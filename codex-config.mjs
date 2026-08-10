#!/usr/bin/env node
'use strict';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeConfig, providerModelAlias } from './config-core.mjs';

export { providerModelAlias } from './config-core.mjs';

export const CODEX_PROVIDER_ID = 'multi-provider-gateway';
export const CODEX_ENV_KEY = 'DEEPSEEK_GATEWAY_TOKEN';

const PROJECT_DIR = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = path.join(PROJECT_DIR, 'codex-models.json');

function tomlString(value) {
  return JSON.stringify(String(value));
}

function gatewayApiUrl(gatewayUrl) {
  const url = new URL(gatewayUrl);
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/v1`;
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

function loadTemplates() {
  const parsed = JSON.parse(fs.readFileSync(TEMPLATE_PATH, 'utf8'));
  if (!Array.isArray(parsed.models) || !parsed.models.length) {
    throw new Error('codex-models.json does not contain a model template');
  }
  return parsed.models;
}

function normalizeCatalogConfig(config) {
  return normalizeConfig(config);
}

export function buildModelCatalog(config) {
  config = normalizeCatalogConfig(config);
  const templates = loadTemplates();
  const bySlug = new Map(templates.map(model => [model.slug, model]));
  const fallback = templates[0];
  const models = [];
  const aliases = new Set();
  let priority = 1;

  for (const provider of config.providers) {
    if (!provider.enabled) continue;
    for (const model of provider.models) {
      const alias = providerModelAlias(provider.id, model.id);
      if (aliases.has(alias)) throw new Error(`duplicate model alias: ${alias}`);
      aliases.add(alias);
      const template = bySlug.get(model.upstreamModel) || fallback;
      models.push({
        ...structuredClone(template),
        slug: alias,
        display_name: `${provider.name} · ${model.name}`,
        description: `${model.upstreamModel} through ${provider.name}`,
        priority: priority++,
        visibility: 'list',
        supported_in_api: true,
      });
    }
  }
  if (!models.length) throw new Error('at least one enabled provider model is required');
  return { models };
}

export function buildCodexToml({ config, gatewayUrl, modelsPath }) {
  config = normalizeCatalogConfig(config);
  const baseUrl = gatewayApiUrl(gatewayUrl);
  return [
    `model = ${tomlString(config.defaultModel)}`,
    `model_provider = ${tomlString(CODEX_PROVIDER_ID)}`,
    `model_catalog_json = ${tomlString(modelsPath)}`,
    '',
    `[model_providers.${CODEX_PROVIDER_ID}]`,
    `name = ${tomlString('Multi-Provider Gateway')}`,
    `base_url = ${tomlString(baseUrl)}`,
    'wire_api = "responses"',
    `env_key = ${tomlString(CODEX_ENV_KEY)}`,
    `env_key_instructions = ${tomlString(`Set ${CODEX_ENV_KEY} to the gateway token.`)}`,
    '',
  ].join('\n');
}

export function buildCodexArtifacts(config, options = {}) {
  config = normalizeCatalogConfig(config);
  const gatewayUrl = options.gatewayUrl || `http://127.0.0.1:${config.port || 8787}`;
  const modelsPath = options.modelsPath || path.join(os.homedir(), '.codex', 'gateway-models.json');
  const catalog = buildModelCatalog(config);
  if (!catalog.models.some(model => model.slug === config.defaultModel)) {
    throw new Error(`defaultModel is not present in the generated catalog: ${config.defaultModel}`);
  }
  return {
    providerId: CODEX_PROVIDER_ID,
    envKey: CODEX_ENV_KEY,
    defaultModel: config.defaultModel,
    gatewayUrl: gatewayApiUrl(gatewayUrl),
    modelsPath,
    configToml: buildCodexToml({ config, gatewayUrl, modelsPath }),
    catalog,
    catalogJson: `${JSON.stringify(catalog, null, 2)}\n`,
  };
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--config') args.configPath = argv[++i];
    else if (flag === '--gateway-url') args.gatewayUrl = argv[++i];
    else if (flag === '--models-path') args.modelsPath = argv[++i];
    else if (flag === '--model') args.model = argv[++i];
    else if (flag === '--write-catalog') args.catalogOutput = argv[++i];
    else if (flag === '--print-toml') args.printToml = true;
    else if (flag === '--print-model') args.printModel = true;
    else throw new Error(`unknown option: ${flag}`);
  }
  return args;
}

function runCli() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.configPath) throw new Error('--config is required');
  const config = JSON.parse(fs.readFileSync(args.configPath, 'utf8'));
  const artifacts = buildCodexArtifacts(config, {
    gatewayUrl: args.gatewayUrl,
    modelsPath: args.modelsPath || args.catalogOutput,
  });
  if (args.model && !artifacts.catalog.models.some(model => model.slug === args.model)) {
    throw new Error(`model alias is not present in the generated catalog: ${args.model}`);
  }
  if (args.catalogOutput) {
    fs.writeFileSync(args.catalogOutput, artifacts.catalogJson, { mode: 0o600 });
    fs.chmodSync(args.catalogOutput, 0o600);
  }
  if (args.printToml) process.stdout.write(artifacts.configToml);
  if (args.printModel) process.stdout.write(`${artifacts.defaultModel}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    runCli();
  } catch (error) {
    console.error(`ERROR: ${error.message}`);
    process.exit(1);
  }
}
