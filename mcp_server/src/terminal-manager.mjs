import { createHash, randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { mkdir, open, readdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { atomicJson, atomicWrite, delay, integer, jsonFile, KeyedMutex, OperationError, quote } from "./runtime.mjs";
import { DEFAULT_SEGMENT_BYTES, readLog } from "./log-store.mjs";

import { environmentScript, isolatedLaunch, shellRc } from './terminal-shell.mjs';
import { submitCommand, commandState } from './terminal-commands.mjs';
import { readCommandOutput } from './terminal-output.mjs';

const exec = promisify(execFile);
const ID = /^term_[a-f0-9-]{36}$/;
const KEY = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,119}$/;
export class TerminalManager {
  constructor({ root, env = process.env, tmux = "tmux", maxSessions = 32, segmentBytes = DEFAULT_SEGMENT_BYTES, maxSegments = 0 } = {}) {
    this.root = path.resolve(root); this.socket = path.join(this.root, "tmux.sock"); this.env = env; this.tmux = tmux;
    this.owner = "terminal-workspace-mcp";
    this.managerId = createHash("sha256").update(this.root).digest("hex").slice(0, 24);
    this.maxSessions = integer(maxSessions, "maxSessions", 1, 1000); this.logs = { segmentBytes, maxSegments }; this.lock = new KeyedMutex();
    this.logger = fileURLToPath(new URL("./log-writer.mjs", import.meta.url));
  }
  async initialize() { await mkdir(this.root, { recursive: true, mode: 0o700 }); return this; }
  dir(id) { if (!ID.test(id)) throw new OperationError("invalid terminal session id", "invalid_input"); return path.join(this.root, id); }
  async locked(id, operation) {
    return this.fileLocked(id, path.join(this.dir(id), 'operation.lock'), operation);
  }
  async fileLocked(key, lockFile, operation) {
    return this.lock.run(key, async () => {
      // Linux flock belongs to the shared open-file description: after the
      // child locks fd 3, our parent fd retains the lock until close(). This
      // serializes CLI cleanup, HTTP and stdio processes and is crash-safe.
      const file = await open(lockFile, 'a', 0o600);
      try {
        await new Promise((resolve, reject) => {
          const child = spawn('flock', ['--exclusive', '--timeout', '10', '3'], { stdio: ['ignore', 'ignore', 'ignore', file.fd], env: this.env });
          child.once('error', reject);
          child.once('exit', code => code === 0 ? resolve() : reject(new OperationError('terminal lock unavailable', 'terminal_busy')));
        });
        return await operation();
      } finally { await file.close(); }
    });
  }
  async touch(id) { await this.locked(id, () => atomicJson(path.join(this.dir(id), 'activity.json'), { lastUsedAt: new Date().toISOString() })); }
  async run(args) {
    try { return (await exec(this.tmux, ["-S", this.socket, "-f", "/dev/null", ...args], { env: this.env, timeout: 10000, maxBuffer: 2 * 1024 * 1024 })).stdout.trimEnd(); }
    catch (error) { throw new OperationError(error.stderr?.trim() || error.message, error.code === "ENOENT" ? "tmux_unavailable" : "terminal_error"); }
  }
  async pane(id) {
    try {
      const value = await this.run(["display-message", "-p", "-t", `${id}:0.0`, "#{pane_dead}\t#{pane_dead_status}\t#{pane_pid}\t#{pane_pipe}\t#{pane_current_path}"]);
      const [dead, exit, pid, pipe, ...cwd] = value.split("\t");
      return { alive: dead === "0", exitCode: dead === "1" && exit !== "" ? Number(exit) : null, pid: Number(pid), pipeActive: pipe === "1", cwd: cwd.join("\t") };
    } catch (error) {
      if (/can't find (session|window|pane)|no server running|Connection refused|No such file/.test(error.message)) return { alive: false, exitCode: null, pid: null, cwd: null };
      // A failed inspection is not evidence that the task died. In particular,
      // do not replace a keyed shell after a tmux timeout or permission error.
      throw error;
    }
  }
  keyFile(key) {
    if (typeof key !== 'string' || !KEY.test(key)) throw new OperationError('terminalKey must be 1..120 ASCII letters/digits or ._:/-, starting with a letter/digit', 'invalid_input');
    return path.join(this.root, 'keys', `${createHash('sha256').update(key).digest('hex')}.json`);
  }
  async liveSessionCount() {
    try {
      const panes = await this.run(['list-panes', '-a', '-F', '#{session_name}\t#{pane_dead}']);
      return new Set(panes.split('\n').map(line => line.split('\t')).filter(([name, dead]) => ID.test(name) && dead === '0').map(([name]) => name)).size;
    } catch (error) {
      if (/no server running|no current target|no sessions|Connection refused|No such file/.test(error.message)) return 0;
      throw error;
    }
  }
  async open({ cwd, resolveCwd, name = "", env = {}, cols = 120, rows = 40, sessionId, terminalKey, createIfMissing = true } = {}) {
    if (sessionId && terminalKey !== undefined) throw new OperationError('provide sessionId or terminalKey, not both', 'invalid_input');
    if (sessionId) return this.status(sessionId);
    const bindingFile = terminalKey === undefined ? null : this.keyFile(terminalKey);
    integer(cols, "cols", 20, 500); integer(rows, "rows", 5, 300);
    return this.fileLocked('create', path.join(this.root, 'creation.lock'), async () => {
      let previous;
      if (bindingFile) {
        const binding = await jsonFile(bindingFile, null);
        if (binding) {
          if (binding.terminalKey !== terminalKey || !ID.test(binding.sessionId)) throw new OperationError('invalid terminal key binding', 'terminal_binding_invalid');
          previous = binding.sessionId;
          const existing = await this.locked(previous, async () => {
            const state = await this.status(previous);
            if (state.owner !== this.owner || state.managerId !== this.managerId || state.terminalKey !== terminalKey) throw new OperationError('terminal key ownership mismatch', 'terminal_binding_invalid');
            if (state.alive) {
              const identity = await this.run(['display-message', '-p', '-t', `${previous}:0.0`, '#{session_id}\t#{@mcp_manager}\t#{@mcp_owner}']);
              if (identity !== `${state.tmuxSessionId}\t${this.owner}\t${this.managerId}`) throw new OperationError('terminal ownership changed', 'terminal_binding_invalid');
              await atomicJson(path.join(this.dir(previous), 'activity.json'), { lastUsedAt: new Date().toISOString() });
            }
            return state;
          }).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
          if (existing && (existing.alive || !createIfMissing)) return { ...existing, reused: true };
        }
        if (!createIfMissing) throw new OperationError('terminalKey not found; provide a command to create it or use a saved sessionId', 'terminal_not_found');
      }
      if (await this.liveSessionCount() >= this.maxSessions) throw new OperationError("terminal session limit reached", "capacity");
      if (resolveCwd) cwd = await resolveCwd();
      const id = `term_${randomUUID()}`, dir = this.dir(id);
      await mkdir(path.join(dir, "commands"), { recursive: true, mode: 0o700 });
      const rc = path.join(dir, "shell.rc"), log = path.join(dir, "terminal.log"), ready = path.join(dir, "ready");
      const logToken = randomUUID();
      const meta = { sessionId: id, owner: this.owner, managerId: this.managerId, shellStateVersion: 2, outputProtocol: 2, name, cwd, createdAt: new Date().toISOString(), log, logs: this.logs, cols, rows, ...(terminalKey === undefined ? {} : { terminalKey }) };
      await atomicJson(path.join(dir, "meta.json"), meta);
      // Persist the binding before shell launch. A service crash cannot leave a
      // live keyed shell undiscoverable to its next caller.
      if (bindingFile) await atomicJson(bindingFile, { terminalKey, sessionId: id });
      await atomicWrite(rc, shellRc({ directory: dir, ready, token: logToken }));
      const environmentFile = path.join(dir, 'environment.sh');
      await atomicWrite(environmentFile, environmentScript({ ...this.env, PAGER: 'cat', GIT_PAGER: 'cat', SYSTEMD_PAGER: 'cat', ...env, HISTFILE: path.join(dir, "history"), MCP_TERMINAL_ROOT: this.root, MCP_TERMINAL_ADMIN: fileURLToPath(new URL("../scripts/terminals.mjs", import.meta.url)) }));
      // wait-for gates shell startup so pipe-pane is installed before any output.
      const gate = `gate_${randomUUID()}`;
      const launch = `${quote(this.tmux)} -S ${quote(this.socket)} wait-for ${quote(gate)}; exec ${isolatedLaunch(environmentFile, ['/bin/bash', '--noprofile', '--rcfile', rc, '-i'])}`;
      try {
        await this.run(["new-session", "-d", "-s", id, "-n", "mcp", "-c", cwd, "-x", String(cols), "-y", String(rows), launch]);
        await this.run(["set-option", "-t", id, "@mcp_manager", this.owner]);
        await this.run(["set-option", "-t", id, "@mcp_owner", this.managerId]);
        meta.tmuxSessionId = await this.run(["display-message", "-p", "-t", id, "#{session_id}"]);
        await atomicJson(path.join(dir, "meta.json"), meta);
        await this.run(["set-option", "-t", id, "remain-on-exit", "on"]);
        await this.run(["set-option", "-t", id, "history-limit", "10000"]);
        await this.run(["pipe-pane", "-O", "-t", `${id}:0.0`, isolatedLaunch(environmentFile, [process.execPath, this.logger, log, String(this.logs.segmentBytes), String(this.logs.maxSegments), logToken])]);
        await this.run(["wait-for", "-S", gate]);
        for (let i = 0; i < 100; i++) { if (await stat(ready).then(() => true, () => false)) break; await delay(20); }
        if (!await stat(ready).then(() => true, () => false)) throw new OperationError("terminal shell did not become ready", "startup_timeout");
        return { ...await this.status(id), reused: false, ...(previous ? { replacedSessionId: previous } : {}) };
      } catch (error) { await this.run(["kill-session", "-t", id]).catch(() => {}); await atomicJson(path.join(dir, "closed.json"), { error: error.message, closedAt: new Date().toISOString() }); throw error; }
    });
  }
  async status(id) {
    const dir = this.dir(id), meta = await jsonFile(path.join(dir, "meta.json"));
    const pane = await this.pane(id);
    const current = await jsonFile(path.join(dir, "current.json"), null);
    return { ...meta, ...pane, status: pane.alive ? "running" : "closed", activeCommandId: current?.commandId ?? null };
  }
  async list() {
    const names = await readdir(this.root);
    const out = [];
    for (const id of names.filter(x => ID.test(x))) { try { out.push(await this.status(id)); } catch {} }
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async read(id, { cursor, maxBytes = 65536, waitMs = 0, signal } = {}) {
    integer(waitMs, "waitMs", 0, 30000);
    await this.touch(id);
    const until = Date.now() + waitMs; let state, output;
    do {
      state = await this.status(id);
      output = await readLog(state.log, { cursor, maxBytes, segmentBytes: state.logs.segmentBytes, final: !state.alive });
      if (output.content || !state.alive || Date.now() >= until || signal?.aborted) break;
      await delay(40);
    } while (true);
    return { sessionId: id, status: state.status, ...output };
  }
  async send(id, text, enter = false, beforeDispatch = async () => {}) {
    if (typeof text !== "string" || Buffer.byteLength(text) > 65536) throw new OperationError("input exceeds 65536 bytes", "invalid_input");
    const state = await this.status(id); if (!state.alive) throw new OperationError("terminal is closed", "terminal_closed");
    if (text) {
      const file = path.join(this.dir(id), `input-${randomUUID()}`), buffer = `buf_${randomUUID()}`;
      try { await writeFile(file, text, { mode: 0o600 }); await this.run(["load-buffer", "-b", buffer, file]); await beforeDispatch(); await this.run(["paste-buffer", "-d", "-b", buffer, "-t", `${id}:0.0`]); }
      finally { await unlink(file).catch(() => {}); await this.run(["delete-buffer", "-b", buffer]).catch(() => {}); }
    }
    if (enter) await this.run(["send-keys", "-t", `${id}:0.0`, "Enter"]);
  }
  async write(id, { input = "", enter = false, key } = {}) {
    return this.locked(id, async () => {
      await atomicJson(path.join(this.dir(id), 'activity.json'), { lastUsedAt: new Date().toISOString() });
      if (key) {
        if (!["C-c", "C-d", "C-z", "Enter", "Escape", "Tab", "Up", "Down"].includes(key)) throw new OperationError("unsupported terminal key", "invalid_input");
        await this.status(id); await this.run(["send-keys", "-t", `${id}:0.0`, key]);
      } else await this.send(id, input, enter);
      return { sessionId: id, sent: true };
    });
  }
  async execute(id, options) { return submitCommand(this, id, options); }
  async commandStatus(id, commandId) { return commandState(this, id, commandId); }
  async readCommand(id, commandId, options) { return readCommandOutput(this, id, commandId, options); }
  async resize(id, cols, rows) {
    integer(cols, "cols", 20, 500); integer(rows, "rows", 5, 300); await this.status(id);
    await this.run(["resize-window", "-t", `${id}:0`, "-x", String(cols), "-y", String(rows)]); return { sessionId: id, cols, rows };
  }
  async close(id) {
    return this.locked(id, async () => {
      const state = await this.status(id);
      if (state.alive || state.pid) await this.run(["kill-session", "-t", id]).catch(() => {});
      if (state.outputProtocol >= 1) {
        for (let i = 0; i < 100; i++) {
          if (await jsonFile(path.join(this.dir(id), 'log-drained.json'), null)) break;
          await delay(20);
        }
      }
      await atomicJson(path.join(this.dir(id), "closed.json"), { closedAt: new Date().toISOString() });
      return { sessionId: id, status: "closed" };
    });
  }
}
