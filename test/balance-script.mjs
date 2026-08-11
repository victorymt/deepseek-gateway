import { test } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';

import {
  effectiveBalanceQuery,
  executeBalanceQuery,
  extractBalanceResult,
  materializeBalanceRequest,
  normalizeQuotaResult,
} from '../balance-script.mjs';

const provider = {
  id: 'alpha',
  baseUrl: 'https://api.example/v1',
};
const key = { name: 'primary', key: 'sk-test"value' };

const query = {
  enabled: true,
  language: 'javascript',
  timeoutMs: 2000,
  code: `({
    request: {
      url: "{{baseUrl}}/quota",
      method: "POST",
      headers: { Authorization: "Bearer {{apiKey}}" },
      body: { keyName: "{{keyName}}", provider: "{{providerId}}" }
    },
    extractor: function(response) {
      return {
        planName: response.plan,
        remaining: response.remaining,
        used: response.used,
        total: response.total,
        unit: response.unit,
        isValid: typeof process === "undefined" && typeof require === "undefined" && typeof fetch === "undefined"
      };
    }
  })`,
};

test('balance script materializes credentials outside QuickJS and normalizes output', async () => {
  const result = await executeBalanceQuery({
    query,
    provider,
    key,
    mockResponse: { plan: 'Pro', remaining: 7, used: 3, total: 10, unit: 'USD' },
  });
  assert.deepEqual(result, {
    isAvailable: true,
    items: [{
      planName: 'Pro',
      isValid: true,
      total: 10,
      used: 3,
      remaining: 7,
      unit: 'USD',
    }],
  });
});

test('balance request enforces provider origin, HTTPS, methods, and header ownership', () => {
  assert.throws(() => materializeBalanceRequest({
    url: 'https://attacker.example/quota',
    method: 'GET',
  }, provider, key), /provider origin/);
  assert.throws(() => materializeBalanceRequest({
    url: 'https://api.example/quota',
    method: 'DELETE',
  }, provider, key), /unsupported/);
  assert.throws(() => materializeBalanceRequest({
    url: 'https://api.example/quota',
    method: 'GET',
    headers: { Host: 'attacker.example' },
  }, provider, key), /not allowed/);
  assert.throws(() => materializeBalanceRequest({
    url: 'http://api.example/quota',
    method: 'GET',
  }, { ...provider, baseUrl: 'http://api.example/v1' }, key), /must use HTTPS/);
});

test('balance script interrupts infinite extraction and rejects malformed output', async () => {
  await assert.rejects(() => extractBalanceResult({
    ...query,
    code: '({ request: {}, extractor: function () { while (true) {} } })',
  }, {}), /timed out|interrupted/);
  assert.throws(() => normalizeQuotaResult({ remaining: '7', unit: 'USD' }), /remaining/);
  assert.throws(() => normalizeQuotaResult([]), /empty array/);
});

test('balance HTTP timeout is a total deadline even while bytes keep arriving', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    const timer = setInterval(() => res.write(' '), 10);
    res.on('close', () => clearInterval(timer));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  try {
    await assert.rejects(() => executeBalanceQuery({
      query: {
        enabled: true,
        language: 'javascript',
        timeoutMs: 80,
        code: `({
          request: { url: "{{baseUrl}}/quota", method: "GET" },
          extractor: function(response) { return response; }
        })`,
      },
      provider: { id: 'local', baseUrl: `http://127.0.0.1:${port}` },
      key,
    }), /timed out after 80ms/);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('DeepSeek keeps an implicit built-in query and explicit disable wins', () => {
  const deepseek = { id: 'deepseek', baseUrl: 'https://api.deepseek.com' };
  assert.equal(effectiveBalanceQuery(deepseek)?.enabled, true);
  assert.equal(effectiveBalanceQuery({
    ...deepseek,
    balanceQuery: { enabled: false, language: 'javascript', code: '', timeoutMs: 10000 },
  }), null);
  assert.equal(effectiveBalanceQuery(provider), null);
  assert.equal(effectiveBalanceQuery(provider, { mock: true }), null);
});
