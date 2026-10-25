#!/usr/bin/env node
"use strict";

// GPT 队列驱动的多智能体通信：只有配对扩展正在同步时才允许协作。
// 业务对话一律走已存在的远程队列桥接器，协作记录留在本机，不写入 Git。
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const http = require("node:http");
const crypto = require("node:crypto");
const {spawnSync} = require("node:child_process");

const SKILL = "gpt-queue-agent-team";
const SKILL_ROOT = fs.realpathSync(__dirname);
const PLUGIN_ROOT = path.resolve(SKILL_ROOT, "..", "..");
const BRIDGE_ROOT = process.env.CQ_BRIDGE_DATA_DIR ||
  path.join(process.env.LOCALAPPDATA || path.join(os.homedir(),"AppData","Local"),
    "ChatGPTTaskQueue","remote-bridge");
const TEAM_ROOT = process.env.CQ_TEAM_DATA_DIR ||
  path.join(process.env.LOCALAPPDATA || path.join(os.homedir(),"AppData","Local"),
    "ChatGPTTaskQueue","team-skill");
const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(),".codex");
const REGISTRATION = path.join(CODEX_HOME,"skills",SKILL);
const PORT = Number(process.env.CQ_BRIDGE_PORT) || 43578;
const MAX_AGE_MS = 120000;
const VALID_RUN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{2,63}$/;
const VALID_MEMBER = /^[a-zA-Z][a-zA-Z0-9_-]{0,39}$/;
const TYPES = new Set(["PLAN","DISCOVERY","CONTRACT","BLOCKER","READY",
  "REVIEW","VERIFIED","ACK","QUESTION","ANSWER","HANDOFF"]);

