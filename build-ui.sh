#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UI_DIR="$SCRIPT_DIR/ui"

if [ ! -f "$UI_DIR/package.json" ] || [ ! -f "$UI_DIR/package-lock.json" ]; then
  echo "ERROR: ui/package.json and ui/package-lock.json are required" >&2
  exit 1
fi
if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: node is required to build the UI" >&2
  exit 1
fi
if ! command -v npm >/dev/null 2>&1; then
  echo "ERROR: npm is required to build the UI" >&2
  exit 1
fi

if [ ! -f "$UI_DIR/node_modules/.package-lock.json" ] || [ "$UI_DIR/package-lock.json" -nt "$UI_DIR/node_modules/.package-lock.json" ]; then
  echo "Installing UI dependencies..."
  npm ci --prefix "$UI_DIR"
fi

echo "Building UI..."
npm run build --prefix "$UI_DIR"
echo "UI build complete: $UI_DIR/dist"
