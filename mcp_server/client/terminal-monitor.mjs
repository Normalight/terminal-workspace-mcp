import { combineSignals } from './request-policy.mjs';
import { outputCheckpoint } from './output-checkpoint.mjs';

function wait(client, key, ms, signal) {
  return new Promise(resolve => {
    const done = () => { clearTimeout(timer); client.waiters.delete(done); signal.removeEventListener('abort', done); resolve(); };
    const timer = setTimeout(done, ms);
    client.waiters.add(done); signal.addEventListener('abort', done, { once: true });
    if (client.events.delete(key) || signal.aborted) done();
  });
}

// onPage owns durable consumption: advance only after it has written output and
// saved its checkpoint. Without a consumer, poll metadata and read output once.
export async function monitorTerminal(client, args, { timeoutMs = 30 * 60 * 1000, onPage, pollIntervalMs = 1000, deferOnAdvice = false } = {}) {
  if (!args.sessionId || !args.commandId) throw TypeError('completion recovery requires saved sessionId and commandId');
  for (const [name, value] of Object.entries({ timeoutMs, pollIntervalMs })) {
    if (!Number.isSafeInteger(value) || value <= 0) throw TypeError(`invalid ${name}`);
  }
  if (onPage !== undefined && typeof onPage !== 'function') throw TypeError('onPage must be a function');
  if (args.command !== undefined || args.input !== undefined || args.key !== undefined || args.outputScope === 'terminal') throw TypeError('monitor requires a saved command read');
  const key = `${args.sessionId}:${args.commandId}`, deadline = Date.now() + timeoutMs;
  const signal = combineSignals(client.lifecycle.signal, AbortSignal.timeout(timeoutMs));
  let checkpoint = { sessionId: args.sessionId, commandId: args.commandId, cursor: args.cursor };
  try {
    for (;;) {
      signal.throwIfAborted();
      const page = await client.read({ ...args, cursor: checkpoint.cursor, statusOnly: !onPage, waitMs: 0, notifyOnCompletion: true }, { signal });
      if (onPage) {
        const next = outputCheckpoint(checkpoint, page);
        await onPage(page, next);
        checkpoint = next;
      }
      // A foreground caller yields even when a long task still has unread
      // output. The consumer has acknowledged only this page, not future ones.
      if (deferOnAdvice && page.nextAction === 'defer') return { ...page, monitoringStopped: true,
        recovery: { ...checkpoint, waitMs: 0 },
        ...(onPage ? { outputGap: checkpoint.outputGap, outputComplete: checkpoint.outputComplete } : {}),
      };
      // Explicit continuous monitoring keeps draining before waiting.
      if (onPage && page.outputTruncated) continue;
      if (page.interaction) {
        const error = new Error(page.interaction.message);
        error.code = 'interaction_required'; error.state = page; throw error;
      }
      if (!['running', 'starting'].includes(page.status)) {
        if (!onPage) return await client.read({ ...args, statusOnly: false, waitMs: 0 }, { signal });
        return { ...page, outputGap: checkpoint.outputGap, outputComplete: checkpoint.outputComplete };
      }
      // Output consumers reconcile regularly even with SSE: completion-only
      // notifications cannot protect unread output from log retention.
      const interval = onPage || page.completionNotification?.listening === false
        ? Math.min(client.reconcileMs, pollIntervalMs) : client.reconcileMs;
      await wait(client, key, Math.max(1, Math.min(interval, deadline - Date.now())), signal);
    }
  } catch (error) {
    error.recovery ??= { sessionId: checkpoint.sessionId, commandId: checkpoint.commandId, cursor: checkpoint.cursor, waitMs: 0 };
    throw error;
  } finally { client.events.delete(key); }
}
