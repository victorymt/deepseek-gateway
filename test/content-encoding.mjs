import { test } from 'node:test';
import assert from 'node:assert';
import zlib from 'node:zlib';

import { decodeRequestBody, parseContentEncodings } from '../content-encoding.mjs';

const PAYLOAD = Buffer.from(JSON.stringify({ model: 'test', input: 'hello' }));

test('decodes Codex request content encodings and aliases', async () => {
  const encoded = [
    ['gzip', zlib.gzipSync(PAYLOAD)],
    ['x-gzip', zlib.gzipSync(PAYLOAD)],
    ['deflate', zlib.deflateSync(PAYLOAD)],
    ['deflate', zlib.deflateRawSync(PAYLOAD)],
    ['br', zlib.brotliCompressSync(PAYLOAD)],
    ['zstd', zlib.zstdCompressSync(PAYLOAD)],
    ['zst', zlib.zstdCompressSync(PAYLOAD)],
  ];
  for (const [encoding, body] of encoded) {
    const result = await decodeRequestBody(body, encoding, 1024);
    assert.deepEqual(result, { body: PAYLOAD, decoded: true });
  }
});

test('decodes repeated and stacked encodings in reverse order', async () => {
  const body = zlib.brotliCompressSync(zlib.gzipSync(PAYLOAD));
  const result = await decodeRequestBody(body, ['gzip', 'br, identity'], 1024);
  assert.deepEqual(result.body, PAYLOAD);
  assert.equal(result.decoded, true);
  assert.deepEqual(parseContentEncodings(['gzip', 'br, identity']), ['gzip', 'br']);
});

test('rejects unsupported, malformed, and oversized encoded bodies', async () => {
  await assert.rejects(
    decodeRequestBody(PAYLOAD, 'compress', 1024),
    error => error.statusCode === 400 && /unsupported/.test(error.message),
  );
  await assert.rejects(
    decodeRequestBody(Buffer.from('invalid'), 'gzip', 1024),
    error => error.statusCode === 400 && /invalid compressed/.test(error.message),
  );
  await assert.rejects(
    decodeRequestBody(zlib.gzipSync(Buffer.alloc(2048)), 'gzip', 1024),
    error => error.statusCode === 413,
  );
});

test('bounds intermediate stages in a stacked encoding chain', async () => {
  const intermediate = zlib.gzipSync(Buffer.alloc(4096));
  const body = zlib.brotliCompressSync(intermediate);
  await assert.rejects(
    decodeRequestBody(body, 'gzip, br', 128),
    error => error.statusCode === 413,
  );
});
