"use strict";

const {test} = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {spawnSync} = require("node:child_process");

const browser = process.env.CQ_BROWSER_BIN || (process.platform === "win32"
  ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
  : "/usr/bin/google-chrome");

test("真实 Chrome：普通/项目/旧聊天每次 Enter 都原生发送，无论队列是否存在", {
  skip: !fs.existsSync(browser) && "Chrome is not installed",
}, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cq-first-turn-enter-"));
  try {
    const original = fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8");
    const source = original
      .replace("  function validUrl(url) {", `  function validUrl(url) {
    if (String(url).startsWith("file:")) return window.__cqTestRoute;`)
      .replace("  function boundHere() {",
        "  function boundHere() { return true; }\n  function originalBoundHereForTest() {");
    assert.notEqual(source, original);
    fs.writeFileSync(path.join(dir, "content.js"), source);
    fs.copyFileSync(path.join(__dirname, "..", "panel.css"), path.join(dir, "panel.css"));
    fs.writeFileSync(path.join(dir, "index.html"), `<!doctype html><html lang="zh">
<head><meta charset="utf-8"><link rel="stylesheet" href="./panel.css"></head>
<body><main>
  <section id="conversation"></section>
  <form id="composer"><textarea id="prompt-textarea"></textarea>
    <button type="button" data-testid="send-button" aria-label="Send" id="send-button">↑</button>
  </form>
</main><script>
window.__cqTestRoute = "https://chatgpt.com/";
const editor = document.querySelector("#prompt-textarea");
const conversation = document.querySelector("#conversation");
const sent = [];
const calls = [];
const state = {
  key:"draft:1",url:"https://chatgpt.com/",tabId:1,tasks:[],schedules:[],
  halted:false,activeTaskId:null,steeringTaskId:null,autoOpenTab:false,
};
const send = document.querySelector("#send-button");
send.onclick = () => {
  sent.push(editor.value);
  const turn = document.createElement("div");
  turn.setAttribute("data-message-author-role","user");
  turn.setAttribute("data-message-id","user-"+sent.length);
  const body = document.createElement("div");
  body.setAttribute("data-message-content","");
  body.textContent = editor.value;
  turn.append(body);
  conversation.append(turn);
  editor.value = "";
};
editor.addEventListener("keydown", event => {
  if (event.key === "Enter" && !event.shiftKey && !event.defaultPrevented) send.click();
});
window.chrome = {
  runtime:{
    onMessage:{addListener(){}},
    async sendMessage(message) {
      calls.push(message);
      if (message.type === "ENQUEUE")
        state.tasks.push({id:"queued-"+state.tasks.length,text:message.text,status:"pending"});
      return {ok:true,state,sessionKey:"draft:1",settings:{maxPending:100}};
    },
  },
  storage:{onChanged:{addListener(){}}},
};
const press = text => {
  editor.value = text;
  const event = new KeyboardEvent("keydown",{key:"Enter",bubbles:true,cancelable:true});
  editor.dispatchEvent(event);
  return event.defaultPrevented;
};
const wait = ms => new Promise(resolve => setTimeout(resolve,ms));
</script><script src="./content.js"></script><script>
setTimeout(async () => {
  const result = {};
  try {
    result.personalFirstNative = !press("普通新对话开场") &&
      sent.length === 1 && sent[0] === "普通新对话开场" && state.tasks.length === 0;
    result.personalSecondNative = !press("普通对话第二条");
    await wait(160);
    result.personalQueueNotTouched = state.tasks.length === 0 &&
      sent.length === 2 && sent[1] === "普通对话第二条";

    window.__cqTestRoute = "https://chatgpt.com/g/g-p-abc/project";
    state.url = window.__cqTestRoute;
    state.tasks.length = 0;
    conversation.replaceChildren();
    result.projectFirstNative = !press("项目新对话开场") &&
      sent.length === 3 && sent[2] === "项目新对话开场" && state.tasks.length === 0;
    result.projectSecondNative = !press("项目对话第二条");
    await wait(160);
    result.projectQueueNotTouched = state.tasks.length === 0 &&
      sent.length === 4 && sent[3] === "项目对话第二条";

    // A /c/ route may temporarily render zero turns while messages hydrate.
    window.__cqTestRoute = "https://chatgpt.com/c/existing-chat";
    state.url = window.__cqTestRoute;
    state.tasks.length = 0;
    conversation.replaceChildren();
    result.existingChatNative = !press("旧聊天正在加载");
    await wait(160);
    result.existingChatNoQueue = state.tasks.length === 0 &&
      sent.length === 5 && sent[4] === "旧聊天正在加载";

    // Do not bypass draft-owned queue work, or an automatic handoff intro.
    window.__cqTestRoute = "https://chatgpt.com/";
    state.url = window.__cqTestRoute;
    state.tasks.length = 0;
    state.tasks.push({id:"existing",text:"已安排的任务",status:"pending"});
    result.pendingDraftNative = !press("等待已有入队任务");
    await wait(160);
    result.pendingDraftQueueUnchanged = state.tasks.length === 1 &&
      sent.length === 6 && sent[5] === "等待已有入队任务";

    state.tasks.length = 0;
    state.handoffSourceKey = "chat:origin";
    result.handoffNative = !press("已有接力来源");
    await wait(160);
    result.handoffNoQueue = state.tasks.length === 0 &&
      sent.length === 7 && sent[6] === "已有接力来源";
  } catch (error) {
    result.error = error.stack || String(error);
  }
  result.ok = ["personalFirstNative","personalSecondNative","personalQueueNotTouched",
    "projectFirstNative","projectSecondNative","projectQueueNotTouched",
    "existingChatNative","existingChatNoQueue",
    "pendingDraftNative","pendingDraftQueueUnchanged",
    "handoffNative","handoffNoQueue"].every(key => result[key] === true);
  document.body.dataset.test = JSON.stringify(result);
},300);
</script></body></html>`);
    const run = spawnSync(browser, [
      "--headless=new","--disable-gpu","--disable-extensions","--no-first-run",
      `--user-data-dir=${path.join(dir,"profile")}`,
      "--virtual-time-budget=9000","--dump-dom",
      `file:///${path.join(dir,"index.html").replace(/\\/g,"/")}`,
    ], {encoding:"utf8",timeout:25000,maxBuffer:7e6});
    assert.equal(run.status,0,run.stderr || "Chrome failed");
    const match = run.stdout.match(/data-test="([^"]+)"/);
    assert.ok(match,"Chrome did not finish first-turn Enter test");
    const result = JSON.parse(match[1].replace(/&quot;/g,'"'));
    assert.equal(result.ok,true,JSON.stringify(result,null,2));
  } finally {
    fs.rmSync(dir,{recursive:true,force:true,maxRetries:12,retryDelay:250});
  }
});
