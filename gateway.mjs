#!/usr/bin/env node
'use strict';

import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import { URL, fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { decodeRequestBody, requestContentEncoding } from './content-encoding.mjs';
import { assertSupportedNodeVersion, MINIMUM_NODE_VERSION } from './node-version.mjs';
import {
  claimGatewayRuntime,
  releaseGatewayRuntime,
  updateGatewayRuntime,
} from './gateway-runtime.mjs';
import {
  effectiveBalanceQuery,
  executeBalanceQuery,
} from './balance-script.mjs';
import {
  mockBalanceResponse,
  ProviderRegistry,
  refreshKeyBalance,
} from './provider-runtime.mjs';
import { buildCodexArtifacts } from './codex-config.mjs';
import { prepareKeyImport } from './key-import.mjs';
import { createManagementApi } from './management-api.mjs';
import { createOperationsStore } from './management/operations-store.mjs';
import { createLoginAttemptLimiter } from './login-attempt-limiter.mjs';
import {
  gatewayUsage,
  loadGatewayConfig,
  parseGatewayArgs,
} from './gateway-config.mjs';
import { modelCapabilityCatalog } from './model-capabilities.mjs';
import {
  fetchProviderModels,
  normalizeModelFetchUrl,
  relay,
  resolveRequestRoute,
  upstreamRequestUrl,
} from './upstream-relay.mjs';
import { createCodexAgentProjector } from './codex-agent-config.mjs';
import {
  normalizeBaseUrl,
  normalizeBalanceQuery,
  normalizeConfig,
  normalizeIdentifier,
  normalizeProvider,
  persistConfig,
  providerModelAlias,
  serializableConfig,
} from './config-core.mjs';

const VERSION = '2.0.0';
const PROJECT_DIR = path.dirname(fileURLToPath(import.meta.url));
const UI_DIST_DIR = path.join(PROJECT_DIR, 'ui', 'dist');
const SESSION_SECRET = crypto.randomBytes(32).toString('hex');
const COOKIE_NAME = 'dsgw';
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

function requireSupportedNodeVersion() {
  try {
    assertSupportedNodeVersion();
  } catch {
    console.error(
      `ERROR: deepseek-gateway requires Node.js ${MINIMUM_NODE_VERSION} or newer; found ${process.versions.node}`,
    );
    process.exit(1);
  }
  if (typeof zlib.zstdDecompress !== 'function') {
    console.error('ERROR: this Node.js build does not provide native zstd decompression');
    process.exit(1);
  }
}

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

function setSessionCookie(res, token, secure = false) {
  res.setHeader(
    'set-cookie',
    `${COOKIE_NAME}=${sessionCookie(token)}; Path=/; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
  );
}

function clearSessionCookie(res) {
  res.setHeader('set-cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
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

function emptyTotals() {
  return { requests: 0, success: 0, errors: 0, ratelimited: 0, tokens: 0 };
}

function addTotals(target, source) {
  for (const key of Object.keys(target)) target[key] += source[key] || 0;
  return target;
}

function buildHealth(cfg, registry, uptime, instanceId) {
  const total = emptyTotals();
  const providers = cfg.providers.map(provider => {
    const runtime = registry.get(provider.id);
    const stats = runtime ? runtime.pool.stats() : { total: emptyTotals(), keys: [] };
    addTotals(total, stats.total);
    return {
      id: provider.id,
      name: provider.name,
      baseUrl: cfg.mock ? 'mock' : provider.baseUrl,
      upstreamFormat: provider.upstreamFormat,
      enabled: provider.enabled,
      balanceQueryEnabled: Boolean(effectiveBalanceQuery(provider)),
      modelCount: provider.models.length,
      total: stats.total,
      keys: stats.keys,
    };
  });
  const defaultRuntime = registry.getDefault();
  const defaultStats = defaultRuntime ? defaultRuntime.pool.stats() : { keys: [] };
  return {
    status: 'ok',
    instanceId,
    setupRequired: cfg.setupPending === true,
    version: VERSION,
    mock: cfg.mock,
    upstream: cfg.mock ? 'mock' : (defaultRuntime?.provider.baseUrl || null),
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
    alwaysTry: key.alwaysTry === true,
    maskedKey: `****${suffix}`,
    fingerprint,
  };
}

function publicProvider(provider) {
  const balanceQuery = provider.balanceQuery || effectiveBalanceQuery(provider);
  return {
    id: provider.id,
    name: provider.name,
    baseUrl: provider.baseUrl,
    upstreamFormat: provider.upstreamFormat,
    apiProfile: provider.apiProfile,
    supportsEncryptedAgentMessages: provider.supportsEncryptedAgentMessages === true,
    supportsPromptCacheKey: provider.supportsPromptCacheKey === true,
    keyRouting: provider.keyRouting,
    enabled: provider.enabled,
    models: provider.models.map(model => ({
      ...model,
      alias: providerModelAlias(provider.id, model.id),
    })),
    keys: provider.keys.map(maskedKey),
    balanceQuery: balanceQuery ? { ...balanceQuery } : null,
  };
}

function publicProviderConfig(cfg) {
  return {
    schemaVersion: 2,
    revision: cfg._managementRevision || 1,
    setupPending: cfg.setupPending === true,
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
  'adminToken',
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
    adminTokenConfigured: Boolean(config.adminToken),
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
  const allowed = new Set([...SETTING_FIELDS, 'clearToken', 'clearAdminToken']);
  const unknown = Object.keys(payload).filter(field => !allowed.has(field));
  if (unknown.length) throw new Error(`unknown settings: ${unknown.join(', ')}`);
  if (Object.hasOwn(payload, 'clearToken') && typeof payload.clearToken !== 'boolean') {
    throw new Error('clearToken must be a boolean');
  }
  if (payload.clearToken && Object.hasOwn(payload, 'token')) {
    throw new Error('token and clearToken cannot be used together');
  }
  if (payload.clearAdminToken && Object.hasOwn(payload, 'adminToken')) {
    throw new Error('adminToken and clearAdminToken cannot be used together');
  }

  const changes = {};
  for (const field of SETTING_FIELDS) {
    if (!Object.hasOwn(payload, field)) continue;
    if (field === 'host') {
      if (typeof payload.host !== 'string' || !payload.host.trim() || payload.host.length > 255) {
        throw new Error('host must be a non-empty string of at most 255 characters');
      }
      changes.host = payload.host.trim();
    } else if (field === 'token' || field === 'adminToken') {
      if (typeof payload[field] !== 'string') throw new Error(`${field} must be a string`);
      changes[field] = payload[field];
    } else {
      if (typeof payload[field] !== 'number') throw new Error(`${field} must be a number`);
      changes[field] = payload[field];
    }
  }
  if (payload.clearToken) changes.token = '';
  if (payload.clearAdminToken) changes.adminToken = '';
  return normalizeConfig(
    { ...serializableConfig(cfg._persistedConfig), ...changes },
    { allowSetup: true },
  );
}

function commitSettingsConfig(cfg, registry, next) {
  const hotChanges = {};
  const rollbackChanges = {};
  for (const field of HOT_SETTING_FIELDS) {
    if (!cfg._scalarOverrides[field]) {
      hotChanges[field] = next[field];
      rollbackChanges[field] = cfg[field];
    }
  }
  registry.updateSettings(hotChanges);
  try {
    persistConfig(cfg.configPath, next);
  } catch (error) {
    registry.updateSettings(rollbackChanges);
    throw error;
  }
  cfg._persistedConfig = normalizeConfig(serializableConfig(next), { allowSetup: true });
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
  if (!origin) {
    return !parseCookies(req)[COOKIE_NAME];
  }
  try {
    const parsed = new URL(origin);
    const protocol = requestProtocol(req);
    return parsed.protocol === protocol && parsed.host === req.headers.host;
  } catch {
    return false;
  }
}

function loopbackManagementHost(req) {
  try {
    const hostname = new URL(`http://${req.headers.host || ''}`).hostname
      .replace(/^\[|\]$/g, '')
      .toLowerCase();
    return hostname === 'localhost'
      || hostname === '::1'
      || hostname === '0:0:0:0:0:0:0:1'
      || /^127(?:\.\d{1,3}){3}$/.test(hostname)
      || /^::ffff:127(?:\.\d{1,3}){3}$/.test(hostname);
  } catch {
    return false;
  }
}

function requestProtocol(req) {
  if (req.socket.encrypted) return 'https:';
  const remoteAddress = String(req.socket.remoteAddress || '');
  const fromLoopback = remoteAddress === '::1'
    || remoteAddress === '127.0.0.1'
    || remoteAddress.startsWith('::ffff:127.');
  if (fromLoopback) {
    const forwarded = String(req.headers['x-forwarded-proto'] || '')
      .split(',', 1)[0]
      .trim()
      .toLowerCase();
    if (forwarded === 'https') return 'https:';
    if (forwarded === 'http') return 'http:';
  }
  return 'http:';
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
  const previous = normalizeConfig(serializableConfig(cfg), { allowSetup: true });
  try {
    createCodexAgentProjector().reconcile(next, activeOperations?.listSubagents() || []);
    registry.apply(next);
    persistConfig(cfg.configPath, next);
  } catch (error) {
    try {
      createCodexAgentProjector().reconcile(
        previous,
        activeOperations?.listSubagents() || [],
        { force: true },
      );
    } catch {}
    registry.apply(previous);
    throw error;
  }
  cfg._persistedConfig = normalizeConfig(serializableConfig(next), { allowSetup: true });
  cfg._managementRevision = (cfg._managementRevision || 1) + 1;
}

function restoreOperationsConfig(cfg, registry, raw) {
  const next = managementValidation(
    () => normalizeConfig({ ...raw, configPath: cfg.configPath, mock: cfg.mock }, { allowSetup: true }),
    400,
  );
  const previous = normalizeConfig(serializableConfig(cfg), { allowSetup: true });
  const hotChanges = {};
  const rollbackChanges = {};
  for (const field of HOT_SETTING_FIELDS) {
    if (!cfg._scalarOverrides[field]) {
      hotChanges[field] = next[field];
      rollbackChanges[field] = cfg[field];
    }
  }
  try {
    createCodexAgentProjector().reconcile(next, activeOperations?.listSubagents() || []);
    registry.apply(next);
    registry.updateSettings(hotChanges);
    persistConfig(cfg.configPath, next);
  } catch (error) {
    try {
      createCodexAgentProjector().reconcile(
        previous,
        activeOperations?.listSubagents() || [],
        { force: true },
      );
    } catch {}
    registry.apply(previous);
    registry.updateSettings(rollbackChanges);
    throw error;
  }
  cfg._persistedConfig = normalizeConfig(serializableConfig(next), { allowSetup: true });
  cfg._managementRevision = (cfg._managementRevision || 1) + 1;
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
  const selection = runtime.pool.pickKey();
  const key = selection?.key
    || runtime.pool.keys.find(item => item.enabled)
    || runtime.pool.keys[0];
  if (!key) throw Object.assign(new Error('provider has no available key'), { statusCode: 409 });
  try {
    return await testKeyConnection(runtime, key);
  } finally {
    // This path does not record routing health. Release only the reservation
    // acquired by this call, and wait a full interval before another probe.
    runtime.pool.releaseProbeReservation(
      key,
      selection?.probeReservation,
      { restartWindow: true },
    );
  }
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
    const configuredOrigin = new URL(runtime.provider.baseUrl).origin;
    const requestedOrigins = [new URL(baseUrl).origin];
    if (payload.modelsUrl) requestedOrigins.push(new URL(normalizeModelFetchUrl(payload.modelsUrl)).origin);
    if (requestedOrigins.some(origin => origin !== configuredOrigin)) {
      throw new Error('an explicit API key is required when fetching models from a different origin');
    }
    const key = keyName
      ? runtime.pool.keys.find(item => item.name === keyName)
      : runtime.pool.keys.find(item => !item.invalid) || runtime.pool.keys[0];
    if (keyName && !key) throw Object.assign(new Error(`key ${keyName} not found`), { statusCode: 404 });
    secret = key?.key || '';
  }
  const modelsUrl = payload.modelsUrl ? normalizeModelFetchUrl(payload.modelsUrl) : '';
  return { baseUrl, secret, modelsUrl };
}

