import path from 'node:path';
import { atomicJson, jsonFile } from './runtime.mjs';

// tmux 3.4 rejects pipe-pane even when the request only closes the pipe on
// an exited pane. Preserve the exit receipt, then remove only that dead pane.
// pane_dead is published after tmux has flushed PTY bytes into its pipe; EOF
// still lets the collector drain queued bytes and publish log-drained.json.
export async function drainExitedPane(manager, id, pane) {
  const file = path.join(manager.dir(id), 'pane-exit.json');
  if (!pane.alive && pane.pid && pane.pipeActive) {
    try {
      await manager.run(['if-shell', '-F', '-t', `${id}:0.0`, '#{pane_dead}', `pipe-pane -t '${id}:0.0'`]);
    } catch (error) {
      if (error.message !== 'target pane has exited') {
        // Another reader may already have removed the dead pane. Require its
        // saved receipt before accepting the missing target as successful drain.
        const receipt = /can't find (session|window|pane)|no server running/.test(error.message) ? await jsonFile(file, null) : null;
        if (receipt) return { ...pane, exitCode: receipt.exitCode };
        throw error;
      }
      const current = await manager.pane(id);
      if (!current.alive && current.pid === pane.pid) {
        await atomicJson(file, { exitCode: current.exitCode ?? pane.exitCode ?? null });
        await manager.run(['if-shell', '-F', '-t', `${id}:0.0`,
          `#{&&:#{pane_dead},#{==:#{pane_pid},${current.pid}}}`,
          `kill-pane -t '${id}:0.0'`]).catch(e => {
          if (!/can't find (session|window|pane)|no server running/.test(e.message)) throw e;
        });
      }
    }
  }
  const saved = !pane.alive ? await jsonFile(file, null) : null;
  return { ...pane, exitCode: pane.exitCode ?? saved?.exitCode ?? null };
}
