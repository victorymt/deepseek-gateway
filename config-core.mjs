#!/usr/bin/env node
'use strict';

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_UPSTREAM = 'https://api.deepseek.com';
export const UPSTREAM_FORMATS = ['responses', 'chat-completions'];
export const MODEL_INPUT_MODALITIES = ['text', 'image'];
export const DEFAULT_MODELS = [
  {
    id: 'v4-flash',
    name: 'V4 Flash',
    upstreamModel: 'deepseek-v4-flash',
    inputModalities: ['text'],
  },
  {
    id: 'v4-pro',
    name: 'V4 Pro',
    upstreamModel: 'deepseek-v4-pro',
    inputModalities: ['text'],
  },
];

const PROVIDER_ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const MODEL_ID_RE = /^[a-z0-9](?:[a-z0-9._\/:+-]{0,61}[a-z0-9])?$/;
const MAX_BALANCE_SCRIPT_BYTES = 64 * 1024;
export const MAX_PROVIDER_KEYS = 1000;

function isLoopbackHost(value) {
  const host = String(value || '').toLowerCase();
  if (host === 'localhost' || host === '::1' || host === '[::1]') return true;
  const octets = host.split('.');
  return octets.length === 4
    && octets[0] === '127'
    && octets.every(octet => /^\d{1,3}$/.test(octet) && Number(octet) <= 255);
}

export function providerModelAlias(providerId, modelId) {
  return `${providerId}--${modelId}`;
}

export function codexModelAlias(providerId, modelId) {
  const provider = String(providerId);
  return `${provider.charAt(0).toUpperCase()}${provider.slice(1)}.${modelId}`;
}

export function normalizeBaseUrl(value, field = 'baseUrl') {
  let url;
  try {
    url = new URL(String(value || ''));
  } catch {
    throw new Error(`${field} must be a valid HTTP(S) URL`);
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error(`${field} must be an HTTP(S) URL without credentials, query, or hash`);
  }
  url.pathname = url.pathname.replace(/\/+$/, '');
  return url.toString().replace(/\/$/, '');
}

export function normalizeIdentifier(value, field) {
  const id = String(value || '').trim().toLowerCase();
  if (!PROVIDER_ID_RE.test(id) || id.includes('--')) {
    throw new Error(`${field} must use lowercase letters, numbers, and single hyphens`);
  }
  return id;
}

export function normalizeModelIdentifier(value, field = 'model id') {
  const id = String(value || '').trim().toLowerCase();
  if (id.includes('--')) throw new Error(`${field} must not contain the reserved separator --`);
  if (!MODEL_ID_RE.test(id)) {
    throw new Error(`${field} must use letters, numbers, dots, underscores, slashes, colons, plus signs, and single hyphens`);
  }
  return id;
}

export function normalizeUpstreamFormat(value, field = 'upstreamFormat') {
  const format = String(value || 'responses').trim().toLowerCase();
  if (!UPSTREAM_FORMATS.includes(format)) {
    throw new Error(`${field} must be one of: ${UPSTREAM_FORMATS.join(', ')}`);
  }
  return format;
}

export function normalizeInputModalities(value, field = 'inputModalities') {
  const source = value === undefined ? ['text'] : value;
  if (!Array.isArray(source) || !source.length) {
    throw new Error(`${field} must be a non-empty array`);
  }
  const values = source.map(item => String(item || '').trim().toLowerCase());
  const unknown = values.filter(item => !MODEL_INPUT_MODALITIES.includes(item));
  if (unknown.length) {
    throw new Error(`${field} must contain only: ${MODEL_INPUT_MODALITIES.join(', ')}`);
  }
  const modalities = MODEL_INPUT_MODALITIES.filter(item => values.includes(item));
  if (!modalities.includes('text')) throw new Error(`${field} must include text`);
  return modalities;
}

export function normalizeHostedWebSearch(value, field = 'supportsHostedWebSearch') {
  if (value !== undefined && typeof value !== 'boolean') {
    throw new Error(`${field} must be a boolean`);
  }
  return value === true;
}