function resolveBalanceTestInput(cfg, registry, payload) {
  const providerId = payload.providerId ? normalizeIdentifier(payload.providerId, 'providerId') : '';
  const runtime = providerId ? registry.get(providerId) : null;
  if (providerId && !runtime) {
    throw Object.assign(new Error(`provider ${providerId} not found`), { statusCode: 404 });
  }
  const baseUrl = normalizeBaseUrl(payload.baseUrl || runtime?.provider.baseUrl, 'baseUrl');
  const query = normalizeBalanceQuery(payload.balanceQuery, null, 'balanceQuery');
  if (!query?.enabled) throw new Error('balanceQuery must be enabled for testing');
  const keyName = String(payload.keyName || runtime?.pool.keys[0]?.name || 'test').trim();
  let secret = typeof payload.key === 'string' ? payload.key.trim() : '';
  if (!secret && runtime) {
    if (new URL(baseUrl).origin !== new URL(runtime.provider.baseUrl).origin) {
      throw new Error('an explicit API key is required when testing balance on a different origin');
    }
    const runtimeKey = runtime.pool.keys.find(item => item.name === keyName);
    if (!runtimeKey) throw Object.assign(new Error(`key ${keyName} not found`), { statusCode: 404 });
    secret = runtimeKey.key;
  }
  if (!secret) throw new Error('an API key is required to test balanceQuery');
  const provider = {
    id: providerId || 'balance-test',
    baseUrl,
    balanceQuery: query,
  };
  return { provider, query, key: { name: keyName || 'test', key: secret }, runtime };
}

