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

test("真实 Chrome：队列筛选/搜索高亮/全文展开与输入栏容器宽度适配", {
  skip: !fs.existsSync(browser) && "Chrome is not installed",
}, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cq-ui-dom-"));
  try {
    let content = fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8");
    content = content.replace("  function boundHere() {",
      "  function boundHere() { return true; }\n  function unusedOriginalBoundHere() {");
    fs.writeFileSync(path.join(dir, "content.js"), content);
    fs.copyFileSync(path.join(__dirname, "..", "panel.css"), path.join(dir, "panel.css"));
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
    if (message.type === "SET_COMPACT_VIEW") state.compactView=message.enabled;
    return {ok:true,state,sessionKey:"draft:1",settings:{maxPending:100}};
  }},
  storage:{onChanged:{addListener(fn){window.fireStorageChange=fn;}}},
};
const q=(selector)=>document.querySelector("#cq-extension-root "+selector);
const rows=()=>[...document.querySelectorAll("#cq-extension-root .cq-list [data-task-id]")]
  .map(element=>element.dataset.taskId);
const filter=(name)=>q('[data-action="filter-tasks"][data-filter="'+name+'"]').click();
const search=(value)=>{
  const input=q("#cq-task-search");
  input.focus();
  input.value=value;
  input.dispatchEvent(new Event("input",{bubbles:true}));
};
const wait=(ms)=>new Promise(resolve=>setTimeout(resolve,ms));
</script>
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
    result.handoffActionSafeguard=q('[data-action="handoff-now"]')?.disabled===true &&
      q('[data-action="handoff-now"]')?.textContent.includes("接力") &&
      q('[data-action="handoff-now"]')?.getAttribute("title")?.includes("原生项目") &&
      !requests.includes("HANDOFF_NOW");
    result.defaultDraggable=q('[data-task-id="p1"]')?.draggable===true &&
      q('[data-task-id="a"]')?.draggable===false;
    result.originalOrder=rows().join(",")==="a,p1,p2,e,p3,i";
    const searchNode=q("#cq-task-search");
    searchNode.focus();
    searchNode.value="截图截图";
    searchNode.setSelectionRange(2,2);
    searchNode.dispatchEvent(new Event("input",{bubbles:true}));
    result.stableSearchInput=q("#cq-task-search")===searchNode &&
      document.activeElement===searchNode &&
      searchNode.selectionStart===2 && rows().join(",")==="p2";
    search("");

    filter("pending");
    result.pendingFilter=rows().join(",")==="p1,p2,p3" &&
      q('[data-filter="pending"]')?.getAttribute("aria-pressed")==="true" &&
      !q('[data-task-id="p1"]').draggable &&
      q(".cq-search-result")?.textContent.includes("3/6");
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
    search("发送不确定");
    result.errorTextSearch=rows().join(",")==="e" &&
      q('[data-task-id="e"] .cq-task-error-detail mark')?.textContent==="发送不确定";
    search("");

    search("没有这种任务");
    result.emptySearch=rows().length===0 &&
      !!q('[data-action="reset-task-filter"]') &&
      q("#cq-task-search")?.value==="没有这种任务" &&
      document.activeElement?.id==="cq-task-search";
    q('[data-action="reset-task-filter"]').click();
    result.reset=rows().join(",")==="a,p1,p2,e,p3,i" &&
      q('[data-filter="all"]').getAttribute("aria-pressed")==="true" &&
      q('[data-task-id="p1"]').draggable===true &&
      q("#cq-task-search").value==="";
    filter("pending");
    search("文本");
    q("#cq-task-search").dispatchEvent(new KeyboardEvent("keydown",{
      key:"Escape",bubbles:true,cancelable:true,
    }));
    result.escapeResets=rows().join(",")==="a,p1,p2,e,p3,i" &&
      q('[data-filter="all"]').getAttribute("aria-pressed")==="true" &&
      q("#cq-task-search").value==="";

    const composing=q("#cq-task-search");
    composing.focus();
    composing.dispatchEvent(new CompositionEvent("compositionstart",{
      bubbles:true,data:"截图",
    }));
    composing.value="截图截图";
    composing.dispatchEvent(new InputEvent("input",{
      bubbles:true,isComposing:true,inputType:"insertCompositionText",data:"截图",
    }));
    // An unrelated background queue update during IME composition must NOT
    // replace the input or close the native Chinese candidate selection.
    window.fireStorageChange?.({
      "cq.state.v2":{newValue:{conversations:{"draft:1":state}}},
    },"local");
    result.imeCompositionStable=q("#cq-task-search")===composing &&
      document.activeElement===composing &&
      rows().join(",")==="a,p1,p2,e,p3,i";
    const cancelled=new KeyboardEvent("keydown",{
      key:"Escape",isComposing:true,bubbles:true,cancelable:true,
    });
    composing.dispatchEvent(cancelled);
    result.imeEscapeProtected=q("#cq-task-search")===composing &&
      composing.value==="截图截图";
    composing.dispatchEvent(new CompositionEvent("compositionend",{
      bubbles:true,data:"截图截图",
    }));
    result.imeAppliedAfterCommit=rows().join(",")==="p2" &&
      q("#cq-task-search")?.value==="截图截图" &&
      document.activeElement?.id==="cq-task-search";
    search("");

    search("截图截图");
    result.imageNameSearch=rows().join(",")==="p2" &&
      q('[data-task-id="p2"] .cq-image-only')?.textContent.includes("仅图片任务");
    search("needle");
    result.longMatch=rows().join(",")==="p1" &&
      q('[data-task-id="p1"] mark')?.textContent==="needle" &&
      q(".cq-search-result")?.textContent.includes("1/6");
    const before=q('[data-task-id="p1"] .cq-task-text').textContent.length;
    q('[data-action="toggle-task-text"]').click();
    const expanded=q('[data-task-id="p1"] .cq-task-text');
    result.expandedLongText=expanded.textContent.length>before &&
      q('[data-action="toggle-task-text"]').getAttribute("aria-expanded")==="true";
    q('[data-action="toggle-task-text"]').click();
    result.collapsedAgain=q('[data-action="toggle-task-text"]')
      .getAttribute("aria-expanded")==="false";
    search("");

    result.xssEscaped=q('[data-task-id="p3"] .cq-task-text')
      ?.textContent.includes('<img src=x onerror=alert(1)>') &&
      !q('[data-task-id="p3"] .cq-task-text img');
    result.statusDoesNotMutate=state.tasks.map(item=>item.id).join(",")==="a,p1,p2,e,p3,i" &&
      !requests.some(type=>["ENQUEUE","REORDER_TASK","PIN_TASK"].includes(type));

    const testStyle=document.createElement("style");
    testStyle.textContent="#cq-extension-root .cq-list{max-height:85px!important}";
    document.head.append(testStyle);
    filter("pending");
    search("needle");
    const jump=q("#cq-jump-target");
    jump.value="review";
    jump.dispatchEvent(new Event("change",{bubbles:true}));
    result.jumpReviewClearsFilters=rows().join(",")==="a,p1,p2,e,p3,i" &&
      q('[data-filter="all"]').getAttribute("aria-pressed")==="true" &&
      q("#cq-task-search").value==="" &&
      q('[data-task-id="e"]').classList.contains("cq-jump-target") &&
      document.activeElement?.dataset.taskId==="e";
    result.jumpScrollsToTarget=q(".cq-list").scrollTop>0;
    const jumpActive=q("#cq-jump-target");
    jumpActive.value="active";
    jumpActive.dispatchEvent(new Event("change",{bubbles:true}));
    result.jumpActive=q('[data-task-id="a"]').classList.contains("cq-jump-target") &&
      document.activeElement?.dataset.taskId==="a";
    testStyle.remove();

    const comfortableHeight=q('[data-task-id="p1"]').getBoundingClientRect().height;
    q('[data-action="toggle-compact-view"]').click();
    await wait(100);
    result.compactSaved=state.compactView===true &&
      q('[data-action="toggle-compact-view"]')?.getAttribute("aria-pressed")==="true" &&
      q(".cq-inline") && q("#cq-extension-root")===null &&
      document.querySelector("#cq-extension-root").classList.contains("cq-compact-view") &&
      requests.includes("SET_COMPACT_VIEW");
    result.compactFitsMore=q('[data-task-id="p1"]').getBoundingClientRect().height <
      comfortableHeight &&
      getComputedStyle(q('[data-task-id="p2"] .cq-image')).width==="38px";
    q('[data-action="toggle-queue"]').click();
    q('[data-action="toggle-queue"]').click();
    result.compactSurvivesRerender=document.querySelector("#cq-extension-root")
      .classList.contains("cq-compact-view");
    q('[data-action="toggle-compact-view"]').click();
    await wait(100);
    result.comfortableRestored=state.compactView===false &&
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
      q(".cq-search-field").getBoundingClientRect().width>130;

    state.tasks.splice(0);
    q('[data-action="toggle-queue"]').click();
    q('[data-action="toggle-queue"]').click();
    result.emptyQueue=!!q(".cq-empty") &&
      q(".cq-empty").textContent.includes("按 Enter") &&
      q(".cq-empty").textContent.includes("加入队列") &&
      !q(".cq-queue-tools");
  } catch (error) {result.error=error.stack || error.message;}
  result.ok=["counts","handoffActionSafeguard","defaultDraggable","originalOrder","stableSearchInput",
    "pendingFilter",
    "activeFilter","reviewFilter","reviewReason","expandReviewReason",
    "collapseReviewReason","errorTextSearch",
    "emptySearch","reset","escapeResets","imeCompositionStable",
    "imeEscapeProtected",
    "imeAppliedAfterCommit","imageNameSearch",
    "longMatch","expandedLongText","collapsedAgain","xssEscaped",
    "statusDoesNotMutate","jumpReviewClearsFilters","jumpScrollsToTarget",
    "jumpActive","compactSaved","compactFitsMore",
    "compactSurvivesRerender","comfortableRestored",
    "containerResponsive","noHorizontalOverflow",
    "wideRestoresLabels","emptyQueue"].every(key=>result[key]===true);
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
