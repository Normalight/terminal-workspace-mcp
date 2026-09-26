#!/usr/bin/env python3
"""Prepare and manage independent systemd user services for a deployment."""
import argparse
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys

SOURCE = Path(__file__).resolve().parents[1]


def configuration(config_file):
    # Match the supervised processes: caller environment must not redirect
    # this command to another deployment's workspace, port or credentials.
    return json.loads(subprocess.run([shutil.which('node'), str(SOURCE / 'scripts/config.mjs'),
                                     'show', '--isolated', '--config', str(Path(config_file).resolve())],
                                    check=True, capture_output=True, text=True).stdout)


def quoted(value):
    value = str(value)
    if '\n' in value or '\r' in value or '\0' in value:
        raise ValueError('unit values cannot contain control characters')
    return '"' + value.replace('\\', '\\\\').replace('"', '\\"').replace('%', '%%') + '"'


def write_private(file, content):
    file.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(file, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w') as stream:
        stream.write(content)
    file.chmod(0o600)


def prepare(config_file, prefix, tunnel_spec=None):
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,79}', prefix):
        raise ValueError('invalid service prefix')
    node = shutil.which('node')
    data = configuration(config_file)
    config = data['config']; workspace = Path(config['workspaceRoot']).resolve()
    if not data['authenticationConfigured'] and (config['tools']['enableTerminal'] or not config['http']['allowAnonymous']):
        raise ValueError('supervised authentication must be set in private configuration, not the caller environment')
    runtime = Path(config['paths']['service']); directory = runtime / 'systemd'
    directory.mkdir(parents=True, exist_ok=True)
    if not directory.resolve().is_relative_to(workspace):
        raise ValueError('service files must remain inside workspace')
    units = {role: f'{prefix}-{role}.service' for role in ['terminals', 'server', 'relay']}
    if tunnel_spec:
        units['tunnel'] = f'{prefix}-tunnel.service'
    paths = {'TMPDIR': workspace / '.tmp', 'TMP': workspace / '.tmp', 'TEMP': workspace / '.tmp',
             'XDG_CACHE_HOME': workspace / '.cache', 'XDG_CONFIG_HOME': workspace / '.local/config',
             'PIP_CACHE_DIR': workspace / '.cache/pip', 'UV_CACHE_DIR': workspace / '.cache/uv',
             'npm_config_cache': workspace / '.cache/npm', 'HF_HOME': workspace / '.cache/huggingface',
             'TORCH_HOME': workspace / '.cache/torch', 'CONDA_ENVS_PATH': workspace / 'shared/envs',
             'CONDA_PKGS_DIRS': workspace / '.cache/conda/pkgs', 'MCP_CONFIG_FILE': Path(config_file).resolve(), 'MCP_ISOLATED_SERVICE': '1'}
    tmux_config = directory / 'tmux.conf'; tmux_config.write_text('set-option -g exit-empty off\n')
    tmux_spec = directory / 'tmux.json'
    tmux_data = {'root': config['paths']['terminals'], 'tmux': shutil.which('tmux'), 'unit': units['terminals'],
                 'tmuxConfig': str(tmux_config), 'pidFile': str(runtime / 'tmux.pid')}
    write_private(tmux_spec, json.dumps(tmux_data, indent=2) + '\n')
    for role, name in units.items():
        lines = ['[Unit]', f'Description=Terminal Workspace {role}', 'StartLimitIntervalSec=60', 'StartLimitBurst=10']
        if role == 'server':
            lines += [f'Requires={units["terminals"]}', f'After={units["terminals"]}']
        if role in ['relay', 'tunnel']:
            lines += [f'Wants={units["server"]}', f'After={units["server"]}']
        lines += ['', '[Service]', 'Type=forking' if role == 'terminals' else 'Type=simple',
                  'WorkingDirectory=' + str(workspace).replace('%', '%%'), 'UMask=0077', 'Restart=on-failure', 'RestartSec=2',
                  # A failed adoption must never kill already migrated tasks.
                  # tmux itself owns pane shutdown; the helper guards stopping it.
                  'TimeoutStopSec=10', 'KillMode=process' if role in ['server', 'terminals'] else 'KillMode=control-group']
        for key, value in paths.items():
            lines += ['Environment=' + quoted(f'{key}={value}')]
        lines += ['Environment=' + quoted('PATH=/usr/local/bin:/usr/bin:/bin')]
        if role == 'terminals':
            command = [sys.executable, '-B', str(SOURCE / 'scripts/tmux-service.py'), '--spec', str(tmux_spec)]
            lines += ['PIDFile=' + tmux_data['pidFile'].replace('%', '%%'), 'GuessMainPID=no', 'Delegate=yes']
        elif role == 'tunnel':
            spec = json.loads(Path(tunnel_spec).read_text()); spec.update({'configFile': str(Path(config_file).resolve()), 'component': 'tunnel'})
            spec_file = directory / 'tunnel.private.json'; write_private(spec_file, json.dumps(spec, indent=2) + '\n')
            command = [node, str(SOURCE / 'scripts/supervised-runtime.mjs'), str(spec_file)]
        else:
            command = [node, str(SOURCE / 'src' / ('server.mjs' if role == 'server' else 'tcp-relay.mjs'))]
        lines += ['ExecStart=' + ' '.join(quoted(x) for x in command),
                  'StandardOutput=null',
                  'StandardError=append:' + str(runtime / f'{role}.bootstrap.stderr.log'), '', '[Install]', 'WantedBy=default.target', '']
        (directory / name).write_text('\n'.join(lines))
    manifest = {'source': str(SOURCE), 'configFile': str(Path(config_file).resolve()), 'workspace': str(workspace),
                'directory': str(directory), 'units': units, 'installed': False}
    write_private(runtime / 'supervised-services.json', json.dumps(manifest, indent=2) + '\n')
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['prepare', 'install', 'start', 'stop', 'restart', 'status'])
    parser.add_argument('--config', default=str(SOURCE / 'config.json'))
    parser.add_argument('--prefix', default='terminal-workspace')
    parser.add_argument('--tunnel-spec')
    parser.add_argument('--component', choices=['server', 'relay', 'tunnel', 'terminals', 'all'], default='server')
    args = parser.parse_args()
    if args.action == 'prepare':
        print(json.dumps(prepare(args.config, args.prefix, args.tunnel_spec))); return
    data = configuration(args.config)
    manifest_path = Path(data['config']['paths']['service']) / 'supervised-services.json'
    manifest = json.loads(manifest_path.read_text())
    names = list(manifest['units'].values()) if args.component == 'all' else [manifest['units'][args.component]]
    if args.action == 'install':
        files = [str(Path(manifest['directory']) / name) for name in manifest['units'].values()]
        subprocess.run(['systemctl', '--user', 'enable', *files], check=True)
        subprocess.run(['systemctl', '--user', 'daemon-reload'], check=True)
        manifest['installed'] = True; write_private(manifest_path, json.dumps(manifest, indent=2) + '\n')
    elif args.action == 'status':
        subprocess.run(['systemctl', '--user', 'show', *names, '-p', 'Id', '-p', 'ActiveState', '-p', 'SubState', '-p', 'MainPID', '-p', 'ControlGroup', '-p', 'NRestarts'], check=True)
    else:
        if args.component == 'terminals' and args.action in ['stop', 'restart']:
            raise RuntimeError('terminal service stop/restart ends its tasks; manage it explicitly with systemctl after inspecting live sessions')
        if args.component == 'all' and args.action in ['stop', 'restart']:
            names = [name for role, name in manifest['units'].items() if role != 'terminals']
        subprocess.run(['systemctl', '--user', args.action, *names], check=True)


if __name__ == '__main__':
    main()
