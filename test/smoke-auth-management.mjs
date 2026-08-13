import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

import {
  freePort,
  multiProviderConfig,
  startGateway,
} from './helpers/gateway-harness.mjs';

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
        models: [{
          id: 'shared',
          name: 'Shared Gamma',
          upstreamModel: 'same-upstream-model',
          contextWindow: 262144,
          supportsParallelToolCalls: true,
          baseInstructions: 'Use Gamma coding instructions.',
        }],
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
    assert.equal(gamma.models[0].contextWindow, 262144);
    assert.equal(gamma.models[0].supportsParallelToolCalls, true);
    assert.equal(gamma.models[0].baseInstructions, 'Use Gamma coding instructions.');

    const routed = await gw.chat({ model: 'gamma--shared' });
    assert.equal(routed.status, 200);
    assert.equal(routed.headers.get('x-gateway-provider'), 'gamma');
    assert.equal(JSON.parse(routed.text).gateway_key_name, 'gamma-key');

    const persisted = JSON.parse(fs.readFileSync(gw.configPath, 'utf8'));
    assert.equal(persisted.schemaVersion, 2);
    const persistedGamma = persisted.providers.find(provider => provider.id === 'gamma');
    assert.equal(persistedGamma.keys[0].key, secret);
    assert.equal(persistedGamma.models[0].contextWindow, 262144);
    assert.equal(persistedGamma.models[0].supportsParallelToolCalls, true);
    assert.equal(persistedGamma.models[0].baseInstructions, 'Use Gamma coding instructions.');
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
