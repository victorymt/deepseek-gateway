import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { loadGatewayConfig, parseGatewayArgs } from '../gateway-config.mjs';
import { GATEWAY, ROOT, multiProviderConfig } from './helpers/gateway-harness.mjs';

function tempConfig(content) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-config-kernel-'));
  const configPath = path.join(directory, 'keys.json');
  fs.writeFileSync(configPath, content);
  return { directory, configPath };
}

test('gateway config applies CLI overrides after environment overrides', () => {
  const { directory, configPath } = tempConfig(JSON.stringify(multiProviderConfig()));
  try {
    const opts = parseGatewayArgs([
      '--config', configPath,
      '--port', '9123',
      '--cooldown-ms', '4567',
    ]);
    const config = loadGatewayConfig(opts, {
      DS_GATEWAY_PORT: '8123',
      DS_COOLDOWN_MS: '1234',
    });
    assert.equal(config.port, 9123);
    assert.equal(config.cooldownMs, 4567);
    assert.equal(config._scalarOverrides.port, '--port');
    assert.equal(config._scalarOverrides.cooldownMs, '--cooldown-ms');
    assert.equal(config.configPath, configPath);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('bad JSON is catchable and never exits the importing process', () => {
  const { directory, configPath } = tempConfig('{not-json');
  const originalExit = process.exit;
  let exitCalled = false;
  process.exit = () => {
    exitCalled = true;
    throw new Error('process.exit must not be called');
  };
  try {
    assert.throws(
      () => loadGatewayConfig({ config: configPath }, {}),
      error => (
        error.code === 'CONFIG_READ_ERROR'
        && error.configPath === configPath
        && error.message.startsWith(`failed to read config ${configPath}:`)
      ),
    );
    assert.equal(exitCalled, false);
  } finally {
    process.exit = originalExit;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('gateway CLI preserves config read error text and exit status', () => {
  const { directory, configPath } = tempConfig('{not-json');
  try {
    const result = spawnSync(process.execPath, [GATEWAY, '--config', configPath], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, new RegExp(`^failed to read config ${configPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:`));
    assert.doesNotMatch(result.stderr, /^ERROR:/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
