#!/usr/bin/env node
'use strict';

import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import { URL, fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Transform } from 'node:stream';
import { buildCodexArtifacts } from './codex-config.mjs';
import {
  DEFAULT_UPSTREAM,
  keyFingerprint,
  normalizeBaseUrl,
  normalizeConfig,
  normalizeIdentifier,
  normalizeProvider,
  persistConfig,
  providerModelAlias,
  serializableConfig,
  validateProviderConfig,
} from './config-core.mjs';

const VERSION = '2.0.0';
const PROJECT_DIR = path.dirname(fileURLToPath(import.meta.url));
const UI_DIST_DIR = path.join(PROJECT_DIR, 'ui', 'dist');
const HOP_HEADERS = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'proxy-connection',
]);
const SESSION_SECRET = crypto.randomBytes(32).toString('hex');
const COOKIE_NAME = 'dsgw';
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

function secureEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

function sessionCookie(token) {
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const expiry = Date.now() + SESSION_TTL_MS;
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(`${tokenHash}:${expiry}`).digest('hex');
  return `v1.${expiry}.${sig}`;
}

function cookieValid(cookie, token) {
  const m = /^v1\.(\d+)\.([0-9a-f]{64})$/.exec(cookie || '');
  if (!m) return false;
  const expiry = Number(m[1]);
  if (!Number.isFinite(expiry) || expiry < Date.now()) return false;
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(`${tokenHash}:${expiry}`).digest('hex');
  return secureEqual(Buffer.from(expected, 'hex'), Buffer.from(m[2], 'hex'));
}

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

const USAGE = `deepseek-gateway v${VERSION}

Usage: node gateway.mjs [options]

Options:
  --config <path>       config JSON file (default: ./keys.json, then ~/.deepseek-gateway/keys.json)
  --keys <list>         comma-separated keys, format: "sk-xxx" or "name=sk-xxx"
  --port <n>            listen port (default 8787)
  --host <addr>         listen host (default 127.0.0.1)
  --upstream <url>      upstream base URL (default https://api.deepseek.com)
  --token <t>           require Authorization: Bearer <t> on gateway requests
  --cooldown-ms <n>     429 cooldown duration (default 60000)
  --blacklist-threshold <n>
                        cumulative failures before disabling a key (default 3; 0 disables)
  --breaker <n>         legacy alias for --blacklist-threshold
  --balance-refresh-ms <n>
                        key balance refresh interval (default 300000; 0 disables)
  --max-retries <n>     failover attempts per request (default 2)
  --max-body-bytes <n>  max request body size in bytes (default 67108864)
  --mock                act as a fake upstream (key suffix ok/429/500/401/402/slow)
  --quiet               suppress request logging
  --help                show this help

Env vars: DEEPSEEK_KEYS, DS_GATEWAY_PORT, DS_UPSTREAM, DS_GATEWAY_TOKEN,
DS_GATEWAY_CONFIG, DS_COOLDOWN_MS, DS_BLACKLIST_THRESHOLD,
DS_BALANCE_REFRESH_MS, DS_MAX_RETRIES, DS_MAX_BODY_BYTES
(DS_BREAKER remains as a legacy alias)

Endpoints: / proxy (chat/completions, responses, any path), /health JSON,
/ dashboard (browser login via /login when token is set), /login, /logout`;

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--port': opts.port = Number(argv[++i]); break;
      case '--host': opts.host = argv[++i]; break;
      case '--upstream': opts.upstream = argv[++i]; break;
      case '--keys': opts.keys = argv[++i]; break;
      case '--config': opts.config = argv[++i]; break;
      case '--token': opts.token = argv[++i]; break;
      case '--mock': opts.mock = true; break;
      case '--quiet': opts.quiet = true; break;
      case '--cooldown-ms': opts.cooldownMs = Number(argv[++i]); break;
      case '--blacklist-threshold':
      case '--breaker': opts.blacklistThreshold = Number(argv[++i]); break;
      case '--balance-refresh-ms': opts.balanceRefreshMs = Number(argv[++i]); break;
      case '--max-retries': opts.maxRetries = Number(argv[++i]); break;
      case '--max-body-bytes': opts.maxBodyBytes = Number(argv[++i]); break;
      case '--help':
      case '-h': opts.help = true; break;
      default:
        if (a.startsWith('-')) { console.error(`unknown option: ${a}`); opts.help = true; }
        else opts.positional = a;
    }
  }
  return opts;
}

function configCandidates() {
  return ['./keys.json', path.join(os.homedir(), '.deepseek-gateway', 'keys.json')];
}

function splitKeyToken(token) {
  token = token.trim();
  if (!token) return null;
  if (/^sk-/i.test(token)) return { name: null, secret: token };
  const eq = token.indexOf('=');
  const colon = token.indexOf(':');
  let name = null;
  let secret = token;
  if (eq > 0) { name = token.slice(0, eq); secret = token.slice(eq + 1); }
  else if (colon > 0) { name = token.slice(0, colon); secret = token.slice(colon + 1); }
  return { name, secret };
}

function loadConfig(opts) {
  const fileConfig = {
    port: 8787,
    host: '127.0.0.1',
    upstream: DEFAULT_UPSTREAM,
    cooldownMs: 60000,
    blacklistThreshold: 3,
    balanceRefreshMs: 5 * 60 * 1000,
    maxRetries: 2,
    timeoutMs: 0,
    maxBodyBytes: 64 * 1024 * 1024,
    token: '',
    keys: [],
  };
  const configPath = opts.config || process.env.DS_GATEWAY_CONFIG || configCandidates().find(p => fs.existsSync(p)) || configCandidates()[0];
  if (fs.existsSync(configPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (parsed.blacklistThreshold === undefined && parsed.breakerThreshold !== undefined) {
        parsed.blacklistThreshold = parsed.breakerThreshold;
      }
      Object.assign(fileConfig, parsed);
    } catch (err) {
      console.error(`failed to read config ${configPath}: ${err.message}`);
      process.exit(1);
    }
  }
  const hasProviderConfig = Array.isArray(fileConfig.providers);
  const externalKeys = [];
  const addExternalKey = (name, secret, weight = 1) => {
    if (!secret) return;
    externalKeys.push({
      name: name || `key-${externalKeys.length + 1}`,
      key: secret,
      weight,
      enabled: true,
    });
  };
  if (process.env.DEEPSEEK_KEYS) process.env.DEEPSEEK_KEYS.split(',').forEach(token => { const parsed = splitKeyToken(token); if (parsed) addExternalKey(parsed.name, parsed.secret); });
  if (opts.keys) opts.keys.split(',').forEach(token => { const parsed = splitKeyToken(token); if (parsed) addExternalKey(parsed.name, parsed.secret); });

  let persistedConfig = null;
  try {
    persistedConfig = normalizeConfig(fileConfig);
  } catch (error) {
    const noLegacyFileKeys = !hasProviderConfig && (!Array.isArray(fileConfig.keys) || !fileConfig.keys.length);
    if (!(noLegacyFileKeys && (externalKeys.length || opts.mock))) throw error;
  }

  const effective = persistedConfig ? serializableConfig(persistedConfig) : structuredClone(fileConfig);
  if (!hasProviderConfig && !persistedConfig && externalKeys.length) {
    effective.keys = [...(effective.keys || []), ...externalKeys];
  }
  if (opts.mock && !hasProviderConfig && !(effective.keys || []).length) {
    effective.keys = [{ name: 'mock', key: 'sk-mock-ok', weight: 1 }];
  }
  const scalarOverrides = {};
  const applyScalarOverride = (field, value, source) => {
    effective[field] = value;
    scalarOverrides[field] = source;
  };
  if (process.env.DS_GATEWAY_PORT) applyScalarOverride('port', Number(process.env.DS_GATEWAY_PORT), 'DS_GATEWAY_PORT');
  if (opts.port !== undefined) applyScalarOverride('port', opts.port, '--port');
  if (process.env.DS_GATEWAY_TOKEN) applyScalarOverride('token', process.env.DS_GATEWAY_TOKEN, 'DS_GATEWAY_TOKEN');
  if (opts.token) applyScalarOverride('token', opts.token, '--token');
  if (process.env.DS_COOLDOWN_MS) applyScalarOverride('cooldownMs', Number(process.env.DS_COOLDOWN_MS), 'DS_COOLDOWN_MS');
  if (opts.cooldownMs !== undefined) applyScalarOverride('cooldownMs', opts.cooldownMs, '--cooldown-ms');
  if (process.env.DS_BREAKER) applyScalarOverride('blacklistThreshold', Number(process.env.DS_BREAKER), 'DS_BREAKER');
  if (process.env.DS_BLACKLIST_THRESHOLD) applyScalarOverride('blacklistThreshold', Number(process.env.DS_BLACKLIST_THRESHOLD), 'DS_BLACKLIST_THRESHOLD');
  if (opts.blacklistThreshold !== undefined) applyScalarOverride('blacklistThreshold', opts.blacklistThreshold, '--blacklist-threshold');
  if (process.env.DS_BALANCE_REFRESH_MS) applyScalarOverride('balanceRefreshMs', Number(process.env.DS_BALANCE_REFRESH_MS), 'DS_BALANCE_REFRESH_MS');
  if (opts.balanceRefreshMs !== undefined) applyScalarOverride('balanceRefreshMs', opts.balanceRefreshMs, '--balance-refresh-ms');
  if (process.env.DS_MAX_RETRIES) applyScalarOverride('maxRetries', Number(process.env.DS_MAX_RETRIES), 'DS_MAX_RETRIES');
  if (opts.maxRetries !== undefined) applyScalarOverride('maxRetries', opts.maxRetries, '--max-retries');
  if (process.env.DS_MAX_BODY_BYTES) applyScalarOverride('maxBodyBytes', Number(process.env.DS_MAX_BODY_BYTES), 'DS_MAX_BODY_BYTES');
  if (opts.maxBodyBytes !== undefined) applyScalarOverride('maxBodyBytes', opts.maxBodyBytes, '--max-body-bytes');
  if (opts.host) applyScalarOverride('host', opts.host, '--host');

  const normalized = normalizeConfig(effective);
  const defaultProvider = normalized.providers.find(provider => provider.id === normalized.defaultProvider);
  if (process.env.DS_UPSTREAM) defaultProvider.baseUrl = normalizeBaseUrl(process.env.DS_UPSTREAM, 'DS_UPSTREAM');
  if (opts.upstream) defaultProvider.baseUrl = normalizeBaseUrl(opts.upstream, '--upstream');
  if (hasProviderConfig && externalKeys.length) defaultProvider.keys = externalKeys;
  if (!hasProviderConfig && persistedConfig && externalKeys.length) {
    defaultProvider.keys = [...defaultProvider.keys, ...externalKeys];
  }
  normalized.configPath = path.resolve(configPath);
  normalized.upstream = defaultProvider.baseUrl;
  normalized.keys = defaultProvider.keys;
  normalized.mock = !!opts.mock;
  normalized.quiet = !!opts.quiet;
  validateProviderConfig(normalized);
  const providerOverrides = [];
  if (process.env.DEEPSEEK_KEYS) providerOverrides.push('DEEPSEEK_KEYS');
  if (opts.keys) providerOverrides.push('--keys');
  if (process.env.DS_UPSTREAM) providerOverrides.push('DS_UPSTREAM');
  if (opts.upstream) providerOverrides.push('--upstream');
  Object.defineProperties(normalized, {
    _persistedConfig: { value: persistedConfig, writable: true },
    _providerOverrides: { value: providerOverrides, writable: true },
    _scalarOverrides: { value: scalarOverrides, writable: true },
  });
  return normalized;
}

