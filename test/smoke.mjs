import { test } from 'node:test';
import assert from 'node:assert';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const GATEWAY = path.join(ROOT, 'gateway.mjs');
const CODEX_CONFIG = path.join(ROOT, 'codex-config.mjs');
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
    try {
      if (await fn()) return;
    } catch {
      // Retry until the predicate succeeds or the deadline expires.
    }
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
  await waitFor(() => fetch(`${base}/health`).then(() => true));
  return {
    base,
    configPath,
    async health() { return fetch(`${base}/health`).then(r => r.json()); },
    async providers() { return fetch(`${base}/api/providers`).then(r => r.json()); },
    async operation(pathname, init) { return fetch(`${base}${pathname}`, init); },
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
    async responses(body = {}, headers = {}, query = '') {
      const res = await fetch(`${base}/v1/responses${query}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify({ model: 'deepseek-v4-flash', input: 'hello', ...body }),
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
  const config = {
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
  if (config.token && !config.adminToken) config.adminToken = 'test-admin-token-123456';
  return config;
}

test('native Responses forwards image input while Chat Completions validates it', async () => {
  const textOnlyConfig = multiProviderConfig({
    providers: [{
      id: 'alpha',
      name: 'Alpha',
      baseUrl: 'https://alpha.example',
      enabled: true,
      models: [{
        id: 'text-only',
        name: 'Text Only',
        upstreamModel: 'text-only-upstream',
        inputModalities: ['text'],
      }],
      keys: [{ name: 'alpha-key', key: 'sk-alpha-ok', weight: 1 }],
    }],
    defaultProvider: 'alpha',
    defaultModel: 'alpha--text-only',
  });
  const textOnly = await startGateway('', [], {}, textOnlyConfig, { keysArg: false });
  try {
    const forwarded = await textOnly.responses({
      model: 'alpha--text-only',
      input: [{
        role: 'user',
        content: [{ type: 'input_image', image_url: 'data:image/png;base64,AA==' }],
      }],
    });
    assert.equal(forwarded.status, 200, forwarded.text);
  } finally {
    await textOnly.stop();
  }

  const chatConfig = multiProviderConfig({
    providers: [{
      id: 'alpha',
      name: 'Alpha Chat',
      baseUrl: 'https://alpha.example',
      upstreamFormat: 'chat-completions',
      enabled: true,
      models: [{
        id: 'text-only',
        name: 'Text Only',
        upstreamModel: 'text-only-upstream',
        inputModalities: ['text'],
      }],
      keys: [{ name: 'alpha-key', key: 'sk-alpha-ok', weight: 1 }],
    }],
    defaultProvider: 'alpha',
    defaultModel: 'alpha--text-only',
  });
  const chatGateway = await startGateway('', [], {}, chatConfig, { keysArg: false });
  try {
    const rejected = await chatGateway.chat({
      model: 'alpha--text-only',
      messages: [{
        role: 'user',
        content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } }],
      }],
    });
    assert.equal(rejected.status, 400);
    assert.match(rejected.text, /does not support image input/);
  } finally {
    await chatGateway.stop();
  }
});

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

test('403 is returned without poisoning or failing over to another key', async () => {
  const gw = await startGateway('alice=sk-a-403,bob=sk-b-ok');
  try {
    const { status, text } = await gw.chat();
    assert.equal(status, 403);
    assert.match(text, /mock 403/);
    const h = await gw.health();
    const alice = h.keys.find(k => k.name === 'alice');
    const bob = h.keys.find(k => k.name === 'bob');
    assert.equal(alice.invalid, false);
    assert.equal(alice.failureCount, 0);
    assert.equal(alice.errors, 1);
    assert.equal(bob.total, 0, 'a request-level 403 must not be retried with another credential');
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

test('alwaysTry keeps the only key schedulable after the blacklist threshold', async () => {
  const config = multiProviderConfig({ blacklistThreshold: 2 });
  config.providers[0].keys[0] = {
    name: 'alpha-key',
    key: 'sk-alpha-500',
    weight: 1,
    enabled: true,
    alwaysTry: true,
  };
  const gw = await startGateway('', [], {}, config, { keysArg: false });
  try {
    for (let i = 0; i < 4; i++) assert.equal((await gw.chat()).status, 500);
    const key = (await gw.health()).providers
      .find(provider => provider.id === 'alpha').keys[0];
    assert.equal(key.alwaysTry, true);
    assert.equal(key.invalid, false);
    assert.equal(key.unhealthy, true);
    assert.equal(key.state, 'unhealthy');
    assert.equal(key.failureCount, 4);
    assert.match(key.lastError, /alwaysTry retained after 4 failures/);
  } finally {
    await gw.stop();
  }
});

test('alwaysTry keeps an authentication failure eligible for later requests', async () => {
  const config = multiProviderConfig();
  config.providers[0].keys[0] = {
    name: 'alpha-key',
    key: 'sk-alpha-401',
    weight: 1,
    enabled: true,
    alwaysTry: true,
  };
  const gw = await startGateway('', [], {}, config, { keysArg: false });
  try {
    assert.equal((await gw.chat()).status, 401);
    assert.equal((await gw.chat()).status, 401);
    const key = (await gw.health()).providers
      .find(provider => provider.id === 'alpha').keys[0];
    assert.equal(key.invalid, false);
    assert.equal(key.unhealthy, true);
    assert.equal(key.failureCount, 2);
    assert.match(key.lastError, /retained by alwaysTry/);
  } finally {
    await gw.stop();
  }
});

test('alwaysTry still respects 429 cooldown', async () => {
  const config = multiProviderConfig({ cooldownMs: 5000 });
  config.providers[0].keys[0] = {
    name: 'alpha-key',
    key: 'sk-alpha-429',
    weight: 1,
    enabled: true,
    alwaysTry: true,
  };
  const gw = await startGateway('', [], {}, config, { keysArg: false });
  try {
    assert.equal((await gw.chat()).status, 429);
    const key = (await gw.health()).providers
      .find(provider => provider.id === 'alpha').keys[0];
    assert.equal(key.state, 'cooldown');
    assert.ok(key.cooldownSec > 0);
    assert.equal((await gw.chat()).status, 502);
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

test('setup mode serves management UI and activates the first provider atomically', async () => {
  const gw = await startGateway('', [], {}, {
    schemaVersion: 2,
    setupPending: true,
    defaultProvider: '',
    defaultModel: '',
    providers: [],
  }, { keysArg: false });
  try {
    const initialHealth = await gw.health();
    assert.equal(initialHealth.setupRequired, true);
    assert.equal(initialHealth.upstream, 'mock');
    assert.deepEqual(initialHealth.providers, []);

    const initialProviders = await gw.providers();
    assert.equal(initialProviders.setupPending, true);
    assert.deepEqual(initialProviders.providers, []);

    const blockedProxy = await gw.chat({ model: 'alpha--chat' });
    assert.equal(blockedProxy.status, 503);
    assert.match(blockedProxy.text, /gateway setup required/);

    const blockedCodex = await fetch(`${gw.base}/api/codex/config`);
    assert.equal(blockedCodex.status, 409);
    assert.match(await blockedCodex.text(), /complete gateway setup/);

    const settings = await gw.settings({
      method: 'PATCH',
      headers: { 'content-type': 'application/json', origin: gw.base },
      body: JSON.stringify({ cooldownMs: 4000 }),
    });
    assert.equal(settings.status, 200, await settings.text());

    const invalidProvider = await fetch(`${gw.base}/api/providers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: gw.base },
      body: JSON.stringify({
        id: 'incomplete',
        name: 'Incomplete',
        baseUrl: 'https://incomplete.example/v1',
        enabled: true,
        models: [{ id: 'chat', name: 'Chat', upstreamModel: 'chat' }],
        keys: [],
      }),
    });
    assert.equal(invalidProvider.status, 400);
    assert.equal((await gw.health()).setupRequired, true);
    assert.equal(JSON.parse(fs.readFileSync(gw.configPath, 'utf8')).setupPending, true);

    const created = await fetch(`${gw.base}/api/providers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: gw.base },
      body: JSON.stringify({
        id: 'alpha',
        name: 'Alpha',
        baseUrl: 'https://alpha.example/v1',
        enabled: true,
        models: [{ id: 'chat', name: 'Chat', upstreamModel: 'alpha-chat' }],
        keys: [{ name: 'primary', key: 'sk-alpha-ok', weight: 1, enabled: true }],
      }),
    });
    const createdText = await created.text();
    assert.equal(created.status, 201, createdText);
    const publicConfig = JSON.parse(createdText);
    assert.equal(publicConfig.setupPending, false);
    assert.equal(publicConfig.defaultProvider, 'alpha');
    assert.equal(publicConfig.defaultModel, 'alpha--chat');

    const readyHealth = await gw.health();
    assert.equal(readyHealth.setupRequired, false);
    assert.equal(readyHealth.defaultProvider, 'alpha');
    assert.equal(readyHealth.providers.length, 1);

    const routed = await gw.chat({ model: 'alpha--chat' });
    assert.equal(routed.status, 200, routed.text);
    assert.equal(JSON.parse(routed.text).gateway_key_name, 'primary');

    const deleteLastProvider = await fetch(`${gw.base}/api/providers/alpha`, {
      method: 'DELETE',
      headers: { origin: gw.base },
    });
    assert.equal(deleteLastProvider.status, 409);
    assert.match(await deleteLastProvider.text(), /at least one provider/);

    const persisted = JSON.parse(fs.readFileSync(gw.configPath, 'utf8'));
    assert.equal(persisted.setupPending, false);
    assert.equal(persisted.cooldownMs, 4000);
    assert.equal(persisted.providers[0].keys[0].key, 'sk-alpha-ok');
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

test('Chat Completions providers adapt Responses JSON and SSE while direct Chat stays passthrough', async () => {
  const upstreamPort = await freePort();
  const requests = [];
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      requests.push({
        url: req.url,
        body,
        ...(req.headers.cookie ? { cookie: req.headers.cookie } : {}),
      });
      if (req.url === '/v1/chat/completions?trace=direct') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          id: 'chatcmpl-direct',
          object: 'chat.completion',
          model: body.model,
          choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'direct' } }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }));
        return;
      }
      if (req.url !== '/v1/chat/completions?trace=adapted') {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `unexpected path ${req.url}` } }));
        return;
      }
      if (!body.stream) {
        const responseBody = JSON.stringify({
          id: 'chatcmpl-json',
          object: 'chat.completion',
          created: 100,
          model: body.model,
          choices: [{
            finish_reason: 'stop',
            message: { role: 'assistant', reasoning_content: 'checked', content: 'adapted json' },
          }],
          usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 },
        });
        res.writeHead(200, {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(responseBody),
          etag: 'upstream-chat-body',
        });
        res.end(responseBody);
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const frames = [
        'data: {"id":"chatcmpl-sse","created":101,"model":"same-upstream-model","choices":[{"delta":{"content":"adapted "}}]}\n\n',
        'data: {"id":"chatcmpl-sse","model":"same-upstream-model","choices":[{"delta":{"content":"stream"},"finish_reason":"stop"}]}\n\n',
        'data: {"id":"chatcmpl-sse","model":"same-upstream-model","choices":[],"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}}\n\n',
        'data: [DONE]\n\n',
      ];
      res.write(frames[0].slice(0, 47));
      res.write(frames[0].slice(47) + frames[1]);
      res.end(frames[2] + frames[3]);
    });
  });
  await new Promise(resolve => upstream.listen(upstreamPort, '127.0.0.1', resolve));

  const config = multiProviderConfig({
    defaultProvider: 'alpha',
    defaultModel: 'alpha--shared',
    providers: [{
      id: 'alpha',
      name: 'Alpha Chat',
      baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
      upstreamFormat: 'chat-completions',
      supportsPromptCacheKey: true,
      enabled: true,
      models: [{
        id: 'shared',
        name: 'Shared',
        upstreamModel: 'same-upstream-model',
        reasoning: {
          parameter: 'thinking_budget',
          default: 'high',
          levels: [
            { effort: 'low', upstreamValue: 1024 },
            { effort: 'high', upstreamValue: 8192 },
          ],
        },
      }],
      keys: [{ name: 'alpha-key', key: 'sk-alpha', weight: 1, enabled: true }],
    }],
  });
  const gw = await startGateway('', [], {}, config, { mock: false, keysArg: false });
  try {
    const nonStream = await gw.responses({
      model: 'alpha--shared',
      instructions: 'Use tools carefully.',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'inspect' }] }],
      reasoning: { effort: 'high' },
    }, { cookie: 'dsgw=must-not-reach-upstream' }, '?trace=adapted');
    assert.equal(nonStream.status, 200, nonStream.text);
    assert.equal(nonStream.headers.get('x-gateway-provider'), 'alpha');
    assert.equal(nonStream.headers.get('content-encoding'), null);
    assert.equal(nonStream.headers.get('etag'), null);
    const response = JSON.parse(nonStream.text);
    assert.equal(response.object, 'response');
    assert.deepEqual(response.output.map(item => item.type), ['reasoning', 'message']);
    assert.equal(response.output[1].content[0].text, 'adapted json');
    assert.equal(response.usage.total_tokens, 7);
    assert.equal((await gw.health()).providers[0].upstreamFormat, 'chat-completions');

    assert.equal(requests[0].url, '/v1/chat/completions?trace=adapted');
    assert.equal(requests[0].body.model, 'same-upstream-model');
    assert.equal(requests[0].body.thinking_budget, 8192);
    assert.equal(requests[0].body.reasoning_effort, undefined);
    assert.deepEqual(requests[0].body.messages.map(message => message.role), ['system', 'user']);
    assert.equal(requests[0].cookie, undefined);

    const compact = await fetch(`${gw.base}/v1/responses/compact?trace=adapted`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'alpha--shared',
        input: 'compact',
        prompt_cache_key: 'stable-project-session',
      }),
    });
    assert.equal(compact.status, 200, await compact.clone().text());
    assert.equal((await compact.json()).object, 'response');
    assert.equal(requests.at(-1).url, '/v1/chat/completions?trace=adapted');
    assert.equal(requests.at(-1).body.prompt_cache_key, 'stable-project-session');

    const stream = await gw.responses({ model: 'alpha--shared', input: 'stream', stream: true }, {}, '?trace=adapted');
    assert.equal(stream.status, 200, stream.text);
    assert.match(stream.headers.get('content-type'), /text\/event-stream/);
    assert.match(stream.text, /"type":"response\.output_text\.delta"/);
    assert.match(stream.text, /"delta":"adapted "/);
    assert.equal((stream.text.match(/event: response\.completed/g) || []).length, 1);
    assert.doesNotMatch(stream.text, /data: \[DONE\]/);

    const direct = await fetch(`${gw.base}/v1/chat/completions?trace=direct`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'alpha--shared', messages: [{ role: 'user', content: 'direct' }] }),
    });
    const directBody = await direct.json();
    assert.equal(direct.status, 200);
    assert.equal(directBody.object, 'chat.completion');
    assert.equal(directBody.choices[0].message.content, 'direct');
    assert.equal(requests.at(-1).url, '/v1/chat/completions?trace=direct');

    const webSearchFiltered = await gw.responses({
      model: 'alpha--shared',
      input: 'search',
      tools: [{ type: 'web_search' }],
      tool_choice: { type: 'web_search' },
      parallel_tool_calls: true,
    }, {}, '?trace=adapted');
    assert.equal(webSearchFiltered.status, 200, webSearchFiltered.text);
    assert.equal(requests.at(-1).url, '/v1/chat/completions?trace=adapted');
    assert.equal(requests.at(-1).body.tools, undefined);
    assert.equal(requests.at(-1).body.tool_choice, undefined);
    assert.equal(requests.at(-1).body.parallel_tool_calls, undefined);

    const agentMessage = await gw.responses({
      model: 'alpha--shared',
      input: [{
        type: 'agent_message',
        id: 'amsg_chat_task',
        author: '/root',
        recipient: '/root/child',
        content: [
          { type: 'input_text', text: 'Message Type: NEW_TASK\nPayload:\n' },
          { type: 'encrypted_content', encrypted_content: 'CHAT-SUBAGENT-9502' },
        ],
      }],
    }, {}, '?trace=adapted');
    assert.equal(agentMessage.status, 200, agentMessage.text);
    const agentRequest = requests.at(-1).body;
    assert.equal(agentRequest.messages[0].role, 'user');
    assert.match(agentRequest.messages[0].content, /Message Type: NEW_TASK/);
    assert.match(agentRequest.messages[0].content, /CHAT-SUBAGENT-9502/);
    assert.doesNotMatch(JSON.stringify(agentRequest), /agent_message|encrypted_content/);
  } finally {
    await gw.stop();
    await new Promise(resolve => upstream.close(resolve));
  }
});

test('compressed Codex requests are decoded and stale encoding headers are removed', async () => {
  const upstreamPort = await freePort();
  const requests = [];
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      requests.push({
        url: req.url,
        headers: req.headers,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'resp-compressed',
        object: 'response',
        status: 'completed',
        output: [],
      }));
    });
  });
  await new Promise(resolve => upstream.listen(upstreamPort, '127.0.0.1', resolve));
  const config = multiProviderConfig();
  config.providers[0].baseUrl = `http://127.0.0.1:${upstreamPort}/v1`;
  const gw = await startGateway('', [], {}, config, { keysArg: false, mock: false });
  try {
    const payload = Buffer.from(JSON.stringify({
      model: 'alpha--shared',
      input: 'compressed',
    }));
    const response = await fetch(`${gw.base}/v1/responses/compact?trace=zstd`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-encoding': 'zstd',
      },
      body: zlib.zstdCompressSync(payload),
    });
    assert.equal(response.status, 200, await response.text());
    assert.equal(requests[0].url, '/v1/responses/compact?trace=zstd');
    assert.equal(requests[0].body.model, 'same-upstream-model');
    assert.equal(requests[0].headers['content-encoding'], undefined);
    assert.equal(
      Number(requests[0].headers['content-length']),
      Buffer.byteLength(JSON.stringify(requests[0].body)),
    );

    const malformed = await fetch(`${gw.base}/v1/responses`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-encoding': 'gzip',
      },
      body: Buffer.from('invalid'),
    });
    assert.equal(malformed.status, 400);
    assert.match(await malformed.text(), /invalid compressed request body/);
  } finally {
    await gw.stop();
    await new Promise(resolve => upstream.close(resolve));
  }
});

