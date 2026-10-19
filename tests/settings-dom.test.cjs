"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawnSync } = require("node:child_process");

const browser = process.env.CQ_BROWSER_BIN || (process.platform === "win32"
  ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
  : "/usr/bin/google-chrome");

test("真实 Chrome DOM 可以打开设置、保存上限并创建数量触发规则", {
  skip: !fs.existsSync(browser) && "Chrome is not installed",
}, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cq-settings-"));
  try {
    fs.copyFileSync(path.join(__dirname, "..", "content.js"), path.join(dir, "content.js"));
    fs.copyFileSync(path.join(__dirname, "..", "panel.css"), path.join(dir, "panel.css"));
    fs.writeFileSync(path.join(dir, "index.html"), `<!doctype html>
<html><head><meta charset="utf-8"><link rel="stylesheet" href="./panel.css"></head><body>
<main><form><textarea id="prompt-textarea"></textarea>
<button type="button" aria-label="Start Voice"></button>
</form></main>
<script>
const state = {
  key: "draft:1", halted: false, haltReason: null, activeTaskId: null,
  tasks: [], schedules: [], autoOpenTab: false, queuePaused: false,
  countRateLimit: { enabled: false, windowMinutes: 10, maxAdds: 3 },
  countRateTimes: [],
};
const settings = {
  maxPending: 100, protectBackground: true,
  defaultIntervalMinutes: 30, defaultRepeatCount: -1,
};
const requests = [];
window.chrome = {
  runtime: {
    onMessage: { addListener() {} },
    async sendMessage(message) {
      requests.push(message);
      if (message.type === "SAVE_SETTINGS") {
        settings.maxPending = Number(message.maxPending);
        if (message.defaultIntervalMinutes !== undefined) {
          settings.defaultIntervalMinutes = Number(message.defaultIntervalMinutes);
        }
        if (message.defaultRepeatCount !== undefined) {
          settings.defaultRepeatCount = Number(message.defaultRepeatCount);
        }
      }
      if (message.type === "PROTECT_BACKGROUND") {
        settings.protectBackground = message.enabled;
      }
      if (message.type === "SET_QUEUE_PAUSED") {
        state.queuePaused = message.paused;
      }
      if (message.type === "SAVE_COUNT_RATE_LIMIT") {
        state.countRateLimit = {
          enabled: message.enabled,
          windowMinutes: Number(message.windowMinutes),
          maxAdds: Number(message.maxAdds),
        };
      }
      if (message.type === "ADD_SCHEDULE") {
        state.schedules.push({
          id: "count-schedule", text: message.text,
          mode: message.mode, threshold: Number(message.threshold),
          repeatCount: Number(message.repeatCount),
          runCount: 0, enabled: true, nextRunAt: null,
        });
      }
      return { ok: true, sessionKey: "draft:1", state, settings };
    },
  },
  storage: { onChanged: { addListener() {} } },
};
</script>
<script src="./content.js"></script>
<script>
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
setTimeout(async () => {
  const flags = {};
  try {
    const root = document.querySelector("#cq-extension-root");
    const main = root.querySelector(".cq-inline");
    const top = root.querySelector(".cq-toolbar");
    const footer = root.querySelector(".cq-footer-toolbar");
    const footerActions = ["queue-composer",
      "toggle-scheduler", "toggle-settings", "toggle-queue"];
    flags.statusOnlyAtTop = top.querySelector(".cq-queue-label strong")?.textContent === "Queue" &&
      top.querySelector(".cq-queue-label span")?.textContent === "0" &&
      top.querySelectorAll("button").length === 0;
    flags.actionsAtBottom = main.lastElementChild === footer &&
      footerActions.every((action) =>
        !!footer.querySelector('button[data-action="' + action + '"]')) &&
      !footer.querySelector('[data-action="toggle-queue-composer"]') &&
      !root.querySelector(".cq-toolbar .cq-tool") &&
      !!footer.querySelector(".cq-shortcuts .cq-enter-action");
    flags.footerBelowContent = footer.getBoundingClientRect().top >=
      top.getBoundingClientRect().bottom - 1;
    flags.pauseAvailable = !!root.querySelector('[data-action="toggle-queue-paused"]');
    root.querySelector('[data-action="toggle-queue-paused"]').click();
    await delay(35);
    flags.pauseActive = state.queuePaused === true &&
      !!root.querySelector(".cq-status-paused") &&
      root.querySelector('[data-action="toggle-queue-paused"]')?.getAttribute("aria-pressed") === "true";
    root.querySelector('[data-action="toggle-queue-paused"]').click();
    await delay(35);
    flags.pauseReenabled = state.queuePaused === false &&
      !root.querySelector(".cq-status-paused") &&
      root.querySelector('[data-action="toggle-queue-paused"]')?.getAttribute("aria-pressed") === "false";
    root.querySelector('[data-action="toggle-settings"]').click();
    const pageVisible = (page) => {
      const element = root.querySelector('#cq-settings-page-' + page);
      return Boolean(element && !element.hidden && getComputedStyle(element).display !== 'none');
    };
    const selectPage = (page) => root.querySelector(
      '[data-action="show-settings-page"][data-page="' + page + '"]').click();
    flags.settingsTabbed = root.querySelectorAll('.cq-settings-tabs [role="tab"]').length === 4 &&
      !!root.querySelector('.cq-settings-tabs[role="tablist"]') &&
      pageVisible('cooldown') && !pageVisible('general') &&
      !pageVisible('background') && !pageVisible('diagnostics') &&
      root.querySelector('[data-page="cooldown"]').getAttribute('aria-selected') === 'true';
    selectPage('general');
    flags.generalOnly = pageVisible('general') && !pageVisible('cooldown') &&
      !pageVisible('background') && !pageVisible('diagnostics');
    flags.queueImageEditorUnderSettings = pageVisible('general') &&
      !!root.querySelector('#cq-settings-page-general [data-action="toggle-queue-composer"]') &&
      !footer.querySelector('[data-action="toggle-queue-composer"]');
    flags.open = !!root.querySelector("#cq-max-pending") &&
      root.querySelector("#cq-max-pending").value === "100";
    flags.defaultValuesInitially = root.querySelector("#cq-default-minutes")?.value === "30" &&
      root.querySelector("#cq-default-repeats")?.value === "-1";
    const input = root.querySelector("#cq-max-pending");
    input.value = "2";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    const defaultMinutes = root.querySelector("#cq-default-minutes");
    defaultMinutes.value = "12";
    defaultMinutes.dispatchEvent(new Event("input", { bubbles: true }));
    const defaultRepeats = root.querySelector("#cq-default-repeats");
    defaultRepeats.value = "2";
    defaultRepeats.dispatchEvent(new Event("input", { bubbles: true }));
    selectPage('background');
    flags.settingsDraftAcrossTabs = pageVisible('background') && !pageVisible('general') &&
      root.querySelector('[data-settings-dirty="general"]')?.hidden === false &&
      root.querySelector('#cq-max-pending')?.value === '2' &&
      root.querySelector('.cq-draft-hint[data-draft-hint="settings"]')?.hidden === false;
    root.querySelector('[data-page="background"]').focus();
    root.querySelector('[data-page="background"]').dispatchEvent(new KeyboardEvent('keydown', {
      key:'ArrowLeft',bubbles:true,cancelable:true,
    }));
    flags.settingsKeyboard = pageVisible('general') &&
      document.activeElement?.dataset.page === 'general';
    root.querySelector('[data-action="save-settings"]').click();
    await delay(50);
    flags.saved = requests.some((request) =>
      request.type === "SAVE_SETTINGS" && request.maxPending === "2" &&
      request.defaultIntervalMinutes === "12" && request.defaultRepeatCount === "2");
    flags.defaultValuesSaved = settings.defaultIntervalMinutes === 12 &&
      settings.defaultRepeatCount === 2 &&
      root.querySelector("#cq-default-minutes")?.value === "12" &&
      root.querySelector("#cq-default-repeats")?.value === "2";
    selectPage('background');
    flags.backgroundOnly = pageVisible('background') && !pageVisible('general');
    flags.defaultProtected = !!root.querySelector("#cq-protect-background")?.checked;
    flags.browserGuidance = root.textContent.includes("chatgpt.com") &&
      root.textContent.includes("始终保持这些网站处于活动状态");
    root.querySelector("#cq-protect-background").click();
    await delay(50);
    flags.disabledProtection = settings.protectBackground === false &&
      requests.some((request) => request.type === "PROTECT_BACKGROUND" && request.enabled === false) &&
      root.querySelector("#cq-protect-background")?.checked === false;
    root.querySelector("#cq-protect-background").click();
    await delay(50);
    flags.reenabledProtection = settings.protectBackground === true &&
      requests.some((request) => request.type === "PROTECT_BACKGROUND" && request.enabled === true) &&
      root.querySelector("#cq-protect-background")?.checked === true;
    selectPage('diagnostics');
    flags.diagnosticsOnly = pageVisible('diagnostics') && !pageVisible('background') &&
      !!root.querySelector('#cq-diagnostics-content') &&
      root.querySelector('[data-action="toggle-diagnostics"]')?.getAttribute('aria-expanded') === 'true';

    root.querySelector('[data-action="toggle-scheduler"]').click();
    flags.panelSwitched = !root.querySelector("#cq-max-pending") &&
      !!root.querySelector("#cq-schedule-mode");
    const advancedToggle = root.querySelector('[data-action="toggle-auto-advanced"]');
    const advancedPanel = root.querySelector("#cq-auto-advanced");
    flags.autoAdvancedDefaultCollapsed = advancedToggle?.getAttribute("aria-expanded") === "false" &&
      advancedToggle === root.querySelector(".cq-scheduler-tabs")?.lastElementChild &&
      advancedPanel?.hidden === true && getComputedStyle(advancedPanel).display === "none";
    advancedToggle.click();
    flags.autoAdvancedOpens = root.querySelector('[data-action="toggle-auto-advanced"]')
      ?.getAttribute("aria-expanded") === "true" &&
      root.querySelector("#cq-auto-advanced")?.hidden === false &&
      root.querySelector("#cq-count-rate-enabled")?.getClientRects().length > 0 &&
      !!root.querySelector("#cq-handoff-enabled") && !!root.querySelector("#cq-auto-open");
    flags.localRateControls = root.querySelector("#cq-count-rate-enabled")?.checked === false &&
      root.querySelector("#cq-count-rate-minutes")?.value === "10" &&
      root.querySelector("#cq-count-rate-max")?.value === "3" &&
      root.textContent.includes("仅当前对话，不是全局设置");
    const limitWindow = root.querySelector("#cq-count-rate-minutes");
    limitWindow.value = "8";
    limitWindow.dispatchEvent(new Event("input", { bubbles: true }));
    const limitMax = root.querySelector("#cq-count-rate-max");
    limitMax.value = "2";
    limitMax.dispatchEvent(new Event("input", { bubbles: true }));
    root.querySelector("#cq-count-rate-enabled").click();
    root.querySelector('[data-action="save-count-rate"]').click();
    await delay(70);
    flags.savedConversationRate = requests.some((request) =>
      request.type === "SAVE_COUNT_RATE_LIMIT" && request.enabled === true &&
      request.windowMinutes === "8" && request.maxAdds === "2") &&
      state.countRateLimit.windowMinutes === 8 &&
      state.countRateLimit.maxAdds === 2 &&
      !Object.hasOwn(settings, "countRateLimit");
    flags.rateStatusVisible = root.querySelector(".cq-count-rate-status")
      ?.textContent.includes("0/2") &&
      root.querySelector("#cq-count-rate-minutes")?.value === "8";
    root.querySelector('[data-action="toggle-auto-advanced"]').focus();
    root.querySelector('[data-action="toggle-auto-advanced"]').click();
    flags.autoAdvancedCloses = root.querySelector("#cq-auto-advanced")?.hidden === true &&
      root.querySelector('[data-action="toggle-auto-advanced"]')
        ?.getAttribute("aria-expanded") === "false" &&
      document.activeElement?.dataset.action === "toggle-auto-advanced";
    root.querySelector('[data-action="toggle-auto-advanced"]').click();
    flags.autoAdvancedPreservesSettings = root.querySelector("#cq-count-rate-enabled")?.checked &&
      root.querySelector("#cq-count-rate-minutes")?.value === "8" &&
      root.querySelector("#cq-count-rate-max")?.value === "2";
    flags.newTaskUsesDefaults = root.querySelector("#cq-minutes")?.value === "12" &&
      root.querySelector("#cq-repeats")?.value === "2";
    const mode = root.querySelector("#cq-schedule-mode");
    mode.value = "count";
    mode.dispatchEvent(new Event("change", { bubbles: true }));
    flags.countControls = !root.querySelector("#cq-minutes") &&
      !!root.querySelector("#cq-threshold");
    const draft = root.querySelector("#cq-schedule-draft");
    draft.value = "下一条任务";
    draft.dispatchEvent(new Event("input", { bubbles: true }));
    const threshold = root.querySelector("#cq-threshold");
    threshold.value = "2";
    threshold.dispatchEvent(new Event("input", { bubbles: true }));
    root.querySelector('[data-action="save-schedule"]').click();
    await delay(50);
    flags.ruleSaved = requests.some((request) =>
      request.type === "ADD_SCHEDULE" && request.mode === "count" &&
      request.threshold === "2" && request.text === "下一条任务" &&
      request.repeatCount === "2");
    flags.ruleVisible = root.textContent.includes("队列 0/2") &&
      root.textContent.includes("下一条任务");
    flags.separated = !root.querySelector("#cq-schedule-draft") &&
      !!root.querySelector('[data-action="show-schedule-create"]');
    flags.rateOnListView = !!root.querySelector(".cq-count-rate-panel") &&
      root.querySelector("#cq-count-rate-enabled")?.checked;
    root.querySelector('[data-action="show-schedule-create"]').click();
    flags.createOnly = !!root.querySelector("#cq-schedule-draft") &&
      !root.querySelector(".cq-schedule-item");
    flags.rateOnCreateView = root.querySelector("#cq-count-rate-minutes")?.value === "8" &&
      root.querySelector("#cq-count-rate-max")?.value === "2";
    flags.reopeningCreationUsesDefaults = root.querySelector("#cq-minutes")?.value === "12" &&
      root.querySelector("#cq-repeats")?.value === "2";
    root.querySelector('[data-action="show-schedule-list"]').click();
    flags.listOnly = !root.querySelector("#cq-schedule-draft") &&
      !!root.querySelector(".cq-schedule-item");
    state.countRateTimes = [Date.now() - 1000, Date.now()];
    root.querySelector('[data-action="show-schedule-create"]').click();
    root.querySelector('[data-action="show-schedule-list"]').click();
    flags.quotaCountdown = root.querySelector(".cq-count-rate-status")?.textContent.includes("2/2") &&
      !!root.querySelector(".cq-count-rate-status .cq-countdown") &&
      root.querySelector(".cq-schedule-item")?.textContent.includes("已达本对话补队限额");
    state.countRateTimes = [];
    // An existing rule can differ from newly configured defaults.
    state.schedules[0].repeatCount = 6;
    root.querySelector('[data-action="edit-schedule"]').click();
    flags.editPreservesOwnCount = root.querySelector("#cq-repeats")?.value === "6" &&
      root.querySelector("#cq-schedule-mode")?.value === "count";
    root.querySelector('[data-action="cancel-edit-schedule"]').click();
    root.querySelector('.cq-bottom-actions [data-action="toggle-queue"]').click();
    flags.collapsedActions = root.querySelector(".cq-inline").lastElementChild ===
      root.querySelector(".cq-footer-toolbar") &&
      !root.querySelector(".cq-shortcuts") &&
      !root.querySelector(".cq-scheduler") &&
      footerActions.every((action) =>
        !!root.querySelector('.cq-bottom-actions button[data-action="' + action + '"]')) &&
      root.querySelector('.cq-bottom-actions [data-action="toggle-queue"]')?.getAttribute("aria-label") === "展开队列";
    root.querySelector('.cq-bottom-actions [data-action="toggle-settings"]').click();
    flags.reopenFromFooter = !!root.querySelector("#cq-max-pending") &&
      root.querySelector('.cq-bottom-actions [data-action="toggle-settings"]')
        ?.classList.contains("cq-tool-active");
    state.halted = true;
    state.haltReason = "state_inconsistent";
    state.error = "检测到不完整的任务状态";
    state.tasks = [
      {id:"uncertain",text:"发送结果未知",status:"error",
        error:"异常重启后发送状态无法确认，已隔离"},
      {id:"not-sent",text:"还没有发送",status:"pending"},
    ];
    root.querySelector('.cq-bottom-actions [data-action="toggle-settings"]').click();
    flags.crashReviewNotice = root.querySelector(".cq-notice")?.textContent
      .includes("可能已有消息发出") &&
      root.querySelector(".cq-notice")?.textContent.includes("不会自动重发") &&
      !!root.querySelector('[data-action="skip-failed"][data-id="uncertain"]');
    flags.crashReviewKeepsPending = root.querySelector(".cq-list")?.textContent
      .includes("还没有发送");
  } catch (error) {
    flags.error = error.message;
  }
    flags.ok = ["statusOnlyAtTop", "actionsAtBottom", "footerBelowContent",
      "pauseAvailable", "pauseActive", "pauseReenabled",
      "collapsedActions", "reopenFromFooter", "crashReviewNotice",
      "crashReviewKeepsPending", "open", "saved", "settingsTabbed", "generalOnly",
        "settingsDraftAcrossTabs", "settingsKeyboard", "backgroundOnly", "diagnosticsOnly",
        "queueImageEditorUnderSettings",
       "defaultValuesInitially", "defaultValuesSaved", "newTaskUsesDefaults",
       "reopeningCreationUsesDefaults", "editPreservesOwnCount",
       "autoAdvancedDefaultCollapsed", "autoAdvancedOpens", "autoAdvancedCloses",
       "autoAdvancedPreservesSettings",
      "localRateControls", "savedConversationRate", "rateStatusVisible",
      "rateOnListView", "rateOnCreateView", "quotaCountdown",
      "defaultProtected", "browserGuidance",
      "disabledProtection", "reenabledProtection", "panelSwitched", "countControls",
      "ruleSaved", "ruleVisible", "separated", "createOnly", "listOnly"]
    .every((key) => flags[key] === true);
  document.body.dataset.check = JSON.stringify(flags);
}, 300);
</script></body></html>`);

    const result = spawnSync(browser, [
      "--headless=new", "--disable-gpu", "--disable-extensions", "--no-first-run",
      `--user-data-dir=${path.join(dir, "profile")}`,
      "--virtual-time-budget=2000", "--dump-dom",
      `file:///${path.join(dir, "index.html").replace(/\\/g, "/")}`,
    ], { encoding: "utf8", timeout: 20000, maxBuffer: 6e6 });
    assert.equal(result.status, 0, result.stderr || "Chrome failed");
    const match = result.stdout.match(/data-check="([^"]+)"/);
    assert.ok(match, "Chrome did not execute the settings test");
    const flags = JSON.parse(match[1].replace(/&quot;/g, '"'));
    assert.equal(flags.ok, true, JSON.stringify(flags));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
