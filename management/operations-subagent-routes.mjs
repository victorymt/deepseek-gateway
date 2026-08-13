'use strict';

import crypto from 'node:crypto';

import {
  createCodexAgentProjector,
  validateCodexAgentInput,
} from '../codex-agent-config.mjs';

function subagentResponse(current, projector, config) {
  return current.listSubagents().map(subagent => ({
    ...subagent,
    projection: projector.inspect(subagent, config),
  }));
}

export function createOperationsSubagentRoutes({
  codexAgentProjector: configuredProjector,
  readJsonBody,
  writeJson,
}) {
  const projector = configuredProjector || createCodexAgentProjector();

  function saveSubagent(current, cfg, input, id = '') {
    const existing = id
      ? current.listSubagents().find(value => value.id === id)
      : null;
    if (id && !existing) {
      throw Object.assign(new Error('subagent not found'), { statusCode: 404 });
    }
    const validated = validateCodexAgentInput(cfg, input, existing);
    const duplicate = current.listSubagents().find(value => (
      value.name === validated.name && value.id !== id
    ));
    if (duplicate) {
      throw Object.assign(new Error('agent name is already configured'), { statusCode: 409 });
    }
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
    projector.reconcile(cfg, next);
    try {
      return current.saveSubagent(candidate, candidate.id);
    } catch (error) {
      try { projector.reconcile(cfg, previous, { force: true }); } catch {}
      throw error;
    }
  }

  function deleteSubagent(current, cfg, id) {
    const previous = current.listSubagents();
    const existing = previous.find(value => value.id === id);
    if (!existing) {
      throw Object.assign(new Error('subagent not found'), { statusCode: 404 });
    }
    projector.reconcile(cfg, previous.filter(value => value.id !== id));
    try {
      current.deleteSubagent(id);
    } catch (error) {
      try { projector.reconcile(cfg, previous, { force: true }); } catch {}
      throw error;
    }
  }

  return async function handleOperationsSubagentRoute({ current, cfg, req, res, pathname }) {
    if (pathname === '/api/subagents') {
      if (req.method === 'GET') {
        writeJson(res, 200, {
          subagents: subagentResponse(current, projector, cfg),
        });
        return true;
      }
      if (req.method === 'POST') {
        const input = await readJsonBody(req);
        writeJson(res, 201, {
          subagent: saveSubagent(current, cfg, input),
        });
        return true;
      }
    }
    if (!pathname.startsWith('/api/subagents/') || !['PATCH', 'DELETE'].includes(req.method)) {
      return false;
    }
    const parts = pathname.split('/').filter(Boolean);
    const id = decodeURIComponent(parts[2] || '');
    if (parts.length > 3) return false;
    if (req.method === 'DELETE') {
      deleteSubagent(current, cfg, id);
      writeJson(res, 200, { deleted: id });
      return true;
    }
    const input = await readJsonBody(req);
    writeJson(res, 200, {
      subagent: saveSubagent(current, cfg, input, id),
    });
    return true;
  };
}
