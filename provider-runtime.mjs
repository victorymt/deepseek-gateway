'use strict';

import http from 'node:http';
import https from 'node:https';

import { effectiveBalanceQuery, executeBalanceQuery } from './balance-script.mjs';
import {
  codexModelAlias,
  keyFingerprint,
  providerModelAlias,
  validateProviderConfig,
} from './config-core.mjs';

// How long an invalid (blacklisted/401/402) key waits before being probed
// again with one request; a successful probe revives the key.
const KEY_PROBE_INTERVAL_MS = 60 * 1000;
// Upper bound for an upstream Retry-After so a hostile or broken header can
// never take a key out of rotation for longer than an hour.
const MAX_RETRY_AFTER_MS = 60 * 60 * 1000;
// Failure counts accumulate inside this sliding window; a longer gap between
// failures resets the counter so sporadic hiccups cannot blacklist a key.
const FAILURE_DECAY_MS = 5 * 60 * 1000;

export class KeyPool {
  constructor(keys, cfg, providerId, operations = null) {
    this.keys = keys.map(key => this.createKeyState(key));
    this.providerId = providerId;
    this.operations = operations;
    this.cursor = 0;
    this.cooldownMs = cfg.cooldownMs;
    this.blacklistThreshold = cfg.blacklistThreshold;
    this.total = { requests: 0, success: 0, errors: 0, ratelimited: 0, tokens: 0 };
  }

  createKeyState(key) {
    return {
      ...key,
      alwaysTry: key.alwaysTry === true,
      inFlight: 0,
      success: 0,
      errors: 0,
      ratelimited: 0,
      failureCount: 0,
      failureWindowStart: 0,
      invalid: false,
      invalidatedAt: 0,
      unhealthy: false,
      throttleUntil: 0,
      lastUsed: 0,
      lastError: '',
      balance: null,
      balanceUpdatedAt: 0,
      balanceError: '',
    };
  }

  reconcile(keys, cfg) {
    const previousByFingerprint = new Map(this.keys.map(key => [keyFingerprint(key.key), key]));
    let added = 0;
    const nextKeys = keys.map(key => {
      const fingerprint = keyFingerprint(key.key);
      const existing = previousByFingerprint.get(fingerprint);
      if (!existing) {
        added++;
        return this.createKeyState(key);
      }
      previousByFingerprint.delete(fingerprint);
      existing.name = key.name;
      existing.key = key.key;
      existing.weight = key.weight;
      existing.enabled = key.enabled;
      existing.alwaysTry = key.alwaysTry === true;
      return existing;
    });

    this.keys = nextKeys;
    this.cursor = nextKeys.length ? this.cursor % nextKeys.length : 0;
    this.cooldownMs = cfg.cooldownMs;
    this.blacklistThreshold = cfg.blacklistThreshold;
    return { added, removed: previousByFingerprint.size };
  }

  pickKey(exclude = []) {
    const now = Date.now();
    const avail = this.keys.filter(k => (
      k.enabled
      && !exclude.includes(k.name)
      && (k.alwaysTry || !k.invalid || now >= (k.invalidatedAt || 0) + KEY_PROBE_INTERVAL_MS)
      && now >= k.throttleUntil
      && (k.alwaysTry || k.balance?.isAvailable !== false)
    ));
    if (!avail.length) return null;
    let best = null;
    let bestScore = Infinity;
    let bestDist = Infinity;
    const n = this.keys.length;
    for (let i = 0; i < avail.length; i++) {
      const k = avail[i];
      const idx = this.keys.indexOf(k);
      const score = k.inFlight / (k.weight || 1);
      const dist = (idx - this.cursor + n) % n;
      if (score < bestScore || (score === bestScore && dist < bestDist)) {
        best = k;
        bestScore = score;
        bestDist = dist;
      }
    }
    this.cursor = (this.keys.indexOf(best) + 1) % n;
    return best;
  }

  markInvalid(key, reason) {
    key.invalid = true;
    key.invalidatedAt = Date.now();
    key.unhealthy = false;
    key.throttleUntil = 0;
    key.lastError = reason;
  }

  recordFailure(key, reason) {
    const now = Date.now();
    if (now - (key.failureWindowStart || 0) > FAILURE_DECAY_MS) {
      key.failureCount = 0;
      key.failureWindowStart = now;
    }
    key.failureCount++;
    key.lastError = reason;
    if (key.alwaysTry) {
      key.unhealthy = true;
      if (this.blacklistThreshold > 0 && key.failureCount >= this.blacklistThreshold) {
        key.lastError = `alwaysTry retained after ${key.failureCount} failures: ${reason}`;
      }
      return;
    }
    if (this.blacklistThreshold > 0 && key.failureCount >= this.blacklistThreshold) {
      this.markInvalid(key, `blacklisted after ${key.failureCount} failures: ${reason}`);
    }
  }

