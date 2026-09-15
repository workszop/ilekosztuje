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
import json
import os
from pathlib import Path
import signal
import shutil
import subprocess
import sys
import tempfile
import threading
from contextlib import contextmanager
from urllib.parse import unquote
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
CAPACITY_SMOKE_MARKER = "data-capacity-smoke"


# This script is appended to a temporary copy of index.html.  Keeping the
# flow here, rather than in the application, exercises the real event
# listeners and render path without making the shipped file test-aware.
CAPACITY_SMOKE_SCRIPT = r"""
<script>
(() => {
  const MARKER = 'data-capacity-smoke';
  let assertions = 0;
  const expect = (condition, message) => {
    assertions += 1;
    if (!condition) throw new Error(message);
  };
  const blank = (value) => value == null || value === '';
  const app = document.querySelector('#app');
  const cardId = (key) => '#opt' + key[0].toUpperCase() + key.slice(1);
  const cards = ['cloud', 'own', 'small'];
  const fieldNames = ['units', 'utilization', 'supportedUsers', 'remainingUsers', 'status', 'note'];
  const datasetNames = ['units', 'utilization', 'utilizationLimit', 'supportedUsers', 'remainingUsers', 'capacityStatus'];
  const readCard = (key, requireCapacity = true, requireFields = true) => {
    const node = document.querySelector(cardId(key));
    expect(node, `${key}: result card missing`);
    const box = node.querySelector('.opt-capacity');
    if (requireCapacity) {
      expect(box, `${key}: .opt-capacity missing`);
      expect(!box.hidden && getComputedStyle(box).display !== 'none', `${key}: capacity is hidden`);
      expect(!box.closest('details'), `${key}: capacity is inside collapsed details`);
      for (const field of requireFields ? fieldNames : ['status']) {
        const matches = box.querySelectorAll(`[data-capacity-field="${field}"]`);
        expect(matches.length === 1, `${key}: capacity field ${field} is not unique`);
      }
    }
    const dataset = Object.fromEntries(datasetNames.map((name) => [name, node.dataset[name] ?? null]));
    const fields = Object.fromEntries(fieldNames.map((name) => [name, box?.querySelector(`[data-capacity-field="${name}"]`)?.textContent.trim() ?? '']));
    return { node, box, dataset, fields };
  };
  const setInput = (id, value) => {
    const node = document.getElementById(id);
    expect(node, `input #${id} missing`);
    node.value = String(value);
    node.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const click = (selector) => {
    const node = document.querySelector(selector);
    expect(node, `control ${selector} missing`);
    node.click();
  };
  const numeric = (card, name) => {
    const value = Number(card.dataset[name]);
    expect(Number.isFinite(value), `${name} must be numeric, got ${card.dataset[name]}`);
    return value;
  };
  const assertSized = (key, units, users, limit = 0.8) => {
    const card = readCard(key);
    expect(card.dataset.capacityStatus === 'sized', `${key}: expected sized status`);
    expect(card.dataset.units === String(units), `${key}: expected ${units} unit(s), got ${card.dataset.units}`);
    expect(Math.abs(numeric(card, 'utilizationLimit') - limit) < 1e-9, `${key}: wrong utilization limit`);
    const utilization = numeric(card, 'utilization');
    expect(utilization >= -1e-9 && utilization <= limit + 1e-9, `${key}: utilization exceeds ceiling`);
    const supported = numeric(card, 'supportedUsers');
    const remaining = numeric(card, 'remainingUsers');
    expect(supported >= users, `${key}: selected users exceed supported users`);
    expect(remaining >= 0, `${key}: remaining users is negative`);
    expect(card.fields.units && card.fields.utilization, `${key}: visible capacity values are empty`);
    return card;
  };
  const assertUnavailable = (key) => {
    const card = readCard(key, true, false);
    expect(card.dataset.capacityStatus === 'unavailable', `${key}: expected unavailable status`);
    for (const name of ['units', 'utilization', 'utilizationLimit', 'supportedUsers', 'remainingUsers']) {
      expect(blank(card.dataset[name]), `${key}: unavailable ${name} dataset must be blank`);
    }
    expect(card.fields.status, `${key}: unavailable status text is empty`);
    return card;
  };
  const assertInvalid = (key) => {
    const card = readCard(key, false);
    expect(card.dataset.capacityStatus === 'invalid', `${key}: expected invalid status`);
    for (const name of ['units', 'utilization', 'utilizationLimit', 'supportedUsers', 'remainingUsers']) {
      expect(blank(card.dataset[name]), `${key}: invalid ${name} dataset must be blank`);
    }
    if (card.box) expect(card.box.hidden || getComputedStyle(card.box).display === 'none', `${key}: invalid capacity is visible`);
    return card;
  };
  const assertSizedSet = (users, units, limit = 0.8) => {
    setInput('users', users);
    assertSized('cloud', units.cloud, users, limit);
    assertSized('own', units.own, users, limit);
    if (units.small == null) assertUnavailable('small');
    else assertSized('small', units.small, users, limit);
  };
  const finish = (payload) => {
    const target = app || document.documentElement;
    target.setAttribute(MARKER, encodeURIComponent(JSON.stringify({
      ...payload,
      assertions,
      viewport: { width: window.innerWidth, scrollWidth: document.documentElement.scrollWidth },
    })));
  };
  try {
    expect(app, '#app missing');
    const ceiling = document.querySelector('#maxUtilization');
    expect(ceiling, '#maxUtilization missing');
    expect(ceiling.value === '80', `default max utilization is ${ceiling.value}, expected 80`);
    expect(ceiling.min === '1' && ceiling.max === '100' && ceiling.step === '1', 'max utilization input bounds');
    expect(app.dataset.maxUtilization === '80', '#app max utilization dataset');

    // Default workload and automatic instance sizing.
    assertSizedSet(20, { cloud: 1, own: 1, small: 1 });
    assertSizedSet(100, { cloud: 1, own: 1, small: 2 });
    setInput('users', 400);
    assertSized('cloud', 2, 400);
    assertSized('own', 2, 400);
    assertUnavailable('small');

    // A 100% ceiling can fit the same cloud/own workload on one unit.
    setInput('maxUtilization', 100);
    assertSized('cloud', 1, 400, 1);
    assertSized('own', 1, 400, 1);
    assertUnavailable('small');

    // Non-binary ceilings must survive the DOM contract's raw fraction math.
    setInput('maxUtilization', 57);
    assertSizedSet(20, { cloud: 1, own: 1, small: 1 }, 0.57);
    const ceiling57Checks = checkDomContract(document, App.results);
    expect(ceiling57Checks.every((check) => check.pass), 'DOM contract at 57% ceiling');

    // GB10 remains unavailable at 200+ users, while 199 is still eligible.
    setInput('maxUtilization', 80);
    setInput('users', 199);
    assertSized('small', numeric(readCard('small'), 'units'), 199);
    setInput('users', 200);
    assertUnavailable('small');

    // Zero request workload is idle: cloud/own do not invent a user capacity.
    setInput('users', 20);
    setInput('reqPerDay', 0);
    for (const key of ['cloud', 'own']) {
      const card = readCard(key);
      expect(card.dataset.capacityStatus === 'idle', `${key}: zero workload should be idle`);
      expect(card.dataset.units === '1', `${key}: idle workload should keep one unit`);
      expect(Math.abs(numeric(card, 'utilization')) < 1e-9, `${key}: idle utilization should be zero`);
      expect(blank(card.dataset.supportedUsers) && blank(card.dataset.remainingUsers), `${key}: idle user capacity must be blank`);
    }
    const idleSmall = readCard('small');
    expect(idleSmall.dataset.capacityStatus === 'idle', 'small: zero workload should be idle');
    if (!blank(idleSmall.dataset.supportedUsers)) expect(numeric(idleSmall, 'supportedUsers') >= 199, 'small: idle user cap');
    setInput('reqPerDay', 20);

    // Presets and language toggles keep the original behavior.
    click('[data-lang="en"]');
    expect(document.documentElement.lang === 'en' && app.dataset.lang === 'en', 'English toggle');
    click('[data-lang="pl"]');
    expect(document.documentElement.lang === 'pl' && app.dataset.lang === 'pl', 'Polish toggle');
    click('[data-preset="S2"]');
    expect(document.querySelector('#users').value === '100', 'S2 preset users');
    assertSized('small', 2, 100);
    click('[data-preset="S3"]');
    expect(document.querySelector('#users').value === '300', 'S3 preset users');
    assertUnavailable('small');
    click('[data-preset="S1"]');
    expect(document.querySelector('#users').value === '20', 'S1 preset users');
    assertSized('small', 1, 20);

    // Save, serialize/import and apply the scenario with a non-default ceiling.
    setInput('maxUtilization', 73);
    expect(state.maxUtilization === 73 && app.dataset.maxUtilization === '73', 'max utilization input event');
    expect(saveScenario() === true, 'saveScenario should succeed');
    const savedText = localStorage.getItem(LS_SCENARIO);
    expect(savedText, 'saved scenario missing');
    expect(JSON.parse(savedText).values.maxUtilization === 73, 'saved scenario ceiling');
    const loaded = parseScenario(savedText);
    expect(loaded.values.maxUtilization === 73, 'parsed scenario ceiling');
    setInput('maxUtilization', 91);
    applyScenario(loaded);
    expect(state.maxUtilization === 73 && document.querySelector('#maxUtilization').value === '73', 'applied scenario ceiling');
    const imported = parseScenario(JSON.stringify(serializeScenario(state)));
    expect(imported.values.maxUtilization === 73, 'export/import ceiling');
    setInput('maxUtilization', 80);
    assertSizedSet(20, { cloud: 1, own: 1, small: 1 });

    // Invalid ceilings clear capacity data and hide the capacity panel; recovery works.
    setInput('maxUtilization', 0);
    cards.forEach(assertInvalid);
    setInput('maxUtilization', 101);
    cards.forEach(assertInvalid);
    setInput('maxUtilization', 80);
    assertSizedSet(20, { cloud: 1, own: 1, small: 1 });

    // The app's own DOM contract must detect both data and visible-value corruption.
    const baselineChecks = checkDomContract(document, App.results);
    expect(baselineChecks.length > 0 && baselineChecks.every((check) => check.pass), 'baseline DOM contract');
    const cloud = readCard('cloud');
    const oldUnits = cloud.node.dataset.units;
    cloud.node.dataset.units = '999';
    expect(checkDomContract(document, App.results).some((check) => !check.pass), 'DOM contract misses dataset corruption');
    cloud.node.dataset.units = oldUnits;
    const unitsField = cloud.box.querySelector('[data-capacity-field="units"]');
    const oldUnitsText = unitsField.textContent;
    unitsField.textContent = 'BROKEN';
    expect(checkDomContract(document, App.results).some((check) => !check.pass), 'DOM contract misses visible corruption');
    unitsField.textContent = oldUnitsText;
    expect(checkDomContract(document, App.results).every((check) => check.pass), 'DOM contract does not recover');

    expect(document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1, 'horizontal overflow');
    finish({ ok: true });
  } catch (error) {
    finish({ ok: false, error: String(error && (error.stack || error)) });
  }
})();
</script>
"""


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


