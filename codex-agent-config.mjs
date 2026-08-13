'use strict';

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { codexModelAlias, normalizeConfig } from './config-core.mjs';
import { withFileLock } from './file-lock.mjs';

export const CODEX_AGENT_NAME_RE = /^[a-z][a-z0-9_]{0,63}$/;
export const CODEX_AGENT_MANIFEST = 'gateway-agents.json';
const MANIFEST_SCHEMA_VERSION = 2;

function httpError(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

function tomlString(value) {
  return JSON.stringify(String(value));
}

function hashContent(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function readFile(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function readManifest(file, options = {}) {
  const source = readFile(file);
  if (source === null) {
    return { schemaVersion: MANIFEST_SCHEMA_VERSION, owner: null, agents: {} };
  }
  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw httpError(`Codex agent manifest is not valid JSON: ${file}`, 409);
  }
  if (Number(parsed.schemaVersion) > MANIFEST_SCHEMA_VERSION) {
    throw httpError(`Codex agent manifest is newer than this gateway: ${file}`, 409);
  }
  const rawAgents = parsed.agents && typeof parsed.agents === 'object'
    && !Array.isArray(parsed.agents)
    ? parsed.agents
    : {};
  const agents = Object.create(null);
  const names = new Set();
  const backupRoot = path.resolve(
    options.backupRoot || path.join(path.dirname(file), 'backup-gateway', 'agents'),
  );
  for (const [id, entry] of Object.entries(rawAgents)) {
    const name = String(entry?.name || '');
    const hash = String(entry?.hash || '');
    const backupPath = entry?.backupPath ? path.resolve(String(entry.backupPath)) : null;
    if (!id || !CODEX_AGENT_NAME_RE.test(name) || !/^[0-9a-f]{64}$/.test(hash)) {
      throw httpError(`Codex agent manifest contains an invalid entry: ${id || '(empty)'}`, 409);
    }
    if (names.has(name)) {
      throw httpError(`Codex agent manifest contains a duplicate name: ${name}`, 409);
    }
    if (backupPath) {
      const relative = path.relative(backupRoot, backupPath);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
        throw httpError(`Codex agent manifest contains an invalid backup path: ${backupPath}`, 409);
      }
    }
    agents[id] = { name, hash, backupPath };
    names.add(name);
  }
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    owner: typeof parsed.owner === 'string' && parsed.owner ? parsed.owner : null,
    agents,
  };
}

/**
 * Identity stamp for the agent manifest. In production the config file path is
 * used so two gateway configs sharing one Codex home can never silently
 * delete each other's agents; when no config path exists (unit tests, direct
 * module use) the Codex home itself is the owner.
 */
function manifestOwner(config, codexHome) {
  const source = config?.configPath ? path.resolve(config.configPath) : codexHome;
  return crypto.createHash('sha256').update(source).digest('hex').slice(0, 16);
}

function writeAtomic(file, content, mode = 0o600) {
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temp = path.join(
    directory,
    `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(5).toString('hex')}.tmp`,
  );
  try {
    fs.writeFileSync(temp, content, { mode, flag: 'wx' });
    fs.chmodSync(temp, mode);
    fs.renameSync(temp, file);
  } finally {
    try { fs.unlinkSync(temp); } catch {}
  }
}

function backupFile(file, codexHome) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const directory = path.join(codexHome, 'backup-gateway', 'agents', stamp);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  let destination = path.join(directory, path.basename(file));
  for (let index = 1; fs.existsSync(destination); index++) {
    destination = path.join(directory, `${path.basename(file)}.${index}`);
  }
  fs.copyFileSync(file, destination, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(destination, 0o600);
  return destination;
}

function normalizeModelReference(agent) {
  const providerId = String(agent.providerId || '').trim();
  const value = String(agent.model || '').trim();
  const prefix = `${providerId}--`;
  return value.startsWith(prefix) ? value.slice(prefix.length) : value;
}

export function normalizeCodexAgentName(value, fallback = 'agent') {
  let name = String(value || '').trim().toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/-+/g, '_')
    .replace(/^_+/, '');
  if (!/^[a-z]/.test(name)) name = `agent_${name}`;
  name = name.slice(0, 64);
  if (!name || !CODEX_AGENT_NAME_RE.test(name)) {
    name = `agent_${String(fallback || '').replace(/[^a-z0-9]/gi, '').slice(0, 12).toLowerCase()}`;
  }
  return name;
}

