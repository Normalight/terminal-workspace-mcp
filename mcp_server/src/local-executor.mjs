import path from "node:path";
import { JobManager, TERMINAL_STATES } from "./job-manager.mjs";
import { integer, OperationError } from "./runtime.mjs";

export class LocalExecutionError extends OperationError {}
export class LocalCommandExecutor {
  constructor({ shell = "/bin/bash", maxTimeoutMs = 120000, maxOutputBytes = 524288, auditLogger = () => {}, jobManager, jobRoot } = {}) {
    this.maxTimeoutMs = integer(maxTimeoutMs, "maxTimeoutMs", 100, 120000);
    this.maxOutputBytes = integer(maxOutputBytes, "maxOutputBytes", 1024, 2097152);
    this.auditLogger = auditLogger;
    this.jobs = jobManager ?? new JobManager({ root: jobRoot ?? path.resolve("outputs/mcp-jobs"), shell });
  }
  async execute({ command, cwd, cwdLabel = cwd, timeoutMs = 30000, waitMs = timeoutMs, executionTimeoutMs = 0, maxOutputBytes = this.maxOutputBytes, env = process.env, tool = "execute_command" }) {
    integer(waitMs, "waitMs", 0, this.maxTimeoutMs); integer(maxOutputBytes, "maxOutputBytes", 1024, this.maxOutputBytes);
    await this.jobs.initialize();
    const started = Date.now();
    const job = await this.jobs.start({ command, cwd, cwdLabel, env, executionTimeoutMs });
    const state = await this.jobs.wait(job.jobId, Math.max(0, waitMs - (Date.now() - started)));
    const logs = await this.jobs.logs(job.jobId, { maxBytes: Math.floor(maxOutputBytes / 2), stdoutCursor: 0, stderrCursor: 0 });
    const result = { jobId: job.jobId, commandId: job.jobId, status: state.status, cwd: cwdLabel, command,
      stdout: logs.stdout, stderr: logs.stderr || state.error || "", exitCode: state.exitCode ?? null, signal: state.signal ?? null,
      timedOut: state.status === "timed_out", waitingExpired: !TERMINAL_STATES.has(state.status),
      outputLimitExceeded: !!(logs.stdoutPage?.truncated || logs.stderrPage?.truncated), outputTruncated: !!(logs.stdoutPage?.truncated || logs.stderrPage?.truncated),
      stdoutCursor: logs.stdoutPage?.nextCursor ?? 0, stderrCursor: logs.stderrPage?.nextCursor ?? 0,
      durationMs: Date.now() - started, startedAt: state.startedAt ?? state.createdAt, finishedAt: state.finishedAt ?? null };
    try { this.auditLogger({ timestamp: new Date().toISOString(), tool, command, cwd: cwdLabel, jobId: job.jobId, status: state.status, exitCode: result.exitCode }); } catch {}
    return result;
  }
}
