"use strict";

const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const vm=require("node:vm");

const source=fs.readFileSync(path.join(__dirname,"..","content.js"),"utf8");
const start=source.lastIndexOf('  window.addEventListener("keydown", (event) => {');
const suffix="\n  }, true);";
const end=source.indexOf(suffix,start);
assert.ok(start>=0 && end>start,"cannot locate production capture-phase keyboard handler");
const handlerSource=source.slice(start,end+suffix.length);

function environment(options={}) {
  const calls={queue:[],native:[],steer:[],busy:[],rpc:[],render:0,wake:0};
  const listeners=[];
  const editor={isConnected:true,contains:node=>node===nested};
  const nested={parent:editor};
  const state={activeTaskId:null,steeringTaskId:null,tasks:[]};
  const documentUrl="https://chatgpt.com/c/known-chat";
  let draft="Testing native keyboard";
  const sandbox={
    window:{addEventListener(type,listener,capture){listeners.push({type,listener,capture});}},
    root:{contains:()=>false},
    getEditor:()=>editor,
    suggestionPopupOpen:()=>false,
    extensionContextGone:false,
    state,location:{href:documentUrl},sendPageEpoch:0,
    editorText:()=>draft,hasComposerAttachments:()=>false,
    workInProgress:false,composerActionInProgress:false,
    captureSendScope:()=>({url:documentUrl,epoch:0}),
    boundHere:()=>true,
    syncSendRoute:()=>{},
    conversationSnapshot:()=>({busy:options.busy||false,lastUserText:""}),
    steerQueuedTask:async(...args)=>{calls.busy.push(args);},
    steerNativePrompt:async(...args)=>{calls.steer.push(args);},
    queueNativePrompt:async(...args)=>{calls.queue.push(args);},
    rpc:async(...args)=>{calls.rpc.push(args);},
    render:()=>{calls.render++;},
    requestQueueWake:()=>{calls.wake++;},
    showError:error=>{throw error;},
  };
  vm.runInNewContext(handlerSource,sandbox);
  assert.equal(listeners.length,1);
  assert.equal(listeners[0].capture,true);

  function key({target=editor,...opts}={}) {
    const event={
      key:"Enter",target,shiftKey:false,altKey:false,
      ctrlKey:false,metaKey:false,isComposing:false,keyCode:13,repeat:false,
      defaultPrevented:false,immediatePropagationStopped:false,
      preventDefault(){this.defaultPrevented=true;},
      stopImmediatePropagation(){this.immediatePropagationStopped=true;},
      ...opts,
    };
    listeners[0].listener(event);
    return event;
  }
  function nativeSend(event) {
    // Mimic ChatGPT's normal editor listener after the extension capture
    // phase. No queue bridge is involved in a native Enter submission.
    if(!event.defaultPrevented && !event.shiftKey && !event.altKey &&
        !event.isComposing && event.keyCode!==229) calls.native.push(draft);
  }
  return {calls,key,nativeSend,state,editor,nested,
    setDraft(value){draft=value;}};
}

const settled=()=>new Promise(resolve=>setImmediate(resolve));

test("新对话、旧聊天和已有队列：普通 Enter 都不拦截、不会 ENQUEUE",async()=>{
  const env=environment();
  env.state.tasks=[{status:"pending",id:"queued-one"}];
  for(const target of [env.editor,env.nested]){
    const event=env.key({target});
    env.nativeSend(event);
    assert.equal(event.defaultPrevented,false);
    assert.equal(event.immediatePropagationStopped,false);
  }
  await settled();
  assert.deepEqual(env.calls.native,
    ["Testing native keyboard","Testing native keyboard"]);
  assert.equal(env.calls.queue.length,0);
  assert.equal(env.calls.steer.length,0);
  assert.equal(env.calls.rpc.length,0);
});

test("Ctrl+Enter 与 Cmd+Enter 即时发送而不排队，包括已有待办的聊天",async()=>{
  const env=environment();
  env.state.tasks=[{status:"pending",id:"queued-one"}];
  for(const shortcut of [{ctrlKey:true},{metaKey:true}]){
    const event=env.key(shortcut);
    assert.equal(event.defaultPrevented,true);
    assert.equal(event.immediatePropagationStopped,true);
    await settled();
  }
  assert.equal(env.calls.steer.length,2);
  assert.equal(env.calls.busy.length,0);
  assert.equal(env.calls.queue.length,0);
});

test("生成中 Ctrl+Enter 走即时引导，不发送 ENQUEUE",async()=>{
  const env=environment({busy:true});
  const event=env.key({ctrlKey:true});
  assert.equal(event.defaultPrevented,true);
  await settled();
  assert.equal(env.calls.busy.length,1);
  assert.equal(env.calls.queue.length,0);
});

test("Shift/Alt、中文输入法、斜杠候选以外编辑器不受插件键盘处理",async()=>{
  const env=environment();
  const examples=[
    {shiftKey:true},{altKey:true},{isComposing:true},{keyCode:229},
    {key:"Escape"},{target:{}},
  ];
  for(const options of examples) {
    const event=env.key(options);
    assert.equal(event.defaultPrevented,false,JSON.stringify(options));
  }
  await settled();
  assert.equal(env.calls.steer.length,0);
  assert.equal(env.calls.queue.length,0);
});

test("人工入队仅绑定插件按钮，不由任何键盘事件调用队列 RPC",()=>{
  assert.match(source,/if \(action === "queue-composer"\) \{/);
  assert.match(source,/if \(action === "queue-composer"\)[\s\S]*?await queueNativePrompt\(editor, text\);/);
  assert.doesNotMatch(handlerSource,/queueNativePrompt\(/);
  assert.doesNotMatch(handlerSource,/rpc\("ENQUEUE"/);
  assert.doesNotMatch(source,/nativeFirstEnterAllowed\(/);
});
