"use strict";

const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const os=require("node:os");
const {spawnSync}=require("node:child_process");

const browser=process.env.CQ_BROWSER_BIN || (process.platform==="win32"
  ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
  : "/usr/bin/google-chrome");

test("真实 Chrome：接力诊断兼容旧记录，复制和下载 v2 脱敏报告及发送门禁详情",{
  skip:!fs.existsSync(browser) && "Chrome is not installed",
},()=>{
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),"cq-handoff-debug-dom-"));
  try {
    let script=fs.readFileSync(path.join(__dirname,"..","content.js"),"utf8")
      .replace("  function boundHere() {",
        "  function boundHere() { return true; }\n  function originalBoundHere() {");
    const initCall=/  void init\(\);\r?\n\}\)\(\);/;
    assert.match(script,initCall,"Cannot expose diagnostics fixture hooks");
    script=script.replace(initCall,
      "  window.__cqDebugProbe={send:sendTask,heartbeat};\n  void init();\n})();");
    fs.writeFileSync(path.join(folder,"content.js"),script);
    fs.copyFileSync(path.join(__dirname,"..","panel.css"),path.join(folder,"panel.css"));
    fs.writeFileSync(path.join(folder,"index.html"),`<!doctype html><html lang="zh">
<head><meta charset="utf-8"><link rel="stylesheet" href="panel.css"></head><body>
<main><form><textarea id="prompt-textarea">请保留我尚未发送的草稿</textarea>
<button type="button" aria-label="Start Voice">语音</button></form></main>
<script>
const calls=[];
const requests=[];
const downloads=[];
const blobs=new Map();
URL.createObjectURL=blob=>{const key="blob:fixture-"+blobs.size;blobs.set(key,blob);return key;};
URL.revokeObjectURL=()=>{};
HTMLAnchorElement.prototype.click=function(){downloads.push({href:this.href,name:this.download});};
const state={
 key:"draft:1",url:"https://chatgpt.com/c/test",
 halted:false,queuePaused:false,activeTaskId:null,steeringTaskId:null,
 tasks:[{id:"keep",text:"原任务不应被改写",status:"pending"}],
 schedules:[],history:[],handoff:{
  phase:"failed",enabled:false,intervalMinutes:120,
  error:"生成总结后新对话地址确认超时",
 },
};
const runs=[{
 mode:"manual",status:"failed",phase:"failed",
 startedAt:Date.now()-10000,
 events:[
  {at:Date.now()-9500,kind:"state",phase:"due",summaryStatus:"none",introStatus:"none",
   destination:"none",reason:"none"},
  {at:Date.now()-7000,kind:"state",phase:"summarizing",summaryStatus:"waiting",
   introStatus:"none",destination:"none",reason:"none"},
  {at:Date.now()-2000,kind:"state",phase:"failed",summaryStatus:"none",
   introStatus:"none",destination:"none",reason:"timeout"},
 ],
}];
window.copied="";
Object.defineProperty(navigator,"clipboard",{
 configurable:true,value:{async writeText(text){window.copied=text;}},
});
window.chrome={
 runtime:{getManifest(){return {version:"0.49.13"};},
  onMessage:{addListener(){}},
  async sendMessage(message){
   calls.push(message.type);
   requests.push(message);
   if(message.type==="CLAIM")throw new Error("private exception details must not leak");
   // Legacy v1 replies deliberately omit version/current/capturedAt.
   if(message.type==="GET_HANDOFF_DEBUG") return {ok:true,runs:structuredClone(runs)};
   if(message.type==="GET_FAVORITES")return {ok:true,favorites:[]};
   return {ok:true,state,sessionKey:"draft:1",settings:{maxPending:100}};
  }},
 storage:{onChanged:{addListener(){}}},
};
const q=selector=>document.querySelector("#cq-extension-root "+selector);
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const until=async fn=>{for(let i=0;i<80;i++){if(fn())return true;await wait(40);}return false;};
</script><script src="content.js"></script><script>
setTimeout(async()=>{
 const flags={};
 try{
  flags.failedShortcut=await until(()=>!!q('[data-action="open-handoff-debug"]'));
  q('[data-action="open-handoff-debug"]').click();
  flags.opensTimeline=await until(()=>q(".cq-handoff-debug-events")?.textContent.includes("接力失败")) &&
   !!q('#cq-settings-page-diagnostics:not([hidden])') &&
   q(".cq-handoff-debug-summary")?.textContent.includes("手动接力") &&
   q(".cq-handoff-debug-events")?.textContent.includes("超过接力等待期限");
  const beforeCopy=calls.length;
  q('[data-action="copy-handoff-debug"]').click();
  flags.copied=await until(()=>window.copied.includes("ChatGPTTaskQueue-handoff-debug"));
  const payload=JSON.parse(window.copied);
  flags.privateCopy=payload.version===2 && payload.page?.gate==="export" &&
   typeof payload.page.editorChars==="number" && payload.runs.length===1 &&
   payload.runs[0].events.length===3 &&
   !window.copied.includes("原任务不应被改写") &&
   !window.copied.includes("请保留我尚未发送的草稿") &&
   !window.copied.includes("https://chatgpt.com/c/test") &&
   !window.copied.includes("sourceKey") &&
   !window.copied.includes("交接正文");
  q('[data-action="export-handoff-debug"]').click();
  flags.downloaded=await until(()=>downloads.length===1);
  const file=downloads[0];
  const exported=await blobs.get(file.href).text();
  const json=JSON.parse(exported);
  flags.privateDownload=/\\.json$/.test(file.name) && json.version===2 &&
   json.format==="ChatGPTTaskQueue-handoff-debug" && json.runs.length===1 &&
   json.page.editorChars===document.querySelector("#prompt-textarea").value.length &&
   !exported.includes("原任务不应被改写") && !exported.includes("sourceKey") &&
   !exported.includes("https://chatgpt.com/c/test") &&
   !exported.includes("请保留我尚未发送的草稿");
  runs.splice(0,runs.length);
  q('[data-action="export-handoff-debug"]').click();
  flags.emptyExport=await until(()=>downloads.length===2);
  const empty=JSON.parse(await blobs.get(downloads[1].href).text());
  flags.emptyExport=flags.emptyExport && empty.runs.length===0 &&
   empty.version===2 && empty.pluginVersion==="0.49.13" &&
   typeof empty.generatedAt==="string" && empty.page.gate==="export";
  flags.noDispatch=calls.slice(beforeCopy).every(type=>
   !["ENQUEUE","CLAIM","SENT","FINISHED"].includes(type));
  runs.push({mode:"manual",status:"failed",phase:"failed",events:[{
   at:Date.now(),kind:"page_wait",phase:"failed",reason:"waiting_native_reply",
  }]});
  q('[data-action="load-handoff-debug"]').click();
  flags.refreshes=await until(()=>q(".cq-handoff-debug-events")?.textContent
   .includes("等待新对话的助手回复"));
  flags.keepsDraft=document.querySelector("#prompt-textarea").value===
   "请保留我尚未发送的草稿" &&
   state.tasks.length===1 && state.tasks[0].id==="keep";
  const internal={id:"internal",kind:"handoff_summary",text:"不可导出的交接正文",images:[],status:"dispatching"};
  state.tasks=[internal];
  state.activeTaskId=internal.id;
  state.handoff.phase="summarizing";
  await window.__cqDebugProbe.send(internal);
  flags.sendGateDetails=await until(()=>requests.some(message=>
   message.type==="HANDOFF_DEBUG_SIGNAL" && message.reason==="editor_has_text" &&
   message.details?.gate==="prepare" && message.details.editorChars>0 &&
   message.details.taskChars===internal.text.length && message.details.clicked===false));
  state.activeTaskId=null;
  internal.status="pending";
  state.handoff.phase="queued";
  document.querySelector("#prompt-textarea").value="";
  for(let i=0;i<12 && !calls.includes("CLAIM");i++){
   await window.__cqDebugProbe.heartbeat();
   await wait(300);
  }
  flags.claimFailureDetails=await until(()=>requests.some(message=>
   message.type==="HANDOFF_DEBUG_SIGNAL" && message.reason==="claim_exception" &&
   message.details?.gate==="claim" && typeof message.details.scopeCurrent==="boolean"));
  flags.privateSignals=requests.filter(message=>message.type==="HANDOFF_DEBUG_SIGNAL")
   .every(message=>!JSON.stringify(message.details).includes("不可导出的交接正文") &&
    !JSON.stringify(message.details).includes("private exception") &&
    !JSON.stringify(message.details).includes("sourceKey") &&
    !JSON.stringify(message.details).includes("https://chatgpt.com"));
 }catch(error){flags.error=error.stack||String(error);}
 flags.ok=["failedShortcut","opensTimeline","copied","privateCopy","downloaded",
  "privateDownload","emptyExport","noDispatch","refreshes","keepsDraft",
  "sendGateDetails","claimFailureDetails","privateSignals"].every(k=>flags[k]===true);
 document.body.dataset.check=JSON.stringify(flags);
},330);
</script></body></html>`);
    const result=spawnSync(browser,[
      "--headless=new","--disable-gpu","--disable-extensions","--no-first-run",
      "--window-size=1080,900",`--user-data-dir=${path.join(folder,"profile")}`,
      "--virtual-time-budget=11500","--dump-dom",
      `file:///${path.join(folder,"index.html").replace(/\\/g,"/")}`,
    ],{encoding:"utf8",timeout:30000,maxBuffer:10e6});
    assert.equal(result.status,0,result.stderr||"Chrome failed");
    const match=result.stdout.match(/data-check="([^"]+)"/);
    assert.ok(match,"Chrome did not finish handoff debug UI probe");
    const flags=JSON.parse(match[1].replace(/&quot;/g,'"').replace(/&amp;/g,"&"));
    assert.equal(flags.ok,true,JSON.stringify(flags,null,2));
  }finally{
    fs.rmSync(folder,{recursive:true,force:true,maxRetries:12,retryDelay:250});
  }
});
