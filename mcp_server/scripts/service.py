#!/usr/bin/env python3
"""Workspace-local start/restart helper for the Terminal Workspace MCP HTTP process."""
import argparse
import json
import os
from pathlib import Path
from urllib.parse import urlparse
import signal
import shutil
import socket
import subprocess
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
SERVER = ROOT / 'mcp_server/src/server.mjs'


def inside(value):
    path = Path(value).resolve()
    if not path.is_relative_to(ROOT):
        raise ValueError(f'managed state must be inside {ROOT}')
    return path


def identity(pid):
    try:
        fields = Path(f'/proc/{pid}/stat').read_text().rsplit(')', 1)[1].split()
        if fields[0] in ('Z', 'X'):
            return None
        return f'{pid}:{fields[19]}'
    except (FileNotFoundError, ProcessLookupError):
        return None


def owned(meta, script=SERVER):
    pid = meta.get('pid')
    if not pid or identity(pid) != meta.get('identity'):
        return False
    try:
        args = Path(f'/proc/{pid}/cmdline').read_bytes().split(b'\0')
        return str(script).encode() in args or (f'src/{script.name}'.encode() in args and Path(f'/proc/{pid}/cwd').resolve() == script.parent.parent)
    except (FileNotFoundError, ProcessLookupError):
        return False


def rotate(file):
    if not file.exists() or file.stat().st_size < 8388608:
        return
    for i in range(4, 0, -1):
        previous = file.with_name(file.name + (f'.{i}' if i else ''))
        if previous.exists():
            previous.replace(file.with_name(file.name + f'.{i+1}'))
    file.replace(file.with_name(file.name + '.1'))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['start', 'restart', 'stop', 'status'])
    parser.add_argument('--component', choices=['server', 'relay'], default='server')
    parser.add_argument('--config', default=os.environ.get('MCP_CONFIG_FILE', str(ROOT / 'mcp_server/config.json')))
    args = parser.parse_args()
    script = SERVER if args.component == 'server' else SERVER.with_name('tcp-relay.mjs')
    is_owned = lambda meta: owned(meta, script)
    config_path = inside(args.config)
    resolved = subprocess.run([shutil.which('node') or 'node', str(ROOT / 'mcp_server/scripts/config.mjs'), 'runtime', '--config', str(config_path)], check=True, capture_output=True, text=True)
    loaded = json.loads(resolved.stdout)
    config = loaded['env']
    workspace = inside(config['MCP_WORKSPACE_ROOT'])
    health_url = loaded['healthOrigin'] + '/healthz'
    connect = urlparse(loaded['healthOrigin'])
    runtime = inside(config['MCP_SERVICE_ROOT'])
    runtime.mkdir(parents=True, exist_ok=True)
    state_path = runtime / ('service.json' if args.component == 'server' else 'relay-service.json')
    listen_host, listen_port = connect.hostname, connect.port
    if args.component == 'relay':
        listen_host = {'0.0.0.0': '127.0.0.1', '::': '::1'}.get(config['RELAY_LISTEN_HOST'], config['RELAY_LISTEN_HOST'])
        listen_port = int(config['RELAY_LISTEN_PORT'])
    state = json.loads(state_path.read_text()) if state_path.exists() else {}
    if args.action == 'status':
        data = {'running': is_owned(state), 'pid': state.get('pid'), 'state': str(state_path), 'component': args.component}
        if data['running'] and args.component == 'server':
            url = health_url
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
            try:
                with opener.open(url, timeout=2) as response:
                    health = json.load(response)
                data.update({key: health.get(key) for key in ['version', 'revision', 'toolCount', 'toolProfile', 'writesEnabled', 'commandEnabled']})
            except Exception as error:
                data['healthError'] = str(error)
        print(json.dumps(data))
        return
    if args.action in ('stop', 'restart') and is_owned(state):
        os.kill(state['pid'], signal.SIGTERM)
        deadline = time.monotonic() + 6
        while is_owned(state) and time.monotonic() < deadline:
            time.sleep(.05)
        if is_owned(state):
            os.kill(state['pid'], signal.SIGKILL)
    if args.action == 'stop':
        print(json.dumps({'stopped': not is_owned(state)}))
        return
    if is_owned(state):
        raise RuntimeError('service is already running')
    try:
        connection = socket.create_connection((listen_host, listen_port), timeout=1)
    except OSError:
        pass
    else:
        connection.close()
        raise RuntimeError('configured port is already in use by another process')
    env = {key: os.environ[key] for key in ['PATH', 'HOME', 'USER', 'LANG', 'LC_ALL'] if key in os.environ}
    env.update(config)
    env.update({'TMPDIR': str(workspace / '.tmp'), 'TMP': str(workspace / '.tmp'), 'TEMP': str(workspace / '.tmp'), 'XDG_CACHE_HOME': str(workspace / '.cache'), 'npm_config_cache': str(workspace / '.cache/npm')})
    for key in ['MCP_WORKSPACE_ROOT', 'MCP_JOB_ROOT', 'MCP_TERMINAL_ROOT']:
        if key in env:
            inside(env[key]).mkdir(parents=True, exist_ok=True)
    for key in ['MCP_HTTP_AUDIT_LOG']:
        if key in env:
            inside(env[key]).parent.mkdir(parents=True, exist_ok=True)
    stdout_log, stderr_log = runtime / f'{args.component}.stdout.log', runtime / f'{args.component}.stderr.log'
    for log in [stdout_log, stderr_log]:
        rotate(log)
    with stdout_log.open('ab') as out, stderr_log.open('ab') as err:
        process = subprocess.Popen([loaded['nodeExecutable'], str(script)], cwd=SERVER.parent.parent, env=env, stdin=subprocess.DEVNULL, stdout=out, stderr=err, start_new_session=True)
    state = {'pid': process.pid, 'identity': identity(process.pid), 'configFile': str(config_path), 'component': args.component, 'startedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}
    temp = state_path.with_suffix('.tmp')
    temp.write_text(json.dumps(state) + '\n')
    temp.chmod(0o600)
    temp.replace(state_path)
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    deadline = time.monotonic() + 8
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError(f'server exited ({process.returncode}); inspect {stderr_log}')
        try:
            if args.component == 'relay':
                with socket.create_connection((listen_host, listen_port), timeout=1):
                    pass
                print(json.dumps({'running': True, 'pid': process.pid, 'component': args.component, 'port': listen_port}))
                return
            with opener.open(health_url, timeout=1) as response:
                health = json.load(response)
            if health.get('version') == '0.4.0':
                print(json.dumps({'running': True, 'pid': process.pid, 'version': health['version'], 'toolCount': health.get('toolCount')}))
                return
        except Exception:
            pass
        time.sleep(.1)
    if is_owned(state):
        os.kill(process.pid, signal.SIGTERM)
    raise RuntimeError('server did not become healthy within eight seconds')


if __name__ == '__main__':
    main()