function reject(message) {throw new Error(message);}
function required(value,what) {
  if(typeof value!=="string" || !value.trim()) reject("缺少 "+what);
  return value.trim();
}
function runId(value) {
  if(!VALID_RUN.test(value||"")) reject("run 标识只允许 3～64 位字母数字、- 和 _");
  return value;
}
function memberId(value) {
  if(!VALID_MEMBER.test(value||"")) reject("成员名须以字母开头，最多 40 位字母数字、- 和 _");
  return value;
}
function options(argv) {
  const parsed={};
  for(let i=0;i<argv.length;i++) {
    const part=argv[i];
    if(!part.startsWith("--")) reject("未知参数 "+part);
    if(["--json","--urgent","--verified"].includes(part)) {
      parsed[part.slice(2)]=true;continue;
    }
    if(i+1>=argv.length || argv[i+1].startsWith("--")) reject("缺少参数 "+part+" 的值");
    if(part.slice(2) in parsed) reject("参数重复："+part);
    parsed[part.slice(2)]=argv[++i];
  }
  return parsed;
}
function messageText(opts) {
  const value=opts.file ? fs.readFileSync(path.resolve(opts.file),"utf8") : opts.text;
  if(typeof value!=="string" || !value.trim() || value.length>9500)
    reject("消息不能为空且不得超过 9500 字；大内容请以仓库文件/commit 传递");
  return value.trim();
}
function fixedChatUrl(value) {
  const url=new URL(required(value,"ChatGPT 对话 URL"));
  if(url.protocol!=="https:" ||
      !["chatgpt.com","chat.openai.com"].includes(url.hostname) ||
      !/(?:^|\/)c\/[a-zA-Z0-9-]+\/?$/.test(url.pathname))
    reject("必须提供官方 ChatGPT 既有对话地址");
  return url.origin+url.pathname.replace(/\/+$/,"");
}
function checkProjectUrl(value) {
  const url=new URL(value);
  if(url.protocol!=="https:" ||
      !["chatgpt.com","chat.openai.com"].includes(url.hostname) ||
      !/^\/g\/g-p-[a-zA-Z0-9-]+\/project\/?$/.test(url.pathname))
    reject("必须提供官方 ChatGPT 项目首页地址");
  return url.origin+url.pathname.replace(/\/+$/,"");
}
function projectIdFromUrl(url) {
  return new URL(url).pathname.match(/^\/g\/(g-p-[a-zA-Z0-9-]+)/)?.[1]
    .match(/^(g-p-[a-f0-9]{32})(?:-[a-z0-9-]+)?$/i)?.[1] ||
    new URL(url).pathname.match(/^\/g\/(g-p-[a-zA-Z0-9-]+)/)?.[1] || null;
}
function safeReadJson(file) {return JSON.parse(fs.readFileSync(file,"utf8"));}
function statePath(id) {return path.join(TEAM_ROOT,"runs",runId(id)+".json");}
function readRun(id) {
  const file=statePath(id);
  if(!fs.existsSync(file)) reject("协作运行不存在："+id+"；先执行 init");
  const result=safeReadJson(file);
  if(result.version!==1 || result.id!==id || !result.members ||
      !Array.isArray(result.messages)) reject("协作运行记录已损坏，拒绝覆盖");
  return result;
}
function writeAtomic(file, data) {
  fs.mkdirSync(path.dirname(file),{recursive:true});
  const tmp=file+"."+process.pid+"."+crypto.randomBytes(5).toString("hex")+".tmp";
  try {
    fs.writeFileSync(tmp,JSON.stringify(data,null,2),{mode:0o600});
    fs.renameSync(tmp,file);
  }finally {if(fs.existsSync(tmp)) fs.unlinkSync(tmp);}
}
async function locked(id,mutate) {
  const file=statePath(id),lock=file+".lock";
  fs.mkdirSync(path.dirname(file),{recursive:true});
  let acquired=false;
  for(let n=0;n<75;n++) {
    try {fs.mkdirSync(lock);acquired=true;break;}
    catch(error) {
      if(error.code!=="EEXIST") throw error;
      await new Promise(r=>setTimeout(r,80));
    }
  }
  if(!acquired) reject("另一个智能体正在修改登记，锁定超时；没有覆盖任何消息");
  try {
    const current=fs.existsSync(file)?readRun(id):null;
    const result=await mutate(current);
    if(result?.save) writeAtomic(file,result.state);
    return result?.value;
  }finally {fs.rmdirSync(lock);}
}
function httpJson(method,url,body,token,timeout=5000) {
  return new Promise((resolve,rejectPromise)=>{
    const bytes=body===undefined?null:Buffer.from(JSON.stringify(body));
    const request=http.request({
      hostname:"127.0.0.1",port:PORT,method,path:url,timeout,
      headers:{...(token?{Authorization:"Bearer "+token}:{}),
        ...(bytes?{"Content-Type":"application/json","Content-Length":bytes.length}:{})},
    },response=>{
      const chunks=[];
      response.on("data",chunk=>chunks.push(chunk));
      response.on("end",()=>{
        try {
          const payload=JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if(response.statusCode>=400 || payload.ok!==true)
            rejectPromise(new Error(payload.error||"GPT 队列桥接器拒绝操作"));
          else resolve(payload);
        }catch(error){rejectPromise(error);}
      });
    });
    request.on("error",rejectPromise);
    request.on("timeout",()=>request.destroy(new Error("桥接器未及时响应")));
    if(bytes) request.write(bytes);
    request.end();
  });
}
function agentToken() {
  const file=path.join(BRIDGE_ROOT,"agent-token");
  if(!fs.existsSync(file)) reject("桥接器未提供本机访问令牌");
  return fs.readFileSync(file,"utf8").trim();
}
async function api(method,endpoint,body) {
  return httpJson(method,endpoint,body,agentToken());
}
async function doctor() {
  const problems=[];
  const manifest=path.join(PLUGIN_ROOT,"manifest.json");
  let pluginVersion=null, syncAgeSeconds=null, pairedExtension=null;
  try {
    const m=safeReadJson(manifest);
    if(!m.name?.includes("ChatGPT") || !m.background?.service_worker ||
        !fs.existsSync(path.join(PLUGIN_ROOT,m.background.service_worker)))
      problems.push("插件文件不完整");
    pluginVersion=m.version;
  }catch {problems.push("插件本体或 manifest.json 不存在");}
  try {
    const pair=fs.readFileSync(path.join(BRIDGE_ROOT,"paired-extension-id"),"utf8").trim();
    if(!/^[a-z]{32}$/.test(pair)) problems.push("浏览器扩展尚未有效配对");
    else pairedExtension=pair;
  }catch {problems.push("浏览器扩展尚未配对");}
  try {
    const result=safeReadJson(path.join(BRIDGE_ROOT,"jobs.json"));
    const timestamp=result.targetsAt;
    if(!Number.isFinite(timestamp)) problems.push("尚无浏览器扩展在线同步");
    else {
      syncAgeSeconds=Math.round((Date.now()-timestamp)/1000);
      if(syncAgeSeconds< -10 || syncAgeSeconds*1000>MAX_AGE_MS)
        problems.push("浏览器扩展心跳已过期，请启用/刷新扩展");
    }
    if(pluginVersion && result.extensionVersion!==pluginVersion)
      problems.push("浏览器扩展版本与仓库不一致，请重新加载 Edge/Chrome 中的新版插件");
  }catch {problems.push("桥接器尚无有效状态存档");}
  try {
    const bridge=await httpJson("GET","/health");
    if(bridge.service!=="chatgpt-task-queue-bridge" ||
        !bridge.features?.includes("team_channels") ||
        !bridge.features?.includes("safe_tab_release"))
      problems.push("本机桥接器尚未更新到协作版本，请重启本机桥接器");
  }catch {problems.push("本机桥接器未运行");}
  return {ok:problems.length===0,pluginVersion,pairedExtension,
    syncAgeSeconds,problems};
}
async function requireOnline() {
  const result=await doctor();
  if(!result.ok) reject("GPT 队列协作 Skill 已禁用："+result.problems.join("；"));
}
function installedHere() {
  try {
    return fs.realpathSync(REGISTRATION).toLowerCase()===SKILL_ROOT.toLowerCase();
  }catch {return false;}
}
async function install() {
  await requireOnline();
  fs.mkdirSync(path.dirname(REGISTRATION),{recursive:true});
  if(fs.existsSync(REGISTRATION)) {
    if(!installedHere()) reject("同名 Skill 已存在且不是本插件所有；拒绝覆盖："+REGISTRATION);
    return {ok:true,alreadyInstalled:true,registration:REGISTRATION};
  }
  fs.symlinkSync(SKILL_ROOT,REGISTRATION,process.platform==="win32"?"junction":"dir");
  return {ok:true,registration:REGISTRATION,linkedTo:SKILL_ROOT};
}
function uninstall() {
  if(!installedHere()) {
    if(fs.existsSync(REGISTRATION)) reject("现有目录不属于本插件，拒绝删除");
    return {ok:true,alreadyUninstalled:true};
  }
  // Only detach a link/junction created for this plugin; never delete source.
  const stat=fs.lstatSync(REGISTRATION);
  if(!stat.isSymbolicLink()) reject("目标不是符号链接，拒绝删除真实技能文件");
  fs.rmdirSync(REGISTRATION);
  return {ok:true,uninstalled:true,sourcePreserved:SKILL_ROOT};
}
function projectFromTargets(name,targets) {
  const lookup=required(name,"项目名称或 URL").toLowerCase();
  const unique=new Map((targets||[]).filter(item=>item.kind==="project" &&
    [item.id,item.url,item.name,item.alias].some(t=>String(t||"").toLowerCase()===lookup))
    .map(item=>[item.id,item]));
  if(unique.size!==1) reject(unique.size>1?"项目名称不唯一，请使用 ID/URL":
    "找不到指定项目，请先在插件桥接器绑定项目名称");
  const project=[...unique.values()][0];
  checkProjectUrl(project.url);
  return {id:project.id,url:project.url,name:project.name};
}
function gitRoot(repo) {
  const folder=path.resolve(required(repo,"Git 仓库路径"));
  const result=spawnSync("git",["-C",folder,"rev-parse","--show-toplevel"],
    {encoding:"utf8",timeout:8000,windowsHide:true});
  if(result.status!==0 || !result.stdout.trim()) reject("找不到可用 Git 仓库："+folder);
  return path.resolve(result.stdout.trim());
}
async function initialize(opts) {
  await requireOnline();
  const id=runId(opts.run),repo=gitRoot(opts.repo),lead=memberId(opts.lead||"lead");
  const targets=(await api("GET","/v1/targets")).targets;
  const project=projectFromTargets(opts.project,targets);
  const leadChat=opts["lead-chat"]?fixedChatUrl(opts["lead-chat"]):null;
  return locked(id,async(current)=>{
    if(current) reject("协作运行已经存在；不能覆盖已有成员和消息");
    const state={version:1,id,repo,project,lead,createdAt:Date.now(),
      members:{[lead]:{role:"lead",chatUrl:leadChat,joinedAt:Date.now()}},
      messages:[]};
    return {save:true,state,value:{ok:true,id,repo,project,lead}};
  });
}
async function register(opts) {
  await requireOnline();
  const id=runId(opts.run),member=memberId(opts.member),chatUrl=fixedChatUrl(opts.chat);
  return locked(id,async(state)=>{
    if(state.release?.status) reject("协作运行已经进入结束流程，不能新增成员");
    const existing=state.members[member];
    if(existing?.chatUrl && existing.chatUrl!==chatUrl)
      reject("成员已经绑定另一条对话；请使用唯一成员名，不能静默替换");
    state.members[member]={...existing,role:opts.role||existing?.role||"worker",
      chatUrl,joinedAt:existing?.joinedAt||Date.now()};
    return {save:true,state,value:{ok:true,run:id,member,chatUrl}};
  });
}
function workerIntro(run,member,role,task) {
  const executable=path.join(SKILL_ROOT,"team.cjs");
  return [
    "[GPT Queue Agent Team | 子智能体独立任务]",
    "运行标识："+run.id+"；成员："+member+"；角色："+role,
    "Git 仓库："+run.repo,
    "团队项目："+run.project.name,
    "主智能体："+run.lead,
    "任务："+task,
    "",
    "团队协作规定：",
    "1. 先用 HomePC2 执行 node \""+executable+"\" doctor；未通过立即停止本协作。",
    "2. 执行 node \""+executable+"\" sync --run "+run.id+" 注册新对话；通过队列 send 给主智能体报告 PLAN。",
    "3. 每当发现根因、接口变化、阻塞、审查反馈，主动 send 给受影响的团队成员；对收到的消息用 ack --message <消息ID> 表明已知晓，并说明下一步。",
    "4. 仅操作自己授权的 Git 工作树/文件，跨模块契约先交换并确认；完成代码后提供 commit SHA、测试证据、CodeReviewFix 状态。",
    "   未被分配独立 worktree 和文件所有权时，只能调查与沟通，不得和其他成员同时直接修改主工作区。",
    "5. 不能把 queued 当作其他成员已经读懂；不能绕过插件通信门槛，不向未知对话发送；不要等待全部调查才开始独立任务。",
  ].join("\n");
}
async function spawn(opts) {
  await requireOnline();
  const id=runId(opts.run),member=memberId(opts.member),role=required(opts.role,"role");
  const task=messageText({text:opts.task,file:opts.file});
  const run=readRun(id);
  if(run.release?.status) reject("协作运行已经进入结束流程，不能新建子对话");
  if(!run.members[run.lead]?.chatUrl)
    reject("主智能体还未登记对话 URL；请先 register --member "+run.lead+
      " --chat <对话URL>，确保新成员可以双向发送消息");
  if(run.members[member]) reject("成员名已经登记；为避免重复新开对话，请先执行 sync");
  const intro=workerIntro(run,member,role,task);
  if(intro.length>12000) reject("任务开场提示词太长");
  // Reserve locally FIRST. If the HTTP reply is lost, do not spawn again.
  await locked(id,async(state)=>{
    if(state.members[member]) reject("该成员已注册/在创建中");
    state.members[member]={role,chatUrl:null,spawnStatus:"submitting",spawnJobId:null,
      joinedAt:Date.now()};
    return {save:true,state,value:null};
  });
  try {
    const result=await api("POST","/v1/jobs",{
      action:"new_chat",mode:"queue",channel:"team_spawn",runId:id,target:{kind:"project",
        id:run.project.id,url:run.project.url},text:intro,
    });
    await locked(id,async(state)=>{
      state.members[member].spawnJobId=result.job.id;
      state.members[member].spawnStatus=result.job.status;
      return {save:true,state,value:null};
    });
    return {ok:true,run:id,member,spawnJobId:result.job.id,status:result.job.status};
  }catch(error) {
    await locked(id,async(state)=>{
      state.members[member].spawnStatus="review_required";
      state.members[member].error="创建结果未知或失败；为防止重复开页，禁止自动重试";
      return {save:true,state,value:null};
    });
    throw error;
  }
}
async function send(opts) {
  await requireOnline();
  const id=runId(opts.run),from=memberId(opts.from),to=memberId(opts.to);
  const kind=required(opts.type,"type").toUpperCase();
  if(!TYPES.has(kind) || kind==="ACK") reject("消息类型不合法；ACK 请使用 ack 命令");
  const mode=opts.mode||"queue";
  if(!["queue","steer"].includes(mode)) reject("mode 只能是 queue/steer");
  if(mode==="steer" && !opts.urgent)
    reject("steer 会直接引导旧对话，必须显式传 --urgent");
  const content=messageText(opts);
  const ref=opts["reply-to"]||null;
  const messageId=crypto.randomUUID();
  let recipient=null;
  await locked(id,async(state)=>{
    if(state.release?.status) reject("协作运行已结束或正在释放，不能再发送新任务");
    if(!state.members[from]) reject("发件成员未注册："+from);
    if(!state.members[from].chatUrl)
      reject("发件成员尚未获得正式对话 URL；先 sync 确认创建成功再发送消息");
    recipient=state.members[to];
    if(!recipient?.chatUrl) reject("接收成员尚无真实对话 URL；先 sync 或 register");
    state.messages.push({id:messageId,from,to,type:kind,replyTo:ref,
      sentAt:Date.now(),transport:"submitting",jobId:null,ackAt:null});
    return {save:true,state,value:null};
  });
  const header=[
    "[GPT Queue Agent Team | 消息]",
    "RUN: "+id,
    "MSG: "+messageId,
    "FROM: "+from+" / TO: "+to,
    "TYPE: "+kind+(ref?" / REPLY_TO: "+ref:""),
    "请及时回复发送者并 ACK。本机命令：node \""+path.join(SKILL_ROOT,"team.cjs")+
      "\" ack --run "+id+" --from "+to+" --message "+messageId+
      " --text \"已收到，将检查并反馈\"",
    "正文：",content,
  ].join("\n");
  if(header.length>12000) reject("包含消息头后超出插件长度限制");
  try {
    const result=await api("POST","/v1/jobs",{action:"continue",mode,
      ...(mode==="queue"?{channel:"team",runId:id}:{}),
      target:{kind:"chat",url:recipient.chatUrl},text:header});
    await locked(id,async(state)=>{
      const message=state.messages.find(item=>item.id===messageId);
      if(message) {message.transport=result.job.status;message.jobId=result.job.id;}
      return {save:true,state,value:null};
    });
    return {ok:true,run:id,messageId,jobId:result.job.id,transport:result.job.status,
      acknowledgment:"awaiting_explicit_ACK"};
  }catch(error) {
    await locked(id,async(state)=>{
      const message=state.messages.find(item=>item.id===messageId);
      if(message) message.transport="review_required";
      return {save:true,state,value:null};
    });
    throw new Error("发送回执丢失或失败，原消息已标记需核对，绝不自动重发："+error.message);
  }
}
async function acknowledge(opts) {
  await requireOnline();
  const id=runId(opts.run),from=memberId(opts.from);
  const messageId=required(opts.message,"message ID");
  const response=messageText(opts);
  let original=null,sender=null,ackId=null;
  const status=await locked(id,async(state)=>{
    original=state.messages.find(item=>item.id===messageId);
    if(!original) reject("原消息未在本机登记，不能凭空 ACK");
    if(original.to!==from) reject("ACK 只能由消息实际接收成员发送");
    sender=state.members[original.from];
    if(original.ackAt) return {save:false,value:{duplicate:true,ackAt:original.ackAt}};
    original.ackAt=Date.now();original.ackBy=from;
    original.ackResponse=response.slice(0,300);
    original.ackDelivery=sender?.chatUrl?"submitting":"sender_unavailable";
    ackId=crypto.randomUUID();
    original.ackId=ackId;
    return {save:true,state,value:{duplicate:false}};
  });
  if(status.duplicate) return {ok:true,alreadyAcknowledged:true,
    run:id,messageId,ackAt:status.ackAt};
  if(!sender?.chatUrl) return {ok:true,run:id,messageId,ackStored:true,
    senderNotification:"sender_chat_unavailable"};
  const header=[
    "[GPT Queue Agent Team | ACK]",
    "RUN: "+id,"ACK_MSG: "+messageId,
    "FROM: "+from+" / TO: "+original.from,
    "回复："+response,
    "这表示消息已被确认收到，不等于实现/验证工作已经完成。",
  ].join("\n");
  try {
    const result=await api("POST","/v1/jobs",{
      action:"continue",mode:"queue",channel:"team",runId:id,
      target:{kind:"chat",url:sender.chatUrl},
      text:header,
    });
    await locked(id,async(state)=>{
      const item=state.messages.find(item=>item.id===messageId);
      if(item?.ackId===ackId) {
        item.ackDelivery=result.job.status;
        item.ackJobId=result.job.id;
      }
      return {save:true,state,value:null};
    });
    return {ok:true,run:id,messageId,ackStored:true,
      notificationJobId:result.job.id,notificationStatus:result.job.status};
  }catch(error) {
    await locked(id,async(state)=>{
      const item=state.messages.find(item=>item.id===messageId);
      if(item?.ackId===ackId) item.ackDelivery="review_required";
      return {save:true,state,value:null};
    });
    return {ok:true,run:id,messageId,ackStored:true,
      notificationStatus:"review_required",error:error.message};
  }
}
async function sync(opts) {
  await requireOnline();
  const id=runId(opts.run),state=readRun(id);
  const memberChecks=Object.entries(state.members).filter(([,v])=>
    v.spawnJobId && !v.chatUrl);
  const messageChecks=state.messages.filter(item=>item.jobId &&
    !["queued","created","steered","failed","review_required"].includes(item.transport));
  const ackChecks=state.messages.filter(item=>item.ackJobId &&
    !["queued","created","steered","failed","review_required"].includes(item.ackDelivery));
  const found=await Promise.all([...memberChecks.map(async([name,member])=>
    ({category:"member",name,jobId:member.spawnJobId,
      result:(await api("GET","/v1/jobs/"+member.spawnJobId)).job})),
  ...messageChecks.map(async(item)=>({category:"message",name:item.id,jobId:item.jobId,
    result:(await api("GET","/v1/jobs/"+item.jobId)).job})),
  ...ackChecks.map(async(item)=>({category:"ack",name:item.id,jobId:item.ackJobId,
    result:(await api("GET","/v1/jobs/"+item.ackJobId)).job}))]);
  let release=null;
  if(state.release?.status) {
    try {release=(await api("GET","/v1/releases/"+id)).release;}
    catch { /* An unknown status is not proof of completion. */ }
  }
  return locked(id,async(latest)=>{
    for(const item of found) {
      if(item.category==="member") {
        const member=latest.members[item.name];
        if(member?.spawnJobId!==item.jobId) continue;
        member.spawnStatus=item.result.status;
        if(item.result.status==="created" && item.result.chatUrl) {
          const chat=fixedChatUrl(item.result.chatUrl);
          if(projectIdFromUrl(chat)!==latest.project.id)
            reject("新成员对话不属于该项目，已阻止错项目登记");
          member.chatUrl=chat;
        }
      }else {
        const message=latest.messages.find(m=>m.id===item.name);
        if(!message) continue;
        if(item.category==="message" && message.jobId===item.jobId)
          message.transport=item.result.status;
        if(item.category==="ack" && message.ackJobId===item.jobId)
          message.ackDelivery=item.result.status;
      }
    }
    if(release) latest.release={
      ...latest.release,status:release.status,requestId:release.id,
      chats:release.chats,updatedAt:Date.now(),
    };
    return {save:found.length>0 || Boolean(release),state:latest,value:{
      ok:true,run:id,synced:found.length,
      ...(latest.release?{release:latest.release}:{}),
      members:Object.fromEntries(Object.entries(latest.members).map(([name,m])=>
        [name,{role:m.role,chatUrl:m.chatUrl||null,
          ...(m.spawnStatus?{spawnStatus:m.spawnStatus}:{})}])),
    }};
  });
}

