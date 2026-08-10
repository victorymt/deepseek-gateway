'use strict';

import { keyFingerprint } from './config-core.mjs';

export const MAX_KEY_IMPORT_BYTES = 1024 * 1024;
export const MAX_KEY_IMPORT_ENTRIES = 500;
export const MAX_KEY_SECRET_LENGTH = 8192;

function importError(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

function parseToken(token, entry) {
  const value = String(token || '').trim();
  if (!value) return null;
  if (/^sk-/i.test(value)) return { name: null, secret: value, entry };
  const separator = value.search(/[=:]/);
  if (separator > 0) {
    return {
      name: value.slice(0, separator).trim() || null,
      secret: value.slice(separator + 1).trim(),
      entry,
    };
  }
  return { name: null, secret: value, entry };
}

function parseJsonEntries(value) {
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw importError('invalid JSON key list');
  }
  if (!Array.isArray(parsed)) throw importError('JSON key list must be an array');
  return parsed.map((item, index) => {
    if (typeof item === 'string') {
      return parseToken(item, index + 1) || { name: null, secret: '', entry: index + 1 };
    }
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw importError(`JSON key entry ${index + 1} must be a string or object`);
    }
    const allowed = new Set(['name', 'key', 'weight', 'enabled', 'alwaysTry']);
    const unknown = Object.keys(item).filter(field => !allowed.has(field));
    if (unknown.length) throw importError(`JSON key entry ${index + 1} has unknown fields: ${unknown.join(', ')}`);
    return {
      name: item.name === undefined ? null : String(item.name).trim() || null,
      secret: typeof item.key === 'string' ? item.key.trim() : '',
      ...(Object.hasOwn(item, 'weight') ? { weight: item.weight } : {}),
      ...(Object.hasOwn(item, 'enabled') ? { enabled: item.enabled } : {}),
      ...(Object.hasOwn(item, 'alwaysTry') ? { alwaysTry: item.alwaysTry } : {}),
      entry: index + 1,
    };
  });
}

export function parseKeyImportText(text) {
  if (typeof text !== 'string') throw importError('keysText must be a string');
  if (Buffer.byteLength(text, 'utf8') > MAX_KEY_IMPORT_BYTES) {
    throw importError(`key import is limited to ${MAX_KEY_IMPORT_BYTES} bytes`);
  }
  const trimmed = text.trim();
  if (!trimmed) throw importError('key import text cannot be empty');
  if (trimmed.startsWith('[')) return parseJsonEntries(trimmed);

  return trimmed
    .split(/[\s,;]+/)
    .map((token, index) => parseToken(token, index + 1))
    .filter(Boolean);
}

function normalizedOverride(value, field, entry, fallback) {
  if (value === undefined) return fallback;
  if (field === 'weight') {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      throw importError(`key entry ${entry} weight must be greater than zero`);
    }
    return value;
  }
  if (typeof value !== 'boolean') throw importError(`key entry ${entry} ${field} must be a boolean`);
  return value;
}

export function prepareKeyImport(provider, text, defaults = {}) {
  if (!provider || !Array.isArray(provider.keys)) throw importError('provider keys are invalid');
  if (!defaults || typeof defaults !== 'object' || Array.isArray(defaults)) {
    throw importError('defaults must be an object');
  }
  const unknownDefaults = Object.keys(defaults).filter(field => !['weight', 'enabled', 'alwaysTry'].includes(field));
  if (unknownDefaults.length) throw importError(`unknown import defaults: ${unknownDefaults.join(', ')}`);
  const defaultWeight = normalizedOverride(defaults.weight, 'weight', 'defaults', 1);
  const defaultEnabled = normalizedOverride(defaults.enabled, 'enabled', 'defaults', true);
  const defaultAlwaysTry = normalizedOverride(defaults.alwaysTry, 'alwaysTry', 'defaults', false);
  const entries = parseKeyImportText(text);
  if (entries.length > MAX_KEY_IMPORT_ENTRIES) {
    throw importError(`key import is limited to ${MAX_KEY_IMPORT_ENTRIES} entries`);
  }

  const existingNames = new Set(provider.keys.map(key => key.name));
  const existingByName = new Map(provider.keys.map(key => [key.name, keyFingerprint(key.key)]));
  const existingFingerprints = new Set(provider.keys.map(key => keyFingerprint(key.key)));
  const explicitNames = new Map();
  for (const entry of entries) {
    if (!entry || !entry.secret) throw importError(`key entry ${entry?.entry ?? 'unknown'} has an empty secret`);
    if (entry.secret.length > MAX_KEY_SECRET_LENGTH) {
      throw importError(`key entry ${entry.entry} exceeds ${MAX_KEY_SECRET_LENGTH} characters`);
    }
    if (entry.name && entry.name.length > 100) {
      throw importError(`key entry ${entry.entry} name must be at most 100 characters`);
    }
    normalizedOverride(entry.weight, 'weight', entry.entry, defaultWeight);
    normalizedOverride(entry.enabled, 'enabled', entry.entry, defaultEnabled);
    normalizedOverride(entry.alwaysTry, 'alwaysTry', entry.entry, defaultAlwaysTry);
    if (!entry.name) continue;
    const fingerprint = keyFingerprint(entry.secret);
    if (explicitNames.has(entry.name) && explicitNames.get(entry.name) !== fingerprint) {
      throw importError(`key name ${entry.name} is used by multiple different secrets`, 409);
    }
    explicitNames.set(entry.name, fingerprint);
  }

  const reservedNames = new Set([...existingNames, ...explicitNames.keys()]);
  const usedNames = new Set(existingNames);
  const fingerprints = new Set(existingFingerprints);
  const additions = [];
  const ignored = [];
  let generatedName = 1;

  for (const entry of entries) {
    const fingerprint = keyFingerprint(entry.secret);
    if (entry.name && existingByName.has(entry.name) && existingByName.get(entry.name) !== fingerprint) {
      throw importError(`key name ${entry.name} already exists with a different secret`, 409);
    }
    if (fingerprints.has(fingerprint)) {
      ignored.push({ entry: entry.entry, name: entry.name, reason: 'duplicate-secret' });
      continue;
    }

    let name = entry.name;
    if (!name) {
      do name = `imported-${generatedName++}`;
      while (reservedNames.has(name) || usedNames.has(name));
    }
    if (usedNames.has(name)) {
      throw importError(`key name ${name} already exists with a different secret`, 409);
    }

    const key = {
      name,
      key: entry.secret,
      weight: normalizedOverride(entry.weight, 'weight', entry.entry, defaultWeight),
      enabled: normalizedOverride(entry.enabled, 'enabled', entry.entry, defaultEnabled),
      alwaysTry: normalizedOverride(entry.alwaysTry, 'alwaysTry', entry.entry, defaultAlwaysTry),
    };
    additions.push(key);
    fingerprints.add(fingerprint);
    usedNames.add(name);
  }

  return {
    keys: [...provider.keys, ...additions],
    addedCount: additions.length,
    ignoredCount: ignored.length,
    ignored,
  };
}
