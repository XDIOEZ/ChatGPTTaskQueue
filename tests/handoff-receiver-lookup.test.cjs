"use strict";

// Source-only receiver lookup regressions. Worker startup is suppressed and
// the fixture never navigates a browser or sends a real ChatGPT message.
const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const vm=require("node:vm");
const {webcrypto}=require("node:crypto");
const {TextEncoder}=require("node:util");
const workerSource=fs.readFileSync(path.join(__dirname,"..","background.js"),"utf8");
const handoffSource=fs.readFileSync(path.join(__dirname,"..","handoff.js"),"utf8");
const PROJECT="https://chatgpt.com/g/g-p-lookup-project/project";
const DESTINATION="https://chatgpt.com/g/g-p-lookup-project/c/lookup-destination";
const OTHER_PROJECT="https://chatgpt.com/g/g-p-other-project/project";
const sender={tab:{id:11,url:DESTINATION}};
const plain=value=>JSON.parse(JSON.stringify(value));

function fixture() {
  const stored={};
  const event={addListener(){}};
  const chrome={
    storage:{local:{
      async get(keys){return Object.fromEntries((Array.isArray(keys)?keys:[keys])
        .map(key=>[key,structuredClone(stored[key])]));},
      async set(values){Object.assign(stored,structuredClone(values));},
    }},
    runtime:{getManifest:()=>({version:"0.49.47"}),onInstalled:event,onStartup:event,onMessage:event},
    alarms:{onAlarm:event},tabs:{onUpdated:event,onRemoved:event},action:{onClicked:event},
  };
  let context;
  context=vm.createContext({chrome,crypto:webcrypto,URL,Date,atob,TextEncoder,
    structuredClone,setTimeout,clearTimeout,console:{warn(){},error(){}},
    cqImageStore:{async prune(){},async remove(){}},
    importScripts(...names){
      for(const name of names){
        if(name==="handoff.js")vm.runInContext(handoffSource,context);
        else assert.equal(name,"image-store.js");
      }
    },
  });
  const withoutStartup=workerSource.replace(/\bstartSafely\(\);\s*$/,"/* receiver fixture: no startup */");
  assert.notEqual(withoutStartup,workerSource,"Worker startup hook moved");
  vm.runInContext(withoutStartup,context);
  const api=vm.runInContext(`({blankStore,blankSession,newTask,enqueueHandoff,
    checkpointHandoffQueue,attachProjectHandoff,switchDraftScope,selectHandoffAdoption,
    adoptNewChat,finishHandoffTransfer,handoffTargetBlocker})`,context);
  return {api,store:api.blankStore()};
}

function receiver(api,store,name,summary) {
  const url=`https://chatgpt.com/g/g-p-lookup-project/c/${name}`;
  const source=api.blankSession(`chat:${name}`,url,11);
  source.schedules=[{id:`rule-${name}`,text:`自动规则 ${name}`,images:[],mode:"count",
    threshold:1,repeatCount:-1,runCount:3,enabled:true,nextRunAt:null,lastRunAt:null}];
  const remaining=api.newTask(`待执行任务 ${name}`,`rule-${name}`);
  source.tasks.push(remaining);
  store.conversations[source.key]=source;
  api.enqueueHandoff(store,source,"manual");
  source.tasks=source.tasks.filter(task=>task.kind!=="handoff_summary");
  Object.assign(source.handoff,{phase:"navigating",projectId:"g-p-lookup-project",
    projectUrl:PROJECT,summary,changedAt:Date.now()});
  api.checkpointHandoffQueue(store,source);
  assert.equal(api.attachProjectHandoff(store,{tab:{id:11,url:PROJECT}},PROJECT),true);
  const draft=store.conversations["draft:11"];
  const intro=draft.tasks[0];
  intro.status="waiting";
  intro.sentAt=Date.now()-5000;
  draft.activeTaskId=intro.id;
  return {source,draft,intro,remaining};
}

function park(api,store) {
  assert.equal(api.switchDraftScope(store,11,OTHER_PROJECT),true);
}

function observationShell(api,store) {
  const shell=api.blankSession("chat:lookup-destination",DESTINATION,11);
  shell.history=["tab_owner_rebound","tab_revived","tab_reopened"]
    .map((type,index)=>({at:Date.now()-3000+index,type}));
  shell.lastTimeScheduleId=null;
  shell.lastCountScheduleId=null;
  shell.countRateLimit={maxAdds:3,windowMinutes:10,enabled:false};
  shell.handoff={phase:"idle",nextAt:null,remainingCount:-1,repeatCount:-1,
    intervalMinutes:120,enabled:false};
  store.conversations[shell.key]=shell;
  return shell;
}

