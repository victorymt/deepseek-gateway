'use strict';

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const LOCK_FD = 3;

function lockError(file, label, detail) {
  return Object.assign(
    new Error(`cannot acquire ${label} lock: ${file}: ${detail}`),
    { statusCode: 503 },
  );
}

/**
 * Serialize a synchronous operation across processes with an advisory lock.
 *
 * The util-linux `flock` helper locks the same open file description inherited
 * from this process. The helper exits after acquiring the lock, while our file
 * descriptor keeps it held until operation() finishes. The kernel releases the
 * lock on process exit, so stale-lock takeover and lock-file replacement are
 * unnecessary. The lock file intentionally remains in place: unlinking it can
 * split waiters across different inodes and break mutual exclusion.
 */
export function withFileLock(file, operation, {
  timeoutMs = 5000,
  label = 'file',
} = {}) {
  let fd = null;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fd = fs.openSync(
      file,
      fs.constants.O_CREAT | fs.constants.O_RDWR | fs.constants.O_NOFOLLOW,
      0o600,
    );
    fs.fchmodSync(fd, 0o600);

    const timeoutSec = Math.max(0, Number(timeoutMs) || 0) / 1000;
    const result = spawnSync(
      'flock',
      ['--exclusive', '--timeout', String(timeoutSec), String(LOCK_FD)],
      { stdio: ['ignore', 'ignore', 'pipe', fd], encoding: 'utf8' },
    );

    if (result.error) {
      throw lockError(file, label, `flock failed: ${result.error.message}`);
    }
    if (result.status !== 0) {
      const detail = String(result.stderr || '').trim();
      throw lockError(
        file,
        label,
        detail || (result.signal
          ? `flock terminated by ${result.signal}`
          : `timed out after ${timeoutMs}ms`),
      );
    }
  } catch (error) {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch {}
      fd = null;
    }
    if (error?.statusCode === 503) throw error;
    throw lockError(file, label, error?.message || String(error));
  }

  try {
    return operation();
  } finally {
    try { fs.closeSync(fd); } catch {}
  }
}
