"use strict";

// The guardian runs without chrome/runtime or the queue content script.
// Reload is intercepted; this fixture never navigates a real browser tab.
const {test} = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const {spawnSync} = require("node:child_process");

const browser = process.env.CQ_BROWSER_BIN || (process.platform === "win32"
  ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
  : "/usr/bin/google-chrome");

test("真实 Chrome DOM：独立守护无main加载错误，固定60秒刷新、跨刷新限频与草稿安全门", {
  skip: !fs.existsSync(browser) && "Chrome is not installed",
}, () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"cq-recovery-guardian-"));
  try {
    let source=fs.readFileSync(path.join(__dirname,"..","load-recovery.js"),"utf8")
      .replace(/\r\n/g,"\n");
    const locationHelper="function currentUrl() { return location.href; }";
    const reloadHelper="function reloadErrorPage() { location.reload(); }";
    assert.ok(source.includes(locationHelper) && source.includes(reloadHelper),
      "Guardian location/reload fixture hooks moved");
    source=source.replace(locationHelper,"function currentUrl() { return window.__testUrl; }")
      .replace(reloadHelper,"function reloadErrorPage() { window.__reloads.push(window.__now); }");
    fs.writeFileSync(path.join(dir,"guardian.js"),source);
    fs.writeFileSync(path.join(dir,"index.html"),`<!doctype html>
<html><head><meta charset="utf-8"><title>Independent load recovery guardian</title>
<style>#fixture{min-height:100px}button{min-width:24px;min-height:24px}</style></head>
<body><div id="fixture"></div>
<script>
window.__now=2000000000000;
window.__testUrl="https://chatgpt.com/c/fixture";
window.__reloads=[];
window.__online=true;
window.__timersCreated=0;
window.__timersCleared=0;
Date.now=()=>window.__now;
window.setInterval=()=>++window.__timersCreated;
window.clearInterval=()=>window.__timersCleared++;
Object.defineProperty(navigator,"onLine",{configurable:true,get(){return window.__online;}});
// Deliberately do not define window.chrome or any extension API mock.
</script>
<script>
(async()=>{
  const checks={};
  const host=document.querySelector("#fixture");
  const url="https://chatgpt.com/c/fixture";
  const key="cq.conversationLoadRecovery.v1:/c/fixture";
  const epoch=2000000000000;
  const error='<div id="native-error"><h2>无法加载此 ChatGPT 对话</h2><button type="button">重试</button></div>';
  const healthy='<form><textarea id="prompt-textarea"></textarea><button aria-label="Start Voice">语音模式</button></form>';
  const guardian=()=>window.__cqLoadRecoveryGuardian;
  const scan=at=>{window.__now=at;return guardian().scan(at);};
  const record=()=>JSON.parse(sessionStorage.getItem(key)||"null");
  async function load(){
    await new Promise((resolve,reject)=>{
      const script=document.createElement("script");script.src="./guardian.js";
      script.onload=resolve;script.onerror=()=>reject(new Error("Guardian source did not load"));
      document.body.append(script);
    });
    return guardian();
  }
  async function fresh(html,{clear=true,at=epoch,href=url}={}){
    guardian()?.stop();delete window.__cqLoadRecoveryGuardian;
    if(clear)sessionStorage.clear();
    document.documentElement.removeAttribute("data-cq-unsaved-draft");
    window.__now=at;window.__testUrl=href;window.__online=true;
    host.innerHTML=html;
    return load();
  }
  try {
    let probe=await fresh(error);
    checks.standaloneWithoutRuntime=!!probe && typeof window.chrome?.runtime==="undefined";
    checks.noMainScreenshotDetected=!document.querySelector("main") && probe.detectError();
    checks.errorBlocksDispatch=scan(epoch)===true;
    scan(epoch+59999);
    checks.firstAttemptWaits60Seconds=window.__reloads.length===0;
    scan(epoch+60000);
    checks.firstReload=window.__reloads.length===1 && record()?.attempts===1;

    const first=probe;
    const timerCount=window.__timersCreated;
    await load();
    checks.sameVersionInjectionIdempotent=guardian()===first && window.__timersCreated===timerCount;
    scan(epoch+61000);
    checks.onlyOneReloadPerDocument=window.__reloads.length===1;

    probe=await fresh(error,{clear:false,at:epoch+60000});
    scan(epoch+119999);
    checks.fixedIntervalSurvivesFreshGuardian=window.__reloads.length===1;
    scan(epoch+120000);
    checks.secondReloadAfter60Seconds=window.__reloads.length===2 && record()?.attempts===2;
    // A legacy/high attempt count must never increase the one-minute wait.
    sessionStorage.setItem(key,JSON.stringify({attempts:500,lastAt:epoch+120000}));
    probe=await fresh(error,{clear:false,at:epoch+120000});
    scan(epoch+179999);
    checks.highAttemptCountStillWaits60Seconds=window.__reloads.length===2;
    scan(epoch+180000);
    checks.highAttemptCountDoesNotExtendInterval=window.__reloads.length===3;

    probe=await fresh(healthy,{clear:false,at:epoch+180001});
    scan(epoch+210000);
    checks.healthyNeeds30Seconds=record()!==null;
    scan(epoch+210001);
    checks.healthyComposerResetsBudget=record()===null;
    host.innerHTML=error;
    scan(epoch+210002);scan(epoch+270001);
    checks.healthResetStillRequires60Seconds=window.__reloads.length===3;
    scan(epoch+270002);
    checks.afterHealthCanRecoverAgain=window.__reloads.length===4 && record()?.attempts===1;

    probe=await fresh('<aside><p>'+"侧栏记录 ".repeat(180)+'</p></aside>'+error);
    checks.sidebarDoesNotHideNativeError=probe.detectError();
    const deep='<div>无法加载此 ChatGPT 对话<div><div><div><div><div><div><button aria-label="Retry"><span>重试</span></button></div></div></div></div></div></div></div>';
    host.innerHTML='<aside>ChatGPT 项目与历史</aside>'+deep;
    checks.deepRetryDetected=probe.detectError();
    for(const [name,html] of [
      ["sidebar",'<aside>'+error+'</aside>'],
      ["navigation",'<nav>'+error+'</nav>'],
      ["userQuote",'<section data-message-author-role="user">'+error+'</section>'],
      ["assistantQuote",'<section data-message-author-role="assistant"><div class="markdown">'+error+'</div></section>'],
      ["dialogQuote",'<div role="dialog">'+error+'</div>'],
      ["hidden",'<div style="display:none">'+error+'</div>'],
    ]){
      host.innerHTML=html;checks[name+"Ignored"]=!probe.detectError();
    }
    host.innerHTML='<div>无法加载此 ChatGPT 对话</div>';
    checks.errorRequiresRetry=!probe.detectError();
    host.innerHTML='<div><button>重试</button><p>正常页面</p></div>';
    checks.retryRequiresError=!probe.detectError();

    for(const [name,setup] of [
      ["guardRejects",p=>p.setGuard(()=>false)],
      ["guardUndefined",p=>p.setGuard(()=>undefined)],
      ["guardThrows",p=>p.setGuard(()=>{throw new Error("runtime gone");})],
      ["offline",()=>{window.__online=false;}],
      ["documentPluginDraft",()=>{document.documentElement.dataset.cqUnsavedDraft="true";}],
      ["pluginTextDraft",()=>{host.insertAdjacentHTML("beforeend",'<div id="cq-extension-root"><textarea id="cq-queue-draft">未入队草稿</textarea></div>');}],
      ["pluginAttachment",()=>{host.insertAdjacentHTML("beforeend",'<div id="cq-extension-root"><div data-image-zone="queue"><div class="cq-images"><img src="data:image/png;base64,YWJj"></div></div></div>');}],
      ["nativeTextarea",()=>{host.insertAdjacentHTML("beforeend",'<textarea>原生未发送草稿</textarea>');}],
      ["rawContenteditable",()=>{host.insertAdjacentHTML("beforeend",'<div contenteditable="true">侧面板的未发送编辑</div>');}],
      ["nativeAttachment",()=>{host.insertAdjacentHTML("beforeend",'<form><div data-testid="file-chip">photo.png</div></form>');}],
      ["nativeGeneration",()=>{host.insertAdjacentHTML("beforeend",'<button data-testid="stop-button" aria-label="Stop generating"></button>');}],
    ]){
      probe=await fresh(error,{at:epoch+300000});
      const before=window.__reloads.length;
      setup(probe);scan(epoch+360001);
      checks[name+"Protected"]=window.__reloads.length===before;
    }
    probe=await fresh(error,{at:epoch+370000});
    probe.setGuard(()=>true);scan(epoch+430000);
    checks.guardAllowsExplicitTrue=window.__reloads.length===5;

    probe=await fresh(healthy,{at:epoch+440000});
    scan(epoch+500000);
    checks.healthyPageNeverReloads=window.__reloads.length===5 && !probe.detectError();
    probe=await fresh(error,{href:"https://chatgpt.com/g/g-p-fixture/project",at:epoch+510000});
    checks.projectErrorCanBeRecognized=probe.detectError();
    checks.projectOwnerNotBypassed=scan(epoch+570000)===false && window.__reloads.length===5;
    probe=await fresh(error,{href:"https://example.com/c/fixture",at:epoch+580000});
    checks.otherOriginNotRefreshed=scan(epoch+640000)===false && window.__reloads.length===5;
    probe.stop();
    checks.stopDisablesScan=scan(epoch+700000)===false;
  } catch(error) {checks.error=error.stack || error.message;}
  guardian()?.stop();
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
    assert.ok(match,"Independent guardian DOM fixture did not finish");
    const checks=JSON.parse(match[1].replace(/&quot;/g,'"'));
    assert.equal(checks.ok,true,JSON.stringify(checks));
  } finally {
    fs.rmSync(dir,{recursive:true,force:true});
  }
});
