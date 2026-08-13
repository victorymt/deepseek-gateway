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

test('KeyPool clamps oversized and non-finite Retry-After values', () => {
  const config = settings();
  const pool = new KeyPool(config.providers[0].keys, config, 'alpha');
  const key = pool.keys[0];
  pool.recordResult(key, { status: 429, retryAfterSec: 999999999 });
  assert.equal(pool.state(key), 'cooldown');
  assert.ok(key.throttleUntil <= Date.now() + 3600 * 1000);
  pool.recordResult(key, { status: 429, retryAfterSec: Number.NaN });
  assert.equal(pool.state(key), 'cooldown');
  assert.ok(key.throttleUntil >= Date.now() + config.cooldownMs - 1000);
  pool.recordResult(key, { status: 429, retryAfterSec: -5 });
  assert.equal(pool.state(key), 'cooldown');
  assert.ok(key.throttleUntil >= Date.now() + config.cooldownMs - 1000);
});

test('KeyPool half-open probes revive invalid keys after the probe interval', () => {
  const config = settings();
  const pool = new KeyPool(config.providers[0].keys, config, 'alpha');
  const key = pool.keys[0];
  pool.recordResult(key, { status: 401 });
  assert.equal(key.invalid, true);
  assert.equal(key.invalidatedAt > 0, true);
  // Within the probe window the invalid key is not schedulable.
  assert.equal(pool.pickKey()?.name, 'second');
  // Once the probe window opens, the key is eligible again.
  key.invalidatedAt = Date.now() - 61 * 1000;
  assert.equal(pool.pickKey()?.name, 'first');
  // A successful probe fully revives the key.
  pool.recordResult(key, { status: 200 });
  assert.equal(key.invalid, false);
  assert.equal(key.failureCount, 0);
  assert.equal(key.invalidatedAt, 0);
  assert.equal(pool.state(key), 'healthy');
});

test('KeyPool limits half-open probes to one concurrent request', () => {
  const config = settings();
  const pool = new KeyPool(config.providers[0].keys, config, 'alpha');
  pool.keys[1].enabled = false; // single-key pool: every pick would flood
  const key = pool.keys[0];
  pool.recordResult(key, { status: 401 });
  key.invalidatedAt = Date.now() - 61 * 1000;
  // The first request starts the single allowed probe...
  assert.equal(pool.pickKey()?.name, 'first');
  assert.equal(key.invalidProbeInFlight, true);
  // ...and concurrent requests must not receive the same invalid key.
  assert.equal(pool.pickKey(), null);
  assert.equal(pool.pickKey(), null);
  // A failed probe restarts the window: no immediate re-probe.
  pool.recordResult(key, { status: 500 });
  assert.equal(key.invalid, true);
  assert.equal(key.invalidProbeInFlight, false);
  assert.ok(key.invalidatedAt > Date.now() - 1000);
  assert.equal(pool.pickKey(), null);
  // After a full window, exactly one new probe is allowed.
  key.invalidatedAt = Date.now() - 61 * 1000;
  assert.equal(pool.pickKey()?.name, 'first');
  assert.equal(pool.pickKey(), null);
  // The successful probe revives the key for normal scheduling.
  pool.recordResult(key, { status: 200 });
  assert.equal(key.invalid, false);
  assert.equal(pool.pickKey()?.name, 'first');
});

test('KeyPool failure counts decay after the sliding window', () => {
  const config = settings();
  const pool = new KeyPool(config.providers[0].keys, config, 'alpha');
  const key = pool.keys[0];
  key.failureWindowStart = Date.now() - 6 * 60 * 1000;
  key.failureCount = 3;
  pool.recordFailure(key, 'http 500');
  assert.equal(key.failureCount, 1);
});

test('KeyPool excludes keys with an explicitly unavailable balance unless alwaysTry', () => {
  const config = settings();
  const pool = new KeyPool(config.providers[0].keys, config, 'alpha');
  const first = pool.keys[0];
  const second = pool.keys[1];
  first.balance = { isAvailable: false, items: [] };
  assert.equal(pool.pickKey()?.name, 'second');
  second.balance = { isAvailable: false, items: [] };
  assert.equal(pool.pickKey(), null);
  second.alwaysTry = true;
  assert.equal(pool.pickKey()?.name, 'second');
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
