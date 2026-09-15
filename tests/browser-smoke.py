#!/usr/bin/env python3
"""Run the permanent browser contract check for the standalone calculator.

The runner deliberately uses only Python's standard library and the browser's
``--dump-dom`` mode.  It does not use CDP, install a browser, or require a
JavaScript package manager.
"""

from __future__ import annotations

import argparse
import functools
from html.parser import HTMLParser
import os
from pathlib import Path
import signal
import shutil
import subprocess
import sys
import tempfile
import threading
from contextlib import contextmanager
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.request import urlopen


BROWSER_TIMEOUT_SECONDS = 45
MAX_DIAGNOSTIC_CHARS = 2_000
BROWSER_CANDIDATES = (
    "google-chrome",
    "google-chrome-stable",
    "chromium",
    "chromium-browser",
    "chrome",
)


class SmokeFailure(RuntimeError):
    """An actionable smoke-test failure."""


class BrowserUnavailable(SmokeFailure):
    """No supported browser executable is available."""


class ContractParser(HTMLParser):
    """Collect only the attributes needed by the DOM contract."""

    TARGET_IDS = {
        "app",
        "checksPanel",
        "settingsPanel",
        "resultsPanel",
        "options",
        "presets",
        "advancedPanel",
        "settingsToggle",
        "settingsClose",
        "settingsBackdrop",
        "scenarioSave",
        "scenarioExport",
        "scenarioImport",
        "scenarioReset",
    }
    VOID_TAGS = {
        "area",
        "base",
        "br",
        "col",
        "embed",
        "hr",
        "img",
        "input",
        "link",
        "meta",
        "param",
        "source",
        "track",
        "wbr",
    }

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.nodes: dict[str, dict[str, str]] = {}
        self.records: list[dict[str, object]] = []
        self.stack: list[dict[str, object]] = []

    def _start(self, tag: str, attrs: list[tuple[str, str | None]], self_closing: bool = False) -> None:
        attributes = {name: value or "" for name, value in attrs}
        record: dict[str, object] = {
            "tag": tag.lower(),
            "attrs": attributes,
            "ancestors": tuple(self.stack),
        }
        self.records.append(record)
        node_id = attributes.get("id")
        if node_id and node_id not in self.nodes:
            self.nodes[node_id] = {
                **attributes,
                "__tag": tag.lower(),
            }
        if not self_closing and tag.lower() not in self.VOID_TAGS:
            self.stack.append(record)

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self._start(tag, attrs)

    def handle_startendtag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self._start(tag, attrs, self_closing=True)

    def handle_endtag(self, tag: str) -> None:
        tag = tag.lower()
        for index in range(len(self.stack) - 1, -1, -1):
            if self.stack[index]["tag"] == tag:
                del self.stack[index:]
                break


class QuietHandler(SimpleHTTPRequestHandler):
    """Serve the repository without filling CI logs with request lines."""

    def log_message(self, _format: str, *_args: object) -> None:
        return


@contextmanager
def local_server(root: Path):
    """Serve ``root`` on an ephemeral loopback port and always stop it."""

    handler = functools.partial(QuietHandler, directory=str(root))
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    server.daemon_threads = True
    thread = threading.Thread(
        target=server.serve_forever,
        kwargs={"poll_interval": 0.05},
        name="aicalc-http-server",
        daemon=True,
    )
    thread.start()
    try:
        yield server
    finally:
        # ``shutdown`` must be called from a thread other than serve_forever.
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


def find_browser() -> str:
    """Find a pre-installed Chrome/Chromium executable, without installing it."""

    configured = os.environ.get("AICALC_BROWSER", "").strip()
    if configured:
        path = shutil.which(configured) or (configured if Path(configured).is_file() else None)
        if path:
            return path
        raise BrowserUnavailable(
            f"AICALC_BROWSER={configured!r} does not point to an executable. "
            "Set it to google-chrome or chromium."
        )

    for candidate in BROWSER_CANDIDATES:
        path = shutil.which(candidate)
        if path:
            return path

    names = ", ".join(BROWSER_CANDIDATES[:4])
    raise BrowserUnavailable(
        "Google Chrome/Chromium was not found (looked for "
        f"{names}). Install a supported browser and rerun "
        "python3 tests/browser-smoke.py; this script does not install browsers."
    )


def terminate_process(process: subprocess.Popen[str]) -> None:
    """Stop the browser and its process group, even after an exception."""

    if os.name != "posix" and process.poll() is not None:
        return

    if os.name == "posix":
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            return
    else:
        process.terminate()

    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        pass

    if os.name == "posix":
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            return
    else:
        process.kill()
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        # There is no safe stronger action in the standard library here.  The
        # caller still gets the original timeout/error with useful context.
        pass


