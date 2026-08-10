import { test } from 'node:test';
import assert from 'node:assert';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const GATEWAY = path.join(ROOT, 'gateway.mjs');
const CONFIGURE = path.join(ROOT, 'configure.py');

function freePort() {
  return new Promise(resolve => {
    const s = net.createServer();
    s.listen(0, () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
  });
}

test('reports an occupied listen port without an unhandled error stack', async () => {
  const blocker = net.createServer();
  await new Promise((resolve, reject) => {
    blocker.once('error', reject);
    blocker.listen(0, '127.0.0.1', resolve);
  });
  const port = blocker.address().port;
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-port-'));
  const configPath = path.join(runDir, 'keys.json');
  fs.writeFileSync(configPath, JSON.stringify({
    schemaVersion: 2,
    defaultProvider: 'deepseek',
    defaultModel: 'deepseek-chat',
    balanceRefreshMs: 1,
    providers: [{
      id: 'deepseek',
      name: 'DeepSeek',
      baseUrl: 'https://api.deepseek.com',
      enabled: true,
      models: [{ id: 'deepseek-chat', name: 'DeepSeek Chat', upstreamModel: 'deepseek-chat' }],
      keys: [{ name: 'test', key: 'sk-test-ok', weight: 1 }],
    }],
  }));

  try {
    const result = spawnSync(process.execPath, [
      GATEWAY,
      '--config', configPath,
      '--port', String(port),
    ], { cwd: ROOT, encoding: 'utf8', timeout: 5000 });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /address already in use/);
    assert.match(result.stderr, /--port <port>/);
    assert.doesNotMatch(result.stderr, /balance refresh failed/);
    assert.doesNotMatch(result.stderr, /Unhandled 'error' event/);
  } finally {
    await new Promise(resolve => blocker.close(resolve));
    fs.rmSync(runDir, { recursive: true, force: true });
  }
});

async function waitFor(fn, timeout = 8000) {
  const start = Date.now();
  for (;;) {
    if (await fn().then(() => true, () => false)) return;
    if (Date.now() - start > timeout) throw new Error('waitFor timeout');
    await new Promise(r => setTimeout(r, 100));
  }
}

async function startGateway(keys, extra = [], env = {}, config = {}, options = {}) {
  const port = await freePort();
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-run-'));
  const configPath = path.join(runDir, 'keys.json');
  fs.writeFileSync(configPath, JSON.stringify(config));
  const mockArgs = options.mock === false ? [] : ['--mock'];
  const keyArgs = options.keysArg === false ? [] : ['--keys', keys];
  const child = spawn(process.execPath, [
    GATEWAY, ...mockArgs, '--config', configPath, '--port', String(port), ...keyArgs, '--quiet', ...extra,
  ], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } });
  let stderr = '';
  child.stderr.on('data', d => { stderr += d; });
  const base = `http://127.0.0.1:${port}`;
  await waitFor(() => fetch(`${base}/health`).then(r => r.ok));
  return {
    base,
    configPath,
    async health() { return fetch(`${base}/health`).then(r => r.json()); },
    async providers() { return fetch(`${base}/api/providers`).then(r => r.json()); },
    async settings(init) { return fetch(`${base}/api/settings`, init); },
    async chat(body = {}, headers = {}) {
      const res = await fetch(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify({ model: 'deepseek-v4-flash', ...body }),
      });
      const text = await res.text();
      return { status: res.status, headers: res.headers, text };
    },
    async stop() {
      child.kill('SIGKILL');
      await new Promise(r => child.on('exit', r));
      fs.rmSync(runDir, { recursive: true, force: true });
      if (stderr) throw new Error(`gateway stderr: ${stderr}`);
    },
  };
}

function multiProviderConfig(overrides = {}) {
  return {
    schemaVersion: 2,
    defaultProvider: 'alpha',
    defaultModel: 'alpha--shared',
    maxRetries: 0,
    providers: [
      {
        id: 'alpha',
        name: 'Alpha',
        baseUrl: 'https://alpha.example',
        enabled: true,
        models: [{ id: 'shared', name: 'Shared Alpha', upstreamModel: 'same-upstream-model' }],
        keys: [{ name: 'alpha-key', key: 'sk-alpha-ok', weight: 1 }],
      },
      {
        id: 'beta',
        name: 'Beta',
        baseUrl: 'https://beta.example/v1',
        enabled: true,
        models: [{ id: 'shared', name: 'Shared Beta', upstreamModel: 'same-upstream-model' }],
        keys: [{ name: 'beta-key', key: 'sk-beta-ok', weight: 1 }],
      },
    ],
    ...overrides,
  };
}

test('round-robin distributes across keys', async () => {
  const gw = await startGateway('alice=sk-a-ok,bob=sk-b-ok');
  try {
    const names = [];
    for (let i = 0; i < 4; i++) {
      const { status, text } = await gw.chat();
      assert.equal(status, 200);
      names.push(JSON.parse(text).gateway_key_name);
    }
    assert.deepEqual(names, ['alice', 'bob', 'alice', 'bob']);
  } finally {
    await gw.stop();
  }
});

test('429 fails over to the next key and cools the throttled one', async () => {
  const gw = await startGateway('alice=sk-a-429,bob=sk-b-ok');
  try {
    const { status, text } = await gw.chat();
    assert.equal(status, 200);
    assert.equal(JSON.parse(text).gateway_key_name, 'bob');
    const h = await gw.health();
    const alice = h.keys.find(k => k.name === 'alice');
    assert.equal(alice.state, 'cooldown');
    assert.ok(alice.cooldownSec >= 1);
    assert.equal(alice.ratelimited, 1);
    const { status: s2, text: t2 } = await gw.chat();
    assert.equal(s2, 200);
    assert.equal(JSON.parse(t2).gateway_key_name, 'bob');
  } finally {
    await gw.stop();
  }
});

test('401 marks key invalid permanently', async () => {
  const gw = await startGateway('alice=sk-a-401,bob=sk-b-ok');
  try {
    const { status, text } = await gw.chat();
    assert.equal(status, 200);
    assert.equal(JSON.parse(text).gateway_key_name, 'bob');
    const h = await gw.health();
    assert.equal(h.keys.find(k => k.name === 'alice').invalid, true);
    assert.equal(h.keys.find(k => k.name === 'alice').state, 'invalid');
  } finally {
    await gw.stop();
  }
});

