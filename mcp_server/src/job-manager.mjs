import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { atomicJson, delay, integer, jsonFile, KeyedMutex, OperationError, processIdentity, signalProcess } from "./runtime.mjs";
import { DEFAULT_SEGMENT_BYTES, readLog } from "./log-store.mjs";

export const TERMINAL_STATES = new Set(["succeeded", "failed", "failed_to_start", "cancelled", "timed_out"]);
export class JobManager {
  constructor({ root, shell = "/bin/bash", maxJobs = 1000, maxRunning = 32, retentionDays = 30, segmentBytes = DEFAULT_SEGMENT_BYTES, maxSegments = 0 } = {}) {
    this.root = path.resolve(root); this.shell = shell;
    this.maxJobs = integer(maxJobs, "maxJobs", 1, 100000); this.maxRunning = integer(maxRunning, "maxRunning", 1, 10000);
    this.retentionDays = integer(retentionDays, "retentionDays", 0, 36500);
    this.logsConfig = { segmentBytes: integer(segmentBytes, "segmentBytes", 1024, 1024 ** 3), maxSegments: integer(maxSegments, "maxSegments", 0, 10000) };
    this.runner = fileURLToPath(new URL("./job-runner.mjs", import.meta.url)); this.lock = new KeyedMutex();
  }
  async initialize() { await mkdir(this.root, { recursive: true, mode: 0o700 }); return this; }
  paths(jobId) {
    if (typeof jobId !== "string" || !/^job_[a-f0-9-]{36}$/.test(jobId)) throw new OperationError("invalid job id", "invalid_input");
    const dir = path.join(this.root, jobId);
    return Object.fromEntries(Object.entries({ dir: "", spec: "spec.json", meta: "meta.json", result: "result.json", process: "process.json", ready: "ready.json", stop: "stop.json", stdout: "stdout.log", stderr: "stderr.log", events: "events.jsonl", pid: "pid" }).map(([key, name]) => [key, name ? path.join(dir, name) : dir]));
  }
  async metadata() {
    const dirs = (await readdir(this.root, { withFileTypes: true })).filter(x => x.isDirectory() && /^job_[a-f0-9-]{36}$/.test(x.name));
    const rows = [];
    for (let offset = 0; offset < dirs.length; offset += 32) {
      rows.push(...(await Promise.all(dirs.slice(offset, offset + 32).map(d => jsonFile(this.paths(d.name).meta, null).catch(() => null)))).filter(Boolean));
    }
    return rows.sort((a,b) => b.createdAt.localeCompare(a.createdAt));
  }
  async start({ command, cwd, cwdLabel = cwd, env = process.env, executionTimeoutMs = 0 }) {
    if (typeof command !== "string" || !command.trim() || command.length > 20000) throw new OperationError("command must be 1..20000 characters", "invalid_input");
    integer(executionTimeoutMs, "executionTimeoutMs", 0, 2147483647);
    return this.lock.run("store", async () => {
      await this.cleanup({ retainCount: this.maxJobs - 1 });
      const rows = await this.metadata();
      if (rows.length >= this.maxJobs) throw new OperationError("job store is full of active tasks", "capacity");
      let running = 0;
      for (const row of rows) if (!await jsonFile(this.paths(row.jobId).result, null)) running++;
      if (running >= this.maxRunning) throw new OperationError("running job limit reached", "capacity");
      const jobId = `job_${randomUUID()}`, p = this.paths(jobId), createdAt = new Date().toISOString();
      await mkdir(p.dir, { mode: 0o700 });
      const meta = { jobId, commandId: jobId, status: "starting", command, cwd: cwdLabel, createdAt, logs: this.logsConfig, executionTimeoutMs,
        files: { stdout: p.stdout, stderr: p.stderr, events: p.events, result: p.result } };
      await atomicJson(p.meta, meta);
      await writeFile(p.events, JSON.stringify({ timestamp: createdAt, event: "job_created", jobId }) + "\n", { mode: 0o600 });
      await atomicJson(p.spec, { jobId, command, cwd, shell: this.shell, paths: p, createdAt, logs: this.logsConfig, executionTimeoutMs });
      const runner = spawn(process.execPath, [this.runner, p.spec], { cwd, env, detached: true, stdio: "ignore" });
      try {
        await new Promise((resolve, reject) => { runner.once("spawn", resolve); runner.once("error", reject); });
        meta.runnerPid = runner.pid; meta.runnerIdentity = await processIdentity(runner.pid);
        await atomicJson(p.meta, meta); runner.unref();
      } catch (error) {
        await atomicJson(p.result, { jobId, status: "failed_to_start", error: error.message, exitCode: null, signal: null, finishedAt: new Date().toISOString() });
      }
      const until = Date.now() + 1000;
      let status;
      do { status = await this.status(jobId); if (status.status !== "starting") break; await delay(20); } while (Date.now() < until);
      return { jobId, commandId: jobId, status: status.status, cwd: cwdLabel, createdAt, runnerPid: meta.runnerPid ?? null };
    });
  }
  async status(jobId) {
    const p = this.paths(jobId), meta = await jsonFile(p.meta);
    const result = await jsonFile(p.result, null); if (result) return { ...meta, ...result };
    const proc = await jsonFile(p.process, null);
    const runner = await processIdentity(meta.runnerPid);
    const runnerAlive = !!runner && (!meta.runnerIdentity || runner === meta.runnerIdentity);
    const processAlive = !!proc?.identity && await processIdentity(proc.pid) === proc.identity;
    if (!runnerAlive && !processAlive) {
      const failure = { jobId, status: "failed", exitCode: null, signal: null, error: "runner and process exited without a final result", finishedAt: new Date().toISOString() };
      // A final result can appear between the liveness check and this read.
      const final = await jsonFile(p.result, null); if (final) return { ...meta, ...final };
      await atomicJson(p.result, failure); return { ...meta, ...failure };
    }
    return { ...meta, status: proc ? "running" : "starting", pid: proc?.pid ?? null, runnerAlive, processAlive };
  }
  async wait(jobId, waitMs = 30000) {
    integer(waitMs, "waitMs", 0, 120000);
    const until = Date.now() + waitMs;
    let result;
    do { result = await this.status(jobId); if (TERMINAL_STATES.has(result.status) || Date.now() >= until) return result; await delay(40); } while (true);
  }
  async logs(jobId, { stream = "both", maxBytes = 65536, stdoutCursor, stderrCursor } = {}) {
    const p = this.paths(jobId), status = await this.status(jobId);
    const common = { maxBytes, segmentBytes: status.logs?.segmentBytes ?? DEFAULT_SEGMENT_BYTES, final: TERMINAL_STATES.has(status.status) };
    const stdoutResult = stream === "stderr" ? {} : await readLog(p.stdout, { ...common, cursor: stdoutCursor });
    const stderrResult = stream === "stdout" ? {} : await readLog(p.stderr, { ...common, cursor: stderrCursor });
    const { content: stdout = "", ...stdoutPage } = stdoutResult;
    const { content: stderr = "", ...stderrPage } = stderrResult;
    const events = await readLog(p.events, { maxBytes: Math.min(maxBytes, 65536), final: true });
    return { jobId, status: status.status, stdout, stderr, events: events.content,
      stdoutPage, stderrPage };
  }
  async list({ limit = 50 } = {}) {
    integer(limit, "limit", 1, 200);
    const rows = (await this.metadata()).slice(0, limit);
    return Promise.all(rows.map(async row => { const x = await this.status(row.jobId); return { jobId: x.jobId, status: x.status, command: x.command, cwd: x.cwd, createdAt: x.createdAt, finishedAt: x.finishedAt ?? null, exitCode: x.exitCode ?? null }; }));
  }
  async stop(jobId, { force = false, waitMs = 2500 } = {}) {
    const p = this.paths(jobId), status = await this.status(jobId);
    if (TERMINAL_STATES.has(status.status)) return status;
    await atomicJson(p.stop, { force, requestedAt: new Date().toISOString() });
    const proc = await jsonFile(p.process, null);
    // The runner observes the persisted request, including cancellation during startup.
    if (force && proc) await signalProcess(proc.pid, proc.identity, "SIGKILL");
    const result = await this.wait(jobId, waitMs);
    return { ...result, stopRequested: true, stopped: TERMINAL_STATES.has(result.status) };
  }
  async cleanup({ retainCount = this.maxJobs, dryRun = false } = {}) {
    integer(retainCount, "retainCount", 0, 100000);
    const rows = await this.metadata(), removed = [];
    const cutoff = this.retentionDays ? Date.now() - this.retentionDays * 86400000 : -Infinity;
    for (let i = rows.length - 1; i >= 0; i--) {
      const row = rows[i], p = this.paths(row.jobId), result = await jsonFile(p.result, null);
      if (!result || !TERMINAL_STATES.has(result.status)) continue;
      if (Date.parse(result.finishedAt) >= cutoff && rows.length - removed.length <= retainCount) continue;
      if (!dryRun) await rm(p.dir, { recursive: true, force: true });
      removed.push(row.jobId);
    }
    return { removed, dryRun };
  }
}