class KeyPool {
  constructor(keys, cfg) {
    this.keys = keys.map(key => this.createKeyState(key));
    this.cursor = 0;
    this.cooldownMs = cfg.cooldownMs;
    this.blacklistThreshold = cfg.blacklistThreshold;
    this.total = { requests: 0, success: 0, errors: 0, ratelimited: 0, tokens: 0 };
    this._usageBuf = '';
  }

  createKeyState(key) {
    return {
      ...key,
      inFlight: 0,
      success: 0,
      errors: 0,
      ratelimited: 0,
      failureCount: 0,
      invalid: false,
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
    const avail = this.keys.filter(k => k.enabled && !exclude.includes(k.name) && !k.invalid && now >= k.throttleUntil);
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
    key.throttleUntil = 0;
    key.lastError = reason;
  }

  recordFailure(key, reason) {
    key.failureCount++;
    key.lastError = reason;
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
      if (!key.invalid) {
        key.throttleUntil = 0;
        key.lastError = '';
      }
      return;
    }
    key.errors++;
    this.total.errors++;
    if (s === 429) {
      key.ratelimited++;
      this.total.ratelimited++;
      key.throttleUntil = Date.now() + (r.retryAfterSec ? r.retryAfterSec * 1000 : this.cooldownMs);
      key.lastError = '429 rate limited';
    } else if (s === 401 || s === 402 || s === 403) {
      key.failureCount++;
      this.markInvalid(key, `${s} invalid key`);
    } else if (s >= 500) {
      this.recordFailure(key, `http ${s}`);
    }
  }

  trackTokens(chunk) {
    const s = chunk.toString('utf8');
    this._usageBuf = (this._usageBuf + s).slice(-16384);
    const re = /"total_tokens"\s*:\s*(\d+)/g;
    re.lastIndex = Math.max(0, this._usageBuf.length - s.length);
    let m;
    while ((m = re.exec(this._usageBuf)) !== null) this.total.tokens += Number(m[1]);
  }

  state(key) {
    if (!key.enabled) return 'disabled';
    if (key.invalid) return 'invalid';
    if (key.throttleUntil > Date.now()) return 'cooldown';
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
        inFlight: k.inFlight,
        total: k.success + k.errors,
        success: k.success,
        errors: k.errors,
        ratelimited: k.ratelimited,
        failureCount: k.failureCount,
        invalid: k.invalid,
        cooldownSec: k.throttleUntil > now ? Math.ceil((k.throttleUntil - now) / 1000) : 0,
        lastUsed: k.lastUsed,
        lastError: k.lastError,
        balance: k.balance ? {
          isAvailable: k.balance.isAvailable,
          infos: k.balance.infos.map(info => ({ ...info })),
        } : null,
        balanceUpdatedAt: k.balanceUpdatedAt,
        balanceError: k.balanceError,
      })),
    };
  }
}

function normalizeBalance(payload) {
  if (!payload || !Array.isArray(payload.balance_infos)) throw new Error('invalid balance response');
  return {
    isAvailable: payload.is_available !== false,
    infos: payload.balance_infos.map(info => ({
      currency: String(info.currency || ''),
      totalBalance: String(info.total_balance ?? ''),
      grantedBalance: String(info.granted_balance ?? ''),
      toppedUpBalance: String(info.topped_up_balance ?? ''),
    })).filter(info => info.currency && info.totalBalance),
  };
}

function readJsonResponse(res, maxBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    res.on('data', chunk => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error('balance response too large'));
        res.destroy();
        return;
      }
      chunks.push(chunk);
    });
    res.on('end', () => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        reject(new Error(`balance request returned ${res.statusCode}`));
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('invalid balance response'));
      }
    });
    res.on('error', reject);
  });
}

async function fetchKeyBalance(runtime, key) {
  if (runtime.settings.mock) {
    return normalizeBalance({
      is_available: true,
      balance_infos: [{
        currency: 'CNY',
        total_balance: '88.80',
        granted_balance: '8.80',
        topped_up_balance: '80.00',
      }],
    });
  }

  const url = new URL('/user/balance', runtime.provider.baseUrl);
  const mod = url.protocol === 'https:' ? https : http;
  const payload = await new Promise((resolve, reject) => {
    const req = mod.request(url, {
      method: 'GET',
      headers: { authorization: `Bearer ${key.key}`, accept: 'application/json' },
      agent: runtime.agent,
    }, res => readJsonResponse(res).then(resolve, reject));
    req.setTimeout(10000, () => req.destroy(new Error('balance request timeout')));
    req.on('error', reject);
    req.end();
  });
  return normalizeBalance(payload);
}

function supportsBalanceQuery(runtime) {
  if (runtime.settings.mock) return true;
  try {
    const hostname = new URL(runtime.provider.baseUrl).hostname.toLowerCase();
    return hostname === 'api.deepseek.com' || hostname.endsWith('.api.deepseek.com');
  } catch {
    return false;
  }
}

function startBalanceRefresh(runtime, log) {
  const { pool, settings } = runtime;
  if (!runtime.provider.enabled) return () => {};
  let refreshing = false;
  const refresh = async () => {
    if (refreshing) return;
    refreshing = true;
    try {
      await Promise.all(pool.keys.filter(key => key.enabled).map(async key => {
        try {
          key.balance = await fetchKeyBalance(runtime, key);
          key.balanceUpdatedAt = Date.now();
          key.balanceError = '';
        } catch (err) {
          key.balanceError = err.message;
          log(`balance refresh failed provider=${runtime.provider.id} key=${key.name}: ${err.message}`);
        }
      }));
    } finally {
      refreshing = false;
    }
  };

  if (settings.balanceRefreshMs <= 0) return () => {};
  if (!supportsBalanceQuery(runtime)) {
    for (const key of pool.keys) key.balanceError = 'balance is only supported for DeepSeek';
    return () => {};
  }
  refresh();
  const timer = setInterval(refresh, settings.balanceRefreshMs);
  timer.unref();
  return () => clearInterval(timer);
}

function sameKeyConfig(a, b) {
  return JSON.stringify(a.keys) === JSON.stringify(b.keys);
}

function canReuseRuntime(a, b) {
  return a.baseUrl === b.baseUrl;
}

