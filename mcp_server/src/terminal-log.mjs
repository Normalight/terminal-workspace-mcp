import path from 'node:path';
import { atomicJson } from './runtime.mjs';
import { LogWriter } from './log-store.mjs';

// The prompt's private OSC marker travels through the same PTY pipe as output.
// Publish completion only after all preceding bytes have reached the log.
export class TerminalLogWriter extends LogWriter {
  constructor(file, options, token) {
    super(file, options);
    this.directory = path.dirname(file);
    this.prefix = Buffer.from(`\x1b]777;${token};`);
    this.pending = Buffer.alloc(0);
  }
  get cursor() { return (this.index ?? 0) * this.segmentBytes + (this.bytes ?? 0); }
  async record(file, data) {
    try { await atomicJson(file, data, { createParents: false }); }
    catch (error) { if (error.code !== 'ENOENT') throw error; } // Removed histories stay removed.
  }
  async append(chunk) {
    this.pending = Buffer.concat([this.pending, chunk]);
    while (this.pending.length) {
      const start = this.pending.indexOf(this.prefix);
      if (start < 0) {
        let keep = Math.min(this.pending.length, this.prefix.length - 1);
        while (keep && !this.pending.subarray(-keep).equals(this.prefix.subarray(0, keep))) keep--;
        await super.append(this.pending.subarray(0, this.pending.length - keep));
        this.pending = this.pending.subarray(this.pending.length - keep);
        break;
      }
      if (start) {
        await super.append(this.pending.subarray(0, start));
        this.pending = this.pending.subarray(start);
      }
      const end = this.pending.indexOf(7, this.prefix.length);
      if (end < 0 && this.pending.length < this.prefix.length + 80) break;
      const match = end < 0 ? null : /^(cmd_[a-f0-9-]{36})\.result\.json;([0-9]{1,3})$/.exec(this.pending.subarray(this.prefix.length, end).toString());
      if (!match || Number(match[2]) > 255) {
        await super.append(this.pending.subarray(0, 1));
        this.pending = this.pending.subarray(1);
        continue;
      }
      await this.record(path.join(this.directory, 'commands', `${match[1]}.result.json`), {
        exitCode: Number(match[2]), outputEndCursor: this.cursor,
      });
      this.pending = this.pending.subarray(end + 1);
    }
  }
  _final(callback) {
    // An incomplete or unrelated escape sequence is ordinary original output.
    super.append(this.pending).then(() => {
      this.pending = Buffer.alloc(0);
      super._final(error => {
        if (error) return callback(error);
        this.record(path.join(this.directory, 'log-drained.json'), { outputEndCursor: this.cursor }).then(() => callback(), callback);
      });
    }, callback);
  }
}