async function testBalanceQuery(cfg, input) {
  const reusableAgent = input.runtime?.provider.baseUrl === input.provider.baseUrl
    ? input.runtime.agent
    : null;
  let agent = reusableAgent;
  if (!cfg.mock && !agent) {
    const Agent = new URL(input.provider.baseUrl).protocol === 'https:' ? https.Agent : http.Agent;
    agent = new Agent({ keepAlive: false, maxSockets: 1 });
  }
  try {
    return await executeBalanceQuery({
      query: input.query,
      provider: input.provider,
      key: input.key,
      agent,
      ...(cfg.mock ? { mockResponse: mockBalanceResponse() } : {}),
    });
  } finally {
    if (agent && agent !== reusableAgent) agent.destroy();
  }
}

let activeOperations = null;
let activeShutdown = null;

const handleManagementApi = createManagementApi({
  buildCodexArtifacts,
  clearSessionCookie,
  commitProviderConfig,
  commitProviderKeys,
  commitSettingsConfig,
  effectiveBalanceQuery,
  fetchProviderModels,
  managementValidation,
  modelCapabilityCatalog,
  nextProviderConfig,
  nextSettingsConfig,
  normalizeProvider,
  prepareKeyImport,
  providerModelAlias,
  publicProviderConfig,
  publicSettings,
  readJsonBody,
  refreshKeyBalance,
  resolveBalanceTestInput,
  resolveModelFetchInput,
  resolveProviderKey,
  sameOrigin,
  serializableConfig,
  setSessionCookie,
  testBalanceQuery,
  testKeyConnection,
  testProviderConnection,
  writeJson,
  operations: () => activeOperations,
  codexAgentProjector: createCodexAgentProjector(),
  restoreConfig: restoreOperationsConfig,
  stopGateway: () => activeShutdown?.(),
});

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
  .invalid, .unhealthy { background: var(--coral-soft); color: var(--coral); border: 1px solid #80433e; }
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
      tr.innerHTML = '<td><span class="key-name">' + esc(k.name) + '</span>' +
        (k.alwaysTry ? ' <span class="dim">alwaysTry</span>' : '') + '</td>' +
        '<td><span class="pill ' + esc(k.state) + '">' + esc(k.state) + '</span>' +
        (k.invalid || k.unhealthy ? ' <span class="dim">' + esc(k.lastError || '') + '</span>' : '') + '</td>' +
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
    <p class="sub">使用独立的 admin token 继续。</p>
    <label class="field-label" for="gateway-token">Admin token</label>
    <input id="gateway-token" type="password" name="token" placeholder="输入 admin token" autofocus autocomplete="current-password" aria-describedby="err">
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

async function handleLogin(cfg, req, res, loginLimiter) {
  const source = req.socket?.remoteAddress || 'unknown';
  const limit = loginLimiter?.check(source);
  if (limit?.blocked) {
    activeOperations?.addLog({ level: 'audit', message: 'admin login rate limited', method: 'POST', route: '/login', status: 429 });
    res.writeHead(429, {
      'content-type': 'application/json',
      'retry-after': String(limit.retryAfterSeconds),
    });
    res.end(JSON.stringify({ error: { message: 'too many login attempts' } }));
    return;
  }
  const body = await readBody(req, 4096);
  let token = '';
  const ct = req.headers['content-type'] || '';
  if (ct.includes('application/json')) {
    try { token = (JSON.parse(body.toString('utf8')).token || ''); } catch {}
  } else {
    token = new URLSearchParams(body.toString('utf8')).get('token') || '';
  }
  if (!cfg.adminToken || !secureEqual(token, cfg.adminToken)) {
    loginLimiter?.recordFailure(source);
    activeOperations?.addLog({ level: 'audit', message: 'admin login failed', method: 'POST', route: '/login', status: 401 });
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'invalid token' } }));
    return;
  }
  loginLimiter?.recordSuccess(source);
  activeOperations?.addLog({ level: 'audit', message: 'admin login succeeded', method: 'POST', route: '/login', status: 302 });
  setSessionCookie(res, cfg.adminToken, requestProtocol(req) === 'https:');
  res.writeHead(302, { location: '/' });
  res.end();
}

