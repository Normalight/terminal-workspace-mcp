import { spawn } from 'node:child_process';
import { closeSync } from 'node:fs';

// This detached process owns the job's process group until output has drained.
// TERM reaches the shell and its children, but keeps a verifiable group leader
// alive for the runner's subsequent KILL, even if the shell has already exited.
process.on('SIGTERM', () => {});
process.on('message', message => {
  if (message?.type === 'release') process.exit(0);
});
process.on('disconnect', () => {
  // The runner is gone: do not leave an unsupervised job or an immortal leader.
  try { process.kill(-process.pid, 'SIGKILL'); } catch { process.exit(1); }
});
const [shell, command] = process.argv.slice(2);
const child = spawn(shell, ['-lc', command], { stdio: ['ignore', 1, 2] });
const report = message => { if (process.connected) process.send(message, () => {}); };
child.once('spawn', () => report({ type: 'started' }));
child.once('error', error => report({ type: 'result', error: error.message, failedToStart: true }));
child.once('exit', (exitCode, signal) => report({ type: 'result', exitCode, signal }));
// Only the command and its descendants retain these descriptors. The runner
// can observe EOF while this supervisor is still available for safe signalling.
closeSync(1);
closeSync(2);
