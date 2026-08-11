'use strict';

import http from 'node:http';
import https from 'node:https';
import { getQuickJS } from 'quickjs-emscripten';

const MAX_SCRIPT_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_REQUEST_BODY_BYTES = 64 * 1024;
const MAX_RESULT_ITEMS = 16;
const SCRIPT_TIMEOUT_MS = 500;
const RUNTIME_MEMORY_BYTES = 8 * 1024 * 1024;
const RUNTIME_STACK_BYTES = 512 * 1024;
const FORBIDDEN_HEADERS = new Set([
  'connection',
  'content-length',
  'host',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

export const DEEPSEEK_BALANCE_SCRIPT = `({
  request: {
    url: "{{baseUrl}}/user/balance",
    method: "GET",
    headers: {
      "Authorization": "Bearer {{apiKey}}",
      "Accept": "application/json"
    }
  },
  extractor: function(response) {
    return (response.balance_infos || []).map(function(info) {
      return {
        planName: String(info.currency || ""),
        remaining: Number(info.total_balance),
        granted: Number(info.granted_balance),
        toppedUp: Number(info.topped_up_balance),
        unit: String(info.currency || ""),
        isValid: response.is_available !== false
      };
    });
  }
})`;

let quickJsPromise;

function quickJsModule() {
  if (!quickJsPromise) quickJsPromise = getQuickJS();
  return quickJsPromise;
}

function errorMessage(value) {
  if (value && typeof value === 'object') {
    const message = String(value.message || value.name || 'unknown script error');
    return message === 'interrupted' ? 'balance script execution timed out' : message;
  }
  return String(value || 'unknown script error');
}

async function evaluateJson(script, timeoutMs = SCRIPT_TIMEOUT_MS) {
  const QuickJS = await quickJsModule();
  const runtime = QuickJS.newRuntime();
  runtime.setMemoryLimit(RUNTIME_MEMORY_BYTES);
  runtime.setMaxStackSize(RUNTIME_STACK_BYTES);
  const deadline = Date.now() + Math.min(Math.max(timeoutMs, 10), SCRIPT_TIMEOUT_MS);
  runtime.setInterruptHandler(() => Date.now() > deadline);
  const context = runtime.newContext();
  try {
    const result = context.evalCode(script, 'balance-query.js');
    if (result.error) {
      const dumped = context.dump(result.error);
      result.error.dispose();
      throw new Error(errorMessage(dumped));
    }
    const dumped = context.dump(result.value);
    result.value.dispose();
    if (typeof dumped !== 'string') throw new Error('balance script did not return serializable JSON');
    try {
      return JSON.parse(dumped);
    } catch {
      throw new Error('balance script returned invalid JSON');
    }
  } finally {
    context.dispose();
    runtime.dispose();
  }
}

function scriptExpression(code) {
  if (typeof code !== 'string' || !code.trim()) throw new Error('balance script code is required');
  if (Buffer.byteLength(code, 'utf8') > MAX_SCRIPT_BYTES) {
    throw new Error(`balance script code must be at most ${MAX_SCRIPT_BYTES} bytes`);
  }
  return code.trim();
}

export async function evaluateBalanceRequest(query) {
  const code = scriptExpression(query?.code);
  return evaluateJson(`
    "use strict";
    (() => {
      const config = ${code};
      if (!config || typeof config !== "object") throw new Error("script must return a config object");
      if (!config.request || typeof config.request !== "object") throw new Error("script must define request");
      return JSON.stringify(config.request);
    })()
  `, query?.timeoutMs);
}

export async function extractBalanceResult(query, response) {
  const code = scriptExpression(query?.code);
  const responseJson = JSON.stringify(JSON.stringify(response));
  const result = await evaluateJson(`
    "use strict";
    (() => {
      const config = ${code};
      if (!config || typeof config.extractor !== "function") throw new Error("script must define extractor");
      const response = JSON.parse(${responseJson});
      return JSON.stringify(config.extractor(response));
    })()
  `, query?.timeoutMs);
  return normalizeQuotaResult(result);
}

function replaceTemplates(value, variables) {
  if (typeof value === 'string') {
    let output = value;
    for (const [name, replacement] of Object.entries(variables)) {
      output = output.split(`{{${name}}}`).join(replacement);
    }
    return output;
  }
  if (Array.isArray(value)) return value.map(item => replaceTemplates(item, variables));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replaceTemplates(item, variables)]));
  }
  return value;
}

