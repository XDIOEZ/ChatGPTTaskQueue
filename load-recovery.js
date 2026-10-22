/* global window, document, location, sessionStorage, navigator */
"use strict";

// Deliberately independent of chrome.runtime and queue initialization. Old
// content scripts lose their runtime bridge when an unpacked extension reloads.
(() => {
  const VERSION = "0.49.55";
  const previous = globalThis.__cqLoadRecoveryGuardian;
  if (previous?.version === VERSION) { previous.scan(); return; }
  previous?.stop?.();

  const KEY = "cq.conversationLoadRecovery.v1:";
  const REFRESH_INTERVAL_MS = 60000;
  const TRANSPORT_CHECK_INTERVAL_MS = 5 * 60000;
  const TRANSPORT_KEY = "cq.transportErrorRecovery.v1:";
  const foreign = '#cq-extension-root, aside, nav, header, [role="navigation"], ' +
    '[role="dialog"], [aria-modal="true"], [role="menu"], ' +
    '[data-testid^="conversation-turn-"], [data-message-author-role], ' +
    '[data-turn="assistant"], [data-turn="user"], [data-conversation-role], ' +
    '[data-content-search-unit-key$=":user"], [data-content-search-unit-key$=":assistant"], ' +
    '[data-user-message-bubble], [data-markdown-text-style="assistant-message"], ' +
    '[data-testid="user-message"], [data-testid="message-content"], ' +
    '[data-testid*="writing-block"], [data-testid*="artifact"], .markdown, pre, code, blockquote';
  // Native transport notices may be inside the latest assistant turn, but
  // authored text, quoted examples, sidebars and plugin UI are never errors.
  const nativeForeign = '#cq-extension-root, aside, nav, header, [role="navigation"], ' +
    '[role="dialog"], [aria-modal="true"], [role="menu"], ' +
    '[data-message-author-role="user"], [data-turn="user"], [data-conversation-role="user"], ' +
    '[data-content-search-unit-key$=":user"], [data-user-message-bubble], [data-testid="user-message"], ' +
    '[data-markdown-text-style="assistant-message"], [data-testid*="writing-block"], ' +
    '[data-testid*="artifact"], .markdown, pre, code, blockquote';
  const normal = (value) => String(value || "").replace(/\s+/g, " ").trim();
  const rendered = (element) => {
    if (!element?.isConnected || !element.getClientRects().length ||
        element.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
    for (let node = element; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.display === "none" || style.visibility !== "visible" ||
          style.contentVisibility === "hidden" || Number(style.opacity) <= 0.01) return false;
    }
    return true;
  };

  function currentUrl() { return location.href; }
  function reloadErrorPage() { location.reload(); }
  let errorButton = null;
  let status = null;
  function showStatus(message) {
    if (!message) { status?.remove(); status = null; return; }
    if (!errorButton?.isConnected) return;
    if (!status?.isConnected) {
      status = document.createElement("div");
      status.dataset.cqLoadRecoveryStatus = VERSION;
      status.setAttribute("role", "status");
      status.style.cssText = "font-size:12px;opacity:.75;margin-top:12px;text-align:center";
      status.title = `ChatGPT 自动对话队列 v${VERSION}`;
      errorButton.parentElement?.append(status);
    }
    if (status.textContent !== message) status.textContent = message;
  }
  function conversationUrl(value) {
    try {
      const url = new URL(value);
      return url.protocol === "https:" && ["chatgpt.com", "chat.openai.com"].includes(url.hostname) &&
        /(?:^|\/)c\/[a-zA-Z0-9-]+\/?$/.test(url.pathname) ? url : null;
    } catch { return null; }
  }

  function detectError() {
    const error = /无法加载(?:此|这个|该)?\s*(?:ChatGPT\s*)?(?:对话|聊天|项目)|(?:unable\s+to|could\s+not|couldn['’]t|failed\s+to)\s+load\s+(?:this\s+|the\s+)?(?:ChatGPT\s+)?(?:conversation|project)/i;
    // Some native error layouts have no main at all. Pair the Retry with its
    // own compact error surface instead of matching the whole document text.
    for (const button of document.querySelectorAll('button, [role="button"]')) {
      if (!rendered(button) || button.closest(foreign)) continue;
      if (![button.getAttribute("aria-label"), button.getAttribute("title"), button.textContent]
        .some((label) => /^(?:重试|再试一次|retry|try again)$/i.test(normal(label)))) continue;
      for (let surface = button.parentElement, depth = 0; surface && depth < 10;
          surface = surface.parentElement, depth++) {
        if (surface.closest(foreign) || surface.querySelector(foreign)) break;
        const text = normal(surface.innerText || surface.textContent);
        if (text.length > 600) break;
        if (rendered(surface) && error.test(text)) { errorButton = button; return true; }
        if (surface === document.body || surface === document.documentElement) break;
      }
    }
    return false;
  }

  let transportErrorNode = null;
  let transportErrorKind = null;
  let disconnectObservation = null;
  function detectTransportError(now = Date.now()) {
    transportErrorNode = null;
    transportErrorKind = null;
    const main = document.querySelector('main, [role="main"]');
    if (!main) { disconnectObservation = null; return false; }
    const turnSelector = '[data-message-author-role], [data-turn="assistant"], [data-turn="user"], ' +
      '[data-conversation-role], [data-content-search-unit-key$=":assistant"], ' +
      '[data-content-search-unit-key$=":user"]';
    const lastTurn = [...main.querySelectorAll(turnSelector)].filter(rendered).at(-1);
    const current = (element) => rendered(element) && !element.closest(nativeForeign) &&
      (!lastTurn || lastTurn.contains(element) ||
        Boolean(lastTurn.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING));
    const errorText = (element) => {
      const text = normal(element.innerText || element.textContent);
      return text.length <= 350 && /消息(?:传输|发送|投递)超时|(?:message|response)\s+(?:transport|transmission|delivery)\s+(?:timed?\s*out|timeout)/i.test(text);
    };
    for (const element of main.querySelectorAll('[role="alert"], [data-testid*="error"], [data-state="error"]')) {
      if (current(element) && !element.querySelector(nativeForeign) && errorText(element)) {
        transportErrorNode = element;
        transportErrorKind = "timeout";
        disconnectObservation = null;
        errorButton = element.querySelector('button, [role="button"]');
        return true;
      }
    }
    for (const button of main.querySelectorAll('button, [role="button"]')) {
      if (!current(button) || ![button.getAttribute("aria-label"),button.getAttribute("title"),button.textContent]
        .some(label => /^(?:重试|再试一次|retry|try again)$/i.test(normal(label)))) continue;
      for (let surface = button.parentElement, depth = 0; surface && surface !== main && depth < 5;
          surface = surface.parentElement, depth++) {
        if (!current(surface) || surface.querySelector(nativeForeign)) break;
        if (normal(surface.innerText || surface.textContent).length > 350) break;
        if (errorText(surface)) {
          transportErrorNode = surface;
          transportErrorKind = "timeout";
          disconnectObservation = null;
          errorButton = button;
          return true;
        }
      }
    }
    // This native interrupted-connection card has neither Retry nor alert.
    // Search only the current reply's UI leaves, pruning authored surfaces
    // and composers so quoted instructions/drafts cannot request a refresh.
    const scope = lastTurn || main;
    const walker = document.createTreeWalker(scope, NodeFilter.SHOW_ELEMENT, {
      acceptNode(element) {
        return element.matches(`${nativeForeign}, form, [contenteditable], [role="textbox"]`)
          ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
      },
    });
    for (let element = scope; element; element = walker.nextNode()) {
      if (!element.matches("div, p, span") || !current(element) ||
          element.querySelector(`${nativeForeign}, form, [contenteditable], [role="textbox"]`)) continue;
      const text = normal(element.textContent);
      if (text.length > 120) continue;
      if (!/^(?:连接已中断[，,。]?\s*正在等待完整(?:答复|回复|回答)|connection (?:interrupted|lost)[,.]?\s*waiting for (?:the |a )?(?:complete|full) (?:response|reply))[。.!…]*$/i.test(text)) continue;
      transportErrorNode = element;
      transportErrorKind = "disconnected";
      errorButton = null;
      // Time/status widgets can keep ticking while a disconnected response
      // is frozen. Track actual authored answer content instead of that clock.
      const parts = [...scope.querySelectorAll('.markdown, [data-markdown-text-style="assistant-message"], [data-message-content-part]')];
      const body = parts.length ? parts.map(part => normal(part.textContent)).join("\n") : normal(scope.textContent);
      const previous = disconnectObservation;
      if (!previous || previous.url !== currentUrl() || previous.node !== element ||
          previous.turn !== lastTurn || previous.body !== body) {
        disconnectObservation = {url:currentUrl(),node:element,turn:lastTurn,body,since:now};
      }
      return true;
    }
    disconnectObservation = null;
    return false;
  }

  function disconnectRefreshReady(now = Date.now()) {
    return detectTransportError(now) && transportErrorKind === "disconnected" &&
      now - disconnectObservation.since >= TRANSPORT_CHECK_INTERVAL_MS;
  }

  function domSafe(allowDisconnectedGeneration = false) {
    if (navigator.onLine === false || document.readyState === "loading") return false;
    const plugin = document.getElementById("cq-extension-root");
    if (document.documentElement?.getAttribute("data-cq-unsaved-draft") === "true" ||
        plugin?.getAttribute("data-cq-unsaved-draft") === "true") return false;
    if (plugin && (plugin.querySelector('[data-image-zone] .cq-images img') ||
        [...plugin.querySelectorAll("input, textarea, select")].some((input) => {
          if (input.type === "file") return Boolean(input.files?.length);
          if (["checkbox", "radio"].includes(input.type)) return input.checked !== input.defaultChecked;
          if (input.tagName === "SELECT") {
            const selected = [...input.options].find((option) => option.defaultSelected) || input.options[0];
            return input.value !== (selected?.value || "");
          }
          return input.value !== input.defaultValue ||
            input.matches("#cq-queue-draft, #cq-schedule-draft, #cq-edit-task-input") && normal(input.value);
        }))) return false;
    // Include visible side-panel/search drafts too. A recovery must never
    // erase a user edit simply because no recognized prompt editor exists.
    for (const input of document.querySelectorAll('textarea, input, [contenteditable="true"]')) {
      if (input.type === "file" && input.files?.length) return false;
      if (!rendered(input) || plugin?.contains(input)) continue;
      if (["checkbox", "radio", "button", "submit", "reset", "hidden", "file"].includes(input.type)) continue;
      if (normal(input.matches("textarea, input") ? input.value : input.innerText || input.textContent)) return false;
    }
    const frames = [...document.querySelectorAll('form, [data-testid="composer"], [data-chatgpt-composer]')]
      .filter((frame) => rendered(frame) && !frame.closest(foreign));
    const attachments = '[data-testid="file-chip"], [data-testid="attachment-preview"], ' +
      '[data-testid="composer-attachment-preview"], [data-testid="image-file-thumbnail"], ' +
      '[data-testid="file-upload-preview"], img[src^="blob:"], img[src^="data:image/"], ' +
      '[data-testid*="upload-progress"], [aria-busy="true"]';
    if (frames.some((frame) => [...frame.querySelectorAll(attachments)].some(rendered) ||
        [...frame.querySelectorAll('input[type="file"]')].some((input) => input.files?.length))) return false;
    const staleDisconnectedGeneration = allowDisconnectedGeneration === true && disconnectRefreshReady();
    if (!staleDisconnectedGeneration && [...document.querySelectorAll('button, [data-is-streaming="true"], [data-state="streaming"], [data-testid="generation-in-progress"]')]
      .some((element) => {
        if (!rendered(element) || element.closest(nativeForeign)) return false;
        if (!element.matches("button")) return true;
        const id = element.getAttribute("data-testid") || "";
        const label = element.getAttribute("aria-label") || element.getAttribute("title") || "";
        return /(?:^|-)stop-button$|composer-stop-button/i.test(id) ||
          /^(?:stop(?:\s+(?:generating|generation|response|responding|streaming))?|停止(?:生成|回复|回答|响应)?|结束生成)$/i.test(label.trim()) ||
          frames.some((frame) => frame.contains(element)) && [...element.querySelectorAll("svg.icon-primary-action > path")]
            .some((path) => (path.getAttribute("d") || "").startsWith("M4.5 5.75C4.5 5.05964"));
      })) return false;
    return true;
  }

  let route = null;
  let errorSince = null;
  let healthySince = null;
  let reloadIssued = false;
  let guard = null;
  let stopped = false;
  let nextTransportCheckAt = 0;
  function scanTransport(now, href, url) {
    // Observe connection recovery/progress between scheduled refresh checks.
    const found = detectTransportError(now);
    if (now < nextTransportCheckAt) return false;
    nextTransportCheckAt = now + TRANSPORT_CHECK_INTERVAL_MS;
    if (!found) return false;
    const expectedError = transportErrorNode;
    const recovery = {allowDisconnectedGeneration:disconnectRefreshReady(now)};
    if (reloadIssued) return true;
    if (!domSafe(recovery.allowDisconnectedGeneration)) { showStatus("检测到连接异常，草稿或页面操作结束后再检查刷新"); return true; }
    try {
      if (guard && guard(recovery) !== true) return true;
      const key = TRANSPORT_KEY + url.pathname;
      let previous = null;
      try { previous = JSON.parse(sessionStorage.getItem(key) || "null"); } catch { /* Old/corrupt counter. */ }
      if (Number.isFinite(previous?.lastAt) && now - previous.lastAt < TRANSPORT_CHECK_INTERVAL_MS) return true;
      // Re-check the same native error and route immediately before reloading.
      // Refresh only; never invoke Retry or resubmit an uncertain message.
      if (currentUrl() !== href || !detectTransportError(now) || transportErrorNode !== expectedError ||
          !domSafe(recovery.allowDisconnectedGeneration) || guard && guard(recovery) !== true) return true;
      sessionStorage.setItem(key, JSON.stringify({lastAt:now}));
    } catch {
      showStatus("暂时无法确认刷新安全，将在下一轮检查");
      return true;
    }
    reloadIssued = true;
    showStatus("检测到连接异常，正在自动刷新…");
    reloadErrorPage();
    return true;
  }
  function scan(now = Date.now()) {
    if (stopped) return false;
    const href = currentUrl();
    if (route !== href) {
      route = href; errorSince = healthySince = null; reloadIssued = false;
      disconnectObservation = null;
      nextTransportCheckAt = now + TRANSPORT_CHECK_INTERVAL_MS;
    }
    const url = conversationUrl(href);
    if (!url) { showStatus(""); return false; } // Project recovery stays with its queue owner.
    if (scanTransport(now,href,url)) return true;
    const key = KEY + url.pathname;
    if (!detectError()) {
      showStatus("");
      errorSince = null;
      const editor = [...document.querySelectorAll(
        '#prompt-textarea, [data-testid="prompt-textarea"], [data-testid="composer-input"], [data-composer-markdown][role="textbox"]'
      )].find((element) => rendered(element) && !element.closest(foreign) &&
        element.closest('form, [data-testid="composer"], [data-chatgpt-composer]'));
      if (editor && domSafe()) {
        healthySince ??= now;
        if (now - healthySince >= 30000) { try { sessionStorage.removeItem(key); } catch { /* Optional. */ } }
      } else healthySince = null;
      return false;
    }
    healthySince = null;
    errorSince ??= now;
    if (reloadIssued) { showStatus("正在自动刷新，队列记录保持不变…"); return true; }
    if (navigator.onLine === false) { showStatus("当前网络离线，联网后自动重试"); return true; }
    if (!domSafe()) { showStatus("检测到草稿或页面操作，自动刷新暂缓"); return true; }
    if (guard) {
      try { if (guard() !== true) { showStatus("队列正在处理草稿或发送操作，自动刷新暂缓"); return true; } }
      catch { showStatus("暂时无法确认草稿安全，自动刷新暂缓"); return true; }
    }
    const stableRemaining = REFRESH_INTERVAL_MS - (now - errorSince);
    if (stableRemaining > 0) { showStatus(`加载失败，插件将在 ${Math.ceil(stableRemaining / 1000)} 秒后自动刷新`); return true; }
    let previous = null;
    try {
      try { previous = JSON.parse(sessionStorage.getItem(key) || "null"); } catch { /* Malformed record. */ }
      const attempts = Number.isInteger(previous?.attempts) && previous.attempts >= 0
        ? Math.min(previous.attempts, Number.MAX_SAFE_INTEGER - 1) : 0;
      if (Number.isFinite(previous?.lastAt) && previous.lastAt >= 0 &&
          now - previous.lastAt < REFRESH_INTERVAL_MS) {
        const remaining = REFRESH_INTERVAL_MS - (now - previous.lastAt);
        showStatus(`加载仍未恢复，${Math.ceil(remaining / 1000)} 秒后再次刷新`);
        return true;
      }
      if (href !== currentUrl() || !detectError() || !domSafe()) return true;
      if (guard && guard() !== true) return true;
      sessionStorage.setItem(key, JSON.stringify({attempts: attempts + 1, lastAt: now}));
    } catch {
      showStatus("无法保存刷新间隔，请手动刷新页面");
      return true;
    } // No persistent budget means no automatic reload.
    reloadIssued = true;
    showStatus("正在自动刷新，队列记录保持不变…");
    reloadErrorPage();
    return true;
  }
  const timer = window.setInterval(() => scan(), 1300);
  const onWake = () => scan();
  window.addEventListener("online", onWake);
  window.addEventListener("focus", onWake);
  document.addEventListener("visibilitychange", onWake);
  globalThis.__cqLoadRecoveryGuardian = {
    version: VERSION, detectError, detectTransportError, disconnectRefreshReady, domSafe, scan,
    setGuard(callback) { guard = typeof callback === "function" ? callback : null; },
    stop() {
      stopped = true;
      showStatus("");
      window.clearInterval(timer);
      window.removeEventListener("online", onWake);
      window.removeEventListener("focus", onWake);
      document.removeEventListener("visibilitychange", onWake);
    },
  };
  scan();
})();
