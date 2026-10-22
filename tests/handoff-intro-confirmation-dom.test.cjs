"use strict";

// DOM-only source fixture: init is removed and queue wakes are recorded,
// never executed. Expanding an intro must remain a read-only operation.
const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const os=require("node:os");
const {spawnSync}=require("node:child_process");

const browser=process.env.CQ_BROWSER_BIN || (process.platform==="win32"
  ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
  : "/usr/bin/google-chrome");

test("真实 Chrome DOM：接力首条短预览只展开原生正文，完整确认不发送也不改草稿",{
  skip:!fs.existsSync(browser) && "Chrome is not installed",
},()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"cq-handoff-intro-confirmation-"));
  try{
    let content=fs.readFileSync(path.join(__dirname,"..","content.js"),"utf8")
      .replace(/\r\n/g,"\n");
    const start=content.indexOf("  function handoffIntroductionSnapshot() {");
    const stop=content.indexOf("\n  function messageText(",start);
    const end="  void init();\n})();";
    assert.ok(start>=0 && stop>start && content.includes(end),"Intro inspection fixture hooks moved");
    // Keep the fixture file local while the helper sees the actual project
    // conversation route. No ownership check is relaxed in production.
    content=content.slice(0,start)+
      content.slice(start,stop).replaceAll("location.href","window.__testUrl")+
      content.slice(stop);
    content=content.replace(end,`
      requestQueueWake=(delay)=>window.__wakes.push(delay);
      window.__introProbe={
        snapshot:conversationSnapshot,
        inspect:handoffIntroductionSnapshot,
        prime(options={}){
          sessionKey=options.key || "draft:1";
          state={url:options.url || "https://chatgpt.com/g/g-p-fixture/project",
            activeTaskId:"intro",handoffSourceKey:options.source===false?null:"chat:source",
            tasks:[{id:"intro",kind:options.kind || "handoff_intro",status:options.status || "waiting"}],
            schedules:[]};
          composerActionInProgress=options.composer===true;
          workInProgress=options.working===true;
        },
      };
    })();`);
    fs.writeFileSync(path.join(dir,"content.js"),content);
    fs.writeFileSync(path.join(dir,"index.html"),`<!doctype html>
<html><head><meta charset="utf-8"><title>Handoff intro confirmation</title></head>
<body><aside><button id="outside-more">显示更多</button></aside><main>
<div id="conversation"></div><form>
<textarea id="prompt-textarea"></textarea>
<button type="button" id="send" aria-label="Send prompt">发送</button>
<button type="button" aria-label="Start Voice">语音模式</button>
</form></main>
<script>
window.__testUrl="https://chatgpt.com/g/g-p-fixture/c/target-chat";
window.__now=2000000000000;
Date.now=()=>window.__now;
window.__wakes=[];
window.__rpcCalls=[];
window.chrome={runtime:{getManifest(){return {version:"0.99.0"};},
  onMessage:{addListener(){}},async sendMessage(msg){window.__rpcCalls.push(msg.type);throw new Error("Unexpected queue RPC");}},
  storage:{onChanged:{addListener(){}}}};
</script><script src="./content.js"></script>
<script>
(async()=>{
  const checks={};
  const probe=window.__introProbe;
  const conversation=document.querySelector("#conversation");
  const editor=document.querySelector("#prompt-textarea");
  const full="回复 TapTap 帖子。正文中保留显示更多这几个字。"+"目标、关键约束、当前进展和后续步骤。".repeat(28);
  const preview=full.slice(0,76)+"…";
  let clicks=0,otherClicks=0,sends=0,copies=0;
  document.querySelector("#outside-more").addEventListener("click",()=>otherClicks++);
  document.querySelector("#send").addEventListener("click",()=>sends++);
  function setup({async=false,inert=false,extraUser=false}={}){
    window.__now+=10000;
    clicks=0;window.__wakes.length=0;
    conversation.innerHTML=
      '<section data-content-search-unit-key="turn-0:user"><div data-user-message-bubble="true">'+
      '<div data-search-result-target=""></div><button type="button" id="intro-more" aria-expanded="false">显示更多</button>'+
      '<button type="button" aria-label="复制消息" id="copy">复制消息</button></div></section>'+
      '<section data-content-search-unit-key="turn-0:assistant"><div class="markdown">已理解当前任务，请发送后续队列。</div>'+
      '<button type="button" id="assistant-more">显示更多</button></section>';
    const body=conversation.querySelector('[data-search-result-target]');
    body.textContent=preview;
    const more=document.querySelector("#intro-more");
    more.addEventListener("click",()=>{
      clicks++;
      if(inert)return;
      const expand=()=>{body.textContent=full;more.setAttribute("aria-expanded","true");more.textContent="收起";};
      if(async)setTimeout(expand,25);else expand();
    });
    document.querySelector("#assistant-more").addEventListener("click",()=>otherClicks++);
    document.querySelector("#copy").addEventListener("click",()=>copies++);
    if(extraUser){
      const second=document.createElement("section");
      second.setAttribute("data-content-search-unit-key","turn-1:user");
      second.innerHTML='<div data-user-message-bubble="true"><div data-search-result-target>后续用户消息</div><button aria-expanded="false">显示更多</button></div>';
      second.querySelector("button").addEventListener("click",()=>clicks++);
      conversation.append(second);
    }
    editor.value="我尚未发送的编辑草稿";
    probe.prime();
  }
  try{
    setup();
    const before=probe.snapshot();
    checks.nativeShortPreview=before.userCount===1 && before.lastUserFolded===true &&
      before.lastUserText===preview && before.lastUserText.length<160;
    const expanded=probe.inspect();
    checks.syncExpansionGetsFullBody=clicks===1 && expanded.lastUserText===full && !expanded.lastUserFolded;
    checks.controlsNotMixedIntoText=!expanded.lastUserText.includes("复制消息") &&
      !expanded.lastUserText.includes("收起") && expanded.lastUserText.includes("正文中保留显示更多这几个字");
    checks.onlyIntroShowMoreClicked=otherClicks===0 && copies===0 && sends===0;
    checks.editorDraftUntouched=editor.value==="我尚未发送的编辑草稿";
    checks.wakeIsOnlyScheduled=window.__wakes.length===1 && window.__wakes[0]===100 && window.__rpcCalls.length===0;

    setup({async:true});
    const pending=probe.inspect();
    checks.asyncExpansionInitiallyKeepsPreview=pending.lastUserText===preview && clicks===1;
    await new Promise(resolve=>setTimeout(resolve,50));
    const settled=probe.inspect();
    checks.nextTickGetsFullBody=settled.lastUserText===full && !settled.lastUserFolded && clicks===1;
    checks.asyncDraftUntouched=editor.value==="我尚未发送的编辑草稿" && sends===0;

    setup({inert:true});
    probe.inspect();window.__now+=2999;probe.inspect();
    checks.sameControlThrottledFor3Seconds=clicks===1;
    window.__now++;probe.inspect();
    checks.retryAllowedAfter3Seconds=clicks===2 && window.__wakes.length===2;

    for(const [name,options,dom] of [
      ["multipleUsers",{}, {extraUser:true}],
      ["differentProject",{url:"https://chatgpt.com/g/g-p-other/project"},{}],
      ["notHandoff",{source:false},{}],
      ["ordinaryTask",{kind:"message"},{}],
      ["alreadyAdopted",{key:"chat:target-chat"},{}],
      ["composerAction",{composer:true},{}],
      ["queueWork",{working:true},{}],
      ["pendingIntro",{status:"pending"},{}],
    ]){
      setup(dom);probe.prime(options);
      probe.inspect();
      checks[name+"NeverExpanded"]=clicks===0 && window.__wakes.length===0;
    }
    setup();
    document.querySelector("#intro-more").remove();
    probe.inspect();
    checks.otherShowMoreIsNeverFallback=otherClicks===0 && clicks===0;
    checks.inspectionNeverSendsOrCopies=sends===0 && copies===0 && window.__rpcCalls.length===0;
    checks.finalDraftUntouched=editor.value==="我尚未发送的编辑草稿";
  }catch(error){checks.error=error.stack || error.message;}
  checks.ok=Object.values(checks).every(value=>value===true);
  document.body.dataset.result=JSON.stringify(checks);
})();
</script></body></html>`);
    const result=spawnSync(browser,[
      "--headless=new","--disable-gpu","--disable-extensions","--no-first-run",
      `--user-data-dir=${path.join(dir,"profile")}`,
      "--virtual-time-budget=8000","--dump-dom",
      `file:///${path.join(dir,"index.html").replace(/\\/g,"/")}`,
    ],{encoding:"utf8",timeout:30000,maxBuffer:8e6});
    assert.equal(result.status,0,result.stderr || "Chrome failed");
    const match=result.stdout.match(/data-result="([^"]+)"/);
    assert.ok(match,"Handoff intro confirmation fixture did not finish");
    const checks=JSON.parse(match[1].replace(/&quot;/g,'"'));
    assert.equal(checks.ok,true,JSON.stringify(checks));
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
