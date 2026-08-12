'use strict';

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeCatalogReasoningConfig } from './reasoning-config.mjs';

const PROJECT_DIR = path.dirname(fileURLToPath(import.meta.url));
const CATALOG_PATH = path.join(PROJECT_DIR, 'model-capabilities.json');
const ALLOWED_INPUT_MODALITIES = new Set(['text', 'image']);

function normalizeModelId(value) {
  let normalized = String(value || '')
    .trim()
    .replace(/^models\//i, '')
    .trim()
    .toLowerCase();
  normalized = normalized.replace(/\[1m\]$/i, '').trim();
  return normalized;
}

function normalizeModalities(value) {
  if (!Array.isArray(value)) return null;
  const normalized = [...new Set(value
    .map(item => String(item || '').trim().toLowerCase())
    .filter(item => ALLOWED_INPUT_MODALITIES.has(item)))];
  if (!normalized.length) return null;
  if (!normalized.includes('text')) normalized.unshift('text');
  return ['text', 'image'].filter(item => normalized.includes(item));
}

function declaredInputModalities(declaration) {
  if (Array.isArray(declaration)) return normalizeModalities(declaration);
  if (!declaration || typeof declaration !== 'object') return null;

  for (const value of [
    declaration.inputModalities,
    declaration.input_modalities,
    declaration.input,
    declaration.modalities?.input,
    declaration.architecture?.input_modalities,
  ]) {
    const modalities = normalizeModalities(value);
    if (modalities) return modalities;
  }

  for (const value of [
    declaration.supportsImage,
    declaration.supports_image,
    declaration.supportsVision,
    declaration.supports_vision,
    declaration.vision,
  ]) {
    if (typeof value === 'boolean') {
      return value ? ['text', 'image'] : ['text'];
    }
  }

  const capabilities = Array.isArray(declaration.capabilities)
    ? declaration.capabilities.map(value => String(value || '').trim().toLowerCase())
    : null;
  if (capabilities?.some(value => value === 'image' || value === 'vision')) {
    return ['text', 'image'];
  }
  return null;
}

function cloneCapability(entry) {
  return structuredClone(entry);
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

function loadCatalog() {
  const catalog = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8'));
  if (catalog.schemaVersion !== 1 || !Array.isArray(catalog.models)) {
    throw new Error('model-capabilities.json has an unsupported schema');
  }
  const models = new Map();
  for (const entry of catalog.models) {
    const id = normalizeModelId(entry?.id);
    const inputModalities = normalizeModalities(entry?.inputModalities);
    if (!id || !inputModalities) {
      throw new Error('model-capabilities.json contains an invalid model entry');
    }
    if (models.has(id)) {
      throw new Error(`model-capabilities.json contains duplicate model: ${id}`);
    }
    const reasoning = entry.reasoning === undefined
      ? undefined
      : normalizeCatalogReasoningConfig(
        entry.reasoning,
        `model-capabilities.json model ${id} reasoning`,
      );
    models.set(id, deepFreeze({
      ...entry,
      id,
      inputModalities,
      ...(reasoning ? { reasoning } : {}),
    }));
  }
  const unknownInputModalities = normalizeModalities(catalog.unknownModel?.inputModalities);
  if (!unknownInputModalities) {
    throw new Error('model-capabilities.json requires unknownModel.inputModalities');
  }
  return Object.freeze({
    schemaVersion: catalog.schemaVersion,
    unknownModel: Object.freeze({ inputModalities: Object.freeze(unknownInputModalities) }),
    models,
  });
}

const catalog = loadCatalog();

export function findModelCapability(model) {
  const normalized = normalizeModelId(model);
  if (!normalized) return null;
  const tail = normalized.split('/').at(-1);
  const registered = catalog.models.get(normalized) || catalog.models.get(tail);
  return registered ? cloneCapability(registered) : null;
}

export function inferModelCapabilities(model, declaration = null) {
  const declared = declaredInputModalities(declaration);
  const registered = findModelCapability(model);
  if (declared) {
    return {
      inputModalities: declared,
      ...(registered?.reasoning ? { reasoning: structuredClone(registered.reasoning) } : {}),
      source: 'upstream',
    };
  }
  if (registered) {
    return {
      ...registered,
      source: 'registry',
    };
  }
  return {
    inputModalities: [...catalog.unknownModel.inputModalities],
    source: 'default',
  };
}

export function modelCapabilityCatalog() {
  return {
    schemaVersion: catalog.schemaVersion,
    unknownModel: { inputModalities: [...catalog.unknownModel.inputModalities] },
    models: [...catalog.models.values()].map(cloneCapability),
  };
}
