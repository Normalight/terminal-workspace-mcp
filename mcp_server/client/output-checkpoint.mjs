// Checkpoints record execution and output completeness independently. A zero
// exit code cannot validate bytes lost to retention or collector failure.
export function outputCheckpoint(previous, page) {
  if (previous.sessionId && previous.sessionId !== page.sessionId) throw Error('Resume changed terminal identity');
  if (previous.commandId && previous.commandId !== page.commandId) throw Error('Resume changed command identity');
  const gap = previous.outputGap === true || page.outputGap === true || page.droppedBytes > 0;
  return { ...previous, sessionId: page.sessionId, commandId: page.commandId, cursor: page.nextCursor,
    phase: 'monitoring', outputGap: gap, outputComplete: page.outputComplete === true && !gap,
    ...(page.droppedBytes ? { droppedBytes: (previous.droppedBytes ?? 0) + page.droppedBytes } : {}),
    executionStatus: page.executionStatus ?? page.status, exitCode: page.exitCode };
}
