import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { withFileLock } from '../file-lock.mjs';

const worker = fileURLToPath(new URL('./fixtures/file-lock-worker.mjs', import.meta.url));

function lockFixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dsgw-lock-'));
  return {
    directory,
    lock: path.join(directory, 'lock'),
    counter: path.join(directory, 'counter'),
  };
}

function startWorker(args) {
  return spawn(process.execPath, [worker, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function waitForLine(child, expected) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      stdout += chunk;
      if (stdout.split(/\r?\n/).includes(expected)) resolve();
    });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', code => {
      if (!stdout.split(/\r?\n/).includes(expected)) {
        reject(new Error(`worker exited ${code}: ${stderr || stdout}`));
      }
    });
  });
}

function waitForExit(child) {
  return new Promise((resolve, reject) => {
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', code => {
      if (code === 0) resolve();
      else reject(new Error(`worker exited ${code}: ${stderr}`));
    });
  });
}

test('withFileLock times out while another process holds the lock', async () => {
  const { directory, lock } = lockFixture();
  const child = startWorker(['hold', lock, '250']);
  try {
    await waitForLine(child, 'locked');
    assert.throws(
      () => withFileLock(lock, () => {}, { timeoutMs: 25, label: 'test' }),
      error => error.statusCode === 503 && /timed out/.test(error.message),
    );
    await waitForExit(child);
    let ran = false;
    withFileLock(lock, () => { ran = true; }, { timeoutMs: 1000, label: 'test' });
    assert.equal(ran, true);
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('withFileLock is mutually exclusive across concurrent processes', async () => {
  const { directory, lock, counter } = lockFixture();
  fs.writeFileSync(counter, '0\n');
  try {
    const children = Array.from({ length: 12 }, () => (
      startWorker(['increment', lock, counter])
    ));
    await Promise.all(children.map(waitForExit));
    assert.equal(Number(fs.readFileSync(counter, 'utf8')), children.length);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('kernel releases the lock when its owning process exits', async () => {
  const { directory, lock } = lockFixture();
  const child = startWorker(['hold', lock, '30000']);
  try {
    await waitForLine(child, 'locked');
    child.kill('SIGKILL');
    await new Promise(resolve => child.once('exit', resolve));
    let ran = false;
    withFileLock(lock, () => { ran = true; }, { timeoutMs: 1000, label: 'test' });
    assert.equal(ran, true);
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('withFileLock closes a partially acquired descriptor on setup failure', () => {
  const { directory, lock } = lockFixture();
  const original = fs.fchmodSync;
  try {
    fs.fchmodSync = () => { throw Object.assign(new Error('simulated failure'), { code: 'EIO' }); };
    assert.throws(
      () => withFileLock(lock, () => {}, { label: 'test' }),
      error => error.statusCode === 503 && /simulated failure/.test(error.message),
    );
    fs.fchmodSync = original;
    let ran = false;
    withFileLock(lock, () => { ran = true; }, { timeoutMs: 1000, label: 'test' });
    assert.equal(ran, true);
  } finally {
    fs.fchmodSync = original;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('withFileLock preserves operation errors and releases the lock', () => {
  const { directory, lock } = lockFixture();
  const expected = new Error('operation failed');
  try {
    assert.throws(
      () => withFileLock(lock, () => { throw expected; }, { label: 'test' }),
      error => error === expected,
    );
    let ran = false;
    withFileLock(lock, () => { ran = true; }, { timeoutMs: 1000, label: 'test' });
    assert.equal(ran, true);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('withFileLock rejects symlink lock paths', () => {
  const { directory, lock } = lockFixture();
  const target = path.join(directory, 'target');
  try {
    fs.writeFileSync(target, 'do not lock through this path\n');
    fs.symlinkSync(target, lock);
    assert.throws(
      () => withFileLock(lock, () => {}, { label: 'test' }),
      error => error.statusCode === 503 && /cannot acquire test lock/.test(error.message),
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
