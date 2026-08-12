function positiveNumber(value, fallback) {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function normalizeSource(source) {
  return typeof source === 'string' && source.trim() ? source.trim() : 'unknown';
}

export function createLoginAttemptLimiter({
  maxFailures = 5,
  windowMs = 60_000,
  cooldownMs = 300_000,
  staleAfterMs,
  now = Date.now,
} = {}) {
  const failureLimit = Math.max(1, Math.floor(positiveNumber(maxFailures, 5)));
  const failureWindowMs = positiveNumber(windowMs, 60_000);
  const blockCooldownMs = positiveNumber(cooldownMs, 300_000);
  const entryStaleAfterMs = positiveNumber(
    staleAfterMs,
    Math.max(failureWindowMs, blockCooldownMs) * 2,
  );
  const clock = typeof now === 'function' ? now : Date.now;
  const attempts = new Map();
  let operations = 0;

  function currentTime() {
    const value = Number(clock());
    return Number.isFinite(value) ? value : Date.now();
  }

  function maybePrune(time) {
    operations += 1;
    if (operations % 64 === 0) prune(time);
  }

  function check(source) {
    const time = currentTime();
    maybePrune(time);
    const key = normalizeSource(source);
    const entry = attempts.get(key);
    if (!entry) return { blocked: false };

    entry.lastSeen = time;
    if (entry.blockedUntil > time) {
      return {
        blocked: true,
        retryAfterSeconds: Math.max(1, Math.ceil((entry.blockedUntil - time) / 1000)),
      };
    }

    if (entry.blockedUntil > 0) attempts.delete(key);
    return { blocked: false };
  }

  function recordFailure(source) {
    const time = currentTime();
    maybePrune(time);
    const key = normalizeSource(source);
    let entry = attempts.get(key);

    if (!entry || (
      entry.blockedUntil <= time &&
      time - entry.windowStartedAt >= failureWindowMs
    )) {
      entry = {
        failures: 0,
        windowStartedAt: time,
        blockedUntil: 0,
        lastSeen: time,
      };
    }

    entry.failures += 1;
    entry.lastSeen = time;
    if (entry.failures >= failureLimit) entry.blockedUntil = time + blockCooldownMs;
    attempts.set(key, entry);
  }

  function recordSuccess(source) {
    attempts.delete(normalizeSource(source));
  }

  function prune(at = currentTime()) {
    const time = Number.isFinite(at) ? at : currentTime();
    for (const [key, entry] of attempts) {
      const inactive = time - entry.lastSeen >= entryStaleAfterMs;
      const noActiveBlock = entry.blockedUntil <= time;
      if (inactive && noActiveBlock) attempts.delete(key);
    }
  }

  return { check, recordFailure, recordSuccess, prune };
}
