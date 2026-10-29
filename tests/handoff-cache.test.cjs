"use strict";

// Source-only regression cases for the durable handoff cache. Loading this
// fixture suppresses worker startup: no browser, navigation or real messages.
const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const vm=require("node:vm");
const {webcrypto}=require("node:crypto");
const {TextEncoder}=require("node:util");
const workerSource=fs.readFileSync(path.join(__dirname,"..","background.js"),"utf8");
const handoffSource=fs.readFileSync(path.join(__dirname,"..","handoff.js"),"utf8");
const remoteDispatchSource=fs.readFileSync(path.join(__dirname,"..","remote-dispatch.js"),"utf8");
const SOURCE="https://chatgpt.com/g/g-p-cache-project/c/cache-source";
const PROJECT="https://chatgpt.com/g/g-p-cache-project/project";
const DESTINATION="https://chatgpt.com/g/g-p-cache-project/c/cache-destination";
const plain=value=>JSON.parse(JSON.stringify(value));

function fixture(initial={}) {
  const stored=structuredClone(initial);
  const event={addListener(){}};
  const chrome={
    storage:{local:{
      async get(keys){return Object.fromEntries((Array.isArray(keys)?keys:[keys])
        .map(key=>[key,structuredClone(stored[key])]));},
      async set(values){Object.assign(stored,structuredClone(values));},
    }},
    runtime:{getManifest:()=>({version:"0.49.46"}),onInstalled:event,onStartup:event,onMessage:event},
    alarms:{onAlarm:event},tabs:{onUpdated:event,onRemoved:event},action:{onClicked:event},
  };
  let context;
  context=vm.createContext({chrome,crypto:webcrypto,URL,Date,atob,TextEncoder,
    structuredClone,setTimeout,clearTimeout,console:{warn(){},error(){}},
    cqImageStore:{async prune(){},async remove(){}},
    importScripts(...names){
      for(const name of names){
        if(name==="handoff.js")vm.runInContext(handoffSource,context);
        else if(name==="remote-dispatch.js")vm.runInContext(remoteDispatchSource,context);
        else assert.equal(name,"image-store.js");
      }
    },
  });
  const withoutStartup=workerSource.replace(/\bstartSafely\(\);\s*$/,"/* startup disabled by cache fixture */");
  assert.notEqual(withoutStartup,workerSource,"Worker startup hook moved");
  vm.runInContext(withoutStartup,context);
  const api=vm.runInContext(`({blankStore,blankSession,newTask,enqueueHandoff,
    checkpointHandoffQueue,checkpointHandoffTasks,checkpointScheduledHandoffQueue,dueSchedules,
    handoffQueueFor,removeHandoffQueue,maintainHandoffQueues,
    attachProjectHandoff,adoptNewChat,finishHandoffTransfer,cancelHandoffTransaction,
    readStore,saveStore,imageReferences})`,context);
  return {api,stored};
}

function sourceSession(api,store,key="chat:cache-source",url=SOURCE,tabId=11) {
  const source=api.blankSession(key,url,tabId);
  source.schedules=[{
    id:"time-rule-original",text:"定时继续任务",images:[{id:"rule-image",name:"说明.png",type:"image/png"}],
    mode:"time",intervalMinutes:90,repeatCount:5,runCount:2,enabled:true,
    nextRunAt:Date.now()+90*60_000,lastRunAt:Date.now()-90*60_000,
  },{
    id:"count-rule-original",text:"数量不足补入",images:[],mode:"count",threshold:2,
    repeatCount:-1,runCount:7,enabled:false,nextRunAt:null,lastRunAt:Date.now()-10_000,
  }];
  source.countRateLimit={enabled:true,windowMinutes:10,maxAdds:3};
  source.countRateTimes=[Date.now()-5000];
  source.lastCountScheduleId="count-rule-original";
  source.lastTimeScheduleId="time-rule-original";
  source.sendCooldownSeconds=12;
  source.autoOpenTab=true;
  store.conversations[key]=source;
  return source;
}

