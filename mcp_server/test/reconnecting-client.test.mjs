import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { ReconnectingTerminalClient, retryable, retryDelay, SubmissionUncertainError } from '../client/reconnecting-client.mjs';
import { TerminalManager } from '../src/terminal-manager.mjs';
import { fixture, workspaceRoot } from './helpers.mjs';
import { delay } from '../src/runtime.mjs';

async function serverFixture() {
  const f = await fixture(), reservation = createServer();
  await new Promise(r => reservation.listen(0, '127.0.0.1', r));
  const port = reservation.address().port; await new Promise(r => reservation.close(r));
  const token = 'synthetic-reconnect-test', url = `http://127.0.0.1:${port}/mcp`;
  const env = { ...f.env, MCP_NO_HTTP: '0', MCP_ALLOW_ANONYMOUS: '0', MCP_AUTH_TOKEN: token,
    MCP_HOST: '127.0.0.1', MCP_PORT: String(port), MCP_TOOL_PROFILE: 'minimal', MCP_ENABLE_TERMINAL: '1',
    MCP_WORKSPACE_ROOT: f.root, MCP_JOB_ROOT: path.join(f.root, 'jobs'), MCP_TERMINAL_ROOT: path.join(f.root, 'terminals'), MCP_HTTP_AUDIT_LOG: path.join(f.root, 'audit.jsonl') };
  let proc, exited, stderr = '';
  const clients = [];
  const manager = new TerminalManager({ root: env.MCP_TERMINAL_ROOT, env: f.env });
  async function start() {
    proc = spawn(process.execPath, [path.join(workspaceRoot, 'mcp_server/src/server.mjs')], { cwd: workspaceRoot, env, stdio: ['ignore', 'ignore', 'pipe'] });
    exited = once(proc, 'exit'); proc.stderr.on('data', b => { stderr += b; });
    for (let i = 0; i < 150; i++) {
      if (proc.exitCode !== null) throw Error(stderr);
      try { if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) return; } catch {}
      await delay(20);
    }
    throw Error(stderr);
  }
  async function stop() { if (proc?.exitCode === null) { proc.kill('SIGTERM'); await exited; } }
  const client = options => {
    const c = new ReconnectingTerminalClient({ url, requestInit: { headers: { Authorization: `Bearer ${token}` } },
      baseDelayMs: 10, maxDelayMs: 30, reconcileMs: 100, requestTimeoutMs: 3000, ...options });
    clients.push(c); return c;
  };
  return { ...f, env, url, token, start, stop, manager, client, cleanup: async () => {
    for (const c of clients) await c.close(); await stop();
    for (const state of await manager.list()) await manager.close(state.sessionId).catch(() => {});
    await manager.run(['kill-server']).catch(() => {}); await f.cleanup();
  } };
}

test('recovery classifies registration/auth errors, bounds backoff and respects Retry-After', () => {
  assert(!retryable({ code: -32001, message: 'Unknown tool terminal_workspace.execute_command' }));
  for (const code of [401, 403, -32602, 'tool_error']) assert(!retryable({ code, message: 'denied' }));
  for (const code of [404, 429, 503, -32001]) assert(retryable({ code, message: 'temporary' }));
  assert(retryable(new TypeError('terminated', { cause: { code: 'UND_ERR_SOCKET' } })));
  assert.equal(retryDelay({}, 100, { random: () => 1 }), 10000);
  assert.equal(retryDelay({ retryAfterMs: 5000 }, 0, { random: () => 0 }), 5000);
});

