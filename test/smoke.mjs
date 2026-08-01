import { test } from 'node:test';
import assert from 'node:assert';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const GATEWAY = path.join(ROOT, 'gateway.mjs');
const CONFIGURE = path.join(ROOT, 'configure.py');

function freePort() {
  return new Promise(resolve => {
    const s = net.createServer();
    s.listen(0, () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
  });
}

async function waitFor(fn, timeout = 8000) {
  const start = Date.now();
  for (;;) {
    if (await fn().then(() => true, () => false)) return;
    if (Date.now() - start > timeout) throw new Error('waitFor timeout');
    await new Promise(r => setTimeout(r, 100));
  }
}

async function startGateway(keys, extra = [], env = {}) {
  const port = await freePort();
  const child = spawn(process.execPath, [
    GATEWAY, '--mock', '--port', String(port), '--keys', keys, '--quiet', ...extra,
  ], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } });
  let stderr = '';
  child.stderr.on('data', d => { stderr += d; });
  const base = `http://127.0.0.1:${port}`;
  await waitFor(() => fetch(`${base}/health`).then(r => r.ok));
  return {
    base,
    async health() { return fetch(`${base}/health`).then(r => r.json()); },
    async chat(body = {}) {
      const res = await fetch(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'deepseek-v4-flash', ...body }),
      });
      const text = await res.text();
      return { status: res.status, headers: res.headers, text };
    },
    async stop() {
      child.kill('SIGKILL');
      await new Promise(r => child.on('exit', r));
      if (stderr) throw new Error(`gateway stderr: ${stderr}`);
    },
  };
}

test('round-robin distributes across keys', async () => {
  const gw = await startGateway('alice=sk-a-ok,bob=sk-b-ok');
  try {
    const names = [];
    for (let i = 0; i < 4; i++) {
      const { status, text } = await gw.chat();
      assert.equal(status, 200);
      names.push(JSON.parse(text).gateway_key_name);
    }
    assert.deepEqual(names, ['alice', 'bob', 'alice', 'bob']);
  } finally {
    await gw.stop();
  }
});

test('429 fails over to the next key and cools the throttled one', async () => {
  const gw = await startGateway('alice=sk-a-429,bob=sk-b-ok');
  try {
    const { status, text } = await gw.chat();
    assert.equal(status, 200);
    assert.equal(JSON.parse(text).gateway_key_name, 'bob');
    const h = await gw.health();
    const alice = h.keys.find(k => k.name === 'alice');
    assert.equal(alice.state, 'cooldown');
    assert.ok(alice.cooldownSec >= 1);
    assert.equal(alice.ratelimited, 1);
    const { status: s2, text: t2 } = await gw.chat();
    assert.equal(s2, 200);
    assert.equal(JSON.parse(t2).gateway_key_name, 'bob');
  } finally {
    await gw.stop();
  }
});

test('401 marks key invalid permanently', async () => {
  const gw = await startGateway('alice=sk-a-401,bob=sk-b-ok');
  try {
    const { status, text } = await gw.chat();
    assert.equal(status, 200);
    assert.equal(JSON.parse(text).gateway_key_name, 'bob');
    const h = await gw.health();
    assert.equal(h.keys.find(k => k.name === 'alice').invalid, true);
    assert.equal(h.keys.find(k => k.name === 'alice').state, 'invalid');
  } finally {
    await gw.stop();
  }
});

test('consecutive 5xx opens circuit after threshold', async () => {
  const gw = await startGateway('alice=sk-a-500,bob=sk-b-500,carol=sk-c-ok', ['--breaker', '3']);
  try {
    for (let i = 0; i < 4; i++) {
      const { status, text } = await gw.chat();
      assert.equal(status, 200);
      assert.equal(JSON.parse(text).gateway_key_name, 'carol');
    }
    const h = await gw.health();
    const alice = h.keys.find(k => k.name === 'alice');
    assert.equal(alice.state, 'circuit-open');
    assert.match(alice.lastError, /circuit/);
    assert.equal(h.keys.find(k => k.name === 'bob').state, 'circuit-open');
  } finally {
    await gw.stop();
  }
});

