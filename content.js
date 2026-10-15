/* global chrome */
"use strict";

(() => {
  if (document.getElementById("cq-extension-root")) return;

  const POLL_MS = 1300;
  // Voice Mode button (the waveform button, NOT the microphone dictation
  // button) is the shared ready signal for manual and timed queue dispatch.
  const VOICE_READY_STABLE_MS = 1700;
  const TAB_DOT_STABLE_MS = 6500;
  const TAB_UNREAD_DOT = "🔴 ";
  const STEER_CONFIRM_MS = 18000;
  const STATUS = {
    pending: "待发送",
    dispatching: "正在发送",
    waiting: "等待回复",
    steering: "准备引导",
    steering_wait: "引导确认中",
    done: "已完成",
    error: "需要检查",
    interrupted: "用户已中断",
  };

  const root = document.createElement("div");
  root.id = "cq-extension-root";

  let state = null;
  let sessionKey = null;
  let legacyUnboundCount = 0;
  let queueExpanded = true;
  let schedulerOpen = false;
  let scheduleDraft = "";
  let minutesDraft = "30";
  let repeatsDraft = "-1";
  let editingTask = null;
  let editedTaskText = "";
  let editingSchedule = null;
  let notification = "";
  let workInProgress = false;
  let composerActionInProgress = false;
  let heartbeatInProgress = false;
  let voiceReadySignature = "";
  let voiceReadySince = 0;
  let lastLocation = location.href;
  let lastClaimAttempt = 0;
  let lastSchedulePulseAt = 0;
  let schedulePulseInProgress = false;
  let steeringProbe = null;
  let lastReplySnapshot = null;
  let replyCompletionWatch = null;
  let tabUnread = false;

  const clock = () => Date.now();
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
  const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char]);

  function validUrl(url) {
    try {
      const parsed = new URL(url);
      if (!["chatgpt.com", "chat.openai.com"].includes(parsed.hostname) || parsed.protocol !== "https:") return null;
      return parsed.origin + (parsed.pathname.replace(/\/+$/, "") || "/");
    } catch { return null; }
  }

  function pageChatKey(url) {
    const normal = validUrl(url);
    if (!normal) return null;
    const match = new URL(normal).pathname.match(/(?:^|\/)c\/([a-zA-Z0-9-]+)$/);
    return match ? `chat:${match[1]}` : null;
  }

  function boundHere() {
    if (!state || !sessionKey || !validUrl(location.href)) return false;
    const current = pageChatKey(location.href);
    return current ? sessionKey === current : sessionKey.startsWith("draft:");
  }

  function temporaryNewChat() {
    return Boolean(sessionKey?.startsWith("draft:") && !pageChatKey(location.href));
  }

  function hasQueuedWork() {
    // Error/interrupted rows are historical/problem states: they should not
    // trap Enter in queue mode when there is nothing left to dispatch.
    return Boolean(state?.tasks.some((task) =>
      ["pending", "dispatching", "waiting", "steering", "steering_wait"].includes(task.status)
    ));
  }

  function shouldEnqueueEnter() {
    // In a native ChatGPT run, there may be no plugin task yet. Pressing Enter
    // during generation must still enqueue instead of stealing the active run.
    if (hasQueuedWork()) return true;
    const snapshot = conversationSnapshot();
    return snapshot.busy || pendingToolActivity(snapshot) ||
      (!state?.halted && snapshot.lastRole === "user");
  }

  function getEditor() {
    const specific = document.querySelector(
      '#prompt-textarea, [data-testid="prompt-textarea"], [data-testid="composer-input"]'
    );
    if (specific && !root.contains(specific)) {
      if (specific.matches('textarea, input, [contenteditable="true"]')) return specific;
      const inner = specific.querySelector('[contenteditable="true"], textarea');
      if (inner) return inner;
    }
    return [...document.querySelectorAll('main [contenteditable="true"], main textarea, form [contenteditable="true"], form textarea')]
      .find((element) => !root.contains(element) && element.getClientRects().length > 0) || null;
  }

  function mountNearComposer() {
    const editor = getEditor();
    if (!editor) return false;
    let anchor = editor.closest("form") || editor.closest('[data-testid="composer"]') || editor.parentElement;
    if (!anchor?.parentElement) return false;

    // A horizontally laid-out parent cannot host another full-width column.
    const parentStyle = getComputedStyle(anchor.parentElement);
    if (parentStyle.display === "flex" && parentStyle.flexDirection.startsWith("row")) {
      anchor = anchor.parentElement;
    }
    if (!anchor.parentElement || anchor === root || root.contains(anchor)) return false;
    if (root.parentElement !== anchor.parentElement || root.nextElementSibling !== anchor) {
      anchor.insertAdjacentElement("beforebegin", root);
    }
    return true;
  }

  function editorText(editor) {
    if (!editor) return "";
    return editor.matches("textarea, input") ? editor.value : editor.innerText;
  }

  function isVisible(element) {
    return Boolean(element && element.getClientRects().length > 0 && !element.disabled);
  }

  function controls() {
    // Prefer only buttons in this composer. A generated answer may include
    // other clickable "Send" buttons which must never be used by the queue.
    const form = getEditor()?.closest("form");
    const buttons = [...(form?.querySelectorAll("button") || document.querySelectorAll("main button, form button"))]
      .filter((button) => !root.contains(button));
    const isStop = (button) => {
      const testId = button.getAttribute("data-testid") || "";
      const name = button.getAttribute("aria-label") || button.getAttribute("title") || "";
      return /(?:^|-)stop-button$|composer-stop-button/.test(testId) ||
        /stop (generating|response)|停止(生成|回复|回答)/i.test(name);
    };
    // The stop control sometimes moves outside the composer during tool calls.
    const stop = buttons.find((button) => isStop(button) && isVisible(button)) ||
      [...document.querySelectorAll("main button, button[data-testid='stop-button']")]
        .find((button) => !root.contains(button) && isStop(button) && isVisible(button));
    const send = buttons.find((button) => {
      const testId = button.getAttribute("data-testid") || "";
      const name = button.getAttribute("aria-label") || button.getAttribute("title") || "";
      return (/^(send-button|composer-submit-button|composer-send-button)$/.test(testId) ||
        /^(send|send message|send prompt|发送|发送消息|发送提示词)$/.test(name.toLowerCase())) && !isStop(button);
    });
    // ChatGPT distinguishes the waveform "Start Voice" from the adjacent
    // microphone "Start dictation". Never use the dictation mic as ready.
    const isVoice = (button) => {
      const testId = (button.getAttribute("data-testid") || "").toLowerCase();
      const name = (button.getAttribute("aria-label") || button.getAttribute("title") || "").trim();
      if (/dictat|transcrib|microphone|听写|录音|麦克风|语音输入/i.test(`${testId} ${name}`)) return false;
      return /^(?:composer-)?(?:start-)?voice(?:-mode|-chat)?-button$|^voice-mode-button$/i.test(testId) ||
        /^(?:(?:start|use|open|begin|enter)\s+(?:a\s+)?)?voice(?:\s+(?:mode|chat|conversation))?$/i.test(name) ||
        /^(?:(?:开始|开启|进入|使用)\s*)?语音(?:模式|聊天|对话|通话)?$/i.test(name);
    };
    const voice = buttons.find((button) => isVoice(button) && isVisible(button)) ||
      [...(form?.parentElement?.querySelectorAll("button") || [])]
        .find((button) => !root.contains(button) && isVoice(button) && isVisible(button));
    return { stop, send, voice };
  }

  function turns() {
    return [...document.querySelectorAll('[data-message-author-role="assistant"], [data-message-author-role="user"]')]
      .filter((element) => !root.contains(element));
  }

  function messageText(element) {
    if (!element) return "";
    // Use the complete assistant turn, including tool placeholders/status.
    // A single .markdown node can be only the first segment of a tool reply.
    const role = element.getAttribute("data-message-author-role");
    if (role === "assistant") return element.innerText || element.textContent || "";
    // For user bubbles prefer the authored text instead of action buttons.
    const parts = [...element.querySelectorAll('[data-message-content-part]')]
      .filter((part) => !part.parentElement?.closest('[data-message-content-part]'));
    if (parts.length) return parts.map((part) => part.innerText || part.textContent || "").join("\n");
    const selector = '[data-testid="user-message"], [data-message-content], .whitespace-pre-wrap';
    const body = element.querySelector(selector);
    return (body || element).innerText || (body || element).textContent || "";
  }

  function messageId(element) {
    const message = element?.closest("[data-message-id]") || element?.querySelector("[data-message-id]");
    return message?.getAttribute("data-message-id") || null;
  }

  function assistantOutputText(element) {
    if (!element) return "";
    // Thinking timers, tool progress and "思考了 29s" are constantly updated
    // even though the final answer is not changing. Read only actual content.
    const selectors = [
      ".markdown", "[data-testid='message-content']", "[data-message-content]",
      "[data-message-content-part]",
    ];
    for (const selector of selectors) {
      const all = [...element.querySelectorAll(selector)];
      const topLevel = all.filter((node) => !all.some((other) => other !== node && other.contains(node)));
      if (topLevel.length) {
        const text = topLevel.map((node) => node.innerText || node.textContent || "").join("\n").trim();
        if (text) return text;
      }
    }
    return "";
  }

  function pendingToolActivity(snapshot) {
    if (snapshot.busy) return true;
    const output = normalize(snapshot.lastAssistantText);
    const surface = normalize(snapshot.lastAssistantSurface);
    // A tool placeholder can be followed by a *final* markdown reply in the
    // same assistant turn; only treat it as pending if it remains the ending.
    const pending = /(?:waiting for (?:a )?tool result|calling (?:a )?tool|等待工具结果|正在调用工具|思考中|thinking)[.!。…]*$/i;
    return pending.test(output) || pending.test(surface);
  }

  function conversationSnapshot() {
    const list = turns();
    let assistantCount = 0;
    let userCount = 0;
    let lastAssistant = null;
    let lastUser = null;
    for (const element of list) {
      const role = element.getAttribute("data-message-author-role");
      if (role === "assistant") { assistantCount++; lastAssistant = element; }
      if (role === "user") { userCount++; lastUser = element; }
    }
    const text = assistantOutputText(lastAssistant);
    const surface = messageText(lastAssistant);
    return {
      assistantCount,
      userCount,
      lastRole: list.at(-1)?.getAttribute("data-message-author-role") || null,
      lastAssistantText: text,
      lastAssistantSurface: surface,
      lastAssistantSignature: `${text.length}|${text.slice(-2500)}`,
      lastAssistantId: messageId(lastAssistant),
      lastAssistantElement: lastAssistant,
      lastUserText: messageText(lastUser),
      lastUserId: messageId(lastUser),
      lastUserElement: lastUser,
      busy: Boolean(controls().stop),
    };
  }

  function syncTabRedDot() {
    // Edge's vertical tab strip displays the page title. Prefixing one red
    // dot marks *that tab*, without opening Edge's side panel or a popup.
    const current = document.title || "ChatGPT";
    if (tabUnread && !current.startsWith(TAB_UNREAD_DOT)) {
      document.title = TAB_UNREAD_DOT + current;
    } else if (!tabUnread && current.startsWith(TAB_UNREAD_DOT)) {
      document.title = current.slice(TAB_UNREAD_DOT.length);
    }
  }

  function clearTabRedDot() {
    tabUnread = false;
    syncTabRedDot();
  }

  function unreadRedDot() {
    // A user already looking at the answer does not need an unread marker.
    if (document.visibilityState !== "hidden" && document.hasFocus()) return;
    tabUnread = true;
    syncTabRedDot();
  }

  function observeReplyCompleted(snapshot, voiceReady) {
    if (!lastReplySnapshot) {
      // Do not mark an old, already-complete reply when the page first loads.
      lastReplySnapshot = snapshot;
      return;
    }
    const prior = lastReplySnapshot;
    const newUserTurn = snapshot.userCount > prior.userCount ||
      Boolean(snapshot.lastUserId && prior.lastUserId && snapshot.lastUserId !== prior.lastUserId) ||
      Boolean(snapshot.lastUserElement && prior.lastUserElement &&
        snapshot.lastUserElement !== prior.lastUserElement &&
        (snapshot.lastUserText !== prior.lastUserText || snapshot.lastRole === "user"));

    if (newUserTurn) {
      replyCompletionWatch = {
        assistantCount: prior.assistantCount,
        assistantId: prior.lastAssistantId,
        assistantSignature: prior.lastAssistantSignature,
        assistantElement: prior.lastAssistantElement,
      };
    }

    const watch = replyCompletionWatch;
    if (watch) {
      // Reuse the queue's native Voice Mode readiness signal: when the
      // waveform button returns, the answer has finished. No second 6.5s
      // text-stability timeout is needed for the tab notification.
      const newAssistant = snapshot.lastRole === "assistant" &&
        (
          snapshot.assistantCount > watch.assistantCount ||
          Boolean(snapshot.lastAssistantId && watch.assistantId &&
            snapshot.lastAssistantId !== watch.assistantId) ||
          Boolean(snapshot.lastAssistantElement && watch.assistantElement &&
            snapshot.lastAssistantElement !== watch.assistantElement) ||
          snapshot.lastAssistantSignature !== watch.assistantSignature
        );
      // Voice Mode alone is not enough: an already-idle old chat must never
      // raise a false unread dot without a new user/assistant exchange.
      if (newAssistant && voiceReady) {
        unreadRedDot();
        replyCompletionWatch = null; // One dot per completed reply.
      }
    }
    lastReplySnapshot = snapshot;
    syncTabRedDot();
  }

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") clearTabRedDot();
  });
  window.addEventListener("focus", clearTabRedDot);
  // ChatGPT can rename the tab at any moment (including after a response).
  // Keep the single red dot visible until this tab is viewed again.
  const tabTitleObserver = new MutationObserver(() => {
    if (tabUnread) syncTabRedDot();
  });
  if (document.head) {
    tabTitleObserver.observe(document.head, { childList: true, characterData: true, subtree: true });
  }

  function resetVoiceReadiness() {
    voiceReadySignature = "";
    voiceReadySince = 0;
  }

  function updateVoiceReadiness() {
    const editor = getEditor();
    const { voice, stop } = controls();
    // The native waveform button is the SINGLE completion signal. Do not use
    // assistant text, message counts, or delivery confirmation as a second gate.
    // The editor must be empty and the native Stop button absent so unsent
    // drafts and active generation cannot be mistaken for a ready composer.
    if (!editor || normalize(editorText(editor)) || !isVisible(voice) || stop) {
      resetVoiceReadiness();
      return false;
    }
    // Do not reset just because ChatGPT updates thinking counters or virtualizes
    // messages. Only the visible Voice button's disappearance resets this.
    const signature = validUrl(location.href);
    if (voiceReadySignature !== signature) {
      voiceReadySignature = signature;
      voiceReadySince = clock();
    }
    return clock() - voiceReadySince >= VOICE_READY_STABLE_MS;
  }

  function updateIdle(_snapshot, voiceReady) {
    return Boolean(voiceReady && !composerActionInProgress && !workInProgress);
  }

  function readyToComplete(task, voiceReady) {
    return Boolean(task?.status === "waiting" && Number.isFinite(task.sentAt) &&
      voiceReady && clock() - task.sentAt >= VOICE_READY_STABLE_MS);
  }

  async function rpc(type, properties = {}) {
    const reply = await chrome.runtime.sendMessage({ type, url: location.href, ...properties });
    if (!reply?.ok) throw new Error(reply?.error || "插件后台未响应，请刷新 ChatGPT 页面");
    if (reply.sessionKey && sessionKey !== reply.sessionKey) {
      sessionKey = reply.sessionKey;
      steeringProbe = null;
      editingTask = null;
      editedTaskText = "";
      editingSchedule = null;
      scheduleDraft = "";
      minutesDraft = "30";
      repeatsDraft = "-1";
      notification = "";
      schedulerOpen = false;
    }
    if (reply.state) state = reply.state;
    legacyUnboundCount = reply.legacyUnboundCount || 0;
    return reply;
  }

  function showError(error) {
    const message = error?.message || String(error);
    notification = message === state?.error ? "" : message;
    queueExpanded = true;
    render();
  }

  function excerpt(text, max = 160) {
    return escapeHtml(text.length > max ? text.slice(0, max) + "…" : text);
  }

  function localDate(value) {
    if (!value) return "未执行";
    return new Date(value).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  }

  function countdownText(nextRunAt, now = clock()) {
    const seconds = Math.max(0, Math.ceil((Number(nextRunAt) - now) / 1000));
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const remaining = seconds % 60;
    const pad = (number) => String(number).padStart(2, "0");
    if (days) return `${days}天 ${pad(hours)}:${pad(minutes)}:${pad(remaining)}`;
    if (hours) return `${pad(hours)}:${pad(minutes)}:${pad(remaining)}`;
    return `${pad(minutes)}:${pad(remaining)}`;
  }

  function countdownMarkup(nextRunAt, prefix = "") {
    return `<time class="cq-countdown" data-next-run-at="${Number(nextRunAt)}">${escapeHtml(prefix)}${countdownText(nextRunAt)}</time>`;
  }

  function updateCountdowns() {
    if (!state || !root.isConnected) return;
    updateDraftWaiting();
    const enterLabel = root.querySelector(".cq-enter-action");
    if (enterLabel) {
      const action = shouldEnqueueEnter() ? "入队" : "发送";
      if (enterLabel.textContent !== action) enterLabel.textContent = action;
    }
    if (!boundHere()) return;
    const now = clock();
    for (const element of root.querySelectorAll(".cq-countdown[data-next-run-at]")) {
      const nextRunAt = Number(element.dataset.nextRunAt);
      element.textContent = `${element.dataset.prefix || ""}${countdownText(nextRunAt, now)}`;
      element.title = `还剩 ${Math.max(0, Math.ceil((nextRunAt - now) / 1000))} 秒`;
    }
    const due = state.schedules.some((schedule) => schedule.enabled && now >= schedule.nextRunAt);
    if (due && !schedulePulseInProgress && now - lastSchedulePulseAt >= 3000) {
      lastSchedulePulseAt = now;
      schedulePulseInProgress = true;
      void rpc("SCHEDULE_PULSE")
        .then(render)
        .catch(showError)
        .finally(() => { schedulePulseInProgress = false; });
    }
  }

  function updateDraftWaiting() {
    const label = root.querySelector(".cq-compose-wait");
    const voiceLabel = root.querySelector(".cq-voice-wait");
    if (!label && !voiceLabel) return;
    const editor = getEditor();
    const pending = state?.tasks.some((task) => task.status === "pending");
    const hasDraft = Boolean(editor && normalize(editorText(editor)));
    if (label) label.hidden = !(pending && !state.activeTaskId && hasDraft);
    if (voiceLabel) voiceLabel.hidden = !(pending && !state.activeTaskId && !state.halted &&
      !hasDraft && !isVisible(controls().voice));
  }

  function icon(name) {
    const path = {
      list: '<path d="M8 6h13M8 12h13M8 18h13"/><path d="m3 6 1 1 2-2M3 12h3M3 18h3"/>',
      clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
      close: '<path d="M6 6l12 12M18 6 6 18"/>',
      play: '<path d="m8 5 11 7-11 7z"/>',
      pause: '<path d="M9 5v14M15 5v14"/>',
      plus: '<path d="M12 5v14M5 12h14"/>',
      arrowUp: '<path d="m6 14 6-6 6 6"/>',
      arrowDown: '<path d="m6 10 6 6 6-6"/>',
      steer: '<path d="m7 17 10-10M8 7h9v9"/>',
      edit: '<path d="m4 17-.5 3.5L7 20l11-11-3-3L4 17zM13 8l3 3"/>',
      trash: '<path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13"/>',
      check: '<path d="m5 12 4 4L19 6"/>',
    }[name] || "";
    return `<svg aria-hidden="true" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`;
  }

  function renderTasks() {
    const visible = state.tasks;
    if (!visible.length) return '<p class="cq-empty">队列为空：Enter 直接发送，也可以点「＋ 入队」添加第一条任务</p>';
    return visible.map((task) => `
      <div class="cq-task cq-${task.status}">
        <span class="cq-task-mark" title="${STATUS[task.status]}">
          ${task.status === "waiting" ? icon("clock") : icon("list")}
        </span>
        <div class="cq-task-body">
          ${editingTask === task.id ? `
            <textarea id="cq-edit-task-input" rows="2" aria-label="编辑队列消息">${escapeHtml(editedTaskText)}</textarea>
            <div class="cq-inline-edit">
              <button type="button" data-action="cancel-edit-task">取消</button>
              <button type="button" data-action="save-task" class="cq-save">保存</button>
            </div>
          ` : `
            <div class="cq-task-text" title="${escapeHtml(task.text)}">${excerpt(task.text, 220)}</div>
            <span class="cq-task-meta">${task.status === "waiting" ? "等待语音按钮恢复" : STATUS[task.status]}${task.sourceScheduleId ? " · 定时入队" : ""}</span>
          `}
        </div>
        ${editingTask === task.id ? "" : `<div class="cq-item-actions">
          ${task.status === "pending" ? `
            <button type="button" class="cq-steer-action" data-action="steer-task" data-id="${task.id}" title="立即发送这条消息，不等待前面的队列">${icon("steer")}<span>引导</span></button>
            <button type="button" data-action="move-task" data-id="${task.id}" data-direction="up" title="上移">${icon("arrowUp")}</button>
            <button type="button" data-action="move-task" data-id="${task.id}" data-direction="down" title="下移">${icon("arrowDown")}</button>
            <button type="button" data-action="edit-task" data-id="${task.id}" title="编辑">${icon("edit")}</button>` : ""}
          ${!["waiting", "dispatching", "steering", "steering_wait"].includes(task.status) ? `<button type="button" data-action="delete-task" data-id="${task.id}" title="删除">${icon("trash")}</button>` : ""}
        </div>`}
      </div>
    `).join("");
  }

  function renderSchedules() {
    if (!state.schedules.length) return '<p class="cq-empty">还没有定时任务</p>';
    const queueFull = state.tasks.filter((task) =>
      ["pending", "dispatching", "waiting", "steering", "steering_wait"].includes(task.status)
    ).length >= 100;
    return state.schedules.map((item) => `
      <div class="cq-task cq-schedule-item">
        <span class="cq-task-mark">${icon("clock")}</span>
        <div class="cq-task-body">
          <span class="cq-task-text">${excerpt(item.text)}</span>
          <span class="cq-task-meta">${scheduleRepeatDescription(item)}</span>
          <span class="cq-task-meta">${item.enabled
            ? (clock() >= item.nextRunAt
                ? queueFull ? "队列已满 · 等待空位入队" : "已到期 · 即将入队"
                : `每 ${item.intervalMinutes} 分钟 · 下次入队 ${countdownMarkup(item.nextRunAt)}`)
            : "定时器已停止"}</span>
        </div>
        <div class="cq-item-actions">
          <button type="button" data-action="toggle-schedule" data-id="${item.id}" title="${item.enabled ? '停用定时' : '启用定时'}">${icon(item.enabled ? "pause" : "play")}</button>
          <button type="button" data-action="edit-schedule" data-id="${item.id}" title="编辑">${icon("edit")}</button>
          <button type="button" data-action="delete-schedule" data-id="${item.id}" title="删除">${icon("trash")}</button>
        </div>
      </div>
    `).join("");
  }

  function scheduleRepeatDescription(item) {
    const repeats = item.repeatCount ?? -1;
    const runs = item.runCount || 0;
    if (repeats === -1) return `无限循环 · 已入队 ${runs} 次`;
    const total = repeats + 1;
    return `${repeats === 0 ? "单次入队" : `额外循环 ${repeats} 次`} · 已入队 ${runs}/${total} 次${runs >= total ? " · 已达次数上限" : ""}`;
  }

  function render() {
    if (!state) return;
    if (!mountNearComposer()) return;
    const pending = state.tasks.filter((item) =>
      ["pending", "dispatching", "waiting", "steering", "steering_wait"].includes(item.status)).length;
    const active = state.tasks.find((item) => item.id === state.activeTaskId);
    const hasWork = shouldEnqueueEnter();
    const needsReview = state.halted && state.haltReason !== "user";
    const recoverable = needsReview && state.tasks.find((task) => task.status === "error");
    const nearestSchedule = state.schedules.filter((schedule) => schedule.enabled)
      .sort((a, b) => a.nextRunAt - b.nextRunAt)[0];
    const activeElement = root.contains(document.activeElement) ? document.activeElement : null;
    const activeId = activeElement?.id;
    const caret = activeElement && typeof activeElement.selectionStart === "number" ? activeElement.selectionStart : null;

    root.innerHTML = `
      <section class="cq-inline" aria-label="ChatGPT 对话任务队列">
        <div class="cq-toolbar">
          <button type="button" class="cq-queue-toggle" data-action="toggle-queue" title="展开/收起队列">
            ${icon("list")} <strong>Queue</strong> <span>${pending}</span>
          </button>
          ${active ? `<span class="cq-status cq-status-active">${icon("clock")} ${STATUS[active.status]}</span>` :
            state.halted ? `<span class="cq-status">${state.haltReason === "user" ? "用户已暂停" : "等待核对"}</span>` : ''}
          <span class="cq-status cq-compose-wait" hidden>等待清空输入框</span>
          <span class="cq-status cq-voice-wait" hidden>等待语音按钮</span>
          <div class="cq-toolbar-spacer"></div>
          ${nearestSchedule ? `<span class="cq-next-run" title="下次生成一条队列待办（不代表立即发送）">${icon("clock")}
            ${clock() >= nearestSchedule.nextRunAt
              ? pending >= 100 ? "已到期 · 队列已满" : "已到期 · 待入队"
              : countdownMarkup(nearestSchedule.nextRunAt)}</span>` : ""}
          <button type="button" class="cq-tool cq-add-queue" data-action="queue-composer" title="将原生输入框的文字加入当前对话队列">${icon("plus")}<span>入队</span></button>
          <button type="button" class="cq-tool ${schedulerOpen ? 'cq-tool-active' : ''}" data-action="toggle-scheduler" title="定时对话发生器">${icon("clock")}<span>定时</span>${state.schedules.length ? `<small>${state.schedules.length}</small>` : ""}</button>
          <button type="button" class="cq-tool cq-icon-only" data-action="toggle-queue" title="${queueExpanded ? '收起' : '展开'}">${icon(queueExpanded ? "arrowUp" : "arrowDown")}</button>
        </div>
        ${queueExpanded ? `
          ${needsReview || notification ? `<div class="cq-notice" role="status">
            <span>${needsReview ? "上次发送状态未确认，已保护性暂停。" : escapeHtml(notification)}</span>
            ${recoverable ? `<button type="button" data-action="skip-failed" data-id="${recoverable.id}" title="人工核对后跳过，不会重发">核对后跳过</button>` :
              needsReview && !state.activeTaskId ? `<button type="button" data-action="ack-recovery" title="确认上一条已经处理或无需重发后恢复">核对后继续</button>` : ""}
          </div>` : ''}
          ${state.tasks.length || pending || active ? `<div class="cq-list">${renderTasks()}</div>` : ''}
          ${legacyUnboundCount ? `<div class="cq-footer-actions">
            <span>发现 ${legacyUnboundCount} 项旧版未绑定内容</span>
            <button type="button" data-action="import-legacy">导入到本对话</button>
          </div>` : ''}
          ${schedulerOpen ? `
            <div class="cq-scheduler">
              <div class="cq-section-title">${editingSchedule ? '编辑定时任务' : '创建定时任务'} <span>到点只添加待办，由队列负责发送</span></div>
              <textarea id="cq-schedule-draft" rows="2" placeholder="定时发送的提示词…">${escapeHtml(scheduleDraft)}</textarea>
              <div class="cq-schedule-controls">
                <label for="cq-minutes">间隔 <input id="cq-minutes" type="number" min="1" max="525600" step="1" value="${escapeHtml(minutesDraft)}"> 分钟</label>
                <label for="cq-repeats">循环次数 <input id="cq-repeats" type="number" min="-1" max="1000000" step="1" value="${escapeHtml(repeatsDraft)}"></label>
                <div>${editingSchedule ? '<button type="button" data-action="cancel-edit-schedule">取消</button>' : ''}
                  <button type="button" class="cq-save" data-action="save-schedule">${editingSchedule ? "保存" : "添加定时"}</button>
                </div>
              </div>
              <p class="cq-repeat-hint">-1 无限入队 · 0 入队一次 · N 首次入队后再重复 N 次</p>
              ${renderSchedules()}
              <label class="cq-switch"><input type="checkbox" id="cq-auto-open" ${state.autoOpenTab ? "checked" : ""}> 关闭对话标签页后自动重开（浏览器需保持运行）</label>
            </div>
          ` : ''}
          <div class="cq-shortcuts"><span><kbd>Enter</kbd> <span class="cq-enter-action">${hasWork ? "入队" : "发送"}</span></span><span><kbd>Ctrl</kbd> + <kbd>Enter</kbd> 即时发送</span><span><kbd>Shift</kbd> + <kbd>Enter</kbd> 换行</span></div>
        ` : ''}
      </section>
    `;

    if (activeId) {
      const target = root.querySelector(`#${activeId}`);
      if (target) {
        target.focus();
        if (caret != null && target.setSelectionRange) target.setSelectionRange(caret, caret);
      }
    }
    updateCountdowns();
  }

  async function onAction(button) {
    const action = button.dataset.action;
    const id = button.dataset.id;
    notification = "";
    if (action === "toggle-queue") { queueExpanded = !queueExpanded; render(); return; }
    if (action === "toggle-scheduler") { schedulerOpen = !schedulerOpen; queueExpanded = true; render(); return; }
    if (action === "steer-task") {
      await steerQueuedTask(id);
      return;
    }
    if (action === "queue-composer") {
      const editor = getEditor();
      const text = editorText(editor);
      if (!text?.trim()) {
        editor?.focus();
        notification = "先在 ChatGPT 输入框输入需要排队的内容。";
        queueExpanded = true;
        render();
        return;
      }
      if (workInProgress || composerActionInProgress) {
        throw new Error("正在处理上一条消息，请等发送确认后再操作");
      }
      composerActionInProgress = true;
      try {
        if (!boundHere()) await rpc("HELLO", { lastUserText: conversationSnapshot().lastUserText });
        await queueNativePrompt(editor, text);
      } finally {
        composerActionInProgress = false;
      }
      return;
    }

    if (action === "edit-task") {
      const task = state.tasks.find((item) => item.id === id);
      if (!task || task.status !== "pending") return;
      editedTaskText = task.text; editingTask = id; render();
      root.querySelector("#cq-edit-task-input")?.focus(); return;
    }
    if (action === "cancel-edit-task") { editingTask = null; editedTaskText = ""; render(); return; }

    if (action === "edit-schedule") {
      const item = state.schedules.find((entry) => entry.id === id);
      if (!item) return;
      scheduleDraft = item.text; minutesDraft = String(item.intervalMinutes);
      repeatsDraft = String(item.repeatCount ?? -1);
      editingSchedule = id; render();
      root.querySelector("#cq-schedule-draft")?.focus(); return;
    }
    if (action === "cancel-edit-schedule") {
      editingSchedule = null; scheduleDraft = ""; minutesDraft = "30"; repeatsDraft = "-1"; render(); return;
    }

    let request = null;
    switch (action) {
      case "import-legacy":
        request = ["IMPORT_LEGACY", { userCount: conversationSnapshot().userCount }];
        break;
      case "save-task":
        request = ["EDIT_TASK", { id: editingTask, text: editedTaskText }];
        break;
      case "move-task": request = ["MOVE_TASK", { id, direction: button.dataset.direction }]; break;
      case "delete-task": request = ["DELETE_TASK", { id }]; break;
      case "skip-failed":
        if (!confirm("请先确认该消息已经发送，或不需要重发。\n\n跳过后插件不会重发此任务，并将继续处理后续队列。")) return;
        request = ["SKIP_FAILED", { id }];
        break;
      case "ack-recovery":
        if (!confirm("确认上次发送已经完成或不需要重发？\n\n继续后队列会发送后面的任务，之前不确定的消息不会自动重试。")) return;
        request = ["ACK_RECOVERY"];
        break;
      case "save-schedule":
        request = [editingSchedule ? "EDIT_SCHEDULE" : "ADD_SCHEDULE", {
          ...(editingSchedule ? { id: editingSchedule } : {}),
          text: scheduleDraft,
          intervalMinutes: minutesDraft,
          repeatCount: repeatsDraft,
        }];
        break;
      case "toggle-schedule": request = ["TOGGLE_SCHEDULE", { id }]; break;
      case "delete-schedule": request = ["DELETE_SCHEDULE", { id }]; break;
      default: return;
    }
    const [type, props] = request;
    await rpc(type, props);
    if (action === "save-task") { editingTask = null; editedTaskText = ""; }
    if (action === "save-schedule") {
      editingSchedule = null; scheduleDraft = ""; minutesDraft = "30"; repeatsDraft = "-1";
    }
    render();
  }

  root.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-action]");
    if (!button || !root.contains(button)) return;
    void onAction(button).catch(showError);
  });

  root.addEventListener("input", (event) => {
    if (event.target.id === "cq-edit-task-input") editedTaskText = event.target.value;
    if (event.target.id === "cq-schedule-draft") scheduleDraft = event.target.value;
    if (event.target.id === "cq-minutes") minutesDraft = event.target.value;
    if (event.target.id === "cq-repeats") repeatsDraft = event.target.value;
  });

  root.addEventListener("change", (event) => {
    if (event.target.id === "cq-auto-open") {
      void rpc("AUTO_OPEN", { enabled: event.target.checked }).then(render).catch(showError);
    }
  });

  root.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter" && event.target.id === "cq-schedule-draft") {
      event.preventDefault();
      const button = root.querySelector('[data-action="save-schedule"]');
      if (button) void onAction(button).catch(showError);
    }
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === "TOGGLE_PANEL") { queueExpanded = !queueExpanded; render(); }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes["cq.state.v2"] || !sessionKey || !boundHere()) return;
    const store = changes["cq.state.v2"].newValue;
    const updated = store?.conversations?.[sessionKey];
    if (!updated) return;
    state = updated;
    legacyUnboundCount = store.legacyUnbound?.tasks.length || store.legacyUnbound?.schedules.length || 0;
    render();
  });

  function insertText(editor, text) {
    editor.focus();
    if (editor.matches("textarea, input")) {
      const type = editor.matches("textarea") ? HTMLTextAreaElement : HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(type.prototype, "value")?.set;
      if (!setter) throw new Error("不支持当前输入组件");
      setter.call(editor, text);
      editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
    } else if (editor.isContentEditable) {
      const range = document.createRange();
      range.selectNodeContents(editor);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      if (!document.execCommand("insertText", false, text)) {
        throw new Error("浏览器未允许填写 ChatGPT 编辑器");
      }
    } else {
      throw new Error("当前 ChatGPT 输入框不可编辑");
    }
    if (normalize(editorText(editor)) !== normalize(text)) {
      throw new Error("编辑器未完整接收提示词，已停止自动发送");
    }
  }

  function clearComposerText(editor, submittedText) {
    // Never erase what the user typed while the asynchronous queue save ran.
    if (!editor?.isConnected || normalize(editorText(editor)) !== normalize(submittedText)) return false;
    editor.focus();
    if (editor.matches("textarea, input")) {
      const kind = editor.matches("textarea") ? HTMLTextAreaElement : HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(kind.prototype, "value")?.set;
      if (!setter) return false;
      setter.call(editor, "");
      editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward" }));
    } else if (editor.isContentEditable) {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(editor);
      selection.removeAllRanges();
      selection.addRange(range);
      // execCommand is deliberately used for ProseMirror's editing history.
      // Direct innerHTML assignment can desynchronize React/editor state.
      if (!document.execCommand("delete", false)) return false;
    } else {
      return false;
    }
    return !normalize(editorText(editor));
  }

  function hasComposerAttachments(editor) {
    const form = editor.closest("form");
    if (!form) return false;
    return [...form.querySelectorAll(
      '[data-testid="file-chip"], [data-testid="attachment-preview"], [data-testid="composer-attachment-preview"]'
    )].some(isVisible);
  }

  async function queueNativePrompt(editor, text) {
    if (!state) throw new Error("队列还没初始化，请刷新页面");
    if (hasComposerAttachments(editor)) {
      throw new Error("队列当前只支持纯文本；附件请使用 ChatGPT 原生发送功能");
    }

    // Save atomically before touching the editor. A failed persistence call
    // must never lose the original message.
    await rpc("ENQUEUE", { text });
    if (!clearComposerText(editor, text)) {
      notification = "任务已保存，但输入内容未能自动清空。请手动清空，避免重复入队。";
    } else {
      notification = "";
    }
    queueExpanded = true;
    render();
  }

  function steeredMessageObserved(snapshot, task) {
    if (!task || normalize(snapshot.lastUserText) !== normalize(task.text)) return false;
    if (snapshot.lastUserId && task.steerBaselineUserId &&
        snapshot.lastUserId !== task.steerBaselineUserId) return true;
    if (Number.isInteger(task.steerBaselineUserCount) &&
        snapshot.userCount > task.steerBaselineUserCount) return true;
    return Boolean(steeringProbe?.id === task.id && steeringProbe.lastUserElement &&
      snapshot.lastUserElement && steeringProbe.lastUserElement !== snapshot.lastUserElement);
  }

  async function confirmSteeredTask(task, snapshot) {
    if (!steeredMessageObserved(snapshot, task)) return false;
    await rpc("STEER_CONFIRM", {
      id: task.id, lastUserText: snapshot.lastUserText,
      userCount: snapshot.userCount, lastUserId: snapshot.lastUserId,
      newUserElement: Boolean(steeringProbe?.id === task.id && steeringProbe.lastUserElement &&
        snapshot.lastUserElement && steeringProbe.lastUserElement !== snapshot.lastUserElement),
    });
    steeringProbe = null;
    resetVoiceReadiness();
    lastClaimAttempt = clock();
    notification = "";
    return true;
  }

  async function steerQueuedTask(id) {
    if (!state || !boundHere() || state.halted) {
      throw new Error("当前对话不可引导，请返回原对话并确认没有暂停");
    }
    if (composerActionInProgress || workInProgress) {
      throw new Error("正在发送另一条消息，请稍后再引导");
    }
    const editor = getEditor();
    if (!editor || normalize(editorText(editor))) {
      throw new Error("输入框有未发送的内容，请先发送或清空，避免覆盖草稿");
    }
    if (hasComposerAttachments(editor)) {
      throw new Error("检测到附件，请先处理附件后再引导队列任务");
    }
    const before = conversationSnapshot();
    composerActionInProgress = true;
    let reserved = null;
    let armed = false;
    try {
      const claim = await rpc("STEER_CLAIM", {
        id, userCount: before.userCount, lastUserId: before.lastUserId,
      });
      reserved = claim.dispatch;
      if (!reserved) throw new Error("任务无法锁定，未尝试发送");
      if (!boundHere() || state.halted || !editor.isConnected || normalize(editorText(editor))) {
        throw new Error("对话或输入框已变化，未发送引导任务");
      }
      insertText(editor, reserved.text);

      let send = null;
      for (let attempt = 0; attempt < 12; attempt++) {
        send = controls().send;
        if (isVisible(send)) break;
        await sleep(250);
      }
      if (!isVisible(send) || !boundHere() || state.halted || !editor.isConnected ||
          normalize(editorText(editor)) !== normalize(reserved.text)) {
        throw new Error(before.busy
          ? "当前 ChatGPT 网页不支持中途即时发送，任务已保留在原队列"
          : "发送按钮不可用，任务已保留在原队列");
      }

      // Arm the durable no-retry state before invoking ChatGPT's native Send.
      await rpc("STEER_CLICKED", { id });
      armed = true;
      steeringProbe = { id, lastUserElement: before.lastUserElement };
      resetVoiceReadiness();
      send.click();
      const snapshot = conversationSnapshot();
      const task = state.tasks.find((item) => item.id === id);
      if (task) await confirmSteeredTask(task, snapshot);
      else notification = "已发送引导，等待网页确认消息";
      if (state.steeringTaskId) {
        notification = "已尝试即时发送，正在确认；不会重复发送这条消息";
      }
    } catch (error) {
      if (reserved && !armed) {
        // No Send click happened. Safely restore exactly the same task and
        // remove only our inserted text (not anything typed by the user).
        if (normalize(editorText(editor)) === normalize(reserved.text)) {
          clearComposerText(editor, reserved.text);
        }
        try { await rpc("STEER_CANCEL", { id }); }
        catch { /* The periodic recovery also releases unclicked reservations. */ }
      } else if (reserved && armed) {
        try { await rpc("STEER_UNCONFIRMED", { id }); }
        catch { /* Persisted 'steering_wait' remains protected from replay. */ }
      }
      throw error;
    } finally {
      composerActionInProgress = false;
      render();
    }
  }

  async function steerNativePrompt(editor, text) {
    // No unsupported stop/restart emulation: only the native Send button is
    // allowed to deliver an immediate follow-up while ChatGPT is generating.
    if (!state) throw new Error("插件还没初始化，请刷新页面");
    if (hasComposerAttachments(editor)) {
      throw new Error("暂不支持通过快捷键自动处理带附件的消息");
    }
    const before = conversationSnapshot();
    const send = controls().send;
    if (!isVisible(send)) {
      throw new Error(before.busy
        ? "ChatGPT 网页当前不提供可用的中途发送按钮，无法真正引导；输入内容已保留。"
        : "ChatGPT 原生发送按钮不可用，输入内容已保留。");
    }

    send.click();
    const since = clock();
    while (clock() - since < STEER_CONFIRM_MS) {
      await sleep(350);
      const after = conversationSnapshot();
      if (after.userCount > before.userCount && normalize(after.lastUserText) === normalize(text)) {
        // If a queued task is currently running, record the native user turn
        // before its completion watchdog is permitted to advance the queue.
        await rpc("STEER_SENT", {
          text, userCount: after.userCount, lastUserText: after.lastUserText,
        });
        if (state.halted) {
          await rpc("USER_RESUMED", {
            userCount: after.userCount, lastUserText: after.lastUserText,
          });
        }
        notification = before.busy
          ? "消息已即时发送；是否加入当前运行中的回复，由 ChatGPT 网页决定。"
          : "消息已通过 ChatGPT 原生发送按钮发送。";
        render();
        return;
      }
    }
    // Do not retry: the message may already be in flight.
    if (state.activeTaskId && boundHere()) {
      await rpc("FAIL", { id: state.activeTaskId,
        error: "引导消息的发送结果未确认，已暂停队列；请检查网页对话。" });
    } else if (boundHere() && state.tasks.some((task) => task.status === "pending")) {
      await rpc("UNCERTAIN_SEND", { userCount: before.userCount });
    }
    throw new Error("即时消息是否发出无法确认；不会自动重发，请检查对话。");
  }

  function suggestionPopupOpen() {
    // Keep native Enter behavior for slash commands and @-mention pickers.
    return [...document.querySelectorAll('[role="listbox"], [cmdk-list]')]
      .some((element) => !root.contains(element) && element.getClientRects().length > 0);
  }

  function isNativeStopButton(button) {
    if (!button || root.contains(button)) return false;
    const testId = button.getAttribute("data-testid") || "";
    const label = button.getAttribute("aria-label") || button.getAttribute("title") || "";
    return /(?:^|-)stop-button$|composer-stop-button/i.test(testId) ||
      /stop (generating|response)|停止(生成|回复|回答)/i.test(label);
  }

  function isNativeContinueButton(button) {
    if (!button || root.contains(button)) return false;
    const label = button.getAttribute("aria-label") || button.getAttribute("title") || button.innerText || "";
    return /continue (generating|generation)|继续(生成|回答)/i.test(label.trim());
  }

  // Only trusted *native* user actions control the queue's stop/resume state.
  // Programmatic clicks performed by this extension do not qualify.
  document.addEventListener("click", (event) => {
    if (!event.isTrusted || !state || !boundHere()) return;
    const button = event.target.closest?.("button");
    if (!button) return;
    if (isNativeStopButton(button)) {
      const snapshot = conversationSnapshot();
      void rpc("STOPPED", { userCount: snapshot.userCount }).then(render).catch(showError);
    } else if (state.halted && isNativeContinueButton(button)) {
      void rpc("USER_RESUMED", { viaNativeContinue: true }).then(render).catch(showError);
    }
  }, true);

  // The native ChatGPT composer is the one and only prompt editor. The plugin
  // merely chooses where a completed text-only prompt should go.
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.shiftKey || event.altKey || event.isComposing || event.keyCode === 229) return;
    const editor = getEditor();
    if (!editor || (event.target !== editor && !editor.contains(event.target))) return;
    if (root.contains(event.target) || suggestionPopupOpen()) return;

    const text = editorText(editor);
    if (!text?.trim()) return;
    const steer = event.ctrlKey || event.metaKey;
    // An empty queue belongs to ChatGPT: leave the original Enter untouched,
    // including attachments and all of ChatGPT's native submit behavior.
    if (!steer && state && boundHere() && !shouldEnqueueEnter()) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.repeat) return;
    if (workInProgress) {
      showError(new Error("队列正在发送当前消息，请等发送确认后再操作。"));
      return;
    }
    if (composerActionInProgress) return;
    composerActionInProgress = true;
    lastClaimAttempt = clock();

    const run = async () => {
      // SPA navigation can happen before the next heartbeat. Re-read the new
      // chat's queue before deciding whether to send or enqueue.
      if (!boundHere()) await rpc("HELLO", { lastUserText: conversationSnapshot().lastUserText });
      if (steer) return steerNativePrompt(editor, text);
      if (shouldEnqueueEnter()) return queueNativePrompt(editor, text);
      // We intercepted only to resolve a stale/new route. The target chat has
      // an empty queue, so submit using ChatGPT's native send button.
      const button = controls().send;
      if (!isVisible(button)) throw new Error("当前对话的发送按钮不可用；输入内容已保留");
      button.click();
    };
    void run()
      .catch(showError)
      .finally(() => { composerActionInProgress = false; });
  }, true);

  async function sendTask(task) {
    if (workInProgress) return;
    workInProgress = true;
    let clicked = false;
    let editor = null;
    try {
      if (!boundHere() || state.halted) throw new Error("当前对话已切换或用户已停止回复");
      editor = getEditor();
      if (!editor || normalize(editorText(editor)) || controls().stop ||
          !isVisible(controls().voice)) {
        throw new Error("语音模式按钮尚未就绪或输入框被占用，稍后再发");
      }
      insertText(editor, task.text);

      let send = null;
      for (let attempt = 0; attempt < 12; attempt++) {
        send = controls().send;
        if (isVisible(send) && !controls().stop) break;
        await sleep(300);
      }
      if (!isVisible(send) || controls().stop || !boundHere() || state.halted) {
        throw new Error("发送按钮不可用或对话已停止，拒绝自动发送");
      }
      resetVoiceReadiness();
      clicked = true;
      send.click();
      // No five-second DOM/user-message confirmation phase. The only automatic
      // completion signal is the native Voice Mode button returning later.
      // For a newly-created chat, the route may switch from / to /c/<id>
      // during the click. Only there do we wait for its ownership handshake.
      if (sessionKey?.startsWith("draft:") && pageChatKey(location.href)) {
        const end = clock() + 4000;
        while (clock() < end && normalize(conversationSnapshot().lastUserText) !== normalize(task.text)) {
          await sleep(250);
        }
      }
      await rpc("SENT", { id: task.id, lastUserText: conversationSnapshot().lastUserText });
    } catch (error) {
      if (!clicked && boundHere()) {
        // Only our own unsubmitted text may be removed; never clear a user's
        // changed draft. Requeue without turning a transient UI race into a
        // permanently halted scheduled task.
        if (editor && normalize(editorText(editor)) === normalize(task.text)) {
          clearComposerText(editor, task.text);
        }
        try {
          await rpc("RELEASE_CLAIM", { id: task.id });
          notification = "";
          return;
        } catch { /* If ownership changed, fail closed below. */ }
      }
      try { await rpc("FAIL", { id: task.id, error: error.message }); }
      catch { /* Context may have been invalidated by extension reload. */ }
      showError(error);
    } finally {
      workInProgress = false;
    }
  }

  async function heartbeat() {
    if (heartbeatInProgress || !state) return;
    heartbeatInProgress = true;
    try {
      mountNearComposer();
      if (location.href !== lastLocation) {
        lastLocation = location.href;
        // A route change is a different conversation; no stale unread marker
        // or pending completion from the previous chat may carry over.
        clearTabRedDot();
        lastReplySnapshot = null;
        replyCompletionWatch = null;
        resetVoiceReadiness();
        const snapshot = conversationSnapshot();
        await rpc("HELLO", { lastUserText: snapshot.lastUserText });
        render();
      }

      // A new conversation URL can appear before its first user message mounts.
      // Keep trying the safe adoption handshake; never adopt unrelated chats.
      if (sessionKey?.startsWith("draft:") && state.activeTaskId &&
          pageChatKey(location.href) && !boundHere()) {
        await rpc("HELLO", { lastUserText: conversationSnapshot().lastUserText });
        if (boundHere()) render();
      }

      if (!boundHere() || composerActionInProgress) return;
      const snapshot = conversationSnapshot();
      // One native Voice Mode readiness signal governs BOTH ordinary queue
      // dispatch, scheduled task delivery, and the tab unread indicator.
      const voiceReady = updateVoiceReadiness(snapshot);
      observeReplyCompleted(snapshot, voiceReady);
      const idle = updateIdle(snapshot, voiceReady);
      const active = state.tasks.find((item) => item.id === state.activeTaskId);

      if (state.halted) {
        // A native user message after Stop means the conversation is resumed.
        // Do not claim anything until this new reply settles.
        if (Number.isInteger(state.haltAtUserCount) &&
            snapshot.userCount > state.haltAtUserCount && normalize(snapshot.lastUserText)) {
          await rpc("USER_RESUMED", {
            userCount: snapshot.userCount, lastUserText: snapshot.lastUserText,
          });
          render();
        }
        return;
      }

      // A selected queue item can be sent *ahead* of the normal queue. Verify
      // that immediate user turn first, before processing the active task's
      // completion or claiming another pending item.
      if (state.steeringTaskId) {
        const steering = state.tasks.find((item) => item.id === state.steeringTaskId);
        if (steering?.status === "steering_wait") {
          if (await confirmSteeredTask(steering, snapshot)) render();
        }
        return;
      }

      if (active?.status === "waiting") {
        if (readyToComplete(active, voiceReady)) {
          await rpc("FINISHED", {
            id: active.id,
            voiceReady: true,
            voiceStableMs: clock() - voiceReadySince,
            editorEmpty: Boolean(getEditor() && !normalize(editorText(getEditor()))),
            busy: snapshot.busy,
          });
          render();
        }
        return;
      }

      if (active || !idle || (temporaryNewChat() && snapshot.userCount > 0)) return;
      if (clock() - lastClaimAttempt < 1800) return;
      lastClaimAttempt = clock();
      const claimed = await rpc("CLAIM", {
        ready: true,
        userCount: snapshot.userCount,
        lastUserId: snapshot.lastUserId,
      });
      if (claimed.dispatch) {
        render();
        await sendTask(claimed.dispatch);
      }
    } catch (error) {
      showError(error);
    } finally {
      heartbeatInProgress = false;
    }
  }

  async function init() {
    try {
      const snapshot = conversationSnapshot();
      resetVoiceReadiness();
      lastReplySnapshot = snapshot;
      clearTabRedDot();
      await rpc("HELLO", { lastUserText: snapshot.lastUserText });
      render();
      await heartbeat();
      window.setInterval(() => { void heartbeat(); }, POLL_MS);
      window.setInterval(updateCountdowns, 1000);
    } catch (error) {
      root.textContent = "任务队列扩展初始化失败，请刷新页面：" + (error.message || error);
      console.error("[ChatQueue]", error);
    }
  }

  void init();
})();
