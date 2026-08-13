'use strict';

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { normalizeStoredCodexAgent } from '../codex-agent-config.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;
const LOG_RETENTION_DAYS = 7;
const USAGE_RETENTION_DAYS = 30;
const BACKUP_LIMIT = 5;
const PERSIST_DELAY_MS = 200;
const STORAGE_SCHEMA_VERSION = 2;
const LOCK_WAIT_MS = 5;
const LOCK_TIMEOUT_MS = 2000;
const LOCK_STALE_MS = 30000;

function safeRead(file, fallback, { quarantine = true } = {}) {
  let content;
  try {
    content = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      console.error(`ERROR: Cannot read gateway operations JSON: ${error.message}`);
    }
    return fallback;
  }
  try {
    return JSON.parse(content);
  } catch (error) {
    if (quarantine) {
      try {
        const corrupt = `${file}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
        fs.renameSync(file, corrupt);
        console.error(`ERROR: Invalid gateway operations JSON moved to ${corrupt}`);
      } catch {
        console.error(`ERROR: Cannot quarantine invalid gateway operations JSON: ${error.message}`);
      }
    }
    return fallback;
  }
}

function acquireLock(file) {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  while (true) {
    try {
      return fs.openSync(file, 'wx', 0o600);
    } catch (error) {
      if (error?.code !== 'EEXIST' || Date.now() >= deadline) {
        throw Object.assign(new Error(`cannot acquire operations storage lock: ${error.message}`), { statusCode: 503 });
      }
      try {
        if (Date.now() - fs.statSync(file).mtimeMs > LOCK_STALE_MS) fs.unlinkSync(file);
      } catch {}
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, LOCK_WAIT_MS);
    }
  }
}

// Read the on-disk state for the read-modify-write merge inside writeAtomic.
// Unlike the startup path (which quarantines with `quarantine: true`), a
// corrupt file here used to be treated as `{}` and then overwritten, silently
// dropping all external data (other instances' usage/logs). Quarantine the
// corrupt file first so it can be recovered instead of lost.
function safeReadForMerge(file) {
  let content;
  try {
    content = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      console.error(`ERROR: Cannot read gateway operations JSON: ${error.message}`);
    }
    return {};
  }
  try {
    return JSON.parse(content);
  } catch (error) {
    try {
      const corrupt = `${file}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
      fs.renameSync(file, corrupt);
      console.error(`ERROR: Invalid gateway operations JSON moved to ${corrupt} before merge; existing data is preserved for recovery`);
    } catch {
      console.error(`ERROR: Cannot quarantine invalid gateway operations JSON: ${error.message}`);
    }
    return {};
  }
}

function writeAtomic(file, buildValue) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const lock = `${file}.lock`;
  const lockFd = acquireLock(lock);
  const temp = path.join(dir, `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(5).toString('hex')}.tmp`);
  let value;
  try {
    value = typeof buildValue === 'function'
      ? buildValue(safeReadForMerge(file))
      : buildValue;
    fs.writeFileSync(temp, `${JSON.stringify({ schemaVersion: STORAGE_SCHEMA_VERSION, ...value }, null, 2)}\n`, { mode: 0o600 });
    fs.chmodSync(temp, 0o600);
    fs.renameSync(temp, file);
  } catch (error) {
    try { fs.unlinkSync(temp); } catch {}
    throw error;
  } finally {
    try { fs.closeSync(lockFd); } catch {}
    try { fs.unlinkSync(lock); } catch {}
  }
  return value;
}

const USAGE_GROUPS = ['providers', 'models'];

function mergeTotals(local = {}, external = {}, baseline = {}) {
  const merged = {};
  for (const key of ['requests', 'success', 'errors', 'ratelimited', 'tokens']) {
    const delta = (Number(local[key]) || 0) - (Number(baseline[key]) || 0);
    merged[key] = Math.max(0, (Number(external[key]) || 0) + delta);
  }
  for (const group of USAGE_GROUPS) {
    merged[group] = {};
    const names = new Set([
      ...Object.keys(external[group] || {}),
      ...Object.keys(local[group] || {}),
    ]);
    for (const name of names) {
      merged[group][name] = mergeTotals(
        local[group]?.[name],
        external[group]?.[name],
        baseline[group]?.[name],
      );
      for (const nestedGroup of USAGE_GROUPS) delete merged[group][name][nestedGroup];
    }
  }
  return merged;
}

