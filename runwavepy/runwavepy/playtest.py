"""Python wrapper around the runwave Node CLI.

Shells out to ``runwave`` from the runwave repo. All the same requirements apply: recording needs a Linux host
with gstreamer, an X server or Xvfb, and PulseAudio. See the runwave README
for details.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Mapping, Optional, Union

PathLike = Union[str, "os.PathLike[str]"]
LogHandler = Callable[[dict], None]


class PlaytestError(RuntimeError):
    """Raised when the runwave CLI exits non-zero or misbehaves."""

    def __init__(
        self,
        message: str,
        *,
        exit_code: int,
        summary: Optional[dict] = None,
    ) -> None:
        super().__init__(message)
        self.exit_code = exit_code
        self.summary = summary


@dataclass
class PlaytestResult:
    status: str
    summary: dict
    out_dir: Path
    exit_code: int


def _resolve_cli(cli_path: Optional[PathLike]) -> str:
    if cli_path:
        return str(cli_path)
    found = shutil.which("runwave")
    if found:
        return found
    raise FileNotFoundError(
        "runwave CLI not found on PATH. Install runwave "
        "(`npm install -g <runwave-repo>`) or pass cli_path=... explicitly."
    )


def run_playtest(
    *,
    game_dir: PathLike,
    out_dir: PathLike,
    port: Optional[int] = None,
    target_kind: str = "web",
    openrouter_api_key: Optional[str] = None,
    viewport: Optional[Mapping[str, int]] = None,
    playtest_duration_ms: Optional[int] = None,
    min_playtest_ms: Optional[int] = None,
    launch_settle_ms: Optional[int] = None,
    model: Optional[str] = None,
    verbose: bool = False,
    cli_path: Optional[PathLike] = None,
    env: Optional[Mapping[str, str]] = None,
    on_log: Optional[LogHandler] = None,
) -> PlaytestResult:
    """Run a runwave playtest by invoking the runwave Node CLI.

    Parameters
    ----------
    game_dir:
        Path to the game directory. Must contain ``start.sh`` and ``playtest.md``.
    out_dir:
        Directory for artifacts (video, screenshots, agent history, summary.json).
        Created if it does not exist.
    port:
        Port passed to ``start.sh`` via ``PORT=`` and used as
        ``http://127.0.0.1:<port>/``. Required for web games; ignored for
        native Linux games.
    target_kind:
        ``"web"`` for browser games or ``"linux"`` for native Linux games.
    openrouter_api_key:
        OpenRouter API key. If omitted, ``OPENROUTER_API_KEY`` must already be
        in the environment (or in ``env``).
    viewport:
        Browser viewport and video size as ``{"width": 1280, "height": 720}``.
    playtest_duration_ms:
        Max playtest wall time. Defaults to 150000 (2m30s) if omitted.
    min_playtest_ms:
        Floor before the agent may self-stop. Defaults to duration - 10000.
    launch_settle_ms:
        Native Linux only. Milliseconds to wait after launch before the first
        agent call. Defaults to RunWave's Linux controller default.
    model:
        OpenRouter model slug. Sets ``RUNWAVE_AGENT_MODEL`` for the CLI.
    verbose:
        Forwards ``--verbose`` to the CLI (runwave harness ndjson timing log).
    cli_path:
        Explicit path to ``runwave``. Otherwise looked up on ``PATH``.
    env:
        Extra environment variables to merge into the CLI's environment.
    on_log:
        If provided, called with one parsed ndjson dict per stdout line. Lines
        that are not JSON are passed as ``{"raw": <line>}``. When omitted,
        stdout is printed as it arrives.

    Returns
    -------
    PlaytestResult
        Wraps the parsed ``summary.json`` plus process exit code.

    Raises
    ------
    PlaytestError
        If the CLI exits non-zero, or exits 0 without writing ``summary.json``.
    FileNotFoundError
        If the CLI cannot be located.
    ValueError
        If no OpenRouter API key is available.
    """
    resolved_cli = _resolve_cli(cli_path)
    game_dir_path = Path(game_dir).resolve()
    out_dir_path = Path(out_dir).resolve()
    out_dir_path.mkdir(parents=True, exist_ok=True)

    args = [
        resolved_cli,
        "--game-dir", str(game_dir_path),
        "--out-dir", str(out_dir_path),
        "--kind", target_kind,
    ]
    if port is not None:
        args += ["--port", str(port)]
    if viewport is not None:
        args += ["--viewport", f"{viewport['width']}x{viewport['height']}"]
    if playtest_duration_ms is not None:
        args += ["--playtest-duration-ms", str(playtest_duration_ms)]
    if min_playtest_ms is not None:
        args += ["--min-playtest-ms", str(min_playtest_ms)]
    if launch_settle_ms is not None:
        args += ["--launch-settle-ms", str(launch_settle_ms)]
    if model:
        args += ["--model", model]
    if verbose:
        args.append("--verbose")

    resolved_env: dict[str, str] = dict(os.environ)
    if env:
        resolved_env.update(env)
    if openrouter_api_key:
        resolved_env["OPENROUTER_API_KEY"] = openrouter_api_key
    if not resolved_env.get("OPENROUTER_API_KEY"):
        raise ValueError(
            "OPENROUTER_API_KEY is required; pass openrouter_api_key=... or set "
            "it in the environment / env=... mapping."
        )

    with subprocess.Popen(
        args,
        env=resolved_env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
    ) as process:
        assert process.stdout is not None

        for line in process.stdout:
            stripped = line.rstrip("\n")
            if on_log is not None:
                try:
                    on_log(json.loads(stripped))
                except json.JSONDecodeError:
                    on_log({"raw": stripped})
            else:
                print(stripped, flush=True)

        exit_code = process.wait()
    summary_path = out_dir_path / "summary.json"
    summary: Optional[dict[str, Any]] = None
    if summary_path.exists():
        with summary_path.open("r", encoding="utf-8") as fh:
            summary = json.load(fh)

    if exit_code != 0:
        message = f"runwave exited {exit_code}"
        if summary and summary.get("error"):
            message += f": {summary['error']}"
        raise PlaytestError(message, exit_code=exit_code, summary=summary)

    if summary is None:
        raise PlaytestError(
            "runwave exited 0 but did not write summary.json",
            exit_code=exit_code,
            summary=None,
        )

    return PlaytestResult(
        status=str(summary.get("status", "unknown")),
        summary=summary,
        out_dir=out_dir_path,
        exit_code=exit_code,
    )