function receiverFixture() {
  const env=fixture();
  const {api}=env;
  const store=api.blankStore();
  const source=sourceSession(api,store);
  assert.equal(api.enqueueHandoff(store,source,"manual"),true);
  // The summary has completed. Remaining task references the original rule.
  const remaining=api.newTask("继续尚未执行的自动任务","time-rule-original");
  source.tasks=[remaining];
  // Model the real ENQUEUE mutation hook rather than adding uncached work.
  api.checkpointHandoffTasks(store,source);
  Object.assign(source.handoff,{phase:"navigating",projectId:"g-p-cache-project",
    projectUrl:PROJECT,summary:"任务主题：继续任务\n保留规则、进度和约束。",changedAt:Date.now()});
  api.checkpointHandoffQueue(store,source);
  assert.equal(api.attachProjectHandoff(store,{tab:{id:11,url:PROJECT}},PROJECT),true);
  const draft=store.conversations["draft:11"];
  const intro=draft.tasks[0];
  intro.status="waiting";
  intro.sentAt=Date.now()-5000;
  draft.activeTaskId=intro.id;
  assert.equal(api.adoptNewChat(store,{tab:{id:11,url:DESTINATION}},DESTINATION,
    intro.text,false,null,false,1),true);
  const destination=store.conversations["chat:cache-destination"];
  return {...env,store,source,destination,intro,remaining};
}

test("接力启动按来源对话缓存深拷贝，队列身份随草稿和正式对话传递",()=>{
  const {api,store,source,destination}=receiverFixture();
  const cached=store.handoffQueues[source.key];
  assert.equal(cached.version,1);
  assert.equal(cached.sourceKey,source.key);
  assert.equal(cached.queueId,source.handoff.queueId);
  assert.equal(cached.token,source.handoff.token);
  assert.equal(cached.projectId,"g-p-cache-project");
  assert.equal(cached.destinationKey,destination.key);
  assert.equal(cached.taskSnapshotVersion,1);
  assert.equal(cached.tasks.length,1);
  assert.equal(cached.tasks[0].sourceScheduleId,"time-rule-original");
  assert.equal(destination.handoffCacheKey,source.key);
  assert.equal(destination.handoffQueueId,cached.queueId);
  assert.equal(destination.handoffToken,cached.token);
  assert.notEqual(cached.schedules,source.schedules);
  assert.notEqual(cached.schedules[0],source.schedules[0]);
  assert.notEqual(cached.schedules[0].images,source.schedules[0].images);
  const second=sourceSession(api,store,"chat:second-source",
    "https://chatgpt.com/g/g-p-cache-project/c/second-source",12);
  api.enqueueHandoff(store,second,"automatic");
  assert.notEqual(second.handoff.queueId,source.handoff.queueId);
  assert.notEqual(second.handoff.token,source.handoff.token);
  assert.equal(store.handoffQueues[source.key],cached,"另一来源不得覆盖当前缓存");
});

test("接力完成从持久缓存恢复原规则身份与执行进度，消费一次且保留任务引用",()=>{
  const {api,store,source,destination,intro,remaining}=receiverFixture();
  const expected=plain(store.handoffQueues[source.key].schedules);
  // Simulate the reported disappearance from the live source record. The
  // cached snapshot is the transfer source; do not reconstruct it from [].
  source.schedules=[];
  source.tasks=[];
  api.finishHandoffTransfer(store,destination,intro,DESTINATION);
  assert.deepEqual(plain(destination.schedules),expected);
  assert.equal(destination.tasks[0].id,remaining.id);
  assert.equal(destination.tasks[0].sourceScheduleId,"time-rule-original");
  assert.equal(destination.schedules[0].runCount,2);
  assert.equal(destination.schedules[1].runCount,7);
  assert.equal(destination.schedules[1].enabled,false);
  assert.equal(destination.schedules[0].images[0].id,"rule-image");
  assert.equal(destination.countRateLimit.maxAdds,3);
  assert.equal(destination.sendCooldownSeconds,12);
  assert.equal(destination.lastTimeScheduleId,"time-rule-original");
  assert.equal(store.handoffQueues[source.key],undefined);
  assert.equal(destination.handoffQueueId,undefined);
  assert.equal(destination.handoffCacheKey,undefined);
  assert.equal(source.handoff.phase,"completed");
  const once=plain(destination.schedules);
  assert.throws(()=>api.finishHandoffTransfer(store,destination,intro,DESTINATION));
  assert.deepEqual(plain(destination.schedules),once);
});

test("错误队列ID、凭证、项目或目标拒绝恢复且不消费正确缓存",()=>{
  for(const mismatch of ["queueId","token","project","target"]){
    const {api,store,source,destination,intro}=receiverFixture();
    const cached=store.handoffQueues[source.key];
    const before=plain(cached);
    if(mismatch==="queueId")destination.handoffQueueId="another-round-queue";
    if(mismatch==="token")destination.handoffToken="another-round-token";
    if(mismatch==="project")cached.projectId="g-p-unrelated-project";
    if(mismatch==="target")cached.destinationKey="chat:unrelated-target";
    const afterTamper=plain(cached);
    assert.throws(()=>api.finishHandoffTransfer(store,destination,intro,DESTINATION),mismatch);
    assert.deepEqual(plain(store.handoffQueues[source.key]),afterTamper,mismatch);
    assert.equal(destination.schedules.length,0,mismatch);
    assert.equal(source.schedules.length,before.schedules.length,mismatch);
  }
});

