import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { BotmuxCompletionWatcher } from '../src/botmux-completion-watcher.mjs';
import { taskMessage } from '../src/botmux-task-monitor.mjs';
import { runBotmuxCli } from '../src/botmux-cli.mjs';
import { atomicJson, jsonFile, KeyedMutex } from '../src/runtime.mjs';
import { loadConfig } from '../src/config.mjs';
import { fixture } from './helpers.mjs';

const uuid = '11111111-1111-4111-8111-111111111111';
const ids = { sessionId: `term_${uuid}`, commandId: `cmd_${uuid}` };
const config = { enabled: true, mode: 'task', executable: 'botmux', botAppId: 'cli_bot', chatId: 'oc_group', mentionOpenId: 'ou_user',
  minDurationMs: 1000, pollIntervalMs: 60000, progressIntervalMs: 2000, sendTimeoutMs: 1000, taskTimeoutMs: 5000,
  eventTimeoutMs: 3000, retryDelayMs: 100, maxAttempts: 2 };
const start = Date.parse('2026-09-27T00:00:00Z');
async function setup() {
  const f = await fixture(), lock = new KeyedMutex(), calls = [], messages = [], watchers = []; let now = start + 2000, response = 'completed', failure;
  const state = { ...ids, startedAt: new Date(start).toISOString(), status: 'running', executionStatus: 'running', taskSummary: '**数据评估： **', command: 'SECRET', output: 'PRIVATE_LOG' };
  let event;
  const run = async ({ args }) => {
    calls.push(args);
    if (failure) return failure;
    if (args.includes('--prompt-file')) {
      const brief = await readFile(args[args.indexOf('--prompt-file') + 1], 'utf8');
      assert(!brief.includes('SECRET')); assert(!brief.includes('PRIVATE_LOG'));
      event = brief.match(/事件：([^；]+)；/)[1];
    }
    const value = args[1] === 'start' ? { sessionId: `hl_${uuid}`, botmuxSessionId: uuid, state: 'completed', output: { content: JSON.stringify({ eventId: event, summary: '已接手监听。' }) } }
      : args[1] === 'bind' ? { rootMessageId: 'om_topic' }
      : args[1] === 'send' ? { trigger: { triggerId: `trg_${uuid}` } }
      : { state: response, output: { content: JSON.stringify({ eventId: event, summary: '依据最新状态同步。' }) } };
    return { status: 'ok', value };
  };
  const terminals = { fileLocked: (_key, _file, fn) => lock.run('worker', fn), commandStatus: async () => state };
  const make = async overrides => {
    const w = await new BotmuxCompletionWatcher({ config: { ...config, ...overrides }, root: path.join(f.root, 'watches'), terminals,
      env: f.env, cwd: f.root, now: () => now, run, send: async args => { messages.push(args); return { status: 'sent', messageId: `om_${messages.length}` }; } }).initialize();
    watchers.push(w); await w.running; return w;
  };
  const w = await make();
  const file = w.file(ids.sessionId, ids.commandId);
  return { ...f, w, state, calls, messages, make, file, get: () => jsonFile(file), advance: ms => { now += ms; },
    response: value => { response = value; }, failure: value => { failure = value; },
    done: duration => Object.assign(state, { status: 'failed', executionStatus: 'failed', outputStatus: 'complete', exitCode: 3, finishedAt: new Date(start + duration).toISOString() }),
    cleanup: async () => { for (const w of watchers) await w.close(); await f.cleanup(); } };
}

test('task mode validates bot, group and start/completion recipient without requiring an existing topic', async () => {
  const env = { MCP_BOTMUX_ENABLED: '1', MCP_BOTMUX_MODE: 'task', MCP_BOTMUX_SESSION_ID: '', MCP_BOTMUX_BOT_APP_ID: 'cli_bot', MCP_BOTMUX_CHAT_ID: 'oc_group', MCP_BOTMUX_MENTION_OPEN_ID: 'ou_user' };
  assert.equal(loadConfig({ env }).config.notifications.botmux.mode, 'task');
  for (const key of ['MCP_BOTMUX_BOT_APP_ID', 'MCP_BOTMUX_CHAT_ID', 'MCP_BOTMUX_MENTION_OPEN_ID']) assert.throws(() => loadConfig({ env: { ...env, [key]: '' } }), /required/);
});

