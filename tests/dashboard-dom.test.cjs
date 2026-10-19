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

test("真实 Chrome：Edge 工具栏管理页跨对话汇总、实时筛选、权限操作和安全打开",{
  skip:!fs.existsSync(browser) && "Chrome is not installed",
},()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"cq-dashboard-dom-"));
  try {
    for(const file of ["dashboard.js","dashboard.css"]) {
      fs.copyFileSync(path.join(__dirname,"..",file),path.join(dir,file));
    }
    const html=fs.readFileSync(path.join(__dirname,"..","dashboard.html"),"utf8")
      .replace('<script src="dashboard.js" defer></script>',
        '<script src="dashboard-mock.js"></script><script src="dashboard.js" defer></script>');
    fs.writeFileSync(path.join(dir,"dashboard.html"),html);
    fs.writeFileSync(path.join(dir,"dashboard-mock.js"),`"use strict";
const entries=[
 {key:"chat:a",title:"对话 A · 大型任务",url:"https://chatgpt.com/c/a",
  tabId:11,browser:"loaded",pending:2,active:1,review:0,
  enabledRules:0,allRules:1,queuePaused:false,halted:false,activeStatus:"waiting",
  activeSince:Date.now()-32000,lastEventAt:Date.now()-60000,
  pageSignal:"generating",pageSignalAt:Date.now()-3000},
 {key:"chat:b",title:"<img src=x onerror=alert(42)>危险标题",
  url:"https://chatgpt.com/c/b",tabId:null,browser:"closed",
  pending:0,active:0,review:2,enabledRules:0,allRules:0,
  queuePaused:true,halted:true,haltReason:"state_inconsistent",activeStatus:null,
  activeSince:null,lastEventAt:Date.now()-300000},
 {key:"chat:c",title:"定时规则对话 C",url:"https://chatgpt.com/c/c",
  tabId:13,browser:"discarded",pending:0,active:0,review:0,enabledRules:2,
  allRules:3,queuePaused:false,halted:false,activeStatus:null,
  activeSince:null,lastEventAt:Date.now()-120000},
 {key:"chat:d",title:"手动暂停 D",url:"https://chatgpt.com/c/d",
  tabId:14,browser:"loaded",pending:1,active:0,review:0,
  enabledRules:0,allRules:0,queuePaused:true,halted:false,activeStatus:null,
  activeSince:null,lastEventAt:Date.now()-180000,
  pageSignal:"stale",pageSignalAt:Date.now()-40000},
 {key:"draft:15",title:null,url:"https://chatgpt.com/",
  tabId:15,browser:"loaded",pending:0,active:0,review:0,
  enabledRules:0,allRules:0,queuePaused:false,halted:false,activeStatus:null,
  activeSince:null,lastEventAt:null},
];
const events=[];
const openTabs=new Map([
 [11,{id:11,url:"https://chatgpt.com/c/a",windowId:2}],
 [13,{id:13,url:"https://chatgpt.com/c/c",windowId:2}],
 [14,{id:14,url:"https://chatgpt.com/c/d",windowId:2}],
 [15,{id:15,url:"https://chatgpt.com/",windowId:2}],
]);
let storageChanged=null;
let rejectNextPause=false;
let rejectWindowFocus=false;
window.chrome={
 runtime:{
  getURL(path) {return "chrome-extension://test-queue/"+path;},
  async sendMessage(message) {
   events.push({...message});
   if(message.type==="DASHBOARD_GET") {
     return {ok:true,dashboard:{version:"0.28.0",sessions:entries.map(s=>({...s}))}};
   }
   if(message.type==="DASHBOARD_SET_PAUSED") {
     if(rejectNextPause) {
       rejectNextPause=false;
       return {ok:false,error:"模拟后台暂停失败"};
     }
     const entry=entries.find(s=>s.key===message.key);
     if(!entry) return {ok:false,error:"不存在"};
     if(entry.halted && !message.paused) return {ok:false,error:"需要人工核对"};
     entry.queuePaused=message.paused;
     return {ok:true,dashboard:{version:"0.28.0",sessions:entries.map(s=>({...s}))}};
   }
   return {ok:false,error:"未知管理请求"};
  },
 },
 tabs:{
  async query(query) {
    if(query?.active && query.currentWindow) {
      return [{id:11,url:"https://chatgpt.com/c/a",windowId:2}];
    }
    return [...openTabs.values()];
  },
  async sendMessage(id,message) {
    events.push({type:"TAB_MESSAGE",id,message});
    return {ok:true};
  },
  async get(id) {
    if(!openTabs.has(id)) throw new Error("标签已关闭");
    return {...openTabs.get(id)};
  },
  async update(id,change) {
    events.push({type:"TAB_UPDATE",id,...change});
    return {...openTabs.get(id),...change};
  },
  async create(data) {
    events.push({type:"TAB_CREATE",...data});
    return {id:100,...data};
  },
 },
 windows:{
  async update(id,change) {
   events.push({type:"WINDOW_UPDATE",id,...change});
   if(rejectWindowFocus) throw new Error("Edge cannot focus window");
  },
 },
 storage:{onChanged:{addListener(fn){storageChanged=fn;}}},
};
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const waitUntil=async (predicate,timeout=3000)=>{
 const until=Date.now()+timeout;
 while(Date.now()<until) {
   if(predicate()) return true;
   await wait(40);
 }
 return Boolean(predicate());
};
const q=selector=>document.querySelector(selector);
const card=key=>[...document.querySelectorAll(".session")].find(e=>e.dataset.key===key);
const chooseFilter=name=>q('#filters [data-filter="'+name+'"]').click();
const keys=()=>[...document.querySelectorAll(".session")].map(e=>e.dataset.key);
const search=value=>{
 const input=q("#search");
 input.value=value;
 input.dispatchEvent(new Event("input",{bubbles:true}));
};
const calls=type=>events.filter(e=>e.type===type);
setTimeout(async()=>{
 const flags={};
 try {
  await waitUntil(()=>q("#stat-chats")?.textContent==="4" && keys().length===5);
  flags.title=q("h1")?.textContent==="对话队列总览" &&
   q("#version")?.textContent==="v0.28.0";
  flags.stats=q("#stat-chats")?.textContent==="4" &&
   q("#stat-pending")?.textContent==="3" &&
   q("#stat-active")?.textContent==="1" &&
   q("#stat-review")?.textContent==="2";
  flags.privacy=!document.body.innerHTML.includes("prompt private content") &&
   card("chat:b")?.textContent.includes("<img src=x onerror=alert(42)>") &&
   !card("chat:b")?.querySelector("img");
  flags.defaultReviewFirst=keys()[0]==="chat:b" &&
   card("chat:b")?.querySelector(".status.review")?.textContent.includes("需要人工核对") &&
   card("chat:a")?.querySelector(".status.active")?.textContent.includes("等待回复");
  flags.browserStates=card("chat:b")?.textContent.includes("标签页未打开") &&
   card("chat:c")?.textContent.includes("标签页已被丢弃");
  flags.safetyResumeDisabled=card("chat:b")
   ?.querySelector('[data-action="pause"]')?.disabled===true;
  card("chat:b")?.querySelector('[data-action="pause"]')?.click();
  flags.noUnsafeResume=!calls("DASHBOARD_SET_PAUSED").length;

  chooseFilter("review");
  flags.reviewFilter=keys().join(",")==="chat:b";
  chooseFilter("paused");
  flags.pausedFilter=keys().join(",")==="chat:b,chat:d" &&
   q('#filters [data-filter="paused"]')?.getAttribute("aria-pressed")==="true";
  chooseFilter("offline");
  flags.offlineFilter=keys().join(",")==="chat:b,chat:c";
  chooseFilter("nosignal");
  flags.noSignalFilter=keys().join(",")==="chat:d,draft:15";
  chooseFilter("busy");
  flags.busyFilter=keys().join(",")==="chat:b,chat:a,chat:d,chat:c";
  chooseFilter("all");
  search("定时规则");
  flags.searchTitle=keys().join(",")==="chat:c" &&
   q("#search")?.value==="定时规则";
  search("chat:d");
  flags.searchKey=keys().join(",")==="chat:d";
  search("");
  flags.defaultListRestored=keys().length===5;
  flags.loadedTabStatus=card("chat:a")?.textContent.includes("标签页已加载");
  flags.pageHeartbeats=card("chat:a")?.textContent.includes("检测到停止按钮") &&
   card("chat:a")?.querySelector('[data-time-kind="pulse"]')
     ?.textContent.includes("最近心跳") &&
   card("chat:d")?.textContent.includes("页面信号已过期") &&
   card("draft:15")?.textContent.includes("等待页面心跳") &&
   card("chat:b")?.textContent.includes("页面未打开 · 无心跳");
  flags.savedAgeLabels=card("chat:a")?.querySelector('[data-time-kind="stage"]')
     ?.textContent.includes("当前阶段记录已持续") &&
   card("chat:a")?.querySelector('[data-time-kind="event"]')
     ?.textContent.includes("最近队列操作") &&
   card("chat:b")?.querySelector('[data-time-kind="stage"]')===null;
  const sort=q("#sort-order");
  sort.value="recent";
  sort.dispatchEvent(new Event("change",{bubbles:true}));
  flags.recentSort=keys().join(",")==="chat:a,chat:c,chat:d,chat:b,draft:15";
  sort.value="pending";
  sort.dispatchEvent(new Event("change",{bubbles:true}));
  flags.pendingSort=keys()[0]==="chat:a" && keys()[1]==="chat:d";
  sort.value="name";
  sort.dispatchEvent(new Event("change",{bubbles:true}));
  flags.nameSort=q("#sort-order")?.value==="name" && keys().length===5;
  sort.value="priority";
  sort.dispatchEvent(new Event("change",{bubbles:true}));
  flags.sortRestored=keys()[0]==="chat:b";
  flags.fullViewLinkAvailable=q("#open-full-view")?.hidden===false &&
   document.documentElement.dataset.view==="popup";
  q("#open-full-view").click();
  await waitUntil(()=>calls("TAB_CREATE").length===1);
  flags.openLargePage=calls("TAB_CREATE").some(e=>
   e.url==="chrome-extension://test-queue/dashboard.html?view=full" && e.active===true);

  const pause=card("chat:a").querySelector('[data-action="pause"]');
  pause.focus();
  pause.click();
  await waitUntil(()=>entries[0].queuePaused &&
   card("chat:a")?.querySelector('[data-action="pause"]')?.textContent.includes("继续接力"));
  flags.pauseSuccess=entries[0].queuePaused===true &&
   calls("DASHBOARD_SET_PAUSED").length===1 &&
   calls("DASHBOARD_SET_PAUSED")[0].paused===true &&
   q("#feedback")?.textContent.includes("已暂停此对话") &&
   q("#feedback")?.hidden===false &&
   card("chat:a")?.querySelector('[data-action="pause"]')?.textContent.includes("继续接力");
  flags.pauseFocusRestored=document.activeElement?.dataset.key==="chat:a" &&
   document.activeElement?.dataset.action==="pause";
  card("chat:a").querySelector('[data-action="pause"]').click();
  await waitUntil(()=>!entries[0].queuePaused &&
   q("#feedback")?.textContent.includes("已恢复"));
  flags.resumeSuccess=!entries[0].queuePaused &&
   calls("DASHBOARD_SET_PAUSED").length===2 &&
   q("#feedback")?.textContent.includes("已恢复");

  rejectNextPause=true;
  card("chat:a").querySelector('[data-action="pause"]').click();
  await waitUntil(()=>q("#feedback")?.textContent.includes("模拟后台暂停失败"));
  flags.errorNoFakeSuccess=!entries[0].queuePaused &&
   q("#feedback")?.classList.contains("error") &&
   q("#feedback")?.textContent.includes("模拟后台暂停失败");

  card("chat:a").querySelector('[data-action="open"]').click();
  await waitUntil(()=>calls("TAB_UPDATE").length===1 &&
   calls("WINDOW_UPDATE").length===1);
  flags.reuseExistingTab=calls("TAB_UPDATE").some(e=>e.id===11 && e.active===true) &&
   calls("WINDOW_UPDATE").some(e=>e.id===2 && e.focused===true) &&
   calls("TAB_CREATE").length===1;
  rejectWindowFocus=true;
  card("chat:a").querySelector('[data-action="open"]').click();
  await waitUntil(()=>calls("TAB_UPDATE").filter(e=>e.id===11).length===2);
  flags.focusFailureNoDuplicate=calls("TAB_UPDATE").filter(e=>e.id===11).length===2 &&
   calls("TAB_CREATE").length===1;
  rejectWindowFocus=false;
  card("chat:b").querySelector('[data-action="open"]').click();
  await waitUntil(()=>calls("TAB_CREATE").length===2);
  flags.openMissingChat=calls("TAB_CREATE").some(e=>
   e.url==="https://chatgpt.com/c/b" && e.active===true);
  q("#toggle-current-panel").click();
  await waitUntil(()=>calls("TAB_MESSAGE").length===1 &&
   q("#feedback")?.textContent.includes("已切换当前"));
  flags.oldToolbarActionAccessible=calls("TAB_MESSAGE").some(e=>
   e.id===11 && e.message.type==="TOGGLE_PANEL") &&
   q("#feedback")?.textContent.includes("已切换当前");

  entries[0].pending=0;
  entries[0].active=0;
  entries[0].activeStatus=null;
  storageChanged?.({"cq.state.v2":{newValue:{}}},"local");
  await waitUntil(()=>q("#stat-pending")?.textContent==="1" &&
   q("#stat-active")?.textContent==="0");
  flags.liveUpdate=q("#stat-pending")?.textContent==="1" &&
   q("#stat-active")?.textContent==="0" &&
   card("chat:a")?.querySelector(".status")?.textContent.includes("空闲");
  flags.changesHighlighted=card("chat:a")?.classList.contains("recently-changed") &&
   card("chat:a")?.querySelector(".change-pill")?.textContent.includes("有变化") &&
   !card("chat:c")?.classList.contains("recently-changed");
  chooseFilter("changed");
  flags.changedOnlyFilter=keys().join(",")==="chat:a" &&
   q('#filters [data-filter="changed"]')?.getAttribute("aria-pressed")==="true";
  chooseFilter("all");
  flags.noConversationTextEver=!document.querySelector("#dashboard textarea");

  for(let i=0;i<40;i++) {
   entries.push({key:"chat:long-"+i,title:"大量会话 "+i,
    url:"https://chatgpt.com/c/long-"+i,tabId:null,browser:"closed",
    pending:1,active:0,review:0,enabledRules:0,allRules:0,
    queuePaused:false,halted:false,activeStatus:null});
  }
  q("#refresh").click();
  await waitUntil(()=>q("#result-count")?.textContent.includes("45") &&
   q("#stat-pending")?.textContent==="41");
  flags.largeListScrollable=q(".sessions")?.scrollHeight>q(".sessions")?.clientHeight &&
   q("#result-count")?.textContent.includes("45") &&
   q("#stat-pending")?.textContent==="41";
  search("long-39");
  flags.largeSearch=keys().join(",")==="chat:long-39";
  search("");
 } catch(error) {flags.error=error.stack || error.message;}
 flags.ok=["title","stats","privacy","defaultReviewFirst","browserStates",
  "safetyResumeDisabled","noUnsafeResume","reviewFilter","pausedFilter",
  "offlineFilter","noSignalFilter","busyFilter","searchTitle","searchKey","defaultListRestored",
  "loadedTabStatus","pageHeartbeats","savedAgeLabels","recentSort","pendingSort","nameSort",
  "sortRestored","fullViewLinkAvailable","openLargePage",
  "pauseSuccess","pauseFocusRestored","resumeSuccess",
  "errorNoFakeSuccess","reuseExistingTab","focusFailureNoDuplicate",
  "openMissingChat",
  "oldToolbarActionAccessible",
  "liveUpdate","changesHighlighted","changedOnlyFilter",
  "noConversationTextEver","largeListScrollable",
  "largeSearch"].every(key=>flags[key]===true);
 document.body.dataset.test=JSON.stringify(flags);
},400);`);
    const run=spawnSync(browser,[
      "--headless=new","--disable-gpu","--disable-extensions","--no-first-run",
      `--user-data-dir=${path.join(dir,"profile")}`,
      "--virtual-time-budget=10000","--dump-dom",
      `file:///${path.join(dir,"dashboard.html").replace(/\\/g,"/")}`,
    ],{encoding:"utf8",timeout:27000,maxBuffer:10e6});
    assert.equal(run.status,0,run.stderr || "Chrome failed");
    const match=run.stdout.match(/data-test="([^"]+)"/);
    assert.ok(match,"Chrome did not run the dashboard popup test");
    const flags=JSON.parse(match[1].replace(/&quot;/g,'"').replace(/&amp;/g,"&"));
    assert.equal(flags.ok,true,JSON.stringify(flags));
  } finally {
    fs.rmSync(dir,{recursive:true,force:true});
  }
});