test("缓存跨后台重启保留，已拥有新凭证但缓存丢失时不会重建",async()=>{
  const {api,store,source,destination}=receiverFixture();
  const expected=plain(store.handoffQueues[source.key]);
  source.schedules=[];
  await api.saveStore(store);
  assert.deepEqual(plain(store.handoffQueues[source.key]),expected,
    "通用save不能以源规则空数组覆盖独立缓存");
  const restarted=fixture({"cq.state.v2":plain(store)});
  const restored=await restarted.api.readStore();
  assert.deepEqual(plain(restored.handoffQueues[source.key]),expected);
  assert.equal(restored.conversations[destination.key].handoffQueueId,source.handoff.queueId);
  delete restored.handoffQueues[source.key];
  restarted.api.maintainHandoffQueues(restored);
  assert.equal(restored.handoffQueues[source.key],undefined,
    "新版本凭证的缓存丢失必须诊断失败，不能从空源记录猜测重建");
});

test("明确编辑删除通过检查点更新缓存，规则图片在接力期间保持引用",()=>{
  const {api,store,source}=receiverFixture();
  source.schedules[0].text="用户修改后的定时任务";
  source.schedules[0].runCount=3;
  source.schedules.splice(1,1);
  api.checkpointHandoffQueue(store,source);
  const cached=store.handoffQueues[source.key];
  assert.equal(cached.schedules.length,1);
  assert.equal(cached.schedules[0].id,"time-rule-original");
  assert.equal(cached.schedules[0].runCount,3);
  assert.equal(cached.schedules[0].text,"用户修改后的定时任务");
  source.schedules=[];
  assert.equal(api.imageReferences(store).has("rule-image"),true,
    "原会话缺失规则时，缓存必须独立保护IndexedDB中的图片");
});

test("queued阶段仅清理限速时间或缺失部分规则，自动检查点不能删除缓存规则",()=>{
  const {api}=fixture();
  const store=api.blankStore();
  const source=sourceSession(api,store);
  api.enqueueHandoff(store,source,"manual");
  const cached=store.handoffQueues[source.key];
  const expected=plain(cached.schedules);
  const surviving=source.schedules[0];
  source.schedules=[];
  source.countRateTimes=[Date.now()-20*60_000];
  assert.equal(api.dueSchedules(source,Date.now(),100),true,
    "本轮只清理过期限速时间，并未执行规则删除");
  api.checkpointScheduledHandoffQueue(store,source);
  assert.deepEqual(plain(cached.schedules),expected);
  assert.equal(cached.settings.countRateTimes.length,0);

  surviving.nextRunAt=Date.now()-1000;
  source.schedules=[surviving];
  assert.equal(api.dueSchedules(source,Date.now(),100),true);
  api.checkpointScheduledHandoffQueue(store,source);
  assert.equal(cached.schedules.length,2,"自动tick不能把缺失的规则当作用户删除");
  assert.equal(cached.schedules[0].runCount,3,"仍在运行的规则记录新入队次数");
  assert.equal(cached.schedules[1].id,"count-rule-original");
  assert.equal(cached.schedules[1].runCount,7);
});

test("取消只清理同轮缓存，旧接收凭证不能删除其他来源或新一轮缓存",()=>{
  const {api,store,source,destination}=receiverFixture();
  const second=sourceSession(api,store,"chat:second-source",
    "https://chatgpt.com/g/g-p-cache-project/c/second-source",12);
  api.enqueueHandoff(store,second,"manual");
  const other=plain(store.handoffQueues[second.key]);
  api.cancelHandoffTransaction(store,destination,{reviewed:true});
  assert.equal(store.handoffQueues[source.key],undefined);
  assert.deepEqual(plain(store.handoffQueues[second.key]),other);
  assert.equal(source.schedules.length,2,"取消不丢弃原自动规则");

  const cached=store.handoffQueues[second.key];
  const oldSource=plain(second);
  oldSource.handoff.queueId="old-round-queue";
  oldSource.handoff.token="old-round-token";
  api.removeHandoffQueue(store,oldSource);
  assert.equal(store.handoffQueues[second.key],cached,"旧轮次不能清掉新轮次缓存");
});
