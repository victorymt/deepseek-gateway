'use strict';

import fs from 'node:fs';
import path from 'node:path';

/**
 * Serialize a read-modify-write section across processes with a lock file.
 *
 * - Creates `<file>` with `O_EXCL` (0600) and holds it open for the duration
 *   of `operation()`, then releases it in `finally`.
 * - A lock whose mtime is older than `staleMs` is considered abandoned and is
 *   stolen; otherwise the caller waits up to `timeoutMs`.
 * - Throws a 503 error on timeout so callers can surface a clear message
 *   instead of silently proceeding without mutual exclusion.
 */
export function withFileLock(file, operation, {
  timeoutMs = 5000,
  staleMs = 30000,
  waitMs = 5,
  label = 'file',
} = {}) {
  const deadline = Date.now() + timeoutMs;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  let fd = null;
  for (;;) {
    try {
      fd = fs.openSync(file, 'wx', 0o600);
      break;
    } catch (error) {
      if (error?.code !== 'EEXIST' || Date.now() >= deadline) {
        throw Object.assign(
          new Error(`cannot acquire ${label} lock: ${file}: ${error.message}`),
          { statusCode: 503 },
        );
      }
      try {
        if (Date.now() - fs.statSync(file).mtimeMs > staleMs) fs.unlinkSync(file);
      } catch {}
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, waitMs);
    }
  }
  try {
    return operation();
  } finally {
    try { fs.closeSync(fd); } catch {}
    try { fs.unlinkSync(file); } catch {}
  }
}