test('restart recovers one shared connection, re-subscribes and reads original command without rerunning', { timeout: 20000 }, async () => {
  const f = await serverFixture();
  try {
    await f.start(); let initializations = 0, submissions = 0;
    const c = f.client({ fetch: (url, options) => {
      const body = options.body ? JSON.parse(options.body) : {};
      if (body.method === 'initialize') initializations++;
      if (body.params?.arguments?.command) submissions++;
      return fetch(url, options);
    } });
    const first = await c.execute({ terminalKey: 'restart/task', cwd: f.root,
      command: 'printf x >> once; while [ ! -f release ]; do sleep .02; done; printf RECONNECTED', waitMs: 0 });
    const oldSession = c.connection.transport.sessionId;
    await f.stop(); await writeFile(path.join(f.root, 'release'), ''); await f.start();
    const stale = await fetch(f.url, { method: 'POST', headers: { Authorization: `Bearer ${f.token}`, 'mcp-session-id': oldSession, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) });
    assert.equal(stale.status, 404); assert.equal((await stale.json()).recovery.replayCommand, false);
    const target = { sessionId: first.sessionId, commandId: first.commandId, cursor: first.nextCursor };
    const readers = await Promise.all(Array.from({ length: 5 }, () => c.read({ ...target, waitMs: 0, notifyOnCompletion: true })));
    assert(readers.every(x => x.sessionId === first.sessionId));
    const result = await c.waitForCompletion(target);
    assert.equal(result.exitCode, 0); assert.match(result.stdout, /RECONNECTED/);
    assert.equal(initializations, 2); assert.equal(submissions, 1); assert.equal(await readFile(path.join(f.root, 'once'), 'utf8'), 'x');
  } finally { await f.cleanup(); }
});

test('lost submission response is never replayed; a new client locates durable output by task key', { timeout: 15000 }, async () => {
  const f = await serverFixture();
  try {
    await f.start(); let submissions = 0;
    const c = f.client({ fetch: async (url, options) => {
      const body = options.body ? JSON.parse(options.body) : {};
      const response = await fetch(url, options);
      if (body.params?.arguments?.command) {
        submissions++; await response.arrayBuffer(); throw new TypeError('fetch failed: reply lost');
      }
      return response;
    } });
    await assert.rejects(c.execute({ terminalKey: 'lost/task', cwd: f.root, command: 'printf x >> once; printf SAVED', waitMs: 1000 }), SubmissionUncertainError);
    assert.equal(submissions, 1);
    const resumed = await f.client().read({ terminalKey: 'lost/task', cursor: 0, waitMs: 0, notifyOnCompletion: true });
    assert.equal(resumed.exitCode, 0); assert.match(resumed.stdout, /SAVED/);
    assert.equal(await readFile(path.join(f.root, 'once'), 'utf8'), 'x');
  } finally { await f.cleanup(); }
});

test('transient read failure retries safely and missing notifications reconcile durable completion', { timeout: 15000 }, async () => {
  const f = await serverFixture();
  try {
    await f.start(); let failRead = false, reads = 0;
    const c = f.client({ fetch: async (url, options) => {
      if (options.method === 'GET') return new Response('', { status: 405 }); // Host has no notification support.
      const body = options.body ? JSON.parse(options.body) : {};
      if (body.method === 'tools/call' && !body.params.arguments.command) {
        reads++;
        if (failRead) { failRead = false; return new Response('', { status: 503, headers: { 'retry-after': '0' } }); }
      }
      return fetch(url, options);
    } });
    const first = await c.execute({ terminalKey: 'fallback/task', cwd: f.root, command: 'sleep .4; printf COMPLETE', waitMs: 0 });
    failRead = true;
    const result = await c.waitForCompletion({ sessionId: first.sessionId, commandId: first.commandId, cursor: first.nextCursor });
    assert.equal(result.exitCode, 0); assert.match(result.stdout, /COMPLETE/); assert(reads >= 2);
    await assert.rejects(c.read({ sessionId: first.sessionId, command: 'false' }), /read retries only/);
  } finally { await f.cleanup(); }
});

test('completion events wake monitoring before the reconciliation timer', { timeout: 10000 }, async () => {
  const f = await serverFixture();
  try {
    await f.start(); const c = f.client({ reconcileMs: 60000 });
    const first = await c.execute({ terminalKey: 'event/task', cwd: f.root, command: 'sleep .5; printf PUSHED', waitMs: 0 });
    assert.equal(first.status, 'running');
    const started = Date.now();
    const final = await c.waitForCompletion({ sessionId: first.sessionId, commandId: first.commandId, cursor: first.nextCursor });
    assert.equal(final.exitCode, 0); assert.match(final.stdout, /PUSHED/); assert(Date.now() - started < 4000);
  } finally { await f.cleanup(); }
});

