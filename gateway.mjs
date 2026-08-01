#!/usr/bin/env node
'use strict';

import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import { URL } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Transform } from 'node:stream';

const VERSION = '1.0.0';
const DEFAULT_UPSTREAM = 'https://api.deepseek.com';
const HOP_HEADERS = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'proxy-connection',
]);
const SESSION_SECRET = crypto.randomBytes(32).toString('hex');
const COOKIE_NAME = 'dsgw';
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

function secureEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

function sessionCookie(token) {
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const expiry = Date.now() + SESSION_TTL_MS;
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(`${tokenHash}:${expiry}`).digest('hex');
  return `v1.${expiry}.${sig}`;
}

function cookieValid(cookie, token) {
  const m = /^v1\.(\d+)\.([0-9a-f]{64})$/.exec(cookie || '');
  if (!m) return false;
  const expiry = Number(m[1]);
  if (!Number.isFinite(expiry) || expiry < Date.now()) return false;
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(`${tokenHash}:${expiry}`).digest('hex');
  return secureEqual(Buffer.from(expected, 'hex'), Buffer.from(m[2], 'hex'));
}

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

const USAGE = `deepseek-gateway v${VERSION}

Usage: node gateway.mjs [options]

Options:
  --config <path>       config JSON file (default: ./keys.json, then ~/.deepseek-gateway/keys.json)
  --keys <list>         comma-separated keys, format: "sk-xxx" or "name=sk-xxx"
  --port <n>            listen port (default 8787)
  --host <addr>         listen host (default 127.0.0.1)
  --upstream <url>      upstream base URL (default https://api.deepseek.com)
  --token <t>           require Authorization: Bearer <t> on gateway requests
  --cooldown-ms <n>     429/5xx cooldown duration (default 60000)
  --breaker <n>         consecutive failures to open circuit (default 5)
  --max-retries <n>     failover attempts per request (default 2)
  --max-body-bytes <n>  max request body size in bytes (default 67108864)
  --mock                act as a fake upstream (key suffix ok/429/500/401/slow)
  --quiet               suppress request logging
  --help                show this help

Env vars: DEEPSEEK_KEYS, DS_GATEWAY_PORT, DS_UPSTREAM, DS_GATEWAY_TOKEN,
DS_GATEWAY_CONFIG, DS_COOLDOWN_MS, DS_BREAKER, DS_MAX_RETRIES, DS_MAX_BODY_BYTES

Endpoints: / proxy (chat/completions, responses, any path), /health JSON,
/ dashboard (browser login via /login when token is set), /login, /logout`;

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--port': opts.port = Number(argv[++i]); break;
      case '--host': opts.host = argv[++i]; break;
      case '--upstream': opts.upstream = argv[++i]; break;
      case '--keys': opts.keys = argv[++i]; break;
      case '--config': opts.config = argv[++i]; break;
      case '--token': opts.token = argv[++i]; break;
      case '--mock': opts.mock = true; break;
      case '--quiet': opts.quiet = true; break;
      case '--cooldown-ms': opts.cooldownMs = Number(argv[++i]); break;
      case '--breaker': opts.breakerThreshold = Number(argv[++i]); break;
      case '--max-retries': opts.maxRetries = Number(argv[++i]); break;
      case '--max-body-bytes': opts.maxBodyBytes = Number(argv[++i]); break;
      case '--help':
      case '-h': opts.help = true; break;
      default:
        if (a.startsWith('-')) { console.error(`unknown option: ${a}`); opts.help = true; }
        else opts.positional = a;
    }
  }
  return opts;
}

function configCandidates() {
  return ['./keys.json', path.join(os.homedir(), '.deepseek-gateway', 'keys.json')];
}

function splitKeyToken(token) {
  token = token.trim();
  if (!token) return null;
  if (/^sk-/i.test(token)) return { name: null, secret: token };
  const eq = token.indexOf('=');
  const colon = token.indexOf(':');
  let name = null;
  let secret = token;
  if (eq > 0) { name = token.slice(0, eq); secret = token.slice(eq + 1); }
  else if (colon > 0) { name = token.slice(0, colon); secret = token.slice(colon + 1); }
  return { name, secret };
}