export function normalizeStoredCodexAgent(input = {}) {
  const id = String(input.id || crypto.randomUUID());
  const legacy = typeof input.developerInstructions !== 'string'
    || typeof input.description !== 'string';
  const name = legacy
    ? normalizeCodexAgentName(input.name, id)
    : String(input.name || '').trim();
  return {
    id,
    name,
    description: String(
      input.description
      || (input.name ? `Specialist agent for ${input.name}.` : 'Gateway-managed Codex specialist.'),
    ).trim(),
    providerId: String(input.providerId || '').trim(),
    model: String(input.model || '').trim(),
    developerInstructions: String(
      input.developerInstructions
      ?? input.instructions
      ?? `Work as the ${name || 'specialist'} subagent. Return concise findings to the parent Codex session.`,
    ),
    enabled: input.enabled !== false,
    createdAt: Number(input.createdAt) || Number(input.updatedAt) || Date.now(),
    updatedAt: Number(input.updatedAt) || Date.now(),
  };
}

function resolveConfiguredCodexAgentTarget(config, agent) {
  const provider = config?.providers?.find(item => (
    item.id === String(agent?.providerId || '')
  ));
  if (!provider) return null;
  const requestedModel = normalizeModelReference(agent);
  const model = provider.models.find(item => item.id === requestedModel);
  return model ? { provider, model } : null;
}

export function resolveCodexAgentTarget(config, agent) {
  const target = resolveConfiguredCodexAgentTarget(config, agent);
  return target?.provider.enabled ? target : null;
}

export function validateCodexAgentInput(config, input, existing = null) {
  const name = normalizeCodexAgentName(input.name ?? existing?.name, existing?.id);
  const description = String(input.description ?? existing?.description ?? '').trim();
  const developerInstructions = String(
    input.developerInstructions
      ?? input.instructions
      ?? existing?.developerInstructions
      ?? existing?.instructions
      ?? '',
  ).trim();
  const providerId = String(input.providerId ?? existing?.providerId ?? '').trim();
  const model = String(input.model ?? existing?.model ?? '').trim();
  const enabled = input.enabled ?? existing?.enabled ?? true;

  if (!CODEX_AGENT_NAME_RE.test(name)) {
    throw httpError('agent name must use lowercase letters, numbers, and underscores, starting with a letter');
  }
  const effectiveDescription = description || `Specialist agent for ${name}.`;
  const effectiveInstructions = developerInstructions
    || `Work as the ${name} subagent. Return concise findings to the parent Codex session.`;
  if (effectiveDescription.length > 1000) throw httpError('agent description must not exceed 1000 characters');
  if (Buffer.byteLength(effectiveInstructions, 'utf8') > 64 * 1024) {
    throw httpError('agent developer instructions must not exceed 64 KiB');
  }
  const candidate = { name, description: effectiveDescription, developerInstructions: effectiveInstructions, providerId, model, enabled: enabled !== false };
  const retainsConfiguredTarget = existing
    && candidate.providerId === String(existing.providerId || '').trim()
    && normalizeModelReference(candidate) === normalizeModelReference(existing)
    && resolveConfiguredCodexAgentTarget(config, candidate);
  if (!resolveCodexAgentTarget(config, candidate) && !retainsConfiguredTarget) {
    throw httpError('agent model does not belong to an enabled provider');
  }
  return candidate;
}

export function buildCodexAgentToml(config, agent) {
  const target = resolveCodexAgentTarget(config, agent);
  if (!target) throw httpError(`agent ${agent.name} has no enabled provider model`, 409);
  return [
    `name = ${tomlString(agent.name)}`,
    `description = ${tomlString(agent.description)}`,
    `model = ${tomlString(codexModelAlias(target.provider.id, target.model.id))}`,
    `developer_instructions = ${tomlString(agent.developerInstructions)}`,
    '',
  ].join('\n');
}

export function codexAgentHome(options = {}) {
  return path.resolve(options.codexHome || process.env.CODEX_HOME || path.join(os.homedir(), '.codex'));
}

