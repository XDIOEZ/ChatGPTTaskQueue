"use strict";

const {test} = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const {spawnSync} = require("node:child_process");

const browser=process.env.CQ_BROWSER_BIN || (process.platform === "win32"
  ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" : "/usr/bin/google-chrome");

test("真实 Chrome：精简自动任务列表，保留任务操作、长文、图片及窄栏适配",{
  skip:!fs.existsSync(browser) && "Chrome is not installed",
},()=>{
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),"cq-rule-manager-"));
  try {
    const content=fs.readFileSync(path.join(__dirname,"..","content.js"),"utf8")
      .replace("  function boundHere() {",
        "  function boundHere() { return true; }\n  function unusedBoundHere() {");
    fs.writeFileSync(path.join(folder,"content.js"),content);
    fs.copyFileSync(path.join(__dirname,"..","panel.css"),path.join(folder,"panel.css"));
    fs.writeFileSync(path.join(folder,"index.html"),`<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><link rel="stylesheet" href="./panel.css">
<style>main{width:700px;max-width:100%;margin:20px auto}</style></head><body>
<main><form><textarea id="prompt-textarea"></textarea>
<button type="button" data-testid="send-button" aria-label="Send">发送</button></form></main>
<script>
const now=Date.now();
const original=[
 {id:"t1",text:"中期时间规则",mode:"time",enabled:true,intervalMinutes:15,
   nextRunAt:now+900000,runCount:0,repeatCount:-1,images:[]},
 {id:"t2",text:"暂停数量规则",mode:"count",enabled:false,threshold:2,
   nextRunAt:null,runCount:2,repeatCount:5,images:[]},
 {id:"t3",text:"截图自动分析",mode:"count",enabled:true,threshold:3,
   nextRunAt:null,runCount:1,repeatCount:-1,
   images:[{name:"证据needle截图.png",thumbnail:"data:image/jpeg;base64,YWJj"}]},
 {id:"t4",text:"最快触发规则",mode:"time",enabled:true,intervalMinutes:1,
   nextRunAt:now+60000,runCount:0,repeatCount:-1,images:[]},
 {id:"t5",text:"已停止时间规则",mode:"time",enabled:false,intervalMinutes:5,
   nextRunAt:now+300000,runCount:1,repeatCount:0,images:[]},
];
const state={
 key:"draft:1",halted:false,queuePaused:false,activeTaskId:null,
 autoOpenTab:false,steeringTaskId:null,
 tasks:[],schedules:original.slice(),
 countRateLimit:{enabled:false,windowMinutes:10,maxAdds:3},
};
const calls=[];
window.chrome={
 runtime:{onMessage:{addListener(){}},async sendMessage(message) {
   calls.push(message);
   if(message.type==="TOGGLE_SCHEDULE") {
     const item=state.schedules.find(item=>item.id===message.id);
     if(item) item.enabled=!item.enabled;
   }
   return {ok:true,state,sessionKey:"draft:1",
     settings:{maxPending:100,protectBackground:true,
       defaultIntervalMinutes:30,defaultRepeatCount:-1}};
 }},
 storage:{onChanged:{addListener(fn){window.storageChanged=fn;}}},
};
const q=selector=>document.querySelector("#cq-extension-root "+selector);
const rows=()=>[...document.querySelectorAll("#cq-extension-root .cq-schedule-item")]
  .map(row=>row.dataset.scheduleId);
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const waitUntil=async predicate=>{
  for(let i=0;i<60;i++) {
    if(predicate()) return true;
    await wait(50);
  }
  return Boolean(predicate());
};
</script><script src="./content.js"></script>
<script>
setTimeout(async()=>{
 const flags={};
 try {
  q('[data-action="toggle-scheduler"]').click();
  flags.defaultOrder=rows().join(",")==="t1,t2,t3,t4,t5";
  flags.controlsRemoved=!q(".cq-rule-tools") && !q("#cq-rule-search") &&
    !q("#cq-rule-kind") && !q("#cq-rule-sort") &&
    !q('[data-action="filter-schedules"]') &&
    // Only the redundant top-level *list* title was removed. The separate
    // count-rate settings panel legitimately has its own section heading.
    !q(".cq-scheduler > .cq-section-title");
  flags.ruleStatusBadges=q('[data-schedule-id="t2"] .cq-rule-state')
    ?.textContent.includes("已停用") &&
    q('[data-schedule-id="t3"] .cq-rule-state')?.textContent.includes("运行中") &&
    !!q(".cq-count-rate-panel") && !!q("#cq-auto-open");
  flags.disabledActions=q('[data-schedule-id="t2"] [data-action="toggle-schedule"]')
    ?.getAttribute("aria-label")==="启用此自动任务";
  q('[data-schedule-id="t2"] [data-action="toggle-schedule"]').click();
  await wait(65);
  flags.toggleStillWorks=state.schedules.find(item=>item.id==="t2").enabled &&
    q('[data-schedule-id="t2"] .cq-rule-state')?.textContent.includes("运行中") &&
    calls.some(message=>message.type==="TOGGLE_SCHEDULE" && message.id==="t2");
  flags.noUnintendedDispatch=!calls.some(message=>["ENQUEUE","CLAIM","SENT",
    "DELETE_SCHEDULE","REORDER_TASK"].includes(message.type));

  q('[data-schedule-id="t1"] [data-action="edit-schedule"]').click();
  flags.editView=q("#cq-schedule-draft")?.value==="中期时间规则" &&
    !q(".cq-schedule-results");
  q('[data-action="cancel-edit-schedule"]').click();
  flags.listSurvivesEdit=rows().join(",")==="t1,t2,t3,t4,t5";

  state.schedules[0].text="长期任务 " + "多行巡检 ".repeat(60) +
    "末尾专用关键字needle <img src=x onerror=alert(1)>";
  q('[data-action="show-schedule-create"]').click();
  q('[data-action="show-schedule-list"]').click();
  const preview=q('[data-schedule-id="t1"] .cq-task-text');
  const shortLength=preview?.textContent.length || 0;
  flags.longRulePreview=rows().join(",")==="t1,t2,t3,t4,t5" &&
    !preview?.querySelector("mark") &&
    shortLength < state.schedules[0].text.length;
  q('[data-schedule-id="t1"] [data-action="toggle-schedule-text"]').click();
  const expanded=q('[data-schedule-id="t1"] .cq-task-text');
  flags.longRuleExpand=expanded?.textContent.length>shortLength &&
    !expanded.querySelector("img") &&
    expanded.textContent.includes("<img src=x onerror=alert(1)>") &&
    q('[data-schedule-id="t1"] [data-action="toggle-schedule-text"]')
      ?.getAttribute("aria-expanded")==="true";
  q('[data-schedule-id="t1"] [data-action="toggle-schedule-text"]').click();
  flags.longRuleCollapse=q('[data-schedule-id="t1"] .cq-task-text')
    ?.textContent.length===shortLength &&
    q('[data-schedule-id="t1"] [data-action="toggle-schedule-text"]')
      ?.getAttribute("aria-expanded")==="false";

  for(let i=0;i<70;i++) {
    state.schedules.push({id:"extra-"+i,text:"额外规则 "+i,mode:"time",
      enabled:i%2===0,intervalMinutes:120,nextRunAt:now+120000,images:[]});
  }
  q('[data-action="show-schedule-create"]').click();
  q('[data-action="show-schedule-list"]').click();
  flags.largeListScrollable=q(".cq-schedule-results")?.scrollHeight >
    q(".cq-schedule-results")?.clientHeight &&
    rows().length===75;
  document.querySelector("main").style.width="330px";
  await wait(80);
  flags.narrowNoOverflow=q(".cq-inline").scrollWidth<=q(".cq-inline").clientWidth+2 &&
    q(".cq-schedule-results").getBoundingClientRect().width<=328;
  flags.narrowControlsRemoved=!q("#cq-rule-kind") &&
    !q("#cq-rule-sort") && !q("#cq-rule-search");

  // Images are added straight to the automatic-task textbox. No independent
  // dashed upload row should remain, including in the narrow layout.
  q('[data-action="show-schedule-create"]').click();
  const composer=q('.cq-inline-image-composer[data-image-zone="schedule"]');
  const editor=q("#cq-schedule-draft");
  flags.imageInsideEditor=!!composer && composer.contains(editor) &&
    composer.contains(q("#cq-schedule-images")) &&
    !q('.cq-image-zone[data-image-zone="schedule"]') &&
    !q('.cq-scheduler .cq-image-hint') &&
    editor.placeholder.includes("拖入") &&
    getComputedStyle(composer).borderStyle==="solid";
  flags.imageNarrowFits=composer.scrollWidth<=composer.clientWidth+2 &&
    getComputedStyle(q(".cq-composer-image-button")).position==="absolute";
  editor.value="依据截图排查游戏问题";
  editor.dispatchEvent(new Event("input",{bubbles:true}));
  const png="iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lSkAAAAASUVORK5CYII=";
  const binary=Uint8Array.from(atob(png),ch=>ch.charCodeAt(0));
  const attachment=name=>new File([binary],name,{type:"image/png"});
  const transfer=file=>{
    const value=new DataTransfer();
    value.items.add(file);
    return value;
  };
  const first=transfer(attachment("第一张.png"));
  const drag=new DragEvent("dragover",{
    bubbles:true,cancelable:true,dataTransfer:first,
  });
  editor.dispatchEvent(drag);
  flags.imageDropHighlight=drag.defaultPrevented &&
    composer.classList.contains("cq-image-drag-over") &&
    getComputedStyle(q(".cq-image-drop-overlay")).display==="grid";
  const drop=new DragEvent("drop",{
    bubbles:true,cancelable:true,dataTransfer:first,
  });
  editor.dispatchEvent(drop);
  flags.imageDropped=drop.defaultPrevented && await waitUntil(()=>
    q(".cq-inline-image-composer .cq-image img")?.getAttribute("src")
      .startsWith("data:image/jpeg"));
  flags.imageDraftKept=q(".cq-inline-image-composer .cq-images")?.parentElement===
    q(".cq-inline-image-composer") &&
    q("#cq-schedule-draft")?.value==="依据截图排查游戏问题" &&
    !q(".cq-inline-image-composer.cq-image-drag-over");
  const second=transfer(attachment("第二张.png"));
  const paste=new ClipboardEvent("paste",{
    bubbles:true,cancelable:true,clipboardData:second,
  });
  q("#cq-schedule-draft").dispatchEvent(paste);
  flags.imagePasted=paste.defaultPrevented && await waitUntil(()=>
    document.querySelectorAll(".cq-inline-image-composer .cq-image").length===2);
  q('.cq-inline-image-composer [data-action="remove-image"][data-index="0"]').click();
  flags.imageRemoved=document.querySelectorAll(".cq-inline-image-composer .cq-image").length===1 &&
    q("#cq-schedule-draft")?.value==="依据截图排查游戏问题";
  q('[data-action="save-schedule"]').click();
  flags.imageSubmitted=await waitUntil(()=>calls.some(call=>call.type==="ADD_SCHEDULE")) &&
    calls.find(call=>call.type==="ADD_SCHEDULE")?.images?.length===1 &&
    calls.find(call=>call.type==="ADD_SCHEDULE").images[0].name==="第二张.png" &&
    calls.find(call=>call.type==="ADD_SCHEDULE").images[0].dataUrl.startsWith("data:image/png") &&
    calls.find(call=>call.type==="ADD_SCHEDULE").text==="依据截图排查游戏问题";
  flags.saveSettled=await waitUntil(()=>!q("#cq-schedule-draft") &&
    !!q(".cq-schedule-results"));
  if(flags.saveSettled) {
    q('[data-schedule-id="t3"] [data-action="edit-schedule"]').click();
    flags.editImageEmbedded=q(".cq-inline-image-composer .cq-image")?.title===
      "证据needle截图.png" && !!q(".cq-inline-image-composer [data-action='remove-image']");
  }
  } catch(error) {flags.error=error.stack || error.message;}
 flags.ok=["defaultOrder","controlsRemoved","ruleStatusBadges","disabledActions",
   "toggleStillWorks","noUnintendedDispatch","editView","listSurvivesEdit",
   "longRulePreview","longRuleExpand","longRuleCollapse","largeListScrollable",
   "narrowNoOverflow","narrowControlsRemoved","imageInsideEditor","imageNarrowFits",
   "imageDropHighlight","imageDropped","imageDraftKept","imagePasted",
   "imageRemoved","imageSubmitted","saveSettled","editImageEmbedded"]
   .every(key=>flags[key]===true);
 document.body.dataset.check=JSON.stringify(flags);
},280);
</script></body></html>`);
    const result=spawnSync(browser,[
      "--headless=new","--disable-gpu","--disable-extensions","--no-first-run",
      `--user-data-dir=${path.join(folder,"profile")}`,
      "--virtual-time-budget=8500","--dump-dom",
      `file:///${path.join(folder,"index.html").replace(/\\/g,"/")}`,
    ],{encoding:"utf8",timeout:26000,maxBuffer:9e6});
    assert.equal(result.status,0,result.stderr || "Chrome failed");
    const match=result.stdout.match(/data-check="([^"]+)"/);
    assert.ok(match,"Chrome did not finish automatic-rule manager test");
    const flags=JSON.parse(match[1].replace(/&quot;/g,'"'));
    assert.equal(flags.ok,true,JSON.stringify(flags));
  } finally {
    fs.rmSync(folder,{recursive:true,force:true});
  }
});
