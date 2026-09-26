import { Console } from 'node:console';
import path from 'node:path';
import { finished } from 'node:stream/promises';
import { LogWriter } from './log-store.mjs';

export function serviceLogging(component, root) {
  if (process.env.MCP_ISOLATED_SERVICE !== '1') return async () => {};
  const streams = ['stdout', 'stderr'].map(name => new LogWriter(path.join(root, `${component}.${name}.log`), { segmentBytes: 8388608, maxSegments: 8 }));
  for (const stream of streams) stream.on('error', error => { process.stderr.write(`service logging failed: ${error.code ?? error.name}\n`); });
  globalThis.console = new Console({ stdout: streams[0], stderr: streams[1] });
  return async () => { for (const stream of streams) stream.end(); await Promise.all(streams.map(s => finished(s).catch(() => {}))); };
}
