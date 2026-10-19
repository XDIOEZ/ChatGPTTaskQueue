"use strict";

const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const os=require("node:os");
const {spawnSync}=require("node:child_process");

const browser=process.env.CQ_BROWSER_BIN || (process.platform==="win32"
  ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
  : "/usr/bin/google-chrome");

test("真实 Chrome：重点会话标记持久化、紧凑视图、事件时间线和跨面板同步",{
  skip:!fs.existsSync(browser) && "Chrome is not installed",
},()=>{
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),"cq-dashboard-view-"));
  try {
    for(const filename of ["dashboard.js","dashboard.css"]) {
      fs.copyFileSync(path.join(__dirname,"..",filename),path.join(folder,filename));
    }
    const html=fs.readFileSync(path.join(__dirname,"..","dashboard.html"),"utf8")
      .replace('<script src="dashboard.js" defer></script>',
        '<script src="dashboard-view-mock.js"></script><script src="dashboard.js" defer></script>');
    fs.writeFileSync(path.join(folder,"dashboard.html"),html);
    fs.writeFileSync(path.join(folder,"dashboard-view-mock.js"),`"use strict";
const now=Date.now();
const sessions=[
 {key:"chat:a",title:"A 项目活跃对话",url:"https://chatgpt.com/c/a",tabId:11,
  browser:"loaded",pending:3,active:1,review:0,enabledRules:1,allRules:1,
  queuePaused:false,halted:false,activeStatus:"waiting",
  activeSince:now-60000,lastEventAt:now-30000,recentEvents:[
   {type:"sent",at:now-30000},{type:"claim",at:now-45000},
   {type:"manual_enqueue",at:now-60000},
  ]},
 {key:"chat:b",title:"B 异常待核对",url:"https://chatgpt.com/c/b",tabId:null,
  browser:"closed",pending:0,active:0,review:1,enabledRules:0,allRules:0,
  queuePaused:true,halted:true,haltReason:"timeout",activeStatus:null,
  activeSince:null,lastEventAt:now-90000,recentEvents:[
   {type:"timeout",at:now-90000},{type:"send_failed",at:now-100000},
  ]},
 {key:"chat:c",title:"C 重点自动规则",url:"https://chatgpt.com/c/c",tabId:13,
  browser:"loaded",pending:0,active:0,review:0,enabledRules:2,allRules:2,
  queuePaused:false,halted:false,activeStatus:null,
  activeSince:null,lastEventAt:now-140000,recentEvents:[
   {type:"schedule_added",at:now-140000},
  ]},
 {key:"chat:d",title:"D 暂停状态",url:"https://chatgpt.com/c/d",tabId:14,
  browser:"loaded",pending:1,active:0,review:0,enabledRules:0,allRules:0,
  queuePaused:true,halted:false,activeStatus:null,
  activeSince:null,lastEventAt:null,recentEvents:[]},
];
let prefs={favorites:["chat:c"],compact:false};
let failNextPreferenceSet=false;
const saved=[];
const messages=[];
const storageListeners=[];
window.chrome={
 runtime:{
  getURL(name){return "chrome-extension://test-queue/"+name;},
  async sendMessage(message){
    messages.push({...message});
    return {ok:true,dashboard:{version:"0.28.0",sessions:sessions.map(s=>({...s}))}};
  },
 },
 storage:{
  local:{
   async get(key){return {[key]:JSON.parse(JSON.stringify(prefs))};},
   async set(values){
     saved.push(JSON.parse(JSON.stringify(values)));
     if(failNextPreferenceSet){
       failNextPreferenceSet=false;
       throw Error("simulated preferences storage failure");
     }
     const oldPrefs=prefs;
     prefs=JSON.parse(JSON.stringify(values["cq.dashboard.view.v1"]));
     storageListeners.forEach(fn=>fn({
       "cq.dashboard.view.v1":{oldValue:oldPrefs,newValue:prefs},
     },"local"));
   },
  },
  onChanged:{addListener(fn){storageListeners.push(fn);}},
 },
};
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const waitUntil=async(fn,limit=3500)=>{
  const end=Date.now()+limit;
  while(Date.now()<end){
    if(fn())return true;
    await wait(50);
  }
  return Boolean(fn());
};
const q=selector=>document.querySelector(selector);
const card=key=>[...document.querySelectorAll(".session")]
  .find(element=>element.dataset.key===key);
const keys=()=>[...document.querySelectorAll(".session")]
  .map(element=>element.dataset.key);
const setPrefsExternal=value=>{
  const before=prefs;
  prefs=value;
  storageListeners.forEach(fn=>fn({
   "cq.dashboard.view.v1":{oldValue:before,newValue:value},
  },"local"));
};
setTimeout(async()=>{
 const flags={};
 try {
  await waitUntil(()=>keys().length===4 && q("#stat-chats")?.textContent==="4");
  flags.initialFavoriteRestored=keys()[0]==="chat:c" &&
    card("chat:c")?.querySelector('[data-action="favorite"]')
      ?.getAttribute("aria-pressed")==="true" &&
    q("#result-count")?.textContent.includes("重点 1");
  const regularHeight=card("chat:a")?.getBoundingClientRect().height || 0;
  flags.initialComfortable=!q("#dashboard")?.classList.contains("compact-cards") &&
    q("#density-toggle")?.getAttribute("aria-pressed")==="false";
  const activity=card("chat:a").querySelector('[data-action="activity"]');
  activity.focus();
  activity.click();
  flags.activityMetadata=card("chat:a")?.querySelectorAll(".activity-timeline li").length===3 &&
    card("chat:a")?.textContent.includes("已点击发送") &&
    card("chat:a")?.textContent.includes("手动任务入队") &&
    card("chat:a")?.querySelector('[data-action="activity"]')
      ?.getAttribute("aria-expanded")==="true" &&
    document.activeElement?.dataset.action==="activity";
  const activityTime=card("chat:a")?.querySelector('[data-time-kind="activity"]');
  flags.activityRelativeTime=/秒前|刚刚|分钟前|小时前/.test(
      activityTime?.textContent || "") &&
    !card("chat:a")?.textContent.includes("secret prompt");
  card("chat:a").querySelector('[data-action="activity"]').click();
  flags.activityCollapsed=!card("chat:a")?.querySelector(".activity-timeline");

  const star=card("chat:a")?.querySelector('[data-action="favorite"]');
  star.focus();
  star.click();
  await waitUntil(()=>prefs.favorites.includes("chat:a") &&
    card("chat:a")?.querySelector('[data-action="favorite"]')
      ?.getAttribute("aria-pressed")==="true" &&
    q("#feedback")?.textContent.includes("已设为重点") &&
    document.activeElement?.dataset.key==="chat:a");
  flags.favoriteSaved=prefs.favorites.length===2 &&
    keys().slice(0,2).join(",")==="chat:a,chat:c" &&
    saved.at(-1)["cq.dashboard.view.v1"].favorites.includes("chat:a") &&
    q("#feedback")?.textContent.includes("已设为重点");
  flags.starFocusRetained=document.activeElement?.dataset.action==="favorite" &&
    document.activeElement?.dataset.key==="chat:a";
  q("#favorites-only").click();
  flags.favoritesOnly=keys().join(",")==="chat:a,chat:c" &&
    q("#favorites-only")?.getAttribute("aria-pressed")==="true";
  q("#favorites-only").click();
  flags.filterRestored=keys().length===4;

  q("#density-toggle").click();
  await waitUntil(()=>prefs.compact===true && q("#dashboard")
    ?.classList.contains("compact-cards"));
  const compactHeight=card("chat:a").getBoundingClientRect().height;
  flags.compactSaved=q("#density-toggle")?.getAttribute("aria-pressed")==="true" &&
    compactHeight<regularHeight &&
    saved.at(-1)["cq.dashboard.view.v1"].compact===true;
  flags.noOverflow=document.documentElement.scrollWidth<=
    document.documentElement.clientWidth+3;

  // A second extension view changing UI preferences must update this window
  // without touching the queue or requiring a page reload.
  setPrefsExternal({favorites:["chat:b"],compact:false});
  flags.externalSync=!q("#dashboard")?.classList.contains("compact-cards") &&
    card("chat:b")?.querySelector('[data-action="favorite"]')
      ?.getAttribute("aria-pressed")==="true" &&
    keys()[0]==="chat:b" &&
    card("chat:c")?.querySelector('[data-action="favorite"]')
      ?.getAttribute("aria-pressed")==="false";

  failNextPreferenceSet=true;
  card("chat:a").querySelector('[data-action="favorite"]').click();
  await waitUntil(()=>q("#feedback")?.textContent.includes("视图偏好保存失败"));
  flags.failedFavoriteNotClaimed=!prefs.favorites.includes("chat:a") &&
    card("chat:a")?.querySelector('[data-action="favorite"]')
      ?.getAttribute("aria-pressed")==="false" &&
    q("#feedback")?.classList.contains("error");

  // Metadata updates must keep activity expansion in the current document.
  card("chat:a").querySelector('[data-action="activity"]').click();
  sessions[0].pending=4;
  sessions[0].lastEventAt=Date.now();
  sessions[0].recentEvents.unshift({type:"task_pinned",at:Date.now()});
  storageListeners.forEach(fn=>fn({"cq.state.v2":{newValue:{}}},"local"));
  await waitUntil(()=>q("#stat-pending")?.textContent==="5");
  flags.expandedAcrossUpdates=card("chat:a")
    ?.querySelector('[data-action="activity"]')?.getAttribute("aria-expanded")==="true" &&
    card("chat:a")?.querySelector(".activity-timeline")?.textContent.includes("任务置顶") &&
    card("chat:a")?.classList.contains("recently-changed");
  const beforeTooManyFavorites=saved.length;
  setPrefsExternal({
    favorites:Array.from({length:100},(_,index)=>"chat:old-"+index),
    compact:false,
  });
  card("chat:a").querySelector('[data-action="favorite"]').click();
  flags.favoriteLimitProtected=saved.length===beforeTooManyFavorites &&
    !prefs.favorites.includes("chat:a") &&
    q("#feedback")?.textContent.includes("最多标记 100 个") &&
    card("chat:a")?.querySelector('[data-action="favorite"]')
      ?.getAttribute("aria-pressed")==="false";
  flags.viewOnlyActions=messages.every(msg=>msg.type==="DASHBOARD_GET");
  flags.settingsMetadataOnly=JSON.stringify(prefs).includes("prompt")===false &&
    JSON.stringify(saved).includes("task_pinned")===false;
 } catch(error) {flags.error=error.stack || error.message;}
 flags.ok=["initialFavoriteRestored","initialComfortable","activityMetadata",
   "activityRelativeTime","activityCollapsed","favoriteSaved",
   "starFocusRetained","favoritesOnly","filterRestored","compactSaved",
   "noOverflow","externalSync","failedFavoriteNotClaimed",
   "expandedAcrossUpdates","favoriteLimitProtected",
   "viewOnlyActions","settingsMetadataOnly"]
   .every(key=>flags[key]===true);
 document.body.dataset.test=JSON.stringify(flags);
},330);`);
    const run=spawnSync(browser,[
      "--headless=new","--disable-gpu","--disable-extensions","--no-first-run",
      `--user-data-dir=${path.join(folder,"profile")}`,
      "--virtual-time-budget=9500","--dump-dom",
      `file:///${path.join(folder,"dashboard.html").replace(/\\/g,"/")}`,
    ],{encoding:"utf8",timeout:27000,maxBuffer:11e6});
    assert.equal(run.status,0,run.stderr || "Chrome failed");
    const match=run.stdout.match(/data-test="([^"]+)"/);
    assert.ok(match,"Chrome did not complete favorite/compact/activity test");
    const flags=JSON.parse(match[1].replace(/&quot;/g,'"').replace(/&amp;/g,"&"));
    assert.equal(flags.ok,true,JSON.stringify(flags));
  } finally {
    fs.rmSync(folder,{recursive:true,force:true});
  }
});
