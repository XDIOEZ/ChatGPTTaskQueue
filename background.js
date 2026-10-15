/* global chrome */
"use strict";

// One serialized service worker owns every conversation's queue. The storage
// envelope is shared, but task dispatch and scheduler state are per-chat.
const STORAGE_KEY = "cq.state.v2";
const LEGACY_KEY = "cq.state.v1";
const ALARM_NAME = "cq.scheduler";
const MAX_PENDING = 100;
const MAX_TEXT_LENGTH = 12000;
const MAX_REPEAT_COUNT = 1_000_000;
const WAIT_TIMEOUT_MS = 45 * 60 * 1000;
const DISPATCH_TIMEOUT_MS = 90 * 1000;
const STEER_RESERVE_TIMEOUT_MS = 60 * 1000;
const STEER_CONFIRM_TIMEOUT_MS = 2 * 60 * 1000;

let serial = Promise.resolve();

function exclusive(work) {
  const result = serial.then(work, work);
  serial = result.catch((error) => console.error("[ChatQueue]", error));
  return result;
}

function blankSession(key, url = null, tabId = null) {
  return {
    key,
    url,
    tabId,
    halted: false,
    haltReason: null,
    haltAtUserCount: null,
    activeTaskId: null,
    steeringTaskId: null,
    autoOpenTab: false,
    error: "",
    tasks: [],
    schedules: [],
  };
}

function blankStore() {
  return { version: 2, conversations: {}, legacyUnbound: null };
}

function chatKey(url) {
  const normal = safeUrl(url);
  if (!normal) return null;
  const match = new URL(normal).pathname.match(/(?:^|\/)c\/([a-zA-Z0-9-]+)$/);
  return match ? `chat:${match[1]}` : null;
}

function resolveKey(url, tabId) {
  return chatKey(url) || (safeUrl(url) && Number.isInteger(tabId) ? `draft:${tabId}` : null);
}

function convertLegacy(old) {
  const sessionKey = resolveKey(old.target?.url, old.target?.tabId);
  const session = blankSession(sessionKey, safeUrl(old.target?.url), old.target?.tabId ?? null);
  session.halted = Boolean(old.paused);
  session.haltReason = session.halted ? "user" : null;
  session.autoOpenTab = Boolean(old.autoOpenTab);
  session.error = old.error || "";
  session.tasks = (old.tasks || []).filter((task) => task.status !== "done");
  session.schedules = old.schedules || [];
  session.activeTaskId = old.activeTaskId || null;
  // Without a prior binding we cannot safely infer which chat owns old work.
  if (!sessionKey) {
    session.halted = true;
    session.haltReason = "legacy";
    session.error = "旧版有未绑定的任务，请选择目标对话后导入。";
  }
  return session;
}

async function readStore() {
  const data = await chrome.storage.local.get([STORAGE_KEY, LEGACY_KEY]);
  if (data[STORAGE_KEY]?.version === 2) return data[STORAGE_KEY];
  const result = blankStore();
  const old = data[LEGACY_KEY];
  if (old?.version === 1) {
    const session = convertLegacy(old);
    if (session.key) result.conversations[session.key] = session;
    else if (session.tasks.length || session.schedules.length) result.legacyUnbound = session;
  }
  await saveStore(result);
  return result;
}

async function saveStore(store) {
  await chrome.storage.local.set({ [STORAGE_KEY]: store });
}

function sessionFor(store, key, url = null, tabId = null) {
  return store.conversations[key] || blankSession(key, url, tabId);
}

function id() {
  return crypto.randomUUID();
}

function safeUrl(input) {
  try {
    const parsed = new URL(input);
    if (parsed.protocol !== "https:" || !["chatgpt.com", "chat.openai.com"].includes(parsed.hostname)) {
      return null;
    }
    return parsed.origin + (parsed.pathname.replace(/\/+$/, "") || "/");
  } catch {
    return null;
  }
}

function requireText(value) {
  if (typeof value !== "string" || !value.trim()) throw new Error("提示词不能为空");
  if (value.length > MAX_TEXT_LENGTH) throw new Error("提示词不能超过 12000 字符");
  return value.trim();
}

function sameMessage(a, b) {
  return String(a || "").replace(/\s+/g, " ").trim() ===
    String(b || "").replace(/\s+/g, " ").trim();
}

