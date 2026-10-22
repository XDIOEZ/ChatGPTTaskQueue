"use strict";

const {test} = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {spawnSync} = require("node:child_process");

const browser = process.env.CQ_BROWSER_BIN || (process.platform === "win32"
  ? "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"
  : "/usr/bin/google-chrome");

test("真实浏览器：点击原生发送前必须再次核对草稿、附件与输入框身份", {
  skip:!fs.existsSync(browser) && "Chromium not installed",
}, () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"cq-native-send-race-"));
  try {
    const source=fs.readFileSync(path.join(__dirname,"..","content.js"),"utf8")
      .replace("  function boundHere() {",
        "  function boundHere() { return true; }\n  function originalBoundHere() {")
      .replace("  void init();", "  window.__cqSendRace={sendTask,steerQueuedTask};\n  void init();");
    fs.writeFileSync(path.join(dir,"content.js"),source);
    fs.writeFileSync(path.join(dir,"index.html"),`<!doctype html><html lang="zh">
<head><meta charset="utf-8"></head><body><main>
<form id="composer"><textarea id="prompt-textarea"></textarea>
  <button id="send" type="button" data-testid="send-button" aria-label="Send" style="display:none">Send</button>
  <button id="voice" type="button" aria-label="Start Voice">Voice</button>
</form></main>
<script>
const state={key:"draft:1",activeTaskId:null,steeringTaskId:null,
  halted:false,queuePaused:true,tasks:[],schedules:[],history:[],countRateTimes:[]};
const calls=[],sent=[];
let form=document.getElementById("composer");
let editor=document.getElementById("prompt-textarea");
let send=document.getElementById("send");
let enableSend=false;
let deferSteerClicked=false;
let releaseSteerClicked=null;
editor.addEventListener("input",()=>{if(enableSend)send.style.display="";});
send.addEventListener("click",()=>{sent.push(editor.value);editor.value="";});
window.chrome={
 runtime:{getManifest(){return {version:"0.49.26"};},onMessage:{addListener(){}},
 async sendMessage(message){
   calls.push(message.type);
   const task=state.tasks.find(item=>item.id===message.id);
   if(message.type==="RELEASE_CLAIM"&&task){task.status="pending";state.activeTaskId=null;}
   if(message.type==="SENT"&&task){task.status="waiting";}
   if(message.type==="FAIL"){state.halted=true;}
   if(message.type==="STEER_CLAIM"&&task){
     task.status="steering";state.steeringTaskId=task.id;
     return {ok:true,state,sessionKey:"draft:1",dispatch:{id:task.id,text:task.text}};
   }
   if(message.type==="STEER_CANCEL"&&task){
     task.status="pending";state.steeringTaskId=null;
   }
   if(message.type==="STEER_CLICKED"&&task){
     task.status="steering_wait";
     if(deferSteerClicked)await new Promise(resolve=>{releaseSteerClicked=resolve;});
   }
   if(message.type==="STEER_UNCONFIRMED"&&task){task.status="error";state.halted=true;}
   if(message.type==="GET_FAVORITES")return {ok:true,favorites:[]};
   return {ok:true,state,sessionKey:"draft:1",settings:{maxPending:100}};
 }},
 storage:{onChanged:{addListener(){}}}
};
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const until=async f=>{for(let i=0;i<75;i++){if(f())return true;await wait(30);}return false;};
const claim=(id,text)=>{
  editor.value="";send.style.display="none";enableSend=false;
  state.halted=false;state.activeTaskId=id;
  state.tasks=[{id,text,status:"dispatching",images:[]}];
};
</script>
<script src="content.js"></script><script>
setTimeout(async()=>{
  const flags={};
  try{
    flags.ready=await until(()=>!!window.__cqSendRace);
    // ChatGPT often renders Send a few ticks after our injected text.
    claim("changed","原队列消息");
    const first=window.__cqSendRace.sendTask(state.tasks[0]);
    await wait(125);
    editor.value="用户正在写的新草稿";
    editor.dispatchEvent(new Event("input",{bubbles:true}));
    enableSend=true;send.style.display="";
    await first;
    flags.userDraftNotSent=sent.length===0&&!calls.includes("SENT");
    flags.userDraftPreserved=editor.value==="用户正在写的新草稿";
    flags.modifiedTaskReleased=calls.includes("RELEASE_CLAIM")&&
      state.tasks[0].status==="pending";

    // A user can attach a file while the native Send arrow hydrates.
    claim("attached","带保护的原队列消息");
    const second=window.__cqSendRace.sendTask(state.tasks[0]);
    await wait(125);
    const chip=document.createElement("span");
    chip.setAttribute("data-testid","file-chip");
    chip.textContent="用户选择的新截图";
    form.append(chip);
    enableSend=true;send.style.display="";
    await second;
    flags.unexpectedAttachmentNotSent=sent.length===0&&!calls.includes("SENT");
    flags.unexpectedAttachmentPreserved=chip.isConnected;
    chip.remove();

    // A route transition may replace the entire native form after insertion.
    claim("replaced","旧编辑框里的队列消息");
    const third=window.__cqSendRace.sendTask(state.tasks[0]);
    await wait(125);
    const newer=document.createElement("form");
    newer.innerHTML='<textarea id="prompt-textarea">新输入框的私人草稿</textarea>'+
      '<button data-testid="send-button" aria-label="Send" type="button">Send</button>'+
      '<button aria-label="Start Voice" type="button">Voice</button>';
    form.replaceWith(newer);
    const newEditor=newer.querySelector("textarea");
    newer.querySelector("button").addEventListener("click",()=>sent.push(newEditor.value));
    await third;
    flags.replacedEditorNotSent=sent.length===0&&!calls.includes("SENT");
    flags.replacedEditorDraftPreserved=newEditor.value==="新输入框的私人草稿";

    // A normal, unchanged queue message must still use native Send.
    form=newer;editor=newEditor;send=newer.querySelector("button");
    editor.value="";send.style.display="none";
    editor.addEventListener("input",()=>{if(enableSend)send.style.display="";});
    claim("valid","正确的队列消息");
    enableSend=true;
    const fourth=window.__cqSendRace.sendTask(state.tasks[0]);
    await fourth;
    flags.normalSendWorks=sent.length===1&&sent[0]==="正确的队列消息"&&
      calls.includes("SENT");
    if(!flags.normalSendWorks)flags.debugNormal={sent:[...sent],calls:[...calls].slice(-12),
      editorValue:editor.value,active:state.activeTaskId,halted:state.halted,
      sendDisplay:send.style.display};

    // Steer can wait for Send too. If a second composer appears first in
    // document order, it must not send the user's draft from that composer.
    editor.value="";send.style.display="none";enableSend=false;
    state.activeTaskId=null;state.steeringTaskId=null;state.halted=false;
    state.tasks=[{id:"steer-other",text:"要提前引导的队列消息",status:"pending"}];
    const sentBeforeSteer=sent.length;
    const clickedBeforeSteer=calls.filter(type=>type==="STEER_CLICKED").length;
    const fifth=window.__cqSendRace.steerQueuedTask("steer-other").catch(error=>error.message);
    await wait(125);
    const decoy=document.createElement("form");
    decoy.innerHTML='<textarea id="prompt-textarea">另一个输入框的私人草稿</textarea>'+
      '<button data-testid="send-button" aria-label="Send" type="button">Send</button>';
    form.before(decoy);
    const decoyEditor=decoy.querySelector("textarea");
    decoy.querySelector("button").addEventListener("click",()=>sent.push(decoyEditor.value));
    await fifth;
    flags.steerOtherComposerNotSent=sent.length===sentBeforeSteer&&
      calls.filter(type=>type==="STEER_CLICKED").length===clickedBeforeSteer;
    flags.steerOtherComposerDraftPreserved=decoyEditor.value==="另一个输入框的私人草稿";
    flags.steerOtherComposerReleased=state.tasks[0].status==="pending"&&
      state.steeringTaskId===null;
    decoy.remove();

    // Even retyping the same text is an edit by the user; no implicit Send.
    editor.value="";send.style.display="none";enableSend=false;
    state.activeTaskId=null;state.steeringTaskId=null;state.halted=false;
    state.tasks=[{id:"steer-same",text:"用户重新确认了相同内容",status:"pending"}];
    const sixth=window.__cqSendRace.steerQueuedTask("steer-same").catch(error=>error.message);
    await wait(125);
    editor.dispatchEvent(new InputEvent("input",{bubbles:true,inputType:"insertText",data:"相同内容"}));
    enableSend=true;send.style.display="";
    await sixth;
    flags.steerEditedSameTextNotSent=sent.length===sentBeforeSteer&&
      calls.filter(type=>type==="STEER_CLICKED").length===clickedBeforeSteer;
    flags.steerEditedSameTextDraftPreserved=editor.value==="用户重新确认了相同内容";
    flags.steerEditedSameTextReleased=state.tasks[0].status==="pending"&&
      state.steeringTaskId===null;

    // Persistence of STEER_CLICKED is async. A user edit *after* that lock
    // must still stop the native click and keep the record non-retryable.
    editor.value="";send.style.display="none";enableSend=true;
    state.activeTaskId=null;state.steeringTaskId=null;state.halted=false;
    state.tasks=[{id:"steer-ack",text:"确认锁即将落盘",status:"pending"}];
    deferSteerClicked=true;
    const seventh=window.__cqSendRace.steerQueuedTask("steer-ack").catch(error=>error.message);
    flags.steerAckPending=await until(()=>Boolean(releaseSteerClicked));
    editor.value="锁确认期间输入的新草稿";
    editor.dispatchEvent(new Event("input",{bubbles:true}));
    releaseSteerClicked?.();
    await seventh;
    flags.steerAckEditNotSent=sent.length===sentBeforeSteer;
    flags.steerAckEditDraftPreserved=editor.value==="锁确认期间输入的新草稿";
    flags.steerAckEditQuarantined=state.halted&&state.tasks[0].status==="error"&&
      calls.includes("STEER_UNCONFIRMED");
  }catch(error){flags.error=error.stack||String(error);}
  flags.ok=["ready","userDraftNotSent","userDraftPreserved","modifiedTaskReleased",
    "unexpectedAttachmentNotSent","unexpectedAttachmentPreserved",
    "replacedEditorNotSent","replacedEditorDraftPreserved","normalSendWorks",
    "steerOtherComposerNotSent","steerOtherComposerDraftPreserved",
    "steerOtherComposerReleased","steerEditedSameTextNotSent",
    "steerEditedSameTextDraftPreserved","steerEditedSameTextReleased",
    "steerAckPending","steerAckEditNotSent","steerAckEditDraftPreserved",
    "steerAckEditQuarantined"]
    .every(key=>flags[key]===true);
  document.body.dataset.sendRace=JSON.stringify(flags);
},250);
</script></body></html>`);
    const run=spawnSync(browser,[
      "--headless=new","--disable-gpu","--disable-extensions","--no-first-run",
      `--user-data-dir=${path.join(dir,"profile")}`,
      "--virtual-time-budget=17000","--dump-dom",
      `file:///${path.join(dir,"index.html").replace(/\\/g,"/")}`,
    ],{encoding:"utf8",timeout:30000,maxBuffer:8e6});
    assert.equal(run.status,0,run.stderr||"Browser failed");
    const match=run.stdout.match(/data-send-race="([^"]+)"/);
    assert.ok(match,"Browser did not complete native send race test");
    const flags=JSON.parse(match[1].replace(/&quot;/g,'"').replace(/&amp;/g,"&"));
    assert.equal(flags.ok,true,JSON.stringify(flags,null,2));
  }finally{
    fs.rmSync(dir,{recursive:true,force:true,maxRetries:12,retryDelay:250});
  }
});
