"use strict";

// Isolated fixture source: init never runs, and reload only records a call.
// No real ChatGPT page, queue dispatch, or browser refresh is involved.
const {test} = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const {spawnSync} = require("node:child_process");

const browser = process.env.CQ_BROWSER_BIN || (process.platform === "win32"
  ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
  : "/usr/bin/google-chrome");

test("真实 Chrome DOM：项目加载卡住固定每60秒恢复，保护Sources、消息引用和未发送草稿", {
  skip: !fs.existsSync(browser) && "Chrome is not installed",
}, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cq-project-load-recovery-"));
  try {
    let content = fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8")
      .replace(/\r\n/g, "\n");
    const end = "  void init();\n})();";
    const start = content.indexOf("  function maybeReloadConversationLoadError(");
    const stop = content.indexOf("\n  function extractHandoffReply(", start);
    assert.ok(content.includes(end) && start >= 0 && stop > start,
      "Cannot expose project loading recovery helpers");
    assert.match(content, /function nativeProjectLoadingVisible\(/);
    // Simulate a real project path without navigating the file fixture.
    // Restrict the substitution to recovery's own route read/final recheck.
    content = content.slice(0, start) +
      content.slice(start, stop).replaceAll("location.href", "window.__testUrl") +
      content.slice(stop);
    content = content.replace(end, `
      reloadConversationErrorPage = () => window.__reloads.push(window.__now);
      window.__projectRecovery = {
        detect: () => nativeProjectLoadingVisible(window.__testUrl),
        observe: maybeReloadConversationLoadError,
        state: () => state,
        setFlags(values) {
          queueDraft = values.queueDraft || "";
          composerActionInProgress = values.composerActionInProgress === true;
          workInProgress = values.workInProgress === true;
        },
        setVisit(id) { projectVisitId = id; },
        setInFlight(status) {
          state = {tasks:[{id:"in-flight",status}],activeTaskId:"in-flight"};
        },
      };
    })();`);
    fs.writeFileSync(path.join(dir, "content.js"), content);
    fs.writeFileSync(path.join(dir, "index.html"), `<!doctype html>
<html><head><meta charset="utf-8"><title>Project loading recovery</title>
<style>main{min-height:100px}.animate-spin,[role=progressbar]{display:block;width:32px;height:32px}</style>
</head><body><main></main>
<script>
window.__reloads=[];
window.__now=2000000000000;
window.__online=true;
window.__testUrl="https://chatgpt.com/g/g-p-fixture/project";
Object.defineProperty(navigator,"onLine",{configurable:true,get(){return window.__online;}});
window.chrome={runtime:{getManifest(){return {version:"0.99.0"};},
  onMessage:{addListener(){}},async sendMessage(){throw new Error("Unexpected RPC in isolated fixture");}},
  storage:{onChanged:{addListener(){}}}};
</script>
<script>
(async()=>{
  const checks={};
  const main=document.querySelector("main");
  const projectUrl="https://chatgpt.com/g/g-p-fixture/project";
  const recoveryKey="cq.conversationLoadRecovery.v1:/g/g-p-fixture/project";
  const spinner='<div class="animate-spin" aria-label="Loading"></div>';
  const healthy='<form><textarea id="prompt-textarea"></textarea><button type="button" aria-label="Start Voice">语音模式</button></form>';
  const sources='<h1>项目文件</h1><div role="tablist"><button role="tab">聊天</button><button role="tab" aria-selected="true">来源</button></div><p>上传文件以供项目使用</p>';
  const epoch=2000000000000;
  function observe(at){window.__now=at;return window.__projectRecovery.observe(at);}
  function record(){return JSON.parse(sessionStorage.getItem(recoveryKey)||"null");}
  async function fresh(html,{clear=false,url=projectUrl}={}){
    if(clear)sessionStorage.clear();
    window.__testUrl=url;
    window.__online=true;
    document.querySelector("#cq-extension-root")?.remove();
    document.documentElement.removeAttribute("data-cq-unsaved-draft");
    main.innerHTML=html;
    await new Promise((resolve,reject)=>{
      const script=document.createElement("script");
      script.src="./content.js";
      script.onload=resolve;script.onerror=()=>reject(new Error("Fixture source failed to load"));
      document.body.append(script);
    });
    return window.__projectRecovery;
  }
  try {
    let probe=await fresh(spinner,{clear:true});
    probe.setVisit("same-project-visit");
    checks.projectSpinnerDetected=probe.detect() && probe.state()===null;
    checks.loadingBlocksDispatch=observe(epoch)===true;
    observe(epoch+59999);
    checks.firstAttemptWaits60Seconds=window.__reloads.length===0;
    observe(epoch+60000);
    checks.reloadsStableSpinner=window.__reloads.length===1;
    checks.reloadPreservesVisitMarker=record()?.resumeVisitId==="same-project-visit" &&
      record()?.attempts===1 && record()?.lastAt===epoch+60000;

    // Legacy high retry counts remain metadata: every retry waits one minute.
    sessionStorage.setItem(recoveryKey,JSON.stringify({attempts:500,lastAt:epoch+60000}));
    probe=await fresh(spinner);
    observe(epoch+60000);observe(epoch+119999);
    checks.fixedIntervalSurvivesRefresh=window.__reloads.length===1;
    observe(epoch+120000);
    checks.highAttemptCountDoesNotExtendInterval=window.__reloads.length===2;

    sessionStorage.setItem(recoveryKey,JSON.stringify({attempts:500,lastAt:epoch+180000}));
    probe=await fresh(healthy);
    checks.healthyComposerNotLoading=!probe.detect();
    observe(epoch+180000);observe(epoch+209999);
    checks.healthyRequires30Seconds=record()?.attempts===500;
    observe(epoch+210000);
    checks.healthyResetsPersistedBudget=record()===null;
    main.innerHTML=spinner;
    observe(epoch+210001);observe(epoch+270000);
    checks.healthResetStillRequires60Seconds=window.__reloads.length===2;
    observe(epoch+270001);
    checks.recoveredProjectCanRetryAfter60Seconds=window.__reloads.length===3;

    probe=await fresh(sources,{clear:true});
    checks.sourcesWithoutComposerNotLoading=!probe.detect();
    observe(epoch+600000);observe(epoch+700000);
    checks.sourcesNeverReloaded=window.__reloads.length===3;
    main.innerHTML='<section data-message-author-role="user">'+spinner+'</section>';
    checks.userSpinnerIgnored=!probe.detect();
    main.innerHTML='<section data-message-author-role="assistant"><div class="markdown">'+spinner+'</div></section>';
    checks.assistantSpinnerIgnored=!probe.detect();
    main.innerHTML='<p>项目已加载</p><button>'+spinner+'</button>';
    checks.buttonSpinnerIgnored=!probe.detect();
    main.innerHTML='<p>项目已加载</p><div class="animate-spin" style="display:none"></div>';
    checks.hiddenSpinnerIgnored=!probe.detect();

    probe=await fresh("",{clear:true,url:"https://chatgpt.com/c/existing-chat"});
    checks.chatBlankIsNotProjectLoading=!probe.detect() && observe(epoch+710000)===false;
    observe(epoch+760000);
    checks.chatBlankNeverReloaded=window.__reloads.length===3;

    probe=await fresh(spinner,{clear:true});
    window.__online=false;
    observe(epoch+800000);observe(epoch+860001);
    checks.offlineProtected=window.__reloads.length===3;
    window.__online=true;
    probe.setFlags({queueDraft:"未入队的文字"});
    observe(epoch+870001);
    checks.pluginDraftProtected=window.__reloads.length===3;
    probe.setFlags({composerActionInProgress:true});
    observe(epoch+880001);
    checks.mutationProtected=window.__reloads.length===3;
    probe.setFlags({});
    main.innerHTML=spinner+healthy;
    document.querySelector("#prompt-textarea").value="未发送的原生草稿";
    observe(epoch+890001);observe(epoch+950001);
    checks.nativeDraftProtected=window.__reloads.length===3 &&
      document.querySelector("#prompt-textarea").value==="未发送的原生草稿";

    // A genuinely empty project main also qualifies, unlike a chat route.
    probe=await fresh("",{clear:true});
    checks.projectBlankDetected=probe.detect();
    observe(epoch+1000000);observe(epoch+1059999);
    checks.blankAlsoWaits60Seconds=window.__reloads.length===3;
    observe(epoch+1060000);
    checks.blankProjectRecovers=window.__reloads.length===4;

    for(const status of ["dispatching","waiting","steering","steering_wait"]){
      probe=await fresh(spinner,{clear:true});
      probe.setInFlight(status);
      observe(epoch+1100000);observe(epoch+1160000);
      checks[status+"ProtectedOnProjectUrl"]=window.__reloads.length===4;
    }
  } catch(error) {checks.error=error.stack || error.message;}
  checks.ok=Object.values(checks).every(value=>value===true);
  document.body.dataset.result=JSON.stringify(checks);
})();
</script></body></html>`);
    const result = spawnSync(browser, [
      "--headless=new", "--disable-gpu", "--disable-extensions", "--no-first-run",
      `--user-data-dir=${path.join(dir, "profile")}`,
      "--virtual-time-budget=8000", "--dump-dom",
      `file:///${path.join(dir, "index.html").replace(/\\/g, "/")}`,
    ], {encoding:"utf8",timeout:30000,maxBuffer:8e6});
    assert.equal(result.status,0,result.stderr || "Chrome failed");
    const match=result.stdout.match(/data-result="([^"]+)"/);
    assert.ok(match,"Project loading fixture did not finish");
    const checks=JSON.parse(match[1].replace(/&quot;/g,'"'));
    assert.equal(checks.ok,true,JSON.stringify(checks));
  } finally {
    fs.rmSync(dir,{recursive:true,force:true});
  }
});
