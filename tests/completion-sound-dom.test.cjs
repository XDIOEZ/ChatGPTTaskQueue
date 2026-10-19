"use strict";

// Browser DOM regression for the local WebAudio completion cue: no audio on
// startup or unfinished turns, once per finished reply/queue, global mute and
// an explicit preview that can recover from suspended browser audio.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const browser = process.env.CQ_BROWSER_BIN || (process.platform === "win32"
  ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
  : "/usr/bin/google-chrome");

test("completion cue sounds once, obeys global mute and offers a preview", {
  skip: !fs.existsSync(browser) && "Chrome is not installed",
}, () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "cq-sound-"));
  try {
    const source = fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8");
    const tested = source
      .replace("const VOICE_READY_STABLE_MS = 1700;", "const VOICE_READY_STABLE_MS = 120;")
      .replace("if (!state || !sessionKey || !validUrl(location.href)) return false;",
        "if (!state || !sessionKey || (!validUrl(location.href) && !location.href.startsWith('file:'))) return false;")
      .replace('return document.visibilityState === "visible" && document.hasFocus();',
        'return !window.__cqSimulateUnfocused;')
      .replace("  void init();\n})();", `  window.__cqSoundTest = {
        hello: () => rpc("HELLO"),
        finish: (id) => rpc("FINISHED", {id}),
        ready: updateVoiceReadiness,
        observe() {
          const snapshot = conversationSnapshot();
          observeReplyCompleted(snapshot, updateVoiceReadiness(snapshot));
        },
        preview: () => playCompletionSound(true),
        play: () => playCompletionSound(),
        suspendAudio: () => { if (completionAudioContext) completionAudioContext.state = "suspended"; },
        enabled: () => completionSoundEnabled,
      };
      void init();
})();`);
    assert.notEqual(tested, source, "test hook did not attach");
    fs.writeFileSync(path.join(temp, "content-test.js"), tested);

    const html = `<!doctype html><html><head><meta charset="utf-8">
<title>Audio completion test</title></head><body>
<main><div id="messages">
  <div data-message-author-role="user" data-message-id="u1">旧问题</div>
  <div data-message-author-role="assistant" data-message-id="a1"><div class="markdown">旧回复</div></div>
</div><form>
  <textarea id="prompt-textarea"></textarea>
  <button type="button" aria-label="Start Voice" id="voice"></button>
</form></main>
<script>
window.__cqSimulateUnfocused = true;
window.__cqNotes = 0;
window.__cqResumeCalls = 0;
class FakeAudioContext {
  constructor() { this.state = "running"; this.currentTime = 1; this.destination = {}; }
  createOscillator() {
    return {
      frequency: { setValueAtTime() {} }, connect() {},
      start() { window.__cqNotes++; }, stop() {}, type:"sine",
    };
  }
  createGain() {
    return {
      gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} },
      connect() {},
    };
  }
  async resume() { window.__cqResumeCalls++; this.state = "running"; }
}
window.AudioContext = FakeAudioContext;
window.__cqStored = {};
window.__cqState = {
  key:"draft:1", halted:false, tasks:[], schedules:[],
  activeTaskId:null, steeringTaskId:null, queuePaused:true, error:"",
};
window.chrome = {
  runtime: {
    getManifest() { return {version:"test"}; },
    onMessage:{addListener(){}},
    async sendMessage(message) {
      const s = window.__cqState;
      if (message.type === "FINISHED") {
        s.tasks = s.tasks.filter((task) => task.id !== message.id);
        s.activeTaskId = null;
      }
      return {ok:true,sessionKey:s.key, state:JSON.parse(JSON.stringify(s)),dispatch:null};
    },
  },
  storage: {
    onChanged:{addListener(callback) {window.__cqStorageChanged = callback;}},
    local:{
      async get(key) {return {[key]:window.__cqStored[key]};},
      async set(values) {
        Object.assign(window.__cqStored, values);
        const changes = Object.fromEntries(Object.entries(values).map(([key,value]) =>
          [key,{newValue:value}]));
        window.__cqStorageChanged?.(changes, "local");
      },
    },
  },
};
</script>
<script src="./content-test.js"></script>
<script>
setTimeout(async () => {
  const flags = {};
  try {
    const h = window.__cqSoundTest;
    const voice = document.getElementById("voice");
    const messages = document.getElementById("messages");
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const turn = (user, assistant) => {
      messages.innerHTML = '<div data-message-author-role="user" data-message-id="' + user +
        '">提问</div><div data-message-author-role="assistant" data-message-id="' + assistant +
        '"><div class="markdown">完整回答</div></div>';
    };
    flags.quietOnInit = window.__cqNotes === 0 && h.enabled();
    voice.style.display = "none";
    turn("u2", "a2");
    h.observe();
    await wait(150);
    h.observe();
    flags.quietDuringReply = window.__cqNotes === 0;
    voice.style.display = "";
    h.observe();
    await wait(150);
    h.observe();
    flags.manualReplySounds = window.__cqNotes === 2;
    h.observe();
    flags.noRepeatOnPolling = window.__cqNotes === 2;

    // A finished response that the user is already looking at also chimes,
    // without creating a green unread checkmark in the foreground.
    window.__cqSimulateUnfocused = false;
    window.dispatchEvent(new Event("focus"));
    voice.style.display = "none";
    turn("u3", "a3");
    h.observe();
    voice.style.display = "";
    h.ready();
    await wait(150);
    h.observe();
    flags.foregroundReplySounds = window.__cqNotes === 4;

    // Intermediate queued completions must not make a noisy long queue.
    window.__cqState = {...window.__cqState,
      tasks:[{id:"q1",status:"waiting",sentAt:Date.now()-3000},
        {id:"q2",status:"pending"}], activeTaskId:"q1"};
    await h.hello();
    await h.finish("q1");
    flags.intermediateQueueQuiet = window.__cqNotes === 4;
    window.__cqState.tasks = [{id:"q2",status:"waiting",sentAt:Date.now()-3000}];
    window.__cqState.activeTaskId = "q2";
    await h.hello();
    await h.finish("q2");
    flags.finalQueueSounds = window.__cqNotes === 6;
    await h.hello();
    flags.noDuplicateAfterServerPoll = window.__cqNotes === 6;

    // Global preference is independent of queue state and saves instantly.
    document.querySelector('[data-action="toggle-settings"]').click();
    document.querySelector('[data-action="show-settings-page"][data-page="background"]').click();
    const toggle = document.getElementById("cq-completion-sound");
    flags.controlsVisible = !!toggle && toggle.checked &&
      !!document.querySelector('[data-action="preview-completion-sound"]');
    toggle.click();
    await wait(25);
    flags.muteSaved = window.__cqStored["cq.completionSoundEnabled.v1"] === false &&
      !h.enabled();
    voice.style.display = "none";
    turn("u4", "a4");
    h.observe();
    voice.style.display = "";
    h.ready();
    await wait(150);
    h.observe();
    flags.muteSilencesCompletion = window.__cqNotes === 6;
    const preview = document.querySelector('[data-action="preview-completion-sound"]');
    preview.click();
    await wait(30);
    flags.previewWorksWhileMuted = window.__cqNotes === 8;

    // If autoplay was denied, regular completion does not play late; only
    // an explicitly clicked preview may resume the suspended audio context.
    h.suspendAudio();
    const playingBeforeResume = window.__cqNotes;
    flags.blockedAudioSilent = !await h.play() &&
      window.__cqNotes === playingBeforeResume;
    await h.preview();
    flags.previewCanResume = window.__cqResumeCalls === 1 &&
      window.__cqNotes === playingBeforeResume + 2;
  } catch(error) { flags.unexpectedError = String(error?.stack || error); }
  const success = Object.values(flags).every((flag) => flag === true);
  document.body.dataset.soundTest = JSON.stringify({success,...flags});
}, 350);
</script></body></html>`;
    fs.writeFileSync(path.join(temp, "test.html"), html);
    const args = ["--headless=new", "--disable-gpu", "--disable-extensions", "--no-first-run",
      `--user-data-dir=${path.join(temp, "browser-profile")}`,
      "--virtual-time-budget=4800", "--dump-dom",
      `file:///${path.join(temp, "test.html").replace(/\\/g, "/")}`];
    const result = spawnSync(browser, args, {
      encoding:"utf8", timeout:25000, maxBuffer:6e6,
    });
    assert.equal(result.status, 0, result.stderr || "Browser failed");
    const match = result.stdout.match(/data-sound-test="([^"]+)"/);
    assert.ok(match, "completion sound DOM test did not run");
    const flags = JSON.parse(match[1].replace(/&quot;/g, '"'));
    assert.equal(flags.success, true, JSON.stringify(flags));
  } finally {
    fs.rmSync(temp, {recursive:true, force:true});
  }
});
