#!/usr/bin/env bash
set -euo pipefail

# Keep the aggregate entry point independent from npm's forwarded arguments.
"$(dirname "$0")/run-node-tests.sh"
.venv/bin/python -m pytest
npm --prefix ui test -- --run
