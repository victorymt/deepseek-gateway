'use strict';

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  DEFAULT_UPSTREAM,
  normalizeBaseUrl,
  normalizeConfig,
  serializableConfig,
  validateProviderConfig,
} from './config-core.mjs';

export function gatewayUsage(version) {
  return `deepseek-gateway v${version}

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
}

export function parseGatewayArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
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
        if (arg.startsWith('-')) {
          console.error(`unknown option: ${arg}`);
          opts.help = true;
        } else {
          opts.positional = arg;
        }
    }
  }
  return opts;
}

function configCandidates() {
  return [
    './keys.json',
    path.join(os.homedir(), '.deepseek-gateway', 'keys.json'),
  ];
}

function splitKeyToken(token) {
  token = token.trim();
  if (!token) return null;
  if (/^sk-/i.test(token)) return { name: null, secret: token };
  const eq = token.indexOf('=');
  const colon = token.indexOf(':');
  let name = null;
  let secret = token;
  if (eq > 0) {
    name = token.slice(0, eq);
    secret = token.slice(eq + 1);
  } else if (colon > 0) {
    name = token.slice(0, colon);
    secret = token.slice(colon + 1);
  }
  return { name, secret };
}

export function loadGatewayConfig(opts, env = process.env) {
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
    adminToken: '',
    keys: [],
  };
  const candidates = configCandidates();
  const configPath = opts.config
    || env.DS_GATEWAY_CONFIG
    || candidates.find(candidate => fs.existsSync(candidate))
    || candidates[0];
  if (fs.existsSync(configPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (
        parsed.blacklistThreshold === undefined
        && parsed.breakerThreshold !== undefined
      ) {
        parsed.blacklistThreshold = parsed.breakerThreshold;
      }
      Object.assign(fileConfig, parsed);
    } catch (error) {
      throw Object.assign(
        new Error(`failed to read config ${configPath}: ${error.message}`, {
          cause: error,
        }),
        { code: 'CONFIG_READ_ERROR', configPath: path.resolve(configPath) },
      );
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
  if (env.DEEPSEEK_KEYS) {
    env.DEEPSEEK_KEYS.split(',').forEach(token => {
      const parsed = splitKeyToken(token);
      if (parsed) addExternalKey(parsed.name, parsed.secret);
    });
  }
  if (opts.keys) {
    opts.keys.split(',').forEach(token => {
      const parsed = splitKeyToken(token);
      if (parsed) addExternalKey(parsed.name, parsed.secret);
    });
  }

  let persistedConfig = null;
  try {
    persistedConfig = normalizeConfig(fileConfig, { allowSetup: true });
  } catch (error) {
    const noLegacyFileKeys = !hasProviderConfig
      && (!Array.isArray(fileConfig.keys) || !fileConfig.keys.length);
    if (!(noLegacyFileKeys && (externalKeys.length || opts.mock))) throw error;
  }

  const effective = persistedConfig
    ? serializableConfig(persistedConfig)
    : structuredClone(fileConfig);
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
  if (env.DS_GATEWAY_PORT) applyScalarOverride('port', Number(env.DS_GATEWAY_PORT), 'DS_GATEWAY_PORT');
  if (opts.port !== undefined) applyScalarOverride('port', opts.port, '--port');
  if (env.DS_GATEWAY_TOKEN) applyScalarOverride('token', env.DS_GATEWAY_TOKEN, 'DS_GATEWAY_TOKEN');
  if (opts.token) applyScalarOverride('token', opts.token, '--token');
  if (env.DS_GATEWAY_ADMIN_TOKEN) applyScalarOverride('adminToken', env.DS_GATEWAY_ADMIN_TOKEN, 'DS_GATEWAY_ADMIN_TOKEN');
  if (env.DS_COOLDOWN_MS) applyScalarOverride('cooldownMs', Number(env.DS_COOLDOWN_MS), 'DS_COOLDOWN_MS');
  if (opts.cooldownMs !== undefined) applyScalarOverride('cooldownMs', opts.cooldownMs, '--cooldown-ms');
  if (env.DS_BREAKER) applyScalarOverride('blacklistThreshold', Number(env.DS_BREAKER), 'DS_BREAKER');
  if (env.DS_BLACKLIST_THRESHOLD) applyScalarOverride('blacklistThreshold', Number(env.DS_BLACKLIST_THRESHOLD), 'DS_BLACKLIST_THRESHOLD');
  if (opts.blacklistThreshold !== undefined) applyScalarOverride('blacklistThreshold', opts.blacklistThreshold, '--blacklist-threshold');
  if (env.DS_BALANCE_REFRESH_MS) applyScalarOverride('balanceRefreshMs', Number(env.DS_BALANCE_REFRESH_MS), 'DS_BALANCE_REFRESH_MS');
  if (opts.balanceRefreshMs !== undefined) applyScalarOverride('balanceRefreshMs', opts.balanceRefreshMs, '--balance-refresh-ms');
  if (env.DS_MAX_RETRIES) applyScalarOverride('maxRetries', Number(env.DS_MAX_RETRIES), 'DS_MAX_RETRIES');
  if (opts.maxRetries !== undefined) applyScalarOverride('maxRetries', opts.maxRetries, '--max-retries');
  if (env.DS_MAX_BODY_BYTES) applyScalarOverride('maxBodyBytes', Number(env.DS_MAX_BODY_BYTES), 'DS_MAX_BODY_BYTES');
  if (opts.maxBodyBytes !== undefined) applyScalarOverride('maxBodyBytes', opts.maxBodyBytes, '--max-body-bytes');
  if (opts.host) applyScalarOverride('host', opts.host, '--host');

  const normalized = normalizeConfig(effective, { allowSetup: true });
  const defaultProvider = normalized.providers.find(
    provider => provider.id === normalized.defaultProvider,
  );
  if (normalized.setupPending && (externalKeys.length || env.DS_UPSTREAM || opts.upstream)) {
    throw new Error(
      'provider runtime overrides cannot be used before gateway setup is complete',
    );
  }
  if (defaultProvider) {
    if (env.DS_UPSTREAM) {
      defaultProvider.baseUrl = normalizeBaseUrl(env.DS_UPSTREAM, 'DS_UPSTREAM');
    }
    if (opts.upstream) {
      defaultProvider.baseUrl = normalizeBaseUrl(opts.upstream, '--upstream');
    }
    if (hasProviderConfig && externalKeys.length) {
      defaultProvider.keys = externalKeys;
    }
    if (!hasProviderConfig && persistedConfig && externalKeys.length) {
      defaultProvider.keys = [...defaultProvider.keys, ...externalKeys];
    }
  }
  normalized.configPath = path.resolve(configPath);
  normalized.upstream = defaultProvider?.baseUrl || '';
  normalized.keys = defaultProvider?.keys || [];
  normalized.mock = !!opts.mock;
  normalized.quiet = !!opts.quiet;
  validateProviderConfig(normalized, { allowSetup: true });

  const providerOverrides = [];
  if (env.DEEPSEEK_KEYS) providerOverrides.push('DEEPSEEK_KEYS');
  if (opts.keys) providerOverrides.push('--keys');
  if (env.DS_UPSTREAM) providerOverrides.push('DS_UPSTREAM');
  if (opts.upstream) providerOverrides.push('--upstream');
  Object.defineProperties(normalized, {
    _persistedConfig: { value: persistedConfig, writable: true },
    _providerOverrides: { value: providerOverrides, writable: true },
    _scalarOverrides: { value: scalarOverrides, writable: true },
    _managementRevision: {
      value: crypto.randomInt(1, 281474976710656),
      writable: true,
    },
  });
  return normalized;
}
