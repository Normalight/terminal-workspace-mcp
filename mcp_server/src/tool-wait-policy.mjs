import { requestAudit } from './request-audit.mjs';

// A response wait budget is not a process deadline. Apply it on the server so
// cached tool schemas and callers explicitly asking for 30s also return sooner.
export function toolWait(args, { legacy = false } = {}) {
  const budget = requestAudit.getStore()?.maxToolWaitMs;
  if (budget === undefined) return { args, metadata: {} };
  const requestedWaitMs = args.waitMs ?? (legacy ? args.timeoutMs ?? 30000 : 1000);
  const effectiveWaitMs = args.statusOnly ? 0 : Math.min(requestedWaitMs, budget);
  return { args: { ...args, waitMs: effectiveWaitMs }, metadata: {
    requestedWaitMs, effectiveWaitMs, waitLimited: effectiveWaitMs < requestedWaitMs,
  } };
}
