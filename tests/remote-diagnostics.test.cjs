"use strict";
const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const vm=require("node:vm");
const bridge=require("../remote-bridge.cjs");

function part(source,start,end,name,globals={}) {
  const i=source.indexOf(start),j=source.indexOf(end,i);
  assert.ok(i>=0 && j>i);
  return vm.runInNewContext(source.slice(i,j)+"\n"+name,globals);
}

test("assistant authored node can itself be the content node",()=>{
  const source=fs.readFileSync(path.join(__dirname,"../content.js"),"utf8");
  const extract=part(source,"  function assistantOutputText(","  let remoteCompletionWait", "assistantOutputText");
  const element={matches:selector=>selector===".markdown",querySelectorAll:()=>[],innerText:"最终回复"};
  assert.equal(extract(element),"最终回复");
});

test("diagnostic identifies evidence failure without including message content",()=>{
  const source=fs.readFileSync(path.join(__dirname,"../content.js"),"utf8");
  const diag=part(source,"  function remoteReplyDiagnostic(","  function remoteReplyEvidence(",
    "remoteReplyDiagnostic",{normalize:value=>String(value||"").replace(/\s+/g," ").trim(),
      boundHere:()=>true,pageChatKey:()=>"chat:1",location:{href:"https://chatgpt.com/c/1"},
      state:{recentSubmissions:[{id:"id"}]}});
  const task={remoteJobId:"id",remoteCaptureResult:true,text:"秘密内容",baselineUserCount:0,
    baselineAssistantCount:0,baselineAssistantId:null};
  const snap={lastRole:"assistant",userCount:1,lastUserText:"秘密内容",lastUserFolded:false,
    assistantCount:1,lastAssistantId:"new",lastAssistantText:"秘密回复"};
  assert.equal(diag(task,snap).reason,"ok");
  assert.equal(diag(task,snap).boundHere,true);
  assert.equal(diag(task,snap).chatRoute,true);
  assert.equal(diag(task,snap).recentSubmission,true);
  assert.equal(diag(task,{...snap,lastAssistantText:""}).reason,"assistant_text_missing");
  assert.equal(diag(task,{...snap,lastRole:"user"}).reason,"last_role");
  assert.equal(diag(task,{...snap,lastUserText:"其他"}).reason,"user_mismatch");
  assert.equal(diag(task,{...snap,userCount:2}).reason,"user_count");
  assert.equal(diag(task,{...snap,assistantCount:0}).reason,"assistant_not_new");
  assert.doesNotMatch(JSON.stringify(diag(task,snap)),/秘密/);
});

test("result diagnostics are sanitized and repeatable",()=>{
  const job=bridge.makeJob({action:"new_chat",captureResult:true,text:"任务",
    target:{kind:"personal",id:"personal",url:"https://chatgpt.com/"}});
  const report={id:job.id,taskId:"task",completionStatus:"result_unavailable",
    resultDiagnostic:{reason:"assistant_text_missing",userCount:1,assistantCount:1,
      userMatches:true,assistantTextLength:0,text:"should-not-leak"}};
  const first=bridge.recordCompletion(job,report);
  assert.equal(first.resultDiagnostic.reason,"assistant_text_missing");
  assert.equal(first.resultDiagnostic.text,undefined);
  assert.doesNotThrow(()=>bridge.recordCompletion(job,report));
});

test("background diagnostics only preserve the explicit metadata whitelist",()=>{
  const source=fs.readFileSync(path.join(__dirname,"../background.js"),"utf8");
  const sanitize=part(source,"function safeRemoteDiagnostic(","function chatKey(","safeRemoteDiagnostic");
  const out=sanitize({reason:"user_count",userCount:1,userMatches:true,rawText:"secret"});
  assert.equal(out.reason,"user_count");
  assert.equal(out.rawText,undefined);
});

test("new-chat confirmation failure exposes only its boolean checks",async()=>{
  const source=fs.readFileSync(path.join(__dirname,"../remote-dispatch.js"),"utf8");
  const diagnostics={boundHere:true,chatRoute:true,recentSubmission:false,userMatches:true,userCount:1,domUserCount:2};
  let captured,observed=false;
  const inspect=part(source,"  async function inspectCreatedChat(","  async function inspectSteeredChat(",
    "inspectCreatedChat",{
      safeUrl:url=>url,chatKey:()=>"chat:1",sameScope:()=>true,noteOwnedTask:async()=>{},
      withTabResponseDeadline:promise=>promise,
      chrome:{tabs:{async sendMessage(_id,message){captured=message;
        return {ok:true,observed,confirmationDiagnostic:diagnostics};}}},
    });
  const status=await inspect({id:"id",text:"private",captureResult:true},{},
    {id:3,url:"https://chatgpt.com/c/1"});
  assert.equal(captured.captureDiagnostics,true);
  assert.equal(status.status,"waiting");
  assert.equal(status.confirmationDiagnostic.recentSubmission,false);
  observed=true;
  const confirmed=await inspect({id:"id",text:"private",captureResult:true},{},
    {id:3,url:"https://chatgpt.com/c/1"});
  assert.equal(confirmed.status,"created");
  assert.equal(confirmed.confirmationDiagnostic.domUserCount,2);
  const job=bridge.makeJob({action:"new_chat",captureResult:true,text:"任务",
    target:{kind:"personal",id:"personal",url:"https://chatgpt.com/"}});
  bridge.updateJob(job,{status:"waiting",confirmationDiagnostic:{...diagnostics,rawText:"private"}});
  assert.equal(job.confirmationDiagnostic.boundHere,true);
  assert.equal(job.confirmationDiagnostic.domUserCount,2);
  assert.equal(job.confirmationDiagnostic.rawText,undefined);
});
