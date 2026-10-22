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

test("真实 Chrome DOM：版本更新刷新前保护文字、附件、插件草稿与生成中回复", {
  skip: !fs.existsSync(browser) && "Chrome is not installed",
}, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cq-update-dom-"));
  try {
    const source=fs.readFileSync(path.join(__dirname,"..","background.js"),"utf8");
    const start=source.indexOf("function inspectUpdateRefreshSafety() {");
    const end=source.indexOf("\nasync function inspectUpdateTab(",start);
    assert.ok(start>=0 && end>start,"Missing isolated update-safety inspector");
    const inspect=source.slice(start,end);
    fs.writeFileSync(path.join(dir,"index.html"), `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"></head><body>
<main><form id="native"><textarea id="prompt-textarea"></textarea>
  <button type="button" id="voice" data-testid="voice-mode-button"
    aria-label="Start Voice">语音模式</button>
</form></main>
<div id="cq-extension-root"></div>
<script>
@INSPECT@
const probe=inspectUpdateRefreshSafety;
setTimeout(() => {
  const flags={};
  try {
    const form=document.querySelector("#native");
    const editor=document.querySelector("#prompt-textarea");
    const voice=document.querySelector("#voice");
    const root=document.querySelector("#cq-extension-root");
    flags.idle=probe().safe && probe().voiceReady;
    root.setAttribute("data-cq-unsaved-draft","true");
    flags.hiddenDraftProtected=probe().reason==="plugin_hidden_unsaved_draft";
    root.removeAttribute("data-cq-unsaved-draft");
    flags.hiddenDraftCleared=probe().safe;
    // The panel can be detached during a native composer transition; the
    // document-level marker must still block an extension-update reload.
    root.remove();
    document.documentElement.dataset.cqUnsavedDraft="true";
    flags.detachedPanelDraftProtected=probe().reason==="plugin_hidden_unsaved_draft";
    document.documentElement.removeAttribute("data-cq-unsaved-draft");
    document.body.append(root);
    editor.value="我还没发送的草稿";
    flags.textProtected=probe().reason==="unsent_text";
    editor.value="";

    const chip=document.createElement("div");
    chip.setAttribute("data-testid","file-chip");
    chip.textContent="已选截图";
    form.appendChild(chip);
    flags.attachmentProtected=probe().reason==="attachments_or_upload";
    chip.remove();

    const fileInput=document.createElement("input");
    fileInput.type="file";
    form.appendChild(fileInput);
    const data=new DataTransfer();
    data.items.add(new File(["img"],"image.png",{type:"image/png"}));
    fileInput.files=data.files;
    flags.fileInputProtected=probe().reason==="attachments_or_upload";
    fileInput.remove();

    const uploading=document.createElement("div");
    uploading.setAttribute("data-testid","upload-progress");
    form.appendChild(uploading);
    flags.uploadProtected=probe().reason==="attachments_or_upload";
    uploading.remove();

    for(const id of ["cq-queue-draft","cq-schedule-draft","cq-edit-task-input"]) {
      const draft=document.createElement("textarea");
      draft.id=id;
      draft.value="还未入队的私有草稿";
      root.appendChild(draft);
      flags[id]=probe().reason==="plugin_draft";
      draft.remove();
    }
    const imageZone=document.createElement("div");
    imageZone.setAttribute("data-image-zone","queue");
    imageZone.innerHTML='<div class="cq-images"><img src="data:image/png;base64,YWJj"></div>';
    root.appendChild(imageZone);
    flags.imageOnlyPluginDraftProtected=probe().reason==="plugin_draft_image";
    imageZone.remove();

    const unsaved=document.createElement("input");
    unsaved.type="number";
    unsaved.defaultValue="100";
    unsaved.value="20";
    root.appendChild(unsaved);
    flags.unsavedNumericProtected=probe().reason==="plugin_unsaved_changes";
    unsaved.remove();

    const toggle=document.createElement("input");
    toggle.type="checkbox";
    toggle.checked=true;
    root.appendChild(toggle);
    flags.unsavedToggleProtected=probe().reason==="plugin_unsaved_changes";
    toggle.remove();

    const selection=document.createElement("select");
    selection.innerHTML='<option value="time">时间</option><option value="count">数量</option>';
    root.appendChild(selection);
    flags.untouchedSelectDoesNotBlock=probe().safe;
    selection.value="count";
    flags.changedSelectProtected=probe().reason==="plugin_unsaved_changes";
    selection.remove();

    const stop=document.createElement("button");
    stop.setAttribute("data-testid","stop-button");
    stop.textContent="停止生成";
    form.appendChild(stop);
    flags.generatingProtected=probe().reason==="generating";
    stop.remove();
    stop.style.opacity="0";
    form.append(stop);
    flags.transparentStopIgnored=probe().safe && probe().voiceReady;
    stop.remove();
    stop.style.opacity="";
    stop.style.pointerEvents="none";
    form.append(stop);
    flags.unclickableStopStillBusy=probe().reason==="generating";
    stop.remove();
    stop.style.pointerEvents="";
    const foreignForm=document.createElement("form");
    foreignForm.innerHTML='<button type="button" data-testid="stop-button" aria-label="Stop generating"></button>'+
      '<button type="button" aria-label="Start Voice"></button>';
    document.querySelector("main").prepend(foreignForm);
    flags.otherFormStopIgnored=probe().safe;
    voice.style.visibility="hidden";
    flags.otherFormVoiceIgnored=probe().safe && !probe().voiceReady;
    voice.style.visibility="";
    foreignForm.remove();
    voice.style.opacity="0";
    flags.transparentVoiceNotReady=probe().safe && !probe().voiceReady;
    voice.style.opacity="";
    voice.style.pointerEvents="none";
    flags.unclickableVoiceNotReady=probe().safe && !probe().voiceReady;
    voice.style.pointerEvents="";
    form.style.opacity="0";
    flags.transparentComposerNotReady=probe().reason==="composer_not_ready";
    form.style.opacity="";
    const message=document.createElement("section");
    message.setAttribute("data-message-author-role","assistant");
    message.innerHTML='<button type="button" data-testid="stop-button"></button>';
    document.querySelector("main").prepend(message);
    flags.messageStopIgnored=probe().safe;
    message.remove();

    voice.setAttribute("data-testid","microphone-button");
    voice.setAttribute("aria-label","Start dictation");
    const withMic=probe();
    flags.micNotVoice=withMic.safe && !withMic.voiceReady;
    voice.setAttribute("data-testid","voice-mode-button");
    voice.setAttribute("aria-label","Start Voice");

    const extensionInput=document.createElement("textarea");
    root.appendChild(extensionInput);
    const removed=form.removeChild(editor);
    const writingBlock=document.createElement("div");
    writingBlock.setAttribute("data-testid","writing-block-editor");
    writingBlock.innerHTML='<form><div id="prompt-textarea" contenteditable="true">写作块中的正文</div></form>';
    document.querySelector("main").prepend(writingBlock);
    const noEditor=probe();
    flags.noComposerProtected=!noEditor.safe &&
      noEditor.reason==="composer_not_ready";
    flags.writingBlockNotComposer=noEditor.reason==="composer_not_ready";

    const markdownEditor=document.createElement("div");
    markdownEditor.setAttribute("data-composer-markdown","");
    markdownEditor.setAttribute("role","textbox");
    markdownEditor.setAttribute("contenteditable","true");
    markdownEditor.className="ProseMirror";
    markdownEditor.innerHTML='<p data-empty-paragraph="true" data-placeholder="询问 ChatGPT"><br></p>';
    form.setAttribute("data-chatgpt-composer","");
    form.setAttribute("data-composer-placement","thread");
    form.setAttribute("data-thread-find-composer","true");
    form.prepend(markdownEditor);
    voice.removeAttribute("data-testid");
    voice.setAttribute("aria-label","开始语音");
    flags.markdownComposerIdle=probe().safe && probe().voiceReady;
    voice.style.visibility="hidden";
    flags.invisibleVoiceNotReady=probe().safe && !probe().voiceReady;
    voice.style.visibility="";
    voice.setAttribute("aria-hidden","true");
    flags.ariaHiddenVoiceNotReady=probe().safe && !probe().voiceReady;
    voice.removeAttribute("aria-hidden");
    markdownEditor.textContent="新布局里的未发送草稿";
    flags.markdownDraftProtected=probe().reason==="unsent_text";
    const ghost=document.createElement("form");
    ghost.innerHTML='<div data-composer-markdown role="textbox" contenteditable="true"></div>';
    form.before(ghost);
    ghost.setAttribute("aria-hidden","true");
    flags.ariaHiddenGhostCannotEraseDraft=probe().reason==="unsent_text";
    ghost.removeAttribute("aria-hidden");
    ghost.style.visibility="hidden";
    flags.invisibleGhostCannotEraseDraft=probe().reason==="unsent_text";
    ghost.remove();
    markdownEditor.remove();
    flags.writingBlockStillNotComposer=probe().reason==="composer_not_ready";
    writingBlock.remove();
    form.removeAttribute("data-chatgpt-composer");
    form.removeAttribute("data-composer-placement");
    form.removeAttribute("data-thread-find-composer");
    voice.setAttribute("data-testid","voice-mode-button");
    voice.setAttribute("aria-label","Start Voice");
    form.appendChild(removed);
    extensionInput.remove();
    flags.recoveredIdle=probe().safe && probe().voiceReady;
  } catch(error) {flags.error=error.stack || error.message;}
  flags.ok=["idle","hiddenDraftProtected","hiddenDraftCleared",
    "detachedPanelDraftProtected","otherFormStopIgnored","otherFormVoiceIgnored",
    "transparentStopIgnored","unclickableStopStillBusy",
    "transparentVoiceNotReady","unclickableVoiceNotReady",
    "transparentComposerNotReady",
    "messageStopIgnored",
    "textProtected","attachmentProtected",
    "fileInputProtected","uploadProtected","cq-queue-draft",
    "cq-schedule-draft","cq-edit-task-input",
    "imageOnlyPluginDraftProtected","unsavedNumericProtected",
    "unsavedToggleProtected","untouchedSelectDoesNotBlock",
    "changedSelectProtected","generatingProtected",
    "micNotVoice","noComposerProtected","writingBlockNotComposer",
    "markdownComposerIdle","invisibleVoiceNotReady","ariaHiddenVoiceNotReady",
    "markdownDraftProtected", "ariaHiddenGhostCannotEraseDraft",
    "invisibleGhostCannotEraseDraft", "writingBlockStillNotComposer",
    "recoveredIdle"]
    .every(key => flags[key]===true);
  document.body.dataset.update=JSON.stringify(flags);
},100);
</script></body></html>`.replace("@INSPECT@",inspect));
    const run=spawnSync(browser,[
      "--headless=new","--disable-gpu","--disable-extensions","--no-first-run",
      `--user-data-dir=${path.join(dir,"profile")}`,
      "--virtual-time-budget=1600","--dump-dom",
      `file:///${path.join(dir,"index.html").replace(/\\/g,"/")}`,
    ],{encoding:"utf8",timeout:21000,maxBuffer:7e6});
    assert.equal(run.status,0,run.stderr || "Chrome failed");
    const match=run.stdout.match(/data-update="([^"]+)"/);
    assert.ok(match,"Chrome did not run extension update-safety probe");
    const flags=JSON.parse(match[1].replace(/&quot;/g,'"'));
    assert.equal(flags.ok,true,JSON.stringify(flags));
  } finally {
    fs.rmSync(dir,{recursive:true,force:true});
  }
});
