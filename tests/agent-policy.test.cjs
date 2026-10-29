"use strict";

const {test}=require("node:test");
const assert=require("node:assert/strict");
const policy=require("../agent-policy.js");

const longTask="请重构项目里的物品和生产系统，整合旧武器数值表与食物数值表，"+
  "同时完成运行时数值更新、存档兼容、界面调整和自动化测试。".repeat(4);

test("长任务入队时给 AI 明确可见的协作提示，普通与项目聊天均可作主对话",()=>{
  assert.equal(policy.likelyLongTask(longTask),true);
  const ordinary=policy.prepare(longTask,"https://chatgpt.com/c/ordinary-1?debug=secret#private");
  const project=policy.prepare(longTask,"https://chatgpt.com/g/g-p-valid-project/c/worker-1");
  assert.ok(ordinary.startsWith(longTask+"\n\n"));
  assert.ok(project.startsWith(longTask+"\n\n"));
  assert.match(ordinary,/team.cjs doctor/);
  assert.match(ordinary,/init --auto/);
  assert.match(ordinary,/https:\/\/chatgpt.com\/c\/ordinary-1/);
  assert.doesNotMatch(ordinary,/debug=secret|private/);
  assert.match(project,/https:\/\/chatgpt.com\/g\/g-p-valid-project\/c\/worker-1/);
  assert.equal(policy.prepare(ordinary,"https://chatgpt.com/c/ordinary-1"),ordinary,
    "再次入队已包装的任务不能不断叠加协作提示");
});

test("短任务、明确拒绝协作、团队协议消息与手动关闭时原文不变",()=>{
  for(const value of ["把按钮改成蓝色","解释一下什么是二极管",
    "[GPT Queue Agent Team | 消息]\nRUN: a\n完成模块检查",
    "请不要使用多智能体，直接实现和测试下面的四个模块："+longTask]) {
    assert.equal(policy.prepare(value,"https://chatgpt.com/c/a"),value);
  }
  assert.equal(policy.prepare(longTask,"https://chatgpt.com/c/a",false),longTask);
  assert.equal(policy.prepare("x".repeat(11999),"https://chatgpt.com/c/a"),"x".repeat(11999));
  assert.equal(policy.chatUrl("https://evil.com/c/123"),null);
});
