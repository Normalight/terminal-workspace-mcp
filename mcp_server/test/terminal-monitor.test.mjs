import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { serverFixture } from './http-fixture.mjs';
import { delay, atomicJson } from '../src/runtime.mjs';
import { ReconnectingTerminalClient } from '../client/reconnecting-client.mjs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { foregroundInteraction } from '../src/terminal-interaction.mjs';
import { fixture } from './helpers.mjs';

test('observable terminal read produces confirmed input evidence', { timeout: 5000 }, async () => {
  const f = await fixture(); let child, pid, exited;
  try {
    // A descendant PTY keeps /proc syscall observable under Yama scope=1.
    child = spawn('python3', ['-B', '-u', '-c', 'import os,pty\npid,fd=pty.fork()\nif pid==0: os.execl("/bin/bash","bash","--noprofile","--norc","-c","read value")\nprint(pid,flush=True)\nos.waitpid(pid,0)'], { env: f.env, stdio: ['ignore', 'pipe', 'pipe'] });
    exited = once(child, 'exit');
    pid = Number(String((await once(child.stdout, 'data'))[0]).trim()); assert(Number.isSafeInteger(pid) && pid > 0);
    let detected;
    for (let i = 0; i < 40; i++) { detected = await foregroundInteraction(pid); if (detected?.type === 'terminal_input') break; await delay(25); }
    assert.equal(detected?.type, 'terminal_input');
  } finally {
    if (pid) { try { process.kill(pid, 'SIGTERM'); } catch {} }
    if (child && child.exitCode === null) child.kill('SIGTERM');
    await exited; await f.cleanup();
  }
});

test('incremental monitoring checkpoints running output before retention and survives reconnect', { timeout: 20000 }, async () => {
  const f = await serverFixture();
  f.env.MCP_LOG_SEGMENT_BYTES = '1024'; f.env.MCP_LOG_MAX_SEGMENTS = '2';
  try {
    await f.start(); const c = f.client({ requestTimeoutMs: 5000 });
    const initial = await c.execute({ terminalKey: 'incremental', cwd: f.root, waitMs: 0, maxBytes: 128,
      command: 'printf x >> once; for i in {1..8}; do while [ ! -f "gate-$i" ]; do sleep .02; done; printf "%01024d" "$i"; done' });
    let checkpoint = { sessionId: initial.sessionId, commandId: initial.commandId, cursor: initial.startCursor }, output = '', restarts = 0;
    const checkpointFile = path.join(f.root, 'checkpoint.json');
    const monitored = c.waitForCompletion({ ...checkpoint, maxBytes: 128 }, { pollIntervalMs: 20, onPage: async (page, next) => {
      output += page.stdout; checkpoint = next; await atomicJson(checkpointFile, next);
      if (page.status === 'running' && output.length === 3072 && restarts === 0) { restarts++; await f.stop(); await f.start(); }
      const gate = Math.floor(output.length / 1024) + 1;
      if (gate <= 8) await writeFile(path.join(f.root, `gate-${gate}`), '');
    } });
    const end = await monitored;
    assert.equal(output, Array.from({ length: 8 }, (_, i) => String(i + 1).padStart(1024, '0')).join(''));
    assert.equal(end.exitCode, 0); assert.equal(end.nextAction, 'done'); assert(end.outputComplete); assert(!end.outputGap);
    assert.equal(restarts, 1); assert.equal(await readFile(path.join(f.root, 'once'), 'utf8'), 'x');
    assert.equal(JSON.parse(await readFile(checkpointFile)).cursor, end.nextCursor);
    const historical = await c.read({ sessionId: initial.sessionId, commandId: initial.commandId, cursor: initial.startCursor });
    assert(historical.outputGap, 'retention really removed already-consumed pages');
  } finally { await f.cleanup(); }
});

