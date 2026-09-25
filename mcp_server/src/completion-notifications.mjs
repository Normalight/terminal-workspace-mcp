// One subscription set per MCP connection. Durable command results remain the
// source of truth; a new connection can explicitly subscribe using saved IDs.
export class CompletionNotifications {
  constructor({ terminals, jobs, send, ready = () => true, intervalMs = 500, maxPending = 256 }) {
    Object.assign(this, { terminals, jobs, send, ready, intervalMs, maxPending });
    this.pending = new Map();
    this.sent = new Set();
    this.closed = false;
  }

  observe(state, requested, auto = false) {
    const id = state.jobId ?? state.commandId;
    if (!id || (!state.jobId && !state.sessionId)) return state;
    const key = state.jobId ? `job:${id}` : `${state.sessionId}:${id}`;
    const active = ['running', 'starting'].includes(state.status);
    if (requested === false) this.pending.delete(key);
    else if (!this.closed && (requested === true || (auto && active)) && !this.sent.has(key) && !this.pending.has(key)) {
      if (this.pending.size >= this.maxPending) return { ...state, completionNotification: { subscribed: false, reason: 'subscription_limit', fallback: 'poll' } };
      this.pending.set(key, state.jobId ? { jobId: id } : { sessionId: state.sessionId, commandId: id });
      this.timer ??= setInterval(() => { void this.tick(); }, this.intervalMs);
      this.timer.unref();
    }
    if (!this.pending.size) { clearInterval(this.timer); this.timer = undefined; }
    return { ...state, completionNotification: {
      method: 'notifications/message', logger: 'terminal-workspace.completion',
      subscribed: this.pending.has(key), listening: this.ready(), sent: this.sent.has(key),
    } };
  }

  async tick() {
    if (this.closed || this.running || !this.ready()) return;
    this.running = true;
    try {
      for (const [key, target] of this.pending) {
        if (this.closed || !this.ready()) break;
        try {
          const state = target.result ?? (target.jobId ? await this.jobs.status(target.jobId) : await this.terminals.commandStatus(target.sessionId, target.commandId));
          if (['starting', 'running'].includes(state.status)) continue;
          target.result = state;
          // A call may unsubscribe or the transport may close while reading.
          if (this.closed || this.pending.get(key) !== target || !this.ready()) continue;
          const data = { event: 'command_completed', notificationId: key,
            ...(target.jobId ? { jobId: target.jobId, commandId: target.jobId } : { sessionId: target.sessionId, commandId: target.commandId }),
            status: state.status, exitCode: state.exitCode ?? null, signal: state.signal ?? null,
            startedAt: state.startedAt ?? state.createdAt ?? null, finishedAt: state.finishedAt ?? null,
            ...(target.jobId ? {} : { startCursor: state.startCursor, outputEndCursor: state.outputEndCursor }),
          };
          // Send identifiers and status only: commands/output can contain secrets.
          if (await this.send({ level: 'notice', logger: 'terminal-workspace.completion', data }) === false) continue;
          this.pending.delete(key);
          this.sent.add(key);
          if (this.sent.size > 2048) this.sent.delete(this.sent.values().next().value);
        } catch (error) {
          // Retention may remove an explicitly subscribed completed history.
          // Other failures are retried while this MCP session is alive.
          if (error.code === 'ENOENT') this.pending.delete(key);
        }
      }
    } finally {
      this.running = false;
      if (!this.pending.size) { clearInterval(this.timer); this.timer = undefined; }
    }
  }

  close() {
    this.closed = true;
    clearInterval(this.timer);
    this.timer = undefined;
    this.pending.clear();
    this.sent.clear();
  }
}
