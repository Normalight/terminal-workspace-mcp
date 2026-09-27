import { randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { outputCheckpoint } from '../client/output-checkpoint.mjs';
import { ReconnectingTerminalClient } from '../client/reconnecting-client.mjs';
import { atomicJson } from '../src/runtime.mjs';
import { loadConfig } from '../src/config.mjs';

const deployment = loadConfig(), argv = process.argv.slice(2), resume = argv[0] === '--resume';
if ((!resume && !argv.length) || (resume && argv.length !== 2)) throw Error('Usage: completion-client.mjs <shell-command> [next-command ...] | --resume <state-file>');
const workspace = await realpath(deployment.config.workspaceRoot);
const stateFile = path.resolve(resume ? argv[1] : path.join(workspace, 'outputs/mcp-client-state', `${randomUUID()}.json`));
const within = p => p === workspace || p.startsWith(workspace + path.sep);
if (!within(stateFile)) throw Error('State file must be inside the configured workspace');
// Check existing ancestors before creating directories, including symlinks.
let ancestor = path.dirname(stateFile);
for (;;) {
  try { if (!within(await realpath(ancestor))) throw Error('State directory resolves outside workspace'); break; }
  catch (error) { if (error.code !== 'ENOENT') throw error; ancestor = path.dirname(ancestor); }
}
await mkdir(path.dirname(stateFile), { recursive: true });
const client = new ReconnectingTerminalClient({
  url: process.env.MCP_NOTIFICATION_URL ?? `${deployment.healthOrigin}${deployment.config.http.path}`,
  requestInit: { headers: { Authorization: `Bearer ${deployment.env.MCP_AUTH_TOKEN}` } },
  onReconnect: ({ generation }) => console.error(JSON.stringify({ reconnected: true, generation })),
});
let state = resume ? JSON.parse(await readFile(stateFile, 'utf8')) : { terminalKey: `example/${randomUUID()}`, phase: 'new' };
const save = () => atomicJson(stateFile, state);
const writeOutput = text => new Promise((resolve, reject) => process.stdout.write(text, error => error ? reject(error) : resolve()));
async function consume(page) {
  const next = outputCheckpoint(state, page);
  await writeOutput(page.stdout);
  state = next;
  if (state.outputGap) console.error(JSON.stringify({ code: 'output_incomplete', droppedBytes: state.droppedBytes ?? 0 }));
  await save(); // A crash before this checkpoint may repeat a page, never a command.
}
async function finish() {
  const target = { sessionId: state.sessionId, commandId: state.commandId, cursor: state.cursor };
  const final = await client.waitForCompletion(target, { onPage: consume });
  console.error(JSON.stringify({ commandId: state.commandId, status: final.status, exitCode: final.exitCode }));
  state.phase = state.outputGap || !state.outputComplete ? 'incomplete' : 'complete'; await save();
  if (final.exitCode !== 0 || state.phase !== 'complete') process.exitCode = 1;
}
try {
  console.error(JSON.stringify({ stateFile, resume }));
  if (resume) {
    if (!state || typeof state !== 'object' || (!state.sessionId && !state.terminalKey)) throw Error('Invalid checkpoint: missing saved terminal selector');
    // This branch submits no commands, even if the initial submission reply was
    // lost. A unique key locates that workflow's shell; missing state fails closed.
    const selector = state.sessionId ? { sessionId: state.sessionId } : { terminalKey: state.terminalKey };
    let page = await client.read({ ...selector, commandId: state.commandId, cursor: state.cursor, waitMs: 0, notifyOnCompletion: true });
    if (!page.commandId) throw Error('No tracked command is confirmed; inspect the saved task before considering a new submission.');
    if (state.phase === 'submitting') {
      if (page.commandId === state.previousCommandId) throw Error('Only the previous command is confirmed; inspect the pending submission without replaying it.');
      page = await client.read({ sessionId: page.sessionId, commandId: page.commandId, cursor: page.startCursor, waitMs: 0, notifyOnCompletion: true });
    }
    await consume(page); await finish();
  } else {
    for (const command of argv) {
      // Commit the selector before sending. No command text or token is stored.
      const sessionId = state.sessionId;
      state = { terminalKey: state.terminalKey, ...(sessionId ? { sessionId } : {}), previousCommandId: state.commandId, phase: 'submitting' }; await save();
      const page = await client.execute({ ...(sessionId ? { sessionId } : { terminalKey: state.terminalKey }),
        command, cwd: workspace, waitMs: 0, notifyOnCompletion: true });
      await consume(page); await finish();
    }
  }
} finally { await client.close(); }
