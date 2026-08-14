import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  buildCodexAgentToml,
  createCodexAgentProjector,
  normalizeStoredCodexAgent,
  restoreCodexAgentSnapshot,
  validateCodexAgentInput,
} from '../codex-agent-config.mjs';

const config = {
  providers: [{
    id: 'alpha',
    name: 'Alpha',
    enabled: true,
    models: [{ id: 'chat', upstreamModel: 'upstream-chat' }],
  }],
};

function agent(overrides = {}) {
  return {
    id: 'reviewer-id',
    name: 'reviewer',
    description: 'Reviews correctness and security.',
    providerId: 'alpha',
    model: 'alpha--chat',
    developerInstructions: 'Review carefully.',
    enabled: true,
    ...overrides,
  };
}

function hashOf(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

const AGENT_CONFIG_CLI = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'codex-agent-config.mjs',
);

function cliSyncFixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dsgw-cli-sync-'));
  const configPath = path.join(directory, 'keys.json');
  const codexHome = path.join(directory, 'codex');
  fs.writeFileSync(configPath, JSON.stringify({
    schemaVersion: 2,
    defaultProvider: 'alpha',
    defaultModel: 'alpha--chat',
    providers: [{
      id: 'alpha',
      name: 'Alpha',
      baseUrl: 'https://alpha.example',
      enabled: true,
      models: [{ id: 'chat', name: 'Chat', upstreamModel: 'chat' }],
      keys: [{ name: 'k', key: 'sk-ok', weight: 1 }],
    }],
  }));
  fs.writeFileSync(path.join(directory, 'gateway-operations.json'), JSON.stringify({
    schemaVersion: 2,
    subagents: [{
      id: 'reviewer-id',
      name: 'reviewer',
      description: 'Reviews.',
      providerId: 'alpha',
      model: 'alpha--chat',
      developerInstructions: 'Review.',
      enabled: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }],
    logs: [],
    usage: {},
    integrations: [],
    deleted: {},
  }));
  fs.mkdirSync(path.join(codexHome, 'agents'), { recursive: true });
  fs.writeFileSync(path.join(codexHome, 'agents', 'reviewer.toml'), 'name = "reviewer"\n');
  return { directory, configPath, codexHome };
}

