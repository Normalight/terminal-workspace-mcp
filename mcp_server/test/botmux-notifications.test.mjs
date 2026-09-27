import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { fixture } from './helpers.mjs';
import { serverFixture } from './http-fixture.mjs';
import { atomicJson, jsonFile, KeyedMutex, delay } from '../src/runtime.mjs';
import { loadConfig } from '../src/config.mjs';
import { BotmuxCompletionWatcher } from '../src/botmux-completion-watcher.mjs';
import { sendBotmux, completionMessage } from '../src/botmux-notifier.mjs';
import { describeTask } from '../src/task-summary.mjs';

const route = '11111111-1111-4111-8111-111111111111';
const ids = { sessionId: 'term_11111111-1111-4111-8111-111111111111', commandId: 'cmd_22222222-2222-4222-8222-222222222222' };
const startedAt = '2026-09-27T00:00:00Z', start = Date.parse(startedAt);
const config = { enabled: true, executable: 'botmux', sessionId: route, mentionOpenId: 'ou_test',
  minDurationMs: 1000, pollIntervalMs: 60000, sendTimeoutMs: 1000, retryDelayMs: 100, maxAttempts: 3 };

test('task summaries normalize caller text and classify omitted descriptions without command arguments', () => {
  assert.deepEqual(describeTask('private-command', '  数据\n评估\t任务 '), { taskSummary: '数据 评估 任务', taskSummarySource: 'caller' });
  assert.deepEqual(describeTask('/private/env/bin/python3 /private/task.py --token=SECRET'), { taskSummary: 'Python 程序任务', taskSummarySource: 'command_type' });
  assert.equal(describeTask('TOKEN=SECRET npm test').taskSummary, '终端后台任务');
  for (const value of ['', '\x00\t', 123, 'x'.repeat(241)]) assert.throws(() => describeTask('true', value), /taskSummary/);
});

test('completion summaries distinguish failure and missing output, escape supplied Markdown, and omit logs', () => {
  const message = completionMessage({ ...ids, terminalId: ids.sessionId, durationMs: 1500, taskSummary: '评估 [模型](private-url)' },
    { executionStatus: 'failed', exitCode: 2, outputStatus: 'incomplete', command: 'SECRET', output: 'SECRET_LOG' });
  assert.match(message, /任务摘要：评估 \\\[模型\\\]/);
  assert.match(message, /结果摘要：执行失败；输出可能不完整/);
  assert(!message.includes('SECRET')); assert(!message.includes('[模型](private-url)'));
});
async function setup() {
  const f = await fixture(), lock = new KeyedMutex(), instances = []; let now = start + 2000, sends = 0;
  const state = { ...ids, status: 'running', executionStatus: 'running', startedAt, command: 'private-command' };
  const terminals = { fileLocked: (_key, _file, operation) => lock.run('worker', operation), commandStatus: async () => state };
  async function watcher(overrides = {}, sender = async () => { sends++; return { status: 'sent', messageId: 'om_test' }; }) {
    const w = await new BotmuxCompletionWatcher({ config: { ...config, ...overrides }, root: path.join(f.root, 'watches'), terminals,
      env: f.env, cwd: f.root, now: () => now, send: sender }).initialize();
    instances.push(w); await w.running; return w;
  }
  return { ...f, state, watcher, get sends() { return sends; }, advance: ms => { now += ms; },
    done: duration => Object.assign(state, { status: 'succeeded', executionStatus: 'succeeded', outputStatus: 'complete', exitCode: 0, finishedAt: new Date(start + duration).toISOString() }),
    cleanup: async () => { for (const w of instances) await w.close(); await f.cleanup(); } };
}

test('botmux is optional and enabling requires an explicit session route', async () => {
  const f = await setup();
  try {
    assert.equal(loadConfig({ env: { MCP_BOTMUX_ENABLED: '0' } }).config.notifications.botmux.enabled, false);
    assert.throws(() => loadConfig({ env: { MCP_BOTMUX_ENABLED: '1', MCP_BOTMUX_SESSION_ID: '' } }), /sessionId/);
    const w = await f.watcher({ enabled: false });
    assert.equal(await w.observe(f.state), f.state); await w.tick(); assert.equal(f.sends, 0);
    await assert.rejects(readdir(w.root), e => e.code === 'ENOENT');
  } finally { await f.cleanup(); }
});

test('durable registrations deduplicate concurrent clients and worker instances without exporting commands', async () => {
  const f = await setup();
  try {
    const a = await f.watcher(), b = await f.watcher();
    const replies = await Promise.all([a.observe(f.state), b.observe(f.state), a.observe(f.state)]);
    assert(replies.every(x => x.externalNotification.registered));
    const file = a.file(ids.sessionId, ids.commandId); assert(!(await readFile(file, 'utf8')).includes('private-command'));
    f.done(1500); await Promise.all([a.tick(), b.tick()]); assert.equal(f.sends, 1);
    assert.equal((await a.observe(f.state)).externalNotification.status, 'sent');
    await a.tick(); assert.equal(f.sends, 1);
  } finally { await f.cleanup(); }
});

test('short completed tasks stay silent after downtime; old history is not newly registered', async () => {
  const f = await setup();
  try {
    const w = await f.watcher(); await w.observe(f.state); f.done(500); f.advance(600000); await w.tick();
    assert.equal(f.sends, 0); assert.equal((await w.observe(f.state)).externalNotification.status, 'skipped');
    assert.equal((await w.observe({ ...f.state, commandId: 'cmd_33333333-3333-4333-8333-333333333333' })).externalNotification, undefined);
  } finally { await f.cleanup(); }
});

