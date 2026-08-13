import { test } from 'node:test';
import assert from 'node:assert';

import {
  assertSupportedNodeVersion,
  nodeVersionSupported,
} from '../node-version.mjs';

test('Node runtime requirement includes native zstd support', () => {
  assert.equal(nodeVersionSupported('22.14.9'), false);
  assert.equal(nodeVersionSupported('22.15.0'), true);
  assert.equal(nodeVersionSupported('23.0.0'), true);
  assert.throws(() => assertSupportedNodeVersion('20.19.0'), /22\.15\.0\+/);
});
