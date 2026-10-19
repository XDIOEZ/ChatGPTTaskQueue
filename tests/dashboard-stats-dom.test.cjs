"use strict";

const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const os=require("node:os");
const path=require("node:path");
const {spawnSync}=require("node:child_process");

const browser=process.env.CQ_BROWSER_BIN || (process.platform==="win32"
  ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
  : "/usr/bin/google-chrome");

function probe(full) {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),"cq-stats-ui-"));
  try {
    for (const filename of ["dashboard.js","dashboard.css"]) {
      fs.copyFileSync(path.join(__dirname,"..",filename),path.join(directory,filename));
    }
    const html=fs.readFileSync(path.join(__dirname,"..","dashboard.html"),"utf8")
      .replace('<script src="dashboard.js" defer></script>',
        '<script src="stats-mock.js"></script><script src="dashboard.js" defer></script>');
    fs.writeFileSync(path.join(directory,"dashboard.html"),html);
    fs.writeFileSync(path.join(directory,"stats-mock.js"),`"use strict";
const now=Date.now();
const make=(key,title,extra={})=>({
 key,title,url:"https://chatgpt.com/c/"+key.slice(5),
 tabId:10,browser:"loaded",pending:0,active:0,review:0,
 enabledRules:0,allRules:0,halted:false,queuePaused:false,
 activeStatus:null,activeSince:null,lastEventAt:now-10000,
 pageSignal:"idle",pageSignalAt:now-1000,recentEvents:[],...extra,
});
const entries=[
 make("chat:review","重点异常",{review:2,halted:true,queuePaused:true}),
 make("chat:active","执行中",{active:1,activeStatus:"waiting"}),
 make("chat:pending-a","等待任务 A",{pending:3}),
 make("chat:pending-b","等待任务 B",{pending:1}),
 make("chat:paused","暂停中",{queuePaused:true}),
 make("chat:rules","等待规则触发",{enabledRules:1,allRules:1}),
 make("chat:idle","空闲对话"),
 make("chat:stale","页面心跳过期但仍有任务",{
  active:1,activeStatus:"waiting",pageSignal:"stale",
 }),
];
let preferences={favorites:["chat:review"],compact:false,layout:"cards",grouped:false,focus:false};
const calls=[];
const listeners=[];
window.chrome={
 runtime:{
  getURL(value){return "chrome-extension://test-queue/"+value;},
  async sendMessage(message){
   calls.push({...message});
   if(message.type!=="DASHBOARD_GET")return {ok:false,error:"UI cannot mutate queues"};
   return {ok:true,dashboard:{version:"0.41.0",sessions:entries.map(x=>({...x})),cleanupEligible:0}};
  },
 },
 storage:{
  local:{
   async get(key){return {[key]:JSON.parse(JSON.stringify(preferences))};},
   async set(change){
    const previous=preferences;
    preferences=JSON.parse(JSON.stringify(change["cq.dashboard.view.v1"]));
    listeners.forEach(fn=>fn({"cq.dashboard.view.v1":{
      oldValue:previous,newValue:preferences,
    }},"local"));
   },
  },
  onChanged:{addListener(fn){listeners.push(fn);}},
 },
};
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const until=async(fn,max=5000)=>{
 const end=Date.now()+max;
 while(Date.now()<end){if(fn())return true;await wait(45);}
 return Boolean(fn());
};
const q=(selector)=>document.querySelector(selector);
const cards=()=>[...document.querySelectorAll(".session")];
const keys=()=>cards().map(c=>c.dataset.key);
const stat=kind=>q('button[data-stat-filter="'+kind+'"]');
const filter=kind=>q('button[data-filter="'+kind+'"]');
const notify=()=>listeners.forEach(fn=>fn({"cq.state.v2":{newValue:{}}},"local"));
setTimeout(async()=>{
 const f={};
 try {
  await until(()=>q("#stat-pending")?.textContent==="4" &&
    cards().length===8 && q(".filter-count")?.textContent==="8");
  f.statValues=q("#stat-chats").textContent==="6" &&
    q("#stat-pending").textContent==="4" &&
    q("#stat-active").textContent==="2" &&
    q("#stat-review").textContent==="2";
  f.conversationCounts=filter("all").querySelector(".filter-count")?.textContent==="8" &&
    filter("review").querySelector(".filter-count")?.textContent==="1" &&
    filter("busy").querySelector(".filter-count")?.textContent==="6" &&
    filter("paused").querySelector(".filter-count")?.textContent==="2" &&
    filter("nosignal").querySelector(".filter-count")?.textContent==="1";
  f.tasksVsChats=stat("pending").getAttribute("aria-label").includes("4 条任务") &&
    stat("pending").getAttribute("aria-label").includes("2 个对话") &&
    stat("review").getAttribute("aria-label").includes("2 条任务") &&
    stat("review").getAttribute("aria-label").includes("1 个对话");
  f.accessibleButtons=[...document.querySelectorAll(".stat-shortcut")].length===4 &&
    [...document.querySelectorAll(".stat-shortcut")]
      .every(b=>b.tagName==="BUTTON" && b.tabIndex===0 && b.getAttribute("aria-pressed")==="false");

  q("#search").value="nonmatching";
  q("#search").dispatchEvent(new Event("input",{bubbles:true}));
  q("#favorites-only").click();
  f.wasFiltered=cards().length===0;
  stat("pending").focus();
  stat("pending").click();
  f.pendingDrilldown=keys().length===2 &&
    keys().includes("chat:pending-a") && keys().includes("chat:pending-b") &&
    stat("pending").getAttribute("aria-pressed")==="true" &&
    q("#search").value==="" &&
    q("#favorites-only").getAttribute("aria-pressed")==="false" &&
    q("#result-count").textContent.includes("显示 2 / 8 个对话") &&
    document.activeElement===stat("pending") &&
    calls.every(x=>x.type==="DASHBOARD_GET");
  stat("pending").click();
  f.statToggleBack=cards().length===8 &&
    stat("pending").getAttribute("aria-pressed")==="false";

  q("#group-toggle").click();
  await until(()=>q("#dashboard").classList.contains("grouped-mode"));
  q(".group-review [data-group='review']").click();
  f.reviewCollapsed=q(".group-review [data-group='review']")
    ?.getAttribute("aria-expanded")==="false";
  stat("review").click();
  f.reviewExpands=stat("review").getAttribute("aria-pressed")==="true" &&
    keys().join(",")==="chat:review" &&
    q(".group-review [data-group='review']").getAttribute("aria-expanded")==="true" &&
    filter("review").getAttribute("aria-pressed")==="true";
  stat("active").click();
  f.activeDrilldown=keys().length===2 &&
    keys().includes("chat:active") && keys().includes("chat:stale") &&
    stat("active").getAttribute("aria-pressed")==="true" &&
    filter("review").getAttribute("aria-pressed")==="false";
  stat("busy").click();
  f.busyDrilldown=cards().length===6 &&
    stat("busy").getAttribute("aria-pressed")==="true";

  q("#focus-mode").click();
  await until(()=>preferences.focus===true &&
    q("#dashboard").classList.contains("focus-mode"));
  stat("active").click();
  f.focusStillAccessible=stat("active").getAttribute("aria-pressed")==="true" &&
    getComputedStyle(q("#filters")).display==="none" &&
    q("#focus-filter-summary").textContent.includes("执行中") &&
    cards().length===2 && !q("#focus-reset").hidden;
  q("#focus-reset").click();
  f.focusReset=q("#focus-filter-summary").textContent.includes("全部对话") &&
    stat("active").getAttribute("aria-pressed")==="false" &&
    cards().length===8;

  entries[0].review=0;
  entries[0].halted=false;
  entries[0].queuePaused=false;
  notify();
  await until(()=>q("#stat-review").textContent==="0" &&
    filter("review").querySelector(".filter-count").textContent==="0");
  stat("review").click();
  f.emptyRecovery=cards().length===0 &&
    q(".empty-reset")?.textContent==="查看全部对话" &&
    stat("review").getAttribute("aria-pressed")==="true";
  q(".empty-reset").click();
  f.emptyRestored=cards().length===8 &&
    stat("review").getAttribute("aria-pressed")==="false" &&
    document.activeElement===q("#search");
  f.noOverflow=document.documentElement.scrollWidth<=
    document.documentElement.clientWidth+3 &&
    q("#sessions").scrollWidth<=q("#sessions").clientWidth+3;
  f.noQueueActions=calls.every(call=>call.type==="DASHBOARD_GET");
 }catch(error){f.error=error.stack||error.message;}
 f.ok=["statValues","conversationCounts","tasksVsChats","accessibleButtons",
  "wasFiltered","pendingDrilldown","statToggleBack","reviewCollapsed",
  "reviewExpands","activeDrilldown","busyDrilldown","focusStillAccessible",
  "focusReset","emptyRecovery","emptyRestored","noOverflow",
  "noQueueActions"].every(key=>f[key]===true);
 document.body.dataset.statsProbe=JSON.stringify(f);
},360);
`);
    const page="file:///"+path.join(directory,"dashboard.html").replace(/\\/g,"/")+
      (full?"?view=full":"");
    const run=spawnSync(browser,[
      "--headless=new","--disable-gpu","--disable-extensions","--no-first-run",
      "--disable-background-networking","--disable-component-update",
      "--disable-sync","--no-default-browser-check","--no-sandbox",
      "--force-device-scale-factor=1",
      "--window-size="+(full?"1400,940":"560,900"),
      "--user-data-dir="+path.join(directory,"profile"),
      "--virtual-time-budget=11500","--dump-dom",page,
    ],{encoding:"utf8",timeout:55000,maxBuffer:12e6});
    assert.equal(run.status,0,run.stderr||"Headless browser could not start");
    const found=run.stdout.match(/data-stats-probe="([^"]+)"/);
    assert.ok(found,"Browser did not finish stats filter probe");
    const flags=JSON.parse(found[1].replace(/&quot;/g,'"').replace(/&amp;/g,"&"));
    assert.equal(flags.ok,true,JSON.stringify(flags));
  } finally {
    fs.rmSync(directory,{recursive:true,force:true});
  }
}

for(const view of ["popup","full"]){
  if(process.env.CQ_STATS_VIEW && process.env.CQ_STATS_VIEW!==view)continue;
  test("真实 Chromium：统计卡片状态钻取、数量语义和空结果恢复（"+view+"）",{
    skip:!fs.existsSync(browser) && "Chrome/Edge unavailable",
  },()=>probe(view==="full"));
}
