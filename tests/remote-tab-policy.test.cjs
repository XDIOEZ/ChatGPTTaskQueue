"use strict";

const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const vm=require("node:vm");

const source=fs.readFileSync(path.join(__dirname,"../remote-dispatch.js"),"utf8");
const chatUrl="https://chatgpt.com/g/g-p-1234567890abcdef1234567890abcdef/c/chat-123";
const projectUrl="https://chatgpt.com/g/g-p-1234567890abcdef1234567890abcdef/project";
const projectId="g-p-1234567890abcdef1234567890abcdef";
const targetChat={kind:"chat",id:"chat-123",url:chatUrl};
const targetProject={kind:"project",id:projectId,url:projectUrl};
const jobId="12345678-1234-4234-8234-123456789abc";

function harness() {
  const tabs=[{id:1,url:chatUrl,status:"complete",active:true,windowId:7}];
  const created=[],reports=[],messages=[];
  const storage={};
  let owner=1;
  const chrome={
    runtime:{id:"abcdefghijklmnopabcdefghijklmnop"},
    tabs:{
      async query(){return tabs;},
      async create(props){
        const tab={id:tabs.length+1,status:"complete",windowId:props.windowId,
          url:props.url,active:props.active};
        created.push(tab);tabs.push(tab);return tab;
      },
      async sendMessage(id,message){
        messages.push({id,message});
        return message.type==="CQ_REMOTE_INSPECT"?
          {ok:true,observed:true}:{ok:true};
      },
    },
    storage:{local:{
      async get(key){return {[key]:storage[key]};},
      async set(values){Object.assign(storage,values);},
    }},
  };
  const sandbox={
    URL,console,chrome,AbortController,setTimeout,clearTimeout,
    async fetch(url,options){
      if(!url.endsWith("/report")) throw new Error("unexpected API request");
      reports.push(JSON.parse(options.body));
      return {ok:true,async json(){return {ok:true};}};
    },
    async readStore(){return {conversations:{"chat:chat-123":{
      tabId:owner,url:chatUrl,tasks:[],recentSubmissions:[],
    }}};},
    CQHandoff:{
      projectId(url){
        try {return new URL(url).pathname.match(/^\/g\/(g-p-[^/]+)\/(?:project|c\/[^/]+)$/)?.[1]||null;}
        catch{return null;}
      },
      projectStart(url){
        const id=this.projectId(url);return id?"https://chatgpt.com/g/"+id+"/project":null;
      },
    },
    chatKey(url){
      const match=/\/c\/([^/]+)$/.exec(new URL(url).pathname);
      return match?"chat:"+match[1]:null;
    },
    safeUrl(url) {
      try {
        const u=new URL(url);
        return u.hostname==="chatgpt.com"?u.origin+u.pathname:null;
      }catch {return null;}
    },
  };
  const remote=vm.runInNewContext(source+"\nCQRemoteDispatch",sandbox);
  return {remote,tabs,created,reports,messages,storage,setOwner(id){owner=id;}};
}

test("普通旧对话任务必须另开后台标签，同任务重试不再次开页",async()=>{
  const env=harness();
  const job={id:jobId,action:"continue",mode:"queue"};
  const tab=await env.remote.findOrOpen(job,targetChat);
  assert.equal(env.created.length,1);
  assert.equal(tab.id,2);
  assert.equal(tab.active,false,"不抢用户当前正在使用的标签");
  assert.equal(tab.windowId,7,"在现有浏览器窗口中新建标签，而不是新开窗口");
  assert.equal(env.tabs[0].active,true);
  assert.equal(env.tabs[0].url,chatUrl);
  assert.equal(new URL(tab.url).hash,"#cq-remote-job="+jobId);
  assert.equal(env.reports[0].openIntent,true,"必须在创建标签前记录意图");
  assert.equal(env.reports[1].tabId,2);
  assert.equal((await env.remote.findOrOpen({...job,openIntent:true,tabId:2},targetChat)).id,2);
  assert.equal((await env.remote.findOrOpen({...job,openIntent:true},targetChat)).id,2,
    "丢失标签ID也能通过唯一任务标记找回");
  assert.equal(env.created.length,1);
  env.tabs[1].url=chatUrl; // 模拟 ChatGPT 路由重定向抹掉 URL 标记
  await assert.rejects(()=>env.remote.findOrOpen({...job,openIntent:true},targetChat),
    /拒绝再次打开/);
  assert.equal(env.created.length,1,"标记丢失时宁可人工核对，也绝不重复开页");
});

