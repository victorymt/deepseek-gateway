'use strict';

import zlib from 'node:zlib';

const SUPPORTED_ENCODINGS = new Set([
  'gzip', 'x-gzip', 'deflate', 'br', 'zstd', 'zst', 'identity',
]);

function bodyError(message, statusCode) {
  return Object.assign(new Error(message), { statusCode });
}

export function parseContentEncodings(value) {
  const values = Array.isArray(value) ? value : [value];
  const encodings = values
    .flatMap(item => String(item || '').split(','))
    .map(item => item.trim().toLowerCase())
    .filter(item => item && item !== 'identity');
  const unsupported = encodings.find(item => !SUPPORTED_ENCODINGS.has(item));
  if (unsupported) throw bodyError(`unsupported content-encoding: ${unsupported}`, 400);
  return encodings;
}

function decompress(method, input, maxOutputBytes) {
  return new Promise((resolve, reject) => {
    method(input, { maxOutputLength: maxOutputBytes }, (error, output) => {
      if (!error) {
        resolve(output);
        return;
      }
      if (error.code === 'ERR_BUFFER_TOO_LARGE') {
        reject(bodyError('decompressed request body too large', 413));
        return;
      }
      reject(error);
    });
  });
}

async function decompressSingle(encoding, input, maxOutputBytes) {
  if (encoding === 'gzip' || encoding === 'x-gzip') {
    return decompress(zlib.gunzip, input, maxOutputBytes);
  }
  if (encoding === 'br') return decompress(zlib.brotliDecompress, input, maxOutputBytes);
  if (encoding === 'zstd' || encoding === 'zst') {
    return decompress(zlib.zstdDecompress, input, maxOutputBytes);
  }
  try {
    return await decompress(zlib.inflate, input, maxOutputBytes);
  } catch (error) {
    if (error.statusCode === 413) throw error;
    return decompress(zlib.inflateRaw, input, maxOutputBytes);
  }
}

export async function decodeRequestBody(body, contentEncoding, maxOutputBytes) {
  const encodings = parseContentEncodings(contentEncoding);
  if (!encodings.length) return { body, decoded: false };
  let decoded = body;
  try {
    for (const encoding of encodings.reverse()) {
      decoded = await decompressSingle(encoding, decoded, maxOutputBytes);
      if (decoded.length > maxOutputBytes) {
        throw bodyError('decompressed request body too large', 413);
      }
    }
  } catch (error) {
    if (error.statusCode) throw error;
    throw bodyError(`invalid compressed request body: ${error.message}`, 400);
  }
  return { body: decoded, decoded: true };
}

export function requestContentEncoding(req) {
  return req.headersDistinct?.['content-encoding'] || req.headers['content-encoding'] || '';
}
