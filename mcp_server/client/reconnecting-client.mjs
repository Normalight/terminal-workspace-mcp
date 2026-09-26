import { setTimeout as sleep } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { LoggingMessageNotificationSchema } from '@modelcontextprotocol/sdk/types.js';

export function retryable(error) {
  // Some hosts use -32001 for Unknown tool, while the SDK uses it for timeout.
  // A missing registration requires the host to refresh its connection.
  if (error?.code === 'tool_error' || /unknown tool|method not found|unauthorized|forbidden/i.test(error?.message ?? '')) return false;
  if ([401, 403].includes(error?.code)) return false;
  if (/^(ECONNRESET|ECONNREFUSED|EPIPE|ENETUNREACH|UND_ERR_SOCKET|UND_ERR_CONNECT_TIMEOUT)$/.test(error?.cause?.code ?? '')) return true;
  return [404, 408, 429, 500, 502, 503, 504, -32000, -32001].includes(error?.code)
    || ['TimeoutError', 'AbortError'].includes(error?.name)
    || /fetch failed|ECONNRESET|ECONNREFUSED|EPIPE|ENETUNREACH|socket|connection closed/i.test(error?.message ?? '');
}

export function retryDelay(error, attempt, { baseDelayMs = 500, maxDelayMs = 10000, random = Math.random } = {}) {
  const cap = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
  return Math.max(error?.retryAfterMs ?? 0, Math.round(cap * (0.5 + random() * 0.5)));
}

export class SubmissionUncertainError extends Error {
  constructor(args, cause) {
    super('Command response was lost; submission may have succeeded. Inspect the saved terminalKey/sessionId without command before deciding what to do.', { cause });
    this.code = 'submission_uncertain';
    this.recovery = { ...(args.sessionId ? { sessionId: args.sessionId } : { terminalKey: args.terminalKey }), waitMs: 0 };
  }
}

// A reusable client for integrations under our control. Host plugin registration
// errors are deliberately surfaced; they cannot be repaired by an origin server.
export class ReconnectingTerminalClient {
  constructor({ url, requestInit, fetch: fetcher = fetch, maxRetries = 4, baseDelayMs = 500,
    maxDelayMs = 10000, requestTimeoutMs = 40000, reconcileMs = 30000, onReconnect = () => {} } = {}) {
    this.url = new URL(url); this.requestInit = requestInit;
    for (const [key, value, min] of [['maxRetries', maxRetries, 0], ['baseDelayMs', baseDelayMs, 1],
      ['maxDelayMs', maxDelayMs, 1], ['requestTimeoutMs', requestTimeoutMs, 1], ['reconcileMs', reconcileMs, 1]]) {
      if (!Number.isSafeInteger(value) || value < min) throw new TypeError(`invalid ${key}`);
    }
    Object.assign(this, { maxRetries, baseDelayMs, maxDelayMs, requestTimeoutMs, reconcileMs, onReconnect });
    this.lifecycle = new AbortController(); this.events = new Set(); this.waiters = new Set(); this.generation = 0;
    this.fetch = async (url, options = {}) => {
      // GET's body is an ongoing SSE stream. Apply deadlines only to finite RPCs.
      const signal = options.method === 'GET' ? options.signal : AbortSignal.any([
        ...(options.signal ? [options.signal] : []), AbortSignal.timeout(options.method === 'DELETE' ? 2000 : requestTimeoutMs),
      ]);
      const response = await fetcher(url, { ...options, signal });
      if ([429, 503].includes(response.status)) {
        const retry = response.headers.get('retry-after');
        const retryAfterMs = retry === null ? 0 : /^\d+(\.\d+)?$/.test(retry) ? Number(retry) * 1000 : Math.max(0, Date.parse(retry) - Date.now());
        await response.body?.cancel();
        const error = new Error(`HTTP ${response.status}`); error.code = response.status;
        error.retryAfterMs = Number.isFinite(retryAfterMs) ? retryAfterMs : 0; throw error;
      }
      return response;
    };
  }

