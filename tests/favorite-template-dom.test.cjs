"use strict";

const {test} = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const {spawnSync} = require("node:child_process");

const browser = process.env.CQ_BROWSER_BIN || (process.platform === "win32"
  ? "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"
  : "/usr/bin/google-chrome");

test("真实浏览器：显式变量模板填写/预览/图文入队，普通收藏不受影响",{
  skip:!fs.existsSync(browser) && "Edge/Chrome is not installed",
},()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"cq-template-dom-"));
  try {
    const original=fs.readFileSync(path.join(__dirname,"..","content.js"),"utf8");
    fs.writeFileSync(path.join(dir,"content.js"),original.replace(
      "  function boundHere() {",
      "  function boundHere() { return true; }\n  function originalBoundHere() {"));
    fs.copyFileSync(path.join(__dirname,"..","panel.css"),path.join(dir,"panel.css"));
    fs.writeFileSync(path.join(dir,"index.html"),`<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><link rel="stylesheet" href="panel.css">
<style>main {width:740px;max-width:100%;margin:16px auto} form {display:block}</style></head>
<body><main><form><textarea id="prompt-textarea"></textarea>
<button type="button" data-testid="send-button" aria-label="Send">Send</button>
</form></main>
<script>
const img={id:"original-png",name:"地图.png",type:"image/png",
 size:42,thumbnail:"data:image/jpeg;base64,YWJj"};
const favorites=[
 {id:"literal",title:"旧代码",text:"原文 {{变量}}",images:[],templateEnabled:false},
 {id:"dynamic",title:"西幻剧情模版",
  text:"改写 {{项目名}} 的 {{任务目标}}，再检查 {{项目名}}。",
  images:[img],templateEnabled:true,category:"剧情",pinned:true},
 {id:"escaped",title:"字面占位符",
  text:"指令 {{主题}}，展示 \\\\{{不替换}}。",
  images:[],templateEnabled:true},
];
const state={key:"draft:1",tasks:[],schedules:[],halted:false,queuePaused:false,
  activeTaskId:null,steeringTaskId:null,autoOpenTab:false};
const messages=[];
let storageChanged;
window.confirm=()=>true;
window.chrome={runtime:{
 onMessage:{addListener(){}},
 async sendMessage(message){
  messages.push({...message});
  if(message.type==="GET_FAVORITES")return {ok:true,favorites};
  if(message.type==="ENQUEUE_FAVORITE"){
   const favorite=favorites.find(x=>x.id===message.favoriteId);
   if(!favorite)return {ok:false,error:"不存在"};
   const values=message.templateValues || {};
   const text=favorite.templateEnabled
    ? favorite.text.replace(/\\\\?\\{\\{([^{}\\r\\n]*)\\}\\}/g,(token,name)=>
      token.startsWith("\\\\")?token.slice(1):values[name.trim()])
    : favorite.text;
   state.tasks.push({id:"task-"+state.tasks.length,text,status:"pending",
    images:[...(favorite.images||[])]});
  }
  return {ok:true,state,sessionKey:"draft:1",settings:{maxPending:100}};
 },
},storage:{onChanged:{addListener(fn){storageChanged=fn;}}}};
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const until=async fn=>{for(let i=0;i<100;i++){if(fn())return true;await wait(30);}return !!fn();};
const q=sel=>document.querySelector("#cq-extension-root "+sel);
const row=id=>q('.cq-favorite-row[data-favorite-id="'+id+'"]');
const setField=(index,value,isComposing=false)=>{
 const field=q('#cq-template-value-'+index);
 field.value=value;
 field.dispatchEvent(new InputEvent("input",{bubbles:true,isComposing,data:value,
   inputType:"insertText"}));
 return field;
};
const refresh=()=>storageChanged?.({"cq.state.v2":{newValue:{
 conversations:{"draft:1":state},favorites,
}}},"local");
</script>
<script src="content.js"></script>
<script>
setTimeout(async()=>{
 const r={};
 try{
  await until(()=>!!q('[data-action="toggle-favorites"]'));
  q('[data-action="toggle-favorites"]').click();
  r.available=!!row("dynamic") && !!row("literal") &&
   row("dynamic").querySelector('[data-action="enqueue-favorite"]')?.textContent.includes("填写入队") &&
   !row("literal").querySelector('[data-action="enqueue-favorite"]')?.textContent.includes("填写入队");
  row("literal").querySelector('[data-action="enqueue-favorite"]').click();
  await until(()=>state.tasks.length===1);
  r.legacy=state.tasks[0]?.text==="原文 {{变量}}" &&
    !row("literal")?.querySelector(".cq-template-compose") &&
    !messages.find(x=>x.type==="ENQUEUE_FAVORITE"&&x.favoriteId==="literal")?.templateValues;
  await until(()=>row("dynamic")?.querySelector('[data-action="enqueue-favorite"]')?.disabled===false);
  row("dynamic").querySelector('[data-action="enqueue-favorite"]').click();
  r.opened=await until(()=>!!row("dynamic")?.querySelector(".cq-template-compose"));
  r.editor=!!q("#cq-template-value-0") && !!q("#cq-template-value-1") &&
    q('[data-action="confirm-favorite-template"]')?.disabled===true &&
    q(".cq-template-status")?.textContent.includes("项目名");
  if(!r.editor)throw new Error("模板表单字段缺失");
  const field0=setField(0,"Aetherwild");
  r.partial=q(".cq-template-preview")?.textContent.includes("Aetherwild") &&
    q(".cq-template-preview")?.textContent.includes("《待填：任务目标》") &&
    q('[data-action="confirm-favorite-template"]')?.disabled===true;
  field0.focus();
  field0.setSelectionRange(4,4);
  refresh();
  r.focusAfterRefresh=document.activeElement?.id==="cq-template-value-0" &&
    q("#cq-template-value-0")?.value==="Aetherwild" &&
    q("#cq-template-value-0")?.selectionStart===4 &&
    document.querySelector("#cq-extension-root").dataset.cqUnsavedDraft==="true";
  const field1=q("#cq-template-value-1");
  field1.focus();
  field1.dispatchEvent(new CompositionEvent("compositionstart",{bubbles:true}));
  const text="<img src=x onerror=alert(1)> $& 骑士与恶龙";
  setField(1,text,true);
  refresh();
  r.imeStable=q("#cq-template-value-1")===field1 &&
    document.activeElement===field1;
  field1.dispatchEvent(new CompositionEvent("compositionend",{bubbles:true}));
  r.ready=q(".cq-template-preview")?.textContent.includes(text) &&
    !q(".cq-template-preview img") &&
    q('[data-action="confirm-favorite-template"]')?.disabled===false &&
    q(".cq-template-preview")?.textContent.split("Aetherwild").length===3;
  const confirm=q('[data-action="confirm-favorite-template"]');
  confirm.click();
  confirm.click();
  await until(()=>state.tasks.length===2 && !q(".cq-template-compose"));
  r.queued=state.tasks.length===2 &&
    state.tasks[1].text==="改写 Aetherwild 的 "+text+"，再检查 Aetherwild。" &&
    state.tasks[1].images[0].id==="original-png" &&
    favorites[1].text.includes("{{项目名}}") &&
    messages.filter(x=>x.type==="ENQUEUE_FAVORITE"&&x.favoriteId==="dynamic").length===1 &&
    messages.find(x=>x.type==="ENQUEUE_FAVORITE"&&x.favoriteId==="dynamic")?.templateValues["项目名"]==="Aetherwild" &&
    !document.querySelector("#cq-extension-root").dataset.cqUnsavedDraft.includes("true");
  await until(()=>row("escaped")?.querySelector('[data-action="enqueue-favorite"]')?.disabled===false);
  row("escaped").querySelector('[data-action="enqueue-favorite"]').click();
  await until(()=>!!q(".cq-template-compose"));
  setField(0,"世界观");
  r.escape=q(".cq-template-preview")?.textContent==="指令 世界观，展示 {{不替换}}。";
  q('[data-action="confirm-favorite-template"]').click();
  await until(()=>state.tasks.length===3);
  r.escapeQueued=state.tasks[2]?.text==="指令 世界观，展示 {{不替换}}。";
  await until(()=>row("dynamic")?.querySelector('[data-action="enqueue-favorite"]')?.disabled===false);
  row("dynamic").querySelector('[data-action="enqueue-favorite"]').click();
  await until(()=>!!row("dynamic")?.querySelector(".cq-template-compose"));
  setField(0,"另一款游戏");
  favorites[1].text="新版 {{项目名}} 新内容";
  refresh();
  r.staleBlocked=q(".cq-template-status")?.textContent.includes("模板已更新") &&
    q('[data-action="confirm-favorite-template"]')?.disabled===true;
  q('[data-action="cancel-favorite-template"]').click();
  r.cancelled=!q(".cq-template-compose") && state.tasks.length===3;
  document.querySelector("main").style.width="335px";
  await wait(70);
  r.narrow=q(".cq-inline")?.scrollWidth<=q(".cq-inline")?.clientWidth+2;
  r.noUnexpectedSend=!messages.some(x=>["SENT","STEER_CLAIM","STEER_CLICKED"].includes(x.type));
 }catch(error){r.error=error.stack||String(error);}
 r.ok=["available","legacy","opened","editor","partial","focusAfterRefresh",
  "imeStable","ready","queued","escape","escapeQueued","staleBlocked",
  "cancelled","narrow","noUnexpectedSend"].every(k=>r[k]===true);
 document.body.dataset.test=JSON.stringify(r);
},400);
</script></body></html>`);
    const run=spawnSync(browser,[
      "--headless=new","--disable-gpu","--disable-extensions","--no-first-run",
      "--window-size=980,900",`--user-data-dir=${path.join(dir,"profile")}`,
      "--virtual-time-budget=14000","--dump-dom",
      `file:///${path.join(dir,"index.html").replace(/\\/g,"/")}`,
    ],{encoding:"utf8",timeout:32000,maxBuffer:11e6});
    assert.equal(run.status,0,run.stderr||"Browser startup failed");
    const match=run.stdout.match(/data-test="([^"]+)"/);
    assert.ok(match,"Browser did not complete template UI assertions");
    const result=JSON.parse(match[1].replace(/&quot;/g,'"').replace(/&amp;/g,"&"));
    assert.equal(result.ok,true,JSON.stringify(result,null,2));
  }finally{fs.rmSync(dir,{recursive:true,force:true,maxRetries:12,retryDelay:250});}
});