function loadConfig(opts) {
  const cfg = {
    port: 8787,
    host: '127.0.0.1',
    upstream: DEFAULT_UPSTREAM,
    cooldownMs: 60000,
    breakerThreshold: 5,
    maxRetries: 2,
    timeoutMs: 0,
    maxBodyBytes: 64 * 1024 * 1024,
    token: '',
    mock: false,
    keys: [],
  };
  const configPath = opts.config || process.env.DS_GATEWAY_CONFIG || configCandidates().find(p => fs.existsSync(p));
  if (configPath) {
    try {
      const fileCfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      Object.assign(cfg, fileCfg);
    } catch (err) {
      console.error(`failed to read config ${configPath}: ${err.message}`);
      process.exit(1);
    }
  }
  const addKey = (name, secret, weight) => {
    if (!secret) return;
    cfg.keys.push({ name: name || `key-${cfg.keys.length + 1}`, key: secret, weight: weight || 1 });
  };
  const fileKeys = cfg.keys || [];
  cfg.keys = [];
  fileKeys.forEach(k => addKey(k.name, k.key, k.weight));
  if (process.env.DEEPSEEK_KEYS) process.env.DEEPSEEK_KEYS.split(',').forEach(t => { const p = splitKeyToken(t); if (p) addKey(p.name, p.secret); });
  if (opts.keys) opts.keys.split(',').forEach(t => { const p = splitKeyToken(t); if (p) addKey(p.name, p.secret); });
  if (process.env.DS_GATEWAY_PORT) cfg.port = Number(process.env.DS_GATEWAY_PORT);
  if (opts.port !== undefined) cfg.port = opts.port;
  if (process.env.DS_UPSTREAM) cfg.upstream = process.env.DS_UPSTREAM;
  if (opts.upstream) cfg.upstream = opts.upstream;
  if (process.env.DS_GATEWAY_TOKEN) cfg.token = process.env.DS_GATEWAY_TOKEN;
  if (opts.token) cfg.token = opts.token;
  if (process.env.DS_COOLDOWN_MS) cfg.cooldownMs = Number(process.env.DS_COOLDOWN_MS);
  if (opts.cooldownMs !== undefined) cfg.cooldownMs = opts.cooldownMs;
  if (process.env.DS_BREAKER) cfg.breakerThreshold = Number(process.env.DS_BREAKER);
  if (opts.breakerThreshold !== undefined) cfg.breakerThreshold = opts.breakerThreshold;
  if (process.env.DS_MAX_RETRIES) cfg.maxRetries = Number(process.env.DS_MAX_RETRIES);
  if (opts.maxRetries !== undefined) cfg.maxRetries = opts.maxRetries;
  if (process.env.DS_MAX_BODY_BYTES) cfg.maxBodyBytes = Number(process.env.DS_MAX_BODY_BYTES);
  if (opts.maxBodyBytes !== undefined) cfg.maxBodyBytes = opts.maxBodyBytes;
  if (opts.host) cfg.host = opts.host;
  cfg.mock = !!opts.mock;
  if (cfg.mock && !cfg.keys.length) cfg.keys = [{ name: 'mock', key: 'sk-mock-ok', weight: 1 }];
  if (!cfg.mock) cfg.agent = new https.Agent({ keepAlive: true, maxSockets: 64 });
  return cfg;
}

class KeyPool {
  constructor(keys, cfg) {
    this.keys = keys.map(k => ({ ...k, inFlight: 0, success: 0, errors: 0, ratelimited: 0, consecutiveFailures: 0, invalid: false, throttleUntil: 0, lastUsed: 0, lastError: '' }));
    this.cursor = 0;
    this.cooldownMs = cfg.cooldownMs;
    this.breakerThreshold = cfg.breakerThreshold;
    this.total = { requests: 0, success: 0, errors: 0, ratelimited: 0, tokens: 0 };
    this._usageBuf = '';
  }

