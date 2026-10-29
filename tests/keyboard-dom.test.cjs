"use strict";

const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const os=require("node:os");
const path=require("node:path");
const {spawnSync}=require("node:child_process");

const browser=process.env.CQ_BROWSER_BIN || (process.platform==="win32"
  ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" : "/usr/bin/google-chrome");

test("真实 Chromium：Enter 始终原生发送，Ctrl/Cmd+Enter 即时发送，只有插件按钮入队",{
  skip:!fs.existsSync(browser)&&"Chrome/Edge is not installed",
},()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"cq-native-keyboard-"));
  try {
    let script=fs.readFileSync(path.join(__dirname,"..","content.js"),"utf8");
    script=script.replace("  function boundHere() {",
      "  function boundHere() { return true; }\n  function oldBoundHereForTest() {");
    assert.ok(script.includes("function oldBoundHereForTest"));
    fs.writeFileSync(path.join(dir,"content.js"),script);
    fs.copyFileSync(path.join(__dirname,"..","panel.css"),path.join(dir,"panel.css"));
    fs.writeFileSync(path.join(dir,"index.html"),`<!doctype html><html lang="zh">
<head><meta charset="utf-8"><link rel="stylesheet" href="./panel.css"></head>
<body><main><section id="conversation"><div data-message-author-role="assistant"
  data-message-id="old-answer"><div data-message-content>旧回复</div></div></section>
  <form id="composer"><textarea id="prompt-textarea"></textarea>
  <button type="button" id="send-button" data-testid="send-button" aria-label="Send">↑</button></form>
</main><script>
const editor=document.querySelector("#prompt-textarea");
const sendButton=document.querySelector("#send-button");
const conversation=document.querySelector("#conversation");
const sent=[],requests=[];
let nativeCount=0,pickerSelected=0;
const state={key:"chat:demo",url:"https://chatgpt.com/c/demo",tabId:1,
  tasks:[],schedules:[],activeTaskId:null,steeringTaskId:null,
  halted:false,queuePaused:false,autoOpenTab:false};
sendButton.addEventListener("click",()=>{
  sent.push(editor.value);
  const turn=document.createElement("div");
  turn.setAttribute("data-message-author-role","user");
  turn.setAttribute("data-message-id","user-"+sent.length);
  turn.innerHTML="<div data-message-content></div>";
  turn.firstElementChild.textContent=editor.value;
  conversation.append(turn);
  editor.value="";
});
editor.addEventListener("keydown",event=>{
  if(event.key!=="Enter" || event.shiftKey || event.altKey || event.ctrlKey ||
      event.metaKey || event.isComposing || event.keyCode===229 ||
      event.defaultPrevented) return;
  const picker=document.querySelector("#picker");
  if(picker && picker.getClientRects().length &&
      !picker.closest('[hidden], [inert], [aria-hidden="true"]') &&
      getComputedStyle(picker).visibility==="visible" &&
      Number(getComputedStyle(picker).opacity)>0){
    pickerSelected++;return;
  }
  nativeCount++;
  if(editor.value.trim()) sendButton.click();
});
window.chrome={
  runtime:{onMessage:{addListener(){}},getManifest(){return {version:"0.49.70"};},
    async sendMessage(message){
      requests.push(message);
      if(message.type==="ENQUEUE")state.tasks.push({
        id:"queued-"+(state.tasks.length+1),status:"pending",text:message.text});
      let dispatch;
      if(message.type==="STEER_PROMPT_CLAIM"){
        const task={id:"shortcut-guide",status:"steering",text:message.text,
          steerFromComposer:true,steerBaselineUserCount:message.userCount,
          steerBaselineUserId:message.lastUserId};
        state.tasks.push(task);state.steeringTaskId=task.id;
        dispatch={id:task.id,text:task.text,needsPause:true};
      }
      if(message.type==="STEER_CLICKED"){
        const task=state.tasks.find(t=>t.id===message.id);
        if(task)task.status="steering_wait";
      }
      if(message.type==="STEER_CONFIRM"){
        state.tasks=state.tasks.filter(t=>t.id!==message.id);
        state.steeringTaskId=null;
      }
      return {ok:true,state,sessionKey:"chat:demo",dispatch,settings:{
        maxPending:100,protectBackground:true,defaultIntervalMinutes:30,
        defaultRepeatCount:-1}};
    }},
  storage:{onChanged:{addListener(){}}},
};
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const press=(options={})=>{
  const event=new KeyboardEvent("keydown",{key:"Enter",bubbles:true,
    cancelable:true,...options});
  editor.dispatchEvent(event);
  return event.defaultPrevented;
};
</script><script src="./content.js"></script><script>
setTimeout(async()=>{
  const flags={};
  try{
    flags.queueButtonVisible=!!document.querySelector('[data-action="queue-composer"]');
    flags.queueHint=document.querySelector(".cq-empty")?.textContent.includes("点击底部") &&
      !document.querySelector(".cq-empty")?.textContent.includes("按 Enter 入队");
    editor.value="第一条普通发送";
    flags.firstNative=!press() && sent.length===1 &&
      sent[0]==="第一条普通发送" && state.tasks.length===0;
    editor.value="旧对话第二条也原生发送";
    flags.secondNative=!press() && sent.length===2 &&
      sent[1]==="旧对话第二条也原生发送" && state.tasks.length===0;

    editor.value="只点击入队按钮";
    document.querySelector('[data-action="queue-composer"]').click();
    await wait(140);
    flags.buttonQueues=state.tasks.length===1 &&
      state.tasks[0].text==="只点击入队按钮" && editor.value==="" &&
      sent.length===2;
    editor.value="队列非空时 Enter 仍直接发";
    flags.nativeWithQueue=!press() && sent.length===3 &&
      sent[2]==="队列非空时 Enter 仍直接发" && state.tasks.length===1;

    editor.value="Ctrl 直接发送";
    flags.ctrlPrevented=press({ctrlKey:true});
    await wait(550);
    flags.ctrlSent=sent.length===4 && sent[3]==="Ctrl 直接发送" &&
      state.tasks.length===1 && editor.value==="";
    editor.value="Cmd 直接发送";
    flags.cmdPrevented=press({metaKey:true});
    await wait(550);
    flags.cmdSent=sent.length===5 && sent[4]==="Cmd 直接发送" &&
      state.tasks.length===1;

    editor.value="Shift 换行";const before=sent.length;
    flags.shiftNative=!press({shiftKey:true}) && editor.value==="Shift 换行" &&
      sent.length===before;
    flags.imeNative=!press({isComposing:true}) && sent.length===before;
    flags.altNative=!press({altKey:true}) && sent.length===before;

    const picker=document.createElement("div");picker.id="picker";
    picker.setAttribute("role","listbox");picker.textContent="选择 slash 命令";
    document.body.append(picker);
    editor.value="候选菜单";const beforePicker=sent.length;
    flags.pickerNative=!press() && pickerSelected===1 && sent.length===beforePicker;
    picker.setAttribute("aria-hidden","true");
    editor.value="隐藏候选框应该直接发送";
    flags.hiddenPickerNative=!press() &&
      sent.at(-1)==="隐藏候选框应该直接发送" && state.tasks.length===1;
    picker.remove();
    const unrelated=document.createElement("aside");
    unrelated.innerHTML='<div role="listbox">侧栏菜单</div>';
    document.body.append(unrelated);
    editor.value="无关菜单不拦 Enter";
    flags.unrelatedNative=!press() && sent.at(-1)==="无关菜单不拦 Enter";
    unrelated.remove();

    editor.value="Ctrl 连按重复事件不发第二次";
    flags.ctrlRepeatPrevented=press({ctrlKey:true,repeat:true});
    await wait(80);
    flags.ctrlRepeatIgnored=editor.value==="Ctrl 连按重复事件不发第二次" &&
      state.tasks.length===1;

    sendButton.style.display="none";
    editor.value="不可发送时 Ctrl 不入队";
    flags.unavailableCtrl=press({ctrlKey:true});
    await wait(90);
    flags.unavailablePreservesDraft=editor.value==="不可发送时 Ctrl 不入队" &&
      state.tasks.length===1;
    sendButton.style.display="";
    editor.value="原生按钮仍可发送";sendButton.click();
    flags.nativeButtonWorks=sent.at(-1)==="原生按钮仍可发送";

    const stop=document.createElement("button");
    stop.type="button";stop.dataset.testid="stop-button";
    stop.setAttribute("aria-label","Stop generating");stop.textContent="Stop";
    document.querySelector("#composer").append(stop);
    state.activeTaskId=state.tasks[0].id;
    state.tasks[0].status="waiting";
    const beforeBusy=requests.length;
    editor.value="生成期间 Ctrl 只引导不入队";
    flags.busyCtrl=press({ctrlKey:true});
    await wait(600);
    const busyRequests=requests.slice(beforeBusy);
    flags.busySteer=busyRequests.some(r=>r.type==="STEER_PROMPT_CLAIM") &&
      !busyRequests.some(r=>r.type==="ENQUEUE") &&
      sent.at(-1)==="生成期间 Ctrl 只引导不入队";
    flags.queueIntact=state.tasks.length===1;
    stop.remove();
    state.activeTaskId=null;
    state.tasks[0].status="pending";

    flags.onlyOneEnqueue=requests.filter(r=>r.type==="ENQUEUE").length===1;
    flags.allShortcutTipsCorrect=!document.querySelector(".cq-shortcuts");
  }catch(error){flags.error=error.stack||String(error);}
  flags.ok=["queueButtonVisible","queueHint","firstNative","secondNative",
    "buttonQueues","nativeWithQueue","ctrlPrevented","ctrlSent",
    "cmdPrevented","cmdSent","shiftNative","imeNative","altNative",
    "pickerNative","hiddenPickerNative","unrelatedNative",
    "ctrlRepeatPrevented","ctrlRepeatIgnored","unavailableCtrl",
    "unavailablePreservesDraft","nativeButtonWorks","busyCtrl",
    "busySteer","queueIntact","onlyOneEnqueue","allShortcutTipsCorrect"]
    .every(k=>flags[k]===true);
  document.body.dataset.keyboard=JSON.stringify(flags);
},300);
</script></body></html>`);
    const run=spawnSync(browser,[
      "--headless=new","--disable-gpu","--disable-extensions","--no-first-run",
      `--user-data-dir=${path.join(dir,"profile")}`,
      "--virtual-time-budget=9000","--dump-dom",
      `file:///${path.join(dir,"index.html").replace(/\\/g,"/")}`,
    ],{encoding:"utf8",timeout:35000,maxBuffer:8e6});
    assert.equal(run.status,0,run.stderr||"Chromium did not start");
    const match=run.stdout.match(/data-keyboard="([^"]+)"/);
    assert.ok(match,"Chromium did not finish keyboard smoke check");
    const flags=JSON.parse(match[1].replace(/&quot;/g,'"').replace(/&amp;/g,"&"));
    assert.equal(flags.ok,true,JSON.stringify(flags,null,2));
  }finally{fs.rmSync(dir,{recursive:true,force:true,maxRetries:12,retryDelay:250});}
});
