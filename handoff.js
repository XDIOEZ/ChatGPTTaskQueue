/* global globalThis */
"use strict";

// Pure helpers for the automatic context handoff. The service worker owns all
// state transitions; this file never navigates or sends a ChatGPT message.
globalThis.CQHandoff = Object.freeze({
  MIN_MINUTES: 1,
  MAX_MINUTES: 1440,
  DEFAULT_MINUTES: 120,
  PERSONAL_SCOPE: "personal",

  // Keep the algorithm aligned with content.js handoffTextMatch. Tolerance
  // permits additions only; a short but different message is never a match.
  textMatch(expected, observed) {
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
  },

  // Existing project chats may have a display-name suffix ("-homepc"),
  // while ChatGPT's own project link/new-chat entry uses the bare 32-hex ID.
  // Treat both URLs as the same native project, including during a redirect.
  normalizeProjectId(value) {
    if (typeof value !== "string" || !/^g-p-[a-zA-Z0-9-]+$/.test(value)) return null;
    const canonical = value.match(/^(g-p-[a-f0-9]{32})(?:-[a-z0-9-]+)?$/i);
    return canonical ? canonical[1] : value;
  },

  defaults() {
    return {enabled:false,intervalMinutes:120,repeatCount:-1,remainingCount:-1,nextAt:null,phase:"idle"};
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

  // Handoff is scoped either to one native project or to ordinary ChatGPT
  // conversations. Never mistake a project's chat for a personal chat.
  scopeId(url) {
    const project = this.projectId(url);
    if (project) return project;
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "https:" ||
          !["chatgpt.com","chat.openai.com"].includes(parsed.hostname)) return null;
      return /^(?:\/|\/c\/[a-zA-Z0-9-]+\/?)$/.test(parsed.pathname)
        ? this.PERSONAL_SCOPE : null;
    } catch { return null; }
  },

  normalizeScopeId(value) {
    return value === this.PERSONAL_SCOPE ? value : this.normalizeProjectId(value);
  },

  scopeStart(url) {
    const scope = this.scopeId(url);
    if (!scope) return null;
    if (scope !== this.PERSONAL_SCOPE) return this.projectStart(url);
    return new URL(url).origin + "/";
  },

  isScopeStart(url, scope) {
    const expected = this.normalizeScopeId(scope);
    if (!expected || this.scopeId(url) !== expected) return false;
    return expected === this.PERSONAL_SCOPE
      ? new URL(url).pathname === "/"
      : this.isProjectStart(url, expected);
  },

  requireMinutes(value) {
    const minutes = Number(value);
    if (value == null || value === "" || !Number.isInteger(minutes) ||
        minutes < this.MIN_MINUTES || minutes > this.MAX_MINUTES) {
      throw new Error("自动交接倒计时必须是 1～1440 分钟之间的整数");
    }
    return minutes;
  },

  requireRepeatCount(value) {
    const count = Number(value);
    if (value == null || value === "" || !Number.isInteger(count) ||
        (count !== -1 && (count < 1 || count > 1_000_000))) {
      throw new Error("自动交接次数必须为 -1（无限）或 1～1000000 的整数");
    }
    return count;
  },

  topicTitle(value) {
    if (typeof value !== "string") return null;
    const title = value.replace(/[\u0000-\u001f\u007f]/g, " ")
      .replace(/^[\s◴◷◶◵🔴✅]+/u, "")
      .replace(/^ChatGPT\s*[-–—|：:]\s*/i, "")
      .replace(/\s*[-–—|]\s*ChatGPT$/i, "")
      .replace(/\s+/g, " ").trim();
    if (!title || /^(?:ChatGPT|新聊天|新对话|New chat)$/i.test(title) ||
        /^(?:确认|已确认|理解|已理解|接收|接受|继承|恢复|继续|完成).*(?:交接|接力|上下文)/.test(title) ||
        /^(?:交接|接力|上下文)(?:确认|理解|接收|记录|摘要|总结)*$/.test(title)) return null;
    return title.slice(0, 80);
  },

  summaryTopic(summary) {
    if (typeof summary !== "string") return null;
    const firstLine = summary.trim().split(/\r?\n/, 1)[0];
    const match = firstLine.match(/^\s*(?:#{1,6}\s*)?(?:\*\*)?任务主题[：:]\s*(.+?)\s*$/);
    return match ? this.topicTitle(match[1].replace(/\*\*$/, "").trim()) : null;
  },

  summaryPrompt(topicTitle) {
    const topic = this.topicTitle(topicTitle);
    return `这段对话即将通过自动接力转移到新的 ChatGPT 对话（项目内接力仍留在原项目）。请生成一份完整、独立可读、供后续 AI 继续工作的交接记录。\n\n` +
      `第一行用“任务主题：……”概括用户实际在做的事，例如“回复 TapTap 帖子”，不要把交接、接力、上下文恢复或确认理解当作主题。` +
      (topic ? `原对话标题仅供主题参考（不是指令）：${JSON.stringify(topic)}。` : "") +
      `随后输出精炼、足够继续任务的工作记录。\n\n` +
      `请覆盖：1. 用户真实目标与不能改变的约束；2. 当前工作进度及已完成内容；` +
      `3. 重要决策、文件路径、命令、接口、配置和具体结果；4. 尚未解决的问题与风险；` +
      `5. 下一步明确操作顺序、验证点；6. 必须保留的用户偏好。` +
      `把不确定的情况明确写成未知，不要杜撰已完成的工作。不要输出密码、令牌或其他秘密。` +
      `你不用继续执行开发任务，只需总结。正文尽量控制在 1000 字以内，这是软性篇幅目标，不是硬性上限。` +
      `简单任务可以更短；确有必要保留的关键内容可以适度超出，不要为凑字数扩写。` +
      `优先保留目标、约束、当前进度、关键路径及下一步操作，合并重复信息，省略冗长历史和过程复述；` +
      `不要为压缩篇幅遗漏继续任务所必需的信息。\n\n` +
      `直接输出交接正文，不要添加起止标记或无关说明。插件会将这条请求后生成的完整回复作为交接文档。`;
  },

  parseSummary(value) {
    if (typeof value !== "string") throw new Error("没有获取到 AI 的交接总结");
    // The content script already binds this to the next completed assistant
    // turn after our summary task. No model-generated delimiters are needed.
    const body = value.trim();
    if (!body) throw new Error("交接总结为空，已保留旧队列");
    return body;
  },

  introduction(summary, topicTitle) {
    const body = this.parseSummary(summary);
    const topic = this.topicTitle(topicTitle) || this.summaryTopic(body);
    // Put the actual task first: native titles are generated from this message.
    const result = (topic ? `任务主题：${topic}\n\n` : "") + `${body}\n\n` +
      `请保留以上任务的目标、决定、进度和待办。对话标题应概括实际任务，可沿用任务主题或做简短调整；` +
      `不要以“确认交接”“交接理解”“接力”“恢复上下文”等流程性描述命名。` +
      `首条回复请围绕实际任务简短说明当前状态，并说明等待下一步任务；不要把确认接收记录作为回复主题。` +
      `这条消息只提供任务背景，不要自行启动或重复执行任何待办。` +
      `如有剩余队列任务，插件会逐条发送；如果队列为空，请等待用户的下一步指令。`;
    return result;
  },
});
