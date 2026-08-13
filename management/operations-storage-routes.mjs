'use strict';

export function createOperationsStorageRoutes({ readJsonBody, restoreConfig, writeJson }) {
  return async function handleOperationsStorageRoute({ current, cfg, registry, req, res, pathname }) {
    if (pathname === '/api/storage') {
      if (req.method === 'GET') {
        writeJson(res, 200, current.storageInfo());
        return true;
      }
      if (req.method === 'POST') {
        const body = await readJsonBody(req);
        if (body.action === 'backup') {
          const backup = current.createBackup();
          current.addLog({ level: 'audit', message: 'config backup created', method: req.method, route: pathname, status: 201 });
          writeJson(res, 201, backup);
        } else if (body.action === 'restore') {
          const result = current.restoreBackup(String(body.id || ''));
          current.addLog({ level: 'audit', message: `config restored from backup ${result.restored}`, method: req.method, route: pathname, status: 200 });
          restoreConfig(cfg, registry, result.config);
          writeJson(res, 200, { restored: result.restored });
        } else {
          throw Object.assign(new Error('unknown storage action'), { statusCode: 400 });
        }
        return true;
      }
    }
    if (pathname.startsWith('/api/storage/backups/') && req.method === 'DELETE') {
      const id = decodeURIComponent(pathname.slice('/api/storage/backups/'.length));
      const backup = current.listBackups().find(item => item.id === id);
      if (!backup) {
        throw Object.assign(new Error('backup not found'), { statusCode: 404 });
      }
      const fs = await import('node:fs');
      fs.unlinkSync(backup.path);
      current.addLog({ level: 'audit', message: `config backup deleted ${id}`, method: req.method, route: pathname, status: 200 });
      writeJson(res, 200, { deleted: id });
      return true;
    }
    return false;
  };
}
