"use strict";

const {test} = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const {spawnSync} = require("node:child_process");

const browser = process.env.CQ_BROWSER_BIN || (process.platform === "win32"
  ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
  : "/usr/bin/google-chrome");

test("真实 Chrome：移除队列冗余工具栏，保留状态筛选、长文和响应式布局", {
  skip: !fs.existsSync(browser) && "Chrome is not installed",
}, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cq-ui-dom-"));
  try {
    let content = fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8");
    content = content.replace("  function boundHere() {",
      "  function boundHere() { return true; }\n  function unusedOriginalBoundHere() {");
    fs.writeFileSync(path.join(dir, "content.js"), content);
    fs.copyFileSync(path.join(__dirname, "..", "panel.css"), path.join(dir, "panel.css"));
    fs.copyFileSync(path.join(__dirname, "..", "agent-policy.js"), path.join(dir, "agent-policy.js"));
    fs.writeFileSync(path.join(dir, "index.html"), `<!doctype html>
<html lang="zh"><head><meta charset="utf-8">
<link rel="stylesheet" href="./panel.css">
<style>main {width:700px;max-width:100%;margin:20px auto} main form{display:block}</style>
</head><body>
<main><form><textarea id="prompt-textarea"></textarea>
<button type="button" data-testid="send-button" aria-label="Send">发送</button></form></main>
<script>
const initialLongText = "一个很长的队列消息：" + "中".repeat(255) + "needle 最重要的关键字";
const dangerous = '<img src=x onerror=alert(1)>内容不能变成 HTML';
const requests = [];
const queueSubmissions = [];
const dismissed = [];
const state = {
  key:"draft:1",halted:false,queuePaused:false,compactView:false,activeTaskId:"a",
  steeringTaskId:null,autoOpenTab:false,schedules:[],
  tasks:[
    {id:"a",text:"正在等待回复的任务",status:"waiting",sentAt:Date.now()-3000},
    {id:"p1",text:initialLongText,status:"pending"},
    {id:"p2",text:"",images:[{name:"截图截图.png",thumbnail:"data:image/jpeg;base64,YWJj"}],status:"pending"},
    {id:"e",text:"需要人工核对的任务",status:"error",error:"发送不确定"},
    {id:"p3",text:dangerous,status:"pending"},
    {id:"i",text:"用户停止的任务",status:"interrupted"},
  ],
};
window.chrome = {
  runtime:{getManifest(){return {version:"9.8.7"};},onMessage:{addListener(){}},async sendMessage(message) {
    requests.push(message.type);
    if(message.type === "ENQUEUE") {
      queueSubmissions.push(message);
      state.tasks.push({id:"new-"+queueSubmissions.length,
        text:message.text,status:"pending",images:[]});
    }
    if (message.type === "DISMISS_WAITING") {
      dismissed.push(message);
      state.tasks=state.tasks.filter(task=>task.id!==message.id);
      state.activeTaskId=null;
    }
    if (message.type === "SET_COMPACT_VIEW") state.compactView=message.enabled;
    return {ok:true,state,sessionKey:"draft:1",settings:{maxPending:100}};
  }},
  storage:{onChanged:{addListener(fn){window.fireStorageChange=fn;}}},
};
const q=(selector)=>document.querySelector("#cq-extension-root "+selector);
const rows=()=>[...document.querySelectorAll("#cq-extension-root .cq-list [data-task-id]")]
  .map(element=>element.dataset.taskId);
const filter=(name)=>q('[data-action="filter-tasks"][data-filter="'+name+'"]').click();
const wait=(ms)=>new Promise(resolve=>setTimeout(resolve,ms));
</script>
<script src="./agent-policy.js"></script>
<script src="./content.js"></script>
<script>
setTimeout(async()=>{
  const result={};
  try {
    result.counts=q('[data-filter="all"] span')?.textContent==="6" &&
      q('[data-filter="pending"] span')?.textContent==="3" &&
      q('[data-filter="active"] span')?.textContent==="1" &&
      q('[data-filter="review"] span')?.textContent==="2";
    result.versionBadge=q('.cq-toolbar > .cq-version-badge')?.textContent==="v9.8.7" &&
      q('.cq-toolbar')?.lastElementChild?.classList.contains('cq-version-badge') &&
      q('.cq-version-badge')?.getAttribute('aria-label')==="插件版本 9.8.7";
    q('[data-action="toggle-handoff"]').click();
    result.handoffActionSafeguard=q('[data-action="handoff-now"]')?.disabled===true &&
      /接力|交接/.test(q('[data-action="handoff-now"]')?.textContent||"") &&
      !requests.includes("HANDOFF_NOW");
    q('[data-action="toggle-handoff"]').click();
    result.defaultDraggable=q('[data-task-id="p1"]')?.draggable===true &&
      q('[data-task-id="a"]')?.draggable===false;
    result.originalOrder=rows().join(",")==="a,p1,p2,e,p3,i";
    result.waitingDismissButton=!!q('[data-task-id="a"] [data-action="dismiss-waiting"]') &&
      !q('[data-task-id="p1"] [data-action="dismiss-waiting"]');
    const stop=document.createElement("button");
    stop.type="button";
    stop.setAttribute("aria-label","停止生成");
    document.querySelector("form").append(stop);
    q('[data-action="toggle-queue"]').click();
    q('[data-action="toggle-queue"]').click();
    result.generatingCannotDismiss=q('[data-action="dismiss-waiting"]')?.disabled===true;
    stop.remove();
    q('[data-action="toggle-queue"]').click();
    q('[data-action="toggle-queue"]').click();
    result.idleCanDismiss=q('[data-action="dismiss-waiting"]')?.disabled===false;
    result.noUnusedTools=!q(".cq-queue-search-row") && !q("#cq-task-search") &&
      !q(".cq-search-result") && !q("#cq-jump-target") &&
      !q('[data-action="toggle-compact-view"]');
    const tools=q(".cq-queue-tools");
    result.onlyFilterRow=tools?.children.length===1 &&
      tools.firstElementChild?.classList.contains("cq-filter-row") &&
      tools.getBoundingClientRect().height<50;

    filter("pending");
    result.pendingFilter=rows().join(",")==="p1,p2,p3" &&
      q('[data-filter="pending"]')?.getAttribute("aria-pressed")==="true" &&
      !q('[data-task-id="p1"]').draggable;
    filter("active");
    result.activeFilter=rows().join(",")==="a";
    filter("review");
    result.reviewFilter=rows().join(",")==="e,i" &&
      getComputedStyle(q('[data-task-id="e"]')).boxShadow.includes("inset");
    result.reviewReason=!q('[data-task-id="e"] .cq-task-error-detail') &&
      q('[data-task-id="e"] .cq-error-toggle')?.textContent.includes("查看原因");
    q('[data-task-id="e"] .cq-error-toggle').click();
    result.expandReviewReason=q('[data-task-id="e"] .cq-task-error-detail')
      ?.textContent.includes("发送不确定") &&
      q('[data-task-id="e"] .cq-error-toggle').getAttribute("aria-expanded")==="true";
    q('[data-task-id="e"] .cq-error-toggle').click();
    result.collapseReviewReason=!q('[data-task-id="e"] .cq-task-error-detail');
    filter("all");
    result.filterReset=rows().join(",")==="a,p1,p2,e,p3,i" &&
      q('[data-filter="all"]')?.getAttribute("aria-pressed")==="true" &&
      q('[data-task-id="p1"]')?.draggable===true;
    const before=q('[data-task-id="p1"] .cq-task-text').textContent.length;
    q('[data-action="toggle-task-text"]').click();
    const expanded=q('[data-task-id="p1"] .cq-task-text');
    result.expandedLongText=expanded.textContent.length>before &&
      q('[data-action="toggle-task-text"]').getAttribute("aria-expanded")==="true";
    q('[data-action="toggle-task-text"]').click();
    result.collapsedAgain=q('[data-action="toggle-task-text"]')
      .getAttribute("aria-expanded")==="false";

    result.xssEscaped=q('[data-task-id="p3"] .cq-task-text')
      ?.textContent.includes('<img src=x onerror=alert(1)>') &&
      !q('[data-task-id="p3"] .cq-task-text img');
    result.statusDoesNotMutate=state.tasks.map(item=>item.id).join(",")==="a,p1,p2,e,p3,i" &&
      !requests.some(type=>["ENQUEUE","REORDER_TASK","PIN_TASK"].includes(type));

    const comfortableHeight=q('[data-task-id="p1"]').getBoundingClientRect().height;
    // Old conversations may still have a compact preference; keep rendering it
    // without exposing the removed density toggle.
    state.compactView=true;
    q('[data-action="toggle-queue"]').click();
    q('[data-action="toggle-queue"]').click();
    result.legacyCompact=q('[data-task-id="p1"]').getBoundingClientRect().height <
      comfortableHeight &&
      getComputedStyle(q('[data-task-id="p2"] .cq-image')).width==="38px";
    result.noCompactControl=!q('[data-action="toggle-compact-view"]');
    state.compactView=false;
    q('[data-action="toggle-queue"]').click();
    q('[data-action="toggle-queue"]').click();
    result.comfortableRestored=
      !document.querySelector("#cq-extension-root").classList.contains("cq-compact-view");

    document.querySelector("main").style.width="340px";
    await wait(80);
    const footer=q(".cq-footer-toolbar");
    const actionBar=q(".cq-bottom-actions");
    result.containerResponsive = window.innerWidth>600 &&
      getComputedStyle(q('.cq-tool[data-action="queue-composer"] span')).display==="none" &&
      Math.abs(actionBar.getBoundingClientRect().width-
        footer.getBoundingClientRect().width)<30 &&
      q(".cq-filter-row").getBoundingClientRect().width<=340;
    result.noHorizontalOverflow=q(".cq-inline").scrollWidth<=q(".cq-inline").clientWidth+2;
    document.querySelector("main").style.width="700px";
    await wait(80);
    result.wideRestoresLabels=getComputedStyle(
      q('.cq-tool[data-action="queue-composer"] span')).display!=="none" &&
      !q(".cq-queue-search-row");

    const originalTasks=state.tasks.slice();
    state.tasks=state.tasks.filter(task=>task.status!=="pending");
    filter("pending");
    result.emptyFilter=rows().length===0 && !!q('[data-action="reset-task-filter"]');
    q('[data-action="reset-task-filter"]').click();
    result.resetFilterFocus=q('[data-filter="all"]')?.getAttribute("aria-pressed")==="true" &&
      document.activeElement?.id==="cq-filter-all" &&
      rows().join(",")==="a,e,i";
    state.tasks=originalTasks;
    filter("all");

    q('[data-action="dismiss-waiting"]').click();
    await wait(80);
    result.dismissWaiting=dismissed.length===1 && dismissed[0].id==="a" &&
      dismissed[0].userRequested===true && dismissed[0].nativeBusy===false &&
      !q('[data-task-id="a"]') && state.activeTaskId===null;

    state.tasks.splice(0);
    q('[data-action="toggle-queue"]').click();
    q('[data-action="toggle-queue"]').click();
    result.emptyQueue=!!q(".cq-empty") &&
      q(".cq-empty").textContent.includes("按 Enter") &&
      q(".cq-empty").textContent.includes("加入队列") &&
      !q(".cq-queue-tools");
    const longTask="请重构物品与生产系统，同时整合食物及装备数值编辑、"+
      "修复运行时更新并提供自动化测试。".repeat(6);
    q('[data-action="toggle-settings"]').click();
    q('[data-action="show-settings-page"][data-page="general"]').click();
    q('[data-action="toggle-queue-composer"]').click();
    result.teamToggleDefault=q('#cq-auto-team-enabled')?.checked===true;
    q('#cq-queue-draft').value=longTask;
    q('#cq-queue-draft').dispatchEvent(new Event("input",{bubbles:true}));
    q('[data-action="save-queue-composer"]').click();
    await wait(120);
    result.teamHintSubmitted=queueSubmissions.length===1 &&
      queueSubmissions[0].text.startsWith(longTask) &&
      queueSubmissions[0].text.includes("[队列插件：自动协作]");
    q('[data-action="toggle-settings"]').click();
    q('[data-action="show-settings-page"][data-page="general"]').click();
    q('[data-action="toggle-queue-composer"]').click();
    const toggle=q('#cq-auto-team-enabled');
    toggle.checked=false;
    toggle.dispatchEvent(new Event("change",{bubbles:true}));
    q('#cq-queue-draft').value=longTask;
    q('#cq-queue-draft').dispatchEvent(new Event("input",{bubbles:true}));
    q('[data-action="save-queue-composer"]').click();
    await wait(120);
    result.teamToggleHonored=queueSubmissions.length===2 &&
      queueSubmissions[1].text===longTask &&
      localStorage.getItem("cq.agentTeamAuto.v1")==="0";
  } catch (error) {result.error=error.stack || error.message;}
  result.ok=["counts","handoffActionSafeguard","defaultDraggable","originalOrder",
    "waitingDismissButton","generatingCannotDismiss","idleCanDismiss","dismissWaiting",
    "noUnusedTools","onlyFilterRow","pendingFilter","activeFilter","reviewFilter",
    "reviewReason","expandReviewReason","collapseReviewReason","filterReset",
    "expandedLongText","collapsedAgain","xssEscaped","statusDoesNotMutate",
    "legacyCompact","noCompactControl","comfortableRestored",
    "containerResponsive","noHorizontalOverflow","wideRestoresLabels",
    "emptyFilter","resetFilterFocus","emptyQueue","teamToggleDefault",
    "teamHintSubmitted","teamToggleHonored"].every(key=>result[key]===true);
  document.body.dataset.check=JSON.stringify(result);
},300);
</script></body></html>`);
    const output=spawnSync(browser,[
      "--headless=new","--disable-gpu","--disable-extensions","--no-first-run",
      `--user-data-dir=${path.join(dir,"profile")}`,
      "--virtual-time-budget=4500","--dump-dom",
      `file:///${path.join(dir,"index.html").replace(/\\/g,"/")}`,
    ],{encoding:"utf8",timeout:23000,maxBuffer:9e6});
    assert.equal(output.status,0,output.stderr || "Chrome failed");
    const match=output.stdout.match(/data-check="([^"]+)"/);
    assert.ok(match,"Chrome did not finish queue UI interaction test");
    const results=JSON.parse(match[1].replace(/&quot;/g,'"'));
    assert.equal(results.ok,true,JSON.stringify(results));
  } finally {
    fs.rmSync(dir,{recursive:true,force:true});
  }
});
