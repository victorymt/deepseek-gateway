import assert from 'node:assert';
import { test } from 'node:test';

import { normalizeConfig } from '../config-core.mjs';
import { KeyPool, ProviderRegistry } from '../provider-runtime.mjs';

function settings(baseUrl = 'https://one.example/v1') {
  return Object.assign(normalizeConfig({
    schemaVersion: 2,
    defaultProvider: 'alpha',
    defaultModel: 'alpha--chat',
    balanceRefreshMs: 0,
    providers: [{
      id: 'alpha',
      name: 'Alpha',
      baseUrl,
      enabled: true,
      models: [{ id: 'chat', name: 'Chat', upstreamModel: 'chat' }],
      keys: [
        { name: 'first', key: 'sk-first', weight: 1 },
        { name: 'second', key: 'sk-second', weight: 2 },
      ],
    }],
  }), { mock: true, quiet: true });
}

test('KeyPool records tokens through the injected operations recorder', () => {
  const recorded = [];
  const config = settings();
  const pool = new KeyPool(
    config.providers[0].keys,
    config,
    'alpha',
    { recordTokens: value => recorded.push(value) },
  );
  pool.recordTokens(21, 'alpha--chat');
  pool.recordTokens(0, 'ignored');
  assert.equal(pool.stats().total.tokens, 21);
  assert.deepEqual(recorded, [{ provider: 'alpha', model: 'alpha--chat', tokens: 21 }]);
});

test('KeyPool selection and failure states retain their behavior', () => {
  const config = settings();
  const pool = new KeyPool(config.providers[0].keys, config, 'alpha');
  const first = pool.pickKey();
  first.inFlight++;
  assert.equal(first.name, 'first');
  assert.equal(pool.pickKey().name, 'second');
  pool.recordResult(first, { status: 401 });
  assert.equal(pool.state(first), 'invalid');
  assert.equal(pool.pickKey().name, 'second');
});

test('retired runtimes drain retained requests before closing', () => {
  const config = settings();
  const registry = new ProviderRegistry(config, () => {});
  const oldRuntime = registry.get('alpha');
  oldRuntime.retain();

  registry.apply(settings('https://two.example/v1'));
  assert.equal(oldRuntime.retired, true);
  assert.equal(oldRuntime.closed, false);
  assert.equal(registry.retiredEntries.has(oldRuntime), true);

  oldRuntime.release();
  assert.equal(oldRuntime.closed, true);
  assert.equal(registry.retiredEntries.has(oldRuntime), false);
  registry.close();
});