function assertTeamFinished(state) {
  const members=Object.entries(state.members).filter(([name])=>name!==state.lead);
  if(!members.length) reject("没有可以结束的子智能体成员");
  if(!Object.values(state.members).every(member=>Boolean(member.chatUrl) &&
      (!member.spawnJobId || member.spawnStatus==="created")))
    reject("仍有成员未创建成功，不允许释放聊天窗口");
  if(state.messages.some(message=>!message.ackAt ||
      !["queued","steered"].includes(message.transport) ||
      message.ackDelivery!=="queued"))
    reject("仍有消息未 ACK、未完成入队或回复通知尚未确认");
  for(const [name] of members) {
    if(!state.messages.some(message=>message.from===name && message.to===state.lead &&
        ["READY","VERIFIED"].includes(message.type) && message.ackAt))
      reject("成员 "+name+" 未报告并确认 READY/VERIFIED，不允许结束团队");
  }
}

async function finish(opts) {
  await requireOnline();
  const id=runId(opts.run);
  if(opts.verified!==true)
    reject("只有主智能体完成集成、CodeReviewFix 与测试后才能显式 --verified 释放窗口");
  await sync({run:id});
  const state=readRun(id);
  assertTeamFinished(state);
  const chats=[...new Set(Object.values(state.members).map(m=>fixedChatUrl(m.chatUrl)))];
  await locked(id,async(latest)=>{
    if(latest.release?.status && latest.release.status!=="submitting")
      return {save:false,value:null};
    latest.release={...latest.release,status:"submitting",submittedAt:Date.now()};
    return {save:true,state:latest,value:null};
  });
  try {
    // Idempotent per run. A lost HTTP reply never causes arbitrary extra
    // releases; the bridge will return the existing run-scoped request.
    const result=(await api("POST","/v1/releases",{runId:id,chats})).release;
    await locked(id,async(latest)=>{
      latest.release={status:result.status,requestId:result.id,
        chats:result.chats,updatedAt:Date.now()};
      return {save:true,state:latest,value:null};
    });
    return {ok:true,run:id,release:result,
      note:"仅安全释放插件创建且队列已清空的后台标签；用户标签不会关闭"};
  }catch(error) {
    // Preserve the uncertain request and forbid new team work until the
    // original run-scoped request has been inspected.
    throw new Error("释放结果暂时未知；保留 submitting 状态，请运行 sync 核对："+error.message);
  }
}
function conciseRun(state) {
  const messages=state.messages;
  const unacked=messages.filter(item=>!item.ackAt);
  return {ok:true,run:state.id,repo:state.repo,project:state.project,
    ...(state.release?{release:state.release}:{}),
    members:Object.fromEntries(Object.entries(state.members).map(([name,member])=>
      [name,{role:member.role,chatUrl:member.chatUrl||null,
        ...(member.spawnStatus?{spawnStatus:member.spawnStatus}:{})}])),
    counts:{totalMessages:messages.length,unacknowledged:unacked.length,
      pendingTransport:messages.filter(m=>!["queued","steered"].includes(m.transport)).length},
    unacked:unacked.map(m=>({id:m.id,from:m.from,to:m.to,type:m.type,
      transport:m.transport,sentAt:m.sentAt,jobId:m.jobId})).slice(-60),
    recent:messages.slice(-30).map(m=>({id:m.id,from:m.from,to:m.to,type:m.type,
      transport:m.transport,ackAt:m.ackAt||null,
      ackDelivery:m.ackDelivery||null})),
  };
}
function inbox(opts) {
  const state=readRun(runId(opts.run)),who=memberId(opts.member);
  if(!state.members[who]) reject("成员不存在："+who);
  return {ok:true,run:state.id,member:who,messages:state.messages
    .filter(m=>m.to===who && !m.ackAt)
    .map(m=>({id:m.id,from:m.from,type:m.type,transport:m.transport,
      sentAt:m.sentAt,replyTo:m.replyTo||null}))};
}
function help() {
  return [
    "GPT 队列协作（仅当扩展在线）:",
    "  node team.cjs doctor",
    "  node team.cjs install | uninstall",
    "  node team.cjs init --run <标识> --repo <Git路径> --project <已绑定项目> [--lead lead --lead-chat <URL>]",
    "  node team.cjs spawn --run <标识> --member <成员> --role <职责> --task <描述>",
    "  node team.cjs sync --run <标识>",
    "  node team.cjs register --run <标识> --member <成员> --chat <会话URL> [--role <职责>]",
    "  node team.cjs send --run <标识> --from <成员> --to <成员> --type <消息类型> --text <正文>",
    "  node team.cjs ack --run <标识> --from <接收者> --message <消息ID> --text <确认>",
    "  node team.cjs inbox --run <标识> --member <成员>",
    "  node team.cjs status --run <标识>",
    "  node team.cjs finish --run <标识> --verified 由主智能体完成审查与测试后安全释放后台聊天标签",
    "  send 可指定 --mode steer --urgent；正文可用 --file <UTF-8文件>；状态不明不自动重发。",
  ].join("\n");
}
async function main(args) {
  const command=args[0]||"help",opts=options(args.slice(1));
  if(command==="help") return {help:help()};
  if(command==="doctor") return doctor();
  if(command==="install") return install();
  if(command==="uninstall") return uninstall();
  await requireOnline();
  if(command==="init") return initialize(opts);
  if(command==="register") return register(opts);
  if(command==="spawn") return spawn(opts);
  if(command==="sync") return sync(opts);
  if(command==="send") return send(opts);
  if(command==="ack") return acknowledge(opts);
  if(command==="inbox") return inbox(opts);
  if(command==="status") return conciseRun(readRun(runId(opts.run)));
  if(command==="finish") return finish(opts);
  reject("未知命令，请运行 help");
}
if(require.main===module) main(process.argv.slice(2)).then(output=>{
  process.stdout.write(output.help||JSON.stringify(output,null,2)+"\n");
  if(output.ok===false) process.exitCode=2;
}).catch(error=>{
  process.stderr.write("GPT 队列协作失败："+error.message+"\n");
  process.exitCode=1;
});
module.exports={doctor,installedHere,install,uninstall,initialize,register,spawn,
  send,acknowledge,sync,finish,assertTeamFinished,
  conciseRun,inbox,readRun,projectFromTargets,main};
