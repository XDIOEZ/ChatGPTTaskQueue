"use strict";

// Run the actual content script against a synthetic ChatGPT-like composer in
// Chrome. Only the temporary test copy accepts file://: the shipped extension
// remains restricted to real ChatGPT HTTPS origins.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawnSync } = require("node:child_process");

const chromePath = process.env.CQ_BROWSER_BIN || (process.platform === "win32"
  ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
  : "/usr/bin/google-chrome");

test("队列引导按钮真实 Chrome DOM：提前发送、不重复、不可用时回队列、保留草稿", {
  skip: !fs.existsSync(chromePath) && "Chrome is not installed",
}, () => {
  const project = path.join(__dirname, "..");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cq-steer-dom-"));
  const pageFolder = path.join(tmp, "page");
  try {
    fs.mkdirSync(pageFolder);
    const original = fs.readFileSync(path.join(project, "content.js"), "utf8");
    const guard = "if (!state || !sessionKey || !validUrl(location.href)) return false;";
    assert.ok(original.includes(guard), "Expected ChatGPT-only binding safety guard");
    const testOnly = original.replace(guard,
      "if (!state || !sessionKey || (!validUrl(location.href) && !location.href.startsWith('file:'))) return false;");
    fs.writeFileSync(path.join(pageFolder, "content-under-test.js"), testOnly);
    fs.copyFileSync(path.join(project, "panel.css"), path.join(tmp, "panel.css"));

    const smoke = fs.readFileSync(path.join(__dirname, "composer-smoke.html"), "utf8");
    assert.ok(smoke.includes("window.__cqSteerTestMode = false;"));
    assert.ok(smoke.includes('<script src="../content.js"></script>'));
    const html = smoke.replace("window.__cqSteerTestMode = false;", "window.__cqSteerTestMode = true;")
      .replace('<script src="../content.js"></script>', '<script src="./content-under-test.js"></script>');
    fs.writeFileSync(path.join(pageFolder, "composer-smoke.html"), html);

    const chromeArgs = [
      "--headless=new", "--disable-gpu", "--disable-extensions", "--no-first-run",
      `--user-data-dir=${path.join(tmp, "profile")}`,
      "--virtual-time-budget=18000", "--dump-dom",
      `file:///${path.join(pageFolder, "composer-smoke.html").replace(/\\/g, "/")}`,
    ];
    const run = spawnSync(chromePath, chromeArgs, { encoding: "utf8", timeout: 30000, maxBuffer: 8e6 });
    assert.equal(run.status, 0, run.stderr || "Chrome process failed");
    const match = run.stdout.match(/data-smoke="([^"]+)"/);
    assert.ok(match, "Chrome did not finish the composer smoke test");
    const flags = JSON.parse(match[1].replace(/&quot;/g, '"').replace(/&amp;/g, "&"));
    assert.equal(flags.ok, true, JSON.stringify(flags));
    assert.equal(flags.steerSentOnce, true);
    assert.equal(flags.steerRemovedFromQueue, true);
    assert.equal(flags.steerNoDuplicate, true);
    assert.equal(flags.unsupportedSteerRestored, true);
    assert.equal(flags.unsupportedSteerClean, true);
    assert.equal(flags.steerPreservesDraft, true);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 });
  }
});
