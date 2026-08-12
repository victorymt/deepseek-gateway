'use strict';

export function createToolRoutes(services) {
  const {
    buildCodexArtifacts,
    fetchProviderModels,
    managementValidation,
    modelCapabilityCatalog,
    readJsonBody,
    resolveBalanceTestInput,
    resolveModelFetchInput,
    serializableConfig,
    testBalanceQuery,
    writeJson,
  } = services;

  return async function handleToolRoute({
    cfg,
    registry,
    req,
    res,
    pathname,
  }) {
    if (pathname === '/api/models' && req.method === 'POST') {
      const payload = await readJsonBody(req);
      const input = managementValidation(
        () => resolveModelFetchInput(cfg, registry, payload),
      );
      const models = await fetchProviderModels(
        input.baseUrl,
        input.secret,
        input.modelsUrl,
      );
      writeJson(res, 200, { models });
      return true;
    }

    if (pathname === '/api/model-capabilities' && req.method === 'GET') {
      writeJson(res, 200, modelCapabilityCatalog());
      return true;
    }

    if (pathname === '/api/balance/test' && req.method === 'POST') {
      const payload = await readJsonBody(req);
      const input = managementValidation(
        () => resolveBalanceTestInput(cfg, registry, payload),
      );
      try {
        writeJson(res, 200, await testBalanceQuery(cfg, input));
      } catch (error) {
        if (!error.statusCode) error.statusCode = 502;
        throw error;
      }
      return true;
    }

    if (pathname === '/api/codex/config' && req.method === 'GET') {
      if (cfg.setupPending) {
        throw Object.assign(
          new Error(
            'complete gateway setup before generating Codex configuration',
          ),
          { statusCode: 409 },
        );
      }
      const gatewayUrl = `${req.socket.encrypted ? 'https' : 'http'}://${req.headers.host}`;
      const artifacts = buildCodexArtifacts(serializableConfig(cfg), {
        gatewayUrl,
        authRequired: Boolean(cfg.token),
      });
      writeJson(res, 200, artifacts);
      return true;
    }

    return false;
  };
}
