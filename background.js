/* global chrome */
"use strict";
importScripts("image-store.js", "handoff.js", "remote-dispatch.js");

// One serialized service worker owns every conversation's queue. The storage
// envelope is shared, but task dispatch and scheduler state are per-chat.
const STORAGE_KEY = "cq.state.v2";
const LEGACY_KEY = "cq.state.v1";
const HANDOFF_DEBUG_KEY = "cq.handoffDebug.v1";
const HANDOFF_DEBUG_MAX_RUNS = 12;
const HANDOFF_DEBUG_MAX_EVENTS = 80;
const HANDOFF_DEBUG_PHASES = new Set([
  "queued","due","summarizing","opening","navigating","bootstrapping","failed","completed",
]);
const HANDOFF_DEBUG_SIGNALS = new Set([
  "page_wait","native_send_click","navigation_start","navigation_committed",
  "send_uncertain","new_chat_pending",
  "send_prepare","send_reuse","send_wait","send_gate_blocked","claim_release",
  "send_ack","send_exception","adoption_probe","adoption_expand",
  "completion_probe","dispatch_blocked","claim_result",
  "input_start","input_complete","input_failed","send_ready","adoption_result",
]);
const HANDOFF_DEBUG_REASONS = new Set([
  "none","editor_missing","editor_has_text","attachments_present",
  "native_busy","native_stop","voice_not_ready","assistant_not_new",
  "reply_not_stable","waiting_native_reply","waiting_chat_id",
  "waiting_project_page","page_not_ready","transport_error",
  "native_send_unconfirmed","other_blocker",
  "scope_changed","task_not_owned","composer_not_ready","send_not_ready",
  "editor_replaced","composer_edited","text_mismatch","attachments_mismatch",
  "upload_busy","claim_released","claim_release_failed","ack_failed","send_exception",
  "prepared_document","adoption_wait","adoption_folded","completion_wait","dispatch_blocked",
  "claim_empty","claim_rejected","claim_exception","claim_acquired",
  "target_exists_shell","target_has_work","owner_mismatch","project_mismatch","source_missing",
  "source_phase","token_mismatch","destination_mismatch","intro_missing","message_mismatch",
  "user_count_mismatch","adopted","ready","cache_mismatch","adoption_ambiguous",
]);
const HANDOFF_DEBUG_DETAIL_BOOLEANS = new Set([
  "scopeCurrent","boundHere","editorConnected","editorCurrent","editorPresent",
  "sendVisible","voiceVisible","stopVisible","nativeBusy","composerEdited",
  "textMatches","hasAttachments","uploadBusy","reuseDocument","resumeCandidate","sourceBound",
  "activeMatches","halted","queuePaused","sendPresent","sendDisabled","composerChanged",
  "trustedEdited","clicked","preparedMatch","exactTextMatches","lastUserFolded",
  "newerAssistant","responseConfirmed","firstUserOnly","targetShell","adopted","usedTolerance",
]);
const HANDOFF_DEBUG_DETAIL_NUMBERS = new Set([
  "textChars","expectedChars","attachmentCount","expectedAttachmentCount","waitMs",
  "userCount","assistantCount","elapsedMs","editorChars","editorNormalizedChars",
  "taskChars","taskNormalizedChars","voiceStableMs","idleStableMs","replyStableMs",
  "sendWaitMs","navigationEpoch","claimedEpoch","inputElapsedMs","inputParagraphs",
  "commonPrefixChars","commonSuffixChars","expectedDifferenceChars","editorDifferenceChars",
  "expectedControlChars","editorControlChars",
  "extraTextChars","targetSystemHistoryCount","targetBusinessHistoryCount",
]);
const HANDOFF_DEBUG_DETAIL_ENUMS = {
  gate:new Set(["prepare","reuse","wait","final_click","release","ack","adoption",
    "completion","dispatch","export","claim","final_send","wait_send","input","arm"]),
  inputMethod:new Set(["paste","html","nativeValue"]),
  textDifferenceKind:new Set(["equal","whitespace","format_controls","content"]),
  targetBlocker:new Set(["none","owner","linked","tasks","schedules","active","paused",
    "submissions","history","configuration","queue_history","metadata","unknown_field"]),
  stage:new Set(["none","probe","before_claim","after_claim","before_insert","after_insert",
    "waiting_send","before_click","after_click","before_release","after_release",
    "before_ack","after_ack","before_expand","after_expand"]),
  taskKind:new Set(["none","normal","handoff_summary","handoff_intro"]),
  taskStatus:new Set(["none","pending","dispatching","waiting","steering","steering_wait",
    "done","error","interrupted"]),
  dispatchBlockedReason:new Set(["none","halted","paused","active_task","steering",
    "owner_mismatch","target_mismatch","not_ready","busy_handoff","retry_wait","no_pending",
    "cooldown","resume_handoff_mismatch"]),
  route:new Set(["project","chat","other"]),
  sessionKind:new Set(["draft","chat","none"]),
  handoffPhase:new Set([...HANDOFF_DEBUG_PHASES,"idle","none"]),
};
const HANDOFF_DEBUG_CRITICAL_SIGNALS = new Set([
  "native_send_click","navigation_start","navigation_committed","send_ack",
  "send_exception","claim_release","send_gate_blocked","send_prepare","send_reuse",
  "input_start","input_complete","input_failed","send_ready",
]);
const HANDOFF_DEBUG_PROBE_SIGNALS = new Set([
  "page_wait","send_wait","adoption_probe","completion_probe","dispatch_blocked",
  "new_chat_pending","claim_result","adoption_result",
]);
const ALARM_NAME = "cq.scheduler";
const PROTECTED_TABS_KEY = "cq.protectedTabs.v1";
const UPDATE_REFRESH_KEY = "cq.updateRefresh.v1";
const DASHBOARD_PAGE = "dashboard.html";
const DASHBOARD_VIEW_KEY = "cq.dashboard.view.v1";
const DASHBOARD_ALIASES_KEY = "cq.dashboard.aliases.v1";
const DASHBOARD_PROJECTS_KEY = "cq.dashboard.projects.v1";
const DASHBOARD_KEY_PATTERN = /^(?:chat:[a-zA-Z0-9-]+|draft:\d+)$/;
const FAVORITES_PAGE = "favorites.html";
const MAX_FAVORITES = 100;
const MAX_FAVORITE_TITLE_LENGTH = 80;
const MAX_FAVORITE_CATEGORY_LENGTH = 24;
const MAX_FAVORITE_TEMPLATE_FIELDS = 12;
const MAX_FAVORITE_TEMPLATE_FIELD_VALUE = 3000;
// An escaped \\{{field}} is literal text, not a variable.
const FAVORITE_TEMPLATE_PATTERN = /\\?\{\{([^{}\r\n]*)\}\}/g;
const FAVORITE_TEMPLATE_FIELD_NAME = /^[\p{L}\p{N}_][\p{L}\p{N}_ -]{0,31}$/u;
const FAVORITES_BACKUP_FORMAT = "chatgpt-taskqueue-favorites";
const FAVORITES_BACKUP_VERSION = 1;
const MAX_FAVORITES_BACKUP_BYTES = 60 * 1024 * 1024;
const FAVORITE_ACTIONS = new Set([
  "GET_FAVORITES", "ADD_FAVORITE", "RENAME_FAVORITE", "UPDATE_FAVORITE",
  "DELETE_FAVORITE", "GET_FAVORITES_BACKUP_META", "GET_FAVORITES_BACKUP_IMAGE",
  "RESTORE_FAVORITES_BEGIN", "RESTORE_FAVORITES_IMAGE",
  "RESTORE_FAVORITES_FINISH", "RESTORE_FAVORITES_ABORT",
]);
// Ephemeral page observations are separate from the durable queue store.
// A missing pulse may indicate a sleeping tab, not a failed ChatGPT reply.
const PAGE_PULSE_FRESH_MS = 20_000;
const PAGE_PULSE_LIMIT = 256;
const pagePulses = new Map();
// Only metadata event names are allowed into the cross-chat dashboard.
// History payloads, message text, image data, errors and task IDs stay in
// the per-conversation store, even if a legacy entry is malformed.
const DASHBOARD_EVENT_TYPES = new Set([
  "manual_enqueue", "auto_count", "auto_time", "claim", "sent", "finished",
  "deferred", "send_failed", "timeout", "steer_timeout",
  "task_edited", "task_deleted", "waiting_dismissed", "task_pinned", "task_reordered",
  "steer_claim", "steer_pausing", "steer_clicked", "steer_cancel", "steer_confirm",
  "steer_uncertain", "state_inconsistent", "tab_revived",
  "tab_reopened", "tab_owner_rebound", "tab_reopen_failed",
    "user_stopped", "user_resumed", "auto_recovered", "failed_skipped",
  "review_confirmed", "schedule_added", "schedule_edited",
  "schedule_deleted", "schedule_toggled", "queue_paused",
  "queue_resumed", "rate_limit_updated", "backup_restored",
    "send_cooldown_updated", "handoff_due", "handoff_manual", "handoff_setting",
    "handoff_summary", "handoff_new_chat", "handoff_completed",
    "handoff_received", "handoff_failed", "handoff_cancelled", "handoff_retry",
]);
const UPDATE_REFRESH_STABLE_MS = 1800;
// Keep the configurable cap bounded: chrome.storage.local has a shared quota.
const MAX_PENDING = 200;
const DEFAULT_PENDING_LIMIT = 100;
const MIN_QUEUE_LIST_HEIGHT = 72;
const MAX_QUEUE_LIST_HEIGHT = 900;
const DEFAULT_INTERVAL_MINUTES = 30;
const DEFAULT_REPEAT_COUNT = -1;
const MAX_INTERVAL_MINUTES = 525600;
const DEFAULT_COUNT_WINDOW_MINUTES = 10;
const DEFAULT_COUNT_WINDOW_MAX_ADDS = 3;
const MAX_COUNT_WINDOW_MINUTES = 1440;
const MAX_COUNT_WINDOW_ADDS = 200;
// Per-conversation pause between completed queue turns (0 disables it).
const DEFAULT_SEND_COOLDOWN_SECONDS = 0;
const MAX_SEND_COOLDOWN_SECONDS = 3600;
const MAX_TEXT_LENGTH = 12000;
const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_REPEAT_COUNT = 1_000_000;
const HISTORY_LIMIT = 80;
const SUBMISSION_HISTORY_LIMIT = 128;
const SUBMISSION_HISTORY_TTL_MS = 24 * 60 * 60 * 1000;
const BACKUP_FORMAT = "chatgpt-taskqueue-conversation";
const BACKUP_VERSION = 1;
const MAX_BACKUP_BYTES = 60 * 1024 * 1024;
const BACKUP_STAGE_TIMEOUT_MS = 15 * 60 * 1000;
const TAB_REVIVE_BACKOFF_MS = 2 * 60 * 1000;
const IMAGE_SHA256_PATTERN = /^[0-9a-f]{64}$/;
const WAIT_TIMEOUT_MS = 45 * 60 * 1000;
const DISPATCH_TIMEOUT_MS = 90 * 1000;
const HANDOFF_PREPARE_TIMEOUT_MS = 10 * 60 * 1000;
const STEER_RESERVE_TIMEOUT_MS = 60 * 1000;
const STEER_CONFIRM_TIMEOUT_MS = 2 * 60 * 1000;

let serial = Promise.resolve();
let updateRefreshInProgress = null;
const loadRecoveryInstallations = new Map();
// A discarded tab may remain flagged as such while Chrome processes reload().
// Throttle wake attempts so the minute alarm cannot repeatedly reload it.
const recentTabRevives = new Map();
const recentTabOpens = new Map();
// Temporary restoration sessions live only in the service worker. A restart
// invalidates their tokens; the next startup removes their orphan images.
const pendingBackupRestores = new Map();
const pendingFavoriteRestores = new Map();

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
    queuePaused: false,
    compactView: false,
    sendCooldownSeconds: DEFAULT_SEND_COOLDOWN_SECONDS,
    lastQueueSettledAt: null,
    haltReason: null,
    haltAtUserCount: null,
    activeTaskId: null,
    steeringTaskId: null,
    autoOpenTab: false,
    error: "",
    // A completed response remains unreviewed until this conversation is
    // actually brought to the foreground. Survives refreshes and MV3 restarts.
    unreadCompleted: false,
    tasks: [],
    schedules: [],
    countRateLimit: {
      enabled: false,
      windowMinutes: DEFAULT_COUNT_WINDOW_MINUTES,
      maxAdds: DEFAULT_COUNT_WINDOW_MAX_ADDS,
    },
    countRateTimes: [],
    history: [],
    recentSubmissions: [],
    remoteSteerConfirmedIds: [],
    firstSeenAt: null,
    firstMessageAt: null,
    handoff: CQHandoff.defaults(),
  };
}

function blankStore() {
  return {
    version: 2, conversations: {}, handoffQueues: {}, legacyUnbound: null, favorites: [],
    settings: {
      maxPending: DEFAULT_PENDING_LIMIT,
      protectBackground: true,
      defaultIntervalMinutes: DEFAULT_INTERVAL_MINUTES,
      defaultRepeatCount: DEFAULT_REPEAT_COUNT,
      queueListHeight: null,
    },
  };
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

function isProjectOverview(url) {
  const normal = safeUrl(url);
  return Boolean(normal &&
    /^\/g\/g-p-[a-zA-Z0-9-]+(?:\/project)?$/.test(new URL(normal).pathname));
}

function draftProjectId(url) {
  const normal = safeUrl(url);
  if (!normal) return null;
  const match = new URL(normal).pathname.match(/^\/g\/(g-p-[a-zA-Z0-9-]+)(?:\/project|\/c\/[a-zA-Z0-9-]+)?$/);
  return match ? CQHandoff.normalizeProjectId(match[1]) : null;
}

function sameDraftScope(firstUrl, secondUrl) {
  const first = safeUrl(firstUrl);
  const second = safeUrl(secondUrl);
  if (!first || !second || new URL(first).origin !== new URL(second).origin) return false;
  const projectId = draftProjectId(first);
  const nextProjectId = draftProjectId(second);
  return projectId || nextProjectId ? Boolean(projectId && projectId === nextProjectId) : first === second;
}

function draftCanAdoptChat(draft, url) {
  const first = safeUrl(draft?.url);
  const second = safeUrl(url);
  if (!first || !second || new URL(first).origin !== new URL(second).origin) return false;
  return draftProjectId(first) === draftProjectId(second);
}

function canDiscardProjectDraft(state) {
  return Boolean(state && isProjectOverview(state.url) && !state.handoffSourceKey &&
    !state.activeTaskId && !state.steeringTaskId && !handoffBusy(state) &&
    !state.tasks.some((task) => ["dispatching","waiting","steering","steering_wait"].includes(task.status)));
}

async function discardDepartedProjectDraft(store, tabId, nextUrl = null) {
  const key = `draft:${tabId}`;
  const draft = store.conversations[key];
  if (!draft?.projectVisitId || !canDiscardProjectDraft(draft) ||
      nextUrl && isProjectOverview(nextUrl) && sameDraftScope(draft.url, nextUrl)) return false;
  delete store.conversations[key];
  await saveStore(store);
  await cleanupUnusedImages(store);
  return true;
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
  if (data[STORAGE_KEY] != null) {
    const saved = data[STORAGE_KEY];
    if (saved.version !== 2 || !saved.conversations ||
        typeof saved.conversations !== "object" || Array.isArray(saved.conversations) ||
        Object.values(saved.conversations).some((conversation) =>
          !conversation || !Array.isArray(conversation.tasks) ||
          !Array.isArray(conversation.schedules))) {
      // A later plugin version (or a partially corrupted write) must never
      // be silently replaced by an empty v2 store. Doing so followed by the
      // startup image prune would permanently erase every existing image.
      throw new Error("检测到不兼容或损坏的队列存档，已停止读写以保护原有任务和图片；请先备份或使用匹配版本");
    }
    if (saved.handoffQueues != null && (typeof saved.handoffQueues !== "object" ||
        Array.isArray(saved.handoffQueues))) {
      throw new Error("接力缓存格式异常，已保留原存档，请导出 DEBUG 后处理");
    }
    if (maintainHandoffQueues(saved)) await saveStore(saved);
    return saved;
  }
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
  maintainHandoffQueues(store);
  await chrome.storage.local.set({ [STORAGE_KEY]: store });
  // Diagnostic persistence is best effort and independent of queue commits.
  // A full debug store must NEVER block sending or roll back a task.
  try { await observeHandoffDebugStore(store); }
  catch (error) { console.warn("[ChatQueue] 接力调试记录未能保存", error); }
}

// Strictly metadata-only tracing: no prompt, summary, images, URL, user text,
// raw error string or handoff token is copied to this separate local store.
function handoffDebugVersion(value) {
  return typeof value === "string" && /^\d{1,4}(?:\.\d{1,4}){2,3}$/.test(value) ? value : "unknown";
}

function handoffDebugBackendVersion() {
  return handoffDebugVersion(chrome.runtime.getManifest().version);
}

function handoffDebugDetails(value) {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length > 96) {
    throw new Error("接力调试详情无效");
  }
  const details = {};
  for (const key of Object.keys(value).sort()) {
    const item = value[key];
    const valid = HANDOFF_DEBUG_DETAIL_BOOLEANS.has(key) ? typeof item === "boolean" :
      HANDOFF_DEBUG_DETAIL_NUMBERS.has(key) ? Number.isFinite(item) && item >= 0 && item <= 1_000_000_000 :
      Object.hasOwn(HANDOFF_DEBUG_DETAIL_ENUMS,key) ? HANDOFF_DEBUG_DETAIL_ENUMS[key].has(item) :
      key === "contentVersion" && handoffDebugVersion(item) !== "unknown";
    if (!valid) throw new Error("接力调试详情包含不支持的字段或值");
    details[key] = item;
  }
  return details;
}

function handoffDebugReason(message) {
  const value = String(message || "");
  for (const [pattern,code] of [
    [/接力缓存|交接缓存|队列 ID/, "cache_mismatch"],
    [/总结为空|没有获取到 AI 的交接总结/, "summary_empty"],
    [/总结过短/, "summary_too_short"],[/总结过长/, "summary_too_long"],
    [/尚未确认本轮回复完整结束|下一条完整助手回复/, "reply_not_confirmed"],
    [/原生输入框|发送按钮不可用|语音按钮/, "composer_not_ready"],
    [/额外用户消息|新的用户消息|交接记录已过期/, "source_changed"],
    [/新对话地址|无法确认已进入|新对话入口/, "chat_not_confirmed"],
    [/项目不匹配|项目归属|同项目|当前项目|项目新对话.*不一致|归属/, "project_mismatch"],
    [/开场|接收交接/, "intro_not_confirmed"],
    [/超时|长时间/, "timeout"],[/发送中断|发送状态|状态不确定/, "send_uncertain"],
    [/队列|不完整/, "queue_conflict"],
  ]) if (pattern.test(value)) return code;
  return value ? "other_failure" : "none";
}

function handoffDebugSnapshot(store, state) {
  const handoff = state.handoff;
  const cache = store.handoffQueues?.[state.key];
  const introState = store.conversations[handoff?.destinationKey];
  const summary = state.tasks.find(task => task.kind === "handoff_summary");
  const intro = introState?.tasks?.find(task => task.kind === "handoff_intro");
  const active = state.tasks.find(task => task.id === state.activeTaskId);
  const destinationActive = introState?.tasks?.find(task => task.id === introState.activeTaskId);
  const elapsed = (startedAt) => Number.isFinite(startedAt)
    ? Math.min(1_000_000_000,Math.max(0,Date.now()-startedAt)) : 0;
  const taskKind = task => !task ? "none" :
    ["handoff_summary","handoff_intro"].includes(task.kind) ? task.kind : "normal";
  const taskStatus = task => HANDOFF_DEBUG_DETAIL_ENUMS.taskStatus.has(task?.status) ? task.status : "none";
  return {
    phase:handoff.phase,
    summaryStatus:taskStatus(summary),
    introStatus:taskStatus(intro),
    destination:handoff.destinationKey
      ? introState?.key?.startsWith("chat:") ? "chat"
        : introState?.key?.startsWith("draft:") ? "draft" : "not_found"
      : "none",
    summaryChars:typeof handoff.summary === "string" ? handoff.summary.length : 0,
    pendingTasks:state.tasks.filter(task => task.status === "pending" &&
      task.kind !== "handoff_summary").length,
    halted:state.halted === true,
    queuePaused:state.queuePaused === true,
    reason:handoff.phase === "failed" ? handoffDebugReason(handoff.error) : "none",
    sourceTaskCount:state.tasks.length,
    destinationTaskCount:introState?.tasks?.length || 0,
    sourceScheduleCount:state.schedules.length,
    sourceEnabledScheduleCount:state.schedules.filter(rule => rule.enabled === true).length,
    destinationScheduleCount:introState?.schedules?.length || 0,
    destinationEnabledScheduleCount:introState?.schedules?.filter(rule => rule.enabled === true).length || 0,
    sourceActiveKind:taskKind(active),sourceActiveStatus:taskStatus(active),
    destinationActiveKind:taskKind(destinationActive),destinationActiveStatus:taskStatus(destinationActive),
    destinationHalted:introState?.halted === true,
    destinationQueuePaused:introState?.queuePaused === true,
    ownerChainMatches:Boolean(introState && introState.tabId === state.tabId),
    cacheFound:Boolean(cache),
    cacheIdentityMatches:Boolean(handoffQueueFor(store,state)),
    cacheDestinationMatches:Boolean(introState && handoffQueueFor(store,state,introState)),
    cachedScheduleCount:Array.isArray(cache?.schedules) ? cache.schedules.length : 0,
    cachedEnabledScheduleCount:Array.isArray(cache?.schedules)
      ? cache.schedules.filter(rule => rule.enabled === true).length : 0,
    cachedTaskCount:Array.isArray(cache?.tasks) ? cache.tasks.length : 0,
    destinationRecorded:Boolean(cache?.observedChatKey),
    destinationConfirmed:Boolean(introState?.key?.startsWith("chat:") && cache?.confirmedChatKey === introState.key),
    phaseElapsedMs:elapsed(handoff.changedAt),
    summaryDispatchElapsedMs:elapsed(summary?.claimedAt),
    summaryWaitElapsedMs:elapsed(summary?.sentAt),
    introDispatchElapsedMs:elapsed(intro?.claimedAt),
    introWaitElapsedMs:elapsed(intro?.sentAt),
    dispatchBudgetMs:dispatchTimeoutBudget(destinationActive || active),
    summaryDispatchBudgetMs:dispatchTimeoutBudget(summary),
    introDispatchBudgetMs:dispatchTimeoutBudget(intro),replyBudgetMs:WAIT_TIMEOUT_MS,
    entryBudgetMs:60*60_000,bootstrapBudgetMs:60*60_000,
  };
}

function handoffDebugStateSignature(snapshot) {
  return JSON.stringify(Object.fromEntries(Object.entries(snapshot)
    .filter(([key]) => !key.endsWith("ElapsedMs"))));
}

async function handoffDebugData() {
  const saved = (await chrome.storage.local.get(HANDOFF_DEBUG_KEY))[HANDOFF_DEBUG_KEY];
  return [1,2].includes(saved?.version) && Array.isArray(saved.runs)
    ? {...saved,version:2,runs:saved.runs.filter(run => run && typeof run === "object" &&
        !Array.isArray(run)).slice(0,HANDOFF_DEBUG_MAX_RUNS)} : {version:2,runs:[]};
}

function handoffDebugRun(data, sourceKey, mode = "automatic", phase = "due") {
  const previous = data.runs.find(run => run.sourceKey === sourceKey);
  // A terminal result is still the SAME handoff when the user subsequently
  // acknowledges/cancels it. A fresh queued command starts a fresh run.
  if (previous && (previous.status === "running" || !["due","queued"].includes(phase))) return previous;
  const run = {
    id:crypto.randomUUID(),sourceKey,startedAt:Date.now(),mode,
    status:"running",phase,signature:"",events:[],
    createdBackendVersion:handoffDebugBackendVersion(),lastBackendVersion:handoffDebugBackendVersion(),
  };
  data.runs.unshift(run);
  data.runs = data.runs.slice(0,HANDOFF_DEBUG_MAX_RUNS);
  return run;
}

function handoffDebugPush(run, event) {
  run.createdBackendVersion ||= "unknown";
  run.lastBackendVersion = handoffDebugBackendVersion();
  run.events.push({at:Date.now(),...event,backendVersion:handoffDebugBackendVersion()});
  while (run.events.length > HANDOFF_DEBUG_MAX_EVENTS) {
    const oldProbe = run.events.findIndex((item,index) => index > 0 &&
      index < run.events.length-1 && HANDOFF_DEBUG_PROBE_SIGNALS.has(item.kind) &&
      !(item.kind === "claim_result" && item.reason === "claim_acquired"));
    // Retain the opening state and important send transitions before dropping
    // old probes. If all events are important, preserve a head and recent tail.
    run.events.splice(oldProbe >= 0 ? oldProbe : Math.min(16,run.events.length-2),1);
  }
}

function handoffDebugSignalDuplicate(run, event) {
  if (HANDOFF_DEBUG_CRITICAL_SIGNALS.has(event.kind) ||
      event.kind === "claim_result" && event.reason === "claim_acquired") return false;
  const signature = JSON.stringify({kind:event.kind,phase:event.phase,reason:event.reason,
    route:event.route || "other",details:event.details || {}});
  return run.events.some(previous => Date.now()-previous.at < 30000 &&
    JSON.stringify({kind:previous.kind,phase:previous.phase,reason:previous.reason,
      route:previous.route || "other",details:previous.details || {}}) === signature);
}

function handoffDebugClaimSnapshot(state, url) {
  if (!state) return {stateFound:false};
  const active = state.tasks.find(task => task.id === state.activeTaskId);
  const pending = state.tasks.find(task => task.status === "pending");
  const kind = task => !task ? "none" : ["handoff_summary","handoff_intro"].includes(task.kind) ? task.kind : "normal";
  const status = task => HANDOFF_DEBUG_DETAIL_ENUMS.taskStatus.has(task?.status) ? task.status : "none";
  const retryWaitMs = Number.isFinite(pending?.retryNotBefore)
    ? Math.min(1_000_000_000,Math.max(0,pending.retryNotBefore-Date.now())) : 0;
  const cooldown = sendCooldownUntil(state);
  return {stateFound:true,route:isProjectOverview(url) ? "project" : chatKey(url) ? "chat" : "other",
    sessionKind:state.key?.startsWith("draft:") ? "draft" : "chat",
    halted:state.halted === true,queuePaused:state.queuePaused === true,
    hasActiveTask:Boolean(state.activeTaskId),hasSteeringTask:Boolean(state.steeringTaskId),
    activeKind:kind(active),activeStatus:status(active),nextKind:kind(pending),nextStatus:status(pending),
    pendingTasks:state.tasks.filter(task => task.status === "pending").length,
    retryWaitMs,cooldownRemainingMs:cooldown ? Math.min(1_000_000_000,Math.max(0,cooldown-Date.now())) : 0};
}

function handoffDebugClaimEvent(store, observation) {
  if (!observation) return null;
  const {state,sender,url,dispatch,blockedReason} = observation;
  const source = handoffDebugSource(store,sender,url);
  if (!source) return null;
  const task = dispatch ? state.tasks.find(item => item.id === dispatch.id) :
    state.tasks.find(item => item.status === "pending");
  const details = {gate:"claim",taskKind:!task ? "none" :
    ["handoff_summary","handoff_intro"].includes(task.kind) ? task.kind : "normal",
    taskStatus:HANDOFF_DEBUG_DETAIL_ENUMS.taskStatus.has(task?.status) ? task.status : "none",
    dispatchBlockedReason:HANDOFF_DEBUG_DETAIL_ENUMS.dispatchBlockedReason.has(blockedReason) ? blockedReason : "none",
    boundHere:targetMatches(state,sender,url),activeMatches:Boolean(dispatch && state.activeTaskId === dispatch.id),
    halted:state.halted === true,queuePaused:state.queuePaused === true};
  return {source,event:{kind:"claim_result",reason:dispatch ? "claim_acquired" : "claim_empty",
    phase:source.handoff.phase,route:isProjectOverview(url) ? "project" : "chat",details}};
}

async function recordHandoffDebugClaim(store, observation) {
  const claim = handoffDebugClaimEvent(store,observation);
  if (!claim) return;
  const data = await handoffDebugData();
  const run = data.runs.find(item => item.sourceKey === claim.source.key) ||
    handoffDebugRun(data,claim.source.key,claim.source.handoff.manualRequested ? "manual" : "automatic",claim.source.handoff.phase);
  if (handoffDebugSignalDuplicate(run,claim.event)) return;
  handoffDebugPush(run,claim.event);
  await chrome.storage.local.set({[HANDOFF_DEBUG_KEY]:data});
}

async function recordHandoffDebugAdoption(store, observation, sender, url, message, adopted) {
  const source = observation?.source;
  if (!source?.handoff) return;
  const data = await handoffDebugData();
  const run = data.runs.find(item => item.sourceKey === source.key) ||
    handoffDebugRun(data,source.key,source.handoff.manualRequested ? "manual" : "automatic",source.handoff.phase);
  const details = {gate:"adoption",targetShell:observation.targetShell === true,adopted,
    targetBlocker:observation.targetBlocker || "none",
    targetSystemHistoryCount:observation.targetSystemHistoryCount || 0,
    targetBusinessHistoryCount:observation.targetBusinessHistoryCount || 0,
    textChars:typeof message.lastUserText === "string" ? message.lastUserText.length : 0,
    expectedChars:observation.active?.text?.length || 0,
    textMatches:CQHandoff.textMatch(observation.active?.text,message.lastUserText).matches,
    usedTolerance:CQHandoff.textMatch(observation.active?.text,message.lastUserText).usedTolerance,
    extraTextChars:CQHandoff.textMatch(observation.active?.text,message.lastUserText).extraChars};
  if (Number.isInteger(message.userCount) && message.userCount >= 0) details.userCount = message.userCount;
  const event = {kind:"adoption_result",reason:observation.reason,
    phase:source.handoff.phase,route:"chat",details};
  if (!handoffDebugSignalDuplicate(run,event)) {
    handoffDebugPush(run,event);
    await chrome.storage.local.set({[HANDOFF_DEBUG_KEY]:data});
  }
}

function handoffDebugAdoptionMetadata(store, sender, url) {
  const project = CQHandoff.projectId(url);
  const candidates = Object.values(store.conversations).filter(state =>
    project && chatKey(state.url) && state.tabId === sender.tab?.id && CQHandoff.projectId(state.url) === project &&
    ["navigating","bootstrapping","failed"].includes(state.handoff?.phase));
  return {candidateCount:candidates.length,candidates:candidates.slice(0,12).map(source => {
    const destination = store.conversations[source.handoff.destinationKey];
    const check = handoffAdoptionCandidate(store,sender,url,source.handoff.destinationKey);
    const cache = store.handoffQueues?.[source.key];
    const intro = destination?.tasks.find(task => task.kind === "handoff_intro");
    return {phase:source.handoff.phase,sourceTaskCount:source.tasks.length,
      sourceScheduleCount:source.schedules.length,
      sourceEnabledScheduleCount:source.schedules.filter(rule => rule.enabled === true).length,
      destination:destination?.key?.startsWith("draft:") ? "draft" : destination ? "chat" : "not_found",
      destinationTaskCount:destination?.tasks.length || 0,
      introStatus:HANDOFF_DEBUG_DETAIL_ENUMS.taskStatus.has(intro?.status) ? intro.status : "none",
      reason:check.reason,targetShell:check.targetShell === true,parked:destination?.parkedDraft === true,
      targetBlocker:check.targetBlocker || "none",
      targetSystemHistoryCount:check.targetSystemHistoryCount || 0,
      targetBusinessHistoryCount:check.targetBusinessHistoryCount || 0,
      cacheFound:Boolean(cache),cacheIdentityMatches:Boolean(handoffQueueFor(store,source)),
      cachedScheduleCount:cache?.schedules?.length || 0,cachedTaskCount:cache?.tasks?.length || 0,
      destinationRecorded:Boolean(cache?.observedChatKey)};
  })};
}

async function observeHandoffDebugStore(store) {
  const sources = Object.entries(store.conversations).filter(([,state]) => {
    if (!chatKey(state.url) || !state.handoff || state.handoffSourceKey) return false;
    if (HANDOFF_DEBUG_PHASES.has(state.handoff.phase)) {
      return !["failed","completed"].includes(state.handoff.phase) ||
        Number.isFinite(state.handoff.changedAt) &&
        Date.now()-state.handoff.changedAt < 5*60_000;
    }
    const last = state.history?.at(-1);
    return state.handoff.phase === "idle" && last?.type === "handoff_cancelled" &&
      Number.isFinite(last.at) && Date.now()-last.at < 5*60_000;
  });
  if (!sources.length) return;
  const data = await handoffDebugData();
  let changed = false;
  for (const [sourceKey,state] of sources) {
    const snapshot = handoffDebugSnapshot(store,state);
    const signature = handoffDebugStateSignature(snapshot);
    const previous = data.runs.find(run => run.sourceKey === sourceKey);
    if (previous?.signature === signature) continue;
    // A source can hand off again after completion or explicit cancellation.
    const run = handoffDebugRun(data,sourceKey,
      state.handoff.manualRequested ? "manual" : "automatic",snapshot.phase);
    run.signature = signature;
    const failureAcknowledged = run.status === "failed" &&
      snapshot.phase === "idle";
    if (!failureAcknowledged) run.phase = snapshot.phase;
    if (state.handoff.destinationKey?.startsWith("chat:")) {
      run.destinationKey = state.handoff.destinationKey;
    }
    const status = snapshot.phase === "failed" ? "failed" :
      snapshot.phase === "completed" ? "completed" :
      snapshot.phase === "idle" ? "cancelled" : "running";
    if (status !== "running") run.endedAt = Date.now();
    if (!failureAcknowledged) run.status = status;
    handoffDebugPush(run,{kind:"state",...snapshot});
    changed = true;
  }
  if (changed) await chrome.storage.local.set({[HANDOFF_DEBUG_KEY]:data});
}