test('cumulative 5xx failures blacklist keys after threshold', async () => {
  const gw = await startGateway('alice=sk-a-500,bob=sk-b-500,carol=sk-c-ok', ['--blacklist-threshold', '3']);
  try {
    for (let i = 0; i < 4; i++) {
      const { status, text } = await gw.chat();
      assert.equal(status, 200);
      assert.equal(JSON.parse(text).gateway_key_name, 'carol');
    }
    const h = await gw.health();
    const alice = h.keys.find(k => k.name === 'alice');
    assert.equal(alice.state, 'invalid');
    assert.equal(alice.failureCount, 3);
    assert.match(alice.lastError, /blacklisted after 3 failures/);
    assert.equal(h.keys.find(k => k.name === 'bob').state, 'invalid');
  } finally {
    await gw.stop();
  }
});

test('blacklisted key is removed from scheduling even when it is the only key', async () => {
  const gw = await startGateway('alice=sk-a-500', ['--blacklist-threshold', '3']);
  try {
    for (let i = 0; i < 3; i++) assert.equal((await gw.chat()).status, 500);
    const h = await gw.health();
    assert.equal(h.keys[0].state, 'invalid');
    assert.equal(h.keys[0].failureCount, 3);
    const afterBlacklist = await gw.chat();
    assert.equal(afterBlacklist.status, 502);
    assert.match(afterBlacklist.text, /no keys available/);
  } finally {
    await gw.stop();
  }
});

test('legacy breakerThreshold config still controls the blacklist threshold', async () => {
  const gw = await startGateway('alice=sk-a-500', [], {}, { breakerThreshold: 2 });
  try {
    assert.equal((await gw.chat()).status, 500);
    assert.equal((await gw.chat()).status, 500);
    assert.equal((await gw.chat()).status, 502);
    const h = await gw.health();
    assert.equal(h.keys[0].state, 'invalid');
    assert.equal(h.keys[0].failureCount, 2);
  } finally {
    await gw.stop();
  }
});

test('402 marks a key invalid and fails over', async () => {
  const gw = await startGateway('alice=sk-a-402,bob=sk-b-ok');
  try {
    const { status, text } = await gw.chat();
    assert.equal(status, 200);
    assert.equal(JSON.parse(text).gateway_key_name, 'bob');
    const h = await gw.health();
    assert.equal(h.keys.find(k => k.name === 'alice').state, 'invalid');
  } finally {
    await gw.stop();
  }
});

test('SSE stream passes through with key attribution', async () => {
  const gw = await startGateway('alice=sk-a-ok,bob=sk-b-ok');
  try {
    const { status, headers, text } = await gw.chat({ stream: true });
    assert.equal(status, 200);
    assert.match(headers.get('content-type'), /text\/event-stream/);
    assert.match(text, /data: \{\"type\":\"response\.output_item\.added\",\"gateway_key_name\":\"alice\"/);
    assert.match(text, /data: \[DONE\]/);
    assert.match(text, /total_tokens/);
    assert.equal(headers.get('x-gateway-key'), 'alice');
  } finally {
    await gw.stop();
  }
});

test('concurrent requests spread across slow keys', async () => {
  const gw = await startGateway('alice=sk-a-slow,bob=sk-b-slow');
  try {
    const results = await Promise.all(Array.from({ length: 4 }, () => gw.chat()));
    const names = results.map(r => JSON.parse(r.text).gateway_key_name);
    assert.ok(names.includes('alice') && names.includes('bob'), `expected both keys, got ${names}`);
    assert.ok(names.filter(n => n === 'alice').length >= 1 && names.filter(n => n === 'bob').length >= 1);
  } finally {
    await gw.stop();
  }
});

test('health endpoint reports totals', async () => {
  const gw = await startGateway('alice=sk-a-ok');
  try {
    await gw.chat();
    await gw.chat();
    const h = await gw.health();
    assert.equal(h.total.requests, 2);
    assert.equal(h.total.success, 2);
    assert.ok(h.total.tokens > 0);
    assert.equal(h.keys[0].name, 'alice');
    assert.equal(h.keys[0].state, 'healthy');
  } finally {
    await gw.stop();
  }
});

test('provider-scoped aliases route identical upstream model names without crossing pools', async () => {
  const gw = await startGateway('', [], {}, multiProviderConfig(), { keysArg: false });
  try {
    const alpha = await gw.chat({ model: 'alpha--shared' });
    assert.equal(alpha.status, 200);
    assert.equal(alpha.headers.get('x-gateway-provider'), 'alpha');
    assert.equal(alpha.headers.get('x-gateway-model'), 'alpha--shared');
    assert.equal(JSON.parse(alpha.text).gateway_key_name, 'alpha-key');
    assert.equal(JSON.parse(alpha.text).model, 'same-upstream-model');

    const beta = await gw.chat({ model: 'beta--shared' });
    assert.equal(beta.status, 200);
    assert.equal(beta.headers.get('x-gateway-provider'), 'beta');
    assert.equal(beta.headers.get('x-gateway-model'), 'beta--shared');
    assert.equal(JSON.parse(beta.text).gateway_key_name, 'beta-key');

    const h = await gw.health();
    assert.equal(h.providers.find(provider => provider.id === 'alpha').total.requests, 1);
    assert.equal(h.providers.find(provider => provider.id === 'beta').total.requests, 1);
    assert.equal(h.total.requests, 2);
  } finally {
    await gw.stop();
  }
});

test('provider failure and cooldown state is isolated', async () => {
  const config = multiProviderConfig();
  config.providers[0].keys[0].key = 'sk-alpha-429';
  const gw = await startGateway('', [], {}, config, { keysArg: false });
  try {
    assert.equal((await gw.chat({ model: 'alpha--shared' })).status, 429);
    assert.equal((await gw.chat({ model: 'beta--shared' })).status, 200);
    const h = await gw.health();
    const alpha = h.providers.find(provider => provider.id === 'alpha');
    const beta = h.providers.find(provider => provider.id === 'beta');
    assert.equal(alpha.keys[0].state, 'cooldown');
    assert.equal(alpha.total.ratelimited, 1);
    assert.equal(beta.keys[0].state, 'healthy');
    assert.equal(beta.total.ratelimited, 0);
  } finally {
    await gw.stop();
  }
});

test('unknown prefixed aliases fail closed while legacy model names use the default provider', async () => {
  const gw = await startGateway('', [], {}, multiProviderConfig(), { keysArg: false });
  try {
    const unknown = await gw.chat({ model: 'missing--shared' });
    assert.equal(unknown.status, 400);
    assert.match(unknown.text, /unknown or disabled model alias/);
    const legacy = await gw.chat({ model: 'same-upstream-model' });
    assert.equal(legacy.status, 200);
    assert.equal(legacy.headers.get('x-gateway-provider'), 'alpha');
    assert.equal(JSON.parse(legacy.text).gateway_key_name, 'alpha-key');
  } finally {
    await gw.stop();
  }
});

test('provider API masks secrets, persists atomically, and applies new aliases live', async () => {
  const gw = await startGateway('', [], {}, multiProviderConfig(), { keysArg: false });
  const secret = 'sk-gamma-super-secret';
  try {
    const response = await fetch(`${gw.base}/api/providers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: gw.base },
      body: JSON.stringify({
        id: 'gamma',
        name: 'Gamma',
        baseUrl: 'https://gamma.example/v1',
        enabled: true,
        models: [{ id: 'shared', name: 'Shared Gamma', upstreamModel: 'same-upstream-model' }],
        keys: [{ name: 'gamma-key', key: secret, weight: 2 }],
      }),
    });
    assert.equal(response.status, 201);
    const responseText = await response.text();
    assert.ok(!responseText.includes(secret));
    const publicConfig = JSON.parse(responseText);
    const gamma = publicConfig.providers.find(provider => provider.id === 'gamma');
    assert.match(gamma.keys[0].maskedKey, /^\*\*\*\*/);
    assert.equal(gamma.keys[0].key, undefined);

    const routed = await gw.chat({ model: 'gamma--shared' });
    assert.equal(routed.status, 200);
    assert.equal(routed.headers.get('x-gateway-provider'), 'gamma');
    assert.equal(JSON.parse(routed.text).gateway_key_name, 'gamma-key');

    const persisted = JSON.parse(fs.readFileSync(gw.configPath, 'utf8'));
    assert.equal(persisted.schemaVersion, 2);
    assert.equal(persisted.providers.find(provider => provider.id === 'gamma').keys[0].key, secret);
    assert.equal(fs.statSync(gw.configPath).mode & 0o777, 0o600);
    assert.ok(fs.existsSync(`${gw.configPath}.bak`));

    const crossOrigin = await fetch(`${gw.base}/api/providers/gamma`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
      body: JSON.stringify({ name: 'Compromised' }),
    });
    assert.equal(crossOrigin.status, 403);

    const invalid = await fetch(`${gw.base}/api/providers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: gw.base },
      body: JSON.stringify({ id: 'bad--id' }),
    });
    assert.equal(invalid.status, 400);
  } finally {
    await gw.stop();
  }
});