  pickKey(exclude = []) {
    const now = Date.now();
    const avail = this.keys.filter(k => !exclude.includes(k.name) && !k.invalid && now >= k.throttleUntil);
    let candidates;
    if (avail.length) {
      candidates = avail;
    } else {
      candidates = this.keys
        .filter(k => !exclude.includes(k.name) && !k.invalid)
        .sort((a, b) => (a.consecutiveFailures - b.consecutiveFailures) || (a.throttleUntil - b.throttleUntil));
      return candidates.length ? candidates[0] : null;
    }
    let best = null;
    let bestScore = Infinity;
    let bestDist = Infinity;
    const n = this.keys.length;
    for (let i = 0; i < candidates.length; i++) {
      const k = candidates[i];
      const idx = this.keys.indexOf(k);
      const score = k.inFlight / (k.weight || 1);
      const dist = (idx - this.cursor + n) % n;
      if (score < bestScore || (score === bestScore && dist < bestDist)) {
        best = k;
        bestScore = score;
        bestDist = dist;
      }
    }
    this.cursor = (this.keys.indexOf(best) + 1) % n;
    return best;
  }

  openCircuit(key) {
    key.throttleUntil = Date.now() + this.cooldownMs;
    key.consecutiveFailures = 0;
    key.lastError = 'circuit open';
  }

  recordResult(key, r) {
    key.inFlight = Math.max(0, key.inFlight - 1);
    this.total.requests++;
    key.lastUsed = Date.now();
    if (r.clientAbort) {
      key.errors++;
      this.total.errors++;
      key.lastError = 'client aborted';
      return;
    }
    if (r.networkError) {
      key.errors++;
      this.total.errors++;
      key.consecutiveFailures++;
      key.lastError = 'network error';
      if (key.consecutiveFailures >= this.breakerThreshold) this.openCircuit(key);
      return;
    }
    const s = r.status;
    if (s < 400) {
      key.success++;
      this.total.success++;
      key.consecutiveFailures = 0;
      key.throttleUntil = 0;
      key.lastError = '';
      return;
    }
    key.errors++;
    this.total.errors++;
    if (s === 429) {
      key.ratelimited++;
      this.total.ratelimited++;
      key.throttleUntil = Date.now() + (r.retryAfterSec ? r.retryAfterSec * 1000 : this.cooldownMs);
      key.consecutiveFailures = 0;
      key.lastError = '429 rate limited';
    } else if (s === 401 || s === 403) {
      key.invalid = true;
      key.lastError = `${s} invalid key`;
    } else if (s >= 500) {
      key.consecutiveFailures++;
      key.lastError = `http ${s}`;
      if (key.consecutiveFailures >= this.breakerThreshold) this.openCircuit(key);
    }
  }

  trackTokens(chunk) {
    const s = chunk.toString('utf8');
    const prevLen = this._usageBuf.length;
    this._usageBuf = (this._usageBuf + s).slice(-16384);
    const re = /"total_tokens"\s*:\s*(\d+)/g;
    re.lastIndex = Math.max(0, this._usageBuf.length - s.length);
    let m;
    while ((m = re.exec(this._usageBuf)) !== null) this.total.tokens += Number(m[1]);
  }

  state(key) {
    if (key.invalid) return 'invalid';
    if (key.throttleUntil > Date.now()) return key.lastError === 'circuit open' ? 'circuit-open' : 'cooldown';
    return 'healthy';
  }

  stats() {
    const now = Date.now();
    return {
      total: { ...this.total },
      keys: this.keys.map(k => ({
        name: k.name,
        state: this.state(k),
        weight: k.weight,
        inFlight: k.inFlight,
        total: k.success + k.errors,
        success: k.success,
        errors: k.errors,
        ratelimited: k.ratelimited,
        consecutiveFailures: k.consecutiveFailures,
        invalid: k.invalid,
        cooldownSec: k.throttleUntil > now ? Math.ceil((k.throttleUntil - now) / 1000) : 0,
        lastUsed: k.lastUsed,
        lastError: k.lastError,
      })),
    };
  }
}