function handoffDebugSource(store, sender, url) {
  if (!Number.isInteger(sender.tab?.id) ||
      sender.frameId != null && sender.frameId !== 0 || !safeUrl(url)) return null;
  const project = CQHandoff.projectId(url);
  if (!project) return null;
  const direct = store.conversations[chatKey(url)];
  if (direct?.handoff && !direct.handoffSourceKey &&
      direct.tabId === sender.tab.id && HANDOFF_DEBUG_PHASES.has(direct.handoff.phase) &&
      direct.handoff.phase !== "completed") return direct;
  return Object.values(store.conversations).filter(state =>
    chatKey(state.url) && state.tabId === sender.tab.id &&
    CQHandoff.projectId(state.url) === project &&
    state.handoff && HANDOFF_DEBUG_PHASES.has(state.handoff.phase) &&
    state.handoff.phase !== "completed")
    .sort((a,b) => (b.handoff.changedAt || 0)-(a.handoff.changedAt || 0))[0] || null;
}

async function appendHandoffDebugSignal(message, sender) {
  if (!HANDOFF_DEBUG_SIGNALS.has(message.event) ||
      !HANDOFF_DEBUG_REASONS.has(message.reason)) {
    throw new Error("接力调试事件无效");
  }
  const requested = safeUrl(message.url);
  const current = safeUrl(sender.tab?.url);
  if (!requested || current && current !== requested ||
      sender.url && new URL(sender.url).origin !== new URL(requested).origin) {
    throw new Error("接力调试来源不匹配");
  }
  const details = handoffDebugDetails(message.details);
  try {
    const store = await readStore();
    const source = handoffDebugSource(store,sender,requested);
    if (!source) return {ok:true,recorded:false};
    const data = await handoffDebugData();
    const run = data.runs.find(item => item.sourceKey === source.key) ||
      handoffDebugRun(data,source.key,source.handoff.manualRequested ? "manual" : "automatic",source.handoff.phase);
    if (source.handoff.phase === "failed") run.status = "failed";
    const event = {kind:message.event,phase:source.handoff.phase,reason:message.reason,
      route:isProjectOverview(requested) ? "project" : chatKey(requested) ? "chat" : "other",
      ...(Object.keys(details).length ? {details} : {})};
    if (handoffDebugSignalDuplicate(run,event)) return {ok:true,recorded:false};
    handoffDebugPush(run,event);
    await chrome.storage.local.set({[HANDOFF_DEBUG_KEY]:data});
    return {ok:true,recorded:true};
  } catch (error) {
    console.warn("[ChatQueue] 接力页面诊断暂时无法记录",error);
    return {ok:true,recorded:false,diagnosticsUnavailable:true};
  }
}

function handoffDebugManagerSender(sender) {
  const dashboard = chrome.runtime.getURL(DASHBOARD_PAGE);
  return typeof chrome.runtime.id === "string" && sender.id === chrome.runtime.id &&
    (sender.frameId == null || sender.frameId === 0) &&
    [dashboard,dashboard+"?view=full"].includes(sender.url) &&
    (!sender.tab?.url || sender.tab.url === sender.url);
}

function handoffDebugVisibleSnapshot(value) {
  const result = {};
  const enums = {
    phase:HANDOFF_DEBUG_DETAIL_ENUMS.handoffPhase,
    summaryStatus:HANDOFF_DEBUG_DETAIL_ENUMS.taskStatus,introStatus:HANDOFF_DEBUG_DETAIL_ENUMS.taskStatus,
    sourceActiveKind:HANDOFF_DEBUG_DETAIL_ENUMS.taskKind,destinationActiveKind:HANDOFF_DEBUG_DETAIL_ENUMS.taskKind,
    sourceActiveStatus:HANDOFF_DEBUG_DETAIL_ENUMS.taskStatus,destinationActiveStatus:HANDOFF_DEBUG_DETAIL_ENUMS.taskStatus,
    destination:new Set(["none","chat","draft","not_found"]),
  };
  const numbers = ["summaryChars","pendingTasks","sourceTaskCount","destinationTaskCount",
    "sourceScheduleCount","sourceEnabledScheduleCount","destinationScheduleCount",
    "destinationEnabledScheduleCount","phaseElapsedMs","summaryDispatchElapsedMs","summaryWaitElapsedMs",
    "introDispatchElapsedMs","introWaitElapsedMs","dispatchBudgetMs","summaryDispatchBudgetMs",
    "introDispatchBudgetMs","replyBudgetMs","entryBudgetMs","bootstrapBudgetMs",
    "cachedScheduleCount","cachedEnabledScheduleCount","cachedTaskCount"];
  for (const [key,allowed] of Object.entries(enums)) if (allowed.has(value?.[key])) result[key] = value[key];
  for (const key of numbers) if (Number.isFinite(value?.[key]) && value[key] >= 0 && value[key] <= 1_000_000_000) result[key] = value[key];
  for (const key of ["halted","queuePaused","destinationHalted","destinationQueuePaused","ownerChainMatches",
      "cacheFound","cacheIdentityMatches","cacheDestinationMatches","destinationRecorded","destinationConfirmed"]) {
    if (typeof value?.[key] === "boolean") result[key] = value[key];
  }
  return result;
}

function handoffDebugVisibleEvent(event) {
  if (!event || !["state","rpc_error",...HANDOFF_DEBUG_SIGNALS].includes(event.kind)) return null;
  const visible = {kind:event.kind,backendVersion:handoffDebugVersion(event.backendVersion),
    ...handoffDebugVisibleSnapshot(event)};
  if (Number.isFinite(event.at) && event.at >= 0) visible.at = event.at;
  const reasons = new Set([...HANDOFF_DEBUG_REASONS,"summary_empty","summary_too_short","summary_too_long",
    "reply_not_confirmed","source_changed","project_mismatch","chat_not_confirmed","intro_not_confirmed",
    "timeout","send_uncertain","queue_conflict","other_failure"]);
  visible.reason = reasons.has(event.reason) ? event.reason : "other_failure";
  if (HANDOFF_DEBUG_ERROR_ACTIONS.has(event.action)) visible.action = event.action;
  if (HANDOFF_DEBUG_DETAIL_ENUMS.route.has(event.route)) visible.route = event.route;
  try {
    const details = handoffDebugDetails(event.details);
    if (Object.keys(details).length) visible.details = details;
  } catch { /* Old/corrupt diagnostic payloads are not exported as raw text. */ }
  return visible;
}

function handoffDebugVisibleRun(run) {
  const visible = {createdBackendVersion:handoffDebugVersion(run.createdBackendVersion),
    lastBackendVersion:handoffDebugVersion(run.lastBackendVersion),
    events:(Array.isArray(run.events) ? run.events : []).slice(-HANDOFF_DEBUG_MAX_EVENTS)
      .map(handoffDebugVisibleEvent).filter(Boolean)};
  if (["automatic","manual"].includes(run.mode)) visible.mode = run.mode;
  if (["running","failed","completed","cancelled"].includes(run.status)) visible.status = run.status;
  if (HANDOFF_DEBUG_DETAIL_ENUMS.handoffPhase.has(run.phase)) visible.phase = run.phase;
  for (const key of ["startedAt","endedAt"]) if (Number.isFinite(run[key]) && run[key] >= 0) visible[key] = run[key];
  return visible;
}

function handoffDebugReportSource(store, sender, url) {
  const key = chatKey(url);
  const direct = key && store.conversations[key];
  if (direct && !direct.handoffSourceKey && HANDOFF_DEBUG_PHASES.has(direct.handoff?.phase)) return direct;
  const destination = direct || store.conversations[`draft:${sender.tab?.id}`];
  const linked = store.conversations[destination?.handoffSourceKey];
  if (linked?.handoff && destination.tabId === sender.tab?.id && linked.tabId === sender.tab.id &&
      linked.handoff.destinationKey === destination.key && linked.handoff.token === destination.handoffToken &&
      CQHandoff.projectId(linked.url) === CQHandoff.projectId(url)) return linked;
  return isProjectOverview(url) ? handoffDebugSource(store,sender,url) : null;
}

async function handoffDebugReport(message, sender) {
  const all = message.all === true;
  const url = safeUrl(message.url);
  const key = chatKey(url);
  if (all ? !handoffDebugManagerSender(sender) :
      (!url || !key && !isProjectOverview(url) || !Number.isInteger(sender.tab?.id) ||
       sender.frameId != null && sender.frameId !== 0 ||
       sender.tab.url && safeUrl(sender.tab.url) !== url ||
       sender.url && new URL(sender.url).origin !== new URL(url).origin)) {
    throw new Error("只能从当前对话、项目页或插件管理页读取接力日志");
  }
  let data = {version:2,runs:[]};
  let store = null;
  let diagnosticsUnavailable = false;
  try { data = await handoffDebugData(); } catch { diagnosticsUnavailable = true; }
  try { store = await readStore(); } catch { diagnosticsUnavailable = true; }
  const source = !all && store ? handoffDebugReportSource(store,sender,url) : null;
  const currentState = !all && store ? (store.conversations[key] || store.conversations[`draft:${sender.tab.id}`]) : null;
  const current = {pageType:all ? "manager" : isProjectOverview(url) ? "project" : "chat",
    sessionKind:currentState?.key?.startsWith("draft:") ? "draft" : key ? "chat" : "none",
    stateFound:Boolean(currentState),sourceFound:Boolean(source),ownerPageType:"unavailable"};
  if (!all) current.claimDiagnostic = handoffDebugClaimSnapshot(currentState,url);
  if (!all && store && key) current.adoption = handoffDebugAdoptionMetadata(store,sender,url);
  if (all && store) current.conversationCount = Object.keys(store.conversations).length;
  if (source?.handoff) {
    Object.assign(current,handoffDebugVisibleSnapshot(handoffDebugSnapshot(store,source)));
    current.reason = source.handoff.phase === "failed" ? handoffDebugReason(source.handoff.error) : "none";
    try {
      const owner = await chrome.tabs.get(source.tabId);
      current.ownerPageType = isProjectOverview(owner.url) ? "project" : chatKey(owner.url) ? "chat" : "other";
    } catch { /* Closed owner: keep only its unavailable page category. */ }
  }
  const ownerPageTypes = new Map();
  if (store && all) {
    try {
      for (const tab of await chrome.tabs.query({url:["https://chatgpt.com/*","https://chat.openai.com/*"]})) {
        ownerPageTypes.set(tab.id,isProjectOverview(tab.url) ? "project" : chatKey(tab.url) ? "chat" : "other");
      }
    } catch { /* Export stored state even when current tab metadata is unavailable. */ }
  }
  const relatedSources = new Set(!all && store && CQHandoff.projectId(url)
    ? Object.values(store.conversations).filter(item => item.tabId === sender.tab?.id &&
      CQHandoff.projectId(item.url) === CQHandoff.projectId(url) && item.handoff?.destinationKey &&
      ["navigating","bootstrapping","failed"].includes(item.handoff.phase)).map(item => item.key) : []);
  const selected = data.runs.filter(run => all ||
    key && (run.sourceKey === key || run.destinationKey === key) || source && run.sourceKey === source.key ||
    relatedSources.has(run.sourceKey))
    .slice(0,HANDOFF_DEBUG_MAX_RUNS);
  const runs = selected.map(run => {
    const visible = handoffDebugVisibleRun(run);
    const liveSource = store?.conversations[run.sourceKey];
    const destination = store?.conversations[liveSource?.handoff?.destinationKey];
    const liveState = destination || liveSource;
    visible.current = {stateFound:Boolean(liveSource),
      isLatestForSource:data.runs.find(item => item.sourceKey === run.sourceKey) === run,
      ownerPageType:all ? ownerPageTypes.get(liveSource?.tabId) || "unavailable" : current.ownerPageType,
      claimDiagnostic:handoffDebugClaimSnapshot(liveState,liveState?.url)};
    if (liveSource?.handoff) {
      Object.assign(visible.current,handoffDebugVisibleSnapshot(handoffDebugSnapshot(store,liveSource)));
      visible.current.reason = liveSource.handoff.phase === "failed" ? handoffDebugReason(liveSource.handoff.error) : "none";
    }
    return visible;
  });
  return {ok:true,version:2,backendVersion:handoffDebugBackendVersion(),capturedAt:Date.now(),current,runs,
    ...(diagnosticsUnavailable ? {diagnosticsUnavailable:true} : {})};
}

const HANDOFF_DEBUG_ERROR_ACTIONS = new Set([
  "HANDOFF_NOW","HANDOFF_NAVIGATE","CLAIM","SENT","FINISHED",
  "HELLO","CANCEL_HANDOFF","RELEASE_CLAIM","HANDOFF_SEND_READY","CONFIRM_HANDOFF","RETRY_UNSENT_HANDOFF",
]);

async function recordHandoffDebugRpcError(message,sender,error) {
  if (!HANDOFF_DEBUG_ERROR_ACTIONS.has(message?.type)) return;
  const url = safeUrl(message.url);
  const store = await readStore();
  const source = handoffDebugSource(store,sender,url);
  if (!source) return;
  const data = await handoffDebugData();
  const run = data.runs.find(item=>item.sourceKey === source.key);
  if (!run) return;
  const reason = handoffDebugReason(error?.message);
  if (run.events.some(event => event.kind === "rpc_error" && event.action === message.type &&
      event.reason === reason && Date.now()-event.at < 30000)) return;
  handoffDebugPush(run,{
    kind:"rpc_error",action:message.type,phase:source.handoff.phase,reason,
  });
  if (message.type === "CLAIM") {
    const event = {kind:"claim_result",reason:"claim_rejected",phase:source.handoff.phase,
      route:isProjectOverview(url) ? "project" : "chat",details:{gate:"claim"}};
    if (!handoffDebugSignalDuplicate(run,event)) handoffDebugPush(run,event);
  }
  await chrome.storage.local.set({[HANDOFF_DEBUG_KEY]:data});
}

function isDashboardSender(sender) {
  // The toolbar popup and the exact, opt-in full-page dashboard URL are
  // privileged. Checking the browser-provided sender.url (rather than a
  // message argument) keeps ordinary ChatGPT content scripts isolated.
  const popup = chrome.runtime.getURL(DASHBOARD_PAGE);
  const fullscreen = popup + "?view=full";
  if (sender.url === popup) return !sender.tab;
  return sender.url === fullscreen &&
    Number.isInteger(sender.tab?.id) &&
    // Chrome can omit Tab.url without the optional broad "tabs" permission.
    // The unforgeable MessageSender.url still has to be the exact full page.
    (sender.tab.url == null || sender.tab.url === fullscreen);
}

function isFavoritesPageSender(sender) {
  const page = chrome.runtime.getURL(FAVORITES_PAGE);
  return sender.url === page && Number.isInteger(sender.tab?.id) &&
    (sender.frameId == null || sender.frameId === 0) &&
    (sender.tab.url == null || sender.tab.url === page);
}

async function favoriteSenderKind(message, sender) {
  if (isDashboardSender(sender) || isFavoritesPageSender(sender)) return "manager";
  const documentUrl = sender.url ? safeUrl(sender.url) : null;
  const tabUrl = safeUrl(sender.tab?.url);
  const requestedUrl = safeUrl(message.url);
  if (!Number.isInteger(sender.tab?.id) || (sender.frameId != null && sender.frameId !== 0) ||
      !requestedUrl || (!documentUrl && !tabUrl) ||
      (sender.url && !documentUrl) ||
      (documentUrl && new URL(documentUrl).origin !== new URL(requestedUrl).origin)) {
    throw new Error("只能从 ChatGPT 对话或插件管理页操作收藏夹");
  }
  // sender.url identifies the document where the content script was injected.
  // ChatGPT changes routes via the History API without reloading that document.
  // Verify the *current* browser tab instead of requiring the original path.
  if (tabUrl !== requestedUrl) {
    let liveTabUrl = null;
    try { liveTabUrl = safeUrl((await chrome.tabs.get(sender.tab.id)).url); }
    catch { /* Older browsers may omit tab URL access. */ }
    if (liveTabUrl !== requestedUrl &&
        (tabUrl || liveTabUrl || documentUrl !== requestedUrl)) {
      throw new Error("只能从 ChatGPT 对话或插件管理页操作收藏夹");
    }
  }
  return "chat";
}

function favoritesOf(store) {
  return Array.isArray(store.favorites) ? store.favorites : [];
}

function favoriteTitle(value, text, images = []) {
  const title = value == null ?
    (text.replace(/\s+/g, " ").trim().slice(0, 46) || `图片任务 · ${images.length} 张`) : value;
  if (typeof title !== "string" || !title.trim() || title.trim().length > MAX_FAVORITE_TITLE_LENGTH) {
    throw new Error("收藏名称需要在 1～80 字符之间");
  }
  return title.trim();
}

function favoriteCategory(value) {
  if (typeof value !== "string") throw new Error("收藏分类必须是文字");
  const category = value.trim().replace(/\s+/g, " ");
  if (category.length > MAX_FAVORITE_CATEGORY_LENGTH) {
    throw new Error("收藏分类最多 24 个字符");
  }
  return category;
}

function duplicateFavorite(favorites, candidate, excludedId = null) {
  const ids = JSON.stringify((candidate.images || []).map((image) => image.id));
  return favorites.find((item) => item.id !== excludedId && item.text === candidate.text &&
    (item.templateEnabled === true) === (candidate.templateEnabled === true) &&
    JSON.stringify((item.images || []).map((image) => image.id)) === ids);
}

function requireFavoriteTemplateMode(value, text) {
  if (typeof value !== "boolean") throw new Error("收藏模板模式参数无效");
  if (value && !favoriteTemplateFields(text).length) {
    throw new Error("启用变量模板时，请先在正文中填写至少一个 {{变量名}}");
  }
  return value;
}

function favoriteTemplateFields(text) {
  const fields = [];
  for (const match of String(text).matchAll(FAVORITE_TEMPLATE_PATTERN)) {
    if (match[0].startsWith("\\")) continue;
    const name = match[1].trim();
    if (!FAVORITE_TEMPLATE_FIELD_NAME.test(name)) {
      throw new Error("收藏模板变量名只能使用中英文、数字、空格、下划线或短横线，最多 32 字");
    }
    if (!fields.includes(name)) fields.push(name);
    if (fields.length > MAX_FAVORITE_TEMPLATE_FIELDS) {
      throw new Error("每条收藏最多使用 12 个不同的模板变量");
    }
  }
  return fields;
}

function resolveFavoriteTemplate(text, input) {
  const fields = favoriteTemplateFields(text);
  if (input !== undefined && (!input || typeof input !== "object" ||
      Array.isArray(input))) {
    throw new Error("收藏模板变量必须是名称与值的对应表");
  }
  const values = input || {};
  const keys = Object.keys(values);
  if (keys.length !== fields.length ||
      keys.some((name) => !fields.includes(name))) {
    throw new Error("收藏模板变量缺失或与当前收藏不一致，请重新填写");
  }
  for (const name of fields) {
    if (!Object.hasOwn(values,name) || typeof values[name] !== "string" ||
        !values[name].trim() || values[name].length > MAX_FAVORITE_TEMPLATE_FIELD_VALUE) {
      throw new Error("模板变量「" + name + "」必须填写 1～3000 字符的内容");
    }
  }
  // The function replacement never recursively evaluates user input or
  // interprets special replacement tokens such as $& and $'. An escaped
  // placeholder becomes a literal {{field}} in the queued task.
  return String(text).replace(FAVORITE_TEMPLATE_PATTERN,(match,name) =>
    match.startsWith("\\") ? match.slice(1) : values[name.trim()]);
}

function favoriteBackupItem(item) {
  return {
    title:item.title, text:item.text, category:item.category || "",
    pinned:item.pinned === true,templateEnabled:item.templateEnabled === true,
    useCount:Number.isInteger(item.useCount) ? Math.max(0,Math.min(1_000_000,item.useCount)) : 0,
    lastUsedAt:Number.isFinite(item.lastUsedAt) ? item.lastUsedAt : null,
    createdAt:Number.isFinite(item.createdAt) ? item.createdAt : Date.now(),
    updatedAt:Number.isFinite(item.updatedAt) ? item.updatedAt : Date.now(),
    images:(item.images || []).map((image) => ({id:image.id})),
  };
}

function createFavoritesBackupMetadata(store) {
  const favorites = favoritesOf(store);
  if (favorites.length > MAX_FAVORITES) throw new Error("收藏数量超过安全备份上限");
  const refs = new Map();
  for (const favorite of favorites) {
    if (!Array.isArray(favorite.images) || favorite.images.length > MAX_IMAGES) {
      throw new Error("收藏中存在无效的图片列表，拒绝导出不完整备份");
    }
    for (const image of favorite.images) {
      if (typeof image?.id !== "string" || !image.id ||
          typeof image.name !== "string" || typeof image.type !== "string" ||
          !Number.isInteger(image.size) || image.size < 1 || image.size > MAX_IMAGE_BYTES) {
        throw new Error("收藏中有无效的图片引用，无法安全导出");
      }
      const old = refs.get(image.id);
      if (old && (old.name !== image.name || old.type !== image.type ||
          old.size !== image.size)) throw new Error("收藏中的同一原图信息不一致");
      refs.set(image.id,{id:image.id,name:image.name,type:image.type,size:image.size});
    }
  }
  if (refs.size > MAX_FAVORITES * MAX_IMAGES) throw new Error("收藏原图数量超出安全上限");
  const metadata = {
    format:FAVORITES_BACKUP_FORMAT,version:FAVORITES_BACKUP_VERSION,
    exportedAt:new Date().toISOString(),
    favorites:favorites.map(favoriteBackupItem),images:[...refs.values()],
  };
  const bytes = JSON.stringify(metadata).length;
  if (bytes > MAX_FAVORITES_BACKUP_BYTES) throw new Error("收藏备份清单超过 60 MB");
  // Quick size preflight; final serialized file length is also checked by the
  // export UI. No "text only" fallback is allowed for broken image backups.
  const estimate = [...refs.values()].reduce((sum, ref) =>
    sum + Math.ceil(ref.size * 4 / 3) + 46_000,bytes);
  if (estimate > MAX_FAVORITES_BACKUP_BYTES) {
    throw new Error("收藏图文备份预计超过 60 MB，请先精简图片；不会导出缺图文件");
  }
  return metadata;
}

function validateFavoritesBackupManifest(backup) {
  if (!backup || backup.format !== FAVORITES_BACKUP_FORMAT ||
      backup.version !== FAVORITES_BACKUP_VERSION ||
      !Array.isArray(backup.favorites) || backup.favorites.length > MAX_FAVORITES ||
      !Array.isArray(backup.images) || backup.images.length > MAX_FAVORITES * MAX_IMAGES ||
      JSON.stringify(backup).length > MAX_FAVORITES_BACKUP_BYTES) {
    throw new Error("收藏夹备份格式或体积无效（最多 100 条、60 MB）");
  }
  const expected = new Map();
  for (const ref of backup.images) {
    if (typeof ref?.id !== "string" || !/^[a-zA-Z0-9-]{1,128}$/.test(ref.id) ||
        expected.has(ref.id) || typeof ref.name !== "string" ||
        !ref.name || ref.name.length > 150 ||
        !["image/png","image/jpeg","image/webp","image/gif"].includes(ref.type) ||
        !Number.isInteger(ref.size) || ref.size < 1 || ref.size > MAX_IMAGE_BYTES ||
        !IMAGE_SHA256_PATTERN.test(ref.sha256 || "") ||
        Object.hasOwn(ref,"dataUrl")) {
      throw new Error("收藏备份包含重复、无效或未经校验的原图清单");
    }
    expected.set(ref.id,{
      name:ref.name,type:ref.type,size:ref.size,sha256:ref.sha256,
    });
  }
  const used = new Set();
  const items = backup.favorites.map((favorite) => {
    if (!favorite || !Array.isArray(favorite.images) ||
        favorite.images.length > MAX_IMAGES) throw new Error("收藏备份条目或图像数量无效");
    const ids = favorite.images.map((ref) => ref?.id);
    if (ids.some((imageId) => typeof imageId !== "string" || !expected.has(imageId)) ||
        new Set(ids).size !== ids.length) {
      throw new Error("收藏引用了不存在或重复的图片");
    }
    ids.forEach((imageId) => used.add(imageId));
    const text = requirePrompt(favorite.text,ids.length > 0);
    const title = favoriteTitle(favorite.title,text,ids);
    const category = favoriteCategory(favorite.category ?? "");
    if (typeof favorite.pinned !== "boolean") throw new Error("收藏置顶信息无效");
    const templateEnabled = requireFavoriteTemplateMode(favorite.templateEnabled ?? false,text);
    const useCount = favorite.useCount ?? 0;
    if (!Number.isInteger(useCount) || useCount < 0 || useCount > 1_000_000) {
      throw new Error("收藏复用次数无效");
    }
    const safeTime = (value) => Number.isFinite(value) &&
      value > 0 && value < 8_640_000_000_000_000 ? value : null;
    return {
      title,text,category,pinned:favorite.pinned,templateEnabled,useCount,
      createdAt:safeTime(favorite.createdAt) ?? Date.now(),
      updatedAt:safeTime(favorite.updatedAt) ?? Date.now(),
      lastUsedAt:safeTime(favorite.lastUsedAt),ids,
    };
  });
  if (used.size !== expected.size) throw new Error("备份包含未被收藏引用的原图");
  return {expected,items};
}

function favoriteRestoreStage(token, sender) {
  const stage = typeof token === "string" ? pendingFavoriteRestores.get(token) : null;
  if (!stage || stage.tabId !== sender.tab?.id ||
      Date.now() - stage.createdAt > BACKUP_STAGE_TIMEOUT_MS) {
    throw new Error("收藏导入会话已失效，请重新选择备份文件");
  }
  return stage;
}

async function abortFavoriteRestore(token, store) {
  const stage = pendingFavoriteRestores.get(token);
  if (!stage) return;
  pendingFavoriteRestores.delete(token);
  // Reload durable state before pruning. A previous save might have
  // succeeded even if the storage API reported an error afterward.
  try { await cleanupUnusedImages(await readStore()); }
  catch (error) {
    console.warn("[ChatQueue] 无法确认备份图像是否仍被引用，已保留原图",error);
  }
}

async function mergeFavoritesBackup(store, stage) {
  const favorites = favoritesOf(store);
  const shaCache = new Map();
  const signature = (text, hashes, templateEnabled) =>
    JSON.stringify([text,hashes,templateEnabled === true]);
  const seen = new Set();
  const sourceTexts = new Set(stage.items.map((item) => item.text));
  // Existing bookmarks can point to the same original data through unrelated
  // local image IDs. Match by verified bytes, not the old exported UUID.
  for (const old of favorites) {
    if (!sourceTexts.has(old.text)) continue;
    const hashes = [];
    let valid = true;
    for (const ref of old.images || []) {
      try {
        if (!shaCache.has(ref.id)) {
          const [record] = await cqImageStore.load([ref.id]);
          verifyStoredImage(ref,record);
          shaCache.set(ref.id,await imageSha256(record.dataUrl));
        }
        hashes.push(shaCache.get(ref.id));
      } catch {
        // An existing broken image reference should not block a valid backup
        // from restoring an intact copy of the same prompt.
        valid = false;
        break;
      }
    }
    if (valid) seen.add(signature(old.text,hashes,old.templateEnabled));
  }
  const additions = [];
  let skipped = 0;
  for (const item of stage.items) {
    const hashes = item.ids.map((imageId) => stage.expected.get(imageId).sha256);
    const identity = signature(item.text,hashes,item.templateEnabled);
    if (seen.has(identity)) {
      skipped++;
      continue;
    }
    seen.add(identity);
    const images = item.ids.map((imageId) => {
      const record = stage.received.get(imageId);
      return {id:record.id,name:record.name,type:record.type,
        size:record.size,thumbnail:record.thumbnail};
    });
    additions.push({
      id:id(),title:item.title,text:item.text,category:item.category,
      pinned:item.pinned,templateEnabled:item.templateEnabled,
      useCount:item.useCount,lastUsedAt:item.lastUsedAt,
      createdAt:item.createdAt,updatedAt:item.updatedAt,images,
    });
    if (favorites.length + additions.length > MAX_FAVORITES) {
      throw new Error("合并后收藏数量超过 100 条；现有收藏未被覆盖");
    }
  }
  if (additions.length) {
    // Never mutate the current durable snapshot before the write succeeds.
    // Even a test storage adapter (or a partially failing browser API) may
    // expose the object by reference. A rejected write must leave the old
    // favorites untouched, while an "actually saved then threw" error is
    // recovered by re-reading state during abort.
    const nextFavorites = [...favorites,...additions];
    await saveStore({...store,favorites:nextFavorites});
    store.favorites = nextFavorites;
  }
  return {imported:additions.length,skipped};
}

