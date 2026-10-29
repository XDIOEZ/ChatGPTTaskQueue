"use strict";

const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const os=require("node:os");
const {spawnSync}=require("node:child_process");

const browser=process.env.CQ_BROWSER_BIN || (process.platform==="win32"
  ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" : "/usr/bin/google-chrome");

test("原生附件原图不匹配：仅数据安全时自动刷新、限制重复刷新，并支持原图严格找回",{
  skip:!fs.existsSync(browser) && "Chrome is not installed",
},()=>{
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),"cq-native-mismatch-refresh-"));
  try {
    let source=fs.readFileSync(path.join(__dirname,"..","content.js"),"utf8");
    source=source.replace("  function boundHere() {",
      "  function boundHere() { return true; }\n  function unusedBoundHere() {");
    const reload=/  function reloadConversationErrorPage\(\) \{\r?\n    location\.reload\(\);\r?\n  \}/;
    assert.match(source,reload,"reload guard changed");
    source=source.replace(reload,'  function reloadConversationErrorPage() { window.__reloadCalls++; }');
    const start=/  void init\(\);\r?\n\}\)\(\);/;
    assert.match(source,start);
    source=source.replace(start,[
      "  window.__imageRefreshProbe={tick:maybeReloadNativeImageMismatch,",
      "    safe:nativeImageRecoverySafe,hasIssue:()=>!!nativeImageMismatch};",
      "  void init();","})();",
    ].join("\n"));
    fs.writeFileSync(path.join(folder,"content.js"),source);
    fs.copyFileSync(path.join(__dirname,"..","panel.css"),path.join(folder,"panel.css"));
    fs.writeFileSync(path.join(folder,"index.html"),`<!doctype html>
<html><head><meta charset="utf-8"><link rel="stylesheet" href="panel.css"></head><body>
<main><form id="composer"><textarea id="prompt-textarea"></textarea>
<input id="image-picker" type="file" accept="image/png" multiple>
<button type="button" id="native-send" aria-label="Send" data-testid="send-button">↑</button>
</form></main>
<script>
window.__reloadCalls=0;
const editor=document.querySelector("#prompt-textarea"),form=document.querySelector("#composer");
const picker=document.querySelector("#image-picker");
const enqueued=[];
const state={key:"draft:1",tasks:[],schedules:[],activeTaskId:null,steeringTaskId:null,
  halted:false,queuePaused:false};
window.chrome={runtime:{getManifest(){return {version:"0.99.0"};},
  onMessage:{addListener(){}},
  async sendMessage(request){
    if(request.type==="ENQUEUE") enqueued.push(request);
    return {ok:true,state,sessionKey:"draft:1",settings:{maxPending:100}};
  }},storage:{onChanged:{addListener(){}}}};
function orphan(name){
  const chip=document.createElement("div");
  chip.setAttribute("data-testid","file-chip");
  chip.textContent=name;
  const remove=document.createElement("button");
  remove.type="button";remove.setAttribute("aria-label","Remove attachment");
  remove.textContent="×";remove.onclick=()=>chip.remove();
  chip.append(remove);form.append(chip);return chip;
}
function clickQueueButton(){
  const button=document.querySelector('[data-action="queue-composer"]');
  if(!button)throw new Error("missing native composer queue button");
  button.click();
  return true;
}
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
</script>
<script src="content.js"></script><script>
setTimeout(async()=>{
  const flags={};
  try{
    editor.value="需要保护的截图草稿";
    const chip=orphan("unknown.png");
    flags.mismatchIntercepted=clickQueueButton();
    await wait(120);
    const probe=window.__imageRefreshProbe;
    flags.unmatchedIssueCreated=probe.hasIssue() && enqueued.length===0 &&
      document.querySelector(".cq-native-image-recovery")?.textContent.includes("图片");
    const later=Date.now()+61000;
    probe.tick(later);
    flags.attachmentKeepsDraft=window.__reloadCalls===0 &&
      editor.value==="需要保护的截图草稿" && chip.isConnected;
    chip.remove();
    probe.tick(later);
    flags.textKeepsDraft=window.__reloadCalls===0 && !!editor.value;
    editor.value="";
    state.activeTaskId="another-in-flight";
    probe.tick(later);
    flags.activeQueuePreventsReload=window.__reloadCalls===0;
    state.activeTaskId=null;
    probe.tick(later);
    flags.safeReloadOnce=window.__reloadCalls===1;
    probe.tick(later+120000);
    flags.noRepeatRefresh=window.__reloadCalls===1;

    // A route change must never carry the old refresh request to a new chat.
    history.pushState({},"","?new-chat");
    probe.tick(later+120001);
    flags.routeChangeClearsIssue=!probe.hasIssue();

    // A native input with unchanged FileList and an exact named chip may
    // reconstruct the original File safely; a bare thumbnail cannot.
    const png=Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lSkAAAAASUVORK5CYII="),
      c=>c.charCodeAt(0));
    const file=new File([png],"recover.png",{type:"image/png"});
    const transfer=new DataTransfer();transfer.items.add(file);
    picker.files=transfer.files; // Deliberately no change event
    const recovered=orphan("recover.png");
    editor.value="严格对应的图片";
    const before=enqueued.length;
    flags.nativeInputIntercepted=clickQueueButton();
    await wait(250);
    flags.nativeInputRecovered=enqueued.length===before+1 &&
      enqueued.at(-1).images.length===1 &&
      enqueued.at(-1).images[0].name==="recover.png" && !probe.hasIssue();
    recovered.remove();
  }catch(error){flags.error=error.stack||String(error);}
  flags.ok=["mismatchIntercepted","unmatchedIssueCreated","attachmentKeepsDraft",
    "textKeepsDraft","activeQueuePreventsReload","safeReloadOnce",
    "noRepeatRefresh","routeChangeClearsIssue","nativeInputIntercepted",
    "nativeInputRecovered"].every(key=>flags[key]===true);
  document.body.dataset.result=JSON.stringify(flags);
},250);
</script></body></html>`);
    const run=spawnSync(browser,[
      "--headless=new","--disable-gpu","--disable-extensions","--no-first-run",
      `--user-data-dir=${path.join(folder,"profile")}`,
      "--virtual-time-budget=9500","--dump-dom",
      `file:///${path.join(folder,"index.html").replace(/\\/g,"/")}`,
    ],{encoding:"utf8",timeout:30000,maxBuffer:10e6});
    assert.equal(run.status,0,run.stderr||"Chrome did not start");
    const match=run.stdout.match(/data-result="([^"]+)"/);
    assert.ok(match,"Chrome did not complete native-image recovery checks");
    const flags=JSON.parse(match[1].replace(/&quot;/g,'"').replace(/&amp;/g,"&"));
    assert.equal(flags.ok,true,JSON.stringify(flags,null,2));
  }finally{
    fs.rmSync(folder,{recursive:true,force:true,maxRetries:8,retryDelay:250});
  }
});
