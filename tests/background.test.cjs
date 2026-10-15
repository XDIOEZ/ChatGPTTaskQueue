"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { webcrypto } = require("node:crypto");

const source = fs.readFileSync(path.join(__dirname, "..", "background.js"), "utf8");
const A = "https://chatgpt.com/c/dialogue-a";
const B = "https://chatgpt.com/c/dialogue-b";
const voiceProof = {
  voiceReady: true, voiceStableMs: 2200, editorEmpty: true,
  lastRole: "assistant", busy: false, toolPending: false,
  assistantAdvanced: true, assistantTextLength: 24, stableMs: 2200,
};

async function harness(initialStorage = {}) {
  let now = Date.UTC(2026, 9, 15, 12, 0);
  const stored = structuredClone(initialStorage);
  let alarmHandler;
  let messageHandler;
  let alarm;
  const tabs = new Map([
    [11, { id: 11, url: A }],
    [12, { id: 12, url: B }],
    [13, { id: 13, url: "https://chatgpt.com/" }],
  ]);

  class FakeDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }

  const chrome = {
    storage: {
      local: {
        async get(keys) {
          const names = Array.isArray(keys) ? keys : [keys];
          return Object.fromEntries(names.map((key) => [key, stored[key]]));
        },
        async set(values) { Object.assign(stored, values); },
      },
    },
    alarms: {
      async get() { return alarm; },
      async create(name, options) { alarm = { name, ...options }; },
      onAlarm: { addListener(fn) { alarmHandler = fn; } },
    },
    tabs: {
      async get(id) {
        if (!tabs.has(id)) throw new Error("tab closed");
        return tabs.get(id);
      },
      async query() { return [...tabs.values()]; },
      async create({ url }) {
        const tab = { id: 100 + tabs.size, url };
        tabs.set(tab.id, tab);
        return tab;
      },
      async sendMessage() {},
    },
    runtime: {
      onInstalled: { addListener() {} },
      onStartup: { addListener() {} },
      onMessage: { addListener(fn) { messageHandler = fn; } },
    },
    action: { onClicked: { addListener() {} } },
  };

  vm.runInNewContext(source, {
    chrome, crypto: webcrypto, Date: FakeDate, URL,
    console: { error() {} }, // Some tests deliberately check rejected operations.
  });

  async function send(type, args = {}, tab = 11, overrideUrl, tabProperties = {}) {
    return new Promise((resolve) => messageHandler(
      { type, url: overrideUrl ?? tabs.get(tab)?.url, ...args },
      { tab: { id: tab, ...tabProperties } }, resolve
    ));
  }

  async function tick(minutes) {
    now += minutes * 60_000;
    alarmHandler({ name: "cq.scheduler" });
    return send("GET"); // Queued after the timer callback.
  }

  function navigate(tab, url) { tabs.get(tab).url = url; }
  function advance(seconds) { now += seconds * 1000; }
  return { send, tick, navigate, advance, tabs, stored };
}

test("A/B chats have separate queues and switching restores their own content", async () => {
  const { send, navigate } = await harness();
  const first = await send("ENQUEUE", { text: "A 任务" });
  assert.equal(first.state.key, "chat:dialogue-a");
  assert.equal(first.state.halted, false);
  navigate(11, B);
  const empty = await send("HELLO");
  assert.equal(empty.state.key, "chat:dialogue-b");
  assert.equal(empty.state.tasks.length, 0);
  await send("ENQUEUE", { text: "B 任务" });

  navigate(11, A);
  const restoredA = await send("HELLO");
  assert.equal(restoredA.state.tasks.length, 1);
  assert.equal(restoredA.state.tasks[0].text, "A 任务");
  const claimA = await send("CLAIM", { ready: true, userCount: 0, assistantCount: 0 });
  assert.equal(claimA.dispatch.text, "A 任务");

  navigate(11, B);
  const restoredB = await send("HELLO");
  assert.equal(restoredB.state.tasks.length, 1);
  assert.equal(restoredB.state.tasks[0].text, "B 任务");
  assert.equal(restoredB.state.activeTaskId, null);
  assert.equal((await send("SENT", { id: claimA.dispatch.id })).ok, false);
});

test("confirmed finished message is deleted immediately from queue and storage", async () => {
  const { send, stored, advance } = await harness();
  await send("ENQUEUE", { text: "任务一" });
  await send("ENQUEUE", { text: "任务二" });
  const first = await send("CLAIM", { ready: true, userCount: 2, assistantCount: 2 });
  assert.equal(first.dispatch.text, "任务一");
  assert.equal((await send("CLAIM", { ready: true })).dispatch, null);
  await send("SENT", { id: first.dispatch.id });
  advance(3);
  const tooEarly = await send("FINISHED", {
    ...voiceProof, voiceReady: false, id: first.dispatch.id,
  });
  assert.equal(tooEarly.ok, false);
  const result = await send("FINISHED", {
    ...voiceProof, id: first.dispatch.id,
  });
  assert.equal(result.state.activeTaskId, null);
  assert.equal(result.state.tasks.length, 1);
  assert.equal(result.state.tasks[0].text, "任务二");
  assert.equal(stored["cq.state.v2"].conversations["chat:dialogue-a"].tasks.length, 1);
  const second = await send("CLAIM", { ready: true, userCount: 3, assistantCount: 3 });
  assert.equal(second.dispatch.text, "任务二");
});

test("schedulers belong to their own chat, run independently and never backfill missed periods", async () => {
  const { send, tick } = await harness();
  await send("ADD_SCHEDULE", { text: "A 定时", intervalMinutes: 2 }, 11);
  await send("ADD_SCHEDULE", { text: "B 定时", intervalMinutes: 3 }, 12);
  const startA = await send("GET", {}, 11);
  const startB = await send("GET", {}, 12);
  assert.equal(startA.state.schedules.length, 1);
  assert.equal(startB.state.schedules.length, 1);
  assert.equal(startA.state.schedules[0].intervalMinutes, 2);

  await tick(2);
  const afterA = await send("GET", {}, 11);
  const afterB = await send("GET", {}, 12);
  assert.equal(afterA.state.tasks.length, 1);
  assert.equal(afterA.state.tasks[0].text, "A 定时");
  assert.equal(afterB.state.tasks.length, 0);

  await tick(1);
  const bDue = await send("GET", {}, 12);
  assert.equal(bDue.state.tasks.length, 1);
  assert.equal(bDue.state.tasks[0].text, "B 定时");

  await tick(20);
  // Each chat receives ONE new item for the missed period, regardless of
  // earlier pending items and regardless of a 20-minute browser sleep.
  const a = (await send("GET", {}, 11)).state;
  const b = (await send("GET", {}, 12)).state;
  assert.equal(a.tasks.length, 2);
  assert.equal(b.tasks.length, 2);
  assert.equal(a.schedules[0].runCount, 2);
  assert.equal(b.schedules[0].runCount, 2);
  assert.equal(new Set(a.tasks.map((task) => task.id)).size, 2);
  assert.equal(new Set(b.tasks.map((task) => task.id)).size, 2);
});

