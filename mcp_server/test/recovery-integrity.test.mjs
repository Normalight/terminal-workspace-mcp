import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, access } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import { ReconnectingTerminalClient, SubmissionUncertainError } from '../client/reconnecting-client.mjs';
import { TerminalManager } from '../src/terminal-manager.mjs';
import { serverFixture } from './http-fixture.mjs';
import { workspaceRoot } from './helpers.mjs';
import { delay } from '../src/runtime.mjs';
const example = path.join(workspaceRoot, 'mcp_server/examples/completion-client.mjs');
async function resume(f, state) {
  const file = path.join(f.root, 'checkpoint.json'); await writeFile(file, JSON.stringify(state));
  const child = spawn(process.execPath, [example, '--resume', file], { env: f.env, cwd: workspaceRoot, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', b => { stdout += b; }); child.stderr.on('data', b => { stderr += b; });
  const [code] = await once(child, 'exit'); return { code, stdout, stderr, state: JSON.parse(await readFile(file, 'utf8')) };
}

test('command pages and resume stay within immutable boundaries after later commands; raw terminal remains explicit', { timeout: 15000 }, async () => {
  const f = await serverFixture();
  try {
    await f.start(); const c = f.client();
    const a = await c.execute({ terminalKey: 'history/a', cwd: f.root, command: "printf '%02000d' 0; printf ORIGINAL", waitMs: 1000, maxBytes: 64 });
    await c.execute({ sessionId: a.sessionId, command: 'printf LATER', waitMs: 1000 });
    let cursor = a.startCursor, output = '', page;
    do { page = await c.read({ sessionId: a.sessionId, commandId: a.commandId, cursor, maxBytes: 57, waitMs: 0 }); output += page.stdout; cursor = page.nextCursor; } while (page.outputTruncated);
    assert.equal(output, '0'.repeat(2000) + 'ORIGINAL'); assert.equal(cursor, a.outputEndCursor); assert(page.outputComplete);
    const tail = await c.read({ sessionId: a.sessionId, outputScope: 'terminal', waitMs: 0 }); assert.match(tail.stdout, /LATER/); assert.equal(tail.outputFormat, 'pty');
    const restored = await resume(f, { sessionId: a.sessionId, commandId: a.commandId, cursor: a.startCursor, phase: 'monitoring' });
    assert.equal(restored.code, 0, restored.stderr); assert.equal(restored.stdout, output); assert.equal(restored.state.cursor, a.outputEndCursor);
  } finally { await f.cleanup(); }
});

test('delivery failure distinguishes unsent from uncertain and returns a saved recovery selector', { timeout: 12000 }, async () => {
  const f = await serverFixture(), t = await f.manager.initialize();
  try {
    const id = (await t.open({ terminalKey: 'delivery/test', cwd: f.root })).sessionId;
    const send = t.send;
    t.send = async () => { throw Error('before dispatch'); };
    let caught; try { await t.execute(id, { command: 'touch never' }); } catch (e) { caught = e; }
    assert.equal(caught.code, 'submission_failed'); assert(caught.recovery.commandId);
    const fresh = new TerminalManager({ root: t.root, env: f.env });
    assert.equal((await fresh.commandStatus(id, caught.recovery.commandId)).status, 'failed_to_start');
    assert.equal(await access(path.join(f.root, 'never')).then(() => true, () => false), false);
    t.send = send;
    assert.equal((await t.execute(id, { command: 'true', waitMs: 1000 })).exitCode, 0);
    t.send = async (_id, _text, _enter, mark) => { await mark(); throw Error('during dispatch'); };
    try { await t.execute(id, { command: 'touch uncertain' }); } catch (e) { caught = e; }
    assert.equal(caught.code, 'submission_uncertain');
    assert.equal((await fresh.commandStatus(id, caught.recovery.commandId)).status, 'submission_uncertain');
    await assert.rejects(fresh.execute(id, { command: 'true' }), { code: 'terminal_busy' });
  } finally { await f.cleanup(); }
});

test('collector death preserves the independent execution receipt and explicitly marks missing output', { timeout: 15000 }, async () => {
  const f = await serverFixture();
  try {
    await f.start(); const c = f.client();
    const a = await c.execute({ terminalKey: 'collector/test', cwd: f.root, command: 'while [ ! -f release ]; do sleep .02; done; printf done > effect; printf LOST_OUTPUT', waitMs: 0 });
    const logger = JSON.parse(await readFile(path.join(f.env.MCP_TERMINAL_ROOT, a.sessionId, 'logger.json'), 'utf8'));
    process.kill(logger.pid, 'SIGKILL'); await writeFile(path.join(f.root, 'release'), '');
    const final = await c.waitForCompletion({ sessionId: a.sessionId, commandId: a.commandId, cursor: a.nextCursor });
    assert.equal(final.status, 'succeeded'); assert.equal(final.executionStatus, 'succeeded'); assert.equal(final.exitCode, 0);
    assert.equal(final.outputStatus, 'incomplete'); assert(final.outputGap); assert(!final.outputComplete);
    assert.equal(await readFile(path.join(f.root, 'effect'), 'utf8'), 'done');
    await assert.rejects(c.execute({ sessionId: a.sessionId, command: 'true' }), e => e.serverCode === 'collector_unavailable');
  } finally { await f.cleanup(); }
});

test('retention preserves the requested cursor gap and resume refuses to report complete output', { timeout: 12000 }, async () => {
  const f = await serverFixture(); f.env.MCP_LOG_SEGMENT_BYTES = '1024'; f.env.MCP_LOG_MAX_SEGMENTS = '2';
  try {
    await f.start(); const c = f.client();
    const a = await c.execute({ terminalKey: 'retention/test', cwd: f.root, command: "printf '%08000d' 0", waitMs: 1000 });
    const page = await c.read({ sessionId: a.sessionId, commandId: a.commandId, cursor: a.startCursor, waitMs: 0 });
    assert(page.droppedBytes > 0); assert(page.outputGap); assert(!page.outputComplete); assert.equal(page.requestedCursor, a.startCursor);
    const restored = await resume(f, { sessionId: a.sessionId, commandId: a.commandId, cursor: a.startCursor, phase: 'monitoring' });
    assert.equal(restored.code, 1); assert.equal(restored.state.phase, 'incomplete'); assert.match(restored.stderr, /output_incomplete/);
  } finally { await f.cleanup(); }
});

test('origin session rejection reconnects before submission, but an arbitrary gateway 404 is never replayed', { timeout: 20000 }, async () => {
  const f = await serverFixture();
  try {
    await f.start(); const c = f.client();
    const a = await c.execute({ terminalKey: 'stale/test', cwd: f.root, command: 'true', waitMs: 1000 });
    await f.stop(); await f.start();
    const b = await c.execute({ sessionId: a.sessionId, command: 'printf x >> once', waitMs: 1000 });
    assert.equal(b.exitCode, 0); assert.equal(c.generation, 2); assert.equal(await readFile(path.join(f.root, 'once'), 'utf8'), 'x');
    let attempts = 0;
    const gateway = f.client({ fetch: (url, options) => {
      if (options.body && JSON.parse(options.body).params?.arguments?.command) { attempts++; return Promise.resolve(new Response('not found', { status: 404 })); }
      return fetch(url, options);
    } });
    await assert.rejects(gateway.execute({ terminalKey: 'gateway/test', cwd: f.root, command: 'true' }), SubmissionUncertainError);
    assert.equal(attempts, 1);
  } finally { await f.cleanup(); }
});

test('completed empty reads return promptly; cancellation and completion deadlines include network waits', { timeout: 10000 }, async () => {
  const f = await serverFixture();
  try {
    await f.start(); const c = f.client();
    const a = await c.execute({ terminalKey: 'empty/test', cwd: f.root, command: 'true', waitMs: 1000 });
    const start = Date.now(); const page = await c.read({ sessionId: a.sessionId, commandId: a.commandId, cursor: a.nextCursor, waitMs: 1200 });
    assert.equal(page.stdout, ''); assert(page.outputComplete); assert(Date.now() - start < 700);
  } finally { await f.cleanup(); }
  const blockedFetch = (_url, options) => new Promise((_r, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
  const c = new ReconnectingTerminalClient({ url: 'http://127.0.0.1:1/mcp', requestTimeoutMs: 4000, fetch: blockedFetch });
  const pending = c.connect().catch(e => e); await delay(30); const start = Date.now(); await c.close(); await pending;
  assert(Date.now() - start < 500);
  const d = new ReconnectingTerminalClient({ url: 'http://127.0.0.1:1/mcp', requestTimeoutMs: 4000, fetch: blockedFetch });
  const began = Date.now();
  try { await assert.rejects(d.waitForCompletion({ sessionId: 'saved', commandId: 'saved' }, { timeoutMs: 150 })); assert(Date.now() - began < 700); }
  finally { await d.close(); }
});

test('multiple agents run distinct terminals concurrently, share read cursors safely, and recover together', { timeout: 25000 }, async () => {
  const f = await serverFixture();
  try {
    await f.start(); const agents = Array.from({ length: 6 }, () => f.client());
    const starts = await Promise.all(agents.map((c, i) => c.execute({ terminalKey: `project/agent-${i}/task`, cwd: f.root,
      command: `printf x >> once-${i}; while [ ! -f release ]; do sleep .02; done; printf AGENT_${i}`, waitMs: 0 })));
    assert.equal(new Set(starts.map(s => s.sessionId)).size, 6); assert(starts.every(s => ['running', 'starting'].includes(s.status)));
    await assert.rejects(agents[1].execute({ sessionId: starts[0].sessionId, command: 'printf WRONG' }), e => e.serverCode === 'terminal_busy');
    await f.stop(); await writeFile(path.join(f.root, 'release'), ''); await f.start();
    const finals = await Promise.all(agents.map((c, i) => c.waitForCompletion({ sessionId: starts[i].sessionId, commandId: starts[i].commandId, cursor: starts[i].startCursor })));
    for (let i = 0; i < finals.length; i++) {
      assert.equal(finals[i].stdout, `AGENT_${i}`); assert.equal(finals[i].exitCode, 0); assert(finals[i].outputComplete);
      assert.equal(await readFile(path.join(f.root, `once-${i}`), 'utf8'), 'x');
    }
    const readers = await Promise.all(agents.map(c => c.read({ sessionId: starts[0].sessionId, commandId: starts[0].commandId, cursor: starts[0].startCursor, waitMs: 0 })));
    assert(readers.every(r => r.stdout === 'AGENT_0' && r.nextCursor === finals[0].nextCursor));
  } finally { await f.cleanup(); }
});

test('legacy receipts without byte boundaries stay bounded and report incomplete history', { timeout: 10000 }, async () => {
  const f = await serverFixture();
  try {
    await f.start(); const c = f.client();
    const a = await c.execute({ terminalKey: 'legacy/test', cwd: f.root, command: 'printf ORIGINAL', waitMs: 1000 });
    await c.execute({ sessionId: a.sessionId, command: 'printf LATER', waitMs: 1000 });
    const result = path.join(f.env.MCP_TERMINAL_ROOT, a.sessionId, 'commands', a.commandId + '.result.json');
    await writeFile(result, JSON.stringify({ exitCode: 0 }));
    const page = await c.read({ sessionId: a.sessionId, commandId: a.commandId, waitMs: 0 });
    assert.match(page.stdout, /ORIGINAL/); assert(!page.stdout.includes('LATER')); assert(page.outputGap); assert(!page.outputComplete);
    await c.execute({ sessionId: a.sessionId, command: 'printf NEWER', waitMs: 1000 });
    const again = await c.read({ sessionId: a.sessionId, commandId: a.commandId, waitMs: 0 });
    assert.equal(again.stdout, page.stdout); assert.equal(again.outputEndCursor, page.outputEndCursor);
  } finally { await f.cleanup(); }
});

test('new shells and collectors ignore stale tmux-server environment after adoption', { timeout: 12000 }, async () => {
  const f = await serverFixture(), t = await f.manager.initialize();
  try {
    await t.open({ terminalKey: 'environment/seed', cwd: f.root });
    for (const key of ['BOTMUX_STALE', 'MCP_AUTH_TOKEN', 'OLD_CALLER_ONLY']) await t.run(['set-environment', '-g', key, 'stale']);
    const id = (await t.open({ terminalKey: 'environment/new', cwd: f.root, env: { TASK_VALUE: 'value with spaces and $literal', BOTMUX_INJECTED: 'drop' } })).sessionId;
    const result = await t.execute(id, { command: 'test -z "${BOTMUX_STALE+x}${BOTMUX_INJECTED+x}${MCP_AUTH_TOKEN+x}${OLD_CALLER_ONLY+x}" && test -n "$TMUX_PANE" && printf "%s" "$TASK_VALUE"', waitMs: 1000 });
    assert.equal(result.exitCode, 0); assert.equal(result.output.content, 'value with spaces and $literal');
    const logger = JSON.parse(await readFile(path.join(t.dir(id), 'logger.json'), 'utf8'));
    const environment = (await readFile(`/proc/${logger.pid}/environ`, 'utf8')).split('\0');
    for (const key of ['BOTMUX_STALE', 'BOTMUX_INJECTED', 'MCP_AUTH_TOKEN', 'OLD_CALLER_ONLY']) assert(!environment.some(x => x.startsWith(key + '=')));
    assert(environment.includes('TASK_VALUE=value with spaces and $literal'));
  } finally { await f.cleanup(); }
});

test('transient pane inspection failure cannot close or replace a live keyed terminal', async () => {
  const f = await serverFixture(), t = await f.manager.initialize();
  try {
    const original = await t.open({ terminalKey: 'inspection/test', cwd: f.root });
    const run = t.run;
    t.run = async () => { throw Error('tmux inspection timed out'); };
    await assert.rejects(t.status(original.sessionId), /timed out/);
    await assert.rejects(t.open({ terminalKey: 'inspection/test', cwd: f.root }), /timed out/);
    t.run = run;
    assert.equal((await t.open({ terminalKey: 'inspection/test', cwd: f.root })).sessionId, original.sessionId);
  } finally { await f.cleanup(); }
});
