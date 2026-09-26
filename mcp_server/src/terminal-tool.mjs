import { OperationError } from './runtime.mjs';
import { activeStatus } from './terminal-output.mjs';

// Pin the command before waiting. Another client may submit the next command
// after completion; that must not change this call's identity or output scope.
export async function executeTerminalCall(t, args, resolveCwd) {
  const a = args, began = Date.now();
  if (a.command?.trim() && a.outputScope === 'terminal') throw new OperationError('outputScope=terminal is for reads; command submission returns its command range', 'invalid_input');
  if (a.sessionId && a.terminalKey !== undefined) throw new OperationError('provide sessionId or terminalKey, not both', 'invalid_input');
  if (a.commandId && ((!a.sessionId && !a.terminalKey) || a.command !== undefined || a.input !== undefined || a.key)) throw new OperationError('commandId requires a saved selector and a read without command/input/key', 'invalid_input');
  if (a.command !== undefined && (a.input !== undefined || a.key)) throw new OperationError('send a command or interactive input in separate calls', 'invalid_input');
  if (!a.sessionId && !a.terminalKey && !a.command?.trim()) throw new OperationError('provide command for a new session, or sessionId/terminalKey to resume', 'invalid_input');
  const opened = a.sessionId ? null : await t.open({ terminalKey: a.terminalKey, createIfMissing: !!a.command?.trim(), resolveCwd: () => resolveCwd(a.cwd) });
  const id = a.sessionId ?? opened.sessionId;
  let tracked, page;
  if (a.command?.trim()) {
    const { output, ...state } = await t.execute(id, a); tracked = state; page = output;
  } else {
    if (a.input !== undefined || a.key) await t.write(id, { input: a.input ?? '', key: a.key });
    const state = await t.status(id), target = a.commandId ?? state.activeCommandId;
    if (target && a.outputScope !== 'terminal') {
      const { output, ...command } = await t.readCommand(id, target, a); tracked = command; page = output;
    } else {
      page = await t.read(id, a);
      tracked = target ? await t.commandStatus(id, target) : { status: state.alive ? 'idle' : 'terminal_closed', exitCode: null };
      page = { ...page, outputScope: 'terminal', outputFormat: 'pty', outputGap: page.droppedBytes > 0, outputComplete: false };
    }
  }
  const state = await t.status(id);
  return { ...tracked, sessionId: id, ...(state.terminalKey ? { terminalKey: state.terminalKey } : {}),
    terminalReused: opened?.reused ?? true, ...(opened?.replacedSessionId ? { replacedSessionId: opened.replacedSessionId } : {}),
    cwd: tracked.cwd ?? state.cwd, stdout: page.content, stderr: '', nextCursor: page.nextCursor, endCursor: page.endCursor,
    requestedCursor: page.requestedCursor, earliestCursor: page.earliestCursor, droppedBytes: page.droppedBytes,
    outputTruncated: page.truncated, outputScope: page.outputScope, outputFormat: page.outputFormat,
    outputGap: page.outputGap, outputComplete: page.outputComplete, waitingExpired: activeStatus(tracked.status), durationMs: Date.now() - began };
}

export const terminalDescription = 'Execute shell commands in persistent tmux. Choose a stable terminalKey=project/agent/task before the first submission; it locates a shell, not a deduplicated command. Different agents/tasks should use distinct keys. Save sessionId, commandId and nextCursor. Start once; after a lost reply inspect the saved key without command before deciding anything. Poll with sessionId, commandId, cursor=nextCursor, waitMs=10000 (up to 30000), no command. Tracked output defaults to this command\'s byte range; omitted cursor starts at its beginning. outputScope=terminal reads the shared PTY stream (omitted cursor tails it). PTY merges stdout/stderr and may include interactive echo, ANSI and concurrent background output; use dedicated files for exact process output. Check status, exitCode, outputGap and outputComplete, and drain all pages. waitMs/maxBytes limit the reply, never the process. Existing shells preserve cwd/env; cwd applies only on creation. Closed keys are replaced only by new commands, returning replacedSessionId; initialize their cwd/env again. A shell accepts one active tracked command; concurrent readers have independent cursors. Use input for prompts or key=C-c to interrupt. Running commands subscribe to notifications/message (logger=terminal-workspace.completion); when completionNotification.listening=false, keep polling. Notifications require an active host and do not start another model turn. Re-subscribe with saved IDs and notifyOnCompletion=true after reconnect. HTTP MCP-Session-Id is separate from terminal sessionId; origin session 404 needs a fresh initialize. During planned updates serverRestarting=true returns saved task state early; reconnect and read those IDs without command. submission_uncertain/unknown require inspection, not replay. Use shell for files/search/Git and get_file for artifacts. Inspect managed sessions with node "$MCP_TERMINAL_ADMIN" list; command=exit ends a finished shell after checking background jobs.';
