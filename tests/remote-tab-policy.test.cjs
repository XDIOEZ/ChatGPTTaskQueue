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
const targetPersonal={kind:"personal",id:"personal",url:"https://chatgpt.com/"};
const jobId="12345678-1234-4234-8234-123456789abc";

function harness() {
  const tabs=[{id:1,url:chatUrl,status:"complete",active:true,windowId:7}];
  const created=[],reports=[],messages=[],removed=[];
  const storage={};
  let owner=1;
  const session={tabId:1,url:chatUrl,tasks:[],schedules:[],
    history:[],halted:false,queuePaused:false,
    activeTaskId:null,steeringTaskId:null,error:"",
    handoff:{phase:"idle"}};
  let releaseSafe=true;
  const chrome={
    runtime:{id:"abcdefghijklmnopabcdefghijklmnop"},
    tabs:{
      async query(){return tabs;},
      async get(id) {
        const tab=tabs.find(t=>t.id===id);
        if(!tab) throw new Error("No tab with id: "+id);
        return tab;
      },
      async remove(id) {
        const index=tabs.findIndex(t=>t.id===id);
        if(index<0) throw new Error("No tab with id: "+id);
        tabs.splice(index,1);removed.push(id);
      },
      async create(props){
        const tab={id:tabs.length+1,status:"complete",windowId:props.windowId,
          url:props.url,active:props.active};
        created.push(tab);tabs.push(tab);return tab;
      },
      async sendMessage(id,message){
        messages.push({id,message});
        if(message.type==="CQ_REMOTE_RELEASE_CHECK")
          return {ok:true,safe:releaseSafe,
            ...(!releaseSafe?{reason:"draft present"}:{})};
        if(message.type==="CQ_REMOTE_EXECUTE")
          return {ok:true,status:"queued",taskId:"task-final"};
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
      ...session,tabId:owner,recentSubmissions:[],
    }}};},
    CQHandoff:{
      normalizeProjectId(id){return typeof id==="string" && id.startsWith("g-p-")?id:null;},
      projectId(url){
        try {return new URL(url).pathname.match(/^\/g\/(g-p-[^/]+)\/(?:project|c\/[^/]+)$/)?.[1]||null;}
        catch{return null;}
      },
      projectStart(url){
        const id=this.projectId(url);return id?"https://chatgpt.com/g/"+id+"/project":null;
      },
      scopeId(url){
        try {
          const path=new URL(url).pathname;
          return this.projectId(url) ||
            (/^(?:\/|\/c\/[^/]+)$/.test(path)?"personal":null);
        } catch {return null;}
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
  return {remote,tabs,created,reports,messages,removed,storage,session,
    setOwner(id){owner=id;},setReleaseSafe(value){releaseSafe=value;}};
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

test("普通新聊天可远程创建，首次跳转后仍属原任务，不能串入项目对话",async()=>{
  const env=harness();
  const job={id:jobId,action:"new_chat",mode:"queue",text:"在普通聊天里新建任务",
    target:targetPersonal};
  const chosen=env.remote.pickTarget(job,[]);
  assert.equal(chosen.kind,"personal");
  assert.equal(chosen.url,"https://chatgpt.com/");
  const tab=await env.remote.findOrOpen(job,chosen);
  assert.equal(tab.active,false);
  assert.equal(env.created.length,1);
  assert.equal(new URL(tab.url).pathname,"/");
  assert.equal((await env.remote.findOrOpen({...job,tabId:tab.id},chosen)).id,tab.id);
  tab.url="https://chatgpt.com/c/new-ordinary-chat";
  await env.remote.onTabNavigated(tab.id,tab.url);
  assert.equal(env.storage["cq.remote.ownedTabs.v1"][String(tab.id)].visited,false,
    "普通首页首发变成正式聊天属于自然跳转，不是用户接管标签");
  const result=await env.remote.executeJob({...job,tabId:tab.id,taskId:"task-final"});
  assert.equal(result.status,"created");
  assert.equal(result.chatUrl,"https://chatgpt.com/c/new-ordinary-chat");
  assert.equal(env.created.length,1,"跳转为正式普通聊天后不能重复开页");

  tab.url="https://chatgpt.com/g/"+projectId+"/c/new-ordinary-chat";
  await env.remote.onTabNavigated(tab.id,tab.url);
  assert.equal(env.storage["cq.remote.ownedTabs.v1"][String(tab.id)].visited,true,
    "自动创建的普通聊天跳到别的项目必须永久禁止自动关闭");
  await assert.rejects(()=>env.remote.findOrOpen({...job,tabId:tab.id},chosen),
    /已切换目标/);
  assert.equal(env.created.length,1);
  assert.throws(()=>env.remote.pickTarget({...job,target:{
    kind:"personal",id:"personal",url:projectUrl,
  }},[]),/普通新对话目标/);
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

test("仅凭 URL 任务标记恢复的页面不得伪造插件所有权或被自动关闭",async()=>{
  const env=harness();
  env.tabs.push({id:2,url:chatUrl+"#cq-remote-job="+jobId,
    status:"complete",active:false,windowId:7});
  const job={id:jobId,mode:"queue",action:"continue",openIntent:true,target:targetChat};
  const found=await env.remote.findOrOpen(job,targetChat);
  assert.equal(found.id,2);
  assert.equal(env.created.length,0);
  assert.equal(env.storage["cq.remote.ownedTabs.v1"],undefined,
    "URL 标记不等于 Chrome 扩展创建标签的可靠证明");
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

test("普通远程任务仅在对应 FINISHED、队列清空后自动关闭自建后台标签",async()=>{
  const env=harness();
  const job={id:jobId,action:"continue",mode:"queue",target:targetChat,text:"test"};
  const tab=await env.remote.findOrOpen(job,targetChat);
  env.tabs[1].url=chatUrl;
  await env.remote.executeJob({...job,tabId:tab.id,taskId:"task-final"});
  env.setOwner(tab.id);
  env.session.tasks=[{id:"pending-other",status:"pending"}];
  env.session.history=[{type:"finished",taskId:"task-final"}];
  await env.remote.onTaskFinished(tab.id,"task-final");
  assert.equal(env.removed.length,0,"仍有待发队列绝不释放");
  env.session.tasks=[];
  env.setReleaseSafe(false);
  await env.remote.releaseFinishedJobs();
  assert.equal(env.removed.length,0,"存在网页草稿或未稳定回复时不能关闭");
  env.setReleaseSafe(true);
  env.setOwner(1); // A separate tab may have inherited chat ownership.
  await env.remote.releaseFinishedJobs();
  assert.deepEqual(env.removed,[tab.id]);
  assert.equal(env.tabs.length,1);
  assert.equal(env.tabs[0].active,true,"用户原标签始终存在");
  assert.equal(env.storage["cq.remote.ownedTabs.v1"][String(tab.id)],undefined);
});

test("未真正 FINISHED、人工访问、网页仍在生成均不能触发自动关闭",async()=>{
  const env=harness();
  const job={id:jobId,action:"continue",mode:"queue",target:targetChat,text:"test"};
  const tab=await env.remote.findOrOpen(job,targetChat);
  env.tabs[1].url=chatUrl;
  await env.remote.executeJob({...job,tabId:tab.id,taskId:"id1"});
  env.setOwner(tab.id);
  await env.remote.onTaskFinished(tab.id,"id1");
  assert.deepEqual(env.removed,[],"伪造完成调用没有完成日志，不得关闭");
  env.session.history=[{type:"finished",taskId:"id1"}];
  await env.remote.onTabActivated(tab.id);
  await env.remote.releaseFinishedJobs();
  assert.deepEqual(env.removed,[],"用户访问过的后台标签不再自动关闭");
});

test("插件标签导航到另一对话后永久保护，无法误关用户正在使用的页面",async()=>{
  const env=harness();
  const job={id:jobId,action:"continue",mode:"queue",target:targetChat,text:"test"};
  const tab=await env.remote.findOrOpen(job,targetChat);
  await env.remote.onTabNavigated(tab.id,"https://chatgpt.com/c/unrelated-chat");
  assert.equal(env.storage["cq.remote.ownedTabs.v1"][String(tab.id)].visited,true);
  assert.equal(env.removed.length,0);
});

test("释放后台标签不得关闭浏览器窗口中唯一剩余的标签",async()=>{
  const env=harness(),runId="only-window-run";
  const job={id:jobId,action:"continue",mode:"queue",
    channel:"team",runId,target:targetChat};
  const owned=await env.remote.findOrOpen(job,targetChat);
  env.tabs[1].url=chatUrl;
  env.tabs.splice(0,1); // Test a single remaining extension tab in a window.
  env.setOwner(owned.id);
  const result=await env.remote.releaseOwnedChat("chat-123",runId);
  assert.equal(result.status,"skipped");
  assert.equal(env.removed.length,0);
  assert.equal(env.tabs.length,1);
});

test("团队释放仅关闭所属 run 的插件自建聊天标签，保留用户原标签",async()=>{
  const env=harness(),runId="stress-20261026-team";
  const teamJob={id:jobId,action:"continue",mode:"queue",channel:"team",
    runId,target:targetChat};
  const tab=await env.remote.findOrOpen(teamJob,targetChat);
  env.tabs[1].url=chatUrl;
  env.setOwner(tab.id);
  env.session.tasks=[{id:"busy",status:"waiting"}];
  let result=await env.remote.releaseOwnedChat("chat-123",runId);
  assert.equal(result.status,"deferred");
  assert.equal(env.removed.length,0);
  env.session.tasks=[];
  env.setOwner(1); // The original tab may own the last native queue state.
  result=await env.remote.releaseOwnedChat("chat-123","other-run");
  assert.equal(result.status,"skipped");
  result=await env.remote.releaseOwnedChat("chat-123",runId);
  assert.equal(result.status,"closed");
  assert.deepEqual(env.removed,[tab.id]);
  assert.equal(env.tabs.length,1);
  assert.equal(env.tabs[0].id,1);
  assert.equal(env.tabs[0].active,true);
});

test("同一协作聊天被多个 run 复用时，必须等所有 run 结束才释放",async()=>{
  const env=harness();
  const first={id:jobId,action:"continue",mode:"queue",channel:"team",
    runId:"team-run-one",target:targetChat};
  const tab=await env.remote.findOrOpen(first,targetChat);
  env.tabs[1].url=chatUrl;
  const second={...first,id:"88888888-1234-4234-8234-123456789abc",
    runId:"team-run-two"};
  assert.equal((await env.remote.findOrOpen(second,targetChat)).id,tab.id);
  const ownership=env.storage["cq.remote.ownedTabs.v1"][String(tab.id)];
  assert.equal(ownership.runIds.length,2);
  env.setOwner(tab.id);
  const a=await env.remote.releaseOwnedChat("chat-123","team-run-one");
  assert.equal(a.status,"skipped");
  assert.equal(env.removed.length,0);
  const b=await env.remote.releaseOwnedChat("chat-123","team-run-two");
  assert.equal(b.status,"closed");
  assert.deepEqual(env.removed,[tab.id]);
  assert.equal(env.tabs[0].id,1);
});