test('authentication and unknown-tool failures stop immediately; outages have a finite retry budget', async () => {
  for (const status of [401, 403, 503]) {
    let attempts = 0;
    const c = new ReconnectingTerminalClient({ url: 'http://127.0.0.1:1/mcp', maxRetries: 2, baseDelayMs: 1, maxDelayMs: 1,
      fetch: async () => { attempts++; return new Response('', { status, headers: { 'retry-after': '0' } }); } });
    try { await assert.rejects(c.connect()); assert.equal(attempts, status === 503 ? 3 : 1); }
    finally { await c.close(); }
  }
});

test('aborted response is audited and the command continues to its durable result', { timeout: 15000 }, async () => {
  const f = await serverFixture();
  try {
    await f.start(); const abort = new AbortController();
    const c = f.client({ fetch: (url, options) => {
      const body = options.body ? JSON.parse(options.body) : {};
      return fetch(url, body.params?.arguments?.command ? { ...options, signal: AbortSignal.any([options.signal, abort.signal]) } : options);
    } });
    const pending = assert.rejects(c.execute({ terminalKey: 'abort/task', cwd: f.root,
      command: 'printf x >> once; while [ ! -f release ]; do sleep .02; done; printf AFTER_ABORT', waitMs: 30000 }), SubmissionUncertainError);
    let state;
    for (let i = 0; i < 150; i++) {
      state = (await f.manager.list().catch(() => []))[0];
      if (state?.activeCommandId) break; await delay(20);
    }
    assert(state?.activeCommandId); abort.abort(); await pending;
    let audit;
    for (let i = 0; i < 100; i++) {
      audit = (await readFile(f.env.MCP_HTTP_AUDIT_LOG, 'utf8')).trim().split('\n').map(JSON.parse).find(x => x.event === 'http_aborted' && x.rpcMethod === 'tools/call');
      if (audit) break; await delay(20);
    }
    assert(audit); assert.equal(audit.responseFinished, false); assert.equal(audit.statusCode, null);
    await writeFile(path.join(f.root, 'release'), '');
    const final = await f.client().waitForCompletion({ sessionId: state.sessionId, commandId: state.activeCommandId, cursor: 0 });
    assert.match(final.stdout, /AFTER_ABORT/); assert.equal(final.exitCode, 0);
    assert.equal(await readFile(path.join(f.root, 'once'), 'utf8'), 'x');
  } finally { await f.cleanup(); }
});

test('example process crash resumes from its private checkpoint without submitting another command', { timeout: 15000 }, async () => {
  const f = await serverFixture(); let child;
  const script = path.join(workspaceRoot, 'mcp_server/examples/completion-client.mjs');
  try {
    await f.start(); let stderr = '', stdout = '';
    child = spawn(process.execPath, [script, 'printf x >> once; while [ ! -f release ]; do sleep .02; done; printf CLIENT_RESUMED'], { env: f.env, cwd: workspaceRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    let exited = once(child, 'exit'); child.stderr.on('data', b => { stderr += b; }); child.stdout.on('data', b => { stdout += b; });
    let stateFile, checkpoint;
    for (let i = 0; i < 200; i++) {
      if (child.exitCode !== null) throw Error(stderr);
      stateFile = stderr.split('\n').filter(Boolean).map(x => { try { return JSON.parse(x).stateFile; } catch { return null; } }).find(Boolean);
      if (stateFile) checkpoint = await readFile(stateFile, 'utf8').then(JSON.parse).catch(() => null);
      if (checkpoint?.phase === 'monitoring') break; await delay(20);
    }
    assert(checkpoint?.commandId); assert.equal((await stat(stateFile)).mode & 0o777, 0o600);
    child.kill('SIGKILL'); await exited; await writeFile(path.join(f.root, 'release'), '');
    child = spawn(process.execPath, [script, '--resume', stateFile], { env: f.env, cwd: workspaceRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    exited = once(child, 'exit'); child.stderr.on('data', b => { stderr += b; }); child.stdout.on('data', b => { stdout += b; });
    const [code] = await exited; assert.equal(code, 0, stderr); assert.match(stdout, /CLIENT_RESUMED/);
    const completed = JSON.parse(await readFile(stateFile, 'utf8'));
    assert.equal(completed.commandId, checkpoint.commandId); assert.equal(completed.phase, 'complete');
    assert.equal(await readFile(path.join(f.root, 'once'), 'utf8'), 'x');
    assert(!JSON.stringify(completed).includes(f.token));
  } finally { if (child?.exitCode === null) child.kill('SIGKILL'); await f.cleanup(); }
});
