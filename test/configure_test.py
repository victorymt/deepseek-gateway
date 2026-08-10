import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("gateway_configure", ROOT / "configure.py")
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
        })()
        config = {"host": "127.0.0.1", "port": 8787, "token": "gateway-token"}

        with patch.object(configure_module, "parse_args", return_value=args), \
             patch.object(configure_module, "configure", return_value=config), \
             patch.object(configure_module, "gateway_status", return_value=configure_module.GATEWAY_RUNNING), \
             patch.object(configure_module, "confirm") as confirm, \
             patch.object(configure_module.subprocess, "call") as call:
            result = configure_module.main()

        self.assertEqual(result, 0)
        confirm.assert_not_called()
        call.assert_not_called()

    def test_main_checks_an_occupied_port_before_spawning_node(self):
        args = type("Args", (), {
            "config": Path("/tmp/keys.json"),
            "no_ui": True,
            "no_codex": True,
            "no_start": False,
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

        with patch.object(configure_module.subprocess, "run", return_value=completed) as run:
            result = configure_module.run_ui_build()

        self.assertTrue(result)
        run.assert_called_once_with([str(ROOT / "build-ui.sh")], check=False)

    def test_codex_setup_can_skip_ui_build(self):
        config = {"host": "127.0.0.1", "port": 8787}
        completed = type("Completed", (), {"returncode": 0})()

        with patch.object(configure_module, "prompt_text", return_value="deepseek--v4-flash"), \
             patch.object(configure_module.subprocess, "run", return_value=completed) as run:
            configure_module.run_codex_setup(config, Path("/tmp/keys.json"), skip_ui=True)

        command = run.call_args.args[0]
        self.assertEqual(command, [str(ROOT / "setup-codex.sh"), "--skip-ui"])

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
