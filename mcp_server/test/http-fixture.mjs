import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { ReconnectingTerminalClient } from '../client/reconnecting-client.mjs';
import { TerminalManager } from '../src/terminal-manager.mjs';
import { fixture, workspaceRoot } from './helpers.mjs';
import { delay } from '../src/runtime.mjs';
export async function serverFixture() {
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
