#!/usr/bin/env bash
set -euo pipefail

for test_file in test/*.mjs; do
  node --test "$test_file"
done
