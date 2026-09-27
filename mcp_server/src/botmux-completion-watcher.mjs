import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, writeFile, link, unlink } from 'node:fs/promises';
import path from 'node:path';
import { atomicJson, jsonFile } from './runtime.mjs';
import { sendBotmux, completionMessage } from './botmux-notifier.mjs';
import { BotmuxTaskMonitor } from './botmux-task-monitor.mjs';
import { describeTask } from './task-summary.mjs';

const active = state => ['running', 'starting'].includes(state.status);
const finalDelivery = new Set(['sent', 'skipped', 'failed', 'uncertain']);
const valid = (value, prefix) => new RegExp(`^${prefix}_[a-f0-9-]{36}$`).test(value ?? '');

export class BotmuxCompletionWatcher {
  constructor({ config, root, terminals, env, cwd, send = sendBotmux, run, now = Date.now }) {
    Object.assign(this, { config, root, terminals, env, cwd, send, now });
    this.controller = new AbortController();
    this.monitor = new BotmuxTaskMonitor({ config, env, cwd, now, run, send, terminals, signal: this.controller.signal });
    this.counts = {}; this.lastErrorCode = null;
  }
  async initialize() {
    if (!this.config.enabled) return this;
    try { await mkdir(this.root, { recursive: true, mode: 0o700 }); }
    catch { this.lastErrorCode = 'watch_storage_unavailable'; return this; }
    this.timer = setInterval(() => { void this.tick(); }, this.config.pollIntervalMs); this.timer.unref();
    void this.tick(); return this;
  }
  file(terminalId, commandId) {
    return path.join(this.root, createHash('sha256').update(`${terminalId}:${commandId}`).digest('hex') + '.json');
  }
  summary() { return { enabled: this.config.enabled, ...this.counts, lastErrorCode: this.lastErrorCode }; }
  async observe(state) {
    if (!this.config.enabled || !valid(state.sessionId, 'term') || !valid(state.commandId, 'cmd')) return state;
    try {
      const file = this.file(state.sessionId, state.commandId);
      let record = await jsonFile(file, null);
      if (!record && active(state)) {
        const fresh = { version: 2, mode: this.config.mode ?? 'completion', progressIntervalMs: this.config.progressIntervalMs, terminalId: state.sessionId, commandId: state.commandId,
          target: { sessionId: this.config.sessionId, mentionOpenId: this.config.mentionOpenId,
            ...(this.config.mode === 'task' ? { botAppId: this.config.botAppId, chatId: this.config.chatId } : {}) },
          minDurationMs: this.config.minDurationMs, status: 'watching', attempts: 0,
          registeredAt: this.now(), startedAt: state.startedAt ?? state.submittedAt ?? null,
          taskSummarySource: state.taskSummarySource ?? (state.taskSummary ? 'caller' : 'command_type'),
          taskSummary: state.taskSummary ?? describeTask(state.command).taskSummary };
        // Atomic create-if-absent: duplicate clients cannot replace a pinned
        // target, a completed delivery, or another process's in-flight send.
        const temporary = `${file}.${randomUUID()}.tmp`;
        try {
          await writeFile(temporary, JSON.stringify(fresh), { mode: 0o600 });
          await link(temporary, file).catch(error => { if (error.code !== 'EEXIST') throw error; });
        } finally { await unlink(temporary).catch(() => {}); }
        record = await jsonFile(file);
      }
      if (!record) return state; // Do not backfill completed historical tasks.
      return { ...state, externalNotification: { provider: 'botmux', status: record.status,
        mode: record.mode ?? 'completion', ...(record.task ? { task: { sessionId: record.task.sessionId, rootMessageId: record.task.rootMessageId, phase: record.task.phase } } : {}),
        registered: !['skipped', 'failed', 'uncertain'].includes(record.status), minDurationMs: record.minDurationMs,
        instruction: record.mode === 'task'
          ? 'A durable background watcher delegates eligible long tasks to the configured bot in a dedicated new topic, mentions the recipient on start and completion, and forwards periodic progress. No continued MCP polling is needed. Keep the terminal and command IDs to read results.'
          : 'A durable background watcher checks this task independently of the MCP client. Eligible completion is sent to the configured botmux session. Keep the task IDs for reading results; this does not rerun the command or schedule another ChatGPT turn.',
      } };
    } catch {
      this.lastErrorCode = 'watch_registration_failed';
      return { ...state, externalNotification: { provider: 'botmux', registered: false, status: 'failed', errorCode: this.lastErrorCode } };
    }
  }
  async tick() {
    if (!this.config.enabled || this.controller.signal.aborted || this.running) return;
    this.running = this.terminals.fileLocked('botmux-watches', path.join(this.root, 'worker.lock'), async () => {
      const counts = {};
      for (const name of await readdir(this.root)) {
        if (this.controller.signal.aborted) break;
        if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
        try {
          const file = path.join(this.root, name), record = await jsonFile(file);
          if (!finalDelivery.has(record.status)) await this.process(file, record);
          counts[record.status] = (counts[record.status] ?? 0) + 1;
        } catch { this.lastErrorCode = 'watch_check_failed'; }
      }
      this.counts = counts;
    }).catch(() => { this.lastErrorCode = 'watch_lock_failed'; }).finally(() => { this.running = null; });
    await this.running;
  }
  async process(file, record) {
    if (record.status === 'sending') {
      // flock proves the previous sender no longer owns the record. Its CLI
      // may have delivered before a crash; never blindly replay that message.
      record.status = 'uncertain'; record.errorCode = 'sender_interrupted'; await atomicJson(file, record); return;
    }
    if ((record.nextAttemptAt ?? 0) > this.now()) return;
    let state;
    try { state = await this.terminals.commandStatus(record.terminalId, record.commandId); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      record.status = 'failed'; record.errorCode = 'task_record_missing'; await atomicJson(file, record); return;
    }
    if (record.mode === 'task') return this.monitor.process(file, record, state);
    const start = Date.parse(state.startedAt ?? state.submittedAt ?? record.startedAt);
    if (active(state)) {
      if (!record.observedLong && Number.isFinite(start) && this.now() - start >= record.minDurationMs) {
        record.observedLong = true; record.observedDurationMs = this.now() - start; await atomicJson(file, record);
      }
      return;
    }
    const finish = Date.parse(state.finishedAt);
    // Missing completion time cannot prove a long runtime. Only a prior
    // observed running interval would do; retain the record for inspection.
    if ((!Number.isFinite(start) || !Number.isFinite(finish)) && !record.observedLong) {
      record.status = 'uncertain'; record.errorCode = 'task_duration_unknown'; await atomicJson(file, record); return;
    }
    record.durationIsLowerBound = !Number.isFinite(start) || !Number.isFinite(finish);
    record.durationMs = record.durationIsLowerBound ? record.observedDurationMs : Math.max(0, finish - start);
    if (record.durationMs < record.minDurationMs) { record.status = 'skipped'; await atomicJson(file, record); return; }
    record.status = 'sending'; record.attempts++; await atomicJson(file, record);
    let result;
    try {
      result = await this.send({ executable: this.config.executable, timeoutMs: this.config.sendTimeoutMs,
        env: this.env, cwd: this.cwd, target: record.target, message: completionMessage(record, state), signal: this.controller.signal });
    } catch { result = { status: 'uncertain', code: 'botmux_delivery_unconfirmed' }; }
    if (result.status === 'sent') { record.status = 'sent'; record.messageId = result.messageId; record.sentAt = this.now(); }
    else if (result.status === 'uncertain') { record.status = 'uncertain'; record.errorCode = result.code; }
    else {
      record.status = record.attempts >= this.config.maxAttempts ? 'failed' : 'retry'; record.errorCode = result.code;
      record.nextAttemptAt = this.now() + Math.min(300000, this.config.retryDelayMs * 2 ** Math.min(record.attempts - 1, 10));
    }
    await atomicJson(file, record);
  }
  async close() {
    clearInterval(this.timer); this.controller.abort();
    let timer;
    try { await Promise.race([this.running, new Promise(resolve => { timer = setTimeout(resolve, 1000); })]); }
    finally { clearTimeout(timer); }
  }
}