def run_browser(browser: str, url: str, label: str) -> str:
    """Dump one URL's post-JavaScript DOM with a fresh temporary profile."""

    with tempfile.TemporaryDirectory(prefix="aicalc-browser-profile-") as profile:
        command = [
            browser,
            "--headless",
            "--disable-gpu",
            "--disable-dev-shm-usage",
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-extensions",
            f"--user-data-dir={profile}",
            "--dump-dom",
            url,
        ]
        try:
            process = subprocess.Popen(
                command,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                encoding="utf-8",
                errors="replace",
                start_new_session=(os.name == "posix"),
            )
        except OSError as error:
            raise SmokeFailure(f"{label}: could not start {browser}: {error}") from error

        try:
            stdout, stderr = process.communicate(timeout=BROWSER_TIMEOUT_SECONDS)
        except subprocess.TimeoutExpired as error:
            terminate_process(process)
            # Drain pipes after killing the process so no child keeps the file
            # descriptors open while TemporaryDirectory is being removed.
            try:
                stdout, stderr = process.communicate(timeout=5)
            except subprocess.TimeoutExpired:
                stdout, stderr = "", "Browser descendants kept output pipes open after cleanup."
            detail = (stderr or stdout).strip()[-MAX_DIAGNOSTIC_CHARS:]
            suffix = f" Output: {detail}" if detail else ""
            raise SmokeFailure(
                f"{label}: browser timed out after {BROWSER_TIMEOUT_SECONDS}s.{suffix}"
            ) from error
        finally:
            # Covers exceptions from communicate and also makes cleanup
            # explicit on successful runs (where poll() is already non-null).
            terminate_process(process)

        if process.returncode != 0:
            detail = (stderr or stdout).strip()[-MAX_DIAGNOSTIC_CHARS:]
            raise SmokeFailure(
                f"{label}: browser exited with code {process.returncode}. "
                f"{detail or 'No browser diagnostics were emitted.'}"
            )
        return stdout


def check_dom_contract(dom: str, label: str) -> tuple[int, int]:
    """Validate the stable DOM contract emitted by ``?verify=1``."""

    parser = ContractParser()
    try:
        parser.feed(dom)
        parser.close()
    except Exception as error:  # HTMLParser should be forgiving, but report it.
        raise SmokeFailure(f"{label}: could not parse dumped DOM: {error}") from error

    app = parser.nodes.get("app")
    panel = parser.nodes.get("checksPanel")
    if not app:
        raise SmokeFailure(f"{label}: dumped DOM has no #app element")
    if not panel:
        raise SmokeFailure(f"{label}: dumped DOM has no #checksPanel element")

    state = app.get("data-state", "")
    if state != "ready":
        raise SmokeFailure(
            f"{label}: #app data-state={state!r}, expected 'ready'"
        )

    passed_text = panel.get("data-passed", "")
    total_text = panel.get("data-total", "")
    try:
        passed = int(passed_text)
        total = int(total_text)
    except ValueError as error:
        raise SmokeFailure(
            f"{label}: #checksPanel has invalid data-passed/data-total "
            f"({passed_text!r}/{total_text!r})"
        ) from error

    if total <= 0 or passed != total:
        raise SmokeFailure(
            f"{label}: calculator checks failed ({passed}/{total}); "
            "expected equal values and total > 0"
        )

    check_layout_contract(parser, label)
    return passed, total