test('provider API does not persist key overrides from the environment', async () => {
  const config = multiProviderConfig();
  const gw = await startGateway('', [], { DEEPSEEK_KEYS: 'runtime=sk-runtime-only-ok' }, config, { keysArg: false });
  try {
    const response = await fetch(`${gw.base}/api/providers/alpha`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', origin: gw.base },
      body: JSON.stringify({ name: 'Must Not Persist' }),
    });
    assert.equal(response.status, 409);
    assert.match(await response.text(), /DEEPSEEK_KEYS/);

    const persisted = fs.readFileSync(gw.configPath, 'utf8');
    assert.ok(!persisted.includes('sk-runtime-only-ok'));
    assert.equal(JSON.parse(persisted).providers[0].name, 'Alpha');
  } finally {
    await gw.stop();
  }
});

test('provider API persists file values instead of scalar runtime overrides', async () => {
  const config = multiProviderConfig({ maxRetries: 0, customField: { keep: true } });
  const gw = await startGateway('', [], { DS_MAX_RETRIES: '7' }, config, { keysArg: false });
  try {
    const response = await fetch(`${gw.base}/api/providers/beta`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', origin: gw.base },
      body: JSON.stringify({ name: 'Beta Updated' }),
    });
    assert.equal(response.status, 200, await response.text());

    const persisted = JSON.parse(fs.readFileSync(gw.configPath, 'utf8'));
    assert.equal(persisted.maxRetries, 0);
    assert.deepEqual(persisted.customField, { keep: true });
    assert.equal(persisted.providers.find(provider => provider.id === 'beta').name, 'Beta Updated');
  } finally {
    await gw.stop();
  }
});

test('settings API redacts tokens and applies runtime settings live', async () => {
  const config = multiProviderConfig({
    cooldownMs: 60000,
    maxRetries: 0,
    token: 'stored-gateway-secret',
  });
  config.providers[0].keys = [
    { name: 'limited', key: 'sk-alpha-429', weight: 1 },
    { name: 'healthy', key: 'sk-alpha-ok', weight: 1 },
  ];
  const gw = await startGateway('', [], {}, config, { keysArg: false });
  const auth = { authorization: 'Bearer stored-gateway-secret' };
  try {
    const initial = await gw.settings({ headers: auth });
    const initialText = await initial.text();
    assert.equal(initial.status, 200);
    assert.ok(!initialText.includes('stored-gateway-secret'));
    const initialSettings = JSON.parse(initialText);
    assert.equal(initialSettings.persisted.tokenConfigured, true);
    assert.equal(initialSettings.effective.tokenConfigured, true);
    assert.equal(initialSettings.persisted.token, undefined);

    const updated = await gw.settings({
      method: 'PATCH',
      headers: { ...auth, 'content-type': 'application/json', origin: gw.base },
      body: JSON.stringify({ cooldownMs: 4000, maxRetries: 1, timeoutMs: 2500 }),
    });
    const updatedText = await updated.text();
    assert.equal(updated.status, 200, updatedText);
    const settings = JSON.parse(updatedText);
    assert.equal(settings.effective.cooldownMs, 4000);
    assert.equal(settings.effective.maxRetries, 1);
    assert.equal(settings.effective.timeoutMs, 2500);

    const routed = await gw.chat({ model: 'alpha--shared' }, auth);
    assert.equal(routed.status, 200);
    assert.equal(JSON.parse(routed.text).gateway_key_name, 'healthy');
    const health = await fetch(`${gw.base}/health`, { headers: auth }).then(response => response.json());
    const limited = health.providers.find(provider => provider.id === 'alpha').keys.find(key => key.name === 'limited');
    assert.equal(limited.state, 'cooldown');
    assert.ok(limited.cooldownSec <= 4);
  } finally {
    await gw.stop();
  }
});