export function canExposeHostedWebSearch(provider, model) {
  return provider?.upstreamFormat === 'responses'
    && model?.supportsHostedWebSearch === true;
}

export function normalizeNumber(value, field, { min = 0, max = Infinity, integer = false } = {}) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max || (integer && !Number.isInteger(number))) {
    throw new Error(`${field} must be ${integer ? 'an integer' : 'a number'} between ${min} and ${max}`);
  }
  return number;
}

export function keyFingerprint(secret) {
  return crypto.createHash('sha256').update(String(secret)).digest('hex');
}

export function normalizeBalanceQuery(input, existing = null, field = 'balanceQuery') {
  const source = input === undefined ? existing : input;
  if (source === undefined || source === null) return null;
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    throw new Error(`${field} must be an object or null`);
  }
  const enabled = source.enabled === undefined ? (existing?.enabled ?? true) : source.enabled === true;
  const language = String(source.language ?? existing?.language ?? 'javascript').trim().toLowerCase();
  if (language !== 'javascript') throw new Error(`${field} language must be javascript`);
  const code = String(source.code ?? existing?.code ?? '').trim();
  if (enabled && !code) throw new Error(`${field} code is required when enabled`);
  if (Buffer.byteLength(code, 'utf8') > MAX_BALANCE_SCRIPT_BYTES) {
    throw new Error(`${field} code must be at most ${MAX_BALANCE_SCRIPT_BYTES} bytes`);
  }
  const timeoutMs = normalizeNumber(
    source.timeoutMs ?? existing?.timeoutMs ?? 10000,
    `${field} timeoutMs`,
    { min: 2000, max: 30000, integer: true },
  );
  const rawRefreshMs = source.refreshMs ?? existing?.refreshMs;
  const refreshMs = rawRefreshMs === undefined
    ? null
    : normalizeNumber(rawRefreshMs, `${field} refreshMs`, { min: 10000, max: 24 * 60 * 60 * 1000, integer: true });
  return {
    enabled,
    language,
    code,
    timeoutMs,
    ...(refreshMs === null ? {} : { refreshMs }),
  };
}

