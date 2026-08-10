#!/usr/bin/env python3
"""Interactive configuration wizard for deepseek-gateway."""

from __future__ import annotations

import argparse
import getpass
import http.client
import json
import math
import os
from pathlib import Path
import secrets
import shutil
import socket
import subprocess
import sys
import tempfile
from datetime import datetime
from urllib.parse import urlparse


ROOT = Path(__file__).resolve().parent
DEFAULT_CONFIG = ROOT / "keys.json"
CONFIG_CORE = ROOT / "config-core.mjs"
GATEWAY_AVAILABLE = "available"
GATEWAY_RUNNING = "running"
GATEWAY_OCCUPIED = "occupied"
DEFAULTS = {
    "port": 8787,
    "host": "127.0.0.1",
    "upstream": "https://api.deepseek.com",
    "cooldownMs": 60000,
    "blacklistThreshold": 3,
    "balanceRefreshMs": 5 * 60 * 1000,
    "maxRetries": 2,
    "timeoutMs": 0,
    "maxBodyBytes": 64 * 1024 * 1024,
    "token": "",
    "keys": [],
}


def confirm(label: str, default: bool) -> bool:
    suffix = "Y/n" if default else "y/N"
    while True:
        value = input(f"{label} [{suffix}]: ").strip().lower()
        if not value:
            return default
        if value in {"y", "yes", "1", "true"}:
            return True
        if value in {"n", "no", "0", "false"}:
            return False
        print("请输入 y 或 n。")


def prompt_text(label: str, current: str, validator=None) -> str:
    while True:
        value = input(f"{label} [{current}]: ").strip() or current
        try:
            return validator(value) if validator else value
        except ValueError as exc:
            print(f"无效输入：{exc}")


def prompt_number(
    label: str,
    current,
    *,
    minimum: float,
    maximum: float | None = None,
    integer: bool = True,
):
    parser = int if integer else float
    while True:
        value = input(f"{label} [{current}]: ").strip()
        try:
            parsed = parser(value) if value else parser(current)
            if isinstance(parsed, float) and not math.isfinite(parsed):
                raise ValueError("必须是有限数值")
            if parsed < minimum:
                raise ValueError(f"必须大于或等于 {minimum:g}")
            if maximum is not None and parsed > maximum:
                raise ValueError(f"必须小于或等于 {maximum:g}")
            return parsed
        except (TypeError, ValueError) as exc:
            print(f"无效输入：{exc}")


def prompt_secret(label: str) -> str:
    if sys.stdin.isatty():
        return getpass.getpass(label)
    return input(label)


def validate_upstream(value: str) -> str:
    parsed = urlparse(value)
    if (
        parsed.scheme not in {"http", "https"}
        or not parsed.netloc
        or parsed.username
        or parsed.password
        or parsed.query
        or parsed.fragment
    ):
        raise ValueError("请输入不包含凭据、查询参数或片段的完整 HTTP(S) URL")
    return value.rstrip("/")


def load_existing(path: Path) -> dict:
    if not path.exists():
        return {}
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError(f"无法读取现有配置 {path}: {exc}") from exc
    if not isinstance(value, dict):
        raise ValueError(f"现有配置 {path} 的顶层必须是 JSON 对象")
    return value


def run_config_core(config: dict, mode: str) -> dict:
    result = subprocess.run(
        ["node", str(CONFIG_CORE), mode],
        input=json.dumps(config, ensure_ascii=False),
        text=True,
        capture_output=True,
        check=False,
    )
    if result.returncode:
        message = result.stderr.strip()
        if message.startswith("ERROR: "):
            message = message[7:]
        raise ValueError(f"配置处理失败：{message or f'Node 退出码 {result.returncode}'}")
    try:
        normalized = json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise ValueError("配置校验器返回了无效 JSON") from exc
    if not isinstance(normalized, dict):
        raise ValueError("配置校验器返回的顶层必须是 JSON 对象")
    return normalized


def migrate_to_v2(existing: dict) -> dict:
    return run_config_core(existing, "--migrate-stdin")


def normalize_config(config: dict) -> dict:
    return run_config_core(config, "--normalize-stdin")


def mask_secret(value: str) -> str:
    if len(value) <= 7:
        return "*" * len(value)
    return f"{value[:3]}...{value[-4:]}"


