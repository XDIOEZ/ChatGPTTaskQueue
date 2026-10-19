"use strict";

const {test} = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const {createHash} = require("node:crypto");
const {spawnSync} = require("node:child_process");

const browser = process.env.CQ_BROWSER_BIN || (process.platform === "win32"
  ? "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe" : "/usr/bin/google-chrome");
const dataUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lSkAAAAASUVORK5CYII=";
const sha256 = createHash("sha256").update(dataUrl).digest("hex");

test("真实浏览器：收藏夹 JSON 含完整原图导出、选择备份合并导入、进度和文件安全",{
  skip:!fs.existsSync(browser) && "browser is not installed",
},()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"cq-favorites-backup-"));
  try{
    for(const filename of ["favorites.js","favorites.css"]) {
      fs.copyFileSync(path.join(__dirname,"..",filename),path.join(dir,filename));
    }
    const html=fs.readFileSync(path.join(__dirname,"..","favorites.html"),"utf8")
      .replace('<script src="favorites.js" defer></script>',
        '<script src="mock.js"></script><script src="favorites.js" defer></script>');
    fs.writeFileSync(path.join(dir,"favorites.html"),html);
    fs.writeFileSync(path.join(dir,"mock.js"),`"use strict";
const image={id:"img-1",name:"原图.png",type:"image/png",size:68,
 dataUrl:${JSON.stringify(dataUrl)},thumbnail:"data:image/jpeg;base64,YWJj",
 sha256:${JSON.stringify(sha256)}};
const initial=[{id:"fav-a",title:"完整图文",text:"<img src=x onerror=alert(1)> 隐私内容",
 category:"图文",pinned:true,images:[{id:image.id,name:image.name,
 type:image.type,size:image.size,thumbnail:image.thumbnail}],
 useCount:2,lastUsedAt:1700000000000,createdAt:1700000000000,updatedAt:1700000000000}];
const favorites=[...initial],calls=[];
let stage=null,allowImport=true;
window.mockCalls=calls;
window.chrome={
 runtime:{getURL(path){return "chrome-extension://test-queue/"+path;},
  async sendMessage(message){
   calls.push({...message});
   if(message.type==="GET_FAVORITES")return {ok:true,favorites:[...favorites]};
   if(message.type==="GET_FAVORITES_BACKUP_META")return {ok:true,backup:{
    format:"chatgpt-taskqueue-favorites",version:1,
    favorites:favorites.map(f=>({...f,images:(f.images||[]).map(x=>({id:x.id}))})),
    images:[{id:image.id,name:image.name,type:image.type,size:image.size}],
   }};
   if(message.type==="GET_FAVORITES_BACKUP_IMAGE")return {ok:true,image:{...image}};
   if(message.type==="RESTORE_FAVORITES_BEGIN"){
    stage={token:"test-import",backup:message.backup,received:[]};
    return {ok:true,token:stage.token,images:stage.backup.images.length,
     favorites:stage.backup.favorites.length};
   }
   if(message.type==="RESTORE_FAVORITES_IMAGE"){
    if(!stage || message.token!==stage.token)return {ok:false,error:"stage gone"};
    await new Promise(resolve=>setTimeout(resolve,30));
    stage.received.push(message.image);
    return {ok:true};
   }
   if(message.type==="RESTORE_FAVORITES_FINISH"){
    if(!stage || message.token!==stage.token)return {ok:false,error:"stage gone"};
    const add=stage.backup.favorites.filter(f=>f.text==="导入的新模板");
    for(const f of add)favorites.push({...f,id:"imported",images:stage.received.map(img=>({
      id:img.id,name:img.name,type:img.type,size:img.size,thumbnail:img.thumbnail,
    }))});
    stage=null;
    return {ok:true,imported:add.length,
     skipped:message.token==="test-import"?1:0,favorites:[...favorites]};
   }
   if(message.type==="RESTORE_FAVORITES_ABORT"){stage=null;return {ok:true};}
   return {ok:false,error:"unsupported "+message.type};
  }
 },
 tabs:{async create(){}},
 storage:{onChanged:{addListener(){}}},
};
let capturedBlob=null;
const oldCreate=URL.createObjectURL.bind(URL);
URL.createObjectURL=(blob)=>{capturedBlob=blob;return oldCreate(blob);};
let downloadName=null;
HTMLAnchorElement.prototype.click=function(){downloadName=this.download;};
window.confirm=()=>allowImport;
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const until=async fn=>{for(let i=0;i<90;i++){if(fn())return true;await wait(30);}return Boolean(fn());};
const q=s=>document.querySelector(s);
const choose=(data)=>{
 const input=q("#import-favorites");
 const file=new File([JSON.stringify(data)],"backup.json",{type:"application/json"});
 const transfer=new DataTransfer();transfer.items.add(file);input.files=transfer.files;
 input.dispatchEvent(new Event("change",{bubbles:true}));
};
setTimeout(async()=>{
 const r={};
 try{
  await until(()=>q(".favorite[data-id='fav-a']"));
  r.entry=!!q("#export-favorites") && !!q("#import-favorites") &&
    !!q(".backup-hint")?.textContent.includes("完整提示词");
  q("#export-favorites").click();
  await until(()=>!!capturedBlob && q("#backup-status")?.textContent.includes("已生成完整备份"));
  const exported=JSON.parse(await capturedBlob.text());
  r.export=downloadName?.startsWith("ChatGPTQueue-Favorites-") &&
    exported.images[0].dataUrl===image.dataUrl &&
    exported.images[0].sha256===image.sha256 &&
    exported.favorites[0].category==="图文" &&
    exported.favorites[0].images[0].id===image.id;
  r.privacyText=q(".favorite-text")?.textContent.includes("<img") &&
    !q(".favorite-text img") && q(".backup-hint")?.textContent.includes("未加密");
  // A wrong format is rejected on the client before any image upload.
  const startsBefore=calls.filter(x=>x.type==="RESTORE_FAVORITES_BEGIN").length;
  choose({...exported,format:"not-a-backup"});
  await until(()=>q("#feedback")?.textContent.includes("不是支持的收藏夹备份"));
  r.invalidRejected=calls.filter(x=>x.type==="RESTORE_FAVORITES_BEGIN").length===startsBefore;
  allowImport=false;
  choose(exported);
  await until(()=>q("#backup-status")?.textContent.includes("已取消本次导入"));
  r.cancelled=!stage;
  allowImport=true;
  const copy={...exported,favorites:[...exported.favorites,{
   title:"新导入的模板",text:"导入的新模板",category:"代码",pinned:false,
   useCount:0,images:[{id:image.id}],createdAt:Date.now(),updatedAt:Date.now(),
  }]};
  choose(copy);
  await until(()=>q("#backup-status")?.textContent.includes("导入完成"));
  r.import=!!calls.find(x=>x.type==="RESTORE_FAVORITES_BEGIN") &&
    !!calls.find(x=>x.type==="RESTORE_FAVORITES_IMAGE") &&
    !!calls.find(x=>x.type==="RESTORE_FAVORITES_FINISH") &&
    q("#backup-status")?.textContent.includes("新增 1 条") &&
    q("#backup-status")?.textContent.includes("跳过重复 1 条") &&
    !!q(".favorite[data-id='imported']");
  r.noEnqueue=!calls.some(x=>x.type==="ENQUEUE_FAVORITE" || x.type==="CLAIM");
  r.noOverflow=document.documentElement.scrollWidth<=window.innerWidth+2;
 }catch(error){r.error=error.stack||String(error);}
 r.ok=["entry","export","privacyText","invalidRejected","cancelled",
  "import","noEnqueue","noOverflow"].every(key=>r[key]===true);
 document.body.dataset.test=JSON.stringify(r);
},300);`);
    const run=spawnSync(browser,[
      "--headless=new","--disable-gpu","--disable-extensions","--no-first-run",
      "--window-size=420,900",`--user-data-dir=${path.join(dir,"profile")}`,
      "--virtual-time-budget=12000","--dump-dom",
      `file:///${path.join(dir,"favorites.html").replace(/\\/g,"/")}`,
    ],{encoding:"utf8",timeout:35000,maxBuffer:11e6});
    assert.equal(run.status,0,run.stderr||"Browser failed");
    const match=run.stdout.match(/data-test="([^"]+)"/);
    assert.ok(match,"Browser did not finish favorites backup test");
    const result=JSON.parse(match[1].replace(/&quot;/g,'"').replace(/&amp;/g,"&"));
    assert.equal(result.ok,true,JSON.stringify(result,null,2));
  }finally{fs.rmSync(dir,{recursive:true,force:true,maxRetries:12,retryDelay:250});}
});
