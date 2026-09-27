import { readFile } from 'node:fs/promises';

async function processState(pid) {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    const end = stat.lastIndexOf(')'), fields = stat.slice(end + 2).split(' ');
    return { name: stat.slice(stat.indexOf('(') + 1, end), group: Number(fields[2]), foreground: Number(fields[5]) };
  } catch { return null; } // Exiting processes and unavailable /proc are normal.
}

// A pager can share Git's foreground process group, so tmux's current-command
// name alone misses it. Inspect names/groups only, never command lines or env.
export async function foregroundInteraction(shellPid) {
  const shell = await processState(shellPid);
  if (!shell || shell.foreground <= 0) return null;
  const pending = [shellPid], visited = new Set();
  while (pending.length && visited.size < 64) {
    const pid = pending.shift();
    if (visited.has(pid)) continue;
    visited.add(pid);
    const state = await processState(pid);
    if (state?.group === shell.foreground && ['less', 'more', 'pager', 'most'].includes(state.name)) {
      return { type: 'pager', process: state.name, message: 'Foreground pager is waiting for input. Send input="q" to leave it when finished reading; polling does not dismiss it.' };
    }
    try {
      const children = await readFile(`/proc/${pid}/task/${pid}/children`, 'utf8');
      pending.push(...children.trim().split(/\s+/).filter(Boolean).slice(0, 64).map(Number));
    } catch {}
  }
  return null;
}

export function nextTerminalAction(state) {
  if (['submission_uncertain', 'unknown'].includes(state.status)) return 'inspect';
  if (state.outputTruncated) return 'read_output';
  if (['running', 'starting'].includes(state.status)) return state.interaction ? 'input' : 'poll';
  return state.outputGap ? 'inspect' : 'done';
}
