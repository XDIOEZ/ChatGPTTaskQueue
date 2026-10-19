"use strict";

const {test} = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const {spawnSync} = require("node:child_process");

const browser = process.env.CQ_BROWSER_BIN || (process.platform === "win32"
  ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" : "/usr/bin/google-chrome");

test("真实 Chrome：按对话发送冷却保存、倒计时、草稿保护和极窄面板",{
  skip:!fs.existsSync(browser) && "Chrome is not installed",
},()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"cq-send-cooldown-"));
  try {
    let content=fs.readFileSync(path.join(__dirname,"..","content.js"),"utf8");
    content=content.replace("  function boundHere() {",
      "  function boundHere() { return true; }\n  function originalBoundHere() {");
    fs.writeFileSync(path.join(dir,"content.js"),content);
    fs.copyFileSync(path.join(__dirname,"..","panel.css"),path.join(dir,"panel.css"));
    fs.writeFileSync(path.join(dir,"index.html"),`<!doctype html>
<html lang="zh"><head><meta charset="utf-8">
<link rel="stylesheet" href="panel.css">
<style>main{width:720px;max-width:100%;margin:18px auto}</style></head><body>
<main><form><textarea id="prompt-textarea"></textarea>
<button type="button" aria-label="Start Voice">Voice</button>
</form></main>
<script>
const state={
 key:"draft:1",url:"https://chatgpt.com/",halted:false,queuePaused:false,
 activeTaskId:null,steeringTaskId:null,autoOpenTab:false,schedules:[],
 tasks:[],sendCooldownSeconds:0,lastQueueSettledAt:null,
};
const settings={maxPending:100,protectBackground:true,
 defaultIntervalMinutes:30,defaultRepeatCount:-1};
const requests=[];
let storageChanged=null;
window.confirm=()=>true;
window.chrome={
 runtime:{
  onMessage:{addListener(){}},
  async sendMessage(message) {
   requests.push({...message});
   if(message.type==="SAVE_SEND_COOLDOWN") {
    if(!Number.isInteger(Number(message.seconds)) ||
       Number(message.seconds)<0 || Number(message.seconds)>3600) {
      return {ok:false,error:"发送冷却时间必须是 0～3600 秒的整数"};
    }
    await new Promise(resolve=>setTimeout(resolve,100));
    state.sendCooldownSeconds=Number(message.seconds);
   }
   if(message.type==="SAVE_SETTINGS") {
    settings.maxPending=Number(message.maxPending);
    settings.defaultIntervalMinutes=Number(message.defaultIntervalMinutes);
    settings.defaultRepeatCount=Number(message.defaultRepeatCount);
   }
   return {ok:true,state,sessionKey:"draft:1",settings};
  },
 },
 storage:{onChanged:{addListener(fn){storageChanged=fn;}}},
};
const q=(selector)=>document.querySelector("#cq-extension-root "+selector);
const wait=(ms)=>new Promise(resolve=>setTimeout(resolve,ms));
const until=async fn=>{for(let i=0;i<75;i++){if(fn())return true;await wait(40);}return !!fn();};
const input=(value)=>{
 const field=q("#cq-send-cooldown");field.focus();field.value=value;
 field.dispatchEvent(new Event("input",{bubbles:true}));
 return field;
};
const notify=()=>storageChanged?.({"cq.state.v2":{newValue:{
  conversations:{"draft:1":state},settings,
 }}},"local");
</script>
<script src="content.js"></script>
<script>
setTimeout(async()=>{
 const flags={};
 try{
  await until(()=>!!q('[data-action="toggle-settings"]'));
  q('[data-action="toggle-settings"]').click();
  flags.default=q("#cq-send-cooldown")?.value==="0" &&
   q(".cq-send-cooldown-panel")?.textContent.includes("仅当前对话");
  input("60");
  flags.unsavedIndicator=q('.cq-draft-indicator[data-draft-kind="settings"]')?.hidden===false &&
   document.querySelector("#cq-extension-root").dataset.cqUnsavedDraft==="true";
  q('[data-action="save-send-cooldown"]').click();
  await until(()=>state.sendCooldownSeconds===60 &&
    q(".cq-action-feedback")?.textContent.includes("60 秒"));
  flags.saved=requests.some(r=>r.type==="SAVE_SEND_COOLDOWN" && r.seconds==="60") &&
    q("#cq-send-cooldown")?.value==="60" &&
    q('.cq-draft-indicator[data-draft-kind="settings"]')?.hidden===true;

  // Simulate the previous queue reply completing 12 seconds ago.
  state.tasks=[{id:"later",text:"下一条等待任务",status:"pending"}];
  state.lastQueueSettledAt=Date.now()-12000;
  notify();
  await until(()=>!!q(".cq-cooldown-status .cq-countdown"));
  const before=q(".cq-cooldown-status .cq-countdown")?.textContent;
  // Virtual headless Chrome may throttle wall-clock intervals. Verify that
  // persisted deadline changes cause a real DOM countdown update instead of
  // assuming setInterval fires exactly 1200 ms after this test begins.
  state.lastQueueSettledAt=Date.now()-18000;
  notify();
  const after=q(".cq-cooldown-status .cq-countdown")?.textContent;
  flags.countdown=!!before && !!after && before!=="00:00" && after!==before &&
    q(".cq-cooldown-hint")?.textContent.includes("剩余");
  state.queuePaused=true;
  notify();
  flags.pausedNoBadge=!q(".cq-cooldown-status");
  state.queuePaused=false;
  notify();
  flags.resumedBadge=!!q(".cq-cooldown-status");

  const draft=input("120");
  notify();
  flags.storageKeepsUnsaved=q("#cq-send-cooldown")?.value==="120" &&
   document.activeElement?.id==="cq-send-cooldown";
  // Save while editing again: late first response must not erase the new input.
  q('[data-action="save-send-cooldown"]').click();
  await wait(20);
  input("180");
  await until(()=>state.sendCooldownSeconds===120);
  flags.asyncEditKept=q("#cq-send-cooldown")?.value==="180" &&
   q('.cq-draft-indicator[data-draft-kind="settings"]')?.hidden===false;
  q('[data-action="save-send-cooldown"]').click();
  await until(()=>state.sendCooldownSeconds===180);
  flags.secondSave=q("#cq-send-cooldown")?.value==="180" &&
    q('.cq-draft-indicator[data-draft-kind="settings"]')?.hidden===true;
  input("-1");
  q('[data-action="save-send-cooldown"]').click();
  await until(()=>q(".cq-notice")?.textContent.includes("0～3600"));
  flags.invalidPreserved=state.sendCooldownSeconds===180 &&
    q("#cq-send-cooldown")?.value==="-1" &&
    q('.cq-draft-indicator[data-draft-kind="settings"]')?.hidden===false;
  q('[data-action="discard-settings-draft"]').click();
  flags.discard=q("#cq-send-cooldown")?.value==="180" &&
    q('.cq-draft-indicator[data-draft-kind="settings"]')?.hidden===true;
  input("0");
  q('[data-action="save-send-cooldown"]').click();
  await until(()=>state.sendCooldownSeconds===0);
  flags.disabled=state.sendCooldownSeconds===0 && !q(".cq-cooldown-status");
  document.querySelector("main").style.width="335px";
  await wait(70);
  flags.noOverflow=q(".cq-inline").scrollWidth<=q(".cq-inline").clientWidth+2;
 }catch(error){flags.error=error.stack||String(error);}
 flags.ok=["default","unsavedIndicator","saved","countdown","pausedNoBadge",
  "resumedBadge","storageKeepsUnsaved","asyncEditKept","secondSave",
  "invalidPreserved","discard","disabled","noOverflow"].every(x=>flags[x]===true);
 document.body.dataset.test=JSON.stringify(flags);
},350);
</script></body></html>`);
    const run=spawnSync(browser,[
      "--headless=new","--disable-gpu","--disable-extensions","--no-first-run",
      "--window-size=1100,850",`--user-data-dir=${path.join(dir,"profile")}`,
      "--virtual-time-budget=15000","--dump-dom",
      `file:///${path.join(dir,"index.html").replace(/\\/g,"/")}`,
    ],{encoding:"utf8",timeout:30000,maxBuffer:10e6});
    assert.equal(run.status,0,run.stderr||"Chrome failed");
    const match=run.stdout.match(/data-test="([^"]+)"/);
    assert.ok(match,"Chrome did not finish the send-cooldown test");
    const result=JSON.parse(match[1].replace(/&quot;/g,'"').replace(/&amp;/g,"&"));
    assert.equal(result.ok,true,JSON.stringify(result,null,2));
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
