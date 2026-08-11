#!/usr/bin/env node
'use strict';

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { normalizeConfig } from './config-core.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CONFIG = path.join(ROOT, 'keys.json');

const USAGE = `deepseek-gateway control utility

Usage:
  gatewayctl init [configure options]
  gatewayctl validate [--config PATH]
  gatewayctl doctor [--config PATH]
  gatewayctl start [gateway options]
  gatewayctl codex [--config PATH] [setup options]

Commands:
  init       run the interactive configuration wizard
  validate   validate and normalize a gateway config
  doctor     check the runtime, config, dashboard, and local gateway
  start      start the gateway in the foreground
  codex      install or preview the Codex CLI integration
`;

function configOption(args, env = process.env) {
  const index = args.indexOf('--config');
  if (index >= 0) {
    if (!args[index + 1] || args[index + 1].startsWith('-')) {
      throw new Error('--config requires a path');
    }
    return path.resolve(args[index + 1]);
  }
  return path.resolve(env.DS_GATEWAY_CONFIG || DEFAULT_CONFIG);
}

function removeConfigOption(args) {
  const index = args.indexOf('--config');
  if (index < 0) return [...args];
  return [...args.slice(0, index), ...args.slice(index + 2)];
}

function assertConfigOnlyArgs(args) {
  const remaining = removeConfigOption(args);
  if (remaining.length) throw new Error(`unknown option: ${remaining[0]}`);
}

function readConfig(configPath) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (error) {
    throw new Error(`cannot read config ${configPath}: ${error.message}`);
  }
  try {
    return normalizeConfig(parsed, { allowSetup: true });
  } catch (error) {
    throw new Error(`invalid config ${configPath}: ${error.message}`);
  }
}

function localHost(host) {
  return ['0.0.0.0', '::', '[::]'].includes(host) ? '127.0.0.1' : host;
}

function gatewayUrl(config) {
  const host = localHost(config.host);
  const urlHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return `http://${urlHost}:${config.port}`;
}

function probeGateway(config) {
  if (config.port === 0) return Promise.resolve({ status: 'unknown', message: '动态端口无法探测' });
  return new Promise(resolve => {
    const request = http.request({
      host: localHost(config.host),
      port: config.port,
      path: '/health',
      method: 'GET',
      headers: config.token ? { authorization: `Bearer ${config.token}` } : {},
    }, response => {
      const chunks = [];
      let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size <= 65536) chunks.push(chunk);
      });
      response.on('end', () => {
        if (response.statusCode !== 200) {
          resolve({ status: 'warning', message: `端口返回 HTTP ${response.statusCode}` });
          return;
        }
        try {
          const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (size > 65536 || !payload || payload.status !== 'ok' || !Array.isArray(payload.providers)) {
            throw new Error('unexpected health payload');
          }
          resolve({ status: 'ok', message: `网关运行中 (${config.host}:${config.port})` });
        } catch {
          resolve({ status: 'warning', message: '端口返回了非 Gateway health 响应' });
        }
      });
    });
    request.setTimeout(700, () => request.destroy(new Error('timeout')));
    request.on('error', error => resolve({ status: 'offline', message: `网关未运行 (${error.message})` }));
    request.end();
  });
}

export function commandInvocation(command, args, env = process.env) {
  switch (command) {
    case 'init':
      return {
        executable: env.PYTHON || 'python3',
        args: [path.join(ROOT, 'configure_wizard.py'), ...args],
        env,
      };
    case 'start': {
      let forwarded;
      if (args.includes('--config')) {
        configOption(args, env);
        forwarded = [...args];
      } else {
        forwarded = ['--config', configOption(args, env), ...args];
      }
      return {
        executable: process.execPath,
        args: [path.join(ROOT, 'gateway.mjs'), ...forwarded],
        env,
      };
    }
    case 'codex': {
      const configPath = configOption(args, env);
      const config = readConfig(configPath);
      return {
        executable: path.join(ROOT, 'setup-codex.sh'),
        args: removeConfigOption(args),
        env: {
          ...env,
          GATEWAY_CONFIG: configPath,
          GATEWAY_URL: env.GATEWAY_URL || gatewayUrl(config),
        },
      };
    }
    default:
      throw new Error(`unknown command: ${command}`);
  }
}

function runInvocation(invocation) {
  const result = spawnSync(invocation.executable, invocation.args, {
    cwd: ROOT,
    env: invocation.env,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

function validate(args) {
  assertConfigOnlyArgs(args);
  const configPath = configOption(args);
  const config = readConfig(configPath);
  if (config.setupPending) {
    console.log(`OK: Gateway 引导配置有效 ${configPath}`);
    console.log('    等待通过 Web UI 添加首个 Provider');
  } else {
    console.log(`OK: 配置有效 ${configPath}`);
    console.log(`    ${config.providers.length} provider(s), 默认模型 ${config.defaultModel}`);
  }
  return 0;
}

async function doctor(args) {
  assertConfigOnlyArgs(args);
  const configPath = configOption(args);
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 18) throw new Error(`Node.js 18+ is required (current ${process.version})`);
  console.log(`OK: Node.js ${process.version}`);

  const config = readConfig(configPath);
  if (config.setupPending) {
    console.log(`OK: Gateway 引导配置有效 ${configPath}`);
    console.log('WARN: 等待通过 Web UI 添加首个 Provider');
  } else {
    console.log(`OK: 配置有效 ${configPath}`);
    console.log(`OK: ${config.providers.length} provider(s), 默认模型 ${config.defaultModel}`);
  }

  const dashboard = path.join(ROOT, 'ui', 'dist', 'index.html');
  console.log(`${fs.existsSync(dashboard) ? 'OK' : 'WARN'}: ${fs.existsSync(dashboard) ? 'Dashboard 已构建' : 'Dashboard 尚未构建，将使用兼容面板'}`);

  const probe = await probeGateway(config);
  console.log(`${probe.status === 'ok' ? 'OK' : 'WARN'}: ${probe.message}`);
  console.log(`OK: doctor 完成 (${os.platform()} ${os.arch()})`);
  return 0;
}

async function main(argv = process.argv.slice(2)) {
  const [command, ...args] = argv;
  if (!command || ['help', '--help', '-h'].includes(command)) {
    console.log(USAGE);
    return 0;
  }
  if (args.includes('--help') && ['validate', 'doctor'].includes(command)) {
    console.log(USAGE);
    return 0;
  }
  if (command === 'validate') return validate(args);
  if (command === 'doctor') return doctor(args);
  return runInvocation(commandInvocation(command, args));
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().then(code => {
    process.exitCode = code;
  }).catch(error => {
    console.error(`ERROR: ${error.message}`);
    process.exitCode = 1;
  });
}