test('SSE stream passes through with key attribution', async () => {
  const gw = await startGateway('alice=sk-a-ok,bob=sk-b-ok');
  try {
    const { status, headers, text } = await gw.chat({ stream: true });
    assert.equal(status, 200);
    assert.match(headers.get('content-type'), /text\/event-stream/);
    assert.match(text, /data: \{\"type\":\"response\.output_item\.added\",\"gateway_key_name\":\"alice\"/);
    assert.match(text, /data: \[DONE\]/);
    assert.match(text, /total_tokens/);
    assert.equal(headers.get('x-gateway-key'), 'alice');
  } finally {
    await gw.stop();
  }
});

test('concurrent requests spread across slow keys', async () => {
  const gw = await startGateway('alice=sk-a-slow,bob=sk-b-slow');
  try {
    const results = await Promise.all(Array.from({ length: 4 }, () => gw.chat()));
    const names = results.map(r => JSON.parse(r.text).gateway_key_name);
    assert.ok(names.includes('alice') && names.includes('bob'), `expected both keys, got ${names}`);
    assert.ok(names.filter(n => n === 'alice').length >= 1 && names.filter(n => n === 'bob').length >= 1);
  } finally {
    await gw.stop();
  }
});

test('health endpoint reports totals', async () => {
  const gw = await startGateway('alice=sk-a-ok');
  try {
    await gw.chat();
    await gw.chat();
    const h = await gw.health();
    assert.equal(h.total.requests, 2);
    assert.equal(h.total.success, 2);
    assert.ok(h.total.tokens > 0);
    assert.equal(h.keys[0].name, 'alice');
    assert.equal(h.keys[0].state, 'healthy');
  } finally {
    await gw.stop();
  }
});

test('all keys invalid: degraded mode never picks them, returns 502', async () => {
  const gw = await startGateway('alice=sk-a-401,bob=sk-b-401');
  try {
    const first = await gw.chat();
    assert.equal(first.status, 401);
    const second = await gw.chat();
    assert.equal(second.status, 502);
    assert.match(second.text, /no keys available/);
    const h = await gw.health();
    for (const k of h.keys) assert.equal(k.state, 'invalid');
  } finally {
    await gw.stop();
  }
});

test('CLI args take precedence over env vars', async () => {
  const envPort = await freePort();
  const gw = await startGateway('alice=sk-a-ok', [], { DS_GATEWAY_PORT: String(envPort) });
  try {
    const h = await gw.health();
    assert.notEqual(h.port, envPort);
    const res = await fetch(`${gw.base}/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-v4-flash' }),
    });
    assert.equal(res.status, 200);
  } finally {
    await gw.stop();
  }
});

test('token auth: cookie login for dashboard, bearer for proxy', async () => {
  const gw = await startGateway('alice=sk-a-ok', ['--token', 'secret-token']);
  try {
    const shell = await fetch(`${gw.base}/`);
    assert.equal(shell.status, 200);
    const shellHtml = await shell.text();
    assert.ok(!shellHtml.includes('secret-token'), 'dashboard HTML must not embed the token');
    assert.ok(!shellHtml.includes('Bearer'), 'dashboard HTML must not embed bearer credentials');

    const healthNoAuth = await fetch(`${gw.base}/health`);
    assert.equal(healthNoAuth.status, 401);
    const wrongLogin = await fetch(`${gw.base}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'wrong' }),
    });
    assert.equal(wrongLogin.status, 401);

    const login = await fetch(`${gw.base}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'secret-token' }),
      redirect: 'manual',
    });
    assert.equal(login.status, 302);
    const cookie = login.headers.get('set-cookie').split(';')[0];
    assert.ok(cookie.startsWith('dsgw='));

    const healthCookie = await fetch(`${gw.base}/health`, { headers: { cookie } });
    assert.equal(healthCookie.status, 200);
    const shellCookie = await fetch(`${gw.base}/`, { headers: { cookie } });
    assert.equal(shellCookie.status, 200);

    const proxyWithCookie = await fetch(`${gw.base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ model: 'deepseek-v4-flash' }),
    });
    assert.equal(proxyWithCookie.status, 401, 'cookie must not authorize proxied calls');

    const proxyWithBearer = await fetch(`${gw.base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer secret-token' },
      body: JSON.stringify({ model: 'deepseek-v4-flash' }),
    });
    assert.equal(proxyWithBearer.status, 200);
  } finally {
    await gw.stop();
  }
});

test('inFlight is held for the whole stream, not just headers', async () => {
  const gw = await startGateway('alice=sk-a-drip');
  try {
    const res = await fetch(`${gw.base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-v4-flash', stream: true }),
    });
    assert.equal(res.status, 200);
    const reader = res.body.getReader();
    await reader.read();
    const during = await gw.health();
    assert.equal(during.keys[0].inFlight, 1, 'in-flight must stay 1 while stream is active');
    while (true) {
      const { done } = await reader.read();
      if (done) break;
    }
    const after = await gw.health();
    assert.equal(after.keys[0].inFlight, 0);
    assert.equal(after.keys[0].success, 1);
  } finally {
    await gw.stop();
  }
});