export function normalizeProvider(input, existing = null) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('provider must be an object');
  const id = normalizeIdentifier(input.id ?? existing?.id, 'provider id');
  const name = String(input.name ?? existing?.name ?? id).trim();
  if (!name || name.length > 100) throw new Error(`provider ${id} name is required and must be at most 100 characters`);
  const baseUrl = normalizeBaseUrl(input.baseUrl ?? input.upstream ?? existing?.baseUrl, `provider ${id} baseUrl`);
  const upstreamFormat = normalizeUpstreamFormat(
    input.upstreamFormat ?? existing?.upstreamFormat,
    `provider ${id} upstreamFormat`,
  );
  const enabled = input.enabled === undefined ? (existing?.enabled ?? true) : input.enabled === true;
  const rawModels = input.models ?? existing?.models ?? [];
  const rawKeys = input.keys ?? existing?.keys ?? [];
  const balanceQuery = normalizeBalanceQuery(
    input.balanceQuery,
    existing?.balanceQuery,
    `provider ${id} balanceQuery`,
  );
  if (!Array.isArray(rawModels) || !rawModels.length) throw new Error(`provider ${id} must define at least one model`);
  if (!Array.isArray(rawKeys) || !rawKeys.length) throw new Error(`provider ${id} must define at least one key`);
  if (rawKeys.length > MAX_PROVIDER_KEYS) {
    throw new Error(`provider ${id} must not define more than ${MAX_PROVIDER_KEYS} keys`);
  }

  const models = rawModels.map(model => {
    if (!model || typeof model !== 'object' || Array.isArray(model)) throw new Error(`provider ${id} has an invalid model`);
    const modelId = normalizeModelIdentifier(model.id, `provider ${id} model id`);
    const modelName = String(model.name || modelId).trim();
    const upstreamModel = String(model.upstreamModel || '').trim();
    const inputModalities = normalizeInputModalities(
      model.inputModalities,
      `provider ${id} model ${modelId} inputModalities`,
    );
    const supportsHostedWebSearch = normalizeHostedWebSearch(
      model.supportsHostedWebSearch,
      `provider ${id} model ${modelId} supportsHostedWebSearch`,
    );
    if (!modelName || modelName.length > 100) throw new Error(`provider ${id} model ${modelId} name is invalid`);
    if (!upstreamModel || upstreamModel.length > 200) throw new Error(`provider ${id} model ${modelId} upstreamModel is required`);
    if (supportsHostedWebSearch && upstreamFormat !== 'responses') {
      throw new Error(
        `provider ${id} model ${modelId} supportsHostedWebSearch requires responses upstreamFormat`,
      );
    }
    return {
      id: modelId,
      name: modelName,
      upstreamModel,
      inputModalities,
      supportsHostedWebSearch,
    };
  });

  const existingKeys = new Map((existing?.keys || []).map(key => [key.name, key]));
  const canReuseExistingSecrets = Boolean(
    existing?.baseUrl
    && new URL(existing.baseUrl).origin === new URL(baseUrl).origin,
  );
  const keys = rawKeys.map((key, index) => {
    if (!key || typeof key !== 'object' || Array.isArray(key)) throw new Error(`provider ${id} has an invalid key`);
    const keyName = String(key.name || `key-${index + 1}`).trim();
    const originalName = String(key.originalName || keyName).trim();
    let secret = typeof key.key === 'string' ? key.key.trim() : '';
    if (!secret && canReuseExistingSecrets && existingKeys.has(originalName)) {
      secret = existingKeys.get(originalName).key;
    }
    const weight = Number(key.weight ?? 1);
    const enabled = key.enabled === undefined
      ? (existingKeys.get(keyName)?.enabled ?? true)
      : key.enabled === true;
    const alwaysTry = key.alwaysTry === undefined
      ? (existingKeys.get(keyName)?.alwaysTry ?? false)
      : key.alwaysTry === true;
    if (!keyName || keyName.length > 100) throw new Error(`provider ${id} key name is invalid`);
    if (!secret) throw new Error(`provider ${id} key ${keyName} secret is required`);
    if (!Number.isFinite(weight) || weight <= 0) throw new Error(`provider ${id} key ${keyName} weight must be greater than zero`);
    return { name: keyName, key: secret, weight, enabled, alwaysTry };
  });

  return {
    id,
    name,
    baseUrl,
    upstreamFormat,
    enabled,
    models,
    keys,
    ...(balanceQuery ? { balanceQuery } : {}),
  };
}

export function validateProviderConfig(config, { allowSetup = false } = {}) {
  if (config.setupPending === true) {
    if (!allowSetup) throw new Error('gateway setup is incomplete');
    if (!Array.isArray(config.providers) || config.providers.length) {
      throw new Error('setupPending config must not contain providers');
    }
    if (config.defaultProvider || config.defaultModel) {
      throw new Error('setupPending config must not define defaultProvider or defaultModel');
    }
    return;
  }
  if (!Array.isArray(config.providers) || !config.providers.length) throw new Error('at least one provider is required');
  const providerIds = new Set();
  const aliases = new Set();
  let enabledCount = 0;
  for (const provider of config.providers) {
    if (providerIds.has(provider.id)) throw new Error(`duplicate provider id: ${provider.id}`);
    providerIds.add(provider.id);
    if (provider.enabled) enabledCount++;
    const modelIds = new Set();
    for (const model of provider.models) {
      if (modelIds.has(model.id)) throw new Error(`duplicate model id ${model.id} in provider ${provider.id}`);
      modelIds.add(model.id);
      const alias = providerModelAlias(provider.id, model.id);
      if (aliases.has(alias)) throw new Error(`duplicate model alias: ${alias}`);
      aliases.add(alias);
    }
    const keyNames = new Set();
    const keyFingerprints = new Set();
    let enabledKeyCount = 0;
    for (const key of provider.keys) {
      if (keyNames.has(key.name)) throw new Error(`duplicate key name ${key.name} in provider ${provider.id}`);
      keyNames.add(key.name);
      const fingerprint = keyFingerprint(key.key);
      if (keyFingerprints.has(fingerprint)) throw new Error(`duplicate key secret in provider ${provider.id}`);
      keyFingerprints.add(fingerprint);
      if (key.enabled) enabledKeyCount++;
    }
    if (!enabledKeyCount) throw new Error(`provider ${provider.id} must have at least one enabled key`);
  }
  if (!enabledCount) throw new Error('at least one provider must be enabled');
  const defaultProvider = config.providers.find(provider => provider.id === config.defaultProvider);
  if (!defaultProvider || !defaultProvider.enabled) throw new Error('defaultProvider must reference an enabled provider');
  if (!aliases.has(config.defaultModel)) throw new Error('defaultModel must reference a configured model alias');
  const defaultModelProvider = config.defaultModel.split('--', 1)[0];
  if (defaultModelProvider !== config.defaultProvider) throw new Error('defaultModel must belong to defaultProvider');
}

