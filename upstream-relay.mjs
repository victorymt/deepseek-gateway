'use strict';

import http from 'node:http';
import https from 'node:https';
import { PassThrough, Transform } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';

import {
  ChatCompletionsSseTransform,
  chatCompletionToResponses,
  chatCompletionToResponsesSse,
  chatCompletionsSseToResponses,
  normalizeChatCompletionsError,
  responsesRequestToChatCompletions,
} from './chat-completions-adapter.mjs';
import { normalizeAgentMessagesForUpstream } from './responses-request-normalizer.mjs';
import { normalizeBaseUrl } from './config-core.mjs';
import { inferModelCapabilities } from './model-capabilities.mjs';

const HOP_HEADERS = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'proxy-connection',
]);

function retryAfterSec(res) {
  const raw = res.headers['retry-after'] || res.headers['Retry-After'];
  if (!raw) return null;
  const n = parseInt(raw, 10);
  if (!Number.isNaN(n)) return n;
  const d = Date.parse(raw);
  return Number.isNaN(d) ? null : Math.max(1, Math.ceil((d - Date.now()) / 1000));
}
export function upstreamRequestUrl(baseUrl, requestUrl) {
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

export function normalizeModelFetchUrl(value, field = 'modelsUrl') {
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
    .replace(/[^a-z0-9._\/:+-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '')
    .slice(0, 63)
    .replace(/[^a-z0-9]+$/, '') || 'model';
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
        reject(Object.assign(
          new Error(`model endpoint returned HTTP ${res.statusCode}`),
          { statusCode: res.statusCode },
        ));
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
    const capabilities = inferModelCapabilities(
      upstreamModel,
      typeof entry === 'object' && entry ? entry : null,
    );
    models.push({
      id: modelDraftIdentifier(upstreamModel, used),
      name,
      upstreamModel,
      ownedBy,
      inputModalities: capabilities.inputModalities,
      ...(capabilities.reasoning ? {
        reasoning: structuredClone(capabilities.reasoning),
      } : {}),
      capabilitySource: capabilities.source,
    });
  }
  return models.sort((a, b) => a.upstreamModel.localeCompare(b.upstreamModel));
}

export async function fetchProviderModels(baseUrl, secret, modelsUrl = '') {
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

function rewriteResponsesRequestUrl(requestUrl) {
  const url = new URL(requestUrl || '/', 'http://gateway.local');
  if (url.pathname === '/v1/responses' || url.pathname === '/v1/responses/compact') {
    url.pathname = '/v1/chat/completions';
  } else if (url.pathname === '/responses' || url.pathname === '/responses/compact') {
    url.pathname = '/chat/completions';
  }
  return `${url.pathname}${url.search}`;
}

function contentHasImageInput(content) {
  if (!Array.isArray(content)) return false;
  return content.some(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
    if (item.type === 'input_image' || item.type === 'image_url') return true;
    return contentHasImageInput(item.content);
  });
}

function requestHasImageInput(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  const input = Array.isArray(payload.input) ? payload.input : [payload.input];
  if (contentHasImageInput(input)) return true;
  return Array.isArray(payload.messages)
    && payload.messages.some(message => contentHasImageInput(message?.content));
}

function prepareUpstreamRequest({
  body,
  payload,
  aliasRoute,
  model,
  runtime,
  requestUrl,
  isResponsesRequest,
}) {
  let preparedPayload = payload;
  let upstreamModel;
  if (aliasRoute) {
    upstreamModel = aliasRoute.model.upstreamModel;
    preparedPayload = { ...preparedPayload, model: upstreamModel };
  }

  const shouldAdapt = runtime.provider.upstreamFormat === 'chat-completions'
    && isResponsesRequest;
  if (shouldAdapt) {
    if (!preparedPayload) {
      throw Object.assign(new Error('Responses request body must be valid JSON'), { statusCode: 400 });
    }
    const adapted = responsesRequestToChatCompletions(preparedPayload, {
      reasoning: model?.reasoning,
      supportsPromptCacheKey: runtime.provider.supportsPromptCacheKey,
    });
    return {
      body: Buffer.from(JSON.stringify(adapted.payload)),
      upstreamModel,
      upstreamRequestPath: rewriteResponsesRequestUrl(requestUrl),
      responseAdapter: {
        type: 'chat-completions',
        context: adapted.context,
        stream: adapted.payload.stream === true,
      },
    };
  }

  if (
    preparedPayload
    && isResponsesRequest
    && !runtime.provider.supportsEncryptedAgentMessages
  ) {
    preparedPayload = normalizeAgentMessagesForUpstream(preparedPayload);
  }

  return {
    body: preparedPayload === payload
      ? body
      : Buffer.from(JSON.stringify(preparedPayload)),
    upstreamModel,
    upstreamRequestPath: requestUrl,
    responseAdapter: null,
  };
}

export function resolveRequestRoute(registry, body, requestUrl) {
  if (registry.settings.setupPending) {
    throw Object.assign(new Error('gateway setup required'), { statusCode: 503 });
  }
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
  if (!aliasRoute && (
    requestedModel.includes('--')
    || /^[A-Z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9._\/:+-]*$/.test(requestedModel)
  )) {
    throw Object.assign(new Error(`unknown or disabled model alias: ${requestedModel}`), { statusCode: 400 });
  }
  const runtime = aliasRoute?.runtime || registry.getDefault();
  if (!runtime || !runtime.provider.enabled) {
    throw Object.assign(new Error('default provider is unavailable'), { statusCode: 503 });
  }
  const configuredModel = aliasRoute?.model
    || runtime.provider.models.find(model => (
      model.upstreamModel === requestedModel || model.id === requestedModel
    ))
    || registry.resolveAlias(registry.settings.defaultModel)?.model
    || runtime.provider.models[0];
  if (
    parsed
    && runtime.provider.upstreamFormat === 'chat-completions'
    && requestHasImageInput(parsed)
    && !configuredModel.inputModalities.includes('image')
  ) {
    const modelName = requestedModel || registry.settings.defaultModel || configuredModel.id;
    throw Object.assign(
      new Error(`model ${modelName} does not support image input`),
      { statusCode: 400 },
    );
  }
  const pathname = new URL(requestUrl || '/', 'http://gateway.local').pathname;
  const isResponsesRequest = [
    '/v1/responses',
    '/responses',
    '/v1/responses/compact',
    '/responses/compact',
  ].includes(pathname);
  const prepared = prepareUpstreamRequest({
    body,
    payload: parsed,
    aliasRoute,
    model: configuredModel,
    runtime,
    requestUrl,
    isResponsesRequest,
  });

  return {
    runtime,
    body: prepared.body,
    clientPath: pathname,
    requestedModel,
    gatewayModel: requestedModel || registry.settings.defaultModel,
    ...(prepared.upstreamModel ? { upstreamModel: prepared.upstreamModel } : {}),
    upstreamRequestPath: prepared.upstreamRequestPath,
    responseAdapter: prepared.responseAdapter,
  };
}

async function forwardOnce(runtime, key, clientReq, route, signal) {
  const { settings } = runtime;
  const { body } = route;
  if (settings.mock) return mockResponse(key, body, route.responseAdapter?.type, signal);
  const u = upstreamRequestUrl(runtime.provider.baseUrl, route.upstreamRequestPath || clientReq.url);
  const headers = {};
  for (const [h, v] of Object.entries(clientReq.headers)) {
    if (
      HOP_HEADERS.has(h)
      || h === 'host'
      || h === 'authorization'
      || h === 'cookie'
      || h === 'content-length'
      || (route.decodedRequestBody && h === 'content-encoding')
    ) continue;
    headers[h] = Array.isArray(v) ? v.join(', ') : v;
  }
  headers.authorization = `Bearer ${key.key}`;
  headers.host = u.host;
  headers['accept-encoding'] = 'identity';
  if (body.length) headers['content-length'] = body.length;
  return new Promise((resolve, reject) => {
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(u, {
      method: clientReq.method,
      headers,
      agent: runtime.agent,
      signal,
    }, res => resolve(res));
    if (settings.timeoutMs) req.setTimeout(settings.timeoutMs, () => req.destroy(new Error(`upstream timeout after ${settings.timeoutMs}ms`)));
    req.on('error', reject);
    req.end(body);
  });
}

async function requestUpstream(runtime, clientReq, route, signal) {
  const { pool, settings } = runtime;
  const enabledKeyCount = pool.keys.filter(key => key.enabled).length;
  const maxRetries = Math.min(settings.maxRetries, enabledKeyCount - 1);
  const attempted = [];
  let lastErr = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const key = pool.pickKey(attempted);
    if (!key) {
      lastErr = new Error('no keys available');
      break;
    }
    attempted.push(key.name);
    key.inFlight++;
    try {
      const response = await forwardOnce(runtime, key, clientReq, route, signal);
      const status = response.statusCode;
      if (status < 400) return { response, key, preRecorded: false, lastErr };
      const retryAfter = retryAfterSec(response);
      pool.recordResult(key, { status, retryAfterSec: retryAfter });
      const retryable = status === 429 || status === 401 || status === 402 || status >= 500;
      if (retryable && attempt < maxRetries) {
        response.resume();
        response.on('error', () => {});
        continue;
      }
      return { response, key, preRecorded: true, lastErr };
    } catch (error) {
      const aborted = signal?.aborted;
      pool.recordResult(key, aborted ? { clientAbort: true } : { networkError: true });
      lastErr = error;
      if (aborted || attempt >= maxRetries) break;
    }
  }
  return { response: null, key: null, preRecorded: true, lastErr };
}