function pendingCount(state) {
  return state.tasks.filter((task) =>
    ["pending", "dispatching", "waiting", "steering", "steering_wait"].includes(task.status)).length;
}

function recoverObsoleteHalt(state) {
  // Classify an old persisted halt. Actual recovery always requires a fresh
  // stable native Voice Mode signal from the owner tab (RECOVER_ON_VOICE).
  if (state.halted && !state.haltReason &&
      /用户已停止回复|用户停止生成|用户已暂停|人工暂停|手动停止|已暂停队列/.test(state.error || "")) {
    state.haltReason = "user";
    return true;
  }
  // Legacy technical errors may carry arbitrary server/browser error strings
  // such as '消息传输超时，请重试。', not only our older send-warning wording.
  if (state.halted && !state.haltReason && String(state.error || "").trim()) {
    state.haltReason = "failure";
    return true;
  }
  return false;
}

const VOICE_RECOVERABLE_HALTS = new Set([
  "failure", "timeout", "uncertain", "steer_unconfirmed",
]);

function resumeTechnicalHalt(state) {
  if (!state.halted || !VOICE_RECOVERABLE_HALTS.has(state.haltReason)) return false;

  // A send click may have succeeded despite an error/timeout. Retire any
  // ambiguous in-flight work instead of restoring it to 'pending'. Never
  // re-send that same prompt when normal queue dispatch resumes.
  const active = state.tasks.find((task) => task.id === state.activeTaskId);
  if (active) {
    if (!["error", "interrupted"].includes(active.status)) {
      active.status = "error";
      active.error ||= "本轮发送状态不确定，已跳过，不会自动重发。";
    }
    state.activeTaskId = null;
  }
  const steering = state.tasks.find((task) => task.id === state.steeringTaskId);
  if (steering) {
    if (steering.status === "steering_wait") {
      steering.status = "error";
      steering.error ||= "提前发送状态不确定，已跳过，不会自动重发。";
    } else if (steering.status === "steering") {
      // Even an unclicked reservation is no longer replayed on recovery;
      // we cannot prove it was not sent after a script reload.
      steering.status = "error";
      steering.error ||= "提前发送中断，已跳过，不会自动重发。";
    }
    state.steeringTaskId = null;
  }
  state.halted = false;
  state.haltReason = null;
  state.haltAtUserCount = null;
  state.error = "";
  return true;
}

function ownerMatches(session, sender) {
  return Boolean(session && sender.tab && session.tabId === sender.tab.id);
}

function targetMatches(session, sender, url) {
  return ownerMatches(session, sender) && session.key === resolveKey(url, sender.tab?.id);
}

function adoptNewChat(store, sender, url, lastUserText) {
  const nextKey = chatKey(url);
  const draftKey = `draft:${sender.tab?.id}`;
  const draft = store.conversations[draftKey];
  if (!nextKey || !draft || !ownerMatches(draft, sender)) return false;
  const active = draft.tasks.find((task) => task.id === draft.activeTaskId);
  if (!active || (active.status !== "dispatching" && active.status !== "waiting")) return false;
  if (!sameMessage(active.text, lastUserText)) return false;
  if (store.conversations[nextKey]) return false; // Never overwrite an existing chat.
  draft.key = nextKey;
  draft.url = safeUrl(url);
  store.conversations[nextKey] = draft;
  delete store.conversations[draftKey];
  return true;
}

function newTask(text, sourceScheduleId = null) {
  return {
    id: id(),
    text,
    status: "pending",
    sourceScheduleId,
    createdAt: Date.now(),
  };
}

function repeatLimit(value) {
  // -1 = unlimited; 0 = one occurrence; N > 0 = first + N repeats.
  // Schedules stored by earlier versions have no repeatCount and stay infinite.
  return value == null ? -1 : value;
}

function requireRepeatCount(value) {
  const result = value == null ? -1 : Number(value);
  if (value === "" || !Number.isInteger(result) || result < -1 || result > MAX_REPEAT_COUNT) {
    throw new Error("循环次数必须为 -1（无限）、0（单次）或 1～1000000 的整数");
  }
  return result;
}