  recordResult(key, r) {
    key.inFlight = Math.max(0, key.inFlight - 1);
    this.total.requests++;
    key.lastUsed = Date.now();
    if (r.clientAbort) {
      key.errors++;
      this.total.errors++;
      key.lastError = 'client aborted';
      return;
    }
    if (r.networkError) {
      key.errors++;
      this.total.errors++;
      this.recordFailure(key, 'network error');
      return;
    }
    const s = r.status;
    if (s < 400) {
      key.success++;
      this.total.success++;
      // A successful probe (or any success) fully revives the key.
      key.invalid = false;
      key.unhealthy = false;
      key.failureCount = 0;
      key.failureWindowStart = 0;
      key.invalidatedAt = 0;
      key.throttleUntil = 0;
      key.lastError = '';
      return;
    }
    key.errors++;
    this.total.errors++;
    if (s === 429) {
      key.ratelimited++;
      this.total.ratelimited++;
      let retryMs = this.cooldownMs;
      if (Number.isFinite(r.retryAfterSec) && r.retryAfterSec > 0) {
        retryMs = Math.min(r.retryAfterSec * 1000, MAX_RETRY_AFTER_MS);
      }
      key.throttleUntil = Date.now() + retryMs;
      key.lastError = '429 rate limited';
    } else if (s === 401 || s === 402) {
      key.failureCount++;
      if (key.alwaysTry) {
        key.unhealthy = true;
        key.lastError = `${s} invalid key; retained by alwaysTry`;
      } else {
        this.markInvalid(key, `${s} invalid key`);
      }
    } else if (s >= 500) {
      this.recordFailure(key, `http ${s}`);
    }
  }

  recordTokens(totalTokens, model = '') {
    const value = Number(totalTokens);
    if (!Number.isFinite(value) || value <= 0) return;
    this.total.tokens += value;
    this.operations?.recordTokens({
      provider: this.providerId,
      model,
      tokens: value,
    });
  }

  state(key) {
    if (!key.enabled) return 'disabled';
    if (key.invalid && !key.alwaysTry) return 'invalid';
    if (key.throttleUntil > Date.now()) return 'cooldown';
    if (key.invalid || key.unhealthy) return 'unhealthy';
    return 'healthy';
  }

  stats() {
    const now = Date.now();
    return {
      total: { ...this.total },
      keys: this.keys.map(k => ({
        name: k.name,
        state: this.state(k),
        weight: k.weight,
        enabled: k.enabled,
        alwaysTry: k.alwaysTry,
        inFlight: k.inFlight,
        total: k.success + k.errors,
        success: k.success,
        errors: k.errors,
        ratelimited: k.ratelimited,
        failureCount: k.failureCount,
        invalid: k.invalid,
        unhealthy: k.unhealthy || (k.alwaysTry && k.invalid),
        cooldownSec: k.throttleUntil > now ? Math.ceil((k.throttleUntil - now) / 1000) : 0,
        lastUsed: k.lastUsed,
        lastError: k.lastError,
        balance: k.balance ? {
          isAvailable: k.balance.isAvailable,
          items: k.balance.items.map(item => ({ ...item })),
        } : null,
        balanceUpdatedAt: k.balanceUpdatedAt,
        balanceError: k.balanceError,
      })),
    };
  }
}
async function fetchKeyBalance(runtime, key) {
  const query = effectiveBalanceQuery(runtime.provider);
  if (!query) throw Object.assign(new Error('balance query is not configured'), { statusCode: 409 });
  return executeBalanceQuery({
    query,
    provider: runtime.provider,
    key,
    agent: runtime.agent,
    ...(runtime.settings.mock ? { mockResponse: mockBalanceResponse() } : {}),
  });
}

export function mockBalanceResponse() {
  return {
    is_available: true,
    balance_infos: [{
      currency: 'CNY',
      total_balance: '88.80',
      granted_balance: '8.80',
      topped_up_balance: '80.00',
    }],
  };
}

