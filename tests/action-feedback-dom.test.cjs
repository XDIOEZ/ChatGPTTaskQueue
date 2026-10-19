"use strict";

const {test} = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const {spawnSync} = require("node:child_process");

const browser=process.env.CQ_BROWSER_BIN || (process.platform === "win32"
  ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" : "/usr/bin/google-chrome");

test("真实 Chrome：操作反馈在折叠队列仍可见、删除确认、按钮防连点及键盘焦点",{
  skip:!fs.existsSync(browser) && "Chrome is not installed",
},()=>{
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),"cq-feedback-"));
  try {
    const src=fs.readFileSync(path.join(__dirname,"..","content.js"),"utf8")
      .replace("  function boundHere() {",
        "  function boundHere() { return true; }\n  function unusedBoundHere() {");
    fs.writeFileSync(path.join(folder,"content.js"),src);
    fs.copyFileSync(path.join(__dirname,"..","panel.css"),path.join(folder,"panel.css"));
    fs.writeFileSync(path.join(folder,"index.html"),`<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><link rel="stylesheet" href="./panel.css">
<style>main{max-width:700px;margin:20px auto}</style></head><body>
<main><form><textarea id="prompt-textarea"></textarea>
<button type="button" data-testid="send-button" aria-label="Send">发送</button></form></main>
<script>
const state={
 key:"draft:1",halted:false,queuePaused:false,
 activeTaskId:null,steeringTaskId:null,autoOpenTab:false,
 tasks:[
   {id:"a",text:"重要的第一条待发送任务",status:"pending"},
   {id:"b",text:"需要删除的第二条",status:"pending"},
 ],
 schedules:[
   {id:"r1",text:"用于测试暂停的循环规则",mode:"time",enabled:true,
    repeatCount:-1,runCount:0,intervalMinutes:30,nextRunAt:Date.now()+1800000,images:[]},
   {id:"r2",text:"需要删除的另一条自动规则",mode:"count",enabled:false,
    repeatCount:-1,runCount:0,threshold:1,nextRunAt:null,images:[]},
 ],
};
const requests=[];
const confirms=[];
const confirmationResponses=[];
let holdToggle=false;
let failedToggle=false;
let releaseToggle=null;
window.confirm=message=>{
 confirms.push(message);
 return confirmationResponses.length ? confirmationResponses.shift() : true;
};
window.chrome={
 runtime:{onMessage:{addListener(){}},async sendMessage(message) {
   requests.push(message);
   if(message.type==="TOGGLE_SCHEDULE" && failedToggle) {
     failedToggle=false;
     return {ok:false,error:"模拟规则修改失败"};
   }
   if(message.type==="TOGGLE_SCHEDULE" && holdToggle) {
     holdToggle=false;
     return await new Promise(resolve=>{
       releaseToggle=()=>{
         const rule=state.schedules.find(item=>item.id===message.id);
         if(rule) rule.enabled=!rule.enabled;
         resolve({ok:true,state,sessionKey:"draft:1",settings:{maxPending:100}});
       };
     });
   }
   if(message.type==="PIN_TASK") {
     const index=state.tasks.findIndex(item=>item.id===message.id);
     if(index>=0) state.tasks.unshift(...state.tasks.splice(index,1));
   }
   if(message.type==="DELETE_TASK") state.tasks=state.tasks.filter(item=>item.id!==message.id);
   if(message.type==="DELETE_SCHEDULE") {
     state.schedules=state.schedules.filter(item=>item.id!==message.id);
   }
   if(message.type==="TOGGLE_SCHEDULE") {
     const item=state.schedules.find(item=>item.id===message.id);
     if(item) item.enabled=!item.enabled;
   }
   if(message.type==="EDIT_TASK") {
     const item=state.tasks.find(item=>item.id===message.id);
     if(item) item.text=message.text;
   }
   if(message.type==="CLEAR_HISTORY") state.history=[];
   return {ok:true,state,sessionKey:"draft:1",settings:{maxPending:100}};
 }},
 storage:{onChanged:{addListener(fn){window.fireStorageChange=fn;}}},
};
const q=selector=>document.querySelector("#cq-extension-root "+selector);
const receipt=()=>q(".cq-action-feedback")?.textContent || "";
const count=type=>requests.filter(item=>item.type===type).length;
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
</script><script src="./content.js"></script>
<script>
setTimeout(async()=>{
 const flags={};
 try {
  flags.initiallyEmpty=!q(".cq-action-feedback");
  const pin=q('[data-action="pin-task"][data-id="b"]');
  pin.focus();
  pin.click();
  await wait(65);
  flags.pinnedWithReceipt=state.tasks[0].id==="b" &&
    count("PIN_TASK")===1 && receipt().includes("已移至待发送队首") &&
    q(".cq-action-feedback")?.getAttribute("role")==="status";
  q('[data-action="toggle-queue"]').click();
  flags.visibleWhenCollapsed=!q(".cq-list") && receipt().includes("已移至") &&
    !!q('.cq-footer-toolbar') && !!q('[data-action="dismiss-feedback"]');
  const beforeDismiss=requests.length;
  q('[data-action="dismiss-feedback"]').click();
  flags.dismissNoRpc=!q(".cq-action-feedback") &&
    requests.length===beforeDismiss;
  q('[data-action="toggle-queue"]').click();

  confirmationResponses.push(false,true);
  q('[data-action="delete-task"][data-id="b"]').click();
  flags.cancelPreservesTask=state.tasks.length===2 &&
    count("DELETE_TASK")===0 && confirms.at(-1)?.includes("删除后不能直接撤销") &&
    confirms.at(-1)?.includes("重要")===false;
  const deleteTask=q('[data-action="delete-task"][data-id="b"]');
  deleteTask.focus();
  deleteTask.click();
  await wait(65);
  flags.deleteTaskConfirmed=state.tasks.length===1 &&
    state.tasks[0].id==="a" && count("DELETE_TASK")===1 &&
    receipt().includes("队列任务已删除") &&
    document.activeElement?.dataset.taskId==="a";

  q('[data-action="edit-task"][data-id="a"]').click();
  const draft=q("#cq-edit-task-input");
  draft.value="经过编辑后的待办";
  draft.dispatchEvent(new Event("input",{bubbles:true}));
  q('[data-action="save-task"]').click();
  await wait(65);
  flags.editFeedback=state.tasks[0].text==="经过编辑后的待办" &&
    count("EDIT_TASK")===1 && receipt().includes("队列任务已保存");

  q('[data-action="toggle-scheduler"]').click();
  confirmationResponses.push(false,true);
  q('[data-action="delete-schedule"][data-id="r2"]').click();
  flags.cancelPreservesRule=state.schedules.length===2 &&
    count("DELETE_SCHEDULE")===0 && confirms.at(-1)?.includes("此前已经入队");
  const delRule=q('[data-action="delete-schedule"][data-id="r2"]');
  delRule.focus();
  delRule.click();
  await wait(65);
  flags.deleteRuleConfirmed=state.schedules.length===1 &&
    state.schedules[0].id==="r1" && count("DELETE_SCHEDULE")===1 &&
    receipt().includes("自动入队规则已删除") &&
    document.activeElement?.dataset.action==="toggle-schedule";

  const toggle=q('[data-action="toggle-schedule"][data-id="r1"]');
  toggle.focus();
  holdToggle=true;
  toggle.click();
  await wait(45);
  flags.busyMarked=toggle.disabled && toggle.getAttribute("aria-busy")==="true" &&
    count("TOGGLE_SCHEDULE")===1 && typeof releaseToggle==="function";
  window.fireStorageChange?.({
    "cq.state.v2":{newValue:{conversations:{"draft:1":state}}},
  },"local");
  const rerenderedToggle=q('[data-action="toggle-schedule"][data-id="r1"]');
  flags.busySurvivesRefresh=rerenderedToggle?.disabled &&
    rerenderedToggle.getAttribute("aria-busy")==="true";
  rerenderedToggle?.click();
  flags.duplicateSuppressed=count("TOGGLE_SCHEDULE")===1 &&
    state.schedules[0].enabled;
  releaseToggle?.();
  await wait(65);
  flags.toggleReceipt=!state.schedules[0].enabled &&
    count("TOGGLE_SCHEDULE")===1 &&
    receipt().includes("规则已停用") &&
    document.activeElement?.dataset.id==="r1";
  failedToggle=true;
  q('[data-action="toggle-schedule"][data-id="r1"]').click();
  await wait(65);
  flags.errorReplacesReceipt=!q(".cq-action-feedback") &&
    q(".cq-notice")?.textContent.includes("模拟规则修改失败") &&
    state.schedules[0].enabled===false;
 } catch(error) {flags.error=error.stack || error.message;}
 flags.ok=["initiallyEmpty","pinnedWithReceipt","visibleWhenCollapsed",
   "dismissNoRpc","cancelPreservesTask","deleteTaskConfirmed",
   "editFeedback","cancelPreservesRule","deleteRuleConfirmed",
   "busyMarked","busySurvivesRefresh","duplicateSuppressed","toggleReceipt",
   "errorReplacesReceipt"].every(key=>flags[key]===true);
 document.body.dataset.check=JSON.stringify(flags);
},280);
</script></body></html>`);
    const result=spawnSync(browser,[
      "--headless=new","--disable-gpu","--disable-extensions","--no-first-run",
      `--user-data-dir=${path.join(folder,"profile")}`,
      "--virtual-time-budget=6000","--dump-dom",
      `file:///${path.join(folder,"index.html").replace(/\\/g,"/")}`,
    ],{encoding:"utf8",timeout:26000,maxBuffer:9e6});
    assert.equal(result.status,0,result.stderr || "Chrome failed");
    const match=result.stdout.match(/data-check="([^"]+)"/);
    assert.ok(match,"Chrome did not finish action-feedback test");
    const flags=JSON.parse(match[1].replace(/&quot;/g,'"'));
    assert.equal(flags.ok,true,JSON.stringify(flags));
  } finally {
    fs.rmSync(folder,{recursive:true,force:true});
  }
});