test("后台唤醒历史和默认空元数据不阻断唯一接收，确认后恢复缓存任务、规则和自动交接",()=>{
  const {api,store}=fixture();
  const original=receiver(api,store,"observed-source","任务主题：继续回复帖子\n保留自动任务与进度。");
  park(api,store);
  const shell=observationShell(api,store);
  Object.assign(original.source.handoff,{enabled:true,intervalMinutes:15,
    repeatCount:3,remainingCount:2,trigger:"automatic",manualRequested:false});
  assert.equal(api.handoffTargetBlocker(shell,sender,DESTINATION),"none");
  const selected=api.selectHandoffAdoption(store,sender,DESTINATION,original.intro.text,1,false,true);
  assert.equal(selected.matchCount,1);
  assert.equal(selected.candidate.targetShell,true);
  assert.equal(selected.candidate.targetBlocker,"none");
  assert.equal(selected.candidate.targetSystemHistoryCount,3);
  assert.equal(selected.candidate.targetBusinessHistoryCount,0);
  const observations=plain(shell.history);
  assert.equal(api.adoptNewChat(store,sender,DESTINATION,original.intro.text,false,null,true,1),true);
  const destination=store.conversations[shell.key];
  assert.equal(destination,original.draft);
  for(const entry of observations) assert.ok(destination.history.some(item=>
    item.at===entry.at && item.type===entry.type),"绑定后保留已有后台观察历史");
  assert.equal(destination.schedules.length,0,"绑定 ID 后仍需等待接收完成才迁移自动任务");
  assert.equal(destination.tasks[0].kind,"handoff_intro");
  original.source.tasks=[];
  original.source.schedules=[];
  const finishedAfter=Date.now();
  api.finishHandoffTransfer(store,destination,original.intro,DESTINATION);
  assert.equal(destination.tasks[0].id,original.remaining.id);
  assert.equal(destination.tasks[0].sourceScheduleId,"rule-observed-source");
  assert.equal(destination.schedules[0].id,"rule-observed-source");
  assert.equal(destination.schedules[0].runCount,3);
  assert.equal(destination.handoff.enabled,true);
  assert.equal(destination.handoff.intervalMinutes,15);
  assert.equal(destination.handoff.repeatCount,3);
  assert.equal(destination.handoff.remainingCount,1,"本轮自动交接成功后只扣一次次数");
  assert.ok(destination.handoff.nextAt>=finishedAfter+15*60_000);
  assert.equal(store.handoffQueues[original.source.key],undefined);
  assert.equal(original.source.handoff.phase,"completed");
});

test("接收目标有业务历史、非默认配置、未知字段或错误 owner 时保持全部原状态",()=>{
  const cases=[
    ["业务历史","history",shell=>shell.history.push({at:Date.now(),type:"manual_enqueue",taskId:"existing-task"})],
    ["后台历史携带任务 ID","history",shell=>shell.history[0].taskId="existing-task"],
    ["非默认数量限制","configuration",shell=>shell.countRateLimit.enabled=true],
    ["已开启自动交接","configuration",shell=>shell.handoff.enabled=true],
    ["非默认显示配置","configuration",shell=>shell.compactView=true],
    ["未知字段","unknown_field",shell=>shell.unknownBusinessField=true],
    ["错误 owner","owner",shell=>shell.tabId=12],
  ];
  for(const [label,blocker,mutate] of cases){
    const {api,store}=fixture();
    const original=receiver(api,store,"protected-source","任务主题：保留目标对话的已有业务。");
    park(api,store);
    const shell=observationShell(api,store);
    mutate(shell);
    assert.equal(api.handoffTargetBlocker(shell,sender,DESTINATION),blocker,label);
    const before=plain(store);
    const selected=api.selectHandoffAdoption(store,sender,DESTINATION,original.intro.text,1,false,true);
    assert.equal(Boolean(selected.candidate),false,label);
    if(blocker!=="owner") {
      assert.equal(selected.observation.targetBlocker,blocker,label);
      assert.equal(selected.observation.targetSystemHistoryCount,blocker==="history" && label!=="业务历史"?2:3,label);
      assert.equal(selected.observation.targetBusinessHistoryCount,blocker==="history"?1:0,label);
    }
    assert.equal(api.adoptNewChat(store,sender,DESTINATION,original.intro.text,false,null,true,1),false,label);
    assert.deepEqual(plain(store),before,label);
  }
});