test('Responses providers normalize agent messages by default and allow explicit native passthrough', async () => {
  const upstreamPort = await freePort();
  const requests = [];
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      requests.push({ url: req.url, raw, body: JSON.parse(raw) });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'resp_native',
        object: 'response',
        status: 'completed',
        model: requests.at(-1).body.model,
        output: [],
        usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 },
      }));
    });
  });
  await new Promise(resolve => upstream.listen(upstreamPort, '127.0.0.1', resolve));

  const config = multiProviderConfig({
    defaultProvider: 'alpha',
    defaultModel: 'alpha--shared',
    providers: [
      {
        id: 'alpha',
        name: 'Compatible Responses',
        baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
        upstreamFormat: 'responses',
        enabled: true,
        models: [{ id: 'shared', name: 'Shared', upstreamModel: 'same-upstream-model' }],
        keys: [{ name: 'alpha-key', key: 'sk-alpha', weight: 1 }],
      },
      {
        id: 'beta',
        name: 'Native Responses',
        baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
        upstreamFormat: 'responses',
        supportsEncryptedAgentMessages: true,
        enabled: true,
        models: [{ id: 'shared', name: 'Shared', upstreamModel: 'same-upstream-model' }],
        keys: [{ name: 'beta-key', key: 'sk-beta', weight: 1 }],
      },
    ],
  });
  const agentInput = [{
    type: 'agent_message',
    id: 'amsg_native_task',
    author: '/root',
    recipient: '/root/child',
    content: [
      { type: 'input_text', text: 'Message Type: NEW_TASK\nPayload:\n' },
      { type: 'encrypted_content', encrypted_content: 'NATIVE-SUBAGENT-9502' },
    ],
  }];
  const gw = await startGateway('', [], {}, config, { mock: false, keysArg: false });
  try {
    const compatible = await gw.responses({
      model: 'alpha--shared',
      input: agentInput,
    }, {}, '?trace=compatible');
    assert.equal(compatible.status, 200, compatible.text);

    const native = await gw.responses({
      model: 'beta--shared',
      input: agentInput,
    }, {}, '?trace=native');
    assert.equal(native.status, 200, native.text);

    assert.equal(requests[0].url, '/v1/responses?trace=compatible');
    assert.deepEqual(requests[0].body, {
      model: 'same-upstream-model',
      input: [{
        type: 'message',
        role: 'user',
        id: 'amsg_native_task',
        content: [
          { type: 'input_text', text: 'Message Type: NEW_TASK\nPayload:\n' },
          { type: 'input_text', text: 'NATIVE-SUBAGENT-9502' },
        ],
      }],
    });
    assert.equal(requests[1].url, '/v1/responses?trace=native');
    assert.deepEqual(requests[1].body, {
      model: 'same-upstream-model',
      input: agentInput,
    });

    const publicConfig = await gw.providers();
    assert.equal(publicConfig.providers[0].supportsEncryptedAgentMessages, false);
    assert.equal(publicConfig.providers[1].supportsEncryptedAgentMessages, true);
  } finally {
    await gw.stop();
    await new Promise(resolve => upstream.close(resolve));
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
    const unknownCodex = await gw.chat({ model: 'Missing.shared' });
    assert.equal(unknownCodex.status, 400);
    assert.match(unknownCodex.text, /unknown or disabled model alias/);
    const unknownNumericCodex = await gw.chat({ model: '1missing.shared' });
    assert.equal(unknownNumericCodex.status, 400);
    assert.match(unknownNumericCodex.text, /unknown or disabled model alias/);
    const legacy = await gw.chat({ model: 'same-upstream-model' });
    assert.equal(legacy.status, 200);
    assert.equal(legacy.headers.get('x-gateway-provider'), 'alpha');
    assert.equal(JSON.parse(legacy.text).gateway_key_name, 'alpha-key');
  } finally {
    await gw.stop();
  }
});

