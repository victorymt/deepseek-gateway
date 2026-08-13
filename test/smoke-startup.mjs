import { test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

import {
  CODEX_CONFIG,
  CONFIGURE,
  GATEWAY,
  ROOT,
  freePort,
  multiProviderConfig,
  startGateway,
} from './helpers/gateway-harness.mjs';

test('reports an occupied listen port without an unhandled error stack', async () => {
  const blocker = net.createServer();
  await new Promise((resolve, reject) => {
    blocker.once('error', reject);
    blocker.listen(0, '127.0.0.1', resolve);
  });
  const port = blocker.address().port;
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-port-'));
  const configPath = path.join(runDir, 'keys.json');
  fs.writeFileSync(configPath, JSON.stringify({
    schemaVersion: 2,
    defaultProvider: 'deepseek',
    defaultModel: 'deepseek-chat',
    balanceRefreshMs: 1,
    providers: [{
      id: 'deepseek',
      name: 'DeepSeek',
      baseUrl: 'https://api.deepseek.com',
      enabled: true,
      models: [{ id: 'deepseek-chat', name: 'DeepSeek Chat', upstreamModel: 'deepseek-chat' }],
      keys: [{ name: 'test', key: 'sk-test-ok', weight: 1 }],
    }],
  }));

  try {
    const result = spawnSync(process.execPath, [
      GATEWAY,
      '--config', configPath,
      '--port', String(port),
    ], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 5000,
      // isolate native Codex agent sync from the real ~/.codex
      env: { ...process.env, CODEX_HOME: path.join(runDir, 'codex-home') },
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /address already in use/);
    assert.match(result.stderr, /--port <port>/);
    assert.doesNotMatch(result.stderr, /balance refresh failed/);
    assert.doesNotMatch(result.stderr, /Unhandled 'error' event/);
  } finally {
    await new Promise(resolve => blocker.close(resolve));
    fs.rmSync(runDir, { recursive: true, force: true });
  }
});

test('generated Codex artifacts omit env auth when the gateway has no token', async () => {
  const config = multiProviderConfig();
  config.providers[0].models[0].supportsHostedWebSearch = true;
  config.providers[1].upstreamFormat = 'chat-completions';
  config.providers[1].models[0] = {
    id: 'gpt-4.1',
    name: 'GPT 4.1',
    upstreamModel: 'gpt-4.1',
    inputModalities: ['text', 'image'],
  };
  const gw = await startGateway('', [], {}, config, { keysArg: false });
  try {
    const routed = await gw.chat({ model: 'beta--gpt-4.1' });
    assert.equal(routed.status, 200, routed.text);
    assert.equal(routed.headers.get('x-gateway-provider'), 'beta');
    const dotted = await gw.chat({ model: 'Beta.gpt-4.1' });
    assert.equal(dotted.status, 200, dotted.text);
    assert.equal(dotted.headers.get('x-gateway-provider'), 'beta');

    const response = await fetch(`${gw.base}/api/codex/config`);
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.ok(!text.includes('sk-alpha-ok'));
    assert.ok(!text.includes('sk-beta-ok'));
    const artifacts = JSON.parse(text);
    assert.equal(artifacts.providerId, 'multi-provider-gateway');
    assert.match(artifacts.revision, /^[a-f0-9]{64}$/);
    assert.equal(artifacts.authRequired, false);
    assert.equal(artifacts.envKey, null);
    assert.equal(artifacts.defaultModel, 'Alpha.shared');
    assert.match(artifacts.configToml, /model_provider = "multi-provider-gateway"/);
    assert.doesNotMatch(artifacts.configToml, /env_key/);
    assert.doesNotMatch(artifacts.configToml, /experimental_bearer_token/);
    assert.equal((artifacts.configToml.match(/\[model_providers\./g) || []).length, 1);
    const catalog = JSON.parse(artifacts.catalogJson);
    const aliases = catalog.models.map(model => model.slug);
    assert.deepEqual(aliases, ['Alpha.shared', 'Beta.gpt-4.1']);
    assert.deepEqual(catalog.models.map(model => model.display_name), [
      'Alpha.shared',
      'Beta.gpt-4.1',
    ]);
    assert.deepEqual(catalog.models.map(model => model.input_modalities), [
      ['text', 'image'],
      ['text', 'image'],
    ]);
    assert.equal(catalog.models[0].web_search_tool_type, 'text');
    assert.equal(catalog.models[1].web_search_tool_type, undefined);
  } finally {
    await gw.stop();
  }
});

test('generated Codex artifacts use the effective runtime gateway token state', async () => {
  const gw = await startGateway('', [], {
    DS_GATEWAY_TOKEN: 'runtime-gateway-secret',
    DS_GATEWAY_ADMIN_TOKEN: 'runtime-admin-secret-1234',
  }, multiProviderConfig(), { keysArg: false });
  const auth = { authorization: 'Bearer runtime-admin-secret-1234' };
  try {
    const settingsResponse = await gw.settings({ headers: auth });
    assert.equal(settingsResponse.status, 200);
    const settings = await settingsResponse.json();
    assert.equal(settings.persisted.tokenConfigured, false);
    assert.equal(settings.effective.tokenConfigured, true);
    assert.equal(settings.overrides.token, 'DS_GATEWAY_TOKEN');

    const response = await fetch(`${gw.base}/api/codex/config`, { headers: auth });
    assert.equal(response.status, 200);
    const artifacts = await response.json();
    assert.equal(artifacts.authRequired, true);
    assert.equal(artifacts.envKey, 'DEEPSEEK_GATEWAY_TOKEN');
    assert.match(artifacts.configToml, /env_key = "DEEPSEEK_GATEWAY_TOKEN"/);
  } finally {
    await gw.stop();
  }
});

test('Codex config auth mode can override offline token detection', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-codex-auth-'));
  const configPath = path.join(directory, 'keys.json');
  try {
    fs.writeFileSync(configPath, JSON.stringify(multiProviderConfig()));
    const required = spawnSync(process.execPath, [
      CODEX_CONFIG, '--config', configPath, '--auth', 'required', '--print-toml',
    ], { encoding: 'utf8' });
    assert.equal(required.status, 0, required.stderr);
    assert.match(required.stdout, /env_key = "DEEPSEEK_GATEWAY_TOKEN"/);

    fs.writeFileSync(configPath, JSON.stringify(multiProviderConfig({ token: 'gateway-secret' })));
    const none = spawnSync(process.execPath, [
      CODEX_CONFIG, '--config', configPath, '--auth', 'none', '--print-toml',
    ], { encoding: 'utf8' });
    assert.equal(none.status, 0, none.stderr);
    assert.doesNotMatch(none.stdout, /env_key/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
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

test('merge-config preserves codex profiles', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-profiles-'));
  const codexDir = path.join(tmp, 'codex');
  fs.mkdirSync(codexDir);
  fs.writeFileSync(path.join(codexDir, 'config.toml'), [
    'model = "gpt-5"',
    '# [model_providers.multi-provider-gateway] is documentation only',
    '',
    '[profiles.fast]',
    'model = "gpt-5-fast"',
    '',
    '[profiles.deepseek]',
    'base_url = "https://deepseek.example"',
    '',
    '[model_providers."multi-provider-gateway"] # stale generated section',
    'name = "Stale Gateway"',
    'base_url = "http://127.0.0.1:1/v1"',
    '',
  ].join('\n'));
  const setup = path.join(ROOT, 'setup-codex.sh');
  for (let i = 0; i < 2; i++) {
    const r = spawnSync('bash', [setup], {
      env: {
        ...process.env,
        CODEX_HOME: codexDir,
        GATEWAY_URL: 'http://127.0.0.1:8787',
        GATEWAY_CONFIG: path.join(ROOT, 'keys.example.json'),
      },
      encoding: 'utf8',
    });
    assert.equal(r.status, 0, r.stderr);
  }
  const merged = fs.readFileSync(path.join(codexDir, 'config.toml'), 'utf8');
  assert.match(merged, /\[profiles\.fast\]/);
  assert.match(merged, /model = "gpt-5-fast"/, 'profile model must be preserved');
  assert.match(merged, /\[profiles\.deepseek\]/);
  assert.match(merged, /base_url = "https:\/\/deepseek\.example"/, 'profile deepseek must be preserved');
  assert.match(merged, /^model = "Deepseek.v4-flash"/m, 'top-level model must be replaced');
  assert.match(merged, /^# \[model_providers\.multi-provider-gateway\] is documentation only$/m);
  assert.doesNotMatch(merged, /Stale Gateway/);
  assert.equal((merged.match(/^\[model_providers\.multi-provider-gateway\]$/gm) || []).length, 1);
  assert.doesNotMatch(merged, /env_key/);
  assert.doesNotMatch(merged, /experimental_bearer_token/);
  const validate = spawnSync('python3', ['-c', `
import sys, tomllib
with open(sys.argv[1], 'rb') as f: tomllib.load(f)
`, path.join(codexDir, 'config.toml')]);
  assert.equal(validate.status, 0, `merged config.toml must be valid TOML: ${validate.stderr}`);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('dashboard escapes key names', async () => {
  const evilName = '<script>alert(1)</script>';
  const gw = await startGateway(`${evilName}=sk-a-ok`);
  try {
    const res = await fetch(`${gw.base}/`);
    const html = await res.text();
    if (html.includes('id="root"')) {
      assert.ok(!html.includes(evilName), 'dashboard shell must not embed key names');
    } else {
      assert.match(html, /function esc\(/);
      assert.match(html, /esc\(k\.name\)/);
    }
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
  fs.mkdirSync(path.join(codexDir, 'agents'));
  fs.writeFileSync(path.join(codexDir, 'agents', 'reviewer.toml'), 'name = "personal_reviewer"\n');
  const gatewayConfig = path.join(tmp, 'gateway.json');
  fs.writeFileSync(gatewayConfig, JSON.stringify(multiProviderConfig({ token: 'gateway-secret' })));
  const operationsPath = path.join(tmp, 'gateway-operations.json');
  fs.writeFileSync(operationsPath, JSON.stringify({
    schemaVersion: 2,
    subagents: [{
      id: 'reviewer',
      name: 'reviewer',
      description: 'Reviews code.',
      providerId: 'alpha',
      model: 'alpha--shared',
      developerInstructions: 'Review correctness and missing tests.',
      enabled: true,
    }],
  }));
  const setup = path.join(ROOT, 'setup-codex.sh');
  const runSetup = (args) => spawnSync('bash', [setup, ...args], {
    env: {
      ...process.env,
      CODEX_HOME: codexDir,
      GATEWAY_URL: 'http://127.0.0.1:8787',
      GATEWAY_CONFIG: gatewayConfig,
      DEEPSEEK_GATEWAY_TOKEN: 'configured-token',
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
  const agentPath = path.join(codexDir, 'agents', 'reviewer.toml');
  assert.match(fs.readFileSync(agentPath, 'utf8'), /model = "Alpha\.shared"/);
  const preSecondAgent = fs.readFileSync(agentPath, 'utf8');
  const operations = JSON.parse(fs.readFileSync(operationsPath, 'utf8'));
  operations.subagents[0].developerInstructions = 'Review security and regression risks first.';
  fs.writeFileSync(operationsPath, JSON.stringify(operations));
  fs.appendFileSync(configPath, '[mcp_servers.demo]\ncommand = "echo"\n');
  const preSecond = fs.readFileSync(configPath, 'utf8');
  const second = runSetup([]);
  assert.equal(second.status, 0, second.stderr);
  assert.match(
    fs.readFileSync(agentPath, 'utf8'),
    /developer_instructions = "Review security and regression risks first\."/,
  );

  const merged = fs.readFileSync(configPath, 'utf8');
  const sectionCount = (merged.match(/\[model_providers\.multi-provider-gateway\]/g) || []).length;
  assert.equal(sectionCount, 1, `expected exactly one provider section: ${merged}`);
  assert.match(merged, /\[mcp_servers\.demo\]/);
  assert.match(merged, /base_url = "http:\/\/127\.0\.0\.1:8787\/v1"/);
  assert.match(merged, /env_key = "DEEPSEEK_GATEWAY_TOKEN"/);
  assert.doesNotMatch(merged, /experimental_bearer_token/);
  assert.ok(!merged.includes('configured-token'));
  assert.match(merged, /model = "Alpha.shared"/);
  const catalog = JSON.parse(fs.readFileSync(path.join(codexDir, 'gateway-models.json'), 'utf8'));
  assert.deepEqual(catalog.models.map(model => model.slug), ['Alpha.shared', 'Beta.shared']);
  assert.ok(
    catalog.models.every(model => model.supports_search_tool === false),
    'catalog models must not enable supports_search_tool (hides MCP tools in Codex CLI)',
  );
  assert.ok(
    catalog.models.every(model => model.shell_type === 'shell_command'),
    'every catalog model must declare the Codex shell tool type',
  );
  assert.ok(
    catalog.models.every(model => (
      model.base_instructions || model.model_messages?.instructions_template
    )),
    'every catalog model must include a Codex instruction source',
  );
  assert.ok(
    catalog.models.every(model => typeof model.supports_reasoning_summaries === 'boolean'),
    'every catalog model must declare reasoning summary support',
  );
  assert.ok(
    catalog.models.every(model => model.apply_patch_tool_type === undefined),
    'native Responses models must not advertise the proxy-only freeform patch tool',
  );
  assert.equal(fs.statSync(path.join(codexDir, 'gateway-models.json')).mode & 0o777, 0o600);

  const beforeUndoDryConfig = fs.readFileSync(configPath, 'utf8');
  const beforeUndoDryCatalog = fs.readFileSync(path.join(codexDir, 'gateway-models.json'), 'utf8');
  const undoDry = runSetup(['--undo', '--dry-run']);
  assert.notEqual(undoDry.status, 0);
  assert.match(undoDry.stderr, /cannot be used together/);
  assert.equal(fs.readFileSync(configPath, 'utf8'), beforeUndoDryConfig);
  assert.equal(fs.readFileSync(path.join(codexDir, 'gateway-models.json'), 'utf8'), beforeUndoDryCatalog);

  const validate = spawnSync('python3', ['-c', `
import sys, tomllib
with open(sys.argv[1], 'rb') as f: tomllib.load(f)
`, configPath]);
  assert.equal(validate.status, 0, `merged config.toml must be valid TOML: ${validate.stderr}`);

  const undo = runSetup(['--undo']);
  assert.equal(undo.status, 0, undo.stderr);
  assert.equal(fs.readFileSync(configPath, 'utf8'), preSecond, 'undo should restore the pre-run state');
  assert.equal(fs.readFileSync(agentPath, 'utf8'), preSecondAgent, 'undo should restore managed agent files');

  fs.rmSync(tmp, { recursive: true, force: true });
});

test('interactive configure writes a private web setup config', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-configure-'));
  const configPath = path.join(tmp, 'keys.json');
  const port = await freePort();
  const answers = [
    String(port),
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    'y',
    'gateway-secret',
  ].join('\n');
  const result = spawnSync('python3', [
    CONFIGURE, '--config', configPath, '--no-codex', '--no-start',
  ], {
    input: answers,
    encoding: 'utf8',
    env: { ...process.env, DS_GATEWAY_PORT: String(port) },
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.equal(config.schemaVersion, 2);
  assert.equal(config.port, port);
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.setupPending, true);
  assert.equal(config.defaultProvider, '');
  assert.equal(config.defaultModel, '');
  assert.equal(config.upstream, undefined);
  assert.equal(config.keys, undefined);
  assert.equal(config.blacklistThreshold, 3);
  assert.equal(config.balanceRefreshMs, 300000);
  assert.equal(config.token, 'gateway-secret');
  assert.deepEqual(config.providers, []);
  assert.equal(fs.statSync(configPath).mode & 0o777, 0o600);
  assert.doesNotMatch(result.stdout, /API Key/);

  const keepAnswers = [
    '', '', '', '', '', '', '', '', '',
    '',
  ].join('\n') + '\n';
  const second = spawnSync('python3', [
    CONFIGURE, '--config', configPath, '--no-codex', '--no-start',
  ], {
    input: keepAnswers,
    encoding: 'utf8',
    env: { ...process.env, DS_GATEWAY_PORT: String(port) },
  });
  assert.equal(second.status, 0, second.stderr || second.stdout);
  const kept = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.equal(kept.setupPending, true);
  assert.deepEqual(kept.providers, []);
  assert.equal(kept.token, 'gateway-secret');
  const backups = fs.readdirSync(path.join(tmp, '.gateway-backups'));
  assert.equal(backups.length, 1);
  fs.rmSync(tmp, { recursive: true, force: true });
});
