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

function runLayoutProbe(view) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(),"cq-dashboard-list-"));
  try {
    for (const file of ["dashboard.js","dashboard.css"]) {
      fs.copyFileSync(path.join(__dirname,"..",file),path.join(folder,file));
    }
    const html = fs.readFileSync(path.join(__dirname,"..","dashboard.html"),"utf8")
      .replace('<script src="dashboard.js" defer></script>',
        '<script src="dashboard-list-mock.js"></script><script src="dashboard.js" defer></script>');
    fs.writeFileSync(path.join(folder,"dashboard.html"),html);
    fs.writeFileSync(path.join(folder,"dashboard-list-mock.js"),`"use strict";
const now=Date.now();
const sessions=[
 {key:"chat:a",title:"A 大型项目进行中",url:"https://chatgpt.com/c/a",
  tabId:11,browser:"loaded",pending:2,active:1,review:0,
  enabledRules:1,allRules:2,queuePaused:false,halted:false,
  activeStatus:"waiting",activeSince:now-65000,lastEventAt:now-35000,
  pageSignal:"generating",pageSignalAt:now-3000,
  recentEvents:[{type:"sent",at:now-35000},{type:"claim",at:now-50000}]},
 {key:"chat:b",title:"B 待人工核对",url:"https://chatgpt.com/c/b",
  tabId:null,browser:"closed",pending:1,active:0,review:1,
  enabledRules:0,allRules:0,queuePaused:true,halted:true,
  activeStatus:null,activeSince:null,lastEventAt:now-55000,
  pageSignal:"unavailable",pageSignalAt:null,
  recentEvents:[{type:"timeout",at:now-55000}]},
 {key:"chat:unsafe",title:"<img src=x onerror=alert(1)>",
  url:"https://example.com/bad",tabId:null,browser:"closed",
  pending:0,active:0,review:0,enabledRules:1,allRules:1,
  queuePaused:false,halted:false,activeStatus:null,
  activeSince:null,lastEventAt:now-80000, pageSignal:"unavailable"},
 ...Array.from({length:14},(_,i)=>({
  key:"chat:sample-"+i,title:"并行任务 "+String(i).padStart(2,"0"),
  url:"https://chatgpt.com/c/sample-"+i,tabId:i+20,
  browser:"loaded",pending:i%4,active:0,review:0,
  enabledRules:i%2,allRules:1,queuePaused:false,halted:false,
  activeStatus:null,activeSince:null,lastEventAt:now-i*10000,
  pageSignal:i%3===0?"stale":"idle",pageSignalAt:now-30000,
  recentEvents:[],
 })),
];
const messages=[];
const saved=[];
const listeners=[];
let preferences={favorites:[],compact:false};
let failNextSave=false;
window.chrome={
 runtime:{
  getURL(path){return "chrome-extension://test-queue/"+path;},
  async sendMessage(message){
   messages.push({...message});
   if(message.type!=="DASHBOARD_GET")return {ok:false,error:"unsafe dashboard action"};
   return {ok:true,dashboard:{version:"0.30.0",sessions:sessions.map(item=>({...item}))}};
  },
 },
 storage:{
  local:{
   async get(key){return {[key]:JSON.parse(JSON.stringify(preferences))};},
   async set(change){
    if(failNextSave){failNextSave=false;throw Error("simulated storage failure");}
    const before=preferences;
    preferences=JSON.parse(JSON.stringify(change["cq.dashboard.view.v1"]));
    saved.push(preferences);
    listeners.forEach(fn=>fn({
      "cq.dashboard.view.v1":{oldValue:before,newValue:preferences},
    },"local"));
   },
  },
  onChanged:{addListener(fn){listeners.push(fn);}},
 },
};
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const waitUntil=async(fn,timeout=4500)=>{
 const until=Date.now()+timeout;
 while(Date.now()<until){
  if(fn())return true;
  await wait(40);
 }
 return Boolean(fn());
};
const q=selector=>document.querySelector(selector);
const rows=()=>[...document.querySelectorAll(".session")];
const row=key=>rows().find(item=>item.dataset.key===key);
const keys=()=>rows().map(item=>item.dataset.key);
const externalPrefs=next=>{
 const old=preferences;
 preferences=next;
 listeners.forEach(fn=>fn({"cq.dashboard.view.v1":{oldValue:old,newValue:next}},"local"));
};
setTimeout(async()=>{
 const flags={};
 try{
  await waitUntil(()=>rows().length===17 && q("#stat-active")?.textContent==="1");
  flags.initialCards=!q("#dashboard")?.classList.contains("list-mode") &&
   rows().every(item=>!item.classList.contains("monitor-row"));
  const switcher=q("#layout-toggle");
  switcher.click();
  await waitUntil(()=>q("#dashboard")?.classList.contains("list-mode") &&
   row("chat:a")?.classList.contains("monitor-row") && !switcher.disabled);
  flags.listSaved=preferences.layout==="list" &&
   switcher.getAttribute("aria-pressed")==="true" &&
   switcher.textContent.includes("卡片视图") &&
   saved.at(-1).layout==="list";
  flags.allVisible=rows().length===17 && keys()[0]==="chat:b" &&
   q(".monitor-columns")?.children.length===6;
  flags.layoutMatchesViewport=(
    getComputedStyle(q(".monitor-columns")).display===
      (document.documentElement.dataset.view==="full"?"grid":"none")
  );
  const first=row("chat:a");
  const collapsedHeight=first.getBoundingClientRect().height;
  flags.compactRows=collapsedHeight<
    (document.documentElement.dataset.view==="full"?125:215);
  flags.coreStatus=first.querySelector(".monitor-counts")?.textContent.includes("2") &&
   first.querySelector(".status.active")?.textContent.includes("等待回复") &&
   first.querySelector(".monitor-signal.generating")?.textContent.includes("检测到停止按钮") &&
   first.querySelector('[data-time-kind="stage"]')?.textContent.includes("记录已持续");
  flags.unsafeAndHaltedProtected=row("chat:b")?.querySelector('[data-action="pause"]')?.disabled===true &&
   row("chat:unsafe")?.querySelector('[data-action="open"]')?.disabled===true &&
   !row("chat:unsafe")?.querySelector("img");
  const details=first.querySelector('[data-action="details"]');
  details.focus();
  details.click();
  flags.detailsExpanded=row("chat:a")?.querySelector('[data-action="details"]')
     ?.getAttribute("aria-expanded")==="true" &&
    row("chat:a")?.querySelector(".monitor-details")?.textContent.includes("自动规则 1/2") &&
    row("chat:a")?.querySelector(".monitor-details")?.textContent.includes("最近心跳") &&
    document.activeElement?.dataset.action==="details";
  row("chat:a").querySelector('[data-action="activity"]').click();
  flags.activityReused=row("chat:a")?.querySelector(".activity-timeline")?.textContent.includes("已点击发送");
  sessions[0].pending=3;
  sessions[0].lastEventAt=Date.now();
  sessions[0].recentEvents.unshift({type:"task_pinned",at:Date.now()});
  listeners.forEach(fn=>fn({"cq.state.v2":{newValue:{}}},"local"));
  await waitUntil(()=>q("#stat-pending")?.textContent==="23");
  flags.expandedOnRefresh=row("chat:a")?.querySelector('[data-action="details"]')
    ?.getAttribute("aria-expanded")==="true" &&
    row("chat:a")?.querySelector(".activity-timeline")?.textContent.includes("任务置顶");
  row("chat:a").querySelector('[data-action="details"]').click();
  flags.detailsCollapsed=!row("chat:a")?.querySelector(".monitor-details");
  const star=row("chat:a").querySelector('[data-action="favorite"]');
  star.focus();
  star.click();
  await waitUntil(()=>preferences.favorites.includes("chat:a") &&
   !switcher.disabled && document.activeElement?.dataset.action==="favorite");
  flags.favoriteKeepsLayout=preferences.layout==="list" &&
   row("chat:a")?.querySelector('[data-action="favorite"]')?.getAttribute("aria-pressed")==="true" &&
   document.activeElement?.dataset.action==="favorite";
  // Switch layout twice: information, focus and saved view preferences survive.
  switcher.click();
  await waitUntil(()=>!q("#dashboard").classList.contains("list-mode") &&
   !switcher.disabled);
  flags.backToCards=preferences.layout==="cards" &&
    row("chat:a")?.querySelector(".session-metrics") &&
    !row("chat:a")?.querySelector(".monitor-main");
  switcher.click();
  await waitUntil(()=>q("#dashboard").classList.contains("list-mode") &&
   !switcher.disabled);
  flags.returnToList=preferences.layout==="list" &&
    row("chat:a")?.querySelector(".monitor-main") &&
    row("chat:a")?.querySelector('[data-action="favorite"]')?.getAttribute("aria-pressed")==="true";
  // Keyboard shortcut must not steal normal typing; Escape clears only search.
  q("#refresh").focus();
  document.dispatchEvent(new KeyboardEvent("keydown",{key:"/",bubbles:true}));
  flags.slashSearch=document.activeElement===q("#search");
  const search=q("#search");
  search.value="sample-13";
  search.dispatchEvent(new Event("input",{bubbles:true}));
  flags.liveSearch=keys().join(",")==="chat:sample-13";
  search.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}));
  flags.escapeClears=search.value==="" && rows().length===17 &&
    document.activeElement===search;
  // Other dashboard instances can switch layouts through the existing key.
  externalPrefs({favorites:["chat:a"],compact:false,layout:"cards"});
  flags.crossViewSync=!q("#dashboard").classList.contains("list-mode") &&
    q("#layout-toggle").getAttribute("aria-pressed")==="false";
  failNextSave=true;
  switcher.click();
  await waitUntil(()=>q("#feedback")?.textContent.includes("视图偏好保存失败"));
  flags.failedSaveKeepsLayout=preferences.layout==="cards" &&
    !q("#dashboard").classList.contains("list-mode") &&
    q("#feedback").classList.contains("error");
  flags.noHorizontalOverflow=document.documentElement.scrollWidth<=
    document.documentElement.clientWidth+3 &&
    q("#sessions").scrollWidth<=q("#sessions").clientWidth+3;
  flags.noQueueMutation=messages.every(message=>message.type==="DASHBOARD_GET");
  flags.privacy=JSON.stringify(preferences).includes("prompt")===false &&
    !document.querySelector(".monitor-row img") &&
    !document.querySelector("#dashboard textarea");
 }catch(error){flags.error=error.stack||error.message;}
 flags.ok=["initialCards","listSaved","allVisible","layoutMatchesViewport",
  "compactRows","coreStatus","unsafeAndHaltedProtected","detailsExpanded",
  "activityReused","expandedOnRefresh","detailsCollapsed","favoriteKeepsLayout",
  "backToCards","returnToList","slashSearch","liveSearch","escapeClears",
  "crossViewSync","failedSaveKeepsLayout","noHorizontalOverflow",
  "noQueueMutation","privacy"].every(key=>flags[key]===true);
 document.body.dataset.test=JSON.stringify(flags);
},400);
`);
    const uri = "file:///" + path.join(folder,"dashboard.html").replace(/\\/g,"/") +
      (view === "full" ? "?view=full" : "");
    const run=spawnSync(browser,[
      "--headless=new","--disable-gpu","--disable-extensions","--no-first-run",
      "--force-device-scale-factor=1",
      "--window-size=" + (view === "full" ? "1460,940" : "560,900"),
      "--user-data-dir=" + path.join(folder,"profile"),
      "--virtual-time-budget=11000","--dump-dom",uri,
    ],{encoding:"utf8",timeout:28000,maxBuffer:10e6});
    assert.equal(run.status,0,run.stderr || "Chrome failed to start");
    const match=run.stdout.match(/data-test="([^"]+)"/);
    assert.ok(match,"Chrome did not finish list layout probe");
    const flags=JSON.parse(match[1].replace(/&quot;/g,'"').replace(/&amp;/g,"&"));
    assert.equal(flags.ok,true,JSON.stringify(flags));
  } finally {
    fs.rmSync(folder,{recursive:true,force:true});
  }
}

for (const view of ["popup","full"]) {
  test("真实 Chrome：高密度列表、详情展开、偏好同步和键盘导航（"+view+"）",{
    skip:!fs.existsSync(browser) && "Chrome is not installed",
  },()=>runLayoutProbe(view));
}