test('CLI sync accepts a manifest owned by the same config path', () => {
  const { directory, configPath, codexHome } = cliSyncFixture();
  const owner = crypto.createHash('sha256').update(configPath).digest('hex').slice(0, 16);
  fs.writeFileSync(path.join(codexHome, 'gateway-agents.json'), JSON.stringify({
    schemaVersion: 2,
    owner,
    agents: { 'reviewer-id': { name: 'reviewer', hash: hashOf('name = "reviewer"\n'), backupPath: null } },
  }));
  try {
    const result = spawnSync(process.execPath, [
      AGENT_CONFIG_CLI,
      '--config', configPath,
      '--codex-home', codexHome,
      '--sync',
    ], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    // The sync rewrote the agent file from the stored definition.
    assert.match(
      fs.readFileSync(path.join(codexHome, 'agents', 'reviewer.toml'), 'utf8'),
      /^name = "reviewer"$/m,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('CLI sync refuses a manifest owned by a different config path', () => {
  const { directory, configPath, codexHome } = cliSyncFixture();
  fs.writeFileSync(path.join(codexHome, 'gateway-agents.json'), JSON.stringify({
    schemaVersion: 2,
    owner: 'another-config-owner',
    agents: { 'reviewer-id': { name: 'reviewer', hash: hashOf('name = "reviewer"\n'), backupPath: null } },
  }));
  try {
    const result = spawnSync(process.execPath, [
      AGENT_CONFIG_CLI,
      '--config', configPath,
      '--codex-home', codexHome,
      '--sync',
    ], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /owned by another gateway config/);
    assert.equal(fs.existsSync(path.join(codexHome, 'agents', 'reviewer.toml')), true);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('Codex agent TOML uses the native schema and gateway model alias', () => {
  const source = buildCodexAgentToml(config, agent());
  assert.match(source, /^name = "reviewer"$/m);
  assert.match(source, /^description = "Reviews correctness and security\."$/m);
  assert.match(source, /^model = "Alpha\.chat"$/m);
  assert.match(source, /^developer_instructions = "Review carefully\."$/m);
  assert.doesNotMatch(source, /agent--|^instructions =/m);
});

test('legacy pseudo-agent records migrate to native agent fields', () => {
  const migrated = normalizeStoredCodexAgent({
    id: 'old',
    name: 'Code Reviewer',
    providerId: 'alpha',
    model: 'alpha--chat',
    instructions: 'Review old records.',
  });
  assert.equal(migrated.name, 'code_reviewer');
  assert.equal(migrated.developerInstructions, 'Review old records.');
  assert.equal(migrated.instructions, undefined);
  assert.ok(migrated.description);

  const partial = normalizeStoredCodexAgent({
    id: 'partial',
    name: 'Coder',
    description: null,
    developerInstructions: null,
    instructions: 'Keep the legacy instructions.',
    providerId: 'alpha',
    model: 'alpha--chat',
  });
  assert.equal(partial.name, 'coder');
  assert.equal(partial.developerInstructions, 'Keep the legacy instructions.');
  assert.ok(partial.description);
});

test('agent validation allows maintaining an existing target while its provider is disabled', () => {
  const value = validateCodexAgentInput(config, {
    name: 'Code Reviewer',
    description: 'Review code',
    providerId: 'alpha',
    model: 'alpha--chat',
    developerInstructions: 'Review it.',
  });
  assert.equal(value.name, 'code_reviewer');
  const unavailable = { providers: [{ ...config.providers[0], enabled: false }] };
  assert.deepEqual(
    validateCodexAgentInput(unavailable, { description: 'Updated review scope' }, agent()),
    {
      name: 'reviewer',
      description: 'Updated review scope',
      developerInstructions: 'Review carefully.',
      providerId: 'alpha',
      model: 'alpha--chat',
      enabled: true,
    },
  );
  assert.equal(
    validateCodexAgentInput(unavailable, { enabled: false }, agent()).enabled,
    false,
  );
  assert.throws(
    () => validateCodexAgentInput(config, { ...value, providerId: 'missing' }),
    /enabled provider/,
  );
  assert.throws(
    () => validateCodexAgentInput(unavailable, value),
    /enabled provider/,
  );
  assert.throws(
    () => validateCodexAgentInput(unavailable, { model: 'alpha--missing' }, agent()),
    /enabled provider/,
  );
});

test('empty reconciliation does not create Codex management state', () => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsgw-agents-empty-'));
  const projector = createCodexAgentProjector({ codexHome });
  try {
    assert.deepEqual(projector.reconcile(config, []), []);
    assert.equal(fs.existsSync(projector.manifestPath), false);
    assert.equal(fs.existsSync(projector.agentsDirectory), false);
  } finally {
    fs.rmSync(codexHome, { recursive: true, force: true });
  }
});

test('reconciliation rejects duplicate native agent names before writing files', () => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsgw-agents-duplicate-'));
  const projector = createCodexAgentProjector({ codexHome });
  try {
    assert.throws(
      () => projector.reconcile(config, [agent(), agent({ id: 'other-reviewer-id' })]),
      error => error.statusCode === 409 && /configured by both/.test(error.message),
    );
    assert.equal(fs.existsSync(projector.manifestPath), false);
    assert.equal(fs.existsSync(projector.agentsDirectory), false);
  } finally {
    fs.rmSync(codexHome, { recursive: true, force: true });
  }
});

test('projector rejects manifest paths outside the Codex backup directory', () => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsgw-agent-manifest-'));
  const projector = createCodexAgentProjector({ codexHome });
  fs.writeFileSync(projector.manifestPath, JSON.stringify({
    schemaVersion: 1,
    agents: {
      'reviewer-id': {
        name: 'reviewer',
        hash: 'a'.repeat(64),
        backupPath: path.join(codexHome, '..', 'outside.toml'),
      },
    },
  }));
  try {
    assert.throws(
      () => projector.inspect(agent(), config),
      error => error.statusCode === 409 && /invalid backup path/.test(error.message),
    );
  } finally {
    fs.rmSync(codexHome, { recursive: true, force: true });
  }
});

test('projector rejects duplicate names in a managed manifest', () => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsgw-agent-manifest-'));
  const projector = createCodexAgentProjector({ codexHome });
  fs.writeFileSync(projector.manifestPath, JSON.stringify({
    schemaVersion: 1,
    agents: {
      first: { name: 'reviewer', hash: 'a'.repeat(64), backupPath: null },
      second: { name: 'reviewer', hash: 'b'.repeat(64), backupPath: null },
    },
  }));
  try {
    assert.throws(
      () => projector.inspect(agent(), config),
      error => error.statusCode === 409 && /duplicate name/.test(error.message),
    );
  } finally {
    fs.rmSync(codexHome, { recursive: true, force: true });
  }
});

test('projector backs up unmanaged files, restores them, and detects edits', () => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsgw-agents-'));
  const projector = createCodexAgentProjector({ codexHome });
  const file = path.join(codexHome, 'agents', 'reviewer.toml');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'user-owned = true\n');
  try {
    projector.reconcile(config, [agent()]);
    const installed = projector.inspect(agent(), config);
    assert.equal(installed.status, 'installed');
    assert.ok(installed.backupPath);
    assert.equal(fs.readFileSync(installed.backupPath, 'utf8'), 'user-owned = true\n');

    fs.appendFileSync(file, '# external edit\n');
    assert.throws(
      () => projector.reconcile(config, [agent({ enabled: false })]),
      error => error.statusCode === 409,
    );
    assert.equal(projector.inspect(agent(), config).status, 'modified');

    projector.reconcile(config, [agent({ enabled: false })], { force: true });
    assert.equal(fs.readFileSync(file, 'utf8'), 'user-owned = true\n');
    assert.equal(projector.inspect(agent({ enabled: false }), config).status, 'disabled');
    assert.equal(fs.existsSync(projector.manifestPath), false);
  } finally {
    fs.rmSync(codexHome, { recursive: true, force: true });
  }
});

test('renaming an agent restores each colliding user file to its own name', () => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsgw-agent-rename-'));
  const projector = createCodexAgentProjector({ codexHome });
  const agentsDirectory = path.join(codexHome, 'agents');
  const oldFile = path.join(agentsDirectory, 'reviewer.toml');
  const newFile = path.join(agentsDirectory, 'security_reviewer.toml');
  fs.mkdirSync(agentsDirectory, { recursive: true });
  fs.writeFileSync(oldFile, 'owner = "old-name"\n');
  fs.writeFileSync(newFile, 'owner = "new-name"\n');
  try {
    projector.reconcile(config, [agent()]);
    projector.reconcile(config, [agent({ name: 'security_reviewer' })]);
    assert.equal(fs.readFileSync(oldFile, 'utf8'), 'owner = "old-name"\n');
    assert.match(fs.readFileSync(newFile, 'utf8'), /^name = "security_reviewer"$/m);

    projector.reconcile(config, []);
    assert.equal(fs.readFileSync(oldFile, 'utf8'), 'owner = "old-name"\n');
    assert.equal(fs.readFileSync(newFile, 'utf8'), 'owner = "new-name"\n');
    assert.equal(fs.existsSync(projector.manifestPath), false);
  } finally {
    fs.rmSync(codexHome, { recursive: true, force: true });
  }
});

test('projector withdraws agents whose provider target is unavailable', () => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsgw-agents-'));
  const projector = createCodexAgentProjector({ codexHome });
  try {
    projector.reconcile(config, [agent()]);
    const unavailable = { providers: [{ ...config.providers[0], enabled: false }] };
    projector.reconcile(unavailable, [agent()]);
    assert.equal(fs.existsSync(path.join(codexHome, 'agents', 'reviewer.toml')), false);
    assert.equal(projector.inspect(agent(), unavailable).status, 'unavailable');
  } finally {
    fs.rmSync(codexHome, { recursive: true, force: true });
  }
});

