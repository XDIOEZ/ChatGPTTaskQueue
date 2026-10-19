"use strict";

const {test} = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const {spawnSync} = require("node:child_process");

const browser = process.env.CQ_BROWSER_BIN || (process.platform === "win32"
  ? "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe" : "/usr/bin/google-chrome");

test("真实浏览器：收藏分类、置顶、完整正文编辑、筛选及长文草稿保护",{
  skip:!fs.existsSync(browser) && "browser is not installed",
},()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"cq-favorite-organize-"));
  try {
    for(const file of ["favorites.js","favorites.css"]) {
      fs.copyFileSync(path.join(__dirname,"..",file),path.join(dir,file));
    }
    const html=fs.readFileSync(path.join(__dirname,"..","favorites.html"),"utf8")
      .replace('<script src="favorites.js" defer></script>',
        '<script src="mock.js"></script><script src="favorites.js" defer></script>');
    fs.writeFileSync(path.join(dir,"favorites.html"),html);
    fs.writeFileSync(path.join(dir,"mock.js"),`"use strict";
const saved=[
 {id:"a",title:"代码审查",text:"原始代码问题",category:"代码",pinned:false,
  images:[],createdAt:1000,updatedAt:1000,useCount:2,lastUsedAt:5000},
 {id:"b",title:"未分类脚本",text:"简短提示词",images:[],createdAt:2000,updatedAt:2000},
 {id:"c",title:"剧情规划",text:"打败恶龙",category:"剧情",pinned:false,
  images:[],createdAt:3000,updatedAt:3000,useCount:4,lastUsedAt:7000},
];
const calls=[];
let storageChanged;
window.chrome={runtime:{
 getURL(path){return "chrome-extension://test-queue/"+path;},
 async sendMessage(message){
  calls.push({...message});
  if(message.type==="ADD_FAVORITE") {
   saved.unshift({id:"d",title:message.title || "自动标题",text:message.text,
    category:message.category,pinned:false,images:[],templateEnabled:message.templateEnabled,
    createdAt:4000,updatedAt:4000});
  } else if(message.type==="UPDATE_FAVORITE"){
   const item=saved.find(item=>item.id===message.id);
   if(!item)return {ok:false,error:"不存在"};
   for(const field of ["title","text","category","pinned","templateEnabled"]) {
    if(Object.hasOwn(message,field))item[field]=message[field];
   }
  } else if(message.type==="DELETE_FAVORITE"){
   saved.splice(saved.findIndex(item=>item.id===message.id),1);
  }
  if(message.type!=="GET_FAVORITES"){
   storageChanged?.({"cq.state.v2":{newValue:{favorites:saved.map(item=>({...item}))}}},"local");
  }
  return {ok:true,favorites:saved.map(item=>({...item}))};
 },
},tabs:{async create(){}},storage:{onChanged:{addListener(fn){storageChanged=fn;}}}};
window.confirm=()=>true;
window.prompt=()=>"已改名";
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const until=async fn=>{for(let i=0;i<100;i++){if(fn())return true;await wait(25);}return !!fn();};
const q=selector=>document.querySelector(selector);
const cards=()=>[...document.querySelectorAll(".favorite[data-id]")];
const card=id=>cards().find(el=>el.dataset.id===id);
const choose=(value)=>{const el=q("#filter-category");el.value=value;el.dispatchEvent(new Event("change",{bubbles:true}));};
const input=(el,value)=>{el.value=value;el.dispatchEvent(new Event("input",{bubbles:true}));};
setTimeout(async()=>{
 const r={};
 try{
  await until(()=>cards().length===3);
  r.initial=cards().length===3 && q("#pinned-count")?.textContent.includes("0") &&
    [...q("#filter-category").options].some(o=>o.value==="cat:代码") &&
    [...q("#filter-category").options].some(o=>o.value==="__none__");
  r.usage=card("c")?.textContent.includes("已复用 4 次");
  q("#new-title").value="角色设计";
  q("#new-category").value="角色";
  q("#new-text").value="写一个 {{王国名}} 骑士";
  const addTemplate=q("#new-template-enabled");
  r.templateOption=addTemplate?.checked===false;
  addTemplate.checked=true;
  q("#add-favorite-form").dispatchEvent(new Event("submit",{bubbles:true,cancelable:true}));
  await until(()=>cards().length===4);
  r.addCategory=saved[0].category==="角色" &&
   [...q("#filter-category").options].some(o=>o.value==="cat:角色") &&
   [...q("#favorite-categories").options].some(o=>o.value==="角色");
  r.templateCreated=saved[0].templateEnabled===true &&
    !!card("d")?.querySelector(".favorite-template-label") &&
    calls.some(x=>x.type==="ADD_FAVORITE"&&x.templateEnabled===true);
  await until(()=>card("c")?.querySelector('[data-action="pin"]')?.disabled===false);
  choose("cat:角色");
  r.categoryFilter=cards().map(el=>el.dataset.id).join(",")==="d";
  choose("__none__");
  r.uncategorized=cards().map(el=>el.dataset.id).join(",")==="b";
  choose("");
  q("#pinned-only").click();
  r.emptyPinned=cards().length===0 && q("#pinned-only")?.getAttribute("aria-pressed")==="true";
  q("#pinned-only").click();
  card("c").querySelector('[data-action="pin"]').click();
  await until(()=>saved.find(x=>x.id==="c")?.pinned===true &&
   cards()[0]?.dataset.id==="c");
  r.pin=cards()[0]?.dataset.id==="c" &&
   q("#pinned-count")?.textContent.includes("1") &&
   card("c")?.querySelector('[data-action="pin"]')?.getAttribute("aria-pressed")==="true";
  q("#sort-favorites").value="name";
  q("#sort-favorites").dispatchEvent(new Event("change",{bubbles:true}));
  r.pinnedFirstWhenSorted=cards()[0]?.dataset.id==="c";
  q("#sort-favorites").value="popular";
  q("#sort-favorites").dispatchEvent(new Event("change",{bubbles:true}));
  r.popularSort=cards()[0]?.dataset.id==="c" && cards()[1]?.dataset.id==="a";
  await until(()=>card("c")?.querySelector('[data-action="edit"]')?.disabled===false);
  card("c").querySelector('[data-action="edit"]').click();
  const editor=card("c").querySelector(".favorite-editor");
  r.editor=!!editor && editor.querySelector('[name="category"]')?.value==="剧情" &&
    editor.querySelector('[name="text"]')?.value==="打败恶龙";
  const title=editor.querySelector('[name="title"]');
  title.focus();input(title,"英雄旅程");
  const category=editor.querySelector('[name="category"]');
  input(category,"故事");
  const text=editor.querySelector('[name="text"]');
  input(text,"<img src=x onerror=alert(3)>改写后的长正文");
  text.focus();text.setSelectionRange(9,9);
  storageChanged?.({"cq.state.v2":{newValue:{favorites:saved.map(x=>({...x}))}}},"local");
  r.draftProtected=card("c").querySelector('[name="text"]')===text &&
    document.activeElement===text && text.value.includes("<img") &&
    text.selectionStart===9;
  editor.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true}));
  await until(()=>saved.find(x=>x.id==="c")?.title==="英雄旅程" &&
    !card("c")?.querySelector(".favorite-editor"));
  r.edited=saved.find(x=>x.id==="c")?.category==="故事" &&
    saved.find(x=>x.id==="c")?.text.includes("改写后的长正文") &&
    !!card("c")?.querySelector(".favorite-text")?.textContent.includes("<img") &&
    !card("c")?.querySelector(".favorite-text img");
  choose("cat:故事");
  r.newCategory=cards().length===1 && cards()[0].dataset.id==="c";
  await until(()=>card("c")?.querySelector('[data-action="pin"]')?.disabled===false);
  card("c").querySelector('[data-action="pin"]').click();
  await until(()=>saved.find(x=>x.id==="c")?.pinned===false);
  r.unpin=saved.find(x=>x.id==="c")?.pinned===false;
  choose("");
  q("#search-favorites").value="故事";
  q("#search-favorites").dispatchEvent(new Event("input",{bubbles:true}));
  r.categorySearch=cards().length===1 && cards()[0].dataset.id==="c";
  q("#search-favorites").value="";
  q("#search-favorites").dispatchEvent(new Event("input",{bubbles:true}));
  await until(()=>card("d")?.querySelector('[data-action="edit"]')?.disabled===false);
  card("d").querySelector('[data-action="edit"]').click();
  const toggle=card("d")?.querySelector('.favorite-editor [name="templateEnabled"]');
  r.templateEditAvailable=toggle?.checked===true;
  toggle.checked=false;
  toggle.dispatchEvent(new Event("input",{bubbles:true}));
  card("d").querySelector(".favorite-editor").dispatchEvent(new Event("submit",{
    bubbles:true,cancelable:true,
  }));
  await until(()=>saved.find(x=>x.id==="d")?.templateEnabled===false &&
    !card("d")?.querySelector(".favorite-editor"));
  r.templateDisabled=saved.find(x=>x.id==="d")?.templateEnabled===false &&
    !card("d")?.querySelector(".favorite-template-label");
  r.noAccidentalEnqueue=!calls.some(c=>/ENQUEUE/.test(c.type));
  r.narrowNoOverflow=document.documentElement.scrollWidth<=window.innerWidth+2;
 }catch(e){r.error=e.stack||String(e);}
 r.ok=["initial","usage","templateOption","templateCreated","addCategory","categoryFilter","uncategorized",
  "emptyPinned","pin","pinnedFirstWhenSorted","popularSort","editor",
  "draftProtected","edited","newCategory","unpin","categorySearch",
  "templateEditAvailable","templateDisabled",
  "noAccidentalEnqueue","narrowNoOverflow"].every(k=>r[k]===true);
 document.body.dataset.test=JSON.stringify(r);
},300);`);
    const run=spawnSync(browser,[
      "--headless=new","--disable-gpu","--disable-extensions","--no-first-run",
      "--window-size=430,940",`--user-data-dir=${path.join(dir,"profile")}`,
      "--virtual-time-budget=13000","--dump-dom",
      `file:///${path.join(dir,"favorites.html").replace(/\\/g,"/")}`,
    ],{encoding:"utf8",timeout:30000,maxBuffer:11e6});
    assert.equal(run.status,0,run.stderr||"Browser failed");
    const match=run.stdout.match(/data-test="([^"]+)"/);
    assert.ok(match,"Browser did not finish favorites organization test");
    const flags=JSON.parse(match[1].replace(/&quot;/g,'"').replace(/&amp;/g,"&"));
    assert.equal(flags.ok,true,JSON.stringify(flags,null,2));
  }finally{fs.rmSync(dir,{recursive:true,force:true,maxRetries:12,retryDelay:250});}
});
