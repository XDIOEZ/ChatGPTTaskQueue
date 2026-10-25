"use strict";
const {test} = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const vm = require("node:vm");

const temp=fs.mkdtempSync(path.join(os.tmpdir(),"cq-remote-bridge-"));
process.env.CQ_BRIDGE_DATA_DIR=temp;
const bridge=require("../remote-bridge.cjs");
const source=fs.readFileSync(path.join(__dirname,"../remote-dispatch.js"),"utf8");
const agentToken="test-agent-token";
const extensionId="abcdefghijklmnopabcdefghijklmnop";
fs.writeFileSync(path.join(temp,"agent-token"),agentToken);

const chatUrl="https://chatgpt.com/g/g-p-1234567890abcdef1234567890abcdef/c/chat-123";
const projectUrl="https://chatgpt.com/g/g-p-1234567890abcdef1234567890abcdef/project";

test("本机桥接请求：身份、目标别名、任务入队、结果回执",async t=>{
  const server=bridge.makeServer();
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
  t.after(async()=>new Promise(resolve=>server.close(resolve)));
  const port=server.address().port;
  async function call(method,endpoint,body,identity="agent",origin) {
    const data=body===undefined?null:Buffer.from(JSON.stringify(body));
    const headers={
      ...(identity==="agent"?{Authorization:"Bearer "+agentToken}:{}),
      ...(identity==="extension"?{
        "X-CQ-Extension":"chatgpt-task-queue-extension-v1",
        "X-CQ-Extension-Id":extensionId,
      }:{}),
      ...(origin?{Origin:origin}:{}),
      ...(data?{"Content-Type":"application/json","Content-Length":data.length}:{}),
    };
    return new Promise((resolve,reject)=>{
      const req=http.request({hostname:"127.0.0.1",port,path:endpoint,method,headers},res=>{
        const chunks=[];res.on("data",c=>chunks.push(c));res.on("end",()=>{
          try {resolve({code:res.statusCode,data:chunks.length?
            JSON.parse(Buffer.concat(chunks).toString("utf8")):null,headers:res.headers});}
          catch(error){reject(error);}
        });
      });
      req.on("error",reject);
      if(data)req.write(data);
      req.end();
    });
  }
  const health=await call("GET","/health",undefined,"none");
  assert.equal(health.code,200);
  assert.equal((await call("GET","/v1/targets",undefined,"none")).code,401);
  assert.equal((await call("GET","/v1/extension/poll",undefined,"extension",
    "https://example.com")).code,403);
  const extensionOrigin="chrome-extension://"+extensionId;
  const discovery=await call("POST","/v1/extension/targets",{
    version:require("../manifest.json").version,
    targets:[{kind:"chat",id:"chat-123",url:chatUrl,name:"游戏问题讨论"},
      {kind:"project",id:"g-p-1234567890abcdef1234567890abcdef",
        url:projectUrl,name:"FlatWorld"}],
  },"extension",extensionOrigin);
  assert.equal(discovery.code,200);
  assert.equal(discovery.data.count,2);
  assert.equal(discovery.headers["access-control-allow-origin"],extensionOrigin);
  assert.equal(JSON.parse(fs.readFileSync(path.join(temp,"jobs.json"),"utf8")).extensionVersion,
    require("../manifest.json").version);

  const first=await call("POST","/v1/jobs",{
    action:"continue",target:{kind:"chat",name:"游戏问题讨论"},
    mode:"steer",text:"修复液体系统",
  });
  assert.equal(first.code,201);
  assert.equal(first.data.job.target.url,chatUrl);
  const firstId=first.data.job.id;
  const poll=await call("GET","/v1/extension/poll",undefined,"extension",extensionOrigin);
  assert.equal(poll.data.job.id,firstId);
  assert.equal(poll.data.job.mode,"steer");
  assert.equal((await call("GET","/v1/extension/poll",undefined,"extension",
    extensionOrigin)).data.job,null,"租约防止双重领取");
  const finish=await call("POST","/v1/extension/report",{id:firstId,status:"steered",
    tabId:10,taskId:"x-1"},"extension",extensionOrigin);
  assert.equal(finish.data.job.status,"steered");
  const duplicate=await call("POST","/v1/extension/report",{id:firstId,status:"failed",
    error:"late"},"extension",extensionOrigin);
  assert.equal(duplicate.data.job.status,"steered","终态不可回退");

  const bound=await call("POST","/v1/bindings",{
    kind:"project",name:"我的游戏项目",url:projectUrl,
  });
  assert.equal(bound.code,200);
  const next=await call("POST","/v1/jobs",{
    action:"new_chat",target:{kind:"project",name:"我的游戏项目"},
    text:"添加硅矿生产路线",
  });
  assert.equal(next.code,201);
  assert.equal(next.data.job.target.url,projectUrl);
  const newJobId=next.data.job.id;
  assert.equal((await call("GET","/v1/extension/poll",undefined,"extension",
    extensionOrigin)).data.job.id,newJobId);
  assert.equal((await call("POST","/v1/extension/report",{
    id:newJobId,status:"created",tabId:20,chatUrl:chatUrl,
  },"extension",extensionOrigin)).data.job.status,"created");
  assert.equal((await call("GET","/v1/jobs/"+newJobId)).data.job.chatUrl,chatUrl);
  const unclaimed=await call("POST","/v1/jobs",{
    action:"continue",target:{kind:"chat",id:"chat-123"},text:"cancel stress",
  });
  const unclaimedId=unclaimed.data.job.id;
  assert.equal((await call("POST","/v1/jobs/cancel-unclaimed",
    {ids:[unclaimedId]},"none")).code,401);
  const cancelled=await call("POST","/v1/jobs/cancel-unclaimed",{ids:[unclaimedId]});
  assert.equal(cancelled.code,200);
  assert.deepEqual(cancelled.data.cancelled,[unclaimedId]);
  assert.equal((await call("GET","/v1/jobs/"+unclaimedId)).data.job.status,"cancelled");
  assert.equal((await call("GET","/v1/extension/poll",undefined,"extension",
    extensionOrigin)).data.job,null,"取消的未领取任务不得再被派发");

  const otherId="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  assert.equal((await call("GET","/v1/extension/poll",undefined,"extension",
    "chrome-extension://"+otherId)).code,403);
  assert.equal((await call("GET","/v1/targets")).data.targets.some(t=>
    t.name==="我的游戏项目"&&t.url===projectUrl),true);
  const bindFromChat=await call("POST","/v1/bindings",{
    kind:"project",name:"项目聊天链接绑定",url:chatUrl,
  });
  assert.equal(bindFromChat.code,200);
  assert.equal(bindFromChat.data.binding.url,projectUrl,
    "从项目聊天链接绑定项目时自动转为项目主页");
});

