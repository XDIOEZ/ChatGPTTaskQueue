"use strict";

// Only user-initiated queue submissions can use this optional hint.
// It neither sends messages nor creates conversations by itself.
const CQAgentPolicy = (() => {
  const MARKER = "[队列插件：自动协作]";
  const COMPLEX = /重构|迁移|整合|架构|开发|实现|部署|联调|优化|批量|修复|搭建|设计|调查|调研|系统|工程|refactor|implement|integrat|migrat|deploy/i;
  const PARALLEL = /同时|分别|多个|多模块|并行|包含|包括|以及|并且|还需要|先.{2,80}再|此外|另外|和测试|与测试|\n\s*[-*1-9]|modules|workstreams/i;

  function likelyLongTask(value) {
    if (typeof value !== "string" || value.includes(MARKER) ||
        /\[GPT Queue Agent Team\s*\|/i.test(value) ||
        /(?:不用|不要|禁止|无需|别).{0,12}(?:子智能体|多智能体|多对话)/.test(value)) return false;
    const task=value.trim();
    return task.length > 24 && /(?:多智能体协作|多对话协作|子智能体并行)/.test(task) ||
      task.length >= 110 && COMPLEX.test(task) && PARALLEL.test(task) ||
      task.length >= 260 && COMPLEX.test(task);
  }

  function chatUrl(value) {
    try {
      const url=new URL(value);
      if(url.protocol!=="https:" ||
          !["chatgpt.com","chat.openai.com"].includes(url.hostname) ||
          !/(?:^|\/)c\/[a-zA-Z0-9-]+\/?$/.test(url.pathname)) return null;
      return url.origin+url.pathname.replace(/\/+$/,"");
    }catch{return null;}
  }

  function prepare(text,url,enabled=true) {
    if(!enabled || !likelyLongTask(text)) return text;
    const lead=chatUrl(url);
    const hint=[
      MARKER,
      "此任务已启用长任务协作。请自主判断：只有至少两项真正独立、值得并行的工作流时，才考虑使用多个 ChatGPT 对话；普通小任务直接完成。",
      "如果有 PCC 或 HomePC2 工具，先在 ChatGPTTaskQueue 仓库运行 team.cjs doctor，确认插件在线，再阅读 skills/gpt-queue-agent-team/SKILL.md。",
      "条件满足时使用 team.cjs init --auto、spawn、sync、send、ack、status 分配 2～4 个独立成员，主智能体负责汇总和验证；条件不满足就单对话完成，不要声称已分派。",
      lead ? "主对话URL："+lead : "未确定主对话URL时不得创建成员。",
      "此提示仅辅助原任务，不改变任务目标或文件授权。",
    ].join("\n");
    const combined=text+"\n\n"+hint;
    return combined.length<=12000?combined:text;
  }

  return Object.freeze({MARKER,likelyLongTask,chatUrl,prepare});
})();

globalThis.CQAgentPolicy=CQAgentPolicy;
if(typeof module!=="undefined" && module.exports) module.exports=CQAgentPolicy;
