import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fixture } from './helpers.mjs';
import { TerminalManager } from '../src/terminal-manager.mjs';
import { Workspace } from '../src/workspace.mjs';
import { registerTools } from '../src/tools.mjs';
import { delay } from '../src/runtime.mjs';

const exec = promisify(execFile);
const reuseRoot = root => path.join(root, 'tmux');
async function cleanup(manager, fixture) {
  for (const state of await manager.list()) await manager.close(state.sessionId).catch(() => {});
  await manager.run(['kill-server']).catch(() => {}); await fixture.cleanup();
}
function calls(workspace, manager) {
  const registered = new Map();
  registerTools({ registerTool: (name, spec, call) => registered.set(name, call) }, {
    workspace, terminals: manager, config: { enableTerminal: true, toolProfile: 'minimal', directFileMaxBytes: 1048576 },
  });
  return async args => {
    const r = await registered.get('execute_command')({ waitMs: 1000, maxBytes: 65536, ...args });
    assert(!r.isError, JSON.stringify(r)); return r.structuredContent;
  };
}

test('task key reuses one terminal across callers/managers and preserves cwd/env; reads never allocate', { timeout: 15000 }, async () => {
  const f = await fixture(), t = await new TerminalManager({ root: reuseRoot(f.root), env: f.env }).initialize();
  try {
    await assert.rejects(t.open({ terminalKey: 'project/missing', createIfMissing: false }), { code: 'terminal_not_found' });
    assert.equal(await t.liveSessionCount(), 0);
    const workspace = await new Workspace(f.root).initialize(), first = calls(workspace, t);
    await mkdir(path.join(f.root, 'child'));
    const a = await first({ terminalKey: 'project/task', command: 'cd child; export REUSE_VALUE=retained', cwd: f.root });
    assert.equal(a.terminalReused, false); assert.equal(a.terminalKey, 'project/task');
    const next = new TerminalManager({ root: t.root, env: f.env }), second = calls(workspace, next);
    // cwd is ignored on reuse, even if the new caller supplies a stale path.
    const b = await second({ terminalKey: 'project/task', command: 'printf "%s:%s" "$PWD" "$REUSE_VALUE"', cwd: '/no-such-cwd' });
    assert.equal(b.sessionId, a.sessionId); assert(b.terminalReused); assert.match(b.stdout, /child:retained/);
    const read = await second({ terminalKey: 'project/task', commandId: b.commandId, cursor: b.startCursor, waitMs: 0 });
    assert.equal(read.commandId, b.commandId); assert.equal(await t.liveSessionCount(), 1);
    assert.equal(await readFile(path.join(t.dir(a.sessionId), 'meta.json'), 'utf8').then(JSON.parse).then(x => x.terminalKey), 'project/task');
  } finally { await cleanup(t, f); }
});

test('independent processes racing the same task key create one shell and enforce the shared terminal limit', { timeout: 15000 }, async () => {
  const f = await fixture(), t = await new TerminalManager({ root: reuseRoot(f.root), env: f.env, maxSessions: 1 }).initialize();
  try {
    const moduleUrl = new URL('../src/terminal-manager.mjs', import.meta.url).href;
    const code = `import {TerminalManager} from ${JSON.stringify(moduleUrl)}; const t=await new TerminalManager({root:process.argv[1],maxSessions:1}).initialize(); console.log(JSON.stringify(await t.open({terminalKey:'same-task',cwd:process.argv[2]})));`;
    const rows = await Promise.all(Array.from({ length: 3 }, async () => JSON.parse((await exec(process.execPath, ['--input-type=module', '-e', code, t.root, f.root], { env: f.env, timeout: 10000 })).stdout)));
    assert.equal(new Set(rows.map(x => x.sessionId)).size, 1); assert.equal(rows.filter(x => !x.reused).length, 1);
    assert.equal(await t.liveSessionCount(), 1);
    assert((await t.open({ terminalKey: 'same-task', cwd: f.root })).reused);
    await assert.rejects(t.open({ terminalKey: 'other-task', cwd: f.root }), { code: 'capacity' });
  } finally { await cleanup(t, f); }
});

test('closed key reads retain history, explicit new commands replace the shell and report the old ID', { timeout: 15000 }, async () => {
  const f = await fixture(), t = await new TerminalManager({ root: reuseRoot(f.root), env: f.env }).initialize();
  try {
    const call = calls(await new Workspace(f.root).initialize(), t);
    const first = await call({ terminalKey: 'closed-task', command: 'export OLD_ENV=old; printf BEFORE_CLOSE', cwd: f.root });
    await t.close(first.sessionId);
    const old = await call({ terminalKey: 'closed-task', commandId: first.commandId, cursor: first.startCursor, waitMs: 0 });
    assert.equal(old.sessionId, first.sessionId); assert.match(old.stdout, /BEFORE_CLOSE/); assert.equal(await t.liveSessionCount(), 0);
    const fresh = await call({ terminalKey: 'closed-task', command: 'printf "ENV=%s" "${OLD_ENV-unset}"', cwd: f.root });
    assert.notEqual(fresh.sessionId, first.sessionId); assert.equal(fresh.replacedSessionId, first.sessionId); assert.equal(fresh.terminalReused, false); assert.match(fresh.stdout, /ENV=unset/);
    assert.equal((await t.commandStatus(first.sessionId, first.commandId)).exitCode, 0);
  } finally { await cleanup(t, f); }
});

test('reusing a busy key cannot launch duplicate work or consume an interactive prompt as command input', { timeout: 15000 }, async () => {
  const f = await fixture(), t = await new TerminalManager({ root: reuseRoot(f.root), env: f.env }).initialize();
  try {
    const id = (await t.open({ terminalKey: 'busy-task', cwd: f.root })).sessionId;
    const command = await t.execute(id, { command: 'sleep 30', waitMs: 0 });
    assert.equal((await t.open({ terminalKey: 'busy-task', cwd: f.root })).sessionId, id);
    await assert.rejects(t.execute(id, { command: 'printf WRONG' }), { code: 'terminal_busy' });
    await t.write(id, { key: 'C-c' });
    for (let i = 0; i < 100 && (await t.commandStatus(id, command.commandId)).status === 'running'; i++) await delay(20);
    await t.write(id, { input: 'read -r raw_answer; printf "ANSWER=%s" "$raw_answer"', enter: true });
    await delay(100);
    await assert.rejects(t.execute(id, { command: 'printf WRONG' }), { code: 'terminal_busy' });
    await t.write(id, { input: 'expected', enter: true }); await delay(100);
    const last = await t.execute(id, { command: 'printf SAFE', waitMs: 1000 }); assert.equal(last.exitCode, 0); assert.match(last.output.content, /SAFE/);
    assert.equal(await t.liveSessionCount(), 1);
  } finally { await cleanup(t, f); }
});
