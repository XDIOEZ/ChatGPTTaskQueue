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
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),"cq-dashboard-alias-"));
  try {
    for (const filename of ["dashboard.js","dashboard.css"]) {
      fs.copyFileSync(path.join(__dirname,"..",filename),path.join(folder,filename));
    }
    const html=fs.readFileSync(path.join(__dirname,"..","dashboard.html"),"utf8")
      .replace('<script src="dashboard.js" defer></script>',
        '<script src="alias-mock.js"></script><script src="dashboard.js" defer></script>');
    fs.writeFileSync(path.join(folder,"dashboard.html"),html);
    fs.writeFileSync(path.join(folder,"alias-mock.js"),`"use strict";
const now=Date.now();
const sessions=[
 {key:"chat:a",title:"原始故事创作标题",url:"https://chatgpt.com/c/a",
  tabId:11,browser:"loaded",pending:2,active:1,review:0,
  enabledRules:0,allRules:0,halted:false,queuePaused:false,
  activeStatus:"waiting",activeSince:now-60000,
  lastEventAt:now-5000,pageSignal:"generating",recentEvents:[]},
 {key:"chat:b",title:"原始战斗策划标题",url:"https://chatgpt.com/c/b",
  tabId:null,browser:"closed",pending:2,active:0,review:0,
  enabledRules:0,allRules:0,halted:false,queuePaused:false,
  activeStatus:null,lastEventAt:now-15000,
  pageSignal:"unavailable",recentEvents:[]},
 {key:"chat:c",title:"ChatGPT",url:"https://chatgpt.com/c/c",
  tabId:13,browser:"loaded",pending:0,active:0,review:0,
  enabledRules:1,allRules:1,halted:false,queuePaused:false,
  lastEventAt:now-20000,pageSignal:"idle",recentEvents:[]},
 {key:"chat:d",title:"<img src=x onerror=alert(1)> 恶意标题",
  url:"https://chatgpt.com/c/d",tabId:14,browser:"loaded",
  pending:0,active:0,review:0,enabledRules:0,allRules:0,
  halted:false,queuePaused:false,lastEventAt:now-30000,
  pageSignal:"idle",recentEvents:[]},
];
const VIEW="cq.dashboard.view.v1";
const ALIAS="cq.dashboard.aliases.v1";
const storage={
 [VIEW]:{favorites:["chat:a"],compact:false,
   layout:location.search.includes("full")?"list":"cards",
   grouped:false,focus:false},
 [ALIAS]:{"chat:a":"01 主线剧本"},
};
let failAliasOnce=false;
const writes=[];
const messages=[];
const listeners=[];
const storageEmit=(change)=>{
 for(const listener of listeners)listener(change,"local");
};
window.chrome={
 runtime:{
  getURL(file){return "chrome-extension://test-queue/"+file;},
  async sendMessage(message){
   messages.push({...message});
   if(message.type!=="DASHBOARD_GET")return {ok:false,error:"UI must not operate queues"};
   return {ok:true,dashboard:{version:"0.44.0",sessions:sessions.map(x=>({...x})),cleanupEligible:0}};
  },
 },
 storage:{
  local:{
   async get(names){
    const keys=Array.isArray(names)?names:[names];
    return Object.fromEntries(keys.map(key=>[key,structuredClone(storage[key])]));
   },
   async set(values){
    const entries=Object.entries(values);
    if(entries.some(([key])=>key===ALIAS) && failAliasOnce){
      failAliasOnce=false;
      throw Error("模拟备注存档写入失败");
    }
    const changes={};
    for(const [key,value] of entries){
      const before=structuredClone(storage[key]);
      storage[key]=structuredClone(value);
      writes.push({key,value:structuredClone(value)});
      changes[key]={oldValue:before,newValue:storage[key]};
    }
    storageEmit(changes);
   },
  },
  onChanged:{addListener(listener){listeners.push(listener);}},
 },
};
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const until=async(fn,timeout=4500)=>{
 const end=Date.now()+timeout;
 while(Date.now()<end){if(fn())return true;await sleep(40);}
 return Boolean(fn());
};
const q=selector=>document.querySelector(selector);
const rows=()=>[...document.querySelectorAll(".session")];
const row=key=>rows().find(element=>element.dataset.key===key);
const keys=()=>rows().map(element=>element.dataset.key);
const button=(key,action)=>row(key)?.querySelector('[data-action="'+action+'"]');
const showMore=key=>{
 const b=button(key,"more");
 if(b?.getAttribute("aria-expanded")!=="true")b.click();
};
const editor=()=>q("input[data-alias-input]");
const type=value=>{
 const input=editor();
 input.value=value;
 input.dispatchEvent(new Event("input",{bubbles:true}));
};
const refresh=()=>{
 storageEmit({"cq.state.v2":{newValue:{}}});
};
const externalAlias=(key,value)=>{
 const prev=structuredClone(storage[ALIAS]);
 if(value===null)delete storage[ALIAS][key];
 else storage[ALIAS][key]=value;
 storageEmit({[ALIAS]:{oldValue:prev,newValue:structuredClone(storage[ALIAS])}});
};
setTimeout(async()=>{
 const f={};
 try{
  await until(()=>rows().length===4 && row("chat:a")?.querySelector(".session-title")
   ?.textContent==="01 主线剧本");
  f.initialRestored=row("chat:a").querySelector(".session-id")
    ?.textContent.includes("原始故事创作标题") &&
    row("chat:b").querySelector(".session-title")?.textContent==="原始战斗策划标题" &&
    q("#scan-nav")?.textContent.includes("巡检");
  const search=q("#search");
  search.value="原始故事";
  search.dispatchEvent(new Event("input",{bubbles:true}));
  f.searchOriginal=keys().join(",")==="chat:a";
  search.value="01 主线";
  search.dispatchEvent(new Event("input",{bubbles:true}));
  f.searchAlias=keys().join(",")==="chat:a";
  search.value="";
  search.dispatchEvent(new Event("input",{bubbles:true}));

  const sort=q("#sort-order");
  sort.value="name";
  sort.dispatchEvent(new Event("change",{bubbles:true}));
  f.aliasSortFirst=keys()[0]==="chat:a";
  showMore("chat:b");
  button("chat:b","alias-edit").click();
  f.inlineEditor=editor()?.value==="" &&
    editor()?.maxLength===48 &&
    document.activeElement===editor();
  type("02 战斗系统维护");
  editor().focus();
  editor().setSelectionRange(3,3);
  sessions[1].pending=3;
  refresh();
  await until(()=>row("chat:b")?.textContent.includes("待发送"));
  f.draftSurvivesRefresh=editor()?.value==="02 战斗系统维护" &&
    document.activeElement===editor() && editor()?.selectionStart===3 &&
    editor()?.selectionEnd===3;
  const writesBeforeSave=writes.length;
  editor().dispatchEvent(new KeyboardEvent("keydown",{key:"j",bubbles:true,cancelable:true}));
  f.noKeyboardHijack=editor()?.value==="02 战斗系统维护" &&
    document.activeElement===editor();
  editor().dispatchEvent(new KeyboardEvent("keydown",{
    key:"Enter",bubbles:true,cancelable:true,
  }));
  await until(()=>row("chat:b")?.querySelector(".session-title")
    ?.textContent==="02 战斗系统维护" && editor()===null);
  f.savedAndSynced=storage[ALIAS]["chat:b"]==="02 战斗系统维护" &&
    storage[ALIAS]["chat:a"]==="01 主线剧本" &&
    writes.length===writesBeforeSave+1 &&
    writes.at(-1).key===ALIAS &&
    row("chat:b").querySelector(".session-id")?.textContent.includes("原始战斗策划标题") &&
    q("#feedback")?.textContent.includes("未修改") &&
    button("chat:b","alias-edit")?.textContent.includes("修改备注");

  showMore("chat:d");
  button("chat:d","alias-edit").click();
  type("<img src=x onerror=alert(1)>");
  button("chat:d","alias-save").click();
  await until(()=>storage[ALIAS]["chat:d"]==="<img src=x onerror=alert(1)>");
  f.xssSafe=row("chat:d")?.querySelector(".session-title")
    ?.textContent==="<img src=x onerror=alert(1)>" &&
    !document.querySelector("#dashboard img");

  // Cross-dashboard updates are delivered by chrome.storage.onChanged.
  externalAlias("chat:c","03 后台规则管理");
  f.externalSync=row("chat:c")?.querySelector(".session-title")
    ?.textContent==="03 后台规则管理" &&
    row("chat:c")?.querySelector(".session-id")?.textContent.includes("ChatGPT 对话");

  showMore("chat:c");
  button("chat:c","alias-edit").click();
  type("不应保存的草稿");
  editor().dispatchEvent(new KeyboardEvent("keydown",{
    key:"Escape",bubbles:true,cancelable:true,
  }));
  f.escapeCancel=editor()===null &&
    row("chat:c")?.querySelector(".session-title")?.textContent==="03 后台规则管理" &&
    document.activeElement?.dataset.action==="alias-edit";

  showMore("chat:b");
  button("chat:b","alias-edit").click();
  type("暂时不更改");
  button("chat:b","alias-cancel").click();
  f.cancelDoesNotSave=storage[ALIAS]["chat:b"]==="02 战斗系统维护";
  button("chat:b","alias-edit").click();
  type("保存失败需保留光标");
  failAliasOnce=true;
  button("chat:b","alias-save").click();
  await until(()=>q("#feedback")?.textContent.includes("模拟备注存档写入失败"));
  f.failureKeepsDraft=storage[ALIAS]["chat:b"]==="02 战斗系统维护" &&
    editor()?.value==="保存失败需保留光标" &&
    document.activeElement===editor() &&
    q("#feedback").classList.contains("error");

  // Retrying keeps the editor and only updates the aliases storage key.
  button("chat:b","alias-save").click();
  await until(()=>storage[ALIAS]["chat:b"]==="保存失败需保留光标" && editor()===null);
  f.retrySucceeded=row("chat:b")?.querySelector(".session-title")
    ?.textContent==="保存失败需保留光标";
  button("chat:b","alias-edit").click();
  type("");
  button("chat:b","alias-save").click();
  await until(()=>!Object.hasOwn(storage[ALIAS],"chat:b") && editor()===null);
  f.clearRestoresOfficial=row("chat:b")?.querySelector(".session-title")
    ?.textContent==="原始战斗策划标题" &&
    !row("chat:b")?.querySelector(".session-id")?.textContent.includes("原始战斗策划标题");

  const aliasesBefore=structuredClone(storage[ALIAS]);
  q("#density-toggle").click();
  await until(()=>storage[VIEW].compact===true);
  f.independentStorage=JSON.stringify(storage[ALIAS])===JSON.stringify(aliasesBefore) &&
    storage[VIEW].favorites.join(",")==="chat:a" &&
    storage[VIEW].compact===true &&
    writes.filter(item=>item.key===ALIAS).every(item=>item.value && !item.value.favorites);
  f.noOverflow=document.documentElement.scrollWidth <=
    document.documentElement.clientWidth+3 &&
    q("#sessions").scrollWidth<=q("#sessions").clientWidth+3;
  f.noQueueMutations=messages.every(message=>message.type==="DASHBOARD_GET");
 }catch(error){f.error=error.stack||error.message;}
 f.ok=["initialRestored","searchOriginal","searchAlias","aliasSortFirst",
  "inlineEditor","draftSurvivesRefresh","noKeyboardHijack","savedAndSynced",
  "xssSafe","externalSync","escapeCancel","cancelDoesNotSave",
  "failureKeepsDraft","retrySucceeded","clearRestoresOfficial",
  "independentStorage","noOverflow","noQueueMutations"]
  .every(key=>f[key]===true);
 document.body.dataset.aliasProbe=JSON.stringify(f);
},420);
`);
    const uri="file:///"+path.join(folder,"dashboard.html").replace(/\\/g,"/")+
      (full?"?view=full":"");
    const result=spawnSync(browser,[
      "--headless=new","--disable-gpu","--disable-extensions","--no-first-run",
      "--disable-background-networking","--disable-component-update",
      "--disable-sync","--no-default-browser-check","--no-sandbox",
      "--force-device-scale-factor=1",
      "--window-size="+(full?"1400,940":"560,900"),
      "--user-data-dir="+path.join(folder,"profile"),
      "--virtual-time-budget=11000","--dump-dom",uri,
    ],{encoding:"utf8",timeout:48000,maxBuffer:13e6});
    assert.equal(result.status,0,result.stderr || "Chrome failed to render aliases");
    const match=result.stdout.match(/data-alias-probe="([^"]+)"/);
    assert.ok(match,"Chrome did not complete alias UI probe");
    const flags=JSON.parse(match[1].replace(/&quot;/g,'"').replace(/&amp;/g,"&"));
    assert.equal(flags.ok,true,JSON.stringify(flags));
  }finally{
    fs.rmSync(folder,{recursive:true,force:true});
  }
}

for(const view of ["popup","full"]){
  if(process.env.CQ_ALIAS_VIEW && process.env.CQ_ALIAS_VIEW!==view)continue;
  test("真实 Chromium：会话本地备注、搜索、编辑保留、跨视图同步（"+view+"）",{
    skip:!fs.existsSync(browser) && "Chrome/Edge unavailable",
  },()=>probe(view==="full"));
}
