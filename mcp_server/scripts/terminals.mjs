import { parseArgs } from 'node:util';
import { loadConfig } from '../src/config.mjs';
import { TerminalManager } from '../src/terminal-manager.mjs';
import { TerminalAdmin } from '../src/terminal-admin.mjs';

const { values, positionals } = parseArgs({ options: { config: { type: 'string' }, apply: { type: 'boolean', default: false }, session: { type: 'string' }, help: { type: 'boolean' } }, allowPositionals: true });
if (values.help) {
  console.log('node terminals.mjs list|cleanup [--config FILE] [--session term_UUID] [--apply]\ncleanup previews the configured policy; --apply reclaims verified exited or expired idle sessions. Running jobs, attached clients, kept or split sessions are protected. Logs remain.');
} else {
  const action = positionals[0] ?? 'list';
  if (positionals.length > 1 || !['list', 'cleanup'].includes(action) || (action === 'list' && (values.apply || values.session))) throw new Error('expected list or cleanup [--session ID] [--apply]');
  const loaded = loadConfig({ file: values.config });
  const manager = await new TerminalManager({ root: loaded.config.paths.terminals }).initialize();
  const admin = new TerminalAdmin(manager);
  const policy = { idleTtlMs: loaded.config.terminal.idleTtlMs };
  console.log(JSON.stringify(action === 'list' ? await admin.inventory(policy) : await admin.cleanup({ ...policy, apply: values.apply, sessionId: values.session }), null, 2));
}
