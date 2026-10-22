/* global chrome */
"use strict";

(() => {
  if (document.getElementById("cq-extension-root")) return;

  const POLL_MS = 1300;
  const PAGE_PULSE_MS = 8000;
  // Voice Mode button (the waveform button, NOT the microphone dictation
  // button) is the shared ready signal for manual and timed queue dispatch.
  const VOICE_READY_STABLE_MS = 1700;
  const NATIVE_ERROR_STABLE_MS = 1700;
  const CONVERSATION_LOAD_REFRESH_INTERVAL_MS = 60000;
  const CONVERSATION_LOAD_RECOVERY_KEY = "cq.conversationLoadRecovery.v1:";
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
  const DELETE_TASK_CONFIRMATION_KEY = "cq.deleteTask.confirmedAt.v1";
  const DELETE_TASK_CONFIRMATION_WINDOW_MS = 24 * 60 * 60 * 1000;
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
  let currentTabId = null;
  let dispatchBlockedReason = "";
  let projectVisitUrl = null;
  let projectVisitId = null;
  let extensionContextGone = false;
  let legacyUnboundCount = 0;
  let settings = {
    maxPending: 100, protectBackground: true,
    defaultIntervalMinutes: 30, defaultRepeatCount: -1,
    queueListHeight: null,
  };
  let queueExpanded = true;
  let queueFilter = "all";
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
  let panelImeEditor = null;
  let panelImeUrl = "";
  let panelImeSession = null;
  let panelImeRenderPending = false;
  let panelImeFlushScheduled = false;
  let focusedTaskId = null;
  const expandedTaskIds = new Set();
  const expandedErrorIds = new Set();
  let schedulerOpen = false;
  const AUTO_ADVANCED_STORAGE_KEY = "cq.autoAdvancedExpanded.v1";
  let autoAdvancedOpen = false;
  try { autoAdvancedOpen = localStorage.getItem(AUTO_ADVANCED_STORAGE_KEY) === "1"; }
  catch { /* The panel still works when site storage is unavailable. */ }

  function needsDeleteTaskConfirmation() {
    try {
      const confirmedAt = Number(localStorage.getItem(DELETE_TASK_CONFIRMATION_KEY));
      const now = Date.now();
      return !Number.isFinite(confirmedAt) || confirmedAt <= 0 ||
        confirmedAt > now || now - confirmedAt >= DELETE_TASK_CONFIRMATION_WINDOW_MS;
    } catch {
      // If storage is unavailable, fail safely by asking every time.
      return true;
    }
  }

  function rememberDeleteTaskConfirmation() {
    try {
      localStorage.setItem(DELETE_TASK_CONFIRMATION_KEY, String(Date.now()));
    } catch { /* No persistent suppression if site storage is blocked. */ }
  }
  let schedulerView = "list";
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
  let handoffOpen = false;
  let handoffMinutesDraft = "120";
  let handoffRepeatsDraft = "-1";
  let handoffDraftDirty = false;
  let handoffDraftRevision = 0;
  let handoffSaving = false;
  let settingsPage = "cooldown";
  let diagnosticsOpen = false;
  let handoffDebugRuns = [];
  let handoffDebugLoaded = false;
  let handoffDebugLoading = false;
  let handoffDebugReportMeta = {};
  const handoffDebugSignals = new Map();
  let handoffRecoveryProbe = null;
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
  let queueWakeTimer = null;
  let queueWakeAt = 0;
  let queueWakePending = false;
  let sendPageUrl = location.href;
  let sendPageEpoch = 0;
  let navigationPendingUntil = 0;
  let immediateDispatchScope = null;
  let lastPagePulseAt = 0;
  let voiceReadySignature = "";
  let voiceReadySince = 0;
  let nativeErrorFirstSeenAt = 0;
  let conversationLoadErrorUrl = null;
  let conversationLoadErrorSince = null;
  let conversationLoadHealthySince = null;
  let conversationLoadReloadIssued = false;
  let conversationLoadFailureKind = null;
  let handoffComposerIdleSince = 0;
  let handoffReplyProbe = null;
  const handoffIntroExpansionAttempts = new WeakMap();
  const handoffComposerRecords = new Map();
  let handoffComposerWriteDepth = 0;
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

  function resetHandoffDraft() {
    handoffMinutesDraft = String(state?.handoff?.intervalMinutes ?? 120);
    handoffRepeatsDraft = String(state?.handoff?.repeatCount ?? -1);
    handoffDraftDirty = false;
    handoffDraftRevision++;
  }

  function hasUnsavedPageDraft() {
    return hasQueueDraft() || hasUnsavedAutomation() ||
      hasUnsavedSettings() || hasUnsavedCooldown() || handoffDraftDirty || hasUnsavedFavoriteTemplate() ||
      Boolean(editingTask || imageSelectionInProgress || panelImeEditor);
  }

  function syncUnsavedDraftIndicators() {
    // The hidden marker lets a newly updated extension avoid refreshing the
    // page when an editor is closed but its unsaved data is still in memory.
    // Mirror it on <html>: the panel is intentionally detached when the
    // native composer disappears, but its drafts are still in memory.
    const unsaved = hasUnsavedPageDraft() ? "true" : "false";
    root.dataset.cqUnsavedDraft = unsaved;
    if (document.documentElement) document.documentElement.dataset.cqUnsavedDraft = unsaved;
    for (const [kind, dirty] of [
      ["queue",hasQueueDraft() || Boolean(editingTask)],
      ["schedule",hasUnsavedAutomation()],
      ["settings",hasUnsavedSettings() || hasUnsavedCooldown()],
      ["favorite",hasUnsavedFavoriteTemplate()],
      ["handoff",handoffDraftDirty],
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
      ["toggle-handoff","接力设置",handoffDraftDirty],
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
    const handoffHint = root.querySelector(".cq-draft-hint[data-draft-hint='handoff']");
    if (handoffHint) handoffHint.hidden = !handoffDraftDirty;
    const discardHandoff = root.querySelector('[data-action="discard-handoff-draft"]');
    if (discardHandoff) discardHandoff.hidden = !handoffDraftDirty;
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

  function isProjectOverview(url = location.href) {
    const normal = validUrl(url);
    return Boolean(normal &&
      /^\/g\/g-p-[a-zA-Z0-9-]+(?:\/project)?$/.test(new URL(normal).pathname));
  }

  function projectPageId(url) {
    const normal = validUrl(url);
    if (!normal) return null;
    const match = new URL(normal).pathname.match(/^\/g\/(g-p-[a-zA-Z0-9-]+)(?:\/|$)/);
    if (!match) return null;
    return match[1].replace(/^(g-p-[a-f0-9]{32})(?:-[a-z0-9-]+)?$/i, "$1");
  }

  function boundHere() {
    if (!state || !sessionKey || !validUrl(location.href)) return false;
    if (isProjectOverview()) {
      return sessionKey.startsWith("draft:") && isProjectOverview(state.url) &&
        new URL(state.url).origin === new URL(validUrl(location.href)).origin &&
        projectPageId(state.url) === projectPageId(location.href) &&
        (!state.projectVisitId || state.projectVisitId === projectVisitId);
    }
    const current = pageChatKey(location.href);
    if (!current && isProjectOverview(state.url)) return false;
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

  const NATIVE_COMPOSER_EDITOR =
    '#prompt-textarea, [data-testid="prompt-textarea"], [data-testid="composer-input"], ' +
    '[data-composer-markdown][role="textbox"]';
  const FOREIGN_EDITOR_SURFACE =
    '[role="dialog"], [aria-modal="true"], aside, [role="menu"],' +
    '[data-testid^="conversation-turn-"], [data-message-author-role],' +
    '[data-turn="assistant"], [data-turn="user"], [data-conversation-role],' +
    '[data-content-search-unit-key$=":user"], [data-content-search-unit-key$=":assistant"],' +
    '[data-user-message-bubble], [data-markdown-text-style="assistant-message"],' +
    '[data-testid="user-message"], [data-testid="message-content"],' +
    '[data-testid*="writing-block"], [data-testid*="artifact"], .markdown';

  function outsideForeignEditor(element) {
    return Boolean(element && element.isConnected && !root.contains(element) &&
      !element.closest(FOREIGN_EDITOR_SURFACE) &&
      // Hidden transition layers can retain nonzero geometry and the old
      // composer identifiers. Apply the same effective visibility rules as
      // the native readiness checks before allowing an editor to be selected.
      isRendered(element));
  }

  function isNativeVoiceButton(button) {
    const testId = (button.getAttribute("data-testid") || "").toLowerCase();
    const names = [button.getAttribute("aria-label"), button.getAttribute("title")]
      .filter(Boolean).map((name) => name.trim());
    // Use the same recognizer to locate the editor and to check readiness.
    // The dictation microphone must never qualify as Voice Mode.
    if (/dictat|transcrib|microphone|听写|录音|麦克风|语音输入/i.test(`${testId} ${names.join(" ")}`)) return false;
    return /^(?:composer-)?(?:start-)?voice(?:-mode|-chat)?-button$|^voice-mode-button$/i.test(testId) ||
      names.some((name) =>
        /^(?:(?:start|use|open|begin|enter)\s+(?:a\s+)?)?(?:advanced\s+)?voice(?:\s+(?:mode|chat|conversation))?(?:\s+button)?$/i.test(name) ||
        /^(?:(?:开始|开启|启动|打开|进入|使用)\s*)?(?:高级)?语音(?:模式|聊天|对话|通话)?(?:按钮)?$/i.test(name));
  }

  function nativeComposerAction(frame) {
    return [...frame.querySelectorAll("button")].some((button) => {
      if (!isVisible(button) || button.closest(FOREIGN_EDITOR_SURFACE)) return false;
      const testId = button.getAttribute("data-testid") || "";
      const label = button.getAttribute("aria-label") || button.getAttribute("title") || "";
      return isNativeVoiceButton(button) ||
        /^(send-button|composer-submit-button|composer-send-button|stop-button|composer-stop-button)$/i.test(testId) ||
        /^(send|send message|send prompt|发送|发送消息|发送提示词|stop generating|停止生成)$/i.test(label.trim());
    });
  }

  function nativeComposerCandidate(editor) {
    if (!outsideForeignEditor(editor) ||
        editor.disabled ||
        !editor.matches('textarea, input, [contenteditable="true"]') ||
        !editor.getClientRects().length) return false;
    // ChatGPT's writing blocks and message editors are also contenteditable.
    // A real composer must have its own native form/composer container.
    const frame = editor.closest('form, [data-testid="composer"], [data-chatgpt-composer]');
    if (!outsideForeignEditor(frame)) return false;
    if (editor.matches(NATIVE_COMPOSER_EDITOR) ||
        editor.closest(NATIVE_COMPOSER_EDITOR)) return true;
    // Compatibility fallback for a renamed main editor: accept an unnamed
    // field ONLY inside a form with a recognizable native ChatGPT action.
    if (!editor.closest("form")) return false;
    return nativeComposerAction(frame);
  }

  function getEditor() {
    // Do not take the first matching node blindly: ChatGPT can render an
    // editor with the same identifier in a temporary writing/message window.
    for (const specific of document.querySelectorAll(NATIVE_COMPOSER_EDITOR)) {
      const editor = specific.matches('textarea, input, [contenteditable="true"]')
        ? specific : specific.querySelector('[contenteditable="true"], textarea');
      if (nativeComposerCandidate(editor)) return editor;
    }
    return [...document.querySelectorAll('form [contenteditable="true"], form textarea')]
      .find(nativeComposerCandidate) || null;
  }

  function nativeComposerAnchor() {
    const editor = getEditor();
    if (editor) return editor.closest('form, [data-testid="composer"], [data-chatgpt-composer]') ||
      editor.parentElement;
    // An empty composer may render a placeholder/temporarily non-editable
    // element and no Send button. Displaying the queue must NOT depend on a
    // message being typed; sending still uses the stricter getEditor().
    for (const specific of document.querySelectorAll(NATIVE_COMPOSER_EDITOR)) {
      // A hidden editor may remain in a visible form during React hydration.
      // Checking only its form's geometry would mount the panel on a stale UI.
      if (!outsideForeignEditor(specific) || !specific.getClientRects().length) continue;
      const frame = specific.closest('form, [data-testid="composer"], [data-chatgpt-composer]');
      if (frame && outsideForeignEditor(frame) && frame.getClientRects().length) return frame;
      if (specific.getClientRects().length && specific.closest("main") &&
          outsideForeignEditor(specific.parentElement)) return specific.parentElement;
    }
    // Stable composer containers also exist before their editor/Send action
    // hydrates. They can live outside main in ChatGPT's bottom layout.
    const stableFrames = document.querySelectorAll(
      '[data-testid="composer"], [data-chatgpt-composer], form[data-type="unified-composer"]'
    );
    for (const frame of stableFrames) {
      if (!outsideForeignEditor(frame) || !frame.getClientRects().length) continue;
      const knownEditors = [...frame.querySelectorAll(NATIVE_COMPOSER_EDITOR)];
      if (knownEditors.length && !knownEditors.some((element) =>
        outsideForeignEditor(element) && element.getClientRects().length)) continue;
      return frame;
    }
    // An unnamed empty editor may only expose dictation, with no Send or
    // Voice Mode button. This fallback is for DISPLAY ONLY: do not loosen
    // getEditor(), controls() or the Voice-based sending readiness checks.
    return [...document.querySelectorAll('form')].find((frame) => {
      if (!outsideForeignEditor(frame) || !frame.getClientRects().length ||
          ![...frame.querySelectorAll('textarea, [contenteditable], [role="textbox"]')]
            .some((field) => outsideForeignEditor(field) && field.getClientRects().length)) return false;
      if (nativeComposerAction(frame)) return true;
      return [...frame.querySelectorAll("button")].some((button) => {
        if (!isVisible(button) || button.closest(FOREIGN_EDITOR_SURFACE)) return false;
        const testId = button.getAttribute("data-testid") || "";
        const label = button.getAttribute("aria-label") || button.getAttribute("title") || "";
        return /^(?:composer-)?(?:speech|dictation|microphone)-button$/i.test(testId) ||
          /^(?:(?:start|use|open)\s+)?(?:dictation|dictate)(?:\s+button)?$|^(?:开始|开启)?(?:听写|语音输入|录音|麦克风)$/i.test(label.trim());
      });
    }) || null;
  }

  function mountNearComposer() {
    let anchor = nativeComposerAnchor();
    if (!anchor) {
      // When a composer is replaced by a writing block or a transient modal,
      // detach the old panel instead of leaving it captured in that surface.
      root.remove();
      return false;
    }
    if (!anchor?.parentElement || anchor.closest(FOREIGN_EDITOR_SURFACE)) {
      root.remove();
      return false;
    }

    // A horizontally laid-out parent cannot host another full-width column.
    const parentStyle = getComputedStyle(anchor.parentElement);
    if (parentStyle.display === "flex" && parentStyle.flexDirection.startsWith("row")) {
      anchor = anchor.parentElement;
    }
    if (!anchor.parentElement || anchor === root || root.contains(anchor) ||
        anchor.closest(FOREIGN_EDITOR_SURFACE)) {
      root.remove();
      return false;
    }
    if (root.parentElement !== anchor.parentElement || root.nextElementSibling !== anchor) {
      anchor.insertAdjacentElement("beforebegin", root);
    }
    return true;
  }

  function editorText(editor) {
    if (!editor) return "";
    return editor.matches("textarea, input") ? editor.value : editor.innerText;
  }

  // Keep aligned with CQHandoff.textMatch in the worker's pure helper.
  function handoffTextMatch(expected, observed) {
    const first = Array.from(String(expected || "").replace(/\s+/g," ").trim());
    const second = Array.from(String(observed || "").replace(/\s+/g," ").trim());
    const extraChars = Math.max(0,second.length-first.length);
    let matches = first.length > 0 && second.length >= first.length && extraChars <= 100;
    if (matches) {
      let position = 0;
      for (const character of second) if (position < first.length && character === first[position]) position++;
      matches = position === first.length;
    }
    return {matches,extraChars,usedTolerance:matches && extraChars > 0};
  }

  function pruneHandoffComposerRecords() {
    for (const id of handoffComposerRecords.keys()) {
      if (!state?.tasks.some((task) => task.id === id)) handoffComposerRecords.delete(id);
    }
  }

  function rememberHandoffComposer(task, editor) {
    const record = {editor, url:validUrl(location.href), sessionKey,
      userEdited:false, clicked:false};
    handoffComposerRecords.set(task.id, record);
    return record;
  }

  function matchingHandoffComposer(task, editor = getEditor()) {
    if (!task || !["pending", "dispatching"].includes(task.status) ||
        !["handoff_summary", "handoff_intro"].includes(task.kind) || task.images?.length ||
        !boundHere() || state.halted || !editor?.isConnected || getEditor() !== editor ||
        hasComposerAttachments(editor) || nativeUploadBusy(editor) ||
        !handoffTextMatch(task.text,editorText(editor)).matches) return false;
    if (task.kind === "handoff_intro" ? !state.handoffSourceKey || !state.handoffToken ||
        !isProjectOverview() || projectPageId(state.url) !== projectPageId(location.href) :
        state.handoffSourceKey || !["queued", "summarizing"].includes(state.handoff?.phase) ||
        state.handoff?.cancelRequested) return false;
    const record = handoffComposerRecords.get(task.id);
    return !record?.userEdited && !record?.clicked;
  }

  function preparedHandoffTask(editor = getEditor()) {
    if (!state || state.activeTaskId || state.steeringTaskId) return null;
    const task = state.tasks.find((item) => item.status === "pending");
    return matchingHandoffComposer(task, editor) ? task : null;
  }

  function retryableUnsentHandoff() {
    if (!state?.handoffSourceKey || !state.handoffToken || !state.handoffQueueId ||
        !boundHere() || !isProjectOverview() || state.activeTaskId || state.steeringTaskId ||
        state.queuePaused || state.haltReason === "user" || state.tasks.length !== 1) return null;
    const task = state.tasks[0];
    if (task.kind !== "handoff_intro" || task.status !== "pending" || task.images?.length ||
        task.sentAt != null || task.sendArmedAt != null) return null;
    const editor = getEditor();
    if (!editor || hasComposerAttachments(editor) || nativeUploadBusy(editor) || nativeGenerationRunning()) return null;
    return state.halted || normalize(editorText(editor)) && !matchingHandoffComposer(task,editor) ? task : null;
  }

  // Keep real user edits sticky across RELEASE_CLAIM -> retry, including an
  // edit followed by undo back to the identical text. Our synchronous editor
  // writes are explicitly marked, so execCommand's own input isn't user work.
  function recordTrustedHandoffEdit(event) {
    if (!event.isTrusted || handoffComposerWriteDepth || !state ||
        !(event.target instanceof Element) || root.contains(event.target)) return;
    const editor = getEditor();
    if (!editor || !(event.target === editor || editor.contains(event.target))) return;
    for (const task of state.tasks) {
      if (!["pending", "dispatching"].includes(task.status) ||
          !["handoff_summary", "handoff_intro"].includes(task.kind)) continue;
      let record = handoffComposerRecords.get(task.id);
      const sameOwner = record && record.url === validUrl(location.href) && record.sessionKey === sessionKey;
      if (!sameOwner && handoffTextMatch(task.text,editorText(editor)).matches) {
        record = rememberHandoffComposer(task, editor);
      } else if (!sameOwner) continue;
      record.userEdited = true;
      record.editor = editor;
    }
  }
  for (const type of ["beforeinput", "input", "paste", "drop", "compositionstart"]) {
    document.addEventListener(type, recordTrustedHandoffEdit, true);
  }

  function isRendered(element) {
    if (!element?.isConnected || !element.getClientRects().length ||
        element.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
    const style = getComputedStyle(element);
    if (style.visibility !== "visible" || style.contentVisibility === "hidden" ||
        Number(style.opacity) <= 0.01) {
      return false;
    }
    // Opacity is not inherited by computedStyle(child): a fading parent can
    // hide a voice/Stop button while it still has a nonzero client rect.
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      const parentStyle = getComputedStyle(parent);
      if (parentStyle.visibility !== "visible" ||
          parentStyle.contentVisibility === "hidden" ||
          Number(parentStyle.opacity) <= 0.01) return false;
    }
    return true;
  }

  function isVisible(element) {
    // A non-interactive Voice/Send button is not a readiness signal, but a
    // painted Stop button still means the current generation is unfinished.
    return isRendered(element) && !element.disabled && !element.matches(":disabled") &&
      !element.closest('[inert], [aria-disabled="true"]') &&
      (!element.matches('button, [role="button"]') ||
        getComputedStyle(element).pointerEvents !== "none");
  }

  function isNativeStopButton(button, composer = nativeComposerAnchor()) {
    if (!outsideForeignEditor(button) || !composer) return false;
    const testId = button.getAttribute("data-testid") || "";
    const label = button.getAttribute("aria-label") || button.getAttribute("title") || "";
    const byId = /(?:^|-)stop-button$|composer-stop-button/i.test(testId);
    const byLabel = /^(?:stop(?:\s+(?:generating|generation|response|responding|streaming))?|停止(?:生成|回复|回答|响应)?|结束生成)$/i.test(label.trim());
    const buttonFrame = button.closest('form, [data-testid="composer"], [data-chatgpt-composer]');
    const insideComposer = composer.contains(button) ||
      Boolean(buttonFrame?.contains(composer));
    // During tool calls a labelled Stop may briefly move outside the form.
    // Never treat a Stop control in a different form, dialog, writing block
    // or message as the native generation control.
    const floatingStop = !buttonFrame && Boolean(button.closest("main")) &&
      (byId || (byLabel && /(?:生成|回复|回答|响应|generation|generating|responding|streaming)/i.test(label)));
    if (!insideComposer && !floatingStop) return false;
    if (byId || byLabel) return true;
    // An unlabelled square glyph must stay within the native composer.
    return insideComposer && [...button.querySelectorAll("svg.icon-primary-action > path")]
      .some((path) => (path.getAttribute("d") || "").startsWith(NATIVE_STOP_ICON_PREFIX));
  }

  function controls() {
    // Prefer only buttons in this composer. A generated answer may include
    // other clickable "Send" buttons which must never be used by the queue.
    const form = getEditor()?.closest('form, [data-testid="composer"], [data-chatgpt-composer]');
    const composer = form || nativeComposerAnchor();
    const buttons = [...(form?.querySelectorAll("button") || [])]
      .filter((button) => !root.contains(button));
    // The stop control sometimes moves outside the composer during tool calls.
    const stop = buttons.find((button) => isNativeStopButton(button, composer) && isRendered(button)) ||
      [...document.querySelectorAll("main button, button[data-testid='stop-button']")]
        .find((button) => isNativeStopButton(button, composer) && isRendered(button));
    const send = buttons.find((button) => {
      const testId = button.getAttribute("data-testid") || "";
      const name = button.getAttribute("aria-label") || button.getAttribute("title") || "";
      return isVisible(button) &&
        (/^(send-button|composer-submit-button|composer-send-button)$/.test(testId) ||
        /^(send|send message|send prompt|发送|发送消息|发送提示词)$/.test(name.trim().toLowerCase())) && !isNativeStopButton(button, composer);
    });
    // ChatGPT distinguishes the waveform "Start Voice" from the adjacent
    // microphone "Start dictation". Never use the dictation mic as ready.
    const voice = buttons.find((button) => isNativeVoiceButton(button) && isVisible(button)) ||
      [...(form?.parentElement?.querySelectorAll("button") || [])]
        .find((button) => outsideForeignEditor(button) && isVisible(button) &&
          (!button.closest("form") || button.closest("form") === form ||
            button.closest("form")?.contains(form)) && isNativeVoiceButton(button));
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
      element?.getAttribute("data-conversation-role") ||
      element?.getAttribute("data-content-search-unit-key")?.match(/:(user|assistant)$/)?.[1] ||
      (element?.matches('[data-user-message-bubble="true"]') ? "user" : null);
  }

  function turns() {
    const selector =
      '[data-message-author-role="assistant"], [data-message-author-role="user"],' +
      'section[data-turn="assistant"], section[data-turn="user"],' +
      '[data-conversation-role="assistant"], [data-conversation-role="user"],' +
      '[data-content-search-unit-key$=":assistant"], [data-content-search-unit-key$=":user"],' +
      '[data-user-message-bubble="true"]';
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

  function authoredUserText(element) {
    // Native folding and action controls are UI, not part of the submitted
    // prompt. Preserve text-node adjacency and paragraph boundaries instead
    // of deleting words such as "显示更多" from the user's actual message.
    function read(node) {
      if (node.nodeType === Node.TEXT_NODE) return node.nodeValue || "";
      if (node.nodeType !== Node.ELEMENT_NODE) return "";
      if (node.matches('button, [role="button"], input, select, textarea, svg, script, style, [hidden], [aria-hidden="true"], .sr-only') ||
          getComputedStyle(node).display === "none") return "";
      if (node.tagName === "BR") return "\n";
      const text = [...node.childNodes].map(read).join("");
      return /^(?:DIV|P|LI|PRE|BLOCKQUOTE|H[1-6]|TR)$/.test(node.tagName) ? text + "\n" : text;
    }
    return read(element).trim();
  }

  function userMessageFoldControl(element) {
    if (!element) return null;
    const body = element.matches('[data-user-message-bubble="true"]') ? element :
      element.querySelector('[data-user-message-bubble="true"]') || element;
    return [...body.querySelectorAll('button, [role="button"], [aria-expanded="false"]')]
      .find((control) => isVisible(control) && control.getAttribute("aria-expanded") !== "true" &&
        [control.getAttribute("aria-label"), control.getAttribute("title"), control.innerText, control.textContent]
          .some((label) => /^(?:显示更多|展开|展开全文|查看更多|show more|read more|expand)$/i.test(normalize(label)))) || null;
  }

  function userMessageFolded(element) {
    return Boolean(userMessageFoldControl(element));
  }

  function handoffIntroductionSnapshot() {
    let snapshot = conversationSnapshot();
    const task = state?.tasks.find((item) => item.id === state.activeTaskId);
    if (state?.handoffSourceKey) emitHandoffDebug("adoption_probe",
      snapshot.lastUserFolded ? "adoption_folded" : "adoption_wait",{
        gate:"adoption",firstUserOnly:snapshot.userCount === 1,
        lastUserFolded:Boolean(snapshot.lastUserFolded),
        textMatches:Boolean(task?.text && handoffTextMatch(task.text,snapshot.lastUserText).matches),
        textChars:normalize(snapshot.lastUserText).length,expectedChars:normalize(task?.text || "").length,
      });
    // Only inspect the first native user turn of our still-pending project
    // handoff. Expanding is a read operation; ownership still requires the
    // worker's original token/project/full-message checks to pass.
    if (!state?.handoffSourceKey || !sessionKey?.startsWith("draft:") ||
        !pageChatKey(location.href) || !projectPageId(state.url) ||
        projectPageId(state.url) !== projectPageId(location.href) ||
        task?.kind !== "handoff_intro" || !["dispatching", "waiting"].includes(task.status) ||
        snapshot.userCount !== 1 || !snapshot.lastUserFolded ||
        composerActionInProgress || workInProgress) return snapshot;
    const control = userMessageFoldControl(snapshot.lastUserElement);
    if (!control) return snapshot;
    const last = handoffIntroExpansionAttempts.get(control);
    if (last?.id === task.id && clock() - last.at < 3000) return snapshot;
    const url = location.href;
    const key = sessionKey;
    const epoch = sendPageEpoch;
    handoffIntroExpansionAttempts.set(control, {id:task.id, at:clock()});
    // Never activate Send/Retry or edit/copy the message to manufacture proof.
    // React may reveal the full body synchronously or on the next frame.
    if (control.isConnected && snapshot.lastUserElement.contains(control) &&
        getEditor() && url === location.href && key === sessionKey && epoch === sendPageEpoch) {
      control.click();
      snapshot = conversationSnapshot();
      emitHandoffDebug("adoption_expand","adoption_wait",{
        gate:"adoption",lastUserFolded:Boolean(snapshot.lastUserFolded),
        textMatches:Boolean(task?.text && handoffTextMatch(task.text,snapshot.lastUserText).matches),
        textChars:normalize(snapshot.lastUserText).length,expectedChars:normalize(task?.text || "").length,
      });
      requestQueueWake(100);
    }
    return snapshot;
  }

  async function probePendingHandoff(snapshot) {
    // A fast route observation can leave a metadata-only chat record before
    // the first user bubble mounts. Keep checking that first bubble even
    // after the local UI has switched from draft to an ordinary empty chat.
    // This handshake never sends a message or claims a queued task.
    if (!state || !boundHere() || !pageChatKey(location.href) || !projectPageId(location.href) ||
        !sessionKey?.startsWith("chat:") || snapshot.userCount !== 1 ||
        !normalize(snapshot.lastUserText) || state.handoffSourceKey ||
        state.tasks.length || state.schedules.length || state.activeTaskId || state.steeringTaskId ||
        state.halted || state.queuePaused || state.error ||
        state.handoff?.enabled || state.handoff && state.handoff.phase !== "idle" ||
        workInProgress || composerActionInProgress) return false;
    const editor = getEditor();
    if (!editor || normalize(editorText(editor)) || hasComposerAttachments(editor) ||
        nativeUploadBusy(editor)) return false;
    const scope = captureSendScope();
    // A receiver can temporarily look like an ordinary empty conversation
    // before its relay draft is found. Read the first native user bubble in
    // full here too; the worker still requires an exact, uniquely owned match.
    if (snapshot.lastUserFolded) {
      const control = userMessageFoldControl(snapshot.lastUserElement);
      if (!control) return false;
      const expansionId = `recovery:${scope.url}|${scope.epoch}|${snapshot.lastUserId || ""}`;
      const last = handoffIntroExpansionAttempts.get(control);
      if (last?.id === expansionId && clock()-last.at < 3000) {
        requestQueueWake(Math.max(100,3000-(clock()-last.at)));
        return false;
      }
      if (!sendScopeCurrent(scope) || getEditor() !== editor || !control.isConnected ||
          !snapshot.lastUserElement?.contains(control)) return false;
      handoffIntroExpansionAttempts.set(control,{id:expansionId,at:clock()});
      const previousUserId = snapshot.lastUserId;
      control.click();
      snapshot = conversationSnapshot();
      requestQueueWake(100);
      if (!sendScopeCurrent(scope) || snapshot.userCount !== 1 ||
          previousUserId && snapshot.lastUserId && previousUserId !== snapshot.lastUserId ||
          snapshot.lastUserFolded) return false;
    }
    if (!sendScopeCurrent(scope) || getEditor() !== editor ||
        normalize(editorText(editor)) || hasComposerAttachments(editor) || nativeUploadBusy(editor)) return false;
    const signature = `${scope.url}|${scope.epoch}|${scope.sessionKey}|` +
      `${snapshot.lastUserId || ""}|${normalize(snapshot.lastUserText).length}|${snapshot.lastUserFolded}`;
    if (handoffRecoveryProbe?.signature === signature &&
        (handoffRecoveryProbe.pending || clock()-handoffRecoveryProbe.at < 5000)) return false;
    const probe = {signature,at:clock(),pending:true};
    handoffRecoveryProbe = probe;
    try {
      const reply = await rpc("CONFIRM_HANDOFF",{
        lastUserText:snapshot.lastUserText,userCount:snapshot.userCount,
        lastUserFolded:snapshot.lastUserFolded,lastUserId:snapshot.lastUserId,
      },scope);
      if (!sendScopeCurrent(scope) || reply.adopted !== true) return false;
      render();
      requestQueueWake();
      return true;
    } finally { probe.pending = false; }
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
    if (parts.length) return parts.map(authoredUserText).join("\n");
    const selector = '[data-user-message-bubble="true"], [data-testid="user-message"], [data-message-content], .whitespace-pre-wrap';
    const body = element.matches(selector) ? element : element.querySelector(selector) || element;
    const content = body.querySelector('[data-search-result-target]') || body;
    return authoredUserText(content);
  }

  function messageId(element) {
    const message = element?.closest("[data-message-id]") || element?.querySelector("[data-message-id]");
    const selection = element?.querySelector("[data-chatgpt-selection-message-id]");
    const search = element?.closest("[data-chatgpt-search-message-ids]") ||
      element?.querySelector("[data-chatgpt-search-message-ids]");
    return message?.getAttribute("data-message-id") ||
      selection?.getAttribute("data-chatgpt-selection-message-id") ||
      search?.getAttribute("data-chatgpt-search-message-ids")?.trim().split(/\s+/)[0] ||
      element?.getAttribute("data-turn-id") ||
      element?.getAttribute("data-testid") ||
      element?.getAttribute("data-content-search-unit-key") || null;
  }

  function assistantOutputText(element) {
    if (!element) return "";
    // Thinking timers, tool progress and "思考了 29s" are constantly updated
    // even though the final answer is not changing. Read only actual content.
    const selectors = [
      '[data-markdown-text-style="assistant-message"]',
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
      lastUserFolded: userMessageFolded(lastUser),
      lastUserId: messageId(lastUser),
      lastUserElement: lastUser,
      firstUserElement: firstUser,
      busy: nativeGenerationRunning(),
    };
  }

  // ChatGPT's own transport failure is not an extension sendMessage error.
  // Read only native visible error surfaces, never arbitrary user/AI prose.
  function nativeTransportErrorVisible() {
    const guardian = globalThis.__cqLoadRecoveryGuardian;
    if (typeof guardian?.detectTransportError === "function") return guardian.detectTransportError();
    const main = document.querySelector("main");
    if (!main) return false;
    const transportTimeout = /消息(?:传输|发送|投递)超时|(?:message|response)\s+(?:transport|transmission|delivery)\s+(?:timed?\s*out|timeout)/i;
    const nativeElement = (element) => isVisible(element) && !root.contains(element) &&
      !element.closest('[data-message-author-role="user"], [data-turn="user"], [data-user-message-bubble], [data-markdown-text-style="assistant-message"], .markdown');
    const errorText = (element) => {
      const text = normalize(element.innerText || element.textContent);
      return text.length <= 350 && transportTimeout.test(text);
    };
    for (const element of main.querySelectorAll(
      '[role="alert"], [data-testid*="error"], [data-state="error"]'
    )) {
      if (nativeElement(element) && errorText(element)) return true;
    }
    // Some ChatGPT versions render the red error box without role="alert".
    // Its native Retry button and compact adjacent error text identify it.
    for (const button of main.querySelectorAll("button")) {
      if (!nativeElement(button)) continue;
      const label = normalize(button.getAttribute("aria-label") ||
        button.getAttribute("title") || button.textContent);
      if (!/^(?:重试|再试一次|retry|try again)$/i.test(label)) continue;
      let ancestor = button.parentElement;
      for (let depth = 0; ancestor && ancestor !== main && depth < 5; depth++) {
        if (errorText(ancestor)) return true;
        if (normalize(ancestor.innerText || ancestor.textContent).length > 350) break;
        ancestor = ancestor.parentElement;
      }
    }
    return false;
  }

  function observeNativeTransportError() {
    if (!nativeTransportErrorVisible()) {
      nativeErrorFirstSeenAt = 0;
      return false;
    }
    nativeErrorFirstSeenAt ||= clock();
    return true;
  }

  function nativeConversationLoadErrorVisible() {
    const guardian = globalThis.__cqLoadRecoveryGuardian;
    if (typeof guardian?.detectError === "function") return guardian.detectError();
    const excluded = `${FOREIGN_EDITOR_SURFACE}, nav, header, [role="navigation"], pre, code, blockquote`;
    const loadError = /无法加载(?:此|这个|该)?\s*(?:ChatGPT\s*)?(?:对话|聊天|项目)|(?:unable\s+to|could\s+not|couldn['’]t|failed\s+to)\s+load\s+(?:this\s+|the\s+)?(?:ChatGPT\s+)?(?:conversation|project)/i;
    // Match the compact native error and its Retry control together. Text
    // quoted in a user/assistant message must never reload a healthy chat.
    for (const button of document.querySelectorAll('button, [role="button"]')) {
      if (!isRendered(button) || root.contains(button) || button.closest(excluded)) continue;
      const labels = [button.getAttribute("aria-label"),button.getAttribute("title"),button.textContent];
      if (!labels.some((label) => /^(?:重试|再试一次|retry|try again)$/i.test(normalize(label)))) continue;
      let surface = button.parentElement;
      for (let depth = 0; surface && depth < 10; depth++) {
        if (surface.closest(excluded) || root.contains(surface) || surface.querySelector(excluded)) break;
        const text = normalize(surface.innerText || surface.textContent);
        if (text.length > 600) break;
        if (isRendered(surface) && loadError.test(text)) return true;
        if (surface === document.body || surface === document.documentElement) break;
        surface = surface.parentElement;
      }
    }
    return false;
  }

  function nativeProjectLoadingVisible(url = location.href) {
    if (!isProjectOverview(url) || getEditor()) return false;
    const main = document.querySelector('main, [role="main"]');
    if (!main || !isRendered(main)) return false;
    // The project spinner has no Retry/error text. Only inspect the native
    // main area: sidebars, answer quotes and plugin spinners are unrelated.
    const excluded = `${FOREIGN_EDITOR_SURFACE}, button, a, form`;
    const indicators = main.querySelectorAll(
      '[role="progressbar"], [aria-busy="true"], .animate-spin, .animate-pulse,' +
      '[data-testid="loading-spinner"], [data-testid="project-loading"], [data-testid="loading"]'
    );
    if ([...indicators].some((element) => !root.contains(element) &&
        !element.closest(excluded) && isRendered(element))) return true;
    // Some revisions render an unlabelled SVG, or a completely empty main
    // while hydrating. Existing project content must not be refreshed merely
    // because the Sources view legitimately has no composer.
    if (main.querySelector(FOREIGN_EDITOR_SURFACE)) return false;
    const copy = main.cloneNode(true);
    copy.querySelectorAll('#cq-extension-root, script, style, nav, [role="navigation"]').forEach((node) => node.remove());
    return !normalize(copy.textContent) &&
      !main.querySelector('input, textarea, [contenteditable="true"], [role="tablist"], iframe');
  }

  function reloadConversationErrorPage() {
    location.reload();
  }

  function loadErrorRefreshSafe(recovery = null) {
    const guardian = globalThis.__cqLoadRecoveryGuardian;
    const staleDisconnectedGeneration = recovery?.allowDisconnectedGeneration === true &&
      guardian?.disconnectRefreshReady?.() === true;
    if (typeof guardian?.domSafe === "function" && !guardian.domSafe(staleDisconnectedGeneration)) return false;
    if (navigator.onLine === false || workInProgress || composerActionInProgress ||
        backupInProgress || favoriteBusy || pendingUiActions.size || schedulePulseInProgress ||
        nativeSubmission || nativeComposerImages?.files?.length || hasUnsavedPageDraft()) return false;
    const editor = getEditor();
    return !normalize(editorText(editor)) && !hasComposerAttachments(editor) &&
      !nativeUploadBusy(editor) && (staleDisconnectedGeneration || !nativeGenerationRunning());
  }

  function maybeReloadConversationLoadError(now = clock()) {
    const url = location.href;
    if (conversationLoadErrorUrl !== url) {
      conversationLoadErrorUrl = url;
      conversationLoadErrorSince = null;
      conversationLoadHealthySince = null;
      conversationLoadReloadIssued = false;
      conversationLoadFailureKind = null;
    }
    if (!pageChatKey(url) && !isProjectOverview(url)) return false;
    const storageKey = CONVERSATION_LOAD_RECOVERY_KEY + new URL(url).pathname;
    const failureKind = nativeConversationLoadErrorVisible() ? "error" :
      nativeProjectLoadingVisible(url) ? "project_loading" : null;
    if (!failureKind) {
      conversationLoadErrorSince = null;
      conversationLoadFailureKind = null;
      // Initial hydration may briefly omit the error. Reset the cross-reload
      // refresh record only after the real composer has stayed healthy for 30s.
      if (getEditor()) {
        conversationLoadHealthySince ??= now;
        if (now - conversationLoadHealthySince >= 30000) {
          try { sessionStorage.removeItem(storageKey); } catch { /* Optional cleanup. */ }
        }
      } else {
        conversationLoadHealthySince = null;
      }
      return false;
    }
    conversationLoadHealthySince = null;
    if (conversationLoadFailureKind !== failureKind) {
      conversationLoadFailureKind = failureKind;
      conversationLoadErrorSince = null;
    }
    conversationLoadErrorSince ??= now;
    // Even while waiting for a safe refresh, never treat a failed page as a
    // completed assistant turn or claim/send the next queued task.
    if (conversationLoadReloadIssued || now - conversationLoadErrorSince < CONVERSATION_LOAD_REFRESH_INTERVAL_MS ||
        !loadErrorRefreshSafe()) return true;
    if (failureKind === "project_loading" && state?.tasks?.some((task) =>
        ["dispatching", "waiting", "steering", "steering_wait"].includes(task.status))) {
      // An introduction may already have been clicked while the URL is still
      // /project. Do not refresh an unresolved first send or invent a retry.
      return true;
    }
    try {
      let previous = null;
      try { previous = JSON.parse(sessionStorage.getItem(storageKey) || "null"); }
      catch { /* Discard a malformed record, not the queued conversation. */ }
      const attempts = Number.isInteger(previous?.attempts) && previous.attempts >= 0
        ? Math.min(previous.attempts, Number.MAX_SAFE_INTEGER - 1) : 0;
      const lastAt = Number.isFinite(previous?.lastAt) && previous.lastAt >= 0
        ? previous.lastAt : null;
      if (lastAt !== null && now - lastAt < CONVERSATION_LOAD_REFRESH_INTERVAL_MS) return true;
      // Persist before reload so a fresh content script cannot start a tight
      // refresh loop. If storage is unavailable, leave the page intact.
      sessionStorage.setItem(storageKey, JSON.stringify({attempts:attempts + 1,lastAt:now,
        ...(isProjectOverview(url) && projectVisitId ? {resumeVisitId:projectVisitId} : {})}));
    } catch {
      return true;
    }
    if (location.href !== url || hasUnsavedPageDraft() ||
        !(failureKind === "error" ? nativeConversationLoadErrorVisible() : nativeProjectLoadingVisible(url))) return true;
    conversationLoadReloadIssued = true;
    reloadConversationErrorPage();
    return true;
  }

  function extractHandoffReply(snapshot) {
    // Read the newest assistant turn's authored content, not its toolbar or
    // streaming-status text. No delimiter or generated token is required.
    return {
      text: (snapshot.lastAssistantText ||
        snapshot.lastAssistantSurface ||
        snapshot.lastAssistantElement?.textContent || "").trim(),
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
    const result = extractHandoffReply(snapshot);
    const newerUser = Number.isInteger(task.baselineUserCount) &&
      snapshot.userCount > task.baselineUserCount;
    const changedReplyText = typeof task.baselineAssistantSignature === "string" &&
      snapshot.lastAssistantSignature !== task.baselineAssistantSignature;
    const newerAssistant = Boolean(
      snapshot.lastRole === "assistant" && (
        Number.isInteger(task.baselineAssistantCount) &&
          snapshot.assistantCount > task.baselineAssistantCount ||
        task.baselineAssistantId && snapshot.lastAssistantId &&
          snapshot.lastAssistantId !== task.baselineAssistantId ||
        newerUser && (changedReplyText ||
          (!task.baselineAssistantId && !task.baselineAssistantSignature))
      )
    );
    const finalActions = nativeReplyHasFinalActions(snapshot.lastAssistantElement);
    const responseConfirmed = Boolean(newerAssistant && result.text &&
      finalActions);
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
    if (controlsChanged) {
      setTabRunning(tabGenerationRunning());
      requestQueueWake();
    }
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

  // Coalesce native DOM/storage events; polling remains a recovery fallback.
  function requestQueueWake(delay = 0) {
    if (extensionContextGone) return;
    const due = clock() + Math.max(0, delay);
    if (queueWakeTimer !== null && queueWakeAt <= due) return;
    if (queueWakeTimer !== null) window.clearTimeout(queueWakeTimer);
    queueWakeAt = due;
    queueWakeTimer = window.setTimeout(() => {
      queueWakeTimer = null;
      if (heartbeatInProgress) { queueWakePending = true; return; }
      void heartbeat();
    }, Math.max(0, delay));
  }

  function syncSendRoute() {
    if (sendPageUrl === location.href) return;
    sendPageUrl = location.href;
    sendPageEpoch++;
    navigationPendingUntil = 0;
    immediateDispatchScope = null;
    resetVoiceReadiness();
  }

  function invalidateSendPage() {
    sendPageEpoch++;
    navigationPendingUntil = clock() + 1500;
    immediateDispatchScope = null;
    requestQueueWake(1500);
  }

  function captureSendScope() {
    syncSendRoute();
    return { url: location.href, sessionKey, epoch: sendPageEpoch,
      projectVisitId, expiresAt: clock() + 5000 };
  }

  function sendScopeCurrent(scope) {
    syncSendRoute();
    return Boolean(scope && scope.url === location.href && scope.epoch === sendPageEpoch &&
      scope.sessionKey === sessionKey && clock() >= navigationPendingUntil && boundHere());
  }

  // Capture intent before ChatGPT's router replaces the page/editor. Epochs
  // also invalidate A -> B -> A, even when the final URL matches the claim.
  document.addEventListener("click", (event) => {
    if (!event.isTrusted || event.button !== 0 || event.ctrlKey || event.metaKey ||
        event.shiftKey || event.altKey || !(event.target instanceof Element)) return;
    const link = event.target.closest("a[href]");
    if (!link || root.contains(link) || link.hasAttribute("download") ||
        link.target && link.target !== "_self") return;
    const destination = new URL(link.href, location.href);
    if (destination.origin === location.origin && destination.href !== location.href) invalidateSendPage();
  }, true);
  window.addEventListener("popstate", () => { invalidateSendPage(); requestQueueWake(); });
  window.addEventListener("hashchange", () => { invalidateSendPage(); requestQueueWake(); });
  window.addEventListener("pagehide", invalidateSendPage);
  window.navigation?.addEventListener("navigate", invalidateSendPage);

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
    const remaining = VOICE_READY_STABLE_MS - (clock() - voiceReadySince);
    if (remaining > 0) requestQueueWake(remaining);
    return remaining <= 0;
  }

  function updateIdle(_snapshot, voiceReady) {
    return Boolean(voiceReady && !composerActionInProgress && !workInProgress);
  }

  function readyToComplete(task, voiceReady) {
    return Boolean(task?.status === "waiting" && Number.isFinite(task.sentAt) &&
      voiceReady && clock() - task.sentAt >= VOICE_READY_STABLE_MS);
  }

  async function rpc(type, properties = {}, scope = null) {
    syncSendRoute();
    const requestedUrl = scope?.url || location.href;
    const requestedEpoch = scope?.epoch ?? sendPageEpoch;
    const requestIsCurrent = () => {
      syncSendRoute();
      return location.href === requestedUrl && sendPageEpoch === requestedEpoch;
    };
    if (requestIsCurrent() && ["HELLO","SENT"].includes(type) && typeof properties.lastUserText === "string") {
      const snapshot = conversationSnapshot();
      // Only annotate the same observed message, never a newer turn that
      // appeared between the caller's snapshot and this request.
      if (normalize(snapshot.lastUserText) === normalize(properties.lastUserText)) {
        properties = {...properties,lastUserFolded:snapshot.lastUserFolded,
          ...(type === "HELLO" ? {userCount:snapshot.userCount,lastUserId:snapshot.lastUserId} : {})};
      }
    }
    if (!scope && isProjectOverview(requestedUrl)) {
      if (projectVisitUrl !== validUrl(requestedUrl)) {
        projectVisitUrl = validUrl(requestedUrl);
        projectVisitId = crypto.randomUUID();
        // Only our own safe recovery reload may retain this one project
        // visit. A normal refresh/navigation still starts a fresh visit.
        try {
          const key = CONVERSATION_LOAD_RECOVERY_KEY + new URL(requestedUrl).pathname;
          const saved = JSON.parse(sessionStorage.getItem(key) || "null");
          if (typeof saved?.resumeVisitId === "string" &&
              /^[a-zA-Z0-9_-]{1,100}$/.test(saved.resumeVisitId) &&
              Number.isFinite(saved.lastAt) && clock() >= saved.lastAt && clock() - saved.lastAt < 600000) {
            const resumedVisitId = saved.resumeVisitId;
            delete saved.resumeVisitId;
            sessionStorage.setItem(key, JSON.stringify(saved));
            projectVisitId = resumedVisitId;
          }
        } catch { /* Ordinary visit semantics remain the fallback. */ }
      }
    } else if (!scope) {
      projectVisitUrl = null;
      projectVisitId = null;
    }
    const completingQueuedReply = type === "FINISHED"
      ? state?.activeTaskId === properties.id &&
        state?.tasks?.some((task) => task.id === properties.id && task.status === "waiting")
      : type === "STEER_CONFIRM" && state?.steeringTaskId === properties.id &&
        state?.tasks?.some((task) => task.id === properties.id && task.status === "steering_wait");
    const reply = await chrome.runtime.sendMessage({
      ...properties, type, url: requestedUrl,
      ...((scope ? scope.projectVisitId : projectVisitId)
        ? {projectVisitId: scope ? scope.projectVisitId : projectVisitId} : {}),
    });
    if (!reply?.ok) {
      const error = new Error(reply?.error || "插件后台未响应，请刷新 ChatGPT 页面");
      error.queueRequestUrl = requestedUrl;
      throw error;
    }
    // A user may navigate between chats while a large image is being saved.
    // That reply belongs to the old route: return it to the original action,
    // but never overwrite the new chat's state or erase its unsent draft.
    // The next heartbeat issues HELLO for the current route.
    if (!requestIsCurrent()) return reply;
    if (Number.isInteger(reply.tabId)) currentTabId = reply.tabId;
    if (type === "CLAIM") dispatchBlockedReason = reply.dispatchBlockedReason || "";
    if (reply.pageType === "project" && !reply.state) {
      // A project folder must not inherit the previous chat's UI or state.
      state = null;
      sessionKey = null;
      handoffDebugRuns = [];
      handoffDebugLoaded = false;
      handoffDebugReportMeta = {};
      root.remove();
      return reply;
    }
    const switched = Boolean(reply.sessionKey && (sessionKey !== reply.sessionKey ||
      reply.state?.projectVisitId && state?.projectVisitId !== reply.state.projectVisitId));
    if (switched) {
      dispatchBlockedReason = "";
      queueCompletionPending = false;
      completionSoundPlayed = false;
      tabCompleted = false;
      clearTabRedDot();
      imageHealthResult = null;
      nativeSubmission = null;
      queueFilter = "all";
      favoritesOpen = false;
      favoriteCategoryFilter = "";
      favoritePinnedOnly = false;
      favoriteTemplateDraft = null;
      favoriteTemplateComposing = false;
      favoriteTemplateRenderPending = false;
      favoriteSearchComposing = false;
      favoriteSearchRenderPending = false;
      focusedTaskId = null;
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
      expandedScheduleIds.clear();
      queueComposerOpen = false;
      queueDraft = "";
      queueImages = [];
      queueSubmissionId = null;
      scheduleSubmissionId = null;
      settingsOpen = false;
      handoffOpen = false;
      handoffDraftDirty = false;
      handoffDraftRevision++;
      diagnosticsOpen = false;
      handoffDebugRuns = [];
      handoffDebugLoaded = false;
      handoffDebugReportMeta = {};
      handoffDebugSignals.clear();
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
      pruneHandoffComposerRecords();
      clearCompletionIfWorkQueued();
      syncStoredCompletion();
      if (switched) countRateDirty = false;
      if (!countRateDirty) resetCountRateDraft();
      if (!cooldownDraftDirty) resetCooldownDraft();
      if (!handoffDraftDirty) resetHandoffDraft();
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
    if (["ENQUEUE", "ADD_TASK", "FINISHED", "STEER_CONFIRM", "RESUME", "DELETE_TASK"].includes(type)) {
      lastClaimAttempt = 0;
      requestQueueWake();
    }
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
    // A navigation may finish while an old route's request is still running.
    // Keep that failure with its caller, not as a warning on the new chat.
    if (error?.queueRequestUrl && error.queueRequestUrl !== location.href) return;
    const message = error?.message || String(error);
    actionFeedback = null;
    if (/extension context invalidated|extension context has been invalidated/i.test(message)) {
      // Extension hot-reloads invalidate this document's old runtime bridge.
      // Never reinterpret it as a failed queue send or keep polling a dead
      // service-worker connection. Preserve draft and durable task status.
      extensionContextGone = true;
      notification = "扩展已重新加载，当前页面的旧插件脚本已失效。请刷新 ChatGPT 页面重新连接；未确认的任务不会自动重发。";
      queueExpanded = true;
      render();
      return;
    }
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

  function handoffDebugDetails(task = null, extra = {}) {
    // Only measured metadata goes across the diagnostics bridge. Never add
    // text, DOM, URLs, task IDs, native labels or exception messages here.
    try {
      task ||= state?.tasks?.find(item => item.id === state.activeTaskId) ||
        state?.tasks?.find(item => ["handoff_intro","handoff_summary"].includes(item.kind));
      const editor = getEditor();
      const native = controls();
      const text = editor ? editorText(editor) : "";
      const expected = task?.text || "";
      const record = task && handoffComposerRecords.get(task.id);
      const currentTask = state?.tasks?.find(item => item.id === task?.id);
      const snapshot = conversationSnapshot();
      return {
        contentVersion:EXTENSION_VERSION,
        route:pageChatKey(location.href) ? "chat" : /\/project\/?$/.test(location.pathname) ? "project" : "other",
        sessionKind:sessionKey?.startsWith("draft:") ? "draft" : sessionKey ? "chat" : "none",
        taskKind:["handoff_summary","handoff_intro"].includes(task?.kind) ? task.kind : task ? "normal" : "none",
        taskStatus:currentTask?.status || task?.status || "none",
        handoffPhase:state?.handoff?.phase || "idle",
        boundHere:Boolean(boundHere()),activeMatches:Boolean(task && task.id === state?.activeTaskId),
        halted:Boolean(state?.halted),queuePaused:Boolean(state?.queuePaused),
        editorPresent:Boolean(editor),editorConnected:Boolean(editor?.isConnected),
        sendPresent:Boolean(native.send),sendVisible:Boolean(isVisible(native.send)),
        sendDisabled:Boolean(native.send?.disabled),voiceVisible:Boolean(isVisible(native.voice)),
        stopVisible:Boolean(isVisible(native.stop)),nativeBusy:Boolean(snapshot.busy),
        hasAttachments:Boolean(editor && hasComposerAttachments(editor)),
        uploadBusy:Boolean(editor && nativeUploadBusy(editor)),
        editorChars:text.length,taskChars:expected.length,
        editorNormalizedChars:normalize(text).length,taskNormalizedChars:normalize(expected).length,
        textMatches:Boolean(expected && (isHandoffTask(task)
          ? handoffTextMatch(expected,text).matches : normalize(text) === normalize(expected))),
        usedTolerance:Boolean(isHandoffTask(task) && handoffTextMatch(expected,text).usedTolerance),
        extraTextChars:isHandoffTask(task) ? handoffTextMatch(expected,text).extraChars : 0,
        exactTextMatches:Boolean(expected && text === expected),
        attachmentCount:editor ? nativeAttachmentCount(editor) : 0,
        expectedAttachmentCount:task?.images?.length || 0,
        trustedEdited:Boolean(record?.userEdited),clicked:Boolean(record?.clicked),
        lastUserFolded:Boolean(snapshot.lastUserFolded),
        userCount:snapshot.userCount,assistantCount:snapshot.assistantCount,
        voiceStableMs:voiceReadySince ? Math.min(1_000_000_000,Math.max(0,clock()-voiceReadySince)) : 0,
        navigationEpoch:sendPageEpoch,
        ...extra,
      };
    } catch { return {contentVersion:EXTENSION_VERSION,...extra}; }
  }

  function emitHandoffDebug(event, reason = "none", details = {}) {
    try {
      if (!state || !["queued","due","summarizing","opening","navigating","bootstrapping","failed"]
        .includes(state.handoff?.phase) && !state.handoffSourceKey) return;
      const measured = details.contentVersion ? details : handoffDebugDetails(null,details);
      const signature = JSON.stringify([sessionKey,event,reason,{...measured,voiceStableMs:0,
        waitMs:0,elapsedMs:0,sendWaitMs:0,replyStableMs:0,idleStableMs:0}]);
      const now = clock();
      if (handoffDebugSignals.has(signature) && now-handoffDebugSignals.get(signature) < 30000) return;
      handoffDebugSignals.set(signature,now);
      if (handoffDebugSignals.size > 160) handoffDebugSignals.delete(handoffDebugSignals.keys().next().value);
      void Promise.resolve(chrome.runtime.sendMessage({
        type:"HANDOFF_DEBUG_SIGNAL",url:location.href,event,reason,details:measured,
      })).catch(() => {});
    } catch { /* Diagnostics must never affect sending. */ }
  }

  function handoffDebugWaitReason(snapshot, voiceReady, active, evidence = null,
      nativeError = false) {
    const editor = getEditor();
    if (!editor) return "editor_missing";
    if (normalize(editorText(editor))) return preparedHandoffTask(editor)
      ? "prepared_document" : "editor_has_text";
    if (hasComposerAttachments(editor)) return "attachments_present";
    if (snapshot.busy) return "native_busy";
    if (controls().stop) return "native_stop";
    if (nativeError) return "transport_error";
    if (state?.handoff?.phase === "summarizing" && active?.status === "waiting") {
      if (!evidence?.newerAssistant) return "assistant_not_new";
      if (!evidence?.ready) return "reply_not_stable";
    }
    if (state?.handoff?.phase === "opening") return "waiting_project_page";
    if (state?.handoffSourceKey && pageChatKey(location.href) &&
        sessionKey?.startsWith("draft:")) return "waiting_chat_id";
    if (state?.handoffSourceKey && active?.status === "waiting") {
      return "waiting_native_reply";
    }
    if (!voiceReady) return "voice_not_ready";
    return "page_not_ready";
  }

  function handoffProgressText(snapshot = conversationSnapshot()) {
    const phase = state?.handoff?.phase;
    if (phase === "failed") return state.handoff.error || "接力未完成，旧队列已保留；请回到原对话核对后重新接力";
    if (phase === "queued") return "交接命令已入队，轮到它时自动执行；可在队列中调整顺序";
    if (state?.handoff?.cancelRequested) return "正在结束本次接力，当前回复结束后停止";
    if (state?.handoffSourceKey && pageChatKey(location.href) &&
        sessionKey?.startsWith("draft:")) return snapshot.lastUserFolded
      ? "正在读取交接消息全文，确认新对话归属" : "正在确认新对话已收到交接内容";
    if (state?.halted) return "接力已暂停，请先核对队列提示";
    if (state?.queuePaused) return "接力正在等待恢复自动发送";
    if (phase === "navigating") return "正在进入同项目的新对话";
    const editor = getEditor();
    if (!editor) return "正在等待 ChatGPT 输入框加载";
    if (preparedHandoffTask(editor)) return "交接文档已就位，正在接续发送";
    if (normalize(editorText(editor)) || hasComposerAttachments(editor)) {
      return workInProgress ? "正在准备接力消息" : "接力等待中：请先发送或清空输入框中的草稿和附件";
    }
    const active = state?.tasks.find((task) => task.id === state.activeTaskId);
    if (phase === "opening") return "交接总结已保存，正在准备进入新对话";
    if (state?.handoffSourceKey) {
      return active?.status === "waiting" ? "交接内容已发送，正在等待新对话确认" :
        "正在向同项目的新对话发送交接内容";
    }
    if (phase === "summarizing" && active?.status === "waiting") {
      return "正在生成并保存交接总结";
    }
    if (snapshot.busy || controls().stop || active?.status === "waiting") {
      return "接力已启动，正在等待当前回复完成";
    }
    return "接力已启动，正在准备发送总结请求";
  }

  function updateHandoffProgress(snapshot) {
    const label = root.querySelector(".cq-handoff-progress-text");
    if (!label) return;
    const text = handoffProgressText(snapshot);
    if (label.textContent !== text) label.textContent = text;
  }

  async function loadHandoffDebug() {
    if (handoffDebugLoading) throw new Error("正在读取日志，请稍后重试");
    const requestedUrl = location.href;
    const requestedSession = sessionKey;
    handoffDebugLoading = true;
    try {
      const reply = await chrome.runtime.sendMessage({
        type:"GET_HANDOFF_DEBUG",url:location.href,
      });
      if (!reply?.ok) throw new Error(reply?.error || "接力调试日志读取失败");
      if (location.href !== requestedUrl || sessionKey !== requestedSession) {
        throw new Error("读取日志时页面已切换，请在当前页面重新导出");
      }
      handoffDebugRuns = Array.isArray(reply.runs) ? reply.runs : [];
      handoffDebugReportMeta = {backendVersion:reply.backendVersion || null,
        capturedAt:reply.capturedAt || null,current:reply.current || null};
      handoffDebugLoaded = true;
    } finally {
      handoffDebugLoading = false;
    }
  }

  async function buildHandoffDebugReport() {
    await loadHandoffDebug();
    return JSON.stringify({
      format:"ChatGPTTaskQueue-handoff-debug",version:2,
      generatedAt:new Date().toISOString(),
      pluginVersion:EXTENSION_VERSION,...handoffDebugReportMeta,
      page:handoffDebugDetails(null,{gate:"export"}),runs:handoffDebugRuns,
    },null,2);
  }

  async function exportHandoffDebug() {
    const report = await buildHandoffDebugReport();
    const target = URL.createObjectURL(new Blob([report],{type:"application/json;charset=utf-8"}));
    const link = document.createElement("a");
    link.href = target;
    link.download = `chatgpt-handoff-debug-${new Date().toISOString().replace(/[:.]/g,"-")}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(target),60000);
    showActionFeedback("DEBUG JSON 已导出；队列窗口不可用时也可从浏览器扩展按钮导出");
    render();
  }

  async function copyHandoffDebug() {
    const report = await buildHandoffDebugReport();
    let copied = false;
    if (navigator.clipboard?.writeText) {
      try { await navigator.clipboard.writeText(report); copied = true; }
      catch { /* Fallback to document selection if clipboard API is blocked. */ }
    }
    if (!copied) {
      const previousFocus = document.activeElement;
      const field = document.createElement("textarea");
      field.value = report;
      field.style.cssText = "position:fixed;left:-9999px;top:0";
      root.appendChild(field);
      field.select();
      try { copied = document.execCommand("copy"); }
      finally {
        field.remove();
        previousFocus?.focus?.({preventScroll:true});
      }
    }
    if (!copied) throw new Error("浏览器拒绝复制日志，请允许剪贴板访问后重试");
    showActionFeedback("接力调试报告已复制，可直接粘贴给 AI 分析");
    render();
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

  function conversationHoverText(hint, now = clock()) {
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

  function handoffHoverText(hint, now = clock()) {
    const handoff = state?.handoff;
    let status;
    if (state?.handoffSourceKey) {
      status = "正在接收交接内容，成功后恢复自动交接设置";
    } else if (handoff?.phase === "queued") {
      status = handoff.trigger === "automatic"
        ? "自动交接已触发并入队，等待轮到它执行"
        : "手动交接已入队，等待轮到它执行";
      if (handoff.enabled) status += "\n本次交接成功后重新开始倒计时";
    } else if (handoff?.phase === "failed") {
      status = "本次交接失败，请先处理后再继续自动倒计时";
    } else if (handoff && !["idle","completed"].includes(handoff.phase)) {
      status = handoff.phase === "due" ? "自动交接已到期，等待交接命令入队" :
        "正在交接，成功后再开始下一轮自动倒计时";
    } else if (handoff?.remainingCount === 0) {
      status = "自动交接次数已用完";
    } else if (!handoff?.enabled) {
      status = "自动交接未开启";
    } else if (Number.isFinite(handoff.nextAt) && handoff.nextAt > 0) {
      status = now >= handoff.nextAt ? "自动交接倒计时已到期，等待交接命令入队" :
        `距离下一次触发自动交接：${countdownText(handoff.nextAt, now)}（到期加入队列）`;
    } else {
      status = "自动交接已开启，等待下一轮倒计时";
    }
    return `${status}\n${hint}`;
  }

  function updateHandoffHover(now = clock()) {
    const button = root.querySelector('.cq-handoff-now[data-handoff-hint]');
    if (button) {
      const value = handoffHoverText(button.dataset.handoffHint,now);
      if (button.title !== value) button.title = value;
      const wrapper = button.closest(".cq-handoff-hover-area");
      if (wrapper && wrapper.title !== value) wrapper.title = value;
    }
    const automation = root.querySelector('[data-action="toggle-scheduler"][data-conversation-hint]');
    if (automation) {
      const value = conversationHoverText(automation.dataset.conversationHint,now);
      if (automation.title !== value) automation.title = value;
    }
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
    updateHandoffProgress();
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
    const due = (state.handoff?.enabled && state.handoff.phase === "idle" &&
      Number.isFinite(state.handoff.nextAt) && now >= state.handoff.nextAt) ||
      state.schedules.some((schedule) => schedule.enabled &&
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
    const nativeBusy = nativeGenerationRunning();
    for (const button of root.querySelectorAll('[data-action="dismiss-waiting"]')) {
      button.disabled = nativeBusy || pendingUiActions.has(`dismiss-waiting:${button.dataset.id}`);
    }
    const label = root.querySelector(".cq-compose-wait");
    const voiceLabel = root.querySelector(".cq-voice-wait");
    const dispatchLabel = root.querySelector(".cq-dispatch-wait");
    if (!label && !voiceLabel && !dispatchLabel) return;
    const editor = getEditor();
    const pending = state?.tasks.some((task) => task.status === "pending");
    const handoffPending = ["due","summarizing"].includes(state?.handoff?.phase) ||
      state?.handoff?.phase === "queued" &&
        state.tasks.find((task) => task.status === "pending")?.kind === "handoff_summary" ||
      Boolean(state?.handoffSourceKey);
    const hasDraft = Boolean(editor && normalize(editorText(editor)) && !preparedHandoffTask(editor));
    if (label) label.hidden = !(pending && !state.activeTaskId && hasDraft);
    if (voiceLabel) voiceLabel.hidden = !(pending && !state.activeTaskId && !state.halted &&
      !handoffPending && !hasDraft && !isVisible(controls().voice));
    if (dispatchLabel) {
      const messages = {
        owner_mismatch:"等待当前标签页接管队列",
        target_mismatch:"队列不属于当前对话，请刷新页面重新连接",
        busy_handoff:state.handoff?.phase === "failed"
          ? "接力失败，请取消本次接力后继续队列" : "正在等待接力结束",
        resume_handoff_mismatch:"交接身份或待发送任务已变化，输入内容已保留，请核对本轮接力",
        retry_wait:"发送暂缓，稍后自动继续",
        not_ready:"正在等待 ChatGPT 就绪",
      };
      const ownerMismatch = Number.isInteger(currentTabId) &&
        Number.isInteger(state.tabId) && state.tabId !== currentTabId;
      const message = !editor ? "未识别到 ChatGPT 输入框，请刷新页面或更新扩展" :
        ownerMismatch ? messages.owner_mismatch : messages[dispatchBlockedReason] || "";
      dispatchLabel.textContent = message;
      dispatchLabel.hidden = !(pending && !state.activeTaskId && !state.steeringTaskId &&
        !state.halted && !state.queuePaused && message);
    }
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
    return state.tasks.filter((task) => task.id === editingTask ||
      queueFilter === "all" || taskCategory(task) === queueFilter);
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

  function highlightedTaskSnippet(text, expanded = false) {
    const source = String(text || "");
    const end = expanded ? source.length : Math.min(source.length, 220);
    return escapeHtml(source.slice(0, end)) + (end < source.length ? "…" : "");
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
    return `<div class="cq-queue-tools" aria-label="队列状态">
      <div class="cq-filter-row" role="group" aria-label="按任务状态筛选">
        ${filters.map(([filter,label]) => `<button type="button" data-action="filter-tasks"
          id="cq-filter-${filter}"
          data-filter="${filter}" aria-pressed="${queueFilter === filter ? "true" : "false"}"
          class="cq-filter-chip${queueFilter === filter ? " cq-filter-selected" : ""}">
          ${label} <span>${counts[filter]}</span></button>`).join("")}
      </div>
    </div>`;
  }

  function isHandoffTask(task) {
    return ["handoff_summary", "handoff_intro"].includes(task?.kind);
  }

  function taskDisplayText(task) {
    if (task.kind === "handoff_summary") return task.handoffTrigger === "automatic"
      ? "自动交接 · 总结当前对话并在同项目新对话继续"
      : "手动交接 · 总结当前对话并在同项目新对话继续";
    if (task.kind === "handoff_intro") return "接收任务背景 · 确认后继续剩余队列";
    return task.text || `仅有 ${task.images?.length || 0} 张图片`;
  }

  function renderTasks() {
    const visible = filteredTasks();
    if (!state.tasks.length) return '<p class="cq-empty">队列为空 · 在 ChatGPT 输入框按 Enter，将文字或图片加入队列</p>';
    if (!visible.length) return `<div class="cq-filter-empty">
      <p>没有符合条件的队列任务</p>
      <button type="button" data-action="reset-task-filter">清除筛选条件</button>
    </div>`;
    const firstPendingId = state.tasks.find((task) => task.status === "pending")?.id;
    const nativeBusy = state.tasks.some((task) => task.status === "waiting") && nativeGenerationRunning();
    const canDrag = queueFilter === "all";
    const tabStopId = visible.some((task) => task.id === focusedTaskId)
      ? focusedTaskId : visible[0].id;
    const pendingPositions = new Map(state.tasks
      .filter((task) => task.status === "pending")
      .map((task, index) => [task.id, index + 1]));
    return visible.map((task) => `
      <div class="cq-task cq-${task.status}${task.status === "pending" && editingTask !== task.id && canDrag ? " cq-task-draggable" : ""}"
        data-task-id="${escapeHtml(task.id)}"
        role="listitem" tabindex="${task.id === tabStopId ? "0" : "-1"}"
        ${task.id === state.activeTaskId || task.id === state.steeringTaskId ? 'aria-current="step"' : ""}
        aria-label="${escapeHtml(
          (task.status === "pending"
            ? `待发送第 ${pendingPositions.get(task.id)} 条`
            : STATUS[task.status] || "队列任务") +
          `：${taskDisplayText(task).replace(/\s+/g, " ").slice(0, 100)}` +
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
            <div class="cq-task-text${expandedTaskIds.has(task.id) ? " cq-task-text-expanded" : ""}" title="${escapeHtml(taskDisplayText(task))}">${task.text || isHandoffTask(task)
              ? highlightedTaskSnippet(taskDisplayText(task), expandedTaskIds.has(task.id))
              : `<span class="cq-image-only">仅图片任务 · ${task.images?.length || 0} 张</span>`}</div>
            ${!isHandoffTask(task) && task.text?.length > 220 ? `<button type="button" class="cq-expand-task"
              data-action="toggle-task-text" data-id="${escapeHtml(task.id)}"
              aria-expanded="${expandedTaskIds.has(task.id) ? "true" : "false"}"
              title="${expandedTaskIds.has(task.id) ? "收起完整内容" : "展开查看完整内容"}">${expandedTaskIds.has(task.id) ? "收起内容" : "展开全文"}</button>` : ""}
            ${imagePreviews(task.images || [])}
            <span class="cq-task-meta">${task.status === "pending"
              ? `待发送 ${pendingPositions.get(task.id)}/${pendingPositions.size}`
              : task.status === "waiting" ? "等待回复结束确认" : STATUS[task.status]}${task.sourceScheduleId ? " · 自动入队" : ""}</span>
            ${taskCategory(task) === "review" && task.error ? `
              <button type="button" class="cq-expand-task cq-error-toggle"
                data-action="toggle-task-error" data-id="${escapeHtml(task.id)}"
                aria-expanded="${expandedErrorIds.has(task.id) ? "true" : "false"}">
                ${expandedErrorIds.has(task.id) ? "收起原因" : "查看原因"}
              </button>
              ${expandedErrorIds.has(task.id) ?
                `<span class="cq-task-error-detail">${highlightedTaskSnippet(task.error, true)}</span>` : ""}
            ` : ""}
          `}
        </div>
        ${editingTask === task.id ? "" : `<div class="cq-item-actions">
          ${!isHandoffTask(task) ? `<button type="button" class="cq-favorite-task${favoriteForTask(task) ? " cq-is-favorite" : ""}"
            data-action="favorite-task" data-id="${escapeHtml(task.id)}"
            ${favoriteBusy ? 'disabled aria-busy="true"' : ""}
            title="${favoriteForTask(task) ? "取消收藏此图文任务" : "收藏此图文任务，其他对话也能复用"}"
            aria-label="${favoriteForTask(task) ? "取消收藏任务" : "收藏任务"}"
            aria-pressed="${favoriteForTask(task) ? "true" : "false"}">${favoriteForTask(task) ? "★" : "☆"}</button>` : ""}
          ${task.status === "pending" && !isHandoffTask(task) && !task.images?.length ? `
            <button type="button" class="cq-steer-action" data-action="steer-task" data-id="${task.id}"
              ${composerActionInProgress || workInProgress ? "disabled" : ""}
              title="优先尝试直接补充指令；网页不支持时自动停止当前生成、发送指令并继续回复">${icon("steer")}<span>${pendingUiActions.has(`steer-task:${task.id}`) ? "引导中" : "引导"}</span></button>
            ` : ""}
          ${task.status === "pending" ? `
            <button type="button" class="cq-pin-action" data-action="pin-task" data-id="${task.id}"
              title="${task.id === firstPendingId ? "已在待发送队首" : "置顶：移至待发送队首"}"
              ${task.id === firstPendingId || pendingUiActions.has(`pin-task:${task.id}`) ? "disabled" : ""}
              ${pendingUiActions.has(`pin-task:${task.id}`) ? 'aria-busy="true"' : ""}>${icon("pin")}<span>置顶</span></button>
            ${!isHandoffTask(task) ? `<button type="button" data-action="edit-task" data-id="${task.id}" title="编辑">${icon("edit")}</button>` : ""}` : ""}
          ${task.status === "waiting" && task.id === state.activeTaskId && !state.handoffSourceKey &&
            !["handoff_summary","handoff_intro"].includes(task.kind) ? `
            <button type="button" class="cq-dismiss-waiting" data-action="dismiss-waiting" data-id="${escapeHtml(task.id)}"
              title="确认回复已结束时，移除此等待项并继续队列；不会删除聊天或重新发送本条"
              aria-label="移除等待并继续队列"
              ${nativeBusy || pendingUiActions.has(`dismiss-waiting:${task.id}`) ? "disabled" : ""}
              ${pendingUiActions.has(`dismiss-waiting:${task.id}`) ? 'aria-busy="true"' : ""}>${icon("trash")}</button>` : ""}
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

  function renderSchedules() {
    if (!state.schedules.length) return '<p class="cq-empty">还没有自动入队任务</p>';
    const pending = queueCount();
    const queueFull = pending >= settings.maxPending;
    const throttled = countRateStatus().nextAvailableAt !== null;
    return state.schedules.map((item) => `
      <div class="cq-task cq-schedule-item${item.enabled ? " cq-rule-enabled" : " cq-rule-disabled"}"
        data-schedule-id="${escapeHtml(item.id)}">
        <span class="cq-task-mark">${icon(item.mode === "count" ? "list" : "clock")}</span>
        <div class="cq-task-body">
          <span class="cq-task-text">${expandedScheduleIds.has(item.id) ? escapeHtml(item.text) : excerpt(item.text)}</span>
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
      waiting_dismissed: "手动移除等待项",
      deferred: "发送条件未就绪，安全回队列", send_failed: "发送失败，等待检查",
      timeout: "等待超时", steer_timeout: "引导确认超时",
      task_edited: "修改待办", task_deleted: "删除待办",
      task_pinned: "任务置顶", task_reordered: "调整顺序",
      steer_claim: "锁定引导任务", steer_deferred: "引导等待上一条完成", steer_clicked: "已尝试引导发送",
      steer_cancel: "取消引导", steer_confirm: "引导确认完成", steer_pausing: "引导保底：暂停当前回复",
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
      handoff_manual: "手动交接命令已入队",
      handoff_setting: "修改自动交接次数、倒计时或开关",
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

  // The panel is rebuilt on state changes. Animate only real view/feedback/
  // queue changes, not ordinary heartbeat refreshes.
  function renderHandoffDebug() {
    if (!handoffDebugLoaded) {
      return '<p class="cq-repeat-hint">点击「读取日志」查看此对话的最近接力记录。</p>';
    }
    if (!handoffDebugRuns.length) {
      return '<p class="cq-repeat-hint">还没有接力日志。升级后首次接力时会自动开始记录。</p>';
    }
    const labels = {
      queued:"交接命令已入队",due:"接力启动",summarizing:"生成总结",opening:"总结已获取，等待导航",
      navigating:"进入项目新聊天",bootstrapping:"新对话开场排队",
      failed:"接力失败",completed:"接力完成",idle:"已取消",
    };
    const signals = {
      state:"后台状态",page_wait:"页面等待",native_send_click:"发送点击",
      navigation_start:"开始导航",navigation_committed:"导航确认",
      send_uncertain:"发送未确认",new_chat_pending:"新对话地址待确认",
      rpc_error:"接口执行未完成",
      send_prepare:"准备发送／领取",send_reuse:"接续已准备文档",send_wait:"等待发送按钮",
      send_gate_blocked:"发送前检查拦截",claim_release:"释放领取预约",
      send_ack:"发送回执已记录",send_exception:"发送过程异常",
      claim_result:"领取结果",dispatch_blocked:"尚未进入领取",
      adoption_probe:"核对接收归属",adoption_expand:"展开接收文档",completion_probe:"核对回复完成",
      input_start:"开始写入文档",input_complete:"原生写入调用结束",input_failed:"文档写入未通过检查",
      send_ready:"后台发送前复核通过",
      adoption_result:"后台接收绑定结果",
    };
    const reasons = {
      voice_not_ready:"语音就绪信号尚未恢复",
      assistant_not_new:"未检测到本轮新增助手回复",
      reply_not_stable:"回复仍在更新或结束证据不足",
      waiting_native_reply:"等待新对话的助手回复",
      waiting_chat_id:"等待生成正式对话地址",
      waiting_project_page:"等待项目新聊天入口",
      editor_missing:"尚未找到原生输入框",
      editor_has_text:"原生输入框仍有未发送内容",
      attachments_present:"原生输入框仍有附件",
      native_busy:"ChatGPT 正在生成",
      native_stop:"原生停止按钮仍在显示",
      page_not_ready:"等待页面就绪",
      transport_error:"ChatGPT 显示消息传输错误",
      native_send_unconfirmed:"点击发送后的状态尚未确认",
      summary_empty:"没有获取到非空的交接总结",
      summary_too_short:"旧版本：交接回复长度不足",
      summary_too_long:"旧版本：交接回复超出长度上限",
      source_changed:"总结期间对话发生变化",
      project_mismatch:"项目归属校验失败",
      chat_not_confirmed:"无法确认新对话",
      intro_not_confirmed:"新对话开场消息尚未确认",
      timeout:"超过接力等待期限",
      send_uncertain:"发送结果不确定",
      queue_conflict:"目标队列状态不一致",
      composer_not_ready:"原生发送条件未满足",
      reply_not_confirmed:"回复结束证据不足",
      other_failure:"其他错误，需核对操作阶段",
      other_blocker:"其他页面就绪条件未满足",
      prepared_document:"输入框内容匹配本轮交接文档",
      scope_changed:"页面或访问身份已变化",task_not_owned:"任务归属或领取状态不符",
      send_not_ready:"发送按钮或其作用域未就绪",editor_replaced:"输入框已被网页重建",
      composer_edited:"等待期间草稿被编辑",text_mismatch:"输入框内容与本轮文档不一致",
      attachments_mismatch:"附件数量不一致",upload_busy:"原生附件仍在上传",
      claim_released:"未点击发送，已释放预约",claim_release_failed:"预约释放未确认",
      ack_failed:"点击发送后后台回执失败",send_exception:"发送准备异常",
      adoption_wait:"等待完整接收归属证据",adoption_folded:"用户消息仍被折叠",
      completion_wait:"等待回复结束证据",dispatch_blocked:"队列暂停、已有活动任务或页面未就绪",
      claim_acquired:"已领取任务",claim_empty:"本轮未取得任务",
      claim_rejected:"后台拒绝领取",claim_exception:"领取接口异常或连接中断",
    };
    const run = handoffDebugRuns[0];
    return `<div class="cq-handoff-debug-summary">
      <strong>${run.mode === "manual" ? "手动" : "自动"}接力</strong>
      <span>${escapeHtml(labels[run.phase] || run.phase)}</span>
      <span>${escapeHtml(new Date(run.startedAt).toLocaleString("zh-CN"))}</span>
      <span>历史 ${handoffDebugRuns.length} 轮</span>
    </div><div class="cq-handoff-debug-events" aria-label="最新接力时间线">
      ${(run.events || []).slice(-40).map(event => `<div class="cq-handoff-debug-entry">
        <time>${escapeHtml(new Date(event.at).toLocaleTimeString("zh-CN",{hour12:false}))}</time>
        <span>${escapeHtml(signals[event.kind] || event.kind || "未知")}
          · ${escapeHtml(labels[event.phase] || event.phase || "未知阶段")}
          ${event.action ? " · " + escapeHtml(event.action) : ""}
          ${event.reason && event.reason !== "none"
            ? " · " + escapeHtml(reasons[event.reason] || event.reason) : ""}
          ${event.summaryStatus && event.summaryStatus !== "none"
            ? " · 总结 " + escapeHtml(event.summaryStatus) : ""}
          ${event.introStatus && event.introStatus !== "none"
            ? " · 开场 " + escapeHtml(event.introStatus) : ""}
          ${event.destination && event.destination !== "none"
            ? " · 目标 " + escapeHtml(event.destination) : ""}
          ${event.details?.gate ? " · 检查 " + escapeHtml(event.details.gate) : ""}
          ${event.details ? `<details><summary>DEBUG 详情</summary><pre>${escapeHtml(JSON.stringify(event.details,null,2))}</pre></details>` : ""}
        </span>
      </div>`).join("")}</div>`;
  }

  const UI_MOTION_EASING = "cubic-bezier(.22, 1, .36, 1)";
  function uiMotionAllowed() {
    return document.visibilityState === "visible" &&
      !window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
  }

  function uiViewKey() {
    if (!queueExpanded) return "collapsed";
    if (handoffOpen) return "handoff";
    if (settingsOpen) return `settings:${settingsPage}:${diagnosticsOpen}`;
    if (schedulerOpen) return `scheduler:${schedulerView}:${autoAdvancedOpen}`;
    if (favoritesOpen) return "favorites";
    if (queueComposerOpen) return "composer";
    return "queue";
  }

  function captureUiMotion() {
    if (!uiMotionAllowed()) return null;
    const panel = root.querySelector(".cq-inline");
    if (!panel) return null;
    const list = root.querySelector(".cq-list");
    const positions = new Map();
    if (list) {
      const listTop = list.getBoundingClientRect().top;
      for (const row of list.querySelectorAll(".cq-task[data-task-id]")) {
        positions.set(row.dataset.taskId,
          row.getBoundingClientRect().top - listTop + list.scrollTop);
      }
    }
    return {
      session:root.dataset.cqMotionSession,
      view:root.dataset.cqMotionView,
      height:panel.getBoundingClientRect().height,
      feedback:root.querySelector(".cq-action-feedback-text")?.textContent || "",
      listPresent:Boolean(list),
      positions,
    };
  }

  function animateUiChanges(before) {
    const view = uiViewKey();
    root.dataset.cqMotionView = view;
    root.dataset.cqMotionSession = sessionKey || "";
    if (!before || before.session !== sessionKey || !uiMotionAllowed()) return;
    const panel = root.querySelector(".cq-inline");
    if (!panel || typeof panel.animate !== "function") return;

    const feedback = root.querySelector(".cq-action-feedback");
    const feedbackText = feedback?.querySelector(".cq-action-feedback-text")?.textContent || "";
    const viewChanged = before.view !== view;
    const feedbackChanged = before.feedback !== feedbackText;
    if (viewChanged || feedbackChanged) {
      const nextHeight = panel.getBoundingClientRect().height;
      // Collapsing already replaced the expanded DOM with compact markup.
      // Animating the new (empty) panel from the old height leaves a large
      // blank strip for 230ms and appears as a flash. Only tween height when
      // opening/switching expanded views that still contain their content.
      if (view !== "collapsed" && Math.abs(nextHeight - before.height) > 3) {
        panel.animate([{height:`${before.height}px`}, {height:`${nextHeight}px`}],
          {duration:230,easing:UI_MOTION_EASING});
      }
    }
    if (viewChanged && view === "collapsed") {
      // Animate just the compact toolbar: it exists at its final layout size
      // immediately, so rapid toggles and outside clicks cannot rebound.
      root.querySelector(".cq-footer-toolbar")?.animate?.([
        {transform:"translateY(3px)"},
        {transform:"translateY(0)"},
      ],{duration:150,easing:UI_MOTION_EASING});
    }
    if (viewChanged && view !== "collapsed") {
      const section = root.querySelector(
        handoffOpen ? ".cq-handoff-page" :
        settingsOpen ? ".cq-settings-page:not([hidden])" :
        schedulerOpen ? (schedulerView === "list" ? ".cq-schedule-results" : "#cq-schedule-draft") :
        favoritesOpen ? ".cq-favorites" :
        queueComposerOpen ? ".cq-queue-create" : ".cq-list");
      // Animate the section around a focused input, not its caret.
      const target = section?.matches?.("textarea") ? section.closest(".cq-scheduler") : section;
      target?.animate?.([
        {opacity:0.45,transform:"translateY(7px)"},
        {opacity:1,transform:"translateY(0)"},
      ],{duration:200,easing:UI_MOTION_EASING});
    }
    if (feedbackText && feedbackChanged) {
      feedback?.animate?.([
        {opacity:0,transform:"translateY(5px)"},
        {opacity:1,transform:"translateY(0)"},
      ],{duration:190,easing:UI_MOTION_EASING});
    }

    const list = root.querySelector(".cq-list");
    if (!list || !before.listPresent) return;
    const rows = [...list.querySelectorAll(".cq-task[data-task-id]")];
    const oldOrder = [...before.positions.keys()];
    // A normal state refresh recreates identical row DOM: don't measure or
    // replay any animations unless membership/order really changed.
    if (rows.length === oldOrder.length &&
        rows.every((row,index) => row.dataset.taskId === oldOrder[index])) return;
    if (!rows.length && oldOrder.length) {
      list.querySelector(".cq-empty, .cq-filter-empty")?.animate?.([
        {opacity:0,transform:"translateY(5px)"},
        {opacity:1,transform:"translateY(0)"},
      ],{duration:190,easing:UI_MOTION_EASING});
      return;
    }
    const listTop = list.getBoundingClientRect().top;
    for (const row of rows) {
      const oldTop = before.positions.get(row.dataset.taskId);
      if (oldTop === undefined) {
        row.animate([
          {opacity:0,transform:"translateY(8px)"},
          {opacity:1,transform:"translateY(0)"},
        ],{duration:210,easing:UI_MOTION_EASING});
      } else {
        const newTop = row.getBoundingClientRect().top - listTop + list.scrollTop;
        const delta = oldTop - newTop;
        if (Math.abs(delta) > 2 && Math.abs(delta) < 900) {
          row.animate([
            {transform:`translateY(${delta}px)`},
            {transform:"translateY(0)"},
          ],{duration:225,easing:UI_MOTION_EASING});
        }
      }
    }
  }

  function render() {
    if (!state) {
      root.remove();
      return;
    }
    syncUnsavedDraftIndicators();
    // State/storage updates can arrive while someone is selecting characters
    // using an IME. Replacing the focused textarea would cancel composition
    // and silently lose the final committed text. Defer only DOM repaint.
    if (panelImeEditor) {
      if (panelImeEditor.isConnected && root.contains(panelImeEditor) &&
          location.href === panelImeUrl && sessionKey === panelImeSession) {
        panelImeRenderPending = true;
        return;
      }
      // Route changes or a removed editor must never freeze the old panel.
      panelImeEditor = null;
      panelImeRenderPending = false;
      panelImeFlushScheduled = false;
    }
    // Rebuilding the row DOM during a native drag would cancel the gesture.
    if (draggingTaskId || queueResize) return;
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
    const userStopped = state.halted && state.haltReason === "user";
    const queueIsPaused = state.queuePaused || userStopped;
    const autoRecovering = needsReview && !(state.handoffSourceKey && state.handoff?.phase === "failed") &&
      ["failure", "timeout", "uncertain", "steer_unconfirmed"].includes(state.haltReason);
    const recoverable = needsReview && state.tasks.find((task) => task.status === "error");
    const nearestSchedule = state.schedules.filter((schedule) => schedule.enabled && schedule.mode !== "count")
      .sort((a, b) => a.nextRunAt - b.nextRunAt)[0];
    const countSchedule = state.schedules.find((schedule) => schedule.enabled && schedule.mode === "count");
    const rate = countRateStatus();
    const handoff = state.handoff || {enabled:false,intervalMinutes:120,phase:"idle"};
    const handoffRunning = !["idle","completed"].includes(handoff.phase);
    const handoffCancelling = handoff.cancelRequested === true || pendingUiActions.has("cancel-handoff");
    // A stale "started successfully" receipt is misleading once the
    // background records a failed handoff.
    if (handoff.phase === "failed" && actionFeedback?.startsWith("已启动接力")) {
      actionFeedback = null;
    }
    const projectChat = /^\/g\/g-p-[a-zA-Z0-9-]+\/c\/[a-zA-Z0-9-]+\/?$/
      .test(new URL(location.href).pathname);
    const canHandoffNow = projectChat && !state.handoffSourceKey && !handoffRunning;
    const canSetHandoff = projectChat && !state.handoffSourceKey &&
      ["idle","completed","queued"].includes(handoff.phase);
    const canCancelHandoff = (projectChat || isProjectOverview()) &&
      (handoffRunning || state.handoffSourceKey || state.tasks.some(isHandoffTask)) && !handoffCancelling;
    const handoffButtonHint = "打开接力设置：自动交接次数、倒计时及手动交接";
    const handoffLabels = {
      queued:"交接命令已入队 · 等待前面的任务完成",
      due:"已到期 · 等待当前任务结束", summarizing:"正在生成交接总结",
      opening:"总结已保存 · 准备进入新对话",
      navigating:"正在进入原生项目的新对话", bootstrapping:"等待新对话确认接收",
      failed:"交接失败 · 旧队列已保留", completed:"已接力到新对话",
    };
    const backgroundWork = pending > 0 || (handoffRunning && handoff.phase !== "failed") || handoff.enabled ||
      (state.handoffSourceKey && handoff.phase !== "failed") ||
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

    const beforeMotion = captureUiMotion();
    root.innerHTML = `
      <section class="cq-inline" aria-label="ChatGPT 对话任务队列">
        <div class="cq-toolbar">
          <div class="cq-queue-label">
            ${icon("list")} <strong>Queue</strong> <span>${pending}</span>
          </div>
          ${active ? `<span class="cq-status cq-status-active">${icon("clock")} ${STATUS[active.status]}</span>` :
            state.halted ? `<span class="cq-status">${state.haltReason === "user" ? "用户已暂停" : "等待核对"}</span>` : ''}
          ${state.queuePaused ? `<span class="cq-status cq-status-paused" title="只暂停领取下一条，当前正在运行的任务不会被强行中断">自动发送已暂停</span>` : ""}
          ${state.handoffSourceKey ? `<span class="cq-status ${handoff.phase === "failed" ? "" : "cq-status-active"}"
            title="${handoff.phase === "failed" ? "接收未完成，旧队列仍保留在原对话" : "旧队列会在当前对话确认接收总结后一次性迁移"}">${handoff.phase === "failed" ? "交接接收失败" : "接收交接中"}</span>` : ""}
          ${handoffRunning ? `<span class="cq-status ${handoff.phase === "failed" ? "" : "cq-status-active"}"
            title="${escapeHtml(handoff.error || handoffLabels[handoff.phase] || "接力正在进行")}">
            ${handoffCancelling ? "接力取消中" :
              handoff.phase === "failed" ? "接力失败" : handoff.phase === "queued" ? "交接已入队" : handoff.phase === "due" ? "接力待总结" :
              handoff.phase === "summarizing" ? "接力总结中" : "接力切换中"}</span>` : ""}
          ${cooldownAt && waitingToDispatch && !active && !state.halted &&
             !state.queuePaused && !state.steeringTaskId
            ? `<span class="cq-status cq-cooldown-status" data-cooldown-until="${cooldownAt}"
                title="上一条任务结束后的等待时间；只限制下一条自动发送">
                ${icon("clock")}下条发送冷却 ${countdownMarkup(cooldownAt)}</span>` : ""}
          <span class="cq-status cq-compose-wait" hidden>等待清空输入框</span>
          <span class="cq-status cq-voice-wait" hidden>等待语音按钮</span>
          <span class="cq-status cq-dispatch-wait" role="status" hidden></span>
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
        ${(handoffRunning && handoff.phase !== "failed") || state.handoffSourceKey
          ? `<div class="cq-notice cq-handoff-progress" role="status" aria-live="polite">
            <span class="cq-handoff-progress-text">${escapeHtml(handoffProgressText())}</span>
            <button type="button" data-action="open-handoff-debug">查看接力日志</button>
          </div>` : ""}
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
            <button type="button" data-action="open-handoff-debug">查看接力日志</button>
            <button type="button" data-action="cancel-handoff" title="人工核对后取消失败的接力，保留原队列"
              ${handoffCancelling ? 'disabled aria-busy="true"' : ""}>${handoffCancelling ? "正在取消接力" : "取消本次接力"}</button>
          </div>` : ""}
          ${retryableUnsentHandoff() ? `<div class="cq-notice cq-handoff-retry-notice" role="status">
            <span>交接文档尚未发送，可重新填入后继续本轮接力。</span>
            <button type="button" data-action="retry-unsent-handoff"
              title="用本轮交接文档替换当前输入框草稿并重试；已发送或状态不明的任务不能重试"
              ${pendingUiActions.has("retry-unsent-handoff") ? 'disabled aria-busy="true"' : ""}>替换草稿并重试交接</button>
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
          ${handoffOpen ? `<section class="cq-scheduler cq-handoff-page" aria-label="接力设置">
            <div class="cq-settings-heading">
              <div class="cq-section-title">接力设置 <span>同一原生项目 · 随队列延续到新对话</span></div>
              <button type="button" data-action="toggle-handoff" aria-label="关闭接力设置">完成</button>
            </div>
            ${!projectChat || state.handoffSourceKey ? `<p class="cq-repeat-hint">${state.handoffSourceKey
              ? "正在接收交接内容，请等待当前接力完成。"
              : "请在 ChatGPT 原生项目内的已有对话中使用交接。"}</p>` : ""}
            <div class="cq-handoff-panel">
              <div class="cq-section-title">自动交接</div>
              <div class="cq-schedule-controls">
                <label for="cq-handoff-repeats">循环次数 <input type="number" id="cq-handoff-repeats"
                  min="-1" max="1000000" step="1" value="${escapeHtml(handoffRepeatsDraft)}"
                  ${canSetHandoff && !handoffSaving ? "" : "disabled"}></label>
                <label for="cq-handoff-minutes">倒计时 <input type="number" id="cq-handoff-minutes"
                  min="1" max="1440" step="1" value="${escapeHtml(handoffMinutesDraft)}"
                  ${canSetHandoff && !handoffSaving ? "" : "disabled"}> 分钟</label>
                <button type="button" class="cq-save" data-action="save-handoff"
                  ${canSetHandoff && !handoffSaving ? "" : "disabled"}
                  ${handoffSaving ? 'aria-busy="true"' : ""}>启动自动交接</button>
                ${handoff.enabled ? `<button type="button" data-action="stop-handoff"
                  ${canSetHandoff && !handoffSaving ? "" : "disabled"}>停止自动交接</button>` : ""}
                <button type="button" data-action="discard-handoff-draft" ${handoffDraftDirty ? "" : "hidden"}
                  ${handoffSaving ? "disabled" : ""}>放弃修改</button>
              </div>
              <p class="cq-repeat-hint">次数填 -1 表示无限次，其余填写正整数。倒计时结束后，将交接命令加入队列末尾；成功交接后在新对话重新倒计时。</p>
              <p class="cq-draft-hint" data-draft-hint="handoff" ${handoffDraftDirty ? "" : "hidden"}>有未保存的修改 · 切换面板会保留，刷新页面会丢失。</p>
              <p class="cq-handoff-state cq-repeat-hint" role="status">
                ${handoff.enabled ? `自动交接已开启 · 剩余 ${handoff.remainingCount == null || handoff.remainingCount === -1
                  ? "无限" : escapeHtml(handoff.remainingCount)} 次` :
                  handoff.remainingCount === 0 ? "自动交接次数已用完" : "自动交接已关闭"}
                ${handoff.enabled && handoff.phase === "idle" && handoff.nextAt
                  ? ` · ${countdownMarkup(handoff.nextAt)} 后入队` : ""}
              </p>
              <p class="cq-repeat-hint">点击“启动自动交接”会保存参数并开启自动交接，重新计算次数和倒计时；已有交接命令保留原顺序。只有自动交接成功才扣次数，手动交接不占自动次数。</p>
            </div>
            <div class="cq-handoff-panel">
              <div class="cq-section-title">手动交接</div>
              <p class="cq-repeat-hint">点击后加入当前队列末尾，轮到它时生成总结并在同项目的新对话继续。</p>
              <div class="cq-schedule-controls">
                <button type="button" class="cq-save" data-action="handoff-now"
                  ${canHandoffNow && !pendingUiActions.has("handoff-now") ? "" : "disabled"}
                  ${pendingUiActions.has("handoff-now") ? 'aria-busy="true"' : ""}>手动交接 · 加入队列</button>
                ${canCancelHandoff ? `<button type="button" data-action="cancel-handoff" class="cq-handoff-cancel">
                  ${handoff.phase === "queued" ? "取消已入队的交接" : "取消本次接力"}</button>` : ""}
              </div>
              <p class="cq-repeat-hint" role="status">${handoffLabels[handoff.phase] || "尚无待执行的交接命令"}${handoff.error ? ` · ${escapeHtml(handoff.error)}` : ""}</p>
              <p class="cq-repeat-hint">新对话确认接收后才迁移剩余任务与自动规则。队列暂停时命令会等待；交接失败时保留原队列，不自动重复发送。</p>
            </div>
          </section>` : ""}
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
              <div class="cq-inline-image-composer" data-image-zone="schedule">
                <textarea id="cq-schedule-draft" rows="2"
                  placeholder="自动入队的提示词… 可直接拖入或粘贴图片">${escapeHtml(scheduleDraft)}</textarea>
                ${imagePreviews([...scheduleKeptImages, ...scheduleImages], "schedule")}
                <label class="cq-composer-image-button" for="cq-schedule-images" role="button" tabindex="0"
                  title="选择图片；也可直接拖入或粘贴（最多 4 张，每张不超过 8 MB）"
                  aria-label="添加图片，当前 ${scheduleKeptImages.length + scheduleImages.length} 张，最多 4 张">
                  ${icon("image")}
                  <input id="cq-schedule-images" type="file"
                    accept="image/png,image/jpeg,image/webp,image/gif" multiple>
                </label>
                <div class="cq-image-drop-overlay" aria-hidden="true">松开添加图片</div>
              </div>
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
              ` : `<div class="cq-schedule-results" aria-label="当前自动任务列表">${renderSchedules()}</div>`}
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
              <label class="cq-switch"><input type="checkbox" id="cq-auto-open" ${state.autoOpenTab ? "checked" : ""}> 对话标签关闭后自动重新打开（浏览器需保持运行）</label>
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
                <p class="cq-repeat-hint">有队列、自动规则或接力任务时持续保护所属标签页，包括项目加载和新对话阶段；页面被卸载时在原标签恢复，不依赖“关闭后自动重新打开”。后台每分钟唤醒一次，已发送任务不会重发。</p>
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
                  <div class="cq-handoff-debug" aria-label="接力调试日志">
                    <div class="cq-section-title">接力调试日志 <span>自动记录 · 本地最多 12 轮 · 不保存聊天正文或图片</span></div>
                    <div class="cq-diagnostics-actions">
                      <button type="button" data-action="load-handoff-debug"
                        ${handoffDebugLoading ? "disabled" : ""}>读取日志</button>
                      <button type="button" data-action="copy-handoff-debug"
                        ${handoffDebugLoading ? "disabled" : ""}>复制调试报告</button>
                      <button type="button" data-action="export-handoff-debug"
                        ${handoffDebugLoading ? "disabled" : ""}>导出 DEBUG JSON</button>
                    </div>
                    <p class="cq-repeat-hint">队列窗口不可用时：点击浏览器工具栏中的本插件 → 导出 DEBUG JSON，可导出所有近期接力记录。</p>
                    ${renderHandoffDebug()}
                  </div>
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
        ${!queueExpanded && handoff.phase === "failed" && handoff.error
          ? `<div class="cq-handoff-collapse-error" role="alert"
              title="${escapeHtml(handoff.error)}">接力失败：${escapeHtml(handoff.error)}
              · 原队列已保留，展开面板可核对</div>` : ""}
        ${renderActionFeedback()}
        <div class="cq-footer-toolbar">
          <div class="cq-bottom-actions">
            <button type="button" class="cq-tool cq-add-queue" data-action="queue-composer"
              aria-label="将原生输入框内容入队" title="将原生输入框里的文字和图片一起加入当前对话队列">${icon("plus")}<span>入队</span></button>
            <button type="button" class="cq-tool ${queueIsPaused ? "cq-tool-active" : ""}" data-action="toggle-queue-paused"
              aria-label="${queueIsPaused ? "继续自动发送" : "暂停自动发送"}"
              title="${needsReview ? "当前有发送异常需先核对；此开关不能解除安全暂停" :
                userStopped ? "解除用户停止状态并继续队列；已中断的回复不会自动重发" :
                queueIsPaused ? "继续自动发送" : "暂停自动发送（不会强行打断正在运行的消息）"}"
              aria-pressed="${queueIsPaused ? "true" : "false"}">${icon(queueIsPaused ? "play" : "pause")}<span>${queueIsPaused ? "继续" : "暂停"}</span></button>
            <button type="button" class="cq-tool ${favoritesOpen && queueExpanded ? 'cq-tool-active' : ''}"
              data-action="toggle-favorites" aria-pressed="${favoritesOpen && queueExpanded}"
              aria-label="打开提示词收藏夹" title="收藏常用图文任务并一键重新入队">${icon("star")}<span>收藏</span>${favoriteItems.length ? `<small>${favoriteItems.length}</small>` : ""}<small class="cq-draft-indicator" data-draft-kind="favorite" ${hasUnsavedFavoriteTemplate() ? "" : "hidden"}>草稿</small></button>
            <button type="button" class="cq-tool ${schedulerOpen && queueExpanded ? 'cq-tool-active' : ''}"
              data-action="toggle-scheduler" aria-label="${hasUnsavedAutomation() ? "自动入队规则，有未保存草稿" : "自动入队规则"}"
              data-conversation-hint="定时 / 数量触发入队"
              title="${escapeHtml(conversationHoverText("定时 / 数量触发入队"))}">${icon("clock")}<span>自动</span>${state.schedules.length ? `<small>${state.schedules.length}</small>` : ""}<small class="cq-draft-indicator" data-draft-kind="schedule" ${hasUnsavedAutomation() ? "" : "hidden"}>未保存</small></button>
            <span class="cq-handoff-hover-area" title="${escapeHtml(handoffHoverText(handoffButtonHint))}">
              <button type="button" class="cq-tool cq-handoff-now ${handoffOpen && queueExpanded ? "cq-tool-active" : ""}"
                data-action="toggle-handoff" aria-label="接力设置" aria-expanded="${handoffOpen && queueExpanded}"
                data-handoff-hint="${escapeHtml(handoffButtonHint)}"
                title="${escapeHtml(handoffHoverText(handoffButtonHint))}">
                ${icon("handoff")}<span>接力</span><small class="cq-draft-indicator" data-draft-kind="handoff" ${handoffDraftDirty ? "" : "hidden"}>未保存</small></button>
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
    animateUiChanges(beforeMotion);
  }

  async function onAction(button) {
    const action = button.dataset.action;
    const id = button.dataset.id;
    if (action === "retry-unsent-handoff") {
      if (composerActionInProgress || workInProgress || pendingUiActions.has(action)) return;
      const task = retryableUnsentHandoff();
      const editor = getEditor();
      const before = conversationSnapshot();
      if (!task || !editor || before.userCount !== 0 || nativeGenerationRunning()) {
        throw new Error("当前交接不能确认为尚未发送，未替换输入框");
      }
      const scope = captureSendScope();
      const draft = editorText(editor);
      composerActionInProgress = true;
      pendingUiActions.add(action);
      button.disabled = true;
      try {
        const reply = await rpc("RETRY_UNSENT_HANDOFF",{
          id:task.id,userRequested:true,nativeBusy:false,userCount:before.userCount,
        },scope);
        if (!reply.retryReady || !sendScopeCurrent(scope) || getEditor() !== editor ||
            editorText(editor) !== draft || hasComposerAttachments(editor) || nativeUploadBusy(editor) ||
            nativeGenerationRunning() || conversationSnapshot().userCount !== 0) {
          throw new Error("页面或草稿已经变化，未替换输入框；请重新核对后重试");
        }
        // This explicit button authorizes replacement, unlike automatic
        // retry. Recheck the exact original draft after the worker response.
        handoffComposerWriteDepth++;
        try {
          if (normalize(draft) && !clearComposerText(editor,draft)) {
            throw new Error("未能清空原生草稿，请手动清空后继续");
          }
        } finally { handoffComposerWriteDepth--; }
        handoffComposerRecords.delete(task.id);
        notification = "本轮接力已恢复，将重新填入交接文档并发送";
      } finally {
        composerActionInProgress = false;
        pendingUiActions.delete(action);
        render();
        requestQueueWake();
      }
      return;
    }
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
    if (action === "open-handoff-debug" || action === "load-handoff-debug" ||
        action === "copy-handoff-debug" || action === "export-handoff-debug") {
      if (action === "open-handoff-debug") {
        settingsOpen = true;
        handoffOpen = false;
        queueComposerOpen = false;
        schedulerOpen = false;
        favoritesOpen = false;
        settingsPage = "diagnostics";
        diagnosticsOpen = true;
        queueExpanded = true;
        render();
      }
      if (action === "export-handoff-debug") {
        await exportHandoffDebug();
      } else if (action === "copy-handoff-debug") {
        await copyHandoffDebug();
      } else {
        try { await loadHandoffDebug(); }
        finally { render(); }
      }
      return;
    }
    const guardedKeyEarly = ["pin-task", "delete-task", "delete-schedule",
      "handoff-now", "dismiss-waiting",
      "toggle-schedule", "save-task"].includes(action)
      ? `${action}:${id || editingTask}` : null;
    // Reject a duplicate before opening a second confirmation dialog.
    if (guardedKeyEarly && pendingUiActions.has(guardedKeyEarly)) return;
    if (action === "dismiss-waiting") {
      const key = `dismiss-waiting:${id}`;
      pendingUiActions.add(key);
      render();
      try {
        const snapshot = conversationSnapshot();
        if (snapshot.busy) throw new Error("ChatGPT 仍在生成回复，请等生成结束后再移除等待");
        if (!boundHere()) {
          await rpc("HELLO", {lastUserText:snapshot.lastUserText,userCount:snapshot.userCount});
        }
        const task = state?.tasks.find((item) => item.id === id);
        if (!task) {
          showActionFeedback("等待项已结束");
          return;
        }
        if (!boundHere() || task.id !== state.activeTaskId || task.status !== "waiting") {
          throw new Error("等待状态已变化，请按当前任务状态操作");
        }
        if (nativeGenerationRunning()) throw new Error("ChatGPT 仍在生成回复，暂不能移除等待");
        await rpc("DISMISS_WAITING", {id,userRequested:true,nativeBusy:false});
        notification = "";
        showActionFeedback(state.halted || state.queuePaused
          ? "已移除等待，原有暂停状态保留" : "已移除等待，队列将继续");
      } finally {
        pendingUiActions.delete(key);
        render();
      }
      void heartbeat();
      return;
    }
    if (action === "toggle-favorites") {
      favoritesOpen = !favoritesOpen;
      handoffOpen = false;
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
    if (action === "toggle-handoff") {
      handoffOpen = !handoffOpen;
      if (handoffOpen && !handoffDraftDirty) resetHandoffDraft();
      schedulerOpen = false; favoritesOpen = false; settingsOpen = false; queueComposerOpen = false;
      queueExpanded = true;
      render();
      return;
    }
    if (action === "discard-handoff-draft") {
      resetHandoffDraft();
      render();
      return;
    }
    if (action === "save-handoff" || action === "stop-handoff") {
      if (handoffSaving) return;
      const starting = action === "save-handoff";
      // Read the current form before rebuilding it, including changes whose
      // input/change event has not yet updated the in-memory draft.
      if (starting) {
        handoffMinutesDraft = root.querySelector("#cq-handoff-minutes")?.value ?? handoffMinutesDraft;
        handoffRepeatsDraft = root.querySelector("#cq-handoff-repeats")?.value ?? handoffRepeatsDraft;
      }
      const revision = handoffDraftRevision;
      const requestedKey = sessionKey;
      const requestedUrl = location.href;
      const enabled = starting;
      // Stopping uses saved values so invalid, unsaved fields cannot prevent
      // it, and those edits remain available for the next explicit start.
      const intervalMinutes = starting ? handoffMinutesDraft : state.handoff?.intervalMinutes ?? 120;
      const repeatCount = starting ? handoffRepeatsDraft : state.handoff?.repeatCount ?? -1;
      const queuedAutomaticIds = new Set(state.tasks.filter((task) =>
        task.kind === "handoff_summary" && task.status === "pending" &&
        task.handoffTrigger === "automatic").map((task) => task.id));
      handoffSaving = true;
      render();
      try {
        const saved = await rpc("SET_HANDOFF", {enabled,intervalMinutes,repeatCount});
        if (sessionKey === requestedKey && location.href === requestedUrl) {
          if (starting && handoffDraftRevision === revision) resetHandoffDraft();
          const persisted = saved.state?.handoff;
          const cancelled = !persisted?.enabled && [...queuedAutomaticIds].some((taskId) =>
            !saved.state?.tasks?.some((task) => task.id === taskId));
          showActionFeedback(persisted?.enabled
            ? `自动交接已启动，设置已保存 · ${persisted.phase === "queued" ? "已有交接命令等待执行" : `倒计时 ${persisted.intervalMinutes} 分钟`} · ${persisted.repeatCount === -1 ? "无限次" : `${persisted.repeatCount} 次`}`
            : `自动交接已停止${cancelled ? "；已撤销未发送的自动交接命令" : ""}`);
        }
      } finally {
        handoffSaving = false;
        render();
      }
      return;
    }
    if (action === "handoff-now") {
      if (pendingUiActions.has("handoff-now")) return;
      pendingUiActions.add("handoff-now");
      button.disabled = true;
      button.setAttribute("aria-busy", "true");
      try {
        await rpc("HANDOFF_NOW");
        showActionFeedback(state.handoff?.phase === "queued"
          ? "交接命令已加入队列末尾，轮到它时执行"
          : "已有接力正在进行，请等待当前接力完成");
      } finally {
        pendingUiActions.delete("handoff-now");
        render();
      }
      void heartbeat();
      return;
    }
    if (action === "cancel-handoff") {
      if (pendingUiActions.has("cancel-handoff")) return;
      if (!confirm("取消本次接力？\n\n已发送的聊天消息不会撤回。若交接消息仍在发送，将等待安全停止。原有任务和定时规则保留。")) return;
      const pauseAfter = state.handoff?.phase === "failed" &&
        state.tasks.some((task) => task.status === "pending" && !isHandoffTask(task));
      const requestedKey = sessionKey;
      const requestedUrl = location.href;
      pendingUiActions.add("cancel-handoff");
      render();
      try {
        const reply = await rpc("CANCEL_HANDOFF",{pauseAfter,reviewed:true});
        if (requestedKey === sessionKey && requestedUrl === location.href) {
          const stillLinked = state.handoffSourceKey || state.handoffToken || state.tasks.some(isHandoffTask);
          showActionFeedback(reply.cancelPending === true || state.handoff?.cancelRequested
            ? "已请求取消接力：等待当前交接消息结束后清理，不会继续跳转"
            : stillLinked
              ? "取消接力尚未完成，请查看接力日志后重试"
              : state.queuePaused
                ? "已取消接力，原有任务与规则已保留；请核对后继续队列"
                : "已取消接力，原有任务与规则已保留");
        }
      } finally {
        pendingUiActions.delete("cancel-handoff");
        render();
      }
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
      render();
      const list = root.querySelector(".cq-list");
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
    if (action === "reset-task-filter") {
      queueFilter = "all";
      render();
      root.querySelector("#cq-filter-all")?.focus();
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
      const queueIsPaused = state.queuePaused ||
        (state.halted && state.haltReason === "user");
      await rpc("SET_QUEUE_PAUSED", { paused: !queueIsPaused });
      notification = state.queuePaused
        ? "当前对话的自动发送已暂停；自动规则仍可入队，当前消息不会被打断。"
        : state.halted ? "当前对话仍处于安全暂停，请先核对异常任务。"
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
      handoffOpen = false;
      if (!hasScheduleDraft()) schedulerView = state.schedules.length ? "list" : "create";
      queueComposerOpen = false; favoritesOpen = false; settingsOpen = false; queueExpanded = true; render(); return;
    }
    if (action === "toggle-queue-composer") {
      queueDraftRevision++;
      handoffOpen = false;
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
      handoffOpen = false;
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
      const inputPage = captureSendScope();
      try {
        if (!boundHere()) await rpc("HELLO", { lastUserText: conversationSnapshot().lastUserText });
        syncSendRoute();
        if (location.href !== inputPage.url || sendPageEpoch !== inputPage.epoch || getEditor() !== editor) return;
        await queueNativePrompt(editor, text);
      } finally {
        composerActionInProgress = false;
        render();
        requestQueueWake();
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
    let deleteTaskConfirmedNow = false;
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
        if (needsDeleteTaskConfirmation()) {
          const preview = String(task.text || `纯图片任务（${task.images?.length || 0} 张）`)
            .replace(/\s+/g, " ").slice(0, 70);
          if (!confirm(`确定删除这条队列任务？\n\n${preview}\n\n删除后不能直接撤销。请先确认不再需要发送这条内容。\n\n确认并成功删除后，24 小时内删除其他队列任务不再弹出确认。`)) return;
          deleteTaskConfirmedNow = true;
        }
        request = ["DELETE_TASK", { id,...(isHandoffTask(task) ? {reviewed:true} : {}) }];
        break;
      }
      case "skip-failed":
        if (!confirm("请先确认该消息已经发送，或不需要重发。\n\n跳过后插件不会重发此任务，并将继续处理后续队列。")) return;
        request = ["SKIP_FAILED", { id,...(isHandoffTask(state.tasks.find((task) => task.id === id))
          ? {reviewed:true} : {}) }];
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
    let mutationReply = null;
    if (guardedKey) {
      pendingUiActions.add(guardedKey);
      button.disabled = true;
      button.setAttribute("aria-busy", "true");
    }
    try {
      mutationReply = await rpc(type, props);
      // Arm the 24h window only after a prompted deletion actually succeeds.
      // Quiet deletions must not continually extend the suppression period.
      if (deleteTaskConfirmedNow && !mutationReply.cancelPending &&
          !state.tasks.some((task) => task.id === id)) rememberDeleteTaskConfirmation();
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
      const message = mutationReply?.cancelPending === true
        ? "已请求取消接力：等待当前交接消息结束后清理，原有任务与规则保留"
        : action === "skip-failed" && props.reviewed
          ? "已取消本次接力，原有任务与规则已保留"
        : action === "toggle-schedule"
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

  // Fold only after an actual click outside the panel, not at pointerdown:
  // moving the composer while a pointer is pressed could redirect that click.
  // Ignore synthetic .click() calls used by our automated native Send flow.
  document.addEventListener("click", (event) => {
    if (!state || !queueExpanded || !root.isConnected ||
        root.contains(event.target) || event.button !== 0 ||
        (!event.isTrusted && event.detail === 0)) return;
    // Focusing/placing the caret in ChatGPT's native text editor should not
    // hide the queue. Other areas outside the panel still collapse normally.
    const composer = nativeComposerAnchor();
    if (composer?.contains(event.target)) return;
    queueExpanded = false;
    render();
  }, true);

  root.addEventListener("input", (event) => {
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
    if (event.target.id === "cq-handoff-minutes") {
      handoffMinutesDraft = event.target.value;
      handoffDraftDirty = true; handoffDraftRevision++;
    }
    if (event.target.id === "cq-handoff-repeats") {
      handoffRepeatsDraft = event.target.value;
      handoffDraftDirty = true; handoffDraftRevision++;
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
    if (event.target.id === "cq-favorite-search") favoriteSearchComposing = true;
    if (event.target.matches?.('textarea, input:not([type="checkbox"]):not([type="radio"]):not([type="file"])') &&
        event.target.id !== "cq-favorite-search" &&
        !event.target.matches(".cq-template-compose textarea[data-template-index]")) {
      panelImeEditor = event.target;
      panelImeUrl = location.href;
      panelImeSession = sessionKey;
      panelImeRenderPending = false;
      panelImeFlushScheduled = false;
      syncUnsavedDraftIndicators();
    }
  });
  function finishPanelIme(control) {
    if (panelImeEditor !== control || panelImeFlushScheduled) return;
    panelImeFlushScheduled = true;
    // The final non-composing input can follow compositionend. Leave one task
    // turn for it to update draft state before any deferred DOM replacement.
    // Also sync the value if a browser omits that final input event.
    window.setTimeout(() => {
      if (panelImeEditor !== control) return;
      const pending = panelImeRenderPending;
      const samePage = location.href === panelImeUrl && sessionKey === panelImeSession;
      panelImeEditor = null;
      panelImeRenderPending = false;
      panelImeFlushScheduled = false;
      if (samePage && control.isConnected && root.contains(control)) {
        control.dispatchEvent(new Event("input", {bubbles:true}));
      }
      syncUnsavedDraftIndicators();
      if (pending) render();
    }, 0);
  }
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
    finishPanelIme(event.target);
  });
  // A cancelled IME can blur without compositionend. Release the queued
  // repaint when the user leaves the field rather than freezing panel UI.
  root.addEventListener("focusout", (event) => finishPanelIme(event.target));

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
      handoffOpen = false;
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
    const zone = event.target.closest?.("[data-image-zone]");
    if (!zone || !event.dataTransfer?.types?.includes("Files")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    if (zone.classList.contains("cq-inline-image-composer")) {
      zone.classList.add("cq-image-drag-over");
    }
  });
  root.addEventListener("dragleave", (event) => {
    const zone = event.target.closest?.(".cq-inline-image-composer");
    if (zone && !zone.contains(event.relatedTarget)) {
      zone.classList.remove("cq-image-drag-over");
    }
  });
  root.addEventListener("drop", (event) => {
    root.querySelectorAll(".cq-inline-image-composer.cq-image-drag-over")
      .forEach((zone) => zone.classList.remove("cq-image-drag-over"));
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
    if (!zone || !event.dataTransfer?.types?.includes("Files")) return;
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
    if (event.target.matches?.(".cq-image-add[role='button'], .cq-composer-image-button[role='button']") &&
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
              keyboardReorderInProgress || queueFilter !== "all") return;
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
    pruneHandoffComposerRecords();
    clearCompletionIfWorkQueued();
    syncStoredCompletion();
    if (!countRateDirty) resetCountRateDraft();
    if (!cooldownDraftDirty) resetCooldownDraft();
    if (!handoffDraftDirty) resetHandoffDraft();
    legacyUnboundCount = store.legacyUnbound?.tasks.length || store.legacyUnbound?.schedules.length || 0;
    render();
    requestQueueWake();
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

  function handoffTextDifference(expected, observed) {
    const first = normalize(expected), second = normalize(observed);
    let prefix = 0, suffix = 0;
    while (prefix < first.length && prefix < second.length && first[prefix] === second[prefix]) prefix++;
    while (suffix < first.length-prefix && suffix < second.length-prefix &&
        first[first.length-1-suffix] === second[second.length-1-suffix]) suffix++;
    const controls = /[\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g;
    return {
      textDifferenceKind:first === second ? String(expected) === String(observed) ? "equal" : "whitespace"
        : first.replace(controls,"") === second.replace(controls,"") ? "format_controls" : "content",
      commonPrefixChars:prefix,commonSuffixChars:suffix,
      expectedDifferenceChars:first.length-prefix-suffix,editorDifferenceChars:second.length-prefix-suffix,
      expectedControlChars:(first.match(controls) || []).length,
      editorControlChars:(second.match(controls) || []).length,
    };
  }

  async function insertHandoffText(editor, task, scope) {
    const text = task.text;
    const details = {contentVersion:EXTENSION_VERSION,gate:"input",taskKind:task.kind,
      taskChars:text.length,inputParagraphs:text.split(/\r\n?|\n/).length};
    const current = () => sendScopeCurrent(scope) && editor.isConnected && getEditor() === editor &&
      state?.activeTaskId === task.id && !state.halted &&
      !handoffComposerRecords.get(task.id)?.userEdited &&
      !handoffComposerRecords.get(task.id)?.clicked;
    const write = (method, action) => {
      const started = clock();
      emitHandoffDebug("input_start","none",{...details,inputMethod:method});
      handoffComposerWriteDepth++;
      try { return action(); }
      finally {
        handoffComposerWriteDepth--;
        // Measure the browser operation BEFORE reading innerText/layout. A
        // frozen native input and an expensive layout now have distinct evidence.
        emitHandoffDebug("input_complete","none",{...details,inputMethod:method,
          inputElapsedMs:Math.max(0,clock()-started)});
      }
    };
    const select = () => {
      editor.focus();
      const range = document.createRange();
      range.selectNodeContents(editor);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    };
    try {
      if (!current() || normalize(editorText(editor)) || hasComposerAttachments(editor)) {
        throw new Error("交接输入框已变化，未写入交接文档");
      }
      if (editor.matches("textarea, input")) {
        write("nativeValue",() => insertText(editor,text));
        return;
      }
      if (!editor.isContentEditable) throw new Error("当前 ChatGPT 输入框不可编辑");
      select();
      // Give ProseMirror an explicit, inert paragraph representation as well
      // as plain text. Both flavors describe exactly the same authored text;
      // the editor need not reinterpret plain-text Markdown into rich nodes.
      const html = text.replace(/\r\n?/g,"\n").split("\n")
        .map(line => `<p>${line ? escapeHtml(line) : "<br>"}</p>`).join("");
      let handled = false;
      let paste = null;
      if (typeof DataTransfer === "function" && typeof ClipboardEvent === "function") {
        try {
          const data = new DataTransfer();
          data.setData("text/plain",text);
          data.setData("text/html",html);
          paste = new ClipboardEvent("paste",{bubbles:true,cancelable:true,clipboardData:data});
        } catch { /* Some browser builds expose but restrict these constructors. */ }
      }
      if (paste) {
        write("paste",() => editor.dispatchEvent(paste));
        handled = paste.defaultPrevented;
        // Yield once so ProseMirror/React can publish the single paste transaction.
        // Real user edits during this yield remain protected by the trusted-edit guard.
        await sleep(0);
        if (!current()) throw new Error("粘贴交接文档时原页面或草稿已变化，未继续发送");
        const received = normalize(editorText(editor));
        if (handoffTextMatch(text,editorText(editor)).matches) return;
        if (received || handled) {
          throw new Error("网页尚未完整接收交接粘贴，已保留草稿，不重复填入正文");
        }
      }
      if (!current() || normalize(editorText(editor)) || hasComposerAttachments(editor)) {
        throw new Error("交接输入框已变化，未执行兼容写入");
      }
      select();
      // A single native HTML edit avoids insertText's per-line editing cost.
      // Escaping keeps every user character as text; do not mutate innerHTML
      // or manufacture an input event over an editor whose model was not updated.
      if (!write("html",() => document.execCommand("insertHTML",false,html))) {
        throw new Error("浏览器未允许批量填写交接文档，未执行发送");
      }
      await sleep(0);
      if (!current() || !handoffTextMatch(text,editorText(editor)).matches) {
        throw new Error("编辑器未完整接收交接文档，已保留草稿并停止发送");
      }
    } catch (error) {
      emitHandoffDebug("input_failed","text_mismatch",{
        ...details,...handoffTextDifference(text,editorText(editor)),
      });
      throw error;
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
    const editor = getEditor();
    const composerForm = editor?.closest("form");
    // ChatGPT may portal its upload input outside the composer, but an input
    // owned by a different form or embedded in a writing block is not ours.
    // Otherwise an unrelated file picker can poison the next plain-text
    // queue attempt with a phantom unconfirmed attachment.
    if (!composerForm || input.form && input.form !== composerForm ||
        input.closest('[data-testid*="writing-block"], [data-testid*="artifact"], ' +
          '[data-message-author-role], [data-testid^="conversation-turn-"], aside')) return;
    recordNativeComposerImages(editor, input.files);
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

  function nativeImageCloseIcon(button) {
    if (/^[×✕✖✗]$/.test(button.textContent.trim()) ||
        button.querySelector('svg.lucide-x, svg[data-lucide="x"]')) return true;
    // Recognize only two crossing diagonals. A generic SVG/arrow is not
    // evidence of removal, even when it happens to sit beside a thumbnail.
    for (const svg of button.querySelectorAll("svg")) {
      const segments = [...svg.querySelectorAll("line")].map(line =>
        ["x1","y1","x2","y2"].map(field => Number(line.getAttribute(field))));
      let valid = true;
      for (const path of svg.querySelectorAll("path")) {
        const data = path.getAttribute("d") || "";
        const parts = data.match(/M\s*-?[\d.]+[\s,]+-?[\d.]+\s*L\s*-?[\d.]+[\s,]+-?[\d.]+/g) || [];
        if (data.replace(/M\s*-?[\d.]+[\s,]+-?[\d.]+\s*L\s*-?[\d.]+[\s,]+-?[\d.]+/g,"").trim()) {
          valid = false; break;
        }
        for (const part of parts) segments.push((part.match(/-?[\d.]+/g) || []).map(Number));
      }
      if (!valid || segments.length !== 2 || svg.querySelector("circle, rect, polygon, polyline") ||
          segments.some(points => points.length !== 4 || points.some(value => !Number.isFinite(value)))) continue;
      const [a,b] = segments;
      const near = (first,second) => Math.abs(first-second) < 0.01;
      if (Math.abs(a[0]-a[2]) > 1 && Math.abs(a[1]-a[3]) > 1 &&
          near(Math.min(a[0],a[2]),Math.min(b[0],b[2])) &&
          near(Math.max(a[0],a[2]),Math.max(b[0],b[2])) &&
          near(Math.min(a[1],a[3]),Math.min(b[1],b[3])) &&
          near(Math.max(a[1],a[3]),Math.max(b[1],b[3])) &&
          (a[2]-a[0])*(a[3]-a[1])*(b[2]-b[0])*(b[3]-b[1]) < 0) return true;
    }
    return false;
  }

  function nativeImageRemoveButton(preview, form, previews) {
    // A global "Remove" or "Clear" search could delete unrelated user content.
    // Stop before reaching the form: only a thumbnail's local card may qualify.
    const native = controls();
    for (let node = preview, depth = 0; node && node !== form && depth < 7;
         node = node.parentElement, depth++) {
      if (previews.some((other) => other !== preview && node.contains(other))) {
        return null; // Do not guess which image an action in a shared group removes.
      }
      const buttons = [...node.querySelectorAll('button, [role="button"]')]
        .filter((button) => button.isConnected && form.contains(button) &&
          !root.contains(button) && !button.contains(preview) &&
          !button.disabled && !button.matches(":disabled") &&
          !button.closest('[hidden], [inert], [aria-hidden="true"], [aria-disabled="true"]') &&
          !button.closest(FOREIGN_EDITOR_SURFACE) &&
          button !== native.send && button !== native.stop && button !== native.voice &&
          !isNativeStopButton(button,form) && !isNativeVoiceButton(button) &&
          !button.matches('[type="submit"], [data-testid="send-button"], [data-testid="composer-submit-button"], [data-testid="composer-send-button"]'));
      const explicit = buttons.filter((button) => {
        const label = [button.getAttribute("aria-label"), button.getAttribute("title"),
          button.getAttribute("data-testid")].filter(Boolean).join(" ");
        return (/(remove|delete|移除|删除|移去|移走)/i.test(label) ||
          [button.getAttribute("aria-label"),button.getAttribute("title")]
            .some(name => /^(?:close(?: (?:image|attachment|file|preview))?|关闭(?:图片|图像|附件|文件|预览)?)$/i.test((name || "").trim()))) &&
          !/(\ball\b|全部|所有)/i.test(label);
      });
      if (explicit.length === 1) return explicit[0];
      if (explicit.length > 1) return null;
      // Some cards use only an unlabeled × button. Never infer removal from
      // a generic button; the icon must belong to a single local thumbnail.
      // CSS hover-hidden removal buttons still accept native click(). Limit
      // this exception to proven removal/close controls in this single card;
      // never loosen global Send/Stop readiness or remove nodes directly.
      const icons = buttons.filter(nativeImageCloseIcon);
      if (icons.length === 1 &&
          node.querySelectorAll('img[src^="blob:"], img[src^="data:image/"]').length <= 1) {
        return icons[0];
      }
      if (icons.length > 1) return null;
    }
    return null;
  }

  async function clearNativeComposerImages(editor, files, submittedText, safeToClear = () => true) {
    const form = editor?.closest("form");
    if (!form) return false;
    const captured = nativeComposerImages;
    const originalUrl = location.href;
    const unchanged = () => safeToClear() && editor.isConnected &&
      sessionKey === captured?.sessionKey && location.href === originalUrl &&
      nativeComposerImages === captured &&
      normalize(editorText(editor)) === normalize(submittedText) &&
      files.every((file,index) => captured.files[index] === file) && !nativeUploadBusy(editor);
    for (let i = 0; i < files.length; i++) {
      // Abort if the user edits text, adds images, or switches conversations
      // while the persisted attachment previews are being cleared.
      if (!unchanged() || nativeAttachmentCount(editor) !== files.length - i) return false;
      let previews = nativeAttachmentPreviews(editor);
      let remove = previews[0] && nativeImageRemoveButton(previews[0], form, previews);
      if (!remove && previews[0]) {
        // React may mount the card's close control only on mouse enter.
        previews[0].dispatchEvent(new MouseEvent("mouseover", {bubbles:true}));
        await sleep(0);
        if (!unchanged() || nativeAttachmentCount(editor) !== files.length - i) return false;
        previews = nativeAttachmentPreviews(editor);
        remove = previews[0] && nativeImageRemoveButton(previews[0],form,previews);
      }
      if (!remove) break;
      const before = nativeAttachmentCount(editor);
      if (!unchanged()) return false;
      // A missing type defaults to submit in HTML. Suppress only that
      // default form submission; the native removal click handler still runs.
      const preventSubmit = (event) => event.preventDefault();
      const defaultsToSubmit = remove.matches('button:not([type])') && remove.type === "submit";
      if (defaultsToSubmit) remove.addEventListener("click",preventSubmit,true);
      try { remove.click(); }
      finally { if (defaultsToSubmit) remove.removeEventListener("click",preventSubmit,true); }
      for (let wait = 0; wait < 32 && nativeAttachmentCount(editor) >= before; wait++) {
        if (!unchanged()) return false;
        await sleep(50);
      }
      if (nativeAttachmentCount(editor) !== before - 1) return false;
    }
    const cleared = safeToClear() && editor.isConnected && nativeComposerImages === captured &&
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

  async function restoreNativeImages(editor, task, scope = captureSendScope()) {
    if (!task.images?.length) return;
    const assertOriginalComposer = () => {
      if (!sendScopeCurrent(scope) || state?.activeTaskId !== task.id || state?.halted ||
          !editor.isConnected || getEditor() !== editor ||
          normalize(editorText(editor)) !== normalize(task.text)) {
        throw new Error("上传期间原对话或输入框已变化，已阻止发送");
      }
    };
    assertOriginalComposer();
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
      assertOriginalComposer();
      const response = await rpc("GET_TASK_IMAGE", { id: task.id, imageId: reference.id }, scope);
      assertOriginalComposer();
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
    assertOriginalComposer();
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
      assertOriginalComposer();
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

  async function queueNativePrompt(editor, text, priority = false) {
    if (!state) throw new Error("队列还没初始化，请刷新页面");
    let draftEdited = false;
    let clearingAttachments = false;
    const markEdited = (event) => {
      if (clearingAttachments && event.type === "input" && !event.isTrusted &&
          normalize(editorText(editor)) === normalize(text)) return;
      draftEdited = true;
    };
    editor.addEventListener("beforeinput", markEdited, true);
    editor.addEventListener("input", markEdited, true);
    try {
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
    const originalScope = captureSendScope();
    const beganIdle = !state.activeTaskId && !state.steeringTaskId &&
      !nativeGenerationRunning() && !controls().stop;
    const images = await Promise.all(files.map(readImageFile));
    if (!sendScopeCurrent(originalScope) || !editor.isConnected || getEditor() !== editor || draftEdited ||
        location.href !== originalUrl || originalKey !== sessionKey ||
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
    const requestId = nativeSubmission.requestId;
    await rpc("ENQUEUE", { text, images, priority, requestId }, originalScope);
    // The queue was persisted for the original chat. If the user navigated or
    // changed the composer while the RPC ran, leave their new draft/attachments
    // exactly as they are; clearing them would be irreversible data loss.
    if (!editor.isConnected || getEditor() !== editor || draftEdited ||
        !sendScopeCurrent(originalScope) || sessionKey !== originalKey || location.href !== originalUrl ||
        normalize(editorText(editor)) !== normalize(text) ||
        nativeAttachmentCount(editor) !== previewCount ||
        (files.length && files.some((file,index) => nativeComposerImages?.files[index] !== file))) {
      notification = "任务已保存，但原生输入框或对话已变化；新草稿与附件已保留，请核对后手动清除残留";
      queueExpanded = true;
      render();
      return;
    }
    const safeToClear = () => !draftEdited && getEditor() === editor &&
      sendScopeCurrent(originalScope) && sessionKey === originalKey && location.href === originalUrl;
    let imagesCleared = !files.length;
    if (files.length) {
      clearingAttachments = true;
      try { imagesCleared = await clearNativeComposerImages(editor,files,text,safeToClear); }
      finally { clearingAttachments = false; }
    }
    // Keep the same text/file submission identity on failure. Clearing only
    // text would turn another Enter into a different, duplicate image task.
    const textCleared = imagesCleared && (!text?.trim() || (safeToClear() &&
      !nativeUploadBusy(editor) && clearComposerText(editor, text)));
    if (!imagesCleared || !textCleared) {
      notification = "任务和图片已保存，但原生输入框未完全清空；请清除残留的附件/文字，避免重复发送。";
    } else {
      nativeSubmission = null;
      if (beganIdle && sendScopeCurrent(originalScope)) {
        immediateDispatchScope = { ...originalScope, expiresAt: clock() + 5000 };
      }
      lastClaimAttempt = 0;
      notification = priority ? "当前回复结束后优先发送，不会打断正在运行的任务。" : "";
    }
    queueExpanded = true;
    render();
    } finally {
      editor.removeEventListener("beforeinput", markEdited, true);
      editor.removeEventListener("input", markEdited, true);
      requestQueueWake();
    }
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
    const newerAssistant = Boolean(snapshot.lastRole === "assistant" &&
      normalize(snapshot.lastAssistantText || snapshot.lastAssistantSurface) && (
        Number.isInteger(task.steerPauseAssistantCount) &&
          snapshot.assistantCount > task.steerPauseAssistantCount ||
        task.steerPauseAssistantId && snapshot.lastAssistantId &&
          snapshot.lastAssistantId !== task.steerPauseAssistantId));
    const continuationObserved = nativeGenerationRunning() || newerAssistant;
    // A Stop produces a temporarily idle composer. Do not unlock the old
    // task until our follow-up has actually started its own generation/reply.
    if (task.steerPauseRequestedAt && !continuationObserved) return false;
    await rpc("STEER_CONFIRM", {
      id: task.id, lastUserText: snapshot.lastUserText,
      userCount: snapshot.userCount, lastUserId: snapshot.lastUserId,
      newUserElement: Boolean(steeringProbe?.id === task.id && steeringProbe.lastUserElement &&
        snapshot.lastUserElement && steeringProbe.lastUserElement !== snapshot.lastUserElement),
      ...(task.steerPauseRequestedAt ? {continuationObserved:true} : {}),
    });
    steeringProbe = null;
    resetVoiceReadiness();
    lastClaimAttempt = clock();
    notification = "";
    return true;
  }

  async function steerQueuedTask(id, nativeDraft = null) {
    const fromComposer = Boolean(nativeDraft);
    const actionKey = fromComposer ? "steer-prompt" : `steer-task:${id}`;
    if (pendingUiActions.has(actionKey)) return;
    if (!state || !boundHere() || state.halted) {
      throw new Error("当前对话不可引导，请返回原对话并确认没有暂停");
    }
    // The keyboard handler already holds the composer lock. A queue-row
    // action must acquire it here instead of rejecting the keyboard's lock.
    if ((!fromComposer && composerActionInProgress) || workInProgress) {
      throw new Error("正在发送另一条消息，请稍后再引导");
    }
    let editor = getEditor();
    if (fromComposer && (editor !== nativeDraft.editor || editorText(editor) !== nativeDraft.text)) {
      throw new Error("输入框或草稿已变化，未发送引导；输入内容已保留");
    }
    if (!editor && nativeGenerationRunning()) {
      const frame = nativeComposerAnchor();
      editor = [...(frame?.querySelectorAll(NATIVE_COMPOSER_EDITOR) || [])]
        .find(outsideForeignEditor) || null;
    }
    if (!editor) {
      throw new Error("未识别到 ChatGPT 输入框，任务已保留；请刷新页面或更新扩展");
    }
    if (!fromComposer && normalize(editorText(editor))) {
      throw new Error("输入框有未发送的内容，请先发送或清空，避免覆盖草稿");
    }
    if (hasComposerAttachments(editor)) {
      throw new Error("检测到附件，请先处理附件后再引导队列任务");
    }
    // A disabled placeholder can identify the native area for Stop only.
    // Sending still requires the strict live getEditor() after it recovers.
    const sameNativeEditor = () => getEditor() === editor ||
      !getEditor() && outsideForeignEditor(editor) && nativeComposerAnchor()?.contains(editor);
    const before = conversationSnapshot();
    const originalSession = sessionKey;
    const originalUrl = location.href;
    const originalScope = captureSendScope();
    let reserved = null;
    let armed = false;
    let pausing = false;
    let composerChanged = false;
    const onComposerEdit = (event) => {
      // Stop can reset the native composer with a synthetic input event.
      // Accept only an empty/exact owned draft during this controlled phase;
      // beforeinput/paste/cut/drop and real user edits still cancel steering.
      const observed = normalize(editorText(event.currentTarget));
      if (pausing && event.type === "input" && !event.isTrusted &&
          (!observed || observed === normalize(reserved?.text))) return;
      composerChanged = true;
    };
    const composerEditEvents = ["beforeinput", "input", "paste", "cut", "drop"];
    const watchedEditors = new Set();
    const watchEditor = (element) => {
      watchedEditors.add(element);
      for (const type of composerEditEvents) element.addEventListener(type, onComposerEdit, true);
    };
    const unwatchEditor = (element) => {
      for (const type of composerEditEvents) element.removeEventListener(type, onComposerEdit, true);
      watchedEditors.delete(element);
    };
    watchEditor(editor);
    composerActionInProgress = true;
    pendingUiActions.add(actionKey);
    showActionFeedback("正在准备引导，优先尝试直接发送…");
    render();
    try {
      // Reserve a typed instruction atomically. Enqueue-then-claim would let
      // a normal dispatcher take it between the two storage operations.
      const claim = await rpc(fromComposer ? "STEER_PROMPT_CLAIM" : "STEER_CLAIM", {
        ...(fromComposer ? {text: nativeDraft.text} : {id}),
        userCount: before.userCount, lastUserId: before.lastUserId,
        busy: before.busy,
      }, originalScope);
      if (claim.steerDeferred) {
        notification = "已移到待发送队首，当前回复结束后优先执行，不打断上一条任务。";
        return;
      }
      reserved = claim.dispatch;
      if (!reserved) throw new Error("任务无法锁定，未尝试发送");
      if (fromComposer) id = reserved.id;
      if (!sendScopeCurrent(originalScope) || state.halted || !editor.isConnected ||
          !sameNativeEditor() || sessionKey !== originalSession ||
          location.href !== originalUrl || composerChanged ||
          (fromComposer ? editorText(editor) !== nativeDraft.text ||
            normalize(editorText(editor)) !== normalize(reserved.text) : Boolean(normalize(editorText(editor)))) ||
          hasComposerAttachments(editor) || nativeUploadBusy(editor)) {
        throw new Error("对话或输入框已变化，未发送引导任务");
      }
      const writableEditor = (element) => Boolean(element &&
        !element.disabled && !element.readOnly && !element.matches(":disabled") &&
        !element.closest('[inert], [aria-readonly="true"], [aria-disabled="true"]') &&
        (element.isContentEditable || element.matches("textarea, input")));
      let draftInserted = fromComposer;
      if (!fromComposer && writableEditor(editor)) {
        unwatchEditor(editor);
        try {
          insertText(editor, reserved.text);
          draftInserted = true;
        } catch (error) {
          // Some running replies reject writes even though contenteditable
          // remains true. If nothing/deliberately all was inserted, proceed to
          // the Stop fallback; never overwrite a partial or changed draft.
          const observed = normalize(editorText(editor));
          if ((!nativeGenerationRunning() && !reserved.needsPause) ||
              observed && observed !== normalize(reserved.text)) throw error;
          draftInserted = observed === normalize(reserved.text);
        } finally {
          watchEditor(editor);
        }
      }

      const ownsSteering = () => Boolean(sendScopeCurrent(originalScope) && !state.halted &&
        sessionKey === originalSession && location.href === originalUrl &&
        state.steeringTaskId === id && !composerChanged &&
        conversationSnapshot().userCount === before.userCount);
      const unchangedDraft = () => Boolean(ownsSteering() && editor.isConnected &&
        sameNativeEditor() && normalize(editorText(editor)) === (draftInserted ? normalize(reserved.text) : "") &&
        !hasComposerAttachments(editor) && !nativeUploadBusy(editor));
      const safeToClick = (button) => Boolean(draftInserted && isVisible(button) &&
        writableEditor(editor) && getEditor() === editor &&
        controls().send === button && unchangedDraft() &&
        editor.closest('form, [data-testid="composer"], [data-chatgpt-composer]')?.contains(button));

      let send = null;
      for (let attempt = 0; attempt < 12; attempt++) {
        if (!unchangedDraft()) throw new Error("引导期间输入框或草稿已变化，未发送指令");
        if (!draftInserted) break;
        send = controls().send;
        if (safeToClick(send)) break;
        await sleep(250);
      }
      if (!safeToClick(send) && unchangedDraft() &&
          (nativeGenerationRunning() || reserved.needsPause)) {
        // Direct native steering was unavailable. Stop is a fallback only;
        // no Send click has happened and the unsent task is durably reserved.
        const pauseSnapshot = conversationSnapshot();
        showActionFeedback("网页暂不支持直接引导，正在暂停当前生成…");
        render();
        await rpc("STEER_PAUSING", {id,assistantCount:pauseSnapshot.assistantCount,
          lastAssistantId:pauseSnapshot.lastAssistantId}, originalScope);
        if (!unchangedDraft()) throw new Error("暂停前草稿已变化，未继续发送引导");
        pausing = true;
        let stopClicked = false;
        let idleSince = null;
        const pauseUntil = clock() + 15000;
        while (clock() < pauseUntil) {
          if (!ownsSteering()) throw new Error("暂停期间对话或草稿已变化，引导任务已保留");
          const current = getEditor();
          if (current && (hasComposerAttachments(current) || nativeUploadBusy(current))) {
            throw new Error("暂停期间检测到新附件，引导任务已保留");
          }
          const stop = controls().stop;
          if (!stopClicked && isVisible(stop)) {
            if (!unchangedDraft()) throw new Error("停止生成前输入框已变化，未继续引导");
            stop.click();
            stopClicked = true;
          }
          if (!nativeGenerationRunning() && !controls().stop) {
            idleSince ??= clock();
            if (clock() - idleSince >= 650) break;
          } else {
            idleSince = null;
          }
          await sleep(150);
        }
        if (idleSince === null || clock() - idleSince < 650 || nativeGenerationRunning()) {
          throw new Error("尚未确认当前生成已停止，已暂停队列并保留引导任务");
        }
        let resumedEditor = getEditor();
        const editorUntil = clock() + 8000;
        while (!writableEditor(resumedEditor) && clock() < editorUntil) {
          if (resumedEditor) watchEditor(resumedEditor);
          if (!ownsSteering() || resumedEditor && (
              normalize(editorText(resumedEditor)) && normalize(editorText(resumedEditor)) !== normalize(reserved.text) ||
              hasComposerAttachments(resumedEditor) || nativeUploadBusy(resumedEditor))) {
            throw new Error("恢复输入框期间检测到草稿变化，已暂停队列并保留内容");
          }
          await sleep(150);
          resumedEditor = getEditor();
        }
        const resumedText = normalize(editorText(resumedEditor));
        if (!ownsSteering() || !writableEditor(resumedEditor) || hasComposerAttachments(resumedEditor) ||
            nativeUploadBusy(resumedEditor) || resumedText && resumedText !== normalize(reserved.text)) {
          throw new Error("暂停后输入框或草稿已变化，已保留内容并暂停队列");
        }
        // ChatGPT may rebuild its empty composer when Stop completes. Adopt
        // that editor only while the route, task and untouched draft agree.
        if (resumedEditor !== editor) {
          unwatchEditor(editor);
          editor = resumedEditor;
          watchEditor(editor);
        }
        if (!resumedText) {
          unwatchEditor(editor);
          insertText(editor,reserved.text);
          watchEditor(editor);
        }
        draftInserted = true;
        pausing = false;
        showActionFeedback("当前生成已暂停，正在发送引导并继续回复…");
        render();
        const sendUntil = clock() + 8000;
        while (clock() < sendUntil) {
          if (!unchangedDraft()) throw new Error("发送前草稿已变化，已暂停队列并保留引导任务");
          send = controls().send;
          if (safeToClick(send)) break;
          await sleep(150);
        }
      }
      if (!safeToClick(send)) {
        throw new Error(fromComposer
          ? "未能确认可用的引导发送按钮，输入内容已保留，请核对后重试"
          : before.busy
          ? "当前 ChatGPT 网页不支持中途即时发送，任务已保留在原队列"
          : "输入框、草稿或附件在等待引导时发生变化，任务已保留在原队列");
      }

      // Arm the durable no-retry state before invoking ChatGPT's native Send.
      await rpc("STEER_CLICKED", { id }, originalScope);
      armed = true;
      // Persisting the no-retry lock is asynchronous. If the editor changes
      // during that RPC, do NOT click another composer or retry the send.
      if (!safeToClick(send)) {
        throw new Error("引导确认期间输入框发生变化，未点击发送；请核对当前队列后恢复");
      }
      unwatchEditor(editor);
      steeringProbe = { id, lastUserElement: before.lastUserElement };
      resetVoiceReadiness();
      send.click();
      showActionFeedback("引导已提交，等待网页确认并继续回复；不会重复发送");
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
        if (!fromComposer && editor.isConnected && getEditor() === editor && !composerChanged &&
            !hasComposerAttachments(editor) && !nativeUploadBusy(editor) &&
            normalize(editorText(editor)) === normalize(reserved.text)) {
          clearComposerText(editor, reserved.text);
        }
        try { await rpc("STEER_CANCEL", { id }, originalScope); }
        catch { /* The periodic recovery also releases unclicked reservations. */ }
      } else if (reserved && armed) {
        try { await rpc("STEER_UNCONFIRMED", { id }, originalScope); }
        catch { /* Persisted 'steering_wait' remains protected from replay. */ }
      }
      throw error;
    } finally {
      for (const element of watchedEditors) unwatchEditor(element);
      pendingUiActions.delete(actionKey);
      if (!fromComposer) composerActionInProgress = false;
      render();
      requestQueueWake();
    }
  }

  async function steerNativePrompt(editor, text) {
    // Idle Ctrl/Cmd+Enter uses native Send. A running reply goes through
    // steerQueuedTask's durable reservation and optional Stop fallback.
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

  function suggestionPopupOpen(editor) {
    // Keep native Enter for an actual slash/@ picker associated with this
    // editor, never for a hidden portal or another app surface elsewhere.
    const frame = editor.closest('form, [data-testid="composer"], [data-chatgpt-composer]');
    const field = editor.getBoundingClientRect();
    const controls = (editor.getAttribute("aria-controls") || "").split(/\s+/);
    const activeOption = document.getElementById(editor.getAttribute("aria-activedescendant") || "");
    return [...document.querySelectorAll('[role="listbox"], [cmdk-list]')].some((element) => {
      if (!isRendered(element) || root.contains(element) || element.closest(
        'aside, [data-testid^="conversation-turn-"], [data-message-author-role], ' +
        '[data-turn="assistant"], [data-turn="user"], [data-testid*="writing-block"], ' +
        '[data-testid*="artifact"], .markdown')) return false;
      // Slash/@ pickers may live in a popover with role=dialog/role=menu:
      // these roles alone do not make the *picker* unrelated to the composer.
      if (frame?.contains(element) || element.id && controls.includes(element.id) ||
          activeOption && element.contains(activeOption)) return true;
      // ChatGPT often portals a picker outside the form. Only a popup near
      // this composer is relevant; a sidebar picker cannot hijack Enter.
      const menu = element.getBoundingClientRect();
      return menu.left <= field.right + 80 && menu.right >= field.left - 80 &&
        menu.top <= field.bottom + 120 && menu.bottom >= field.top - 120;
    });
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
    if (root.contains(event.target) || suggestionPopupOpen(editor)) return;

    // Cancel the native send synchronously, before any async storage calls.
    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.repeat) return;
    if (extensionContextGone) {
      notification = "扩展连接已失效，请刷新 ChatGPT 页面后再入队；输入内容已保留。";
      queueExpanded = true;
      render();
      return;
    }
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
    const inputPage = captureSendScope();

    const run = async () => {
      // SPA navigation can happen before the next heartbeat. Re-read the new
      // chat's queue before deciding whether to send or enqueue.
      if (!boundHere()) await rpc("HELLO", { lastUserText: conversationSnapshot().lastUserText });
      syncSendRoute();
      if (location.href !== inputPage.url || sendPageEpoch !== inputPage.epoch || getEditor() !== editor) return;
      // Running replies use the same steering path as the row button:
      // direct Send first, Stop/send/continue only when direct Send is absent.
      if (steer && (state?.activeTaskId || state?.steeringTaskId ||
          conversationSnapshot().busy)) return steerQueuedTask(null, {editor, text});
      if (steer) return steerNativePrompt(editor, text);
      return queueNativePrompt(editor, text);
    };
    void run()
      .catch(showError)
      .finally(() => {
        composerActionInProgress = false;
        // Enqueue rendered while locked; refresh row actions after unlocking
        // so the pending instruction's steering button is immediately usable.
        render();
        requestQueueWake();
      });
  }, true);

  async function sendTask(task, scope = captureSendScope()) {
    if (workInProgress) return;
    // Keep internal-message handling compatible with a worker that omitted
    // kind in its dispatch payload; the owned queue record is authoritative.
    const ownedTask = state?.tasks.find((item) => item.id === task.id &&
      item.id === state.activeTaskId);
    if (ownedTask) task = {...task,kind:ownedTask.kind};
    const internalHandoff = ["handoff_summary","handoff_intro"].includes(task.kind);
    workInProgress = true;
    let clicked = false;
    let imageAttempted = false;
    let editor = null;
    let composerChanged = false;
    let debugGate = "prepare";
    let preparedHandoffText = null;
    let debugReason = "send_exception";
    const debugStartedAt = clock();
    const debugSend = (event,reason = "none") => {
      if (!internalHandoff) return;
      try { emitHandoffDebug(event,reason,handoffDebugDetails(task,{
        gate:debugGate,scopeCurrent:sendScopeCurrent(scope),
        sourceBound:Boolean((!task.sourceUrl || validUrl(task.sourceUrl) === validUrl(scope.url)) &&
          (!task.sourceSessionKey || task.sourceSessionKey === scope.sessionKey) &&
          (!task.projectVisitId || task.projectVisitId === scope.projectVisitId)),
        editorCurrent:Boolean(editor && getEditor() === editor),
        composerChanged,clicked,claimedEpoch:scope.epoch,
        ...handoffTextDifference(task.text,editorText(editor)),
        sendWaitMs:Math.max(0,clock()-debugStartedAt),
      })); } catch { /* A probe must not affect the send transaction. */ }
    };
    const onComposerEdit = (event) => {
      if (internalHandoff && handoffComposerWriteDepth) return;
      composerChanged = true;
      if (internalHandoff && event.isTrusted && !handoffComposerWriteDepth) {
        const record = handoffComposerRecords.get(task.id) || rememberHandoffComposer(task, editor);
        record.userEdited = true;
      }
    };
    try {
      debugSend("send_prepare");
      debugReason = sendScopeCurrent(scope) ? "task_not_owned" : "scope_changed";
      if (!sendScopeCurrent(scope) || !ownedTask || ownedTask.status !== "dispatching" ||
          task.sourceUrl && validUrl(task.sourceUrl) !== validUrl(scope.url) ||
          task.sourceSessionKey && task.sourceSessionKey !== scope.sessionKey ||
          task.projectVisitId && task.projectVisitId !== scope.projectVisitId || state.halted) {
        throw new Error("当前对话已切换或任务不属于原页面");
      }
      editor = getEditor();
      const reuseHandoffDocument = internalHandoff && matchingHandoffComposer(ownedTask, editor);
      const composerReady = reuseHandoffDocument
        ? isVisible(controls().send) && !nativeGenerationRunning()
        : isVisible(controls().voice) ||
        (internalHandoff && handoffComposerReady(conversationSnapshot()));
      debugReason = !editor ? "editor_missing" :
        normalize(editorText(editor)) && !reuseHandoffDocument ? "editor_has_text" :
        controls().stop ? "native_stop" : hasComposerAttachments(editor)
          ? "attachments_present" : "composer_not_ready";
      if (!editor || (normalize(editorText(editor)) && !reuseHandoffDocument) || controls().stop ||
          !composerReady || hasComposerAttachments(editor)) {
        throw new Error("原生输入框或回复结束信号尚未就绪，稍后再发");
      }
      debugReason = "send_exception";
      if (internalHandoff && !reuseHandoffDocument) rememberHandoffComposer(task, editor);
      if (internalHandoff && reuseHandoffDocument && !handoffComposerRecords.has(task.id)) {
        rememberHandoffComposer(task, editor);
      }
      if (reuseHandoffDocument) { debugGate = "reuse"; debugSend("send_reuse","prepared_document"); }
      if (internalHandoff) {
        editor.addEventListener("beforeinput",onComposerEdit,true);
        editor.addEventListener("input",onComposerEdit,true);
      }
      if (task.text && !reuseHandoffDocument) {
        if (internalHandoff) await insertHandoffText(editor,task,scope);
        else insertText(editor,task.text);
      }
      // The native Send button can appear seconds after we insert the task.
      // A user may edit the same field in that gap (even back to identical
      // text). Never treat that user action as authorization to send the row.
      editor.addEventListener("beforeinput", onComposerEdit, true);
      editor.addEventListener("input", onComposerEdit, true);
      if (task.images?.length) {
        imageAttempted = true;
        await restoreNativeImages(editor, task, scope);
      }
      if (internalHandoff) preparedHandoffText = editorText(editor);

      let send = null;
      debugGate = "wait_send";
      debugSend("send_wait");
      const sendDeadline = clock() + 3600;
      while (clock() < sendDeadline) {
        debugReason = !sendScopeCurrent(scope) ? "scope_changed" :
          getEditor() !== editor ? "editor_replaced" :
          composerChanged ? "composer_edited" : "task_not_owned";
        if (!sendScopeCurrent(scope) || getEditor() !== editor || composerChanged ||
            state?.activeTaskId !== task.id || state.halted) {
          throw new Error("等待发送时原对话或输入框已变化");
        }
        send = controls().send;
        if (isVisible(send) && !controls().stop) break;
        await sleep(40);
      }
      debugReason = "send_not_ready";
      if (!isVisible(send) || controls().stop || !boundHere() || state.halted) {
        throw new Error("发送按钮不可用或对话已停止，拒绝自动发送");
      }
      if (task.kind === "handoff_summary" && state.handoff?.cancelRequested) {
        // A cancellation arrived while the native editor was being prepared.
        // We have not clicked Send: safely release the special queue row.
        if (!composerChanged && !handoffComposerRecords.get(task.id)?.userEdited &&
            handoffTextMatch(task.text,editorText(editor)).matches) {
          handoffComposerWriteDepth++;
          try { clearComposerText(editor,editorText(editor)); }
          finally { handoffComposerWriteDepth--; }
        }
        await rpc("RELEASE_CLAIM",{id:task.id},scope);
        debugGate = "release";
        debugSend("claim_release","claim_released");
        notification = "已取消本轮接力，没有发送总结";
        return;
      }
      // All checks immediately precede the native click, after all waits,
      // uploads and any React composer re-mount. This is the final no-send
      // gate: neither a changed draft nor a replacement editor may be sent
      // under the ownership of the original queued task.
      if (internalHandoff) {
        if (editorText(editor) !== preparedHandoffText) {
          debugReason = "composer_edited";
          throw new Error("交接草稿在准备后发生变化，未申请发送");
        }
        debugGate = "arm";
        debugReason = "task_not_owned";
        const ready = await rpc("HANDOFF_SEND_READY",{id:task.id},scope);
        if (!ready.sendReady) throw new Error("后台未确认本轮交接仍可发送，已保留草稿");
        debugSend("send_ready");
      }
      debugGate = "final_send";
      debugReason = !sendScopeCurrent(scope) ? "scope_changed" :
        !editor.isConnected || getEditor() !== editor ? "editor_replaced" :
        composerChanged || handoffComposerRecords.get(task.id)?.userEdited ? "composer_edited" :
        (internalHandoff ? !handoffTextMatch(task.text,editorText(editor)).matches ||
          editorText(editor) !== preparedHandoffText : normalize(editorText(editor)) !== normalize(task.text)) ? "text_mismatch" :
        nativeUploadBusy(editor) ? "upload_busy" :
        nativeAttachmentCount(editor) !== (task.images?.length || 0) ? "attachments_mismatch" : "send_not_ready";
      if (!editor.isConnected || getEditor() !== editor ||
          !sendScopeCurrent(scope) ||
          state.activeTaskId !== task.id || composerChanged ||
          (internalHandoff && (handoffComposerRecords.get(task.id)?.userEdited ||
            handoffComposerRecords.get(task.id)?.clicked)) ||
          (internalHandoff ? !handoffTextMatch(task.text,editorText(editor)).matches ||
            editorText(editor) !== preparedHandoffText : normalize(editorText(editor)) !== normalize(task.text)) ||
          nativeUploadBusy(editor) ||
          nativeAttachmentCount(editor) !== (task.images?.length || 0) ||
          !editor.closest('form, [data-testid="composer"], [data-chatgpt-composer]')?.contains(send)) {
        throw new Error("输入框、草稿或附件在等待发送时发生变化，未执行原生发送；请核对当前草稿");
      }
      editor.removeEventListener("beforeinput", onComposerEdit, true);
      editor.removeEventListener("input", onComposerEdit, true);
      resetVoiceReadiness();
      handoffComposerIdleSince = 0;
      handoffReplyProbe = null;
      debugSend("native_send_click");
      clicked = true;
      if (internalHandoff && handoffComposerRecords.has(task.id)) handoffComposerRecords.get(task.id).clicked = true;
      immediateDispatchScope = null;
      send.click();
      // Record the click immediately against its original reservation. A new
      // chat's /c/ route is adopted separately by HELLO when its user turn
      // mounts; do not wait seconds here or acknowledge an unrelated new page.
      debugGate = "ack";
      debugReason = "ack_failed";
      await rpc("SENT", { id: task.id, lastUserText: task.text }, scope);
      debugSend("send_ack");
      requestQueueWake();
    } catch (error) {
      debugSend(clicked ? "send_exception" : "send_gate_blocked",debugReason);
      if (clicked && ["handoff_summary","handoff_intro"].includes(task.kind)) {
        emitHandoffDebug("send_uncertain","native_send_unconfirmed");
      }
      if (!clicked && (!imageAttempted || !sendScopeCurrent(scope))) {
        // Only our own unsubmitted text may be removed; never clear a user's
        // changed draft. Requeue without turning a transient UI race into a
        // permanently halted scheduled task.
        if (!internalHandoff && location.href === scope.url && sessionKey === scope.sessionKey &&
            editor?.isConnected && getEditor() === editor && !composerChanged &&
            normalize(editorText(editor)) === normalize(task.text) &&
            !hasComposerAttachments(editor) && !nativeUploadBusy(editor)) {
          clearComposerText(editor, task.text);
        }
        try {
          await rpc("RELEASE_CLAIM", { id: task.id }, scope);
          debugGate = "release";
          debugSend("claim_release","claim_released");
          if (sendScopeCurrent(scope)) {
            notification = internalHandoff && !handoffTextMatch(task.text,editorText(editor)).matches
              ? task.kind === "handoff_intro"
                ? "交接文档写入结果不一致，尚未发送；可用「替换草稿并重试交接」恢复。"
                : "交接总结请求写入结果不一致，尚未发送；请核对草稿后取消本轮接力再重试。"
              : "";
          }
          return;
        } catch {
          debugGate = "release";
          debugSend("claim_release","claim_release_failed");
        }
      }
      try { await rpc("FAIL", { id: task.id, error: error.message }, scope); }
      catch { /* Context may have been invalidated by extension reload. */ }
      if (!sendScopeCurrent(scope)) return;
      if (imageAttempted && !clicked) {
        notification = "图片未确认上传，已暂停自动接力。请检查原生输入框中的残留图片和文字。";
      }
      showError(error);
    } finally {
      editor?.removeEventListener("beforeinput", onComposerEdit, true);
      editor?.removeEventListener("input", onComposerEdit, true);
      workInProgress = false;
      render();
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
    emitHandoffDebug("navigation_start");
    const scope = captureSendScope();
    await rpc("HANDOFF_NAVIGATE",{userCount:conversationSnapshot().userCount},scope);
    if (!sendScopeCurrent(scope) || state?.handoff?.phase !== "navigating") return false;
    emitHandoffDebug("navigation_committed");
    location.assign(url.href); // Same Edge tab, never a new background tab.
    return true;
  }

  async function heartbeat() {
    if (maybeReloadConversationLoadError()) return;
    if (extensionContextGone) return;
    // Track the native square Stop button even for chats without a queue.
    setTabRunning(tabGenerationRunning());
    if (heartbeatInProgress) return;
    heartbeatInProgress = true;
    try {
      syncSendRoute();
      if (location.href !== lastLocation) {
        lastLocation = location.href;
        notification = "";
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
        nativeErrorFirstSeenAt = 0;
        handoffComposerIdleSince = 0;
        handoffReplyProbe = null;
        const snapshot = conversationSnapshot();
        await rpc("HELLO", { lastUserText: snapshot.lastUserText });
        render();
      }

      if (!state) {
        root.remove();
        return;
      }
      if (mountNearComposer() && !root.firstElementChild) {
        // Initial render may run before ChatGPT mounts its empty composer.
        // Once an anchor appears, populate the panel without waiting for a
        // typed message or a queue/storage change to trigger another render.
        render();
      }

      // A new conversation URL can appear before its first user message mounts.
      // Keep trying the safe adoption handshake; never adopt unrelated chats.
      if (sessionKey?.startsWith("draft:") && state.activeTaskId &&
          pageChatKey(location.href) && !boundHere()) {
        const introduction = handoffIntroductionSnapshot();
        await rpc("HELLO", { lastUserText: introduction.lastUserText,
          userCount:introduction.userCount, lastUserId:introduction.lastUserId });
        if (boundHere()) render();
      }

      await probePendingHandoff(conversationSnapshot());

      if (!boundHere()) {
        if (state.handoffSourceKey && pageChatKey(location.href)) {
          emitHandoffDebug("new_chat_pending","waiting_chat_id");
        }
        return;
      }
      const heartbeatScope = captureSendScope();
      const snapshot = conversationSnapshot();
      updateHandoffProgress(snapshot);
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
      emitHandoffDebug("page_wait","none",{gate:"dispatch"});
      const nativeTransportError = observeNativeTransportError();
      if (composerActionInProgress || workInProgress || !sendScopeCurrent(heartbeatScope)) return;
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
      if (state.handoff?.phase === "due" ||
          state.handoff?.phase === "opening" ||
          state.handoffSourceKey && active?.status !== "waiting") {
        emitHandoffDebug("page_wait",
          handoffDebugWaitReason(snapshot,voiceReady,active,null,nativeTransportError));
      }

      // A red ChatGPT transport-timeout banner can coexist with a visible
      // Voice button. It is NOT a completed assistant response. Quarantine
      // only an already-clicked task after the banner persists; never click
      // native Retry or replay an uncertain tool/message operation.
      if (!state.halted && active?.status === "waiting" && nativeTransportError &&
          Number.isFinite(active.sentAt) && nativeErrorFirstSeenAt >= active.sentAt) {
        if (clock() - nativeErrorFirstSeenAt >= NATIVE_ERROR_STABLE_MS) {
          await rpc("FAIL", {
            id: active.id, userCount: snapshot.userCount,
            error: "ChatGPT 网页提示传输超时或连接中断，本轮结果无法确认；已跳过，不会自动重发。",
          });
          render();
        }
        return;
      }

      // A Voice button beside a native transport error is not recovery proof.
      // Keep the remaining queue still while the periodic guardian refreshes.
      if (nativeTransportError) return;

      if (state.halted) {
        // ChatGPT can return to its normal Voice Mode button after a transport
        // error even though an old plugin failure/timeout has locked the queue.
        // Automatically retire only that uncertain attempt and continue the
        // remaining pending work. Never override a user's native Stop.
        if (!(state.handoffSourceKey && state.handoff?.phase === "failed") &&
            voiceReady && ["failure", "timeout", "uncertain", "steer_unconfirmed"]
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
        if (["handoff_summary","handoff_intro"].includes(active.kind)) {
          emitHandoffDebug("completion_probe",
            handoffDebugWaitReason(snapshot,voiceReady,active,
              handoffEvidence,nativeTransportError),{
                gate:"completion",newerAssistant:Boolean(handoffEvidence.newerAssistant),
                responseConfirmed:Boolean(handoffEvidence.responseConfirmed),
                idleStableMs:handoffEvidence.idleStableMs || 0,
                replyStableMs:handoffEvidence.replyStableMs || 0,
              });
        }
        const waveformComplete = readyToComplete(active, voiceReady);
        // A settled composer alone is not proof of the next reply. Even with
        // native Voice Mode, do not capture old text or a partially hydrated
        // answer while the current handoff summary is still arriving.
        const summaryReady = active.kind !== "handoff_summary" ||
          state.handoff?.cancelRequested ||
          (handoffEvidence.newerAssistant && handoffEvidence.summary &&
            handoffEvidence.replyStableMs >= 2500);
        if ((handoffEvidence.ready || waveformComplete) && summaryReady) {
          await rpc("FINISHED", {
            id: active.id,
            viewed: isTabViewed(),
            voiceReady,
            voiceStableMs: voiceReady ? clock() - voiceReadySince : 0,
            editorEmpty: Boolean(getEditor() && !normalize(editorText(getEditor()))),
            busy: snapshot.busy,
            ...(handoffEvidence.ready ? {
              handoffReady:true, handoffNativeIdle:true,
              handoffResponseConfirmed:handoffEvidence.responseConfirmed,
              handoffIdleStableMs:handoffEvidence.idleStableMs,
              handoffReplyStableMs:handoffEvidence.replyStableMs,
            } : {}),
            ...(active.kind === "handoff_summary" ? {userCount:snapshot.userCount} : {}),
            ...(active.kind === "handoff_summary" ? {
              handoffSummary:handoffEvidence.summary,
              handoffReplyIsNew:handoffEvidence.newerAssistant === true,
              handoffLastRole:snapshot.lastRole,
              handoffAssistantCount:snapshot.assistantCount,
              handoffAssistantId:snapshot.lastAssistantId,
              handoffLastUserText:snapshot.lastUserText,
            } : {}),
          }, heartbeatScope);
          render();
          if (sendScopeCurrent(heartbeatScope) && !state.activeTaskId) {
            lastClaimAttempt = 0;
            requestQueueWake();
          }
        } else if (voiceReady && Number.isFinite(active.sentAt) &&
            clock() - active.sentAt < VOICE_READY_STABLE_MS) {
          requestQueueWake(VOICE_READY_STABLE_MS - (clock() - active.sentAt));
        }
        return;
      }

      const handoffNeedsDispatch = state.handoff?.phase === "due" ||
        state.handoff?.phase === "queued" &&
          state.tasks.find((task) => task.status === "pending")?.kind === "handoff_summary" ||
        state.handoff?.phase === "summarizing" && state.tasks.some((task) =>
          task.kind === "handoff_summary" && task.status === "pending") ||
        Boolean(state.handoffSourceKey &&
          state.tasks.some((task) => task.kind === "handoff_intro" &&
            task.status === "pending"));
      const manualReady = immediateDispatchScope &&
        immediateDispatchScope.expiresAt >= clock() && sendScopeCurrent(immediateDispatchScope) &&
        isVisible(controls().voice) && !controls().stop && !nativeGenerationRunning() &&
        getEditor() && !normalize(editorText(getEditor())) && !hasComposerAttachments(getEditor());
      const preparedHandoff = preparedHandoffTask();
      const preparedHandoffReady = preparedHandoff && isVisible(controls().send) &&
        !controls().stop && !nativeGenerationRunning();
      const dispatchReady = idle || manualReady || preparedHandoffReady ||
        (handoffNeedsDispatch && handoffComposerReady(snapshot));
      if (state.queuePaused || active || !dispatchReady ||
          (temporaryNewChat() && snapshot.userCount > 0)) {
        if (handoffNeedsDispatch) emitHandoffDebug("dispatch_blocked","dispatch_blocked",{
          gate:"dispatch",resumeCandidate:Boolean(preparedHandoff),
          preparedMatch:Boolean(preparedHandoffReady),
          dispatchBlockedReason:state.queuePaused ? "paused" : active ? "active_task" :
            !dispatchReady ? "not_ready" : "target_mismatch",
        });
        return;
      }
      if (!sendScopeCurrent(heartbeatScope) ||
          !handoffNeedsDispatch && !state.tasks.some((task) => task.status === "pending")) return;
      const claimBackoff = 250 - (clock() - lastClaimAttempt);
      if (claimBackoff > 0) { requestQueueWake(claimBackoff); return; }
      lastClaimAttempt = clock();
      // Capture before the asynchronous claim. Never recapture the destination
      // after the worker returns, even if the tab has since changed pages.
      const claimScope = captureSendScope();
      emitHandoffDebug("send_prepare","none",{gate:"claim",
        scopeCurrent:sendScopeCurrent(claimScope),resumeCandidate:Boolean(preparedHandoffReady)});
      let claimed;
      try { claimed = await rpc("CLAIM", {
        ready: true,
        ...(preparedHandoffReady ? {resumeHandoffTaskId:preparedHandoff.id} : {}),
        userCount: snapshot.userCount,
        lastUserId: snapshot.lastUserId,
        assistantCount:snapshot.assistantCount,
        lastAssistantId:snapshot.lastAssistantId,
        lastAssistantSignature:snapshot.lastAssistantSignature,
      }, claimScope); }
      catch (error) {
        emitHandoffDebug("claim_result","claim_exception",{
          gate:"claim",scopeCurrent:sendScopeCurrent(claimScope)});
        throw error;
      }
      emitHandoffDebug("claim_result",claimed.dispatch ? "claim_acquired" :
        claimed.claimDiagnostic?.outcome === "rejected" ? "claim_rejected" : "claim_empty",{
          gate:"claim",scopeCurrent:sendScopeCurrent(claimScope),
          resumeCandidate:Boolean(preparedHandoffReady),
        });
      if (sendScopeCurrent(claimScope)) updateDraftWaiting();
      if (claimed.dispatch) {
        if (sendScopeCurrent(claimScope)) render();
        await sendTask(claimed.dispatch, claimScope);
      }
    } catch (error) {
      showError(error);
    } finally {
      heartbeatInProgress = false;
      if (queueWakePending) { queueWakePending = false; requestQueueWake(); }
    }
  }

  async function init() {
    // Full-page load failures have no composer/panel and must also recover
    // when initial queue setup fails or is still waiting on the worker.
    window.setInterval(() => { void heartbeat(); }, POLL_MS);
    window.setInterval(updateCountdowns, 1000);
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
    } catch (error) {
      root.textContent = "任务队列扩展初始化失败，请刷新页面：" + (error.message || error);
      console.error("[ChatQueue]", error);
    }
  }

  globalThis.__cqLoadRecoveryGuardian?.setGuard?.(loadErrorRefreshSafe);
  void init();
})();
