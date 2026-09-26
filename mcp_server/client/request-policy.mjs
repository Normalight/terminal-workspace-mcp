import { AsyncLocalStorage } from 'node:async_hooks';

export const requestContext = new AsyncLocalStorage();
export function combineSignals(...signals) { return AbortSignal.any(signals.filter(Boolean)); }
export function abortable(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) { promise.catch(() => {}); return Promise.reject(signal.reason); }
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

export function recoveringFetch(fetcher, { lifecycle, requestTimeoutMs, url }) {
  return async (target, options = {}) => {
    const cleanup = options.method === 'DELETE', stream = options.method === 'GET';
    const signal = combineSignals(options.signal, cleanup ? undefined : lifecycle.signal,
      stream || cleanup ? undefined : requestContext.getStore()?.signal,
      stream ? undefined : AbortSignal.timeout(cleanup ? 2000 : requestTimeoutMs));
    const response = await fetcher(target, { ...options, signal });
    if (response.status === 404 && options.method === 'POST' && new URL(target).href === url.href && new Headers(options.headers).has('mcp-session-id')) {
      const body = await response.clone().json().catch(() => null);
      if (body?.code === 'mcp_session_expired' && body.recovery?.initializeWithoutSessionId === true && body.recovery?.replayCommand === false) {
        await response.body?.cancel();
        const error = new Error('Origin rejected the expired MCP session before dispatch');
        error.code = 404; error.sessionExpired = true; throw error;
      }
    }
    if ([429, 503].includes(response.status)) {
      const retry = response.headers.get('retry-after');
      const ms = retry === null ? 0 : /^\d+(\.\d+)?$/.test(retry) ? Number(retry) * 1000 : Math.max(0, Date.parse(retry) - Date.now());
      await response.body?.cancel();
      const error = new Error(`HTTP ${response.status}`); error.code = response.status;
      error.retryAfterMs = Number.isFinite(ms) ? ms : 0; throw error;
    }
    return response;
  };
}
