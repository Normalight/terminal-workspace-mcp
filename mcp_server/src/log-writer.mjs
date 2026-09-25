import { pipeline } from "node:stream/promises";
import { LogWriter } from "./log-store.mjs";
import { TerminalLogWriter } from "./terminal-log.mjs";
const [file, segmentBytes, maxSegments, token] = process.argv.slice(2);
const options = { segmentBytes: Number(segmentBytes), maxSegments: Number(maxSegments) };
await pipeline(process.stdin, token ? new TerminalLogWriter(file, options, token) : new LogWriter(file, options));
