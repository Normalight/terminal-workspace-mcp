import { appendFile, readFile, unlink } from "node:fs/promises";
import { spawn } from "node:child_process";
import { pipeline } from "node:stream/promises";
import { atomicJson, jsonFile, processIdentity, signalProcess } from "./runtime.mjs";
import { LogWriter } from "./log-store.mjs";

const [specPath] = process.argv.slice(2);
const spec = JSON.parse(await readFile(specPath, "utf8"));
await unlink(specPath);
const { jobId, paths: p } = spec;
const began = Date.now();
const event = entry => appendFile(p.events, JSON.stringify({ timestamp: new Date().toISOString(), jobId, ...entry }) + "\n", { mode: 0o600 });
let child, identity, timer, monitor, killTimer, cancelled = false, timedOut = false, failure = null;
let exitCode = null, signal = null;
const stop = async (force = false) => {
  if (!child?.pid || !identity) return;
  await signalProcess(child.pid, identity, force ? "SIGKILL" : "SIGTERM");
  if (!force && !killTimer) killTimer = setTimeout(() => void signalProcess(child.pid, identity, "SIGKILL"), 1000);
};
try {
  await event({ event: "runner_started", runnerPid: process.pid });
  const requested = await jsonFile(p.stop, null);
  if (requested) { cancelled = true; }
  else {
    child = spawn(spec.shell, ["-lc", spec.command], { cwd: spec.cwd, env: process.env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const completion = new Promise(resolve => {
      child.once("error", error => { failure = error; resolve(); });
      child.once("close", (code, sig) => { exitCode = code; signal = sig; resolve(); });
    });
    const streams = [pipeline(child.stdout, new LogWriter(p.stdout, spec.logs)), pipeline(child.stderr, new LogWriter(p.stderr, spec.logs))];
    const drained = Promise.all(streams).catch(async error => { failure ??= error; await stop(true); });
    identity = await processIdentity(child.pid);
    await atomicJson(p.process, { pid: child.pid ?? null, identity, startedAt: new Date(began).toISOString() });
    await atomicJson(p.ready, { startedAt: new Date(began).toISOString() });
    await event({ event: "process_started", pid: child.pid ?? null });
    monitor = setInterval(() => {
      void jsonFile(p.stop, null).then(request => { if (request) { cancelled = true; return stop(request.force); } }).catch(() => {});
    }, 50);
    if (spec.executionTimeoutMs > 0) timer = setTimeout(() => { timedOut = true; void stop(); }, spec.executionTimeoutMs);
    await completion;
    await drained;
  }
} catch (error) { failure ??= error; await stop(true); }
finally { clearTimeout(timer); clearInterval(monitor); clearTimeout(killTimer); }
cancelled ||= !!(await jsonFile(p.stop, null));
const result = { jobId, status: failure ? (child?.pid ? "failed" : "failed_to_start") : timedOut ? "timed_out" : cancelled ? "cancelled" : exitCode === 0 ? "succeeded" : "failed",
  exitCode, signal, timedOut, startedAt: new Date(began).toISOString(), finishedAt: new Date().toISOString(), durationMs: Date.now() - began, error: failure?.message ?? null };
await atomicJson(p.result, result);
await event({ event: "job_finished", ...result });
