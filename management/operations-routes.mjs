'use strict';

import { createOperationsIntegrationRoutes } from './operations-integration-routes.mjs';
import { createOperationsStorageRoutes } from './operations-storage-routes.mjs';
import { createOperationsSubagentRoutes } from './operations-subagent-routes.mjs';
import { createOperationsTelemetryRoutes } from './operations-telemetry-routes.mjs';

export function createOperationsRoutes(services) {
  const { operations, stopGateway, writeJson } = services;
  const store = () => typeof operations === 'function' ? operations() : operations;
  const handlers = [
    createOperationsTelemetryRoutes(services),
    createOperationsStorageRoutes(services),
    createOperationsIntegrationRoutes(services),
    createOperationsSubagentRoutes(services),
  ];

  return async function handleOperationsRoute(context) {
    const current = store();
    if (!current) return false;
    const { req, res, pathname } = context;
    if (pathname === '/api/runtime/stop' && req.method === 'POST') {
      writeJson(res, 202, { stopping: true });
      setTimeout(() => stopGateway(), 250);
      return true;
    }
    for (const handler of handlers) {
      if (await handler({ ...context, current })) return true;
    }
    return false;
  };
}