function routeLogContext(route, status, latencyMs) {
  return {
    status,
    method: route.method,
    route: route.clientPath,
    provider: route.runtime.provider.id,
    model: route.gatewayModel,
    latencyMs,
  };
}

export async function relay(route, clientReq, clientRes, log) {
  const { runtime, body } = route;
  const { pool, provider } = runtime;
  const started = Date.now();
  runtime.retain();
  const abortController = new AbortController();
  const abortUpstream = () => {
    if (!clientRes.writableEnded) abortController.abort();
  };
  clientRes.once('close', abortUpstream);
  let released = false;
  const releaseRuntime = () => {
    if (released) return;
    released = true;
    runtime.release();
  };
  try {
    const {
      response: res,
      key,
      preRecorded,
      lastErr,
    } = await requestUpstream(runtime, clientReq, route, abortController.signal);
    const ms = Date.now() - started;
    if (!res) {
      if (abortController.signal.aborted || clientRes.destroyed) {
        releaseRuntime();
        return;
      }
      log(
        `502 ${clientReq.method} ${clientReq.url} provider=${provider.id} model=${route.gatewayModel} all-keys-failed ${ms}ms`,
        routeLogContext({ ...route, method: clientReq.method }, 502, ms),
      );
      clientRes.writeHead(502, { 'content-type': 'application/json' });
      clientRes.end(JSON.stringify({ error: { message: lastErr ? lastErr.message : 'all upstream keys failed' } }));
      releaseRuntime();
      return;
    }
    log(
      `${res.statusCode} ${clientReq.method} ${clientReq.url} provider=${provider.id} model=${route.gatewayModel} key=${key.name} ${ms}ms`,
      routeLogContext({ ...route, method: clientReq.method }, res.statusCode, ms),
    );
    await relayResponse(clientRes, res, key, pool, preRecorded, route, releaseRuntime);
  } catch (error) {
    releaseRuntime();
    throw error;
  } finally {
    clientRes.off('close', abortUpstream);
  }
}