test("an open tab can trigger its chat schedule at second precision", async () => {
  const { send, advance } = await harness();
  const schedule = await send("ADD_SCHEDULE", { text: "倒计时", intervalMinutes: 1 });
  const nextRunAt = schedule.state.schedules[0].nextRunAt;
  advance(59);
  assert.equal((await send("SCHEDULE_PULSE")).state.tasks.length, 0);
  advance(1);
  const triggered = await send("SCHEDULE_PULSE");
  assert.equal(triggered.state.tasks.length, 1);
  assert.equal(triggered.state.tasks[0].text, "倒计时");
  assert.equal(triggered.state.schedules[0].nextRunAt, nextRunAt + 60_000);
});

test("repeatCount 0 schedules exactly one occurrence then disables itself", async () => {
  const { send, tick } = await harness();
  const added = await send("ADD_SCHEDULE", {
    text: "只做一次", intervalMinutes: 2, repeatCount: 0,
  });
  assert.equal(added.state.schedules[0].runCount, 0);
  assert.equal(added.state.schedules[0].repeatCount, 0);

  await tick(2);
  const first = await send("GET");
  assert.equal(first.state.tasks.length, 1);
  assert.equal(first.state.schedules[0].enabled, false);
  assert.equal(first.state.schedules[0].runCount, 1);

  await send("DELETE_TASK", { id: first.state.tasks[0].id });
  await tick(30);
  const after = await send("GET");
  assert.equal(after.state.tasks.length, 0);
  assert.equal(after.state.schedules[0].runCount, 1);
});

test("repeatCount N creates N+1 queue items at time intervals even if earlier tasks are still pending", async () => {
  const { send, tick } = await harness();
  await send("ADD_SCHEDULE", { text: "总共三次", intervalMinutes: 1, repeatCount: 2 });

  await tick(1);
  let state = (await send("GET")).state;
  assert.equal(state.schedules[0].runCount, 1);
  assert.equal(state.schedules[0].enabled, true);
  // Even with a full conversation still waiting to be dispatched, the
  // next due interval becomes a new pending item (not a deferred reply).
  await tick(7);
  state = (await send("GET")).state;
  assert.equal(state.tasks.length, 2);
  assert.equal(state.schedules[0].runCount, 2);
  assert.equal(state.tasks[0].status, "pending");
  assert.equal(state.tasks[1].status, "pending");

  await tick(1);
  state = (await send("GET")).state;
  assert.equal(state.tasks.length, 3);
  assert.equal(state.schedules[0].runCount, 3);
  assert.equal(state.schedules[0].enabled, false);
  assert.equal(new Set(state.tasks.map((task) => task.id)).size, 3);
  await tick(20);
  assert.equal((await send("GET")).state.tasks.length, 3);
});

test("repeatCount -1 remains enabled and skips catchup bursts", async () => {
  const { send, tick } = await harness();
  await send("ADD_SCHEDULE", { text: "无限执行", intervalMinutes: 1, repeatCount: -1 });
  await tick(12); // 12 intervals elapsed while the machine was asleep.
  let current = (await send("GET")).state;
  assert.equal(current.tasks.length, 1);
  assert.equal(current.schedules[0].runCount, 1);
  assert.equal(current.schedules[0].enabled, true);
  const afterNext = current.schedules[0].nextRunAt;
  await send("DELETE_TASK", { id: current.tasks[0].id });
  await tick(1);
  current = (await send("GET")).state;
  assert.equal(current.schedules[0].runCount, 2);
  assert.equal(current.schedules[0].nextRunAt, afterNext + 60_000);
});

test("re-enabling an exhausted one-shot restarts its count, editing resets finite cycle", async () => {
  const { send, tick } = await harness();
  const initial = await send("ADD_SCHEDULE", {
    text: "一次", intervalMinutes: 1, repeatCount: 0,
  });
  const id = initial.state.schedules[0].id;
  await tick(1);
  let current = (await send("GET")).state;
  assert.equal(current.schedules[0].runCount, 1);
  await send("DELETE_TASK", { id: current.tasks[0].id });

  current = (await send("TOGGLE_SCHEDULE", { id })).state;
  assert.equal(current.schedules[0].enabled, true);
  assert.equal(current.schedules[0].runCount, 0);
  await tick(1);
  current = (await send("GET")).state;
  assert.equal(current.schedules[0].runCount, 1);
  assert.equal(current.schedules[0].enabled, false);

  current = (await send("EDIT_SCHEDULE", {
    id, text: "三次", intervalMinutes: 2, repeatCount: 2,
  })).state;
  assert.equal(current.schedules[0].text, "三次");
  assert.equal(current.schedules[0].repeatCount, 2);
  assert.equal(current.schedules[0].runCount, 0);
  assert.equal(current.schedules[0].enabled, false); // Editing does not override disabled status.
  current = (await send("TOGGLE_SCHEDULE", { id })).state;
  assert.equal(current.schedules[0].enabled, true);
  assert.equal(current.schedules[0].runCount, 0);
});

test("invalid repeatCount is rejected without modifying saved scheduler", async () => {
  const { send } = await harness();
  const invalid = [-2, 1.5, "", "NaN", 1_000_001];
  for (const repeatCount of invalid) {
    assert.equal((await send("ADD_SCHEDULE", {
      text: "不应该创建", intervalMinutes: 1, repeatCount,
    })).ok, false);
  }
  assert.equal((await send("GET")).state.schedules.length, 0);

  const add = await send("ADD_SCHEDULE", { text: "正常", intervalMinutes: 1, repeatCount: 0 });
  const scheduleId = add.state.schedules[0].id;
  assert.equal((await send("EDIT_SCHEDULE", {
    id: scheduleId, text: "非法编辑", intervalMinutes: 1, repeatCount: -2,
  })).ok, false);
  assert.equal((await send("GET")).state.schedules[0].text, "正常");
});

test("existing v2 schedules without repeatCount keep the prior infinite behavior", async () => {
  const { send, tick } = await harness({
    "cq.state.v2": {
      version: 2, conversations: {
        "chat:dialogue-a": {
          key: "chat:dialogue-a", url: A, tabId: 11, halted: false,
          activeTaskId: null, autoOpenTab: false, error: "", tasks: [],
          schedules: [{
            id: "legacy-v2-timer", text: "旧定时", intervalMinutes: 1,
            enabled: true, nextRunAt: Date.UTC(2026, 9, 15, 12, 1),
          }],
        },
      },
      legacyUnbound: null,
    },
  });
  await tick(1);
  let current = (await send("GET")).state;
  assert.equal(current.tasks.length, 1);
  assert.equal(current.schedules[0].enabled, true);
  assert.equal(current.schedules[0].runCount, 1);
  await send("DELETE_TASK", { id: current.tasks[0].id });
  await tick(1);
  current = (await send("GET")).state;
  assert.equal(current.schedules[0].runCount, 2);
  assert.equal(current.schedules[0].enabled, true);
});

