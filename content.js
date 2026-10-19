/* global chrome */
"use strict";

(() => {
  if (document.getElementById("cq-extension-root")) return;

  const POLL_MS = 1300;
  const PAGE_PULSE_MS = 8000;
  // Voice Mode button (the waveform button, NOT the microphone dictation
  // button) is the shared ready signal for manual and timed queue dispatch.
  const VOICE_READY_STABLE_MS = 1700;
  const TAB_DOT_STABLE_MS = 6500;
  const TAB_UNREAD_DOT = "🔴 ";
  const TAB_COMPLETED_MARK = "✅ ";
  const TAB_SPINNER_FRAMES = ["◴", "◷", "◶", "◵"];
  // A previously injected update spinner (or an older content script) may
  // have prefixed the title too. Remove ALL extension-owned badges rather
  // than only our last frame, or two writers accumulate infinite prefixes.
  const TAB_INDICATOR_PREFIX = /^(?:(?:[◴◷◶◵]|🔴|✅)\s+)+/u;
  const TAB_SPINNER_MS = 300;
  const COMPLETION_SOUND_KEY = "cq.completionSoundEnabled.v1";
  // The icon-only Stop control has no reliable localized label/testid in
  // some ChatGPT composer variants. Recognize its primary-action glyph.
  const NATIVE_STOP_ICON_PREFIX = "M4.5 5.75C4.5 5.05964";
  const STEER_CONFIRM_MS = 18000;
  const EXTENSION_VERSION = chrome.runtime?.getManifest?.()?.version || "";
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
  root.dataset.cqVersion = chrome.runtime?.getManifest?.()?.version || "";

  let state = null;
  let sessionKey = null;
  let legacyUnboundCount = 0;
  let settings = {
    maxPending: 100, protectBackground: true,
    defaultIntervalMinutes: 30, defaultRepeatCount: -1,
    queueListHeight: null,
  };
  let queueExpanded = true;
  let queueFilter = "all";
  let queueSearch = "";
  let favoritesOpen = false;
  let favoriteItems = [];
  let favoriteSearch = "";
  let favoriteCategoryFilter = "";
  let favoritePinnedOnly = false;
  let favoriteSearchComposing = false;
  let favoriteSearchRenderPending = false;
  let favoriteBusy = false;
  let favoriteTemplateDraft = null;
  let favoriteTemplateComposing = false;
  let favoriteTemplateRenderPending = false;
  let focusedTaskId = null;
  let searchComposing = false;
  let searchRenderPending = false;
  let jumpTargetId = null;
  const expandedTaskIds = new Set();
  const expandedErrorIds = new Set();
  let schedulerOpen = false;
  const AUTO_ADVANCED_STORAGE_KEY = "cq.autoAdvancedExpanded.v1";
  let autoAdvancedOpen = false;
  try { autoAdvancedOpen = localStorage.getItem(AUTO_ADVANCED_STORAGE_KEY) === "1"; }
  catch { /* The panel still works when site storage is unavailable. */ }
  let schedulerView = "list";
  let scheduleFilter = "all";
  let scheduleKind = "all";
  let scheduleOrder = "original";
  let scheduleSearch = "";
  let scheduleSearchComposing = false;
  let scheduleRenderPending = false;
  const expandedScheduleIds = new Set();
  let queueComposerOpen = false;
  let queueDraft = "";
  let queueImages = [];
  let queueSubmissionId = null;
  let queueSubmissionInProgress = false;
  let queueDraftRevision = 0;
  let nativeSubmission = null;
  // Keep real File references captured before ChatGPT's uploader clears its
  // native file input. Never persist previews without their source bytes.
  let nativeComposerImages = null;
  let settingsOpen = false;
  let settingsPage = "cooldown";
  let diagnosticsOpen = false;
  let settingsDraftRevision = 0;
  let maxPendingDraft = "100";
  let defaultMinutesDraft = "30";
  let defaultRepeatsDraft = "-1";
  let cooldownSecondsDraft = "0";
  let cooldownDraftDirty = false;
  let cooldownDraftRevision = 0;
  let cooldownSaving = false;
  let scheduleDraft = "";
  let scheduleImages = [];
  let scheduleKeptImages = [];
  let scheduleSubmissionId = null;
  let scheduleSubmissionInProgress = false;
  let scheduleDraftRevision = 0;
  let scheduleDraftDirty = false;
  let scheduleModeDraft = "time";
  let minutesDraft = "30";
  let thresholdDraft = "1";
  let repeatsDraft = "-1";
  let countRateEnabledDraft = false;
  let countRateMinutesDraft = "10";
  let countRateMaxDraft = "3";
  let countRateDirty = false;
  let editingTask = null;
  let editedTaskText = "";
  let editedTaskImages = [];
  let editedTaskKeptImages = [];
  let editingSchedule = null;
  let notification = "";
  let actionFeedback = null;
  const pendingUiActions = new Set();
  let backupInProgress = false;
  let backupProgress = "";
  let imageHealthResult = null;
  let workInProgress = false;
  let composerActionInProgress = false;
  let imageSelectionInProgress = false;
  let draggingTaskId = null;
  let keyboardReorderInProgress = false;
  let draggingSessionKey = null;
  let highlightedDropRow = null;
  let queueResize = null;
  let heartbeatInProgress = false;
  let lastPagePulseAt = 0;
  let voiceReadySignature = "";
  let voiceReadySince = 0;
  let handoffComposerIdleSince = 0;
  let handoffReplyProbe = null;
  let lastLocation = location.href;
  let lastClaimAttempt = 0;
  let lastSchedulePulseAt = 0;
  let schedulePulseInProgress = false;
  let steeringProbe = null;
  let lastReplySnapshot = null;
  let replyCompletionWatch = null;
  let tabUnread = false;
  let tabCompleted = false;
  let tabRunning = false;
  let tabSpinnerFrame = 0;
  let tabSpinnerTimer = null;
  let queueCompletionPending = false;
  const completionAcksInFlight = new Set();
  let completionSoundEnabled = true;
  let completionSoundPlayed = false;
  let completionAudioContext = null;

  const clock = () => Date.now();
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
  const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char]);

  function hasQueueDraft() {
    return Boolean(queueDraft.trim() || queueImages.length ||
      queueSubmissionInProgress);
  }

  function scheduleDraftIsModified() {
    const original = editingSchedule
      ? state?.schedules?.find((item) => item.id === editingSchedule) : null;
    if (original) {
      const previousImages = original.images || [];
      return scheduleDraft !== original.text ||
        scheduleModeDraft !== (original.mode === "count" ? "count" : "time") ||
        minutesDraft !== String(original.intervalMinutes ?? settings.defaultIntervalMinutes) ||
        thresholdDraft !== String(original.threshold ?? 1) ||
        repeatsDraft !== String(original.repeatCount ?? -1) ||
        scheduleImages.length > 0 ||
        scheduleKeptImages.length !== previousImages.length ||
        scheduleKeptImages.some((image, index) => image.id !== previousImages[index]?.id);
    }
    return Boolean(scheduleDraftDirty || scheduleDraft.trim() || scheduleImages.length ||
      scheduleKeptImages.length);
  }

  function hasScheduleDraft() {
    return Boolean(editingSchedule || scheduleSubmissionInProgress ||
      scheduleDraftIsModified());
  }

  function hasUnsavedSettings() {
    return maxPendingDraft !== String(settings.maxPending) ||
      defaultMinutesDraft !== String(settings.defaultIntervalMinutes) ||
      defaultRepeatsDraft !== String(settings.defaultRepeatCount);
  }

  function hasUnsavedCooldown() {
    return cooldownSecondsDraft !== String(state?.sendCooldownSeconds ?? 0);
  }

  function hasUnsavedFavoriteTemplate() {
    return Boolean(favoriteTemplateDraft && Object.values(favoriteTemplateDraft.values)
      .some((value) => String(value).trim()));
  }

  function hasUnsavedAutomation() {
    return hasScheduleDraft() || countRateDirty;
  }

  function hasUnsavedPageDraft() {
    return hasQueueDraft() || hasUnsavedAutomation() ||
      hasUnsavedSettings() || hasUnsavedCooldown() || hasUnsavedFavoriteTemplate() ||
      Boolean(editingTask || imageSelectionInProgress);
  }

  function syncUnsavedDraftIndicators() {
    // The hidden marker lets a newly updated extension avoid refreshing the
    // page when an editor is closed but its unsaved data is still in memory.
    root.dataset.cqUnsavedDraft = hasUnsavedPageDraft() ? "true" : "false";
    for (const [kind, dirty] of [
      ["queue",hasQueueDraft() || Boolean(editingTask)],
      ["schedule",hasUnsavedAutomation()],
      ["settings",hasUnsavedSettings() || hasUnsavedCooldown()],
      ["favorite",hasUnsavedFavoriteTemplate()],
    ]) {
      for (const indicator of root.querySelectorAll(`.cq-draft-indicator[data-draft-kind="${kind}"]`)) {
        indicator.hidden = !dirty;
      }
    }
    for (const [action, label, dirty] of [
      ["toggle-queue-composer","图文入队",hasQueueDraft() || Boolean(editingTask)],
      ["toggle-scheduler","自动入队规则",hasUnsavedAutomation()],
      ["toggle-settings","队列设置",hasUnsavedSettings() || hasUnsavedCooldown() || hasQueueDraft()],
      ["toggle-favorites","提示词收藏夹",hasUnsavedFavoriteTemplate()],
    ]) {
      const button = root.querySelector(`[data-action="${action}"]`);
      if (button) button.setAttribute("aria-label",
        dirty ? `${label}，有未保存的草稿或修改` : label);
    }
    const discardSettings = root.querySelector('[data-action="discard-settings-draft"]');
    if (discardSettings) discardSettings.hidden = !(hasUnsavedSettings() || hasUnsavedCooldown());
    const discardSchedule = root.querySelector('[data-action="discard-schedule-draft"]');
    if (discardSchedule) discardSchedule.hidden = !hasScheduleDraft();
    const scheduleHint = root.querySelector(".cq-draft-hint[data-draft-hint='schedule']");
    if (scheduleHint) scheduleHint.hidden = !hasScheduleDraft();
    const queueHint = root.querySelector(".cq-draft-hint[data-draft-hint='queue']");
    if (queueHint) queueHint.hidden = !hasQueueDraft();
    const settingsHint = root.querySelector(".cq-draft-hint[data-draft-hint='settings']");
    if (settingsHint) settingsHint.hidden = !(hasUnsavedSettings() || hasUnsavedCooldown());
    const cooldownTabDraft = root.querySelector('[data-settings-dirty="cooldown"]');
    if (cooldownTabDraft) cooldownTabDraft.hidden = !hasUnsavedCooldown();
    const generalTabDraft = root.querySelector('[data-settings-dirty="general"]');
    if (generalTabDraft) generalTabDraft.hidden = !hasUnsavedSettings();
    const createTabTitle = root.querySelector(".cq-create-tab-title");
    if (createTabTitle) createTabTitle.textContent = editingSchedule
      ? "继续编辑" : hasScheduleDraft() ? "继续草稿" : "＋ 创建任务";
    const scheduleUnsavedLabel = root.querySelector(".cq-unsaved-label");
    if (scheduleUnsavedLabel) scheduleUnsavedLabel.hidden = !hasScheduleDraft();
  }

  function resetScheduleDraft() {
    scheduleDraftRevision++;
    scheduleDraftDirty = false;
    scheduleSubmissionId = null;
    editingSchedule = null;
    scheduleDraft = "";
    scheduleImages = [];
    scheduleKeptImages = [];
    scheduleModeDraft = "time";
    minutesDraft = String(settings.defaultIntervalMinutes);
    thresholdDraft = "1";
    repeatsDraft = String(settings.defaultRepeatCount);
  }

  function resetSettingsDraft() {
    maxPendingDraft = String(settings.maxPending);
    defaultMinutesDraft = String(settings.defaultIntervalMinutes);
    defaultRepeatsDraft = String(settings.defaultRepeatCount);
  }

  function resetCooldownDraft() {
    cooldownSecondsDraft = String(state?.sendCooldownSeconds ?? 0);
    cooldownDraftDirty = false;
  }

  function resetCountRateDraft() {
    const config = state?.countRateLimit;
    countRateEnabledDraft = config?.enabled === true;
    countRateMinutesDraft = String(config?.windowMinutes ?? 10);
    countRateMaxDraft = String(config?.maxAdds ?? 3);
  }

  function countRateStatus(now = clock()) {
    const config = state?.countRateLimit;
    const enabled = config?.enabled === true;
    const minutes = config?.windowMinutes ?? 10;
    const maxAdds = config?.maxAdds ?? 3;
    const windowStart = now - minutes * 60_000;
    const times = (Array.isArray(state?.countRateTimes) ? state.countRateTimes : [])
      .filter((time) => Number.isFinite(time) && time > windowStart && time <= now)
      .sort((a, b) => a - b);
    const used = times.length;
    return {
      enabled, minutes, maxAdds, used,
      nextAvailableAt: enabled && used >= maxAdds
        ? times[used - maxAdds] + minutes * 60_000 : null,
    };
  }

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

  function queueCount() {
    return state?.tasks.filter((task) =>
      ["pending", "dispatching", "waiting", "steering", "steering_wait"].includes(task.status)).length || 0;
  }

  function queueHeightLimit() {
    return Math.max(72, Math.min(900, Math.floor(window.innerHeight * 0.75)));
  }

  function clampQueueHeight(value) {
    return Math.max(72, Math.min(queueHeightLimit(), Math.round(value)));
  }

  function setQueueListHeight(list, height) {
    if (!list) return;
    const handle = root.querySelector(".cq-resize-handle");
    if (height === null) {
      list.classList.remove("cq-list-custom");
      list.style.removeProperty("--cq-list-height");
      if (handle) handle.setAttribute("aria-valuetext", "自动高度");
    } else {
      const pixels = clampQueueHeight(height);
      list.classList.add("cq-list-custom");
      list.style.setProperty("--cq-list-height", `${pixels}px`);
      if (handle) handle.setAttribute("aria-valuetext", `${pixels} 像素`);
    }
    if (handle) {
      handle.setAttribute("aria-valuemax", String(queueHeightLimit()));
      handle.setAttribute("aria-valuenow", String(Math.round(list.getBoundingClientRect().height)));
    }
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

  function isNativeStopButton(button) {
    if (!button || root.contains(button)) return false;
    const testId = button.getAttribute("data-testid") || "";
    const label = button.getAttribute("aria-label") || button.getAttribute("title") || "";
    if (/(?:^|-)stop-button$|composer-stop-button/i.test(testId) ||
        /^(?:stop(?:\s+(?:generating|generation|response|responding|streaming))?|停止(?:生成|回复|回答|响应)?|结束生成)$/i.test(label.trim())) {
      return true;
    }
    // The square primary-action glyph only counts when it belongs to the
    // ChatGPT composer, never an arbitrary Stop button in a chat reply.
    const form = button.closest("form");
    if (!form || (!form.querySelector('#prompt-textarea, [data-testid="prompt-textarea"], [data-testid="composer-input"]') &&
        !form.matches("[data-chatgpt-composer]"))) return false;
    return [...button.querySelectorAll("svg.icon-primary-action > path")]
      .some((path) => (path.getAttribute("d") || "").startsWith(NATIVE_STOP_ICON_PREFIX));
  }

  function controls() {
    // Prefer only buttons in this composer. A generated answer may include
    // other clickable "Send" buttons which must never be used by the queue.
    const form = getEditor()?.closest("form");
    const buttons = [...(form?.querySelectorAll("button") || document.querySelectorAll("main button, form button"))]
      .filter((button) => !root.contains(button));
    // The stop control sometimes moves outside the composer during tool calls.
    const stop = buttons.find((button) => isNativeStopButton(button) && isVisible(button)) ||
      [...document.querySelectorAll("main button, button[data-testid='stop-button']")]
        .find((button) => isNativeStopButton(button) && isVisible(button));
    const send = buttons.find((button) => {
      const testId = button.getAttribute("data-testid") || "";
      const name = button.getAttribute("aria-label") || button.getAttribute("title") || "";
      return (/^(send-button|composer-submit-button|composer-send-button)$/.test(testId) ||
        /^(send|send message|send prompt|发送|发送消息|发送提示词)$/.test(name.toLowerCase())) && !isNativeStopButton(button);
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

  function nativeGenerationRunning() {
    if (controls().stop) return true;
    return [...document.querySelectorAll(
      'main [data-testid="generation-in-progress"], main [data-is-streaming="true"],' +
      'main [data-state="streaming"]'
    )].some(isVisible);
  }

  function tabGenerationRunning() {
    if (nativeGenerationRunning()) return true;
    // A queued reply may temporarily hide the Stop button while a tool runs.
    // Do not let pending tasks or an idle Voice composer cause false spinners.
    if (!state || !boundHere() || state.halted || !state.activeTaskId) return false;
    const task = state.tasks.find((item) => item.id === state.activeTaskId);
    return task?.status === "waiting" && !isVisible(controls().voice);
  }

  function turnRole(element) {
    return element?.getAttribute("data-message-author-role") ||
      element?.getAttribute("data-turn") ||
      element?.getAttribute("data-conversation-role") || null;
  }

  function turns() {
    const selector =
      '[data-message-author-role="assistant"], [data-message-author-role="user"],' +
      'section[data-turn="assistant"], section[data-turn="user"],' +
      '[data-conversation-role="assistant"], [data-conversation-role="user"]';
    return [...document.querySelectorAll(selector)]
      .filter((element) => !root.contains(element) &&
        !element.parentElement?.closest(selector));
  }

  function nativeFirstMessageAt(firstUser) {
    if (!firstUser) return null;
    // If ChatGPT is virtualizing turns, a displayed middle turn must not be
    // mistaken for the beginning of the conversation.
    const wrapper = firstUser.closest('[data-testid^="conversation-turn-"]');
    const index = wrapper?.getAttribute("data-testid")?.match(/^conversation-turn-(\d+)$/);
    if (index && Number(index[1]) !== 0) return null;
    const message = firstUser.querySelector("[data-message-id]");
    const timestamps = [
      firstUser.getAttribute("data-message-created-at"),
      message?.getAttribute("data-message-created-at"),
      wrapper?.getAttribute("data-message-created-at"),
      firstUser.querySelector("time[datetime]")?.getAttribute("datetime"),
      wrapper?.querySelector("time[datetime]")?.getAttribute("datetime"),
    ];
    const now = clock();
    for (const value of timestamps) {
      if (typeof value !== "string") continue;
      const raw = value.trim();
      const timestamp = /^\d{13}$/.test(raw) ? Number(raw) :
        /^\d{10}$/.test(raw) ? Number(raw) * 1000 :
        /^\d{4}-\d\d-\d\dT\d\d:\d\d:/.test(raw) &&
        /(?:Z|[+-]\d\d:\d\d)$/i.test(raw) ? Date.parse(raw) : NaN;
      if (Number.isInteger(timestamp) && timestamp >= Date.UTC(2022,0,1) &&
          timestamp <= now + 60_000) return timestamp;
    }
    return null;
  }

  function messageText(element) {
    if (!element) return "";
    // Use the complete assistant turn, including tool placeholders/status.
    // A single .markdown node can be only the first segment of a tool reply.
    const role = turnRole(element);
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
    return message?.getAttribute("data-message-id") ||
      element?.getAttribute("data-turn-id") ||
      element?.getAttribute("data-testid") || null;
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

  function conversationSnapshot() {
    const list = turns();
    let assistantCount = 0;
    let userCount = 0;
    let lastAssistant = null;
    let lastUser = null;
    let firstUser = null;
    for (const element of list) {
      const role = turnRole(element);
      if (role === "assistant") { assistantCount++; lastAssistant = element; }
      if (role === "user") {
        userCount++;
        lastUser = element;
        firstUser ||= element;
      }
    }
    const text = assistantOutputText(lastAssistant);
    const surface = messageText(lastAssistant);
    return {
      assistantCount,
      userCount,
      lastRole: turnRole(list.at(-1)),
      lastAssistantText: text,
      lastAssistantSurface: surface,
      lastAssistantSignature: `${text.length}|${text.slice(-2500)}`,
      lastAssistantId: messageId(lastAssistant),
      lastAssistantElement: lastAssistant,
      lastUserText: messageText(lastUser),
      lastUserId: messageId(lastUser),
      lastUserElement: lastUser,
      firstUserElement: firstUser,
      busy: nativeGenerationRunning(),
    };
  }

  function handoffBoundaryPresent(text, name, requestId) {
    const suffix = requestId ? `\\s*:\\s*${requestId}` : "";
    return new RegExp(
      `\\[\\[\\s*CHATGPT_TASKQUEUE_HANDOFF_${name}${suffix}\\s*\\]\\]`,"i")
      .test(text);
  }

  function extractHandoffReply(snapshot, requestId) {
    const element = snapshot.lastAssistantElement;
    const candidates = [
      snapshot.lastAssistantText, snapshot.lastAssistantSurface,
      element?.textContent,
    ].filter((value) => typeof value === "string" && value.trim());
    const complete = candidates.filter((value) =>
      handoffBoundaryPresent(value,"START",requestId) &&
      handoffBoundaryPresent(value,"END",requestId));
    // A response can have multiple markdown/code/tool segments. Prefer a
    // complete source before a short .markdown fragment; the background still
    // performs the authoritative UUID and summary-length validation.
    const text = (complete.length ? complete : candidates)
      .sort((a,b) => b.length - a.length)[0] || "";
    return {
      text,
      completeMarkers:complete.length > 0,
    };
  }

  function nativeReplyHasFinalActions(element) {
    if (!element) return false;
    const turn = element.closest(
      '[data-testid^="conversation-turn-"], article, [data-turn-id]'
    ) || element.parentElement || element;
    return [...turn.querySelectorAll("button")].some((button) => {
      const label = button.getAttribute("aria-label") || button.getAttribute("title") || "";
      const testId = button.getAttribute("data-testid") || "";
      return isVisible(button) && (
        /^(复制|复制消息|复制回复|copy|copy message|copy response)$/i.test(label.trim()) ||
        /^(copy-turn-action-button|copy-message-button)$/.test(testId));
    });
  }

  function handoffComposerReady(snapshot) {
    const editor = getEditor();
    const safe = Boolean(editor && !normalize(editorText(editor)) &&
      !hasComposerAttachments(editor) && !nativeGenerationRunning() &&
      !controls().stop && (snapshot.userCount === 0 || snapshot.lastRole === "assistant"));
    if (!safe) {
      handoffComposerIdleSince = 0;
      return false;
    }
    handoffComposerIdleSince ||= clock();
    // Used only for the two internal handoff messages when ChatGPT does not
    // expose the Voice Mode waveform at all. Never dispatch ordinary tasks
    // from a temporarily hidden Stop button.
    return clock() - handoffComposerIdleSince >= 4500;
  }

  function handoffCompletionEvidence(task, snapshot) {
    // A handoff may first have to wait for a normal queue reply already sent.
    // Only while handoff is due may that existing reply use the same strict
    // native-final-action proof; ordinary queue dispatch remains unchanged.
    const finishingBeforeHandoff = state?.handoff?.phase === "due";
    if (!task || (!["handoff_summary","handoff_intro"].includes(task.kind) &&
        !finishingBeforeHandoff)) {
      handoffReplyProbe = null;
      return {ready:false};
    }
    const editor = getEditor();
    if (!editor || normalize(editorText(editor)) || hasComposerAttachments(editor) ||
        nativeGenerationRunning() || controls().stop) {
      handoffReplyProbe = null;
      return {ready:false};
    }
    const result = extractHandoffReply(snapshot,
      task.kind === "handoff_summary" ? state?.handoff?.requestId : null);
    const newerAssistant = Boolean(
      task.kind === "handoff_summary" && result.completeMarkers ||
      Number.isInteger(task.baselineAssistantCount) &&
        snapshot.assistantCount > task.baselineAssistantCount ||
      task.baselineAssistantId && snapshot.lastAssistantId &&
        snapshot.lastAssistantId !== task.baselineAssistantId ||
      Number.isInteger(task.baselineUserCount) &&
        snapshot.userCount > task.baselineUserCount && snapshot.lastRole === "assistant"
    );
    const finalActions = nativeReplyHasFinalActions(snapshot.lastAssistantElement);
    const responseConfirmed = Boolean(newerAssistant && result.text &&
      (finalActions || task.kind === "handoff_summary" && result.completeMarkers));
    const now = clock();
    const signature = `${snapshot.lastAssistantId || ""}|${result.text.length}|` +
      `${result.text.slice(0,120)}|${result.text.slice(-380)}`;
    if (!handoffReplyProbe || handoffReplyProbe.taskId !== task.id) {
      handoffReplyProbe = {
        taskId:task.id,idleSince:now,replySince:now,signature,
      };
    } else if (handoffReplyProbe.signature !== signature) {
      handoffReplyProbe.signature = signature;
      handoffReplyProbe.replySince = now;
    }
    const idleStableMs = now - handoffReplyProbe.idleSince;
    const replyStableMs = now - handoffReplyProbe.replySince;
    return {
      ready:responseConfirmed && idleStableMs >= 4500 && replyStableMs >= 2500,
      idleStableMs,replyStableMs,responseConfirmed,
      newerAssistant:Boolean(newerAssistant),summary:result.text,
    };
  }

  function reportPagePulse(snapshot) {
    const now = clock();
    if (now - lastPagePulseAt < PAGE_PULSE_MS) return;
    lastPagePulseAt = now;
    // A standalone, best-effort observation: never use rpc() here, because
    // a pulse must not replace UI state, modify tasks, or interrupt dispatch.
    try {
      void Promise.resolve(chrome.runtime.sendMessage({
        type:"PAGE_PULSE",generating:snapshot.busy === true,
      })).catch(() => { /* Extension reloading or the tab going to sleep. */ });
    } catch { /* Monitoring is optional; sending tasks is not. */ }
  }

  function syncTabIndicators() {
    // Animate the title prefix so Edge's vertical tab strip shows work in
    // progress without opening a window or replacing ChatGPT's favicon.
    // Both the normal script and the temporary update spinner can touch the
    // same title; previous-frame matching alone is not idempotent.
    const current = document.title || "ChatGPT";
    const title = current.replace(TAB_INDICATOR_PREFIX, "");
    const prefix = (tabRunning ? TAB_SPINNER_FRAMES[tabSpinnerFrame] + " " : "") +
      (tabUnread ? TAB_UNREAD_DOT : "") +
      (tabCompleted ? TAB_COMPLETED_MARK : "");
    if (current !== prefix + title) document.title = prefix + title;
  }

  function isTabViewed() {
    return document.visibilityState === "visible" && document.hasFocus();
  }

  function setTabRunning(running) {
    if (tabRunning === running) return;
    tabRunning = running;
    if (tabSpinnerTimer !== null) {
      clearInterval(tabSpinnerTimer);
      tabSpinnerTimer = null;
    }
    if (running) {
      tabSpinnerFrame = 0;
      tabSpinnerTimer = window.setInterval(() => {
        tabSpinnerFrame = (tabSpinnerFrame + 1) % TAB_SPINNER_FRAMES.length;
        syncTabIndicators();
      }, TAB_SPINNER_MS);
    }
    syncTabIndicators();
  }

  // ChatGPT can swap a labelled Stop button for an icon-only square during
  // generation. Observe composer mutations directly instead of relying on
  // 1.3-second polling (heavily throttled in background Edge tabs).
  const tabControlObserver = new MutationObserver((records) => {
    const controlsChanged = records.some((record) => {
      const target = record.target;
      if (!(target instanceof Element) || root.contains(target)) return false;
      if (record.type === "attributes") {
        return target.matches("button, svg, path, [data-is-streaming], [data-state], [data-testid]") &&
          (target.closest("button, form") !== null ||
            target.matches('[data-is-streaming], [data-state="streaming"], [data-testid="generation-in-progress"]'));
      }
      if (target.closest("form, button")) return true;
      return [...record.addedNodes, ...record.removedNodes].some((node) =>
        node instanceof Element && node !== root && !root.contains(node) &&
        (node.matches("button, form, [data-is-streaming], [data-testid='generation-in-progress']") ||
          node.querySelector("button, form, [data-is-streaming], [data-testid='generation-in-progress']")));
    });
    if (controlsChanged) setTabRunning(tabGenerationRunning());
  });
  if (document.body) {
    tabControlObserver.observe(document.body, {
      childList: true, subtree: true, attributes: true,
      attributeFilter: ["data-testid", "aria-label", "title", "style", "class", "disabled", "d", "data-is-streaming", "data-state"],
    });
  }

  function clearTabRedDot() {
    tabUnread = false;
    syncTabIndicators();
  }

  function clearTabCompleted() {
    if (!tabCompleted) return;
    tabCompleted = false;
    syncTabIndicators();
  }

  function syncStoredCompletion() {
    // The notification belongs to the conversation, not this particular DOM
    // instance. Never clear it merely because more queue tasks were enqueued.
    tabCompleted = Boolean(state?.unreadCompleted) && !isTabViewed();
    syncTabIndicators();
    if (isTabViewed() && state?.unreadCompleted) acknowledgeViewedTab();
  }

  function getCompletionAudio() {
    const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextCtor) return null;
    if (!completionAudioContext || completionAudioContext.state === "closed") {
      completionAudioContext = new AudioContextCtor();
    }
    return completionAudioContext;
  }

  function unlockCompletionAudio() {
    if (!completionSoundEnabled) return;
    try {
      const audio = getCompletionAudio();
      if (audio?.state === "suspended") {
        void audio.resume().catch(() => { /* Requires a real user gesture. */ });
      }
    } catch { /* Audio is optional; never interrupt queue dispatch. */ }
  }

  // A gesture on ChatGPT or on the queue controls authorizes this document
  // to play later while it is in a background tab. A brand new, never
  // interacted-with tab may still be blocked by the browser's autoplay policy.
  window.addEventListener("pointerdown", unlockCompletionAudio, { capture: true, passive: true });
  window.addEventListener("keydown", unlockCompletionAudio, true);

  function emitCompletionChime(audio) {
    // Two gentle tones, generated locally. No remote file, OS integration,
    // extra extension permission or autoplaying audio element is required.
    const start = audio.currentTime + 0.01;
    for (const [offset, frequency] of [[0, 784], [0.12, 1047]]) {
      const oscillator = audio.createOscillator();
      const gain = audio.createGain();
      const at = start + offset;
      oscillator.type = "sine";
      oscillator.frequency.setValueAtTime(frequency, at);
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.065, at + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.18);
      oscillator.connect(gain);
      gain.connect(audio.destination);
      oscillator.start(at);
      oscillator.stop(at + 0.19);
    }
  }

  async function playCompletionSound(preview = false) {
    if (!completionSoundEnabled && !preview) return false;
    try {
      const audio = getCompletionAudio();
      if (!audio) return false;
      if (audio.state !== "running") {
        // Only a user-clicked preview may wait for resume; a finished reply
        // must not play a stale notification on the user's next interaction.
        if (!preview) return false;
        await audio.resume();
      }
      if (audio.state !== "running") return false;
      emitCompletionChime(audio);
      return true;
    } catch { return false; }
  }

  async function loadCompletionSoundPreference() {
    try {
      const stored = await chrome.storage?.local?.get?.(COMPLETION_SOUND_KEY);
      if (typeof stored?.[COMPLETION_SOUND_KEY] === "boolean") {
        completionSoundEnabled = stored[COMPLETION_SOUND_KEY];
      }
    } catch { /* Keep the default if extension storage is unavailable. */ }
  }

  function markTabCompletedIfDrained(voiceReady) {
    // Empty queues on page load, manual deletion, interrupted sends and
    // scheduled refills are NOT evidence of a successfully finished reply.
    if (!voiceReady || !boundHere() || !state || state.halted ||
        state.tasks.length || state.activeTaskId || state.steeringTaskId ||
        composerActionInProgress || workInProgress) return;
    if (!completionSoundPlayed) {
      completionSoundPlayed = true;
      void playCompletionSound();
    }
    if (isTabViewed()) return; // Already reading this conversation.
    tabCompleted = true;
    syncTabIndicators();
  }

  function clearCompletionIfWorkQueued() {
    if (state?.tasks?.length || state?.activeTaskId || state?.steeringTaskId || state?.halted) {
      queueCompletionPending = false;
      completionSoundPlayed = false;
    }
  }

  function unreadRedDot() {
    // A user already looking at the answer does not need an unread marker.
    if (isTabViewed()) return;
    tabUnread = true;
    syncTabIndicators();
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
      // Automatic follow-up messages in a hidden queue must not count as
      // the user reading the earlier completed answer.
      if (isTabViewed()) acknowledgeViewedTab();
      queueCompletionPending = false;
      completionSoundPlayed = false;
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
        markTabCompletedIfDrained(voiceReady);
        // Ordinary manual replies have no FINISHED event in the queue
        // backend. Persist their unread state separately after confirmation.
        if (!state?.activeTaskId && !state?.steeringTaskId && !state?.halted) {
          void rpc("REPLY_COMPLETED", { viewed: isTabViewed() }).catch(() => {
            // A missed cosmetic notification must never stop the queue.
          });
        }
        replyCompletionWatch = null; // One dot per completed reply.
      }
    }
    lastReplySnapshot = snapshot;
    syncTabIndicators();
  }

  function acknowledgeViewedTab() {
    if (!isTabViewed()) return;
    tabUnread = false;
    tabCompleted = false;
    syncTabIndicators();
    if (!state?.unreadCompleted || !boundHere() ||
        completionAcksInFlight.has(sessionKey)) return;
    const key = sessionKey;
    completionAcksInFlight.add(key);
    void rpc("ACK_COMPLETION_VIEWED").catch(() => {
      // Leave the stored unread marker intact for a future retry.
    }).finally(() => completionAcksInFlight.delete(key));
  }
  document.addEventListener("visibilitychange", acknowledgeViewedTab);
  window.addEventListener("focus", acknowledgeViewedTab);
  // ChatGPT can rename the tab at any moment (including after a response).
  // Keep the indicator visible until the tab is actually viewed again.
  const tabTitleObserver = new MutationObserver(() => {
    if (tabUnread || tabCompleted || tabRunning) syncTabIndicators();
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
    if (!editor || normalize(editorText(editor)) || !isVisible(voice) || stop ||
        nativeGenerationRunning()) {
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
    const requestedUrl = location.href;
    const completingQueuedReply = type === "FINISHED"
      ? state?.activeTaskId === properties.id &&
        state?.tasks?.some((task) => task.id === properties.id && task.status === "waiting")
      : type === "STEER_CONFIRM" && state?.steeringTaskId === properties.id &&
        state?.tasks?.some((task) => task.id === properties.id && task.status === "steering_wait");
    const reply = await chrome.runtime.sendMessage({ type, url: requestedUrl, ...properties });
    if (!reply?.ok) throw new Error(reply?.error || "插件后台未响应，请刷新 ChatGPT 页面");
    // A user may navigate between chats while a large image is being saved.
    // That reply belongs to the old route: return it to the original action,
    // but never overwrite the new chat's state or erase its unsent draft.
    // The next heartbeat issues HELLO for the current route.
    if (location.href !== requestedUrl) return reply;
    const switched = Boolean(reply.sessionKey && sessionKey !== reply.sessionKey);
    if (switched) {
      queueCompletionPending = false;
      completionSoundPlayed = false;
      tabCompleted = false;
      clearTabRedDot();
      imageHealthResult = null;
      nativeSubmission = null;
      queueFilter = "all";
      queueSearch = "";
      favoritesOpen = false;
      favoriteCategoryFilter = "";
      favoritePinnedOnly = false;
      favoriteTemplateDraft = null;
      favoriteTemplateComposing = false;
      favoriteTemplateRenderPending = false;
      favoriteSearchComposing = false;
      favoriteSearchRenderPending = false;
      focusedTaskId = null;
      searchComposing = false;
      searchRenderPending = false;
      jumpTargetId = null;
      expandedTaskIds.clear();
      expandedErrorIds.clear();
      sessionKey = reply.sessionKey;
      steeringProbe = null;
      editingTask = null;
      editedTaskText = "";
      editedTaskImages = [];
      editedTaskKeptImages = [];
      notification = "";
      actionFeedback = null;
      schedulerOpen = false;
      schedulerView = "list";
      scheduleFilter = "all";
      scheduleKind = "all";
      scheduleOrder = "original";
      scheduleSearch = "";
      scheduleSearchComposing = false;
      scheduleRenderPending = false;
      expandedScheduleIds.clear();
      queueComposerOpen = false;
      queueDraft = "";
      queueImages = [];
      queueSubmissionId = null;
      scheduleSubmissionId = null;
      settingsOpen = false;
      diagnosticsOpen = false;
      cooldownDraftDirty = false;
      cooldownDraftRevision++;
    }
    if (["ENQUEUE", "ADD_TASK", "EDIT_TASK", "DELETE_TASK", "FINISHED",
         "ADD_SCHEDULE", "EDIT_SCHEDULE", "DELETE_SCHEDULE", "RESTORE_BACKUP",
         "STEER_CONFIRM"].includes(type)) {
      imageHealthResult = null;
    }
    if (reply.state) {
      state = reply.state;
      clearCompletionIfWorkQueued();
      syncStoredCompletion();
      if (switched) countRateDirty = false;
      if (!countRateDirty) resetCountRateDraft();
      if (!cooldownDraftDirty) resetCooldownDraft();
    }
    if (completingQueuedReply && reply.state &&
        !state.halted && !state.tasks.length && !state.activeTaskId && !state.steeringTaskId) {
      // FINISHED is backed by the native stable Voice signal; STEER_CONFIRM
      // only proves a native user message, so it must wait for Voice readiness.
      queueCompletionPending = type === "STEER_CONFIRM";
      if (type === "FINISHED") markTabCompletedIfDrained(updateVoiceReadiness());
    }
    if (reply.settings) {
      const settingsWereDirty = hasUnsavedSettings();
      settings = { ...settings, ...reply.settings };
      if (!settingsOpen && !settingsWereDirty) resetSettingsDraft();
    }
    if (switched) resetScheduleDraft();
    legacyUnboundCount = reply.legacyUnboundCount || 0;
    return reply;
  }

  async function favoriteRpc(type, properties = {}) {
    const reply = await chrome.runtime.sendMessage({type, url:location.href, ...properties});
    if (!reply?.ok) throw new Error(reply?.error || "收藏夹暂时不可用");
    if (Array.isArray(reply.favorites)) favoriteItems = reply.favorites;
    return reply;
  }

  function favoriteForTask(task) {
    const images = (task.images || []).map((image) => image.id);
    // The star beside a queue task represents a *literal* copy. A parameterized
    // favorite with the same source is independent and must not be deleted
    // accidentally when the user clicks this star.
    return favoriteItems.find((favorite) => favorite.templateEnabled !== true &&
      favorite.text === task.text &&
      JSON.stringify((favorite.images || []).map((image) => image.id)) === JSON.stringify(images));
  }

  function showError(error) {
    const message = error?.message || String(error);
    actionFeedback = null;
    notification = message === state?.error ? "" : message;
    queueExpanded = true;
    render();
  }

  function showActionFeedback(message) {
    // A compact, dismissible receipt for explicit user actions. It stays
    // visible even when the queue panel is collapsed, unlike the in-queue
    // safety notices used for uncertain sends and recovery.
    actionFeedback = String(message || "");
  }

  function renderActionFeedback() {
    if (!actionFeedback) return "";
    return `<div class="cq-action-feedback" role="status" aria-live="polite">
      <span class="cq-action-feedback-check" aria-hidden="true">${icon("check")}</span>
      <span class="cq-action-feedback-text">${escapeHtml(actionFeedback)}</span>
      <button type="button" data-action="dismiss-feedback" aria-label="关闭操作提示"
        title="关闭操作提示">${icon("close")}</button>
    </div>`;
  }

  function excerpt(text, max = 160) {
    return escapeHtml(text.length > max ? text.slice(0, max) + "…" : text);
  }

  function localDate(value) {
    if (!value) return "未执行";
    return new Date(value).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  }

  function conversationDuration(startedAt, now = clock()) {
    const minutes = Math.max(0, Math.floor((now - startedAt) / 60_000));
    const days = Math.floor(minutes / 1440);
    const hours = Math.floor((minutes % 1440) / 60);
    const rest = minutes % 60;
    if (days) return `${days}天 ${hours}小时${rest}分钟`;
    if (hours) return `${hours}小时${rest}分钟`;
    return minutes ? `${minutes}分钟` : "不到1分钟";
  }

  function handoffHoverText(hint, now = clock()) {
    const date = (value) => new Date(value).toLocaleString("zh-CN", {
      month:"2-digit", day:"2-digit", hour:"2-digit", minute:"2-digit",
    });
    const valid = (value) => Number.isInteger(value) &&
      value >= Date.UTC(2022,0,1) && value <= now + 60_000;
    const firstMessageAt = valid(state?.firstMessageAt) ? state.firstMessageAt : null;
    const firstSeenAt = valid(state?.firstSeenAt) ? state.firstSeenAt : null;
    if (firstMessageAt) {
      return `当前对话已至少持续：${conversationDuration(firstMessageAt, now)}\n` +
        `首条消息：${date(firstMessageAt)}\n${hint}`;
    }
    if (firstSeenAt) {
      return `插件已记录此对话至少：${conversationDuration(firstSeenAt, now)}\n` +
        `首次记录：${date(firstSeenAt)}（实际开始可能更早）\n${hint}`;
    }
    return `对话时长：尚无可靠记录\n${hint}`;
  }

  function updateHandoffHover(now = clock()) {
    const button = root.querySelector('.cq-handoff-now[data-handoff-hint]');
    if (!button) return;
    const value = handoffHoverText(button.dataset.handoffHint,now);
    if (button.title !== value) button.title = value;
    const wrapper = button.closest(".cq-handoff-hover-area");
    if (wrapper && wrapper.title !== value) wrapper.title = value;
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

  function sendCooldownUntil(now = clock()) {
    const seconds = state?.sendCooldownSeconds;
    const settled = state?.lastQueueSettledAt;
    if (!Number.isInteger(seconds) || seconds <= 0 || seconds > 3600 ||
        !Number.isFinite(settled) || settled <= 0 || settled > now + 60_000) return null;
    const until = settled + seconds * 1000;
    return until > now ? until : null;
  }

  function updateCountdowns() {
    if (!state || !root.isConnected) return;
    updateDraftWaiting();
    if (!boundHere()) return;
    const now = clock();
    updateHandoffHover(now);
    for (const element of root.querySelectorAll(".cq-countdown[data-next-run-at]")) {
      const nextRunAt = Number(element.dataset.nextRunAt);
      element.textContent = `${element.dataset.prefix || ""}${countdownText(nextRunAt, now)}`;
      element.title = `还剩 ${Math.max(0, Math.ceil((nextRunAt - now) / 1000))} 秒`;
    }
    const cooldownBadge = root.querySelector(".cq-cooldown-status[data-cooldown-until]");
    if (cooldownBadge && now >= Number(cooldownBadge.dataset.cooldownUntil)) {
      // Hide an expired label immediately; the next heartbeat will attempt
      // CLAIM against the serialized background gate.
      cooldownBadge.hidden = true;
    }
    const rateCountdown = root.querySelector(".cq-count-rate-status .cq-countdown[data-next-run-at]");
    if (rateCountdown && now >= Number(rateCountdown.dataset.nextRunAt)) {
      // Refresh the quota display when the rolling window releases a slot,
      // including when no count-rule currently needs another queued item.
      render();
      return;
    }
    const rateLimited = countRateStatus(now).nextAvailableAt !== null;
    const due = state.schedules.some((schedule) => schedule.enabled &&
      (schedule.mode === "count"
        ? !rateLimited && queueCount() < Math.min(schedule.threshold, settings.maxPending)
        : now >= schedule.nextRunAt));
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
      settings: '<path d="M12 2l1.6 2.2 2.7.5.5 2.7L19 9l-1.2 2.5 1.2 2.5-2.2 1.6-.5 2.7-2.7.5L12 21l-2.5-1.2-2.5 1.2-.5-2.7-2.7-.5L3 14l1.2-2.5L3 9l2.2-1.6.5-2.7 2.7-.5L12 2z"/><circle cx="12" cy="11.5" r="3"/>',
      shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/>',
      close: '<path d="M6 6l12 12M18 6 6 18"/>',
      play: '<path d="m8 5 11 7-11 7z"/>',
      pause: '<path d="M9 5v14M15 5v14"/>',
      plus: '<path d="M12 5v14M5 12h14"/>',
      arrowUp: '<path d="m6 14 6-6 6 6"/>',
      arrowDown: '<path d="m6 10 6 6 6-6"/>',
      grip: '<circle cx="9" cy="5" r="1"/><circle cx="15" cy="5" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="9" cy="19" r="1"/><circle cx="15" cy="19" r="1"/>',
      pin: '<path d="m16 3 5 5-4 1-3 4 1 4-2 2-4-5-5-5 2-2 4 1 4-3zM9 15l-6 6"/>',
      star: '<path d="m12 2 3.1 6.3 7 .9-5 4.9 1.2 6.9-6.3-3.3-6.3 3.3 1.2-6.9-5-4.9 7-.9z"/>',
      handoff: '<path d="M4 7h14m-4-4 4 4-4 4M20 17H6m4-4-4 4 4 4"/>',
      steer: '<path d="m7 17 10-10M8 7h9v9"/>',
      edit: '<path d="m4 17-.5 3.5L7 20l11-11-3-3L4 17zM13 8l3 3"/>',
      image: '<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8" cy="8" r="1.6"/><path d="m3 17 6-6 4 4 3-3 5 5"/>',
      trash: '<path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13"/>',
      check: '<path d="m5 12 4 4L19 6"/>',
      search: '<circle cx="10.5" cy="10.5" r="7"/><path d="m16 16 5 5"/>',
      focus: '<circle cx="12" cy="12" r="3"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/>',
      alert: '<path d="M12 3 2 21h20L12 3z"/><path d="M12 9v5M12 18h.01"/>',
    }[name] || "";
    return `<svg aria-hidden="true" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`;
  }

  function taskCategory(task) {
    if (task.status === "pending") return "pending";
    if (["dispatching", "waiting", "steering", "steering_wait"].includes(task.status)) return "active";
    if (["error", "interrupted"].includes(task.status)) return "review";
    return "other";
  }

  function filteredTasks() {
    const query = queueSearch.trim().toLocaleLowerCase();
    return state.tasks.filter((task) =>
      (task.id === editingTask || (queueFilter === "all" || taskCategory(task) === queueFilter) &&
      (!query || [task.text, task.error, ...(task.images || []).map((image) => image.name)]
        .some((value) => String(value || "").toLocaleLowerCase().includes(query)))));
  }

  function queueResultText() {
    return queueFilter !== "all" || queueSearch.trim()
      ? `显示 ${filteredTasks().length}/${state.tasks.length} 条 · 筛选时暂停拖拽`
      : "↑↓ 浏览 · Alt+↑↓ 排序 · 可拖拽";
  }

  function focusQueueTaskRow(taskId, scrollToRow = true) {
    const list = root.querySelector(".cq-list");
    const row = [...(list?.querySelectorAll(".cq-task[data-task-id]") || [])]
      .find((element) => element.dataset.taskId === taskId);
    if (!row || !list) return false;
    focusedTaskId = taskId;
    for (const item of list.querySelectorAll(".cq-task[data-task-id]")) {
      item.tabIndex = item === row ? 0 : -1;
    }
    if (scrollToRow) {
      const listRect = list.getBoundingClientRect();
      const rowRect = row.getBoundingClientRect();
      if (rowRect.top < listRect.top + 3) {
        list.scrollTop -= (listRect.top + 3 - rowRect.top);
      } else if (rowRect.bottom > listRect.bottom - 3) {
        list.scrollTop += rowRect.bottom - (listRect.bottom - 3);
      }
    }
    row.focus({preventScroll: true});
    return true;
  }

  function queueNavigationTask(category) {
    if (category === "active") {
      return state.tasks.find((task) => task.id === state.activeTaskId ||
        task.id === state.steeringTaskId) ||
        state.tasks.find((task) => taskCategory(task) === "active");
    }
    if (category === "pending" || category === "review") {
      return state.tasks.find((task) => taskCategory(task) === category);
    }
    return null;
  }

  function updateSearchResults() {
    // Never replace the search input while the user is typing. In particular
    // this preserves Chinese IME composition, caret/selection and native
    // browser search editing on large (up to 200-item) queue lists.
    const list = root.querySelector(".cq-list");
    if (!list || draggingTaskId || queueResize || searchComposing) return;
    list.innerHTML = renderTasks();
    list.scrollTop = 0;
    const counter = root.querySelector(".cq-search-result");
    if (counter) counter.textContent = queueResultText();
  }

  function jumpToQueueTask(category) {
    const task = queueNavigationTask(category);
    if (!task) return;
    // A target hidden by search/filter must become visible before scrolling;
    // only view state changes, never the real queue order.
    queueFilter = "all";
    queueSearch = "";
    jumpTargetId = task.id;
    queueExpanded = true;
    render();
    const list = root.querySelector(".cq-list");
    const row = [...(list?.querySelectorAll("[data-task-id]") || [])]
      .find((element) => element.dataset.taskId === task.id);
    if (!list || !row) return;
    const offset = row.getBoundingClientRect().top - list.getBoundingClientRect().top;
    list.scrollTop += offset - Math.max(8, (list.clientHeight - row.clientHeight) / 2);
    focusQueueTaskRow(task.id, false);
  }

  function highlightedTaskSnippet(text, expanded = false) {
    const source = String(text || "");
    const query = queueSearch.trim();
    const found = query ? source.toLocaleLowerCase().indexOf(query.toLocaleLowerCase()) : -1;
    const start = !expanded && found > 170 ? Math.max(0, found - 55) : 0;
    const end = expanded ? source.length : Math.min(source.length, start + 220);
    const snippet = source.slice(start, end);
    let markup = "";
    if (!query) {
      markup = escapeHtml(snippet);
    } else {
      const index = snippet.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
      markup = index < 0 ? escapeHtml(snippet) :
        escapeHtml(snippet.slice(0, index)) +
        `<mark>${escapeHtml(snippet.slice(index, index + query.length))}</mark>` +
        escapeHtml(snippet.slice(index + query.length));
    }
    return (start ? "…" : "") + markup + (end < source.length ? "…" : "");
  }

  function renderQueueTools() {
    if (!state.tasks.length) return "";
    const counts = {all:state.tasks.length,pending:0,active:0,review:0};
    for (const task of state.tasks) {
      const category = taskCategory(task);
      if (category in counts) counts[category]++;
    }
    const filters = [
      ["all","全部"],["pending","待发送"],["active","进行中"],["review","需核对"],
    ];
    return `<div class="cq-queue-tools" aria-label="查找与筛选队列">
      <div class="cq-filter-row" role="group" aria-label="按任务状态筛选">
        ${filters.map(([filter,label]) => `<button type="button" data-action="filter-tasks"
          id="cq-filter-${filter}"
          data-filter="${filter}" aria-pressed="${queueFilter === filter ? "true" : "false"}"
          class="cq-filter-chip${queueFilter === filter ? " cq-filter-selected" : ""}">
          ${label} <span>${counts[filter]}</span></button>`).join("")}
      </div>
      <div class="cq-queue-search-row">
        <label class="cq-search-field" for="cq-task-search">
          ${icon("search")}
          <input id="cq-task-search" type="search" autocomplete="off" spellcheck="false"
            maxlength="160" placeholder="搜索消息或图片名" aria-label="搜索队列任务"
            value="${escapeHtml(queueSearch)}">
        </label>
        <span class="cq-search-result" aria-live="polite">${queueResultText()}</span>
        <label class="cq-quick-jump" for="cq-jump-target">
          ${icon("focus")}
          <select id="cq-jump-target" aria-label="快速定位队列任务">
            <option value="">定位任务</option>
            <option value="active" ${queueNavigationTask("active") ? "" : "disabled"}>进行中</option>
            <option value="pending" ${queueNavigationTask("pending") ? "" : "disabled"}>首条待发</option>
            <option value="review" ${queueNavigationTask("review") ? "" : "disabled"}>需核对</option>
          </select>
        </label>
        <button type="button" class="cq-view-toggle" data-action="toggle-compact-view"
          aria-pressed="${state.compactView === true ? "true" : "false"}"
          aria-label="紧凑列表视图"
          title="${state.compactView ? "切换到舒适视图" : "切换到紧凑视图（当前对话独立保存）"}">
          ${state.compactView ? "舒适" : "紧凑"}
        </button>
      </div>
    </div>`;
  }

  function renderTasks() {
    const visible = filteredTasks();
    if (!state.tasks.length) return '<p class="cq-empty">队列为空 · 在 ChatGPT 输入框按 Enter，将文字或图片加入队列</p>';
    if (!visible.length) return `<div class="cq-filter-empty">
      <p>没有符合条件的队列任务</p>
      <button type="button" data-action="reset-task-filter">清除筛选条件</button>
    </div>`;
    const firstPendingId = state.tasks.find((task) => task.status === "pending")?.id;
    const canDrag = queueFilter === "all" && !queueSearch.trim();
    const tabStopId = visible.some((task) => task.id === focusedTaskId)
      ? focusedTaskId : visible[0].id;
    const pendingPositions = new Map(state.tasks
      .filter((task) => task.status === "pending")
      .map((task, index) => [task.id, index + 1]));
    return visible.map((task) => `
      <div class="cq-task cq-${task.status}${task.id === jumpTargetId ? " cq-jump-target" : ""}${task.status === "pending" && editingTask !== task.id && canDrag ? " cq-task-draggable" : ""}"
        data-task-id="${escapeHtml(task.id)}"
        role="listitem" tabindex="${task.id === tabStopId ? "0" : "-1"}"
        ${task.id === state.activeTaskId || task.id === state.steeringTaskId ? 'aria-current="step"' : ""}
        aria-label="${escapeHtml(
          (task.status === "pending"
            ? `待发送第 ${pendingPositions.get(task.id)} 条`
            : STATUS[task.status] || "队列任务") +
          `：${String(task.text || `仅有 ${task.images?.length || 0} 张图片`).replace(/\s+/g, " ").slice(0, 100)}` +
          (task.status === "pending" && canDrag ? "，按 Alt 加上下方向键调整顺序" : "")
        )}"
        ${task.status === "pending" && canDrag ? 'aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"' : ""}
        ${task.status === "pending" && editingTask !== task.id && canDrag ? 'draggable="true"' : ""}>
        <span class="cq-task-mark" title="${task.status === "pending" && canDrag ? "可拖动排序，也可聚焦任务后按 Alt+↑ / Alt+↓" : STATUS[task.status]}">
          ${taskCategory(task) === "review" ? icon("alert") :
            task.status === "pending" && canDrag ? icon("grip") : task.status === "waiting" ? icon("clock") : icon("list")}
        </span>
        <div class="cq-task-body">
          ${editingTask === task.id ? `
            <textarea id="cq-edit-task-input" rows="2" aria-label="编辑队列消息">${escapeHtml(editedTaskText)}</textarea>
            ${imagePicker("task", editedTaskKeptImages, editedTaskImages)}
            <div class="cq-inline-edit">
              <button type="button" data-action="cancel-edit-task">取消</button>
              <button type="button" data-action="save-task" class="cq-save"
                ${pendingUiActions.has(`save-task:${task.id}`) ? 'disabled aria-busy="true"' : ""}>保存</button>
            </div>
          ` : `
            <div class="cq-task-text${expandedTaskIds.has(task.id) ? " cq-task-text-expanded" : ""}" title="${escapeHtml(task.text || "仅图片任务")}">${task.text
              ? highlightedTaskSnippet(task.text, expandedTaskIds.has(task.id))
              : `<span class="cq-image-only">仅图片任务 · ${task.images?.length || 0} 张</span>`}</div>
            ${task.text?.length > 220 ? `<button type="button" class="cq-expand-task"
              data-action="toggle-task-text" data-id="${escapeHtml(task.id)}"
              aria-expanded="${expandedTaskIds.has(task.id) ? "true" : "false"}"
              title="${expandedTaskIds.has(task.id) ? "收起完整内容" : "展开查看完整内容"}">${expandedTaskIds.has(task.id) ? "收起内容" : "展开全文"}</button>` : ""}
            ${imagePreviews(task.images || [])}
            <span class="cq-task-meta">${task.status === "pending"
              ? `待发送 ${pendingPositions.get(task.id)}/${pendingPositions.size}`
              : task.status === "waiting" ? "等待语音按钮恢复" : STATUS[task.status]}${task.sourceScheduleId ? " · 自动入队" : ""}</span>
            ${taskCategory(task) === "review" && task.error ? `
              <button type="button" class="cq-expand-task cq-error-toggle"
                data-action="toggle-task-error" data-id="${escapeHtml(task.id)}"
                aria-expanded="${expandedErrorIds.has(task.id) ? "true" : "false"}">
                ${expandedErrorIds.has(task.id) ? "收起原因" : "查看原因"}
              </button>
              ${expandedErrorIds.has(task.id) ||
                  (queueSearch.trim() && String(task.error).toLocaleLowerCase()
                    .includes(queueSearch.trim().toLocaleLowerCase())) ?
                `<span class="cq-task-error-detail">${highlightedTaskSnippet(task.error, true)}</span>` : ""}
            ` : ""}
          `}
        </div>
        ${editingTask === task.id ? "" : `<div class="cq-item-actions">
          <button type="button" class="cq-favorite-task${favoriteForTask(task) ? " cq-is-favorite" : ""}"
            data-action="favorite-task" data-id="${escapeHtml(task.id)}"
            ${favoriteBusy ? 'disabled aria-busy="true"' : ""}
            title="${favoriteForTask(task) ? "取消收藏此图文任务" : "收藏此图文任务，其他对话也能复用"}"
            aria-label="${favoriteForTask(task) ? "取消收藏任务" : "收藏任务"}"
            aria-pressed="${favoriteForTask(task) ? "true" : "false"}">${favoriteForTask(task) ? "★" : "☆"}</button>
          ${task.status === "pending" && !task.images?.length ? `
            <button type="button" class="cq-steer-action" data-action="steer-task" data-id="${task.id}" title="立即发送这条消息，不等待前面的队列">${icon("steer")}<span>引导</span></button>
            ` : ""}
          ${task.status === "pending" ? `
            <button type="button" class="cq-pin-action" data-action="pin-task" data-id="${task.id}"
              title="${task.id === firstPendingId ? "已在待发送队首" : "置顶：移至待发送队首"}"
              ${task.id === firstPendingId || pendingUiActions.has(`pin-task:${task.id}`) ? "disabled" : ""}
              ${pendingUiActions.has(`pin-task:${task.id}`) ? 'aria-busy="true"' : ""}>${icon("pin")}<span>置顶</span></button>
            <button type="button" data-action="edit-task" data-id="${task.id}" title="编辑">${icon("edit")}</button>` : ""}
          ${!["waiting", "dispatching", "steering", "steering_wait"].includes(task.status) ? `<button type="button" data-action="delete-task" data-id="${task.id}"
            title="删除（需确认）" aria-label="删除此队列任务（需要确认）"
            ${pendingUiActions.has(`delete-task:${task.id}`) ? 'disabled aria-busy="true"' : ""}>${icon("trash")}</button>` : ""}
        </div>`}
      </div>
    `).join("");
  }

  function favoriteMatchesSearch(favorite) {
    const query = favoriteSearch.trim().toLocaleLowerCase();
    const category = typeof favorite.category === "string" ? favorite.category : "";
    return (!favoritePinnedOnly || favorite.pinned === true) &&
      (!favoriteCategoryFilter || (favoriteCategoryFilter === "__none__"
        ? !category : category === favoriteCategoryFilter.slice(4))) &&
      (!query || [favorite.title, favorite.text,category,
        ...(favorite.images || []).map((image) => image.name)]
        .some((value) => String(value || "").toLocaleLowerCase().includes(query)));
  }

  function favoriteCategories() {
    return [...new Set(favoriteItems
      .map((favorite) => typeof favorite.category === "string" ? favorite.category : "")
      .filter(Boolean))].sort((a,b) => a.localeCompare(b,"zh-CN"));
  }

  function orderedFavorites() {
    return favoriteItems.filter(favoriteMatchesSearch).sort((a,b) =>
      Number(b.pinned === true) - Number(a.pinned === true) ||
      (Number(b.lastUsedAt) || 0) - (Number(a.lastUsedAt) || 0) ||
      (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0));
  }

  // Keep this parser aligned with background.js. Actual substitution is
  // repeated and validated in the serialized worker, never trusted to UI.
  const favoritePlaceholderPattern = /\\?\{\{([^{}\r\n]*)\}\}/g;
  const favoriteFieldNamePattern = /^[\p{L}\p{N}_][\p{L}\p{N}_ -]{0,31}$/u;

  function favoriteTemplateFields(text) {
    const names = [];
    for (const token of String(text).matchAll(favoritePlaceholderPattern)) {
      if (token[0].startsWith("\\")) continue;
      const name = token[1].trim();
      if (!favoriteFieldNamePattern.test(name)) {
        return {names:[],error:"变量名仅支持中英文、数字、空格、下划线和短横线，最多 32 字"};
      }
      if (!names.includes(name)) names.push(name);
      if (names.length > 12) return {names:[],error:"每条收藏最多使用 12 个不同变量"};
    }
    return {names,error:""};
  }

  function favoriteTemplatePreview(item) {
    const draft = favoriteTemplateDraft;
    const parsed = favoriteTemplateFields(item.text);
    if (parsed.error) return {text:item.text,ready:false,status:parsed.error};
    if (!draft || draft.id !== item.id || draft.sourceText !== item.text) {
      return {text:item.text,ready:false,status:"模板已更新，请取消并重新填写变量"};
    }
    const missing = parsed.names.filter((name) =>
      typeof draft.values[name] !== "string" || !draft.values[name].trim());
    const expanded = item.text.replace(favoritePlaceholderPattern,(whole,name) =>
      whole.startsWith("\\") ? whole.slice(1) :
        (missing.includes(name.trim()) ? `《待填：${name.trim()}》` : draft.values[name.trim()]));
    const tooLong = expanded.length > 12000;
    const status = tooLong
      ? `预览长度 ${expanded.length}/12000，超过单条队列长度限制`
      : missing.length ? `还需填写：${missing.join("、")}`
        : `已填写全部 ${parsed.names.length} 个变量 · ${expanded.length}/12000 字符`;
    return {text:expanded,ready:!missing.length && !tooLong &&
      (Boolean(expanded.trim()) || Boolean(item.images?.length)),status};
  }

  function renderFavoriteTemplateForm(item, fields) {
    const draft = favoriteTemplateDraft;
    const preview = favoriteTemplatePreview(item);
    return `<div class="cq-template-compose" data-template-id="${escapeHtml(item.id)}"
      aria-label="填写收藏模板变量">
      <div class="cq-template-heading">填写变量 <span>${fields.length} 项 · 仅本次使用，不修改收藏</span></div>
      ${fields.map((name,index) => `<label class="cq-template-field"
        for="cq-template-value-${index}">${escapeHtml(name)}
        <textarea id="cq-template-value-${index}" data-template-index="${index}"
          rows="2" maxlength="3000" placeholder="填写 ${escapeHtml(name)}（最多 3000 字）"
          spellcheck="false">${escapeHtml(draft?.values[name] || "")}</textarea>
      </label>`).join("")}
      <div class="cq-template-heading cq-template-preview-label">入队内容预览</div>
      <pre class="cq-template-preview">${escapeHtml(preview.text)}</pre>
      <p class="cq-template-status" role="status">${escapeHtml(preview.status)}</p>
      <div class="cq-template-actions">
        <button type="button" data-action="cancel-favorite-template"
          data-id="${escapeHtml(item.id)}">取消</button>
        <button type="button" class="cq-save cq-template-confirm"
          data-action="confirm-favorite-template" data-id="${escapeHtml(item.id)}"
          ${!preview.ready || favoriteBusy ? "disabled" : ""}>确认加入队列</button>
      </div>
    </div>`;
  }

  function updateFavoriteTemplatePreview() {
    const draft = favoriteTemplateDraft;
    if (!draft) return;
    const item = favoriteItems.find((favorite) => favorite.id === draft.id);
    const form = root.querySelector(".cq-template-compose");
    if (!form || !item) return;
    const preview = favoriteTemplatePreview(item);
    const text = form.querySelector(".cq-template-preview");
    const status = form.querySelector(".cq-template-status");
    const confirm = form.querySelector('[data-action="confirm-favorite-template"]');
    if (text) text.textContent = preview.text;
    if (status) status.textContent = preview.status;
    if (confirm) confirm.disabled = !preview.ready || favoriteBusy;
    syncUnsavedDraftIndicators();
  }

  function renderFavoriteResults() {
    const items = orderedFavorites();
    if (!items.length) return `<p class="cq-favorite-empty">${favoriteItems.length
      ? "没有匹配的收藏，换个关键词试试" : "还没有收藏。在队列任务旁点击 ☆，或者收藏当前输入框里的提示词。"}</p>`;
    return items.map((favorite) => {
      const template = favorite.templateEnabled === true
        ? favoriteTemplateFields(favorite.text) : {names:[],error:""};
      const editingTemplate = favoriteTemplateDraft?.id === favorite.id;
      return `<article class="cq-favorite-row" data-favorite-id="${escapeHtml(favorite.id)}">
      <div class="cq-favorite-body">
        <strong title="${escapeHtml(favorite.title)}">${favorite.pinned === true ? '<span class="cq-pinned-mark" aria-label="已置顶">★</span> ' : ""}${escapeHtml(favorite.title)}</strong>
        <div class="cq-favorite-excerpt">${escapeHtml(favorite.text.slice(0, 180) || "仅图片任务")}${favorite.text.length > 180 ? "…" : ""}</div>
        <div class="cq-favorite-meta" title="仅统计升级后从收藏夹成功入队的次数">${escapeHtml(favorite.category || "未分类")} · 已复用 ${Math.max(0,Number(favorite.useCount)||0)} 次${template.names.length ? ` · ${template.names.length} 个变量` : ""}${template.error ? " · 变量格式需检查" : ""}</div>
        ${imagePreviews(favorite.images || [])}
        ${editingTemplate ? renderFavoriteTemplateForm(favorite,template.names) : ""}
      </div>
      <div class="cq-favorite-actions">
        <button type="button" data-action="enqueue-favorite" data-id="${escapeHtml(favorite.id)}"
          class="cq-favorite-queue" ${favoriteBusy ? "disabled" : ""}
          title="${template.names.length ? "填写变量后预览并入队" : "加入当前对话队列，按原有队列规则发送"}">${icon("plus")} ${template.names.length ? "填写入队" : "入队"}</button>
        <button type="button" data-action="pin-favorite" data-id="${escapeHtml(favorite.id)}"
          class="${favorite.pinned === true ? "cq-is-pinned" : ""}"
          aria-pressed="${favorite.pinned === true}" aria-label="${favorite.pinned === true ? "取消置顶" : "置顶"}${escapeHtml(favorite.title)}"
          ${favoriteBusy ? "disabled" : ""} title="收藏夹置顶，和任务置顶无关">${favorite.pinned === true ? "★" : "☆"}</button>
        <button type="button" data-action="rename-favorite" data-id="${escapeHtml(favorite.id)}"
          ${favoriteBusy ? "disabled" : ""} title="重命名收藏" aria-label="重命名 ${escapeHtml(favorite.title)}">${icon("edit")}</button>
        <button type="button" data-action="delete-favorite" data-id="${escapeHtml(favorite.id)}"
          ${favoriteBusy ? "disabled" : ""} title="删除收藏" aria-label="删除 ${escapeHtml(favorite.title)}">${icon("trash")}</button>
      </div>
    </article>`;
    }).join("");
  }

  function renderFavorites() {
    if (favoriteCategoryFilter && favoriteCategoryFilter !== "__none__" &&
        !favoriteCategories().includes(favoriteCategoryFilter.slice(4))) favoriteCategoryFilter = "";
    return `<div class="cq-scheduler cq-favorites" aria-label="提示词收藏夹">
      <div class="cq-section-title">提示词收藏夹 <span>跨对话通用 · ${favoriteItems.length}/100 条 · 仅保存在本地</span></div>
      <div class="cq-favorite-tools">
        <label class="cq-search-field" for="cq-favorite-search">${icon("search")}
          <input type="search" id="cq-favorite-search" value="${escapeHtml(favoriteSearch)}"
            maxlength="160" placeholder="搜索收藏名称或内容" autocomplete="off" spellcheck="false">
        </label>
        <button type="button" data-action="save-current-favorite" ${favoriteBusy ? "disabled" : ""}
          title="将 ChatGPT 输入框中的文字存为收藏；图文任务可在入队后点 ☆ 收藏">${icon("star")} 收藏输入</button>
      </div>
      <div class="cq-favorite-filters">
        <label for="cq-favorite-category">分类
          <select id="cq-favorite-category" aria-label="按收藏分类筛选">
            <option value="" ${!favoriteCategoryFilter ? "selected" : ""}>全部分类</option>
            <option value="__none__" ${favoriteCategoryFilter === "__none__" ? "selected" : ""}>未分类</option>
            ${favoriteCategories().map((category) => `<option value="cat:${escapeHtml(category)}"
              ${favoriteCategoryFilter === "cat:" + category ? "selected" : ""}>${escapeHtml(category)}</option>`).join("")}
          </select>
        </label>
        <button type="button" data-action="favorites-pinned-only" aria-pressed="${favoritePinnedOnly}">
          ${favoritePinnedOnly ? "★ 显示全部" : "☆ 仅置顶"}
        </button>
        <span>${orderedFavorites().length} / ${favoriteItems.length} 条</span>
      </div>
      <div class="cq-favorite-results">${renderFavoriteResults()}</div>
      <p class="cq-favorite-hint">只添加为普通待发送任务；如果当前队列空闲且未暂停，可能很快自动接力发送。图文原件保存在本地。</p>
    </div>`;
  }

  function imagePreviews(images, kind = null) {
    if (!images.length) return "";
    return `<div class="cq-images">${images.map((image, index) => `
      <div class="cq-image" title="${escapeHtml(image.name)}">
        <img alt="${escapeHtml(image.name)}" draggable="false" src="${escapeHtml(image.thumbnail)}">
        ${kind ? `<button type="button" data-action="remove-image" data-kind="${kind}"
          data-index="${index}" aria-label="移除图片 ${escapeHtml(image.name)}">${icon("close")}</button>` : ""}
      </div>`).join("")}</div>`;
  }

  function imagePicker(kind, kept, fresh) {
    const all = [...kept, ...fresh];
    return `<div class="cq-image-zone" data-image-zone="${kind}">
      ${imagePreviews(all, kind)}
      <label class="cq-image-add" for="cq-${kind}-images" role="button" tabindex="0"
        aria-label="添加图片，当前 ${all.length} 张，最多 4 张">${icon("image")} 添加图片
        <input id="cq-${kind}-images" type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple>
      </label>
      <span class="cq-image-hint">可粘贴或拖入图片，每条最多 4 张，每张不超过 8 MB</span>
    </div>`;
  }

  // Original bytes remain in memory only while editing; persisted tasks keep
  // their full images in the background IndexedDB, not the queue state.
  async function readImageFile(file) {
    if (!["image/png", "image/jpeg", "image/webp", "image/gif"].includes(file.type)) {
      throw new Error("仅支持 PNG、JPEG、WebP 和 GIF 图片");
    }
    if (!file.size || file.size > 8 * 1024 * 1024) throw new Error("每张图片必须小于 8 MB");
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error("读取图片失败"));
      reader.readAsDataURL(file);
    });
    const thumbnail = await new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => {
        const size = 100;
        const scale = Math.min(1, size / Math.max(image.naturalWidth, image.naturalHeight));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
        canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
        const ctx = canvas.getContext("2d");
        if (!ctx) { reject(new Error("无法生成图片预览")); return; }
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL("image/jpeg", 0.65));
      };
      image.onerror = () => reject(new Error("图片损坏或浏览器无法读取"));
      image.src = dataUrl;
    });
    return { name: file.name || "图片", type: file.type, dataUrl, thumbnail };
  }

  function draftImages(kind) {
    if (kind === "queue") return { kept: [], fresh: queueImages };
    if (kind === "schedule") return { kept: scheduleKeptImages, fresh: scheduleImages };
    if (kind === "task") return { kept: editedTaskKeptImages, fresh: editedTaskImages };
    throw new Error("未知图片编辑区域");
  }

  async function addDraftImages(kind, files) {
    if (imageSelectionInProgress) throw new Error("图片正在处理中，请稍后");
    const list = [...files];
    if (!list.length) return;
    if (list.some((file) => !["image/png","image/jpeg","image/webp","image/gif"].includes(file.type))) {
      throw new Error("仅支持 PNG、JPEG、WebP、GIF 图片");
    }
    const draft = draftImages(kind);
    if (draft.kept.length + draft.fresh.length + list.length > 4) {
      throw new Error("每条任务最多保存 4 张图片");
    }
    imageSelectionInProgress = true;
    try {
      const images = await Promise.all(list.map(readImageFile));
      draft.fresh.push(...images);
      if (kind === "queue") { queueSubmissionId = null; queueDraftRevision++; }
      if (kind === "schedule") {
        scheduleSubmissionId = null; scheduleDraftRevision++; scheduleDraftDirty = true;
      }
      render();
    } finally {
      imageSelectionInProgress = false;
    }
  }

  function removeDraftImage(kind, index) {
    const draft = draftImages(kind);
    if (index < draft.kept.length) draft.kept.splice(index, 1);
    else draft.fresh.splice(index - draft.kept.length, 1);
    if (kind === "queue") { queueSubmissionId = null; queueDraftRevision++; }
    if (kind === "schedule") {
      scheduleSubmissionId = null; scheduleDraftRevision++; scheduleDraftDirty = true;
    }
    render();
  }

  function visibleSchedules() {
    const term = scheduleSearch.trim().toLocaleLowerCase();
    const selected = state.schedules.map((item, index) => ({item, index}))
      .filter(({item}) =>
        (scheduleFilter === "all" ||
          (scheduleFilter === "enabled" ? item.enabled : !item.enabled)) &&
        (scheduleKind === "all" || (item.mode === "count" ? "count" : "time") === scheduleKind) &&
        (!term || [item.text, ...(item.images || []).map((image) => image.name)]
          .some((value) => String(value || "").toLocaleLowerCase().includes(term))));
    if (scheduleOrder === "next") {
      // Visual sorting only. Never mutate state.schedules: the scheduler
      // relies on stable creation order and its own persisted fair cursors.
      selected.sort((a, b) => {
        const rank = (item) => !item.enabled ? 2 : item.mode === "count" ? 1 : 0;
        const rankDifference = rank(a.item) - rank(b.item);
        if (rankDifference) return rankDifference;
        const when = (item) => item.enabled && item.mode !== "count" &&
          Number.isFinite(item.nextRunAt) ? item.nextRunAt : Infinity;
        return when(a.item) - when(b.item) || a.index - b.index;
      });
    }
    return selected.map(({item}) => item);
  }

  function renderScheduleSearchText(value, expanded = false) {
    const text = String(value || "");
    const term = scheduleSearch.trim();
    if (!term) return expanded ? escapeHtml(text) : excerpt(text);
    const match = text.toLocaleLowerCase().indexOf(term.toLocaleLowerCase());
    const start = !expanded && match > 90 ? Math.max(0, match - 36) : 0;
    const displayed = expanded ? text : text.slice(start, start + 160);
    const pos = displayed.toLocaleLowerCase().indexOf(term.toLocaleLowerCase());
    const highlighted = pos < 0 ? escapeHtml(displayed) :
      escapeHtml(displayed.slice(0, pos)) +
      `<mark>${escapeHtml(displayed.slice(pos, pos + term.length))}</mark>` +
      escapeHtml(displayed.slice(pos + term.length));
    return (start ? "…" : "") + highlighted +
      (start + displayed.length < text.length ? "…" : "");
  }

  function renderScheduleControls() {
    if (!state.schedules.length) return "";
    const enabled = state.schedules.filter((item) => item.enabled).length;
    return `<div class="cq-rule-tools" aria-label="查找与筛选自动任务">
      <div class="cq-rule-status-filters" role="group" aria-label="按启停状态筛选自动任务">
        ${[
          ["all","全部",state.schedules.length],
          ["enabled","运行中",enabled],
          ["disabled","已停用",state.schedules.length - enabled],
        ].map(([key,label,count]) => `<button type="button" data-action="filter-schedules"
          data-filter="${key}" aria-pressed="${scheduleFilter === key ? "true" : "false"}"
          class="cq-filter-chip${scheduleFilter === key ? " cq-filter-selected" : ""}">
          ${label} <span>${count}</span></button>`).join("")}
      </div>
      <div class="cq-rule-search-row">
        <label class="cq-search-field" for="cq-rule-search">
          ${icon("search")}
          <input id="cq-rule-search" type="search" autocomplete="off" spellcheck="false"
            maxlength="160" placeholder="搜索规则或图片名" aria-label="搜索自动任务"
            value="${escapeHtml(scheduleSearch)}">
        </label>
        <label class="cq-rule-select-label" for="cq-rule-kind">类型
          <select id="cq-rule-kind" aria-label="按自动任务触发类型筛选">
            <option value="all" ${scheduleKind === "all" ? "selected" : ""}>全部类型</option>
            <option value="time" ${scheduleKind === "time" ? "selected" : ""}>按时间</option>
            <option value="count" ${scheduleKind === "count" ? "selected" : ""}>按数量</option>
          </select>
        </label>
        <label class="cq-rule-select-label" for="cq-rule-sort">排序
          <select id="cq-rule-sort" aria-label="自动任务列表排序方式">
            <option value="original" ${scheduleOrder === "original" ? "selected" : ""}>原列表顺序</option>
            <option value="next" ${scheduleOrder === "next" ? "selected" : ""}>下次到期优先</option>
          </select>
        </label>
      </div>
      <div class="cq-rule-tools-footer">
        <span class="cq-rule-result-count" aria-live="polite">${scheduleResultText()}</span>
        ${scheduleFilter !== "all" || scheduleKind !== "all" ||
          scheduleOrder !== "original" || scheduleSearch.trim() ?
          '<button type="button" data-action="reset-schedule-filters">清除筛选</button>' : ""}
      </div>
    </div>`;
  }

  function scheduleResultText() {
    return `显示 ${visibleSchedules().length}/${state.schedules.length} 条 · 只调整显示顺序`;
  }

  function updateScheduleSearchResults() {
    const list = root.querySelector(".cq-schedule-results");
    if (!list || scheduleSearchComposing || !schedulerOpen || schedulerView !== "list") return;
    list.innerHTML = renderSchedules();
    list.scrollTop = 0;
    const counter = root.querySelector(".cq-rule-result-count");
    if (counter) counter.textContent = scheduleResultText();
  }

  function renderSchedules() {
    if (!state.schedules.length) return '<p class="cq-empty">还没有自动入队任务</p>';
    const pending = queueCount();
    const queueFull = pending >= settings.maxPending;
    const throttled = countRateStatus().nextAvailableAt !== null;
    const matches = visibleSchedules();
    if (!matches.length) return `<div class="cq-filter-empty">
      <p>没有符合条件的自动任务</p>
      <button type="button" data-action="reset-schedule-filters">清除筛选条件</button>
    </div>`;
    return matches.map((item) => `
      <div class="cq-task cq-schedule-item${item.enabled ? " cq-rule-enabled" : " cq-rule-disabled"}"
        data-schedule-id="${escapeHtml(item.id)}">
        <span class="cq-task-mark">${icon(item.mode === "count" ? "list" : "clock")}</span>
        <div class="cq-task-body">
          <span class="cq-task-text">${renderScheduleSearchText(item.text, expandedScheduleIds.has(item.id))}</span>
          ${item.text.length > 160 ? `<button type="button" class="cq-expand-task"
            data-action="toggle-schedule-text" data-id="${escapeHtml(item.id)}"
            aria-expanded="${expandedScheduleIds.has(item.id) ? "true" : "false"}">
            ${expandedScheduleIds.has(item.id) ? "收起全文" : "展开全文"}</button>` : ""}
          <span class="cq-rule-state ${item.enabled ? "cq-rule-state-on" : "cq-rule-state-off"}">${item.enabled ? "运行中" : "已停用"} · ${item.mode === "count" ? "按数量" : "按时间"}</span>
          ${imagePreviews(item.images || [])}
          <span class="cq-task-meta">${scheduleRepeatDescription(item)}</span>
          <span class="cq-task-meta">${item.enabled
            ? item.mode === "count"
              ? (queueFull ? "队列已满 · 等待空位" : pending < item.threshold && throttled
                  ? "已达本对话补队限额 · 等待名额恢复" : pending < item.threshold
                  ? `队列 ${pending}/${item.threshold} · 即将补入`
                  : `队列 ${pending} 条 · 少于 ${item.threshold} 条时补入`)
              : (clock() >= item.nextRunAt
                ? queueFull ? "队列已满 · 等待空位入队" : "已到期 · 即将入队"
                : `每 ${item.intervalMinutes} 分钟 · 下次入队 ${countdownMarkup(item.nextRunAt)}`)
            : "自动入队已停止"}</span>
        </div>
        <div class="cq-item-actions">
          <button type="button" data-action="toggle-schedule" data-id="${escapeHtml(item.id)}"
            title="${item.enabled ? '停用自动任务' : '启用自动任务'}" aria-label="${item.enabled ? '停用' : '启用'}此自动任务"
            ${pendingUiActions.has(`toggle-schedule:${item.id}`) ? 'disabled aria-busy="true"' : ""}>${icon(item.enabled ? "pause" : "play")}</button>
          <button type="button" data-action="edit-schedule" data-id="${escapeHtml(item.id)}" title="编辑" aria-label="编辑此自动任务">${icon("edit")}</button>
          <button type="button" data-action="delete-schedule" data-id="${escapeHtml(item.id)}" title="删除（需确认）" aria-label="删除此自动任务（需要确认）"
            ${pendingUiActions.has(`delete-schedule:${item.id}`) ? 'disabled aria-busy="true"' : ""}>${icon("trash")}</button>
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

  function renderHistory() {
    const labels = {
      manual_enqueue: "手动入队", auto_count: "数量规则补队", auto_time: "定时规则入队",
      claim: "领取待发送任务", sent: "已点击发送", finished: "回复完成，任务出队",
      deferred: "发送条件未就绪，安全回队列", send_failed: "发送失败，等待检查",
      timeout: "等待超时", steer_timeout: "引导确认超时",
      task_edited: "修改待办", task_deleted: "删除待办",
      task_pinned: "任务置顶", task_reordered: "调整顺序",
      steer_claim: "锁定引导任务", steer_clicked: "已尝试引导发送",
      steer_cancel: "取消引导", steer_confirm: "引导确认完成",
      steer_uncertain: "引导结果未确认",
      state_inconsistent: "检测到不一致状态，等待人工核对",
      tab_revived: "恢复被浏览器丢弃的标签",
      tab_reopened: "后台重新打开对话标签",
      tab_owner_rebound: "接力已转交正常对话标签",
      tab_reopen_failed: "自动恢复标签失败，将稍后重试",
      user_stopped: "用户停止生成", user_resumed: "用户恢复对话",
      auto_recovered: "自动解除技术暂停", failed_skipped: "人工跳过失败任务",
      review_confirmed: "人工确认后继续",
      schedule_added: "创建自动规则", schedule_edited: "编辑自动规则",
      schedule_deleted: "删除自动规则", schedule_toggled: "切换规则启停",
      queue_paused: "暂停自动发送", queue_resumed: "继续自动发送",
      rate_limit_updated: "修改本对话补队限速",
      send_cooldown_updated: "修改本对话发送冷却",
      handoff_due: "定时上下文接力到期",
      handoff_manual: "手动启动上下文接力",
      handoff_setting: "修改接力间隔或开关",
      handoff_summary: "已保存本轮交接总结",
      handoff_new_chat: "已进入项目新对话入口",
      handoff_completed: "旧队列已成功迁移",
      handoff_received: "新对话已接收任务和规则",
      handoff_failed: "交接失败，保留旧队列",
      handoff_cancelled: "取消交接",
      backup_restored: "从备份恢复并暂停",
    };
    const entries = Array.isArray(state.history) ? state.history.slice(-30).reverse() : [];
    if (!entries.length) return '<p class="cq-repeat-hint">暂无运行日志。后续队列操作会自动记录。</p>';
    return `<div class="cq-history-list" aria-label="当前对话最近运行日志">${entries.map((entry) => `
      <div class="cq-history-entry">
        <time>${Number.isFinite(entry.at) ? escapeHtml(localDate(entry.at)) : "未知时间"}</time>
        <span>${escapeHtml(labels[entry.type] || "队列事件")}</span>
        ${entry.taskId ? `<code title="${escapeHtml(entry.taskId)}">#${escapeHtml(entry.taskId.slice(0, 8))}</code>` : ""}
      </div>`).join("")}</div>`;
  }

  function render() {
    if (!state) return;
    syncUnsavedDraftIndicators();
    // Rebuilding the row DOM during a native drag would cancel the gesture.
    if (draggingTaskId || queueResize) return;
    if (searchComposing) {
      searchRenderPending = true;
      return;
    }
    if (scheduleSearchComposing) {
      scheduleRenderPending = true;
      return;
    }
    if (favoriteSearchComposing) {
      favoriteSearchRenderPending = true;
      return;
    }
    if (favoriteTemplateComposing) {
      favoriteTemplateRenderPending = true;
      return;
    }
    if (!mountNearComposer()) return;
    root.classList.toggle("cq-compact-view", state.compactView === true);
    const previousListScroll = root.querySelector(".cq-list")?.scrollTop || 0;
    const previousScheduleScroll = root.querySelector(".cq-schedule-results")?.scrollTop || 0;
    const pending = queueCount();
    const active = state.tasks.find((item) => item.id === state.activeTaskId);
    const cooldownAt = sendCooldownUntil();
    const waitingToDispatch = state.tasks.some((item) => item.status === "pending");
    const needsReview = state.halted && state.haltReason !== "user";
    const autoRecovering = needsReview &&
      ["failure", "timeout", "uncertain", "steer_unconfirmed"].includes(state.haltReason);
    const recoverable = needsReview && state.tasks.find((task) => task.status === "error");
    const nearestSchedule = state.schedules.filter((schedule) => schedule.enabled && schedule.mode !== "count")
      .sort((a, b) => a.nextRunAt - b.nextRunAt)[0];
    const countSchedule = state.schedules.find((schedule) => schedule.enabled && schedule.mode === "count");
    const rate = countRateStatus();
    const handoff = state.handoff || {enabled:false,intervalMinutes:120,phase:"idle"};
    const handoffRunning = !["idle","completed"].includes(handoff.phase);
    const handoffCancelling = handoff.cancelRequested === true;
    const projectChat = /^\/g\/g-p-[a-zA-Z0-9-]+\/c\/[a-zA-Z0-9-]+\/?$/
      .test(new URL(location.href).pathname);
    const canHandoffNow = projectChat &&
      !state.halted && !state.queuePaused && !state.handoffSourceKey && !handoffRunning;
    const canCancelHandoff = projectChat && handoffRunning &&
      !state.handoffSourceKey && !handoffCancelling;
    const handoffButtonHint = handoffCancelling ? "已请求取消：等待当前总结安全结束，不会跳转新对话" :
      handoffRunning ? (state.handoffSourceKey
        ? "接力正在新对话中进行，若有异常请回到原对话核对"
        : handoff.phase === "summarizing"
          ? "再次点击取消接力：已发送的总结会自然结束，但不再自动跳转"
          : "再次点击取消接力，原有队列和规则保留") :
      !projectChat ? "请先打开 ChatGPT 原生项目内的已有对话" :
      state.halted || state.queuePaused ? "队列已暂停，请先恢复自动发送" :
      "手动总结当前对话并在同项目新对话继续；无需待发送任务，也不必开启定时";
    const handoffLabels = {
      due:"已到期 · 等待当前任务结束", summarizing:"正在生成交接总结",
      opening:"总结已保存 · 准备进入新对话",
      navigating:"正在进入原生项目的新对话", bootstrapping:"等待新对话确认接收",
      failed:"交接失败 · 旧队列已保留", completed:"已接力到新对话",
    };
    const backgroundWork = pending > 0 || handoffRunning ||
      state.schedules.some((schedule) => schedule.enabled);
    const activeElement = root.contains(document.activeElement) ? document.activeElement : null;
    const activeId = activeElement?.id;
    const focusedTaskRowId = activeElement?.matches?.(".cq-list .cq-task[data-task-id]")
      ? activeElement.dataset.taskId : null;
    const focusedButton = activeElement?.matches?.("button[data-action]") ?
      { action:activeElement.dataset.action, id:activeElement.dataset.id || "",
        filter:activeElement.dataset.filter || "",
        page:activeElement.dataset.page || "" } : null;
    const caret = activeElement && typeof activeElement.selectionStart === "number" ? activeElement.selectionStart : null;

    root.innerHTML = `
      <section class="cq-inline" aria-label="ChatGPT 对话任务队列">
        <div class="cq-toolbar">
          <div class="cq-queue-label">
            ${icon("list")} <strong>Queue</strong> <span>${pending}</span>
          </div>
          ${active ? `<span class="cq-status cq-status-active">${icon("clock")} ${STATUS[active.status]}</span>` :
            state.halted ? `<span class="cq-status">${state.haltReason === "user" ? "用户已暂停" : "等待核对"}</span>` : ''}
          ${state.queuePaused ? `<span class="cq-status cq-status-paused" title="只暂停领取下一条，当前正在运行的任务不会被强行中断">自动发送已暂停</span>` : ""}
          ${state.handoffSourceKey ? `<span class="cq-status cq-status-active" title="旧队列会在当前对话确认接收总结后一次性迁移">接收交接中</span>` : ""}
          ${handoffRunning ? `<span class="cq-status ${handoff.phase === "failed" ? "" : "cq-status-active"}"
            title="${escapeHtml(handoff.error || handoffLabels[handoff.phase] || "接力正在进行")}">
            ${handoffCancelling ? "接力取消中" :
              handoff.phase === "failed" ? "接力失败" : handoff.phase === "due" ? "接力待总结" :
              handoff.phase === "summarizing" ? "接力总结中" : "接力切换中"}</span>` : ""}
          ${cooldownAt && waitingToDispatch && !active && !state.halted &&
             !state.queuePaused && !state.steeringTaskId
            ? `<span class="cq-status cq-cooldown-status" data-cooldown-until="${cooldownAt}"
                title="上一条任务结束后的等待时间；只限制下一条自动发送">
                ${icon("clock")}下条发送冷却 ${countdownMarkup(cooldownAt)}</span>` : ""}
          <span class="cq-status cq-compose-wait" hidden>等待清空输入框</span>
          <span class="cq-status cq-voice-wait" hidden>等待语音按钮</span>
          ${settings.protectBackground !== false && backgroundWork
            ? `<span class="cq-status cq-background-protection" title="已启用防自动丢弃保护；不能保证阻止浏览器休眠或冻结">${icon("shield")} 防丢弃</span>`
            : ""}
          <div class="cq-toolbar-spacer"></div>
          ${nearestSchedule ? `<span class="cq-next-run" title="下次生成一条队列待办（不代表立即发送）">${icon("clock")}
            ${clock() >= nearestSchedule.nextRunAt
              ? pending >= settings.maxPending ? "已到期 · 队列已满" : "已到期 · 待入队"
              : countdownMarkup(nearestSchedule.nextRunAt)}</span>` : ""}
          ${!nearestSchedule && countSchedule ? `<span class="cq-next-run" title="队列数量低于阈值时自动补入">${icon("list")} 补队 ${pending}/${countSchedule.threshold}</span>` : ""}
          ${EXTENSION_VERSION ? `<span class="cq-version-badge" title="ChatGPT 自动对话队列 v${escapeHtml(EXTENSION_VERSION)}"
            aria-label="插件版本 ${escapeHtml(EXTENSION_VERSION)}">v${escapeHtml(EXTENSION_VERSION)}</span>` : ""}
        </div>
        ${queueExpanded ? `
          ${needsReview || notification ? `<div class="cq-notice" role="status">
            <span>${needsReview
              ? state.haltReason === "state_inconsistent"
                ? "检测到异常中断的发送状态，可能已有消息发出。请先核对对话，逐条跳过不确定任务；不会自动重发。"
                : autoRecovering ? "上轮发生技术错误，语音按钮恢复后将自动跳过并继续。" : "队列已暂停，等待人工确认。"
              : escapeHtml(notification)}</span>
            ${recoverable ? `<button type="button" data-action="skip-failed" data-id="${recoverable.id}" title="人工核对后跳过，不会重发">核对后跳过</button>` :
              needsReview && !state.activeTaskId ? `<button type="button" data-action="ack-recovery" title="确认上一条已经处理或无需重发后恢复">核对后继续</button>` : ""}
          </div>` : ''}
          ${handoff.phase === "failed" ? `<div class="cq-notice cq-handoff-failed-notice" role="alert">
            <span>接力未完成：${escapeHtml(handoff.error || "请核对原对话后取消本次接力")}
              · 旧队列与规则没有迁移</span>
            <button type="button" data-action="cancel-handoff" title="人工核对后取消失败的接力，保留原队列">取消本次接力</button>
          </div>` : ""}
          ${renderQueueTools()}
          <div class="cq-list${settings.queueListHeight !== null ? " cq-list-custom" : ""}"
            role="list" aria-label="当前对话的队列任务"
            ${settings.queueListHeight !== null ? `style="--cq-list-height:${clampQueueHeight(settings.queueListHeight)}px"` : ""}>
            ${renderTasks()}
          </div>
          <div class="cq-resize-handle" role="separator" tabindex="0"
            aria-label="队列列表高度，上下拖动调整；方向键微调；双击恢复自动"
            aria-orientation="horizontal" aria-valuemin="72"
            aria-valuemax="${queueHeightLimit()}" aria-valuenow="${settings.queueListHeight ?? 260}"
            title="上下拖动调整队列高度 · 双击恢复自动高度">
            <span class="cq-resize-grip" aria-hidden="true"></span>
            <span aria-hidden="true">拖动调整高度 · 双击还原</span>
          </div>
          ${legacyUnboundCount ? `<div class="cq-footer-actions">
            <span>发现 ${legacyUnboundCount} 项旧版未绑定内容</span>
            <button type="button" data-action="import-legacy">导入到本对话</button>
          </div>` : ''}
          ${queueComposerOpen ? `<div class="cq-scheduler cq-queue-create">
            <div class="cq-section-title">新建图文队列任务 <span>图片保存在本地，轮到任务时随消息发送</span></div>
            <textarea id="cq-queue-draft" rows="2" placeholder="输入任务内容，也可以只添加图片…">${escapeHtml(queueDraft)}</textarea>
            ${imagePicker("queue", [], queueImages)}
            <p class="cq-draft-hint" data-draft-hint="queue" ${hasQueueDraft() ? "" : "hidden"}>
              草稿只在当前页面暂存，切换面板会保留；手动刷新或关闭标签页会丢失。
            </p>
            <div class="cq-panel-actions">
              <button type="button" data-action="cancel-queue-composer">取消</button>
              <button type="button" class="cq-save" data-action="save-queue-composer">加入队列</button>
            </div>
          </div>` : ""}
          ${favoritesOpen ? renderFavorites() : ""}
          ${schedulerOpen ? `
            <div class="cq-scheduler">
              <div class="cq-scheduler-tabs">
                <button type="button" class="${schedulerView === "list" ? "cq-tab-active" : ""}" data-action="show-schedule-list">当前自动任务 <span>${state.schedules.length}</span></button>
                <button type="button" class="${schedulerView === "create" ? "cq-tab-active" : ""}" data-action="show-schedule-create">
                  <span class="cq-create-tab-title">${editingSchedule ? "继续编辑" : hasScheduleDraft() ? "继续草稿" : "＋ 创建任务"}</span>
                  <small class="cq-unsaved-label" ${hasScheduleDraft() ? "" : "hidden"}>未保存</small>
                </button>
                <button type="button" class="cq-auto-advanced-toggle" data-action="toggle-auto-advanced"
                  aria-expanded="${autoAdvancedOpen}" aria-controls="cq-auto-advanced"
                  aria-label="${autoAdvancedOpen ? "收起不常用设置" : "展开不常用设置"}"
                  title="${autoAdvancedOpen ? "收起不常用设置" : "展开不常用设置"}">
                  ${icon(autoAdvancedOpen ? "arrowUp" : "arrowDown")}<span>${autoAdvancedOpen ? "收起设置" : "高级设置"}</span>
                </button>
              </div>
              ${schedulerView === "create" ? `
              <div class="cq-section-title">${editingSchedule ? '编辑自动入队任务' : '创建自动入队任务'} <span>只负责入队，由原队列依次发送</span></div>
              <p class="cq-draft-hint" data-draft-hint="schedule" ${hasScheduleDraft() ? "" : "hidden"}>草稿仅在当前页面暂存；切换列表或面板会保留，手动刷新页面会丢失。</p>
              <textarea id="cq-schedule-draft" rows="2" placeholder="自动入队的提示词…">${escapeHtml(scheduleDraft)}</textarea>
              ${imagePicker("schedule", scheduleKeptImages, scheduleImages)}
              <div class="cq-schedule-controls">
                <label for="cq-schedule-mode">触发方式 <select id="cq-schedule-mode">
                  <option value="time" ${scheduleModeDraft === "time" ? "selected" : ""}>按时间</option>
                  <option value="count" ${scheduleModeDraft === "count" ? "selected" : ""}>按队列数量</option>
                </select></label>
                ${scheduleModeDraft === "count"
                  ? `<label for="cq-threshold">队列少于 <input id="cq-threshold" type="number" min="1" max="${settings.maxPending}" step="1" value="${escapeHtml(thresholdDraft)}"> 条</label>`
                  : `<label for="cq-minutes">间隔 <input id="cq-minutes" type="number" min="1" max="525600" step="1" value="${escapeHtml(minutesDraft)}"> 分钟</label>`}
                <label for="cq-repeats">循环次数 <input id="cq-repeats" type="number" min="-1" max="1000000" step="1" value="${escapeHtml(repeatsDraft)}"></label>
                <div>${editingSchedule ? '<button type="button" data-action="cancel-edit-schedule">取消编辑</button>' :
                  `<button type="button" data-action="discard-schedule-draft" ${hasScheduleDraft() ? "" : "hidden"}>清空草稿</button>`}
                  <button type="button" class="cq-save" data-action="save-schedule">${editingSchedule ? "保存" : "添加任务"}</button>
                </div>
              </div>
              <p class="cq-repeat-hint">${scheduleModeDraft === "count" ? "数量不足时按自动任务轮流补队，每轮各任务最多一条；统计含发送中和等待回复的任务。多规则建议使用相同阈值。" : "间隔到期自动入队一条。"} -1 无限 · 0 单次 · N 再重复 N 次</p>
              ` : `<div class="cq-section-title">当前自动任务 <span>筛选与排序仅影响显示，不改变入队顺序</span></div>
                ${renderScheduleControls()}
                <div class="cq-schedule-results" aria-label="当前自动任务列表">${renderSchedules()}</div>`}
              <div id="cq-auto-advanced" class="cq-auto-advanced" ${autoAdvancedOpen ? "" : "hidden"}>
              <div class="cq-count-rate-panel">
                <div class="cq-section-title">数量补队频率限制 <span>仅当前对话，不是全局设置</span></div>
                <label class="cq-switch" for="cq-count-rate-enabled">
                  <input type="checkbox" id="cq-count-rate-enabled" ${countRateEnabledDraft ? "checked" : ""}>
                  限制数量检测自动补队（默认关闭）
                </label>
                <div class="cq-schedule-controls">
                  <label for="cq-count-rate-minutes">每 <input type="number" id="cq-count-rate-minutes"
                    min="1" max="1440" step="1" value="${escapeHtml(countRateMinutesDraft)}"> 分钟</label>
                  <label for="cq-count-rate-max">最多补入 <input type="number" id="cq-count-rate-max"
                    min="1" max="200" step="1" value="${escapeHtml(countRateMaxDraft)}"> 条</label>
                  <button type="button" class="cq-save" data-action="save-count-rate">保存本对话限制</button>
                </div>
                <p class="cq-repeat-hint cq-count-rate-status" role="status">
                  ${rate.enabled
                    ? `本对话最近 ${rate.minutes} 分钟已自动补入 ${rate.used}/${rate.maxAdds} 条。${rate.nextAvailableAt
                      ? ` 已到限制，下个名额 ${countdownMarkup(rate.nextAvailableAt)} 后恢复。`
                      : ` 还可补入 ${Math.max(0, rate.maxAdds - rate.used)} 条。`}`
                    : "本对话未启用限速，数量模式按原来的轮询规则补队。"}
                  手动入队和按时间触发的任务不计入此限制。
                </p>
              </div>
              <div class="cq-handoff-panel">
                <div class="cq-section-title">自动上下文接力 <span>原生项目 · 本对话独立设置</span></div>
                <label class="cq-switch" for="cq-handoff-enabled">
                  <input type="checkbox" id="cq-handoff-enabled" ${handoff.enabled ? "checked" : ""} ${handoffRunning ? "disabled" : ""}>
                  定时总结并在同项目的新对话继续队列
                </label>
                <div class="cq-schedule-controls">
                  <label for="cq-handoff-minutes">每 <input type="number" id="cq-handoff-minutes"
                    min="5" max="1440" step="1" value="${escapeHtml(handoff.intervalMinutes)}"
                    ${handoffRunning ? "disabled" : ""}> 分钟</label>
                  <button type="button" class="cq-save" data-action="save-handoff"
                    ${handoffRunning ? "disabled" : ""}>保存接力设置</button>
                </div>
                <p class="cq-repeat-hint" role="status">
                  ${handoffLabels[handoff.phase] || (handoff.enabled
                    ? handoff.nextAt && handoff.nextAt > clock()
                      ? `下次检查 ${countdownMarkup(handoff.nextAt)} 后；仅队列还有未发送任务时接力。`
                      : "等待队列任务；到期且还有待办时启动接力。"
                    : "默认关闭。仅支持项目聊天链接；没有待办时不会创建新对话。")}
                  ${handoff.error ? ` · ${escapeHtml(handoff.error)}` : ""}
                </p>
                ${["due","opening","navigating","failed","bootstrapping"].includes(handoff.phase)
                  ? `<button type="button" data-action="cancel-handoff" class="cq-handoff-cancel"
                      title="仅在尚未发送新对话开场内容时可以安全取消">取消接力并保留旧队列</button>`
                  : ""}
                <p class="cq-repeat-hint">无需开启定时，也可以点击底部「接力」按钮立即触发；会先等待当前回复完成。新对话确认接收总结后才转移剩余图文任务与规则，失败时不会自动重复发送。</p>
              </div>
              <label class="cq-switch"><input type="checkbox" id="cq-auto-open" ${state.autoOpenTab ? "checked" : ""}> 对话标签关闭或被丢弃后自动恢复（浏览器需保持运行）</label>
              </div>
            </div>
          ` : ''}
          ${settingsOpen ? `
            <div class="cq-scheduler cq-settings">
              <div class="cq-settings-heading">
                <div class="cq-section-title">队列设置 <span>按类别查看与修改</span></div>
                <button type="button" data-action="discard-settings-draft" ${hasUnsavedSettings() || hasUnsavedCooldown() ? "" : "hidden"}>放弃未保存更改</button>
              </div>
              <p class="cq-draft-hint" data-draft-hint="settings" ${hasUnsavedSettings() || hasUnsavedCooldown() ? "" : "hidden"}>设置有未保存的修改 · 切换面板会保留，刷新页面会丢失。</p>
              <div class="cq-settings-tabs" role="tablist" aria-label="设置分类">
                <button type="button" role="tab" id="cq-settings-tab-cooldown" data-action="show-settings-page" data-page="cooldown"
                  aria-selected="${settingsPage === "cooldown"}" aria-controls="cq-settings-page-cooldown" tabindex="${settingsPage === "cooldown" ? 0 : -1}" class="${settingsPage === "cooldown" ? "cq-tab-active" : ""}">发送冷却<small class="cq-settings-dirty" data-settings-dirty="cooldown" ${hasUnsavedCooldown() ? "" : "hidden"}>未保存</small></button>
                <button type="button" role="tab" id="cq-settings-tab-general" data-action="show-settings-page" data-page="general"
                  aria-selected="${settingsPage === "general"}" aria-controls="cq-settings-page-general" tabindex="${settingsPage === "general" ? 0 : -1}" class="${settingsPage === "general" ? "cq-tab-active" : ""}">队列与自动<small class="cq-settings-dirty" data-settings-dirty="general" ${hasUnsavedSettings() ? "" : "hidden"}>未保存</small></button>
                <button type="button" role="tab" id="cq-settings-tab-background" data-action="show-settings-page" data-page="background"
                  aria-selected="${settingsPage === "background"}" aria-controls="cq-settings-page-background" tabindex="${settingsPage === "background" ? 0 : -1}" class="${settingsPage === "background" ? "cq-tab-active" : ""}">后台运行</button>
                <button type="button" role="tab" id="cq-settings-tab-diagnostics" data-action="show-settings-page" data-page="diagnostics"
                  aria-selected="${settingsPage === "diagnostics"}" aria-controls="cq-settings-page-diagnostics" tabindex="${settingsPage === "diagnostics" ? 0 : -1}" class="${settingsPage === "diagnostics" ? "cq-tab-active" : ""}">诊断备份</button>
              </div>
              <div class="cq-settings-page" id="cq-settings-page-cooldown" role="tabpanel" aria-labelledby="cq-settings-tab-cooldown" ${settingsPage === "cooldown" ? "" : "hidden"}>
              <div class="cq-send-cooldown-panel">
                <div class="cq-section-title">自动发送冷却 <span>仅当前对话</span></div>
                <div class="cq-schedule-controls">
                  <label for="cq-send-cooldown">上一条完成后等待
                    <input id="cq-send-cooldown" type="number" min="0" max="3600"
                      step="1" value="${escapeHtml(cooldownSecondsDraft)}"> 秒
                  </label>
                  <button type="button" class="cq-save" data-action="save-send-cooldown"
                    ${cooldownSaving ? 'disabled aria-busy="true"' : ""}>保存本对话冷却</button>
                </div>
                <p class="cq-repeat-hint">0 表示关闭；建议先试 30～60 秒，可设置 0～3600 秒。等待期间可继续入队，但不会领取下一条自动发送任务。手动即时发送不受此限制。</p>
                <p class="cq-repeat-hint cq-cooldown-hint" role="status">当前：${state.sendCooldownSeconds ?? 0} 秒
                  ${cooldownAt ? ` · 剩余 ${countdownMarkup(cooldownAt)}` : " · 无等待中的冷却"}
                  · 只能降低短时间发送频率，不能保证避开平台限制。
                </p>
              </div>
              </div>
              <div class="cq-settings-page" id="cq-settings-page-general" role="tabpanel" aria-labelledby="cq-settings-tab-general" ${settingsPage === "general" ? "" : "hidden"}>
              <div class="cq-defaults-settings">
                <div class="cq-section-title">全局队列设置 <span>所有对话共用</span></div>
              <div class="cq-schedule-controls">
                <label for="cq-max-pending">队列数量上限 <input id="cq-max-pending" type="number" min="1" max="200" step="1" value="${escapeHtml(maxPendingDraft)}"> 条</label>
              </div>
              <p class="cq-repeat-hint">包含待发送、发送中和等待回复；手动入队与自动入队共用此上限（1～200）。降低上限不会删除现有任务。</p>
              </div>
              <div class="cq-defaults-settings">
                <div class="cq-section-title">新建自动任务默认值 <span>只影响之后创建的任务</span></div>
                <div class="cq-schedule-controls">
                  <label for="cq-default-minutes">默认循环间隔 <input id="cq-default-minutes" type="number" min="1" max="525600" step="1" value="${escapeHtml(defaultMinutesDraft)}"> 分钟</label>
                  <label for="cq-default-repeats">默认循环次数 <input id="cq-default-repeats" type="number" min="-1" max="1000000" step="1" value="${escapeHtml(defaultRepeatsDraft)}"></label>
                </div>
                <p class="cq-repeat-hint">-1 无限循环 · 0 只入队一次 · N 再重复 N 次；循环间隔仅用于按时间模式，数量模式按阈值触发。</p>
              </div>
              <div class="cq-panel-actions">
                <button type="button" data-action="toggle-queue-composer"
                  title="在这里打开不常用的独立图文任务编辑器">${icon("image")} 图文任务
                  <small class="cq-draft-indicator" data-draft-kind="queue" ${hasQueueDraft() || editingTask ? "" : "hidden"}>草稿</small>
                </button>
                <button type="button" class="cq-save" data-action="save-settings">保存设置</button>
              </div>
              </div>
              <div class="cq-settings-page" id="cq-settings-page-background" role="tabpanel" aria-labelledby="cq-settings-tab-background" ${settingsPage === "background" ? "" : "hidden"}>
              <div class="cq-protection-settings">
                <div class="cq-section-title">完成提示音 <span>网页内播放 · 所有对话共用</span></div>
                <label class="cq-switch" for="cq-completion-sound">
                  <input type="checkbox" id="cq-completion-sound" ${completionSoundEnabled ? "checked" : ""}>
                  对话回复或整个队列完成后播放轻提示音
                </label>
                <div class="cq-schedule-controls">
                  <button type="button" data-action="preview-completion-sound">试听提示音</button>
                </div>
                <p class="cq-repeat-hint">不调用 Windows 通知。浏览器可能限制从未交互过的后台网页播放声音；在需要提醒的对话中点击一次页面，或点击「试听提示音」可尝试解锁。</p>
              </div>
              <div class="cq-protection-settings">
                <label class="cq-switch" for="cq-protect-background">
                  <input type="checkbox" id="cq-protect-background" ${settings.protectBackground !== false ? "checked" : ""}>
                  <strong>后台队列防丢弃</strong>（默认开启）
                </label>
                <p class="cq-repeat-hint">有待发送、执行中任务或启用的自动规则时，阻止浏览器自动释放对应标签页；队列清空后恢复原设置。后台每分钟尝试唤醒运行中的队列。</p>
                <p class="cq-repeat-hint">无法阻止 Edge 休眠/冻结。为确保长期运行，请前往 Edge 设置 → 系统和性能 → 性能 → 始终保持这些网站处于活动状态，添加 chatgpt.com。</p>
              </div>
              </div>
              <div class="cq-settings-page" id="cq-settings-page-diagnostics" role="tabpanel" aria-labelledby="cq-settings-tab-diagnostics" ${settingsPage === "diagnostics" ? "" : "hidden"}>
              <div class="cq-diagnostics">
                <button type="button" class="cq-diagnostics-toggle" data-action="toggle-diagnostics"
                  aria-expanded="${diagnosticsOpen ? "true" : "false"}" aria-controls="cq-diagnostics-content">
                  <span>诊断与备份</span>
                  <small>最近 ${Math.min(80, state.history?.length || 0)} 条日志 · 图文备份 · 图片自检</small>
                  ${icon(diagnosticsOpen ? "arrowUp" : "arrowDown")}
                </button>
                ${diagnosticsOpen ? `<div id="cq-diagnostics-content" class="cq-diagnostics-content">
                  <div class="cq-section-title">本对话运行日志 <span>最近 80 条，不保存提示词或图片正文</span></div>
                  ${renderHistory()}
                  ${backupProgress ? `<p class="cq-repeat-hint cq-backup-progress" role="status">${escapeHtml(backupProgress)}</p>` : ""}
                  <div class="cq-diagnostics-actions">
                    <button type="button" data-action="export-backup">导出本对话完整备份</button>
                    <label for="cq-backup-file" class="cq-restore-label">选择 JSON 备份恢复</label>
                    <input type="file" id="cq-backup-file" accept=".json,application/json" hidden>
                    <button type="button" data-action="check-queue-images">检查本对话图片存档</button>
                    <button type="button" data-action="clear-history">清空日志</button>
                  </div>
                  ${imageHealthResult ? `<p class="cq-repeat-hint cq-image-health" role="status">
                    已检查 ${imageHealthResult.total} 张图片引用；${imageHealthResult.missing
                      ? `有 ${imageHealthResult.missing} 张缺失，影响 ${imageHealthResult.affectedTasks} 条队列任务、${imageHealthResult.affectedRules} 条自动规则。缺图任务不会被作为纯文字发送。`
                      : "对应原图记录均存在。"}
                  </p>` : ""}
                  <p class="cq-repeat-hint">备份包含当前对话提示词、自动规则及图片原图，是未加密的敏感文件，请妥善保管。仅能恢复到同一对话的空队列；恢复后暂停发送，自动规则默认停用，需手动检查后启用。</p>
                  <p class="cq-repeat-hint">图片存档检查只检查原图记录是否存在，不代表 ChatGPT 一定能成功上传附件。</p>
                </div>` : ""}
              </div>
              </div>
            </div>
          ` : ''}
        ` : ''}
        ${renderActionFeedback()}
        <div class="cq-footer-toolbar">
          ${queueExpanded ? `<div class="cq-shortcuts">
            <span><kbd>Enter</kbd> <span class="cq-enter-action">入队</span></span>
            <span><kbd>Ctrl</kbd> + <kbd>Enter</kbd> 即时发送</span>
            <span><kbd>Shift</kbd> + <kbd>Enter</kbd> 换行</span>
          </div>` : ""}
          <div class="cq-bottom-actions">
            <button type="button" class="cq-tool cq-add-queue" data-action="queue-composer"
              aria-label="将原生输入框内容入队" title="将原生输入框里的文字和图片一起加入当前对话队列">${icon("plus")}<span>入队</span></button>
            <button type="button" class="cq-tool ${state.queuePaused ? "cq-tool-active" : ""}" data-action="toggle-queue-paused"
              aria-label="${state.queuePaused ? "继续自动发送" : "暂停自动发送"}"
              title="${state.queuePaused ? "继续自动发送" : "暂停自动发送（不会强行打断正在运行的消息）"}"
              aria-pressed="${state.queuePaused ? "true" : "false"}">${icon(state.queuePaused ? "play" : "pause")}<span>${state.queuePaused ? "继续" : "暂停"}</span></button>
            <button type="button" class="cq-tool ${favoritesOpen && queueExpanded ? 'cq-tool-active' : ''}"
              data-action="toggle-favorites" aria-pressed="${favoritesOpen && queueExpanded}"
              aria-label="打开提示词收藏夹" title="收藏常用图文任务并一键重新入队">${icon("star")}<span>收藏</span>${favoriteItems.length ? `<small>${favoriteItems.length}</small>` : ""}<small class="cq-draft-indicator" data-draft-kind="favorite" ${hasUnsavedFavoriteTemplate() ? "" : "hidden"}>草稿</small></button>
            <button type="button" class="cq-tool ${schedulerOpen && queueExpanded ? 'cq-tool-active' : ''}"
              data-action="toggle-scheduler" aria-label="${hasUnsavedAutomation() ? "自动入队规则，有未保存草稿" : "自动入队规则"}" title="定时 / 数量触发入队">${icon("clock")}<span>自动</span>${state.schedules.length ? `<small>${state.schedules.length}</small>` : ""}<small class="cq-draft-indicator" data-draft-kind="schedule" ${hasUnsavedAutomation() ? "" : "hidden"}>未保存</small></button>
            <span class="cq-handoff-hover-area" title="${escapeHtml(handoffHoverText(handoffButtonHint))}">
              <button type="button" class="cq-tool cq-handoff-now ${handoffRunning ? "cq-tool-active" : ""}"
                data-action="handoff-now" aria-label="${handoffRunning ? "取消本次上下文接力" : "立即接力到同一原生项目的新对话"}"
                data-handoff-hint="${escapeHtml(handoffButtonHint)}"
                title="${escapeHtml(handoffHoverText(handoffButtonHint))}"
                ${(handoffRunning ? canCancelHandoff : canHandoffNow) &&
                  !pendingUiActions.has("handoff-now") ? "" : 'disabled'}>
                ${icon("handoff")}<span>${handoffRunning ?
                  handoffCancelling ? "取消中" : "取消接力" : "接力"}</span></button>
            </span>
            <button type="button" class="cq-tool ${settingsOpen && queueExpanded ? 'cq-tool-active' : ''}"
              data-action="toggle-settings" aria-label="${hasQueueDraft() ? "队列设置，有未保存的图文任务草稿" : hasUnsavedSettings() || hasUnsavedCooldown() ? "队列设置，有未保存修改" : "队列设置"}" title="队列设置">${icon("settings")}<span>设置</span><small class="cq-draft-indicator" data-draft-kind="settings" ${hasUnsavedSettings() || hasUnsavedCooldown() ? "" : "hidden"}>未保存</small><small class="cq-draft-indicator" data-draft-kind="queue" ${hasQueueDraft() || editingTask ? "" : "hidden"}>图文草稿</small></button>
            <button type="button" class="cq-tool cq-icon-only" data-action="toggle-queue" title="${queueExpanded ? '收起队列' : '展开队列'}" aria-label="${queueExpanded ? '收起队列' : '展开队列'}">${icon(queueExpanded ? "arrowUp" : "arrowDown")}</button>
          </div>
        </div>
      </section>
    `;

    syncUnsavedDraftIndicators();
    if (activeId) {
      const target = root.querySelector(`#${activeId}`);
      if (target) {
        target.focus();
        if (caret != null && target.setSelectionRange) target.setSelectionRange(caret, caret);
      }
    } else if (focusedButton) {
      const target = [...root.querySelectorAll("button[data-action]")]
        .find((item) => item.dataset.action === focusedButton.action &&
          (item.dataset.id || "") === focusedButton.id &&
          (item.dataset.filter || "") === focusedButton.filter &&
          (item.dataset.page || "") === focusedButton.page);
      target?.focus({preventScroll:true});
    }
    const list = root.querySelector(".cq-list");
    if (list) {
      list.scrollTop = previousListScroll;
      setQueueListHeight(list, settings.queueListHeight);
      if (focusedTaskRowId) focusQueueTaskRow(focusedTaskRowId, false);
    }
    const scheduleResults = root.querySelector(".cq-schedule-results");
    if (scheduleResults) scheduleResults.scrollTop = previousScheduleScroll;
    updateCountdowns();
  }

  async function onAction(button) {
    const action = button.dataset.action;
    const id = button.dataset.id;
    if (action === "preview-completion-sound") {
      if (!await playCompletionSound(true)) {
        notification = "浏览器暂时不允许播放声音，请确认标签页未静音，并点击试听再试。";
        render();
      }
      return;
    }
    if (action === "dismiss-feedback") {
      actionFeedback = null;
      render();
      return;
    }
    const guardedKeyEarly = ["pin-task", "delete-task", "delete-schedule",
      "handoff-now",
      "toggle-schedule", "save-task"].includes(action)
      ? `${action}:${id || editingTask}` : null;
    // Reject a duplicate before opening a second confirmation dialog.
    if (guardedKeyEarly && pendingUiActions.has(guardedKeyEarly)) return;
    if (action === "toggle-favorites") {
      favoritesOpen = !favoritesOpen;
      queueComposerOpen = false; schedulerOpen = false; settingsOpen = false;
      queueExpanded = true;
      render();
      if (favoritesOpen) root.querySelector("#cq-favorite-search")?.focus();
      return;
    }
    if (action === "favorites-pinned-only") {
      favoritePinnedOnly = !favoritePinnedOnly;
      render();
      return;
    }
    if (action === "cancel-favorite-template") {
      if (favoriteTemplateDraft?.id !== id) return;
      if (hasUnsavedFavoriteTemplate() &&
          !confirm("放弃这次尚未加入队列的模板变量填写？")) return;
      favoriteTemplateDraft = null;
      favoriteTemplateRenderPending = false;
      render();
      return;
    }
    if (action === "confirm-favorite-template") {
      if (favoriteBusy || favoriteTemplateDraft?.id !== id) return;
      const item = favoriteItems.find((favorite) => favorite.id === id);
      if (!item || item.text !== favoriteTemplateDraft.sourceText) {
        throw new Error("收藏模板已被更新，请取消并重新填写");
      }
      if (!boundHere() || favoriteTemplateDraft.conversationKey !== sessionKey ||
          favoriteTemplateDraft.pageUrl !== location.href) {
        throw new Error("填写模板时对话已变化，请在目标对话重新打开收藏");
      }
      const preview = favoriteTemplatePreview(item);
      if (!preview.ready) throw new Error(preview.status);
      const origin = location.href;
      const conversation = sessionKey;
      const {requestId,values} = favoriteTemplateDraft;
      favoriteBusy = true;
      render();
      try {
        // Backend reconstructs/validates the final task independently and
        // keeps the normal per-chat queue, cooldown and dedupe gates.
        await rpc("ENQUEUE_FAVORITE", {
          favoriteId:id,requestId,templateValues:{...values},
        });
        if (origin === location.href && conversation === sessionKey) {
          favoriteTemplateDraft = null;
          showActionFeedback("模板变量已替换，任务加入当前对话队列");
        }
      } finally {
        favoriteBusy = false;
        render();
      }
      return;
    }
    if (action === "save-send-cooldown") {
      if (cooldownSaving) return;
      const revision = cooldownDraftRevision;
      const submitted = cooldownSecondsDraft;
      const savedSession = sessionKey;
      const savedUrl = location.href;
      cooldownSaving = true;
      actionFeedback = null;
      render();
      try {
        await rpc("SAVE_SEND_COOLDOWN", {seconds:submitted});
        if (savedSession === sessionKey && savedUrl === location.href) {
          if (revision === cooldownDraftRevision) {
            resetCooldownDraft();
            showActionFeedback(Number(submitted) === 0 ?
              "本对话已关闭发送冷却" : `本对话发送冷却已设为 ${Number(submitted)} 秒`);
          } else {
            notification = "上次冷却设置已保存，新输入仍保留，点击保存可再次更新";
          }
        }
      } finally {
        cooldownSaving = false;
        render();
      }
      return;
    }
    if (action === "save-handoff") {
      const enabled = root.querySelector("#cq-handoff-enabled")?.checked === true;
      const intervalMinutes = root.querySelector("#cq-handoff-minutes")?.value;
      await rpc("SET_HANDOFF", {enabled,intervalMinutes});
      showActionFeedback(enabled ? `已启用自动上下文接力 · 每 ${intervalMinutes} 分钟` :
        "已关闭自动上下文接力");
      render();
      return;
    }
    if (action === "handoff-now") {
      if (pendingUiActions.has("handoff-now")) return;
      pendingUiActions.add("handoff-now");
      button.disabled = true;
      button.setAttribute("aria-busy", "true");
      try {
        if (state.handoff && !["idle","completed"].includes(state.handoff.phase)) {
          const pauseAfter = state.handoff.phase === "failed" &&
            state.tasks.some((task) => task.status === "pending");
          await rpc("CANCEL_HANDOFF",{pauseAfter});
          showActionFeedback(state.handoff?.cancelRequested
            ? "已请求终止接力：等当前总结安全结束后停止，不会跳转新对话"
            : pauseAfter
              ? "已取消失败的接力并暂停队列，确认任务后可继续"
              : "本次接力已取消，原队列保留");
        } else {
          await rpc("HANDOFF_NOW");
          showActionFeedback("已启动接力：当前回复完成后生成总结，并在同项目新对话继续（队列可为空）");
        }
      } finally {
        pendingUiActions.delete("handoff-now");
        render();
      }
      return;
    }
    if (action === "cancel-handoff") {
      if (!confirm("取消本次接力？\n\n若交接消息已发送且状态不明，将拒绝自动撤回以保护任务。定时规则设置不变。")) return;
      const pauseAfter = state.handoff?.phase === "failed" &&
        state.tasks.some((task) => task.status === "pending");
      await rpc("CANCEL_HANDOFF",{pauseAfter});
      showActionFeedback(state.handoff?.cancelRequested
        ? "已请求停止：当前总结结束后退出，不会跳转"
        : pauseAfter
          ? "已取消失败的接力并暂停队列；请检查待发送任务，确认后再点击继续"
          : "已取消接力，原队列继续使用");
      render();
      return;
    }
    if (["favorite-task", "save-current-favorite", "enqueue-favorite",
         "rename-favorite", "delete-favorite","pin-favorite"].includes(action)) {
      if (favoriteBusy) return;
      const item = favoriteItems.find((favorite) => favorite.id === id);
      const task = state.tasks.find((candidate) => candidate.id === id);
      let rename = null;
      if (action === "rename-favorite") {
        if (!item) return;
        rename = prompt("收藏名称（最多 80 字）", item.title);
        if (rename == null || rename === item.title) return;
      }
      if (action === "delete-favorite" &&
          (!item || !confirm(`确定删除收藏「${item.title}」？不会删除已经入队的任务。`))) return;
      favoriteBusy = true;
      try {
        let notice = "";
        if (action === "favorite-task") {
          if (!task) return;
          const existingFavorite = favoriteForTask(task);
          await favoriteRpc(existingFavorite ? "DELETE_FAVORITE" : "ADD_FAVORITE",
            existingFavorite ? {id:existingFavorite.id} : {taskId:task.id});
          notice = existingFavorite ? "已取消收藏，原任务不受影响" : "已收藏图文任务，其他对话也可以复用";
        } else if (action === "save-current-favorite") {
          const editor = getEditor();
          const text = editorText(editor);
          if (hasComposerAttachments(editor)) {
            throw new Error("要保留图片，请先将图文任务入队，再点击任务旁的 ☆ 收藏");
          }
          if (!text?.trim()) throw new Error("请先在 ChatGPT 输入框写下要收藏的提示词");
          const reply = await favoriteRpc("ADD_FAVORITE", {text});
          notice = reply.alreadySaved ? "这条提示词已经收藏过了" : "已收藏输入框提示词，原内容保持不变";
        } else if (action === "enqueue-favorite") {
          if (!item) return;
          const template = item.templateEnabled === true
            ? favoriteTemplateFields(item.text) : {names:[],error:""};
          if (template.error) throw new Error(template.error + "；请在收藏管理页修改，或使用 \\{{名称}} 输出字面文本");
          if (template.names.length) {
            if (favoriteTemplateDraft && favoriteTemplateDraft.id !== id &&
                hasUnsavedFavoriteTemplate() &&
                !confirm("已有尚未加入队列的变量草稿，确定放弃并填写另一条模板？")) return;
            if (!favoriteTemplateDraft || favoriteTemplateDraft.id !== id ||
                favoriteTemplateDraft.sourceText !== item.text) {
              favoriteTemplateDraft = {
                id,sourceText:item.text,values:Object.create(null),
                requestId:crypto.randomUUID(),
                conversationKey:sessionKey,pageUrl:location.href,
              };
            }
            render();
            root.querySelector(".cq-template-compose textarea")?.focus();
            return;
          }
          // Exactly one deliberate click creates one queue entry; never
          // send directly or bypass the normal dispatch safety state.
          await rpc("ENQUEUE_FAVORITE", {favoriteId:id,requestId:crypto.randomUUID()});
          notice = "收藏已加入当前对话队列，将按原有接力规则执行";
        } else if (action === "pin-favorite") {
          if (!item) return;
          const wasPinned = item.pinned === true;
          await favoriteRpc("UPDATE_FAVORITE", {id,pinned:!wasPinned});
          notice = wasPinned ? "已取消收藏置顶" : "收藏已置顶，不影响队列任务顺序";
        } else if (action === "rename-favorite") {
          await favoriteRpc("RENAME_FAVORITE", {id,title:rename});
          notice = "收藏已重命名";
        } else if (action === "delete-favorite") {
          await favoriteRpc("DELETE_FAVORITE", {id});
          notice = "收藏已删除，现有队列任务不受影响";
        }
        showActionFeedback(notice);
        render();
      } finally {
        favoriteBusy = false;
        render();
      }
      return;
    }
    if (action === "toggle-queue") { queueExpanded = !queueExpanded; render(); return; }
    if (action === "filter-tasks") {
      if (!["all", "pending", "active", "review"].includes(button.dataset.filter)) return;
      queueFilter = button.dataset.filter;
      jumpTargetId = null;
      render();
      const list = root.querySelector(".cq-list");
      if (list) list.scrollTop = 0;
      return;
    }
    if (action === "filter-schedules") {
      const chosen = button.dataset.filter;
      if (!["all", "enabled", "disabled"].includes(chosen)) return;
      scheduleFilter = chosen;
      render();
      root.querySelector(`[data-action="filter-schedules"][data-filter="${chosen}"]`)?.focus();
      const list = root.querySelector(".cq-schedule-results");
      if (list) list.scrollTop = 0;
      return;
    }
    if (action === "toggle-schedule-text") {
      if (expandedScheduleIds.has(id)) expandedScheduleIds.delete(id);
      else expandedScheduleIds.add(id);
      render();
      [...root.querySelectorAll('[data-action="toggle-schedule-text"]')]
        .find((item) => item.dataset.id === id)?.focus();
      return;
    }
    if (action === "reset-schedule-filters") {
      scheduleFilter = "all";
      scheduleKind = "all";
      scheduleOrder = "original";
      scheduleSearch = "";
      render();
      root.querySelector("#cq-rule-search")?.focus();
      const list = root.querySelector(".cq-schedule-results");
      if (list) list.scrollTop = 0;
      return;
    }
    if (action === "reset-task-filter") {
      queueFilter = "all";
      queueSearch = "";
      jumpTargetId = null;
      render();
      const search = root.querySelector("#cq-task-search");
      search?.focus();
      return;
    }
    if (action === "toggle-task-text") {
      if (expandedTaskIds.has(id)) expandedTaskIds.delete(id);
      else expandedTaskIds.add(id);
      render();
      return;
    }
    if (action === "toggle-task-error") {
      if (expandedErrorIds.has(id)) expandedErrorIds.delete(id);
      else expandedErrorIds.add(id);
      render();
      return;
    }
    if (action === "toggle-compact-view") {
      await rpc("SET_COMPACT_VIEW", {enabled: state.compactView !== true});
      render();
      return;
    }
    if (action === "toggle-diagnostics") {
      diagnosticsOpen = !diagnosticsOpen;
      render();
      root.querySelector('[data-action="toggle-diagnostics"]')?.focus();
      return;
    }
    if (action === "toggle-auto-advanced") {
      autoAdvancedOpen = !autoAdvancedOpen;
      try { localStorage.setItem(AUTO_ADVANCED_STORAGE_KEY, autoAdvancedOpen ? "1" : "0"); }
      catch { /* Keep the current view even if storage is blocked. */ }
      render();
      root.querySelector('[data-action="toggle-auto-advanced"]')?.focus({preventScroll:true});
      return;
    }
    if (action === "show-settings-page") {
      const nextPage = button.dataset.page;
      if (!["cooldown", "general", "background", "diagnostics"].includes(nextPage)) return;
      settingsPage = nextPage;
      if (nextPage === "diagnostics") diagnosticsOpen = true;
      render();
      root.querySelector(`.cq-settings-tabs [data-page="${nextPage}"]`)?.focus({preventScroll:true});
      return;
    }
    notification = "";
    if (action === "toggle-queue-paused") {
      actionFeedback = null;
      await rpc("SET_QUEUE_PAUSED", { paused: !state.queuePaused });
      notification = state.queuePaused
        ? "当前对话的自动发送已暂停；自动规则仍可入队，当前消息不会被打断。"
        : "当前对话已恢复自动发送。";
      render();
      return;
    }
    if (action === "export-backup") {
      await exportConversationBackup();
      return;
    }
    if (action === "clear-history") {
      if (!confirm("清空当前对话的运行日志？不会影响任务、自动规则或图片。")) return;
      actionFeedback = null;
      await rpc("CLEAR_HISTORY");
      showActionFeedback("本对话的运行日志已清空，任务和图片没有变化");
      render();
      return;
    }
    if (action === "check-queue-images") {
      actionFeedback = null;
      const response = await rpc("CHECK_QUEUE_IMAGES");
      imageHealthResult = response.imageHealth;
      notification = imageHealthResult?.missing
        ? "发现本地图像缺失，请检查相关队列任务；插件不会仅发送文字。"
        : "";
      render();
      return;
    }
    if (action === "toggle-scheduler") {
      schedulerOpen = !schedulerOpen;
      if (!hasScheduleDraft()) schedulerView = state.schedules.length ? "list" : "create";
      queueComposerOpen = false; favoritesOpen = false; settingsOpen = false; queueExpanded = true; render(); return;
    }
    if (action === "toggle-queue-composer") {
      queueDraftRevision++;
      queueComposerOpen = !queueComposerOpen;
      schedulerOpen = false; favoritesOpen = false; settingsOpen = false; queueExpanded = true; render(); return;
    }
    if (action === "cancel-queue-composer") {
      if (queueSubmissionInProgress) return;
      if (hasQueueDraft() && !confirm(
        "图文草稿尚未保存，确定放弃已输入的文字和选中的图片？\n\n取消后可继续编辑，也可在「设置 → 队列与自动」重新打开并继续编辑。"
      )) return;
      queueDraftRevision++;
      queueComposerOpen = false; queueDraft = ""; queueImages = [];
      queueSubmissionId = null; render(); return;
    }
    if (action === "save-queue-composer") {
      if (queueSubmissionInProgress) return;
      if (imageSelectionInProgress) throw new Error("图片仍在处理中");
      queueSubmissionInProgress = true;
      queueSubmissionId ||= crypto.randomUUID();
      const savedRevision = queueDraftRevision;
      const savedSession = sessionKey;
      const savedUrl = location.href;
      const submittedText = queueDraft;
      const submittedImages = [...queueImages];
      const requestId = queueSubmissionId;
      const previousLabel = button.textContent;
      button.disabled = true;
      button.setAttribute("aria-busy", "true");
      button.textContent = "保存中…";
      try {
        await rpc("ENQUEUE", {
          text: submittedText, images: submittedImages, requestId,
        });
        if (sessionKey === savedSession && location.href === savedUrl &&
            queueDraftRevision === savedRevision) {
          queueDraft = ""; queueImages = []; queueComposerOpen = false;
          queueSubmissionId = null;
          queueDraftRevision++;
        } else if (sessionKey === savedSession && location.href === savedUrl) {
          notification = "上一份图文任务已入队，保存期间的新编辑已保留";
        }
        render();
      } finally {
        queueSubmissionInProgress = false;
        syncUnsavedDraftIndicators();
        button.disabled = false;
        button.removeAttribute("aria-busy");
        if (button.isConnected) button.textContent = previousLabel;
      }
      return;
    }
    if (action === "remove-image") {
      removeDraftImage(button.dataset.kind, Number(button.dataset.index));
      return;
    }
    if (action === "save-count-rate") {
      actionFeedback = null;
      await rpc("SAVE_COUNT_RATE_LIMIT", {
        enabled: countRateEnabledDraft,
        windowMinutes: countRateMinutesDraft,
        maxAdds: countRateMaxDraft,
      });
      countRateDirty = false;
      resetCountRateDraft();
      notification = "当前对话的数量补队频率限制已保存";
      render();
      return;
    }
    if (action === "show-schedule-list") {
      schedulerView = "list"; render(); return;
    }
    if (action === "show-schedule-create") {
      if (schedulerView !== "create" && !hasScheduleDraft()) {
        resetScheduleDraft();
      }
      schedulerView = "create"; render(); return;
    }
    if (action === "discard-schedule-draft") {
      if (scheduleSubmissionInProgress) return;
      if (hasScheduleDraft() && !confirm(
        "确定放弃尚未保存的自动任务草稿？\n\n已输入的提示词、规则参数和选中的图片都会清空。"
      )) return;
      resetScheduleDraft();
      render();
      root.querySelector("#cq-schedule-draft")?.focus();
      return;
    }
    if (action === "discard-settings-draft") {
      if ((hasUnsavedSettings() || hasUnsavedCooldown()) && !confirm(
        "确定放弃尚未保存的设置修改，并恢复到最后保存的值？"
      )) return;
      resetSettingsDraft();
      resetCooldownDraft();
      render();
      root.querySelector(settingsPage === "cooldown" ? "#cq-send-cooldown" :
        settingsPage === "general" ? "#cq-max-pending" :
        `.cq-settings-tabs [data-page="${settingsPage}"]`)?.focus();
      return;
    }
    if (action === "toggle-settings") {
      settingsOpen = !settingsOpen;
      schedulerOpen = false; queueComposerOpen = false; favoritesOpen = false;
      if (settingsOpen && !hasUnsavedSettings()) resetSettingsDraft();
      if (settingsOpen && !cooldownDraftDirty) resetCooldownDraft();
      queueExpanded = true; render(); return;
    }
    if (action === "steer-task") {
      await steerQueuedTask(id);
      return;
    }
    if (action === "queue-composer") {
      const editor = getEditor();
      const text = editorText(editor);
      if (!text?.trim() && !hasComposerAttachments(editor)) {
        editor?.focus();
        notification = "先在 ChatGPT 输入框输入文字或添加图片。";
        queueExpanded = true;
        render();
        return;
      }
      if (workInProgress || composerActionInProgress) {
        throw new Error("正在处理上一条消息，请等发送确认后再操作");
      }
      actionFeedback = null;
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
      editedTaskText = task.text; editingTask = id;
      editedTaskKeptImages = [...(task.images || [])]; editedTaskImages = []; render();
      root.querySelector("#cq-edit-task-input")?.focus(); return;
    }
    if (action === "cancel-edit-task") {
      editingTask = null; editedTaskText = ""; editedTaskKeptImages = []; editedTaskImages = [];
      render(); return;
    }

    if (action === "edit-schedule") {
      const item = state.schedules.find((entry) => entry.id === id);
      if (!item) return;
      if (hasScheduleDraft() && editingSchedule !== id && !confirm(
        "已有未保存的自动任务草稿。\n\n确定放弃当前草稿，改为编辑另一条规则？"
      )) return;
      if (editingSchedule === id) {
        schedulerView = "create";
        render();
        root.querySelector("#cq-schedule-draft")?.focus();
        return;
      }
      scheduleDraft = item.text; scheduleModeDraft = item.mode === "count" ? "count" : "time";
      scheduleKeptImages = [...(item.images || [])]; scheduleImages = [];
      minutesDraft = String(item.intervalMinutes ?? settings.defaultIntervalMinutes);
      thresholdDraft = String(item.threshold ?? 1);
      repeatsDraft = String(item.repeatCount ?? -1);
      editingSchedule = id; schedulerView = "create"; render();
      scheduleDraftRevision++;
      root.querySelector("#cq-schedule-draft")?.focus(); return;
    }
    if (action === "cancel-edit-schedule") {
      if (scheduleDraftIsModified() && !confirm(
        "当前自动任务的修改尚未保存。确定放弃这些修改并返回规则列表？"
      )) return;
      resetScheduleDraft(); schedulerView = "list"; render(); return;
    }

    let request = null;
    let savedScheduleRevision = null;
    let savedScheduleSession = null;
    let savedScheduleUrl = null;
    let savedSettingsRevision = null;
    switch (action) {
      case "import-legacy":
        request = ["IMPORT_LEGACY", { userCount: conversationSnapshot().userCount }];
        break;
      case "save-task":
        if (imageSelectionInProgress) throw new Error("图片仍在处理中");
        request = ["EDIT_TASK", {
          id: editingTask, text: editedTaskText,
          keepImageIds: editedTaskKeptImages.map((image) => image.id),
          images: editedTaskImages,
        }];
        break;
      case "pin-task": request = ["PIN_TASK", { id }]; break;
      case "delete-task": {
        const task = state.tasks.find((item) => item.id === id);
        if (!task) return;
        const preview = String(task.text || `纯图片任务（${task.images?.length || 0} 张）`)
          .replace(/\s+/g, " ").slice(0, 70);
        if (!confirm(`确定删除这条队列任务？\n\n${preview}\n\n删除后不能直接撤销。请先确认不再需要发送这条内容。`)) return;
        request = ["DELETE_TASK", { id }];
        break;
      }
      case "skip-failed":
        if (!confirm("请先确认该消息已经发送，或不需要重发。\n\n跳过后插件不会重发此任务，并将继续处理后续队列。")) return;
        request = ["SKIP_FAILED", { id }];
        break;
      case "ack-recovery":
        if (!confirm("确认上次发送已经完成或不需要重发？\n\n继续后队列会发送后面的任务，之前不确定的消息不会自动重试。")) return;
        request = ["ACK_RECOVERY"];
        break;
      case "save-schedule":
        if (scheduleSubmissionInProgress) return;
        if (imageSelectionInProgress) throw new Error("图片仍在处理中");
        scheduleSubmissionInProgress = true;
        savedScheduleRevision = scheduleDraftRevision;
        savedScheduleSession = sessionKey;
        savedScheduleUrl = location.href;
        if (!editingSchedule) scheduleSubmissionId ||= crypto.randomUUID();
        button.disabled = true;
        button.setAttribute("aria-busy", "true");
        request = [editingSchedule ? "EDIT_SCHEDULE" : "ADD_SCHEDULE", {
          ...(editingSchedule ? { id: editingSchedule } : {}),
          ...(!editingSchedule ? { requestId: scheduleSubmissionId } : {}),
          text: scheduleDraft,
          keepImageIds: scheduleKeptImages.map((image) => image.id),
          images: scheduleImages,
          mode: scheduleModeDraft,
          intervalMinutes: minutesDraft,
          threshold: thresholdDraft,
          repeatCount: repeatsDraft,
        }];
        break;
      case "save-settings":
        savedSettingsRevision = settingsDraftRevision;
        request = ["SAVE_SETTINGS", {
          maxPending: maxPendingDraft,
          defaultIntervalMinutes: defaultMinutesDraft,
          defaultRepeatCount: defaultRepeatsDraft,
        }];
        break;
      case "toggle-schedule": request = ["TOGGLE_SCHEDULE", { id }]; break;
      case "delete-schedule": {
        const rule = state.schedules.find((item) => item.id === id);
        if (!rule) return;
        const preview = String(rule.text || "（仅图片规则）").replace(/\s+/g, " ").slice(0, 70);
        if (!confirm(`确定删除这条自动入队规则？\n\n${preview}\n\n删除后不能直接撤销；此前已经入队的任务不会因此被删除。`)) return;
        request = ["DELETE_SCHEDULE", { id }];
        break;
      }
      default: return;
    }
    const [type, props] = request;
    actionFeedback = null;
    const requestedUrl = location.href;
    const requestedSession = sessionKey;
    const guardedKey = guardedKeyEarly;
    const keyboardFocus = document.activeElement === button;
    if (guardedKey) {
      pendingUiActions.add(guardedKey);
      button.disabled = true;
      button.setAttribute("aria-busy", "true");
    }
    try {
      await rpc(type, props);
    } finally {
      if (guardedKey) {
        pendingUiActions.delete(guardedKey);
        button.disabled = false;
        button.removeAttribute("aria-busy");
      }
      if (action === "save-schedule") {
        scheduleSubmissionInProgress = false;
        button.disabled = false;
        button.removeAttribute("aria-busy");
      }
    }
    if (requestedUrl === location.href && requestedSession === sessionKey) {
      const receipt = ({
        "save-task": "队列任务已保存",
        "pin-task": "已移至待发送队首",
        "delete-task": "队列任务已删除",
        "delete-schedule": "自动入队规则已删除",
        "save-schedule": editingSchedule ? "自动入队规则已修改" : "自动入队规则已创建",
      })[action];
      const message = action === "toggle-schedule"
        ? state.schedules.find((item) => item.id === id)?.enabled ?
          "自动入队规则已启用" : "自动入队规则已停用"
        : receipt;
      if (message) {
        showActionFeedback(message);
        notification = "";
      }
    }
    if (action === "save-task") {
      editingTask = null; editedTaskText = ""; editedTaskKeptImages = []; editedTaskImages = [];
    }
    if (action === "save-schedule") {
      if (sessionKey === savedScheduleSession && location.href === savedScheduleUrl &&
          scheduleDraftRevision === savedScheduleRevision) {
        resetScheduleDraft(); schedulerView = "list";
      } else if (sessionKey === savedScheduleSession && location.href === savedScheduleUrl) {
        notification = "上一份自动规则已保存，期间的新编辑仍保留在表单中";
      }
    }
    if (action === "save-settings") {
      if (requestedUrl === location.href && requestedSession === sessionKey) {
        if (settingsDraftRevision === savedSettingsRevision) {
          resetSettingsDraft();
          if (!hasScheduleDraft()) resetScheduleDraft();
          notification = "设置已保存，新建自动任务将使用新的默认值";
        } else {
          notification = "上一份设置已保存，保存期间的新修改仍保留，请再次保存";
        }
      }
    }
    render();
    if (keyboardFocus && requestedUrl === location.href && requestedSession === sessionKey) {
      if (action === "delete-task") {
        root.querySelector(".cq-list .cq-task[data-task-id]")?.focus({preventScroll:true});
      } else if (action === "delete-schedule") {
        root.querySelector(".cq-schedule-results [data-action='toggle-schedule']")
          ?.focus({preventScroll:true});
      } else {
        [...root.querySelectorAll("button[data-action]")].find((element) =>
          element.dataset.action === action && (element.dataset.id || "") === (id || "")
        )?.focus({preventScroll:true});
      }
    }
  }

  root.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-action]");
    if (!button || !root.contains(button)) return;
    void onAction(button).catch(showError);
  });

  root.addEventListener("input", (event) => {
    if (event.target.id === "cq-rule-search") {
      if (scheduleSearchComposing || event.isComposing) return;
      scheduleSearch = event.target.value.slice(0, 160);
      updateScheduleSearchResults();
      // Only this small section changes while typing; no focus loss or IME reset.
      const resetButton = root.querySelector('[data-action="reset-schedule-filters"]');
      if (!resetButton && scheduleSearch) {
        const footer = root.querySelector(".cq-rule-tools-footer");
        footer?.insertAdjacentHTML("beforeend",
          '<button type="button" data-action="reset-schedule-filters">清除筛选</button>');
      } else if (resetButton && !scheduleSearch &&
          scheduleFilter === "all" && scheduleKind === "all" && scheduleOrder === "original") {
        resetButton.remove();
      }
      return;
    }
    if (event.target.id === "cq-task-search") {
      if (searchComposing || event.isComposing) return;
      queueSearch = event.target.value.slice(0, 160);
      jumpTargetId = null;
      updateSearchResults();
      return;
    }
    if (event.target.id === "cq-favorite-search") {
      if (favoriteSearchComposing || event.isComposing) return;
      favoriteSearch = event.target.value.slice(0, 160);
      const results = root.querySelector(".cq-favorite-results");
      if (results) results.innerHTML = renderFavoriteResults();
      return;
    }
    if (event.target.matches?.(".cq-template-compose textarea[data-template-index]")) {
      const draft = favoriteTemplateDraft;
      const item = favoriteItems.find((favorite) => favorite.id === draft?.id);
      if (!draft || !item || item.text !== draft.sourceText) return;
      const index = Number(event.target.dataset.templateIndex);
      const name = favoriteTemplateFields(item.text).names[index];
      if (!name) return;
      draft.values[name] = event.target.value;
      draft.requestId = crypto.randomUUID();
      if (!favoriteTemplateComposing && !event.isComposing) updateFavoriteTemplatePreview();
      else syncUnsavedDraftIndicators();
      return;
    }
    if (event.target.id === "cq-edit-task-input") editedTaskText = event.target.value;
    if (event.target.id === "cq-queue-draft") {
      queueDraft = event.target.value; queueSubmissionId = null; queueDraftRevision++;
    }
    if (event.target.id === "cq-schedule-draft") {
      scheduleDraft = event.target.value;
      scheduleSubmissionId = null; scheduleDraftRevision++; scheduleDraftDirty = true;
    }
    if (event.target.id === "cq-minutes") {
      minutesDraft = event.target.value;
      scheduleSubmissionId = null; scheduleDraftRevision++; scheduleDraftDirty = true;
    }
    if (event.target.id === "cq-threshold") {
      thresholdDraft = event.target.value;
      scheduleSubmissionId = null; scheduleDraftRevision++; scheduleDraftDirty = true;
    }
    if (event.target.id === "cq-repeats") {
      repeatsDraft = event.target.value;
      scheduleSubmissionId = null; scheduleDraftRevision++; scheduleDraftDirty = true;
    }
    if (event.target.id === "cq-max-pending") {
      maxPendingDraft = event.target.value; settingsDraftRevision++;
    }
    if (event.target.id === "cq-default-minutes") {
      defaultMinutesDraft = event.target.value; settingsDraftRevision++;
    }
    if (event.target.id === "cq-default-repeats") {
      defaultRepeatsDraft = event.target.value; settingsDraftRevision++;
    }
    if (event.target.id === "cq-send-cooldown") {
      cooldownSecondsDraft = event.target.value;
      cooldownDraftRevision++;
      cooldownDraftDirty = hasUnsavedCooldown();
    }
    if (event.target.id === "cq-count-rate-minutes") {
      countRateMinutesDraft = event.target.value;
      countRateDirty = true;
    }
    if (event.target.id === "cq-count-rate-max") {
      countRateMaxDraft = event.target.value;
      countRateDirty = true;
    }
    syncUnsavedDraftIndicators();
  });

  root.addEventListener("compositionstart", (event) => {
    if (event.target.matches?.(".cq-template-compose textarea[data-template-index]")) {
      favoriteTemplateComposing = true;
    }
    if (event.target.id === "cq-task-search") searchComposing = true;
    if (event.target.id === "cq-rule-search") scheduleSearchComposing = true;
    if (event.target.id === "cq-favorite-search") favoriteSearchComposing = true;
  });
  root.addEventListener("compositionend", (event) => {
    if (event.target.matches?.(".cq-template-compose textarea[data-template-index]")) {
      favoriteTemplateComposing = false;
      const draft = favoriteTemplateDraft;
      const item = favoriteItems.find((favorite) => favorite.id === draft?.id);
      const index = Number(event.target.dataset.templateIndex);
      const name = favoriteTemplateFields(item?.text || "").names[index];
      if (draft && name) {
        draft.values[name] = event.target.value;
        draft.requestId = crypto.randomUUID();
      }
      if (favoriteTemplateRenderPending) {
        favoriteTemplateRenderPending = false;
        render();
      } else {
        updateFavoriteTemplatePreview();
      }
      return;
    }
    if (event.target.id === "cq-favorite-search") {
      favoriteSearchComposing = false;
      favoriteSearch = event.target.value.slice(0, 160);
      if (favoriteSearchRenderPending) {
        favoriteSearchRenderPending = false;
        render();
      } else {
        const results = root.querySelector(".cq-favorite-results");
        if (results) results.innerHTML = renderFavoriteResults();
      }
      return;
    }
    if (event.target.id === "cq-rule-search") {
      scheduleSearchComposing = false;
      scheduleSearch = event.target.value.slice(0, 160);
      if (scheduleRenderPending) {
        scheduleRenderPending = false;
        render();
      } else {
        updateScheduleSearchResults();
      }
      return;
    }
    if (event.target.id !== "cq-task-search") return;
    searchComposing = false;
    queueSearch = event.target.value.slice(0, 160);
    jumpTargetId = null;
    if (searchRenderPending) {
      searchRenderPending = false;
      render();
    } else {
      updateSearchResults();
    }
  });

  root.addEventListener("change", (event) => {
    if (event.target.id === "cq-completion-sound") {
      const enabled = event.target.checked;
      const previous = completionSoundEnabled;
      completionSoundEnabled = enabled;
      if (enabled) unlockCompletionAudio();
      void Promise.resolve().then(async () => {
        await chrome.storage.local.set({ [COMPLETION_SOUND_KEY]: enabled });
      }).catch((error) => {
        completionSoundEnabled = previous;
        render();
        showError(error);
      });
      return;
    }
    if (event.target.id === "cq-favorite-category") {
      const value = event.target.value;
      if (value !== "" && value !== "__none__" &&
          (!value.startsWith("cat:") || !favoriteCategories().includes(value.slice(4)))) return;
      favoriteCategoryFilter = value;
      render();
      root.querySelector("#cq-favorite-category")?.focus();
      return;
    }
    if (event.target.id === "cq-rule-kind" || event.target.id === "cq-rule-sort") {
      const isKind = event.target.id === "cq-rule-kind";
      const next = event.target.value;
      if (isKind) {
        if (!["all", "time", "count"].includes(next)) return;
        scheduleKind = next;
      } else {
        if (!["original", "next"].includes(next)) return;
        scheduleOrder = next;
      }
      const controlId = event.target.id;
      render();
      root.querySelector("#" + controlId)?.focus();
      const list = root.querySelector(".cq-schedule-results");
      if (list) list.scrollTop = 0;
      return;
    }
    if (event.target.id === "cq-jump-target") {
      const category = event.target.value;
      event.target.value = "";
      jumpToQueueTask(category);
      return;
    }
    if (event.target.id === "cq-backup-file") {
      const file = event.target.files?.[0];
      event.target.value = "";
      if (file) void restoreBackupFile(file).catch(showError);
      return;
    }
    const imageInput = event.target.closest?.('input[type="file"][id^="cq-"]');
    if (imageInput) {
      const kind = imageInput.id.replace(/^cq-/, "").replace(/-images$/, "");
      void addDraftImages(kind, imageInput.files).catch(showError);
      return;
    }
    if (event.target.id === "cq-schedule-mode") {
      scheduleModeDraft = event.target.value;
      scheduleSubmissionId = null;
      scheduleDraftRevision++; scheduleDraftDirty = true;
      render();
    }
    if (event.target.id === "cq-count-rate-enabled") {
      countRateEnabledDraft = event.target.checked;
      countRateDirty = true;
      syncUnsavedDraftIndicators();
    }
    if (event.target.id === "cq-auto-open") {
      void rpc("AUTO_OPEN", { enabled: event.target.checked }).then(render).catch(showError);
    }
    if (event.target.id === "cq-protect-background") {
      void rpc("PROTECT_BACKGROUND", { enabled: event.target.checked })
        .then(render).catch(showError);
    }
  });

  async function exportConversationBackup() {
    if (backupInProgress) throw new Error("已有备份任务正在运行，请等待完成");
    backupInProgress = true;
    const expectedKey = sessionKey;
    try {
      backupProgress = "正在检查当前对话备份清单…";
      render();
      const result = await rpc("GET_BACKUP_META");
      const meta = result.backup;
      if (meta?.format !== "chatgpt-taskqueue-conversation" ||
          meta.version !== 1 || meta.conversation?.key !== expectedKey ||
          !Array.isArray(meta.images)) {
        throw new Error("插件返回的备份清单无效");
      }
      const {images, ...header} = meta;
      const opening = JSON.stringify(header).slice(0, -1) + ',"images":[';
      const pieces = [opening];
      let bytes = new Blob([opening]).size;
      for (let i = 0; i < images.length; i++) {
        if (!boundHere() || sessionKey !== expectedKey) {
          throw new Error("导出备份期间切换了对话；未生成不完整的文件");
        }
        backupProgress = `正在导出原图 ${i+1}/${images.length}…`;
        render();
        const payload = await rpc("GET_BACKUP_IMAGE", {imageId:images[i].id});
        const image = payload.images?.[0];
        if (payload.images?.length !== 1 || image?.id !== images[i].id ||
            image.name !== images[i].name || image.type !== images[i].type ||
            image.size !== images[i].size ||
            !/^[0-9a-f]{64}$/.test(image.sha256 || "")) {
          throw new Error("导出图片文件与备份清单不一致，已停止导出");
        }
        const segment = (i ? "," : "") + JSON.stringify(image);
        bytes += new Blob([segment]).size;
        if (bytes + 2 > 60 * 1024 * 1024) {
          throw new Error("完整图文备份超过 60 MB，未生成不完整文件");
        }
        pieces.push(segment);
      }
      pieces.push("]}");
      const blob = new Blob(pieces, {type:"application/json;charset=utf-8"});
      if (blob.size > 60 * 1024 * 1024) throw new Error("备份超出 60 MB 上限");
      if (sessionKey !== expectedKey) throw new Error("导出时对话已切换，已取消下载");
      const safeName = String(expectedKey || "chat")
        .replace(/[^a-zA-Z0-9-]/g, "-").slice(0, 55);
      const link = document.createElement("a");
      const target = URL.createObjectURL(blob);
      link.href = target;
      link.download = `chatgpt-queue-${safeName}-${new Date().toISOString().slice(0, 10)}.json`;
      root.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(target), 60_000);
      notification = "本对话图文备份已生成，请妥善保管 JSON 文件";
    } finally {
      backupInProgress = false;
      backupProgress = "";
      render();
    }
  }

  async function restoreBackupFile(file) {
    if (backupInProgress) throw new Error("已有备份任务正在运行，请等待完成");
    backupInProgress = true;
    if (file.size > 60 * 1024 * 1024) {
      backupInProgress = false;
      throw new Error("备份文件超过 60 MB，无法安全恢复");
    }
    let token = null;
    try {
      if (workInProgress || composerActionInProgress) {
        throw new Error("正在发送消息，请等待这一轮完成后再恢复备份");
      }
      const backup = JSON.parse(await file.text());
      const info = backup?.conversation;
      if (backup?.format !== "chatgpt-taskqueue-conversation" ||
          backup.version !== 1 || !Array.isArray(info?.tasks) ||
          !Array.isArray(info?.schedules) || !Array.isArray(backup.images)) {
        throw new Error("所选 JSON 文件不是支持的队列备份");
      }
      const waiting = info.tasks.filter((task) => task.status === "pending").length;
      const uncertain = info.tasks.length - waiting;
      if (!confirm(`确定恢复当前对话备份？\n\n待发送 ${waiting} 条，需核对 ${uncertain} 条，自动规则 ${info.schedules.length} 条。\n\n仅允许恢复到同一对话的空队列。恢复后自动发送暂停，自动规则停用，不会直接重发旧消息。`)) return;
      const expectedKey = sessionKey;
      const images = backup.images;
      const manifest = {...backup, images:images.map((item) => ({
        id:item.id,name:item.name,type:item.type,size:item.size,
        ...(item.sha256 != null ? {sha256:item.sha256} : {}),
      }))};
      const begin = await rpc("RESTORE_BACKUP_BEGIN", {backup:manifest});
      token = begin.backup?.token;
      if (!token) throw new Error("插件未创建备份恢复会话");
      for (let index = 0; index < images.length; index++) {
        if (!boundHere() || sessionKey !== expectedKey) {
          throw new Error("上传备份图片时已切换对话，恢复操作已取消");
        }
        backupProgress = `正在恢复原图 ${index+1}/${images.length}…`;
        render();
        await rpc("RESTORE_BACKUP_IMAGE", {token, image:images[index]});
      }
      const result = await rpc("RESTORE_BACKUP_FINISH", {token});
      token = null;
      if (result.sessionKey !== expectedKey) throw new Error("恢复时对话已变化，请核对当前页面");
      notification = "备份已恢复：请逐条核对队列，再点击「继续」；自动规则需手动启用";
      settingsOpen = true;
    } catch (error) {
      if (token) {
        try { await rpc("RESTORE_BACKUP_ABORT", {token}); }
        catch { /* Worker restart also removes unfinished staging images. */ }
      }
      throw error;
    } finally {
      backupInProgress = false;
      backupProgress = "";
      render();
    }
  }

  root.addEventListener("paste", (event) => {
    const target = event.target.id;
    const kind = target === "cq-queue-draft" ? "queue"
      : target === "cq-schedule-draft" ? "schedule"
      : target === "cq-edit-task-input" ? "task" : null;
    if (!kind) return;
    const files = [...(event.clipboardData?.items || [])]
      .filter((item) => item.type.startsWith("image/"))
      .map((item) => item.getAsFile()).filter(Boolean);
    if (!files.length) return;
    event.preventDefault();
    void addDraftImages(kind, files).catch(showError);
  });

  function stopQueueResize(commit = false) {
    if (!queueResize) return;
    const current = queueResize;
    queueResize = null;
    document.documentElement.style.cursor = current.oldCursor;
    document.documentElement.style.userSelect = current.oldUserSelect;
    root.classList.remove("cq-resizing");
    if (commit && current.moved && boundHere()) {
      void rpc("SAVE_QUEUE_HEIGHT", { height: current.height })
        .then(render).catch(showError);
    } else {
      render();
    }
  }

  root.addEventListener("pointerdown", (event) => {
    const handle = event.target.closest?.(".cq-resize-handle");
    const list = root.querySelector(".cq-list");
    if (!handle || !list || event.button !== 0 || draggingTaskId || queueResize) return;
    event.preventDefault();
    event.stopPropagation();
    queueResize = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startHeight: list.getBoundingClientRect().height,
      height: settings.queueListHeight,
      moved: false,
      oldCursor: document.documentElement.style.cursor,
      oldUserSelect: document.documentElement.style.userSelect,
    };
    root.classList.add("cq-resizing");
    document.documentElement.style.cursor = "ns-resize";
    document.documentElement.style.userSelect = "none";
  });

  window.addEventListener("pointermove", (event) => {
    if (!queueResize || event.pointerId !== queueResize.pointerId) return;
    event.preventDefault();
    const delta = event.clientY - queueResize.startY;
    if (!queueResize.moved && Math.abs(delta) < 3) return;
    queueResize.moved = true;
    queueResize.height = clampQueueHeight(queueResize.startHeight + delta);
    setQueueListHeight(root.querySelector(".cq-list"), queueResize.height);
  }, true);
  window.addEventListener("pointerup", (event) => {
    if (queueResize && event.pointerId === queueResize.pointerId) stopQueueResize(true);
  }, true);
  window.addEventListener("pointercancel", (event) => {
    if (queueResize && event.pointerId === queueResize.pointerId) stopQueueResize();
  }, true);
  window.addEventListener("blur", () => stopQueueResize());

  root.addEventListener("dblclick", (event) => {
    if (!event.target.closest?.(".cq-resize-handle")) return;
    event.preventDefault();
    if (queueResize || settings.queueListHeight === null) return;
    void rpc("SAVE_QUEUE_HEIGHT", { height: null }).then(render).catch(showError);
  });

  function clearTaskDragHighlight() {
    highlightedDropRow?.classList.remove("cq-drop-before", "cq-drop-after");
    highlightedDropRow = null;
  }

  function resetTaskDrag() {
    draggingTaskId = null;
    draggingSessionKey = null;
    clearTaskDragHighlight();
    root.querySelector(".cq-dragging")?.classList.remove("cq-dragging");
  }

  function taskDropTarget(event) {
    if (!draggingTaskId || draggingSessionKey !== sessionKey || !boundHere()) return null;
    const row = event.target.closest?.(".cq-list .cq-task-draggable[data-task-id]");
    if (!row || row.dataset.taskId === draggingTaskId) return null;
    const middle = row.getBoundingClientRect().top + row.getBoundingClientRect().height / 2;
    return { row, id: row.dataset.taskId, position: event.clientY < middle ? "before" : "after" };
  }

  root.addEventListener("focusin", (event) => {
    const row = event.target.matches?.(".cq-list .cq-task[data-task-id]")
      ? event.target : null;
    if (!row) return;
    focusedTaskId = row.dataset.taskId;
    for (const item of root.querySelectorAll(".cq-list .cq-task[data-task-id]")) {
      item.tabIndex = item === row ? 0 : -1;
    }
  });

  root.addEventListener("dragstart", (event) => {
    const row = event.target.closest?.(".cq-list .cq-task-draggable[data-task-id]");
    if (!row || event.target.closest?.("button, input, textarea, select, a, [contenteditable]") ||
        !boundHere() || !event.dataTransfer) return;
    const task = state?.tasks.find((item) => item.id === row.dataset.taskId);
    if (task?.status !== "pending") { event.preventDefault(); return; }
    draggingTaskId = task.id;
    draggingSessionKey = sessionKey;
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("application/x-chatgpt-queue-task", task.id);
    row.classList.add("cq-dragging");
  });

  root.addEventListener("dragover", (event) => {
    if (draggingTaskId) {
      const target = taskDropTarget(event);
      clearTaskDragHighlight();
      if (!target) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      highlightedDropRow = target.row;
      highlightedDropRow.classList.add(target.position === "before" ? "cq-drop-before" : "cq-drop-after");
      return;
    }
    if (!event.target.closest?.("[data-image-zone]") || !event.dataTransfer?.types?.includes("Files")) return;
    event.preventDefault();
  });
  root.addEventListener("drop", (event) => {
    if (draggingTaskId) {
      event.preventDefault();
      event.stopPropagation();
      const target = taskDropTarget(event);
      const sourceId = draggingTaskId;
      resetTaskDrag();
      if (target) {
        void rpc("REORDER_TASK", {
          id: sourceId, targetId: target.id, position: target.position,
        }).then(render).catch(showError);
      } else {
        render();
      }
      return;
    }
    const zone = event.target.closest?.("[data-image-zone]");
    if (!zone) return;
    event.preventDefault();
    event.stopPropagation();
    void addDraftImages(zone.dataset.imageZone, event.dataTransfer.files).catch(showError);
  });
  root.addEventListener("dragend", () => {
    if (!draggingTaskId) return;
    resetTaskDrag();
    render();
  });

  root.addEventListener("keydown", (event) => {
    const settingsTab = event.target.closest?.('.cq-settings-tabs [role="tab"]');
    if (settingsTab && ["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      event.stopPropagation();
      const tabs = [...root.querySelectorAll('.cq-settings-tabs [role="tab"]')];
      const current = tabs.indexOf(settingsTab);
      if (current < 0) return;
      const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 :
        (current + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
      tabs[next].click();
      return;
    }
    if (event.target.id === "cq-rule-search" && !event.isComposing &&
        event.keyCode !== 229 && event.key === "Escape" &&
        (scheduleSearch || scheduleFilter !== "all" ||
         scheduleKind !== "all" || scheduleOrder !== "original")) {
      event.preventDefault();
      event.stopPropagation();
      scheduleSearch = "";
      scheduleFilter = "all";
      scheduleKind = "all";
      scheduleOrder = "original";
      render();
      root.querySelector("#cq-rule-search")?.focus();
      return;
    }
    if (event.target.matches?.(".cq-image-add[role='button']") &&
        ["Enter", " "].includes(event.key) && !event.repeat) {
      event.preventDefault();
      event.stopPropagation();
      event.target.querySelector('input[type="file"]')?.click();
      return;
    }
    const row = event.target.matches?.(".cq-list .cq-task[data-task-id]")
      ? event.target : null;
    if (row && !event.isComposing && event.keyCode !== 229 &&
        !event.ctrlKey && !event.metaKey) {
      const navigation = ["ArrowUp", "ArrowDown", "Home", "End"];
      if (navigation.includes(event.key)) {
        event.preventDefault();
        event.stopPropagation();
        const id = row.dataset.taskId;
        const direction = event.key === "ArrowDown" ? 1 : -1;
        if (event.altKey) {
          if (!["ArrowUp", "ArrowDown"].includes(event.key) ||
              keyboardReorderInProgress || queueFilter !== "all" ||
              queueSearch.trim()) return;
          const pending = state.tasks.filter((item) => item.status === "pending");
          const index = pending.findIndex((item) => item.id === id);
          const neighbor = pending[index + direction];
          if (index < 0 || !neighbor) return;
          keyboardReorderInProgress = true;
          void rpc("REORDER_TASK", {
            id, targetId: neighbor.id,
            position: direction < 0 ? "before" : "after",
          }).then(() => {
            render();
            focusQueueTaskRow(id);
          }).catch(showError).finally(() => { keyboardReorderInProgress = false; });
          return;
        }
        if (event.shiftKey) return;
        const rows = [...root.querySelectorAll(".cq-list .cq-task[data-task-id]")];
        const index = rows.indexOf(row);
        if (index < 0) return;
        const targetIndex = event.key === "Home" ? 0 :
          event.key === "End" ? rows.length - 1 :
          Math.max(0, Math.min(rows.length - 1, index + direction));
        focusQueueTaskRow(rows[targetIndex].dataset.taskId);
        return;
      }
    }
    if (event.target.id === "cq-task-search" && !event.isComposing &&
        event.keyCode !== 229 && event.key === "Escape" &&
        (queueSearch || queueFilter !== "all")) {
      event.preventDefault();
      event.stopPropagation();
      queueSearch = "";
      queueFilter = "all";
      render();
      return;
    }
    if (event.target.closest?.(".cq-resize-handle") &&
        ["ArrowUp", "ArrowDown", "Home", "Escape"].includes(event.key)) {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape") { stopQueueResize(); return; }
      if (queueResize) return;
      const list = root.querySelector(".cq-list");
      if (!list) return;
      const height = event.key === "Home" ? null : clampQueueHeight(
        list.getBoundingClientRect().height +
        (event.key === "ArrowDown" ? 1 : -1) * (event.shiftKey ? 80 : 24)
      );
      if (height === settings.queueListHeight) return;
      void rpc("SAVE_QUEUE_HEIGHT", { height }).then(render).catch(showError);
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter" && event.target.id === "cq-schedule-draft") {
      event.preventDefault();
      const button = root.querySelector('[data-action="save-schedule"]');
      if (button) void onAction(button).catch(showError);
    }
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === "TOGGLE_PANEL") { queueExpanded = !queueExpanded; render(); }
    if (message.type === "QUEUE_WAKE") { void heartbeat(); }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes[COMPLETION_SOUND_KEY] &&
        typeof changes[COMPLETION_SOUND_KEY].newValue === "boolean") {
      completionSoundEnabled = changes[COMPLETION_SOUND_KEY].newValue;
      if (settingsOpen) render();
    }
    if (!changes["cq.state.v2"]) return;
    const store = changes["cq.state.v2"].newValue;
    if (Array.isArray(store?.favorites)) favoriteItems = store.favorites;
    if (store?.settings) {
      const settingsWereDirty = hasUnsavedSettings();
      settings = { ...settings, ...store.settings };
      if (!settingsOpen && !settingsWereDirty) resetSettingsDraft();
    }
    if (!sessionKey || !boundHere()) {
      if (state) render();
      return;
    }
    const updated = store?.conversations?.[sessionKey];
    if (!updated) { render(); return; }
    state = updated;
    clearCompletionIfWorkQueued();
    syncStoredCompletion();
    if (!countRateDirty) resetCountRateDraft();
    if (!cooldownDraftDirty) resetCooldownDraft();
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
    return nativeAttachmentCount(editor) > 0;
  }

  function recordNativeComposerImages(editor, files) {
    if (!editor?.closest("form")) return;
    const selection = [...files].filter((item) => item instanceof File);
    if (!selection.length) return;
    const existing = nativeAttachmentCount(editor) > 0 &&
      nativeComposerImages?.editor === editor &&
      nativeComposerImages.sessionKey === sessionKey ? nativeComposerImages.files : [];
    nativeComposerImages = {
      editor, sessionKey, files: [...existing, ...selection],
      sawPreview: nativeAttachmentCount(editor) > 0,
    };
  }

  // Capture in the earliest phase; ChatGPT may clear input.files before Enter.
  // Do not collect files selected inside our own 图文 panel.
  window.addEventListener("change", (event) => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || input.type !== "file" ||
        root.contains(input) || !input.files?.length) return;
    recordNativeComposerImages(getEditor(), input.files);
  }, true);
  window.addEventListener("paste", (event) => {
    const editor = getEditor();
    if (!editor || (event.target !== editor && !editor.contains(event.target))) return;
    const files = [...(event.clipboardData?.items || [])]
      .filter((item) => item.kind === "file")
      .map((item) => item.getAsFile()).filter(Boolean);
    recordNativeComposerImages(editor, files);
  }, true);
  window.addEventListener("drop", (event) => {
    const editor = getEditor();
    const form = editor?.closest("form");
    if (!form || !form.contains(event.target)) return;
    recordNativeComposerImages(editor, event.dataTransfer?.files || []);
  }, true);
  // If a user removes the selected file before queuing it, the snapshot may
  // safely be released once its native preview disappears.
  window.addEventListener("click", (event) => {
    const editor = getEditor();
    if (nativeComposerImages?.editor !== editor) return;
    const button = event.target.closest?.('button');
    if (!button || root.contains(button)) return;
    if (button === controls().send) {
      // A deliberate native Send takes ownership of its attached files.
      nativeComposerImages = null;
      return;
    }
    if (/remove|delete|移除|删除/i.test([
      button.getAttribute("aria-label"), button.getAttribute("data-testid"),
    ].join(" ")) && nativeAttachmentCount(editor) > 0) {
      nativeComposerImages.sawPreview = true;
    }
  }, true);

  function nativeUploadSnapshot(editor) {
    const previews = nativeAttachmentCount(editor);
    if (!previews) {
      nativeComposerImages = null;
      return [];
    }
    const captured = nativeComposerImages;
    if (captured?.editor === editor && captured.sessionKey === sessionKey) {
      captured.sawPreview = true;
    }
    if (!captured || captured.editor !== editor || captured.sessionKey !== sessionKey ||
        captured.files.length !== previews) {
      throw new Error("原生附件与原图不一致；请清空附件再通过「图文」添加，避免漏图");
    }
    return [...captured.files];
  }

  // ChatGPT can place the native remove button inside a file chip or beside
  // a thumbnail. Only search the native composer, never the extension panel.
  const NATIVE_PREVIEW_SELECTORS = [
    '[data-testid="file-chip"]',
    '[data-testid="composer-attachment-preview"]',
    '[data-testid="attachment-preview"]',
    '[data-testid="image-file-thumbnail"]',
    '[data-testid="file-upload-preview"]',
    '[data-testid="composer-upload-preview"]',
    'img[src^="blob:"], img[src^="data:image/"]',
  ];

  function nativeAttachmentPreviews(editor) {
    const form = editor?.closest("form");
    if (!form) return [];
    for (const selector of NATIVE_PREVIEW_SELECTORS) {
      const visible = [...form.querySelectorAll(selector)]
        .filter((element) => element.getClientRects().length > 0 && !root.contains(element));
      if (visible.length) return visible;
    }
    return [];
  }

  function nativeImageRemoveButton(preview, form, previews) {
    // A global "Remove" or "Clear" search could delete unrelated user content.
    // Stop before reaching the form: only a thumbnail's local card may qualify.
    for (let node = preview, depth = 0; node && node !== form && depth < 5;
         node = node.parentElement, depth++) {
      if (previews.some((other) => other !== preview && node.contains(other))) {
        return null; // Do not guess which image an action in a shared group removes.
      }
      const buttons = [...node.querySelectorAll('button, [role="button"]')]
        .filter((button) => isVisible(button) && !root.contains(button) &&
          button !== controls().send);
      const explicit = buttons.filter((button) => {
        const label = [button.getAttribute("aria-label"), button.getAttribute("title"),
          button.getAttribute("data-testid")].filter(Boolean).join(" ");
        return /(remove|delete|移除|删除|移去|移走)/i.test(label) &&
          !/(all|全部|所有)/i.test(label);
      });
      if (explicit.length === 1) return explicit[0];
      if (explicit.length > 1) return null;
      // Some cards use only an unlabeled × button. Never infer removal from
      // a generic button; the icon must belong to a single local thumbnail.
      const icons = buttons.filter((button) => /^[×✕✖✗]$/.test(button.textContent.trim()) ||
        Boolean(button.querySelector('svg.lucide-x, svg[data-lucide="x"]')));
      if (icons.length === 1 &&
          node.querySelectorAll('img[src^="blob:"], img[src^="data:image/"]').length <= 1) {
        return icons[0];
      }
      if (icons.length > 1) return null;
    }
    return null;
  }

  async function clearNativeComposerImages(editor, files, submittedText) {
    const form = editor?.closest("form");
    if (!form) return false;
    const captured = nativeComposerImages;
    const originalUrl = location.href;
    for (let i = 0; i < files.length; i++) {
      // Abort if the user edits text, adds images, or switches conversations
      // while the persisted attachment previews are being cleared.
      if (!editor.isConnected || sessionKey !== captured?.sessionKey ||
          location.href !== originalUrl || nativeComposerImages !== captured ||
          normalize(editorText(editor)) !== normalize(submittedText) ||
          files.some((file, index) => captured.files[index] !== file) ||
          nativeAttachmentCount(editor) !== files.length - i ||
          nativeUploadBusy(editor)) return false;
      const previews = nativeAttachmentPreviews(editor);
      const remove = previews[0] && nativeImageRemoveButton(previews[0], form, previews);
      if (!remove) break;
      const before = nativeAttachmentCount(editor);
      remove.click();
      for (let wait = 0; wait < 10 && nativeAttachmentCount(editor) >= before; wait++) {
        await sleep(80);
      }
      if (nativeAttachmentCount(editor) !== before - 1) return false;
    }
    const cleared = editor.isConnected && nativeComposerImages === captured &&
      sessionKey === captured?.sessionKey && location.href === originalUrl &&
      nativeAttachmentCount(editor) === 0;
    if (cleared) {
      for (const input of form.querySelectorAll('input[type="file"]')) input.value = "";
      nativeComposerImages = null;
    }
    return cleared;
  }

  function nativeAttachmentCount(editor) {
    return nativeAttachmentPreviews(editor).length;
  }

  function nativeUploadBusy(editor) {
    const form = editor?.closest("form");
    return Boolean(form?.querySelector(
      '[data-testid*="upload-progress"], [data-testid="attachment-loading"], ' +
      '[aria-label*="Uploading"], [aria-label*="上传中"], [aria-busy="true"]'
    ));
  }

  function fileFromSavedImage(image) {
    const parts = image.dataUrl.split(",");
    if (parts.length !== 2 || !parts[0].startsWith(`data:${image.type};base64`)) {
      throw new Error("已保存的图片数据格式无效");
    }
    const binary = atob(parts[1]);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new File([bytes], image.name, { type: image.type });
  }

  async function restoreNativeImages(editor, task) {
    if (!task.images?.length) return;
    const base = nativeAttachmentCount(editor);
    if (base) throw new Error("原生输入框已有附件，拒绝覆盖或合并其他文件");

    // Request one original image at a time. Four 8 MB attachments would turn
    // the former all-at-once RPC into a ~45 MB base64 message, which could be
    // dropped by the extension messaging layer before any image is restored.
    const files = [];
    for (const reference of task.images) {
      if (!boundHere() || state?.activeTaskId !== task.id ||
          state?.halted || !editor.isConnected || nativeAttachmentCount(editor) !== base) {
        throw new Error("读取原图期间队列或原生输入框发生变化，已阻止发送");
      }
      const response = await rpc("GET_TASK_IMAGE", { id: task.id, imageId: reference.id });
      const image = response.images?.[0];
      if (response.images?.length !== 1 || image?.id !== reference.id ||
          image.name !== reference.name || image.type !== reference.type ||
          (reference.size != null && image.size !== reference.size)) {
        throw new Error("队列图片与本地原图不一致，已阻止发送");
      }
      const file = fileFromSavedImage(image);
      if (reference.size != null && file.size !== reference.size) {
        throw new Error("队列图片文件长度不一致，已阻止发送");
      }
      files.push(file);
    }
    if (files.length !== task.images.length) throw new Error("队列图片数量不符");
    const transfer = new DataTransfer();
    files.forEach((file) => transfer.items.add(file));

    // The native input's change event is handled by ChatGPT's own uploader;
    // never fabricate an upload success or directly call undocumented APIs.
    const formInputs = [...(editor.closest("form")?.querySelectorAll('input[type="file"]') || [])];
    const inputs = [...formInputs, ...document.querySelectorAll('input[type="file"]')]
      .filter((input) => !root.contains(input) && !input.disabled);
    const input = inputs.find((element) => element.accept?.includes("image")) ||
      inputs.find((element) => !element.accept || element.accept.includes("*"));
    if (input) {
      input.files = transfer.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
    } else {
      // Some ChatGPT composer revisions support drop but have no file input
      // mounted until the attachment menu opens.
      editor.dispatchEvent(new DragEvent("drop", {
        bubbles: true, cancelable: true, dataTransfer: transfer,
      }));
    }

    // If the native UI cannot prove attachment acceptance, NEVER send text
    // without the requested images. Require a stable preview and Send control.
    let stableSince = 0;
    const until = clock() + 18000;
    while (clock() < until) {
      if (!boundHere() || state.halted || !editor.isConnected || controls().stop) {
        throw new Error("上传图片时对话状态发生变化，已阻止发送");
      }
      if (nativeAttachmentCount(editor) >= base + files.length &&
          !nativeUploadBusy(editor) && isVisible(controls().send)) {
        if (!stableSince) stableSince = clock();
        if (clock() - stableSince >= 1200) return;
      } else {
        stableSince = 0;
      }
      await sleep(200);
    }
    throw new Error("无法确认图片已附加到 ChatGPT；已暂停队列，防止误发纯文本");
  }

  async function queueNativePrompt(editor, text) {
    if (!state) throw new Error("队列还没初始化，请刷新页面");
    const previewCount = nativeAttachmentCount(editor);
    let files = [];
    if (!previewCount && nativeComposerImages?.editor === editor &&
        nativeComposerImages.sessionKey === sessionKey && nativeComposerImages.files.length) {
      if (!nativeComposerImages.sawPreview) {
        throw new Error("图片已选中但尚未显示上传预览；请等待上传完成后入队，避免漏图");
      }
      nativeComposerImages = null; // User removed previously visible attachments.
    }
    if (previewCount) {
      if (nativeUploadBusy(editor)) throw new Error("图片仍在上传中，请上传完成后再入队");
      files = nativeUploadSnapshot(editor);
      if (files.length > 4) throw new Error("每条队列任务最多 4 张图片");
      if (files.some((file) => !["image/png", "image/jpeg", "image/webp", "image/gif"].includes(file.type))) {
        throw new Error("原生附件包含非图片文件，仅支持 PNG、JPEG、WebP、GIF");
      }
    }
    if (!text?.trim() && !files.length) throw new Error("请输入文字或添加图片后再入队");
    const originalKey = sessionKey;
    const originalUrl = location.href;
    const images = await Promise.all(files.map(readImageFile));
    if (!editor.isConnected || originalKey !== sessionKey ||
        normalize(editorText(editor)) !== normalize(text) ||
        nativeAttachmentCount(editor) !== previewCount || nativeUploadBusy(editor) ||
        (files.length && files.some((file, index) => nativeComposerImages?.files[index] !== file))) {
      throw new Error("读取图片期间输入框或附件发生变化，未入队；原始草稿仍保留");
    }
    const sameDraft = nativeSubmission?.editor === editor &&
      nativeSubmission.sessionKey === originalKey && nativeSubmission.text === text &&
      nativeSubmission.files.length === files.length &&
      files.every((file, index) => file === nativeSubmission.files[index]);
    if (!sameDraft) {
      nativeSubmission = {
        editor, sessionKey: originalKey, text,
        files: [...files], requestId: crypto.randomUUID(),
      };
    }

    // Save atomically before touching the editor. A failed persistence call
    // must never lose the original message or the full image bytes.
    await rpc("ENQUEUE", { text, images, requestId: nativeSubmission.requestId });
    // The queue was persisted for the original chat. If the user navigated or
    // changed the composer while the RPC ran, leave their new draft/attachments
    // exactly as they are; clearing them would be irreversible data loss.
    if (!editor.isConnected || sessionKey !== originalKey || location.href !== originalUrl ||
        normalize(editorText(editor)) !== normalize(text) ||
        nativeAttachmentCount(editor) !== previewCount ||
        (files.length && files.some((file,index) => nativeComposerImages?.files[index] !== file))) {
      notification = "任务已保存，但原生输入框或对话已变化；新草稿与附件已保留，请核对后手动清除残留";
      queueExpanded = true;
      render();
      return;
    }
    const imagesCleared = files.length ? await clearNativeComposerImages(editor, files, text) : true;
    const textCleared = !text?.trim() || clearComposerText(editor, text);
    if (!imagesCleared || !textCleared) {
      notification = "任务和图片已保存，但原生输入框未完全清空；请清除残留的附件/文字，避免重复发送。";
    } else {
      nativeSubmission = null;
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

  // Intercept before ChatGPT's editor and form listeners, regardless of
  // whether the native Send arrow is present or the queue is empty.
  // Only Ctrl/Cmd+Enter may invoke native Send; plain Enter always enqueues.
  window.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.shiftKey || event.altKey || event.isComposing || event.keyCode === 229) return;
    const editor = getEditor();
    if (!editor || (event.target !== editor && !editor.contains(event.target))) return;
    if (root.contains(event.target) || suggestionPopupOpen()) return;

    // Cancel the native send synchronously, before any async storage calls.
    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.repeat) return;
    const text = editorText(editor);
    const steer = event.ctrlKey || event.metaKey;
    if (!text?.trim() && !hasComposerAttachments(editor)) {
      return;
    }
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
      return queueNativePrompt(editor, text);
    };
    void run()
      .catch(showError)
      .finally(() => { composerActionInProgress = false; });
  }, true);

  async function sendTask(task) {
    if (workInProgress) return;
    workInProgress = true;
    let clicked = false;
    let imageAttempted = false;
    let editor = null;
    try {
      if (!boundHere() || state.halted) throw new Error("当前对话已切换或用户已停止回复");
      const internalHandoff = ["handoff_summary","handoff_intro"].includes(task.kind);
      const composerReady = isVisible(controls().voice) ||
        (internalHandoff && handoffComposerReady(conversationSnapshot()));
      editor = getEditor();
      if (!editor || normalize(editorText(editor)) || controls().stop ||
          !composerReady || hasComposerAttachments(editor)) {
        throw new Error("原生输入框或回复结束信号尚未就绪，稍后再发");
      }
      if (task.text) insertText(editor, task.text);
      if (task.images?.length) {
        imageAttempted = true;
        await restoreNativeImages(editor, task);
      }

      let send = null;
      for (let attempt = 0; attempt < 12; attempt++) {
        send = controls().send;
        if (isVisible(send) && !controls().stop) break;
        await sleep(300);
      }
      if (!isVisible(send) || controls().stop || !boundHere() || state.halted) {
        throw new Error("发送按钮不可用或对话已停止，拒绝自动发送");
      }
      if (task.kind === "handoff_summary" && state.handoff?.cancelRequested) {
        // A cancellation arrived while the native editor was being prepared.
        // We have not clicked Send: safely release the special queue row.
        if (normalize(editorText(editor)) === normalize(task.text)) {
          clearComposerText(editor,task.text);
        }
        await rpc("RELEASE_CLAIM",{id:task.id});
        notification = "已取消本轮接力，没有发送总结";
        return;
      }
      if (task.images?.length && nativeAttachmentCount(editor) < task.images.length) {
        throw new Error("图片预览消失，已阻止发送");
      }
      resetVoiceReadiness();
      handoffComposerIdleSince = 0;
      handoffReplyProbe = null;
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
      if (!clicked && !imageAttempted && boundHere()) {
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
      if (imageAttempted && !clicked) {
        notification = "图片未确认上传，已暂停自动接力。请检查原生输入框中的残留图片和文字。";
      }
      showError(error);
    } finally {
      workInProgress = false;
    }
  }

  async function navigateForHandoff(voiceReady, snapshot) {
    const handoff = state?.handoff;
    if (handoff?.phase !== "opening" || handoff.cancelRequested || !boundHere()) return false;
    // The expected destination is produced by the background from the
    // current project's URL, never from untrusted AI-generated summary text.
    const url = new URL(handoff.projectUrl || "",location.href);
    if (url.origin !== location.origin ||
        !/^\/g\/g-p-[a-zA-Z0-9-]+\/project$/.test(url.pathname)) return false;
    if (!(voiceReady || handoffComposerReady(snapshot)) ||
        composerActionInProgress || workInProgress ||
        hasComposerAttachments(getEditor())) return false;
    await rpc("HANDOFF_NAVIGATE",{userCount:conversationSnapshot().userCount});
    if (state?.handoff?.phase !== "navigating") return false;
    location.assign(url.href); // Same Edge tab, never a new background tab.
    return true;
  }

  async function heartbeat() {
    // Track the native square Stop button even for chats without a queue.
    setTabRunning(tabGenerationRunning());
    if (heartbeatInProgress || !state) return;
    heartbeatInProgress = true;
    try {
      mountNearComposer();
      if (location.href !== lastLocation) {
        lastLocation = location.href;
        lastPagePulseAt = 0;
        // A route change is a different conversation; no stale unread marker
        // or pending completion from the previous chat may carry over.
        clearTabRedDot();
        clearTabCompleted();
        queueCompletionPending = false;
        completionSoundPlayed = false;
        lastReplySnapshot = null;
        replyCompletionWatch = null;
        resetVoiceReadiness();
        handoffComposerIdleSince = 0;
        handoffReplyProbe = null;
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

      if (!boundHere()) return;
      const snapshot = conversationSnapshot();
      if (snapshot.userCount > 0 && !state.firstSeenAt) {
        await rpc("HELLO", {
          lastUserText:snapshot.lastUserText,userCount:snapshot.userCount,
        });
        updateHandoffHover();
      }
      const firstMessageAt = nativeFirstMessageAt(snapshot.firstUserElement);
      if (firstMessageAt && (!state.firstMessageAt || firstMessageAt < state.firstMessageAt)) {
        // This is a metadata-only observation; it must never enqueue a task
        // or guess the date when ChatGPT doesn't expose one.
        await rpc("OBSERVE_FIRST_MESSAGE_AT",{firstMessageAt});
        updateHandoffHover();
      }
      reportPagePulse(snapshot);
      if (composerActionInProgress) return;
      // One native Voice Mode readiness signal governs BOTH ordinary queue
      // dispatch, scheduled task delivery, and the tab unread indicator.
      const voiceReady = updateVoiceReadiness(snapshot);
      observeReplyCompleted(snapshot, voiceReady);
      if (await navigateForHandoff(voiceReady,snapshot)) return;
      if (queueCompletionPending && voiceReady) {
        markTabCompletedIfDrained(voiceReady);
        queueCompletionPending = false;
        if (!state?.activeTaskId && !state?.steeringTaskId && !state?.halted) {
          await rpc("REPLY_COMPLETED", { viewed: isTabViewed() });
        }
      }
      const idle = updateIdle(snapshot, voiceReady);
      const active = state.tasks.find((item) => item.id === state.activeTaskId);

      if (state.halted) {
        // ChatGPT can return to its normal Voice Mode button after a transport
        // error even though an old plugin failure/timeout has locked the queue.
        // Automatically retire only that uncertain attempt and continue the
        // remaining pending work. Never override a user's native Stop.
        if (voiceReady && ["failure", "timeout", "uncertain", "steer_unconfirmed"]
          .includes(state.haltReason)) {
          await rpc("RECOVER_ON_VOICE", {
            voiceReady: true,
            voiceStableMs: clock() - voiceReadySince,
            editorEmpty: Boolean(getEditor() && !normalize(editorText(getEditor()))),
            busy: snapshot.busy,
          });
          if (!state.halted) {
            notification = "";
            render();
          }
          return;
        }
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
        const handoffEvidence = handoffCompletionEvidence(active,snapshot);
        const waveformComplete = readyToComplete(active, voiceReady);
        // Even with the traditional Voice proof, do not immediately parse a
        // partially hydrated handoff document. Give the actual assistant
        // reply a moment to settle and to render its start/end boundaries.
        const summaryStillLoading = active.kind === "handoff_summary" &&
          !state.handoff?.cancelRequested && waveformComplete &&
          !(handoffEvidence.replyStableMs >= 1800 &&
            (handoffEvidence.newerAssistant || clock() - voiceReadySince >= 15000));
        if (handoffEvidence.ready || waveformComplete && !summaryStillLoading) {
          await rpc("FINISHED", {
            id: active.id,
            viewed: isTabViewed(),
            voiceReady: true,
            voiceStableMs: clock() - voiceReadySince,
            editorEmpty: Boolean(getEditor() && !normalize(editorText(getEditor()))),
            busy: snapshot.busy,
            ...(handoffEvidence.ready ? {
              handoffReady:true, handoffNativeIdle:true,
              handoffResponseConfirmed:handoffEvidence.responseConfirmed,
              handoffIdleStableMs:handoffEvidence.idleStableMs,
              handoffReplyStableMs:handoffEvidence.replyStableMs,
            } : {}),
            ...(active.kind === "handoff_summary" ? {userCount:snapshot.userCount} : {}),
            ...(active.kind === "handoff_summary"
              ? {
                handoffSummary: handoffEvidence.summary ||
                  extractHandoffReply(snapshot,state?.handoff?.requestId).text,
                handoffLastUserText:snapshot.lastUserText,
              } : {}),
          });
          render();
        }
        return;
      }

      const handoffNeedsDispatch = state.handoff?.phase === "due" ||
        Boolean(state.handoffSourceKey &&
          state.tasks.some((task) => task.kind === "handoff_intro" &&
            task.status === "pending"));
      const dispatchReady = idle ||
        (handoffNeedsDispatch && handoffComposerReady(snapshot));
      if (state.queuePaused || active || !dispatchReady ||
          (temporaryNewChat() && snapshot.userCount > 0)) return;
      if (clock() - lastClaimAttempt < 1800) return;
      lastClaimAttempt = clock();
      const claimed = await rpc("CLAIM", {
        ready: true,
        userCount: snapshot.userCount,
        lastUserId: snapshot.lastUserId,
        assistantCount:snapshot.assistantCount,
        lastAssistantId:snapshot.lastAssistantId,
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
      await loadCompletionSoundPreference();
      const snapshot = conversationSnapshot();
      setTabRunning(tabGenerationRunning());
      resetVoiceReadiness();
      lastReplySnapshot = snapshot;
      clearTabRedDot();
      await rpc("HELLO", {
        lastUserText:snapshot.lastUserText,userCount:snapshot.userCount,
      });
      acknowledgeViewedTab();
      try { await favoriteRpc("GET_FAVORITES"); }
      catch (error) { console.warn("[ChatQueue] 收藏夹加载失败", error); }
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
