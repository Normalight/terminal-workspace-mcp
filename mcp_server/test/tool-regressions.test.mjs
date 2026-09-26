import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { registerTools } from '../src/tools.mjs';
import { TerminalManager } from '../src/terminal-manager.mjs';
import { Workspace } from '../src/workspace.mjs';
import { loadConfig } from '../src/config.mjs';
import { delay } from '../src/runtime.mjs';
import { fixture } from './helpers.mjs';

function callbacks(workspace, terminals, directFileMaxBytes = 1048576) {
  const registered = new Map();
  registerTools({ registerTool: (name, spec, call) => registered.set(name, call) }, {
    workspace, terminals, config: { enableTerminal: true, toolProfile: 'minimal', directFileMaxBytes },
  });
  return registered;
}

test('poll includes final output when completion arrives after its initial read', { timeout: 15000 }, async () => {
  const f = await fixture(), t = await new TerminalManager({ root: path.join(f.root, 'tmux'), env: f.env }).initialize();
  let id;
  try {
    const tools = callbacks(await new Workspace(f.root).initialize(), t);
    const call = async args => {
      const r = await tools.get('execute_command')({ waitMs: 0, maxBytes: 65536, ...args });
      assert(!r.isError, JSON.stringify(r)); return r.structuredContent;
    };
    const initial = await call({ cwd: f.root, command: 'printf FIRST; while [ ! -f release ]; do sleep .01; done; printf LAST' });
    id = initial.sessionId;
    assert.equal(initial.status, 'running');
    // Force completion after the first state snapshot; the output helper
    // must then refresh within the final immutable command boundary.
    const status = t.commandStatus.bind(t); let armed = true;
    t.commandStatus = async (...args) => {
      const snapshot = await status(...args);
      if (armed) {
        armed = false; await writeFile(path.join(f.root, 'release'), '');
        for (let i = 0; i < 100; i++) {
          if (!['running', 'starting'].includes((await status(initial.sessionId, initial.commandId)).status)) break;
          await delay(10);
        }
      }
      return snapshot;
    };
    const final = await call({ sessionId: initial.sessionId, cursor: initial.nextCursor });
    assert.equal(final.status, 'succeeded'); assert.equal(final.outputTruncated, false);
    assert.match(initial.stdout + final.stdout, /FIRSTLAST/);
    assert.equal(final.nextCursor, final.outputEndCursor);
    const exited = await call({ sessionId: initial.sessionId, command: 'printf BEFORE_EXIT; exit 3', waitMs: 2000 });
    assert.equal(exited.status, 'terminal_closed'); assert.equal(exited.exitCode, 3);
    assert.match(exited.stdout, /BEFORE_EXIT/);
  } finally { if (id) await t.close(id); await t.run(['kill-server']).catch(() => {}); await f.cleanup(); }
});

test('default file chunks respect the chunk ceiling with a larger direct budget', async () => {
  const f = await fixture();
  try {
    const config = loadConfig({ env: { MCP_WORKSPACE_ROOT: f.root, MCP_DIRECT_FILE_MAX_BYTES: '4194304' } }).config;
    const tools = callbacks(await new Workspace(f.root).initialize(), null, config.files.directMaxBytes);
    const data = Buffer.alloc(5 * 1024 * 1024, 19), file = path.join(f.root, 'large.bin');
    await writeFile(file, data);
    let offset = 0; const chunks = [];
    do {
      const r = await tools.get('get_file')({ path: file, offset });
      assert(!r.isError, JSON.stringify(r));
      assert(r.structuredContent.bytes <= 1048576);
      chunks.push(Buffer.from(r.content[1].resource.blob, 'base64'));
      assert(r.structuredContent.nextOffset > offset); offset = r.structuredContent.nextOffset;
      if (r.structuredContent.eof) break;
    } while (offset < data.length);
    assert.deepEqual(Buffer.concat(chunks), data);
  } finally { await f.cleanup(); }
});
