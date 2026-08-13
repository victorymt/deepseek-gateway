'use strict';

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Lock files carry a unique token (`<pid>.<startedAt>.<nonce>`) so takeover
 * and release can be identity-checked.
 *
 * Stale takeover is inherently racy on plain POSIX files: there is no atomic
 * "remove only if token matches" operation, so a takeover that renames the
 * occupant aside can race a third process that creates a new lock in the
 * brief gap. We minimize that window to the practical floor:
 *
 * - staleness is decided by the OWNER PID (fact, via kill(pid, 0)) instead of
 *   mtime heuristics, and the token is read BEFORE the staleness decision, so
 *   a lock replaced between our checks is never mistaken for the stale one;
 * - the moved occupant is verified against the token we observed, and on
 *   mismatch the fresh lock is restored instead of discarded;
 * - release only unlinks when the file still carries our token.
 *
 * The remaining theoretical window (three processes racing within the rename
 * gap, causing a brief double entry) is documented in takeStaleLock below.
 */
function readLockToken(file) {
  try {
    return fs.readFileSync(file, 'utf8').trim() || null;
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function lockOwnerPid(token) {
  const match = /^(\d+)\./.exec(String(token || ''));
  return match ? Number(match[1]) : NaN;
}

/**
 * @returns true when the lock owner process is alive, false when it is
 * confirmed dead (ESRCH), or null when the token carries no usable pid
 * (legacy/empty lock files).
 */
function ownerAlive(token) {
  const pid = lockOwnerPid(token);
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    if (error?.code === 'EPERM') return true;
    return null;
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
 *   staleness check and the rename; the fresh lock is restored to `file`
 *   (unless yet another process created a lock there first — in that
 *   sub-millisecond window the moved lock is discarded and both new owners
 *   may briefly overlap, which plain-fs takeover cannot fully prevent).
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
 * - A lock whose owner process is dead is taken over immediately (verified
 *   rename protocol); a lock with an unparseable legacy token is taken over
 *   once its mtime is older than `staleMs`; a lock held by a live process is
 *   waited on up to `timeoutMs`.
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
      // Read the occupant's identity BEFORE judging staleness: a lock that is
      // replaced between our checks must never be taken over as "stale".
      const observed = readLockToken(file);
      if (observed === null) continue; // lock vanished; retry creation
      const alive = ownerAlive(observed);
      const staleByMtime = Date.now() - fs.statSync(file).mtimeMs > staleMs;
      if (alive === true || (alive === null && !staleByMtime)) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, waitMs);
        continue;
      }
      // Owner confirmed dead (alive === false) or legacy lock older than
      // staleMs: attempt the verified takeover.
      const quarantine = `${file}.stale-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
      takeStaleLock(file, quarantine, observed);
      continue; // 'taken'/'gone': path free, retry creation; 'replaced': restored, keep waiting
    }
  }
  try {
    return operation();
  } finally {
    try { fs.closeSync(fd); } catch {}
    releaseLock(file, token);
  }
}