test('upstream abort mid-stream counts as error and gateway survives', async () => {
  const gw = await startGateway('alice=sk-a-abort');
  try {
    const res = await fetch(`${gw.base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-v4-flash', stream: true }),
    });
    assert.equal(res.status, 200);
    await assert.rejects(() => res.text());
    const h = await gw.health();
    assert.equal(h.keys[0].errors, 1);
    assert.equal(h.keys[0].inFlight, 0);
    const next = await gw.chat();
    assert.equal(next.status, 200, 'gateway must keep serving after an aborted stream');
  } finally {
    await gw.stop();
  }
});

test('merge-config preserves codex profiles', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-profiles-'));
  const codexDir = path.join(tmp, 'codex');
  fs.mkdirSync(codexDir);
  fs.writeFileSync(path.join(codexDir, 'config.toml'), [
    'model = "gpt-5"',
    '',
    '[profiles.fast]',
    'model = "gpt-5-fast"',
    '',
    '[profiles.deepseek]',
    'base_url = "https://deepseek.example"',
    '',
  ].join('\n'));
  const setup = path.join(ROOT, 'setup-codex.sh');
  for (let i = 0; i < 2; i++) {
    const r = spawnSync('bash', [setup], {
      env: { ...process.env, CODEX_HOME: codexDir, GATEWAY_URL: 'http://127.0.0.1:8787' },
      encoding: 'utf8',
    });
    assert.equal(r.status, 0, r.stderr);
  }
  const merged = fs.readFileSync(path.join(codexDir, 'config.toml'), 'utf8');
  assert.match(merged, /\[profiles\.fast\]/);
  assert.match(merged, /model = "gpt-5-fast"/, 'profile model must be preserved');
  assert.match(merged, /\[profiles\.deepseek\]/);
  assert.match(merged, /base_url = "https:\/\/deepseek\.example"/, 'profile deepseek must be preserved');
  assert.match(merged, /^model = "deepseek-v4-flash"/m, 'top-level model must be replaced');
  assert.equal((merged.match(/\[model_providers\.deepseek\]/g) || []).length, 1);
  const validate = spawnSync('python3', ['-c', `
import sys, tomllib
with open(sys.argv[1], 'rb') as f: tomllib.load(f)
`, path.join(codexDir, 'config.toml')]);
  assert.equal(validate.status, 0, `merged config.toml must be valid TOML: ${validate.stderr}`);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('oversized request body is rejected with 413', async () => {
  const gw = await startGateway('alice=sk-a-ok', ['--max-body-bytes', '100']);
  try {
    const res = await fetch(`${gw.base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-v4-flash', messages: [{ role: 'user', content: 'x'.repeat(200) }] }),
    });
    assert.equal(res.status, 413);
    const small = await gw.chat();
    assert.equal(small.status, 200);
  } finally {
    await gw.stop();
  }
});

