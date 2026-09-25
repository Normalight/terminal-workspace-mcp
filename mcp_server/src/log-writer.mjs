import { pipeline } from "node:stream/promises";
import { LogWriter } from "./log-store.mjs";
const [file, segmentBytes, maxSegments] = process.argv.slice(2);
await pipeline(process.stdin, new LogWriter(file, { segmentBytes: Number(segmentBytes), maxSegments: Number(maxSegments) }));
