import { readFile, readlink } from 'node:fs/promises';

async function terminalRead(pid) {
  try {
    const fd = await readlink(`/proc/${pid}/fd/0`);
    if (!/^\/dev\/(pts\/\d+|tty\d*)$/.test(fd)) return null;
    const call = await readFile(`/proc/${pid}/syscall`, 'utf8').catch(() => null);
    if (call === null) {
      const channel = (await readFile(`/proc/${pid}/wchan`, 'utf8')).trim();
      // wait_woken can also describe socket I/O. Expose only a hint, never an
      // input requirement or a reason to interrupt an otherwise valid task.
      return channel === 'wait_woken' ? 'possible' : null;
    }
    const [number, descriptor] = call.trim().split(/\s+/);
    const readNumber = { x64: '0', arm64: '63' }[process.arch];
    return readNumber !== undefined && number === readNumber && Number(descriptor) === 0 ? 'observed' : null;
  } catch { return null; }
}

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
  let hint = null;
  while (pending.length && visited.size < 64) {
    const pid = pending.shift();
    if (visited.has(pid)) continue;
    visited.add(pid);
    const state = await processState(pid);
    if (state?.group === shell.foreground && ['less', 'more', 'pager', 'most'].includes(state.name)) {
      return { type: 'pager', process: state.name, message: 'Foreground pager is waiting for input. Send input="q" to leave it when finished reading; polling does not dismiss it.' };
    }
    if (state?.group === shell.foreground) {
      const input = await terminalRead(pid);
      if (input === 'observed') return { type: 'terminal_input', process: state.name, message: 'Foreground process is blocked reading terminal input. Inspect the prompt and provide the intended input or explicitly interrupt; polling alone will not supply input.' };
      if (input === 'possible') hint = { type: 'possible_terminal_input', process: state.name, message: 'Foreground process is waiting on I/O and has terminal stdin. Kernel restrictions prevent confirming what it is reading. Inspect recent output for a prompt; this can also be normal I/O waiting.' };
    }
    try {
      const children = await readFile(`/proc/${pid}/task/${pid}/children`, 'utf8');
      pending.push(...children.trim().split(/\s+/).filter(Boolean).slice(0, 64).map(Number));
    } catch {}
  }
  return hint;
}

export function nextTerminalAction(state) {
  if (['submission_uncertain', 'unknown'].includes(state.status)) return 'inspect';
  if (state.outputTruncated) return 'read_output';
  if (['running', 'starting'].includes(state.status)) return state.interaction ? 'input' : 'poll';
  if (state.outputRead === false) return state.outputStatus === 'incomplete' ? 'inspect' : 'read_output';
  return state.outputGap ? 'inspect' : 'done';
}
