#!/usr/bin/env node
'use strict';

import fs from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  canExposeCustomApplyPatch,
  canExposeHostedWebSearch,
  codexModelAlias,
  DEFAULT_UPSTREAM,
  normalizeConfig,
} from './config-core.mjs';

export { codexModelAlias, providerModelAlias } from './config-core.mjs';

export const CODEX_PROVIDER_ID = 'multi-provider-gateway';
export const CODEX_ENV_KEY = 'DEEPSEEK_GATEWAY_TOKEN';
const AUTH_MODES = new Set(['auto', 'required', 'none']);
const CATALOG_PROFILE = Object.freeze({
  PROXY_CHAT: 'proxy-chat',
  NATIVE_RESPONSES: 'native-responses',
});
const NEUTRAL_BASE_INSTRUCTIONS = [
  'You are Codex, a coding agent.',
  "You and the user share the same workspace and collaborate to achieve the user's goals.",
].join(' ');

const PROJECT_DIR = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = path.join(PROJECT_DIR, 'codex-models.json');
const NATIVE_RESPONSES_MODEL_TEMPLATE = {
  shell_type: 'shell_command',
  base_instructions: NEUTRAL_BASE_INSTRUCTIONS,
  default_reasoning_level: 'high',
  supported_reasoning_levels: [
    { effort: 'none', description: 'Disable Thinking' },
    { effort: 'high', description: 'Enabled Thinking' },
  ],
  supports_reasoning_summaries: true,
  default_reasoning_summary: 'none',
  support_verbosity: false,
  truncation_policy: { mode: 'bytes', limit: 10000 },
  supports_parallel_tool_calls: false,
  supports_image_detail_original: false,
  context_window: 128000,
  max_context_window: 128000,
  effective_context_window_percent: 95,
  experimental_supported_tools: [],
  input_modalities: ['text', 'image'],
  supports_search_tool: false,
};

const NEUTRAL_MODEL_TEMPLATE = {
  shell_type: 'shell_command',
  base_instructions: NEUTRAL_BASE_INSTRUCTIONS,
  prefer_websockets: false,
  support_verbosity: false,
  input_modalities: ['text'],
  supports_image_detail_original: false,
  truncation_policy: { mode: 'tokens', limit: 8192 },
  supports_parallel_tool_calls: false,
  context_window: 32768,
  max_context_window: 32768,
  effective_context_window_percent: 90,
  supported_reasoning_levels: [],
  experimental_supported_tools: [],
  supports_reasoning_summaries: false,
  supports_search_tool: false,
};

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

function catalogProfile(provider) {
  return provider.upstreamFormat === 'chat-completions'
    ? CATALOG_PROFILE.PROXY_CHAT
    : CATALOG_PROFILE.NATIVE_RESPONSES;
}

function usesOfficialDeepSeekCatalog(provider) {
  return provider.apiProfile === 'deepseek'
    && provider.upstreamFormat === 'responses'
    && new URL(provider.baseUrl).origin === new URL(DEFAULT_UPSTREAM).origin;
}

function hasInstructionSource(model) {
  return Boolean(
    String(model.base_instructions || '').trim()
    || String(model.model_messages?.instructions_template || '').trim(),
  );
}

function validateCatalogModel(model) {
  if (model.shell_type !== 'shell_command') {
    throw new Error(`Codex catalog model ${model.slug} must use shell_type shell_command`);
  }
  if (!hasInstructionSource(model)) {
    throw new Error(
      `Codex catalog model ${model.slug} requires base_instructions or model_messages.instructions_template`,
    );
  }
  if (typeof model.supports_reasoning_summaries !== 'boolean') {
    throw new Error(
      `Codex catalog model ${model.slug} requires supports_reasoning_summaries`,
    );
  }
  if (!Array.isArray(model.supported_reasoning_levels)) {
    throw new Error(`Codex catalog model ${model.slug} requires supported_reasoning_levels`);
  }
  if (
    model.default_reasoning_level !== undefined
    && !model.supported_reasoning_levels.some(
      level => level?.effort === model.default_reasoning_level,
    )
  ) {
    throw new Error(
      `Codex catalog model ${model.slug} has an unsupported default_reasoning_level`,
    );
  }
}