test('Codex dotted aliases route Responses requests to the matching provider model', async () => {
  const config = multiProviderConfig({
    defaultProvider: 'routify',
    defaultModel: 'routify--deepseek-v4-flash',
    providers: [{
      id: 'routify',
      name: 'Routify',
      baseUrl: 'https://routify.example/v1',
      enabled: true,
      models: [{
        id: 'deepseek-v4-flash',
        name: 'deepseek-v4-flash',
        upstreamModel: 'deepseek-v4-flash',
      }],
      keys: [{ name: 'routify-key', key: 'sk-routify-ok', weight: 1 }],
    }],
  });
  const gw = await startGateway('', [], {}, config, { keysArg: false });
  try {
    const routed = await gw.responses({
      model: 'Routify.deepseek-v4-flash',
      input: 'hello',
    });
    assert.equal(routed.status, 200, routed.text);
    assert.equal(routed.headers.get('x-gateway-provider'), 'routify');
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
        upstreamFormat: 'chat-completions',
        supportsPromptCacheKey: true,
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
    assert.equal(gamma.supportsPromptCacheKey, true);

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

test('operations API aggregates usage and restores provider configuration', async () => {
  const original = multiProviderConfig({ cooldownMs: 1200 });
  const gw = await startGateway('', [], {}, original, { keysArg: false });
  try {
    const response = await gw.chat({ model: 'alpha--shared' });
    assert.equal(response.status, 200);
    await new Promise(resolve => setTimeout(resolve, 250));
    const usage = await gw.operation('/api/usage?range=30d');
    assert.equal(usage.status, 200);
    const usageBody = await usage.json();
    assert.equal(usageBody.total.requests, 1);
    assert.equal(usageBody.total.tokens, 15);

    const backupResponse = await gw.operation('/api/storage', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: gw.base },
      body: JSON.stringify({ action: 'backup' }),
    });
    assert.equal(backupResponse.status, 201);
    const backup = await backupResponse.json();
    const changed = await fetch(`${gw.base}/api/providers/alpha`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', origin: gw.base },
      body: JSON.stringify({ name: 'Changed Alpha', expectedRevision: (await gw.providers()).revision }),
    });
    assert.equal(changed.status, 200, await changed.text());
    assert.equal((await gw.providers()).providers[0].name, 'Changed Alpha');

    const restored = await gw.operation('/api/storage', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: gw.base },
      body: JSON.stringify({ action: 'restore', id: backup.id }),
    });
    assert.equal(restored.status, 200, await restored.text());
    assert.equal((await gw.providers()).providers[0].name, 'Alpha');
    const settings = await gw.settings({ headers: { authorization: `Bearer ${original.adminToken}` } });
    assert.equal((await settings.json()).effective.cooldownMs, 1200);
  } finally {
    await gw.stop();
  }
});

