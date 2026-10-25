"use strict";

const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const os=require("node:os");
const path=require("node:path");
const http=require("node:http");

test("多智能体协作：插件门槛、Git 项目、子对话、双向 ACK、消息状态及关闭保护",async t=>{
  const sandbox=fs.mkdtempSync(path.join(os.tmpdir(),"cq-agent-team-"));
  t.after(()=>fs.rmSync(sandbox,{recursive:true,force:true,maxRetries:5,retryDelay:100}));
  const bridgeDir=path.join(sandbox,"bridge");
  const teamDir=path.join(sandbox,"teams");
  const codexHome=path.join(sandbox,"codex");
  fs.mkdirSync(bridgeDir,{recursive:true});
  fs.writeFileSync(path.join(bridgeDir,"agent-token"),"unit-test-token");

  const projectId="g-p-1234567890abcdef1234567890abcdef";
  const projectUrl="https://chatgpt.com/g/"+projectId+"/project";
  const leadUrl="https://chatgpt.com/g/"+projectId+"/c/chat-lead";
  const workerUrl="https://chatgpt.com/g/"+projectId+"/c/chat-worker";
  const posted=[];
  const jobs=new Map();
  const releases=new Map();
  let ordinal=0;
  const server=http.createServer((req,res)=>{
    const chunks=[];
    req.on("data",chunk=>chunks.push(chunk));
    req.on("end",()=>{
      const body=chunks.length?JSON.parse(Buffer.concat(chunks).toString("utf8")):null;
      const respond=(status,payload)=>{
        res.writeHead(status,{"Content-Type":"application/json"});
        res.end(JSON.stringify(payload));
      };
      if(req.url==="/health") return respond(200,{ok:true,version:3,
        service:"chatgpt-task-queue-bridge",
        features:["extension_version","team_channels","safe_tab_release"]});
      if(req.headers.authorization!=="Bearer unit-test-token")
        return respond(401,{ok:false,error:"unverified"});
      if(req.method==="GET" && req.url==="/v1/targets")
        return respond(200,{ok:true,targets:[{kind:"project",name:"FlatWorld",
          id:projectId,url:projectUrl}]});
      if(req.method==="POST" && req.url==="/v1/releases") {
        let result=releases.get(body.runId);
        if(!result) {
          result={id:"22222222-2222-4222-8222-222222222222",
            runId:body.runId,status:"pending",
            chats:body.chats.map((url,index)=>({id:"chat-"+index,url,status:"pending"}))};
          releases.set(body.runId,result);
        }
        return respond(200,{ok:true,release:result});
      }
      if(req.method==="GET" && req.url.startsWith("/v1/releases/")) {
        const result=releases.get(req.url.slice("/v1/releases/".length));
        return respond(result?200:404,result?{ok:true,release:result}:
          {ok:false,error:"release not found"});
      }
      if(req.method==="POST" && req.url==="/v1/jobs") {
        posted.push(body);
        const id="00000000-0000-4000-8000-"+(++ordinal).toString().padStart(12,"0");
        const job={id,action:body.action,status:"pending",target:body.target};
        jobs.set(id,job);
        return respond(201,{ok:true,job});
      }
      const lookup=req.url.match(/^\/v1\/jobs\/([a-f0-9-]+)$/);
      if(req.method==="GET" && lookup) {
        const job=jobs.get(lookup[1]);
        return respond(job?200:404,job?{ok:true,job}:{ok:false,error:"not found"});
      }
      return respond(404,{ok:false,error:"invalid request"});
    });
  });
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
  t.after(async()=>new Promise(resolve=>server.close(resolve)));
  process.env.CQ_BRIDGE_DATA_DIR=bridgeDir;
  process.env.CQ_TEAM_DATA_DIR=teamDir;
  process.env.CODEX_HOME=codexHome;
  process.env.CQ_BRIDGE_PORT=String(server.address().port);
  const team=require("../skills/gpt-queue-agent-team/team.cjs");

  assert.equal((await team.doctor()).ok,false,"只有桥接服务不够，扩展必须配对并在线");
  await assert.rejects(()=>team.install(),/扩展/);
  const pairedId="abcdefghijklmnopabcdefghijklmnop";
  fs.writeFileSync(path.join(bridgeDir,"paired-extension-id"),pairedId);
  fs.writeFileSync(path.join(bridgeDir,"jobs.json"),JSON.stringify({
    version:1,extensionVersion:require("../manifest.json").version,
    targetsAt:Date.now(),jobs:[],targets:[],
  }));
  const health=await team.doctor();
  assert.equal(health.ok,true);
  assert.equal(health.pairedExtension,pairedId);
  fs.writeFileSync(path.join(bridgeDir,"jobs.json"),JSON.stringify({
    version:1,extensionVersion:"0.0.0",targetsAt:Date.now(),
    jobs:[],targets:[],
  }));
  assert.equal((await team.doctor()).ok,false,
    "文件已升级但 Edge/Chrome 扩展没更新时，协作必须禁用");
  fs.writeFileSync(path.join(bridgeDir,"jobs.json"),JSON.stringify({
    version:1,extensionVersion:require("../manifest.json").version,
    targetsAt:Date.now(),jobs:[],targets:[],
  }));

  const installed=await team.install();
  assert.equal(installed.ok,true);
  assert.equal(fs.lstatSync(installed.registration).isSymbolicLink(),true);
  assert.equal((await team.install()).alreadyInstalled,true,"重复安装不可复制一份失控的 Skill");

  const run="sim-test-01";
  const repo=path.join(__dirname,"..");
  const noLead=await team.initialize({run:"sim-no-lead",repo,project:"FlatWorld"});
  assert.equal(noLead.ok,true);
  await assert.rejects(()=>team.spawn({run:"sim-no-lead",
    member:"worker",role:"researcher",task:"查看旧项目"}),/主智能体还未登记/);
  assert.equal(posted.length,0,"没有主智能体地址时不得创建孤儿成员对话");
  const started=await team.initialize({run,repo,project:"FlatWorld",
    lead:"main","lead-chat":leadUrl});
  assert.equal(started.ok,true);
  assert.equal(started.project.id,projectId);
  await assert.rejects(()=>team.initialize({run,repo,project:"FlatWorld"}),/已经存在/);
  const spawned=await team.spawn({run,member:"worker",role:"implementer",
    task:"只检查文件，不修改代码；先报告 PLAN"});
  assert.equal(spawned.ok,true);
  assert.equal(posted.length,1);
  assert.equal(posted[0].action,"new_chat");
  assert.equal(posted[0].channel,"team_spawn");
  assert.equal(posted[0].target.id,projectId);
  await assert.rejects(()=>team.send({run,from:"worker",to:"main",
    type:"PLAN",text:"等待创建完成"}),/正式对话 URL/);
  assert.equal(posted.length,1);
  await assert.rejects(()=>team.spawn({run,member:"worker",role:"implementer",
    task:"第二次创建"}),/已经登记/);
  assert.equal(posted.length,1,"重试不得开第二个标签页");
  const activeJob=jobs.get(spawned.spawnJobId);
  activeJob.status="created";
  activeJob.chatUrl=workerUrl;
  const synced=await team.sync({run});
  assert.equal(synced.members.worker.chatUrl,workerUrl);

  const sent=await team.send({run,from:"main",to:"worker",type:"CONTRACT",
    text:"请确认接口 A->B，不要改动 UI"});
  assert.equal(sent.ok,true);
  assert.equal(sent.acknowledgment,"awaiting_explicit_ACK");
  assert.equal(posted.length,2);
  assert.equal(posted[1].channel,"team");
  assert.match(posted[1].text,new RegExp(sent.messageId));
  assert.match(posted[1].text,/--message/);
  assert.equal(posted[1].target.url,workerUrl);
  assert.equal((await team.inbox({run,member:"worker"})).messages.length,1);
  await assert.rejects(()=>team.send({run,from:"worker",to:"main",
    type:"BLOCKER",mode:"steer",text:"紧急调整"}),/--urgent/);
  await assert.rejects(()=>team.acknowledge({run,from:"main",
    message:sent.messageId,text:"冒认"}),/只能由消息实际接收成员/);

  const ack=await team.acknowledge({run,from:"worker",message:sent.messageId,
    text:"确认接口，实施前先更新测试"});
  assert.equal(ack.ok,true);
  assert.equal(ack.ackStored,true);
  assert.equal(posted.length,3);
  assert.equal(posted[2].channel,"team");
  assert.equal(posted[2].target.url,leadUrl);
  assert.match(posted[2].text,/ACK_MSG/);
  assert.equal((await team.inbox({run,member:"worker"})).messages.length,0);
  assert.equal((await team.acknowledge({run,from:"worker",
    message:sent.messageId,text:"同一确认再来一次"})).alreadyAcknowledged,true);
  assert.equal(posted.length,3,"重复 ACK 绝不重新发送");
  assert.equal(team.conciseRun(team.readRun(run)).counts.unacknowledged,0);
  await assert.rejects(()=>team.finish({run,verified:true}),/未完成入队|未报告/);
  const ready=await team.send({run,from:"worker",to:"main",type:"VERIFIED",
    text:"成员已完成测试，执行结果可用于集成"});
  const readyAck=await team.acknowledge({run,from:"main",
    message:ready.messageId,text:"已完成 CodeReviewFix 和集成验证"});
  for(const job of jobs.values()) {
    if(job.action==="continue") job.status="queued";
  }
  await team.sync({run});
  await assert.rejects(()=>team.finish({run}),/--verified/);
  const finalized=await team.finish({run,verified:true});
  assert.equal(finalized.ok,true);
  assert.equal(finalized.release.chats.length,2);
  assert.equal(releases.size,1);
  assert.equal((await team.finish({run,verified:true})).release.id,finalized.release.id,
    "重复 finish 只能读回同一 run 的释放请求");
  await assert.rejects(()=>team.send({run,from:"main",to:"worker",
    type:"PLAN",text:"结束后禁止发信"}),/运行已结束/);

  fs.writeFileSync(path.join(bridgeDir,"jobs.json"),JSON.stringify({
    version:1,extensionVersion:require("../manifest.json").version,
    targetsAt:Date.now()-150000,jobs:[],targets:[],
  }));
  assert.equal((await team.doctor()).ok,false,"扩展停止同步即禁用 Skill");
  await assert.rejects(()=>team.send({run,from:"main",to:"worker",
    type:"DISCOVERY",text:"禁止离线发送"}).then(()=>{}),/Skill/);
  await assert.rejects(()=>team.main(["send","--run",run,"--from","main",
    "--to","worker","--type","DISCOVERY","--text","禁止离线"]),/Skill/);
  assert.equal(posted.length,5,"离线时不允许绕过门槛发送");
  const removed=team.uninstall();
  assert.equal(removed.uninstalled,true);
  assert.equal(fs.existsSync(installed.registration),false);
  assert.equal(fs.existsSync(path.join(repo,"skills","gpt-queue-agent-team","SKILL.md")),true,
    "卸载只解绑入口，不删除 Git 仓库中的源文件");
});
