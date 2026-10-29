"use strict";

// Real Chrome DOM regression for the simplified Voice Mode completion gate.
// Message virtualization, missing bubbles, and changing thinking text must
// NOT block a clicked task from completing when the waveform button returns.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawnSync } = require("node:child_process");

const browser = process.env.CQ_BROWSER_BIN || (process.platform === "win32"
  ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
  : "/usr/bin/google-chrome");

test("原生 Voice 按钮是唯一完成信号，不依赖回复正文或消息气泡", {
  skip: !fs.existsSync(browser) && "Chrome is not installed",
}, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cq-voice-only-"));
  try {
    const content = fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8");
    const marker = /  void init\(\);\r?\n\}\)\(\);/;
    assert.match(content, marker);
    const injected = content.replace(marker, (original) => `  window.__cqVoiceOnly = {
      snapshot: conversationSnapshot, shapes: remoteUserNodeShapes,
      remoteFirstUserCount, remoteReplyEvidence,
      ready: updateVoiceReadiness,
      complete: readyToComplete,
      reset: resetVoiceReadiness,
      forceStable() { voiceReadySince = Date.now() - 2200; },
    };
    ${original}`);
    fs.writeFileSync(path.join(dir, "content.js"), injected);
    fs.writeFileSync(path.join(dir, "index.html"), `<!doctype html>
<html><head><meta charset="utf-8"><title>ChatGPT DOM test</title></head><body>
<main>
  <div id="conversation">
    <div data-message-author-role="user" data-message-id="u1"><div data-testid="user-message">旧问题</div></div>
    <div data-message-author-role="assistant" data-message-id="a1">
      <span id="thinking">思考了 11s</span><div class="markdown">旧回答</div>
    </div>
  </div>
  <form>
    <textarea id="prompt-textarea"></textarea>
    <button type="button" aria-label="Start dictation" id="mic">听写</button>
    <button type="button" aria-label="Start Voice" id="voice">语音</button>
    <button type="button" aria-label="Stop generating" data-testid="stop-button" id="stop" style="display:none">停止</button>
  </form>
</main>
<script>
window.chrome = { runtime: { id:'test-extension', onMessage:{addListener(fn){window.__cqMessage=fn;}}, async sendMessage() {
  return { ok:true, state:{key:'draft:1',halted:false,tasks:[],schedules:[],activeTaskId:null},
    sessionKey:'draft:1',dispatch:null };
}}, storage:{onChanged:{addListener(){}}} };
</script>
<script src="./content.js"></script>
<script>
setTimeout(async () => {
  const h = window.__cqVoiceOnly;
  const flags = {};
  const voice = document.getElementById('voice');
  const stop = document.getElementById('stop');
  const mic = document.getElementById('mic');
  const editor = document.getElementById('prompt-textarea');
  const task = {id:'clicked',status:'waiting',sentAt:Date.now()-10000,deliveryVerified:false};

  voice.style.display='none';
  flags.micIgnored = h.ready(h.snapshot()) === false && !!mic.getClientRects().length;
  voice.style.display='';
  h.reset();
  flags.needsStable = h.ready(h.snapshot()) === false;
  h.forceStable();
  const ready = h.ready(h.snapshot());
  flags.readyAfterStable = ready === true;
  flags.waitingWithoutBubbleCompletes = h.complete(task,ready) === true;
  flags.notClickedCannotComplete = h.complete({...task,status:'pending'},true) === false;
  flags.justClickedCannotComplete = h.complete({...task,sentAt:Date.now()},true) === false;

  // No new messages were added. Updating the entire old assistant subtree
  // cannot reset the native button's stable readiness timer.
  document.getElementById('thinking').textContent='思考了 1234s';
  document.getElementById('conversation').innerHTML='';
  flags.virtualizationIgnored = h.ready(h.snapshot()) === true && h.complete(task,true);

  // Current ChatGPT uses semantic search units instead of message-author
  // wrappers. The assistant role on its heading must not count as a turn.
  const conversation=document.getElementById('conversation');
  conversation.innerHTML=
    '<div data-talvt-turn-state="complete">' +
      '<div data-chatgpt-search-message-ids="native-user-id">' +
        '<div data-content-search-unit-key="fallback-turn-0:0:user">' +
          '<div data-user-message-bubble="true">新对话首条队列消息</div>' +
        '</div></div>' +
      '<div data-content-search-unit-key="fallback-turn-0:6:assistant">' +
        '<h4 data-conversation-role="assistant">ChatGPT 说：</h4>' +
        '<div data-chatgpt-selection-message-id="native-assistant-id">' +
          '<div data-markdown-text-style="assistant-message">本轮回复已经完成</div>' +
        '</div><button aria-label="复制">复制</button>' +
      '</div>' +
    '</div>';
  const nativeSnapshot=h.snapshot();
  flags.currentLayoutTurns=nativeSnapshot.userCount===1 && nativeSnapshot.assistantCount===1 &&
    nativeSnapshot.lastRole==='assistant';
  flags.currentLayoutUser=nativeSnapshot.lastUserText==='新对话首条队列消息' &&
    nativeSnapshot.lastUserId==='native-user-id';
  flags.currentLayoutAssistant=nativeSnapshot.lastAssistantText==='本轮回复已经完成' &&
    nativeSnapshot.lastAssistantId==='native-assistant-id' &&
    !nativeSnapshot.lastAssistantText.includes('ChatGPT 说');
  const bubble=conversation.querySelector('[data-user-message-bubble]');
  const authored='交接正文里保留“显示更多”这几个字。'+ '目标、约束和下一步操作。'.repeat(24);
  bubble.innerHTML='<div data-search-result-target=""></div>' +
    '<button type="button" aria-expanded="false">显示更多</button>' +
    '<button type="button" aria-label="复制消息">复制消息</button>';
  bubble.firstElementChild.textContent=authored;
  const folded=h.snapshot();
  flags.foldedUserBodyOnly=folded.lastUserText===authored && folded.lastUserFolded===true;
  bubble.firstElementChild.textContent=authored.slice(0,200)+'…';
  const preview=h.snapshot();
  flags.foldedPreviewAnnotated=preview.lastUserText===authored.slice(0,200)+'…' &&
    preview.lastUserFolded===true;
  bubble.querySelector('button').remove();
  flags.foldFlagNeedsNativeControl=h.snapshot().lastUserFolded===false;
  const content=bubble.querySelector('[data-search-result-target]');
  content.removeAttribute('data-search-result-target');
  const fallback=h.snapshot();
  flags.foldedFallbackStillExcludesControls=!fallback.lastUserText.includes('复制消息');
  // Three selected user-shaped nodes but only one authored message. The
  // metadata shows where they live and never includes the message body.
  conversation.innerHTML='<div data-talvt-turn-state="complete">' +
    '<h4 data-conversation-role="user">用户说</h4>'+
    '<div data-chatgpt-search-message-ids="native-user-id">'+
      '<div data-content-search-unit-key="fallback-turn-0:0:user">'+
        '<div data-user-message-bubble="true">私密测试消息</div></div></div>'+
    '<div data-content-search-unit-key="fallback-turn-0:6:assistant">'+
      '<div class="markdown">测试回复</div></div></div>';
  const extra=document.createElement('aside');
  extra.innerHTML='<span data-conversation-role="user">侧栏</span>';
  document.body.insertBefore(extra,document.querySelector('main'));
  const shapeSnapshot=h.snapshot(), shapes=h.shapes(shapeSnapshot);
  flags.structuralDiagnostics=shapeSnapshot.userCount===3 && shapes.length===3 &&
    shapes[0].inMain===false && shapes[1].inMain===true && shapes[1].path[0].tag==='h4' &&
    shapes[1].path[0].mask===4 && shapes[1].sameContainerAsLast===true &&
    shapes[2].sameTextAsLast===true && shapes[2].hasId===true;
  flags.structuralDiagnosticsNoText=!JSON.stringify(shapes).includes('私密测试消息') &&
    !JSON.stringify(shapes).includes('native-user-id');
  extra.remove();

  const user='相同的用户消息', userTurn=(id,hidden=false)=>
    '<div data-talvt-turn-state="complete"'+(hidden?' style="visibility:hidden"':'')+'>'+
      '<div data-chatgpt-search-message-ids="'+id+'">'+
      '<div data-content-search-unit-key="'+id+':user"><div data-user-message-bubble="true">'+
      user+'</div></div></div></div>';
  const assistant='<div data-talvt-turn-state="complete"><div data-content-search-unit-key="answer:assistant">'+
    '<div class="markdown">最终回复</div></div></div>';
  const shadow=(text=user)=>'<div style="visibility:hidden"><div><div data-user-message-bubble="true">'+
    text+'</div></div></div>';
  const remoteTask={remoteJobId:'remote',remoteCaptureResult:true,remoteNewChat:true,text:user,
    baselineUserCount:0,baselineAssistantCount:0};
  conversation.innerHTML=shadow()+userTurn('u1')+assistant;
  const duplicated=h.snapshot(), evidence=h.remoteReplyEvidence(remoteTask,duplicated);
  flags.countUnchangedForOtherPluginLogic=duplicated.userCount===2;
  flags.invisibleOrphanCountCorrected=h.remoteFirstUserCount(duplicated,user)===1;
  flags.completedResultUsesCorrectedCount=evidence?.userCount===1 && evidence.rawUserCount===2 &&
    evidence.mirrorIgnored===true && evidence.replyText==='最终回复';
  flags.existingChatDoesNotUseCorrection=h.remoteReplyEvidence({...remoteTask,remoteNewChat:false},duplicated)===null;
  flags.nonzeroBaselineDoesNotUseCorrection=h.remoteReplyEvidence({...remoteTask,baselineUserCount:1},duplicated)?.mirrorIgnored!==true;
  const inspect=await new Promise(resolve=>window.__cqMessage({type:'CQ_REMOTE_INSPECT',
    id:'00000000-0000-0000-0000-000000000001',targetUrl:location.href,text:user,captureDiagnostics:true},
    {id:'test-extension'},resolve));
  flags.inspectUsesSameCount=inspect.ok && inspect.confirmationDiagnostic.userCount===1 &&
    inspect.confirmationDiagnostic.domUserCount===2;

  conversation.innerHTML=userTurn('u1')+userTurn('u2')+assistant;
  const twoVisible=h.snapshot();
  flags.twoVisibleIdenticalMessagesStayDistinct=h.remoteFirstUserCount(twoVisible,user)===2 &&
    h.remoteReplyEvidence(remoteTask,twoVisible)===null;
  conversation.innerHTML=userTurn('u1',true)+userTurn('u2')+assistant;
  const hiddenIdentified=h.snapshot();
  flags.hiddenIdentifiedHistoryStaysDistinct=h.remoteFirstUserCount(hiddenIdentified,user)===2 &&
    h.remoteReplyEvidence(remoteTask,hiddenIdentified)===null;
  conversation.innerHTML=shadow('别的用户消息')+userTurn('u1')+assistant;
  flags.otherHiddenTextStaysDistinct=h.remoteFirstUserCount(h.snapshot(),user)===2;
  conversation.innerHTML=shadow()+'<div data-user-message-bubble="true">'+user+'</div>'+assistant;
  flags.noNativeOwnerCannotCorrect=h.remoteFirstUserCount(h.snapshot(),user)===2;
  conversation.innerHTML='';

  stop.style.display='';
  flags.stopPrevents = h.ready(h.snapshot()) === false;
  stop.style.display='none';
  h.reset();h.ready(h.snapshot());h.forceStable();
  editor.value='未发送草稿';
  flags.draftPrevents = h.ready(h.snapshot()) === false;
  editor.value='';
  voice.style.display='none';
  flags.noVoiceNoCompletion = h.ready(h.snapshot()) === false;

  const ok = Object.values(flags).every(Boolean);
  document.body.dataset.observer = JSON.stringify({ok,...flags});
  document.body.insertAdjacentText('beforeend',ok?'VOICE_ONLY_PASS':'VOICE_ONLY_FAIL');
},450);
</script>
</body></html>`);
    const result = spawnSync(browser, [
      "--headless=new", "--disable-gpu", "--disable-extensions", "--no-first-run",
      `--user-data-dir=${path.join(dir, "profile")}`,
      "--virtual-time-budget=2600", "--dump-dom",
      `file:///${path.join(dir, "index.html").replace(/\\/g,"/")}`,
    ], { encoding:"utf8",timeout:20000,maxBuffer:6e6 });
    assert.equal(result.status,0,result.stderr||"Chrome failed");
    const match=result.stdout.match(/data-observer="([^"]+)"/);
    assert.ok(match,"Chrome did not execute the voice-only DOM test");
    const flags=JSON.parse(match[1].replace(/&quot;/g,'"'));
    assert.equal(flags.ok,true,JSON.stringify(flags));
  } finally {
    fs.rmSync(dir,{recursive:true,force:true});
  }
});

test("bridge sanitizes node shape diagnostics",()=>{
  const bridge=require("../remote-bridge.cjs");
  const job=bridge.makeJob({action:"new_chat",captureResult:true,text:"任务",
    target:{kind:"personal",id:"personal",url:"https://chatgpt.com/"}});
  bridge.updateJob(job,{status:"waiting",confirmationDiagnostic:{userCount:2,userNodeShapes:[
    {inMain:true,sameIdAsLast:false,text:"PRIVATE",path:[{tag:"h4",mask:4,text:"SECRET"},
      {tag:"user-input",mask:100000}]},
  ]}});
  const result=JSON.stringify(job.confirmationDiagnostic);
  assert.doesNotMatch(result,/PRIVATE|SECRET|user-input/);
  assert.equal(job.confirmationDiagnostic.userNodeShapes[0].path[0].tag,"h4");
  assert.equal(job.confirmationDiagnostic.userNodeShapes[0].path[1].tag,"other");
});