def configure_keys(existing) -> list[dict]:
    keys = []
    names = set()
    secrets_seen = set()
    invalid_existing = False
    for index, item in enumerate(existing or []):
        if not isinstance(item, dict) or not item.get("key"):
            invalid_existing = True
            continue
        name = str(item.get("name") or f"key-{index + 1}").strip()
        secret = str(item["key"]).strip()
        try:
            weight = float(item.get("weight", 1))
            if not math.isfinite(weight) or weight <= 0:
                raise ValueError
        except (TypeError, ValueError):
            invalid_existing = True
            continue
        if not name or len(name) > 100 or name in names or secret in secrets_seen:
            invalid_existing = True
            continue
        keys.append({
            "name": name,
            "key": secret,
            "weight": int(weight) if weight.is_integer() else weight,
        })
        names.add(name)
        secrets_seen.add(secret)
    if invalid_existing:
        print("现有 API Key 配置包含空值、重复名称或无效权重，需要重新输入。")
        keys = []
    if keys:
        print("\n现有 API Key：")
        for index, item in enumerate(keys, 1):
            print(f"  {index}. {item['name']} ({mask_secret(item['key'])}, weight={item['weight']})")
        if not confirm("重新输入全部 API Key", False):
            return keys

    keys = []
    names = set()
    secrets_seen = set()
    print("\n配置 API Key（至少一个）：")
    while True:
        default_name = f"key-{len(keys) + 1}"
        name = prompt_text("  名称", default_name)
        if not name or len(name) > 100 or name in names:
            print("名称不能为空、超过 100 个字符或与现有名称重复。")
            continue
        secret = prompt_secret("  API Key（隐藏输入）: ").strip()
        if not secret:
            print("API Key 不能为空。")
            continue
        if secret in secrets_seen:
            print("该 API Key 已存在，请输入不同的 Key。")
            continue
        weight = prompt_number("  权重", 1, minimum=0.000001, integer=False)
        if float(weight).is_integer():
            weight = int(weight)
        keys.append({"name": name, "key": secret, "weight": weight})
        names.add(name)
        secrets_seen.add(secret)
        if not confirm("  继续添加 Key", False):
            return keys


def configure_token(existing: str) -> tuple[str, bool]:
    enabled = confirm("启用网关访问密码", bool(existing))
    if not enabled:
        return "", False
    hint = "（回车保留现有密码）" if existing else "（回车自动生成）"
    value = prompt_secret(f"网关密码{hint}: ").strip()
    if value:
        return value, False
    if existing:
        return existing, False
    return secrets.token_urlsafe(32), True


def default_provider_entry(config: dict) -> tuple[int, dict]:
    """Return the provider edited by the wizard, selecting a usable default."""
    providers = config.get("providers")
    if not isinstance(providers, list) or not providers:
        raise ValueError("v2 配置必须包含至少一个 Provider")

    requested_id = str(config.get("defaultProvider") or "").strip()
    if requested_id:
        for index, provider in enumerate(providers):
            if isinstance(provider, dict) and str(provider.get("id") or "").strip() == requested_id:
                if provider.get("enabled", True) is not True:
                    raise ValueError("defaultProvider 必须指向已启用的 Provider")
                return index, provider
        raise ValueError(f"找不到默认 Provider：{requested_id}")

    for index, provider in enumerate(providers):
        if isinstance(provider, dict) and provider.get("enabled", True) is True:
            provider_id = str(provider.get("id") or "").strip()
            if provider_id:
                config["defaultProvider"] = provider_id
                return index, provider
    raise ValueError("v2 配置必须至少启用一个 Provider")


def write_config(path: Path, config: dict) -> Path | None:
    path.parent.mkdir(parents=True, exist_ok=True)
    backup = None
    if path.exists():
        backup_dir = path.parent / ".gateway-backups"
        backup_dir.mkdir(mode=0o700, exist_ok=True)
        backup_dir.chmod(0o700)
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S-%f")
        backup = backup_dir / f"{path.name}.{stamp}"
        shutil.copy2(path, backup)
        backup.chmod(0o600)

    fd, temp_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent, text=True)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(config, stream, ensure_ascii=False, indent=2)
            stream.write("\n")
        os.replace(temp_name, path)
        path.chmod(0o600)
    except BaseException:
        try:
            os.unlink(temp_name)
        except FileNotFoundError:
            pass
        raise
    return backup


