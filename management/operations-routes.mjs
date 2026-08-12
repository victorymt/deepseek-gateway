'use strict';

import crypto from 'node:crypto';

import {
  createCodexAgentProjector,
  validateCodexAgentInput,
} from '../codex-agent-config.mjs';

const INTEGRATION_TEST_TIMEOUT_MS = 5000;

function integrationTestError(error) {
  if (error?.name === 'AbortError') {
    return Object.assign(new Error('integration test timed out'), { statusCode: 504 });
  }
  return Object.assign(new Error('integration test could not reach the upstream service'), { statusCode: 502 });
}

function subagentResponse(current, projector, config) {
  return current.listSubagents().map(subagent => ({
    ...subagent,
    projection: projector.inspect(subagent, config),
  }));
}

export function createOperationsRoutes(services) {
  const {
    codexAgentProjector: configuredProjector,
    operations,
    restoreConfig,
    stopGateway,
    writeJson,
    readJsonBody,
  } = services;
  const codexAgentProjector = configuredProjector || createCodexAgentProjector();
  const store = () => typeof operations === 'function' ? operations() : operations;

  function saveSubagent(current, cfg, input, id = '') {
    const existing = id
      ? current.listSubagents().find(value => value.id === id)
      : null;
    if (id && !existing) throw Object.assign(new Error('subagent not found'), { statusCode: 404 });
    const validated = validateCodexAgentInput(cfg, input, existing);
    const duplicate = current.listSubagents().find(value => (
      value.name === validated.name && value.id !== id
    ));
    if (duplicate) throw Object.assign(new Error('agent name is already configured'), { statusCode: 409 });
    const candidate = {
      ...existing,
      ...validated,
      id: id || input.id || crypto.randomUUID(),
      createdAt: existing?.createdAt || Date.now(),
      updatedAt: Date.now(),
    };
    const previous = current.listSubagents();
    const next = id
      ? previous.map(value => value.id === id ? candidate : value)
      : [...previous, candidate];
    codexAgentProjector.reconcile(cfg, next);
    try {
      return current.saveSubagent(candidate, candidate.id);
    } catch (error) {
      try { codexAgentProjector.reconcile(cfg, previous, { force: true }); } catch {}
      throw error;
    }
  }

  function deleteSubagent(current, cfg, id) {
    const previous = current.listSubagents();
    const existing = previous.find(value => value.id === id);
    if (!existing) throw Object.assign(new Error('subagent not found'), { statusCode: 404 });
    codexAgentProjector.reconcile(cfg, previous.filter(value => value.id !== id));
    try {
      current.deleteSubagent(id);
    } catch (error) {
      try { codexAgentProjector.reconcile(cfg, previous, { force: true }); } catch {}
      throw error;
    }
  }

  return async function handleOperationsRoute({ cfg, registry, req, res, pathname }) {
    const current = store();
    if (!current) return false;
    if (pathname === '/api/runtime/stop' && req.method === 'POST') {
      writeJson(res, 202, { stopping: true });
      setTimeout(() => stopGateway(), 250);
      return true;
    }
    if (pathname === '/api/logs') {
      if (req.method === 'GET') { writeJson(res, 200, current.listLogsPage(new URL(req.url, 'http://gateway.local').searchParams)); return true; }
      if (req.method === 'DELETE') { current.clearLogs(); writeJson(res, 200, { cleared: true }); return true; }
    }
    if (pathname === '/api/usage' && req.method === 'GET') {
      const range = new URL(req.url, 'http://gateway.local').searchParams.get('range') || '30d';
      writeJson(res, 200, current.usage(range));
      return true;
    }
    if (pathname === '/api/storage') {
      if (req.method === 'GET') { writeJson(res, 200, current.storageInfo()); return true; }
      if (req.method === 'POST') { const body = await readJsonBody(req); if (body.action === 'backup') writeJson(res, 201, current.createBackup()); else if (body.action === 'restore') { const result = current.restoreBackup(String(body.id || '')); restoreConfig(cfg, registry, result.config); writeJson(res, 200, { restored: result.restored }); } else throw Object.assign(new Error('unknown storage action'), { statusCode: 400 }); return true; }
    }
    if (pathname.startsWith('/api/storage/backups/') && req.method === 'DELETE') {
      const id = decodeURIComponent(pathname.slice('/api/storage/backups/'.length));
      const backup = current.listBackups().find(item => item.id === id);
      if (!backup) throw Object.assign(new Error('backup not found'), { statusCode: 404 });
      const fs = await import('node:fs');
      fs.unlinkSync(backup.path);
      writeJson(res, 200, { deleted: id });
      return true;
    }
    if (pathname === '/api/integrations') {
      if (req.method === 'GET') { writeJson(res, 200, { integrations: current.listIntegrations() }); return true; }
      if (req.method === 'POST') { writeJson(res, 201, { integration: current.saveIntegration(await readJsonBody(req)) }); return true; }
    }
    if (pathname.startsWith('/api/integrations/') && ['PATCH', 'DELETE', 'POST'].includes(req.method)) {
      const parts = pathname.split('/').filter(Boolean);
      const id = decodeURIComponent(parts[2] || '');
      if (parts[3] === 'test' && req.method === 'POST') {
        const item = current.listIntegrations().find(value => value.id === id);
        if (!item) throw Object.assign(new Error('integration not found'), { statusCode: 404 });
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), INTEGRATION_TEST_TIMEOUT_MS);
        const started = Date.now();
        try {
          const webhook = item.type === 'webhook';
          const response = await fetch(item.baseUrl, {
            method: webhook ? 'POST' : 'GET',
            signal: controller.signal,
            headers: { accept: 'application/json', ...(webhook ? { 'content-type': 'application/json' } : {}) },
            ...(webhook ? { body: JSON.stringify({ event: 'gateway.integration_test', timestamp: new Date().toISOString() }) } : {}),
          });
          if (!response.ok) response.body?.cancel?.().catch?.(() => {});
          writeJson(res, response.ok ? 200 : 502, {
            ok: response.ok,
            status: response.status,
            ...(response.ok ? {} : { error: { message: `upstream returned HTTP ${response.status}` } }),
            latencyMs: Date.now() - started,
            integrationId: id,
          });
        } catch (error) {
          throw integrationTestError(error);
        } finally { clearTimeout(timer); }
        return true;
      }
      const existing = current.listIntegrations().find(value => value.id === id);
      if (!existing) throw Object.assign(new Error('integration not found'), { statusCode: 404 });
      if (req.method === 'DELETE') { current.deleteIntegration(id); writeJson(res, 200, { deleted: id }); return true; }
      writeJson(res, 200, { integration: current.saveIntegration(await readJsonBody(req), id) });
      return true;
    }
    if (pathname === '/api/subagents') {
      if (req.method === 'GET') { writeJson(res, 200, { subagents: subagentResponse(current, codexAgentProjector, cfg) }); return true; }
      if (req.method === 'POST') {
        writeJson(res, 201, { subagent: saveSubagent(current, cfg, await readJsonBody(req)) });
        return true;
      }
    }
    if (pathname.startsWith('/api/subagents/') && ['PATCH', 'DELETE'].includes(req.method)) {
      const parts = pathname.split('/').filter(Boolean);
      const id = decodeURIComponent(parts[2] || '');
      if (parts.length > 3) return false;
      if (req.method === 'DELETE') { deleteSubagent(current, cfg, id); writeJson(res, 200, { deleted: id }); return true; }
      writeJson(res, 200, { subagent: saveSubagent(current, cfg, await readJsonBody(req), id) });
      return true;
    }
    return false;
  };
}