def run_browser(
    browser: str,
    url: str,
    label: str,
    window_size: tuple[int, int] | None = None,
) -> str:
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
        if window_size:
            command.insert(-1, f"--window-size={window_size[0]},{window_size[1]}")
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


@contextmanager
def capacity_fixture(index: Path):
    """Yield a temporary app copy with the real-browser capacity flow appended."""

    try:
        source = index.read_text(encoding="utf-8")
    except OSError as error:
        raise SmokeFailure(f"Could not read {index} for capacity smoke: {error}") from error
    marker = "</body>"
    if marker not in source:
        raise SmokeFailure(f"Could not inject capacity smoke into {index}: no </body>")

    with tempfile.TemporaryDirectory(prefix="aicalc-capacity-fixture-") as directory:
        fixture_root = Path(directory)
        fixture_index = fixture_root / "index.html"
        fixture_index.write_text(
            source.replace(marker, CAPACITY_SMOKE_SCRIPT + "\n" + marker, 1),
            encoding="utf-8",
        )
        assets = index.parent / "assets"
        if assets.is_dir():
            shutil.copytree(assets, fixture_root / "assets")
        yield fixture_root, fixture_index


def check_capacity_smoke(dom: str, label: str) -> dict[str, object]:
    """Read and validate the result marker emitted by the temporary fixture."""

    parser = ContractParser()
    try:
        parser.feed(dom)
        parser.close()
    except Exception as error:  # HTMLParser should be forgiving, but report it.
        raise SmokeFailure(f"{label}: could not parse capacity smoke DOM: {error}") from error

    app = parser.nodes.get("app")
    encoded = app.get(CAPACITY_SMOKE_MARKER, "") if app else ""
    if not encoded:
        raise SmokeFailure(f"{label}: temporary fixture did not emit {CAPACITY_SMOKE_MARKER}")
    try:
        payload = json.loads(unquote(encoded))
    except (TypeError, ValueError) as error:
        raise SmokeFailure(f"{label}: invalid capacity smoke marker: {encoded!r}") from error
    if not isinstance(payload, dict):
        raise SmokeFailure(f"{label}: capacity smoke marker is not an object")
    if payload.get("ok") is not True:
        detail = str(payload.get("error") or "unknown capacity assertion failure")
        raise SmokeFailure(f"{label}: {detail}")
    assertions = payload.get("assertions")
    viewport = payload.get("viewport")
    if not isinstance(assertions, int) or assertions <= 0:
        raise SmokeFailure(f"{label}: capacity smoke emitted no assertions")
    if not isinstance(viewport, dict):
        raise SmokeFailure(f"{label}: capacity smoke omitted viewport details")
    try:
        width = int(viewport["width"])
        scroll_width = int(viewport["scrollWidth"])
    except (KeyError, TypeError, ValueError) as error:
        raise SmokeFailure(f"{label}: invalid capacity viewport details: {viewport!r}") from error
    if scroll_width > width + 1:
        raise SmokeFailure(
            f"{label}: horizontal overflow ({scroll_width}px content > {width}px viewport)"
        )
    return payload


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


