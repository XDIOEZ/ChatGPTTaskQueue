"use strict";

// Standalone native-error recovery: no chrome/runtime, no queue dispatch and
// no real navigation. Keep the transport cadence separate from load errors.
const {test} = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const {spawnSync} = require("node:child_process");

const browser = process.env.CQ_BROWSER_BIN || (process.platform === "win32"
  ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
  : "/usr/bin/google-chrome");

test("独立守护每五分钟检查末条回复传输错误，刷新前保护草稿与生成且从不点重试", {
  skip: !fs.existsSync(browser) && "Chrome is not installed",
}, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cq-transport-recovery-"));
  try {
    let source = fs.readFileSync(path.join(__dirname, "..", "load-recovery.js"), "utf8")
      .replace(/\r\n/g, "\n");
    const locationHelper = "function currentUrl() { return location.href; }";
    const reloadHelper = "function reloadErrorPage() { location.reload(); }";
    assert.ok(source.includes(locationHelper) && source.includes(reloadHelper),
      "Guardian location/reload fixture hooks moved");
    source = source.replace(locationHelper, "function currentUrl() { return window.__testUrl; }")
      .replace(reloadHelper, "function reloadErrorPage() { window.__reloads.push(window.__now); }");
    fs.writeFileSync(path.join(dir, "guardian.js"), source);
    fs.writeFileSync(path.join(dir, "index.html"), `<!doctype html>
<html><head><meta charset="utf-8"><title>Native transport error recovery</title>
<style>button{min-width:24px;min-height:24px}textarea{min-height:24px}</style></head>
<body><div id="fixture"></div><script>
window.__now=2000000000000;
window.__testUrl="https://chatgpt.com/c/transport-fixture";
window.__reloads=[];
window.__retryClicks=0;
window.__online=true;
Date.now=()=>window.__now;
window.setInterval=()=>1;
window.clearInterval=()=>{};
Object.defineProperty(navigator,"onLine",{configurable:true,get(){return window.__online;}});
Object.defineProperty(document,"visibilityState",{configurable:true,get(){return "hidden";}});
Object.defineProperty(document,"hidden",{configurable:true,get(){return true;}});
document.addEventListener("click",event=>{
  if(event.target.closest?.("[data-native-retry]"))window.__retryClicks++;
});
// No window.chrome/runtime mock: background recovery must stand on its own.
</script><script>
(async()=>{
  const checks={},host=document.querySelector("#fixture");
  const epoch=2000000000000,url="https://chatgpt.com/c/transport-fixture";
  const key="cq.transportErrorRecovery.v1:/c/transport-fixture";
  const composer='<form><textarea id="prompt-textarea"></textarea><button aria-label="Start Voice">Voice</button></form>';
  const retry='<button type="button" data-native-retry>重试</button>';
  const alert='<div id="transport-error" role="alert">消息传输超时。请重试。</div>';
  const compact='<div id="transport-error"><span>消息传输超时。请重试。</span>'+retry+'</div>';
  // Native disconnected notice has neither Retry nor role=alert. It lives
  // beside the authored markdown, not inside the assistant's prose.
  const disconnected='<div id="disconnected-notice">连接已中断，正在等待完整答复</div>';
  const reply=error=>'<article data-testid="conversation-turn-1"><div data-message-author-role="assistant" data-message-id="a1"><div class="markdown">上一步已执行，等待工具结果。</div>'+error+'</div></article>';
  const page=error=>'<main><section id="conversation"><div data-message-author-role="user" data-message-id="u1">请处理任务</div>'+reply(error)+'</section>'+composer+'</main>';
  const guardian=()=>window.__cqLoadRecoveryGuardian;
  const scan=at=>{window.__now=at;return guardian().scan(at);};
  const record=()=>JSON.parse(sessionStorage.getItem(key)||"null");
  async function fresh(html,{clear=true,at=epoch,href=url}={}){
    guardian()?.stop();delete window.__cqLoadRecoveryGuardian;
    if(clear)sessionStorage.clear();
    document.documentElement.removeAttribute("data-cq-unsaved-draft");
    window.__now=at;window.__testUrl=href;window.__online=true;
    host.innerHTML=html;
    await new Promise((resolve,reject)=>{
      const script=document.createElement("script");script.src="./guardian.js";
      script.onload=resolve;script.onerror=()=>reject(new Error("Guardian did not load"));
      document.body.append(script);
    });
    return guardian();
  }
  try{
    let probe=await fresh(page(alert));
    checks.standalone=typeof window.chrome?.runtime==="undefined"&&
      typeof probe.detectTransportError==="function";
    checks.latestAssistantAlertDetected=!!probe.detectTransportError();
    scan(epoch+299999);
    checks.noEarlyTransportRefresh=window.__reloads.length===0;
    scan(epoch+300000);
    checks.hiddenTabRefreshesAtFiveMinutes=document.hidden&&window.__reloads.length===1&&!!record();
    scan(epoch+600000);
    checks.oneReloadPerDocument=window.__reloads.length===1;

    // Reinstallation after reload cannot fall into a one-minute/tight loop.
    await fresh(page(alert),{clear:false,at:epoch+300001});
    scan(epoch+599999);
    checks.persistedCadenceNoEarlyRefresh=window.__reloads.length===1;
    scan(epoch+600001);
    checks.persistedCadenceRecoversAgain=window.__reloads.length===2;

    // This is a periodic check, not a five-minute continuous-error debounce.
    probe=await fresh(page(""));
    scan(epoch+299999);
    host.innerHTML=page(compact);
    checks.latestCompactRetryDetected=!!probe.detectTransportError();
    const beforeLate=window.__reloads.length;
    scan(epoch+300000);
    checks.newErrorAtScheduledCheckRefreshes=window.__reloads.length===beforeLate+1;

    probe=await fresh(page(disconnected));
    checks.disconnectedNativeTextDetected=!!probe.detectTransportError();
    const beforeDisconnected=window.__reloads.length;
    scan(epoch+299999);
    checks.disconnectedWaitsFiveMinutes=window.__reloads.length===beforeDisconnected;
    scan(epoch+300000);
    checks.disconnectedRefreshesWithoutRetry=window.__reloads.length===beforeDisconnected+1;

    const addGenerationSignals=()=>{
      document.querySelector("form").insertAdjacentHTML("beforeend",
        '<button data-testid="stop-button" aria-label="Stop generating">Stop</button>');
      document.querySelector('[data-testid="conversation-turn-1"]').dataset.isStreaming="true";
    };
    probe=await fresh(page(disconnected));
    addGenerationSignals();
    let allowedDisconnectedGeneration=false;
    probe.setGuard(options=>{
      allowedDisconnectedGeneration=options?.allowDisconnectedGeneration===true;
      return allowedDisconnectedGeneration;
    });
    const beforeStalled=window.__reloads.length;
    checks.disconnectedStillNormallyGenerationUnsafe=!probe.domSafe();
    scan(epoch+299999);
    checks.disconnectedStopNotBypassedEarly=window.__reloads.length===beforeStalled;
    scan(epoch+300000);
    checks.stableDisconnectedMayBypassStuckGeneration=window.__reloads.length===beforeStalled+1&&
      allowedDisconnectedGeneration;

    probe=await fresh(page(disconnected));
    addGenerationSignals();
    const beforeProgress=window.__reloads.length;
    scan(epoch+199999);
    document.querySelector('[data-message-id="a1"] .markdown').textContent+="工具返回后继续生成真实答复。";
    scan(epoch+200000);
    scan(epoch+300000);
    checks.actualReplyProgressResetsStability=window.__reloads.length===beforeProgress;
    scan(epoch+499999);
    checks.newReplyContentNeedsFullStableWindow=window.__reloads.length===beforeProgress;
    scan(epoch+600000);
    checks.newReplyMayRecoverAtNextStableCheck=window.__reloads.length===beforeProgress+1;

    for(const [name,setup] of [
      ["whiteDraft",()=>{document.querySelector("#prompt-textarea").value="仍需保留的私人草稿";}],
      ["whiteAttachment",()=>{document.querySelector("form").insertAdjacentHTML("beforeend",'<div data-testid="file-chip">截图.png</div>');}],
      ["whiteGuard",p=>{p.setGuard(()=>false);}],
    ]){
      probe=await fresh(page(disconnected));
      addGenerationSignals();
      const before=window.__reloads.length;
      setup(probe);scan(epoch+300000);
      checks[name+"ProtectedDespiteStall"]=window.__reloads.length===before;
    }

    for(const [name,html] of [
      ["oldAssistant",page(alert).replace('</section>',
        '<article data-testid="conversation-turn-2"><div data-message-author-role="assistant" data-message-id="a2"><div class="markdown">新的正常回答</div></div></article></section>')],
      ["authoredQuote",page('<div class="markdown">'+compact+'</div>')],
      ["codeQuote",page('<pre><code>'+compact+'</code></pre>')],
      ["userQuote",'<main><div data-message-author-role="user">'+compact+'</div>'+reply("")+composer+'</main>'],
      ["hiddenError",page('<div hidden>'+alert+'</div>')],
      ["ordinaryRetry",page('<div>正常回复'+retry+'</div>')],
      ["oldDisconnected",page(disconnected).replace('</section>',
        '<article data-testid="conversation-turn-2"><div data-message-author-role="assistant" data-message-id="a2"><div class="markdown">新的正常回答</div></div></article></section>')],
      ["disconnectedBodyQuote",page('<div class="markdown">'+disconnected+'</div>')],
      ["disconnectedUserQuote",'<main><div data-message-author-role="user">'+disconnected+'</div>'+reply("")+composer+'</main>'],
    ]){
      probe=await fresh(html);
      const before=window.__reloads.length;
      checks[name+"NotDetected"]=!probe.detectTransportError();
      scan(epoch+300000);
      checks[name+"NotRefreshed"]=window.__reloads.length===before;
    }

    probe=await fresh(page(""));
    document.querySelector("#prompt-textarea").value="连接已中断，正在等待完整答复";
    checks.disconnectedComposerTextNotDetected=!probe.detectTransportError();

    for(const [name,setup] of [
      ["nativeDraft",()=>{document.querySelector("#prompt-textarea").value="私人草稿";}],
      ["nativeAttachment",()=>{document.querySelector("form").insertAdjacentHTML("beforeend",'<div data-testid="file-chip">图片.png</div>');}],
      ["nativeStop",()=>{document.querySelector("form").insertAdjacentHTML("beforeend",'<button data-testid="stop-button" aria-label="Stop generating">Stop</button>');}],
      ["assistantStreaming",()=>{document.querySelector('[data-testid="conversation-turn-1"]').dataset.isStreaming="true";}],
      ["pluginDraft",()=>{document.documentElement.dataset.cqUnsavedDraft="true";}],
      ["offline",()=>{window.__online=false;}],
      ["guard",p=>{p.setGuard(()=>false);}],
    ]){
      probe=await fresh(page(compact));
      const before=window.__reloads.length;
      setup(probe);scan(epoch+300000);
      checks[name+"BlocksReload"]=window.__reloads.length===before;
    }

    probe=await fresh(page(compact));
    const beforeFinal=window.__reloads.length;
    probe.setGuard(()=>{
      document.querySelector("#transport-error")?.remove();
      return true;
    });
    scan(epoch+300000);
    checks.errorRecheckedAfterGuard=window.__reloads.length===beforeFinal;

    probe=await fresh(page(alert));
    const beforeRoute=window.__reloads.length;
    window.__testUrl="https://chatgpt.com/c/different-chat";
    scan(epoch+300000);
    checks.routeChangeRestartsCheck=window.__reloads.length===beforeRoute;

    // The existing conversation-load-error recovery must remain at 60 s.
    await fresh('<main><div>无法加载此 ChatGPT 对话'+retry+'</div></main>');
    const beforeLoad=window.__reloads.length;
    scan(epoch+59999);
    checks.loadErrorStillWaits60Seconds=window.__reloads.length===beforeLoad;
    scan(epoch+60000);
    checks.loadErrorStillRefreshesAt60Seconds=window.__reloads.length===beforeLoad+1;
    checks.neverClicksRetry=window.__retryClicks===0;
  }catch(error){checks.error=error.stack||error.message;}
  guardian()?.stop();
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
    assert.equal(result.status, 0, result.stderr || "Chrome failed");
    const match = result.stdout.match(/data-result="([^"]+)"/);
    assert.ok(match, "Transport recovery DOM fixture did not finish");
    const checks = JSON.parse(match[1].replace(/&quot;/g, '"').replace(/&amp;/g, "&"));
    assert.equal(checks.ok, true, JSON.stringify(checks));
  } finally {
    fs.rmSync(dir, {recursive:true,force:true});
  }
});