test("目标只有后台元数据也不能绕过多轮接力正文歧义",()=>{
  const {api,store}=fixture();
  const body="任务主题：相同任务\n两轮接力均保留同一组进度。";
  const first=receiver(api,store,"observed-first",body);
  park(api,store);
  receiver(api,store,"observed-second",body);
  const shell=observationShell(api,store);
  assert.equal(api.handoffTargetBlocker(shell,sender,DESTINATION),"none");
  const before=plain(store);
  const selected=api.selectHandoffAdoption(store,sender,DESTINATION,first.intro.text,1,false,true);
  assert.equal(selected.matchCount,2);
  assert.equal(selected.reason,"adoption_ambiguous");
  assert.equal(Boolean(selected.candidate),false);
  assert.equal(api.adoptNewChat(store,sender,DESTINATION,first.intro.text,false,null,true,1),false);
  assert.deepEqual(plain(store),before);
});

test("按源记录查找已停放接收草稿，正式绑定后才恢复任务且保留其他项目的当前草稿",()=>{
  const {api,store}=fixture();
  const original=receiver(api,store,"lookup-source","任务主题：回复帖子\n保留进度和自动规则。");
  park(api,store);
  const parkedKey=original.draft.key;
  const live=api.blankSession("draft:11",OTHER_PROJECT,11);
  live.tasks.push(api.newTask("另一项目的普通草稿任务"));
  store.conversations[live.key]=live;
  const beforeLive=plain(live);
  const selected=api.selectHandoffAdoption(store,sender,DESTINATION,original.intro.text,1,false,true);
  assert.equal(selected.matchCount,1);
  assert.equal(selected.candidate.key,parkedKey);
  assert.equal(api.adoptNewChat(store,sender,DESTINATION,original.intro.text,false,null,true,1),true);
  const destination=store.conversations["chat:lookup-destination"];
  assert.equal(destination,original.draft);
  assert.equal(destination.parkedDraft,undefined);
  assert.equal(store.conversations[parkedKey],undefined);
  assert.deepEqual(plain(store.conversations["draft:11"]),beforeLive);
  assert.equal(original.source.handoff.destinationKey,destination.key);
  assert.equal(store.handoffQueues[original.source.key].destinationKey,destination.key);
  assert.equal(destination.handoffQueueId,original.source.handoff.queueId);
  assert.equal(destination.schedules.length,0,"绑定新对话 ID 不能提前注入自动规则");
  assert.equal(destination.tasks.length,1);
  assert.equal(destination.tasks[0].kind,"handoff_intro");
  assert.equal(store.handoffQueues[original.source.key].taskSnapshotVersion,1);
  assert.equal(store.handoffQueues[original.source.key].tasks[0].id,original.remaining.id);
  // Source arrays can disappear during reattachment; the confirmed receiver
  // must inject the independent cached task/rule records, with original IDs.
  original.source.tasks=[];
  original.source.schedules=[];
  api.finishHandoffTransfer(store,destination,original.intro,DESTINATION);
  assert.equal(destination.schedules[0].id,"rule-lookup-source");
  assert.equal(destination.schedules[0].runCount,3);
  assert.equal(destination.tasks[0].id,original.remaining.id);
  assert.equal(destination.tasks[0].sourceScheduleId,"rule-lookup-source");
  assert.deepEqual(plain(store.conversations["draft:11"]),beforeLive);
});

test("多个有效接力文档全文相同仍拒绝猜选，不按最新时间或当前槽抢占",()=>{
  const {api,store}=fixture();
  const body="任务主题：相同任务\n两个不同轮次可能生成完全相同的文档。";
  const first=receiver(api,store,"first-source",body);
  park(api,store);
  const second=receiver(api,store,"second-source",body);
  assert.equal(first.intro.text,second.intro.text);
  const before=plain(store);
  const selected=api.selectHandoffAdoption(store,sender,DESTINATION,first.intro.text,1,false,true);
  assert.equal(selected.matchCount,2);
  assert.equal(Boolean(selected.candidate),false);
  assert.equal(api.adoptNewChat(store,sender,DESTINATION,first.intro.text,false,null,true,1),false);
  assert.deepEqual(plain(store),before);
  assert.equal(store.conversations["chat:lookup-destination"],undefined);
});

