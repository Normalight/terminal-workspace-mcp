import test from 'node:test';
import assert from 'node:assert/strict';
import { CompletionNotifications } from '../src/completion-notifications.mjs';

test('completion subscriptions defer offline delivery, retry, deduplicate and honour opt-out', async () => {
  let connected = false, attempts = 0;
  const messages = [];
  const state = { sessionId: 'term_saved', commandId: 'cmd_saved', status: 'running' };
  const watcher = new CompletionNotifications({
    terminals: { commandStatus: async () => ({ ...state, status: 'succeeded', exitCode: 0, outputEndCursor: 123, command: 'SECRET' }) },
    ready: () => connected,
    send: async msg => { if (++attempts === 1) throw Error('temporary disconnect'); messages.push(msg); },
  });
  try {
    const subscription = watcher.observe(state, undefined, true).completionNotification;
    assert(subscription.subscribed); assert.equal(subscription.listening, false);
    await watcher.tick(); assert.equal(attempts, 0);
    connected = true;
    assert.equal(watcher.observe(state).completionNotification.listening, true);
    await watcher.tick(); assert.equal(messages.length, 0);
    await watcher.tick(); assert.equal(messages.length, 1);
    assert.equal(messages[0].data.outputEndCursor, 123);
    assert(!JSON.stringify(messages).includes('SECRET'));
    watcher.observe(state, true); await watcher.tick(); assert.equal(messages.length, 1);
    const other = { ...state, commandId: 'cmd_other' };
    watcher.observe(other, true); watcher.observe(other, false); await watcher.tick();
    assert.equal(messages.length, 1);
  } finally { watcher.close(); }
});

test('subscriptions are bounded, isolated, and released during an in-flight status read', async () => {
  const state = { jobId: 'job_one', status: 'running' };
  let release;
  const messages = [];
  const watcher = new CompletionNotifications({ maxPending: 1,
    jobs: { status: () => new Promise(resolve => { release = resolve; }) }, send: msg => messages.push(msg),
  });
  watcher.observe(state, true);
  assert.equal(watcher.observe({ ...state, jobId: 'job_two' }, true).completionNotification.reason, 'subscription_limit');
  const tick = watcher.tick();
  watcher.close(); release({ status: 'cancelled', exitCode: null }); await tick;
  assert.equal(messages.length, 0); assert.equal(watcher.pending.size, 0);
});

test('a logging filter retains a completed result until delivery is allowed', async () => {
  let enabled = false, reads = 0, sends = 0;
  const watcher = new CompletionNotifications({
    jobs: { status: async () => { reads++; return { status: 'timed_out', exitCode: null }; } },
    send: async () => { if (!enabled) return false; sends++; return true; },
  });
  try {
    watcher.observe({ jobId: 'job_timeout', status: 'running' }, true);
    await watcher.tick(); await watcher.tick(); assert.equal(sends, 0); assert.equal(reads, 1);
    enabled = true; await watcher.tick(); assert.equal(sends, 1);
  } finally { watcher.close(); }
});
