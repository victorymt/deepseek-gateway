import assert from 'node:assert/strict';
import test from 'node:test';

import { createLoginAttemptLimiter } from '../login-attempt-limiter.mjs';

function makeLimiter(options = {}) {
  let currentTime = 0;
  const limiter = createLoginAttemptLimiter({
    maxFailures: 5,
    windowMs: 60_000,
    cooldownMs: 300_000,
    staleAfterMs: 600_000,
    now: () => currentTime,
    ...options,
  });
  return {
    limiter,
    advance(ms) { currentTime += ms; },
  };
}

test('allows requests through the threshold and blocks the next request', () => {
  const { limiter } = makeLimiter();
  for (let i = 0; i < 5; i += 1) {
    assert.deepEqual(limiter.check('127.0.0.1'), { blocked: false });
    limiter.recordFailure('127.0.0.1');
  }
  const result = limiter.check('127.0.0.1');
  assert.equal(result.blocked, true);
  assert.match(String(result.retryAfterSeconds), /^[1-9]\d*$/);
});

test('recovers after cooldown', () => {
  const { limiter, advance } = makeLimiter();
  for (let i = 0; i < 5; i += 1) limiter.recordFailure('client');
  advance(300_000);
  assert.deepEqual(limiter.check('client'), { blocked: false });
});

test('isolates sources', () => {
  const { limiter } = makeLimiter();
  for (let i = 0; i < 5; i += 1) limiter.recordFailure('client-a');
  assert.equal(limiter.check('client-a').blocked, true);
  assert.deepEqual(limiter.check('client-b'), { blocked: false });
});

test('success resets failures', () => {
  const { limiter } = makeLimiter();
  for (let i = 0; i < 4; i += 1) limiter.recordFailure('client');
  limiter.recordSuccess('client');
  limiter.recordFailure('client');
  assert.deepEqual(limiter.check('client'), { blocked: false });
});

test('expired failure window starts a new count', () => {
  const { limiter, advance } = makeLimiter();
  for (let i = 0; i < 4; i += 1) limiter.recordFailure('client');
  advance(60_000);
  limiter.recordFailure('client');
  assert.deepEqual(limiter.check('client'), { blocked: false });
});

test('prune removes stale entries', () => {
  const { limiter, advance } = makeLimiter({ staleAfterMs: 1_000 });
  for (let i = 0; i < 5; i += 1) limiter.recordFailure('client');
  advance(301_000);
  limiter.prune();
  assert.deepEqual(limiter.check('client'), { blocked: false });
});

test('normalizes invalid sources safely', () => {
  const { limiter } = makeLimiter();
  for (const source of [undefined, null, '', '   ', 42]) limiter.recordFailure(source);
  assert.equal(limiter.check('unknown').blocked, true);
});

test('public results do not expose sensitive fields', () => {
  const { limiter } = makeLimiter();
  for (let i = 0; i < 5; i += 1) limiter.recordFailure('client');
  const serialized = JSON.stringify(limiter.check('client'));
  assert.doesNotMatch(serialized, /token|key|password|authorization|cookie/i);
});