export function createCodexAgentProjector(options = {}) {
  const codexHome = codexAgentHome(options);
  const agentsDirectory = path.join(codexHome, 'agents');
  const manifestPath = path.join(codexHome, CODEX_AGENT_MANIFEST);

  function inspect(agent, config = null) {
    const manifest = readManifest(manifestPath);
    const managed = manifest.agents[agent.id] || null;
    const name = String(agent.name || managed?.name || '');
    const file = CODEX_AGENT_NAME_RE.test(name)
      ? path.join(agentsDirectory, `${name}.toml`)
      : null;
    const content = file ? readFile(file) : null;
    const expectedHash = managed?.hash || null;
    const currentHash = content === null ? null : hashContent(content);
    const available = !config || Boolean(resolveCodexAgentTarget(config, agent));
    return {
      codexHome,
      path: file,
      installed: Boolean(agent.enabled && available && content !== null && expectedHash && currentHash === expectedHash),
      status: !agent.enabled
        ? 'disabled'
        : !available
          ? 'unavailable'
        : content === null
          ? 'missing'
          : expectedHash && currentHash === expectedHash
            ? 'installed'
            : expectedHash
              ? 'modified'
              : 'unmanaged',
      backupPath: managed?.backupPath || null,
    };
  }

  function reconcile(config, agents, { force = false } = {}) {
    const ids = new Set();
    const names = new Map();
    for (const agent of agents) {
      const id = String(agent?.id || '').trim();
      const name = String(agent?.name || '').trim();
      if (!id) throw httpError('stored Codex agent is missing an id', 409);
      if (ids.has(id)) throw httpError(`stored Codex agent id is duplicated: ${id}`, 409);
      if (!CODEX_AGENT_NAME_RE.test(name)) {
        throw httpError(`stored Codex agent name is not canonical: ${name || '(empty)'}`, 409);
      }
      const owner = names.get(name);
      if (owner) {
        throw httpError(`Codex agent name ${name} is configured by both ${owner} and ${id}`, 409);
      }
      ids.add(id);
      names.set(name, id);
    }

    return withFileLock(`${manifestPath}.lock`, () => {
      if (!agents.length && readFile(manifestPath) === null) return [];
      const manifest = readManifest(manifestPath);
      const owner = manifestOwner(config, codexHome);
      if (manifest.owner !== null && manifest.owner !== owner) {
        throw httpError(
          `refusing to modify Codex agents under ${codexHome}: the agent manifest ${manifestPath} is owned by another gateway config (owner ${manifest.owner}). Set CODEX_HOME to a dedicated directory for this config, or remove the manifest to take over.`,
          409,
        );
      }
      if (manifest.owner === null && !agents.length) {
        throw httpError(
          `refusing to delete Codex agent file(s) under ${codexHome}: the agent manifest ${manifestPath} has no owner recorded and no agents are configured for this gateway config. Set CODEX_HOME explicitly to confirm ownership, or remove the manifest.`,
          409,
        );
      }
      const activeAgents = agents.filter(agent => agent.enabled && resolveCodexAgentTarget(config, agent));
      const desiredById = new Map(activeAgents.map(agent => [String(agent.id), agent]));
      const conflicts = [];

      for (const [id, managed] of Object.entries(manifest.agents)) {
        const desired = desiredById.get(id);
        const oldFile = path.join(agentsDirectory, `${managed.name}.toml`);
        const current = readFile(oldFile);
        if (current !== null && hashContent(current) !== managed.hash && !force) {
          conflicts.push(oldFile);
        }
      }
      for (const agent of activeAgents) {
        const file = path.join(agentsDirectory, `${agent.name}.toml`);
        const ownerEntry = Object.entries(manifest.agents).find(([, item]) => item.name === agent.name);
        if (ownerEntry && ownerEntry[0] !== String(agent.id)) {
          conflicts.push(`${file} (managed by ${ownerEntry[0]})`);
        }
      }
      if (conflicts.length) {
        throw httpError(`Codex agent file changed outside the gateway: ${conflicts.join(', ')}`, 409);
      }

      const rendered = new Map(activeAgents.map(agent => [
        String(agent.id),
        buildCodexAgentToml(config, agent),
      ]));

      const nextEntries = Object.create(null);
      for (const agent of activeAgents) {
        const id = String(agent.id);
        const previous = manifest.agents[id];
        const file = path.join(agentsDirectory, `${agent.name}.toml`);
        const content = rendered.get(id);
        const current = readFile(file);
        const fileOwnedByThisAgent = previous?.name === agent.name;
        let backupPath = fileOwnedByThisAgent ? previous?.backupPath || null : null;
        if (current !== null && !fileOwnedByThisAgent && !backupPath) {
          backupPath = backupFile(file, codexHome);
        }
        writeAtomic(file, content);
        nextEntries[id] = { name: agent.name, hash: hashContent(content), backupPath };
      }

      for (const [id, managed] of Object.entries(manifest.agents)) {
        const next = nextEntries[id];
        if (next?.name === managed.name) continue;
        const oldFile = path.join(agentsDirectory, `${managed.name}.toml`);
        const current = readFile(oldFile);
        if (managed.backupPath && fs.existsSync(managed.backupPath)) {
          writeAtomic(oldFile, fs.readFileSync(managed.backupPath, 'utf8'));
        } else if (current !== null && (force || hashContent(current) === managed.hash)) {
          fs.unlinkSync(oldFile);
        }
      }

      const nextManifest = { schemaVersion: MANIFEST_SCHEMA_VERSION, owner, agents: nextEntries };
      if (Object.keys(nextEntries).length) {
        writeAtomic(manifestPath, `${JSON.stringify(nextManifest, null, 2)}\n`);
      } else if (readFile(manifestPath) !== null) {
        fs.unlinkSync(manifestPath);
      }
      return agents.map(agent => ({ ...agent, projection: inspect(agent, config) }));
    }, { label: 'Codex agents' });
  }

  function managedFiles(agents = []) {
    const manifest = readManifest(manifestPath);
    return [...new Set([
      ...Object.values(manifest.agents).map(item => `${item.name}.toml`),
      ...agents.filter(item => item.enabled).map(item => `${item.name}.toml`),
    ])].sort();
  }

  return { codexHome, agentsDirectory, manifestPath, inspect, reconcile, managedFiles };
}

