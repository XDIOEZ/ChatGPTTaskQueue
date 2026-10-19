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

function runStatusGroupProbe(fullPage) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(),"cq-dashboard-groups-"));
  try {
    for (const file of ["dashboard.js","dashboard.css"]) {
      fs.copyFileSync(path.join(__dirname,"..",file),path.join(folder,file));
    }
    const html=fs.readFileSync(path.join(__dirname,"..","dashboard.html"),"utf8")
      .replace('<script src="dashboard.js" defer></script>',
        '<script src="groups-mock.js"></script><script src="dashboard.js" defer></script>');
    fs.writeFileSync(path.join(folder,"dashboard.html"),html);
    fs.writeFileSync(path.join(folder,"groups-mock.js"),`"use strict";
const now=Date.now();
const mk=(key,title,state={})=>({
 key,title,url:"https://chatgpt.com/c/"+key.slice(5),tabId:1,
 browser:"loaded",pending:0,active:0,review:0,enabledRules:0,allRules:0,
 queuePaused:false,halted:false,activeStatus:null,activeSince:null,
 pageSignal:"idle",pageSignalAt:now-3000,lastEventAt:now-20000,
 recentEvents:[{type:"manual_enqueue",at:now-20000}],...state,
});
const entries=[
 mk("chat:review","甲 · 需要人工核对",{review:1,halted:true,queuePaused:true}),
 mk("chat:active","乙 · 运行中",{active:1,pending:2,activeStatus:"waiting",pageSignal:"generating"}),
 mk("chat:paused","丙 · 已暂停",{queuePaused:true,pending:1}),
 mk("chat:pending-a","丁 · 排队 A",{pending:2}),
 mk("chat:pending-b","戊 · 排队 B",{pending:1,pageSignal:"stale"}),
 mk("chat:rules","己 · 定时",{enabledRules:2,allRules:2}),
 mk("chat:idle","庚 · 空闲"),
 mk("chat:danger","<img src=x onerror=alert(1)>恶意标题",{enabledRules:1,allRules:1}),
];
let prefs={favorites:[],compact:false,layout:"cards"};
let failNextSave=false;
const messages=[];
const saved=[];
const listeners=[];
window.chrome={
 runtime:{
  getURL(path){return "chrome-extension://test-queue/"+path;},
  async sendMessage(message){
   messages.push({...message});
   if(message.type!=="DASHBOARD_GET")return {ok:false,error:"No side effects allowed"};
   return {ok:true,dashboard:{version:"0.31.0",sessions:entries.map(e=>({...e}))}};
  },
 },
 storage:{
  local:{
   async get(key){return {[key]:JSON.parse(JSON.stringify(prefs))};},
   async set(change){
    if(failNextSave){failNextSave=false;throw Error("save failure");}
    const previous=prefs;
    prefs=JSON.parse(JSON.stringify(change["cq.dashboard.view.v1"]));
    saved.push(prefs);
    listeners.forEach(fn=>fn({"cq.dashboard.view.v1":{oldValue:previous,newValue:prefs}},"local"));
   },
  },
  onChanged:{addListener(fn){listeners.push(fn);}},
 },
};
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const until=async(check,timeout=4000)=>{
 const end=Date.now()+timeout;
 while(Date.now()<end){if(check())return true;await wait(40);}
 return Boolean(check());
};
const q=(selector)=>document.querySelector(selector);
const groups=()=>[...document.querySelectorAll(".session-group")];
const group=(id)=>q('.session-group[data-group-id="'+id+'"]');
const header=(id)=>q('button.session-group-toggle[data-group="'+id+'"]');
const rows=(id)=>[...group(id)?.querySelectorAll(".session")||[]];
const filter=(type)=>q('button[data-filter="'+type+'"]').click();
const notify=()=>listeners.forEach(fn=>fn({"cq.state.v2":{newValue:{}}},"local"));
setTimeout(async()=>{
 const flags={};
 try{
  await until(()=>q("#stat-chats")?.textContent==="7" &&
    q(".session") && q("#group-toggle")?.disabled===false);
  flags.legacyDefaultsToFlat=!q("#dashboard").classList.contains("grouped-mode") &&
    !groups().length && q("#group-toggle").getAttribute("aria-pressed")==="false";
  const toggle=q("#group-toggle");
  toggle.click();
  await until(()=>prefs.grouped===true && !toggle.disabled && groups().length===6);
  flags.groupsSaved=groups().map(s=>s.dataset.groupId).join(",")===
    "review,active,paused,pending,rules,idle" &&
    toggle.getAttribute("aria-pressed")==="true" && saved.at(-1).grouped===true;
  flags.groupCounts=rows("pending").length===2 &&
    group("pending")?.querySelector(".group-count")?.textContent.includes("2 个对话") &&
    rows("review").length===1 && rows("rules").length===2;
  flags.signalIsNotReview=rows("pending").some(s=>s.dataset.key==="chat:pending-b") &&
    rows("review").every(s=>s.dataset.key!=="chat:pending-b") &&
    !q(".session-group img");
  const pending=header("pending");
  pending.focus();
  pending.click();
  flags.collapseWorks=header("pending")?.getAttribute("aria-expanded")==="false" &&
    rows("pending").length===0 &&
    document.activeElement===header("pending") &&
    group("pending")?.querySelector(".session-group-items")?.hidden===true;
  filter("review");
  flags.filterHidesGroups=groups().map(s=>s.dataset.groupId).join(",")==="review";
  filter("all");
  flags.collapseSurvivesFilter=header("pending")?.getAttribute("aria-expanded")==="false";
  header("pending").focus();
  header("pending").click();
  flags.expandWorks=rows("pending").length===2 &&
    document.activeElement===header("pending");
  // One global table header; the body is split into independent groups.
  q("#layout-toggle").click();
  await until(()=>prefs.layout==="list" && !toggle.disabled &&
    rowCheck() && q("#dashboard").classList.contains("grouped-mode"));
  function rowCheck(){return rows("review")[0]?.classList.contains("monitor-row");}
  flags.listAndGroupTogether=q(".monitor-columns")?.children.length===6 &&
    rows("active")[0]?.querySelector(".monitor-signal.generating") &&
    rows("pending").length===2 && prefs.grouped===true;
  const detail=rows("review")[0].querySelector('[data-action="details"]');
  detail.click();
  flags.detailStillWorks=Boolean(rows("review")[0]?.querySelector(".monitor-details") &&
    rows("review")[0]?.querySelector('[data-action="activity"]'));
  // Collapse a review group, then introduce a new safety stop.
  header("review").click();
  header("active").click();
  flags.reviewManuallyCollapsed=header("review").getAttribute("aria-expanded")==="false";
  const changing=entries.find(e=>e.key==="chat:pending-a");
  changing.review=1;
  changing.halted=true;
  changing.queuePaused=true;
  notify();
  await until(()=>header("review")?.getAttribute("aria-expanded")==="true" &&
    rows("review").length===2);
  flags.newReviewAutoOpens=rows("review").some(e=>e.dataset.key==="chat:pending-a") &&
    header("active").getAttribute("aria-expanded")==="false";
  flags.closedGroupStaysClosed=rows("active").length===0;
  // Existing review remains collapsed if only unrelated data changes.
  header("review").click();
  entries.find(e=>e.key==="chat:rules").enabledRules=3;
  notify();
  await wait(100);
  flags.noUnnecessaryExpand=header("review")?.getAttribute("aria-expanded")==="false";
  // No UI state may silently modify the durable queue store or bypass safety.
  flags.reviewSafety=rows("review").length===0 &&
    !q('[data-action="pause"][data-key="chat:review"]');
  header("review").click();
  flags.reviewStillProtected=rows("review")[0]?.querySelector('[data-action="pause"]')?.disabled===true;
  flags.savedTogether=prefs.grouped===true && prefs.layout==="list";
  flags.noOverflow=document.documentElement.scrollWidth<=
    document.documentElement.clientWidth+3 &&
    q("#sessions").scrollWidth<=q("#sessions").clientWidth+3;
  flags.noMutations=messages.every(m=>m.type==="DASHBOARD_GET");
  // An existing popup changes its preference; this window updates instantly.
  const old=prefs;
  prefs={favorites:[],compact:false,layout:"cards",grouped:false};
  listeners.forEach(fn=>fn({"cq.dashboard.view.v1":{oldValue:old,newValue:prefs}},"local"));
  flags.syncedAcrossViews=!groups().length &&
    toggle.getAttribute("aria-pressed")==="false" &&
    q(".session")?.classList.contains("monitor-row")===false;
  failNextSave=true;
  toggle.click();
  await until(()=>q("#feedback")?.textContent.includes("视图偏好保存失败"));
  flags.failedSaveDoesNotLie=!q("#dashboard").classList.contains("grouped-mode") &&
    prefs.grouped===false && q("#feedback").classList.contains("error");
 }catch(error){flags.error=error.stack||error.message;}
 flags.ok=["legacyDefaultsToFlat","groupsSaved","groupCounts","signalIsNotReview",
   "collapseWorks","filterHidesGroups","collapseSurvivesFilter","expandWorks",
   "listAndGroupTogether","detailStillWorks","reviewManuallyCollapsed",
   "newReviewAutoOpens","closedGroupStaysClosed","noUnnecessaryExpand",
   "reviewSafety","reviewStillProtected","savedTogether","noOverflow",
   "noMutations","syncedAcrossViews","failedSaveDoesNotLie"]
   .every(k=>flags[k]===true);
 document.body.dataset.probe=JSON.stringify(flags);
},350);
`);
    const uri="file:///" + path.join(folder,"dashboard.html").replace(/\\/g,"/") +
      (fullPage ? "?view=full" : "");
    const run=spawnSync(browser,[
      "--headless=new","--disable-gpu","--disable-extensions","--no-first-run",
      "--force-device-scale-factor=1",
      "--window-size="+(fullPage ? "1400,940" : "520,880"),
      "--user-data-dir="+path.join(folder,"profile"),
      "--virtual-time-budget=10000","--dump-dom",uri,
    ],{encoding:"utf8",timeout:30000,maxBuffer:11e6});
    assert.equal(run.status,0,run.stderr || "Chrome did not start");
    const match=run.stdout.match(/data-probe="([^"]+)"/);
    assert.ok(match,"Chrome did not complete the status groups test");
    const flags=JSON.parse(match[1].replace(/&quot;/g,'"').replace(/&amp;/g,"&"));
    assert.equal(flags.ok,true,JSON.stringify(flags));
  } finally {
    fs.rmSync(folder,{recursive:true,force:true});
  }
}

for(const mode of ["popup","full"]){
  test("真实 Chrome 状态分组、折叠、新异常自动展开及偏好同步（"+mode+"）",{
    skip:!fs.existsSync(browser) && "Chrome is not installed",
  },()=>runStatusGroupProbe(mode==="full"));
}