test('native Codex agents project TOML without changing gateway model routing', async () => {
  const upstreamPort = await freePort();
  const upstreamRequests = [];
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    upstreamRequests.push({
      url: req.url,
      body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
    });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'chatcmpl-native',
      object: 'chat.completion',
      model: 'upstream-agent-model',
      choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'ordinary model ok' } }],
      usage: { prompt_tokens: 4, completion_tokens: 5, total_tokens: 9 },
    }));
  });
  await new Promise(resolve => upstream.listen(upstreamPort, '127.0.0.1', resolve));
  const config = multiProviderConfig({
    providers: [{
      id: 'alpha',
      name: 'Alpha',
      baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
      upstreamFormat: 'chat-completions',
      enabled: true,
      models: [{ id: 'shared', name: 'Shared', upstreamModel: 'upstream-agent-model' }],
      keys: [{ name: 'alpha-key', key: 'sk-alpha', weight: 1 }],
    }],
    defaultProvider: 'alpha',
    defaultModel: 'alpha--shared',
  });
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-codex-home-'));
  const gw = await startGateway('', [], { CODEX_HOME: codexHome }, config, { mock: false, keysArg: false });
  try {
    const createdResponse = await gw.operation('/api/subagents', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: gw.base },
      body: JSON.stringify({
        name: 'code_reviewer',
        description: 'Reviews correctness and security.',
        providerId: 'alpha',
        model: 'alpha--shared',
        developerInstructions: 'Review correctness, security, and missing tests.',
        enabled: true,
      }),
    });
    const createdText = await createdResponse.text();
    assert.equal(createdResponse.status, 201, createdText);
    const agent = JSON.parse(createdText).subagent;
    assert.equal(agent.name, 'code_reviewer');
    const agentFile = path.join(codexHome, 'agents', 'code_reviewer.toml');
    assert.match(fs.readFileSync(agentFile, 'utf8'), /^name = "code_reviewer"/m);
    assert.match(fs.readFileSync(agentFile, 'utf8'), /^description = /m);
    assert.match(fs.readFileSync(agentFile, 'utf8'), /^model = "Alpha\.shared"/m);
    assert.match(fs.readFileSync(agentFile, 'utf8'), /developer_instructions/);

    const modelsResponse = await fetch(`${gw.base}/v1/models`);
    assert.equal(modelsResponse.status, 200);
    const models = await modelsResponse.json();
    assert.ok(models.data.some(model => model.id === 'Alpha.shared'));
    assert.equal(models.data.some(model => model.id.startsWith('agent--')), false);
    assert.deepEqual(
      models.data.find(model => model.id === 'Alpha.shared').input_modalities,
      ['text', 'image'],
    );

    const response = await gw.responses({
      model: 'Alpha.shared',
      instructions: 'Keep the client requirements.',
      input: [{ role: 'user', content: 'Inspect this patch.' }],
    });
    assert.equal(response.status, 200, response.text);
    assert.equal(response.headers.get('x-gateway-agent'), null);
    assert.equal(JSON.parse(response.text).output[0].content[0].text, 'ordinary model ok');
    assert.equal(upstreamRequests[0].url, '/v1/chat/completions');
    assert.equal(upstreamRequests[0].body.model, 'upstream-agent-model');
    assert.deepEqual(upstreamRequests[0].body.messages.map(message => message.role), ['system', 'user']);
    assert.match(upstreamRequests[0].body.messages[0].content, /Keep the client requirements/);
    assert.doesNotMatch(upstreamRequests[0].body.messages[0].content, /Review correctness/);

    const chatResponse = await gw.chat({
      model: 'Alpha.shared',
      messages: [
        { role: 'system', content: 'Client system message.' },
        { role: 'user', content: 'Review directly.' },
      ],
    });
    assert.equal(chatResponse.status, 200, chatResponse.text);
    assert.deepEqual(upstreamRequests[1].body.messages.map(message => message.role), ['system', 'user']);
    assert.equal(upstreamRequests[1].body.messages[0].content, 'Client system message.');

    const catalogResponse = await gw.operation('/api/codex/config');
    const catalogText = await catalogResponse.text();
    assert.equal(catalogResponse.status, 200, catalogText);
    const catalog = JSON.parse(catalogText);
    assert.deepEqual(catalog.catalog.models.map(model => model.slug), ['Alpha.shared']);

    const disabledResponse = await gw.operation(`/api/subagents/${agent.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', origin: gw.base },
      body: JSON.stringify({ ...agent, enabled: false }),
    });
    const disabledText = await disabledResponse.text();
    assert.equal(disabledResponse.status, 200, disabledText);
    assert.equal(fs.existsSync(agentFile), false);
  } finally {
    await gw.stop();
    await new Promise(resolve => upstream.close(resolve));
    fs.rmSync(codexHome, { recursive: true, force: true });
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
  const adminAuth = { authorization: `Bearer ${config.adminToken}` };
  const inferenceAuth = { authorization: 'Bearer stored-gateway-secret' };
  try {
    const initial = await gw.settings({ headers: adminAuth });
    const initialText = await initial.text();
    assert.equal(initial.status, 200);
    assert.ok(!initialText.includes('stored-gateway-secret'));
    const initialSettings = JSON.parse(initialText);
    assert.equal(initialSettings.persisted.tokenConfigured, true);
    assert.equal(initialSettings.effective.tokenConfigured, true);
    assert.equal(initialSettings.persisted.token, undefined);

    const updated = await gw.settings({
      method: 'PATCH',
      headers: { ...adminAuth, 'content-type': 'application/json', origin: gw.base },
      body: JSON.stringify({ cooldownMs: 4000, maxRetries: 1, timeoutMs: 2500 }),
    });
    const updatedText = await updated.text();
    assert.equal(updated.status, 200, updatedText);
    const settings = JSON.parse(updatedText);
    assert.equal(settings.effective.cooldownMs, 4000);
    assert.equal(settings.effective.maxRetries, 1);
    assert.equal(settings.effective.timeoutMs, 2500);

    const routed = await gw.chat({ model: 'alpha--shared' }, inferenceAuth);
    assert.equal(routed.status, 200);
    assert.equal(JSON.parse(routed.text).gateway_key_name, 'healthy');
    const health = await fetch(`${gw.base}/health`, { headers: inferenceAuth }).then(response => response.json());
    const limited = health.providers.find(provider => provider.id === 'alpha').keys.find(key => key.name === 'limited');
    assert.equal(limited.state, 'cooldown');
    assert.ok(limited.cooldownSec <= 4);
  } finally {
    await gw.stop();
  }
});

test('settings API persists restart-only values and rejects cross-origin writes', async () => {
  const adminToken = 'settings-admin-token';
  const gw = await startGateway('', [], {}, multiProviderConfig({
    token: 'settings-gateway-token',
    adminToken,
  }), { keysArg: false });
  try {
    const rejected = await gw.settings({
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        origin: 'https://evil.example',
        authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({ host: '0.0.0.0' }),
    });
    assert.equal(rejected.status, 403);

    const response = await gw.settings({
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        origin: gw.base,
        authorization: `Bearer ${adminToken}`,
      },
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
      body: JSON.stringify({
        token: 'rotated-gateway-secret',
        adminToken: 'rotated-admin-secret-1234',
      }),
    });
    const setText = await setToken.text();
    assert.equal(setToken.status, 200);
    assert.ok(!setText.includes('rotated-gateway-secret'));
    assert.ok(!setText.includes('rotated-admin-secret-1234'));
    assert.equal(JSON.parse(setText).effective.tokenConfigured, true);
    assert.equal(JSON.parse(setText).effective.adminTokenConfigured, true);
    const setCookie = setToken.headers.get('set-cookie');
    assert.match(setCookie || '', /dsgw=v1\./);
    const browserCookie = setCookie.split(';', 1)[0];
    assert.equal((await gw.settings()).status, 401);

    const authenticated = await gw.settings({ headers: { cookie: browserCookie } });
    const authenticatedText = await authenticated.text();
    assert.equal(authenticated.status, 200);
    assert.ok(!authenticatedText.includes('rotated-gateway-secret'));

    const cleared = await gw.settings({
      method: 'PATCH',
      headers: { cookie: browserCookie, 'content-type': 'application/json', origin: gw.base },
      body: JSON.stringify({ clearToken: true }),
    });
    const clearedText = await cleared.text();
    assert.equal(cleared.status, 200, clearedText);
    assert.equal(JSON.parse(clearedText).effective.tokenConfigured, false);
    assert.doesNotMatch(cleared.headers.get('set-cookie') || '', /Max-Age=0/);
    assert.equal(JSON.parse(fs.readFileSync(gw.configPath, 'utf8')).token, '');
    assert.equal((await gw.settings()).status, 401);
    assert.equal((await gw.settings({ headers: { cookie: browserCookie } })).status, 200);
  } finally {
    await gw.stop();
  }
});

test('unauthenticated local management rejects non-loopback Host headers', async () => {
  const gw = await startGateway('', [], {}, multiProviderConfig(), { keysArg: false });
  try {
    const target = new URL(gw.base);
    const result = await new Promise((resolve, reject) => {
      const req = http.request({
        hostname: target.hostname,
        port: target.port,
        path: '/api/providers',
        method: 'GET',
        headers: { host: `attacker.example:${target.port}` },
      }, res => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => resolve({
          status: res.statusCode,
          body: Buffer.concat(chunks).toString('utf8'),
        }));
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(result.status, 403);
    assert.match(result.body, /untrusted management host/);
  } finally {
    await gw.stop();
  }
});

test('model discovery proxies OpenAI-compatible endpoints and normalizes upstream model ids', async () => {
  const upstreamPort = await freePort();
  const requests = [];
  const upstream = http.createServer((req, res) => {
    requests.push({ path: req.url, authorization: req.headers.authorization });
    if (req.url === '/leak/models') {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end(`reflected ${req.headers.authorization}`);
      return;
    }
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
        {
          id: 'Qwen/Qwen3-235B-A22B-Instruct',
          owned_by: 'qwen',
          architecture: { input_modalities: ['text'] },
        },
        { id: 'gpt-4o-mini', owned_by: 'openai' },
        {
          id: 'claude/3.5-sonnet',
          name: 'Claude 3.5 Sonnet',
          supports_image: false,
        },
      ],
    }));
  });
  await new Promise(resolve => upstream.listen(upstreamPort, '127.0.0.1', resolve));
  const config = multiProviderConfig();
  config.providers[0].baseUrl = `http://127.0.0.1:${upstreamPort}/anthropic`;
  const gw = await startGateway('', [], {}, config, { keysArg: false });
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
      'claude/3.5-sonnet',
      'gpt-4o-mini',
      'qwen/qwen3-235b-a22b-instruct',
    ]);
    assert.equal(payload.models[2].ownedBy, 'qwen');
    assert.equal(payload.models[0].name, 'Claude 3.5 Sonnet');
    assert.deepEqual(payload.models.map(model => model.inputModalities), [
      ['text'],
      ['text', 'image'],
      ['text'],
    ]);
    assert.deepEqual(payload.models.map(model => model.capabilitySource), [
      'upstream',
      'default',
      'upstream',
    ]);
    assert.equal(payload.models[0].reasoning, undefined);
    assert.equal(payload.models[1].reasoning, undefined);
    assert.ok(!JSON.stringify(payload).includes(secret));

    const capabilitiesResponse = await fetch(`${gw.base}/api/model-capabilities`);
    assert.equal(capabilitiesResponse.status, 200);
    const capabilities = await capabilitiesResponse.json();
    assert.deepEqual(capabilities.unknownModel.inputModalities, ['text', 'image']);
    assert.ok(capabilities.models.some(model => (
      model.id === 'deepseek-v4-pro'
      && JSON.stringify(model.inputModalities) === JSON.stringify(['text'])
    )));
    assert.deepEqual(
      capabilities.models.find(model => model.id === 'deepseek-v4-pro').reasoning,
      {
        parameter: 'reasoning_effort',
        default: 'high',
        levels: [
          { effort: 'low', description: 'Fast responses with lighter reasoning' },
          { effort: 'high', description: 'Extra high reasoning depth for complex problems' },
          { effort: 'max', description: 'Maximum reasoning depth for the hardest problems' },
        ],
      },
    );

    const providerKeyResponse = await fetch(`${gw.base}/api/models`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: gw.base },
      body: JSON.stringify({ providerId: 'alpha' }),
    });
    assert.equal(providerKeyResponse.status, 200, await providerKeyResponse.text());

    const crossOriginResponse = await fetch(`${gw.base}/api/models`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: gw.base },
      body: JSON.stringify({
        providerId: 'alpha',
        baseUrl: `http://localhost:${upstreamPort}/anthropic`,
      }),
    });
    assert.equal(crossOriginResponse.status, 400);
    assert.match(await crossOriginResponse.text(), /explicit API key/);
    assert.deepEqual(requests, [
      { path: '/anthropic/v1/models', authorization: `Bearer ${secret}` },
      { path: '/v1/models', authorization: `Bearer ${secret}` },
      { path: '/anthropic/v1/models', authorization: 'Bearer sk-alpha-ok' },
      { path: '/v1/models', authorization: 'Bearer sk-alpha-ok' },
    ]);

    const reflected = await fetch(`${gw.base}/api/models`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: gw.base },
      body: JSON.stringify({
        providerId: 'alpha',
        modelsUrl: `http://127.0.0.1:${upstreamPort}/leak/models`,
      }),
    });
    const reflectedText = await reflected.text();
    assert.equal(reflected.status, 500);
    assert.doesNotMatch(reflectedText, /sk-alpha-ok|Bearer/);
    assert.match(reflectedText, /model endpoint returned HTTP 500/);
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

