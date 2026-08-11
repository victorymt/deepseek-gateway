#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CODEX_DIR="${CODEX_HOME:-$HOME/.codex}"
GATEWAY_URL="${GATEWAY_URL:-http://127.0.0.1:8787}"
MODEL="${MODEL:-}"
PROVIDER_ID="multi-provider-gateway"
ENV_KEY="DEEPSEEK_GATEWAY_TOKEN"
BACKUP_DIR="$CODEX_DIR/backup-gateway"
CONFIG="$CODEX_DIR/config.toml"
MODELS="$CODEX_DIR/gateway-models.json"
GATEWAY_CONFIG="${GATEWAY_CONFIG:-$SCRIPT_DIR/keys.json}"
[ -f "$GATEWAY_CONFIG" ] || GATEWAY_CONFIG="$SCRIPT_DIR/keys.example.json"

usage() {
  cat <<EOF
setup-codex.sh — point Codex CLI at the local multi-provider gateway

Usage:
  ./setup-codex.sh                install gateway config (backs up existing files)
  ./setup-codex.sh --build-ui     force rebuild the shadcn dashboard first
  ./setup-codex.sh --skip-ui      skip the dashboard build
  ./setup-codex.sh --auth MODE    auth mode: auto, required, or none
  ./setup-codex.sh --undo         restore the latest backup
  ./setup-codex.sh --dry-run      show what would be written, change nothing

Env:
  GATEWAY_URL   gateway base URL (default $GATEWAY_URL)
  GATEWAY_CONFIG gateway v2 JSON config (default keys.json)
  MODEL         optional default model alias (defaults to config defaultModel)
  CODEX_HOME    codex config dir (default ~/.codex)
EOF
}

DRY=""
UI_MODE="auto"
AUTH_MODE="auto"
UNDO=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --help) usage; exit 0 ;;
    --build-ui) UI_MODE="force"; shift ;;
    --skip-ui) UI_MODE="skip"; shift ;;
    --dry-run) DRY=1; shift ;;
    --auth)
      [ "$#" -ge 2 ] || { echo "ERROR: --auth requires auto, required, or none" >&2; exit 1; }
      AUTH_MODE="$2"
      case "$AUTH_MODE" in auto|required|none) ;; *) echo "ERROR: invalid auth mode: $AUTH_MODE" >&2; exit 1 ;; esac
      shift 2
      ;;
    --undo) UNDO=1; shift ;;
    *) echo "ERROR: unknown option: $1" >&2; usage >&2; exit 1 ;;
  esac
done

if [ -n "$UNDO" ]; then
    if [ ! -d "$BACKUP_DIR" ]; then echo "no backups found in $BACKUP_DIR"; exit 1; fi
    CONFIG_BACKUP="$(ls -1 "$BACKUP_DIR"/config.toml.* 2>/dev/null | tail -1 || true)"
    MODELS_BACKUP="$(ls -1 "$BACKUP_DIR"/gateway-models.json.* 2>/dev/null | tail -1 || true)"
    if [ -z "$CONFIG_BACKUP" ] && [ -z "$MODELS_BACKUP" ]; then echo "no backups found"; exit 1; fi
    if [ -n "$CONFIG_BACKUP" ]; then cp "$CONFIG_BACKUP" "$CONFIG"; echo "restored $CONFIG from $CONFIG_BACKUP"; fi
    if [ -n "$MODELS_BACKUP" ]; then cp "$MODELS_BACKUP" "$MODELS"; echo "restored $MODELS from $MODELS_BACKUP"; fi
    exit 0
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "ERROR: python3 is required for config merging" >&2
  exit 1
fi
if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: node is required for model catalog generation" >&2
  exit 1
fi

