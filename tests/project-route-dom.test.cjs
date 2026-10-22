"use strict";

const {test} = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const {spawnSync} = require("node:child_process");

const browser = process.env.CQ_BROWSER_BIN || (process.platform === "win32"
  ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" : "/usr/bin/google-chrome");

test("真实浏览器：项目主页显示本次队列并可使用收藏，离开返回后重新开始",{
  skip:!fs.existsSync(browser) && "Chrome is not installed",
},()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"cq-project-route-"));
  try {
    const original=fs.readFileSync(path.join(__dirname,"..","content.js"),"utf8");
    // Use a file-based test page while emulating ChatGPT's route classification
    // through the same validUrl() used by production project/chat routing.
    const modified=original.replace("  function validUrl(url) {",`
  function validUrl(url) {
    if (String(url).startsWith("file:")) {
      const mode = new URL(url).searchParams.get("mode");
      return "https://chatgpt.com/g/g-p-test/" +
        (mode === "project" ? "project" : "c/chat-one");
    }`);
    assert.notEqual(modified,original,"Cannot instrument the URL classifier");
    fs.writeFileSync(path.join(dir,"content.js"),modified);
    fs.copyFileSync(path.join(__dirname,"..","panel.css"),path.join(dir,"panel.css"));
    fs.writeFileSync(path.join(dir,"index.html"),`<!doctype html><html><head>
<meta charset="utf-8"><link rel="stylesheet" href="panel.css">
</head><body><main><form><textarea id="prompt-textarea">没有发送的原生草稿</textarea>
<button type="button" aria-label="Start Voice">语音</button></form></main>
<script>
const state={key:"chat:chat-one",tabId:1,halted:false,queuePaused:false,
  activeTaskId:null,steeringTaskId:null,autoOpenTab:false,tasks:[],schedules:[],
  countRateLimit:{enabled:false,windowMinutes:10,maxAdds:3},countRateTimes:[],history:[]};
const projectUrl="https://chatgpt.com/g/g-p-test/project";
let projectState=null;
const favorites=[{id:"starter",title:"启动任务",text:"从收藏开始项目任务",images:[]}];
const calls=[];
window.chrome={
 runtime:{
  onMessage:{addListener(){}},
  async sendMessage(message){
   calls.push(message);
   if(message.type==="GET_FAVORITES")return {ok:true,favorites};
   if(message.url.includes("mode=project")) {
     if(!projectState || message.type==="HELLO" &&
        projectState.projectVisitId!==message.projectVisitId) {
       projectState={...state,key:"draft:1",url:projectUrl,tasks:[],
         projectVisitId:message.projectVisitId};
     }
     if(message.type==="ENQUEUE_FAVORITE")
       projectState.tasks.push({id:"starter-task",text:favorites[0].text,status:"pending"});
     return {ok:true,state:projectState,sessionKey:"draft:1",settings:{maxPending:100}};
   }
   return {ok:true,state,sessionKey:"chat:chat-one",settings:{maxPending:100}};
  }
 },
 storage:{onChanged:{addListener(){}}},
};
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const until=async fn=>{for(let i=0;i<105;i++){if(fn())return true;await wait(50);}return false;};
</script><script src="content.js"></script><script>
setTimeout(async()=>{
 const results={};
 try{
  results.initialChat=await until(()=>!!document.querySelector("#cq-extension-root .cq-inline"));
  history.pushState({},"","?mode=project");
  results.projectVisible=await until(()=>!!document.querySelector("#cq-extension-root .cq-inline") &&
   calls.some(c=>c.type==="HELLO" && c.url.includes("mode=project")));
  const firstVisit=projectState?.projectVisitId;
  results.visitToken=typeof firstVisit==="string" && firstVisit.length>0;
  document.querySelector('[data-action="toggle-favorites"]').click();
  results.favoritesVisible=!!document.querySelector('[data-action="enqueue-favorite"][data-id="starter"]');
  document.querySelector('[data-action="enqueue-favorite"][data-id="starter"]').click();
  results.favoriteQueued=await until(()=>projectState.tasks.length===1 &&
    !!document.querySelector('[data-task-id="starter-task"]'));
  const editor=document.querySelector("#prompt-textarea");
  const draft=editor.value;
  editor.value="";
  const event=new KeyboardEvent("keydown",{key:"Enter",bubbles:true,cancelable:true});
  editor.dispatchEvent(event);
  results.normalEnter=event.defaultPrevented &&
   !calls.some(c=>c.type==="ENQUEUE" && c.url.includes("mode=project"));
  editor.value=draft;
  const earlierChatHellos=calls.filter(c=>c.type==="HELLO" && c.url.includes("mode=chat")).length;
  history.pushState({},"","?mode=chat");
  results.returned=await until(()=>!!document.querySelector("#cq-extension-root .cq-inline") &&
   calls.filter(c=>c.type==="HELLO" && c.url.includes("mode=chat")).length>earlierChatHellos);
  results.draftIntact=editor.value==="没有发送的原生草稿";
  history.pushState({},"","?mode=project");
  results.freshVisit=await until(()=>projectState?.projectVisitId!==firstVisit &&
    projectState.tasks.length===0 && !!document.querySelector("#cq-extension-root .cq-empty"));
 }catch(error){results.error=error.stack||String(error);}
 results.ok=["initialChat","projectVisible","visitToken","favoritesVisible",
   "favoriteQueued","normalEnter","returned","draftIntact","freshVisit"]
  .every(k=>results[k]===true);
 document.body.dataset.routeTest=JSON.stringify(results);
},250);
</script></body></html>`);
    const run=spawnSync(browser,[
      "--headless=new","--disable-gpu","--disable-extensions","--no-first-run",
      "--window-size=1100,900",`--user-data-dir=${path.join(dir,"profile")}`,
      "--virtual-time-budget=10000","--dump-dom",
      `file:///${path.join(dir,"index.html").replace(/\\/g,"/")}?mode=chat`,
    ],{encoding:"utf8",timeout:30000,maxBuffer:10e6});
    assert.equal(run.status,0,run.stderr||"Chrome failed");
    const match=run.stdout.match(/data-route-test="([^"]+)"/);
    assert.ok(match,"Chrome did not complete the project route test");
    const result=JSON.parse(match[1].replace(/&quot;/g,'"').replace(/&amp;/g,"&"));
    assert.equal(result.ok,true,JSON.stringify(result,null,2));
  } finally {fs.rmSync(dir,{recursive:true,force:true,maxRetries:12,retryDelay:250});}
});
