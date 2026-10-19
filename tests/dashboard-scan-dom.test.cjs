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

function probe(full){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),"cq-dashboard-scan-"));
  try{
    for(const file of ["dashboard.js","dashboard.css"]){
      fs.copyFileSync(path.join(__dirname,"..",file),path.join(directory,file));
    }
    const html=fs.readFileSync(path.join(__dirname,"..","dashboard.html"),"utf8")
      .replace('<script src="dashboard.js" defer></script>',
        '<script src="scan-mock.js"></script><script src="dashboard.js" defer></script>');
    fs.writeFileSync(path.join(directory,"dashboard.html"),html);
    fs.writeFileSync(path.join(directory,"scan-mock.js"),`"use strict";
const now=Date.now();
const make=(key,title,extra={})=>({
 key,title,url:"https://chatgpt.com/c/"+key.slice(5),tabId:10,
 browser:"loaded",pending:0,active:0,review:0,enabledRules:0,allRules:0,
 halted:false,queuePaused:false,activeStatus:null,activeSince:null,
 lastEventAt:now-12000,pageSignal:"idle",pageSignalAt:now-1000,
 recentEvents:[],...extra,
});
const sessions=[
 make("chat:review","必须核对",{review:1,halted:true,queuePaused:true}),
 make("chat:active","正在执行",{active:1,activeStatus:"waiting"}),
 make("chat:pending","待发送",{pending:2}),
 make("chat:paused","已暂停",{queuePaused:true}),
 make("chat:rules","规则待命",{enabledRules:1,allRules:1}),
 make("chat:unsafe","<img src=x onerror=alert(1)>空闲对话"),
];
const messages=[];
const listeners=[];
let prefs={favorites:[],compact:false,layout:"cards",grouped:false,focus:false};
window.chrome={
 runtime:{
  getURL(name){return "chrome-extension://test-queue/"+name;},
  async sendMessage(message){
   messages.push({...message});
   if(message.type!=="DASHBOARD_GET")return {ok:false,error:"No queue mutations"};
   return {ok:true,dashboard:{version:"0.42.0",sessions:sessions.map(s=>({...s})),cleanupEligible:0}};
  },
 },
 storage:{
  local:{
   async get(key){return {[key]:JSON.parse(JSON.stringify(prefs))};},
   async set(value){
    const old=prefs;
    prefs=JSON.parse(JSON.stringify(value["cq.dashboard.view.v1"]));
    listeners.forEach(fn=>fn({"cq.dashboard.view.v1":{oldValue:old,newValue:prefs}},"local"));
   },
  },
  onChanged:{addListener(fn){listeners.push(fn);}},
 },
};
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const until=async(fn,max=4500)=>{
 const end=Date.now()+max;
 while(Date.now()<end){if(fn())return true;await wait(40);}
 return Boolean(fn());
};
const q=selector=>document.querySelector(selector);
const cards=()=>[...document.querySelectorAll(".session")];
const current=()=>q(".session.scan-selected");
const key=()=>current()?.dataset.key;
const progress=()=>q("#scan-progress")?.textContent;
const press=(eventKey,target=document.body,extra={})=>
  target.dispatchEvent(new KeyboardEvent("keydown",{
    key:eventKey,bubbles:true,cancelable:true,...extra,
  }));
const refresh=()=>listeners.forEach(fn=>fn({"cq.state.v2":{newValue:{}}},"local"));
setTimeout(async()=>{
 const flags={};
 try{
  await until(()=>cards().length===6 && q("#scan-next")?.disabled===false &&
    progress()?.includes("6 个对话"));
  flags.initial=!current() && q("#scan-prev").disabled===false &&
    q("#scan-exit").hidden && q("#scan-current").textContent==="";
  q("#scan-next").focus();
  q("#scan-next").click();
  flags.first=key()==="chat:review" && progress()==="1 / 6" &&
    current()?.getAttribute("aria-current")==="true" &&
    document.activeElement===q("#scan-next");
  q("#scan-next").click();
  flags.next=key()==="chat:active" && progress()==="2 / 6" &&
    q("#scan-current").textContent==="正在执行";
  q("#scan-prev").click();
  flags.prev=key()==="chat:review" && progress()==="1 / 6";
  q("#scan-prev").click();
  flags.wrap=key()==="chat:unsafe" && progress()==="6 / 6" &&
    q("#scan-current").textContent.includes("<img src=x") &&
    !q("#scan-nav img") && !current()?.querySelector("img");

  press("j");
  flags.keyboardNext=key()==="chat:review" && progress()==="1 / 6" &&
    document.activeElement===current();
  press("k",document.activeElement);
  flags.keyboardPrev=key()==="chat:unsafe" && progress()==="6 / 6" &&
    document.activeElement===current();
  const search=q("#search");
  search.focus();
  press("j",search);
  press("k",search);
  flags.noHijackTyping=key()==="chat:unsafe" && document.activeElement===search;
  press("Escape",search);
  flags.escapeNotStolen=key()==="chat:unsafe";
  press("Escape",document.body);
  flags.keyboardExit=!current() && q("#scan-exit").hidden &&
    progress().includes("6 个对话");

  // Groups can be collapsed by the user. Navigation must automatically
  // expand the selected group's content instead of pointing at hidden UI.
  q("#group-toggle").click();
  await until(()=>prefs.grouped===true && !!q(".group-active [data-group='active']"));
  q(".group-active [data-group='active']").click();
  flags.activeCollapsed=q(".group-active [data-group='active']")
    ?.getAttribute("aria-expanded")==="false";
  q("#scan-next").click(); // review
  q("#scan-next").click(); // active
  flags.groupAutoExpands=key()==="chat:active" &&
    q(".group-active [data-group='active']")?.getAttribute("aria-expanded")==="true" &&
    current()?.getBoundingClientRect().height>0;

  // A saved snapshot may update every few seconds; the active patrol card
  // must not disappear or lose focus when it is replaced with a new node.
  press("j",document.body);
  const selectedBefore=current();
  const keyBefore=key();
  sessions.find(s=>s.key===keyBefore).lastEventAt=Date.now();
  refresh();
  await until(()=>current()!==selectedBefore &&
    key()===keyBefore && document.activeElement===current());
  flags.refreshRetainsFocus=current()!==selectedBefore &&
    document.activeElement===current() && key()===keyBefore;

  // Sorting/filtering changes the patrol order. Keep the cursor by key if
  // present, otherwise clear it instead of highlighting a wrong dialogue.
  const sort=q("#sort-order");
  sort.value="name";
  sort.dispatchEvent(new Event("change",{bubbles:true}));
  flags.sortKeepsSelection=key()===keyBefore &&
    q("#scan-progress").textContent.includes("/ 6");
  search.value="必须核对";
  search.dispatchEvent(new Event("input",{bubbles:true}));
  flags.filterClearsMissing=!current() &&
    progress().includes("1 个对话") && !q("#scan-next").disabled;
  q("#scan-next").click();
  flags.filteredNavigate=key()==="chat:review" && progress()==="1 / 1";
  search.value="no match at all";
  search.dispatchEvent(new Event("input",{bubbles:true}));
  flags.emptyDisables=!current() && q("#scan-next").disabled &&
    q("#scan-prev").disabled && progress().includes("0 个对话");
  q("#scan-next").click();
  flags.emptySafe=!current() && messages.every(m=>m.type==="DASHBOARD_GET");
  search.value="";
  search.dispatchEvent(new Event("input",{bubbles:true}));

  q("#focus-mode").click();
  await until(()=>prefs.focus===true && q("#dashboard").classList.contains("focus-mode"));
  q("#layout-toggle").click();
  await until(()=>prefs.layout==="list" && q("#dashboard").classList.contains("list-mode"));
  q("#scan-next").click();
  flags.modeCompatible=!!current()?.classList.contains("monitor-row") &&
    getComputedStyle(q("#scan-nav")).display==="flex" &&
    q("#scan-exit").hidden===false;
  q("#scan-exit").click();
  flags.finish=!current() && q("#scan-exit").hidden &&
    document.activeElement===q("#scan-next");
  flags.noHorizontalOverflow=document.documentElement.scrollWidth<=
    document.documentElement.clientWidth+3 &&
    q("#sessions").scrollWidth<=q("#sessions").clientWidth+3;
  flags.readOnly=messages.every(m=>m.type==="DASHBOARD_GET");
 }catch(error){flags.error=error.stack||error.message;}
 flags.ok=["initial","first","next","prev","wrap","keyboardNext",
  "keyboardPrev","noHijackTyping","escapeNotStolen","keyboardExit",
  "activeCollapsed","groupAutoExpands","refreshRetainsFocus",
  "sortKeepsSelection","filterClearsMissing","filteredNavigate",
  "emptyDisables","emptySafe","modeCompatible","finish",
  "noHorizontalOverflow","readOnly"].every(name=>flags[name]===true);
 document.body.dataset.scanProbe=JSON.stringify(flags);
},400);
`);
    const url="file:///"+path.join(directory,"dashboard.html").replace(/\\/g,"/")+
      (full?"?view=full":"");
    const run=spawnSync(browser,[
      "--headless=new","--disable-gpu","--disable-extensions",
      "--no-first-run","--disable-background-networking","--disable-component-update",
      "--disable-sync","--no-default-browser-check","--no-sandbox",
      "--window-size="+(full?"1400,940":"560,900"),
      "--force-device-scale-factor=1",
      "--user-data-dir="+path.join(directory,"profile"),
      "--virtual-time-budget=14000","--dump-dom",url,
    ],{encoding:"utf8",timeout:55000,maxBuffer:12e6});
    assert.equal(run.status,0,run.stderr||"Chromium did not start the scan test");
    const match=run.stdout.match(/data-scan-probe="([^"]+)"/);
    assert.ok(match,"Chromium did not finish the scan UI probe");
    const result=JSON.parse(match[1].replace(/&quot;/g,'"').replace(/&amp;/g,"&"));
    assert.equal(result.ok,true,JSON.stringify(result));
  }finally{
    fs.rmSync(directory,{recursive:true,force:true});
  }
}

for(const view of ["popup","full"]){
  if(process.env.CQ_SCAN_VIEW && process.env.CQ_SCAN_VIEW!==view)continue;
  test("真实 Chromium：逐对话巡检导航、键盘 J/K、分组和刷新焦点（"+view+"）",{
    skip:!fs.existsSync(browser) && "Chrome/Edge unavailable",
  },()=>probe(view==="full"));
}
