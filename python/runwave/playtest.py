"""Python wrapper around the runwave-playtest Node CLI.

Shells out to ``runwave-playtest`` (see ``playtest/cli.js`` in the
runwave repo). All the same requirements apply: recording needs a Linux host
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
    """Raised when the runwave-playtest CLI exits non-zero or misbehaves."""

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
    found = shutil.which("runwave-playtest")
    if found:
        return found
    raise FileNotFoundError(
        "runwave-playtest CLI not found on PATH. Install runwave "
        "(`npm install -g <runwave-repo>`) or pass cli_path=... explicitly."
    )


def run_playtest(
    *,
    game_dir: PathLike,
    out_dir: PathLike,
    port: int,
    openrouter_api_key: Optional[str] = None,
    max_duration: Optional[int] = None,
    min_duration: Optional[int] = None,
    model: Optional[str] = None,
    verbose: bool = False,
    cli_path: Optional[PathLike] = None,
    env: Optional[Mapping[str, str]] = None,
    on_log: Optional[LogHandler] = None,
) -> PlaytestResult:
    """Run a runwave playtest by invoking the runwave-playtest Node CLI.

    Parameters
    ----------
    game_dir:
        Path to the game directory. Must contain ``start.sh`` and ``playtest.md``.
    out_dir:
        Directory for artifacts (video, screenshots, agent history, summary.json).
        Created if it does not exist.
    port:
        Port passed to ``start.sh`` via ``PORT=`` and used as
        ``http://127.0.0.1:<port>/``.
    openrouter_api_key:
        OpenRouter API key. If omitted, ``OPENROUTER_API_KEY`` must already be
        in the environment (or in ``env``).
    max_duration:
        Max run wall time. Defaults to 150000 (2m30s) if omitted.
    min_duration:
        Floor before the agent may self-stop. Defaults to max duration - 10000.
    model:
        OpenRouter model slug. Sets ``RUNWAVE_AGENT_MODEL`` for the CLI.
    verbose:
        Forwards ``--verbose`` to the CLI (runwave harness ndjson timing log).
    cli_path:
        Explicit path to ``runwave-playtest``. Otherwise looked up on ``PATH``.
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
        "--port", str(port),
    ]
    if max_duration is not None:
        args += ["--max-duration", str(max_duration)]
    if min_duration is not None:
        args += ["--min-duration", str(min_duration)]
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

    process = subprocess.Popen(
        args,
        env=resolved_env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
    )
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
        message = f"runwave-playtest exited {exit_code}"
        if summary and summary.get("error"):
            message += f": {summary['error']}"
        raise PlaytestError(message, exit_code=exit_code, summary=summary)

    if summary is None:
        raise PlaytestError(
            "runwave-playtest exited 0 but did not write summary.json",
            exit_code=exit_code,
            summary=None,
        )

    return PlaytestResult(
        status=str(summary.get("status", "unknown")),
        summary=summary,
        out_dir=out_dir_path,
        exit_code=exit_code,
    )
