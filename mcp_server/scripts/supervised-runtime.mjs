import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { loadConfig } from '../src/config.mjs';
import { childEnvironment } from '../src/runtime.mjs';
import { LogWriter } from '../src/log-store.mjs';

// The service manager invokes this with a private, workspace-local process
// specification. No CLI-session environment or controlling terminal is needed.
const spec = JSON.parse(await readFile(process.argv[2], 'utf8'));
const deployment = loadConfig({ file: spec.configFile, env: {} });
const workspace = deployment.config.workspaceRoot;
const base = Object.fromEntries(Object.entries(process.env).filter(([key]) => ['HOME', 'USER', 'LANG', 'LC_ALL'].includes(key)));
const env = childEnvironment(workspace, { PATH: spec.path ?? '/usr/local/bin:/usr/bin:/bin', ...base });
for (const key of Object.keys(env)) if (!Object.hasOwn(base, key) && !['PATH', 'TMPDIR', 'TMP', 'TEMP', 'XDG_CACHE_HOME', 'PIP_CACHE_DIR', 'UV_CACHE_DIR', 'npm_config_cache', 'HF_HOME', 'TORCH_HOME', 'CONDA_ENVS_PATH', 'CONDA_PKGS_DIRS'].includes(key)) delete env[key];
Object.assign(env, spec.environment ?? {}, { XDG_CONFIG_HOME: path.join(workspace, '.local/config') });
const logRoot = deployment.config.paths.service;
const child = spawn(spec.executable, spec.args, { cwd: workspace, env, stdio: ['ignore', 'pipe', 'pipe'] });
const pipes = [['stdout', child.stdout], ['stderr', child.stderr]].map(([name, stream]) => pipeline(stream,
  new LogWriter(path.join(logRoot, `${spec.component}.${name}.log`), { segmentBytes: 8388608, maxSegments: 8 })));
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));
child.once('error', error => { console.error(error.message); process.exitCode = 1; });
child.once('exit', (code, signal) => { process.exitCode = code ?? (signal === 'SIGTERM' ? 0 : 1); });
await Promise.all(pipes).catch(error => { child.kill('SIGTERM'); console.error(error.message); process.exitCode = 1; });
