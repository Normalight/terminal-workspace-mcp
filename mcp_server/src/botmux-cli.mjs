import { spawn } from 'node:child_process';

// The automation CLI emits a pretty-printed JSON object. Keep credentials and
// stderr out of persisted errors; failed mutations may already have side effects.
export function runBotmuxCli({ executable, args, env, cwd, timeoutMs, signal }) {
  return new Promise(resolve => {
    let stdout = '', done = false, interrupted = false;
    const child = spawn(executable, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const stop = () => { interrupted = true; child.kill('SIGKILL'); };
    const timer = setTimeout(stop, timeoutMs);
    const finish = result => { if (done) return; done = true; clearTimeout(timer); signal?.removeEventListener('abort', stop); resolve(result); };
    signal?.addEventListener('abort', stop, { once: true }); if (signal?.aborted) stop();
    child.stdout.on('data', chunk => { stdout += chunk; if (stdout.length > 262144) stop(); });
    child.stderr.on('data', () => {});
    child.once('error', error => finish({ status: 'retry', code: error.code === 'ENOENT' ? 'botmux_not_found' : 'botmux_spawn_failed' }));
    child.once('close', code => {
      let value; try { value = JSON.parse(stdout); } catch {}
      if (value?.ok === true && code === 0 && !interrupted) return finish({ status: 'ok', value });
      finish({ status: 'uncertain', code: 'botmux_operation_unconfirmed' });
    });
  });
}
