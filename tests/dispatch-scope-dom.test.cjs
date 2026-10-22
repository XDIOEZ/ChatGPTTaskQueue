"use strict";

const {test} = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {spawnSync} = require("node:child_process");

const browser = process.env.CQ_BROWSER_BIN || (process.platform === "win32"
  ? "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"
  : "/usr/bin/google-chrome");

test("真实浏览器：领取前绑定页面，导航意图与 A→B→A 均阻止旧预约发送", {
  skip:!fs.existsSync(browser) && "Chromium not installed",
}, () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"cq-dispatch-scope-"));
  try {
    // Keep real composer, route epoch and scoped RPC behavior. Disable only
    // startup/heartbeat scheduling so this fixture drives each send itself.
    const source=fs.readFileSync(path.join(__dirname,"..","content.js"),"utf8")
      .replace("  function boundHere() {",
        "  function boundHere() { return true; }\n  function originalBoundHere() {")
      .replace("  function requestQueueWake(delay = 0) {",
        "  function requestQueueWake() {}\n  function originalRequestQueueWake(delay = 0) {")
      .replace("  void init();", `  window.__cqDispatchScope={
        captureSendScope,invalidateSendPage,sendScopeCurrent,sendTask,
        prime(next){state=next;sessionKey=next.key;}
      };`);
    fs.writeFileSync(path.join(dir,"content.js"),source);
    fs.writeFileSync(path.join(dir,"index.html"),`<!doctype html><html lang="zh">
<head><meta charset="utf-8"></head><body><main>
<form id="composer"><textarea id="prompt-textarea"></textarea>
  <button id="send" type="button" data-testid="send-button" aria-label="Send" style="display:none">Send</button>
  <button type="button" aria-label="Start Voice">Voice</button>
</form></main><script>
history.replaceState(null,"","#A");
const editor=document.getElementById("prompt-textarea");
const send=document.getElementById("send");
const calls=[],sent=[];
let inputEvents=0;
editor.addEventListener("input",()=>inputEvents++);
send.addEventListener("click",()=>sent.push(editor.value));
let currentState=null;
window.chrome={runtime:{getManifest(){return {version:"0.49.35"};},
  onMessage:{addListener(){}},async sendMessage(message){
    calls.push({...message});
    if(message.type==="RELEASE_CLAIM"){
      const task=currentState.tasks.find(item=>item.id===message.id);
      if(task){task.status="pending";currentState.activeTaskId=null;}
    }
    return {ok:true,state:currentState,sessionKey:"draft:1",settings:{maxPending:100}};
  }},storage:{onChanged:{addListener(){}}}};
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const until=async predicate=>{
  for(let index=0;index<75;index++){if(predicate())return true;await wait(20);}
  return false;
};
const prime=(id,text)=>{
  editor.value="";send.style.display="none";
  currentState={key:"draft:1",activeTaskId:id,steeringTaskId:null,
    halted:false,queuePaused:true,tasks:[{id,text,status:"dispatching",images:[]}],
    schedules:[],history:[],countRateTimes:[]};
  window.__cqDispatchScope.prime(currentState);
  return currentState.tasks[0];
};
const dispatch=(task,scope)=>({...task,sourceUrl:scope.url,sourceSessionKey:scope.sessionKey});
const releasedAt=(id,url)=>calls.some(message=>message.type==="RELEASE_CLAIM"&&
  message.id===id&&message.url===url);
</script><script src="content.js"></script><script>
(async()=>{
  const flags={};
  try{
    flags.ready=!!window.__cqDispatchScope;
    const api=window.__cqDispatchScope;
    // Capture before an asynchronous CLAIM finishes. Navigation intent may
    // arrive before the address bar or reused editor changes at all.
    const delayedTask=prime("late-claim","旧对话消息");
    const delayedScope=api.captureSendScope();
    let resolveClaim;
    const pendingClaim=new Promise(resolve=>{resolveClaim=resolve;});
    api.invalidateSendPage();
    resolveClaim(dispatch(delayedTask,delayedScope));
    const writesBefore=inputEvents;
    await api.sendTask(await pendingClaim,delayedScope);
    flags.delayedClaimDidNotWrite=inputEvents===writesBefore&&editor.value==="";
    flags.delayedClaimDidNotSend=sent.length===0&&!calls.some(call=>call.type==="SENT");
    flags.delayedClaimReleasedAtOrigin=releasedAt(delayedTask.id,delayedScope.url);

    await wait(1600);
    const returnTask=prime("returned-route","返回 A 也不得复用旧预约");
    const returnScope=api.captureSendScope();
    // Same-document hashes provide real browser routes in this local fixture.
    // Sampling B mirrors the observer/heartbeat seeing an intermediate page.
    history.replaceState(null,"","#B");
    api.captureSendScope();
    history.replaceState(null,"","#A");
    api.captureSendScope();
    flags.returnedToSameUrl=location.href===returnScope.url;
    flags.returnedScopeExpired=!api.sendScopeCurrent(returnScope);
    const writesBeforeReturn=inputEvents;
    await api.sendTask(dispatch(returnTask,returnScope),returnScope);
    flags.returnedRouteDidNotWrite=inputEvents===writesBeforeReturn&&editor.value==="";
    flags.returnedRouteDidNotSend=sent.length===0;
    flags.returnedRouteReleasedAtOrigin=releasedAt(returnTask.id,returnScope.url);

    await wait(1600);
    const waitingTask=prime("waiting-send","发送按钮尚未挂载");
    const waitingScope=api.captureSendScope();
    const waitingSend=api.sendTask(dispatch(waitingTask,waitingScope),waitingScope);
    flags.waitingTextPrepared=await until(()=>editor.value===waitingTask.text);
    api.invalidateSendPage();
    // React can reuse the exact form while a new destination hydrates. Its
    // Send arrow becoming visible must not validate the old claimed message.
    editor.value="切换页面期间的私人草稿";
    send.style.display="";
    const writesAfterNavigation=inputEvents;
    await waitingSend;
    flags.waitingNavigationDidNotSend=sent.length===0&&!calls.some(call=>call.type==="SENT");
    flags.waitingNavigationPreservedDraft=editor.value==="切换页面期间的私人草稿"&&
      inputEvents===writesAfterNavigation;
    flags.waitingNavigationReleasedAtOrigin=releasedAt(waitingTask.id,waitingScope.url);
    flags.noFailureOrWrongScopeRpc=!calls.some(call=>call.type==="FAIL")&&
      calls.filter(call=>call.type==="RELEASE_CLAIM").length===3;
  }catch(error){flags.error=error.stack||String(error);}
  flags.ok=["ready","delayedClaimDidNotWrite","delayedClaimDidNotSend",
    "delayedClaimReleasedAtOrigin","returnedToSameUrl","returnedScopeExpired",
    "returnedRouteDidNotWrite","returnedRouteDidNotSend","returnedRouteReleasedAtOrigin",
    "waitingTextPrepared","waitingNavigationDidNotSend","waitingNavigationPreservedDraft",
    "waitingNavigationReleasedAtOrigin","noFailureOrWrongScopeRpc"]
    .every(key=>flags[key]===true);
  document.body.dataset.dispatchScope=JSON.stringify(flags);
})();
</script></body></html>`);
    const run=spawnSync(browser,[
      "--headless=new","--disable-gpu","--disable-extensions","--no-first-run",
      `--user-data-dir=${path.join(dir,"profile")}`,
      "--virtual-time-budget=10000","--dump-dom",
      `file:///${path.join(dir,"index.html").replace(/\\/g,"/")}`,
    ],{encoding:"utf8",timeout:30000,maxBuffer:8e6});
    assert.equal(run.status,0,run.stderr||"Browser failed");
    const match=run.stdout.match(/data-dispatch-scope="([^"]+)"/);
    assert.ok(match,"Browser did not complete dispatch scope scenarios");
    const flags=JSON.parse(match[1].replace(/&quot;/g,'"').replace(/&amp;/g,"&"));
    assert.equal(flags.ok,true,JSON.stringify(flags,null,2));
  }finally{
    fs.rmSync(dir,{recursive:true,force:true,maxRetries:12,retryDelay:250});
  }
});