  wake() { for (const fn of this.waiters) fn(); }
  async dispose(connection) {
    connection.retired = true;
    try { await connection.transport.terminateSession(); } catch {}
    await connection.client.close();
  }
  async connectionForCall() {
    if (this.lifecycle.signal.aborted) throw Error('client is closed');
    if (this.connection) return this.connection;
    if (!this.connecting) {
      this.connecting = (async () => {
        const client = new Client({ name: 'terminal-reconnecting-client', version: '1' });
        const transport = new StreamableHTTPClientTransport(this.url, { requestInit: this.requestInit, fetch: this.fetch });
        const connection = { client, transport, retired: false };
        client.onerror = () => { if (!connection.retired) this.wake(); };
        client.onclose = () => { if (!connection.retired) this.wake(); };
        client.setNotificationHandler(LoggingMessageNotificationSchema, ({ params }) => {
          if (connection.retired || params.logger !== 'terminal-workspace.completion' || params.data?.event !== 'command_completed') return;
          this.events.add(`${params.data.sessionId}:${params.data.commandId}`);
          if (this.events.size > 1024) this.events.delete(this.events.values().next().value);
          this.wake();
        });
        try {
          await client.connect(transport, { timeout: this.requestTimeoutMs });
          if (this.lifecycle.signal.aborted) throw Error('client is closed');
          this.connection = connection; this.generation++;
          if (this.generation > 1) this.onReconnect({ generation: this.generation });
          return connection;
        } catch (error) {
          if (this.connection === connection) this.connection = null;
          await this.dispose(connection); throw error;
        }
      })();
    }
    const pending = this.connecting;
    try { return await pending; }
    finally { if (this.connecting === pending) this.connecting = null; }
  }

  async recover(operation) {
    for (let attempt = 0; ; attempt++) {
      let connection;
      try { connection = await this.connectionForCall(); return await operation(connection); }
      catch (error) {
        if (this.lifecycle.signal.aborted || !retryable(error) || attempt >= this.maxRetries) throw error;
        // Retire only the failed generation. Concurrent readers share the next
        // initialization instead of creating one new session per retry.
        if (connection && this.connection === connection) {
          this.connection = null; await this.dispose(connection);
        }
        const delayMs = retryDelay(error, attempt, this);
        if (delayMs > this.requestTimeoutMs) throw error; // Do not ignore a long Retry-After.
        await sleep(delayMs, undefined, { signal: this.lifecycle.signal });
      }
    }
  }

  async connect() { await this.recover(async () => {}); }
  async call(connection, args) {
    const response = await connection.client.callTool({ name: 'execute_command', arguments: args }, undefined, { timeout: this.requestTimeoutMs });
    if (response.isError) {
      const error = new Error(response.content?.filter(x => x.type === 'text').map(x => x.text).join('\n') || 'Tool failed');
      error.code = 'tool_error'; throw error;
    }
    return response.structuredContent;
  }
  async read(args) {
    if (args.command !== undefined || args.input !== undefined || args.key !== undefined) throw TypeError('read retries only status/output requests, without command/input/key');
    return this.recover(connection => this.call(connection, args));
  }
  async execute(args) {
    if (!args.command?.trim() || (!args.sessionId && !args.terminalKey)) throw TypeError('execute needs command and a saved sessionId or stable terminalKey');
    const connection = await this.recover(async connection => connection);
    try { return await this.call(connection, args); }
    catch (error) {
      // Retrying a write after a missing reply can start the same training twice.
      if (retryable(error)) throw new SubmissionUncertainError(args, error);
      throw error;
    }
  }
  async waitForCompletion(args, { timeoutMs = 30 * 60 * 1000 } = {}) {
    if (!args.sessionId || !args.commandId) throw TypeError('completion recovery requires saved sessionId and commandId');
    const key = `${args.sessionId}:${args.commandId}`, deadline = Date.now() + timeoutMs;
    for (;;) {
      const state = await this.read({ ...args, waitMs: 0, notifyOnCompletion: true });
      if (state.status !== 'running' && state.status !== 'starting') { this.events.delete(key); return state; }
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw Error('Completion wait expired; retain IDs/cursor and resume without command.');
      // Notifications wake promptly; bounded reconciliation also handles a lost
      // final event or a transport that does not deliver notifications at all.
      await new Promise(resolve => {
        let timer;
        const done = () => { clearTimeout(timer); this.waiters.delete(done); resolve(); };
        this.waiters.add(done); timer = setTimeout(done, Math.min(this.reconcileMs, remaining));
        if (this.events.has(key) || this.lifecycle.signal.aborted) done();
      });
    }
  }
  async close() {
    this.lifecycle.abort(); this.wake();
    if (this.connecting) await this.connecting.catch(() => {});
    const connection = this.connection; this.connection = null;
    if (connection) await this.dispose(connection);
    this.events.clear();
  }
}