function retryAfterSec(res) {
  const raw = res.headers['retry-after'] || res.headers['Retry-After'];
  if (!raw) return null;
  const n = parseInt(raw, 10);
  if (!Number.isNaN(n)) return n;
  const d = Date.parse(raw);
  return Number.isNaN(d) ? null : Math.max(1, Math.ceil((d - Date.now()) / 1000));
}

async function forwardOnce(cfg, key, clientReq, body) {
  if (cfg.mock) return mockResponse(key, body);
  const u = new URL(cfg.upstream + clientReq.url);
  const headers = {};
  for (const [h, v] of Object.entries(clientReq.headers)) {
    if (HOP_HEADERS.has(h) || h === 'host' || h === 'authorization' || h === 'content-length') continue;
    headers[h] = Array.isArray(v) ? v.join(', ') : v;
  }
  headers.authorization = `Bearer ${key.key}`;
  headers.host = u.host;
  if (body.length) headers['content-length'] = body.length;
  return new Promise((resolve, reject) => {
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(u, { method: clientReq.method, headers, agent: cfg.agent }, res => resolve(res));
    if (cfg.timeoutMs) req.setTimeout(cfg.timeoutMs, () => req.destroy(new Error(`upstream timeout after ${cfg.timeoutMs}ms`)));
    req.on('error', reject);
    req.end(body);
  });
}

async function relay(cfg, pool, clientReq, clientRes, body, log) {
  const started = Date.now();
  const maxRetries = Math.min(cfg.maxRetries, pool.keys.length - 1);
  const attempted = [];
  let res = null;
  let key = null;
  let lastErr = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const k = pool.pickKey(attempted);
    if (!k) { lastErr = new Error('no keys available'); break; }
    attempted.push(k.name);
    k.inFlight++;
    try {
      const r = await forwardOnce(cfg, k, clientReq, body);
      const status = r.statusCode;
      if (status < 400) {
        res = r;
        key = k;
        break;
      }
      const ra = retryAfterSec(r);
      pool.recordResult(k, { status, retryAfterSec: ra });
      const retryable = status === 429 || status === 401 || status === 403 || status >= 500;
      if (retryable && attempt < maxRetries) {
        r.resume();
        r.on('error', () => {});
        continue;
      }
      res = r;
      key = k;
      break;
    } catch (err) {
      pool.recordResult(k, { networkError: true });
      lastErr = err;
      if (attempt >= maxRetries) break;
    }
  }
  const ms = Date.now() - started;
  if (!res) {
    log(`502 ${clientReq.method} ${clientReq.url} all-keys-failed ${ms}ms`);
    clientRes.writeHead(502, { 'content-type': 'application/json' });
    clientRes.end(JSON.stringify({ error: { message: lastErr ? lastErr.message : 'all upstream keys failed' } }));
    return;
  }
  log(`${res.statusCode} ${clientReq.method} ${clientReq.url} key=${key.name} ${ms}ms`);
  relayResponse(clientRes, res, key, pool, res.statusCode >= 400);
}