test('dashboard escapes key names', async () => {
  const evilName = '<script>alert(1)</script>';
  const gw = await startGateway(`${evilName}=sk-a-ok`);
  try {
    const res = await fetch(`${gw.base}/`);
    const html = await res.text();
    assert.match(html, /function esc\(/);
    assert.match(html, /esc\(k\.name\)/);
    const h = await gw.health();
    assert.equal(h.keys[0].name, evilName);
  } finally {
    await gw.stop();
  }
});

test('setup script is idempotent and dry-run is pure', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-setup-'));
  const codexDir = path.join(tmp, 'codex');
  fs.mkdirSync(codexDir);
  const setup = path.join(ROOT, 'setup-codex.sh');
  const runSetup = (args) => spawnSync('bash', [setup, ...args], {
    env: {
      ...process.env,
      CODEX_HOME: codexDir,
      GATEWAY_URL: 'http://127.0.0.1:8787',
      GATEWAY_TOKEN: 'configured-token',
    },
    encoding: 'utf8',
  });

  const beforeDry = fs.readdirSync(codexDir).sort();
  const dry = runSetup(['--dry-run']);
  assert.equal(dry.status, 0, dry.stderr);
  const afterDry = fs.readdirSync(codexDir).sort();
  assert.deepEqual(afterDry, beforeDry, `dry-run must not create files: ${afterDry}`);

  const first = runSetup([]);
  assert.equal(first.status, 0, first.stderr);
  const configPath = path.join(codexDir, 'config.toml');
  fs.appendFileSync(configPath, '[mcp_servers.demo]\ncommand = "echo"\n');
  const preSecond = fs.readFileSync(configPath, 'utf8');
  const second = runSetup([]);
  assert.equal(second.status, 0, second.stderr);

  const merged = fs.readFileSync(configPath, 'utf8');
  const sectionCount = (merged.match(/\[model_providers\.deepseek\]/g) || []).length;
  assert.equal(sectionCount, 1, `expected exactly one provider section: ${merged}`);
  assert.match(merged, /\[mcp_servers\.demo\]/);
  assert.match(merged, /base_url = "http:\/\/127\.0\.0\.1:8787"/);
  assert.match(merged, /experimental_bearer_token = "configured-token"/);
  assert.match(merged, /model = "deepseek-v4-flash"/);

  const validate = spawnSync('python3', ['-c', `
import sys, tomllib
with open(sys.argv[1], 'rb') as f: tomllib.load(f)
`, configPath]);
  assert.equal(validate.status, 0, `merged config.toml must be valid TOML: ${validate.stderr}`);

  const undo = runSetup(['--undo']);
  assert.equal(undo.status, 0, undo.stderr);
  assert.equal(fs.readFileSync(configPath, 'utf8'), preSecond, 'undo should restore the pre-run state');

  fs.rmSync(tmp, { recursive: true, force: true });
});

test('interactive configure writes a validated private config', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-configure-'));
  const configPath = path.join(tmp, 'keys.json');
  const answers = [
    '8790',
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    'primary',
    'sk-test-secret',
    '2',
    'n',
    'y',
    'gateway-secret',
    '',
  ].join('\n');
  const result = spawnSync('python3', [
    CONFIGURE, '--config', configPath, '--no-codex', '--no-start',
  ], { input: answers, encoding: 'utf8' });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.equal(config.port, 8790);
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.upstream, 'https://api.deepseek.com');
  assert.equal(config.token, 'gateway-secret');
  assert.deepEqual(config.keys, [
    { name: 'primary', key: 'sk-test-secret', weight: 2 },
  ]);
  assert.equal(fs.statSync(configPath).mode & 0o777, 0o600);
  assert.ok(!result.stdout.includes('sk-test-secret'), 'API key must not be echoed');

  const keepAnswers = [
    '', '', '', '', '', '', '', '',
    'n',
    '',
    '',
    '',
  ].join('\n');
  const second = spawnSync('python3', [
    CONFIGURE, '--config', configPath, '--no-codex', '--no-start',
  ], { input: keepAnswers, encoding: 'utf8' });
  assert.equal(second.status, 0, second.stderr || second.stdout);
  const kept = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.deepEqual(kept.keys, config.keys);
  assert.equal(kept.token, 'gateway-secret');
  const backups = fs.readdirSync(path.join(tmp, '.gateway-backups'));
  assert.equal(backups.length, 1);
  assert.ok(!second.stdout.includes('sk-test-secret'), 'existing API key must stay masked');
  fs.rmSync(tmp, { recursive: true, force: true });
});
