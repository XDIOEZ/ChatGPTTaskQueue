"use strict";

const {test} = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const {spawnSync} = require("node:child_process");

const browser=process.env.CQ_BROWSER_BIN || (process.platform === "win32"
  ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
  : "/usr/bin/google-chrome");

function runDeleteProbe(full) {
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),"cq-dashboard-delete-"));
  try {
    for (const file of ["dashboard.js","dashboard.css"]) {
      fs.copyFileSync(path.join(__dirname,"..",file),path.join(folder,file));
    }
    const html=fs.readFileSync(path.join(__dirname,"..","dashboard.html"),"utf8")
      .replace('<script src="dashboard.js" defer></script>',
        '<script src="delete-mock.js"></script><script src="dashboard.js" defer></script>');
    fs.writeFileSync(path.join(folder,"dashboard.html"),html);
    fs.writeFileSync(path.join(folder,"delete-mock.js"),`"use strict";
const current=Date.now();
const makeSession=(key,title,values={})=>({
 key,title,url:"https://chatgpt.com/c/"+key.slice(5),tabId:null,
 browser:"closed",pending:0,active:0,review:0,enabledRules:0,allRules:0,
 queuePaused:false,halted:false,activeStatus:null,activeSince:null,
 lastEventAt:current-6000,pageSignal:"unavailable",pageSignalAt:null,
 requiresDiscard:false,recentEvents:[],...values,
});
let sessions=[
 makeSession("chat:open-idle","正在打开的空会话",{
  tabId:11,browser:"loaded",pageSignal:"idle",
 }),
 makeSession("chat:open-active","正在工作的会话",{
  tabId:12,browser:"loaded",pending:2,active:1,activeStatus:"waiting",
  requiresDiscard:true,pageSignal:"generating",
 }),
 makeSession("chat:closed-pending","<img src=x onerror=alert(1)>失效队列",{
  pending:2,allRules:2,enabledRules:1,requiresDiscard:true,
 }),
 makeSession("chat:closed-review","停机待核对",{
  review:1,halted:true,queuePaused:true,requiresDiscard:true,
 }),
 makeSession("chat:unknown","浏览器状态不明",{
  browser:"unknown",requiresDiscard:false,
 }),
];
let cleanupEligible=3;
let prefs={
 favorites:["chat:closed-pending","chat:open-active"],
 compact:false,layout:location.search.includes("full")?"list":"cards",grouped:false,
};
let failNextRemoval=false;
let confirmValue=true;
let promptValue="移除";
const confirms=[];
const prompts=[];
const calls=[];
const listeners=[];
window.confirm=message=>{
 confirms.push(String(message));return confirmValue;
};
window.prompt=message=>{
 prompts.push(String(message));return promptValue;
};
const emitPrefs=(previous)=>listeners.forEach(fn=>fn({
 "cq.dashboard.view.v1":{oldValue:previous,newValue:prefs},
},"local"));
const snap=()=>({ok:true,dashboard:{
 version:"0.35.0",sessions:sessions.map(s=>({...s})),cleanupEligible,
}});
window.chrome={
 runtime:{
  getURL(name){return "chrome-extension://test-queue/"+name;},
  async sendMessage(message){
   calls.push({...message});
   if(message.type==="DASHBOARD_GET")return snap();
   if(message.type==="DASHBOARD_REMOVE_CONVERSATION"){
    if(failNextRemoval){failNextRemoval=false;return {ok:false,error:"模拟存档写入失败"};}
    const item=sessions.find(s=>s.key===message.key);
    if(!message.confirm || !item)return {ok:false,error:"missing confirmation"};
    if(item.requiresDiscard && (message.discardWork!==true ||
       message.confirmKey!==message.key))return {ok:false,error:"second confirmation required"};
    if(item.browser!=="closed" && item.requiresDiscard)return {ok:false,error:"tab still working"};
    sessions=sessions.filter(s=>s.key!==message.key);
    const old=prefs;
    prefs={...prefs,favorites:prefs.favorites.filter(key=>key!==message.key)};
    emitPrefs(old);
    return {...snap(),removedCount:1};
   }
   if(message.type==="DASHBOARD_CLEANUP_IDLE"){
    if(message.confirm!==true)return {ok:false,error:"confirmation required"};
    const removedCount=cleanupEligible;
    cleanupEligible=0;
    return {...snap(),removedCount};
   }
   return {ok:false,error:"invalid manager request"};
  },
 },
 storage:{
  local:{
   async get(key){return {[key]:JSON.parse(JSON.stringify(prefs))};},
   async set(){throw Error("Unexpected view settings write");},
  },
  onChanged:{addListener(fn){listeners.push(fn);}},
 },
};
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const until=async(fn,limit=4000)=>{
 const end=Date.now()+limit;
 while(Date.now()<end){if(fn())return true;await sleep(40);}
 return Boolean(fn());
};
const q=selector=>document.querySelector(selector);
const card=key=>[...document.querySelectorAll(".session")]
 .find(item=>item.dataset.key===key);
const removeButton=key=>card(key)?.querySelector('[data-action="remove"]');
const openRemoveButton=key=>{
 const toggle=card(key)?.querySelector('[data-action="more"]');
 if(toggle?.getAttribute("aria-expanded")!=="true")toggle?.click();
 return removeButton(key);
};
const countCalls=kind=>calls.filter(call=>call.type===kind).length;
setTimeout(async()=>{
 const flags={};
 try {
  await until(()=>q("#stat-pending")?.textContent==="4" &&
    q("#cleanup-idle")?.textContent.includes("3") &&
    !!removeButton("chat:closed-pending"));
  flags.actionsVisible=!!removeButton("chat:open-idle") &&
    !!removeButton("chat:closed-pending") &&
    q("#cleanup-idle").hidden===false;
  flags.removeDisclosedByMore=
    removeButton("chat:closed-pending").closest(".session-more-panel").hidden===true &&
    card("chat:closed-pending").querySelector('[data-action="more"]')
      ?.getAttribute("aria-expanded")==="false" &&
    !card("chat:closed-pending").querySelector(".session-more-panel")
      ?.getBoundingClientRect().height;
  removeButton("chat:closed-pending").click();
  flags.hiddenCannotRemove=countCalls("DASHBOARD_REMOVE_CONVERSATION")===0 &&
    confirms.length===0;
  flags.protectOpenWork=removeButton("chat:open-active").disabled===true &&
    removeButton("chat:unknown").disabled===true;
  flags.safeWarning=!document.querySelector("#dashboard img") &&
    card("chat:closed-pending")?.textContent.includes("<img src=x onerror=alert(1)>");
  openRemoveButton("chat:closed-pending");
  flags.moreAccessible=card("chat:closed-pending")
    ?.querySelector('[data-action="more"]')?.getAttribute("aria-expanded")==="true" &&
    document.activeElement?.dataset.action==="more" &&
    removeButton("chat:closed-pending").closest(".session-more-panel").hidden===false &&
    card("chat:closed-pending").textContent.includes("不删除 ChatGPT 聊天");
  openRemoveButton("chat:open-active");
  flags.disabledExplanation=card("chat:open-active")
    ?.querySelector(".session-more-note")?.textContent.includes("请先关闭原标签页") &&
    removeButton("chat:open-active")?.disabled===true;
  openRemoveButton("chat:closed-pending");
  removeButton("chat:closed-pending").focus();
  removeButton("chat:closed-pending").dispatchEvent(
    new KeyboardEvent("keydown",{key:"Escape",bubbles:true}));
  flags.escapeReturnsToMore=card("chat:closed-pending")
    ?.querySelector('[data-action="more"]')?.getAttribute("aria-expanded")==="false" &&
    document.activeElement?.dataset.action==="more";
  openRemoveButton("chat:closed-review");
  openRemoveButton("chat:closed-pending");
  flags.onlyOneMenu=card("chat:closed-review")
    ?.querySelector(".session-more-panel")?.hidden===true &&
    card("chat:closed-pending")?.querySelector(".session-more-panel")?.hidden===false;
  // Programmatic .click() does not automatically focus inputs like a mouse.
  q("#search").focus();
  q("#search").click();
  flags.outsideDismiss=card("chat:closed-pending")
    ?.querySelector(".session-more-panel")?.hidden===true &&
    document.activeElement===q("#search") &&
    countCalls("DASHBOARD_REMOVE_CONVERSATION")===0;

  confirmValue=false;
  openRemoveButton("chat:closed-pending").click();
  flags.cancelDoesNothing=countCalls("DASHBOARD_REMOVE_CONVERSATION")===0 &&
    confirms.at(-1)?.includes("不会删除 ChatGPT 官方对话");
  confirmValue=true;
  promptValue=null;
  openRemoveButton("chat:closed-pending").click();
  flags.promptBlocksUnsafe=countCalls("DASHBOARD_REMOVE_CONVERSATION")===0 &&
    prompts.at(-1)?.includes("输入「移除」");
  promptValue="移除";
  failNextRemoval=true;
  openRemoveButton("chat:closed-pending").click();
  await until(()=>q("#feedback")?.textContent.includes("模拟存档写入失败"));
  flags.errorPreservesData=!!card("chat:closed-pending") &&
    q("#feedback").classList.contains("error") &&
    countCalls("DASHBOARD_REMOVE_CONVERSATION")===1;
  openRemoveButton("chat:closed-pending").click();
  await until(()=>!card("chat:closed-pending"));
  const removals=calls.filter(call=>call.type==="DASHBOARD_REMOVE_CONVERSATION");
  flags.deleteClosedWork=removals.length===2 &&
    removals.at(-1).discardWork===true &&
    removals.at(-1).confirmKey==="chat:closed-pending" &&
    q("#feedback")?.textContent.includes("官方聊天未受影响") &&
    q("#result-count").textContent.includes("重点 1");
  flags.otherWorkPreserved=!!card("chat:open-active") &&
    !!card("chat:closed-review") &&
    prefs.favorites.join(",")==="chat:open-active";
  openRemoveButton("chat:closed-review").click();
  await until(()=>!card("chat:closed-review"));
  flags.removeReviewRequiresPrompt=removals.length===2 &&
    calls.filter(call=>call.type==="DASHBOARD_REMOVE_CONVERSATION").length===3 &&
    prompts.length>=3;
  openRemoveButton("chat:open-idle").click();
  await until(()=>!card("chat:open-idle"));
  const last=calls.filter(call=>call.type==="DASHBOARD_REMOVE_CONVERSATION").at(-1);
  flags.removeOpenIdle=last?.confirm===true &&
    last?.discardWork===false &&
    !calls.some(call=>call.type==="TAB_REMOVE" || call.type==="DELETE_CHATGPT");
  confirmValue=false;
  q("#cleanup-idle").click();
  flags.cancelBulk=countCalls("DASHBOARD_CLEANUP_IDLE")===0 &&
    !q("#cleanup-idle").hidden;
  confirmValue=true;
  q("#cleanup-idle").click();
  await until(()=>q("#cleanup-idle").hidden===true);
  flags.bulkSuccessful=countCalls("DASHBOARD_CLEANUP_IDLE")===1 &&
    q("#feedback").textContent.includes("已清理 3 个无任务旧对话") &&
    q("#cleanup-idle").hidden===true;
  flags.noFalseChatDeletion=calls.every(call=>
    ["DASHBOARD_GET","DASHBOARD_REMOVE_CONVERSATION","DASHBOARD_CLEANUP_IDLE"].includes(call.type));
  flags.noOverflow=document.documentElement.scrollWidth <=
    document.documentElement.clientWidth+3 &&
    q("#sessions").scrollWidth<=q("#sessions").clientWidth+3;
 }catch(error){flags.error=error.stack||error.message;}
 flags.ok=["actionsVisible","removeDisclosedByMore","hiddenCannotRemove","protectOpenWork",
  "safeWarning","moreAccessible","disabledExplanation","escapeReturnsToMore",
  "onlyOneMenu","outsideDismiss","cancelDoesNothing",
  "promptBlocksUnsafe","errorPreservesData","deleteClosedWork",
  "otherWorkPreserved","removeReviewRequiresPrompt","removeOpenIdle",
  "cancelBulk","bulkSuccessful","noFalseChatDeletion","noOverflow"]
  .every(key=>flags[key]===true);
 document.body.dataset.deleteCheck=JSON.stringify(flags);
},350);
`);
    const page="file:///" + path.join(folder,"dashboard.html").replace(/\\/g,"/") +
      (full ? "?view=full" : "");
    const run=spawnSync(browser,[
      "--headless=new","--disable-gpu","--disable-extensions","--no-first-run",
      "--disable-background-networking","--disable-component-update",
      "--disable-sync","--no-default-browser-check",
      "--force-device-scale-factor=1",
      "--window-size="+(full?"1380,920":"560,900"),
      "--user-data-dir="+path.join(folder,"profile"),
      "--virtual-time-budget=11000","--dump-dom",page,
    ],{encoding:"utf8",timeout:28000,maxBuffer:12e6});
    assert.equal(run.status,0,run.stderr || "Chrome failed");
    const match=run.stdout.match(/data-delete-check="([^"]+)"/);
    assert.ok(match,"Browser did not finish deletion controls test");
    const flags=JSON.parse(match[1].replace(/&quot;/g,'"').replace(/&amp;/g,"&"));
    assert.equal(flags.ok,true,JSON.stringify(flags));
  } finally {
    fs.rmSync(folder,{recursive:true,force:true});
  }
}

for(const layout of ["popup","full"]) {
  test("真实 Chrome：移除本地对话记录、二次确认与批量清理（"+layout+"）",{
    skip:!fs.existsSync(browser) && "Chrome is not installed",
  },()=>runDeleteProbe(layout==="full"));
}
