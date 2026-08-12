import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const GATEWAY = path.join(ROOT, 'gateway.mjs');

function config() {
  return {
    schemaVersion: 2,
    defaultProvider: 'alpha',
    defaultModel: 'alpha--chat',
    providers: [{
      id: 'alpha',
      name: 'Alpha',
      baseUrl: 'https://alpha.example/v1',
      enabled: true,
      models: [{ id: 'chat', name: 'Chat', upstreamModel: 'upstream-chat' }],
      keys: [{ name: 'test', key: 'sk-test-ok', weight: 1 }],
    }],
  };
}

function storedAgent(id = 'reviewer-id') {
  return {
    id,
    name: 'reviewer',
    description: 'Reviews correctness.',
    providerId: 'alpha',
    model: 'alpha--chat',
    developerInstructions: 'Review carefully.',
    enabled: true,
  };
}

async function waitForFile(file, child, timeout = 5000) {
  const started = Date.now();
  while (!fs.existsSync(file)) {
    if (child.exitCode !== null) throw new Error(`gateway exited before projecting agent: ${child.exitCode}`);
    if (Date.now() - started > timeout) throw new Error('timed out waiting for projected Codex agent');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

test('gateway startup reconciles stored native Codex agents before listening', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsgw-agent-startup-'));
  const codexHome = path.join(root, 'codex');
  const configPath = path.join(root, 'gateway.json');
  const operationsPath = path.join(root, 'gateway-operations.json');
  fs.writeFileSync(configPath, JSON.stringify(config()));
  fs.writeFileSync(operationsPath, JSON.stringify({ schemaVersion: 2, subagents: [storedAgent()] }));
  const child = spawn(process.execPath, [
    GATEWAY, '--mock', '--quiet', '--config', configPath, '--port', '0',
  ], {
    cwd: ROOT,
    stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env, CODEX_HOME: codexHome },
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  try {
    const agentFile = path.join(codexHome, 'agents', 'reviewer.toml');
    await waitForFile(agentFile, child);
    assert.match(fs.readFileSync(agentFile, 'utf8'), /^model = "Alpha\.chat"$/m);
    assert.equal(fs.existsSync(path.join(codexHome, 'gateway-agents.json')), true);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve));
      child.kill('SIGKILL');
      await exited;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
  assert.equal(stderr, '');
});

test('gateway startup rejects duplicate canonical Codex agent names', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsgw-agent-duplicate-'));
  const codexHome = path.join(root, 'codex');
  const configPath = path.join(root, 'gateway.json');
  fs.writeFileSync(configPath, JSON.stringify(config()));
  fs.writeFileSync(path.join(root, 'gateway-operations.json'), JSON.stringify({
    schemaVersion: 2,
    subagents: [storedAgent(), storedAgent('other-reviewer-id')],
  }));
  try {
    const result = spawnSync(process.execPath, [
      GATEWAY, '--mock', '--quiet', '--config', configPath, '--port', '0',
    ], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, CODEX_HOME: codexHome },
      timeout: 5000,
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Cannot sync native Codex agents/);
    assert.match(result.stderr, /reviewer.*configured by both reviewer-id and other-reviewer-id/);
    assert.equal(fs.existsSync(path.join(codexHome, 'gateway-agents.json')), false);
    assert.equal(fs.existsSync(path.join(codexHome, 'agents')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