def local_gateway_url(host: str, port: int) -> str:
    target = "127.0.0.1" if host in {"0.0.0.0", "::"} else host
    if ":" in target and not target.startswith("["):
        target = f"[{target}]"
    return f"http://{target}:{port}"


def is_gateway_health(payload) -> bool:
    if not (
        isinstance(payload, dict)
        and payload.get("status") == "ok"
        and isinstance(payload.get("version"), str)
    ):
        return False
    current_shape = isinstance(payload.get("providers"), list)
    legacy_shape = (
        isinstance(payload.get("keys"), list)
        and isinstance(payload.get("total"), dict)
        and isinstance(payload.get("mock"), bool)
    )
    return current_shape or legacy_shape


def gateway_status(config: dict) -> str:
    base_url = local_gateway_url(config["host"], config["port"])
    parsed = urlparse(base_url)
    headers = {}
    if config.get("token"):
        headers["Authorization"] = f"Bearer {config['token']}"

    connection = http.client.HTTPConnection(parsed.hostname, parsed.port, timeout=0.5)
    try:
        connection.request("GET", "/health", headers=headers)
        response = connection.getresponse()
        body = response.read(1024 * 1024)
        if response.status == 200:
            payload = json.loads(body)
            if is_gateway_health(payload):
                return GATEWAY_RUNNING
        return GATEWAY_OCCUPIED
    except (OSError, http.client.HTTPException, json.JSONDecodeError, UnicodeDecodeError):
        pass
    finally:
        connection.close()

    try:
        with socket.create_connection((parsed.hostname, parsed.port), timeout=0.25):
            return GATEWAY_OCCUPIED
    except OSError:
        return GATEWAY_AVAILABLE


def connection_config(existing: dict) -> dict:
    current = {**DEFAULTS, **existing}
    port = os.environ.get("DS_GATEWAY_PORT") or current["port"]
    token = os.environ.get("DS_GATEWAY_TOKEN") or current.get("token") or ""
    return {"host": str(current["host"]), "port": int(port), "token": str(token)}


def ui_needs_build() -> bool:
    output = ROOT / "ui" / "dist" / "index.html"
    if not output.exists():
        return True
    inputs = [
        ROOT / "ui" / "package.json",
        ROOT / "ui" / "package-lock.json",
        ROOT / "ui" / "index.html",
        *list((ROOT / "ui" / "src").rglob("*")),
    ]
    output_mtime = output.stat().st_mtime
    return any(item.is_file() and item.stat().st_mtime > output_mtime for item in inputs)


def run_ui_build() -> bool:
    script = ROOT / "build-ui.sh"
    if not script.exists():
        print(f"WARNING: 找不到 {script}，将使用内嵌兼容面板。", file=sys.stderr)
        return False
    if not ui_needs_build():
        print(f"状态面板已是最新版本：{ROOT / 'ui' / 'dist'}")
        return True
    result = subprocess.run([str(script)], check=False)
    if result.returncode:
        print(
            f"WARNING: build-ui.sh 退出码为 {result.returncode}，将使用内嵌兼容面板。",
            file=sys.stderr,
        )
        return False
    return True


def run_codex_setup(config: dict, config_path: Path, *, skip_ui: bool = False) -> None:
    env = os.environ.copy()
    env["GATEWAY_URL"] = local_gateway_url(config["host"], config["port"])
    env["GATEWAY_CONFIG"] = str(config_path)
    default_model = env.get("MODEL") or str(config.get("defaultModel") or "deepseek--v4-flash")
    env["MODEL"] = prompt_text("Codex 默认模型别名", default_model)
    command = [str(ROOT / "setup-codex.sh")]
    if skip_ui:
        command.append("--skip-ui")
    result = subprocess.run(command, env=env, check=False)
    if result.returncode:
        raise RuntimeError(f"setup-codex.sh 退出码为 {result.returncode}")
    print("启动 Codex 前请设置：export DEEPSEEK_GATEWAY_TOKEN='<网关密码>'")


