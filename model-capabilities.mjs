'use strict';

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
    models.set(id, Object.freeze({ ...entry, id, inputModalities }));
  }
  const unknownInputModalities = normalizeModalities(catalog.unknownModel?.inputModalities);
  if (!unknownInputModalities) {
    throw new Error('model-capabilities.json requires unknownModel.inputModalities');
  }
  return Object.freeze({
    schemaVersion: catalog.schemaVersion,
    unknownModel: Object.freeze({ inputModalities: unknownInputModalities }),
    models,
  });
}

const catalog = loadCatalog();

export function findModelCapability(model) {
  const normalized = normalizeModelId(model);
  if (!normalized) return null;
  const tail = normalized.split('/').at(-1);
  return catalog.models.get(normalized) || catalog.models.get(tail) || null;
}

export function inferModelCapabilities(model, declaration = null) {
  const declared = declaredInputModalities(declaration);
  if (declared) {
    return { inputModalities: declared, source: 'upstream' };
  }
  const registered = findModelCapability(model);
  if (registered) {
    return {
      ...registered,
      inputModalities: [...registered.inputModalities],
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
    models: [...catalog.models.values()].map(entry => ({
      ...entry,
      inputModalities: [...entry.inputModalities],
    })),
  };
}
