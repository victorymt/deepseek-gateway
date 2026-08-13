'use strict';

export function createOperationsTelemetryRoutes({ writeJson }) {
  return async function handleOperationsTelemetryRoute({ current, req, res, pathname }) {
    if (pathname === '/api/logs') {
      if (req.method === 'GET') {
        const searchParams = new URL(req.url, 'http://gateway.local').searchParams;
        writeJson(res, 200, current.listLogsPage(searchParams));
        return true;
      }
      if (req.method === 'DELETE') {
        current.clearLogs();
        writeJson(res, 200, { cleared: true });
        return true;
      }
    }
    if (pathname === '/api/usage' && req.method === 'GET') {
      const range = new URL(req.url, 'http://gateway.local').searchParams.get('range') || '30d';
      writeJson(res, 200, current.usage(range));
      return true;
    }
    return false;
  };
}
