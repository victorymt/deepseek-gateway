'use strict';

export function createManagementApi(services) {
  const {
    buildCodexArtifacts,
    clearSessionCookie,
    commitProviderConfig,
    commitProviderKeys,
    commitSettingsConfig,
    effectiveBalanceQuery,
    fetchProviderModels,
    managementValidation,
    nextProviderConfig,
    nextSettingsConfig,
    normalizeProvider,
    prepareKeyImport,
    providerModelAlias,
    publicProviderConfig,
    publicSettings,
    readJsonBody,
    refreshKeyBalance,
    resolveBalanceTestInput,
    resolveModelFetchInput,
    resolveProviderKey,
    sameOrigin,
    serializableConfig,
    setSessionCookie,
    testBalanceQuery,
    testKeyConnection,
    testProviderConnection,
    writeJson,
  } = services;

  async function handleTopLevelRoute({ cfg, registry, req, res, pathname }) {
    if (pathname === '/api/models' && req.method === 'POST') {
      const payload = await readJsonBody(req);
      const input = managementValidation(() => resolveModelFetchInput(cfg, registry, payload));
      const models = await fetchProviderModels(input.baseUrl, input.secret, input.modelsUrl);
      writeJson(res, 200, { models });
      return true;
    }

    if (pathname === '/api/balance/test' && req.method === 'POST') {
      const payload = await readJsonBody(req);
      const input = managementValidation(() => resolveBalanceTestInput(cfg, registry, payload));
      try {
        writeJson(res, 200, await testBalanceQuery(cfg, input));
      } catch (error) {
        if (!error.statusCode) error.statusCode = 502;
        throw error;
      }
      return true;
    }

    if (pathname === '/api/providers' && req.method === 'GET') {
      writeJson(res, 200, publicProviderConfig(cfg));
      return true;
    }
    if (pathname === '/api/settings' && req.method === 'GET') {
      writeJson(res, 200, publicSettings(cfg));
      return true;
    }
    if (pathname === '/api/settings' && req.method === 'PATCH') {
      const payload = await readJsonBody(req);
      const next = managementValidation(() => nextSettingsConfig(cfg, payload));
      commitSettingsConfig(cfg, registry, next);
      if (Object.hasOwn(payload, 'token') || payload.clearToken === true) {
        if (cfg.token) setSessionCookie(res, cfg.token);
        else clearSessionCookie(res);
      }
      writeJson(res, 200, publicSettings(cfg));
      return true;
    }
    if (pathname === '/api/providers' && req.method === 'POST') {
      const payload = await readJsonBody(req);
      const provider = managementValidation(() => normalizeProvider(payload));
      if (cfg.providers.some(item => item.id === provider.id)) {
        throw Object.assign(
          new Error(`provider ${provider.id} already exists`),
          { statusCode: 409 },
        );
      }
      const makeDefault = cfg.setupPending || payload.makeDefault === true;
      const changes = makeDefault ? {
        setupPending: false,
        defaultProvider: provider.id,
        defaultModel: String(
          payload.defaultModel || providerModelAlias(provider.id, provider.models[0].id),
        ),
      } : {};
      const next = managementValidation(
        () => nextProviderConfig(cfg, [...cfg.providers, provider], changes),
      );
      commitProviderConfig(cfg, registry, next);
      writeJson(res, 201, publicProviderConfig(cfg));
      return true;
    }
    if (pathname === '/api/codex/config' && req.method === 'GET') {
      if (cfg.setupPending) {
        throw Object.assign(
          new Error('complete gateway setup before generating Codex configuration'),
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
  }

  async function handleProviderRoute({ cfg, registry, req, res, parts }) {
    if (parts.length !== 3 || parts[1] !== 'providers') return false;

    const providerId = parts[2];
    const existing = cfg.providers.find(provider => provider.id === providerId);
    if (!existing) {
      throw Object.assign(new Error(`provider ${providerId} not found`), { statusCode: 404 });
    }

    if (req.method === 'PATCH') {
      const payload = await readJsonBody(req);
      if (payload.id && payload.id !== providerId) {
        throw Object.assign(new Error('provider id cannot be changed'), { statusCode: 400 });
      }
      const provider = managementValidation(
        () => normalizeProvider({ ...existing, ...payload, id: providerId }, existing),
      );
      const providers = cfg.providers.map(item => item.id === providerId ? provider : item);
      const changes = {};
      if (payload.makeDefault === true) {
        changes.defaultProvider = providerId;
        changes.defaultModel = String(
          payload.defaultModel || providerModelAlias(providerId, provider.models[0].id),
        );
      } else if (cfg.defaultProvider === providerId) {
        const aliases = new Set(
          provider.models.map(model => providerModelAlias(providerId, model.id)),
        );
        changes.defaultModel = aliases.has(payload.defaultModel || cfg.defaultModel)
          ? (payload.defaultModel || cfg.defaultModel)
          : providerModelAlias(providerId, provider.models[0].id);
      }
      const next = managementValidation(() => nextProviderConfig(cfg, providers, changes));
      commitProviderConfig(cfg, registry, next);
      writeJson(res, 200, publicProviderConfig(cfg));
      return true;
    }

    if (req.method === 'DELETE') {
      const providers = cfg.providers.filter(provider => provider.id !== providerId);
      const changes = {};
      if (cfg.defaultProvider === providerId) {
        const replacement = providers.find(provider => provider.enabled);
        if (replacement) {
          changes.defaultProvider = replacement.id;
          changes.defaultModel = providerModelAlias(replacement.id, replacement.models[0].id);
        }
      }
      const next = managementValidation(
        () => nextProviderConfig(cfg, providers, changes),
        409,
      );
      commitProviderConfig(cfg, registry, next);
      writeJson(res, 200, publicProviderConfig(cfg));
      return true;
    }
    return false;
  }

  async function importProviderKeys({ cfg, registry, req, res, providerId }) {
    const provider = cfg.providers.find(item => item.id === providerId);
    if (!provider) {
      throw Object.assign(new Error(`provider ${providerId} not found`), { statusCode: 404 });
    }
    const payload = await readJsonBody(req);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw Object.assign(new Error('key import payload must be an object'), { statusCode: 400 });
    }
    const allowed = new Set(['keysText', 'defaults']);
    const unknown = Object.keys(payload).filter(field => !allowed.has(field));
    if (unknown.length) {
      throw Object.assign(
        new Error(`unknown key import fields: ${unknown.join(', ')}`),
        { statusCode: 400 },
      );
    }
    const prepared = managementValidation(
      () => prepareKeyImport(provider, payload.keysText, payload.defaults),
    );
    if (prepared.addedCount > 0) {
      commitProviderKeys(cfg, registry, provider, prepared.keys, 409);
    }
    const current = publicProviderConfig(cfg).providers.find(item => item.id === providerId);
    writeJson(res, 200, {
      addedCount: prepared.addedCount,
      ignoredCount: prepared.ignoredCount,
      ignored: prepared.ignored,
      totalCount: current?.keys.length || provider.keys.length,
    });
  }

  async function handleKeyAction({ cfg, registry, req, res, parts, provider, key }) {
    const providerId = parts[2];
    const keyName = parts[4];

    if (parts.length === 6 && parts[5] === 'test' && req.method === 'POST') {
      const runtime = registry.get(providerId);
      const runtimeKey = runtime?.pool.keys.find(item => item.name === keyName);
      if (!runtime || !runtimeKey) {
        throw Object.assign(
          new Error(`key ${keyName} is not active in provider ${providerId}`),
          { statusCode: 409 },
        );
      }
      const result = await testKeyConnection(runtime, runtimeKey);
      writeJson(res, result.ok ? 200 : 502, result);
      return true;
    }

    if (parts.length === 6 && parts[5] === 'balance' && req.method === 'POST') {
      const runtime = registry.get(providerId);
      const runtimeKey = runtime?.pool.keys.find(item => item.name === keyName);
      if (!runtime || !runtimeKey) {
        throw Object.assign(
          new Error(`key ${keyName} is not active in provider ${providerId}`),
          { statusCode: 409 },
        );
      }
      if (!effectiveBalanceQuery(runtime.provider)) {
        throw Object.assign(
          new Error(`balance query is not configured for provider ${providerId}`),
          { statusCode: 409 },
        );
      }
      try {
        await refreshKeyBalance(runtime, runtimeKey);
      } catch (error) {
        if (!error.statusCode) error.statusCode = 502;
        throw error;
      }
      const result = runtime.pool.stats().keys.find(item => item.name === keyName);
      writeJson(res, 200, result);
      return true;
    }

    if (parts.length === 5 && req.method === 'PATCH') {
      const payload = await readJsonBody(req);
      const allowed = new Set(['enabled', 'weight', 'alwaysTry']);
      const unknown = Object.keys(payload).filter(field => !allowed.has(field));
      if (unknown.length) {
        throw Object.assign(
          new Error(`unknown key settings: ${unknown.join(', ')}`),
          { statusCode: 400 },
        );
      }
      if (Object.hasOwn(payload, 'enabled') && typeof payload.enabled !== 'boolean') {
        throw Object.assign(new Error('key enabled must be a boolean'), { statusCode: 400 });
      }
      if (Object.hasOwn(payload, 'weight') && typeof payload.weight !== 'number') {
        throw Object.assign(new Error('key weight must be a number'), { statusCode: 400 });
      }
      if (Object.hasOwn(payload, 'alwaysTry') && typeof payload.alwaysTry !== 'boolean') {
        throw Object.assign(new Error('key alwaysTry must be a boolean'), { statusCode: 400 });
      }
      const updatedKey = {
        ...key,
        ...(Object.hasOwn(payload, 'enabled') ? { enabled: payload.enabled } : {}),
        ...(Object.hasOwn(payload, 'weight') ? { weight: payload.weight } : {}),
        ...(Object.hasOwn(payload, 'alwaysTry') ? { alwaysTry: payload.alwaysTry } : {}),
      };
      const keys = provider.keys.map(item => item.name === keyName ? updatedKey : item);
      const statusCode = payload.enabled === false ? 409 : 400;
      writeJson(res, 200, commitProviderKeys(cfg, registry, provider, keys, statusCode));
      return true;
    }

    if (parts.length === 5 && req.method === 'DELETE') {
      const keys = provider.keys.filter(item => item.name !== keyName);
      writeJson(res, 200, commitProviderKeys(cfg, registry, provider, keys, 409));
      return true;
    }
    return false;
  }

  async function handleProviderKeysRoute(context) {
    const { cfg, registry, req, res, parts } = context;
    if (parts.length < 5 || parts[1] !== 'providers' || parts[3] !== 'keys') {
      return false;
    }

    const providerId = parts[2];
    if (parts.length === 5 && parts[4] === 'import' && req.method === 'POST') {
      await importProviderKeys({ cfg, registry, req, res, providerId });
      return true;
    }

    const keyName = parts[4];
    const { provider, key } = resolveProviderKey(cfg, providerId, keyName);
    return handleKeyAction({ ...context, provider, key });
  }

  async function handleProviderTestRoute({ registry, req, res, parts }) {
    if (
      parts.length !== 4
      || parts[1] !== 'providers'
      || parts[3] !== 'test'
      || req.method !== 'POST'
    ) {
      return false;
    }
    const runtime = registry.get(parts[2]);
    if (!runtime) {
      throw Object.assign(new Error(`provider ${parts[2]} not found`), { statusCode: 404 });
    }
    const result = await testProviderConnection(runtime);
    writeJson(res, result.ok ? 200 : 502, result);
    return true;
  }

  return async function handleManagementApi(cfg, registry, req, res, parsedUrl) {
    const pathname = parsedUrl.pathname;
    const parts = pathname.split('/').filter(Boolean).map(decodeURIComponent);
    if (parts[0] !== 'api') return false;

    if (!['GET', 'HEAD'].includes(req.method) && !sameOrigin(req)) {
      writeJson(res, 403, { error: { message: 'cross-origin management request rejected' } });
      return true;
    }

    const context = { cfg, registry, req, res, pathname, parts };
    if (await handleTopLevelRoute(context)) return true;
    if (await handleProviderRoute(context)) return true;
    if (await handleProviderKeysRoute(context)) return true;
    if (await handleProviderTestRoute(context)) return true;

    writeJson(res, 404, { error: { message: 'management endpoint not found' } });
    return true;
  };
}
