"use strict";

const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const os=require("node:os");
const path=require("node:path");
const {spawnSync}=require("node:child_process");

const browser=process.env.CQ_BROWSER_BIN || (process.platform==="win32"
  ? "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"
  : "/usr/bin/google-chrome");

test("真实 Chromium：后台重绘不能打断图文、自动规则或设置草稿的中文输入法组合态",{
  skip:!fs.existsSync(browser)&&"Chromium is not installed",
},()=>{
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),"cq-ime-draft-"));
  try{
    const source=fs.readFileSync(path.join(__dirname,"..","content.js"),"utf8")
      .replace("  void init();",`  window.__cqImeProbe={
        render,
        openQueue(){queueExpanded=true;queueComposerOpen=true;settingsOpen=false;
          schedulerOpen=false;handoffOpen=false;favoritesOpen=false;render();},
        openSchedule(){queueExpanded=true;queueComposerOpen=false;settingsOpen=false;
          schedulerOpen=true;schedulerView="create";handoffOpen=false;favoritesOpen=false;render();},
        openSettings(){queueExpanded=true;queueComposerOpen=false;settingsOpen=true;
          settingsPage="general";schedulerOpen=false;handoffOpen=false;favoritesOpen=false;render();},
        drafts(){return {queueDraft,scheduleDraft,maxPendingDraft};}
      };
      void init();`);
    fs.writeFileSync(path.join(folder,"content.js"),source);
    fs.copyFileSync(path.join(__dirname,"..","panel.css"),path.join(folder,"panel.css"));
    fs.writeFileSync(path.join(folder,"index.html"),`<!doctype html><html lang="zh">
<head><meta charset="utf-8"><link rel="stylesheet" href="./panel.css"></head><body>
<main><form id="chat"><textarea id="prompt-textarea"></textarea>
 <button type="button" aria-label="Start Voice">Voice</button></form></main>
<script>
const state={key:"draft:1",halted:false,queuePaused:true,tasks:[],schedules:[],
 activeTaskId:null,steeringTaskId:null,history:[],countRateTimes:[]};
window.chrome={runtime:{getManifest(){return {version:"0.49.30"};},
 onMessage:{addListener(){}},async sendMessage(message){
  if(message.type==="GET_FAVORITES")return {ok:true,favorites:[]};
  return {ok:true,state,sessionKey:"draft:1",settings:{maxPending:100,
    defaultIntervalMinutes:30,defaultRepeatCount:-1}};
 }},storage:{onChanged:{addListener(listener){window.__cqStorageListener=listener;}}}};
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const query=id=>document.getElementById(id);
const until=async f=>{for(let i=0;i<90;i++){if(f())return true;await sleep(25);}return false;};
const compose=(field,partial,final)=>{
 field.focus();
 field.dispatchEvent(new CompositionEvent("compositionstart",{bubbles:true,data:""}));
 field.value=partial;
 field.dispatchEvent(new InputEvent("input",{bubbles:true,isComposing:true,
   inputType:"insertCompositionText",data:partial}));
 // This is the real route by which background writes currently recreate
 // the entire queue panel. It must not destroy an active IME editor.
 window.__cqStorageListener?.({"cq.state.v2":{newValue:{
   conversations:{"draft:1":state}
 }}}, "local");
 window.__cqImeProbe.render();
 const stable=field.isConnected&&document.activeElement===field&&
   field.value===partial&&document.querySelector("#cq-extension-root").contains(field);
 const blockedRefresh=query(field.id)===field;
 field.value=final;
 field.dispatchEvent(new CompositionEvent("compositionend",{bubbles:true,data:final}));
 field.dispatchEvent(new InputEvent("input",{bubbles:true,inputType:"insertText",data:final}));
 return {stable,blockedRefresh};
};
</script><script src="./content.js"></script><script>
setTimeout(async()=>{
 const flags={};
 try{
  flags.ready=await until(()=>Boolean(window.__cqImeProbe&&
    document.querySelector("#cq-extension-root .cq-inline")));
  const probe=window.__cqImeProbe;
  probe.openQueue();
  const queue=query("cq-queue-draft");
  flags.queueEditorFound=!!queue;
  const first=compose(queue,"zhuanhuan","转换后的中文草稿");
  flags.queueStableDuringIme=first.stable&&first.blockedRefresh;
  flags.queueDraftMarkedUnsafe=document.documentElement.dataset.cqUnsavedDraft==="true";
  await sleep(90);
  flags.queueCommitted=query("cq-queue-draft")?.value==="转换后的中文草稿"&&
    probe.drafts().queueDraft==="转换后的中文草稿";

  probe.openSchedule();
  const schedule=query("cq-schedule-draft");
  flags.scheduleEditorFound=!!schedule;
  const second=compose(schedule,"jiaohuan","定时任务中文正文");
  flags.scheduleStableDuringIme=second.stable&&second.blockedRefresh;
  await sleep(90);
  flags.scheduleCommitted=query("cq-schedule-draft")?.value==="定时任务中文正文"&&
    probe.drafts().scheduleDraft==="定时任务中文正文";

  probe.openSettings();
  const settings=query("cq-max-pending");
  flags.settingsEditorFound=!!settings;
  const third=compose(settings,"1","18");
  flags.settingsStableDuringIme=third.stable&&third.blockedRefresh;
  await sleep(90);
  flags.settingsCommitted=query("cq-max-pending")?.value==="18"&&
    probe.drafts().maxPendingDraft==="18";

  // Browsers sometimes cancel an IME on blur without compositionend.
  const fallback=query("cq-default-minutes");
  fallback.focus();
  fallback.dispatchEvent(new CompositionEvent("compositionstart",{bubbles:true}));
  fallback.value="42";
  fallback.dispatchEvent(new InputEvent("input",{bubbles:true,isComposing:true}));
  probe.render();
  flags.blurStillHasOriginalEditor=query("cq-default-minutes")===fallback;
  fallback.dispatchEvent(new FocusEvent("focusout",{bubbles:true}));
  await sleep(90);
  flags.blurReleasesPendingRender=query("cq-default-minutes")!==fallback&&
    query("cq-default-minutes")?.value==="42";
 }catch(error){flags.error=error.stack||String(error);}
 flags.ok=["ready","queueEditorFound","queueStableDuringIme",
   "queueDraftMarkedUnsafe","queueCommitted",
   "scheduleEditorFound","scheduleStableDuringIme","scheduleCommitted",
   "settingsEditorFound","settingsStableDuringIme","settingsCommitted",
   "blurStillHasOriginalEditor","blurReleasesPendingRender"]
   .every(key=>flags[key]===true);
 document.body.dataset.imeTest=JSON.stringify(flags);
},200);
</script></body></html>`);
    const result=spawnSync(browser,[
      "--headless=new","--disable-gpu","--disable-extensions","--no-first-run",
      "--disable-default-apps","--disable-background-networking",
      "--no-default-browser-check",
      `--user-data-dir=${path.join(folder,"profile")}`,
      "--virtual-time-budget=9000","--dump-dom",
      `file:///${path.join(folder,"index.html").replace(/\\/g,"/")}`,
    ],{encoding:"utf8",timeout:30000,maxBuffer:8e6});
    assert.equal(result.status,0,result.stderr||"Browser failed");
    const marker=result.stdout.match(/data-ime-test="([^"]+)"/);
    assert.ok(marker,"IME test did not finish");
    const flags=JSON.parse(marker[1].replace(/&quot;/g,'"').replace(/&amp;/g,"&"));
    assert.equal(flags.ok,true,JSON.stringify(flags,null,2));
  }finally{
    try {
      fs.rmSync(folder,{recursive:true,force:true,maxRetries:16,retryDelay:300});
    } catch(error) {
      // Edge sometimes keeps a test profile locked briefly after a forced
      // headless shutdown. Do not mask the *actual* assertion or browser
      // failure with a secondary Windows cleanup EPERM.
      if (!["EPERM","EBUSY","EACCES"].includes(error.code)) throw error;
      console.warn("Chromium 尚未释放测试临时目录：",folder);
    }
  }
});
