"use strict";

// Real Chrome DOM test for the Edge vertical-tab unread indicator. A temporary
// test-only script shortens the same Voice Mode readiness window used by the
// queue; the shipped extension remains ChatGPT-origin restricted and uses 1.7s.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const chromePath = process.env.CQ_BROWSER_BIN || (process.platform === "win32"
  ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
  : "/usr/bin/google-chrome");

test("finished background reply adds exactly one tab-title red dot; foreground clears it", {
  skip: !fs.existsSync(chromePath) && "Chrome is not installed",
}, () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "cq-tab-dot-"));
  try {
    const source = fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8");
    assert.ok(source.includes("const VOICE_READY_STABLE_MS = 1700;"));
    assert.ok(source.includes("  void init();\n})();"));
    const tested = source
      .replace("const VOICE_READY_STABLE_MS = 1700;", "const VOICE_READY_STABLE_MS = 120;")
      .replace("if (!state || !sessionKey || !validUrl(location.href)) return false;",
        "if (!state || !sessionKey || (!validUrl(location.href) && !location.href.startsWith('file:'))) return false;")
      .replace('if (document.visibilityState !== "hidden" && document.hasFocus()) return;',
        'if (!window.__cqSimulateUnfocused) return;')
      .replace("  void init();\n})();", `  window.__cqTabTest = {
        snapshot: conversationSnapshot,
        observe() {
          const snapshot = conversationSnapshot();
          observeReplyCompleted(snapshot, updateVoiceReadiness(snapshot));
        },
        ready: updateVoiceReadiness,
        clear: clearTabRedDot, hasDot: () => tabUnread,
      };
      void init();
})();`);
    fs.writeFileSync(path.join(temp, "content-test.js"), tested);

    const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>对话：时间报告</title></head><body>
<main>
  <div id="messages">
    <div data-message-author-role="user" data-message-id="u1"><div data-testid="user-message">旧问题</div></div>
    <div data-message-author-role="assistant" data-message-id="a1"><div class="markdown">旧回答</div></div>
  </div>
  <form>
    <textarea id="prompt-textarea"></textarea>
    <button type="button" data-testid="send-button">发送</button>
    <button type="button" id="mic" aria-label="Start dictation">麦克风</button>
    <button type="button" id="voice" aria-label="Start Voice">语音对话</button>
  </form>
</main>
<script>
window.__cqSimulateUnfocused = true;
window.chrome = {
  runtime: { onMessage: { addListener() {} }, async sendMessage() {
    return {ok:true, state: {key:'draft:1', halted:false, tasks:[], schedules:[], error:'',
      activeTaskId:null, autoOpenTab:false}, sessionKey:'draft:1', dispatch:null};
  }},
  storage: { onChanged: {addListener() {}} },
};
</script>
<script src="./content-test.js"></script>
<script>
setTimeout(async () => {
  const h = window.__cqTabTest;
  const flags = {};
  flags.existingReplyUnmarked = !document.title.startsWith('🔴 ');
  const original = document.querySelector('#messages');
  const voice = document.querySelector('#voice');
  function turn(userId, assistantId, answer) {
    original.innerHTML =
      '<div data-message-author-role="user" data-message-id="'+userId+'">' +
      '<div data-testid="user-message">新的问题</div></div>' +
      '<div data-message-author-role="assistant" data-message-id="'+assistantId+'">' +
      '<div class="markdown">'+answer+'</div></div>';
  }
  voice.style.display = 'none';
  flags.microphoneNotVoice = h.ready(h.snapshot()) === false;
  // A new reply (even a non-text reply) is not finished while Voice Mode
  // remains hidden. The adjacent dictation microphone is NOT a substitute.
  turn('u2', 'a2', '');
  h.observe();
  await new Promise((resolve) => setTimeout(resolve, 160));
  h.observe();
  flags.noDotBeforeVoice = !document.title.startsWith('🔴 ');
  voice.style.display = '';
  h.observe();
  await new Promise((resolve) => setTimeout(resolve, 160));
  h.observe();
  flags.dotAfterReply = document.title.startsWith('🔴 ');
  h.observe();
  flags.oneDotOnly = !document.title.startsWith('🔴 🔴 ');
  document.title = '更新后的对话标题';
  await new Promise((resolve) => setTimeout(resolve, 25));
  flags.titleRenameKeepsDot = document.title === '🔴 更新后的对话标题';

  // The user returns to that Edge tab, so the unread mark disappears.
  window.__cqSimulateUnfocused = false;
  window.dispatchEvent(new Event('focus'));
  flags.focusClearsDot = document.title === '更新后的对话标题' && !h.hasDot();

  // Tool call remains pending: never treat the placeholder as completion.
  window.__cqSimulateUnfocused = true;
  voice.style.display = 'none';
  turn('u3', 'a3', 'Waiting for a tool result.');
  h.observe();
  await new Promise((resolve) => setTimeout(resolve, 165));
  h.observe();
  flags.toolWaitNoDot = !document.title.startsWith('🔴 ');
  const tool = original.querySelector('.markdown');
  tool.textContent = '最终报告完成';
  voice.style.display = '';
  h.observe();
  await new Promise((resolve) => setTimeout(resolve, 155));
  h.observe();
  flags.toolFinishesDot = document.title.startsWith('🔴 ');

  const success = Object.values(flags).every(Boolean);
  document.body.dataset.dotTest = JSON.stringify({ success, ...flags });
  document.body.insertAdjacentText('beforeend', success ? 'DOT_PASS' : 'DOT_FAIL');
}, 330);
</script>
</body></html>`;
    fs.writeFileSync(path.join(temp, "test.html"), html);
    const args = ["--headless=new", "--disable-gpu", "--disable-extensions", "--no-first-run",
      `--user-data-dir=${path.join(temp, "chrome-profile")}`,
      "--virtual-time-budget=3500", "--dump-dom",
      `file:///${path.join(temp, "test.html").replace(/\\/g, "/")}`];
    const result = spawnSync(chromePath, args, { encoding: "utf8", timeout: 18000, maxBuffer: 6e6 });
    assert.equal(result.status, 0, result.stderr || "Chrome failed");
    const match = result.stdout.match(/data-dot-test="([^"]+)"/);
    assert.ok(match, "tab-dot DOM test did not run");
    const flags = JSON.parse(match[1].replace(/&quot;/g, '"'));
    assert.equal(flags.success, true, JSON.stringify(flags));
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