test("同一标签存在多轮接力时，正文唯一命中已停放轮次，不改变当前轮次的目标和缓存",()=>{
  const {api,store}=fixture();
  const first=receiver(api,store,"first-source","任务主题：回复帖子\n保留帖子的回复记录。");
  park(api,store);
  const second=receiver(api,store,"second-source","任务主题：优化性能\n保留性能采样与修改进度。");
  const secondCache=plain(store.handoffQueues[second.source.key]);
  const liveBefore=plain(second.draft);
  const selected=api.selectHandoffAdoption(store,sender,DESTINATION,first.intro.text,1,false,true);
  assert.equal(selected.matchCount,1);
  assert.equal(selected.candidate.source.key,first.source.key);
  assert.equal(api.adoptNewChat(store,sender,DESTINATION,first.intro.text,false,null,true,1),true);
  assert.equal(store.conversations["draft:11"],second.draft);
  assert.deepEqual(plain(second.draft),liveBefore);
  assert.deepEqual(plain(store.handoffQueues[second.source.key]),secondCache);
  assert.equal(first.source.handoff.destinationKey,"chat:lookup-destination");
  assert.equal(second.source.handoff.destinationKey,"draft:11");
});

test("候选接力已失败、取消或凭证错配时，不凭相同项目和相同正文自动收养",()=>{
  for(const invalid of ["failed","cancelled","queueId","owner","multiple-users"]){
    const {api,store}=fixture();
    const original=receiver(api,store,"invalid-source","任务主题：待处理任务\n保留已有自动规则。");
    park(api,store);
    if(invalid==="failed")original.source.handoff.phase="failed";
    if(invalid==="cancelled")original.source.handoff.cancelRequested=true;
    if(invalid==="queueId")original.draft.handoffQueueId="another-round";
    if(invalid==="owner")original.source.tabId=12;
    const before=plain(store);
    const count=invalid==="multiple-users"?2:1;
    assert.equal(api.adoptNewChat(store,sender,DESTINATION,original.intro.text,false,null,true,count),false,invalid);
    assert.deepEqual(plain(store),before,invalid);
  }
});

test("唯一接力允许新增 100 字符并绑定目标 ID，新增 101 字符不收养",()=>{
  for(const extra of [100,101]) {
    const {api,store}=fixture();
    const original=receiver(api,store,"tolerance-source","任务主题：保持原任务\n完整保留目标和约束。");
    park(api,store);
    const observed="X".repeat(extra)+original.intro.text;
    const before=plain(store);
    const selected=api.selectHandoffAdoption(store,sender,DESTINATION,observed,1,false,true);
    assert.equal(selected.matchCount,extra===100?1:0);
    assert.equal(api.adoptNewChat(store,sender,DESTINATION,observed,false,null,true,1),extra===100);
    if(extra===100) {
      const destination=store.conversations["chat:lookup-destination"];
      assert.equal(destination.handoffQueueId,original.source.handoff.queueId);
      assert.equal(store.handoffQueues[original.source.key].confirmedChatKey,destination.key);
      assert.equal(destination.tasks[0].kind,"handoff_intro","文本容差确认不提前注入普通任务");
      assert.equal(destination.schedules.length,0);
    } else assert.deepEqual(plain(store),before);
  }
});

test("不同原文同时容差命中时拒绝猜选，即使其中一轮严格相等",()=>{
  const {api,store}=fixture();
  const body="任务主题：同一实际任务\n完整保留原始目标和下一步。";
  const first=receiver(api,store,"tolerance-first",body);
  park(api,store);
  const second=receiver(api,store,"tolerance-second",body+"X");
  assert.notEqual(first.intro.text,second.intro.text);
  const observed=second.intro.text;
  const before=plain(store);
  const selected=api.selectHandoffAdoption(store,sender,DESTINATION,observed,1,false,true);
  assert.equal(selected.matchCount,2,"严格相等不能遮蔽另一轮容差匹配");
  assert.equal(Boolean(selected.candidate),false);
  assert.equal(api.adoptNewChat(store,sender,DESTINATION,observed,false,null,true,1),false);
  assert.deepEqual(plain(store),before);
});
