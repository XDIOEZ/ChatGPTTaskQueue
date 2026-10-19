/* global chrome */
"use strict";
importScripts("image-store.js");

// One serialized service worker owns every conversation's queue. The storage
// envelope is shared, but task dispatch and scheduler state are per-chat.
const STORAGE_KEY = "cq.state.v2";
const LEGACY_KEY = "cq.state.v1";
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
  "task_edited", "task_deleted", "task_pinned", "task_reordered",
  "steer_claim", "steer_clicked", "steer_cancel", "steer_confirm",
  "steer_uncertain", "state_inconsistent", "tab_revived",
  "tab_reopened", "tab_owner_rebound", "tab_reopen_failed",
  "user_stopped", "user_resumed", "auto_recovered", "failed_skipped",
  "review_confirmed", "schedule_added", "schedule_edited",
  "schedule_deleted", "schedule_toggled", "queue_paused",
  "queue_resumed", "rate_limit_updated", "backup_restored",
  "send_cooldown_updated",
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
const STEER_RESERVE_TIMEOUT_MS = 60 * 1000;
const STEER_CONFIRM_TIMEOUT_MS = 2 * 60 * 1000;

let serial = Promise.resolve();
let updateRefreshInProgress = null;
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
  };
}

function blankStore() {
  return {
    version: 2, conversations: {}, legacyUnbound: null, favorites: [],
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
  await chrome.storage.local.set({ [STORAGE_KEY]: store });
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

function favoriteSenderKind(message, sender) {
  if (isDashboardSender(sender) || isFavoritesPageSender(sender)) return "manager";
  const sourceUrl = safeUrl(sender.url || sender.tab?.url);
  if (!Number.isInteger(sender.tab?.id) || (sender.frameId != null && sender.frameId !== 0) ||
      !sourceUrl || sourceUrl !== safeUrl(message.url) ||
      (sender.tab.url && safeUrl(sender.tab.url) !== sourceUrl)) {
    throw new Error("只能从 ChatGPT 对话或插件管理页操作收藏夹");
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
  const kind = favoriteSenderKind(message, sender);
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
    state.queuePaused || String(state.error || "").trim());
}

function canPruneIdleSession(key, state, tabs) {
  return !hasConversationWork(state) &&
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
        !schedules.length && !state.queuePaused && !state.halted) continue;
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

// This standalone DOM probe runs in already-open ChatGPT tabs *after* the
// extension updates. Previous content scripts may have been invalidated, so
// runtime.sendMessage cannot be relied on to inspect those pages.
function inspectUpdateRefreshSafety() {
  const editor = document.querySelector(
    '#prompt-textarea, [data-testid="prompt-textarea"], [data-testid="composer-input"]'
  );
  let input = editor && !editor.closest("#cq-extension-root")
    ? (editor.matches('textarea, input, [contenteditable="true"]') ? editor :
      editor.querySelector('[contenteditable="true"], textarea, input')) : null;
  if (!input) input = [...document.querySelectorAll(
    'main [contenteditable="true"], main textarea, form [contenteditable="true"], form textarea'
  )].find((candidate) => !candidate.closest("#cq-extension-root")) || null;
  if (!input || document.readyState === "loading") {
    return { safe: false, voiceReady: false, reason: "composer_not_ready" };
  }
  const visible = (element) =>
    element.getClientRects().length > 0 && !element.disabled;
  const form = input.closest("form");
  const text = input.matches("textarea, input") ? input.value : input.innerText;
  if (String(text || "").trim()) {
    return { safe: false, voiceReady: false, reason: "unsent_text" };
  }
  const plugin = document.querySelector("#cq-extension-root");
  if (plugin?.getAttribute("data-cq-unsaved-draft") === "true") {
    // A closed editor can still contain a draft in content-script memory.
    // The new extension must not refresh that old document and erase it.
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
  const buttons = [...document.querySelectorAll("main button, form button")].filter(visible);
  const stop = buttons.some((button) => {
    const testId = button.getAttribute("data-testid") || "";
    const label = button.getAttribute("aria-label") || button.getAttribute("title") || "";
    return /(?:^|-)stop-button$|composer-stop-button/i.test(testId) ||
      /stop (generating|response)|停止(生成|回复|回答)/i.test(label);
  });
  if (stop || document.querySelector('main [data-testid="generation-in-progress"]')) {
    return { safe: false, voiceReady: false, reason: "generating" };
  }
  const voiceReady = buttons.some((button) => {
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
  return pendingCount(state) > 0 || state.schedules.some((schedule) => schedule.enabled);
}

function backgroundProtectionEnabled(store) {
  // Old v2 stores had no setting; make the safe default opt-out.
  return store.settings?.protectBackground !== false;
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
    if (resolveKey(tab?.url, tab?.id) !== state.key) continue;
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
      tasks: state.tasks.map((task) => copy(backupTask(task))),
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
    tasks: state.tasks.map(backupTask),
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
  recordHistory(state, "timeout", active.id, now);
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
  if (["HELLO", "SCHEDULE_PULSE", "CLAIM"].includes(message.type)) {
    changed = checkInFlightIntegrity(state) || changed;
  }
  // This also repairs an old Queue 0 + permanently-red-warning state before
  // the scheduler is evaluated or the UI is returned on HELLO / GET.
  changed = recoverObsoleteHalt(state) || changed;
  let dispatch = null;
  let imagePayload = null;
  let backupPayload = null;
  let restoreTokenCompleted = null;
  let imageHealth = null;
  const newImageIds = [];
  const maxPending = queueLimit(store);

  try {
  switch (message.type) {
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
      break;

    case "SCHEDULE_PULSE":
      // An open ChatGPT tab can tick precisely when the countdown reaches zero.
      // The minute alarm below is still the fallback for hidden/closed tabs.
      break;

    case "RECOVER_ON_VOICE": {
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
      state.tasks.push(newTask(text, null, images));
      markSubmission(state, requestId, fingerprint);
      changed = true;
      break;
    }

    case "ENQUEUE_FAVORITE": {
      if (favoriteSenderKind(message, sender) !== "chat") {
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
      const images = await attachImages([], null, message.images || [], newImageIds);
      if (!state.url) state.url = url;
      if (state.tabId == null) state.tabId = tabId;
      state.tasks.push(newTask(requirePrompt(message.text, images.length > 0), null, images));
      markSubmission(state, requestId, fingerprint);
      changed = true;
      break;
    }

    case "EDIT_TASK": {
      const task = state.tasks.find((item) => item.id === message.id);
      if (!task || task.status !== "pending") throw new Error("只能编辑未发送任务");
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
      if (task.images?.length) throw new Error("图片任务只能按普通队列发送，暂不支持引导");
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
      if (state.halted || state.queuePaused || state.activeTaskId || state.steeringTaskId ||
          !targetMatches(state, sender, url) || !message.ready) break;
      // Serialize the decision in the service worker: a stale tab or an old
      // content script cannot skip this gate by polling CLAIM early.
      if (sendCooldownUntil(state)) break;
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
      state.lastQueueSettledAt = Date.now();
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
      if (!targetMatches(state, sender, url)) break;
      const index = state.tasks.findIndex((task) => task.id === message.id && task.status === "error");
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
      if (!targetMatches(state, sender, url) || state.activeTaskId ||
          !state.halted || state.haltReason === "user") break;
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
    DELETE_TASK: "task_deleted", PIN_TASK: "task_pinned",
    REORDER_TASK: "task_reordered", CLAIM: "claim", SENT: "sent",
    FINISHED: "finished", RELEASE_CLAIM: "deferred",
    STEER_CLAIM: "steer_claim", STEER_CLICKED: "steer_clicked",
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
  // CLAIM can repair an inconsistent persisted lock without claiming any
  // pending row. Do not misreport that maintenance as an actual send attempt.
  if (changed && historyAction && (message.type !== "CLAIM" || dispatch)) {
    const itemId = ["ENQUEUE", "ENQUEUE_FAVORITE", "ADD_TASK"].includes(message.type)
      ? state.tasks.at(-1)?.id : message.id;
    recordHistory(state, historyAction, itemId);
  }

  // Recheck after queue mutations, so count-triggered schedules refill as soon
  // as an item finishes or is deleted, without waiting for a countdown.
  if (["HELLO", "SCHEDULE_PULSE", "ADD_SCHEDULE", "EDIT_SCHEDULE", "TOGGLE_SCHEDULE",
       "ENQUEUE", "ENQUEUE_FAVORITE", "ADD_TASK", "DELETE_TASK", "FINISHED", "STEER_CONFIRM",
       "STEER_UNCONFIRMED", "STOPPED", "USER_RESUMED", "RECOVER_ON_VOICE",
       "UNCERTAIN_SEND", "FAIL", "SKIP_FAILED", "ACK_RECOVERY", "SAVE_SETTINGS",
       "SAVE_COUNT_RATE_LIMIT"].includes(message.type) &&
      dueSchedules(state, Date.now(), queueLimit(store))) changed = true;

  if (changed) {
    store.conversations[key] = state;
    await saveStore(store);
    // Keep staged image references protected until durable queue persistence
    // succeeds. Only then can the normal queue own those originals.
    if (restoreTokenCompleted) pendingBackupRestores.delete(restoreTokenCompleted);
    if (["DELETE_TASK", "EDIT_TASK", "FINISHED", "STEER_CONFIRM",
         "DELETE_SCHEDULE", "EDIT_SCHEDULE", "IMPORT_LEGACY", "SKIP_FAILED"].includes(message.type)) {
      await cleanupUnusedImages(store);
    }
  }
  if (changed || message.type === "HELLO") await maintainTabProtection(store);
  return {
    ok: true, state, sessionKey: key, dispatch, tabId,
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
  if (state.halted || !state.autoOpenTab || !state.url ||
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
      const recovered = recoverObsoleteHalt(state);
      // Per-chat timers keep running while the user views a different chat.
      const scheduled = dueSchedules(state, Date.now(), queueLimit(store));
      const inconsistent = checkInFlightIntegrity(state);
      const timedOut = checkTimeout(state);
      const steerTimedOut = checkSteerTimeout(state);
      // A single failed tabs.query/reload/create must not abort scheduling for
      // every other conversation or discard this minute's newly due tasks.
      let reopened = false;
      try { reopened = await ensureTargetTab(state); }
      catch (error) {
        console.warn("[ChatQueue] 自动恢复标签失败，保留已排队任务并继续其他对话", error);
        const lastFailure = Array.isArray(state.history) ?
          state.history.filter((entry) => entry.type === "tab_reopen_failed").at(-1) : null;
        if (!lastFailure || Date.now() - lastFailure.at >= 10 * 60_000) {
          recordHistory(state, "tab_reopen_failed");
          changed = true;
        }
      }
      if (recovered || scheduled || inconsistent || timedOut || steerTimedOut || reopened) changed = true;
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
  await onScheduleTick();
  await exclusive(async () => cleanupUnusedImages(await readStore()));
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
});
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url) pagePulses.delete(tabId);
  if (changeInfo.status === "complete") {
    void processPendingVersionRefresh().catch((error) =>
      console.warn("[ChatQueue] 网页加载后的版本刷新检查失败", error));
  }
  if (!changeInfo.url) return;
  // Revoke our no-discard flag promptly if the protected tab navigates away.
  void exclusive(async () => maintainTabProtection(await readStore()))
    .catch((error) => console.warn("[ChatQueue] 标签导航后的保护同步失败，已保留队列数据", error));
});
chrome.tabs.onRemoved.addListener((tabId) => {
  pagePulses.delete(tabId);
  recentTabRevives.delete(tabId);
  recentTabOpens.delete(tabId);
  void exclusive(async () => maintainTabProtection(await readStore()))
    .catch((error) => console.warn("[ChatQueue] 标签关闭后的保护同步失败，已保留队列数据", error));
});
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Heartbeats never write durable queue state or enter the dispatch lock.
  const work = message?.type === "PAGE_PULSE"
    ? Promise.resolve().then(() => handlePagePulse(message, sender))
    : exclusive(() => FAVORITE_ACTIONS.has(message?.type)
      ? handleFavoriteMessage(message, sender)
      : ["DASHBOARD_GET", "DASHBOARD_SET_PAUSED",
         "DASHBOARD_REMOVE_CONVERSATION", "DASHBOARD_CLEANUP_IDLE"].includes(message?.type)
        ? handleDashboardMessage(message, sender) : handle(message, sender));
  work.then(sendResponse)
    .catch((error) => sendResponse({ ok: false, error: error.message || "未知错误" }));
  return true;
});
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id || !safeUrl(tab.url)) return;
  try { await chrome.tabs.sendMessage(tab.id, { type: "TOGGLE_PANEL" }); }
  catch { /* The ChatGPT tab might still be loading. */ }
});

// Recover missing alarms after service-worker termination/browser upgrades.
startSafely();
