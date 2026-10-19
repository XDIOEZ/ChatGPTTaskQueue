"use strict";

const {test} = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const {spawnSync} = require("node:child_process");

const browser = process.env.CQ_BROWSER_BIN || (process.platform === "win32"
  ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" : "/usr/bin/google-chrome");

test("真实 Chrome：队列图文收藏、跨列表搜索及复用入队不触发即时发送",{
  skip:!fs.existsSync(browser) && "Chrome is not installed",
},()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"cq-favorites-queue-dom-"));
  try {
    let content=fs.readFileSync(path.join(__dirname,"..","content.js"),"utf8");
    content=content.replace("  function boundHere() {",
      "  function boundHere() { return true; }\n  function unusedOriginalBoundHere() {");
    fs.writeFileSync(path.join(dir,"content.js"),content);
    fs.copyFileSync(path.join(__dirname,"..","panel.css"),path.join(dir,"panel.css"));
    fs.writeFileSync(path.join(dir,"index.html"),`<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><link rel="stylesheet" href="panel.css">
<style>main{width:700px;max-width:100%;margin:16px auto} main form{display:block}</style>
</head><body><main><form>
<textarea id="prompt-textarea">输入框文字</textarea>
<button type="button" data-testid="send-button" aria-label="Send">发送</button>
</form></main>
<script>
const state={key:"draft:1",halted:false,queuePaused:false,compactView:false,
 activeTaskId:null,steeringTaskId:null,autoOpenTab:false,schedules:[],
 tasks:[
  {id:"p1",text:"常用代码审查",status:"pending"},
  {id:"p2",text:"截图分析",status:"pending",images:[{
   id:"img-1",name:"截图名字.png",type:"image/png",size:111,
   thumbnail:"data:image/jpeg;base64,YWJj",
  }]},
 ]};
const favorites=[],requests=[];
let onStorageChange=null;
window.chrome={
 runtime:{
  onMessage:{addListener(){}},
  async sendMessage(message){
   requests.push({...message});
   if(message.type==="ADD_FAVORITE"){
    const task=state.tasks.find(item=>item.id===message.taskId);
    const favorite=task
     ? {id:"fav-1",title:task.text,text:task.text,images:[...(task.images||[])]}
     : {id:"fav-2",title:"当前输入",text:message.text,images:[]};
    favorites.push(favorite);
    return {ok:true,favorites:[...favorites]};
   }
   if(message.type==="DELETE_FAVORITE"){
    favorites.splice(favorites.findIndex(item=>item.id===message.id),1);
    return {ok:true,favorites:[...favorites]};
   }
   if(message.type==="GET_FAVORITES")return {ok:true,favorites:[...favorites]};
   if(message.type==="UPDATE_FAVORITE"){
    const favorite=favorites.find(item=>item.id===message.id);
    if(!favorite)return {ok:false,error:"收藏不存在"};
    if(Object.hasOwn(message,"pinned"))favorite.pinned=message.pinned;
    if(Object.hasOwn(message,"category"))favorite.category=message.category;
    return {ok:true,favorites:[...favorites]};
   }
   if(message.type==="ENQUEUE_FAVORITE"){
    const favorite=favorites.find(item=>item.id===message.favoriteId);
    if(!favorite)return {ok:false,error:"收藏不存在"};
    state.tasks.push({id:"p3",text:favorite.text,images:[...favorite.images],status:"pending"});
   }
   return {ok:true,state,sessionKey:"draft:1",settings:{maxPending:100}};
  },
 },
 storage:{onChanged:{addListener(fn){onStorageChange=fn;}}},
};
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const until=async fn=>{for(let i=0;i<75;i++){if(fn())return true;await wait(30);}return !!fn();};
const q=selector=>document.querySelector("#cq-extension-root "+selector);
const fireInput=(node,value)=>{node.value=value;node.dispatchEvent(new Event("input",{bubbles:true}));};
</script>
<script src="content.js"></script>
<script>
setTimeout(async()=>{
 const result={};
 try{
  await until(()=>q('[data-action="favorite-task"][data-id="p2"]'));
  result.entry=!!q('[data-action="toggle-favorites"]') &&
   !!q('[data-action="favorite-task"][data-id="p2"]');
  q('[data-action="favorite-task"][data-id="p2"]').click();
  await until(()=>favorites.length===1 && q('[data-action="favorite-task"][data-id="p2"]')?.textContent==="★");
  result.savedImage=favorites[0]?.images[0]?.id==="img-1" &&
   requests.some(request=>request.type==="ADD_FAVORITE" && request.taskId==="p2");
  q('[data-action="toggle-favorites"]').click();
  await until(()=>!!q('.cq-favorite-row[data-favorite-id="fav-1"]'));
  result.library=q('.cq-favorite-row')?.textContent.includes("截图分析") &&
   q('.cq-favorite-row .cq-image img')?.getAttribute("src").startsWith("data:image/jpeg");
  const search=q("#cq-favorite-search");
  search.focus();fireInput(search,"没有这条");
  result.searchStable=q("#cq-favorite-search")===search &&
   document.activeElement===search && !q(".cq-favorite-row");
  fireInput(search,"");
  search.dispatchEvent(new CompositionEvent("compositionstart",{bubbles:true}));
  search.value="截图名字";
  search.dispatchEvent(new InputEvent("input",{bubbles:true,isComposing:true}));
  onStorageChange?.({"cq.state.v2":{newValue:{
   conversations:{"draft:1":state},favorites:[...favorites],
  }}},"local");
  result.imePreserved=q("#cq-favorite-search")===search &&
   document.activeElement===search;
  search.dispatchEvent(new CompositionEvent("compositionend",{bubbles:true}));
  result.imageNameSearch=q(".cq-favorite-row")?.textContent.includes("截图分析") &&
   q("#cq-favorite-search")?.value==="截图名字";
  fireInput(q("#cq-favorite-search"),"");
  q('[data-action="enqueue-favorite"][data-id="fav-1"]').click();
  await until(()=>state.tasks.length===3 && !!q('[data-task-id="p3"]'));
  result.reenqueue=state.tasks[2].images[0].id==="img-1" &&
   requests.some(request=>request.type==="ENQUEUE_FAVORITE" &&
    request.favoriteId==="fav-1" && request.requestId);
  result.noImmediateSend=!requests.some(request=>
   ["SENT","STEER_CLAIM","STEER_CLICKED"].includes(request.type));
  q('[data-action="favorite-task"][data-id="p2"]').click();
  await until(()=>favorites.length===0 && q('[data-action="favorite-task"][data-id="p2"]')?.textContent==="☆");
  result.deleteKeepsQueue=favorites.length===0 && state.tasks.length===3;
  q('[data-action="toggle-favorites"]').click();
  q('[data-action="toggle-favorites"]').click();
  q('[data-action="save-current-favorite"]').click();
  await until(()=>favorites.length===1);
  result.saveComposer=favorites[0].text==="输入框文字" &&
   q("#prompt-textarea")===null && document.querySelector("#prompt-textarea").value==="输入框文字";
  favorites[0].category="效率";
  favorites[0].useCount=3;
  onStorageChange?.({"cq.state.v2":{newValue:{
   conversations:{"draft:1":state},favorites:[...favorites],
  }}},"local");
  const categories=q("#cq-favorite-category");
  result.categoriesAvailable=[...categories.options].some(item=>item.value==="cat:效率") &&
    q(".cq-favorite-meta")?.textContent.includes("已复用 3 次");
  categories.value="cat:效率";categories.dispatchEvent(new Event("change",{bubbles:true}));
  result.categoryFilter=q(".cq-favorite-row")?.dataset.favoriteId==="fav-2";
  q("#cq-favorite-category").value="__none__";
  q("#cq-favorite-category").dispatchEvent(new Event("change",{bubbles:true}));
  result.uncategorizedFilter=!q(".cq-favorite-row");
  q("#cq-favorite-category").value="";
  q("#cq-favorite-category").dispatchEvent(new Event("change",{bubbles:true}));
  q('[data-action="favorites-pinned-only"]').click();
  result.pinnedFilterEmpty=!q(".cq-favorite-row");
  q('[data-action="favorites-pinned-only"]').click();
  await until(()=>q('[data-action="pin-favorite"][data-id="fav-2"]')?.disabled===false);
  q('[data-action="pin-favorite"][data-id="fav-2"]').click();
  await until(()=>favorites[0]?.pinned===true &&
   q('[data-action="pin-favorite"][data-id="fav-2"]')?.getAttribute("aria-pressed")==="true");
  result.pin=!!favorites[0].pinned &&
   !!q(".cq-pinned-mark") && requests.some(request=>
    request.type==="UPDATE_FAVORITE" && request.pinned===true);
  await until(()=>q('[data-action="pin-favorite"][data-id="fav-2"]')?.disabled===false);
  q('[data-action="pin-favorite"][data-id="fav-2"]').click();
  await until(()=>favorites[0]?.pinned===false);
  result.unpin=favorites[0]?.pinned===false;
  document.querySelector("main").style.width="345px";
  await wait(50);
  result.noOverflow=q(".cq-inline").scrollWidth<=q(".cq-inline").clientWidth+2;
 }catch(error){result.error=error.stack || String(error);}
 result.ok=["entry","savedImage","library","searchStable","imePreserved",
  "imageNameSearch","reenqueue","noImmediateSend","deleteKeepsQueue",
  "saveComposer","categoriesAvailable","categoryFilter","uncategorizedFilter",
  "pinnedFilterEmpty","pin","unpin","noOverflow"].every(key=>result[key]===true);
 document.body.dataset.test=JSON.stringify(result);
},350);
</script></body></html>`);
    const run=spawnSync(browser,[
      "--headless=new","--disable-gpu","--disable-extensions","--no-first-run",
      "--window-size=1000,900",`--user-data-dir=${path.join(dir,"profile")}`,
      "--virtual-time-budget=11000","--dump-dom",
      `file:///${path.join(dir,"index.html").replace(/\\/g,"/")}`,
    ],{encoding:"utf8",timeout:30000,maxBuffer:10e6});
    assert.equal(run.status,0,run.stderr || "Chrome failed");
    const match=run.stdout.match(/data-test="([^"]+)"/);
    assert.ok(match,"Chrome did not finish the favorites queue test");
    const result=JSON.parse(match[1].replace(/&quot;/g,'"').replace(/&amp;/g,"&"));
    assert.equal(result.ok,true,JSON.stringify(result,null,2));
  } finally {fs.rmSync(dir,{recursive:true,force:true,maxRetries:12,retryDelay:250});}
});