function isLoopbackHostname(value) {
  const host = String(value || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host === '::1') return true;
  const octets = host.split('.');
  return octets.length === 4
    && octets[0] === '127'
    && octets.every(octet => /^\d{1,3}$/.test(octet) && Number(octet) <= 255);
}

function serializeBody(body) {
  if (body === undefined || body === null) return null;
  if (typeof body === 'string') return body;
  if (typeof body === 'object') return JSON.stringify(body);
  throw new Error('balance request body must be a string, object, or null');
}

export function materializeBalanceRequest(template, provider, key) {
  if (!template || typeof template !== 'object' || Array.isArray(template)) {
    throw new Error('balance script request must be an object');
  }
  const materialized = replaceTemplates(template, {
    apiKey: String(key.key),
    baseUrl: String(provider.baseUrl),
    keyName: String(key.name),
    providerId: String(provider.id),
  });
  const method = String(materialized.method || 'GET').toUpperCase();
  if (!['GET', 'POST'].includes(method)) throw new Error(`unsupported balance request method: ${method}`);

  let url;
  let baseUrl;
  try {
    url = new URL(String(materialized.url || ''));
    baseUrl = new URL(provider.baseUrl);
  } catch {
    throw new Error('balance request URL is invalid');
  }
  if (url.username || url.password || url.hash) {
    throw new Error('balance request URL must not contain credentials or a fragment');
  }
  if (url.origin !== baseUrl.origin) throw new Error('balance request URL must use the provider origin');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopbackHostname(url.hostname))) {
    throw new Error('balance request URL must use HTTPS unless it targets loopback');
  }

  const rawHeaders = materialized.headers ?? {};
  if (!rawHeaders || typeof rawHeaders !== 'object' || Array.isArray(rawHeaders)) {
    throw new Error('balance request headers must be an object');
  }
  const entries = Object.entries(rawHeaders);
  if (entries.length > 32) throw new Error('balance request must not contain more than 32 headers');
  const headers = {};
  for (const [name, rawValue] of entries) {
    const lower = name.toLowerCase();
    if (FORBIDDEN_HEADERS.has(lower)) throw new Error(`balance request header is not allowed: ${name}`);
    const value = String(rawValue);
    http.validateHeaderName(name);
    http.validateHeaderValue(name, value);
    headers[name] = value;
  }

  const body = serializeBody(materialized.body);
  if (method === 'GET' && body !== null) throw new Error('GET balance requests must not define a body');
  if (body !== null && Buffer.byteLength(body, 'utf8') > MAX_REQUEST_BODY_BYTES) {
    throw new Error(`balance request body must be at most ${MAX_REQUEST_BODY_BYTES} bytes`);
  }
  return { url, method, headers, body };
}