async function handleFavoriteMessage(message, sender) {
  const kind = await favoriteSenderKind(message, sender);
  const store = await readStore();
  const favorites = favoritesOf(store);
  if (["GET_FAVORITES_BACKUP_META","GET_FAVORITES_BACKUP_IMAGE",
       "RESTORE_FAVORITES_BEGIN","RESTORE_FAVORITES_IMAGE",
       "RESTORE_FAVORITES_FINISH","RESTORE_FAVORITES_ABORT"].includes(message.type)) {
    // Full-resolution exports and imports are accessible only from the exact
    // extension-owned library page, not arbitrary ChatGPT content scripts.
    if (kind !== "manager" || !isFavoritesPageSender(sender)) {
      throw new Error("请从插件自己的收藏管理页面备份或导入收藏");
    }
    if (message.type === "GET_FAVORITES_BACKUP_META") {
      const backup = createFavoritesBackupMetadata(store);
      const missing = await cqImageStore.missing(backup.images.map((image) => image.id));
      if (missing.length) throw new Error("有 " + missing.length + " 张收藏原图已缺失，未导出残缺备份");
      return {ok:true,backup};
    }
    if (message.type === "GET_FAVORITES_BACKUP_IMAGE") {
      const ref = favorites.flatMap((favorite) => favorite.images || [])
        .find((image) => image.id === message.imageId);
      if (!ref) throw new Error("指定图片不属于当前收藏夹");
      const [image] = await cqImageStore.load([ref.id]);
      verifyStoredImage(ref,image);
      return {ok:true,image:{...image,sha256:await imageSha256(image.dataUrl)}};
    }
    if (message.type === "RESTORE_FAVORITES_BEGIN") {
      const parsed = validateFavoritesBackupManifest(message.backup);
      for (const [token,stage] of pendingFavoriteRestores) {
        if (stage.tabId === sender.tab.id) await abortFavoriteRestore(token,store);
      }
      const token = id();
      pendingFavoriteRestores.set(token,{
        tabId:sender.tab.id,createdAt:Date.now(),
        ...parsed,received:new Map(),
        encodedBytes:JSON.stringify(message.backup).length,
      });
      return {ok:true,token,images:parsed.expected.size,favorites:parsed.items.length};
    }
    if (message.type === "RESTORE_FAVORITES_ABORT") {
      const stage = pendingFavoriteRestores.get(message.token);
      if (stage && stage.tabId !== sender.tab.id) {
        throw new Error("不能取消其他标签的收藏导入");
      }
      await abortFavoriteRestore(message.token,store);
      return {ok:true};
    }
    const stage = favoriteRestoreStage(message.token,sender);
    if (message.type === "RESTORE_FAVORITES_IMAGE") {
      const input = message.image;
      const expected = typeof input?.id === "string" ? stage.expected.get(input.id) : null;
      if (!expected || stage.received.has(input.id)) {
        throw new Error("收藏导入的原图未列入清单或重复上传");
      }
      const addedBytes = JSON.stringify(input).length;
      if (stage.encodedBytes + addedBytes > MAX_FAVORITES_BACKUP_BYTES) {
        throw new Error("收藏备份总数据超过 60 MB，已中止本次图片上传");
      }
      const record = validateImage(input);
      if (record.name !== expected.name || record.type !== expected.type ||
          record.size !== expected.size ||
          await imageSha256(record.dataUrl) !== expected.sha256) {
        throw new Error("原图与收藏备份清单不匹配，或 SHA-256 完整性检查失败");
      }
      await cqImageStore.save([record]);
      stage.received.set(input.id,record);
      stage.encodedBytes += addedBytes;
      return {ok:true,received:stage.received.size,total:stage.expected.size};
    }
    if (message.type === "RESTORE_FAVORITES_FINISH") {
      if (stage.received.size !== stage.expected.size) {
        throw new Error("收藏备份仍有原图未导入，不能写入任何收藏");
      }
      const missing = await cqImageStore.missing([...stage.received.values()]
        .map((image) => image.id));
      if (missing.length) throw new Error("收藏暂存图片不完整，不能提交");
      const result = await mergeFavoritesBackup(store,stage);
      pendingFavoriteRestores.delete(message.token);
      // Remove imported images that were used exclusively by duplicate
      // bookmarks. Existing queue/favorite images remain protected.
      await cleanupUnusedImages(store);
      return {ok:true,...result,favorites:favoritesOf(store)};
    }
  }
  let changed = false;
  let removed = false;
  let alreadySaved = false;
  if (message.type === "ADD_FAVORITE") {
    let text;
    let images = [];
    if (message.taskId != null) {
      if (kind !== "chat") throw new Error("只能从原对话收藏队列任务");
      const url = safeUrl(message.url);
      const key = resolveKey(url, sender.tab.id);
      const session = store.conversations[key];
      if (!targetMatches(session, sender, url)) throw new Error("只能收藏当前对话的队列任务");
      const task = session.tasks.find((item) => item.id === message.taskId);
      if (!task) throw new Error("队列任务已不存在，无法收藏");
      text = requirePrompt(task.text, Boolean(task.images?.length));
      images = (task.images || []).map((image) => ({...image}));
      if (images.length) {
        const missing = await cqImageStore.missing(images.map((image) => image.id));
        if (missing.length) throw new Error("原始图片已缺失，未创建不完整的收藏");
      }
    } else {
      text = requirePrompt(message.text, false);
    }
    const category = message.category == null ? "" : favoriteCategory(message.category);
    const templateEnabled = requireFavoriteTemplateMode(message.templateEnabled ?? false,text);
    const existing = duplicateFavorite(favorites, {text,images,templateEnabled});
    if (existing) {
      alreadySaved = true;
    } else {
      if (favorites.length >= MAX_FAVORITES) throw new Error("收藏夹最多保存 100 条，可先删除不再使用的收藏");
      favorites.unshift({
        id:id(), title:favoriteTitle(message.title, text, images), text, images,category,
        pinned:false, templateEnabled, useCount:0, lastUsedAt:null,
        createdAt:Date.now(), updatedAt:Date.now(),
      });
      changed = true;
    }
  } else if (message.type === "UPDATE_FAVORITE") {
    const item = favorites.find((favorite) => favorite.id === message.id);
    if (!item) throw new Error("收藏已不存在");
    // Validate the entire patch BEFORE mutating the saved object. Images and
    // runtime statistics are never accepted from extension-page input.
    const editable = ["title","text","category","pinned","templateEnabled"];
    if (Object.keys(message).some((field) =>
      !["type","url","id",...editable].includes(field))) {
      throw new Error("不能通过编辑收藏修改图片或运行统计");
    }
    if (!editable.some((field) => Object.hasOwn(message,field))) {
      throw new Error("没有需要保存的收藏修改");
    }
    const text = Object.hasOwn(message,"text")
      ? requirePrompt(message.text, Boolean(item.images?.length)) : item.text;
    const title = Object.hasOwn(message,"title")
      ? favoriteTitle(message.title,text,item.images) : item.title;
    const category = Object.hasOwn(message,"category")
      ? favoriteCategory(message.category) : (item.category || "");
    const pinned = Object.hasOwn(message,"pinned") ? message.pinned : item.pinned === true;
    if (typeof pinned !== "boolean") throw new Error("收藏置顶参数无效");
    const templateEnabled = requireFavoriteTemplateMode(
      Object.hasOwn(message,"templateEnabled") ? message.templateEnabled : item.templateEnabled === true,
      text);
    if (duplicateFavorite(favorites,{text,images:item.images,templateEnabled},item.id)) {
      throw new Error("已经收藏过相同的提示词及图片，不能保存重复内容");
    }
    if (item.text !== text || item.title !== title ||
        (item.category || "") !== category || (item.pinned === true) !== pinned ||
        (item.templateEnabled === true) !== templateEnabled) {
      Object.assign(item,{text,title,category,pinned,templateEnabled,updatedAt:Date.now()});
      changed = true;
    }
  } else if (message.type === "RENAME_FAVORITE") {
    const item = favorites.find((favorite) => favorite.id === message.id);
    if (!item) throw new Error("收藏已不存在");
    const title = favoriteTitle(message.title, item.text, item.images);
    if (title !== item.title) {
      item.title = title;
      item.updatedAt = Date.now();
      changed = true;
    }
  } else if (message.type === "DELETE_FAVORITE") {
    const index = favorites.findIndex((favorite) => favorite.id === message.id);
    if (index < 0) throw new Error("收藏已不存在");
    favorites.splice(index, 1);
    changed = removed = true;
  }
  if (changed) {
    store.favorites = favorites;
    await saveStore(store);
    if (removed) await cleanupUnusedImages(store);
  }
  return {ok:true, favorites, alreadySaved};
}

function handlePagePulse(message, sender) {
  const tabId = sender.tab?.id;
  if (!Number.isInteger(tabId) || tabId < 0 ||
      (sender.frameId != null && sender.frameId !== 0) ||
      typeof message.generating !== "boolean") {
    throw new Error("页面状态报告无效");
  }
  // Trust Chrome's MessageSender, never a URL/key supplied by the page.
  const key = resolveKey(sender.url, tabId);
  if (!key || (sender.tab.url &&
      resolveKey(sender.tab.url, tabId) !== key)) {
    throw new Error("页面状态来源与当前标签不一致");
  }
  if (pagePulses.size >= PAGE_PULSE_LIMIT && !pagePulses.has(tabId)) {
    pagePulses.delete(pagePulses.keys().next().value);
  }
  pagePulses.set(tabId, {key, at:Date.now(), generating:message.generating});
  return {ok:true};
}

function dashboardCounts(state) {
  const statuses = { pending: 0, active: 0, review: 0 };
  for (const task of state.tasks || []) {
    if (task.status === "pending") statuses.pending++;
    else if (["dispatching", "waiting", "steering", "steering_wait"].includes(task.status)) {
      statuses.active++;
    } else if (["error", "interrupted"].includes(task.status)) statuses.review++;
  }
  return statuses;
}

async function queryDashboardTabs() {
  try {
    return {
      tabs:await chrome.tabs.query({
        url:["https://chatgpt.com/*","https://chat.openai.com/*"],
      }),
      failed:false,
    };
  } catch {
    return {tabs:[],failed:true};
  }
}

function tabBelongsToSession(tab, key) {
  // Check both sides of an in-progress navigation. A live tab must not be
  // mistaken for an offline conversation while its pending URL is changing.
  return resolveKey(tab.url, tab.id) === key ||
    resolveKey(tab.pendingUrl, tab.id) === key;
}

function hasConversationWork(state) {
  return Boolean(state.tasks.length || state.schedules.length ||
    state.activeTaskId || state.steeringTaskId || state.halted ||
    state.queuePaused || state.handoff?.enabled === true || handoffBusy(state) ||
    String(state.error || "").trim());
}

function canPruneIdleSession(key, state, tabs) {
  return state.unreadCompleted !== true && !hasConversationWork(state) &&
    !tabs.some((tab) => tabBelongsToSession(tab, key)) &&
    ![...pendingBackupRestores.values()].some((stage) => stage.key === key);
}

async function forgetDashboardFavorites(keys) {
  const data = await chrome.storage.local.get(DASHBOARD_VIEW_KEY);
  const saved = data[DASHBOARD_VIEW_KEY];
  if (!saved || !Array.isArray(saved.favorites)) return;
  const filtered = saved.favorites.filter((key) => !keys.has(key));
  if (filtered.length === saved.favorites.length) return;
  await chrome.storage.local.set({
    [DASHBOARD_VIEW_KEY]:{...saved,favorites:filtered},
  });
}

async function forgetDashboardAliases(keys) {
  const data = await chrome.storage.local.get(DASHBOARD_ALIASES_KEY);
  const saved = data[DASHBOARD_ALIASES_KEY];
  if (!saved || typeof saved !== "object" || Array.isArray(saved)) return;
  const next = Object.fromEntries(Object.entries(saved)
    .filter(([key]) => !keys.has(key)));
  if (Object.keys(next).length === Object.keys(saved).length) return;
  await chrome.storage.local.set({[DASHBOARD_ALIASES_KEY]:next});
}

async function forgetDashboardProjects(keys) {
  const data = await chrome.storage.local.get(DASHBOARD_PROJECTS_KEY);
  const saved = data[DASHBOARD_PROJECTS_KEY];
  if (!saved || typeof saved !== "object" || Array.isArray(saved)) return;
  const next = Object.fromEntries(Object.entries(saved)
    .filter(([key])=>!keys.has(key)));
  if (Object.keys(next).length === Object.keys(saved).length) return;
  await chrome.storage.local.set({[DASHBOARD_PROJECTS_KEY]:next});
}

async function finalizeConversationRemoval(store, keys) {
  // Persistence comes first: never delete an image before the queue record
  // that references it has been successfully removed.
  await saveStore(store);
  for (const [tabId, pulse] of pagePulses) {
    if (keys.has(pulse.key)) pagePulses.delete(tabId);
  }
  await cleanupUnusedImages(store);
  await maintainTabProtection(store);
  try { await forgetDashboardFavorites(keys); }
  catch (error) {
    console.warn("[ChatQueue] 记录已移除，但重点标记同步失败", error);
  }
  try { await forgetDashboardAliases(keys); }
  catch (error) {
    console.warn("[ChatQueue] 记录已移除，但本地备注清理失败", error);
  }
  try { await forgetDashboardProjects(keys); }
  catch (error) {
    console.warn("[ChatQueue] 记录已移除，但项目标签清理失败", error);
  }
}

async function dashboardSnapshot() {
  const store = await readStore();
  const {tabs,failed:tabLookupError} = await queryDashboardTabs();
  let cleanupEligible = 0;
  const sessions = [];
  for (const [key, state] of Object.entries(store.conversations)) {
    if (state.parkedDraft) continue;
    // The project landing page is not a conversation. During an automatic
    // handoff its internal introduction is temporarily stored under a draft
    // key, but should never appear as a separate user queue. Keep failed
    // introductions visible for manual review rather than hiding errors.
    if (key.startsWith("draft:") && state.handoffSourceKey && !state.halted &&
        state.tasks.length === 1 && state.tasks[0].kind === "handoff_intro") continue;
    const counts = dashboardCounts(state);
    const related = tabs.filter((tab) => tabBelongsToSession(tab, key));
    if (!tabLookupError && canPruneIdleSession(key, state, tabs)) cleanupEligible++;
    const owner = related.find((tab) => tab.id === state.tabId) || related[0];
    const savedUrl = safeUrl(state.url);
    const verifiedUrl = key.startsWith("chat:")
      ? (chatKey(savedUrl) === key ? savedUrl : null)
      : (owner ? safeUrl(owner.url || owner.pendingUrl) : null);
    const url = verifiedUrl ||
      (owner && key.startsWith("chat:") &&
        chatKey(owner.url || owner.pendingUrl) === key
        ? safeUrl(owner.url || owner.pendingUrl) : null);
    const schedules = state.schedules || [];
    // Empty, closed historical conversations are not actionable. Keep all
    // sessions with unfinished work, paused state, or an actual browser tab.
    if (!related.length && !counts.pending && !counts.active && !counts.review &&
        !schedules.length && !state.queuePaused && !state.halted &&
        state.handoff?.enabled !== true && !handoffBusy(state) &&
        state.unreadCompleted !== true) continue;
    const active = state.tasks.find((task) =>
      task.id === state.activeTaskId || task.id === state.steeringTaskId);
    const lastEvent = Array.isArray(state.history) ? state.history.at(-1) : null;
    const validTime = (value) => Number.isFinite(value) &&
      value > 0 && value <= Date.now() + 5 * 60_000 ? value : null;
    const pulse = owner ? pagePulses.get(owner.id) : null;
    const pulseAt = pulse?.key === key ? validTime(pulse.at) : null;
    const pageSignal = tabLookupError || !owner || owner.discarded ||
      owner.status === "loading" ? "unavailable" :
      pulseAt === null ? "unknown" :
      Date.now() - pulseAt > PAGE_PULSE_FRESH_MS ? "stale" :
      pulse.generating ? "generating" : "idle";
    const recentEvents = (Array.isArray(state.history) ? state.history : [])
      .filter((entry) => entry && DASHBOARD_EVENT_TYPES.has(entry.type) &&
        validTime(entry.at) !== null)
      .slice(-5).reverse()
      .map((entry) => ({type:entry.type,at:entry.at}));
    const activeSince = active?.status === "waiting" ? active.sentAt :
      active?.status === "dispatching" ? active.claimedAt :
      active?.status === "steering_wait" ? active.steerClickedAt :
      active?.status === "steering" ? active.steerClaimedAt : null;
    sessions.push({
      key,
      title: (typeof owner?.title === "string" && owner.title.trim()
        ? owner.title.trim().slice(0, 100) : null),
      url,
      tabId: owner?.id || null,
      browser: tabLookupError ? "unknown" :
        !owner ? "closed" : owner.discarded ? "discarded" :
        owner.status === "loading" ? "loading" : "loaded",
      pending: counts.pending,
      active: counts.active,
      review: counts.review,
      requiresDiscard:hasConversationWork(state),
      enabledRules: schedules.filter((item) => item.enabled).length,
      allRules: schedules.length,
      queuePaused: state.queuePaused === true,
      halted: state.halted === true,
      haltReason: typeof state.haltReason === "string" ? state.haltReason : null,
      activeStatus: active?.status || null,
      activeSince: validTime(activeSince),
      pageSignal,
      pageSignalAt: pageSignal === "unavailable" ? null : pulseAt,
      lastEventAt: validTime(lastEvent?.at),
      recentEvents,
    });
  }
  return {version:chrome.runtime.getManifest().version, sessions, cleanupEligible,
    unreadableTabs:tabLookupError};
}

async function handleDashboardMessage(message, sender) {
  if (!isDashboardSender(sender)) {
    throw new Error("只有扩展工具栏管理页可以执行跨对话管理操作");
  }
  if (message.type === "DASHBOARD_GET") {
    return {ok:true, dashboard:await dashboardSnapshot()};
  }
  if (message.type === "DASHBOARD_REMOVE_CONVERSATION" ||
      message.type === "DASHBOARD_CLEANUP_IDLE") {
    if (message.confirm !== true) throw new Error("请在管理页确认移除记录");
    const {tabs,failed} = await queryDashboardTabs();
    if (failed) throw new Error("无法确认哪些对话仍然打开，已取消删除以保护队列");
    const store = await readStore();
    const removedKeys = new Set();
    if (message.type === "DASHBOARD_REMOVE_CONVERSATION") {
      if (typeof message.key !== "string" || !DASHBOARD_KEY_PATTERN.test(message.key)) {
        throw new Error("无效的对话标识");
      }
      const state = Object.hasOwn(store.conversations,message.key)
        ? store.conversations[message.key] : null;
      if (!state) throw new Error("对话记录已经不存在，请刷新管理页");
      const hasWork = hasConversationWork(state);
      if (hasWork && tabs.some((tab) => tabBelongsToSession(tab,message.key))) {
        throw new Error("此对话仍在浏览器中打开且有任务、规则或异常记录，请先关闭该标签页再移除");
      }
      if ([...pendingBackupRestores.values()].some((stage) => stage.key === message.key)) {
        throw new Error("此对话有尚未完成的备份恢复，请先完成或放弃恢复");
      }
      if (hasWork && (message.discardWork !== true ||
          message.confirmKey !== message.key)) {
        throw new Error("此对话包含任务或自动规则，必须再次明确确认永久丢弃");
      }
      delete store.conversations[message.key];
      removedKeys.add(message.key);
    } else {
      for (const [key,state] of Object.entries(store.conversations)) {
        if (!canPruneIdleSession(key,state,tabs)) continue;
        delete store.conversations[key];
        removedKeys.add(key);
      }
    }
    if (removedKeys.size) await finalizeConversationRemoval(store,removedKeys);
    return {ok:true,removedCount:removedKeys.size,
      dashboard:await dashboardSnapshot()};
  }
  if (message.type !== "DASHBOARD_SET_PAUSED") {
    throw new Error("未知的管理页操作");
  }
  if (typeof message.key !== "string" ||
      !DASHBOARD_KEY_PATTERN.test(message.key) ||
      typeof message.paused !== "boolean") {
    throw new Error("对话或暂停参数无效");
  }
  const store = await readStore();
  const state = Object.hasOwn(store.conversations, message.key)
    ? store.conversations[message.key] : null;
  if (!state) throw new Error("对话记录已经不存在，请刷新管理页");
  if (!message.paused && state.halted) {
    throw new Error("此对话需要先人工核对，管理页不能解除安全暂停");
  }
  if (state.queuePaused !== message.paused) {
    state.queuePaused = message.paused;
    recordHistory(state, message.paused ? "queue_paused" : "queue_resumed");
    checkpointHandoffQueue(store,state,false);
    await saveStore(store);
  }
  return {ok:true, dashboard:await dashboardSnapshot()};
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

function loadRecoveryEligibleTab(tab) {
  return Number.isInteger(tab?.id) && tab.status === "complete" &&
    !tab.discarded && Boolean(chatKey(tab.url));
}

async function installLoadRecoveryGuardian(tabId) {
  if (loadRecoveryInstallations.has(tabId)) return loadRecoveryInstallations.get(tabId);
  const work = (async () => {
    // Re-read immediately before injection: a queued onUpdated or alarm may
    // refer to a tab that has already left this conversation or been unloaded.
    const tab = await chrome.tabs.get(tabId);
    if (!loadRecoveryEligibleTab(tab)) return false;
    await chrome.scripting.executeScript({
      target:{tabId}, files:["load-recovery.js"],
    });
    // The guardian itself is idempotent and owns native-error observations,
    // draft checks and cross-reload backoff. Installation never changes tasks.
    return true;
  })().catch((error) => {
    console.warn("[ChatQueue] 对话错误页恢复守护暂时无法补注入", tabId, error);
    return false;
  }).finally(() => { loadRecoveryInstallations.delete(tabId); });
  loadRecoveryInstallations.set(tabId, work);
  return work;
}

async function installLoadRecoveryGuardians(tabId = null) {
  if (Number.isInteger(tabId)) return installLoadRecoveryGuardian(tabId);
  let tabs;
  try {
    tabs = await chrome.tabs.query({url:["https://chatgpt.com/*","https://chat.openai.com/*"]});
  } catch (error) {
    console.warn("[ChatQueue] 暂时无法查找待补注入恢复守护的对话页", error);
    return [];
  }
  // Do not enter the serialized queue lock or wait on one tab before starting
  // the rest. A closed, inaccessible or failing page must not block its peers.
  return Promise.all(tabs.filter(loadRecoveryEligibleTab)
    .map((tab) => installLoadRecoveryGuardian(tab.id)));
}

// This standalone DOM probe runs in already-open ChatGPT tabs *after* the
// extension updates. Previous content scripts may have been invalidated, so
// runtime.sendMessage cannot be relied on to inspect those pages.
function inspectUpdateRefreshSafety() {
  const editorSelector = '#prompt-textarea, [data-testid="prompt-textarea"], ' +
    '[data-testid="composer-input"], [data-composer-markdown][role="textbox"]';
  const foreignSurface = '#cq-extension-root, [role="dialog"], [aria-modal="true"], aside, [role="menu"], ' +
    '[data-testid^="conversation-turn-"], [data-message-author-role], ' +
    '[data-turn="assistant"], [data-turn="user"], [data-conversation-role], ' +
    '[data-testid="user-message"], [data-testid="message-content"], ' +
    '[data-testid*="writing-block"], [data-testid*="artifact"], .markdown';
  const rendered = (element) => {
    if (!element?.isConnected || !element.getClientRects().length ||
        element.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
    const style = getComputedStyle(element);
    if (style.visibility !== "visible" || style.contentVisibility === "hidden" ||
        Number(style.opacity) <= 0.01) return false;
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      const parentStyle = getComputedStyle(parent);
      if (parentStyle.visibility !== "visible" ||
          parentStyle.contentVisibility === "hidden" ||
          Number(parentStyle.opacity) <= 0.01) return false;
    }
    return true;
  };
  const visible = (element) => rendered(element) && !element.disabled &&
    (!element.matches('button, [role="button"]') ||
      getComputedStyle(element).pointerEvents !== "none");
  const usableInput = (candidate) => Boolean(candidate && candidate.isConnected &&
    !candidate.closest(foreignSurface) && visible(candidate) &&
    candidate.matches('textarea, input, [contenteditable="true"]') &&
    candidate.closest('form, [data-testid="composer"], [data-chatgpt-composer]'));
  let input = null;
  for (const editor of document.querySelectorAll(editorSelector)) {
    const candidate = editor.matches('textarea, input, [contenteditable="true"]') ? editor :
      editor.querySelector('[contenteditable="true"], textarea, input');
    if (usableInput(candidate)) {
      input = candidate;
      break;
    }
  }
  // Unknown editors are safe to inspect only inside a marked native composer.
  // A writing block elsewhere in main must never stand in for the prompt.
  if (!input) input = [...document.querySelectorAll(
    '[data-testid="composer"] [contenteditable="true"], [data-testid="composer"] textarea, ' +
    '[data-chatgpt-composer] [contenteditable="true"], [data-chatgpt-composer] textarea'
  )].find(usableInput) || null;
  if (!input || document.readyState === "loading") {
    return { safe: false, voiceReady: false, reason: "composer_not_ready" };
  }
  const form = input.closest("form");
  const text = input.matches("textarea, input") ? input.value : input.innerText;
  if (String(text || "").trim()) {
    return { safe: false, voiceReady: false, reason: "unsent_text" };
  }
  const plugin = document.querySelector("#cq-extension-root");
  if (plugin?.getAttribute("data-cq-unsaved-draft") === "true" ||
      document.documentElement?.getAttribute("data-cq-unsaved-draft") === "true") {
    // A closed editor can still contain a draft in content-script memory,
    // even when the panel was detached while ChatGPT replaced its composer.
    return { safe: false, voiceReady: false, reason: "plugin_hidden_unsaved_draft" };
  }
  if (plugin && [
    "#cq-queue-draft", "#cq-schedule-draft", "#cq-edit-task-input",
  ].some((selector) => {
    const control = plugin.querySelector(selector);
    return control && String(control.value || "").trim();
  })) {
    return { safe: false, voiceReady: false, reason: "plugin_draft" };
  }
  if (plugin && plugin.querySelector('[data-image-zone] .cq-images img')) {
    // A pure-image task can have no text in any draft field.
    return { safe: false, voiceReady: false, reason: "plugin_draft_image" };
  }
  if (plugin && [...plugin.querySelectorAll("input, textarea, select")].some((control) => {
    if (control.type === "checkbox" || control.type === "radio") {
      return control.checked !== control.defaultChecked;
    }
    if (control.type === "file") return Boolean(control.files?.length);
    if (control.tagName === "SELECT") {
      const initiallySelected = [...control.options].find((option) => option.defaultSelected) ||
        control.options[0];
      return control.value !== (initiallySelected?.value || "");
    }
    return control.value !== control.defaultValue;
  })) {
    return { safe: false, voiceReady: false, reason: "plugin_unsaved_changes" };
  }
  const attachmentSelector = [
    '[data-testid="file-chip"]', '[data-testid="attachment-preview"]',
    '[data-testid="composer-attachment-preview"]',
    '[data-testid="image-file-thumbnail"]', '[data-testid="file-upload-preview"]',
    'img[src^="blob:"], img[src^="data:image/"]',
  ].join(",");
  if (form && (
    [...form.querySelectorAll(attachmentSelector)].some(visible) ||
    [...form.querySelectorAll('input[type="file"]')].some((item) => item.files?.length) ||
    form.querySelector('[data-testid*="upload-progress"], [aria-busy="true"]')
  )) {
    return { safe: false, voiceReady: false, reason: "attachments_or_upload" };
  }
  const composerFrame = input.closest('form, [data-testid="composer"], [data-chatgpt-composer]');
  const buttons = [...document.querySelectorAll("main button, form button")]
    .filter((button) => rendered(button) && !button.closest(foreignSurface));
  const stop = buttons.some((button) => {
    const testId = button.getAttribute("data-testid") || "";
    const label = button.getAttribute("aria-label") || button.getAttribute("title") || "";
    const byId = /(?:^|-)stop-button$|composer-stop-button/i.test(testId);
    const byLabel = /^(?:stop(?:\s+(?:generating|generation|response|responding|streaming))?|停止(?:生成|回复|回答|响应)?|结束生成)$/i.test(label.trim());
    const buttonFrame = button.closest('form, [data-testid="composer"], [data-chatgpt-composer]');
    const insideComposer = composerFrame?.contains(button) || buttonFrame?.contains(composerFrame);
    const floatingStop = !buttonFrame && button.closest("main") &&
      (byId || (byLabel && /(?:生成|回复|回答|响应|generation|generating|responding|streaming)/i.test(label)));
    if (!insideComposer && !floatingStop) return false;
    return Boolean(byId || byLabel || (insideComposer &&
      [...button.querySelectorAll("svg.icon-primary-action > path")]
      .some((path) => (path.getAttribute("d") || "").startsWith("M4.5 5.75C4.5 5.05964"))));
  });
  if (stop || [...document.querySelectorAll(
    'main [data-testid="generation-in-progress"], main [data-is-streaming="true"], main [data-state="streaming"]'
  )].some(visible)) {
    return { safe: false, voiceReady: false, reason: "generating" };
  }
  const voiceReady = buttons.some((button) => {
    if (!visible(button)) return false;
    const buttonFrame = button.closest('form, [data-testid="composer"], [data-chatgpt-composer]');
    if (!composerFrame?.contains(button) && !form?.contains(button) &&
        !(composerFrame?.parentElement?.contains(button) && !buttonFrame)) return false;
    const testId = (button.getAttribute("data-testid") || "").toLowerCase();
    const label = (button.getAttribute("aria-label") ||
      button.getAttribute("title") || "").trim();
    if (/dictat|transcrib|microphone|听写|录音|麦克风|语音输入/i.test(testId + " " + label)) {
      return false;
    }
    return /^(?:composer-)?(?:start-)?voice(?:-mode|-chat)?-button$|^voice-mode-button$/i.test(testId) ||
      /^(?:(?:start|use|open|begin|enter)\s+(?:a\s+)?)?voice(?:\s+(?:mode|chat|conversation))?$/i.test(label) ||
      /^(?:(?:开始|开启|进入|使用)\s*)?语音(?:模式|聊天|对话|通话)?$/i.test(label);
  });
  return { safe: true, voiceReady, reason: "idle" };
}

// Busy/unsaved tabs cannot be refreshed during an extension update. Give
// those old documents a temporary passive tab spinner without disturbing
// their existing composer, drafts, or queue state. It disappears on reload.
function installDeferredTabSpinner(version) {
  // An already-running content script (including an older version) owns its
  // tab indicators. Installing a SECOND title spinner makes both scripts
  // prefix each other's last frame, growing an unbounded chain in Edge tabs.
  const stripIndicators = (value) => String(value || "ChatGPT")
    .replace(/^(?:(?:[◴◷◶◵]|🔴|✅)\s+)+/u, "");
  const activePlugin = () => Boolean(document.getElementById("cq-extension-root"));
  const previous = window.__cqDeferredTabSpinner;
  if (activePlugin()) {
    if (typeof previous?.stop === "function") previous.stop();
    else if (previous?.timer != null) {
      // Compatibility with the earlier injected helper, which exposed its
      // timer but no stop callback. Its old content script still owns updates.
      clearInterval(previous.timer);
      previous.timer = null;
    }
    const current = document.title || "";
    const badges = current.match(/^(?:(?:[◴◷◶◵]|🔴|✅)\s+)+/u)?.[0] || "";
    if ((badges.match(/[◴◷◶◵]/g) || []).length > 1) {
      // Remove a stack already accumulated by the old version. The content
      // script's next redraw restores the one appropriate status indicator.
      document.title = stripIndicators(current);
    }
    return;
  }
  if (previous) return; // Never create two passive update spinners.
  const state = { version, frame: 0, running: false, timer: null };
  window.__cqDeferredTabSpinner = state;
  const frames = ["◴", "◷", "◶", "◵"];
  const rendered = (element) => {
    if (!element?.isConnected || !element.getClientRects().length ||
        element.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
    const style = getComputedStyle(element);
    if (style.visibility !== "visible" || style.contentVisibility === "hidden" ||
        Number(style.opacity) <= 0.01) return false;
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      const parentStyle = getComputedStyle(parent);
      if (parentStyle.visibility !== "visible" ||
          parentStyle.contentVisibility === "hidden" ||
          Number(parentStyle.opacity) <= 0.01) return false;
    }
    return true;
  };
  const visible = (element) => rendered(element) && !element.disabled &&
    (!element.matches('button, [role="button"]') ||
      getComputedStyle(element).pointerEvents !== "none");
  const busy = () => {
    const editor = [...document.querySelectorAll(
      '#prompt-textarea, [data-testid="prompt-textarea"], ' +
      '[data-testid="composer-input"], [data-composer-markdown][role="textbox"]'
    )].find((candidate) => visible(candidate) &&
      candidate.matches('textarea, input, [contenteditable="true"]') &&
      candidate.closest('form, [data-testid="composer"], [data-chatgpt-composer]') &&
      !candidate.closest('#cq-extension-root, [role="dialog"], [aria-modal="true"], ' +
        '[role="menu"], aside, [data-message-author-role], ' +
        '[data-testid^="conversation-turn-"], [data-testid*="writing-block"], .markdown'));
    const composer = editor?.closest('form, [data-testid="composer"], [data-chatgpt-composer]') ||
      [...document.querySelectorAll('[data-testid="composer"], [data-chatgpt-composer]')]
        .find(visible);
    const buttons = [...document.querySelectorAll("main button, button[data-testid='stop-button']")];
    return buttons.some((button) => {
      if (!composer || !rendered(button) || button.closest(
        '#cq-extension-root, [role="dialog"], [aria-modal="true"], [role="menu"], ' +
        'aside, [data-message-author-role], [data-testid^="conversation-turn-"], ' +
        '[data-testid*="writing-block"], .markdown')) return false;
      const testId = button.getAttribute("data-testid") || "";
      const label = button.getAttribute("aria-label") || button.getAttribute("title") || "";
      const byId = /(?:^|-)stop-button$|composer-stop-button/i.test(testId);
      const byLabel = /^(?:stop(?:\s+(?:generating|generation|response|responding|streaming))?|停止(?:生成|回复|回答|响应)?|结束生成)$/i.test(label.trim());
      const buttonFrame = button.closest('form, [data-testid="composer"], [data-chatgpt-composer]');
      const insideComposer = composer.contains(button) || buttonFrame?.contains(composer);
      const floatingStop = !buttonFrame && button.closest("main") &&
        (byId || (byLabel && /(?:生成|回复|回答|响应|generation|generating|responding|streaming)/i.test(label)));
      if (!insideComposer && !floatingStop) return false;
      return Boolean(byId || byLabel || (insideComposer &&
        [...button.querySelectorAll("svg.icon-primary-action > path")]
          .some((path) => (path.getAttribute("d") || "").startsWith("M4.5 5.75C4.5 5.05964"))));
    }) || [...document.querySelectorAll(
      'main [data-testid="generation-in-progress"], main [data-is-streaming="true"], main [data-state="streaming"]'
    )].some(visible);
  };
  const draw = () => {
    const current = document.title || "ChatGPT";
    const title = stripIndicators(current);
    const prefix = state.running ? frames[state.frame] + " " : "";
    if (current !== prefix + title) document.title = prefix + title;
  };
  let controlObserver = null;
  state.stop = () => {
    if (state.timer !== null) clearInterval(state.timer);
    state.timer = null;
    state.running = false;
    draw();
    controlObserver?.disconnect();
    if (window.__cqDeferredTabSpinner === state) {
      delete window.__cqDeferredTabSpinner;
    }
  };
  const scan = () => {
    if (activePlugin()) {
      state.stop();
      return;
    }
    const next = busy();
    if (next === state.running) return;
    state.running = next;
    if (state.timer !== null) clearInterval(state.timer);
    state.timer = next ? setInterval(() => {
      state.frame = (state.frame + 1) % frames.length;
      draw();
    }, 400) : null;
    draw();
  };
  controlObserver = new MutationObserver((records) => {
    if (records.some((record) => {
      const target = record.target;
      if (!(target instanceof Element) ||
          target.closest("#cq-extension-root")) return false;
      if (record.type === "attributes") {
        return target.closest("button, form") !== null ||
          target.matches("[data-is-streaming], [data-state='streaming']");
      }
      if (target.closest("button, form")) return true;
      return [...record.addedNodes, ...record.removedNodes].some((node) =>
        node instanceof Element &&
        (node.matches("button, form, #cq-extension-root") ||
          node.querySelector("button, form, #cq-extension-root")));
    })) scan();
  });
  controlObserver.observe(document.documentElement, {
    childList: true, subtree: true, attributes: true,
    attributeFilter: ["data-testid", "aria-label", "title", "class", "style", "d"],
  });
  scan();
}

async function inspectUpdateTab(tabId, state) {
  const injected = await chrome.scripting.executeScript({
    target: { tabId },
    func: inspectUpdateRefreshSafety,
  });
  const first = injected?.[0]?.result;
  if (!first?.safe) return false;
  const inFlight = state && (state.activeTaskId || state.steeringTaskId ||
    state.tasks.some((task) =>
      ["dispatching", "waiting", "steering", "steering_wait"].includes(task.status)));
  if (inFlight && !first.voiceReady) return false;
  // Protect against a short idle-looking gap between generations. Require a
  // second safe observation before reloading and discarding the old document.
  await new Promise((resolve) => setTimeout(resolve, UPDATE_REFRESH_STABLE_MS));
  const again = await chrome.scripting.executeScript({
    target: { tabId },
    func: inspectUpdateRefreshSafety,
  });
  const second = again?.[0]?.result;
  return Boolean(second?.safe && (!inFlight || second.voiceReady));
}

async function processPendingVersionRefresh() {
  if (updateRefreshInProgress) return updateRefreshInProgress;
  updateRefreshInProgress = (async () => {
    const saved = await chrome.storage.session.get(UPDATE_REFRESH_KEY);
    const plan = saved[UPDATE_REFRESH_KEY];
    if (!plan || plan.version !== chrome.runtime.getManifest().version ||
        !Array.isArray(plan.tabs) || !plan.tabs.length) return;
    // The queue remains the source of truth; do not reload an active producer
    // unless the native ChatGPT UI has genuinely returned to a safe idle state.
    let store;
    try { store = await readStore(); }
    catch (error) {
      console.warn("[ChatQueue] 版本更新刷新延迟：无法读取原队列", error);
      return;
    }
    // Inspect tabs concurrently. Doing 1.8-second stability checks serially
    // across dozens of chats could exceed an MV3 worker's available lifetime.
    const checks = await Promise.all(plan.tabs.map(async (entry) => {
      let tab;
      try { tab = await chrome.tabs.get(entry.id); }
      catch { return {entry,action:"skip"}; } // The page was closed.
      if (!safeUrl(tab.url) && !safeUrl(tab.pendingUrl)) {
        return {entry,action:"skip"}; // No longer a ChatGPT tab.
      }
      if (tab.discarded) {
        // When the browser reactivates a discarded page, it loads fresh
        // scripts automatically; don't wake it just to update the extension.
        return {entry,action:"skip"};
      }
      if (tab.status === "loading") return {entry,action:"keep"};
      const busy = Object.values(store.conversations).find((session) =>
        session.tabId === tab.id);
      let safe = false;
      try { safe = await inspectUpdateTab(tab.id, busy); }
      catch (error) {
        console.warn("[ChatQueue] 无法确认页面可安全刷新，稍后重试", error);
      }
      if (!safe) {
        try {
          await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: installDeferredTabSpinner,
            args: [chrome.runtime.getManifest().version],
          });
        } catch (error) {
          console.warn("[ChatQueue] 无法为待安全刷新标签注入临时状态标记", error);
        }
      }
      return {entry,action:safe ? "reload" : "keep"};
    }));
    const keep = checks.filter((item) => item.action === "keep").map((item) => item.entry);
    const eligible = checks.filter((item) => item.action === "reload").map((item) => item.entry);
    // Mark eligible tabs as handled *before* reloading; if the worker restarts
    // as the pages navigate, it must not initiate the same refresh a second time.
    await chrome.storage.session.set({
      [UPDATE_REFRESH_KEY]: keep.length ? {version:plan.version,tabs:keep} : null,
    });
    const failed = await Promise.all(eligible.map(async (entry) => {
      try {
        await chrome.tabs.reload(entry.id);
        return null;
      } catch (error) {
        console.warn("[ChatQueue] 版本更新自动刷新失败，将重试", error);
        return entry;
      }
    }));
    const retry = failed.filter(Boolean);
    if (retry.length) {
      await chrome.storage.session.set({
        [UPDATE_REFRESH_KEY]: {version:plan.version,tabs:[...keep,...retry]},
      });
    }
  })().finally(() => { updateRefreshInProgress = null; });
  return updateRefreshInProgress;
}

