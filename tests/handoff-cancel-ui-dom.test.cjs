"use strict";

const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const os=require("node:os");
const {spawnSync}=require("node:child_process");

const browser=process.env.CQ_BROWSER_BIN || (process.platform==="win32"
  ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" : "/usr/bin/google-chrome");

test("真实 Chrome：项目主页可取消失败接收，删除及核对跳过携带人工确认，不把待取消报成成功",{
  skip:!fs.existsSync(browser) && "Chrome is not installed",
},()=>{
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),"cq-handoff-cancel-dom-"));
  try {
    let script=fs.readFileSync(path.join(__dirname,"..","content.js"),"utf8");
    script=script.replace("  function boundHere() {",
      "  function boundHere() { return true; }\n  function originalBoundHere() {");
    script=script.replace("  function isProjectOverview(url = location.href) {",
      "  function isProjectOverview() { return true; }\n  function originalIsProjectOverview(url = location.href) {");
    const init=/  void init\(\);\r?\n\}\)\(\);/;
    assert.match(script,init,"Cannot expose cancellation fixture hooks");
    script=script.replace(init,
      "  window.__cqCancel={set(value){state=value;sessionKey=value.key;render();},act:onAction};\n})();");
    fs.writeFileSync(path.join(folder,"content.js"),script);
    fs.copyFileSync(path.join(__dirname,"..","panel.css"),path.join(folder,"panel.css"));
    fs.writeFileSync(path.join(folder,"index.html"),`<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="panel.css"></head><body><main><form>
<textarea id="prompt-textarea" aria-label="询问 ChatGPT"></textarea>
<button type="button" aria-label="Start Voice">Voice</button></form></main><script>
const requests=[];
let pending=false;
let current;
window.confirm=()=>true;
function reset(status="error"){
 current={key:"draft:11",url:location.href,tasks:[
  {id:"intro",kind:"handoff_intro",status,text:"接收文档正文",images:[],error:"接收失败"},
  {id:"ordinary",status:"pending",text:"保留的普通任务",images:[]},
 ],schedules:[{id:"rule",mode:"count",enabled:false,text:"保留规则",threshold:1,repeatCount:-1}],
 history:[],halted:status==="error",haltReason:"failure",queuePaused:false,
 activeTaskId:status==="error"?"intro":null,steeringTaskId:null,
 handoffSourceKey:"source-chat",handoffToken:"token",
 handoff:{enabled:false,intervalMinutes:120,phase:"failed",error:"交接接收失败"}};
 window.__cqCancel.set(current);
}
function clean(){
 current.tasks=current.tasks.filter(task=>task.kind!=="handoff_intro");
 delete current.handoffSourceKey;delete current.handoffToken;
 current.activeTaskId=null;current.halted=false;current.haltReason=null;
 current.handoff={enabled:false,intervalMinutes:120,phase:"idle",nextAt:null};
}
window.chrome={runtime:{getManifest(){return {version:"0.49.42"};},onMessage:{addListener(){}},
 async sendMessage(message){
  requests.push(message);
  if(["CANCEL_HANDOFF","DELETE_TASK","SKIP_FAILED"].includes(message.type)){
   if(!pending)clean();
   return {ok:true,cancelPending:pending,state:current,sessionKey:current.key};
  }
  return {ok:true,state:current,sessionKey:current.key};
 }},storage:{onChanged:{addListener(){}}}};
</script><script src="content.js"></script><script>
(async()=>{
 const flags={};
 const q=selector=>document.querySelector("#cq-extension-root "+selector);
 const act=async selector=>{const button=q(selector);if(!button)throw new Error("missing "+selector);await window.__cqCancel.act(button);};
 try{
  reset();
  await act('[data-action="toggle-handoff"]');
  flags.projectCancel=!!q('.cq-handoff-page [data-action="cancel-handoff"]');
  pending=true;
  await act('.cq-handoff-page [data-action="cancel-handoff"]');
  flags.pendingNotSuccess=q('.cq-action-feedback')?.textContent.includes("已请求取消接力") &&
   !q('.cq-action-feedback')?.textContent.includes("已取消接力") &&
   current.tasks.some(task=>task.id==="intro");
  pending=false;
  await act('.cq-handoff-page [data-action="cancel-handoff"]');
  flags.cancelReviewed=requests.filter(message=>message.type==="CANCEL_HANDOFF")
   .every(message=>message.reviewed===true);
  flags.cancelCleansBinding=!current.handoffSourceKey && !current.handoffToken &&
   current.tasks.length===1 && current.tasks[0].id==="ordinary" && current.schedules[0].id==="rule";
  reset();
  const trash=q('[data-action="delete-task"][data-id="intro"]');
  flags.errorTrashAvailable=!!trash && !trash.disabled;
  await act('[data-action="delete-task"][data-id="intro"]');
  flags.deleteReviewed=requests.some(message=>message.type==="DELETE_TASK" &&
   message.id==="intro" && message.reviewed===true) && !current.handoffSourceKey;
  reset("pending");
  pending=true;
  await act('[data-action="delete-task"][data-id="intro"]');
  flags.deletePendingNotSuccess=q('.cq-action-feedback')?.textContent.includes("已请求取消接力") &&
   !q('.cq-action-feedback')?.textContent.includes("队列任务已删除");
  pending=false;
  reset();
  await act('[data-action="skip-failed"][data-id="intro"]');
  flags.skipReviewed=requests.some(message=>message.type==="SKIP_FAILED" &&
   message.id==="intro" && message.reviewed===true) &&
   current.tasks.length===1 && current.tasks[0].id==="ordinary" && current.schedules.length===1;
  flags.noDispatch=requests.every(message=>!["CLAIM","SENT","FINISHED","ENQUEUE"].includes(message.type));
 }catch(error){flags.error=error.stack||String(error);}
 flags.ok=["projectCancel","pendingNotSuccess","cancelReviewed","cancelCleansBinding",
  "errorTrashAvailable","deleteReviewed","deletePendingNotSuccess","skipReviewed","noDispatch"]
  .every(key=>flags[key]===true);
 document.body.dataset.check=JSON.stringify(flags);
})();
</script></body></html>`);
    const result=spawnSync(browser,["--headless=new","--disable-gpu","--disable-extensions","--no-first-run",
      `--user-data-dir=${path.join(folder,"profile")}`,"--virtual-time-budget=3500","--dump-dom",
      `file:///${path.join(folder,"index.html").replace(/\\/g,"/")}`],
    {encoding:"utf8",timeout:20000,maxBuffer:5e6});
    assert.equal(result.status,0,result.stderr||"Chrome failed");
    const match=result.stdout.match(/data-check="([^"]+)"/);
    assert.ok(match,"Cancellation fixture did not finish");
    const flags=JSON.parse(match[1].replace(/&quot;/g,'"').replace(/&amp;/g,"&"));
    assert.equal(flags.ok,true,JSON.stringify(flags,null,2));
  }finally{fs.rmSync(folder,{recursive:true,force:true,maxRetries:8,retryDelay:100});}
});
