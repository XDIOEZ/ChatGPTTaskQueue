"use strict";

const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const vm=require("node:vm");

const source=fs.readFileSync(path.join(__dirname,"..","debug-export.js"),"utf8");

function fixture({reply,stored,rpcFails=false,storageFails=false}={}) {
  const handlers=new Map();
  const attrs=new Map();
  const requests=[];
  const storageReads=[];
  const blobs=new Map();
  const downloads=[];
  const status={textContent:""};
  const button={
    dataset:{},disabled:false,
    addEventListener(type,fn){handlers.set(type,fn);},
    setAttribute(name,value){attrs.set(name,value);},
    removeAttribute(name){attrs.delete(name);},
    closest(){return null;},
  };
  const document={
    getElementById(id){return id==="export-debug-json"?button:id==="debug-export-status"?status:null;},
    createElement(tag){
      assert.equal(tag,"a");
      return {click(){downloads.push({href:this.href,name:this.download});},remove(){this.removed=true;}};
    },
    body:{append(){}},
  };
  const chrome={
    runtime:{
      getManifest(){return {version:"0.49.99"};},
      async sendMessage(message){
        requests.push(message);
        if(rpcFails)throw new Error("private runtime failure and chat URL");
        return reply;
      },
    },
    storage:{local:{async get(key){
      storageReads.push(key);
      if(storageFails)throw new Error("private storage failure");
      return {[key]:stored};
    }}},
  };
  const context=vm.createContext({
    document,chrome,Blob,Date,Promise,
    URL:{createObjectURL(blob){const key="blob:test-"+blobs.size;blobs.set(key,blob);return key;},
      revokeObjectURL(){}},
    setTimeout(fn,ms){if(ms===60000)return 0;const id=setTimeout(fn,ms);id.unref();return id;},
    clearTimeout,
  });
  vm.runInContext(source,context,{filename:"debug-export.js"});
  return {button,status,requests,storageReads,downloads,attrs,
    async click(){await handlers.get("click")();},
    async payload(index=0){return JSON.parse(await blobs.get(downloads[index].href).text());},
  };
}

test("独立 DEBUG 入口无需 dashboard 脚本，即使没有历史记录也下载 v2 JSON",async()=>{
  const env=fixture({reply:{ok:true,version:2,backendVersion:"0.49.99",capturedAt:123456,
    current:{handoffPhase:"idle",pendingTasks:0},runs:[]}});
  await env.click();
  const json=await env.payload();
  assert.equal(env.downloads.length,1);
  assert.match(env.downloads[0].name,/\.json$/);
  assert.equal(json.format,"ChatGPTTaskQueue-handoff-debug");
  assert.equal(json.version,2);
  assert.equal(json.pluginVersion,"0.49.99");
  assert.equal(json.backendVersion,"0.49.99");
  assert.equal(json.capturedAt,123456);
  assert.equal(json.current.handoffPhase,"idle");
  assert.deepEqual(json.runs,[]);
  assert.ok(Number.isFinite(Date.parse(json.generatedAt)));
  assert.equal(env.requests.length,1);
  assert.equal(env.requests[0].type,"GET_HANDOFF_DEBUG");
  assert.equal(env.requests[0].all,true);
  assert.deepEqual(env.storageReads,[]);
  assert.match(env.status.textContent,/已导出 DEBUG JSON/);
  assert.equal(env.button.disabled,false);
  assert.equal(env.attrs.has("aria-busy"),false);
});

test("后台 RPC 异常时仍下载本地记录，只保留枚举、数量和时间，不输出正文或身份字段",async()=>{
  const privateText="SECRET_TASK_BODY";
  const privateUrl="https://chatgpt.com/c/private-chat-id";
  const event={kind:"page_wait",at:1000,phase:"failed",reason:"editor_has_text",
    pendingTasks:2,halted:false,queuePaused:true,route:"chat",
    text:privateText,url:privateUrl,sourceKey:"private-source-key",error:"private error",
    details:{editorText:privateText,sourceKey:"private-nested-key"}};
  const stored={runs:Array.from({length:15},()=>({
    mode:"manual",status:"failed",phase:"failed",startedAt:900,endedAt:1100,
    sourceKey:"private-source-key",token:"private-token",summary:privateText,url:privateUrl,
    events:[...Array.from({length:90},()=>({...event})),{kind:"unknown-private-event",text:privateText}],
  }))};
  const env=fixture({rpcFails:true,stored});
  await env.click();
  const json=await env.payload();
  const serialized=JSON.stringify(json);
  assert.equal(env.downloads.length,1);
  assert.equal(json.version,2);
  assert.equal(json.diagnosticStatus,"background_unavailable");
  assert.equal(json.backendVersion,null);
  assert.equal(json.current,null);
  assert.equal(json.runs.length,12);
  assert.ok(json.runs.every(run=>run.events.length<=80));
  assert.equal(json.runs[0].events[0].reason,"editor_has_text");
  assert.equal(json.runs[0].events[0].pendingTasks,2);
  assert.equal(json.runs[0].events[0].queuePaused,true);
  for(const secret of [privateText,privateUrl,"sourceKey","private-token","private error","editorText"]){
    assert.equal(serialized.includes(secret),false,secret);
  }
  assert.deepEqual(env.storageReads,["cq.handoffDebug.v1"]);
  assert.match(env.status.textContent,/本地脱敏 DEBUG JSON/);
  assert.equal(env.button.disabled,false);
  assert.equal(env.requests.every(message=>message.type==="GET_HANDOFF_DEBUG"),true);
});

