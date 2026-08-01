#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CODEX_DIR="${CODEX_HOME:-$HOME/.codex}"
GATEWAY_URL="${GATEWAY_URL:-http://127.0.0.1:8787}"
GATEWAY_TOKEN="${GATEWAY_TOKEN:-gateway}"
MODEL="${MODEL:-deepseek-v4-flash}"
PROVIDER_ID="deepseek"
BACKUP_DIR="$CODEX_DIR/backup-gateway"
CONFIG="$CODEX_DIR/config.toml"
MODELS="$CODEX_DIR/models.json"

usage() {
  cat <<EOF
setup-codex.sh — point Codex CLI at the local DeepSeek multi-key gateway

Usage:
  ./setup-codex.sh                install gateway config (backs up existing files)
  ./setup-codex.sh --undo         restore the latest backup
  ./setup-codex.sh --dry-run      show what would be written, change nothing

Env:
  GATEWAY_URL   gateway base URL (default $GATEWAY_URL)
  GATEWAY_TOKEN bearer token sent to the gateway (default: gateway)
  MODEL         model id, e.g. deepseek-v4-flash / deepseek-v4-pro (default $MODEL)
  CODEX_HOME    codex config dir (default ~/.codex)
EOF
}

[ "${1:-}" = "--help" ] && usage && exit 0

DRY=""
case "${1:-}" in
  --undo)
    if [ ! -d "$BACKUP_DIR" ]; then echo "no backups found in $BACKUP_DIR"; exit 1; fi
    CONFIG_BACKUP="$(ls -1 "$BACKUP_DIR"/config.toml.* 2>/dev/null | tail -1 || true)"
    MODELS_BACKUP="$(ls -1 "$BACKUP_DIR"/models.json.* 2>/dev/null | tail -1 || true)"
    if [ -z "$CONFIG_BACKUP" ] && [ -z "$MODELS_BACKUP" ]; then echo "no backups found"; exit 1; fi
    if [ -n "$CONFIG_BACKUP" ]; then cp "$CONFIG_BACKUP" "$CONFIG"; echo "restored $CONFIG from $CONFIG_BACKUP"; fi
    if [ -n "$MODELS_BACKUP" ]; then cp "$MODELS_BACKUP" "$MODELS"; echo "restored $MODELS from $MODELS_BACKUP"; fi
    exit 0
    ;;
  --dry-run) DRY=1 ;;
esac

if ! command -v python3 >/dev/null 2>&1; then
  echo "ERROR: python3 is required for config merging" >&2
  exit 1
fi

run() {
  if [ -n "$DRY" ]; then
    echo "[dry-run] $*"
  else
    "$@"
  fi
}
now() {
  [ -n "$DRY" ] || echo "$*"
}

run mkdir -p "$CODEX_DIR" "$BACKUP_DIR"
TS="$(date +%Y%m%d-%H%M%S)"

if [ -f "$CONFIG" ]; then
  run cp "$CONFIG" "$BACKUP_DIR/config.toml.$TS"
  now "backed up config.toml -> $BACKUP_DIR/config.toml.$TS"
fi
if [ -f "$MODELS" ]; then
  run cp "$MODELS" "$BACKUP_DIR/models.json.$TS"
  now "backed up models.json -> $BACKUP_DIR/models.json.$TS"
fi

if [ ! -f "$MODELS" ] || ! grep -q '"deepseek-v4-flash"' "$MODELS" 2>/dev/null; then
  python3 -c "import json,sys; json.load(open('$SCRIPT_DIR/codex-models.json'))" || { echo "ERROR: bundled codex-models.json is invalid" >&2; exit 1; }
  run cp "$SCRIPT_DIR/codex-models.json" "$MODELS"
  now "wrote $MODELS (deepseek-v4-flash / deepseek-v4-pro catalog)"
else
  echo "kept existing $MODELS (already contains deepseek catalog)"
fi

if [ ! -f "$CONFIG" ]; then
  run touch "$CONFIG"
fi
export GATEWAY_TOKEN
run python3 "$SCRIPT_DIR/merge-config.py" "$CONFIG" "$MODEL" "$PROVIDER_ID" "$GATEWAY_URL" "$MODELS"
now "merged gateway config into $CONFIG"

if [ -n "$DRY" ]; then
  echo "[dry-run] would validate $CONFIG (TOML)"
elif python3 - "$CONFIG" <<'PY' 2>/dev/null
import sys
try:
    import tomllib
except ImportError:
    sys.exit(3)
with open(sys.argv[1], 'rb') as f:
    tomllib.load(f)
PY
then
  echo "validated $CONFIG (TOML ok)"
else
  echo "WARNING: could not validate config.toml (python3 tomllib needs 3.11+); check the file manually" >&2
fi

cat <<EOF

Done. Next steps:
  1. start the gateway:        node $SCRIPT_DIR/gateway.mjs --config $SCRIPT_DIR/keys.json
  2. run codex in your project: codex
     startup banner should show "model: $MODEL"
  3. dashboard:                $GATEWAY_URL/

To restore your previous codex config: ./setup-codex.sh --undo
EOF
