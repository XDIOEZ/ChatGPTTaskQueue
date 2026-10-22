"use strict";

// Browser regression for ChatGPT's own red "消息传输超时" notice. Unlike an
// extension FAIL, the page error must be detected before Voice says "done".
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const browser = process.env.CQ_BROWSER_BIN || (process.platform === "win32"
  ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
  : "/usr/bin/google-chrome");

test("原生消息传输超时先隔离并等待错误消失后继续；不点重试、不误认引用文字、不解除手动暂停", {
  skip: !fs.existsSync(browser) && "Chrome is not installed",
}, () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "cq-native-timeout-"));
  try {
    const source = fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8")
      .replace(/\r\n/g, "\n");
    const guard = "if (!state || !sessionKey || !validUrl(location.href)) return false;";
    const end = "  void init();\n})();";
    assert.ok(source.includes(guard) && source.includes(end));
    fs.writeFileSync(path.join(folder, "content.js"), source
      .replace(guard,
        "if (!state || !sessionKey || (!validUrl(location.href) && !location.href.startsWith('file:'))) return false;")
      .replace('return Boolean(sessionKey?.startsWith("draft:") && !pageChatKey(location.href));',
        'return location.protocol === "file:" ? false : Boolean(sessionKey?.startsWith("draft:") && !pageChatKey(location.href));')
      .replace(end, `  window.__nativeErrorTest = {
        snapshot: conversationSnapshot,
        ready: updateVoiceReadiness,
        detect: nativeTransportErrorVisible,
        heartbeat,
        forceStable() { voiceReadySince = Date.now() - 2500; },
        state: () => state,
      };
      ${end}`));

    fs.writeFileSync(path.join(folder, "index.html"), `<!doctype html>
<html><head><meta charset="utf-8"><title>ChatGPT native transport failure</title></head><body>
<main>
 <div id="conversation">
  <div data-message-author-role="user" data-message-id="u0">
   <div data-testid="user-message">请处理当前请求</div>
  </div>
  <div data-message-author-role="assistant" data-message-id="a0">
   <div data-message-content>Waiting for a tool result.</div>
  </div>
 </div>
 <div id="server-error">
  <div>消息传输超时。请重试。</div>
  <button type="button" id="native-retry">重试</button>
 </div>
 <form>
  <textarea id="prompt-textarea"></textarea>
  <button type="button" id="send" data-testid="send-button" aria-label="Send prompt" style="display:none">发送</button>
  <button type="button" id="mic" aria-label="Start dictation">听写</button>
  <button type="button" id="voice" aria-label="Start Voice">语音模式</button>
  <button type="button" id="stop" data-testid="stop-button" aria-label="Stop generating" style="display:none">停止</button>
 </form>
</main>
<script>
const log={events:[], failed:[], finished:[], sent:[], recovered:0, nativeRetries:0};
const editor=document.querySelector('#prompt-textarea');
const send=document.querySelector('#send');
const voice=document.querySelector('#voice');
const stop=document.querySelector('#stop');
const errorBox=document.querySelector('#server-error');
document.querySelector('#native-retry').addEventListener('click',()=>log.nativeRetries++);
const state={key:'draft:1',halted:false,haltReason:null,activeTaskId:'bad',
  steeringTaskId:null,error:'',tasks:[
    {id:'bad',text:'无法确认结果的旧任务',status:'waiting',sentAt:Date.now()-20000},
    {id:'next',text:'要继续的下一条',status:'pending'},
  ],schedules:[],autoOpenTab:false};
function updateButtons(){
  const composing=!!editor.value.trim();
  send.style.display=composing?'':'none';
  voice.style.display=composing||stop.style.display!=='none'?'none':'';
}
editor.addEventListener('input',updateButtons);
send.addEventListener('click',()=>{
  const text=editor.value;
  if(!text.trim())return;
  log.sent.push(text);
  editor.value='';
  stop.style.display='';
  updateButtons();
  const turn=document.createElement('div');
  turn.setAttribute('data-message-author-role','user');
  turn.innerHTML='<div data-testid="user-message"></div>';
  turn.firstChild.textContent=text;
  document.querySelector('#conversation').append(turn);
  setTimeout(()=>{
    const assistant=document.createElement('div');
    assistant.setAttribute('data-message-author-role','assistant');
    assistant.innerHTML='<div class="markdown">成功完成新的回复</div>';
    document.querySelector('#conversation').append(assistant);
    stop.style.display='none';updateButtons();
  },300);
});
window.chrome={
 runtime:{onMessage:{addListener(){}},async sendMessage(msg){
  log.events.push(msg.type);
  let dispatch=null;
  if(msg.type==='FAIL'){
    const task=state.tasks.find(t=>t.id===msg.id);
    if(task&&task.status==='waiting'){
      log.failed.push(task.id);task.status='error';task.error=msg.error;
      state.activeTaskId=null;state.halted=true;state.haltReason='failure';
    }
  }
  if(msg.type==='RECOVER_ON_VOICE'&&state.haltReason==='failure'&&
     msg.voiceReady&&msg.voiceStableMs>=1700&&!msg.busy&&msg.editorEmpty){
    state.halted=false;state.haltReason=null;state.error='';log.recovered++;
  }
  if(msg.type==='CLAIM'&&!state.halted&&!state.activeTaskId&&msg.ready){
    const task=state.tasks.find(t=>t.status==='pending');
    if(task){task.status='dispatching';state.activeTaskId=task.id;
      dispatch={id:task.id,text:task.text,baselineUserCount:msg.userCount};}
  }
  if(msg.type==='SENT'){
    const task=state.tasks.find(t=>t.id===msg.id);
    if(task){task.status='waiting';task.sentAt=Date.now();}
  }
  if(msg.type==='FINISHED'){
    const task=state.tasks.find(t=>t.id===msg.id);
    if(task&&task.status==='waiting'&&msg.voiceReady&&msg.voiceStableMs>=1700){
      log.finished.push(task.id);
      state.tasks.splice(state.tasks.indexOf(task),1);state.activeTaskId=null;
    }
  }
  return {ok:true,state,sessionKey:'draft:1',dispatch};
 }},storage:{onChanged:{addListener(){}}}
};
</script>
<script src="./content.js"></script>
<script>
let proseIgnored=false,nativeDetected=false,heldWhileError=false;
setTimeout(()=>{
  const h=window.__nativeErrorTest;
  const bubble=document.querySelector('[data-testid="user-message"]');
  bubble.textContent='原文引用：消息传输超时。请重试。';
  errorBox.style.display='none';
  proseIgnored=!h.detect();
  errorBox.style.display='';
  nativeDetected=h.detect();
  // A Voice button next to a persistent transport error must not resume work.
  h.ready(h.snapshot());h.forceStable();
},350);
setTimeout(()=>{
  heldWhileError=state.halted&&log.failed.length===1&&log.recovered===0&&log.sent.length===0;
  // Simulate the healthy page after refresh; uncertain work is never replayed.
  errorBox.style.display='none';
  const h=window.__nativeErrorTest;h.ready(h.snapshot());h.forceStable();
},6000);
setTimeout(async()=>{
  const h=window.__nativeErrorTest;
  state.halted=true;state.haltReason='user';
  state.tasks.push({id:'manual-stop',text:'用户暂停后不能发送',status:'pending'});
  h.ready(h.snapshot());h.forceStable();
  await h.heartbeat();
  const flags={
    detectsNativeTimeout:nativeDetected,
    persistentErrorHoldsQueue:heldWhileError,
    proseNotNativeError:proseIgnored,
    firstQuarantined:log.failed.length===1&&log.failed[0]==='bad'&&
      state.tasks[0].status==='error',
    firstNeverFinished:!log.finished.includes('bad'),
    recoveredOnce:log.recovered===1,
    onlyNextSent:log.sent.length===1&&log.sent[0]==='要继续的下一条',
    nextFinished:log.finished.length===1&&log.finished[0]==='next',
    neverClickedRetry:log.nativeRetries===0,
    manualStopHeld:state.halted&&state.haltReason==='user',
    manualTaskPending:state.tasks.find(t=>t.id==='manual-stop')?.status==='pending',
  };
  document.body.dataset.result=JSON.stringify({ok:Object.values(flags).every(Boolean),
    ...flags,events:log.events.slice(-24)});
},15500);
</script>
</body></html>`);

    const result = spawnSync(browser, [
      "--headless=new", "--disable-gpu", "--disable-extensions", "--no-first-run",
      `--user-data-dir=${path.join(folder, "profile")}`,
      "--virtual-time-budget=19000", "--dump-dom",
      `file:///${path.join(folder, "index.html").replace(/\\/g, "/")}`,
    ], { encoding:"utf8", timeout:30000, maxBuffer:8e6 });
    assert.equal(result.status, 0, result.stderr || "Chrome failed");
    const match = result.stdout.match(/data-result="([^"]+)"/);
    assert.ok(match, "Transport error DOM test did not finish");
    const flags = JSON.parse(match[1].replace(/&quot;/g, '"'));
    assert.equal(flags.ok, true, JSON.stringify(flags));
  } finally {
    fs.rmSync(folder, {recursive:true,force:true});
  }
});
