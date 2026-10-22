"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const browser = process.env.CQ_BROWSER_BIN || (process.platform === "win32"
  ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
  : "/usr/bin/google-chrome");

test("真实 Chrome 输入框：有发送箭头、空队列也只允许 Enter 入队，Ctrl/Cmd+Enter 才直接发送", {
  skip: !fs.existsSync(browser) && "Chrome is not installed",
}, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cq-keyboard-"));
  try {
    let script = fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8");
    script = script.replace("  function boundHere() {",
      "  function boundHere() { return true; }\n  function originalBoundHereForTestOnly() {");
    fs.writeFileSync(path.join(dir, "content.js"), script);
    fs.copyFileSync(path.join(__dirname, "..", "panel.css"), path.join(dir, "panel.css"));
    fs.writeFileSync(path.join(dir, "index.html"), `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"></head><body>
<main>
  <section id="conversation">
    <div data-message-author-role="assistant" data-message-id="previous-answer">
      <div data-message-content>上一条回答已经完成</div>
    </div>
  </section>
  <form id="composer">
    <textarea id="prompt-textarea"></textarea>
    <button id="send-button" type="button" data-testid="send-button" aria-label="Send">↑</button>
  </form>
</main>
<script>
const editor = document.querySelector("#prompt-textarea");
const sendButton = document.querySelector("#send-button");
const conversation = document.querySelector("#conversation");
const sent = [];
const requests = [];
let nativeKeyCount = 0;
let pickerSelections = 0;
const state = {
  key:"draft:1",url:"https://chatgpt.com/",tabId:1,
  activeTaskId:null,steeringTaskId:null,halted:false,
  tasks:[],schedules:[],autoOpenTab:false,
};
sendButton.addEventListener("click", () => {
  const message = editor.value;
  sent.push(message);
  const bubble = document.createElement("div");
  bubble.setAttribute("data-message-author-role", "user");
  bubble.setAttribute("data-message-id", "user-" + sent.length);
  bubble.innerHTML = '<div data-message-content></div>';
  bubble.firstElementChild.textContent = message;
  conversation.appendChild(bubble);
  editor.value = "";
});
editor.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || event.shiftKey || event.altKey ||
      event.isComposing || event.keyCode === 229 || event.defaultPrevented) return;
  const picker = document.querySelector("#picker");
  if (picker && picker.getClientRects().length &&
      !picker.closest('[hidden], [inert], [aria-hidden="true"]') &&
      getComputedStyle(picker).visibility === "visible" &&
      Number(getComputedStyle(picker).opacity) > 0) {
    pickerSelections++;
    return;
  }
  nativeKeyCount++;
  sendButton.click(); // Simulate ChatGPT's own native keyboard send.
});
window.chrome = {
  runtime: {
    onMessage: { addListener() {} },
    async sendMessage(message) {
      requests.push(message);
      if (message.type === "ENQUEUE") {
        state.tasks.push({id:"queued-" + (state.tasks.length + 1),
          text:message.text,status:"pending"});
      }
      let dispatch;
      if (message.type === "STEER_PROMPT_CLAIM") {
        const task = {id:"shortcut-guide",text:message.text,status:"steering",
          steerFromComposer:true,steerBaselineUserCount:message.userCount,
          steerBaselineUserId:message.lastUserId};
        state.tasks.push(task);
        state.steeringTaskId = task.id;
        dispatch = {id:task.id,text:task.text,needsPause:true};
      }
      if (message.type === "STEER_CLICKED") {
        state.tasks.find(task => task.id === message.id).status = "steering_wait";
      }
      if (message.type === "STEER_CONFIRM") {
        state.tasks = state.tasks.filter(task => task.id !== message.id);
        state.steeringTaskId = null;
      }
      return {ok:true,sessionKey:"draft:1",state,dispatch,settings:{
        maxPending:100,protectBackground:true,
        defaultIntervalMinutes:30,defaultRepeatCount:-1,
      }};
    },
  },
  storage: {onChanged:{addListener(){}}},
};
</script>
<script src="./content.js"></script>
<script>
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const press = (opts = {}) => {
  const event = new KeyboardEvent("keydown", {key:"Enter",bubbles:true,
    cancelable:true,...opts});
  return !editor.dispatchEvent(event);
};
setTimeout(async () => {
  const flags = {};
  try {
    flags.nativeArrow = sendButton.getClientRects().length > 0 &&
      sendButton.getAttribute("data-testid") === "send-button";
    flags.noShortcutHints = !document.querySelector(".cq-shortcuts");
    editor.value = "空队列先入队";
    flags.emptyEnterPrevented = press();
    await delay(120);
    flags.emptyEnteredQueue = state.tasks.length === 1 &&
      state.tasks[0].text === "空队列先入队" && editor.value === "";
    flags.emptyNeverSent = sent.length === 0 && nativeKeyCount === 0;

    editor.value = "第二条也入队";
    flags.queuedEnterPrevented = press();
    await delay(120);
    flags.secondEnteredQueue = state.tasks.length === 2 &&
      state.tasks[1].text === "第二条也入队" && sent.length === 0;
    const queuedSteer = document.querySelector('[data-action="steer-task"][data-id="queued-2"]');
    flags.steerUnlockedAfterQueue = !!queuedSteer && !queuedSteer.disabled;

    editor.value = "Ctrl 即时发送";
    flags.ctrlPrevented = press({ctrlKey:true});
    await delay(550);
    flags.ctrlSent = sent.length === 1 && sent[0] === "Ctrl 即时发送" &&
      editor.value === "" && state.tasks.length === 2;

    editor.value = "Cmd 即时发送";
    flags.metaPrevented = press({metaKey:true});
    await delay(550);
    flags.metaSent = sent.length === 2 && sent[1] === "Cmd 即时发送" &&
      state.tasks.length === 2;
    flags.nativeStillBlocked = nativeKeyCount === 0;

    editor.value = "Shift 换行";
    flags.shiftLeftToEditor = !press({shiftKey:true}) &&
      editor.value === "Shift 换行";
    flags.imeLeftToEditor = !press({isComposing:true}) &&
      sent.length === 2 && state.tasks.length === 2;

    const picker = document.createElement("div");
    picker.id = "picker";
    picker.setAttribute("role", "listbox");
    picker.textContent = "候选命令";
    document.body.appendChild(picker);
    flags.popupNotBlocked = !press() && pickerSelections === 1 &&
      sent.length === 2;
    picker.setAttribute("aria-hidden", "true");
    editor.value = "隐藏候选框不能拦截队列回车";
    flags.hiddenPickerEnterPrevented = press();
    await delay(130);
    flags.hiddenPickerEnqueued = state.tasks.at(-1)?.text === "隐藏候选框不能拦截队列回车" &&
      editor.value === "" && sent.length === 2 && pickerSelections === 1;
    picker.removeAttribute("aria-hidden");
    picker.style.opacity = "0";
    editor.value = "透明候选框也不能拦截回车";
    flags.transparentPickerEnterPrevented = press();
    await delay(130);
    flags.transparentPickerEnqueued = state.tasks.at(-1)?.text === "透明候选框也不能拦截回车" &&
      editor.value === "" && sent.length === 2 && pickerSelections === 1;
    picker.style.opacity = "";
    const popupDialog = document.createElement("div");
    popupDialog.setAttribute("role", "dialog");
    popupDialog.append(picker);
    document.body.append(popupDialog);
    editor.value = "正在选择斜杠命令";
    flags.dialogPickerNotBlocked = !press() && pickerSelections === 2 &&
      sent.length === 2 && editor.value === "正在选择斜杠命令";
    popupDialog.remove();
    picker.remove();
    const unrelated = document.createElement("aside");
    unrelated.innerHTML = '<div role="listbox">侧栏候选菜单</div>';
    document.body.appendChild(unrelated);
    editor.value = "侧栏候选不应该抢走回车";
    flags.unrelatedPickerEnterPrevented = press();
    await delay(130);
    flags.unrelatedPickerEnqueued = state.tasks.at(-1)?.text === "侧栏候选不应该抢走回车" &&
      editor.value === "" && sent.length === 2;
    unrelated.remove();

    editor.value = "按住回车重复事件不应再入队";
    const beforeRepeat = state.tasks.length;
    flags.repeatPrevented = press({repeat:true});
    await delay(60);
    flags.repeatIgnored = state.tasks.length === beforeRepeat &&
      sent.length === 2 && editor.value === "按住回车重复事件不应再入队";

    editor.value = "";
    flags.emptyPrevented = press();
    await delay(60);
    flags.emptyNoSend = state.tasks.length === beforeRepeat && sent.length === 2;

    const attachment = document.createElement("span");
    attachment.setAttribute("data-testid", "file-chip");
    attachment.textContent = "截图.png";
    document.querySelector("#composer").appendChild(attachment);
    editor.value = "带原生附件";
    flags.attachmentPrevented = press();
    await delay(100);
    flags.attachmentPreserved = editor.value === "带原生附件" &&
      sent.length === 2 && state.tasks.length === beforeRepeat;
    attachment.remove();

    sendButton.style.display = "none";
    editor.value = "发送按钮不可用时 Ctrl 不应该偷偷入队";
    flags.unavailableCtrlPrevented = press({ctrlKey:true});
    await delay(110);
    flags.unavailableCtrlPreservesDraft = editor.value.includes("发送按钮不可用") &&
      sent.length === 2 && state.tasks.length === beforeRepeat;
    sendButton.style.display = "";

    editor.value = "手动点击箭头仍可发送";
    sendButton.click();
    flags.manualButtonWorks = sent.length === 3 &&
      sent[2] === "手动点击箭头仍可发送";

    // A running reply must take the durable immediate-steering path rather
    // than priority ENQUEUE, while retaining the existing queue order.
    state.activeTaskId = state.tasks[0].id;
    state.tasks[0].status = "waiting";
    const stop = document.createElement("button");
    stop.type = "button";
    stop.dataset.testid = "stop-button";
    stop.setAttribute("aria-label", "Stop generating");
    stop.textContent = "Stop";
    let stopCount = 0;
    stop.addEventListener("click", () => { stopCount++; });
    document.querySelector("#composer").appendChild(stop);
    const beforeBusyRequests = requests.length;
    const beforeBusyIds = state.tasks.map(task => task.id).join(",");
    editor.value = "生成中立即补充指令";
    flags.busyCtrlPrevented = press({ctrlKey:true});
    await delay(600);
    const busyRequests = requests.slice(beforeBusyRequests);
    flags.busyCtrlAtomicClaim = busyRequests.some(message => message.type === "STEER_PROMPT_CLAIM") &&
      !busyRequests.some(message => message.type === "ENQUEUE");
    flags.busyCtrlDirectSend = sent.length === 4 && sent[3] === "生成中立即补充指令" &&
      editor.value === "" && stopCount === 0;
    flags.busyCtrlQueuePreserved = state.tasks.map(task => task.id).join(",") === beforeBusyIds &&
      state.steeringTaskId === null && nativeKeyCount === 0;
    const restoredSteer = document.querySelector('[data-action="steer-task"][data-id="queued-2"]');
    flags.steerUnlockedAfterBusyCtrl = !!restoredSteer && !restoredSteer.disabled;
    stop.remove();
    state.tasks[0].status = "pending";
    state.activeTaskId = null;

    // The current ChatGPT composer can be ProseMirror/contenteditable instead
    // of a textarea. Keyboard capture must work on nested inline elements.
    const oldEditor = document.querySelector("#prompt-textarea");
    const richEditor = document.createElement("div");
    richEditor.id = "prompt-textarea";
    richEditor.contentEditable = "true";
    richEditor.innerHTML = "<p><span>富文本输入框也入队</span></p>";
    oldEditor.replaceWith(richEditor);
    const beforeRich = state.tasks.length;
    const beforeNative = nativeKeyCount;
    richEditor.addEventListener("keydown", () => { nativeKeyCount++; });
    const richEvent = new KeyboardEvent("keydown", {
      key:"Enter",bubbles:true,cancelable:true,
    });
    flags.richPrevented = !richEditor.querySelector("span").dispatchEvent(richEvent);
    await delay(140);
    flags.richQueued = state.tasks.length === beforeRich + 1 &&
      state.tasks.at(-1).text === "富文本输入框也入队" &&
      sent.length === 4 && nativeKeyCount === beforeNative;
    flags.noShortcutHintsAfterEdit = !document.querySelector(".cq-shortcuts");
  } catch (error) {
    flags.error = error.stack || error.message;
  }
  flags.ok = ["nativeArrow","noShortcutHints","emptyEnterPrevented","emptyEnteredQueue",
    "emptyNeverSent","queuedEnterPrevented","secondEnteredQueue","steerUnlockedAfterQueue",
    "ctrlPrevented","ctrlSent","metaPrevented","metaSent",
    "nativeStillBlocked","shiftLeftToEditor","imeLeftToEditor",
    "popupNotBlocked","hiddenPickerEnterPrevented","hiddenPickerEnqueued",
    "transparentPickerEnterPrevented","transparentPickerEnqueued",
    "dialogPickerNotBlocked",
    "unrelatedPickerEnterPrevented","unrelatedPickerEnqueued",
    "repeatPrevented","repeatIgnored","emptyPrevented",
    "emptyNoSend","attachmentPrevented","attachmentPreserved",
    "unavailableCtrlPrevented","unavailableCtrlPreservesDraft",
    "manualButtonWorks","busyCtrlPrevented","busyCtrlAtomicClaim","busyCtrlDirectSend",
    "busyCtrlQueuePreserved","steerUnlockedAfterBusyCtrl",
    "richPrevented","richQueued","noShortcutHintsAfterEdit"]
      .every((key) => flags[key] === true);
  document.body.dataset.keyboard = JSON.stringify(flags);
}, 280);
</script>
</body></html>`);

    const result = spawnSync(browser, [
      "--headless=new", "--disable-gpu", "--disable-extensions", "--no-first-run",
      `--user-data-dir=${path.join(dir, "profile")}`,
      "--virtual-time-budget=6000", "--dump-dom",
      `file:///${path.join(dir, "index.html").replace(/\\/g,"/")}`,
    ], {encoding:"utf8",timeout:20000,maxBuffer:6e6});
    assert.equal(result.status, 0, result.stderr || "Chrome failed");
    const match = result.stdout.match(/data-keyboard="([^"]+)"/);
    assert.ok(match, "Chrome did not complete the keyboard regression test");
    const flags = JSON.parse(match[1].replace(/&quot;/g, '"'));
    assert.equal(flags.ok, true, JSON.stringify(flags));
  } finally {
    fs.rmSync(dir, {recursive:true,force:true});
  }
});
