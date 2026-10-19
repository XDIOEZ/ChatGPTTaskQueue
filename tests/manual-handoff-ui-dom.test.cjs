"use strict";

const {test} = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const {spawnSync} = require("node:child_process");

const browser = process.env.CQ_BROWSER_BIN || (process.platform === "win32"
  ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
  : "/usr/bin/google-chrome");

test("真实 Chrome：原生项目空队列可以点击手动接力，重复点击仅发送一次", {
  skip: !fs.existsSync(browser) && "Chrome is not installed",
}, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cq-manual-handoff-ui-"));
  try {
    let content = fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8");
    // The browser fixture loads file://. Simulate the path portion of an
    // existing native-project chat only for its UI eligibility check.
    const pathnameSource = "      .test(new URL(location.href).pathname);";
    assert.ok(content.includes(pathnameSource),"Project-chat eligibility expression moved");
    content = content.replace(pathnameSource,
      '      .test("/g/g-p-empty-ui/c/known-chat");');
    // file:// has no legitimate conversation owner; its normal binding gate
    // is covered by worker tests. Keep this DOM test focused on the button.
    content = content.replace("  function boundHere() {",
      "  function boundHere() { return true; }\n  function unusedOriginalBoundHere() {");
    content = content.replace("  void init();\n})();",
      "  window.__cqHandoffProbe={snapshot:conversationSnapshot,extract:extractHandoffReply," +
      "completion:handoffCompletionEvidence,ready:updateVoiceReadiness};\n  void init();\n})();");
    fs.writeFileSync(path.join(dir, "content.js"),content);
    fs.copyFileSync(path.join(__dirname, "..", "panel.css"),path.join(dir,"panel.css"));
    fs.writeFileSync(path.join(dir, "index.html"), `<!doctype html>
<html><head><meta charset="utf-8"><link rel="stylesheet" href="./panel.css"></head>
<body><main><form><div contenteditable="true" aria-label="询问 ChatGPT"></div>
<button type="button" aria-label="Start Voice">Voice</button></form></main>
<script>
const calls=[];
window.confirm=()=>true;
const state={
  key:"draft:1",tasks:[],schedules:[],history:[],halted:false,
  activeTaskId:null,steeringTaskId:null,queuePaused:false,
  firstSeenAt:Date.now()-((2*60+14)*60000),firstMessageAt:null,
  handoff:{enabled:false,intervalMinutes:120,nextAt:null,phase:"idle"},
};
const settings={maxPending:100,protectBackground:true,
  defaultIntervalMinutes:30,defaultRepeatCount:-1};
window.chrome={
  runtime:{getManifest(){return {version:"0.99.0"};},
    onMessage:{addListener(){}},async sendMessage(msg){
      calls.push(msg.type);
      if(msg.type==="OBSERVE_FIRST_MESSAGE_AT"){
        state.firstMessageAt=msg.firstMessageAt;
      }
       if(msg.type==="HANDOFF_NOW"){
         state.handoff={...state.handoff,manualRequested:true,phase:"due"};
       }
       if(msg.type==="CANCEL_HANDOFF"){
         state.handoff={enabled:false,intervalMinutes:120,nextAt:null,phase:"idle"};
       }
      return {ok:true,state,settings,sessionKey:"draft:1"};
    }},
  storage:{onChanged:{addListener(){}}},
};
</script>
<script src="./content.js"></script>
<script>
setTimeout(async()=>{
  const root=document.querySelector("#cq-extension-root");
  const button=()=>root?.querySelector('[data-action="handoff-now"]');
  const checks={};
  try{
    checks.emptyQueue=root.querySelector(".cq-queue-label span")?.textContent==="0";
    checks.enabled=button()?.disabled===false &&
      button()?.getAttribute("title")?.includes("无需待发送任务");
    checks.estimatedAge=button()?.title.includes("插件已记录此对话至少：2小时14分钟") &&
      button()?.title.includes("实际开始可能更早") &&
      button()?.closest(".cq-handoff-hover-area")?.title===button()?.title;
    const date=new Date(Date.now()-((6*60+15)*60000)).toISOString();
    const user=document.createElement("section");
    user.dataset.turn="user";
    user.setAttribute("data-testid","conversation-turn-0");
    const time=document.createElement("time");
    time.setAttribute("datetime",date);
    user.appendChild(time);
    document.querySelector("main").appendChild(user);
    await new Promise(resolve=>setTimeout(resolve,1850));
    checks.nativeMessageTime=calls.includes("OBSERVE_FIRST_MESSAGE_AT") &&
      state.firstMessageAt===Date.parse(date) &&
      button()?.title.includes("当前对话已至少持续：6小时15分钟") &&
      button()?.title.includes("首条消息：");
    button().click();
    button().click();
    await new Promise(resolve=>setTimeout(resolve,70));
    checks.onlyOnce=calls.filter(type=>type==="HANDOFF_NOW").length===1;
    checks.busy=state.handoff.phase==="due" && button()?.disabled===false &&
      button()?.textContent.includes("取消接力") &&
      button()?.title.includes("再次点击取消接力");
    checks.manualNotTimed=state.handoff.enabled===false &&
      state.handoff.manualRequested===true && state.tasks.length===0;
    checks.handoffTooltip=button()?.closest(".cq-handoff-hover-area")?.title
      .includes("当前对话已至少持续");
    button().click();
    await new Promise(resolve=>setTimeout(resolve,70));
    checks.secondClickCancels=state.handoff.phase==="idle" &&
      button()?.textContent.includes("接力") &&
      calls.filter(type=>type==="CANCEL_HANDOFF").length===1;
    button().click();
    await new Promise(resolve=>setTimeout(resolve,70));
     state.handoff={...state.handoff,phase:"failed",error:"当前接力校验失败"};
     root.querySelector('[data-action="toggle-queue"]').click();
     root.querySelector('[data-action="toggle-queue"]').click();
     checks.failedNotice=root.querySelector('.cq-handoff-failed-notice[role="alert"]')
       ?.textContent.includes("当前接力校验失败") &&
       !!root.querySelector('.cq-handoff-failed-notice [data-action="cancel-handoff"]');
     root.querySelector('.cq-handoff-failed-notice [data-action="cancel-handoff"]').click();
     await new Promise(resolve=>setTimeout(resolve,60));
     checks.failedRecovery=calls.includes("CANCEL_HANDOFF") &&
       state.handoff.phase==="idle" &&
       !root.querySelector('.cq-handoff-failed-notice');
     // Current ChatGPT variants may have no waveform Voice button, only
     // dictation and Stop. Validate the internal handoff-specific evidence.
     document.querySelector('[aria-label="Start Voice"]').remove();
     const nativeStop=document.createElement("button");
     nativeStop.type="button";
     nativeStop.setAttribute("aria-label","停止");
     document.querySelector("form").append(nativeStop);
     const requestId="e0af96b0-a521-4d1a-9e3c-3477d661a2f0";
     state.handoff={phase:"summarizing",requestId,enabled:false,intervalMinutes:120};
     const summaryTask={id:"summary",kind:"handoff_summary",status:"waiting",
       sentAt:Date.now()-8000,baselineAssistantId:"prior-assistant",baselineAssistantCount:0};
     state.tasks=[summaryTask];
     state.activeTaskId="summary";
     const article=document.createElement("article");
     const assistant=document.createElement("section");
     assistant.setAttribute("data-message-author-role","assistant");
     assistant.setAttribute("data-message-id","latest-assistant");
     const markdown=document.createElement("div");
     markdown.className="markdown";
     markdown.textContent="[[CHATGPT_TASKQUEUE_HANDOFF_START:"+requestId+"]]"+
       "本次总结中的工作目录、决策与后续步骤。".repeat(24);
     const pre=document.createElement("pre");
     const code=document.createElement("code");
     code.textContent="[[CHATGPT_TASKQUEUE_HANDOFF_END:"+requestId+"]]";
     pre.appendChild(code);
     assistant.append(markdown,pre);
     const copy=document.createElement("button");
     copy.setAttribute("aria-label","复制");
     article.append(assistant,copy);
     document.querySelector("main").append(article);
     const probe=window.__cqHandoffProbe;
     const snapshot=probe.snapshot();
     checks.fragmentedMarkers=snapshot.lastAssistantText.includes("HANDOFF_START") &&
       !snapshot.lastAssistantText.includes("HANDOFF_END") &&
       probe.extract(snapshot,requestId).completeMarkers &&
       probe.extract(snapshot,requestId).text.includes("HANDOFF_END");
     checks.stopPreventsCompletion=probe.ready()===false &&
       probe.completion(summaryTask,snapshot).ready===false;
     nativeStop.remove();
     checks.noPrematureComplete=probe.completion(summaryTask,probe.snapshot()).ready===false;
     await new Promise(resolve=>setTimeout(resolve,5100));
     checks.nativeFallbackCompletes=probe.ready()===false &&
       probe.completion(summaryTask,probe.snapshot()).ready===true;
  }catch(error){checks.error=String(error);}
  checks.ok=["emptyQueue","enabled","estimatedAge","nativeMessageTime",
     "onlyOnce","busy","manualNotTimed","handoffTooltip","secondClickCancels",
     "failedNotice","failedRecovery","fragmentedMarkers",
     "stopPreventsCompletion","noPrematureComplete","nativeFallbackCompletes"]
    .every(key=>checks[key]===true);
  document.body.dataset.result=JSON.stringify(checks);
},350);
</script></body></html>`);
    const run=spawnSync(browser,[
      "--headless=new","--disable-gpu","--disable-extensions","--no-first-run",
      `--user-data-dir=${path.join(dir,"profile")}`,
      "--virtual-time-budget=11000","--dump-dom",
      `file:///${path.join(dir,"index.html").replace(/\\/g,"/")}`,
    ],{encoding:"utf8",timeout:20000,maxBuffer:5e6});
    assert.equal(run.status,0,run.stderr||"Chrome failed");
    const match=run.stdout.match(/data-result="([^"]+)"/);
    assert.ok(match,"Chrome did not finish the handoff button check");
    const checks=JSON.parse(match[1].replace(/&quot;/g,'"').replace(/&amp;/g,"&"));
    assert.equal(checks.ok,true,JSON.stringify(checks));
  }finally{
    fs.rmSync(dir,{recursive:true,force:true});
  }
});
