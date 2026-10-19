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

function runPriorityProbe(fullPage) {
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),"cq-priority-"));
  try {
    for(const name of ["dashboard.js","dashboard.css"])
      fs.copyFileSync(path.join(__dirname,"..",name),path.join(folder,name));
    const html=fs.readFileSync(path.join(__dirname,"..","dashboard.html"),"utf8")
      .replace('<script src="dashboard.js" defer></script>',
        '<script src="priority-mock.js"></script><script src="dashboard.js" defer></script>');
    fs.writeFileSync(path.join(folder,"dashboard.html"),html);
    fs.writeFileSync(path.join(folder,"priority-mock.js"),`"use strict";
const now=Date.now();
const mk=(key,title,state={})=>({
  key,title,url:"https://chatgpt.com/c/"+key.slice(5),tabId:10,
  browser:"loaded",pending:0,active:0,review:0,
  enabledRules:0,allRules:0,halted:false,queuePaused:false,
  activeStatus:null,activeSince:null,lastEventAt:now-10000,
  pageSignal:"idle",pageSignalAt:now-1500,recentEvents:[],...state,
});
const sessions=[
  mk("chat:review-a","重点异常甲",{review:1,halted:true,queuePaused:true}),
  mk("chat:review-b","<img src=x onerror=alert(1)>重点异常乙",
    {review:1,halted:true,queuePaused:true,lastEventAt:now-30000}),
  mk("chat:review-c","普通异常",{review:1,halted:true,queuePaused:true,lastEventAt:now-20000}),
  mk("chat:signal","重点但只是心跳待确认",
    {active:1,activeStatus:"waiting",pageSignal:"stale"}),
  mk("chat:active","正常执行",{active:1,activeStatus:"waiting",pageSignal:"generating"}),
  mk("chat:idle","空闲",{enabledRules:1,allRules:1}),
];
let prefs={favorites:["chat:review-a","chat:review-b","chat:signal"],
  layout:"list",grouped:true,compact:false};
const calls=[];
const listeners=[];
let writes=0;
window.chrome={
  runtime:{
    getURL(name){return "chrome-extension://test-queue/"+name;},
    async sendMessage(message){
      calls.push({...message});
      if(message.type!=="DASHBOARD_GET")return {ok:false,error:"UI must not operate queues"};
      return {ok:true,dashboard:{version:"0.34.0",sessions:sessions.map(s=>({...s}))}};
    },
  },
  storage:{
    local:{
      async get(key){return {[key]:JSON.parse(JSON.stringify(prefs))};},
      async set(){writes++;throw Error("Quick filter may not write preferences");},
    },
    onChanged:{addListener(fn){listeners.push(fn);}},
  },
};
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const waitUntil=async(fn,timeout=4000)=>{
  const until=Date.now()+timeout;
  while(Date.now()<until){if(fn())return true;await wait(40);}
  return Boolean(fn());
};
const q=selector=>document.querySelector(selector);
const cards=()=>[...document.querySelectorAll(".session")];
const visibleKeys=()=>cards().map(card=>card.dataset.key);
const group=(id)=>q('.session-group[data-group-id="'+id+'"]');
const setState=()=>listeners.forEach(fn=>fn({"cq.state.v2":{newValue:{}}},"local"));
const externalPrefs=next=>{
  const old=prefs;
  prefs=next;
  listeners.forEach(fn=>fn({"cq.dashboard.view.v1":{oldValue:old,newValue:next}},"local"));
};
setTimeout(async()=>{
 const f={};
 try {
  await waitUntil(()=>q("#stat-review")?.textContent==="3" &&
    q("#focus-review")?.textContent.includes("重点 2"));
  f.initialVisible=!q("#attention-review").hidden &&
    q("#attention-review-hint").textContent.includes("★ 2 个重点对话") &&
    !q("#focus-review").hidden && q("#focus-review").getAttribute("aria-pressed")==="false";
  f.realReviewOnly=cards().filter(el=>el.classList.contains("priority-review")).length===2 &&
    !cards().find(el=>el.dataset.key==="chat:signal").classList.contains("priority-review") &&
    cards().filter(el=>el.querySelector(".priority-marker")).length===2;
  f.noXss=!q("#dashboard img") &&
    q("#dashboard").textContent.includes("<img src=x onerror=alert(1)>");
  q('.group-review [data-group="review"]').click();
  const wasCollapsed=group("review")?.querySelector("[data-group]")?.getAttribute("aria-expanded")==="false";
  q('#filters [data-filter="offline"]').click();
  q("#search").value="no-match";
  q("#search").dispatchEvent(new Event("input",{bubbles:true}));
  f.hiddenBeforeFocus=wasCollapsed && cards().length===0;
  q("#focus-review").click();
  f.oneClickFilter=q("#search").value==="" &&
    q('#filters [data-filter="review"]').getAttribute("aria-pressed")==="true" &&
    q("#favorites-only").getAttribute("aria-pressed")==="true" &&
    q("#focus-review").getAttribute("aria-pressed")==="true" &&
    q("#focus-review").textContent.includes("显示全部") &&
    group("review")?.querySelector("[data-group]")?.getAttribute("aria-expanded")==="true" &&
    visibleKeys().length===2 &&
    visibleKeys().includes("chat:review-a") &&
    visibleKeys().includes("chat:review-b") &&
    cards().some(el=>el.classList.contains("located-session")) &&
    q("#feedback")?.textContent.includes("2 个重点且需人工核对");
  f.noHorizontalOverflow=document.documentElement.scrollWidth<=
    document.documentElement.clientWidth+3 &&
    q("#sessions").scrollWidth<=q("#sessions").clientWidth+3;
  q("#focus-review").click();
  f.exitClean=q('#filters [data-filter="all"]').getAttribute("aria-pressed")==="true" &&
    q("#favorites-only").getAttribute("aria-pressed")==="false" &&
    q("#focus-review").getAttribute("aria-pressed")==="false" &&
    cards().length===6;
  // Focused view survives regular queue changes and keeps an exit when
  // the last prioritized issue is resolved.
  q("#focus-review").click();
  sessions[0].review=0;sessions[0].halted=false;sessions[0].queuePaused=false;
  setState();
  await waitUntil(()=>q("#focus-review")?.getAttribute("aria-pressed")==="true" &&
    visibleKeys().join(",")==="chat:review-b");
  f.livePriorityCount=q("#focus-review")?.textContent.includes("显示全部") &&
    q("#attention-review-hint")?.textContent.includes("★ 1 个重点对话");
  sessions[1].review=0;sessions[1].halted=false;sessions[1].queuePaused=false;
  setState();
  await waitUntil(()=>cards().length===0 &&
    q("#focus-review")?.getAttribute("aria-pressed")==="true");
  f.safeEmptyExit=!q("#attention-review").hidden &&
    !q("#focus-review").hidden &&
    q("#focus-review").textContent.includes("显示全部") &&
    q("#jump-review").disabled===false &&
    q("#attention-review-count").textContent.includes("1 个对话");
  q("#focus-review").click();
  f.recoveredView=cards().length===6 &&
    q("#focus-review").hidden && q("#attention-review-hint")
      .textContent.includes("来自队列存档") &&
    q("#attention-signal-count").textContent.includes("1 个执行中");
  // Browser preference changes don't require a reload and the focus
  // shortcut remains consistent in card layout.
  sessions[0].review=1;sessions[0].halted=true;sessions[0].queuePaused=true;
  setState();
  await waitUntil(()=>!q("#focus-review").hidden);
  externalPrefs({...prefs,layout:"cards",grouped:false});
  f.cardCompatibility=cards().length===6 &&
    cards().find(el=>el.dataset.key==="chat:review-a")
      ?.querySelector(".priority-marker")!==null &&
    !q("#dashboard").classList.contains("list-mode");
  q("#focus-review").click();
  f.cardQuickFilter=visibleKeys().join(",")==="chat:review-a" &&
    q("#focus-review").getAttribute("aria-pressed")==="true";
  f.noDataWrites=writes===0 && calls.every(call=>call.type==="DASHBOARD_GET");
 }catch(error){f.error=error.stack||error.message;}
 f.ok=["initialVisible","realReviewOnly","noXss","hiddenBeforeFocus",
  "oneClickFilter","noHorizontalOverflow","exitClean","livePriorityCount",
  "safeEmptyExit","recoveredView","cardCompatibility","cardQuickFilter",
  "noDataWrites"].every(key=>f[key]===true);
 document.body.dataset.priorityCheck=JSON.stringify(f);
},360);
`);
    const page="file:///" + path.join(folder,"dashboard.html").replace(/\\/g,"/") +
      (fullPage ? "?view=full" : "");
    const result=spawnSync(browser,[
      "--headless=new","--disable-gpu","--disable-extensions","--no-first-run",
      "--disable-background-networking","--force-device-scale-factor=1",
      "--window-size="+(fullPage?"1420,940":"560,900"),
      "--user-data-dir="+path.join(folder,"profile"),
      "--virtual-time-budget=10000","--dump-dom",page,
    ],{encoding:"utf8",timeout:30000,maxBuffer:12e6});
    assert.equal(result.status,0,result.stderr||"Chrome did not start");
    const match=result.stdout.match(/data-priority-check="([^"]+)"/);
    assert.ok(match,"Chrome did not complete the priority review test");
    const flags=JSON.parse(match[1].replace(/&quot;/g,'"').replace(/&amp;/g,"&"));
    assert.equal(flags.ok,true,JSON.stringify(flags));
  } finally {
    fs.rmSync(folder,{recursive:true,force:true});
  }
}

for(const mode of ["popup","full"]){
  test("真实 Chrome：重点异常快捷筛选、恢复入口与两种布局（"+mode+"）",{
    skip:!fs.existsSync(browser) && "Chrome is unavailable",
  },()=>runPriorityProbe(mode==="full"));
}
