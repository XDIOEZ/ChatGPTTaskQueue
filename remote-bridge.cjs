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
const TERMINAL = new Set(["queued","steered","created","failed","review_required"]);
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
function emptyStore() { return {version:1,jobs:[],targets:[],targetsAt:null,bindings:[]}; }
function load() {
  ensureRoot();
  if (!fs.existsSync(DATA_FILE)) return emptyStore();
  const data = JSON.parse(fs.readFileSync(DATA_FILE,"utf8"));
  if (data.version!==1 || !Array.isArray(data.jobs) || !Array.isArray(data.targets))
    fail("桥接器数据格式不兼容，已停止以免覆盖数据",500);
  if (!Array.isArray(data.bindings)) data.bindings=[];
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
      (action==="new_chat" && target.kind!=="project"))
    fail("已有对话用 chat，新建对话用 project");
  const selector=target.id||target.url||target.name;
  if (typeof selector!=="string" || !selector.trim() || selector.length>512)
    fail("必须提供 target.id / target.url / target.name");
  if (target.url && (!/^https:\/\/chatgpt\.com\//.test(target.url) &&
      !/^https:\/\/chat\.openai\.com\//.test(target.url)))
    fail("只允许官方 ChatGPT 地址");
  const mode=input.mode || "queue";
  if (!["queue","steer"].includes(mode) || (action==="new_chat" && mode!=="queue"))
    fail("新对话仅支持 queue；已有对话支持 queue / steer");
  return {action,text:input.text,target:{
    kind:target.kind,...(target.id?{id:target.id}:{}),
    ...(target.url?{url:target.url}:{}),...(target.name?{name:target.name}:{})
  },mode};
}
function publicJob(job) {
  const {id,action,target,mode,status,createdAt,updatedAt,attempts,tabId,taskId,chatUrl,error,
    openIntent,sendIntent}=job;
  return {id,action,target,mode,status,createdAt,updatedAt,attempts,
    ...(tabId?{tabId}:{}),...(taskId?{taskId}:{}),
    ...(chatUrl?{chatUrl}:{}),...(error?{error}:{}),
    ...(openIntent===true?{openIntent:true}:{}),
    ...(sendIntent===true?{sendIntent:true}:{})};
}
function makeJob(input,now=Date.now()) {
  return {...validateJob(input),id:crypto.randomUUID(),status:"pending",
    createdAt:now,updatedAt:now,attempts:0,leaseUntil:0};
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
      if (req.method==="GET" && url.pathname==="/health")
        return output(res,200,{ok:true,service:"chatgpt-task-queue-bridge",version:1});
      if (url.pathname.startsWith("/v1/extension/")) {
        requireExtension(req);
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
      if (req.method==="POST" && url.pathname==="/v1/jobs") {
        const store=load();
        const item=makeJob(await readJson(req));
        applyKnownTarget(item,store);
        // Never silently delete pending work just to accept one more task.
        if(store.jobs.filter(j=>!TERMINAL.has(j.status)).length>=MAX_JOBS)
          fail("待处理任务数量已满",409);
        store.jobs.push(item);
        if(store.jobs.length>MAX_JOBS*2) {
          const recent=store.jobs.filter(j=>TERMINAL.has(j.status)).slice(-MAX_JOBS);
          store.jobs=[...store.jobs.filter(j=>!TERMINAL.has(j.status)),...recent]
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
  if(command==="new") return {action:"new_chat",target:{kind:"project",name:arg("--project")},
    text:content,mode:"queue"};
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
      "  node remote-bridge.cjs bind --project <名称> --url <项目主页地址>",
      "  node remote-bridge.cjs bind --chat <名称> --url <现有对话地址>",
      "  node remote-bridge.cjs submit --json <文件> 结构化创建任务",
      "  node remote-bridge.cjs status [任务ID]      查看任务状态",
      "  node remote-bridge.cjs reset-pairing       改变浏览器扩展安装 ID 后重新配对",
      "  可以用 --file <UTF-8文件> 代替 --text；指定项目新聊天不会创建新项目。",
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
  else if(["enqueue","new","submit"].includes(command))
    data=await request("POST","/v1/jobs",argsToJob(command,args));
  else fail("未知指令，运行 help 查看说明");
  process.stdout.write(JSON.stringify(data,null,2)+"\n");
}
if(require.main===module) cli(process.argv.slice(2)).catch(error=>{
  process.stderr.write("操作失败："+error.message+"\n");process.exitCode=1;
});
module.exports={validateJob,makeJob,dispatchNext,updateJob,makeServer,ROOT,PORT};
