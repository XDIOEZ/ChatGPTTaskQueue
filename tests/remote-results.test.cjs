"use strict";
const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const os=require("node:os");
const path=require("node:path");
const http=require("node:http");
const vm=require("node:vm");

const temp=fs.mkdtempSync(path.join(os.tmpdir(),"cq-results-test-"));
process.env.CQ_BRIDGE_DATA_DIR=temp;
const bridge=require("../remote-bridge.cjs");
const agentToken="test-agent-token";
const extensionId="abcdefghijklmnopabcdefghijklmnop";
fs.writeFileSync(path.join(temp,"agent-token"),agentToken);

test("stable submission ID deduplicates and final result is idempotent",async t=>{
  const server=bridge.makeServer();
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
  t.after(async()=>new Promise(resolve=>server.close(resolve)));
  const port=server.address().port;
  async function call(method,endpoint,body,identity="agent") {
    const data=body===undefined?null:Buffer.from(JSON.stringify(body));
    const headers={...(identity==="agent"?{Authorization:"Bearer "+agentToken}:{
      "X-CQ-Extension":"chatgpt-task-queue-extension-v1","X-CQ-Extension-Id":extensionId}),
      ...(data?{"Content-Type":"application/json","Content-Length":data.length}:{})};
    return new Promise((resolve,reject)=>{
      const req=http.request({hostname:"127.0.0.1",port,path:endpoint,method,headers},res=>{
        const chunks=[];res.on("data",chunk=>chunks.push(chunk));
        res.on("end",()=>resolve({status:res.statusCode,body:JSON.parse(Buffer.concat(chunks).toString("utf8"))}));
      });
      req.on("error",reject); if(data)req.write(data);req.end();
    });
  }
  const id="12345678-1234-4234-8234-123456789abc";
  const input={clientRequestId:id,captureResult:true,action:"new_chat",mode:"queue",text:"开发任务",
    target:{kind:"personal",id:"personal",url:"https://chatgpt.com/"}};
  assert.equal((await call("POST","/v1/jobs",input)).status,201);
  const retry=await call("POST","/v1/jobs",input);
  assert.equal(retry.status,200);assert.equal(retry.body.job.id,id);
  assert.equal((await call("POST","/v1/jobs",{...input,text:"其他任务"})).status,409);
  const noCapture=bridge.makeJob({action:"new_chat",text:"其他任务",
    target:{kind:"personal",id:"personal",url:"https://chatgpt.com/"}});
  assert.throws(()=>bridge.recordCompletion(noCapture,{id:noCapture.id,taskId:"task2",
    completionStatus:"completed",replyText:"不要收集"}),/未请求收集/);
  assert.equal((await call("GET","/v1/extension/poll",undefined,"extension")).body.job.id,id);
  await call("POST","/v1/extension/report",{id,status:"created",taskId:"task1",
    chatUrl:"https://chatgpt.com/c/chat1"},"extension");
  const result={id,taskId:"task1",completionStatus:"completed",replyText:"最终回复"};
  assert.equal((await call("POST","/v1/extension/results/report",{...result,taskId:"wrong"},"extension")).status,409);
  assert.equal((await call("POST","/v1/extension/results/report",result,"extension")).status,200);
  assert.equal((await call("POST","/v1/extension/results/report",result,"extension")).status,200);
  assert.equal((await call("POST","/v1/extension/results/report",{...result,replyText:"不同"},"extension")).status,409);
  const status=(await call("GET","/v1/jobs/"+id)).body.job;
  assert.equal(status.status,"created");
  assert.equal(status.completionStatus,"completed");
  assert.equal(status.replyText,"最终回复");
});

test("reply evidence rejects old or unrelated assistant text",()=>{
  const source=fs.readFileSync(path.join(__dirname,"../content.js"),"utf8");
  const start=source.indexOf("  function remoteReplyEvidence(");
  const end=source.indexOf("  function conversationSnapshot()",start);
  assert.ok(start>=0 && end>start);
  const fn=vm.runInNewContext(source.slice(start,end)+"\nremoteReplyEvidence",{
    normalize:value=>String(value||"").replace(/\s+/g," ").trim(),
  });
  const task={remoteJobId:"id",remoteCaptureResult:true,text:"新任务",baselineUserCount:1,
    baselineAssistantCount:1,baselineAssistantId:"old"};
  const good={lastRole:"assistant",lastUserText:"新任务",lastUserFolded:false,
    lastAssistantText:"新回复",lastAssistantId:"new",userCount:2,assistantCount:2};
  assert.equal(fn(task,good).replyText,"新回复");
  assert.equal(fn(task,{...good,lastAssistantId:"old",assistantCount:1}),null);
  assert.equal(fn(task,{...good,lastUserText:"其他任务"}),null);
  assert.equal(fn(task,{...good,userCount:3}),null);
  assert.equal(fn(task,{...good,lastUserFolded:true}),null);
  assert.equal(fn({...task,remoteCaptureResult:false},good),null);
});

test("completion outbox survives failure and is removed only after success",async()=>{
  const source=fs.readFileSync(path.join(__dirname,"../remote-dispatch.js"),"utf8");
  let store={remoteResults:[{id:"job",taskId:"task",completionStatus:"completed",replyText:"OK"}]};
  let fail=true, calls=0;
  const sandbox={URL,AbortController,setTimeout,clearTimeout,console:{warn(){}},
    chrome:{runtime:{id:"abcdefghijklmnopabcdefghijklmnop"}},
    async readStore(){return structuredClone(store);},
    async saveStore(value){store=structuredClone(value);},
    async exclusive(fn){return fn();},
    async fetch(){calls++; if(fail)throw new Error("offline");return {ok:true,async json(){return {ok:true};}};},
  };
  let remote=vm.runInNewContext(source+"\nCQRemoteDispatch",sandbox);
  await assert.rejects(remote.flushRemoteResults());
  assert.equal(store.remoteResults.length,1);
  fail=false;
  remote=vm.runInNewContext(source+"\nCQRemoteDispatch",sandbox);
  await remote.flushRemoteResults();
  assert.equal(store.remoteResults.length,0);
  assert.equal(calls,2);
});

test("one failed result does not block other completed results",async()=>{
  const source=fs.readFileSync(path.join(__dirname,"../remote-dispatch.js"),"utf8");
  let store={remoteResults:[{id:"bad",taskId:"t1"},{id:"good",taskId:"t2"}]};
  const sandbox={URL,AbortController,setTimeout,clearTimeout,console:{warn(){}},
    chrome:{runtime:{id:"abcdefghijklmnopabcdefghijklmnop"}},
    async readStore(){return structuredClone(store);},
    async saveStore(value){store=structuredClone(value);},
    async exclusive(fn){return fn();},
    async fetch(url,options){if(JSON.parse(options.body).id==="bad")throw new Error("offline");
      return {ok:true,async json(){return {ok:true};}};},
  };
  const remote=vm.runInNewContext(source+"\nCQRemoteDispatch",sandbox);
  await assert.rejects(remote.flushRemoteResults());
  assert.deepEqual(store.remoteResults.map(item=>item.id),["bad"]);
});