export function restoreCodexAgentSnapshot(options = {}) {
  const codexHome = codexAgentHome(options);
  const snapshotValue = String(options.snapshot || '').trim();
  if (!snapshotValue) throw new Error('snapshot directory is required');
  const snapshot = path.resolve(snapshotValue);
  let snapshotStat;
  try { snapshotStat = fs.statSync(snapshot); } catch {}
  if (!snapshotStat?.isDirectory()) {
    throw new Error('snapshot directory is required');
  }
  const manifestPath = path.join(codexHome, CODEX_AGENT_MANIFEST);
  const current = readManifest(manifestPath);
  const snapshotManifestPath = path.join(snapshot, CODEX_AGENT_MANIFEST);
  const previous = fs.existsSync(snapshotManifestPath)
    ? readManifest(snapshotManifestPath, {
        backupRoot: path.join(codexHome, 'backup-gateway', 'agents'),
      })
    : { schemaVersion: MANIFEST_SCHEMA_VERSION, agents: {} };
  const names = new Set([
    ...Object.values(current.agents).map(item => item.name),
    ...Object.values(previous.agents).map(item => item.name),
  ]);
  const agentsDirectory = path.join(codexHome, 'agents');
  const snapshotAgents = path.join(snapshot, 'agents');
  for (const name of names) {
    if (!CODEX_AGENT_NAME_RE.test(name)) throw new Error(`invalid agent name in snapshot: ${name}`);
    const target = path.join(agentsDirectory, `${name}.toml`);
    const source = path.join(snapshotAgents, `${name}.toml`);
    if (fs.existsSync(source)) writeAtomic(target, fs.readFileSync(source, 'utf8'));
    else if (fs.existsSync(target)) fs.unlinkSync(target);
  }
  if (fs.existsSync(snapshotManifestPath)) {
    writeAtomic(manifestPath, fs.readFileSync(snapshotManifestPath, 'utf8'));
  } else if (fs.existsSync(manifestPath)) {
    fs.unlinkSync(manifestPath);
  }
}

function loadAgentInputs(configPath, operationsPath) {
  const config = normalizeConfig(JSON.parse(fs.readFileSync(configPath, 'utf8')));
  // Match the gateway runtime's ownership stamp: gateway.mjs attaches the
  // resolved config path before reconcile, so the CLI must do the same or
  // manifestOwner() would fall back to the Codex home hash and every sync
  // would look like a foreign config.
  config.configPath = path.resolve(configPath);
  let operations = {};
  try {
    operations = JSON.parse(fs.readFileSync(operationsPath, 'utf8'));
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const agents = Array.isArray(operations.subagents)
    ? operations.subagents.map(normalizeStoredCodexAgent)
    : [];
  return { config, agents };
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (flag === '--config') args.configPath = argv[++index];
    else if (flag === '--operations') args.operationsPath = argv[++index];
    else if (flag === '--codex-home') args.codexHome = argv[++index];
    else if (flag === '--sync') args.sync = true;
    else if (flag === '--restore-snapshot') args.restoreSnapshot = argv[++index];
    else if (flag === '--force') args.force = true;
    else if (flag === '--print-files') args.printFiles = true;
    else throw new Error(`unknown option: ${flag}`);
  }
  return args;
}

function runCli() {
  const args = parseArgs(process.argv.slice(2));
  if (args.restoreSnapshot) {
    restoreCodexAgentSnapshot({ codexHome: args.codexHome, snapshot: args.restoreSnapshot });
    return;
  }
  if (!args.configPath) throw new Error('--config is required');
  const configPath = path.resolve(args.configPath);
  const operationsPath = path.resolve(
    args.operationsPath || path.join(path.dirname(configPath), 'gateway-operations.json'),
  );
  const { config, agents } = loadAgentInputs(configPath, operationsPath);
  const projector = createCodexAgentProjector({ codexHome: args.codexHome });
  if (args.printFiles) {
    process.stdout.write(`${projector.managedFiles(agents).join('\n')}${projector.managedFiles(agents).length ? '\n' : ''}`);
  }
  if (args.sync) projector.reconcile(config, agents, { force: args.force });
  if (!args.printFiles && !args.sync) throw new Error('--sync or --print-files is required');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    runCli();
  } catch (error) {
    console.error(`ERROR: ${error.message}`);
    process.exit(1);
  }
}