export function migrateConfig(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('config must be an object');
  if (Number.isFinite(raw.schemaVersion) && raw.schemaVersion > 2) {
    throw new Error(`unsupported config schemaVersion: ${raw.schemaVersion}`);
  }
  if (Array.isArray(raw.providers)) {
    return {
      ...raw,
      schemaVersion: 2,
      blacklistThreshold: raw.blacklistThreshold ?? raw.breakerThreshold ?? 3,
    };
  }
  const {
    upstream = DEFAULT_UPSTREAM,
    keys = [],
    breakerThreshold,
    ...stored
  } = raw;
  return {
    ...stored,
    schemaVersion: 2,
    blacklistThreshold: stored.blacklistThreshold ?? breakerThreshold ?? 3,
    defaultProvider: stored.defaultProvider || 'deepseek',
    defaultModel: stored.defaultModel || 'deepseek--v4-flash',
    providers: [{
      id: 'deepseek',
      name: 'DeepSeek',
      baseUrl: upstream,
      enabled: true,
      models: DEFAULT_MODELS,
      keys,
    }],
  };
}

export function normalizeConfig(raw, { allowSetup = false } = {}) {
  const migrated = migrateConfig(raw);
  const setupPending = migrated.setupPending === true;
  if (setupPending && (String(migrated.defaultProvider || '').trim() || String(migrated.defaultModel || '').trim())) {
    throw new Error('setupPending config must not define defaultProvider or defaultModel');
  }
  const providers = migrated.providers.map(provider => normalizeProvider(provider));
  const defaultProvider = setupPending
    ? ''
    : normalizeIdentifier(migrated.defaultProvider || providers.find(provider => provider.enabled)?.id, 'defaultProvider');
  const defaultEntry = providers.find(provider => provider.id === defaultProvider);
  let defaultModel = setupPending ? '' : String(migrated.defaultModel || '').trim();
  if (!defaultModel && defaultEntry) defaultModel = providerModelAlias(defaultEntry.id, defaultEntry.models[0].id);
  if (defaultModel && !defaultModel.includes('--') && defaultEntry) {
    const model = defaultEntry.models.find(item => item.upstreamModel === defaultModel || item.id === defaultModel);
    if (model) defaultModel = providerModelAlias(defaultEntry.id, model.id);
  }
  const config = {
    ...migrated,
    schemaVersion: 2,
    setupPending,
    port: normalizeNumber(migrated.port ?? 8787, 'port', { min: 0, max: 65535, integer: true }),
    host: String(migrated.host || '127.0.0.1'),
    cooldownMs: normalizeNumber(migrated.cooldownMs ?? 60000, 'cooldownMs'),
    blacklistThreshold: normalizeNumber(migrated.blacklistThreshold ?? 3, 'blacklistThreshold', { integer: true }),
    balanceRefreshMs: normalizeNumber(migrated.balanceRefreshMs ?? 300000, 'balanceRefreshMs'),
    maxRetries: normalizeNumber(migrated.maxRetries ?? 2, 'maxRetries', { integer: true }),
    timeoutMs: normalizeNumber(migrated.timeoutMs ?? 0, 'timeoutMs'),
    maxBodyBytes: normalizeNumber(migrated.maxBodyBytes ?? 64 * 1024 * 1024, 'maxBodyBytes', { min: 1, integer: true }),
    token: String(migrated.token || ''),
    adminToken: String(migrated.adminToken || ''),
    defaultProvider,
    defaultModel,
    providers,
  };
  if (!isLoopbackHost(config.host) && config.token.length < 16) {
    throw new Error('a non-loopback host requires a gateway token of at least 16 characters');
  }
  if (config.adminToken && config.adminToken.length < 16) {
    throw new Error('adminToken must be at least 16 characters');
  }
  if (config.token && !config.adminToken) {
    throw new Error('gateway authentication requires a separate adminToken of at least 16 characters');
  }
  if (config.token && config.adminToken === config.token) {
    throw new Error('adminToken must be different from the gateway token');
  }
  validateProviderConfig(config, { allowSetup });
  return config;
}

