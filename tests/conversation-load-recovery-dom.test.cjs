"use strict";

// Source-only regression fixture. Reload is replaced before init, so even an
// executed test can never refresh a real ChatGPT tab or dispatch a message.
const {test} = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const {spawnSync} = require("node:child_process");

const browser = process.env.CQ_BROWSER_BIN || (process.platform === "win32"
  ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
  : "/usr/bin/google-chrome");

test("真实 Chrome DOM：对话加载失败固定每60秒刷新，保护草稿并隔离消息引用", {
  skip: !fs.existsSync(browser) && "Chrome is not installed",
}, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cq-load-recovery-"));
  try {
    let content = fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8")
      .replace(/\r\n/g, "\n");
    const end = "  void init();\n})();";
    assert.ok(content.includes(end), "Cannot expose load-recovery helpers");
    assert.match(content, /function nativeConversationLoadErrorVisible\(/);
    assert.match(content, /function maybeReloadConversationLoadError\(/);
    assert.match(content, /function reloadConversationErrorPage\(/);
    const recoveryStart = content.indexOf("  function maybeReloadConversationLoadError(");
    const recoveryEnd = content.indexOf("\n  function extractHandoffReply(", recoveryStart);
    assert.ok(recoveryStart >= 0 && recoveryEnd > recoveryStart);
    // Route changes are simulated without navigating the file fixture. Keep
    // the replacement limited to this helper, including its last route check.
    content = content.slice(0, recoveryStart) +
      content.slice(recoveryStart, recoveryEnd).replaceAll("location.href", "window.__testChatUrl") +
      content.slice(recoveryEnd);
    content = content.replace(end, `
      pageChatKey = () => window.__testChatKey;
      reloadConversationErrorPage = () => window.__reloads.push(window.__now);
      window.__loadRecovery = {
        detect: nativeConversationLoadErrorVisible,
        observe: maybeReloadConversationLoadError,
        state: () => state,
        setFlags(values) {
          queueDraft = values.queueDraft || "";
          composerActionInProgress = values.composerActionInProgress === true;
          imageSelectionInProgress = values.imageSelectionInProgress === true;
          workInProgress = values.workInProgress === true;
        },
      };
    })();`);
    fs.writeFileSync(path.join(dir, "content.js"), content);
    fs.writeFileSync(path.join(dir, "index.html"), `<!doctype html>
<html><head><meta charset="utf-8"><title>Conversation load recovery fixture</title></head>
<body><main></main>
<script>
window.__reloads=[];
window.__now=2000000000000;
window.__testChatKey="chat:fixture-a";
window.__testChatUrl="https://chatgpt.com/g/g-p-fixture/c/fixture-a";
window.__online=true;
Object.defineProperty(navigator,"onLine",{configurable:true,get(){return window.__online;}});
window.chrome={runtime:{getManifest(){return {version:"0.99.0"};},
  onMessage:{addListener(){}},async sendMessage(){throw new Error("Unexpected RPC in isolated fixture");}},
  storage:{onChanged:{addListener(){}}}};
</script>
<script>
(async()=>{
  const checks={};
  const main=document.querySelector("main");
  const failed='<div id="native-error"><h2>无法加载此 ChatGPT 对话</h2><button type="button">重试</button></div>';
  const healthy='<form><textarea id="prompt-textarea"></textarea><button type="button" aria-label="Start Voice">语音模式</button></form>';
  const epoch=2000000000000;
  const observe=(at)=>{
    window.__now=at;
    return window.__loadRecovery.observe(at);
  };
  async function fresh(html,clear=false){
    if(clear)sessionStorage.clear();
    document.querySelector("#cq-extension-root")?.remove();
    document.documentElement.removeAttribute("data-cq-unsaved-draft");
    main.innerHTML=html;
    window.__online=true;
    await new Promise((resolve,reject)=>{
      const script=document.createElement("script");
      script.src="./content.js";
      script.onload=resolve;script.onerror=()=>reject(new Error("Fixture source failed to load"));
      document.body.append(script);
    });
    return window.__loadRecovery;
  }
  try {
    let probe=await fresh(failed,true);
    checks.screenshotDetected=probe.detect();
    checks.noQueueStateRequired=probe.state()===null;
    checks.errorBlocksDispatch=observe(epoch)===true;
    observe(epoch+59999);
    checks.firstAttemptWaits60Seconds=window.__reloads.length===0;
    observe(epoch+60000);
    checks.firstStableReload=window.__reloads.length===1;

    // Evaluate a fresh content-script instance in the same document. The
    // isolated script's memory resets while real sessionStorage survives.
    probe=await fresh(failed);
    observe(epoch+60000);
    observe(epoch+119999);
    checks.persistedFirstCooldown=window.__reloads.length===1;
    observe(epoch+120000);
    checks.secondAttemptAfter60Seconds=window.__reloads.length===2;
    probe=await fresh(failed);
    observe(epoch+120000);
    observe(epoch+179999);
    checks.thirdAttemptKeepsSameCooldown=window.__reloads.length===2;
    observe(epoch+180000);
    checks.thirdAttemptAfter60Seconds=window.__reloads.length===3;

    probe=await fresh(healthy);
    observe(epoch+180001);
    observe(epoch+210001);
    main.innerHTML=failed;
    observe(epoch+210002);
    observe(epoch+270001);
    checks.healthResetStillRequires60Seconds=window.__reloads.length===3;
    observe(epoch+270002);
    checks.healthyComposerResetsBudget=window.__reloads.length===4;

    probe=await fresh(failed,true);
    document.querySelector("#native-error").style.display="none";
    checks.hiddenErrorIgnored=!probe.detect() && observe(epoch+300000)===false;
    main.innerHTML='<section data-message-author-role="user">'+failed+'</section>';
    checks.userQuoteIgnored=!probe.detect();
    main.innerHTML='<section data-message-author-role="assistant"><div class="markdown">'+failed+'</div></section>';
    checks.assistantQuoteIgnored=!probe.detect();
    main.innerHTML=failed.replace('<button type="button">重试</button>',"");
    checks.missingRetryIgnored=!probe.detect();
    main.innerHTML=failed;
    observe(epoch+310000);
    main.innerHTML="";
    observe(epoch+370001);
    checks.disappearedErrorDoesNotReload=window.__reloads.length===4;

    probe=await fresh(failed+healthy,true);
    const editor=document.querySelector("#prompt-textarea");
    editor.value="我的未发送草稿";
    observe(epoch+400000);observe(epoch+460001);
    checks.nativeDraftProtected=window.__reloads.length===4 && editor.value==="我的未发送草稿";
    editor.value="";
    probe.setFlags({queueDraft:"未入队的插件草稿"});
    observe(epoch+470001);
    checks.pluginDraftProtected=window.__reloads.length===4;
    probe.setFlags({composerActionInProgress:true});
    observe(epoch+480001);
    checks.composerMutationProtected=window.__reloads.length===4;
    probe.setFlags({});
    window.__online=false;
    observe(epoch+490001);
    checks.offlineDoesNotReload=window.__reloads.length===4;

    probe=await fresh(failed+healthy,true);
    const stop=document.createElement("button");
    stop.setAttribute("data-testid","stop-button");
    stop.setAttribute("aria-label","Stop generating");
    document.querySelector("form").append(stop);
    observe(epoch+500000);observe(epoch+560001);
    checks.generationProtected=window.__reloads.length===4;

    probe=await fresh(failed,true);
    observe(epoch+700000);
    window.__testChatKey="chat:fixture-b";
    window.__testChatUrl="https://chatgpt.com/g/g-p-fixture/c/fixture-b";
    observe(epoch+760000);
    checks.routeChangeStartsFresh60Seconds=window.__reloads.length===4;
    observe(epoch+819999);
    checks.newRouteDoesNotReloadEarly=window.__reloads.length===4;
    observe(epoch+820000);
    checks.newRouteCanRecover=window.__reloads.length===5;
    probe=await fresh(failed,true);
    window.__testChatKey=null;
    observe(epoch+900000);observe(epoch+960001);
    checks.nonConversationDoesNotReload=window.__reloads.length===5;
  } catch(error) { checks.error=error.stack || error.message; }
  checks.ok=Object.values(checks).every(value=>value===true);
  document.body.dataset.result=JSON.stringify(checks);
})();
</script>
</body></html>`);
    const result = spawnSync(browser, [
      "--headless=new", "--disable-gpu", "--disable-extensions", "--no-first-run",
      `--user-data-dir=${path.join(dir, "profile")}`,
      "--virtual-time-budget=8000", "--dump-dom",
      `file:///${path.join(dir, "index.html").replace(/\\/g, "/")}`,
    ], {encoding:"utf8",timeout:30000,maxBuffer:8e6});
    assert.equal(result.status,0,result.stderr || "Chrome failed");
    const match=result.stdout.match(/data-result="([^"]+)"/);
    assert.ok(match,"Load recovery fixture did not finish");
    const checks=JSON.parse(match[1].replace(/&quot;/g,'"'));
    assert.equal(checks.ok,true,JSON.stringify(checks));
  } finally {
    fs.rmSync(dir,{recursive:true,force:true});
  }
});
