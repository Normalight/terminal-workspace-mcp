import { randomUUID } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { atomicJson, atomicWrite, delay, integer, jsonFile, OperationError, processIdentity, quote } from './runtime.mjs';
import { readLog } from './log-store.mjs';
import { activeStatus, blocksSubmission, readCommandOutput } from './terminal-output.mjs';

const COMMAND = /^cmd_[a-f0-9-]{36}$/;
async function fallbackEnd(base, meta, session) {
  const saved = await jsonFile(base + '.output-end.json', null);
  if (saved) return saved.outputEndCursor;
  let end = (await readLog(session.log, { maxBytes: 4, segmentBytes: session.logs.segmentBytes })).endCursor;
  // Old receipts lack the collector's end marker. Bound their best-effort
  // history by the next submitted command and explicitly report a gap.
  for (const name of await readdir(path.dirname(base))) {
    if (!/^cmd_[a-f0-9-]{36}\.json$/.test(name)) continue;
    const next = await jsonFile(path.join(path.dirname(base), name), null);
    if (next && next.commandId !== meta.commandId && (next.submittedAt ?? next.startedAt) > (meta.submittedAt ?? meta.startedAt)) end = Math.min(end, next.startCursor);
  }
  await atomicJson(base + '.output-end.json', { outputEndCursor: end });
  return end;
}
export async function collectorState(manager, session, pane) {
  const record = await jsonFile(path.join(manager.dir(session.sessionId), 'logger.json'), null);
  if (record) return { alive: record.status === 'running' && await processIdentity(record.pid) === record.identity, ...record };
  return { alive: !!pane.pipeActive, status: 'legacy' };
}

export async function submitCommand(manager, id, { command, waitMs = 1000, maxBytes = 65536 } = {}) {
  if (typeof command !== 'string' || !command.trim() || command.length > 20000) throw new OperationError('command must be 1..20000 characters', 'invalid_input');
  integer(waitMs, 'waitMs', 0, 30000);
  const commandId = await manager.locked(id, async () => {
    const state = await manager.status(id);
    if (!state.alive) throw new OperationError('terminal is closed; inspect saved command IDs before starting a replacement', 'terminal_closed');
    if (state.activeCommandId && blocksSubmission((await manager.commandStatus(id, state.activeCommandId)).status)) {
      throw new OperationError('tracked command is active or its submission is uncertain; inspect it without command, or use input/key for its interaction', 'terminal_busy');
    }
    if (!(await collectorState(manager, state, state)).alive) throw new OperationError('terminal output collector is unavailable; inspect saved command results, then use a new terminal for new work', 'collector_unavailable');
    if (state.shellStateVersion >= 1) {
      let ready = false;
      for (let i = 0; i < 6; i++) {
        ready = await readFile(path.join(manager.dir(id), 'ready'), 'utf8').then(x => x === 'ready', () => false);
        if (ready) break; await delay(20);
      }
      if (!ready) throw new OperationError('shell is not at a prompt; use input/key for the current interaction', 'terminal_busy');
    }
    const cid = `cmd_${randomUUID()}`, directory = path.join(manager.dir(id), 'commands'), base = path.join(directory, cid);
    const tail = await readLog(state.log, { maxBytes: 4, segmentBytes: state.logs.segmentBytes });
    const meta = { commandId: cid, sessionId: id, command, cwd: state.cwd, submittedAt: new Date().toISOString(),
      startedAt: null, startCursor: tail.endCursor, submissionProtocol: 1 };
    await atomicWrite(base + '.sh', command + '\n');
    await atomicJson(base + '.json', meta);
    await atomicJson(base + '.delivery.json', { phase: 'prepared' });
    await atomicJson(path.join(manager.dir(id), 'activity.json'), { lastUsedAt: meta.submittedAt });
    await atomicJson(path.join(manager.dir(id), 'current.json'), { commandId: cid });
    let dispatching = false;
    const beforeDispatch = async () => { await atomicJson(base + '.delivery.json', { phase: 'dispatching' }); dispatching = true; };
    try {
      const text = state.shellStateVersion >= 2
        ? `__csy_dispatch ${quote(base + '.result.json')} ${quote(base + '.sh')}`
        : `__csy_result_file=${quote(base + '.result.json')}; . ${quote(base + '.sh')}`;
      await manager.send(id, text, true, beforeDispatch);
      await atomicJson(base + '.delivery.json', { phase: 'sent' });
    } catch (error) {
      // A paste/Enter failure can be ambiguous. Never turn that into permission
      // to replay. A failure before dispatch is definitively not submitted.
      await atomicJson(base + '.delivery.json', { phase: dispatching ? 'uncertain' : 'failed', errorCode: error.code ?? 'terminal_error' });
      error.recovery = { sessionId: id, commandId: cid, waitMs: 0 };
      error.code = dispatching ? 'submission_uncertain' : 'submission_failed';
      throw error;
    }
    return cid;
  });
  const deadline = Date.now() + waitMs;
  while (activeStatus((await manager.commandStatus(id, commandId)).status) && Date.now() < deadline) await delay(20);
  return readCommandOutput(manager, id, commandId, { waitMs: 0, maxBytes });
}

