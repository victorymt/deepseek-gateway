'use strict';

export function createProviderKeyRoutes(services) {
  const {
    commitProviderKeys,
    effectiveBalanceQuery,
    managementValidation,
    prepareKeyImport,
    publicProviderConfig,
    readJsonBody,
    refreshKeyBalance,
    resolveProviderKey,
    testKeyConnection,
    writeJson,
  } = services;

  async function importProviderKeys({
    cfg,
    registry,
    req,
    res,
    providerId,
  }) {
    const payload = await readJsonBody(req);
    if (
      !payload
      || typeof payload !== 'object'
      || Array.isArray(payload)
    ) {
      throw Object.assign(
        new Error('key import payload must be an object'),
        { statusCode: 400 },
      );
    }
    const allowed = new Set(['keysText', 'defaults']);
    const unknown = Object.keys(payload).filter(
      field => !allowed.has(field),
    );
    if (unknown.length) {
      throw Object.assign(
        new Error(`unknown key import fields: ${unknown.join(', ')}`),
        { statusCode: 400 },
      );
    }
    const provider = cfg.providers.find(
      item => item.id === providerId,
    );
    if (!provider) {
      throw Object.assign(
        new Error(`provider ${providerId} not found`),
        { statusCode: 404 },
      );
    }
    const prepared = managementValidation(
      () => prepareKeyImport(
        provider,
        payload.keysText,
        payload.defaults,
      ),
    );
    if (prepared.addedCount > 0) {
      commitProviderKeys(
        cfg,
        registry,
        provider,
        prepared.keys,
        409,
      );
    }
    const current = publicProviderConfig(cfg).providers.find(
      item => item.id === providerId,
    );
    writeJson(res, 200, {
      addedCount: prepared.addedCount,
      ignoredCount: prepared.ignoredCount,
      ignored: prepared.ignored,
      totalCount: current?.keys.length || provider.keys.length,
    });
  }

  async function handleKeyAction({
    cfg,
    registry,
    req,
    res,
    parts,
    provider,
    key,
  }) {
    const providerId = parts[2];
    const keyName = parts[4];

    if (
      parts.length === 6
      && parts[5] === 'test'
      && req.method === 'POST'
    ) {
      const runtime = registry.get(providerId);
      const runtimeKey = runtime?.pool.keys.find(
        item => item.name === keyName,
      );
      if (!runtime || !runtimeKey) {
        throw Object.assign(
          new Error(
            `key ${keyName} is not active in provider ${providerId}`,
          ),
          { statusCode: 409 },
        );
      }
      const result = await testKeyConnection(runtime, runtimeKey);
      writeJson(res, result.ok ? 200 : 502, result);
      return true;
    }

    if (
      parts.length === 6
      && parts[5] === 'balance'
      && req.method === 'POST'
    ) {
      const runtime = registry.get(providerId);
      const runtimeKey = runtime?.pool.keys.find(
        item => item.name === keyName,
      );
      if (!runtime || !runtimeKey) {
        throw Object.assign(
          new Error(
            `key ${keyName} is not active in provider ${providerId}`,
          ),
          { statusCode: 409 },
        );
      }
      if (!effectiveBalanceQuery(runtime.provider)) {
        throw Object.assign(
          new Error(
            `balance query is not configured for provider ${providerId}`,
          ),
          { statusCode: 409 },
        );
      }
      try {
        await refreshKeyBalance(runtime, runtimeKey);
      } catch (error) {
        if (!error.statusCode) error.statusCode = 502;
        throw error;
      }
      const result = runtime.pool.stats().keys.find(
        item => item.name === keyName,
      );
      writeJson(res, 200, result);
      return true;
    }

    if (parts.length === 5 && req.method === 'PATCH') {
      const payload = await readJsonBody(req);
      const current = resolveProviderKey(cfg, providerId, keyName);
      const allowed = new Set([
        'enabled',
        'weight',
        'alwaysTry',
      ]);
      const unknown = Object.keys(payload).filter(
        field => !allowed.has(field),
      );
      if (unknown.length) {
        throw Object.assign(
          new Error(
            `unknown key settings: ${unknown.join(', ')}`,
          ),
          { statusCode: 400 },
        );
      }
      if (
        Object.hasOwn(payload, 'enabled')
        && typeof payload.enabled !== 'boolean'
      ) {
        throw Object.assign(
          new Error('key enabled must be a boolean'),
          { statusCode: 400 },
        );
      }
      if (
        Object.hasOwn(payload, 'weight')
        && typeof payload.weight !== 'number'
      ) {
        throw Object.assign(
          new Error('key weight must be a number'),
          { statusCode: 400 },
        );
      }
      if (
        Object.hasOwn(payload, 'alwaysTry')
        && typeof payload.alwaysTry !== 'boolean'
      ) {
        throw Object.assign(
          new Error('key alwaysTry must be a boolean'),
          { statusCode: 400 },
        );
      }
      const updatedKey = {
        ...current.key,
        ...(Object.hasOwn(payload, 'enabled')
          ? { enabled: payload.enabled }
          : {}),
        ...(Object.hasOwn(payload, 'weight')
          ? { weight: payload.weight }
          : {}),
        ...(Object.hasOwn(payload, 'alwaysTry')
          ? { alwaysTry: payload.alwaysTry }
          : {}),
      };
      const keys = current.provider.keys.map(
        item => item.name === keyName ? updatedKey : item,
      );
      const statusCode = payload.enabled === false ? 409 : 400;
      writeJson(
        res,
        200,
        commitProviderKeys(
          cfg,
          registry,
          current.provider,
          keys,
          statusCode,
        ),
      );
      return true;
    }

    if (parts.length === 5 && req.method === 'DELETE') {
      const keys = provider.keys.filter(
        item => item.name !== keyName,
      );
      writeJson(
        res,
        200,
        commitProviderKeys(
          cfg,
          registry,
          provider,
          keys,
          409,
        ),
      );
      return true;
    }

    return false;
  }

  return async function handleProviderKeysRoute(context) {
    const { cfg, registry, req, res, parts } = context;
    if (
      parts.length < 5
      || parts[1] !== 'providers'
      || parts[3] !== 'keys'
    ) {
      return false;
    }

    const providerId = parts[2];
    if (
      parts.length === 5
      && parts[4] === 'import'
      && req.method === 'POST'
    ) {
      await importProviderKeys({
        cfg,
        registry,
        req,
        res,
        providerId,
      });
      return true;
    }

    const keyName = parts[4];
    const { provider, key } = resolveProviderKey(
      cfg,
      providerId,
      keyName,
    );
    return handleKeyAction({ ...context, provider, key });
  };
}
