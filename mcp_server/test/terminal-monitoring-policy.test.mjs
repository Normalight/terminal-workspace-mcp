import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { terminalMonitoring } from '../src/terminal-monitoring-policy.mjs';
import { serverFixture } from './http-fixture.mjs';
import { ReconnectingTerminalClient } from '../client/reconnecting-client.mjs';
import { delay } from '../src/runtime.mjs';

test('defer guidance separates unknown, usable and exceeded estimates and preserves final/input states', () => {
  const now = Date.parse('2026-09-27T12:00:00Z');
  const active = { sessionId: 'saved', commandId: 'saved', status: 'running', executionStatus: 'running',
    submittedAt: new Date(now - 30000).toISOString(), outputRead: false };
  const unknown = terminalMonitoring(active, { now, cursor: 7 });
  assert.equal(unknown.nextAction, 'defer'); assert.equal(unknown.status, 'running');
  assert.equal(unknown.monitoring.estimatedRemainingMs, null); assert.equal(unknown.monitoring.estimateSource, 'unavailable');
  assert.equal(unknown.monitoring.checkAfterMs, 30000); assert.equal(unknown.monitoring.resume.cursor, 7);
  const estimated = terminalMonitoring({ ...active, submittedAt: new Date(now - 1000).toISOString(), estimatedDurationMs: 180000 }, { now });
  assert.equal(estimated.nextAction, 'defer'); assert.equal(estimated.monitoring.reason, 'estimated_long_task');
  assert.equal(estimated.monitoring.estimatedRemainingMs, 179000); assert.equal(estimated.monitoring.estimateSource, 'caller');
  const exceeded = terminalMonitoring({ ...active, estimatedDurationMs: 20000 }, { now });
  assert.equal(exceeded.monitoring.estimatedRemainingMs, null); assert(exceeded.monitoring.estimateExceeded);
  assert.equal(terminalMonitoring({ ...active, submittedAt: new Date(now - 29999).toISOString() }, { now }).nextAction, 'poll');
  assert.equal(terminalMonitoring({ ...active, interaction: { type: 'pager' } }, { now }).nextAction, 'input');
  assert.equal(terminalMonitoring({ ...active, status: 'submission_uncertain', executionStatus: 'submission_uncertain' }, { now }).nextAction, 'inspect');
  assert.equal(terminalMonitoring({ ...active, status: 'succeeded', executionStatus: 'succeeded' }, { now }).nextAction, 'read_output');
  assert.equal(terminalMonitoring({ ...active, status: 'succeeded', executionStatus: 'succeeded', outputRead: true }, { now }).nextAction, 'done');
});

test('foreground monitoring yields across reconnect; saved command continues once and later completes', { timeout: 15000 }, async () => {
  const f = await serverFixture(); f.env.MCP_TERMINAL_FOREGROUND_BUDGET_MS = '1000';
  try {
    await f.start(); const c = f.client({ fetch: (url, options) => options?.method === 'GET' ? Promise.resolve(new Response('', { status: 405 })) : fetch(url, options) });
    const first = await c.execute({ terminalKey: 'yield-age', cwd: f.root, waitMs: 0,
      command: 'printf x >> once; while [ ! -f release ]; do sleep .02; done; printf FINISHED' });
    const target = { sessionId: first.sessionId, commandId: first.commandId, cursor: first.nextCursor };
    const yielded = await c.monitorUntilYield(target);
    assert.equal(yielded.status, 'running'); assert.equal(yielded.nextAction, 'defer'); assert(yielded.monitoringStopped);
    assert.equal(yielded.recovery.cursor, target.cursor); assert.equal(yielded.nextCursor, undefined);
    assert.equal(yielded.completionNotification.fallback, 'defer');
    assert.equal(yielded.completionNotification.pollAfterMs, undefined);
    await f.stop(); await f.start();
    const recovered = await f.client().read(yielded.recovery);
    assert.equal(recovered.commandId, first.commandId); assert.equal(recovered.nextAction, 'defer');
    assert.equal(recovered.monitoring.estimatedRemainingMs, null);
    await writeFile(path.join(f.root, 'release'), '');
    const end = await c.waitForCompletion(yielded.recovery);
    assert.equal(end.nextAction, 'done'); assert.equal(end.exitCode, 0); assert.match(end.stdout, /FINISHED/);
    assert.equal(await readFile(path.join(f.root, 'once'), 'utf8'), 'x');
  } finally { await f.cleanup(); }
});

test('submission estimate persists through reads and cannot be replaced by polling', { timeout: 10000 }, async () => {
  const f = await serverFixture();
  try {
    await f.start(); const c = f.client();
    const a = await c.execute({ terminalKey: 'estimated', cwd: f.root, waitMs: 0, estimatedDurationMs: 180000,
      command: 'while [ ! -f release ]; do sleep .02; done' });
    assert.equal(a.nextAction, 'defer'); assert.equal(a.estimatedDurationMs, 180000);
    await f.stop(); await f.start();
    const target = { sessionId: a.sessionId, commandId: a.commandId, statusOnly: true };
    const state = await c.read(target); assert.equal(state.estimatedDurationMs, 180000); assert.equal(state.nextAction, 'defer');
    await assert.rejects(c.read({ ...target, estimatedDurationMs: 1 }), e => e.serverCode === 'invalid_input');
    await writeFile(path.join(f.root, 'release'), '');
    await delay(100); const end = await c.waitForCompletion({ sessionId: a.sessionId, commandId: a.commandId });
    assert.equal(end.exitCode, 0);
  } finally { await f.cleanup(); }
});

test('foreground consumer returns its acknowledged cursor with unread pages instead of draining forever', async () => {
  const c = new ReconnectingTerminalClient({ url: 'http://127.0.0.1:1/mcp' }); let calls = 0;
  c.read = async () => { calls++; return { sessionId: 'saved', commandId: 'saved', status: 'running', nextAction: 'defer',
    outputRead: true, stdout: 'page', nextCursor: 4, outputTruncated: true, outputComplete: false }; };
  try {
    const page = await c.monitorUntilYield({ sessionId: 'saved', commandId: 'saved', cursor: 0 }, { onPage: async (_page, checkpoint) => assert.equal(checkpoint.cursor, 4) });
    assert.equal(calls, 1); assert.equal(page.recovery.cursor, 4); assert.equal(page.outputComplete, false);
  } finally { await c.close(); }
});