export async function refreshKeyBalance(runtime, key) {
  const generation = runtime.balanceRefreshGeneration;
  if (
    key.balanceRefreshTask
    && key.balanceRefreshTask.generation === generation
  ) {
    return key.balanceRefreshTask.promise;
  }
  const sequence = (key.balanceRefreshSequence || 0) + 1;
  key.balanceRefreshSequence = sequence;
  const refreshPromise = (async () => {
    try {
      const balance = await fetchKeyBalance(runtime, key);
      if (
        runtime.balanceRefreshGeneration !== generation
        || key.balanceRefreshSequence !== sequence
        || !runtime.pool.keys.includes(key)
      ) {
        return balance;
      }
      key.balance = balance;
      key.balanceUpdatedAt = Date.now();
      key.balanceError = '';
      return balance;
    } catch (error) {
      if (
        runtime.balanceRefreshGeneration === generation
        && key.balanceRefreshSequence === sequence
        && runtime.pool.keys.includes(key)
      ) {
        key.balanceError = error.message;
      }
      throw error;
    }
  })();
  const task = { generation, promise: refreshPromise };
  key.balanceRefreshTask = task;
  try {
    return await refreshPromise;
  } finally {
    if (key.balanceRefreshTask === task) key.balanceRefreshTask = null;
  }
}

function startBalanceRefresh(runtime, log) {
  const { pool, settings } = runtime;
  const generation = Symbol('balance-refresh');
  runtime.balanceRefreshGeneration = generation;
  if (!runtime.provider.enabled) return () => {};
  const query = effectiveBalanceQuery(runtime.provider);
  if (!query) {
    for (const key of pool.keys) {
      key.balance = null;
      key.balanceUpdatedAt = null;
      key.balanceError = '';
    }
    return () => {};
  }
  const refreshMs = query.refreshMs ?? settings.balanceRefreshMs;
  if (refreshMs <= 0) return () => {};
  let refreshing = false;
  let stopped = false;
  const refresh = async () => {
    if (refreshing || stopped) return;
    refreshing = true;
    try {
      const keys = pool.keys.filter(key => key.enabled);
      let nextIndex = 0;
      const worker = async () => {
        while (!stopped && nextIndex < keys.length) {
          const key = keys[nextIndex++];
          try {
            await refreshKeyBalance(runtime, key);
          } catch (err) {
            if (stopped || runtime.balanceRefreshGeneration !== generation || !pool.keys.includes(key)) continue;
            key.balanceError = err.message;
            log(`balance refresh failed provider=${runtime.provider.id} key=${key.name}: ${err.message}`);
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(4, keys.length) }, worker));
    } finally {
      refreshing = false;
    }
  };

  refresh();
  const timer = setInterval(refresh, refreshMs);
  timer.unref();
  return () => {
    stopped = true;
    if (runtime.balanceRefreshGeneration === generation) runtime.balanceRefreshGeneration = null;
    clearInterval(timer);
  };
}

function sameKeyConfig(a, b) {
  return JSON.stringify(a.keys) === JSON.stringify(b.keys);
}

function sameBalanceQuery(a, b) {
  return JSON.stringify(a.balanceQuery || null) === JSON.stringify(b.balanceQuery || null);
}

function canReuseRuntime(a, b) {
  return a.baseUrl === b.baseUrl;
}

export class ProviderRegistry {
  constructor(settings, log, operations = null) {
    this.settings = settings;
    this.log = log;
    this.operations = operations;
    this.entries = new Map();
    this.retiredEntries = new Set();
    this.aliases = new Map();
    this.active = false;
    this.apply(settings);
  }

  createRuntime(provider) {
    const protocol = new URL(provider.baseUrl).protocol;
    const Agent = protocol === 'https:' ? https.Agent : http.Agent;
    const runtime = {
      provider,
      settings: this.settings,
      pool: new KeyPool(provider.keys, this.settings, provider.id, this.operations),
      agent: this.settings.mock ? undefined : new Agent({ keepAlive: true, maxSockets: 64 }),
      stopBalanceRefresh: () => {},
      activeRequests: 0,
      retired: false,
      closed: false,
      retain: () => {},
      release: () => {},
    };
    runtime.retain = () => this.retainRuntime(runtime);
    runtime.release = () => this.releaseRuntime(runtime);
    if (this.active) runtime.stopBalanceRefresh = startBalanceRefresh(runtime, this.log);
    return runtime;
  }

  restartBalanceRefresh(runtime) {
    runtime.stopBalanceRefresh();
    runtime.stopBalanceRefresh = this.active ? startBalanceRefresh(runtime, this.log) : () => {};
  }

  activate() {
    if (this.active) return;
    this.active = true;
    for (const runtime of this.entries.values()) this.restartBalanceRefresh(runtime);
  }

