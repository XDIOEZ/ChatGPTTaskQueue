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

test("真实 Chrome：交互动效只在视图、反馈或任务变化时播放，可关闭动态效果",{
  skip:!fs.existsSync(browser) && "Chrome is not installed",
},()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"cq-ui-motion-"));
  try {
    const script=fs.readFileSync(path.join(__dirname,"..","content.js"),"utf8")
      .replace("  function boundHere() {",
        "  function boundHere() { return true; }\n  function originalBoundHere() {");
    fs.writeFileSync(path.join(dir,"content.js"),script);
    fs.copyFileSync(path.join(__dirname,"..","panel.css"),path.join(dir,"panel.css"));
    fs.writeFileSync(path.join(dir,"index.html"),`<!doctype html><html lang="zh">
<head><meta charset="utf-8"><link rel="stylesheet" href="panel.css">
<style>main{max-width:700px;margin:15px auto}</style></head><body>
<main><form><textarea id="prompt-textarea">原生输入框草稿</textarea>
<button type="button" data-testid="send-button">发送</button></form></main>
<script>
const state={key:"draft:1",halted:false,queuePaused:false,compactView:false,
 activeTaskId:null,steeringTaskId:null,autoOpenTab:false,history:[],schedules:[],
 tasks:[
  {id:"a",text:"第一条比较长的任务，用于验证排序时的移动距离",status:"pending"},
  {id:"b",text:"第二条任务",status:"pending"},
 ]};
const motion=[];
const nativeAnimate=Element.prototype.animate;
Element.prototype.animate=function(frames,options){
 motion.push({klass:String(this.className||""),frames,duration:options?.duration});
 return nativeAnimate.call(this,frames,options);
};
let storageChanged;
const favorites=[];
window.chrome={
 runtime:{onMessage:{addListener(){}},async sendMessage(message){
  if(message.type==="GET_FAVORITES")return {ok:true,favorites:[...favorites]};
  if(message.type==="ADD_FAVORITE"){
   favorites.push({id:"fav",title:"当前",text:message.text,images:[]});
   return {ok:true,favorites:[...favorites]};
  }
  return {ok:true,state,sessionKey:"draft:1",settings:{maxPending:100}};
 }},
 storage:{onChanged:{addListener(callback){storageChanged=callback;}}},
};
const q=selector=>document.querySelector("#cq-extension-root "+selector);
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const until=async fn=>{for(let i=0;i<70;i++){if(fn())return true;await wait(30);}return false;};
const emit=()=>storageChanged?.({"cq.state.v2":{newValue:{
 conversations:{"draft:1":state},favorites:[...favorites],settings:{maxPending:100}
}}},"local");
</script>
<script src="content.js"></script>
<script>
setTimeout(async()=>{
 const flags={};
 try{
  flags.mounted=await until(()=>!!q(".cq-inline"));
  flags.noBootAnimation=motion.length===0;
  const expandedHeight=q(".cq-inline").getBoundingClientRect().height;
  const start=motion.length;
  q('[data-action="toggle-queue"]').click();
  const collapseMotions=motion.slice(start);
  const compactHeight=q(".cq-inline").getBoundingClientRect().height;
  flags.collapse=q('[data-action="toggle-queue"]')?.getAttribute("aria-label")==="展开队列" &&
    collapseMotions.some(call=>call.klass.includes("cq-footer-toolbar"));
  flags.noCollapseOpacityBlink=collapseMotions.every(call=>
    !call.frames?.some(frame=>Object.hasOwn(frame,"opacity")));
  flags.noCollapseHeightFlash=compactHeight<expandedHeight-20 &&
    !collapseMotions.some(call=>call.klass==="cq-inline" &&
      call.frames?.some(frame=>frame.height));
  await wait(85);
  flags.collapseHeightStable=Math.abs(q(".cq-inline").getBoundingClientRect().height-compactHeight)<1;

  q('[data-action="toggle-queue"]').click();
  flags.expand=!!q(".cq-list") &&
    motion.some(call=>call.klass==="cq-inline" && call.frames?.[0]?.height) &&
    motion.some(call=>call.klass==="cq-list" && call.frames?.[0]?.opacity===.45);

  const beforeOutside=motion.length;
  document.querySelector("main").dispatchEvent(new MouseEvent("click",{
    bubbles:true,button:0,detail:1,
  }));
  flags.outsideCollapseNoFlash=q('[data-action="toggle-queue"]')?.getAttribute("aria-label")==="展开队列" &&
    !motion.slice(beforeOutside).some(call=>call.klass==="cq-inline" &&
      call.frames?.some(frame=>frame.height));
  q('[data-action="toggle-queue"]').click();
  const beforeRapid=motion.length;
  q('[data-action="toggle-queue"]').click();
  q('[data-action="toggle-queue"]').click();
  q('[data-action="toggle-queue"]').click();
  flags.rapidCollapseNoFlash=!q(".cq-list") &&
    motion.slice(beforeRapid).filter(call=>call.klass==="cq-inline" &&
      call.frames?.some(frame=>frame.height)).length===1;
  q('[data-action="toggle-queue"]').click();

  q('[data-action="toggle-settings"]').click();
  flags.settingsEnter=q(".cq-settings-page:not([hidden])")?.id==="cq-settings-page-cooldown" &&
    motion.some(call=>call.klass.includes("cq-settings-page"));
  q('[data-action="show-settings-page"][data-page="general"]').click();
  flags.settingsSwitch=q(".cq-settings-page:not([hidden])")?.id==="cq-settings-page-general" &&
    motion.filter(call=>call.klass.includes("cq-settings-page")).length>=2;
  q('[data-action="toggle-settings"]').click();
  await wait(300);

  const beforeIdle=motion.length;
  emit();
  flags.idleNoRepeat=motion.length===beforeIdle;

  state.tasks.push({id:"c",text:"刚加入的新任务",status:"pending"});
  emit();
  flags.taskEnter=motion.slice(beforeIdle).some(call=>call.klass.includes("cq-task") &&
    call.frames?.[0]?.opacity===0);
  await wait(270);

  state.tasks=[state.tasks[1],state.tasks[0],state.tasks[2]];
  emit();
  flags.taskReorder=motion.some(call=>call.klass.includes("cq-task") &&
    typeof call.frames?.[0]?.transform==="string" &&
    call.frames[0].transform.startsWith("translateY(") &&
    call.frames[0].transform!=="translateY(8px)");

  q('[data-action="toggle-favorites"]').click();
  const beforeReceipt=motion.length;
  q('[data-action="save-current-favorite"]').click();
  flags.receipt=await until(()=>!!q(".cq-action-feedback")) &&
    motion.slice(beforeReceipt).some(call=>call.klass.includes("cq-action-feedback"));

  const nativeDraft=document.querySelector("#prompt-textarea");
  flags.nativeDraftIntact=nativeDraft.value==="原生输入框草稿";
  const media=window.matchMedia.bind(window);
  window.matchMedia=query=>query.includes("prefers-reduced-motion")
    ? {matches:true} : media(query);
  const beforeReduced=motion.length;
  q('[data-action="toggle-queue"]').click();
  flags.respectsReducedMotion=motion.length===beforeReduced &&
    q('[data-action="toggle-queue"]')?.getAttribute("aria-label")==="展开队列";
 }catch(error){flags.error=error.stack||String(error);}
 flags.ok=["mounted","noBootAnimation","collapse","noCollapseHeightFlash",
  "noCollapseOpacityBlink",
  "collapseHeightStable","outsideCollapseNoFlash","rapidCollapseNoFlash",
  "expand","settingsEnter",
  "settingsSwitch","idleNoRepeat","taskEnter","taskReorder","receipt",
  "nativeDraftIntact","respectsReducedMotion"].every(key=>flags[key]===true);
 document.body.dataset.motionTest=JSON.stringify(flags);
},300);
</script></body></html>`);
    const result=spawnSync(browser,[
      "--headless=new","--disable-gpu","--disable-extensions","--no-first-run",
      "--window-size=1100,900",`--user-data-dir=${path.join(dir,"profile")}`,
      "--virtual-time-budget=12500","--dump-dom",
      `file:///${path.join(dir,"index.html").replace(/\\/g,"/")}`,
    ],{encoding:"utf8",timeout:30000,maxBuffer:10e6});
    assert.equal(result.status,0,result.stderr||"Chrome failed");
    const match=result.stdout.match(/data-motion-test="([^"]+)"/);
    assert.ok(match,"Chrome did not complete UI motion test");
    const flags=JSON.parse(match[1].replace(/&quot;/g,'"').replace(/&amp;/g,"&"));
    assert.equal(flags.ok,true,JSON.stringify(flags,null,2));
  }finally{
    fs.rmSync(dir,{recursive:true,force:true,maxRetries:12,retryDelay:250});
  }
});
