"use strict";

const {test} = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const {spawnSync} = require("node:child_process");

const browser = process.env.CQ_BROWSER_BIN || (process.platform==="win32"
  ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
  : "/usr/bin/google-chrome");

function runFocusProbe(full) {
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),"cq-dashboard-focus-"));
  try {
    for(const file of ["dashboard.js","dashboard.css"]) {
      fs.copyFileSync(path.join(__dirname,"..",file),path.join(folder,file));
    }
    const html=fs.readFileSync(path.join(__dirname,"..","dashboard.html"),"utf8")
      .replace('<script src="dashboard.js" defer></script>',
        '<script src="focus-mock.js"></script><script src="dashboard.js" defer></script>');
    fs.writeFileSync(path.join(folder,"dashboard.html"),html);
    fs.writeFileSync(path.join(folder,"focus-mock.js"),`"use strict";
const now=Date.now();
const entries=[
 {key:"chat:review",title:"重要项目需核对",url:"https://chatgpt.com/c/review",
  tabId:11,browser:"loaded",pending:1,active:0,review:1,
  enabledRules:0,allRules:0,halted:true,queuePaused:true,
  activeStatus:null,lastEventAt:now-8000,pageSignal:"idle",recentEvents:[]},
 {key:"chat:signal",title:"项目执行中待确认",url:"https://chatgpt.com/c/signal",
  tabId:12,browser:"loaded",pending:2,active:1,review:0,
  enabledRules:1,allRules:1,halted:false,queuePaused:false,
  activeStatus:"waiting",activeSince:now-30000,lastEventAt:now-30000,
  pageSignal:"stale",pageSignalAt:now-40000,recentEvents:[]},
 {key:"chat:paused",title:"项目暂停中",url:"https://chatgpt.com/c/paused",
  tabId:13,browser:"loaded",pending:2,active:0,review:0,
  enabledRules:0,allRules:0,halted:false,queuePaused:true,
  activeStatus:null,lastEventAt:now-10000,pageSignal:"idle",recentEvents:[]},
 ...Array.from({length:15},(_,i)=>({
  key:"chat:other-"+i,title:"普通会话 "+i,
  url:"https://chatgpt.com/c/other-"+i,
  tabId:i+20,browser:"loaded",pending:i%3,active:0,review:0,
  enabledRules:0,allRules:0,halted:false,queuePaused:false,
  activeStatus:null,lastEventAt:now-i*10000,pageSignal:"idle",recentEvents:[],
 })),
];
const calls=[];
let prefs={favorites:["chat:review"],compact:false,layout:"cards",grouped:false};
let failNextSave=false;
const saved=[];
const listeners=[];
window.chrome={
 runtime:{
  getURL(path){return "chrome-extension://test-queue/"+path;},
  async sendMessage(message){
   calls.push({...message});
   if(message.type!=="DASHBOARD_GET")return {ok:false,error:"Unexpected queue operation"};
   return {ok:true,dashboard:{version:"0.37.0",sessions:entries.map(item=>({...item})),
     cleanupEligible:3}};
  },
 },
 storage:{
  local:{
   async get(key){return {[key]:JSON.parse(JSON.stringify(prefs))};},
   async set(change){
    if(failNextSave){failNextSave=false;throw Error("simulated view save failure");}
    const oldPrefs=prefs;
    prefs=JSON.parse(JSON.stringify(change["cq.dashboard.view.v1"]));
    saved.push(prefs);
    listeners.forEach(fn=>fn({"cq.dashboard.view.v1":{
      oldValue:oldPrefs,newValue:prefs,
    }},"local"));
   },
  },
  onChanged:{addListener(fn){listeners.push(fn);}},
 },
};
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const until=async(check,timeout=4300)=>{
 const end=Date.now()+timeout;
 while(Date.now()<end){if(check())return true;await sleep(45);}
 return Boolean(check());
};
const q=selector=>document.querySelector(selector);
const updateSnapshot=()=>listeners.forEach(fn=>fn({"cq.state.v2":{newValue:{}}},"local"));
const external=next=>{
 const old=prefs;
 prefs=next;
 listeners.forEach(fn=>fn({"cq.dashboard.view.v1":{
  oldValue:old,newValue:next,
 }},"local"));
};
setTimeout(async()=>{
 const f={};
 try {
  await until(()=>q("#stat-active")?.textContent==="1" &&
    q("#focus-mode")?.getAttribute("aria-pressed")==="false");
  const headerHeight=q(".header").getBoundingClientRect().height;
  const statsHeight=q(".stats").getBoundingClientRect().height;
  f.legacyFullControls=!q("#dashboard").classList.contains("focus-mode") &&
    q("#focus-tools").hidden &&
    getComputedStyle(q("#filters")).display==="flex" &&
    getComputedStyle(q(".sort-line")).display==="flex" &&
    q("#cleanup-idle").textContent.includes("3");
  const search=q("#search");
  search.value="项目";
  search.dispatchEvent(new Event("input",{bubbles:true}));
  q('#filters [data-filter="review"]').click();
  q("#favorites-only").click();
  const sort=q("#sort-order");
  sort.value="recent";
  sort.dispatchEvent(new Event("change",{bubbles:true}));
  q("#focus-mode").click();
  await until(()=>prefs.focus===true && !q("#focus-mode").disabled &&
    q("#dashboard").classList.contains("focus-mode"));
  f.saved=!!saved.length && saved.at(-1).focus===true &&
    prefs.favorites.join(",")==="chat:review" && !prefs.compact &&
    q("#focus-mode").getAttribute("aria-pressed")==="true";
  f.compacted=q(".header").getBoundingClientRect().height<headerHeight &&
    q(".stats").getBoundingClientRect().height<statsHeight &&
    q("#attention").hidden===false && q("#stat-review").textContent==="1";
  f.summary=q("#focus-filter-summary").textContent.includes("需核对") &&
    q("#focus-filter-summary").textContent.includes("仅重点") &&
    q("#focus-filter-summary").textContent.includes("搜索中") &&
    q("#focus-filter-summary").textContent.includes("最近动作优先") &&
    !q("#focus-reset").hidden &&
    getComputedStyle(q("#filters")).display==="none" &&
    getComputedStyle(q(".sort-line")).display==="none";
  f.monitoringArea=!!q(".session") &&
    (document.documentElement.dataset.view==="popup"
      ? getComputedStyle(q(".sessions")).maxHeight==="none" &&
        q("#dashboard").getBoundingClientRect().height<=603 &&
        q(".sessions").getBoundingClientRect().height>0
      : getComputedStyle(q(".sessions")).maxHeight==="none");
  q("#focus-reset").click();
  f.clearOnlyFilters=search.value==="" &&
    q('#filters [data-filter="all"]').getAttribute("aria-pressed")==="true" &&
    q("#favorites-only").getAttribute("aria-pressed")==="false" &&
    q("#sort-order").value==="recent" &&
    q("#focus-filter-summary").textContent.includes("最近动作优先") &&
    q("#focus-reset").hidden &&
    document.activeElement===search &&
    saved.length===1;
  const more=q("#focus-advanced-toggle");
  more.focus();
  more.click();
  f.advancedExpanded=more.getAttribute("aria-expanded")==="true" &&
    getComputedStyle(q("#filters")).display==="flex" &&
    getComputedStyle(q(".sort-line")).display==="flex" &&
    document.activeElement===more;
  q('#filters [data-filter="paused"]').click();
  updateSnapshot();
  await until(()=>q("#focus-filter-summary").textContent.includes("已暂停"));
  f.advancedSurvivesUpdate=more.getAttribute("aria-expanded")==="true" &&
    getComputedStyle(q("#filters")).display==="flex";
  more.click();
  f.advancedCollapses=more.getAttribute("aria-expanded")==="false" &&
    getComputedStyle(q("#filters")).display==="none" &&
    q("#focus-filter-summary").textContent.includes("已暂停");
  q("#density-toggle").click();
  await until(()=>prefs.compact===true && !q("#density-toggle").disabled);
  f.otherPreferencesKeepFocus=prefs.focus===true &&
    q("#dashboard").classList.contains("focus-mode") && saved.at(-1).focus===true;
  q("#focus-mode").click();
  await until(()=>prefs.focus===false && !q("#focus-mode").disabled);
  f.exitRetainsFilter=!q("#dashboard").classList.contains("focus-mode") &&
    getComputedStyle(q("#filters")).display==="flex" &&
    q("#focus-tools").hidden &&
    q('#filters [data-filter="paused"]').getAttribute("aria-pressed")==="true";
  // A second management view can enable focus mode through the stored
  // preferences; this view must react without a reload.
  external({...prefs,compact:false,focus:true});
  f.externalSync=q("#dashboard").classList.contains("focus-mode") &&
    q("#focus-mode").getAttribute("aria-pressed")==="true" &&
    q("#focus-tools").hidden===false;
  external({...prefs,focus:false});
  failNextSave=true;
  q("#focus-mode").click();
  await until(()=>q("#feedback").textContent.includes("视图偏好保存失败"));
  f.failedSaveDoesNotLie=prefs.focus===false &&
    !q("#dashboard").classList.contains("focus-mode") &&
    q("#focus-mode").getAttribute("aria-pressed")==="false";
  f.noOverflow=document.documentElement.scrollWidth<=
    document.documentElement.clientWidth+3 &&
    q("#sessions").scrollWidth<=q("#sessions").clientWidth+3;
  f.noQueueActions=calls.every(call=>call.type==="DASHBOARD_GET");
 }catch(error){f.error=error.stack||error.message;}
 f.ok=["legacyFullControls","saved","compacted","summary","monitoringArea",
  "clearOnlyFilters","advancedExpanded","advancedSurvivesUpdate",
  "advancedCollapses","otherPreferencesKeepFocus","exitRetainsFilter",
  "externalSync","failedSaveDoesNotLie","noOverflow","noQueueActions"]
  .every(key=>f[key]===true);
 document.body.dataset.focusProbe=JSON.stringify(f);
},400);
`);
    const uri="file:///"+path.join(folder,"dashboard.html").replace(/\\/g,"/")+
      (full?"?view=full":"");
    const run=spawnSync(browser,[
      "--headless=new","--disable-gpu","--disable-extensions","--no-first-run",
      "--disable-background-networking","--force-device-scale-factor=1",
      "--window-size="+(full?"1420,940":"560,900"),
      "--user-data-dir="+path.join(folder,"profile"),
      "--virtual-time-budget=10000","--dump-dom",uri,
    ],{encoding:"utf8",timeout:30000,maxBuffer:12e6});
    assert.equal(run.status,0,run.stderr||"Chromium did not run focus UI probe");
    const match=run.stdout.match(/data-focus-probe="([^"]+)"/);
    assert.ok(match,"Chromium did not complete focus UI probe");
    const flags=JSON.parse(match[1].replace(/&quot;/g,'"').replace(/&amp;/g,"&"));
    assert.equal(flags.ok,true,JSON.stringify(flags));
  } finally {
    fs.rmSync(folder,{recursive:true,force:true});
  }
}

for(const kind of ["popup","full"]){
  if (process.env.CQ_FOCUS_VIEW && process.env.CQ_FOCUS_VIEW !== kind) continue;
  test("真实 Chrome 管理页：专注布局、筛选摘要、焦点与偏好同步（"+kind+"）",{
    skip:!fs.existsSync(browser) && "Chrome is not installed",
  },()=>runFocusProbe(kind==="full"));
}