test('key import API adds a batch atomically, ignores duplicate secrets, and redacts output', async () => {
  const gw = await startGateway('', [], {}, multiProviderConfig({ maxRetries: 0 }), { keysArg: false });
  try {
    const response = await fetch(`${gw.base}/api/providers/alpha/keys/import`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: gw.base },
      body: JSON.stringify({
        keysText: 'sk-alpha-ok\nimported=sk-imported-ok\nsk-auto-ok',
        defaults: { weight: 2, enabled: true, alwaysTry: true },
      }),
    });
    const responseText = await response.text();
    assert.equal(response.status, 200, responseText);
    assert.ok(!responseText.includes('sk-alpha-ok'));
    assert.ok(!responseText.includes('sk-imported-ok'));
    assert.deepEqual(JSON.parse(responseText), {
      addedCount: 2,
      ignoredCount: 1,
      ignored: [{ entry: 1, name: null, reason: 'duplicate-secret' }],
      totalCount: 3,
    });

    const health = await gw.health();
    const alpha = health.providers.find(provider => provider.id === 'alpha');
    assert.deepEqual(alpha.keys.map(key => key.name), ['alpha-key', 'imported', 'imported-1']);
    assert.equal(alpha.keys.find(key => key.name === 'imported').alwaysTry, true);
    assert.equal(alpha.keys.find(key => key.name === 'imported').weight, 2);

    const tested = await fetch(`${gw.base}/api/providers/alpha/keys/imported/test`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: gw.base },
      body: '{}',
    });
    assert.equal(tested.status, 200, await tested.text());

    const beforeConflict = fs.readFileSync(gw.configPath, 'utf8');
    const conflict = await fetch(`${gw.base}/api/providers/alpha/keys/import`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: gw.base },
      body: JSON.stringify({ keysText: 'alpha-key=sk-different\nsk-must-not-persist' }),
    });
    assert.equal(conflict.status, 409);
    assert.match(await conflict.text(), /already exists with a different secret/);
    assert.equal(fs.readFileSync(gw.configPath, 'utf8'), beforeConflict);

    const persisted = JSON.parse(beforeConflict);
    const keys = persisted.providers.find(provider => provider.id === 'alpha').keys;
    assert.deepEqual(keys.map(key => key.name), ['alpha-key', 'imported', 'imported-1']);
    assert.equal(keys.find(key => key.name === 'imported').key, 'sk-imported-ok');
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
      body: JSON.stringify({ enabled: true, weight: 3, alwaysTry: true }),
    });
    const updateText = await update.text();
    assert.equal(update.status, 200, updateText);
    const updatedPublicKey = JSON.parse(updateText).providers
      .find(provider => provider.id === 'alpha').keys
      .find(key => key.name === 'alpha-key');
    assert.equal(updatedPublicKey.alwaysTry, true);

    const updatedHealthKey = (await gw.health()).providers
      .find(provider => provider.id === 'alpha').keys
      .find(key => key.name === 'alpha-key');
    assert.equal(updatedHealthKey.alwaysTry, true);

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
    assert.equal(persistedKeys[0].alwaysTry, true);
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

test('provider editor revisions reject stale masked key snapshots', async () => {
  const gw = await startGateway('', [], {}, multiProviderConfig(), { keysArg: false });
  try {
    const initial = await gw.providers();
    assert.ok(Number.isSafeInteger(initial.revision));
    assert.ok(initial.revision > 0);
    const updated = await fetch(`${gw.base}/api/providers/alpha`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', origin: gw.base },
      body: JSON.stringify({
        name: 'Alpha updated elsewhere',
        expectedRevision: initial.revision,
      }),
    });
    const updatedPayload = await updated.json();
    assert.equal(updated.status, 200);
    assert.equal(updatedPayload.revision, initial.revision + 1);

    const stale = await fetch(`${gw.base}/api/providers/alpha`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', origin: gw.base },
      body: JSON.stringify({
        name: 'Stale editor',
        expectedRevision: initial.revision,
        keys: [{
          name: 'alpha-key',
          originalName: 'alpha-key',
          key: '',
          weight: 1,
          enabled: true,
        }],
      }),
    });
    assert.equal(stale.status, 409);
    assert.match(await stale.text(), /changed; refresh before saving/);
    const current = await gw.providers();
    assert.equal(current.providers[0].name, 'Alpha updated elsewhere');
    assert.deepEqual(current.providers[0].keys.map(key => key.name), ['alpha-key']);
  } finally {
    await gw.stop();
  }
});

test('provider origin changes cannot carry existing secrets implicitly', async () => {
  const gw = await startGateway('', [], {}, multiProviderConfig(), { keysArg: false });
  try {
    const initial = await gw.providers();
    const response = await fetch(`${gw.base}/api/providers/alpha`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', origin: gw.base },
      body: JSON.stringify({
        baseUrl: 'https://attacker.example/v1',
        expectedRevision: initial.revision,
      }),
    });
    assert.equal(response.status, 400);
    assert.match(await response.text(), /keys must be supplied when changing provider origin/);

    const current = await gw.providers();
    assert.equal(new URL(current.providers[0].baseUrl).origin, 'https://alpha.example');
    assert.equal(current.revision, initial.revision);
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

    const beforeUpdate = await gw.providers();
    const updated = await fetch(`${gw.base}/api/providers/alpha`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', origin: gw.base },
      body: JSON.stringify({
        baseUrl: `http://127.0.0.1:${newPort}`,
        expectedRevision: beforeUpdate.revision,
        keys: [{ name: 'alpha-key', key: 'sk-alpha-ok', weight: 1 }],
      }),
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

test('generated Codex artifacts omit env auth when the gateway has no token', async () => {
  const config = multiProviderConfig();
  config.providers[0].models[0].supportsHostedWebSearch = true;
  config.providers[1].upstreamFormat = 'chat-completions';
  config.providers[1].models[0] = {
    id: 'gpt-4.1',
    name: 'GPT 4.1',
    upstreamModel: 'gpt-4.1',
    inputModalities: ['text', 'image'],
  };
  const gw = await startGateway('', [], {}, config, { keysArg: false });
  try {
    const routed = await gw.chat({ model: 'beta--gpt-4.1' });
    assert.equal(routed.status, 200, routed.text);
    assert.equal(routed.headers.get('x-gateway-provider'), 'beta');
    const dotted = await gw.chat({ model: 'Beta.gpt-4.1' });
    assert.equal(dotted.status, 200, dotted.text);
    assert.equal(dotted.headers.get('x-gateway-provider'), 'beta');

    const response = await fetch(`${gw.base}/api/codex/config`);
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.ok(!text.includes('sk-alpha-ok'));
    assert.ok(!text.includes('sk-beta-ok'));
    const artifacts = JSON.parse(text);
    assert.equal(artifacts.providerId, 'multi-provider-gateway');
    assert.match(artifacts.revision, /^[a-f0-9]{64}$/);
    assert.equal(artifacts.authRequired, false);
    assert.equal(artifacts.envKey, null);
    assert.equal(artifacts.defaultModel, 'Alpha.shared');
    assert.match(artifacts.configToml, /model_provider = "multi-provider-gateway"/);
    assert.doesNotMatch(artifacts.configToml, /env_key/);
    assert.doesNotMatch(artifacts.configToml, /experimental_bearer_token/);
    assert.equal((artifacts.configToml.match(/\[model_providers\./g) || []).length, 1);
    const catalog = JSON.parse(artifacts.catalogJson);
    const aliases = catalog.models.map(model => model.slug);
    assert.deepEqual(aliases, ['Alpha.shared', 'Beta.gpt-4.1']);
    assert.deepEqual(catalog.models.map(model => model.display_name), [
      'Alpha.shared',
      'Beta.gpt-4.1',
    ]);
    assert.deepEqual(catalog.models.map(model => model.input_modalities), [
      ['text', 'image'],
      ['text', 'image'],
    ]);
    assert.equal(catalog.models[0].web_search_tool_type, 'text');
    assert.equal(catalog.models[1].web_search_tool_type, undefined);
  } finally {
    await gw.stop();
  }
});

test('generated Codex artifacts use the effective runtime gateway token state', async () => {
  const gw = await startGateway('', [], {
    DS_GATEWAY_TOKEN: 'runtime-gateway-secret',
    DS_GATEWAY_ADMIN_TOKEN: 'runtime-admin-secret-1234',
  }, multiProviderConfig(), { keysArg: false });
  const auth = { authorization: 'Bearer runtime-admin-secret-1234' };
  try {
    const settingsResponse = await gw.settings({ headers: auth });
    assert.equal(settingsResponse.status, 200);
    const settings = await settingsResponse.json();
    assert.equal(settings.persisted.tokenConfigured, false);
    assert.equal(settings.effective.tokenConfigured, true);
    assert.equal(settings.overrides.token, 'DS_GATEWAY_TOKEN');

    const response = await fetch(`${gw.base}/api/codex/config`, { headers: auth });
    assert.equal(response.status, 200);
    const artifacts = await response.json();
    assert.equal(artifacts.authRequired, true);
    assert.equal(artifacts.envKey, 'DEEPSEEK_GATEWAY_TOKEN');
    assert.match(artifacts.configToml, /env_key = "DEEPSEEK_GATEWAY_TOKEN"/);
  } finally {
    await gw.stop();
  }
});

test('Codex config auth mode can override offline token detection', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-codex-auth-'));
  const configPath = path.join(directory, 'keys.json');
  try {
    fs.writeFileSync(configPath, JSON.stringify(multiProviderConfig()));
    const required = spawnSync(process.execPath, [
      CODEX_CONFIG, '--config', configPath, '--auth', 'required', '--print-toml',
    ], { encoding: 'utf8' });
    assert.equal(required.status, 0, required.stderr);
    assert.match(required.stdout, /env_key = "DEEPSEEK_GATEWAY_TOKEN"/);

    fs.writeFileSync(configPath, JSON.stringify(multiProviderConfig({ token: 'gateway-secret' })));
    const none = spawnSync(process.execPath, [
      CODEX_CONFIG, '--config', configPath, '--auth', 'none', '--print-toml',
    ], { encoding: 'utf8' });
    assert.equal(none.status, 0, none.stderr);
    assert.doesNotMatch(none.stdout, /env_key/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
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
      assert.deepEqual(key.balance.items, [{
        planName: 'CNY',
        remaining: 88.8,
        granted: 8.8,
        toppedUp: 80,
        unit: 'CNY',
        isValid: true,
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
    assert.equal(h.keys[0].balanceError, '');
    assert.equal(h.providers[0].balanceQueryEnabled, false);
  } finally {
    await gw.stop();
    await new Promise(resolve => upstream.close(resolve));
  }
});

test('custom balance scripts support automatic, draft, manual, and live-updated queries', async () => {
  const upstreamPort = await freePort();
  const requests = [];
  let remaining = 12;
  let holdQuota = false;
  let releaseHeldQuota = null;
  const upstream = http.createServer((req, res) => {
    requests.push({
      path: req.url,
      authorization: req.headers.authorization,
      draft: req.headers['x-draft'] || '',
    });
    const responsePayload = {
      plan: req.url === '/quota-v2' ? 'Team' : 'Pro',
      remaining: req.url === '/quota-v2' ? 25 : remaining,
      used: 5,
      total: 30,
    };
    const respond = () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(responsePayload));
    };
    if (holdQuota && req.url === '/quota') {
      releaseHeldQuota = respond;
      return;
    }
    respond();
  });
  await new Promise(resolve => upstream.listen(upstreamPort, '127.0.0.1', resolve));

  const script = pathName => `({
    request: {
      url: "{{baseUrl}}${pathName}",
      method: "GET",
      headers: { Authorization: "Bearer {{apiKey}}" }
    },
    extractor: function(response) {
      return {
        planName: response.plan,
        remaining: response.remaining,
        used: response.used,
        total: response.total,
        unit: "USD"
      };
    }
  })`;
  const config = multiProviderConfig({ balanceRefreshMs: 60000 });
  config.providers[0].baseUrl = `http://127.0.0.1:${upstreamPort}`;
  config.providers[0].balanceQuery = {
    enabled: true,
    language: 'javascript',
    code: script('/quota'),
    timeoutMs: 2000,
    refreshMs: 10000,
  };

  const gw = await startGateway('', [], {}, config, { keysArg: false, mock: false });
  try {
    await waitFor(async () => {
      const health = await gw.health();
      return health.providers[0].keys[0].balance?.items[0]?.remaining === 12;
    });
    let health = await gw.health();
    let alpha = health.providers.find(provider => provider.id === 'alpha');
    assert.equal(alpha.balanceQueryEnabled, true);
    assert.deepEqual(alpha.keys[0].balance.items, [{
      planName: 'Pro',
      isValid: true,
      total: 30,
      used: 5,
      remaining: 12,
      unit: 'USD',
    }]);
    assert.ok(requests.some(request => (
      request.path === '/quota'
      && request.authorization === 'Bearer sk-alpha-ok'
    )));

    const draftCode = script('/quota').replace(
      'Authorization: "Bearer {{apiKey}}"',
      'Authorization: "Bearer {{apiKey}}", "X-Draft": "yes"',
    );
    const draft = await fetch(`${gw.base}/api/balance/test`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: gw.base },
      body: JSON.stringify({
        providerId: 'alpha',
        baseUrl: config.providers[0].baseUrl,
        key: 'sk-unsaved-draft',
        keyName: 'draft',
        balanceQuery: {
          enabled: true,
          language: 'javascript',
          code: draftCode,
          timeoutMs: 2000,
        },
      }),
    });
    const draftText = await draft.text();
    assert.equal(draft.status, 200, draftText);
    assert.equal(JSON.parse(draftText).items[0].remaining, 12);
    assert.ok(requests.some(request => (
      request.authorization === 'Bearer sk-unsaved-draft' && request.draft === 'yes'
    )));

    remaining = 18;
    const manual = await fetch(`${gw.base}/api/providers/alpha/keys/alpha-key/balance`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: gw.base },
      body: '{}',
    });
    const manualText = await manual.text();
    assert.equal(manual.status, 200, manualText);
    assert.equal(JSON.parse(manualText).balance.items[0].remaining, 18);

    const blockedBefore = requests.length;
    const blocked = await fetch(`${gw.base}/api/balance/test`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: gw.base },
      body: JSON.stringify({
        providerId: 'alpha',
        keyName: 'alpha-key',
        balanceQuery: {
          enabled: true,
          language: 'javascript',
          code: script('/quota').replace(
            '{{baseUrl}}',
            `http://localhost:${upstreamPort}`,
          ),
          timeoutMs: 2000,
        },
      }),
    });
    assert.equal(blocked.status, 502);
    assert.match(await blocked.text(), /provider origin/);
    assert.equal(requests.length, blockedBefore);

    holdQuota = true;
    const staleManual = fetch(`${gw.base}/api/providers/alpha/keys/alpha-key/balance`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: gw.base },
      body: '{}',
    });
    await waitFor(async () => Boolean(releaseHeldQuota));

    const updatedCode = script('/quota-v2');
    const updated = await fetch(`${gw.base}/api/providers/alpha`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', origin: gw.base },
      body: JSON.stringify({
        balanceQuery: {
          enabled: true,
          language: 'javascript',
          code: updatedCode,
          timeoutMs: 2000,
          refreshMs: 10000,
        },
      }),
    });
    assert.equal(updated.status, 200, await updated.text());
    await waitFor(async () => {
      const current = await gw.health();
      return current.providers[0].keys[0].balance?.items[0]?.remaining === 25;
    });
    health = await gw.health();
    alpha = health.providers.find(provider => provider.id === 'alpha');
    assert.equal(alpha.keys[0].balance.items[0].planName, 'Team');
    assert.ok(requests.some(request => request.path === '/quota-v2'));
    releaseHeldQuota();
    const staleManualResponse = await staleManual;
    assert.equal(staleManualResponse.status, 200, await staleManualResponse.text());
    await new Promise(resolve => setTimeout(resolve, 20));
    alpha = (await gw.health()).providers.find(provider => provider.id === 'alpha');
    assert.equal(alpha.keys[0].balance.items[0].planName, 'Team');
    assert.equal(alpha.keys[0].balance.items[0].remaining, 25);
    const persisted = JSON.parse(fs.readFileSync(gw.configPath, 'utf8'));
    assert.equal(persisted.providers[0].balanceQuery.code, updatedCode);
    assert.equal(persisted.providers[0].balanceQuery.refreshMs, 10000);
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
  const adminToken = 'separate-admin-token-1234';
  const gw = await startGateway(
    'alice=sk-a-ok',
    ['--token', 'secret-token'],
    { DS_GATEWAY_ADMIN_TOKEN: adminToken },
  );
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
      body: JSON.stringify({ token: adminToken }),
      redirect: 'manual',
    });
    assert.equal(login.status, 302);
    const cookie = login.headers.get('set-cookie').split(';')[0];
    assert.ok(cookie.startsWith('dsgw='));

    const proxiedLogin = await fetch(`${gw.base}/login`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-proto': 'https',
      },
      body: JSON.stringify({ token: adminToken }),
      redirect: 'manual',
    });
    assert.match(proxiedLogin.headers.get('set-cookie'), /; Secure;/);

    const malformedPath = await fetch(`${gw.base}/api/providers/%ZZ`, {
      headers: { authorization: `Bearer ${adminToken}` },
    });
    assert.equal(malformedPath.status, 400);

    const healthCookie = await fetch(`${gw.base}/health`, { headers: { cookie } });
    assert.equal(healthCookie.status, 200);
    const providersCookie = await fetch(`${gw.base}/api/providers`, { headers: { cookie } });
    assert.equal(providersCookie.status, 200);
    const shellCookie = await fetch(`${gw.base}/`, { headers: { cookie } });
    assert.equal(shellCookie.status, 200);

    const providersWithInferenceToken = await fetch(`${gw.base}/api/providers`, {
      headers: { authorization: 'Bearer secret-token' },
    });
    assert.equal(providersWithInferenceToken.status, 401);

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

