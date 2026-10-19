"use strict";

const {test} = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const {spawnSync} = require("node:child_process");

const browser = process.env.CQ_BROWSER_BIN || (process.platform === "win32"
  ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" : "/usr/bin/google-chrome");

test("真实 Chrome：独立提示词收藏管理页可新增、搜索、改名、删除且转义不可信内容", {
  skip: !fs.existsSync(browser) && "Chrome is not installed",
}, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),"cq-favorites-dom-"));
  try {
    for (const file of ["favorites.js","favorites.css"]) {
      fs.copyFileSync(path.join(__dirname,"..",file),path.join(dir,file));
    }
    const html = fs.readFileSync(path.join(__dirname,"..","favorites.html"),"utf8")
      .replace('<script src="favorites.js" defer></script>',
        '<script src="mock.js"></script><script src="favorites.js" defer></script>');
    fs.writeFileSync(path.join(dir,"favorites.html"),html);
    fs.writeFileSync(path.join(dir,"mock.js"),`"use strict";
const saved = [{
  id:"old", title:"<img src=x onerror=alert(1)>安全标题",
  text:"危险<img src=x onerror=alert(2)>内容",images:[],
  createdAt:Date.now()-10000,updatedAt:Date.now()-10000,
}];
const calls=[];
let onStorageChange=null;
window.chrome={
 runtime:{
  getURL(path){return "chrome-extension://test-queue/"+path;},
  async sendMessage(message){
   calls.push({...message});
   if(message.type==="ADD_FAVORITE"){
    if(!message.text.trim())return {ok:false,error:"不能为空"};
    saved.unshift({id:"new",text:message.text,title:message.title || "自动摘要",
      images:[],createdAt:Date.now(),updatedAt:Date.now()});
   } else if(message.type==="RENAME_FAVORITE"){
    saved.find(item=>item.id===message.id).title=message.title;
   } else if(message.type==="DELETE_FAVORITE"){
    saved.splice(saved.findIndex(item=>item.id===message.id),1);
   }
   return {ok:true,favorites:saved.map(item=>({...item}))};
  },
 },
 tabs:{async create(data){calls.push({type:"CREATE_TAB",...data});}},
 storage:{onChanged:{addListener(fn){onStorageChange=fn;}}},
};
window.prompt=()=>"已重命名";
window.confirm=()=>true;
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const until=async fn=>{for(let i=0;i<80;i++){if(fn())return true;await wait(30);}return !!fn();};
const q=selector=>document.querySelector(selector);
const click=(action,id)=>q('[data-action="'+action+'"][data-id="'+id+'"]')?.click();
setTimeout(async()=>{
 const result={};
 try{
  await until(()=>q("#favorite-count")?.textContent==="1");
  result.loaded=q("#favorite-count")?.textContent==="1" &&
   q(".favorite-head h3")?.textContent.includes("<img") &&
   !q(".favorite-head h3 img");
  const title=q("#new-title"),text=q("#new-text");
  title.value="常用";text.value="新的常用提示词";
  q("#add-favorite-form").dispatchEvent(new Event("submit",{cancelable:true,bubbles:true}));
  await until(()=>q("#favorite-count")?.textContent==="2");
  result.add=q("#favorite-count").textContent==="2" &&
   calls.some(c=>c.type==="ADD_FAVORITE" && c.title==="常用") &&
   !q("#new-text").value;
  const search=q("#search-favorites");
  search.value="新的常用";
  search.dispatchEvent(new Event("input",{bubbles:true}));
  result.search=q("#result-count").textContent.includes("1 / 2") &&
   q(".favorite-head h3")?.textContent==="常用";
  search.value="";search.dispatchEvent(new Event("input",{bubbles:true}));
  click("rename","new");
  await until(()=>q(".favorite-head h3")?.textContent==="已重命名");
  result.rename=calls.some(c=>c.type==="RENAME_FAVORITE" && c.title==="已重命名");
  click("delete","new");
  await until(()=>q("#favorite-count")?.textContent==="1");
  result.delete=calls.some(c=>c.type==="DELETE_FAVORITE" && c.id==="new") &&
   q("#favorite-count")?.textContent==="1";
  q("#open-dashboard").click();
  await until(()=>calls.some(c=>c.type==="CREATE_TAB"));
  result.dashboardLink=calls.some(c=>c.type==="CREATE_TAB" &&
   c.url==="chrome-extension://test-queue/dashboard.html?view=full");
  result.noUnexpectedEnqueue=!calls.some(c=>c.type==="ENQUEUE_FAVORITE");
  result.noHorizontalOverflow=document.documentElement.scrollWidth<=window.innerWidth+2;
 }catch(error){result.error=error.stack || String(error);}
 result.ok=["loaded","add","search","rename","delete","dashboardLink",
  "noUnexpectedEnqueue","noHorizontalOverflow"].every(key=>result[key]===true);
 document.body.dataset.test=JSON.stringify(result);
},250);`);
    const run = spawnSync(browser,[
      "--headless=new","--disable-gpu","--disable-extensions","--no-first-run",
      "--window-size=390,860",`--user-data-dir=${path.join(dir,"profile")}`,
      "--virtual-time-budget=8000","--dump-dom",
      `file:///${path.join(dir,"favorites.html").replace(/\\/g,"/")}`,
    ],{encoding:"utf8",timeout:27000,maxBuffer:10e6});
    assert.equal(run.status,0,run.stderr || "Chrome failed");
    const match = run.stdout.match(/data-test="([^"]+)"/);
    assert.ok(match,"Chrome did not finish the favorites test");
    const result = JSON.parse(match[1].replace(/&quot;/g,'"').replace(/&amp;/g,"&"));
    assert.equal(result.ok,true,JSON.stringify(result,null,2));
  } finally {fs.rmSync(dir,{recursive:true,force:true,maxRetries:12,retryDelay:250});}
});
