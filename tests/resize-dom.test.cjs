"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawnSync } = require("node:child_process");

const browser = process.env.CQ_BROWSER_BIN || (process.platform === "win32"
  ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
  : "/usr/bin/google-chrome");

test("真实 Chrome DOM：队列高度可拖动、键盘微调、双击还原，且不影响队列排序", {
  skip: !fs.existsSync(browser) && "Chrome is not installed",
}, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cq-resize-dom-"));
  try {
    let source = fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8");
    source = source.replace("  function boundHere() {",
      "  function boundHere() { return true; }\n  function originalBoundHereForTest() {");
    fs.writeFileSync(path.join(dir, "content.js"), source);
    fs.copyFileSync(path.join(__dirname, "..", "panel.css"), path.join(dir, "panel.css"));
    fs.writeFileSync(path.join(dir, "index.html"), `<!doctype html>
<html lang="zh"><head><meta charset="utf-8">
<link rel="stylesheet" href="./panel.css">
<style>main {max-width:700px;margin:40px auto;} textarea{width:100%;height:45px}</style>
</head><body><main><form>
<textarea id="prompt-textarea"></textarea>
<button type="button" aria-label="Send" data-testid="send-button">发送</button>
</form></main>
<script>
const calls = [];
const settings = {
  maxPending:100,protectBackground:true,
  defaultIntervalMinutes:30,defaultRepeatCount:-1,queueListHeight:null,
};
const state = {
  key:"draft:1",tasks:Array.from({length:18},(_,i) => ({
    id:"task-"+i,text:"队列项目 "+i+"：这是一个需要保留顺序的长队列任务",
    status:"pending",
  })),
  activeTaskId:null,steeringTaskId:null,
  halted:false,haltReason:null,schedules:[],autoOpenTab:false,
};
window.chrome = {
  runtime: {
    onMessage:{addListener(){}},
    async sendMessage(message) {
      calls.push(message);
      if (message.type === "SAVE_QUEUE_HEIGHT") settings.queueListHeight = message.height;
      return {ok:true,state,settings,sessionKey:"draft:1"};
    },
  },
  storage:{onChanged:{addListener(){}}},
};
</script>
<script src="./content.js"></script>
<script>
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const list = () => document.querySelector("#cq-extension-root .cq-list");
const handle = () => document.querySelector("#cq-extension-root .cq-resize-handle");
const height = () => Math.round(list().getBoundingClientRect().height);
const mouse = (kind, clientY, pointerId = 15) => new PointerEvent(kind,{
  bubbles:true,cancelable:true,pointerId,clientY,button:0,
});
const resize = async (delta, cancel = false) => {
  const start = height();
  const before = calls.filter((call) => call.type === "SAVE_QUEUE_HEIGHT").length;
  handle().dispatchEvent(mouse("pointerdown", 150));
  window.dispatchEvent(mouse("pointermove", 150+delta));
  const preview = height();
  const savedOnlyOnRelease = calls.filter((call) =>
    call.type === "SAVE_QUEUE_HEIGHT").length === before;
  window.dispatchEvent(mouse(cancel ? "pointercancel" : "pointerup",150+delta));
  await wait(80);
  return {start,preview,savedOnlyOnRelease};
};
setTimeout(async () => {
  const flags = {};
  try {
    flags.exists = !!handle() && !!list() && !!document.querySelector(".cq-bottom-actions");
    flags.defaultHeight = settings.queueListHeight === null && height() <= 260 &&
      !list().classList.contains("cq-list-custom");
    const initialIds = [...list().querySelectorAll("[data-task-id]")]
      .map((row) => row.dataset.taskId).join(",");
    flags.isScrollable = list().scrollHeight > list().clientHeight;

    const up = await resize(105);
    flags.livePreview = up.preview > up.start && up.savedOnlyOnRelease;
    flags.persistedDrag = settings.queueListHeight === up.preview &&
      list().classList.contains("cq-list-custom") &&
      height() === up.preview;
    flags.accessible = handle().getAttribute("role") === "separator" &&
      handle().getAttribute("aria-orientation") === "horizontal" &&
      handle().getAttribute("aria-valuenow") === String(height());

    list().scrollTop = 110;
    document.querySelector('.cq-bottom-actions [data-action="toggle-queue"]').click();
    flags.collapsed = !list() && !!document.querySelector(".cq-bottom-actions");
    document.querySelector('.cq-bottom-actions [data-action="toggle-queue"]').click();
    flags.restoredOnExpand = height() === up.preview &&
      list().classList.contains("cq-list-custom");
    list().scrollTop = 110;
    document.querySelector('.cq-bottom-actions [data-action="toggle-settings"]').click();
    flags.restoredOnRerender = height() === up.preview && list().scrollTop === 110;
    document.querySelector('.cq-bottom-actions [data-action="toggle-settings"]').click();

    const down = await resize(-85);
    flags.shrinks = down.preview < down.start &&
      settings.queueListHeight === down.preview;
    const countBeforeCancel = calls.filter((call) => call.type === "SAVE_QUEUE_HEIGHT").length;
    const original = height();
    await resize(60, true);
    flags.cancelReverts = height() === original &&
      settings.queueListHeight === original &&
      calls.filter((call) => call.type === "SAVE_QUEUE_HEIGHT").length === countBeforeCancel;
    flags.cursorRestored = !document.querySelector("#cq-extension-root")
      .classList.contains("cq-resizing") &&
      document.documentElement.style.cursor === "";

    const old = settings.queueListHeight;
    handle().dispatchEvent(new KeyboardEvent("keydown", {
      key:"ArrowDown",bubbles:true,cancelable:true,
    }));
    await wait(75);
    flags.keyboardWorks = settings.queueListHeight === old+24 &&
      height() === old+24;

    handle().dispatchEvent(new MouseEvent("dblclick",{bubbles:true,cancelable:true}));
    await wait(75);
    flags.doubleClickResets = settings.queueListHeight === null &&
      !list().classList.contains("cq-list-custom") && height() <= 260;
    flags.homeResets = true;
    handle().dispatchEvent(new KeyboardEvent("keydown", {
      key:"ArrowDown",bubbles:true,cancelable:true,
    }));
    await wait(75);
    handle().dispatchEvent(new KeyboardEvent("keydown", {
      key:"Home",bubbles:true,cancelable:true,
    }));
    await wait(75);
    flags.homeResets = settings.queueListHeight === null &&
      !list().classList.contains("cq-list-custom");

    flags.taskOrderUntouched = [...list().querySelectorAll("[data-task-id]")]
      .map((row) => row.dataset.taskId).join(",") === initialIds;
    flags.noTaskDrag = !calls.some((call) =>
      call.type === "REORDER_TASK" || call.type === "PIN_TASK");

    // The grip is also available for an empty queue, but not when collapsed.
    state.tasks = [];
    document.querySelector('.cq-bottom-actions [data-action="toggle-queue"]').click();
    flags.emptyCollapsed = !list() && !handle();
    document.querySelector('.cq-bottom-actions [data-action="toggle-queue"]').click();
    flags.emptyGripAvailable = !!list() && !!handle() &&
      list().textContent.includes("队列为空");
  } catch (error) {
    flags.error = error.stack || error.message;
  }
  flags.ok = ["exists","defaultHeight","isScrollable","livePreview",
    "persistedDrag","accessible","collapsed","restoredOnExpand",
    "restoredOnRerender","shrinks","cancelReverts","cursorRestored",
    "keyboardWorks","doubleClickResets","homeResets",
    "taskOrderUntouched","noTaskDrag","emptyCollapsed","emptyGripAvailable"]
      .every((key) => flags[key] === true);
  document.body.dataset.resize = JSON.stringify(flags);
}, 350);
</script>
</body></html>`);
    const run = spawnSync(browser, [
      "--headless=new", "--disable-gpu", "--disable-extensions", "--no-first-run",
      `--user-data-dir=${path.join(dir, "profile")}`,
      "--virtual-time-budget=6000", "--dump-dom",
      `file:///${path.join(dir, "index.html").replace(/\\/g, "/")}`,
    ], {encoding:"utf8",timeout:25000,maxBuffer:7e6});
    assert.equal(run.status, 0, run.stderr || "Chrome failed");
    const match = run.stdout.match(/data-resize="([^"]+)"/);
    assert.ok(match, "Chrome did not complete the queue resize test");
    const flags = JSON.parse(match[1].replace(/&quot;/g, '"'));
    assert.equal(flags.ok, true, JSON.stringify(flags));
  } finally {
    fs.rmSync(dir, {recursive:true,force:true});
  }
});
