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
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),"cq-quick-jump-"));
  try {
    for(const name of ["dashboard.js","dashboard.css"]) {
      fs.copyFileSync(path.join(__dirname,"..",name),path.join(folder,name));
    }
    const html=fs.readFileSync(path.join(__dirname,"..","dashboard.html"),"utf8")
      .replace('<script src="dashboard.js" defer></script>',
        '<script src="quick-jump-mock.js"></script><script src="dashboard.js" defer></script>');
    fs.writeFileSync(path.join(folder,"dashboard.html"),html);
    fs.writeFileSync(path.join(folder,"quick-jump-mock.js"),`"use strict";
const now=Date.now();
const make=(key,title,values={})=>({
 key,title,url:"https://chatgpt.com/c/"+key.slice(5),tabId:10,
 browser:"loaded",pending:0,active:0,review:0,enabledRules:0,allRules:0,
 halted:false,queuePaused:false,activeStatus:null,activeSince:null,
 lastEventAt:now-12000,pageSignal:"idle",pageSignalAt:now-2000,
 recentEvents:[],...values,
});
const sessions=[
 make("chat:review","原始主线剧情标题",{
  review:1,halted:true,queuePaused:true,
 }),
 make("chat:active","战斗系统设计",{
  active:1,activeStatus:"waiting",pageSignal:"generating",
 }),
 make("chat:tools","插件工具迭代",{pending:2}),
 make("chat:unsafe","<img src=x onerror=alert(1)> 标题"),
 ...Array.from({length:15},(_,i)=>make(
  "chat:extra-"+i,"普通对话 "+i,{lastEventAt:now-i*1000},
 )),
];
const calls=[];
const listeners=[];
const preferenceWrites=[];
const data={
 "cq.dashboard.view.v1":{
  favorites:["chat:tools"],compact:false,layout:location.search.includes("full")?"list":"cards",
  grouped:false,projectGrouped:true,focus:false,
 },
 "cq.dashboard.aliases.v1":{"chat:review":"Aetherwild 主线任务"},
 "cq.dashboard.projects.v1":{
  "chat:review":"Aetherwild","chat:active":"Aetherwild",
  "chat:tools":"工具开发","chat:unsafe":"工具开发",
 },
};
window.chrome={
 runtime:{
  getURL(name){return "chrome-extension://test-queue/"+name;},
  async sendMessage(message){
   calls.push({...message});
   if(message.type!=="DASHBOARD_GET")return {ok:false,error:"Not authorized"};
   return {ok:true,dashboard:{
    version:"0.47.0",sessions:sessions.map(session=>({...session})),
    cleanupEligible:0,
   }};
  },
 },
 storage:{
  local:{
   async get(key){return {[key]:JSON.parse(JSON.stringify(data[key]))};},
   async set(values){
    if(Object.keys(values).join(",")!=="cq.dashboard.view.v1")
     throw Error("Quick jump must not write queue or other storage");
    const key="cq.dashboard.view.v1";
    const oldValue=JSON.parse(JSON.stringify(data[key]));
    data[key]=JSON.parse(JSON.stringify(values[key]));
    preferenceWrites.push(data[key]);
    listeners.forEach(fn=>fn({[key]:{oldValue,newValue:data[key]}},"local"));
   },
  },
  onChanged:{addListener(fn){listeners.push(fn);}},
 },
};
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const until=async(check,max=5000)=>{
 const end=Date.now()+max;
 while(Date.now()<end){if(check())return true;await wait(45);}
 return Boolean(check());
};
const q=selector=>document.querySelector(selector);
const results=()=>[...document.querySelectorAll(".quick-jump-result")];
const cards=()=>[...document.querySelectorAll(".session")];
const current=()=>q(".session.scan-selected");
const modal=()=>q("#quick-jump-dialog");
const query=()=>q("#quick-jump-query");
const press=(target,key,props={})=>
 target.dispatchEvent(new KeyboardEvent("keydown",{
  key,bubbles:true,cancelable:true,...props,
 }));
const type=value=>{
 query().value=value;
 query().dispatchEvent(new Event("input",{bubbles:true}));
};
const open=()=>{
 q("#quick-jump-open").focus();
 q("#quick-jump-open").click();
};
const filterChange=(value)=>{
 const select=q("#project-filter");
 select.value=value;
 select.dispatchEvent(new Event("change",{bubbles:true}));
};
const fireUpdate=()=>listeners.forEach(fn=>fn({"cq.state.v2":{newValue:{}}},"local"));
setTimeout(async()=>{
 const f={};
 try {
  await until(()=>cards().length===19 &&
   !q("#quick-jump-open")?.disabled &&
   q('[data-project-group="project:Aetherwild"]'));
  f.hasTrigger=q("#quick-jump-open").textContent.includes("跳转") &&
   !modal().open && q("#quick-jump-query").getAttribute("aria-controls")==="quick-jump-results";
  const search=q("#search");
  search.focus();
  press(search,"g");
  f.typingUninterrupted=!modal().open && document.activeElement===search;
  q("#scan-next").focus();
  press(q("#scan-next"),"g");
  await until(()=>modal().open && document.activeElement===query() &&
   results().length===12);
  f.openByG=modal().open && results().length===12 &&
   q("#quick-jump-count").textContent.includes("12 / 19") &&
   q(".quick-jump-result[aria-selected='true']")?.getAttribute("role")==="option";

  type("Aetherwild 主线");
  f.aliasSearch=results().length===1 &&
   results()[0].dataset.quickJumpKey==="chat:review" &&
   results()[0].textContent.includes("Aetherwild 主线任务") &&
   results()[0].textContent.includes("需要人工核对");
  type("<img");
  f.untrustedTitleIsText=results().length===1 &&
   results()[0].textContent.includes("<img src=x onerror=alert(1)>") &&
   !q("#quick-jump-results img") &&
   !q("#quick-jump-results iframe");
  type("工具开发");
  f.crossProjectSearch=results().length===2 &&
   results().every(item=>item.textContent.includes("工具开发"));
  const before=results()[0].dataset.quickJumpKey;
  press(query(),"ArrowDown");
  f.arrowMovesSelection=results()[1].getAttribute("aria-selected")==="true" &&
   query().getAttribute("aria-activedescendant")===results()[1].id;
  press(query(),"ArrowUp");
  f.arrowMovesBack=results()[0].getAttribute("aria-selected")==="true" &&
   results()[0].dataset.quickJumpKey===before;
  press(query(),"Escape");
  await until(()=>!modal().open);
  f.escapeRestoresFocus=!modal().open &&
   document.activeElement===q("#scan-next") &&
   q("#project-filter").value==="all";

  // A real quick jump must find a chat even when its project is folded and
  // three separate filters currently make the regular dashboard empty.
  q('[data-project-group="project:Aetherwild"]').click();
  f.folded=q('[data-project-group="project:Aetherwild"]')
    ?.getAttribute("aria-expanded")==="false";
  filterChange("project:工具开发");
  q('#filters [data-filter="review"]').click();
  q("#favorites-only").click();
  search.value="does not exist";
  search.dispatchEvent(new Event("input",{bubbles:true}));
  f.initiallyFiltered=cards().length===0;
  open();
  type("战斗系统");
  f.ignoresFilters=results().length===1 &&
   results()[0].dataset.quickJumpKey==="chat:active";
  press(query(),"Enter");
  await until(()=>!modal().open && current()?.dataset.key==="chat:active");
  f.enterLocates=current()?.dataset.key==="chat:active" &&
   document.activeElement===current() &&
   current().getAttribute("aria-current")==="true" &&
   q("#project-filter").value==="all" &&
   q('#filters [data-filter="all"]').getAttribute("aria-pressed")==="true" &&
   q("#favorites-only").getAttribute("aria-pressed")==="false" &&
   search.value==="" &&
   q('[data-project-group="project:Aetherwild"]')
    ?.getAttribute("aria-expanded")==="true" &&
   q("#scan-current").textContent==="战斗系统设计" &&
   q("#feedback").textContent.includes("已清除之前的显示筛选");

  // When the 2.5-second snapshot updates while the dialog is open, keep
  // the query/selected result and focus on the search input.
  open();
  type("战斗系统");
  query().focus();
  sessions[1].pending=2;
  fireUpdate();
  await until(()=>q("#stat-pending")?.textContent==="4" && modal().open);
  f.refreshKeepsSearch=modal().open &&
   query().value==="战斗系统" &&
   document.activeElement===query() &&
   results()[0]?.dataset.quickJumpKey==="chat:active";
  f.debugRefresh={
   opened:modal().open,query:query().value,
   focused:document.activeElement?.id,
   keys:results().map(item=>item.dataset.quickJumpKey),
  };
  q("#quick-jump-close").click();
  await until(()=>!modal().open);
  f.closeButtonRestores=document.activeElement===q("#quick-jump-open");

  // The same locator must unfold a state group, not only a project group.
  q("#group-toggle").click();
  await until(()=>!!q(".group-review [data-group='review']"));
  q(".group-review [data-group='review']").click();
  f.reviewFolded=q(".group-review [data-group='review']")
    ?.getAttribute("aria-expanded")==="false";
  open();
  type("Aetherwild 主线");
  press(query(),"Enter");
  f.reviewUnfolded=current()?.dataset.key==="chat:review" &&
   q(".group-review [data-group='review']")
    ?.getAttribute("aria-expanded")==="true" &&
   document.activeElement===current();

  // Search misses are inert; clicking a result does not click ChatGPT.
  open();
  type("there is no such conversation");
  f.noMatches=results().length===0 &&
   q("#quick-jump-count").textContent.includes("没有匹配");
  press(query(),"Enter");
  f.emptyEnterInert=modal().open && current()?.dataset.key==="chat:review";
  type("<img");
  results()[0]?.click();
  f.mouseSelection=modal().open===false &&
   current()?.dataset.key==="chat:unsafe" &&
   !q("#dashboard img");
  const toolsCard=()=>cards().find(item=>item.dataset.key==="chat:tools");
  toolsCard()?.querySelector('[data-action="more"]')?.click();
  toolsCard()?.querySelector('[data-action="alias-edit"]')?.click();
  const draft=q("input[data-alias-input]");
  if (draft) {
    draft.value="尚未保存的备注草稿";
    draft.dispatchEvent(new Event("input",{bubbles:true}));
  }
  open();
  f.unsavedEditGuard=!modal().open &&
   q("input[data-alias-input]")?.value==="尚未保存的备注草稿" &&
   q("#feedback").textContent.includes("请先保存或取消") &&
   document.activeElement===q("input[data-alias-input]");
  toolsCard()?.querySelector('[data-action="alias-cancel"]')?.click();
  open();
  f.afterCancelCanJump=modal().open;
  q("#quick-jump-close").click();
  f.noQueueMutations=calls.every(message=>message.type==="DASHBOARD_GET");
  f.viewPreferenceOnly=preferenceWrites.length===1 &&
   preferenceWrites[0].grouped===true;
  f.noOverflow=document.documentElement.scrollWidth<=
   document.documentElement.clientWidth+3 &&
   q("#sessions").scrollWidth<=q("#sessions").clientWidth+3 &&
   modal().getBoundingClientRect().width <= innerWidth;
 }catch(error){f.error=error.stack||error.message;}
 f.ok=["hasTrigger","typingUninterrupted","openByG",
  "aliasSearch","untrustedTitleIsText","crossProjectSearch",
  "arrowMovesSelection","arrowMovesBack","escapeRestoresFocus",
  "folded","initiallyFiltered","ignoresFilters","enterLocates",
  "refreshKeepsSearch","closeButtonRestores","reviewFolded",
  "reviewUnfolded","noMatches","emptyEnterInert","mouseSelection",
  "unsavedEditGuard","afterCancelCanJump",
  "noQueueMutations","viewPreferenceOnly","noOverflow"].every(name=>f[name]===true);
 document.body.dataset.quickJumpProbe=JSON.stringify(f);
},400);
`);
    const url="file:///"+path.join(folder,"dashboard.html").replace(/\\/g,"/")+
      (full?"?view=full":"");
    const run=spawnSync(browser,[
      "--headless=new","--disable-gpu","--disable-extensions","--no-first-run",
      "--disable-background-networking","--disable-component-update",
      "--disable-sync","--no-default-browser-check","--no-sandbox",
      "--force-device-scale-factor=1",
      "--window-size="+(full?"1400,940":"560,900"),
      "--user-data-dir="+path.join(folder,"profile"),
      "--virtual-time-budget=14000","--dump-dom",url,
    ],{encoding:"utf8",timeout:50000,maxBuffer:15e6});
    assert.equal(run.status,0,run.stderr || "Chromium could not render quick jump");
    const match=run.stdout.match(/data-quick-jump-probe="([^"]+)"/);
    assert.ok(match,"Chromium did not finish quick jump probe");
    const f=JSON.parse(match[1].replace(/&quot;/g,'"').replace(/&amp;/g,"&"));
    assert.equal(f.ok,true,JSON.stringify(f));
  }finally{
    fs.rmSync(folder,{recursive:true,force:true});
  }
}

for(const view of ["popup","full"]){
  if(process.env.CQ_QUICK_VIEW && process.env.CQ_QUICK_VIEW!==view)continue;
  test("真实 Chromium：跨筛选快速跳转、安全键盘定位与状态刷新（"+view+"）",{
    skip:!fs.existsSync(browser) && "Chrome/Edge unavailable",
  },()=>probe(view==="full"));
}
