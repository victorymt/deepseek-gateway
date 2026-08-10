import { test } from 'node:test';
import assert from 'node:assert';

import {
  MAX_KEY_IMPORT_BYTES,
  MAX_KEY_IMPORT_ENTRIES,
  parseKeyImportText,
  prepareKeyImport,
} from '../key-import.mjs';

function provider(keys = []) {
  return {
    id: 'alpha',
    name: 'Alpha',
    keys,
  };
}

test('key import parses gpt-load compatible text and JSON formats', () => {
  assert.deepEqual(parseKeyImportText('sk-one, sk-two\nprimary=sk-three;backup:sk-four'), [
    { name: null, secret: 'sk-one', entry: 1 },
    { name: null, secret: 'sk-two', entry: 2 },
    { name: 'primary', secret: 'sk-three', entry: 3 },
    { name: 'backup', secret: 'sk-four', entry: 4 },
  ]);
  assert.deepEqual(parseKeyImportText('["sk-five", {"name":"named","key":"sk-six","alwaysTry":true}]'), [
    { name: null, secret: 'sk-five', entry: 1 },
    { name: 'named', secret: 'sk-six', alwaysTry: true, entry: 2 },
  ]);
});

test('key import deduplicates secrets and generates collision-free names', () => {
  const result = prepareKeyImport(
    provider([{ name: 'imported-1', key: 'sk-existing', weight: 1, enabled: true, alwaysTry: false }]),
    'sk-existing\nsk-new\nbackup=sk-other\nsk-new',
    { weight: 2, enabled: false, alwaysTry: true },
  );

  assert.equal(result.addedCount, 2);
  assert.equal(result.ignoredCount, 2);
  assert.deepEqual(result.keys.slice(1), [
    { name: 'imported-2', key: 'sk-new', weight: 2, enabled: false, alwaysTry: true },
    { name: 'backup', key: 'sk-other', weight: 2, enabled: false, alwaysTry: true },
  ]);
  assert.deepEqual(result.ignored.map(item => item.reason), ['duplicate-secret', 'duplicate-secret']);
});

test('key import rejects name conflicts before changing the provider', () => {
  assert.throws(
    () => prepareKeyImport(
      provider([{ name: 'primary', key: 'sk-existing', weight: 1, enabled: true, alwaysTry: false }]),
      'primary=sk-new\nsk-another',
    ),
    error => error.statusCode === 409 && /different secret/.test(error.message),
  );
});

test('key import enforces the batch limit and validates defaults', () => {
  const input = Array.from({ length: MAX_KEY_IMPORT_ENTRIES + 1 }, (_, index) => `sk-${index}`).join('\n');
  assert.throws(() => prepareKeyImport(provider(), input), /limited to/);
  assert.throws(() => prepareKeyImport(provider(), 'sk-one', { enabled: 'yes' }), /must be a boolean/);
});

test('key import enforces the byte limit and does not echo malformed secrets', () => {
  const oversized = Buffer.alloc(MAX_KEY_IMPORT_BYTES + 1, 'a').toString();
  assert.throws(() => parseKeyImportText(oversized), /limited to/);

  const secret = 'sk-sensitive-secret';
  assert.throws(
    () => parseKeyImportText(`[{"key":"${secret}"`),
    error => error.message === 'invalid JSON key list' && !error.message.includes(secret),
  );
});

test('key import validates JSON fields and overrides before deduplicating', () => {
  assert.throws(
    () => parseKeyImportText('[{"key":"sk-one","unexpected":true}]'),
    /unknown fields: unexpected/,
  );
  assert.throws(
    () => prepareKeyImport(
      provider([{ name: 'existing', key: 'sk-one', weight: 1, enabled: true, alwaysTry: false }]),
      '[{"key":"sk-one","weight":0}]',
    ),
    /weight must be greater than zero/,
  );
  assert.throws(() => prepareKeyImport(provider(), '[""]'), /empty secret/);
});
