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

test("真实浏览器：写作块及弹窗不能捕获队列，原生输入框消失时脱离并在恢复后重新挂载", {
  skip:!fs.existsSync(browser) && "Chrome is not installed",
}, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),"cq-composer-capture-"));
  try {
    const source = fs.readFileSync(path.join(__dirname,"..","content.js"),"utf8")
      .replace("  function boundHere() {",
        "  function boundHere() { return true; }\n  function unusedOriginalBoundHere() {")
      .replace("  void init();", "  window.__cqComposerProbe={editor:getEditor,text:editorText,normalize,controls,steer:steerQueuedTask,mount:mountNearComposer,isStop:isNativeStopButton,busy:nativeGenerationRunning};\n  void init();");
    fs.writeFileSync(path.join(dir,"content.js"),source);
    fs.copyFileSync(path.join(__dirname,"..","panel.css"),path.join(dir,"panel.css"));
    fs.writeFileSync(path.join(dir,"index.html"),`<!doctype html><html lang="zh">
<head><meta charset="utf-8"><link rel="stylesheet" href="panel.css"></head>
<body><main id="chat">
  <section data-testid="conversation-turn-2" data-message-author-role="assistant">
    <div class="markdown">
      <div data-testid="writing-block">
        <div id="prompt-textarea" contenteditable="true">写作块中的假输入框</div>
        <form id="message-form"><textarea data-testid="composer-input">编辑回复</textarea>
          <button type="button" data-testid="send-button">伪发送</button>
        </form>
      </div>
    </div>
  </section>
  <div role="dialog" id="foreign-dialog">
    <form><textarea data-testid="prompt-textarea">弹窗编辑</textarea>
      <button type="button" data-testid="send-button">弹窗发送</button>
    </form>
  </div>
  <form id="chat-form">
    <div data-testid="composer-input" contenteditable="false" data-placeholder="询问 ChatGPT"></div>
    <button type="button" data-testid="send-button" aria-label="Send">发送</button>
    <button type="button" aria-label="Start Voice">语音</button>
  </form>
</main>
<script>
const state={key:"draft:1",halted:false,queuePaused:false,
  activeTaskId:null,steeringTaskId:null,tasks:[],schedules:[],
  countRateTimes:[],history:[],autoOpenTab:false};
const requests=[];
let invalidateExtension=false;
window.chrome={
 runtime:{getManifest(){return {version:"0.49.12"};},
  onMessage:{addListener(){}},
  async sendMessage(message){
    if(invalidateExtension)throw new Error("Extension context invalidated.");
    requests.push(message.type);
    if(message.type==="GET_FAVORITES")return {ok:true,favorites:[]};
    return {ok:true,state,sessionKey:"draft:1",settings:{maxPending:100}};
  }},
 storage:{onChanged:{addListener(){}}},
};
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const until=async fn=>{for(let i=0;i<90;i++){if(fn())return true;await delay(60);}return !!fn();};
const panel=()=>document.querySelector("#cq-extension-root");
const inMainComposer=()=>panel()?.nextElementSibling?.id==="chat-form";
</script>
<script src="content.js"></script>
<script>
setTimeout(async()=>{
 const result={};
 try{
  result.mainOnly=await until(inMainComposer) && !document.querySelector(
    "[data-testid='writing-block'] #cq-extension-root, #foreign-dialog #cq-extension-root");
  result.emptyEditorVisible=inMainComposer() &&
    document.querySelector("#chat-form [data-testid='composer-input']").textContent==="";
  const native=document.querySelector("#chat-form [data-testid='composer-input']");
  native.setAttribute("contenteditable","true");
  native.textContent="输入内容";
  await delay(1450);
  result.typedStillVisible=inMainComposer();
  native.textContent="";
  native.setAttribute("contenteditable","false");
  await delay(1450);
  result.clearedStillVisible=inMainComposer();
  // New ChatGPT layouts can leave only a placeholder and a voice button.
  native.removeAttribute("data-testid");
  document.querySelector('#chat-form [data-testid="send-button"]').remove();
  await delay(1450);
  result.unlabelledEmptyVisible=inMainComposer();
  // Clicking the placeholder is still an interaction with the native
  // composer, even before contenteditable is enabled. It must not fold UI.
  const emptyClick=new MouseEvent("click",{bubbles:true,button:0,detail:1});
  native.dispatchEvent(emptyClick);
  result.emptyComposerClickKeepsPanel=panel()?.querySelector(
    '[data-action="toggle-queue"]')?.getAttribute("aria-label")==="收起队列";
  if(!result.emptyComposerClickKeepsPanel)panel()?.querySelector(
    '[data-action="toggle-queue"]')?.click();
  // A stale editor can be display:none while its form and Voice remain
  // visible. The placeholder-only live composer must retain the panel.
  const stale=document.createElement("form");
  stale.innerHTML='<div data-composer-markdown role="textbox" contenteditable="true" style="display:none"></div>'+
    '<button aria-label="Start Voice" type="button"></button>';
  document.querySelector("#chat-form").before(stale);
  result.hiddenEditorVisibleFormIgnored=window.__cqComposerProbe.mount()&&inMainComposer();
  stale.remove();
  const fake=document.querySelector('[data-testid="writing-block"] [contenteditable]');
  const before=requests.filter(type=>type==="ENQUEUE").length;
  const event=new KeyboardEvent("keydown",{key:"Enter",bubbles:true,cancelable:true});
  fake.dispatchEvent(event);
  result.foreignEditorUnaffected=!event.defaultPrevented &&
    requests.filter(type=>type==="ENQUEUE").length===before;
  const form=document.querySelector("#chat-form");
  form.remove();
  result.detached=await until(()=>!panel());
  const orphan=new KeyboardEvent("keydown",{key:"Enter",bubbles:true,cancelable:true});
  fake.dispatchEvent(orphan);
  result.noForeignFallback=!orphan.defaultPrevented;
  const decoy=document.createElement("form");
  decoy.innerHTML='<div contenteditable="true">无关的富文本编辑器</div>'+
    '<button type="button" aria-label="Start Voice" style="opacity:0"></button>';
  document.querySelector("#chat").append(decoy);
  result.hiddenActionDoesNotCapture=!window.__cqComposerProbe.editor() &&
    !window.__cqComposerProbe.mount() && !panel();
  decoy.remove();
  document.querySelector("#chat").append(form);
  result.restored=await until(inMainComposer);
  // If the main composer is moved into a message, do not follow it there.
  document.querySelector('[data-testid="writing-block"]').append(form);
  result.rejectedMessageComposer=await until(()=>!panel());
  document.querySelector("#chat").append(form);
  result.recoveredAgain=await until(inMainComposer);
  const probe=window.__cqComposerProbe;
  native.setAttribute("contenteditable","true");
  native.setAttribute("data-composer-markdown","");
  native.setAttribute("role","textbox");
  const ghost=document.createElement("form");
  ghost.id="hidden-chat-composer";
  ghost.innerHTML='<div data-composer-markdown role="textbox" contenteditable="true"></div>'+
    '<button aria-label="Start Voice" type="button"></button>';
  form.before(ghost);
  ghost.style.visibility="hidden";
  result.invisibleComposerIgnored=probe.mount()&&inMainComposer()&&probe.editor()===native;
  ghost.style.visibility="";
  ghost.setAttribute("aria-hidden","true");
  result.ariaHiddenComposerIgnored=probe.mount()&&inMainComposer()&&probe.editor()===native;
  ghost.removeAttribute("aria-hidden");
  ghost.style.opacity="0";
  result.transparentComposerIgnored=probe.mount()&&inMainComposer()&&probe.editor()===native;
  ghost.remove();
  probe.mount();
  // Match the current native DOM: no legacy id/testid, a hidden twin editor,
  // an empty ProseMirror paragraph, and localized buttons without testids.
  form.setAttribute("data-chatgpt-composer","");
  native.setAttribute("contenteditable","true");
  native.setAttribute("data-composer-markdown","");
  native.setAttribute("role","textbox");
  native.innerHTML='<p data-empty-paragraph="true" data-placeholder="询问 ChatGPT"><br class="ProseMirror-trailingBreak"></p>';
  const voice=form.querySelector('[aria-label="Start Voice"]');
  voice.setAttribute("aria-label","开始语音");
  const hiddenTwin=native.cloneNode(true);
  hiddenTwin.style.display="none";
  form.prepend(hiddenTwin);
  result.currentLayoutRecognized=probe.editor()===native &&
    probe.normalize(probe.text(native))==="" && probe.controls().voice===voice;
  voice.style.visibility="hidden";
  result.invisibleVoiceIgnored=!probe.controls().voice;
  voice.style.visibility="";
  voice.setAttribute("aria-hidden","true");
  result.ariaHiddenVoiceIgnored=!probe.controls().voice;
  voice.removeAttribute("aria-hidden");
  voice.style.opacity="0";
  result.transparentVoiceIgnored=!probe.controls().voice;
  voice.style.opacity="";
  voice.style.pointerEvents="none";
  result.unclickableVoiceIgnored=!probe.controls().voice;
  voice.style.pointerEvents="";
  voice.style.visibility="hidden";
  const foreignVoice=document.createElement("button");
  foreignVoice.type="button";
  foreignVoice.setAttribute("aria-label","Start Voice");
  document.querySelector("#foreign-dialog form").append(foreignVoice);
  result.foreignVoiceIgnored=!probe.controls().voice;
  foreignVoice.remove();
  voice.style.visibility="";
  form.style.opacity="0";
  result.transparentParentDetaches=!probe.mount()&&!panel()&&!probe.editor();
  form.style.opacity="";
  result.transparentParentRestores=probe.mount()&&inMainComposer()&&probe.editor()===native;
  // The primary action can be a label-free square Stop SVG. The new editor
  // need not live in a legacy form or have data-chatgpt-composer.
  form.removeAttribute("data-chatgpt-composer");
  const iconStop=document.createElement("button");
  iconStop.type="button";
  iconStop.innerHTML='<svg class="icon-primary-action"><path d="M4.5 5.75C4.5 5.05964 5.05964 4.5 5.75 4.5H14.25"/></svg>';
  form.append(iconStop);
  result.iconOnlyStopRecognized=probe.controls().stop===iconStop &&
    probe.controls().send!==iconStop;
  iconStop.style.pointerEvents="none";
  result.unclickableStopStillBusy=probe.controls().stop===iconStop && probe.busy();
  iconStop.style.pointerEvents="";
  iconStop.remove();
  const unrelated=document.createElement("form");
  unrelated.innerHTML='<button type="button" data-testid="stop-button" aria-label="Stop generating"></button>';
  document.querySelector("#chat").prepend(unrelated);
  const unrelatedStop=unrelated.querySelector("button");
  result.otherFormStopIgnored=!probe.isStop(unrelatedStop) &&
    !probe.controls().stop && !probe.busy();
  unrelated.remove();
  const messageStop=document.createElement("button");
  messageStop.setAttribute("data-testid","stop-button");
  document.querySelector('[data-message-author-role="assistant"]').append(messageStop);
  result.messageStopIgnored=!probe.isStop(messageStop) && !probe.controls().stop;
  messageStop.remove();
  const floatingStop=document.createElement("button");
  floatingStop.setAttribute("data-testid","stop-button");
  document.querySelector("#chat").append(floatingStop);
  result.nativeFloatingStopRecognized=probe.controls().stop===floatingStop;
  floatingStop.remove();
  form.setAttribute("data-chatgpt-composer","");
  native.removeAttribute("data-composer-markdown");
  result.localizedFallbackRecognized=probe.editor()===native;
  native.setAttribute("data-composer-markdown","");
  state.tasks.push({id:"draft-protection",text:"排队任务",status:"pending"});
  native.textContent="真正未发送的草稿";
  let draftError="";
  try{await probe.steer("draft-protection");}catch(error){draftError=error.message;}
  result.realDraftProtected=draftError.includes("有未发送的内容") &&
    native.textContent==="真正未发送的草稿" && !requests.includes("STEER_CLAIM");
  form.remove();
  let missingError="";
  try{await probe.steer("draft-protection");}catch(error){missingError=error.message;}
  result.missingEditorExplained=missingError.includes("未识别到") &&
    !missingError.includes("有未发送的内容");
  native.textContent="";
  document.querySelector("#chat").append(form);
  hiddenTwin.remove();
  invalidateExtension=true;
  panel().querySelector('[data-action="toggle-queue-paused"]').click();
  result.staleContextNotice=await until(()=>panel()?.textContent.includes("请刷新 ChatGPT 页面") &&
    !panel()?.textContent.includes("Extension context invalidated."));
  const queuedBefore=requests.filter(type=>type==="ENQUEUE").length;
  native.setAttribute("contenteditable","true");
  native.textContent="保留的输入草稿";
  const staleEnter=new KeyboardEvent("keydown",{key:"Enter",bubbles:true,cancelable:true});
  native.dispatchEvent(staleEnter);
  result.staleContextSafe=!staleEnter.defaultPrevented &&
    native.textContent==="保留的输入草稿" &&
    requests.filter(type=>type==="ENQUEUE").length===queuedBefore;
 }catch(error){result.error=error.stack||String(error);}
 result.ok=["mainOnly","emptyEditorVisible","typedStillVisible",
   "clearedStillVisible","unlabelledEmptyVisible","emptyComposerClickKeepsPanel",
   "hiddenEditorVisibleFormIgnored","otherFormStopIgnored","messageStopIgnored",
   "nativeFloatingStopRecognized","foreignVoiceIgnored",
   "invisibleComposerIgnored","ariaHiddenComposerIgnored","transparentComposerIgnored",
   "transparentVoiceIgnored","unclickableVoiceIgnored",
   "transparentParentDetaches","transparentParentRestores","iconOnlyStopRecognized",
   "unclickableStopStillBusy",
   "invisibleVoiceIgnored","ariaHiddenVoiceIgnored",
   "foreignEditorUnaffected","detached","hiddenActionDoesNotCapture",
   "noForeignFallback","restored","rejectedMessageComposer","recoveredAgain",
   "currentLayoutRecognized","localizedFallbackRecognized","realDraftProtected",
   "missingEditorExplained","staleContextNotice","staleContextSafe"]
   .every(key=>result[key]===true);
 document.body.dataset.captureTest=JSON.stringify(result);
},250);
</script></body></html>`);
    const run = spawnSync(browser,[
      "--headless=new","--disable-gpu","--disable-extensions","--no-first-run",
      "--window-size=1100,850",`--user-data-dir=${path.join(dir,"profile")}`,
      "--virtual-time-budget=22000","--dump-dom",
      `file:///${path.join(dir,"index.html").replace(/\\/g,"/")}`,
    ],{encoding:"utf8",timeout:30000,maxBuffer:10e6});
    assert.equal(run.status,0,run.stderr||"Chrome failed");
    const match = run.stdout.match(/data-capture-test="([^"]+)"/);
    assert.ok(match,"Chrome did not complete the composer capture test");
    const result = JSON.parse(match[1].replace(/&quot;/g,'"').replace(/&amp;/g,"&"));
    assert.equal(result.ok,true,JSON.stringify(result,null,2));
  } finally {
    fs.rmSync(dir,{recursive:true,force:true,maxRetries:12,retryDelay:250});
  }
});
