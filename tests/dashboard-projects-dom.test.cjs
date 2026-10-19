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

function runProjectProbe(full) {
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),"cq-project-groups-"));
  try {
    for (const filename of ["dashboard.js","dashboard.css"]) {
      fs.copyFileSync(path.join(__dirname,"..",filename),path.join(folder,filename));
    }
    const html=fs.readFileSync(path.join(__dirname,"..","dashboard.html"),"utf8")
      .replace('<script src="dashboard.js" defer></script>',
        '<script src="projects-mock.js"></script><script src="dashboard.js" defer></script>');
    fs.writeFileSync(path.join(folder,"dashboard.html"),html);
    fs.writeFileSync(path.join(folder,"projects-mock.js"),`"use strict";
const VIEW="cq.dashboard.view.v1";
const ALIAS="cq.dashboard.aliases.v1";
const PROJECT="cq.dashboard.projects.v1";
const now=Date.now();
const make=(key,title,changes={})=>({
 key,title,url:"https://chatgpt.com/c/"+key.slice(5),tabId:10,
 browser:"loaded",pending:0,active:0,review:0,enabledRules:0,allRules:0,
 halted:false,queuePaused:false,activeStatus:null,activeSince:null,
 lastEventAt:now-30000,pageSignal:"idle",pageSignalAt:now-2500,
 recentEvents:[],...changes,
});
const sessions=[
 make("chat:a","原剧情标题",{review:1,halted:true,queuePaused:true}),
 make("chat:b","原战斗标题",{active:1,activeStatus:"waiting",pending:1}),
 make("chat:c","新关卡草案",{pending:2}),
 make("chat:d","工具管理",{enabledRules:1,allRules:1}),
 make("chat:e","<img src=x onerror=alert(1)> 源标题"),
 make("chat:f","还没有项目的对话"),
];
let store={
 [VIEW]:{favorites:["chat:a"],compact:false,
  layout:location.search.includes("full")?"list":"cards",
  grouped:false,projectGrouped:false,focus:false},
 [ALIAS]:{"chat:a":"主线剧情"},
 [PROJECT]:{
  "chat:a":"Aetherwild","chat:b":"Aetherwild",
  "chat:d":"DevTools","chat:e":"<img src=x onerror=1>",
 },
};
const listeners=[];
const calls=[];
const writes=[];
let failNextProject=false;
const clone=value=>value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const broadcast=changes=>listeners.forEach(fn=>fn(changes,"local"));
window.chrome={
 runtime:{
  getURL(filename){return "chrome-extension://test-queue/"+filename;},
  async sendMessage(message){
   calls.push({...message});
   if(message.type!=="DASHBOARD_GET")return {ok:false,error:"Not a queue operation"};
   return {ok:true,dashboard:{version:"0.45.0",sessions:sessions.map(s=>({...s})),
     cleanupEligible:0}};
  },
 },
 storage:{
  local:{
   async get(key){return {[key]:clone(store[key])};},
   async set(values){
    const changes={};
    for(const [key,value] of Object.entries(values)){
     if(key===PROJECT && failNextProject){
      failNextProject=false;
      throw Error("模拟项目写入失败");
     }
     const oldValue=clone(store[key]);
     store[key]=clone(value);
     writes.push({key,value:clone(value)});
     changes[key]={oldValue,newValue:clone(value)};
    }
    broadcast(changes);
   },
  },
  onChanged:{addListener(fn){listeners.push(fn);}},
 },
};
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const until=async(fn,max=4800)=>{
 const end=Date.now()+max;
 while(Date.now()<end){if(fn())return true;await wait(40);}
 return Boolean(fn());
};
const q=selector=>document.querySelector(selector);
const rows=()=>[...document.querySelectorAll(".session")];
const row=key=>rows().find(element=>element.dataset.key===key);
const keys=()=>rows().map(element=>element.dataset.key);
const filter=()=>q("#project-filter");
const chooseProject=value=>{
 filter().value=value;
 filter().dispatchEvent(new Event("change",{bubbles:true}));
};
const projectGroup=name=>[...document.querySelectorAll("button[data-project-group]")]
 .find(button=>button.dataset.projectGroup===name);
const expandMore=key=>{
 const button=row(key)?.querySelector('[data-action="more"]');
 if(button?.getAttribute("aria-expanded")!=="true") button?.click();
};
const action=(key,name)=>row(key)?.querySelector('[data-action="'+name+'"]');
const input=()=>q("input[data-project-input]");
const fill=value=>{
 input().value=value;
 input().dispatchEvent(new Event("input",{bubbles:true}));
};
const updateState=()=>broadcast({"cq.state.v2":{newValue:{}}});
const outsideProject=(key,value)=>{
 const before=clone(store[PROJECT]);
 if(value==null)delete store[PROJECT][key];
 else store[PROJECT][key]=value;
 broadcast({[PROJECT]:{oldValue:before,newValue:clone(store[PROJECT])}});
};
setTimeout(async()=>{
 const f={};
 try {
  await until(()=>rows().length===6 &&
   q("#project-filter")?.options.length===5 &&
   row("chat:a")?.querySelector(".project-chip")?.textContent==="Aetherwild");
  f.initialData=q("#dashboard").classList.contains("project-grouped-mode")===false &&
   row("chat:a").querySelector(".session-title")?.textContent==="主线剧情" &&
   row("chat:a").textContent.includes("原剧情标题") &&
   row("chat:f").querySelector(".project-chip")===null;
  f.optionsSafe=filter().options.length===5 &&
   [...filter().options].some(option=>option.textContent==="DevTools") &&
   [...filter().options].some(option=>option.textContent==="<img src=x onerror=1>") &&
   !q("#dashboard img") &&
   row("chat:e")?.querySelector(".project-chip")?.textContent==="<img src=x onerror=1>";

  f.overviewInitiallyCompact=!q("#project-health").hidden &&
   q("#project-health-toggle").getAttribute("aria-expanded")==="false" &&
   q("#project-health-cards").hidden===true &&
   q("#project-health-summary").textContent.includes("3 个项目") &&
   q("#project-health-summary").textContent.includes("1 个对话需核对");
  const healthToggle=q("#project-health-toggle");
  healthToggle.focus();
  healthToggle.click();
  f.overviewExpanded=healthToggle.getAttribute("aria-expanded")==="true" &&
   !q("#project-health-cards").hidden &&
   q("#project-health-cards").querySelectorAll(".project-health-card").length===4 &&
   document.activeElement===healthToggle;
  const healthCard=q('[data-project-health-key="project:Aetherwild"]');
  f.overviewCounts=healthCard?.querySelector(".project-health-amount")?.textContent==="2 对话" &&
   healthCard?.querySelector(".project-health-metrics")?.textContent.includes("待 1") &&
   healthCard?.querySelector(".project-health-metrics")?.textContent.includes("执 1") &&
   healthCard?.querySelector(".project-health-review")?.textContent.includes("需核对 1 对话") &&
   !q("#project-health-cards img") &&
   [...q("#project-health-cards").querySelectorAll(".project-health-name")]
    .some(element=>element.textContent==="<img src=x onerror=1>");
  const healthWritesBefore=writes.length;
  const healthMain=q('[data-project-open="project:Aetherwild"]');
  healthMain.focus();
  healthMain.click();
  f.overviewQuickProject=keys().length===2 &&
   keys().includes("chat:a") && keys().includes("chat:b") &&
   filter().value==="project:Aetherwild" &&
   document.activeElement?.dataset.projectOpen==="project:Aetherwild";
  q('[data-project-open="project:Aetherwild"]').click();
  f.overviewToggleAll=rows().length===6 && filter().value==="all";
  q('[data-project-review="project:Aetherwild"]').click();
  f.overviewQuickReview=keys().join(",")==="chat:a" &&
   filter().value==="project:Aetherwild" &&
   q('[data-project-review="project:Aetherwild"]').getAttribute("aria-pressed")==="true" &&
   q("#feedback").textContent.includes("需人工核对");
  q('[data-project-open="project:Aetherwild"]').click();
  q('[data-project-open="project:Aetherwild"]').click();
  f.overviewReadOnly=writes.length===healthWritesBefore &&
   rows().length===6 && calls.every(message=>message.type==="DASHBOARD_GET");

  chooseProject("project:Aetherwild");
  f.projectFilter=keys().length===2 &&
   keys().includes("chat:a") && keys().includes("chat:b") &&
   q("#scan-progress").textContent.includes("2 个对话");
  q('#filters [data-filter="review"]').click();
  f.combinedFilter=keys().join(",")==="chat:a";
  chooseProject("none");
  f.unassignedFilter=keys().length===0;
  q("#focus-mode").click();
  await until(()=>store[VIEW].focus===true &&
   q("#dashboard").classList.contains("focus-mode"));
  f.focusSummary=q("#focus-filter-summary").textContent.includes("未分组") &&
   !q("#focus-reset").hidden;
  q("#focus-reset").click();
  f.focusClears=filter().value==="all" && rows().length===6 &&
   q("#focus-filter-summary").textContent.includes("全部对话");

  q("#project-group-toggle").click();
  await until(()=>store[VIEW].projectGrouped===true &&
   q("#dashboard").classList.contains("project-grouped-mode"));
  f.projectGroups=store[VIEW].grouped===false &&
   [...document.querySelectorAll(".project-group")].length===4 &&
   projectGroup("project:Aetherwild")?.textContent.includes("2 个对话") &&
   projectGroup("none")?.textContent.includes("2 个对话");
  const projectHeader=projectGroup("project:Aetherwild");
  projectHeader.focus();
  projectHeader.click();
  f.collapseAndFocus=projectGroup("project:Aetherwild")
   ?.getAttribute("aria-expanded")==="false" &&
   document.activeElement===projectGroup("project:Aetherwild") &&
   !row("chat:a");
  q("#scan-next").click();
  f.scanExpands=projectGroup("project:Aetherwild")
   ?.getAttribute("aria-expanded")==="true" &&
   row("chat:a")?.classList.contains("scan-selected");
  q("#group-toggle").click();
  await until(()=>store[VIEW].grouped===true &&
   store[VIEW].projectGrouped===false);
  f.groupMutualExclusion=q("#dashboard").classList.contains("project-grouped-mode")===false &&
   !!q(".group-review") &&
   q("#project-group-toggle").getAttribute("aria-pressed")==="false";
  q("#project-group-toggle").click();
  await until(()=>store[VIEW].projectGrouped===true && store[VIEW].grouped===false);

  const devHeader=()=>projectGroup("project:DevTools");
  devHeader().click();
  f.devGroupClosed=devHeader()?.getAttribute("aria-expanded")==="false";
  sessions[3].review=1;
  sessions[3].halted=true;
  updateState();
  await until(()=>devHeader()?.getAttribute("aria-expanded")==="true" &&
    row("chat:d")?.classList.contains("needs-review"));
  f.newReviewOpensProject=devHeader()?.getAttribute("aria-expanded")==="true" &&
    q('[data-project-health-key="project:DevTools"]')
      ?.querySelector(".project-health-review")?.textContent.includes("需核对 1 对话");
  sessions[3].review=0;
  sessions[3].halted=false;
  updateState();
  await until(()=>!row("chat:d")?.classList.contains("needs-review"));
  devHeader().click();
  sessions[3].active=1;
  sessions[3].pageSignal="stale";
  updateState();
  await until(()=>q('[data-project-health-key="project:DevTools"]')
    ?.querySelector(".project-health-signal")?.textContent.includes("心跳待确认 1"));
  f.staleDoesNotReopen=devHeader()?.getAttribute("aria-expanded")==="false" &&
    q('[data-project-health-key="project:DevTools"]')
      ?.querySelector(".project-health-review")===null;
  sessions[3].active=0;
  sessions[3].pageSignal="idle";
  updateState();
  await until(()=>!q('[data-project-health-key="project:DevTools"]')
    ?.querySelector(".project-health-signal"));
  devHeader().click();

  expandMore("chat:b");
  action("chat:b","project-edit").click();
  f.inlineEditor=input()?.value==="Aetherwild" &&
    input()?.maxLength===24 &&
    document.activeElement===input() &&
    !!q("datalist option[value='DevTools']") &&
    action("chat:b","alias-edit")?.disabled===true;
  fill("DevTools");
  input().focus();
  input().setSelectionRange(2,2);
  sessions[1].pending=2;
  updateState();
  await until(()=>q("#stat-pending").textContent==="4");
  f.refreshKeepsDraft=input()?.value==="DevTools" &&
   document.activeElement===input() && input()?.selectionStart===2 &&
   input()?.selectionEnd===2;
  input().dispatchEvent(new KeyboardEvent("keydown",{
   key:"Enter",bubbles:true,cancelable:true,
  }));
  await until(()=>store[PROJECT]["chat:b"]==="DevTools" && !input());
  f.saved=store[PROJECT]["chat:a"]==="Aetherwild" &&
   row("chat:b")?.querySelector(".project-chip")?.textContent==="DevTools" &&
   store[ALIAS]["chat:a"]==="主线剧情" &&
   q("#feedback").textContent.includes("队列任务没有变化");

  expandMore("chat:d");
  action("chat:d","project-edit").click();
  fill("准备取消的分类");
  input().dispatchEvent(new KeyboardEvent("keydown",{
   key:"Escape",bubbles:true,cancelable:true,
  }));
  f.escCancel=!input() && store[PROJECT]["chat:d"]==="DevTools" &&
   document.activeElement?.dataset.action==="project-edit";

  expandMore("chat:b");
  action("chat:b","project-edit").click();
  fill("保存失败还在");
  failNextProject=true;
  action("chat:b","project-save").click();
  await until(()=>q("#feedback").textContent.includes("模拟项目写入失败"));
  f.failureRetains=input()?.value==="保存失败还在" &&
   document.activeElement===input() &&
   store[PROJECT]["chat:b"]==="DevTools";
  action("chat:b","project-save").click();
  await until(()=>store[PROJECT]["chat:b"]==="保存失败还在" && !input());
  f.retrySuccess=row("chat:b")?.querySelector(".project-chip")
   ?.textContent==="保存失败还在";
  action("chat:b","project-edit").click();
  fill("");
  action("chat:b","project-save").click();
  await until(()=>!Object.hasOwn(store[PROJECT],"chat:b") && !input());
  f.cleared=!row("chat:b")?.querySelector(".project-chip");

  outsideProject("chat:f","工具开发");
  f.externalSync=row("chat:f")?.querySelector(".project-chip")
   ?.textContent==="工具开发" &&
   [...filter().options].some(option=>option.textContent==="工具开发");
  const before=JSON.stringify(store[PROJECT]);
  q("#layout-toggle").click();
  await until(()=>store[VIEW].layout===(location.search.includes("full")?"cards":"list"));
  f.independent=JSON.stringify(store[PROJECT])===before &&
   store[VIEW].projectGrouped===true &&
   writes.filter(item=>item.key===PROJECT).every(item=>!item.value.favorites);
  sessions[0].review=0;
  sessions[0].halted=false;
  sessions[0].queuePaused=false;
  sessions[1].pageSignal="stale";
  updateState();
  await until(()=>q("#project-health-summary")?.textContent.includes("无待核对对话") &&
   q(".project-health-signal")?.textContent.includes("心跳待确认"));
  f.heartbeatSeparated=q("#project-health-summary")?.textContent.includes("无待核对对话") &&
   !q(".project-health-review") &&
   [...q("#project-health-cards").querySelectorAll(".project-health-signal")]
     .some(item=>item.textContent.includes("心跳待确认 1")) &&
   !projectGroup("project:Aetherwild")?.closest(".project-group")?.classList.contains("has-review");
  const healthFocused=q('[data-project-open="project:Aetherwild"]');
  healthFocused.focus();
  sessions[0].pending=1;
  updateState();
  await until(()=>q('[data-project-open="project:Aetherwild"]')!==healthFocused &&
    q('[data-project-health-key="project:Aetherwild"]')
      ?.querySelector(".project-health-metrics")?.textContent.includes("待 1"));
  f.overviewKeepsFocusAfterRefresh=document.activeElement?.dataset.projectOpen===
    "project:Aetherwild" &&
    q('[data-project-health-key="project:Aetherwild"]')
      ?.querySelector(".project-health-metrics")?.textContent.includes("待 1");
  sessions[0].pending=0;
  updateState();
  f.safety=calls.every(message=>message.type==="DASHBOARD_GET");
  f.noOverflow=document.documentElement.scrollWidth<=
   document.documentElement.clientWidth+3 &&
   q("#sessions").scrollWidth<=q("#sessions").clientWidth+3;
 }catch(error){f.error=error.stack||error.message;}
 f.ok=["initialData","optionsSafe","overviewInitiallyCompact",
  "overviewExpanded","overviewCounts","overviewQuickProject",
  "overviewToggleAll","overviewQuickReview","overviewReadOnly",
  "projectFilter","combinedFilter",
  "unassignedFilter","focusSummary","focusClears","projectGroups",
  "collapseAndFocus","scanExpands","groupMutualExclusion",
  "devGroupClosed","newReviewOpensProject","staleDoesNotReopen","inlineEditor",
  "refreshKeepsDraft","saved","escCancel","failureRetains",
  "retrySuccess","cleared","externalSync","independent","heartbeatSeparated",
  "overviewKeepsFocusAfterRefresh",
  "safety","noOverflow"].every(key=>f[key]===true);
 document.body.dataset.projectProbe=JSON.stringify(f);
},420);
`);
    const page="file:///"+path.join(folder,"dashboard.html").replace(/\\/g,"/")+
      (full?"?view=full":"");
    const run=spawnSync(browser,[
      "--headless=new","--disable-gpu","--disable-extensions","--no-first-run",
      "--disable-background-networking","--disable-component-update",
      "--disable-sync","--no-default-browser-check","--no-sandbox",
      "--force-device-scale-factor=1",
      "--window-size="+(full?"1400,940":"560,900"),
      "--user-data-dir="+path.join(folder,"profile"),
      "--virtual-time-budget=14000","--dump-dom",page,
    ],{encoding:"utf8",timeout:50000,maxBuffer:14e6});
    assert.equal(run.status,0,run.stderr||"Chrome did not launch the projects test");
    const match=run.stdout.match(/data-project-probe="([^"]+)"/);
    assert.ok(match,"Chrome did not finish projects UI probe");
    const flags=JSON.parse(match[1].replace(/&quot;/g,'"').replace(/&amp;/g,"&"));
    assert.equal(flags.ok,true,JSON.stringify(flags));
  }finally{
    fs.rmSync(folder,{recursive:true,force:true});
  }
}

for(const view of ["popup","full"]){
  if(process.env.CQ_PROJECTS_VIEW && process.env.CQ_PROJECTS_VIEW!==view)continue;
  test("真实 Chromium：项目归类、筛选、分组与跨管理页同步（"+view+"）",{
    skip:!fs.existsSync(browser) && "Chrome/Edge unavailable",
  },()=>runProjectProbe(view==="full"));
}
