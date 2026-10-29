"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { webcrypto, createHash } = require("node:crypto");
const { TextEncoder } = require("node:util");

const source = fs.readFileSync(path.join(__dirname, "..", "background.js"), "utf8");
const handoffSource = fs.readFileSync(path.join(__dirname, "..", "handoff.js"), "utf8");
const remoteDispatchSource = fs.readFileSync(path.join(__dirname, "..", "remote-dispatch.js"), "utf8");
const A = "https://chatgpt.com/c/dialogue-a";
const B = "https://chatgpt.com/c/dialogue-b";
const voiceProof = {
  voiceReady: true, voiceStableMs: 2200, editorEmpty: true,
  lastRole: "assistant", busy: false, toolPending: false,
  assistantAdvanced: true, assistantTextLength: 24, stableMs: 2200,
};
const handoffProof = {
  ...voiceProof, handoffReplyIsNew:true, handoffLastRole:"assistant",
};
function handoffReply(request, body) {
  assert.doesNotMatch(request,/CHATGPT_TASKQUEUE_HANDOFF_(START|END)/);
  return body;
}
// Finish an already queued command whose predecessors have settled. Native
// acknowledgement and new-chat ownership remain part of every quota scenario.
async function finishQueuedHandoff(env, sourceUrl, destinationUrl,
  summaryBody="任务主题：持续开发当前项目\n保留当前目标、约束、已完成进度和后续任务。".repeat(12)) {
  const projectUrl = sourceUrl.replace(/\/c\/[^/]+$/, "/project");
  const claim = await env.send("CLAIM",{ready:true,userCount:0},11,sourceUrl);
  assert.equal(claim.dispatch?.kind,"handoff_summary");
  await env.send("SENT",{id:claim.dispatch.id},11,sourceUrl);
  env.advance(3);
  const summary = await env.send("FINISHED",{
    id:claim.dispatch.id,...handoffProof,userCount:1,
    handoffSummary:summaryBody,
  },11,sourceUrl);
  assert.equal(summary.state.handoff.phase,"opening");
  assert.equal(summary.state.handoff.summary,summaryBody.trim());
  await env.send("HANDOFF_NAVIGATE",{userCount:1},11,sourceUrl);
  env.navigate(11,projectUrl);
  await env.send("HELLO",{},11,projectUrl);
  const intro = await env.send("CLAIM",{ready:true,userCount:0},11,projectUrl);
  assert.equal(intro.dispatch?.kind,"handoff_intro");
  assert.ok(intro.dispatch.text.includes(summaryBody.trim()),
    "交接正文完整进入新对话开场，不因字数裁剪");
  await env.send("SENT",{id:intro.dispatch.id},11,projectUrl);
  env.navigate(11,destinationUrl);
  await env.send("HELLO",{lastUserText:intro.dispatch.text},11,destinationUrl);
  env.advance(3);
  return env.send("FINISHED",{id:intro.dispatch.id,...voiceProof},11,destinationUrl);
}

async function preparePendingHandoffEntry(env) {
  const sourceUrl="https://chatgpt.com/g/g-p-protected-entry/c/source";
  const projectUrl="https://chatgpt.com/g/g-p-protected-entry/project";
  env.navigate(11,sourceUrl);
  await env.send("HANDOFF_NOW",{},11,sourceUrl);
  await env.send("ENQUEUE",{text:"始终保留在原对话的任务"},11,sourceUrl);
  const summary=await env.send("CLAIM",{ready:true,userCount:0},11,sourceUrl);
  await env.send("SENT",{id:summary.dispatch.id},11,sourceUrl);
  env.advance(3);
  await env.send("FINISHED",{id:summary.dispatch.id,...handoffProof,
    handoffSummary:"任务主题：继续处理原任务\n保存现有进度和约束。",userCount:1},11,sourceUrl);
  await env.send("HANDOFF_NAVIGATE",{userCount:1},11,sourceUrl);
  return {sourceUrl,projectUrl};
}

async function prepareRecoverableHandoffReceiver(env, status="error") {
  const sourceUrl="https://chatgpt.com/g/g-p-protected-entry/c/source";
  env.navigate(11,sourceUrl);
  const rule=await env.send("ADD_SCHEDULE",{
    text:"原对话自动规则必须保留",intervalMinutes:60,repeatCount:-1,
  },11,sourceUrl);
  const sourceRuleId=rule.state.schedules[0].id;
  const entry=await preparePendingHandoffEntry(env);
  env.navigate(11,entry.projectUrl);
  const hello=await env.send("HELLO",{projectVisitId:"receiver-recovery-visit"},11,entry.projectUrl);
  const introId=hello.state.tasks[0].id;
  if(status!=="pending"){
    await env.send("CLAIM",{ready:true},11,entry.projectUrl);
    await env.send("SENT",{id:introId},11,entry.projectUrl);
    if(status==="error")await env.send("FAIL",{id:introId,error:"接收端交接状态待核对"},11,entry.projectUrl);
    if(status==="interrupted")await env.send("STOPPED",{userCount:1},11,entry.projectUrl);
  }
  // Model an existing receiver with an independent normal task. Recovery
  // must remove only the handoff row, even in this mixed legacy state.
  const destination=env.stored["cq.state.v2"].conversations["draft:11"];
  destination.tasks.push({id:"receiver-normal",text:"接收端独立普通任务",status:"pending",images:[],
    createdAt:destination.tasks[0].createdAt});
  return {...entry,introId,sourceRuleId};
}

async function prepareClaimedHandoffSend(env,kind) {
  const sourceUrl="https://chatgpt.com/g/g-p-protected-entry/c/source";
  if(kind==="handoff_summary"){
    env.navigate(11,sourceUrl);
    await env.send("HANDOFF_NOW",{},11,sourceUrl);
    const claimed=await env.send("CLAIM",{ready:true},11,sourceUrl);
    return {url:sourceUrl,id:claimed.dispatch.id,key:"chat:source"};
  }
  const entry=await preparePendingHandoffEntry(env);
  env.navigate(11,entry.projectUrl);
  await env.send("HELLO",{},11,entry.projectUrl);
  const claimed=await env.send("CLAIM",{ready:true},11,entry.projectUrl);
  return {url:entry.projectUrl,id:claimed.dispatch.id,key:"draft:11"};
}

async function prepareHandoffTargetShell(env) {
  const next="https://chatgpt.com/g/g-p-protected-entry/c/shell-destination";
  env.navigate(11,next);
  const shell=await env.send("HELLO",{userCount:1,lastUserText:"原生消息已挂载，插件尚未关联"},11,next);
  assert.equal(shell.state.tasks.length,0);
  assert.ok(shell.state.firstSeenAt);
  const entry=await preparePendingHandoffEntry(env);
  await env.send("ADD_SCHEDULE",{text:"数量规则继续",mode:"count",threshold:1,repeatCount:-1},11,entry.sourceUrl);
  await env.send("ADD_SCHEDULE",{text:"时间规则继续",mode:"time",intervalMinutes:60,repeatCount:3},11,entry.sourceUrl);
  await env.send("SAVE_COUNT_RATE_LIMIT",{enabled:true,windowMinutes:10,maxAdds:2},11,entry.sourceUrl);
  env.navigate(11,entry.projectUrl);
  await env.send("HELLO",{},11,entry.projectUrl);
  const intro=await env.send("CLAIM",{ready:true,userCount:0},11,entry.projectUrl);
  await env.send("SENT",{id:intro.dispatch.id},11,entry.projectUrl);
  env.navigate(11,next);
  return {...entry,next,intro:intro.dispatch};
}

test("接力可接续同标签首见时间空壳，HELLO 或恢复握手均仍等待 FINISHED 才迁移规则",async()=>{
  for(const action of ["HELLO","CONFIRM_HANDOFF"]){
    const env=await harness();
    const fixture=await prepareHandoffTargetShell(env);
    const conversations=env.stored["cq.state.v2"].conversations;
    const source=conversations["chat:source"];
    const scheduleIds=Array.from(source.schedules,rule=>rule.id);
    const timeNextAt=source.schedules[1].nextRunAt;
    const firstSeen=conversations["chat:shell-destination"].firstSeenAt;
    const adopted=await env.send(action,{userCount:1,lastUserText:fixture.intro.text,
      lastUserFolded:false},11,fixture.next);
    assert.equal(adopted.ok,true,action);
    assert.equal(adopted.sessionKey,"chat:shell-destination");
    if(action==="CONFIRM_HANDOFF"){
      assert.equal(adopted.adopted,true);
      assert.equal(adopted.handoffPending,true);
    }
    assert.equal(adopted.dispatch,null,"恢复归属不能领取或重发交接正文");
    assert.equal(adopted.state.activeTaskId,fixture.intro.id);
    assert.equal(adopted.state.tasks[0].status,"waiting");
    assert.equal(adopted.state.firstSeenAt,firstSeen);
    assert.equal(adopted.state.schedules.length,0);
    assert.equal(source.schedules.length,2,"归属确认尚未等于完成迁移");
    assert.equal(source.handoff.destinationKey,"chat:shell-destination");
    assert.equal(conversations["draft:11"],undefined);
    env.advance(3);
    const finished=await env.send("FINISHED",{id:fixture.intro.id,...voiceProof,userCount:1},11,fixture.next);
    assert.equal(finished.ok,true);
    assert.deepEqual(Array.from(finished.state.schedules,rule=>rule.id),scheduleIds);
    assert.equal(finished.state.schedules[1].nextRunAt,timeNextAt);
    assert.equal(finished.state.schedules.every(rule=>rule.enabled),true);
    assert.equal(finished.state.countRateLimit.enabled,true);
    assert.equal(finished.state.countRateLimit.maxAdds,2);
    assert.equal(source.schedules.length,0);
    assert.equal(source.handoff.phase,"completed");
    const repeated=await env.send("CONFIRM_HANDOFF",{userCount:1,lastUserText:fixture.intro.text},11,fixture.next);
    assert.equal(repeated.adopted,false);
    assert.equal(repeated.handoffPending,false);
    assert.equal(repeated.state.schedules.length,2,"重复恢复不再迁移或补入第二份规则");
    const report=await env.send("GET_HANDOFF_DEBUG",{},11,fixture.next);
    assert.ok(report.runs[0].events.some(event=>event.kind==="adoption_result"&&event.reason==="adopted"));
  }
});

test("恢复握手不匹配保持普通 chat 原状态和 sessionKey，不回包 pending draft",async()=>{
  for(const invalid of ["user_count","body","prefix","task","rule","paused","halted","history",
    "submission","config","other_owner","source_owner","token","destination","phase"]){
    const env=await harness();
    const fixture=await prepareHandoffTargetShell(env);
    const conversations=env.stored["cq.state.v2"].conversations;
    const target=conversations["chat:shell-destination"];
    const source=conversations["chat:source"];
    if(invalid==="task")target.tasks.push({id:"real-task",text:"真实独立任务",status:"pending",images:[]});
    if(invalid==="rule")target.schedules.push({...source.schedules[0],id:"independent-rule"});
    if(invalid==="paused")target.queuePaused=true;
    if(invalid==="halted"){target.halted=true;target.haltReason="user";target.haltAtUserCount=1;}
    if(invalid==="history")target.history.push({type:"task_deleted",at:target.firstSeenAt});
    if(invalid==="submission")target.recentSubmissions.push({id:"previous-submit",at:target.firstSeenAt});
    if(invalid==="config")target.compactView=true;
    if(invalid==="other_owner")target.tabId=12;
    if(invalid==="source_owner")source.tabId=12;
    if(invalid==="token")source.handoff.token="different-round";
    if(invalid==="destination")source.handoff.destinationKey="draft:other";
    if(invalid==="phase")source.handoff.phase="failed";
    const targetBefore=JSON.stringify(target);
    const sourceRules=JSON.stringify(source.schedules);
    const reply=await env.send("CONFIRM_HANDOFF",{userCount:invalid==="user_count"?2:1,
      lastUserText:invalid==="body"?"另一条普通指令":invalid==="prefix"?fixture.intro.text.slice(0,180):fixture.intro.text,
      lastUserFolded:invalid==="prefix"},11,fixture.next);
    assert.equal(reply.ok,true,invalid);
    assert.equal(reply.adopted,false,invalid);
    assert.equal(reply.handoffPending,false,invalid);
    assert.equal(reply.sessionKey,"chat:shell-destination",invalid);
    assert.equal(reply.dispatch,null);
    assert.equal(JSON.stringify(reply.state),targetBefore,"不匹配不能覆盖原 chat: "+invalid);
    assert.equal(JSON.stringify(source.schedules),sourceRules);
    assert.equal(conversations["draft:11"].activeTaskId,fixture.intro.id);
  }
});

test("已有首见空壳的 HELLO 只有真实单条用户正文才能接续，缺失或多条观测不替换",async()=>{
  for(const userCount of [undefined,0,2]){
    const env=await harness();
    const fixture=await prepareHandoffTargetShell(env);
    const conversations=env.stored["cq.state.v2"].conversations;
    const shellBefore=JSON.stringify(conversations["chat:shell-destination"]);
    await env.send("HELLO",{userCount,lastUserText:fixture.intro.text},11,fixture.next);
    assert.equal(JSON.stringify(conversations["chat:shell-destination"]),shellBefore);
    assert.equal(conversations["chat:source"].handoff.destinationKey,"draft:11");
    assert.equal(conversations["draft:11"].activeTaskId,fixture.intro.id);
    const accepted=await env.send("HELLO",{userCount:1,lastUserText:fixture.intro.text},11,fixture.next);
    assert.equal(accepted.sessionKey,"chat:shell-destination");
    assert.equal(accepted.state.activeTaskId,fixture.intro.id);
  }
});

test("空壳修复不接受其他项目或同项目其他标签，未匹配只导出候选安全元信息",async()=>{
  const env=await harness();
  const fixture=await prepareHandoffTargetShell(env);
  const report=await env.send("GET_HANDOFF_DEBUG",{},11,fixture.next);
  assert.equal(report.current.adoption.candidateCount,1);
  assert.equal(report.current.adoption.candidates[0].sourceScheduleCount,2);
  assert.equal(report.current.adoption.candidates[0].reason,"target_exists_shell");
  assert.equal(report.current.adoption.candidates[0].targetShell,true);
  assert.equal(JSON.stringify(report.current.adoption).includes("chat:source"),false);
  assert.equal(JSON.stringify(report.current.adoption).includes(fixture.intro.text),false);
  const other="https://chatgpt.com/g/g-p-unrelated/c/foreign";
  env.navigate(11,other);
  const foreign=await env.send("CONFIRM_HANDOFF",{userCount:1,lastUserText:fixture.intro.text},11,other);
  assert.equal(foreign.adopted,false);
  assert.equal(foreign.handoffPending,false);
  assert.equal(foreign.sessionKey,"chat:foreign");
  env.navigate(12,fixture.next);
  const anotherTab=await env.send("CONFIRM_HANDOFF",{userCount:1,lastUserText:fixture.intro.text},12,fixture.next);
  assert.equal(anotherTab.adopted,false);
  assert.equal(anotherTab.sessionKey,"chat:shell-destination");
  assert.equal(env.stored["cq.state.v2"].conversations["draft:11"].activeTaskId,fixture.intro.id);
});

test("接力期间另标签查看旧源不能抢 owner，既有错 owner 只诊断而不自动重置",async()=>{
  const env=await harness();
  const fixture=await prepareHandoffTargetShell(env);
  const conversations=env.stored["cq.state.v2"].conversations;
  env.navigate(12,fixture.sourceUrl);
  await env.send("HELLO",{userCount:2},12,fixture.sourceUrl,{active:true});
  assert.equal(conversations["chat:source"].tabId,11,
    "原 owner 正在新对话页面，不能把它误当旧源已离开而抢占");
  const normal=await env.send("GET_HANDOFF_DEBUG",{},11,fixture.next);
  assert.equal(normal.current.adoption.candidates[0].reason,"target_exists_shell");
  conversations["chat:source"].tabId=12;
  const refused=await env.send("CONFIRM_HANDOFF",{userCount:1,lastUserText:fixture.intro.text},11,fixture.next);
  assert.equal(refused.adopted,false);
  assert.equal(conversations["chat:source"].tabId,12,"不猜测并重置旧版本已错绑的 owner");
  const full=await env.sendDashboard("GET_HANDOFF_DEBUG",{all:true},
    {id:"test-queue",url:"chrome-extension://test-queue/dashboard.html"});
  assert.equal(full.runs[0].current.ownerChainMatches,false);
  assert.ok(full.runs[0].events.some(event=>event.kind==="adoption_result"&&event.reason==="owner_mismatch"));
});

test("内部交接准备有独立十分钟预算，普通发送仍为九十秒且不会自动重发",async()=>{
  for(const kind of ["handoff_summary","handoff_intro"]){
    const env=await harness();
    const fixture=await prepareClaimedHandoffSend(env,kind);
    await env.tick(4);
    const preparing=env.stored["cq.state.v2"].conversations[fixture.key];
    assert.equal(preparing.activeTaskId,fixture.id,kind);
    assert.equal(preparing.tasks.find(task=>task.id===fixture.id).status,"dispatching");
    const report=await env.send("GET_HANDOFF_DEBUG",{},11,fixture.url);
    assert.equal(report.current.dispatchBudgetMs,600000);
    assert.equal(report.current[kind==="handoff_intro"?"introDispatchBudgetMs":"summaryDispatchBudgetMs"],600000);
    await env.tick(7);
    const expired=env.stored["cq.state.v2"].conversations[fixture.key];
    assert.equal(expired.activeTaskId,null);
    assert.equal(expired.tasks.find(task=>task.id===fixture.id).status,"error");
    assert.match(expired.error,/准备超时/);
    assert.equal((await env.send("HANDOFF_SEND_READY",{id:fixture.id},11,fixture.url)).ok,false);
    assert.equal((await env.send("CLAIM",{ready:true},11,fixture.url)).dispatch,null);
  }
  const ordinary=await harness();
  await ordinary.send("ENQUEUE",{text:"普通发送预算不变"});
  const claim=await ordinary.send("CLAIM",{ready:true});
  await ordinary.tick(2);
  const state=(await ordinary.send("GET")).state;
  assert.equal(state.tasks.find(task=>task.id===claim.dispatch.id).status,"error");
  assert.match(state.error,/发送确认超时/);
});

test("内部交接点击前持久复核仅放行一次，arm 后九十秒未 SENT 必须隔离",async()=>{
  for(const kind of ["handoff_summary","handoff_intro"]){
    const env=await harness();
    const fixture=await prepareClaimedHandoffSend(env,kind);
    env.advance(240);
    const armed=await env.send("HANDOFF_SEND_READY",{id:fixture.id},11,fixture.url);
    assert.equal(armed.ok,true,kind);
    assert.equal(armed.sendReady,true);
    const task=env.stored["cq.state.v2"].conversations[fixture.key].tasks
      .find(item=>item.id===fixture.id);
    assert.ok(Number.isFinite(task.sendArmedAt));
    assert.equal(task.status,"dispatching","arm 不能等同已发送");
    assert.equal((await env.send("HANDOFF_SEND_READY",{id:fixture.id},11,fixture.url)).ok,false);
    assert.equal((await env.send("RELEASE_CLAIM",{id:fixture.id},11,fixture.url)).ok,false);
    assert.equal(task.status,"dispatching","失去 arm 响应也不能回到 pending 重发");
    await env.tick(2);
    assert.equal(task.status,"error");
    assert.equal((await env.send("CLAIM",{ready:true},11,fixture.url)).dispatch,null);
  }
});

test("内部交接 arm 后正常 SENT 使用原有四十五分钟回复预算",async()=>{
  const env=await harness();
  const fixture=await prepareClaimedHandoffSend(env,"handoff_intro");
  await env.send("HANDOFF_SEND_READY",{id:fixture.id},11,fixture.url);
  const sent=await env.send("SENT",{id:fixture.id},11,fixture.url);
  assert.equal(sent.state.tasks[0].status,"waiting");
  await env.tick(44);
  assert.equal(env.stored["cq.state.v2"].conversations[fixture.key].tasks[0].status,"waiting");
  await env.tick(2);
  const expired=env.stored["cq.state.v2"].conversations[fixture.key];
  assert.equal(expired.tasks[0].status,"error");
  assert.match(expired.error,/等待回复超时/);
});

test("内部交接 arm 拒绝取消、失效身份、错页和错标签，不修改原发送权限",async()=>{
  for(const invalid of ["cancelled","failed","token","destination","project","other_tab","expired"]){
    const env=await harness();
    const fixture=await prepareClaimedHandoffSend(env,"handoff_intro");
    const conversations=env.stored["cq.state.v2"].conversations;
    const source=conversations["chat:source"];
    if(invalid==="cancelled")await env.send("CANCEL_HANDOFF",{reviewed:true},11,fixture.url);
    if(invalid==="failed")source.handoff.phase="failed";
    if(invalid==="token")source.handoff.token="another-round";
    if(invalid==="destination")source.handoff.destinationKey="draft:another";
    if(invalid==="project")env.tabs.get(11).url="https://chatgpt.com/g/g-p-other/project";
    if(invalid==="other_tab")env.tabs.get(12).url=fixture.url;
    if(invalid==="expired")env.advance(601);
    const armed=await env.send("HANDOFF_SEND_READY",{id:fixture.id},
      invalid==="other_tab"?12:11,fixture.url);
    assert.equal(armed.ok,false,invalid);
    assert.notEqual(armed.sendReady,true);
    assert.equal(conversations[fixture.key]?.tasks.some(task=>Number.isFinite(task.sendArmedAt)),false);
  }
  const env=await harness();
  const fixture=await prepareClaimedHandoffSend(env,"handoff_summary");
  await env.send("CANCEL_HANDOFF",{},11,fixture.url);
  assert.equal((await env.send("HANDOFF_SEND_READY",{id:fixture.id},11,fixture.url)).ok,false,
    "等待取消的活动总结不能得到新的点击权限");
});

test("内部交接 arm 必须先完成持久写入，诊断允许受限的输入方式和耗时",async()=>{
  const env=await harness({}, {structuredStorage:true});
  const fixture=await prepareClaimedHandoffSend(env,"handoff_summary");
  env.failNextWrite();
  const refused=await env.send("HANDOFF_SEND_READY",{id:fixture.id},11,fixture.url);
  assert.equal(refused.ok,false);
  assert.equal(env.stored["cq.state.v2"].conversations[fixture.key].tasks[0].sendArmedAt,undefined);
  for(const event of ["input_start","input_complete","input_failed","send_ready"]){
    const recorded=await env.send("HANDOFF_DEBUG_SIGNAL",{event,reason:"none",details:{
      gate:event==="send_ready"?"arm":"input",inputMethod:"paste",inputElapsedMs:245,
      inputParagraphs:18,
    }},11,fixture.url);
    assert.equal(recorded.ok,true,event);
  }
  for(const details of [{inputMethod:"raw-private-text"},{inputElapsedMs:-1},{inputParagraphs:Infinity}]){
    assert.equal((await env.send("HANDOFF_DEBUG_SIGNAL",{
      event:"input_failed",reason:"none",details,
    },11,fixture.url)).ok,false);
  }
  const report=await env.send("GET_HANDOFF_DEBUG",{},11,fixture.url);
  assert.ok(report.runs[0].events.some(event=>event.kind==="input_complete"&&
    event.details.inputMethod==="paste"&&event.details.inputElapsedMs===245));
});

for (const [label,summaryBody] of [
  ["简短总结","接着回复 TapTap 帖子。"],
  ["超出旧长度上限的完整总结","任务主题：回复 TapTap 帖子\n" +
    "保留帖子的处理状态、反馈结论、用户约束与未完成步骤。\n".repeat(800)],
]) {
  test(`上下文接力：${label}均能完整迁移并继续后续任务`,async()=>{
    const env=await harness();
    const sourceUrl="https://chatgpt.com/g/g-p-free-summary/c/source";
    const destinationUrl="https://chatgpt.com/g/g-p-free-summary/c/destination";
    env.navigate(11,sourceUrl);
    await env.send("HANDOFF_NOW",{},11,sourceUrl);
    await env.send("ENQUEUE",{text:"继续剩余工作"},11,sourceUrl);
    const result=await finishQueuedHandoff(env,sourceUrl,destinationUrl,summaryBody);
    assert.equal(result.ok,true);
    assert.equal(result.state.handoff.phase,"idle");
    assert.deepEqual(Array.from(result.state.tasks,task=>task.text),["继续剩余工作"]);
    env.advance(180);
    assert.equal((await env.send("CLAIM",{ready:true},11,destinationUrl)).dispatch.text,
      "继续剩余工作");
  });
}

test("交接总结：仅空白或缺失内容无效，不要求固定字数或结构",()=>{
  const context=vm.createContext({});
  vm.runInContext(handoffSource,context);
  const handoff=context.CQHandoff;
  for (const value of [undefined,null,42,""," \n\t "]) {
    assert.throws(()=>handoff.parseSummary(value),/交接总结|交接回复/);
  }
  assert.equal(handoff.parseSummary("  好\n "),"好");
  assert.equal(handoff.parseSummary("简短的无标题正文"),"简短的无标题正文");
});

const testImage = {
  name: "示例.png", type: "image/png",
  dataUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lSkAAAAASUVORK5CYII=",
  thumbnail: "data:image/jpeg;base64,YWJj",
};

async function harness(initialStorage = {}, options = {}) {
  let now = Date.UTC(2026, 9, 15, 12, 0);
  const stored = structuredClone(initialStorage);
  let failNextStateWrite = null;
  const sessionStored = structuredClone(options.initialSession || {});
  const storedImages = new Map();
  const tabUpdates = [];
  const tabReloads = [];
  const failedTabReloads = new Set();
  const reloadLeavesDiscarded = new Set();
  const failedTabCreates = new Set();
  const wakeMessages = [];
  const updateProbes = [];
  const tabSafety = new Map();
  const failProbes = new Set();
  let failTabQuery = false;
  let alarmHandler;
  let installedHandler;
  let messageHandler;
  let tabUpdatedHandler;
  let tabRemovedHandler;
  let alarm;
  const tabs = new Map([
    [11, { id: 11, url: A, autoDiscardable: true }],
    [12, { id: 12, url: B, autoDiscardable: true }],
    [13, { id: 13, url: "https://chatgpt.com/", autoDiscardable: true }],
  ]);

  class FakeDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }

  const chrome = {
    storage: {
      local: {
        async get(keys) {
          const names = Array.isArray(keys) ? keys : [keys];
          return Object.fromEntries(names.map((key) =>
            [key, options.structuredStorage ? structuredClone(stored[key]) : stored[key]]));
        },
        async set(values) {
          if (options.failHandoffDebugWrite &&
              Object.hasOwn(values,"cq.handoffDebug.v1")) {
            throw new Error("simulated handoff diagnostics write refusal");
          }
          const failure = Object.hasOwn(values, "cq.state.v2") ? failNextStateWrite : null;
          if (failure) failNextStateWrite = null;
          if (failure !== "before") Object.assign(stored,
            options.structuredStorage ? structuredClone(values) : values);
          if (failure) throw new Error("simulated storage write failure: " + failure);
        },
      },
      session: {
        async get(key) { return { [key]: sessionStored[key] }; },
        async set(values) { Object.assign(sessionStored, values); },
      },
    },
    alarms: {
      async get() { return alarm; },
      async create(name, options) { alarm = { name, ...options }; },
      onAlarm: { addListener(fn) { alarmHandler = fn; } },
    },
    tabs: {
      async get(id) {
        if (!tabs.has(id)) throw new Error("tab closed");
        return tabs.get(id);
      },
      async update(id, values) {
        if (!tabs.has(id)) throw new Error("tab closed");
        const tab = tabs.get(id);
        Object.assign(tab, values);
        tabUpdates.push({ id, ...values });
        return tab;
      },
      async reload(id) {
        if (!tabs.has(id) || failedTabReloads.has(id)) throw new Error("tab reload unavailable");
        if (!reloadLeavesDiscarded.has(id)) tabs.get(id).discarded = false;
        tabReloads.push(id);
      },
      async query() {
        if (failTabQuery) throw new Error("tabs lookup unavailable");
        return [...tabs.values()];
      },
      async create({ url, active = true }) {
        if (failedTabCreates.has(url)) throw new Error("browser refused new tab");
        const tab = { id: 100 + tabs.size, url, autoDiscardable: true, active };
        tabs.set(tab.id, tab);
        return tab;
      },
      async sendMessage(tabId, message) { wakeMessages.push({ tabId, message }); },
      onUpdated: { addListener(fn) { tabUpdatedHandler = fn; } },
      onRemoved: { addListener(fn) { tabRemovedHandler = fn; } },
    },
    runtime: {
      id:"test-queue",
      getManifest() { return { version: "0.19.0" }; },
      getURL(path) { return "chrome-extension://test-queue/" + path; },
      onInstalled: { addListener(fn) { installedHandler = fn; } },
      onStartup: { addListener() {} },
      onMessage: { addListener(fn) { messageHandler = fn; } },
    },
    scripting: {
      async executeScript({target,func}) {
        updateProbes.push({tabId:target.tabId,func:func?.name});
        if (func?.name === "installDeferredTabSpinner") return [{result:null}];
        if (failProbes.has(target.tabId)) throw new Error("cannot inspect tab");
        const probe = tabSafety.get(target.tabId);
        const result = typeof probe === "function"
          ? probe(updateProbes.filter((item) => item.tabId === target.tabId &&
              item.func === "inspectUpdateRefreshSafety").length)
          : probe;
        return [{ result: result || {safe:true,voiceReady:true,reason:"idle"} }];
      },
    },
    action: { onClicked: { addListener() {} } },
  };

  const sandbox = {
    chrome, crypto: webcrypto, Date: FakeDate, URL,
    atob, TextEncoder, setTimeout: (callback) => { callback(); },
    // Browser IndexedDB is covered by its own DOM regression test; this
    // in-memory equivalent isolates the queue state machine in unit tests.
    importScripts(...scripts) {
      for (const script of scripts) {
        if (script === "handoff.js") vm.runInNewContext(handoffSource, sandbox);
        else if (script === "remote-dispatch.js")
          vm.runInNewContext(remoteDispatchSource, sandbox);
        else assert.equal(script, "image-store.js");
      }
    },
    cqImageStore: {
      async save(items) { items.forEach((item) => storedImages.set(item.id, item)); },
      async load(ids) {
        const items = ids.map((id) => storedImages.get(id));
        if (items.some((item) => !item)) throw new Error("图片不存在");
        return items;
      },
      async missing(ids) { return ids.filter((id) => !storedImages.has(id)); },
      async remove(ids) { ids.forEach((id) => storedImages.delete(id)); },
      async prune(keepIds) {
        for (const key of storedImages.keys()) if (!keepIds.has(key)) storedImages.delete(key);
      },
    },
    console: { error() {}, warn() {} }, // Some tests deliberately check rejected operations.
  };
  vm.runInNewContext(source, sandbox);

  async function send(type, args = {}, tab = 11, overrideUrl, tabProperties = {}) {
    return new Promise((resolve) => messageHandler(
      { type, url: overrideUrl ?? tabs.get(tab)?.url, ...args },
      { tab: { id: tab, ...tabProperties } }, resolve
    ));
  }

  async function sendDashboard(type, args = {}, sender = {
    url:"chrome-extension://test-queue/dashboard.html",
  }) {
    return new Promise((resolve) => messageHandler(
      {type,...args}, sender, resolve
    ));
  }

  async function sendPulse(tab, generating, senderOverrides = {}) {
    const url = tabs.get(tab)?.url;
    return new Promise((resolve) => messageHandler(
      {type:"PAGE_PULSE",generating,url:"https://chatgpt.com/c/forged"},
      {tab:{id:tab,url},url,frameId:0,...senderOverrides}, resolve
    ));
  }

  async function tick(minutes) {
    now += minutes * 60_000;
    alarmHandler({ name: "cq.scheduler" });
    return send("GET"); // Queued after the timer callback.
  }

  function navigate(tab, url) {
    tabs.get(tab).url = url;
    tabUpdatedHandler?.(tab, { url }, tabs.get(tab));
  }
  function closeTab(tab) {
    tabs.delete(tab);
    tabRemovedHandler?.(tab);
  }
  function updateTab(tab, changes) {
    Object.assign(tabs.get(tab),changes);
    tabUpdatedHandler?.(tab,changes,tabs.get(tab));
  }
  function advance(seconds) { now += seconds * 1000; }
  function failNextWrite(phase = "before") { failNextStateWrite = phase; }
  function setTabQueryFailure(value) { failTabQuery = Boolean(value); }
  async function simulateExtensionUpdate(reason = "update", previousVersion = "0.18.0") {
    return installedHandler({reason,previousVersion});
  }
  async function retryVersionRefresh() {
    return vm.runInNewContext("processPendingVersionRefresh()", sandbox);
  }
  return {
    send, sendDashboard, sendPulse, tick, navigate, closeTab, updateTab, advance, tabs, stored, sessionStored,
    tabUpdates, tabReloads, failedTabReloads, reloadLeavesDiscarded, failedTabCreates,
    wakeMessages, storedImages, failNextWrite, setTabQueryFailure,
    simulateExtensionUpdate, retryVersionRefresh, tabSafety, updateProbes, failProbes,
  };
}

test("普通聊天首页首条队列任务跳转正式聊天前保留草稿，确认后完整继承队列与自动规则",async()=>{
  const env=await harness();
  const home="https://chatgpt.com/";
  const ordinary="https://chatgpt.com/c/plain-first-chat";
  env.navigate(13,home);
  await env.send("HELLO",{},13,home);
  const schedule=await env.send("ADD_SCHEDULE",{
    text:"后续定时任务",intervalMinutes:30,repeatCount:3,
  },13,home);
  assert.equal(schedule.ok,true,schedule.error);
  const queued=await env.send("ENQUEUE",{text:"普通聊天的第一条任务"},13,home);
  assert.equal(queued.ok,true,queued.error);
  const claim=await env.send("CLAIM",{ready:true,userCount:0},13,home);
  assert.equal(claim.dispatch?.text,"普通聊天的第一条任务");
  const sent=await env.send("SENT",{id:claim.dispatch.id},13,home);
  assert.equal(sent.ok,true,sent.error);

  env.navigate(13,ordinary);
  const early=await env.send("HELLO",{lastUserText:"",userCount:0},13,ordinary);
  assert.equal(early.sessionKey,"draft:13","原生消息尚未出现时不能丢失临时队列");
  assert.equal(early.state.activeTaskId,claim.dispatch.id);
  assert.equal(early.state.schedules.length,1);
  const adopted=await env.send("HELLO",{
    lastUserText:"普通聊天的第一条任务",userCount:1,
  },13,ordinary);
  assert.equal(adopted.sessionKey,"chat:plain-first-chat");
  assert.equal(adopted.state.activeTaskId,claim.dispatch.id);
  assert.equal(adopted.state.tasks[0].status,"waiting");
  assert.equal(adopted.state.schedules.length,1);
  assert.equal(adopted.state.schedules[0].text,"后续定时任务");
  assert.equal(env.stored["cq.state.v2"].conversations["draft:13"],undefined);
});

test("普通聊天临时队列不能被项目对话或其他标签抢走",async()=>{
  const env=await harness();
  const home="https://chatgpt.com/";
  env.navigate(13,home);
  await env.send("ENQUEUE",{text:"仅属于普通聊天"},13,home);
  const claim=await env.send("CLAIM",{ready:true,userCount:0},13,home);
  await env.send("SENT",{id:claim.dispatch.id},13,home);
  const project="https://chatgpt.com/g/g-p-1234567890abcdef1234567890abcdef/c/foreign";
  env.navigate(13,project);
  const wrongScope=await env.send("HELLO",{lastUserText:"仅属于普通聊天",userCount:1},13,project);
  assert.equal(wrongScope.sessionKey,"chat:foreign");
  assert.ok(env.stored["cq.state.v2"].conversations["draft:13"]);
  const ordinary="https://chatgpt.com/c/other-tab-chat";
  env.navigate(12,ordinary);
  const wrongTab=await env.send("HELLO",{lastUserText:"仅属于普通聊天",userCount:1},12,ordinary);
  assert.equal(wrongTab.sessionKey,"chat:other-tab-chat");
  assert.ok(env.stored["cq.state.v2"].conversations["draft:13"]);
});

test("未查看的已完成回复跨队列续发、页面刷新和后台重启保持标记，查看后清除", async () => {
  const env = await harness();
  const first = await env.send("ENQUEUE", {text:"第一条"});
  const second = await env.send("ENQUEUE", {text:"第二条"});
  assert.equal(first.state.unreadCompleted,false);
  assert.equal(second.state.tasks.length,2);
  const claimed = await env.send("CLAIM", {ready:true,userCount:0});
  await env.send("SENT", {id:claimed.dispatch.id});
  env.advance(4);
  const finished = await env.send("FINISHED", {
    id:claimed.dispatch.id,...voiceProof,viewed:false,
  });
  assert.equal(finished.ok,true);
  assert.equal(finished.state.tasks.length,1,"队列尚未全部完成");
  assert.equal(finished.state.unreadCompleted,true,"第一条结束就应标记待查看");
  const next = await env.send("CLAIM", {ready:true,userCount:1});
  assert.ok(next.dispatch);
  assert.equal(next.state.unreadCompleted,true,"自动领取下一条不能清除上一条未读");
  const persisted = await harness(env.stored);
  assert.equal((await persisted.send("GET")).state.unreadCompleted,true,
    "重新打开页面/后台重启后仍可恢复绿色勾");
  const ack = await persisted.send("ACK_COMPLETION_VIEWED");
  assert.equal(ack.state.unreadCompleted,false);
  assert.equal((await persisted.send("GET")).state.unreadCompleted,false);
  assert.equal((await persisted.send("GET",{},12)).state.unreadCompleted,false,
    "查看 A 对话不能给 B 对话添加标记");
});

test("普通回复待查看记录属于原对话：不抢跑队列，不接受别的标签代确认", async () => {
  const env = await harness();
  const noReply = await env.send("REPLY_COMPLETED",{viewed:true});
  assert.equal(noReply.state.unreadCompleted,false);
  const manual = await env.send("REPLY_COMPLETED",{viewed:false},12);
  assert.equal(manual.state.unreadCompleted,true);
  assert.equal((await env.send("GET")).state.unreadCompleted,false);
  await env.send("ACK_COMPLETION_VIEWED",{},11,B);
  assert.equal((await env.send("GET",{},12)).state.unreadCompleted,true,
    "伪造 B 地址的 A 标签不能清除 B 的待查看");
  await env.send("ACK_COMPLETION_VIEWED",{},12);
  assert.equal((await env.send("GET",{},12)).state.unreadCompleted,false);

  const queued = await env.send("ENQUEUE",{text:"正在等待回复"},11);
  const claimed = await env.send("CLAIM",{ready:true,userCount:0},11);
  await env.send("SENT",{id:claimed.dispatch.id},11);
  const early = await env.send("REPLY_COMPLETED",{viewed:false},11);
  assert.equal(early.state.unreadCompleted,false,
    "队列任务必须等待经过语音按钮的正式 FINISHED");
  assert.equal(queued.state.tasks.length,1);
});

test("管理页清理不会删除已完成但用户尚未查看的关闭对话", async () => {
  const env = await harness();
  await env.send("REPLY_COMPLETED",{viewed:false},12);
  env.closeTab(12);
  const dashboard = await env.sendDashboard("DASHBOARD_GET");
  assert.equal(dashboard.ok,true);
  assert.equal(dashboard.dashboard.sessions.some((s) => s.key === "chat:dialogue-b"),true);
  const cleaned = await env.sendDashboard("DASHBOARD_CLEANUP_IDLE",{confirm:true});
  assert.equal(cleaned.ok,true);
  assert.equal(env.stored["cq.state.v2"].conversations["chat:dialogue-b"].unreadCompleted,true);
});

test("升级时仍在运行的旧脚本没有 viewed 字段，完成提醒不会被丢掉", async () => {
  const env = await harness();
  await env.send("ENQUEUE",{text:"升级过程中完成的队列任务"});
  const claimed = await env.send("CLAIM",{ready:true,userCount:0});
  await env.send("SENT",{id:claimed.dispatch.id});
  env.advance(4);
  const finished = await env.send("FINISHED",{
    id:claimed.dispatch.id,...voiceProof,
  });
  assert.equal(finished.state.unreadCompleted,true);
  assert.equal(finished.state.tasks.length,0);
  assert.equal((await env.send("ACK_COMPLETION_VIEWED")).state.unreadCompleted,false);
});

test("变量收藏：必须主动启用模板，旧版双花括号提示词保持字面入队", async () => {
  const env=await harness();
  const literal=(await env.sendDashboard("ADD_FAVORITE",{
    text:"已有代码示例：{{项目名}}\\{{不用替换}}",
  })).favorites[0];
  assert.equal(literal.templateEnabled,false);
  const first=await env.send("ENQUEUE_FAVORITE",{
    favoriteId:literal.id,requestId:"b630f89f-95d9-4977-9d8d-aca788398811",
  },11,undefined,{url:A});
  assert.equal(first.ok,true);
  assert.equal(first.state.tasks[0].text,"已有代码示例：{{项目名}}\\{{不用替换}}");
  const rejected=await env.send("ENQUEUE_FAVORITE",{
    favoriteId:literal.id,templateValues:{"项目名":"演示"},
  },11,undefined,{url:A});
  assert.equal(rejected.ok,false);
  assert.match(rejected.error,/未启用变量模板/);
  assert.equal((await env.send("GET",{},11)).state.tasks.length,1);
  const dynamic=(await env.sendDashboard("ADD_FAVORITE",{
    text:literal.text,templateEnabled:true,
  })).favorites.find((favorite)=>favorite.templateEnabled);
  assert.ok(dynamic,"相同正文但不同模式允许作为不同模板");
  const queued=await env.send("ENQUEUE_FAVORITE",{
    favoriteId:dynamic.id,templateValues:{"项目名":"Aetherwild"},
  },12,undefined,{url:B});
  assert.equal(queued.ok,true);
  assert.equal(queued.state.tasks[0].text,"已有代码示例：Aetherwild{{不用替换}}");
  assert.equal(literal.text,"已有代码示例：{{项目名}}\\{{不用替换}}",
    "填充变量不能修改已保存的收藏正文");
});

test("变量收藏：重复占位符、中文输入和特殊字符按纯文本替换，图片仍可随队列发送", async () => {
  const env=await harness();
  const enqueued=await env.send("ENQUEUE",{
    text:"审核 {{项目名}} 的 {{任务目标}}，再审一次 {{项目名}}，保留 \\{{字面内容}}。",
    images:[testImage],
  },11);
  const task=enqueued.state.tasks[0];
  const saved=await env.send("ADD_FAVORITE",{
    taskId:task.id,templateEnabled:true,
  },11,undefined,{url:A});
  const favorite=saved.favorites[0];
  assert.equal(favorite.templateEnabled,true);
  const requestId="edcb23b0-cab7-4a2a-91c4-702cfc27c111";
  const values={"项目名":"Aetherwild","任务目标":"<img src=x onerror=alert(1)> $& 演示"};
  const result=await env.send("ENQUEUE_FAVORITE",{
    favoriteId:favorite.id,templateValues:values,requestId,
  },12,undefined,{url:B});
  assert.equal(result.ok,true);
  assert.equal(result.state.tasks.length,1);
  assert.equal(result.state.tasks[0].text,
    "审核 Aetherwild 的 <img src=x onerror=alert(1)> $& 演示，再审一次 Aetherwild，保留 {{字面内容}}。");
  assert.equal(result.state.tasks[0].images[0].id,task.images[0].id);
  const repeated=await env.send("ENQUEUE_FAVORITE",{
    favoriteId:favorite.id,templateValues:values,requestId,
  },12,undefined,{url:B});
  assert.equal(repeated.ok,true);
  assert.equal((await env.send("GET",{},12)).state.tasks.length,1);
  const updated=(await env.sendDashboard("GET_FAVORITES")).favorites[0];
  assert.equal(updated.useCount,1);
  assert.equal(updated.text,task.text);
  const conflict=await env.send("ENQUEUE_FAVORITE",{
    favoriteId:favorite.id,templateValues:{...values,"项目名":"新项目"},requestId,
  },12,undefined,{url:B});
  assert.equal(conflict.ok,false);
  assert.match(conflict.error,/重复提交标识/);
  assert.equal((await env.send("GET",{},12)).state.tasks.length,1);
});

test("变量收藏：缺失、多余、不合法字段及最终正文超限时严格拒绝且不入队", async () => {
  const env=await harness();
  const favorite=(await env.sendDashboard("ADD_FAVORITE",{
    text:"项目：{{项目名}}。目标：{{目标}}。",templateEnabled:true,
  })).favorites[0];
  const snapshots=JSON.stringify(env.stored["cq.state.v2"].favorites);
  for (const values of [
    undefined,null,{},{"项目名":"游戏"},
    {"项目名":"游戏","目标":" "},
    {"项目名":"游戏","目标":4},
    {"项目名":"游戏","目标":"任务","多余":"覆盖"},
    {"项目名":"游戏","目标":"a".repeat(3001)},
    "不是对象",[],
  ]) {
    const result=await env.send("ENQUEUE_FAVORITE",{
      favoriteId:favorite.id,...(values === undefined ? {} : {templateValues:values}),
    },11,undefined,{url:A});
    assert.equal(result.ok,false,JSON.stringify(values)?.slice(0,100));
    assert.equal((await env.send("GET",{},11)).state.tasks.length,0);
  }
  assert.equal(JSON.stringify(env.stored["cq.state.v2"].favorites),snapshots);
  const huge=(await env.sendDashboard("ADD_FAVORITE",{
    text:"{{大段}}".repeat(5),templateEnabled:true,
  })).favorites.find((item)=>item.templateEnabled && item.text.includes("大段"));
  const excessive=await env.send("ENQUEUE_FAVORITE",{
    favoriteId:huge.id,templateValues:{"大段":"甲".repeat(3000)},
  },11,undefined,{url:A});
  assert.equal(excessive.ok,false);
  assert.match(excessive.error,/12000/);
  assert.equal((await env.send("GET",{},11)).state.tasks.length,0);
  for (const invalid of [
    {text:"没有变量",templateEnabled:true},
    {text:"{{x?}}",templateEnabled:true},
    {text:"{{  }}",templateEnabled:true},
    {text:Array.from({length:13},(_,i)=>`{{变量${i}}}`).join(" "),templateEnabled:true},
    {text:"{{".concat("x".repeat(35),"}}"),templateEnabled:true},
    {text:"{{变量}}",templateEnabled:"true"},
  ]) {
    const reply=await env.sendDashboard("ADD_FAVORITE",invalid);
    assert.equal(reply.ok,false,JSON.stringify(invalid));
  }
});

test("变量收藏：模板开关和正文随完整备份迁移，旧备份缺省为字面文本", async () => {
  const page="chrome-extension://test-queue/favorites.html";
  const sender={url:page,tab:{id:77,url:page}};
  const source=await harness();
  const favorite=(await source.sendDashboard("ADD_FAVORITE",{
    text:"查阅 {{文件名}} 后给出建议",templateEnabled:true,category:"代码",
  },sender)).favorites[0];
  const meta=(await source.sendDashboard("GET_FAVORITES_BACKUP_META",{},sender)).backup;
  assert.equal(meta.favorites[0].templateEnabled,true);
  const dest=await harness();
  const started=await dest.sendDashboard("RESTORE_FAVORITES_BEGIN",{backup:meta},sender);
  const restored=await dest.sendDashboard("RESTORE_FAVORITES_FINISH",{
    token:started.token,
  },sender);
  assert.equal(restored.ok,true);
  assert.equal(restored.favorites[0].templateEnabled,true);
  assert.equal((await dest.send("ENQUEUE_FAVORITE",{
    favoriteId:restored.favorites[0].id,templateValues:{"文件名":"README.md"},
  },11,undefined,{url:A})).state.tasks[0].text,"查阅 README.md 后给出建议");
  const legacyMeta={
    ...meta,favorites:[{...meta.favorites[0]}],
  };
  delete legacyMeta.favorites[0].templateEnabled;
  const other=await harness();
  const old=await other.sendDashboard("RESTORE_FAVORITES_BEGIN",{
    backup:legacyMeta,
  },sender);
  const done=await other.sendDashboard("RESTORE_FAVORITES_FINISH",{
    token:old.token,
  },sender);
  assert.equal(done.ok,true);
  assert.equal(done.favorites[0].templateEnabled,false);
  assert.equal((await other.send("ENQUEUE_FAVORITE",{
    favoriteId:done.favorites[0].id,
  },11,undefined,{url:A})).state.tasks[0].text,"查阅 {{文件名}} 后给出建议");
  assert.equal(favorite.templateEnabled,true);
});

test("收藏备份：导出图文+分类置顶使用统计，跨浏览器导入完整原图并保持队列独立", async () => {
  const page="chrome-extension://test-queue/favorites.html";
  const sender={url:page,tab:{id:77,url:page}};
  const source=await harness();
  const task=(await source.send("ENQUEUE",{text:"图文模板",images:[testImage]},11)).state.tasks[0];
  const favorited=await source.send("ADD_FAVORITE",{taskId:task.id},11,undefined,{url:A});
  const imgFavorite=favorited.favorites[0];
  const decorated=await source.sendDashboard("UPDATE_FAVORITE",{
    id:imgFavorite.id,category:"代码",pinned:true,title:"保存图片模板",
  },sender);
  assert.equal(decorated.ok,true);
  await source.sendDashboard("ADD_FAVORITE",{
    text:"纯文字模板",category:"剧情",
  },sender);
  const used=await source.send("ENQUEUE_FAVORITE",{favoriteId:imgFavorite.id},12,undefined,{url:B});
  assert.equal(used.ok,true);
  const initialQueue=JSON.stringify(source.stored["cq.state.v2"].conversations);
  const meta=await source.sendDashboard("GET_FAVORITES_BACKUP_META",{},sender);
  assert.equal(meta.ok,true);
  assert.equal(meta.backup.format,"chatgpt-taskqueue-favorites");
  assert.equal(meta.backup.version,1);
  assert.equal(meta.backup.favorites.length,2);
  assert.equal(meta.backup.images.length,1);
  assert.ok(!JSON.stringify(meta.backup).includes("dataUrl"));
  const exported=await source.sendDashboard("GET_FAVORITES_BACKUP_IMAGE",{
    imageId:meta.backup.images[0].id,
  },sender);
  assert.equal(exported.ok,true);
  assert.equal(exported.image.dataUrl,testImage.dataUrl);
  assert.equal(exported.image.sha256,
    createHash("sha256").update(testImage.dataUrl).digest("hex"));
  assert.equal(JSON.stringify(source.stored["cq.state.v2"].conversations),initialQueue);
  const manifest={
    ...meta.backup,images:[{
      id:exported.image.id,name:exported.image.name,type:exported.image.type,
      size:exported.image.size,sha256:exported.image.sha256,
    }],
  };
  const destination=await harness();
  const begin=await destination.sendDashboard("RESTORE_FAVORITES_BEGIN",{
    backup:manifest,
  },sender);
  assert.equal(begin.ok,true);
  assert.equal(begin.images,1);
  assert.equal(begin.favorites,2);
  assert.equal((await destination.sendDashboard("GET_FAVORITES",{},sender)).favorites.length,0,
    "正式提交之前不应出现部分收藏");
  const staged=await destination.sendDashboard("RESTORE_FAVORITES_IMAGE",{
    token:begin.token,image:exported.image,
  },sender);
  assert.equal(staged.ok,true);
  const finished=await destination.sendDashboard("RESTORE_FAVORITES_FINISH",{
    token:begin.token,
  },sender);
  assert.equal(finished.ok,true);
  assert.equal(finished.imported,2);
  assert.equal(finished.skipped,0);
  const restored=finished.favorites.find((item)=>item.title==="保存图片模板");
  assert.equal(restored.pinned,true);
  assert.equal(restored.category,"代码");
  assert.equal(restored.useCount,1);
  assert.equal(restored.images.length,1);
  assert.notEqual(restored.images[0].id,exported.image.id);
  assert.ok(destination.storedImages.has(restored.images[0].id));
  assert.equal((await destination.send("GET",{},11)).state.tasks.length,0,
    "导入收藏绝不应该创建或发送对话队列任务");
  const queued=await destination.send("ENQUEUE_FAVORITE",{
    favoriteId:restored.id,
  },11,undefined,{url:A});
  assert.equal(queued.ok,true);
  assert.equal(queued.state.tasks[0].images[0].id,restored.images[0].id);
  assert.equal(destination.storedImages.get(restored.images[0].id).dataUrl,testImage.dataUrl);
});

test("收藏备份：合并时按原图 SHA-256 跳过跨设备重复项，清理多余暂存原图", async () => {
  const env=await harness();
  const page="chrome-extension://test-queue/favorites.html";
  const sender={url:page,tab:{id:81,url:page}};
  const task=(await env.send("ENQUEUE",{text:"相同图文",images:[testImage]},11)).state.tasks[0];
  const fav=(await env.send("ADD_FAVORITE",{taskId:task.id},11,undefined,{url:A})).favorites[0];
  const meta=(await env.sendDashboard("GET_FAVORITES_BACKUP_META",{},sender)).backup;
  const image=(await env.sendDashboard("GET_FAVORITES_BACKUP_IMAGE",{
    imageId:meta.images[0].id,
  },sender)).image;
  const manifest={...meta,images:[{
    id:image.id,name:image.name,type:image.type,size:image.size,sha256:image.sha256,
  }]};
  const oldOriginals=[...env.storedImages.keys()];
  const first=await env.sendDashboard("RESTORE_FAVORITES_BEGIN",{backup:manifest},sender);
  await env.sendDashboard("RESTORE_FAVORITES_IMAGE",{token:first.token,image},sender);
  const result=await env.sendDashboard("RESTORE_FAVORITES_FINISH",{token:first.token},sender);
  assert.equal(result.ok,true);
  assert.equal(result.imported,0);
  assert.equal(result.skipped,1);
  assert.deepEqual([...env.storedImages.keys()],oldOriginals);
  assert.equal((await env.sendDashboard("GET_FAVORITES",{},sender)).favorites[0].id,fav.id);
  assert.equal((await env.send("GET",{},11)).state.tasks.length,1);

  const textBackup={format:"chatgpt-taskqueue-favorites",version:1,
    favorites:[{title:"同名其他收藏",text:"与本地不同的文字",category:"参考",
      pinned:false,useCount:0,images:[]}],images:[]};
  const started=await env.sendDashboard("RESTORE_FAVORITES_BEGIN",{
    backup:textBackup,
  },sender);
  const imported=await env.sendDashboard("RESTORE_FAVORITES_FINISH",{
    token:started.token,
  },sender);
  assert.equal(imported.imported,1);
  assert.equal(imported.skipped,0);
  assert.equal(imported.favorites.length,2);
});

test("收藏备份：篡改图片、缺失上传、伪造来源或中止均不能修改已有收藏和队列", async () => {
  const env=await harness();
  const page="chrome-extension://test-queue/favorites.html";
  const sender={url:page,tab:{id:77,url:page}};
  const badSenders=[
    {url:page,tab:{id:77,url:page},frameId:2},
    {url:"chrome-extension://test-queue/dashboard.html"},
    {url:A,tab:{id:11,url:A},frameId:0},
    {url:"chrome-extension://another/favorites.html",tab:{id:77}},
  ];
  for (const bad of badSenders) {
    assert.equal((await env.sendDashboard("GET_FAVORITES_BACKUP_META",{},bad)).ok,false);
    assert.equal((await env.sendDashboard("RESTORE_FAVORITES_BEGIN",{},bad)).ok,false);
  }
  const created=await env.send("ENQUEUE",{text:"原有图文",images:[testImage]},11);
  await env.send("ADD_FAVORITE",{taskId:created.state.tasks[0].id},11,undefined,{url:A});
  const meta=(await env.sendDashboard("GET_FAVORITES_BACKUP_META",{},sender)).backup;
  const image=(await env.sendDashboard("GET_FAVORITES_BACKUP_IMAGE",{
    imageId:meta.images[0].id,
  },sender)).image;
  const manifest={...meta,images:[{
    id:image.id,name:image.name,type:image.type,size:image.size,sha256:image.sha256,
  }]};
  const before=JSON.stringify(env.stored["cq.state.v2"]);
  const beforeImageIds=[...env.storedImages.keys()];
  for (const invalid of [
    {...manifest,format:"wrong"},
    {...manifest,images:[{...manifest.images[0],sha256:"bad-sha"}]},
    {...manifest,images:[...manifest.images,...manifest.images]},
    {...manifest,favorites:[{...meta.favorites[0],text:1}]},
    {...manifest,favorites:[{...meta.favorites[0],images:[{id:"missing"}]}]},
  ]) {
    const result=await env.sendDashboard("RESTORE_FAVORITES_BEGIN",{
      backup:invalid,
    },sender);
    assert.equal(result.ok,false);
    assert.equal(JSON.stringify(env.stored["cq.state.v2"]),before);
  }
  const began=await env.sendDashboard("RESTORE_FAVORITES_BEGIN",{
    backup:manifest,
  },sender);
  assert.equal(began.ok,true);
  assert.equal((await env.sendDashboard("RESTORE_FAVORITES_FINISH",{
    token:began.token,
  },sender)).ok,false);
  const tampered=await env.sendDashboard("RESTORE_FAVORITES_IMAGE",{
    token:began.token,image:{...image,dataUrl:image.dataUrl.replace(/A/g,"B")},
  },sender);
  assert.equal(tampered.ok,false);
  assert.equal((await env.sendDashboard("RESTORE_FAVORITES_IMAGE",{
    token:began.token,image,
  },{url:page,tab:{id:99,url:page}})).ok,false,
    "其他标签无法上传至当前暂存");
  assert.equal((await env.sendDashboard("RESTORE_FAVORITES_IMAGE",{
    token:began.token,image,
  },sender)).ok,true);
  assert.equal((await env.sendDashboard("RESTORE_FAVORITES_ABORT",{
    token:began.token,
  },{url:page,tab:{id:99,url:page}})).ok,false,
    "其他标签不能取消当前图片暂存");
  const aborted=await env.sendDashboard("RESTORE_FAVORITES_ABORT",{
    token:began.token,
  },sender);
  assert.equal(aborted.ok,true);
  assert.deepEqual([...env.storedImages.keys()],beforeImageIds);
  assert.equal(JSON.stringify(env.stored["cq.state.v2"]),before);
});

test("收藏备份：存储写入失败不清除旧图，误报写入失败后也保留已提交原图", async () => {
  const page="chrome-extension://test-queue/favorites.html";
  const sender={url:page,tab:{id:77,url:page}};
  const source=await harness();
  const task=(await source.send("ENQUEUE",{text:"恢复测试",images:[testImage]},11)).state.tasks[0];
  await source.send("ADD_FAVORITE",{taskId:task.id},11,undefined,{url:A});
  const meta=(await source.sendDashboard("GET_FAVORITES_BACKUP_META",{},sender)).backup;
  const image=(await source.sendDashboard("GET_FAVORITES_BACKUP_IMAGE",{
    imageId:meta.images[0].id,
  },sender)).image;
  const manifest={...meta,images:[{
    id:image.id,name:image.name,type:image.type,size:image.size,sha256:image.sha256,
  }]};
  for (const failurePhase of ["before","after"]) {
    const dest=await harness();
    const started=await dest.sendDashboard("RESTORE_FAVORITES_BEGIN",{
      backup:manifest,
    },sender);
    await dest.sendDashboard("RESTORE_FAVORITES_IMAGE",{
      token:started.token,image,
    },sender);
    dest.failNextWrite(failurePhase);
    assert.equal((await dest.sendDashboard("RESTORE_FAVORITES_FINISH",{
      token:started.token,
    },sender)).ok,false);
    await dest.sendDashboard("RESTORE_FAVORITES_ABORT",{
      token:started.token,
    },sender);
    const committed=dest.stored["cq.state.v2"].favorites?.[0] || null;
    if (failurePhase === "before") {
      assert.equal(committed,null);
      assert.equal(dest.storedImages.size,0);
    } else {
      assert.ok(committed);
      assert.equal(committed.images.length,1);
      assert.ok(dest.storedImages.has(committed.images[0].id),
        "存储实际落盘时不能把已经被收藏引用的原图作为失败回滚删除");
    }
  }
});

test("收藏备份：导入容量不足与暂存超时，拒绝部分恢复且不会误删别的收藏原图", async () => {
  const env=await harness();
  const page="chrome-extension://test-queue/favorites.html";
  const sender={url:page,tab:{id:77,url:page}};
  const source=(await env.send("ENQUEUE",{text:"受保护的原图",images:[testImage]},11)).state.tasks[0];
  const existing=(await env.send("ADD_FAVORITE",{taskId:source.id},11,undefined,{url:A})).favorites[0];
  const originalImageId=existing.images[0].id;
  for (let i=1;i<100;i++) {
    const added=await env.sendDashboard("ADD_FAVORITE",{text:"占满收藏名额-"+i},sender);
    assert.equal(added.ok,true);
  }
  const backup={
    format:"chatgpt-taskqueue-favorites",version:1,
    favorites:[{title:"溢出项",text:"新收藏",category:"",pinned:false,images:[]}],
    images:[],
  };
  const before=JSON.stringify(env.stored["cq.state.v2"]);
  const began=await env.sendDashboard("RESTORE_FAVORITES_BEGIN",{backup},sender);
  assert.equal(began.ok,true);
  const overflow=await env.sendDashboard("RESTORE_FAVORITES_FINISH",{
    token:began.token,
  },sender);
  assert.equal(overflow.ok,false);
  assert.match(overflow.error,/100/);
  assert.equal(JSON.stringify(env.stored["cq.state.v2"]),before);
  await env.sendDashboard("RESTORE_FAVORITES_ABORT",{token:began.token},sender);
  assert.equal(env.storedImages.has(originalImageId),true);

  // Restore using a source manifest with a new image and a text different
  // from every existing favorite. This is only staged, not committed.
  const ref=(await env.sendDashboard("GET_FAVORITES_BACKUP_META",{},sender)).backup.images[0];
  const image=(await env.sendDashboard("GET_FAVORITES_BACKUP_IMAGE",{
    imageId:ref.id,
  },sender)).image;
  const importBackup={
    format:"chatgpt-taskqueue-favorites",version:1,
    favorites:[{title:"待过期导入",text:"有原图的新收藏",
      category:"",pinned:false,images:[{id:ref.id}]}],
    images:[{id:ref.id,name:ref.name,type:ref.type,size:ref.size,sha256:image.sha256}],
  };
  const pending=await env.sendDashboard("RESTORE_FAVORITES_BEGIN",{
    backup:importBackup,
  },sender);
  assert.equal((await env.sendDashboard("RESTORE_FAVORITES_IMAGE",{
    token:pending.token,image,
  },sender)).ok,true);
  assert.equal(env.storedImages.size,2);
  await env.tick(16);
  assert.equal(env.storedImages.size,1,"过期图片只能清理没有正式收藏引用的暂存原图");
  assert.ok(env.storedImages.has(originalImageId));
  assert.equal((await env.sendDashboard("RESTORE_FAVORITES_FINISH",{
    token:pending.token,
  },sender)).ok,false,"已过期会话不能迟到提交");
  assert.equal(env.stored["cq.state.v2"].favorites.length,100);
});

test("发送冷却：上一条确认完成后延迟领取，后台硬拦截提前 CLAIM，按对话独立", async () => {
  const env = await harness();
  assert.equal((await env.send("GET")).state.sendCooldownSeconds,0,
    "旧对话和未设置的对话保持原先即时接力");
  const saved = await env.send("SAVE_SEND_COOLDOWN",{seconds:"30"},11);
  assert.equal(saved.ok,true);
  assert.equal(saved.state.sendCooldownSeconds,30);
  assert.equal((await env.send("GET",{},12)).state.sendCooldownSeconds,0);
  await env.send("ENQUEUE",{text:"第一条"},11);
  await env.send("ENQUEUE",{text:"第二条"},11);
  const first = await env.send("CLAIM",{ready:true},11);
  assert.equal(first.dispatch.text,"第一条",
    "首次发送不应因没有上一条完成时间而无端等待");
  await env.send("SENT",{id:first.dispatch.id},11);
  env.advance(3);
  const finished = await env.send("FINISHED",{...voiceProof,id:first.dispatch.id},11);
  assert.equal(finished.ok,true);
  assert.equal(Number.isFinite(finished.state.lastQueueSettledAt),true);
  const logLength = finished.state.history.length;
  const cooling = await env.send("CLAIM",{ready:true},11);
  assert.equal(cooling.dispatch,null);
  assert.equal(cooling.dispatchBlockedReason,"cooldown");
  env.advance(29);
  assert.equal((await env.send("CLAIM",{ready:true},11)).dispatch,null);
  assert.equal((await env.send("GET",{},11)).state.history.length,logLength,
    "冷却轮询不能重复写日志");
  assert.equal((await env.send("CLAIM",{ready:true},12)).dispatch,null,
    "另一个没有待办的对话不应生成任务");
  env.advance(1);
  const next = await env.send("CLAIM",{ready:true},11);
  assert.equal(next.dispatch.text,"第二条");
  assert.equal(next.state.tasks.find((task)=>task.id===next.dispatch.id).status,"dispatching");
});

test("发送冷却：调整时长可立即生效，暂停和自动规则入队不会绕过实际发送门禁", async () => {
  const env = await harness();
  await env.send("SAVE_SEND_COOLDOWN",{seconds:120},11);
  await env.send("ENQUEUE",{text:"第一条"},11);
  await env.send("ENQUEUE",{text:"普通队列第二条"},11);
  const first=(await env.send("CLAIM",{ready:true},11)).dispatch;
  await env.send("SENT",{id:first.id},11);
  env.advance(3);
  await env.send("FINISHED",{...voiceProof,id:first.id},11);
  const rule = await env.send("ADD_SCHEDULE",{
    text:"时间规则追加的任务",mode:"time",intervalMinutes:1,repeatCount:0,
  },11);
  assert.equal(rule.ok,true);
  env.advance(60);
  const pulse = await env.send("SCHEDULE_PULSE",{},11);
  assert.ok(pulse.state.tasks.some((item)=>item.text==="时间规则追加的任务" &&
    item.status==="pending"),"冷却中定时规则仍可入队");
  assert.equal((await env.send("CLAIM",{ready:true},11)).dispatch,null);
  await env.send("SET_QUEUE_PAUSED",{paused:true},11);
  env.advance(10);
  assert.equal((await env.send("CLAIM",{ready:true},11)).dispatch,null);
  await env.send("SET_QUEUE_PAUSED",{paused:false},11);
  assert.equal((await env.send("CLAIM",{ready:true},11)).dispatch,null,
    "解除暂停不能跳过剩余冷却");
  await env.send("SAVE_SEND_COOLDOWN",{seconds:30},11);
  const ready=await env.send("CLAIM",{ready:true},11);
  assert.equal(ready.dispatch.text,"普通队列第二条",
    "缩短时长后，已超过新间隔的任务可以正常开始");
  await env.send("SENT",{id:ready.dispatch.id},11);
  env.advance(3);
  await env.send("FINISHED",{...voiceProof,id:ready.dispatch.id},11);
  await env.send("SAVE_SEND_COOLDOWN",{seconds:90},11);
  env.advance(40);
  assert.equal((await env.send("CLAIM",{ready:true},11)).dispatch,null,
    "延长时长也应以最后完成时间重新计算");
  await env.send("SAVE_SEND_COOLDOWN",{seconds:0},11);
  assert.equal((await env.send("CLAIM",{ready:true},11)).dispatch.text,"时间规则追加的任务");
  assert.equal((await env.send("GET",{},12)).state.sendCooldownSeconds,0);
});

test("发送冷却：错误恢复后重新计时，旧版存档兼容；持久化设置可在后台重启后继续生效", async () => {
  const env=await harness();
  await env.send("SAVE_SEND_COOLDOWN",{seconds:60},11);
  await env.send("ENQUEUE",{text:"结果不确定"},11);
  await env.send("ENQUEUE",{text:"等待后续"},11);
  const first=(await env.send("CLAIM",{ready:true},11)).dispatch;
  await env.send("SENT",{id:first.id},11);
  env.advance(3);
  await env.send("FAIL",{id:first.id,error:"错误"},11);
  const recovered=await env.send("RECOVER_ON_VOICE",{
    voiceReady:true,voiceStableMs:2200,editorEmpty:true,busy:false,
  },11);
  assert.equal(recovered.state.halted,false);
  assert.equal((await env.send("CLAIM",{ready:true},11)).dispatch,null);
  const afterRestart=await harness({"cq.state.v2":structuredClone(env.stored["cq.state.v2"])});
  assert.equal((await afterRestart.send("GET",{},11)).state.sendCooldownSeconds,60);
  assert.equal((await afterRestart.send("CLAIM",{ready:true},11)).dispatch,null);
  afterRestart.advance(62);
  assert.equal((await afterRestart.send("CLAIM",{ready:true},11)).dispatch,null);
  afterRestart.advance(1);
  assert.equal((await afterRestart.send("CLAIM",{ready:true},11)).dispatch.text,"等待后续");
});

test("发送冷却：非法设置和越权修改一律拒绝，失败不更改已有秒数", async () => {
  const env=await harness();
  assert.equal((await env.send("SAVE_SEND_COOLDOWN",{seconds:40},11)).ok,true);
  for (const seconds of ["",null,-1,3601,1.5,"abc",Infinity,true,false,{}]) {
    const result=await env.send("SAVE_SEND_COOLDOWN",{seconds},11);
    assert.equal(result.ok,false,String(seconds));
  }
  const cross=await env.send("SAVE_SEND_COOLDOWN",{seconds:1},12,A);
  assert.equal(cross.ok,false,"B 标签不能更改 A 对话");
  assert.equal((await env.send("GET",{},11)).state.sendCooldownSeconds,40);
  assert.equal((await env.send("GET",{},12)).state.sendCooldownSeconds,0);
});

test("收藏夹迭代：分类、置顶、编辑全文及图文引用，旧版收藏兼容", async () => {
  const env = await harness();
  const original = await env.send("ENQUEUE",{text:"原始图文模板",images:[testImage]},11);
  const task = original.state.tasks[0];
  const saved = await env.send("ADD_FAVORITE",{taskId:task.id},11,undefined,{url:A});
  const id = saved.favorites[0].id;
  const imageId = saved.favorites[0].images[0].id;
  // Simulate a pre-upgrade bookmark with no category, pin, usage metadata.
  const legacy = env.stored["cq.state.v2"].favorites[0];
  delete legacy.category;
  delete legacy.pinned;
  delete legacy.useCount;
  delete legacy.lastUsedAt;
  const renamed = await env.sendDashboard("UPDATE_FAVORITE",{
    id, title:"  勇者西幻剧情  ",text:"重写后的图文指令",
    category:"  剧情    设计  ",pinned:true,
  });
  assert.equal(renamed.ok,true);
  assert.equal(renamed.favorites[0].title,"勇者西幻剧情");
  assert.equal(renamed.favorites[0].category,"剧情 设计");
  assert.equal(renamed.favorites[0].pinned,true);
  assert.equal(renamed.favorites[0].text,"重写后的图文指令");
  assert.equal(renamed.favorites[0].images[0].id,imageId);
  assert.equal((await env.send("GET",{},11)).state.tasks[0].text,"原始图文模板",
    "编辑收藏不能改写原任务");
  await env.send("DELETE_TASK",{id:task.id},11);
  assert.equal(env.storedImages.has(imageId),true,"收藏仍引用原图，删除任务不得清理");
  const target=await env.send("ENQUEUE_FAVORITE",{favoriteId:id},12,undefined,{url:B});
  assert.equal(target.ok,true);
  assert.equal(target.state.tasks[0].text,"重写后的图文指令");
  assert.equal(target.state.tasks[0].images[0].id,imageId);
  const used=(await env.sendDashboard("GET_FAVORITES")).favorites[0];
  assert.equal(used.useCount,1);
  assert.equal(Number.isFinite(used.lastUsedAt),true);
  await env.sendDashboard("UPDATE_FAVORITE",{id,category:"",pinned:false});
  const unpinned=(await env.sendDashboard("GET_FAVORITES")).favorites[0];
  assert.equal(unpinned.category,"");
  assert.equal(unpinned.pinned,false);
  assert.equal(unpinned.useCount,1);
  assert.equal(unpinned.lastUsedAt,used.lastUsedAt);
});

test("收藏夹迭代：复用统计只计算成功入队，不因重试、已满或失败增加", async () => {
  const env = await harness();
  const favorite=(await env.sendDashboard("ADD_FAVORITE",{
    text:"重复使用统计",category:"效率",
  })).favorites[0];
  assert.equal(favorite.category,"效率");
  const requestId="4b8bfae2-713a-4766-bca7-42f601981111";
  const first=await env.send("ENQUEUE_FAVORITE",{favoriteId:favorite.id,requestId},11,undefined,{url:A});
  assert.equal(first.ok,true);
  const same=await env.send("ENQUEUE_FAVORITE",{favoriteId:favorite.id,requestId},11,undefined,{url:A});
  assert.equal(same.ok,true);
  assert.equal((await env.sendDashboard("GET_FAVORITES")).favorites[0].useCount,1);
  const countBefore=(await env.sendDashboard("GET_FAVORITES")).favorites[0].lastUsedAt;
  await env.send("SAVE_SETTINGS",{maxPending:1},11);
  const full=await env.send("ENQUEUE_FAVORITE",{favoriteId:favorite.id},11,undefined,{url:A});
  assert.equal(full.ok,false);
  assert.equal((await env.sendDashboard("GET_FAVORITES")).favorites[0].useCount,1);
  assert.equal((await env.sendDashboard("GET_FAVORITES")).favorites[0].lastUsedAt,countBefore);
  const next=await env.send("ENQUEUE_FAVORITE",{favoriteId:favorite.id},12,undefined,{url:B});
  assert.equal(next.ok,true);
  assert.equal((await env.sendDashboard("GET_FAVORITES")).favorites[0].useCount,2,
    "不同对话成功复用也共用累计计数");
});

test("收藏夹迭代：元数据非法、重复编辑、越权输入时不写入存档", async () => {
  const env = await harness();
  const first=(await env.sendDashboard("ADD_FAVORITE",{
    text:"第一条",category:"分类A",
  })).favorites[0];
  await env.sendDashboard("ADD_FAVORITE",{text:"第二条"});
  const before=JSON.stringify(env.stored["cq.state.v2"].favorites);
  for (const message of [
    {id:first.id,category:14},
    {id:first.id,category:"超".repeat(25)},
    {id:first.id,pinned:"yes"},
    {id:first.id,title:" "},
    {id:first.id,text:""},
    {id:first.id,text:"第二条"},
    {id:first.id,text:"test",images:[{id:"forged"}]},
    {id:first.id,useCount:9900},
    {id:first.id,createdAt:1},
    {id:first.id},
  ]) {
    const response=await env.sendDashboard("UPDATE_FAVORITE",message);
    assert.equal(response.ok,false,JSON.stringify(message));
    assert.equal(JSON.stringify(env.stored["cq.state.v2"].favorites),before,
      "编辑校验失败不能产生半修改");
  }
  const outsider=await env.sendDashboard("UPDATE_FAVORITE",{
    id:first.id,pinned:true,
  },{url:"https://evil.example/favorites.html",tab:{id:77}});
  assert.equal(outsider.ok,false);
  assert.equal(JSON.stringify(env.stored["cq.state.v2"].favorites),before);
});

test("收藏夹：任务收藏跨对话持久化、去重、重命名、删除，不改变原队列", async () => {
  const env = await harness();
  const source = await env.send("ENQUEUE",{text:"  我想反复使用的提示词  "},11);
  const task = source.state.tasks[0];
  const saved = await env.send("ADD_FAVORITE",{taskId:task.id},11,undefined,{url:A});
  assert.equal(saved.ok,true);
  assert.equal(saved.favorites.length,1);
  const favorite = saved.favorites[0];
  assert.equal(favorite.text,"我想反复使用的提示词");
  const duplicate = await env.send("ADD_FAVORITE",{taskId:task.id},11,undefined,{url:A});
  assert.equal(duplicate.alreadySaved,true);
  assert.equal(duplicate.favorites.length,1);
  const renamed = await env.sendDashboard("RENAME_FAVORITE",{id:favorite.id,title:"  精选模板 "});
  assert.equal(renamed.favorites[0].title,"精选模板");
  const listed = await env.send("GET_FAVORITES",{},12,undefined,{url:B});
  assert.equal(listed.favorites[0].title,"精选模板");
  assert.equal((await env.send("GET",{},11)).state.tasks.length,1);
  await env.send("DELETE_TASK",{id:task.id},11);
  assert.equal((await env.send("GET_FAVORITES",{},12,undefined,{url:B})).favorites.length,1);
  const requestId = "00000000-0000-4000-8000-000000000001";
  const queued = await env.send("ENQUEUE_FAVORITE",{favoriteId:favorite.id,requestId},12,undefined,{url:B});
  assert.equal(queued.ok,true);
  assert.equal(queued.state.tasks[0].status,"pending");
  assert.equal(queued.state.tasks[0].text,"我想反复使用的提示词");
  await env.send("ENQUEUE_FAVORITE",{favoriteId:favorite.id,requestId},12,undefined,{url:B});
  assert.equal((await env.send("GET",{},12)).state.tasks.length,1);
  const removed = await env.sendDashboard("DELETE_FAVORITE",{id:favorite.id});
  assert.equal(removed.favorites.length,0);
  assert.equal((await env.send("GET",{},12)).state.tasks.length,1);
  assert.equal(env.stored["cq.state.v2"].favorites.length,0);
});

test("收藏输入：ChatGPT 单页切换对话后可收藏本地路径，但不能伪造标签地址或来源", async () => {
  const env = await harness();
  env.navigate(11,B);
  const localPath = String.raw`C:\Users\CatStudio\Desktop\ChatGPTTaskQueue`;
  const staleSender = {url:A,tab:{id:11,url:B},frameId:0};
  const saved = await env.sendDashboard("ADD_FAVORITE",{url:B,text:localPath},staleSender);
  assert.equal(saved.ok,true);
  assert.equal(saved.favorites[0].text,localPath);
  // Some browsers omit sender.tab.url; querying the live tab must still work.
  const repeated = await env.sendDashboard("ADD_FAVORITE",{url:B,text:localPath},
    {url:A,tab:{id:11},frameId:0});
  assert.equal(repeated.ok,true);
  assert.equal(repeated.alreadySaved,true);
  assert.equal((await env.sendDashboard("ADD_FAVORITE",{url:A,text:"伪造旧地址"},
    staleSender)).ok,false);
  assert.equal((await env.sendDashboard("ADD_FAVORITE",{url:B,text:"伪造来源"},
    {url:"https://evil.example/",tab:{id:11,url:B},frameId:0})).ok,false);
  assert.equal(env.stored["cq.state.v2"].favorites.length,1);
});

test("图文收藏保留 IndexedDB 原件；队列删除、重用与删除收藏不提前清理图片", async () => {
  const env = await harness();
  const source = await env.send("ENQUEUE",{text:"图文模板",images:[testImage]},11);
  const task = source.state.tasks[0];
  const imageId = task.images[0].id;
  const saved = await env.send("ADD_FAVORITE",{taskId:task.id},11,undefined,{url:A});
  const favoriteId = saved.favorites[0].id;
  assert.equal(saved.favorites[0].images[0].id,imageId);
  await env.send("DELETE_TASK",{id:task.id},11);
  assert.equal(env.storedImages.has(imageId),true);
  const again = await env.send("ENQUEUE_FAVORITE",{favoriteId},12,undefined,{url:B});
  assert.equal(again.ok,true);
  assert.equal(again.state.tasks[0].images[0].id,imageId);
  await env.sendDashboard("DELETE_FAVORITE",{id:favoriteId});
  assert.equal(env.storedImages.has(imageId),true);
  await env.send("DELETE_TASK",{id:again.state.tasks[0].id},12);
  assert.equal(env.storedImages.has(imageId),false);
});

test("收藏权限与安全边界：拒绝伪造来源、跨对话任务、图片丢失及收藏上限", async () => {
  const env = await harness();
  const source = await env.send("ENQUEUE",{text:"A 的任务",images:[testImage]},11);
  const task = source.state.tasks[0];
  assert.equal((await env.send("ADD_FAVORITE",{taskId:task.id},12,undefined,{url:B})).ok,false);
  assert.equal((await env.send("GET_FAVORITES",{},11)).ok,false);
  assert.equal((await env.send("ADD_FAVORITE",{taskId:task.id},11,undefined,{url:"https://evil.invalid"})).ok,false);
  env.storedImages.delete(task.images[0].id);
  assert.equal((await env.send("ADD_FAVORITE",{taskId:task.id},11,undefined,{url:A})).ok,false);
  const manager = "chrome-extension://test-queue/favorites.html";
  assert.equal((await env.sendDashboard("ADD_FAVORITE",{text:"文字模板"},
    {url:manager,tab:{id:77,url:manager}})).ok,true);
  const favoriteId = env.stored["cq.state.v2"].favorites[0].id;
  assert.equal((await env.sendDashboard("ENQUEUE_FAVORITE",{favoriteId,url:B},
    {url:manager,tab:{id:77,url:manager}})).ok,false);
  assert.equal((await env.sendDashboard("RENAME_FAVORITE",{id:favoriteId,title:" "})).ok,false);
  assert.equal((await env.sendDashboard("ADD_FAVORITE",{text:" "})).ok,false);
  for (let i = 1; i < 100; i++) {
    assert.equal((await env.sendDashboard("ADD_FAVORITE",{text:`模板 ${i}`})).ok,true);
  }
  assert.equal((await env.sendDashboard("ADD_FAVORITE",{text:"超过上限"})).ok,false);
  assert.equal(env.stored["cq.state.v2"].favorites.length,100);
});

test("运行日志按对话记录状态事件，不写提示词/错误详情，最多保留 80 条", async () => {
  const { send, advance, stored } = await harness();
  await send("ENQUEUE", { text: "绝不能出现在运行日志中的敏感提示词" });
  const task = (await send("GET")).state.tasks[0];
  assert.equal((await send("GET")).state.history.length, 1);
  await send("CLAIM", { ready: true });
  await send("SENT", { id: task.id });
  advance(3);
  await send("FINISHED", { ...voiceProof, id: task.id });
  let history = (await send("GET")).state.history;
  assert.deepEqual(Array.from(history, (entry) => entry.type),
    ["manual_enqueue", "claim", "sent", "finished"]);
  assert.equal(JSON.stringify(history).includes("敏感提示词"), false);
  assert.equal((await send("GET", {}, 12)).state.history.length, 0);
  for (let i = 0; i < 90; i++) {
    await send("ENQUEUE", { text: "新任务" + i });
    const current = (await send("GET")).state;
    await send("DELETE_TASK", { id: current.tasks.at(-1).id });
  }
  history = (await send("GET")).state.history;
  assert.equal(history.length, 80);
  assert.equal(history.at(-1).type, "task_deleted");
  assert.equal(history[0].type, "manual_enqueue");
  assert.equal(stored["cq.state.v2"].conversations["chat:dialogue-a"].history.length, 80);
  await send("ENQUEUE", { text: "保留待办" });
  const clean = await send("CLEAR_HISTORY");
  assert.equal(clean.state.history.length, 0);
  assert.equal(clean.state.tasks.at(-1).text, "保留待办");
  assert.equal((await send("GET")).state.history.length, 0);
});

test("工具栏管理页汇总多个对话的状态与标签信息，但绝不返回提示词或原图正文", async () => {
  const env = await harness();
  await env.send("ENQUEUE",{text:"隐私内容不要传给管理页",images:[testImage]},11);
  await env.send("ENQUEUE",{text:"第二个对话的任务"},12);
  await env.send("ADD_SCHEDULE",{text:"秘密的自动规则",intervalMinutes:20},12);
  env.tabs.get(11).title="A 对话 · 队列";
  env.tabs.get(12).discarded=true;
  const snapshot=await env.sendDashboard("DASHBOARD_GET");
  assert.equal(snapshot.ok,true);
  const sessions=snapshot.dashboard.sessions;
  assert.equal(sessions.length,2);
  const a=sessions.find((item)=>item.key==="chat:dialogue-a");
  const b=sessions.find((item)=>item.key==="chat:dialogue-b");
  assert.equal(a.pending,1);
  assert.equal(a.active,0);
  assert.equal(a.review,0);
  assert.equal(a.title,"A 对话 · 队列");
  assert.equal(a.browser,"loaded");
  assert.equal(a.url,A);
  assert.equal(b.pending,1);
  assert.equal(b.enabledRules,1);
  assert.equal(b.allRules,1);
  assert.equal(b.browser,"discarded");
  assert.equal(b.tabId,12);
  assert.equal(JSON.stringify(snapshot).includes("隐私内容不要传给管理页"),false);
  assert.equal(JSON.stringify(snapshot).includes("秘密的自动规则"),false);
  assert.equal(JSON.stringify(snapshot).includes(testImage.dataUrl),false);
  assert.equal(JSON.stringify(snapshot).includes("thumbnail"),false);
  assert.equal(a.recentEvents.length,1);
  assert.deepEqual(Object.keys(a.recentEvents[0]).sort(),["at","type"]);
  assert.equal(a.recentEvents[0].type,"manual_enqueue");
  assert.equal(b.recentEvents.length,2);
  assert.equal(b.recentEvents[0].type,"schedule_added");
  assert.equal(Number.isFinite(a.lastEventAt),true);
  assert.equal(a.activeSince,null);
  const fullPage=await env.sendDashboard("DASHBOARD_GET",{},{
    url:"chrome-extension://test-queue/dashboard.html?view=full",
    tab:{id:99,url:"chrome-extension://test-queue/dashboard.html?view=full"},
  });
  assert.equal(fullPage.ok,true,"独立大屏管理页能读取与弹窗相同的有限元数据");
  const fullPageWithoutTabsPermission=await env.sendDashboard("DASHBOARD_GET",{},{
    url:"chrome-extension://test-queue/dashboard.html?view=full",
    tab:{id:99},
  });
  assert.equal(fullPageWithoutTabsPermission.ok,true,
    "浏览器隐藏 Tab.url 时，已验证的扩展页面仍可访问自己的管理接口");

  const claim=await env.send("CLAIM",{ready:true},11);
  assert.ok(claim.dispatch);
  const during=(await env.sendDashboard("DASHBOARD_GET")).dashboard.sessions
    .find((item)=>item.key==="chat:dialogue-a");
  assert.equal(during.pending,0);
  assert.equal(during.active,1);
  assert.equal(during.activeStatus,"dispatching");
  assert.equal(Number.isFinite(during.activeSince),true);
  assert.equal((await env.send("SENT",{id:claim.dispatch.id},11)).ok,true);
  const waiting=(await env.sendDashboard("DASHBOARD_GET")).dashboard.sessions
    .find((item)=>item.key==="chat:dialogue-a");
  assert.equal(waiting.activeStatus,"waiting");
  assert.equal(Number.isFinite(waiting.activeSince),true);
  assert.equal(waiting.lastEventAt,waiting.activeSince);
  assert.equal(waiting.recentEvents[0].type,"sent");
});

test("页面心跳只反映当前标签的临时检测信号，不修改队列存档、任务或其他对话", async () => {
  const env = await harness();
  await env.send("ENQUEUE",{text:"敏感提示词 A"},11);
  await env.send("ENQUEUE",{text:"敏感提示词 B"},12);
  const before = JSON.stringify(env.stored["cq.state.v2"]);
  const initial = (await env.sendDashboard("DASHBOARD_GET")).dashboard.sessions;
  assert.equal(initial.find((s)=>s.key==="chat:dialogue-a").pageSignal,"unknown");
  assert.equal(initial.find((s)=>s.key==="chat:dialogue-a").pageSignalAt,null);

  assert.equal((await env.sendPulse(11,true)).ok,true);
  let items=(await env.sendDashboard("DASHBOARD_GET")).dashboard.sessions;
  const a=items.find((s)=>s.key==="chat:dialogue-a");
  assert.equal(a.pageSignal,"generating");
  assert.equal(Number.isFinite(a.pageSignalAt),true);
  assert.equal(items.find((s)=>s.key==="chat:dialogue-b").pageSignal,"unknown");
  assert.equal(Object.keys(a).includes("generating"),false,
    "管理页只需要有限枚举状态，不应透出原始页面参数");

  env.advance(21);
  items=(await env.sendDashboard("DASHBOARD_GET")).dashboard.sessions;
  assert.equal(items.find((s)=>s.key==="chat:dialogue-a").pageSignal,"stale");
  assert.equal((await env.sendPulse(11,false)).ok,true);
  items=(await env.sendDashboard("DASHBOARD_GET")).dashboard.sessions;
  assert.equal(items.find((s)=>s.key==="chat:dialogue-a").pageSignal,"idle");
  assert.equal(items.find((s)=>s.key==="chat:dialogue-b").pageSignal,"unknown");
  assert.equal(JSON.stringify(env.stored["cq.state.v2"]),before,
    "页面信号不应写入队列存档或污染任务日志");
  assert.equal(JSON.stringify(items).includes("敏感提示词"),false);

  env.closeTab(11);
  items=(await env.sendDashboard("DASHBOARD_GET")).dashboard.sessions;
  assert.equal(items.find((s)=>s.key==="chat:dialogue-a").pageSignal,"unavailable");
  assert.equal(items.find((s)=>s.key==="chat:dialogue-a").pageSignalAt,null);
});

test("页面心跳拒绝跨对话伪造、无效状态、子框架和外站报告", async () => {
  const env = await harness();
  await env.send("ENQUEUE",{text:"队列 A"},11);
  await env.send("ENQUEUE",{text:"队列 B"},12);
  for (const result of [
    await env.sendPulse(11,undefined),
    await env.sendPulse(11,"true"),
    await env.sendPulse(11,true,{url:"https://chatgpt.com/c/dialogue-b"}),
    await env.sendPulse(11,true,{url:"https://example.com/c/dialogue-a"}),
    await env.sendPulse(11,true,{frameId:2}),
    await env.sendPulse(11,true,{tab:{id:12,url:"https://chatgpt.com/c/dialogue-b"}}),
    await env.sendPulse(11,true,{tab:null}),
  ]) {
    assert.equal(result.ok,false);
  }
  const items=(await env.sendDashboard("DASHBOARD_GET")).dashboard.sessions;
  assert.equal(items.find((s)=>s.key==="chat:dialogue-a").pageSignal,"unknown");
  assert.equal(items.find((s)=>s.key==="chat:dialogue-b").pageSignal,"unknown");
});

test("管理中心：关闭的无任务旧会话可批量清理，仍有工作或打开的会话一律保留", async () => {
  const env=await harness();
  await env.send("ENQUEUE",{text:"旧会话完成后留下的日志"},11);
  const task=(await env.send("GET",{},11)).state.tasks[0];
  await env.send("DELETE_TASK",{id:task.id},11);
  await env.send("ENQUEUE",{text:"保留未完成的队列"},12);
  await env.send("ENQUEUE",{text:"打开的空队列"},13);
  const draft=(await env.send("GET",{},13)).state.tasks[0];
  await env.send("DELETE_TASK",{id:draft.id},13);
  env.closeTab(11);
  const snapshot=await env.sendDashboard("DASHBOARD_GET");
  assert.equal(snapshot.dashboard.cleanupEligible,1);
  assert.equal(snapshot.dashboard.sessions.some((item)=>item.key==="chat:dialogue-a"),false,
    "旧日志对应的空会话不在管理页，但仍占据持久化存档");
  assert.equal((await env.sendDashboard("DASHBOARD_CLEANUP_IDLE")).ok,false);
  const removed=await env.sendDashboard("DASHBOARD_CLEANUP_IDLE",{confirm:true});
  assert.equal(removed.ok,true);
  assert.equal(removed.removedCount,1);
  assert.equal(removed.dashboard.cleanupEligible,0);
  assert.equal(Object.hasOwn(env.stored["cq.state.v2"].conversations,"chat:dialogue-a"),false);
  assert.equal((await env.send("GET",{},12)).state.tasks.length,1);
  assert.equal((await env.send("GET",{},13)).state.tasks.length,0);
  assert.equal((await env.sendDashboard("DASHBOARD_CLEANUP_IDLE",{confirm:true})).removedCount,0);
});

test("管理中心：已关闭的遗留任务/自动规则需明确二次确认，可移除且不影响其他对话", async () => {
  const env=await harness();
  await env.send("ENQUEUE",{text:"待放弃的一号任务"},11);
  await env.send("ADD_SCHEDULE",{text:"不再有效的自动任务",intervalMinutes:120},11);
  await env.send("ENQUEUE",{text:"另一对话必须保留"},12);
  env.closeTab(11);
  assert.equal((await env.sendDashboard("DASHBOARD_GET")).dashboard.sessions
    .find((item)=>item.key==="chat:dialogue-a").requiresDiscard,true);
  assert.equal((await env.sendDashboard("DASHBOARD_REMOVE_CONVERSATION",{
    key:"chat:dialogue-a",confirm:true,
  })).ok,false);
  assert.equal((await env.sendDashboard("DASHBOARD_REMOVE_CONVERSATION",{
    key:"chat:dialogue-a",confirm:true,discardWork:true,confirmKey:"chat:dialogue-b",
  })).ok,false);
  const removed=await env.sendDashboard("DASHBOARD_REMOVE_CONVERSATION",{
    key:"chat:dialogue-a",confirm:true,discardWork:true,confirmKey:"chat:dialogue-a",
  });
  assert.equal(removed.ok,true);
  assert.equal(removed.removedCount,1);
  assert.equal(removed.dashboard.sessions.some((item)=>item.key==="chat:dialogue-a"),false);
  assert.equal(Object.hasOwn(env.stored["cq.state.v2"].conversations,"chat:dialogue-a"),false);
  assert.equal((await env.send("GET",{},12)).state.tasks[0].text,"另一对话必须保留");
  await env.tick(180);
  assert.equal(Object.hasOwn(env.stored["cq.state.v2"].conversations,"chat:dialogue-a"),false,
    "被删除的自动规则不能在下一次定时器触发时重新创建队列");
});

test("管理中心：已关闭的待确认发送记录允许明确放弃，打开的工作会话坚决拒绝移除", async () => {
  const env=await harness();
  await env.send("ENQUEUE",{text:"不确定是否已发送"},11);
  const claimed=await env.send("CLAIM",{ready:true},11);
  assert.ok(claimed.dispatch);
  const args={key:"chat:dialogue-a",confirm:true,discardWork:true,
    confirmKey:"chat:dialogue-a"};
  const rejected=await env.sendDashboard("DASHBOARD_REMOVE_CONVERSATION",args);
  assert.equal(rejected.ok,false);
  assert.match(rejected.error,/先关闭/);
  assert.equal((await env.send("GET",{},11)).state.activeTaskId,claimed.dispatch.id);
  env.closeTab(11);
  const removed=await env.sendDashboard("DASHBOARD_REMOVE_CONVERSATION",args);
  assert.equal(removed.ok,true);
  assert.equal(Object.hasOwn(env.stored["cq.state.v2"].conversations,"chat:dialogue-a"),false);
  assert.equal(env.tabReloads.length,0);
});

test("管理中心：删除图文队列不删除仍被收藏的原图，移除失效收藏标记", async () => {
  const env=await harness({
    "cq.dashboard.view.v1":{favorites:["chat:dialogue-a","chat:dialogue-b"],
      compact:true,layout:"list",grouped:true},
  },{structuredStorage:true});
  const added=await env.send("ENQUEUE",{text:"需要复用的图文内容",images:[testImage]},11);
  const task=added.state.tasks[0];
  const imageId=task.images[0].id;
  assert.equal(env.storedImages.has(imageId),true);
  const favorite=await env.send("ADD_FAVORITE",{taskId:task.id},11,undefined,{url:A});
  assert.equal(favorite.ok,true);
  env.closeTab(11);
  const result=await env.sendDashboard("DASHBOARD_REMOVE_CONVERSATION",{
    key:"chat:dialogue-a",confirm:true,discardWork:true,confirmKey:"chat:dialogue-a",
  });
  assert.equal(result.ok,true);
  assert.equal(env.storedImages.has(imageId),true,"收藏夹共享的原图必须保留");
  assert.equal(env.stored["cq.state.v2"].favorites.length,1);
  assert.deepEqual(env.stored["cq.dashboard.view.v1"].favorites,["chat:dialogue-b"]);
  assert.equal(env.stored["cq.dashboard.view.v1"].layout,"list");
  assert.equal(env.stored["cq.dashboard.view.v1"].grouped,true);
});

test("管理中心：移除对话同步清除本地备注；其他备注与视图偏好保持原样", async () => {
  const env=await harness({
    "cq.dashboard.aliases.v1":{
      "chat:dialogue-a":"主线剧本",
      "chat:dialogue-b":"战斗机制",
      "chat:other-chat":"以后再用",
    },
    "cq.dashboard.view.v1":{
      favorites:["chat:dialogue-a","chat:dialogue-b"],
      compact:true,focus:true,layout:"list",
    },
  },{structuredStorage:true});
  await env.send("ENQUEUE",{text:"将要明确放弃的旧待办"},11);
  env.closeTab(11);
  const removed=await env.sendDashboard("DASHBOARD_REMOVE_CONVERSATION",{
    key:"chat:dialogue-a",confirm:true,discardWork:true,
    confirmKey:"chat:dialogue-a",
  });
  assert.equal(removed.ok,true);
  assert.deepEqual(env.stored["cq.dashboard.aliases.v1"],{
    "chat:dialogue-b":"战斗机制",
    "chat:other-chat":"以后再用",
  });
  assert.equal(env.stored["cq.dashboard.view.v1"].layout,"list");
  assert.equal(env.stored["cq.dashboard.view.v1"].focus,true);
  assert.deepEqual(env.stored["cq.dashboard.view.v1"].favorites,["chat:dialogue-b"]);
});

test("管理中心：批量清理隐藏空会话时也清理对应别名", async () => {
  const env=await harness({
    "cq.dashboard.aliases.v1":{
      "chat:dialogue-a":"空闲旧聊天",
      "chat:dialogue-b":"有效聊天",
    },
  },{structuredStorage:true});
  const {state}=await env.send("ENQUEUE",{text:"完成后留下的历史"},11);
  await env.send("DELETE_TASK",{id:state.tasks[0].id},11);
  await env.send("ENQUEUE",{text:"待发送，需要保留"},12);
  env.closeTab(11);
  const result=await env.sendDashboard("DASHBOARD_CLEANUP_IDLE",{confirm:true});
  assert.equal(result.ok,true);
  assert.equal(result.removedCount,1);
  assert.deepEqual(env.stored["cq.dashboard.aliases.v1"],{
    "chat:dialogue-b":"有效聊天",
  });
  assert.equal((await env.send("GET",{},12)).state.tasks.length,1);
});

test("管理中心：手动移除对话时清理项目标签但保留其他项目、备注和偏好", async () => {
  const env=await harness({
    "cq.dashboard.projects.v1":{
      "chat:dialogue-a":"Aetherwild",
      "chat:dialogue-b":"Aetherwild",
      "chat:other-chat":"工具开发",
    },
    "cq.dashboard.aliases.v1":{
      "chat:dialogue-a":"主线剧情",
      "chat:dialogue-b":"战斗系统",
    },
    "cq.dashboard.view.v1":{
      favorites:["chat:dialogue-a","chat:dialogue-b"],
      grouped:false,projectGrouped:true,layout:"list",
    },
  },{structuredStorage:true});
  await env.send("ENQUEUE",{text:"待放弃的历史队列"},11);
  await env.send("ENQUEUE",{text:"必须保留的队列"},12);
  env.closeTab(11);
  const removed=await env.sendDashboard("DASHBOARD_REMOVE_CONVERSATION",{
    key:"chat:dialogue-a",confirm:true,discardWork:true,
    confirmKey:"chat:dialogue-a",
  });
  assert.equal(removed.ok,true);
  assert.deepEqual(env.stored["cq.dashboard.projects.v1"],{
    "chat:dialogue-b":"Aetherwild",
    "chat:other-chat":"工具开发",
  });
  assert.deepEqual(env.stored["cq.dashboard.aliases.v1"],{"chat:dialogue-b":"战斗系统"});
  assert.equal(env.stored["cq.dashboard.view.v1"].projectGrouped,true);
  assert.equal((await env.send("GET",{},12)).state.tasks.length,1);
});

test("管理中心：批量清理隐藏空记录时也移除对应项目，保留有效项目", async () => {
  const env=await harness({
    "cq.dashboard.projects.v1":{
      "chat:dialogue-a":"过期项目",
      "chat:dialogue-b":"仍在使用",
    },
  },{structuredStorage:true});
  const added=await env.send("ENQUEUE",{text:"空会话历史"},11);
  await env.send("DELETE_TASK",{id:added.state.tasks[0].id},11);
  await env.send("ENQUEUE",{text:"需要保留的任务"},12);
  env.closeTab(11);
  const reply=await env.sendDashboard("DASHBOARD_CLEANUP_IDLE",{confirm:true});
  assert.equal(reply.ok,true);
  assert.equal(reply.removedCount,1);
  assert.deepEqual(env.stored["cq.dashboard.projects.v1"],{
    "chat:dialogue-b":"仍在使用",
  });
});

test("管理中心：仅被移除会话引用的图文原件在保存成功后被清理", async () => {
  const env=await harness({}, {structuredStorage:true});
  const saved=await env.send("ENQUEUE",{text:"待清理图片",images:[testImage]},11);
  const imageId=saved.state.tasks[0].images[0].id;
  env.closeTab(11);
  const removeArgs={
    key:"chat:dialogue-a",confirm:true,discardWork:true,confirmKey:"chat:dialogue-a",
  };
  env.failNextWrite();
  const failed=await env.sendDashboard("DASHBOARD_REMOVE_CONVERSATION",removeArgs);
  assert.equal(failed.ok,false);
  assert.equal(env.storedImages.has(imageId),true);
  assert.equal(Object.hasOwn(env.stored["cq.state.v2"].conversations,"chat:dialogue-a"),true,
    "持久化失败时不能清理原图，也不能假报已删除");
  const completed=await env.sendDashboard("DASHBOARD_REMOVE_CONVERSATION",removeArgs);
  assert.equal(completed.ok,true);
  assert.equal(env.storedImages.has(imageId),false);
});

test("管理中心：清理前必须核实标签和调用者，参数无效时不会改变本地记录", async () => {
  const env=await harness();
  await env.send("ENQUEUE",{text:"仍在运行的待发送队列"},11);
  const key="chat:dialogue-a";
  const initial=JSON.stringify(env.stored["cq.state.v2"]);
  for (const args of [
    {key,confirm:false}, {key,confirm:"true"},
    {key:"__proto__",confirm:true},
    {key:"chat:a;bad",confirm:true}, {key:"draft:1.2",confirm:true},
    {key:"chat:missing",confirm:true}, {key,confirm:true,discardWork:true},
    {key,confirm:true,discardWork:true,confirmKey:key},
  ]) {
    assert.equal((await env.sendDashboard("DASHBOARD_REMOVE_CONVERSATION",args)).ok,false);
  }
  assert.equal((await env.sendDashboard("DASHBOARD_REMOVE_CONVERSATION",{
    key,confirm:true,discardWork:true,confirmKey:key,
  },{url:A,tab:{id:11}})).ok,false);
  assert.equal((await env.sendDashboard("DASHBOARD_CLEANUP_IDLE",{
    confirm:true,
  },{url:"chrome-extension://other-extension/dashboard.html"})).ok,false);
  env.setTabQueryFailure(true);
  assert.equal((await env.sendDashboard("DASHBOARD_CLEANUP_IDLE",{confirm:true})).ok,false);
  assert.equal((await env.sendDashboard("DASHBOARD_REMOVE_CONVERSATION",{
    key,confirm:true,discardWork:true,confirmKey:key,
  })).ok,false);
  assert.equal(JSON.stringify(env.stored["cq.state.v2"]),initial);
});

test("管理中心：清理打开的空记录不会关闭标签或删除 ChatGPT 官方对话", async () => {
  const env=await harness();
  await env.send("ENQUEUE",{text:"空会话历史"},11);
  const task=(await env.send("GET",{},11)).state.tasks[0];
  await env.send("DELETE_TASK",{id:task.id},11);
  const result=await env.sendDashboard("DASHBOARD_REMOVE_CONVERSATION",{
    key:"chat:dialogue-a",confirm:true,
  });
  assert.equal(result.ok,true);
  assert.equal(env.tabs.has(11),true,"插件不得关闭或删除用户的 ChatGPT 标签");
  assert.equal((await env.send("HELLO",{},11)).ok,true);
  assert.equal(Object.hasOwn(env.stored["cq.state.v2"].conversations,"chat:dialogue-a"),false,
    "旧的空闲标签刷新状态不会重新写入无任务记录");
});

test("跨对话近期活动只公开最近 5 个白名单事件及时间，不透出任务 ID、正文或异常详情", async () => {
  const env = await harness();
  await env.send("ENQUEUE",{text:"需要隐藏的完整提示词"},11);
  const state = env.stored["cq.state.v2"].conversations["chat:dialogue-a"];
  const at = state.history[0].at;
  state.history = [
    {type:"manual_enqueue",at,taskId:"hidden-task-identifier",text:"私密提示词"},
    {type:"send_failed",at:at+1000,error:"秘密错误详情"},
    {type:"sneaky: private prompt",at:at+2000,secret:"不要显示"},
    {type:"claim",at:at+3000,taskId:"hidden-next"},
    {type:"finished",at:at+4000,image:"private-image-data"},
    {type:"task_edited",at:at+5000,raw:"hidden-edit"},
    {type:"queue_paused",at:at+6000},
    {type:"unknown",at:at+7000},
    {type:"sent",at:"malformed timestamp"},
  ];
  const response = await env.sendDashboard("DASHBOARD_GET");
  assert.equal(response.ok,true);
  const item = response.dashboard.sessions.find((entry) => entry.key === "chat:dialogue-a");
  assert.deepEqual(Array.from(item.recentEvents,(entry)=>entry.type),[
    "queue_paused","task_edited","finished","claim","send_failed",
  ]);
  assert.ok(item.recentEvents.every((entry) =>
    Object.keys(entry).length===2 && Number.isFinite(entry.at)));
  for (const secret of [
    "需要隐藏的完整提示词", "hidden-task-identifier", "私密提示词",
    "秘密错误详情", "private-image-data", "hidden-edit", "不要显示",
    "sneaky: private prompt", "malformed timestamp",
  ]) {
    assert.equal(JSON.stringify(response).includes(secret),false);
  }
  assert.equal(JSON.stringify(env.stored["cq.state.v2"]).includes("秘密错误详情"),true,
    "仪表盘的数据最小化不能删除原始本地记录");
});

test("管理页只能暂停或恢复后续自动发送，不能解除异常隔离；两个对话互不干扰", async () => {
  const env=await harness();
  await env.send("ENQUEUE",{text:"A 队列待办"},11);
  await env.send("ENQUEUE",{text:"B 队列待办"},12);
  const paused=await env.sendDashboard("DASHBOARD_SET_PAUSED",{
    key:"chat:dialogue-a",paused:true,
  });
  assert.equal(paused.ok,true);
  assert.equal(paused.dashboard.sessions.find((item)=>item.key==="chat:dialogue-a").queuePaused,true);
  assert.equal((await env.send("GET",{},11)).state.queuePaused,true);
  assert.equal((await env.send("CLAIM",{ready:true},11)).dispatch,null);
  assert.equal((await env.send("CLAIM",{ready:true},12)).dispatch.text,"B 队列待办");
  const historyBefore=(await env.send("GET",{},11)).state.history.length;
  const unchanged=await env.sendDashboard("DASHBOARD_SET_PAUSED",{
    key:"chat:dialogue-a",paused:true,
  });
  assert.equal(unchanged.ok,true);
  assert.equal((await env.send("GET",{},11)).state.history.length,historyBefore,
    "重复暂停不应刷屏运行日志");
  const resumed=await env.sendDashboard("DASHBOARD_SET_PAUSED",{
    key:"chat:dialogue-a",paused:false,
  });
  assert.equal(resumed.ok,true);
  assert.equal((await env.send("CLAIM",{ready:true},11)).dispatch.text,"A 队列待办");

  const halted=await harness({
    "cq.state.v2":{version:2,legacyUnbound:null,conversations:{
      "chat:dialogue-a":{
        key:"chat:dialogue-a",url:A,tabId:11,
        halted:true,haltReason:"state_inconsistent",queuePaused:true,
        activeTaskId:null,steeringTaskId:null,
        tasks:[{id:"pending",text:"不可强制跳过的任务",status:"pending"}],
        schedules:[],history:[],
      },
    }},
  });
  const blocked=await halted.sendDashboard("DASHBOARD_SET_PAUSED",{
    key:"chat:dialogue-a",paused:false,
  });
  assert.equal(blocked.ok,false);
  assert.match(blocked.error,/核对/);
  assert.equal((await halted.send("GET")).state.queuePaused,true);
  assert.equal((await halted.send("GET")).state.halted,true);
  assert.equal((await halted.send("CLAIM",{ready:true})).dispatch,null);
});

test("跨对话管理接口拒绝普通内容脚本、伪造扩展页和非法参数，不创建不存在的会话", async () => {
  const env=await harness();
  await env.send("ENQUEUE",{text:"保留的第一条"},11);
  const outsider=await env.send("DASHBOARD_GET",{},11);
  assert.equal(outsider.ok,false);
  for (const sender of [
    {url:"https://chatgpt.com/c/dialogue-a"},
    {url:"chrome-extension://test-queue/popup.html"},
    {url:"chrome-extension://other-extension/dashboard.html"},
    {url:"chrome-extension://test-queue/dashboard.html",tab:{id:11}},
    {url:"chrome-extension://test-queue/dashboard.html?view=full",
      tab:{id:11,url:A}},
    {url:"chrome-extension://test-queue/dashboard.html?view=full&untrusted=1",
      tab:{id:11,url:"chrome-extension://test-queue/dashboard.html?view=full&untrusted=1"}},
  ]) {
    const result=await env.sendDashboard("DASHBOARD_SET_PAUSED",{
      key:"chat:dialogue-a",paused:true,
    },sender);
    assert.equal(result.ok,false);
    assert.match(result.error,/工具栏管理页/);
  }
  for (const args of [
    {key:"chat:dialogue-a",paused:1},
    {key:"chat:dialogue-a",paused:"false"},
    {key:"chat:missing-chat",paused:true},
    {key:"draft:11;dangerous",paused:true},
    {key:"__proto__",paused:true},
  ]) {
    assert.equal((await env.sendDashboard("DASHBOARD_SET_PAUSED",args)).ok,false);
  }
  assert.equal((await env.send("GET")).state.queuePaused,false);
  assert.equal((await env.send("GET")).state.tasks.length,1);
  assert.equal(Object.keys(env.stored["cq.state.v2"].conversations).length,1);
});

test("管理页包含已关闭但有工作或需核对的会话，隐藏完全空闲的旧会话", async () => {
  const env=await harness();
  await env.send("ENQUEUE",{text:"关闭标签后保留的工作"},11);
  await env.send("HELLO",{},12);
  await env.send("HELLO",{},13);
  await env.send("ENQUEUE",{text:"新对话也有待发送队列"},13);
  env.closeTab(11);
  env.closeTab(12);
  const list=(await env.sendDashboard("DASHBOARD_GET")).dashboard.sessions;
  assert.equal(list.some((item)=>item.key==="chat:dialogue-a" && item.browser==="closed"),true);
  assert.equal(list.some((item)=>item.key==="chat:dialogue-b"),false);
  assert.equal(list.some((item)=>item.key==="draft:13"),true);
});

test("列表紧凑视图按对话独立保存，刷新与后台重启后继续保留，不改变发送队列", async () => {
  const {send,stored}=await harness();
  await send("ENQUEUE",{text:"A 的待发送内容"},11);
  await send("ENQUEUE",{text:"B 的待发送内容"},12);
  const result=await send("SET_COMPACT_VIEW",{enabled:true},11);
  assert.equal(result.ok,true);
  assert.equal(result.state.compactView,true);
  assert.equal(result.state.tasks[0].text,"A 的待发送内容");
  assert.equal((await send("GET",{},12)).state.compactView,false);
  assert.equal((await send("CLAIM",{ready:true},11)).dispatch.text,"A 的待发送内容");
  assert.equal((await send("GET",{},11)).state.compactView,true);
  const reboot=await harness(structuredClone(stored));
  assert.equal((await reboot.send("HELLO",{},11)).state.compactView,true);
  assert.equal((await reboot.send("HELLO",{},12)).state.compactView,false);
  const changed=await reboot.send("SET_COMPACT_VIEW",{enabled:false},11);
  assert.equal(changed.state.compactView,false);
  assert.equal(changed.state.tasks.length,1);
});

test("列表外观不允许越权跨对话修改或传入错误参数，不添加发送日志", async () => {
  const {send}=await harness();
  await send("ENQUEUE",{text:"原任务"},11);
  const before=(await send("GET",{},11)).state.history.length;
  for (const enabled of [null,1,"true",{},[]]) {
    const result=await send("SET_COMPACT_VIEW",{enabled},11);
    assert.equal(result.ok,false);
  }
  assert.equal((await send("SET_COMPACT_VIEW",{enabled:true},12,A)).ok,false);
  assert.equal((await send("GET",{},11)).state.compactView,false);
  await send("SET_COMPACT_VIEW",{enabled:true},11);
  await send("SET_COMPACT_VIEW",{enabled:true},11);
  assert.equal((await send("GET",{},11)).state.history.length,before);
  assert.equal((await send("GET",{},11)).state.tasks.length,1);
});

test("插件版本更新自动刷新所有已打开的 ChatGPT 标签，但安装和同版本重载不触发", async () => {
  const env = await harness();
  await env.simulateExtensionUpdate("install", "0.18.0");
  await env.simulateExtensionUpdate("update", "0.19.0");
  await env.simulateExtensionUpdate("chrome_update", "0.18.0");
  assert.deepEqual(env.tabReloads, []);
  assert.equal(env.sessionStored["cq.updateRefresh.v1"], undefined);
  await env.simulateExtensionUpdate("update", "0.18.0");
  assert.deepEqual(env.tabReloads, [11, 12, 13]);
  assert.equal(env.updateProbes.length, 6, "每个页面在刷新前都必须复核两次");
  assert.ok(env.updateProbes.every((p) => p.func === "inspectUpdateRefreshSafety"));
  assert.equal(env.sessionStored["cq.updateRefresh.v1"], null);
  await env.retryVersionRefresh();
  assert.deepEqual(env.tabReloads, [11, 12, 13], "完成后不能发生循环刷新");
});

test("插件升级时有未发送文字、图片、生成中的页面应延后刷新，安全后才继续", async () => {
  const env = await harness();
  env.tabSafety.set(11, {safe:false,voiceReady:false,reason:"unsent_text"});
  env.tabSafety.set(12, {safe:false,voiceReady:false,reason:"attachments_or_upload"});
  env.tabSafety.set(13, {safe:false,voiceReady:false,reason:"generating"});
  await env.simulateExtensionUpdate();
  assert.deepEqual(env.tabReloads,[]);
  assert.deepEqual(Array.from(env.sessionStored["cq.updateRefresh.v1"].tabs,(t)=>t.id),
    [11,12,13]);

  env.tabSafety.set(11,{safe:true,voiceReady:true,reason:"idle"});
  await env.retryVersionRefresh();
  assert.deepEqual(env.tabReloads,[11]);
  assert.deepEqual(Array.from(env.sessionStored["cq.updateRefresh.v1"].tabs,(t)=>t.id),
    [12,13]);
  env.tabSafety.set(12,{safe:true,voiceReady:true,reason:"idle"});
  env.tabSafety.set(13,{safe:true,voiceReady:true,reason:"idle"});
  await env.retryVersionRefresh();
  assert.deepEqual(env.tabReloads,[11,12,13]);
  assert.equal(env.sessionStored["cq.updateRefresh.v1"],null);
});

test("升级安全检查必须连续两次通过；两次检查之间开始生成回复不能强制刷新", async () => {
  const env=await harness();
  env.tabSafety.set(11,(number)=>number===1
    ? {safe:true,voiceReady:true,reason:"idle"}
    : {safe:false,voiceReady:false,reason:"generating"});
  await env.simulateExtensionUpdate();
  assert.deepEqual(env.tabReloads,[12,13]);
  assert.equal(env.updateProbes.filter((item)=>item.tabId===11 &&
    item.func==="inspectUpdateRefreshSafety").length,2);
  assert.ok(env.updateProbes.some((item)=>item.tabId===11 &&
    item.func==="installDeferredTabSpinner"),"生成中的旧标签应补装临时状态指示器");
  env.tabSafety.set(11,{safe:true,voiceReady:true,reason:"idle"});
  await env.retryVersionRefresh();
  assert.deepEqual(env.tabReloads,[12,13,11]);
});

test("升级遇到执行中的队列时即便编辑框空也不能打断回复，需等原生 Voice Mode 返回", async () => {
  const env = await harness();
  await env.send("ENQUEUE",{text:"正在等待 ChatGPT 回复"});
  const claim=await env.send("CLAIM",{ready:true});
  await env.send("SENT",{id:claim.dispatch.id});
  env.tabSafety.set(11,{safe:true,voiceReady:false,reason:"idle"});
  await env.simulateExtensionUpdate();
  assert.equal(env.tabReloads.includes(11),false);
  assert.deepEqual(env.tabReloads,[12,13]);
  assert.equal((await env.send("GET")).state.tasks[0].status,"waiting");
  env.tabSafety.set(11,{safe:true,voiceReady:true,reason:"idle"});
  await env.retryVersionRefresh();
  assert.deepEqual(env.tabReloads,[12,13,11]);
  assert.equal((await env.send("GET")).state.tasks[0].status,"waiting",
    "刷新不会把执行中的任务重置为待发送");
});

test("注入安全检测失败或自动刷新失败时保留重试计划，不重复刷新其他标签", async () => {
  const env=await harness();
  env.failProbes.add(11);
  env.failedTabReloads.add(12);
  await env.simulateExtensionUpdate();
  assert.deepEqual(env.tabReloads,[13]);
  assert.deepEqual(Array.from(env.sessionStored["cq.updateRefresh.v1"].tabs,(t)=>t.id),
    [11,12]);
  env.failProbes.delete(11);
  env.failedTabReloads.delete(12);
  await env.retryVersionRefresh();
  assert.deepEqual(env.tabReloads,[13,11,12]);
  assert.equal(env.sessionStored["cq.updateRefresh.v1"],null);
});

test("扩展服务工作线程重启后仍能继续之前被草稿延后的版本刷新", async () => {
  const first=await harness();
  first.tabSafety.set(11,{safe:false,voiceReady:false,reason:"plugin_draft"});
  await first.simulateExtensionUpdate();
  assert.equal(first.tabReloads.includes(11),false);
  const resumed=await harness(structuredClone(first.stored),{
    initialSession:structuredClone(first.sessionStored),
  });
  assert.equal(resumed.sessionStored["cq.updateRefresh.v1"].tabs.length,1);
  await resumed.retryVersionRefresh();
  assert.deepEqual(resumed.tabReloads,[11]);
  assert.equal(resumed.sessionStored["cq.updateRefresh.v1"],null);
});

test("升级时仍在加载的标签等完成加载再刷新，不能强制打断导航", async () => {
  const env=await harness();
  env.tabs.get(11).status="loading";
  await env.simulateExtensionUpdate();
  assert.deepEqual(env.tabReloads,[12,13]);
  assert.deepEqual(Array.from(env.sessionStored["cq.updateRefresh.v1"].tabs,(item)=>item.id),[11]);
  env.tabs.get(11).status="complete";
  await env.retryVersionRefresh();
  assert.deepEqual(env.tabReloads,[12,13,11]);
  assert.equal(env.sessionStored["cq.updateRefresh.v1"],null);
});

test("插件升级时已关闭、导航离开 ChatGPT 或丢弃的标签不应被强制唤醒", async () => {
  const env=await harness();
  env.closeTab(11);
  env.navigate(12,"https://example.com");
  env.tabs.get(13).discarded=true;
  await env.simulateExtensionUpdate();
  assert.deepEqual(env.tabReloads,[]);
  assert.equal(env.sessionStored["cq.updateRefresh.v1"],null);
});

test("同一次手动入队的重复请求只保存一次，即使队列已满或浏览器重启", async () => {
  const {send,stored}=await harness();
  await send("SAVE_SETTINGS",{maxPending:1});
  const requestId="00000000-0000-4000-8000-000000000001";
  const first=await send("ENQUEUE",{text:"一次提交",requestId});
  assert.equal(first.ok,true);
  assert.equal(first.state.tasks.length,1);
  const second=await send("ENQUEUE",{text:"一次提交",requestId});
  assert.equal(second.ok,true,"重复确认不应被队列已满阻挡");
  assert.equal(second.state.tasks.length,1);
  assert.equal(second.state.tasks[0].id,first.state.tasks[0].id);
  assert.equal(second.state.history.filter((entry) => entry.type==="manual_enqueue").length,1);
  assert.equal(second.state.recentSubmissions.length,1);
  assert.equal((await send("ENQUEUE",{text:"另一次独立提交",
    requestId:"00000000-0000-4000-8000-000000000002"})).ok,false);

  const restarted=await harness(structuredClone(stored));
  assert.equal((await restarted.send("ENQUEUE",{text:"一次提交",requestId})).state.tasks.length,1);
  await restarted.send("DELETE_TASK",{id:first.state.tasks[0].id});
  const retry=await restarted.send("ENQUEUE",{text:"一次提交",requestId});
  assert.equal(retry.state.tasks.length,0,
    "队列任务被处理或删除后，迟到的旧请求仍不应恢复已结束任务");
  const newIntent=await restarted.send("ENQUEUE",{
    text:"一次提交",requestId:"00000000-0000-4000-8000-000000000003",
  });
  assert.equal(newIntent.state.tasks.length,1);
});

test("自动任务创建的重试不生成第二个规则，也不重置原有执行次数", async () => {
  const {send,stored}=await harness();
  const requestId="00000000-0000-4000-8000-000000000010";
  const args={text:"自动巡检",mode:"time",intervalMinutes:1,repeatCount:1,requestId};
  const first=await send("ADD_SCHEDULE",args);
  assert.equal(first.ok,true);
  const scheduleId=first.state.schedules[0].id;
  const duplicated=await send("ADD_SCHEDULE",args);
  assert.equal(duplicated.ok,true);
  assert.equal(duplicated.state.schedules.length,1);
  assert.equal(duplicated.state.schedules[0].id,scheduleId);
  const restored=await harness(structuredClone(stored));
  restored.advance(60);
  const once=await restored.send("SCHEDULE_PULSE");
  assert.equal(once.state.schedules[0].runCount,1);
  const retry=await restored.send("ADD_SCHEDULE",args);
  assert.equal(retry.ok,true);
  assert.equal(retry.state.schedules.length,1);
  assert.equal(retry.state.schedules[0].runCount,1);
  assert.equal(retry.state.tasks.length,1);
  assert.equal(retry.state.history.filter((entry) => entry.type==="schedule_added").length,1);
});

test("提交去重只限当前对话、有限期和有限容量；没有提交标识的老版本照常使用", async () => {
  const {send,advance}=await harness();
  const shared="00000000-0000-4000-8000-000000000020";
  const a=await send("ENQUEUE",{text:"A",requestId:shared},11);
  const b=await send("ENQUEUE",{text:"B",requestId:shared},12);
  assert.equal(a.state.tasks.length,1);
  assert.equal(b.state.tasks.length,1);
  assert.equal((await send("ENQUEUE",{text:"A 的第二条"})).state.tasks.length,2);
  assert.equal((await send("ENQUEUE",{text:"A 的第三条"})).state.tasks.length,3);
  for (const invalid of ["oops",123,{},null]) {
    if (invalid===null) continue; // null indicates old callers without a request ID.
    const result=await send("ENQUEUE",{text:"非法",requestId:invalid});
    assert.equal(result.ok,false);
  }
  const validCount=130;
  for (let index=0;index<validCount;index++) {
    const id="00000000-0000-4000-8000-"+String(index+100).padStart(12,"0");
    const result=await send("ADD_SCHEDULE",{
      text:"规则"+index,mode:"time",intervalMinutes:525600,requestId:id,
    });
    assert.equal(result.ok,true);
  }
  const recent=(await send("GET")).state.recentSubmissions;
  assert.equal(recent.length,128);
  assert.equal(recent.at(-1).id,"00000000-0000-4000-8000-000000000229");
  const before=(await send("GET")).state.tasks.length;
  assert.equal((await send("ENQUEUE",{text:"B",requestId:shared},12)).state.tasks.length,1);
  advance(24*60*60+1);
  const later=await send("ENQUEUE",{text:"A 的全新尝试",requestId:shared},11);
  assert.equal(later.state.tasks.length,before+1);
});

test("同一个提交标识意外重用于不同提示词、不同图片或不同操作时，必须明确拒绝而不能静默丢内容", async () => {
  const {send,storedImages}=await harness();
  const requestId="20000000-0000-4000-8000-000000000011";
  const first=await send("ENQUEUE", {
    text:"截图 A",images:[testImage],requestId,
  });
  assert.equal(first.ok,true);
  assert.match(first.state.recentSubmissions[0].fingerprint,/^[0-9a-f]{64}$/);
  const pictureId=first.state.tasks[0].images[0].id;
  for (const [type,params] of [
    ["ENQUEUE",{text:"截图 B",images:[testImage],requestId}],
    ["ENQUEUE",{text:"截图 A",images:[{...testImage,name:"另一张图.png"}],requestId}],
    ["ADD_TASK",{text:"截图 A",images:[testImage],requestId}],
    ["ADD_SCHEDULE",{text:"截图 A",images:[testImage],
      intervalMinutes:1,requestId}],
  ]) {
    const rejected=await send(type,params);
    assert.equal(rejected.ok,false);
    assert.match(rejected.error,/重复提交标识/);
    assert.equal((await send("GET")).state.tasks.length,1);
    assert.equal((await send("GET")).state.schedules.length,0);
    assert.equal(storedImages.size,1);
    assert.ok(storedImages.has(pictureId));
  }
  const same=await send("ENQUEUE",{text:"截图 A",images:[testImage],requestId});
  assert.equal(same.ok,true);
  assert.equal(same.state.tasks[0].id,first.state.tasks[0].id);
});

test("新图片已写入 IndexedDB 但队列持久化失败时回滚孤立图片，不影响已有任务", async () => {
  const {send,stored,storedImages,failNextWrite}=
    await harness({}, {structuredStorage:true});
  await send("HELLO");
  const existing=await send("ENQUEUE",{text:"原任务",images:[testImage]});
  assert.equal(existing.ok,true);
  const oldTask=existing.state.tasks[0];
  const oldImageId=oldTask.images[0].id;
  const before=JSON.stringify(stored["cq.state.v2"]);
  failNextWrite("before");
  const failed=await send("ENQUEUE",{
    text:"保存失败的图文任务",images:[testImage],
    requestId:"30000000-0000-4000-8000-000000000001",
  });
  assert.equal(failed.ok,false);
  assert.match(failed.error,/storage write failure/);
  assert.equal(JSON.stringify(stored["cq.state.v2"]),before);
  assert.equal(storedImages.size,1,"没有存档引用的新增图片应该立即清理");
  assert.ok(storedImages.has(oldImageId));

  failNextWrite("before");
  const edited=await send("EDIT_TASK", {
    id:oldTask.id,text:"编辑未保存",keepImageIds:[oldImageId],
    images:[{...testImage,name:"新增图片.png"}],
  });
  assert.equal(edited.ok,false);
  assert.equal((await send("GET")).state.tasks[0].text,"原任务");
  assert.equal(storedImages.size,1);
  assert.ok(storedImages.has(oldImageId));
});

test("存储实际上写入成功但响应报错时不能清除已经被队列引用的原图，重试保持幂等", async () => {
  const {send,storedImages,failNextWrite}=
    await harness({}, {structuredStorage:true});
  await send("HELLO");
  const requestId="30000000-0000-4000-8000-000000000002";
  failNextWrite("after");
  const uncertain=await send("ENQUEUE",{
    text:"存储实际上已经保存",images:[testImage],requestId,
  });
  assert.equal(uncertain.ok,false);
  const saved=(await send("GET")).state;
  assert.equal(saved.tasks.length,1);
  assert.equal(storedImages.size,1);
  assert.ok(storedImages.has(saved.tasks[0].images[0].id),
    "实际已持久化的图片引用不能因响应异常被删除");
  const retried=await send("ENQUEUE",{
    text:"存储实际上已经保存",images:[testImage],requestId,
  });
  assert.equal(retried.ok,true);
  assert.equal(retried.state.tasks.length,1);
  assert.equal(retried.state.tasks[0].id,saved.tasks[0].id);
  assert.equal(storedImages.size,1);
});

test("图文自动规则和旧式整包备份恢复在存储提交失败时不留下孤立原图", async () => {
  const source=await harness();
  await source.send("ENQUEUE",{text:"备份原图",images:[testImage]});
  const backup=(await source.send("GET_BACKUP")).backup;
  const {send,storedImages,failNextWrite}=
    await harness({}, {structuredStorage:true});
  await send("HELLO");
  failNextWrite("before");
  const rule=await send("ADD_SCHEDULE",{
    text:"定时看图",mode:"time",intervalMinutes:5,
    images:[testImage],requestId:"30000000-0000-4000-8000-000000000003",
  });
  assert.equal(rule.ok,false);
  assert.equal((await send("GET")).state.schedules.length,0);
  assert.equal(storedImages.size,0);

  failNextWrite("before");
  const restored=await send("RESTORE_BACKUP",{backup});
  assert.equal(restored.ok,false);
  assert.equal((await send("GET")).state.tasks.length,0);
  assert.equal(storedImages.size,0);

  const successful=await send("RESTORE_BACKUP",{backup});
  assert.equal(successful.ok,true);
  assert.equal(successful.state.queuePaused,true);
  assert.equal(successful.state.tasks.length,1);
  assert.equal(storedImages.size,1);
});

test("发现未来存档版本或损坏数据时拒绝初始化，不覆写队列、不清理原图", async () => {
  const badStores = [
    { version: 3, conversations: {}, settings: { maxPending: 1 } },
    { version: 2, conversations: null },
    { version: 2, conversations: [] },
    { version: 2, conversations: {
      "chat:dialogue-a": { key: "chat:dialogue-a", tasks: [], schedules: null },
    } },
  ];
  for (const future of badStores) {
    const { send, tick, navigate, closeTab, stored, storedImages } = await harness({
      "cq.state.v2": future,
    });
    const snapshot = JSON.stringify(stored["cq.state.v2"]);
    storedImages.set("keep-original", { id: "keep-original", dataUrl: testImage.dataUrl });
    const result = await send("GET");
    assert.equal(result.ok, false);
    assert.match(result.error, /不兼容或损坏/);
    assert.equal((await send("ENQUEUE", { text: "不允许覆盖" })).ok, false);
    await tick(1);
    navigate(11,B);
    closeTab(11);
    await tick(1);
    assert.equal(JSON.stringify(stored["cq.state.v2"]), snapshot);
    assert.ok(storedImages.has("keep-original"), "异常存档不能触发原图清理");
  }
});

test("图片传输按单张待办引用授权，拒绝跨对话、其他任务及元数据不符", async () => {
  const { send, storedImages } = await harness();
  const queued = await send("ENQUEUE", {
    text: "带图片的待办", images: [testImage],
  });
  const reference = queued.state.tasks[0].images[0];
  const claim = await send("CLAIM", { ready: true });
  assert.equal((await send("GET_TASK_IMAGE", {
    id: claim.dispatch.id, imageId: "not-related",
  })).ok, false);
  assert.equal((await send("GET_TASK_IMAGE", {
    id: claim.dispatch.id, imageId: reference.id,
  }, 12, A)).ok, false);
  assert.equal((await send("GET_TASK_IMAGE", {
    id: "someone-else", imageId: reference.id,
  })).ok, false);
  const obtained = await send("GET_TASK_IMAGE", {
    id: claim.dispatch.id, imageId: reference.id,
  });
  assert.equal(obtained.ok, true);
  assert.equal(obtained.images.length, 1);
  assert.equal(obtained.images[0].dataUrl, testImage.dataUrl);
  const original = storedImages.get(reference.id);
  storedImages.set(reference.id, { ...original, name: "wrong-original.png" });
  assert.equal((await send("GET_TASK_IMAGE", {
    id: claim.dispatch.id, imageId: reference.id,
  })).ok, false);
  storedImages.delete(reference.id);
  assert.equal((await send("GET_TASK_IMAGE", {
    id: claim.dispatch.id, imageId: reference.id,
  })).ok, false);
  assert.equal((await send("GET")).state.tasks[0].status, "dispatching");
  assert.equal((await send("SENT", { id: claim.dispatch.id })).ok, true);
  assert.equal((await send("GET_TASK_IMAGE", {
    id: claim.dispatch.id, imageId: reference.id,
  })).ok, false);
});

test("存储图片内容损坏但文件 ID 和元数据仍相同时，不可发送或导出不完整备份", async () => {
  const { send, storedImages } = await harness();
  const queued = await send("ENQUEUE", {
    text: "原图可能已损坏", images: [testImage],
  });
  const imageRef = queued.state.tasks[0].images[0];
  const original = storedImages.get(imageRef.id);
  storedImages.set(imageRef.id, {
    ...original,
    dataUrl: "data:image/png;base64,YWJj", // Broken signature, but original metadata retained.
  });
  assert.equal((await send("GET_BACKUP_IMAGE", { imageId:imageRef.id })).ok, false);
  assert.equal((await send("GET_BACKUP")).ok, false);
  const claim = await send("CLAIM", {ready:true});
  assert.ok(claim.dispatch);
  assert.equal((await send("GET_TASK_IMAGE", {
    id:claim.dispatch.id,imageId:imageRef.id,
  })).ok, false);
  assert.equal((await send("GET_TASK_IMAGES", {id:claim.dispatch.id})).ok, false);
  assert.equal((await send("GET")).state.tasks[0].status, "dispatching");
  storedImages.set(imageRef.id, original);
  const image = await send("GET_TASK_IMAGE", {
    id:claim.dispatch.id,imageId:imageRef.id,
  });
  assert.equal(image.ok, true);
  assert.equal(image.images[0].dataUrl, testImage.dataUrl);
});

test("本对话图片自检只报告缺失引用，不修改队列或其他对话，也不暴露原图", async () => {
  const { send, storedImages, stored } = await harness();
  const queued = await send("ENQUEUE", { text: "分析截图", images: [testImage] }, 11);
  const schedule = await send("ADD_SCHEDULE", {
    text: "定时图片", intervalMinutes: 30, images: [testImage],
  }, 11);
  await send("ENQUEUE", { text: "B 的截图", images: [testImage] }, 12);
  const before = JSON.stringify(stored["cq.state.v2"]);
  const healthy = await send("CHECK_QUEUE_IMAGES", {}, 11);
  assert.equal(healthy.ok, true);
  assert.deepEqual(JSON.parse(JSON.stringify(healthy.imageHealth)), {
    total: 2, missing: 0, affectedTasks: 0, affectedRules: 0,
  });
  assert.equal(JSON.stringify(healthy).includes(testImage.dataUrl), false);
  assert.equal(JSON.stringify(stored["cq.state.v2"]), before);
  const taskImageId = queued.state.tasks[0].images[0].id;
  const ruleImageId = schedule.state.schedules[0].images[0].id;
  storedImages.delete(taskImageId);
  storedImages.delete(ruleImageId);
  const missing = await send("CHECK_QUEUE_IMAGES", {}, 11);
  assert.deepEqual(JSON.parse(JSON.stringify(missing.imageHealth)), {
    total: 2, missing: 2, affectedTasks: 1, affectedRules: 1,
  });
  const b = await send("CHECK_QUEUE_IMAGES", {}, 12);
  assert.equal(b.imageHealth.total, 1);
  assert.equal(b.imageHealth.missing, 0);
  assert.equal((await send("CHECK_QUEUE_IMAGES", {}, 12, A)).ok, false);
  const plain = await harness();
  assert.equal((await plain.send("CHECK_QUEUE_IMAGES")).imageHealth.total, 0);
});

test("图文备份完整包含图片原图，导出为只读操作", async () => {
  const { send, stored, storedImages } = await harness();
  await send("ENQUEUE", { text: "图片说明", images: [testImage] });
  await send("ADD_SCHEDULE", {
    text: "反复审图", images: [testImage], mode: "time",
    intervalMinutes: 30, repeatCount: 2,
  });
  const beforeState = structuredClone(stored["cq.state.v2"]);
  const result = await send("GET_BACKUP");
  assert.equal(result.ok, true);
  assert.equal(result.backup.format, "chatgpt-taskqueue-conversation");
  assert.equal(result.backup.version, 1);
  assert.equal(result.backup.conversation.key, "chat:dialogue-a");
  assert.equal(result.backup.conversation.tasks.length, 1);
  assert.equal(result.backup.conversation.schedules.length, 1);
  assert.equal(result.backup.images.length, 2);
  assert.ok(result.backup.images.every((image) => image.dataUrl === testImage.dataUrl));
  assert.equal(result.backup.conversation.tasks[0].images[0].dataUrl, undefined);
  assert.equal(result.backup.conversation.schedules[0].repeatCount, 2);
  assert.equal(storedImages.size, 2);
  assert.equal(JSON.stringify(stored["cq.state.v2"]), JSON.stringify(beforeState));
});

test("分段导出只返回轻量清单，4 张原图分别读取并防止跨对话访问", async () => {
  const {send, stored, storedImages} = await harness();
  const images = ["第一", "第二", "第三", "第四"].map((name) => ({
    ...testImage, name: name + ".png",
  }));
  await send("ENQUEUE", {text:"四图队列",images});
  const before = JSON.stringify(stored["cq.state.v2"]);
  const manifest = await send("GET_BACKUP_META");
  assert.equal(manifest.ok, true);
  assert.equal(manifest.backup.images.length, 4);
  assert.equal(manifest.backup.conversation.tasks.length, 1);
  assert.equal(manifest.backup.conversation.tasks[0].images.length, 4);
  assert.equal(manifest.backup.conversation.tasks[0].images[0].thumbnail, undefined);
  assert.equal(JSON.stringify(manifest.backup).includes(testImage.dataUrl), false);
  for (const reference of manifest.backup.images) {
    const result = await send("GET_BACKUP_IMAGE", {imageId:reference.id});
    assert.equal(result.ok, true);
    assert.equal(result.images.length, 1);
    assert.equal(result.images[0].name, reference.name);
    assert.equal(result.images[0].dataUrl, testImage.dataUrl);
  }
  assert.equal((await send("GET_BACKUP_IMAGE", {imageId:"other-image"})).ok, false);
  assert.equal((await send("GET_BACKUP_IMAGE", {
    imageId:manifest.backup.images[0].id,
  }, 12, A)).ok, false);
  const removed = manifest.backup.images[1];
  storedImages.delete(removed.id);
  assert.equal((await send("GET_BACKUP_META")).ok, false);
  assert.equal((await send("GET_BACKUP_IMAGE", {imageId:removed.id})).ok, false);
  assert.equal(JSON.stringify(stored["cq.state.v2"]), before);
});

test("新备份携带 SHA-256：同样大小的图片内容被篡改也必须拒绝恢复", async () => {
  const source = await harness();
  await source.send("ENQUEUE", {text:"原图完整性",images:[testImage]});
  const manifest = (await source.send("GET_BACKUP_META")).backup;
  const image = (await source.send("GET_BACKUP_IMAGE", {
    imageId:manifest.images[0].id,
  })).images[0];
  const expectedHash = createHash("sha256").update(testImage.dataUrl).digest("hex");
  assert.equal(image.sha256, expectedHash);
  assert.match(image.sha256, /^[0-9a-f]{64}$/);
  manifest.images[0].sha256 = image.sha256;

  const destination = await harness();
  const begin = await destination.send("RESTORE_BACKUP_BEGIN", {backup:manifest});
  assert.equal(begin.ok, true);
  const token = begin.backup.token;
  const index = image.dataUrl.length - 9;
  const changedCharacter = image.dataUrl[index] === "A" ? "B" : "A";
  const corrupted = {
    ...image,
    dataUrl:image.dataUrl.slice(0,index) + changedCharacter + image.dataUrl.slice(index+1),
  };
  assert.equal(corrupted.dataUrl.length, image.dataUrl.length);
  assert.notEqual(corrupted.dataUrl, image.dataUrl);
  const rejected = await destination.send("RESTORE_BACKUP_IMAGE", {token,image:corrupted});
  assert.equal(rejected.ok, false);
  assert.match(rejected.error, /SHA-256/);
  assert.equal(destination.storedImages.size, 0);
  assert.equal((await destination.send("GET")).state.tasks.length, 0);
  assert.equal((await destination.send("RESTORE_BACKUP_IMAGE", {token,image})).ok, true);
  const finished = await destination.send("RESTORE_BACKUP_FINISH", {token});
  assert.equal(finished.ok, true);
  assert.equal(finished.state.queuePaused, true);
  assert.equal(finished.state.tasks.length, 1);
});

test("旧版不含 SHA-256 的 JSON 仍可恢复，非法哈希和非法任务预先拒绝", async () => {
  const source = await harness();
  await source.send("ENQUEUE", {text:"旧版格式",images:[testImage]});
  const oldManifest = (await source.send("GET_BACKUP_META")).backup;
  const image = (await source.send("GET_BACKUP_IMAGE", {
    imageId:oldManifest.images[0].id,
  })).images[0];
  const target = await harness();

  for (const bad of [
    {...oldManifest,images:[{...oldManifest.images[0],sha256:"abc"}]},
    {...oldManifest,conversation:{...oldManifest.conversation,
      tasks:[{...oldManifest.conversation.tasks[0],status:"unknown"}]}},
    {...oldManifest,conversation:{...oldManifest.conversation,
      tasks:[{...oldManifest.conversation.tasks[0],images:[{id:"missing"}]}]}},
    {...oldManifest,conversation:{...oldManifest.conversation,
      tasks:[{...oldManifest.conversation.tasks[0],text:"x".repeat(12_001)}]}},
    {...oldManifest,images:[]},
  ]) {
    const rejected = await target.send("RESTORE_BACKUP_BEGIN", {backup:bad});
    assert.equal(rejected.ok, false);
    assert.equal((await target.send("GET")).state.tasks.length, 0);
    assert.equal(target.storedImages.size, 0);
  }
  const begin = await target.send("RESTORE_BACKUP_BEGIN", {backup:oldManifest});
  assert.equal(begin.ok, true); // No checksum was required for old backup files.
  assert.equal((await target.send("RESTORE_BACKUP_IMAGE", {
    token:begin.backup.token,image:{...image,sha256:undefined},
  })).ok, true);
  const result = await target.send("RESTORE_BACKUP_FINISH", {token:begin.backup.token});
  assert.equal(result.ok, true);
  assert.equal(result.state.tasks[0].text, "旧版格式");
});

test("分段恢复先存原图后提交队列，两次引用相同的图片映射一致，恢复后暂停", async () => {
  const source = await harness();
  await source.send("ENQUEUE", {text:"图文任务",images:[testImage]});
  const added = await source.send("ADD_SCHEDULE", {
    text:"自动图文",images:[testImage],intervalMinutes:7,repeatCount:3,
  });
  assert.equal(added.ok, true);
  const manifest = (await source.send("GET_BACKUP_META")).backup;
  assert.equal(manifest.images.length, 2);

  const target = await harness();
  const started = await target.send("RESTORE_BACKUP_BEGIN", {backup:manifest});
  assert.equal(started.ok, true);
  assert.ok(started.backup.token);
  assert.equal((await target.send("GET")).state.tasks.length, 0);
  const token = started.backup.token;
  for (const ref of manifest.images) {
    const original = (await source.send("GET_BACKUP_IMAGE", {imageId:ref.id})).images[0];
    const uploaded = await target.send("RESTORE_BACKUP_IMAGE", {token,image:original});
    assert.equal(uploaded.ok, true);
    assert.equal((await target.send("GET")).state.tasks.length, 0);
  }
  assert.equal(target.storedImages.size, 2);
  const result = await target.send("RESTORE_BACKUP_FINISH", {token});
  assert.equal(result.ok, true);
  const restored = result.state;
  assert.equal(restored.queuePaused, true);
  assert.equal(restored.tasks.length, 1);
  assert.equal(restored.tasks[0].status, "pending");
  assert.equal(restored.schedules.length, 1);
  assert.equal(restored.schedules[0].enabled, false);
  assert.equal(restored.schedules[0].repeatCount, 3);
  assert.notEqual(restored.tasks[0].images[0].id, manifest.images[0].id);
  assert.notEqual(restored.schedules[0].images[0].id, manifest.images[1].id);
  assert.equal((await target.send("CLAIM", {ready:true})).dispatch, null);
  assert.equal((await target.send("RESTORE_BACKUP_FINISH", {token})).ok, false);
  assert.equal((await target.send("RESTORE_BACKUP_ABORT", {token})).ok, true);
  assert.equal(target.storedImages.size, 2);
});

test("不完整、篡改、重复或跨会话图片不允许分段恢复提交", async () => {
  const source = await harness();
  await source.send("ENQUEUE", {
    text:"两张图片",images:[testImage,{...testImage,name:"另一张.png"}],
  });
  const meta = (await source.send("GET_BACKUP_META")).backup;
  const target = await harness();
  const started = await target.send("RESTORE_BACKUP_BEGIN", {backup:meta});
  const token = started.backup.token;
  assert.equal((await target.send("RESTORE_BACKUP_FINISH", {token})).ok, false);
  assert.equal((await target.send("RESTORE_BACKUP_IMAGE", {
    token, image:{...testImage,id:"undeclared"},
  })).ok, false);
  assert.equal((await target.send("RESTORE_BACKUP_IMAGE", {
    token, image:{...testImage,id:meta.images[0].id,name:"wrong.png"},
  })).ok, false);
  const first = (await source.send("GET_BACKUP_IMAGE", {
    imageId:meta.images[0].id,
  })).images[0];
  assert.equal((await target.send("RESTORE_BACKUP_IMAGE", {token,image:first})).ok, true);
  assert.equal((await target.send("RESTORE_BACKUP_IMAGE", {token,image:first})).ok, false);
  assert.equal((await target.send("RESTORE_BACKUP_IMAGE", {
    token,image:first,
  }, 12, A)).ok, false);
  assert.equal((await target.send("RESTORE_BACKUP_FINISH", {token})).ok, false);
  assert.equal((await target.send("GET")).state.tasks.length, 0);
  assert.equal(target.storedImages.size, 1);
  const other = (await source.send("GET_BACKUP_IMAGE", {
    imageId:meta.images[1].id,
  })).images[0];
  assert.equal((await target.send("RESTORE_BACKUP_IMAGE", {token,image:other})).ok, true);
  target.storedImages.delete([...target.storedImages.keys()][0]);
  assert.equal((await target.send("RESTORE_BACKUP_FINISH", {token})).ok, false);
  assert.equal((await target.send("GET")).state.tasks.length, 0);
  assert.equal((await target.send("RESTORE_BACKUP_ABORT", {token})).ok, true);
  assert.equal(target.storedImages.size, 0);
});

test("暂存原图不会被其他对话清理；取消和超时会清除暂存但不动现有任务", async () => {
  const source = await harness();
  await source.send("ENQUEUE", {text:"图片",images:[testImage]});
  const manifest = (await source.send("GET_BACKUP_META")).backup;
  const picture = (await source.send("GET_BACKUP_IMAGE", {
    imageId:manifest.images[0].id,
  })).images[0];
  const target = await harness();
  const first = await target.send("RESTORE_BACKUP_BEGIN", {backup:manifest});
  await target.send("RESTORE_BACKUP_IMAGE", {token:first.backup.token,image:picture});
  assert.equal(target.storedImages.size, 1);
  await target.send("ENQUEUE", {text:"其他对话的临时任务"}, 12);
  const other = (await target.send("GET", {}, 12)).state.tasks[0];
  await target.send("DELETE_TASK", {id:other.id}, 12);
  assert.equal(target.storedImages.size, 1, "不相干的图片清理不能误删暂存数据");
  await target.send("RESTORE_BACKUP_ABORT", {token:first.backup.token});
  assert.equal(target.storedImages.size, 0);
  assert.equal((await target.send("GET")).state.tasks.length, 0);
  assert.equal((await target.send("RESTORE_BACKUP_FINISH", {
    token:first.backup.token,
  })).ok, false);

  const second = await target.send("RESTORE_BACKUP_BEGIN", {backup:manifest});
  await target.send("RESTORE_BACKUP_IMAGE", {token:second.backup.token,image:picture});
  assert.equal(target.storedImages.size, 1);
  target.advance(16 * 60);
  await target.tick(1);
  assert.equal(target.storedImages.size, 0);
  assert.equal((await target.send("RESTORE_BACKUP_FINISH", {
    token:second.backup.token,
  })).ok, false);
  assert.equal((await target.send("GET")).state.tasks.length, 0);
});

test("恢复图文备份暂停自动发送，自动规则默认停用，并重新映射原图引用", async () => {
  const source = await harness();
  await source.send("SAVE_COUNT_RATE_LIMIT", { enabled: true, windowMinutes: 8, maxAdds: 2 });
  await source.send("ENQUEUE", { text: "准备审图", images: [testImage] });
  await source.send("ADD_SCHEDULE", {
    text: "定时截图分析", mode: "time", intervalMinutes: 3,
    repeatCount: 4, images: [testImage],
  });
  const backup = (await source.send("GET_BACKUP")).backup;
  const target = await harness();
  const restored = await target.send("RESTORE_BACKUP", { backup });
  assert.equal(restored.ok, true);
  const state = restored.state;
  assert.equal(state.queuePaused, true);
  assert.equal(state.halted, false);
  assert.equal(state.tasks.length, 1);
  assert.equal(state.tasks[0].status, "pending");
  assert.equal(state.tasks[0].text, "准备审图");
  assert.equal(state.schedules.length, 1);
  assert.equal(state.schedules[0].enabled, false);
  assert.equal(state.schedules[0].intervalMinutes, 3);
  assert.equal(state.schedules[0].repeatCount, 4);
  assert.equal(state.countRateLimit.maxAdds, 2);
  assert.equal(state.countRateTimes.length, 0);
  assert.equal(state.history.at(-1).type, "backup_restored");
  assert.notEqual(state.tasks[0].id, backup.conversation.tasks[0].id);
  assert.notEqual(state.tasks[0].images[0].id, backup.conversation.tasks[0].images[0].id);
  assert.equal(target.storedImages.size, 2);
  assert.equal((await target.send("CLAIM", { ready: true })).dispatch, null);
  await target.send("SET_QUEUE_PAUSED", { paused: false });
  const claimed = await target.send("CLAIM", { ready: true });
  assert.equal(claimed.dispatch.text, "准备审图");
  const images = await target.send("GET_TASK_IMAGES", { id: claimed.dispatch.id });
  assert.equal(images.images[0].dataUrl, testImage.dataUrl);
});

test("备份中的发送中/等待回复状态只作为错误记录恢复，绝不自动重发", async () => {
  const source = await harness();
  await source.send("ENQUEUE", { text: "可能已经发出的任务" });
  await source.send("ENQUEUE", { text: "确定尚未发送的任务" });
  const claimed = await source.send("CLAIM", { ready: true });
  await source.send("SENT", { id: claimed.dispatch.id });
  const backup = (await source.send("GET_BACKUP")).backup;
  const target = await harness();
  const restored = await target.send("RESTORE_BACKUP", { backup });
  assert.equal(restored.state.queuePaused, true);
  assert.deepEqual(Array.from(restored.state.tasks, (task) => task.status), ["error", "pending"]);
  assert.ok(restored.state.tasks[0].error.includes("不自动重发"));
  await target.send("SET_QUEUE_PAUSED", { paused: false });
  const safe = await target.send("CLAIM", { ready: true });
  assert.equal(safe.dispatch.text, "确定尚未发送的任务");
});

test("备份拒绝错误会话、重复图片、缺失引用以及覆盖非空队列，失败不写入数据", async () => {
  const original = await harness();
  await original.send("ENQUEUE", { text: "有效原图", images: [testImage] });
  const backup = (await original.send("GET_BACKUP")).backup;
  const target = await harness();
  const invalid = [
    { ...backup, format: "unknown" },
    { ...backup, version: 8 },
    { ...backup, conversation: { ...backup.conversation, key: "chat:other" } },
    { ...backup, images: [] },
    { ...backup, images: [backup.images[0], backup.images[0]] },
    { ...backup, images: [{ ...backup.images[0], dataUrl: "data:image/png;base64,YWJj" }] },
    { ...backup, conversation: { ...backup.conversation,
      tasks: [backup.conversation.tasks[0], backup.conversation.tasks[0]] } },
    { ...backup, conversation: { ...backup.conversation,
      tasks: [{ ...backup.conversation.tasks[0], text: "x".repeat(12001) }] } },
  ];
  for (const value of invalid) {
    const res = await target.send("RESTORE_BACKUP", { backup: value });
    assert.equal(res.ok, false);
    assert.equal(target.storedImages.size, 0);
    assert.equal((await target.send("GET")).state.tasks.length, 0);
  }
  assert.equal((await target.send("RESTORE_BACKUP", { backup }, 12)).ok, false);
  await target.send("ENQUEUE", { text: "不能覆盖的现存任务" });
  assert.equal((await target.send("RESTORE_BACKUP", { backup })).ok, false);
  assert.equal((await target.send("GET")).state.tasks[0].text, "不能覆盖的现存任务");
});

test("已删除的自动规则产生的待办仍可备份与恢复为普通待办", async () => {
  const source = await harness();
  const s = await source.send("ADD_SCHEDULE", {
    text: "原规则", mode: "count", threshold: 1,
  });
  await source.send("DELETE_SCHEDULE", { id: s.state.schedules[0].id });
  const backup = (await source.send("GET_BACKUP")).backup;
  const target = await harness();
  const result = await target.send("RESTORE_BACKUP", { backup });
  assert.equal(result.ok, true);
  assert.equal(result.state.tasks.length, 1);
  assert.equal(result.state.tasks[0].sourceScheduleId, null);
});

test("导出备份拒绝超过恢复上限的任务量，防止生成不可用文件", async () => {
  const { send } = await harness({
    "cq.state.v2": {
      version: 2, conversations: {
        "chat:dialogue-a": {
          key: "chat:dialogue-a", url: A, tabId: 11,
          halted: false, tasks: Array.from({ length: 301 }, (_, n) => ({
            id: "over-" + n, text: "待办" + n, status: "pending", images: [],
          })), schedules: [],
        },
      }, legacyUnbound: null,
    },
  });
  const backup = await send("GET_BACKUP");
  assert.equal(backup.ok, false);
  assert.match(backup.error, /备份上限/);
  assert.equal((await send("GET")).state.tasks.length, 301);
});

test("失败事件日志不保存服务端原始错误字符串", async () => {
  const { send } = await harness();
  await send("ENQUEUE", { text: "包含内部业务信息的消息" });
  const claim = await send("CLAIM", { ready: true });
  await send("FAIL", {
    id: claim.dispatch.id, error: "Authorization token ABCSECRET; retry failed",
  });
  const state = (await send("GET")).state;
  assert.equal(state.history.at(-1).type, "send_failed");
  assert.equal(JSON.stringify(state.history).includes("ABCSECRET"), false);
  assert.equal(JSON.stringify(state.history).includes("业务信息"), false);
  assert.equal(state.tasks[0].status, "error");
});

test("异常重启导致活动任务指针丢失时必须隔离发送中记录，不允许偷偷发送下一条", async () => {
  const {send,stored} = await harness({
    "cq.state.v2": { version:2,legacyUnbound:null,conversations:{
      "chat:dialogue-a":{
        key:"chat:dialogue-a",url:A,tabId:11,halted:false,
        activeTaskId:null,steeringTaskId:null,
        tasks:[
          {id:"orphan",text:"可能已经发出",status:"waiting",sentAt:Date.UTC(2026,9,15,11,58)},
          {id:"next",text:"真正的下一条",status:"pending"},
        ],schedules:[],
      },
    }},
  });
  const hello = await send("HELLO");
  assert.equal(hello.state.halted,true);
  assert.equal(hello.state.haltReason,"state_inconsistent");
  assert.equal(hello.state.tasks[0].status,"error");
  assert.match(hello.state.tasks[0].error,/不会自动重发/);
  assert.equal(hello.state.tasks[1].status,"pending");
  assert.equal((await send("CLAIM",{ready:true})).dispatch,null);
  const recovered = await send("RECOVER_ON_VOICE",voiceProof);
  assert.equal(recovered.state.halted,true,"语音按钮不允许解除数据不一致的隔离");
  assert.equal(recovered.state.history.at(-1).type,"state_inconsistent");
  assert.equal((await send("HELLO")).state.history.length,1,"重复启动不应刷屏重复日志");
  assert.equal(stored["cq.state.v2"].conversations["chat:dialogue-a"].haltReason,
    "state_inconsistent");
  await send("ACK_RECOVERY");
  assert.equal((await send("CLAIM",{ready:true})).dispatch.text,"真正的下一条");
});

test("活动锁指向不存在的任务时暂停而不盲目领取，人工核对后可继续", async () => {
  const {send} = await harness({
    "cq.state.v2":{version:2,legacyUnbound:null,conversations:{
      "chat:dialogue-a":{
        key:"chat:dialogue-a",url:A,tabId:11,halted:false,
        activeTaskId:"missing-active",steeringTaskId:null,
        tasks:[{id:"pending",text:"待处理内容",status:"pending"}],schedules:[],
      },
    }},
  });
  const first = await send("CLAIM",{ready:true});
  assert.equal(first.dispatch,null);
  assert.equal(first.state.halted,true);
  assert.equal(first.state.activeTaskId,null);
  assert.equal(first.state.tasks[0].status,"pending");
  assert.equal(first.state.haltReason,"state_inconsistent");
  const again = await send("HELLO");
  assert.equal(again.state.history.length,1);
  assert.equal((await send("ACK_RECOVERY")).state.halted,false);
  assert.equal((await send("CLAIM",{ready:true})).dispatch.text,"待处理内容");
});

test("缺失或明显异常的发送时间戳必须隔离，防止锁永远不超时", async () => {
  const now = Date.UTC(2026,9,15,12,0);
  for (const invalid of [
    {status:"dispatching"},
    {status:"dispatching",claimedAt:NaN},
    {status:"dispatching",claimedAt:now + 3_600_000},
    {status:"waiting",claimedAt:now - 1500},
    {status:"waiting",sentAt:0},
    {status:"waiting",sentAt:now + 3_600_000},
  ]) {
    const {send}=await harness({
      "cq.state.v2":{version:2,legacyUnbound:null,conversations:{
        "chat:dialogue-a":{
          key:"chat:dialogue-a",url:A,tabId:11,halted:false,
          activeTaskId:"inflight",steeringTaskId:null,
          tasks:[{id:"inflight",text:"无法确认送达",...invalid},
            {id:"later",text:"后续待办",status:"pending"}],
          schedules:[],
        },
      }},
    });
    const repaired=(await send("HELLO")).state;
    assert.equal(repaired.halted,true,JSON.stringify(invalid));
    assert.equal(repaired.haltReason,"state_inconsistent");
    assert.equal(repaired.activeTaskId,null);
    assert.equal(repaired.tasks[0].status,"error");
    assert.equal(repaired.tasks[1].status,"pending");
    assert.equal((await send("CLAIM",{ready:true})).dispatch,null);
  }
});

test("丢失或过期的引导锁会安全隔离；有效未点击引导仍沿用超时回队列机制", async () => {
  const now=Date.UTC(2026,9,15,12,0);
  for (const spec of [
    {pointer:"missing",item:{id:"queued",text:"待发送",status:"pending"}},
    {pointer:"steer",item:{id:"steer",text:"引导",status:"steering"}},
    {pointer:"steer",item:{id:"steer",text:"引导",status:"steering_wait",steerClaimedAt:now-1000}},
    {pointer:null,item:{id:"orphan-steer",text:"孤立的引导",status:"steering_wait",steerClickedAt:now-1000}},
  ]) {
    const {send}=await harness({
      "cq.state.v2":{version:2,legacyUnbound:null,conversations:{
        "chat:dialogue-a":{
          key:"chat:dialogue-a",url:A,tabId:11,halted:false,
          activeTaskId:null,steeringTaskId:spec.pointer,
          tasks:[spec.item,{id:"later",text:"下一个",status:"pending"}],schedules:[],
        },
      }},
    });
    const state=(await send("HELLO")).state;
    assert.equal(state.halted,true);
    assert.equal(state.steeringTaskId,null);
    assert.equal(state.haltReason,"state_inconsistent");
    assert.equal((await send("CLAIM",{ready:true})).dispatch,null);
  }
  const live=await harness();
  await live.send("ENQUEUE",{text:"正常引导"});
  const queued=(await live.send("GET")).state.tasks[0];
  await live.send("STEER_CLAIM",{id:queued.id,userCount:0});
  assert.equal((await live.send("HELLO")).state.halted,false);
  assert.equal((await live.send("GET")).state.tasks[0].status,"steering");
  await live.tick(2);
  const after=(await live.send("GET")).state;
  assert.equal(after.halted,false);
  assert.equal(after.steeringTaskId,null);
  assert.equal(after.tasks[0].status,"pending");
});

test("合法旧版 waiting 仅保存 sentAt 仍可继续按原语音完成条件回收", async () => {
  const {send,advance}=await harness({
    "cq.state.v2":{version:2,legacyUnbound:null,conversations:{
      "chat:dialogue-a":{
        key:"chat:dialogue-a",url:A,tabId:11,halted:false,
        activeTaskId:"valid",steeringTaskId:null,
        tasks:[{id:"valid",text:"旧版等待任务",status:"waiting",
          sentAt:Date.UTC(2026,9,15,11,59)}],
        schedules:[],
      },
    }},
  });
  const hello=await send("HELLO");
  assert.equal(hello.state.halted,false);
  assert.equal(hello.state.activeTaskId,"valid");
  advance(3);
  const finished=await send("FINISHED",{...voiceProof,id:"valid"});
  assert.equal(finished.ok,true);
  assert.equal(finished.state.tasks.length,0);
});

test("多个孤立的发送/引导任务必须逐条人工核对，核对第一条不能提前放行队列", async () => {
  const {send}=await harness({
    "cq.state.v2":{version:2,legacyUnbound:null,conversations:{
      "chat:dialogue-a":{
        key:"chat:dialogue-a",url:A,tabId:11,halted:false,
        activeTaskId:null,steeringTaskId:null,
        tasks:[
          {id:"orphan-a",text:"上一条是否已发不明确",status:"waiting",sentAt:Date.UTC(2026,9,15,11,59)},
          {id:"orphan-b",text:"第二次中途引导可能已发",status:"steering_wait",steerClickedAt:Date.UTC(2026,9,15,11,59)},
          {id:"next",text:"明确待发送的下一个任务",status:"pending"},
        ],schedules:[],
      },
    }},
  });
  const protectedState=(await send("HELLO")).state;
  assert.equal(protectedState.halted,true);
  assert.deepEqual(Array.from(protectedState.tasks, (task) => task.status),
    ["error","error","pending"]);
  assert.equal((await send("USER_RESUMED",{viaNativeContinue:true})).state.halted,true);
  assert.equal((await send("USER_RESUMED",{
    userCount:10,lastUserText:"我自己发送了一条新消息",
  })).state.halted,true);
  const first=await send("SKIP_FAILED",{id:"orphan-a"});
  assert.equal(first.state.halted,true);
  assert.equal(first.state.haltReason,"state_inconsistent");
  assert.match(first.state.error,/还有 1 条/);
  assert.equal((await send("CLAIM",{ready:true})).dispatch,null);
  const second=await send("SKIP_FAILED",{id:"orphan-b"});
  assert.equal(second.state.halted,false);
  assert.equal((await send("CLAIM",{ready:true})).dispatch.text,"明确待发送的下一个任务");
});

test("A/B chats have separate queues and switching restores their own content", async () => {
  const { send, navigate } = await harness();
  const first = await send("ENQUEUE", { text: "A 任务" });
  assert.equal(first.state.key, "chat:dialogue-a");
  assert.equal(first.state.halted, false);
  navigate(11, B);
  const empty = await send("HELLO");
  assert.equal(empty.state.key, "chat:dialogue-b");
  assert.equal(empty.state.tasks.length, 0);
  await send("ENQUEUE", { text: "B 任务" });

  navigate(11, A);
  const restoredA = await send("HELLO");
  assert.equal(restoredA.state.tasks.length, 1);
  assert.equal(restoredA.state.tasks[0].text, "A 任务");
  const claimA = await send("CLAIM", { ready: true, userCount: 0, assistantCount: 0 });
  assert.equal(claimA.dispatch.text, "A 任务");

  navigate(11, B);
  const restoredB = await send("HELLO");
  assert.equal(restoredB.state.tasks.length, 1);
  assert.equal(restoredB.state.tasks[0].text, "B 任务");
  assert.equal(restoredB.state.activeTaskId, null);
  assert.equal((await send("SENT", { id: claimA.dispatch.id })).ok, false);
});

test("手动移除普通等待任务：清理图片、保留暂停且按冷却继续下一条，不报告完成", async () => {
  const env=await harness();
  await env.send("SAVE_SEND_COOLDOWN",{seconds:30});
  const added=await env.send("ENQUEUE",{text:"等待已结束的回复",images:[testImage]});
  const first=added.state.tasks[0];
  await env.send("ENQUEUE",{text:"后续待办"});
  const claimed=await env.send("CLAIM",{ready:true});
  await env.send("SENT",{id:claimed.dispatch.id});
  await env.send("SET_QUEUE_PAUSED",{paused:true});
  const removed=await env.send("DISMISS_WAITING",{
    id:claimed.dispatch.id,userRequested:true,nativeBusy:false,
  });
  assert.equal(removed.ok,true);
  assert.equal(removed.state.activeTaskId,null);
  assert.equal(removed.state.queuePaused,true);
  assert.equal(removed.state.halted,false);
  assert.equal(removed.state.unreadCompleted,false);
  assert.equal(removed.state.history.at(-1).type,"waiting_dismissed");
  const dashboard=await env.sendDashboard("DASHBOARD_GET");
  assert.equal(dashboard.dashboard.sessions.find((session)=>session.key==="chat:dialogue-a")
    .recentEvents.some((entry)=>entry.type==="waiting_dismissed"),true);
  assert.equal(removed.state.history.some((entry)=>entry.type==="finished"),false);
  assert.deepEqual(Array.from(removed.state.tasks,(task)=>task.text),["后续待办"]);
  assert.equal(env.storedImages.has(first.images[0].id),false);
  assert.equal((await env.send("CLAIM",{ready:true})).dispatchBlockedReason,"paused");
  await env.send("SET_QUEUE_PAUSED",{paused:false});
  assert.equal((await env.send("CLAIM",{ready:true})).dispatchBlockedReason,"cooldown");
  env.advance(30);
  const next=await env.send("CLAIM",{ready:true});
  assert.equal(next.dispatch.text,"后续待办");
  assert.notEqual(next.dispatch.id,first.id);
});

test("移除等待需要本对话用户操作且原生已停止，不能移除发送中或不确定任务", async () => {
  const env=await harness();
  await env.send("ENQUEUE",{text:"只能移除已确认发送的等待"});
  const claimed=await env.send("CLAIM",{ready:true});
  const request={id:claimed.dispatch.id,userRequested:true,nativeBusy:false};
  assert.equal((await env.send("DISMISS_WAITING",request)).ok,false);
  await env.send("SENT",{id:claimed.dispatch.id});
  for (const args of [
    {id:claimed.dispatch.id,nativeBusy:false},
    {id:claimed.dispatch.id,userRequested:true},
    {...request,nativeBusy:true},
    {...request,id:"not-the-active-task"},
  ]) assert.equal((await env.send("DISMISS_WAITING",args)).ok,false);
  assert.equal((await env.send("DISMISS_WAITING",request,12,A)).ok,false);
  await env.send("UNCERTAIN_SEND",{userCount:1});
  assert.equal((await env.send("DISMISS_WAITING",request)).ok,false);
  const retained=(await env.send("GET")).state;
  assert.equal(retained.activeTaskId,claimed.dispatch.id);
  assert.equal(retained.tasks[0].status,"waiting");
  assert.equal(retained.halted,true);
  assert.equal(retained.haltReason,"uncertain");
});

test("逐对话暂停/继续自动发送：暂停期间允许入队、计时，且不领取新任务", async () => {
  const { send, advance } = await harness();
  await send("ENQUEUE", { text: "第一条" });
  const stopped = await send("SET_QUEUE_PAUSED", { paused: true });
  assert.equal(stopped.ok, true);
  assert.equal(stopped.state.queuePaused, true);
  const pausedClaim = await send("CLAIM", { ready: true });
  assert.equal(pausedClaim.dispatch, null);
  assert.equal(pausedClaim.dispatchBlockedReason, "paused");
  await send("ENQUEUE", { text: "暂停后新入队" });
  await send("ADD_SCHEDULE", {
    text: "计时器照常补入", intervalMinutes: 1, repeatCount: 0,
  });
  advance(60);
  const timed = await send("SCHEDULE_PULSE");
  assert.deepEqual(Array.from(timed.state.tasks, (task) => task.text),
    ["第一条", "暂停后新入队", "计时器照常补入"]);
  assert.equal((await send("CLAIM", { ready: true })).dispatch, null);
  const resumed = await send("SET_QUEUE_PAUSED", { paused: false });
  assert.equal(resumed.state.queuePaused, false);
  assert.equal((await send("CLAIM", { ready: true })).dispatch.text, "第一条");
});

test("已发送消息在手动暂停期间仍可确认完成，但不会触发下一条；重启后保留暂停", async () => {
  const { send, advance, stored } = await harness();
  await send("ENQUEUE", { text: "正在运行" });
  await send("ENQUEUE", { text: "后续消息" });
  const claim = await send("CLAIM", { ready: true, userCount: 0 });
  await send("SENT", { id: claim.dispatch.id });
  await send("SET_QUEUE_PAUSED", { paused: true });
  advance(3);
  const done = await send("FINISHED", { ...voiceProof, id: claim.dispatch.id });
  assert.equal(done.state.tasks.length, 1);
  assert.equal(done.state.tasks[0].text, "后续消息");
  assert.equal(done.state.activeTaskId, null);
  assert.equal((await send("CLAIM", { ready: true })).dispatch, null);
  const rebooted = await harness(structuredClone(stored));
  assert.equal((await rebooted.send("HELLO")).state.queuePaused, true);
  assert.equal((await rebooted.send("CLAIM", { ready: true })).dispatch, null);
  await rebooted.send("SET_QUEUE_PAUSED", { paused: false });
  assert.equal((await rebooted.send("CLAIM", { ready: true })).dispatch.text, "后续消息");
});

test("暂停仅限本对话、参数严格校验；显式继续解除用户停止但不解除异常安全锁", async () => {
  const { send } = await harness();
  await send("ENQUEUE", { text: "A" }, 11);
  await send("ENQUEUE", { text: "B" }, 12);
  assert.equal((await send("SET_QUEUE_PAUSED", { paused: "false" })).ok, false);
  assert.equal((await send("SET_QUEUE_PAUSED", { paused: true }, 12, A)).ok, false);
  await send("SET_QUEUE_PAUSED", { paused: true }, 11);
  assert.equal((await send("GET", {}, 12)).state.queuePaused, false);
  assert.equal((await send("CLAIM", { ready: true }, 11)).dispatch, null);
  assert.equal((await send("CLAIM", { ready: true }, 12)).dispatch.text, "B");
  await send("STOPPED", { userCount: 1 }, 11);
  const resumed = await send("SET_QUEUE_PAUSED", { paused: false }, 11);
  assert.equal(resumed.state.halted, false);
  assert.equal(resumed.state.haltReason, null);
  assert.equal(resumed.state.haltAtUserCount, null);
  assert.equal(resumed.state.error, "");
  assert.equal(resumed.state.queuePaused, false);
  await send("UNCERTAIN_SEND", { userCount: 2 }, 11);
  await send("SET_QUEUE_PAUSED", { paused: true }, 11);
  const unsafeResume = await send("SET_QUEUE_PAUSED", { paused: false }, 11);
  assert.equal(unsafeResume.ok, false);
  assert.match(unsafeResume.error,/核对/);
  const guarded = await send("GET", {}, 11);
  assert.equal(guarded.state.halted, true);
  assert.equal(guarded.state.haltReason, "uncertain");
  assert.equal(guarded.state.queuePaused, true);
  assert.equal((await send("CLAIM", { ready: true }, 11)).dispatch, null);
});

test("原生停止后的显式继续不会重发被打断任务，仅领取剩余待发送任务", async () => {
  const { send, stored } = await harness();
  await send("ENQUEUE", { text: "已发出但中断的任务" });
  await send("ENQUEUE", { text: "仍待发送的任务" });
  const first = await send("CLAIM", { ready: true, userCount: 0 });
  await send("SENT", { id: first.dispatch.id });
  const stopped = await send("STOPPED", { userCount: 1 });
  assert.equal(stopped.state.halted, true);
  assert.equal(stopped.state.tasks[0].status, "interrupted");
  assert.equal(stopped.state.tasks[1].status, "pending");
  assert.equal((await send("CLAIM", { ready: true })).dispatch, null);
  const resumed = await send("SET_QUEUE_PAUSED", { paused: false });
  assert.equal(resumed.ok, true);
  assert.equal(resumed.state.halted, false);
  assert.equal(resumed.state.tasks[0].status, "interrupted");
  assert.equal(resumed.state.tasks[0].id, first.dispatch.id);
  assert.equal((await send("CLAIM", { ready: true })).dispatch.text, "仍待发送的任务");
  assert.equal(stored["cq.state.v2"].conversations["chat:dialogue-a"].tasks[0].status,
    "interrupted");
});

test("队列高度支持跨对话持久化、刷新后保留与双击恢复自动高度", async () => {
  const { send, stored } = await harness();
  assert.equal((await send("HELLO")).settings.queueListHeight, null);
  const sized = await send("SAVE_QUEUE_HEIGHT", { height: 420 });
  assert.equal(sized.ok, true);
  assert.equal(sized.settings.queueListHeight, 420);
  assert.equal((await send("GET", {}, 12)).settings.queueListHeight, 420);
  assert.equal(stored["cq.state.v2"].settings.queueListHeight, 420);
  await send("SAVE_SETTINGS", {
    maxPending: 17, defaultIntervalMinutes: 20, defaultRepeatCount: 3,
  });
  assert.equal((await send("GET")).settings.queueListHeight, 420);
  const restored = await harness(structuredClone(stored));
  assert.equal((await restored.send("HELLO", {}, 11)).settings.queueListHeight, 420);
  const reset = await restored.send("SAVE_QUEUE_HEIGHT", { height: null });
  assert.equal(reset.settings.queueListHeight, null);
  assert.equal((await restored.send("GET", {}, 12)).settings.queueListHeight, null);
  assert.equal(restored.stored["cq.state.v2"].settings.queueListHeight, null);
});

test("队列高度范围校验严格，失败不会改动原有设置或队列", async () => {
  const { send, stored } = await harness();
  await send("ENQUEUE", { text: "不能误删的队列任务" });
  await send("SAVE_QUEUE_HEIGHT", { height: 180 });
  for (const invalid of [undefined, "", "180", 71, 901, -5, 240.5, NaN, Infinity, {}]) {
    const result = await send("SAVE_QUEUE_HEIGHT", { height: invalid });
    assert.equal(result.ok, false, String(invalid));
  }
  assert.equal((await send("GET")).settings.queueListHeight, 180);
  assert.equal(stored["cq.state.v2"].settings.queueListHeight, 180);
  assert.deepEqual(Array.from((await send("GET")).state.tasks, (task) => task.text),
    ["不能误删的队列任务"]);
  assert.equal((await send("SAVE_QUEUE_HEIGHT", { height: 72 })).settings.queueListHeight, 72);
  assert.equal((await send("SAVE_QUEUE_HEIGHT", { height: 900 })).settings.queueListHeight, 900);
});

test("后台保护默认开启，队列运行和等待期间不可自动丢弃，完成后恢复原状态", async () => {
  const { send, advance, tabs, tabUpdates, sessionStored } = await harness();
  const empty = await send("HELLO");
  assert.equal(empty.settings.protectBackground, true);
  assert.equal(tabs.get(11).autoDiscardable, true);
  await send("ENQUEUE", { text: "长时间运行的对话" });
  assert.equal(tabs.get(11).autoDiscardable, false);
  assert.equal(sessionStored["cq.protectedTabs.v1"]["11"], true);
  const claim = await send("CLAIM", { ready: true });
  await send("SENT", { id: claim.dispatch.id });
  assert.equal(tabs.get(11).autoDiscardable, false);
  advance(3);
  const done = await send("FINISHED", { ...voiceProof, id: claim.dispatch.id });
  assert.equal(done.state.tasks.length, 0);
  assert.equal(tabs.get(11).autoDiscardable, true);
  assert.equal(Object.keys(sessionStored["cq.protectedTabs.v1"]).length, 0);
  assert.deepEqual(tabUpdates.map((update) => update.autoDiscardable), [false, true]);
});

test("启用的自动任务也保护后台，禁用与删除规则后恢复，手动禁用保护立即生效", async () => {
  const { send, tick, tabs, tabUpdates } = await harness();
  const schedule = await send("ADD_SCHEDULE", { text: "间隔触发", intervalMinutes: 30 }, 11);
  const scheduleId = schedule.state.schedules[0].id;
  assert.equal(schedule.state.tasks.length, 0);
  assert.equal(tabs.get(11).autoDiscardable, false);
  await send("TOGGLE_SCHEDULE", { id: scheduleId });
  assert.equal(tabs.get(11).autoDiscardable, true);
  await send("TOGGLE_SCHEDULE", { id: scheduleId });
  assert.equal(tabs.get(11).autoDiscardable, false);
  const disabled = await send("PROTECT_BACKGROUND", { enabled: false });
  assert.equal(disabled.settings.protectBackground, false);
  assert.equal(tabs.get(11).autoDiscardable, true);
  await tick(1);
  assert.equal(tabs.get(11).autoDiscardable, true);
  assert.equal((await send("PROTECT_BACKGROUND", { enabled: "false" })).ok, false);
  const enabled = await send("PROTECT_BACKGROUND", { enabled: true });
  assert.equal(enabled.settings.protectBackground, true);
  assert.equal(tabs.get(11).autoDiscardable, false);
  await send("DELETE_SCHEDULE", { id: scheduleId });
  assert.equal(tabs.get(11).autoDiscardable, true);
  assert.deepEqual(tabUpdates.map((update) => update.autoDiscardable),
    [false, true, false, true, false, true]);
});

test("后台保护仅作用于对应 ChatGPT 对话，导航、关闭标签和既有不可丢弃设置均安全", async () => {
  const { send, tabs, navigate, closeTab, sessionStored, tabUpdates } = await harness();
  tabs.get(12).autoDiscardable = false; // User or another extension protected B already.
  await send("ENQUEUE", { text: "A 队列" }, 11);
  await send("ENQUEUE", { text: "B 队列" }, 12);
  assert.equal(tabs.get(11).autoDiscardable, false);
  assert.equal(tabs.get(12).autoDiscardable, false);
  assert.equal(Object.keys(sessionStored["cq.protectedTabs.v1"]).length, 1);
  navigate(11, "https://example.com/");
  await send("GET", {}, 12); // Wait for the queued navigation cleanup.
  assert.equal(tabs.get(11).autoDiscardable, true);
  assert.equal(tabs.get(12).autoDiscardable, false);
  assert.equal(sessionStored["cq.protectedTabs.v1"]["11"], undefined);

  // Returning to the correct conversation can reattach and restore protection.
  navigate(11, A);
  await send("HELLO", { lastUserText: "" }, 11);
  assert.equal(tabs.get(11).autoDiscardable, false);
  closeTab(11);
  await send("GET", {}, 12);
  assert.equal(sessionStored["cq.protectedTabs.v1"]["11"], undefined);
  await send("PROTECT_BACKGROUND", { enabled: false }, 12);
  assert.equal(tabs.get(12).autoDiscardable, false); // Never reset the user's own flag.
  assert.equal(tabUpdates.some((update) => update.id === 12), false);
});

test("后台闹钟每分钟补充发送检查，不唤醒无队列页面，不抢占焦点", async () => {
  const { send, tick, tabs, wakeMessages, tabUpdates } = await harness();
  await send("ENQUEUE", { text: "后台持续任务" }, 11);
  await tick(1);
  assert.ok(wakeMessages.some((message) =>
    message.tabId === 11 && message.message.type === "QUEUE_WAKE"));
  assert.equal(wakeMessages.some((message) => message.tabId === 12), false);
  assert.equal(tabUpdates.some((update) => "active" in update), false);

  const pending = (await send("GET")).state.tasks[0];
  await send("DELETE_TASK", { id: pending.id });
  const count = wakeMessages.length;
  await tick(1);
  assert.equal(wakeMessages.length, count);
  assert.equal(tabs.get(11).autoDiscardable, true);
});

test("置顶和拖动只改变待发送顺序，刷新后持久保留，下一条按新顺序领取", async () => {
  const { send, stored } = await harness();
  const texts = (state) => Array.from(state.tasks, (task) => task.text);
  for (const text of ["甲", "乙", "丙", "丁"]) await send("ENQUEUE", { text });
  let tasks = (await send("GET")).state.tasks;
  const ids = Object.fromEntries(tasks.map((task) => [task.text, task.id]));

  const pinned = await send("PIN_TASK", { id: ids.丙 });
  assert.deepEqual(texts(pinned.state), ["丙", "甲", "乙", "丁"]);
  const before = await send("REORDER_TASK", {
    id: ids.丁, targetId: ids.甲, position: "before",
  });
  assert.deepEqual(texts(before.state), ["丙", "丁", "甲", "乙"]);
  const after = await send("REORDER_TASK", {
    id: ids.丙, targetId: ids.乙, position: "after",
  });
  assert.deepEqual(texts(after.state), ["丁", "甲", "乙", "丙"]);
  const noOp = await send("PIN_TASK", { id: ids.丁 });
  assert.deepEqual(texts(noOp.state), ["丁", "甲", "乙", "丙"]);
  assert.deepEqual(texts((await send("HELLO")).state),
    ["丁", "甲", "乙", "丙"]);
  assert.deepEqual(texts(stored["cq.state.v2"].conversations["chat:dialogue-a"]),
    ["丁", "甲", "乙", "丙"]);
  const claimed = await send("CLAIM", { ready: true });
  assert.equal(claimed.dispatch.text, "丁");
});

test("拖拽经过等待、失败和引导记录不会移动非 pending 槽位", async () => {
  const { send } = await harness({
    "cq.state.v2": {
      version: 2,
      conversations: {
        "chat:dialogue-a": {
          key: "chat:dialogue-a", url: A, tabId: 11, halted: false,
          activeTaskId: "w", steeringTaskId: null, tasks: [
            { id: "w", text: "运行中", status: "waiting", sentAt: Date.UTC(2026, 9, 15, 12, 0) },
            { id: "a", text: "甲", status: "pending" },
            { id: "e", text: "失败记录", status: "error" },
            { id: "b", text: "乙", status: "pending", images: [{ id: "img", name: "图片.png" }] },
            { id: "s", text: "引导中", status: "steering" },
            { id: "c", text: "丙", status: "pending", sourceScheduleId: "periodic" },
          ],
          schedules: [],
        },
      },
      legacyUnbound: null,
    },
  });
  const ids = (state) => Array.from(state.tasks, (task) => task.id);
  const pinned = await send("PIN_TASK", { id: "c" });
  assert.deepEqual(ids(pinned.state),
    ["w", "c", "e", "a", "s", "b"]);
  assert.equal(pinned.state.activeTaskId, "w");
  const moved = await send("REORDER_TASK", {
    id: "b", targetId: "c", position: "before",
  });
  assert.deepEqual(ids(moved.state),
    ["w", "b", "e", "c", "s", "a"]);
  assert.equal(moved.state.tasks[1].images[0].id, "img");
  assert.equal(moved.state.tasks[3].sourceScheduleId, "periodic");

  for (const request of [
    ["PIN_TASK", { id: "w" }],
    ["PIN_TASK", { id: "e" }],
    ["REORDER_TASK", { id: "c", targetId: "w", position: "after" }],
    ["REORDER_TASK", { id: "c", targetId: "e", position: "before" }],
    ["REORDER_TASK", { id: "c", targetId: "a", position: "middle" }],
    ["REORDER_TASK", { id: "c", targetId: "unknown", position: "before" }],
    ["REORDER_TASK", { id: "c", position: "before" }],
  ]) {
    assert.equal((await send(...request)).ok, false);
  }
  assert.deepEqual(ids((await send("GET")).state),
    ["w", "b", "e", "c", "s", "a"]);
  assert.equal((await send("PIN_TASK", { id: "c" }, 12, A)).ok, false);
  assert.equal((await send("REORDER_TASK", {
    id: "a", targetId: "b", position: "before",
  }, 12, A)).ok, false);
  assert.deepEqual(ids((await send("GET")).state),
    ["w", "b", "e", "c", "s", "a"]);
});

test("confirmed finished message is deleted immediately from queue and storage", async () => {
  const { send, stored, advance } = await harness();
  await send("ENQUEUE", { text: "任务一" });
  await send("ENQUEUE", { text: "任务二" });
  const first = await send("CLAIM", { ready: true, userCount: 2, assistantCount: 2 });
  assert.equal(first.dispatch.text, "任务一");
  assert.equal((await send("CLAIM", { ready: true })).dispatch, null);
  await send("SENT", { id: first.dispatch.id });
  advance(3);
  const tooEarly = await send("FINISHED", {
    ...voiceProof, voiceReady: false, id: first.dispatch.id,
  });
  assert.equal(tooEarly.ok, false);
  const result = await send("FINISHED", {
    ...voiceProof, id: first.dispatch.id,
  });
  assert.equal(result.state.activeTaskId, null);
  assert.equal(result.state.tasks.length, 1);
  assert.equal(result.state.tasks[0].text, "任务二");
  assert.equal(stored["cq.state.v2"].conversations["chat:dialogue-a"].tasks.length, 1);
  const second = await send("CLAIM", { ready: true, userCount: 3, assistantCount: 3 });
  assert.equal(second.dispatch.text, "任务二");
});

test("多个按时间规则在队列只有一个空位时 A→B→C 公平轮流入队", async () => {
  const {send,tick,advance,stored}=await harness();
  await send("SAVE_SETTINGS",{maxPending:1});
  for (const name of ["A","B","C"]) {
    await send("ADD_SCHEDULE",{text:name,mode:"time",intervalMinutes:1,repeatCount:-1});
  }
  await tick(1);
  const order=[];
  const ids=[];
  for (let step=0;step<7;step++) {
    const state=(await send("GET")).state;
    assert.equal(state.tasks.length,1);
    order.push(state.tasks[0].text);
    ids.push(state.lastTimeScheduleId);
    assert.equal(state.lastTimeScheduleId,state.tasks[0].sourceScheduleId);
    if (step===6) break;
    advance(60);
    const deleted=await send("DELETE_TASK",{id:state.tasks[0].id});
    assert.equal(deleted.state.tasks.length,1,
      "删除唯一待办后，下一条已到期规则立即补入空位");
    await send("SCHEDULE_PULSE");
    assert.equal((await send("GET")).state.tasks.length,1);
  }
  assert.deepEqual(order,["A","B","C","A","B","C","A"]);
  assert.deepEqual(Array.from((await send("GET")).state.schedules,(s)=>s.runCount),[3,2,2]);
  assert.deepEqual(ids,[...new Set(ids),...ids.slice(3,6),ids[6]]);
  assert.equal(stored["cq.state.v2"].conversations["chat:dialogue-a"].lastTimeScheduleId,
    ids[6]);
});

test("按时间规则轮询游标跨服务工作线程重启后仍继续下一规则", async () => {
  const first=await harness();
  await first.send("SAVE_SETTINGS",{maxPending:1});
  for (const text of ["甲","乙","丙"]) {
    await first.send("ADD_SCHEDULE",{text,intervalMinutes:1});
  }
  await first.tick(1);
  const initial=(await first.send("GET")).state;
  assert.equal(initial.tasks[0].text,"甲");
  assert.equal(initial.lastTimeScheduleId,initial.schedules[0].id);
  const restarted=await harness(structuredClone(first.stored));
  restarted.advance(120);
  const before=(await restarted.send("GET")).state;
  assert.equal(before.tasks[0].text,"甲");
  const second=await restarted.send("DELETE_TASK",{id:before.tasks[0].id});
  assert.equal(second.state.tasks[0].text,"乙");
  assert.equal(second.state.lastTimeScheduleId,second.state.schedules[1].id);
  assert.equal((await restarted.send("HELLO")).state.tasks[0].text,"乙");
});

test("时间轮询跳过停用、未到期和用尽次数的规则，不破坏各自周期", async () => {
  const {send,advance}=await harness();
  await send("SAVE_SETTINGS",{maxPending:1});
  const a=await send("ADD_SCHEDULE",{text:"已停用",intervalMinutes:1});
  await send("TOGGLE_SCHEDULE",{id:a.state.schedules[0].id});
  await send("ADD_SCHEDULE",{text:"慢周期",intervalMinutes:30});
  await send("ADD_SCHEDULE",{text:"单次",intervalMinutes:1,repeatCount:0});
  await send("ADD_SCHEDULE",{text:"循环",intervalMinutes:1});
  advance(60);
  const first=await send("SCHEDULE_PULSE");
  assert.equal(first.state.tasks[0].text,"单次");
  assert.equal(first.state.schedules[2].enabled,false);
  advance(60);
  const second=await send("DELETE_TASK",{id:first.state.tasks[0].id});
  assert.equal(second.state.tasks[0].text,"循环");
  assert.equal(second.state.schedules[0].runCount,0);
  assert.equal(second.state.schedules[1].runCount,0);
  assert.equal(second.state.schedules[2].runCount,1);
  assert.equal(second.state.schedules[3].runCount,1);
  assert.equal(second.state.schedules[1].nextRunAt,
    Date.UTC(2026,9,15,12,30));
});

test("schedulers belong to their own chat, run independently and never backfill missed periods", async () => {
  const { send, tick } = await harness();
  await send("ADD_SCHEDULE", { text: "A 定时", intervalMinutes: 2 }, 11);
  await send("ADD_SCHEDULE", { text: "B 定时", intervalMinutes: 3 }, 12);
  const startA = await send("GET", {}, 11);
  const startB = await send("GET", {}, 12);
  assert.equal(startA.state.schedules.length, 1);
  assert.equal(startB.state.schedules.length, 1);
  assert.equal(startA.state.schedules[0].intervalMinutes, 2);

  await tick(2);
  const afterA = await send("GET", {}, 11);
  const afterB = await send("GET", {}, 12);
  assert.equal(afterA.state.tasks.length, 1);
  assert.equal(afterA.state.tasks[0].text, "A 定时");
  assert.equal(afterB.state.tasks.length, 0);

  await tick(1);
  const bDue = await send("GET", {}, 12);
  assert.equal(bDue.state.tasks.length, 1);
  assert.equal(bDue.state.tasks[0].text, "B 定时");

  await tick(20);
  // Each chat receives ONE new item for the missed period, regardless of
  // earlier pending items and regardless of a 20-minute browser sleep.
  const a = (await send("GET", {}, 11)).state;
  const b = (await send("GET", {}, 12)).state;
  assert.equal(a.tasks.length, 2);
  assert.equal(b.tasks.length, 2);
  assert.equal(a.schedules[0].runCount, 2);
  assert.equal(b.schedules[0].runCount, 2);
  assert.equal(new Set(a.tasks.map((task) => task.id)).size, 2);
  assert.equal(new Set(b.tasks.map((task) => task.id)).size, 2);
});

test("an open tab can trigger its chat schedule at second precision", async () => {
  const { send, advance } = await harness();
  const schedule = await send("ADD_SCHEDULE", { text: "倒计时", intervalMinutes: 1 });
  const nextRunAt = schedule.state.schedules[0].nextRunAt;
  advance(59);
  assert.equal((await send("SCHEDULE_PULSE")).state.tasks.length, 0);
  advance(1);
  const triggered = await send("SCHEDULE_PULSE");
  assert.equal(triggered.state.tasks.length, 1);
  assert.equal(triggered.state.tasks[0].text, "倒计时");
  assert.equal(triggered.state.schedules[0].nextRunAt, nextRunAt + 60_000);
});

test("数量触发模式按待执行任务数补队，发送中也计数，完成后立即补一条", async () => {
  const { send, advance } = await harness();
  const created = await send("ADD_SCHEDULE", {
    text: "持续接力", mode: "count", threshold: 2, repeatCount: -1,
  });
  assert.equal(created.state.schedules[0].mode, "count");
  assert.equal(created.state.tasks.length, 1); // 创建规则时立即发现空队列。
  const filled = await send("SCHEDULE_PULSE");
  assert.equal(filled.state.tasks.length, 2);
  assert.equal(filled.state.schedules[0].runCount, 2);
  assert.equal((await send("SCHEDULE_PULSE")).state.tasks.length, 2);

  const claim = await send("CLAIM", { ready: true, userCount: 0 });
  await send("SENT", { id: claim.dispatch.id });
  assert.equal((await send("SCHEDULE_PULSE")).state.tasks.length, 2); // waiting 也占位。
  advance(3);
  const finished = await send("FINISHED", { ...voiceProof, id: claim.dispatch.id });
  assert.equal(finished.state.tasks.length, 2);
  assert.equal(finished.state.schedules[0].runCount, 3);
  assert.equal(finished.state.tasks.every((task) => task.status === "pending"), true);
  assert.equal((await send("SCHEDULE_PULSE")).state.tasks.length, 2);
});

test("多个数量规则公平轮流补充唯一空位，不会一直由首条规则占用", async () => {
  const { send, stored } = await harness();
  await send("SAVE_SETTINGS", { maxPending: 1 });
  const schedules = [];
  for (const text of ["A", "B", "C"]) {
    const state = (await send("ADD_SCHEDULE", {
      text, mode: "count", threshold: 1, repeatCount: -1,
    })).state;
    schedules.push(state.schedules.at(-1).id);
  }
  const order = [];
  for (let i = 0; i < 10; i++) {
    const state = (await send("GET")).state;
    assert.equal(state.tasks.length, 1);
    order.push(state.tasks[0].text);
    assert.equal(state.lastCountScheduleId, state.tasks[0].sourceScheduleId);
    if (i < 9) {
      const result = await send("DELETE_TASK", { id: state.tasks[0].id });
      assert.equal(result.state.tasks.length, 1); // The next rule fills the newly freed slot.
    }
  }
  assert.deepEqual(order, ["A", "B", "C", "A", "B", "C", "A", "B", "C", "A"]);
  assert.equal(stored["cq.state.v2"].conversations["chat:dialogue-a"].lastCountScheduleId,
    schedules[0]);
  assert.deepEqual(Array.from((await send("GET")).state.schedules, (rule) => rule.runCount),
    [4, 3, 3]);
});

test("数量规则轮询进度可跨插件重启恢复，实际发送结束后补下一个", async () => {
  const first = await harness();
  await first.send("SAVE_SETTINGS", { maxPending: 1 });
  await first.send("ADD_SCHEDULE", { text: "A", mode: "count", threshold: 1 });
  await first.send("ADD_SCHEDULE", { text: "B", mode: "count", threshold: 1 });
  const copy = structuredClone(first.stored);
  const restored = await harness(copy);
  let state = (await restored.send("HELLO")).state;
  assert.equal(state.lastCountScheduleId, state.schedules[0].id);
  const claim = await restored.send("CLAIM", { ready: true, userCount: 0 });
  assert.equal(claim.dispatch.text, "A");
  await restored.send("SENT", { id: claim.dispatch.id });
  assert.equal((await restored.send("SCHEDULE_PULSE")).state.tasks.length, 1);
  restored.advance(3);
  state = (await restored.send("FINISHED", { ...voiceProof, id: claim.dispatch.id })).state;
  assert.deepEqual(Array.from(state.tasks, (task) => task.text), ["B"]);
  assert.equal(state.lastCountScheduleId, state.schedules[1].id);
});

test("数量轮询跳过停止与已达循环次数规则，并让空缺给其他规则", async () => {
  const { send } = await harness();
  await send("SAVE_SETTINGS", { maxPending: 1 });
  const a = (await send("ADD_SCHEDULE", {
    text: "一次性", mode: "count", threshold: 1, repeatCount: 0,
  })).state;
  assert.equal(a.schedules[0].enabled, false);
  await send("ADD_SCHEDULE", { text: "持续 B", mode: "count", threshold: 1 });
  const c = (await send("ADD_SCHEDULE", {
    text: "持续 C", mode: "count", threshold: 1,
  })).state;
  const disabledC = await send("TOGGLE_SCHEDULE", { id: c.schedules[2].id });
  assert.equal(disabledC.state.schedules[2].enabled, false);

  const sequence = [];
  for (let i = 0; i < 3; i++) {
    const state = (await send("GET")).state;
    sequence.push(state.tasks[0].text);
    await send("DELETE_TASK", { id: state.tasks[0].id });
  }
  assert.deepEqual(sequence, ["一次性", "持续 B", "持续 B"]);

  const enabledC = await send("TOGGLE_SCHEDULE", { id: c.schedules[2].id });
  assert.equal(enabledC.state.schedules[2].enabled, true);
  const bTask = enabledC.state.tasks[0];
  const next = await send("DELETE_TASK", { id: bTask.id });
  assert.equal(next.state.tasks[0].text, "持续 C");
});

test("数量模式每次检查最多遍历每条规则一次，保持时间模式独立计时", async () => {
  const { send, advance } = await harness({
    "cq.state.v2": {
      version: 2, conversations: {
        "chat:dialogue-a": {
          key: "chat:dialogue-a", url: A, tabId: 11, halted: false,
          activeTaskId: null, steeringTaskId: null, tasks: [], schedules: [
            { id: "a", text: "A", mode: "count", threshold: 5, enabled: true, repeatCount: -1 },
            { id: "time", text: "定时", mode: "time", intervalMinutes: 1,
              nextRunAt: Date.UTC(2026, 9, 15, 12, 1), enabled: true, repeatCount: -1 },
            { id: "b", text: "B", mode: "count", threshold: 5, enabled: true, repeatCount: -1 },
            { id: "c", text: "C", mode: "count", threshold: 5, enabled: true, repeatCount: -1 },
          ],
        },
      }, legacyUnbound: null,
    },
  });
  const afterFirst = (await send("HELLO")).state;
  assert.deepEqual(Array.from(afterFirst.tasks, (task) => task.text), ["A", "B", "C"]);
  assert.equal(afterFirst.schedules[1].runCount, undefined);
  const next = (await send("SCHEDULE_PULSE")).state;
  assert.deepEqual(Array.from(next.tasks, (task) => task.text), ["A", "B", "C", "A", "B"]);
  assert.equal(next.schedules[0].runCount, 2);
  assert.equal(next.schedules[2].runCount, 2);
  assert.equal(next.schedules[3].runCount, 1);
  advance(60);
  const due = (await send("SCHEDULE_PULSE")).state;
  assert.equal(due.tasks.length, 6); // Time trigger still adds one, even after count threshold.
  assert.equal(due.tasks[5].text, "定时");
});

test("数量检测补队按对话的滚动时间窗口限额，满额暂缓而不是删除任务", async () => {
  const { send, advance, stored } = await harness();
  const saved = await send("SAVE_COUNT_RATE_LIMIT", {
    enabled: true, windowMinutes: "10", maxAdds: "3",
  });
  assert.equal(saved.ok, true);
  assert.equal(saved.state.countRateLimit.enabled, true);
  assert.equal(saved.state.countRateLimit.windowMinutes, 10);
  assert.equal(saved.state.countRateLimit.maxAdds, 3);
  assert.equal("countRateLimit" in stored["cq.state.v2"].settings, false);
  await send("ADD_SCHEDULE", { text: "自动补入", mode: "count", threshold: 5 });
  await send("SCHEDULE_PULSE");
  const three = await send("SCHEDULE_PULSE");
  assert.equal(three.state.tasks.length, 3);
  assert.equal(three.state.countRateTimes.length, 3);
  assert.equal(three.state.schedules[0].runCount, 3);
  assert.equal((await send("SCHEDULE_PULSE")).state.tasks.length, 3);
  await send("ENQUEUE", { text: "手动添加不受限" });
  const four = (await send("SCHEDULE_PULSE")).state;
  assert.equal(four.tasks.length, 4);
  assert.equal(four.countRateTimes.length, 3);
  advance(599);
  assert.equal((await send("SCHEDULE_PULSE")).state.tasks.length, 4);
  advance(1);
  const resumed = (await send("SCHEDULE_PULSE")).state;
  assert.equal(resumed.tasks.length, 5);
  assert.equal(resumed.countRateTimes.length, 1);
  assert.equal(resumed.schedules[0].runCount, 4);
  assert.equal(resumed.tasks[4].text, "自动补入");
});

test("两段不同起点的补队事件按滚动窗口依次释放名额", async () => {
  const { send, advance } = await harness();
  await send("SAVE_COUNT_RATE_LIMIT", { enabled: true, windowMinutes: 10, maxAdds: 2 });
  await send("ADD_SCHEDULE", { text: "补入", mode: "count", threshold: 5 });
  advance(300);
  const second = (await send("SCHEDULE_PULSE")).state;
  assert.equal(second.tasks.length, 2);
  assert.equal(second.countRateTimes.length, 2);
  advance(299);
  assert.equal((await send("SCHEDULE_PULSE")).state.tasks.length, 2);
  advance(1);
  const third = (await send("SCHEDULE_PULSE")).state;
  assert.equal(third.tasks.length, 3);
  assert.equal(third.countRateTimes.length, 2);
  assert.equal((await send("SCHEDULE_PULSE")).state.tasks.length, 3);
  advance(300);
  const fourth = (await send("SCHEDULE_PULSE")).state;
  assert.equal(fourth.tasks.length, 4);
  assert.equal(fourth.countRateTimes.length, 2);
});

test("数量补队限额为每个对话分别保存；同对话所有数量规则共享额度", async () => {
  const { send, stored } = await harness();
  await send("SAVE_COUNT_RATE_LIMIT", { enabled: true, windowMinutes: 60, maxAdds: 1 }, 11);
  await send("SAVE_COUNT_RATE_LIMIT", { enabled: true, windowMinutes: 30, maxAdds: 2 }, 12);
  await send("ADD_SCHEDULE", { text: "A 规则甲", mode: "count", threshold: 5 }, 11);
  await send("ADD_SCHEDULE", { text: "A 规则乙", mode: "count", threshold: 5 }, 11);
  await send("ADD_SCHEDULE", { text: "B 规则", mode: "count", threshold: 5 }, 12);
  await send("SCHEDULE_PULSE", {}, 11);
  await send("SCHEDULE_PULSE", {}, 12);
  const a = (await send("GET", {}, 11)).state;
  const b = (await send("GET", {}, 12)).state;
  assert.equal(a.tasks.length, 1);
  assert.equal(a.schedules[1].runCount || 0, 0);
  assert.equal(a.countRateTimes.length, 1);
  assert.equal(b.tasks.length, 2);
  assert.equal(b.countRateTimes.length, 2);
  assert.equal(a.countRateLimit.maxAdds, 1);
  assert.equal(b.countRateLimit.maxAdds, 2);
  assert.equal(stored["cq.state.v2"].conversations["chat:dialogue-a"].countRateLimit.maxAdds, 1);
  assert.equal(stored["cq.state.v2"].conversations["chat:dialogue-b"].countRateLimit.maxAdds, 2);
  await send("SAVE_COUNT_RATE_LIMIT", { enabled: false, windowMinutes: 60, maxAdds: 1 }, 11);
  assert.equal((await send("GET", {}, 12)).state.countRateLimit.enabled, true);
  const moreA = (await send("SCHEDULE_PULSE", {}, 11)).state;
  assert.equal(moreA.tasks.length, 5); // Disabled limiter restores the original fill behavior.
});

test("数量补队限速满额时保持 A→B→C 公平轮询，不耗费未发生的入队次数", async () => {
  const { send, advance } = await harness();
  await send("SAVE_SETTINGS", { maxPending: 1 });
  await send("SAVE_COUNT_RATE_LIMIT", { enabled: true, windowMinutes: 10, maxAdds: 1 });
  for (const text of ["A", "B", "C"]) {
    await send("ADD_SCHEDULE", { text, mode: "count", threshold: 1 });
  }
  const order = [];
  for (let n = 0; n < 4; n++) {
    const current = (await send("GET")).state;
    assert.equal(current.tasks.length, 1);
    order.push(current.tasks[0].text);
    const removed = await send("DELETE_TASK", { id: current.tasks[0].id });
    assert.equal(removed.state.tasks.length, 0);
    assert.equal((await send("SCHEDULE_PULSE")).state.tasks.length, 0);
    if (n < 3) {
      advance(600);
      const refilled = await send("SCHEDULE_PULSE");
      assert.equal(refilled.state.tasks.length, 1);
    }
  }
  assert.deepEqual(order, ["A", "B", "C", "A"]);
  assert.deepEqual(Array.from((await send("GET")).state.schedules, (s) => s.runCount), [2, 1, 1]);
});

test("手动入队和按时间入队不消耗数量限额，限速只作用于数量检测", async () => {
  const { send, advance } = await harness();
  await send("SAVE_COUNT_RATE_LIMIT", { enabled: true, windowMinutes: 60, maxAdds: 1 });
  await send("ADD_SCHEDULE", { text: "按数量", mode: "count", threshold: 8 });
  await send("ADD_SCHEDULE", { text: "按时间", mode: "time", intervalMinutes: 1 });
  await send("ENQUEUE", { text: "手动" });
  await send("ADD_TASK", { text: "图文入口手动任务" });
  advance(60);
  const state = (await send("SCHEDULE_PULSE")).state;
  assert.deepEqual(Array.from(state.tasks, (task) => task.text),
    ["按数量", "手动", "图文入口手动任务", "按时间"]);
  assert.equal(state.countRateTimes.length, 1);
  assert.equal(state.schedules[0].runCount, 1);
  assert.equal(state.schedules[1].runCount, 1);
});

test("浏览器重启后仍保留当前对话的数量入队限额，旧存档默认不启用", async () => {
  const original = await harness();
  await original.send("SAVE_COUNT_RATE_LIMIT", { enabled: true, windowMinutes: 5, maxAdds: 1 });
  await original.send("ADD_SCHEDULE", { text: "只补一条", mode: "count", threshold: 5 });
  const restarted = await harness(structuredClone(original.stored));
  assert.equal((await restarted.send("HELLO")).state.countRateTimes.length, 1);
  const current = (await restarted.send("GET")).state;
  await restarted.send("DELETE_TASK", { id: current.tasks[0].id });
  assert.equal((await restarted.send("SCHEDULE_PULSE")).state.tasks.length, 0);
  restarted.advance(300);
  assert.equal((await restarted.send("SCHEDULE_PULSE")).state.tasks.length, 1);
  const old = await harness({
    "cq.state.v2": { version: 2, conversations: {
      "chat:dialogue-a": {
        key: "chat:dialogue-a", url: A, tabId: 11, halted: false,
        activeTaskId: null, steeringTaskId: null, tasks: [], schedules: [],
      },
    }, legacyUnbound: null },
  });
  assert.equal((await old.send("GET")).state.countRateLimit, undefined);
  await old.send("ADD_SCHEDULE", { text: "旧存档补队", mode: "count", threshold: 2 });
  assert.equal((await old.send("SCHEDULE_PULSE")).state.tasks.length, 2);
});

test("每个对话限速配置严格校验，非法值不能改变记录，禁止串对话设置", async () => {
  const { send, stored } = await harness();
  await send("SAVE_COUNT_RATE_LIMIT", { enabled: true, windowMinutes: 10, maxAdds: 4 });
  for (const malformed of [
    { enabled: "false", windowMinutes: 10, maxAdds: 4 },
    { enabled: true, windowMinutes: 0, maxAdds: 4 },
    { enabled: true, windowMinutes: 1441, maxAdds: 4 },
    { enabled: true, windowMinutes: "", maxAdds: 4 },
    { enabled: true, windowMinutes: null, maxAdds: 4 },
    { enabled: true, windowMinutes: 2.5, maxAdds: 4 },
    { enabled: true, windowMinutes: 10, maxAdds: 0 },
    { enabled: true, windowMinutes: 10, maxAdds: 201 },
    { enabled: true, windowMinutes: 10, maxAdds: "" },
    { enabled: true, windowMinutes: 10, maxAdds: 2.3 },
    { enabled: true, windowMinutes: 10 },
  ]) {
    assert.equal((await send("SAVE_COUNT_RATE_LIMIT", malformed)).ok, false, JSON.stringify(malformed));
  }
  assert.equal((await send("SAVE_COUNT_RATE_LIMIT", {
    enabled: false, windowMinutes: 10, maxAdds: 1,
  }, 12, A)).ok, false);
  const saved = (await send("GET")).state.countRateLimit;
  assert.equal(saved.enabled, true);
  assert.equal(saved.windowMinutes, 10);
  assert.equal(saved.maxAdds, 4);
  assert.equal(stored["cq.state.v2"].settings?.countRateLimit, undefined);
});

test("数量模式尊重循环上限、停用状态及输入校验", async () => {
  const { send } = await harness();
  const invalid = [0, -1, 1.5, "", "NaN", 201];
  for (const threshold of invalid) {
    assert.equal((await send("ADD_SCHEDULE", {
      text: "无效阈值", mode: "count", threshold,
    })).ok, false);
  }
  assert.equal((await send("ADD_SCHEDULE", { text: "未知模式", mode: "other" })).ok, false);
  assert.equal((await send("GET")).state.schedules.length, 0);

  const added = await send("ADD_SCHEDULE", {
    text: "最多两次", mode: "count", threshold: 4, repeatCount: 1,
  });
  const id = added.state.schedules[0].id;
  const next = await send("SCHEDULE_PULSE");
  assert.equal(next.state.tasks.length, 2);
  assert.equal(next.state.schedules[0].enabled, false);
  assert.equal((await send("SCHEDULE_PULSE")).state.tasks.length, 2);
  const paused = await send("TOGGLE_SCHEDULE", { id });
  assert.equal(paused.state.schedules[0].runCount, 1); // 恢复后开启新循环，并入队一次。
  assert.equal(paused.state.schedules[0].enabled, true);
  const stopped = await send("TOGGLE_SCHEDULE", { id });
  assert.equal(stopped.state.schedules[0].enabled, false);
  assert.equal((await send("SCHEDULE_PULSE")).state.tasks.length, 3);
});

test("队列上限设置全局保存、每个对话单独生效，手动和自动入队共同受限", async () => {
  const { send, tick, stored } = await harness();
  assert.equal((await send("GET")).settings.maxPending, 100);
  for (const invalid of [0, -1, 1.5, "", "oops", 201]) {
    assert.equal((await send("SAVE_SETTINGS", { maxPending: invalid })).ok, false);
  }
  assert.equal((await send("SAVE_SETTINGS", { maxPending: "2" })).settings.maxPending, 2);
  assert.equal(stored["cq.state.v2"].settings.maxPending, 2);
  await send("ENQUEUE", { text: "A-1" }, 11);
  await send("ENQUEUE", { text: "A-2" }, 11);
  assert.equal((await send("ENQUEUE", { text: "超额" }, 11)).ok, false);
  assert.equal((await send("ADD_SCHEDULE", {
    text: "阈值太大", mode: "count", threshold: 3,
  }, 11)).ok, false);
  await send("ADD_SCHEDULE", { text: "A-定时", intervalMinutes: 1 }, 11);
  await tick(1); // 满额时到期但不能入队。
  assert.equal((await send("GET", {}, 11)).state.tasks.length, 2);
  const first = (await send("GET", {}, 11)).state.tasks[0];
  const freed = await send("DELETE_TASK", { id: first.id }, 11);
  assert.equal(freed.state.tasks.length, 2); // 空位立即由到期定时器补入。
  assert.equal(freed.state.tasks.some((task) => task.text === "A-定时"), true);

  await send("ADD_SCHEDULE", { text: "B-补队", mode: "count", threshold: 2 }, 12);
  await send("SCHEDULE_PULSE", {}, 12);
  assert.equal((await send("GET", {}, 12)).state.tasks.length, 2);
  assert.equal((await send("ENQUEUE", { text: "B-超额" }, 12)).ok, false);
  const reduced = await send("SAVE_SETTINGS", { maxPending: 1 }, 11);
  assert.equal(reduced.state.tasks.length, 2); // 调低上限不删除旧任务。
  assert.equal((await send("GET", {}, 12)).settings.maxPending, 1);
  assert.equal((await send("ENQUEUE", { text: "仍超额" }, 11)).ok, false);
});

test("自动任务全局默认间隔和循环次数可保存并应用到新建任务，刷新后保持", async () => {
  const first = await harness();
  const { send, stored } = first;
  const before = await send("GET");
  assert.equal(before.settings.defaultIntervalMinutes, 30);
  assert.equal(before.settings.defaultRepeatCount, -1);

  const saved = await send("SAVE_SETTINGS", {
    maxPending: 100, defaultIntervalMinutes: "12", defaultRepeatCount: "3",
  });
  assert.equal(saved.settings.defaultIntervalMinutes, 12);
  assert.equal(saved.settings.defaultRepeatCount, 3);
  assert.equal(stored["cq.state.v2"].settings.defaultIntervalMinutes, 12);
  assert.equal(stored["cq.state.v2"].settings.defaultRepeatCount, 3);
  assert.equal((await send("GET", {}, 12)).settings.defaultIntervalMinutes, 12);
  assert.equal((await send("GET", {}, 12)).settings.defaultRepeatCount, 3);

  const time = (await send("ADD_SCHEDULE", { text: "新定时" }, 12)).state.schedules[0];
  assert.equal(time.intervalMinutes, 12);
  assert.equal(time.repeatCount, 3);
  assert.equal(time.nextRunAt - Date.UTC(2026, 9, 15, 12, 0), 12 * 60_000);
  const count = (await send("ADD_SCHEDULE", {
    text: "新补队", mode: "count", threshold: 2,
  }, 11)).state.schedules[0];
  assert.equal(count.repeatCount, 3);
  assert.equal(count.intervalMinutes, null);

  const restarted = await harness(structuredClone(stored));
  const restored = await restarted.send("GET", {}, 12);
  assert.equal(restored.settings.defaultIntervalMinutes, 12);
  assert.equal(restored.settings.defaultRepeatCount, 3);
  const newlyAdded = (await restarted.send("ADD_SCHEDULE", { text: "重启后新任务" }, 12))
    .state.schedules[1];
  assert.equal(newlyAdded.intervalMinutes, 12);
  assert.equal(newlyAdded.repeatCount, 3);
});

test("更改自动任务默认值不会改变既有任务，也不影响显式选择的间隔与次数", async () => {
  const { send } = await harness();
  const original = (await send("ADD_SCHEDULE", {
    text: "已有独立任务", intervalMinutes: 7, repeatCount: 1,
  })).state.schedules[0];
  assert.equal(original.intervalMinutes, 7);
  assert.equal(original.repeatCount, 1);

  await send("SAVE_SETTINGS", {
    maxPending: 100, defaultIntervalMinutes: 90, defaultRepeatCount: 0,
  });
  const after = (await send("GET")).state.schedules[0];
  assert.equal(after.intervalMinutes, 7);
  assert.equal(after.repeatCount, 1);
  assert.equal(after.nextRunAt, original.nextRunAt);
  const explicit = (await send("ADD_SCHEDULE", {
    text: "单独覆盖默认值", intervalMinutes: 2, repeatCount: -1,
  })).state.schedules[1];
  assert.equal(explicit.intervalMinutes, 2);
  assert.equal(explicit.repeatCount, -1);
  const noRepeat = (await send("ADD_SCHEDULE", { text: "默认单次" })).state.schedules[2];
  assert.equal(noRepeat.intervalMinutes, 90);
  assert.equal(noRepeat.repeatCount, 0);

  await send("SAVE_SETTINGS", { maxPending: 50 });
  const preserved = await send("GET");
  assert.equal(preserved.settings.defaultIntervalMinutes, 90);
  assert.equal(preserved.settings.defaultRepeatCount, 0);
  const edited = (await send("EDIT_SCHEDULE", {
    id: original.id, text: "编辑独立任务", mode: "time",
    intervalMinutes: 6, repeatCount: 4,
  })).state.schedules[0];
  assert.equal(edited.intervalMinutes, 6);
  assert.equal(edited.repeatCount, 4);
});

test("默认间隔和默认循环次数必须合法，保存过程是原子的", async () => {
  const { send, stored } = await harness();
  await send("SAVE_SETTINGS", {
    maxPending: 100, defaultIntervalMinutes: 40, defaultRepeatCount: 4,
  });
  for (const minutes of ["", null, undefined, 0, -2, 1.5, "nan", 525601]) {
    const result = await send("SAVE_SETTINGS", {
      maxPending: 3, defaultIntervalMinutes: minutes, defaultRepeatCount: 1,
    });
    assert.equal(result.ok, false, String(minutes));
  }
  for (const repeats of ["", null, undefined, -2, 1.5, "nan", 1_000_001]) {
    const result = await send("SAVE_SETTINGS", {
      maxPending: 3, defaultIntervalMinutes: 15, defaultRepeatCount: repeats,
    });
    assert.equal(result.ok, false, String(repeats));
  }
  const current = await send("GET");
  assert.equal(current.settings.maxPending, 100);
  assert.equal(current.settings.defaultIntervalMinutes, 40);
  assert.equal(current.settings.defaultRepeatCount, 4);
  assert.equal(stored["cq.state.v2"].settings.defaultRepeatCount, 4);
});

test("已存在的旧版 v2 设置没有自动任务默认值时使用 30 分钟与无限循环", async () => {
  const { send } = await harness({
    "cq.state.v2": {
      version: 2, conversations: {}, legacyUnbound: null,
      settings: { maxPending: 25, protectBackground: false },
    },
  });
  const result = await send("GET");
  assert.equal(result.settings.defaultIntervalMinutes, 30);
  assert.equal(result.settings.defaultRepeatCount, -1);
  const updated = await send("SAVE_SETTINGS", {
    maxPending: 25, defaultIntervalMinutes: 5, defaultRepeatCount: 2,
  });
  assert.equal(updated.settings.protectBackground, false);
  assert.equal(updated.settings.defaultIntervalMinutes, 5);
  assert.equal(updated.settings.defaultRepeatCount, 2);
});

test("图文队列持久化原图、队列状态只保存缩略图，完成任务后清理原图", async () => {
  const { send, stored, storedImages, advance } = await harness();
  const added = await send("ENQUEUE", { text: "", images: [testImage] });
  assert.equal(added.ok, true);
  const task = added.state.tasks[0];
  assert.equal(task.text, "");
  assert.equal(task.images.length, 1);
  assert.equal(task.images[0].name, "示例.png");
  assert.equal(task.images[0].dataUrl, undefined);
  assert.equal(storedImages.size, 1);
  assert.equal(JSON.stringify(stored["cq.state.v2"]).includes(testImage.dataUrl), false);
  assert.equal((await send("GET_TASK_IMAGES", { id: task.id })).ok, false);
  const claim = await send("CLAIM", { ready: true });
  assert.equal(claim.dispatch.images.length, 1);
  const image = await send("GET_TASK_IMAGES", { id: task.id });
  assert.equal(image.images[0].dataUrl, testImage.dataUrl);
  assert.equal((await send("GET_TASK_IMAGES", { id: task.id }, 12)).ok, false);
  await send("SENT", { id: task.id });
  advance(3);
  await send("FINISHED", { id: task.id, ...voiceProof });
  assert.equal((await send("GET")).state.tasks.length, 0);
  assert.equal(storedImages.size, 0);
});

test("自动任务图片被队列复用，删除规则不会误删仍在排队的原图", async () => {
  const { send, storedImages } = await harness();
  const added = await send("ADD_SCHEDULE", {
    text: "检查这张图", images: [testImage],
    mode: "count", threshold: 1, repeatCount: 0,
  });
  assert.equal(added.state.tasks.length, 1);
  const schedule = added.state.schedules[0];
  assert.equal(added.state.tasks[0].images[0].id, schedule.images[0].id);
  await send("DELETE_SCHEDULE", { id: schedule.id });
  assert.equal(storedImages.size, 1);
  const task = (await send("GET")).state.tasks[0];
  await send("DELETE_TASK", { id: task.id });
  assert.equal(storedImages.size, 0);
});

test("修改图文队列可保留/移除旧图，损坏图片无法入队", async () => {
  const { send, storedImages } = await harness();
  for (const invalid of [
    { ...testImage, dataUrl: "data:image/svg+xml;base64,PHN2Zz4=" },
    { ...testImage, dataUrl: "data:image/png;base64,YWJj" },
    { ...testImage, thumbnail: "javascript:alert(1)" },
  ]) {
    assert.equal((await send("ENQUEUE", { text: "非法", images: [invalid] })).ok, false);
  }
  assert.equal((await send("ENQUEUE", { text: "太多", images: Array(5).fill(testImage) })).ok, false);
  assert.equal(storedImages.size, 0);
  const first = await send("ENQUEUE", { text: "初始", images: [testImage] });
  const task = first.state.tasks[0];
  const changed = await send("EDIT_TASK", {
    id: task.id, text: "图片说明", keepImageIds: [task.images[0].id],
  });
  assert.equal(changed.state.tasks[0].images.length, 1);
  assert.equal((await send("EDIT_TASK", {
    id: task.id, text: "其他引用", keepImageIds: ["foreign-id"],
  })).ok, false);
  const cleared = await send("EDIT_TASK", {
    id: task.id, text: "去除图片", keepImageIds: [],
  });
  assert.equal(cleared.state.tasks[0].images.length, 0);
  assert.equal(storedImages.size, 0);
});

test("repeatCount 0 schedules exactly one occurrence then disables itself", async () => {
  const { send, tick } = await harness();
  const added = await send("ADD_SCHEDULE", {
    text: "只做一次", intervalMinutes: 2, repeatCount: 0,
  });
  assert.equal(added.state.schedules[0].runCount, 0);
  assert.equal(added.state.schedules[0].repeatCount, 0);

  await tick(2);
  const first = await send("GET");
  assert.equal(first.state.tasks.length, 1);
  assert.equal(first.state.schedules[0].enabled, false);
  assert.equal(first.state.schedules[0].runCount, 1);

  await send("DELETE_TASK", { id: first.state.tasks[0].id });
  await tick(30);
  const after = await send("GET");
  assert.equal(after.state.tasks.length, 0);
  assert.equal(after.state.schedules[0].runCount, 1);
});

test("repeatCount N creates N+1 queue items at time intervals even if earlier tasks are still pending", async () => {
  const { send, tick } = await harness();
  await send("ADD_SCHEDULE", { text: "总共三次", intervalMinutes: 1, repeatCount: 2 });

  await tick(1);
  let state = (await send("GET")).state;
  assert.equal(state.schedules[0].runCount, 1);
  assert.equal(state.schedules[0].enabled, true);
  // Even with a full conversation still waiting to be dispatched, the
  // next due interval becomes a new pending item (not a deferred reply).
  await tick(7);
  state = (await send("GET")).state;
  assert.equal(state.tasks.length, 2);
  assert.equal(state.schedules[0].runCount, 2);
  assert.equal(state.tasks[0].status, "pending");
  assert.equal(state.tasks[1].status, "pending");

  await tick(1);
  state = (await send("GET")).state;
  assert.equal(state.tasks.length, 3);
  assert.equal(state.schedules[0].runCount, 3);
  assert.equal(state.schedules[0].enabled, false);
  assert.equal(new Set(state.tasks.map((task) => task.id)).size, 3);
  await tick(20);
  assert.equal((await send("GET")).state.tasks.length, 3);
});

test("repeatCount -1 remains enabled and skips catchup bursts", async () => {
  const { send, tick } = await harness();
  await send("ADD_SCHEDULE", { text: "无限执行", intervalMinutes: 1, repeatCount: -1 });
  await tick(12); // 12 intervals elapsed while the machine was asleep.
  let current = (await send("GET")).state;
  assert.equal(current.tasks.length, 1);
  assert.equal(current.schedules[0].runCount, 1);
  assert.equal(current.schedules[0].enabled, true);
  const afterNext = current.schedules[0].nextRunAt;
  await send("DELETE_TASK", { id: current.tasks[0].id });
  await tick(1);
  current = (await send("GET")).state;
  assert.equal(current.schedules[0].runCount, 2);
  assert.equal(current.schedules[0].nextRunAt, afterNext + 60_000);
});

test("re-enabling an exhausted one-shot restarts its count, editing resets finite cycle", async () => {
  const { send, tick } = await harness();
  const initial = await send("ADD_SCHEDULE", {
    text: "一次", intervalMinutes: 1, repeatCount: 0,
  });
  const id = initial.state.schedules[0].id;
  await tick(1);
  let current = (await send("GET")).state;
  assert.equal(current.schedules[0].runCount, 1);
  await send("DELETE_TASK", { id: current.tasks[0].id });

  current = (await send("TOGGLE_SCHEDULE", { id })).state;
  assert.equal(current.schedules[0].enabled, true);
  assert.equal(current.schedules[0].runCount, 0);
  await tick(1);
  current = (await send("GET")).state;
  assert.equal(current.schedules[0].runCount, 1);
  assert.equal(current.schedules[0].enabled, false);

  current = (await send("EDIT_SCHEDULE", {
    id, text: "三次", intervalMinutes: 2, repeatCount: 2,
  })).state;
  assert.equal(current.schedules[0].text, "三次");
  assert.equal(current.schedules[0].repeatCount, 2);
  assert.equal(current.schedules[0].runCount, 0);
  assert.equal(current.schedules[0].enabled, false); // Editing does not override disabled status.
  current = (await send("TOGGLE_SCHEDULE", { id })).state;
  assert.equal(current.schedules[0].enabled, true);
  assert.equal(current.schedules[0].runCount, 0);
});

test("invalid repeatCount is rejected without modifying saved scheduler", async () => {
  const { send } = await harness();
  const invalid = [-2, 1.5, "", "NaN", 1_000_001];
  for (const repeatCount of invalid) {
    assert.equal((await send("ADD_SCHEDULE", {
      text: "不应该创建", intervalMinutes: 1, repeatCount,
    })).ok, false);
  }
  assert.equal((await send("GET")).state.schedules.length, 0);

  const add = await send("ADD_SCHEDULE", { text: "正常", intervalMinutes: 1, repeatCount: 0 });
  const scheduleId = add.state.schedules[0].id;
  assert.equal((await send("EDIT_SCHEDULE", {
    id: scheduleId, text: "非法编辑", intervalMinutes: 1, repeatCount: -2,
  })).ok, false);
  assert.equal((await send("GET")).state.schedules[0].text, "正常");
});

test("existing v2 schedules without repeatCount keep the prior infinite behavior", async () => {
  const { send, tick } = await harness({
    "cq.state.v2": {
      version: 2, conversations: {
        "chat:dialogue-a": {
          key: "chat:dialogue-a", url: A, tabId: 11, halted: false,
          activeTaskId: null, autoOpenTab: false, error: "", tasks: [],
          schedules: [{
            id: "legacy-v2-timer", text: "旧定时", intervalMinutes: 1,
            enabled: true, nextRunAt: Date.UTC(2026, 9, 15, 12, 1),
          }],
        },
      },
      legacyUnbound: null,
    },
  });
  await tick(1);
  let current = (await send("GET")).state;
  assert.equal(current.tasks.length, 1);
  assert.equal(current.schedules[0].enabled, true);
  assert.equal(current.schedules[0].runCount, 1);
  await send("DELETE_TASK", { id: current.tasks[0].id });
  await tick(1);
  current = (await send("GET")).state;
  assert.equal(current.schedules[0].runCount, 2);
  assert.equal(current.schedules[0].enabled, true);
});

test("A/B scheduler repeat counts remain isolated", async () => {
  const { send, tick } = await harness();
  await send("ADD_SCHEDULE", { text: "A 单次", intervalMinutes: 1, repeatCount: 0 }, 11);
  await send("ADD_SCHEDULE", { text: "B 无限", intervalMinutes: 1, repeatCount: -1 }, 12);
  await tick(1);
  const stateA = (await send("GET", {}, 11)).state;
  const stateB = (await send("GET", {}, 12)).state;
  assert.equal(stateA.schedules[0].enabled, false);
  assert.equal(stateA.schedules[0].runCount, 1);
  assert.equal(stateB.schedules[0].enabled, true);
  assert.equal(stateB.schedules[0].runCount, 1);
});

test("native Stop halts only its chat and manual new user turn resumes its queue", async () => {
  const { send } = await harness();
  await send("ENQUEUE", { text: "A 第一条" }, 11);
  await send("ENQUEUE", { text: "A 第二条" }, 11);
  await send("ENQUEUE", { text: "B 第一条" }, 12);
  const a = await send("CLAIM", { ready: true, userCount: 0, assistantCount: 0 }, 11);
  await send("SENT", { id: a.dispatch.id }, 11);
  const stopped = await send("STOPPED", { userCount: 1 }, 11);
  assert.equal(stopped.state.halted, true);
  assert.equal(stopped.state.tasks[0].status, "interrupted");
  assert.equal(stopped.state.activeTaskId, null);
  assert.equal((await send("CLAIM", { ready: true }, 11)).dispatch, null);
  await send("ENQUEUE", { text: "停下后继续排队" }, 11);
  assert.equal((await send("GET", {}, 11)).state.halted, true);
  assert.equal((await send("USER_RESUMED", { userCount: 1, lastUserText: "旧消息" }, 11)).state.halted, true);
  assert.equal((await send("CLAIM", { ready: true }, 12)).dispatch.text, "B 第一条");
  const resumed = await send("USER_RESUMED", { userCount: 2, lastUserText: "新消息" }, 11);
  assert.equal(resumed.state.halted, false);
  assert.equal((await send("CLAIM", { ready: true }, 11)).dispatch.text, "A 第二条");
});

test("legacy v1 data migrates into bound chat with done tasks removed", async () => {
  const { send, stored } = await harness({
    "cq.state.v1": {
      version: 1, target: { url: A, tabId: 11 }, paused: false,
      tasks: [
        { id: "old", text: "保留", status: "pending" },
        { id: "done", text: "已完成", status: "done" },
      ],
      schedules: [{ id: "periodic", text: "旧定时", intervalMinutes: 2, enabled: false, nextRunAt: Date.now() + 999_999 }],
    },
  });
  const a = await send("GET", {}, 11);
  assert.equal(a.state.tasks.length, 1);
  assert.equal(a.state.tasks[0].text, "保留");
  assert.equal(a.state.schedules.length, 1);
  assert.equal((await send("GET", {}, 12)).state.tasks.length, 0);
  assert.equal(stored["cq.state.v2"].version, 2);
});

test("new chat draft queue and its timer move to a confirmed conversation ID", async () => {
  const { send, navigate } = await harness();
  await send("ENQUEUE", { text: "建立对话" }, 13);
  await send("ADD_SCHEDULE", { text: "之后巡检", intervalMinutes: 4 }, 13);
  const claimed = await send("CLAIM", { ready: true }, 13);
  assert.equal(claimed.state.key, "draft:13");
  navigate(13, "https://chatgpt.com/c/fresh-chat");
  const unrelated = await send("HELLO", { lastUserText: "别的消息" }, 13);
  assert.equal(unrelated.state.tasks.length, 0);
  const adopted = await send("HELLO", { lastUserText: "建立对话" }, 13);
  assert.equal(adopted.state.key, "chat:fresh-chat");
  assert.equal(adopted.state.schedules.length, 1);
  const sent = await send("SENT", { id: claimed.dispatch.id, lastUserText: "建立对话" }, 13);
  assert.equal(sent.state.tasks[0].status, "waiting");
});

test("switching tab away leaves queued tasks bound to their chat, not the next page", async () => {
  const { send, navigate } = await harness();
  await send("ENQUEUE", { text: "A 任务" }, 11);
  const claimed = await send("CLAIM", { ready: true }, 11);
  navigate(11, B);
  assert.equal((await send("SENT", { id: claimed.dispatch.id }, 11)).ok, false);
  assert.equal((await send("GET", {}, 12)).state.activeTaskId, null);
  navigate(11, A);
  assert.equal((await send("GET", {}, 11)).state.activeTaskId, claimed.dispatch.id);
});

test("发送后不再确认消息气泡，语音按钮恢复就释放等待锁", async () => {
  const { send, advance } = await harness();
  await send("ENQUEUE", { text: "回复我x++ x=1" });
  await send("ENQUEUE", { text: "第二次测试" });
  const first = await send("CLAIM", {
    ready: true, userCount: 2, assistantCount: 2, lastUserId: "user-2",
  });
  const id = first.dispatch.id;
  const clicked = await send("SENT", { id });
  assert.equal(clicked.state.tasks[0].status, "waiting");
  assert.equal("deliveryVerified" in clicked.state.tasks[0], false);
  advance(24); // Previously the content script failed at 18 seconds.
  const waiting = await send("GET");
  assert.equal(waiting.state.halted, false);
  assert.equal(waiting.state.activeTaskId, id);
  assert.equal(waiting.state.tasks[1].status, "pending");
  assert.equal((await send("CLAIM", { ready: true })).dispatch, null);
  const finished = await send("FINISHED", {
    ...voiceProof, id,
  });
  assert.equal(finished.state.tasks.length, 1);
  assert.equal(finished.state.halted, false);
  assert.equal((await send("CLAIM", { ready: true, userCount: 3, assistantCount: 3 })).dispatch.text,
    "第二次测试");
});

test("发送后的唯一完成信号是语音按钮，助手内容及消息数量不影响队列释放", async () => {
  const { send, advance } = await harness();
  await send("ENQUEUE", { text: "工具处理很久" });
  const first = await send("CLAIM", { ready: true, assistantCount: 2, userCount: 2 });
  await send("SENT", { id: first.dispatch.id });
  advance(17);
  const evidence = {
    ...voiceProof,
    id: first.dispatch.id,
    assistantCount: 2, lastRole: "user", lastUserText: "完全不匹配的消息",
    editorEmpty: true, busy: false, toolPending: true,
    assistantTextLength: 0,
  };
  assert.equal((await send("FINISHED", { ...evidence, voiceReady: false })).ok, false);
  assert.equal((await send("FINISHED", { ...evidence, busy: true })).ok, false);
  assert.equal((await send("FINISHED", { ...evidence, voiceStableMs: 800 })).ok, false);
  assert.equal((await send("FINISHED", { ...evidence, editorEmpty: false })).ok, false);
  assert.equal((await send("GET")).state.tasks[0].status, "waiting");
  const recovered = await send("FINISHED", evidence);
  assert.equal(recovered.state.tasks.length, 0);
  assert.equal(recovered.state.halted, false);
});

test("infinite timer completes five successive delayed tool conversations", async () => {
  const { send, tick, advance } = await harness();
  const created = await send("ADD_SCHEDULE", {
    text: "周期巡检", intervalMinutes: 10, repeatCount: -1,
  });
  const scheduleId = created.state.schedules[0].id;
  for (let iteration = 1; iteration <= 5; iteration++) {
    await tick(10);
    const scheduled = (await send("GET")).state;
    assert.equal(scheduled.schedules[0].enabled, true);
    assert.equal(scheduled.schedules[0].runCount, iteration);
    assert.equal(scheduled.tasks.length, 1);
    assert.equal(scheduled.tasks[0].sourceScheduleId, scheduleId);
    const started = await send("CLAIM", {
      ready: true, userCount: iteration, assistantCount: iteration,
    });
    const id = started.dispatch.id;
    await send("SENT", { id, verified: false });
    advance(25); // Each answer takes >18 seconds.
    const result = await send("FINISHED", {
      ...voiceProof,
      id, assistantFallback: true, assistantCount: iteration + 1,
      stableMs: 16000, editorEmpty: true, lastRole: "assistant",
      busy: false, toolPending: false, assistantTextLength: 23,
      assistantAdvanced: true,
    });
    assert.equal(result.ok, true);
    assert.equal(result.state.tasks.length, 0);
    assert.equal(result.state.halted, false);
  }
  const stillRunning = (await send("GET")).state;
  assert.equal(stillRunning.schedules[0].enabled, true);
  assert.equal(stillRunning.schedules[0].repeatCount, -1);
});

test("manual review can skip a previously failed task without resending it", async () => {
  const { send } = await harness();
  await send("ENQUEUE", { text: "之前可能已发送" });
  await send("ENQUEUE", { text: "下一条" });
  const started = await send("CLAIM", { ready: true });
  await send("FAIL", { id: started.dispatch.id, error: "发送结果未确认，可能已发送" });
  const failed = (await send("GET")).state;
  assert.equal(failed.halted, true);
  assert.equal(failed.tasks[0].status, "error");
  const skipped = await send("SKIP_FAILED", { id: started.dispatch.id });
  assert.equal(skipped.state.halted, false);
  assert.equal(skipped.state.error, "");
  assert.equal(skipped.state.tasks.length, 1);
  assert.equal(skipped.state.tasks[0].text, "下一条");
  assert.equal((await send("CLAIM", { ready: true })).dispatch.text, "下一条");
});

test("project GPT nested conversation URL owns the same chat queue by conversation id", async () => {
  const { send, navigate } = await harness();
  navigate(11, "https://chatgpt.com/g/p-123456-project0/c/project-chat-id");
  const added = await send("ENQUEUE", { text: "项目对话任务" });
  assert.equal(added.state.key, "chat:project-chat-id");
  navigate(11, "https://chatgpt.com/c/project-chat-id");
  const restored = await send("HELLO");
  assert.equal(restored.state.key, "chat:project-chat-id");
  assert.equal(restored.state.tasks.length, 1);
});

test("项目主页本次停留可从收藏启动，离开后清理未发队列，已有聊天仍各自隔离", async () => {
  const env = await harness();
  const overview = "https://chatgpt.com/g/g-p-0123456789abcdef0123456789abcdef-pcc/project";
  const first = "https://chatgpt.com/g/g-p-0123456789abcdef0123456789abcdef-pcc/c/first-chat";
  const second = "https://chatgpt.com/g/g-p-0123456789abcdef0123456789abcdef-pcc/c/second-chat";
  env.navigate(11,overview);
  const visit = {projectVisitId:"project-visit-one"};
  const hello = await env.send("HELLO",visit,11,overview);
  assert.equal(hello.ok,true);
  assert.equal(hello.state.tasks.length,0);
  assert.equal(hello.sessionKey,"draft:11");
  assert.equal(Object.hasOwn(env.stored["cq.state.v2"].conversations,"draft:11"),false);
  const favorite=(await env.sendDashboard("ADD_FAVORITE",{text:"收藏启动内容"})).favorites[0];
  const queued=await env.send("ENQUEUE_FAVORITE",{...visit,favoriteId:favorite.id},11,overview,{url:overview});
  assert.equal(queued.ok,true);
  assert.deepEqual(Array.from(queued.state.tasks,t=>t.text),["收藏启动内容"]);
  assert.equal(queued.state.projectVisitId,visit.projectVisitId);

  env.navigate(11,first);
  assert.equal((await env.send("ENQUEUE",{text:"第一个对话"},11,first)).state.key,"chat:first-chat");
  assert.equal(Object.hasOwn(env.stored["cq.state.v2"].conversations,"draft:11"),false);
  env.navigate(11,second);
  const other = await env.send("ENQUEUE",{text:"第二个对话"},11,second);
  assert.deepEqual(Array.from(other.state.tasks,t=>t.text),["第二个对话"]);
  env.navigate(11,overview);
  assert.equal((await env.send("HELLO",{projectVisitId:"project-visit-two"},11,overview)).state.tasks.length,0);
  assert.equal((await env.sendDashboard("DASHBOARD_GET")).dashboard.sessions
    .some(s=>s.key==="draft:11"),false);
  env.navigate(11,first);
  const resumed=await env.send("HELLO",{},11,first);
  assert.deepEqual(Array.from(resumed.state.tasks,t=>t.text),["第一个对话"]);
  assert.equal(Object.keys(env.stored["cq.state.v2"].conversations).length,2);
});

test("普通新建页的已有草稿不能带入 Project 页面，已有内容不自动删除",async()=>{
  const env=await harness();
  await env.send("ENQUEUE",{text:"原本在新建对话里的草稿"},13);
  const before=JSON.stringify(env.stored["cq.state.v2"].conversations["draft:13"]);
  const overview="https://chatgpt.com/g/g-p-example-old/project";
  env.navigate(13,overview);
  const project=await env.send("HELLO",{projectVisitId:"project-visit"},13,overview);
  assert.equal(project.ok,false);
  assert.match(project.error,/其他页面/);
  assert.equal(JSON.stringify(env.stored["cq.state.v2"].conversations["draft:13"]),before);
});

test("项目主页换一次停留清理未发送任务，发送中的首条任务保留并按同项目接管",async()=>{
  const env=await harness();
  const overview="https://chatgpt.com/g/g-p-visit-test/project";
  const other="https://chatgpt.com/g/g-p-other/c/unrelated";
  const chat="https://chatgpt.com/g/g-p-visit-test/c/created";
  env.navigate(11,overview);
  await env.send("ENQUEUE",{projectVisitId:"visit-one",text:"旧停留待发内容"},11,overview);
  const fresh=await env.send("HELLO",{projectVisitId:"visit-two"},11,overview);
  assert.equal(fresh.state.tasks.length,0);
  assert.equal(Object.hasOwn(env.stored["cq.state.v2"].conversations,"draft:11"),false);
  await env.send("ENQUEUE",{projectVisitId:"visit-two",text:"项目开场消息"},11,overview);
  const claimed=await env.send("CLAIM",{projectVisitId:"visit-two",ready:true,userCount:0},11,overview);
  assert.ok(claimed.dispatch);
  const staleVisit=await env.send("HELLO",{projectVisitId:"visit-three"},11,overview);
  assert.equal(staleVisit.ok,false);
  assert.equal(env.stored["cq.state.v2"].conversations["draft:11"].activeTaskId,claimed.dispatch.id);
  env.navigate(11,other);
  const wrong=await env.send("HELLO",{lastUserText:"项目开场消息"},11,other);
  assert.equal(wrong.state.key,"chat:unrelated");
  assert.equal(env.stored["cq.state.v2"].conversations["draft:11"].activeTaskId,claimed.dispatch.id);
  env.navigate(11,chat);
  const pending=await env.send("HELLO",{lastUserText:""},11,chat);
  assert.equal(pending.sessionKey,"draft:11");
  assert.equal(pending.awaitingChatConfirmation,true);
  const adopted=await env.send("HELLO",{lastUserText:"项目开场消息"},11,chat);
  assert.equal(adopted.state.key,"chat:created");
  assert.equal(adopted.state.tasks[0].status,"waiting");
  assert.equal(Object.hasOwn(adopted.state,"projectVisitId"),false);
  assert.equal(Object.hasOwn(env.stored["cq.state.v2"].conversations,"draft:11"),false);
  assert.equal((await env.send("SENT",{id:claimed.dispatch.id},11,chat)).ok,true);
});

test("old Queue 0 stale send-warning unlocks after stable Voice Mode returns, timer still queues", async () => {
  const { send, tick, stored } = await harness({
    "cq.state.v2": {
      version: 2, legacyUnbound: null,
      conversations: {
        "chat:dialogue-a": {
          key: "chat:dialogue-a", url: A, tabId: 11,
          halted: true, activeTaskId: null,
          error: "发送结果未确认，可能已发送；请人工检查，插件不会自动重发",
          autoOpenTab: false, tasks: [], schedules: [{
            id: "stale-loop", text: "定时继续", enabled: true,
            intervalMinutes: 1, repeatCount: -1, runCount: 2,
            nextRunAt: Date.UTC(2026, 9, 15, 12, 1),
          }],
        },
      },
    },
  });

  const init = await send("HELLO");
  assert.equal(init.state.halted, true);
  assert.equal(init.state.haltReason, "failure");
  assert.equal(init.state.tasks.length, 0);

  await tick(1);
  const before = (await send("GET")).state;
  assert.equal(before.halted, true);
  assert.equal((await send("CLAIM", { ready: true })).dispatch, null);
  const ready = (await send("RECOVER_ON_VOICE", voiceProof)).state;
  assert.equal(ready.halted, false);
  assert.equal(ready.error, "");
  assert.equal(ready.tasks.length, 1);
  assert.equal(ready.tasks[0].text, "定时继续");
  assert.equal(ready.schedules[0].enabled, true);
  assert.equal(ready.schedules[0].runCount, 3);
  const claim = await send("CLAIM", { ready: true, assistantCount: 4, userCount: 4 });
  assert.equal(claim.dispatch.text, "定时继续");
  assert.equal(stored["cq.state.v2"].conversations["chat:dialogue-a"].error, "");
});

test("old failed row is quarantined, Voice Mode resumes next timer item without retrying error", async () => {
  const { send, tick } = await harness({
    "cq.state.v2": {
      version: 2, legacyUnbound: null,
      conversations: {
        "chat:dialogue-a": {
          key: "chat:dialogue-a", url: A, tabId: 11,
          halted: true, activeTaskId: null,
          error: "发送结果未确认，可能已发送；请人工检查",
          tasks: [{ id: "unverified", text: "可能已经发过", status: "error" }],
          schedules: [{
            id: "loop", text: "继续做新任务", intervalMinutes: 1,
            repeatCount: -1, enabled: true, nextRunAt: Date.UTC(2026, 9, 15, 12, 1),
          }],
        },
      },
    },
  });
  await tick(1);
  const held = (await send("GET")).state;
  assert.equal(held.halted, true);
  const result = (await send("RECOVER_ON_VOICE", voiceProof)).state;
  assert.equal(result.halted, false);
  assert.equal(result.error, "");
  assert.equal(result.tasks.length, 2);
  assert.equal(result.tasks[0].status, "error");
  assert.equal(result.tasks[0].text, "可能已经发过");
  assert.equal((await send("CLAIM", { ready: true })).dispatch.text, "继续做新任务");
});

test("explicit user Stop is not silently resumed by timer or reload", async () => {
  const { send, tick } = await harness();
  await send("ENQUEUE", { text: "任务" });
  const stopped = await send("STOPPED", { userCount: 3 });
  assert.equal(stopped.state.halted, true);
  assert.equal(stopped.state.haltReason, "user");
  await send("ADD_SCHEDULE", { text: "定时通知", intervalMinutes: 1, repeatCount: -1 });
  await tick(1);
  const loaded = await send("HELLO", { userCount: 3 });
  assert.equal(loaded.state.halted, true);
  assert.equal(loaded.state.haltReason, "user");
  assert.equal(loaded.state.tasks.length, 2);
  assert.equal((await send("CLAIM", { ready: true })).dispatch, null);
  assert.equal((await send("ACK_RECOVERY")).state.halted, true);
});

test("new technical hold requires explicit recovery and does not repeat an uncertain send", async () => {
  const { send } = await harness();
  await send("ENQUEUE", { text: "稍后处理" });
  const start = await send("CLAIM", { ready: true });
  await send("FAIL", { id: start.dispatch.id, error: "当前网页不支持原生发送" });
  const held = (await send("HELLO")).state;
  assert.equal(held.halted, true);
  assert.equal(held.haltReason, "failure");
  assert.equal((await send("CLAIM", { ready: true })).dispatch, null);
  const recovered = await send("ACK_RECOVERY");
  assert.equal(recovered.state.halted, false);
  assert.equal(recovered.state.error, "");
  assert.equal(recovered.state.tasks[0].status, "error");
  assert.equal((await send("CLAIM", { ready: true })).dispatch, null);
});

test("传输错误后 Voice Mode 自动解除技术暂停，不重发故障任务，只执行后续待办", async () => {
  const { send, stored } = await harness();
  await send("ENQUEUE", { text: "之前已经尝试发送的任务" });
  await send("ENQUEUE", { text: "第二条继续处理" });
  await send("ENQUEUE", { text: "第三条继续处理" });
  const first = await send("CLAIM", { ready: true, userCount: 1, assistantCount: 1 });
  await send("SENT", { id: first.dispatch.id });
  await send("FAIL", { id: first.dispatch.id, error: "消息传输超时，请重试。" });
  const blocked = (await send("GET")).state;
  assert.equal(blocked.halted, true);
  assert.equal(blocked.haltReason, "failure");
  assert.equal(blocked.activeTaskId, null);
  assert.equal(blocked.tasks[0].status, "error");
  assert.equal((await send("CLAIM", { ready: true })).dispatch, null);

  // No manual recovery required once the *native* Voice Mode button is back.
  const resumed = await send("RECOVER_ON_VOICE", voiceProof);
  assert.equal(resumed.state.halted, false);
  assert.equal(resumed.state.error, "");
  assert.equal(resumed.state.haltReason, null);
  assert.equal(resumed.state.tasks[0].status, "error");
  assert.equal(resumed.state.tasks[1].status, "pending");
  assert.equal(resumed.state.tasks[2].status, "pending");
  const claim = await send("CLAIM", { ready: true, userCount: 2, assistantCount: 2 });
  assert.equal(claim.dispatch.text, "第二条继续处理");
  assert.equal(stored["cq.state.v2"].conversations["chat:dialogue-a"].tasks[0].status, "error");
  assert.equal((await send("RECOVER_ON_VOICE", voiceProof)).state.activeTaskId, claim.dispatch.id);
});

test("上一条 waiting 时插件因即时发送结果未知锁住，语音恢复后跳过旧锁但不重发", async () => {
  const { send } = await harness();
  await send("ENQUEUE", { text: "旧的运行任务" });
  await send("ENQUEUE", { text: "下一条必须继续" });
  const active = await send("CLAIM", { ready: true });
  await send("SENT", { id: active.dispatch.id });
  const interrupted = await send("UNCERTAIN_SEND", { userCount: 1 });
  assert.equal(interrupted.state.haltReason, "uncertain");
  assert.equal(interrupted.state.activeTaskId, active.dispatch.id);

  const resumed = await send("RECOVER_ON_VOICE", voiceProof);
  assert.equal(resumed.state.halted, false);
  assert.equal(resumed.state.activeTaskId, null);
  assert.equal(resumed.state.tasks[0].status, "error");
  assert.match(resumed.state.tasks[0].error, /不会自动重发/);
  assert.equal(resumed.state.tasks[1].status, "pending");
  assert.equal((await send("CLAIM", { ready: true })).dispatch.text, "下一条必须继续");
});

test("定时队列已满前的技术暂停，语音恢复只接力普通待办，定时器独立继续产生", async () => {
  const { send, tick } = await harness();
  await send("ENQUEUE", { text: "先前失败" });
  const failed = await send("CLAIM", { ready: true });
  await send("FAIL", { id: failed.dispatch.id, error: "消息传输超时" });
  await send("ADD_SCHEDULE", { text: "循环任务", intervalMinutes: 1, repeatCount: -1 });
  await tick(1);
  await tick(1);
  let state = (await send("GET")).state;
  assert.equal(state.halted, true);
  assert.equal(state.tasks.length, 3);
  assert.equal(state.schedules[0].runCount, 2);

  state = (await send("RECOVER_ON_VOICE", voiceProof)).state;
  assert.equal(state.halted, false);
  assert.equal(state.tasks[0].status, "error");
  assert.equal((await send("CLAIM", { ready: true })).dispatch.text, "循环任务");
  await tick(1);
  state = (await send("GET")).state;
  assert.equal(state.schedules[0].runCount, 3);
  assert.equal(state.tasks.filter((task) => task.text === "循环任务").length, 3);
});

test("只有完整稳定的 Voice Mode 证据才能解除技术故障；错误标签页不影响原队列", async () => {
  const { send } = await harness();
  await send("ENQUEUE", { text: "待处理第一条" }, 11);
  await send("ENQUEUE", { text: "待处理第二条" }, 11);
  const claimed = await send("CLAIM", { ready: true }, 11);
  await send("FAIL", { id: claimed.dispatch.id, error: "浏览器超时" }, 11);
  for (const proof of [
    { ...voiceProof, voiceReady: false },
    { ...voiceProof, voiceStableMs: 1699 },
    { ...voiceProof, editorEmpty: false },
    { ...voiceProof, busy: true },
  ]) {
    assert.equal((await send("RECOVER_ON_VOICE", proof, 11)).state.halted, true);
  }
  assert.equal((await send("RECOVER_ON_VOICE", voiceProof, 12)).state.halted, false);
  assert.equal((await send("GET", {}, 11)).state.halted, true);
  assert.equal((await send("CLAIM", { ready: true }, 11)).dispatch, null);
  assert.equal((await send("RECOVER_ON_VOICE", voiceProof, 11)).state.halted, false);
  assert.equal((await send("CLAIM", { ready: true }, 11)).dispatch.text, "待处理第二条");
});

test("用户主动停止、旧版未绑定暂停，均不能被自动恢复", async () => {
  const { send } = await harness();
  await send("ENQUEUE", { text: "用户主动暂停" });
  await send("STOPPED", { userCount: 1 });
  const manualStop = await send("RECOVER_ON_VOICE", voiceProof);
  assert.equal(manualStop.state.halted, true);
  assert.equal(manualStop.state.haltReason, "user");
  assert.equal((await send("CLAIM", { ready: true })).dispatch, null);

  const legacy = await harness({
    "cq.state.v2": { version: 2, legacyUnbound: null, conversations: {
      "chat:dialogue-a": {
        key: "chat:dialogue-a", url: A, tabId: 11,
        halted: true, haltReason: "legacy", activeTaskId: null,
        tasks: [{ id: "legacy-queue", text: "不能自动恢复", status: "pending" }],
        schedules: [], error: "等待人工导入确认",
      },
    } },
  });
  const result = await legacy.send("RECOVER_ON_VOICE", voiceProof);
  assert.equal(result.state.halted, true);
  assert.equal(result.state.haltReason, "legacy");
});

test("旧版存档没有 haltReason，服务器直接报告消息传输超时，也能等待语音按钮后恢复", async () => {
  const { send } = await harness({
    "cq.state.v2": { version: 2, legacyUnbound: null, conversations: {
      "chat:dialogue-a": {
        key: "chat:dialogue-a", url: A, tabId: 11,
        halted: true, activeTaskId: null, error: "消息传输超时，请重试。",
        tasks: [{ id: "following", text: "还未执行的任务", status: "pending" }],
        schedules: [],
      },
    } },
  });
  const loaded = await send("HELLO");
  assert.equal(loaded.state.halted, true);
  assert.equal(loaded.state.haltReason, "failure");
  assert.equal((await send("CLAIM", { ready: true })).dispatch, null);
  const resumed = await send("RECOVER_ON_VOICE", voiceProof);
  assert.equal(resumed.state.halted, false);
  assert.equal(resumed.state.error, "");
  assert.equal((await send("CLAIM", { ready: true })).dispatch.text, "还未执行的任务");
});

test("an old native Stop remains stopped across reload and countdown expiry", async () => {
  const { send, tick } = await harness({
    "cq.state.v2": {
      version: 2, legacyUnbound: null, conversations: {
        "chat:dialogue-a": {
          key: "chat:dialogue-a", url: A, tabId: 11, halted: true,
          activeTaskId: null, error: "用户已停止回复；本对话队列暂停",
          tasks: [], schedules: [{ id: "loop", text: "不要发", intervalMinutes: 1,
            repeatCount: -1, enabled: true, nextRunAt: Date.UTC(2026, 9, 15, 12, 1) }],
        },
      },
    },
  });
  const hello = await send("HELLO");
  assert.equal(hello.state.halted, true);
  assert.equal(hello.state.haltReason, "user");
  await tick(1);
  const pending = (await send("GET")).state;
  assert.equal(pending.tasks.length, 1);
  assert.equal(pending.halted, true);
  assert.equal((await send("CLAIM", { ready: true })).dispatch, null);
});

test("启用自动重开后，原标签被浏览器丢弃应原位重新加载且不夺取焦点", async () => {
  const {send,tick,tabs,tabReloads,wakeMessages}=await harness();
  await send("ENQUEUE",{text:"需要继续处理的任务"});
  await send("AUTO_OPEN",{enabled:true});
  tabs.get(11).discarded=true;
  await tick(1);
  const state=(await send("GET")).state;
  assert.equal(state.tabId,11);
  assert.equal(tabs.size,3,"不应因标签被丢弃而额外创建重复标签");
  assert.deepEqual(tabReloads,[11]);
  assert.equal(tabs.get(11).discarded,false);
  assert.equal(tabs.get(11).active,undefined,"不切换用户焦点");
  assert.equal(state.history.filter((entry) => entry.type==="tab_revived").length,1);
  assert.ok(wakeMessages.some((call) =>
    call.tabId===11 && call.message.type==="QUEUE_WAKE"));
});

test("明确关闭后台保护且未开启自动重开时，不恢复被丢弃的标签", async () => {
  const {send,tick,tabs,tabReloads}=await harness();
  await send("ENQUEUE",{text:"手动管理的队列"});
  await send("PROTECT_BACKGROUND",{enabled:false});
  tabs.get(11).discarded=true;
  await tick(1);
  assert.equal(tabReloads.length,0);
  assert.equal((await send("GET")).state.history.some((entry) =>
    entry.type==="tab_revived" || entry.type==="tab_reopened"),false);
  assert.equal(tabs.get(11).discarded,true);
  assert.equal(tabs.size,3);
  assert.equal((await send("GET")).state.tabId,11);
});

test("默认后台保护恢复已存在的卸载标签，不依赖关闭后自动重开设置", async () => {
  const env=await harness();
  await env.send("ENQUEUE",{text:"继续原队列"});
  const before=(await env.send("GET")).state.tasks[0].id;
  env.tabs.get(11).discarded=true;
  await env.tick(1);
  assert.deepEqual(env.tabReloads,[11]);
  assert.equal(env.tabs.size,3,"只恢复现有标签，不创建替代页面");
  assert.equal(env.tabs.get(11).active,undefined);
  assert.equal(env.tabs.get(11).autoDiscardable,false);
  const state=(await env.send("GET")).state;
  assert.equal(state.autoOpenTab,false);
  assert.equal(state.tasks[0].id,before);
  assert.equal(state.tasks[0].status,"pending");
});

test("卸载和防卸载标记变化事件及时恢复，但不重发已有 waiting 任务", async () => {
  const env=await harness();
  await env.send("ENQUEUE",{text:"已点击发送，不可重复"});
  const claimed=await env.send("CLAIM",{ready:true});
  await env.send("SENT",{id:claimed.dispatch.id});
  env.updateTab(11,{discarded:true,autoDiscardable:true});
  const restored=await env.send("GET");
  assert.deepEqual(env.tabReloads,[11],"不等待下一分钟闹钟");
  assert.equal(restored.state.tasks[0].status,"waiting");
  assert.equal(restored.state.activeTaskId,claimed.dispatch.id);
  assert.equal((await env.send("CLAIM",{ready:true})).dispatch,null);
  assert.equal(env.tabs.get(11).autoDiscardable,false);
  env.updateTab(11,{autoDiscardable:true});
  await env.send("GET");
  assert.equal(env.tabs.get(11).autoDiscardable,false,"浏览器重置标记后重新保护");
  assert.equal(env.tabs.size,3);
});

test("接力进入项目首页的 HELLO 空窗持续受保护，慢加载六分钟不误判失败", async () => {
  const env=await harness();
  const {sourceUrl,projectUrl}=await preparePendingHandoffEntry(env);
  env.navigate(11,projectUrl);
  await env.send("GET",{},12);
  assert.equal(env.tabs.get(11).autoDiscardable,false,"还没有挂载 draft 时也保护原生项目入口");
  assert.equal(env.stored["cq.state.v2"].conversations["draft:11"],undefined);
  await env.tick(6);
  const source=env.stored["cq.state.v2"].conversations["chat:source"];
  assert.equal(source.handoff.phase,"navigating");
  assert.equal(source.tasks[0].text,"始终保留在原对话的任务");
  env.updateTab(11,{discarded:true,autoDiscardable:true});
  await env.send("GET",{},12);
  assert.deepEqual(env.tabReloads,[11],"接力阶段无需 autoOpenTab 也恢复原项目页");
  assert.equal(source.handoff.phase,"navigating");
  assert.equal(source.url,sourceUrl);
  env.navigate(11,"https://chatgpt.com/g/g-p-other/project");
  await env.send("GET",{},12);
  assert.equal(env.tabs.get(11).autoDiscardable,true,"不保护误入的其他项目");
});

test("已有待发送接力正文只能重新领取原 pending intro，释放退避仍然有效",async()=>{
  const env=await harness();
  const {projectUrl}=await preparePendingHandoffEntry(env);
  env.navigate(11,projectUrl);
  const entry=await env.send("HELLO",{},11,projectUrl);
  const introId=entry.state.tasks[0].id;
  const first=await env.send("CLAIM",{
    ready:true,resumeHandoffTaskId:introId,userCount:0,
  },11,projectUrl);
  assert.equal(first.dispatch.id,introId);
  assert.equal(first.dispatch.kind,"handoff_intro");
  assert.equal(first.dispatch.sourceUrl,projectUrl);
  assert.equal(first.state.tasks.length,1);
  await env.send("RELEASE_CLAIM",{id:introId},11,projectUrl);
  const early=await env.send("CLAIM",{ready:true,resumeHandoffTaskId:introId},11,projectUrl);
  assert.equal(early.dispatch,null);
  assert.equal(early.dispatchBlockedReason,"retry_wait");
  assert.equal(early.state.tasks[0].status,"pending");
  env.advance(3);
  const resumed=await env.send("CLAIM",{ready:true,resumeHandoffTaskId:introId},11,projectUrl);
  assert.equal(resumed.dispatch.id,introId);
  assert.equal(resumed.state.tasks.length,1,"续发只领取原行，不创建另一份交接记录");
  assert.equal(env.stored["cq.state.v2"].conversations["chat:source"].tasks.length,1);
});

test("复用交接正文不能把 dispatching、waiting、error 或结果不确定的 intro 恢复为 pending",async()=>{
  for(const phase of ["dispatching","waiting","error","uncertain"]){
    const env=await harness();
    const {projectUrl}=await preparePendingHandoffEntry(env);
    env.navigate(11,projectUrl);
    await env.send("HELLO",{},11,projectUrl);
    const first=await env.send("CLAIM",{ready:true},11,projectUrl);
    const introId=first.dispatch.id;
    if(phase==="waiting"||phase==="uncertain")await env.send("SENT",{id:introId},11,projectUrl);
    if(phase==="error")await env.send("FAIL",{id:introId,error:"接收结果待核对"},11,projectUrl);
    if(phase==="uncertain"){
      const destination=env.stored["cq.state.v2"].conversations["draft:11"];
      destination.halted=true;
      destination.haltReason="uncertain";
      destination.error="原生发送已点击，但未确认结果";
    }
    const retry=await env.send("CLAIM",{ready:true,resumeHandoffTaskId:introId},11,projectUrl);
    assert.equal(retry.dispatch,null,phase);
    assert.notEqual(retry.state.tasks[0].status,"pending",phase);
    assert.equal(retry.state.tasks[0].id,introId);
    assert.equal(retry.state.tasks.length,1);
    assert.equal(env.stored["cq.state.v2"].conversations["chat:source"].tasks.length,1);
  }
});

test("复用待发 intro 必须匹配任务和完整接力归属，不能附带图片或认领其他项目",async()=>{
  for(const mismatch of ["task","token","project","owner","destination","images"]){
    const env=await harness();
    const {projectUrl}=await preparePendingHandoffEntry(env);
    env.navigate(11,projectUrl);
    const entry=await env.send("HELLO",{},11,projectUrl);
    const introId=entry.state.tasks[0].id;
    const destination=env.stored["cq.state.v2"].conversations["draft:11"];
    const source=env.stored["cq.state.v2"].conversations["chat:source"];
    if(mismatch==="token")destination.handoffToken="another-handoff";
    if(mismatch==="project")source.handoff.projectId="g-p-another-project";
    if(mismatch==="owner")source.tabId=12;
    if(mismatch==="destination")source.handoff.destinationKey="draft:another";
    if(mismatch==="images")destination.tasks[0].images=[{id:"unexpected-image"}];
    const blocked=await env.send("CLAIM",{
      ready:true,resumeHandoffTaskId:mismatch==="task"?"another-task":introId,
    },11,projectUrl);
    assert.equal(blocked.dispatch,null,mismatch);
    assert.equal(blocked.dispatchBlockedReason,"resume_handoff_mismatch",mismatch);
    assert.equal(blocked.state.activeTaskId,null);
    assert.equal(blocked.state.tasks[0].status,"pending");
    assert.equal(blocked.state.tasks[0].id,introId);
    assert.equal(source.tasks.length,1,"归属失败时原队列仍然完整");
  }
});

test("复用 summary 不绕过 FIFO、前序退避或取消状态，正常释放后仍能续发同一条",async()=>{
  const env=await harness();
  const origin="https://chatgpt.com/g/g-p-resume-summary/c/source-resume";
  env.navigate(11,origin);
  await env.send("ENQUEUE",{text:"必须先完成的普通任务"},11,origin);
  const queued=await env.send("HANDOFF_NOW",{},11,origin);
  const ordinary=queued.state.tasks[0];
  const summary=queued.state.tasks.find(task=>task.kind==="handoff_summary");
  const blocked=await env.send("CLAIM",{
    ready:true,resumeHandoffTaskId:summary.id,
  },11,origin);
  assert.equal(blocked.dispatch,null);
  assert.equal(blocked.state.activeTaskId,null);
  assert.equal(blocked.state.tasks[0].id,ordinary.id);
  ordinary.retryNotBefore=ordinary.createdAt+60_000;
  const delayedPredecessor=await env.send("CLAIM",{
    ready:true,resumeHandoffTaskId:summary.id,
  },11,origin);
  assert.equal(delayedPredecessor.dispatch,null,"不能跳过前序任务的 retryNotBefore");
  assert.equal(delayedPredecessor.state.tasks.every(task=>task.status==="pending"),true);
  delete ordinary.retryNotBefore;
  const first=await env.send("CLAIM",{ready:true},11,origin);
  assert.equal(first.dispatch.id,ordinary.id,"普通领取保持原有行为");
  await env.send("SENT",{id:ordinary.id},11,origin);
  env.advance(3);
  await env.send("FINISHED",{id:ordinary.id,...voiceProof},11,origin);
  const resumed=await env.send("CLAIM",{
    ready:true,resumeHandoffTaskId:summary.id,userCount:1,
  },11,origin);
  assert.equal(resumed.dispatch.id,summary.id);
  assert.equal(resumed.state.handoff.phase,"summarizing");
  await env.send("RELEASE_CLAIM",{id:summary.id},11,origin);
  env.advance(3);
  const retry=await env.send("CLAIM",{ready:true,resumeHandoffTaskId:summary.id},11,origin);
  assert.equal(retry.dispatch.id,summary.id);
  await env.send("RELEASE_CLAIM",{id:summary.id},11,origin);
  env.advance(3);
  env.stored["cq.state.v2"].conversations["chat:source-resume"].handoff.cancelRequested=true;
  assert.equal((await env.send("CLAIM",{
    ready:true,resumeHandoffTaskId:summary.id,
  },11,origin)).dispatch,null,"已取消的总结不因正文仍在输入框而再次领取");
});

test("复用正文提示不能将普通 pending 任务当作内部接力消息发送",async()=>{
  const env=await harness();
  const queued=await env.send("ENQUEUE",{text:"普通草稿不自动接管"});
  const taskId=queued.state.tasks[0].id;
  const blocked=await env.send("CLAIM",{ready:true,resumeHandoffTaskId:taskId});
  assert.equal(blocked.dispatch,null);
  assert.equal(blocked.state.tasks[0].status,"pending");
  assert.equal(blocked.state.activeTaskId,null);
  assert.equal((await env.send("CLAIM",{ready:true})).dispatch.id,taskId);
});

test("接收交接的未发送 intro 跨项目页刷新保留，已发送后不得在项目页确认完成", async () => {
  const env=await harness();
  const {projectUrl}=await preparePendingHandoffEntry(env);
  env.navigate(11,projectUrl);
  const first=await env.send("HELLO",{projectVisitId:"first-visit"},11,projectUrl);
  const introId=first.state.tasks[0].id;
  assert.equal(first.state.tasks[0].kind,"handoff_intro");
  const refreshed=await env.send("HELLO",{projectVisitId:"after-refresh"},11,projectUrl);
  assert.equal(refreshed.state.tasks[0].id,introId);
  assert.equal(refreshed.state.tasks[0].status,"pending");
  env.updateTab(11,{discarded:true,autoDiscardable:true});
  await env.send("GET",{},12);
  assert.equal(env.tabs.get(11).autoDiscardable,false);
  assert.deepEqual(env.tabReloads,[11]);
  const claim=await env.send("CLAIM",{ready:true,userCount:0},11,projectUrl);
  assert.equal(claim.dispatch.id,introId);
  await env.send("SENT",{id:introId},11,projectUrl);
  env.advance(3);
  const premature=await env.send("FINISHED",{id:introId,...voiceProof,userCount:0},11,projectUrl);
  assert.equal(premature.ok,false);
  assert.match(premature.error,/新对话地址/);
  assert.equal(env.stored["cq.state.v2"].conversations["chat:source"].tasks.length,1);
  env.navigate(11,"https://chatgpt.com/g/g-p-protected-entry/c/new-entry");
  await env.send("GET",{},12);
  assert.equal(env.tabs.get(11).autoDiscardable,false,"气泡尚未挂载的原生首发跳转也继续保护");
});

test("接力 intro 预约超时同步原对话失败，语音恢复不清空错误或重发", async () => {
  const env=await harness();
  const {projectUrl}=await preparePendingHandoffEntry(env);
  env.navigate(11,projectUrl);
  await env.send("HELLO",{},11,projectUrl);
  const intro=await env.send("CLAIM",{ready:true},11,projectUrl);
  await env.tick(2);
  const failed=await env.send("GET",{},11,projectUrl);
  assert.equal(failed.state.tasks[0].id,intro.dispatch.id);
  assert.equal(failed.state.tasks[0].status,"error");
  assert.equal(failed.state.activeTaskId,null);
  assert.equal(failed.state.handoff.phase,"failed");
  assert.equal(failed.state.halted,true);
  const source=env.stored["cq.state.v2"].conversations["chat:source"];
  assert.equal(source.handoff.phase,"failed");
  assert.equal(source.tasks[0].text,"始终保留在原对话的任务");
  const recovered=await env.send("RECOVER_ON_VOICE",voiceProof,11,projectUrl);
  assert.equal(recovered.state.halted,true);
  assert.equal(recovered.state.handoff.phase,"failed");
  assert.ok(recovered.state.error);
  assert.equal((await env.send("CLAIM",{ready:true},11,projectUrl)).dispatch,null);
});

test("缺失或发送状态未知的 intro 明确联动失败，保留原队列而非显示永久接收", async () => {
  for (const broken of ["missing","uncertain"]) {
    const env=await harness();
    const {projectUrl}=await preparePendingHandoffEntry(env);
    env.navigate(11,projectUrl);
    const entry=await env.send("HELLO",{},11,projectUrl);
    const destination=env.stored["cq.state.v2"].conversations["draft:11"];
    if (broken==="missing") destination.tasks=[];
    else {
      const intro=await env.send("CLAIM",{ready:true},11,projectUrl);
      await env.send("SENT",{id:intro.dispatch.id},11,projectUrl);
      // Persisted technical halts from an earlier script must not run the
      // ordinary resumeTechnicalHalt path on a handoff destination.
      destination.halted=true;
      destination.haltReason="uncertain";
      destination.error="旧脚本未确认交接开场结果";
    }
    const observed=await env.send("GET",{},11,projectUrl);
    assert.equal(observed.state.handoffSourceKey,"chat:source");
    assert.equal(observed.state.handoff.phase,"failed",broken);
    assert.equal(observed.state.halted,true);
    assert.ok(observed.state.error);
    assert.equal(env.stored["cq.state.v2"].conversations["chat:source"].handoff.phase,"failed");
    assert.equal(env.stored["cq.state.v2"].conversations["chat:source"].tasks[0].text,
      "始终保留在原对话的任务");
    assert.equal((await env.send("RECOVER_ON_VOICE",voiceProof,11,projectUrl)).state.halted,true);
    assert.equal((await env.send("CLAIM",{ready:true},11,projectUrl)).dispatch,null);
    if (broken==="uncertain") assert.equal(observed.state.tasks[0].id,entry.state.tasks[0].id);
  }
});

test("原标签被丢弃、同一对话另有正常页面时，优先转交正常标签而不重载丢弃页", async () => {
  const {send,tick,navigate,tabs,tabReloads,wakeMessages}=await harness();
  await send("ENQUEUE",{text:"无论哪一个页面都不能重复发送"});
  await send("AUTO_OPEN",{enabled:true});
  tabs.get(11).discarded=true;
  navigate(12,A);
  wakeMessages.length=0; // Only compare wakeups generated after the new owner is selected.
  await tick(1);
  const state=(await send("GET",{},12)).state;
  assert.equal(state.tabId,12);
  assert.equal(state.history.filter((entry) => entry.type==="tab_owner_rebound").length,1);
  assert.deepEqual(tabReloads,[]);
  assert.equal(tabs.size,3);
  assert.equal((await send("CLAIM",{ready:true},11)).dispatch,null);
  assert.equal((await send("CLAIM",{ready:true},12)).dispatch.text,
    "无论哪一个页面都不能重复发送");
  assert.ok(wakeMessages.some((call) => call.tabId===12));
  assert.equal(wakeMessages.some((call) => call.tabId===11),false);
});

test("标签无法原位重载时仅后台新开一个替代标签，之后的闹钟不重复打开", async () => {
  const {send,tick,tabs,failedTabReloads,tabReloads}=await harness();
  await send("ENQUEUE",{text:"恢复运行"});
  await send("AUTO_OPEN",{enabled:true});
  tabs.get(11).discarded=true;
  failedTabReloads.add(11);
  await tick(1);
  const first=(await send("GET")).state;
  assert.notEqual(first.tabId,11);
  assert.equal(tabs.size,4);
  assert.equal(tabs.get(first.tabId).url,A);
  assert.equal(tabs.get(first.tabId).active,false);
  assert.equal(first.history.filter((entry) => entry.type==="tab_reopened").length,1);
  await tick(1);
  assert.equal(tabs.size,4);
  assert.equal((await send("GET")).state.tabId,first.tabId);
  assert.deepEqual(tabReloads,[]);
});

test("浏览器延迟解除 discarded 标志时，分钟闹钟按退避时间重载，避免连续刷新", async () => {
  const {send,tick,tabs,tabReloads,reloadLeavesDiscarded}=await harness();
  await send("ENQUEUE",{text:"页面正在恢复中"});
  await send("AUTO_OPEN",{enabled:true});
  tabs.get(11).discarded=true;
  reloadLeavesDiscarded.add(11);
  await tick(1);
  assert.deepEqual(tabReloads,[11]);
  assert.equal(tabs.get(11).discarded,true);
  await tick(1);
  assert.deepEqual(tabReloads,[11],"短时间内不应重复刷新仍处于恢复状态的标签");
  await tick(1);
  assert.deepEqual(tabReloads,[11,11],"到退避期限后才允许重新尝试一次");
  assert.equal((await send("GET")).state.history.filter((entry) =>
    entry.type==="tab_revived").length,2);
  assert.equal(tabs.size,3);
  reloadLeavesDiscarded.delete(11);
  await tick(1);
  assert.deepEqual(tabReloads,[11,11]);
  assert.equal((await send("GET")).state.tasks[0].status,"pending");
});

test("一个自动标签创建失败，其他对话的定时规则仍按期入队并持久保存", async () => {
  const {send,tick,tabs,closeTab,failedTabCreates,stored}=await harness();
  await send("ADD_SCHEDULE",{
    text:"A 到期任务",intervalMinutes:1,repeatCount:0,
  },11);
  await send("ADD_SCHEDULE",{
    text:"B 到期任务",intervalMinutes:1,repeatCount:0,
  },12);
  await send("AUTO_OPEN",{enabled:true},11);
  await send("AUTO_OPEN",{enabled:true},12);
  closeTab(11);
  closeTab(12);
  failedTabCreates.add(A);
  await tick(1);
  const a=stored["cq.state.v2"].conversations["chat:dialogue-a"];
  const b=stored["cq.state.v2"].conversations["chat:dialogue-b"];
  assert.equal(a.tasks.length,1);
  assert.equal(a.tasks[0].text,"A 到期任务");
  assert.equal(a.schedules[0].enabled,false);
  assert.equal(a.tabId,11,"失败时保留原绑定，供下一次后台检查重试");
  assert.equal(b.tasks.length,1);
  assert.equal(b.tasks[0].text,"B 到期任务");
  assert.equal(b.schedules[0].enabled,false);
  assert.notEqual(b.tabId,12);
  assert.equal(a.history.filter((entry) => entry.type==="tab_reopen_failed").length,1);
  assert.equal(b.history.filter((entry) => entry.type==="tab_reopened").length,1);
  assert.equal(tabs.get(b.tabId).active,false);
  await tick(1);
  assert.equal(a.tasks.length,1);
  assert.equal(b.tasks.length,1);
  assert.equal(tabs.size,2,"B 不会因为 A 的失败再次新开重复标签");
  assert.equal(a.history.filter((entry) => entry.type==="tab_reopen_failed").length,1,
    "短时间失败不应刷满运行日志");
  await tick(10);
  assert.equal(a.history.filter((entry) => entry.type==="tab_reopen_failed").length,2,
    "长时间持续失败才追加新诊断记录");
});

test("对话绑定 URL 与真实会话 ID 不一致时自动重开必须拒绝打开别的聊天", async () => {
  const {send,closeTab,tick,stored,tabs}=await harness();
  await send("ENQUEUE",{text:"保留 A 的任务"});
  await send("AUTO_OPEN",{enabled:true});
  const saved=stored["cq.state.v2"].conversations["chat:dialogue-a"];
  saved.url=B;
  closeTab(11);
  await tick(1);
  assert.equal(tabs.size,2);
  assert.equal(saved.tabId,11);
  assert.equal(saved.tasks.length,1);
  assert.equal(saved.tasks[0].status,"pending");
});

test("后台新开标签仍在 pendingUrl 导航中时不得重复打开标签，即使加载超过两分钟", async () => {
  const {send,closeTab,tick,tabs,stored}=await harness();
  await send("ENQUEUE",{text:"网络慢时也只打开一页"});
  await send("AUTO_OPEN",{enabled:true});
  closeTab(11);
  await tick(1);
  const session=stored["cq.state.v2"].conversations["chat:dialogue-a"];
  const reopened=session.tabId;
  assert.ok(reopened !== 11 && tabs.has(reopened));
  assert.equal(tabs.get(reopened).active,false);
  tabs.get(reopened).url="about:blank";
  tabs.get(reopened).pendingUrl=A;
  await tick(4);
  assert.equal(tabs.size,3);
  assert.equal(session.tabId,reopened);
  assert.equal(session.tasks.length,1);
  assert.equal(session.tasks[0].text,"网络慢时也只打开一页");
});

test("浏览器尚未暴露 pendingUrl 时，最近新开的标签有短暂保护期防止连续创建", async () => {
  const {send,closeTab,tick,tabs,stored}=await harness();
  await send("ENQUEUE",{text:"避免一分钟打开一个标签"});
  await send("AUTO_OPEN",{enabled:true});
  closeTab(11);
  await tick(1);
  const session=stored["cq.state.v2"].conversations["chat:dialogue-a"];
  const initial=session.tabId;
  tabs.get(initial).url="about:blank";
  tabs.get(initial).pendingUrl=undefined;
  await tick(1);
  assert.equal(tabs.size,3,"刚创建的页面尚未加载时应先等待");
  assert.equal(session.tabId,initial);
});

test("新开的标签已明确跳转到其他对话时，自动重开不应被加载退避误阻挡", async () => {
  const {send,closeTab,tick,tabs,stored}=await harness();
  await send("ENQUEUE",{text:"A 对话的后续任务"});
  await send("AUTO_OPEN",{enabled:true});
  closeTab(11);
  await tick(1);
  const session=stored["cq.state.v2"].conversations["chat:dialogue-a"];
  const first=session.tabId;
  assert.notEqual(first,11);
  tabs.get(first).url=B;
  tabs.get(first).pendingUrl=undefined;
  tabs.get(first).status="complete";
  await tick(1);
  assert.notEqual(session.tabId,first);
  assert.equal(tabs.get(session.tabId).url,A);
  assert.equal(tabs.get(session.tabId).active,false);
  assert.equal(session.tasks.length,1);
});

test("CLAIM lets a foreground chat take over after its background HELLO could not acquire ownership", async () => {
  const { send, navigate } = await harness();
  const added = await send("ENQUEUE", { text: "接力任务" }, 11);
  assert.equal(added.state.tabId, 11);
  navigate(12, A);
  const backgroundHello = await send("HELLO", {}, 12, undefined, { active: false });
  assert.equal(backgroundHello.state.tabId, 11);
  const backgroundClaim = await send("CLAIM", { ready: true }, 12);
  assert.equal(backgroundClaim.dispatch, null);
  assert.equal(backgroundClaim.dispatchBlockedReason, "owner_mismatch");
  const switched = await send("CLAIM", { ready: true }, 12, undefined, { active: true });
  assert.equal(switched.state.key, "chat:dialogue-a");
  assert.equal(switched.state.tabId, 12);
  assert.equal(switched.dispatch.text, "接力任务");
  assert.equal(Object.hasOwn(switched,"dispatchBlockedReason"),false);
  const stillOwned = await send("CLAIM", { ready: true }, 11, undefined, { active: true });
  assert.equal(stillOwned.dispatch, null);
  assert.equal(stillOwned.dispatchBlockedReason,"active_task");
  assert.equal(stillOwned.state.tabId,12,"有进行中任务时不能再次转移持有者");
  assert.equal(Object.hasOwn(await send("GET"),"dispatchBlockedReason"),false);
});

test("CLAIM explains idle and failed-handoff gates without restarting uncertain work", async () => {
  const env=await harness();
  const url="https://chatgpt.com/g/g-p-dispatch-blocked/c/source";
  env.navigate(11,url);
  assert.equal((await env.send("CLAIM",{ready:false},11,url)).dispatchBlockedReason,"not_ready");
  assert.equal((await env.send("CLAIM",{ready:true},11,url)).dispatchBlockedReason,"no_pending");
  await env.send("ENQUEUE",{text:"保留的普通待办"},11,url);
  const scheduled=await env.send("HANDOFF_NOW",{},11,url);
  const summaryId=scheduled.state.tasks.find((task)=>task.kind==="handoff_summary")?.id;
  assert.ok(summaryId,"手动接力先作为 FIFO 队列命令排在普通任务之后");
  // Explicitly pin this queued command to test the failed-handoff gate
  // while an ordinary task is still pending, without breaking FIFO by default.
  const pinned=await env.send("PIN_TASK",{id:summaryId},11,url);
  assert.equal(pinned.state.tasks[0].id,summaryId);
  const summary=await env.send("CLAIM",{ready:true},11,url);
  assert.equal(summary.dispatch.kind,"handoff_summary");
  await env.send("FAIL",{id:summary.dispatch.id,error:"发送结果不确定"},11,url);
  assert.equal((await env.send("CLAIM",{ready:true},11,url)).dispatchBlockedReason,"halted");
  await env.send("RECOVER_ON_VOICE",voiceProof,11,url);
  const blocked=await env.send("CLAIM",{ready:true},11,url);
  assert.equal(blocked.dispatch,null);
  assert.equal(blocked.dispatchBlockedReason,"busy_handoff");
  assert.equal(blocked.state.handoff.phase,"failed");
  assert.equal(blocked.state.tasks.find((task)=>task.id===summary.dispatch.id).status,"error");
  assert.equal(blocked.state.tasks.find((task)=>task.text==="保留的普通待办").status,"pending");
});

test("a visible-message count that stays constant can still finish a confirmed new assistant turn", async () => {
  const { send, advance } = await harness();
  await send("ENQUEUE", { text: "重复当前时间" });
  const first = await send("CLAIM", {
    ready: true, assistantCount: 1, userCount: 1,
    lastAssistantId: "old-assistant", lastAssistantSignature: "12|上轮回复内容",
  });
  await send("SENT", { id: first.dispatch.id, verified: true, userCount: 1 });
  advance(8);
  const completed = await send("FINISHED", {
    ...voiceProof,
    id: first.dispatch.id,
    assistantCount: 1, userCount: 1, lastUserText: "",
    lastAssistantId: "new-assistant", lastAssistantSignature: "14|最新时间已更新",
    assistantAdvanced: true, stableMs: 7000, assistantTextLength: 14,
    busy: false, toolPending: false, lastRole: "assistant",
  });
  assert.equal(completed.ok, true);
  assert.equal(completed.state.tasks.length, 0);
  assert.equal(completed.state.activeTaskId, null);
});

test("即使最后回复和消息数量不变化，只有语音按钮恢复才推动队列", async () => {
  const { send, advance } = await harness();
  await send("ENQUEUE", { text: "检查运行结果" });
  const first = await send("CLAIM", {
    ready: true, assistantCount: 1, userCount: 1,
    lastAssistantId: "previous", lastAssistantSignature: "12|上轮回复内容",
  });
  await send("SENT", { id: first.dispatch.id, verified: true });
  advance(30);
  const evidence = {
    ...voiceProof,
    id: first.dispatch.id, assistantCount: 1, userCount: 1,
    lastUserText: "", assistantAdvanced: true, stableMs: 20000,
    assistantTextLength: 23, busy: false, toolPending: false,
    lastRole: "assistant", lastAssistantId: "previous",
    lastAssistantSignature: "12|上轮回复内容",
  };
  assert.equal((await send("FINISHED", { ...evidence, voiceReady: false })).ok, false);
  assert.equal((await send("FINISHED", {
    ...evidence, lastAssistantId: "new-turn", voiceStableMs: 800,
  })).ok, false);
  assert.equal((await send("FINISHED", {
    ...evidence, lastAssistantId: "new-turn", busy: true,
  })).ok, false);
  assert.equal((await send("GET")).state.tasks[0].status, "waiting");
  // No assistant-text / user-bubble evidence is required any more.
  const cleared = await send("FINISHED", evidence);
  assert.equal(cleared.state.tasks.length, 0);
});

test("无限定时器在首条回复未完成的六个周期中，照常累计六条队列待办", async () => {
  const { send, tick, advance } = await harness();
  const schedule = await send("ADD_SCHEDULE", {
    text: "每分钟汇报", intervalMinutes: 1, repeatCount: -1,
  });
  await tick(1);
  const first = await send("CLAIM", {
    ready: true, assistantCount: 1, userCount: 1,
  });
  await send("SENT", { id: first.dispatch.id, verified: false });
  for (let occurrence = 2; occurrence <= 6; occurrence++) {
    await tick(1);
    const state = (await send("GET")).state;
    assert.equal(state.activeTaskId, first.dispatch.id);
    assert.equal(state.tasks.length, occurrence);
    assert.equal(state.tasks[0].status, "waiting");
    assert.equal(state.tasks.slice(1).every((task) => task.status === "pending"), true);
    assert.equal(state.schedules[0].runCount, occurrence);
    assert.equal(state.schedules[0].enabled, true);
    assert.equal(state.tasks.every((task) => task.sourceScheduleId === schedule.state.schedules[0].id), true);
    assert.equal("deferred" in state.schedules[0], false);
  }
  advance(17);
  const finished = await send("FINISHED", {
    ...voiceProof, id: first.dispatch.id, assistantFallback: true,
    assistantCount: 2, editorEmpty: true, assistantTextLength: 12,
  });
  assert.equal(finished.ok, true);
  assert.equal(finished.state.tasks.length, 5);
  assert.equal(finished.state.tasks.every((task) => task.status === "pending"), true);
  // A response completion removes one task only. The timer itself does
  // nothing here; pending tasks are dispatched by the ordinary CLAIM path.
  assert.equal(finished.state.schedules[0].runCount, 6);
  assert.equal((await send("CLAIM", { ready: true, userCount: 2, assistantCount: 2 })).dispatch.text,
    "每分钟汇报");
});

test("有限次数定时器不等回复：第二次到点就直接入队，完成回复不再产生额外任务", async () => {
  const { send, tick, advance } = await harness();
  await send("ADD_SCHEDULE", { text: "只循环一次", intervalMinutes: 1, repeatCount: 1 });
  await tick(1);
  const task = await send("CLAIM", { ready: true, assistantCount: 1, userCount: 1 });
  await send("SENT", { id: task.dispatch.id, verified: false });
  await tick(1);
  let before = (await send("GET")).state;
  assert.equal(before.tasks.length, 2);
  assert.equal(before.tasks[0].status, "waiting");
  assert.equal(before.tasks[1].status, "pending");
  assert.equal(before.schedules[0].runCount, 2);
  assert.equal(before.schedules[0].enabled, false);
  advance(17);
  const after = await send("FINISHED", {
    ...voiceProof,
    id: task.dispatch.id, assistantFallback: true, assistantAdvanced: true,
    assistantCount: 2, lastRole: "assistant", busy: false,
    editorEmpty: true, toolPending: false, assistantTextLength: 9, stableMs: 16000,
  });
  assert.equal(after.ok, true);
  assert.equal(after.state.schedules[0].runCount, 2);
  assert.equal(after.state.schedules[0].enabled, false);
  assert.equal(after.state.tasks.length, 1);
  assert.equal(after.state.tasks[0].status, "pending");
  await tick(5);
  assert.equal((await send("GET")).state.tasks.length, 1);
});

test("队列满 100 条时不会丢失到期入队机会，有空位后只补一条", async () => {
  const { send, tick, stored } = await harness({
    "cq.state.v2": {
      version: 2, legacyUnbound: null,
      conversations: {
        "chat:dialogue-a": {
          key: "chat:dialogue-a", url: A, tabId: 11, halted: false,
          activeTaskId: null, schedules: [{
            id: "once", text: "等待空位", intervalMinutes: 1,
            repeatCount: 0, enabled: true, runCount: 0,
            nextRunAt: Date.UTC(2026, 9, 15, 12, 1),
          }],
          tasks: Array.from({ length: 100 }, (_, i) => ({
            id: `preexisting-${i}`, text: `未处理 ${i}`, status: "pending",
          })),
        },
      },
    },
  });
  await tick(1);
  let current = (await send("GET")).state;
  assert.equal(current.tasks.length, 100);
  assert.equal(current.schedules[0].enabled, true);
  assert.equal(current.schedules[0].runCount, 0);
  assert.equal(current.schedules[0].nextRunAt, Date.UTC(2026, 9, 15, 12, 1));
  assert.equal((await send("SCHEDULE_PULSE")).state.tasks.length, 100);

  await send("DELETE_TASK", { id: "preexisting-0" });
  current = (await send("SCHEDULE_PULSE")).state;
  assert.equal(current.tasks.length, 100);
  assert.equal(current.tasks.at(-1).text, "等待空位");
  assert.equal(current.tasks.at(-1).status, "pending");
  assert.equal(current.schedules[0].runCount, 1);
  assert.equal(current.schedules[0].enabled, false);
  await send("SCHEDULE_PULSE");
  assert.equal(stored["cq.state.v2"].conversations["chat:dialogue-a"].tasks.length, 100);
});

test("旧版 deferred 状态仅迁移成一条队列待办，此后不再依赖回复", async () => {
  const next = Date.UTC(2026, 9, 15, 12, 10);
  const { send, advance } = await harness({
    "cq.state.v2": {
      version: 2, legacyUnbound: null,
      conversations: {
        "chat:dialogue-a": {
          key: "chat:dialogue-a", url: A, tabId: 11,
          activeTaskId: "waiting-1", halted: false,
          tasks: [{ id: "waiting-1", text: "正在回复", status: "waiting", sentAt: Date.UTC(2026, 9, 15, 12, 0) }],
          schedules: [{
            id: "old", text: "旧版本延后触发", enabled: true,
            intervalMinutes: 10, repeatCount: -1, runCount: 1,
            nextRunAt: next, deferred: true,
          }],
        },
      },
    },
  });
  const migrated = await send("HELLO", { userCount: 1 });
  assert.equal(migrated.state.tasks.length, 2);
  assert.equal(migrated.state.tasks[0].status, "waiting");
  assert.equal(migrated.state.tasks[1].status, "pending");
  assert.equal(migrated.state.tasks[1].text, "旧版本延后触发");
  assert.equal(migrated.state.schedules[0].runCount, 2);
  assert.equal("deferred" in migrated.state.schedules[0], false);
  assert.equal(migrated.state.schedules[0].nextRunAt, next);
  assert.equal((await send("HELLO")).state.tasks.length, 2);

  advance(10 * 60);
  const nextDue = await send("SCHEDULE_PULSE");
  assert.equal(nextDue.state.tasks.length, 3);
  assert.equal(nextDue.state.schedules[0].runCount, 3);
  assert.equal(nextDue.state.tasks[2].status, "pending");
});

test("用户暂停回复时定时器继续生产待办，恢复后由普通队列发送", async () => {
  const { send, tick } = await harness();
  await send("ENQUEUE", { text: "手动排队" });
  await send("STOPPED", { userCount: 1 });
  await send("ADD_SCHEDULE", { text: "每分钟新待办", intervalMinutes: 1, repeatCount: 2 });
  await tick(1);
  await tick(1);
  await tick(1);
  const state = (await send("GET")).state;
  assert.equal(state.halted, true);
  assert.equal(state.tasks.length, 4);
  assert.deepEqual(Array.from(state.tasks, (task) => task.text), [
    "手动排队", "每分钟新待办", "每分钟新待办", "每分钟新待办",
  ]);
  assert.equal(state.schedules[0].runCount, 3);
  assert.equal(state.schedules[0].enabled, false);
  assert.equal((await send("CLAIM", { ready: true })).dispatch, null);
  await send("USER_RESUMED", { userCount: 2, lastUserText: "恢复聊天" });
  assert.equal((await send("CLAIM", { ready: true })).dispatch.text, "手动排队");
});

test("旧版等待中的任务无需消息确认，页面刷新后语音按钮即可解锁", async () => {
  const sentAt = Date.UTC(2026, 9, 15, 12, 0) - 25000;
  const old = {
    id: "old-wait", text: "回复当前时间", status: "waiting",
    baselineAssistantCount: 1, baselineUserCount: 1, baselineUserId: "previous-user",
    deliveryVerified: false, sentAt,
  };
  const { send, stored } = await harness({
    "cq.state.v2": {
      version: 2, legacyUnbound: null,
      conversations: {
        "chat:dialogue-a": {
          key: "chat:dialogue-a", url: A, tabId: 11, halted: false,
          activeTaskId: old.id, error: "", tasks: [old], schedules: [],
        },
      },
    },
  });
  const evidence = { ...voiceProof, id: old.id,
    lastUserId: "previous-user", lastUserText: "别人的消息",
    lastRole: "user", assistantTextLength: 0, assistantCount: 1,
  };
  assert.equal((await send("FINISHED", { ...evidence, voiceReady: false })).ok, false);
  assert.equal((await send("FINISHED", { ...evidence, voiceStableMs: 800 })).ok, false);
  const recovered = await send("FINISHED", evidence);
  assert.equal(recovered.ok, true);
  assert.equal(recovered.state.activeTaskId, null);
  assert.equal(recovered.state.tasks.length, 0);
  assert.equal(stored["cq.state.v2"].conversations["chat:dialogue-a"].tasks.length, 0);
});

test("旧任务不需要手动确认：等待语音按钮恢复后自动继续下一条", async () => {
  const { send, advance } = await harness();
  await send("ENQUEUE", { text: "旧的卡住任务" });
  await send("ENQUEUE", { text: "下一条" });
  const claimed = await send("CLAIM", { ready: true, userCount: 1, assistantCount: 1 });
  const id = claimed.dispatch.id;
  await send("SENT", { id });
  assert.equal((await send("FINISHED", { ...voiceProof, id, voiceStableMs: 100 })).ok, false);
  advance(3);
  const recovered = await send("FINISHED", { ...voiceProof, id });
  assert.equal(recovered.ok, true);
  assert.equal(recovered.state.tasks.length, 1);
  assert.equal(recovered.state.tasks[0].text, "下一条");
  assert.equal((await send("CLAIM", { ready: true })).dispatch.text, "下一条");
});

test("即使语音按钮恢复，原生 Stop 后的任务不会被重复推进", async () => {
  const { send, advance } = await harness();
  await send("ENQUEUE", { text: "不允许自动继续" });
  const claimed = await send("CLAIM", { ready: true });
  await send("SENT", { id: claimed.dispatch.id });
  advance(65);
  await send("STOPPED", { userCount: 1 });
  const refused = await send("FINISHED", { ...voiceProof, id: claimed.dispatch.id });
  assert.equal(refused.state.halted, true);
  assert.equal(refused.state.tasks[0].status, "interrupted");
});

test("Ctrl+Enter 原子领取草稿为引导任务，确认后不留待发副本", async () => {
  const {send} = await harness();
  await send("ENQUEUE", {text:"普通待办保持原位"});
  const claimed = await send("STEER_PROMPT_CLAIM", {
    text:"立即补充当前指令",busy:true,userCount:1,lastUserId:"u1",
  });
  assert.equal(claimed.ok, true);
  assert.equal(claimed.dispatch.text, "立即补充当前指令");
  assert.equal(claimed.dispatch.needsPause, true);
  const id = claimed.dispatch.id;
  const transient = claimed.state.tasks.find(task => task.id === id);
  assert.equal(transient.status, "steering");
  assert.equal(transient.steerFromComposer, true);
  assert.equal(claimed.state.steeringTaskId, id);
  assert.equal((await send("CLAIM", {ready:true})).dispatch, null);
  const competing = await send("STEER_PROMPT_CLAIM", {text:"不能创建第二个快捷引导",busy:true});
  assert.equal(competing.ok, false);
  assert.equal((await send("GET")).state.tasks.length, 2);
  await send("STEER_CLICKED", {id});
  const confirmed = await send("STEER_CONFIRM", {
    id,userCount:2,lastUserId:"u2",lastUserText:"立即补充当前指令",
  });
  assert.equal(confirmed.state.steeringTaskId, null);
  assert.deepEqual(Array.from(confirmed.state.tasks, task => task.text), ["普通待办保持原位"]);
  assert.equal((await send("CLAIM", {ready:true})).dispatch.text, "普通待办保持原位");
});

test("快捷引导未暂停且未发送时，取消或领取过期都会移除瞬态任务", async () => {
  for (const release of ["cancel", "timeout"]) {
    const {send,tick} = await harness();
    await send("ENQUEUE", {text:"原任务"});
    const active = (await send("CLAIM", {ready:true})).dispatch;
    await send("SENT", {id:active.id});
    const claimed = await send("STEER_PROMPT_CLAIM", {text:"未送达的快捷指令",busy:true});
    const id = claimed.dispatch.id;
    if (release === "cancel") await send("STEER_CANCEL", {id});
    else await tick(2);
    const state = (await send("GET")).state;
    assert.equal(state.steeringTaskId, null, release);
    assert.equal(state.activeTaskId, active.id, release);
    assert.equal(state.tasks.length, 1, release);
    assert.equal(state.tasks[0].status, "waiting", release);
    assert.equal(state.queuePaused, false, release);
    assert.equal(state.tasks.some(task => task.text === "未送达的快捷指令"), false, release);
  }
});

test("快捷引导暂停后取消或过期时保留错误记录并暂停，不转成普通待发", async () => {
  for (const release of ["cancel", "timeout"]) {
    const {send,tick} = await harness();
    await send("ENQUEUE", {text:"原任务"});
    const active = (await send("CLAIM", {ready:true})).dispatch;
    await send("SENT", {id:active.id});
    const id = (await send("STEER_PROMPT_CLAIM", {text:"暂停后的快捷指令",busy:true})).dispatch.id;
    await send("STEER_PAUSING", {id});
    if (release === "cancel") await send("STEER_CANCEL", {id});
    else await tick(2);
    const state = (await send("GET")).state;
    assert.equal(state.steeringTaskId, null, release);
    assert.equal(state.activeTaskId, null, release);
    assert.equal(state.tasks.find(task => task.id === active.id).status, "interrupted", release);
    const transient = state.tasks.find(task => task.id === id);
    assert.equal(transient.status, "error", release);
    assert.equal(transient.text, "暂停后的快捷指令", release);
    assert.equal(state.queuePaused, true, release);
    assert.equal(state.tasks.some(task => task.status === "pending"), false, release);
    assert.equal((await send("CLAIM", {ready:true})).dispatch, null, release);
  }
});

test("快捷引导拒绝非文本草稿或正在普通发送的对话，拒绝后不遗留任务", async () => {
  for (const invalid of ["empty", "attachment", "dispatching"]) {
    const {send} = await harness();
    if (invalid === "dispatching") {
      await send("ENQUEUE", {text:"普通发送尚未确认"});
      await send("CLAIM", {ready:true});
    }
    const before = (await send("GET")).state.tasks.length;
    const result = await send("STEER_PROMPT_CLAIM", {
      text:invalid === "empty" ? "  " : "快捷指令",
      images:invalid === "attachment" ? [{id:"native-attachment"}] : [],busy:true,
    });
    assert.equal(result.ok, false, invalid);
    const state = (await send("GET")).state;
    assert.equal(state.tasks.length, before, invalid);
    assert.equal(state.steeringTaskId, null, invalid);
  }
});

test("回复中可直接引导，原任务保留等待直到续答完成且指令不重复发送", async () => {
  const { send, advance } = await harness();
  await send("ENQUEUE", { text: "正在执行的任务" });
  await send("ENQUEUE", { text: "第二条普通任务" });
  await send("ENQUEUE", { text: "第三条需要引导" });
  const started = await send("CLAIM", { ready: true, userCount: 1, assistantCount: 1 });
  await send("SENT", { id: started.dispatch.id, verified: true, userCount: 2 });
  const third = (await send("GET")).state.tasks[2].id;

  const claimed = await send("STEER_CLAIM", {
    id: third, userCount: 2, lastUserId: "user-2", busy: true,
  });
  assert.equal(claimed.steerDeferred, false);
  assert.equal(claimed.dispatch.id, third);
  assert.equal(claimed.dispatch.needsPause, true);
  assert.equal(claimed.state.steeringTaskId, third);
  assert.equal(claimed.state.tasks[0].status, "waiting");
  assert.deepEqual(Array.from(claimed.state.tasks, task => task.text), [
    "正在执行的任务", "第二条普通任务", "第三条需要引导",
  ]);
  assert.equal((await send("STEER_CLAIM", { id: third })).ok, false);
  assert.equal((await send("CLAIM", { ready: true })).dispatch, null);
  await send("STEER_CLICKED", { id: third });
  const confirmed = await send("STEER_CONFIRM", {
    id: third, userCount: 3, lastUserId: "user-3", lastUserText: "第三条需要引导",
  });
  assert.equal(confirmed.state.activeTaskId, started.dispatch.id);
  assert.equal(confirmed.state.tasks[0].status, "waiting");
  assert.equal(confirmed.state.tasks[0].steerCount, 1);
  assert.equal(confirmed.state.tasks[0].lastSteerText, "第三条需要引导");
  assert.equal(confirmed.state.tasks.some(task => task.id === third), false);
  advance(3);
  const finished = await send("FINISHED", {
    ...voiceProof,
    id: started.dispatch.id, assistantCount: 2, userCount: 3,
    lastUserText: "第三条需要引导",
  });
  assert.equal(finished.ok, true);
  assert.equal(finished.state.tasks.length, 1);
  assert.equal((await send("CLAIM", { ready: true, assistantCount: 2, userCount: 3 })).dispatch.text,
    "第二条普通任务");
});

test("原生手动对话仍在生成时也能锁定即时引导，不修改其他队列顺序", async () => {
  const { send } = await harness();
  await send("ENQUEUE", { text:"普通待办" });
  const selectedId = (await send("ENQUEUE", { text:"优先引导" })).state.tasks[1].id;
  const claimed = await send("STEER_CLAIM", { id:selectedId, busy:true });
  assert.equal(claimed.steerDeferred, false);
  assert.equal(claimed.dispatch.id, selectedId);
  assert.equal(claimed.dispatch.needsPause, true);
  assert.deepEqual(Array.from(claimed.state.tasks, task => task.text),
    ["普通待办", "优先引导"]);
  assert.equal((await send("CLAIM", { ready:true })).dispatch, null);
});

test("引导暂停后发送续答，短暂空闲不能完成原任务且保留用户的队列暂停", async () => {
  const { send, advance } = await harness();
  await send("ENQUEUE", {text:"原任务"});
  const active = (await send("CLAIM", {ready:true,userCount:0})).dispatch;
  await send("SENT", {id:active.id});
  const selected = (await send("ENQUEUE", {text:"调整方向继续"})).state.tasks[1];
  await send("SET_QUEUE_PAUSED", {paused:true});
  await send("STEER_CLAIM", {id:selected.id,userCount:1,busy:true});
  const pausing = await send("STEER_PAUSING", {
    id:selected.id,assistantCount:1,lastAssistantId:"assistant-original",
  });
  assert.equal(Number.isFinite(pausing.state.tasks[1].steerPauseRequestedAt), true);
  assert.equal(pausing.state.tasks[1].steerPauseAssistantCount, 1);
  assert.equal(pausing.state.tasks[1].steerPauseAssistantId, "assistant-original");
  assert.equal(pausing.state.activeTaskId, active.id);
  advance(3);
  const stoppedSurface = await send("FINISHED", {...voiceProof,id:active.id});
  assert.equal(stoppedSurface.state.activeTaskId, active.id);
  assert.equal(stoppedSurface.state.tasks[0].status, "waiting");
  await send("STEER_CLICKED", {id:selected.id});
  const notContinued = await send("STEER_CONFIRM", {
    id:selected.id,userCount:2,lastUserText:selected.text,
  });
  assert.equal(notContinued.ok, false);
  assert.equal((await send("GET")).state.steeringTaskId, selected.id);
  const confirmed = await send("STEER_CONFIRM", {
    id:selected.id,userCount:2,lastUserText:selected.text,continuationObserved:true,
  });
  assert.equal(confirmed.state.tasks.length, 1);
  assert.equal(confirmed.state.activeTaskId, active.id);
  assert.equal(confirmed.state.tasks[0].steerCount, 1);
  assert.equal(confirmed.state.tasks[0].status, "waiting");
  assert.equal(confirmed.state.queuePaused, true);
  assert.equal(confirmed.state.halted, false);
});

test("尚未暂停原生回复就取消引导时，原任务保持等待且队列暂停状态不变", async () => {
  const { send } = await harness();
  await send("ENQUEUE", {text:"原任务"});
  const active = (await send("CLAIM", {ready:true})).dispatch;
  await send("SENT", {id:active.id});
  const selected = (await send("ENQUEUE", {text:"未发送的引导"})).state.tasks[1];
  await send("STEER_CLAIM", {id:selected.id,busy:true});
  const cancelled = await send("STEER_CANCEL", {id:selected.id});
  assert.equal(cancelled.state.activeTaskId, active.id);
  assert.equal(cancelled.state.tasks[0].status, "waiting");
  assert.equal(cancelled.state.tasks[1].status, "pending");
  assert.equal(cancelled.state.queuePaused, false);
});

test("暂停原回复后引导未发送而取消时，不把原任务误判完成或自动重发", async () => {
  const { send } = await harness();
  await send("ENQUEUE", {text:"原任务"});
  const active = (await send("CLAIM", {ready:true})).dispatch;
  await send("SENT", {id:active.id});
  const selected = (await send("ENQUEUE", {text:"未发送的引导"})).state.tasks[1];
  await send("STEER_CLAIM", {id:selected.id,busy:true});
  await send("STEER_PAUSING", {id:selected.id});
  const cancelled = await send("STEER_CANCEL", {id:selected.id});
  assert.equal(cancelled.state.activeTaskId, null);
  assert.equal(cancelled.state.steeringTaskId, null);
  assert.equal(cancelled.state.tasks[0].status, "interrupted");
  assert.equal(cancelled.state.tasks[1].status, "pending");
  assert.equal(cancelled.state.queuePaused, true);
  assert.match(cancelled.state.error, /核对.*手动继续/);
  assert.equal((await send("CLAIM", {ready:true})).dispatch, null);
});

test("暂停原生回复后引导锁过期时，恢复指令但暂停队列并隔离未完成原任务", async () => {
  const { send, tick } = await harness();
  await send("ENQUEUE", {text:"原任务"});
  const active = (await send("CLAIM", {ready:true})).dispatch;
  await send("SENT", {id:active.id});
  const selected = (await send("ENQUEUE", {text:"未发送的引导"})).state.tasks[1];
  await send("STEER_CLAIM", {id:selected.id,busy:true});
  await send("STEER_PAUSING", {id:selected.id});
  await tick(2);
  const state = (await send("GET")).state;
  assert.equal(state.activeTaskId, null);
  assert.equal(state.steeringTaskId, null);
  assert.equal(state.tasks[0].status, "interrupted");
  assert.equal(state.tasks[1].status, "pending");
  assert.equal(state.queuePaused, true);
  assert.equal((await send("CLAIM", {ready:true})).dispatch, null);
});

test("快捷键的优先消息入队原子置顶，不改动 active 状态", async () => {
  const { send } = await harness();
  await send("ENQUEUE", { text:"正在运行" });
  const first = await send("CLAIM", { ready:true });
  await send("SENT", { id:first.dispatch.id });
  await send("ENQUEUE", { text:"已有待办" });
  const queued = await send("ENQUEUE", { text:"快捷键引导", priority:true });
  assert.equal(queued.state.activeTaskId, first.dispatch.id);
  assert.equal(queued.state.tasks[0].status, "waiting");
  assert.deepEqual(Array.from(queued.state.tasks, task => task.text),
    ["正在运行", "快捷键引导", "已有待办"]);
  assert.equal(queued.state.halted, false);
});

test("普通空闲队列也可选定一条任务提前发送，不会更改其他任务顺序", async () => {
  const { send } = await harness();
  const first = await send("ENQUEUE", { text: "原本第一条" });
  const secondId = (await send("ENQUEUE", { text: "选中的第二条" })).state.tasks[1].id;
  await send("STEER_CLAIM", { id: secondId, userCount: 0 });
  await send("STEER_CLICKED", { id: secondId });
  const confirmed = await send("STEER_CONFIRM", {
    id: secondId, userCount: 1, lastUserText: "选中的第二条",
  });
  assert.equal(confirmed.state.tasks.length, 1);
  assert.equal(confirmed.state.tasks[0].id, first.state.tasks[0].id);
  assert.equal(confirmed.state.tasks[0].text, "原本第一条");
  assert.equal(confirmed.state.activeTaskId, null);
  assert.equal((await send("CLAIM", { ready: true, userCount: 1, assistantCount: 1 })).dispatch.text,
    "原本第一条");
});

test("网页不支持即时发送时取消引导，消息保持待发送且顺序不变", async () => {
  const { send } = await harness();
  await send("ENQUEUE", { text: "第一条" });
  const id = (await send("ENQUEUE", { text: "需要引导" })).state.tasks[1].id;
  await send("STEER_CLAIM", { id, userCount: 1 });
  const result = await send("STEER_CANCEL", { id });
  assert.equal(result.state.tasks.length, 2);
  assert.equal(result.state.tasks[0].text, "第一条");
  assert.equal(result.state.tasks[1].text, "需要引导");
  assert.equal(result.state.tasks[1].status, "pending");
  assert.equal(result.state.steeringTaskId, null);
  assert.equal((await send("CLAIM", { ready: true })).dispatch.text, "第一条");
});

test("已点击引导但未确认时永不自动重试，超时只能人工核对", async () => {
  const { send, tick } = await harness();
  await send("ENQUEUE", { text: "旧任务" });
  const selectedId = (await send("ENQUEUE", { text: "需要即时引导" })).state.tasks[1].id;
  await send("STEER_CLAIM", { id: selectedId, userCount: 1 });
  await send("STEER_CLICKED", { id: selectedId });
  await send("ENQUEUE", { text: "第三条" });
  await tick(3);
  const uncertain = (await send("GET")).state;
  assert.equal(uncertain.halted, true);
  assert.equal(uncertain.haltReason, "steer_unconfirmed");
  assert.equal(uncertain.steeringTaskId, null);
  assert.equal(uncertain.tasks[1].status, "error");
  assert.equal(uncertain.tasks[2].status, "pending");
  assert.equal((await send("CLAIM", { ready: true })).dispatch, null);

  const safe = await send("SKIP_FAILED", { id: selectedId });
  assert.equal(safe.state.halted, false);
  assert.equal(safe.state.tasks.length, 2);
  assert.equal(safe.state.activeTaskId, null);
  assert.equal(safe.state.tasks[1].text, "第三条");
  assert.equal((await send("CLAIM", { ready: true })).dispatch.text, "旧任务");
});

test("引导不能串对话或抢占发送中任务，手动停止不会自动恢复", async () => {
  const { send } = await harness();
  await send("ENQUEUE", { text: "A 第一条" }, 11);
  const id = (await send("ENQUEUE", { text: "A 第二条" }, 11)).state.tasks[1].id;
  assert.equal((await send("STEER_CLAIM", { id }, 12)).ok, false);
  const first = await send("CLAIM", { ready: true }, 11);
  const early = await send("STEER_CLAIM", { id }, 11);
  assert.equal(early.ok, false);
  assert.equal((await send("GET")).state.activeTaskId, first.dispatch.id);
  await send("SENT", { id: first.dispatch.id, verified: true, userCount: 1 }, 11);
  assert.equal((await send("STEER_CLAIM", { id, userCount: 1 }, 11)).dispatch.id, id);
  await send("STOPPED", { userCount: 1 }, 11);
  const stopped = (await send("GET", {}, 11)).state;
  assert.equal(stopped.halted, true);
  assert.equal(stopped.haltReason, "user");
  assert.equal(stopped.steeringTaskId, null);
  assert.equal(stopped.tasks[1].status, "pending");
  assert.equal((await send("STEER_CLAIM", { id }, 11)).ok, false);
});

test("有限定时器在引导第一条时仍按时生成第二条普通待办", async () => {
  const { send, tick } = await harness();
  await send("ADD_SCHEDULE", { text: "定时引导", intervalMinutes: 1, repeatCount: 1 });
  await tick(1);
  const first = (await send("GET")).state;
  const selectedId = first.tasks[0].id;
  await send("STEER_CLAIM", { id: selectedId, userCount: 0 });
  await tick(1);
  const reserved = (await send("GET")).state;
  assert.equal(reserved.tasks.length, 2);
  assert.equal(reserved.tasks[0].status, "steering");
  assert.equal(reserved.tasks[1].status, "pending");
  assert.equal(reserved.schedules[0].runCount, 2);
  assert.equal(reserved.schedules[0].enabled, false);
  assert.equal("deferred" in reserved.schedules[0], false);
  const restored = await send("STEER_CANCEL", { id: selectedId });
  assert.equal(restored.state.tasks[0].status, "pending");
  assert.equal(restored.state.tasks.length, 2);
  assert.equal(restored.state.schedules[0].runCount, 2);
  const steer = await send("STEER_CLAIM", { id: selectedId, userCount: 0 });
  assert.equal(steer.dispatch.text, "定时引导");
  await send("STEER_CLICKED", { id: selectedId });
  const sent = await send("STEER_CONFIRM", {
    id: selectedId, userCount: 1, lastUserText: "定时引导",
  });
  assert.equal(sent.state.tasks.length, 1);
  assert.equal(sent.state.tasks[0].status, "pending");
  assert.equal(sent.state.schedules[0].runCount, 2);
});

test("尚未点击发送的引导锁超时后安全回队列，不会造成永久锁定", async () => {
  const { send, tick } = await harness();
  await send("ENQUEUE", { text: "第一条普通消息" });
  const id = (await send("ENQUEUE", { text: "第二条引导" })).state.tasks[1].id;
  await send("STEER_CLAIM", { id, userCount: 0 });
  await tick(2);
  const recovered = (await send("GET")).state;
  assert.equal(recovered.steeringTaskId, null);
  assert.equal(recovered.tasks[1].status, "pending");
  assert.equal(recovered.halted, false);
  assert.equal((await send("CLAIM", { ready: true })).dispatch.text, "第一条普通消息");
});

test("确认引导需要匹配新用户消息，错误文本或未变化的用户消息不能移除队列任务", async () => {
  const { send } = await harness();
  const id = (await send("ENQUEUE", { text: "要引导的消息" })).state.tasks[0].id;
  await send("STEER_CLAIM", { id, userCount: 3, lastUserId: "u3" });
  await send("STEER_CLICKED", { id });
  assert.equal((await send("STEER_CONFIRM", {
    id, userCount: 3, lastUserId: "u3", lastUserText: "要引导的消息",
  })).ok, false);
  assert.equal((await send("STEER_CONFIRM", {
    id, userCount: 4, lastUserId: "u4", lastUserText: "其他消息",
  })).ok, false);
  assert.equal((await send("GET")).state.tasks[0].status, "steering_wait");
  const confirmed = await send("STEER_CONFIRM", {
    id, userCount: 3, lastUserId: "u4", lastUserText: "要引导的消息",
  });
  assert.equal(confirmed.ok, true);
  assert.equal(confirmed.state.tasks.length, 0);
});

test("引导已点击后用户主动停止，不得从失败项重新开启用户暂停的队列", async () => {
  const { send } = await harness();
  const id = (await send("ENQUEUE", { text: "原本待发送" })).state.tasks[0].id;
  await send("STEER_CLAIM", { id, userCount: 0 });
  await send("STEER_CLICKED", { id });
  const stopped = await send("STOPPED", { userCount: 1 });
  assert.equal(stopped.state.steeringTaskId, null);
  assert.equal(stopped.state.halted, true);
  assert.equal(stopped.state.haltReason, "user");
  assert.equal(stopped.state.tasks[0].status, "error");
  const stillStopped = await send("SKIP_FAILED", { id });
  assert.equal(stillStopped.state.halted, true);
  assert.equal(stillStopped.state.tasks.length, 1);
});

test("新任务必须等语音模式按钮稳定恢复，单有新回复或麦克风不能推动无限定时队列", async () => {
  const { send, tick, advance } = await harness();
  await send("ADD_SCHEDULE", {text:"定时语音按钮验证",intervalMinutes:1,repeatCount:-1});
  await tick(1);
  const started=await send("CLAIM",{ready:true,userCount:2,assistantCount:2,
    lastAssistantId:"a2",lastAssistantSignature:"7|旧回答内容"});
  const id=started.dispatch.id;
  await send("SENT",{id,verified:false});
  advance(4);
  const proof={...voiceProof,id,assistantFallback:true,assistantCount:3,
    lastAssistantId:"a3",lastAssistantSignature:"9|新的回答内容",stableMs:2100};

  assert.equal((await send("FINISHED",{...proof,voiceReady:false})).ok,false);
  assert.equal((await send("FINISHED",{...proof,voiceStableMs:300})).ok,false);
  assert.equal((await send("FINISHED",{...proof,busy:true})).ok,false);
  assert.equal((await send("FINISHED",{...proof,editorEmpty:false})).ok,false);
  // Assistant text/IDs are intentionally irrelevant once Voice Mode returns.
  const stillWaiting=(await send("GET")).state;
  assert.equal(stillWaiting.activeTaskId,id);
  assert.equal(stillWaiting.tasks[0].status,"waiting");

  const finished=await send("FINISHED",proof);
  assert.equal(finished.ok,true);
  assert.equal(finished.state.tasks.length,0);
  assert.equal(finished.state.halted,false);
  await tick(1);
  const next=(await send("GET")).state;
  assert.equal(next.tasks.length,1);
  assert.equal(next.schedules[0].runCount,2);
  assert.equal(next.schedules[0].enabled,true);
  assert.equal((await send("CLAIM",{ready:true,assistantCount:3,userCount:3})).dispatch.text,
    "定时语音按钮验证");
});

test("领取消息携带原始页面绑定，切页后只允许原持有者释放旧任务", async () => {
  const env = await harness({}, {structuredStorage:true});
  await env.send("ENQUEUE",{text:"只发到 A"},11);
  await env.send("ENQUEUE",{text:"B 自己的任务"},12);
  const claimed = await env.send("CLAIM",{ready:true,userCount:2},11);
  const targetClaim = await env.send("CLAIM",{ready:true},12);
  assert.equal(claimed.dispatch.sourceUrl,A);
  assert.equal(claimed.dispatch.sourceSessionKey,"chat:dialogue-a");
  assert.equal(Object.hasOwn(claimed.dispatch,"projectVisitId"),false);
  const targetBefore = structuredClone(env.stored["cq.state.v2"].conversations["chat:dialogue-b"]);

  env.navigate(11,B);
  const foreign = await env.send("RELEASE_CLAIM",{id:claimed.dispatch.id},12,A,{url:B});
  assert.equal(foreign.state.activeTaskId,claimed.dispatch.id,"其他标签页不能释放 A 的预约");
  const wrongPage = await env.send("RELEASE_CLAIM",{id:claimed.dispatch.id},11,B,{url:B});
  assert.equal(wrongPage.state.activeTaskId,targetClaim.dispatch.id,"新页面不能按旧任务 ID 释放其任务");
  assert.equal(env.stored["cq.state.v2"].conversations["chat:dialogue-a"].activeTaskId,
    claimed.dispatch.id);

  const released = await env.send("RELEASE_CLAIM",{id:claimed.dispatch.id},11,A,{url:B});
  assert.equal(released.ok,true);
  assert.equal(released.sessionKey,"chat:dialogue-a");
  assert.equal(released.state.activeTaskId,null);
  assert.equal(released.state.tasks[0].id,claimed.dispatch.id);
  assert.equal(released.state.tasks[0].status,"pending");
  assert.equal(released.state.halted,false);
  assert.deepEqual(env.stored["cq.state.v2"].conversations["chat:dialogue-b"],targetBefore,
    "仅释放原页面任务，不改动切换后的页面队列");
});

test("项目首页领取消息保留本次访问身份", async () => {
  const env = await harness({}, {structuredStorage:true});
  const url = "https://chatgpt.com/g/g-p-claim-origin/project";
  const projectVisitId = "claim-visit-origin";
  env.navigate(11,url);
  await env.send("ENQUEUE",{text:"项目内新对话任务",projectVisitId},11,url);
  const claimed = await env.send("CLAIM",{ready:true,projectVisitId},11,url);
  assert.equal(claimed.dispatch.sourceUrl,url);
  assert.equal(claimed.dispatch.sourceSessionKey,"draft:11");
  assert.equal(claimed.dispatch.projectVisitId,projectVisitId);
});

test("领取任务后语音按钮临时消失，未点击发送应安全回队列且不会暂停定时器", async () => {
  const { send, tick, advance } = await harness();
  await send("ADD_SCHEDULE", {text:"语音按钮反复切换",intervalMinutes:1,repeatCount:-1});
  await tick(1);
  const before=(await send("GET")).state;
  const claimed=await send("CLAIM",{ready:true,userCount:2,assistantCount:2});
  assert.equal(claimed.dispatch.text,"语音按钮反复切换");
  const release=await send("RELEASE_CLAIM",{id:claimed.dispatch.id});
  assert.equal(release.state.tasks.length,1);
  assert.equal(release.state.tasks[0].id,before.tasks[0].id);
  assert.equal(release.state.tasks[0].status,"pending");
  assert.equal(release.state.activeTaskId,null);
  assert.equal(release.state.halted,false);
  assert.equal(release.state.schedules[0].enabled,true);
  assert.equal((await send("CLAIM",{ready:true})).dispatch,null);
  advance(3);
  const restored=await send("CLAIM",{ready:true,userCount:2,assistantCount:2});
  assert.equal(restored.dispatch.text,"语音按钮反复切换");
  assert.equal(restored.state.schedules[0].runCount,1);
});

test("普通聊天：自动接力通过普通新聊天接续，保留队列与规则，不跨标签或项目", async () => {
  const env=await harness();
  const sourceUrl="https://chatgpt.com/c/personal-old";
  const home="https://chatgpt.com/";
  const destinationUrl="https://chatgpt.com/c/personal-new";
  env.navigate(11,sourceUrl);
  const configured=await env.send("SET_HANDOFF",{
    enabled:true,intervalMinutes:1,repeatCount:2,
  },11,sourceUrl);
  assert.equal(configured.ok,true);
  env.advance(61);
  const due=await env.send("SCHEDULE_PULSE",{},11,sourceUrl);
  assert.equal(due.state.tasks[0].kind,"handoff_summary");
  assert.equal(due.state.handoff.remainingCount,2);
  const task=await env.send("ENQUEUE",{text:"延续的普通聊天待办"},11,sourceUrl);
  const originalTaskId=task.state.tasks.at(-1).id;
  const rule=await env.send("ADD_SCHEDULE",{
    text:"保留原定时规则",intervalMinutes:180,repeatCount:4,
  },11,sourceUrl);
  const originalRuleId=rule.state.schedules[0].id;
  const claim=await env.send("CLAIM",{ready:true,userCount:2},11,sourceUrl);
  assert.equal(claim.dispatch.kind,"handoff_summary");
  await env.send("SENT",{id:claim.dispatch.id},11,sourceUrl);
  env.advance(3);
  const summary=await env.send("FINISHED",{
    id:claim.dispatch.id,...handoffProof,userCount:3,
    handoffSummary:"任务主题：继续个人聊天\n保留任务、定时规则和所有安全校验。",
  },11,sourceUrl);
  assert.equal(summary.state.handoff.phase,"opening");
  assert.equal(summary.state.handoff.projectId,"personal");
  assert.equal(summary.state.handoff.projectUrl,home);
  assert.equal((await env.send("HANDOFF_NAVIGATE",{userCount:3},11,sourceUrl)).ok,true);

  env.navigate(12,home);
  const otherTab=await env.send("HELLO",{},12,home);
  assert.equal(otherTab.state.tasks.length,0,"其他标签不得获得接力内容");
  env.navigate(11,"https://chatgpt.com/g/g-p-unrelated/project");
  const otherProject=await env.send("HELLO",{projectVisitId:"wrong-project"},11,
    "https://chatgpt.com/g/g-p-unrelated/project");
  assert.equal(otherProject.state.tasks.length,0,"项目新聊天不得接收普通聊天接力");
  env.navigate(11,home);
  const attached=await env.send("HELLO",{},11,home);
  assert.equal(attached.state.tasks.length,1);
  assert.equal(attached.state.tasks[0].kind,"handoff_intro");
  const intro=await env.send("CLAIM",{ready:true,userCount:0},11,home);
  assert.equal(intro.dispatch.kind,"handoff_intro");
  await env.send("SENT",{id:intro.dispatch.id},11,home);
  env.navigate(11,destinationUrl);
  const adopted=await env.send("HELLO",{lastUserText:intro.dispatch.text},11,destinationUrl);
  assert.equal(adopted.sessionKey,"chat:personal-new");
  assert.equal(adopted.state.tasks[0].kind,"handoff_intro");
  env.advance(3);
  const completed=await env.send("FINISHED",{
    id:intro.dispatch.id,...voiceProof,
  },11,destinationUrl);
  assert.equal(completed.ok,true);
  assert.equal(completed.state.tasks[0].id,originalTaskId);
  assert.equal(completed.state.schedules[0].id,originalRuleId);
  assert.equal(completed.state.handoff.enabled,true);
  assert.equal(completed.state.handoff.remainingCount,1);
  assert.equal(env.stored["cq.state.v2"].conversations["chat:personal-old"].tasks.length,0);
});

test("上下文接力：原生项目内生成总结、同标签新建对话并原子迁移图文队列与定时规则", async () => {
  const env = await harness();
  const project = "g-p-example-handoff";
  const sourceUrl = `https://chatgpt.com/g/${project}/c/old-session`;
  const projectUrl = `https://chatgpt.com/g/${project}/project`;
  const nextUrl = `https://chatgpt.com/g/${project}/c/next-session`;
  env.navigate(11,sourceUrl);
  assert.equal((await env.send("SET_HANDOFF", {
    enabled:true,intervalMinutes:60,repeatCount:2,
  },11,sourceUrl)).ok,true);
  env.advance(3601);
  const due = await env.send("SCHEDULE_PULSE",{},11,sourceUrl);
  assert.equal(due.state.handoff.phase,"queued");
  assert.equal(due.state.tasks[0].kind,"handoff_summary","空队列到期也加入交接命令");
  assert.equal(due.state.handoff.remainingCount,2,"入队不扣减次数");
  assert.equal(env.stored["cq.handoffDebug.v1"].runs[0].mode,"automatic");
  assert.equal(env.stored["cq.handoffDebug.v1"].runs[0].events[0].phase,"queued");
  const pending = await env.send("ENQUEUE",{
    text:"继续修复游戏背包界面",images:[testImage],
  },11,sourceUrl);
  const pendingTask = pending.state.tasks.at(-1);
  const rule = await env.send("ADD_SCHEDULE",{
    text:"下一次自动巡检",intervalMinutes:180,images:[testImage],
  },11,sourceUrl);
  assert.equal(rule.ok,true);
  const claim = await env.send("CLAIM",{ready:true,userCount:2},11,sourceUrl);
  assert.equal(claim.ok,true);
  assert.doesNotMatch(claim.dispatch.text,/CHATGPT_TASKQUEUE_HANDOFF_(START|END)/);
  assert.equal(claim.state.tasks[1].id,pendingTask.id);
  await env.send("SENT",{id:claim.dispatch.id},11,sourceUrl);
  env.advance(3);
  const summary = handoffReply(claim.dispatch.text,
    "项目进度与目标：继续游戏开发，保留所有队列任务、图片、自动规则和原有设置。".repeat(12));
  const finished = await env.send("FINISHED",{
    id:claim.dispatch.id,...handoffProof,handoffSummary:summary,
    handoffLastUserText:"网页把上一条用户消息虚拟化了，无法读回完整原文",
  },11,sourceUrl);
  assert.equal(finished.ok,true);
  assert.equal(finished.state.handoff.phase,"opening");
  assert.equal(finished.state.tasks.length,1,"总结完成不能清除剩余队列");
  assert.equal((await env.send("HANDOFF_NAVIGATE",{},11,sourceUrl)).ok,true);

  env.navigate(11,projectUrl);
  const attached = await env.send("HELLO",{},11,projectUrl);
  assert.equal(attached.ok,true);
  assert.equal(attached.state.tasks[0].kind,"handoff_intro");
  assert.equal((await env.sendDashboard("DASHBOARD_GET")).dashboard.sessions
    .some(item=>item.key==="draft:11"),false,
    "项目入口的内部接力草稿不能被列成独立的普通对话队列");
  const introductory = await env.send("CLAIM",{ready:true,userCount:0},11,projectUrl);
  assert.match(introductory.dispatch.text,/项目进度与目标/);
  await env.send("SENT",{id:introductory.dispatch.id},11,projectUrl);
  env.navigate(11,nextUrl);
  const adopted = await env.send("HELLO",{
    lastUserText:introductory.dispatch.text,
  },11,nextUrl);
  assert.equal(adopted.ok,true);
  assert.equal(adopted.sessionKey,"chat:next-session");
  assert.equal(adopted.state.tasks[0].kind,"handoff_intro");
  env.advance(3);
  const transferred = await env.send("FINISHED",{
    id:introductory.dispatch.id,...voiceProof,
  },11,nextUrl);
  assert.equal(transferred.ok,true);
  assert.equal(transferred.state.tasks.length,1);
  assert.equal(transferred.state.tasks[0].id,pendingTask.id);
  assert.equal(transferred.state.tasks[0].images[0].id,pendingTask.images[0].id);
  assert.equal(transferred.state.schedules.length,1);
  assert.equal(transferred.state.handoff.enabled,true);
  assert.equal(transferred.state.handoff.phase,"idle");
  assert.equal(transferred.state.handoff.repeatCount,2);
  assert.equal(transferred.state.handoff.remainingCount,1,"新对话确认成功后才扣减");
  assert.ok(transferred.state.handoff.nextAt > transferred.state.lastQueueSettledAt);
  const old = env.stored["cq.state.v2"].conversations["chat:old-session"];
  assert.equal(old.tasks.length,0);
  assert.equal(old.schedules.length,0);
  assert.equal(old.handoff.phase,"completed");
  const debugFromNew=await env.send("GET_HANDOFF_DEBUG",{},11,nextUrl);
  assert.equal(debugFromNew.ok,true);
  assert.equal(debugFromNew.runs[0].status,"completed");
  assert.equal(debugFromNew.runs[0].phase,"completed");
  assert.ok(debugFromNew.runs[0].events.some(event =>
    event.phase==="bootstrapping" && event.introStatus==="waiting"));
  assert.equal(JSON.stringify(debugFromNew.runs).includes("sourceKey"),false);
  assert.equal(env.storedImages.has(pendingTask.images[0].id),true);
  assert.equal(env.tabUpdates.some((item)=>item.url===projectUrl),false,
    "后台不能偷偷创建或导航其他标签");
});

test("接力新聊天：URL 先出现、首条消息稍后渲染也不会丢掉置顶交接或旧队列", async () => {
  const env = await harness();
  const project="g-p-6ad25b09f7988191b8c35b36d03e3d70";
  const origin=`https://chatgpt.com/g/${project}-pcc/c/old`;
  const landing=`https://chatgpt.com/g/${project}/project`;
  const newChat=`https://chatgpt.com/g/${project}/c/fresh`;
  env.navigate(11,origin);
  await env.send("HANDOFF_NOW",{},11,origin);
  await env.send("ENQUEUE",{text:"原有任务必须安全留在旧对话"},11,origin);
  const summaryClaim=await env.send("CLAIM",{ready:true,userCount:2},11,origin);
  await env.send("SENT",{id:summaryClaim.dispatch.id},11,origin);
  env.advance(3);
  const completed=await env.send("FINISHED",{
    id:summaryClaim.dispatch.id,...handoffProof,
    handoffSummary:"交接完整内容，继续开发并保留所有任务和配置。".repeat(28),
    userCount:3,
  },11,origin);
  assert.equal(completed.state.handoff.phase,"opening");
  await env.send("HANDOFF_NAVIGATE",{userCount:3},11,origin);
  env.navigate(11,landing);
  const waiting=await env.send("HELLO",{},11,landing);
  assert.equal(waiting.ok,true);
  assert.equal(waiting.state.tasks[0].kind,"handoff_intro");
  assert.equal(waiting.state.tasks.length,1);
  const intro=await env.send("CLAIM",{ready:true,userCount:0},11,landing);
  assert.equal(intro.dispatch.id,waiting.state.tasks[0].id);

  // SPA redirect arrives before the native user message is hydrated.
  env.navigate(11,newChat);
  const early=await env.send("HELLO",{lastUserText:""},11,newChat);
  assert.equal(early.ok,true);
  assert.equal(early.awaitingChatConfirmation,true);
  assert.equal(early.sessionKey,"draft:11");
  assert.equal(early.state.activeTaskId,intro.dispatch.id);
  assert.equal(early.state.tasks.length,1);

  const sent=await env.send("SENT",{
    id:intro.dispatch.id,lastUserText:"",
  },11,newChat);
  assert.equal(sent.ok,true);
  assert.equal(sent.sessionKey,"draft:11");
  assert.equal(sent.state.tasks[0].status,"waiting");
  assert.equal(env.stored["cq.state.v2"].conversations["chat:fresh"],undefined);
  assert.equal(env.stored["cq.state.v2"].conversations["chat:old"].tasks.length,1);

  const confirmed=await env.send("HELLO",{
    lastUserText:intro.dispatch.text,
  },11,newChat);
  assert.equal(confirmed.sessionKey,"chat:fresh");
  assert.equal(confirmed.state.tasks[0].kind,"handoff_intro");
  assert.equal(confirmed.state.tasks[0].status,"waiting");
  assert.equal(env.stored["cq.state.v2"].conversations["draft:11"],undefined);
  assert.equal((await env.send("GET",{},11,newChat)).state.tasks.length,1);
  env.advance(3);
  const accepted=await env.send("FINISHED",{
    id:intro.dispatch.id,...voiceProof,
  },11,newChat);
  assert.equal(accepted.ok,true);
  assert.equal(accepted.state.tasks[0].text,"原有任务必须安全留在旧对话");
  assert.equal(env.stored["cq.state.v2"].conversations["chat:old"].handoff.phase,"completed");
});

test("接力新聊天：折叠的首条用户消息可确认归属，但错误项目或短文本绝不认领", async () => {
  const env=await harness();
  const project="g-p-6ad25b09f7988191b8c35b36d03e3d70";
  const origin=`https://chatgpt.com/g/${project}/c/source-preview`;
  const landing=`https://chatgpt.com/g/${project}/project`;
  const wrong=`https://chatgpt.com/g/g-p-another-project/c/foreign`;
  const next=`https://chatgpt.com/g/${project}/c/preview-new`;
  env.navigate(11,origin);
  await env.send("HANDOFF_NOW",{},11,origin);
  const claim=await env.send("CLAIM",{ready:true,userCount:0},11,origin);
  await env.send("SENT",{id:claim.dispatch.id},11,origin);
  env.advance(3);
  await env.send("FINISHED",{
    id:claim.dispatch.id,...handoffProof,
    handoffSummary:"用于模拟 ChatGPT 折叠长提示词的完整交接信息。".repeat(32),
  },11,origin);
  await env.send("HANDOFF_NAVIGATE",{},11,origin);
  env.navigate(11,landing);
  await env.send("HELLO",{},11,landing);
  const intro=await env.send("CLAIM",{ready:true},11,landing);
  await env.send("SENT",{id:intro.dispatch.id},11,landing);
  env.navigate(11,wrong);
  assert.equal((await env.send("HELLO",{
    lastUserText:intro.dispatch.text,
  },11,wrong)).state.key,"chat:foreign");
  assert.ok(env.stored["cq.state.v2"].conversations["draft:11"]);

  env.navigate(11,next);
  const short=await env.send("HELLO",{lastUserText:intro.dispatch.text.slice(0,45)},11,next);
  assert.equal(short.sessionKey,"draft:11");
  assert.equal(short.awaitingChatConfirmation,true);
  for (const suffix of ["…","..."]) {
    const preview=intro.dispatch.text.slice(0,190)+suffix;
    const unconfirmed=await env.send("HELLO",{lastUserText:preview},11,next);
    assert.equal(unconfirmed.sessionKey,"draft:11",
      "没有原生折叠标记时，不能把正文末尾字符当作展示省略号删除");
    const foldedEnv=await harness(env.stored);
    foldedEnv.navigate(11,next);
    const folded=await foldedEnv.send("HELLO",{
      lastUserText:preview,lastUserFolded:true,
    },11,next);
    assert.equal(folded.sessionKey,"chat:preview-new");
    assert.equal(folded.state.tasks[0].kind,"handoff_intro");
  }
  for (const preview of [
    intro.dispatch.text.slice(0,45)+"…",
    intro.dispatch.text.slice(25,215)+"…",
    intro.dispatch.text.slice(0,190)+"显示更多",
  ]) {
    const rejected=await env.send("HELLO",{lastUserText:preview,lastUserFolded:true},11,next);
    assert.equal(rejected.sessionKey,"draft:11",
      "折叠标记不能绕过长度、开头匹配或剔除正文其他字符");
  }
  const prefix=await env.send("HELLO",{lastUserText:intro.dispatch.text.slice(0,190)},11,next);
  assert.equal(prefix.sessionKey,"chat:preview-new");
  assert.equal(prefix.state.tasks[0].kind,"handoff_intro");
  assert.equal(env.stored["cq.state.v2"].conversations["chat:source-preview"].tasks.length,0);
});

test("接力接收：短折叠预览不迁移，展开全文确认后一次继承任务和两类自动规则",async()=>{
  const env=await harness();
  const project="g-p-expand-handoff-receipt";
  const origin=`https://chatgpt.com/g/${project}/c/receipt-source`;
  const landing=`https://chatgpt.com/g/${project}/project`;
  const next=`https://chatgpt.com/g/${project}/c/receipt-destination`;
  const wrong="https://chatgpt.com/g/g-p-other-receipt/c/foreign-receipt";
  env.navigate(11,origin);
  await env.send("SET_HANDOFF",{enabled:true,intervalMinutes:120,repeatCount:3},11,origin);
  await env.send("HANDOFF_NOW",{},11,origin);
  const queued=await env.send("ENQUEUE",{text:"原队列下一项"},11,origin);
  const pendingId=queued.state.tasks.find(task=>task.text==="原队列下一项").id;
  const countAdded=await env.send("ADD_SCHEDULE",{
    text:"数量规则继续补队",mode:"count",threshold:1,repeatCount:-1,
  },11,origin);
  const countId=countAdded.state.schedules.find(rule=>rule.mode==="count").id;
  const timeAdded=await env.send("ADD_SCHEDULE",{
    text:"时间规则继续计时",intervalMinutes:30,repeatCount:-1,
  },11,origin);
  const timeRule=timeAdded.state.schedules.find(rule=>rule.id!==countId);
  const timeId=timeRule.id;
  const timeNextAt=timeRule.nextRunAt;
  const summary=await env.send("CLAIM",{ready:true,userCount:0},11,origin);
  assert.equal(summary.dispatch.kind,"handoff_summary");
  await env.send("SENT",{id:summary.dispatch.id},11,origin);
  env.advance(3);
  await env.send("FINISHED",{id:summary.dispatch.id,...handoffProof,userCount:1,
    handoffSummary:"任务主题：继续回复帖子\n"+
      "保留用户目标、已完成处理记录、当前进度、剩余队列和自动规则。".repeat(20),
  },11,origin);
  await env.send("HANDOFF_NAVIGATE",{userCount:1},11,origin);
  env.navigate(11,landing);
  await env.send("HELLO",{},11,landing);
  const intro=await env.send("CLAIM",{ready:true,userCount:0},11,landing);
  await env.send("SENT",{id:intro.dispatch.id},11,landing);
  const preview=intro.dispatch.text.slice(0,80)+"…";

  env.navigate(11,wrong);
  const wrongProject=await env.send("HELLO",{
    lastUserText:intro.dispatch.text,lastUserFolded:false,
  },11,wrong);
  assert.notEqual(wrongProject.sessionKey,"draft:11");
  assert.equal(wrongProject.state.handoffSourceKey,undefined);
  env.navigate(12,next);
  const otherTab=await env.send("HELLO",{
    lastUserText:intro.dispatch.text,lastUserFolded:false,
  },12,next);
  assert.equal(otherTab.state.handoffSourceKey,undefined,"其他标签不能认领接力内容");

  env.navigate(11,next);
  const folded=await env.send("HELLO",{
    lastUserText:preview,lastUserFolded:true,userCount:1,
  },11,next);
  assert.equal(folded.sessionKey,"draft:11");
  assert.equal(folded.awaitingChatConfirmation,true);
  assert.equal(folded.state.tasks[0].id,intro.dispatch.id);
  assert.equal(folded.state.tasks[0].status,"waiting");
  assert.equal(folded.state.schedules.length,0,"接收身份未确认前不复制规则");
  const sourceBefore=env.stored["cq.state.v2"].conversations["chat:receipt-source"];
  assert.equal(sourceBefore.tasks[0].id,pendingId);
  assert.equal(sourceBefore.schedules.length,2);
  assert.equal(sourceBefore.handoff.phase,"bootstrapping");
  assert.equal(env.stored["cq.state.v2"].conversations["chat:receipt-destination"],undefined);

  // The content script expands only the native first user bubble, then
  // supplies its complete authored text instead of weakening identity checks.
  const expanded=await env.send("HELLO",{
    lastUserText:intro.dispatch.text,lastUserFolded:false,userCount:1,
  },11,next);
  assert.equal(expanded.sessionKey,"chat:receipt-destination");
  assert.equal(expanded.state.tasks[0].id,intro.dispatch.id);
  assert.equal(expanded.state.schedules.length,0,"归属确认与完成迁移仍是两步");
  assert.equal(env.stored["cq.state.v2"].conversations["draft:11"],undefined);
  env.advance(3);
  const received=await env.send("FINISHED",{
    id:intro.dispatch.id,...voiceProof,userCount:1,
  },11,next);
  assert.equal(received.ok,true);
  assert.deepEqual(Array.from(received.state.tasks,task=>task.id),[pendingId]);
  assert.deepEqual(Array.from(received.state.schedules,rule=>rule.id),[countId,timeId]);
  assert.equal(received.state.schedules.find(rule=>rule.id===timeId).nextRunAt,timeNextAt);
  assert.equal(received.state.schedules.find(rule=>rule.id===countId).runCount,0);
  assert.equal(received.state.schedules.every(rule=>rule.enabled),true);
  assert.equal(received.state.handoffSourceKey,undefined);
  assert.equal(received.state.handoff.phase,"idle");
  assert.equal(received.state.handoff.enabled,true);
  assert.equal(received.state.handoff.remainingCount,3,"手动接力不消耗自动接力次数");
  const old=env.stored["cq.state.v2"].conversations["chat:receipt-source"];
  assert.equal(old.tasks.length,0);
  assert.equal(old.schedules.length,0);
  assert.equal(old.handoff.phase,"completed");

  await env.send("HELLO",{lastUserText:intro.dispatch.text,userCount:1},11,next);
  const repeated=await env.send("FINISHED",{id:intro.dispatch.id,...voiceProof},11,next);
  assert.deepEqual(Array.from(repeated.state.tasks,task=>task.id),[pendingId]);
  assert.equal(repeated.state.schedules.length,2);
  assert.equal(repeated.state.schedules.find(rule=>rule.id===countId).runCount,0);
  const original=await env.send("CLAIM",{ready:true,userCount:1},11,next);
  assert.equal(original.dispatch.id,pendingId);
  await env.send("SENT",{id:pendingId},11,next);
  env.advance(3);
  const completed=await env.send("FINISHED",{id:pendingId,...voiceProof},11,next);
  const generated=completed.state.tasks.find(task=>task.sourceScheduleId===countId);
  assert.ok(generated,"原 pending 项完成后数量规则在新对话继续补队");
  assert.equal(completed.state.tasks.length,1);
  assert.equal(completed.state.schedules.find(rule=>rule.id===countId).runCount,1);
  assert.equal(completed.state.schedules.find(rule=>rule.id===timeId).runCount,0);
  const auto=await env.send("CLAIM",{ready:true,userCount:2},11,next);
  assert.equal(auto.dispatch.id,generated.id);
  assert.equal(auto.dispatch.text,"数量规则继续补队");
  await env.send("HELLO",{lastUserText:"原队列下一项",userCount:2},11,next);
  const duplicateCompletion=await env.send("FINISHED",{id:pendingId,...voiceProof},11,next);
  assert.equal(duplicateCompletion.state.tasks.length,1);
  assert.equal(duplicateCompletion.state.activeTaskId,generated.id);
  assert.equal(duplicateCompletion.state.schedules.find(rule=>rule.id===countId).runCount,1,
    "重复完成通知不二次迁移，也不重复补队");
  assert.equal((await env.send("CLAIM",{ready:true},11,next)).dispatch,null);
});

test("接力新聊天：发送后发生整页导航，未回报 SENT 也可由真实首条消息安全认领",async()=>{
  const env=await harness();
  const project="g-p-create-first-chat";
  const origin=`https://chatgpt.com/g/${project}/c/source`;
  const landing=`https://chatgpt.com/g/${project}/project`;
  const next=`https://chatgpt.com/g/${project}/c/created`;
  env.navigate(11,origin);
  await env.send("HANDOFF_NOW",{},11,origin);
  const claim=await env.send("CLAIM",{ready:true,userCount:1},11,origin);
  await env.send("SENT",{id:claim.dispatch.id},11,origin);
  env.advance(3);
  const saved=await env.send("FINISHED",{
    id:claim.dispatch.id,...handoffProof,
    handoffSummary:"完整交接文档：工作目标与步骤记录。".repeat(30),
    userCount:2,
  },11,origin);
  assert.equal(saved.state.handoff.phase,"opening");
  await env.send("HANDOFF_NAVIGATE",{userCount:2},11,origin);
  env.navigate(11,landing);
  await env.send("HELLO",{},11,landing);
  const intro=await env.send("CLAIM",{ready:true,userCount:0},11,landing);
  assert.equal(intro.state.tasks[0].status,"dispatching");
  // ChatGPT accepted the native first message but reloaded the page before
  // the old content script could send its SENT acknowledgement.
  env.navigate(11,next);
  const arrived=await env.send("HELLO",{
    lastUserText:intro.dispatch.text,
  },11,next);
  assert.equal(arrived.sessionKey,"chat:created");
  assert.equal(arrived.state.tasks[0].kind,"handoff_intro");
  assert.equal(arrived.state.tasks[0].status,"waiting");
  assert.equal(arrived.state.activeTaskId,intro.dispatch.id);
  const late=await env.send("SENT",{id:intro.dispatch.id},11,next);
  assert.equal(late.ok,true,"延迟到达的 SENT 不得把已确认任务标为失败");
  assert.equal(late.state.tasks[0].status,"waiting");
  env.advance(3);
  const finished=await env.send("FINISHED",{
    id:intro.dispatch.id,...voiceProof,
  },11,next);
  assert.equal(finished.ok,true);
  assert.equal(finished.state.handoff.phase,"idle");
  assert.equal(env.stored["cq.state.v2"].conversations["chat:source"].handoff.phase,
    "completed");
});

test("接力调试：自动记录阶段、等待原因和 RPC 异常，刷新后台后仍能读取且不泄露正文",async()=>{
  const env=await harness({}, {structuredStorage:true});
  const project="g-p-debug-test";
  const source=`https://chatgpt.com/g/${project}/c/source`;
  env.navigate(11,source);
  await env.send("HANDOFF_NOW",{},11,source);
  const key="cq.handoffDebug.v1";
  let trace=env.stored[key];
  assert.equal(trace.version,2);
  assert.equal(trace.runs.length,1);
  assert.equal(trace.runs[0].mode,"manual");
  assert.equal(trace.runs[0].events[0].phase,"queued");
  assert.equal(trace.runs[0].events[0].pendingTasks,0);

  const observed=await env.send("HANDOFF_DEBUG_SIGNAL",{
    event:"page_wait",reason:"voice_not_ready",
  },11,source);
  assert.equal(observed.ok,true);
  assert.equal(observed.recorded,true);
  assert.equal((await env.send("HANDOFF_DEBUG_SIGNAL",{
    event:"page_wait",reason:"voice_not_ready",
  },11,source)).recorded,false,"等待状态反复轮询不得刷屏");
  assert.equal((await env.send("HANDOFF_DEBUG_SIGNAL",{
    event:"page_wait",reason:"private prompt content",
  },11,source)).ok,false,"不能记录任意字符串");
  assert.equal((await env.send("HANDOFF_NAVIGATE",{},11,source)).ok,false);
  trace=env.stored[key];
  assert.ok(trace.runs[0].events.some(entry=>entry.kind==="rpc_error" &&
    entry.action==="HANDOFF_NAVIGATE"));

  const summaryTask=await env.send("CLAIM",{ready:true,userCount:1},11,source);
  assert.equal(summaryTask.state.handoff.phase,"summarizing");
  assert.ok(env.stored[key].runs[0].events.some(entry=>entry.phase==="summarizing" &&
    entry.summaryStatus==="dispatching"));
  await env.send("SENT",{id:summaryTask.dispatch.id},11,source);
  const secret="不要写入调试日志的原始内容 123456_private";
  env.advance(3);
  const complete=await env.send("FINISHED",{
    id:summaryTask.dispatch.id,...handoffProof,
    handoffSummary:(secret+"。继续原计划、保留任务。").repeat(10),
    userCount:2,
  },11,source);
  assert.equal(complete.state.handoff.phase,"opening");
  const report=await env.send("GET_HANDOFF_DEBUG",{},11,source);
  assert.equal(report.ok,true);
  assert.equal(report.version,2);
  assert.equal(report.backendVersion,"0.19.0");
  assert.equal(report.runs[0].createdBackendVersion,"0.19.0");
  assert.equal(report.runs[0].lastBackendVersion,"0.19.0");
  assert.equal(report.runs[0].events.every(event=>event.backendVersion==="0.19.0"),true);
  assert.equal(report.current.claimDiagnostic.stateFound,true);
  assert.equal(report.runs[0].current.claimDiagnostic.stateFound,true);
  assert.equal(report.runs[0].phase,"opening");
  assert.ok(report.runs[0].events.some(event=>event.summaryChars>150));
  assert.ok(report.runs[0].events.some(event=>event.kind==="page_wait"));
  const exposed=JSON.stringify(report);
  assert.equal(exposed.includes(secret),false);
  assert.equal(exposed.includes("sourceKey"),false);
  assert.equal(exposed.includes(source),false);
  assert.equal(exposed.includes("token"),false);
  assert.equal((await env.send("GET_HANDOFF_DEBUG",{},12,B)).runs.length,0,
    "不能读取其他对话的日志");

  const restarted=await harness(structuredClone(env.stored));
  const restored=await restarted.send("GET_HANDOFF_DEBUG",{},11,source);
  assert.equal(restored.runs[0].events.length,report.runs[0].events.length);
  assert.equal(restored.runs[0].startedAt,report.runs[0].startedAt);
});

test("接力调试：日志上限与失败原因归类，取消后新一轮独立记录",async()=>{
  const env=await harness();
  const source="https://chatgpt.com/g/g-p-debug-limits/c/source";
  env.navigate(11,source);
  await env.send("HANDOFF_NOW",{},11,source);
  const reasons=["voice_not_ready","assistant_not_new"];
  for(let i=0;i<105;i++){
    env.advance(31);
    assert.equal((await env.send("HANDOFF_DEBUG_SIGNAL",{
      event:"page_wait",reason:reasons[i%2],
    },11,source)).ok,true);
  }
  const stored=env.stored["cq.handoffDebug.v1"];
  assert.equal(stored.runs[0].events.length,80);
  assert.equal(stored.runs[0].events[0].phase,"queued","保留开场状态，不被等待轮询冲走");
  await env.send("CANCEL_HANDOFF",{},11,source);
  assert.equal(env.stored["cq.handoffDebug.v1"].runs[0].status,"cancelled");
  await env.send("HANDOFF_NOW",{},11,source);
  const runs=env.stored["cq.handoffDebug.v1"].runs;
  assert.equal(runs.length,2);
  assert.equal(runs[0].status,"running");
  assert.equal(runs[1].status,"cancelled");
  assert.notEqual(runs[0].id,runs[1].id);
  for(let i=0;i<14;i++){
    await env.send("CANCEL_HANDOFF",{},11,source);
    await env.send("HANDOFF_NOW",{},11,source);
  }
  assert.equal(env.stored["cq.handoffDebug.v1"].runs.length,12,
    "超出保留上限后自动裁剪旧轮次，不无限增长");
});

test("接力调试：日志存储失败仍可启动接力，不能影响任务与后台状态",async()=>{
  const env=await harness({}, {failHandoffDebugWrite:true});
  const source="https://chatgpt.com/g/g-p-debug-storage/c/source";
  env.navigate(11,source);
  const handoff=await env.send("HANDOFF_NOW",{},11,source);
  await env.send("ENQUEUE",{text:"必要任务，调试写入失败也必须保留"},11,source);
  assert.equal(handoff.ok,true);
  assert.equal(handoff.state.handoff.phase,"queued");
  assert.equal(env.stored["cq.handoffDebug.v1"],undefined);
  const claimed=await env.send("CLAIM",{ready:true},11,source);
  assert.equal(claimed.ok,true);
  assert.equal(claimed.state.tasks.length,2);
  assert.equal(claimed.state.tasks[1].text,"必要任务，调试写入失败也必须保留");
  assert.equal(claimed.claimDiagnostic.outcome,"acquired");
  const report=await env.send("GET_HANDOFF_DEBUG",{},11,source);
  assert.equal(report.ok,true);
  assert.equal(report.current.sourceFound,true,"没有新日志也可导出当前后台快照");
  assert.equal(report.current.sourceActiveStatus,"dispatching");
});

test("接力调试 v2：详情仅允许元信息，交替等待去重但关键发送节点保留",async()=>{
  const env=await harness();
  const url="https://chatgpt.com/g/g-p-debug-details/c/debug-details";
  env.navigate(11,url);
  await env.send("HANDOFF_NOW",{},11,url);
  const details={contentVersion:"0.49.41",gate:"prepare",taskKind:"handoff_summary",
    taskStatus:"pending",scopeCurrent:true,editorChars:800,taskChars:800,textMatches:true};
  assert.equal((await env.send("HANDOFF_DEBUG_SIGNAL",{
    event:"send_wait",reason:"send_not_ready",details,
  },11,url)).recorded,true);
  await env.send("HANDOFF_DEBUG_SIGNAL",{event:"page_wait",reason:"voice_not_ready"},11,url);
  assert.equal((await env.send("HANDOFF_DEBUG_SIGNAL",{
    event:"send_wait",reason:"send_not_ready",details:{...details},
  },11,url)).recorded,false,"不只和最后一条比较，交替等待也不刷屏");
  for(let index=0;index<2;index++)assert.equal((await env.send("HANDOFF_DEBUG_SIGNAL",{
    event:"native_send_click",reason:"none",details:{gate:"final_send",clicked:true},
  },11,url)).recorded,true,"两次关键点击不能被等待去重吞掉");
  for(const invalid of [{text:"private正文"},{url:"https://private.example"},{token:"secret"},
    {rawError:"private stack"},{html:"<main>secret</main>"},{contentVersion:"private-prompt"},
    {gate:"private-prompt"},{editorChars:Infinity},{editorChars:-1},{editorChars:1e12},
    {scopeCurrent:"true"},{taskStatus:"private-prompt"}]){
    assert.equal((await env.send("HANDOFF_DEBUG_SIGNAL",{
      event:"send_prepare",reason:"prepared_document",details:invalid,
    },11,url)).ok,false);
  }
  const acquired=await env.send("CLAIM",{ready:true},11,url);
  assert.equal(acquired.claimDiagnostic.outcome,"acquired");
  await env.send("CLAIM",{ready:true},11,url);
  const report=await env.send("GET_HANDOFF_DEBUG",{},11,url);
  assert.ok(report.runs[0].events.some(event=>event.kind==="claim_result"&&event.reason==="claim_acquired"));
  assert.ok(report.runs[0].events.some(event=>event.kind==="claim_result"&&
    event.details?.dispatchBlockedReason==="active_task"));
  assert.equal(JSON.stringify(report).includes("private"),false);
});

test("接力调试 v2：项目页与管理页可独立导出，网页不能请求全量日志",async()=>{
  const env=await harness();
  const {projectUrl}=await preparePendingHandoffEntry(env);
  env.navigate(11,projectUrl);
  await env.send("HELLO",{},11,projectUrl);
  const project=await env.send("GET_HANDOFF_DEBUG",{},11,projectUrl);
  assert.equal(project.ok,true);
  assert.equal(project.current.pageType,"project");
  assert.equal(project.current.claimDiagnostic.nextKind,"handoff_intro");
  assert.equal(project.runs.length,1);
  assert.equal((await env.send("GET_HANDOFF_DEBUG",{all:true},11,projectUrl)).ok,false);
  assert.equal((await env.send("GET_HANDOFF_DEBUG",{},12,projectUrl)).runs.length,0,
    "同项目其他标签不能读取该接力轮次");
  const manager={id:"test-queue",url:"chrome-extension://test-queue/dashboard.html"};
  const all=await env.sendDashboard("GET_HANDOFF_DEBUG",{all:true},manager);
  assert.equal(all.ok,true);
  assert.equal(all.current.pageType,"manager");
  assert.equal(all.runs[0].current.claimDiagnostic.nextKind,"handoff_intro");
  assert.equal(all.runs[0].current.ownerPageType,"project");
  const exported=JSON.stringify(all);
  assert.equal(exported.includes("sourceKey"),false);
  assert.equal(exported.includes("handoffToken"),false);
  assert.equal(exported.includes(projectUrl),false);
  assert.equal((await env.sendDashboard("GET_HANDOFF_DEBUG",{all:true},
    {...manager,id:"other-extension"})).ok,false);
  const empty=await env.send("GET_HANDOFF_DEBUG",{},12,B);
  assert.equal(empty.ok,true);
  assert.equal(empty.current.sourceFound,false);
  assert.equal(empty.runs.length,0);
});

test("接力调试 v2：兼容旧 v1，过滤旧额外载荷，并正确归类项目入口确认失败",async()=>{
  const url="https://chatgpt.com/g/g-p-debug-legacy/c/legacy-debug";
  const env=await harness({"cq.handoffDebug.v1":{version:1,runs:[{
    id:"private-id",sourceKey:"chat:legacy-debug",mode:"manual",status:"failed",phase:"failed",
    startedAt:Date.UTC(2026,9,15),rawError:"private-legacy-prompt",events:[{
      at:Date.UTC(2026,9,15),kind:"state",phase:"failed",reason:"chat_not_confirmed",
      text:"private-legacy-prompt",details:{token:"private-token"},
    }],
  }]}});
  env.navigate(11,url);
  const legacy=await env.send("GET_HANDOFF_DEBUG",{},11,url);
  assert.equal(legacy.version,2);
  assert.equal(legacy.runs.length,1);
  assert.equal(legacy.runs[0].createdBackendVersion,"unknown");
  assert.equal(JSON.stringify(legacy).includes("private"),false);
  await env.send("HANDOFF_NOW",{},11,url);
  const source=env.stored["cq.state.v2"].conversations["chat:legacy-debug"];
  source.handoff.phase="failed";
  source.handoff.error="无法确认已进入项目新对话。旧队列保留。";
  const report=await env.send("GET_HANDOFF_DEBUG",{},11,url);
  assert.equal(report.current.reason,"chat_not_confirmed");
});

test("接力调试：空总结失败后确认取消仍属于同一轮，下一次启动才创建新日志",async()=>{
  const env=await harness();
  const source="https://chatgpt.com/g/g-p-debug-ack/c/source";
  env.navigate(11,source);
  await env.send("HANDOFF_NOW",{},11,source);
  const claim=await env.send("CLAIM",{ready:true,userCount:1},11,source);
  await env.send("SENT",{id:claim.dispatch.id},11,source);
  env.advance(3);
  const rejected=await env.send("FINISHED",{
    id:claim.dispatch.id,...handoffProof,
    handoffSummary:" \n\t ",
    userCount:2,
  },11,source);
  assert.equal(rejected.state.handoff.phase,"failed");
  let runs=env.stored["cq.handoffDebug.v1"].runs;
  assert.equal(runs.length,1);
  assert.equal(runs[0].status,"failed");
  assert.equal(runs[0].events.at(-1).reason,"summary_empty");
  const failedRunId=runs[0].id;
  const cancelled=await env.send("CANCEL_HANDOFF",{},11,source);
  assert.equal(cancelled.ok,true);
  runs=env.stored["cq.handoffDebug.v1"].runs;
  assert.equal(runs.length,1);
  assert.equal(runs[0].id,failedRunId);
  assert.equal(runs[0].status,"failed");
  assert.ok(runs[0].events.some(event=>event.phase==="idle"));
  await env.send("HANDOFF_NOW",{},11,source);
  runs=env.stored["cq.handoffDebug.v1"].runs;
  assert.equal(runs.length,2);
  assert.equal(runs[1].id,failedRunId);
  assert.equal(runs[0].status,"running");
});

test("上下文接力：带项目名称的聊天地址应进入官方规范项目入口，旧版中途接力也能继续", async () => {
  const env = await harness();
  const project = "g-p-6ad25b09f7988191b8c35b36d03e3d70";
  const sourceUrl = `https://chatgpt.com/g/${project}-homepc/c/old-alias`;
  const canonicalStart = `https://chatgpt.com/g/${project}/project`;
  const nextUrl = `https://chatgpt.com/g/${project}/c/new-alias`;
  env.navigate(11, sourceUrl);
  await env.send("HANDOFF_NOW", {}, 11, sourceUrl);
  await env.send("ENQUEUE", {text:"迁移后执行的图文任务", images:[testImage]}, 11, sourceUrl);
  const claim = await env.send("CLAIM", {ready:true,userCount:2}, 11, sourceUrl);
  assert.equal(claim.state.tasks[0].kind,"handoff_summary");
  await env.send("SENT", {id:claim.dispatch.id}, 11, sourceUrl);
  env.advance(3);
  const finished = await env.send("FINISHED", {
    id:claim.dispatch.id,...handoffProof,
    handoffSummary:handoffReply(claim.dispatch.text,"该对话在 HomePC 原生项目内继续开发。".repeat(20)),
  }, 11, sourceUrl);
  assert.equal(finished.state.handoff.phase,"opening");
  assert.equal(finished.state.handoff.projectId,project);
  assert.equal(finished.state.handoff.projectUrl,canonicalStart);

  // Simulate an already-staged v0.49.4 handoff across an extension upgrade.
  const oldHandoff = env.stored["cq.state.v2"].conversations["chat:old-alias"].handoff;
  oldHandoff.projectId = `${project}-homepc`;
  oldHandoff.projectUrl = `https://chatgpt.com/g/${project}-homepc/project`;
  const navigate = await env.send("HANDOFF_NAVIGATE", {}, 11, sourceUrl);
  assert.equal(navigate.ok,true);
  assert.equal(navigate.state.handoff.phase,"navigating");
  assert.equal(navigate.state.handoff.projectId,project);
  assert.equal(navigate.state.handoff.projectUrl,canonicalStart);

  env.navigate(11, canonicalStart);
  const mounted = await env.send("HELLO",{},11,canonicalStart);
  assert.equal(mounted.state.tasks[0].kind,"handoff_intro");
  const intro = await env.send("CLAIM",{ready:true,userCount:0},11,canonicalStart);
  assert.equal(intro.state.tasks[0].kind,"handoff_intro");
  await env.send("SENT",{id:intro.dispatch.id},11,canonicalStart);
  env.navigate(11,nextUrl);
  const adopted = await env.send("HELLO",{lastUserText:intro.dispatch.text},11,nextUrl);
  assert.equal(adopted.sessionKey,"chat:new-alias");
  env.advance(3);
  const transferred = await env.send("FINISHED",{
    id:intro.dispatch.id,...voiceProof,
  },11,nextUrl);
  assert.equal(transferred.ok,true);
  assert.equal(transferred.state.tasks.length,1);
  assert.equal(transferred.state.tasks[0].text,"迁移后执行的图文任务");
  assert.equal(transferred.state.tasks[0].images.length,1);
  const source = env.stored["cq.state.v2"].conversations["chat:old-alias"];
  assert.equal(source.handoff.phase,"completed");
  assert.equal(source.tasks.length,0);
});

test("手动交接：加入队列末尾、等待前序任务，重复点击不重复入队", async () => {
  const env = await harness();
  const projectUrl = "https://chatgpt.com/g/g-p-on-demand/c/source";
  env.navigate(11, projectUrl);
  await env.send("ENQUEUE", {text:"本轮正在处理"}, 11, projectUrl);
  await env.send("ENQUEUE", {text:"留待下一个项目聊天的任务"}, 11, projectUrl);
  const first = await env.send("CLAIM", {ready:true,userCount:0}, 11, projectUrl);
  assert.equal(first.dispatch.text,"本轮正在处理");
  await env.send("SENT", {id:first.dispatch.id}, 11, projectUrl);

  const manual = await env.send("HANDOFF_NOW", {}, 11, projectUrl);
  assert.equal(manual.ok,true);
  assert.equal(manual.state.handoff.enabled,false,"不要求打开定时开关");
  assert.equal(manual.state.handoff.phase,"queued");
  assert.equal(manual.state.tasks.at(-1).kind,"handoff_summary");
  assert.equal(manual.state.activeTaskId,first.dispatch.id,"正在运行的任务不被打断");
  const duplicate = await env.send("HANDOFF_NOW", {}, 11, projectUrl);
  assert.equal(duplicate.ok,true);
  assert.equal(duplicate.state.history.filter((event)=>event.type==="handoff_manual").length,1);
  assert.equal((await env.send("CLAIM",{ready:true},11,projectUrl)).dispatch,null);

  env.advance(3);
  await env.send("FINISHED",{id:first.dispatch.id,...voiceProof},11,projectUrl);
  const preceding=await env.send("CLAIM",{ready:true},11,projectUrl);
  assert.equal(preceding.dispatch.text,"留待下一个项目聊天的任务","交接命令不能越过原有任务");
  await env.send("SENT",{id:preceding.dispatch.id},11,projectUrl);
  env.advance(3);
  await env.send("FINISHED",{id:preceding.dispatch.id,...voiceProof},11,projectUrl);
  const summary=await env.send("CLAIM",{ready:true},11,projectUrl);
  assert.equal(summary.ok,true);
  assert.doesNotMatch(summary.dispatch.text,/CHATGPT_TASKQUEUE_HANDOFF_(START|END)/);
  assert.equal(summary.state.tasks.filter((item)=>item.kind==="handoff_summary").length,1);
  assert.equal(summary.state.tasks.length,1);
  assert.equal(summary.dispatch.kind,"handoff_summary");
  assert.equal((await env.send("HANDOFF_NOW",{},11,projectUrl)).ok,false,
    "生成总结期间不能重复立即接力");
});

test("对话时长：首次可靠观察持久化、能读取首条消息时间时更新、跨对话隔离", async () => {
  const env=await harness();
  const empty=await env.send("HELLO",{},11,A);
  assert.equal(empty.state.firstSeenAt,null);
  assert.equal(Object.hasOwn(env.stored["cq.state.v2"].conversations,"chat:dialogue-a"),false,
    "只打开空对话不应该创建持久记录");

  const first=await env.send("HELLO",{userCount:1},11,A);
  const firstSeenAt=first.state.firstSeenAt;
  assert.ok(firstSeenAt > Date.UTC(2022,0,1));
  env.advance(7250);
  assert.equal((await env.send("HELLO",{userCount:2},11,A)).state.firstSeenAt,
    firstSeenAt,"同对话刷新不能重置计时");
  const historical=firstSeenAt - 8 * 60 * 60_000;
  const recorded=await env.send("OBSERVE_FIRST_MESSAGE_AT",{firstMessageAt:historical},11,A);
  assert.equal(recorded.ok,true);
  assert.equal(recorded.state.firstMessageAt,historical);
  assert.equal((await env.send("OBSERVE_FIRST_MESSAGE_AT",{
    firstMessageAt:firstSeenAt - 60_000,
  },11,A)).state.firstMessageAt,historical,"新一点的消息时间不能覆盖首条记录");
  const invalid=await env.send("OBSERVE_FIRST_MESSAGE_AT",{firstMessageAt:0},11,A);
  assert.equal(invalid.ok,false);
  assert.match(invalid.error,/消息时间无效/);
  const forged=await env.send("OBSERVE_FIRST_MESSAGE_AT",{
    firstMessageAt:historical,
  },12,A);
  assert.equal(forged.ok,false,"不能串对话更改时间");
  assert.equal((await env.send("HELLO",{userCount:1},12,B)).state.firstMessageAt,null);
  assert.equal((await env.send("GET",{},11,A)).state.firstMessageAt,historical,
    "真实首条消息时间需要跨页面重载保留");

  await env.send("ENQUEUE",{text:"旧历史记录"},12,B);
  const oldTime=env.stored["cq.state.v2"].conversations["chat:dialogue-b"].firstSeenAt;
  assert.ok(oldTime > firstSeenAt);
});

test("对话时长：旧会话可用最早的插件日志恢复已记录时间", async () => {
  const env=await harness();
  await env.send("ENQUEUE",{text:"两小时前的操作"},11,A);
  const old=env.stored["cq.state.v2"].conversations["chat:dialogue-a"];
  const recordedAt=old.history[0].at;
  assert.equal(old.firstSeenAt,null);
  env.advance(7200);
  const restored=await env.send("HELLO",{userCount:1},11,A);
  assert.equal(restored.state.firstSeenAt,recordedAt);
  assert.equal(restored.state.firstMessageAt,null,
    "只能确认插件使用记录，不能冒充 ChatGPT 原始创建时间");
});

test("接力主题使用实际任务，过滤流程性原标题并兼容旧总结", () => {
  const sandbox = {};
  vm.runInNewContext(handoffSource, sandbox);
  const handoff = sandbox.CQHandoff;
  assert.equal(handoff.topicTitle("🔴 回复TapTap帖子 - ChatGPT"), "回复TapTap帖子");
  for (const title of ["确认交接理解", "确认优化交接", "确认交接上下文", "ChatGPT", "新聊天"]) {
    assert.equal(handoff.topicTitle(title), null, title);
  }
  assert.equal(handoff.summaryTopic("任务主题：回复 TapTap 帖子\n\n当前进度……"), "回复 TapTap 帖子");
  assert.equal(handoff.summaryTopic("**任务主题：回复 TapTap 帖子**\n\n当前进度……"), "回复 TapTap 帖子");
  const summary = "任务主题：回复 TapTap 帖子\n\n当前进度：等待下一条任务。";
  assert.ok(handoff.introduction(summary, "确认交接理解").startsWith("任务主题：回复 TapTap 帖子\n"));
  const legacy = "当前正在优化游戏性能，保留此前的决定和待办。";
  assert.ok(handoff.introduction(legacy).startsWith(legacy), "旧总结也从实际工作内容开始");
  assert.match(handoff.introduction(legacy), /不要自行启动或重复执行任何待办/);
});

test("手动接力：零队列也会生成总结、同项目开启新对话并继承设置", async () => {
  const env=await harness();
  const project="g-p-empty-manual";
  const sourceUrl=`https://chatgpt.com/g/${project}/c/empty-source`;
  const projectUrl=`https://chatgpt.com/g/${project}/project`;
  const targetUrl=`https://chatgpt.com/g/${project}/c/context-continued`;
  env.navigate(11,sourceUrl);
  const start=await env.send("HANDOFF_NOW",{},11,sourceUrl,{title:"🔴 回复TapTap帖子 - ChatGPT"});
  assert.equal(start.ok,true);
  assert.equal(start.state.handoff.topicTitle,"回复TapTap帖子");
  assert.equal(start.state.tasks.length,1,"空队列也会持久保存交接命令");
  assert.equal(start.state.tasks[0].kind,"handoff_summary");
  assert.equal(start.state.handoff.phase,"queued");
  assert.equal(start.state.handoff.manualRequested,true);
  assert.equal(start.state.handoff.enabled,false,"不自动开启定时接力");
  assert.equal((await env.send("HANDOFF_NOW",{},11,sourceUrl)).state.handoff.phase,"queued");
  assert.equal(start.state.history.filter((entry)=>entry.type==="handoff_manual").length,1,
    "多次触发只记一次手动接力");
  const tick=await env.send("SCHEDULE_PULSE",{},11,sourceUrl);
  assert.equal(tick.state.handoff.phase,"queued","后台轮询不能取消空队列手动接力");

  const summary=await env.send("CLAIM",{ready:true,userCount:4},11,sourceUrl);
  assert.equal(summary.ok,true);
  assert.equal(summary.dispatch?.id,summary.state.activeTaskId);
  assert.equal(summary.dispatch.kind,"handoff_summary",
    "发送执行器必须收到任务类型，才能使用接力专用原生就绪信号");
  assert.doesNotMatch(summary.dispatch.text,/CHATGPT_TASKQUEUE_HANDOFF_(START|END)/);
  assert.match(summary.dispatch.text,/回复TapTap帖子/);
  assert.equal(summary.state.tasks.length,1,"只有临时总结任务");
  assert.equal(summary.state.tasks[0].kind,"handoff_summary");
  await env.send("SENT",{id:summary.dispatch.id},11,sourceUrl);
  assert.equal((await env.send("DISMISS_WAITING",{
    id:summary.dispatch.id,userRequested:true,nativeBusy:false,
  },11,sourceUrl)).ok,false,"不能通过移除等待跳过接力总结");
  env.advance(3);
  const context=handoffReply(summary.dispatch.text,
    "已完成了此前的开发讨论，没有待发送队列；继续保留目标、技术决策和未解决的问题，等待用户指令。".repeat(12));
  const finished=await env.send("FINISHED",{
    id:summary.dispatch.id,...handoffProof,
    handoffLastUserText:summary.dispatch.text,handoffSummary:context,userCount:5,
  },11,sourceUrl);
  assert.equal(finished.ok,true);
  assert.equal(finished.state.handoff.phase,"opening");
  assert.equal(finished.state.tasks.length,0,"总结完成也要继续跳转");
  assert.equal((await env.send("HANDOFF_NAVIGATE",{userCount:5},11,sourceUrl)).ok,true);

  env.navigate(11,projectUrl);
  const started=await env.send("HELLO",{},11,projectUrl);
  assert.equal(started.state.tasks[0].kind,"handoff_intro");
  const stopped=await env.send("STOPPED",{userCount:0},11,projectUrl);
  assert.equal(stopped.ok,true,"项目接力入口也必须记录用户明确停止");
  assert.equal(stopped.state.haltReason,"user");
  const notRecovered=await env.send("RECOVER_ON_VOICE",voiceProof,11,projectUrl);
  assert.equal(notRecovered.ok,true);
  assert.equal(notRecovered.state.halted,true,"原生就绪不能覆盖用户停止");
  const resumed=await env.send("USER_RESUMED",{viaNativeContinue:true},11,projectUrl);
  assert.equal(resumed.ok,true);
  assert.equal(resumed.state.halted,false);
  const intro=await env.send("CLAIM",{ready:true},11,projectUrl);
  assert.equal(intro.dispatch.kind,"handoff_intro");
  assert.ok(intro.dispatch.text.startsWith("任务主题：回复TapTap帖子\n\n"));
  assert.match(intro.dispatch.text,/如果队列为空，请等待用户/);
  await env.send("SENT",{id:intro.dispatch.id},11,projectUrl);
  assert.equal((await env.send("DISMISS_WAITING",{
    id:intro.dispatch.id,userRequested:true,nativeBusy:false,
  },11,projectUrl)).ok,false,"不能通过移除等待触发接力迁移");
  env.navigate(11,targetUrl);
  await env.send("HELLO",{lastUserText:intro.dispatch.text},11,targetUrl);
  env.advance(3);
  const transferred=await env.send("FINISHED",{id:intro.dispatch.id,...voiceProof},11,targetUrl);
  assert.equal(transferred.ok,true);
  assert.equal(transferred.state.tasks.length,0);
  assert.equal(transferred.state.schedules.length,0);
  assert.equal(transferred.state.handoff.enabled,false);
  assert.equal(transferred.state.handoff.phase,"idle");
  assert.equal(transferred.state.handoff.topicTitle,"回复TapTap帖子");
  assert.equal(env.stored["cq.state.v2"].conversations["chat:empty-source"].handoff.phase,"completed");
  assert.equal((await env.send("CLAIM",{ready:true},11,targetUrl)).dispatch,null,
    "进入新对话后不会重复发送总结");
  const next=await env.send("HANDOFF_NOW",{},11,targetUrl,{title:"确认交接理解 - ChatGPT"});
  assert.equal(next.state.handoff.topicTitle,"回复TapTap帖子","重复接力保留业务主题");
  const nextSummary=await env.send("CLAIM",{ready:true},11,targetUrl,{title:"确认交接理解 - ChatGPT"});
  assert.match(nextSummary.dispatch.text,/回复TapTap帖子/);
});

test("手动接力：队列最后一条完成后仍能接力，且手动总结不受自动冷却限制", async () => {
  const env=await harness();
  const url="https://chatgpt.com/g/g-p-drained-manual/c/source";
  env.navigate(11,url);
  await env.send("ENQUEUE",{text:"这条任务先完成"},11,url);
  const active=await env.send("CLAIM",{ready:true},11,url);
  await env.send("SENT",{id:active.dispatch.id},11,url);
  await env.send("HANDOFF_NOW",{},11,url);
  env.advance(3);
  const done=await env.send("FINISHED",{id:active.dispatch.id,...voiceProof},11,url);
  assert.equal(done.state.tasks.length,1);
  assert.equal(done.state.handoff.phase,"queued");
  await env.send("SAVE_SEND_COOLDOWN",{seconds:600},11,url);
  assert.equal((await env.send("SCHEDULE_PULSE",{},11,url)).state.handoff.phase,"queued");
  const summary=await env.send("CLAIM",{ready:true},11,url);
  assert.equal(summary.ok,true);
  assert.equal(summary.state.handoff.phase,"summarizing");
  assert.equal(summary.state.tasks[0].kind,"handoff_summary",
    "手动总结不等待自动任务的十分钟冷却");
});

test("手动接力：已开启定时但没有队列任务时，定时巡检不会取消手动请求", async () => {
  const env=await harness();
  const url="https://chatgpt.com/g/g-p-manual-timer/c/empty";
  env.navigate(11,url);
  await env.send("SET_HANDOFF",{enabled:true,intervalMinutes:60},11,url);
  const started=await env.send("HANDOFF_NOW",{},11,url);
  assert.equal(started.ok,true);
  assert.equal(started.state.handoff.manualRequested,true);
  env.advance(3601);
  const pulse=await env.send("SCHEDULE_PULSE",{},11,url);
  assert.equal(pulse.state.handoff.phase,"queued","定时器不能把手动接力重置成空闲");
  const summary=await env.send("CLAIM",{ready:true},11,url);
  assert.equal(summary.state.handoff.phase,"summarizing");
  assert.equal(summary.state.tasks[0].kind,"handoff_summary");
});

test("手动接力：空队列总结不合法时保留当前对话，取消后可重试", async () => {
  const env=await harness();
  const url="https://chatgpt.com/g/g-p-empty-failure/c/source";
  env.navigate(11,url);
  await env.send("HANDOFF_NOW",{},11,url);
  const summary=await env.send("CLAIM",{ready:true},11,url);
  await env.send("SENT",{id:summary.dispatch.id},11,url);
  env.advance(3);
  const failed=await env.send("FINISHED",{
    id:summary.dispatch.id,...handoffProof,
    handoffLastUserText:summary.dispatch.text,handoffSummary:"   ",
  },11,url);
  assert.equal(failed.state.handoff.phase,"failed");
  assert.equal(failed.state.tasks[0].status,"error");
  assert.equal((await env.send("CLAIM",{ready:true},11,url)).dispatch,null);
  assert.equal((await env.send("CANCEL_HANDOFF",{},11,url)).ok,true);
  const retried=await env.send("HANDOFF_NOW",{},11,url);
  assert.equal(retried.ok,true);
  assert.equal(retried.state.tasks.length,1);
  assert.equal(retried.state.handoff.phase,"queued");
});

test("交接命令：未建立聊天拒绝入队，暂停允许入队但阻止执行，取消不丢普通任务", async () => {
  const env=await harness();
  const projectUrl="https://chatgpt.com/g/g-p-on-demand/c/source-safe";
  env.navigate(11,"https://chatgpt.com/");
  assert.equal((await env.send("HANDOFF_NOW",{},11,"https://chatgpt.com/")).ok,false,
    "首页尚未建立聊天，不应创建交接命令");
  env.navigate(11,projectUrl);
  assert.equal((await env.send("HANDOFF_NOW",{},11,projectUrl)).ok,true,
    "项目中的空队列可以手动接力");
  assert.equal((await env.send("CANCEL_HANDOFF",{},11,projectUrl)).ok,true);
  await env.send("ENQUEUE",{text:"重要的任务"},11,projectUrl);
  await env.send("SET_QUEUE_PAUSED",{paused:true},11,projectUrl);
  const paused=await env.send("HANDOFF_NOW",{},11,projectUrl);
  assert.equal(paused.ok,true,"队列暂停仍允许添加命令");
  assert.equal(paused.state.handoff.phase,"queued");
  assert.equal((await env.send("CLAIM",{ready:true},11,projectUrl)).dispatch,null,
    "入队不能绕过用户暂停");
  await env.send("SET_QUEUE_PAUSED",{paused:false},11,projectUrl);
  const trigger=await env.send("HANDOFF_NOW",{},11,projectUrl);
  assert.equal(trigger.ok,true);
  assert.equal(trigger.state.handoff.phase,"queued");
  assert.equal((await env.send("SET_HANDOFF",{
    enabled:true,intervalMinutes:60,
  },11,projectUrl)).ok,true,"尚未开始的命令允许修改自动设置");
  const cancelled=await env.send("CANCEL_HANDOFF",{},11,projectUrl);
  assert.equal(cancelled.ok,true);
  assert.equal(cancelled.state.tasks.length,1);
  assert.equal(cancelled.state.tasks[0].text,"重要的任务");
});

test("立即接力：默认关闭定时功能时，仍能完成同项目接力并保留关闭状态", async () => {
  const env=await harness();
  const project="g-p-manual-complete";
  const sourceUrl=`https://chatgpt.com/g/${project}/c/old`;
  const newChatUrl=`https://chatgpt.com/g/${project}/project`;
  const destinationUrl=`https://chatgpt.com/g/${project}/c/new`;
  env.navigate(11,sourceUrl);
  await env.send("HANDOFF_NOW",{},11,sourceUrl);
  const source=await env.send("ENQUEUE",{text:"下个对话再继续这项工作"},11,sourceUrl);
  const pendingId=source.state.tasks.at(-1).id;
  const summary=await env.send("CLAIM",{ready:true},11,sourceUrl);
  await env.send("SENT",{id:summary.dispatch.id},11,sourceUrl);
  env.advance(3);
  const text=handoffReply(summary.dispatch.text,
    "当前任务尚未开始，下一轮必须先接收总结，再继续排队工作。".repeat(16));
  assert.equal((await env.send("FINISHED",{
    id:summary.dispatch.id,...handoffProof,
    handoffLastUserText:summary.dispatch.text,handoffSummary:text,
  },11,sourceUrl)).state.handoff.phase,"opening");
  await env.send("HANDOFF_NAVIGATE",{},11,sourceUrl);
  env.navigate(11,newChatUrl);
  await env.send("HELLO",{},11,newChatUrl);
  const intro=await env.send("CLAIM",{ready:true},11,newChatUrl);
  await env.send("SENT",{id:intro.dispatch.id},11,newChatUrl);
  env.navigate(11,destinationUrl);
  await env.send("HELLO",{lastUserText:intro.dispatch.text},11,destinationUrl);
  env.advance(3);
  const result=await env.send("FINISHED",{id:intro.dispatch.id,...voiceProof},11,destinationUrl);
  assert.equal(result.ok,true);
  assert.equal(result.state.tasks[0].id,pendingId);
  assert.equal(result.state.handoff.enabled,false);
  assert.equal(env.stored["cq.state.v2"].conversations["chat:old"].tasks.length,0);
});

test("上下文接力：旧助手长回复不能冒充接力后生成的下一条回复", async () => {
  const env=await harness();
  const sourceUrl="https://chatgpt.com/g/g-p-stale-summary/c/source";
  env.navigate(11,sourceUrl);
  await env.send("HANDOFF_NOW",{},11,sourceUrl);
  await env.send("ENQUEUE",{text:"绝不能误转移的任务"},11,sourceUrl);
  const claim=await env.send("CLAIM",{ready:true},11,sourceUrl);
  await env.send("SENT",{id:claim.dispatch.id},11,sourceUrl);
  env.advance(3);
  const stale="这是另一轮旧回复留下的文本。".repeat(24);
  const premature=await env.send("FINISHED",{
    id:claim.dispatch.id,...voiceProof,
    handoffSummary:stale,handoffLastUserText:claim.dispatch.text,
  },11,sourceUrl);
  assert.equal(premature.ok,false,"旧回复不能仅凭原生结束信号就被当作交接记录");
  const waiting=(await env.send("GET",{},11,sourceUrl)).state;
  assert.equal(waiting.handoff.phase,"summarizing");
  assert.equal(waiting.activeTaskId,claim.dispatch.id);
  assert.equal(waiting.tasks.some((task)=>task.text==="绝不能误转移的任务" &&
    task.status==="pending"),true);
  const genuine=await env.send("FINISHED",{
    id:claim.dispatch.id,...handoffProof,
    handoffSummary:"这是接力请求之后新生成的完整总结。".repeat(24),
  },11,sourceUrl);
  assert.equal(genuine.ok,true);
  assert.equal(genuine.state.handoff.phase,"opening");
});

test("上下文接力：用户消息不能冒充下一条助手回复，原队列保持等待", async () => {
  const env=await harness();
  const url="https://chatgpt.com/g/g-p-nonce-guard/c/source";
  env.navigate(11,url);
  await env.send("HANDOFF_NOW",{},11,url);
  await env.send("ENQUEUE",{text:"必须保留的下一条任务"},11,url);
  const claim=await env.send("CLAIM",{ready:true},11,url);
  await env.send("SENT",{id:claim.dispatch.id},11,url);
  env.advance(3);
  const premature=await env.send("FINISHED",{
    id:claim.dispatch.id,...handoffProof,handoffLastRole:"user",
    handoffSummary:"这是新插入的用户文字而非助手交接回复。".repeat(20),
  },11,url);
  assert.equal(premature.ok,false);
  const waiting=(await env.send("GET",{},11,url)).state;
  assert.equal(waiting.handoff.phase,"summarizing");
  assert.equal(waiting.tasks.some(t=>t.text==="必须保留的下一条任务"),true);
  assert.equal(waiting.tasks.some(t=>t.status==="pending"),true);
  assert.equal((await env.send("CLAIM",{ready:true},11,url)).dispatch,null);
});

test("上下文接力：总结生成后出现新用户消息，拒绝导航且不会丢失原任务", async () => {
  const env=await harness();
  const url="https://chatgpt.com/g/g-p-message-race/c/source";
  env.navigate(11,url);
  await env.send("HANDOFF_NOW",{},11,url);
  await env.send("ENQUEUE",{text:"保留后续队列"},11,url);
  const claim=await env.send("CLAIM",{ready:true,userCount:10},11,url);
  await env.send("SENT",{id:claim.dispatch.id},11,url);
  env.advance(3);
  const done=await env.send("FINISHED",{
    id:claim.dispatch.id,...handoffProof,userCount:11,
    handoffSummary:handoffReply(claim.dispatch.text,"此记录来自本轮真实总结。".repeat(24)),
    handoffLastUserText:"网页没有正确提供最近的用户气泡",
  },11,url);
  assert.equal(done.state.handoff.phase,"opening");
  const rejected=await env.send("HANDOFF_NAVIGATE",{userCount:12},11,url);
  assert.equal(rejected.state.handoff.phase,"failed");
  assert.match(rejected.state.handoff.error,/新的用户消息/);
  assert.equal(rejected.state.tasks[0].text,"保留后续队列");
});

test("上下文接力：总结尚未被接收前插入第二条用户消息时拒绝迁移", async () => {
  const env=await harness();
  const url="https://chatgpt.com/g/g-p-extra-user/c/source";
  env.navigate(11,url);
  await env.send("HANDOFF_NOW",{},11,url);
  await env.send("ENQUEUE",{text:"仍应保留的原始待办"},11,url);
  const claim=await env.send("CLAIM",{ready:true,userCount:5},11,url);
  await env.send("SENT",{id:claim.dispatch.id},11,url);
  env.advance(3);
  const result=await env.send("FINISHED",{
    id:claim.dispatch.id,...handoffProof,userCount:7,
    handoffSummary:"这是收到第二条用户输入之后的回复，而不是原始交接结果。".repeat(20),
  },11,url);
  assert.equal(result.ok,true);
  assert.equal(result.state.handoff.phase,"failed");
  assert.match(result.state.handoff.error,/额外用户消息/);
  assert.equal(result.state.tasks.some((task)=>
    task.text==="仍应保留的原始待办" && task.status==="pending"),true);
});

test("接力失败取消时可要求暂停原队列，防止误入队的重复消息被自动发送", async () => {
  const env=await harness();
  const url="https://chatgpt.com/g/g-p-recovery-pause/c/source";
  env.navigate(11,url);
  await env.send("HANDOFF_NOW",{},11,url);
  await env.send("ENQUEUE",{text:"疑似重复的用户消息"},11,url);
  const claim=await env.send("CLAIM",{ready:true},11,url);
  await env.send("SENT",{id:claim.dispatch.id},11,url);
  env.advance(3);
  const failed=await env.send("FINISHED",{
    id:claim.dispatch.id,...handoffProof,
    handoffSummary:"   ",handoffLastUserText:claim.dispatch.text,
  },11,url);
  assert.equal(failed.state.handoff.phase,"failed");
  const recovered=await env.send("CANCEL_HANDOFF",{reviewed:true,pauseAfter:true},11,url);
  assert.equal(recovered.state.handoff.phase,"idle");
  assert.equal(recovered.state.queuePaused,true);
  assert.equal(recovered.state.tasks.map(t=>t.text).join("|"),"疑似重复的用户消息");
  assert.equal((await env.send("CLAIM",{ready:true},11,url)).dispatch,null);
});

test("上下文接力：空队列到期也入队，未建立对话拒绝，总结缺失时原队列仍保留", async () => {
  const env=await harness();
  const sourceUrl="https://chatgpt.com/g/g-p-safe-project/c/old-safe";
  env.navigate(11,"https://chatgpt.com/");
  const outside=await env.send("SET_HANDOFF",{enabled:true,intervalMinutes:60});
  assert.equal(outside.ok,false);
  assert.match(outside.error,/已建立/);
  env.navigate(11,sourceUrl);
  await env.send("SET_HANDOFF",{enabled:true,intervalMinutes:60},11,sourceUrl);
  env.advance(3601);
  const empty=await env.send("SCHEDULE_PULSE",{},11,sourceUrl);
  assert.equal(empty.state.handoff.phase,"queued");
  await env.send("ENQUEUE",{text:"不能丢失的待办"},11,sourceUrl);
  const due=await env.send("SCHEDULE_PULSE",{},11,sourceUrl);
  assert.equal(due.state.handoff.phase,"queued");
  const claim=await env.send("CLAIM",{ready:true},11,sourceUrl);
  await env.send("SENT",{id:claim.dispatch.id},11,sourceUrl);
  env.advance(3);
  const invalid=await env.send("FINISHED",{
    id:claim.dispatch.id,...handoffProof,handoffSummary:"   ",
    handoffLastUserText:claim.dispatch.text,
  },11,sourceUrl);
  assert.equal(invalid.state.handoff.phase,"failed");
  assert.equal(invalid.state.tasks.some((task)=>task.text==="不能丢失的待办"),true);
  assert.equal((await env.send("CLAIM",{ready:true},11,sourceUrl)).dispatch,null);
  const cancelled=await env.send("CANCEL_HANDOFF",{},11,sourceUrl);
  assert.equal(cancelled.ok,true);
  assert.equal(cancelled.state.handoff.enabled,true,
    "取消本次交接不应悄悄修改用户原来的定时设置");
  assert.equal((await env.send("CLAIM",{ready:true},11,sourceUrl)).dispatch.text,
    "不能丢失的待办");
});

test("上下文接力：项目 ID 不一致时拒绝挂载交接并保留旧队列", async () => {
  const env=await harness();
  const sourceUrl="https://chatgpt.com/g/g-p-correct-project/c/source";
  const wrongUrl="https://chatgpt.com/g/g-p-other-project/project";
  env.navigate(11,sourceUrl);
  await env.send("SET_HANDOFF",{enabled:true,intervalMinutes:60},11,sourceUrl);
  env.advance(3601);
  await env.send("SCHEDULE_PULSE",{},11,sourceUrl);
  await env.send("ENQUEUE",{text:"需要留在原项目的待办"},11,sourceUrl);
  const claim=await env.send("CLAIM",{ready:true},11,sourceUrl);
  await env.send("SENT",{id:claim.dispatch.id},11,sourceUrl);
  env.advance(3);
  const summary=handoffReply(claim.dispatch.text,"只在正确项目中传输。".repeat(40));
  await env.send("FINISHED",{id:claim.dispatch.id,...handoffProof,handoffSummary:summary,
    handoffLastUserText:claim.dispatch.text},11,sourceUrl);
  await env.send("HANDOFF_NAVIGATE",{},11,sourceUrl);
  env.navigate(11,wrongUrl);
  const wrong=await env.send("HELLO",{projectVisitId:"wrong-project-visit"},11,wrongUrl);
  assert.equal(wrong.state.tasks.length,0,"错误项目不得挂载其他项目的交接内容");
  assert.equal(wrong.state.handoffSourceKey,undefined);
  const old=env.stored["cq.state.v2"].conversations["chat:source"];
  assert.equal(old.handoff.phase,"navigating");
  assert.equal(old.tasks[0].text,"需要留在原项目的待办");
  assert.equal(old.tasks.length,1);
});

test("上下文接力：新对话开场发送不确定时，须人工确认才可恢复旧队列", async () => {
  const env=await harness();
  const sourceUrl="https://chatgpt.com/g/g-p-recovery-test/c/old-recovery";
  const projectUrl="https://chatgpt.com/g/g-p-recovery-test/project";
  env.navigate(11,sourceUrl);
  await env.send("SET_HANDOFF",{enabled:true,intervalMinutes:60},11,sourceUrl);
  env.advance(3601);
  await env.send("SCHEDULE_PULSE",{},11,sourceUrl);
  await env.send("ENQUEUE",{text:"保留的正式任务"},11,sourceUrl);
  const claim=await env.send("CLAIM",{ready:true},11,sourceUrl);
  await env.send("SENT",{id:claim.dispatch.id},11,sourceUrl);
  env.advance(3);
  await env.send("FINISHED",{
    id:claim.dispatch.id,...handoffProof,
    handoffSummary:handoffReply(claim.dispatch.text,
      "这是要转移到新项目聊天的完整进度摘要。".repeat(22)),
    handoffLastUserText:claim.dispatch.text,
  },11,sourceUrl);
  await env.send("HANDOFF_NAVIGATE",{},11,sourceUrl);
  env.navigate(11,projectUrl);
  await env.send("HELLO",{},11,projectUrl);
  const intro=await env.send("CLAIM",{ready:true},11,projectUrl);
  await env.send("SENT",{id:intro.dispatch.id},11,projectUrl);
  await env.send("FAIL",{id:intro.dispatch.id,error:"交接回复传输失败"},11,projectUrl);
  env.navigate(11,sourceUrl);
  const blocked=await env.send("CANCEL_HANDOFF",{},11,sourceUrl);
  assert.equal(blocked.ok,false);
  assert.match(blocked.error,/人工核对/);
  const cancelled=await env.send("CANCEL_HANDOFF",{reviewed:true},11,sourceUrl);
  assert.equal(cancelled.ok,true);
  assert.equal(cancelled.state.tasks.length,1);
  assert.equal(cancelled.state.tasks[0].text,"保留的正式任务");
  assert.equal(cancelled.state.handoff.enabled,true,
    "对发送结果不确定的交接进行人工取消，也应保留原定时开关");
  assert.equal((await env.send("CLAIM",{ready:true},11,sourceUrl)).dispatch.text,
    "保留的正式任务");
});

test("接力总结发送前暂缓可安全重领同一条，已发送后不重复领取", async () => {
  const env=await harness();
  const url="https://chatgpt.com/g/g-p-summary-preclick-retry/c/source";
  env.navigate(11,url);
  await env.send("HANDOFF_NOW",{},11,url);
  await env.send("ENQUEUE",{text:"原队列继续保留"},11,url);
  const first=await env.send("CLAIM",{ready:true},11,url);
  assert.equal(first.dispatch.kind,"handoff_summary");
  const deferred=await env.send("RELEASE_CLAIM",{id:first.dispatch.id},11,url);
  assert.equal(deferred.state.handoff.phase,"summarizing");
  assert.equal(deferred.state.activeTaskId,null);
  assert.equal((await env.send("CLAIM",{ready:true},11,url)).dispatch,null,
    "发送前暂缓的重试间隔仍然有效");
  env.advance(3);
  const retried=await env.send("CLAIM",{ready:true},11,url);
  assert.equal(retried.dispatch.id,first.dispatch.id);
  assert.equal(retried.dispatch.kind,"handoff_summary");
  assert.equal(retried.state.tasks.filter((task)=>task.kind==="handoff_summary").length,1);
  assert.equal((await env.send("CLAIM",{ready:true},11,url)).dispatch,null,
    "仍由当前执行器持有的任务不能被重复领取");
  await env.send("SENT",{id:retried.dispatch.id},11,url);
  env.advance(3);
  assert.equal((await env.send("CLAIM",{ready:true},11,url)).dispatch,null);
  await env.send("FAIL",{id:retried.dispatch.id,error:"发送结果不确定"},11,url);
  assert.equal((await env.send("CLAIM",{ready:true},11,url)).dispatch,null,
    "发送不确定的总结不会自动重发");
});

test("接力恢复：从任一端取消只清内部记录，保留两端普通任务及原自动规则",async()=>{
  for(const side of ["source","receiver"]){
    const env=await harness();
    const fixture=await prepareRecoverableHandoffReceiver(env);
    await env.send("ENQUEUE",{text:"另一对话不受本轮取消影响"},12);
    const conversations=env.stored["cq.state.v2"].conversations;
    const unrelatedBefore=JSON.stringify(conversations["chat:dialogue-b"]);
    const sourceTaskId=conversations["chat:source"].tasks[0].id;
    const url=side==="source"?fixture.sourceUrl:fixture.projectUrl;
    env.navigate(11,url);
    const cancelled=await env.send("CANCEL_HANDOFF",{
      reviewed:true,projectVisitId:"receiver-recovery-visit",
    },11,url);
    assert.equal(cancelled.ok,true,side);
    assert.equal(cancelled.cancelPending,false);
    const source=conversations["chat:source"];
    const destination=conversations["draft:11"];
    assert.deepEqual(Array.from(source.tasks,task=>task.id),[sourceTaskId]);
    assert.equal(source.schedules.length,1);
    assert.equal(source.schedules[0].id,fixture.sourceRuleId);
    assert.equal(source.schedules[0].enabled,true);
    assert.equal(source.handoff.phase,"idle");
    assert.equal(source.handoff.token,undefined);
    assert.equal(source.handoff.destinationKey,undefined);
    assert.ok(destination,"含普通任务的接收队列不能被整份删除");
    assert.deepEqual(Array.from(destination.tasks,task=>task.id),["receiver-normal"]);
    assert.equal(destination.handoffSourceKey,undefined);
    assert.equal(destination.handoffToken,undefined);
    assert.equal(destination.activeTaskId,null);
    assert.equal(destination.tasks.some(task=>task.id===fixture.introId),false);
    assert.equal(JSON.stringify(conversations["chat:dialogue-b"]),unrelatedBefore);
  }
});

test("接收端垃圾桶和核对跳过共用取消逻辑，项目页保留普通队列并可确认恢复",async()=>{
  for(const [action,status] of [["DELETE_TASK","pending"],["DELETE_TASK","error"],
    ["DELETE_TASK","interrupted"],["SKIP_FAILED","error"]]){
    const env=await harness();
    const fixture=await prepareRecoverableHandoffReceiver(env,status);
    const removed=await env.send(action,{id:fixture.introId,reviewed:true,
      projectVisitId:"receiver-recovery-visit"},11,fixture.projectUrl);
    assert.equal(removed.ok,true,action+status);
    const destination=env.stored["cq.state.v2"].conversations["draft:11"];
    const source=env.stored["cq.state.v2"].conversations["chat:source"];
    assert.deepEqual(Array.from(destination.tasks,task=>task.id),["receiver-normal"]);
    assert.equal(destination.handoffSourceKey,undefined);
    assert.equal(destination.handoffToken,undefined);
    assert.equal(source.handoff.phase,"idle");
    assert.equal(source.tasks[0].text,"始终保留在原对话的任务");
    assert.equal(source.schedules[0].id,fixture.sourceRuleId);
    const acknowledged=await env.send("ACK_RECOVERY",{
      projectVisitId:"receiver-recovery-visit",
    },11,fixture.projectUrl);
    assert.equal(acknowledged.ok,true,"项目页允许恢复操作");
    if(status==="interrupted")assert.equal(acknowledged.state.haltReason,"user",
      "清理内部交接行不能顺带解除用户的原生停止");
  }
});

test("明确核对后可取消仍在接收的 intro，不重发已点击消息，也不丢普通行",async()=>{
  const env=await harness();
  const fixture=await prepareRecoverableHandoffReceiver(env,"waiting");
  const refused=await env.send("CANCEL_HANDOFF",{},11,fixture.projectUrl);
  assert.equal(refused.ok,false,"已点击的接收消息仍需用户明确核对");
  const reviewed=await env.send("CANCEL_HANDOFF",{reviewed:true,
    projectVisitId:"receiver-recovery-visit"},11,fixture.projectUrl);
  assert.equal(reviewed.ok,true);
  assert.equal(reviewed.cancelPending,false);
  assert.equal(reviewed.state.activeTaskId,null);
  assert.equal(reviewed.state.tasks.some(task=>task.id===fixture.introId),false);
  assert.deepEqual(Array.from(reviewed.state.tasks,task=>task.id),["receiver-normal"]);
  assert.equal(env.stored["cq.state.v2"].conversations["chat:source"].tasks.length,1);
});

test("接收端旧 token 或目的链变成孤儿时可清本地内部行，较新源原样保留",async()=>{
  for(const mismatch of ["token","destination"]){
    const env=await harness();
    const fixture=await prepareRecoverableHandoffReceiver(env);
    const conversations=env.stored["cq.state.v2"].conversations;
    if(mismatch==="token")conversations["draft:11"].handoffToken="another-round-token";
    else conversations["chat:source"].handoff.destinationKey="draft:another-round";
    const sourceBefore=JSON.stringify(conversations["chat:source"]);
    const cleared=await env.send("CANCEL_HANDOFF",{reviewed:true},11,fixture.projectUrl);
    assert.equal(cleared.ok,true,mismatch);
    assert.equal(cleared.cancelPending,false);
    assert.deepEqual(Array.from(cleared.state.tasks,task=>task.id),["receiver-normal"]);
    assert.equal(cleared.state.handoffSourceKey,undefined);
    assert.equal(cleared.state.handoffToken,undefined);
    assert.equal(JSON.stringify(conversations["chat:source"]),sourceBefore,
      "本地孤儿清理不能取消较新源轮次或改变其任务、规则");
  }
});

test("源已取消或不存在时接收端可单独清理孤儿 intro，不触碰现有源普通任务",async()=>{
  for(const orphan of ["missing_source","cancelled_source"]){
    const env=await harness();
    const fixture=await prepareRecoverableHandoffReceiver(env);
    const conversations=env.stored["cq.state.v2"].conversations;
    if(orphan==="missing_source")delete conversations["chat:source"];
    else conversations["chat:source"].handoff={enabled:false,intervalMinutes:120,
      repeatCount:-1,remainingCount:-1,nextAt:null,phase:"idle"};
    const sourceBefore=JSON.stringify(conversations["chat:source"]);
    const removed=await env.send("DELETE_TASK",{id:fixture.introId,reviewed:true,
      projectVisitId:"receiver-recovery-visit"},11,fixture.projectUrl);
    assert.equal(removed.ok,true,orphan);
    assert.equal(removed.state.handoffSourceKey,undefined);
    assert.equal(removed.state.handoffToken,undefined);
    assert.deepEqual(Array.from(removed.state.tasks,task=>task.id),["receiver-normal"]);
    assert.equal(JSON.stringify(conversations["chat:source"]),sourceBefore,
      "孤儿恢复只能清接收端遗留内部行");
  }
});

test("源端取消遇到另一轮接收链时只取消本端，接收端普通与内部行原样保留",async()=>{
  const env=await harness();
  const fixture=await prepareRecoverableHandoffReceiver(env);
  const conversations=env.stored["cq.state.v2"].conversations;
  conversations["draft:11"].handoffToken="newer-destination-round";
  const destinationBefore=JSON.stringify(conversations["draft:11"]);
  const sourceTasksBefore=JSON.stringify(conversations["chat:source"].tasks);
  const sourceRulesBefore=JSON.stringify(conversations["chat:source"].schedules);
  env.navigate(11,fixture.sourceUrl);
  const cancelled=await env.send("CANCEL_HANDOFF",{reviewed:true},11,fixture.sourceUrl);
  assert.equal(cancelled.ok,true);
  assert.equal(cancelled.cancelPending,false);
  assert.equal(cancelled.state.handoff.phase,"idle");
  assert.equal(JSON.stringify(cancelled.state.tasks),sourceTasksBefore);
  assert.equal(JSON.stringify(cancelled.state.schedules),sourceRulesBefore);
  assert.equal(JSON.stringify(conversations["draft:11"]),destinationBefore,
    "源端不能取消 token 已不同的另一轮接收记录");
});

test("接力接收草稿 A→B→A 按项目隔离，晚到确认不会污染新项目",async()=>{
  const env=await harness();
  const fixture=await prepareRecoverableHandoffReceiver(env);
  const projectB="https://chatgpt.com/g/g-p-receiver-project-b/project";
  const conversations=env.stored["cq.state.v2"].conversations;
  const originalTasks=JSON.stringify(conversations["draft:11"].tasks);
  const sourceRuleId=conversations["chat:source"].schedules[0].id;
  env.navigate(11,projectB);
  const next=await env.send("HELLO",{projectVisitId:"project-b-visit"},11,projectB);
  assert.equal(next.ok,true,next.error);
  assert.equal(next.sessionKey,"draft:11");
  assert.equal(next.state.tasks.length,0);
  assert.equal(next.state.handoffSourceKey,undefined);
  assert.equal(Boolean(next.state.error),false);
  assert.equal(next.state.halted,false);
  const parked=Object.values(conversations).find(state=>state.parkedDraft===true&&
    state.tabId===11&&state.url===fixture.projectUrl);
  assert.ok(parked);
  const parkedKey=parked.key;
  assert.match(parkedKey,/^draft:11:parked:/);
  assert.equal(JSON.stringify(parked.tasks),originalTasks);
  assert.equal(conversations["chat:source"].handoff.destinationKey,parkedKey);
  const parkedBefore=JSON.stringify(parked);
  for(const action of ["SENT","FAIL","RELEASE_CLAIM"]){
    const late=await env.send(action,{id:fixture.introId,error:"旧页面晚到的结果"},
      11,fixture.projectUrl,{url:projectB});
    assert.equal(late.ok,false,action);
    assert.equal(JSON.stringify(conversations[parkedKey]),parkedBefore);
    const current=conversations["draft:11"];
    if(current){
      assert.equal(current.tasks.length,0);
      assert.equal(current.handoffSourceKey,undefined);
    }
  }
  await env.tick(2);
  assert.equal(JSON.stringify(conversations[parkedKey]),parkedBefore,
    "隔离草稿不参与自动调度、超时恢复或队列补充");
  env.navigate(11,fixture.projectUrl);
  const restored=await env.send("HELLO",{projectVisitId:"receiver-returned-visit"},11,fixture.projectUrl);
  assert.equal(restored.ok,true);
  assert.equal(restored.sessionKey,"draft:11");
  assert.notEqual(restored.state.parkedDraft,true);
  assert.equal(JSON.stringify(restored.state.tasks),originalTasks);
  assert.equal(restored.state.handoffSourceKey,"chat:source");
  assert.equal(conversations["chat:source"].handoff.destinationKey,"draft:11");
  assert.equal(conversations["chat:source"].schedules[0].id,sourceRuleId);
  assert.equal(Object.hasOwn(conversations,parkedKey),false);
});

test("接力取消：等待总结时直接撤销，未发送的总结解除锁且不丢失原任务", async () => {
  const env=await harness();
  const url="https://chatgpt.com/g/g-p-cancel-during-claim/c/source";
  env.navigate(11,url);
  await env.send("SET_HANDOFF",{enabled:true,intervalMinutes:60},11,url);
  await env.send("HANDOFF_NOW",{},11,url);
  await env.send("ENQUEUE",{text:"原有重要任务"},11,url);
  const summary=await env.send("CLAIM",{ready:true},11,url);
  assert.equal(summary.state.tasks[0].kind,"handoff_summary");
  const cancelled=await env.send("CANCEL_HANDOFF",{},11,url);
  assert.equal(cancelled.ok,true);
  assert.equal(cancelled.cancelPending,true);
  assert.equal(cancelled.state.handoff.cancelRequested,true);
  assert.equal(cancelled.state.activeTaskId,summary.dispatch.id,
    "原生发送状态未确认时，取消不能直接丢弃活动任务锁");
  const released=await env.send("RELEASE_CLAIM",{id:summary.dispatch.id},11,url);
  assert.equal(released.state.handoff.phase,"idle");
  assert.equal(released.state.handoff.enabled,true);
  assert.equal(released.state.activeTaskId,null);
  assert.equal(released.state.tasks.map((item)=>item.text).join(","),"原有重要任务");
  assert.equal((await env.send("CLAIM",{ready:true},11,url)).dispatch.text,"原有重要任务");
});

test("接力取消：已发送总结仍需自然完成，随后丢弃专用总结且不跳转", async () => {
  const env=await harness();
  const url="https://chatgpt.com/g/g-p-cancel-waiting/c/source";
  env.navigate(11,url);
  await env.send("HANDOFF_NOW",{},11,url);
  await env.send("ENQUEUE",{text:"继续保留的原任务"},11,url);
  const claim=await env.send("CLAIM",{ready:true},11,url);
  await env.send("SENT",{id:claim.dispatch.id},11,url);
  const cancelled=await env.send("CANCEL_HANDOFF",{},11,url);
  assert.equal(cancelled.cancelPending,true);
  assert.equal(cancelled.state.handoff.cancelRequested,true);
  assert.equal(cancelled.state.activeTaskId,claim.dispatch.id);
  env.advance(5);
  const incomplete=await env.send("FINISHED",{
    id:claim.dispatch.id,voiceReady:false,editorEmpty:true,busy:false,
    handoffReady:true,handoffNativeIdle:true,handoffResponseConfirmed:true,
    handoffIdleStableMs:1000,handoffReplyStableMs:2500,
  },11,url);
  assert.equal(incomplete.ok,false);
  assert.equal((await env.send("GET",{},11,url)).state.handoff.phase,"summarizing");
  const done=await env.send("FINISHED",{
    id:claim.dispatch.id,voiceReady:false,editorEmpty:true,busy:false,
    handoffReady:true,handoffNativeIdle:true,handoffResponseConfirmed:true,
    handoffIdleStableMs:5200,handoffReplyStableMs:3000,
    handoffSummary:"即使缺少标记，取消请求也不应再试图解析总结",
  },11,url);
  assert.equal(done.ok,true);
  assert.equal(done.state.handoff.phase,"idle");
  assert.equal(done.state.activeTaskId,null);
  assert.equal(done.state.tasks.map((item)=>item.text).join(","),"继续保留的原任务");
  assert.equal((await env.send("HANDOFF_NAVIGATE",{},11,url)).ok,false,
    "已取消的接力不能继续导航");
});

test("接力完成：无语音按钮时严格的原生结束证据可验证总结和新聊天，普通队列仍拒绝", async () => {
  const env=await harness();
  const project="g-p-native-finish";
  const sourceUrl=`https://chatgpt.com/g/${project}/c/source`;
  const startUrl=`https://chatgpt.com/g/${project}/project`;
  const destinationUrl=`https://chatgpt.com/g/${project}/c/destination`;
  const nativeProof={
    voiceReady:false, editorEmpty:true,busy:false,
    handoffReady:true,handoffNativeIdle:true,handoffResponseConfirmed:true,
    handoffIdleStableMs:5100,handoffReplyStableMs:3000,
    handoffReplyIsNew:true,handoffLastRole:"assistant",
  };
  env.navigate(11,sourceUrl);
  await env.send("HANDOFF_NOW",{},11,sourceUrl);
  await env.send("ENQUEUE",{text:"接力后继续的原任务"},11,sourceUrl);
  const claimed=await env.send("CLAIM",{ready:true,assistantCount:8,lastAssistantId:"old-a"},11,sourceUrl);
  await env.send("SENT",{id:claimed.dispatch.id},11,sourceUrl);
  env.advance(5);
  const summaryBody=handoffReply(claimed.dispatch.text,
    "本次总结完整有效，且由原生停止控件与新回复完成工具栏联合确认。".repeat(12));
  const summary=await env.send("FINISHED",{
    id:claimed.dispatch.id,...nativeProof,handoffSummary:summaryBody,
  },11,sourceUrl);
  assert.equal(summary.ok,true);
  assert.equal(summary.state.handoff.phase,"opening");
  assert.equal(summary.state.tasks.length,1);
  await env.send("HANDOFF_NAVIGATE",{},11,sourceUrl);
  env.navigate(11,startUrl);
  await env.send("HELLO",{},11,startUrl);
  const intro=await env.send("CLAIM",{ready:true},11,startUrl);
  await env.send("SENT",{id:intro.dispatch.id},11,startUrl);
  env.navigate(11,destinationUrl);
  await env.send("HELLO",{lastUserText:intro.dispatch.text},11,destinationUrl);
  env.advance(5);
  const received=await env.send("FINISHED",{
    id:intro.dispatch.id,...nativeProof,
  },11,destinationUrl);
  assert.equal(received.ok,true);
  assert.equal(received.state.handoff.phase,"idle");
  assert.equal(received.state.tasks[0].text,"接力后继续的原任务");
  // A plain queued reply must never be completed using this fallback.
  const normalTask=await env.send("CLAIM",{ready:true},11,destinationUrl);
  await env.send("SENT",{id:normalTask.dispatch.id},11,destinationUrl);
  env.advance(5);
  const denied=await env.send("FINISHED",{
    id:normalTask.dispatch.id,...nativeProof,
  },11,destinationUrl);
  assert.equal(denied.ok,false);
  assert.equal((await env.send("GET",{},11,destinationUrl)).state.activeTaskId,
    normalTask.dispatch.id);
});

test("交接排队期间普通任务仍需普通结束证据，且按 FIFO 执行", async () => {
  const env=await harness();
  const url="https://chatgpt.com/g/g-p-finish-before-handoff/c/source";
  env.navigate(11,url);
  await env.send("ENQUEUE",{text:"第一轮工作"},11,url);
  await env.send("ENQUEUE",{text:"下一轮工作"},11,url);
  const first=await env.send("CLAIM",{ready:true,assistantCount:3,lastAssistantId:"a3"},11,url);
  await env.send("SENT",{id:first.dispatch.id},11,url);
  await env.send("HANDOFF_NOW",{},11,url);
  env.advance(5);
  const proof={
    id:first.dispatch.id,voiceReady:false,editorEmpty:true,busy:false,
    handoffReady:true,handoffNativeIdle:true,handoffResponseConfirmed:true,
    handoffIdleStableMs:5300,handoffReplyStableMs:3200,
  };
  const premature=await env.send("FINISHED",{
    ...proof,handoffReplyStableMs:800,
  },11,url);
  assert.equal(premature.ok,false);
  assert.equal((await env.send("FINISHED",proof,11,url)).ok,false,
    "尚未执行的交接命令不能放宽普通任务的完成条件");
  const completed=await env.send("FINISHED",{id:first.dispatch.id,...voiceProof},11,url);
  assert.equal(completed.ok,true);
  assert.equal(completed.state.handoff.phase,"queued");
  assert.equal(completed.state.tasks.length,2);
  assert.equal(completed.state.tasks[0].text,"下一轮工作");
  const next=await env.send("CLAIM",{ready:true},11,url);
  assert.equal(next.dispatch.text,"下一轮工作","交接不越过排在它前面的普通任务");
});

test("自动交接倒计时：FIFO 入队、暂停时保留、长时间轮询只产生一个命令", async () => {
  const env=await harness();
  const url="https://chatgpt.com/g/g-p-countdown-fifo/c/source";
  env.navigate(11,url);
  await env.send("ENQUEUE",{text:"倒计时之前的任务"},11,url);
  const saved=await env.send("SET_HANDOFF",{
    enabled:true,intervalMinutes:1,repeatCount:2,
  },11,url);
  assert.equal(saved.ok,true);
  await env.send("SET_QUEUE_PAUSED",{paused:true},11,url);
  env.advance(61);
  const expired=await env.send("SCHEDULE_PULSE",{},11,url);
  assert.equal(expired.state.tasks[0].text,"倒计时之前的任务");
  assert.equal(expired.state.tasks[1].kind,"handoff_summary");
  assert.equal(expired.state.tasks[1].handoffTrigger,"automatic");
  assert.equal(expired.state.handoff.remainingCount,2);
  assert.equal(expired.state.handoff.nextAt,null);
  const commandId=expired.state.tasks[1].id;
  env.advance(36000);
  for(let i=0;i<3;i++) await env.send("SCHEDULE_PULSE",{},11,url);
  const unchanged=await env.send("GET",{},11,url);
  assert.equal(unchanged.state.tasks.length,2);
  assert.equal(unchanged.state.tasks[1].id,commandId);
  assert.equal((await env.send("CLAIM",{ready:true},11,url)).dispatch,null);
  const cancelled=await env.send("CANCEL_HANDOFF",{},11,url);
  assert.equal(cancelled.state.tasks.length,1);
  assert.equal(cancelled.state.tasks[0].text,"倒计时之前的任务");
  assert.equal(cancelled.state.handoff.remainingCount,2,"取消未发送命令不扣次数");
  assert.ok(cancelled.state.handoff.nextAt > 0);
});

test("自动交接次数：成功才扣减，最后一次停止计时；手动成功不占自动次数", async () => {
  for(const manual of [false,true]){
    const env=await harness();
    const sourceUrl="https://chatgpt.com/g/g-p-finite-relay/c/source";
    const destinationUrl="https://chatgpt.com/g/g-p-finite-relay/c/destination";
    env.navigate(11,sourceUrl);
    await env.send("SET_HANDOFF",{enabled:true,intervalMinutes:1,repeatCount:1},11,sourceUrl);
    if(manual) await env.send("HANDOFF_NOW",{},11,sourceUrl);
    else { env.advance(61); await env.send("SCHEDULE_PULSE",{},11,sourceUrl); }
    const done=await finishQueuedHandoff(env,sourceUrl,destinationUrl);
    assert.equal(done.ok,true);
    assert.equal(done.state.handoff.remainingCount,manual?1:0);
    assert.equal(done.state.handoff.enabled,manual);
    if(manual) assert.ok(done.state.handoff.nextAt > 0);
    else {
      assert.equal(done.state.handoff.nextAt,null);
      env.advance(600);
      assert.equal((await env.send("SCHEDULE_PULSE",{},11,destinationUrl)).state.tasks.length,0);
    }
  }
});

test("无限自动交接：-1 在连续两个新对话中保持无限并重新倒计时", async () => {
  const env=await harness();
  let current="https://chatgpt.com/g/g-p-unlimited-relay/c/source";
  env.navigate(11,current);
  await env.send("SET_HANDOFF",{enabled:true,intervalMinutes:1,repeatCount:-1},11,current);
  for(let round=1;round<=2;round++){
    env.advance(61);
    const queued=await env.send("SCHEDULE_PULSE",{},11,current);
    assert.equal(queued.state.tasks.length,1,"空队列也执行已启用的倒计时");
    const next=`https://chatgpt.com/g/g-p-unlimited-relay/c/round-${round}`;
    const completed=await finishQueuedHandoff(env,current,next);
    assert.equal(completed.state.handoff.repeatCount,-1);
    assert.equal(completed.state.handoff.remainingCount,-1);
    assert.equal(completed.state.handoff.enabled,true);
    assert.ok(completed.state.handoff.nextAt > 0);
    current=next;
  }
});

async function prepareFailedUnsentHandoffRetry(env) {
  const sourceUrl="https://chatgpt.com/g/g-p-protected-entry/c/source";
  env.navigate(11,sourceUrl);
  const scheduled=await env.send("ADD_SCHEDULE",{
    text:"修复写入后仍须继续的自动规则",mode:"time",intervalMinutes:60,repeatCount:4,
  },11,sourceUrl);
  assert.equal(scheduled.ok,true);
  const fixture=await prepareClaimedHandoffSend(env,"handoff_intro");
  const released=await env.send("RELEASE_CLAIM",{id:fixture.id},11,fixture.url);
  assert.equal(released.ok,true);
  assert.equal(released.state.tasks[0].status,"pending");
  const store=env.stored["cq.state.v2"];
  const destination=store.conversations[fixture.key];
  const source=store.conversations[destination.handoffSourceKey];
  source.handoff.phase="failed";
  source.handoff.error="交接文档写入不一致，尚未点击发送";
  destination.halted=true;
  destination.haltReason="failure";
  destination.error=source.handoff.error;
  destination.handoff={...destination.handoff,phase:"failed",error:source.handoff.error};
  return {...fixture,store,source,destination,task:destination.tasks[0],
    cache:store.handoffQueues[source.key]};
}

test("明确重试未发送交接只恢复同轮接收，不领取、不点击、不迁移自动规则",async()=>{
  const env=await harness();
  const fixture=await prepareFailedUnsentHandoffRetry(env);
  const {source,destination,task,cache}=fixture;
  const queueId=source.handoff.queueId;
  const cacheBefore=JSON.stringify(cache);
  const scheduleBefore=JSON.stringify(source.schedules);
  const remainingBefore=JSON.stringify(source.tasks);
  const retried=await env.send("RETRY_UNSENT_HANDOFF",{
    id:task.id,userRequested:true,nativeBusy:false,userCount:0,
  },11,fixture.url);
  assert.equal(retried.ok,true);
  assert.equal(retried.retryReady,true);
  assert.equal(retried.dispatch,null,"恢复授权不能等同于领取或发送");
  assert.equal(source.handoff.phase,"bootstrapping");
  assert.equal(source.handoff.queueId,queueId);
  assert.equal(retried.state.halted,false);
  assert.equal(retried.state.error,"");
  assert.equal(retried.state.activeTaskId,null);
  assert.equal(retried.state.tasks.length,1);
  assert.equal(retried.state.tasks[0].id,task.id);
  assert.equal(retried.state.tasks[0].status,"pending");
  assert.equal(retried.state.tasks[0].handoffQueueId,queueId);
  assert.equal(retried.state.handoffQueueId,queueId);
  assert.equal(retried.state.handoffToken,destination.handoffToken);
  assert.equal(retried.state.tasks[0].claimedAt,undefined);
  assert.equal(retried.state.tasks[0].retryNotBefore,undefined);
  assert.equal(retried.state.tasks[0].sendArmedAt,undefined);
  assert.equal(retried.state.tasks[0].sentAt,undefined);
  assert.equal(retried.state.schedules.length,0,"自动规则仍等待交接回复完成后迁移");
  assert.equal(JSON.stringify(source.schedules),scheduleBefore);
  assert.equal(JSON.stringify(source.tasks),remainingBefore);
  assert.equal(JSON.stringify(fixture.store.handoffQueues[source.key]),cacheBefore);
});

test("未发送交接重试拒绝已授权、已发、等待、用户暂停和身份错配，缓存不被消费",async()=>{
  for(const mismatch of ["armed","sent","waiting","userHalt","paused","sourceHalt",
    "cacheQueue","cacheToken","observedRoute","confirmedRoute","owner","liveUrl",
    "notRequested","busy","existingTurns"]){
    const env=await harness();
    const fixture=await prepareFailedUnsentHandoffRetry(env);
    const {source,destination,task,cache}=fixture;
    const args={id:task.id,userRequested:true,nativeBusy:false,userCount:0};
    if(mismatch==="armed")task.sendArmedAt=1;
    if(mismatch==="sent")task.sentAt=1;
    if(mismatch==="waiting")task.status="waiting";
    if(mismatch==="userHalt")destination.haltReason="user";
    if(mismatch==="paused")destination.queuePaused=true;
    if(mismatch==="sourceHalt"){source.halted=true;source.haltReason="user";}
    if(mismatch==="cacheQueue")cache.queueId="another-relay-queue";
    if(mismatch==="cacheToken")cache.token="another-relay-token";
    if(mismatch==="observedRoute")cache.observedChatKey="chat:possibly-created";
    if(mismatch==="confirmedRoute")cache.confirmedChatKey="chat:confirmed-created";
    if(mismatch==="owner")source.tabId=12;
    if(mismatch==="liveUrl")env.tabs.get(11).url="https://chatgpt.com/c/another-dialogue";
    if(mismatch==="notRequested")args.userRequested=false;
    if(mismatch==="busy")args.nativeBusy=true;
    if(mismatch==="existingTurns")args.userCount=1;
    const cacheBefore=JSON.stringify(cache);
    const denied=await env.send("RETRY_UNSENT_HANDOFF",args,11,fixture.url);
    assert.equal(denied.ok,false,mismatch);
    assert.equal(denied.retryReady,undefined,mismatch);
    assert.equal(JSON.stringify(fixture.store.handoffQueues[source.key]),cacheBefore,mismatch);
    assert.equal(source.handoff.phase,"failed",mismatch);
    assert.equal(destination.schedules.length,0,mismatch);
  }
});

test("远程普通任务使用新标签接管空闲队列，旧标签不能继续自动领取且不会重复入队",async()=>{
  const env=await harness();
  await env.send("ENQUEUE",{text:"已有待发任务"},11,A);
  env.navigate(13,A);
  await env.send("HELLO",{},13,A);
  const requestId="77777777-7777-4777-8777-777777777777";
  const args={text:"AI 从新标签追加的任务",requestId,remoteJobId:requestId};
  const result=await env.send("ADD_TASK",args,13,A,{url:A});
  assert.equal(result.ok,true);
  assert.equal(result.state.tabId,13);
  assert.deepEqual(Array.from(result.state.tasks,t=>t.text),
    ["已有待发任务","AI 从新标签追加的任务"]);
  assert.equal((await env.send("CLAIM",{ready:true},11,A)).dispatch,null,
    "旧标签已不是队列所有者");
  const claimed=await env.send("CLAIM",{ready:true},13,A);
  assert.equal(claimed.dispatch.text,"已有待发任务","保留 FIFO 顺序");
  const duplicate=await env.send("ADD_TASK",args,13,A,{url:A});
  assert.equal(duplicate.ok,true);
  assert.equal(duplicate.state.tasks.length,2);
});

test("远程新标签不得抢走正在发送或引导中的旧对话队列",async()=>{
  const env=await harness();
  await env.send("ENQUEUE",{text:"已经执行中的任务"},11,A);
  const claimed=await env.send("CLAIM",{ready:true},11,A);
  assert.equal(claimed.ok,true);
  assert.ok(claimed.dispatch);
  env.navigate(13,A);
  await env.send("HELLO",{},13,A);
  const requestId="66666666-6666-4666-8666-666666666666";
  const denied=await env.send("ADD_TASK",{
    text:"不能抢占旧对话",remoteJobId:requestId,requestId,
  },13,A,{url:A});
  assert.equal(denied.ok,false);
  assert.match(denied.error,/正在执行/);
  const original=env.stored["cq.state.v2"].conversations["chat:dialogue-a"];
  assert.equal(original.tabId,11);
  assert.equal(original.tasks.length,1);
  assert.equal(original.recentSubmissions.some(x=>x.id===requestId),false);
});

test("远程引导只在真正观察到发送的用户消息后确认，丢回执也不会重复提交",async()=>{
  const env=await harness();
  const requestId="55555555-5555-4555-8555-555555555555";
  const result=await env.send("REMOTE_STEER_CLAIM",{
    text:"补充引导内容",requestId,userCount:0,busy:false,
  },11,A,{url:A});
  assert.equal(result.ok,true);
  const id=result.dispatch.id;
  assert.equal(result.state.tasks.find(t=>t.id===id).remoteJobId,requestId);
  assert.equal((await env.send("STEER_CLICKED",{id},11,A)).ok,true);
  const premature=await env.send("STEER_CONFIRM",{
    id,userCount:1,lastUserText:"其他人的消息",
  },11,A);
  assert.equal(premature.ok,false);
  assert.equal(env.stored["cq.state.v2"].conversations["chat:dialogue-a"]
    .remoteSteerConfirmedIds.length,0);
  const done=await env.send("STEER_CONFIRM",{
    id,userCount:1,lastUserText:"补充引导内容",newUserElement:true,
  },11,A);
  assert.equal(done.ok,true);
  assert.equal(done.state.remoteSteerConfirmedIds.includes(requestId),true);
  assert.equal(done.state.tasks.some(t=>t.id===id),false);
  const duplicate=await env.send("REMOTE_STEER_CLAIM",{
    text:"补充引导内容",requestId,userCount:1,busy:false,
  },11,A,{url:A});
  assert.equal(duplicate.ok,false);
  assert.equal(env.stored["cq.state.v2"].conversations["chat:dialogue-a"]
    .remoteSteerConfirmedIds.filter(x=>x===requestId).length,1);
});

test("远程任务结果按完成事务持久化，旧回复不能冒充新回复",async()=>{
  for(const matching of [true,false]) {
    const env=await harness({}, {structuredStorage:true});
    const remoteId=matching?"aaaaaaaa-1234-4234-8234-123456789abc":
      "bbbbbbbb-1234-4234-8234-123456789abc";
    await env.send("HELLO",{},11,A,{url:A});
    const queued=await env.send("ADD_TASK",{
      text:"请完成任务",requestId:remoteId,remoteJobId:remoteId,remoteCaptureResult:true,
    },11,A,{url:A});
    assert.equal(queued.ok,true,queued.error);
    const claim=await env.send("CLAIM",{ready:true,userCount:1,assistantCount:1,
      lastAssistantId:"old"},11,A,{url:A});
    assert.ok(claim.dispatch);
    await env.send("SENT",{id:claim.dispatch.id},11,A,{url:A});
    env.advance(4);
    env.failNextWrite("before");
    const result={completionStatus:"completed",replyText:"最终回复",
      userCount:2,lastUserText:"请完成任务",assistantCount:matching?2:1,
      assistantId:matching?"new":"old"};
    const failed=await env.send("FINISHED",{
      id:claim.dispatch.id,...voiceProof,remoteResult:result,
    },11,A,{url:A});
    assert.equal(failed.ok,false);
    assert.equal(env.stored["cq.state.v2"].remoteResults,undefined);
    const finished=await env.send("FINISHED",{
      id:claim.dispatch.id,...voiceProof,remoteResult:result,
    },11,A,{url:A});
    assert.equal(finished.ok,true,finished.error);
    const outbox=env.stored["cq.state.v2"].remoteResults;
    assert.equal(outbox.length,1);
    assert.equal(outbox[0].id,remoteId);
    assert.equal(outbox[0].completionStatus,matching?"completed":"result_unavailable");
    assert.equal(outbox[0].replyText,matching?"最终回复":undefined);
    const restarted=await harness(structuredClone(env.stored), {structuredStorage:true});
    assert.equal(restarted.stored["cq.state.v2"].remoteResults.length,1);
  }
});

test("远程新对话的隐藏镜像修正只适用于零基线和指定原始计数",async()=>{
  for (const scenario of [
    {name:"new",flag:true,raw:2,expected:"completed"},
    {name:"old",flag:false,raw:2,expected:"result_unavailable"},
    {name:"invalid",flag:true,raw:3,expected:"result_unavailable"},
  ]) {
    const env=await harness({}, {structuredStorage:true});
    const remoteId="aaaaaaaa-1234-4234-8234-123456789abc";
    await env.send("HELLO",{},11,A,{url:A});
    const queued=await env.send("ADD_TASK",{text:"请完成任务",requestId:remoteId,
      remoteJobId:remoteId,remoteCaptureResult:true,remoteNewChat:scenario.flag},11,A,{url:A});
    assert.equal(queued.ok,true,scenario.name);
    assert.equal(queued.state.tasks[0].remoteNewChat===true,scenario.flag);
    const claim=await env.send("CLAIM",{ready:true,userCount:0,assistantCount:0},11,A,{url:A});
    assert.ok(claim.dispatch,scenario.name);
    await env.send("SENT",{id:claim.dispatch.id},11,A,{url:A});
    env.advance(4);
    const result={completionStatus:"completed",replyText:"最终回复",userCount:1,
      rawUserCount:scenario.raw,mirrorIgnored:true,lastUserText:"请完成任务",assistantCount:1};
    const finished=await env.send("FINISHED",{id:claim.dispatch.id,...voiceProof,remoteResult:result},11,A,{url:A});
    assert.equal(finished.ok,true,scenario.name);
    const outcome=env.stored["cq.state.v2"].remoteResults[0];
    assert.equal(outcome.completionStatus,scenario.expected,scenario.name);
    assert.equal(outcome.replyText,scenario.expected==="completed"?"最终回复":undefined,scenario.name);
  }
});

test("远程新对话首页跳转后保留镜像修正标记并完成结果",async()=>{
  const env=await harness({}, {structuredStorage:true});
  const home="https://chatgpt.com/", remoteId="aaaaaaaa-1234-4234-8234-123456789abc";
  await env.send("HELLO",{},13,home,{url:home});
  const added=await env.send("ADD_TASK",{text:"请完成任务",requestId:remoteId,
    remoteJobId:remoteId,remoteCaptureResult:true,remoteNewChat:true},13,home,{url:home});
  assert.equal(added.ok,true,added.error);
  const claim=await env.send("CLAIM",{ready:true,userCount:0,assistantCount:0},13,home,{url:home});
  assert.ok(claim.dispatch);
  await env.send("SENT",{id:claim.dispatch.id},13,home,{url:home});
  env.navigate(13,A);
  const adopted=await env.send("HELLO",{lastUserText:"请完成任务",userCount:2},13,A,{url:A});
  assert.equal(adopted.ok,true,adopted.error);
  assert.equal(adopted.state.tasks.find(task=>task.id===claim.dispatch.id).remoteNewChat,true);
  env.advance(4);
  const finished=await env.send("FINISHED",{id:claim.dispatch.id,...voiceProof,
    remoteResult:{completionStatus:"completed",replyText:"最终回复",userCount:1,rawUserCount:2,
      mirrorIgnored:true,lastUserText:"请完成任务",assistantCount:1}},13,A,{url:A});
  assert.equal(finished.ok,true,finished.error);
  assert.equal(env.stored["cq.state.v2"].remoteResults[0].completionStatus,"completed");
});

test("远程任务超时或停止时回报不可确认，而不是一直等待或宣称完成",async()=>{
  for(const mode of ["timeout","stopped","failure"]) {
    const env=await harness({}, {structuredStorage:true});
    const remoteId={timeout:"cccccccc-1234-4234-8234-123456789abc",
      stopped:"dddddddd-1234-4234-8234-123456789abc",
      failure:"eeeeeeee-1234-4234-8234-123456789abc"}[mode];
    await env.send("HELLO",{},11,A,{url:A});
    await env.send("ADD_TASK",{text:"任务",requestId:remoteId,remoteJobId:remoteId,remoteCaptureResult:true},11,A,{url:A});
    const claim=await env.send("CLAIM",{ready:true,userCount:1,assistantCount:1},11,A,{url:A});
    await env.send("SENT",{id:claim.dispatch.id},11,A,{url:A});
    if(mode==="timeout") {env.advance(46*60);await env.tick(1);}
    else if(mode==="stopped") await env.send("STOPPED",{},11,A,{url:A});
    else await env.send("FAIL",{id:claim.dispatch.id,error:"模拟失败"},11,A,{url:A});
    const outbox=env.stored["cq.state.v2"].remoteResults;
    assert.equal(outbox.length,1);
    assert.equal(outbox[0].id,remoteId);
    assert.equal(outbox[0].completionStatus,"result_unavailable");
    assert.ok(outbox[0].resultError);
  }
});