test("输入校验和租约重试：类型、长度、终态不会重复领取",()=>{
  assert.equal(bridge.validateJob({action:"continue",mode:"queue",channel:"team",
    target:{kind:"chat",name:"A"},text:"team"}).channel,"team");
  assert.equal(bridge.validateJob({action:"new_chat",channel:"team_spawn",
    target:{kind:"project",name:"FlatWorld"},text:"spawn"}).channel,"team_spawn");
  assert.throws(()=>bridge.validateJob({action:"new_chat",channel:"team",
    target:{kind:"project",name:"FlatWorld"},text:"invalid"}));
  assert.throws(()=>bridge.validateJob({action:"continue",channel:"team_spawn",
    target:{kind:"chat",name:"A"},text:"invalid"}));
  assert.throws(()=>bridge.validateJob({action:"new_chat",mode:"steer",
    target:{kind:"project",id:"g-p-abc"},text:"hi"}));
  assert.throws(()=>bridge.validateJob({action:"continue",
    target:{kind:"chat",url:"https://evil.com/c/123"},text:"hi"}));
  assert.throws(()=>bridge.validateJob({action:"continue",
    target:{kind:"chat",name:"A"},text:"x".repeat(12001)}));
  const item=bridge.makeJob({action:"continue",target:{kind:"chat",name:"A"},
    text:"test"} ,1000);
  const data={jobs:[item]};
  const once=bridge.dispatchNext(data,1100);
  assert.equal(once.id,item.id);
  assert.equal(bridge.dispatchNext(data,1190),null);
  const again=bridge.dispatchNext(data,once.updatedAt+90001);
  assert.equal(again.id,item.id);
  assert.equal(again.attempts,2);
  bridge.updateJob(item,{status:"queued",tabId:2},220000);
  assert.equal(bridge.dispatchNext(data,999999),null);
});