test('a delegated task owns a new topic and serializes start, progress and final delivery across restart', async () => {
  const f = await setup();
  try {
    await Promise.all([f.w.observe(f.state), f.w.observe(f.state)]);
    await f.w.tick(); await f.w.tick(); await f.w.tick();
    assert.equal(f.calls.filter(a => a[1] === 'start').length, 1);
    const bind = f.calls.find(a => a[1] === 'bind'); assert(!bind.includes('--into')); assert(bind.includes('none'));
    assert.equal(f.messages[0].target.mentionOpenId, 'ou_user'); assert.equal(f.messages[0].target.sessionId, uuid);
    assert(!f.messages[0].message.includes('**')); assert(f.messages[0].message.includes('\n\n'));
    await f.w.close(); const b = await f.make({ chatId: 'oc_other', mentionOpenId: 'ou_other' });
    f.advance(2100); await b.tick(); await b.tick(); await b.tick();
    assert.equal(f.messages.length, 2); assert.equal(f.messages[1].target.mentionOpenId, '');
    assert.equal(f.calls.filter(a => a[1] === 'start').length, 1);
    f.done(4500); await b.tick(); await b.tick(); await b.tick(); await b.tick();
    assert.equal(f.messages.length, 3); assert.equal(f.messages[2].target.mentionOpenId, 'ou_user');
    assert.match(f.messages[2].message, /执行失败/); assert.match(f.messages[2].message, /退出码：3/);
    assert.equal((await f.get()).status, 'sent');
    assert.equal((await b.observe(f.state)).externalNotification.task.rootMessageId, 'om_topic');
  } finally { await f.cleanup(); }
});

test('short tasks stay silent and a caller estimate can hand off before the threshold', async () => {
  const f = await setup();
  try {
    await f.w.observe(f.state); f.done(500); await f.w.tick(); assert.equal((await f.get()).status, 'skipped'); assert.equal(f.calls.length, 0);
    f.state.commandId = 'cmd_22222222-2222-4222-8222-222222222222';
    Object.assign(f.state, { status: 'running', startedAt: new Date(start + 2000).toISOString(), finishedAt: undefined, estimatedDurationMs: 10000 });
    await f.w.observe(f.state); await f.w.tick(); assert.equal(f.calls.length, 1);
  } finally { await f.cleanup(); }
});

test('stalled agent turns have a deadline and completion is still delivered without queuing more turns', async () => {
  const f = await setup();
  try {
    await f.w.observe(f.state); await f.w.tick(); await f.w.tick(); await f.w.tick();
    f.response('running'); f.advance(2100); await f.w.tick();
    await f.w.tick(); assert.equal(f.messages.length, 1);
    f.advance(3100); await f.w.tick(); await f.w.tick();
    assert((await f.get()).task.agentStalled); assert.match(f.messages[1].message, /机器人摘要暂不可用/);
    f.done(7000); await f.w.tick(); await f.w.tick();
    assert.equal(f.messages.length, 3); assert.equal((await f.get()).status, 'sent');
    assert.equal(f.calls.filter(a => a[1] === 'send').length, 1);
  } finally { await f.cleanup(); }
});

test('crashed mutations are never replayed and missing executables have bounded retries', async () => {
  const f = await setup();
  try {
    await f.w.observe(f.state); const record = await f.get(); record.status = 'binding_task'; await atomicJson(f.file, record);
    await f.w.tick(); assert.equal((await f.get()).status, 'uncertain'); assert.equal(f.calls.length, 0);
    record.status = 'watching'; await atomicJson(f.file, record); f.failure({ status: 'retry', code: 'botmux_not_found' });
    await f.w.tick(); assert.equal((await f.get()).status, 'watching'); f.advance(101); await f.w.tick();
    assert.equal((await f.get()).status, 'failed'); assert.equal(f.calls.length, 2);
  } finally { await f.cleanup(); }
});

test('task formatter preserves unknown results and CLI failures never claim success', async () => {
  const body = taskMessage({ kind: 'completion', snapshot: { ...ids, taskSummary: '**用途： **', status: 'unknown', elapsedMs: null, exitCode: null }, fallback: true });
  assert.match(body, /状态待核查/); assert.match(body, /时长：未知/); assert(!body.includes('**'));
  const f = await fixture();
  try {
    assert.equal((await runBotmuxCli({ executable: path.join(f.root, 'missing'), args: [], env: f.env, cwd: f.root, timeoutMs: 1000 })).status, 'retry');
    const result = await runBotmuxCli({ executable: process.execPath, args: ['-e', 'console.log(JSON.stringify({ok:true,value:1},null,2))'], env: f.env, cwd: f.root, timeoutMs: 2000 });
    assert.equal(result.value.value, 1);
  } finally { await f.cleanup(); }
});