test('browser management mutations require an origin and admin token rotation invalidates old sessions', async () => {
  const adminToken = 'csrf-admin-token-123456';
  const nextAdminToken = 'rotated-csrf-admin-token-123456';
  const gw = await startGateway('', [], {}, multiProviderConfig({ adminToken }), { keysArg: false });
  try {
    const login = await fetch(`${gw.base}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: gw.base },
      body: JSON.stringify({ token: adminToken }),
      redirect: 'manual',
    });
    assert.equal(login.status, 302);
    const cookie = login.headers.get('set-cookie').split(';', 1)[0];

    const missingOrigin = await gw.settings({
      method: 'PATCH',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ maxRetries: 1 }),
    });
    assert.equal(missingOrigin.status, 403);

    const crossOrigin = await gw.settings({
      method: 'PATCH',
      headers: { cookie, 'content-type': 'application/json', origin: 'https://attacker.example' },
      body: JSON.stringify({ maxRetries: 1 }),
    });
    assert.equal(crossOrigin.status, 403);

    const rotated = await gw.settings({
      method: 'PATCH',
      headers: { cookie, 'content-type': 'application/json', origin: gw.base },
      body: JSON.stringify({ adminToken: nextAdminToken }),
    });
    assert.equal(rotated.status, 200, await rotated.text());
    assert.equal((await gw.settings({ headers: { cookie } })).status, 401);
    assert.equal((await gw.settings({ headers: { authorization: `Bearer ${nextAdminToken}` } })).status, 200);

    const logs = await gw.operation('/api/logs?level=audit', {
      headers: { authorization: `Bearer ${nextAdminToken}` },
    });
    assert.equal(logs.status, 200);
    const audit = (await logs.json()).logs;
    assert.ok(audit.some(entry => entry.message === 'admin login succeeded'));
    assert.ok(audit.some(entry => entry.message === 'management mutation rejected by origin policy'));
    assert.ok(audit.some(entry => entry.message === 'management mutation completed'));
    assert.ok(!JSON.stringify(audit).includes(adminToken));
    assert.ok(!JSON.stringify(audit).includes(nextAdminToken));
  } finally {
    await gw.stop();
  }
});

test('admin login rate limit blocks the sixth request from one socket source', async () => {
  const adminToken = 'rate-limit-admin-token-1234';
  const gw = await startGateway(
    'alice=sk-a-ok',
    [],
    { DS_GATEWAY_ADMIN_TOKEN: adminToken },
  );
  try {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const res = await fetch(`${gw.base}/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: `invalid-${attempt}` }),
      });
      assert.equal(res.status, 401);
    }

    const blocked = await fetch(`${gw.base}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'invalid-blocked-request' }),
    });
    assert.equal(blocked.status, 429);
    assert.match(blocked.headers.get('retry-after') || '', /^[1-9]\d*$/);
    const body = await blocked.text();
    assert.ok(!body.includes(adminToken), 'rate-limit response must not expose the admin token');
  } finally {
    await gw.stop();
  }
});

test('successful admin login resets the source failure count', async () => {
  const adminToken = 'rate-reset-admin-token-1234';
  const gw = await startGateway(
    'alice=sk-a-ok',
    [],
    { DS_GATEWAY_ADMIN_TOKEN: adminToken },
  );
  try {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const res = await fetch(`${gw.base}/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: `invalid-${attempt}` }),
      });
      assert.equal(res.status, 401);
    }

    const login = await fetch(`${gw.base}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: adminToken }),
      redirect: 'manual',
    });
    assert.equal(login.status, 302);

    const afterReset = await fetch(`${gw.base}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'invalid-after-reset' }),
    });
    assert.equal(afterReset.status, 401);
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

