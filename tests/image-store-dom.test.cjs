"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawn } = require("node:child_process");

const browser = process.env.CQ_BROWSER_BIN || (process.platform === "win32"
  ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
  : "/usr/bin/google-chrome");

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("真实浏览器 IndexedDB 保存、读取与清理队列原图", {
  skip: !fs.existsSync(browser) && "Chrome is not installed",
  timeout: 30000,
}, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cq-image-store-"));
  try {
    fs.copyFileSync(path.join(__dirname, "..", "image-store.js"), path.join(dir, "image-store.js"));
    fs.writeFileSync(path.join(dir, "index.html"), `<!doctype html>
<html><meta charset="utf-8"><body><script src="./image-store.js"></script>
<script>
document.body.dataset.step = "script-start";
setTimeout(() => {
  if (!document.body.dataset.check) {
    document.body.dataset.check = JSON.stringify({ok:false,error:"IndexedDB operation timed out",step:document.body.dataset.step,supported:!!window.indexedDB});
  }
}, 12000);
(async () => {
  const flags = {};
  try {
    const original = "data:image/png;base64,iVBORw0KGgo=";
    document.body.dataset.step = "before-save";
    await cqImageStore.save([
      {id:"keep",dataUrl:original,name:"图片1.png"},
      {id:"delete",dataUrl:"data:image/png;base64,YWJj",name:"图片2.png"},
    ]);
    document.body.dataset.step = "after-save";
    let pictures = await cqImageStore.load(["keep","delete"]);
    document.body.dataset.step = "after-load";
    flags.saved = pictures.length === 2 && pictures[0].dataUrl === original;
    flags.allExist = (await cqImageStore.missing(["keep","delete","keep"])).length === 0;
    await cqImageStore.prune(new Set(["keep"]));
    document.body.dataset.step = "after-prune";
    pictures = await cqImageStore.load(["keep"]);
    flags.kept = pictures.length === 1 && pictures[0].name === "图片1.png";
    let missing = false;
    try { await cqImageStore.load(["delete"]); }
    catch { missing = true; }
    flags.deleted = missing;
    const missingReferences = await cqImageStore.missing(["keep","delete","delete"]);
    flags.existenceCheck = missingReferences.length === 1 &&
      missingReferences[0] === "delete";
    await cqImageStore.save([
      {id:"staged-1",dataUrl:original,name:"暂存1.png"},
      {id:"staged-2",dataUrl:original,name:"暂存2.png"},
    ]);
    await cqImageStore.remove(["staged-1","staged-2"]);
    flags.stagedOnlyCleanup = (await cqImageStore.missing(["staged-1","staged-2"])).length === 2 &&
      (await cqImageStore.missing(["keep"])).length === 0;
    await cqImageStore.prune(new Set());
    let allRemoved = false;
    try { await cqImageStore.load(["keep"]); }
    catch { allRemoved = true; }
    flags.allRemoved = allRemoved;
    flags.allMissing = (await cqImageStore.missing(["keep","delete"])).length === 2;
  } catch (error) { flags.error = error.message; }
  flags.ok = ["saved","kept","deleted","allRemoved","allExist",
    "existenceCheck","stagedOnlyCleanup","allMissing"].every((key) => flags[key] === true);
  document.body.dataset.check = JSON.stringify(flags);
})();
</script></body></html>`);
    const profile = path.join(dir, "profile");
    const chrome = spawn(browser, [
      "--headless=new", "--disable-gpu", "--disable-extensions", "--no-first-run",
      "--remote-allow-origins=*", "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      `file:///${path.join(dir, "index.html").replace(/\\/g, "/")}`,
    ], { stdio: "ignore" });
    let socket;
    try {
      const portFile = path.join(profile, "DevToolsActivePort");
      for (let retry = 0; !fs.existsSync(portFile) && retry < 100; retry++) await delay(100);
      assert.ok(fs.existsSync(portFile), "Chrome debugging endpoint did not start");
      const port = Number(fs.readFileSync(portFile, "utf8").split("\n")[0]);
      let page;
      for (let retry = 0; retry < 60; retry++) {
        const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
        page = targets.find((target) => target.type === "page");
        if (page) break;
        await delay(100);
      }
      assert.ok(page?.webSocketDebuggerUrl, "Chrome page did not start");
      socket = new WebSocket(page.webSocketDebuggerUrl);
      await new Promise((resolve, reject) => {
        socket.addEventListener("open", resolve, { once: true });
        socket.addEventListener("error", reject, { once: true });
      });
      let serial = 0;
      const waiting = new Map();
      socket.addEventListener("message", (event) => {
        const data = JSON.parse(event.data);
        const done = waiting.get(data.id);
        if (done) { waiting.delete(data.id); done(data); }
      });
      const evaluate = (expression) => new Promise((resolve) => {
        const id = ++serial;
        waiting.set(id, resolve);
        socket.send(JSON.stringify({ id, method: "Runtime.evaluate", params: {
          expression, returnByValue: true,
        } }));
      });
      let flags;
      for (let retry = 0; retry < 100; retry++) {
        const reply = await evaluate("document.body?.dataset.check || ''");
        if (reply.result?.result?.value) {
          flags = JSON.parse(reply.result.result.value);
          break;
        }
        await delay(100);
      }
      assert.ok(flags, "Chrome did not complete IndexedDB image tests");
      assert.equal(flags.ok, true, JSON.stringify(flags));
    } finally {
      socket?.close();
      chrome.kill();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
  }
});
