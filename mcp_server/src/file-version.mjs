import { createHash } from 'node:crypto';
import { OperationError } from './runtime.mjs';
export function fileVersion(info) {
  return createHash('sha256').update([info.dev, info.ino, info.size, info.mtimeNs ?? info.mtimeMs, info.ctimeNs ?? info.ctimeMs].join(':')).digest('hex');
}
export function checkFileVersion(info, expected) {
  const version = fileVersion(info);
  if (expected !== undefined && version !== expected) throw new OperationError('file changed during transfer; restart from offset=0 on a stable artifact', 'file_changed');
  return version;
}