test('settings API persists restart-only values and rejects cross-origin writes', async () => {
  const gw = await startGateway('', [], {}, multiProviderConfig(), { keysArg: false });
  try {
    const rejected = await gw.settings({
      method: 'PATCH',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
      body: JSON.stringify({ host: '0.0.0.0' }),
    });
    assert.equal(rejected.status, 403);

    const response = await gw.settings({
      method: 'PATCH',
      headers: { 'content-type': 'application/json', origin: gw.base },
      body: JSON.stringify({ host: '0.0.0.0', port: 9444, maxBodyBytes: 4096 }),
    });
    const responseText = await response.text();
    assert.equal(response.status, 200, responseText);
    const settings = JSON.parse(responseText);
    assert.equal(settings.persisted.host, '0.0.0.0');
    assert.equal(settings.persisted.port, 9444);
    assert.equal(settings.effective.host, '127.0.0.1');
    assert.notEqual(settings.effective.port, 9444);
    assert.deepEqual(settings.restartRequired.sort(), ['host', 'port']);
    assert.equal(settings.effective.maxBodyBytes, 4096);

    const persisted = JSON.parse(fs.readFileSync(gw.configPath, 'utf8'));
    assert.equal(persisted.host, '0.0.0.0');
    assert.equal(persisted.port, 9444);
    assert.equal(persisted.maxBodyBytes, 4096);
  } finally {
    await gw.stop();
  }
});

test('settings API reports scalar overrides without persisting their values', async () => {
  const config = multiProviderConfig({ cooldownMs: 60000, maxRetries: 0 });
  const gw = await startGateway('', [], {
    DS_COOLDOWN_MS: '9000',
    DS_MAX_RETRIES: '7',
  }, config, { keysArg: false });
  try {
    const response = await gw.settings({
      method: 'PATCH',
      headers: { 'content-type': 'application/json', origin: gw.base },
      body: JSON.stringify({ cooldownMs: 4000, maxRetries: 1, port: 9444 }),
    });
    const responseText = await response.text();
    assert.equal(response.status, 200, responseText);
    const settings = JSON.parse(responseText);
    assert.equal(settings.persisted.cooldownMs, 4000);
    assert.equal(settings.persisted.maxRetries, 1);
    assert.equal(settings.effective.cooldownMs, 9000);
    assert.equal(settings.effective.maxRetries, 7);
    assert.equal(settings.overrides.cooldownMs, 'DS_COOLDOWN_MS');
    assert.equal(settings.overrides.maxRetries, 'DS_MAX_RETRIES');
    assert.equal(settings.overrides.port, '--port');

    const persisted = JSON.parse(fs.readFileSync(gw.configPath, 'utf8'));
    assert.equal(persisted.cooldownMs, 4000);
    assert.equal(persisted.maxRetries, 1);
    assert.equal(persisted.port, 9444);
    assert.ok(!JSON.stringify(persisted).includes('9000'));
  } finally {
    await gw.stop();
  }
});

test('settings API can set and clear the gateway token without exposing it', async () => {
  const gw = await startGateway('', [], {}, multiProviderConfig(), { keysArg: false });
  try {
    const setToken = await gw.settings({
      method: 'PATCH',
      headers: { 'content-type': 'application/json', origin: gw.base },
      body: JSON.stringify({ token: 'rotated-gateway-secret' }),
    });
    const setText = await setToken.text();
    assert.equal(setToken.status, 200);
    assert.ok(!setText.includes('rotated-gateway-secret'));
    assert.equal(JSON.parse(setText).effective.tokenConfigured, true);
    assert.equal((await gw.settings()).status, 401);

    const auth = { authorization: 'Bearer rotated-gateway-secret' };
    const authenticated = await gw.settings({ headers: auth });
    const authenticatedText = await authenticated.text();
    assert.equal(authenticated.status, 200);
    assert.ok(!authenticatedText.includes('rotated-gateway-secret'));

    const cleared = await gw.settings({
      method: 'PATCH',
      headers: { ...auth, 'content-type': 'application/json', origin: gw.base },
      body: JSON.stringify({ clearToken: true }),
    });
    const clearedText = await cleared.text();
    assert.equal(cleared.status, 200, clearedText);
    assert.equal(JSON.parse(clearedText).effective.tokenConfigured, false);
    assert.equal(JSON.parse(fs.readFileSync(gw.configPath, 'utf8')).token, '');
    assert.equal((await gw.settings()).status, 200);
  } finally {
    await gw.stop();
  }
});

test('model discovery proxies OpenAI-compatible endpoints and normalizes upstream model ids', async () => {
  const upstreamPort = await freePort();
  const requests = [];
  const upstream = http.createServer((req, res) => {
    requests.push({ path: req.url, authorization: req.headers.authorization });
    if (req.url === '/anthropic/v1/models') {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    if (req.url !== '/v1/models') {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      object: 'list',
      data: [
        { id: 'Qwen/Qwen3-235B-A22B-Instruct', owned_by: 'qwen' },
        { id: 'gpt-4o-mini', owned_by: 'openai' },
        { id: 'claude/3.5-sonnet', name: 'Claude 3.5 Sonnet' },
      ],
    }));
  });
  await new Promise(resolve => upstream.listen(upstreamPort, '127.0.0.1', resolve));
  const gw = await startGateway('', [], {}, multiProviderConfig(), { keysArg: false });
  const secret = 'sk-model-discovery-secret';
  try {
    const response = await fetch(`${gw.base}/api/models`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: gw.base },
      body: JSON.stringify({
        baseUrl: `http://127.0.0.1:${upstreamPort}/anthropic`,
        key: secret,
      }),
    });
    const responseText = await response.text();
    assert.equal(response.status, 200, responseText);
    const payload = JSON.parse(responseText);
    assert.deepEqual(payload.models.map(model => model.upstreamModel), [
      'claude/3.5-sonnet',
      'gpt-4o-mini',
      'Qwen/Qwen3-235B-A22B-Instruct',
    ]);
    assert.deepEqual(payload.models.map(model => model.id), [
      'claude-3-5-sonnet',
      'gpt-4o-mini',
      'qwen-qwen3-235b-a22b-instruct',
    ]);
    assert.equal(payload.models[2].ownedBy, 'qwen');
    assert.equal(payload.models[0].name, 'Claude 3.5 Sonnet');
    assert.ok(!JSON.stringify(payload).includes(secret));

    const providerKeyResponse = await fetch(`${gw.base}/api/models`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: gw.base },
      body: JSON.stringify({ providerId: 'alpha', baseUrl: `http://127.0.0.1:${upstreamPort}/anthropic` }),
    });
    assert.equal(providerKeyResponse.status, 200, await providerKeyResponse.text());
    assert.deepEqual(requests, [
      { path: '/anthropic/v1/models', authorization: `Bearer ${secret}` },
      { path: '/v1/models', authorization: `Bearer ${secret}` },
      { path: '/anthropic/v1/models', authorization: 'Bearer sk-alpha-ok' },
      { path: '/v1/models', authorization: 'Bearer sk-alpha-ok' },
    ]);
  } finally {
    await gw.stop();
    await new Promise(resolve => upstream.close(resolve));
  }
});