function responseHeaders(upRes, key, route, { transformed = false, contentType = '' } = {}) {
  const headers = {};
  for (const [h, v] of Object.entries(upRes.headers)) {
    if (HOP_HEADERS.has(h)) continue;
    if (transformed && ['content-length', 'content-encoding', 'content-md5', 'etag'].includes(h)) continue;
    headers[h] = Array.isArray(v) ? v.join(', ') : v;
  }
  if (contentType) headers['content-type'] = contentType;
  headers['x-gateway-key'] = key.name;
  headers['x-gateway-provider'] = route.runtime.provider.id;
  headers['x-gateway-model'] = route.gatewayModel;
  return headers;
}

function readUpstreamBody(upRes, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const fail = error => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    upRes.on('data', chunk => {
      if (settled) return;
      size += chunk.length;
      if (maxBytes && size > maxBytes) {
        const error = new Error('upstream response body too large');
        fail(error);
        upRes.destroy(error);
        return;
      }
      chunks.push(chunk);
    });
    upRes.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });
    upRes.on('error', fail);
    upRes.on('aborted', () => fail(new Error('upstream response aborted')));
  });
}

async function relayAdaptedResponse(clientRes, upRes, key, pool, route, finish) {
  const adapter = route.responseAdapter;
  const contentType = String(upRes.headers['content-type'] || '').toLowerCase();
  const isSse = contentType.includes('text/event-stream');

  if (upRes.statusCode >= 400) {
    try {
      const body = await readUpstreamBody(upRes, route.runtime.settings.maxBodyBytes);
      let payload;
      try { payload = JSON.parse(body.toString('utf8')); } catch { payload = body.toString('utf8'); }
      const output = Buffer.from(JSON.stringify(normalizeChatCompletionsError(payload, upRes.statusCode)));
      const headers = responseHeaders(upRes, key, route, {
        transformed: true,
        contentType: 'application/json; charset=utf-8',
      });
      headers['content-length'] = output.length;
      clientRes.writeHead(upRes.statusCode, headers);
      clientRes.end(output);
      finish({ status: upRes.statusCode });
    } catch {
      finish({ networkError: true });
      if (!clientRes.headersSent) clientRes.writeHead(502, { 'content-type': 'application/json' });
      if (!clientRes.writableEnded) {
        clientRes.end(JSON.stringify({ error: { message: 'failed to read upstream error response' } }));
      }
    }
    return;
  }

  if (adapter.stream && isSse) {
    const headers = responseHeaders(upRes, key, route, {
      transformed: true,
      contentType: 'text/event-stream; charset=utf-8',
    });
    headers['cache-control'] = 'no-cache';
    clientRes.writeHead(upRes.statusCode, headers);
    const transformer = new ChatCompletionsSseTransform(adapter.context, {
      onUsage: usage => pool.recordTokens(usage?.total_tokens, route.gatewayModel),
    });
    let upstreamFailed = false;
    const failStream = (message, type) => {
      if (upstreamFailed) return;
      upstreamFailed = true;
      upRes.unpipe?.(transformer);
      transformer.fail(message, type);
      transformer.end();
    };
    upRes.on('error', error => failStream(`Upstream stream error: ${error.message}`, 'stream_error'));
    upRes.on('aborted', () => failStream('Upstream Chat Completions stream was aborted', 'stream_aborted'));
    transformer.on('error', () => {
      finish({ networkError: true });
      if (!clientRes.writableEnded) clientRes.destroy();
    });
    transformer.on('end', () => {
      finish(upstreamFailed || transformer.state.terminal === 'failed' ? { networkError: true } : { status: 200 });
    });
    upRes.pipe(transformer).pipe(clientRes);
    clientRes.on('close', () => {
      if (!clientRes.writableEnded) {
        upstreamFailed = true;
        finish({ clientAbort: true });
        upRes.destroy();
        transformer.destroy();
      }
    });
    return;
  }

  try {
    const body = await readUpstreamBody(upRes, route.runtime.settings.maxBodyBytes);
    let converted;
    let usage;
    if (isSse) {
      const result = chatCompletionsSseToResponses(body.toString('utf8'), adapter.context);
      converted = result.response;
      usage = result.usage;
    } else {
      const payload = JSON.parse(body.toString('utf8'));
      if (adapter.stream) {
        const result = chatCompletionToResponsesSse(payload, adapter.context);
        pool.recordTokens(result.usage?.total_tokens, route.gatewayModel);
        const output = Buffer.from(result.body);
        const headers = responseHeaders(upRes, key, route, {
          transformed: true,
          contentType: 'text/event-stream; charset=utf-8',
        });
        headers['cache-control'] = 'no-cache';
        headers['content-length'] = output.length;
        clientRes.writeHead(upRes.statusCode, headers);
        clientRes.end(output);
        finish({ status: 200 });
        return;
      }
      converted = chatCompletionToResponses(payload, adapter.context);
      usage = converted.usage;
    }
    pool.recordTokens(usage?.total_tokens, route.gatewayModel);
    const output = Buffer.from(JSON.stringify(converted));
    const headers = responseHeaders(upRes, key, route, {
      transformed: true,
      contentType: 'application/json; charset=utf-8',
    });
    headers['content-length'] = output.length;
    clientRes.writeHead(upRes.statusCode, headers);
    clientRes.end(output);
    finish({ status: 200 });
  } catch (error) {
    const clientAbort = clientRes.destroyed && !clientRes.writableEnded;
    finish(clientAbort ? { clientAbort: true } : { networkError: true });
    if (clientAbort) return;
    if (!clientRes.headersSent) {
      clientRes.writeHead(error.statusCode || 502, { 'content-type': 'application/json' });
    }
    if (!clientRes.writableEnded) {
      clientRes.end(JSON.stringify(normalizeChatCompletionsError({
        message: error.message,
        type: 'upstream_error',
      }, error.statusCode || 502)));
    }
  }
}