function dueSchedules(state, now = Date.now()) {
  // Timers ONLY create ordinary queue items. They never inspect the active
  // reply, wait for its completion, or claim/send a task themselves.
  let changed = false;
  for (const schedule of state.schedules) {
    // Migrate an old one-time delayed tick into a queue item. This field is
    // never generated by the new scheduler; old 'false' values are discarded.
    const legacyDue = schedule.deferred === true && schedule.enabled;
    if (!legacyDue && "deferred" in schedule) {
      delete schedule.deferred;
      changed = true;
    }
    if (!schedule.enabled) continue;

    const period = schedule.intervalMinutes * 60_000;
    if (!Number.isFinite(period) || period <= 0) continue;
    const repeats = repeatLimit(schedule.repeatCount);
    if (repeats >= 0 && (schedule.runCount || 0) >= repeats + 1) {
      schedule.enabled = false;
      changed = true;
      continue;
    }
    const due = now >= schedule.nextRunAt;
    if (!due && !legacyDue) continue;
    if (pendingCount(state) >= MAX_PENDING) continue; // Retry on the next pulse.

    // One real queued item per due timer. Even if an earlier occurrence is
    // still waiting for ChatGPT, the new item is appended behind it.
    state.tasks.push(newTask(schedule.text, schedule.id));
    schedule.runCount = (schedule.runCount || 0) + 1;
    schedule.lastRunAt = now;
    if (legacyDue) delete schedule.deferred;
    if (due) {
      // Coalesce browser sleep/restart gaps into ONE occurrence, not a burst.
      const skipped = Math.floor((now - schedule.nextRunAt) / period) + 1;
      schedule.nextRunAt += skipped * period;
    }
    if (repeats >= 0 && schedule.runCount >= repeats + 1) schedule.enabled = false;
    changed = true;
  }
  return changed;
}

function checkTimeout(state, now = Date.now()) {
  const active = state.tasks.find((task) => task.id === state.activeTaskId);
  if (!active) return false;
  const started = active.sentAt || active.claimedAt || now;
  const timeout = active.status === "waiting" ? WAIT_TIMEOUT_MS : DISPATCH_TIMEOUT_MS;
  if (now - started <= timeout) return false;
  const wasWaiting = active.status === "waiting";
  active.status = "error";
  active.error = "等待超时，无法确认是否成功发送/回复；请人工检查后恢复。";
  state.activeTaskId = null;
  state.halted = true;
  state.haltReason = "timeout";
  state.haltAtUserCount = Number.isInteger(active.baselineUserCount)
    ? active.baselineUserCount + (wasWaiting ? 1 + (active.steerCount || 0) : 0)
    : null;
  state.error = active.error;
  return true;
}

function checkSteerTimeout(state, now = Date.now()) {
  const task = state.tasks.find((item) => item.id === state.steeringTaskId);
  if (!task) {
    if (!state.steeringTaskId) return false;
    state.steeringTaskId = null;
    return true;
  }
  if (task.status === "steering" && now - task.steerClaimedAt > STEER_RESERVE_TIMEOUT_MS) {
    // The native Send button was never armed. It is safe to restore the item.
    task.status = "pending";
    state.steeringTaskId = null;
    return true;
  }
  if (task.status === "steering_wait" && now - task.steerClickedAt > STEER_CONFIRM_TIMEOUT_MS) {
    // A click may already have sent the message. NEVER retry automatically.
    task.status = "error";
    task.error = "引导消息是否送达尚未确认，请先核对对话后跳过。";
    state.steeringTaskId = null;
    state.halted = true;
    state.haltReason = "steer_unconfirmed";
    state.error = task.error;
    return true;
  }
  return false;
}

async function reattachIfOldTabClosed(session, sender, url) {
  if (!session || session.key !== resolveKey(url, sender.tab?.id) || !sender.tab) return false;
  if (session.tabId === sender.tab.id) return false;
  try {
    const previousTab = await chrome.tabs.get(session.tabId);
    if (chatKey(previousTab.url) === session.key) {
      // A newly opened foreground tab of the *same* chat may take ownership
      // only when nothing is executing. An old background tab otherwise keeps
      // the scheduler from ever dispatching in the visible tab.
      if (session.activeTaskId || sender.tab.active !== true) return false;
    }
  } catch { /* Closed tab: safe to take over. */ }
  session.tabId = sender.tab.id;
  session.url = safeUrl(url);
  return true;
}