test('adding a key live preserves existing key state and schedules the new key immediately', async () => {
  const config = multiProviderConfig({ maxRetries: 0 });
  config.providers[0].keys[0].key = 'sk-alpha-429';
  const gw = await startGateway('', [], {}, config, { keysArg: false });
  try {
    const limited = await gw.chat({ model: 'alpha--shared' });
    assert.equal(limited.status, 429);
    const before = await gw.health();
    const beforeKey = before.providers.find(provider => provider.id === 'alpha').keys[0];
    assert.equal(beforeKey.state, 'cooldown');
    assert.equal(beforeKey.ratelimited, 1);

    const response = await fetch(`${gw.base}/api/providers/alpha`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', origin: gw.base },
      body: JSON.stringify({
        keys: [
          { name: 'alpha-renamed', key: 'sk-alpha-429', weight: 2 },
          { name: 'alpha-fresh', key: 'sk-alpha-fresh', weight: 1 },
        ],
      }),
    });
    assert.equal(response.status, 200, await response.text());

    const reconciled = await gw.health();
    const alpha = reconciled.providers.find(provider => provider.id === 'alpha');
    const preserved = alpha.keys.find(key => key.name === 'alpha-renamed');
    const added = alpha.keys.find(key => key.name === 'alpha-fresh');
    assert.equal(preserved.state, 'cooldown');
    assert.equal(preserved.ratelimited, 1);
    assert.equal(preserved.lastUsed, beforeKey.lastUsed);
    assert.equal(preserved.weight, 2);
    assert.equal(added.state, 'healthy');
    assert.equal(added.total, 0);
    assert.equal(alpha.total.ratelimited, 1);

    const routed = await gw.chat({ model: 'alpha--shared' });
    assert.equal(routed.status, 200);
    assert.equal(JSON.parse(routed.text).gateway_key_name, 'alpha-fresh');
    const after = await gw.health();
    const afterAlpha = after.providers.find(provider => provider.id === 'alpha');
    assert.equal(afterAlpha.keys.find(key => key.name === 'alpha-renamed').ratelimited, 1);
    assert.equal(afterAlpha.keys.find(key => key.name === 'alpha-fresh').success, 1);
    assert.equal(afterAlpha.total.requests, 2);
  } finally {
    await gw.stop();
  }
});

test('key API updates routing state, tests one key, and deletes live', async () => {
  const config = multiProviderConfig({ maxRetries: 0 });
  config.providers[0].keys.push({
    name: 'alpha-backup',
    key: 'sk-alpha-backup-ok',
    weight: 1,
  });
  const gw = await startGateway('', [], {}, config, { keysArg: false });
  try {
    const disable = await fetch(`${gw.base}/api/providers/alpha/keys/alpha-key`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', origin: gw.base },
      body: JSON.stringify({ enabled: false }),
    });
    const disableText = await disable.text();
    assert.equal(disable.status, 200, disableText);
    const publicConfig = JSON.parse(disableText);
    const publicKey = publicConfig.providers
      .find(provider => provider.id === 'alpha').keys
      .find(key => key.name === 'alpha-key');
    assert.equal(publicKey.enabled, false);
    assert.equal(publicKey.key, undefined);

    const disabledHealth = await gw.health();
    const disabledKey = disabledHealth.providers
      .find(provider => provider.id === 'alpha').keys
      .find(key => key.name === 'alpha-key');
    assert.equal(disabledKey.state, 'disabled');
    assert.equal(disabledKey.enabled, false);

    const routed = await gw.chat({ model: 'alpha--shared' });
    assert.equal(routed.status, 200);
    assert.equal(JSON.parse(routed.text).gateway_key_name, 'alpha-backup');

    const tested = await fetch(`${gw.base}/api/providers/alpha/keys/alpha-key/test`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: gw.base },
      body: '{}',
    });
    const testedText = await tested.text();
    assert.equal(tested.status, 200, testedText);
    assert.equal(JSON.parse(testedText).key, 'alpha-key');

    const update = await fetch(`${gw.base}/api/providers/alpha/keys/alpha-key`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', origin: gw.base },
      body: JSON.stringify({ enabled: true, weight: 3 }),
    });
    assert.equal(update.status, 200, await update.text());

    const remove = await fetch(`${gw.base}/api/providers/alpha/keys/alpha-backup`, {
      method: 'DELETE',
      headers: { origin: gw.base },
    });
    assert.equal(remove.status, 200, await remove.text());

    const rejectLastDisable = await fetch(`${gw.base}/api/providers/alpha/keys/alpha-key`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', origin: gw.base },
      body: JSON.stringify({ enabled: false }),
    });
    assert.equal(rejectLastDisable.status, 409);
    assert.match(await rejectLastDisable.text(), /at least one enabled key/);

    const persisted = JSON.parse(fs.readFileSync(gw.configPath, 'utf8'));
    const persistedKeys = persisted.providers.find(provider => provider.id === 'alpha').keys;
    assert.deepEqual(persistedKeys.map(key => key.name), ['alpha-key']);
    assert.equal(persistedKeys[0].enabled, true);
    assert.equal(persistedKeys[0].weight, 3);
  } finally {
    await gw.stop();
  }
});

