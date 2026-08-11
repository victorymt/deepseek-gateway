'use strict';

export function createSettingsRoutes(services) {
  const {
    clearSessionCookie,
    commitSettingsConfig,
    managementValidation,
    nextSettingsConfig,
    publicSettings,
    readJsonBody,
    setSessionCookie,
    writeJson,
  } = services;

  return async function handleSettingsRoute({
    cfg,
    registry,
    req,
    res,
    pathname,
  }) {
    if (pathname !== '/api/settings') return false;

    if (req.method === 'GET') {
      writeJson(res, 200, publicSettings(cfg));
      return true;
    }

    if (req.method === 'PATCH') {
      const payload = await readJsonBody(req);
      const next = managementValidation(
        () => nextSettingsConfig(cfg, payload),
      );
      commitSettingsConfig(cfg, registry, next);
      if (
        Object.hasOwn(payload, 'token')
        || Object.hasOwn(payload, 'adminToken')
        || payload.clearToken === true
        || payload.clearAdminToken === true
      ) {
        if (cfg.adminToken) setSessionCookie(res, cfg.adminToken);
        else clearSessionCookie(res);
      }
      writeJson(res, 200, publicSettings(cfg));
      return true;
    }

    return false;
  };
}