test('reconcile refuses to delete unowned manifest agents when none are configured', () => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsgw-agents-guard-'));
  const projector = createCodexAgentProjector({ codexHome });
  const file = path.join(codexHome, 'agents', 'reviewer.toml');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'name = "reviewer"\n');
  // A manifest left behind by an older gateway version has no owner.
  fs.writeFileSync(projector.manifestPath, JSON.stringify({
    schemaVersion: 1,
    agents: {
      'reviewer-id': { name: 'reviewer', hash: hashOf('name = "reviewer"\n'), backupPath: null },
    },
  }));
  try {
    assert.throws(
      () => projector.reconcile(config, []),
      error => error.statusCode === 409 && /refusing to delete/.test(error.message),
    );
    assert.equal(fs.existsSync(file), true);
    assert.equal(fs.existsSync(projector.manifestPath), true);
  } finally {
    fs.rmSync(codexHome, { recursive: true, force: true });
  }
});

test('reconcile refuses to touch a manifest owned by another gateway config', () => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsgw-agents-foreign-'));
  const projector = createCodexAgentProjector({ codexHome });
  const file = path.join(codexHome, 'agents', 'reviewer.toml');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'name = "reviewer"\n');
  fs.writeFileSync(projector.manifestPath, JSON.stringify({
    schemaVersion: 2,
    owner: 'another-config',
    agents: {
      'reviewer-id': { name: 'reviewer', hash: hashOf('name = "reviewer"\n'), backupPath: null },
    },
  }));
  try {
    assert.throws(
      () => projector.reconcile(config, [agent()]),
      error => error.statusCode === 409 && /owned by another gateway config/.test(error.message),
    );
    assert.equal(fs.existsSync(file), true);
  } finally {
    fs.rmSync(codexHome, { recursive: true, force: true });
  }
});