test("A/B scheduler repeat counts remain isolated", async () => {
  const { send, tick } = await harness();
  await send("ADD_SCHEDULE", { text: "A 单次", intervalMinutes: 1, repeatCount: 0 }, 11);
  await send("ADD_SCHEDULE", { text: "B 无限", intervalMinutes: 1, repeatCount: -1 }, 12);
  await tick(1);
  const stateA = (await send("GET", {}, 11)).state;
  const stateB = (await send("GET", {}, 12)).state;
  assert.equal(stateA.schedules[0].enabled, false);
  assert.equal(stateA.schedules[0].runCount, 1);
  assert.equal(stateB.schedules[0].enabled, true);
  assert.equal(stateB.schedules[0].runCount, 1);
});

test("native Stop halts only its chat and manual new user turn resumes its queue", async () => {
  const { send } = await harness();
  await send("ENQUEUE", { text: "A 第一条" }, 11);
  await send("ENQUEUE", { text: "A 第二条" }, 11);
  await send("ENQUEUE", { text: "B 第一条" }, 12);
  const a = await send("CLAIM", { ready: true, userCount: 0, assistantCount: 0 }, 11);
  await send("SENT", { id: a.dispatch.id }, 11);
  const stopped = await send("STOPPED", { userCount: 1 }, 11);
  assert.equal(stopped.state.halted, true);
  assert.equal(stopped.state.tasks[0].status, "interrupted");
  assert.equal(stopped.state.activeTaskId, null);
  assert.equal((await send("CLAIM", { ready: true }, 11)).dispatch, null);
  await send("ENQUEUE", { text: "停下后继续排队" }, 11);
  assert.equal((await send("GET", {}, 11)).state.halted, true);
  assert.equal((await send("USER_RESUMED", { userCount: 1, lastUserText: "旧消息" }, 11)).state.halted, true);
  assert.equal((await send("CLAIM", { ready: true }, 12)).dispatch.text, "B 第一条");
  const resumed = await send("USER_RESUMED", { userCount: 2, lastUserText: "新消息" }, 11);
  assert.equal(resumed.state.halted, false);
  assert.equal((await send("CLAIM", { ready: true }, 11)).dispatch.text, "A 第二条");
});

test("legacy v1 data migrates into bound chat with done tasks removed", async () => {
  const { send, stored } = await harness({
    "cq.state.v1": {
      version: 1, target: { url: A, tabId: 11 }, paused: false,
      tasks: [
        { id: "old", text: "保留", status: "pending" },
        { id: "done", text: "已完成", status: "done" },
      ],
      schedules: [{ id: "periodic", text: "旧定时", intervalMinutes: 2, enabled: false, nextRunAt: Date.now() + 999_999 }],
    },
  });
  const a = await send("GET", {}, 11);
  assert.equal(a.state.tasks.length, 1);
  assert.equal(a.state.tasks[0].text, "保留");
  assert.equal(a.state.schedules.length, 1);
  assert.equal((await send("GET", {}, 12)).state.tasks.length, 0);
  assert.equal(stored["cq.state.v2"].version, 2);
});

test("new chat draft queue and its timer move to a confirmed conversation ID", async () => {
  const { send, navigate } = await harness();
  await send("ENQUEUE", { text: "建立对话" }, 13);
  await send("ADD_SCHEDULE", { text: "之后巡检", intervalMinutes: 4 }, 13);
  const claimed = await send("CLAIM", { ready: true }, 13);
  assert.equal(claimed.state.key, "draft:13");
  navigate(13, "https://chatgpt.com/c/fresh-chat");
  const unrelated = await send("HELLO", { lastUserText: "别的消息" }, 13);
  assert.equal(unrelated.state.tasks.length, 0);
  const adopted = await send("HELLO", { lastUserText: "建立对话" }, 13);
  assert.equal(adopted.state.key, "chat:fresh-chat");
  assert.equal(adopted.state.schedules.length, 1);
  const sent = await send("SENT", { id: claimed.dispatch.id, lastUserText: "建立对话" }, 13);
  assert.equal(sent.state.tasks[0].status, "waiting");
});

test("switching tab away leaves queued tasks bound to their chat, not the next page", async () => {
  const { send, navigate } = await harness();
  await send("ENQUEUE", { text: "A 任务" }, 11);
  const claimed = await send("CLAIM", { ready: true }, 11);
  navigate(11, B);
  assert.equal((await send("SENT", { id: claimed.dispatch.id }, 11)).ok, false);
  assert.equal((await send("GET", {}, 12)).state.activeTaskId, null);
  navigate(11, A);
  assert.equal((await send("GET", {}, 11)).state.activeTaskId, claimed.dispatch.id);
});

test("发送后不再确认消息气泡，语音按钮恢复就释放等待锁", async () => {
  const { send, advance } = await harness();
  await send("ENQUEUE", { text: "回复我x++ x=1" });
  await send("ENQUEUE", { text: "第二次测试" });
  const first = await send("CLAIM", {
    ready: true, userCount: 2, assistantCount: 2, lastUserId: "user-2",
  });
  const id = first.dispatch.id;
  const clicked = await send("SENT", { id });
  assert.equal(clicked.state.tasks[0].status, "waiting");
  assert.equal("deliveryVerified" in clicked.state.tasks[0], false);
  advance(24); // Previously the content script failed at 18 seconds.
  const waiting = await send("GET");
  assert.equal(waiting.state.halted, false);
  assert.equal(waiting.state.activeTaskId, id);
  assert.equal(waiting.state.tasks[1].status, "pending");
  assert.equal((await send("CLAIM", { ready: true })).dispatch, null);
  const finished = await send("FINISHED", {
    ...voiceProof, id,
  });
  assert.equal(finished.state.tasks.length, 1);
  assert.equal(finished.state.halted, false);
  assert.equal((await send("CLAIM", { ready: true, userCount: 3, assistantCount: 3 })).dispatch.text,
    "第二次测试");
});

test("发送后的唯一完成信号是语音按钮，助手内容及消息数量不影响队列释放", async () => {
  const { send, advance } = await harness();
  await send("ENQUEUE", { text: "工具处理很久" });
  const first = await send("CLAIM", { ready: true, assistantCount: 2, userCount: 2 });
  await send("SENT", { id: first.dispatch.id });
  advance(17);
  const evidence = {
    ...voiceProof,
    id: first.dispatch.id,
    assistantCount: 2, lastRole: "user", lastUserText: "完全不匹配的消息",
    editorEmpty: true, busy: false, toolPending: true,
    assistantTextLength: 0,
  };
  assert.equal((await send("FINISHED", { ...evidence, voiceReady: false })).ok, false);
  assert.equal((await send("FINISHED", { ...evidence, busy: true })).ok, false);
  assert.equal((await send("FINISHED", { ...evidence, voiceStableMs: 800 })).ok, false);
  assert.equal((await send("FINISHED", { ...evidence, editorEmpty: false })).ok, false);
  assert.equal((await send("GET")).state.tasks[0].status, "waiting");
  const recovered = await send("FINISHED", evidence);
  assert.equal(recovered.state.tasks.length, 0);
  assert.equal(recovered.state.halted, false);
});