async function scheduleVersionRefresh(details) {
  if (details?.reason !== "update" ||
      !details.previousVersion ||
      details.previousVersion === chrome.runtime.getManifest().version) return;
  const tabs = await chrome.tabs.query({
    url: ["https://chatgpt.com/*", "https://chat.openai.com/*"],
  });
  const targets = tabs.filter((tab) => safeUrl(tab.url)).map((tab) => ({id:tab.id}));
  await chrome.storage.session.set({
    [UPDATE_REFRESH_KEY]: targets.length ?
      {version:chrome.runtime.getManifest().version,tabs:targets} : null,
  });
  if (targets.length) {
    // Startup can race the update event and be inspecting the old (empty)
    // marker. Wait for that pass, then definitely process the new plan.
    if (updateRefreshInProgress) await updateRefreshInProgress;
    await processPendingVersionRefresh();
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

// ChatGPT's first-message timestamp is not always exposed to a content
// script. Persist when this extension first sees each established chat as a
// clearly labelled lower bound, rather than inventing a creation date.
function plausibleConversationTime(value, now = Date.now()) {
  return Number.isInteger(value) && value >= Date.UTC(2022,0,1) &&
    value <= now + 60_000;
}

function recordConversationFirstSeen(state, now = Date.now()) {
  if (plausibleConversationTime(state.firstSeenAt, now)) return false;
  // Older plugin versions did not have firstSeenAt. Their local history can
  // establish an earlier observation, but is NOT the ChatGPT creation time.
  const recorded = (state.history || [])
    .map((entry) => entry.at).filter((time) => plausibleConversationTime(time, now));
  state.firstSeenAt = recorded.length ? Math.min(now,...recorded) : now;
  return true;
}

function pendingCount(state) {
  return state.tasks.filter((task) =>
    ["pending", "dispatching", "waiting", "steering", "steering_wait"].includes(task.status)).length;
}

function requireSendCooldownSeconds(value) {
  if (!["string", "number"].includes(typeof value) ||
      String(value).trim() === "" ||
      !Number.isInteger(Number(value)) || Number(value) < 0 ||
      Number(value) > MAX_SEND_COOLDOWN_SECONDS) {
    throw new Error("发送冷却时间必须是 0～3600 秒的整数（0 表示关闭）");
  }
  return Number(value);
}

function sendCooldownUntil(state, now = Date.now()) {
  // Old sessions have no cooldown fields: keep their old dispatch behavior.
  const seconds = state.sendCooldownSeconds;
  const settled = state.lastQueueSettledAt;
  if (!Number.isInteger(seconds) || seconds <= 0 ||
      seconds > MAX_SEND_COOLDOWN_SECONDS || !Number.isFinite(settled) ||
      settled <= 0 || settled > now + 60_000) return null;
  const until = settled + seconds * 1000;
  return until > now ? until : null;
}

function hasBackgroundWork(state) {
  if (state.parkedDraft) return false;
  return pendingCount(state) > 0 || state.schedules.some((schedule) => schedule.enabled) ||
    state.handoff?.enabled === true || handoffBusy(state);
}

function backgroundProtectionEnabled(store) {
  // Old v2 stores had no setting; make the safe default opt-out.
  return store.settings?.protectBackground !== false;
}

function tabOwnsConversationWork(store, state, tab) {
  if (!tab || tab.id !== state.tabId) return false;
  const url = safeUrl(tab.url);
  if (!url) return false;
  if (resolveKey(url, tab.id) === state.key) {
    return !state.key.startsWith("draft:") || sameDraftScope(state.url, url);
  }
  // Keep protection across the native project entry, before its first HELLO
  // creates the destination draft. This does not transfer dispatch ownership.
  const handoff = state.handoff;
  if (handoff?.phase === "navigating" && chatKey(state.url) === state.key &&
      CQHandoff.projectId(state.url) === CQHandoff.normalizeProjectId(handoff.projectId) &&
      CQHandoff.projectId(handoff.projectUrl) === CQHandoff.normalizeProjectId(handoff.projectId) &&
      CQHandoff.isProjectStart(url, handoff.projectId)) return true;
  const destination = store.conversations[handoff?.destinationKey];
  if (handoff?.phase === "bootstrapping" && destination &&
      destination.tabId === tab.id && destination.handoffSourceKey === state.key &&
      destination.handoffToken === handoff.token &&
      (CQHandoff.isProjectStart(url, handoff.projectId) ||
       chatKey(url) === destination.key && CQHandoff.projectId(url) ===
         CQHandoff.normalizeProjectId(handoff.projectId))) return true;
  // The first native Send can publish /c/<id> before its user bubble mounts.
  // Only the already owned draft/token chain may bridge that hydration gap.
  const pending = pendingHandoffDraftForChat(store, {tab}, url);
  return pending?.state === state;
}

async function reviveProtectedDiscardedTab(store, state) {
  if (!backgroundProtectionEnabled(store) || !hasBackgroundWork(state) ||
      !Number.isInteger(state.tabId)) return false;
  let tab;
  try { tab = await chrome.tabs.get(state.tabId); }
  catch { return false; } // Reopening closed tabs remains a separate opt-in.
  if (!tab.discarded || !tabOwnsConversationWork(store, state, tab)) return false;
  const lastAttempt = recentTabRevives.get(tab.id);
  if (lastAttempt != null && Date.now() - lastAttempt < TAB_REVIVE_BACKOFF_MS) return false;
  recentTabRevives.set(tab.id, Date.now());
  // A discarded page has already lost its document. Reload that same owner,
  // retaining every durable send status; never replay an uncertain message.
  await chrome.tabs.reload(tab.id);
  recordHistory(state, "tab_revived");
  return true;
}

async function syncTabProtection(store) {
  // Never activate tabs or interfere with normal dispatch. The browser's
  // autoDiscardable flag prevents memory discard, not tab freezing/sleeping.
  const saved = await chrome.storage.session.get(PROTECTED_TABS_KEY);
  const protectedTabs = { ...(saved[PROTECTED_TABS_KEY] || {}) };
  const desired = new Map();

  for (const state of Object.values(store.conversations)) {
    if (!hasBackgroundWork(state) || !Number.isInteger(state.tabId)) continue;
    let tab;
    try { tab = await chrome.tabs.get(state.tabId); }
    catch { continue; }
    if (!tabOwnsConversationWork(store, state, tab)) continue;
    desired.set(String(tab.id), tab);
  }

  if (backgroundProtectionEnabled(store)) {
    for (const [id, tab] of desired) {
      if (tab.autoDiscardable === false || tab.discarded) continue;
      try {
        await chrome.tabs.update(tab.id, { autoDiscardable: false });
        // Remember only flags changed by us, to avoid undoing user settings.
        if (!(id in protectedTabs)) protectedTabs[id] = true;
      } catch (error) {
        console.warn("[ChatQueue] 无法保护后台标签", tab.id, error);
      }
    }
  }

  for (const id of Object.keys(protectedTabs)) {
    if (backgroundProtectionEnabled(store) && desired.has(id)) continue;
    try {
      const tab = await chrome.tabs.get(Number(id));
      if (tab.autoDiscardable === false) {
        await chrome.tabs.update(tab.id, { autoDiscardable: true });
      }
      delete protectedTabs[id];
    } catch {
      // Closed tabs need no restoration. Retry failed updates on next pulse.
      try { await chrome.tabs.get(Number(id)); }
      catch { delete protectedTabs[id]; }
    }
  }

  await chrome.storage.session.set({ [PROTECTED_TABS_KEY]: protectedTabs });
  return [...desired.values()].filter((tab) => !tab.discarded).map((tab) => tab.id);
}

async function maintainTabProtection(store) {
  try { return await syncTabProtection(store); }
  catch (error) {
    console.warn("[ChatQueue] 后台标签保护检查失败", error);
    return [];
  }
}

function reorderPendingTasks(state, sourceId, targetId = null, position = "before") {
  // Reorder only pending slots; in-flight and review rows keep their positions.
  const slots = state.tasks.map((task, index) => task.status === "pending" ? index : -1)
    .filter((index) => index !== -1);
  const pending = slots.map((index) => state.tasks[index]);
  const from = pending.findIndex((task) => task.id === sourceId);
  if (from < 0) throw new Error("只能调整待发送的队列任务");
  if (targetId !== null && !["before", "after"].includes(position)) {
    throw new Error("无效的拖动目标位置");
  }
  if (targetId !== null && !pending.some((task) => task.id === targetId)) {
    throw new Error("只能拖放到待发送的队列任务上");
  }
  if (sourceId === targetId) return false;
  const moved = pending.splice(from, 1)[0];
  let destination = 0; // Pin always means the first pending slot.
  if (targetId !== null) {
    const target = pending.findIndex((task) => task.id === targetId);
    if (target < 0) throw new Error("只能拖放到待发送的队列任务上");
    destination = target + (position === "after" ? 1 : 0);
  }
  pending.splice(destination, 0, moved);
  if (slots.every((index, offset) => state.tasks[index].id === pending[offset].id)) return false;
  slots.forEach((index, offset) => { state.tasks[index] = pending[offset]; });
  return true;
}

function queueLimit(store) {
  const limit = store.settings?.maxPending;
  return Number.isInteger(limit) && limit >= 1 && limit <= MAX_PENDING
    ? limit : DEFAULT_PENDING_LIMIT;
}

function requireQueueLimit(value) {
  const limit = Number(value);
  if (value === "" || !Number.isInteger(limit) || limit < 1 || limit > MAX_PENDING) {
    throw new Error(`队列上限必须为 1～${MAX_PENDING} 的整数`);
  }
  return limit;
}

function queueListHeight(store) {
  const value = store.settings?.queueListHeight;
  return Number.isInteger(value) && value >= MIN_QUEUE_LIST_HEIGHT &&
    value <= MAX_QUEUE_LIST_HEIGHT ? value : null;
}

function requireQueueListHeight(value) {
  if (value === null) return null; // Reset to automatic height.
  if (!Number.isInteger(value) || value < MIN_QUEUE_LIST_HEIGHT ||
      value > MAX_QUEUE_LIST_HEIGHT) {
    throw new Error("队列高度必须是 72～900 像素的整数，或重置为自动高度");
  }
  return value;
}

function defaultIntervalMinutes(store) {
  const minutes = store.settings?.defaultIntervalMinutes;
  return Number.isInteger(minutes) && minutes >= 1 && minutes <= MAX_INTERVAL_MINUTES
    ? minutes : DEFAULT_INTERVAL_MINUTES;
}

function defaultRepeatCount(store) {
  const repeats = store.settings?.defaultRepeatCount;
  return Number.isInteger(repeats) && repeats >= -1 && repeats <= MAX_REPEAT_COUNT
    ? repeats : DEFAULT_REPEAT_COUNT;
}

function requireIntervalMinutes(value) {
  const minutes = Number(value);
  if (value === "" || value == null || !Number.isInteger(minutes) ||
      minutes < 1 || minutes > MAX_INTERVAL_MINUTES) {
    throw new Error("循环间隔必须为 1～525600 分钟之间的整数");
  }
  return minutes;
}

function requireDefaultRepeatCount(value) {
  if (value == null) throw new Error("默认循环次数必须为 -1、0 或正整数");
  return requireRepeatCount(value);
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
  return ownerMatches(session, sender) && session.key === resolveKey(url, sender.tab?.id) &&
    (!session.key.startsWith("draft:") || sameDraftScope(session.url, url));
}

// A project conversation ID only exists after ChatGPT accepts its first
// message. During that SPA redirect the new URL may arrive before the user
// bubble is hydrated; keep the introduction under its original draft key
// rather than replacing it with a new, empty conversation state.
const HANDOFF_OBSERVATION_HISTORY = new Set(["tab_owner_rebound","tab_revived","tab_reopened"]);

function handoffObservationHistory(entry) {
  return Boolean(entry && HANDOFF_OBSERVATION_HISTORY.has(entry.type) &&
    plausibleConversationTime(entry.at) &&
    Object.keys(entry).every(field => ["at","type"].includes(field)));
}

function sameHandoffDefault(value, expected) {
  if (value === expected) return true;
  if (!value || !expected || typeof value !== "object" || typeof expected !== "object" ||
      Array.isArray(value) !== Array.isArray(expected)) return false;
  if (Array.isArray(value) && value.length !== expected.length) return false;
  const keys = Object.keys(value);
  return keys.length === Object.keys(expected).length &&
    keys.every(field => Object.hasOwn(expected,field) && sameHandoffDefault(value[field],expected[field]));
}

function handoffTargetBlocker(state, sender, url) {
  if (!state || !targetMatches(state,sender,url) || state.parkedDraft ||
      state.handoffSourceKey || state.handoffToken || state.projectVisitId) {
    return !state || !targetMatches(state,sender,url) ? "owner" : "linked";
  }
  const defaults = blankSession(state.key,state.url,state.tabId);
  // Background wake/rebind observations do not turn an empty receiving shell
  // into user-owned work. Every actual task, choice and unknown field still
  // blocks replacement; compare defaults by value rather than key order.
  for (const [field,value] of Object.entries(state)) {
    if (["key","url","tabId"].includes(field)) continue;
    if (["firstSeenAt","firstMessageAt"].includes(field)) {
      if (value == null || plausibleConversationTime(value)) continue;
      return "metadata";
    }
    if (field === "unreadCompleted" && typeof value === "boolean") continue;
    if (field === "history" && Array.isArray(value) && value.every(handoffObservationHistory)) continue;
    if (["lastTimeScheduleId","lastCountScheduleId"].includes(field) && value == null) continue;
    if (field === "parkedDraft" && value === false) continue;
    if (!Object.hasOwn(defaults,field)) return "unknown_field";
    if (sameHandoffDefault(value,defaults[field])) continue;
    if (field === "tasks" || field === "schedules") return field;
    if (["activeTaskId","steeringTaskId"].includes(field)) return "active";
    if (["halted","queuePaused","error","haltReason","haltAtUserCount"].includes(field)) return "paused";
    if (field === "recentSubmissions") return "submissions";
    if (field === "history") return "history";
    if (["compactView","sendCooldownSeconds","autoOpenTab","countRateLimit","handoff"].includes(field)) {
      return "configuration";
    }
    if (["lastQueueSettledAt","countRateTimes"].includes(field)) return "queue_history";
    return "metadata";
  }
  return "none";
}

function handoffAdoptionCandidate(store, sender, url, draftKey = `draft:${sender.tab?.id}`) {
  const tabId = sender.tab?.id;
  const key = draftKey;
  const draft = store.conversations[key];
  const source = store.conversations[draft?.handoffSourceKey];
  const handoff = source?.handoff;
  const active = draft?.tasks?.find(task => task.id === draft.activeTaskId);
  const target = store.conversations[chatKey(url)];
  const result = {key,state:draft,source,active,targetShell:false,reason:"ready"};
  if (!draft || !draft.handoffSourceKey || !source || !handoff) result.reason = "source_missing";
  else if (!Number.isInteger(tabId) || draft.tabId !== tabId || source.tabId !== tabId ||
      safeUrl(sender.tab?.url) && safeUrl(sender.tab.url) !== url ||
      target && target.tabId !== tabId) result.reason = "owner_mismatch";
  else if (!chatKey(url) || !CQHandoff.projectId(url) ||
      CQHandoff.projectId(url) !== CQHandoff.normalizeProjectId(handoff.projectId) ||
      CQHandoff.projectId(source.url) !== CQHandoff.projectId(url) ||
      !sameDraftScope(draft.url,url) ||
      !CQHandoff.isProjectStart(draft.url,handoff.projectId) ||
      target && !sameDraftScope(target.url,url)) result.reason = "project_mismatch";
  else if (handoff.phase !== "bootstrapping" || handoff.cancelRequested) result.reason = "source_phase";
  else if (!handoff.token || handoff.token !== draft.handoffToken) result.reason = "token_mismatch";
  else if (handoff.destinationKey !== key) result.reason = "destination_mismatch";
  else if (!handoffQueueFor(store,source,draft)) result.reason = "cache_mismatch";
  else if (draft.halted || draft.queuePaused || !active || active.handoffQueueId !== handoff.queueId ||
      active.kind !== "handoff_intro" || !["dispatching","waiting"].includes(active.status)) result.reason = "intro_missing";
  else if (target) {
    result.targetBlocker = handoffTargetBlocker(target,sender,url);
    result.targetShell = result.targetBlocker === "none";
    const history = Array.isArray(target.history) ? target.history : [];
    result.targetSystemHistoryCount = history.filter(handoffObservationHistory).length;
    result.targetBusinessHistoryCount = history.length-result.targetSystemHistoryCount;
    result.reason = result.targetShell ? "target_exists_shell" : "target_has_work";
  }
  return result;
}

function handoffAdoptionCandidates(store, sender, url) {
  const keys = new Set([`draft:${sender.tab?.id}`]);
  for (const source of Object.values(store.conversations)) {
    if (source.tabId === sender.tab?.id && CQHandoff.projectId(source.url) === CQHandoff.projectId(url) &&
        source.handoff?.destinationKey?.startsWith("draft:")) keys.add(source.handoff.destinationKey);
  }
  return [...keys].map(key => handoffAdoptionCandidate(store,sender,url,key));
}

function noteHandoffCreatedChat(store, sender, url) {
  if (!chatKey(url) || safeUrl(sender.tab?.url) !== safeUrl(url)) return false;
  const candidate = handoffAdoptionCandidate(store,sender,url);
  if (!["ready","target_exists_shell"].includes(candidate.reason) || candidate.state.parkedDraft ||
      !Number.isFinite(candidate.active.sentAt) && !Number.isFinite(candidate.active.sendArmedAt)) return false;
  const cache = handoffQueueFor(store,candidate.source,candidate.state);
  if (!cache || cache.observedChatKey) return false;
  // URL creation is only a provisional observation. It grants no permission
  // to adopt or inject tasks: the full first message must still match uniquely.
  cache.observedChatKey = chatKey(url);
  cache.observedAt = Date.now();
  return true;
}

function selectHandoffAdoption(store, sender, url, text, userCount, folded = false, exactText = false) {
  const candidates = handoffAdoptionCandidates(store,sender,url);
  const eligible = candidates.filter(item => ["ready","target_exists_shell"].includes(item.reason));
  const exact = eligible.filter(item => CQHandoff.textMatch(item.active.text,text).matches &&
    (userCount === 1 || userCount == null && !item.state.parkedDraft &&
      !store.conversations[chatKey(url)] && !exactText));
  if (exact.length === 1) return {candidate:exact[0],reason:exact[0].reason,matchCount:1,observation:exact[0]};
  if (exact.length > 1) return {candidate:null,reason:"adoption_ambiguous",matchCount:exact.length,observation:exact[0]};
  // Count every acceptable document, including additive variants. Do not
  // prefer an exact candidate while ignoring another candidate within tolerance.
  const observation = eligible[0] || candidates.find(item => item.source) || candidates[0];
  return {candidate:null,reason:eligible.length ? "message_mismatch" : observation?.reason || "source_missing",
    matchCount:0,observation};
}

function pendingHandoffDraftForChat(store, sender, url) {
  const nextKey = chatKey(url);
  const tabId = sender.tab?.id;
  if (!nextKey || !Number.isInteger(tabId)) return null;
  const draftKey = `draft:${tabId}`;
  const draft = store.conversations[draftKey];
  const active = draft?.tasks?.find((task) => task.id === draft.activeTaskId);
  // The first project message can change the SPA route before its bubble
  // mounts. Retain the owned draft until that exact message confirms adoption.
  if (!store.conversations[nextKey] && draft && !draft.handoffSourceKey && ownerMatches(draft, sender) && active &&
      ["dispatching","waiting"].includes(active.status) &&
      isProjectOverview(draft.url) && draftCanAdoptChat(draft, url)) {
    return {key:draftKey,state:draft,active};
  }
  const candidate = handoffAdoptionCandidate(store,sender,url);
  if (draft?.parkedDraft || !["ready","target_exists_shell"].includes(candidate.reason)) return null;
  return {key:draftKey,state:draft,active};
}

function matchesHandoffIntroduction(expected, observed, folded = false) {
  if (sameMessage(expected, observed)) return true;
  // ChatGPT folds long user bubbles. Only the FIRST new turn of this
  // token-verified handoff draft may use an anchored, substantial preview.
  const full = String(expected || "").replace(/\s+/g," ").trim();
  let displayed = String(observed || "").replace(/\s+/g," ").trim();
  // Only a confirmed native folded bubble may add its own preview ellipsis.
  // Keep all other text intact and retain the substantial anchored prefix.
  if (folded === true) displayed = displayed.replace(/(?:…|\.\.\.)$/, "").trimEnd();
  return full.length >= 240 && displayed.length >= 160 &&
    displayed.length < full.length && full.startsWith(displayed);
}

function adoptNewChat(store, sender, url, lastUserText, lastUserFolded = false, observation = null, exactText = false, userCount = null) {
  const nextKey = chatKey(url);
  const selected = selectHandoffAdoption(store,sender,url,lastUserText,userCount,lastUserFolded,exactText);
  if (observation && selected.observation) Object.assign(observation,selected.observation,{reason:selected.reason});
  let draftKey = selected.candidate?.key || `draft:${sender.tab?.id}`;
  let draft = store.conversations[draftKey];
  if (!selected.candidate && draft?.handoffSourceKey) return false;
  if (!selected.candidate && selected.reason === "adoption_ambiguous") return false;
  if (!nextKey || !draft || !ownerMatches(draft, sender)) return false;
  const active = draft.tasks.find((task) => task.id === draft.activeTaskId);
  if (!active || (active.status !== "dispatching" && active.status !== "waiting")) return false;
  if (draft.handoffSourceKey) {
    if (!selected.candidate) return false;
    if (store.conversations[nextKey] && userCount !== 1) {
      if (observation) observation.reason = "user_count_mismatch";
      return false;
    }
    if (!CQHandoff.textMatch(active.text,lastUserText).matches) {
      if (observation) observation.reason = "message_mismatch";
      return false;
    }
  } else if (!draftCanAdoptChat(draft, url) || !sameMessage(active.text, lastUserText)) return false;
  if (store.conversations[nextKey] && !draft.handoffSourceKey) return false;
  const target = store.conversations[nextKey];
  if (draft.handoffSourceKey) {
    const source = store.conversations[draft.handoffSourceKey];
    const cache = handoffQueueFor(store,source,draft);
    if (!cache) return false;
    cache.destinationKey = nextKey;
    cache.confirmedChatKey = nextKey;
  }
  // Keep genuine observation timestamps when replacing this metadata shell.
  for (const field of ["firstSeenAt","firstMessageAt"]) {
    if (plausibleConversationTime(target?.[field]) &&
        (!plausibleConversationTime(draft[field]) || target[field] < draft[field])) draft[field] = target[field];
  }
  if (active.status === "dispatching") {
    // Full-document navigation can invalidate the old content script after
    // native Send but before its SENT RPC. A matching first user turn in the
    // new conversation is proof the handoff intro was delivered. Mark it
    // waiting, NEVER put it back in the send queue on a reload.
    active.status = "waiting";
    active.sentAt = Date.now();
  }
  draft.key = nextKey;
  draft.url = safeUrl(url);
  delete draft.projectVisitId;
  delete draft.parkedDraft;
  if (target?.unreadCompleted === true) draft.unreadCompleted = true;
  if (target?.history?.length) {
    draft.history = [...draft.history,...target.history].sort((a,b) => a.at-b.at).slice(-HISTORY_LIMIT);
  }
  store.conversations[nextKey] = draft;
  delete store.conversations[draftKey];
  if (draft.handoffSourceKey) {
    const source = store.conversations[draft.handoffSourceKey];
    if (source?.handoff?.token === draft.handoffToken &&
        source.handoff.destinationKey === draftKey) {
      source.handoff.destinationKey = nextKey;
    }
  }
  if (observation) observation.reason = "adopted";
  return true;
}

function newTask(text, sourceScheduleId = null, images = []) {
  return {
    id: id(),
    text,
    status: "pending",
    sourceScheduleId,
    images,
    createdAt: Date.now(),
  };
}

// A relay cache is indexed by the original conversation, with an independent
// per-relay queue ID. It shares the durable envelope with the live queues so
// restoring rules and consuming the cache can never be separate commits.
function handoffQueueFor(store, source, destination = null) {
  const handoff = source?.handoff;
  const entry = store.handoffQueues?.[source?.key];
  if (!entry || entry.version !== 1 || !handoff?.queueId ||
      entry.sourceKey !== source.key || source.key !== chatKey(source.url) ||
      entry.queueId !== handoff.queueId ||
      !entry.token || entry.token !== handoff.token ||
      !entry.projectId || entry.projectId !== CQHandoff.projectId(source.url) ||
      !Array.isArray(entry.schedules) || !entry.settings ||
      typeof entry.settings !== "object" || Array.isArray(entry.settings)) return null;
  if (destination && (destination.handoffCacheKey !== source.key ||
      destination.handoffSourceKey !== source.key ||
      destination.handoffQueueId !== entry.queueId || destination.handoffToken !== entry.token ||
      entry.destinationKey !== destination.key || handoff.destinationKey !== destination.key ||
      entry.projectId !== CQHandoff.projectId(destination.url))) return null;
  return entry;
}

function handoffQueueSettings(source) {
  const result = {};
  for (const field of ["queuePaused","compactView","autoOpenTab","sendCooldownSeconds",
      "countRateLimit","countRateTimes","lastQueueSettledAt","lastTimeScheduleId","lastCountScheduleId"]) {
    if (source[field] !== undefined) result[field] = source[field];
  }
  return JSON.parse(JSON.stringify(result));
}

function handoffOrdinaryTasks(source) {
  return JSON.parse(JSON.stringify(source.tasks.filter(task =>
    !["handoff_summary","handoff_intro"].includes(task.kind))));
}

function checkpointHandoffTasks(store, source) {
  const entry = handoffQueueFor(store,source);
  if (!entry || source.handoffSourceKey) return;
  const tasks = handoffOrdinaryTasks(source);
  if (JSON.stringify(tasks) !== JSON.stringify(entry.tasks)) {
    entry.tasks = tasks;
    entry.updatedAt = Date.now();
  }
}

function checkpointHandoffQueue(store, source, includeSchedules = true) {
  const entry = handoffQueueFor(store,source);
  if (!entry || source.handoffSourceKey) return false;
  const schedules = includeSchedules ? JSON.parse(JSON.stringify(source.schedules)) : entry.schedules;
  const settings = handoffQueueSettings(source);
  if (JSON.stringify(entry.schedules) === JSON.stringify(schedules) &&
      JSON.stringify(entry.settings) === JSON.stringify(settings)) return false;
  entry.schedules = schedules;
  entry.settings = settings;
  entry.updatedAt = Date.now();
  return true;
}

function createHandoffQueue(store, source, now = Date.now()) {
  store.handoffQueues ||= {};
  store.handoffQueues[source.key] = {
    version:1,sourceKey:source.key,queueId:source.handoff.queueId,token:source.handoff.token,
    projectId:CQHandoff.projectId(source.url),destinationKey:null,
    createdAt:now,updatedAt:now,schedules:JSON.parse(JSON.stringify(source.schedules)),
    taskSnapshotVersion:1,tasks:handoffOrdinaryTasks(source),
    settings:handoffQueueSettings(source),
  };
}

function checkpointScheduledHandoffQueue(store, source) {
  const entry = handoffQueueFor(store,source);
  if (!entry) return;
  checkpointHandoffQueue(store,source,false);
  // A scheduler tick can merely prune rate timestamps. It is never evidence
  // that an absent rule was deliberately deleted. Preserve cached IDs and
  // advance only the rules the scheduler actually still knows about.
  const live = new Map(source.schedules.map(rule => [rule.id,rule]));
  const schedules = entry.schedules.map(rule => live.get(rule.id) || rule);
  if (JSON.stringify(schedules) !== JSON.stringify(entry.schedules)) {
    entry.schedules = JSON.parse(JSON.stringify(schedules));
    entry.updatedAt = Date.now();
  }
  const liveTasks = handoffOrdinaryTasks(source);
  const liveById = new Map(liveTasks.map(task => [task.id,task]));
  const cachedIds = new Set((entry.tasks || []).map(task => task.id));
  const tasks = [...(entry.tasks || []).map(task => liveById.get(task.id) || task),
    ...liveTasks.filter(task => !cachedIds.has(task.id))];
  if (JSON.stringify(tasks) !== JSON.stringify(entry.tasks)) {
    entry.tasks = tasks;
    entry.updatedAt = Date.now();
  }
}

function removeHandoffQueue(store, source) {
  const entry = store.handoffQueues?.[source?.key];
  if (!entry || entry.sourceKey !== source.key || entry.queueId !== source.handoff?.queueId ||
      entry.token !== source.handoff?.token) return false;
  delete store.handoffQueues[source.key];
  return true;
}

function bindHandoffQueueDestination(store, source, destination, previousKey = null) {
  const entry = handoffQueueFor(store,source);
  if (!entry || entry.destinationKey !== previousKey) {
    throw new Error("接力缓存归属不一致，已保留自动规则，请取消本轮后重新接力");
  }
  destination.handoffCacheKey = source.key;
  destination.handoffQueueId = entry.queueId;
  entry.destinationKey = destination.key;
  if (destination.key.startsWith("chat:")) entry.confirmedChatKey = destination.key;
}

function maintainHandoffQueues(store) {
  let changed = false;
  if (!store.handoffQueues) { store.handoffQueues = {}; changed = true; }
  // Upgrade only legacy transactions with no cache identity. A modern missing
  // cache must remain an explicit failure, never silently rebuilt from []
  // after a transient source-state problem.
  for (const source of Object.values(store.conversations)) {
    const handoff = source.handoff;
    if (source.handoffSourceKey || !chatKey(source.url) || !CQHandoff.projectId(source.url) ||
        !["queued","due","summarizing","opening","navigating","bootstrapping","failed"].includes(handoff?.phase)) continue;
    if (!handoff.queueId && !store.handoffQueues[source.key]) {
      handoff.queueId = id();
      handoff.token ||= id();
      for (const task of source.tasks) {
        if (task.kind === "handoff_summary") task.handoffQueueId = handoff.queueId;
      }
      createHandoffQueue(store,source);
      const destination = store.conversations[handoff.destinationKey];
      if (destination?.handoffSourceKey === source.key && destination.handoffToken === handoff.token &&
          source.tabId === destination.tabId && sameDraftScope(source.url,destination.url)) {
        bindHandoffQueueDestination(store,source,destination);
        for (const task of destination.tasks) {
          if (task.kind === "handoff_intro") task.handoffQueueId = handoff.queueId;
        }
      }
      changed = true;
    }
    const cache = handoffQueueFor(store,source);
    if (cache && cache.taskSnapshotVersion == null) {
      cache.tasks = handoffOrdinaryTasks(source);
      cache.taskSnapshotVersion = 1;
      if (cache.destinationKey?.startsWith("chat:")) cache.confirmedChatKey = cache.destinationKey;
      changed = true;
    }
    // Rule edits and automatic refills checkpoint explicitly at their mutation
    // sites. A generic read/save must never overwrite the cache with a live []
    // that disappeared while a page or worker was being reattached.
  }
  for (const key of Object.keys(store.handoffQueues)) {
    const source = store.conversations[key];
    if (!source || (!source.handoff?.queueId && ["idle","completed"].includes(source.handoff?.phase))) {
      delete store.handoffQueues[key];
      changed = true;
    }
  }
  return changed;
}

function handoffState(state) {
  return state.handoff || (state.handoff = CQHandoff.defaults());
}

function handoffBusy(state) {
  return Boolean(state.handoff && !["idle", "queued", "completed"].includes(state.handoff.phase));
}

function handoffCounts(handoff) {
  // Older configurations had no quota and remain unlimited after upgrade.
  const repeatCount = handoff?.repeatCount === -1 ||
    Number.isInteger(handoff?.repeatCount) && handoff.repeatCount >= 1 &&
    handoff.repeatCount <= MAX_REPEAT_COUNT ? handoff.repeatCount : -1;
  const remainingCount = repeatCount === -1 ? -1 :
    Number.isInteger(handoff?.remainingCount) && handoff.remainingCount >= 0
      ? Math.min(repeatCount, handoff.remainingCount) : repeatCount;
  return {repeatCount,remainingCount};
}

function enqueueHandoff(store, state, trigger, now = Date.now()) {
  const handoff = handoffState(state);
  if (state.tasks.some((task) => task.kind === "handoff_summary")) return false;
  const summary = newTask(CQHandoff.summaryPrompt(handoff.topicTitle));
  summary.kind = "handoff_summary";
  summary.handoffTrigger = trigger;
  state.tasks.push(summary);
  Object.assign(handoff,handoffCounts(handoff),{
    phase:"queued",trigger,manualRequested:trigger === "manual",
    nextAt:null,changedAt:now,queueId:id(),token:id(),
  });
  summary.handoffQueueId = handoff.queueId;
  delete handoff.destinationKey;
  createHandoffQueue(store,state,now);
  delete handoff.error;
  delete handoff.cancelRequested;
  recordHistory(state,trigger === "manual" ? "handoff_manual" : "handoff_due",summary.id,now);
  return true;
}

function maybeRequestHandoff(store, state, now = Date.now()) {
  if (state.parkedDraft) return false;
  const handoff = state.handoff;
  if (!handoff || state.handoffSourceKey || !chatKey(state.url) ||
      !CQHandoff.projectId(state.url)) return false;
  // Convert an older unsent due state into the same durable queue command.
  if (handoff.phase === "due") {
    return enqueueHandoff(store,state,handoff.manualRequested ? "manual" : "automatic",now);
  }
  if (!handoff.enabled || handoff.phase !== "idle" ||
      !Number.isFinite(handoff.nextAt) || now < handoff.nextAt) return false;
  if (handoffCounts(handoff).remainingCount === 0) {
    handoff.enabled = false;
    handoff.nextAt = null;
    return true;
  }
  // Countdown expiry queues one command even without ordinary pending work.
  // Pausing only prevents dispatch; it never loses an expired countdown.
  return enqueueHandoff(store,state,"automatic",now);
}

function failHandoff(source, reason, now = Date.now()) {
  const handoff = source.handoff;
  if (!handoff || ["idle","completed","failed"].includes(handoff.phase)) return false;
  handoff.phase = "failed";
  handoff.changedAt = now;
  handoff.error = String(reason).slice(0, 240);
  recordHistory(source, "handoff_failed", null, now);
  return true;
}

function syncFailedHandoffDestination(store, destination, now = Date.now()) {
  if (!destination.handoffSourceKey) return false;
  const source = store.conversations[destination.handoffSourceKey];
  const handoff = source?.handoff;
  if (!handoff || handoff.token !== destination.handoffToken ||
      handoff.destinationKey !== destination.key || source.tabId !== destination.tabId) return false;
  const intro = destination.tasks.find((task) => task.kind === "handoff_intro");
  const uncertain = destination.halted &&
    VOICE_RECOVERABLE_HALTS.has(destination.haltReason) &&
    intro && ["dispatching","waiting"].includes(intro.status);
  if (handoff.phase !== "failed" && intro &&
      !["error","interrupted"].includes(intro.status) && !uncertain) return false;
  // An intro failure cannot become an ordinary recovered queue: the source
  // still owns its tasks. Keep both ends visibly failed until explicit review.
  let changed = false;
  if (uncertain) {
    intro.status = "error";
    intro.error ||= "交接开场发送状态不确定，不会自动重发；请返回原对话核对接力。";
    changed = true;
  }
  const reason = !intro
    ? "新对话的交接开场记录缺失，无法确认是否已发送；旧队列仍在原对话，请人工核对。"
    : intro.error || handoff.error || "新对话接收交接中断；旧队列仍在原对话，请人工核对。";
  changed = failHandoff(source, reason, now) || changed;
  if (!destination.halted) { destination.halted = true; changed = true; }
  if (destination.haltReason !== "user" && destination.haltReason !== "failure") {
    destination.haltReason = "failure";
    changed = true;
  }
  if (intro && ["error","interrupted"].includes(intro.status) &&
      destination.activeTaskId === intro.id) {
    destination.activeTaskId = null;
    changed = true;
  }
  if (destination.error !== reason) { destination.error = reason; changed = true; }
  if (destination.handoff?.phase !== "failed" || destination.handoff?.error !== reason) {
    destination.handoff = {...(destination.handoff || CQHandoff.defaults()),
      enabled:false,nextAt:null,phase:"failed",error:reason,changedAt:now};
    changed = true;
  }
  return changed;
}

function cancelHandoffState(source, now = Date.now()) {
  const current = source.handoff || CQHandoff.defaults();
  const minutes = Number.isInteger(current.intervalMinutes)
    ? current.intervalMinutes : CQHandoff.DEFAULT_MINUTES;
  const counts = handoffCounts(current);
  const enabled = current.enabled === true && counts.remainingCount !== 0;
  source.handoff = {
    enabled, intervalMinutes:minutes,...counts,
    nextAt:enabled ? now + minutes * 60_000 : null,
    phase:"idle",
    ...(current.topicTitle ? {topicTitle:current.topicTitle} : {}),
  };
  recordHistory(source,"handoff_cancelled",null,now);
}

function clearCancelledHandoffHalt(state) {
  if (state.activeTaskId || state.steeringTaskId ||
      state.tasks.some(task => ["error","interrupted"].includes(task.status))) return;
  if (state.halted && !["failure","timeout","uncertain","state_inconsistent"].includes(state.haltReason)) return;
  state.halted = false;
  state.haltReason = null;
  state.haltAtUserCount = null;
  state.error = "";
  state.lastQueueSettledAt = Date.now();
}

// Cancellation removes only the internal rows of this transaction. The
// receiving draft is a real queue too: it may now contain ordinary tasks.
// Never delete that whole session, or leave its token to re-fail on GET.
function cancelHandoffTransaction(store, state, options = {}) {
  let source = state;
  let destination = null;
  if (state.handoffSourceKey || !state.handoff?.token &&
      state.tasks.some(task => task.kind === "handoff_intro")) {
    destination = state;
    const linked = store.conversations[state.handoffSourceKey];
    const handoff = linked?.handoff;
    if (handoff?.token && handoff.token === state.handoffToken &&
        handoff.queueId === state.handoffQueueId && state.handoffCacheKey === linked.key &&
        handoff.destinationKey === state.key && linked.tabId === state.tabId) {
      source = linked;
    } else {
      // Older versions cancelled the receiver's local phase but left this
      // link behind. Explicit cancellation can retire that orphan intro.
      source = null;
    }
  } else if (source.handoff?.destinationKey) {
    destination = store.conversations[source.handoff.destinationKey] || null;
    if (destination && (destination.handoffSourceKey !== source.key ||
        destination.handoffToken !== source.handoff.token || destination.tabId !== source.tabId ||
        destination.handoffQueueId !== source.handoff.queueId || destination.handoffCacheKey !== source.key)) {
      destination = null; // A newer/unrelated destination must remain intact.
    }
  }
  const handoff = source?.handoff;
  const internal = state.tasks.some(task => ["handoff_summary","handoff_intro"].includes(task.kind));
  if (!destination && !internal && !["queued","due","summarizing","opening","navigating","bootstrapping","failed"]
      .includes(handoff?.phase)) {
    return false; // Repeated explicit cancellation is harmless.
  }
  const activeSummary = source?.tasks.find(task => task.id === source.activeTaskId &&
    task.kind === "handoff_summary" && ["dispatching","waiting"].includes(task.status));
  if (activeSummary) {
    source.handoff.cancelRequested = true;
    source.handoff.changedAt = Date.now();
    return true;
  }
  const intros = destination?.tasks.filter(task => task.kind === "handoff_intro") || [];
  if (intros.some(task => task.status !== "pending") && options.reviewed !== true) {
    throw new Error("请核对已发送的交接消息后确认取消；不会重新发送该消息");
  }
  if (source) {
    const summaryIds = new Set(source.tasks.filter(task => task.kind === "handoff_summary").map(task => task.id));
    source.tasks = source.tasks.filter(task => !summaryIds.has(task.id));
    if (summaryIds.has(source.activeTaskId)) source.activeTaskId = null;
    const cache = handoffQueueFor(store,source);
    if (cache) {
      source.schedules = JSON.parse(JSON.stringify(cache.schedules));
      if (Array.isArray(cache.tasks)) source.tasks = JSON.parse(JSON.stringify(cache.tasks));
    }
    removeHandoffQueue(store,source);
    cancelHandoffState(source);
    if (options.pauseAfter === true && source === state) source.queuePaused = true;
    clearCancelledHandoffHalt(source);
  }
  if (destination) {
    const introIds = new Set(intros.map(task => task.id));
    destination.tasks = destination.tasks.filter(task => !introIds.has(task.id));
    if (introIds.has(destination.activeTaskId)) destination.activeTaskId = null;
    if (introIds.has(destination.steeringTaskId)) destination.steeringTaskId = null;
    delete destination.handoffSourceKey;
    delete destination.handoffToken;
    delete destination.handoffCacheKey;
    delete destination.handoffQueueId;
    destination.handoff = {...CQHandoff.defaults(),phase:"idle"};
    recordHistory(destination,"handoff_cancelled");
    clearCancelledHandoffHalt(destination);
  }
  return false;
}

// A tab can visit several project composers. Retain the previous visit in
// storage, outside the live draft slot, instead of blocking the new project
// or exposing its stale receiving task. Returning restores that exact scope.
function switchDraftScope(store, tabId, url) {
  const key = `draft:${tabId}`;
  const current = store.conversations[key];
  if (current && sameDraftScope(current.url,url)) return false;
  let changed = false;
  const move = (draft,nextKey) => {
    const oldKey = draft.key;
    const source = store.conversations[draft.handoffSourceKey];
    const cache = source && handoffQueueFor(store,source,draft);
    delete store.conversations[oldKey];
    draft.key = nextKey;
    store.conversations[nextKey] = draft;
    if (source?.handoff?.token && source.handoff.token === draft.handoffToken &&
        source.handoff.destinationKey === oldKey) {
      source.handoff.destinationKey = nextKey;
      if (cache) cache.destinationKey = nextKey;
    }
  };
  if (current) {
    move(current,`draft:${tabId}:parked:${id()}`);
    current.parkedDraft = true;
    changed = true;
  }
  const parked = Object.values(store.conversations).find(draft =>
    draft.parkedDraft === true && draft.tabId === tabId && sameDraftScope(draft.url,url));
  if (parked) {
    move(parked,key);
    delete parked.parkedDraft;
    changed = true;
  }
  return changed;
}

function timeoutHandoff(state, now = Date.now()) {
  const handoff = state.handoff;
  if (!handoff) return false;
  if (handoff.phase === "summarizing" &&
      state.tasks.some((task) => task.kind === "handoff_summary" &&
        ["error","interrupted"].includes(task.status)) && !state.activeTaskId) {
    return failHandoff(state, "交接总结发送中断，请核对原对话后取消接力。", now);
  }
  if (handoff.phase === "opening" && now - handoff.changedAt > 5 * 60_000) {
    return failHandoff(state, "生成总结后未能自动进入新对话，旧队列仍在原对话；可取消交接后继续。", now);
  }
  // No introduction has been sent in this phase. Give the native project
  // entry the same recovery window as bootstrap instead of failing while a
  // discarded/spinning page is being restored by the background/content loop.
  if (handoff.phase === "navigating" && now - handoff.changedAt > 60 * 60_000) {
    return failHandoff(state, "无法确认已进入项目新对话。请返回原对话取消接力，旧队列仍然保留。", now);
  }
  if (handoff.phase === "bootstrapping" && now - handoff.changedAt > 60 * 60_000) {
    return failHandoff(state, "新对话长时间没有确认接收交接内容。旧队列尚未迁移，请人工核对。", now);
  }
  return false;
}

function attachProjectHandoff(store, sender, url) {
  const projectId = CQHandoff.projectId(url);
  const tabId = sender.tab?.id;
  if (!Number.isInteger(tabId) || !projectId ||
      !CQHandoff.isProjectStart(url,projectId)) return false;
  const source = Object.values(store.conversations).find((session) =>
    session.tabId === tabId && session.handoff?.phase === "navigating" &&
    CQHandoff.normalizeProjectId(session.handoff.projectId) === projectId &&
    CQHandoff.projectId(session.url) === projectId &&
    CQHandoff.projectId(session.handoff.projectUrl) === projectId);
  if (!source) return false;
  // An in-flight handoff started on an older version can still contain a
  // slugged project ID. Normalize it before creating the destination draft.
  source.handoff.projectId = projectId;
  source.handoff.projectUrl = CQHandoff.projectStart(url);
  const draftKey = `draft:${tabId}`;
  const existing = store.conversations[draftKey];
  if (existing && (existing.tasks.length || existing.schedules.length ||
                   existing.activeTaskId || existing.handoffSourceKey)) {
    failHandoff(source, "新对话入口已有未完成的队列，已停止自动迁移");
    return true;
  }
  const draft = blankSession(draftKey, safeUrl(url), tabId);
  const intro = newTask(CQHandoff.introduction(source.handoff.summary, source.handoff.topicTitle));
  intro.kind = "handoff_intro";
  intro.handoffQueueId = source.handoff.queueId;
  // The first message creates ChatGPT's conversation ID. Place it FIRST;
  // original tasks stay at the source until the new reply is confirmed.
  draft.tasks.unshift(intro);
  draft.handoffSourceKey = source.key;
  draft.handoffToken = source.handoff.token;
  bindHandoffQueueDestination(store,source,draft);
  store.conversations[draftKey] = draft;
  source.handoff.phase = "bootstrapping";
  source.handoff.destinationKey = draftKey;
  source.handoff.changedAt = Date.now();
  recordHistory(source, "handoff_new_chat");
  return true;
}

function activeProjectHandoffDraft(store, key, sender, url) {
  const draft = store.conversations[key];
  const source = store.conversations[draft?.handoffSourceKey];
  const handoff = source?.handoff;
  return Boolean(draft && source && handoff && draft.tabId === sender.tab?.id &&
    CQHandoff.isProjectStart(url, handoff.projectId) &&
    handoff.phase === "bootstrapping" && handoff.destinationKey === key &&
    handoff.token === draft.handoffToken && handoffQueueFor(store,source,draft) && draft.tasks.some((task) =>
      task.kind === "handoff_intro"));
}

function finishHandoffTransfer(store, destination, task, url) {
  const source = store.conversations[destination.handoffSourceKey];
  const handoff = source?.handoff;
  if (task.kind !== "handoff_intro" || !source || !handoff ||
      handoff.phase !== "bootstrapping" ||
      handoff.token !== destination.handoffToken ||
      source.tabId !== destination.tabId ||
      CQHandoff.normalizeProjectId(handoff.projectId) !== CQHandoff.projectId(url) ||
      handoff.destinationKey !== destination.key ||
      destination.tasks.length !== 1 || destination.tasks[0].id !== task.id) {
    throw new Error("无法验证同项目对话接力关系，旧队列保持不变");
  }
  const cache = handoffQueueFor(store,source,destination);
  if (!cache || task.handoffQueueId !== cache.queueId) {
    throw new Error("接力缓存缺失或队列 ID 不匹配，自动规则未迁移；请导出 DEBUG 后核对");
  }
  if (cache.confirmedChatKey !== destination.key || !Array.isArray(cache.tasks) ||
      cache.tasks.some(item => ["dispatching","waiting","steering","steering_wait"].includes(item.status))) {
    throw new Error("新对话 ID 或待办缓存尚未完整确认，已保留本轮任务和自动规则");
  }
  if (destination.schedules.length) {
    throw new Error("接收对话已有自动规则，已停止覆盖，请先核对本次接力");
  }
  // One durable storage write moves all references together. Images live in
  // IndexedDB and are NOT copied or deleted; their IDs remain referenced.
  const receiverPaused = destination.queuePaused === true;
  destination.tasks = JSON.parse(JSON.stringify(cache.tasks));
  destination.schedules = JSON.parse(JSON.stringify(cache.schedules));
  Object.assign(destination,handoffQueueSettings(cache.settings));
  if (receiverPaused) destination.queuePaused = true;
  // Receipt carries the logical relay queue ID without exposing it to the AI.
  destination.receivedHandoffQueueId = cache.queueId;
  removeHandoffQueue(store,source);
  destination.lastQueueSettledAt = Date.now();
  const counts = handoffCounts(handoff);
  if ((handoff.trigger === "automatic" ||
       !handoff.trigger && !handoff.manualRequested) && counts.remainingCount > 0) {
    counts.remainingCount -= 1;
  }
  const enabled = handoff.enabled === true && counts.remainingCount !== 0;
  destination.handoff = {
    enabled, intervalMinutes:handoff.intervalMinutes,...counts,
    nextAt:enabled ? Date.now() + handoff.intervalMinutes * 60_000 : null, phase:"idle",
    ...(handoff.topicTitle ? {topicTitle:handoff.topicTitle} : {}),
  };
  source.tasks = [];
  source.schedules = [];
  source.autoOpenTab = false;
  source.handoff = {
    enabled:false,intervalMinutes:handoff.intervalMinutes,...counts,nextAt:null,
    phase:"completed",destinationKey:destination.key,changedAt:Date.now(),
    ...(handoff.topicTitle ? {topicTitle:handoff.topicTitle} : {}),
  };
  delete destination.handoffSourceKey;
  delete destination.handoffToken;
  delete destination.handoffCacheKey;
  delete destination.handoffQueueId;
  recordHistory(source,"handoff_completed");
  recordHistory(destination,"handoff_received");
}

// Store metadata-only diagnostics. Never write prompts, images or raw errors
// into the history: exported backups may be shared for troubleshooting.
function recordHistory(state, type, taskId = null, now = Date.now()) {
  const previous = Array.isArray(state.history) ? state.history : [];
  const entry = {
    at: now,
    type,
    ...(typeof taskId === "string" ? { taskId: taskId.slice(0, 72) } : {}),
  };
  state.history = [...previous.slice(-(HISTORY_LIMIT - 1)), entry];
}

function requireSubmissionId(value) {
  // Optional for old content scripts. New content scripts use one UUID per
  // user action so a response lost after persistence can be retried safely.
  if (value == null) return null;
  if (typeof value !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error("提交标识格式无效");
  }
  return value;
}

async function submissionFingerprint(type, message, requestId) {
  if (!requestId) return null; // Legacy callers do not need fingerprint work.
  // Hash original images one at a time. A four-image task can contain about
  // 45 MB of base64, so stringifying/copying all its bytes a second time for
  // the receipt would unnecessarily increase service-worker memory use.
  const images = [];
  for (const image of message.images || []) {
    images.push({
      name: image?.name,
      type: image?.type,
      dataSha256: await imageSha256(image?.dataUrl || ""),
      thumbnailSha256: await imageSha256(image?.thumbnail || ""),
    });
  }
  const payload = type === "ENQUEUE_FAVORITE" ? {
      type, favoriteId:message.favoriteId, text:message.text, imageRefs:message.imageRefs,
    } : type === "ADD_SCHEDULE"
    ? {
      type, text: message.text, images,
      mode: message.mode ?? "time", intervalMinutes: message.intervalMinutes,
      threshold: message.threshold, repeatCount: message.repeatCount,
    }
    : {type, text: message.text, images};
  const digest = await crypto.subtle.digest(
    "SHA-256", new TextEncoder().encode(JSON.stringify(payload)));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function submittedRecently(state, requestId, fingerprint, now = Date.now()) {
  if (!requestId) return false;
  const receipt = (Array.isArray(state.recentSubmissions) ? state.recentSubmissions : [])
    .find((entry) => entry.id === requestId && Number.isFinite(entry.at) &&
      entry.at <= now && now - entry.at < SUBMISSION_HISTORY_TTL_MS);
  if (!receipt) return false;
  // Old v0.17 receipts had no fingerprint. Fail closed by keeping their
  // original once-only semantics; never recreate an ambiguously sent task.
  if (receipt.fingerprint && receipt.fingerprint !== fingerprint) {
    throw new Error("重复提交标识对应的内容已经变化；请重新提交，不能静默丢弃不同内容");
  }
  return true;
}

function markSubmission(state, requestId, fingerprint, now = Date.now()) {
  if (!requestId) return;
  const prior = Array.isArray(state.recentSubmissions) ? state.recentSubmissions : [];
  state.recentSubmissions = [...prior.filter((entry) =>
    entry && Number.isFinite(entry.at) && entry.at <= now &&
    now - entry.at < SUBMISSION_HISTORY_TTL_MS).slice(-(SUBMISSION_HISTORY_LIMIT - 1)),
  {id:requestId,at:now,fingerprint}];
}

function backupTask(item) {
  return {
    id: item.id, text: item.text, status: item.status,
    images: item.images || [], sourceScheduleId: item.sourceScheduleId || null,
  };
}

function backupRule(item) {
  return {
    id: item.id, text: item.text, mode: item.mode || "time",
    intervalMinutes: item.intervalMinutes, threshold: item.threshold,
    repeatCount: repeatLimit(item.repeatCount), images: item.images || [],
  };
}

async function imageSha256(dataUrl) {
  // Hash the canonical serialized image data, not its filename or thumbnail.
  // Each call handles only one image, keeping peak memory bounded.
  const buffer = new TextEncoder().encode(dataUrl);
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function createBackupMetadata(state) {
  if (state.tasks.length > 300 || state.schedules.length > 100) {
    throw new Error("此对话任务或自动规则数量超出可安全恢复的备份上限");
  }
  const refs = new Map();
  for (const item of [...state.tasks, ...state.schedules]) {
    for (const image of item.images || []) {
      if (typeof image.id !== "string" || !image.id ||
          typeof image.name !== "string" || typeof image.type !== "string" ||
          !Number.isInteger(image.size)) {
        throw new Error("队列中存在无法识别的图片引用，无法安全备份");
      }
      const old = refs.get(image.id);
      if (old && (old.name !== image.name || old.type !== image.type ||
          old.size !== image.size)) {
        throw new Error("同一图片引用的文件信息不一致，无法安全备份");
      }
      refs.set(image.id, {id:image.id,name:image.name,type:image.type,size:image.size});
    }
  }
  if (refs.size > 400) throw new Error("此对话图片数量超过 400 张，无法备份");
  const copy = (item) => ({
    ...item,
    // Original thumbnails and image bytes are included in the corresponding
    // per-image export segment; no reason to repeat them in every task.
    images:(item.images || []).map((image) => ({id:image.id})),
  });
  const metadata = {
    format: BACKUP_FORMAT, version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    conversation: {
      key: state.key,
      // Relay commands are state-machine operations, never ordinary prompts
      // that a backup restore may replay outside the handoff lifecycle.
      tasks: state.tasks.filter((task) =>
        !["handoff_summary","handoff_intro"].includes(task.kind)).map((task) => copy(backupTask(task))),
      omittedHandoffTasks:state.tasks.filter((task) =>
        ["handoff_summary","handoff_intro"].includes(task.kind)).length,
      schedules: state.schedules.map((rule) => copy(backupRule(rule))),
      countRateLimit: countRateLimit(state),
    },
    images: [...refs.values()],
  };
  if (JSON.stringify(metadata).length > MAX_BACKUP_BYTES) {
    throw new Error("备份任务清单体积超过 60 MB，拒绝导出不完整文件");
  }
  return metadata;
}

function validateBackupManifest(backup, key) {
  if (!backup || backup.format !== BACKUP_FORMAT ||
      backup.version !== BACKUP_VERSION || backup.conversation?.key !== key ||
      !Array.isArray(backup.images) || backup.images.length > 400 ||
      !Array.isArray(backup.conversation.tasks) || backup.conversation.tasks.length > 300 ||
      !Array.isArray(backup.conversation.schedules) || backup.conversation.schedules.length > 100) {
    throw new Error("备份清单无效、版本不支持或对话不匹配");
  }
  const expected = new Map();
  for (const item of backup.images) {
    if (!item || typeof item.id !== "string" || !item.id || expected.has(item.id) ||
        typeof item.name !== "string" || typeof item.type !== "string" ||
        !Number.isInteger(item.size) || item.size < 1 || item.size > MAX_IMAGE_BYTES ||
        Object.hasOwn(item, "dataUrl") ||
        (item.sha256 != null && !IMAGE_SHA256_PATTERN.test(item.sha256))) {
      throw new Error("备份清单存在重复/无效原图或包含不应上传的完整图像数据");
    }
    expected.set(item.id, {
      name:item.name,type:item.type,size:item.size,
      sha256:item.sha256 || null, // Older JSON backups have no checksum.
    });
  }
  return expected;
}

async function createConversationBackup(state) {
  if (state.tasks.length > 300 || state.schedules.length > 100) {
    throw new Error("此对话任务或自动规则数量超出可安全恢复的备份上限，未生成不完整备份");
  }
  const imageIds = [...new Set([
    ...state.tasks.flatMap((item) => (item.images || []).map((image) => image.id)),
    ...state.schedules.flatMap((item) => (item.images || []).map((image) => image.id)),
  ])];
  const referenceMap = new Map(
    [...state.tasks, ...state.schedules]
      .flatMap((item) => item.images || [])
      .map((image) => [image.id, image]));
  if (imageIds.length > 400) {
    throw new Error("此对话图片数量超过 400 张，无法生成可完整恢复的备份");
  }
  const conversation = {
    key: state.key,
    tasks: state.tasks.filter((task) =>
      !["handoff_summary","handoff_intro"].includes(task.kind)).map(backupTask),
    omittedHandoffTasks:state.tasks.filter((task) =>
      ["handoff_summary","handoff_intro"].includes(task.kind)).length,
    schedules: state.schedules.map(backupRule),
    countRateLimit: countRateLimit(state),
  };
  const images = [];
  let approxSize = JSON.stringify(conversation).length;
  // Stream through small IndexedDB reads instead of loading hundreds of
  // full-resolution images before discovering an oversized backup.
  for (let start = 0; start < imageIds.length; start += 2) {
    const batch = await cqImageStore.load(imageIds.slice(start, start + 2));
    for (const item of batch) {
      verifyStoredImage(referenceMap.get(item.id), item);
      approxSize += JSON.stringify(item).length;
      if (approxSize > MAX_BACKUP_BYTES) {
        throw new Error("此对话的图文备份超过 60 MB，未生成不完整的备份文件；请先精简待办图片");
      }
      images.push(item);
    }
  }
  const result = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    conversation,
    images,
  };
  if (JSON.stringify(result).length > MAX_BACKUP_BYTES) {
    throw new Error("此对话的图文备份超过 60 MB，未生成不完整的备份文件；请先精简待办图片");
  }
  return result;
}

function prepareConversationRestore(backup, key, maxPending, stagedImages = null) {
  if (!backup || backup.format !== BACKUP_FORMAT || backup.version !== BACKUP_VERSION ||
      !backup.conversation || backup.conversation.key !== key) {
    throw new Error("备份文件版本不支持，或不是当前对话的备份；请打开原对话再恢复");
  }
  const source = backup.conversation;
  if (!Array.isArray(source.tasks) || source.tasks.length > 300 ||
      !Array.isArray(source.schedules) || source.schedules.length > 100 ||
      !Array.isArray(backup.images) || backup.images.length > 400 ||
      JSON.stringify(backup).length > MAX_BACKUP_BYTES) {
    throw new Error("备份数据量或结构超出安全限制");
  }
  const imageMap = new Map();
  const records = [];
  for (const image of backup.images) {
    if (typeof image.id !== "string" || !image.id || imageMap.has(image.id)) {
      throw new Error("备份中存在无效或重复的图片引用");
    }
    let restored;
    if (stagedImages) {
      restored = stagedImages.get(image.id);
      if (!restored || restored.name !== image.name ||
          restored.type !== image.type || restored.size !== image.size) {
        throw new Error("备份中的原图没有完整上传，或文件信息不匹配");
      }
    } else {
      restored = validateImage(image); // Legacy one-call restore gets a fresh ID.
    }
    imageMap.set(image.id, restored);
    if (!stagedImages) records.push(restored);
  }
  const usedImages = new Set();
  function refs(images) {
    if (!Array.isArray(images) || images.length > MAX_IMAGES) {
      throw new Error("备份任务的图片数量无效");
    }
    const seen = new Set();
    return images.map((image) => {
      if (typeof image?.id !== "string" || seen.has(image.id) || !imageMap.has(image.id)) {
        throw new Error("备份任务引用了缺失或重复的图片");
      }
      seen.add(image.id);
      usedImages.add(image.id);
      const record = imageMap.get(image.id);
      return { id: record.id, name: record.name, type: record.type,
        size: record.size, thumbnail: record.thumbnail };
    });
  }
  const scheduleIds = new Set();
  const scheduleMap = new Map();
  const schedules = source.schedules.map((old) => {
    if (!old || typeof old.id !== "string" || !old.id || scheduleIds.has(old.id)) {
      throw new Error("备份中存在重复或无效的自动规则");
    }
    scheduleIds.add(old.id);
    const images = refs(old.images);
    const text = requirePrompt(old.text, images.length > 0);
    const mode = old.mode;
    if (!["time", "count"].includes(mode)) throw new Error("备份中的自动规则类型无效");
    const intervalMinutes = mode === "time" ? requireIntervalMinutes(old.intervalMinutes) : null;
    const threshold = mode === "count" ? Number(old.threshold) : null;
    if (mode === "count" && (!Number.isInteger(threshold) || threshold < 1 ||
        threshold > maxPending)) throw new Error("备份的数量阈值超过当前队列容量");
    const restored = {
      id: id(), text, images, mode, intervalMinutes, threshold,
      repeatCount: requireRepeatCount(old.repeatCount), runCount: 0, enabled: false,
      nextRunAt: mode === "time" ? Date.now() + intervalMinutes * 60_000 : null,
      lastRunAt: null,
    };
    scheduleMap.set(old.id, restored.id);
    return restored;
  });
  const taskIds = new Set();
  const tasks = source.tasks.map((old) => {
    if (!old || typeof old.id !== "string" || !old.id || taskIds.has(old.id)) {
      throw new Error("备份中存在重复或无效的队列任务");
    }
    if (["handoff_summary","handoff_intro"].includes(old.kind)) {
      throw new Error("备份包含内部交接命令，不能作为普通任务恢复；请重新导出队列备份");
    }
    taskIds.add(old.id);
    const images = refs(old.images);
    const text = requirePrompt(old.text, images.length > 0);
    if (!["pending", "dispatching", "waiting", "steering",
          "steering_wait", "error", "interrupted"].includes(old.status)) {
      throw new Error("备份任务状态无效");
    }
    // A user may delete an automatic rule while its previously generated
    // pending tasks remain. Those ordinary tasks still need to be restorable.
    const task = newTask(text, old.sourceScheduleId
      ? scheduleMap.get(old.sourceScheduleId) || null : null, images);
    if (old.status !== "pending") {
      // Never automatically repeat a message that may have been sent.
      task.status = "error";
      task.error = "备份时此任务可能已发送或异常，必须人工核对，不自动重发";
    }
    return task;
  });
  if (tasks.filter((task) => task.status === "pending").length > maxPending) {
    throw new Error("备份里的待发送条目超过当前队列上限，请先调整队列容量");
  }
  if (usedImages.size !== imageMap.size) throw new Error("备份包含未被引用的图片记录");
  const rate = source.countRateLimit == null ? countRateLimit({})
    : requireCountRateLimit(source.countRateLimit);
  return { tasks, schedules, rate, images: records };
}

function applyConversationRestore(state, restored, senderTabId, url) {
  state.tasks = restored.tasks;
  state.schedules = restored.schedules;
  state.countRateLimit = restored.rate;
  state.countRateTimes = [];
  state.lastCountScheduleId = null;
  state.activeTaskId = null;
  state.steeringTaskId = null;
  state.queuePaused = true;
  state.halted = false;
  state.haltReason = null;
  state.error = "";
  state.autoOpenTab = false;
  state.tabId = senderTabId;
  state.url = url;
  state.history = [];
  recordHistory(state, "backup_restored");
}

function requireEmptyRestoreTarget(state, sender, url) {
  if (!targetMatches(state, sender, url)) throw new Error("只能恢复当前对话");
  if (state.tasks.length || state.schedules.length ||
      state.activeTaskId || state.steeringTaskId) {
    throw new Error("只能恢复到没有任务和自动规则的对话，避免覆盖正在运行的队列");
  }
}

function restoreStageFor(token, key, sender) {
  const stage = typeof token === "string" ? pendingBackupRestores.get(token) : null;
  if (!stage || stage.key !== key || stage.tabId !== sender.tab?.id ||
      Date.now() - stage.createdAt >= BACKUP_STAGE_TIMEOUT_MS) {
    throw new Error("备份恢复会话已失效或不属于当前标签，请重新选择文件");
  }
  return stage;
}

function requirePrompt(value, hasImages) {
  if (typeof value !== "string") throw new Error("提示词格式无效");
  if (hasImages && !value.trim()) return "";
  return requireText(value);
}

function imageReferences(store) {
  const ids = new Set();
  for (const favorite of favoritesOf(store)) {
    for (const image of favorite.images || []) ids.add(image.id);
  }
  for (const session of Object.values(store.conversations)) {
    for (const item of [...session.tasks, ...session.schedules]) {
      for (const image of item.images || []) ids.add(image.id);
    }
  }
  for (const cache of Object.values(store.handoffQueues || {})) {
    for (const item of [...(cache.schedules || []),...(cache.tasks || [])]) {
      for (const image of item.images || []) ids.add(image.id);
    }
  }
  if (store.legacyUnbound) {
    for (const item of [...store.legacyUnbound.tasks, ...store.legacyUnbound.schedules]) {
      for (const image of item.images || []) ids.add(image.id);
    }
  }
  // Pending restores are not committed to the queue yet. Protect staged
  // originals from orphan pruning caused by unrelated queue operations.
  for (const stage of pendingBackupRestores.values()) {
    for (const record of stage.received.values()) ids.add(record.id);
  }
  for (const stage of pendingFavoriteRestores.values()) {
    for (const record of stage.received.values()) ids.add(record.id);
  }
  return ids;
}

function cleanupUnusedImages(store) {
  return cqImageStore.prune(imageReferences(store))
    .catch((error) => console.error("[ChatQueue] 图片清理失败", error));
}

function validateImage(value) {
  if (!value || typeof value !== "object") throw new Error("图片数据无效");
  if (typeof value.dataUrl !== "string" || value.dataUrl.length > 11_200_000) {
    throw new Error("每张图片不得超过 8 MB");
  }
  const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([a-zA-Z0-9+/]+={0,2})$/.exec(value.dataUrl || "");
  if (!match) throw new Error("只支持 PNG、JPEG、WebP 或 GIF 图片");
  const encoded = match[2];
  const bytes = Math.floor(encoded.length * 3 / 4) - (encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0);
  if (bytes < 1 || bytes > MAX_IMAGE_BYTES) throw new Error("每张图片不得超过 8 MB");
  let header;
  try { header = atob(encoded.slice(0, 64)); }
  catch { throw new Error("图片编码损坏"); }
  const type = match[1];
  const validSignature = type === "image/png" ? header.startsWith("\x89PNG\r\n\x1a\n")
    : type === "image/jpeg" ? header.startsWith("\xff\xd8\xff")
    : type === "image/gif" ? /^GIF8[79]a/.test(header)
    : header.startsWith("RIFF") && header.slice(8, 12) === "WEBP";
  if (!validSignature) throw new Error("图片格式与实际内容不匹配");
  const thumbnail = String(value.thumbnail || "");
  if (!/^data:image\/jpeg;base64,[a-zA-Z0-9+/]+={0,2}$/.test(thumbnail) || thumbnail.length > 45000) {
    throw new Error("图片缩略图无效");
  }
  const name = String(value.name || "image").slice(0, 150);
  return { id: id(), dataUrl: value.dataUrl, name, type, size: bytes, thumbnail };
}

function verifyStoredImage(reference, record) {
  if (!reference || !record || record.id !== reference.id ||
      record.name !== reference.name || record.type !== reference.type ||
      record.size !== reference.size) {
    throw new Error("本地图像与队列引用不一致，已阻止发送或导出");
  }
  // IndexedDB can contain a damaged payload even when the old metadata still
  // matches. Verify the data URL signature, decoded size and thumbnail too.
  const checked = validateImage(record);
  if (checked.size !== reference.size || checked.type !== reference.type ||
      checked.name !== reference.name) {
    throw new Error("本地图片内容不完整，已阻止发送或导出");
  }
  return record;
}

async function attachImages(existing, keepIds, uploads, newlyStoredIds = null) {
  if (keepIds != null && !Array.isArray(keepIds)) throw new Error("图片引用无效");
  const keep = keepIds == null ? (existing || []) :
    (existing || []).filter((image) => keepIds.includes(image.id));
  if (keepIds != null && (keep.length !== keepIds.length ||
      new Set(keepIds).size !== keepIds.length)) {
    throw new Error("图片引用无效");
  }
  if (!Array.isArray(uploads) || keep.length + uploads.length > MAX_IMAGES) {
    throw new Error(`每条任务最多添加 ${MAX_IMAGES} 张图片`);
  }
  const records = uploads.map(validateImage);
  await cqImageStore.save(records);
  if (newlyStoredIds) newlyStoredIds.push(...records.map((item) => item.id));
  return [...keep, ...records.map(({ id, name, type, size, thumbnail }) =>
    ({ id, name, type, size, thumbnail }))];
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

function countRateLimit(state) {
  const config = state.countRateLimit;
  return {
    enabled: config?.enabled === true,
    windowMinutes: Number.isInteger(config?.windowMinutes) &&
      config.windowMinutes >= 1 && config.windowMinutes <= MAX_COUNT_WINDOW_MINUTES
      ? config.windowMinutes : DEFAULT_COUNT_WINDOW_MINUTES,
    maxAdds: Number.isInteger(config?.maxAdds) &&
      config.maxAdds >= 1 && config.maxAdds <= MAX_COUNT_WINDOW_ADDS
      ? config.maxAdds : DEFAULT_COUNT_WINDOW_MAX_ADDS,
  };
}

function requireCountRateLimit(message) {
  const windowMinutes = Number(message.windowMinutes);
  const maxAdds = Number(message.maxAdds);
  if (typeof message.enabled !== "boolean") throw new Error("请指定是否启用当前对话的自动补队限速");
  if (message.windowMinutes == null || message.windowMinutes === "" ||
      !Number.isInteger(windowMinutes) || windowMinutes < 1 ||
      windowMinutes > MAX_COUNT_WINDOW_MINUTES) {
    throw new Error(`限制时间必须为 1～${MAX_COUNT_WINDOW_MINUTES} 分钟的整数`);
  }
  if (message.maxAdds == null || message.maxAdds === "" ||
      !Number.isInteger(maxAdds) || maxAdds < 1 || maxAdds > MAX_COUNT_WINDOW_ADDS) {
    throw new Error(`每个时间窗口最多补入 1～${MAX_COUNT_WINDOW_ADDS} 条`);
  }
  return { enabled: message.enabled, windowMinutes, maxAdds };
}

function pruneCountRateHistory(state, now) {
  if (!Array.isArray(state.countRateTimes)) {
    if (state.countRateTimes == null) return false; // Legacy sessions have no history.
    state.countRateTimes = [];
    return true;
  }
  if (!state.countRateTimes.length) return false;
  const interval = countRateLimit(state).windowMinutes * 60_000;
  const history = state.countRateTimes.filter((time) =>
    Number.isFinite(time) && time > now - interval && time <= now);
  // Bound persistent history even if older data was malformed or a user
  // changed from a generous rule to a stricter one.
  history.sort((a, b) => a - b);
  const bounded = history.slice(-MAX_COUNT_WINDOW_ADDS);
  if (bounded.length === state.countRateTimes.length &&
      bounded.every((value, index) => value === state.countRateTimes[index])) return false;
  state.countRateTimes = bounded;
  return true;
}

function countRateStatus(state, now) {
  const config = countRateLimit(state);
  const windowStart = now - config.windowMinutes * 60_000;
  const usedTimes = (Array.isArray(state.countRateTimes) ? state.countRateTimes : [])
    .filter((value) => Number.isFinite(value) && value > windowStart && value <= now)
    .sort((a, b) => a - b);
  const used = usedTimes.length;
  return {
    ...config,
    used,
    remaining: config.enabled ? Math.max(0, config.maxAdds - used) : null,
    nextAvailableAt: config.enabled && used >= config.maxAdds
      ? usedTimes[used - config.maxAdds] + config.windowMinutes * 60_000 : null,
  };
}

function enqueueScheduledTask(state, schedule, now) {
  const task = newTask(schedule.text, schedule.id, schedule.images || []);
  state.tasks.push(task);
  recordHistory(state, schedule.mode === "count" ? "auto_count" : "auto_time", task.id, now);
  schedule.runCount = (schedule.runCount || 0) + 1;
  schedule.lastRunAt = now;
  const repeats = repeatLimit(schedule.repeatCount);
  if (repeats >= 0 && schedule.runCount >= repeats + 1) schedule.enabled = false;
}

function dueSchedules(state, now = Date.now(), maxPending = DEFAULT_PENDING_LIMIT) {
  if (state.parkedDraft) return false;
  // Scheduled rules move together with the queue; do not create more items
  // in a source conversation while its handoff is suspended or in transit.
  if (handoffBusy(state)) return false;
  // Both trigger modes ONLY enqueue ordinary tasks. The existing dispatcher
  // remains the sole owner of actual sending and response completion.
  let changed = pruneCountRateHistory(state, now);
  // When several time rules are overdue but the queue has only one free slot,
  // always visiting them in creation order starves the later rules forever.
  // Rotate from the last successfully served time rule; persist its ID in the
  // conversation just like the existing count-rule round-robin cursor.
  const timeRules = state.schedules.filter((schedule) => schedule.mode !== "count");
  const countRules = state.schedules.filter((schedule) => schedule.mode === "count");
  const lastTimeIndex = timeRules.findIndex((rule) => rule.id === state.lastTimeScheduleId);
  const timeStart = timeRules.length ? (lastTimeIndex + 1) % timeRules.length : 0;
  const rules = [
    ...timeRules.slice(timeStart), ...timeRules.slice(0, timeStart),
    ...countRules,
  ];
  for (const schedule of rules) {
    // Migrate an old one-time delayed tick into a queue item. This field is
    // never generated by the new scheduler; old 'false' values are discarded.
    const legacyDue = schedule.deferred === true && schedule.enabled;
    if (!legacyDue && "deferred" in schedule) {
      delete schedule.deferred;
      changed = true;
    }
    if (!schedule.enabled) continue;

    const byCount = schedule.mode === "count";
    const repeats = repeatLimit(schedule.repeatCount);
    if (repeats >= 0 && (schedule.runCount || 0) >= repeats + 1) {
      schedule.enabled = false;
      changed = true;
      continue;
    }
    // Count-based rules are handled below in a persisted rotating order.
    // Otherwise the first rule would monopolize the last free queue slot.
    if (byCount) continue;

    const period = schedule.intervalMinutes * 60_000;
    if (!Number.isFinite(period) || period <= 0) continue;
    const due = now >= schedule.nextRunAt;
    if (!due && !legacyDue) continue;
    if (pendingCount(state) >= maxPending) continue; // Retry when an item leaves the queue.

    // Time-based rules retain their independent due dates and missed-tick coalescing.
    enqueueScheduledTask(state, schedule, now);
    state.lastTimeScheduleId = schedule.id;
    if (legacyDue) delete schedule.deferred;
    if (due) {
      // Coalesce browser sleep/restart gaps into ONE occurrence, not a burst.
      const skipped = Math.floor((now - schedule.nextRunAt) / period) + 1;
      schedule.nextRunAt += skipped * period;
    }
    changed = true;
  }

  if (countRules.length) {
    // Keep the last served rule ID in the session so refreshes, worker restarts,
    // and a queue that only ever has one free slot all remain fair.
    const lastIndex = countRules.findIndex((rule) => rule.id === state.lastCountScheduleId);
    const start = (lastIndex + 1) % countRules.length;
    for (let step = 0; step < countRules.length; step++) {
      if (pendingCount(state) >= maxPending) break;
      if (countRateStatus(state, now).nextAvailableAt !== null) break;
      const rule = countRules[(start + step) % countRules.length];
      if (!rule.enabled || !Number.isInteger(rule.threshold) ||
          rule.threshold < 1 || rule.threshold > MAX_PENDING ||
          pendingCount(state) >= rule.threshold) continue;

      // At most one item per eligible rule per pulse. Each accepted item
      // advances the cursor, so the next free slot begins after that rule.
      enqueueScheduledTask(state, rule, now);
      state.lastCountScheduleId = rule.id;
      if (countRateLimit(state).enabled) {
        state.countRateTimes ||= [];
        state.countRateTimes.push(now);
      }
      changed = true;
    }
  }
  return changed;
}

function dispatchTimeoutBudget(task) {
  return ["handoff_summary","handoff_intro"].includes(task?.kind) &&
    !Number.isFinite(task.sendArmedAt) ? HANDOFF_PREPARE_TIMEOUT_MS : DISPATCH_TIMEOUT_MS;
}

function checkTimeout(state, now = Date.now()) {
  const active = state.tasks.find((task) => task.id === state.activeTaskId);
  if (!active) return false;
  const started = active.sentAt || active.sendArmedAt || active.claimedAt || now;
  const timeout = active.status === "waiting" ? WAIT_TIMEOUT_MS : dispatchTimeoutBudget(active);
  if (now - started <= timeout) return false;
  const wasWaiting = active.status === "waiting";
  active.status = "error";
  active.error = wasWaiting ? "等待回复超时；请人工检查后恢复。" :
    ["handoff_summary","handoff_intro"].includes(active.kind) && !Number.isFinite(active.sendArmedAt)
      ? "交接正文准备超时，已停止自动发送；请核对输入框和聊天记录后恢复。"
      : "发送确认超时，无法确认是否成功发送；请人工检查后恢复，不会自动重发。";
  state.activeTaskId = null;
  state.halted = true;
  state.haltReason = "timeout";
  state.haltAtUserCount = Number.isInteger(active.baselineUserCount)
    ? active.baselineUserCount + (wasWaiting ? 1 + (active.steerCount || 0) : 0)
    : null;
  state.error = active.error;
  recordHistory(state, "timeout", active.id, now);
  return true;
}

function releaseSteerReservation(state, task, now = Date.now()) {
  // Before Send is armed, a queue instruction may return to its old position;
  // a typed shortcut must remain a draft rather than becoming queued work.
  // Once native Stop was requested, the old turn is no completion evidence.
  if (Number.isFinite(task.steerPauseRequestedAt)) {
    const active = state.tasks.find((item) => item.id === state.activeTaskId &&
      item.id === task.steerActiveTaskId);
    if (active?.status === "waiting") {
      active.status = "interrupted";
      active.error = "引导已暂停原回复，但新指令未发送；请核对后手动继续，此任务不会自动重发。";
      state.activeTaskId = null;
      state.lastQueueSettledAt = now;
    }
    state.queuePaused = true;
    state.error = "引导未发送，已暂停自动队列；请核对原回复后手动继续。";
  }
  if (task.steerFromComposer === true) {
    // A failed Ctrl+Enter must never quietly become an ordinary queued send.
    // Keep a review record only if Stop has already affected the old reply.
    if (Number.isFinite(task.steerPauseRequestedAt)) {
      task.status = "error";
      task.error = "快捷引导未发送，指令已保留供核对；不会自动入队发送。";
    } else {
      state.tasks.splice(state.tasks.indexOf(task),1);
    }
    state.steeringTaskId = null;
    return;
  }
  task.status = "pending";
  delete task.steerPauseRequestedAt;
  delete task.steerPauseAssistantCount;
  delete task.steerPauseAssistantId;
  delete task.steerActiveTaskId;
  state.steeringTaskId = null;
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
    releaseSteerReservation(state, task, now);
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
    recordHistory(state, "steer_timeout", task.id, now);
    return true;
  }
  return false;
}

function checkInFlightIntegrity(state, now = Date.now()) {
  // Service workers and tabs may terminate between persisted state changes.
  // A dangling lock or an orphaned in-flight row must never let CLAIM start
  // another message while the earlier one might already have been sent.
  const active = state.tasks.find((task) => task.id === state.activeTaskId);
  const steering = state.tasks.find((task) => task.id === state.steeringTaskId);
  const plausibleTime = (value) => Number.isFinite(value) &&
    value > 0 && value <= now + 5 * 60_000;
  const activeValid = !state.activeTaskId ||
    (active && ["dispatching", "waiting"].includes(active.status) &&
      plausibleTime(active.status === "waiting" ? active.sentAt : active.claimedAt));
  const steeringValid = !state.steeringTaskId ||
    (steering && ["steering", "steering_wait"].includes(steering.status) &&
      plausibleTime(steering.status === "steering_wait" ?
        steering.steerClickedAt : steering.steerClaimedAt));
  const orphan = state.tasks.some((task) =>
    (["dispatching", "waiting"].includes(task.status) &&
      task.id !== state.activeTaskId) ||
    (["steering", "steering_wait"].includes(task.status) &&
      task.id !== state.steeringTaskId));
  if (activeValid && steeringValid && !orphan) return false;

  const oldActiveId = state.activeTaskId;
  const oldSteeringId = state.steeringTaskId;
  for (const task of state.tasks) {
    if (task.id !== oldActiveId && task.id !== oldSteeringId &&
        !["dispatching", "waiting", "steering", "steering_wait"].includes(task.status)) continue;
    if (!["error", "interrupted"].includes(task.status)) {
      task.status = "error";
      task.error = "异常重启后发送状态无法确认，已隔离；请核对聊天记录，不会自动重发。";
    }
  }
  state.activeTaskId = null;
  state.steeringTaskId = null;
  state.halted = true;
  // Preserve an explicit native Stop if one was already recorded.
  if (state.haltReason !== "user") state.haltReason = "state_inconsistent";
  state.error = "检测到不完整的发送/引导状态，已暂停自动发送；请核对后手动继续。";
  state.haltAtUserCount = null;
  recordHistory(state, "state_inconsistent", oldActiveId || oldSteeringId, now);
  return true;
}

async function reattachIfOldTabClosed(session, sender, url) {
  if (!session || session.key !== resolveKey(url, sender.tab?.id) || !sender.tab) return false;
  if (session.tabId === sender.tab.id) return false;
  // During handoff the owning tab legitimately shows the destination URL.
  // Opening the source in another tab must not steal that transaction owner.
  if (session.handoffSourceKey || ["queued","due","summarizing","opening","navigating",
      "bootstrapping","failed"].includes(session.handoff?.phase)) return false;
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
  if (key.startsWith("draft:") && message.type !== "HELLO" &&
      safeUrl(sender.tab?.url) && !sameDraftScope(url,sender.tab.url) &&
      Object.values(store.conversations).some(draft => draft.parkedDraft === true &&
        draft.tabId === tabId && sameDraftScope(draft.url,url))) {
    throw new Error("原接力页面已切换，已拒绝旧页面的迟到操作；当前项目队列不受影响");
  }
  let draftScopeChanged = false;
  let previousDraft = key.startsWith("draft:") ? store.conversations[key] : null;
  const projectVisitId = isProjectOverview(url) && typeof message.projectVisitId === "string" &&
    /^[a-zA-Z0-9_-]{1,100}$/.test(message.projectVisitId) ? message.projectVisitId : null;
  // A project homepage queue belongs only to this visit. A new visit may
  // discard unsent work, while a sent first turn remains available to adopt.
  if (previousDraft && projectVisitId && previousDraft.projectVisitId !== projectVisitId &&
      message.type === "HELLO" && canDiscardProjectDraft(previousDraft)) {
    delete store.conversations[key];
    previousDraft = null;
    draftScopeChanged = true;
  }
  if (key.startsWith("draft:") && message.type === "HELLO" &&
      safeUrl(sender.tab?.url) === url &&
      (previousDraft?.handoffSourceKey && !sameDraftScope(previousDraft.url,url) ||
       !previousDraft && Object.values(store.conversations).some(draft =>
         draft.parkedDraft === true && draft.tabId === tabId && sameDraftScope(draft.url,url)))) {
    draftScopeChanged = switchDraftScope(store,tabId,url) || draftScopeChanged;
    previousDraft = store.conversations[key] || null;
  }
  if (previousDraft && !sameDraftScope(previousDraft.url, url)) {
    if (hasConversationWork(previousDraft) || previousDraft.handoffSourceKey) {
      throw new Error("此标签页的新对话队列属于其他页面，请返回原页面处理，或另开标签页使用收藏");
    }
    previousDraft.url = url;
    draftScopeChanged = true;
  }
  let projectHandoffAttached = false;
  if (isProjectOverview(url)) {
    // Ordinary project starts use the same owned draft queue as a new chat.
    // An internal handoff must keep its isolated introduction-only gate.
    projectHandoffAttached = message.type === "HELLO" &&
      attachProjectHandoff(store, sender, url);
    if (activeProjectHandoffDraft(store, key, sender, url) &&
        !["HELLO","GET","CLAIM","SENT","FINISHED","FAIL","HANDOFF_SEND_READY",
          "RELEASE_CLAIM","SCHEDULE_PULSE","ACK_COMPLETION_VIEWED",
          "REPLY_COMPLETED","STOPPED","USER_RESUMED",
          "RECOVER_ON_VOICE","CANCEL_HANDOFF","DELETE_TASK","SKIP_FAILED","ACK_RECOVERY",
          "RETRY_UNSENT_HANDOFF"].includes(message.type)) {
      throw new Error("项目主页仅允许正在进行的内部上下文接力");
    }
  }
  const confirmingHandoff = message.type === "CONFIRM_HANDOFF";
  const adoptionSelection = chatKey(url) ? selectHandoffAdoption(store,sender,url,
    message.lastUserText,message.userCount,message.lastUserFolded === true,confirmingHandoff) : null;
  const adoptionObservation = adoptionSelection?.observation?.source
    ? {...adoptionSelection.observation,reason:adoptionSelection.reason} : null;
  let confirmPageCurrent = true;
  if (confirmingHandoff) {
    try { confirmPageCurrent = safeUrl((await chrome.tabs.get(tabId)).url) === url; }
    catch { confirmPageCurrent = false; }
  }
  const confirmAllowed = !confirmingHandoff || message.userCount === 1 && confirmPageCurrent;
  if (!confirmAllowed && adoptionObservation) adoptionObservation.reason =
    confirmPageCurrent ? "user_count_mismatch" : "owner_mismatch";
  const destinationNoted = confirmPageCurrent && ["HELLO","CONFIRM_HANDOFF"].includes(message.type) &&
    noteHandoffCreatedChat(store,sender,url);
  const adopted = confirmAllowed && adoptNewChat(store, sender, url,
    message.lastUserText, message.lastUserFolded === true,adoptionObservation,confirmingHandoff,message.userCount);
  // A recovery probe is not a reservation or permission to bind an unrelated
  // ordinary chat to a pending draft merely because the project matches.
  const pendingNewChat = !confirmingHandoff && !adopted &&
    pendingHandoffDraftForChat(store,sender,url);
  const effectiveKey = pendingNewChat?.key || key;
  let changed = adopted || destinationNoted ||
    projectHandoffAttached || draftScopeChanged;
  if (effectiveKey.startsWith("draft:") && !isProjectOverview(url) &&
      !pendingNewChat) {
    changed = attachProjectHandoff(store, sender, url) || changed;
  }
  const existing = store.conversations[effectiveKey];
  const state = sessionFor(store, effectiveKey, url, tabId);
  if (isProjectOverview(url) && !state.handoffSourceKey) {
    if (!projectVisitId) throw new Error("项目主页队列已更新，请刷新页面后使用");
    if (state.projectVisitId && state.projectVisitId !== projectVisitId) {
      throw new Error("上一轮新对话仍在发送，请先等待发送确认");
    }
    state.projectVisitId = projectVisitId;
  }
  if (["HELLO", "SCHEDULE_PULSE", "CLAIM"].includes(message.type)) {
    changed = checkInFlightIntegrity(state) || changed;
  }
  // This also repairs an old Queue 0 + permanently-red-warning state before
  // the scheduler is evaluated or the UI is returned on HELLO / GET.
  changed = recoverObsoleteHalt(state) || changed;
  changed = syncFailedHandoffDestination(store, state) || changed;
  let dispatch = null;
  let sendReady = false;
  let handoffPending = false;
  let retryReady = false;
  let cancelPending = null;
  let dispatchBlockedReason = null;
  let steerDeferred = false;
  let enqueuedTaskId = null;
  let imagePayload = null;
  let backupPayload = null;
  let restoreTokenCompleted = null;
  const requestTaskKind = state.tasks.find(task => task.id === message.id)?.kind;
  let imageHealth = null;
  const newImageIds = [];
  const maxPending = queueLimit(store);

  try {
  switch (message.type) {
    case "CONFIRM_HANDOFF": {
      const intro = state.tasks.find(task => task.id === state.activeTaskId &&
        task.kind === "handoff_intro" && ["dispatching","waiting"].includes(task.status));
      const source = store.conversations[state.handoffSourceKey];
      handoffPending = Boolean(message.userCount === 1 && confirmPageCurrent &&
        targetMatches(state,sender,url) && intro && source?.tabId === tabId &&
        source.handoff?.phase === "bootstrapping" && !source.handoff.cancelRequested &&
        !state.halted && !state.queuePaused && source.handoff.token &&
        source.handoff.token === state.handoffToken && source.handoff.destinationKey === state.key &&
        CQHandoff.projectId(source.url) === CQHandoff.projectId(url) &&
        CQHandoff.textMatch(intro.text,message.lastUserText).matches);
      break;
    }

    case "ACK_COMPLETION_VIEWED": {
      if (!targetMatches(state, sender, url)) break;
      if (state.unreadCompleted === true) {
        state.unreadCompleted = false;
        changed = true;
      }
      break;
    }

    case "REPLY_COMPLETED": {
      // Manual replies do not have a queue FINISHED action. The content
      // script only reports them after a new assistant turn + stable Voice
      // readiness. Never mark a running queue task ahead of its FINISHED.
      if (!targetMatches(state, sender, url) || message.viewed !== false ||
          state.activeTaskId || state.steeringTaskId || state.halted) break;
      if (state.unreadCompleted !== true) {
        state.unreadCompleted = true;
        changed = true;
      }
      break;
    }

    case "GET_BACKUP":
      if (!targetMatches(state, sender, url)) throw new Error("只能备份当前对话");
      backupPayload = await createConversationBackup(state);
      break;

    case "GET_BACKUP_META": {
      if (!targetMatches(state, sender, url)) throw new Error("只能备份当前对话");
      backupPayload = createBackupMetadata(state);
      const missing = await cqImageStore.missing(backupPayload.images.map((item) => item.id));
      if (missing.length) throw new Error("备份中有 " + missing.length + " 张原图缺失，未生成不完整的文件");
      break;
    }

    case "GET_BACKUP_IMAGE": {
      if (!targetMatches(state, sender, url)) throw new Error("只能读取当前对话的备份图片");
      const reference = [...state.tasks, ...state.schedules]
        .flatMap((item) => item.images || [])
        .find((image) => image.id === message.imageId);
      if (!reference) throw new Error("备份图片不属于当前对话");
      const [record] = await cqImageStore.load([reference.id]);
      verifyStoredImage(reference, record);
      imagePayload = [{
        ...record,
        sha256: await imageSha256(record.dataUrl),
      }];
      break;
    }

    case "RESTORE_BACKUP_BEGIN": {
      requireEmptyRestoreTarget(state, sender, url);
      if (JSON.stringify(message.backup || {}).length > MAX_BACKUP_BYTES) {
        throw new Error("备份清单过大，拒绝恢复");
      }
      const expected = validateBackupManifest(message.backup, key);
      // Reject malformed task/rule structure before uploading a single byte.
      // Placeholder images are used only for validating references and limits;
      // real restored IDs/metadata are created after every upload succeeds.
      const placeholders = new Map([...expected].map(([imageId, ref]) => [
        imageId, { id: id(), name: ref.name, type: ref.type,
          size: ref.size, thumbnail: "" },
      ]));
      prepareConversationRestore(message.backup, key, maxPending, placeholders);
      // A new attempt supersedes an abandoned upload from this very tab.
      for (const [previousToken, previous] of pendingBackupRestores) {
        if (previous.key !== key || previous.tabId !== tabId) continue;
        pendingBackupRestores.delete(previousToken);
        await cqImageStore.remove([...previous.received.values()].map((item) => item.id));
      }
      const token = id();
      pendingBackupRestores.set(token, {
        key, tabId, createdAt: Date.now(),
        metadata: message.backup, expected, received: new Map(),
        encodedBytes: JSON.stringify(message.backup).length,
      });
      backupPayload = { token };
      break;
    }

    case "RESTORE_BACKUP_IMAGE": {
      requireEmptyRestoreTarget(state, sender, url);
      const stage = restoreStageFor(message.token, key, sender);
      const image = message.image;
      const ref = typeof image?.id === "string" ? stage.expected.get(image.id) : null;
      if (!ref || stage.received.has(image.id)) {
        throw new Error("备份恢复包含未声明或重复上传的图片");
      }
      const record = validateImage(image);
      if (record.name !== ref.name || record.type !== ref.type ||
          record.size !== ref.size) {
        throw new Error("恢复的原图内容与备份清单不一致，未写入");
      }
      if (ref.sha256 && await imageSha256(record.dataUrl) !== ref.sha256) {
        throw new Error("备份图片 SHA-256 完整性校验失败，未写入损坏原图");
      }
      const addedBytes = JSON.stringify(image).length;
      if (stage.encodedBytes + addedBytes > MAX_BACKUP_BYTES) {
        throw new Error("备份总大小超过 60 MB，拒绝继续恢复");
      }
      await cqImageStore.save([record]);
      stage.received.set(image.id, record);
      stage.encodedBytes += addedBytes;
      break;
    }

    case "RESTORE_BACKUP_FINISH": {
      requireEmptyRestoreTarget(state, sender, url);
      const stage = restoreStageFor(message.token, key, sender);
      if (stage.received.size !== stage.expected.size) {
        throw new Error("备份原图尚未全部恢复，拒绝提交队列");
      }
      const missing = await cqImageStore.missing(
        [...stage.received.values()].map((record) => record.id));
      if (missing.length) throw new Error("暂存图片已丢失，拒绝恢复队列");
      const restored = prepareConversationRestore(stage.metadata, key, maxPending, stage.received);
      applyConversationRestore(state, restored, tabId, url);
      restoreTokenCompleted = message.token;
      changed = true;
      break;
    }

    case "RESTORE_BACKUP_ABORT": {
      const stage = pendingBackupRestores.get(message.token);
      if (!stage) break;
      if (!targetMatches(state, sender, url) ||
          stage.key !== key || stage.tabId !== tabId) {
        throw new Error("不能取消其他对话的备份恢复");
      }
      pendingBackupRestores.delete(message.token);
      await cqImageStore.remove([...stage.received.values()].map((item) => item.id));
      break;
    }

    case "CHECK_QUEUE_IMAGES": {
      if (!targetMatches(state, sender, url)) throw new Error("只能检查当前对话的图片");
      const taskIds = new Set(state.tasks.flatMap((item) =>
        (item.images || []).map((image) => image.id)));
      const scheduleIds = new Set(state.schedules.flatMap((item) =>
        (item.images || []).map((image) => image.id)));
      const references = [...new Set([...taskIds, ...scheduleIds])];
      const missing = await cqImageStore.missing(references);
      const missingSet = new Set(missing);
      imageHealth = {
        total: references.length,
        missing: missing.length,
        affectedTasks: state.tasks.filter((item) =>
          (item.images || []).some((image) => missingSet.has(image.id))).length,
        affectedRules: state.schedules.filter((item) =>
          (item.images || []).some((image) => missingSet.has(image.id))).length,
      };
      break;
    }

    case "RESTORE_BACKUP": {
      requireEmptyRestoreTarget(state, sender, url);
      const restored = prepareConversationRestore(message.backup, key, maxPending);
      await cqImageStore.save(restored.images);
      newImageIds.push(...restored.images.map((item) => item.id));
      applyConversationRestore(state, restored, tabId, url);
      changed = true;
      break;
    }

    case "CLEAR_HISTORY":
      if (!targetMatches(state, sender, url)) throw new Error("只能清理当前对话日志");
      state.history = [];
      changed = true;
      break;

    case "HELLO":
      if (existing && await reattachIfOldTabClosed(state, sender, message.url)) changed = true;
      if (existing && state.halted && state.haltAtUserCount == null &&
          Number.isInteger(message.userCount)) {
        state.haltAtUserCount = message.userCount;
        changed = true;
      }
      if (chatKey(url) && targetMatches(state, sender, url) &&
          (message.userCount > 0 || state.history?.length ||
           state.tasks.length || state.schedules.length)) {
        changed = recordConversationFirstSeen(state) || changed;
      }
      break;

    case "OBSERVE_FIRST_MESSAGE_AT":
      if (!chatKey(url) || !targetMatches(state, sender, url)) {
        throw new Error("只能记录当前已建立对话的消息时间");
      }
      if (!plausibleConversationTime(message.firstMessageAt)) {
        throw new Error("消息时间无效，未修改对话记录");
      }
      changed = recordConversationFirstSeen(state) || changed;
      // Keep the earliest genuine timestamp even if the page later virtualizes
      // old turns. No repeated writes once that date has been recorded.
      if (!plausibleConversationTime(state.firstMessageAt) ||
          message.firstMessageAt < state.firstMessageAt) {
        state.firstMessageAt = message.firstMessageAt;
        changed = true;
      }
      break;

    case "SCHEDULE_PULSE":
      // An open ChatGPT tab can tick precisely when the countdown reaches zero.
      // The minute alarm below is still the fallback for hidden/closed tabs.
      break;

    case "SET_HANDOFF": {
      if (!targetMatches(state, sender, url)) throw new Error("只能修改本对话的接力设置");
      if (typeof message.enabled !== "boolean") throw new Error("接力开关参数无效");
      const minutes = CQHandoff.requireMinutes(message.intervalMinutes);
      const repeatCount = CQHandoff.requireRepeatCount(message.repeatCount ?? -1);
      if (message.enabled && (!chatKey(url) || !CQHandoff.projectId(url))) {
        throw new Error("仅支持 ChatGPT 原生项目内的已建立对话；请先在项目内打开一个聊天");
      }
      const handoff = handoffState(state);
      if (!["idle","queued","completed"].includes(handoff.phase)) {
        throw new Error("接力正在进行或需要人工恢复，请先处理当前交接");
      }
      if (!message.enabled && handoff.phase === "queued") {
        state.tasks = state.tasks.filter((task) => !(task.kind === "handoff_summary" &&
          task.status === "pending" && task.handoffTrigger === "automatic"));
      }
      const queued = state.tasks.find((task) =>
        task.kind === "handoff_summary" && task.status === "pending");
      if (!queued) removeHandoffQueue(store,state);
      state.handoff = {
        enabled:message.enabled,intervalMinutes:minutes,
        repeatCount,remainingCount:repeatCount,
        nextAt:message.enabled && !queued ? Date.now() + minutes * 60_000 : null,
        phase:queued ? "queued" : "idle",
        ...(queued ? {trigger:queued.handoffTrigger,
          manualRequested:queued.handoffTrigger === "manual",changedAt:handoff.changedAt,
          queueId:handoff.queueId,token:handoff.token} : {}),
        ...(handoff.topicTitle ? {topicTitle:handoff.topicTitle} : {}),
      };
      recordHistory(state, "handoff_setting");
      changed = true;
      break;
    }

    case "HANDOFF_NOW": {
      if (!targetMatches(state, sender, url) || !chatKey(url) ||
          !CQHandoff.projectId(url)) {
        throw new Error("只能在 ChatGPT 原生项目里的已建立对话中添加交接命令");
      }
      if (state.handoffSourceKey) throw new Error("新对话正在接收交接，不能重复创建接力");
      const handoff = handoffState(state);
      if (["queued","due"].includes(handoff.phase)) break; // Double click is idempotent.
      if (!["idle","completed"].includes(handoff.phase)) {
        throw new Error("已有接力正在进行或等待人工处理，不能重复启动");
      }
      handoff.topicTitle = CQHandoff.topicTitle(sender.tab?.title) ||
        CQHandoff.topicTitle(handoff.topicTitle);
      changed = enqueueHandoff(store,state,"manual") || changed;
      break;
    }

    case "CANCEL_HANDOFF": {
      if (!targetMatches(state,sender,url) && !pendingNewChat) {
        throw new Error("只能取消当前页面所属的接力");
      }
      cancelPending = cancelHandoffTransaction(store,state,message);
      changed = true;
      break;
    }
    case "RETRY_UNSENT_HANDOFF": {
      const source = store.conversations[state.handoffSourceKey];
      const handoff = source?.handoff;
      const task = state.tasks.find(item => item.id === message.id);
      const cache = handoffQueueFor(store,source,state);
      const liveTab = await chrome.tabs.get(tabId);
      if (!targetMatches(state,sender,url) || !isProjectOverview(url) ||
          safeUrl(liveTab.url) !== url || liveTab.discarded === true ||
          message.userRequested !== true || message.nativeBusy !== false || message.userCount !== 0 ||
          state.queuePaused || state.haltReason === "user" || state.activeTaskId || state.steeringTaskId ||
          !source || source.tabId !== tabId || source.halted || source.activeTaskId || source.steeringTaskId ||
          !["failed","bootstrapping"].includes(handoff?.phase) || handoff.cancelRequested ||
          !cache || cache.observedChatKey || cache.confirmedChatKey ||
          !task || state.tasks.length !== 1 || task.kind !== "handoff_intro" || task.status !== "pending" ||
          task.handoffQueueId !== cache.queueId || task.images?.length ||
          task.sentAt != null || task.sendArmedAt != null) {
        throw new Error("无法确认交接尚未发送，未替换草稿；请核对日志或取消本轮接力");
      }
      // Explicit retry of a never-armed introduction preserves this exact
      // transaction and its cached work. Already-clicked/uncertain sends can
      // never become pending through this action.
      handoff.phase = "bootstrapping";
      handoff.changedAt = Date.now();
      delete handoff.error;
      delete task.claimedAt;
      delete task.retryNotBefore;
      delete task.error;
      state.handoff = CQHandoff.defaults();
      clearCancelledHandoffHalt(state);
      recordHistory(source,"handoff_retry",task.id);
      recordHistory(state,"handoff_retry",task.id);
      retryReady = true;
      changed = true;
      break;
    }
    case "HANDOFF_NAVIGATE": {
      if (!targetMatches(state, sender, url) || state.handoff?.phase !== "opening") {
        throw new Error("交接导航尚未准备好");
      }
      const handoff = state.handoff;
      const projectId = CQHandoff.projectId(url);
      if (!projectId || projectId !== CQHandoff.normalizeProjectId(handoff.projectId) ||
          projectId !== CQHandoff.projectId(handoff.projectUrl)) {
        throw new Error("无法确认当前项目，已停止自动切换");
      }
      if (Number.isInteger(handoff.sourceUserCount) &&
          handoff.sourceUserCount !== message.userCount) {
        failHandoff(state,"总结之后发现新的用户消息，交接记录已过期；请重新总结以避免丢失上下文");
        changed = true;
        break;
      }
      // ChatGPT uses a canonical /project link even if the current /c/ URL
      // includes a human-readable slug; repair old staged handoffs as well.
      handoff.projectId = projectId;
      handoff.projectUrl = CQHandoff.projectStart(url);
      if (!handoffQueueFor(store,state)) throw new Error("本轮接力缓存缺失或不匹配，已停止导航");
      checkpointHandoffQueue(store,state,false);
      handoff.phase = "navigating";
      handoff.changedAt = Date.now();
      changed = true;
      break;
    }

    case "RECOVER_ON_VOICE": {
      // A failed destination is still tied to its original queue. Normal
      // recovery would erase the visible error without completing transfer.
      if (state.handoffSourceKey && state.handoff?.phase === "failed") break;
      // The page owns the Voice Mode readiness observation. Verify the same
      // evidence as FINISHED and the exact tab/chat binding before resuming.
      if (!targetMatches(state, sender, url) ||
          message.voiceReady !== true || message.editorEmpty !== true ||
          message.busy !== false || !Number.isFinite(message.voiceStableMs) ||
          message.voiceStableMs < 1700) break;
      if (resumeTechnicalHalt(state)) {
        // The preceding send may have happened. Restart the spacing window
        // conservatively instead of sending the next queued turn immediately.
        state.lastQueueSettledAt = Date.now();
        changed = true;
      }
      break;
    }

    case "ENQUEUE": {
      const requestId = requireSubmissionId(message.requestId);
      const fingerprint = await submissionFingerprint(message.type, message, requestId);
      if (submittedRecently(state, requestId, fingerprint)) break;
      if (pendingCount(state) >= maxPending) throw new Error(`待执行队列最多 ${maxPending} 条`);
      requirePrompt(message.text, Boolean(message.images?.length));
      const images = await attachImages([], null, message.images || [], newImageIds);
      const text = requirePrompt(message.text, images.length > 0);
      if (existing) changed = await reattachIfOldTabClosed(state, sender, url) || changed;
      if (!state.url) state.url = url;
      if (state.tabId == null) state.tabId = tabId;
      // Do not automatically resume a conversation explicitly stopped by user.
      const queued = newTask(text, null, images);
      state.tasks.push(queued);
      enqueuedTaskId = queued.id;
      if (message.priority === true) reorderPendingTasks(state, queued.id);
      markSubmission(state, requestId, fingerprint);
      changed = true;
      break;
    }

    case "ENQUEUE_FAVORITE": {
      if (await favoriteSenderKind(message, sender) !== "chat") {
        throw new Error("只能从 ChatGPT 对话把收藏加入队列");
      }
      const favorite = favoritesOf(store).find((item) => item.id === message.favoriteId);
      if (!favorite) throw new Error("收藏已不存在，请重新打开收藏夹");
      const images = (favorite.images || []).map((image) => ({...image}));
      if (favorite.templateEnabled !== true && message.templateValues !== undefined) {
        throw new Error("该收藏未启用变量模板模式，不能传入模板参数");
      }
      const expandedText = favorite.templateEnabled === true
        ? resolveFavoriteTemplate(favorite.text,message.templateValues) : favorite.text;
      const text = requirePrompt(expandedText, images.length > 0);
      const requestId = requireSubmissionId(message.requestId);
      const fingerprint = await submissionFingerprint(message.type, {
        favoriteId:favorite.id, text,
        imageRefs:(favorite.images || []).map((image) => image.id),
      }, requestId);
      if (submittedRecently(state, requestId, fingerprint)) break;
      if (pendingCount(state) >= maxPending) throw new Error(`待执行队列最多 ${maxPending} 条`);
      if (images.length) {
        const records = await cqImageStore.load(images.map((image) => image.id));
        images.forEach((image, index) => verifyStoredImage(image, records[index]));
      }
      if (existing) changed = await reattachIfOldTabClosed(state, sender, url) || changed;
      if (!state.url) state.url = url;
      if (state.tabId == null) state.tabId = tabId;
      state.tasks.push(newTask(text, null, images));
      markSubmission(state, requestId, fingerprint);
      // Count accepted queue submissions, not UI clicks, retries, or actual
      // delivery attempts. Never increment when the queue is full.
      favorite.useCount = Math.min(1_000_000, Math.max(0,Number(favorite.useCount)||0) + 1);
      favorite.lastUsedAt = Date.now();
      changed = true;
      break;
    }

    case "ADD_TASK": {
      const requestId = requireSubmissionId(message.requestId);
      const fingerprint = await submissionFingerprint(message.type, message, requestId);
      if (submittedRecently(state, requestId, fingerprint)) break;
      if (pendingCount(state) >= maxPending) throw new Error(`待执行队列最多 ${maxPending} 条`);
      requirePrompt(message.text, Boolean(message.images?.length));
      if (message.remoteJobId) {
        if (!requestId || message.remoteJobId !== requestId)
          throw new Error("远程任务提交标识不一致");
        if (existing && !targetMatches(state,sender,url)) {
          // New remote queue work runs in its own background tab. Transfer
          // ownership only at a safe boundary: never steal an in-flight turn.
          const liveTab=await chrome.tabs.get(tabId);
          if (!chatKey(url) || chatKey(state.url)!==chatKey(url) ||
              safeUrl(liveTab.url)!==url || state.activeTaskId ||
              state.steeringTaskId || state.halted || state.queuePaused ||
              handoffBusy(state) || state.handoffSourceKey) {
            throw new Error("目标旧对话正在执行、暂停或交接；等待安全空闲后再由新标签发送");
          }
          state.tabId=tabId;
          state.url=url;
        }
      }
      const images = await attachImages([], null, message.images || [], newImageIds);
      if (!state.url) state.url = url;
      if (state.tabId == null) state.tabId = tabId;
      const task = newTask(requirePrompt(message.text, images.length > 0), null, images);
      // Stable local-bridge id enables uncertain-reply reconciliation.
      if (message.remoteJobId) {
        task.remoteJobId = requestId;
      }
      state.tasks.push(task);
      markSubmission(state, requestId, fingerprint);
      changed = true;
      break;
    }

    case "EDIT_TASK": {
      const task = state.tasks.find((item) => item.id === message.id);
      if (!task || task.status !== "pending") throw new Error("只能编辑未发送任务");
      if (["handoff_summary","handoff_intro"].includes(task.kind)) {
        throw new Error("交接命令不能编辑，请使用接力设置或取消交接");
      }
      requirePrompt(message.text, Boolean((message.keepImageIds ?? task.images)?.length || message.images?.length));
      const images = await attachImages(task.images, message.keepImageIds, message.images || [], newImageIds);
      task.text = requirePrompt(message.text, images.length > 0);
      task.images = images;
      changed = true;
      break;
    }

    case "PIN_TASK":
    case "REORDER_TASK": {
      if (!targetMatches(state, sender, url)) {
        throw new Error("只能调整当前对话的队列");
      }
      const targetId = message.type === "PIN_TASK" ? null : message.targetId;
      if (message.type === "REORDER_TASK" && typeof targetId !== "string") {
        throw new Error("拖动目标任务无效");
      }
      changed = reorderPendingTasks(state, message.id, targetId, message.position) || changed;
      break;
    }

    case "DELETE_TASK": {
      const idx = state.tasks.findIndex((task) => task.id === message.id);
      if (idx < 0) break;
      if (["handoff_summary","handoff_intro"].includes(state.tasks[idx].kind)) {
        if (!targetMatches(state,sender,url) && !pendingNewChat) throw new Error("只能删除当前页面的接力任务");
        cancelPending = cancelHandoffTransaction(store,state,message);
        changed = true;
        break;
      }
      if (state.tasks[idx].id === state.activeTaskId ||
          state.tasks[idx].id === state.steeringTaskId) {
        throw new Error("正在发送的任务不能删除，请等确认后再操作");
      }
      state.tasks.splice(idx, 1);
      changed = true;
      break;
    }

    case "DISMISS_WAITING": {
      if (!targetMatches(state, sender, url)) {
        throw new Error("只能移除当前对话正在等待的任务");
      }
      if (message.userRequested !== true || message.nativeBusy !== false) {
        throw new Error("请在回复停止生成后，手动移除等待任务");
      }
      const index = state.tasks.findIndex((task) => task.id === message.id);
      const task = state.tasks[index];
      if (!task || task.id !== state.activeTaskId || task.status !== "waiting" ||
          state.steeringTaskId || VOICE_RECOVERABLE_HALTS.has(state.haltReason) ||
          state.haltReason === "state_inconsistent") {
        throw new Error("只能移除已发送且正在等待的普通任务，请先核对发送状态");
      }
      if (["handoff_summary","handoff_intro"].includes(task.kind) || state.handoffSourceKey) {
        throw new Error("上下文接力任务不能直接移除，请先处理当前接力");
      }
      // This is an explicit dismissal, not successful reply completion. Keep
      // pause/error/unread flags and never return the sent row to pending.
      state.tasks.splice(index, 1);
      state.activeTaskId = null;
      state.lastQueueSettledAt = Date.now();
      changed = true;
      break;
    }

    case "REMOTE_STEER_CLAIM":
    case "STEER_PROMPT_CLAIM":
    case "STEER_CLAIM": {
      if (!targetMatches(state, sender, url) || state.halted || handoffBusy(state)) {
        throw new Error("当前对话不可即时发送，请先返回原对话或核对暂停状态");
      }
      if (state.steeringTaskId) {
        throw new Error("已有消息正在发送，请稍后再引导");
      }
      const fromRemote = message.type === "REMOTE_STEER_CLAIM";
      const fromComposer = message.type === "STEER_PROMPT_CLAIM";
      if (fromComposer && (safeUrl(sender.tab?.url) && safeUrl(sender.tab.url) !== url ||
          message.images?.length)) throw new Error("原生草稿或页面已变化，未创建引导任务");
      if ((fromComposer || fromRemote) && pendingCount(state) >= maxPending)
        throw new Error("队列已满，请先处理现有任务再引导");
      let remoteRequestId=null,remoteFingerprint=null;
      if (fromRemote) {
        if (safeUrl(sender.tab?.url) !== url) throw new Error("远程引导目标页面已切换");
        remoteRequestId=requireSubmissionId(message.requestId);
        if (!remoteRequestId) throw new Error("远程引导需要唯一提交标识");
        remoteFingerprint=await submissionFingerprint(message.type,message,remoteRequestId);
        if (submittedRecently(state,remoteRequestId,remoteFingerprint))
          throw new Error("远程引导已经创建过；未重试以避免重复发送");
      }
      const task = fromComposer || fromRemote ? newTask(requireText(message.text)) :
        state.tasks.find((item) => item.id === message.id);
      if (!task || task.status !== "pending") throw new Error("只能引导待发送的队列任务");
      if (["handoff_summary","handoff_intro"].includes(task.kind)) {
        throw new Error("交接命令需要按队列顺序执行，不能即时引导发送");
      }
      if (task.images?.length) throw new Error("图片任务只能按普通队列发送，暂不支持引导");
      const active = state.tasks.find((item) => item.id === state.activeTaskId);
      if (state.activeTaskId && active?.status !== "waiting") {
        throw new Error("上一条任务正在发送，请稍后再引导");
      }
      if (active && ["handoff_summary","handoff_intro"].includes(active.kind)) {
        throw new Error("正在交接上下文，请等待交接完成后再引导");
      }
      if (fromComposer || fromRemote) {
        task.steerFromComposer = true;
        if (fromRemote) {
          task.remoteJobId=remoteRequestId;
          markSubmission(state,remoteRequestId,remoteFingerprint);
        }
        state.tasks.push(task);
      }
      // Reserve first, then try native steering or stop/send only as fallback.
      // Keep the original turn waiting until the continued reply
      // completes; the transient idle surface after Stop must not finish it.
      task.status = "steering";
      task.steerClaimedAt = Date.now();
      task.steerActiveTaskId = active?.id || null;
      delete task.steerPauseRequestedAt;
      delete task.steerPauseAssistantCount;
      delete task.steerPauseAssistantId;
      task.steerBaselineUserCount = Number.isInteger(message.userCount) ? message.userCount : 0;
      task.steerBaselineUserId = typeof message.lastUserId === "string" ? message.lastUserId : null;
      state.steeringTaskId = task.id;
      dispatch = { id: task.id, text: task.text,
        needsPause: Boolean(active || message.busy === true) };
      changed = true;
      break;
    }

    case "STEER_PAUSING": {
      if (!targetMatches(state, sender, url) || state.halted || handoffBusy(state)) {
        throw new Error("当前对话已暂停或正在交接，不能暂停回复进行引导");
      }
      const task = state.tasks.find((item) => item.id === message.id &&
        item.id === state.steeringTaskId);
      if (!task || task.status !== "steering") throw new Error("引导任务未被锁定，不能暂停回复");
      // Persist BEFORE native Stop so a crash cannot mistake its idle result
      // for completion of the original queued task.
      task.steerPauseRequestedAt = Date.now();
      task.steerPauseAssistantCount = Number.isInteger(message.assistantCount) &&
        message.assistantCount >= 0 ? message.assistantCount : null;
      task.steerPauseAssistantId = typeof message.lastAssistantId === "string" &&
        message.lastAssistantId.length <= 1024 ? message.lastAssistantId : null;
      changed = true;
      break;
    }

    case "STEER_CANCEL": {
      if (!targetMatches(state, sender, url)) break;
      const task = state.tasks.find((item) => item.id === message.id &&
        item.id === state.steeringTaskId);
      if (!task || task.status !== "steering") break;
      // No native Send click took place. Restore a queue row's order, or
      // release a typed shortcut without turning it into a pending send.
      releaseSteerReservation(state, task);
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
      if (Number.isFinite(task.steerPauseRequestedAt) && message.continuationObserved !== true) {
        throw new Error("引导消息已发送，尚未观察到新回复继续生成，请继续等待");
      }
      const active = state.tasks.find((item) => item.id === state.activeTaskId);
      if (active?.status === "waiting") {
        active.steerCount = (active.steerCount || 0) + 1;
        active.lastSteerText = task.text;
        active.lastSteerAt = Date.now();
      }
      // Only an observed native user turn may mark a remote steer delivered.
      // An idempotent claim or canceled reservation is never success evidence.
      if (typeof task.remoteJobId === "string") {
        const previous = Array.isArray(state.remoteSteerConfirmedIds)
          ? state.remoteSteerConfirmedIds : [];
        state.remoteSteerConfirmedIds = [...previous.filter(id => id !== task.remoteJobId),
          task.remoteJobId].slice(-60);
      }
      // Exactly once: remove the steered item so the ordinary queue cannot
      // send it a second time, regardless of which pending index it occupied.
      state.tasks.splice(state.tasks.indexOf(task), 1);
      state.steeringTaskId = null;
      state.lastQueueSettledAt = Date.now();
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
      const requestId = message.type === "ADD_SCHEDULE"
        ? requireSubmissionId(message.requestId) : null;
      const fingerprint = await submissionFingerprint(message.type, message, requestId);
      if (submittedRecently(state, requestId, fingerprint)) break;
      const mode = message.mode ?? "time";
      if (!["time", "count"].includes(mode)) throw new Error("无效的触发模式");
      const intervalMinutes = mode === "time" ? requireIntervalMinutes(
        message.type === "ADD_SCHEDULE" && message.intervalMinutes == null
          ? defaultIntervalMinutes(store) : message.intervalMinutes
      ) : null;
      const threshold = mode === "count" ? Number(message.threshold) : null;
      const repeatCount = message.type === "ADD_SCHEDULE" && message.repeatCount == null
        ? defaultRepeatCount(store) : requireRepeatCount(message.repeatCount);
      if (mode === "count" &&
          (message.threshold === "" || !Number.isInteger(threshold) || threshold < 1 || threshold > maxPending)) {
        throw new Error(`数量阈值必须为 1～${maxPending} 的整数，且不能超过队列上限`);
      }
      if (message.type === "EDIT_SCHEDULE") {
        const item = state.schedules.find((s) => s.id === message.id);
        if (!item) throw new Error("定时任务不存在");
        requirePrompt(message.text, Boolean((message.keepImageIds ?? item.images)?.length || message.images?.length));
        const images = await attachImages(item.images, message.keepImageIds, message.images || [], newImageIds);
        const text = requirePrompt(message.text, images.length > 0);
        Object.assign(item, {
          text, images, mode, intervalMinutes, threshold, repeatCount, runCount: 0, lastRunAt: null,
          nextRunAt: mode === "time" ? Date.now() + intervalMinutes * 60_000 : null,
        });
        delete item.deferred;
      } else {
        requirePrompt(message.text, Boolean(message.images?.length));
        const images = await attachImages([], null, message.images || [], newImageIds);
        const text = requirePrompt(message.text, images.length > 0);
        if (!state.url) state.url = url;
        if (state.tabId == null) state.tabId = tabId;
        state.schedules.push({
          id: id(), text, images, mode, intervalMinutes, threshold, repeatCount, runCount: 0, enabled: true,
          nextRunAt: mode === "time" ? Date.now() + intervalMinutes * 60_000 : null,
          lastRunAt: null,
        });
        markSubmission(state, requestId, fingerprint);
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
        item.nextRunAt = item.mode === "count" ? null : Date.now() + item.intervalMinutes * 60_000;
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

    case "SAVE_COUNT_RATE_LIMIT":
      if (!targetMatches(state, sender, url)) {
        throw new Error("只能修改当前对话的自动补队限速");
      }
      state.countRateLimit = requireCountRateLimit(message);
      changed = true;
      break;

    case "SAVE_SEND_COOLDOWN": {
      if (!targetMatches(state, sender, url)) {
        throw new Error("只能修改当前对话的发送冷却时间");
      }
      const seconds = requireSendCooldownSeconds(message.seconds);
      if (state.sendCooldownSeconds !== seconds) {
        state.sendCooldownSeconds = seconds;
        changed = true;
      }
      break;
    }

    case "SAVE_SETTINGS":
      // Validate all inputs before changing anything; old callers may omit
      // the new fields, in which case their saved defaults are preserved.
      store.settings = {
        ...store.settings,
        maxPending: requireQueueLimit(message.maxPending),
        defaultIntervalMinutes: Object.hasOwn(message, "defaultIntervalMinutes")
          ? requireIntervalMinutes(message.defaultIntervalMinutes)
          : defaultIntervalMinutes(store),
        defaultRepeatCount: Object.hasOwn(message, "defaultRepeatCount")
          ? requireDefaultRepeatCount(message.defaultRepeatCount)
          : defaultRepeatCount(store),
      };
      changed = true;
      break;

    case "SAVE_QUEUE_HEIGHT":
      store.settings = {
        ...store.settings,
        queueListHeight: requireQueueListHeight(message.height),
      };
      changed = true;
      break;

    case "PROTECT_BACKGROUND":
      if (typeof message.enabled !== "boolean") throw new Error("后台保护开关无效");
      store.settings = { ...store.settings, protectBackground: message.enabled };
      changed = true;
      break;

    case "SET_QUEUE_PAUSED":
      if (!targetMatches(state, sender, url)) throw new Error("只能暂停当前对话的自动发送");
      if (typeof message.paused !== "boolean") throw new Error("暂停参数必须是布尔值");
      if (!message.paused && state.halted) {
        // "Continue" is an explicit user action. It may clear a native Stop,
        // but must never bypass an uncertain delivery or crash-safety hold.
        if (state.haltReason !== "user") {
          throw new Error("当前对话存在待核对的发送异常，请先核对后继续，不能直接恢复自动发送");
        }
        if (state.activeTaskId || state.steeringTaskId) {
          throw new Error("上一条任务仍在处理，暂不能恢复自动发送");
        }
        state.halted = false;
        state.haltReason = null;
        state.haltAtUserCount = null;
        state.error = "";
        // Keep interrupted tasks quarantined: never resend a stopped reply.
      }
      state.queuePaused = message.paused;
      changed = true;
      break;

    case "SET_COMPACT_VIEW":
      if (!targetMatches(state, sender, url)) throw new Error("只能修改当前对话的列表外观");
      if (typeof message.enabled !== "boolean") throw new Error("列表外观参数必须是布尔值");
      if (state.compactView !== message.enabled) {
        state.compactView = message.enabled;
        changed = true;
      }
      break;

    case "CLAIM": {
      // An initially background tab may have missed ownership on HELLO.
      // A foreground claimant can take over only an idle established chat.
      if (chatKey(url) && sender.tab?.active === true && !ownerMatches(state, sender) &&
          !state.activeTaskId && !state.steeringTaskId) {
        changed = await reattachIfOldTabClosed(state, sender, url) || changed;
      }
      dispatchBlockedReason = state.halted ? "halted"
        : state.queuePaused ? "paused"
        : state.activeTaskId ? "active_task"
        : state.steeringTaskId ? "steering"
        : !ownerMatches(state, sender) ? "owner_mismatch"
        : !targetMatches(state, sender, url) ? "target_mismatch"
        : !message.ready ? "not_ready" : null;
      if (dispatchBlockedReason) break;
      // A pre-click RELEASE_CLAIM leaves the one summary pending. Continue
      // that exact unsent row instead of blocking forever in summarizing or
      // creating another summary. Uncertain/sent rows are never retried here.
      const summaries = state.handoff?.phase === "summarizing"
        ? state.tasks.filter((task) => task.kind === "handoff_summary") : [];
      const retrySummary = summaries.length === 1 && summaries[0].status === "pending" &&
        !state.handoff.cancelRequested ? summaries[0] : null;
      changed = maybeRequestHandoff(store,state) || changed;
      if (handoffBusy(state) && !retrySummary) {
        dispatchBlockedReason = "busy_handoff";
        break;
      }
      const task = retrySummary
        ? (!retrySummary.retryNotBefore || Date.now() >= retrySummary.retryNotBefore ? retrySummary : null)
        : state.tasks.find((item) => item.status === "pending" &&
          (!item.retryNotBefore || Date.now() >= item.retryNotBefore));
      if (!task) {
        dispatchBlockedReason = retrySummary || state.tasks.some((item) => item.status === "pending")
          ? "retry_wait" : "no_pending";
        break;
      }
      if (task.kind === "handoff_intro") {
        const cache = handoffQueueFor(store,store.conversations[state.handoffSourceKey],state);
        if (!cache || task.handoffQueueId !== cache.queueId) {
          throw new Error("本轮交接缓存或队列 ID 不匹配，已停止领取");
        }
      } else if (task.kind === "handoff_summary" &&
          (!handoffQueueFor(store,state) || task.handoffQueueId !== state.handoff?.queueId)) {
        throw new Error("本轮总结缓存或队列 ID 不匹配，已停止领取");
      }
      if (Object.hasOwn(message, "resumeHandoffTaskId")) {
        // The page may reuse this exact unsent internal document in its native
        // composer. The hint is not permission to pick another FIFO row or to
        // restore any clicked, failed or delayed reservation.
        const firstPending = state.tasks.find((item) => item.status === "pending");
        let valid = typeof message.resumeHandoffTaskId === "string" &&
          task.id === message.resumeHandoffTaskId && firstPending?.id === task.id &&
          ["handoff_summary","handoff_intro"].includes(task.kind) && !task.images?.length;
        if (valid && task.kind === "handoff_summary") {
          valid = ["queued","summarizing"].includes(state.handoff?.phase) &&
            !state.handoff.cancelRequested;
        } else if (valid && task.kind === "handoff_intro") {
          const source = store.conversations[state.handoffSourceKey];
          const handoff = source?.handoff;
          const projectId = CQHandoff.normalizeProjectId(handoff?.projectId);
          valid = Boolean(source && source.tabId === state.tabId &&
            typeof handoff?.token === "string" && handoff.token &&
            handoff.token === state.handoffToken && handoff.destinationKey === state.key &&
            handoff.phase === "bootstrapping" && projectId &&
            CQHandoff.projectId(source.url) === projectId &&
            CQHandoff.projectId(state.url) === projectId &&
            CQHandoff.projectId(url) === projectId);
        }
        if (!valid) {
          dispatchBlockedReason = "resume_handoff_mismatch";
          break;
        }
      }
      // A queued handoff occupies an ordinary FIFO slot. It must never make
      // preceding tasks bypass their normal cooldown or jump to the front.
      const manualSummary = task.kind === "handoff_summary" &&
        (task.handoffTrigger === "manual" || state.handoff?.manualRequested === true);
      if (sendCooldownUntil(state) && !manualSummary) {
        dispatchBlockedReason = "cooldown";
        break;
      }
      if (task.kind === "handoff_summary") {
        const handoff = state.handoff;
        if (!["queued","summarizing"].includes(handoff?.phase)) {
          throw new Error("交接命令与接力状态不一致，请先取消交接后重试");
        }
        if (handoff.phase === "queued") {
          delete handoff.requestId;
          handoff.topicTitle = CQHandoff.topicTitle(sender.tab?.title) ||
            CQHandoff.topicTitle(handoff.topicTitle);
          task.text = CQHandoff.summaryPrompt(handoff.topicTitle);
          handoff.trigger = task.handoffTrigger || (handoff.manualRequested ? "manual" : "automatic");
          handoff.manualRequested = handoff.trigger === "manual";
          handoff.phase = "summarizing";
          handoff.changedAt = Date.now();
        }
      }
      task.status = "dispatching";
      task.claimedAt = Date.now();
      task.baselineUserCount = Math.max(0, Number(message.userCount) || 0);
      task.baselineUserId = typeof message.lastUserId === "string" ? message.lastUserId : null;
      task.baselineAssistantCount = Number.isInteger(message.assistantCount)
        ? message.assistantCount : null;
      task.baselineAssistantId = typeof message.lastAssistantId === "string"
        ? message.lastAssistantId : null;
      task.baselineAssistantSignature = typeof message.lastAssistantSignature === "string"
        ? message.lastAssistantSignature : null;
      state.activeTaskId = task.id;
      dispatch = {
        id: task.id, text: task.text,
        // Bind the send attempt to the route where it was reserved. The
        // content script must keep this origin while awaiting the RPC and
        // must release it there if the user changes conversations.
        sourceUrl: url,
        sourceSessionKey: state.key,
        ...(state.projectVisitId ? {projectVisitId:state.projectVisitId} : {}),
        ...(task.kind ? {kind:task.kind} : {}),
        images: task.images || [],
        baselineUserCount: task.baselineUserCount,
        baselineUserId: task.baselineUserId,
      };
      changed = true;
      break;
    }

    case "GET_TASK_IMAGES": {
      if (!targetMatches(state, sender, url) || state.activeTaskId !== message.id) {
        throw new Error("图片只能由本对话正在执行的任务读取");
      }
      const task = state.tasks.find((item) => item.id === message.id && item.status === "dispatching");
      if (!task) throw new Error("图片任务没有处于发送准备状态");
      // Kept for content scripts already open when the extension reloads.
      // New scripts use GET_TASK_IMAGE to avoid bundling up to 4 x 8 MB.
      const refs = task.images || [];
      imagePayload = (await cqImageStore.load(refs.map((image) => image.id)))
        .map((record, index) => verifyStoredImage(refs[index], record));
      break;
    }

    case "GET_TASK_IMAGE": {
      if (!targetMatches(state, sender, url) || state.activeTaskId !== message.id) {
        throw new Error("图片只能由本对话正在执行的任务读取");
      }
      const task = state.tasks.find((item) => item.id === message.id && item.status === "dispatching");
      if (!task) throw new Error("图片任务没有处于发送准备状态");
      const reference = (task.images || []).find((image) => image.id === message.imageId);
      if (!reference || typeof message.imageId !== "string") {
        throw new Error("图片不属于当前正在执行的队列任务");
      }
      const [record] = await cqImageStore.load([reference.id]);
      verifyStoredImage(reference, record);
      imagePayload = [record];
      break;
    }

    case "HANDOFF_SEND_READY": {
      const task = state.tasks.find(item => item.id === message.id &&
        item.id === state.activeTaskId && item.status === "dispatching" &&
        ["handoff_summary","handoff_intro"].includes(item.kind));
      if (!targetMatches(state,sender,url) || !task || state.parkedDraft ||
          state.halted || state.queuePaused || state.steeringTaskId ||
          task.images?.length || Number.isFinite(task.sendArmedAt) ||
          !Number.isFinite(task.claimedAt) ||
          Date.now()-task.claimedAt > HANDOFF_PREPARE_TIMEOUT_MS) {
        throw new Error("交接发送准备已失效或已确认过，拒绝再次发送；请核对当前任务");
      }
      const liveTab = await chrome.tabs.get(tabId);
      if (safeUrl(liveTab.url) !== url || liveTab.discarded === true ||
          safeUrl(sender.tab?.url) && safeUrl(sender.tab.url) !== url) {
        throw new Error("交接页面已变化，拒绝发送到其他页面");
      }
      if (task.kind === "handoff_summary") {
        if (state.handoff?.phase !== "summarizing" || state.handoff.cancelRequested ||
            !chatKey(url) || !CQHandoff.projectId(url) || !handoffQueueFor(store,state) ||
            task.handoffQueueId !== state.handoff.queueId) {
          throw new Error("交接总结已取消或状态失效，拒绝发送");
        }
      } else {
        const source = store.conversations[state.handoffSourceKey];
        const handoff = source?.handoff;
        const projectId = CQHandoff.normalizeProjectId(handoff?.projectId);
        if (!source || source.tabId !== tabId || !handoff?.token ||
            handoff.token !== state.handoffToken || handoff.destinationKey !== state.key ||
            handoff.phase !== "bootstrapping" || handoff.cancelRequested || !projectId ||
            !handoffQueueFor(store,source,state) || task.handoffQueueId !== handoff.queueId ||
            CQHandoff.projectId(source.url) !== projectId ||
            CQHandoff.projectId(state.url) !== projectId || CQHandoff.projectId(url) !== projectId) {
          throw new Error("接收交接关系已失效或已取消，拒绝发送");
        }
      }
      // Durable one-shot permission precedes the native click. A lost reply
      // cannot be retried as another arm, or released into the pending queue.
      task.sendArmedAt = Date.now();
      sendReady = true;
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
      if (Number.isFinite(task.sendArmedAt)) {
        throw new Error("交接发送已确认准备，无法回退重发；请核对原生聊天记录");
      }
      if (task.kind === "handoff_summary" && state.handoff?.cancelRequested) {
        state.tasks.splice(state.tasks.indexOf(task),1);
        state.activeTaskId = null;
        removeHandoffQueue(store,state);
        cancelHandoffState(state);
        changed = true;
        break;
      }
      task.status = "pending";
      task.retryNotBefore = Date.now() + 2500;
      state.activeTaskId = null;
      changed = true;
      break;
    }

    case "SENT": {
      // The first native Send may create /c/<id> before its user bubble
      // arrives. Confirm the click against the still-owned draft, not an
      // unrelated empty chat. HELLO will bind the real chat ID once visible.
      const pendingIntroSend = pendingNewChat &&
        pendingNewChat.active.id === message.id;
      if (!targetMatches(state, sender, url) && !pendingIntroSend) {
        throw new Error("对话地址变化，拒绝确认发送");
      }
      const task = state.tasks.find((item) => item.id === message.id);
      // The new document may already have confirmed the first native user
      // turn and adopted its draft before the old script's SENT RPC arrived.
      if (task && task.id === state.activeTaskId && task.status === "waiting" &&
          (targetMatches(state,sender,url) || pendingIntroSend)) break;
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
      const waveformConfirmed = message.voiceReady === true &&
        Number.isFinite(message.voiceStableMs) && message.voiceStableMs >= 1700;
      const handoffTask = ["handoff_summary","handoff_intro"].includes(task.kind) ||
        state.handoff?.phase === "due";
      // Current ChatGPT layouts can show only a dictation microphone, with no
      // dedicated Voice Mode button. For handoff tasks ONLY, accept a more
      // conservative proof: the native Stop is gone, an actual newer assistant
      // reply/final toolbar exists, and the surface stayed idle and unchanged.
      const handoffNativeConfirmed = handoffTask && message.handoffReady === true &&
        message.handoffNativeIdle === true && message.handoffResponseConfirmed === true &&
        Number.isFinite(message.handoffIdleStableMs) &&
        message.handoffIdleStableMs >= 4500 &&
        Number.isFinite(message.handoffReplyStableMs) &&
        message.handoffReplyStableMs >= 2500;
      if ((!waveformConfirmed && !handoffNativeConfirmed) ||
          message.editorEmpty !== true || message.busy !== false ||
          !Number.isFinite(task.sentAt) || Date.now() - task.sentAt < 1700) {
        throw new Error("尚未确认本轮回复完整结束，继续等待");
      }
      if (task.kind === "handoff_summary" && !state.handoff?.cancelRequested &&
          (message.handoffReplyIsNew !== true || message.handoffLastRole !== "assistant")) {
        // A stable Voice control can precede reply hydration. Stay waiting
        // rather than parse the prior assistant turn or lose the source queue.
        throw new Error("尚未确认接力请求之后的下一条完整助手回复，继续等待");
      }
      if (task.kind === "handoff_summary") {
        const handoff = state.handoff;
        if (handoff?.phase !== "summarizing") throw new Error("接力状态异常，旧队列未迁移");
        if (handoff.cancelRequested) {
          state.tasks.splice(state.tasks.indexOf(task),1);
          state.activeTaskId = null;
          state.lastQueueSettledAt = Date.now();
          removeHandoffQueue(store,state);
          cancelHandoffState(state);
          changed = true;
          break;
        }
        try {
          if (Number.isInteger(message.userCount) &&
              message.userCount > task.baselineUserCount + 1) {
            throw new Error("生成交接总结期间出现了额外用户消息，旧队列已保留；请重新接力");
          }
          // The next assistant reply is identified by the pre-send
          // assistant snapshot, not by its wording or marker formatting.
          // ChatGPT may virtualize the full user request bubble.
          const summary = CQHandoff.parseSummary(message.handoffSummary);
          handoff.summary = summary;
          handoff.topicTitle = CQHandoff.summaryTopic(summary) ||
            CQHandoff.topicTitle(handoff.topicTitle);
          if (!handoffQueueFor(store,state)) throw new Error("本轮接力缓存缺失或不匹配，旧队列已保留");
          handoff.sourceUserCount = Number.isInteger(message.userCount)
            ? message.userCount : null;
          handoff.projectId = CQHandoff.projectId(url);
          handoff.projectUrl = CQHandoff.projectStart(url);
          if (!handoff.projectId) throw new Error("无法确认原生项目归属");
          handoff.phase = "opening";
          handoff.changedAt = Date.now();
          recordHistory(state,"handoff_summary");
        } catch (error) {
          failHandoff(state,error.message);
          task.status = "error";
          task.error = error.message;
          state.activeTaskId = null;
          state.lastQueueSettledAt = Date.now();
          changed = true;
          break;
        }
      } else if (task.kind === "handoff_intro") {
        if (!chatKey(url)) throw new Error("还没有确认新对话地址，旧队列未迁移");
        finishHandoffTransfer(store,state,task,url);
        state.activeTaskId = null;
        state.lastQueueSettledAt = Date.now();
        changed = true;
        break;
      }
      // Remove exactly this task and release the lock; the source keeps all
      // pending work until the destination introduction is confirmed.
      state.tasks.splice(state.tasks.indexOf(task), 1);
      state.activeTaskId = null;
      state.lastQueueSettledAt = Date.now();
      // Older content scripts from safely deferred extension updates do not
      // yet send the viewed flag. Preserve their completed reply as unread
      // rather than lose it; a foreground page acknowledges after upgrading.
      if (message.viewed !== true) state.unreadCompleted = true;
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
        if (task.status === "waiting") state.lastQueueSettledAt = Date.now();
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
      // A native Continue button or a new user message may lift the explicit
      // native Stop. It is NOT evidence that an ambiguous send was reviewed.
      if (!targetMatches(state, sender, url) || !state.halted ||
          state.haltReason !== "user") break;
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
      if (!targetMatches(state, sender, url) && !pendingNewChat) break;
      const index = state.tasks.findIndex((task) => task.id === message.id &&
        (task.status === "error" || task.status === "interrupted" &&
         ["handoff_summary","handoff_intro"].includes(task.kind)));
      if (index >= 0 && ["handoff_summary","handoff_intro"].includes(state.tasks[index].kind)) {
        cancelPending = cancelHandoffTransaction(store,state,message);
        changed = true;
        break;
      }
      if (index < 0 || state.steeringTaskId ||
          state.haltReason === "user" ||
          state.activeTaskId && state.haltReason !== "steer_unconfirmed") break;
      // Explicit recovery after the user has checked the conversation.
      // Never retry the failed task, even when sending was uncertain.
      state.tasks.splice(index, 1);
      state.lastQueueSettledAt = Date.now();
      const remainingCrashErrors = state.haltReason === "state_inconsistent"
        ? state.tasks.filter((task) => task.status === "error" &&
          String(task.error || "").includes("异常重启后发送状态无法确认")).length : 0;
      if (remainingCrashErrors) {
        state.error = "还有 " + remainingCrashErrors + " 条异常中断任务待核对，暂不恢复自动发送。";
      } else {
        state.error = "";
        state.halted = false;
        state.haltReason = null;
        state.haltAtUserCount = null;
      }
      changed = true;
      break;
    }

    case "ACK_RECOVERY": {
      // Explicit recovery when a *newer* delivery failure has been confirmed
      // by the user. Does not modify or resend an uncertain task.
      if ((!targetMatches(state, sender, url) && !pendingNewChat) || state.activeTaskId ||
          !state.halted || state.haltReason === "user") break;
      if (state.handoffSourceKey || state.tasks.some(task =>
          ["handoff_summary","handoff_intro"].includes(task.kind))) {
        cancelPending = cancelHandoffTransaction(store,state,{...message,reviewed:true});
        changed = true;
        break;
      }
      state.halted = false;
      state.haltReason = null;
      state.haltAtUserCount = null;
      state.error = "";
      state.lastQueueSettledAt = Date.now();
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
      if (task.kind === "handoff_summary") {
        failHandoff(failed,"交接总结发送状态不确定；已保留原有队列");
      } else if (task.kind === "handoff_intro") {
        const source = store.conversations[failed.handoffSourceKey];
        if (source?.handoff?.token === failed.handoffToken) {
          failHandoff(source,"新对话开场消息状态不确定；旧队列未迁移");
        }
      }
      recordHistory(failed, "send_failed", task.id);
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

  const historyAction = ({
    ENQUEUE: "manual_enqueue", ENQUEUE_FAVORITE: "manual_enqueue",
    ADD_TASK: "manual_enqueue", EDIT_TASK: "task_edited",
    DELETE_TASK: "task_deleted", DISMISS_WAITING: "waiting_dismissed", PIN_TASK: "task_pinned",
    REORDER_TASK: "task_reordered", CLAIM: "claim", SENT: "sent",
    FINISHED: "finished", RELEASE_CLAIM: "deferred",
    STEER_CLAIM: steerDeferred ? "steer_deferred" : "steer_claim",
    REMOTE_STEER_CLAIM:"steer_claim",
    STEER_PROMPT_CLAIM:"steer_claim", STEER_PAUSING: "steer_pausing",
    STEER_CLICKED: "steer_clicked",
    STEER_CANCEL: "steer_cancel", STEER_CONFIRM: "steer_confirm",
    STEER_UNCONFIRMED: "steer_uncertain", STOPPED: "user_stopped",
    USER_RESUMED: "user_resumed", RECOVER_ON_VOICE: "auto_recovered",
    SKIP_FAILED: "failed_skipped", ACK_RECOVERY: "review_confirmed",
    ADD_SCHEDULE: "schedule_added", EDIT_SCHEDULE: "schedule_edited",
    DELETE_SCHEDULE: "schedule_deleted", TOGGLE_SCHEDULE: "schedule_toggled",
    SET_QUEUE_PAUSED: state.queuePaused ? "queue_paused" : "queue_resumed",
    SAVE_COUNT_RATE_LIMIT: "rate_limit_updated",
    SAVE_SEND_COOLDOWN: "send_cooldown_updated",
  })[message.type];
  if (cancelPending === false && isProjectOverview(url) &&
      !state.handoffSourceKey && projectVisitId) state.projectVisitId = projectVisitId;
  // CLAIM can repair an inconsistent persisted lock without claiming any
  // pending row. Do not misreport that maintenance as an actual send attempt.
  if (changed && historyAction && (message.type !== "CLAIM" || dispatch)) {
    const itemId = enqueuedTaskId ||
      (["ENQUEUE_FAVORITE", "ADD_TASK"].includes(message.type)
        ? state.tasks.at(-1)?.id : message.id);
    recordHistory(state, historyAction, itemId);
  }

  changed = syncFailedHandoffDestination(store, state) || changed;
  // Recheck after queue mutations, so count-triggered schedules refill as soon
  // as an item finishes or is deleted, without waiting for a countdown.
  if (["HELLO", "SCHEDULE_PULSE", "ADD_SCHEDULE", "EDIT_SCHEDULE", "TOGGLE_SCHEDULE",
       "ENQUEUE", "ENQUEUE_FAVORITE", "ADD_TASK", "DELETE_TASK", "DISMISS_WAITING", "FINISHED", "STEER_CONFIRM",
       "STEER_UNCONFIRMED", "STOPPED", "USER_RESUMED", "RECOVER_ON_VOICE",
       "UNCERTAIN_SEND", "FAIL", "SKIP_FAILED", "ACK_RECOVERY", "SAVE_SETTINGS",
       "SAVE_COUNT_RATE_LIMIT"].includes(message.type) &&
      dueSchedules(state, Date.now(), queueLimit(store))) {
    checkpointScheduledHandoffQueue(store,state);
    changed = true;
  }
  if (["HELLO","SCHEDULE_PULSE","ENQUEUE","ADD_TASK","FINISHED","CLAIM"].includes(message.type)) {
    changed = maybeRequestHandoff(store,state) || changed;
  }

  if (changed && ["ADD_SCHEDULE","EDIT_SCHEDULE","TOGGLE_SCHEDULE","DELETE_SCHEDULE",
      "SAVE_COUNT_RATE_LIMIT","SAVE_SEND_COOLDOWN","SAVE_SETTINGS","AUTO_OPEN",
      "SET_QUEUE_PAUSED","SET_COMPACT_VIEW"].includes(message.type)) {
    checkpointHandoffQueue(store,state,["ADD_SCHEDULE","EDIT_SCHEDULE","TOGGLE_SCHEDULE",
      "DELETE_SCHEDULE"].includes(message.type));
  }
  if (changed && !["handoff_summary","handoff_intro"].includes(requestTaskKind) &&
      ["ENQUEUE","ENQUEUE_FAVORITE","ADD_TASK","EDIT_TASK","PIN_TASK","REORDER_TASK",
       "DELETE_TASK","DISMISS_WAITING","CLAIM","SENT","FINISHED","STEER_CONFIRM",
       "STEER_UNCONFIRMED","STOPPED","USER_RESUMED","RECOVER_ON_VOICE","UNCERTAIN_SEND",
       "FAIL","SKIP_FAILED","ACK_RECOVERY","RELEASE_CLAIM","STEER_PROMPT_CLAIM","REMOTE_STEER_CLAIM",
       "STEER_CLAIM","STEER_CANCEL","STEER_PAUSING","STEER_CLICKED"].includes(message.type)) {
    checkpointHandoffTasks(store,state);
  }

  if (changed) {
    // Merely opening an empty homepage must not leave a durable queue.
    if (!state.projectVisitId || hasConversationWork(state)) store.conversations[effectiveKey] = state;
    else delete store.conversations[effectiveKey];
    await saveStore(store);
    if (draftScopeChanged) await cleanupUnusedImages(store);
    // Keep staged image references protected until durable queue persistence
    // succeeds. Only then can the normal queue own those originals.
    if (restoreTokenCompleted) pendingBackupRestores.delete(restoreTokenCompleted);
    if (["DELETE_TASK", "DISMISS_WAITING", "EDIT_TASK", "FINISHED", "STEER_CONFIRM",
         "DELETE_SCHEDULE", "EDIT_SCHEDULE", "IMPORT_LEGACY", "SKIP_FAILED"].includes(message.type)) {
      await cleanupUnusedImages(store);
    }
  }
  if (changed || message.type === "HELLO") await maintainTabProtection(store);
  if (message.type === "CLAIM") {
    try { await recordHandoffDebugClaim(store,{state,sender,url,dispatch,blockedReason:dispatchBlockedReason}); }
    catch (error) { console.warn("[ChatQueue] 领取诊断暂时无法记录，领取结果保持不变",error); }
  }
  if (adoptionObservation && ["HELLO","CONFIRM_HANDOFF"].includes(message.type)) {
    try { await recordHandoffDebugAdoption(store,adoptionObservation,sender,url,message,adopted); }
    catch (error) { console.warn("[ChatQueue] 接收归属诊断暂时无法记录",error); }
  }
  return {
    ok: true, state, sessionKey: effectiveKey, dispatch, steerDeferred, tabId,
    ...(message.type === "HANDOFF_SEND_READY" ? {sendReady} : {}),
    ...(confirmingHandoff ? {handoffPending,adopted:Boolean(adopted)} : {}),
    ...(message.type === "RETRY_UNSENT_HANDOFF" ? {retryReady} : {}),
    ...(cancelPending !== null ? {cancelPending} : {}),
    ...(message.type === "CLAIM" && !dispatch ? {dispatchBlockedReason} : {}),
    ...(message.type === "CLAIM" ? {claimDiagnostic:{
      outcome:dispatch ? "acquired" : "empty",
      reason:dispatch ? "claim_acquired" : dispatchBlockedReason || "claim_empty",
      backendVersion:handoffDebugBackendVersion(),
      ...handoffDebugClaimSnapshot(state,url),
    }} : {}),
    ...(pendingNewChat ? {awaitingChatConfirmation:true} : {}),
    ...(backupPayload ? { backup: backupPayload } : {}),
    ...(imageHealth ? { imageHealth } : {}),
    ...(imagePayload ? { images: imagePayload } : {}),
    settings: {
      maxPending: queueLimit(store),
      protectBackground: backgroundProtectionEnabled(store),
      defaultIntervalMinutes: defaultIntervalMinutes(store),
      defaultRepeatCount: defaultRepeatCount(store),
      queueListHeight: queueListHeight(store),
    },
    legacyUnboundCount: store.legacyUnbound?.tasks.length || store.legacyUnbound?.schedules.length || 0,
  };
  } catch (error) {
    if (newImageIds.length) {
      // An image may have been written to IndexedDB before chrome.storage
      // accepted its queue reference. Roll back only confirmed unreferenced
      // new IDs. If storage cannot be inspected, keep the originals intact;
      // the normal startup orphan sweep can clean them later.
      try {
        const stored = (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY];
        if (stored?.version === 2) {
          const references = imageReferences(stored);
          const orphanIds = newImageIds.filter((imageId) => !references.has(imageId));
          if (orphanIds.length) await cqImageStore.remove(orphanIds);
        }
      } catch (cleanupError) {
        console.warn("[ChatQueue] 保存失败后清理新图片未完成，已保留原始数据", cleanupError);
      }
    }
    throw error;
  }
}

async function ensureTargetTab(state) {
  if (state.halted || handoffBusy(state) || !state.autoOpenTab || !state.url ||
      (!state.activeTaskId && !state.tasks.some((t) => t.status === "pending")) ||
      chatKey(state.url) !== state.key) return;
  let current = null;
  try {
    current = await chrome.tabs.get(state.tabId);
    // A newly opened tab may report only pendingUrl until navigation commits.
    // It is still the correct owner; opening another every minute would create
    // a tab storm on slow/offline connections.
    if ((chatKey(current.url) === state.key ||
         chatKey(current.pendingUrl) === state.key) && !current.discarded) return false;
    const openedAt = recentTabOpens.get(current.id);
    const stillNavigating = !current.url || current.url === "about:blank" ||
      current.status === "loading";
    if (openedAt != null && Date.now() - openedAt >= 0 &&
        Date.now() - openedAt < TAB_REVIVE_BACKOFF_MS && stillNavigating) return false;
  } catch { /* Tab was closed. */ }

  const matches = await chrome.tabs.query({ url: ["https://chatgpt.com/*", "https://chat.openai.com/*"] });
  // Prefer a live copy of the same chat over a discarded tab, otherwise a
  // stale duplicate can monopolize ownership and never answer QUEUE_WAKE.
  const live = matches.find((tab) => chatKey(tab.url) === state.key && !tab.discarded);
  if (live) {
    if (state.tabId === live.id) return false;
    state.tabId = live.id;
    recordHistory(state, "tab_owner_rebound");
    return true;
  }
  const discarded = matches.find((tab) => chatKey(tab.url) === state.key && tab.discarded) ||
    (current && chatKey(current.url) === state.key && current.discarded ? current : null);
  if (discarded) {
    const reassigned = state.tabId !== discarded.id;
    state.tabId = discarded.id;
    const lastAttempt = recentTabRevives.get(discarded.id);
    if (lastAttempt != null && Date.now() - lastAttempt < TAB_REVIVE_BACKOFF_MS) {
      return reassigned;
    }
    recentTabRevives.set(discarded.id, Date.now());
    try {
      // Reload only when the user explicitly opted into auto-reopening.
      // Unlike creating a second tab, this keeps the same chat tab in place
      // and does not activate it or steal foreground focus.
      await chrome.tabs.reload(discarded.id);
      recordHistory(state, "tab_revived");
      return true;
    } catch (error) {
      console.warn("[ChatQueue] 无法恢复被丢弃的标签页，改为后台新开", error);
    }
  }
  const tab = await chrome.tabs.create({ url: state.url, active: false });
  state.tabId = tab.id;
  recentTabOpens.set(tab.id, Date.now());
  recordHistory(state, "tab_reopened");
  return true;
}

async function onScheduleTick() {
  // Recovery installation is independent of durable queue reads/locks. Even
  // a damaged store or an occupied dispatch lock must not strand an error page.
  // Re-injection calls the existing guardian's scan, including its independent
  // five-minute transport-error cadence when page timers are throttled.
  void installLoadRecoveryGuardians();
  const wakeTabIds = await exclusive(async () => {
    const store = await readStore();
    const staleIds = [];
    for (const [token, stage] of pendingBackupRestores) {
      if (Date.now() - stage.createdAt < BACKUP_STAGE_TIMEOUT_MS) continue;
      pendingBackupRestores.delete(token);
      staleIds.push(...[...stage.received.values()].map((item) => item.id));
    }
    if (staleIds.length) {
      try { await cqImageStore.remove(staleIds); }
      catch (error) { console.warn("[ChatQueue] 过期备份暂存图片清理失败", error); }
    }
    let expiredFavorites = false;
    for (const [token,stage] of pendingFavoriteRestores) {
      if (Date.now() - stage.createdAt < BACKUP_STAGE_TIMEOUT_MS) continue;
      pendingFavoriteRestores.delete(token);
      expiredFavorites = true;
    }
    if (expiredFavorites) await cleanupUnusedImages(store);
    let changed = false;
    for (const state of Object.values(store.conversations)) {
      if (state.parkedDraft) continue;
      const recovered = recoverObsoleteHalt(state);
      // Per-chat timers keep running while the user views a different chat.
      const scheduled = dueSchedules(state, Date.now(), queueLimit(store));
      if (scheduled) checkpointScheduledHandoffQueue(store,state);
      const inconsistent = checkInFlightIntegrity(state);
      const timedOut = checkTimeout(state);
      const steerTimedOut = checkSteerTimeout(state);
      if (steerTimedOut) checkpointHandoffTasks(store,state);
      const handoffDue = maybeRequestHandoff(store,state);
      const handoffExpired = timeoutHandoff(state);
      const destinationFailed = syncFailedHandoffDestination(store, state);
      // A single failed tabs.query/reload/create must not abort scheduling for
      // every other conversation or discard this minute's newly due tasks.
      let reopened = false;
      try {
        reopened = await ensureTargetTab(state);
        reopened = await reviveProtectedDiscardedTab(store, state) || reopened;
      }
      catch (error) {
        console.warn("[ChatQueue] 自动恢复标签失败，保留已排队任务并继续其他对话", error);
        const lastFailure = Array.isArray(state.history) ?
          state.history.filter((entry) => entry.type === "tab_reopen_failed").at(-1) : null;
        if (!lastFailure || Date.now() - lastFailure.at >= 10 * 60_000) {
          recordHistory(state, "tab_reopen_failed");
          changed = true;
        }
      }
      if (recovered || scheduled || inconsistent || timedOut || steerTimedOut ||
          handoffDue || handoffExpired || destinationFailed || reopened) changed = true;
    }
    if (changed) await saveStore(store);
    return maintainTabProtection(store);
  });
  // A message can nudge a throttled but live content script; frozen pages may
  // never receive it. Don't await RPCs while holding the serialized worker.
  for (const tabId of wakeTabIds) {
    void chrome.tabs.sendMessage(tabId, { type: "QUEUE_WAKE" })
      .catch(() => { /* Frozen, navigated, or not yet loaded. */ });
  }
  // Retry deferred version-refresh tabs without relying on stale content
  // scripts. This also survives MV3 service-worker suspension.
  await processPendingVersionRefresh();
}

async function startup() {
  const existing = await chrome.alarms.get(ALARM_NAME);
  if (!existing) await chrome.alarms.create(ALARM_NAME, { periodInMinutes: 1 });
  // Chrome 120+ supports 30-second alarms, surviving MV3 worker suspension.
  const remoteAlarm=await chrome.alarms.get(CQRemoteDispatch.ALARM);
  if (!remoteAlarm) await chrome.alarms.create(CQRemoteDispatch.ALARM, {periodInMinutes:0.5});
  await onScheduleTick();
  await exclusive(async () => cleanupUnusedImages(await readStore()));
  void CQRemoteDispatch.tick().catch((error) =>
    console.warn("[ChatQueue] 启动远程任务检查失败",error));
}

function startSafely() {
  // A future/corrupt queue version intentionally fails closed. Swallow only
  // the unhandled Promise rejection at event boundaries, not the data error:
  // user RPCs still receive the explicit refusal and no cleanup is performed.
  void startup().catch((error) =>
    console.error("[ChatQueue] 启动检查失败，已保留原队列与图片", error));
}

chrome.runtime.onInstalled.addListener((details) => {
  startSafely();
  // Only an actual extension version change reloads ChatGPT pages.
  // Never refresh for first install, browser updates, or same-version reloads.
  return scheduleVersionRefresh(details).catch((error) =>
    console.warn("[ChatQueue] 版本更新自动刷新初始化失败", error));
});
chrome.runtime.onStartup.addListener(startSafely);
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) {
    void onScheduleTick().catch((error) =>
      console.error("[ChatQueue] 后台检查失败，已保留原队列与图片", error));
  }
  if (alarm.name === CQRemoteDispatch.ALARM) {
    void CQRemoteDispatch.tick().catch((error) =>
      console.warn("[ChatQueue] 远程任务轮询失败，保留未确认任务",error));
  }
});
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if(changeInfo.url) {
    void CQRemoteDispatch.onTabNavigated(tabId,changeInfo.url).catch(error=>
      console.warn("[ChatQueue] 远程标签导航保护标记暂未更新",error));
  }
  if (changeInfo.url || changeInfo.discarded === true) pagePulses.delete(tabId);
  if (changeInfo.status === "complete") {
    // This path deliberately stays outside exclusive(): a broken/missing
    // content script must not prevent the native error-page watchdog running.
    void installLoadRecoveryGuardians(tabId);
    void processPendingVersionRefresh().catch((error) =>
      console.warn("[ChatQueue] 网页加载后的版本刷新检查失败", error));
  }
  if (!changeInfo.url && changeInfo.discarded !== true &&
      changeInfo.autoDiscardable !== true && changeInfo.status !== "complete") return;
  // Revoke our no-discard flag promptly if the protected tab navigates away.
  void exclusive(async () => {
    const store = await readStore();
    if (changeInfo.url) await discardDepartedProjectDraft(store, tabId, changeInfo.url);
    let revived = changeInfo.url ? noteHandoffCreatedChat(store,
      {tab:{id:tabId,url:changeInfo.url}},safeUrl(changeInfo.url)) : false;
    if (changeInfo.discarded === true) {
      for (const state of Object.values(store.conversations)) {
        if (state.tabId !== tabId) continue;
        try { revived = await reviveProtectedDiscardedTab(store, state) || revived; }
        catch (error) { console.warn("[ChatQueue] 已丢弃的队列页面暂时无法恢复", tabId, error); }
      }
    }
    if (revived) await saveStore(store);
    await maintainTabProtection(store);
  })
    .catch((error) => console.warn("[ChatQueue] 标签导航后的保护同步失败，已保留队列数据", error));
});
chrome.tabs.onRemoved.addListener((tabId) => {
  pagePulses.delete(tabId);
  recentTabRevives.delete(tabId);
  recentTabOpens.delete(tabId);
  void exclusive(async () => {
    const store = await readStore();
    await discardDepartedProjectDraft(store, tabId);
    await maintainTabProtection(store);
  })
    .catch((error) => console.warn("[ChatQueue] 标签关闭后的保护同步失败，已保留队列数据", error));
  void CQRemoteDispatch.onTabRemoved(tabId).catch(error=>
    console.warn("[ChatQueue] 自动标签归属清理失败",error));
});
// A user-visited AI tab must never be auto-closed after focus changes.
chrome.tabs.onActivated?.addListener(({tabId})=>{
  void CQRemoteDispatch.onTabActivated(tabId).catch(error=>
    console.warn("[ChatQueue] 标签访问保护标记暂时未保存",error));
});
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Heartbeats never write durable queue state or enter the dispatch lock.
  const work = message?.type === "PAGE_PULSE"
    ? Promise.resolve().then(() => handlePagePulse(message, sender))
    : exclusive(async () => {
      try {
        if (message?.type === "HANDOFF_DEBUG_SIGNAL") {
          return await appendHandoffDebugSignal(message,sender);
        }
        if (message?.type === "GET_HANDOFF_DEBUG") {
          return await handoffDebugReport(message,sender);
        }
        return await (FAVORITE_ACTIONS.has(message?.type)
          ? handleFavoriteMessage(message, sender)
          : ["DASHBOARD_GET", "DASHBOARD_SET_PAUSED",
             "DASHBOARD_REMOVE_CONVERSATION", "DASHBOARD_CLEANUP_IDLE"].includes(message?.type)
            ? handleDashboardMessage(message, sender) : handle(message, sender));
      } catch (error) {
        try { await recordHandoffDebugRpcError(message,sender,error); }
        catch (debugError) {
          console.warn("[ChatQueue] 接力操作错误未能写入调试日志",debugError);
        }
        throw error;
      }
    });
  work.then((reply)=>{
    sendResponse(reply);
    if(message?.type==="FINISHED" && reply?.ok===true &&
        Number.isInteger(sender.tab?.id) && typeof message.id==="string" &&
        reply.state?.history?.some(h=>h.type==="finished" && h.taskId===message.id)) {
      // Completion is persisted before releasing its owned background tab.
      void CQRemoteDispatch.onTaskFinished(sender.tab.id,message.id).catch(error=>
        console.warn("[ChatQueue] 已完成队列标签释放延后",error));
    }
  })
    .catch((error) => sendResponse({ ok: false, error: error.message || "未知错误",
      ...(message?.type === "CLAIM" ? {claimDiagnostic:{outcome:"rejected",reason:"claim_rejected",
        errorReason:handoffDebugReason(error.message),backendVersion:handoffDebugBackendVersion()}} : {}),
    }));
  return true;
});
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id || !safeUrl(tab.url)) return;
  try { await chrome.tabs.sendMessage(tab.id, { type: "TOGGLE_PANEL" }); }
  catch { /* The ChatGPT tab might still be loading. */ }
});

// Recover missing alarms after service-worker termination/browser upgrades.
startSafely();
