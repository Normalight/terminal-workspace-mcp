import { readLog } from './log-store.mjs';
import { delay, integer } from './runtime.mjs';

export const activeStatus = status => ['running', 'starting'].includes(status);
export const blocksSubmission = status => activeStatus(status) || ['submission_uncertain', 'unknown'].includes(status);

export async function readCommandOutput(manager, id, commandId, { cursor, maxBytes = 65536, waitMs = 0 } = {}) {
  integer(waitMs, 'waitMs', 0, 30000);
  await manager.touch(id);
  const until = Date.now() + waitMs;
  for (;;) {
    let tracked = await manager.commandStatus(id, commandId);
    const state = await manager.status(id);
    const read = command => readLog(state.log, { cursor: cursor ?? command.startCursor, minCursor: command.startCursor,
      endCursor: command.outputEndCursor ?? (command.outputStarted === false ? command.startCursor : undefined),
      maxBytes, segmentBytes: state.logs.segmentBytes, final: command.outputEndCursor !== null });
    let page = await read(tracked);
    if (activeStatus(tracked.status)) {
      const after = await manager.commandStatus(id, commandId);
      if (after.outputEndCursor !== tracked.outputEndCursor || after.startCursor !== tracked.startCursor || after.status !== tracked.status) {
        tracked = after;
        // Always refresh from the caller's original cursor. Reusing a clamped
        // cursor would erase retention gaps, and a moving tail can cross into
        // the next command while completion is being acknowledged.
        page = await read(tracked);
      }
    }
    const outputGap = page.droppedBytes > 0 || tracked.outputStatus === 'incomplete';
    const output = { ...page, outputScope: 'command', outputFormat: 'pty', outputGap,
      outputComplete: !activeStatus(tracked.status) && !page.truncated && !outputGap && tracked.outputStatus === 'complete' };
    if (page.content || !activeStatus(tracked.status) || Date.now() >= until) return { ...tracked, output };
    await delay(Math.min(40, Math.max(0, until - Date.now())));
  }
}