test("infinite timer completes five successive delayed tool conversations", async () => {
  const { send, tick, advance } = await harness();
  const created = await send("ADD_SCHEDULE", {
    text: "周期巡检", intervalMinutes: 10, repeatCount: -1,
  });
  const scheduleId = created.state.schedules[0].id;
  for (let iteration = 1; iteration <= 5; iteration++) {
    await tick(10);
    const scheduled = (await send("GET")).state;
    assert.equal(scheduled.schedules[0].enabled, true);
    assert.equal(scheduled.schedules[0].runCount, iteration);
    assert.equal(scheduled.tasks.length, 1);
    assert.equal(scheduled.tasks[0].sourceScheduleId, scheduleId);
    const started = await send("CLAIM", {
      ready: true, userCount: iteration, assistantCount: iteration,
    });
    const id = started.dispatch.id;
    await send("SENT", { id, verified: false });
    advance(25); // Each answer takes >18 seconds.
    const result = await send("FINISHED", {
      ...voiceProof,
      id, assistantFallback: true, assistantCount: iteration + 1,
      stableMs: 16000, editorEmpty: true, lastRole: "assistant",
      busy: false, toolPending: false, assistantTextLength: 23,
      assistantAdvanced: true,
    });
    assert.equal(result.ok, true);
    assert.equal(result.state.tasks.length, 0);
    assert.equal(result.state.halted, false);
  }
  const stillRunning = (await send("GET")).state;
  assert.equal(stillRunning.schedules[0].enabled, true);
  assert.equal(stillRunning.schedules[0].repeatCount, -1);
});

test("manual review can skip a previously failed task without resending it", async () => {
  const { send } = await harness();
  await send("ENQUEUE", { text: "之前可能已发送" });
  await send("ENQUEUE", { text: "下一条" });
  const started = await send("CLAIM", { ready: true });
  await send("FAIL", { id: started.dispatch.id, error: "发送结果未确认，可能已发送" });
  const failed = (await send("GET")).state;
  assert.equal(failed.halted, true);
  assert.equal(failed.tasks[0].status, "error");
  const skipped = await send("SKIP_FAILED", { id: started.dispatch.id });
  assert.equal(skipped.state.halted, false);
  assert.equal(skipped.state.error, "");
  assert.equal(skipped.state.tasks.length, 1);
  assert.equal(skipped.state.tasks[0].text, "下一条");
  assert.equal((await send("CLAIM", { ready: true })).dispatch.text, "下一条");
});

test("project GPT nested conversation URL owns the same chat queue by conversation id", async () => {
  const { send, navigate } = await harness();
  navigate(11, "https://chatgpt.com/g/p-123456-project0/c/project-chat-id");
  const added = await send("ENQUEUE", { text: "项目对话任务" });
  assert.equal(added.state.key, "chat:project-chat-id");
  navigate(11, "https://chatgpt.com/c/project-chat-id");
  const restored = await send("HELLO");
  assert.equal(restored.state.key, "chat:project-chat-id");
  assert.equal(restored.state.tasks.length, 1);
});

test("old Queue 0 stale send-warning unlocks automatically and timer sends after countdown", async () => {
  const { send, tick, stored } = await harness({
    "cq.state.v2": {
      version: 2, legacyUnbound: null,
      conversations: {
        "chat:dialogue-a": {
          key: "chat:dialogue-a", url: A, tabId: 11,
          halted: true, activeTaskId: null,
          error: "发送结果未确认，可能已发送；请人工检查，插件不会自动重发",
          autoOpenTab: false, tasks: [], schedules: [{
            id: "stale-loop", text: "定时继续", enabled: true,
            intervalMinutes: 1, repeatCount: -1, runCount: 2,
            nextRunAt: Date.UTC(2026, 9, 15, 12, 1),
          }],
        },
      },
    },
  });

  const init = await send("HELLO");
  assert.equal(init.state.halted, false);
  assert.equal(init.state.error, "");
  assert.equal(init.state.tasks.length, 0);

  await tick(1);
  const ready = (await send("GET")).state;
  assert.equal(ready.tasks.length, 1);
  assert.equal(ready.tasks[0].text, "定时继续");
  assert.equal(ready.schedules[0].enabled, true);
  assert.equal(ready.schedules[0].runCount, 3);
  const claim = await send("CLAIM", { ready: true, assistantCount: 4, userCount: 4 });
  assert.equal(claim.dispatch.text, "定时继续");
  assert.equal(stored["cq.state.v2"].conversations["chat:dialogue-a"].error, "");
});

test("old failed row is quarantined and does not get resent when timer fires", async () => {
  const { send, tick } = await harness({
    "cq.state.v2": {
      version: 2, legacyUnbound: null,
      conversations: {
        "chat:dialogue-a": {
          key: "chat:dialogue-a", url: A, tabId: 11,
          halted: true, activeTaskId: null,
          error: "发送结果未确认，可能已发送；请人工检查",
          tasks: [{ id: "unverified", text: "可能已经发过", status: "error" }],
          schedules: [{
            id: "loop", text: "继续做新任务", intervalMinutes: 1,
            repeatCount: -1, enabled: true, nextRunAt: Date.UTC(2026, 9, 15, 12, 1),
          }],
        },
      },
    },
  });
  await tick(1);
  const result = (await send("GET")).state;
  assert.equal(result.halted, false);
  assert.equal(result.error, "");
  assert.equal(result.tasks.length, 2);
  assert.equal(result.tasks[0].status, "error");
  assert.equal(result.tasks[0].text, "可能已经发过");
  assert.equal((await send("CLAIM", { ready: true })).dispatch.text, "继续做新任务");
});

test("explicit user Stop is not silently resumed by timer or reload", async () => {
  const { send, tick } = await harness();
  await send("ENQUEUE", { text: "任务" });
  const stopped = await send("STOPPED", { userCount: 3 });
  assert.equal(stopped.state.halted, true);
  assert.equal(stopped.state.haltReason, "user");
  await send("ADD_SCHEDULE", { text: "定时通知", intervalMinutes: 1, repeatCount: -1 });
  await tick(1);
  const loaded = await send("HELLO", { userCount: 3 });
  assert.equal(loaded.state.halted, true);
  assert.equal(loaded.state.haltReason, "user");
  assert.equal(loaded.state.tasks.length, 2);
  assert.equal((await send("CLAIM", { ready: true })).dispatch, null);
  assert.equal((await send("ACK_RECOVERY")).state.halted, true);
});

test("new technical hold requires explicit recovery and does not repeat an uncertain send", async () => {
  const { send } = await harness();
  await send("ENQUEUE", { text: "稍后处理" });
  const start = await send("CLAIM", { ready: true });
  await send("FAIL", { id: start.dispatch.id, error: "当前网页不支持原生发送" });
  const held = (await send("HELLO")).state;
  assert.equal(held.halted, true);
  assert.equal(held.haltReason, "failure");
  assert.equal((await send("CLAIM", { ready: true })).dispatch, null);
  const recovered = await send("ACK_RECOVERY");
  assert.equal(recovered.state.halted, false);
  assert.equal(recovered.state.error, "");
  assert.equal(recovered.state.tasks[0].status, "error");
  assert.equal((await send("CLAIM", { ready: true })).dispatch, null);
});