test("只能取消尚未被扩展领取的任务，已领取/已完成严格保留",()=>{
  const payload={action:"continue",target:{kind:"chat",name:"test"},text:"smoke"};
  const a=bridge.makeJob(payload,1000);
  const b=bridge.makeJob(payload,1001);
  const c=bridge.makeJob(payload,1002);
  const state={jobs:[a,b,c]};
  const claimed=bridge.dispatchNext({jobs:[b]},1100);
  assert.equal(claimed.id,b.id);
  bridge.updateJob(c,{status:"queued",tabId:11},1200);
  const result=bridge.cancelUnclaimedJobs(state,[a.id,b.id,c.id],1300);
  assert.deepEqual(result.cancelled,[a.id]);
  assert.equal(result.skipped.length,2);
  assert.equal(a.status,"cancelled");
  assert.equal(b.status,"pending","已尝试发送的任务不允许当作未发取消");
  assert.equal(c.status,"queued");
  assert.equal(bridge.dispatchNext({jobs:[a]},999999),null);
  assert.equal(bridge.updateJob(a,{status:"queued"},1500).status,"cancelled",
    "终态不接受迟到回执反向重排");
  assert.throws(()=>bridge.cancelUnclaimedJobs(state,[a.id,a.id]),/不重复/);
  const duringLease=bridge.quarantineUncertainJobs(state,[b.id],1150);
  assert.equal(duringLease.quarantined.length,0,"未过期租约不能被隔离");
  assert.equal(b.status,"pending");
  const stale=bridge.quarantineUncertainJobs(state,[b.id],200000);
  assert.deepEqual(stale.quarantined,[b.id]);
  assert.equal(b.status,"review_required");
  assert.equal(bridge.dispatchNext({jobs:[b]},999999),null,
    "隔离后绝不可自动重发不确定消息");
  assert.equal(bridge.quarantineUncertainJobs(state,[c.id],200000).quarantined.length,0);
});

test("扩展调度：严格匹配指定会话和项目，拒绝重名歧义",()=>{
  const sandbox={
    URL,console,
    CQHandoff:{
      normalizeProjectId(id){return /^g-p-[a-zA-Z0-9-]+$/.test(id)?id:null;},
      projectId(url) {
        try {return new URL(url).pathname.match(/^\/g\/(g-p-[^/]+)\/(?:project|c\/[^/]+)$/)?.[1]||null;}
        catch{return null;}
      },
      projectStart(url) {
        const id=this.projectId(url);
        return id?"https://chatgpt.com/g/"+id+"/project":null;
      },
    },
    chatKey(url){return /\/c\/([^/]+)$/.test(url)?"chat:"+url.match(/\/c\/([^/]+)$/)[1]:null;},
    safeUrl(url){try{
      const u=new URL(url);return u.hostname==="chatgpt.com"?u.origin+u.pathname:null;
    }catch{return null;}},
    isProjectOverview(url){return /\/project$/.test(url);},
  };
  const remote=vm.runInNewContext(source+"\nCQRemoteDispatch",sandbox);
  const choices=remote.listTargets({
    conversations:{"chat:chat-123":{url:chatUrl}},
  },[{id:55,url:chatUrl,title:"进度讨论",status:"complete"},
    {id:56,url:projectUrl,title:"FlatWorld",status:"complete"}],
  {"chat:chat-123":"液体系统讨论"},{"chat:chat-123":"FlatWorld"});
  assert.equal(choices.find(x=>x.kind==="chat").alias,"液体系统讨论");
  assert.equal(remote.pickTarget({target:{kind:"chat",name:"液体系统讨论"}},choices).id,
    "chat-123");
  assert.equal(remote.pickTarget({target:{kind:"project",name:"FlatWorld"}},choices).url,
    projectUrl);
  assert.throws(()=>remote.pickTarget({target:{kind:"chat",name:"没打开的目标"}},choices));
  assert.throws(()=>remote.pickTarget({target:{kind:"chat",name:"重复"}},[
    {kind:"chat",id:"a",url:"https://chatgpt.com/c/a",name:"重复"},
    {kind:"chat",id:"b",url:"https://chatgpt.com/c/b",name:"重复"},
  ]));
});

test("开页/引导意图先持久化，慢任务不会饿死后续新任务",()=>{
  const first=bridge.makeJob({action:"continue",
    target:{kind:"chat",name:"正在加载的会话"},text:"第一条"},1000);
  const second=bridge.makeJob({action:"new_chat",
    target:{kind:"project",name:"FlatWorld"},text:"第二条"},1001);
  const data={jobs:[first,second]};
  assert.equal(bridge.dispatchNext(data,2000).id,first.id);
  bridge.updateJob(first,{status:"waiting",openIntent:true},2100);
  assert.equal(first.openIntent,true);
  assert.equal(bridge.dispatchNext(data,18000).id,second.id,
    "第二条任务应继续推进，不受第一条等待页面加载影响");
  bridge.updateJob(second,{status:"opening",tabId:7,openIntent:true},19000);
  const resumed=bridge.dispatchNext(data,19000);
  assert.equal(resumed.id,first.id);
  assert.equal(resumed.openIntent,true,"重试应看见已经创建过页面的意图");
  bridge.updateJob(first,{status:"review_required",
    error:"标签无法确认"},22000);
  assert.equal(bridge.dispatchNext(data,200000).id,second.id);
  bridge.updateJob(second,{status:"created",chatUrl:projectUrl},201000);
  assert.equal(second.error,undefined);
  assert.equal(bridge.dispatchNext(data,999999),null);
});