class ProviderRegistry {
  constructor(settings, log) {
    this.settings = settings;
    this.log = log;
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
      pool: new KeyPool(provider.keys, this.settings),
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

  rebuildAliases() {
    this.aliases.clear();
    for (const runtime of this.entries.values()) {
      if (!runtime.provider.enabled) continue;
      for (const model of runtime.provider.models) {
        this.aliases.set(providerModelAlias(runtime.provider.id, model.id), { runtime, model });
      }
    }
  }

  apply(nextConfig) {
    validateProviderConfig(nextConfig);
    const nextEntries = new Map();
    for (const provider of nextConfig.providers) {
      const existing = this.entries.get(provider.id);
      if (existing && canReuseRuntime(existing.provider, provider)) {
        const refreshBalance = existing.provider.enabled !== provider.enabled
          || !sameKeyConfig(existing.provider, provider);
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
    this.settings.defaultProvider = nextConfig.defaultProvider;
    this.settings.defaultModel = nextConfig.defaultModel;
    this.settings.providers = nextConfig.providers;
    const defaultProvider = nextConfig.providers.find(provider => provider.id === nextConfig.defaultProvider);
    this.settings.upstream = defaultProvider.baseUrl;
    this.settings.keys = defaultProvider.keys;
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

  close() {
    this.active = false;
    const runtimes = new Set([...this.entries.values(), ...this.retiredEntries]);
    for (const runtime of runtimes) this.destroyRuntime(runtime);
    this.entries.clear();
    this.retiredEntries.clear();
    this.aliases.clear();
  }
}

function retryAfterSec(res) {
  const raw = res.headers['retry-after'] || res.headers['Retry-After'];
  if (!raw) return null;
  const n = parseInt(raw, 10);
  if (!Number.isNaN(n)) return n;
  const d = Date.parse(raw);
  return Number.isNaN(d) ? null : Math.max(1, Math.ceil((d - Date.now()) / 1000));
}

function upstreamRequestUrl(baseUrl, requestUrl) {
  const incoming = new URL(requestUrl || '/', 'http://gateway.local');
  const upstream = new URL(baseUrl);
  let requestPath = incoming.pathname;
  if (upstream.pathname.endsWith('/v1') && requestPath.startsWith('/v1/')) requestPath = requestPath.slice(3);
  upstream.pathname = `${upstream.pathname.replace(/\/$/, '')}/${requestPath.replace(/^\//, '')}`;
  upstream.search = incoming.search;
  return upstream;
}

const MODEL_FETCH_TIMEOUT_MS = 15000;
const MODEL_RESPONSE_MAX_BYTES = 2 * 1024 * 1024;
const MODEL_COMPAT_SUFFIXES = [
  '/api/claudecode', '/api/anthropic', '/apps/anthropic', '/api/coding',
  '/claudecode', '/anthropic', '/step_plan', '/coding', '/claude',
];

function normalizeModelFetchUrl(value, field = 'modelsUrl') {
  let url;
  try {
    url = new URL(String(value || ''));
  } catch {
    throw new Error(`${field} must be a valid HTTP(S) URL`);
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) {
    throw new Error(`${field} must be an HTTP(S) URL without credentials or hash`);
  }
  return url.toString();
}

function appendModelPath(baseUrl, suffix) {
  const url = new URL(baseUrl);
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/${suffix.replace(/^\/+/, '')}`;
  url.search = '';
  return url.toString();
}

function modelFetchUrlCandidates(baseUrl, override = '') {
  if (override.trim()) return [normalizeModelFetchUrl(override.trim())];
  const normalized = normalizeBaseUrl(baseUrl, 'baseUrl');
  const parsed = new URL(normalized);
  const pathname = parsed.pathname.replace(/\/+$/, '');
  const candidates = [];
  const add = value => {
    if (!candidates.includes(value)) candidates.push(value);
  };
  const versionMatch = /\/v\d+$/i.test(pathname);
  if (versionMatch) {
    add(appendModelPath(normalized, 'models'));
    if (!/\/v1$/i.test(pathname)) add(appendModelPath(normalized, 'v1/models'));
  } else {
    add(appendModelPath(normalized, 'v1/models'));
    if (!pathname || pathname === '/') add(appendModelPath(normalized, 'models'));
  }
  const lowerPath = pathname.toLowerCase();
  const suffix = MODEL_COMPAT_SUFFIXES.find(item => lowerPath.endsWith(item));
  if (suffix) {
    const root = new URL(normalized);
    root.pathname = pathname.slice(0, pathname.length - suffix.length);
    root.search = '';
    const rootUrl = root.toString().replace(/\/$/, '');
    add(appendModelPath(rootUrl, 'v1/models'));
    add(appendModelPath(rootUrl, 'models'));
  }
  return candidates;
}

function modelDraftIdentifier(raw, used = new Set()) {
  const base = String(raw || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 63)
    .replace(/-+$/, '') || 'model';
  let id = base;
  let suffix = 2;
  while (used.has(id)) {
    const tail = `-${suffix++}`;
    id = `${base.slice(0, 63 - tail.length)}${tail}`;
  }
  used.add(id);
  return id;
}

function readModelResponse(res) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const fail = error => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    res.on('data', chunk => {
      size += chunk.length;
      if (size > MODEL_RESPONSE_MAX_BYTES) {
        res.destroy();
        fail(new Error('model response too large'));
        return;
      }
      chunks.push(chunk);
    });
    res.on('end', () => {
      if (settled) return;
      settled = true;
      const text = Buffer.concat(chunks).toString('utf8');
      if (res.statusCode < 200 || res.statusCode >= 300) {
        reject(Object.assign(new Error(`HTTP ${res.statusCode}: ${text.slice(0, 512)}`), { statusCode: res.statusCode }));
        return;
      }
      try {
        resolve(JSON.parse(text || '{}'));
      } catch (error) {
        reject(new Error(`failed to parse model response: ${error.message}`));
      }
    });
    res.on('error', fail);
  });
}

async function fetchModelEndpoint(url, secret) {
  const parsed = new URL(url);
  const mod = parsed.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const headers = { accept: 'application/json' };
    if (secret) headers.authorization = `Bearer ${secret}`;
    const req = mod.request(parsed, { method: 'GET', headers }, res => {
      readModelResponse(res).then(resolve, reject);
    });
    req.setTimeout(MODEL_FETCH_TIMEOUT_MS, () => req.destroy(new Error('model request timeout')));
    req.on('error', reject);
    req.end();
  });
}

function normalizeFetchedModels(payload) {
  const entries = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.data)
      ? payload.data
      : Array.isArray(payload?.models)
        ? payload.models
        : null;
  if (!entries) throw new Error('model response must contain a data array');
  const used = new Set();
  const seenUpstream = new Set();
  const models = [];
  for (const entry of entries) {
    const upstreamModel = typeof entry === 'string'
      ? entry.trim()
      : String(entry?.id ?? entry?.model ?? entry?.name ?? '').trim();
    if (!upstreamModel || upstreamModel.length > 200 || seenUpstream.has(upstreamModel)) continue;
    seenUpstream.add(upstreamModel);
    const ownedBy = typeof entry === 'object' && entry
      ? String(entry.owned_by ?? entry.ownedBy ?? entry.provider ?? '').trim() || null
      : null;
    const name = (typeof entry === 'object' && entry && String(entry.name || '').trim()
      ? String(entry.name).trim()
      : upstreamModel).slice(0, 100);
    models.push({
      id: modelDraftIdentifier(upstreamModel, used),
      name,
      upstreamModel,
      ownedBy,
    });
  }
  return models.sort((a, b) => a.upstreamModel.localeCompare(b.upstreamModel));
}

async function fetchProviderModels(baseUrl, secret, modelsUrl = '') {
  const candidates = modelFetchUrlCandidates(baseUrl, modelsUrl);
  let lastError = null;
  for (const url of candidates) {
    try {
      return normalizeFetchedModels(await fetchModelEndpoint(url, secret));
    } catch (error) {
      lastError = error;
      if (error.statusCode === 404 || error.statusCode === 405) continue;
      throw error;
    }
  }
  throw new Error(`all model endpoints failed: ${lastError?.message || 'no candidates'}`);
}

function resolveRequestRoute(registry, body) {
  let parsed = null;
  let requestedModel = '';
  if (body.length) {
    try {
      parsed = JSON.parse(body.toString('utf8'));
      if (parsed && typeof parsed === 'object' && typeof parsed.model === 'string') requestedModel = parsed.model;
    } catch {
      parsed = null;
    }
  }

  const aliasRoute = requestedModel ? registry.resolveAlias(requestedModel) : null;
  if (!aliasRoute && requestedModel.includes('--')) {
    throw Object.assign(new Error(`unknown or disabled model alias: ${requestedModel}`), { statusCode: 400 });
  }
  const runtime = aliasRoute?.runtime || registry.getDefault();
  if (!runtime || !runtime.provider.enabled) {
    throw Object.assign(new Error('default provider is unavailable'), { statusCode: 503 });
  }
  if (!aliasRoute) {
    return { runtime, body, requestedModel, gatewayModel: requestedModel || registry.settings.defaultModel };
  }
  parsed.model = aliasRoute.model.upstreamModel;
  return {
    runtime,
    body: Buffer.from(JSON.stringify(parsed)),
    requestedModel,
    gatewayModel: requestedModel,
    upstreamModel: aliasRoute.model.upstreamModel,
  };
}

async function forwardOnce(runtime, key, clientReq, body) {
  const { settings } = runtime;
  if (settings.mock) return mockResponse(key, body);
  const u = upstreamRequestUrl(runtime.provider.baseUrl, clientReq.url);
  const headers = {};
  for (const [h, v] of Object.entries(clientReq.headers)) {
    if (HOP_HEADERS.has(h) || h === 'host' || h === 'authorization' || h === 'content-length') continue;
    headers[h] = Array.isArray(v) ? v.join(', ') : v;
  }
  headers.authorization = `Bearer ${key.key}`;
  headers.host = u.host;
  if (body.length) headers['content-length'] = body.length;
  return new Promise((resolve, reject) => {
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(u, { method: clientReq.method, headers, agent: runtime.agent }, res => resolve(res));
    if (settings.timeoutMs) req.setTimeout(settings.timeoutMs, () => req.destroy(new Error(`upstream timeout after ${settings.timeoutMs}ms`)));
    req.on('error', reject);
    req.end(body);
  });
}

async function relay(route, clientReq, clientRes, log) {
  const { runtime, body } = route;
  const { pool, settings, provider } = runtime;
  const started = Date.now();
  runtime.retain();
  let released = false;
  const releaseRuntime = () => {
    if (released) return;
    released = true;
    runtime.release();
  };
  try {
    const enabledKeyCount = pool.keys.filter(key => key.enabled).length;
    const maxRetries = Math.min(settings.maxRetries, enabledKeyCount - 1);
    const attempted = [];
    let res = null;
    let key = null;
    let lastErr = null;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const k = pool.pickKey(attempted);
      if (!k) { lastErr = new Error('no keys available'); break; }
      attempted.push(k.name);
      k.inFlight++;
      try {
        const r = await forwardOnce(runtime, k, clientReq, body);
        const status = r.statusCode;
        if (status < 400) {
          res = r;
          key = k;
          break;
        }
        const ra = retryAfterSec(r);
        pool.recordResult(k, { status, retryAfterSec: ra });
        const retryable = status === 429 || status === 401 || status === 402 || status === 403 || status >= 500;
        if (retryable && attempt < maxRetries) {
          r.resume();
          r.on('error', () => {});
          continue;
        }
        res = r;
        key = k;
        break;
      } catch (err) {
        pool.recordResult(k, { networkError: true });
        lastErr = err;
        if (attempt >= maxRetries) break;
      }
    }
    const ms = Date.now() - started;
    if (!res) {
      log(`502 ${clientReq.method} ${clientReq.url} provider=${provider.id} all-keys-failed ${ms}ms`);
      clientRes.writeHead(502, { 'content-type': 'application/json' });
      clientRes.end(JSON.stringify({ error: { message: lastErr ? lastErr.message : 'all upstream keys failed' } }));
      releaseRuntime();
      return;
    }
    log(`${res.statusCode} ${clientReq.method} ${clientReq.url} provider=${provider.id} model=${route.gatewayModel} key=${key.name} ${ms}ms`);
    relayResponse(clientRes, res, key, pool, res.statusCode >= 400, route, releaseRuntime);
  } catch (error) {
    releaseRuntime();
    throw error;
  }
}

function relayResponse(clientRes, upRes, key, pool, preRecorded, route, releaseRuntime) {
  const headers = {};
  for (const [h, v] of Object.entries(upRes.headers)) {
    if (HOP_HEADERS.has(h)) continue;
    headers[h] = Array.isArray(v) ? v.join(', ') : v;
  }
  headers['x-gateway-key'] = key.name;
  headers['x-gateway-provider'] = route.runtime.provider.id;
  headers['x-gateway-model'] = route.gatewayModel;
  clientRes.writeHead(upRes.statusCode, headers);
  const tracker = new Transform({
    transform(chunk, enc, cb) {
      if (pool) pool.trackTokens(chunk);
      cb(null, chunk);
    },
  });
  let settled = false;
  const finish = result => {
    if (settled) return;
    settled = true;
    try {
      if (!preRecorded) pool.recordResult(key, result);
    } finally {
      releaseRuntime();
    }
  };
  upRes.on('end', () => finish({ status: 200 }));
  upRes.on('error', () => {
    finish({ networkError: true });
    if (!clientRes.writableEnded) clientRes.destroy();
  });
  upRes.on('aborted', () => {
    finish({ networkError: true });
    if (!clientRes.writableEnded) clientRes.destroy();
  });
  upRes.pipe(tracker).pipe(clientRes);
  clientRes.on('close', () => {
    if (!clientRes.writableEnded) {
      finish({ clientAbort: true });
      upRes.destroy();
    }
  });
}

function mockResponse(key, body) {
  return new Promise(resolve => {
    let behavior = 'ok';
    const parts = String(key.key).split('-');
    const suffix = parts[parts.length - 1];
    if (['429', '500', '401', '402', 'slow', 'drip', 'abort'].includes(suffix)) behavior = suffix;
    let bodyObj = {};
    try { bodyObj = JSON.parse(body.toString('utf8') || '{}'); } catch {}
    const model = bodyObj.model || 'deepseek-v4-flash';
    const stream = !!bodyObj.stream;
    const delay = behavior === 'slow' ? 400 : 30;
    setTimeout(() => {
      const statusMap = { 429: 429, 500: 500, 401: 401, 402: 402 };
      const status = statusMap[behavior] || 200;
      const headers = {};
      if (stream && status === 200) {
        headers['content-type'] = 'text/event-stream';
        headers['cache-control'] = 'no-cache';
      } else {
        headers['content-type'] = 'application/json';
      }
      if (behavior === '429') headers['retry-after'] = '1';
      const pt = new PassThrough();
      const frames = [
        JSON.stringify({ type: 'response.output_item.added', gateway_key_name: key.name }),
        JSON.stringify({ type: 'response.output_text.delta', delta: 'hello' }),
        JSON.stringify({ type: 'response.completed', usage: { prompt_tokens: 5, completion_tokens: 10, total_tokens: 15 } }),
      ];
      const writeAll = () => {
        if (stream && status === 200) {
          pt.write(frames.map(f => `data: ${f}\n\n`).join('') + 'data: [DONE]\n\n');
        } else if (status === 200) {
          pt.write(JSON.stringify({
            id: 'mock-1', object: 'chat.completion', model,
            gateway_key_name: key.name,
            usage: { prompt_tokens: 5, completion_tokens: 10, total_tokens: 15 },
          }));
        } else {
          pt.write(JSON.stringify({ error: { message: `mock ${behavior}` } }));
        }
        pt.end();
      };
      if (behavior === 'drip' && stream) {
        let i = 0;
        const iv = setInterval(() => {
          if (i < frames.length) {
            pt.write(`data: ${frames[i++]}\n\n`);
          } else {
            clearInterval(iv);
            pt.end();
          }
        }, 60);
        pt.on('close', () => clearInterval(iv));
      } else if (behavior === 'abort' && stream) {
        pt.write('data: {"type":"response.output_item.added","gateway_key_name":"' + key.name + '"}\n\n');
        setTimeout(() => pt.destroy(new Error('mock abort')), 60);
      } else {
        writeAll();
      }
      resolve({
        statusCode: status,
        headers,
        resume() { pt.resume(); },
        destroy() { pt.destroy(); },
        pipe(dest) { pt.pipe(dest); return dest; },
        on(ev, fn) { pt.on(ev, fn); return this; },
      });
    }, delay);
  });
}

function emptyTotals() {
  return { requests: 0, success: 0, errors: 0, ratelimited: 0, tokens: 0 };
}

function addTotals(target, source) {
  for (const key of Object.keys(target)) target[key] += source[key] || 0;
  return target;
}

function buildHealth(cfg, registry, uptime) {
  const total = emptyTotals();
  const providers = cfg.providers.map(provider => {
    const runtime = registry.get(provider.id);
    const stats = runtime ? runtime.pool.stats() : { total: emptyTotals(), keys: [] };
    addTotals(total, stats.total);
    return {
      id: provider.id,
      name: provider.name,
      baseUrl: cfg.mock ? 'mock' : provider.baseUrl,
      enabled: provider.enabled,
      modelCount: provider.models.length,
      total: stats.total,
      keys: stats.keys,
    };
  });
  const defaultRuntime = registry.getDefault();
  const defaultStats = defaultRuntime ? defaultRuntime.pool.stats() : { keys: [] };
  return {
    status: 'ok',
    version: VERSION,
    mock: cfg.mock,
    upstream: cfg.mock ? 'mock' : defaultRuntime?.provider.baseUrl,
    defaultProvider: cfg.defaultProvider,
    defaultModel: cfg.defaultModel,
    port: cfg.port,
    uptime: Math.round(uptime / 1000),
    total,
    keys: defaultStats.keys,
    providers,
  };
}

function maskedKey(key) {
  const fingerprint = crypto.createHash('sha256').update(key.key).digest('hex').slice(0, 12);
  const suffix = key.key.slice(-4);
  return {
    name: key.name,
    weight: key.weight,
    enabled: key.enabled,
    maskedKey: `****${suffix}`,
    fingerprint,
  };
}

function publicProvider(provider) {
  return {
    id: provider.id,
    name: provider.name,
    baseUrl: provider.baseUrl,
    enabled: provider.enabled,
    models: provider.models.map(model => ({
      ...model,
      alias: providerModelAlias(provider.id, model.id),
    })),
    keys: provider.keys.map(maskedKey),
  };
}

function publicProviderConfig(cfg) {
  return {
    schemaVersion: 2,
    defaultProvider: cfg.defaultProvider,
    defaultModel: cfg.defaultModel,
    providers: cfg.providers.map(publicProvider),
  };
}

const SETTING_FIELDS = [
  'port',
  'host',
  'cooldownMs',
  'blacklistThreshold',
  'balanceRefreshMs',
  'maxRetries',
  'timeoutMs',
  'maxBodyBytes',
  'token',
];
const HOT_SETTING_FIELDS = SETTING_FIELDS.filter(field => !['port', 'host'].includes(field));

function publicScalarSettings(config) {
  return {
    port: config.port,
    host: config.host,
    cooldownMs: config.cooldownMs,
    blacklistThreshold: config.blacklistThreshold,
    balanceRefreshMs: config.balanceRefreshMs,
    maxRetries: config.maxRetries,
    timeoutMs: config.timeoutMs,
    maxBodyBytes: config.maxBodyBytes,
    tokenConfigured: Boolean(config.token),
  };
}

function publicSettings(cfg) {
  const persisted = cfg._persistedConfig || cfg;
  return {
    writable: Boolean(cfg._persistedConfig),
    persisted: publicScalarSettings(persisted),
    effective: publicScalarSettings(cfg),
    overrides: { ...cfg._scalarOverrides },
    restartRequired: ['host', 'port'].filter(field => persisted[field] !== cfg[field]),
  };
}

function nextSettingsConfig(cfg, payload) {
  if (!cfg._persistedConfig) {
    throw Object.assign(
      new Error('settings are read-only until a valid config file is created'),
      { statusCode: 409 },
    );
  }
  const allowed = new Set([...SETTING_FIELDS, 'clearToken']);
  const unknown = Object.keys(payload).filter(field => !allowed.has(field));
  if (unknown.length) throw new Error(`unknown settings: ${unknown.join(', ')}`);
  if (Object.hasOwn(payload, 'clearToken') && typeof payload.clearToken !== 'boolean') {
    throw new Error('clearToken must be a boolean');
  }
  if (payload.clearToken && Object.hasOwn(payload, 'token')) {
    throw new Error('token and clearToken cannot be used together');
  }

  const changes = {};
  for (const field of SETTING_FIELDS) {
    if (!Object.hasOwn(payload, field)) continue;
    if (field === 'host') {
      if (typeof payload.host !== 'string' || !payload.host.trim() || payload.host.length > 255) {
        throw new Error('host must be a non-empty string of at most 255 characters');
      }
      changes.host = payload.host.trim();
    } else if (field === 'token') {
      if (typeof payload.token !== 'string') throw new Error('token must be a string');
      changes.token = payload.token;
    } else {
      if (typeof payload[field] !== 'number') throw new Error(`${field} must be a number`);
      changes[field] = payload[field];
    }
  }
  if (payload.clearToken) changes.token = '';
  return normalizeConfig({ ...serializableConfig(cfg._persistedConfig), ...changes });
}

function commitSettingsConfig(cfg, registry, next) {
  persistConfig(cfg.configPath, next);
  cfg._persistedConfig = normalizeConfig(serializableConfig(next));
  const hotChanges = {};
  for (const field of HOT_SETTING_FIELDS) {
    if (!cfg._scalarOverrides[field]) hotChanges[field] = next[field];
  }
  registry.updateSettings(hotChanges);
}

function nextProviderConfig(cfg, providers, changes = {}) {
  if (cfg._providerOverrides.length) {
    throw Object.assign(
      new Error(`provider configuration is read-only while runtime overrides are active: ${cfg._providerOverrides.join(', ')}`),
      { statusCode: 409 },
    );
  }
  if (!cfg._persistedConfig) {
    throw Object.assign(
      new Error('provider configuration is read-only until a valid config file is created'),
      { statusCode: 409 },
    );
  }
  const raw = { ...serializableConfig(cfg._persistedConfig), ...changes, providers };
  const next = normalizeConfig(raw);
  next.configPath = cfg.configPath;
  next.mock = cfg.mock;
  return next;
}

function writeJson(res, status, payload, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers });
  res.end(JSON.stringify(payload));
}

function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    const protocol = req.socket.encrypted ? 'https:' : 'http:';
    return parsed.protocol === protocol && parsed.host === req.headers.host;
  } catch {
    return false;
  }
}

async function readJsonBody(req, maxBytes = 1024 * 1024) {
  const body = await readBody(req, maxBytes);
  try {
    const parsed = JSON.parse(body.toString('utf8') || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('request body must be an object');
    return parsed;
  } catch (error) {
    throw Object.assign(new Error(`invalid JSON body: ${error.message}`), { statusCode: 400 });
  }
}

function commitProviderConfig(cfg, registry, next) {
  persistConfig(cfg.configPath, next);
  cfg._persistedConfig = normalizeConfig(serializableConfig(next));
  registry.apply(next);
}

function managementValidation(operation, statusCode = 400) {
  try {
    return operation();
  } catch (error) {
    if (!error.statusCode) error.statusCode = statusCode;
    throw error;
  }
}

function resolveProviderKey(cfg, providerId, keyName) {
  const provider = cfg.providers.find(item => item.id === providerId);
  if (!provider) {
    throw Object.assign(new Error(`provider ${providerId} not found`), { statusCode: 404 });
  }
  const key = provider.keys.find(item => item.name === keyName);
  if (!key) {
    throw Object.assign(new Error(`key ${keyName} not found in provider ${providerId}`), { statusCode: 404 });
  }
  return { provider, key };
}

function commitProviderKeys(cfg, registry, provider, keys, statusCode = 400) {
  const updated = managementValidation(
    () => normalizeProvider({ ...provider, keys }, provider),
    statusCode,
  );
  const providers = cfg.providers.map(item => item.id === provider.id ? updated : item);
  const next = managementValidation(
    () => nextProviderConfig(cfg, providers),
    statusCode,
  );
  commitProviderConfig(cfg, registry, next);
  return publicProviderConfig(cfg);
}

async function testKeyConnection(runtime, key) {
  const started = Date.now();
  if (runtime.settings.mock) {
    return { ok: true, status: 200, latencyMs: 0, key: key.name };
  }
  const url = upstreamRequestUrl(runtime.provider.baseUrl, '/v1/models');
  const mod = url.protocol === 'https:' ? https : http;
  const status = await new Promise((resolve, reject) => {
    const request = mod.request(url, {
      method: 'GET',
      headers: { authorization: `Bearer ${key.key}`, accept: 'application/json' },
      agent: runtime.agent,
    }, response => {
      response.resume();
      response.on('end', () => resolve(response.statusCode || 0));
      response.on('error', reject);
    });
    request.setTimeout(10000, () => request.destroy(new Error('provider test timed out')));
    request.on('error', reject);
    request.end();
  });
  const ok = status >= 200 && status < 400;
  return {
    ok,
    status,
    latencyMs: Date.now() - started,
    key: key.name,
    ...(ok ? {} : { error: { message: `upstream returned HTTP ${status}` } }),
  };
}

async function testProviderConnection(runtime) {
  const key = runtime.pool.pickKey()
    || runtime.pool.keys.find(item => item.enabled)
    || runtime.pool.keys[0];
  if (!key) throw Object.assign(new Error('provider has no available key'), { statusCode: 409 });
  return testKeyConnection(runtime, key);
}

function resolveModelFetchInput(cfg, registry, payload) {
  const providerId = payload.providerId ? normalizeIdentifier(payload.providerId, 'providerId') : '';
  const provider = providerId ? cfg.providers.find(item => item.id === providerId) : null;
  if (providerId && !provider) throw Object.assign(new Error(`provider ${providerId} not found`), { statusCode: 404 });
  const baseUrl = normalizeBaseUrl(payload.baseUrl || provider?.baseUrl, 'baseUrl');
  const runtime = providerId ? registry.get(providerId) : null;
  const keyName = String(payload.keyName || '').trim();
  let secret = typeof payload.key === 'string' ? payload.key.trim() : '';
  if (!secret && runtime) {
    const key = keyName
      ? runtime.pool.keys.find(item => item.name === keyName)
      : runtime.pool.keys.find(item => !item.invalid) || runtime.pool.keys[0];
    if (keyName && !key) throw Object.assign(new Error(`key ${keyName} not found`), { statusCode: 404 });
    secret = key?.key || '';
  }
  const modelsUrl = payload.modelsUrl ? normalizeModelFetchUrl(payload.modelsUrl) : '';
  return { baseUrl, secret, modelsUrl };
}

async function handleManagementApi(cfg, registry, req, res, parsedUrl) {
  const pathname = parsedUrl.pathname;
  const parts = pathname.split('/').filter(Boolean).map(decodeURIComponent);
  if (parts[0] !== 'api') return false;

  if (!['GET', 'HEAD'].includes(req.method) && !sameOrigin(req)) {
    writeJson(res, 403, { error: { message: 'cross-origin management request rejected' } });
    return true;
  }

  if (pathname === '/api/models' && req.method === 'POST') {
    const payload = await readJsonBody(req);
    const input = managementValidation(() => resolveModelFetchInput(cfg, registry, payload));
    const models = await fetchProviderModels(input.baseUrl, input.secret, input.modelsUrl);
    writeJson(res, 200, { models });
    return true;
  }

  if (pathname === '/api/providers' && req.method === 'GET') {
    writeJson(res, 200, publicProviderConfig(cfg));
    return true;
  }
  if (pathname === '/api/settings' && req.method === 'GET') {
    writeJson(res, 200, publicSettings(cfg));
    return true;
  }
  if (pathname === '/api/settings' && req.method === 'PATCH') {
    const payload = await readJsonBody(req);
    const next = managementValidation(() => nextSettingsConfig(cfg, payload));
    commitSettingsConfig(cfg, registry, next);
    writeJson(res, 200, publicSettings(cfg));
    return true;
  }
  if (pathname === '/api/providers' && req.method === 'POST') {
    const payload = await readJsonBody(req);
    const provider = managementValidation(() => normalizeProvider(payload));
    if (cfg.providers.some(item => item.id === provider.id)) throw Object.assign(new Error(`provider ${provider.id} already exists`), { statusCode: 409 });
    const makeDefault = payload.makeDefault === true;
    const changes = makeDefault ? {
      defaultProvider: provider.id,
      defaultModel: String(payload.defaultModel || providerModelAlias(provider.id, provider.models[0].id)),
    } : {};
    const next = managementValidation(() => nextProviderConfig(cfg, [...cfg.providers, provider], changes));
    commitProviderConfig(cfg, registry, next);
    writeJson(res, 201, publicProviderConfig(cfg));
    return true;
  }
  if (pathname === '/api/codex/config' && req.method === 'GET') {
    const gatewayUrl = `${req.socket.encrypted ? 'https' : 'http'}://${req.headers.host}`;
    const artifacts = buildCodexArtifacts(serializableConfig(cfg), { gatewayUrl });
    writeJson(res, 200, artifacts);
    return true;
  }

  if (parts.length === 3 && parts[1] === 'providers') {
    const providerId = parts[2];
    const existing = cfg.providers.find(provider => provider.id === providerId);
    if (!existing) throw Object.assign(new Error(`provider ${providerId} not found`), { statusCode: 404 });
    if (req.method === 'PATCH') {
      const payload = await readJsonBody(req);
      if (payload.id && payload.id !== providerId) throw Object.assign(new Error('provider id cannot be changed'), { statusCode: 400 });
      const provider = managementValidation(() => normalizeProvider({ ...existing, ...payload, id: providerId }, existing));
      const providers = cfg.providers.map(item => item.id === providerId ? provider : item);
      const changes = {};
      if (payload.makeDefault === true) {
        changes.defaultProvider = providerId;
        changes.defaultModel = String(payload.defaultModel || providerModelAlias(providerId, provider.models[0].id));
      } else if (cfg.defaultProvider === providerId) {
        const aliases = new Set(provider.models.map(model => providerModelAlias(providerId, model.id)));
        changes.defaultModel = aliases.has(payload.defaultModel || cfg.defaultModel)
          ? (payload.defaultModel || cfg.defaultModel)
          : providerModelAlias(providerId, provider.models[0].id);
      }
      const next = managementValidation(() => nextProviderConfig(cfg, providers, changes));
      commitProviderConfig(cfg, registry, next);
      writeJson(res, 200, publicProviderConfig(cfg));
      return true;
    }
    if (req.method === 'DELETE') {
      const providers = cfg.providers.filter(provider => provider.id !== providerId);
      const changes = {};
      if (cfg.defaultProvider === providerId) {
        const replacement = providers.find(provider => provider.enabled);
        if (replacement) {
          changes.defaultProvider = replacement.id;
          changes.defaultModel = providerModelAlias(replacement.id, replacement.models[0].id);
        }
      }
      const next = managementValidation(() => nextProviderConfig(cfg, providers, changes), 409);
      commitProviderConfig(cfg, registry, next);
      writeJson(res, 200, publicProviderConfig(cfg));
      return true;
    }
  }

  if (parts.length >= 5 && parts[1] === 'providers' && parts[3] === 'keys') {
    const providerId = parts[2];
    const keyName = parts[4];
    const { provider, key } = resolveProviderKey(cfg, providerId, keyName);

    if (parts.length === 6 && parts[5] === 'test' && req.method === 'POST') {
      const runtime = registry.get(providerId);
      const runtimeKey = runtime?.pool.keys.find(item => item.name === keyName);
      if (!runtime || !runtimeKey) {
        throw Object.assign(new Error(`key ${keyName} is not active in provider ${providerId}`), { statusCode: 409 });
      }
      const result = await testKeyConnection(runtime, runtimeKey);
      writeJson(res, result.ok ? 200 : 502, result);
      return true;
    }

    if (parts.length === 5 && req.method === 'PATCH') {
      const payload = await readJsonBody(req);
      const allowed = new Set(['enabled', 'weight']);
      const unknown = Object.keys(payload).filter(field => !allowed.has(field));
      if (unknown.length) {
        throw Object.assign(new Error(`unknown key settings: ${unknown.join(', ')}`), { statusCode: 400 });
      }
      if (Object.hasOwn(payload, 'enabled') && typeof payload.enabled !== 'boolean') {
        throw Object.assign(new Error('key enabled must be a boolean'), { statusCode: 400 });
      }
      if (Object.hasOwn(payload, 'weight') && typeof payload.weight !== 'number') {
        throw Object.assign(new Error('key weight must be a number'), { statusCode: 400 });
      }
      const updatedKey = {
        ...key,
        ...(Object.hasOwn(payload, 'enabled') ? { enabled: payload.enabled } : {}),
        ...(Object.hasOwn(payload, 'weight') ? { weight: payload.weight } : {}),
      };
      const keys = provider.keys.map(item => item.name === keyName ? updatedKey : item);
      const statusCode = payload.enabled === false ? 409 : 400;
      writeJson(res, 200, commitProviderKeys(cfg, registry, provider, keys, statusCode));
      return true;
    }

    if (parts.length === 5 && req.method === 'DELETE') {
      const keys = provider.keys.filter(item => item.name !== keyName);
      writeJson(res, 200, commitProviderKeys(cfg, registry, provider, keys, 409));
      return true;
    }
  }

  if (parts.length === 4 && parts[1] === 'providers' && parts[3] === 'test' && req.method === 'POST') {
    const runtime = registry.get(parts[2]);
    if (!runtime) throw Object.assign(new Error(`provider ${parts[2]} not found`), { statusCode: 404 });
    const result = await testProviderConnection(runtime);
    writeJson(res, result.ok ? 200 : 502, result);
    return true;
  }

  writeJson(res, 404, { error: { message: 'management endpoint not found' } });
  return true;
}

const UI_CONTENT_TYPES = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
]);

function sendUiFile(res, filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return false;
    const ext = path.extname(filePath).toLowerCase();
    const headers = {
      'content-type': UI_CONTENT_TYPES.get(ext) || 'application/octet-stream',
      'cache-control': ext === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable',
    };
    res.writeHead(200, headers);
    res.end(fs.readFileSync(filePath));
    return true;
  } catch (err) {
    if (err && err.code === 'ENOENT') return false;
    throw err;
  }
}