test("an old native Stop remains stopped across reload and countdown expiry", async () => {
  const { send, tick } = await harness({
    "cq.state.v2": {
      version: 2, legacyUnbound: null, conversations: {
        "chat:dialogue-a": {
          key: "chat:dialogue-a", url: A, tabId: 11, halted: true,
          activeTaskId: null, error: "用户已停止回复；本对话队列暂停",
          tasks: [], schedules: [{ id: "loop", text: "不要发", intervalMinutes: 1,
            repeatCount: -1, enabled: true, nextRunAt: Date.UTC(2026, 9, 15, 12, 1) }],
        },
      },
    },
  });
  const hello = await send("HELLO");
  assert.equal(hello.state.halted, true);
  assert.equal(hello.state.haltReason, "user");
  await tick(1);
  const pending = (await send("GET")).state;
  assert.equal(pending.tasks.length, 1);
  assert.equal(pending.halted, true);
  assert.equal((await send("CLAIM", { ready: true })).dispatch, null);
});

test("a foreground tab of the same conversation can take over an idle background owner", async () => {
  const { send, navigate } = await harness();
  const added = await send("ENQUEUE", { text: "接力任务" }, 11);
  assert.equal(added.state.tabId, 11);
  navigate(12, A);
  const switched = await send("HELLO", {}, 12, undefined, { active: true });
  assert.equal(switched.state.key, "chat:dialogue-a");
  assert.equal(switched.state.tabId, 12);
  assert.equal((await send("CLAIM", { ready: true }, 11)).dispatch, null);
  assert.equal((await send("CLAIM", { ready: true }, 12)).dispatch.text, "接力任务");
});

test("a visible-message count that stays constant can still finish a confirmed new assistant turn", async () => {
  const { send, advance } = await harness();
  await send("ENQUEUE", { text: "重复当前时间" });
  const first = await send("CLAIM", {
    ready: true, assistantCount: 1, userCount: 1,
    lastAssistantId: "old-assistant", lastAssistantSignature: "12|上轮回复内容",
  });
  await send("SENT", { id: first.dispatch.id, verified: true, userCount: 1 });
  advance(8);
  const completed = await send("FINISHED", {
    ...voiceProof,
    id: first.dispatch.id,
    assistantCount: 1, userCount: 1, lastUserText: "",
    lastAssistantId: "new-assistant", lastAssistantSignature: "14|最新时间已更新",
    assistantAdvanced: true, stableMs: 7000, assistantTextLength: 14,
    busy: false, toolPending: false, lastRole: "assistant",
  });
  assert.equal(completed.ok, true);
  assert.equal(completed.state.tasks.length, 0);
  assert.equal(completed.state.activeTaskId, null);
});

test("即使最后回复和消息数量不变化，只有语音按钮恢复才推动队列", async () => {
  const { send, advance } = await harness();
  await send("ENQUEUE", { text: "检查运行结果" });
  const first = await send("CLAIM", {
    ready: true, assistantCount: 1, userCount: 1,
    lastAssistantId: "previous", lastAssistantSignature: "12|上轮回复内容",
  });
  await send("SENT", { id: first.dispatch.id, verified: true });
  advance(30);
  const evidence = {
    ...voiceProof,
    id: first.dispatch.id, assistantCount: 1, userCount: 1,
    lastUserText: "", assistantAdvanced: true, stableMs: 20000,
    assistantTextLength: 23, busy: false, toolPending: false,
    lastRole: "assistant", lastAssistantId: "previous",
    lastAssistantSignature: "12|上轮回复内容",
  };
  assert.equal((await send("FINISHED", { ...evidence, voiceReady: false })).ok, false);
  assert.equal((await send("FINISHED", {
    ...evidence, lastAssistantId: "new-turn", voiceStableMs: 800,
  })).ok, false);
  assert.equal((await send("FINISHED", {
    ...evidence, lastAssistantId: "new-turn", busy: true,
  })).ok, false);
  assert.equal((await send("GET")).state.tasks[0].status, "waiting");
  // No assistant-text / user-bubble evidence is required any more.
  const cleared = await send("FINISHED", evidence);
  assert.equal(cleared.state.tasks.length, 0);
});

test("无限定时器在首条回复未完成的六个周期中，照常累计六条队列待办", async () => {
  const { send, tick, advance } = await harness();
  const schedule = await send("ADD_SCHEDULE", {
    text: "每分钟汇报", intervalMinutes: 1, repeatCount: -1,
  });
  await tick(1);
  const first = await send("CLAIM", {
    ready: true, assistantCount: 1, userCount: 1,
  });
  await send("SENT", { id: first.dispatch.id, verified: false });
  for (let occurrence = 2; occurrence <= 6; occurrence++) {
    await tick(1);
    const state = (await send("GET")).state;
    assert.equal(state.activeTaskId, first.dispatch.id);
    assert.equal(state.tasks.length, occurrence);
    assert.equal(state.tasks[0].status, "waiting");
    assert.equal(state.tasks.slice(1).every((task) => task.status === "pending"), true);
    assert.equal(state.schedules[0].runCount, occurrence);
    assert.equal(state.schedules[0].enabled, true);
    assert.equal(state.tasks.every((task) => task.sourceScheduleId === schedule.state.schedules[0].id), true);
    assert.equal("deferred" in state.schedules[0], false);
  }
  advance(17);
  const finished = await send("FINISHED", {
    ...voiceProof, id: first.dispatch.id, assistantFallback: true,
    assistantCount: 2, editorEmpty: true, assistantTextLength: 12,
  });
  assert.equal(finished.ok, true);
  assert.equal(finished.state.tasks.length, 5);
  assert.equal(finished.state.tasks.every((task) => task.status === "pending"), true);
  // A response completion removes one task only. The timer itself does
  // nothing here; pending tasks are dispatched by the ordinary CLAIM path.
  assert.equal(finished.state.schedules[0].runCount, 6);
  assert.equal((await send("CLAIM", { ready: true, userCount: 2, assistantCount: 2 })).dispatch.text,
    "每分钟汇报");
});

test("有限次数定时器不等回复：第二次到点就直接入队，完成回复不再产生额外任务", async () => {
  const { send, tick, advance } = await harness();
  await send("ADD_SCHEDULE", { text: "只循环一次", intervalMinutes: 1, repeatCount: 1 });
  await tick(1);
  const task = await send("CLAIM", { ready: true, assistantCount: 1, userCount: 1 });
  await send("SENT", { id: task.dispatch.id, verified: false });
  await tick(1);
  let before = (await send("GET")).state;
  assert.equal(before.tasks.length, 2);
  assert.equal(before.tasks[0].status, "waiting");
  assert.equal(before.tasks[1].status, "pending");
  assert.equal(before.schedules[0].runCount, 2);
  assert.equal(before.schedules[0].enabled, false);
  advance(17);
  const after = await send("FINISHED", {
    ...voiceProof,
    id: task.dispatch.id, assistantFallback: true, assistantAdvanced: true,
    assistantCount: 2, lastRole: "assistant", busy: false,
    editorEmpty: true, toolPending: false, assistantTextLength: 9, stableMs: 16000,
  });
  assert.equal(after.ok, true);
  assert.equal(after.state.schedules[0].runCount, 2);
  assert.equal(after.state.schedules[0].enabled, false);
  assert.equal(after.state.tasks.length, 1);
  assert.equal(after.state.tasks[0].status, "pending");
  await tick(5);
  assert.equal((await send("GET")).state.tasks.length, 1);
});

