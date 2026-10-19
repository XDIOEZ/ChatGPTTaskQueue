"use strict";

const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const os=require("node:os");
const {spawnSync}=require("node:child_process");

const browser=process.env.CQ_BROWSER_BIN || (process.platform==="win32"
  ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" : "/usr/bin/google-chrome");

test("真实 Chrome：隐藏草稿提示、自动规则返回保留、主动放弃确认、设置异步编辑与更新安全检测",{
  skip:!fs.existsSync(browser) && "Chrome is not installed",
},()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),"cq-unsaved-drafts-"));
  try {
    const content=fs.readFileSync(path.join(__dirname,"..","content.js"),"utf8")
      .replace("  function boundHere() {",
        "  function boundHere() { return true; }\n  function unusedBoundHere() {");
    const background=fs.readFileSync(path.join(__dirname,"..","background.js"),"utf8");
    const start=background.indexOf("function inspectUpdateRefreshSafety() {");
    const end=background.indexOf("\nasync function inspectUpdateTab(",start);
    assert.ok(start>=0 && end>start,"Expected safety probe in background.js");
    const probe=background.slice(start,end);
    fs.writeFileSync(path.join(directory,"content.js"),content);
    fs.copyFileSync(path.join(__dirname,"..","panel.css"),path.join(directory,"panel.css"));
    const html=`<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><link rel="stylesheet" href="./panel.css">
<style>main{max-width:720px;margin:20px auto}</style></head><body>
<main><form><textarea id="prompt-textarea"></textarea>
  <button type="button" data-testid="voice-mode-button" aria-label="Start Voice">Voice</button>
</form></main>
<script>
const state={
  key:"draft:1",halted:false,queuePaused:false,
  activeTaskId:null,steeringTaskId:null,
  tasks:[],autoOpenTab:false,
  countRateLimit:{enabled:false,windowMinutes:10,maxAdds:3},
  schedules:[{
    id:"r1",text:"原始自动规则",mode:"time",enabled:true,
    intervalMinutes:30,repeatCount:5,runCount:0,
    nextRunAt:Date.now()+1800000,images:[],
  }],
};
const settings={maxPending:100,protectBackground:true,
  defaultIntervalMinutes:30,defaultRepeatCount:-1};
const requests=[];
const confirmations=[];
const answers=[];
let deferSettings=false;
let releaseSettings=null;
window.confirm=(message)=>{
  confirmations.push(message);
  return answers.length ? answers.shift() : true;
};
function commitSettings(message) {
  settings.maxPending=Number(message.maxPending);
  settings.defaultIntervalMinutes=Number(message.defaultIntervalMinutes);
  settings.defaultRepeatCount=Number(message.defaultRepeatCount);
}
window.chrome={
  runtime:{onMessage:{addListener(){}},async sendMessage(message) {
    requests.push(message);
    if(message.type==="SAVE_SETTINGS") {
      if(deferSettings) {
        deferSettings=false;
        return await new Promise(resolve=>{
          releaseSettings=()=>{
            commitSettings(message);
            resolve({ok:true,state,sessionKey:"draft:1",settings});
          };
        });
      }
      commitSettings(message);
    }
    if(message.type==="SAVE_COUNT_RATE_LIMIT") {
      state.countRateLimit={
        enabled:message.enabled,
        windowMinutes:Number(message.windowMinutes),
        maxAdds:Number(message.maxAdds),
      };
    }
    return {ok:true,state,sessionKey:"draft:1",settings};
  }},
  storage:{onChanged:{addListener(fn){window.storageChange=fn;}}},
};
const q=selector=>document.querySelector("#cq-extension-root "+selector);
const click=action=>{
  const button=q('[data-action="'+action+'"]');
  if(!button) throw new Error("missing action "+action);
  button.click();
};
const input=(id,value)=>{
  const element=q("#"+id);
  if(!element) throw new Error("missing field "+id);
  element.value=value;
  element.dispatchEvent(new Event("input",{bubbles:true}));
};
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const dirty=()=>document.querySelector("#cq-extension-root")?.dataset.cqUnsavedDraft;
const shown=kind=>{
  const indicator=q('.cq-draft-indicator[data-draft-kind="'+kind+'"]');
  return Boolean(indicator && !indicator.hidden);
};
</script>
<script src="./content.js"></script>
<script>
@INSPECT@
setTimeout(async()=>{
 const flags={};
 try {
  const base=inspectUpdateRefreshSafety();
  flags.initialClean=dirty()==="false" &&
    ["queue","schedule","settings"].every(kind=>!shown(kind)) &&
    base.safe;

  click("toggle-queue-composer");
  input("cq-queue-draft","没有保存的图文草稿");
  flags.queueEditing=shown("queue") && dirty()==="true";
  click("toggle-settings");
  flags.queueHiddenPreserved=shown("queue") &&
    !q("#cq-queue-draft") &&
    inspectUpdateRefreshSafety().reason==="plugin_hidden_unsaved_draft";
  click("toggle-queue-composer");
  flags.queueReopened=q("#cq-queue-draft")?.value==="没有保存的图文草稿";
  click("toggle-queue");
  flags.collapsedBadgeStillVisible=shown("queue") &&
    !q("#cq-queue-draft") &&
    inspectUpdateRefreshSafety().reason==="plugin_hidden_unsaved_draft";
  click("toggle-queue");

  answers.push(false,true);
  click("cancel-queue-composer");
  flags.queueCancelDeclined=q("#cq-queue-draft")?.value==="没有保存的图文草稿" &&
    confirmations.at(-1)?.includes("尚未保存");
  click("cancel-queue-composer");
  flags.queueCancelled=!q("#cq-queue-draft") && !shown("queue") &&
    dirty()==="false";

  click("toggle-scheduler");
  click("show-schedule-create");
  input("cq-schedule-draft","还在编辑的自动规则");
  const mode=q("#cq-schedule-mode");
  mode.value="count";
  mode.dispatchEvent(new Event("change",{bubbles:true}));
  input("cq-threshold","3");
  input("cq-repeats","7");
  flags.scheduleDirty=shown("schedule") && dirty()==="true";
  click("show-schedule-list");
  flags.scheduleSavedWhenHidden=shown("schedule") &&
    q('[data-action="show-schedule-create"]')?.textContent.includes("继续草稿") &&
    !q("#cq-schedule-draft") &&
    inspectUpdateRefreshSafety().reason==="plugin_hidden_unsaved_draft";
  click("toggle-settings");
  click("toggle-scheduler");
  click("show-schedule-create");
  flags.scheduleResume=q("#cq-schedule-draft")?.value==="还在编辑的自动规则" &&
    q("#cq-schedule-mode")?.value==="count" &&
    q("#cq-threshold")?.value==="3" &&
    q("#cq-repeats")?.value==="7";

  answers.push(false,true);
  click("discard-schedule-draft");
  flags.scheduleDiscardDeclined=q("#cq-schedule-draft")?.value==="还在编辑的自动规则";
  click("discard-schedule-draft");
  flags.scheduleDiscarded=q("#cq-schedule-draft")?.value==="" &&
    q("#cq-schedule-mode")?.value==="time" && !shown("schedule") &&
    dirty()==="false";

  click("show-schedule-list");
  click("show-schedule-create");
  input("cq-schedule-draft","另一个未保存的创建草稿");
  click("show-schedule-list");
  answers.push(false,true);
  q('[data-action="edit-schedule"][data-id="r1"]').click();
  flags.switchEditDeclined=q('[data-action="show-schedule-create"]')
    ?.textContent.includes("继续草稿");
  q('[data-action="edit-schedule"][data-id="r1"]').click();
  flags.switchEditConfirmed=q("#cq-schedule-draft")?.value==="原始自动规则" &&
    q("#cq-repeats")?.value==="5";
  input("cq-schedule-draft","更改后的规则（还没保存）");
  click("show-schedule-list");
  click("show-schedule-create");
  flags.ruleEditResumes=q("#cq-schedule-draft")?.value==="更改后的规则（还没保存）" &&
    q('[data-action="show-schedule-create"]')?.textContent.includes("继续编辑");
  answers.push(false,true);
  click("cancel-edit-schedule");
  flags.ruleEditCancelDeclined=q("#cq-schedule-draft")?.value==="更改后的规则（还没保存）";
  click("cancel-edit-schedule");
  flags.ruleEditCancelled=!q("#cq-schedule-draft") && !shown("schedule");

  click("toggle-settings");
  input("cq-max-pending","22");
  input("cq-default-minutes","44");
  flags.settingsDirty=shown("settings") &&
    !!q('[data-action="discard-settings-draft"]');
  click("toggle-scheduler");
  flags.settingsHiddenPreserved=shown("settings") &&
    inspectUpdateRefreshSafety().reason==="plugin_hidden_unsaved_draft";
  click("toggle-settings");
  flags.settingsResume=q("#cq-max-pending")?.value==="22" &&
    q("#cq-default-minutes")?.value==="44";
  settings.maxPending=90;
  window.storageChange?.({"cq.state.v2":{newValue:{
    settings,conversations:{"draft:1":state},
  }}},"local");
  flags.settingsSurvivesExternalUpdate=q("#cq-max-pending")?.value==="22";
  answers.push(false,true);
  click("discard-settings-draft");
  flags.settingsDiscardDeclined=q("#cq-max-pending")?.value==="22";
  click("discard-settings-draft");
  flags.settingsRestored=q("#cq-max-pending")?.value==="90" &&
    !shown("settings") && dirty()==="false";

  input("cq-max-pending","23");
  deferSettings=true;
  click("save-settings");
  flags.settingsSavePending=typeof releaseSettings==="function";
  input("cq-default-minutes","17");
  releaseSettings?.();
  await wait(110);
  flags.settingsConcurrentEditPreserved=q("#cq-max-pending")?.value==="23" &&
    q("#cq-default-minutes")?.value==="17" &&
    shown("settings") && dirty()==="true" &&
    q(".cq-notice")?.textContent.includes("期间的新修改仍保留");
  click("save-settings");
  await wait(110);
  flags.settingsFinallySaved=settings.maxPending===23 &&
    settings.defaultIntervalMinutes===17 &&
    dirty()==="false" && !shown("settings");
  click("toggle-scheduler");
  input("cq-count-rate-minutes","11");
  flags.rateLimitDraftDetected=shown("schedule") && dirty()==="true";
  click("toggle-settings");
  flags.rateLimitDraftHidden=shown("schedule") &&
    inspectUpdateRefreshSafety().reason==="plugin_hidden_unsaved_draft";
  click("toggle-scheduler");
  click("save-count-rate");
  await wait(70);
  flags.rateLimitDraftSaved=state.countRateLimit.windowMinutes===11 &&
    !shown("schedule") && dirty()==="false";

  click("toggle-settings");
  input("cq-max-pending","37");
  click("toggle-queue-composer");
  input("cq-queue-draft","窗口很窄时也不能看不到草稿提示");
  click("toggle-scheduler");
  input("cq-count-rate-minutes","13");
  document.querySelector("main").style.width="320px";
  await wait(90);
  flags.narrowMultiDraftBadges=["queue","schedule","settings"].every(shown) &&
    dirty()==="true" &&
    q(".cq-inline").scrollWidth<=q(".cq-inline").clientWidth+2;
  flags.noUnintendedQueueOps=!requests.some(request=>
    ["ENQUEUE","CLAIM","SENT","DELETE_TASK","ADD_SCHEDULE","EDIT_SCHEDULE"]
      .includes(request.type));
 } catch(error) {flags.error=error.stack || error.message;}
 flags.ok=["initialClean","queueEditing","queueHiddenPreserved",
   "queueReopened","collapsedBadgeStillVisible","queueCancelDeclined",
   "queueCancelled","scheduleDirty","scheduleSavedWhenHidden",
   "scheduleResume","scheduleDiscardDeclined","scheduleDiscarded",
   "switchEditDeclined","switchEditConfirmed","ruleEditResumes",
   "ruleEditCancelDeclined","ruleEditCancelled","settingsDirty",
   "settingsHiddenPreserved","settingsResume","settingsSurvivesExternalUpdate",
   "settingsDiscardDeclined","settingsRestored",
   "settingsSavePending","settingsConcurrentEditPreserved",
   "settingsFinallySaved","rateLimitDraftDetected","rateLimitDraftHidden",
   "rateLimitDraftSaved","narrowMultiDraftBadges",
   "noUnintendedQueueOps"]
   .every(key=>flags[key]===true);
 document.body.dataset.check=JSON.stringify(flags);
},300);
</script></body></html>`.replace("@INSPECT@",probe);
    fs.writeFileSync(path.join(directory,"index.html"),html);
    const run=spawnSync(browser,[
      "--headless=new","--disable-gpu","--disable-extensions","--no-first-run",
      `--user-data-dir=${path.join(directory,"profile")}`,
      "--virtual-time-budget=8500","--dump-dom",
      `file:///${path.join(directory,"index.html").replace(/\\/g,"/")}`,
    ],{encoding:"utf8",timeout:30000,maxBuffer:9e6});
    assert.equal(run.status,0,run.stderr || "Chrome failed");
    const match=run.stdout.match(/data-check="([^"]+)"/);
    assert.ok(match,"Chrome did not complete unsaved drafts test");
    const flags=JSON.parse(match[1].replace(/&quot;/g,'"'));
    assert.equal(flags.ok,true,JSON.stringify(flags));
  } finally {
    fs.rmSync(directory,{recursive:true,force:true});
  }
});
