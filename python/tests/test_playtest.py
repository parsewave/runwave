import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from runwave import PlaytestError, run_playtest  # noqa: E402


class FakeProcess:
    def __init__(self, lines=None, exit_code=0):
        self.stdout = iter(lines or [])
        self._exit_code = exit_code

    def wait(self):
        return self._exit_code


class RunPlaytestTests(unittest.TestCase):
    def test_invokes_cli_and_returns_summary(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            game_dir = root / "game"
            out_dir = root / "out"
            game_dir.mkdir()
            calls = []

            def fake_popen(args, **kwargs):
                calls.append((args, kwargs))
                with (out_dir / "summary.json").open("w", encoding="utf-8") as fh:
                    json.dump({"status": "passed", "ok": True}, fh)
                return FakeProcess(
                    ['{"event":"playtest.start"}\n', "plain text\n"],
                    exit_code=0,
                )

            logs = []
            with patch("subprocess.Popen", side_effect=fake_popen):
                result = run_playtest(
                    game_dir=game_dir,
                    out_dir=out_dir,
                    port=7777,
                    openrouter_api_key="key-from-arg",
                    max_duration=123000,
                    min_duration=120000,
                    model="openrouter/model",
                    verbose=True,
                    cli_path="/tmp/runwave-playtest",
                    env={"EXTRA": "1"},
                    on_log=logs.append,
                )

            args, kwargs = calls[0]
            self.assertEqual(
                args,
                [
                    "/tmp/runwave-playtest",
                    "--game-dir",
                    str(game_dir.resolve()),
                    "--out-dir",
                    str(out_dir.resolve()),
                    "--port",
                    "7777",
                    "--max-duration",
                    "123000",
                    "--min-duration",
                    "120000",
                    "--model",
                    "openrouter/model",
                    "--verbose",
                ],
            )
            self.assertEqual(kwargs["env"]["OPENROUTER_API_KEY"], "key-from-arg")
            self.assertEqual(kwargs["env"]["EXTRA"], "1")
            self.assertEqual(kwargs["stderr"], subprocess.STDOUT)
            self.assertEqual(logs, [{"event": "playtest.start"}, {"raw": "plain text"}])
            self.assertEqual(result.status, "passed")
            self.assertEqual(result.summary["ok"], True)
            self.assertEqual(result.exit_code, 0)
            self.assertEqual(result.out_dir, out_dir.resolve())

    def test_openrouter_key_can_come_from_env_mapping(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            game_dir = root / "game"
            out_dir = root / "out"
            game_dir.mkdir()
            captured_env = {}

            def fake_popen(args, **kwargs):
                del args
                captured_env.update(kwargs["env"])
                with (out_dir / "summary.json").open("w", encoding="utf-8") as fh:
                    json.dump({"status": "passed"}, fh)
                return FakeProcess(exit_code=0)

            with patch.dict(os.environ, {}, clear=True):
                with patch("subprocess.Popen", side_effect=fake_popen):
                    run_playtest(
                        game_dir=game_dir,
                        out_dir=out_dir,
                        port=7777,
                        cli_path="/tmp/runwave-playtest",
                        env={"OPENROUTER_API_KEY": "key-from-env"},
                        on_log=lambda _: None,
                    )

            self.assertEqual(captured_env["OPENROUTER_API_KEY"], "key-from-env")

    def test_openrouter_key_is_required(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            with patch.dict(os.environ, {}, clear=True):
                with self.assertRaisesRegex(ValueError, "OPENROUTER_API_KEY is required"):
                    run_playtest(
                        game_dir=root / "game",
                        out_dir=root / "out",
                        port=7777,
                        cli_path="/tmp/runwave-playtest",
                        on_log=lambda _: None,
                    )

    def test_nonzero_exit_raises_with_summary_error(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            game_dir = root / "game"
            out_dir = root / "out"
            game_dir.mkdir()

            def fake_popen(args, **kwargs):
                del args, kwargs
                with (out_dir / "summary.json").open("w", encoding="utf-8") as fh:
                    json.dump({"status": "failed", "error": "bad viewport"}, fh)
                return FakeProcess(exit_code=1)

            with patch("subprocess.Popen", side_effect=fake_popen):
                with self.assertRaisesRegex(PlaytestError, "bad viewport") as cm:
                    run_playtest(
                        game_dir=game_dir,
                        out_dir=out_dir,
                        port=7777,
                        openrouter_api_key="key",
                        cli_path="/tmp/runwave-playtest",
                        on_log=lambda _: None,
                    )

            self.assertEqual(cm.exception.exit_code, 1)
            self.assertEqual(cm.exception.summary["error"], "bad viewport")

    def test_zero_exit_without_summary_raises(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            game_dir = root / "game"
            out_dir = root / "out"
            game_dir.mkdir()

            with patch("subprocess.Popen", return_value=FakeProcess(exit_code=0)):
                with self.assertRaisesRegex(PlaytestError, "did not write summary.json"):
                    run_playtest(
                        game_dir=game_dir,
                        out_dir=out_dir,
                        port=7777,
                        openrouter_api_key="key",
                        cli_path="/tmp/runwave-playtest",
                        on_log=lambda _: None,
                    )


if __name__ == "__main__":
    unittest.main()