test("队列满 100 条时不会丢失到期入队机会，有空位后只补一条", async () => {
  const { send, tick, stored } = await harness({
    "cq.state.v2": {
      version: 2, legacyUnbound: null,
      conversations: {
        "chat:dialogue-a": {
          key: "chat:dialogue-a", url: A, tabId: 11, halted: false,
          activeTaskId: null, schedules: [{
            id: "once", text: "等待空位", intervalMinutes: 1,
            repeatCount: 0, enabled: true, runCount: 0,
            nextRunAt: Date.UTC(2026, 9, 15, 12, 1),
          }],
          tasks: Array.from({ length: 100 }, (_, i) => ({
            id: `preexisting-${i}`, text: `未处理 ${i}`, status: "pending",
          })),
        },
      },
    },
  });
  await tick(1);
  let current = (await send("GET")).state;
  assert.equal(current.tasks.length, 100);
  assert.equal(current.schedules[0].enabled, true);
  assert.equal(current.schedules[0].runCount, 0);
  assert.equal(current.schedules[0].nextRunAt, Date.UTC(2026, 9, 15, 12, 1));
  assert.equal((await send("SCHEDULE_PULSE")).state.tasks.length, 100);

  await send("DELETE_TASK", { id: "preexisting-0" });
  current = (await send("SCHEDULE_PULSE")).state;
  assert.equal(current.tasks.length, 100);
  assert.equal(current.tasks.at(-1).text, "等待空位");
  assert.equal(current.tasks.at(-1).status, "pending");
  assert.equal(current.schedules[0].runCount, 1);
  assert.equal(current.schedules[0].enabled, false);
  await send("SCHEDULE_PULSE");
  assert.equal(stored["cq.state.v2"].conversations["chat:dialogue-a"].tasks.length, 100);
});

test("旧版 deferred 状态仅迁移成一条队列待办，此后不再依赖回复", async () => {
  const next = Date.UTC(2026, 9, 15, 12, 10);
  const { send, advance } = await harness({
    "cq.state.v2": {
      version: 2, legacyUnbound: null,
      conversations: {
        "chat:dialogue-a": {
          key: "chat:dialogue-a", url: A, tabId: 11,
          activeTaskId: "waiting-1", halted: false,
          tasks: [{ id: "waiting-1", text: "正在回复", status: "waiting", sentAt: Date.UTC(2026, 9, 15, 12, 0) }],
          schedules: [{
            id: "old", text: "旧版本延后触发", enabled: true,
            intervalMinutes: 10, repeatCount: -1, runCount: 1,
            nextRunAt: next, deferred: true,
          }],
        },
      },
    },
  });
  const migrated = await send("HELLO", { userCount: 1 });
  assert.equal(migrated.state.tasks.length, 2);
  assert.equal(migrated.state.tasks[0].status, "waiting");
  assert.equal(migrated.state.tasks[1].status, "pending");
  assert.equal(migrated.state.tasks[1].text, "旧版本延后触发");
  assert.equal(migrated.state.schedules[0].runCount, 2);
  assert.equal("deferred" in migrated.state.schedules[0], false);
  assert.equal(migrated.state.schedules[0].nextRunAt, next);
  assert.equal((await send("HELLO")).state.tasks.length, 2);

  advance(10 * 60);
  const nextDue = await send("SCHEDULE_PULSE");
  assert.equal(nextDue.state.tasks.length, 3);
  assert.equal(nextDue.state.schedules[0].runCount, 3);
  assert.equal(nextDue.state.tasks[2].status, "pending");
});

test("用户暂停回复时定时器继续生产待办，恢复后由普通队列发送", async () => {
  const { send, tick } = await harness();
  await send("ENQUEUE", { text: "手动排队" });
  await send("STOPPED", { userCount: 1 });
  await send("ADD_SCHEDULE", { text: "每分钟新待办", intervalMinutes: 1, repeatCount: 2 });
  await tick(1);
  await tick(1);
  await tick(1);
  const state = (await send("GET")).state;
  assert.equal(state.halted, true);
  assert.equal(state.tasks.length, 4);
  assert.deepEqual(Array.from(state.tasks, (task) => task.text), [
    "手动排队", "每分钟新待办", "每分钟新待办", "每分钟新待办",
  ]);
  assert.equal(state.schedules[0].runCount, 3);
  assert.equal(state.schedules[0].enabled, false);
  assert.equal((await send("CLAIM", { ready: true })).dispatch, null);
  await send("USER_RESUMED", { userCount: 2, lastUserText: "恢复聊天" });
  assert.equal((await send("CLAIM", { ready: true })).dispatch.text, "手动排队");
});

test("旧版等待中的任务无需消息确认，页面刷新后语音按钮即可解锁", async () => {
  const sentAt = Date.UTC(2026, 9, 15, 12, 0) - 25000;
  const old = {
    id: "old-wait", text: "回复当前时间", status: "waiting",
    baselineAssistantCount: 1, baselineUserCount: 1, baselineUserId: "previous-user",
    deliveryVerified: false, sentAt,
  };
  const { send, stored } = await harness({
    "cq.state.v2": {
      version: 2, legacyUnbound: null,
      conversations: {
        "chat:dialogue-a": {
          key: "chat:dialogue-a", url: A, tabId: 11, halted: false,
          activeTaskId: old.id, error: "", tasks: [old], schedules: [],
        },
      },
    },
  });
  const evidence = { ...voiceProof, id: old.id,
    lastUserId: "previous-user", lastUserText: "别人的消息",
    lastRole: "user", assistantTextLength: 0, assistantCount: 1,
  };
  assert.equal((await send("FINISHED", { ...evidence, voiceReady: false })).ok, false);
  assert.equal((await send("FINISHED", { ...evidence, voiceStableMs: 800 })).ok, false);
  const recovered = await send("FINISHED", evidence);
  assert.equal(recovered.ok, true);
  assert.equal(recovered.state.activeTaskId, null);
  assert.equal(recovered.state.tasks.length, 0);
  assert.equal(stored["cq.state.v2"].conversations["chat:dialogue-a"].tasks.length, 0);
});

test("旧任务不需要手动确认：等待语音按钮恢复后自动继续下一条", async () => {
  const { send, advance } = await harness();
  await send("ENQUEUE", { text: "旧的卡住任务" });
  await send("ENQUEUE", { text: "下一条" });
  const claimed = await send("CLAIM", { ready: true, userCount: 1, assistantCount: 1 });
  const id = claimed.dispatch.id;
  await send("SENT", { id });
  assert.equal((await send("FINISHED", { ...voiceProof, id, voiceStableMs: 100 })).ok, false);
  advance(3);
  const recovered = await send("FINISHED", { ...voiceProof, id });
  assert.equal(recovered.ok, true);
  assert.equal(recovered.state.tasks.length, 1);
  assert.equal(recovered.state.tasks[0].text, "下一条");
  assert.equal((await send("CLAIM", { ready: true })).dispatch.text, "下一条");
});

