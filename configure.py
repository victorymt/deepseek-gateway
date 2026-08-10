#!/usr/bin/env python3
"""Compatibility entry point for ``gatewayctl init``."""

from __future__ import annotations

import os
from pathlib import Path
import sys


ROOT = Path(__file__).resolve().parent


def main() -> int:
    command = ROOT / "gatewayctl"
    try:
        os.execv(command, [str(command), "init", *sys.argv[1:]])
    except OSError as exc:
        print(f"ERROR: 无法启动 gatewayctl: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
