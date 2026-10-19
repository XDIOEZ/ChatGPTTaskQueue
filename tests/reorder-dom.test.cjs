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

test("真实 Chrome DOM：点击置顶、整条拖拽排序、锁定任务不可移动且无上下按钮", {
  skip: !fs.existsSync(browser) && "Chrome is not installed",
}, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cq-reorder-"));
  try {
    let content = fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8");
    // A local file:// smoke page cannot match a genuine ChatGPT conversation.
    content = content.replace("  function boundHere() {",
      "  function boundHere() { return true; }\n  function unusedOriginalBoundHere() {");
    fs.writeFileSync(path.join(dir, "content.js"), content);
    fs.copyFileSync(path.join(__dirname, "..", "panel.css"), path.join(dir, "panel.css"));
    fs.writeFileSync(path.join(dir, "index.html"), `<!doctype html>
<html><head><meta charset="utf-8"><link rel="stylesheet" href="./panel.css"></head><body>
<main><form><textarea id="prompt-textarea"></textarea></form></main>
<script>
const requests = [];
const state = {
  key:"draft:1",activeTaskId:"w",steeringTaskId:null,halted:false,haltReason:null,
  tasks:[
    {id:"w",text:"正在回答",status:"waiting"},
    {id:"a",text:"任务甲",status:"pending"},
    {id:"b",text:"任务乙",status:"pending"},
    {id:"c",text:"任务丙",status:"pending"},
  ],
  schedules:[],autoOpenTab:false,
};
function sortedPending(sourceId, targetId, position) {
  const slots = state.tasks.map((task, index) => task.status === "pending" ? index : -1)
    .filter((index) => index >= 0);
  const tasks = slots.map((index) => state.tasks[index]);
  const original = tasks.findIndex((task) => task.id === sourceId);
  const item = tasks.splice(original, 1)[0];
  const index = targetId === null ? 0 :
    tasks.findIndex((task) => task.id === targetId) + (position === "after" ? 1 : 0);
  tasks.splice(index, 0, item);
  slots.forEach((slot, offset) => { state.tasks[slot] = tasks[offset]; });
}
window.chrome = {
  runtime: {
    onMessage:{addListener(){}},
    async sendMessage(message) {
      requests.push(message);
      if (message.type === "PIN_TASK") sortedPending(message.id, null, "before");
      if (message.type === "REORDER_TASK") {
        sortedPending(message.id, message.targetId, message.position);
      }
      return {ok:true,state,sessionKey:"draft:1",settings:{maxPending:100}};
    },
  },
  storage:{onChanged:{addListener(){}}},
};
</script>
<script src="./content.js"></script>
<script>
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const currentOrder = () => [...document.querySelectorAll(".cq-list .cq-task[data-task-id]")]
  .map((row) => row.dataset.taskId);
const row = (id) => document.querySelector('.cq-list .cq-task[data-task-id="' + id + '"]');
const simulateDrag = (source, target, position) => {
  const transfer = new DataTransfer();
  const from = row(source);
  const to = row(target);
  from.dispatchEvent(new DragEvent("dragstart", {bubbles:true,cancelable:true,dataTransfer:transfer}));
  const rect = to.getBoundingClientRect();
  const y = position === "before" ? rect.top + 2 : rect.bottom - 2;
  const over = new DragEvent("dragover", {
    bubbles:true,cancelable:true,dataTransfer:transfer,clientY:y,
  });
  to.dispatchEvent(over);
  const highlighted = to.classList.contains(
    position === "before" ? "cq-drop-before" : "cq-drop-after");
  to.dispatchEvent(new DragEvent("drop", {
    bubbles:true,cancelable:true,dataTransfer:transfer,clientY:y,
  }));
  return highlighted && over.defaultPrevented;
};
const pressRow = (id, key, extra = {}) => {
  const element = row(id);
  element.focus();
  const event = new KeyboardEvent("keydown", {
    key, bubbles:true, cancelable:true, ...extra,
  });
  element.dispatchEvent(event);
  return event.defaultPrevented;
};
setTimeout(async () => {
  const flags = {};
  try {
    flags.noArrows = !document.querySelector('[data-action="move-task"]') &&
      !document.querySelector('[data-direction="up"]') &&
      !document.querySelector('[data-direction="down"]');
    flags.pendingDraggable = ["a","b","c"].every((id) => row(id).draggable);
    flags.activeLocked = !row("w").draggable &&
      !row("w").querySelector('[data-action="pin-task"]');
    flags.firstPinDisabled = row("a").querySelector('[data-action="pin-task"]').disabled;
    row("c").querySelector('[data-action="pin-task"]').click();
    await wait(80);
    flags.pinned = currentOrder().join(",") === "w,c,a,b" &&
      requests.some((request) => request.type === "PIN_TASK" && request.id === "c");
    flags.dragFeedback = simulateDrag("b","c","before");
    await wait(80);
    flags.dragReordered = currentOrder().join(",") === "w,b,c,a" &&
      requests.some((request) => request.type === "REORDER_TASK" &&
        request.id === "b" && request.targetId === "c" &&
        request.position === "before");
    flags.afterFeedback = simulateDrag("b","a","after");
    await wait(80);
    flags.dragAfter = currentOrder().join(",") === "w,c,a,b" &&
      requests.some((request) => request.type === "REORDER_TASK" &&
        request.id === "b" && request.targetId === "a" &&
        request.position === "after");

    const moves = requests.filter((request) => request.type === "REORDER_TASK").length;
    simulateDrag("a","w","before");
    await wait(50);
    flags.activeNotTarget = requests.filter((request) =>
      request.type === "REORDER_TASK").length === moves &&
      currentOrder().join(",") === "w,c,a,b";
    flags.noDragResidue = !document.querySelector(".cq-drop-before, .cq-drop-after, .cq-dragging");

    flags.focusableList = document.querySelector(".cq-list")?.getAttribute("role") === "list" &&
      ["w","c","a","b"].every((id) => row(id)?.getAttribute("role") === "listitem") &&
      [...document.querySelectorAll(".cq-list .cq-task")].filter((item) =>
        item.tabIndex === 0).length === 1 &&
      row("a").getAttribute("aria-label")?.includes("任务甲");
    flags.keyboardDownBlocked = pressRow("c","ArrowDown");
    flags.keyboardDown = document.activeElement?.dataset.taskId === "a";
    flags.singleTabStop = [...document.querySelectorAll(".cq-list .cq-task")]
      .filter((item) => item.tabIndex === 0).map((item) => item.dataset.taskId)
      .join(",") === "a";
    flags.keyboardHomeBlocked = pressRow("a","Home");
    flags.keyboardHome = document.activeElement?.dataset.taskId === "w";
    flags.keyboardEndBlocked = pressRow("w","End");
    flags.keyboardEnd = document.activeElement?.dataset.taskId === "b";
    flags.keyboardUpBlocked = pressRow("b","ArrowUp");
    flags.keyboardUp = document.activeElement?.dataset.taskId === "a";

    flags.keyboardReorderUpPrevented = pressRow("a","ArrowUp",{altKey:true});
    await wait(80);
    flags.keyboardMovedUp = currentOrder().join(",") === "w,a,c,b" &&
      requests.some((request) => request.type === "REORDER_TASK" &&
        request.id === "a" && request.targetId === "c" &&
        request.position === "before") &&
      document.activeElement?.dataset.taskId === "a" &&
      row("a").querySelector(".cq-task-meta")?.textContent.includes("待发送 1/3") &&
      row("c").querySelector(".cq-task-meta")?.textContent.includes("待发送 2/3");
    flags.keyboardReorderDownPrevented = pressRow("a","ArrowDown",{altKey:true});
    await wait(80);
    flags.keyboardMovedDown = currentOrder().join(",") === "w,c,a,b" &&
      requests.some((request) => request.type === "REORDER_TASK" &&
        request.id === "a" && request.targetId === "c" &&
        request.position === "after");

    const numberBeforeLocked = requests.filter((request) =>
      request.type === "REORDER_TASK").length;
    pressRow("w","ArrowDown",{altKey:true});
    await wait(50);
    flags.activeNeverMoved = currentOrder().join(",") === "w,c,a,b" &&
      requests.filter((request) => request.type === "REORDER_TASK").length === numberBeforeLocked;

    document.querySelector('[data-action="filter-tasks"][data-filter="pending"]').click();
    flags.filteredBrowse = pressRow("c","ArrowDown") &&
      document.activeElement?.dataset.taskId === "a";
    pressRow("a","ArrowDown",{altKey:true});
    await wait(50);
    flags.filteredReorderProtected =
      requests.filter((request) => request.type === "REORDER_TASK").length === numberBeforeLocked &&
      currentOrder().join(",") === "c,a,b";
    document.querySelector('[data-action="filter-tasks"][data-filter="all"]').click();

    document.querySelector('[data-action="toggle-settings"]').click();
    document.querySelector('[data-action="show-settings-page"][data-page="general"]').click();
    document.querySelector('[data-action="toggle-queue-composer"]').click();
    const imageLabel = document.querySelector('.cq-image-add[role="button"]');
    const picker = document.querySelector("#cq-queue-images");
    let pickerClicks = 0;
    picker.click = () => { pickerClicks++; };
    imageLabel.focus();
    const enter = new KeyboardEvent("keydown", {
      key:"Enter",bubbles:true,cancelable:true,
    });
    imageLabel.dispatchEvent(enter);
    const space = new KeyboardEvent("keydown", {
      key:" ",bubbles:true,cancelable:true,
    });
    imageLabel.dispatchEvent(space);
    flags.imagePickerAccessible = imageLabel.tabIndex === 0 &&
      imageLabel.getAttribute("role") === "button" &&
      imageLabel.getAttribute("aria-label")?.includes("最多 4 张") &&
      document.activeElement === imageLabel &&
      pickerClicks === 2 && enter.defaultPrevented && space.defaultPrevented;
  } catch (error) {
    flags.error = error.stack || error.message;
  }
  flags.ok = ["noArrows","pendingDraggable","activeLocked","firstPinDisabled",
    "pinned","dragFeedback","dragReordered","afterFeedback","dragAfter",
    "activeNotTarget","noDragResidue","focusableList",
    "keyboardDownBlocked","keyboardDown","singleTabStop",
    "keyboardHomeBlocked","keyboardHome",
    "keyboardEndBlocked","keyboardEnd","keyboardUpBlocked","keyboardUp",
    "keyboardReorderUpPrevented","keyboardMovedUp",
    "keyboardReorderDownPrevented","keyboardMovedDown",
    "activeNeverMoved","filteredBrowse","filteredReorderProtected",
    "imagePickerAccessible"].every((key) => flags[key] === true);
  document.body.dataset.check = JSON.stringify(flags);
}, 400);
</script>
</body></html>`);

    const result = spawnSync(browser, [
      "--headless=new", "--disable-gpu", "--disable-extensions", "--no-first-run",
      `--user-data-dir=${path.join(dir, "profile")}`,
      "--virtual-time-budget=4000", "--dump-dom",
      `file:///${path.join(dir, "index.html").replace(/\\/g, "/")}`,
    ], { encoding: "utf8", timeout: 20000, maxBuffer: 6e6 });
    assert.equal(result.status, 0, result.stderr || "Chrome failed");
    const match = result.stdout.match(/data-check="([^"]+)"/);
    assert.ok(match, "Chrome did not execute reorder DOM test");
    const flags = JSON.parse(match[1].replace(/&quot;/g, '"'));
    assert.equal(flags.ok, true, JSON.stringify(flags));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