test("即使语音按钮恢复，原生 Stop 后的任务不会被重复推进", async () => {
  const { send, advance } = await harness();
  await send("ENQUEUE", { text: "不允许自动继续" });
  const claimed = await send("CLAIM", { ready: true });
  await send("SENT", { id: claimed.dispatch.id });
  advance(65);
  await send("STOPPED", { userCount: 1 });
  const refused = await send("FINISHED", { ...voiceProof, id: claimed.dispatch.id });
  assert.equal(refused.state.halted, true);
  assert.equal(refused.state.tasks[0].status, "interrupted");
});

test("引导任意待发送任务时提前发送且不重复发送，其他任务顺序不变", async () => {
  const { send, advance } = await harness();
  await send("ENQUEUE", { text: "正在执行的任务" });
  await send("ENQUEUE", { text: "第二条普通任务" });
  await send("ENQUEUE", { text: "第三条需要引导" });
  const started = await send("CLAIM", { ready: true, userCount: 1, assistantCount: 1 });
  await send("SENT", { id: started.dispatch.id, verified: true, userCount: 2 });
  const third = (await send("GET")).state.tasks[2].id;

  const claimed = await send("STEER_CLAIM", {
    id: third, userCount: 2, lastUserId: "user-2",
  });
  assert.equal(claimed.dispatch.text, "第三条需要引导");
  assert.equal(claimed.state.tasks[2].status, "steering");
  assert.equal((await send("STEER_CLAIM", { id: third })).ok, false);
  assert.equal((await send("CLAIM", { ready: true })).dispatch, null);

  const armed = await send("STEER_CLICKED", { id: third });
  assert.equal(armed.state.tasks[2].status, "steering_wait");
  assert.equal((await send("STEER_CANCEL", { id: third })).state.tasks[2].status, "steering_wait");
  const confirmed = await send("STEER_CONFIRM", {
    id: third, userCount: 3, lastUserId: "user-3", lastUserText: "第三条需要引导",
  });
  assert.equal(confirmed.state.tasks.length, 2);
  assert.equal(confirmed.state.activeTaskId, started.dispatch.id);
  assert.equal(confirmed.state.steeringTaskId, null);
  assert.equal(confirmed.state.tasks[0].steerCount, 1);
  assert.equal(confirmed.state.tasks[0].lastSteerText, "第三条需要引导");
  assert.equal(confirmed.state.tasks[1].text, "第二条普通任务");
  assert.equal((await send("STEER_CONFIRM", { id: third, userCount: 3 })).state.tasks.length, 2);

  advance(3);
  const finished = await send("FINISHED", {
    ...voiceProof,
    id: started.dispatch.id, assistantCount: 2, userCount: 3,
    lastUserText: "第三条需要引导",
  });
  assert.equal(finished.ok, true);
  assert.equal(finished.state.tasks.length, 1);
  assert.equal((await send("CLAIM", { ready: true, assistantCount: 2, userCount: 3 })).dispatch.text,
    "第二条普通任务");
});

test("普通空闲队列也可选定一条任务提前发送，不会更改其他任务顺序", async () => {
  const { send } = await harness();
  const first = await send("ENQUEUE", { text: "原本第一条" });
  const secondId = (await send("ENQUEUE", { text: "选中的第二条" })).state.tasks[1].id;
  await send("STEER_CLAIM", { id: secondId, userCount: 0 });
  await send("STEER_CLICKED", { id: secondId });
  const confirmed = await send("STEER_CONFIRM", {
    id: secondId, userCount: 1, lastUserText: "选中的第二条",
  });
  assert.equal(confirmed.state.tasks.length, 1);
  assert.equal(confirmed.state.tasks[0].id, first.state.tasks[0].id);
  assert.equal(confirmed.state.tasks[0].text, "原本第一条");
  assert.equal(confirmed.state.activeTaskId, null);
  assert.equal((await send("CLAIM", { ready: true, userCount: 1, assistantCount: 1 })).dispatch.text,
    "原本第一条");
});

test("网页不支持即时发送时取消引导，消息保持待发送且顺序不变", async () => {
  const { send } = await harness();
  await send("ENQUEUE", { text: "第一条" });
  const id = (await send("ENQUEUE", { text: "需要引导" })).state.tasks[1].id;
  await send("STEER_CLAIM", { id, userCount: 1 });
  const result = await send("STEER_CANCEL", { id });
  assert.equal(result.state.tasks.length, 2);
  assert.equal(result.state.tasks[0].text, "第一条");
  assert.equal(result.state.tasks[1].text, "需要引导");
  assert.equal(result.state.tasks[1].status, "pending");
  assert.equal(result.state.steeringTaskId, null);
  assert.equal((await send("CLAIM", { ready: true })).dispatch.text, "第一条");
});

test("已点击引导但未确认时永不自动重试，超时只能人工核对", async () => {
  const { send, tick } = await harness();
  await send("ENQUEUE", { text: "旧任务" });
  const active = await send("CLAIM", { ready: true });
  await send("SENT", { id: active.dispatch.id, verified: true, userCount: 1 });
  const selectedId = (await send("ENQUEUE", { text: "需要即时引导" })).state.tasks[1].id;
  await send("STEER_CLAIM", { id: selectedId, userCount: 1 });
  await send("STEER_CLICKED", { id: selectedId });
  await send("ENQUEUE", { text: "第三条" });
  await tick(3);
  const uncertain = (await send("GET")).state;
  assert.equal(uncertain.halted, true);
  assert.equal(uncertain.haltReason, "steer_unconfirmed");
  assert.equal(uncertain.steeringTaskId, null);
  assert.equal(uncertain.tasks[1].status, "error");
  assert.equal(uncertain.tasks[2].status, "pending");
  assert.equal((await send("CLAIM", { ready: true })).dispatch, null);

  const safe = await send("SKIP_FAILED", { id: selectedId });
  assert.equal(safe.state.halted, false);
  assert.equal(safe.state.tasks.length, 2);
  assert.equal(safe.state.activeTaskId, active.dispatch.id);
  assert.equal(safe.state.tasks[1].text, "第三条");
  assert.equal((await send("CLAIM", { ready: true })).dispatch, null);
});

test("引导不能串对话或抢占正在填入输入框的任务，手动停止不自动恢复", async () => {
  const { send } = await harness();
  await send("ENQUEUE", { text: "A 第一条" }, 11);
  const id = (await send("ENQUEUE", { text: "A 第二条" }, 11)).state.tasks[1].id;
  assert.equal((await send("STEER_CLAIM", { id }, 12)).ok, false);
  const first = await send("CLAIM", { ready: true }, 11);
  assert.equal((await send("STEER_CLAIM", { id }, 11)).ok, false);
  await send("SENT", { id: first.dispatch.id, verified: true, userCount: 1 }, 11);
  await send("STEER_CLAIM", { id, userCount: 1 }, 11);
  await send("STOPPED", { userCount: 1 }, 11);
  const stopped = (await send("GET", {}, 11)).state;
  assert.equal(stopped.halted, true);
  assert.equal(stopped.haltReason, "user");
  assert.equal(stopped.steeringTaskId, null);
  assert.equal(stopped.tasks[1].status, "pending");
  assert.equal((await send("STEER_CLAIM", { id }, 11)).ok, false);
});

