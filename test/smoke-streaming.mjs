import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

import {
  freePort,
  multiProviderConfig,
  startGateway,
  waitFor,
} from './helpers/gateway-harness.mjs';

test('SSE stream passes through with key attribution', async () => {
  const gw = await startGateway('alice=sk-a-ok,bob=sk-b-ok');
  try {
    const { status, headers, text } = await gw.chat({ stream: true });
    assert.equal(status, 200);
    assert.match(headers.get('content-type'), /text\/event-stream/);
    assert.match(text, /data: \{\"type\":\"response\.output_item\.added\",\"gateway_key_name\":\"alice\"/);
    assert.match(text, /data: \[DONE\]/);
    assert.match(text, /total_tokens/);
    assert.equal(headers.get('x-gateway-key'), 'alice');
  } finally {
    await gw.stop();
  }
});

test('inFlight is held for the whole stream, not just headers', async () => {
  const gw = await startGateway('alice=sk-a-drip');
  try {
    const res = await fetch(`${gw.base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-v4-flash', stream: true }),
    });
    assert.equal(res.status, 200);
    const reader = res.body.getReader();
    await reader.read();
    const during = await gw.health();
    assert.equal(during.keys[0].inFlight, 1, 'in-flight must stay 1 while stream is active');
    while (true) {
      const { done } = await reader.read();
      if (done) break;
    }
    const after = await gw.health();
    assert.equal(after.keys[0].inFlight, 0);
    assert.equal(after.keys[0].success, 1);
  } finally {
    await gw.stop();
  }
});

test('upstream abort mid-stream counts as error and gateway survives', async () => {
  const gw = await startGateway('alice=sk-a-abort');
  try {
    const res = await fetch(`${gw.base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-v4-flash', stream: true }),
    });
    assert.equal(res.status, 200);
    await assert.rejects(() => res.text());
    const h = await gw.health();
    assert.equal(h.keys[0].errors, 1);
    assert.equal(h.keys[0].inFlight, 0);
    const next = await gw.chat();
    assert.equal(next.status, 200, 'gateway must keep serving after an aborted stream');
  } finally {
    await gw.stop();
  }
});

test('direct SSE without a protocol terminal event is treated as truncated', async () => {
  const upstreamPort = await freePort();
  const upstream = http.createServer((req, res) => {
    req.resume();
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"type":"response.output_text.delta","delta":"partial"}\n\n');
    res.end();
  });
  await new Promise(resolve => upstream.listen(upstreamPort, '127.0.0.1', resolve));
  const config = multiProviderConfig();
  config.providers[0].baseUrl = `http://127.0.0.1:${upstreamPort}`;
  const gw = await startGateway('', [], {}, config, { keysArg: false, mock: false });
  try {
    await assert.rejects(async () => {
      const response = await fetch(`${gw.base}/v1/responses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'alpha--shared', input: 'hello', stream: true }),
      });
      await response.text();
    }, /terminated|fetch failed|socket/i);
    await waitFor(async () => (await gw.health()).providers[0].keys[0].inFlight === 0);
    const key = (await gw.health()).providers[0].keys[0];
    assert.equal(key.failureCount, 1);
    assert.equal(key.lastError, 'network error');
  } finally {
    await gw.stop();
    await new Promise(resolve => upstream.close(resolve));
  }
});

test('direct SSE requests force identity encoding before validating terminal events', async () => {
  const upstreamPort = await freePort();
  let acceptEncoding = '';
  const body = [
    'event: response.completed',
    'data: {"type":"response.completed","response":{"status":"completed"}}',
    '',
    '',
  ].join('\n');
  const upstream = http.createServer((req, res) => {
    req.resume();
    acceptEncoding = String(req.headers['accept-encoding'] || '');
    if (acceptEncoding === 'identity') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(body);
      return;
    }
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'content-encoding': 'gzip',
    });
    res.end(zlib.gzipSync(body));
  });
  await new Promise(resolve => upstream.listen(upstreamPort, '127.0.0.1', resolve));
  const config = multiProviderConfig();
  config.providers[0].baseUrl = `http://127.0.0.1:${upstreamPort}`;
  const gw = await startGateway('', [], {}, config, { keysArg: false, mock: false });
  try {
    const response = await fetch(`${gw.base}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'alpha--shared', input: 'hello', stream: true }),
    });
    assert.equal(response.status, 200);
    assert.match(await response.text(), /response\.completed/);
    assert.equal(acceptEncoding, 'identity');
    const key = (await gw.health()).providers[0].keys[0];
    assert.equal(key.success, 1);
    assert.equal(key.errors, 0);
  } finally {
    await gw.stop();
    await new Promise(resolve => upstream.close(resolve));
  }
});

test('direct Responses SSE accepts terminal events larger than one MiB', async () => {
  const upstreamPort = await freePort();
  const largeOutput = 'x'.repeat(1100000);
  const terminal = JSON.stringify({
    type: 'response.completed',
    response: { status: 'completed', output: largeOutput },
  });
  const upstream = http.createServer((req, res) => {
    req.resume();
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(`event: response.completed\ndata: ${terminal}\n\n`);
  });
  await new Promise(resolve => upstream.listen(upstreamPort, '127.0.0.1', resolve));
  const config = multiProviderConfig();
  config.providers[0].baseUrl = `http://127.0.0.1:${upstreamPort}`;
  const gw = await startGateway('', [], {}, config, { keysArg: false, mock: false });
  try {
    const response = await fetch(`${gw.base}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'alpha--shared', input: 'hello', stream: true }),
    });
    const text = await response.text();
    assert.equal(response.status, 200);
    assert.ok(text.length > 1100000);
    const key = (await gw.health()).providers[0].keys[0];
    assert.equal(key.success, 1);
    assert.equal(key.errors, 0);
  } finally {
    await gw.stop();
    await new Promise(resolve => upstream.close(resolve));
  }
});

test('direct Responses SSE accepts CR-only event framing', async () => {
  const upstreamPort = await freePort();
  const upstream = http.createServer((req, res) => {
    req.resume();
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end([
      'event: response.completed',
      'data: {"type":"response.completed","response":{"status":"completed"}}',
      '',
      '',
    ].join('\r'));
  });
  await new Promise(resolve => upstream.listen(upstreamPort, '127.0.0.1', resolve));
  const config = multiProviderConfig();
  config.providers[0].baseUrl = `http://127.0.0.1:${upstreamPort}`;
  const gw = await startGateway('', [], {}, config, { keysArg: false, mock: false });
  try {
    const response = await fetch(`${gw.base}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'alpha--shared', input: 'hello', stream: true }),
    });
    assert.match(await response.text(), /response\.completed/);
    const key = (await gw.health()).providers[0].keys[0];
    assert.equal(key.success, 1);
    assert.equal(key.errors, 0);
  } finally {
    await gw.stop();
    await new Promise(resolve => upstream.close(resolve));
  }
});

test('direct Responses SSE rejects malformed terminal event payloads', async () => {
  const upstreamPort = await freePort();
  const upstream = http.createServer((req, res) => {
    req.resume();
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('event: response.completed\ndata: {broken}\n\n');
  });
  await new Promise(resolve => upstream.listen(upstreamPort, '127.0.0.1', resolve));
  const config = multiProviderConfig();
  config.providers[0].baseUrl = `http://127.0.0.1:${upstreamPort}`;
  const gw = await startGateway('', [], {}, config, { keysArg: false, mock: false });
  try {
    await assert.rejects(async () => {
      const response = await fetch(`${gw.base}/v1/responses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'alpha--shared', input: 'hello', stream: true }),
      });
      await response.text();
    }, /terminated|fetch failed|socket/i);
    const key = (await gw.health()).providers[0].keys[0];
    assert.equal(key.success, 0);
    assert.equal(key.errors, 1);
  } finally {
    await gw.stop();
    await new Promise(resolve => upstream.close(resolve));
  }
});

test('direct SSE terminal markers inside model output do not bypass truncation checks', async () => {
  const upstreamPort = await freePort();
  const upstream = http.createServer((req, res) => {
    req.resume();
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (req.url.includes('chat/completions')) {
      res.end('data: {"choices":[{"delta":{"content":"data: [DONE]"}}]}\n\n');
      return;
    }
    res.end('data: {"type":"response.output_text.delta","delta":"event: response.completed"}\n\n');
  });
  await new Promise(resolve => upstream.listen(upstreamPort, '127.0.0.1', resolve));
  const config = multiProviderConfig();
  config.providers[0].baseUrl = `http://127.0.0.1:${upstreamPort}`;
  const gw = await startGateway('', [], {}, config, { keysArg: false, mock: false });
  try {
    for (const pathname of ['/v1/responses', '/v1/chat/completions']) {
      await assert.rejects(async () => {
        const response = await fetch(`${gw.base}${pathname}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'alpha--shared', input: 'hello', stream: true }),
        });
        await response.text();
      }, /terminated|fetch failed|socket/i);
    }
    await waitFor(async () => (await gw.health()).providers[0].keys[0].inFlight === 0);
    const key = (await gw.health()).providers[0].keys[0];
    assert.equal(key.errors, 2);
    assert.equal(key.failureCount, 2);
  } finally {
    await gw.stop();
    await new Promise(resolve => upstream.close(resolve));
  }
});

test('direct Responses SSE failure terminals count as upstream errors', async () => {
  const upstreamPort = await freePort();
  const upstream = http.createServer((req, res) => {
    req.resume();
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end([
      'event: response.failed',
      'data: {"type":"response.failed","response":{"status":"failed"}}',
      '',
      '',
    ].join('\n'));
  });
  await new Promise(resolve => upstream.listen(upstreamPort, '127.0.0.1', resolve));
  const config = multiProviderConfig();
  config.providers[0].baseUrl = `http://127.0.0.1:${upstreamPort}`;
  const gw = await startGateway('', [], {}, config, { keysArg: false, mock: false });
  try {
    const response = await fetch(`${gw.base}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'alpha--shared', input: 'hello', stream: true }),
    });
    assert.equal(response.status, 200);
    assert.match(await response.text(), /response\.failed/);
    const key = (await gw.health()).providers[0].keys[0];
    assert.equal(key.success, 0);
    assert.equal(key.errors, 1);
    assert.equal(key.failureCount, 1);
  } finally {
    await gw.stop();
    await new Promise(resolve => upstream.close(resolve));
  }
});

test('client cancellation while buffering an adapted response does not penalize the key', async () => {
  const upstreamPort = await freePort();
  const upstream = http.createServer((req, res) => {
    req.resume();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.flushHeaders();
    const timer = setTimeout(() => {
      res.end(JSON.stringify({
        id: 'chatcmpl-late',
        model: 'same-upstream-model',
        choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'late' } }],
      }));
    }, 500);
    res.on('close', () => clearTimeout(timer));
  });
  await new Promise(resolve => upstream.listen(upstreamPort, '127.0.0.1', resolve));
  const config = multiProviderConfig();
  config.providers[0].baseUrl = `http://127.0.0.1:${upstreamPort}`;
  config.providers[0].upstreamFormat = 'chat-completions';
  const gw = await startGateway('', [], {}, config, { keysArg: false, mock: false });
  try {
    const target = new URL(gw.base);
    await new Promise((resolve, reject) => {
      const req = http.request({
        hostname: target.hostname,
        port: target.port,
        path: '/v1/responses',
        method: 'POST',
        headers: { 'content-type': 'application/json' },
      });
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      req.on('response', res => {
        res.resume();
        res.on('close', done);
      });
      req.on('error', error => {
        if (error.code === 'ECONNRESET') done();
        else reject(error);
      });
      req.on('close', done);
      req.end(JSON.stringify({ model: 'alpha--shared', input: 'hello' }));
      setTimeout(() => req.destroy(), 80);
    });
    await waitFor(async () => (await gw.health()).providers[0].keys[0].inFlight === 0);
    const key = (await gw.health()).providers[0].keys[0];
    assert.equal(key.failureCount, 0);
    assert.equal(key.invalid, false);
    assert.equal(key.lastError, 'client aborted');
  } finally {
    await gw.stop();
    await new Promise(resolve => upstream.close(resolve));
  }
});

test('downstream abort before upstream headers cancels the active request', async () => {
  const gw = await startGateway('alice=sk-a-slow,bob=sk-b-ok');
  try {
    const controller = new AbortController();
    const pending = fetch(`${gw.base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-v4-flash' }),
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 40);
    await assert.rejects(pending, error => error.name === 'AbortError');
    await waitFor(async () => (await gw.health()).keys[0].inFlight === 0);
    const h = await gw.health();
    assert.equal(h.keys[0].errors, 1);
    assert.equal(h.keys[0].failureCount, 0);
    assert.equal(h.keys[1].total, 0, 'client abort must stop the retry loop');
  } finally {
    await gw.stop();
  }
});
