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
    const marker = "  void init();\n})();";
    assert.ok(content.includes(marker));
    const injected = content.replace(marker, `  window.__cqVoiceOnly = {
      snapshot: conversationSnapshot,
      ready: updateVoiceReadiness,
      complete: readyToComplete,
      reset: resetVoiceReadiness,
      forceStable() { voiceReadySince = Date.now() - 2200; },
    };
    ${marker}`);
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
window.chrome = { runtime: { onMessage:{addListener(){}}, async sendMessage() {
  return { ok:true, state:{key:'draft:1',halted:false,tasks:[],schedules:[],activeTaskId:null},
    sessionKey:'draft:1',dispatch:null };
}}, storage:{onChanged:{addListener(){}}} };
</script>
<script src="./content.js"></script>
<script>
setTimeout(() => {
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