  destroyRuntime(runtime) {
    if (runtime.closed) return;
    runtime.closed = true;
    runtime.stopBalanceRefresh();
    runtime.stopBalanceRefresh = () => {};
    runtime.agent?.destroy();
    this.retiredEntries.delete(runtime);
  }

  retireRuntime(runtime) {
    if (runtime.closed || runtime.retired) return;
    runtime.retired = true;
    runtime.stopBalanceRefresh();
    runtime.stopBalanceRefresh = () => {};
    if (runtime.activeRequests === 0) {
      this.destroyRuntime(runtime);
      return;
    }
    this.retiredEntries.add(runtime);
  }

  retainRuntime(runtime) {
    runtime.activeRequests++;
  }

  releaseRuntime(runtime) {
    runtime.activeRequests = Math.max(0, runtime.activeRequests - 1);
    if (runtime.retired && runtime.activeRequests === 0) this.destroyRuntime(runtime);
  }

  async waitForIdle(timeoutMs = 2000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const runtimes = new Set([...this.entries.values(), ...this.retiredEntries]);
      if ([...runtimes].every(runtime => runtime.activeRequests === 0)) return true;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    return false;
  }

  rebuildAliases() {
    this.aliases.clear();
    for (const runtime of this.entries.values()) {
      if (!runtime.provider.enabled) continue;
      for (const model of runtime.provider.models) {
        const route = { runtime, model };
        this.aliases.set(providerModelAlias(runtime.provider.id, model.id), route);
        this.aliases.set(codexModelAlias(runtime.provider.id, model.id), route);
      }
    }
  }

  apply(nextConfig) {
    validateProviderConfig(nextConfig, { allowSetup: true });
    const nextEntries = new Map();
    for (const provider of nextConfig.providers) {
      const existing = this.entries.get(provider.id);
      if (existing && canReuseRuntime(existing.provider, provider)) {
        const refreshBalance = existing.provider.enabled !== provider.enabled
          || !sameKeyConfig(existing.provider, provider)
          || !sameBalanceQuery(existing.provider, provider);
        existing.provider = provider;
        existing.settings = this.settings;
        const keyChanges = existing.pool.reconcile(provider.keys, this.settings);
        if (refreshBalance) this.restartBalanceRefresh(existing);
        if (keyChanges.added || keyChanges.removed) {
          this.log(`provider=${provider.id} keys reconciled added=${keyChanges.added} removed=${keyChanges.removed}`);
        }
        nextEntries.set(provider.id, existing);
      } else {
        if (existing) this.retireRuntime(existing);
        nextEntries.set(provider.id, this.createRuntime(provider));
      }
    }
    for (const [id, runtime] of this.entries) {
      if (!nextEntries.has(id)) this.retireRuntime(runtime);
    }
    this.entries = nextEntries;
    this.settings.schemaVersion = 2;
    this.settings.setupPending = nextConfig.setupPending === true;
    this.settings.defaultProvider = nextConfig.defaultProvider;
    this.settings.defaultModel = nextConfig.defaultModel;
    this.settings.providers = nextConfig.providers;
    const defaultProvider = nextConfig.providers.find(provider => provider.id === nextConfig.defaultProvider);
    this.settings.upstream = defaultProvider?.baseUrl || '';
    this.settings.keys = defaultProvider?.keys || [];
    this.rebuildAliases();
  }

  updateSettings(changes) {
    const refreshBalance = Object.hasOwn(changes, 'balanceRefreshMs')
      && changes.balanceRefreshMs !== this.settings.balanceRefreshMs;
    Object.assign(this.settings, changes);
    for (const runtime of this.entries.values()) {
      runtime.settings = this.settings;
      runtime.pool.reconcile(runtime.provider.keys, this.settings);
      if (refreshBalance) this.restartBalanceRefresh(runtime);
    }
  }

  get(providerId) {
    return this.entries.get(providerId) || null;
  }

  getDefault() {
    return this.get(this.settings.defaultProvider);
  }

  resolveAlias(alias) {
    return this.aliases.get(alias) || null;
  }

  listAliases() {
    return [...this.aliases.entries()].map(([alias, route]) => ({
      alias,
      providerId: route.runtime.provider.id,
      model: route.model,
    }));
  }

  close() {
    this.active = false;
    const runtimes = new Set([...this.entries.values(), ...this.retiredEntries]);
    for (const runtime of runtimes) this.destroyRuntime(runtime);
    this.entries.clear();
    this.retiredEntries.clear();
    this.aliases.clear();
  }
}
