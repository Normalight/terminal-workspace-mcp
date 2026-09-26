import { delay, OperationError } from './runtime.mjs';

export const restartingCode = 'mcp_service_restarting';
export const rejectedRecovery = { requestAccepted: false, initializeWithoutSessionId: true, replayCommand: false };

export function checkSubmission(signal) {
  if (!signal?.aborted) return;
  const error = new OperationError('Service is restarting; this request was not submitted', restartingCode);
  error.recovery = rejectedRecovery;
  throw error;
}

// Finish finite responses before closing transports. Interrupt waiting for a
// task, never the task itself; its returned IDs/cursor survive the restart.
export class ServerLifecycle {
  controller = new AbortController();
  responses = new Set();
  get signal() { return this.controller.signal; }
  get draining() { return this.signal.aborted; }
  track(response) {
    this.responses.add(response);
    const done = () => { this.responses.delete(response); response.off('finish', done); response.off('close', done); };
    response.once('finish', done); response.once('close', done);
  }
  async drain(timeoutMs = 5000) {
    this.controller.abort();
    const deadline = Date.now() + timeoutMs;
    while (this.responses.size && Date.now() < deadline) await delay(10);
    return { unfinishedResponses: this.responses.size };
  }
}
