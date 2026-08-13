import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
export const GATEWAY = path.join(ROOT, 'gateway.mjs');
export const CODEX_CONFIG = path.join(ROOT, 'codex-config.mjs');
export const CONFIGURE = path.join(ROOT, 'configure.py');

export function freePort() {
  return new Promise(resolve => {
    const server = net.createServer();
    server.listen(0, () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

export async function waitFor(predicate, timeout = 8000, signal = null) {
  const start = Date.now();
  for (;;) {
    if (signal?.aborted) throw signal.reason;
    try {
      if (await predicate()) return;
    } catch {
      // Retry until the predicate succeeds or the deadline expires.
    }
    if (signal?.aborted) throw signal.reason;
    if (Date.now() - start > timeout) throw new Error('waitFor timeout');
    await new Promise((resolve, reject) => {
      const onAbort = () => {
        clearTimeout(timer);
        reject(signal.reason);
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, 100);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }
}

export async function startGateway(keys, extra = [], env = {}, config = {}, options = {}) {
  const port = await freePort();
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-run-'));
  options.onRunDir?.(runDir);
  const configPath = path.join(runDir, 'keys.json');
  fs.writeFileSync(configPath, JSON.stringify(config));
  const mockArgs = options.mock === false ? [] : ['--mock'];
  const keyArgs = options.keysArg === false ? [] : ['--keys', keys];
  const child = spawn(process.execPath, [
    options.gateway || GATEWAY,
    ...mockArgs,
    '--config', configPath,
    '--port', String(port),
    ...keyArgs,
    '--quiet',
    ...extra,
  ], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } });
  options.onChild?.(child);
  let stderr = '';
  child.stderr.on('data', data => { stderr += data; });
  let exited = false;
  let cleaned = false;
  let stopPromise = null;
  const exitPromise = new Promise(resolve => {
    child.once('exit', (code, signal) => {
      exited = true;
      resolve({ code, signal });
    });
  });
  const removeRunDir = () => {
    if (cleaned) return;
    cleaned = true;
    fs.rmSync(runDir, { recursive: true, force: true });
  };
  const terminate = async () => {
    if (!exited) child.kill('SIGKILL');
    await exitPromise;
  };
  const base = `http://127.0.0.1:${port}`;
  const startupController = new AbortController();
  try {
    await Promise.race([
      waitFor(
        () => fetch(`${base}/health`, { signal: startupController.signal }).then(() => true),
        options.startupTimeout,
        startupController.signal,
      ),
      exitPromise.then(({ code, signal }) => {
        throw new Error(`gateway exited during startup: ${code ?? signal}`);
      }),
    ]);
  } catch (cause) {
    await terminate();
    removeRunDir();
    const detail = stderr.trim();
    throw new Error(
      `${cause instanceof Error ? cause.message : 'gateway startup failed'}${detail ? `\ngateway stderr: ${detail}` : ''}`,
      { cause },
    );
  } finally {
    startupController.abort(new Error('gateway startup check complete'));
  }
  return {
    base,
    configPath,
    child,
    runDir,
    async health() { return fetch(`${base}/health`).then(response => response.json()); },
    async providers() { return fetch(`${base}/api/providers`).then(response => response.json()); },
    async operation(pathname, init) { return fetch(`${base}${pathname}`, init); },
    async settings(init) { return fetch(`${base}/api/settings`, init); },
    async chat(body = {}, headers = {}) {
      const response = await fetch(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify({ model: 'deepseek-v4-flash', ...body }),
      });
      const text = await response.text();
      return { status: response.status, headers: response.headers, text };
    },
    async responses(body = {}, headers = {}, query = '') {
      const response = await fetch(`${base}/v1/responses${query}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify({ model: 'deepseek-v4-flash', input: 'hello', ...body }),
      });
      const text = await response.text();
      return { status: response.status, headers: response.headers, text };
    },
    async stop() {
      if (stopPromise) return stopPromise;
      stopPromise = (async () => {
        const stderrBeforeStop = stderr;
        try {
          await terminate();
        } finally {
          removeRunDir();
        }
        if (stderrBeforeStop) throw new Error(`gateway stderr: ${stderrBeforeStop}`);
      })();
      return stopPromise;
    },
  };
}

export function multiProviderConfig(overrides = {}) {
  const config = {
    schemaVersion: 2,
    defaultProvider: 'alpha',
    defaultModel: 'alpha--shared',
    maxRetries: 0,
    providers: [
      {
        id: 'alpha',
        name: 'Alpha',
        baseUrl: 'https://alpha.example',
        enabled: true,
        models: [{ id: 'shared', name: 'Shared Alpha', upstreamModel: 'same-upstream-model' }],
        keys: [{ name: 'alpha-key', key: 'sk-alpha-ok', weight: 1 }],
      },
      {
        id: 'beta',
        name: 'Beta',
        baseUrl: 'https://beta.example/v1',
        enabled: true,
        models: [{ id: 'shared', name: 'Shared Beta', upstreamModel: 'same-upstream-model' }],
        keys: [{ name: 'beta-key', key: 'sk-beta-ok', weight: 1 }],
      },
    ],
    ...overrides,
  };
  if (config.token && !config.adminToken) config.adminToken = 'test-admin-token-123456';
  return config;
}
