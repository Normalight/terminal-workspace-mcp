import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { serverFixture } from './http-fixture.mjs';
import { delay } from '../src/runtime.mjs';
import { nextTerminalAction } from '../src/terminal-interaction.mjs';
import { ReconnectingTerminalClient } from '../client/reconnecting-client.mjs';

test('text-only clients see final status, all output pages and a stop condition above 4 KiB', { timeout: 12000 }, async () => {
  const f = await serverFixture();
  try {
    await f.start(); const c = f.client(), { client } = await c.connectionForCall();
    const call = async args => {
      const r = await client.callTool({ name: 'execute_command', arguments: args });
      assert(!r.isError);
      const text = JSON.parse(r.content.find(x => x.type === 'text').text);
      assert.deepEqual(text, r.structuredContent); return text;
    };
    const a = await call({ terminalKey: 'text-only', cwd: f.root, command: "printf '%07000d' 0", waitMs: 1000, maxBytes: 6000 });
    assert.equal(a.status, 'succeeded'); assert.equal(a.stdout.length, 6000); assert.equal(a.nextAction, 'read_output');
    const b = await call({ sessionId: a.sessionId, commandId: a.commandId, cursor: a.nextCursor, waitMs: 30000 });
    assert.equal(b.stdout.length, 1000); assert.equal(b.nextAction, 'done'); assert(b.outputComplete);
    const began = Date.now();
    const end = await call({ sessionId: a.sessionId, commandId: a.commandId, cursor: b.nextCursor, waitMs: 30000 });
    assert.equal(end.nextAction, 'done'); assert.equal(end.stdout, ''); assert(Date.now() - began < 1000);
    assert.equal(nextTerminalAction({ status: 'succeeded', outputGap: true }), 'inspect');
    assert.equal(nextTerminalAction({ status: 'submission_uncertain', outputTruncated: true }), 'inspect');
  } finally { await f.cleanup(); }
});

test('new shells disable ambient pagers; an explicit Git pager is detected and can be dismissed', { timeout: 15000 }, async () => {
  const f = await serverFixture();
  f.env.PAGER = f.env.GIT_PAGER = f.env.SYSTEMD_PAGER = 'false';
  try {
    await f.start(); const c = f.client();
    const a = await c.execute({ terminalKey: 'pager', cwd: f.root,
      command: 'printf "%s/%s/%s" "$PAGER" "$GIT_PAGER" "$SYSTEMD_PAGER"', waitMs: 1000 });
    assert.equal(a.stdout, 'cat/cat/cat');
    // Git shares its process group with the pager; tmux reports "git".
    await writeFile(path.join(f.root, 'many.txt'), 'line\n'.repeat(100));
    const pager = await c.execute({ sessionId: a.sessionId,
      command: 'GIT_PAGER="less -+F" git --paginate diff --no-index /dev/null many.txt', waitMs: 100 });
    let waiting = pager;
    for (let i = 0; i < 30 && !waiting.interaction; i++) {
      await delay(30); waiting = await c.read({ sessionId: a.sessionId, commandId: pager.commandId, cursor: waiting.nextCursor, waitMs: 0 });
    }
    assert.equal(waiting.interaction?.type, 'pager'); assert.equal(waiting.nextAction, 'input');
    await assert.rejects(c.waitForCompletion({ sessionId: a.sessionId, commandId: pager.commandId }), e => e.code === 'interaction_required' && e.recovery.commandId === pager.commandId);
    const end = await c.call(await c.connectionForCall(), { sessionId: a.sessionId, input: 'q', waitMs: 1000 });
    assert.notEqual(end.status, 'running'); assert.equal(end.nextAction, 'done');
  } finally { await f.cleanup(); }
});

test('JSON-only clients get polling guidance and finish without a completion listener', { timeout: 10000 }, async () => {
  const f = await serverFixture();
  try {
    await f.start();
    const headers = { Authorization: `Bearer ${f.token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
    let id = 0;
    const rpc = (method, params) => fetch(f.url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) });
    const init = await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'text-only-no-listener', version: '1' } });
    await init.json(); headers['mcp-session-id'] = init.headers.get('mcp-session-id');
    const call = async args => JSON.parse((await (await rpc('tools/call', { name: 'execute_command', arguments: args })).json()).result.content[0].text);
    const a = await call({ terminalKey: 'no-listener', cwd: f.root, command: 'while [ ! -f release ]; do sleep .02; done; printf COMPLETE', waitMs: 0 });
    assert.equal(a.nextAction, 'poll'); assert.equal(a.completionNotification.listening, false);
    assert.equal(a.completionNotification.fallback, 'poll');
    await writeFile(path.join(f.root, 'release'), '');
    const end = await call({ sessionId: a.sessionId, commandId: a.commandId, cursor: a.nextCursor, waitMs: 2000 });
    assert.equal(end.status, 'succeeded'); assert.equal(end.nextAction, 'done'); assert.equal(end.stdout, 'COMPLETE');
    await fetch(f.url, { method: 'DELETE', headers });
  } finally { await f.cleanup(); }
});

test('SDK polling fallback reconciles promptly when notifications are unavailable', { timeout: 5000 }, async () => {
  const c = new ReconnectingTerminalClient({ url: 'http://127.0.0.1:1/mcp', reconcileMs: 30000 });
  let calls = 0;
  c.read = async () => ++calls === 1
    ? { status: 'running', completionNotification: { listening: false } }
    : { status: 'succeeded', exitCode: 0 };
  try {
    const began = Date.now(); const end = await c.waitForCompletion({ sessionId: 'saved', commandId: 'saved' }, { timeoutMs: 4000 });
    assert.equal(end.status, 'succeeded'); assert(Date.now() - began < 2500);
  } finally { await c.close(); }
});
