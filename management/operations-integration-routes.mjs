'use strict';

const INTEGRATION_TEST_TIMEOUT_MS = 5000;

function integrationTestError(error) {
  if (error?.name === 'AbortError') {
    return Object.assign(new Error('integration test timed out'), { statusCode: 504 });
  }
  return Object.assign(
    new Error('integration test could not reach the upstream service'),
    { statusCode: 502 },
  );
}

export function createOperationsIntegrationRoutes({ readJsonBody, writeJson }) {
  return async function handleOperationsIntegrationRoute({ current, req, res, pathname }) {
    if (pathname === '/api/integrations') {
      if (req.method === 'GET') {
        writeJson(res, 200, { integrations: current.listIntegrations() });
        return true;
      }
      if (req.method === 'POST') {
        const input = await readJsonBody(req);
        writeJson(res, 201, { integration: current.saveIntegration(input) });
        return true;
      }
    }
    if (!pathname.startsWith('/api/integrations/') || !['PATCH', 'DELETE', 'POST'].includes(req.method)) {
      return false;
    }

    const parts = pathname.split('/').filter(Boolean);
    const id = decodeURIComponent(parts[2] || '');
    if (parts[3] === 'test' && req.method === 'POST') {
      const item = current.listIntegrations().find(value => value.id === id);
      if (!item) {
        throw Object.assign(new Error('integration not found'), { statusCode: 404 });
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), INTEGRATION_TEST_TIMEOUT_MS);
      const started = Date.now();
      try {
        const webhook = item.type === 'webhook';
        const response = await fetch(item.baseUrl, {
          method: webhook ? 'POST' : 'GET',
          signal: controller.signal,
          headers: {
            accept: 'application/json',
            ...(webhook ? { 'content-type': 'application/json' } : {}),
          },
          ...(webhook ? {
            body: JSON.stringify({
              event: 'gateway.integration_test',
              timestamp: new Date().toISOString(),
            }),
          } : {}),
        });
        if (!response.ok) response.body?.cancel?.().catch?.(() => {});
        writeJson(res, response.ok ? 200 : 502, {
          ok: response.ok,
          status: response.status,
          ...(response.ok
            ? {}
            : { error: { message: `upstream returned HTTP ${response.status}` } }),
          latencyMs: Date.now() - started,
          integrationId: id,
        });
      } catch (error) {
        throw integrationTestError(error);
      } finally {
        clearTimeout(timer);
      }
      return true;
    }

    const existing = current.listIntegrations().find(value => value.id === id);
    if (!existing) {
      throw Object.assign(new Error('integration not found'), { statusCode: 404 });
    }
    if (req.method === 'DELETE') {
      current.deleteIntegration(id);
      writeJson(res, 200, { deleted: id });
      return true;
    }
    const input = await readJsonBody(req);
    writeJson(res, 200, { integration: current.saveIntegration(input, id) });
    return true;
  };
}
