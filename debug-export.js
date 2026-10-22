/* global chrome */
"use strict";

// This entry deliberately does not share dashboard state or queue UI setup.
// A failed dashboard refresh must not remove the only way to export evidence.
(() => {
  const button = document.getElementById("export-debug-json");
  if (!button || button.dataset.debugExportBound === "true") return;
  button.dataset.debugExportBound = "true";
  const status = document.getElementById("debug-export-status");
  const KEY = "cq.handoffDebug.v1";
  const MAX_RUNS = 12;
  const MAX_EVENTS = 80;
  const phases = new Set(["idle","queued","due","summarizing","opening","navigating","bootstrapping","failed","completed"]);
  const statuses = new Set(["none","pending","dispatching","waiting","steering","steering_wait","done","error","interrupted"]);
  const kinds = new Set([
    "state","rpc_error","page_wait","native_send_click","navigation_start","navigation_committed","send_uncertain","new_chat_pending",
    "send_prepare","send_reuse","send_wait","send_gate_blocked","claim_release","send_ack","send_exception",
    "adoption_probe","adoption_expand","adoption_result","completion_probe","dispatch_blocked","claim_result",
    "input_start","input_complete","input_failed","send_ready",
  ]);
  const reasons = new Set([
    "none","editor_missing","editor_has_text","attachments_present","native_busy","native_stop",
    "voice_not_ready","assistant_not_new","reply_not_stable","waiting_native_reply","waiting_chat_id",
    "waiting_project_page","page_not_ready","transport_error","native_send_unconfirmed","other_blocker",
    "summary_empty","summary_too_short","summary_too_long","reply_not_confirmed","composer_not_ready",
    "source_changed","project_mismatch","chat_not_confirmed","intro_not_confirmed","timeout",
    "send_uncertain","queue_conflict","other_failure",
    "scope_changed","task_not_owned","send_not_ready","editor_replaced","composer_edited","text_mismatch",
    "attachments_mismatch","upload_busy","claim_released","claim_release_failed","ack_failed","send_exception",
    "prepared_document","adoption_wait","adoption_folded","completion_wait","dispatch_blocked","claim_empty",
    "claim_rejected","claim_exception","claim_acquired",
    "target_exists_shell","target_has_work","owner_mismatch","project_mismatch","source_missing",
    "source_phase","token_mismatch","destination_mismatch","intro_missing","message_mismatch",
    "user_count_mismatch","adopted","ready","cache_mismatch","adoption_ambiguous",
  ]);
  const actions = new Set(["HANDOFF_NOW","HANDOFF_NAVIGATE","HANDOFF_SEND_READY","CONFIRM_HANDOFF","CLAIM","SENT","FINISHED","HELLO","CANCEL_HANDOFF","RELEASE_CLAIM","RETRY_UNSENT_HANDOFF"]);
  const detailNumbers = [
    "textChars","expectedChars","attachmentCount","expectedAttachmentCount","waitMs","userCount","assistantCount",
    "elapsedMs","editorChars","editorNormalizedChars","taskChars","taskNormalizedChars","voiceStableMs",
    "idleStableMs","replyStableMs","sendWaitMs","navigationEpoch","claimedEpoch",
    "inputElapsedMs","inputParagraphs",
    "commonPrefixChars","commonSuffixChars","expectedDifferenceChars","editorDifferenceChars",
    "expectedControlChars","editorControlChars",
    "extraTextChars",
  ];
  const detailBooleans = [
    "scopeCurrent","boundHere","editorConnected","editorCurrent","editorPresent","sendVisible","voiceVisible",
    "stopVisible","nativeBusy","composerEdited","textMatches","hasAttachments","uploadBusy","reuseDocument",
    "resumeCandidate","sourceBound","activeMatches","halted","queuePaused","sendPresent","sendDisabled",
    "composerChanged","trustedEdited","clicked","preparedMatch","exactTextMatches","lastUserFolded",
    "newerAssistant","responseConfirmed","firstUserOnly",
    "targetShell","adopted","usedTolerance",
  ];
  const gates = new Set(["prepare","reuse","wait","final_click","release","ack","adoption","completion","dispatch","export","claim","final_send","wait_send","input","arm"]);
  const inputMethods = new Set(["paste","html","nativeValue"]);
  const taskKinds = new Set(["ordinary","normal","message","普通","handoff_summary","handoff_intro"]);
  const routes = new Set(["project","chat","other"]);
  const sessionKinds = new Set(["draft","chat","none"]);

  function timeout(promise, milliseconds) {
    let timer;
    return Promise.race([
      Promise.resolve(promise),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("unavailable")), milliseconds); }),
    ]).finally(() => clearTimeout(timer));
  }

  function number(value) {
    return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  }

  function enumField(target, key, value, allowed) {
    if (allowed.has(value)) target[key] = value;
  }

  function versionField(target, key, value) {
    if (typeof value === "string" && value.length <= 64 &&
        /^\d{1,6}\.\d{1,6}\.\d{1,6}(?:\.\d{1,6})?(?:-[0-9A-Za-z.-]{1,24})?(?:\+[0-9A-Za-z.-]{1,24})?$/.test(value)) {
      target[key] = value;
    }
  }

  function fallbackDetails(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const result = {};
    for (const key of detailNumbers) {
      const value = number(raw[key]);
      if (value !== undefined && value <= 1_000_000_000) result[key] = value;
    }
    for (const key of detailBooleans) {
      if (typeof raw[key] === "boolean") result[key] = raw[key];
    }
    versionField(result,"contentVersion",raw.contentVersion);
    enumField(result,"gate",raw.gate,gates);
    enumField(result,"taskKind",raw.taskKind,taskKinds);
    enumField(result,"taskStatus",raw.taskStatus,statuses);
    enumField(result,"route",raw.route,routes);
    enumField(result,"sessionKind",raw.sessionKind,sessionKinds);
    enumField(result,"handoffPhase",raw.handoffPhase,phases);
    enumField(result,"inputMethod",raw.inputMethod,inputMethods);
    enumField(result,"textDifferenceKind",raw.textDifferenceKind,
      new Set(["equal","whitespace","format_controls","content"]));
    return Object.keys(result).length ? result : null;
  }

  // Raw local storage also contains private ownership IDs and signatures.
  // Rebuild every retained object from fixed enums, counts and timestamps;
  // never spread raw objects or export error strings/task content.
  function fallbackEvent(raw) {
    if (!raw || typeof raw !== "object" || !kinds.has(raw.kind)) return null;
    const result = {kind:raw.kind};
    for (const key of ["at","summaryChars","pendingTasks","cachedScheduleCount","cachedEnabledScheduleCount","cachedTaskCount"]) {
      const value = number(raw[key]);
      if (value !== undefined) result[key] = value;
    }
    for (const key of ["halted","queuePaused","cacheFound","cacheIdentityMatches","cacheDestinationMatches",
      "destinationRecorded","destinationConfirmed"]) {
      if (typeof raw[key] === "boolean") result[key] = raw[key];
    }
    enumField(result,"phase",raw.phase,phases);
    enumField(result,"reason",raw.reason,reasons);
    enumField(result,"action",raw.action,actions);
    enumField(result,"summaryStatus",raw.summaryStatus,statuses);
    enumField(result,"introStatus",raw.introStatus,statuses);
    enumField(result,"destination",raw.destination,new Set(["none","chat","draft","not_found"]));
    enumField(result,"route",raw.route,routes);
    versionField(result,"backendVersion",raw.backendVersion);
    const details = fallbackDetails(raw.details);
    if (details) result.details = details;
    return result;
  }

  function fallbackRuns(raw) {
    if (!raw || !Array.isArray(raw.runs)) return [];
    return raw.runs.slice(0,MAX_RUNS).filter(run => run && typeof run === "object").map(run => {
      const result = {events:Array.isArray(run.events)
        ? run.events.slice(-MAX_EVENTS).map(fallbackEvent).filter(Boolean) : []};
      for (const key of ["startedAt","endedAt"]) {
        const value = number(run[key]);
        if (value !== undefined) result[key] = value;
      }
      enumField(result,"mode",run.mode,new Set(["manual","automatic"]));
      enumField(result,"status",run.status,new Set(["running","completed","failed","cancelled"]));
      enumField(result,"phase",run.phase,phases);
      versionField(result,"createdBackendVersion",run.createdBackendVersion);
      versionField(result,"lastBackendVersion",run.lastBackendVersion);
      return result;
    });
  }

  function pluginVersion() {
    try { return chrome.runtime.getManifest().version; }
    catch { return "unknown"; }
  }

  async function report() {
    try {
      const reply = await timeout(Promise.resolve().then(() =>
        chrome.runtime.sendMessage({type:"GET_HANDOFF_DEBUG",all:true})),10000);
      if (!reply?.ok || reply.version !== 2 || !Array.isArray(reply.runs)) throw new Error("unavailable");
      return {
        backendVersion:typeof reply.backendVersion === "string" ? reply.backendVersion : null,
        current:reply.current ?? null,runs:reply.runs.slice(0,MAX_RUNS),
        ...(Number.isSafeInteger(reply.capturedAt) ? {capturedAt:reply.capturedAt} : {}),
      };
    } catch {
      let saved = null;
      try {
        const local = await timeout(Promise.resolve().then(() => chrome.storage.local.get(KEY)),3000);
        saved = local?.[KEY];
      } catch { /* Export a minimal report even if the storage API is unavailable. */ }
      return {backendVersion:null,current:null,runs:fallbackRuns(saved),diagnosticStatus:"background_unavailable"};
    }
  }

  button.addEventListener("click",async () => {
    if (button.disabled) return;
    button.disabled = true;
    button.setAttribute("aria-busy","true");
    if (status) status.textContent = "正在生成 DEBUG JSON…";
    try {
      const data = await report();
      const generatedAt = new Date().toISOString();
      const payload = {
        format:"ChatGPTTaskQueue-handoff-debug",version:2,generatedAt,
        pluginVersion:pluginVersion(),...data,
      };
      const url = URL.createObjectURL(new Blob([JSON.stringify(payload,null,2)],{type:"application/json;charset=utf-8"}));
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "ChatGPTTaskQueue-debug-" + generatedAt.replace(/[:.]/g,"-") + ".json";
      anchor.hidden = true;
      document.body.append(anchor);
      try { anchor.click(); }
      finally { anchor.remove(); setTimeout(() => URL.revokeObjectURL(url),60000); }
      if (status) status.textContent = data.diagnosticStatus
        ? "后台暂不可用，已导出本地脱敏 DEBUG JSON"
        : "已导出 DEBUG JSON";
    } catch {
      if (status) status.textContent = "导出未完成，请重新打开扩展管理页再试";
    } finally {
      button.disabled = false;
      button.removeAttribute("aria-busy");
    }
  });

  // The sticky attention bar follows both normal and focused header sizes.
  // This observer is UI-only and remains independent of dashboard fetching.
  const header = button.closest("header");
  if (header && typeof ResizeObserver === "function") {
    const observer = new ResizeObserver(() => {
      document.documentElement.style.setProperty("--cq-dashboard-header-height",Math.ceil(header.getBoundingClientRect().height) + "px");
    });
    observer.observe(header);
  }
})();