def check_layout_contract(parser: ContractParser, label: str) -> None:
    """Validate the sidebar/results containment and mobile drawer contract."""

    def required(node_id: str) -> dict[str, str]:
        node = parser.nodes.get(node_id)
        if not node:
            raise SmokeFailure(f"{label}: dumped DOM has no #{node_id} element")
        return node

    def records_with_id(node_id: str) -> list[dict[str, object]]:
        return [
            record
            for record in parser.records
            if (record["attrs"] or {}).get("id") == node_id
        ]

    def is_descendant(record: dict[str, object], ancestor_id: str) -> bool:
        return any(
            (ancestor["attrs"] or {}).get("id") == ancestor_id
            for ancestor in record["ancestors"]  # type: ignore[index]
        )

    def tag(node: dict[str, str]) -> str:
        return node.get("__tag", "")

    settings = required("settingsPanel")
    results = required("resultsPanel")
    options = required("options")
    if tag(settings) != "aside":
        raise SmokeFailure(f"{label}: #settingsPanel must be an <aside>")
    if not results or not options:
        raise SmokeFailure(f"{label}: results layout contract is incomplete")

    option_records = records_with_id("options")
    if len(option_records) != 1 or not is_descendant(option_records[0], "resultsPanel"):
        raise SmokeFailure(f"{label}: #resultsPanel must contain #options")

    editable = [
        record
        for record in parser.records
        if record["tag"] in {"input", "select"}
    ]
    outside_settings = [
        (record["attrs"] or {}).get("id") or record["tag"]
        for record in editable
        if not is_descendant(record, "settingsPanel")
    ]
    if outside_settings:
        raise SmokeFailure(
            f"{label}: input/select controls outside #settingsPanel: "
            + ", ".join(str(value) for value in outside_settings)
        )

    option_controls = [
        (record["attrs"] or {}).get("id") or record["tag"]
        for record in editable
        if is_descendant(record, "options")
    ]
    if option_controls:
        raise SmokeFailure(
            f"{label}: result cards contain editable controls: "
            + ", ".join(str(value) for value in option_controls)
        )

    for node_id in ("presets", "advancedPanel"):
        records = records_with_id(node_id)
        if len(records) != 1 or not is_descendant(records[0], "settingsPanel"):
            raise SmokeFailure(f"{label}: #{node_id} must be inside #settingsPanel")

    for node_id in ("scenarioSave", "scenarioExport", "scenarioImport", "scenarioReset"):
        records = records_with_id(node_id)
        if len(records) != 1 or not is_descendant(records[0], "settingsPanel"):
            raise SmokeFailure(f"{label}: #{node_id} must be inside #settingsPanel")

    page_heads = [
        record
        for record in parser.records
        if "page-head" in str((record["attrs"] or {}).get("class", "")).split()
    ]
    if len(page_heads) != 1:
        raise SmokeFailure(f"{label}: expected one compact .page-head")

    toggle = required("settingsToggle")
    if tag(toggle) != "button" or toggle.get("type") != "button":
        raise SmokeFailure(f"{label}: #settingsToggle must be a type=button control")
    if toggle.get("aria-controls") != "settingsPanel":
        raise SmokeFailure(f"{label}: #settingsToggle must control #settingsPanel")
    if toggle.get("aria-expanded") not in {"true", "false"}:
        raise SmokeFailure(f"{label}: #settingsToggle needs aria-expanded")

    for node_id in ("settingsClose", "settingsBackdrop"):
        control = required(node_id)
        if tag(control) != "button" or control.get("type") != "button":
            raise SmokeFailure(f"{label}: #{node_id} must be a type=button control")

    app = required("app")
    if app.get("data-settings") not in {"open", "closed"}:
        raise SmokeFailure(f"{label}: #app data-settings must be open or closed")
    expected_expanded = "true" if app.get("data-settings") == "open" else "false"
    if toggle.get("aria-expanded") != expected_expanded:
        raise SmokeFailure(
            f"{label}: #app data-settings and #settingsToggle aria-expanded disagree"
        )


def probe_http(url: str) -> None:
    """Confirm the ephemeral server is reachable before launching Chrome."""

    try:
        with urlopen(url, timeout=5) as response:
            if response.status != 200:
                raise SmokeFailure(f"HTTP probe returned status {response.status}")
            response.read()
    except SmokeFailure:
        raise
    except Exception as error:
        raise SmokeFailure(f"Could not reach local test server at {url}: {error}") from error


def run_smoke(root: Path) -> list[tuple[str, int, int]]:
    browser = find_browser()
    index = root / "index.html"
    if not index.is_file():
        raise SmokeFailure(f"Repository has no {index}")

    results: list[tuple[str, int, int]] = []
    with local_server(root) as server:
        http_url = f"http://127.0.0.1:{server.server_port}/?verify=1"
        probe_http(http_url)
        http_dom = run_browser(browser, http_url, "HTTP smoke")
        http_passed, http_total = check_dom_contract(http_dom, "HTTP smoke")
        results.append(("http://", http_passed, http_total))

        # Chromium accepts a query component on a file URI.  Keep this check
        # because the app promises to remain usable when opened without a server.
        file_url = f"{index.resolve().as_uri()}?verify=1"
        file_dom = run_browser(browser, file_url, "file:// smoke")
        file_passed, file_total = check_dom_contract(file_dom, "file:// smoke")
        results.append(("file://", file_passed, file_total))

    return results


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--root",
        type=Path,
        default=Path(__file__).resolve().parents[1],
        help="repository root (default: directory containing this tests/ folder)",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    root = args.root.resolve()
    try:
        results = run_smoke(root)
    except BrowserUnavailable as error:
        print(f"browser-smoke: unavailable: {error}", file=sys.stderr)
        return 1
    except SmokeFailure as error:
        print(f"browser-smoke: FAIL: {error}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print("browser-smoke: interrupted", file=sys.stderr)
        return 130
    except Exception as error:
        print(f"browser-smoke: FAIL: unexpected error: {error}", file=sys.stderr)
        return 1

    browser = os.environ.get("AICALC_BROWSER") or "Chrome/Chromium"
    print(f"browser-smoke: PASS ({browser})")
    for protocol, passed, total in results:
        print(f"  {protocol} #app ready; calculator checks {passed}/{total}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
