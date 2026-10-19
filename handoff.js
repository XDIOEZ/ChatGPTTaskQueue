/* global globalThis */
"use strict";

// Pure helpers for the automatic context handoff. The service worker owns all
// state transitions; this file never navigates or sends a ChatGPT message.
globalThis.CQHandoff = Object.freeze({
  MIN_MINUTES: 5,
  MAX_MINUTES: 1440,
  DEFAULT_MINUTES: 120,
  START: "[[CHATGPT_TASKQUEUE_HANDOFF_START]]",
  END: "[[CHATGPT_TASKQUEUE_HANDOFF_END]]",

  // Existing project chats may have a display-name suffix ("-homepc"),
  // while ChatGPT's own project link/new-chat entry uses the bare 32-hex ID.
  // Treat both URLs as the same native project, including during a redirect.
  normalizeProjectId(value) {
    if (typeof value !== "string" || !/^g-p-[a-zA-Z0-9-]+$/.test(value)) return null;
    const canonical = value.match(/^(g-p-[a-f0-9]{32})(?:-[a-z0-9-]+)?$/i);
    return canonical ? canonical[1] : value;
  },

  marker(boundary, requestId) {
    if (requestId == null) return boundary; // Pre-upgrade handoffs remain readable.
    if (typeof requestId !== "string" ||
        !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(requestId)) {
      throw new Error("接力请求标识无效");
    }
    return `${boundary.slice(0, -2)}:${requestId}]]`;
  },

  defaults() {
    return {enabled:false,intervalMinutes:120,nextAt:null,phase:"idle"};
  },

  projectId(url) {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "https:" ||
          !["chatgpt.com","chat.openai.com"].includes(parsed.hostname)) return null;
      const match = parsed.pathname.match(
        /^\/g\/(g-p-[a-zA-Z0-9-]+)\/(?:c\/[a-zA-Z0-9-]+|project)\/?$/
      );
      return match ? this.normalizeProjectId(match[1]) : null;
    } catch { return null; }
  },

  projectStart(url) {
    const projectId = this.projectId(url);
    if (!projectId) return null;
    const parsed = new URL(url);
    return `${parsed.origin}/g/${projectId}/project`;
  },

  isProjectStart(url, projectId) {
    return this.projectId(url) === this.normalizeProjectId(projectId) &&
      /^\/g\/g-p-[a-zA-Z0-9-]+\/project\/?$/.test(new URL(url).pathname);
  },

  requireMinutes(value) {
    const minutes = Number(value);
    if (value == null || value === "" || !Number.isInteger(minutes) ||
        minutes < this.MIN_MINUTES || minutes > this.MAX_MINUTES) {
      throw new Error("上下文接力间隔必须是 5～1440 分钟之间的整数");
    }
    return minutes;
  },

  summaryPrompt(requestId = null) {
    const start = this.marker(this.START, requestId);
    const end = this.marker(this.END, requestId);
    return `这段对话即将通过自动接力转移到同一个 ChatGPT 项目中的新对话。请生成一份完整、独立可读、供后续 AI 继续工作的交接记录。\n\n` +
      `请覆盖：1. 用户真实目标与不能改变的约束；2. 当前工作进度及已完成内容；` +
      `3. 重要决策、文件路径、命令、接口、配置和具体结果；4. 尚未解决的问题与风险；` +
      `5. 下一步明确操作顺序、验证点；6. 必须保留的用户偏好。` +
      `把不确定的情况明确写成未知，不要杜撰已完成的工作。不要输出密码、令牌或其他秘密。` +
      `你不用继续执行开发任务，只需总结。记录应尽量完整，建议 3000～8000 个汉字，最多 10000 字符。\n\n` +
      `严格从新的一行输出 ${start}，紧接着输出交接正文，最后在新的一行输出 ${end}。` +
      `两个标记外不输出任何内容。`;
  },

  parseSummary(value, requestId = null) {
    if (typeof value !== "string") throw new Error("没有获取到 AI 的交接总结");
    // ChatGPT can wrap markers in inline code or insert harmless spacing
    // between brackets, name, colon and nonce. Keep requiring the exact UUID
    // for this generation; accepting a bare marker would admit stale replies.
    if (requestId != null) this.marker(this.START,requestId); // Validate the UUID.
    const token = requestId == null ? "" : `\\s*:\\s*${requestId}`;
    const pattern = (name) => new RegExp(
      `\\[\\[\\s*CHATGPT_TASKQUEUE_HANDOFF_${name}${token}\\s*\\]\\]`,"gi");
    const starts = [...value.matchAll(pattern("START"))];
    const ends = [...value.matchAll(pattern("END"))];
    // Use the last complete pair. An assistant may show previous fragments or
    // repeat its own instructions before the final record.
    const pair = [...starts].reverse().map((start) => ({
      start, end:ends.find((end) => end.index > start.index + start[0].length),
    })).find((item) => item.end);
    if (!pair) {
      throw new Error(requestId
        ? "交接总结未包含本次专属的首尾校验标记，旧队列已保留；请取消接力后重试"
        : "交接总结缺少完整的首尾标记，已保留旧队列");
    }
    const body = value.slice(pair.start.index + pair.start[0].length,pair.end.index).trim();
    if (body.length < 150) throw new Error("交接总结过短，已保留旧队列");
    if (body.length > 10500) throw new Error("交接总结过长，无法安全发送到新对话");
    return body;
  },

  introduction(summary) {
    const result = `这是上一段对话的交接记录。你现在处于同一个 ChatGPT 项目的新对话，请完整继承其中的目标、决定、进度及待办。` +
      `这条消息仅用于恢复上下文；请简短确认已理解，不要自行启动或重复执行任何待办。` +
      `如有剩余队列任务，插件会逐条发送；如果队列为空，请等待用户的下一步指令。\n\n${summary}`;
    if (result.length > 12000) throw new Error("交接提示词超过安全发送长度");
    return result;
  },
});