def configure(path: Path, existing: dict | None = None) -> dict:
    existing = load_existing(path) if existing is None else existing
    config = migrate_to_v2(existing)
    current = {**DEFAULTS, **config}

    print(f"配置文件：{path}")
    print("直接回车可接受方括号中的当前值。\n")
    config["port"] = prompt_number("监听端口", current["port"], minimum=1, maximum=65535)
    config["host"] = prompt_text("监听地址", str(current["host"]))
    config["cooldownMs"] = prompt_number("冷却时间（毫秒）", current["cooldownMs"], minimum=0)
    config["blacklistThreshold"] = prompt_number("累计失败黑名单阈值（0 表示禁用）", current["blacklistThreshold"], minimum=0)
    config["balanceRefreshMs"] = prompt_number("余额刷新间隔（毫秒，0 表示禁用）", current["balanceRefreshMs"], minimum=0)
    config["maxRetries"] = prompt_number("每次请求最大重试数", current["maxRetries"], minimum=0)
    config["timeoutMs"] = prompt_number("上游超时（毫秒，0 表示不限）", current["timeoutMs"], minimum=0)
    config["maxBodyBytes"] = prompt_number("请求体上限（字节）", current["maxBodyBytes"], minimum=1)
    provider_index, provider = default_provider_entry(config)
    provider = dict(provider)
    provider_name = str(provider.get("name") or provider.get("id") or "default")
    provider_url = provider.get("baseUrl") or provider.get("upstream") or DEFAULTS["upstream"]
    print(f"\n编辑默认 Provider：{provider_name}")
    provider["baseUrl"] = prompt_text("上游地址", str(provider_url), validate_upstream)
    provider["keys"] = configure_keys(provider.get("keys"))
    config["providers"] = list(config["providers"])
    config["providers"][provider_index] = provider
    config["token"], generated = configure_token(str(current.get("token") or ""))
    config = normalize_config(config)
    backup = write_config(path, config)

    key_count = sum(
        len(provider.get("keys") or [])
        for provider in config["providers"]
        if isinstance(provider, dict)
    )
    print(f"\n已写入 {path}（权限 600，{key_count} 个 Key）")
    if backup:
        print(f"原配置备份：{backup}")
    if generated:
        print(f"自动生成的网关密码：{config['token']}")
        print("请妥善保存；也可以稍后重新运行本脚本修改。")
    print(f"面板地址：{local_gateway_url(config['host'], config['port'])}/")
    return config


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="交互式配置 deepseek-gateway")
    parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG, help="配置文件路径（默认 ./keys.json）")
    parser.add_argument("--no-codex", action="store_true", help="不询问 Codex CLI 接入")
    parser.add_argument("--no-start", action="store_true", help="不询问立即启动网关")
    parser.add_argument("--no-ui", action="store_true", help="跳过 shadcn 状态面板构建")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    path = args.config.expanduser().resolve()
    try:
        existing = load_existing(path)
        initial = connection_config(existing)
        if gateway_status(initial) == GATEWAY_RUNNING:
            gateway_url = local_gateway_url(initial["host"], initial["port"])
            print(f"检测到网关已在运行：{gateway_url}/")
            print("Provider 请通过状态面板管理；修改离线配置前请先停止网关。")
            return 0
        config = configure(path, existing)
        if not args.no_ui:
            run_ui_build()
        if not args.no_codex and confirm("同步配置到 Codex CLI", True):
            run_codex_setup(config, path, skip_ui=args.no_ui)
        if not args.no_start:
            status = gateway_status(config)
            gateway_url = local_gateway_url(config["host"], config["port"])
            if status == GATEWAY_RUNNING:
                print(f"\n检测到网关已在运行：{gateway_url}/")
                print("若本次修改了配置，请先停止现有进程，再重新启动以加载新配置。")
                return 0
            if confirm("立即启动网关", False):
                if status == GATEWAY_OCCUPIED:
                    raise RuntimeError(
                        f"{config['host']}:{config['port']} 已被占用，"
                        "但无法使用当前网关密码访问 /health；请停止占用进程或修改监听端口"
                    )
                print("按 Ctrl+C 停止网关。\n")
                return subprocess.call(["node", str(ROOT / "gateway.mjs"), "--config", str(path)])
        print(f"\n启动命令：node {ROOT / 'gateway.mjs'} --config {path}")
        return 0
    except (EOFError, KeyboardInterrupt):
        print("\n已取消。", file=sys.stderr)
        return 130
    except (OSError, RuntimeError, ValueError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
