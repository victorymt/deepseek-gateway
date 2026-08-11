import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  claimGatewayRuntime,
  readGatewayRuntime,
  releaseGatewayRuntime,
  updateGatewayRuntime,
} from '../gateway-runtime.mjs';

test('managed runtime records are private, exclusive, updateable, and releasable', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-runtime-'));
  const configPath = path.join(directory, 'keys.json');
  const env = { XDG_RUNTIME_DIR: path.join(directory, 'runtime') };
  fs.writeFileSync(configPath, '{}');

  let handle;
  try {
    handle = claimGatewayRuntime({
      configPath,
      instanceId: 'runtime-instance-0001',
      host: '127.0.0.1',
      port: 0,
      startedAt: Date.now(),
    }, env);

    assert.equal(fs.statSync(path.dirname(handle.filePath)).mode & 0o777, 0o700);
    assert.equal(fs.statSync(handle.filePath).mode & 0o777, 0o600);
    assert.equal(readGatewayRuntime(configPath, env).record.instanceId, 'runtime-instance-0001');
    assert.throws(
      () => claimGatewayRuntime({
        configPath,
        instanceId: 'runtime-instance-0002',
        host: '127.0.0.1',
        port: 8787,
      }, env),
      /already running/,
    );

    handle = updateGatewayRuntime(handle, { host: '0.0.0.0', port: 9123 });
    assert.deepEqual(
      {
        host: readGatewayRuntime(configPath, env).record.host,
        port: readGatewayRuntime(configPath, env).record.port,
      },
      { host: '0.0.0.0', port: 9123 },
    );
    assert.equal(releaseGatewayRuntime(handle), true);
    assert.equal(readGatewayRuntime(configPath, env), null);
  } finally {
    releaseGatewayRuntime(handle);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