test('provider update rejects duplicate key secrets without changing the live pool', async () => {
  const gw = await startGateway('', [], {}, multiProviderConfig(), { keysArg: false });
  try {
    const response = await fetch(`${gw.base}/api/providers/alpha`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', origin: gw.base },
      body: JSON.stringify({
        keys: [
          { name: 'alpha-key', key: 'sk-alpha-ok', weight: 1 },
          { name: 'alpha-copy', key: 'sk-alpha-ok', weight: 1 },
        ],
      }),
    });
    assert.equal(response.status, 400);
    assert.match(await response.text(), /duplicate key secret in provider alpha/);
    const health = await gw.health();
    const alpha = health.providers.find(provider => provider.id === 'alpha');
    assert.deepEqual(alpha.keys.map(key => key.name), ['alpha-key']);
  } finally {
    await gw.stop();
  }
});

test('changing provider baseUrl drains an active stream before retiring its runtime', async () => {
  const oldPort = await freePort();
  const newPort = await freePort();
  let finishOldStream = null;
  let oldRequests = 0;
  let newRequests = 0;
  const oldUpstream = http.createServer((req, res) => {
    oldRequests++;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: old-start\n\n');
    finishOldStream = () => res.end('data: old-end\n\ndata: [DONE]\n\n');
  });
  const newUpstream = http.createServer((req, res) => {
    newRequests++;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ source: 'new-upstream' }));
  });
  await Promise.all([
    new Promise(resolve => oldUpstream.listen(oldPort, '127.0.0.1', resolve)),
    new Promise(resolve => newUpstream.listen(newPort, '127.0.0.1', resolve)),
  ]);

  const config = multiProviderConfig({ maxRetries: 0 });
  config.providers[0].baseUrl = `http://127.0.0.1:${oldPort}`;
  const gw = await startGateway('', [], {}, config, { keysArg: false, mock: false });
  try {
    const stream = await fetch(`${gw.base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'alpha--shared', stream: true }),
    });
    assert.equal(stream.status, 200);
    const reader = stream.body.getReader();
    const decoder = new TextDecoder();
    const first = await reader.read();
    assert.match(decoder.decode(first.value), /old-start/);

    const updated = await fetch(`${gw.base}/api/providers/alpha`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', origin: gw.base },
      body: JSON.stringify({ baseUrl: `http://127.0.0.1:${newPort}` }),
    });
    assert.equal(updated.status, 200, await updated.text());

    const next = await gw.chat({ model: 'alpha--shared' });
    assert.equal(next.status, 200);
    assert.deepEqual(JSON.parse(next.text), { source: 'new-upstream' });
    assert.equal(oldRequests, 1);
    assert.equal(newRequests, 1);

    finishOldStream();
    let remainder = '';
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      remainder += decoder.decode(chunk.value, { stream: true });
    }
    remainder += decoder.decode();
    assert.match(remainder, /old-end/);
  } finally {
    finishOldStream?.();
    await gw.stop();
    await Promise.all([
      new Promise(resolve => oldUpstream.close(resolve)),
      new Promise(resolve => newUpstream.close(resolve)),
    ]);
  }
});

test('generated Codex artifacts use one provider, env auth, and unique aliases without secrets', async () => {
  const gw = await startGateway('', [], {}, multiProviderConfig(), { keysArg: false });
  try {
    const response = await fetch(`${gw.base}/api/codex/config`);
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.ok(!text.includes('sk-alpha-ok'));
    assert.ok(!text.includes('sk-beta-ok'));
    const artifacts = JSON.parse(text);
    assert.equal(artifacts.providerId, 'multi-provider-gateway');
    assert.match(artifacts.configToml, /model_provider = "multi-provider-gateway"/);
    assert.match(artifacts.configToml, /env_key = "DEEPSEEK_GATEWAY_TOKEN"/);
    assert.doesNotMatch(artifacts.configToml, /experimental_bearer_token/);
    assert.equal((artifacts.configToml.match(/\[model_providers\./g) || []).length, 1);
    const aliases = JSON.parse(artifacts.catalogJson).models.map(model => model.slug);
    assert.deepEqual(aliases, ['alpha--shared', 'beta--shared']);
  } finally {
    await gw.stop();
  }
});

test('health and dashboard report every key balance', async () => {
  const gw = await startGateway('alice=sk-a-ok,bob=sk-b-ok');
  try {
    await waitFor(async () => (await gw.health()).keys.every(k => k.balanceUpdatedAt));
    const h = await gw.health();
    assert.equal(h.keys.length, 2);
    for (const key of h.keys) {
      assert.equal(key.balance.isAvailable, true);
      assert.deepEqual(key.balance.infos, [{
        currency: 'CNY',
        totalBalance: '88.80',
        grantedBalance: '8.80',
        toppedUpBalance: '80.00',
      }]);
      assert.equal(key.balanceError, '');
    }
    const html = await fetch(`${gw.base}/`).then(r => r.text());
    if (html.includes('id="root"')) {
      const asset = html.match(/src="([^\"]+\.js)"/)?.[1];
      assert.ok(asset, 'shadcn dashboard bundle must be referenced');
      const bundle = await fetch(`${gw.base}${asset}`);
      assert.equal(bundle.status, 200);
      assert.match(bundle.headers.get('content-type'), /javascript/);
    } else {
      assert.match(html, /<th>Balance<\/th>/);
      assert.match(html, /balanceCell\(k\)/);
      const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1];
      assert.ok(script, 'fallback dashboard script must exist');
      assert.doesNotThrow(() => new Function(script), 'rendered fallback dashboard script must be valid JavaScript');
    }
  } finally {
    await gw.stop();
  }
});