function mergeDeletionMaps(local = {}, external = {}) {
  const merged = { ...external };
  for (const [id, timestamp] of Object.entries(local)) {
    merged[id] = Math.max(Number(merged[id]) || 0, Number(timestamp) || 0);
  }
  return merged;
}

function mergeRecords(local, external, deleted) {
  const records = new Map();
  for (const item of [...external, ...local]) {
    if (!item?.id || Number(deleted[item.id]) >= Number(item.updatedAt || item.createdAt || 0)) continue;
    const current = records.get(item.id);
    if (!current || Number(item.updatedAt) >= Number(current.updatedAt)) records.set(item.id, item);
  }
  return [...records.values()];
}

function normalizeLogRecord(value = {}) {
  const { agentId: _agentId, agentName: _agentName, ...record } = value;
  return record;
}

function mergeState(local, external, baseline) {
  if (!external || typeof external !== 'object') return local;
  const logsClearedAt = Math.max(Number(local.logsClearedAt) || 0, Number(external.logsClearedAt) || 0);
  const logs = new Map((Array.isArray(external.logs) ? external.logs : []).map(item => {
    const normalized = normalizeLogRecord(item);
    return [normalized.id, normalized];
  }));
  for (const item of local.logs) {
    const normalized = normalizeLogRecord(item);
    logs.set(normalized.id, normalized);
  }
  const deleted = {
    integrations: mergeDeletionMaps(local.deleted?.integrations, external.deleted?.integrations),
    subagents: mergeDeletionMaps(local.deleted?.subagents, external.deleted?.subagents),
  };
  const usage = {};
  const externalUsage = external.usage && typeof external.usage === 'object' ? external.usage : {};
  const cutoff = Date.now() - USAGE_RETENTION_DAYS * DAY_MS;
  for (const date of new Set([...Object.keys(externalUsage), ...Object.keys(local.usage)])) {
    if (Date.parse(`${date}T00:00:00Z`) < cutoff) continue;
    usage[date] = mergeTotals(local.usage[date], externalUsage[date], baseline.usage[date]);
  }
  return {
    // Audit entries are never removed by a log clear or by the retention
    // window; only the 5000-entry cap applies. Everything else is still
    // dropped past `logsClearedAt` and the retention cutoff.
    logs: [...logs.values()]
      .filter(item => (
        item.level === 'audit'
        || (Number(item.timestamp) > logsClearedAt && Number(item.timestamp) >= Date.now() - LOG_RETENTION_DAYS * DAY_MS)
      ))
      .sort((a, b) => Number(a.timestamp) - Number(b.timestamp))
      .slice(-5000),
    usage,
    integrations: mergeRecords(local.integrations, Array.isArray(external.integrations) ? external.integrations : [], deleted.integrations),
    subagents: mergeRecords(local.subagents, Array.isArray(external.subagents) ? external.subagents : [], deleted.subagents),
    deleted,
    logsClearedAt,
  };
}

function dayKey(timestamp = Date.now()) {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function emptyTotals() {
  return { requests: 0, success: 0, errors: 0, ratelimited: 0, tokens: 0 };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function encodeLogCursor(item) {
  return Buffer.from(JSON.stringify({ timestamp: Number(item.timestamp), id: String(item.id) })).toString('base64url');
}

function decodeLogCursor(value) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(String(value), 'base64url').toString('utf8'));
    if (!Number.isFinite(Number(parsed.timestamp)) || typeof parsed.id !== 'string' || !parsed.id) throw new Error();
    return { timestamp: Number(parsed.timestamp), id: parsed.id };
  } catch {
    throw Object.assign(new Error('invalid logs cursor'), { statusCode: 400 });
  }
}

