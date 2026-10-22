"use strict";

const {test} = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source=fs.readFileSync(path.join(__dirname,"..","background.js"),"utf8");
const chatKeySource=source.slice(source.indexOf("function chatKey(url) {"),
  source.indexOf("function resolveKey(url, tabId) {"));
const recoverySource=source.slice(source.indexOf("function safeUrl(input) {"),
  source.indexOf("// This standalone DOM probe runs"));

function harness(initialTabs, options={}) {
  const tabs=new Map(initialTabs.map(tab=>[tab.id,{...tab}]));
  const injections=[],queries=[],errors=[];
  const chrome={
    tabs:{
      async query(query){
        queries.push(query);
        if(options.failQuery)throw new Error("query unavailable");
        return [...tabs.values()].map(tab=>({...tab}));
      },
      async get(id){
        options.beforeGet?.(id,tabs);
        if(!tabs.has(id))throw new Error("tab closed");
        return {...tabs.get(id)};
      },
      async reload(){throw new Error("injection must not refresh a page itself");},
      async create(){throw new Error("injection must not create or activate a tab");},
      async update(){throw new Error("injection must not change tab properties");},
    },
    scripting:{async executeScript(args){
      injections.push({tabId:args.target.tabId,files:Array.from(args.files || [])});
      if(options.failTabs?.includes(args.target.tabId))throw new Error("no permission or page closed");
      if(options.beforeInject)await options.beforeInject(args.target.tabId);
      return [{result:null}];
    }},
    storage:new Proxy({}, {get(){throw new Error("guardian installation must not access queue storage");}}),
  };
  const context=vm.createContext({chrome,URL,Map,Promise,Number,
    console:{warn(...args){errors.push(args);}},
    exclusive(){throw new Error("guardian installation must not enter the queue lock");},
  });
  vm.runInContext("const loadRecoveryInstallations=new Map();\n"+
    chatKeySource+recoverySource,context);
  return {tabs,injections,queries,errors,
    scan:()=>context.installLoadRecoveryGuardians(),
    install:id=>context.installLoadRecoveryGuardians(id)};
}

test("后台守护补注入只覆盖已加载、未卸载的授权 ChatGPT 对话",async()=>{
  const env=harness([
    {id:1,url:"https://chatgpt.com/c/plain",status:"complete"},
    {id:2,url:"https://chatgpt.com/g/g-p-example/c/project-chat",status:"complete"},
    {id:3,url:"https://chat.openai.com/c/legacy",status:"complete"},
    {id:4,url:"https://chatgpt.com/g/g-p-example/project",status:"complete"},
    {id:5,url:"https://chatgpt.com/c/loading",status:"loading"},
    {id:6,url:"https://chatgpt.com/c/discarded",status:"complete",discarded:true},
    {id:7,url:"https://example.com/c/not-authorized",status:"complete"},
    {id:8,url:"http://chatgpt.com/c/not-https",status:"complete"},
    {id:9,url:"https://chatgpt.com.evil.example/c/not-authorized",status:"complete"},
    {id:10,url:"https://chatgpt.com/",status:"complete"},
  ]);
  await env.scan();
  assert.deepEqual(env.injections,[1,2,3].map(tabId=>({tabId,files:["load-recovery.js"]})));
  assert.deepEqual(Array.from(env.queries[0].url),["https://chatgpt.com/*","https://chat.openai.com/*"]);
});

test("补注入单页拒绝不阻塞其他对话，后续扫描仍允许重试",async()=>{
  const env=harness([1,2,3].map(id=>({id,url:`https://chatgpt.com/c/chat-${id}`,status:"complete"})),
    {failTabs:[1]});
  const first=await env.scan();
  assert.deepEqual(Array.from(first),[false,true,true]);
  assert.equal(env.injections.length,3);
  await env.scan();
  assert.equal(env.injections.filter(item=>item.tabId===1).length,2);
  assert.equal(env.injections.filter(item=>item.tabId===2).length,2,
    "成功页也可重新补注入，由脚本版本标记保证幂等，不依赖失效的后台缓存");
  assert.equal(env.errors.length,2);
});

test("并发闹钟和页面完成事件合并同一标签的未结束注入",async()=>{
  let release;
  const gate=new Promise(resolve=>{release=resolve;});
  const env=harness([{id:1,url:"https://chatgpt.com/c/one",status:"complete"}],
    {beforeInject:()=>gate});
  const first=env.install(1);
  const second=env.scan();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(env.injections.length,1);
  release();
  await Promise.all([first,second]);
  await env.install(1);
  assert.equal(env.injections.length,2,"完成后允许新一轮补注入，不留下永久锁");
});

test("扫描之后关闭或跳离的页面不补注入，单页入口也执行相同权限过滤",async()=>{
  for(const changed of ["closed","foreign","project","loading","discarded"]){
    const env=harness([{id:1,url:"https://chatgpt.com/c/race",status:"complete"}],{
      beforeGet(id,tabs){
        if(changed==="closed")tabs.delete(id);
        if(changed==="foreign")tabs.get(id).url="https://example.com/c/race";
        if(changed==="project")tabs.get(id).url="https://chatgpt.com/g/g-p-test/project";
        if(changed==="loading")tabs.get(id).status="loading";
        if(changed==="discarded")tabs.get(id).discarded=true;
      },
    });
    await env.scan();
    assert.equal(env.injections.length,0,changed);
    assert.equal(await env.install(1),false,changed);
  }
});

test("标签查询不可用时不改存档、不刷新页面，也不产生未处理异常",async()=>{
  const env=harness([],{failQuery:true});
  assert.deepEqual(Array.from(await env.scan()),[]);
  assert.equal(env.injections.length,0);
  assert.equal(env.errors.length,1);
});
