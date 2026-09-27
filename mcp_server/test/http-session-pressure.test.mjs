import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { LoggingMessageNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { fixture, workspaceRoot } from './helpers.mjs';
import { TerminalManager } from '../src/terminal-manager.mjs';
import { delay } from '../src/runtime.mjs';

test('160 fresh-client calls reclaim idle MCP sessions while preserving listeners, in-flight calls and terminal results', { timeout: 35000 }, async () => {
  const f = await fixture(), socket = createServer();
  await new Promise(r => socket.listen(0, '127.0.0.1', r)); const port = socket.address().port;
  await new Promise(r => socket.close(r));
  const base = `http://127.0.0.1:${port}`, token = 'synthetic-session-pressure';
  const env = { ...f.env, MCP_NO_HTTP: '0', MCP_ALLOW_ANONYMOUS: '0', MCP_AUTH_TOKEN: token, MCP_HOST: '127.0.0.1', MCP_PORT: String(port),
    // Keep this request in flight throughout admission pressure. The default
    // short HTTP wait and session reuse are covered by tool-wait-policy.test.
    MCP_HTTP_MAX_TOOL_WAIT_MS: '30000',
    MCP_MAX_SESSIONS: '4', MCP_SESSION_PRESSURE_IDLE_MS: '0', MCP_TOOL_PROFILE: 'minimal', MCP_ENABLE_TERMINAL: '1',
    MCP_WORKSPACE_ROOT: f.root, MCP_JOB_ROOT: path.join(f.root, 'jobs'), MCP_TERMINAL_ROOT: path.join(f.root, 'terminals'), MCP_HTTP_AUDIT_LOG: path.join(f.root, 'audit.jsonl') };
  const proc = spawn(process.execPath, [path.join(workspaceRoot, 'mcp_server/src/server.mjs')], { cwd: workspaceRoot, env, stdio: ['ignore', 'ignore', 'pipe'] });
  const exited = once(proc, 'exit'); let stderr = '', rpcId = 0;
  proc.stderr.on('data', b => { stderr += b; });
  const clients = [], terminalIds = new Set();
  const health = async () => (await fetch(base + '/healthz')).json();
  const headers = session => ({ Authorization: `Bearer ${token}`, Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json',
    'mcp-protocol-version': '2025-11-25', Connection: 'close', ...(session ? { 'mcp-session-id': session } : {}) });
  async function rpc(method, params = {}, session) {
    const response = await fetch(base + '/mcp', { method: 'POST', headers: headers(session), body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }), signal: AbortSignal.timeout(30000) });
    return { response, data: await response.json() };
  }
  const initParams = { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'pressure-client', version: '1' } };
  async function initialize() {
    const r = await rpc('initialize', initParams); assert.equal(r.response.status, 200, JSON.stringify(r.data));
    return r.response.headers.get('mcp-session-id');
  }
  async function call(session, args) {
    const r = await rpc('tools/call', { name: 'execute_command', arguments: { waitMs: 0, ...args } }, session);
    assert.equal(r.response.status, 200, JSON.stringify(r.data)); assert(!r.data.result.isError, JSON.stringify(r.data));
    const state = r.data.result.structuredContent; terminalIds.add(state.sessionId); return state;
  }
  async function until(check) { for (let i = 0; i < 100; i++) { const value = await check(); if (value) return value; await delay(25); } throw Error('condition not reached'); }
  async function listen() {
    const client = new Client({ name: 'sticky-listener', version: '1' }), events = [];
    client.setNotificationHandler(LoggingMessageNotificationSchema, message => { events.push(message.params.data); });
    const transport = new StreamableHTTPClientTransport(new URL(base + '/mcp'), { requestInit: { headers: { Authorization: `Bearer ${token}` } } });
    await client.connect(transport); clients.push({ client, transport }); return { client, transport, events };
  }
  try {
    await until(async () => { if (proc.exitCode !== null) throw Error(stderr); try { return (await health()).ok; } catch { return false; } });
    const sticky = await listen(); await until(async () => (await health()).sessions.listeners === 1);
    const watching = (await sticky.client.callTool({ name: 'execute_command', arguments: { command: 'while [ ! -f listener-release ]; do sleep .02; done; printf LISTENER_DONE', cwd: f.root, waitMs: 0 } })).structuredContent;
    terminalIds.add(watching.sessionId);
    assert(watching.completionNotification.listening);
    const extraStream = await fetch(base + '/mcp', { headers: headers(sticky.transport.sessionId), signal: AbortSignal.timeout(2000) });
    assert.equal(extraStream.status, 409); await extraStream.text();
    for (let i = 0; i < 3; i++) {
      const repeat = await sticky.client.callTool({ name: 'execute_command', arguments: { sessionId: watching.sessionId, commandId: watching.commandId, notifyOnCompletion: true, waitMs: 0 } });
      assert(repeat.structuredContent.completionNotification.subscribed);
    }
    assert.equal((await health()).sessions.listeners, 1);
    const lostSession = await initialize();
    const detached = await call(lostSession, { command: 'printf x >> launch-count; while [ ! -f detached-release ]; do sleep .02; done; printf RETAINED_RESULT', cwd: f.root });
    const busySession = await initialize();
    const busy = call(busySession, { command: 'while [ ! -f busy-release ]; do sleep .02; done; printf BUSY_DONE', cwd: f.root, waitMs: 30000 });
    await until(async () => (await health()).sessions.inflight >= 1);

    let latest;
    for (let i = 0; i < 160; i++) {
      latest = await initialize();
      assert.equal((await rpc('ping', {}, latest)).response.status, 200);
      if (i % 20 === 0) { const h = await health(); assert(h.sessions.active + h.sessions.reserved <= 4); assert.equal(h.sessions.listeners, 1); }
    }
    const pressure = await health(); assert(pressure.counters.sessionsEvicted >= 159); assert.equal(pressure.counters.sessionsRejected, 0);
    assert.equal((await rpc('ping', {}, lostSession)).response.status, 404);
    assert.equal((await rpc('ping', {}, busySession)).response.status, 200);
    // HTTP connections close on every request but the MCP session is reusable.
    const created = (await health()).counters.sessionsCreated;
    for (let i = 0; i < 20; i++) assert.equal((await rpc('ping', {}, latest)).response.status, 200);
    assert.equal((await health()).counters.sessionsCreated, created);
    const evicted = (await health()).counters.sessionsEvicted;
    assert.equal((await rpc('ping')).response.status, 400);
    assert.equal((await rpc('initialize', {})).response.status, 400);
    assert.equal((await health()).counters.sessionsEvicted, evicted);

    // Filling every remaining slot with live listeners must reject admission
    // rather than breaking an SSE stream or an in-progress tools/call.
    await listen(); await listen(); await until(async () => (await health()).sessions.listeners === 3);
    const full = await rpc('initialize', initParams); assert.equal(full.response.status, 503); assert.equal(full.response.headers.get('retry-after'), '5');
    for (const c of clients.slice(1)) { await c.transport.terminateSession(); await c.client.close(); }
    const recovered = await initialize();
    await writeFile(path.join(f.root, 'detached-release'), '');
    await until(async () => {
      const result = await call(recovered, { sessionId: detached.sessionId, commandId: detached.commandId, cursor: detached.nextCursor, waitMs: 100 });
      if (result.status === 'running') return false;
      assert.equal(result.exitCode, 0); assert.match(result.stdout, /RETAINED_RESULT/); return true;
    });
    assert.equal(await readFile(path.join(f.root, 'launch-count'), 'utf8'), 'x');
    await writeFile(path.join(f.root, 'listener-release'), '');
    const completion = await until(() => sticky.events.find(x => x.commandId === watching.commandId)); assert.equal(completion.exitCode, 0);
    assert.equal(sticky.events.filter(x => x.commandId === watching.commandId).length, 1);
    await writeFile(path.join(f.root, 'busy-release'), ''); const finalBusy = await busy;
    assert.equal(finalBusy.exitCode, 0); assert.match(finalBusy.stdout, /BUSY_DONE/);
    assert.equal((await health()).sessions.reserved, 0);
  } finally {
    for (const c of clients) { await c.transport.terminateSession().catch(() => {}); await c.client.close().catch(() => {}); }
    if (proc.exitCode === null) { proc.kill('SIGTERM'); await exited; }
    const manager = new TerminalManager({ root: env.MCP_TERMINAL_ROOT, env: f.env });
    for (const id of terminalIds) await manager.close(id).catch(() => {});
    await manager.run(['kill-server']).catch(() => {}); await f.cleanup();
  }
});