export function createOperationsStore(configPath) {
  const directory = path.dirname(path.resolve(configPath));
  const file = path.join(directory, 'gateway-operations.json');
  const initial = safeRead(file, {});
  const migrated = initial && typeof initial === 'object' ? initial : {};
  if (Number(migrated.schemaVersion) > STORAGE_SCHEMA_VERSION) {
    throw new Error(`gateway operations schema ${migrated.schemaVersion} is newer than supported schema ${STORAGE_SCHEMA_VERSION}`);
  }
  const state = {
    logs: Array.isArray(migrated.logs) ? migrated.logs.map(normalizeLogRecord) : [],
    usage: migrated.usage && typeof migrated.usage === 'object' ? migrated.usage : {},
    integrations: Array.isArray(migrated.integrations) ? migrated.integrations : [],
    subagents: Array.isArray(migrated.subagents)
      ? migrated.subagents.map(normalizeStoredCodexAgent)
      : [],
    deleted: {
      integrations: migrated.deleted?.integrations && typeof migrated.deleted.integrations === 'object' ? migrated.deleted.integrations : {},
      subagents: migrated.deleted?.subagents && typeof migrated.deleted.subagents === 'object' ? migrated.deleted.subagents : {},
    },
    logsClearedAt: Number(migrated.logsClearedAt) || 0,
  };
  let persistTimer = null;
  let dirty = false;
  let persistedState = clone(state);

  function flush() {
    if (persistTimer) {
      clearTimeout(persistTimer);
      persistTimer = null;
    }
    if (!dirty) return;
    const merged = writeAtomic(file, external => mergeState(state, external, persistedState));
    Object.assign(state, clone(merged));
    persistedState = clone(merged);
    dirty = false;
  }

  function schedulePersist() {
    dirty = true;
    if (persistTimer) return;
    persistTimer = setTimeout(() => {
      persistTimer = null;
      try { flush(); } catch (error) {
        console.error(`ERROR: Cannot persist gateway operations: ${error.message}`);
      }
    }, PERSIST_DELAY_MS);
    persistTimer.unref?.();
  }

  function persist() {
    dirty = true;
    flush();
  }

  function prune() {
    const cutoff = Date.now() - LOG_RETENTION_DAYS * DAY_MS;
    state.logs = state.logs
      .filter(item => item.level === 'audit' || Number(item.timestamp) >= cutoff)
      .slice(-5000);
    const usageCutoff = Date.now() - USAGE_RETENTION_DAYS * DAY_MS;
    for (const key of Object.keys(state.usage)) {
      if (Date.parse(`${key}T00:00:00Z`) < usageCutoff) delete state.usage[key];
    }
  }

  prune();
  if (migrated.schemaVersion !== STORAGE_SCHEMA_VERSION) dirty = true;

  function addLog(entry = {}) {
    const item = {
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      level: String(entry.level || 'info'),
      message: String(entry.message || ''),
      method: entry.method ? String(entry.method) : undefined,
      route: entry.route ? String(entry.route) : undefined,
      status: Number.isFinite(entry.status) ? entry.status : undefined,
      provider: entry.provider ? String(entry.provider) : undefined,
      model: entry.model ? String(entry.model) : undefined,
      latencyMs: Number.isFinite(entry.latencyMs) ? entry.latencyMs : undefined,
    };
    state.logs.push(item);
    prune();
    schedulePersist();
    return item;
  }

  function recordUsage(entry = {}) {
    const key = dayKey(entry.timestamp);
    const bucket = state.usage[key] ||= { ...emptyTotals(), providers: {}, models: {} };
    for (const group of USAGE_GROUPS) bucket[group] ||= {};
    bucket.requests += 1;
    if (entry.status >= 200 && entry.status < 400) bucket.success += 1;
    else if (entry.status === 429) bucket.ratelimited += 1;
    else bucket.errors += 1;
    bucket.tokens += Number(entry.tokens) || 0;
    for (const [group, name] of [
      ['providers', entry.provider],
      ['models', entry.model],
    ]) {
      if (!name) continue;
      const target = bucket[group][name] ||= emptyTotals();
      target.requests += 1;
      if (entry.status >= 200 && entry.status < 400) target.success += 1;
      else if (entry.status === 429) target.ratelimited += 1;
      else target.errors += 1;
      target.tokens += Number(entry.tokens) || 0;
    }
    schedulePersist();
  }

  function recordTokens(entry = {}) {
    const tokens = Number(entry.tokens);
    if (!Number.isFinite(tokens) || tokens <= 0) return;
    const key = dayKey(entry.timestamp);
    const bucket = state.usage[key] ||= { ...emptyTotals(), providers: {}, models: {} };
    for (const group of USAGE_GROUPS) bucket[group] ||= {};
    bucket.tokens += tokens;
    for (const [group, name] of [
      ['providers', entry.provider],
      ['models', entry.model],
    ]) {
      if (!name) continue;
      const target = bucket[group][name] ||= emptyTotals();
      target.tokens += tokens;
    }
    schedulePersist();
  }

  function listLogs(query = {}) {
    const get = key => typeof query.get === 'function' ? query.get(key) : query[key];
    const limit = Math.min(Math.max(Number(get('limit')) || 200, 1), 1000);
    const level = get('level') ? String(get('level')) : '';
    const search = get('search') ? String(get('search')).toLowerCase() : '';
    const filtered = state.logs.filter(item =>
      (!level || item.level === level)
      && (!get('provider') || item.provider === String(get('provider')))
      && (!search || JSON.stringify(item).toLowerCase().includes(search))
    );
    return filtered.slice(-limit).reverse().map(clone);
  }

  function listLogsPage(query = {}) {
    const get = key => typeof query.get === 'function' ? query.get(key) : query[key];
    const rawLimit = get('limit');
    if (
      rawLimit !== undefined
      && rawLimit !== null
      && (!/^\d+$/.test(String(rawLimit)) || Number(rawLimit) < 1)
    ) {
      throw Object.assign(new Error('logs limit must be a positive integer'), { statusCode: 400 });
    }
    const limit = Math.min(Math.max(Number(rawLimit) || 200, 1), 1000);
    const level = get('level') ? String(get('level')) : '';
    const provider = get('provider') ? String(get('provider')) : '';
    const model = get('model') ? String(get('model')) : '';
    const rawStatus = get('status');
    const status = rawStatus === undefined || rawStatus === null || rawStatus === '' ? null : Number(rawStatus);
    if (status !== null && (!Number.isInteger(status) || status < 100 || status > 599)) {
      throw Object.assign(new Error('logs status must be a valid HTTP status'), { statusCode: 400 });
    }
    const search = get('search') ? String(get('search')).toLowerCase() : '';
    const cursor = decodeLogCursor(get('cursor'));
    const filtered = state.logs.filter(item => {
      if (level && item.level !== level) return false;
      if (provider && item.provider !== provider) return false;
      if (model && item.model !== model) return false;
      if (status !== null && item.status !== status) return false;
      if (search && !JSON.stringify(item).toLowerCase().includes(search)) return false;
      if (cursor && !(Number(item.timestamp) < cursor.timestamp || (Number(item.timestamp) === cursor.timestamp && String(item.id) < cursor.id))) return false;
      return true;
    }).sort((a, b) => Number(b.timestamp) - Number(a.timestamp) || String(b.id).localeCompare(String(a.id)));
    const page = filtered.slice(0, limit).map(clone);
    const hasMore = filtered.length > limit;
    return {
      logs: page,
      total: state.logs.filter(item => {
        if (level && item.level !== level) return false;
        if (provider && item.provider !== provider) return false;
        if (model && item.model !== model) return false;
        if (status !== null && item.status !== status) return false;
        return !search || JSON.stringify(item).toLowerCase().includes(search);
      }).length,
      hasMore,
      nextCursor: hasMore && page.length ? encodeLogCursor(page.at(-1)) : null,
    };
  }

  function usage(range = '30d') {
    const days = range === '24h' ? 1 : range === '7d' ? 7 : 30;
    const cutoff = Date.now() - days * DAY_MS;
    const points = Object.entries(state.usage)
      .filter(([key]) => Date.parse(`${key}T00:00:00Z`) >= cutoff)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, value]) => {
        const point = {
          date,
          ...emptyTotals(),
          ...clone(value),
          providers: clone(value.providers || {}),
          models: clone(value.models || {}),
        };
        delete point.agents;
        return point;
      });
    const total = points.reduce((sum, point) => {
      for (const key of Object.keys(emptyTotals())) sum[key] += point[key] || 0;
      return sum;
    }, emptyTotals());
    const providers = {};
    const models = {};
    for (const point of points) {
      for (const [source, destination] of [
        [point.providers, providers],
        [point.models, models],
      ]) {
        for (const [name, values] of Object.entries(source || {})) {
          const target = destination[name] ||= emptyTotals();
          for (const key of Object.keys(emptyTotals())) target[key] += Number(values[key]) || 0;
        }
      }
    }
    return { range, total, points, providers, models };
  }

  function listBackups() {
    const target = path.resolve(configPath);
    const files = fs.existsSync(path.dirname(target)) ? fs.readdirSync(path.dirname(target)) : [];
    return files.filter(name => name.startsWith(`${path.basename(target)}.backup-`)).map(name => {
      const filePath = path.join(path.dirname(target), name);
      const stat = fs.statSync(filePath);
      return { id: name, path: filePath, createdAt: stat.mtimeMs, size: stat.size };
    }).sort((a, b) => b.createdAt - a.createdAt);
  }

  function createBackup() {
    const target = path.resolve(configPath);
    if (!fs.existsSync(target)) throw Object.assign(new Error('configuration file does not exist'), { statusCode: 409 });
    const prefix = `${path.basename(target)}.backup-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    let id = prefix;
    let suffix = 1;
    while (fs.existsSync(path.join(path.dirname(target), id))) {
      id = `${prefix}-${suffix++}`;
    }
    const destination = path.join(path.dirname(target), id);
    fs.copyFileSync(target, destination);
    fs.chmodSync(destination, 0o600);
    for (const backup of listBackups().slice(BACKUP_LIMIT)) {
      try { fs.unlinkSync(backup.path); } catch {}
    }
    return listBackups().find(item => item.id === id) || null;
  }

  function restoreBackup(id) {
    const backup = listBackups().find(item => item.id === id);
    if (!backup) throw Object.assign(new Error('backup not found'), { statusCode: 404 });
    const next = safeRead(backup.path, null, { quarantine: false });
    if (!next) throw Object.assign(new Error('backup is not valid JSON'), { statusCode: 400 });
    createBackup();
    return { restored: id, config: next };
  }

  function storageInfo() {
    const target = path.resolve(configPath);
    const stat = fs.existsSync(target) ? fs.statSync(target) : null;
    return { configPath: target, configExists: Boolean(stat), configSize: stat?.size || 0, operationsPath: file, schemaVersion: STORAGE_SCHEMA_VERSION, backups: listBackups(), retention: { logsDays: LOG_RETENTION_DAYS, usageDays: USAGE_RETENTION_DAYS, backupLimit: BACKUP_LIMIT } };
  }

  function listIntegrations() { return clone(state.integrations); }
  function saveIntegration(input, id = '') {
    const value = { id: id || crypto.randomUUID(), name: String(input.name || 'Integration').trim(), type: String(input.type || 'openai').trim(), baseUrl: String(input.baseUrl || '').trim(), enabled: input.enabled !== false, createdAt: input.createdAt || Date.now(), updatedAt: Date.now() };
    if (!value.name || !value.baseUrl) throw Object.assign(new Error('name and baseUrl are required'), { statusCode: 400 });
    if (!['openai', 'anthropic', 'webhook'].includes(value.type)) throw Object.assign(new Error('integration type must be openai, anthropic, or webhook'), { statusCode: 400 });
    try { const parsed = new URL(value.baseUrl); if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error(); } catch { throw Object.assign(new Error('baseUrl must be a valid HTTP(S) URL'), { statusCode: 400 }); }
    const index = state.integrations.findIndex(item => item.id === value.id);
    if (index >= 0) state.integrations[index] = { ...state.integrations[index], ...value };
    else state.integrations.push(value);
    delete state.deleted.integrations[value.id];
    persist();
    return clone(value);
  }
  function deleteIntegration(id) { state.integrations = state.integrations.filter(item => item.id !== id); state.deleted.integrations[id] = Date.now(); persist(); }
  function listSubagents() { return clone(state.subagents); }
  function saveSubagent(input, id = '') {
    const previous = state.subagents.find(item => item.id === id);
    const value = normalizeStoredCodexAgent({
      ...previous,
      ...input,
      id: id || input.id || crypto.randomUUID(),
      createdAt: previous?.createdAt || input.createdAt || Date.now(),
      updatedAt: Date.now(),
    });
    if (!value.name || !value.description || !value.providerId || !value.model || !value.developerInstructions.trim()) {
      throw Object.assign(new Error('name, description, providerId, model and developerInstructions are required'), { statusCode: 400 });
    }
    const index = state.subagents.findIndex(item => item.id === value.id);
    if (index >= 0) state.subagents[index] = { ...state.subagents[index], ...value };
    else state.subagents.push(value);
    delete state.deleted.subagents[value.id];
    persist();
    return clone(value);
  }
  function deleteSubagent(id) { state.subagents = state.subagents.filter(item => item.id !== id); state.deleted.subagents[id] = Date.now(); persist(); }

  function clearLogs() {
    // Clearing runtime logs must not erase the security audit trail.
    state.logs = state.logs.filter(item => item.level === 'audit');
    state.logsClearedAt = Date.now();
    persist();
  }

  return { addLog, recordUsage, recordTokens, flush, listLogs, listLogsPage, clearLogs, usage, storageInfo, listBackups, createBackup, restoreBackup, listIntegrations, saveIntegration, deleteIntegration, listSubagents, saveSubagent, deleteSubagent };
}
