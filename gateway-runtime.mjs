#!/usr/bin/env node
'use strict';

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const RUNTIME_SCHEMA_VERSION = 1;

function canonicalConfigPath(configPath) {
  const resolved = path.resolve(configPath);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

function runtimeDirectory(env = process.env) {
  const xdgRuntime = env.XDG_RUNTIME_DIR;
  if (xdgRuntime && path.isAbsolute(xdgRuntime)) {
    return path.join(xdgRuntime, 'deepseek-gateway');
  }
  const uid = typeof process.getuid === 'function' ? process.getuid() : 'user';
  return path.join(os.tmpdir(), `deepseek-gateway-${uid}`);
}

function ensurePrivateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`gateway runtime path is not a private directory: ${directory}`);
  }
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new Error(`gateway runtime directory is owned by another user: ${directory}`);
  }
  if ((stat.mode & 0o077) !== 0) fs.chmodSync(directory, 0o700);
}

function validateRuntimeRecord(record, expectedConfigPath) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new Error('runtime record must be a JSON object');
  }
  if (record.schemaVersion !== RUNTIME_SCHEMA_VERSION) {
    throw new Error(`unsupported runtime record schema: ${record.schemaVersion}`);
  }
  if (!Number.isSafeInteger(record.pid) || record.pid <= 1) {
    throw new Error('runtime record contains an invalid pid');
  }
  if (typeof record.instanceId !== 'string' || !/^[a-zA-Z0-9-]{16,128}$/.test(record.instanceId)) {
    throw new Error('runtime record contains an invalid instance id');
  }
  if (typeof record.configPath !== 'string' || !path.isAbsolute(record.configPath)) {
    throw new Error('runtime record contains an invalid config path');
  }
  if (record.configPath !== expectedConfigPath) {
    throw new Error('runtime record belongs to a different config');
  }
  if (typeof record.host !== 'string' || !record.host) {
    throw new Error('runtime record contains an invalid host');
  }
  if (!Number.isInteger(record.port) || record.port < 0 || record.port > 65535) {
    throw new Error('runtime record contains an invalid port');
  }
  if (!Number.isSafeInteger(record.startedAt) || record.startedAt <= 0) {
    throw new Error('runtime record contains an invalid start time');
  }
  return record;
}

function readRecordFile(filePath, expectedConfigPath) {
  let stat;
  try {
    stat = fs.lstatSync(filePath);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`gateway runtime record is not a regular file: ${filePath}`);
  }
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new Error(`gateway runtime record is owned by another user: ${filePath}`);
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new Error(`gateway runtime record permissions are too broad: ${filePath}`);
  }
  try {
    return validateRuntimeRecord(JSON.parse(fs.readFileSync(filePath, 'utf8')), expectedConfigPath);
  } catch (error) {
    throw new Error(`invalid gateway runtime record ${filePath}: ${error.message}`);
  }
}

function writeRecordAtomic(filePath, record) {
  validateRuntimeRecord(record, record.configPath);
  const tempPath = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tempPath, `${JSON.stringify(record)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    fs.renameSync(tempPath, filePath);
  } finally {
    try {
      fs.unlinkSync(tempPath);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}

export function gatewayRuntimeRecordPath(configPath, env = process.env) {
  const canonicalPath = canonicalConfigPath(configPath);
  const name = crypto.createHash('sha256').update(canonicalPath).digest('hex').slice(0, 24);
  return path.join(runtimeDirectory(env), `${name}.json`);
}

export function gatewayProcessIsRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    if (error.code === 'EPERM') return true;
    throw error;
  }
}

export function readGatewayRuntime(configPath, env = process.env) {
  const canonicalPath = canonicalConfigPath(configPath);
  const filePath = gatewayRuntimeRecordPath(canonicalPath, env);
  const record = readRecordFile(filePath, canonicalPath);
  return record ? { filePath, record } : null;
}

export function claimGatewayRuntime({
  configPath,
  instanceId,
  host,
  port,
  startedAt = Date.now(),
}, env = process.env) {
  const canonicalPath = canonicalConfigPath(configPath);
  const filePath = gatewayRuntimeRecordPath(canonicalPath, env);
  ensurePrivateDirectory(path.dirname(filePath));

  const existing = readRecordFile(filePath, canonicalPath);
  if (existing && gatewayProcessIsRunning(existing.pid)) {
    throw new Error(`gateway is already running for this config (pid ${existing.pid})`);
  }
  if (existing) fs.unlinkSync(filePath);

  const record = validateRuntimeRecord({
    schemaVersion: RUNTIME_SCHEMA_VERSION,
    pid: process.pid,
    instanceId,
    configPath: canonicalPath,
    host,
    port,
    startedAt,
  }, canonicalPath);
  try {
    fs.writeFileSync(filePath, `${JSON.stringify(record)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
  } catch (error) {
    if (error.code === 'EEXIST') {
      throw new Error('another gateway claimed this config while starting');
    }
    throw error;
  }
  return { filePath, record };
}

export function updateGatewayRuntime(handle, updates) {
  const current = readRecordFile(handle.filePath, handle.record.configPath);
  if (
    !current
    || current.pid !== handle.record.pid
    || current.instanceId !== handle.record.instanceId
  ) {
    throw new Error('gateway runtime record ownership changed while starting');
  }
  const record = {
    ...current,
    ...updates,
    pid: current.pid,
    instanceId: current.instanceId,
    configPath: current.configPath,
  };
  writeRecordAtomic(handle.filePath, record);
  return { filePath: handle.filePath, record };
}

export function releaseGatewayRuntime(handle) {
  if (!handle) return false;
  try {
    const current = readRecordFile(handle.filePath, handle.record.configPath);
    if (
      !current
      || current.pid !== handle.record.pid
      || current.instanceId !== handle.record.instanceId
    ) {
      return false;
    }
    fs.unlinkSync(handle.filePath);
    return true;
  } catch {
    return false;
  }
}