test('retry schedule and original destination survive restart; interrupted send is not replayed', async () => {
  const f = await setup(); let target;
  try {
    const a = await f.watcher({}, async () => ({ status: 'retry', code: 'botmux_not_found' }));
    await a.observe(f.state); f.done(1500); await a.tick(); await a.close();
    const b = await f.watcher({ sessionId: '44444444-4444-4444-8444-444444444444' }, async args => { target = args.target; return { status: 'sent', messageId: 'om_ok' }; });
    assert.equal(target, undefined); f.advance(101); await b.tick(); assert.equal(target.sessionId, route);
    const file = b.file(ids.sessionId, ids.commandId), record = await jsonFile(file);
    record.status = 'sending'; await atomicJson(file, record); target = undefined; await b.tick();
    assert.equal(target, undefined); assert.equal((await jsonFile(file)).status, 'uncertain');
  } finally { await f.cleanup(); }
});

test('long task ending without a completion timestamp reports an observed lower bound, not success', async () => {
  const f = await setup(); let body;
  try {
    const w = await f.watcher({}, async args => { body = args.message; return { status: 'sent', messageId: 'om_closed' }; });
    await w.observe(f.state); await w.tick();
    Object.assign(f.state, { status: 'terminal_closed', executionStatus: 'terminal_closed', exitCode: null, outputStatus: 'incomplete' });
    await w.tick(); assert.match(body, /至少 2 秒/); assert.match(body, /退出码：未知/); assert.match(body, /输出状态：incomplete/);
  } finally { await f.cleanup(); }
});

test('botmux adapter uses explicit route/stdin and classifies missing binaries and timeouts', async () => {
  const f = await fixture();
  try {
    const exe = path.join(f.root, 'botmux'), record = path.join(f.root, 'sent.json');
    await writeFile(exe, `#!${process.execPath}\nimport {writeFile} from 'node:fs/promises';let text='';for await(const chunk of process.stdin)text+=chunk;await writeFile(${JSON.stringify(record)},JSON.stringify({args:process.argv.slice(2),text,ambient:Object.keys(process.env).some(k=>k.startsWith('BOTMUX_'))}));console.log(JSON.stringify({success:true,messageId:'om_adapter'}));`, { mode: 0o700 });
    const args = { executable: exe, timeoutMs: 2000, env: f.env, cwd: f.root, target: { sessionId: route, mentionOpenId: 'ou_test' }, message: 'literal $(touch NEVER)\nsecond line' };
    assert.equal((await sendBotmux(args)).status, 'sent');
    const sent = await jsonFile(record); assert.equal(sent.text, args.message); assert.equal(sent.ambient, false);
    assert.deepEqual(sent.args, ['send', '--session-id', route, '--no-quote', '--response-kind', 'auxiliary', '--mention', 'ou_test']);
    assert.equal((await sendBotmux({ ...args, executable: path.join(f.root, 'missing') })).status, 'retry');
    await writeFile(exe, `#!${process.execPath}\nsetTimeout(()=>{},10000);`, { mode: 0o700 });
    assert.equal((await sendBotmux({ ...args, timeoutMs: 100 })).status, 'uncertain');
  } finally { await f.cleanup(); }
});

test('MCP registration survives server/client loss and independently delivers once', { timeout: 15000 }, async () => {
  const f = await serverFixture();
  const exe = path.join(f.root, 'botmux'), delivered = path.join(f.root, 'deliveries'), message = path.join(f.root, 'message');
  await writeFile(exe, `#!${process.execPath}\nimport {appendFile,writeFile} from 'node:fs/promises';let text='';for await(const chunk of process.stdin)text+=chunk;await writeFile(${JSON.stringify(message)},text);await appendFile(${JSON.stringify(delivered)},'x');console.log(JSON.stringify({success:true,messageId:'om_integration'}));`, { mode: 0o700 });
  Object.assign(f.env, { MCP_BOTMUX_ENABLED: '1', MCP_BOTMUX_SESSION_ID: route, MCP_BOTMUX_EXECUTABLE: exe,
    MCP_SERVICE_ROOT: path.join(f.root, 'runtime'), MCP_BOTMUX_MIN_DURATION_MS: '1000', MCP_BOTMUX_POLL_INTERVAL_MS: '100' });
  try {
    await f.start(); const c = f.client();
    const a = await c.execute({ terminalKey: 'notify', cwd: f.root, command: 'printf x >> once; while [ ! -f release ]; do sleep .05; done', taskSummary: '验证断线后任务只执行一次', waitMs: 0 });
    assert.equal(a.taskSummary, '验证断线后任务只执行一次');
    assert.equal(a.externalNotification.status, 'watching'); await c.close(); await f.stop();
    await delay(1100); await writeFile(path.join(f.root, 'release'), ''); await f.start();
    for (let i = 0; i < 100 && await readFile(delivered, 'utf8').catch(() => '') !== 'x'; i++) await delay(50);
    assert.equal(await readFile(delivered, 'utf8'), 'x'); await f.stop(); await f.start(); await delay(250);
    assert.equal(await readFile(delivered, 'utf8'), 'x'); assert.equal(await readFile(path.join(f.root, 'once'), 'utf8'), 'x');
    const summary = await readFile(message, 'utf8'); assert.match(summary, /任务摘要：验证断线后任务只执行一次/);
    assert.match(summary, /结果摘要：已完成；输出收集已结束/); assert(!summary.includes('printf'));
    const resumed = f.client(), saved = await resumed.read({ sessionId: a.sessionId, commandId: a.commandId, statusOnly: true, waitMs: 0 });
    assert.equal(saved.taskSummary, a.taskSummary); assert.equal(saved.taskSummarySource, 'caller');
    await assert.rejects(resumed.read({ sessionId: a.sessionId, commandId: a.commandId, taskSummary: 'changed', waitMs: 0 }), /submission/);
    await resumed.close();
  } finally { await f.cleanup(); }
});
