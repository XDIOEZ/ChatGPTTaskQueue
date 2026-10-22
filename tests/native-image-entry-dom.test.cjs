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
let nativeRemoveClicks = 0;
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
// Some ChatGPT layouts render an image thumbnail with a sibling close button,
// not a data-testid="file-chip" wrapper. The queue must clear those too.
function addThumbnail(file, buttonType="title") {
  const card = document.createElement("div");
  card.className = "native-thumbnail-card";
  const imageSlot = document.createElement("div");
  const image = document.createElement("img");
  image.src = "data:image/png;base64," + png;
  imageSlot.append(image);
  const remove = document.createElement("button");
  remove.type = "button";
  if (buttonType === "title") remove.title = "移除图片";
  else if (buttonType === "icon") remove.textContent = "×";
  else if (buttonType === "hover") {
    remove.setAttribute("aria-label","Remove attachment");
    remove.style.opacity = "0";
    remove.style.pointerEvents = "none";
  } else if (buttonType === "close") remove.setAttribute("aria-label","Close");
  else if (buttonType === "close-zh") remove.title = "关闭";
  else if (buttonType === "svg-x") {
    remove.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">'+
      '<path d="M6 6L18 18M18 6L6 18" fill="none" stroke="currentColor" stroke-width="2"/></svg>';
  } else if (buttonType === "disabled") {
    remove.setAttribute("aria-label","Remove attachment");
    remove.disabled = true;
  }
  else remove.setAttribute("aria-label","发送");
  remove.onclick = () => { nativeRemoveClicks++; card.remove(); };
  card.append(imageSlot,remove);
  form.append(card);
}
function chooseThumbnail(file, buttonType) {
  choose([file]);
  form.querySelectorAll('[data-testid="file-chip"]').forEach(chip => chip.remove());
  addThumbnail(file,buttonType);
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

    // Wait for the preceding deferred save's finally handler to release the
    // composer lock before starting a different upload.
    await wait(160);
    form.querySelectorAll('[data-testid="file-chip"]').forEach(chip=>chip.remove());
    editor.value = "缩略图旁边的移除按钮";
    chooseThumbnail(make("thumbnail-title.png"),"title");
    flags.thumbnailEnterBlocked = press();
    await waitUntil(() => enqueued.length === previous+2 &&
      !form.querySelector('.native-thumbnail-card') && !editor.value);
    flags.thumbnailRemovedAfterQueue = enqueued.length === previous+2 &&
      enqueued.at(-1).images[0].name === "thumbnail-title.png" &&
      !form.querySelector('.native-thumbnail-card') && editor.value === "";

    editor.value = "图标叉号的图片预览";
    chooseThumbnail(make("thumbnail-icon.png"),"icon");
    flags.iconEnterBlocked = press();
    await waitUntil(() => enqueued.length === previous+3 &&
      !form.querySelector('.native-thumbnail-card') && !editor.value);
    flags.iconThumbnailRemoved = enqueued.length === previous+3 &&
      enqueued.at(-1).images[0].name === "thumbnail-icon.png" &&
      !form.querySelector('.native-thumbnail-card') && editor.value === "";

    editor.value = "无移除按钮时不能误点发送";
    chooseThumbnail(make("keep.png"),"unsafe");
    flags.unknownEnterBlocked = press();
    await waitUntil(() => enqueued.length === previous+4);
    flags.unknownActionPreserved = enqueued.length === previous+4 &&
      !!form.querySelector('.native-thumbnail-card') && sent === 0;

    // An unrelated thumbnail in a shared wrapper must not be removed just
    // because the first thumbnail has no own removal action.
    form.querySelectorAll('.native-thumbnail-card').forEach(card => card.remove());
    editor.value = "共享附件容器不能误删另一张图";
    choose([make("keep-first.png"),make("keep-second.png")]);
    form.querySelectorAll('[data-testid="file-chip"]').forEach(chip => chip.remove());
    const group = document.createElement("div");
    group.className = "shared-thumbnail-group";
    for (let i = 0; i < 2; i++) {
      const card = document.createElement("div");
      const image = document.createElement("img");
      image.src = "data:image/png;base64," + png;
      card.append(image);
      if (i === 1) {
        const remove = document.createElement("button");
        remove.title = "移除图片";
        remove.onclick = () => card.remove();
        card.append(remove);
      }
      group.append(card);
    }
    form.append(group);
    flags.groupEnterBlocked = press();
    await waitUntil(() => enqueued.length === previous+5);
    flags.sharedGroupProtected = enqueued.length === previous+5 &&
      enqueued.at(-1).images.length === 2 &&
      group.querySelectorAll("img").length === 2 && sent === 0;

    // A file picker inside another writing block must not poison the native
    // composer's image snapshot and block an unrelated plain-text Enter.
    group.remove();
    await wait(160);
    const otherForm = document.createElement("form");
    otherForm.innerHTML = '<input type="file" accept="image/png">';
    otherForm.setAttribute("data-testid","writing-block-editor");
    document.querySelector("main").append(otherForm);
    const foreignInput=otherForm.querySelector('input[type="file"]');
    const foreignFiles=new DataTransfer();
    foreignFiles.items.add(make("foreign.png"));
    foreignInput.files=foreignFiles.files;
    foreignInput.dispatchEvent(new Event("change",{bubbles:true}));
    otherForm.remove();
    const beforeForeign=enqueued.length;
    editor.value="其他表单的图片不影响普通入队";
    flags.foreignFileEnterIntercepted=press();
    await waitUntil(()=>enqueued.length===beforeForeign+1 && editor.value==="");
    flags.foreignFileDidNotPoisonComposer=enqueued.length===beforeForeign+1 &&
      enqueued.at(-1).text==="其他表单的图片不影响普通入队" &&
      enqueued.at(-1).images.length===0 && sent===0;

    // An async ENQUEUE acknowledgement must not erase a user's later edit,
    // even if they retype exactly the same text while storage is pending.
    await wait(160);
    editor.value="相同内容也是新的用户草稿";
    releaseDeferredAck=null;
    deferNextAck=true;
    const beforeSameText=enqueued.length;
    flags.sameTextEnterIntercepted=press();
    await waitUntil(()=>typeof releaseDeferredAck==="function" &&
      enqueued.length===beforeSameText+1);
    editor.dispatchEvent(new InputEvent("input",{
      bubbles:true,inputType:"insertText",data:"同样的文字"
    }));
    releaseDeferredAck?.();
    await wait(240);
    flags.sameTextAfterSavePreserved=editor.value==="相同内容也是新的用户草稿" &&
      enqueued.length===beforeSameText+1 &&
      enqueued.at(-1).text==="相同内容也是新的用户草稿" && sent===0;

    // ChatGPT can swap its composer while ENQUEUE is awaiting storage.
    // The old editor may remain connected; do not clear it just because
    // its text still matches the saved queue row.
    await wait(160);
    editor.value="原输入框仍有未发送草稿";
    releaseDeferredAck=null;
    deferNextAck=true;
    const beforeSwap=enqueued.length;
    flags.composerSwapEnterIntercepted=press();
    await waitUntil(()=>typeof releaseDeferredAck==="function" &&
      enqueued.length===beforeSwap+1);
    const newerForm=document.createElement("form");
    newerForm.innerHTML='<textarea id="prompt-textarea">新编辑器的独立草稿</textarea>';
    form.before(newerForm);
    releaseDeferredAck?.();
    await wait(240);
    flags.swappedEditorsBothPreserved=enqueued.length===beforeSwap+1 &&
      editor.value==="原输入框仍有未发送草稿" &&
      newerForm.querySelector("textarea").value==="新编辑器的独立草稿" &&
      sent===0;
    newerForm.remove();

    // Explicit single-card remove/close controls may be invisible until
    // hover. Generic SVG X controls require visible, unambiguous geometry.
    await wait(160);
    for(const kind of ["hover","close","close-zh","svg-x"]){
      editor.value="清理兼容图片按钮 "+kind;
      chooseThumbnail(make("remove-"+kind+".png"),kind);
      const before=enqueued.length,clicks=nativeRemoveClicks;
      flags[kind+"Intercepted"]=press();
      await waitUntil(()=>enqueued.length===before+1 && editor.value==="" &&
        !form.querySelector('.native-thumbnail-card'));
      flags[kind+"AttachmentCleaned"]=enqueued.length===before+1 &&
        enqueued.at(-1).images.length===1 && editor.value==="" &&
        !form.querySelector('.native-thumbnail-card') && nativeRemoveClicks===clicks+1 && sent===0;
      await wait(100);
    }

    editor.value="多图删除时正文不变的程序事件";
    choose([make("reset-first.png"),make("reset-second.png")]);
    let resetInputs=0;
    for(const chip of form.querySelectorAll('[data-testid="file-chip"]')){
      chip.querySelector("button").onclick=()=>{
        chip.remove();resetInputs++;
        editor.dispatchEvent(new InputEvent("input",{bubbles:true,inputType:"deleteContentBackward"}));
      };
    }
    const beforeReset=enqueued.length;
    press();
    await waitUntil(()=>enqueued.length===beforeReset+1 && editor.value==="" &&
      !form.querySelector('[data-testid="file-chip"]'));
    flags.unchangedInputDoesNotAbortMultiImageCleanup=resetInputs===2 &&
      enqueued.length===beforeReset+1 && enqueued.at(-1).images.length===2 &&
      !form.querySelector('[data-testid="file-chip"]') && editor.value==="" && sent===0;

    await wait(160);
    editor.value="附件清理期间的真实编辑必须保留";
    choose([make("edit-first.png"),make("edit-second.png")]);
    const editChips=[...form.querySelectorAll('[data-testid="file-chip"]')];
    editChips[0].querySelector("button").onclick=()=>{
      editChips[0].remove();
      // beforeinput is deliberately never exempted, even for a synthetic
      // event that leaves the original text identical (trusted edits too).
      editor.dispatchEvent(new InputEvent("beforeinput",{bubbles:true,
        cancelable:true,inputType:"insertText",data:""}));
    };
    const beforeEdit=enqueued.length;
    press();
    await waitUntil(()=>enqueued.length===beforeEdit+1);
    await wait(240);
    flags.beforeInputPreservesRemainingAttachment=enqueued.length===beforeEdit+1 &&
      editor.value==="附件清理期间的真实编辑必须保留" &&
      form.querySelectorAll('[data-testid="file-chip"]').length===1 && sent===0;
    form.querySelectorAll('[data-testid="file-chip"]').forEach(chip=>chip.remove());

    editor.value="清理前已保存的正文";
    chooseThumbnail(make("private-edit.png"),"title");
    const privateCard=form.querySelector('.native-thumbnail-card');
    privateCard.querySelector("button").onclick=()=>{
      privateCard.remove();editor.value="清理期间用户写入的新草稿";
      editor.dispatchEvent(new InputEvent("input",{bubbles:true,inputType:"insertText"}));
    };
    const beforePrivate=enqueued.length;
    press();
    await waitUntil(()=>enqueued.length===beforePrivate+1);
    await wait(240);
    flags.changedTextDuringCleanupPreserved=editor.value==="清理期间用户写入的新草稿" &&
      enqueued.at(-1).text==="清理前已保存的正文" && sent===0;

    editor.value="禁用删除按钮时正文和请求ID都要保留";
    chooseThumbnail(make("disabled-remove.png"),"disabled");
    const disabledRemove=form.querySelector('.native-thumbnail-card button');
    const beforeDisabled=enqueued.length,beforeDisabledTasks=state.tasks.length,clicks=nativeRemoveClicks;
    press();
    await waitUntil(()=>enqueued.length===beforeDisabled+1);
    await wait(240);
    flags.disabledRemovePreservesWholeDraft=nativeRemoveClicks===clicks &&
      editor.value==="禁用删除按钮时正文和请求ID都要保留" && disabledRemove.isConnected;
    const savedRequest=enqueued.at(-1).requestId;
    disabledRemove.disabled=false;
    press();
    await waitUntil(()=>enqueued.length===beforeDisabled+2 && editor.value==="" &&
      !form.querySelector('.native-thumbnail-card'));
    flags.cleanupRetryReusesPersistedRequest=enqueued.length===beforeDisabled+2 &&
      enqueued.at(-1).requestId===savedRequest && state.tasks.length===beforeDisabledTasks+1 &&
      nativeRemoveClicks===clicks+1 && editor.value==="" && sent===0;
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
    "nativeSaveWasDeferred","changedNativeDraftPreserved",
    "thumbnailEnterBlocked","thumbnailRemovedAfterQueue",
    "iconEnterBlocked","iconThumbnailRemoved",
    "unknownEnterBlocked","unknownActionPreserved",
    "groupEnterBlocked","sharedGroupProtected",
    "foreignFileEnterIntercepted","foreignFileDidNotPoisonComposer",
    "sameTextEnterIntercepted","sameTextAfterSavePreserved",
    "composerSwapEnterIntercepted","swappedEditorsBothPreserved",
    "hoverIntercepted","hoverAttachmentCleaned","closeIntercepted","closeAttachmentCleaned",
    "close-zhIntercepted","close-zhAttachmentCleaned","svg-xIntercepted","svg-xAttachmentCleaned",
    "unchangedInputDoesNotAbortMultiImageCleanup","beforeInputPreservesRemainingAttachment",
    "changedTextDuringCleanupPreserved","disabledRemovePreservesWholeDraft",
    "cleanupRetryReusesPersistedRequest"]
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
