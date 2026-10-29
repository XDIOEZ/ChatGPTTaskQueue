#!/usr/bin/env node
"use strict";

// ChatGPT Queue 本机任务桥接器：AI/CLI 提交任务，浏览器扩展安全领取。
// 只绑定 IPv4 loopback，控制接口需要本机随机令牌，不公开在局域网。
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const crypto = require("node:crypto");
const {spawn,spawnSync} = require("node:child_process");

const HOST = "127.0.0.1";
const PORT = Number(process.env.CQ_BRIDGE_PORT) || 43578;
const ROOT = process.env.CQ_BRIDGE_DATA_DIR ||
  path.join(process.env.LOCALAPPDATA || path.join(os.homedir(),"AppData","Local"),
    "ChatGPTTaskQueue","remote-bridge");
const TOKEN_FILE = path.join(ROOT,"agent-token");
const EXTENSION_ID_FILE = path.join(ROOT,"paired-extension-id");
const DATA_FILE = path.join(ROOT,"jobs.json");
const MAX_JOBS = 300;
// Align with the extension's requireText limit; never accept a job it cannot send.
const MAX_TEXT = 12000;
const TERMINAL = new Set(["queued","steered","created","failed","review_required","cancelled"]);
const RELEASE_RUN_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{2,63}$/;
const RELEASE_OUTCOMES = new Set(["closed","deferred","skipped"]);
const EXTENSION_HEADER = "chatgpt-task-queue-extension-v1";

