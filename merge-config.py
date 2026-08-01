#!/usr/bin/env python3
import re
import sys
import pathlib
import json
import os

config_path, model, provider_id, gateway_url, models_path = sys.argv[1:6]
gateway_token = os.environ.get('GATEWAY_TOKEN', 'gateway')
p = pathlib.Path(config_path)
lines = p.read_text().splitlines() if p.exists() else []

DROP_KEYS = {
    'model', 'model_provider', 'model_catalog_json', 'model_reasoning_effort',
    'preferred_auth_method', 'forced_login_method',
}

def is_provider_section(stripped):
    if not (stripped.startswith('[') and stripped.endswith(']')):
        return False
    parts = [p.strip() for p in stripped[1:-1].split('.')]
    return len(parts) >= 2 and parts[0] == 'model_providers' and parts[1] == provider_id


out = []
skipping = False
in_table = False
for ln in lines:
    stripped = ln.strip()
    if skipping:
        if re.match(r'^\[', stripped):
            skipping = False
        else:
            continue
    if is_provider_section(stripped):
        skipping = True
        continue
    if re.match(r'^\[', stripped):
        in_table = True
        out.append(ln)
        continue
    m = re.match(r'^(\s*)([A-Za-z0-9_]+)\s*=', ln)
    if not in_table and m and m.group(2) in DROP_KEYS:
        continue
    out.append(ln)

top = [
    f'model = {json.dumps(model, ensure_ascii=False)}',
    f'model_provider = {json.dumps(provider_id, ensure_ascii=False)}',
    'preferred_auth_method = "apikey"',
    'forced_login_method = "api"',
    f'model_catalog_json = {json.dumps(models_path, ensure_ascii=False)}',
]

idx = next((i for i, ln in enumerate(out) if re.match(r'^\s*\[', ln)), len(out))
new = out[:idx] + top + out[idx:]
new += [
    '',
    f'[model_providers.{provider_id}]',
    'name = "deepseek"',
    f'base_url = {json.dumps(gateway_url, ensure_ascii=False)}',
    'wire_api = "responses"',
    f'experimental_bearer_token = {json.dumps(gateway_token, ensure_ascii=False)}',
    '',
]
p.write_text('\n'.join(new) + '\n')
