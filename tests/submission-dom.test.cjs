"use strict";

const {test} = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const {spawnSync} = require("node:child_process");

const browser = process.env.CQ_BROWSER_BIN || (process.platform === "win32"
  ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
  : "/usr/bin/google-chrome");

test("真实 Chrome：双击图文入队/创建自动规则只提交一次；失败重试复用同一请求 ID", {
  skip: !fs.existsSync(browser) && "Chrome is not installed",
}, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cq-submission-dom-"));
  try {
    let script = fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8");
    script = script.replace("  function boundHere() {",
      "  function boundHere() { return true; }\n  function unusedBoundHere() {");
    fs.writeFileSync(path.join(dir, "content.js"), script);
    fs.copyFileSync(path.join(__dirname, "..", "panel.css"), path.join(dir, "panel.css"));
    fs.writeFileSync(path.join(dir, "index.html"), `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><link rel="stylesheet" href="./panel.css"></head>
<body><main><form>
  <textarea id="prompt-textarea"></textarea>
  <button type="button" data-testid="send-button" aria-label="Send">发送</button>
</form></main>
<script>
const settings = {
  maxPending:100,protectBackground:true,
  defaultIntervalMinutes:30,defaultRepeatCount:-1,queueListHeight:null,
};
const state = {
  key:"draft:1",tasks:[],schedules:[],halted:false,
  activeTaskId:null,steeringTaskId:null,autoOpenTab:false,queuePaused:false,
};
const requests = [];
const pending = [];
const completed = new Set();
let next = 0;
window.chrome = {
  runtime: {
    onMessage:{addListener(){}},
    sendMessage(message) {
      requests.push(message);
      if (message.type === "ENQUEUE" || message.type === "ADD_SCHEDULE") {
        return new Promise(resolve => pending.push({message,resolve}));
      }
      return Promise.resolve({ok:true,state,sessionKey:"draft:1",settings});
    },
  },
  storage:{onChanged:{addListener(){}}},
};
function finish(type, lostAcknowledgement=false) {
  const index = pending.findIndex(item => item.message.type === type);
  if (index < 0) throw new Error("no pending " + type);
  const {message,resolve} = pending.splice(index,1)[0];
  if (!completed.has(message.requestId)) {
    completed.add(message.requestId);
    if (type === "ENQUEUE") {
      state.tasks.push({
        id:"task-"+(++next),status:"pending",text:message.text,images:[],
      });
    } else {
      state.schedules.push({
        id:"rule-"+(++next),text:message.text,mode:message.mode,
        enabled:true,intervalMinutes:Number(message.intervalMinutes),
        repeatCount:Number(message.repeatCount),runCount:0,
        nextRunAt:Date.now()+60*1000,images:[],
      });
    }
  }
  resolve(lostAcknowledgement ? {ok:false,error:"模拟保存成功但响应丢失"} :
    {ok:true,state,sessionKey:"draft:1",settings});
}
const wait = (ms) => new Promise(resolve => setTimeout(resolve,ms));
const root = () => document.querySelector("#cq-extension-root");
const click = action => {
  if (action === "toggle-queue-composer") {
    if (!root().querySelector('[data-action="toggle-queue-composer"]')) click("toggle-settings");
    root().querySelector('[data-action="show-settings-page"][data-page="general"]').click();
  }
  const node = root().querySelector('[data-action="'+action+'"]');
  if (!node) throw new Error("missing button: "+action);
  node.click();
  return node;
};
const edit = (id,text) => {
  const node = root().querySelector("#"+id);
  if (!node) throw new Error("missing draft: "+id);
  node.value=text;
  node.dispatchEvent(new Event("input",{bubbles:true}));
};
const posted = type => requests.filter(request => request.type === type);
</script>
<script src="./content.js"></script>
<script>
setTimeout(async () => {
  const flags = {};
  try {
    click("toggle-queue-composer");
    edit("cq-queue-draft","相同文本也可以多次主动入队");
    const saveFirst = click("save-queue-composer");
    saveFirst.click();
    flags.doubleClickQueueBlocked = posted("ENQUEUE").length === 1 &&
      pending.length === 1 &&
      /^[0-9a-f-]{36}$/i.test(posted("ENQUEUE")[0].requestId);
    finish("ENQUEUE");
    await wait(90);
    flags.firstSaved = state.tasks.length === 1 &&
      !root().querySelector("#cq-queue-draft");

    click("toggle-queue-composer");
    edit("cq-queue-draft","相同文本也可以多次主动入队");
    click("save-queue-composer");
    flags.newQueueHasNewId = posted("ENQUEUE").length === 2 &&
      posted("ENQUEUE")[1].requestId !== posted("ENQUEUE")[0].requestId;
    finish("ENQUEUE");
    await wait(90);
    flags.userRepeatAllowed = state.tasks.length === 2;

    click("toggle-queue-composer");
    edit("cq-queue-draft","丢失保存响应后不能重复入队");
    click("save-queue-composer");
    const failedId = posted("ENQUEUE")[2].requestId;
    finish("ENQUEUE",true);
    await wait(90);
    flags.failedDraftPreserved = state.tasks.length === 3 &&
      root().querySelector("#cq-queue-draft")?.value ===
        "丢失保存响应后不能重复入队";
    click("save-queue-composer");
    flags.retryUsesSameId = posted("ENQUEUE").length === 4 &&
      posted("ENQUEUE")[3].requestId === failedId;
    finish("ENQUEUE");
    await wait(90);
    flags.retryNotDuplicated = state.tasks.length === 3 &&
      !root().querySelector("#cq-queue-draft");

    click("toggle-scheduler");
    edit("cq-schedule-draft","自动规则 A");
    const saveRule = click("save-schedule");
    saveRule.click();
    flags.doubleClickScheduleBlocked = posted("ADD_SCHEDULE").length === 1 &&
      pending.length === 1 &&
      /^[0-9a-f-]{36}$/i.test(posted("ADD_SCHEDULE")[0].requestId);
    finish("ADD_SCHEDULE");
    await wait(90);
    flags.firstRuleCreated = state.schedules.length === 1 &&
      !!root().querySelector('[data-action="show-schedule-create"]');

    click("show-schedule-create");
    edit("cq-schedule-draft","自动规则 B");
    click("save-schedule");
    flags.nextRuleHasNewId = posted("ADD_SCHEDULE").length === 2 &&
      posted("ADD_SCHEDULE")[0].requestId !== posted("ADD_SCHEDULE")[1].requestId;
    finish("ADD_SCHEDULE");
    await wait(90);
    flags.twoRules = state.schedules.length === 2;

    // A slow save must not erase text typed after the request was sent.
    click("toggle-queue-composer");
    edit("cq-queue-draft","原本正在保存的图文任务");
    click("save-queue-composer");
    const originalQueueRequest = posted("ENQUEUE").at(-1);
    edit("cq-queue-draft","保存过程中追加的新草稿");
    finish("ENQUEUE");
    await wait(90);
    flags.newQueueDraftPreserved = state.tasks.length === 4 &&
      state.tasks.at(-1).text === "原本正在保存的图文任务" &&
      root().querySelector("#cq-queue-draft")?.value ===
      "保存过程中追加的新草稿";
    click("save-queue-composer");
    flags.changedDraftHasNewId = posted("ENQUEUE").at(-1).requestId !==
      originalQueueRequest.requestId;
    finish("ENQUEUE");
    await wait(90);
    flags.queueSecondSaveWorks = state.tasks.length === 5 &&
      state.tasks.at(-1).text === "保存过程中追加的新草稿";

    click("toggle-scheduler");
    click("show-schedule-create");
    edit("cq-schedule-draft","保存中的定时规则");
    click("save-schedule");
    const originalRuleRequest = posted("ADD_SCHEDULE").at(-1);
    edit("cq-schedule-draft","保存期间修改的另一条规则");
    finish("ADD_SCHEDULE");
    await wait(90);
    flags.newRuleDraftPreserved = state.schedules.length === 3 &&
      state.schedules.at(-1).text === "保存中的定时规则" &&
      root().querySelector("#cq-schedule-draft")?.value ===
      "保存期间修改的另一条规则";
    click("save-schedule");
    flags.changedRuleHasNewId = posted("ADD_SCHEDULE").at(-1).requestId !==
      originalRuleRequest.requestId;
    finish("ADD_SCHEDULE");
    await wait(90);
    flags.ruleSecondSaveWorks = state.schedules.length === 4 &&
      state.schedules.at(-1).text === "保存期间修改的另一条规则";

    click("toggle-queue-composer");
    edit("cq-queue-draft","切换对话时仍保留输入内容");
    click("save-queue-composer");
    history.replaceState(null,"","#another-chat");
    finish("ENQUEUE");
    await wait(90);
    flags.oldRouteCannotEraseNewDraft = state.tasks.length === 6 &&
      root().querySelector("#cq-queue-draft")?.value ===
      "切换对话时仍保留输入内容";
  } catch (error) { flags.error = error.stack || error.message; }
  flags.debug = { calls: requests.filter(r =>
    ["ENQUEUE","ADD_SCHEDULE"].includes(r.type)).map(r => [r.type,r.requestId]),
    queue:state.tasks.length,rules:state.schedules.length,pending:pending.length,
  };
  flags.ok = ["doubleClickQueueBlocked","firstSaved","newQueueHasNewId",
    "userRepeatAllowed","failedDraftPreserved","retryUsesSameId",
    "retryNotDuplicated","doubleClickScheduleBlocked","firstRuleCreated",
    "nextRuleHasNewId","twoRules","newQueueDraftPreserved","changedDraftHasNewId",
    "queueSecondSaveWorks","newRuleDraftPreserved","changedRuleHasNewId",
    "ruleSecondSaveWorks","oldRouteCannotEraseNewDraft"]
    .every(key => flags[key] === true);
  document.body.dataset.test=JSON.stringify(flags);
},350);
</script></body></html>`);
    const run = spawnSync(browser, [
      "--headless=new", "--disable-gpu", "--disable-extensions", "--no-first-run",
      `--user-data-dir=${path.join(dir,"profile")}`,
      "--virtual-time-budget=8000", "--dump-dom",
      `file:///${path.join(dir,"index.html").replace(/\\/g,"/")}`,
    ],{encoding:"utf8",timeout:22000,maxBuffer:7e6});
    assert.equal(run.status,0,run.stderr || "Chrome failed");
    const match=run.stdout.match(/data-test="([^"]+)"/);
    assert.ok(match,"Chrome did not complete duplicate-submission test");
    const flags=JSON.parse(match[1].replace(/&quot;/g,'"'));
    assert.equal(flags.ok,true,JSON.stringify(flags));
  } finally {
    fs.rmSync(dir,{recursive:true,force:true});
  }
});
