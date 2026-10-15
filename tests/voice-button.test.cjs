"use strict";

// Real Chrome DOM regression: the waveform Voice Mode button, not the
// dictation microphone, drives both a timed task and its follow-up turns.
// Test-only hooks and file:// allowances are never written to content.js.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const browserPath = process.env.CQ_BROWSER_BIN || (process.platform === "win32"
  ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
  : "/usr/bin/google-chrome");

test("语音模式按钮控制定时任务连续三轮发送；麦克风、停止生成、工具调用均不会误触发", {
  skip: !fs.existsSync(browserPath) && "Chrome is not installed",
}, () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "cq-voice-dom-"));
  try {
    const source = fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8");
    const guard = "if (!state || !sessionKey || !validUrl(location.href)) return false;";
    const end = "  void init();\n})();";
    assert.ok(source.includes(guard) && source.includes(end));
    const hooks = source.replace(guard,
      "if (!state || !sessionKey || (!validUrl(location.href) && !location.href.startsWith('file:'))) return false;")
      .replace('return Boolean(sessionKey?.startsWith("draft:") && !pageChatKey(location.href));',
        'return location.protocol === "file:" ? false : Boolean(sessionKey?.startsWith("draft:") && !pageChatKey(location.href));')
      .replace(end, `  window.__cqVoiceTest = {
          snapshot: conversationSnapshot,
          controls,
          ready: updateVoiceReadiness,
          idle: updateIdle,
          canComplete: readyToComplete,
          reset: resetVoiceReadiness,
          forceStable() { voiceReadySince = Date.now() - 2200; },
          bound: boundHere,
          state: () => state,
          forceHeartbeat: heartbeat,
          heartbeatBusy: () => heartbeatInProgress,
          lastClaim: () => lastClaimAttempt,
          debugBusy: () => ({composerActionInProgress,workInProgress,heartbeatInProgress}),
        };
        ${end}`);
    fs.writeFileSync(path.join(temp, "content.js"), hooks);
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>ChatGPT voice test</title>
    <style>#conversation>div{padding:4px} form{display:flex;gap:6px;margin-top:16px}</style></head><body>
    <main>
      <div id="conversation">
        <div data-message-author-role="user" data-message-id="u0"><div data-testid="user-message">最初的问题</div></div>
        <div data-message-author-role="assistant" data-message-id="a0"><div class="markdown">最初的答复</div></div>
      </div>
      <form id="form">
        <textarea id="prompt-textarea"></textarea>
        <button type="button" id="send" data-testid="send-button" aria-label="Send prompt" style="display:none">发送</button>
        <button type="button" id="mic" aria-label="Start dictation">麦克风</button>
        <button type="button" id="voice" aria-label="Start Voice">语音模式</button>
        <button type="button" id="stop" data-testid="stop-button" aria-label="Stop generating" style="display:none">停止生成</button>
      </form>
    </main>
    <div id="result">LOADING</div>
    <script>
      const app = { tasks: [], finished: [], sent: [], activeId: null, runCount: 0,
        chats: [], queuePending: false, events: [], scheduledWhileActive: 0 };
      const editor = document.getElementById('prompt-textarea');
      const send = document.getElementById('send');
      const voice = document.getElementById('voice');
      const stop = document.getElementById('stop');
      const mic = document.getElementById('mic');
      let replyNumber = 0;
      function setButtons() {
        const hasText = !!editor.value.trim();
        send.style.display = hasText ? '' : 'none';
        if (hasText || stop.style.display !== 'none') voice.style.display = 'none';
        else voice.style.display = '';
      }
      editor.addEventListener('input', setButtons);
      send.addEventListener('click', () => {
        if (!editor.value.trim()) return;
        const text = editor.value;
        app.sent.push(text);
        editor.value = '';
        stop.style.display = '';
        voice.style.display = 'none';
        setButtons();
        ++replyNumber;
        // On turn 2, ChatGPT's DOM exposes NEITHER the user bubble NOR the
        // assistant body. The voice button alone must still unlock the queue.
        if (replyNumber !== 2) {
          const user = document.createElement('div');
          user.setAttribute('data-message-author-role','user');
          user.setAttribute('data-message-id','u'+replyNumber);
          user.innerHTML = '<div data-testid="user-message"></div>';
          user.firstElementChild.textContent = text;
          document.getElementById('conversation').append(user);
        }
        setTimeout(() => {
          if (replyNumber !== 2) {
            const assistant = document.createElement('div');
            assistant.setAttribute('data-message-author-role','assistant');
            assistant.setAttribute('data-message-id','a'+replyNumber);
            assistant.innerHTML='<div class="markdown">已完成定时回复 '+replyNumber+'</div>';
            document.getElementById('conversation').append(assistant);
          }
          stop.style.display='none';
          setButtons();
        }, 260);
      });

      const session = { key:'draft:1', halted:false, activeTaskId:null,
        tasks:app.tasks, schedules:[], error:'', autoOpenTab:false };
      function nextScheduled() {
        if (app.runCount >= 3) return;
        app.runCount++;
        session.tasks.push({ id:'sched-'+app.runCount, text:'定时第'+app.runCount+'轮',
          status:'pending', sourceScheduleId:'scheduled-loop', createdAt:Date.now() });
        if (session.activeTaskId) app.scheduledWhileActive++;
      }
      window.chrome = {
        runtime: { onMessage:{addListener(){}}, async sendMessage(msg) {
          app.events.push(msg.type);
          let dispatch = null;
          if (msg.type==='CLAIM' && !session.activeTaskId && msg.ready) {
            const task = session.tasks.find(t=>t.status==='pending');
            if (task) {
              task.status='dispatching';
              task.baselineAssistantCount=msg.assistantCount;
              task.baselineUserCount=msg.userCount;
              task.baselineUserId=msg.lastUserId;
              task.baselineAssistantId=msg.lastAssistantId;
              task.baselineAssistantSignature=msg.lastAssistantSignature;
              session.activeTaskId=task.id;
              dispatch={ id:task.id, text:task.text,
                baselineUserCount:msg.userCount, baselineUserId:msg.lastUserId };
            }
          }
          if (msg.type==='SENT') {
            const task=session.tasks.find(t=>t.id===msg.id);
            if (task && task.status==='dispatching') {
              task.status='waiting'; task.sentAt=Date.now();
            }
          }
          if (msg.type==='FINISHED') {
            const task=session.tasks.find(t=>t.id===msg.id);
            if (!msg.voiceReady || msg.voiceStableMs<1700 || !msg.editorEmpty || !task ||
                task.status!=='waiting' || msg.busy) {
              return {ok:false,error:'voice evidence missing'};
            }
            app.finished.push(task.id);
            session.tasks.splice(session.tasks.indexOf(task),1);
            session.activeTaskId=null;
          }
          if (msg.type==='FAIL') {
            session.halted=true;
            return {ok:false,error:'Unexpected send failure'};
          }
          return {ok:true,state:session,sessionKey:'draft:1',dispatch};
        } },
        storage:{onChanged:{addListener(){}}},
      };
    </script>
    <script src="./content.js"></script>
    <script>
      setTimeout(async () => {
        const h=window.__cqVoiceTest;
        const flags={};
        flags.voiceDetected=!!h.controls().voice;
        voice.style.display='none';
        flags.micNotVoice=!h.controls().voice && !!mic.getClientRects().length &&
          h.ready(h.snapshot())===false;
        voice.style.display='';
        h.reset(); h.ready(h.snapshot()); h.forceStable();
        flags.voiceIdle=h.ready(h.snapshot()) && h.idle(h.snapshot(),h.ready(h.snapshot()));
        stop.style.display='';
        flags.stopPrevents=h.ready(h.snapshot())===false;
        stop.style.display='none';
        const newTool=document.createElement('div');
        newTool.setAttribute('data-message-author-role','assistant');
        newTool.innerHTML='<div data-message-content>Waiting for a tool result.</div>';
        document.getElementById('conversation').append(newTool);
        // Tool labels alone no longer gate readiness; native Stop does.
        stop.style.display='';
        flags.toolWithStopPrevents=h.ready(h.snapshot())===false;
        stop.style.display='none';
        h.reset();h.ready(h.snapshot());h.forceStable();
        flags.toolTextDoesNotBlockVoice=h.ready(h.snapshot())===true;
        newTool.remove();
        editor.value='未发出的草稿';
        flags.draftPrevents=h.ready(h.snapshot())===false;
        editor.value='';
        const unsentTask={id:'not-sent',text:'虚构任务',status:'pending',sentAt:Date.now()-10000};
        const clickedTask={...unsentTask,status:'waiting'};
        flags.mustHaveClicked=h.canComplete(unsentTask,true)===false &&
          h.canComplete({...clickedTask,sentAt:Date.now()},true)===false &&
          h.canComplete(clickedTask,true)===true;
        nextScheduled();
        h.reset(); h.ready(h.snapshot()); h.forceStable();
        await h.forceHeartbeat();
        // Timer ticks run independently of FINISHED. They enqueue while the
        // first task is still being processed by ChatGPT.
        setTimeout(nextScheduled, 700);
        setTimeout(nextScheduled, 1400);
        // The queue heartbeat sends each task in order.
      }, 450);
      setTimeout(() => {
        const flags=window.__cqVoiceFlags || {};
        const result={
          voiceDetected: !!window.__cqVoiceTest.controls().voice,
          scheduledSent3: app.sent.join('|')==='定时第1轮|定时第2轮|定时第3轮',
          completed3: app.finished.join('|')==='sched-1|sched-2|sched-3',
          timerProduced3: app.runCount===3,
          timerAddedDuringReply: app.scheduledWhileActive>=1,
          noDeliveryConfirmationCalls: !app.events.includes('CONFIRM_DELIVERY'),
          noDuplicates: new Set(app.sent).size===app.sent.length,
          allRemoved: session.tasks.length===0 && session.activeTaskId===null,
          notHalted: !session.halted,
          ...window.__cqVoiceManualFlags,
        };
        const ok=Object.values(result).every(Boolean);
        document.body.dataset.voiceTest=JSON.stringify({ok,...result, sent:app.sent, finished:app.finished,
          remaining:session.tasks.map(t=>({text:t.text,status:t.status})),halted:session.halted,
          debug:{bound:window.__cqVoiceTest.bound(),
            ready:window.__cqVoiceTest.ready(window.__cqVoiceTest.snapshot()),
            idle:window.__cqVoiceTest.idle(window.__cqVoiceTest.snapshot(),true),
            flags:window.__cqVoiceTest.debugBusy(),
            lastClaim:window.__cqVoiceTest.lastClaim(), now:Date.now(),
            stateActive:window.__cqVoiceTest.state()?.activeTaskId,
            voice:!!window.__cqVoiceTest.controls().voice,
            lastRole:window.__cqVoiceTest.snapshot().lastRole,
            rootText:document.querySelector('#cq-extension-root')?.textContent?.slice(0,180),
            events:app.events.slice(-35)}});
        document.getElementById('result').textContent=ok?'VOICE_PASS':'VOICE_FAIL';
      }, 20500);
    </script>
    </body></html>`;
    // Collect the early button-state checks for the final assertion.
    const page = html.replace("nextScheduled();\n        h.reset();",
      "window.__cqVoiceManualFlags=flags;\n        nextScheduled();\n        h.reset();");
    fs.writeFileSync(path.join(temp, "voice-test.html"), page);
    const result = spawnSync(browserPath, [
      "--headless=new", "--disable-gpu", "--disable-extensions", "--no-first-run",
      `--user-data-dir=${path.join(temp, "profile")}`,
      "--virtual-time-budget=23000", "--dump-dom",
      `file:///${path.join(temp, "voice-test.html").replace(/\\/g, "/")}`,
    ], { encoding:"utf8", timeout:30000, maxBuffer:8e6 });
    assert.equal(result.status, 0, result.stderr || "Chrome exited unexpectedly");
    const match = result.stdout.match(/data-voice-test="([^"]+)"/);
    assert.ok(match, "Voice button DOM test was not completed");
    const flags = JSON.parse(match[1].replace(/&quot;/g,'"').replace(/&amp;/g,'&'));
    assert.equal(flags.ok, true, JSON.stringify(flags));
  } finally {
    fs.rmSync(temp, { recursive:true, force:true });
  }
});
