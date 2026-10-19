"use strict";

const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const os=require("node:os");
const {spawnSync}=require("node:child_process");

const browser=process.env.CQ_BROWSER_BIN || (process.platform==="win32"
  ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
  : "/usr/bin/google-chrome");

test("真实 Chrome 宽屏管理：独立管理页多列布局、长列表、筛选排序和焦点保护",{
  skip:!fs.existsSync(browser) && "Chrome is not installed",
},()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),"cq-dashboard-full-"));
  try {
    fs.copyFileSync(path.join(__dirname,"..","dashboard.js"),path.join(directory,"dashboard.js"));
    fs.copyFileSync(path.join(__dirname,"..","dashboard.css"),path.join(directory,"dashboard.css"));
    const html=fs.readFileSync(path.join(__dirname,"..","dashboard.html"),"utf8")
      .replace('<script src="dashboard.js" defer></script>',
        '<script src="dashboard-full-mock.js"></script><script src="dashboard.js" defer></script>');
    fs.writeFileSync(path.join(directory,"dashboard.html"),html);
    fs.writeFileSync(path.join(directory,"dashboard-full-mock.js"),`"use strict";
const now=Date.now();
const sessions=Array.from({length:25},(_,i)=>({
 key:"chat:wide-"+i,title:"模拟宽屏会话 "+String(i).padStart(2,"0"),
 url:"https://chatgpt.com/c/wide-"+i,tabId:null,browser:"closed",
 pending:(i+2)%4,active:i===0?1:0,review:i===1?1:0,
 enabledRules:i%2,allRules:1,queuePaused:false,halted:false,
 activeStatus:i===0?"waiting":null,
 activeSince:i===0?now-165000:null,
 lastEventAt:now-i*60000,
}));
const calls=[];
window.chrome={
 runtime:{
  getURL(path){return "chrome-extension://test-queue/"+path;},
  async sendMessage(message) {
   calls.push(message);
   return {ok:true,dashboard:{version:"0.28.0",sessions:sessions.map(s=>({...s}))}};
  },
 },
 tabs:{async create(o){calls.push({type:"TAB_CREATE",...o});}},
 storage:{onChanged:{addListener(){}}},
};
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const waitUntil=async(fn,timeout=4500)=>{
 const end=Date.now()+timeout;
 while(Date.now()<end){
  if(fn())return true;
  await wait(50);
 }
 return Boolean(fn());
};
const q=selector=>document.querySelector(selector);
const cards=()=>[...document.querySelectorAll(".session")];
setTimeout(async()=>{
 const flags={};
 try {
  await waitUntil(()=>cards().length===25);
  flags.fullPageMode=document.documentElement.dataset.view==="full" &&
   q("#open-full-view")?.hidden===true;
  flags.bigViewport=document.documentElement.clientWidth>=900 &&
   Math.round(document.body.getBoundingClientRect().width)>=900;
  const grid=q(".sessions");
  const columns=getComputedStyle(grid).gridTemplateColumns.split(" ").filter(Boolean);
  flags.multiColumnGrid=columns.length>=2 &&
   grid.getBoundingClientRect().width>=900 &&
   getComputedStyle(grid).maxHeight==="none" &&
   getComputedStyle(grid).overflowY==="visible";
  flags.stickyHeader=getComputedStyle(q(".header")).position==="sticky";
  flags.noHorizontalOverflow=document.documentElement.scrollWidth <=
   document.documentElement.clientWidth+3;
  const activeCard=cards().find(card=>card.dataset.key==="chat:wide-0");
  flags.cardMetrics=activeCard?.querySelector(".session-metrics")?.textContent.includes("执行中") &&
   activeCard?.querySelector('[data-time-kind="stage"]')
     ?.textContent.includes("记录已持续");
  flags.initialReviewFirst=cards()[0]?.dataset.key==="chat:wide-1";
  const sort=q("#sort-order");
  sort.value="recent";
  sort.dispatchEvent(new Event("change",{bubbles:true}));
  flags.recencySort=cards()[0]?.dataset.key==="chat:wide-0" &&
   cards()[1]?.dataset.key==="chat:wide-1";
  sort.value="priority";
  sort.dispatchEvent(new Event("change",{bubbles:true}));
  const search=q("#search");
  search.value="wide-23";
  search.focus();
  search.dispatchEvent(new Event("input",{bubbles:true}));
  flags.searchKeepsFocus=document.activeElement===search &&
   cards().length===1 && cards()[0].dataset.key==="chat:wide-23";
  search.value="";
  search.dispatchEvent(new Event("input",{bubbles:true}));
  flags.listRestored=cards().length===25 && q("#stat-active")?.textContent==="1";
  flags.noActionSideEffects=calls.every(call=>call.type==="DASHBOARD_GET") &&
   !q(".feedback.error:not([hidden])");
 } catch(error){flags.error=error.stack || error.message;}
 flags.ok=["fullPageMode","bigViewport","multiColumnGrid",
  "stickyHeader","noHorizontalOverflow","cardMetrics",
  "initialReviewFirst","recencySort","searchKeepsFocus",
  "listRestored","noActionSideEffects"].every(key=>flags[key]===true);
 document.body.dataset.check=JSON.stringify(flags);
},400);`);
    const page=`file:///${path.join(directory,"dashboard.html").replace(/\\/g,"/")}?view=full`;
    const run=spawnSync(browser,[
      "--headless=new","--disable-gpu","--disable-extensions","--no-first-run",
      "--window-size=1400,940","--force-device-scale-factor=1",
      `--user-data-dir=${path.join(directory,"profile")}`,
      "--virtual-time-budget=6500","--dump-dom",page,
    ],{encoding:"utf8",timeout:26000,maxBuffer:10e6});
    assert.equal(run.status,0,run.stderr || "Chrome failed");
    const match=run.stdout.match(/data-check="([^"]+)"/);
    assert.ok(match,"Chrome did not finish the full-width management test");
    const flags=JSON.parse(match[1].replace(/&quot;/g,'"').replace(/&amp;/g,"&"));
    assert.equal(flags.ok,true,JSON.stringify(flags));
  } finally {
    fs.rmSync(directory,{recursive:true,force:true});
  }
});
