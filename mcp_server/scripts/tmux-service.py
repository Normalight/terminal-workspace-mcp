#!/usr/bin/env python3
"""Start or adopt this deployment's tmux server without stopping active panes."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import time


def identity(pid):
    try:
        fields = Path(f'/proc/{pid}/stat').read_text().rsplit(')', 1)[1].split()
        return None if fields[0] == 'Z' else fields[19]
    except (FileNotFoundError, ProcessLookupError):
        return None


def tree(pid):
    pending, found = [pid], {}
    while pending:
        current = pending.pop()
        if current in found:
            continue
        token = identity(current)
        if token is None:
            continue
        found[current] = token
        try:
            pending.extend(int(x) for x in Path(f'/proc/{current}/task/{current}/children').read_text().split())
        except (FileNotFoundError, ProcessLookupError):
            pass
    return found


def in_unit(pid, unit):
    try:
        return Path(f'/proc/{pid}/cgroup').read_text().rstrip().endswith('/' + unit)
    except (FileNotFoundError, ProcessLookupError):
        return True


def adopt(pid, unit):
    # Move the tmux parent first, then existing descendants. Children created
    # afterward inherit the new cgroup. PID start times guard against reuse.
    for _ in range(5):
        processes = tree(pid)
        for current, token in processes.items():
            if identity(current) != token:
                continue
            if in_unit(current, unit):
                continue
            result = subprocess.run(['busctl', '--user', 'call', 'org.freedesktop.systemd1', '/org/freedesktop/systemd1',
                                     'org.freedesktop.systemd1.Manager', 'AttachProcessesToUnit', 'ssau', unit, '', '1', str(current)], capture_output=True)
            if result.returncode and identity(current) == token:
                raise RuntimeError(f'could not adopt process {current}: {result.stderr.decode().strip()}')
        remaining = [p for p in tree(pid) if not in_unit(p, unit)]
        if not remaining:
            return
        time.sleep(.05)
    raise RuntimeError('tmux descendants could not all be adopted; existing processes were preserved')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--spec', required=True)
    args = parser.parse_args()
    spec = json.loads(Path(args.spec).read_text())
    root = Path(spec['root']).resolve(); root.mkdir(parents=True, exist_ok=True)
    socket = root / 'tmux.sock'
    command = [spec['tmux'], '-S', str(socket), '-f', spec['tmuxConfig']]
    result = subprocess.run(command + ['display-message', '-p', '#{pid}'], capture_output=True, text=True)
    if result.returncode == 0 and result.stdout.strip().isdigit():
        pid = int(result.stdout.strip())
        # tmux rewrites argv to "tmux: server"; socket inode ownership and the
        # manager's successful query identify the configured private server.
        if not Path(f'/proc/{pid}/exe').resolve().name.startswith('tmux') or socket.stat().st_uid != os.getuid():
            raise RuntimeError('configured tmux server ownership could not be verified')
        adopt(pid, spec['unit'])
        subprocess.run(command + ['set-option', '-g', 'exit-empty', 'off'], check=True, capture_output=True)
    else:
        subprocess.run(command + ['start-server'], check=True, capture_output=True)
        result = subprocess.run(command + ['display-message', '-p', '#{pid}'], check=True, capture_output=True, text=True)
        pid = int(result.stdout.strip())
    target = Path(spec['pidFile']); target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_suffix('.tmp'); temporary.write_text(str(pid) + '\n'); temporary.replace(target)


if __name__ == '__main__':
    main()
