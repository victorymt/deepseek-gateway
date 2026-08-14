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
  waitFor,
} from './helpers/gateway-harness.mjs';

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

test('prompt cache affinity keeps keyed requests sticky without perturbing round-robin', async () => {
  const config = multiProviderConfig({ maxRetries: 0 });
  config.providers[0].keyRouting = 'prompt-cache-affinity';
  config.providers[0].keys = [
    { name: 'alice', key: 'sk-a-ok', weight: 1 },
    { name: 'bob', key: 'sk-b-ok', weight: 1 },
  ];
  const gw = await startGateway('', [], {}, config, { keysArg: false });
  try {
    const stickyNames = [];
    for (let i = 0; i < 4; i++) {
      const response = await gw.responses({
        model: 'alpha--shared',
        prompt_cache_key: 'stable-project-session',
      });
      assert.equal(response.status, 200, response.text);
      stickyNames.push(JSON.parse(response.text).gateway_key_name);
    }
    assert.deepEqual(stickyNames, Array(4).fill(stickyNames[0]));

    const unkeyed = [];
    for (let i = 0; i < 2; i++) {
      const response = await gw.responses({ model: 'alpha--shared' });
      assert.equal(response.status, 200, response.text);
      unkeyed.push(JSON.parse(response.text).gateway_key_name);
    }
    assert.deepEqual(unkeyed, ['alice', 'bob']);
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