test("后台和本地存储都失效时仍导出最小诊断元数据",async()=>{
  const env=fixture({rpcFails:true,storageFails:true});
  await env.click();
  const json=await env.payload();
  assert.equal(json.diagnosticStatus,"background_unavailable");
  assert.deepEqual(json.runs,[]);
  assert.equal(json.pluginVersion,"0.49.99");
  assert.ok(Number.isFinite(Date.parse(json.generatedAt)));
  assert.equal(JSON.stringify(json).includes("private storage failure"),false);
  assert.equal(env.downloads.length,1);
  assert.equal(env.button.disabled,false);
});

test("后台不可用时保留批量输入和发送授权度量，输入方式仍使用固定枚举脱敏",async()=>{
  const events=[
    {kind:"input_start",at:1000,phase:"bootstrapping",reason:"none",
      details:{gate:"input",inputMethod:"paste",inputParagraphs:220,taskChars:15137}},
    {kind:"input_complete",at:1001,phase:"bootstrapping",reason:"none",
      details:{gate:"input",inputMethod:"html",inputElapsedMs:12,inputParagraphs:220}},
    {kind:"input_failed",at:1002,phase:"failed",reason:"text_mismatch",
      details:{gate:"input",inputMethod:"nativeValue",inputElapsedMs:4,inputParagraphs:1}},
    {kind:"send_ready",at:1003,phase:"bootstrapping",action:"HANDOFF_SEND_READY",
      details:{gate:"arm",inputMethod:"SECRET_INPUT_BODY",inputElapsedMs:-1,
        inputParagraphs:Infinity,text:"SECRET_INPUT_BODY",url:"https://private.example/chat"}},
  ];
  const env=fixture({rpcFails:true,stored:{runs:[{mode:"manual",status:"failed",phase:"failed",events}]}});
  await env.click();
  const json=await env.payload();
  const kept=json.runs[0].events;
  assert.deepEqual(kept.map(event=>event.kind),["input_start","input_complete","input_failed","send_ready"]);
  assert.equal(kept[0].details.inputMethod,"paste");
  assert.equal(kept[0].details.inputParagraphs,220);
  assert.equal(kept[0].details.taskChars,15137);
  assert.equal(kept[1].details.inputMethod,"html");
  assert.equal(kept[1].details.inputElapsedMs,12);
  assert.equal(kept[2].details.inputMethod,"nativeValue");
  assert.equal(kept[3].action,"HANDOFF_SEND_READY");
  assert.deepEqual(kept[3].details,{gate:"arm"});
  assert.equal(JSON.stringify(json).includes("SECRET_INPUT_BODY"),false);
  assert.equal(JSON.stringify(json).includes("private.example"),false);
});

test("后台不可用时保留接收恢复结果，仅导出固定阻断原因与布尔值",async()=>{
  const events=[
    {kind:"adoption_result",action:"CONFIRM_HANDOFF",at:1000,phase:"bootstrapping",reason:"adopted",
      details:{gate:"adoption",targetShell:true,adopted:true}},
    {kind:"adoption_result",action:"CONFIRM_HANDOFF",at:1001,phase:"bootstrapping",reason:"message_mismatch",
      details:{gate:"adoption",targetShell:false,adopted:false}},
    {kind:"adoption_result",action:"CONFIRM_HANDOFF",at:1002,reason:"PRIVATE_MESSAGE_BODY",
      details:{targetShell:"private-owner",adopted:"private-token",
        sourceKey:"private-source",lastUserText:"PRIVATE_MESSAGE_BODY",url:"https://private.example/chat"}},
  ];
  const env=fixture({rpcFails:true,stored:{runs:[{mode:"manual",status:"running",phase:"bootstrapping",events}]}});
  await env.click();
  const json=await env.payload();
  const kept=json.runs[0].events;
  assert.equal(kept.length,3);
  assert.equal(kept[0].kind,"adoption_result");
  assert.equal(kept[0].action,"CONFIRM_HANDOFF");
  assert.equal(kept[0].reason,"adopted");
  assert.deepEqual(kept[0].details,{targetShell:true,adopted:true,gate:"adoption"});
  assert.equal(kept[1].reason,"message_mismatch");
  assert.equal(kept[1].details.adopted,false);
  assert.equal(kept[2].details,undefined);
  assert.equal(kept[2].reason,undefined);
  for(const value of ["PRIVATE_MESSAGE_BODY","private-owner","private-token","private-source","private.example"]){
    assert.equal(JSON.stringify(json).includes(value),false);
  }
});