async function handle(message, sender) {
  const store = await readStore();
  const tabId = sender.tab?.id ?? null;
  const url = safeUrl(message.url);
  const key = resolveKey(url, tabId);
  if (!key) throw new Error("只支持 ChatGPT 的有效对话页面");
  let changed = adoptNewChat(store, sender, url, message.lastUserText);
  const existing = store.conversations[key];
  const state = sessionFor(store, key, url, tabId);
  // This also repairs an old Queue 0 + permanently-red-warning state before
  // the scheduler is evaluated or the UI is returned on HELLO / GET.
  changed = recoverObsoleteHalt(state) || changed;
  let dispatch = null;

  switch (message.type) {
    case "HELLO":
      if (existing && await reattachIfOldTabClosed(state, sender, message.url)) changed = true;
      if (existing && state.halted && state.haltAtUserCount == null &&
          Number.isInteger(message.userCount)) {
        state.haltAtUserCount = message.userCount;
        changed = true;
      }
      if (existing && dueSchedules(state)) changed = true;
      break;

    case "SCHEDULE_PULSE":
      // An open ChatGPT tab can tick precisely when the countdown reaches zero.
      // The minute alarm below is still the fallback for hidden/closed tabs.
      if (existing && dueSchedules(state)) changed = true;
      break;

    case "RECOVER_ON_VOICE": {
      // The page owns the Voice Mode readiness observation. Verify the same
      // evidence as FINISHED and the exact tab/chat binding before resuming.
      if (!targetMatches(state, sender, url) ||
          message.voiceReady !== true || message.editorEmpty !== true ||
          message.busy !== false || !Number.isFinite(message.voiceStableMs) ||
          message.voiceStableMs < 1700) break;
      changed = resumeTechnicalHalt(state) || changed;
      break;
    }

    case "ENQUEUE": {
      const text = requireText(message.text);
      if (pendingCount(state) >= MAX_PENDING) throw new Error("待执行队列最多 100 条");
      if (existing) changed = await reattachIfOldTabClosed(state, sender, url) || changed;
      if (!state.url) state.url = url;
      if (state.tabId == null) state.tabId = tabId;
      // Do not automatically resume a conversation explicitly stopped by user.
      state.tasks.push(newTask(text));
      changed = true;
      break;
    }

    case "ADD_TASK":
      if (pendingCount(state) >= MAX_PENDING) throw new Error("待执行队列最多 100 条");
      if (!state.url) state.url = url;
      if (state.tabId == null) state.tabId = tabId;
      state.tasks.push(newTask(requireText(message.text)));
      changed = true;
      break;

    case "EDIT_TASK": {
      const task = state.tasks.find((item) => item.id === message.id);
      if (!task || task.status !== "pending") throw new Error("只能编辑未发送任务");
      task.text = requireText(message.text);
      changed = true;
      break;
    }

    case "MOVE_TASK": {
      const idx = state.tasks.findIndex((item) => item.id === message.id);
      if (idx < 0 || state.tasks[idx].status !== "pending") break;
      const step = message.direction === "up" ? -1 : 1;
      const pending = state.tasks.map((task, index) => task.status === "pending" ? index : -1)
        .filter((index) => index !== -1);
      const pos = pending.indexOf(idx);
      const neighbor = pending[pos + step];
      if (neighbor !== undefined) {
        [state.tasks[idx], state.tasks[neighbor]] = [state.tasks[neighbor], state.tasks[idx]];
        changed = true;
      }
      break;
    }

    case "DELETE_TASK": {
      const idx = state.tasks.findIndex((task) => task.id === message.id);
      if (idx < 0) break;
      if (state.tasks[idx].id === state.activeTaskId ||
          state.tasks[idx].id === state.steeringTaskId) {
        throw new Error("正在发送的任务不能删除，请等确认后再操作");
      }
      state.tasks.splice(idx, 1);
      changed = true;
      break;
    }

    case "STEER_CLAIM": {
      if (!targetMatches(state, sender, url) || state.halted) {
        throw new Error("当前对话不可即时发送，请先返回原对话或核对暂停状态");
      }
      if (state.steeringTaskId || state.activeTaskId &&
          state.tasks.find((item) => item.id === state.activeTaskId)?.status !== "waiting") {
        throw new Error("已有消息正在发送，请稍后再引导");
      }
      const task = state.tasks.find((item) => item.id === message.id);
      if (!task || task.status !== "pending") throw new Error("只能引导待发送的队列任务");
      task.status = "steering";
      task.steerClaimedAt = Date.now();
      task.steerBaselineUserCount = Number.isInteger(message.userCount) ? message.userCount : 0;
      task.steerBaselineUserId = typeof message.lastUserId === "string" ? message.lastUserId : null;
      state.steeringTaskId = task.id;
      dispatch = { id: task.id, text: task.text };
      changed = true;
      break;
    }

    case "STEER_CANCEL": {
      if (!targetMatches(state, sender, url)) break;
      const task = state.tasks.find((item) => item.id === message.id &&
        item.id === state.steeringTaskId);
      if (!task || task.status !== "steering") break;
      // No native Send click took place; keep its original queue order.
      task.status = "pending";
      state.steeringTaskId = null;
      changed = true;
      break;
    }

    case "STEER_CLICKED": {
      if (!targetMatches(state, sender, url) || state.halted) {
        throw new Error("当前对话已暂停，拒绝提前发送");
      }
      const task = state.tasks.find((item) => item.id === message.id &&
        item.id === state.steeringTaskId);
      if (!task || task.status !== "steering") throw new Error("引导任务未被锁定，拒绝发送");
      // Persist BEFORE clicking. A browser crash here cannot cause a retry.
      task.status = "steering_wait";
      task.steerClickedAt = Date.now();
      changed = true;
      break;
    }

    case "STEER_CONFIRM": {
      if (!targetMatches(state, sender, url)) break;
      const task = state.tasks.find((item) => item.id === message.id &&
        item.id === state.steeringTaskId);
      if (!task || task.status !== "steering_wait") break;
      const newTurn = Number.isInteger(message.userCount) &&
        message.userCount > task.steerBaselineUserCount ||
        Boolean(message.lastUserId && task.steerBaselineUserId &&
          message.lastUserId !== task.steerBaselineUserId) ||
        message.newUserElement === true;
      if (!newTurn || !sameMessage(task.text, message.lastUserText)) {
        throw new Error("没有观察到属于这条引导任务的新用户消息");
      }
      const active = state.tasks.find((item) => item.id === state.activeTaskId);
      if (active?.status === "waiting") {
        active.steerCount = (active.steerCount || 0) + 1;
        active.lastSteerText = task.text;
        active.lastSteerAt = Date.now();
      }
      // Exactly once: remove the steered item so the ordinary queue cannot
      // send it a second time, regardless of which pending index it occupied.
      state.tasks.splice(state.tasks.indexOf(task), 1);
      state.steeringTaskId = null;
      changed = true;
      break;
    }

    case "STEER_UNCONFIRMED": {
      if (!targetMatches(state, sender, url)) break;
      const task = state.tasks.find((item) => item.id === message.id &&
        item.id === state.steeringTaskId);
      if (!task || task.status !== "steering_wait") break;
      task.status = "error";
      task.error = "引导消息是否送达尚未确认，请核对对话，不会自动重发。";
      state.steeringTaskId = null;
      state.halted = true;
      state.haltReason = "steer_unconfirmed";
      state.error = task.error;
      changed = true;
      break;
    }

    case "ADD_SCHEDULE":
    case "EDIT_SCHEDULE": {
      const text = requireText(message.text);
      const intervalMinutes = Number(message.intervalMinutes);
      const repeatCount = requireRepeatCount(message.repeatCount);
      if (!Number.isInteger(intervalMinutes) || intervalMinutes < 1 || intervalMinutes > 525600) {
        throw new Error("间隔应为 1～525600 分钟之间的整数");
      }
      if (message.type === "EDIT_SCHEDULE") {
        const item = state.schedules.find((s) => s.id === message.id);
        if (!item) throw new Error("定时任务不存在");
        Object.assign(item, {
          text, intervalMinutes, repeatCount, runCount: 0, lastRunAt: null,
          nextRunAt: Date.now() + intervalMinutes * 60_000,
        });
        delete item.deferred;
      } else {
        if (!state.url) state.url = url;
        if (state.tabId == null) state.tabId = tabId;
        state.schedules.push({
          id: id(), text, intervalMinutes, repeatCount, runCount: 0, enabled: true,
          nextRunAt: Date.now() + intervalMinutes * 60_000,
          lastRunAt: null,
        });
      }
      changed = true;
      break;
    }

    case "TOGGLE_SCHEDULE": {
      const item = state.schedules.find((s) => s.id === message.id);
      if (!item) throw new Error("定时任务不存在");
      item.enabled = !item.enabled;
      delete item.deferred;
      if (item.enabled) {
        // Re-enabling an exhausted finite schedule starts a fresh full cycle.
        const repeats = repeatLimit(item.repeatCount);
        if (repeats >= 0 && (item.runCount || 0) >= repeats + 1) {
          item.runCount = 0;
          item.lastRunAt = null;
        }
        item.nextRunAt = Date.now() + item.intervalMinutes * 60_000;
      }
      changed = true;
      break;
    }

    case "DELETE_SCHEDULE":
      state.schedules = state.schedules.filter((item) => item.id !== message.id);
      changed = true;
      break;

    case "AUTO_OPEN":
      state.autoOpenTab = Boolean(message.enabled);
      changed = true;
      break;

    case "CLAIM": {
      if (state.halted || state.activeTaskId || state.steeringTaskId ||
          !targetMatches(state, sender, url) || !message.ready) break;
      const task = state.tasks.find((item) => item.status === "pending" &&
        (!item.retryNotBefore || Date.now() >= item.retryNotBefore));
      if (!task) break;
      task.status = "dispatching";
      task.claimedAt = Date.now();
      task.baselineUserCount = Math.max(0, Number(message.userCount) || 0);
      task.baselineUserId = typeof message.lastUserId === "string" ? message.lastUserId : null;
      state.activeTaskId = task.id;
      dispatch = {
        id: task.id, text: task.text,
        baselineUserCount: task.baselineUserCount,
        baselineUserId: task.baselineUserId,
      };
      changed = true;
      break;
    }

    case "RELEASE_CLAIM": {
      // The Voice Mode button disappeared or the composer changed BEFORE any
      // native Send click. Release the lock without sending or pausing.
      if (!targetMatches(state, sender, url)) break;
      const task = state.tasks.find((item) => item.id === message.id &&
        item.id === state.activeTaskId && item.status === "dispatching");
      if (!task) break;
      task.status = "pending";
      task.retryNotBefore = Date.now() + 2500;
      state.activeTaskId = null;
      changed = true;
      break;
    }

    case "SENT": {
      if (!targetMatches(state, sender, url)) throw new Error("对话地址变化，拒绝确认发送");
      const task = state.tasks.find((item) => item.id === message.id);
      if (!task || task.id !== state.activeTaskId || task.status !== "dispatching") {
        // An async send from a previous chat must be reported as an error,
        // not silently acknowledged as sent in the newly opened chat.
        throw new Error("任务不属于当前对话，拒绝确认发送");
      }
      task.status = "waiting";
      task.sentAt = Date.now();
      changed = true;
      break;
    }

    case "STEER_SENT": {
      // A native immediate message was observed in the original conversation.
      // It must not look like a foreign user message to the queue watchdog.
      if (!targetMatches(state, sender, url)) break;
      const task = state.tasks.find((item) => item.id === state.activeTaskId);
      if (!task || task.status !== "waiting") break;
      const text = requireText(message.text);
      const prior = task.steerCount || 0;
      if (!sameMessage(message.lastUserText, text) ||
          message.userCount !== task.baselineUserCount + 2 + prior) {
        throw new Error("引导消息状态无法确认，队列未更新");
      }
      task.steerCount = prior + 1;
      task.lastSteerText = text;
      task.lastSteerAt = Date.now();
      changed = true;
      break;
    }

    case "FINISHED": {
      if (!targetMatches(state, sender, url)) break;
      if (state.steeringTaskId) break;
      const task = state.tasks.find((item) => item.id === message.id);
      if (!task || task.id !== state.activeTaskId || task.status !== "waiting") break;
      // The ONLY completion gate is the native Voice Mode (waveform) button
      // returning stable after an actual Send click. No user-bubble detection,
      // assistant-text comparison, or a second post-send confirmation phase.
      // These fields are sampled by our content script, not by the timer.
      if (message.voiceReady !== true || message.editorEmpty !== true ||
          message.busy !== false || !Number.isFinite(message.voiceStableMs) ||
          message.voiceStableMs < 1700 || !Number.isFinite(task.sentAt) ||
          Date.now() - task.sentAt < 1700) {
        throw new Error("语音模式按钮尚未稳定恢复，继续等待");
      }
      // Remove exactly this task and release the lock; all later and timed
      // tasks now use the same ordinary CLAIM dispatch path.
      state.tasks.splice(state.tasks.indexOf(task), 1);
      state.activeTaskId = null;
      changed = true;
      break;
    }

    case "STOPPED": {
      if (!targetMatches(state, sender, url)) break;
      // A trusted click on ChatGPT's native Stop generating button is the
      // user's explicit signal to halt this conversation's entire queue.
      state.halted = true;
      state.haltReason = "user";
      state.haltAtUserCount = Number.isInteger(message.userCount) ? message.userCount : null;
      state.error = "用户已停止回复；本对话队列暂停，直到用户再次发送消息或继续生成。";
      const task = state.tasks.find((item) => item.id === state.activeTaskId);
      if (task) {
        task.status = "interrupted"; // Never resend an interrupted message.
        task.error = "已停止生成，未确认完成；此任务不会自动重发。";
        state.activeTaskId = null;
      }
      const steering = state.tasks.find((item) => item.id === state.steeringTaskId);
      if (steering) {
        // Before a click: safe rollback. After a click: ambiguous, no retry.
        steering.status = steering.status === "steering" ? "pending" : "error";
        if (steering.status === "error") steering.error = "已停止生成，请核对刚才的引导是否发出。";
        state.steeringTaskId = null;
      }
      changed = true;
      break;
    }

    case "USER_RESUMED": {
      if (!targetMatches(state, sender, url) || !state.halted) break;
      const hasNewUserMessage = Number.isInteger(message.userCount) &&
        Number.isInteger(state.haltAtUserCount) &&
        message.userCount > state.haltAtUserCount && Boolean(String(message.lastUserText || "").trim());
      const clickedContinue = message.viaNativeContinue === true;
      if (!hasNewUserMessage && !clickedContinue) break;
      state.halted = false;
      state.haltReason = null;
      state.haltAtUserCount = null;
      state.error = "";
      changed = true;
      break;
    }

    case "UNCERTAIN_SEND": {
      if (!targetMatches(state, sender, url)) break;
      state.halted = true;
      state.haltReason = "uncertain";
      state.haltAtUserCount = Number.isInteger(message.userCount) ? message.userCount : null;
      state.error = "即时发送结果不确定，已停止自动接力；请先检查聊天记录。";
      changed = true;
      break;
    }

    case "SKIP_FAILED": {
      if (!targetMatches(state, sender, url)) break;
      const index = state.tasks.findIndex((task) => task.id === message.id && task.status === "error");
      if (index < 0 || state.steeringTaskId ||
          state.haltReason === "user" ||
          state.activeTaskId && state.haltReason !== "steer_unconfirmed") break;
      // Explicit recovery after the user has checked the conversation.
      // Never retry the failed task, even when sending was uncertain.
      state.tasks.splice(index, 1);
      state.error = "";
      state.halted = false;
      state.haltReason = null;
      state.haltAtUserCount = null;
      changed = true;
      break;
    }

    case "ACK_RECOVERY": {
      // Explicit recovery when a *newer* delivery failure has been confirmed
      // by the user. Does not modify or resend an uncertain task.
      if (!targetMatches(state, sender, url) || state.activeTaskId ||
          !state.halted || state.haltReason === "user") break;
      state.halted = false;
      state.haltReason = null;
      state.haltAtUserCount = null;
      state.error = "";
      changed = true;
      break;
    }

    case "FAIL": {
      // A tab may have navigated away between CLAIM and FAIL. Find only the
      // active task owned by that exact tab, without altering a new chat.
      const failed = Object.values(store.conversations).find((conversation) =>
        ownerMatches(conversation, sender) && conversation.activeTaskId === message.id
      ) || (state.activeTaskId === message.id && ownerMatches(state, sender) ? state : null);
      if (!failed) break;
      const task = failed.tasks.find((item) => item.id === message.id);
      if (!task) break;
      const wasWaiting = task.status === "waiting";
      task.status = "error";
      task.error = String(message.error || "发送失败，可能已经发送，请人工确认").slice(0, 240);
      failed.activeTaskId = null;
      failed.halted = true;
      failed.haltReason = "failure";
      failed.haltAtUserCount = Number.isInteger(message.userCount)
        ? message.userCount
        : Number.isInteger(task.baselineUserCount) ? task.baselineUserCount +
          (wasWaiting ? 1 + (task.steerCount || 0) : 0) : null;
      failed.error = task.error;
      changed = true;
      break;
    }

    case "IMPORT_LEGACY": {
      if (!store.legacyUnbound) break;
      if (existing || state.tasks.length || state.schedules.length) {
        throw new Error("当前对话已有队列；请在空对话中导入旧任务");
      }
      const legacy = store.legacyUnbound;
      Object.assign(state, legacy, { key, url, tabId, halted: true });
      state.haltReason = "legacy";
      state.error = "旧版任务已导入。请在当前对话手动发一条消息后开始接力。";
      // Explicit user action is required because the old queue had no owner.
      state.haltAtUserCount = Number.isInteger(message.userCount) ? message.userCount - 1 : -1;
      store.legacyUnbound = null;
      changed = true;
      break;
    }

    default:
      if (message.type !== "GET") throw new Error("未知操作");
  }

  if (changed) {
    store.conversations[key] = state;
    await saveStore(store);
  }
  return {
    ok: true, state, sessionKey: key, dispatch, tabId,
    legacyUnboundCount: store.legacyUnbound?.tasks.length || store.legacyUnbound?.schedules.length || 0,
  };
}

