import { nextTerminalAction } from './terminal-interaction.mjs';

// Task age comes from durable command receipts, so reconnecting or adding a
// second reader cannot reset the foreground budget. This is advice, not a kill.
export function terminalMonitoring(state, { cursor, foregroundBudgetMs = 30000, now = Date.now() } = {}) {
  const value = { ...state, nextAction: nextTerminalAction(state) };
  if (!['running', 'starting'].includes(state.executionStatus ?? state.status) || state.interaction) return value;
  const started = Date.parse(state.startedAt ?? state.submittedAt);
  const elapsedMs = Number.isFinite(started) ? Math.max(0, now - started) : null;
  const estimate = state.estimatedDurationMs;
  const hasEstimate = Number.isSafeInteger(estimate) && estimate > 0;
  const estimatedRemainingMs = hasEstimate && elapsedMs !== null && estimate > elapsedMs ? estimate - elapsedMs : null;
  const estimateExceeded = hasEstimate && elapsedMs !== null && elapsedMs >= estimate;
  const deferred = elapsedMs !== null && elapsedMs >= foregroundBudgetMs || hasEstimate && estimate > foregroundBudgetMs;
  const checkAfterMs = Math.min(120000, Math.max(30000, estimatedRemainingMs ?? (elapsedMs >= 600000 ? 120000 : elapsedMs >= 120000 ? 60000 : 30000)));
  const resumeCursor = state.outputRead === false ? cursor : state.nextCursor;
  return { ...value, ...(deferred ? { nextAction: 'defer' } : {}), monitoring: {
    action: deferred ? 'defer' : 'poll', foregroundBudgetMs, elapsedMs,
    estimatedRemainingMs, estimateSource: hasEstimate ? 'caller' : 'unavailable', estimateExceeded,
    ...(deferred ? {
      reason: elapsedMs >= foregroundBudgetMs ? 'foreground_budget_exhausted' : 'estimated_long_task',
      checkAfterMs, checkAfterAt: new Date(now + checkAfterMs).toISOString(),
      resume: { sessionId: state.sessionId, commandId: state.commandId, ...(Number.isSafeInteger(resumeCursor) ? { cursor: resumeCursor } : {}), waitMs: 0 },
      instruction: 'End foreground polling for this turn and report that the task is still running. Save the resume IDs/cursor and suggest checking after checkAfterMs. This is a check interval, not a completion ETA. Any ETA is caller-supplied and may be exceeded. Do not cancel or resubmit. Future checks require a user request or a supported scheduler; notifications alone do not schedule a new turn. Unread terminal logs remain subject to retention; use durable output files for long tasks.',
    } : {}),
  } };
}
