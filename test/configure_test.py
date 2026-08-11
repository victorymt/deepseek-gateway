import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("gateway_configure", ROOT / "configure_wizard.py")
configure_module = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(configure_module)


class ConfigureWizardTests(unittest.TestCase):
    def test_gateway_status_authenticates_and_recognizes_running_gateway(self):
        config = {"host": "0.0.0.0", "port": 8787, "token": "gateway-token"}
        response = MagicMock()
        response.status = 200
        response.read.return_value = json.dumps({
            "status": "ok",
            "version": "1.0.0",
            "providers": [],
        }).encode()
        connection = MagicMock()
        connection.getresponse.return_value = response

        with patch.object(configure_module.http.client, "HTTPConnection", return_value=connection) as factory:
            status = configure_module.gateway_status(config)

        self.assertEqual(status, configure_module.GATEWAY_RUNNING)
        factory.assert_called_once_with("127.0.0.1", 8787, timeout=0.5)
        connection.request.assert_called_once_with(
            "GET",
            "/health",
            headers={"Authorization": "Bearer gateway-token"},
        )
        connection.close.assert_called_once_with()

    def test_gateway_status_recognizes_legacy_health_response(self):
        payload = {
            "status": "ok",
            "version": "1.0.0",
            "mock": True,
            "keys": [],
            "total": {"requests": 0, "success": 0, "errors": 0},
        }

        self.assertTrue(configure_module.is_gateway_health(payload))

    def test_main_does_not_start_a_second_running_gateway(self):
        args = type("Args", (), {
            "config": Path("/tmp/keys.json"),
            "no_ui": True,
            "no_codex": True,
            "no_start": False,
            "cli_provider": False,
        })()
        config = {"host": "127.0.0.1", "port": 8787, "token": "gateway-token"}

        with patch.object(configure_module, "parse_args", return_value=args), \
             patch.object(configure_module, "load_existing", return_value=config), \
             patch.object(configure_module, "configure", return_value=config) as configure, \
             patch.object(configure_module, "gateway_status", return_value=configure_module.GATEWAY_RUNNING), \
             patch.object(configure_module, "confirm") as confirm, \
             patch.object(configure_module.subprocess, "call") as call:
            result = configure_module.main()

        self.assertEqual(result, 0)
        configure.assert_not_called()
        confirm.assert_not_called()
        call.assert_not_called()

    def test_main_checks_an_occupied_port_before_spawning_node(self):
        args = type("Args", (), {
            "config": Path("/tmp/keys.json"),
            "no_ui": True,
            "no_codex": True,
            "no_start": False,
            "cli_provider": False,
        })()
        config = {"host": "127.0.0.1", "port": 8787, "token": "gateway-token"}

        with patch.object(configure_module, "parse_args", return_value=args), \
             patch.object(configure_module, "configure", return_value=config), \
             patch.object(configure_module, "gateway_status", return_value=configure_module.GATEWAY_OCCUPIED), \
             patch.object(configure_module, "confirm", return_value=True), \
             patch.object(configure_module.subprocess, "call") as call:
            result = configure_module.main()

        self.assertEqual(result, 1)
        call.assert_not_called()

    def test_ui_build_runs_the_helper_script(self):
        completed = type("Completed", (), {"returncode": 0})()

        with patch.object(configure_module, "ui_needs_build", return_value=True), \
             patch.object(configure_module.subprocess, "run", return_value=completed) as run:
            result = configure_module.run_ui_build()

        self.assertTrue(result)
        run.assert_called_once_with([str(ROOT / "build-ui.sh")], check=False)

    def test_codex_setup_can_skip_ui_build(self):
        config = {"host": "127.0.0.1", "port": 8787, "defaultModel": "openrouter--sonnet"}
        completed = type("Completed", (), {"returncode": 0})()

        with patch.object(configure_module, "prompt_text", return_value="openrouter--sonnet") as prompt, \
             patch.object(configure_module.subprocess, "run", return_value=completed) as run, \
             patch("builtins.print") as output:
            configure_module.run_codex_setup(config, Path("/tmp/keys.json"), skip_ui=True)

        command = run.call_args.args[0]
        self.assertEqual(command, [str(ROOT / "setup-codex.sh"), "--skip-ui"])
        prompt.assert_called_once_with("Codex 默认模型别名", "openrouter--sonnet")
        output.assert_called_with("Gateway 未启用认证，Codex 不需要设置 Token 环境变量。")

    def test_legacy_config_migrates_to_v2(self):
        migrated = configure_module.migrate_to_v2({
            "upstream": "https://legacy.example/v1",
            "keys": [{"name": "legacy", "key": "sk-legacy", "weight": 2}],
        })

        self.assertEqual(migrated["schemaVersion"], 2)
        self.assertEqual(migrated["defaultProvider"], "deepseek")
        self.assertEqual(migrated["defaultModel"], "deepseek--v4-flash")
        self.assertNotIn("upstream", migrated)
        self.assertNotIn("keys", migrated)
        self.assertEqual(migrated["providers"][0]["baseUrl"], "https://legacy.example/v1")
        self.assertEqual(migrated["providers"][0]["keys"][0]["name"], "legacy")

    def test_existing_keys_preserve_always_try(self):
        existing = [{
            "name": "primary",
            "key": "sk-primary",
            "weight": 1,
            "enabled": True,
            "alwaysTry": True,
        }]

        with patch.object(configure_module, "confirm", return_value=False):
            keys = configure_module.configure_keys(existing)

        self.assertTrue(keys[0]["alwaysTry"])

    def test_v2_preserves_providers_without_prompting_for_keys(self):
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
                        {
                            "id": "v4-flash",
                            "name": "V4 Flash",
                            "upstreamModel": "deepseek-chat",
                            "inputModalities": ["text"],
                        }
                    ],
                    "keys": [
                        {
                            "name": "primary",
                            "key": "sk-deepseek",
                            "weight": 1,
                            "enabled": True,
                        }
                    ],
                },
                {
                    "id": "openrouter",
                    "name": "OpenRouter",
                    "baseUrl": "https://openrouter.ai/api/v1",
                    "enabled": True,
                    "models": [
                        {
                            "id": "v4-flash",
                            "name": "V4 Flash",
                            "upstreamModel": "deepseek-chat",
                            "inputModalities": ["text"],
                        }
                    ],
                    "keys": [
                        {
                            "name": "secondary",
                            "key": "sk-openrouter",
                            "weight": 2,
                            "enabled": True,
                        }
                    ],
                },
            ],
            "customField": {"keep": True},
        }

        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "keys.json"
            path.write_text(json.dumps(original), encoding="utf-8")

            with patch.object(configure_module, "prompt_number", side_effect=lambda _label, current, **_kwargs: current), \
                 patch.object(configure_module, "prompt_text", side_effect=lambda _label, current, _validator=None: current), \
                 patch.object(configure_module, "configure_keys") as configure_keys, \
                 patch.object(configure_module, "configure_token", return_value=("gateway-token", False)):
                result = configure_module.configure(path)

            saved = json.loads(path.read_text(encoding="utf-8"))
            self.assertEqual(result, saved)
            self.assertNotIn("upstream", saved)
            self.assertNotIn("keys", saved)
            self.assertEqual(saved["providers"][0]["baseUrl"], original["providers"][0]["baseUrl"])
            self.assertEqual(saved["providers"][0]["keys"], original["providers"][0]["keys"])
            self.assertEqual(
                saved["providers"][1],
                {**original["providers"][1], "upstreamFormat": "responses"},
            )
            self.assertEqual(saved["providers"][0]["upstreamFormat"], "responses")
            self.assertEqual(saved["providers"][0]["models"], original["providers"][0]["models"])
            self.assertEqual(saved["customField"], original["customField"])
            configure_keys.assert_not_called()

    def test_new_init_writes_setup_config_without_prompting_for_provider(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "keys.json"
            with patch.object(configure_module, "prompt_number", side_effect=lambda _label, current, **_kwargs: current), \
                 patch.object(configure_module, "prompt_text", side_effect=lambda _label, current, _validator=None: current), \
                 patch.object(configure_module, "configure_keys") as configure_keys, \
                 patch.object(configure_module, "configure_token", return_value=("", False)):
                result = configure_module.configure(path, {})

            self.assertTrue(result["setupPending"])
            self.assertEqual(result["providers"], [])
            self.assertEqual(result["defaultProvider"], "")
            self.assertEqual(result["defaultModel"], "")
            configure_keys.assert_not_called()

    def test_cli_provider_mode_retains_terminal_provider_setup(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "keys.json"
            with patch.object(configure_module, "prompt_number", side_effect=lambda _label, current, **_kwargs: current), \
                 patch.object(configure_module, "prompt_text", side_effect=lambda _label, current, validator=None: validator(current) if validator else current), \
                 patch.object(configure_module, "configure_keys", return_value=[
                     {"name": "primary", "key": "sk-terminal", "weight": 1, "enabled": True}
                 ]) as configure_keys, \
                 patch.object(configure_module, "configure_token", return_value=("", False)):
                result = configure_module.configure(path, {}, cli_provider=True)

            self.assertFalse(result["setupPending"])
            self.assertEqual(result["defaultProvider"], "deepseek")
            self.assertEqual(result["providers"][0]["keys"][0]["key"], "sk-terminal")
            configure_keys.assert_called_once()

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
