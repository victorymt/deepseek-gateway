'use strict';

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Lock files carry a unique token so takeover and release can be
 * identity-checked. A plain "stat then unlink" stale takeover is unsafe: the
 * lock may be replaced by another process between the two calls, and the
 * takeover would delete a fresh lock. Instead the occupant is atomically
 * renamed aside and its token verified before anything is discarded.
 */
function readLockToken(file) {
  try {
    return fs.readFileSync(file, 'utf8').trim() || null;
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * Attempt to take over a stale lock. Atomically moves whatever occupies
 * `file` to `quarantine`, then checks the moved content against the token we
 * observed as stale:
 *
 * - token matches: the stale lock is discarded and the takeover succeeded
 *   (the caller then creates its own lock).
 * - token mismatch: the lock was replaced by another process between our
 *   stale check and the rename; the fresh lock is restored to `file` (unless
 *   yet another process created a lock there first, in which case the moved
 *   one is discarded) and the takeover is abandoned.
 *
 * Returns `{ taken: boolean, reason: 'taken' | 'gone' | 'replaced' }`.
 */
export function takeStaleLock(file, quarantine, observedToken) {
  try {
    fs.renameSync(file, quarantine);
  } catch (error) {
    if (error?.code === 'ENOENT') return { taken: false, reason: 'gone' };
    throw error;
  }
  const moved = readLockToken(quarantine);
  if (moved !== observedToken) {
    try {
      if (!fs.existsSync(file)) fs.renameSync(quarantine, file);
      else fs.unlinkSync(quarantine);
    } catch {}
    return { taken: false, reason: 'replaced' };
  }
  try {
    fs.unlinkSync(quarantine);
  } catch {}
  return { taken: true };
}

function releaseLock(file, token) {
  try {
    if (readLockToken(file) === token) fs.unlinkSync(file);
  } catch {}
}

/**
 * Serialize a read-modify-write section across processes with a lock file.
 *
 * - Creates `<file>` with `O_EXCL` (0600), writes a unique token into it and
 *   holds the descriptor for the duration of `operation()`, then releases it
 *   in `finally` (only unlinking if the file still carries our token).
 * - A lock whose mtime is older than `staleMs` is considered abandoned and is
 *   taken over through the verified rename protocol; otherwise the caller
 *   waits up to `timeoutMs`.
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
  const token = `${process.pid}.${Date.now()}.${crypto.randomBytes(6).toString('hex')}`;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  let fd = null;
  for (;;) {
    try {
      fd = fs.openSync(file, 'wx', 0o600);
      fs.writeFileSync(fd, `${token}\n`);
      fs.closeSync(fd);
      break;
    } catch (error) {
      if (error?.code !== 'EEXIST' || Date.now() >= deadline) {
        throw Object.assign(
          new Error(`cannot acquire ${label} lock: ${file}: ${error.message}`),
          { statusCode: 503 },
        );
      }
      let stale = false;
      try {
        stale = Date.now() - fs.statSync(file).mtimeMs > staleMs;
      } catch (statError) {
        if (statError?.code === 'ENOENT') continue; // lock vanished; retry creation
        throw statError;
      }
      if (stale) {
        const observed = readLockToken(file);
        const quarantine = `${file}.stale-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
        const result = takeStaleLock(file, quarantine, observed);
        if (result.reason === 'replaced') continue; // fresh lock restored; keep waiting
        // 'taken' or 'gone': the path is free again — retry creation.
        continue;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, waitMs);
    }
  }
  try {
    return operation();
  } finally {
    try { fs.closeSync(fd); } catch {}
    releaseLock(file, token);
  }
}
