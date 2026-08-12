'use strict';

import { createProviderKeyRoutes } from './management/provider-key-routes.mjs';
import { createProviderRoutes } from './management/provider-routes.mjs';
import { createSettingsRoutes } from './management/settings-routes.mjs';
import { createToolRoutes } from './management/tool-routes.mjs';
import { createOperationsRoutes } from './management/operations-routes.mjs';

export function createManagementApi(services) {
  const { sameOrigin, writeJson } = services;
  const operationsStore = () => typeof services.operations === 'function'
    ? services.operations()
    : services.operations;
  const audit = (req, pathname, status, message) => {
    try {
      operationsStore()?.addLog({
        level: 'audit',
        message,
        method: req.method,
        route: pathname,
        status,
      });
    } catch {}
  };
  const handlers = [
    createToolRoutes(services),
    createOperationsRoutes(services),
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
      audit(req, pathname, 403, 'management mutation rejected by origin policy');
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
    try {
      for (const handler of handlers) {
        if (await handler(context)) {
          if (!['GET', 'HEAD'].includes(req.method)) {
            audit(req, pathname, res.statusCode || 200, 'management mutation completed');
          }
          return true;
        }
      }
    } catch (error) {
      if (!['GET', 'HEAD'].includes(req.method)) {
        audit(req, pathname, error.statusCode || 500, 'management mutation failed');
      }
      throw error;
    }

    writeJson(res, 404, {
      error: { message: 'management endpoint not found' },
    });
    return true;
  };
}
