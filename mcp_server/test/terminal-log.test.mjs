import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { finished } from 'node:stream/promises';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { TerminalLogWriter } from '../src/terminal-log.mjs';
import { readLog } from '../src/log-store.mjs';
import { fixture } from './helpers.mjs';

test('PTY completion markers acknowledge written bytes across splits and rotation', async () => {
  const f = await fixture(), token = randomUUID(), id = `cmd_${randomUUID()}`;
  const file = path.join(f.root, 'terminal.log');
  const writer = new TerminalLogWriter(file, { segmentBytes: 1024 }, token);
  const done = finished(writer);
  const write = data => new Promise((resolve, reject) => writer.write(data, error => error ? reject(error) : resolve()));
  try {
    await mkdir(path.join(f.root, 'commands'));
    const original = Buffer.from('中'.repeat(700) + '\x1b[31mEND\x1b[0m');
    const marker = Buffer.from(`\x1b]777;${token};${id}.result.json;7\x07`);
    await write(original);
    // Split every byte, including the OSC prefix and terminator.
    for (const byte of marker.subarray(0, -1)) await write(Buffer.from([byte]));
    const resultFile = path.join(f.root, 'commands', `${id}.result.json`);
    await assert.rejects(readFile(resultFile), { code: 'ENOENT' });
    await write(marker.subarray(-1));
    assert.deepEqual(JSON.parse(await readFile(resultFile, 'utf8')), { exitCode: 7, outputEndCursor: original.length });
    assert.equal((await readLog(file, { cursor: 0, segmentBytes: 1024 })).content, original.toString());
    const suffix = `\x1b]777;unrelated;output\x07\x1b]777;${token};incomplete`;
    writer.end(suffix); await done;
    assert.equal((await readLog(file, { cursor: 0, segmentBytes: 1024, final: true })).content, original.toString() + suffix);
    assert.equal(JSON.parse(await readFile(path.join(f.root, 'log-drained.json'), 'utf8')).outputEndCursor, original.length + Buffer.byteLength(suffix));
  } finally { writer.destroy(); await done.catch(() => {}); await f.cleanup(); }
});

test('a draining logger does not recreate a removed terminal history', async () => {
  const f = await fixture(), file = path.join(f.root, 'terminal', 'terminal.log');
  const writer = new TerminalLogWriter(file, {}, randomUUID()), done = finished(writer);
  try {
    await new Promise((resolve, reject) => writer.write('output', error => error ? reject(error) : resolve()));
    await rm(path.dirname(file), { recursive: true });
    writer.end(); await done;
    await assert.rejects(readFile(path.join(path.dirname(file), 'log-drained.json')), { code: 'ENOENT' });
  } finally { writer.destroy(); await done.catch(() => {}); await f.cleanup(); }
});
