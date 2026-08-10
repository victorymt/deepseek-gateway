import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("gateway_configure", ROOT / "configure.py")
configure_module = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(configure_module)


class ConfigureWizardTests(unittest.TestCase):
    def test_v2_edits_default_provider_without_flattening_config(self):
        original = {
            "schemaVersion": 2,
            "port": 8787,
            "host": "127.0.0.1",
            "defaultProvider": "deepseek",
            "defaultModel": "deepseek--v4-flash",
            "token": "gateway-token",
            "providers": [
                {
                    "id": "deepseek",
                    "name": "DeepSeek",
                    "baseUrl": "https://api.deepseek.com",
                    "enabled": True,
                    "models": [
                        {"id": "v4-flash", "name": "V4 Flash", "upstreamModel": "deepseek-chat"}
                    ],
                    "keys": [{"name": "primary", "key": "sk-deepseek", "weight": 1}],
                },
                {
                    "id": "openrouter",
                    "name": "OpenRouter",
                    "baseUrl": "https://openrouter.ai/api/v1",
                    "enabled": True,
                    "models": [
                        {"id": "v4-flash", "name": "V4 Flash", "upstreamModel": "deepseek-chat"}
                    ],
                    "keys": [{"name": "secondary", "key": "sk-openrouter", "weight": 2}],
                },
            ],
            "customField": {"keep": True},
        }

        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "keys.json"
            path.write_text(json.dumps(original), encoding="utf-8")

            def prompt_text(label, current, validator=None):
                if label == "上游地址":
                    return validator("https://gateway.example.com") if validator else "https://gateway.example.com"
                return current

            with patch.object(configure_module, "prompt_number", side_effect=lambda _label, current, **_kwargs: current), \
                 patch.object(configure_module, "prompt_text", side_effect=prompt_text), \
                 patch.object(configure_module, "configure_keys", side_effect=lambda keys: keys), \
                 patch.object(configure_module, "configure_token", return_value=("gateway-token", False)):
                result = configure_module.configure(path)

            saved = json.loads(path.read_text(encoding="utf-8"))
            self.assertEqual(result, saved)
            self.assertNotIn("upstream", saved)
            self.assertNotIn("keys", saved)
            self.assertEqual(saved["providers"][0]["baseUrl"], "https://gateway.example.com")
            self.assertEqual(saved["providers"][0]["keys"], original["providers"][0]["keys"])
            self.assertEqual(saved["providers"][1], original["providers"][1])
            self.assertEqual(saved["providers"][0]["models"], original["providers"][0]["models"])
            self.assertEqual(saved["customField"], original["customField"])

    def test_v2_missing_default_provider_selects_first_enabled_provider(self):
        config = {
            "providers": [
                {"id": "disabled", "enabled": False},
                {"id": "openrouter", "enabled": True},
            ]
        }

        index, provider = configure_module.default_provider_entry(config)

        self.assertEqual(index, 1)
        self.assertEqual(provider["id"], "openrouter")
        self.assertEqual(config["defaultProvider"], "openrouter")


if __name__ == "__main__":
    unittest.main()
