#!/usr/bin/env python3
import json
import os
import pathlib
import re
import sys
import tempfile
import tomllib


config_path, model, provider_id, gateway_url, models_path, env_key = sys.argv[1:7]
path = pathlib.Path(config_path)
source = path.read_text() if path.exists() else ""
if source:
    tomllib.loads(source)

DROP_KEYS = {
    "model", "model_provider", "model_catalog_json", "model_reasoning_effort",
    "preferred_auth_method", "forced_login_method",
}


def marker_path(value, prefix=()):
    if not isinstance(value, dict):
        return None
    if value.get("__gateway_section_marker__") is True:
        return prefix
    for key, child in value.items():
        found = marker_path(child, (*prefix, key))
        if found is not None:
            return found
    return None


def table_path(line):
    stripped = line.lstrip()
    if not stripped.startswith("["):
        return None
    try:
        parsed = tomllib.loads(f"{stripped}\n__gateway_section_marker__ = true\n")
    except tomllib.TOMLDecodeError:
        return None
    return marker_path(parsed)


def is_provider_section(section):
    return (
        section is not None
        and len(section) >= 2
        and section[0] == "model_providers"
        and section[1] in {provider_id, "deepseek"}
    )


lines = source.splitlines()
output = []
skipping = False
in_table = False
for line in lines:
    section = table_path(line)
    if section is not None:
        in_table = True
        skipping = is_provider_section(section)
        if skipping:
            continue
    elif skipping:
        continue
    if not in_table:
        match = re.match(r'^\s*(?:"([^"]+)"|([A-Za-z0-9_-]+))\s*=', line)
        if match and (match.group(1) or match.group(2)) in DROP_KEYS:
            continue
    output.append(line)

top = [
    f"model = {json.dumps(model, ensure_ascii=False)}",
    f"model_provider = {json.dumps(provider_id, ensure_ascii=False)}",
    f"model_catalog_json = {json.dumps(models_path, ensure_ascii=False)}",
]

gateway_api_url = gateway_url.rstrip("/")
if not gateway_api_url.endswith("/v1"):
    gateway_api_url += "/v1"

first_table = next(
    (index for index, line in enumerate(output) if table_path(line) is not None),
    len(output),
)
merged = output[:first_table] + top + output[first_table:]
merged += [
    "",
    f"[model_providers.{provider_id}]",
    'name = "Multi-Provider Gateway"',
    f"base_url = {json.dumps(gateway_api_url, ensure_ascii=False)}",
    'wire_api = "responses"',
]
if env_key:
    merged += [
        f"env_key = {json.dumps(env_key, ensure_ascii=False)}",
        f"env_key_instructions = {json.dumps(f'Set {env_key} to the gateway token.', ensure_ascii=False)}",
    ]
merged.append("")
content = "\n".join(merged) + "\n"
tomllib.loads(content)

path.parent.mkdir(parents=True, exist_ok=True)
temp_name = None
try:
    with tempfile.NamedTemporaryFile(
        mode="w",
        encoding="utf-8",
        dir=path.parent,
        prefix=f".{path.name}.",
        delete=False,
    ) as temp:
        temp_name = temp.name
        temp.write(content)
        temp.flush()
        os.fsync(temp.fileno())
    os.chmod(temp_name, 0o600)
    os.replace(temp_name, path)
finally:
    if temp_name and os.path.exists(temp_name):
        os.unlink(temp_name)
