"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");

const sampleImageDataUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lSkAAAAASUVORK5CYII=";
const sampleImageSha256 = createHash("sha256").update(sampleImageDataUrl).digest("hex");

const browser = process.env.CQ_BROWSER_BIN || (process.platform === "win32"
  ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
  : "/usr/bin/google-chrome");

test("真实 Chrome DOM：查看/清空日志、导出备份与确认后安全恢复", {
  skip: !fs.existsSync(browser) && "Chrome is not installed",
}, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cq-backup-dom-"));
  try {
    let content = fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8");
    content = content.replace("  function boundHere() {",
      "  function boundHere() { return true; }\n  function unusedOriginalBoundHere() {");
    fs.writeFileSync(path.join(dir, "content.js"), content);
    fs.copyFileSync(path.join(__dirname, "..", "panel.css"), path.join(dir, "panel.css"));
    fs.writeFileSync(path.join(dir, "index.html"), `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><link rel="stylesheet" href="./panel.css"></head>
<body><main><form><textarea id="prompt-textarea"></textarea>
<button type="button" aria-label="Send" data-testid="send-button">发送</button></form></main>
<script>
const settings = {
  maxPending:100,protectBackground:true,
  defaultIntervalMinutes:30,defaultRepeatCount:-1,queueListHeight:null,
};
const calls = [];
const confirms = [];
const downloads = [];
const originalImage = {
  id:"picture-1",name:"backup.png",type:"image/png",size:68,
  thumbnail:"data:image/jpeg;base64,YWJj",
  dataUrl:"${sampleImageDataUrl}",
  sha256:"${sampleImageSha256}",
};
const uploaded = [];
let state = {
  key:"draft:1",tasks:[],schedules:[],history:[
    {at:Date.now(),type:"manual_enqueue",taskId:"mock-task"},
    {at:Date.now(),type:"send_failed",taskId:"mock-task"},
  ],halted:false,activeTaskId:null,steeringTaskId:null,autoOpenTab:false,
  queuePaused:false,
};
const backup = {
  format:"chatgpt-taskqueue-conversation",version:1,
  exportedAt:new Date().toISOString(),
  conversation:{key:"draft:1",tasks:[{
    id:"pending-1",text:"待恢复的任务",images:[{id:"picture-1"}],
    status:"pending",sourceScheduleId:null,
  }],schedules:[],countRateLimit:{enabled:false,windowMinutes:10,maxAdds:3}},
  images:[originalImage],
};
window.chrome = {
  runtime:{
    onMessage:{addListener(){}},
    async sendMessage(message) {
      calls.push(message);
      if (message.type === "GET_BACKUP_META") return {
        ok:true,state,sessionKey:"draft:1",settings,backup:{
          ...backup,images:[{
            id:originalImage.id,name:originalImage.name,
            type:originalImage.type,size:originalImage.size,
          }],
        },
      };
      if (message.type === "GET_BACKUP_IMAGE") return {
        ok:true,state,sessionKey:"draft:1",settings,images:[originalImage],
      };
      if (message.type === "CHECK_QUEUE_IMAGES") return {
        ok:true,state,sessionKey:"draft:1",settings,
        imageHealth:{total:2,missing:1,affectedTasks:1,affectedRules:0},
      };
      if (message.type === "CLEAR_HISTORY") state.history = [];
      if (message.type === "RESTORE_BACKUP_BEGIN") return {
        ok:true,state,sessionKey:"draft:1",settings,
        backup:{token:"restoring-now"},
      };
      if (message.type === "RESTORE_BACKUP_IMAGE") uploaded.push(message.image);
      if (message.type === "RESTORE_BACKUP_FINISH") {
        state.tasks = [{
          id:"restored-1",text:"待恢复的任务",
          images:[{id:"new-image"}],status:"pending",
        }];
        state.queuePaused = true;
        state.history = [{at:Date.now(),type:"backup_restored"}];
      }
      return {ok:true,state,sessionKey:"draft:1",settings};
    },
  },
  storage:{onChanged:{addListener(){}}},
};
window.confirm = (message) => {confirms.push(message);return true;};
HTMLAnchorElement.prototype.click = function() {
  downloads.push({name:this.download,url:this.href});
};
</script>
<script src="./content.js"></script>
<script>
const wait = (ms) => new Promise(resolve => setTimeout(resolve,ms));
setTimeout(async () => {
  const flags = {};
  try {
    const root = document.querySelector("#cq-extension-root");
    root.querySelector('[data-action="toggle-settings"]').click();
    flags.diagnosticsInitiallyFolded =
      root.querySelector('[data-action="toggle-diagnostics"]')
        ?.getAttribute("aria-expanded") === "false" &&
      !root.querySelector("#cq-diagnostics-content") &&
      root.querySelector(".cq-diagnostics")?.textContent.includes("图文备份");
    root.querySelector('[data-action="toggle-diagnostics"]').click();
    flags.diagnosticsOpened =
      root.querySelector('[data-action="toggle-diagnostics"]')
        ?.getAttribute("aria-expanded") === "true" &&
      !!root.querySelector("#cq-diagnostics-content");
    flags.historyVisible = root.querySelectorAll(".cq-history-entry").length === 2 &&
      root.querySelector(".cq-diagnostics")?.textContent.includes("不保存提示词或图片正文");
    flags.backupWarningVisible = root.querySelector(".cq-diagnostics")?.textContent
      .includes("未加密的敏感文件");

    root.querySelector('[data-action="export-backup"]').click();
    await wait(90);
    flags.exported = calls.some((call) => call.type === "GET_BACKUP_META") &&
      calls.some((call) => call.type === "GET_BACKUP_IMAGE" &&
        call.imageId === originalImage.id) &&
      !calls.some((call) => call.type === "GET_BACKUP") &&
      downloads.length === 1 &&
      downloads[0].name.includes("chatgpt-queue") &&
      downloads[0].name.endsWith(".json") &&
      downloads[0].url.startsWith("blob:");

    root.querySelector('[data-action="clear-history"]').click();
    await wait(60);
    flags.cleared = calls.some((call) => call.type === "CLEAR_HISTORY") &&
      root.querySelectorAll(".cq-history-entry").length === 0 &&
      confirms.some((message) => message.includes("不会影响任务"));

    root.querySelector('[data-action="check-queue-images"]').click();
    await wait(85);
    flags.imageCheck = calls.some((call) => call.type === "CHECK_QUEUE_IMAGES") &&
      root.querySelector(".cq-image-health")?.textContent.includes("有 1 张缺失") &&
      root.querySelector(".cq-image-health")?.textContent.includes("影响 1 条队列任务");

    const restore = root.querySelector("#cq-backup-file");
    const transfer = new DataTransfer();
    // Chrome's headless virtual-time clock can outrun disk-backed File.text().
    // Mock only the file content read; the actual chooser/change/confirmation
    // and extension request remain real DOM interactions.
    const backupFile = new File([JSON.stringify(backup)],
      "my-backup.json", {type:"application/json"});
    File.prototype.text = () => Promise.resolve(JSON.stringify(backup));
    transfer.items.add(backupFile);
    restore.files = transfer.files;
    restore.dispatchEvent(new Event("change",{bubbles:true}));
    await wait(350);
    flags.importConfirmed = confirms.some((message) =>
      message.includes("自动发送暂停") && message.includes("同一对话"));
    flags.importCalled = calls.some((call) =>
      call.type === "RESTORE_BACKUP_BEGIN" &&
      call.backup?.format === "chatgpt-taskqueue-conversation" &&
      !call.backup.images[0].dataUrl &&
      call.backup.images[0].sha256 === originalImage.sha256) &&
      calls.some((call) => call.type === "RESTORE_BACKUP_FINISH") &&
      uploaded.length === 1 && uploaded[0].dataUrl === originalImage.dataUrl &&
      !calls.some((call) => call.type === "RESTORE_BACKUP");
    flags.importSafe = state.queuePaused && state.tasks.length === 1 &&
      root.querySelector(".cq-status-paused") &&
      root.querySelector(".cq-history-entry")?.textContent.includes("从备份恢复");
    flags.privacy = !root.querySelector(".cq-diagnostics").innerHTML
      .includes("待恢复的任务");
    root.querySelector('[data-action="toggle-diagnostics"]').click();
    flags.diagnosticsCollapsedAfterActions =
      root.querySelector('[data-action="toggle-diagnostics"]')
        ?.getAttribute("aria-expanded") === "false" &&
      !root.querySelector(".cq-history-list") &&
      state.tasks.length === 1 && state.queuePaused;
    root.querySelector('[data-action="toggle-diagnostics"]').click();
    flags.diagnosticsReopenedAfterActions =
      root.querySelector('[data-action="toggle-diagnostics"]')
        ?.getAttribute("aria-expanded") === "true" &&
      root.querySelector(".cq-history-entry")?.textContent.includes("从备份恢复");
    flags.debug = {
      calls: calls.map((call) => call.type),
      confirms,
      notice: root.querySelector(".cq-notice")?.textContent,
      html: root.querySelector(".cq-diagnostics")?.textContent.slice(-300),
    };
  } catch (error) { flags.error = error.stack || error.message; }
  flags.ok = ["diagnosticsInitiallyFolded","diagnosticsOpened",
    "historyVisible","backupWarningVisible","exported","cleared",
    "imageCheck","importConfirmed","importCalled","importSafe","privacy",
    "diagnosticsCollapsedAfterActions","diagnosticsReopenedAfterActions"]
    .every((key) => Boolean(flags[key]));
  document.body.dataset.test = JSON.stringify(flags);
}, 350);
</script></body></html>`);
    const run = spawnSync(browser, [
      "--headless=new", "--disable-gpu", "--disable-extensions", "--no-first-run",
      `--user-data-dir=${path.join(dir, "profile")}`,
      "--virtual-time-budget=5000", "--dump-dom",
      `file:///${path.join(dir, "index.html").replace(/\\/g, "/")}`,
    ], {encoding:"utf8",timeout:23000,maxBuffer:7e6});
    assert.equal(run.status, 0, run.stderr || "Chrome failed");
    const match = run.stdout.match(/data-test="([^"]+)"/);
    assert.ok(match, "Chrome did not complete the backup DOM test");
    const flags = JSON.parse(match[1].replace(/&quot;/g, '"'));
    assert.equal(flags.ok, true, JSON.stringify(flags));
  } finally {
    fs.rmSync(dir, {recursive:true,force:true});
  }
});
