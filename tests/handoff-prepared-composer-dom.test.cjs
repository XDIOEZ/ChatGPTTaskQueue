"use strict";

// Isolated source fixture. Queue init and wake scheduling are disabled;
// native Send is a local button, and worker acknowledgements are mocked.
const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const os=require("node:os");
const {spawnSync}=require("node:child_process");

const browser=process.env.CQ_BROWSER_BIN || (process.platform==="win32"
  ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
  : "/usr/bin/google-chrome");

test("真实 Chrome DOM：接力预填正文复用一次发送，重试保留正文并尊重用户编辑",{
  skip:!fs.existsSync(browser) && "Chrome is not installed",
},()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"cq-handoff-prepared-composer-"));
  try{
    let content=fs.readFileSync(path.join(__dirname,"..","content.js"),"utf8")
      .replace(/\r\n/g,"\n");
    const end="  void init();\n})();";
    assert.ok(content.includes(end),"Prepared handoff fixture init hook moved");
    assert.match(content,/function matchingHandoffComposer\(/);
    assert.match(content,/function preparedHandoffTask\(/);
    content=content.replaceAll("location.href","window.__testUrl")
      .replace("  function boundHere() {",
        "  function boundHere() { return window.__bound; }\n  function unusedOriginalBoundHere() {");
    content=content.replace(end,`
      requestQueueWake=()=>{};
      window.__preparedProbe={
        state:()=>state,prepared:preparedHandoffTask,match:matchingHandoffComposer,
        scope:captureSendScope,send:sendTask,
        prime(options={}){
          sessionKey="draft:1";
          projectVisitId="fixture-visit";
          const task={id:options.id || "intro",text:window.__fullText,
            kind:options.kind || "handoff_intro",status:options.status || "pending",
            images:options.images || []};
          state={key:sessionKey,url:options.url || window.__testUrl,
            handoffSourceKey:options.source===false?null:"chat:source",
            handoffToken:options.token===false?null:"fixture-token",
            handoff:{phase:"bootstrapping"},halted:false,queuePaused:false,
            activeTaskId:task.status==="dispatching"?task.id:null,steeringTaskId:null,
            tasks:[task],schedules:[],history:[],sendCooldownSeconds:0};
          return task;
        },
        dispatch(){const task=state.tasks[0];task.status="dispatching";state.activeTaskId=task.id;return {...task};},
        trusted(editor){recordTrustedHandoffEdit({isTrusted:true,target:editor});},
        ownWrite(editor){handoffComposerWriteDepth++;try{recordTrustedHandoffEdit({isTrusted:true,target:editor});}
          finally{handoffComposerWriteDepth--;}},
      };
    })();`);
    fs.writeFileSync(path.join(dir,"content.js"),content);
    fs.writeFileSync(path.join(dir,"index.html"),`<!doctype html>
<html><head><meta charset="utf-8"><title>Prepared handoff composer</title></head>
<body><main><form><textarea id="prompt-textarea"></textarea>
<button type="button" id="send" data-testid="send-button" aria-label="Send prompt">发送</button>
<button type="button" aria-label="Start Voice" style="display:none">语音模式</button>
</form></main>
<script>
window.__testUrl="https://chatgpt.com/g/g-p-fixture/project";
window.__bound=true;
window.__fullText="任务主题：回复 TapTap 帖子。"+"目标、约束、已完成工作与剩余步骤。".repeat(32);
window.__rpcCalls=[];window.__sentTexts=[];
window.chrome={runtime:{getManifest(){return {version:"0.99.0"};},
 onMessage:{addListener(){}},async sendMessage(msg){
   if(["SENT","RELEASE_CLAIM","FAIL"].includes(msg.type))window.__rpcCalls.push(msg.type);
   const state=window.__preparedProbe?.state();
   const task=state?.tasks.find(item=>item.id===msg.id);
   if(task && msg.type==="RELEASE_CLAIM"){task.status="pending";state.activeTaskId=null;}
   if(task && msg.type==="SENT"){task.status="waiting";task.sentAt=Date.now();}
   return {ok:true,state,sessionKey:"draft:1",...(msg.type==="HANDOFF_SEND_READY"?{sendReady:true}:{})};
 }},storage:{onChanged:{addListener(){}}}};
</script><script src="./content.js"></script>
<script>
(async()=>{
  const checks={};
  const probe=window.__preparedProbe;
  const form=document.querySelector("form");
  const send=document.querySelector("#send");
  let inputs=0,caseId=0;
  const editor=()=>document.querySelector("#prompt-textarea");
  function watchEditor(){editor().addEventListener("input",()=>inputs++);}
  watchEditor();
  send.addEventListener("click",()=>{window.__sentTexts.push(editor().value);editor().value="";});
  function setup(options={}){
    window.__testUrl="https://chatgpt.com/g/g-p-fixture/project";
    window.__bound=true;send.disabled=false;
    form.querySelectorAll('[data-testid="file-chip"]').forEach(node=>node.remove());
    editor().value=window.__fullText;inputs=0;
    window.__rpcCalls.length=0;window.__sentTexts.length=0;
    return probe.prime({id:"intro-"+(++caseId),...options});
  }
  try{
    let task=setup();
    checks.pendingPreparedIntroRecognized=probe.prepared()?.id===task.id;
    await probe.send(probe.dispatch());
    checks.exactlyOneNativeSend=window.__sentTexts.length===1 && window.__sentTexts[0]===window.__fullText;
    checks.prefilledTextNeverInserted=inputs===0;
    checks.sentAcknowledgedOnce=window.__rpcCalls.join(",")==="SENT";
    // A clicked record stays consumed even if a stale render says pending.
    probe.state().tasks[0].status="pending";probe.state().activeTaskId=null;
    editor().value=window.__fullText;
    checks.clickedIntroNeverPreparedAgain=probe.prepared()===null;

    task=setup();editor().value="用户自己的不同草稿";
    checks.differentTextNotPrepared=probe.prepared()===null;
    await probe.send(probe.dispatch());
    checks.differentTextRetained=editor().value==="用户自己的不同草稿" &&
      window.__sentTexts.length===0 && inputs===0 && window.__rpcCalls.join(",")==="RELEASE_CLAIM";

    task=setup();send.disabled=true;
    await probe.send(probe.dispatch());
    checks.notReadyReleasesClaim=window.__rpcCalls.join(",")==="RELEASE_CLAIM" && probe.state().activeTaskId===null;
    checks.unsubmittedIntroPreserved=editor().value===window.__fullText && inputs===0;
    checks.releasedIntroCanBeReclaimed=probe.prepared()?.id===task.id;
    send.disabled=false;
    await probe.send(probe.dispatch());
    checks.retrySendsOnceWithoutDuplicateText=window.__sentTexts.length===1 &&
      window.__sentTexts[0]===window.__fullText && inputs===0 &&
      window.__rpcCalls.join(",")==="RELEASE_CLAIM,SENT";

    task=setup();
    // An editor may be remounted by React with the same unmodified document.
    const replacement=document.createElement("textarea");replacement.id="prompt-textarea";
    replacement.value=window.__fullText;editor().replaceWith(replacement);watchEditor();
    checks.remountedEditorRecognized=probe.prepared()?.id===task.id;
    await probe.send(probe.dispatch());
    checks.remountedEditorReused=window.__sentTexts.length===1 && inputs===0;

    task=setup();send.disabled=true;
    await probe.send(probe.dispatch());send.disabled=false;
    probe.trusted(editor());
    editor().value="用户修改的中间文本";editor().value=window.__fullText;
    checks.trustedEditBackToSameTextBlocked=probe.prepared()===null;
    await probe.send(probe.dispatch());
    checks.userEditStickyAcrossRelease=window.__sentTexts.length===0 &&
      window.__rpcCalls.join(",")==="RELEASE_CLAIM,RELEASE_CLAIM" && editor().value===window.__fullText;
    task=setup();probe.ownWrite(editor());
    checks.ownSynchronousWriteNotMarkedUserEdit=probe.prepared()?.id===task.id;

    for(const [name,options] of [
      ["waiting",{status:"waiting"}],["error",{status:"error"}],
      ["ordinary",{kind:"message"}],["taskAttachment",{images:[{id:"image"}]}],
      ["missingSource",{source:false}],["missingToken",{token:false}],
    ]){
      setup(options);checks[name+"NotPrepared"]=probe.prepared()===null;
    }
    setup();
    form.insertAdjacentHTML("beforeend",'<div data-testid="file-chip">native-image.png</div>');
    checks.nativeAttachmentNotPrepared=probe.prepared()===null;
    setup();window.__testUrl="https://chatgpt.com/g/g-p-other/project";
    checks.otherProjectNotPrepared=probe.prepared()===null;
    setup();window.__testUrl="https://chatgpt.com/g/g-p-fixture/c/another-chat";
    checks.chatUrlNotPrepared=probe.prepared()===null;
    setup();
    probe.state().tasks.unshift({id:"ordinary-head",kind:"message",status:"pending",text:"先发送这条",images:[]});
    checks.onlyPendingQueueHeadEligible=probe.prepared()===null;

    setup();const dispatch=probe.dispatch();const scope=probe.scope();
    window.__testUrl="https://chatgpt.com/g/g-p-other/project";
    await probe.send(dispatch,scope);
    checks.oldRouteDispatchNeverSent=window.__sentTexts.length===0 && editor().value===window.__fullText;
  }catch(error){checks.error=error.stack || error.message;}
  checks.ok=Object.values(checks).every(value=>value===true);
  document.body.dataset.result=JSON.stringify(checks);
})();
</script></body></html>`);
    const result=spawnSync(browser,[
      "--headless=new","--disable-gpu","--disable-extensions","--no-first-run",
      `--user-data-dir=${path.join(dir,"profile")}`,
      "--virtual-time-budget=15000","--dump-dom",
      `file:///${path.join(dir,"index.html").replace(/\\/g,"/")}`,
    ],{encoding:"utf8",timeout:30000,maxBuffer:8e6});
    assert.equal(result.status,0,result.stderr || "Chrome failed");
    const match=result.stdout.match(/data-result="([^"]+)"/);
    assert.ok(match,"Prepared handoff composer fixture did not finish");
    const checks=JSON.parse(match[1].replace(/&quot;/g,'"'));
    assert.equal(checks.ok,true,JSON.stringify(checks));
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
