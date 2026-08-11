'use strict';

import { createProviderKeyRoutes } from './management/provider-key-routes.mjs';
import { createProviderRoutes } from './management/provider-routes.mjs';
import { createSettingsRoutes } from './management/settings-routes.mjs';
import { createToolRoutes } from './management/tool-routes.mjs';

export function createManagementApi(services) {
  const { sameOrigin, writeJson } = services;
  const handlers = [
    createToolRoutes(services),
    createSettingsRoutes(services),
    createProviderRoutes(services),
    createProviderKeyRoutes(services),
  ];

  return async function handleManagementApi(
    cfg,
    registry,
    req,
    res,
    parsedUrl,
  ) {
    const pathname = parsedUrl.pathname;
    let parts;
    try {
      parts = pathname
        .split('/')
        .filter(Boolean)
        .map(decodeURIComponent);
    } catch {
      writeJson(res, 400, {
        error: { message: 'management path contains invalid percent encoding' },
      });
      return true;
    }
    if (parts[0] !== 'api') return false;

    if (!['GET', 'HEAD'].includes(req.method) && !sameOrigin(req)) {
      writeJson(res, 403, {
        error: {
          message: 'cross-origin management request rejected',
        },
      });
      return true;
    }

    const context = {
      cfg,
      registry,
      req,
      res,
      pathname,
      parts,
    };
    for (const handler of handlers) {
      if (await handler(context)) return true;
    }

    writeJson(res, 404, {
      error: { message: 'management endpoint not found' },
    });
    return true;
  };
}