export function serializableConfig(config) {
  const {
    configPath: _configPath,
    upstream: _upstream,
    keys: _keys,
    breakerThreshold: _breakerThreshold,
    mock: _mock,
    quiet: _quiet,
    ...stored
  } = config;
  return {
    ...stored,
    schemaVersion: 2,
    setupPending: config.setupPending === true,
    port: config.port,
    host: config.host,
    cooldownMs: config.cooldownMs,
    blacklistThreshold: config.blacklistThreshold,
    balanceRefreshMs: config.balanceRefreshMs,
    maxRetries: config.maxRetries,
    timeoutMs: config.timeoutMs,
    maxBodyBytes: config.maxBodyBytes,
    token: config.token,
    adminToken: config.adminToken,
    defaultProvider: config.defaultProvider,
    defaultModel: config.defaultModel,
    providers: config.providers.map(provider => ({
      ...provider,
      models: provider.models.map(({
        supportsHostedWebSearch,
        ...model
      }) => ({
        ...model,
        ...(supportsHostedWebSearch
          ? { supportsHostedWebSearch: true }
          : {}),
      })),
      keys: provider.keys.map(key => ({
        name: key.name,
        key: key.key,
        weight: key.weight,
        enabled: key.enabled,
        ...(key.alwaysTry ? { alwaysTry: true } : {}),
      })),
    })),
  };
}

export function persistConfig(configPath, config) {
  const target = path.resolve(configPath);
  const dir = path.dirname(target);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (fs.existsSync(target)) {
    const backup = `${target}.bak`;
    fs.copyFileSync(target, backup);
    fs.chmodSync(backup, 0o600);
  }
  const temp = path.join(dir, `.${path.basename(target)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(temp, `${JSON.stringify(serializableConfig(config), null, 2)}\n`, { mode: 0o600 });
    fs.chmodSync(temp, 0o600);
    fs.renameSync(temp, target);
  } catch (error) {
    try { fs.unlinkSync(temp); } catch {}
    throw error;
  }
}

function runCli() {
  const modes = ['--migrate-stdin', '--normalize-stdin', '--normalize-setup-stdin'];
  if (process.argv.length !== 3 || !modes.includes(process.argv[2])) {
    throw new Error('usage: node config-core.mjs <--migrate-stdin|--normalize-stdin|--normalize-setup-stdin>');
  }
  const raw = JSON.parse(fs.readFileSync(0, 'utf8'));
  let result;
  if (process.argv[2] === '--migrate-stdin') result = migrateConfig(raw);
  else {
    result = serializableConfig(normalizeConfig(raw, {
      allowSetup: process.argv[2] === '--normalize-setup-stdin',
    }));
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    runCli();
  } catch (error) {
    console.error(`ERROR: ${error.message}`);
    process.exit(1);
  }
}