if [ "$UI_MODE" != "skip" ]; then
  UI_DIST="$SCRIPT_DIR/ui/dist/index.html"
  UI_NEEDS_BUILD=0
  if [ "$UI_MODE" = "force" ] || [ ! -f "$UI_DIST" ]; then
    UI_NEEDS_BUILD=1
  elif [ -n "$(find "$SCRIPT_DIR/ui/src" "$SCRIPT_DIR/ui/package.json" "$SCRIPT_DIR/ui/package-lock.json" "$SCRIPT_DIR/ui/index.html" -type f -newer "$UI_DIST" -print -quit 2>/dev/null)" ]; then
    UI_NEEDS_BUILD=1
  fi
  if [ "$UI_NEEDS_BUILD" -eq 1 ]; then
    if [ -n "$DRY" ]; then
      echo "[dry-run] $SCRIPT_DIR/build-ui.sh"
    elif "$SCRIPT_DIR/build-ui.sh"; then
      echo "dashboard UI is ready: $UI_DIST"
    else
      if [ "$UI_MODE" = "force" ]; then
        echo "ERROR: dashboard UI build failed" >&2
        exit 1
      fi
      echo "WARNING: dashboard UI build failed; gateway will use the embedded fallback panel" >&2
    fi
  else
    echo "dashboard UI is up to date: $UI_DIST"
  fi
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
  run cp "$MODELS" "$BACKUP_DIR/gateway-models.json.$TS"
  now "backed up gateway-models.json -> $BACKUP_DIR/gateway-models.json.$TS"
fi

if [ -z "$MODEL" ]; then
  MODEL="$(node "$SCRIPT_DIR/codex-config.mjs" --config "$GATEWAY_CONFIG" --auth "$AUTH_MODE" --print-model)"
else
  MODEL="$(node "$SCRIPT_DIR/codex-config.mjs" --config "$GATEWAY_CONFIG" --auth "$AUTH_MODE" --model "$MODEL" --print-model)"
fi
AUTH_EFFECTIVE="$(node "$SCRIPT_DIR/codex-config.mjs" --config "$GATEWAY_CONFIG" --auth "$AUTH_MODE" --print-auth)"
node "$SCRIPT_DIR/codex-config.mjs" --config "$GATEWAY_CONFIG" --auth "$AUTH_MODE" --model "$MODEL"
if [ -n "$DRY" ]; then
  echo "[dry-run] node $SCRIPT_DIR/codex-config.mjs --config $GATEWAY_CONFIG --auth $AUTH_MODE --models-path $MODELS --write-catalog $MODELS"
else
  node "$SCRIPT_DIR/codex-config.mjs" --config "$GATEWAY_CONFIG" --auth "$AUTH_MODE" --models-path "$MODELS" --write-catalog "$MODELS"
  chmod 600 "$MODELS"
  now "wrote $MODELS (Codex Provider.model aliases)"
fi

if [ ! -f "$CONFIG" ]; then
  run touch "$CONFIG"
fi
MERGE_ENV_KEY=""
if [ "$AUTH_EFFECTIVE" = "required" ]; then MERGE_ENV_KEY="$ENV_KEY"; fi
run python3 "$SCRIPT_DIR/merge-config.py" "$CONFIG" "$MODEL" "$PROVIDER_ID" "$GATEWAY_URL" "$MODELS" "$MERGE_ENV_KEY"
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

echo
echo "Done. Next steps:"
echo "  1. start the gateway:        $SCRIPT_DIR/gatewayctl start --config $GATEWAY_CONFIG"
if [ "$AUTH_EFFECTIVE" = "required" ]; then
  echo "  2. set the gateway token:    export $ENV_KEY='<gateway-token>'"
else
  echo "  2. gateway authentication:   disabled (no token environment variable needed)"
fi
echo "  3. run codex in your project: codex"
echo "     startup banner should show \"model: $MODEL\""
echo "  4. dashboard:                $GATEWAY_URL/"
echo
echo "To restore your previous codex config: $SCRIPT_DIR/gatewayctl codex --undo"
