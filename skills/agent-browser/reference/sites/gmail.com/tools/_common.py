from __future__ import annotations

import os
import subprocess
import sys
from typing import Any


AGENT_BROWSER_BIN = os.environ.get("AGENT_BROWSER_BIN", "agent-browser")


def run_agent_browser(*args: str, input_text: str | None = None) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [AGENT_BROWSER_BIN, *args],
        input=input_text,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )


def run_js(script: str) -> subprocess.CompletedProcess[str]:
    return run_agent_browser("eval", "--stdin", input_text=script)


def yaml_scalar(value: Any) -> str:
    text = "" if value is None else str(value)
    if text == "":
        return '""'
    if any(char in text for char in [": ", "#", '"']) or text.strip() != text:
        return '"' + text.replace("\\", "\\\\").replace('"', '\\"') + '"'
    return text


def emit_value(lines: list[str], key: str, value: Any, indent: int) -> None:
    prefix = " " * indent
    if isinstance(value, dict):
        lines.append(f"{prefix}{key}:")
        for child_key, child_value in value.items():
            emit_value(lines, child_key, child_value, indent + 2)
    elif isinstance(value, list):
        lines.append(f"{prefix}{key}:")
        for item in value:
            if isinstance(item, dict):
                first_key = next(iter(item))
                lines.append(f"{prefix}  - {first_key}: {yaml_scalar(item[first_key])}")
                for child_key, child_value in list(item.items())[1:]:
                    emit_value(lines, child_key, child_value, indent + 4)
            else:
                lines.append(f"{prefix}  - {yaml_scalar(item)}")
    elif isinstance(value, str) and "\n" in value:
        lines.append(f"{prefix}{key}: |")
        for text_line in value.splitlines():
            lines.append(f"{prefix}  {text_line}")
    else:
        lines.append(f"{prefix}{key}: {yaml_scalar(value)}")


def emit_yaml(data: dict[str, Any]) -> str:
    lines: list[str] = []
    for key, value in data.items():
        emit_value(lines, key, value, 0)
    return "\n".join(lines) + "\n"


def finish(status: str, message: str, data: dict[str, Any] | None = None, exit_code: int = 0) -> int:
    payload: dict[str, Any] = {"status": status}
    if data is not None:
        payload["data"] = data
    payload["message"] = message
    sys.stdout.write(emit_yaml(payload))
    return exit_code


def completed_output(result: subprocess.CompletedProcess[str]) -> str:
    return result.stdout.strip()


def completed_error(result: subprocess.CompletedProcess[str]) -> str:
    return (result.stderr or result.stdout).strip()


def wait_for_url_contains(fragment: str, attempts: int = 20, delay_ms: int = 500) -> subprocess.CompletedProcess[str] | None:
    last_result: subprocess.CompletedProcess[str] | None = None
    for _ in range(attempts):
        result = run_agent_browser("get", "url")
        if result.returncode == 0 and fragment in result.stdout:
            return result
        last_result = result
        run_agent_browser("wait", str(delay_ms))
    return last_result