test("项目新任务也创建独立标签，旧对话引导只用旧标签",async()=>{
  const env=harness();
  const newJob={id:jobId,action:"new_chat",mode:"queue"};
  const tab=await env.remote.findOrOpen(newJob,targetProject);
  assert.equal(tab.active,false);
  assert.equal(env.created.length,1);
  assert.equal(env.tabs[0].url,chatUrl);
  assert.equal(env.tabs[0].active,true);
  const steer={id:"88888888-1234-4234-8234-123456789abc",
    action:"continue",mode:"steer"};
  const old=await env.remote.findOrOpen(steer,targetChat);
  assert.equal(old.id,1);
  assert.equal(env.created.length,1,"引导不可增加任何标签页");
  env.setOwner(999);
  await assert.rejects(()=>env.remote.findOrOpen(steer,targetChat),/已有的标签页/);
  assert.equal(env.created.length,1,"找不到旧标签时必须报错，不得新建代替");
});

test("已记录发送/开页意图与标签ID的任务，目标页关闭或改路由都不重开",async()=>{
  const env=harness();
  const job={id:jobId,action:"continue",mode:"queue",openIntent:true,tabId:31};
  await assert.rejects(()=>env.remote.findOrOpen(job,targetChat),/已关闭/);
  assert.equal(env.created.length,0);
  env.tabs.push({id:31,url:projectUrl,status:"complete",active:false});
  await assert.rejects(()=>env.remote.findOrOpen(job,targetChat),/已切换目标/);
  assert.equal(env.created.length,0);
});

test("协作队列每位成员只有一个后台通信标签，多条消息重复利用",async()=>{
  const env=harness();
  const channel="cq.remote.teamChannels.v1";
  const first={id:jobId,action:"continue",mode:"queue",channel:"team"};
  const second={...first,id:"88888888-1234-4234-8234-123456789abc"};
  const tab1=await env.remote.findOrOpen(first,targetChat);
  assert.equal(tab1.active,false);
  assert.equal(env.created.length,1);
  assert.equal(env.storage[channel][targetChat.id],tab1.id);
  assert.equal(new URL(tab1.url).hash,"#cq-team-channel="+targetChat.id);
  const tab2=await env.remote.findOrOpen(second,targetChat);
  assert.equal(tab2.id,tab1.id);
  assert.equal(env.created.length,1);
  assert.equal(env.tabs[0].active,true,"用户原标签始终不被协作消息接管");
  env.tabs[1].url=chatUrl;
  const tab3=await env.remote.findOrOpen({...second,openIntent:true},targetChat);
  assert.equal(tab3.id,tab1.id,"即使 URL 标记被网页清除，持久 channel 表也能找回");
  assert.equal(env.created.length,1);
  env.tabs.splice(1,1);
  await assert.rejects(()=>env.remote.findOrOpen({...second,openIntent:true},targetChat),
    /拒绝重复开页/);
});

test("团队新建项目子对话确认后，原后台标签成为成员通信标签",async()=>{
  const env=harness();
  const url="https://chatgpt.com/g/"+projectId+"/c/chat-worker";
  env.tabs.push({id:2,url,status:"complete",active:false,windowId:7});
  const createJob={id:jobId,action:"new_chat",channel:"team_spawn",
    mode:"queue",taskId:"task-1",tabId:2,text:"hello",
    target:{kind:"project",id:projectId,url:projectUrl}};
  const result=await env.remote.executeJob(createJob);
  assert.equal(result.status,"created");
  assert.equal(env.storage["cq.remote.teamChannels.v1"]["chat-worker"],2);
  const next=await env.remote.findOrOpen({id:"88888888-1234-4234-8234-123456789abc",
    action:"continue",mode:"queue",channel:"team"},
    {kind:"chat",id:"chat-worker",url});
  assert.equal(next.id,2);
  assert.equal(env.created.length,0);
});