test('non-DeepSeek upstream is never queried for key balance', async () => {
  const upstreamPort = await freePort();
  const paths = [];
  const upstream = http.createServer((req, res) => {
    paths.push(req.url);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
  await new Promise(resolve => upstream.listen(upstreamPort, '127.0.0.1', resolve));
  const gw = await startGateway(
    'alice=sk-a-ok',
    ['--upstream', `http://127.0.0.1:${upstreamPort}`, '--balance-refresh-ms', '20'],
    {},
    {},
    { mock: false },
  );
  try {
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.deepEqual(paths, []);
    const h = await gw.health();
    assert.equal(h.keys[0].balance, null);
    assert.match(h.keys[0].balanceError, /only supported for DeepSeek/);
  } finally {
    await gw.stop();
    await new Promise(resolve => upstream.close(resolve));
  }
});

test('all keys invalid: degraded mode never picks them, returns 502', async () => {
  const gw = await startGateway('alice=sk-a-401,bob=sk-b-401');
  try {
    const first = await gw.chat();
    assert.equal(first.status, 401);
    const second = await gw.chat();
    assert.equal(second.status, 502);
    assert.match(second.text, /no keys available/);
    const h = await gw.health();
    for (const k of h.keys) assert.equal(k.state, 'invalid');
  } finally {
    await gw.stop();
  }
});

test('CLI args take precedence over env vars', async () => {
  const envPort = await freePort();
  const gw = await startGateway('alice=sk-a-ok', [], { DS_GATEWAY_PORT: String(envPort) });
  try {
    const h = await gw.health();
    assert.notEqual(h.port, envPort);
    const res = await fetch(`${gw.base}/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-v4-flash' }),
    });
    assert.equal(res.status, 200);
  } finally {
    await gw.stop();
  }
});

test('token auth: cookie login for dashboard, bearer for proxy', async () => {
  const gw = await startGateway('alice=sk-a-ok', ['--token', 'secret-token']);
  try {
    const shell = await fetch(`${gw.base}/`);
    assert.equal(shell.status, 200);
    const shellHtml = await shell.text();
    assert.ok(!shellHtml.includes('secret-token'), 'dashboard HTML must not embed the token');
    assert.ok(!shellHtml.includes('Bearer'), 'dashboard HTML must not embed bearer credentials');

    const healthNoAuth = await fetch(`${gw.base}/health`);
    assert.equal(healthNoAuth.status, 401);
    const providersNoAuth = await fetch(`${gw.base}/api/providers`);
    assert.equal(providersNoAuth.status, 401);
    const wrongLogin = await fetch(`${gw.base}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'wrong' }),
    });
    assert.equal(wrongLogin.status, 401);

    const login = await fetch(`${gw.base}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'secret-token' }),
      redirect: 'manual',
    });
    assert.equal(login.status, 302);
    const cookie = login.headers.get('set-cookie').split(';')[0];
    assert.ok(cookie.startsWith('dsgw='));

    const healthCookie = await fetch(`${gw.base}/health`, { headers: { cookie } });
    assert.equal(healthCookie.status, 200);
    const providersCookie = await fetch(`${gw.base}/api/providers`, { headers: { cookie } });
    assert.equal(providersCookie.status, 200);
    const shellCookie = await fetch(`${gw.base}/`, { headers: { cookie } });
    assert.equal(shellCookie.status, 200);

    const proxyWithCookie = await fetch(`${gw.base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ model: 'deepseek-v4-flash' }),
    });
    assert.equal(proxyWithCookie.status, 401, 'cookie must not authorize proxied calls');

    const proxyWithBearer = await fetch(`${gw.base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer secret-token' },
      body: JSON.stringify({ model: 'deepseek-v4-flash' }),
    });
    assert.equal(proxyWithBearer.status, 200);
  } finally {
    await gw.stop();
  }
});

test('inFlight is held for the whole stream, not just headers', async () => {
  const gw = await startGateway('alice=sk-a-drip');
  try {
    const res = await fetch(`${gw.base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-v4-flash', stream: true }),
    });
    assert.equal(res.status, 200);
    const reader = res.body.getReader();
    await reader.read();
    const during = await gw.health();
    assert.equal(during.keys[0].inFlight, 1, 'in-flight must stay 1 while stream is active');
    while (true) {
      const { done } = await reader.read();
      if (done) break;
    }
    const after = await gw.health();
    assert.equal(after.keys[0].inFlight, 0);
    assert.equal(after.keys[0].success, 1);
  } finally {
    await gw.stop();
  }
});

test('upstream abort mid-stream counts as error and gateway survives', async () => {
  const gw = await startGateway('alice=sk-a-abort');
  try {
    const res = await fetch(`${gw.base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-v4-flash', stream: true }),
    });
    assert.equal(res.status, 200);
    await assert.rejects(() => res.text());
    const h = await gw.health();
    assert.equal(h.keys[0].errors, 1);
    assert.equal(h.keys[0].inFlight, 0);
    const next = await gw.chat();
    assert.equal(next.status, 200, 'gateway must keep serving after an aborted stream');
  } finally {
    await gw.stop();
  }
});

test('merge-config preserves codex profiles', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-profiles-'));
  const codexDir = path.join(tmp, 'codex');
  fs.mkdirSync(codexDir);
  fs.writeFileSync(path.join(codexDir, 'config.toml'), [
    'model = "gpt-5"',
    '',
    '[profiles.fast]',
    'model = "gpt-5-fast"',
    '',
    '[profiles.deepseek]',
    'base_url = "https://deepseek.example"',
    '',
  ].join('\n'));
  const setup = path.join(ROOT, 'setup-codex.sh');
  for (let i = 0; i < 2; i++) {
    const r = spawnSync('bash', [setup], {
      env: { ...process.env, CODEX_HOME: codexDir, GATEWAY_URL: 'http://127.0.0.1:8787' },
      encoding: 'utf8',
    });
    assert.equal(r.status, 0, r.stderr);
  }
  const merged = fs.readFileSync(path.join(codexDir, 'config.toml'), 'utf8');
  assert.match(merged, /\[profiles\.fast\]/);
  assert.match(merged, /model = "gpt-5-fast"/, 'profile model must be preserved');
  assert.match(merged, /\[profiles\.deepseek\]/);
  assert.match(merged, /base_url = "https:\/\/deepseek\.example"/, 'profile deepseek must be preserved');
  assert.match(merged, /^model = "deepseek--v4-flash"/m, 'top-level model must be replaced');
  assert.equal((merged.match(/\[model_providers\.multi-provider-gateway\]/g) || []).length, 1);
  assert.match(merged, /env_key = "DEEPSEEK_GATEWAY_TOKEN"/);
  assert.doesNotMatch(merged, /experimental_bearer_token/);
  const validate = spawnSync('python3', ['-c', `
import sys, tomllib
with open(sys.argv[1], 'rb') as f: tomllib.load(f)
`, path.join(codexDir, 'config.toml')]);
  assert.equal(validate.status, 0, `merged config.toml must be valid TOML: ${validate.stderr}`);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('oversized request body is rejected with 413', async () => {
  const gw = await startGateway('alice=sk-a-ok', ['--max-body-bytes', '100']);
  try {
    const res = await fetch(`${gw.base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-v4-flash', messages: [{ role: 'user', content: 'x'.repeat(200) }] }),
    });
    assert.equal(res.status, 413);
    const small = await gw.chat();
    assert.equal(small.status, 200);
  } finally {
    await gw.stop();
  }
});

