'use strict';

export const MINIMUM_NODE_VERSION = '22.15.0';

export function nodeVersionSupported(version = process.versions.node) {
  const current = String(version).split('.').map(Number);
  const minimum = MINIMUM_NODE_VERSION.split('.').map(Number);
  for (let index = 0; index < minimum.length; index += 1) {
    if ((current[index] || 0) > minimum[index]) return true;
    if ((current[index] || 0) < minimum[index]) return false;
  }
  return true;
}

export function assertSupportedNodeVersion(version = process.versions.node) {
  if (!nodeVersionSupported(version)) {
    throw new Error(
      `Node.js ${MINIMUM_NODE_VERSION}+ is required (current ${version})`,
    );
  }
}