async function handleRequest(cfg, registry, req, res, log, startedAt, instanceId, loginLimiter) {
  const requestUrl = req.url || '/';
  if (maybeSendUiAsset(requestUrl, res)) return;
  const parsedUrl = new URL(requestUrl, 'http://gateway.local');
  const url = parsedUrl.pathname;
  const bearerOk = cfg.token ? secureEqual(req.headers.authorization || '', `Bearer ${cfg.token}`) : true;
  const adminBearerOk = cfg.adminToken
    ? secureEqual(req.headers.authorization || '', `Bearer ${cfg.adminToken}`)
    : !cfg.token;
  const sessionOk = cfg.adminToken
    ? cookieValid(parseCookies(req)[COOKIE_NAME], cfg.adminToken)
    : false;
  if (url === '/login') {
    if (req.method === 'POST') {
      if (!sameOrigin(req)) {
        writeJson(res, 403, { error: { message: 'cross-origin login request rejected' } });
        return;
      }
      return handleLogin(cfg, req, res, loginLimiter);
    }
    sendUiDocument(res, LOGIN_HTML);
    return;
  }
  if (url === '/logout') {
    clearSessionCookie(res);
    res.writeHead(302, { location: '/' });
    res.end();
    return;
  }
  if (url === '/favicon.ico') {
    res.writeHead(204);
    res.end();
    return;
  }
  const isManagementPath = url === '/' || url.startsWith('/api/');
  if (isManagementPath && !cfg.adminToken && !loopbackManagementHost(req)) {
    res.writeHead(403, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'untrusted management host' } }));
    return;
  }
  const authorized = isManagementPath
    ? adminBearerOk || sessionOk
    : url === '/health'
      ? bearerOk || adminBearerOk || sessionOk
      : bearerOk;
  if (!authorized) {
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
    res.end(JSON.stringify(buildHealth(cfg, registry, Date.now() - startedAt, instanceId)));
    return;
  }
  if (url === '/v1/models' && ['GET', 'HEAD'].includes(req.method)) {
    const created = Math.floor(Date.now() / 1000);
    const data = registry.listAliases().map(item => ({
      id: item.alias,
      object: 'model',
      created,
      owned_by: item.providerId,
      input_modalities: item.model.inputModalities,
    }));
    writeJson(res, 200, { object: 'list', data });
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
  const wireBody = await readBody(req, cfg.maxBodyBytes);
  const decoded = await decodeRequestBody(
    wireBody,
    requestContentEncoding(req),
    cfg.maxBodyBytes,
  );
  const route = resolveRequestRoute(registry, decoded.body, req.url);
  route.decodedRequestBody = decoded.decoded;
  await relay(route, req, res, log);
}

