"use strict";

// Source-only regression fixture: init, wake scheduling and real worker
// dispatch are disabled. Native input and the final Send click stay local.
const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const os=require("node:os");
const {spawnSync}=require("node:child_process");
const browser=process.env.CQ_BROWSER_BIN || (process.platform==="win32"
  ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" : "/usr/bin/google-chrome");

test("真实 Chrome DOM：交接正文单次粘贴与批量兼容输入，异步编辑和发送授权均阻止误发送",{
  skip:!fs.existsSync(browser) && "Chrome is not installed",
},()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"cq-handoff-input-"));
  try{
    let content=fs.readFileSync(path.join(__dirname,"..","content.js"),"utf8").replace(/\r\n/g,"\n");
    const end="  void init();\n})();";
    assert.ok(content.includes(end),"Input fixture init hook moved");
    content=content.replaceAll("location.href","window.__testUrl")
      .replace("  function boundHere() {",
        "  function boundHere() { return true; }\n  function unusedBoundHere() {");
    content=content.replace(end,`
      requestQueueWake=()=>{};
      window.__inputProbe={
        input:insertHandoffText,send:sendTask,scope:captureSendScope,state:()=>state,
        difference:handoffTextDifference,match:handoffTextMatch,
        trusted(editor){recordTrustedHandoffEdit({isTrusted:true,target:editor});},
        prime(id,text,kind="handoff_intro"){
          sessionKey="draft:1";projectVisitId="input-fixture";
          const task={id,text,kind,status:"dispatching",images:[]};
          state={key:sessionKey,url:window.__testUrl,
            handoffSourceKey:kind==="handoff_intro"?"chat:source":null,
            handoffToken:kind==="handoff_intro"?"fixture-token":null,
            handoff:{phase:kind==="handoff_intro"?"bootstrapping":"idle"},
            activeTaskId:id,steeringTaskId:null,halted:false,queuePaused:false,
            tasks:[task],schedules:[],history:[],sendCooldownSeconds:0};
          if(kind==="handoff_intro")rememberHandoffComposer(task,getEditor());
          return task;
        },
      };
    })();`);
    fs.writeFileSync(path.join(dir,"content.js"),content);
    fs.writeFileSync(path.join(dir,"index.html"),`<!doctype html><html><head><meta charset="utf-8"></head>
<body><main><form>
<div id="prompt-textarea" contenteditable="true" role="textbox" style="white-space:pre-wrap;min-height:30px"></div>
<button type="button" id="send" data-testid="send-button" aria-label="Send prompt">发送</button>
<button type="button" aria-label="Start Voice">语音模式</button>
</form></main><script>
window.__testUrl="https://chatgpt.com/g/g-p-fixture/project";
window.__calls=[];window.__events=[];window.__armAllowed=true;window.__mutateOnArm="";
window.chrome={runtime:{getManifest(){return {version:"0.99.0"};},onMessage:{addListener(){}},
 async sendMessage(message){
  window.__calls.push(message);
  const state=window.__inputProbe?.state();
  const task=state?.tasks.find(item=>item.id===message.id);
  if(message.type==="HANDOFF_SEND_READY"){
   window.__events.push("arm");
   if(window.__mutateOnArm){
    const liveEditor=document.querySelector('#prompt-textarea');
    liveEditor.textContent=liveEditor.innerText+window.__mutateOnArm;
   }
  }
  if(message.type==="SENT"){window.__events.push("ack");if(task){task.status="waiting";task.sentAt=Date.now();}}
  if(message.type==="RELEASE_CLAIM" && task){task.status="pending";state.activeTaskId=null;}
  return {ok:true,state,sessionKey:"draft:1",...(message.type==="HANDOFF_SEND_READY"?{sendReady:window.__armAllowed}:{})};
 }},storage:{onChanged:{addListener(){}}}};
</script><script src="content.js"></script><script>
(async()=>{
 const checks={};
 const probe=window.__inputProbe;
 const editor=document.querySelector('#prompt-textarea');
 const send=document.querySelector('#send');
 const originalExec=document.execCommand.bind(document);
 const commands=[];
 let mode="accept",pastes=0,pasted="",pastedHtml="",pasteTypes=[],sent=[],yielded=false,caseId=0;
 const fullText=Array.from({length:220},(_,i)=>"第"+i+"段：目标、约束与下一步。<tag> & 文本").join("\\n");
 const normalize=value=>String(value||"").replace(/\\s+/g," ").trim();
 document.execCommand=(command,ui,value)=>{
  commands.push({command,value});
  return originalExec(command,ui,mode==="ordinaryExtra" && command==="insertText"?value+"XYZ":value);
 };
 editor.addEventListener("paste",event=>{
  pastes++;pasted=event.clipboardData.getData("text/plain");
  pastedHtml=event.clipboardData.getData("text/html");pasteTypes=[...event.clipboardData.types];
  if(mode==="unhandled")return;
  event.preventDefault();
  if(mode==="handledEmpty")return;
  if(mode==="preferHtml"){
   if(pastedHtml){
    const template=document.createElement("template");template.innerHTML=pastedHtml;
    editor.replaceChildren(template.content.cloneNode(true));
   }else editor.textContent=pasted+"XYZ";
  }else editor.textContent=mode==="partial"?pasted.slice(0,80):mode==="extraContent"?pasted+"XYZ"
   :mode==="extra100"?pasted+"X".repeat(100):mode==="extra101"?pasted+"X".repeat(101)
   :mode==="replace"?"X"+pasted.slice(1):mode==="missing"?pasted.slice(1):pasted;
  editor.dispatchEvent(new InputEvent("input",{bubbles:true,inputType:"insertFromPaste",data:pasted}));
  setTimeout(()=>{
   yielded=true;
   if(mode==="userEdit"){
    editor.textContent="用户在粘贴后输入的草稿";
    probe.trusted(editor);
    editor.dispatchEvent(new InputEvent("input",{bubbles:true,data:"用户草稿"}));
   }
   if(mode==="routeChange")window.__testUrl="https://chatgpt.com/g/g-p-other/project";
  },0);
 });
 send.addEventListener("click",()=>{
  window.__events.push("click");sent.push(editor.innerText);editor.replaceChildren();
 });
 function setup(nextMode="accept",kind="handoff_intro",text=fullText){
  mode=nextMode;pastes=0;pasted="";pastedHtml="";pasteTypes=[];sent=[];yielded=false;commands.length=0;
  window.__calls.length=0;window.__events.length=0;window.__armAllowed=true;window.__mutateOnArm="";
  window.__testUrl="https://chatgpt.com/g/g-p-fixture/project";
  editor.replaceChildren();send.disabled=false;
  return probe.prime("input-"+(++caseId),text,kind);
 }
 async function rejectsInput(task){
  try{await probe.input(editor,task,probe.scope());return false;}catch{return true;}
 }
 try{
  let task=setup();
  await probe.input(editor,task,probe.scope());
  checks.pasteIsOneFullTransaction=pastes===1 && pasted===fullText && commands.length===0 &&
   normalize(editor.innerText)===normalize(fullText);
  checks.pasteProvidesBothFlavors=pasteTypes.includes("text/plain") && pasteTypes.includes("text/html");
  checks.pasteHtmlEscapesOriginal=pastedHtml.includes("&lt;tag&gt;") && pastedHtml.includes("&amp;") &&
   pastedHtml.split("<p>").length-1===220;
  checks.pasteYields=yielded;
  checks.measuredInput=window.__calls.some(message=>message.type==="HANDOFF_DEBUG_SIGNAL" &&
   message.event==="input_complete" && message.details?.inputMethod==="paste" &&
   message.details.inputParagraphs===220 && typeof message.details.inputElapsedMs==="number");
  checks.noDebugBody=window.__calls.filter(message=>message.type==="HANDOFF_DEBUG_SIGNAL")
   .every(message=>!JSON.stringify(message.details).includes("目标、约束与下一步") &&
    !Object.hasOwn(message.details,"text") && !Object.hasOwn(message.details,"html"));

  task=setup("preferHtml");
  await probe.input(editor,task,probe.scope());
  checks.nativePasteCanPreferSafeHtml=pastes===1 && commands.length===0 &&
   normalize(editor.innerText)===normalize(fullText) && !editor.querySelector("tag, script");

  const equalDifference=probe.difference("private-diff-body","private-diff-body");
  const contentDifference=probe.difference("private-diff-body","private-diff-bodyXYZ");
  const controlsDifference=probe.difference("private-diff-body","private-diff-body"+String.fromCharCode(0x200b).repeat(3));
  checks.differenceClassifiesCharacters=equalDifference.textDifferenceKind==="equal" &&
   contentDifference.textDifferenceKind==="content" && contentDifference.editorDifferenceChars===3 &&
   contentDifference.expectedDifferenceChars===0 && controlsDifference.textDifferenceKind==="format_controls" &&
   controlsDifference.editorControlChars===3;
  const differenceKeys=new Set(["textDifferenceKind","commonPrefixChars","commonSuffixChars",
   "expectedDifferenceChars","editorDifferenceChars","expectedControlChars","editorControlChars"]);
  checks.differenceMetadataHasNoBody=[equalDifference,contentDifference,controlsDifference].every(value=>
   !JSON.stringify(value).includes("private-diff-body") && Object.entries(value).every(([key,item])=>
    differenceKeys.has(key) && (key==="textDifferenceKind"?typeof item==="string":Number.isInteger(item) && item>=0)));

  const insertedMatch=probe.match("ABC","A1B2C3");
  const maxMatch=probe.match("ABC","ABC"+"X".repeat(100));
  const excessMatch=probe.match("ABC","ABC"+"X".repeat(101));
  checks.toleranceRequiresCompleteOrderedOriginal=insertedMatch.matches && insertedMatch.usedTolerance &&
   insertedMatch.extraChars===3 && maxMatch.matches && maxMatch.extraChars===100 &&
   !excessMatch.matches && !probe.match("ABC","AXC").matches && !probe.match("ABC","AC").matches;

  task=setup("extraContent");
  await probe.input(editor,task,probe.scope());
  checks.threeExtraCharactersAcceptedOnInput=pastes===1 && commands.length===0 &&
   editor.innerText===fullText+"XYZ" && sent.length===0 && probe.match(task.text,editor.innerText).matches;
  task=setup("extraContent");
  await probe.send(task);
  checks.threeExtraCharactersSendOnce=window.__events.join(",")==="arm,click,ack" && sent.length===1 &&
   sent[0]===fullText+"XYZ" && pastes===1 && commands.length===0;
  task=setup("extra100");
  await probe.input(editor,task,probe.scope());
  checks.hundredExtraCharactersAcceptedOnInput=pastes===1 && commands.length===0 &&
   editor.innerText===fullText+"X".repeat(100) && probe.match(task.text,editor.innerText).extraChars===100;
  task=setup("extra100");
  await probe.send(task);
  checks.hundredExtraCharactersSendOnce=window.__events.join(",")==="arm,click,ack" && sent.length===1 &&
   sent[0]===fullText+"X".repeat(100) && pastes===1 && commands.length===0;

  task=setup("extra101");
  checks.hundredAndOneExtraCharactersRejected=await rejectsInput(task) && pastes===1 && commands.length===0 &&
   editor.innerText===fullText+"X".repeat(101) && sent.length===0;
  const mismatch=window.__calls.find(message=>message.type==="HANDOFF_DEBUG_SIGNAL" && message.event==="input_failed");
  checks.inputMismatchHasSafeDifference=mismatch?.details?.textDifferenceKind==="content" &&
   mismatch.details.editorDifferenceChars===101 && mismatch.details.expectedDifferenceChars===0 &&
   !JSON.stringify(mismatch.details).includes("目标、约束与下一步") &&
   !Object.hasOwn(mismatch.details,"text") && !Object.hasOwn(mismatch.details,"html");
  task=setup("replace");
  checks.replacedOriginalStillRejected=await rejectsInput(task) && pastes===1 && commands.length===0 && sent.length===0;
  task=setup("missing");
  checks.missingOriginalStillRejected=await rejectsInput(task) && pastes===1 && commands.length===0 && sent.length===0;

  task=setup("unhandled");
  await probe.input(editor,task,probe.scope());
  const html=commands.filter(command=>command.command==="insertHTML");
  checks.unhandledPasteFallsBackOnce=pastes===1 && html.length===1 && commands.length===1 &&
   normalize(editor.innerText)===normalize(fullText);
  checks.fallbackEscapesText=html[0].value.includes("&lt;tag&gt;") && html[0].value.includes("&amp;") &&
   !editor.querySelector("tag") && html[0].value.split("<p>").length-1===220;

  task=setup("partial");
  checks.partialNeverAppended=await rejectsInput(task) && pastes===1 && commands.length===0 &&
   editor.innerText===fullText.slice(0,80);
  task=setup("handledEmpty");
  checks.handledPendingNeverFallsBack=await rejectsInput(task) && pastes===1 && commands.length===0 && !editor.innerText;
  task=setup("userEdit");
  checks.userEditDuringYieldPreserved=await rejectsInput(task) && commands.length===0 &&
   editor.innerText==="用户在粘贴后输入的草稿";
  task=setup("routeChange");
  checks.routeChangeDuringYieldStops=await rejectsInput(task) && commands.length===0 &&
   normalize(editor.innerText)===normalize(fullText) && sent.length===0;

  task=setup();window.__armAllowed=false;
  await probe.send(task);
  checks.armRefusalNeverClicks=window.__events.join(",")==="arm" && sent.length===0 &&
   normalize(editor.innerText)===normalize(fullText) &&
   !window.__calls.some(message=>message.type==="SENT");
  task=setup();
  await probe.send(task);
  checks.armBeforeSingleClick=window.__events.join(",")==="arm,click,ack" && sent.length===1 &&
   normalize(sent[0])===normalize(fullText) && pastes===1 && commands.length===0;

  task=setup("extraContent");window.__mutateOnArm="Q";
  await probe.send(task);
  checks.toleratedTextIsFrozenAcrossArm=window.__events.join(",")==="arm" && sent.length===0 &&
   editor.innerText===fullText+"XYZQ" && probe.match(task.text,editor.innerText).matches &&
   !window.__calls.some(message=>message.type==="SENT");

  task=setup("unhandled","message","普通任务原有填写方式");
  await probe.send(task);
  checks.ordinaryKeepsInsertText=commands.filter(command=>command.command==="insertText").length===1 &&
   commands.every(command=>command.command!=="insertHTML") && pastes===0 &&
   window.__events.join(",")==="click,ack" && sent[0]===task.text &&
   !window.__calls.some(message=>message.type==="HANDOFF_SEND_READY");

  task=setup("ordinaryExtra","message","普通消息仍然要求完整一致");
  await probe.send(task);
  checks.ordinaryExtraCharactersStayStrict=sent.length===0 && editor.innerText===task.text+"XYZ" &&
   pastes===0 && commands.filter(command=>command.command==="insertText").length===1 &&
   !window.__calls.some(message=>["HANDOFF_SEND_READY","SENT"].includes(message.type));
 }catch(error){checks.error=error.stack||String(error);}
 checks.ok=Object.values(checks).every(value=>value===true);
 document.body.dataset.result=JSON.stringify(checks);
})();
</script></body></html>`);
    const result=spawnSync(browser,["--headless=new","--disable-gpu","--disable-extensions","--no-first-run",
      `--user-data-dir=${path.join(dir,"profile")}`,"--virtual-time-budget=12000","--dump-dom",
      `file:///${path.join(dir,"index.html").replace(/\\/g,"/")}`],
    {encoding:"utf8",timeout:30000,maxBuffer:8e6});
    assert.equal(result.status,0,result.stderr||"Chrome failed");
    const match=result.stdout.match(/data-result="([^"]+)"/);
    assert.ok(match,"Handoff input fixture did not finish");
    const checks=JSON.parse(match[1].replace(/&quot;/g,'"').replace(/&amp;/g,"&"));
    assert.equal(checks.ok,true,JSON.stringify(checks,null,2));
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