def run_capacity_smoke(browser: str, index: Path) -> list[tuple[str, int, int]]:
    """Exercise capacity sizing in a temporary copy over HTTP and file://."""

    results: list[tuple[str, int, int]] = []
    with capacity_fixture(index) as (fixture_root, fixture_index):
        with local_server(fixture_root) as server:
            cases = [
                (
                    "capacity HTTP desktop",
                    f"http://127.0.0.1:{server.server_port}/?verify=1",
                    (1280, 900),
                ),
                (
                    "capacity HTTP mobile",
                    f"http://127.0.0.1:{server.server_port}/?verify=1",
                    (390, 844),
                ),
            ]
            for label, url, window_size in cases:
                probe_http(url)
                dom = run_browser(browser, url, label, window_size=window_size)
                passed, total = check_dom_contract(dom, label)
                check_capacity_smoke(dom, label)
                results.append((label, passed, total))

        # Keep the file:// promise covered by the same injected flow.  A fresh
        # browser profile gives it an independent localStorage origin.
        label = "capacity file://"
        file_dom = run_browser(browser, f"{fixture_index.resolve().as_uri()}?verify=1", label)
        passed, total = check_dom_contract(file_dom, label)
        check_capacity_smoke(file_dom, label)
        results.append((label, passed, total))
    return results


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

    results.extend(run_capacity_smoke(browser, index))

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