test('reconcile stamps the manifest owner and allows cleanup for the same config', () => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsgw-agents-owner-'));
  const projector = createCodexAgentProjector({ codexHome });
  const file = path.join(codexHome, 'agents', 'reviewer.toml');
  try {
    projector.reconcile(config, [agent()]);
    const manifest = JSON.parse(fs.readFileSync(projector.manifestPath, 'utf8'));
    assert.equal(manifest.schemaVersion, 2);
    assert.equal(typeof manifest.owner, 'string');
    assert.ok(manifest.owner.length > 0);
    // The owning config may clean up all agents later (legit UI delete flow).
    projector.reconcile(config, []);
    assert.equal(fs.existsSync(file), false);
    assert.equal(fs.existsSync(projector.manifestPath), false);
  } finally {
    fs.rmSync(codexHome, { recursive: true, force: true });
  }
});

test('reconcile reuses a stable private advisory lock file', () => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsgw-agents-lock-'));
  const projector = createCodexAgentProjector({ codexHome });
  const lockPath = `${projector.manifestPath}.lock`;
  try {
    projector.reconcile(config, [agent()]);
    assert.equal(fs.statSync(lockPath).mode & 0o777, 0o600);
    projector.reconcile(config, [agent({ description: 'updated scope' })]);
    assert.equal(fs.existsSync(lockPath), true);
    assert.match(
      fs.readFileSync(path.join(codexHome, 'agents', 'reviewer.toml'), 'utf8'),
      /updated scope/,
    );
  } finally {
    fs.rmSync(codexHome, { recursive: true, force: true });
  }
});

test('snapshot restore only changes gateway-managed agent files', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsgw-agent-snapshot-'));
  const codexHome = path.join(root, 'codex');
  const snapshot = path.join(root, 'snapshot');
  const projector = createCodexAgentProjector({ codexHome });
  try {
    projector.reconcile(config, [agent()]);
    fs.mkdirSync(path.join(snapshot, 'agents'), { recursive: true });
    fs.copyFileSync(projector.manifestPath, path.join(snapshot, 'gateway-agents.json'));
    fs.copyFileSync(
      path.join(codexHome, 'agents', 'reviewer.toml'),
      path.join(snapshot, 'agents', 'reviewer.toml'),
    );
    fs.writeFileSync(path.join(codexHome, 'agents', 'personal.toml'), 'personal = true\n');
    projector.reconcile(config, [agent({ name: 'security_reviewer' })]);

    restoreCodexAgentSnapshot({ codexHome, snapshot });
    assert.equal(fs.existsSync(path.join(codexHome, 'agents', 'security_reviewer.toml')), false);
    assert.equal(fs.existsSync(path.join(codexHome, 'agents', 'reviewer.toml')), true);
    assert.equal(fs.readFileSync(path.join(codexHome, 'agents', 'personal.toml'), 'utf8'), 'personal = true\n');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