function readResponse(res) {
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
      if (size > MAX_RESPONSE_BYTES) {
        res.destroy();
        fail(new Error(`balance response exceeds ${MAX_RESPONSE_BYTES} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    res.on('error', fail);
    res.on('end', () => {
      if (settled) return;
      settled = true;
      const text = Buffer.concat(chunks).toString('utf8');
      if ((res.statusCode || 500) < 200 || (res.statusCode || 500) >= 300) {
        reject(new Error(`balance request failed with HTTP ${res.statusCode}`));
        return;
      }
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new Error('balance response is not valid JSON'));
      }
    });
  });
}

async function sendBalanceRequest(request, { timeoutMs, agent }) {
  const mod = request.url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    let settled = false;
    let deadlineTimer;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadlineTimer);
      callback(value);
    };
    const req = mod.request(request.url, {
      method: request.method,
      headers: request.headers,
      agent,
    }, res => readResponse(res).then(
      value => finish(resolve, value),
      error => finish(reject, error),
    ));
    deadlineTimer = setTimeout(
      () => req.destroy(new Error(`balance request timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    req.on('error', error => finish(reject, error));
    if (request.body !== null) req.write(request.body);
    req.end();
  });
}

function optionalString(value, field, maxLength) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.length > maxLength) {
    throw new Error(`${field} must be a string of at most ${maxLength} characters`);
  }
  return value;
}

function optionalNumber(value, field, { nonNegative = false } = {}) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || (nonNegative && value < 0)) {
    throw new Error(`${field} must be ${nonNegative ? 'a non-negative ' : 'a finite '}number`);
  }
  return value;
}

function normalizeQuotaItem(value, index) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`balance result item ${index} must be an object`);
  }
  const isValid = value.isValid === undefined || value.isValid === null ? true : value.isValid;
  if (typeof isValid !== 'boolean') throw new Error(`balance result item ${index} isValid must be boolean`);
  const item = {
    planName: optionalString(value.planName, `balance result item ${index} planName`, 100),
    extra: optionalString(value.extra, `balance result item ${index} extra`, 500),
    isValid,
    invalidMessage: optionalString(value.invalidMessage, `balance result item ${index} invalidMessage`, 300),
    total: optionalNumber(value.total, `balance result item ${index} total`, { nonNegative: true }),
    used: optionalNumber(value.used, `balance result item ${index} used`, { nonNegative: true }),
    remaining: optionalNumber(value.remaining, `balance result item ${index} remaining`),
    granted: optionalNumber(value.granted, `balance result item ${index} granted`, { nonNegative: true }),
    toppedUp: optionalNumber(value.toppedUp, `balance result item ${index} toppedUp`, { nonNegative: true }),
    unit: optionalString(value.unit, `balance result item ${index} unit`, 32),
  };
  if (item.remaining === null && item.used === null && item.total === null && isValid) {
    throw new Error(`balance result item ${index} must define remaining, used, or total`);
  }
  return Object.fromEntries(Object.entries(item).filter(([, itemValue]) => itemValue !== null));
}

export function normalizeQuotaResult(value) {
  const rawItems = Array.isArray(value) ? value : [value];
  if (!rawItems.length) throw new Error('balance script returned an empty array');
  if (rawItems.length > MAX_RESULT_ITEMS) {
    throw new Error(`balance script must not return more than ${MAX_RESULT_ITEMS} items`);
  }
  const items = rawItems.map((item, index) => normalizeQuotaItem(item, index));
  return {
    isAvailable: items.some(item => item.isValid !== false),
    items,
  };
}

export function isDeepSeekProvider(provider) {
  try {
    const hostname = new URL(provider.baseUrl).hostname.toLowerCase();
    return hostname === 'api.deepseek.com' || hostname.endsWith('.api.deepseek.com');
  } catch {
    return false;
  }
}

export function effectiveBalanceQuery(provider) {
  if (provider.balanceQuery) return provider.balanceQuery.enabled ? provider.balanceQuery : null;
  if (!isDeepSeekProvider(provider)) return null;
  return {
    enabled: true,
    language: 'javascript',
    code: DEEPSEEK_BALANCE_SCRIPT,
    timeoutMs: 10000,
  };
}

export async function executeBalanceQuery({ query, provider, key, agent, mockResponse }) {
  const template = await evaluateBalanceRequest(query);
  const request = materializeBalanceRequest(template, provider, key);
  const response = mockResponse === undefined
    ? await sendBalanceRequest(request, { timeoutMs: query.timeoutMs, agent })
    : mockResponse;
  return extractBalanceResult(query, response);
}
