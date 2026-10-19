"use strict";

const {test} = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const {spawnSync} = require("node:child_process");

const browser=process.env.CQ_BROWSER_BIN || (process.platform === "win32"
  ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" : "/usr/bin/google-chrome");

test("真实 Chrome：自动规则筛选、图片名搜索、下次到期排序、中文输入法及窄栏适配",{
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
const clickFilter=value=>q('[data-action="filter-schedules"][data-filter="'+value+'"]').click();
const change=(id,value)=>{
  const control=q("#"+id);
  control.value=value;
  control.dispatchEvent(new Event("change",{bubbles:true}));
};
const search=value=>{
  const element=q("#cq-rule-search");
  element.focus();
  element.value=value;
  element.dispatchEvent(new Event("input",{bubbles:true}));
};
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
</script><script src="./content.js"></script>
<script>
setTimeout(async()=>{
 const flags={};
 try {
  q('[data-action="toggle-scheduler"]').click();
  flags.defaultOrder=rows().join(",")==="t1,t2,t3,t4,t5";
  flags.counter=q(".cq-rule-result-count")?.textContent.includes("5/5") &&
    q('[data-filter="enabled"] span')?.textContent==="3" &&
    q('[data-filter="disabled"] span')?.textContent==="2";
  flags.ruleStatusBadges=q('[data-schedule-id="t2"] .cq-rule-state')
    ?.textContent.includes("已停用") &&
    q('[data-schedule-id="t3"] .cq-rule-state')?.textContent.includes("运行中") &&
    !!q(".cq-count-rate-panel") && !!q("#cq-auto-open");
  clickFilter("enabled");
  flags.enabledOnly=rows().join(",")==="t1,t3,t4" &&
    q('[data-filter="enabled"]').getAttribute("aria-pressed")==="true" &&
    document.activeElement?.dataset.filter==="enabled";
  clickFilter("disabled");
  flags.disabledOnly=rows().join(",")==="t2,t5";
  clickFilter("all");
  change("cq-rule-kind","time");
  flags.timeOnly=rows().join(",")==="t1,t4,t5" &&
    document.activeElement?.id==="cq-rule-kind";
  change("cq-rule-kind","count");
  flags.countOnly=rows().join(",")==="t2,t3";
  change("cq-rule-kind","all");

  const input=q("#cq-rule-search");
  input.focus();
  input.value="needle";
  input.setSelectionRange(3,3);
  input.dispatchEvent(new Event("input",{bubbles:true}));
  flags.searchImageByName=rows().join(",")==="t3" &&
    q("#cq-rule-search")===input &&
    input.selectionStart===3 &&
    document.activeElement===input &&
    q(".cq-rule-result-count")?.textContent.includes("1/5");
  flags.resetVisible=!!q('[data-action="reset-schedule-filters"]');
  search("没有对应规则");
  flags.noMatches=rows().length===0 &&
    !!q('[data-action="reset-schedule-filters"]') &&
    q(".cq-schedule-results")?.textContent.includes("没有符合条件");
  q('[data-action="reset-schedule-filters"]').click();
  flags.reset=rows().join(",")==="t1,t2,t3,t4,t5" &&
    q("#cq-rule-search")?.value==="" &&
    document.activeElement?.id==="cq-rule-search";
  clickFilter("enabled");
  search("最快");
  const esc=q("#cq-rule-search");
  const escape=new KeyboardEvent("keydown",{
    key:"Escape",bubbles:true,cancelable:true,
  });
  esc.dispatchEvent(escape);
  flags.escapeResets=escape.defaultPrevented &&
    rows().join(",")==="t1,t2,t3,t4,t5" &&
    q("#cq-rule-search")?.value==="" &&
    document.activeElement?.id==="cq-rule-search" &&
    q('[data-action="filter-schedules"][data-filter="all"]')
      ?.getAttribute("aria-pressed")==="true";

  const ime=q("#cq-rule-search");
  ime.focus();
  ime.dispatchEvent(new CompositionEvent("compositionstart",{bubbles:true,data:"截图"}));
  ime.value="截图";
  ime.dispatchEvent(new InputEvent("input",{bubbles:true,isComposing:true,data:"截图"}));
  window.storageChanged?.({"cq.state.v2":{newValue:{conversations:{"draft:1":state}}}},"local");
  flags.imeKeepsInput=q("#cq-rule-search")===ime &&
    document.activeElement===ime && rows().length===5;
  ime.dispatchEvent(new CompositionEvent("compositionend",{bubbles:true,data:"截图"}));
  flags.imeUpdatesAfterCommit=rows().join(",")==="t3" &&
    q("#cq-rule-search").value==="截图" &&
    document.activeElement?.id==="cq-rule-search";
  search("");

  change("cq-rule-sort","next");
  flags.nextDueOrder=rows().join(",")==="t4,t1,t3,t2,t5" &&
    document.activeElement?.id==="cq-rule-sort" &&
    state.schedules.map(s=>s.id).join(",")==="t1,t2,t3,t4,t5";
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
  flags.filterAndSortSurviveEdit=q("#cq-rule-sort")?.value==="next" &&
    rows().join(",")==="t4,t1,t2,t3,t5";
  change("cq-rule-sort","original");

  state.schedules[0].text="长期任务 " + "多行巡检 ".repeat(60) +
    "末尾专用关键字needle <img src=x onerror=alert(1)>";
  q('[data-action="show-schedule-create"]').click();
  q('[data-action="show-schedule-list"]').click();
  search("关键字needle");
  const preview=q('[data-schedule-id="t1"] .cq-task-text');
  const shortLength=preview?.textContent.length || 0;
  flags.longRuleSearch=rows().join(",")==="t1" &&
    preview?.querySelector("mark")?.textContent==="关键字needle" &&
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
  search("");

  for(let i=0;i<70;i++) {
    state.schedules.push({id:"extra-"+i,text:"额外规则 "+i,mode:"time",
      enabled:i%2===0,intervalMinutes:120,nextRunAt:now+120000,images:[]});
  }
  q('[data-action="show-schedule-create"]').click();
  q('[data-action="show-schedule-list"]').click();
  flags.largeListScrollable=q(".cq-schedule-results")?.scrollHeight >
    q(".cq-schedule-results")?.clientHeight &&
    rows().length===75;
  search("额外规则 69");
  flags.largeSearch=rows().join(",")==="extra-69" &&
    q(".cq-rule-result-count")?.textContent.includes("1/75");
  search("");

  document.querySelector("main").style.width="330px";
  await wait(80);
  flags.narrowNoOverflow=q(".cq-inline").scrollWidth<=q(".cq-inline").clientWidth+2 &&
    q(".cq-rule-search-row").getBoundingClientRect().width<=328;
  flags.narrowControlsAccessible=!!q("#cq-rule-kind") &&
    !!q("#cq-rule-sort") && !!q("#cq-rule-search");
 } catch(error) {flags.error=error.stack || error.message;}
 flags.ok=["defaultOrder","counter","ruleStatusBadges","enabledOnly",
   "disabledOnly","timeOnly","countOnly","searchImageByName",
   "resetVisible","noMatches","reset","escapeResets","imeKeepsInput",
   "imeUpdatesAfterCommit","nextDueOrder","disabledActions",
   "toggleStillWorks","noUnintendedDispatch","editView",
   "filterAndSortSurviveEdit","longRuleSearch","longRuleExpand",
   "longRuleCollapse","largeListScrollable","largeSearch",
   "narrowNoOverflow","narrowControlsAccessible"]
   .every(key=>flags[key]===true);
 document.body.dataset.check=JSON.stringify(flags);
},280);
</script></body></html>`);
    const result=spawnSync(browser,[
      "--headless=new","--disable-gpu","--disable-extensions","--no-first-run",
      `--user-data-dir=${path.join(folder,"profile")}`,
      "--virtual-time-budget=5500","--dump-dom",
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
