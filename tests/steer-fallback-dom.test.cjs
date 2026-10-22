"use strict";

// Synthetic composer regression: no ChatGPT server, only a local file page.
const {test} = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {spawnSync} = require("node:child_process");
const browser = process.env.CQ_BROWSER_BIN || (process.platform === "win32"
  ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
  : "/usr/bin/google-chrome");

test("队列引导优先直接发送；不可用时停止一次再发送并确认新回复", {
  skip: !fs.existsSync(browser) && "Chromium is not installed",
}, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cq-steer-fallback-"));
  try {
    const source = fs.readFileSync(path.join(__dirname,"..","content.js"),"utf8")
      .replace(/\r\n/g,"\n");
    const end = "  void init();\n})();";
    assert.ok(source.includes(end), "Expected initialization boundary");
    assert.ok(source.includes("  function boundHere() {"));
    assert.ok(source.includes("  function render() {"));
    // Exercise real editor/Send/Stop/confirmation logic, without autonomous
    // heartbeat actions or panel rendering changing the controlled scenario.
    fs.writeFileSync(path.join(dir,"content.js"),source
      .replace("  function boundHere() {", "  function boundHere() { return true; }\n  function originalBoundHere() {")
      .replace("  function render() {", "  function render() { return; }\n  function originalRender() {")
      .replace(end, `  state = window.fixture.state;
  sessionKey = state.key;
  window.steerFixture = {
    steer: steerQueuedTask,
    confirm: async () => {
      const task = state.tasks.find(item => item.id === state.steeringTaskId);
      return task ? confirmSteeredTask(task, conversationSnapshot()) : false;
    },
    reset() {
      state = window.fixture.state; sessionKey = state.key; steeringProbe = null;
      composerActionInProgress = false; workInProgress = false;
    },
  };
})();`));
    fs.writeFileSync(path.join(dir,"index.html"),`<!doctype html>
<html><head><meta charset="utf-8"></head><body><main>
<div id="conversation"></div><div id="composer-host"></div></main><script>
const fixture = window.fixture = {
  state:{key:"draft:1",halted:false,activeTaskId:null,steeringTaskId:null,
    tasks:[],schedules:[],history:[],countRateTimes:[],queuePaused:false},
  calls:[],sends:[],stops:0,options:{},editor:null,send:null,stop:null,
};
function addTurn(role,id,text) {
  const turn=document.createElement("div");
  turn.dataset.messageAuthorRole=role; turn.dataset.messageId=id;
  const node=document.createElement("div");
  if(role==="user")node.dataset.testid="user-message";
  else node.className="markdown";
  node.textContent=text;turn.append(node);
  document.getElementById("conversation").append(turn);
}
const nativeExecCommand=document.execCommand.bind(document);
function compose() {
  const form=document.createElement("form");
  form.innerHTML=(fixture.options.failInitialWrite
    ? '<div id="prompt-textarea" contenteditable="true"></div>'
    : '<textarea id="prompt-textarea"></textarea>')+
    '<button type="button" id="send" data-testid="send-button" aria-label="Send prompt">Send</button>'+
    '<button type="button" id="stop" data-testid="stop-button" aria-label="Stop generating">Stop</button>'+
    '<button type="button" id="voice" aria-label="Start Voice" style="display:none">Voice</button>';
  document.getElementById("composer-host").replaceChildren(form);
  const editor=fixture.editor=form.querySelector("#prompt-textarea");
  // Reuse the small textarea fixture for rich-text insertion failures too.
  if(editor.isContentEditable)Object.defineProperty(editor,"value",{
    get(){return this.textContent;},set(value){this.textContent=value;},
  });
  const send=fixture.send=form.querySelector("#send");
  const stop=fixture.stop=form.querySelector("#stop");
  const sendFieldset=document.createElement("fieldset");
  if(fixture.options.fieldsetDisabledSend){
    send.before(sendFieldset);sendFieldset.append(send);
  }
  editor.readOnly=fixture.options.readOnlyDuringGeneration===true;
  let busy=true;
  document.execCommand=(command,...args)=>{
    // Simulate a native rich editor rejecting a write without changing its
    // contents. Stop restores normal editing; no private draft is discarded.
    if(command==="insertText"&&fixture.options.failInitialWrite&&busy)return false;
    return nativeExecCommand(command,...args);
  };
  const update=()=>{
    send.style.display=editor.value.trim()&&(!busy||fixture.options.direct)?"":"none";
    if(fixture.options.ariaDisabledSend)send.setAttribute("aria-disabled",String(busy));
    sendFieldset.disabled=busy&&fixture.options.fieldsetDisabledSend===true;
    stop.style.display=busy?"":"none";
    form.querySelector("#voice").style.display=!busy&&!editor.value.trim()?"":"none";
  };
  editor.addEventListener("input",update);
  stop.addEventListener("click",()=>{
    fixture.stops++;
    if(fixture.options.failedStop)return;
    busy=false;
    editor.readOnly=false;
    if(fixture.options.replaceEditor){
      const replacement=document.createElement("textarea");
      replacement.id="prompt-textarea";replacement.value="新输入框中的私人草稿";
      editor.replaceWith(replacement);fixture.editor=replacement;
    }else if(fixture.options.editDuringPause){
      editor.value="用户在停止期间输入的私人草稿";
      editor.dispatchEvent(new InputEvent("input",{bubbles:true,inputType:"insertText"}));
    }else if(fixture.options.resetDuringPause){
      editor.value="";
      editor.dispatchEvent(new InputEvent("input",{bubbles:true,inputType:"deleteContentBackward"}));
    }else if(fixture.options.beforeInputDuringPause){
      // Even an edit that leaves identical text must invalidate ownership.
      editor.dispatchEvent(new InputEvent("beforeinput",{bubbles:true,
        cancelable:true,inputType:"insertText",data:""}));
    }
    update();
  });
  send.addEventListener("click",()=>{
    if(send.getAttribute("aria-disabled")==="true"||send.matches(":disabled"))return;
    fixture.sends.push(editor.value);addTurn("user","u1",editor.value);editor.value="";
    busy=fixture.options.continueReply!==false;
    if(busy)addTurn("assistant","a1","收到补充指令，继续执行当前任务。");
    update();
  });
  update();
}
function reset(options={}) {
  fixture.calls=[];fixture.sends=[];fixture.stops=0;fixture.options=options;
  Object.assign(fixture.state,{halted:false,haltReason:null,activeTaskId:"running",
    steeringTaskId:null,queuePaused:false,
    tasks:[{id:"running",text:"正在执行的原任务",status:"waiting",images:[]},
      {id:"guide",text:"补充指令：保留原任务并调整处理方式",status:"pending",images:[]}]});
  document.getElementById("conversation").replaceChildren();
  addTurn("user","u0","正在执行的原任务");addTurn("assistant","a0","先前回复正在进行中");
  compose();if(window.steerFixture)window.steerFixture.reset();
}
reset();
window.chrome={runtime:{getManifest(){return {version:"test"};},onMessage:{addListener(){}},
  async sendMessage(message){
    fixture.calls.push({...message});
    const state=fixture.state,task=state.tasks.find(item=>item.id===message.id);
    let dispatch;
    if(message.type==="STEER_CLAIM"&&task){
      state.steeringTaskId=task.id;task.status="steering";
      task.steerBaselineUserCount=message.userCount;task.steerBaselineUserId=message.lastUserId;
      dispatch={id:task.id,text:task.text,needsPause:message.busy===true};
    }
    if(message.type==="STEER_PAUSING"&&task){
      task.steerPauseRequestedAt=Date.now();
      task.steerPauseAssistantCount=message.assistantCount;
      task.steerPauseAssistantId=message.lastAssistantId;
    }
    if(message.type==="STEER_CLICKED"&&task)task.status="steering_wait";
    if(message.type==="STEER_CANCEL"&&task){task.status="pending";state.steeringTaskId=null;}
    if(message.type==="STEER_CONFIRM"&&task){
      // The worker also needs new-generation proof after a Stop fallback.
      if(!task.steerPauseRequestedAt||message.continuationObserved===true){
        state.tasks.splice(state.tasks.indexOf(task),1);state.steeringTaskId=null;
      }
    }
    return {ok:true,state,sessionKey:state.key,dispatch};
  }},storage:{onChanged:{addListener(){}}}};
</script><script src="content.js"></script><script>
(async()=>{
  const flags={},h=window.steerFixture;
  const count=type=>fixture.calls.filter(call=>call.type===type).length;
  const selected=()=>fixture.state.tasks.find(task=>task.id==="guide");
  const invoke=()=>h.steer("guide").then(()=>"",error=>String(error.message||error));
  try{
    reset({direct:true});await invoke();await h.confirm();
    flags.directSendFirst=fixture.sends.length===1&&fixture.stops===0&&
      count("STEER_PAUSING")===0&&count("STEER_CONFIRM")===1;
    flags.directSelectedRemoved=!selected();
    flags.directRunningPreserved=fixture.state.tasks.some(task=>task.id==="running");

    for(const disabled of ["ariaDisabledSend","fieldsetDisabledSend"]){
      reset({direct:true,[disabled]:true});await invoke();await h.confirm();
      const actions=fixture.calls.map(call=>call.type);
      flags[disabled+"FallsBack"]=fixture.stops===1&&fixture.sends.length===1&&
        count("STEER_PAUSING")===1&&!selected()&&
        actions.indexOf("STEER_PAUSING")<actions.indexOf("STEER_CLICKED");
    }

    reset({failInitialWrite:true});await invoke();await h.confirm();
    flags.failedEmptyRichWriteFallsBack=fixture.stops===1&&fixture.sends.length===1&&
      count("STEER_PAUSING")===1&&count("STEER_CLICKED")===1&&!selected();

    reset({resetDuringPause:true});await invoke();await h.confirm();
    flags.nativeEmptyResetContinues=fixture.stops===1&&fixture.sends.length===1&&
      fixture.sends[0]==="补充指令：保留原任务并调整处理方式"&&!selected();

    reset({beforeInputDuringPause:true});await invoke();
    flags.beforeInputAlwaysCancels=fixture.stops===1&&fixture.sends.length===0&&
      count("STEER_CLICKED")===0&&count("STEER_CANCEL")===1&&selected()?.status==="pending";

    reset();await invoke();await h.confirm();
    const ordered=fixture.calls.map(call=>call.type);
    const confirmed=fixture.calls.find(call=>call.type==="STEER_CONFIRM");
    flags.stopOnceSendOnce=fixture.stops===1&&fixture.sends.length===1;
    flags.persistPauseBeforeSend=ordered.indexOf("STEER_PAUSING")>=0&&
      ordered.indexOf("STEER_PAUSING")<ordered.indexOf("STEER_CLICKED");
    flags.continuationProof=!!confirmed&&confirmed.continuationObserved===true&&
      confirmed.userCount===2&&confirmed.lastUserId==="u1";
    flags.fallbackSelectedRemoved=!selected();
    flags.originalNotResent=fixture.sends.every(text=>text!=="正在执行的原任务");

    reset({readOnlyDuringGeneration:true});await invoke();await h.confirm();
    flags.readonlyComposerFallback=fixture.stops===1&&fixture.sends.length===1&&
      count("STEER_PAUSING")===1&&!selected()&&fixture.editor.readOnly===false;

    reset({continueReply:false});await invoke();await h.confirm();await h.confirm();
    flags.deliveryAloneNotConfirmed=count("STEER_CONFIRM")===0&&
      selected()?.status==="steering_wait"&&fixture.state.steeringTaskId==="guide";
    flags.unconfirmedNotResent=fixture.sends.length===1&&fixture.stops===1;
    document.querySelector('[data-message-id="a0"] .markdown').textContent+="旧输出晚到片段";
    await h.confirm();flags.oldOutputNotContinuation=count("STEER_CONFIRM")===0;
    addTurn("assistant","a1","新的回复开始了");fixture.stop.style.display="";
    await h.confirm();
    flags.laterContinuationConfirms=count("STEER_CONFIRM")===1&&!selected()&&fixture.sends.length===1;

    reset({failedStop:true});const stoppedError=await invoke();
    flags.failedStopKeepsTask=!!stoppedError&&fixture.stops===1&&fixture.sends.length===0&&
      selected()?.status==="pending"&&count("STEER_CANCEL")===1;

    reset({replaceEditor:true});await invoke();
    flags.replacedEditorNotSent=fixture.sends.length===0&&selected()?.status==="pending";
    flags.replacedDraftPreserved=fixture.editor.value==="新输入框中的私人草稿";

    reset({editDuringPause:true});await invoke();
    flags.pauseDraftNotSent=fixture.sends.length===0&&selected()?.status==="pending";
    flags.pauseDraftPreserved=fixture.editor.value==="用户在停止期间输入的私人草稿";

    reset();fixture.editor.value="引导之前已经有的私人草稿";
    fixture.editor.dispatchEvent(new Event("input",{bubbles:true}));await invoke();
    flags.initialDraftNoActions=fixture.stops===0&&fixture.sends.length===0&&
      count("STEER_CLAIM")===0&&selected()?.status==="pending";
    flags.initialDraftPreserved=fixture.editor.value==="引导之前已经有的私人草稿";
    flags.ok=Object.values(flags).every(value=>value===true);
  }catch(error){flags.ok=false;flags.error=String(error.stack||error);}
  document.documentElement.dataset.steerFallback=JSON.stringify(flags);
})();
</script></body></html>`);
    const run=spawnSync(browser,["--headless=new","--disable-gpu","--disable-extensions","--no-first-run",
      `--user-data-dir=${path.join(dir,"profile")}`,"--virtual-time-budget=120000","--dump-dom",
      `file:///${path.join(dir,"index.html").replace(/\\/g,"/")}`],
    {encoding:"utf8",timeout:45000,maxBuffer:8e6});
    assert.equal(run.status,0,run.stderr||"Chromium failed");
    const match=run.stdout.match(/data-steer-fallback="([^"]+)"/);
    assert.ok(match,"DOM scenario did not finish");
    const flags=JSON.parse(match[1].replace(/&quot;/g,'"').replace(/&amp;/g,"&"));
    assert.equal(flags.ok,true,JSON.stringify(flags));
    for(const [name,value] of Object.entries(flags))assert.equal(value,true,name);
  }finally{
    fs.rmSync(dir,{recursive:true,force:true,maxRetries:12,retryDelay:250});
  }
});
