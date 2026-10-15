"use strict";

// End-to-end browser DOM smoke: an existing ChatGPT transport error left the
// plugin halted even though the Voice Mode waveform button has returned.
// No real chat is contacted; only a temporary test copy accepts file://.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawnSync } = require("node:child_process");

const browser = process.env.CQ_BROWSER_BIN || (process.platform === "win32"
  ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
  : "/usr/bin/google-chrome");

test("ChatGPT 传输错误恢复语音按钮后自动跳过失败项继续发送；用户暂停仍不能自动恢复", {
  skip: !fs.existsSync(browser) && "Chrome is not installed",
}, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cq-error-recovery-"));
  try {
    const source = fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8");
    const boundGuard = "if (!state || !sessionKey || !validUrl(location.href)) return false;";
    const end = "  void init();\n})();";
    assert.ok(source.includes(boundGuard) && source.includes(end));
    const testContent = source.replace(boundGuard,
      "if (!state || !sessionKey || (!validUrl(location.href) && !location.href.startsWith('file:'))) return false;")
      .replace('return Boolean(sessionKey?.startsWith("draft:") && !pageChatKey(location.href));',
        'return location.protocol === "file:" ? false : Boolean(sessionKey?.startsWith("draft:") && !pageChatKey(location.href));')
      .replace(end, `  window.__cqErrorTest = {
        snapshot: conversationSnapshot,
        heartbeat,
        ready: updateVoiceReadiness,
        forceStable() { voiceReadySince = Date.now() - 2200; },
        state: () => state,
      };
      ${end}`);
    fs.writeFileSync(path.join(directory, "content.js"), testContent);

    fs.writeFileSync(path.join(directory, "index.html"), `<!doctype html>
<html><head><meta charset="utf-8"><title>ChatGPT message transport error</title></head><body>
<main>
  <div id="conversation">
    <div data-message-author-role="user" data-message-id="u0"><div data-testid="user-message">出错的那条消息</div></div>
    <div data-message-author-role="assistant" data-message-id="a0">
      <div class="markdown">消息传输超时，请重试。</div>
    </div>
  </div>
  <form><textarea id="prompt-textarea"></textarea>
    <button type="button" id="send" data-testid="send-button" aria-label="Send prompt" style="display:none">发送</button>
    <button type="button" id="mic" aria-label="Start dictation">听写</button>
    <button type="button" id="voice" aria-label="Start Voice">语音模式</button>
    <button type="button" id="stop" data-testid="stop-button" aria-label="Stop generating" style="display:none">停止生成</button>
  </form>
</main>
<script>
const records = { events:[], sent:[], finished:[], recovered:0 };
const editor=document.querySelector('#prompt-textarea');
const send=document.querySelector('#send');
const voice=document.querySelector('#voice');
const stop=document.querySelector('#stop');
const state={key:'draft:1',halted:true,haltReason:'failure',
  error:'消息传输超时，请重试。',activeTaskId:null,steeringTaskId:null,
  tasks:[{id:'already-failed',text:'出错的那条消息',status:'error'},
    {id:'next-task',text:'下一条正常排队',status:'pending'}],
  schedules:[],autoOpenTab:false};
function updateButtons(){
  const hasDraft=!!editor.value.trim();
  send.style.display=hasDraft?'':'none';
  voice.style.display=hasDraft||stop.style.display!=='none'?'none':'';
}
editor.addEventListener('input',updateButtons);
send.addEventListener('click',()=>{
  const text=editor.value;
  if(!text.trim())return;
  records.sent.push(text);
  editor.value='';stop.style.display='';voice.style.display='none';updateButtons();
  const u=document.createElement('div');
  u.setAttribute('data-message-author-role','user');
  u.innerHTML='<div data-testid="user-message"></div>';
  u.firstElementChild.textContent=text;
  document.querySelector('#conversation').append(u);
  setTimeout(()=>{
    const a=document.createElement('div');
    a.setAttribute('data-message-author-role','assistant');
    a.innerHTML='<div class="markdown">执行完成</div>';
    document.querySelector('#conversation').append(a);
    stop.style.display='none';updateButtons();
  },350);
});
window.chrome={
  runtime:{onMessage:{addListener(){}},async sendMessage(msg){
    records.events.push(msg.type);
    let dispatch=null;
    if(msg.type==='RECOVER_ON_VOICE'){
      if(msg.voiceReady&&msg.voiceStableMs>=1700&&!msg.busy&&msg.editorEmpty&&
         state.halted&&state.haltReason==='failure'){
        state.halted=false;state.haltReason=null;state.error='';records.recovered++;
      }
    }
    if(msg.type==='CLAIM'&&msg.ready&&!state.halted&&!state.activeTaskId){
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
        records.finished.push(task.id);
        state.tasks.splice(state.tasks.indexOf(task),1);
        state.activeTaskId=null;
      }
    }
    if(msg.type==='FAIL'){throw Error('Unexpected FAIL for this test');}
    return {ok:true,state,sessionKey:'draft:1',dispatch};
  }},storage:{onChanged:{addListener(){}}},
};
</script>
<script src="./content.js"></script>
<script>
setTimeout(async()=>{
  const h=window.__cqErrorTest;
  // First observe the genuine waveform after the preexisting transport error.
  h.ready(h.snapshot());h.forceStable();
  await h.heartbeat();
},450);
setTimeout(async()=>{
  const h=window.__cqErrorTest;
  // After successful recovery and completion, simulate a *manual* Stop. The
  // same Voice signal must never override the user's explicit pause.
  state.halted=true;state.haltReason='user';state.error='用户已停止回复';
  state.tasks.push({id:'user-paused-task',text:'用户暂停后不得发送',status:'pending'});
  h.ready(h.snapshot());h.forceStable();
  await h.heartbeat();
  const flags={
    recoveredExactlyOnce:records.recovered===1,
    sentNextOnly:records.sent.length===1&&records.sent[0]==='下一条正常排队',
    completedNext:records.finished.length===1&&records.finished[0]==='next-task',
    failedNeverRetried:state.tasks[0]?.id==='already-failed'&&state.tasks[0]?.status==='error',
    manualStopStillHalted:state.halted===true&&state.haltReason==='user',
    manualStopPendingPreserved:state.tasks.find(t=>t.id==='user-paused-task')?.status==='pending',
    recoveryWasRequested:records.events.includes('RECOVER_ON_VOICE'),
  };
  const ok=Object.values(flags).every(Boolean);
  document.body.dataset.recovery=JSON.stringify({ok,...flags,events:records.events.slice(-25)});
  document.body.insertAdjacentText('beforeend',ok?'RECOVERY_PASS':'RECOVERY_FAIL');
},11500);
</script>
</body></html>`);

    const run = spawnSync(browser, [
      "--headless=new", "--disable-gpu", "--disable-extensions", "--no-first-run",
      `--user-data-dir=${path.join(directory, "profile")}`,
      "--virtual-time-budget=14000", "--dump-dom",
      `file:///${path.join(directory, "index.html").replace(/\\/g,"/")}`,
    ], { encoding:"utf8", timeout:25000, maxBuffer:7e6 });
    assert.equal(run.status,0,run.stderr||"Chrome failed");
    const match=run.stdout.match(/data-recovery="([^"]+)"/);
    assert.ok(match,"Recovery DOM test did not finish");
    const flags=JSON.parse(match[1].replace(/&quot;/g,'"'));
    assert.equal(flags.ok,true,JSON.stringify(flags));
  } finally {
    fs.rmSync(directory,{recursive:true,force:true});
  }
});