test('direct SSE without a protocol terminal event is treated as truncated', async () => {
  const upstreamPort = await freePort();
  const upstream = http.createServer((req, res) => {
    req.resume();
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"type":"response.output_text.delta","delta":"partial"}\n\n');
    res.end();
  });
  await new Promise(resolve => upstream.listen(upstreamPort, '127.0.0.1', resolve));
  const config = multiProviderConfig();
  config.providers[0].baseUrl = `http://127.0.0.1:${upstreamPort}`;
  const gw = await startGateway('', [], {}, config, { keysArg: false, mock: false });
  try {
    await assert.rejects(async () => {
      const response = await fetch(`${gw.base}/v1/responses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'alpha--shared', input: 'hello', stream: true }),
      });
      await response.text();
    }, /terminated|fetch failed|socket/i);
    await waitFor(async () => (await gw.health()).providers[0].keys[0].inFlight === 0);
    const key = (await gw.health()).providers[0].keys[0];
    assert.equal(key.failureCount, 1);
    assert.equal(key.lastError, 'network error');
  } finally {
    await gw.stop();
    await new Promise(resolve => upstream.close(resolve));
  }
});

test('direct SSE requests force identity encoding before validating terminal events', async () => {
  const upstreamPort = await freePort();
  let acceptEncoding = '';
  const body = [
    'event: response.completed',
    'data: {"type":"response.completed","response":{"status":"completed"}}',
    '',
    '',
  ].join('\n');
  const upstream = http.createServer((req, res) => {
    req.resume();
    acceptEncoding = String(req.headers['accept-encoding'] || '');
    if (acceptEncoding === 'identity') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(body);
      return;
    }
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'content-encoding': 'gzip',
    });
    res.end(zlib.gzipSync(body));
  });
  await new Promise(resolve => upstream.listen(upstreamPort, '127.0.0.1', resolve));
  const config = multiProviderConfig();
  config.providers[0].baseUrl = `http://127.0.0.1:${upstreamPort}`;
  const gw = await startGateway('', [], {}, config, { keysArg: false, mock: false });
  try {
    const response = await fetch(`${gw.base}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'alpha--shared', input: 'hello', stream: true }),
    });
    assert.equal(response.status, 200);
    assert.match(await response.text(), /response\.completed/);
    assert.equal(acceptEncoding, 'identity');
    const key = (await gw.health()).providers[0].keys[0];
    assert.equal(key.success, 1);
    assert.equal(key.errors, 0);
  } finally {
    await gw.stop();
    await new Promise(resolve => upstream.close(resolve));
  }
});

test('direct Responses SSE accepts terminal events larger than one MiB', async () => {
  const upstreamPort = await freePort();
  const largeOutput = 'x'.repeat(1100000);
  const terminal = JSON.stringify({
    type: 'response.completed',
    response: { status: 'completed', output: largeOutput },
  });
  const upstream = http.createServer((req, res) => {
    req.resume();
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(`event: response.completed\ndata: ${terminal}\n\n`);
  });
  await new Promise(resolve => upstream.listen(upstreamPort, '127.0.0.1', resolve));
  const config = multiProviderConfig();
  config.providers[0].baseUrl = `http://127.0.0.1:${upstreamPort}`;
  const gw = await startGateway('', [], {}, config, { keysArg: false, mock: false });
  try {
    const response = await fetch(`${gw.base}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'alpha--shared', input: 'hello', stream: true }),
    });
    const text = await response.text();
    assert.equal(response.status, 200);
    assert.ok(text.length > 1100000);
    const key = (await gw.health()).providers[0].keys[0];
    assert.equal(key.success, 1);
    assert.equal(key.errors, 0);
  } finally {
    await gw.stop();
    await new Promise(resolve => upstream.close(resolve));
  }
});

test('direct Responses SSE accepts CR-only event framing', async () => {
  const upstreamPort = await freePort();
  const upstream = http.createServer((req, res) => {
    req.resume();
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end([
      'event: response.completed',
      'data: {"type":"response.completed","response":{"status":"completed"}}',
      '',
      '',
    ].join('\r'));
  });
  await new Promise(resolve => upstream.listen(upstreamPort, '127.0.0.1', resolve));
  const config = multiProviderConfig();
  config.providers[0].baseUrl = `http://127.0.0.1:${upstreamPort}`;
  const gw = await startGateway('', [], {}, config, { keysArg: false, mock: false });
  try {
    const response = await fetch(`${gw.base}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'alpha--shared', input: 'hello', stream: true }),
    });
    assert.match(await response.text(), /response\.completed/);
    const key = (await gw.health()).providers[0].keys[0];
    assert.equal(key.success, 1);
    assert.equal(key.errors, 0);
  } finally {
    await gw.stop();
    await new Promise(resolve => upstream.close(resolve));
  }
});

test('large non-SSE JSON responses still record usage totals', async () => {
  const upstreamPort = await freePort();
  const upstream = http.createServer((req, res) => {
    req.resume();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'large-response',
      output: 'x'.repeat(1100000),
      usage: { total_tokens: 37 },
    }));
  });
  await new Promise(resolve => upstream.listen(upstreamPort, '127.0.0.1', resolve));
  const config = multiProviderConfig();
  config.providers[0].baseUrl = `http://127.0.0.1:${upstreamPort}`;
  const gw = await startGateway('', [], {}, config, { keysArg: false, mock: false });
  try {
    const response = await gw.chat({ model: 'alpha--shared' });
    assert.equal(response.status, 200);
    assert.ok(response.text.length > 1100000);
    const health = await gw.health();
    assert.equal(health.total.tokens, 37);
  } finally {
    await gw.stop();
    await new Promise(resolve => upstream.close(resolve));
  }
});

test('direct Responses SSE rejects malformed terminal event payloads', async () => {
  const upstreamPort = await freePort();
  const upstream = http.createServer((req, res) => {
    req.resume();
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('event: response.completed\ndata: {broken}\n\n');
  });
  await new Promise(resolve => upstream.listen(upstreamPort, '127.0.0.1', resolve));
  const config = multiProviderConfig();
  config.providers[0].baseUrl = `http://127.0.0.1:${upstreamPort}`;
  const gw = await startGateway('', [], {}, config, { keysArg: false, mock: false });
  try {
    await assert.rejects(async () => {
      const response = await fetch(`${gw.base}/v1/responses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'alpha--shared', input: 'hello', stream: true }),
      });
      await response.text();
    }, /terminated|fetch failed|socket/i);
    const key = (await gw.health()).providers[0].keys[0];
    assert.equal(key.success, 0);
    assert.equal(key.errors, 1);
  } finally {
    await gw.stop();
    await new Promise(resolve => upstream.close(resolve));
  }
});

test('direct SSE terminal markers inside model output do not bypass truncation checks', async () => {
  const upstreamPort = await freePort();
  const upstream = http.createServer((req, res) => {
    req.resume();
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (req.url.includes('chat/completions')) {
      res.end('data: {"choices":[{"delta":{"content":"data: [DONE]"}}]}\n\n');
      return;
    }
    res.end('data: {"type":"response.output_text.delta","delta":"event: response.completed"}\n\n');
  });
  await new Promise(resolve => upstream.listen(upstreamPort, '127.0.0.1', resolve));
  const config = multiProviderConfig();
  config.providers[0].baseUrl = `http://127.0.0.1:${upstreamPort}`;
  const gw = await startGateway('', [], {}, config, { keysArg: false, mock: false });
  try {
    for (const pathname of ['/v1/responses', '/v1/chat/completions']) {
      await assert.rejects(async () => {
        const response = await fetch(`${gw.base}${pathname}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'alpha--shared', input: 'hello', stream: true }),
        });
        await response.text();
      }, /terminated|fetch failed|socket/i);
    }
    await waitFor(async () => (await gw.health()).providers[0].keys[0].inFlight === 0);
    const key = (await gw.health()).providers[0].keys[0];
    assert.equal(key.errors, 2);
    assert.equal(key.failureCount, 2);
  } finally {
    await gw.stop();
    await new Promise(resolve => upstream.close(resolve));
  }
});

test('direct Responses SSE failure terminals count as upstream errors', async () => {
  const upstreamPort = await freePort();
  const upstream = http.createServer((req, res) => {
    req.resume();
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end([
      'event: response.failed',
      'data: {"type":"response.failed","response":{"status":"failed"}}',
      '',
      '',
    ].join('\n'));
  });
  await new Promise(resolve => upstream.listen(upstreamPort, '127.0.0.1', resolve));
  const config = multiProviderConfig();
  config.providers[0].baseUrl = `http://127.0.0.1:${upstreamPort}`;
  const gw = await startGateway('', [], {}, config, { keysArg: false, mock: false });
  try {
    const response = await fetch(`${gw.base}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'alpha--shared', input: 'hello', stream: true }),
    });
    assert.equal(response.status, 200);
    assert.match(await response.text(), /response\.failed/);
    const key = (await gw.health()).providers[0].keys[0];
    assert.equal(key.success, 0);
    assert.equal(key.errors, 1);
    assert.equal(key.failureCount, 1);
  } finally {
    await gw.stop();
    await new Promise(resolve => upstream.close(resolve));
  }
});

test('client cancellation while buffering an adapted response does not penalize the key', async () => {
  const upstreamPort = await freePort();
  const upstream = http.createServer((req, res) => {
    req.resume();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.flushHeaders();
    const timer = setTimeout(() => {
      res.end(JSON.stringify({
        id: 'chatcmpl-late',
        model: 'same-upstream-model',
        choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'late' } }],
      }));
    }, 500);
    res.on('close', () => clearTimeout(timer));
  });
  await new Promise(resolve => upstream.listen(upstreamPort, '127.0.0.1', resolve));
  const config = multiProviderConfig();
  config.providers[0].baseUrl = `http://127.0.0.1:${upstreamPort}`;
  config.providers[0].upstreamFormat = 'chat-completions';
  const gw = await startGateway('', [], {}, config, { keysArg: false, mock: false });
  try {
    const target = new URL(gw.base);
    await new Promise((resolve, reject) => {
      const req = http.request({
        hostname: target.hostname,
        port: target.port,
        path: '/v1/responses',
        method: 'POST',
        headers: { 'content-type': 'application/json' },
      });
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      req.on('response', res => {
        res.resume();
        res.on('close', done);
      });
      req.on('error', error => {
        if (error.code === 'ECONNRESET') done();
        else reject(error);
      });
      req.on('close', done);
      req.end(JSON.stringify({ model: 'alpha--shared', input: 'hello' }));
      setTimeout(() => req.destroy(), 80);
    });
    await waitFor(async () => (await gw.health()).providers[0].keys[0].inFlight === 0);
    const key = (await gw.health()).providers[0].keys[0];
    assert.equal(key.failureCount, 0);
    assert.equal(key.invalid, false);
    assert.equal(key.lastError, 'client aborted');
  } finally {
    await gw.stop();
    await new Promise(resolve => upstream.close(resolve));
  }
});

test('downstream abort before upstream headers cancels the active request', async () => {
  const gw = await startGateway('alice=sk-a-slow,bob=sk-b-ok');
  try {
    const controller = new AbortController();
    const pending = fetch(`${gw.base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-v4-flash' }),
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 40);
    await assert.rejects(pending, error => error.name === 'AbortError');
    await waitFor(async () => (await gw.health()).keys[0].inFlight === 0);
    const h = await gw.health();
    assert.equal(h.keys[0].errors, 1);
    assert.equal(h.keys[0].failureCount, 0);
    assert.equal(h.keys[1].total, 0, 'client abort must stop the retry loop');
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
    '# [model_providers.multi-provider-gateway] is documentation only',
    '',
    '[profiles.fast]',
    'model = "gpt-5-fast"',
    '',
    '[profiles.deepseek]',
    'base_url = "https://deepseek.example"',
    '',
    '[model_providers."multi-provider-gateway"] # stale generated section',
    'name = "Stale Gateway"',
    'base_url = "http://127.0.0.1:1/v1"',
    '',
  ].join('\n'));
  const setup = path.join(ROOT, 'setup-codex.sh');
  for (let i = 0; i < 2; i++) {
    const r = spawnSync('bash', [setup], {
      env: {
        ...process.env,
        CODEX_HOME: codexDir,
        GATEWAY_URL: 'http://127.0.0.1:8787',
        GATEWAY_CONFIG: path.join(ROOT, 'keys.example.json'),
      },
      encoding: 'utf8',
    });
    assert.equal(r.status, 0, r.stderr);
  }
  const merged = fs.readFileSync(path.join(codexDir, 'config.toml'), 'utf8');
  assert.match(merged, /\[profiles\.fast\]/);
  assert.match(merged, /model = "gpt-5-fast"/, 'profile model must be preserved');
  assert.match(merged, /\[profiles\.deepseek\]/);
  assert.match(merged, /base_url = "https:\/\/deepseek\.example"/, 'profile deepseek must be preserved');
  assert.match(merged, /^model = "Deepseek.v4-flash"/m, 'top-level model must be replaced');
  assert.match(merged, /^# \[model_providers\.multi-provider-gateway\] is documentation only$/m);
  assert.doesNotMatch(merged, /Stale Gateway/);
  assert.equal((merged.match(/^\[model_providers\.multi-provider-gateway\]$/gm) || []).length, 1);
  assert.doesNotMatch(merged, /env_key/);
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
  fs.mkdirSync(path.join(codexDir, 'agents'));
  fs.writeFileSync(path.join(codexDir, 'agents', 'reviewer.toml'), 'name = "personal_reviewer"\n');
  const gatewayConfig = path.join(tmp, 'gateway.json');
  fs.writeFileSync(gatewayConfig, JSON.stringify(multiProviderConfig({ token: 'gateway-secret' })));
  const operationsPath = path.join(tmp, 'gateway-operations.json');
  fs.writeFileSync(operationsPath, JSON.stringify({
    schemaVersion: 2,
    subagents: [{
      id: 'reviewer',
      name: 'reviewer',
      description: 'Reviews code.',
      providerId: 'alpha',
      model: 'alpha--shared',
      developerInstructions: 'Review correctness and missing tests.',
      enabled: true,
    }],
  }));
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
  const agentPath = path.join(codexDir, 'agents', 'reviewer.toml');
  assert.match(fs.readFileSync(agentPath, 'utf8'), /model = "Alpha\.shared"/);
  const preSecondAgent = fs.readFileSync(agentPath, 'utf8');
  const operations = JSON.parse(fs.readFileSync(operationsPath, 'utf8'));
  operations.subagents[0].developerInstructions = 'Review security and regression risks first.';
  fs.writeFileSync(operationsPath, JSON.stringify(operations));
  fs.appendFileSync(configPath, '[mcp_servers.demo]\ncommand = "echo"\n');
  const preSecond = fs.readFileSync(configPath, 'utf8');
  const second = runSetup([]);
  assert.equal(second.status, 0, second.stderr);
  assert.match(
    fs.readFileSync(agentPath, 'utf8'),
    /developer_instructions = "Review security and regression risks first\."/,
  );

  const merged = fs.readFileSync(configPath, 'utf8');
  const sectionCount = (merged.match(/\[model_providers\.multi-provider-gateway\]/g) || []).length;
  assert.equal(sectionCount, 1, `expected exactly one provider section: ${merged}`);
  assert.match(merged, /\[mcp_servers\.demo\]/);
  assert.match(merged, /base_url = "http:\/\/127\.0\.0\.1:8787\/v1"/);
  assert.match(merged, /env_key = "DEEPSEEK_GATEWAY_TOKEN"/);
  assert.doesNotMatch(merged, /experimental_bearer_token/);
  assert.ok(!merged.includes('configured-token'));
  assert.match(merged, /model = "Alpha.shared"/);
  const catalog = JSON.parse(fs.readFileSync(path.join(codexDir, 'gateway-models.json'), 'utf8'));
  assert.deepEqual(catalog.models.map(model => model.slug), ['Alpha.shared', 'Beta.shared']);
  assert.ok(
    catalog.models.every(model => model.supports_search_tool === false),
    'catalog models must not enable supports_search_tool (hides MCP tools in Codex CLI)',
  );
  assert.ok(
    catalog.models.every(model => model.shell_type === 'shell_command'),
    'every catalog model must declare the Codex shell tool type',
  );
  assert.ok(
    catalog.models.every(model => (
      model.base_instructions || model.model_messages?.instructions_template
    )),
    'every catalog model must include a Codex instruction source',
  );
  assert.ok(
    catalog.models.every(model => typeof model.supports_reasoning_summaries === 'boolean'),
    'every catalog model must declare reasoning summary support',
  );
  assert.ok(
    catalog.models.every(model => model.apply_patch_tool_type === undefined),
    'native Responses models must not advertise the proxy-only freeform patch tool',
  );
  assert.equal(fs.statSync(path.join(codexDir, 'gateway-models.json')).mode & 0o777, 0o600);

  const beforeUndoDryConfig = fs.readFileSync(configPath, 'utf8');
  const beforeUndoDryCatalog = fs.readFileSync(path.join(codexDir, 'gateway-models.json'), 'utf8');
  const undoDry = runSetup(['--undo', '--dry-run']);
  assert.notEqual(undoDry.status, 0);
  assert.match(undoDry.stderr, /cannot be used together/);
  assert.equal(fs.readFileSync(configPath, 'utf8'), beforeUndoDryConfig);
  assert.equal(fs.readFileSync(path.join(codexDir, 'gateway-models.json'), 'utf8'), beforeUndoDryCatalog);

  const validate = spawnSync('python3', ['-c', `
import sys, tomllib
with open(sys.argv[1], 'rb') as f: tomllib.load(f)
`, configPath]);
  assert.equal(validate.status, 0, `merged config.toml must be valid TOML: ${validate.stderr}`);

  const undo = runSetup(['--undo']);
  assert.equal(undo.status, 0, undo.stderr);
  assert.equal(fs.readFileSync(configPath, 'utf8'), preSecond, 'undo should restore the pre-run state');
  assert.equal(fs.readFileSync(agentPath, 'utf8'), preSecondAgent, 'undo should restore managed agent files');

  fs.rmSync(tmp, { recursive: true, force: true });
});

test('interactive configure writes a private web setup config', async () => {
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
    'y',
    'gateway-secret',
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
  assert.equal(config.setupPending, true);
  assert.equal(config.defaultProvider, '');
  assert.equal(config.defaultModel, '');
  assert.equal(config.upstream, undefined);
  assert.equal(config.keys, undefined);
  assert.equal(config.blacklistThreshold, 3);
  assert.equal(config.balanceRefreshMs, 300000);
  assert.equal(config.token, 'gateway-secret');
  assert.deepEqual(config.providers, []);
  assert.equal(fs.statSync(configPath).mode & 0o777, 0o600);
  assert.doesNotMatch(result.stdout, /API Key/);

  const keepAnswers = [
    '', '', '', '', '', '', '', '', '',
    '',
  ].join('\n') + '\n';
  const second = spawnSync('python3', [
    CONFIGURE, '--config', configPath, '--no-codex', '--no-start',
  ], {
    input: keepAnswers,
    encoding: 'utf8',
    env: { ...process.env, DS_GATEWAY_PORT: String(port) },
  });
  assert.equal(second.status, 0, second.stderr || second.stdout);
  const kept = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.equal(kept.setupPending, true);
  assert.deepEqual(kept.providers, []);
  assert.equal(kept.token, 'gateway-secret');
  const backups = fs.readdirSync(path.join(tmp, '.gateway-backups'));
  assert.equal(backups.length, 1);
  fs.rmSync(tmp, { recursive: true, force: true });
});
