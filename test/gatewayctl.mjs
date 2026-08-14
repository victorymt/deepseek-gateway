import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { commandInvocation } from '../gatewayctl.mjs';
import {
  gatewayProcessIsRunning,
  gatewayRuntimeRecordPath,
  readGatewayRuntime,
  releaseGatewayRuntime,
} from '../gateway-runtime.mjs';

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

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function waitFor(check, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      if (await check()) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw lastError || new Error(`condition not met within ${timeoutMs}ms`);
}

function gatewayHealthy(port, token = '') {
  return new Promise(resolve => {
    const request = http.get(`http://127.0.0.1:${port}/health`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    }, response => {
      response.resume();
      resolve(response.statusCode === 200);
    });
    request.setTimeout(200, () => request.destroy());
    request.on('error', () => resolve(false));
  });
}

function childExit(child, timeoutMs = 5000) {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('child did not exit')), timeoutMs);
    child.once('exit', code => {
      clearTimeout(timer);
      resolve(code);
    });
  });
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
  assert.equal(start.env.DS_GATEWAY_MANAGED, '1');

  const explicitStart = commandInvocation('start', ['--config', '/tmp/explicit.json', '--mock'], env);
  assert.deepEqual(explicitStart.args.slice(-3), ['--config', '/tmp/explicit.json', '--mock']);

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gatewayctl-codex-'));
  const codexPath = path.join(directory, 'codex.json');
  fs.writeFileSync(codexPath, JSON.stringify(validConfig({ port: 9123 })));
  try {
    const codex = commandInvocation('codex', ['--config', codexPath, '--auth', 'required', '--dry-run'], env);
    assert.deepEqual(codex.args, ['--auth', 'required', '--dry-run']);
    assert.equal(codex.env.GATEWAY_CONFIG, codexPath);
    assert.equal(codex.env.GATEWAY_URL, 'http://127.0.0.1:9123');

    const overridden = commandInvocation('codex', ['--config', codexPath], {
      ...env,
      GATEWAY_URL: 'https://gateway.example',
    });
    assert.equal(overridden.env.GATEWAY_URL, 'https://gateway.example');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('gatewayctl stop gracefully terminates a managed gateway and is idempotent', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gatewayctl-stop-'));
  const configPath = path.join(directory, 'keys.json');
  const port = await freePort();
  const env = {
    ...process.env,
    XDG_RUNTIME_DIR: path.join(directory, 'runtime'),
    // isolate the spawned gateway's native Codex agent sync from the real ~/.codex
    CODEX_HOME: path.join(directory, 'codex-home'),
  };
  const token = 'gateway-stop-token-123456';
  fs.writeFileSync(configPath, JSON.stringify(validConfig({
    port,
    token,
    adminToken: 'gateway-admin-token-123456',
  })));
  const child = spawn(GATEWAYCTL, ['start', '--config', configPath, '--quiet', '--mock'], {
    cwd: ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });

  try {
    try {
      await waitFor(async () => readGatewayRuntime(configPath, env) && await gatewayHealthy(port, token));
    } catch (error) {
      throw new Error(`${error.message}${stderr ? `: ${stderr}` : ''}`);
    }
    const handle = readGatewayRuntime(configPath, env);
    assert.equal(handle.record.port, port);
    assert.equal(gatewayProcessIsRunning(handle.record.pid), true);

    const stopped = spawnSync(GATEWAYCTL, ['stop', '--config', configPath], {
      cwd: ROOT,
      env,
      encoding: 'utf8',
    });
    assert.equal(stopped.status, 0, stopped.stderr);
    assert.match(stopped.stdout, /网关已停止/);
    assert.equal(await childExit(child), 0, stderr);
    assert.equal(readGatewayRuntime(configPath, env), null);

    const repeated = spawnSync(GATEWAYCTL, ['stop', '--config', configPath], {
      cwd: ROOT,
      env,
      encoding: 'utf8',
    });
    assert.equal(repeated.status, 0, repeated.stderr);
    assert.match(repeated.stdout, /网关未运行/);
  } finally {
    const handle = readGatewayRuntime(configPath, env);
    if (handle && gatewayProcessIsRunning(handle.record.pid)) {
      process.kill(handle.record.pid, 'SIGKILL');
    }
    releaseGatewayRuntime(handle);
    if (child.exitCode === null) child.kill('SIGKILL');
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('gatewayctl stop refuses an identity mismatch and later cleans its stale record', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gatewayctl-stop-safety-'));
  const configPath = path.join(directory, 'keys.json');
  const port = await freePort();
  const env = {
    ...process.env,
    XDG_RUNTIME_DIR: path.join(directory, 'runtime'),
  };
  fs.writeFileSync(configPath, JSON.stringify(validConfig({ port })));

  const fake = spawn(process.execPath, [
    '-e',
    `require('http').createServer((req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({status:'ok',instanceId:'different-instance-0001',providers:[]}));}).listen(${port},'127.0.0.1')`,
  ], { stdio: 'ignore' });

  const recordPath = gatewayRuntimeRecordPath(configPath, env);
  fs.mkdirSync(path.dirname(recordPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(recordPath, `${JSON.stringify({
    schemaVersion: 1,
    pid: fake.pid,
    instanceId: 'recorded-instance-0001',
    configPath: fs.realpathSync(configPath),
    host: '127.0.0.1',
    port,
    startedAt: Date.now(),
  })}\n`, { mode: 0o600 });

  try {
    await waitFor(() => gatewayHealthy(port));
    const refused = spawnSync(GATEWAYCTL, ['stop', '--config', configPath], {
      cwd: ROOT,
      env,
      encoding: 'utf8',
    });
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /runtime identity does not match/);
    assert.equal(gatewayProcessIsRunning(fake.pid), true);

    fake.kill('SIGTERM');
    await childExit(fake);
    const stale = spawnSync(GATEWAYCTL, ['stop', '--config', configPath], {
      cwd: ROOT,
      env,
      encoding: 'utf8',
    });
    assert.equal(stale.status, 0, stale.stderr);
    assert.match(stale.stdout, /已清理过期运行记录/);
    assert.equal(readGatewayRuntime(configPath, env), null);
  } finally {
    if (gatewayProcessIsRunning(fake.pid)) fake.kill('SIGKILL');
    const handle = readGatewayRuntime(configPath, env);
    releaseGatewayRuntime(handle);
    fs.rmSync(directory, { recursive: true, force: true });
  }
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
    assert.match(doctor.stdout, /flock/);
    assert.match(doctor.stdout, /doctor 完成/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('gatewayctl codex rejects an explicitly missing config', () => {
  const missing = path.join(os.tmpdir(), `missing-gateway-${process.pid}.json`);
  const result = spawnSync(GATEWAYCTL, ['codex', '--config', missing, '--dry-run'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /cannot read config/);
});

test('gatewayctl validate and doctor recognize setup-pending config', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gatewayctl-setup-'));
  const configPath = path.join(directory, 'keys.json');
  fs.writeFileSync(configPath, JSON.stringify({
    schemaVersion: 2,
    setupPending: true,
    port: 0,
    host: '127.0.0.1',
    defaultProvider: '',
    defaultModel: '',
    providers: [],
  }));
  try {
    const validate = spawnSync(GATEWAYCTL, ['validate', '--config', configPath], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    assert.equal(validate.status, 0, validate.stderr);
    assert.match(validate.stdout, /引导配置有效/);

    const doctor = spawnSync(GATEWAYCTL, ['doctor', '--config', configPath], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    assert.equal(doctor.status, 0, doctor.stderr);
    assert.match(doctor.stdout, /等待通过 Web UI/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('configure.py remains a compatible gatewayctl init entry point', () => {
  const result = spawnSync(CONFIGURE, ['--help'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /交互式配置 deepseek-gateway/);
  assert.match(result.stdout, /--no-ui/);
  assert.match(result.stdout, /--cli-provider/);
});