function makeLog(quiet, operations) {
  return (msg, context = null) => {
    if (!quiet) console.log(`[${new Date().toLocaleTimeString()}] ${msg}`);
    const level = /^\d{3}\s/.test(String(msg)) && Number(String(msg).slice(0, 3)) >= 500
      ? 'error'
      : 'info';
    operations?.addLog({ message: msg, level, ...(context || {}) });
    if (context?.status) {
      operations?.recordUsage(context);
      return;
    }
    const match = /^(\d{3}) .*?provider=([^\s]+)(?: model=([^\s]+))?/.exec(String(msg));
    if (match) operations?.recordUsage({ status: Number(match[1]), provider: match[2], model: match[3] });
  };
}

let shutdownStarted = false;
async function shutdown(server, registry, runtimeHandle) {
  if (shutdownStarted) return;
  shutdownStarted = true;
  server.close();
  await registry.waitForIdle(2000);
  registry.close();
  activeOperations?.flush();
  releaseGatewayRuntime(runtimeHandle);
  process.exit(0);
}

function main() {
  const opts = parseGatewayArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(gatewayUsage(VERSION));
    process.exit(0);
  }
  let cfg;
  try {
    cfg = loadGatewayConfig(opts);
  } catch (error) {
    console.error(error.code === 'CONFIG_READ_ERROR' ? error.message : `ERROR: ${error.message}`);
    process.exit(1);
  }
  activeOperations = createOperationsStore(cfg.configPath);
  try {
    createCodexAgentProjector().reconcile(cfg, activeOperations.listSubagents());
  } catch (error) {
    console.error(`ERROR: Cannot sync native Codex agents: ${error.message}`);
    process.exit(1);
  }
  const log = makeLog(cfg.quiet, activeOperations);
  const startedAt = Date.now();
  const instanceId = crypto.randomUUID();
  let runtimeHandle = null;
  if (process.env.DS_GATEWAY_MANAGED === '1') {
    try {
      runtimeHandle = claimGatewayRuntime({
        configPath: cfg.configPath,
        instanceId,
        host: cfg.host,
        port: cfg.port,
        startedAt,
      });
    } catch (error) {
      console.error(`ERROR: Cannot create gateway runtime record: ${error.message}`);
      process.exit(1);
    }
  }
  process.once('exit', () => {
    activeOperations?.flush();
    releaseGatewayRuntime(runtimeHandle);
  });

  const registry = new ProviderRegistry(cfg, log, activeOperations);
  const loginLimiter = createLoginAttemptLimiter();
  const server = http.createServer((req, res) => {
    handleRequest(cfg, registry, req, res, log, startedAt, instanceId, loginLimiter).catch(err => {
      const code = err.statusCode || 500;
      log(`${code} ${req.method} ${req.url} ${err.message}`);
      if (!res.headersSent) res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: err.message } }));
    });
  });
  activeShutdown = () => shutdown(server, registry, runtimeHandle);
  server.once('error', error => {
    registry.close();
    releaseGatewayRuntime(runtimeHandle);
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
    const addr = server.address();
    cfg.port = addr.port;
    if (runtimeHandle) {
      try {
        runtimeHandle = updateGatewayRuntime(runtimeHandle, {
          host: addr.address,
          port: addr.port,
        });
      } catch (error) {
        console.error(`ERROR: Cannot update gateway runtime record: ${error.message}`);
        server.close();
        registry.close();
        releaseGatewayRuntime(runtimeHandle);
        process.exitCode = 1;
        return;
      }
    }
    registry.activate();
    log(`deepseek-gateway v${VERSION} listening on http://${addr.address}:${addr.port}${cfg.mock ? ' [mock]' : ''}`);
    log(`providers: ${cfg.providers.filter(provider => provider.enabled).map(provider => `${provider.id}(${provider.keys.length} keys)`).join(', ')}`);
    log(`dashboard: http://${addr.address}:${addr.port}/`);
  });
  process.on('SIGINT', () => shutdown(server, registry, runtimeHandle));
  process.on('SIGTERM', () => shutdown(server, registry, runtimeHandle));
}

requireSupportedNodeVersion();
main();
