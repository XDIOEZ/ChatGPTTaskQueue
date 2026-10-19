/* global chrome */
"use strict";

(() => {
  const root = document.getElementById("dashboard");
  if (!root) return;

  const list = document.getElementById("sessions");
  const search = document.getElementById("search");
  const projectSelect = document.getElementById("project-filter");
  const projectHealth = document.getElementById("project-health");
  const projectHealthToggle = document.getElementById("project-health-toggle");
  const projectHealthSummary = document.getElementById("project-health-summary");
  const projectHealthCards = document.getElementById("project-health-cards");
  const attention = document.getElementById("attention");
  const reviewAttention = document.getElementById("attention-review");
  const signalAttention = document.getElementById("attention-signal");
  const focusReviewButton = document.getElementById("focus-review");
  const updatedAt = document.getElementById("updated-at");
  const feedback = document.getElementById("feedback");
  const refreshButton = document.getElementById("refresh");
  const focusModeButton = document.getElementById("focus-mode");
  const focusTools = document.getElementById("focus-tools");
  const focusFilterSummary = document.getElementById("focus-filter-summary");
  const focusResetButton = document.getElementById("focus-reset");
  const focusAdvancedButton = document.getElementById("focus-advanced-toggle");
  const statShortcuts = [...document.querySelectorAll(".stat-shortcut")];
  const cleanupIdleButton = document.getElementById("cleanup-idle");
  const scanProgress = document.getElementById("scan-progress");
  const scanCurrent = document.getElementById("scan-current");
  const scanPrevButton = document.getElementById("scan-prev");
  const scanNextButton = document.getElementById("scan-next");
  const scanExitButton = document.getElementById("scan-exit");
  const quickJumpOpenButton = document.getElementById("quick-jump-open");
  const quickJumpDialog = document.getElementById("quick-jump-dialog");
  const quickJumpCloseButton = document.getElementById("quick-jump-close");
  const quickJumpQuery = document.getElementById("quick-jump-query");
  const quickJumpResults = document.getElementById("quick-jump-results");
  const quickJumpCount = document.getElementById("quick-jump-count");
  const sortSelect = document.getElementById("sort-order");
  const fullViewButton = document.getElementById("open-full-view");
  const favoritesOnlyButton = document.getElementById("favorites-only");
  const groupButton = document.getElementById("group-toggle");
  const projectGroupButton = document.getElementById("project-group-toggle");
  const layoutButton = document.getElementById("layout-toggle");
  const densityButton = document.getElementById("density-toggle");
  const VIEW_SETTINGS_KEY = "cq.dashboard.view.v1";
  const ALIASES_KEY = "cq.dashboard.aliases.v1";
  const PROJECTS_KEY = "cq.dashboard.projects.v1";
  const MAX_ALIAS_LENGTH = 48;
  const MAX_ALIASES = 250;
  const MAX_PROJECT_LENGTH = 24;
  const MAX_PROJECT_ASSIGNMENTS = 250;
  const MAX_FAVORITES = 100;
  const fullViewUrl = chrome.runtime.getURL("dashboard.html?view=full");
  const fullPage = new URL(location.href).searchParams.get("view") === "full";
  document.documentElement.dataset.view = fullPage ? "full" : "popup";
  let sessions = [];
  let selectedFilter = "all";
  let selectedSort = "priority";
  let favoritesOnly = false;
  let compactView = false;
  let layoutMode = "cards";
  let groupedView = false;
  let projectGroupedView = false;
  let projectFilter = "all";
  let projectHealthExpanded = false;
  let projectHealthTouched = false;
  let focusMode = false;
  let advancedControlsOpen = false;
  let favoriteKeys = new Set();
  let aliases = new Map();
  let projects = new Map();
  let aliasEditor = null;
  let savingAliasKey = null;
  let projectEditor = null;
  let savingProjectKey = null;
  const collapsedProjectGroups = new Set();
  let savingPreferences = false;
  const expandedActivities = new Set();
  const expandedDetails = new Set();
  const collapsedGroups = new Set();
  let lastSnapshot = "";
  let requestInProgress = false;
  let refreshRequested = false;
  const pendingKeys = new Set();
  let cleanupEligible = 0;
  let cleanupInProgress = false;
  // A disclosure is ephemeral UI state, never written to the queue store.
  let moreMenuKey = null;
  let scanKey = null;
  let quickJumpMatches = [];
  let quickJumpIndex = 0;
  let quickJumpReturnFocus = null;
  let quickJumpRestoreOnClose = true;
  const MAX_QUICK_JUMP_RESULTS = 12;
  const lastSessionSignatures = new Map();
  const changedSessions = new Map();
  const RECENT_CHANGE_MS = 8000;
  const attentionCursor = {review:null, signal:null};
  let locatedKey = null;
  let locatedUntil = 0;
  const LOCATED_MS = 7000;

  // UI-only preferences live separately from the queue store and never
  // change message dispatch, schedule order or conversation safety locks.
  const validFavoriteKey = (value) => typeof value === "string" &&
    /^(?:chat:[a-zA-Z0-9-]+|draft:\d+)$/.test(value);

  function normalizedAliases(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return new Map();
    const result = new Map();
    for (const [key, value] of Object.entries(raw)) {
      if (!validFavoriteKey(key) || typeof value !== "string" ||
          !value.trim() || value.length > MAX_ALIAS_LENGTH ||
          /[\u0000-\u001f\u007f]/.test(value)) continue;
      if (result.size === MAX_ALIASES) break;
      result.set(key,value.trim());
    }
    return result;
  }

  function normalizedProjects(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return new Map();
    const result = new Map();
    for (const [key, value] of Object.entries(raw)) {
      if (!validFavoriteKey(key) || typeof value !== "string" ||
          !value.trim() || value.length > MAX_PROJECT_LENGTH ||
          /[\u0000-\u001f\u007f]/.test(value)) continue;
      if (result.size >= MAX_PROJECT_ASSIGNMENTS) break;
      result.set(key,value.trim());
    }
    return result;
  }

  function applyProjects(raw) {
    projects = normalizedProjects(raw);
    render();
  }

  async function loadProjects() {
    try {
      if (!chrome.storage?.local?.get) return;
      const result = await chrome.storage.local.get(PROJECTS_KEY);
      applyProjects(result?.[PROJECTS_KEY]);
    } catch {
      showFeedback("本地项目标签暂时无法读取，其余队列管理仍可使用。",true);
    }
  }

  function applyAliases(raw) {
    aliases = normalizedAliases(raw);
    render();
  }

  async function loadAliases() {
    try {
      // Some minimal management-page environments have no storage adapter;
      // monitoring should still work without treating that as queue failure.
      if (!chrome.storage?.local?.get) return;
      const result = await chrome.storage.local.get(ALIASES_KEY);
      applyAliases(result?.[ALIASES_KEY]);
    } catch {
      showFeedback("无法读取本地对话备注，仍可继续使用队列管理。",true);
    }
  }

  function applyViewPreferences(saved) {
    favoriteKeys = new Set(
      (Array.isArray(saved?.favorites) ? saved.favorites : [])
        .filter(validFavoriteKey).slice(0, MAX_FAVORITES));
    compactView = saved?.compact === true;
    layoutMode = saved?.layout === "list" ? "list" : "cards";
    groupedView = saved?.grouped === true;
    projectGroupedView = saved?.projectGrouped === true && !groupedView;
    if (!projectHealthTouched) projectHealthExpanded = projectGroupedView;
    focusMode = saved?.focus === true;
    if (!focusMode) advancedControlsOpen = false;
    root.classList.toggle("compact-cards", compactView);
    root.classList.toggle("list-mode", layoutMode === "list");
    root.classList.toggle("grouped-mode", groupedView || projectGroupedView);
    root.classList.toggle("project-grouped-mode", projectGroupedView);
    groupButton.setAttribute("aria-pressed",String(groupedView));
    groupButton.textContent = groupedView ? "取消分组" : "状态分组";
    projectGroupButton.setAttribute("aria-pressed",String(projectGroupedView));
    projectGroupButton.textContent = projectGroupedView ? "取消项目分组" : "项目分组";
    layoutButton.setAttribute("aria-pressed",String(layoutMode === "list"));
    layoutButton.textContent = layoutMode === "list" ? "卡片视图" : "列表视图";
    layoutButton.title = layoutMode === "list" ? "切换回卡片布局" : "切换为单行监控列表（可展开详情）";
    densityButton.setAttribute("aria-pressed",String(compactView));
    densityButton.textContent = compactView ? "舒适视图" : "紧凑视图";
    updateFocusControls();
    render();
  }

  async function loadViewPreferences() {
    try {
      if (chrome.storage?.local?.get) {
        const saved = await chrome.storage.local.get(VIEW_SETTINGS_KEY);
        applyViewPreferences(saved?.[VIEW_SETTINGS_KEY]);
      }
    } catch (error) {
      showFeedback("未能读取管理视图偏好，仍可继续查看队列。",true);
    }
  }

  async function updateViewPreferences(
    nextFavorites, nextCompact, nextLayout = layoutMode,
    nextGrouped = groupedView, nextFocus = focusMode,
    nextProjectGrouped = projectGroupedView && !nextGrouped
  ) {
    if (savingPreferences) return false;
    savingPreferences = true;
    densityButton.disabled = true;
    layoutButton.disabled = true;
    groupButton.disabled = true;
    projectGroupButton.disabled = true;
    focusModeButton.disabled = true;
    render();
    try {
      const next = {
        favorites:[...nextFavorites].filter(validFavoriteKey).slice(0,MAX_FAVORITES),
        compact:nextCompact === true,
        layout:nextLayout === "list" ? "list" : "cards",
        grouped:nextGrouped === true,
        projectGrouped:nextProjectGrouped === true && nextGrouped !== true,
        focus:nextFocus === true,
      };
      if (chrome.storage?.local?.set) {
        await chrome.storage.local.set({[VIEW_SETTINGS_KEY]:next});
      }
      applyViewPreferences(next);
      return true;
    } catch (error) {
      showFeedback("视图偏好保存失败，请稍后重试。",true);
      render();
      return false;
    } finally {
      savingPreferences = false;
      densityButton.disabled = false;
      layoutButton.disabled = false;
      groupButton.disabled = false;
      projectGroupButton.disabled = false;
      focusModeButton.disabled = false;
      render();
    }
  }

  const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char]);

  function safeChatUrl(url) {
    try {
      const parsed = new URL(url);
      return parsed.protocol === "https:" &&
        ["chatgpt.com", "chat.openai.com"].includes(parsed.hostname) ? parsed.href : null;
    } catch { return null; }
  }

  function sessionStatus(session) {
    if (session.halted || session.review) return {type:"review",label:"需要人工核对"};
    if (session.active) {
      const stages = {
        dispatching:"正在发送", waiting:"等待回复",
        steering:"准备引导", steering_wait:"引导确认中",
      };
      return {type:"active",label:stages[session.activeStatus] || "执行中"};
    }
    if (session.queuePaused) return {type:"paused",label:"自动接力已暂停"};
    if (session.pending) return {type:"pending",label:"等待发送"};
    if (session.enabledRules) return {type:"rules",label:"自动规则待命"};
    return {type:"idle",label:"空闲"};
  }

  function browserLabel(browser) {
    return {
      loaded:"标签页已加载", loading:"页面加载中",
      discarded:"标签页已被丢弃", closed:"标签页未打开",
      unknown:"无法确认标签状态",
    }[browser] || "标签状态未知";
  }

  function pageSignalInfo(session) {
    if (session.browser === "closed") return {kind:"unavailable",text:"页面未打开 · 无心跳"};
    if (session.browser === "discarded") return {kind:"unavailable",text:"标签已休眠 · 无心跳"};
    if (session.browser === "loading") return {kind:"unavailable",text:"加载中 · 等待页面心跳"};
    if (session.browser === "unknown") return {kind:"unavailable",text:"暂时无法查询标签状态"};
    return {
      generating:{kind:"generating",text:"页面有响应 · 检测到停止按钮"},
      idle:{kind:"idle",text:"页面有响应 · 未检测到停止按钮"},
      stale:{kind:"stale",text:"页面信号已过期 · 可能休眠"},
      unknown:{kind:"unknown",text:"等待页面心跳 · 尚未收到报告"},
    }[session.pageSignal] || {kind:"unknown",text:"等待页面心跳 · 尚未收到报告"};
  }

  // Queue stage groups are derived only from saved task status. A missing
  // heartbeat is never silently reclassified as a failed task.
  const STATUS_GROUPS = Object.freeze([
    {id:"review",name:"需核对",hint:"请进入对应对话检查任务"},
    {id:"active",name:"执行中",hint:"队列阶段记录，不等于服务端实时生成"},
    {id:"paused",name:"已暂停",hint:"后续自动接力已暂停"},
    {id:"pending",name:"待发送",hint:"有等待领取的队列任务"},
    {id:"rules",name:"自动规则待命",hint:"启用规则等待触发"},
    {id:"idle",name:"空闲",hint:"当前无待处理的队列任务"},
  ]);

  function originalName(session) {
    if (session.title && !/^(?:ChatGPT|OpenAI)$/i.test(session.title)) {
      return session.title;
    }
    if (session.key.startsWith("draft:")) return "未命名新对话";
    return "ChatGPT 对话 " + session.key.slice(5, 13);
  }

  function friendlyName(session) {
    return aliases.get(session.key) || originalName(session);
  }

  function projectFor(session) {
    return projects.get(session.key) || "";
  }

  function projectGroupKey(session) {
    return projectFor(session) ? "project:" + projectFor(session) : "none";
  }

  function syncProjectSelector() {
    // Derive choices from actual saved conversations, not orphaned metadata.
    const names = [...new Set(sessions.map(projectFor).filter(Boolean))]
      .sort((a,b)=>a.localeCompare(b,"zh-CN"));
    const signature = JSON.stringify(names);
    if (projectSelect.dataset.optionsSignature !== signature) {
      projectSelect.replaceChildren();
      for (const [value,label] of [["all","全部项目"],["none","未分组"],
        ...names.map((name)=>["project:"+name,name])]) {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = label;
        projectSelect.append(option);
      }
      projectSelect.dataset.optionsSignature = signature;
    }
    if (![...projectSelect.options].some((option)=>option.value === projectFilter)) {
      projectFilter = "all";
    }
    if (projectSelect.value !== projectFilter) projectSelect.value = projectFilter;
    projectSelect.title = projectFilter === "all" ? "全部项目" :
      projectFilter === "none" ? "未分组对话" : projectFilter.slice(8);
  }

  function projectFilterMatches(session) {
    return projectFilter === "all" ||
      projectGroupKey(session) === projectFilter;
  }

  function summarizeProject(key, members) {
    const count = (field) => members.reduce((total, session) =>
      total + Math.max(0, Number(session[field]) || 0), 0);
    return {
      key,
      name:key === "none" ? "未分组" : key.slice(8),
      conversations:members.length,
      pending:count("pending"),
      active:count("active"),
      reviewTasks:count("review"),
      reviewChats:members.filter((session)=>session.review > 0 || session.halted).length,
      signalChats:members.filter((session)=>session.active > 0 &&
        session.browser === "loaded" &&
        ["unknown","stale"].includes(session.pageSignal || "unknown")).length,
    };
  }

  function allProjectSummaries() {
    const grouped = new Map();
    for (const session of sessions) {
      const key = projectGroupKey(session);
      if (!grouped.has(key)) grouped.set(key,[]);
      grouped.get(key).push(session);
    }
    return [...grouped].map(([key,members])=>summarizeProject(key,members))
      .sort((a,b)=>b.reviewChats - a.reviewChats ||
        b.active - a.active ||
        b.pending - a.pending ||
        (a.key === "none" ? 1 : b.key === "none" ? -1 :
          a.name.localeCompare(b.name,"zh-CN")));
  }

  function renderProjectHealth() {
    const summaries = allProjectSummaries();
    const named = summaries.filter((entry)=>entry.key !== "none");
    projectHealth.hidden = named.length === 0;
    if (projectHealth.hidden) {
      projectHealthCards.hidden = true;
      return;
    }
    const reviewTotal = summaries.reduce((total,entry)=>total + entry.reviewChats,0);
    const runningProjects = named.filter((entry)=>entry.active > 0).length;
    projectHealthSummary.textContent = named.length + " 个项目 · " +
      (reviewTotal ? reviewTotal + " 个对话需核对" : "无待核对对话") +
      " · " + runningProjects + " 个项目执行中";
    projectHealthToggle.setAttribute("aria-expanded",String(projectHealthExpanded));
    projectHealthToggle.querySelector(".project-health-chevron").textContent =
      projectHealthExpanded ? "⌃" : "⌄";
    projectHealthCards.hidden = !projectHealthExpanded;
    if (!projectHealthExpanded) return;

    // Avoid rebuilding focused buttons on every 2.5-second snapshot tick.
    const signature = JSON.stringify([summaries,projectFilter,selectedFilter]);
    if (projectHealthCards.dataset.signature === signature) return;
    const focused = document.activeElement;
    const focusedKey = projectHealthCards.contains(focused)
      ? focused.dataset.projectOpen || focused.dataset.projectReview : null;
    const focusedType = focused?.dataset.projectReview ? "projectReview" : "projectOpen";
    const scrollLeft = projectHealthCards.scrollLeft;
    const fragment = document.createDocumentFragment();
    const create = (tag,className,text) => {
      const element = document.createElement(tag);
      element.className = className;
      element.textContent = text;
      return element;
    };
    for (const entry of summaries) {
      const selected = projectFilter === entry.key;
      const card = create("div","project-health-card" +
        (entry.reviewChats ? " has-review" : "") +
        (selected ? " is-filtered" : ""),"");
      card.dataset.projectHealthKey = entry.key;
      const main = create("button","project-health-jump","");
      main.type = "button";
      main.dataset.projectOpen = entry.key;
      main.setAttribute("aria-pressed",String(selected && selectedFilter === "all"));
      main.setAttribute("aria-label","查看" + entry.name +
        "，共 " + entry.conversations + " 个对话，待发送 " +
        entry.pending + " 条任务，执行中 " + entry.active + " 条任务");
      main.title = "只看此项目；再次点击恢复全部项目";
      main.append(create("span","project-health-name",entry.name),
        create("span","project-health-amount",entry.conversations + " 对话"));
      const metrics = create("span","project-health-metrics","");
      metrics.append(create("span","", "待 " + entry.pending),
        create("span","", "执 " + entry.active));
      main.append(metrics);
      card.append(main);
      if (entry.reviewChats) {
        const review = create("button","project-health-review",
          "需核对 " + entry.reviewChats + " 对话");
        review.type = "button";
        review.dataset.projectReview = entry.key;
        review.setAttribute("aria-pressed",
          String(selected && selectedFilter === "review"));
        review.setAttribute("aria-label","查看" + entry.name + "项目中 " +
          entry.reviewChats + " 个需要人工核对的对话");
        review.title = "仅查看确实需要人工核对的队列对话";
        card.append(review);
      }
      if (entry.signalChats) {
        const signal = create("span","project-health-signal",
          "心跳待确认 " + entry.signalChats);
        signal.title = "页面信号不足，不表示任务失败";
        card.append(signal);
      }
      fragment.append(card);
    }
    projectHealthCards.replaceChildren(fragment);
    projectHealthCards.dataset.signature = signature;
    projectHealthCards.scrollLeft = scrollLeft;
    if (focusedKey) {
      [...projectHealthCards.querySelectorAll("button[data-project-open],button[data-project-review]")]
        .find((button)=>button.dataset[focusedType] === focusedKey)
        ?.focus({preventScroll:true});
    }
  }

  function chooseProjectFromOverview(key, reviewOnly) {
    const scope = allProjectSummaries().find((entry)=>entry.key === key);
    if (!scope || reviewOnly && !scope.reviewChats) return;
    const clear = !reviewOnly && projectFilter === key && selectedFilter === "all" &&
      !favoritesOnly && !search.value.trim();
    projectFilter = clear ? "all" : key;
    selectedFilter = reviewOnly ? "review" : "all";
    search.value = "";
    favoritesOnly = false;
    collapsedProjectGroups.delete(key);
    if (reviewOnly) collapsedGroups.delete("review");
    render();
    list.scrollTop = 0;
    showFeedback(clear ? "已恢复所有项目。" :
      reviewOnly ? "正在查看「" + scope.name + "」中 " + scope.reviewChats +
        " 个需人工核对的对话；没有更改任务队列。" :
        "正在查看「" + scope.name + "」的全部 " + scope.conversations +
        " 个对话；没有更改任务队列。");
  }

  function sessionSubtitle(session) {
    const id = session.key.startsWith("chat:")
      ? session.key.slice(5, 23) : session.key;
    return aliases.has(session.key) ? originalName(session) + " · " + id : id;
  }

  const FILTER_NAMES = Object.freeze({
    all:"全部对话", changed:"刚变化", busy:"有工作",
    pending:"待发送", active:"执行中", review:"需核对",
    paused:"已暂停", nosignal:"无心跳", offline:"离线",
  });
  const SORT_NAMES = Object.freeze({
    recent:"最近动作优先", pending:"待发送优先", name:"名称排序",
  });

  function updateFocusControls() {
    root.classList.toggle("focus-mode",focusMode);
    root.classList.toggle("focus-advanced",focusMode && advancedControlsOpen);
    focusModeButton.setAttribute("aria-pressed",String(focusMode));
    focusModeButton.textContent = focusMode ? "退出专注" : "专注";
    focusModeButton.title = focusMode ?
      "恢复完整筛选和舒适监控布局" : "收起次要控件，让更多对话同时可见";
    focusTools.hidden = !focusMode;
    focusAdvancedButton.setAttribute("aria-expanded",String(advancedControlsOpen));
    focusAdvancedButton.textContent = advancedControlsOpen ? "收起筛选" : "显示筛选";
    const summary = [];
    if (selectedFilter !== "all") {
      summary.push(FILTER_NAMES[selectedFilter] || "状态筛选");
    }
    if (favoritesOnly) summary.push("仅重点");
    if (projectFilter !== "all") {
      summary.push(projectFilter === "none" ? "未分组" :
        "项目：" + projectFilter.slice(8));
    }
    if (search.value.trim()) summary.push("搜索中");
    if (selectedSort !== "priority") {
      summary.push(SORT_NAMES[selectedSort] || "自定义排序");
    }
    focusFilterSummary.textContent = summary.length ?
      "当前：" + summary.join(" · ") : "当前：全部对话";
    focusFilterSummary.title = focusFilterSummary.textContent;
    focusResetButton.hidden = !(
      selectedFilter !== "all" || favoritesOnly || search.value.trim() ||
      projectFilter !== "all"
    );
  }

  function changeSignature(session) {
    // Ignore titles and browser window focus. Only meaningful persisted
    // progress/status transitions receive the temporary change highlight.
    return JSON.stringify([
      session.pending,session.active,session.review,
      session.enabledRules,session.allRules,session.queuePaused,
      session.halted,session.activeStatus,session.browser,session.lastEventAt,
      session.pageSignal,
    ]);
  }

  function acceptSnapshot(nextSessions) {
    const previouslyObserved = lastSnapshot !== "";
    // New safety stops must not remain hidden inside a collapsed category.
    if (previouslyObserved && collapsedGroups.has("review")) {
      const oldReviewKeys = new Set(sessions
        .filter((session) => sessionStatus(session).type === "review")
        .map((session) => session.key));
      if (nextSessions.some((session) =>
        sessionStatus(session).type === "review" && !oldReviewKeys.has(session.key))) {
        collapsedGroups.delete("review");
      }
    }
    // Project sections follow the same safety principle: a newly emerged
    // manual-review case must not remain hidden in a folded project.
    // Heartbeat loss alone never triggers this rule.
    if (previouslyObserved && projectGroupedView && collapsedProjectGroups.size) {
      const previousReview = new Set(sessions
        .filter((session)=>session.review > 0 || session.halted)
        .map((session)=>session.key));
      for (const session of nextSessions) {
        if ((session.review > 0 || session.halted) &&
            !previousReview.has(session.key)) {
          collapsedProjectGroups.delete(projectGroupKey(session));
        }
      }
    }
    const present = new Set();
    for (const session of nextSessions) {
      present.add(session.key);
      const signature = changeSignature(session);
      if (previouslyObserved && lastSessionSignatures.get(session.key) !== signature) {
        changedSessions.set(session.key,Date.now());
      }
      lastSessionSignatures.set(session.key,signature);
    }
    for (const key of lastSessionSignatures.keys()) {
      if (!present.has(key)) {
        lastSessionSignatures.delete(key);
        changedSessions.delete(key);
      }
    }
    sessions = nextSessions;
    if (moreMenuKey && !nextSessions.some((item) => item.key === moreMenuKey)) {
      moreMenuKey = null;
    }
    lastSnapshot = JSON.stringify(nextSessions);
  }

  function pruneChangedSessions() {
    let pruned = false;
    for (const [key, at] of changedSessions) {
      if (Date.now() - at >= RECENT_CHANGE_MS) {
        changedSessions.delete(key);
        pruned = true;
      }
    }
    return pruned;
  }

  function elapsedLabel(value, mode = "event") {
    if (!Number.isFinite(value) || value <= 0) return "时间未知";
    const seconds = Math.max(0,Math.floor((Date.now() - value) / 1000));
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);
    if (mode === "pulse" && !minutes) return seconds + " 秒前";
    if (mode === "stage") {
      if (!minutes) return `约 ${seconds} 秒`;
      if (!hours) return `约 ${minutes} 分 ${String(seconds % 60).padStart(2,"0")} 秒`;
      if (!days) return `约 ${hours} 小时 ${minutes % 60} 分`;
      return `约 ${days} 天 ${hours % 24} 小时`;
    }
    if (!minutes) return "刚刚";
    if (!hours) return `${minutes} 分钟前`;
    if (!days) return `${hours} 小时前`;
    return `${days} 天前`;
  }

  function updateRelativeTimes() {
    for (const element of list.querySelectorAll("[data-time]")) {
      const time = Number(element.dataset.time);
      const kind = element.dataset.timeKind;
      element.textContent = (kind === "stage" ? "当前阶段记录已持续 " :
        kind === "activity" ? "" :
        kind === "pulse" ? "最近心跳 " : "最近队列操作 ") + elapsedLabel(time,kind);
    }
  }

  function statusMatches(session, filter) {
    switch (filter) {
      case "all": return true;
      case "changed": return changedSessions.has(session.key);
      case "busy": return Boolean(session.pending || session.active || session.review ||
        session.halted || session.enabledRules);
      case "pending": return session.pending > 0;
      case "active": return session.active > 0;
      case "review": return Boolean(session.review || session.halted);
      case "paused": return session.queuePaused === true;
      case "nosignal": return session.browser === "loaded" &&
        ["unknown","stale"].includes(session.pageSignal || "unknown");
      case "offline": return ["closed","discarded","unknown"].includes(session.browser);
      default: return false;
    }
  }

  function syncFilterIndicators() {
    // The large values above are task totals; filter counts below are
    // conversation totals. Keep these meanings separate for accessibility.
    for (const button of document.querySelectorAll("#filters button[data-filter]")) {
      const filter = button.dataset.filter;
      const count = sessions.filter((session) => statusMatches(session,filter)).length;
      button.setAttribute("aria-pressed",String(selectedFilter === filter));
      const label = FILTER_NAMES[filter] || "状态";
      button.title = label + " · " + count + " 个对话";
      let indicator = button.querySelector(".filter-count");
      if (!indicator) {
        indicator = document.createElement("small");
        indicator.className = "filter-count";
        indicator.setAttribute("aria-hidden","true");
        button.append(indicator);
      }
      indicator.textContent = String(count);
    }
    for (const button of statShortcuts) {
      const filter = button.dataset.statFilter;
      const count = sessions.filter((session) => statusMatches(session,filter)).length;
      const pressed = selectedFilter === filter;
      button.setAttribute("aria-pressed",String(pressed));
      const label = FILTER_NAMES[filter] || "对话";
      const value = button.querySelector("strong")?.textContent || "—";
      const unit = filter === "busy" ? "个有工作的对话" : "条任务";
      button.setAttribute("aria-label",label + " " + value + " " + unit +
        "，共涉及 " + count + " 个对话。" +
        (pressed ? "点击恢复全部状态" : "点击查看对应对话"));
    }
  }

  function matchingSessions() {
    const term = search.value.trim().toLocaleLowerCase();
    return sessions.filter((session) => {
      return statusMatches(session,selectedFilter) &&
        projectFilterMatches(session) &&
        (!favoritesOnly || favoriteKeys.has(session.key)) &&
        (!term || [friendlyName(session),originalName(session),projectFor(session),session.key,session.url]
        .some((value) => String(value || "").toLocaleLowerCase().includes(term)));
    }).sort((a,b) => {
      const favoriteDifference = Number(favoriteKeys.has(b.key)) -
        Number(favoriteKeys.has(a.key));
      if (favoriteDifference) return favoriteDifference;
      if (selectedSort === "recent") {
        const difference = (Number(b.lastEventAt) || 0) - (Number(a.lastEventAt) || 0);
        if (difference) return difference;
      } else if (selectedSort === "pending") {
        const difference = b.pending - a.pending;
        if (difference) return difference;
      } else if (selectedSort === "name") {
        return friendlyName(a).localeCompare(friendlyName(b),"zh-CN") ||
          a.key.localeCompare(b.key);
      }
      const rank = (entry) => entry.halted || entry.review ? 0 :
        entry.active ? 1 : entry.pending ? 2 : entry.queuePaused ? 3 :
        entry.enabledRules ? 4 : 5;
      return rank(a) - rank(b) ||
        friendlyName(a).localeCompare(friendlyName(b),"zh-CN");
    });
  }

  function attentionTargets(kind) {
    return sessions.filter((session) => {
      if (kind === "review") return sessionStatus(session).type === "review";
      if (kind === "signal") {
        return sessionStatus(session).type === "active" &&
          session.browser === "loaded" &&
          ["unknown","stale"].includes(session.pageSignal || "unknown");
      }
      return false;
    }).sort((a,b) =>
      Number(favoriteKeys.has(b.key)) - Number(favoriteKeys.has(a.key)) ||
      (Number(b.lastEventAt) || 0) - (Number(a.lastEventAt) || 0) ||
      a.key.localeCompare(b.key));
  }

  function updateAttention() {
    const reviews = attentionTargets("review");
    const signals = attentionTargets("signal");
    const priorityReviews = reviews.filter((session) => favoriteKeys.has(session.key));
    const focusActive = selectedFilter === "review" && favoritesOnly;
    // Keep the exit button available after the last focused issue is fixed.
    // Otherwise a user could be stranded in an empty filtered view.
    reviewAttention.hidden = reviews.length === 0 && !focusActive;
    signalAttention.hidden = signals.length === 0;
    attention.hidden = reviewAttention.hidden && signalAttention.hidden;
    document.getElementById("attention-review-count").textContent =
      reviews.length + " 个对话需要人工核对";
    document.getElementById("attention-review-hint").textContent =
      priorityReviews.length
        ? "其中 ★ " + priorityReviews.length + " 个重点对话 · 需进入原对话核实"
        : "来自队列存档，必须进入原对话核实";
    focusReviewButton.hidden = priorityReviews.length === 0 && !focusActive;
    focusReviewButton.setAttribute("aria-pressed",String(focusActive));
    focusReviewButton.textContent = focusActive ? "显示全部" :
      "★ 重点 " + priorityReviews.length;
    focusReviewButton.title = focusActive
      ? "退出重点异常视图，显示所有对话"
      : "一键只看标记为重点且需要人工核对的对话";
    document.getElementById("attention-signal-count").textContent =
      signals.length + " 个执行中对话的心跳待确认";
    for (const [kind, items] of [["review", reviews],["signal", signals]]) {
      const button = document.getElementById(kind === "review" ? "jump-review" : "jump-signal");
      button.disabled = items.length === 0;
      if (!items.length) continue;
      const last = items.findIndex((session) => session.key === attentionCursor[kind]);
      const nextNumber = (last + 1) % items.length + 1;
      button.textContent = "定位下一项 · " + nextNumber + "/" + items.length;
      button.setAttribute("aria-label", (kind === "review" ? "定位下一个需人工核对的对话" :
        "定位下一个页面心跳待确认的执行中对话") +
        "，第 " + nextNumber + " 个，共 " + items.length + " 个");
    }
  }

  function togglePriorityReview() {
    const active = selectedFilter === "review" && favoritesOnly;
    const prioritized = attentionTargets("review")
      .filter((session) => favoriteKeys.has(session.key));
    if (!active && !prioritized.length) return;

    selectedFilter = active ? "all" : "review";
    favoritesOnly = !active;
    search.value = "";
    projectFilter = "all";
    if (!active) {
      collapsedGroups.delete("review");
      collapsedProjectGroups.delete(projectGroupKey(prioritized[0]));
      locatedKey = prioritized[0].key;
      locatedUntil = Date.now() + LOCATED_MS;
    } else {
      locatedKey = null;
    }
    for (const button of document.querySelectorAll("#filters button")) {
      button.setAttribute("aria-pressed",String(button.dataset.filter === selectedFilter));
    }
    render();
    list.scrollTop = 0;
    showFeedback(active
      ? "已退出重点异常视图，重新显示所有对话。"
      : "正在显示 " + prioritized.length +
        " 个重点且需人工核对的对话；不会改变原有队列。");
  }

  function expireLocated() {
    if (!locatedKey || Date.now() < locatedUntil) return false;
    locatedKey = null;
    return true;
  }

  function jumpAttention(kind) {
    const targets = attentionTargets(kind);
    if (!targets.length) return;
    const previous = targets.findIndex((session) => session.key === attentionCursor[kind]);
    const target = targets[(previous + 1) % targets.length];
    attentionCursor[kind] = target.key;

    // The explicit jump is allowed to clear display-only filters. Never touch
    // durable conversation state, scheduling order, or recovery locks.
    const hadFilter = Boolean(search.value || selectedFilter !== "all" ||
      favoritesOnly || projectFilter !== "all");
    search.value = "";
    selectedFilter = "all";
    favoritesOnly = false;
    projectFilter = "all";
    for (const button of document.querySelectorAll("#filters button")) {
      button.setAttribute("aria-pressed",String(button.dataset.filter === "all"));
    }
    collapsedGroups.delete(sessionStatus(target).type);
    collapsedProjectGroups.delete(projectGroupKey(target));
    locatedKey = target.key;
    locatedUntil = Date.now() + LOCATED_MS;
    render();
    const card = [...list.querySelectorAll(".session")]
      .find((element) => element.dataset.key === target.key);
    if (!card) {
      showFeedback("没有找到对应的对话卡片，请刷新管理页后再试。",true);
      return;
    }
    const index = targets.findIndex((session) => session.key === target.key) + 1;
    showFeedback((hadFilter ? "已清除筛选，" : "") +
      "已定位 " + (kind === "review" ? "需核对" : "心跳待确认") +
      " " + index + "/" + targets.length + "：" + friendlyName(target));
    const focusTarget = card.querySelector('button[data-action="open"]:not([disabled])') ||
      card.querySelector('button[data-action="favorite"]:not([disabled])');
    focusTarget?.focus({preventScroll:true});
    card.scrollIntoView({block:"center",inline:"nearest"});
  }

  const EVENT_LABELS = Object.freeze({
    manual_enqueue:"手动任务入队", auto_count:"数量规则补队",
    auto_time:"时间规则入队", claim:"领取任务", sent:"已点击发送",
    finished:"回复完成，任务出队", deferred:"发送条件尚未就绪",
    send_failed:"发送失败，需要检查", timeout:"等待超时",
    steer_timeout:"引导确认超时", task_edited:"修改队列任务",
    task_deleted:"删除队列任务", task_pinned:"任务置顶",
    task_reordered:"调整任务顺序", steer_claim:"锁定引导任务",
    steer_clicked:"已尝试引导发送", steer_cancel:"取消引导",
    steer_confirm:"引导已确认", steer_uncertain:"引导结果未确认",
    state_inconsistent:"异常中断，等待核对", tab_revived:"恢复被丢弃的标签",
    tab_reopened:"后台打开对话标签", tab_owner_rebound:"切换正常对话标签",
    tab_reopen_failed:"后台恢复标签失败", user_stopped:"用户停止生成",
    user_resumed:"用户恢复对话", auto_recovered:"技术暂停自动解除",
    failed_skipped:"人工跳过不确定任务", review_confirmed:"人工确认继续",
    schedule_added:"创建自动规则", schedule_edited:"编辑自动规则",
    schedule_deleted:"删除自动规则", schedule_toggled:"切换规则启停",
    queue_paused:"暂停自动接力", queue_resumed:"继续自动接力",
    rate_limit_updated:"更新数量补队限制",
    send_cooldown_updated:"修改对话发送冷却",
    backup_restored:"从备份恢复",
  });

  function renderActivity(session) {
    const events = Array.isArray(session.recentEvents)
      ? session.recentEvents.slice(0, 5) : [];
    const expanded = expandedActivities.has(session.key);
    return `<div class="session-activity">
      <button type="button" class="activity-toggle" data-action="activity"
        data-key="${escapeHtml(session.key)}"
        aria-expanded="${expanded}" title="仅显示本地运行事件类型，不显示任务内容">
        <span>${expanded ? "收起近期活动" : "查看近期活动"}${events.length ? ` · ${events.length} 条` : ""}</span>
        <span aria-hidden="true">${expanded ? "⌃" : "⌄"}</span>
      </button>
      ${expanded ? `<ol class="activity-timeline" aria-label="最近队列操作记录">
        ${events.length ? events.map((entry) => `
          <li>
            <span class="activity-event-name">${escapeHtml(
              EVENT_LABELS[entry.type] || "队列事件")}</span>
            <time data-time="${Number(entry.at) || 0}" data-time-kind="activity"
              title="此时间来自已保存的队列运行日志">
              ${elapsedLabel(entry.at)}</time>
          </li>`).join("") :
        '<li class="activity-empty">暂无近期队列操作记录</li>'}
      </ol>` : ""}
    </div>`;
  }

  function renderFavoriteButton(session) {
    const favorite = favoriteKeys.has(session.key);
    return `<button type="button" class="favorite-toggle" data-action="favorite"
      data-key="${escapeHtml(session.key)}" aria-pressed="${favorite}"
      ${savingPreferences ? "disabled" : ""}
      title="${favorite ? "取消重点标记" : "标记为重点对话（仅影响管理页）"}"
      aria-label="${favorite ? "取消此对话的重点标记" : "把此对话标记为重点"}">
      ${favorite ? "★" : "☆"}
    </button>`;
  }

  function renderProjectChip(session) {
    const name = projectFor(session);
    return name ? '<span class="project-chip" title="本地项目：' +
      escapeHtml(name) + '">' + escapeHtml(name) + '</span>' : "";
  }

  function renderSessionActions(session, short = false) {
    const busy = pendingKeys.has(session.key);
    const cantResume = session.queuePaused && session.halted;
    const trustedUrl = safeChatUrl(session.url);
    const openWork = session.browser !== "closed" &&
      hasWorkToDiscard(session);
    const cantRemove = busy || session.browser === "unknown" || openWork;
    const expanded = moreMenuKey === session.key;
    const menuId = "session-more-" + escapeHtml(session.key);
    const editingAlias = expanded && aliasEditor?.key === session.key;
    const aliasBusy = savingAliasKey === session.key;
    const aliasValue = aliases.get(session.key) || "";
    const editingProject = expanded && projectEditor?.key === session.key;
    const projectBusy = savingProjectKey === session.key;
    const projectValue = projectFor(session);
    const projectChoices = editingProject ? [...new Set(projects.values())]
      .filter((name)=>name !== projectValue)
      .sort((a,b)=>a.localeCompare(b,"zh-CN")) : [];
    const moreHint = session.browser === "unknown"
      ? "无法确认标签状态，暂不允许移除记录"
      : openWork
        ? "该对话仍在运行或有未完成工作，请先关闭原标签页"
        : "仅管理插件本地记录，不删除 ChatGPT 聊天";
    return `<div class="session-actions">
      <button type="button" data-action="pause" data-key="${escapeHtml(session.key)}"
        ${busy || cantResume ? "disabled" : ""}
        aria-label="${session.queuePaused ? "继续" : "暂停"}此对话的后续自动发送"
        title="${cantResume ? "需进入对话人工核对后才能继续" :
          session.queuePaused ? "恢复领取后续任务，不强制发送当前任务" :
            "暂停领取下一条任务，当前消息不会被打断"}">
        ${busy ? "处理中…" : session.queuePaused ?
          (short ? "继续" : "继续接力") : (short ? "暂停" : "暂停接力")}
      </button>
      <button type="button" class="primary" data-action="open"
        data-key="${escapeHtml(session.key)}" ${trustedUrl ? "" : "disabled"}
        aria-label="在浏览器中打开此对话">打开对话</button>
      <button type="button" class="session-more-toggle" data-action="more"
        data-key="${escapeHtml(session.key)}" aria-expanded="${expanded}"
        aria-controls="${menuId}" title="更多对话管理操作"
        aria-label="${expanded ? "收起" : "展开"}${escapeHtml(friendlyName(session))}的更多操作">
        更多 <span aria-hidden="true">${expanded ? "⌃" : "⌄"}</span>
      </button>
      <div class="session-more-panel" id="${menuId}" ${expanded ? "" : "hidden"}>
        <span class="session-more-note">${moreHint}</span>
        <div class="session-more-buttons">
          <button type="button" data-action="alias-edit"
            data-key="${escapeHtml(session.key)}" aria-expanded="${editingAlias}"
            ${aliasBusy || savingProjectKey || projectEditor ? "disabled" : ""}
            title="为此对话设置仅插件管理中心可见的备注名称">
            ${aliasValue ? "修改备注" : "设置备注"}
          </button>
          <button type="button" data-action="project-edit"
            data-key="${escapeHtml(session.key)}" aria-expanded="${editingProject}"
            ${projectBusy || savingAliasKey || aliasEditor ? "disabled" : ""}
            title="选择现有项目或输入新项目名称，只影响管理页">
            ${projectValue ? "更换项目" : "设置项目"}
          </button>
          <button type="button" class="remove-record" data-action="remove"
            data-key="${escapeHtml(session.key)}" ${cantRemove || aliasBusy || projectBusy ? "disabled" : ""}
            aria-label="从插件中移除 ${escapeHtml(friendlyName(session))} 的本地记录"
            title="${session.browser === "unknown" ? "无法确认标签状态，暂不允许删除" :
              openWork ? "仍在打开且含任务或规则，请先关闭原对话标签页" :
              "移除本地队列记录；不会删除 ChatGPT 官方聊天"}">
            ${busy ? "处理中…" : "移除本地记录"}
          </button>
        </div>
        ${editingAlias ? `<div class="session-alias-editor">
          <label for="alias-input-${escapeHtml(session.key)}">本地备注名称（最多 ${MAX_ALIAS_LENGTH} 字）</label>
          <input type="text" id="alias-input-${escapeHtml(session.key)}"
            data-alias-input data-key="${escapeHtml(session.key)}"
            maxlength="${MAX_ALIAS_LENGTH}" autocomplete="off" spellcheck="false"
            placeholder="如：主线剧情 / 战斗系统"
            value="${escapeHtml(aliasEditor.value)}" ${aliasBusy ? "disabled" : ""}>
          <div class="alias-editor-actions">
            <span>留空保存可恢复原标题</span>
            <button type="button" data-action="alias-cancel"
              data-key="${escapeHtml(session.key)}" ${aliasBusy ? "disabled" : ""}>取消</button>
            <button type="button" class="alias-save" data-action="alias-save"
              data-key="${escapeHtml(session.key)}" ${aliasBusy ? "disabled" : ""}>
              ${aliasBusy ? "保存中…" : "保存备注"}
            </button>
          </div>
        </div>` : ""}
        ${editingProject ? `<div class="session-project-editor">
          <label for="project-input-${escapeHtml(session.key)}">本地项目（最多 ${MAX_PROJECT_LENGTH} 字）</label>
          <input type="text" id="project-input-${escapeHtml(session.key)}"
            data-project-input data-key="${escapeHtml(session.key)}"
            list="project-options-${escapeHtml(session.key)}"
            maxlength="${MAX_PROJECT_LENGTH}" autocomplete="off" spellcheck="false"
            placeholder="输入项目名称或选择已有项目"
            value="${escapeHtml(projectEditor.value)}" ${projectBusy ? "disabled" : ""}>
          <datalist id="project-options-${escapeHtml(session.key)}">
            ${projectChoices.map((name)=>`<option value="${escapeHtml(name)}"></option>`).join("")}
          </datalist>
          <div class="project-editor-actions">
            <span>留空保存为未分组；不会影响队列或官方聊天</span>
            <button type="button" data-action="project-cancel"
              data-key="${escapeHtml(session.key)}" ${projectBusy ? "disabled" : ""}>取消</button>
            <button type="button" class="project-save" data-action="project-save"
              data-key="${escapeHtml(session.key)}" ${projectBusy ? "disabled" : ""}>
              ${projectBusy ? "保存中…" : "保存项目"}
            </button>
          </div>
        </div>` : ""}
      </div>
    </div>`;
  }

  function renderCard(session) {
    const status = sessionStatus(session);
    const signal = pageSignalInfo(session);
    const metrics = [
      ["待发送",session.pending], ["执行中",session.active],
      ["需核对",session.review], ["启用规则",session.enabledRules],
    ];
    const updated = changedSessions.has(session.key);
    const favorite = favoriteKeys.has(session.key);
    return `<article class="session${status.type === "review" ? " needs-review" : ""}${updated ? " recently-changed" : ""}${favorite ? " favorite" : ""}${favorite && status.type === "review" ? " priority-review" : ""}"
      data-key="${escapeHtml(session.key)}" aria-label="${escapeHtml(friendlyName(session))}">
      <div class="session-head">
        ${renderFavoriteButton(session)}
        <div class="session-head-copy">
          <div class="session-title" title="${escapeHtml(friendlyName(session))}">${escapeHtml(friendlyName(session))}</div>
          <div class="session-title-meta">
            <span class="session-id" title="${escapeHtml(sessionSubtitle(session))}">${escapeHtml(sessionSubtitle(session))}</span>
            ${renderProjectChip(session)}
          </div>
        </div>
        <span class="status ${status.type === "review" ? "review" :
          status.type === "active" ? "active" : ""}">${status.label}</span>
        ${favorite && status.type === "review" ?
          '<span class="priority-marker" title="已设为重点且需要人工核对">★ 重点</span>' : ""}
        ${updated ? '<span class="change-pill" title="本管理页最近观察到此对话的队列状态变化">有变化</span>' : ""}
      </div>
      <div class="session-metrics">
        ${metrics.map(([label,count]) => `<span class="metric">${label} <strong>${count}</strong></span>`).join("")}
      </div>
      <div class="session-meta">
        <span>${browserLabel(session.browser)}</span>
        <span>自动规则 ${session.enabledRules}/${session.allRules}</span>
      </div>
      <div class="session-page-signal ${signal.kind}"
        title="来自当前标签页的临时检测信号；停止按钮不保证服务端仍在生成，信号过期也不代表任务失败">
        <span>${signal.text}</span>
        ${Number.isFinite(session.pageSignalAt) && session.pageSignalAt > 0 ?
          `<time data-time="${session.pageSignalAt}" data-time-kind="pulse"
            title="插件最近收到当前标签页信号的时间">最近心跳 ${elapsedLabel(session.pageSignalAt,"pulse")}</time>` : ""}
      </div>
      <div class="session-times">
        ${Number.isFinite(session.activeSince) && session.activeSince > 0 ?
          `<span data-time="${session.activeSince}" data-time-kind="stage"
            title="仅根据最后持久化的任务时间推算，不代表网页仍在运行">
            当前阶段记录已持续 ${elapsedLabel(session.activeSince,"stage")}</span>` : ""}
        ${Number.isFinite(session.lastEventAt) && session.lastEventAt > 0 ?
          `<span data-time="${session.lastEventAt}" data-time-kind="event"
            title="本对话最近一次写入运行日志的时间，不代表浏览器心跳">
            最近队列操作 ${elapsedLabel(session.lastEventAt)}</span>` : ""}
      </div>
      ${renderActivity(session)}
      ${renderSessionActions(session)}
    </article>`;
  }

  function renderListHeader() {
    return `<div class="monitor-columns" aria-hidden="true">
      <span>对话</span><span>队列状态</span><span>待 / 执 / 核</span>
      <span>页面心跳</span><span>最新进展</span><span>操作</span>
    </div>`;
  }

  function renderListRow(session) {
    const status = sessionStatus(session);
    const signal = pageSignalInfo(session);
    const key = escapeHtml(session.key);
    const title = escapeHtml(friendlyName(session));
    const expanded = expandedDetails.has(session.key);
    const updated = changedSessions.has(session.key);
    const favorite = favoriteKeys.has(session.key);
    const progress = Number.isFinite(session.activeSince) && session.activeSince > 0
      ? `<span data-time="${session.activeSince}" data-time-kind="stage"
          title="持久化的队列阶段时间，不表示服务端仍在生成">
          当前阶段记录已持续 ${elapsedLabel(session.activeSince,"stage")}</span>`
      : Number.isFinite(session.lastEventAt) && session.lastEventAt > 0
        ? `<span data-time="${session.lastEventAt}" data-time-kind="event"
            title="本对话最后一次写入队列日志的时间">
            最近队列操作 ${elapsedLabel(session.lastEventAt)}</span>`
        : "暂无队列事件";
    return `<article class="session monitor-row${status.type === "review" ? " needs-review" : ""}${updated ? " recently-changed" : ""}${favorite ? " favorite" : ""}${favorite && status.type === "review" ? " priority-review" : ""}"
      data-key="${key}" aria-label="${title}">
      <div class="monitor-main">
        <div class="monitor-identity">
          ${renderFavoriteButton(session)}
          <div class="monitor-title-copy">
            <div class="session-title" title="${title}">${title}</div>
            <div class="session-title-meta">
              <span class="session-id" title="${escapeHtml(sessionSubtitle(session))}">${escapeHtml(sessionSubtitle(session))}</span>
              ${renderProjectChip(session)}
            </div>
          </div>
        </div>
        <div class="monitor-work">
          <span class="status ${status.type === "review" ? "review" :
            status.type === "active" ? "active" : ""}">${status.label}</span>
          ${favorite && status.type === "review" ?
            '<span class="priority-marker" title="已设为重点且需要人工核对">★ 重点</span>' : ""}
          ${updated ? '<span class="change-pill">有变化</span>' : ""}
        </div>
        <div class="monitor-counts" aria-label="待发送 ${session.pending}，执行中 ${session.active}，需核对 ${session.review}">
          <span title="待发送 ${session.pending}"><strong>${session.pending}</strong><small>待</small></span>
          <span title="执行中 ${session.active}"><strong>${session.active}</strong><small>执</small></span>
          <span class="${session.review ? "attention" : ""}" title="需核对 ${session.review}"><strong>${session.review}</strong><small>核</small></span>
        </div>
        <div class="monitor-signal ${signal.kind}"
          title="临时页面心跳：停止按钮不保证服务端仍在生成，信号过期不代表任务失败">
          <span class="monitor-signal-dot" aria-hidden="true"></span>
          <span class="monitor-signal-text">${escapeHtml(signal.text)}</span>
        </div>
        <div class="monitor-time">${progress}</div>
        <div class="monitor-actions">
          <button type="button" class="monitor-details-toggle" data-action="details"
            data-key="${key}" aria-expanded="${expanded}"
            aria-label="${expanded ? "收起" : "展开"}${title}的详细状态"
            title="${expanded ? "收起队列活动与时间详情" : "查看浏览器、规则和近期活动"}">
            ${expanded ? "收起" : "详情"}
          </button>
          ${renderSessionActions(session,true)}
        </div>
      </div>
      ${expanded ? `<div class="monitor-details" aria-label="对话详细信息">
        <div class="monitor-details-meta">
          <span>${browserLabel(session.browser)}</span>
          <span>自动规则 ${session.enabledRules}/${session.allRules}</span>
          ${Number.isFinite(session.pageSignalAt) && session.pageSignalAt > 0 ?
            `<span data-time="${session.pageSignalAt}" data-time-kind="pulse">最近心跳 ${elapsedLabel(session.pageSignalAt,"pulse")}</span>` : ""}
          ${Number.isFinite(session.lastEventAt) && session.lastEventAt > 0 ?
            `<span data-time="${session.lastEventAt}" data-time-kind="event">最近队列操作 ${elapsedLabel(session.lastEventAt)}</span>` : ""}
        </div>
        ${renderActivity(session)}
      </div>` : ""}
    </article>`;
  }

  function renderGroups(items) {
    const header = layoutMode === "list" ? renderListHeader() : "";
    const content = STATUS_GROUPS.map((group) => {
      const members = items.filter((session) => sessionStatus(session).type === group.id);
      if (!members.length) return "";
      const expanded = !collapsedGroups.has(group.id);
      const rows = expanded
        ? members.map(layoutMode === "list" ? renderListRow : renderCard).join("")
        : "";
      return `<section class="session-group group-${group.id}"
        data-group-id="${group.id}" aria-label="${group.name}：${members.length} 个对话">
        <button type="button" class="session-group-toggle" data-group="${group.id}"
          aria-expanded="${expanded}" aria-controls="group-items-${group.id}"
          title="${expanded ? "折叠" : "展开"}${group.name}分组">
          <span class="group-name"><span class="group-dot" aria-hidden="true"></span>${group.name}</span>
          <span class="group-count">${members.length} 个对话</span>
          <span class="group-hint">${group.hint}</span>
          <span class="group-chevron" aria-hidden="true">${expanded ? "⌄" : "›"}</span>
        </button>
        <div class="session-group-items" id="group-items-${group.id}"
          ${expanded ? "" : "hidden"}>${rows}</div>
      </section>`;
    }).join("");
    return header + content;
  }

  function renderProjectGroups(items) {
    const names = [...new Set(items.map(projectFor).filter(Boolean))]
      .sort((a,b)=>a.localeCompare(b,"zh-CN"));
    const keys = [...names.map((name)=>"project:"+name)];
    if (items.some((session)=>!projectFor(session))) keys.push("none");
    const header = layoutMode === "list" ? renderListHeader() : "";
    return header + keys.map((key,index)=>{
      const members = items.filter((session)=>projectGroupKey(session) === key);
      const summary = summarizeProject(key,members);
      const name = summary.name;
      const expanded = !collapsedProjectGroups.has(key);
      const hint = "待 " + summary.pending + " 条 · 执 " + summary.active +
        " 条 · 核对 " + summary.reviewChats + " 对话" +
        (summary.signalChats ? " · 心跳待确认 " + summary.signalChats : "");
      const rows = expanded ? members.map(
        layoutMode === "list" ? renderListRow : renderCard).join("") : "";
      return `<section class="session-group project-group${summary.reviewChats ? " has-review" : ""}"
        data-project-group-id="${escapeHtml(key)}"
        aria-label="${escapeHtml(name)}：${members.length} 个对话">
        <button type="button" class="session-group-toggle"
          data-project-group="${escapeHtml(key)}"
          aria-expanded="${expanded}" aria-controls="project-group-items-${index}"
          title="${expanded ? "折叠" : "展开"}${escapeHtml(name)}分组">
          <span class="group-name"><span class="group-dot" aria-hidden="true"></span>${escapeHtml(name)}</span>
          <span class="group-count">${members.length} 个对话</span>
          <span class="group-hint">${hint}</span>
          <span class="group-chevron" aria-hidden="true">${expanded ? "⌄" : "›"}</span>
        </button>
        <div class="session-group-items" id="project-group-items-${index}"
          ${expanded ? "" : "hidden"}>${rows}</div>
      </section>`;
    }).join("");
  }

  function updateScanNavigation(filtered) {
    const index = scanKey ? filtered.findIndex((session) => session.key === scanKey) : -1;
    scanProgress.textContent = index < 0
      ? "未选择 · " + filtered.length + " 个对话"
      : (index + 1) + " / " + filtered.length;
    const current = index < 0 ? null : filtered[index];
    scanCurrent.textContent = current ? friendlyName(current) : "";
    scanCurrent.title = current ? friendlyName(current) : "";
    scanPrevButton.disabled = !filtered.length;
    scanNextButton.disabled = !filtered.length;
    scanExitButton.hidden = !current;
  }

  function moveScan(direction, fromKeyboard = false) {
    const filtered = matchingSessions();
    if (!filtered.length) return;
    const oldIndex = filtered.findIndex((item) => item.key === scanKey);
    const nextIndex = oldIndex < 0
      ? direction > 0 ? 0 : filtered.length - 1
      : (oldIndex + direction + filtered.length) % filtered.length;
    const next = filtered[nextIndex];
    scanKey = next.key;
    // Navigation only: never open a chat, pause a queue or send a task.
    // Expand the target's group so the highlighted card remains visible.
    if (groupedView) collapsedGroups.delete(sessionStatus(next).type);
    if (projectGroupedView) collapsedProjectGroups.delete(projectGroupKey(next));
    moreMenuKey = null;
    locatedKey = null;
    render();
    const selected = [...list.querySelectorAll(".session")]
      .find((element) => element.dataset.key === next.key);
    selected?.scrollIntoView({block:"center",inline:"nearest"});
    if (fromKeyboard) selected?.focus({preventScroll:true});
  }

  function clearScan() {
    if (!scanKey) return;
    scanKey = null;
    render();
  }

  function quickJumpCandidates() {
    // This search intentionally ignores every active display filter. It uses
    // only the already-loaded dashboard metadata, never message text/images.
    const terms = quickJumpQuery.value.trim().toLocaleLowerCase()
      .split(/\s+/).filter(Boolean);
    const rank = (session) => session.halted || session.review ? 0 :
      session.active ? 1 : session.pending ? 2 :
      session.queuePaused ? 3 : session.enabledRules ? 4 : 5;
    return sessions.map((session) => {
      const fields = [
        friendlyName(session),originalName(session),
        projectFor(session),session.key,session.url || "",
      ].map((value)=>String(value || "").toLocaleLowerCase());
      if (!terms.every((term)=>fields.some((value)=>value.includes(term)))) return null;
      let relevance = 0;
      if (terms.length) {
        const first = terms[0];
        relevance = fields[0] === first ? 0 :
          fields[0].startsWith(first) ? 1 :
          fields[1].startsWith(first) ? 2 :
          fields[0].includes(first) ? 3 :
          fields[2].startsWith(first) ? 4 : 5;
      }
      return {session,relevance,rank:rank(session)};
    }).filter(Boolean).sort((a,b)=>
      a.relevance - b.relevance ||
      Number(favoriteKeys.has(b.session.key)) -
        Number(favoriteKeys.has(a.session.key)) ||
      a.rank - b.rank ||
      (Number(b.session.lastEventAt) || 0) -
        (Number(a.session.lastEventAt) || 0) ||
      friendlyName(a.session).localeCompare(friendlyName(b.session),"zh-CN") ||
      a.session.key.localeCompare(b.session.key));
  }

  function renderQuickJumpResults(resetSelection = false) {
    if (!quickJumpDialog.open) return;
    const previousKey = !resetSelection ? quickJumpMatches[quickJumpIndex]?.key : null;
    const candidates = quickJumpCandidates();
    quickJumpMatches = candidates.slice(0,MAX_QUICK_JUMP_RESULTS)
      .map((item)=>item.session);
    const oldIndex = quickJumpMatches.findIndex((session)=>session.key === previousKey);
    quickJumpIndex = oldIndex < 0 ? 0 : oldIndex;
    quickJumpCount.textContent = candidates.length ?
      "显示 " + quickJumpMatches.length + " / " + candidates.length +
      " 个匹配对话" : "没有匹配的对话";
    const fragment = document.createDocumentFragment();
    if (!quickJumpMatches.length) {
      const empty = document.createElement("div");
      empty.className = "quick-jump-empty";
      empty.textContent = "尝试搜索备注、原标题、项目名称或对话标识";
      fragment.append(empty);
    }
    for (const [index,session] of quickJumpMatches.entries()) {
      const button = document.createElement("button");
      button.id = "quick-jump-result-" + index;
      button.type = "button";
      button.className = "quick-jump-result";
      button.role = "option";
      button.tabIndex = -1;
      button.dataset.quickJumpKey = session.key;
      button.setAttribute("aria-selected",String(index === quickJumpIndex));
      button.setAttribute("aria-label",friendlyName(session) + "，" +
        (projectFor(session) || "未分组") + "，" + sessionStatus(session).label);
      const title = document.createElement("strong");
      title.className = "quick-jump-result-title";
      title.textContent = friendlyName(session);
      const secondary = document.createElement("span");
      secondary.className = "quick-jump-result-secondary";
      secondary.textContent = (projectFor(session) || "未分组") + " · " +
        originalName(session);
      const label = document.createElement("span");
      label.className = "quick-jump-result-label";
      label.textContent = sessionStatus(session).label;
      if (session.halted || session.review) label.classList.add("needs-review");
      const left = document.createElement("span");
      left.className = "quick-jump-result-copy";
      left.append(title,secondary);
      button.append(left,label);
      fragment.append(button);
    }
    quickJumpResults.replaceChildren(fragment);
    const selected = quickJumpResults.querySelector(
      ".quick-jump-result[aria-selected='true']");
    if (selected) quickJumpQuery.setAttribute("aria-activedescendant",selected.id);
    else quickJumpQuery.removeAttribute("aria-activedescendant");
  }

  function selectQuickJumpIndex(index) {
    if (!quickJumpMatches.length) return;
    quickJumpIndex = (index + quickJumpMatches.length) % quickJumpMatches.length;
    for (const [i,button] of [...quickJumpResults.querySelectorAll(".quick-jump-result")].entries()) {
      button.setAttribute("aria-selected",String(i === quickJumpIndex));
    }
    const current = quickJumpResults.querySelector(
      ".quick-jump-result[aria-selected='true']");
    if (current) {
      quickJumpQuery.setAttribute("aria-activedescendant",current.id);
      current.scrollIntoView({block:"nearest",inline:"nearest"});
    }
  }

  function openQuickJump() {
    if (quickJumpDialog.open) return;
    if (aliasEditor || projectEditor || savingAliasKey || savingProjectKey) {
      showFeedback("请先保存或取消正在编辑的本地备注／项目名称，再快速跳转。",true);
      list.querySelector("input[data-alias-input],input[data-project-input]")
        ?.focus({preventScroll:true});
      return;
    }
    quickJumpReturnFocus = document.activeElement === document.body ?
      quickJumpOpenButton : document.activeElement;
    quickJumpRestoreOnClose = true;
    quickJumpQuery.value = "";
    quickJumpDialog.showModal();
    renderQuickJumpResults(true);
    quickJumpQuery.focus({preventScroll:true});
  }

  function locateQuickJump(key) {
    const target = sessions.find((session)=>session.key === key);
    if (!target || !quickJumpDialog.open) return;
    const reset = Boolean(search.value.trim() || favoritesOnly ||
      selectedFilter !== "all" || projectFilter !== "all");
    quickJumpRestoreOnClose = false;
    quickJumpDialog.close();
    search.value = "";
    favoritesOnly = false;
    selectedFilter = "all";
    projectFilter = "all";
    if (groupedView) collapsedGroups.delete(sessionStatus(target).type);
    if (projectGroupedView) collapsedProjectGroups.delete(projectGroupKey(target));
    moreMenuKey = null;
    scanKey = key;
    locatedKey = null;
    render();
    showFeedback((reset ? "已清除之前的显示筛选，" : "") +
      "已定位到「" + friendlyName(target) + "」；不会自动打开或发送。");
    const card = [...list.querySelectorAll(".session")]
      .find((item)=>item.dataset.key === key);
    if (card) {
      card.focus({preventScroll:true});
      card.scrollIntoView({block:"center",inline:"nearest"});
    }
  }

  function render() {
    pruneChangedSessions();
    expireLocated();
    syncProjectSelector();
    renderProjectHealth();
    const filtered = matchingSessions();
    if (scanKey && (!filtered.some((item) => item.key === scanKey) ||
        (groupedView && collapsedGroups.has(sessionStatus(
          filtered.find((item) => item.key === scanKey)).type)) ||
        (projectGroupedView && collapsedProjectGroups.has(projectGroupKey(
          filtered.find((item) => item.key === scanKey)))))) {
      scanKey = null;
    }
    if (moreMenuKey && (!filtered.some((item) => item.key === moreMenuKey) ||
        (groupedView && collapsedGroups.has(
          sessionStatus(sessions.find((item) => item.key === moreMenuKey)).type)) ||
        (projectGroupedView && collapsedProjectGroups.has(projectGroupKey(
          sessions.find((item) => item.key === moreMenuKey)))))) {
      moreMenuKey = null;
    }
    const scrollTop = list.scrollTop;
    const active = document.activeElement;
    const editedInputWasFocused = Boolean(
      (aliasEditor || projectEditor) &&
      active?.matches?.("input[data-alias-input],input[data-project-input]") &&
      (active.dataset.key === aliasEditor?.key && active.hasAttribute("data-alias-input") ||
       active.dataset.key === projectEditor?.key && active.hasAttribute("data-project-input")));
    const selection = editedInputWasFocused ? {
      start:active.selectionStart,end:active.selectionEnd,direction:active.selectionDirection,
    } : null;
    const scanHadFocus = Boolean(scanKey && active?.matches?.(".session[data-key]") &&
      active.dataset.key === scanKey);
    const selected = active && list.contains(active) && active.matches("button[data-key]") ?
      {key:active.dataset.key,action:active.dataset.action} : null;
    const selectedGroup = active && list.contains(active) &&
      active.matches("button[data-group]") ? active.dataset.group : null;
    const selectedProjectGroup = active && list.contains(active) &&
      active.matches("button[data-project-group]") ? active.dataset.projectGroup : null;
    const content = projectGroupedView ? renderProjectGroups(filtered) :
      groupedView ? renderGroups(filtered) :
      (layoutMode === "list"
        ? renderListHeader() + filtered.map(renderListRow).join("")
        : filtered.map(renderCard).join(""));
    list.innerHTML = filtered.length ? content :
      `<div class="empty">${sessions.length ?
        "没有匹配的对话。可尝试切换筛选或清除搜索。" :
        "暂时没有已保存的对话任务。打开 ChatGPT 创建队列后就会显示在这里。"}
        ${sessions.length && (selectedFilter !== "all" || favoritesOnly ||
            search.value.trim() || projectFilter !== "all")
          ? '<button type="button" class="empty-reset" data-action="reset-filters">查看全部对话</button>'
          : ""}</div>`;
    list.scrollTop = scrollTop;
    if (editedInputWasFocused) {
      const selector = active.hasAttribute("data-project-input") ?
        "input[data-project-input]" : "input[data-alias-input]";
      const input = list.querySelector(selector);
      if (input?.dataset.key === active.dataset.key && !input.disabled) {
        input.focus({preventScroll:true});
        if (selection && Number.isInteger(selection.start) && Number.isInteger(selection.end)) {
          input.setSelectionRange(selection.start,selection.end,selection.direction || "none");
        }
      }
    }
    if (scanKey) {
      const scanned = [...list.querySelectorAll(".session")]
        .find((element) => element.dataset.key === scanKey);
      if (scanned) {
        scanned.classList.add("scan-selected");
        scanned.setAttribute("tabindex","-1");
        scanned.setAttribute("aria-current","true");
        if (scanHadFocus) scanned.focus({preventScroll:true});
      }
    }
    if (locatedKey) {
      [...list.querySelectorAll(".session")].find((element) =>
        element.dataset.key === locatedKey)?.classList.add("located-session");
    }
    if (selected) {
      [...list.querySelectorAll("button[data-key]")].find((button) =>
        button.dataset.key === selected.key &&
        button.dataset.action === selected.action && !button.disabled)
        ?.focus({preventScroll:true});
    }
    if (selectedGroup) {
      [...list.querySelectorAll("button[data-group]")].find((button) =>
        button.dataset.group === selectedGroup)?.focus({preventScroll:true});
    }
    if (selectedProjectGroup) {
      [...list.querySelectorAll("button[data-project-group]")].find((button) =>
        button.dataset.projectGroup === selectedProjectGroup)?.focus({preventScroll:true});
    }
    document.getElementById("result-count").textContent =
      `显示 ${filtered.length} / ${sessions.length} 个对话 · 重点 ${favoriteKeys.size}`;
    updateScanNavigation(filtered);
    favoritesOnlyButton.setAttribute("aria-pressed",String(favoritesOnly));
    syncFilterIndicators();
    cleanupIdleButton.hidden = cleanupEligible <= 0;
    cleanupIdleButton.textContent = "清理无任务旧记录 · " + cleanupEligible;
    cleanupIdleButton.disabled = cleanupInProgress;
    updateFocusControls();
    updateAttention();
    updateRelativeTimes();
    quickJumpOpenButton.disabled = sessions.length === 0;
    if (quickJumpDialog.open) renderQuickJumpResults();
  }

  function showFeedback(message, error = false) {
    feedback.textContent = String(message);
    feedback.classList.toggle("error", error);
    feedback.hidden = false;
  }

  function setSummary() {
    const sum = (key) => sessions.reduce((total, item) =>
      total + Math.max(0, Number(item[key]) || 0), 0);
    const activeSessions = sessions.filter((session) =>
      session.pending || session.active || session.review ||
      session.enabledRules || session.halted).length;
    document.getElementById("stat-chats").textContent = activeSessions;
    document.getElementById("stat-pending").textContent = sum("pending");
    document.getElementById("stat-active").textContent = sum("active");
    document.getElementById("stat-review").textContent = sum("review");
    syncFilterIndicators();
  }

  async function refresh() {
    if (requestInProgress) {
      refreshRequested = true;
      return;
    }
    requestInProgress = true;
    refreshButton.disabled = true;
    try {
      const reply = await chrome.runtime.sendMessage({type:"DASHBOARD_GET"});
      if (!reply?.ok || !Array.isArray(reply.dashboard?.sessions)) {
        throw new Error(reply?.error || "后台没有返回有效的队列状态");
      }
      const nextSessions = reply.dashboard.sessions;
      cleanupEligible = Math.max(0,Number(reply.dashboard.cleanupEligible) || 0);
      const nextSnapshot = JSON.stringify(nextSessions);
      const contentChanged = lastSnapshot !== nextSnapshot;
      if (contentChanged) acceptSnapshot(nextSessions);
      document.getElementById("version").textContent =
        "v" + String(reply.dashboard.version || "—");
      updatedAt.textContent = "更新于 " + new Date().toLocaleTimeString("zh-CN",{
        hour:"2-digit", minute:"2-digit", second:"2-digit",
      });
      setSummary();
      const recentChanged = pruneChangedSessions();
      const locationExpired = expireLocated();
      if (contentChanged || recentChanged || locationExpired) render();
      else updateRelativeTimes();
    } catch (error) {
      updatedAt.textContent = "状态读取失败";
      showFeedback(error?.message || "无法读取本地队列状态", true);
    } finally {
      requestInProgress = false;
      refreshButton.disabled = false;
      if (refreshRequested) {
        refreshRequested = false;
        void refresh();
      }
    }
  }

  function hasWorkToDiscard(session) {
    return Boolean(session.requiresDiscard || session.pending || session.active || session.review ||
      session.allRules || session.halted || session.queuePaused);
  }

  async function removeConversation(key) {
    const session = sessions.find((item) => item.key === key);
    if (!session || pendingKeys.has(key)) return;
    if (session.browser === "unknown" ||
        (session.browser !== "closed" && hasWorkToDiscard(session))) {
      showFeedback("此对话可能仍在运行，请先关闭有任务的 ChatGPT 标签页再移除记录。",true);
      return;
    }
    const name = friendlyName(session);
    const warning = hasWorkToDiscard(session)
      ? "该对话还有待发送 " + session.pending + " 条、执行中 " + session.active +
        " 条、需核对 " + session.review + " 条、自动规则 " + session.allRules +
        " 条，移除后这些队列记录和规则无法恢复。"
      : "该对话的本地队列设置和运行日志也会被清理。";
    if (!window.confirm("要从队列插件中移除「" + name + "」吗？\n" +
        warning + "\n不会删除 ChatGPT 官方对话或提示词收藏夹。")) return;
    let discardWork = false;
    if (hasWorkToDiscard(session)) {
      if (session.browser !== "closed") {
        showFeedback("含任务的对话仍在浏览器中打开，请先关闭该标签页。",true);
        return;
      }
      if (window.prompt("为了避免误丢任务，请输入「移除」确认永久丢弃该对话的队列和规则。") !== "移除") return;
      discardWork = true;
    }
    pendingKeys.add(key);
    render();
    try {
      const reply = await chrome.runtime.sendMessage({
        type:"DASHBOARD_REMOVE_CONVERSATION",key,
        confirm:true,discardWork,confirmKey:discardWork ? key : null,
      });
      if (!reply?.ok || !Array.isArray(reply.dashboard?.sessions)) {
        throw new Error(reply?.error || "无法移除本地对话记录");
      }
      favoriteKeys.delete(key);
      aliases.delete(key);
      if (aliasEditor?.key === key) aliasEditor = null;
      expandedActivities.delete(key);
      expandedDetails.delete(key);
      if (locatedKey === key) locatedKey = null;
      if (attentionCursor.review === key) attentionCursor.review = null;
      if (attentionCursor.signal === key) attentionCursor.signal = null;
      cleanupEligible = Math.max(0,Number(reply.dashboard.cleanupEligible) || 0);
      acceptSnapshot(reply.dashboard.sessions);
      setSummary();
      showFeedback("已从插件移除「" + name + "」的本地记录；ChatGPT 官方聊天未受影响。");
    } catch (error) {
      showFeedback(error?.message || "移除失败，原队列记录已保留。",true);
    } finally {
      pendingKeys.delete(key);
      render();
      void refresh();
    }
  }

  async function cleanupIdleRecords() {
    if (cleanupInProgress || cleanupEligible <= 0) return;
    const count = cleanupEligible;
    if (!window.confirm("要清理 " + count +
        " 个已关闭且无任务、无规则的本地旧对话记录吗？\n" +
        "它们可能已经不显示在管理列表中，但仍占用本地存储。\n" +
        "仅清理队列插件的数据，不删除 ChatGPT 官方聊天或提示词收藏夹。")) return;
    cleanupInProgress = true;
    render();
    try {
      const reply = await chrome.runtime.sendMessage({
        type:"DASHBOARD_CLEANUP_IDLE",confirm:true,
      });
      if (!reply?.ok || !Array.isArray(reply.dashboard?.sessions)) {
        throw new Error(reply?.error || "清理旧对话记录失败");
      }
      cleanupEligible = Math.max(0,Number(reply.dashboard.cleanupEligible) || 0);
      acceptSnapshot(reply.dashboard.sessions);
      setSummary();
      showFeedback("已清理 " + Number(reply.removedCount || 0) +
        " 个无任务旧对话的本地记录；官方聊天未受影响。");
    } catch (error) {
      showFeedback(error?.message || "清理失败，原记录已保留。",true);
    } finally {
      cleanupInProgress = false;
      render();
      void refresh();
    }
  }

  async function togglePaused(key) {
    const session = sessions.find((item) => item.key === key);
    if (!session || pendingKeys.has(key)) return;
    if (session.queuePaused && session.halted) {
      showFeedback("该对话还需要人工核对，请先打开对话处理异常暂停。",true);
      return;
    }
    const wasFocused = document.activeElement?.dataset.action === "pause" &&
      document.activeElement?.dataset.key === key;
    pendingKeys.add(key);
    render();
    try {
      const paused = !session.queuePaused;
      const reply = await chrome.runtime.sendMessage({
        type:"DASHBOARD_SET_PAUSED",key,paused,
      });
      if (!reply?.ok) throw new Error(reply?.error || "更新暂停状态失败");
      showFeedback(paused ? "已暂停此对话领取后续任务，当前消息不被打断。" :
        "已恢复此对话的自动接力。");
      // Don't infer success from a click: only apply the state returned by
      // the serialized background write, then request a fresh live snapshot.
      if (Array.isArray(reply.dashboard?.sessions)) {
        acceptSnapshot(reply.dashboard.sessions);
        setSummary();
      }
    } catch (error) {
      showFeedback(error?.message || "更新暂停状态失败",true);
    } finally {
      pendingKeys.delete(key);
      render();
      if (wasFocused) {
        [...list.querySelectorAll('button[data-action="pause"]')]
          .find((button) => button.dataset.key === key && !button.disabled)
          ?.focus({preventScroll:true});
      }
      void refresh();
    }
  }

  async function openConversation(key) {
    const session = sessions.find((item) => item.key === key);
    const url = safeChatUrl(session?.url);
    if (!url) {
      showFeedback("该对话没有可验证的 ChatGPT 地址，无法打开。",true);
      return;
    }
    try {
      if (Number.isInteger(session.tabId)) {
        try {
          const tab = await chrome.tabs.get(session.tabId);
          const existingUrl = safeChatUrl(tab.url || tab.pendingUrl);
          if (existingUrl && new URL(existingUrl).pathname === new URL(url).pathname) {
            await chrome.tabs.update(tab.id,{active:true});
            if (Number.isInteger(tab.windowId) && chrome.windows?.update) {
              // Activating the existing tab is already a success. If Edge
              // refuses to focus its window, do not mistakenly open a second
              // copy of the same chat in the catch fallback below.
              try { await chrome.windows.update(tab.windowId,{focused:true}); }
              catch { /* Best effort; the existing tab remains selected. */ }
            }
            return;
          }
        } catch { /* Closed or navigated tab; open a fresh one instead. */ }
      }
      await chrome.tabs.create({url,active:true});
    } catch (error) {
      showFeedback(error?.message || "无法打开对应的 ChatGPT 对话",true);
    }
  }

  async function toggleCurrentPanel() {
    try {
      const tabs = await chrome.tabs.query({active:true,currentWindow:true});
      const tab = tabs.find((item) => Number.isInteger(item.id) &&
        safeChatUrl(item.url || item.pendingUrl));
      if (!tab) {
        showFeedback("当前标签不是 ChatGPT，请先切换到 ChatGPT 对话。",true);
        return;
      }
      await chrome.tabs.sendMessage(tab.id,{type:"TOGGLE_PANEL"});
      showFeedback("已切换当前 ChatGPT 页面上的队列面板。");
    } catch (error) {
      showFeedback("当前页面尚未载入队列面板，请在页面完成加载后重试。",true);
    }
  }

  async function toggleFavorite(key) {
    if (!sessions.some((session) => session.key === key) || savingPreferences) return;
    const hadKeyboardFocus = document.activeElement?.dataset.action === "favorite" &&
      document.activeElement?.dataset.key === key;
    const next = new Set(favoriteKeys);
    const wasFavorite = next.has(key);
    if (wasFavorite) next.delete(key);
    else {
      if (next.size >= MAX_FAVORITES) {
        showFeedback("最多标记 100 个重点对话，可取消不再关注的重点标记。",true);
        return;
      }
      next.add(key);
    }
    if (await updateViewPreferences(next,compactView)) {
      showFeedback(wasFavorite ? "已取消重点标记，队列状态没有变化。" :
        "已设为重点对话，仅影响管理页排序与筛选。");
    }
    if (hadKeyboardFocus) {
      [...list.querySelectorAll('button[data-action="favorite"]')]
        .find((button) => button.dataset.key === key && !button.disabled)
        ?.focus({preventScroll:true});
    }
  }

  function beginAliasEdit(key) {
    if (moreMenuKey !== key || !sessions.some((session) => session.key === key) ||
        savingAliasKey || savingProjectKey || projectEditor) return;
    if (aliasEditor?.key === key) {
      cancelAliasEdit(key);
      return;
    }
    aliasEditor = {key,value:aliases.get(key) || ""};
    render();
    const input = list.querySelector("input[data-alias-input]");
    if (input?.dataset.key === key) {
      input.focus({preventScroll:true});
      input.select();
    }
  }

  function cancelAliasEdit(key) {
    if (aliasEditor?.key !== key || savingAliasKey) return;
    aliasEditor = null;
    render();
    [...list.querySelectorAll('button[data-action="alias-edit"]')]
      .find((button) => button.dataset.key === key)
      ?.focus({preventScroll:true});
  }

  async function saveAlias(key) {
    if (moreMenuKey !== key || aliasEditor?.key !== key || savingAliasKey ||
        !sessions.some((session) => session.key === key)) return;
    const field = list.querySelector("input[data-alias-input]");
    if (field?.dataset.key === key) aliasEditor.value = field.value;
    const raw = aliasEditor.value;
    const value = raw.trim().replace(/\s+/g," ");
    if (raw.length > MAX_ALIAS_LENGTH || value.length > MAX_ALIAS_LENGTH ||
        /[\u0000-\u001f\u007f]/.test(raw)) {
      showFeedback("备注名称不得超过 48 个字符，且不能包含控制字符。",true);
      return;
    }
    if (value === (aliases.get(key) || "")) {
      cancelAliasEdit(key);
      return;
    }
    savingAliasKey = key;
    render();
    try {
      // Read the latest aliases to preserve edits from other dashboard tabs.
      // This key is deliberately separate from favorites and layout prefs.
      const saved = await chrome.storage.local.get(ALIASES_KEY);
      const next = normalizedAliases(saved?.[ALIASES_KEY]);
      if (value) {
        if (!next.has(key) && next.size >= MAX_ALIASES) {
          throw new Error("本地备注已达 250 条，请先清理无用对话的记录");
        }
        next.set(key,value);
      } else {
        next.delete(key);
      }
      await chrome.storage.local.set({[ALIASES_KEY]:Object.fromEntries(next)});
      aliases = next;
      aliasEditor = null;
      showFeedback(value
        ? "已保存本地对话备注，原 ChatGPT 标题和队列均未修改。"
        : "已恢复原对话标题；原队列没有变化。");
    } catch (error) {
      showFeedback(error?.message || "备注保存失败，输入内容已保留。",true);
    } finally {
      savingAliasKey = null;
      render();
      if (aliasEditor?.key === key) {
        const input = list.querySelector("input[data-alias-input]");
        if (input?.dataset.key === key) input.focus({preventScroll:true});
      } else {
        [...list.querySelectorAll('button[data-action="alias-edit"]')]
          .find((button) => button.dataset.key === key)
          ?.focus({preventScroll:true});
      }
    }
  }

  function beginProjectEdit(key) {
    if (moreMenuKey !== key || !sessions.some((session)=>session.key === key) ||
        savingProjectKey || savingAliasKey || aliasEditor) return;
    if (projectEditor?.key === key) {
      cancelProjectEdit(key);
      return;
    }
    projectEditor = {key,value:projects.get(key) || ""};
    render();
    const input = list.querySelector("input[data-project-input]");
    if (input?.dataset.key === key) {
      input.focus({preventScroll:true});
      input.select();
    }
  }

  function cancelProjectEdit(key) {
    if (projectEditor?.key !== key || savingProjectKey) return;
    projectEditor = null;
    render();
    [...list.querySelectorAll('button[data-action="project-edit"]')]
      .find((button)=>button.dataset.key === key)
      ?.focus({preventScroll:true});
  }

  async function saveProject(key) {
    if (moreMenuKey !== key || projectEditor?.key !== key || savingProjectKey ||
        !sessions.some((session)=>session.key === key)) return;
    const field = list.querySelector("input[data-project-input]");
    if (field?.dataset.key === key) projectEditor.value = field.value;
    const raw = projectEditor.value;
    const value = raw.trim().replace(/\s+/g," ");
    if (raw.length > MAX_PROJECT_LENGTH || value.length > MAX_PROJECT_LENGTH ||
        /[\u0000-\u001f\u007f]/.test(raw)) {
      showFeedback("项目名称不得超过 24 个字符，且不能包含控制字符。",true);
      return;
    }
    if (value === (projects.get(key) || "")) {
      cancelProjectEdit(key);
      return;
    }
    savingProjectKey = key;
    render();
    try {
      // Keep project assignments independent of favorites, aliases and queue.
      const saved = await chrome.storage.local.get(PROJECTS_KEY);
      const next = normalizedProjects(saved?.[PROJECTS_KEY]);
      if (value) {
        if (!next.has(key) && next.size >= MAX_PROJECT_ASSIGNMENTS) {
          throw new Error("项目归属记录已达 250 条，请先清理无用对话记录");
        }
        next.set(key,value);
      } else {
        next.delete(key);
      }
      await chrome.storage.local.set({[PROJECTS_KEY]:Object.fromEntries(next)});
      projects = next;
      projectEditor = null;
      showFeedback(value
        ? "已将对话归入项目「" + value + "」；队列任务没有变化。"
        : "已将对话设为未分组；队列任务没有变化。");
    } catch (error) {
      showFeedback(error?.message || "项目保存失败，输入内容已保留。",true);
    } finally {
      savingProjectKey = null;
      render();
      if (projectEditor?.key === key) {
        const input = list.querySelector("input[data-project-input]");
        if (input?.dataset.key === key) input.focus({preventScroll:true});
      } else {
        [...list.querySelectorAll('button[data-action="project-edit"]')]
          .find((button)=>button.dataset.key === key)
          ?.focus({preventScroll:true});
      }
    }
  }

  function clearDisplayFilters() {
    search.value = "";
    selectedFilter = "all";
    favoritesOnly = false;
    projectFilter = "all";
    render();
  }

  function chooseStatusFilter(filter, drilldown = false) {
    if (!Object.hasOwn(FILTER_NAMES,filter)) return;
    const next = drilldown && selectedFilter === filter ? "all" : filter;
    const clearedContext = drilldown &&
      Boolean(search.value.trim() || favoritesOnly || projectFilter !== "all");
    selectedFilter = next;
    if (drilldown) {
      // A clicked summary is an explicit request to see every affected
      // conversation, regardless of the previous search/favorites filter.
      search.value = "";
      favoritesOnly = false;
      projectFilter = "all";
      if (groupedView) {
        const sections = next === "busy"
          ? ["review","active","pending","paused","rules"]
          : next === "active" ? ["active"]
          : next === "pending" ? ["pending","review","active","paused"]
          : next === "review" ? ["review"] : [];
        for (const section of sections) collapsedGroups.delete(section);
      }
      if (projectGroupedView) collapsedProjectGroups.clear();
    }
    render();
    if (clearedContext) {
      showFeedback("已清除旧搜索和仅重点条件，当前查看：" +
        (FILTER_NAMES[next] || "全部对话") + "。");
    }
  }

  document.getElementById("filters").addEventListener("click",(event)=>{
    const button = event.target.closest("button[data-filter]");
    if (!button || !["all","changed","busy","review","paused","offline","nosignal"]
      .includes(button.dataset.filter)) return;
    chooseStatusFilter(button.dataset.filter);
  });
  document.querySelector(".stats").addEventListener("click",(event)=>{
    const button = event.target.closest("button[data-stat-filter]");
    if (!button) return;
    chooseStatusFilter(button.dataset.statFilter,true);
  });
  sortSelect.addEventListener("change",()=>{
    if (!["priority","recent","pending","name"].includes(sortSelect.value)) return;
    selectedSort = sortSelect.value;
    render();
  });
  projectSelect.addEventListener("change",()=>{
    const chosen = projectSelect.value;
    if (chosen !== "all" && chosen !== "none" &&
        (!chosen.startsWith("project:") ||
          ![...projectSelect.options].some((option)=>option.value === chosen))) return;
    projectFilter = chosen;
    render();
  });
  projectHealthToggle.addEventListener("click",()=>{
    if (projectHealth.hidden) return;
    projectHealthTouched = true;
    projectHealthExpanded = !projectHealthExpanded;
    renderProjectHealth();
  });
  projectHealthCards.addEventListener("click",(event)=>{
    const button = event.target.closest("button[data-project-open],button[data-project-review]");
    if (!button || button.disabled) return;
    chooseProjectFromOverview(
      button.dataset.projectReview || button.dataset.projectOpen,
      button.hasAttribute("data-project-review"));
  });
  favoritesOnlyButton.addEventListener("click",()=>{
    favoritesOnly = !favoritesOnly;
    render();
  });
  densityButton.addEventListener("click",()=>{
    void updateViewPreferences(new Set(favoriteKeys),!compactView);
  });
  layoutButton.addEventListener("click",()=>{
    if (savingPreferences) return;
    void updateViewPreferences(new Set(favoriteKeys),compactView,
      layoutMode === "list" ? "cards" : "list");
  });
  groupButton.addEventListener("click",()=>{
    if (savingPreferences) return;
    void updateViewPreferences(new Set(favoriteKeys),compactView,layoutMode,!groupedView);
  });
  projectGroupButton.addEventListener("click",()=>{
    if (savingPreferences) return;
    void updateViewPreferences(new Set(favoriteKeys),compactView,
      layoutMode,false,focusMode,!projectGroupedView);
  });
  focusModeButton.addEventListener("click",async()=>{
    if (savingPreferences) return;
    const next = !focusMode;
    if (await updateViewPreferences(new Set(favoriteKeys),compactView,
      layoutMode,groupedView,next)) {
      advancedControlsOpen = false;
      updateFocusControls();
      focusModeButton.focus({preventScroll:true});
    }
  });
  focusAdvancedButton.addEventListener("click",()=>{
    if (!focusMode) return;
    advancedControlsOpen = !advancedControlsOpen;
    updateFocusControls();
  });
  focusResetButton.addEventListener("click",()=>{
    if (!focusMode) return;
    clearDisplayFilters();
    search.focus({preventScroll:true});
  });
  if (fullPage) {
    fullViewButton.hidden = true;
  } else {
    fullViewButton.addEventListener("click",async()=>{
      try {
        await chrome.tabs.create({url:fullViewUrl,active:true});
      } catch (error) {
        showFeedback(error?.message || "无法打开独立大屏管理页",true);
      }
    });
  }
  search.addEventListener("input",render);
  quickJumpOpenButton.addEventListener("click",openQuickJump);
  quickJumpCloseButton.addEventListener("click",()=>quickJumpDialog.close());
  quickJumpQuery.addEventListener("input",()=>renderQuickJumpResults(true));
  quickJumpDialog.addEventListener("keydown",(event)=>{
    if (event.defaultPrevented || event.isComposing || event.keyCode === 229 ||
        event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      selectQuickJumpIndex(quickJumpIndex + (event.key === "ArrowDown" ? 1 : -1));
      quickJumpQuery.focus({preventScroll:true});
    } else if (event.key === "Enter" && event.target === quickJumpQuery) {
      event.preventDefault();
      const chosen = quickJumpMatches[quickJumpIndex];
      if (chosen) locateQuickJump(chosen.key);
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      quickJumpDialog.close();
    }
  });
  quickJumpResults.addEventListener("click",(event)=>{
    const choice = event.target.closest("button[data-quick-jump-key]");
    if (choice) locateQuickJump(choice.dataset.quickJumpKey);
  });
  quickJumpDialog.addEventListener("click",(event)=>{
    if (event.target !== quickJumpDialog) return;
    const rect = quickJumpDialog.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right ||
        event.clientY < rect.top || event.clientY > rect.bottom) quickJumpDialog.close();
  });
  quickJumpDialog.addEventListener("close",()=>{
    // A rapid close → reopen can queue the previous close event after the
    // new dialog has already opened. Never erase the new search or its focus.
    if (quickJumpDialog.open) return;
    if (quickJumpRestoreOnClose) {
      const restored = quickJumpReturnFocus?.isConnected ?
        quickJumpReturnFocus : quickJumpOpenButton;
      restored?.focus({preventScroll:true});
    }
    quickJumpReturnFocus = null;
    quickJumpRestoreOnClose = true;
    quickJumpQuery.removeAttribute("aria-activedescendant");
    quickJumpResults.replaceChildren();
    quickJumpMatches = [];
    quickJumpIndex = 0;
  });
  // Lightweight shortcuts for monitoring many chats. Do not steal keys from
  // ChatGPT/editor inputs or interfere with Chinese IME composition.
  document.addEventListener("keydown",(event)=>{
    if (event.defaultPrevented || event.isComposing || event.keyCode === 229 ||
        event.ctrlKey || event.altKey || event.metaKey) return;
    if (quickJumpDialog.open) return;
    if (event.key === "Escape" && event.target === search && search.value) {
      event.preventDefault();
      search.value = "";
      render();
      return;
    }
    if (event.key === "Escape" && moreMenuKey &&
        event.target?.closest?.(".session-actions")) {
      event.preventDefault();
      const key = moreMenuKey;
      moreMenuKey = null;
      render();
      [...list.querySelectorAll('button[data-action="more"]')]
        .find((button) => button.dataset.key === key)
        ?.focus({preventScroll:true});
      return;
    }
    const target = event.target;
    const editing = target?.isContentEditable ||
      ["INPUT","TEXTAREA","SELECT"].includes(target?.tagName);
    if (!editing && !event.shiftKey && event.key === "g" &&
        !quickJumpOpenButton.disabled) {
      event.preventDefault();
      openQuickJump();
      return;
    }
    if (!editing && event.key === "Escape" && scanKey) {
      event.preventDefault();
      clearScan();
      return;
    }
    if (!editing && !event.shiftKey && (event.key === "j" || event.key === "k")) {
      if (scanNextButton.disabled) return;
      event.preventDefault();
      moveScan(event.key === "j" ? 1 : -1,true);
      return;
    }
    if (event.key !== "/" || target?.isContentEditable ||
        ["INPUT","TEXTAREA","SELECT"].includes(target?.tagName)) return;
    event.preventDefault();
    search.focus();
    search.select();
  });
  list.addEventListener("input",(event)=>{
    const input = event.target.closest?.("input[data-alias-input],input[data-project-input]");
    if (input?.hasAttribute("data-alias-input") &&
        aliasEditor?.key === input.dataset.key && !savingAliasKey) {
      aliasEditor.value = input.value;
    }
    if (input?.hasAttribute("data-project-input") &&
        projectEditor?.key === input.dataset.key && !savingProjectKey) {
      projectEditor.value = input.value;
    }
  });
  list.addEventListener("keydown",(event)=>{
    const input = event.target.closest?.("input[data-alias-input],input[data-project-input]");
    if (!input ||
        event.isComposing || event.keyCode === 229 ||
        event.ctrlKey || event.altKey || event.metaKey) return;
    const kind = input.hasAttribute("data-project-input") ? "project" : "alias";
    if (kind === "alias" && aliasEditor?.key !== input.dataset.key ||
        kind === "project" && projectEditor?.key !== input.dataset.key) return;
    if (event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      if (kind === "project") {
        projectEditor.value = input.value;
        void saveProject(input.dataset.key);
      } else {
        aliasEditor.value = input.value;
        void saveAlias(input.dataset.key);
      }
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (kind === "project") cancelProjectEdit(input.dataset.key);
      else cancelAliasEdit(input.dataset.key);
    }
  });
  list.addEventListener("click",(event)=>{
    const reset = event.target.closest("button[data-action='reset-filters']");
    if (reset) {
      clearDisplayFilters();
      search.focus({preventScroll:true});
      return;
    }
    const projectHeader = event.target.closest("button[data-project-group]");
    if (projectHeader && !projectHeader.disabled) {
      const key = projectHeader.dataset.projectGroup;
      if (key !== "none" && !key.startsWith("project:")) return;
      moreMenuKey = null;
      if (collapsedProjectGroups.has(key)) collapsedProjectGroups.delete(key);
      else collapsedProjectGroups.add(key);
      render();
      return;
    }
    const groupHeader = event.target.closest("button[data-group]");
    if (groupHeader && !groupHeader.disabled) {
      const group = groupHeader.dataset.group;
      if (!STATUS_GROUPS.some((item) => item.id === group)) return;
      moreMenuKey = null;
      if (collapsedGroups.has(group)) collapsedGroups.delete(group);
      else collapsedGroups.add(group);
      render();
      return;
    }
    const button = event.target.closest("button[data-action][data-key]");
    if (!button || button.disabled) return;
    if (button.dataset.action === "more") {
      moreMenuKey = moreMenuKey === button.dataset.key ? null : button.dataset.key;
      render();
      [...list.querySelectorAll('button[data-action="more"]')]
        .find((item) => item.dataset.key === button.dataset.key)
        ?.focus({preventScroll:true});
      return;
    }
    if (button.dataset.action === "alias-edit" ||
        button.dataset.action === "alias-save" ||
        button.dataset.action === "alias-cancel") {
      if (moreMenuKey !== button.dataset.key) return;
      if (button.dataset.action === "alias-edit") beginAliasEdit(button.dataset.key);
      if (button.dataset.action === "alias-save") void saveAlias(button.dataset.key);
      if (button.dataset.action === "alias-cancel") cancelAliasEdit(button.dataset.key);
      return;
    }
    if (["project-edit","project-save","project-cancel"].includes(button.dataset.action)) {
      if (moreMenuKey !== button.dataset.key) return;
      if (button.dataset.action === "project-edit") beginProjectEdit(button.dataset.key);
      if (button.dataset.action === "project-save") void saveProject(button.dataset.key);
      if (button.dataset.action === "project-cancel") cancelProjectEdit(button.dataset.key);
      return;
    }
    // Hidden or stale removal buttons must not bypass the disclosure.
    if (button.dataset.action === "remove" && moreMenuKey !== button.dataset.key) return;
    if (moreMenuKey && button.dataset.action !== "remove") moreMenuKey = null;
    if (button.dataset.action === "pause") void togglePaused(button.dataset.key);
    if (button.dataset.action === "open") void openConversation(button.dataset.key);
    if (button.dataset.action === "remove") {
      moreMenuKey = null;
      render();
      void removeConversation(button.dataset.key);
    }
    if (button.dataset.action === "favorite") void toggleFavorite(button.dataset.key);
    if (button.dataset.action === "details") {
      const key = button.dataset.key;
      if (expandedDetails.has(key)) expandedDetails.delete(key);
      else expandedDetails.add(key);
      render();
    }
    if (button.dataset.action === "activity") {
      const key = button.dataset.key;
      if (expandedActivities.has(key)) expandedActivities.delete(key);
      else expandedActivities.add(key);
      render();
    }
  });
  document.addEventListener("click",(event)=>{
    if (!moreMenuKey || event.target?.closest?.(".session-actions")) return;
    // Never dismiss the only editor holding unsaved local title/project text.
    // Users explicitly save or cancel before navigating away.
    if (aliasEditor || projectEditor || savingAliasKey || savingProjectKey) return;
    moreMenuKey = null;
    render();
  });
  refreshButton.addEventListener("click",()=>void refresh());
  scanPrevButton.addEventListener("click",()=>moveScan(-1));
  scanNextButton.addEventListener("click",()=>moveScan(1));
  scanExitButton.addEventListener("click",()=>{
    clearScan();
    scanNextButton.focus({preventScroll:true});
  });
  cleanupIdleButton.addEventListener("click",()=>void cleanupIdleRecords());
  document.getElementById("jump-review")
    .addEventListener("click",()=>jumpAttention("review"));
  focusReviewButton.addEventListener("click",togglePriorityReview);
  document.getElementById("jump-signal")
    .addEventListener("click",()=>jumpAttention("signal"));
  document.getElementById("toggle-current-panel")
    .addEventListener("click",()=>void toggleCurrentPanel());
  document.getElementById("open-favorites")
    .addEventListener("click",()=>void chrome.tabs.create({
      url:chrome.runtime.getURL("favorites.html"),active:true,
    }).catch((error)=>showFeedback(error?.message || "无法打开提示词收藏夹",true)));
  chrome.storage.onChanged?.addListener((changes,area)=>{
    if (area !== "local") return;
    if (changes[VIEW_SETTINGS_KEY]) {
      applyViewPreferences(changes[VIEW_SETTINGS_KEY].newValue);
    }
    if (changes[ALIASES_KEY]) {
      applyAliases(changes[ALIASES_KEY].newValue);
    }
    if (changes[PROJECTS_KEY]) {
      applyProjects(changes[PROJECTS_KEY].newValue);
    }
    if (changes["cq.state.v2"]) void refresh();
  });
  setInterval(()=>{ if (document.visibilityState !== "hidden") void refresh(); },2500);
  void (async()=>{
    await Promise.all([loadViewPreferences(),loadAliases(),loadProjects()]);
    await refresh();
  })();
})();
