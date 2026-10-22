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

test("真实 Chrome：接力按钮打开设置页，保存循环与倒计时，手动命令仅入队一次", {
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
    const initCall = /  void init\(\);\r?\n\}\)\(\);/;
    assert.match(content,initCall,"Cannot expose handoff fixture hooks");
    content = content.replace(initCall,
      "  window.__cqHandoffProbe={snapshot:conversationSnapshot,extract:extractHandoffReply," +
      "completion:handoffCompletionEvidence,ready:updateVoiceReadiness," +
      "composerReady:handoffComposerReady,send:sendTask,hover:updateHandoffHover};\n  void init();\n})();");
    fs.writeFileSync(path.join(dir, "content.js"),content);
    fs.copyFileSync(path.join(__dirname, "..", "panel.css"),path.join(dir,"panel.css"));
    fs.writeFileSync(path.join(dir, "index.html"), `<!doctype html>
<html><head><meta charset="utf-8"><link rel="stylesheet" href="./panel.css"></head>
<body><main><form><div contenteditable="true" data-testid="composer-input" aria-label="询问 ChatGPT"></div>
<button type="button" aria-label="Start Voice">Voice</button></form></main>
<script>
const calls=[];
const requests=[];
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
      requests.push(msg);
      if(msg.type==="OBSERVE_FIRST_MESSAGE_AT"){
        state.firstMessageAt=msg.firstMessageAt;
      }
       if(msg.type==="HANDOFF_NOW"){
         state.tasks=[{id:"queued-handoff",kind:"handoff_summary",text:"交接命令",status:"pending",images:[]}];
         state.handoff={...state.handoff,manualRequested:true,phase:"queued",nextAt:null};
       }
       if(msg.type==="SET_HANDOFF"){
         state.handoff={...state.handoff,enabled:msg.enabled,
           // Return canonical persisted values deliberately different from
           // the draft, so feedback and hover cannot echo stale form data.
           intervalMinutes:msg.enabled?9:Number(msg.intervalMinutes),
           repeatCount:msg.enabled?3:Number(msg.repeatCount),
           remainingCount:msg.enabled?3:Number(msg.repeatCount),
           nextAt:msg.enabled?Date.now()+9*60000:null};
       }
       if(msg.type==="CANCEL_HANDOFF"){
         state.tasks=[];
         state.handoff={enabled:false,intervalMinutes:120,nextAt:null,phase:"idle"};
       }
      return {ok:true,state,settings,sessionKey:"draft:1",...(msg.type==="HANDOFF_SEND_READY"?{sendReady:true}:{})};
    }},
  storage:{onChanged:{addListener(){}}},
};
</script>
<script src="./content.js"></script>
<script>
setTimeout(async()=>{
  const root=document.querySelector("#cq-extension-root");
  const button=()=>root?.querySelector('.cq-tool[data-action="toggle-handoff"]');
  const automatic=()=>root?.querySelector('.cq-tool[data-action="toggle-scheduler"]');
  const manual=()=>root?.querySelector('[data-action="handoff-now"]');
  const checks={};
  try{
    checks.emptyQueue=root.querySelector(".cq-queue-label span")?.textContent==="0";
    checks.enabled=button()?.disabled===false;
    checks.estimatedAge=automatic()?.title.includes("插件已记录此对话至少：2小时14分钟") &&
      automatic()?.title.includes("实际开始可能更早") &&
      !button()?.title.includes("2小时14分钟") &&
      button()?.closest(".cq-handoff-hover-area")?.title===button()?.title;
    checks.disabledTooltip=/未开启|已关闭/.test(button()?.title) &&
      !button()?.title.includes("00:00");
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
      automatic()?.title.includes("当前对话已至少持续：6小时15分钟") &&
      automatic()?.title.includes("首条消息：") &&
      !button()?.title.includes("当前对话已至少持续");
    button().click();
    checks.opensSettings=!!root.querySelector('.cq-handoff-page[aria-label="接力设置"]') &&
      calls.filter(type=>type==="HANDOFF_NOW").length===0;
    root.querySelector('[data-action="save-handoff"]').click();
    await new Promise(resolve=>setTimeout(resolve,70));
    const firstStarted=requests.find(msg=>msg.type==="SET_HANDOFF");
    const startedFeedback=root.querySelector(".cq-action-feedback")?.textContent||"";
    checks.startSavesAndEnables=firstStarted?.enabled===true &&
      state.handoff.enabled===true && state.handoff.nextAt>Date.now() &&
      startedFeedback.includes("已保存") && startedFeedback.includes("已启动") &&
      !root.querySelector('#cq-handoff-enabled') &&
      calls.filter(type=>type==="HANDOFF_NOW").length===0;
    const unsavedMinutes=root.querySelector('#cq-handoff-minutes');
    unsavedMinutes.value="";
    unsavedMinutes.dispatchEvent(new Event("input",{bubbles:true}));
    root.querySelector('[data-action="stop-handoff"]').click();
    await new Promise(resolve=>setTimeout(resolve,70));
    const stopped=requests.filter(msg=>msg.type==="SET_HANDOFF").at(-1);
    checks.stopsSeparately=stopped?.enabled===false &&
      Number(stopped.intervalMinutes)===9 && state.handoff.enabled===false &&
      state.handoff.nextAt===null && root.querySelector('#cq-handoff-minutes')?.value==="" &&
      root.querySelector(".cq-action-feedback")?.textContent.includes("已停止");
    for(const [id,value] of [["cq-handoff-repeats","-1"],["cq-handoff-minutes","7"]]){
      const input=root.querySelector('#'+id);
      input.value=value;
      input.dispatchEvent(new Event("input",{bubbles:true}));
    }
    root.querySelector('[data-action="save-handoff"]').click();
    await new Promise(resolve=>setTimeout(resolve,70));
    const saved=requests.filter(msg=>msg.type==="SET_HANDOFF").at(-1);
    checks.savedCountdown=!!saved && saved.enabled===true &&
      Number(saved.repeatCount)===-1 && Number(saved.intervalMinutes)===7;
    const savedFeedback=root.querySelector(".cq-action-feedback")?.textContent||"";
    checks.savedPersistedFeedback=savedFeedback.includes("已保存") &&
      /9\\s*分钟/.test(savedFeedback) && /3\\s*次/.test(savedFeedback) &&
      !savedFeedback.includes("7 分钟") && !savedFeedback.includes("无限次");
    const persistedHandoff={...state.handoff};
    const hoverNow=Date.now();
    state.handoff.nextAt=hoverNow+272000;
    window.__cqHandoffProbe.hover(hoverNow);
    checks.nextTriggerCountdown=button()?.title.includes("04:32") &&
      button()?.closest(".cq-handoff-hover-area")?.title===button()?.title &&
      !button()?.title.includes("已至少持续") &&
      automatic()?.title.includes("当前对话已至少持续");
    window.__cqHandoffProbe.hover(hoverNow+1000);
    checks.countdownUpdates=button()?.title.includes("04:31");
    state.handoff={...state.handoff,enabled:false,remainingCount:0,nextAt:null};
    window.__cqHandoffProbe.hover(hoverNow);
    checks.exhaustedTooltip=/次数.*用完|次数.*耗尽/.test(button()?.title) &&
      !button()?.title.includes("00:00");
    state.handoff={...persistedHandoff};
    window.__cqHandoffProbe.hover();
    manual().click();
    manual().click();
    await new Promise(resolve=>setTimeout(resolve,70));
    checks.startAcknowledged=root.querySelector(".cq-action-feedback")?.textContent
      .includes("交接命令已加入队列末尾");
    checks.onlyOnce=calls.filter(type=>type==="HANDOFF_NOW").length===1;
    checks.queued=state.handoff.phase==="queued" && state.tasks.length===1 &&
      manual()?.disabled===true;
    checks.manualPreservesAuto=state.handoff.enabled===true && state.handoff.repeatCount===3 &&
      state.handoff.manualRequested===true;
    const queuedTooltip=button()?.closest(".cq-handoff-hover-area")?.title||"";
    checks.handoffTooltip=/已入队|已加入队列|等待.*执行|等待.*交接|排队/.test(queuedTooltip) &&
      !queuedTooltip.includes("00:00") && !queuedTooltip.includes("当前对话已至少持续");
    root.querySelector('.cq-handoff-page [data-action="cancel-handoff"]').click();
    await new Promise(resolve=>setTimeout(resolve,70));
    checks.explicitCancel=state.handoff.phase==="idle" && state.tasks.length===0 &&
      calls.filter(type=>type==="CANCEL_HANDOFF").length===1;
    manual().click();
    await new Promise(resolve=>setTimeout(resolve,70));
     state.handoff={...state.handoff,phase:"failed",error:"当前接力校验失败"};
     root.querySelector('[data-action="toggle-queue"]').click();
     checks.collapsedFailureExplained=root.querySelector(
       '.cq-handoff-collapse-error[role="alert"]')?.textContent
       .includes("当前接力校验失败") &&
       !root.querySelector(".cq-action-feedback")?.textContent.includes("已启动接力");
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
     state.handoff={phase:"summarizing",enabled:false,intervalMinutes:120};
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
     markdown.textContent="继续回复帖子。";
     const second=document.createElement("div");
     second.className="markdown";
     second.textContent="";
     assistant.append(markdown,second);
     const copy=document.createElement("button");
     copy.setAttribute("aria-label","复制");
     article.append(assistant,copy);
     document.querySelector("main").append(article);
     const probe=window.__cqHandoffProbe;
     const shortSnapshot=probe.snapshot();
     checks.shortSummary=probe.extract(shortSnapshot).text==="继续回复帖子。";
     markdown.textContent="本次总结中的工作目录、决策与后续步骤。".repeat(800);
     second.textContent="仍需解决的问题及下一步操作顺序。".repeat(15);
     const snapshot=probe.snapshot();
     checks.longSummary=probe.extract(snapshot).text.length>12000 &&
       probe.extract(snapshot).text===snapshot.lastAssistantText &&
       probe.extract(snapshot).text.includes(markdown.textContent) &&
       probe.extract(snapshot).text.includes(second.textContent);
     checks.plainReply=snapshot.lastAssistantText.includes("工作目录") &&
       snapshot.lastAssistantText.includes("下一步操作顺序") &&
       probe.extract(snapshot).text===snapshot.lastAssistantText &&
       !probe.extract(snapshot).text.includes("复制") &&
       !probe.extract(snapshot).text.includes("CHATGPT_TASKQUEUE_HANDOFF");
     const virtualized={...summaryTask,id:"virtualized",
       baselineAssistantCount:snapshot.assistantCount,
       baselineAssistantId:snapshot.lastAssistantId,
       baselineAssistantSignature:"22|此前的助手回复",
       baselineUserCount:snapshot.userCount-1};
     checks.stopPreventsCompletion=probe.ready()===false &&
       probe.completion(summaryTask,snapshot).ready===false;
     nativeStop.remove();
     checks.virtualizedTurn=probe.completion(virtualized,probe.snapshot()).newerAssistant===true;
     checks.noPrematureComplete=probe.completion(summaryTask,probe.snapshot()).ready===false;
     probe.composerReady(probe.snapshot());
     await new Promise(resolve=>setTimeout(resolve,5100));
     checks.nativeFallbackCompletes=probe.ready()===false &&
       probe.completion(summaryTask,probe.snapshot()).ready===true;
     // The worker used to drop kind in dispatch, despite the owned record
     // being an internal handoff. Only dictation is present in this fixture.
     summaryTask.status="dispatching";
     summaryTask.kind="handoff_intro";
     summaryTask.text="任务主题：回复帖子\\n"+snapshot.lastAssistantText;
     const nativeSend=document.createElement("button");
     nativeSend.type="button";
     nativeSend.dataset.testid="send-button";
     nativeSend.setAttribute("aria-label","Send");
     let nativeSendClicks=0;
     let submittedText="";
     nativeSend.addEventListener("click",()=>{
       nativeSendClicks++;
       submittedText=document.querySelector('[data-testid="composer-input"]').innerText;
       document.querySelector('[data-testid="composer-input"]').textContent="";
     });
     document.querySelector("form").append(nativeSend);
     await probe.send({id:summaryTask.id,text:summaryTask.text,images:[]});
     checks.ownedHandoffDispatch=nativeSendClicks===1 && calls.includes("SENT") &&
       submittedText===summaryTask.text;
  }catch(error){checks.error=String(error);}
  checks.ok=["emptyQueue","enabled","estimatedAge","disabledTooltip","nativeMessageTime",
     "opensSettings","disabledSaveAcknowledged","savedCountdown","savedPersistedFeedback",
     "nextTriggerCountdown","countdownUpdates","exhaustedTooltip","startAcknowledged","onlyOnce","queued",
     "manualPreservesAuto","handoffTooltip","explicitCancel",
     "collapsedFailureExplained","failedNotice","failedRecovery","shortSummary","longSummary","plainReply","virtualizedTurn",
     "stopPreventsCompletion","noPrematureComplete","nativeFallbackCompletes","ownedHandoffDispatch"]
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
