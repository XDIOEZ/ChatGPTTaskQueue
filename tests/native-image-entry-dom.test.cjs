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

test("原生输入框选图后的 Enter / 入队可持久化图文，无法读取的附件拒绝误入队", {
  skip: !fs.existsSync(browser) && "Chrome is not installed",
}, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cq-native-image-"));
  try {
    let source = fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8");
    source = source.replace("  function boundHere() {",
      "  function boundHere() { return true; }\n  function originalBoundHereForTest() {");
    fs.writeFileSync(path.join(dir, "content.js"), source);
    fs.copyFileSync(path.join(__dirname, "..", "panel.css"), path.join(dir, "panel.css"));
    fs.writeFileSync(path.join(dir, "index.html"), `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><link rel="stylesheet" href="./panel.css"></head><body>
<main><form id="composer">
  <textarea id="prompt-textarea"></textarea>
  <input id="native-image" type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple>
  <button type="button" aria-label="Send" data-testid="send-button" id="send-button">↑</button>
</form></main>
<script>
const form = document.querySelector("#composer");
const editor = document.querySelector("#prompt-textarea");
const upload = document.querySelector("#native-image");
const enqueued = [];
let sent = 0;
let failNextAck = false;
let deferNextAck = false;
let releaseDeferredAck = null;
const processedRequests = new Set();
let storedRequests = [];
const state = {
  key:"draft:1",tasks:[],schedules:[],
  activeTaskId:null,steeringTaskId:null,halted:false,autoOpenTab:false,
};
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lSkAAAAASUVORK5CYII=";
const make = (name="native.png",type="image/png") => {
  const bytes = Uint8Array.from(atob(type === "image/png" ? png : "YWFh"),ch => ch.charCodeAt(0));
  return new File([bytes],name,{type});
};
function addChip(file) {
  const chip = document.createElement("div");
  chip.setAttribute("data-testid","file-chip");
  const name = document.createElement("span");
  name.textContent = file.name;
  const remove = document.createElement("button");
  remove.type = "button";
  remove.setAttribute("aria-label","Remove file");
  remove.textContent = "×";
  remove.onclick = () => chip.remove();
  chip.append(name,remove);
  form.append(chip);
}
upload.addEventListener("change", () => {
  for (const file of upload.files) addChip(file);
  // Emulate ChatGPT React uploader clearing the native input after selection.
  upload.value = "";
});
document.querySelector("#send-button").onclick = () => { sent++; editor.value = ""; };
window.chrome = {
  runtime:{
    onMessage:{addListener(){}},
    async sendMessage(request) {
      storedRequests.push(request.type);
      if (request.type === "ENQUEUE") {
        enqueued.push(request);
        if (!processedRequests.has(request.requestId)) {
          processedRequests.add(request.requestId);
          state.tasks.push({
            id: String(state.tasks.length+1),text:request.text,
            images: request.images.map((img,i) => ({id:"img-"+i,thumbnail:img.thumbnail,name:img.name})),
            status:"pending",
          });
        }
        if (failNextAck) {
          failNextAck = false;
          return {ok:false,error:"模拟数据已保存但消息响应丢失"};
        }
        if (deferNextAck) {
          deferNextAck = false;
          return await new Promise(resolve => {
            releaseDeferredAck = () => resolve({
              ok:true,state,sessionKey:"draft:1",settings:{maxPending:100},
            });
          });
        }
      }
      return {ok:true,state,sessionKey:"draft:1",settings:{maxPending:100}};
    },
  },
  storage:{onChanged:{addListener(){}}},
};
function choose(files) {
  const list = new DataTransfer();
  for (const file of files) list.items.add(file);
  upload.files = list.files;
  upload.dispatchEvent(new Event("change",{bubbles:true}));
}
const press = () => !editor.dispatchEvent(new KeyboardEvent("keydown",{
  key:"Enter",bubbles:true,cancelable:true,
}));
const wait = (ms) => new Promise(resolve => setTimeout(resolve,ms));
const waitUntil = async (predicate, timeoutMs = 4500) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await wait(60);
  }
  return Boolean(predicate());
};
</script>
<script src="./content.js"></script>
<script>
setTimeout(async () => {
  const flags = {};
  try {
    flags.ready = !!document.querySelector("#cq-extension-root");
    editor.value = "描述原生图片";
    choose([make()]);
    flags.inputClearedAfterSelection = upload.files.length === 0;
    flags.enterBlocked = press();
    await waitUntil(() => enqueued.length === 1 && editor.value === "" &&
      !form.querySelector('[data-testid="file-chip"]'));
    flags.textAndImageQueued = enqueued.length === 1 &&
      enqueued[0].text === "描述原生图片" && enqueued[0].images.length === 1 &&
      enqueued[0].images[0].dataUrl.startsWith("data:image/png;base64,");
    flags.nativeComposerCleaned = editor.value === "" &&
      !form.querySelector('[data-testid="file-chip"]') && sent === 0;

    choose([make("screenshot.png")]);
    flags.imageOnlyEnterBlocked = press();
    await waitUntil(() => enqueued.length === 2 && editor.value === "" &&
      !form.querySelector('[data-testid="file-chip"]'));
    flags.imageOnlyEntered = enqueued.length === 2 &&
      enqueued[1].text === "" && enqueued[1].images.length === 1 &&
      editor.value === "" && !form.querySelector('[data-testid="file-chip"]');

    choose([make("button.png")]);
    document.querySelector('[data-action="queue-composer"]').click();
    await waitUntil(() => enqueued.length === 3 &&
      !form.querySelector('[data-testid="file-chip"]'));
    flags.imageOnlyButton = enqueued.length === 3 &&
      enqueued[2].images[0].name === "button.png" && enqueued[2].text === "";

    editor.value = "多张截图";
    choose([make("first.png"),make("second.png")]);
    document.querySelector('[data-action="queue-composer"]').click();
    await waitUntil(() => enqueued.length === 4 && editor.value === "" &&
      !form.querySelector('[data-testid="file-chip"]'));
    flags.multipleImages = enqueued.length === 4 &&
      enqueued[3].images.length === 2 &&
      !form.querySelector('[data-testid="file-chip"]') && editor.value === "";
    flags.nativeIdCreated = enqueued.every((item) => /^[0-9a-f-]{36}$/i.test(item.requestId)) &&
      new Set(enqueued.map((item) => item.requestId)).size === 4;

    editor.value = "保存成功但回复丢失时可以安全重试";
    failNextAck = true;
    flags.lostAckIntercepted = press();
    await waitUntil(() => enqueued.length === 5);
    flags.lostAckKeepsDraft = editor.value.includes("安全重试") &&
      state.tasks.length === 5 && enqueued.length === 5;
    flags.safeRetryIntercepted = press();
    await waitUntil(() => enqueued.length === 6 && editor.value === "");
    flags.safeRetryDedupe = enqueued.length === 6 &&
      enqueued[5].requestId === enqueued[4].requestId &&
      state.tasks.length === 5 && editor.value === "" && sent === 0;

    editor.value = "无法读取原始文件时不得入队";
    addChip(make("orphan.png")); // Existing native preview, no original File event.
    const previous = enqueued.length;
    flags.mismatchBlocked = press();
    await wait(100);
    flags.mismatchKept = enqueued.length === previous &&
      editor.value.includes("无法读取原始文件") &&
      !!form.querySelector('[data-testid="file-chip"]') &&
      sent === 0;
    form.querySelector('[data-testid="file-chip"]').remove();

    editor.value = "不是图片的文件不能作为图文入队";
    choose([make("data.txt","text/plain")]);
    flags.nonImageBlocked = press();
    await wait(100);
    flags.nonImageKept = enqueued.length === previous &&
      editor.value.includes("不是图片") &&
      !!form.querySelector('[data-testid="file-chip"]') &&
      sent === 0;

    form.querySelector('[data-testid="file-chip"] button').click();
    const portal = document.createElement("input");
    portal.type = "file";
    document.body.appendChild(portal);
    const selected = new DataTransfer();
    selected.items.add(make("still-uploading.png"));
    portal.files = selected.files;
    portal.dispatchEvent(new Event("change",{bubbles:true}));
    portal.remove();
    editor.value = "图片尚未上传完毕不能只保存文字";
    flags.pendingUploadBlocked = press();
    await wait(130);
    flags.pendingUploadKept = enqueued.length === previous &&
      editor.value.includes("尚未上传完毕") && sent === 0;

    editor.value = "原本要入队的图片消息";
    choose([make("original.png")]);
    deferNextAck = true;
    press();
    await waitUntil(() => typeof releaseDeferredAck === "function");
    flags.nativeSaveWasDeferred = typeof releaseDeferredAck === "function" &&
      enqueued.length === previous+1;
    editor.value = "图片保存时写入的新草稿";
    choose([make("new-draft.png")]);
    releaseDeferredAck?.();
    await waitUntil(() => editor.value === "图片保存时写入的新草稿");
    flags.changedNativeDraftPreserved = enqueued.length === previous+1 &&
      enqueued.at(-1).text === "原本要入队的图片消息" &&
      editor.value === "图片保存时写入的新草稿" &&
      form.querySelectorAll('[data-testid="file-chip"]').length === 2 &&
      sent === 0;
  } catch (error) {
    flags.error = error.stack || error.message;
  }
  flags.debug = {
    enqueued: enqueued.map((item) => ({text:item.text,images:item.images?.length})),
    requests: storedRequests,
    notice: document.querySelector(".cq-notice")?.textContent,
    nativeChips: form.querySelectorAll('[data-testid="file-chip"]').length,
    editor: editor.value,
  };
  flags.ok = ["ready","inputClearedAfterSelection","enterBlocked",
    "textAndImageQueued","nativeComposerCleaned","imageOnlyEnterBlocked",
    "imageOnlyEntered","imageOnlyButton","multipleImages","nativeIdCreated",
    "lostAckIntercepted","lostAckKeepsDraft","safeRetryIntercepted",
    "safeRetryDedupe","mismatchBlocked",
    "mismatchKept","nonImageBlocked","nonImageKept",
    "pendingUploadBlocked","pendingUploadKept",
    "nativeSaveWasDeferred","changedNativeDraftPreserved"]
    .every((key) => flags[key] === true);
  document.body.dataset.check = JSON.stringify(flags);
}, 300);
</script></body></html>`);
    const run = spawnSync(browser, [
      "--headless=new", "--disable-gpu", "--disable-extensions", "--no-first-run",
      `--user-data-dir=${path.join(dir,"profile")}`,
      "--virtual-time-budget=20000", "--dump-dom",
      `file:///${path.join(dir,"index.html").replace(/\\/g,"/")}`,
    ], {encoding:"utf8",timeout:23000,maxBuffer:8e6});
    assert.equal(run.status,0,run.stderr || "Chrome failed");
    const match = run.stdout.match(/data-check="([^"]+)"/);
    assert.ok(match,"Chrome did not finish native attachment test");
    const flags = JSON.parse(match[1].replace(/&quot;/g,'"'));
    assert.equal(flags.ok,true,JSON.stringify(flags));
  } finally {
    fs.rmSync(dir,{recursive:true,force:true});
  }
});
