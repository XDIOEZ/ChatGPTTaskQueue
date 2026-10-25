"use strict";

const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const vm=require("node:vm");

const source=fs.readFileSync(path.join(__dirname,"../remote-dispatch.js"),"utf8");

test("卡住的 ChatGPT 页面 RPC 会超时释放调度锁，下一条仍能继续领取",async()=>{
  const url="https://chatgpt.com/c/stress-stuck-target";
  const make=(id,mode)=>({
    id,action:"continue",mode,text:"safe prompt",
    target:{kind:"chat",id:"stress-stuck-target",url},tabId:15,attempts:1,
  });
  const jobs=[
    make("11111111-2222-4333-8444-555555555555","queue"),
    make("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee","queue"),
    make("12345678-1234-4234-8234-123456789abc","steer"),
  ];
  const reports=[],requests=[];
  let sends=0,tabCreates=0;
  const sandbox={
    URL,AbortController,clearTimeout,
    setTimeout:(callback,ms)=>setTimeout(callback,ms===20000?5:ms),
    console:{warn(){}},
    chrome:{
      runtime:{id:"abcdefghijklmnopabcdefghijklmnop",
        getManifest(){return {version:"0.49.57"};}},
      tabs:{
        async query(){return [{id:15,url,status:"complete",windowId:1,title:"Existing chat"}];},
        async create(){tabCreates++;throw new Error("must not open a new tab");},
        async sendMessage(){sends++;return new Promise(()=>{});},
      },
      storage:{local:{async get(){return {};}}},
    },
    CQHandoff:{projectStart(){return null;},projectId(){return null;}},
    safeUrl(value){const parsed=new URL(value);return parsed.origin+parsed.pathname;},
    chatKey(value){return "chat:"+new URL(value).pathname.match(/\/c\/([^/]+)/)[1];},
    isProjectOverview(){return false;},
    async readStore(){return {conversations:{"chat:stress-stuck-target":{
      url,tabId:15,tasks:[],recentSubmissions:[],
    }}};},
    async fetch(endpoint,options){
      const suffix=new URL(endpoint).pathname;
      requests.push(suffix);
      const payload=suffix.endsWith("/poll")?{ok:true,job:jobs.shift()||null}:{ok:true};
      if(suffix.endsWith("/report")) reports.push(JSON.parse(options.body));
      return {ok:true,async json(){return payload;}};
    },
  };
  vm.runInNewContext(source+"\nglobalThis.remoteUnderTest=CQRemoteDispatch;",sandbox);
  const dispatch=sandbox.remoteUnderTest;
  await dispatch.tick();
  await dispatch.tick();
  await dispatch.tick();

  assert.equal(sends,3,"every tick reaches its own browser RPC");
  assert.equal(tabCreates,0,"timeouts never open extra tabs");
  assert.equal(requests.filter(x=>x.endsWith("/targets")).length,3,
    "every tick can refresh extension heartbeat after the previous timeout");
  assert.equal(requests.filter(x=>x.endsWith("/poll")).length,3);
  const final=reports.filter(x=>["waiting","review_required"].includes(x.status));
  assert.deepEqual(Array.from(final,x=>x.status),["waiting","waiting","review_required"]);
  assert.ok(final.slice(0,2).every(x=>x.error.includes("回执超时")));
  assert.equal(reports.some(x=>x.sendIntent===true),true,
    "steer records a one-shot intent before attempting native send");
});

test("浏览器标签查询超时后，下一次定时轮询仍能恢复心跳",async()=>{
  let stalled=true,targetsPublished=0;
  const sandbox={
    URL,AbortController,clearTimeout,
    setTimeout:(callback,ms)=>setTimeout(callback,ms===20000?5:ms),
    console:{warn(){}},
    chrome:{
      runtime:{id:"abcdefghijklmnopabcdefghijklmnop",
        getManifest(){return {version:"0.49.57"};}},
      tabs:{async query(){return stalled?new Promise(()=>{}):[];}},
      storage:{local:{async get(){return {};}}},
    },
    CQHandoff:{projectStart(){return null;},projectId(){return null;}},
    safeUrl(){return null;},
    chatKey(){return null;},
    isProjectOverview(){return false;},
    async readStore(){return {conversations:{}};},
    async fetch(endpoint){
      if(new URL(endpoint).pathname.endsWith("/targets")) targetsPublished++;
      return {ok:true,async json(){return {ok:true,job:null};}};
    },
  };
  vm.runInNewContext(source+"\nglobalThis.remoteUnderTest=CQRemoteDispatch;",sandbox);
  await sandbox.remoteUnderTest.tick();
  assert.equal(targetsPublished,0);
  stalled=false;
  await sandbox.remoteUnderTest.tick();
  assert.equal(targetsPublished,1,
    "a single stuck read must not block all future bridge heartbeats");
});