function applyCatalogProfile(
  catalogModel,
  provider,
  model,
  template,
  proxyTemplate,
  usesNeutralTemplate,
) {
  const profile = catalogProfile(provider);
  const genericNativeResponses = profile === CATALOG_PROFILE.NATIVE_RESPONSES
    && !usesOfficialDeepSeekCatalog(provider);
  if (genericNativeResponses) {
    catalogModel = structuredClone(NATIVE_RESPONSES_MODEL_TEMPLATE);
    const contextWindow = model.contextWindow ?? 128000;
    catalogModel.context_window = contextWindow;
    catalogModel.max_context_window = contextWindow;
    catalogModel.supports_parallel_tool_calls = model.supportsParallelToolCalls ?? false;
    catalogModel.base_instructions = model.baseInstructions || NEUTRAL_BASE_INSTRUCTIONS;
    catalogModel.additional_speed_tiers = [];
    catalogModel.service_tiers = [];
    catalogModel.availability_nux = null;
    catalogModel.upgrade = null;
  }
  catalogModel.shell_type = 'shell_command';
  if (typeof catalogModel.supports_reasoning_summaries !== 'boolean') {
    catalogModel.supports_reasoning_summaries = false;
  }
  if (model.reasoning) {
    catalogModel.supported_reasoning_levels = model.reasoning.levels.map(level => ({
      effort: level.effort,
      ...(level.description ? { description: level.description } : {}),
    }));
    catalogModel.default_reasoning_level = model.reasoning.default;
  } else if (!genericNativeResponses || model.reasoning === null) {
    catalogModel.supported_reasoning_levels = [];
    delete catalogModel.default_reasoning_level;
    if (model.reasoning === null) {
      catalogModel.supports_reasoning_summaries = false;
      delete catalogModel.default_reasoning_summary;
    }
  }

  if (profile === CATALOG_PROFILE.PROXY_CHAT) {
    delete catalogModel.web_search_tool_type;
    if (usesNeutralTemplate) {
      catalogModel.base_instructions = proxyTemplate.base_instructions
        || NEUTRAL_BASE_INSTRUCTIONS;
      if (proxyTemplate.model_messages) {
        catalogModel.model_messages = structuredClone(proxyTemplate.model_messages);
      }
    }
    catalogModel.apply_patch_tool_type = proxyTemplate.apply_patch_tool_type
      || catalogModel.apply_patch_tool_type
      || 'freeform';
  } else if (genericNativeResponses) {
    delete catalogModel.web_search_tool_type;
    catalogModel.base_instructions = model.baseInstructions || NEUTRAL_BASE_INSTRUCTIONS;
    delete catalogModel.apply_patch_tool_type;
    delete catalogModel.model_messages;
    delete catalogModel.tools;
    if (canExposeHostedWebSearch(provider, model)) {
      catalogModel.web_search_tool_type = template.web_search_tool_type || 'text';
    }
    if (canExposeCustomApplyPatch(provider, model)) {
      catalogModel.apply_patch_tool_type = template.apply_patch_tool_type || 'freeform';
    }
  } else {
    if (!canExposeHostedWebSearch(provider, model)) delete catalogModel.web_search_tool_type;
    if (!canExposeCustomApplyPatch(provider, model)) delete catalogModel.apply_patch_tool_type;
  }
  if (!hasInstructionSource(catalogModel)) {
    catalogModel.base_instructions = NEUTRAL_BASE_INSTRUCTIONS;
  }
  return catalogModel;
}

export function buildModelCatalog(config, options = {}) {
  config = normalizeCatalogConfig(config);
  const templates = loadTemplates();
  const bySlug = new Map(templates.map(model => [model.slug, model]));
  const proxyTemplate = templates[0];
  const models = [];
  const aliases = new Set();
  let priority = 1;

  for (const provider of config.providers) {
    if (!provider.enabled) continue;
    for (const model of provider.models) {
      const alias = codexModelAlias(provider.id, model.id);
      if (aliases.has(alias)) throw new Error(`duplicate model alias: ${alias}`);
      aliases.add(alias);
      const matchedTemplate = bySlug.get(model.upstreamModel);
      const template = matchedTemplate || NEUTRAL_MODEL_TEMPLATE;
      const catalogModel = applyCatalogProfile(
        structuredClone(template),
        provider,
        model,
        template,
        proxyTemplate,
        !matchedTemplate,
      );
      const outputModel = {
        ...catalogModel,
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
      };
      validateCatalogModel(outputModel);
      models.push(outputModel);
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
  const configToml = buildCodexToml({
    config,
    gatewayUrl,
    modelsPath,
    authRequired: requireAuth,
  });
  const catalogJson = `${JSON.stringify(catalog, null, 2)}\n`;
  const revision = createHash('sha256')
    .update(configToml)
    .update('\0')
    .update(catalogJson)
    .digest('hex');
  return {
    providerId: CODEX_PROVIDER_ID,
    revision,
    authRequired: requireAuth,
    envKey: requireAuth ? CODEX_ENV_KEY : null,
    defaultModel,
    gatewayUrl: gatewayApiUrl(gatewayUrl),
    modelsPath,
    configToml,
    catalog,
    catalogJson,
  };
}

function writeCatalogAtomic(outputPath, catalogJson) {
  const tempPath = `${outputPath}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(tempPath, catalogJson, { mode: 0o600, flag: 'wx' });
    fs.renameSync(tempPath, outputPath);
  } finally {
    fs.rmSync(tempPath, { force: true });
  }
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
    writeCatalogAtomic(args.catalogOutput, artifacts.catalogJson);
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
