import { constants } from 'node:fs';
import { open } from 'node:fs/promises';

/** Read one ordinary, unlinked file of at most `maximum` bytes as exact UTF-8 text; null when absent.
 * `fail` raises the caller's protocol error and `what` names the artifact in its message. */
export async function readBounded(path: string, maximum: number, fail: (text: string) => never, what: string): Promise<string | null> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch((e: NodeJS.ErrnoException) => { if (e.code !== 'ENOENT') throw e; return null; });
  if (!file) return null;
  try {
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > maximum) fail(`${what} must be a bounded ordinary file.`);
    const bytes = Buffer.alloc(maximum + 1); let length = 0;
    while (length < bytes.length) { const { bytesRead } = await file.read(bytes, length, bytes.length - length, length); if (!bytesRead) break; length += bytesRead; }
    if (length > maximum) fail(`${what} exceeded its size limit.`);
    // Preserve a UTF-8 BOM as content: hashes identify exact bytes, not normalized text.
    try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, length)); }
    catch { return fail(`${what} must be valid UTF-8.`); }
  } finally { await file.close(); }
}
