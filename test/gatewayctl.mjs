import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { commandInvocation } from '../gatewayctl.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GATEWAYCTL = path.join(ROOT, 'gatewayctl');
const CONFIGURE = path.join(ROOT, 'configure.py');

function validConfig(overrides = {}) {
  return {
    schemaVersion: 2,
    port: 0,
    host: '127.0.0.1',
    defaultProvider: 'deepseek',
    defaultModel: 'deepseek--chat',
    providers: [{
      id: 'deepseek',
      name: 'DeepSeek',
      baseUrl: 'https://api.deepseek.com',
      enabled: true,
      models: [{ id: 'chat', name: 'Chat', upstreamModel: 'deepseek-chat' }],
      keys: [{ name: 'primary', key: 'sk-test', weight: 1 }],
    }],
    ...overrides,
  };
}

test('gatewayctl forwards init, start, and codex arguments', () => {
  const env = { DS_GATEWAY_CONFIG: '/tmp/from-env.json', PATH: process.env.PATH };
  const init = commandInvocation('init', ['--no-ui'], env);
  assert.equal(init.executable, 'python3');
  assert.ok(init.args[0].endsWith('/configure_wizard.py'));
  assert.equal(init.args[1], '--no-ui');

  const start = commandInvocation('start', ['--quiet'], env);
  assert.deepEqual(start.args.slice(-3), ['--config', '/tmp/from-env.json', '--quiet']);
  assert.ok(start.args[0].endsWith('/gateway.mjs'));

  const explicitStart = commandInvocation('start', ['--config', '/tmp/explicit.json', '--mock'], env);
  assert.deepEqual(explicitStart.args.slice(-3), ['--config', '/tmp/explicit.json', '--mock']);

  const codex = commandInvocation('codex', ['--config', '/tmp/codex.json', '--dry-run'], env);
  assert.deepEqual(codex.args, ['--dry-run']);
  assert.equal(codex.env.GATEWAY_CONFIG, '/tmp/codex.json');
});

test('gatewayctl validates config and doctor accepts an offline gateway', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gatewayctl-'));
  const configPath = path.join(directory, 'keys.json');
  fs.writeFileSync(configPath, JSON.stringify(validConfig()));
  try {
    const validate = spawnSync(GATEWAYCTL, ['validate', '--config', configPath], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    assert.equal(validate.status, 0, validate.stderr);
    assert.match(validate.stdout, /配置有效/);

    const doctor = spawnSync(GATEWAYCTL, ['doctor', '--config', configPath], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    assert.equal(doctor.status, 0, doctor.stderr);
    assert.match(doctor.stdout, /doctor 完成/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('configure.py remains a compatible gatewayctl init entry point', () => {
  const result = spawnSync(CONFIGURE, ['--help'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /交互式配置 deepseek-gateway/);
  assert.match(result.stdout, /--no-ui/);
});
