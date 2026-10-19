"use strict";

const {test} = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {spawnSync} = require("node:child_process");

const browser = process.env.CQ_BROWSER_BIN || (process.platform === "win32"
  ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
  : "/usr/bin/google-chrome");

function probe(fullPage) {
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),"cq-attention-"));
  try {
    for(const filename of ["dashboard.css","dashboard.js"]) {
      fs.copyFileSync(path.join(__dirname,"..",filename),path.join(folder,filename));
    }
    const html=fs.readFileSync(path.join(__dirname,"..","dashboard.html"),"utf8")
      .replace('<script src="dashboard.js" defer></script>',
        '<script src="attention-mock.js"></script><script src="dashboard.js" defer></script>');
    fs.writeFileSync(path.join(folder,"dashboard.html"),html);
    fs.writeFileSync(path.join(folder,"attention-mock.js"),`"use strict";
const now=Date.now();
const conversation=(key,title,data)=>({
 key,title,url:"https://chatgpt.com/c/"+key.slice(5),tabId:12,
 browser:"loaded",pending:0,active:0,review:0,enabledRules:0,allRules:0,
 halted:false,queuePaused:false,activeStatus:null,activeSince:null,
 lastEventAt:now-50000,pageSignal:"idle",pageSignalAt:now-2000,
 recentEvents:[],...data,
});
const sessions=[
 conversation("chat:review-a","第一条核对",{review:1,halted:true,queuePaused:true,lastEventAt:now-20000}),
 conversation("chat:review-b","<img src=x onerror=alert(1)>第二条核对",
  {review:2,halted:true,queuePaused:true,lastEventAt:now-35000}),
 conversation("chat:stale","心跳过期",{active:1,activeStatus:"waiting",pageSignal:"stale",lastEventAt:now-30000}),
 conversation("chat:unknown","等待心跳",{active:1,activeStatus:"waiting",pageSignal:"unknown",lastEventAt:now-40000}),
 conversation("chat:running","页面检测正常",{active:1,activeStatus:"waiting",pageSignal:"generating"}),
 conversation("chat:idle","普通空闲对话",{enabledRules:1,allRules:1}),
];
const calls=[];
const observers=[];
const prefs={favorites:[],compact:false,layout:"list",grouped:true};
window.chrome={
 runtime:{
  getURL(name){return "chrome-extension://test-queue/"+name;},
  async sendMessage(message){
   calls.push({...message});
   if(message.type!=="DASHBOARD_GET")return {ok:false,error:"Not authorized"};
   return {ok:true,dashboard:{version:"0.32.0",sessions:sessions.map(s=>({...s}))}};
  },
 },
 storage:{
  local:{
   async get(key){return {[key]:JSON.parse(JSON.stringify(prefs))};},
   async set(){throw Error("Navigation must not change preferences");},
  },
  onChanged:{addListener(fn){observers.push(fn);}},
 },
};
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const waitUntil=async(fn,max=4000)=>{
 const end=Date.now()+max;
 while(Date.now()<end) {if(fn())return true;await wait(45);}
 return Boolean(fn());
};
const q=selector=>document.querySelector(selector);
const cards=()=>[...document.querySelectorAll(".session")];
const located=()=>q(".session.located-session");
const triggerRefresh=()=>observers.forEach(fn=>fn({"cq.state.v2":{newValue:{}}},"local"));
setTimeout(async()=>{
 const flags={};
 try{
  await waitUntil(()=>q("#stat-active")?.textContent==="3" &&
    q("#attention-review-count")?.textContent.includes("2 个对话") &&
    q("#attention-signal-count")?.textContent.includes("2 个执行中"));
  flags.countsAndSemantics=!q("#attention")?.hidden &&
    !q("#attention-review")?.hidden && !q("#attention-signal")?.hidden &&
    q("#attention-signal")?.textContent.includes("不代表任务失败") &&
    q("#jump-review")?.textContent.includes("1/2");
  flags.noSpoofedHtml=!q("#dashboard img") &&
    document.body.textContent.includes("<img src=x onerror=alert(1)>") &&
    !q("#dashboard iframe");
  q(".group-review .session-group-toggle").click();
  flags.reviewCollapsed=q(".group-review .session-group-toggle")
    ?.getAttribute("aria-expanded")==="false";
  q('#filters [data-filter="offline"]').click();
  q("#favorites-only").click();
  const search=q("#search");
  search.value="intentionally-no-matches";
  search.dispatchEvent(new Event("input",{bubbles:true}));
  flags.filteredOut=cards().length===0 &&
    q('#filters [data-filter="offline"]').getAttribute("aria-pressed")==="true";
  q("#jump-review").click();
  flags.jumpClearsDisplayFilters=search.value==="" &&
    q('#filters [data-filter="all"]').getAttribute("aria-pressed")==="true" &&
    q("#favorites-only").getAttribute("aria-pressed")==="false" &&
    q(".group-review .session-group-toggle").getAttribute("aria-expanded")==="true";
  flags.reviewJumpFirst=located()?.dataset.key==="chat:review-a" &&
    located()?.classList.contains("needs-review") &&
    document.activeElement?.dataset.action==="open" &&
    document.activeElement?.dataset.key==="chat:review-a" &&
    q("#feedback")?.textContent.includes("已清除筛选");
  q("#jump-review").click();
  flags.reviewJumpSecond=located()?.dataset.key==="chat:review-b" &&
    q("#jump-review").textContent.includes("1/2") &&
    q("#feedback")?.textContent.includes("<img src=x onerror=alert(1)>");
  q(".group-active .session-group-toggle").click();
  flags.activeCollapsed=q(".group-active .session-group-toggle")
    ?.getAttribute("aria-expanded")==="false";
  q("#jump-signal").click();
  flags.signalJumpExpands=located()?.dataset.key==="chat:stale" &&
    q(".group-active .session-group-toggle")?.getAttribute("aria-expanded")==="true" &&
    q("#feedback")?.textContent.includes("心跳待确认") &&
    q(".monitor-signal.stale")!==null;
  q("#jump-signal").click();
  flags.signalJumpNext=located()?.dataset.key==="chat:unknown" &&
    q("#jump-signal").textContent.includes("1/2");
  // Switch to card mode from another synchronized extension page without
  // writing the queue or triggering an unsafe action.
  observers.forEach(fn=>fn({"cq.dashboard.view.v1":{
   newValue:{favorites:[],compact:false,layout:"cards",grouped:false},
  }},"local"));
  flags.cardsCompatible=located()?.dataset.key==="chat:unknown" &&
    located()?.querySelector(".session-metrics")!==null &&
    !q("#dashboard").classList.contains("grouped-mode");
  // A reviewed chat no longer needs help after its state is resolved.
  for(const s of sessions.filter(item=>item.review>0)){
    s.review=0;s.halted=false;s.queuePaused=false;
  }
  triggerRefresh();
  await waitUntil(()=>q("#attention-review")?.hidden===true);
  flags.reviewAttentionClears=q("#attention-review")?.hidden===true &&
    q("#attention-signal")?.hidden===false;
  for(const s of sessions.filter(item=>item.active>0))s.pageSignal="idle";
  triggerRefresh();
  await waitUntil(()=>q("#attention")?.hidden===true);
  flags.noFalseAlarm=q("#attention").hidden===true &&
    q("#stat-active").textContent==="3";
  flags.noHorizontalOverflow=document.documentElement.scrollWidth<=
    document.documentElement.clientWidth+3 &&
    q("#sessions").scrollWidth<=q("#sessions").clientWidth+3;
  flags.queueUntouched=calls.every(call=>call.type==="DASHBOARD_GET");
 }catch(error){flags.error=error.stack||error.message;}
 flags.ok=["countsAndSemantics","noSpoofedHtml","reviewCollapsed",
  "filteredOut","jumpClearsDisplayFilters","reviewJumpFirst",
  "reviewJumpSecond","activeCollapsed","signalJumpExpands",
  "signalJumpNext","cardsCompatible","reviewAttentionClears",
  "noFalseAlarm","noHorizontalOverflow","queueUntouched"]
  .every(key=>flags[key]===true);
 document.body.dataset.attentionCheck=JSON.stringify(flags);
},350);
`);
    const page="file:///" + path.join(folder,"dashboard.html").replace(/\\/g,"/") +
      (fullPage ? "?view=full" : "");
    const run=spawnSync(browser,[
      "--headless=new","--disable-gpu","--disable-extensions","--no-first-run",
      "--force-device-scale-factor=1","--disable-background-networking",
      "--window-size="+(fullPage?"1360,940":"560,900"),
      "--user-data-dir="+path.join(folder,"profile"),
      "--virtual-time-budget=8500","--dump-dom",page,
    ],{encoding:"utf8",timeout:30000,maxBuffer:12e6});
    assert.equal(run.status,0,run.stderr||"Browser failed");
    const match=run.stdout.match(/data-attention-check="([^"]+)"/);
    assert.ok(match,"Browser did not complete attention navigation test");
    const flags=JSON.parse(match[1].replace(/&quot;/g,'"').replace(/&amp;/g,"&"));
    assert.equal(flags.ok,true,JSON.stringify(flags));
  } finally {
    fs.rmSync(folder,{recursive:true,force:true});
  }
}

for(const mode of ["popup","full"]){
  test("真实浏览器关注导航、异常循环定位及安全心跳提示（"+mode+"）",{
    skip:!fs.existsSync(browser) && "Chrome/Edge is unavailable",
  },()=>probe(mode==="full"));
}
