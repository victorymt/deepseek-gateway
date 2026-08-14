import assert from 'node:assert';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';

import { normalizeConfig } from '../config-core.mjs';
import { ProviderRegistry } from '../provider-runtime.mjs';
import * as relayKernel from '../upstream-relay.mjs';

function registry(providerOverrides = {}) {
  const config = Object.assign(normalizeConfig({
    schemaVersion: 2,
    defaultProvider: 'alpha',
    defaultModel: 'alpha--chat',
    maxRetries: 0,
    balanceRefreshMs: 0,
    providers: [{
      id: 'alpha',
      name: 'Alpha',
      baseUrl: 'https://api.example/v1',
      enabled: true,
      models: [{ id: 'chat', name: 'Chat', upstreamModel: 'upstream-chat' }],
      keys: [{ name: 'slow', key: 'sk-slow', weight: 1 }],
      ...providerOverrides,
    }],
  }), { mock: true });
  return new ProviderRegistry(config, () => {});
}

test('upstream URL normalization preserves paths and query strings', () => {
  assert.equal(
    relayKernel.upstreamRequestUrl(
      'https://api.example/v1',
      '/v1/responses?include=usage',
    ).toString(),
    'https://api.example/v1/responses?include=usage',
  );
  assert.equal(
    relayKernel.upstreamRequestUrl('https://api.example/root/', '/responses').toString(),
    'https://api.example/root/responses',
  );
  assert.throws(
    () => relayKernel.normalizeModelFetchUrl('https://user:secret@example.com/models'),
    /without credentials or hash/,
  );
});

test('route resolution maps a public alias to its provider and upstream model', () => {
  const providers = registry();
  try {
    const route = relayKernel.resolveRequestRoute(
      providers,
      Buffer.from(JSON.stringify({ model: 'alpha--chat', input: 'hello' })),
      '/v1/responses?stream=false',
    );
    assert.equal(route.runtime.provider.id, 'alpha');
    assert.equal(route.gatewayModel, 'alpha--chat');
    assert.equal(route.upstreamModel, 'upstream-chat');
    assert.equal(route.upstreamRequestPath, '/v1/responses?stream=false');
  } finally {
    providers.close();
  }
});

test('route resolution derives only a hashed affinity key for opted-in providers', () => {
  const providers = registry({
    keyRouting: 'prompt-cache-affinity',
    keys: [
      { name: 'first', key: 'sk-first', weight: 1 },
      { name: 'second', key: 'sk-second', weight: 1 },
    ],
  });
  try {
    const body = Buffer.from(JSON.stringify({
      model: 'alpha--chat',
      input: 'hello',
      prompt_cache_key: 'stable-project-session',
    }));
    const first = relayKernel.resolveRequestRoute(providers, body, '/v1/responses');
    const second = relayKernel.resolveRequestRoute(providers, body, '/v1/responses');
    assert.match(first.affinityKey, /^[a-f0-9]{64}$/);
    assert.equal(first.affinityKey, second.affinityKey);
    assert.notEqual(first.affinityKey, 'stable-project-session');

    const absent = relayKernel.resolveRequestRoute(
      providers,
      Buffer.from(JSON.stringify({ model: 'alpha--chat', input: 'hello' })),
      '/v1/responses',
    );
    const invalid = relayKernel.resolveRequestRoute(
      providers,
      Buffer.from(JSON.stringify({
        model: 'alpha--chat',
        input: 'hello',
        prompt_cache_key: 42,
      })),
      '/v1/responses',
    );
    assert.equal(absent.affinityKey, null);
    assert.equal(invalid.affinityKey, null);
  } finally {
    providers.close();
  }
});

test('chat-completions adaptation retains prompt cache affinity routing', () => {
  const providers = registry({
    upstreamFormat: 'chat-completions',
    keyRouting: 'prompt-cache-affinity',
  });
  try {
    const route = relayKernel.resolveRequestRoute(
      providers,
      Buffer.from(JSON.stringify({
        model: 'alpha--chat',
        input: 'hello',
        prompt_cache_key: 'adapted-session',
      })),
      '/v1/responses',
    );
    assert.equal(route.responseAdapter.type, 'chat-completions');
    assert.match(route.affinityKey, /^[a-f0-9]{64}$/);
  } finally {
    providers.close();
  }
});