test('failed consumer retains the last committed cursor; timeout does not terminate silent work', { timeout: 10000 }, async () => {
  const c = new ReconnectingTerminalClient({ url: 'http://127.0.0.1:1/mcp' });
  let calls = 0;
  c.read = async () => ({ sessionId: 'saved', commandId: 'saved', status: 'running', stdout: 'data', nextCursor: ++calls * 4, outputTruncated: true });
  try {
    await assert.rejects(c.waitForCompletion({ sessionId: 'saved', commandId: 'saved', cursor: 0 }, { onPage: async () => { if (calls === 2) throw Error('disk full'); } }), e => e.message === 'disk full' && e.recovery.cursor === 4);
  } finally { await c.close(); }
  const f = await serverFixture();
  try {
    await f.start(); const client = f.client();
    const a = await client.execute({ terminalKey: 'silent', cwd: f.root, command: 'while [ ! -f release ]; do sleep .1; done; printf ALIVE', waitMs: 0 });
    await assert.rejects(client.waitForCompletion({ sessionId: a.sessionId, commandId: a.commandId, cursor: a.nextCursor }, { timeoutMs: 350 }), e => e.recovery.commandId === a.commandId);
    const state = await client.read({ sessionId: a.sessionId, commandId: a.commandId, statusOnly: true });
    assert.equal(state.status, 'running'); assert.equal(state.interaction, undefined); assert.equal(state.stdout, undefined); assert.equal(state.nextCursor, undefined);
    await writeFile(path.join(f.root, 'release'), '');
    const end = await client.waitForCompletion({ sessionId: a.sessionId, commandId: a.commandId, cursor: a.nextCursor });
    assert.equal(end.exitCode, 0); assert.match(end.stdout, /ALIVE/);
  } finally { await f.cleanup(); }
});

test('status polling avoids log payloads and correlates concurrent results without sensitive contents', { timeout: 15000 }, async () => {
  const f = await serverFixture();
  try {
    await f.start(); const c = f.client();
    const tasks = await Promise.all([0, 1, 2].map(i => c.execute({ terminalKey: `private-label-${i}`, cwd: f.root, command: `printf private-output-${i}; while [ ! -f release ]; do sleep .1; done`, waitMs: 0 })));
    const states = await Promise.all(tasks.map(a => c.read({ sessionId: a.sessionId, commandId: a.commandId, statusOnly: true })));
    assert.equal(new Set(states.map(s => s.requestId)).size, 3);
    for (const s of states) { assert.equal(s.stdout, undefined); assert.equal(s.outputRead, false); assert.equal(s.nextCursor, undefined); }
    await assert.rejects(c.read({ sessionId: tasks[0].sessionId, statusOnly: true }), e => e.serverCode === 'invalid_input');
    await writeFile(path.join(f.root, 'release'), '');
    const results = await Promise.all(tasks.map(a => c.waitForCompletion({ sessionId: a.sessionId, commandId: a.commandId, cursor: a.startCursor })));
    let rows;
    for (let i = 0; i < 100; i++) {
      rows = (await readFile(f.env.MCP_HTTP_AUDIT_LOG, 'utf8')).trim().split('\n').map(JSON.parse);
      if (results.every(x => rows.some(row => row.requestId === x.requestId && row.responseFinished))) break;
      await delay(20);
    }
    for (const result of results) {
      const related = rows.filter(row => row.requestId === result.requestId);
      assert(related.some(row => row.event === 'tool_result' && row.commandId === result.commandId && row.nextAction === 'done'));
      assert(related.some(row => row.responseFinished && row.taskStatus === 'succeeded' && row.commandId === result.commandId));
      assert(related.every(row => row.commandId === result.commandId));
    }
    const text = JSON.stringify(rows);
    for (const secret of ['private-output', 'private-label', f.token, f.root, 'printf']) assert(!text.includes(secret));
  } finally { await f.cleanup(); }
});

test('terminal input is distinguished from silent computation without sending unsolicited input', { timeout: 12000 }, async () => {
  const f = await serverFixture();
  try {
    await f.start(); const c = f.client();
    const a = await c.execute({ terminalKey: 'input', cwd: f.root, command: 'read -r -p "Answer: " answer; printf "value=%s" "$answer"', waitMs: 100 });
    let page;
    for (let i = 0; i < 40; i++) {
      page = await c.read({ sessionId: a.sessionId, commandId: a.commandId, statusOnly: true });
      if (page.interaction || page.interactionHint) break; await delay(25);
    }
    if (page.interaction) {
      assert.equal(page.interaction.type, 'terminal_input'); assert.equal(page.nextAction, 'input');
      await assert.rejects(c.waitForCompletion({ sessionId: a.sessionId, commandId: a.commandId }), e => e.code === 'interaction_required');
    } else {
      assert.equal(page.interactionHint?.type, 'possible_terminal_input'); assert.equal(page.nextAction, 'poll');
      await assert.rejects(c.waitForCompletion({ sessionId: a.sessionId, commandId: a.commandId }, { timeoutMs: 150 }), e => e.recovery.commandId === a.commandId);
    }
    await c.call(await c.connectionForCall(), { sessionId: a.sessionId, input: 'intended\n', waitMs: 0 });
    const end = await c.waitForCompletion({ sessionId: a.sessionId, commandId: a.commandId, cursor: a.startCursor });
    assert.match(end.stdout, /value=intended/); assert.equal(end.exitCode, 0);
  } finally { await f.cleanup(); }
});
