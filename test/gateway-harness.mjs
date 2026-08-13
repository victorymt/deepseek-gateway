import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { startGateway } from './helpers/gateway-harness.mjs';

test('startup failure reports stderr and removes its run directory', async () => {
  let runDir;
  await assert.rejects(
    () => startGateway('alice=sk-a-ok', ['--unknown-option'], {}, {}, {
      onRunDir: value => { runDir = value; },
    }),
    error => /gateway stderr:/.test(error.message) && /unknown option/.test(error.message),
  );
  assert.equal(fs.existsSync(runDir), false);
});

test('startup timeout terminates the child and removes temporary files', async () => {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-harness-fixture-'));
  const fixture = path.join(fixtureDir, 'hang.mjs');
  fs.writeFileSync(fixture, 'setInterval(() => {}, 1000);\n');
  let runDir;
  let child;
  try {
    await assert.rejects(
      () => startGateway('', [], {}, {}, {
        gateway: fixture,
        keysArg: false,
        startupTimeout: 25,
        onRunDir: value => { runDir = value; },
        onChild: value => { child = value; },
      }),
      /waitFor timeout/,
    );
    assert.notEqual(child.exitCode ?? child.signalCode, null);
    assert.equal(fs.existsSync(runDir), false);
  } finally {
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test('stop is repeatable after the child has already exited', async () => {
  const gateway = await startGateway('alice=sk-a-ok');
  gateway.child.kill('SIGKILL');
  await new Promise(resolve => gateway.child.once('exit', resolve));
  await gateway.stop();
  await gateway.stop();
  assert.equal(fs.existsSync(gateway.runDir), false);
});