async function ensureTargetTab(state) {
  if (state.halted || !state.autoOpenTab || !state.url ||
      (!state.activeTaskId && !state.tasks.some((t) => t.status === "pending")) ||
      !chatKey(state.url)) return;
  try {
    const tab = await chrome.tabs.get(state.tabId);
    if (chatKey(tab.url) === state.key) return false;
  } catch { /* Tab was closed. */ }

  const matches = await chrome.tabs.query({ url: ["https://chatgpt.com/*", "https://chat.openai.com/*"] });
  const existing = matches.find((tab) => chatKey(tab.url) === state.key);
  if (existing) {
    state.tabId = existing.id;
  } else {
    const tab = await chrome.tabs.create({ url: state.url, active: false });
    state.tabId = tab.id;
  }
  return true;
}

async function onScheduleTick() {
  return exclusive(async () => {
    const store = await readStore();
    let changed = false;
    for (const state of Object.values(store.conversations)) {
      const recovered = recoverObsoleteHalt(state);
      // Per-chat timers keep running while the user views a different chat.
      const scheduled = dueSchedules(state);
      const timedOut = checkTimeout(state);
      const steerTimedOut = checkSteerTimeout(state);
      const reopened = await ensureTargetTab(state);
      if (recovered || scheduled || timedOut || steerTimedOut || reopened) changed = true;
    }
    if (changed) await saveStore(store);
  });
}

async function startup() {
  const existing = await chrome.alarms.get(ALARM_NAME);
  if (!existing) await chrome.alarms.create(ALARM_NAME, { periodInMinutes: 1 });
  await onScheduleTick();
}

chrome.runtime.onInstalled.addListener(() => { void startup(); });
chrome.runtime.onStartup.addListener(() => { void startup(); });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) void onScheduleTick();
});
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  exclusive(() => handle(message, sender))
    .then(sendResponse)
    .catch((error) => sendResponse({ ok: false, error: error.message || "未知错误" }));
  return true;
});
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id || !safeUrl(tab.url)) return;
  try { await chrome.tabs.sendMessage(tab.id, { type: "TOGGLE_PANEL" }); }
  catch { /* The ChatGPT tab might still be loading. */ }
});

// Recover missing alarms after service-worker termination/browser upgrades.
void startup();