test('dashboard escapes key names', async () => {
  const evilName = '<script>alert(1)</script>';
  const gw = await startGateway(`${evilName}=sk-a-ok`);
  try {
    const res = await fetch(`${gw.base}/`);
    const html = await res.text();
    if (html.includes('id="root"')) {
      assert.ok(!html.includes(evilName), 'dashboard shell must not embed key names');
    } else {
      assert.match(html, /function esc\(/);
      assert.match(html, /esc\(k\.name\)/);
    }
    const h = await gw.health();
    assert.equal(h.keys[0].name, evilName);
  } finally {
    await gw.stop();
  }
});

test('setup script is idempotent and dry-run is pure', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-setup-'));
  const codexDir = path.join(tmp, 'codex');
  fs.mkdirSync(codexDir);
  const gatewayConfig = path.join(tmp, 'gateway.json');
  fs.writeFileSync(gatewayConfig, JSON.stringify(multiProviderConfig()));
  const setup = path.join(ROOT, 'setup-codex.sh');
  const runSetup = (args) => spawnSync('bash', [setup, ...args], {
    env: {
      ...process.env,
      CODEX_HOME: codexDir,
      GATEWAY_URL: 'http://127.0.0.1:8787',
      GATEWAY_CONFIG: gatewayConfig,
      DEEPSEEK_GATEWAY_TOKEN: 'configured-token',
    },
    encoding: 'utf8',
  });

  const beforeDry = fs.readdirSync(codexDir).sort();
  const dry = runSetup(['--dry-run']);
  assert.equal(dry.status, 0, dry.stderr);
  const afterDry = fs.readdirSync(codexDir).sort();
  assert.deepEqual(afterDry, beforeDry, `dry-run must not create files: ${afterDry}`);

  const first = runSetup([]);
  assert.equal(first.status, 0, first.stderr);
  const configPath = path.join(codexDir, 'config.toml');
  fs.appendFileSync(configPath, '[mcp_servers.demo]\ncommand = "echo"\n');
  const preSecond = fs.readFileSync(configPath, 'utf8');
  const second = runSetup([]);
  assert.equal(second.status, 0, second.stderr);

  const merged = fs.readFileSync(configPath, 'utf8');
  const sectionCount = (merged.match(/\[model_providers\.multi-provider-gateway\]/g) || []).length;
  assert.equal(sectionCount, 1, `expected exactly one provider section: ${merged}`);
  assert.match(merged, /\[mcp_servers\.demo\]/);
  assert.match(merged, /base_url = "http:\/\/127\.0\.0\.1:8787\/v1"/);
  assert.match(merged, /env_key = "DEEPSEEK_GATEWAY_TOKEN"/);
  assert.doesNotMatch(merged, /experimental_bearer_token/);
  assert.ok(!merged.includes('configured-token'));
  assert.match(merged, /model = "alpha--shared"/);
  const catalog = JSON.parse(fs.readFileSync(path.join(codexDir, 'gateway-models.json'), 'utf8'));
  assert.deepEqual(catalog.models.map(model => model.slug), ['alpha--shared', 'beta--shared']);

  const validate = spawnSync('python3', ['-c', `
import sys, tomllib
with open(sys.argv[1], 'rb') as f: tomllib.load(f)
`, configPath]);
  assert.equal(validate.status, 0, `merged config.toml must be valid TOML: ${validate.stderr}`);

  const undo = runSetup(['--undo']);
  assert.equal(undo.status, 0, undo.stderr);
  assert.equal(fs.readFileSync(configPath, 'utf8'), preSecond, 'undo should restore the pre-run state');

  fs.rmSync(tmp, { recursive: true, force: true });
});

test('interactive configure writes a validated private config', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-configure-'));
  const configPath = path.join(tmp, 'keys.json');
  const port = await freePort();
  const answers = [
    String(port),
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    'primary',
    'sk-test-secret',
    '2',
    'n',
    'y',
    'gateway-secret',
    '',
  ].join('\n');
  const result = spawnSync('python3', [
    CONFIGURE, '--config', configPath, '--no-codex', '--no-start',
  ], {
    input: answers,
    encoding: 'utf8',
    env: { ...process.env, DS_GATEWAY_PORT: String(port) },
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.equal(config.schemaVersion, 2);
  assert.equal(config.port, port);
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.defaultProvider, 'deepseek');
  assert.equal(config.defaultModel, 'deepseek--v4-flash');
  assert.equal(config.upstream, undefined);
  assert.equal(config.keys, undefined);
  assert.equal(config.blacklistThreshold, 3);
  assert.equal(config.balanceRefreshMs, 300000);
  assert.equal(config.token, 'gateway-secret');
  assert.equal(config.providers[0].baseUrl, 'https://api.deepseek.com');
  assert.deepEqual(config.providers[0].keys, [
    { name: 'primary', key: 'sk-test-secret', weight: 2, enabled: true },
  ]);
  assert.equal(fs.statSync(configPath).mode & 0o777, 0o600);
  assert.ok(!result.stdout.includes('sk-test-secret'), 'API key must not be echoed');

  const keepAnswers = [
    '', '', '', '', '', '', '', '', '',
    'n',
    '',
    '',
    '',
  ].join('\n');
  const second = spawnSync('python3', [
    CONFIGURE, '--config', configPath, '--no-codex', '--no-start',
  ], {
    input: keepAnswers,
    encoding: 'utf8',
    env: { ...process.env, DS_GATEWAY_PORT: String(port) },
  });
  assert.equal(second.status, 0, second.stderr || second.stdout);
  const kept = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.deepEqual(kept.providers[0].keys, config.providers[0].keys);
  assert.equal(kept.token, 'gateway-secret');
  const backups = fs.readdirSync(path.join(tmp, '.gateway-backups'));
  assert.equal(backups.length, 1);
  assert.ok(!second.stdout.includes('sk-test-secret'), 'existing API key must stay masked');
  fs.rmSync(tmp, { recursive: true, force: true });
});
