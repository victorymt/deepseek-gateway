#!/usr/bin/env node
'use strict';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { codexModelAlias, normalizeConfig } from './config-core.mjs';

export { codexModelAlias, providerModelAlias } from './config-core.mjs';

export const CODEX_PROVIDER_ID = 'multi-provider-gateway';
export const CODEX_ENV_KEY = 'DEEPSEEK_GATEWAY_TOKEN';
const AUTH_MODES = new Set(['auto', 'required', 'none']);

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

function codexModelAliasForInput(value) {
  const candidate = String(value || '').trim();
  const separator = candidate.indexOf('--');
  if (separator < 0) return candidate;
  return codexModelAlias(
    candidate.slice(0, separator),
    candidate.slice(separator + 2),
  );
}

function codexDefaultModel(config) {
  return codexModelAliasForInput(config.defaultModel);
}

function authRequired(config, options = {}) {
  if (typeof options.authRequired === 'boolean') return options.authRequired;
  const mode = options.auth || 'auto';
  if (!AUTH_MODES.has(mode)) throw new Error(`invalid auth mode: ${mode}`);
  if (mode === 'required') return true;
  if (mode === 'none') return false;
  return Boolean(config.token);
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
      const alias = codexModelAlias(provider.id, model.id);
      if (aliases.has(alias)) throw new Error(`duplicate model alias: ${alias}`);
      aliases.add(alias);
      const template = bySlug.get(model.upstreamModel) || fallback;
      models.push({
        ...structuredClone(template),
        slug: alias,
        display_name: alias,
        description: `${model.upstreamModel} through ${provider.name}`,
        priority: priority++,
        visibility: 'list',
        supported_in_api: true,
        input_modalities: [...model.inputModalities],
        // Codex CLI hides MCP tools (ToolExposure::Deferred) when
        // supports_search_tool is true and the upstream does not implement
        // tool_search (see deepseek-ai/awesome-deepseek-agent#341 and
        // openai/codex#36382). DeepSeek upstreams do not support it, so the
        // catalog always disables the flag regardless of the template.
        supports_search_tool: false,
      });
    }
  }
  if (!models.length) throw new Error('at least one enabled provider model is required');
  return { models };
}

export function buildCodexToml({ config, gatewayUrl, modelsPath, authRequired: requireAuth }) {
  config = normalizeCatalogConfig(config);
  const baseUrl = gatewayApiUrl(gatewayUrl);
  const lines = [
    `model = ${tomlString(codexDefaultModel(config))}`,
    `model_provider = ${tomlString(CODEX_PROVIDER_ID)}`,
    `model_catalog_json = ${tomlString(modelsPath)}`,
    '',
    `[model_providers.${CODEX_PROVIDER_ID}]`,
    `name = ${tomlString('Multi-Provider Gateway')}`,
    `base_url = ${tomlString(baseUrl)}`,
    'wire_api = "responses"',
  ];
  if (requireAuth ?? Boolean(config.token)) {
    lines.push(
      `env_key = ${tomlString(CODEX_ENV_KEY)}`,
      `env_key_instructions = ${tomlString(`Set ${CODEX_ENV_KEY} to the gateway token.`)}`,
    );
  }
  lines.push('');
  return lines.join('\n');
}

export function buildCodexArtifacts(config, options = {}) {
  config = normalizeCatalogConfig(config);
  const gatewayUrl = options.gatewayUrl || `http://127.0.0.1:${config.port || 8787}`;
  const modelsPath = options.modelsPath || path.join(os.homedir(), '.codex', 'gateway-models.json');
  const requireAuth = authRequired(config, options);
  const catalog = buildModelCatalog(config);
  const defaultModel = codexDefaultModel(config);
  if (!catalog.models.some(model => model.slug === defaultModel)) {
    throw new Error(`defaultModel is not present in the generated catalog: ${config.defaultModel}`);
  }
  return {
    providerId: CODEX_PROVIDER_ID,
    authRequired: requireAuth,
    envKey: requireAuth ? CODEX_ENV_KEY : null,
    defaultModel,
    gatewayUrl: gatewayApiUrl(gatewayUrl),
    modelsPath,
    configToml: buildCodexToml({ config, gatewayUrl, modelsPath, authRequired: requireAuth }),
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
    else if (flag === '--auth') {
      args.auth = argv[++i];
      if (!AUTH_MODES.has(args.auth)) throw new Error('--auth requires auto, required, or none');
    }
    else if (flag === '--write-catalog') args.catalogOutput = argv[++i];
    else if (flag === '--print-toml') args.printToml = true;
    else if (flag === '--print-model') args.printModel = true;
    else if (flag === '--print-auth') args.printAuth = true;
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
    auth: args.auth,
  });
  const requestedModel = args.model ? codexModelAliasForInput(args.model) : null;
  if (requestedModel && !artifacts.catalog.models.some(model => model.slug === requestedModel)) {
    throw new Error(`model alias is not present in the generated catalog: ${args.model}`);
  }
  if (args.catalogOutput) {
    fs.writeFileSync(args.catalogOutput, artifacts.catalogJson, { mode: 0o600 });
    fs.chmodSync(args.catalogOutput, 0o600);
  }
  if (args.printToml) process.stdout.write(artifacts.configToml);
  if (args.printModel) process.stdout.write(`${requestedModel || artifacts.defaultModel}\n`);
  if (args.printAuth) process.stdout.write(`${artifacts.authRequired ? 'required' : 'none'}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    runCli();
  } catch (error) {
    console.error(`ERROR: ${error.message}`);
    process.exit(1);
  }
}
