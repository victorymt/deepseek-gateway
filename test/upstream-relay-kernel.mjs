import assert from 'node:assert';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';

import { normalizeConfig } from '../config-core.mjs';
import { ProviderRegistry } from '../provider-runtime.mjs';
import * as relayKernel from '../upstream-relay.mjs';

function registry() {
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

test('relay kernel exposes only its supported public contracts', () => {
  assert.deepEqual(Object.keys(relayKernel).sort(), [
    'fetchProviderModels',
    'normalizeModelFetchUrl',
    'relay',
    'resolveRequestRoute',
    'upstreamRequestUrl',
  ]);
});
