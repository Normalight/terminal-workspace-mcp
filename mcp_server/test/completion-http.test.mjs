import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { writeFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { LoggingMessageNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { fixture, workspaceRoot } from './helpers.mjs';
import { TerminalManager } from '../src/terminal-manager.mjs';
import { delay } from '../src/runtime.mjs';

async function until(predicate) {
  for (let i = 0; i < 160; i++) { const value = predicate(); if (value) return value; await delay(25); }
  throw Error('completion notification did not arrive');
}

test('MCP clients receive completion without polling, isolated by connection, with restart re-subscription', { timeout: 35000 }, async () => {
  const f = await fixture(), reservation = createServer();
  await new Promise(r => reservation.listen(0, '127.0.0.1', r));
  const port = reservation.address().port; await new Promise(r => reservation.close(r));
  const url = `http://127.0.0.1:${port}/mcp`, token = 'synthetic-completion-test';
  const env = { ...f.env, MCP_NO_HTTP: '0', MCP_ALLOW_ANONYMOUS: '0', MCP_AUTH_TOKEN: token,
    MCP_HOST: '127.0.0.1', MCP_PORT: String(port), MCP_TOOL_PROFILE: 'minimal', MCP_ENABLE_TERMINAL: '1',
    MCP_WORKSPACE_ROOT: f.root, MCP_JOB_ROOT: path.join(f.root, 'jobs'), MCP_TERMINAL_ROOT: path.join(f.root, 'terminals'), MCP_HTTP_AUDIT_LOG: path.join(f.root, 'audit.jsonl') };
  let proc, exited, stderr = '';
  const clients = [], ids = new Set();
  async function start() {
    proc = spawn(process.execPath, [path.join(workspaceRoot, 'mcp_server/src/server.mjs')], { cwd: workspaceRoot, env, stdio: ['ignore', 'ignore', 'pipe'] });
    exited = once(proc, 'exit'); proc.stderr.on('data', b => { stderr += b; });
    for (let i = 0; i < 100; i++) {
      if (proc.exitCode !== null) throw Error(stderr);
      try { if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) return; } catch {}
      await delay(30);
    }
    throw Error(stderr);
  }
  async function stop() { if (proc?.exitCode === null) { proc.kill('SIGTERM'); await exited; } }
  async function connect() {
    const client = new Client({ name: 'completion-test', version: '1' });
    const events = [];
    client.setNotificationHandler(LoggingMessageNotificationSchema, message => { events.push(message.params); });
    client.onerror = () => {};
    await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    clients.push(client);
    assert.deepEqual(client.getServerCapabilities().logging, {});
    const call = async args => {
      const r = await client.callTool({ name: 'execute_command', arguments: { waitMs: 0, ...args } });
      assert(!r.isError, JSON.stringify(r)); if (r.structuredContent.sessionId) ids.add(r.structuredContent.sessionId);
      return r.structuredContent;
    };
    return { client, events, call };
  }
  try {
    await start();
    const a = await connect(), b = await connect();
    const command = await a.call({ command: 'while [ ! -f release ]; do sleep .02; done; printf FINISHED', cwd: f.root });
    assert.equal(command.status, 'running'); assert(command.completionNotification.subscribed);
    // No further tools/call from A: releasing the shell triggers a pushed event.
    await writeFile(path.join(f.root, 'release'), '');
    const first = await until(() => a.events.find(x => x.data.commandId === command.commandId));
    assert.equal(first.level, 'notice'); assert.equal(first.logger, 'terminal-workspace.completion');
    assert.equal(first.data.status, 'succeeded'); assert.equal(first.data.exitCode, 0);
    assert(first.data.outputEndCursor > command.startCursor); assert.equal(b.events.length, 0);
    const output = await a.call({ sessionId: command.sessionId, commandId: command.commandId, cursor: command.nextCursor });
    assert.match(output.stdout, /FINISHED/);
    await a.call({ sessionId: command.sessionId, commandId: command.commandId, notifyOnCompletion: true });
    await delay(650); assert.equal(a.events.length, 1);

    const failed = await a.call({ sessionId: command.sessionId, command: 'sleep .2; false' });
    const failure = await until(() => a.events.find(x => x.data.commandId === failed.commandId));
    assert.equal(failure.data.status, 'failed'); assert.equal(failure.data.exitCode, 1);

    const cancelled = await a.call({ sessionId: command.sessionId, command: 'sleep 30' });
    await a.call({ sessionId: command.sessionId, key: 'C-c' });
    assert.equal((await until(() => a.events.find(x => x.data.commandId === cancelled.commandId))).data.exitCode, 130);

    const muted = await a.call({ sessionId: command.sessionId, command: 'sleep .2; true', notifyOnCompletion: false });
    await delay(850); assert(!a.events.some(x => x.data.commandId === muted.commandId));
    await a.client.setLoggingLevel('error');
    await a.call({ sessionId: command.sessionId, commandId: muted.commandId, notifyOnCompletion: true });
    await delay(650); assert(!a.events.some(x => x.data.commandId === muted.commandId));
    await a.client.setLoggingLevel('notice');
    await until(() => a.events.find(x => x.data.commandId === muted.commandId));

    // JSON-only callers can attach GET after completion: the event is not
    // silently discarded by the SDK while no standalone SSE stream exists.
    let rpcId = 0, rawSession;
    const rawHeaders = () => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-11-25', ...(rawSession ? { 'mcp-session-id': rawSession } : {}) });
    const rpc = (method, params) => fetch(url, { method: 'POST', headers: rawHeaders(), body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }) });
    const init = await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'late-listener', version: '1' } });
    await init.json(); rawSession = init.headers.get('mcp-session-id');
    const lateResult = await (await rpc('tools/call', { name: 'execute_command', arguments: { command: 'sleep .1; true', cwd: f.root, waitMs: 0 } })).json();
    const late = lateResult.result.structuredContent; ids.add(late.sessionId);
    assert(late.completionNotification.subscribed);
    await delay(850);
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 4000);
    try {
      const stream = await fetch(url, { headers: rawHeaders(), signal: controller.signal });
      assert.equal(stream.headers.get('content-type'), 'text/event-stream');
      assert.equal(stream.headers.get('content-encoding'), null);
      const reader = stream.body.getReader(); let buffer = '';
      while (!buffer.includes('\n\n')) buffer += new TextDecoder().decode((await reader.read()).value);
      const event = JSON.parse(buffer.split('\n').find(x => x.startsWith('data: ')).slice(6));
      assert.equal(event.params.data.commandId, late.commandId); assert.equal(event.params.data.exitCode, 0);
      await reader.cancel();
    } finally { clearTimeout(timeout); controller.abort(); }
    await fetch(url, { method: 'DELETE', headers: rawHeaders() });

    const restart = await a.call({ sessionId: command.sessionId, command: 'while [ ! -f restart-release ]; do sleep .02; done; printf RECOVERED' });
    await a.client.close(); await b.client.close(); await stop();
    await writeFile(path.join(f.root, 'restart-release'), '');
    await start(); const recovered = await connect();
    await recovered.call({ sessionId: restart.sessionId, commandId: restart.commandId, notifyOnCompletion: true });
    const recoveredEvent = await until(() => recovered.events.find(x => x.data.commandId === restart.commandId));
    assert.equal(recoveredEvent.data.exitCode, 0);
    const final = await recovered.call({ sessionId: restart.sessionId, commandId: restart.commandId, cursor: restart.nextCursor });
    assert.match(final.stdout, /RECOVERED/);
  } finally {
    for (const client of clients) await client.close().catch(() => {});
    await stop();
    const manager = new TerminalManager({ root: env.MCP_TERMINAL_ROOT, env: f.env });
    for (const id of ids) await manager.close(id).catch(() => {});
    await manager.run(['kill-server']).catch(() => {}); await f.cleanup();
  }
});