function streamProtocolForRoute(route, contentType) {
  if (!contentType.includes('text/event-stream')) return '';
  if (['/v1/responses', '/responses'].includes(route.clientPath)) return 'responses';
  if (['/v1/chat/completions', '/chat/completions'].includes(route.clientPath)) return 'chat-completions';
  return '';
}

function parseSseBlock(block) {
  let event = '';
  const data = [];
  for (const rawLine of block.split('\n')) {
    if (!rawLine || rawLine.startsWith(':')) continue;
    const separator = rawLine.indexOf(':');
    const field = separator < 0 ? rawLine : rawLine.slice(0, separator);
    let value = separator < 0 ? '' : rawLine.slice(separator + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    if (field === 'data') data.push(value);
  }
  return { event, data: data.join('\n') };
}

function createUsageTracker(pool, protocol = '', model = '') {
  const maxTrackedEventChars = 16 * 1024 * 1024;
  const maxRawUsageChars = 1024 * 1024;
  const decoder = new StringDecoder('utf8');
  let eventChunks = [];
  let eventChars = 0;
  let eventBufferOverflow = false;
  let previousWasNewline = false;
  let pendingCarriageReturn = false;
  let rawBuffer = '';
  let rawBufferTruncated = false;
  let latestTotalTokens;

  const recordPayloadUsage = payload => {
    const totalTokens = payload?.usage?.total_tokens
      ?? payload?.response?.usage?.total_tokens;
    if (Number.isFinite(Number(totalTokens))) latestTotalTokens = Number(totalTokens);
  };

  const processBlock = block => {
    if (!block.trim()) return;
    const { event, data } = parseSseBlock(block);
    if (!event && !data) return;

    let payload;
    if (data && data.trim() !== '[DONE]') {
      try { payload = JSON.parse(data); } catch {}
    }
    recordPayloadUsage(payload);

    if (protocol === 'chat-completions' && data.trim() === '[DONE]') {
      tracker.protocolTerminal = 'completed';
      return;
    }
    if (protocol !== 'responses') return;
    const payloadType = typeof payload?.type === 'string' ? payload.type : '';
    const type = event || payloadType;
    if (!payload || !payloadType || (event && event !== payloadType)) return;
    const expectedResponseStatus = {
      'response.completed': 'completed',
      'response.incomplete': 'incomplete',
      'response.failed': 'failed',
    }[type];
    if (
      expectedResponseStatus
      && payload.response?.status !== expectedResponseStatus
    ) {
      return;
    }
    if (['response.completed', 'response.incomplete'].includes(type)) {
      tracker.protocolTerminal = type.slice('response.'.length);
    } else if (type === 'response.failed' || type === 'error') {
      tracker.protocolTerminal = 'failed';
    }
  };

  const normalizeEventLineEndings = (decoded, flush = false) => {
    let normalized = decoded;
    if (pendingCarriageReturn) {
      if (normalized.startsWith('\n')) normalized = normalized.slice(1);
      normalized = `\n${normalized}`;
      pendingCarriageReturn = false;
    }
    if (normalized.endsWith('\r')) {
      normalized = normalized.slice(0, -1);
      pendingCarriageReturn = true;
    }
    normalized = normalized.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    if (flush && pendingCarriageReturn) {
      normalized += '\n';
      pendingCarriageReturn = false;
    }
    return normalized;
  };

  const appendEventText = decoded => {
    const appendFragment = fragment => {
      if (!fragment || eventBufferOverflow) return;
      if (eventChars + fragment.length > maxTrackedEventChars) {
        eventBufferOverflow = true;
        eventChunks = [];
        eventChars = 0;
        return;
      }
      eventChunks.push(fragment);
      eventChars += fragment.length;
    };
    const finishEvent = () => {
      if (!eventBufferOverflow && eventChars) {
        processBlock(eventChunks.join(''));
      }
      eventChunks = [];
      eventChars = 0;
      eventBufferOverflow = false;
    };

    let offset = 0;
    for (;;) {
      const newline = decoded.indexOf('\n', offset);
      if (newline < 0) {
        const fragment = decoded.slice(offset);
        if (fragment) {
          appendFragment(fragment);
          previousWasNewline = false;
        }
        return;
      }
      const fragment = decoded.slice(offset, newline);
      if (fragment) {
        appendFragment(fragment);
        previousWasNewline = false;
      }
      if (previousWasNewline) {
        finishEvent();
        previousWasNewline = false;
      } else {
        appendFragment('\n');
        previousWasNewline = true;
      }
      offset = newline + 1;
    }
  };

  const tracker = new Transform({
    transform(chunk, enc, cb) {
      const decoded = decoder.write(chunk);
      if (protocol) {
        appendEventText(normalizeEventLineEndings(decoded));
      } else {
        rawBuffer += decoded;
        if (rawBuffer.length > maxRawUsageChars) {
          rawBufferTruncated = true;
          rawBuffer = rawBuffer.slice(-maxRawUsageChars);
        }
      }
      cb(null, chunk);
    },
    flush(cb) {
      const decoded = decoder.end();
      if (protocol) {
        appendEventText(normalizeEventLineEndings(decoded, true));
        if (!eventBufferOverflow && eventChars) processBlock(eventChunks.join(''));
      } else {
        rawBuffer += decoded;
        if (!rawBufferTruncated) {
          try { recordPayloadUsage(JSON.parse(rawBuffer)); } catch {}
        }
        if (latestTotalTokens === undefined) {
          const matches = [...rawBuffer.matchAll(/"total_tokens"\s*:\s*(\d+)/g)];
          if (matches.length) latestTotalTokens = Number(matches.at(-1)[1]);
        }
      }
      if (latestTotalTokens !== undefined) pool.recordTokens(latestTotalTokens, model);
      cb();
    },
  });
  tracker.protocolTerminal = '';
  return tracker;
}

async function relayResponse(clientRes, upRes, key, pool, preRecorded, route, releaseRuntime) {
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
  if (route.responseAdapter?.type === 'chat-completions') {
    await relayAdaptedResponse(clientRes, upRes, key, pool, route, finish);
    return;
  }
  const headers = responseHeaders(upRes, key, route);
  clientRes.writeHead(upRes.statusCode, headers);
  const contentType = String(upRes.headers['content-type'] || '').toLowerCase();
  const streamProtocol = streamProtocolForRoute(route, contentType);
  const tracker = createUsageTracker(pool, streamProtocol, route.gatewayModel);
  tracker.on('end', () => {
    if (streamProtocol && !tracker.protocolTerminal) {
      finish({ networkError: true });
      if (!clientRes.writableEnded) clientRes.destroy();
      return;
    }
    finish(tracker.protocolTerminal === 'failed' ? { networkError: true } : { status: 200 });
  });
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

function mockResponse(key, body, responseAdapter = '', signal) {
  return new Promise((resolve, reject) => {
    let behavior = 'ok';
    const parts = String(key.key).split('-');
    const suffix = parts[parts.length - 1];
    if (['429', '500', '401', '402', '403', 'slow', 'drip', 'abort'].includes(suffix)) behavior = suffix;
    let bodyObj = {};
    try { bodyObj = JSON.parse(body.toString('utf8') || '{}'); } catch {}
    const model = bodyObj.model || 'deepseek-v4-flash';
    const stream = !!bodyObj.stream;
    const delay = behavior === 'slow' ? 400 : 30;
    let timer;
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason || new Error('client aborted'));
    };
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      const statusMap = { 429: 429, 500: 500, 401: 401, 402: 402, 403: 403 };
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
      const frames = responseAdapter === 'chat-completions'
        ? [
            JSON.stringify({
              id: 'chatcmpl-mock', object: 'chat.completion.chunk', model,
              choices: [{ index: 0, delta: { role: 'assistant', content: 'hello' }, finish_reason: null }],
            }),
            JSON.stringify({
              id: 'chatcmpl-mock', object: 'chat.completion.chunk', model,
              choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            }),
            JSON.stringify({
              id: 'chatcmpl-mock', object: 'chat.completion.chunk', model,
              choices: [], usage: { prompt_tokens: 5, completion_tokens: 10, total_tokens: 15 },
            }),
          ]
        : [
            JSON.stringify({ type: 'response.output_item.added', gateway_key_name: key.name }),
            JSON.stringify({ type: 'response.output_text.delta', delta: 'hello' }),
            JSON.stringify({
              type: 'response.completed',
              response: {
                status: 'completed',
                usage: { prompt_tokens: 5, completion_tokens: 10, total_tokens: 15 },
              },
            }),
          ];
      const writeAll = () => {
        if (stream && status === 200) {
          pt.write(frames.map(f => `data: ${f}\n\n`).join('') + 'data: [DONE]\n\n');
        } else if (status === 200) {
          pt.write(JSON.stringify({
            id: 'mock-1', object: 'chat.completion', model,
            gateway_key_name: key.name,
            choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'hello' } }],
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
            pt.end('data: [DONE]\n\n');
          }
        }, 60);
        pt.on('close', () => clearInterval(iv));
      } else if (behavior === 'abort' && stream) {
        const first = responseAdapter === 'chat-completions'
          ? JSON.stringify({ id: 'chatcmpl-abort', model, choices: [{ delta: { content: 'partial' } }] })
          : JSON.stringify({ type: 'response.output_item.added', gateway_key_name: key.name });
        pt.write(`data: ${first}\n\n`);
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
