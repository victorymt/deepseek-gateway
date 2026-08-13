import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { takeStaleLock, withFileLock } from '../file-lock.mjs';

function lockFixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dsgw-lock-'));
  const lock = path.join(directory, 'lock');
  const quarantine = path.join(directory, 'quarantine');
  return { directory, lock, quarantine };
}

function makeStale(file) {
  const old = new Date(Date.now() - 60 * 1000);
  fs.utimesSync(file, old, old);
}

test('stale lock takeover restores a concurrently replaced lock', () => {
  const { directory, lock, quarantine } = lockFixture();
  try {
    // The takeover observed a stale token, but by the time it renames the
    // occupant aside, another process has replaced it with a fresh lock.
    fs.writeFileSync(lock, 'fresh-token\n');
    const result = takeStaleLock(lock, quarantine, 'stale-token');
    assert.equal(result.taken, false);
    assert.equal(result.reason, 'replaced');
    // The fresh lock survives at the canonical path; nothing was deleted.
    assert.equal(fs.readFileSync(lock, 'utf8').trim(), 'fresh-token');
    assert.equal(fs.existsSync(quarantine), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('stale lock takeover discards a confirmed-stale lock', () => {
  const { directory, lock, quarantine } = lockFixture();
  try {
    fs.writeFileSync(lock, 'stale-token\n');
    const result = takeStaleLock(lock, quarantine, 'stale-token');
    assert.equal(result.taken, true);
    assert.equal(fs.existsSync(lock), false);
    assert.equal(fs.existsSync(quarantine), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('stale lock takeover reports a lock that vanished concurrently', () => {
  const { directory, lock, quarantine } = lockFixture();
  try {
    const result = takeStaleLock(lock, quarantine, 'stale-token');
    assert.equal(result.taken, false);
    assert.equal(result.reason, 'gone');
    assert.equal(fs.existsSync(lock), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('withFileLock never deletes a lock it does not own', () => {
  const { directory, lock } = lockFixture();
  try {
    fs.writeFileSync(lock, 'foreign-token\n');
    let ran = false;
    assert.throws(
      () => withFileLock(lock, () => { ran = true; }, {
        timeoutMs: 60,
        staleMs: 30000,
        waitMs: 1,
        label: 'test',
      }),
      error => error.statusCode === 503 && /cannot acquire test lock/.test(error.message),
    );
    assert.equal(ran, false);
    assert.equal(fs.readFileSync(lock, 'utf8').trim(), 'foreign-token');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('withFileLock steals a stale lock and leaves no residue', () => {
  const { directory, lock } = lockFixture();
  try {
    fs.writeFileSync(lock, 'old-stale-owner\n');
    makeStale(lock);
    let ran = false;
    withFileLock(lock, () => { ran = true; }, { timeoutMs: 1000, label: 'test' });
    assert.equal(ran, true);
    assert.equal(fs.existsSync(lock), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
