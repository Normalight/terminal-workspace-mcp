import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { realpath } from 'node:fs/promises';
import { loadConfig, pluginConnection } from '../src/config.mjs';
import { atomicWrite } from '../src/runtime.mjs';

const { values, positionals } = parseArgs({ options: { config: { type: 'string' }, 'plugin-dir': { type: 'string' } }, allowPositionals: true });
const loaded = loadConfig({ file: values.config });
const action = positionals[0] ?? 'show';
if (positionals.length > 1) throw new Error('expected one action: show, sync-plugin, or runtime');
if (action === 'show') {
  console.log(JSON.stringify({ configFile: loaded.configFile, localFile: loaded.localFile, config: loaded.config, authenticationConfigured: Boolean(loaded.env.MCP_AUTH_TOKEN), healthOrigin: loaded.healthOrigin }, null, 2));
} else if (action === 'runtime') {
  // Machine-to-machine output for service.py; never log it or commit it.
  console.log(JSON.stringify({ ...loaded, nodeExecutable: process.execPath }));
} else if (action === 'sync-plugin') {
  const directory = await realpath(values['plugin-dir'] ?? fileURLToPath(new URL('../../plugins/csy-workspace-mcp', import.meta.url)));
  const relative = path.relative(loaded.config.workspaceRoot, directory);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('plugin directory must remain inside workspaceRoot');
  const connection = pluginConnection(loaded.config);
  await atomicWrite(path.join(directory, '.mcp.json'), JSON.stringify(connection, null, 2) + '\n', 0o644);
  await atomicWrite(path.join(directory, 'mcp.json'), JSON.stringify({ $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json', ...connection }, null, 2) + '\n', 0o644);
  console.log(JSON.stringify({ source: loaded.configFile, destination: directory, url: loaded.config.client.url }));
} else throw new Error('expected action: show, sync-plugin, or runtime');
