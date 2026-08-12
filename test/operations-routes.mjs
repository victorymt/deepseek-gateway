import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createOperationsRoutes } from '../management/operations-routes.mjs';
import { createOperationsStore } from '../management/operations-store.mjs';

function harness(configPath) {
  const operations = createOperationsStore(configPath);
  const calls = { restored: [], stopped: 0 };
  const projections = new Map();
  const codexAgentProjector = {
    inspect: agent => projections.get(agent.id) || {
      codexHome: '/tmp/codex', path: null, installed: false,
      status: agent.enabled ? 'missing' : 'disabled', backupPath: null,
    },
    reconcile: (_config, agents) => {
      projections.clear();
      for (const agent of agents) projections.set(agent.id, {
        codexHome: '/tmp/codex', path: `/tmp/codex/agents/${agent.name}.toml`,
        installed: agent.enabled, status: agent.enabled ? 'installed' : 'disabled', backupPath: null,
      });
    },
  };
  const route = createOperationsRoutes({
    codexAgentProjector,
    operations,
    restoreConfig: (_cfg, _registry, config) => calls.restored.push(config),
    stopGateway: () => { calls.stopped++; },
    writeJson: (res, status, body) => Object.assign(res, { status, body }),
    readJsonBody: async req => req.body || {},
  });
  const cfg = {
    providers: [{ id: 'alpha', enabled: true, models: [{ id: 'one' }] }],
  };
  async function request(method, pathname, body) {
    const res = {};
    const handled = await route({
      cfg,
      registry: {},
      req: { method, url: pathname, body },
      res,
      pathname: new URL(pathname, 'http://gateway.local').pathname,
    });
    assert.equal(handled, true);
    return res;
  }
  return { operations, calls, cfg, request };
}

test('operations routes expose logs, usage, storage, integrations, and subagents', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dsgw-routes-'));
  const configPath = path.join(directory, 'keys.json');
  fs.writeFileSync(configPath, JSON.stringify({ marker: 'backup' }));
  const originalFetch = globalThis.fetch;
  try {
    const { operations, calls, cfg, request } = harness(configPath);
    operations.addLog({ level: 'error', message: 'needle' });
    operations.recordUsage({ status: 200, provider: 'alpha', model: 'alpha--one' });
    operations.recordTokens({ provider: 'alpha', model: 'alpha--one', tokens: 17 });

    const logs = (await request('GET', '/api/logs?search=needle&limit=1')).body;
    assert.equal(logs.logs.length, 1);
    assert.equal(logs.total, 1);
    assert.equal(logs.hasMore, false);
    assert.equal(logs.nextCursor, null);
    const usage = (await request('GET', '/api/usage?range=7d')).body;
    assert.equal(usage.total.tokens, 17);
    assert.equal(usage.providers.alpha.tokens, 17);
    assert.equal(usage.models['alpha--one'].tokens, 17);
    await assert.rejects(
      request('GET', '/api/logs?cursor=invalid'),
      error => error.statusCode === 400,
    );
    assert.equal((await request('DELETE', '/api/logs')).body.cleared, true);

    const backup = (await request('POST', '/api/storage', { action: 'backup' })).body;
    assert.ok(backup.id);
    await request('POST', '/api/storage', { action: 'restore', id: backup.id });
    assert.equal(calls.restored[0].marker, 'backup');

    const created = (await request('POST', '/api/integrations', {
      name: 'Hook', type: 'webhook', baseUrl: 'https://hooks.example/test',
    })).body.integration;
    const updated = (await request('PATCH', `/api/integrations/${created.id}`, {
      ...created, enabled: false,
    })).body.integration;
    assert.equal(updated.enabled, false);

    let fetchInit;
    globalThis.fetch = async (_url, init) => {
      fetchInit = init;
      return new Response('upstream rejected', { status: 503 });
    };
    const tested = await request('POST', `/api/integrations/${created.id}/test`);
    assert.equal(tested.status, 502);
    assert.equal(tested.body.error.message, 'upstream returned HTTP 503');
    assert.equal(tested.body.detail, undefined);
    assert.equal(fetchInit.method, 'POST');
    assert.equal(fetchInit.headers['content-type'], 'application/json');
    assert.equal(JSON.parse(fetchInit.body).event, 'gateway.integration_test');
    await request('DELETE', `/api/integrations/${created.id}`);
    assert.equal(operations.listIntegrations().length, 0);
    await assert.rejects(
      request('PATCH', `/api/integrations/${created.id}`, { name: 'Missing' }),
      error => error.statusCode === 404,
    );

    const agent = (await request('POST', '/api/subagents', {
      name: 'code_reviewer', description: 'Reviews code', providerId: 'alpha',
      model: 'alpha--one', developerInstructions: 'Review carefully.',
    })).body.subagent;
    const listedAgent = (await request('GET', '/api/subagents')).body.subagents[0];
    assert.equal(listedAgent.name, 'code_reviewer');
    assert.equal(listedAgent.projection.status, 'installed');
    assert.equal(listedAgent.usage, undefined);
    assert.equal(listedAgent.lastCallAt, undefined);
    cfg.providers[0].enabled = false;
    const editedAgent = (await request('PATCH', `/api/subagents/${agent.id}`, {
      description: 'Updated while provider is unavailable',
    })).body.subagent;
    assert.equal(editedAgent.description, 'Updated while provider is unavailable');
    assert.equal(editedAgent.enabled, true);
    const disabledAgent = (await request('PATCH', `/api/subagents/${agent.id}`, {
      enabled: false,
    })).body.subagent;
    assert.equal(disabledAgent.description, 'Updated while provider is unavailable');
    assert.equal(disabledAgent.enabled, false);
    await assert.rejects(
      request('POST', '/api/subagents', { name: 'Bad', providerId: 'missing', model: 'x' }),
      /enabled provider/,
    );
    await request('DELETE', `/api/subagents/${agent.id}`);
    assert.equal(operations.listSubagents().length, 0);
    await assert.rejects(
      request('DELETE', `/api/subagents/${agent.id}`),
      error => error.statusCode === 404,
    );

    await request('DELETE', `/api/storage/backups/${encodeURIComponent(backup.id)}`);
    assert.equal(operations.listBackups().some(item => item.id === backup.id), false);
  } finally {
    globalThis.fetch = originalFetch;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('integration test network failures do not expose upstream error details', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dsgw-routes-'));
  const configPath = path.join(directory, 'keys.json');
  fs.writeFileSync(configPath, '{}');
  const originalFetch = globalThis.fetch;
  try {
    const { request } = harness(configPath);
    const created = (await request('POST', '/api/integrations', {
      name: 'Remote', type: 'openai', baseUrl: 'https://example.invalid/v1',
    })).body.integration;
    globalThis.fetch = async () => { throw new Error('secret-token in resolver error'); };
    await assert.rejects(
      request('POST', `/api/integrations/${created.id}/test`),
      error => error.statusCode === 502
        && error.message === 'integration test could not reach the upstream service'
        && !error.message.includes('secret-token'),
    );
  } finally {
    globalThis.fetch = originalFetch;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('runtime stop acknowledges before invoking shutdown', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dsgw-routes-'));
  const configPath = path.join(directory, 'keys.json');
  fs.writeFileSync(configPath, '{}');
  try {
    const { calls, request } = harness(configPath);
    const response = await request('POST', '/api/runtime/stop');
    assert.equal(response.status, 202);
    assert.deepEqual(response.body, { stopping: true });
    assert.equal(calls.stopped, 0);
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(calls.stopped, 1);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