test('route resolution passes dotted bare model names through to the default provider', () => {
  const config = Object.assign(normalizeConfig({
    schemaVersion: 2,
    defaultProvider: 'alpha',
    defaultModel: 'alpha--chat',
    maxRetries: 0,
    balanceRefreshMs: 0,
    providers: [{
      id: 'alpha',
      name: 'Alpha',
      baseUrl: 'https://api.example/v1',
      enabled: true,
      models: [
        { id: 'chat', name: 'Chat', upstreamModel: 'upstream-chat' },
        { id: 'Gpt-4.1', name: 'GPT 4.1', upstreamModel: 'gpt-4.1' },
      ],
      keys: [{ name: 'slow', key: 'sk-slow', weight: 1 }],
    }],
  }), { mock: true });
  const providers = new ProviderRegistry(config, () => {});
  try {
    const route = relayKernel.resolveRequestRoute(
      providers,
      Buffer.from(JSON.stringify({ model: 'Gpt-4.1', input: 'hello' })),
      '/v1/responses',
    );
    assert.equal(route.runtime.provider.id, 'alpha');
    assert.equal(route.gatewayModel, 'Gpt-4.1');
    // A non-alias request passes the model through unchanged.
    assert.equal(route.upstreamModel, undefined);
  } finally {
    providers.close();
  }
});

test('route resolution still rejects unresolved alias-shaped names', () => {
  const providers = registry();
  try {
    assert.throws(
      () => relayKernel.resolveRequestRoute(
        providers,
        Buffer.from(JSON.stringify({ model: 'alpha--missing', input: 'hello' })),
        '/v1/responses',
      ),
      error => error.statusCode === 400 && /unknown or disabled model alias/.test(error.message),
    );
    assert.throws(
      () => relayKernel.resolveRequestRoute(
        providers,
        Buffer.from(JSON.stringify({ model: 'Alpha.unknown', input: 'hello' })),
        '/v1/responses',
      ),
      error => error.statusCode === 400 && /unknown or disabled model alias/.test(error.message),
    );
  } finally {
    providers.close();
  }
});

test('relay cancellation releases a retained runtime exactly once', async () => {
  const providers = registry();
  const runtime = providers.get('alpha');
  const route = relayKernel.resolveRequestRoute(
    providers,
    Buffer.from(JSON.stringify({ model: 'alpha--chat', input: 'hello' })),
    '/v1/responses',
  );
  const request = {
    method: 'POST',
    url: '/v1/responses',
    headers: { 'content-type': 'application/json' },
  };
  const response = Object.assign(new EventEmitter(), {
    writableEnded: false,
    destroyed: false,
    writeHead() {},
    end() { this.writableEnded = true; },
  });
  const pending = relayKernel.relay(route, request, response, () => {});
  assert.equal(runtime.activeRequests, 1);
  response.destroyed = true;
  response.emit('close');
  await pending;
  assert.equal(runtime.activeRequests, 0);
  providers.close();
});

test('relay settles key state when response setup throws after upstream success', async () => {
  const providers = registry();
  const runtime = providers.get('alpha');
  const key = runtime.pool.keys[0];
  runtime.pool.markInvalid(key, 'test');
  key.invalidatedAt = Date.now() - 61_000;
  const route = relayKernel.resolveRequestRoute(
    providers,
    Buffer.from(JSON.stringify({ model: 'alpha--chat', input: 'hello' })),
    '/v1/responses',
  );
  const request = {
    method: 'POST',
    url: '/v1/responses',
    headers: { 'content-type': 'application/json' },
  };
  const response = Object.assign(new EventEmitter(), {
    writableEnded: false,
    destroyed: false,
    writeHead() {},
    end() { this.writableEnded = true; },
  });
  const expected = new Error('log failed');
  try {
    await assert.rejects(
      relayKernel.relay(route, request, response, () => { throw expected; }),
      error => error === expected,
    );
    assert.equal(key.inFlight, 0);
    assert.equal(key.invalidProbeInFlight, false);
    assert.equal(key.invalidProbeReservation, null);
    assert.equal(runtime.activeRequests, 0);
  } finally {
    providers.close();
  }
});

test('relay kernel exposes only its supported public contracts', () => {
  assert.deepEqual(Object.keys(relayKernel).sort(), [
    'fetchProviderModels',
    'normalizeModelFetchUrl',
    'relay',
    'resolveRequestRoute',
    'upstreamRequestUrl',
  ]);
});