function fail(message,code=400) {
  const error = new Error(message);
  error.status = code;
  throw error;
}
function ensureRoot() { fs.mkdirSync(ROOT,{recursive:true}); }
function token() {
  ensureRoot();
  if (!fs.existsSync(TOKEN_FILE)) fs.writeFileSync(TOKEN_FILE,
    crypto.randomBytes(32).toString("hex"),{mode:0o600,flag:"wx"});
  return fs.readFileSync(TOKEN_FILE,"utf8").trim();
}
function emptyStore() {
  return {version:1,jobs:[],targets:[],targetsAt:null,bindings:[],releases:[]};
}
function load() {
  ensureRoot();
  if (!fs.existsSync(DATA_FILE)) return emptyStore();
  const data = JSON.parse(fs.readFileSync(DATA_FILE,"utf8"));
  if (data.version!==1 || !Array.isArray(data.jobs) || !Array.isArray(data.targets))
    fail("桥接器数据格式不兼容，已停止以免覆盖数据",500);
  if (!Array.isArray(data.bindings)) data.bindings=[];
  if (!Array.isArray(data.releases)) data.releases=[];
  return data;
}
function save(data) {
  ensureRoot();
  const tmp = DATA_FILE+"."+process.pid+".tmp";
  fs.writeFileSync(tmp,JSON.stringify(data,null,2),{mode:0o600});
  fs.renameSync(tmp,DATA_FILE);
}
function checkOrigin(req) {
  // 网页不能伪造自定义请求头（会触发被拒绝的 CORS 预检）。
  const origin = req.headers.origin;
  if (origin && !/^chrome-extension:\/\/[a-z]{32}$/.test(origin))
    fail("拒绝网页跨域访问本机桥接器",403);
}
function cors(res,req) {
  if (/^chrome-extension:\/\/[a-z]{32}$/.test(req.headers.origin||"")) {
    res.setHeader("Access-Control-Allow-Origin",req.headers.origin);
    res.setHeader("Vary","Origin");
    res.setHeader("Access-Control-Allow-Methods","GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers","Content-Type, X-CQ-Extension, X-CQ-Extension-Id");
    res.setHeader("Access-Control-Max-Age","600");
  }
}
function requireExtension(req) {
  checkOrigin(req);
  if (req.headers["x-cq-extension"]!==EXTENSION_HEADER) fail("扩展身份标记无效",403);
  const claimed=String(req.headers["x-cq-extension-id"]||"");
  if (!/^[a-z]{32}$/.test(claimed)) fail("浏览器扩展 ID 无效",403);
  if (req.headers.origin && req.headers.origin!== "chrome-extension://"+claimed)
    fail("扩展 ID 与浏览器来源不一致",403);
  ensureRoot();
  if(!fs.existsSync(EXTENSION_ID_FILE))
    fs.writeFileSync(EXTENSION_ID_FILE,claimed,{mode:0o600,flag:"wx"});
  else if(fs.readFileSync(EXTENSION_ID_FILE,"utf8").trim()!==claimed)
    fail("请求来自其他浏览器扩展，已拒绝",403);
}
function requireAgent(req) {
  if (req.headers.origin) fail("本机控制接口不接受浏览器网页访问",403);
  const supplied = String(req.headers.authorization||"").replace(/^Bearer\s+/i,"");
  const expected=token();
  if (Buffer.byteLength(supplied)!==Buffer.byteLength(expected) ||
      !crypto.timingSafeEqual(Buffer.from(supplied),Buffer.from(expected)))
    fail("访问令牌无效",401);
}
function readJson(req,max=MAX_TEXT*4+8192) {
  return new Promise((resolve,reject)=>{
    const chunks=[]; let size=0;
    req.on("data",chunk=>{
      size+=chunk.length;
      if(size>max){reject(Object.assign(new Error("请求数据过大"),{status:413}));req.destroy();return;}
      chunks.push(chunk);
    });
    req.on("end",()=>{try{resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));}catch{reject(Object.assign(new Error("JSON 格式无效"),{status:400}));}});
    req.on("error",reject);
  });
}
function validateJob(input) {
  if (!input || typeof input!=="object" || Array.isArray(input)) fail("任务必须是对象");
  const action=input.action;
  if (!["continue","new_chat"].includes(action)) fail("action 只能是 continue 或 new_chat");
  if (typeof input.text!=="string" || !input.text.trim() || input.text.length>MAX_TEXT)
    fail("任务内容不能为空且最多 12000 字符");
  const target=input.target;
  if (!target || typeof target!=="object" || Array.isArray(target))
    fail("请指定 target 对象");
  if ((action==="continue" && target.kind!=="chat") ||
      (action==="new_chat" && !["project","personal"].includes(target.kind)))
    fail("已有对话用 chat，新建对话用 project 或 personal");
  const selector=target.id||target.url||target.name;
  if (typeof selector!=="string" || !selector.trim() || selector.length>512)
    fail("必须提供 target.id / target.url / target.name");
  if (target.url && (!/^https:\/\/chatgpt\.com\//.test(target.url) &&
      !/^https:\/\/chat\.openai\.com\//.test(target.url)))
    fail("只允许官方 ChatGPT 地址");
  if (target.kind==="personal") {
    if (target.id && target.id!=="personal") fail("普通新对话的 ID 必须是 personal");
    if (target.url) {
      const parsed=new URL(target.url);
      if (parsed.pathname!=="/" || parsed.search || parsed.hash)
        fail("普通新对话必须使用 ChatGPT 首页地址");
    }
  }
  const mode=input.mode || "queue";
  if (!["queue","steer"].includes(mode) || (action==="new_chat" && mode!=="queue"))
    fail("新对话仅支持 queue；已有对话支持 queue / steer");
  const channel=input.channel||"job";
  if (!["job","team","team_spawn"].includes(channel) ||
      (channel==="team" && (action!=="continue" || mode!=="queue")) ||
      (channel==="team_spawn" && (action!=="new_chat" || mode!=="queue")))
    fail("channel 类型不合法：team 用于已有对话消息，team_spawn 用于团队新对话");
  if(input.captureResult!=null && typeof input.captureResult!=="boolean")
    fail("captureResult 必须是布尔值");
  if(input.captureResult===true && (channel!=="job" || mode!=="queue"))
    fail("只有普通队列任务可以请求完成结果");
  const runId=input.runId;
  if(runId!=null && (!RELEASE_RUN_PATTERN.test(runId) || channel==="job"))
    fail("只有协作消息可以包含合法 runId");
  return {action,text:input.text,target:{
    kind:target.kind,...(target.id?{id:target.id}:{}),
    ...(target.url?{url:target.url}:{}),...(target.name?{name:target.name}:{})
  },mode,...(channel!=="job"?{channel}:{}),
    ...(input.captureResult===true?{captureResult:true}:{}),
    ...(runId?{runId}:{})};
}
function publicJob(job) {
  const {id,action,target,mode,status,createdAt,updatedAt,attempts,tabId,taskId,chatUrl,error,
    openIntent,sendIntent,channel,runId,captureResult,completionStatus,replyText,resultError,replyTruncated,resultDiagnostic,confirmationDiagnostic}=job;
  return {id,action,target,mode,status,createdAt,updatedAt,attempts,
    ...(tabId?{tabId}:{}),...(taskId?{taskId}:{}),
    ...(chatUrl?{chatUrl}:{}),...(error?{error}:{}),
    ...(channel?{channel}:{}),...(runId?{runId}:{}),...(captureResult?{captureResult:true}:{}),
    ...(completionStatus?{completionStatus}:{}),
    ...(typeof replyText==="string"?{replyText}:{}),
    ...(resultError?{resultError}:{}),...(replyTruncated?{replyTruncated:true}:{}),
    ...(resultDiagnostic?{resultDiagnostic}:{}),
    ...(confirmationDiagnostic?{confirmationDiagnostic}:{}),
    ...(openIntent===true?{openIntent:true}:{}),
    ...(sendIntent===true?{sendIntent:true}:{})};
}
function makeJob(input,now=Date.now()) {
  const payload=validateJob(input);
  const requestId=input.clientRequestId;
  if(requestId!=null && (typeof requestId!=="string" ||
      !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(requestId)))
    fail("clientRequestId 必须是 UUID");
  const submissionHash=requestId ? crypto.createHash("sha256")
    .update(JSON.stringify(payload)).digest("hex") : null;
  return {...payload,id:requestId||crypto.randomUUID(),
    ...(submissionHash?{submissionHash}:{}),status:"pending",
    createdAt:now,updatedAt:now,attempts:0,leaseUntil:0};
}

function safeResultDiagnostic(value) {
  if(!value || typeof value!=="object" || Array.isArray(value)) return null;
  const allowedReasons=["ok","no_capture","last_role","no_user_baseline","user_count",
    "user_folded","user_mismatch","assistant_text_missing","assistant_not_new","background_rejected"];
  const result={reason:allowedReasons.includes(value.reason)?value.reason:"background_rejected"};
  if(["user","assistant","other"].includes(value.lastRole)) result.lastRole=value.lastRole;
  for(const key of ["baselineUserCount","userCount","baselineAssistantCount","assistantCount","assistantTextLength"])
    if(Number.isInteger(value[key]) && value[key]>=0 && value[key]<=1000000) result[key]=value[key];
  for(const key of ["userFolded","userMatches","newerId","newerCount","boundHere","chatRoute","recentSubmission"])
    if(typeof value[key]==="boolean") result[key]=value[key];
  return result;
}

function recordCompletion(job, input, now=Date.now()) {
  if(!input || input.id!==job.id || typeof input.taskId!=="string" ||
      !input.taskId || input.taskId.length>=128 ||
      !["completed","result_unavailable"].includes(input.completionStatus))
    fail("完成结果格式无效");
  if(job.captureResult!==true) fail("该任务未请求收集结果",409);
  if(job.taskId && job.taskId!==input.taskId) fail("完成结果与队列任务不匹配",409);
  if(input.completionStatus==="completed" &&
      (typeof input.replyText!=="string" || !input.replyText.trim() || input.replyText.length>20000))
    fail("完成结果正文无效");
  if(input.completionStatus==="result_unavailable" && input.replyText!=null)
    fail("无法确认的结果不能包含正文");
  const normalized={completionStatus:input.completionStatus,
    ...(input.completionStatus==="completed"?{replyText:input.replyText}:{}),
    ...(input.replyTruncated===true?{replyTruncated:true}:{}),
    ...(input.completionStatus==="result_unavailable"?{resultError:
      typeof input.resultError==="string" && input.resultError.trim()
        ? input.resultError.slice(0,350) : "无法确认最终回复属于该任务，请查看对应对话。",
      ...(safeResultDiagnostic(input.resultDiagnostic)?
        {resultDiagnostic:safeResultDiagnostic(input.resultDiagnostic)}:{})}:{})};
  if(job.completionStatus) {
    for(const [key,value] of Object.entries(normalized))
      if(JSON.stringify(job[key])!==JSON.stringify(value)) fail("该任务已有不同的完成结果",409);
    return publicJob(job);
  }
  job.taskId ||= input.taskId;
  Object.assign(job,normalized);
  if(typeof input.chatUrl==="string" && /^https:\/\/chatgpt\.com\//.test(input.chatUrl))
    job.chatUrl=input.chatUrl;
  job.updatedAt=now;
  return publicJob(job);
}

function releaseChatUrl(value) {
  if (typeof value!=="string") fail("释放目标必须是 ChatGPT 对话地址");
  let parsed;
  try {parsed=new URL(value);}catch {fail("无效的对话地址");}
  if(parsed.protocol!=="https:" ||
      !["chatgpt.com","chat.openai.com"].includes(parsed.hostname))
    fail("只能释放 ChatGPT 官方对话");
  const match=parsed.pathname.match(/(?:^|\/)c\/([a-zA-Z0-9-]+)\/?$/);
  if(!match) fail("释放目标必须是已建立的聊天，而不是项目主页");
  return {id:match[1],url:parsed.origin+parsed.pathname.replace(/\/+$/,"")};
}
function createReleaseRequest(store,input,now=Date.now()) {
  if(!input || !RELEASE_RUN_PATTERN.test(input.runId||"")) fail("协作 runId 无效");
  if(!Array.isArray(input.chats) || !input.chats.length || input.chats.length>30)
    fail("释放需提供 1～30 个明确的协作对话 URL");
  const chats=input.chats.map(releaseChatUrl);
  if(new Set(chats.map(c=>c.id)).size!==chats.length)
    fail("协作释放目标存在重复聊天");
  const existing=store.releases.find(r=>r.runId===input.runId);
  if(existing) {
    if(JSON.stringify(existing.chats.map(c=>c.id).sort())!==
      JSON.stringify(chats.map(c=>c.id).sort()))
      fail("同一 run 的释放目标已固定，拒绝改变目标",409);
    return existing;
  }
  if(store.releases.length>=200) fail("释放请求已满，请先检查已完成记录",409);
  const request={id:crypto.randomUUID(),runId:input.runId,
    createdAt:now,updatedAt:now,leaseUntil:0,attempts:0,
    status:"pending",chats:chats.map(c=>({...c,status:"pending"}))};
  store.releases.push(request);
  return request;
}
function claimReleaseRequest(store,now=Date.now()) {
  const request=store.releases.find(r=>r.status==="pending" && r.leaseUntil<=now);
  if(!request) return null;
  if(request.attempts>=25 || now-request.createdAt>24*60*60*1000) {
    request.status="review_required";
    request.updatedAt=now;
    request.chats.forEach(c=>{
      if(c.status==="pending"){c.status="review_required";c.reason="超出安全重试次数";}
    });
    return null;
  }
  request.attempts++;
  request.leaseUntil=now+90000;
  const selected=request.chats.filter(c=>c.status==="pending")
    .sort((a,b)=>(a.lastTriedAt||0)-(b.lastTriedAt||0))
    .slice(0,5);
  for(const chat of selected) chat.lastTriedAt=now;
  return {id:request.id,runId:request.runId,
    chats:selected.map(c=>({id:c.id,url:c.url})),
    attempts:request.attempts};
}
function reportReleaseRequest(store,input,now=Date.now()) {
  const request=store.releases.find(r=>r.id===input?.id);
  if(!request) fail("协作释放请求不存在",404);
  if(!Array.isArray(input.results) || input.results.length>30)
    fail("释放结果格式错误");
  for(const result of input.results) {
    if(!result || !RELEASE_OUTCOMES.has(result.status)) fail("释放状态错误");
    const chat=request.chats.find(c=>c.id===result.id);
    if(!chat) fail("不能回报其他协作运行的聊天");
    if(chat.status!=="pending") continue;
    if(result.status==="deferred") {
      chat.reason=String(result.reason||"等待任务结束").slice(0,180);
    }else {
      chat.status=result.status;
      chat.reason=String(result.reason||"").slice(0,180);
    }
  }
  request.updatedAt=now;
  if(request.chats.every(c=>c.status!=="pending")) {
    request.status="finished";
    request.leaseUntil=Number.MAX_SAFE_INTEGER;
  }else {
    request.status="pending";
    request.leaseUntil=now+60000;
  }
  return request;
}
function publicRelease(request) {
  return {id:request.id,runId:request.runId,status:request.status,
    createdAt:request.createdAt,updatedAt:request.updatedAt,
    attempts:request.attempts,chats:request.chats.map(c=>({
      id:c.id,url:c.url,status:c.status,...(c.reason?{reason:c.reason}:{})
    }))};
}
function cancelUnclaimedJobs(store,ids,now=Date.now()) {
  if (!Array.isArray(ids) || !ids.length || ids.length>300 ||
      ids.some(id=>typeof id!=="string" ||
        !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(id)) ||
      new Set(ids).size!==ids.length) fail("取消请求必须包含 1～300 个不重复的 UUID");
  const cancelled=[],skipped=[];
  for(const id of ids) {
    const job=store.jobs.find(x=>x.id===id);
    if(!job) {skipped.push({id,reason:"not_found"});continue;}
    // Never cancel a leased/attempted job: the browser might have saved it
    // even if its acknowledgement is missing.
    if(job.status!=="pending" || job.attempts!==0 ||
        job.openIntent===true || job.sendIntent===true) {
      skipped.push({id,reason:"claimed_or_terminal",status:job.status,
        attempts:job.attempts});continue;
    }
    job.status="cancelled";
    job.updatedAt=now;
    job.leaseUntil=Number.MAX_SAFE_INTEGER;
    job.error="测试任务在扩展领取之前已取消；不会被自动发送";
    cancelled.push(id);
  }
  return {cancelled,skipped};
}
function quarantineUncertainJobs(store,ids,now=Date.now()) {
  if (!Array.isArray(ids) || !ids.length || ids.length>300 ||
      ids.some(id=>typeof id!=="string" ||
        !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(id)) ||
      new Set(ids).size!==ids.length) fail("隔离请求必须包含 1～300 个不重复的 UUID");
  const quarantined=[],skipped=[];
  for(const id of ids) {
    const job=store.jobs.find(x=>x.id===id);
    if(!job) {skipped.push({id,reason:"not_found"});continue;}
    // A leased or already-sent message must not be represented as cancelled.
    // Only an expired, attempted, still-unconfirmed dispatch can be quarantined.
    if(job.status!=="pending" || job.attempts<1 || job.leaseUntil>now) {
      skipped.push({id,reason:"not_expired_or_terminal",status:job.status,
        attempts:job.attempts});continue;
    }
    job.status="review_required";
    job.updatedAt=now;
    job.leaseUntil=Number.MAX_SAFE_INTEGER;
    job.error="该消息可能已经发送但没有回执；停止自动重试，请人工核对对话";
    quarantined.push(id);
  }
  return {quarantined,skipped};
}
function normalizeTarget(target) {
  if (!target || typeof target!=="object" || !["chat","project"].includes(target.kind) ||
      typeof target.name!=="string" || !target.name.trim() || target.name.length>100 ||
      typeof target.url!=="string") fail("目标别名格式无效");
  let parsed;
  try {
    parsed=new URL(target.url);
    if (parsed.protocol!=="https:" ||
        !["chatgpt.com","chat.openai.com"].includes(parsed.hostname)) fail("目标地址必须属于 ChatGPT");
  } catch { fail("目标地址无效"); }
  const pathname=parsed.pathname.replace(/\/+$/,"");
  const chat=/\/c\/([a-zA-Z0-9-]+)$/.exec(pathname);
  const project=/^\/g\/(g-p-[a-zA-Z0-9-]+)(?:\/project|\/c\/[a-zA-Z0-9-]+)?$/.exec(pathname);
  if (target.kind==="chat" && !chat || target.kind==="project" && !project)
    fail("目标地址与对话/项目类型不匹配");
  const originalId=target.kind==="chat" ? chat[1] : project[1];
  const id=target.kind==="project"
    ? (originalId.match(/^(g-p-[a-f0-9]{32})(?:-[a-z0-9-]+)?$/i)?.[1]||originalId)
    : originalId;
  return {kind:target.kind,name:target.name.trim(),
    url:target.kind==="project" ? parsed.origin+"/g/"+id+"/project" :
      parsed.origin+pathname,id};
}
function mergedTargets(store) {
  const merged=new Map();
  for(const target of store.targets) merged.set(target.kind+":"+target.id,target);
  for(const binding of store.bindings) {
    const key=binding.kind+":"+binding.id;
    merged.set(key,{...(merged.get(key)||{}),...binding,
      name:binding.name,alias:binding.name});
  }
  return [...merged.values()];
}
function applyKnownTarget(job,store) {
  const field=job.target;
  const selector=field.url||field.id||field.name;
  const matches=mergedTargets(store).filter(t=>t.kind===field.kind && [
    t.url,t.id,t.name,t.alias,
  ].some(s=>typeof s==="string" && s.toLocaleLowerCase()===selector.toLocaleLowerCase()));
  if(matches.length>1) fail("目标名称对应多个对话，请提供唯一 ID 或 URL",409);
  if(matches.length===1) {
    job.target.id=matches[0].id;
    job.target.url=matches[0].url;
    if(!job.target.name) job.target.name=matches[0].name;
  }
}
function dispatchNext(store,now=Date.now()) {
  // Fair polling: a slow/loading ChatGPT tab must not starve new jobs forever.
  const job=store.jobs.filter(x=>!TERMINAL.has(x.status) && x.leaseUntil<=now)
    .sort((a,b)=>(a.lastPolledAt||0)-(b.lastPolledAt||0) ||
      a.createdAt-b.createdAt)[0];
  if (!job) return null;
  if (job.attempts>=90) {
    job.status="review_required";
    job.error="桥接器多次未能收到扩展确认，请人工核对；为防止重复发送已停止自动尝试";
    job.updatedAt=now;
    return null;
  }
  job.leaseUntil=now+90000;
  job.lastPolledAt=now;
  job.attempts++;
  job.updatedAt=now;
  return {...publicJob(job),text:job.text};
}
function updateJob(job,result,now=Date.now()) {
  if (!result || !["opening","waiting","queued","steered","created","failed","review_required"].includes(result.status))
    fail("无效的任务回报状态");
  if (TERMINAL.has(job.status)) return publicJob(job);
  job.status=result.status;
  job.updatedAt=now;
  job.leaseUntil=TERMINAL.has(result.status)?Number.MAX_SAFE_INTEGER:now+15000;
  if (Number.isInteger(result.tabId) && result.tabId>0) job.tabId=result.tabId;
  // The intent is durable BEFORE opening a tab or starting native steering.
  // A lost response may pause one job, but must never spawn/send it twice.
  if (result.openIntent===true) job.openIntent=true;
  if (result.sendIntent===true) job.sendIntent=true;
  if (typeof result.chatUrl==="string" && /^https:\/\/chatgpt\.com\//.test(result.chatUrl))
    job.chatUrl=result.chatUrl;
  if (typeof result.taskId==="string" && result.taskId.length<128) job.taskId=result.taskId;
  if (typeof result.error==="string") job.error=result.error.slice(0,350);
  else if(TERMINAL.has(result.status)) delete job.error;
  if(job.captureResult===true && result.confirmationDiagnostic &&
      typeof result.confirmationDiagnostic==="object" && !Array.isArray(result.confirmationDiagnostic)) {
    const safe={};
    for(const key of ["boundHere","chatRoute","userMatches","recentSubmission"])
      if(typeof result.confirmationDiagnostic[key]==="boolean") safe[key]=result.confirmationDiagnostic[key];
    for(const key of ["userCount","domUserCount"]) {
      const count=result.confirmationDiagnostic[key];
      if(Number.isInteger(count) && count>=0 && count<=1000000) safe[key]=count;
    }
    const shapes=result.confirmationDiagnostic.userNodeShapes;
    if(Array.isArray(shapes)) safe.userNodeShapes=shapes.slice(0,5).map(shape=>({
      ...Object.fromEntries(["inMain","visible","hasId","sameIdAsLast","sameTextAsLast",
        "sameContainerAsLast","sameOwnerAsLast"].filter(key=>typeof shape?.[key]==="boolean")
        .map(key=>[key,shape[key]])),
      path:Array.isArray(shape?.path)?shape.path.slice(0,10).map(part=>({
        tag:["div","section","article","main","h1","h2","h3","h4","h5","h6","span","p","other"]
          .includes(part?.tag)?part.tag:"other",
        mask:Number.isInteger(part?.mask) && part.mask>=0 && part.mask<1024?part.mask:0,
      })):[],
    }));
    job.confirmationDiagnostic=safe;
  }
  return publicJob(job);
}
function output(res,code,data) {
  const bytes=Buffer.from(JSON.stringify(data));
  res.writeHead(code,{"Content-Type":"application/json; charset=utf-8",
    "Cache-Control":"no-store","Content-Length":bytes.length,
    "X-Content-Type-Options":"nosniff"});
  res.end(bytes);
}
function makeServer() {
  // HTTP request handlers are deliberately short; all queue mutations are
  // serialized in this single local process and persisted before acknowledging.
  return http.createServer(async(req,res)=>{
    try {
      const url=new URL(req.url,"http://"+HOST+":"+PORT);
      cors(res,req);
      if (req.method==="OPTIONS") {
        checkOrigin(req);
        if (!url.pathname.startsWith("/v1/extension/")) fail("CORS 不允许",403);
        res.writeHead(204);res.end();return;
      }
      if (req.method==="GET" && url.pathname==="/health") {
        const store=load();
        return output(res,200,{ok:true,service:"chatgpt-task-queue-bridge",
          version:3,features:["extension_version","team_channels","safe_tab_release",
            "idempotent_submission","completion_results"],
          extensionVersion:store.extensionVersion||null,extensionUpdatedAt:store.targetsAt||null});
      }
      if (url.pathname.startsWith("/v1/extension/")) {
        requireExtension(req);
        if(req.method==="POST" && url.pathname==="/v1/extension/results/report") {
          const message=await readJson(req,100000),store=load();
          const job=store.jobs.find(x=>x.id===message.id);
          if(!job) fail("任务不存在",404);
          const result=recordCompletion(job,message);
          save(store);
          return output(res,200,{ok:true,job:result});
        }
        if(req.method==="GET" && url.pathname==="/v1/extension/releases/poll") {
          const store=load(),request=claimReleaseRequest(store);
          if(request || store.releases.some(r=>r.status==="review_required")) save(store);
          return output(res,200,{ok:true,request});
        }
        if(req.method==="POST" && url.pathname==="/v1/extension/releases/report") {
          const message=await readJson(req,6500),store=load();
          const request=reportReleaseRequest(store,message);
          save(store);
          return output(res,200,{ok:true,release:publicRelease(request)});
        }
        if (req.method==="GET" && url.pathname==="/v1/extension/poll") {
          const store=load(); const job=dispatchNext(store);
          // dispatchNext may mark an exhausted job review_required without
          // returning it. Persist that safety state as well.
          save(store);
          return output(res,200,{ok:true,job});
        }
        if (req.method==="POST" && url.pathname==="/v1/extension/report") {
          const message=await readJson(req,3000),store=load();
          const job=store.jobs.find(x=>x.id===message.id);
          if(!job) fail("任务不存在",404);
          const result=updateJob(job,message);
          save(store);
          return output(res,200,{ok:true,job:result});
        }
        if (req.method==="POST" && url.pathname==="/v1/extension/targets") {
          const data=await readJson(req,160000);
          if (!Array.isArray(data.targets) || data.targets.length>500) fail("目标列表无效");
          const store=load();
          // A live browser version proof prevents a new Skill from silently
          // relying on an obsolete extension which lacks team channel reuse.
          store.extensionVersion=typeof data.version==="string" &&
            /^\d{1,4}(?:\.\d{1,4}){2,3}$/.test(data.version)
            ? data.version:null;
          store.targets=data.targets.filter(t=>t && ["chat","project"].includes(t.kind) &&
            typeof t.id==="string" && t.id.length<200 &&
            typeof t.url==="string" && t.url.length<600).map(t=>({
              kind:t.kind,id:t.id,url:t.url,
              name:String(t.name||"").slice(0,200),
              ...(Number.isInteger(t.tabId)?{tabId:t.tabId}:{}),
              ...(t.alias?{alias:String(t.alias).slice(0,200)}:{}),
              ...(t.open===false?{open:false}:{open:true})
            }));
          store.targetsAt=Date.now();
          save(store);
          return output(res,200,{ok:true,count:store.targets.length});
        }
        fail("扩展接口不存在",404);
      }
      requireAgent(req);
      if(req.method==="POST" && url.pathname==="/v1/releases") {
        const input=await readJson(req,10000),store=load();
        const request=createReleaseRequest(store,input);
        save(store);
        return output(res,200,{ok:true,release:publicRelease(request)});
      }
      const releaseLookup=url.pathname.match(/^\/v1\/releases\/([a-zA-Z0-9_-]{3,64})$/);
      if(req.method==="GET" && releaseLookup) {
        const request=load().releases.find(r=>r.runId===releaseLookup[1]);
        if(!request) fail("协作释放请求不存在",404);
        return output(res,200,{ok:true,release:publicRelease(request)});
      }
      if (req.method==="POST" && url.pathname==="/v1/jobs/cancel-unclaimed") {
        const body=await readJson(req,18000);
        const store=load();
        const result=cancelUnclaimedJobs(store,body?.ids);
        if(result.cancelled.length) save(store);
        return output(res,200,{ok:true,...result});
      }
      if (req.method==="POST" && url.pathname==="/v1/jobs/quarantine-uncertain") {
        const body=await readJson(req,18000);
        const store=load();
        const result=quarantineUncertainJobs(store,body?.ids);
        if(result.quarantined.length) save(store);
        return output(res,200,{ok:true,...result});
      }
      if (req.method==="POST" && url.pathname==="/v1/jobs") {
        const store=load();
        const item=makeJob(await readJson(req));
        const existing=store.jobs.find(j=>j.id===item.id);
        if(existing) {
          if(!item.submissionHash || existing.submissionHash!==item.submissionHash)
            fail("同一请求 ID 对应了不同任务",409);
          return output(res,200,{ok:true,job:publicJob(existing)});
        }
        applyKnownTarget(item,store);
        // Never silently delete pending work just to accept one more task.
        if(store.jobs.filter(j=>!TERMINAL.has(j.status)).length>=MAX_JOBS)
          fail("待处理任务数量已满",409);
        store.jobs.push(item);
        if(store.jobs.length>MAX_JOBS*2) {
          const awaiting=j=>Boolean(j.submissionHash && !j.completionStatus &&
            !["failed","review_required","cancelled"].includes(j.status));
          const recent=store.jobs.filter(j=>TERMINAL.has(j.status) && !awaiting(j)).slice(-MAX_JOBS);
          store.jobs=[...store.jobs.filter(j=>!TERMINAL.has(j.status) || awaiting(j)),...recent]
            .sort((a,b)=>a.createdAt-b.createdAt);
        }
        save(store);return output(res,201,{ok:true,job:publicJob(item)});
      }
      if(req.method==="GET" && url.pathname==="/v1/targets") {
        const store=load();
        return output(res,200,{ok:true,targets:mergedTargets(store),updatedAt:store.targetsAt});
      }
      if(req.method==="POST" && url.pathname==="/v1/bindings") {
        const binding=normalizeTarget(await readJson(req,2048));
        const store=load();
        store.bindings=store.bindings.filter(b=>!(b.kind===binding.kind &&
          (b.name===binding.name || b.id===binding.id)));
        store.bindings.push(binding);save(store);
        return output(res,200,{ok:true,binding});
      }
      if(req.method==="GET" && url.pathname==="/v1/jobs") {
        const store=load();
        return output(res,200,{ok:true,jobs:store.jobs.slice(-100).map(publicJob)});
      }
      const match=url.pathname.match(/^\/v1\/jobs\/([a-f0-9-]{36})$/);
      if(req.method==="GET" && match) {
        const job=load().jobs.find(j=>j.id===match[1]);
        if(!job) fail("任务不存在",404);
        return output(res,200,{ok:true,job:publicJob(job)});
      }
      fail("未知接口",404);
    } catch(error) {
      if(!res.headersSent) output(res,error.status||500,
        {ok:false,error:error.status?error.message:"本机桥接器内部错误"});
    }
  });
}
function request(method,url,data,authorization=true) {
  return new Promise((resolve,reject)=>{
    const body=data?Buffer.from(JSON.stringify(data)):null;
    const req=http.request({hostname:HOST,port:PORT,method,path:url,timeout:5000,
      headers:{...(authorization?{Authorization:"Bearer "+token()}:{}),
        ...(body?{"Content-Type":"application/json","Content-Length":body.length}:{})}},res=>{
      const data=[];res.on("data",c=>data.push(c));
      res.on("end",()=>{try{
        const result=JSON.parse(Buffer.concat(data).toString("utf8"));
        if(res.statusCode>=400) reject(new Error(result.error||"请求失败"));
        else resolve(result);
      }catch(error){reject(error);}});
    });
    req.on("error",reject);req.on("timeout",()=>req.destroy(new Error("本机桥接器超时")));
    if(body) req.write(body);
    req.end();
  });
}
async function ensureServer() {
  try {return await request("GET","/health",null,false);} catch {}
  const proc=spawn(process.execPath,[__filename,"serve"],
    {detached:true,windowsHide:true,stdio:"ignore",cwd:__dirname});
  proc.unref();
  for(let i=0;i<30;i++){
    await new Promise(r=>setTimeout(r,200));
    try{return await request("GET","/health",null,false);}catch{}
  }
  fail("桥接器无法启动，请检查本机 43578 端口",503);
}
function argsToJob(command,args) {
  const arg=(key)=>{const i=args.indexOf(key);return i>=0?args[i+1]:null;};
  if(command==="submit") {
    const file=arg("--json");
    if(!file) fail("submit 需要 --json 文件");
    return JSON.parse(fs.readFileSync(path.resolve(file),"utf8"));
  }
  const content=arg("--file")?fs.readFileSync(path.resolve(arg("--file")),"utf8"):arg("--text");
  if(command==="enqueue") return {action:"continue",target:{kind:"chat",name:arg("--chat")},
    text:content,mode:arg("--mode")||"queue"};
  if(command==="new") {
    if(args.includes("--personal") && args.includes("--project"))
      fail("普通新对话与项目新对话不能同时指定");
    if(args.includes("--personal")) return {action:"new_chat",
      target:{kind:"personal",id:"personal",url:"https://chatgpt.com/"},
      text:content,mode:"queue"};
    return {action:"new_chat",target:{kind:"project",name:arg("--project")},
      text:content,mode:"queue"};
  }
  fail("未知任务指令");
}
async function cli(argv) {
  const [command,...args]=argv;
  if (command==="serve") {
    token();const server=makeServer();
    server.listen(PORT,HOST,()=>process.stdout.write("ChatGPTTaskQueue bridge listening on "+HOST+":"+PORT+"\n"));
    return;
  }
  if(command==="help" || !command) {
    process.stdout.write([
      "GPT 队列 AI 接口（仅本机）：",
      "  node remote-bridge.cjs install             安装开机启动并启动桥接器",
      "  node remote-bridge.cjs start               启动桥接器",
      "  node remote-bridge.cjs targets             查看可识别的对话与项目",
      "  node remote-bridge.cjs enqueue --chat <名称|ID|URL> --text <提示词> [--mode queue|steer]",
      "  node remote-bridge.cjs new --project <名称|ID|URL> --text <提示词>",
      "  node remote-bridge.cjs new --personal --text <提示词>  在普通聊天中新建对话",
      "  node remote-bridge.cjs bind --project <名称> --url <项目主页地址>",
      "  node remote-bridge.cjs bind --chat <名称> --url <现有对话地址>",
      "  node remote-bridge.cjs submit --json <文件> 结构化创建任务",
      "  node remote-bridge.cjs status [任务ID]      查看任务状态",
      "  node remote-bridge.cjs cancel-unclaimed --json <JSON数组文件> 仅取消尚未领取的任务",
      "  node remote-bridge.cjs quarantine-uncertain --json <JSON数组文件> 停止已过租约的不确定任务重试",
      "  node remote-bridge.cjs reset-pairing       改变浏览器扩展安装 ID 后重新配对",
      "  可以用 --file <UTF-8文件> 代替 --text；--personal 创建普通聊天，不进入项目。",
    ].join("\n")+"\n");return;
  }
  if(command==="install") {
    if(process.platform==="win32") {
      const cmd='\"'+process.execPath+'\" \"'+__filename+'\" serve';
      const result=spawnSync("reg.exe",["add","HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run",
        "/v","ChatGPTTaskQueueRemoteBridge","/t","REG_SZ","/d",cmd,"/f"],{encoding:"utf8"});
      if(result.status!==0) fail("开机自启注册失败: "+(result.stderr||result.stdout),500);
    }
    await ensureServer();
    process.stdout.write("已启动本机桥接器；Windows 登录时也将启动。\n");
    return;
  }
  if(command==="reset-pairing") {
    if(fs.existsSync(EXTENSION_ID_FILE)) fs.unlinkSync(EXTENSION_ID_FILE);
    process.stdout.write("已清除扩展身份配对，下次合法扩展连接时重新配对。\n");
    return;
  }
  await ensureServer();
  let data;
  if (command==="start") data=await request("GET","/health",null,false);
  else if(command==="targets") data=await request("GET","/v1/targets");
  else if(command==="bind") {
    const kind=args.includes("--project")?"project":"chat";
    const key=kind==="project"?"--project":"--chat";
    const name=args[args.indexOf(key)+1];
    const url=args[args.indexOf("--url")+1];
    data=await request("POST","/v1/bindings",{kind,name,url});
  }
  else if(command==="status") data=await request("GET","/v1/jobs"+(args[0]?"/"+encodeURIComponent(args[0]):""));
  else if(command==="cancel-unclaimed") {
    const file=args[args.indexOf("--json")+1];
    if(!file || file.startsWith("--")) fail("需要 --json 指定 UUID 数组文件");
    data=await request("POST","/v1/jobs/cancel-unclaimed",
      {ids:JSON.parse(fs.readFileSync(path.resolve(file),"utf8"))});
  }
  else if(command==="quarantine-uncertain") {
    const file=args[args.indexOf("--json")+1];
    if(!file || file.startsWith("--")) fail("需要 --json 指定 UUID 数组文件");
    data=await request("POST","/v1/jobs/quarantine-uncertain",
      {ids:JSON.parse(fs.readFileSync(path.resolve(file),"utf8"))});
  }
  else if(["enqueue","new","submit"].includes(command))
    data=await request("POST","/v1/jobs",argsToJob(command,args));
  else fail("未知指令，运行 help 查看说明");
  process.stdout.write(JSON.stringify(data,null,2)+"\n");
}
if(require.main===module) cli(process.argv.slice(2)).catch(error=>{
  process.stderr.write("操作失败："+error.message+"\n");process.exitCode=1;
});
module.exports={validateJob,makeJob,dispatchNext,updateJob,recordCompletion,
  cancelUnclaimedJobs,quarantineUncertainJobs,
  createReleaseRequest,claimReleaseRequest,reportReleaseRequest,makeServer,ROOT,PORT};
