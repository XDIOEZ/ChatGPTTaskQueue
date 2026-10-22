"use strict";

// This fixture exercises the receiving page only. The native chat and
// worker are local doubles; init and dispatch wake scheduling stay disabled.
const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const os=require("node:os");
const {spawnSync}=require("node:child_process");
const browser=process.env.CQ_BROWSER_BIN || (process.platform==="win32"
  ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" : "/usr/bin/google-chrome");

test("真实 Chrome DOM：空会话恢复接收关联，回复完成后才显示迁移规则，并隔离多轮、真实任务和迟到回执",{
  skip:!fs.existsSync(browser) && "Chrome is not installed",
},()=>{
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),"cq-handoff-adoption-recovery-"));
  try {
    let content=fs.readFileSync(path.join(__dirname,"..","content.js"),"utf8").replace(/\r\n/g,"\n");
    const end="  void init();\n})();";
    assert.ok(content.includes(end),"Adoption fixture init hook moved");
    assert.match(content,/async function probePendingHandoff\(/);
    content=content.replaceAll("location.href","window.__testUrl")
      .replace("  const clock = () => Date.now();","  const clock = () => window.__now;")
      .replace("  function boundHere() {",
        "  function boundHere() { return true; }\n  function unusedBoundHere() {");
    content=content.replace(end,`
      requestQueueWake=()=>{};
      window.__adoptionProbe={
        recover:probePendingHandoff,snapshot:conversationSnapshot,state:()=>state,
        evidence:handoffCompletionEvidence,heartbeat,act:onAction,
        prime(value){
          syncSendRoute();lastLocation=window.__testUrl;lastPagePulseAt=clock();
          state=value;sessionKey=value.key;window.__current=value;
          voiceReadySince=0;handoffComposerIdleSince=0;handoffReplyProbe=null;
          render();
        },
      };
    })();`);
    fs.writeFileSync(path.join(folder,"content.js"),content);
    fs.copyFileSync(path.join(__dirname,"..","panel.css"),path.join(folder,"panel.css"));
    fs.writeFileSync(path.join(folder,"index.html"),`<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="panel.css"></head><body><main>
<article data-testid="conversation-turn-0"><section data-message-author-role="user" data-message-id="first-user"></section></article>
<article data-testid="conversation-turn-1"><section data-message-author-role="assistant" data-message-id="first-assistant">
<div class="markdown">已保留任务目标及上下文，等待下一条任务。</div></section>
<button type="button" aria-label="复制">复制</button></article>
<form><textarea id="prompt-textarea" aria-label="询问 ChatGPT"></textarea>
<button type="button" aria-label="Start Voice">语音模式</button></form></main><script>
window.__now=Date.now();
window.__testUrl="https://chatgpt.com/g/g-p-fixture/c/destination-0";
window.__calls=[];window.__replyMode="adopt";window.__defer=false;
const fullText="任务主题：回复帖子。"+"保留目标、约束、已完成步骤与待执行事项。".repeat(24);
document.querySelector('[data-message-author-role="user"]').textContent=fullText;
function adoptedState(base){
 return {...base,handoffSourceKey:"chat:source",handoffToken:"same-tab-token",
  handoff:{enabled:false,intervalMinutes:120,phase:"bootstrapping"},
  activeTaskId:"intro",tasks:[{id:"intro",kind:"handoff_intro",status:"waiting",text:fullText,
   images:[],sentAt:window.__now-8000,baselineUserCount:0,baselineAssistantCount:0}],schedules:[]};
}
window.chrome={runtime:{getManifest(){return {version:"0.99.0"};},onMessage:{addListener(){}},
 async sendMessage(message){
  window.__calls.push(message);
  if(message.type==="CONFIRM_HANDOFF"){
   const adopted=window.__replyMode==="adopt";
   const next=adopted?adoptedState(window.__current):window.__current;
   const reply={ok:true,state:next,sessionKey:next.key,adopted,handoffPending:adopted};
   if(window.__defer)return new Promise(resolve=>{window.__resolveConfirm=()=>resolve(reply);});
   window.__current=next;return reply;
  }
  if(message.type==="FINISHED"){
   if(!window.__current.handoffSourceKey || message.id!=="intro" ||
     !(message.handoffReady || message.voiceReady))return {ok:false,error:"missing completion evidence"};
   const next={...window.__current,tasks:[],activeTaskId:null,
    handoff:{enabled:false,intervalMinutes:120,phase:"idle"},
    schedules:[{id:"migrated-rule",mode:"count",text:"自动回复帖子",enabled:true,
     threshold:1,repeatCount:-1,enqueuedCount:0}]};
   delete next.handoffSourceKey;delete next.handoffToken;
   window.__current=next;return {ok:true,state:next,sessionKey:next.key};
  }
  return {ok:true,state:window.__current,sessionKey:window.__current?.key};
 }},storage:{onChanged:{addListener(){}}}};
</script><script src="content.js"></script><script>
(async()=>{
 const flags={};
 const probe=window.__adoptionProbe;
 let index=0;
 const q=selector=>document.querySelector("#cq-extension-root "+selector);
 function setup(extra={}){
  window.__now+=6000;window.__calls.length=0;window.__defer=false;
  document.querySelector('#prompt-textarea').value="";
  document.querySelectorAll('[data-extra-user]').forEach(node=>node.remove());
  document.querySelectorAll('[data-testid="file-chip"]').forEach(node=>node.remove());
  const id="destination-"+(++index);
  window.__testUrl="https://chatgpt.com/g/g-p-fixture/c/"+id;
  probe.prime({key:"chat:"+id,url:window.__testUrl,tasks:[],schedules:[],history:[],
   activeTaskId:null,steeringTaskId:null,halted:false,haltReason:null,queuePaused:false,
   firstSeenAt:window.__now,firstMessageAt:null,
   handoff:{enabled:false,intervalMinutes:120,phase:"idle",nextAt:null},...extra});
 }
 function confirmations(){return window.__calls.filter(message=>message.type==="CONFIRM_HANDOFF");}
 try{
  setup();window.__replyMode="adopt";
  const adopted=await probe.recover(probe.snapshot());
  flags.restoresWaitingIntro=adopted===true && confirmations().length===1 &&
   confirmations()[0].userCount===1 && confirmations()[0].lastUserText===fullText &&
   confirmations()[0].lastUserFolded===false && probe.state().handoffSourceKey==="chat:source" &&
   probe.state().tasks[0]?.kind==="handoff_intro" && probe.state().tasks[0]?.status==="waiting";
  flags.rulesWaitForFinish=probe.state().schedules.length===0 &&
   !window.__calls.some(message=>message.type==="FINISHED");
  probe.evidence(probe.state().tasks[0],probe.snapshot());
  window.__now+=5000;
  await probe.heartbeat();
  flags.finishesBeforeRulesAppear=window.__calls.filter(message=>message.type==="FINISHED").length===1 &&
   probe.state().tasks.length===0 && !probe.state().handoffSourceKey &&
   probe.state().schedules[0]?.id==="migrated-rule" && probe.state().schedules[0]?.enabled===true;
  await probe.act(q('[data-action="toggle-scheduler"]'));
  flags.migratedRuleVisible=q('.cq-scheduler')?.textContent.includes("自动回复帖子");
  flags.recoveryNeverSends=window.__calls.every(message=>
   !["CLAIM","SENT","HANDOFF_SEND_READY","ENQUEUE"].includes(message.type));

  setup();window.__replyMode="none";
  await probe.recover(probe.snapshot());await probe.recover(probe.snapshot());
  flags.probeDeduplicated=confirmations().length===1;
  window.__now+=5001;await probe.recover(probe.snapshot());
  flags.probeRetriesAfterWindow=confirmations().length===2;
  flags.ordinaryEmptyRemainsEmpty=probe.state().tasks.length===0 &&
   probe.state().schedules.length===0 && !probe.state().handoffSourceKey;

  for(const [name,extra] of [
   ["task",{tasks:[{id:"real",text:"真实任务",kind:"message",status:"pending",images:[]}]}],
   ["schedule",{schedules:[{id:"existing",text:"既有规则",enabled:false,mode:"count",threshold:1}]}],
   ["active",{activeTaskId:"real"}],["steering",{steeringTaskId:"real"}],
   ["halted",{halted:true}],["paused",{queuePaused:true}],["error",{error:"请人工检查"}],
  ]){
   setup(extra);await probe.recover(probe.snapshot());
   flags[name+"PreventsAdoption"]=confirmations().length===0;
  }
  setup();
  const extraUser=document.createElement("section");extraUser.dataset.messageAuthorRole="user";
  extraUser.dataset.extraUser="true";extraUser.textContent="后续真实指令";
  document.querySelector("main").append(extraUser);
  await probe.recover(probe.snapshot());
  flags.multiTurnPreventsAdoption=probe.snapshot().userCount===2 && confirmations().length===0;
  setup();document.querySelector('#prompt-textarea').value="用户尚未发送的草稿";
  await probe.recover(probe.snapshot());
  flags.draftPreventsAdoption=confirmations().length===0;

  setup();window.__replyMode="adopt";window.__defer=true;
  const oldProbe=probe.recover(probe.snapshot());
  for(let i=0;i<8 && !window.__resolveConfirm;i++)await Promise.resolve();
  const resolveOld=window.__resolveConfirm;
  setup();const freshKey=probe.state().key;
  resolveOld();
  const staleAdopted=await oldProbe;
  flags.staleRouteReceiptIgnored=staleAdopted===false && probe.state().key===freshKey &&
   probe.state().tasks.length===0 && probe.state().schedules.length===0 && !probe.state().handoffSourceKey;
 }catch(error){flags.error=error.stack||String(error);}
 flags.ok=Object.values(flags).every(value=>value===true);
 document.body.dataset.check=JSON.stringify(flags);
})();
</script></body></html>`);
    const result=spawnSync(browser,["--headless=new","--disable-gpu","--disable-extensions","--no-first-run",
      `--user-data-dir=${path.join(folder,"profile")}`,"--virtual-time-budget=6000","--dump-dom",
      `file:///${path.join(folder,"index.html").replace(/\\/g,"/")}`],
    {encoding:"utf8",timeout:25000,maxBuffer:8e6});
    assert.equal(result.status,0,result.stderr||"Chrome failed");
    const match=result.stdout.match(/data-check="([^"]+)"/);
    assert.ok(match,"Adoption recovery fixture did not finish");
    const flags=JSON.parse(match[1].replace(/&quot;/g,'"').replace(/&amp;/g,"&"));
    assert.equal(flags.ok,true,JSON.stringify(flags,null,2));
  }finally{fs.rmSync(folder,{recursive:true,force:true});}
});
