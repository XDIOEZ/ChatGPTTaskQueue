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

test("真实浏览器从图片队列恢复附件后才发送，读取图片失败则阻止发送", {
  skip: !fs.existsSync(browser) && "Chrome is not installed",
}, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cq-image-dispatch-"));
  try {
    let content = fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8");
    content = content.replace("  function boundHere() {",
      "  function boundHere() { return true; }\n  function unusedOriginalBoundHere() {");
    const marker = content.match(/  void init\(\);\r?\n\}\)\(\);/)?.[0];
    assert.ok(marker, "Cannot locate extension initialization with either line-ending style");
    content = content.replace(marker, `  window.__cqImageTest = {
      async send(task) {
        state = { ...state, tasks: [task], activeTaskId: task.id, halted: false };
        return sendTask(task);
      }
    };
    ${marker}`);
    fs.writeFileSync(path.join(dir, "content.js"), content);
    fs.writeFileSync(path.join(dir, "index.html"), `<!doctype html>
<html><head><meta charset="utf-8"></head><body>
<main><form id="composer">
  <textarea id="prompt-textarea"></textarea>
  <input id="native-image-input" type="file" accept="image/png,image/jpeg" multiple style="display:none">
  <button id="send-button" type="button" data-testid="send-button" aria-label="Send">发送</button>
  <button id="voice" type="button" aria-label="Start Voice">语音</button>
</form></main>
<script>
const saved = {
  id:"photo1",name:"样例.png",type:"image/png",
  dataUrl:"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lSkAAAAASUVORK5CYII=",
};
let dbMissing = false;
let sentClicks = 0;
let receivedFiles = [];
const imageRequests = [];
const savedImages = Array.from({length:4}, (_,i) => ({
  ...saved,id:"photo-"+(i+1),name:"附件"+(i+1)+".png",size:68,
}));
const requests = [];
let queueRequest = null;
let state = {
  key:"draft:1",halted:false,haltReason:null,activeTaskId:null,
  tasks:[],schedules:[],autoOpenTab:false
};
const form = document.getElementById("composer");
const fileInput = document.getElementById("native-image-input");
fileInput.addEventListener("change", () => {
  receivedFiles = [...fileInput.files].map((file) => ({name:file.name,type:file.type,size:file.size}));
  for (const file of fileInput.files) {
    const chip = document.createElement("span");
    chip.setAttribute("data-testid","file-chip");
    chip.textContent = file.name;
    form.appendChild(chip);
  }
});
document.getElementById("send-button").addEventListener("click", () => {
  sentClicks++;
  form.querySelectorAll('[data-testid="file-chip"]').forEach((chip) => chip.remove());
  document.getElementById("prompt-textarea").value = "";
  fileInput.value = "";
});
window.chrome = {
  runtime: {
    onMessage:{addListener(){}},
    async sendMessage(message) {
      requests.push(message.type);
      if (message.type === "ENQUEUE") queueRequest = message;
      if (message.type === "GET_TASK_IMAGE") {
        imageRequests.push(message.imageId);
        if (dbMissing) return {ok:false,error:"本地图片丢失"};
        const matched = [saved,...savedImages].find((item) => item.id === message.imageId);
        if (!matched) return {ok:false,error:"图片 ID 错误"};
        return {ok:true,state,sessionKey:"draft:1",images:[{
          ...matched,size:68,
        }]};
      }
      if (message.type === "FAIL") state.halted = true;
      return {ok:true,state,sessionKey:"draft:1"};
    },
  },
  storage:{onChanged:{addListener(){}}},
};
</script>
<script src="./content.js"></script>
<script>
async function waitUntil(predicate, timeoutMs = 4500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
  return !!predicate();
}
setTimeout(async () => {
  const flags = {};
  try {
    const root = document.querySelector("#cq-extension-root");
    root.querySelector('[data-action="toggle-settings"]').click();
    root.querySelector('[data-action="show-settings-page"][data-page="general"]').click();
    root.querySelector('[data-action="toggle-queue-composer"]').click();
    const prompt = root.querySelector("#cq-queue-draft");
    prompt.value = "分析截图";
    prompt.dispatchEvent(new Event("input", { bubbles: true }));
    const binary = atob(saved.dataUrl.split(",")[1]);
    const file = new File([Uint8Array.from(binary, (char) => char.charCodeAt(0))],
      "随队图片.png", {type:"image/png"});
    const transfer = new DataTransfer();
    transfer.items.add(file);
    const picker = root.querySelector("#cq-queue-images");
    picker.files = transfer.files;
    picker.dispatchEvent(new Event("change", {bubbles:true}));
    flags.preview = await waitUntil(() =>
      !!root.querySelector(".cq-queue-create .cq-image img"));
    root.querySelector('[data-action="save-queue-composer"]').click();
    await waitUntil(() => queueRequest?.images?.length === 1);
    flags.imageQueued = queueRequest?.text === "分析截图" &&
      queueRequest.images?.length === 1 &&
      queueRequest.images[0].dataUrl === saved.dataUrl;

    const img = [{id:saved.id,name:saved.name,type:saved.type,size:68}];
    await window.__cqImageTest.send({id:"task1",text:"描述这张图",images:img,status:"dispatching"});
    flags.nativeFile = receivedFiles.length === 1 &&
      receivedFiles[0].name === "样例.png" && receivedFiles[0].type === "image/png";
    flags.sentWithImage = sentClicks === 1 && requests.includes("SENT");
    dbMissing = true;
    await window.__cqImageTest.send({id:"task2",text:"不能只发文字",images:img,status:"dispatching"});
    flags.missingStopped = sentClicks === 1 && requests.includes("FAIL") &&
      !requests.includes("RELEASE_CLAIM");

    dbMissing = false;
    state.halted = false;
    state.activeTaskId = "task3"; // Preserve ownership in the mocked RPC replies.
    document.querySelector("#prompt-textarea").value = ""; // User reviewed the failed task's unsent draft.
    const four = savedImages.map((item) => ({
      id:item.id,name:item.name,type:item.type,size:item.size,
    }));
    await window.__cqImageTest.send({id:"task3",text:"四张图片完整发送",images:four,status:"dispatching"});
    flags.fourLoadedInOrder = imageRequests.slice(-4).join(",") ===
      savedImages.map((item) => item.id).join(",");
    flags.fourAttachedBeforeSend = sentClicks === 2 &&
      receivedFiles.length === 4 &&
      receivedFiles.every((file,i) => file.name === savedImages[i].name);
    flags.noLegacyBulkMessage = !requests.includes("GET_TASK_IMAGES");

    dbMissing = true;
    state.halted = false;
    state.activeTaskId = "task4";
    await window.__cqImageTest.send({id:"task4",text:"缺图不能发送",images:four,status:"dispatching"});
    flags.multiImageFailureSafe = sentClicks === 2 && requests.filter((type) => type === "FAIL").length >= 2;
  } catch (error) { flags.error = error.message; }
  flags.debug = {
    imageRequests, requests, receivedFiles, sentClicks, halted: state.halted,
    imageChips: form.querySelectorAll('[data-testid="file-chip"]').length,
  };
  flags.ok = ["preview","imageQueued","nativeFile","sentWithImage","missingStopped",
    "fourLoadedInOrder","fourAttachedBeforeSend","noLegacyBulkMessage","multiImageFailureSafe"]
    .every((key) => flags[key] === true);
  document.body.dataset.observer = JSON.stringify(flags);
}, 400);
</script>
</body></html>`);
    const result = spawnSync(browser, [
      "--headless=new", "--disable-gpu", "--disable-extensions", "--no-first-run",
      `--user-data-dir=${path.join(dir, "profile")}`,
      "--virtual-time-budget=15000", "--dump-dom",
      `file:///${path.join(dir, "index.html").replace(/\\/g,"/")}`,
    ], { encoding:"utf8",timeout:20000,maxBuffer:6e6 });
    assert.equal(result.status, 0, result.stderr || "Chrome failed");
    const match = result.stdout.match(/data-observer="([^"]+)"/);
    assert.ok(match, "Chrome did not finish image queue DOM test");
    const flags = JSON.parse(match[1].replace(/&quot;/g, '"'));
    assert.equal(flags.ok, true, JSON.stringify(flags));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