function relayResponse(clientRes, upRes, key, pool, preRecorded) {
  const headers = {};
  for (const [h, v] of Object.entries(upRes.headers)) {
    if (HOP_HEADERS.has(h)) continue;
    headers[h] = Array.isArray(v) ? v.join(', ') : v;
  }
  headers['x-gateway-key'] = key.name;
  clientRes.writeHead(upRes.statusCode, headers);
  const tracker = new Transform({
    transform(chunk, enc, cb) {
      if (pool) pool.trackTokens(chunk);
      cb(null, chunk);
    },
  });
  let settled = false;
  const finish = result => {
    if (settled) return;
    settled = true;
    if (!preRecorded) pool.recordResult(key, result);
  };
  upRes.on('end', () => finish({ status: 200 }));
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

function mockResponse(key, body) {
  return new Promise(resolve => {
    let behavior = 'ok';
    const parts = String(key.key).split('-');
    const suffix = parts[parts.length - 1];
    if (['429', '500', '401', 'slow', 'drip', 'abort'].includes(suffix)) behavior = suffix;
    let bodyObj = {};
    try { bodyObj = JSON.parse(body.toString('utf8') || '{}'); } catch {}
    const model = bodyObj.model || 'deepseek-v4-flash';
    const stream = !!bodyObj.stream;
    const delay = behavior === 'slow' ? 400 : 30;
    setTimeout(() => {
      const statusMap = { 429: 429, 500: 500, 401: 401 };
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
      const frames = [
        JSON.stringify({ type: 'response.output_item.added', gateway_key_name: key.name }),
        JSON.stringify({ type: 'response.output_text.delta', delta: 'hello' }),
        JSON.stringify({ type: 'response.completed', usage: { prompt_tokens: 5, completion_tokens: 10, total_tokens: 15 } }),
      ];
      const writeAll = () => {
        if (stream && status === 200) {
          pt.write(frames.map(f => `data: ${f}\n\n`).join('') + 'data: [DONE]\n\n');
        } else if (status === 200) {
          pt.write(JSON.stringify({
            id: 'mock-1', object: 'chat.completion', model,
            gateway_key_name: key.name,
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
            pt.end();
          }
        }, 60);
        pt.on('close', () => clearInterval(iv));
      } else if (behavior === 'abort' && stream) {
        pt.write('data: {"type":"response.output_item.added","gateway_key_name":"' + key.name + '"}\n\n');
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

function buildHealth(cfg, pool, uptime) {
  const s = pool.stats();
  return {
    status: 'ok',
    version: VERSION,
    mock: cfg.mock,
    upstream: cfg.mock ? 'mock' : cfg.upstream,
    port: cfg.port,
    uptime: Math.round(uptime / 1000),
    total: s.total,
    keys: s.keys,
  };
}

function dashboardHtml() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>DeepSeek Gateway</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 24px; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; background: #0d1117; color: #e6edf3; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .sub { color: #8b949e; font-size: 12px; margin-bottom: 20px; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin-bottom: 24px; }
  .card { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 12px 16px; }
  .card .k { color: #8b949e; font-size: 11px; text-transform: uppercase; letter-spacing: .05em; }
  .card .v { font-size: 22px; font-weight: 600; margin-top: 4px; }
  table { width: 100%; border-collapse: collapse; background: #161b22; border: 1px solid #30363d; border-radius: 8px; overflow: hidden; }
  th, td { text-align: left; padding: 8px 12px; font-size: 13px; border-bottom: 1px solid #21262d; }
  th { color: #8b949e; font-weight: 500; font-size: 11px; text-transform: uppercase; letter-spacing: .05em; }
  tr:last-child td { border-bottom: none; }
  .pill { display: inline-block; padding: 2px 10px; border-radius: 999px; font-size: 11px; font-weight: 600; }
  .healthy { background: #12261d; color: #3fb950; border: 1px solid #238636; }
  .cooldown { background: #2d1b05; color: #d29922; border: 1px solid #9e6a03; }
  .circuit-open { background: #3d0c0c; color: #f85149; border: 1px solid #da3633; }
  .invalid { background: #2d1b05; color: #f85149; border: 1px solid #9e6a03; }
  .dim { color: #8b949e; }
  .ok { color: #3fb950; } .bad { color: #f85149; }
</style>
</head>
<body>
<h1>DeepSeek Multi-Key Gateway</h1>
<div class="sub" id="meta">loading…</div>
<div class="cards">
  <div class="card"><div class="k">Requests</div><div class="v" id="c-req">-</div></div>
  <div class="card"><div class="k">Success</div><div class="v ok" id="c-ok">-</div></div>
  <div class="card"><div class="k">Errors</div><div class="v bad" id="c-err">-</div></div>
  <div class="card"><div class="k">Rate limited</div><div class="v" id="c-rl">-</div></div>
  <div class="card"><div class="k">Tokens</div><div class="v" id="c-tok">-</div></div>
</div>
<table>
  <thead><tr><th>Key</th><th>State</th><th>In-flight</th><th>Requests</th><th>Success</th><th>Errors</th><th>429s</th><th>Fails</th><th>Cooldown</th><th>Last used</th></tr></thead>
  <tbody id="rows"></tbody>
</table>
<script>
function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function renderLogin() {
  document.getElementById('meta').innerHTML = '未登录 · <a href="/login">登录</a> 后查看面板';
  document.getElementById('rows').innerHTML = '';
  for (const id of ['c-req', 'c-ok', 'c-err', 'c-rl', 'c-tok']) document.getElementById(id).textContent = '—';
}
async function tick() {
  try {
    const res = await fetch('/health');
    if (res.status === 401) { renderLogin(); return; }
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const h = await res.json();
    document.getElementById('meta').textContent =
      'upstream ' + h.upstream + ' · port ' + h.port + ' · uptime ' + h.uptime + 's · gateway v' + h.version + ' · refreshed ' + new Date().toLocaleTimeString();
    document.getElementById('c-req').textContent = h.total.requests;
    document.getElementById('c-ok').textContent = h.total.success;
    document.getElementById('c-err').textContent = h.total.errors;
    document.getElementById('c-rl').textContent = h.total.ratelimited;
    document.getElementById('c-tok').textContent = h.total.tokens;
    const rows = document.getElementById('rows');
    rows.innerHTML = '';
    for (const k of h.keys) {
      const tr = document.createElement('tr');
      tr.innerHTML = '<td>' + esc(k.name) + '</td>' +
        '<td><span class="pill ' + esc(k.state) + '">' + esc(k.state) + '</span>' +
        (k.invalid ? ' <span class="dim">' + esc(k.lastError || '') + '</span>' : '') + '</td>' +
        '<td>' + k.inFlight + '</td>' +
        '<td>' + k.total + '</td>' +
        '<td class="ok">' + k.success + '</td>' +
        '<td class="bad">' + k.errors + '</td>' +
        '<td>' + k.ratelimited + '</td>' +
        '<td>' + k.consecutiveFailures + '</td>' +
        '<td>' + (k.cooldownSec ? k.cooldownSec + 's' : '—') + '</td>' +
        '<td class="dim">' + (k.lastUsed ? new Date(k.lastUsed).toLocaleTimeString() : '—') + '</td>';
      rows.appendChild(tr);
    }
  } catch (e) {
    document.getElementById('meta').textContent = 'gateway unreachable: ' + e;
  }
}
tick();
setInterval(tick, 2000);
</script>
</body>
</html>`;
}

const LOGIN_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Gateway Login</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; background: #0d1117; color: #e6edf3; }
  form { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 24px; width: 320px; }
  h1 { font-size: 16px; margin: 0 0 16px; }
  input { width: 100%; box-sizing: border-box; padding: 10px 12px; margin-bottom: 12px; background: #0d1117; border: 1px solid #30363d; border-radius: 6px; color: #e6edf3; font-size: 14px; }
  button { width: 100%; padding: 10px; background: #238636; border: none; border-radius: 6px; color: #fff; font-size: 14px; font-weight: 600; cursor: pointer; }
  .err { color: #f85149; font-size: 12px; margin-top: 10px; min-height: 16px; }
</style>
</head>
<body>
<form method="post" action="/login">
  <h1>DeepSeek Gateway 登录</h1>
  <input type="password" name="token" placeholder="gateway token" autofocus autocomplete="current-password">
  <button type="submit">登录</button>
  <div class="err" id="err"></div>
</form>
<script>
document.querySelector('form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const res = await fetch('/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: document.querySelector('input').value }),
  });
  if (res.ok) { location.href = '/'; }
  else { document.getElementById('err').textContent = 'token 不正确'; }
});
</script>
</body>
</html>`;

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (maxBytes && size > maxBytes) {
        req.pause();
        reject(Object.assign(new Error('request body too large'), { statusCode: 413 }));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function handleLogin(cfg, req, res) {
  const body = await readBody(req, 4096);
  let token = '';
  const ct = req.headers['content-type'] || '';
  if (ct.includes('application/json')) {
    try { token = (JSON.parse(body.toString('utf8')).token || ''); } catch {}
  } else {
    token = new URLSearchParams(body.toString('utf8')).get('token') || '';
  }
  if (!cfg.token || !secureEqual(token, cfg.token)) {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'invalid token' } }));
    return;
  }
  res.setHeader('set-cookie', `${COOKIE_NAME}=${sessionCookie(cfg.token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`);
  res.writeHead(302, { location: '/' });
  res.end();
}

async function handleRequest(cfg, pool, req, res, log, startedAt) {
  const url = req.url || '/';
  const bearerOk = cfg.token ? secureEqual(req.headers.authorization || '', `Bearer ${cfg.token}`) : true;
  const sessionOk = cfg.token ? cookieValid(parseCookies(req)[COOKIE_NAME], cfg.token) : false;
  if (url === '/login') {
    if (req.method === 'POST') return handleLogin(cfg, req, res);
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(LOGIN_HTML);
    return;
  }
  if (url === '/logout') {
    res.setHeader('set-cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
    res.writeHead(302, { location: '/' });
    res.end();
    return;
  }
  if (url === '/favicon.ico') {
    res.writeHead(204);
    res.end();
    return;
  }
  const isDashboardPath = url === '/' || url === '/health';
  if (cfg.token && !bearerOk && !(isDashboardPath && sessionOk)) {
    if (url === '/' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(dashboardHtml());
      return;
    }
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'invalid gateway token' } }));
    return;
  }
  if (url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(buildHealth(cfg, pool, Date.now() - startedAt)));
    return;
  }
  if (url === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(dashboardHtml());
    return;
  }
  const body = await readBody(req, cfg.maxBodyBytes);
  await relay(cfg, pool, req, res, body, log);
}

function makeLog(quiet) {
  return quiet ? () => {} : msg => console.log(`[${new Date().toLocaleTimeString()}] ${msg}`);
}

function shutdown(server) {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(USAGE);
    process.exit(0);
  }
  const cfg = loadConfig(opts);
  if (!cfg.keys.length) {
    console.error('ERROR: no keys configured. Use --keys "sk-xxx,sk-yyy", DEEPSEEK_KEYS env, or a keys.json config file.');
    process.exit(1);
  }
  const pool = new KeyPool(cfg.keys, cfg);
  const log = makeLog(cfg.quiet);
  const startedAt = Date.now();
  const server = http.createServer((req, res) => {
    handleRequest(cfg, pool, req, res, log, startedAt).catch(err => {
      const code = err.statusCode || 500;
      log(`${code} ${req.method} ${req.url} ${err.message}`);
      if (!res.headersSent) res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: err.message } }));
    });
  });
  server.listen(cfg.port, cfg.host, () => {
    const addr = server.address();
    cfg.port = addr.port;
    log(`deepseek-gateway v${VERSION} listening on http://${addr.address}:${addr.port}${cfg.mock ? ' [mock]' : ''}`);
    log(`upstream: ${cfg.mock ? 'mock' : cfg.upstream} · ${pool.keys.length} key(s): ${pool.keys.map(k => k.name).join(', ')}`);
    log(`dashboard: http://${addr.address}:${addr.port}/`);
  });
  process.on('SIGINT', () => shutdown(server));
  process.on('SIGTERM', () => shutdown(server));
}

main();