export async function commandState(manager, id, commandId) {
  if (!COMMAND.test(commandId)) throw new OperationError('invalid command id', 'invalid_input');
  const base = path.join(manager.dir(id), 'commands', commandId);
  const meta = await jsonFile(base + '.json');
  const [result, executed, started, startMarker, delivery, pane, session] = await Promise.all([
    jsonFile(base + '.result.json', null), jsonFile(base + '.executed.json', null), jsonFile(base + '.started.json', null),
    jsonFile(base + '.output-start.json', null), jsonFile(base + '.delivery.json', null), manager.pane(id), jsonFile(path.join(manager.dir(id), 'meta.json')),
  ]);
  let drained = !pane.alive && session.outputProtocol >= 1 ? await jsonFile(path.join(manager.dir(id), 'log-drained.json'), null) : null;
  if (!result && !pane.alive && session.outputProtocol >= 1 && !drained && pane.pid && pane.pipeActive) {
    await manager.run(['if-shell', '-F', '-t', `${id}:0.0`, '#{pane_dead}', `pipe-pane -t '${id}:0.0'`]);
  }
  const collector = await collectorState(manager, session, pane);
  // Closing pipe-pane can finish the logger between the preceding reads.
  if (!pane.alive && !drained) drained = await jsonFile(path.join(manager.dir(id), 'log-drained.json'), null);
  const receipt = result ?? executed;
  let status, executionStatus, outputStatus;
  if (receipt) {
    executionStatus = receipt.exitCode === 0 ? 'succeeded' : 'failed';
    outputStatus = result ? Number.isSafeInteger(result.outputEndCursor) ? 'complete' : 'incomplete' : collector.alive ? 'pending' : 'incomplete';
    status = outputStatus === 'pending' ? 'running' : executionStatus;
  } else if (!pane.alive) {
    executionStatus = 'terminal_closed'; outputStatus = drained ? 'complete' : collector.alive ? 'pending' : 'incomplete';
    status = outputStatus === 'pending' ? 'running' : executionStatus;
  } else if (delivery?.phase === 'failed') {
    status = executionStatus = 'failed_to_start'; outputStatus = 'complete';
  } else if (meta.submissionProtocol && !started && !result && !['sent'].includes(delivery?.phase)) {
    status = executionStatus = 'submission_uncertain'; outputStatus = 'incomplete';
  } else if (!collector.alive && !started) {
    status = executionStatus = 'unknown'; outputStatus = 'incomplete';
  } else {
    status = executionStatus = started || !meta.submissionProtocol || (session.shellStateVersion ?? 0) < 2 ? 'running' : 'starting';
    outputStatus = collector.alive ? 'pending' : 'incomplete';
  }
  const terminal = !['running', 'starting', 'submission_uncertain', 'unknown'].includes(status);
  const resultFile = result ? base + '.result.json' : executed ? base + '.executed.json' : null;
  const startedAt = started ? (await stat(base + '.started.json')).mtime.toISOString() : meta.startedAt;
  return { ...meta, startCursor: startMarker?.startCursor ?? meta.startCursor, startedAt,
    status, executionStatus, outputStatus, collectorAlive: collector.alive,
    outputStarted: (session.outputProtocol ?? 0) < 2 || !!startMarker,
    exitCode: receipt?.exitCode ?? pane.exitCode, finishedAt: resultFile ? (await stat(resultFile)).mtime.toISOString() : null,
    outputEndCursor: delivery?.phase === 'failed' ? meta.startCursor : result?.outputEndCursor ?? drained?.outputEndCursor ?? (terminal ? await fallbackEnd(base, meta, session) : null),
  };
}