test("有限定时器在引导第一条时仍按时生成第二条普通待办", async () => {
  const { send, tick } = await harness();
  await send("ADD_SCHEDULE", { text: "定时引导", intervalMinutes: 1, repeatCount: 1 });
  await tick(1);
  const first = (await send("GET")).state;
  const selectedId = first.tasks[0].id;
  await send("STEER_CLAIM", { id: selectedId, userCount: 0 });
  await tick(1);
  const reserved = (await send("GET")).state;
  assert.equal(reserved.tasks.length, 2);
  assert.equal(reserved.tasks[0].status, "steering");
  assert.equal(reserved.tasks[1].status, "pending");
  assert.equal(reserved.schedules[0].runCount, 2);
  assert.equal(reserved.schedules[0].enabled, false);
  assert.equal("deferred" in reserved.schedules[0], false);
  const restored = await send("STEER_CANCEL", { id: selectedId });
  assert.equal(restored.state.tasks[0].status, "pending");
  assert.equal(restored.state.tasks.length, 2);
  assert.equal(restored.state.schedules[0].runCount, 2);
  const steer = await send("STEER_CLAIM", { id: selectedId, userCount: 0 });
  assert.equal(steer.dispatch.text, "定时引导");
  await send("STEER_CLICKED", { id: selectedId });
  const sent = await send("STEER_CONFIRM", {
    id: selectedId, userCount: 1, lastUserText: "定时引导",
  });
  assert.equal(sent.state.tasks.length, 1);
  assert.equal(sent.state.tasks[0].status, "pending");
  assert.equal(sent.state.schedules[0].runCount, 2);
});

test("尚未点击发送的引导锁超时后安全回队列，不会造成永久锁定", async () => {
  const { send, tick } = await harness();
  await send("ENQUEUE", { text: "第一条普通消息" });
  const id = (await send("ENQUEUE", { text: "第二条引导" })).state.tasks[1].id;
  await send("STEER_CLAIM", { id, userCount: 0 });
  await tick(2);
  const recovered = (await send("GET")).state;
  assert.equal(recovered.steeringTaskId, null);
  assert.equal(recovered.tasks[1].status, "pending");
  assert.equal(recovered.halted, false);
  assert.equal((await send("CLAIM", { ready: true })).dispatch.text, "第一条普通消息");
});

test("确认引导需要匹配新用户消息，错误文本或未变化的用户消息不能移除队列任务", async () => {
  const { send } = await harness();
  const id = (await send("ENQUEUE", { text: "要引导的消息" })).state.tasks[0].id;
  await send("STEER_CLAIM", { id, userCount: 3, lastUserId: "u3" });
  await send("STEER_CLICKED", { id });
  assert.equal((await send("STEER_CONFIRM", {
    id, userCount: 3, lastUserId: "u3", lastUserText: "要引导的消息",
  })).ok, false);
  assert.equal((await send("STEER_CONFIRM", {
    id, userCount: 4, lastUserId: "u4", lastUserText: "其他消息",
  })).ok, false);
  assert.equal((await send("GET")).state.tasks[0].status, "steering_wait");
  const confirmed = await send("STEER_CONFIRM", {
    id, userCount: 3, lastUserId: "u4", lastUserText: "要引导的消息",
  });
  assert.equal(confirmed.ok, true);
  assert.equal(confirmed.state.tasks.length, 0);
});

test("引导已点击后用户主动停止，不得从失败项重新开启用户暂停的队列", async () => {
  const { send } = await harness();
  const id = (await send("ENQUEUE", { text: "原本待发送" })).state.tasks[0].id;
  await send("STEER_CLAIM", { id, userCount: 0 });
  await send("STEER_CLICKED", { id });
  const stopped = await send("STOPPED", { userCount: 1 });
  assert.equal(stopped.state.steeringTaskId, null);
  assert.equal(stopped.state.halted, true);
  assert.equal(stopped.state.haltReason, "user");
  assert.equal(stopped.state.tasks[0].status, "error");
  const stillStopped = await send("SKIP_FAILED", { id });
  assert.equal(stillStopped.state.halted, true);
  assert.equal(stillStopped.state.tasks.length, 1);
});

test("新任务必须等语音模式按钮稳定恢复，单有新回复或麦克风不能推动无限定时队列", async () => {
  const { send, tick, advance } = await harness();
  await send("ADD_SCHEDULE", {text:"定时语音按钮验证",intervalMinutes:1,repeatCount:-1});
  await tick(1);
  const started=await send("CLAIM",{ready:true,userCount:2,assistantCount:2,
    lastAssistantId:"a2",lastAssistantSignature:"7|旧回答内容"});
  const id=started.dispatch.id;
  await send("SENT",{id,verified:false});
  advance(4);
  const proof={...voiceProof,id,assistantFallback:true,assistantCount:3,
    lastAssistantId:"a3",lastAssistantSignature:"9|新的回答内容",stableMs:2100};

  assert.equal((await send("FINISHED",{...proof,voiceReady:false})).ok,false);
  assert.equal((await send("FINISHED",{...proof,voiceStableMs:300})).ok,false);
  assert.equal((await send("FINISHED",{...proof,busy:true})).ok,false);
  assert.equal((await send("FINISHED",{...proof,editorEmpty:false})).ok,false);
  // Assistant text/IDs are intentionally irrelevant once Voice Mode returns.
  const stillWaiting=(await send("GET")).state;
  assert.equal(stillWaiting.activeTaskId,id);
  assert.equal(stillWaiting.tasks[0].status,"waiting");

  const finished=await send("FINISHED",proof);
  assert.equal(finished.ok,true);
  assert.equal(finished.state.tasks.length,0);
  assert.equal(finished.state.halted,false);
  await tick(1);
  const next=(await send("GET")).state;
  assert.equal(next.tasks.length,1);
  assert.equal(next.schedules[0].runCount,2);
  assert.equal(next.schedules[0].enabled,true);
  assert.equal((await send("CLAIM",{ready:true,assistantCount:3,userCount:3})).dispatch.text,
    "定时语音按钮验证");
});

test("领取任务后语音按钮临时消失，未点击发送应安全回队列且不会暂停定时器", async () => {
  const { send, tick, advance } = await harness();
  await send("ADD_SCHEDULE", {text:"语音按钮反复切换",intervalMinutes:1,repeatCount:-1});
  await tick(1);
  const before=(await send("GET")).state;
  const claimed=await send("CLAIM",{ready:true,userCount:2,assistantCount:2});
  assert.equal(claimed.dispatch.text,"语音按钮反复切换");
  const release=await send("RELEASE_CLAIM",{id:claimed.dispatch.id});
  assert.equal(release.state.tasks.length,1);
  assert.equal(release.state.tasks[0].id,before.tasks[0].id);
  assert.equal(release.state.tasks[0].status,"pending");
  assert.equal(release.state.activeTaskId,null);
  assert.equal(release.state.halted,false);
  assert.equal(release.state.schedules[0].enabled,true);
  assert.equal((await send("CLAIM",{ready:true})).dispatch,null);
  advance(3);
  const restored=await send("CLAIM",{ready:true,userCount:2,assistantCount:2});
  assert.equal(restored.dispatch.text,"语音按钮反复切换");
  assert.equal(restored.state.schedules[0].runCount,1);
});
