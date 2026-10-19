"use strict";

// An unpacked extension update must not refresh a generating chat just to
// install status UI. The small injected fallback must detect icon-only Stop.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const chromePath = process.env.CQ_BROWSER_BIN || (process.platform === "win32"
  ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
  : "/usr/bin/google-chrome");

test("unsafe icon-only chat gets a temporary spinner without reloading", {
  skip: !fs.existsSync(chromePath) && "Chrome is not installed",
}, () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "cq-tab-update-"));
  try {
    const src = fs.readFileSync(path.join(__dirname, "..", "background.js"), "utf8");
    const version = JSON.parse(fs.readFileSync(
      path.join(__dirname, "..", "manifest.json"), "utf8")).version;
    const beginning = src.indexOf("function inspectUpdateRefreshSafety() {");
    const end = src.indexOf("\nasync function inspectUpdateTab(", beginning);
    assert.ok(beginning >= 0 && end > beginning);
    const fallbackFunctions = src.slice(beginning, end);
    const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>会话</title></head><body>
<main><form data-chatgpt-composer>
  <textarea id="prompt-textarea"></textarea>
  <button type="button" aria-label="Start Voice">语音</button>
  <button type="button" id="primary"><svg class="icon-primary-action">
    <path d="M4.5 5.75C4.5 5.05964 5.05964 4.5 5.75 4.5H14.25"/>
  </svg></button>
</form></main>
<script>${fallbackFunctions}</script>
<script>
setTimeout(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const flags = {};
  const spinning = () => /^[◴◷◶◵] /.test(document.title);
  flags.updateRefreshBlocked = inspectUpdateRefreshSafety().reason === 'generating';
  installDeferredTabSpinner('${version}');
  const first = window.__cqDeferredTabSpinner;
  installDeferredTabSpinner('${version}');
  flags.idempotent = first === window.__cqDeferredTabSpinner;
  flags.startsWhileBusy = spinning();
  const frame = document.title[0];
  await wait(470);
  flags.animates = spinning() && frame !== document.title[0];
  document.title = '改名后的会话';
  await wait(450);
  flags.survivesRename = spinning() && document.title.endsWith('改名后的会话');
  document.title = '◴ ◷ 🔴 ✅ ◵ 改名后的会话';
  await wait(450);
  flags.stackedUpdatePrefixesPruned = /^[◴◷◶◵] 改名后的会话$/.test(document.title);
  document.getElementById('primary').remove();
  await wait(50);
  flags.stopsOnCompletion = document.title === '改名后的会话';

  // When the refreshed content script eventually takes over, the temporary
  // observer and timer must retire without leaving stale title prefixes.
  const root = document.createElement('div');
  root.id = 'cq-extension-root';
  root.dataset.cqVersion = '${version}';
  document.body.append(root);
  await wait(60);
  flags.handsOffToNewVersion = !window.__cqDeferredTabSpinner;
  root.remove();

  // Older installed content scripts also display their own running state.
  // The update helper must never start a competing spinner for them.
  const oldPlugin = document.createElement('div');
  oldPlugin.id = 'cq-extension-root';
  oldPlugin.dataset.cqVersion = '0.49.0';
  document.body.append(oldPlugin);
  // Old versions of the updater left their timer reachable on window but
  // offered no stop callback. Retire it without disrupting the old queue UI.
  let staleTicks = 0;
  window.__cqDeferredTabSpinner = {
    version:'0.49.2',running:true,
    timer:setInterval(() => { staleTicks++; },20),
  };
  await wait(65);
  document.title = '◴ ◷ ◶ ◵ ◴ 旧版对话';
  installDeferredTabSpinner('${version}');
  const ticksAtStop = staleTicks;
  await wait(90);
  flags.oldPluginNotDoubleAnimated = staleTicks === ticksAtStop &&
    window.__cqDeferredTabSpinner?.timer == null &&
    document.title === '旧版对话';
  delete window.__cqDeferredTabSpinner;
  oldPlugin.remove();
  const success = Object.values(flags).every(Boolean);
  document.body.dataset.updateTest = JSON.stringify({success,...flags});
}, 100);
</script></body></html>`;
    fs.writeFileSync(path.join(temp, "test.html"), html);
    const args = ["--headless=new", "--disable-gpu", "--disable-extensions", "--no-first-run",
      `--user-data-dir=${path.join(temp, "chrome-profile")}`,
      "--virtual-time-budget=3500", "--dump-dom",
      `file:///${path.join(temp, "test.html").replace(/\\/g, "/")}`];
    const result = spawnSync(chromePath, args, {
      encoding: "utf8", timeout: 20000, maxBuffer: 6e6,
    });
    assert.equal(result.status, 0, result.stderr || "Chromium failed");
    const match = result.stdout.match(/data-update-test="([^"]+)"/);
    assert.ok(match, "update recovery DOM test did not run");
    const flags = JSON.parse(match[1].replace(/&quot;/g, '"'));
    assert.equal(flags.success, true, JSON.stringify(flags));
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
