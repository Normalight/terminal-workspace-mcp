import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fixture, workspaceRoot } from './helpers.mjs';
import { TerminalManager } from '../src/terminal-manager.mjs';
const exec = promisify(execFile);

test('service definitions load from an external workspace and reference private configuration without embedding credentials', async () => {
  const f = await fixture();
  try {
    const config = path.join(f.root, 'deployment.json');
    await writeFile(config, JSON.stringify({ workspaceRoot: '.', auth: { token: 'synthetic-private-service-token' } }));
    const result = await exec('python3', ['-B', path.join(workspaceRoot, 'mcp_server/scripts/services.py'), 'prepare', '--config', config, '--prefix', 'integration-test'], { env: { ...f.env, MCP_WORKSPACE_ROOT: path.join(f.root, 'wrong'), MCP_PORT: '1' } });
    const manifest = JSON.parse(result.stdout); assert.equal(manifest.workspace, f.root);
    const files = (await readdir(manifest.directory)).filter(x => x.endsWith('.service'));
    assert.equal(files.length, 3);
    for (const file of files) {
      const text = await readFile(path.join(manifest.directory, file), 'utf8');
      assert(!text.includes('synthetic-private-service-token')); assert(!text.includes('BOTMUX_'));
    }
    // Unit syntax is checked by systemd itself; this does not install anything.
    await exec('systemd-analyze', ['verify', ...files.map(x => path.join(manifest.directory, x))], { env: f.env });
  } finally { await f.cleanup(); }
});

test('supervised component starts without a controlling terminal or caller session environment and persists output', async () => {
  const f = await fixture();
  try {
    const config = path.join(f.root, 'deployment.json'), spec = path.join(f.root, 'component.json');
    await writeFile(config, JSON.stringify({ workspaceRoot: '.', auth: { token: 'synthetic' } }));
    await writeFile(spec, JSON.stringify({ configFile: config, component: 'test', executable: process.execPath,
      args: ['-e', "if (process.env.BOTMUX_TEST || process.stdin.isTTY || !process.env.TMPDIR.startsWith(process.argv[1])) process.exit(1); console.log('INDEPENDENT')", f.root] }));
    await exec(process.execPath, [path.join(workspaceRoot, 'mcp_server/scripts/supervised-runtime.mjs'), spec], { cwd: workspaceRoot, env: { ...f.env, BOTMUX_TEST: 'caller-only' } });
    assert.equal(await readFile(path.join(f.root, 'outputs/mcp-runtime/test.stdout.log'), 'utf8'), 'INDEPENDENT\n');
  } finally { await f.cleanup(); }
});

test('terminal supervisor starts an empty persistent tmux server with a recoverable PID', async () => {
  const f = await fixture();
  const socket = path.join(f.root, 'terminals/tmux.sock');
  try {
    const config = path.join(f.root, 'tmux.conf'), spec = path.join(f.root, 'tmux.json'), pidFile = path.join(f.root, 'tmux.pid');
    await writeFile(config, 'set-option -g exit-empty off\n');
    await writeFile(spec, JSON.stringify({ root: path.dirname(socket), tmux: '/usr/bin/tmux', tmuxConfig: config, pidFile, unit: 'isolated-test-terminals.service' }));
    await exec('python3', ['-B', path.join(workspaceRoot, 'mcp_server/scripts/tmux-service.py'), '--spec', spec], { env: f.env });
    const saved = (await readFile(pidFile, 'utf8')).trim();
    const queried = await exec('tmux', ['-S', socket, 'display-message', '-p', '#{pid}'], { env: f.env });
    assert.equal(queried.stdout.trim(), saved);
    await exec('tmux', ['-S', socket, 'new-session', '-d', '-s', 'probe', 'sleep 10'], { env: f.env });
    await exec('tmux', ['-S', socket, 'kill-session', '-t', 'probe'], { env: f.env });
    assert.equal((await exec('tmux', ['-S', socket, 'display-message', '-p', '#{pid}'], { env: f.env })).stdout.trim(), saved);
    const manager = await new TerminalManager({ root: path.dirname(socket), env: f.env }).initialize();
    assert.equal(await manager.liveSessionCount(), 0);
    const terminal = await manager.open({ terminalKey: 'supervised/start', cwd: f.root });
    assert.equal((await manager.execute(terminal.sessionId, { command: 'printf READY', waitMs: 1000 })).output.content, 'READY');
  } finally { await exec('tmux', ['-S', socket, 'kill-server'], { env: f.env }).catch(() => {}); await f.cleanup(); }
});
