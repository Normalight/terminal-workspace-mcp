import path from 'node:path';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { atomicJson, jsonFile, quote } from './runtime.mjs';

const ID = /^term_[a-f0-9-]{36}$/;
const NATIVE = /^\$\d+$/;

// Inventory and reclamation deliberately use the configured socket, native tmux
// IDs, on-disk records AND ownership evidence. A session-name prefix is not proof.
export class TerminalAdmin {
  constructor(manager) { this.manager = manager; }
  async record(id) {
    if (!ID.test(id)) return null;
    const dir = this.manager.dir(id);
    if (!(await lstat(dir).catch(() => null))?.isDirectory()) return null;
    if (!(await lstat(path.join(dir, 'meta.json')).catch(() => null))?.isFile()) return null;
    const meta = await jsonFile(path.join(dir, 'meta.json'), null).catch(() => null);
    return meta?.sessionId === id && meta.log === path.join(dir, 'terminal.log') ? meta : null;
  }
  async inspect(nativeId, { idleTtlMs = 0, now = Date.now() } = {}) {
    if (!NATIVE.test(nativeId)) throw new Error('invalid native tmux ID');
    const t = this.manager;
    const name = await t.run(['display-message', '-p', '-t', nativeId, '#{session_name}']);
    const meta = await this.record(name);
    const tags = (await t.run(['display-message', '-p', '-t', nativeId, '#{@mcp_manager}\t#{@mcp_owner}'])).split('\t');
    const attached = Number(await t.run(['display-message', '-p', '-t', nativeId, '#{session_attached}']));
    const keep = (await t.run(['display-message', '-p', '-t', nativeId, '#{@mcp_keep}'])) === '1';
    const windows = (await t.run(['list-windows', '-t', nativeId, '-F', '#{window_id}'])).split('\n').filter(Boolean);
    const panes = (await t.run(['list-panes', '-s', '-t', nativeId, '-F', '#{pane_id}\t#{pane_dead}\t#{pane_pid}'])).split('\n').filter(Boolean).map(line => {
      const [id, dead, pid] = line.split('\t'); return { id, dead: dead === '1', pid: Number(pid) };
    });
    let ownership = 'unverified';
    if (meta?.owner === t.owner && meta.managerId === t.managerId && meta.tmuxSessionId === nativeId && tags[0] === t.owner && tags[1] === t.managerId) ownership = 'tagged';
    // Older releases used the same private socket and generated Bash rcfile.
    // Recognize their exact launch signature without adopting arbitrary sessions.
    if (meta && !meta.owner && !tags[0] && !tags[1] && windows.length === 1 && panes.length === 1) {
      let launch = await t.run(['display-message', '-p', '-t', panes[0].id, '#{pane_start_command}']);
      // tmux formats a one-argument shell command with outer double quotes.
      if (launch.startsWith('"') && launch.endsWith('"')) launch = launch.slice(1, -1).replace(/\\(["\\$`])/g, '$1');
      const suffix = `; exec /bin/bash --noprofile --rcfile ${quote(path.join(t.dir(name), 'shell.rc'))} -i`;
      if (launch.endsWith(suffix) && launch.startsWith(`${quote(t.tmux)} -S ${quote(t.socket)} wait-for `)) ownership = 'legacy';
    }
    const managed = ownership !== 'unverified';
    let commandStatus = null, finishedAt = null;
    if (managed) {
      const current = await jsonFile(path.join(t.dir(name), 'current.json'), null).catch(() => null);
      if (current?.commandId) {
        const command = await t.commandStatus(name, current.commandId).catch(() => ({ status: 'unknown' }));
        commandStatus = command.status; finishedAt = command.finishedAt;
      }
    }
    const activity = managed ? await jsonFile(path.join(t.dir(name), 'activity.json'), null).catch(() => null) : null;
    const lastUsedAt = Math.max(Date.parse(meta?.createdAt ?? ''), Date.parse(activity?.lastUsedAt ?? meta?.createdAt ?? ''), Date.parse(finishedAt ?? meta?.createdAt ?? ''));
    const idleMs = Number.isFinite(lastUsedAt) ? Math.max(0, now - lastUsedAt) : null;
    let idleShell = false;
    if (panes.length === 1 && !panes[0].dead && commandStatus !== 'running' && commandStatus !== 'unknown') {
      try {
        const pid = panes[0].pid;
        const children = await readFile(`/proc/${pid}/task/${pid}/children`, 'utf8');
        const comm = await readFile(`/proc/${pid}/comm`, 'utf8');
        idleShell = children.trim() === '' && comm.trim() === 'bash';
      } catch { /* Unknown process state is never eligible for idle cleanup. */ }
    }
    const state = panes.length && panes.every(p => p.dead) ? 'exited' : commandStatus === 'running' ? 'active' : idleShell ? 'idle' : 'live';
    const eligible = state === 'exited' || (state === 'idle' && idleTtlMs > 0 && idleMs !== null && idleMs >= idleTtlMs);
    const reclaimable = managed && eligible && !keep && attached === 0 && windows.length === 1 && panes.length === 1;
    const reason = !managed ? 'unverified_owner' : keep ? 'kept_session' : attached > 0 ? 'attached_client' : windows.length !== 1 || panes.length !== 1 ? 'modified_layout' : state === 'exited' ? 'exited_managed_session' : reclaimable ? 'idle_expired' : state === 'idle' ? 'idle_not_expired' : 'live_session';
    return { sessionId: name, tmuxSessionId: nativeId, managed, ownership, state, commandStatus, attached, keep, idleMs, windows, panes, reclaimable, reason, ...(managed ? { createdAt: meta.createdAt, log: meta.log, name: meta.name } : {}) };
  }
  async inventory(options = {}) {
    const t = this.manager;
    // A missing socket is normal before first use. Other tmux failures are
    // surfaced instead of silently reporting an empty, healthy inventory.
    const exists = await lstat(t.socket).then(() => true, () => false);
    let ids = [];
    if (exists) {
      try { ids = (await t.run(['list-sessions', '-F', '#{session_id}'])).split('\n').filter(Boolean); }
      catch (error) { if (!/no server running|Connection refused|No such file/.test(error.message)) throw error; }
    }
    const sessions = [], seen = new Set();
    for (const id of ids) {
      const item = await this.inspect(id, options); sessions.push(item); seen.add(item.sessionId);
    }
    for (const id of await readdir(t.root)) {
      if (seen.has(id)) continue;
      const meta = await this.record(id);
      if (meta) sessions.push({ sessionId: id, managed: meta.owner === t.owner && meta.managerId === t.managerId, ownership: 'record_only', state: 'missing', reclaimable: false, reason: 'no_tmux_session', log: meta.log, createdAt: meta.createdAt });
    }
    return { owner: t.owner, managerId: t.managerId, root: t.root, socket: t.socket, sessions };
  }
  async cleanup({ apply = false, sessionId, idleTtlMs = 0, now = Date.now() } = {}) {
    if (sessionId && !ID.test(sessionId)) throw new Error('invalid session ID');
    const inventory = await this.inventory({ idleTtlMs, now });
    const candidates = inventory.sessions.filter(s => s.reclaimable && (!sessionId || s.sessionId === sessionId));
    const removed = [], skipped = [];
    if (apply) for (const item of candidates) await this.manager.locked(item.sessionId, async () => {
      // Recheck each candidate immediately before the mutation. A tmux-side
      // conditional also checks the exact pane state, layout and attachments.
      const fresh = await this.inspect(item.tmuxSessionId, { idleTtlMs, now }).catch(() => null);
      if (!fresh?.reclaimable || fresh.sessionId !== item.sessionId || fresh.panes[0].id !== item.panes[0].id) { skipped.push(item.sessionId); return; }
      const paneCondition = fresh.state === 'exited' ? '#{pane_dead}' : '#{==:#{pane_current_command},bash}';
      const condition = `#{&&:${paneCondition},#{&&:#{!=:#{@mcp_keep},1},#{&&:#{==:#{session_attached},0},#{&&:#{==:#{session_windows},1},#{==:#{window_panes},1}}}}}`;
      const result = await this.manager.run(['if-shell', '-F', '-t', fresh.panes[0].id, condition, `kill-session -t '${fresh.tmuxSessionId}'`, 'display-message -p cleanup-skipped']);
      if (result.includes('cleanup-skipped')) { skipped.push(item.sessionId); return; }
      await atomicJson(path.join(this.manager.dir(item.sessionId), 'closed.json'), { closedAt: new Date().toISOString(), reason: fresh.reason });
      removed.push(item.sessionId);
    });
    return { ...inventory, dryRun: !apply, candidates: candidates.map(s => s.sessionId), removed, skipped, logsRetained: true };
  }
}
