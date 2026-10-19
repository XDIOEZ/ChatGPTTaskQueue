"use strict";

// Real Chromium DOM regression for the Edge vertical-tab completion mark.
// It only notifies for unseen completed replies, until the user views the tab.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const chromePath = process.env.CQ_BROWSER_BIN || (process.platform === "win32"
  ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
  : "/usr/bin/google-chrome");

test("completed background chat remains marked until viewed; running chats spin", {
  skip: !fs.existsSync(chromePath) && "Chrome is not installed",
}, () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "cq-tab-complete-"));
  try {
    const source = fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8");
    assert.ok(source.includes("const VOICE_READY_STABLE_MS = 1700;"));
    assert.ok(source.includes("  void init();\n})();"));
    const tested = source
      .replace("const VOICE_READY_STABLE_MS = 1700;", "const VOICE_READY_STABLE_MS = 120;")
      .replace("if (!state || !sessionKey || !validUrl(location.href)) return false;",
        "if (!state || !sessionKey || (!validUrl(location.href) && !location.href.startsWith('file:'))) return false;")
      .replace('return document.visibilityState === "visible" && document.hasFocus();',
        'return !window.__cqSimulateUnfocused;')
      .replace("  void init();\n})();", `  window.__cqTabCompleteTest = {
        hello: () => rpc("HELLO"),
        finish: (id) => rpc("FINISHED", {id,viewed:isTabViewed()}),
        steer: (id) => rpc("STEER_CONFIRM", {id}),
        tick: heartbeat,
        ready: updateVoiceReadiness,
        snapshot: conversationSnapshot,
      };
      void init();
})();`);
    fs.writeFileSync(path.join(temp, "content-test.js"), tested);

    const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>对话：批量任务</title></head><body>
<main>
  <div data-message-author-role="user" data-message-id="u1"><div data-testid="user-message">旧问题</div></div>
  <div data-message-author-role="assistant" data-message-id="a1"><div class="markdown">旧回答</div></div>
  <form>
    <textarea id="prompt-textarea"></textarea>
    <button type="button" data-testid="send-button">发送</button>
    <button type="button" aria-label="Start dictation">麦克风</button>
    <button type="button" id="voice" aria-label="Start Voice">语音对话</button>
  </form>
</main>
<script>
window.__cqSimulateUnfocused = true;
window.__cqServerState = {
  key:'draft:1', tasks:[], schedules:[], activeTaskId:null, steeringTaskId:null,
  halted:false, error:'', queuePaused:false, unreadCompleted:false,
};
window.__cqLoadState = (patch) => {
  window.__cqServerState = Object.assign({}, window.__cqServerState,
    patch.key && patch.key !== window.__cqServerState.key
      ? {unreadCompleted:false} : {}, patch);
};
window.chrome = {
  runtime: {onMessage:{addListener(){}}, async sendMessage(message) {
    const s = window.__cqServerState;
    if (message.type === "FINISHED") {
      s.tasks = s.tasks.filter((task) => task.id !== message.id);
      s.activeTaskId = null;
      if (message.viewed === false) s.unreadCompleted = true;
    }
    if (message.type === "REPLY_COMPLETED" && message.viewed === false) {
      s.unreadCompleted = true;
    }
    if (message.type === "ACK_COMPLETION_VIEWED") {
      s.unreadCompleted = false;
    }
    if (message.type === "STEER_CONFIRM") {
      s.tasks = s.tasks.filter((task) => task.id !== message.id);
      s.steeringTaskId = null;
    }
    return {ok:true, state:JSON.parse(JSON.stringify(s)),
      sessionKey:s.key, dispatch:null};
  }},
  storage: {onChanged:{addListener(){}}},
};
</script>
<script src="./content-test.js"></script>
<script>
setTimeout(async () => {
  const h = window.__cqTabCompleteTest;
  const voice = document.getElementById('voice');
  const flags = {};
  const titles = {};
  const marked = () => document.title.startsWith('✅ ');
  async function load(patch) {
    window.__cqLoadState(patch);
    await h.hello();
  }
  flags.existingEmptyNotCompleted = !marked();
  await load({tasks:[{id:'pending',status:'pending'}],activeTaskId:null});
  await h.tick();
  flags.pendingQueueNotCompleted = !marked();
  await load({tasks:[]});
  await h.tick();
  flags.deletedPendingNotCompleted = !marked();
  await load({halted:true,tasks:[{id:'error',status:'error'}]});
  flags.failedQueueNotCompleted = !marked();

  // Two replies in the queue: finishing the first is not completing the queue.
  await load({halted:false,tasks:[
    {id:'q1',status:'waiting',sentAt:Date.now()-3000},
    {id:'q2',status:'pending'}],activeTaskId:'q1'});
  h.ready(h.snapshot());
  await new Promise((resolve) => setTimeout(resolve, 160));
  flags.stableVoiceDetected = h.ready(h.snapshot());
  await h.finish('q1');
  flags.firstTaskRemainsUnread = marked();
  titles.afterFirst = document.title;
  await load({tasks:[{id:'q2',status:'pending'}],activeTaskId:null});
  flags.unreadSurvivesNextPendingTask = marked();
  await load({tasks:[{id:'q2',status:'waiting',sentAt:Date.now()-3000}],
    activeTaskId:'q2'});
  await h.finish('q2');
  flags.lastTaskMarksTab = marked();
  flags.completedTitle = document.title === '✅ 对话：批量任务';
  // Focus without actually viewing the tab is not an acknowledgement.
  window.dispatchEvent(new Event('focus'));
  flags.backgroundFocusDoesNotClearCompletion = marked();
  window.__cqSimulateUnfocused = false;
  window.dispatchEvent(new Event('focus'));
  flags.viewingClearsCompletion = !marked() && document.title === '对话：批量任务';
  // A later page load can reconstruct the unread marker from the saved
  // conversation state without inventing a second finished reply.
  window.__cqSimulateUnfocused = true;
  await load({tasks:[],activeTaskId:null,unreadCompleted:true});
  flags.restoresUnreadFromSavedConversation = marked();
  window.__cqSimulateUnfocused = false;
  window.dispatchEvent(new Event('focus'));
  await new Promise((resolve) => setTimeout(resolve, 30));
  flags.acknowledgesRestoredUnread = !marked() && !window.__cqServerState.unreadCompleted;
  await load({tasks:[{id:'q3',status:'pending'}]});
  flags.newQueueClearsCompletion = !marked();

  // Steering confirms the user turn before the reply is done: wait for the
  // waveform button to return, not the dictation microphone.
  window.__cqSimulateUnfocused = true;
  voice.style.display = 'none';
  await load({tasks:[{id:'steer',status:'steering_wait'}],
    activeTaskId:null,steeringTaskId:'steer'});
  await h.steer('steer');
  flags.steeringNotYetComplete = !marked();
  await h.tick();
  flags.dictationIsNotVoice = !marked();
  voice.style.display = '';
  h.ready(h.snapshot());
  await new Promise((resolve) => setTimeout(resolve, 160));
  await h.tick();
  flags.steeringAfterVoiceCompleted = marked();

  await load({key:'draft:2',tasks:[],activeTaskId:null,steeringTaskId:null});
  flags.newChatClearsCompletion = !marked();
  titles.afterNewChat = document.title;

  // Native square Stop button drives an actually rotating tab-title prefix.
  const stop = document.createElement('button');
  stop.type = 'button';
  stop.dataset.testid = 'stop-button';
  stop.textContent = '停止生成';
  document.querySelector('form').append(stop);
  await load({key:'chat:unbound',tasks:[]});
  await h.tick(); // Running indicator must work even without a bound queue.
  flags.runningShowsSpinner = /^[◴◷◶◵] /.test(document.title);
  // Previously two independent status writers prefixed one another's last
  // frame. Even an existing long chain must collapse to one spinner.
  document.title = '◴ ◷ ✅ 🔴 ◶ ◵ 对话：批量任务';
  await new Promise((resolve) => setTimeout(resolve, 35));
  flags.legacyStackRemoved = /^[◴◷◶◵] (?:🔴 )?(?:✅ )?对话：批量任务$/.test(document.title);
  titles.afterLegacyStack = document.title;
  const firstFrame = document.title[0];
  await new Promise((resolve) => setTimeout(resolve, 340));
  flags.runningActuallySpins = document.title[0] !== firstFrame;
  await new Promise((resolve) => setTimeout(resolve, 1050));
  flags.animatedTitleNeverStacks = /^[◴◷◶◵] (?:🔴 )?(?:✅ )?对话：批量任务$/.test(document.title);
  titles.afterManyTicks = document.title;
  await load({unreadCompleted:true});
  flags.unreadStaysVisibleWhileNextReplyRuns = /^[◴◷◶◵] ✅ /.test(document.title);
  stop.remove();
  await h.tick();
  flags.stopClearsSpinner = !/^[◴◷◶◵] /.test(document.title);
  flags.unreadStillVisibleAfterSpinnerStops = document.title.startsWith('✅ ');

  // Some real ChatGPT variants expose neither Stop text nor stop-button
  // data-testid: only the square SVG in the composer primary action.
  const iconStop = document.createElement('button');
  iconStop.id = 'composer-submit-button';
  iconStop.type = 'button';
  iconStop.innerHTML = '<svg class="icon-primary-action"><path d="M4.5 5.75C4.5 5.05964 5.05964 4.5 5.75 4.5H14.25"/></svg>';
  document.querySelector('form').append(iconStop);
  await new Promise((resolve) => setTimeout(resolve, 80));
  flags.iconOnlyStopObservedImmediately = /^[◴◷◶◵] /.test(document.title) &&
    h.snapshot().busy;
  iconStop.remove();
  await new Promise((resolve) => setTimeout(resolve, 80));
  flags.iconRemovalClearsImmediately = !/^[◴◷◶◵] /.test(document.title);

  // Completion observed by someone already reading needs no unread check.
  window.__cqSimulateUnfocused = false;
  await load({key:'draft:3',tasks:[{id:'visible',status:'waiting',sentAt:Date.now()-3000}],
    activeTaskId:'visible'});
  await h.finish('visible');
  flags.foregroundDoesNotMark = !marked();

  const success = Object.values(flags).every(Boolean);
  document.body.dataset.completionTest = JSON.stringify({success,...flags,titles});
  document.body.insertAdjacentText('beforeend', success ? 'COMPLETE_PASS' : 'COMPLETE_FAIL');
}, 360);
</script>
</body></html>`;
    fs.writeFileSync(path.join(temp, "test.html"), html);
    const args = ["--headless=new", "--disable-gpu", "--disable-extensions", "--no-first-run",
      `--user-data-dir=${path.join(temp, "chrome-profile")}`,
      "--virtual-time-budget=4500", "--dump-dom",
      `file:///${path.join(temp, "test.html").replace(/\\/g, "/")}`];
    const result = spawnSync(chromePath, args, { encoding: "utf8", timeout: 20000, maxBuffer: 6e6 });
    assert.equal(result.status, 0, result.stderr || "Chrome failed");
    const match = result.stdout.match(/data-completion-test="([^"]+)"/);
    assert.ok(match, "tab-completion DOM test did not run");
    const flags = JSON.parse(match[1].replace(/&quot;/g, '"'));
    assert.equal(flags.success, true, JSON.stringify(flags));
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
