import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { LogWriter } from './log-store.mjs';
import { TerminalLogWriter } from './terminal-log.mjs';
import { atomicJson, processIdentity } from './runtime.mjs';
const [file, segmentBytes, maxSegments, token] = process.argv.slice(2);
const options = { segmentBytes: Number(segmentBytes), maxSegments: Number(maxSegments) };
const health = token ? path.join(path.dirname(file), 'logger.json') : null;
const record = { pid: process.pid, identity: await processIdentity(process.pid) };
const save = async status => { if (health) await atomicJson(health, { ...record, status }, { createParents: false }).catch(e => { if (e.code !== 'ENOENT') throw e; }); };
try {
  await save('running');
  await pipeline(process.stdin, token ? new TerminalLogWriter(file, options, token) : new LogWriter(file, options));
  await save('stopped');
} catch (error) {
  await save('failed').catch(() => {});
  throw error;
}