function sendUiDocument(res, fallbackHtml) {
  if (sendUiFile(res, path.join(UI_DIST_DIR, 'index.html'))) return;
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(fallbackHtml);
}

function maybeSendUiAsset(requestUrl, res) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(requestUrl, 'http://gateway.local').pathname);
  } catch {
    return false;
  }
  if (!pathname.startsWith('/assets/')) return false;
  const assetPath = path.resolve(UI_DIST_DIR, pathname.slice(1));
  const allowedPrefix = `${path.resolve(UI_DIST_DIR)}${path.sep}`;
  if (!assetPath.startsWith(allowedPrefix) || !sendUiFile(res, assetPath)) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
  }
  return true;
}

function dashboardHtml() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>DeepSeek Gateway</title>
<style>
  :root { color-scheme: dark; --bg: #0b1015; --surface: #121a22; --surface-raised: #18232c; --line: #26333d; --line-soft: #1e2a33; --text: #ecf3f7; --muted: #8496a1; --faint: #5d707c; --mint: #65d8ad; --mint-soft: #173b35; --coral: #ff8b82; --coral-soft: #432826; --amber: #e6bd72; --amber-soft: #403321; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; background: var(--bg); color: var(--text); font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  body::before { content: ""; display: block; height: 3px; background: var(--mint); }
  .page-shell { width: min(100% - 40px, 1440px); margin: 0 auto; padding: 34px 0 48px; }
  .topbar { display: flex; align-items: flex-start; justify-content: space-between; gap: 24px; margin-bottom: 30px; }
  .top-actions { display: flex; align-items: center; gap: 10px; }
  .brand { display: flex; align-items: flex-start; gap: 14px; }
  .brand-mark { display: grid; grid-template-columns: repeat(2, 8px); grid-template-rows: repeat(2, 8px); gap: 3px; padding-top: 5px; }
  .brand-mark i { display: block; width: 8px; height: 8px; background: var(--mint); border-radius: 2px; }
  .brand-mark i:nth-child(2), .brand-mark i:nth-child(3) { opacity: .55; }
  .eyebrow, .section-label { color: var(--mint); font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11px; font-weight: 700; letter-spacing: 0; text-transform: uppercase; }
  h1 { margin: 6px 0 7px; color: var(--text); font-size: 34px; line-height: 1.08; letter-spacing: 0; }
  .lede { max-width: 600px; margin: 0; color: var(--muted); font-size: 14px; line-height: 1.55; }
  .top-status { display: flex; align-items: center; gap: 9px; padding: 10px 13px; border: 1px solid var(--line); border-radius: 7px; color: var(--muted); font: 12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; white-space: nowrap; }
  .status-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--mint); box-shadow: 0 0 0 4px rgba(101, 216, 173, .12); }
  .top-status.offline .status-dot { background: var(--coral); box-shadow: 0 0 0 4px rgba(255, 139, 130, .12); }
  .top-status.locked .status-dot { background: var(--amber); box-shadow: 0 0 0 4px rgba(230, 189, 114, .12); }
  .theme-toggle { display: grid; place-items: center; width: 40px; height: 40px; padding: 0; border: 1px solid var(--line); border-radius: 7px; background: var(--surface); color: var(--text); cursor: pointer; font-size: 18px; line-height: 1; transition: background .15s ease, border-color .15s ease, transform .15s ease; }
  .theme-toggle:hover { background: var(--surface-raised); border-color: var(--muted); }
  .theme-toggle:active { transform: translateY(1px); }
  .theme-toggle:focus-visible { outline: 2px solid var(--mint); outline-offset: 3px; }
  .sub { min-height: 18px; margin: 0 0 20px; color: var(--muted); font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  .sub a { color: var(--mint); text-underline-offset: 3px; }
  .cards { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 10px; margin-bottom: 32px; }
  .card { min-height: 116px; position: relative; overflow: hidden; background: var(--surface); border: 1px solid var(--line); border-radius: 8px; padding: 17px 18px 15px; }
  .card::after { content: ""; position: absolute; left: 0; right: 0; bottom: 0; height: 2px; background: var(--line); }
  .card.good::after { background: var(--mint); } .card.warning::after { background: var(--amber); } .card.alert::after { background: var(--coral); }
  .card .k { color: var(--muted); font-size: 11px; font-weight: 700; letter-spacing: 0; text-transform: uppercase; }
  .card .v { margin-top: 16px; color: var(--text); font: 600 30px/1 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; letter-spacing: 0; }
  .card .hint { margin-top: 8px; color: var(--faint); font-size: 11px; }
  .ok { color: var(--mint) !important; } .bad { color: var(--coral) !important; }
  .section-head { display: flex; align-items: flex-end; justify-content: space-between; gap: 20px; margin-bottom: 12px; }
  .section-title { margin: 5px 0 0; color: var(--text); font-size: 17px; font-weight: 650; }
  .section-note { color: var(--muted); font: 12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  .table-wrap { width: 100%; overflow-x: auto; border: 1px solid var(--line); border-radius: 8px; background: var(--surface); }
  table { width: 100%; min-width: 1080px; border-collapse: collapse; }
  th, td { text-align: left; padding: 14px 15px; font-size: 13px; border-bottom: 1px solid var(--line-soft); }
  th { color: var(--muted); background: #10171e; font: 700 10px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; letter-spacing: 0; text-transform: uppercase; white-space: nowrap; }
  tbody tr { transition: background .15s ease; } tbody tr:hover { background: var(--surface-raised); }
  tr:last-child td { border-bottom: none; }
  td:first-child, th:first-child { position: sticky; left: 0; z-index: 1; }
  th:first-child { background: #10171e; } td:first-child { background: var(--surface); }
  tbody tr:hover td:first-child { background: var(--surface-raised); }
  .key-name { color: var(--text); font: 600 13px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  .pill { display: inline-flex; align-items: center; gap: 6px; padding: 5px 9px; border-radius: 999px; font: 700 10px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; letter-spacing: 0; text-transform: uppercase; }
  .pill::before { content: ""; width: 5px; height: 5px; border-radius: 50%; background: currentColor; }
  .healthy { background: var(--mint-soft); color: var(--mint); border: 1px solid #286c5e; }
  .cooldown { background: var(--amber-soft); color: var(--amber); border: 1px solid #795b2e; }
  .invalid { background: var(--coral-soft); color: var(--coral); border: 1px solid #80433e; }
  .balance { min-width: 128px; }
  .balance-line { white-space: nowrap; font: 600 13px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-variant-numeric: tabular-nums; }
  .balance-off { margin-top: 3px; color: var(--coral); font-size: 10px; }
  .dim { color: var(--muted); } .empty-row td { padding: 34px 15px; color: var(--muted); text-align: center; }
  .footer { display: flex; justify-content: space-between; gap: 16px; margin-top: 17px; color: var(--faint); font: 11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  :root[data-theme="light"] { color-scheme: light; --bg: #f3f7f6; --surface: #ffffff; --surface-raised: #edf5f2; --line: #d4e2de; --line-soft: #e5eeeb; --text: #162720; --muted: #60756f; --faint: #8a9c97; --mint: #188668; --mint-soft: #e1f4ec; --coral: #c7524d; --coral-soft: #fdeae8; --amber: #966c1b; --amber-soft: #fff4d9; }
  :root[data-theme="light"] th, :root[data-theme="light"] th:first-child { background: #edf5f2; }
  :root[data-theme="light"] td:first-child { background: var(--surface); }
  :root[data-theme="light"] .top-status, :root[data-theme="light"] .theme-toggle { box-shadow: 0 1px 2px rgba(25, 63, 51, .04); }
  @media (max-width: 980px) { .cards { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
  @media (max-width: 640px) { .page-shell { width: min(100% - 28px, 1440px); padding-top: 25px; } .topbar { display: block; margin-bottom: 24px; } h1 { font-size: 27px; } .top-actions { margin-top: 18px; } .top-status { flex: 1; } .cards { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; margin-bottom: 26px; } .card { min-height: 104px; padding: 14px; } .card .v { margin-top: 13px; font-size: 25px; } .section-head { display: block; } .section-note { display: block; margin-top: 8px; } th, td { padding: 12px; } .footer { display: block; line-height: 1.7; } }
</style>
</head>
<body>
<main class="page-shell">
  <header class="topbar">
    <div class="brand">
      <span class="brand-mark" aria-hidden="true"><i></i><i></i><i></i><i></i></span>
      <div><div class="eyebrow">Operations / Gateway</div><h1>DeepSeek Multi-Key Gateway</h1><p class="lede">Runtime telemetry / Key pool</p></div>
    </div>
    <div class="top-actions">
      <button type="button" class="theme-toggle" id="theme-toggle" aria-label="切换到浅色模式" title="切换到浅色模式" aria-pressed="false"><span id="theme-icon" aria-hidden="true">☼</span></button>
      <div class="top-status" id="connection-state"><span class="status-dot" aria-hidden="true"></span><span>CONNECTING</span></div>
    </div>
  </header>
  <div class="sub" id="meta" aria-live="polite">正在连接 gateway…</div>
  <section class="cards" aria-label="Gateway totals">
    <div class="card"><div class="k">Requests</div><div class="v" id="c-req">-</div><div class="hint">LIFETIME</div></div>
    <div class="card good"><div class="k">Success</div><div class="v ok" id="c-ok">-</div><div class="hint">LIFETIME</div></div>
    <div class="card alert"><div class="k">Errors</div><div class="v bad" id="c-err">-</div><div class="hint">LIFETIME</div></div>
    <div class="card warning"><div class="k">Rate limited</div><div class="v" id="c-rl">-</div><div class="hint">HTTP 429</div></div>
    <div class="card"><div class="k">Tokens</div><div class="v" id="c-tok">-</div><div class="hint">LIFETIME</div></div>
  </section>
  <section aria-labelledby="keys-heading">
    <div class="section-head"><div><div class="section-label">Key pool</div><h2 class="section-title" id="keys-heading">Connection health</h2></div><div class="section-note" id="key-count">Waiting for key data</div></div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Key</th><th>State</th><th>Balance</th><th>In-flight</th><th>Requests</th><th>Success</th><th>Errors</th><th>429s</th><th>Failures</th><th>Cooldown</th><th>Last used</th></tr></thead>
        <tbody id="rows"><tr class="empty-row"><td colspan="11">Loading key telemetry…</td></tr></tbody>
      </table>
    </div>
  </section>
  <footer class="footer"><span>Auto-refresh every 2 seconds</span><span>DeepSeek Gateway</span></footer>
</main>
<script>
function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
const THEME_KEY = 'deepseek-gateway-theme';
function applyTheme(theme) {
  const isLight = theme === 'light';
  document.documentElement.dataset.theme = isLight ? 'light' : 'dark';
  const toggle = document.getElementById('theme-toggle');
  const icon = document.getElementById('theme-icon');
  toggle.setAttribute('aria-pressed', String(isLight));
  toggle.setAttribute('aria-label', isLight ? '切换到深色模式' : '切换到浅色模式');
  toggle.title = isLight ? '切换到深色模式' : '切换到浅色模式';
  icon.textContent = isLight ? '☾' : '☼';
}
function initTheme() {
  let saved = '';
  try { saved = localStorage.getItem(THEME_KEY) || ''; } catch (_) {}
  applyTheme(saved === 'light' ? 'light' : 'dark');
  document.getElementById('theme-toggle').addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
    applyTheme(next);
    try { localStorage.setItem(THEME_KEY, next); } catch (_) {}
  });
}
function balanceCell(k) {
  if (!k.balance || !k.balance.infos.length) {
    const title = k.balanceError || 'balance pending';
    return '<td class="balance dim" title="' + esc(title) + '">—</td>';
  }
  const detail = k.balance.infos.map(info =>
    info.currency + ': total ' + info.totalBalance + ', granted ' + info.grantedBalance + ', topped up ' + info.toppedUpBalance
  ).join('\\n') + (k.balanceUpdatedAt ? '\\nupdated ' + new Date(k.balanceUpdatedAt).toLocaleString() : '');
  const lines = k.balance.infos.map(info =>
    '<div class="balance-line"><span class="dim">' + esc(info.currency) + '</span> ' + esc(info.totalBalance) + '</div>'
  ).join('');
  const unavailable = k.balance.isAvailable ? '' : '<div class="balance-off">unavailable</div>';
  return '<td class="balance" title="' + esc(detail) + '">' + lines + unavailable + '</td>';
}
function setConnectionState(label, state) {
  const el = document.getElementById('connection-state');
  el.className = 'top-status' + (state ? ' ' + state : '');
  el.lastElementChild.textContent = label;
}
function renderLogin() {
  setConnectionState('AUTH REQUIRED', 'locked');
  document.getElementById('meta').innerHTML = '未登录 · <a href="/login">登录</a> 后查看面板';
  document.getElementById('key-count').textContent = 'Authentication required';
  document.getElementById('rows').innerHTML = '<tr class="empty-row"><td colspan="11">登录后查看密钥运行状态</td></tr>';
  for (const id of ['c-req', 'c-ok', 'c-err', 'c-rl', 'c-tok']) document.getElementById(id).textContent = '—';
}
async function tick() {
  try {
    const res = await fetch('/health');
    if (res.status === 401) { renderLogin(); return; }
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const h = await res.json();
    setConnectionState('LIVE MONITORING', '');
    document.getElementById('meta').textContent =
      'upstream ' + h.upstream + ' · port ' + h.port + ' · uptime ' + h.uptime + 's · gateway v' + h.version + ' · refreshed ' + new Date().toLocaleTimeString();
    document.getElementById('c-req').textContent = h.total.requests;
    document.getElementById('c-ok').textContent = h.total.success;
    document.getElementById('c-err').textContent = h.total.errors;
    document.getElementById('c-rl').textContent = h.total.ratelimited;
    document.getElementById('c-tok').textContent = h.total.tokens;
    document.getElementById('key-count').textContent = h.keys.length + (h.keys.length === 1 ? ' key' : ' keys') + ' · synced just now';
    const rows = document.getElementById('rows');
    rows.innerHTML = '';
    for (const k of h.keys) {
      const tr = document.createElement('tr');
      tr.innerHTML = '<td><span class="key-name">' + esc(k.name) + '</span></td>' +
        '<td><span class="pill ' + esc(k.state) + '">' + esc(k.state) + '</span>' +
        (k.invalid ? ' <span class="dim">' + esc(k.lastError || '') + '</span>' : '') + '</td>' +
        balanceCell(k) +
        '<td>' + k.inFlight + '</td>' +
        '<td>' + k.total + '</td>' +
        '<td class="ok">' + k.success + '</td>' +
        '<td class="bad">' + k.errors + '</td>' +
        '<td>' + k.ratelimited + '</td>' +
        '<td>' + k.failureCount + '</td>' +
        '<td>' + (k.cooldownSec ? k.cooldownSec + 's' : '—') + '</td>' +
        '<td class="dim">' + (k.lastUsed ? new Date(k.lastUsed).toLocaleTimeString() : '—') + '</td>';
      rows.appendChild(tr);
    }
    if (!h.keys.length) rows.innerHTML = '<tr class="empty-row"><td colspan="11">No keys configured</td></tr>';
  } catch (e) {
    setConnectionState('OFFLINE', 'offline');
    document.getElementById('meta').textContent = 'gateway unreachable: ' + e;
  }
}
initTheme();
tick();
setInterval(tick, 2000);
</script>
</body>
</html>`;
}

const LOGIN_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Gateway Login</title>
<style>
  :root { color-scheme: dark; --bg: #0b1015; --surface: #121a22; --line: #26333d; --text: #ecf3f7; --muted: #8496a1; --mint: #65d8ad; --coral: #ff8b82; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; background: var(--bg); color: var(--text); font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  body::before { content: ""; display: block; height: 3px; background: var(--mint); }
  .login-wrap { display: flex; align-items: center; justify-content: center; min-height: calc(100vh - 3px); padding: 24px; }
  form { width: min(100%, 390px); padding: 30px; background: var(--surface); border: 1px solid var(--line); border-radius: 8px; }
  .brand-line { display: flex; align-items: center; gap: 11px; margin-bottom: 28px; color: var(--muted); font: 11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  .brand-mark { display: grid; grid-template-columns: repeat(2, 7px); grid-template-rows: repeat(2, 7px); gap: 3px; }
  .brand-mark i { display: block; width: 7px; height: 7px; background: var(--mint); border-radius: 2px; }
  .brand-mark i:nth-child(2), .brand-mark i:nth-child(3) { opacity: .55; }
  .eyebrow { color: var(--mint); font: 700 10px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; text-transform: uppercase; }
  h1 { margin: 0 0 8px; font-size: 24px; line-height: 1.15; }
  .sub { margin: 0 0 25px; color: var(--muted); font-size: 13px; line-height: 1.5; }
  .field-label { display: block; margin-bottom: 8px; color: var(--muted); font: 700 11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; text-transform: uppercase; }
  input { width: 100%; padding: 12px 13px; margin-bottom: 16px; background: var(--bg); border: 1px solid var(--line); border-radius: 6px; color: var(--text); font: 14px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; outline: none; }
  input:focus { border-color: var(--mint); box-shadow: 0 0 0 3px rgba(101, 216, 173, .12); }
  button { width: 100%; padding: 12px 14px; background: var(--mint); border: 1px solid var(--mint); border-radius: 6px; color: #10241e; font-size: 14px; font-weight: 750; cursor: pointer; transition: background .15s ease, transform .15s ease; }
  button:hover { background: #8ce6c5; } button:active { transform: translateY(1px); }
  .err { color: var(--coral); font-size: 12px; margin-top: 12px; min-height: 16px; }
  @media (max-width: 480px) { .login-wrap { padding: 14px; } form { padding: 24px; } }
</style>
</head>
<body>
<main class="login-wrap">
  <form method="post" action="/login">
    <div class="brand-line"><span class="brand-mark" aria-hidden="true"><i></i><i></i><i></i><i></i></span><span>DEEPSEEK GATEWAY</span></div>
    <div class="eyebrow">Private console</div>
    <h1>登录控制台</h1>
    <p class="sub">使用 gateway token 继续。</p>
    <label class="field-label" for="gateway-token">Gateway token</label>
    <input id="gateway-token" type="password" name="token" placeholder="输入 token" autofocus autocomplete="current-password" aria-describedby="err">
    <button type="submit">登录</button>
    <div class="err" id="err" aria-live="polite"></div>
  </form>
</main>
<script>
document.querySelector('form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const res = await fetch('/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: document.querySelector('input').value }),
  });
  if (res.ok) { location.href = '/'; }
  else { document.getElementById('err').textContent = 'token 不正确'; }
});
</script>
</body>
</html>`;

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (maxBytes && size > maxBytes) {
        req.pause();
        reject(Object.assign(new Error('request body too large'), { statusCode: 413 }));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function handleLogin(cfg, req, res) {
  const body = await readBody(req, 4096);
  let token = '';
  const ct = req.headers['content-type'] || '';
  if (ct.includes('application/json')) {
    try { token = (JSON.parse(body.toString('utf8')).token || ''); } catch {}
  } else {
    token = new URLSearchParams(body.toString('utf8')).get('token') || '';
  }
  if (!cfg.token || !secureEqual(token, cfg.token)) {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'invalid token' } }));
    return;
  }
  res.setHeader('set-cookie', `${COOKIE_NAME}=${sessionCookie(cfg.token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`);
  res.writeHead(302, { location: '/' });
  res.end();
}

async function handleRequest(cfg, registry, req, res, log, startedAt) {
  const requestUrl = req.url || '/';
  if (maybeSendUiAsset(requestUrl, res)) return;
  const parsedUrl = new URL(requestUrl, 'http://gateway.local');
  const url = parsedUrl.pathname;
  const bearerOk = cfg.token ? secureEqual(req.headers.authorization || '', `Bearer ${cfg.token}`) : true;
  const sessionOk = cfg.token ? cookieValid(parseCookies(req)[COOKIE_NAME], cfg.token) : false;
  if (url === '/login') {
    if (req.method === 'POST') return handleLogin(cfg, req, res);
    sendUiDocument(res, LOGIN_HTML);
    return;
  }
  if (url === '/logout') {
    res.setHeader('set-cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
    res.writeHead(302, { location: '/' });
    res.end();
    return;
  }
  if (url === '/favicon.ico') {
    res.writeHead(204);
    res.end();
    return;
  }
  const isBrowserPath = url === '/' || url === '/health' || url.startsWith('/api/');
  if (cfg.token && !bearerOk && !(isBrowserPath && sessionOk)) {
    if (url === '/' && req.method === 'GET') {
      sendUiDocument(res, dashboardHtml());
      return;
    }
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'invalid gateway token' } }));
    return;
  }
  if (url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(buildHealth(cfg, registry, Date.now() - startedAt)));
    return;
  }
  if (url.startsWith('/api/')) {
    await handleManagementApi(cfg, registry, req, res, parsedUrl);
    return;
  }
  if (url === '/') {
    sendUiDocument(res, dashboardHtml());
    return;
  }
  const body = await readBody(req, cfg.maxBodyBytes);
  const route = resolveRequestRoute(registry, body);
  await relay(route, req, res, log);
}

function makeLog(quiet) {
  return quiet ? () => {} : msg => console.log(`[${new Date().toLocaleTimeString()}] ${msg}`);
}

function shutdown(server, registry) {
  registry.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(USAGE);
    process.exit(0);
  }
  let cfg;
  try {
    cfg = loadConfig(opts);
  } catch (error) {
    console.error(`ERROR: ${error.message}`);
    process.exit(1);
  }
  const log = makeLog(cfg.quiet);
  const registry = new ProviderRegistry(cfg, log);
  const startedAt = Date.now();
  const server = http.createServer((req, res) => {
    handleRequest(cfg, registry, req, res, log, startedAt).catch(err => {
      const code = err.statusCode || 500;
      log(`${code} ${req.method} ${req.url} ${err.message}`);
      if (!res.headersSent) res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: err.message } }));
    });
  });
  server.once('error', error => {
    registry.close();
    if (error.code === 'EADDRINUSE') {
      console.error(
        `ERROR: Cannot listen on http://${cfg.host}:${cfg.port}: address already in use. ` +
        'Stop the existing gateway or choose another port with --port <port>.',
      );
    } else {
      console.error(`ERROR: Cannot start gateway on ${cfg.host}:${cfg.port}: ${error.message}`);
    }
    process.exitCode = 1;
  });
  server.listen(cfg.port, cfg.host, () => {
    registry.activate();
    const addr = server.address();
    cfg.port = addr.port;
    log(`deepseek-gateway v${VERSION} listening on http://${addr.address}:${addr.port}${cfg.mock ? ' [mock]' : ''}`);
    log(`providers: ${cfg.providers.filter(provider => provider.enabled).map(provider => `${provider.id}(${provider.keys.length} keys)`).join(', ')}`);
    log(`dashboard: http://${addr.address}:${addr.port}/`);
  });
  process.on('SIGINT', () => shutdown(server, registry));
  process.on('SIGTERM', () => shutdown(server, registry));
}

main();
