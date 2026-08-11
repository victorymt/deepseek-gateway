'use strict';

export function createProviderRoutes(services) {
  const {
    commitProviderConfig,
    managementValidation,
    nextProviderConfig,
    normalizeProvider,
    providerModelAlias,
    publicProviderConfig,
    readJsonBody,
    testProviderConnection,
    writeJson,
  } = services;

  async function handleCollection({
    cfg,
    registry,
    req,
    res,
    pathname,
  }) {
    if (pathname !== '/api/providers') return false;

    if (req.method === 'GET') {
      writeJson(res, 200, publicProviderConfig(cfg));
      return true;
    }

    if (req.method === 'POST') {
      const payload = await readJsonBody(req);
      const provider = managementValidation(
        () => normalizeProvider(payload),
      );
      if (cfg.providers.some(item => item.id === provider.id)) {
        throw Object.assign(
          new Error(`provider ${provider.id} already exists`),
          { statusCode: 409 },
        );
      }
      const makeDefault =
        cfg.setupPending || payload.makeDefault === true;
      const changes = makeDefault
        ? {
            setupPending: false,
            defaultProvider: provider.id,
            defaultModel: String(
              payload.defaultModel
                || providerModelAlias(
                  provider.id,
                  provider.models[0].id,
                ),
            ),
          }
        : {};
      const next = managementValidation(
        () => nextProviderConfig(
          cfg,
          [...cfg.providers, provider],
          changes,
        ),
      );
      commitProviderConfig(cfg, registry, next);
      writeJson(res, 201, publicProviderConfig(cfg));
      return true;
    }

    return false;
  }

  async function handleProvider({
    cfg,
    registry,
    req,
    res,
    parts,
  }) {
    if (parts.length !== 3 || parts[1] !== 'providers') {
      return false;
    }

    const providerId = parts[2];
    const existing = cfg.providers.find(
      provider => provider.id === providerId,
    );
    if (!existing) {
      throw Object.assign(
        new Error(`provider ${providerId} not found`),
        { statusCode: 404 },
      );
    }

    if (req.method === 'PATCH') {
      const payload = await readJsonBody(req);
      const current = cfg.providers.find(
        provider => provider.id === providerId,
      );
      if (!current) {
        throw Object.assign(
          new Error(`provider ${providerId} no longer exists`),
          { statusCode: 409 },
        );
      }
      if (payload.id && payload.id !== providerId) {
        throw Object.assign(
          new Error('provider id cannot be changed'),
          { statusCode: 400 },
        );
      }
      const provider = managementValidation(
        () => normalizeProvider(
          { ...current, ...payload, id: providerId },
          current,
        ),
      );
      const providers = cfg.providers.map(
        item => item.id === providerId ? provider : item,
      );
      const changes = {};
      if (payload.makeDefault === true) {
        changes.defaultProvider = providerId;
        changes.defaultModel = String(
          payload.defaultModel
            || providerModelAlias(
              providerId,
              provider.models[0].id,
            ),
        );
      } else if (cfg.defaultProvider === providerId) {
        const aliases = new Set(
          provider.models.map(
            model => providerModelAlias(providerId, model.id),
          ),
        );
        changes.defaultModel = aliases.has(
          payload.defaultModel || cfg.defaultModel,
        )
          ? (payload.defaultModel || cfg.defaultModel)
          : providerModelAlias(
            providerId,
            provider.models[0].id,
          );
      }
      const next = managementValidation(
        () => nextProviderConfig(cfg, providers, changes),
      );
      commitProviderConfig(cfg, registry, next);
      writeJson(res, 200, publicProviderConfig(cfg));
      return true;
    }

    if (req.method === 'DELETE') {
      const providers = cfg.providers.filter(
        provider => provider.id !== providerId,
      );
      const changes = {};
      if (cfg.defaultProvider === providerId) {
        const replacement = providers.find(
          provider => provider.enabled,
        );
        if (replacement) {
          changes.defaultProvider = replacement.id;
          changes.defaultModel = providerModelAlias(
            replacement.id,
            replacement.models[0].id,
          );
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

  async function handleTest({ registry, req, res, parts }) {
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
      throw Object.assign(
        new Error(`provider ${parts[2]} not found`),
        { statusCode: 404 },
      );
    }
    const result = await testProviderConnection(runtime);
    writeJson(res, result.ok ? 200 : 502, result);
    return true;
  }

  return async function handleProviderRoute(context) {
    if (await handleCollection(context)) return true;
    if (await handleProvider(context)) return true;
    return handleTest(context);
  };
}
