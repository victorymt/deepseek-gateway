import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createOperationsStore } from '../management/operations-store.mjs';

test('operations store persists logs, usage, integrations, subagents, and backups', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dsgw-operations-'));
  const configPath = path.join(directory, 'keys.json');
  fs.writeFileSync(configPath, JSON.stringify({ schemaVersion: 2, marker: 'current' }));
  try {
    const store = createOperationsStore(configPath);
    store.addLog({ level: 'error', message: 'upstream failed', provider: 'alpha' });
    assert.equal(store.listLogs({ level: 'error' }).length, 1);
    store.flush();
    assert.equal(JSON.parse(fs.readFileSync(path.join(directory, 'gateway-operations.json'), 'utf8')).schemaVersion, 2);
    assert.equal(createOperationsStore(configPath).listLogs().length, 1);

    store.recordUsage({ status: 200, provider: 'alpha', model: 'alpha--one', tokens: 12 });
    store.recordUsage({ status: 429, provider: 'alpha', model: 'alpha--one', tokens: 0 });
    store.recordTokens({ provider: 'alpha', model: 'alpha--one', tokens: 8 });
    const usage = store.usage('30d');
    assert.equal(usage.total.requests, 2);
    assert.equal(usage.total.success, 1);
    assert.equal(usage.total.ratelimited, 1);
    assert.equal(usage.total.tokens, 20);
    assert.equal(usage.points[0].providers.alpha.requests, 2);
    assert.equal(usage.points[0].providers.alpha.tokens, 20);
    assert.equal(usage.agents, undefined);

    const integration = store.saveIntegration({ name: 'Local', type: 'openai', baseUrl: 'http://127.0.0.1:9999/v1' });
    assert.equal(store.listIntegrations()[0].id, integration.id);
    store.deleteIntegration(integration.id);
    assert.equal(store.listIntegrations().length, 0);

    const subagent = store.saveSubagent({ name: 'Coder', providerId: 'alpha', model: 'alpha--one' });
    assert.equal(subagent.name, 'coder');
    assert.ok(subagent.description);
    assert.ok(subagent.developerInstructions);
    assert.equal(subagent.instructions, undefined);
    assert.equal(store.listSubagents()[0].id, subagent.id);
    store.deleteSubagent(subagent.id);
    assert.equal(store.listSubagents().length, 0);

    const backup = store.createBackup();
    assert.ok(backup?.id);
    fs.writeFileSync(configPath, JSON.stringify({ schemaVersion: 2, marker: 'changed' }));
    const restored = store.restoreBackup(backup.id);
    fs.writeFileSync(configPath, JSON.stringify(restored.config));
    assert.equal(JSON.parse(fs.readFileSync(configPath, 'utf8')).marker, 'current');

    store.clearLogs();
    assert.equal(store.listLogs().length, 0);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('operations store migrates legacy JSON and quarantines malformed files', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dsgw-operations-'));
  const configPath = path.join(directory, 'keys.json');
  const operationsPath = path.join(directory, 'gateway-operations.json');
  fs.writeFileSync(configPath, '{}');
  try {
    fs.writeFileSync(operationsPath, JSON.stringify({
      logs: [{ id: 'legacy-log', timestamp: Date.now(), message: 'old attribution', agentId: 'coder', agentName: 'Coder' }],
      usage: {
        [new Date().toISOString().slice(0, 10)]: {
          requests: 1, success: 1, errors: 0, ratelimited: 0, tokens: 3,
          providers: {}, models: {}, agents: { coder: { requests: 1, success: 1, errors: 0, ratelimited: 0, tokens: 3 } },
        },
      },
      integrations: [],
      subagents: [{
        id: 'legacy-agent', name: 'Coder', description: null,
        developerInstructions: null, instructions: 'Implement changes.',
        providerId: 'alpha', model: 'alpha--one', enabled: true,
      }],
    }));
    const legacy = createOperationsStore(configPath);
    assert.equal(legacy.listLogs()[0].agentId, undefined);
    assert.equal(legacy.usage('30d').agents, undefined);
    assert.equal(legacy.usage('30d').points[0].agents, undefined);
    assert.equal(legacy.listSubagents()[0].name, 'coder');
    assert.equal(legacy.listSubagents()[0].developerInstructions, 'Implement changes.');
    legacy.flush();
    assert.equal(JSON.parse(fs.readFileSync(operationsPath, 'utf8')).schemaVersion, 2);

    fs.writeFileSync(operationsPath, '{malformed');
    const recovered = createOperationsStore(configPath);
    recovered.addLog({ message: 'after recovery' });
    recovered.flush();
    assert.equal(recovered.listLogs().length, 1);
    assert.equal(fs.readdirSync(directory).filter(name => name.startsWith('gateway-operations.json.corrupt-')).length, 1);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('operations store quarantines a file corrupted while running instead of overwriting it', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dsgw-operations-'));
  const configPath = path.join(directory, 'keys.json');
  const operationsPath = path.join(directory, 'gateway-operations.json');
  fs.writeFileSync(configPath, '{}');
  try {
    const store = createOperationsStore(configPath);
    store.addLog({ message: 'first' });
    store.flush();
    // Simulate another writer leaving the file corrupt while this store runs.
    fs.writeFileSync(operationsPath, '{broken');
    store.addLog({ message: 'second' });
    store.flush();
    const corrupt = fs.readdirSync(directory)
      .filter(name => name.startsWith('gateway-operations.json.corrupt-'));
    assert.equal(corrupt.length, 1);
    assert.equal(fs.readFileSync(path.join(directory, corrupt[0]), 'utf8'), '{broken');
    // In-memory state survives and the store keeps working.
    assert.deepEqual(store.listLogs().map(item => item.message), ['second', 'first']);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('clearLogs preserves the audit trail', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dsgw-operations-'));
  const configPath = path.join(directory, 'keys.json');
  fs.writeFileSync(configPath, '{}');
  try {
    const store = createOperationsStore(configPath);
    store.addLog({ level: 'audit', message: 'admin login succeeded', method: 'POST', route: '/login', status: 302 });
    store.addLog({ message: 'ordinary request log' });
    store.clearLogs();
    const remaining = store.listLogs();
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].level, 'audit');
    assert.equal(remaining[0].message, 'admin login succeeded');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('logs pagination rejects a zero limit', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dsgw-operations-'));
  const configPath = path.join(directory, 'keys.json');
  fs.writeFileSync(configPath, '{}');
  try {
    const store = createOperationsStore(configPath);
    store.addLog({ message: 'one' });
    assert.throws(
      () => store.listLogsPage(new URLSearchParams('limit=0')),
      error => error.statusCode === 400 && /positive integer/.test(error.message),
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('operations store merges writes from concurrent instances', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dsgw-operations-'));
  const configPath = path.join(directory, 'keys.json');
  fs.writeFileSync(configPath, '{}');
  try {
    const first = createOperationsStore(configPath);
    const second = createOperationsStore(configPath);
    first.addLog({ message: 'first' });
    first.recordUsage({ status: 200, provider: 'alpha' });
    second.addLog({ message: 'second' });
    second.recordUsage({ status: 200, provider: 'alpha' });
    second.flush();
    first.flush();

    let reloaded = createOperationsStore(configPath);
    assert.deepEqual(new Set(reloaded.listLogs().map(item => item.message)), new Set(['first', 'second']));
    assert.equal(reloaded.usage('30d').total.requests, 2);

    const integration = first.saveIntegration({ name: 'Shared', type: 'openai', baseUrl: 'https://example.com/v1' });
    const stale = createOperationsStore(configPath);
    first.deleteIntegration(integration.id);
    stale.addLog({ message: 'stale instance flushed' });
    stale.flush();
    reloaded = createOperationsStore(configPath);
    assert.equal(reloaded.listIntegrations().length, 0);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('operations store validates integration URLs and types', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dsgw-operations-'));
  const configPath = path.join(directory, 'keys.json');
  fs.writeFileSync(configPath, '{}');
  try {
    const store = createOperationsStore(configPath);
    assert.throws(() => store.saveIntegration({ name: 'Bad', type: 'smtp', baseUrl: 'https://example.com' }), /integration type/);
    assert.throws(() => store.saveIntegration({ name: 'Bad', type: 'openai', baseUrl: 'file:///tmp/x' }), /HTTP/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('operations store pages logs with a stable timestamp and id cursor', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dsgw-operations-'));
  const configPath = path.join(directory, 'keys.json');
  fs.writeFileSync(configPath, '{}');
  try {
    const store = createOperationsStore(configPath);
    const first = store.addLog({ level: 'info', message: 'first', provider: 'alpha', model: 'alpha--one', status: 200 });
    const second = store.addLog({ level: 'error', message: 'second', provider: 'beta', model: 'beta--two', status: 503 });
    const third = store.addLog({ level: 'audit', message: 'third', provider: 'alpha', model: 'alpha--one', status: 201 });
    first.timestamp = second.timestamp = third.timestamp = 1700000000000;

    const page = store.listLogsPage({ limit: '2' });
    assert.equal(page.logs.length, 2);
    assert.equal(page.hasMore, true);
    assert.ok(page.nextCursor);
    const orderedIds = [first.id, second.id, third.id].sort((a, b) => b.localeCompare(a));
    assert.deepEqual(page.logs.map(item => item.id), orderedIds.slice(0, 2));

    const next = store.listLogsPage({ limit: '2', cursor: page.nextCursor });
    assert.equal(next.logs.length, 1);
    assert.equal(next.hasMore, false);
    assert.equal(next.logs[0].id, orderedIds[2]);
    assert.equal(new Set([...page.logs, ...next.logs].map(item => item.id)).size, 3);

    assert.equal(store.listLogsPage({ level: 'error', provider: 'beta', model: 'beta--two', status: '503', search: 'SECOND' }).logs[0].message, 'second');
    assert.throws(() => store.listLogsPage({ cursor: 'not-a-cursor' }), error => error.statusCode === 400);
    assert.throws(() => store.listLogsPage({ limit: 'nope' }), error => error.statusCode === 400);
    assert.throws(() => store.listLogsPage({ status: '99' }), error => error.statusCode === 400);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('operations usage aggregates provider and model totals consistently', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dsgw-operations-'));
  const configPath = path.join(directory, 'keys.json');
  fs.writeFileSync(configPath, '{}');
  try {
    const store = createOperationsStore(configPath);
    store.recordUsage({ status: 200, provider: 'alpha', model: 'alpha--one', tokens: 12 });
    store.recordUsage({ status: 429, provider: 'alpha', model: 'alpha--one', tokens: 3 });
    store.recordUsage({ status: 500, provider: 'beta', model: 'beta--two', tokens: 5 });
    const usage = store.usage('30d');
    assert.equal(usage.total.requests, 3);
    assert.equal(usage.providers.alpha.requests, 2);
    assert.equal(usage.providers.alpha.tokens, 15);
    assert.equal(usage.models['alpha--one'].ratelimited, 1);
    assert.equal(usage.models['beta--two'].errors, 1);
    assert.equal(Object.values(usage.providers).reduce((sum, item) => sum + item.requests, 0), usage.total.requests);
    assert.equal(Object.values(usage.models).reduce((sum, item) => sum + item.tokens, 0), usage.total.tokens);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('restoring the oldest retained backup reads it before retention pruning', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dsgw-operations-'));
  const configPath = path.join(directory, 'keys.json');
  try {
    const store = createOperationsStore(configPath);
    for (let index = 0; index < 5; index++) {
      fs.writeFileSync(configPath, JSON.stringify({ marker: index }));
      store.createBackup();
    }
    const oldest = store.listBackups().at(-1);
    fs.writeFileSync(configPath, JSON.stringify({ marker: 'current' }));
    assert.equal(store.restoreBackup(oldest.id).config.marker, 0);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
