/* global chrome, CQHandoff, globalThis */
"use strict";

// 本地 AI 调度器只通过扩展现有的队列 RPC 创建任务，不操作原生 ChatGPT DOM。
// 发送、引导、草稿保护与跨项目隔离仍由 content.js / background.js 统一负责。
globalThis.CQRemoteDispatch = (() => {
  const ENDPOINT = "http://127.0.0.1:43578/v1/extension";
  const BRIDGE_HEADER = "chatgpt-task-queue-extension-v1";
  const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
  const CHAT_URLS = ["https://chatgpt.com/*","https://chat.openai.com/*"];
  const ALARM = "cq.remote-bridge";
  const TEAM_CHANNELS_KEY = "cq.remote.teamChannels.v1";
  const OWNED_TABS_KEY = "cq.remote.ownedTabs.v1";
  const TAB_RESPONSE_TIMEOUT_MS = 20000;
  let running = false;
  let targets = [];
  let ownershipSerial = Promise.resolve();

  function withTabResponseDeadline(promise,timeoutMs=TAB_RESPONSE_TIMEOUT_MS) {
    let guard;
    return Promise.race([
      Promise.resolve(promise),
      new Promise((_,reject)=>{
        guard=setTimeout(()=>reject(new Error("CQ_REMOTE_TAB_TIMEOUT")),timeoutMs);
      }),
    ]).finally(()=>clearTimeout(guard));
  }

  async function api(path, body = null) {
    if (typeof fetch !== "function") throw new Error("浏览器不支持本机桥接请求");
    const ctrl = new AbortController();
    const guard = setTimeout(() => ctrl.abort(), 7000);
    try {
      const response = await fetch(ENDPOINT + path,{
        method:body ? "POST" : "GET",
        headers:{"X-CQ-Extension":BRIDGE_HEADER,"X-CQ-Extension-Id":chrome.runtime.id,
          ...(body ? {"Content-Type":"application/json"} : {})},
        ...(body ? {body:JSON.stringify(body)} : {}),
        cache:"no-store",signal:ctrl.signal,
      });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || "桥接器请求失败");
      return data;
    } finally {
      clearTimeout(guard);
    }
  }

  function normalizedName(name) {
    return typeof name==="string" ? name.trim().toLocaleLowerCase() : "";
  }

  function pickTarget(job,list) {
    const target=job.target;
    if(!target || !["chat","project","personal"].includes(target.kind))
      throw new Error("远程目标类型无效");
    // The ordinary new-chat homepage is a built-in destination. It requires
    // no project binding and can only resolve to the official site root.
    if(target.kind==="personal") {
      const url=target.url || "https://chatgpt.com/";
      const normal=safeUrl(url);
      if(target.id && target.id!=="personal" || !normal ||
          new URL(normal).pathname!=="/" ||
          new URL(url).pathname!=="/" || new URL(url).search)
        throw new Error("普通新对话目标必须是 ChatGPT 首页");
      return {kind:"personal",id:"personal",url:normal,
        name:target.name||"普通聊天"};
    }
    const reference=target.url || target.id || target.name;
    if(typeof reference!=="string" || !reference.trim())
      throw new Error("未指定对话或项目");
    const exact = list.filter(item=>item.kind===target.kind && [
      item.url,item.id,item.name,item.alias,
    ].some(v=>normalizedName(v)===normalizedName(reference)));
    const unique = new Map(exact.map(item=>[item.id,item]));
    if(unique.size>1) throw new Error("名称匹配多个目标，请提供唯一 ChatGPT URL/ID");
    if(unique.size===1) return [...unique.values()][0];
    // Exact direct URL/ID is accepted even when the target is not currently open.
    if (target.kind==="chat") {
      const fullUrl=typeof target.url==="string" ? target.url :
        /^https:\/\//i.test(reference) ? reference : null;
      const match=fullUrl && /\/c\/([a-zA-Z0-9-]+)\/?$/.exec(fullUrl);
      if(match && /^https:\/\/(chatgpt\.com|chat\.openai\.com)\//.test(fullUrl))
        return {kind:"chat",id:match[1],url:fullUrl,name:target.name||match[1]};
      const id=typeof target.id==="string" ? target.id : reference;
      if(/^[a-zA-Z0-9-]{12,100}$/.test(id) && !/^g-p-/.test(id))
        return {kind:"chat",id,url:"https://chatgpt.com/c/"+id,name:target.name||id};
    } else {
      const fullUrl=typeof target.url==="string" ? target.url :
        /^https:\/\//i.test(reference) ? reference : null;
      const project=fullUrl ? CQHandoff.projectStart(fullUrl) : null;
      if(project) return {kind:"project",id:CQHandoff.projectId(project),url:project,name:target.name||project};
      const id=typeof target.id==="string" ? target.id : reference;
      const canonical=CQHandoff.normalizeProjectId(id);
      if(canonical) return {kind:"project",id:canonical,
        url:"https://chatgpt.com/g/"+canonical+"/project",name:target.name||canonical};
    }
    throw new Error("找不到目标“"+reference+"”；请先打开对应页面或使用 bind 绑定名称与 URL");
  }

  function listTargets(store,tabs,aliases={},assignments={}) {
    const choices=new Map();
    function add(kind,url,name,tabId,alias) {
      const id=kind==="chat" ? chatKey(url)?.slice(5) : CQHandoff.projectId(url);
      const finalUrl=kind==="project" ? CQHandoff.projectStart(url) : safeUrl(url);
      if(!id || !finalUrl) return;
      const key=kind+":"+id, previous=choices.get(key);
      const entry={kind,id,url:finalUrl,name:String(name||alias||id).slice(0,200),
        ...(typeof alias==="string" && alias ? {alias:alias.slice(0,200)} : {}),
        ...(Number.isInteger(tabId)?{tabId}:{}),
        open:Number.isInteger(tabId)};
      // Prefer a live tab over a stale owner but retain a user-specified alias.
      if(!previous || entry.open && !previous.open ||
          entry.alias && !previous.alias) choices.set(key,{...previous,...entry});
    }
    const matches=Array.isArray(tabs) ? tabs : [];
    const byChatId=new Map();
    for(const tab of matches) {
      const key=chatKey(tab.url);
      if(key) byChatId.set(key,tab);
    }
    for(const [key,state] of Object.entries(store.conversations||{})) {
      if(!key.startsWith("chat:") || !chatKey(state.url)) continue;
      const tab=byChatId.get(key);
      const alias=typeof aliases[key]==="string" ? aliases[key] : "";
      add("chat",state.url,alias || tab?.title || key.slice(5),tab?.id,alias);
      const projectName=assignments[key];
      const projectUrl=CQHandoff.projectStart(state.url);
      if(projectUrl) add("project",projectUrl,projectName||"",null,projectName||"");
    }
    for(const tab of matches) {
      const url=safeUrl(tab.url);
      if(!url) continue;
      const key=chatKey(url);
      if(key) {
        const alias=typeof aliases[key]==="string" ? aliases[key] : "";
        add("chat",url,alias||tab.title||key.slice(5),tab.id,alias);
      }
      const projectUrl=CQHandoff.projectStart(url);
      if(projectUrl) {
        const label=isProjectOverview(url) ? tab.title : assignments[key];
        add("project",projectUrl,label||"",isProjectOverview(url)?tab.id:null,
          typeof assignments[key]==="string" ? assignments[key] : "");
      }
    }
    return [...choices.values()];
  }

  async function refreshTargets() {
    const [store,tabs,metadata]=await withTabResponseDeadline(Promise.all([
      readStore(),chrome.tabs.query({url:CHAT_URLS}),
      chrome.storage.local.get(["cq.dashboard.aliases.v1","cq.dashboard.projects.v1"]),
    ]));
    targets=listTargets(store,tabs,
      metadata["cq.dashboard.aliases.v1"],metadata["cq.dashboard.projects.v1"]);
    await api("/targets",{targets,version:chrome.runtime.getManifest().version});
    return targets;
  }

  function sameScope(tab,target) {
    if (!safeUrl(tab?.url)) return false;
    if (target.kind==="chat") return chatKey(tab.url)?.slice(5)===target.id;
    if (target.kind==="personal") return CQHandoff.scopeId(tab.url)==="personal";
    return CQHandoff.projectId(tab.url)===target.id;
  }

  function taggedJob(tab,jobId) {
    try {return new URL(tab.url).hash==="#cq-remote-job="+jobId;}
    catch {return false;}
  }

  function taggedTeamChannel(tab,chatId) {
    try {return new URL(tab.url).hash==="#cq-team-channel="+chatId;}
    catch {return false;}
  }

  async function ownedTabs() {
    const stored=await withTabResponseDeadline(chrome.storage.local.get(OWNED_TABS_KEY));
    const value=stored?.[OWNED_TABS_KEY];
    return value && typeof value==="object" && !Array.isArray(value) ? value : {};
  }

  function editOwnedTabs(mutate) {
    // A foreground activation must not be lost behind a concurrent
    // channel-registration write. Never infer ownership from an open URL.
    const update=ownershipSerial.then(async()=>{
      const entries=await ownedTabs();
      if(mutate(entries)===false) return;
      await withTabResponseDeadline(chrome.storage.local.set({[OWNED_TABS_KEY]:entries}));
    });
    ownershipSerial=update.catch(()=>{});
    return update;
  }

  async function rememberOwned(tab,job,kind) {
    if(!Number.isInteger(tab?.id) || !UUID.test(job?.id)) throw new Error("远程标签创建凭据无效");
    await editOwnedTabs(entries=>{
      const key=String(tab.id),current=entries[key];
      if(current && current.jobId!==job.id && current.kind==="job")
        throw new Error("不能将普通任务的独占标签归属转移给其他任务");
      const runIds=[...new Set([...(current?.runIds||[]),
        ...(job.runId?[job.runId]:[])])];
      entries[key]={tabId:tab.id,kind:current?.kind||kind,
        jobId:current?.jobId||job.id,
        chatId:current?.chatId|| (job.action==="new_chat"
          ? chatKey(tab.url)?.slice(5)||null
          : job.target?.id||chatKey(tab.url)?.slice(5)||null),
        projectId:current?.projectId||
          (job.action==="new_chat"
            ? CQHandoff.normalizeProjectId(job.target?.id)
            : CQHandoff.projectId(tab.url))||null,
        // Before a first message creates the chat ID, keep the intended
        // new-chat scope. Native / -> /c/<id> navigation is not a user visit.
        // Activation still marks the tab visited, so it cannot be auto-closed.
        newChatScope:current?.newChatScope||
          (job.action==="new_chat" ? CQHandoff.scopeId(job.target?.url) : null),
        taskId:current?.taskId||null,
        finished:current?.finished===true,
        visited:current?.visited===true,runIds,
        releasedRuns:current?.releasedRuns||[],
        createdAt:current?.createdAt||Date.now()};
    });
  }

  async function noteOwnedTask(tabId,job,taskId,chatUrl=null) {
    if(!Number.isInteger(tabId)) return;
    await editOwnedTabs(entries=>{
      const existing=entries[String(tabId)];
      if(!existing || (existing.kind==="job" && existing.jobId!==job.id)) return false;
      if(typeof taskId==="string" && taskId.length<128) existing.taskId=taskId;
      const id=chatUrl ? chatKey(chatUrl) : null;
      if(id) existing.chatId=id.slice(5);
      if(job.runId && !existing.runIds.includes(job.runId)) existing.runIds.push(job.runId);
    });
  }

  function idleSessionFor(store,entry) {
    if(!entry.chatId || !Array.isArray(entry.runIds)) return null;
    const state=store.conversations?.["chat:"+entry.chatId];
    // The tab owner can move between multiple extension-created tabs.
    // All such tabs are eligible ONLY after their shared conversation is
    // idle; their individual proof/ownership checks happen separately.
    if(!state || state.halted || state.queuePaused ||
        state.activeTaskId || state.steeringTaskId || state.handoffSourceKey ||
        state.error || state.tasks?.length || state.schedules?.length ||
        state.handoff?.phase && state.handoff.phase!=="idle") return null;
    return state;
  }

  async function releaseOwnedChat(chatId,runId=null,expectedTaskId=null) {
    const records=await ownedTabs();
    const candidates=Object.values(records).filter(entry=>
      entry?.chatId===chatId && (runId
        ? entry.runIds?.includes(runId)
        : entry.kind==="job" && entry.finished===true &&
          entry.taskId===expectedTaskId));
    if(!candidates.length) return {status:"skipped",reason:"没有可以证明由插件创建的后台标签"};
    let closed=0,waiting=0,reason="";
    for(const entry of candidates) {
      if(runId && !entry.releasedRuns?.includes(runId)) {
        await editOwnedTabs(entries=>{
          const current=entries[String(entry.tabId)];
          if(current?.chatId===chatId && current.runIds?.includes(runId))
            current.releasedRuns=[...new Set([...(current.releasedRuns||[]),runId])];
        });
        entry.releasedRuns=[...(entry.releasedRuns||[]),runId];
      }
      if(entry.visited || runId && entry.runIds?.some(id=>
          !entry.releasedRuns?.includes(id))) {
        reason="标签被用户查看或仍由其他协作运行使用";
        continue;
      }
      let tab;
      try {tab=await withTabResponseDeadline(chrome.tabs.get(entry.tabId));}
      catch(error) {
        // A timeout is not proof that a tab disappeared.
        if(/No tab with id|tab not found|No tab found/i.test(error.message||"")) {
          await forgetOwnedTab(entry.tabId);closed++;continue;
        }
        waiting++;reason="浏览器无法确认标签是否存在";continue;
      }
      if(!tab || tab.active || tab.pinned || tab.audible || tab.discarded ||
          tab.status!=="complete" ||
          chatKey(tab.url)!=="chat:"+chatId ||
          entry.newChatScope && CQHandoff.scopeId(tab.url)!==entry.newChatScope) {
        reason="标签正在被用户使用、加载或目标已发生变化";
        continue;
      }
      const store=await withTabResponseDeadline(readStore());
      const state=idleSessionFor(store,entry);
      if(!state) {waiting++;reason="队列尚未清空或会话被安全暂停";continue;}
      if(!runId && (!expectedTaskId || !state.history?.some(h=>
        h.type==="finished" && h.taskId===expectedTaskId))) {
        waiting++;reason="尚无对应队列消息的完成证据";continue;
      }
      let response;
      try {
        response=await withTabResponseDeadline(chrome.tabs.sendMessage(tab.id,{
          type:"CQ_REMOTE_RELEASE_CHECK",chatId,targetUrl:tab.url,
        }));
      }catch {waiting++;reason="当前网页无法确认草稿和回复状态";continue;}
      if(!response?.ok || response.safe!==true) {
        waiting++;reason=response?.reason||"网页检测到未完成回复或输入草稿";continue;
      }
      // Double-check tab and persistent ownership immediately before a
      // destructive close. An activated tab must always win this race.
      const latest=(await ownedTabs())[String(tab.id)];
      if(!latest || latest.visited ||
          latest.chatId!==chatId || latest.jobId!==entry.jobId) {
        reason="标签所有权已变化";continue;
      }
      const newest=await withTabResponseDeadline(chrome.tabs.get(tab.id));
      if(newest.active || newest.pinned || newest.audible ||
          chatKey(newest.url)!=="chat:"+chatId ||
          entry.newChatScope && CQHandoff.scopeId(newest.url)!==entry.newChatScope) {
        reason="用户已切换到该标签";continue;
      }
      if(!Number.isInteger(newest.windowId)) {
        reason="无法确认标签所属浏览器窗口";continue;
      }
      const windowTabs=await withTabResponseDeadline(chrome.tabs.query({
        windowId:newest.windowId,
      }));
      if(!Array.isArray(windowTabs) || windowTabs.length<=1) {
        reason="这是浏览器窗口中最后一个标签，保留窗口";
        continue;
      }
      await withTabResponseDeadline(chrome.tabs.remove(tab.id));
      await forgetOwnedTab(tab.id);
      closed++;
    }
    return closed===candidates.length?{status:"closed",reason:"任务完成后已释放插件专用后台标签"}:
      waiting?{status:"deferred",reason:reason||"等待最后一条回复确认"}:
      {status:"skipped",reason:reason||"标签不符合安全释放条件"};
  }

  async function releaseFinishedJobs() {
    const records=await ownedTabs();
    const store=await withTabResponseDeadline(readStore());
    const eligible=Object.values(records).filter(entry=>
      entry?.kind==="job" && !entry.visited && entry.chatId && entry.taskId &&
      store.conversations?.["chat:"+entry.chatId]?.history?.some(h=>
        h.type==="finished" && h.taskId===entry.taskId))
      .sort((a,b)=>(a.lastReleaseAt||0)-(b.lastReleaseAt||0))
      .slice(0,5);
    await Promise.all(eligible.map(async entry=>{
      await editOwnedTabs(entries=>{
          const current=entries[String(entry.tabId)];
          if(current?.jobId===entry.jobId) {
            current.finished=true;
            current.lastReleaseAt=Date.now();
          }
      });
      // A running, paused, or user-visited tab is simply retained.
      try {await releaseOwnedChat(entry.chatId,null,entry.taskId);}
      catch(error) {console.warn("[ChatQueue] 队列自动释放延后",error);}
    }));
  }

  async function releaseTeamRun(request) {
    const results=await Promise.all((request.chats||[]).slice(0,5).map(async(chat)=>{
      try {
        const result=await releaseOwnedChat(chat.id,request.runId);
        return {id:chat.id,...result};
      }catch(error) {
        return {id:chat.id,status:"deferred",
          reason:String(error.message||error).slice(0,180)};
      }
    }));
    await api("/releases/report",{id:request.id,results});
  }

  async function flushRemoteResults() {
    const initial=await readStore();
    const pending=Array.isArray(initial.remoteResults)?initial.remoteResults:[];
    let firstError=null;
    for(const item of pending) {
      // The queue result is already durable before this request. Retrying
      // the same id is safe, even if the previous HTTP response was lost.
      try {
        await api("/results/report",item);
        await exclusive(async()=>{
          const latest=await readStore();
          if(!Array.isArray(latest.remoteResults)) return;
          const index=latest.remoteResults.findIndex(x=>x.id===item.id && x.taskId===item.taskId);
          if(index<0) return;
          latest.remoteResults.splice(index,1);
          await saveStore(latest);
        });
      } catch(error) {firstError ||= error;}
    }
    if(firstError) throw firstError;
  }

  async function onTaskFinished(tabId,taskId) {
    if(!Number.isInteger(tabId) || typeof taskId!=="string") return;
    await editOwnedTabs(entries=>{
      const entry=entries[String(tabId)];
      if(!entry || entry.kind!=="job" || entry.taskId!==taskId) return false;
      entry.finished=true;
    });
    try {await flushRemoteResults();}
    catch(error) {console.warn("[ChatQueue] 远程结果稍后重试",error);}
    await releaseFinishedJobs();
  }

  async function onTabActivated(tabId) {
    await noteTabVisited(tabId);
  }

  async function onTabNavigated(tabId,url) {
    if(!safeUrl(url)) return noteTabVisited(tabId);
    const entries=await ownedTabs(),entry=entries[String(tabId)];
    if(!entry) return;
    if(entry.chatId && chatKey(url)==="chat:"+entry.chatId &&
        (!entry.newChatScope || CQHandoff.scopeId(url)===entry.newChatScope)) return;
    if(!entry.chatId && entry.newChatScope &&
        CQHandoff.scopeId(url)===entry.newChatScope) return;
    if(!entry.chatId && entry.projectId &&
        CQHandoff.projectId(url)===entry.projectId) return;
    await noteTabVisited(tabId);
  }

  async function onTabRemoved(tabId) {
    await forgetOwnedTab(tabId);
  }

  async function noteTabVisited(tabId) {
    await editOwnedTabs(entries=>{
      const current=entries[String(tabId)];
      if(!current || current.visited) return false;
      current.visited=true;
    });
  }

  async function forgetOwnedTab(tabId) {
    await editOwnedTabs(entries=>{
      if(!entries[String(tabId)]) return false;
      delete entries[String(tabId)];
    });
    const channels=await teamChannels();
    const next=Object.fromEntries(Object.entries(channels).filter(([,id])=>id!==tabId));
    if(Object.keys(next).length!==Object.keys(channels).length)
      await withTabResponseDeadline(chrome.storage.local.set({[TEAM_CHANNELS_KEY]:next}));
  }

  async function teamChannels() {
    const data=await withTabResponseDeadline(chrome.storage.local.get(TEAM_CHANNELS_KEY));
    const entries=data?.[TEAM_CHANNELS_KEY];
    return entries && typeof entries==="object" && !Array.isArray(entries) ? entries : {};
  }

  async function rememberTeamChannel(chatId,tabId) {
    if(!/^[a-zA-Z0-9-]+$/.test(chatId) || !Number.isInteger(tabId))
      throw new Error("协作专用标签标识无效");
    const channels=await teamChannels();
    if(channels[chatId]===tabId) return;
    await withTabResponseDeadline(chrome.storage.local.set({[TEAM_CHANNELS_KEY]:{
      ...channels,[chatId]:tabId,
    }}));
  }

  async function findTeamChannel(job,target,current) {
    const channels=await teamChannels();
    const remembered=Number.isInteger(channels[target.id])
      ? current.find(tab=>tab.id===channels[target.id] && sameScope(tab,target)) : null;
    if(remembered) {
      const currentOwner=(await ownedTabs())[String(remembered.id)];
      if(currentOwner && currentOwner.chatId===target.id &&
          currentOwner.kind!=="job")
        await rememberOwned(remembered,job,currentOwner.kind);
      return remembered;
    }
    const marked=current.filter(tab=>sameScope(tab,target) &&
      taggedTeamChannel(tab,target.id));
    if(marked.length>1) throw new Error("同一成员存在多个协作通道，请人工核对");
    if(marked.length===1) {
      const currentOwner=(await ownedTabs())[String(marked[0].id)];
      if(currentOwner && currentOwner.chatId===target.id &&
          currentOwner.kind!=="job")
        await rememberOwned(marked[0],job,currentOwner.kind);
      await rememberTeamChannel(target.id,marked[0].id);
      await api("/report",{id:job.id,status:"opening",tabId:marked[0].id});
      return marked[0];
    }
    if(job.openIntent) throw new Error(
      "协作消息已尝试创建专用标签，但原标签无法核实；拒绝重复开页");
    await api("/report",{id:job.id,status:"opening",openIntent:true});
    const sameWindow=current.find(tab=>sameScope(tab,target) &&
      Number.isInteger(tab.windowId)) ||
      current.find(tab=>Number.isInteger(tab.windowId));
    // Unlike a normal user task, multiple team messages share this ONE
    // inactive inbox tab per chat. Never hijack a user's unrelated tab.
    const tab=await withTabResponseDeadline(chrome.tabs.create({
      url:target.url+"#cq-team-channel="+target.id,active:false,
      ...(sameWindow?{windowId:sameWindow.windowId}:{}),
    }));
    await rememberOwned(tab,job,"team_inbox");
    await rememberTeamChannel(target.id,tab.id);
    await api("/report",{id:job.id,status:"opening",tabId:tab.id});
    return tab;
  }

  async function findOrOpen(job,target) {
    const current=await withTabResponseDeadline(chrome.tabs.query({url:CHAT_URLS}));
    if(Number.isInteger(job.tabId)) {
      const owned=current.find(tab=>tab.id===job.tabId);
      if(!owned) throw new Error("任务专属标签页已关闭；不重新打开以避免重复发消息");
      if(!sameScope(owned,target))
        throw new Error("任务专属标签页已切换目标；为防止串发，停止操作");
      return owned;
    }
    if(job.mode==="steer") {
      // Only steering may use an existing user tab, and it MUST NOT create one.
      const store=await readStore();
      const ownerId=store.conversations["chat:"+target.id]?.tabId;
      const owner=current.find(tab=>tab.id===ownerId && sameScope(tab,target));
      if(!owner) throw new Error("引导只能使用指定旧对话已有的标签页；请打开该对话");
      return owner;
    }
    if(job.channel==="team") return findTeamChannel(job,target,current);
    // All ordinary jobs get their own inactive TAB within the existing
    // browser window. A unique URL fragment permits crash-time discovery.
    const matching=current.filter(tab=>taggedJob(tab,job.id));
    if(matching.length>1) throw new Error("同一任务发现多个标签页，请人工核对");
    if(matching.length===1) {
      // URL fragments alone do not prove who opened this tab. A crashed
      // worker may resume the queued task, but may not auto-close a tab
      // unless it was already marked as extension-owned at creation time.
      const currentOwner=(await ownedTabs())[String(matching[0].id)];
      if(currentOwner?.jobId===job.id)
        await rememberOwned(matching[0],job,job.channel==="team_spawn"?"team_spawn":"job");
      await api("/report",{id:job.id,status:"opening",tabId:matching[0].id});
      return matching[0];
    }
    if(job.openIntent) throw new Error(
      "本任务曾请求创建后台标签但没有可核对的标签，拒绝再次打开以避免无限开页");
    // Persist the open intent first, then create at most ONE page per job.
    await api("/report",{id:job.id,status:"opening",openIntent:true});
    const sameWindow=current.find(tab=>sameScope(tab,target) && Number.isInteger(tab.windowId))
      || current.find(tab=>Number.isInteger(tab.windowId));
    const markedUrl=target.url+"#cq-remote-job="+job.id;
    const tab=await withTabResponseDeadline(chrome.tabs.create({
      url:markedUrl,active:false,
      ...(sameWindow?{windowId:sameWindow.windowId}:{}),
    }));
    await rememberOwned(tab,job,job.channel==="team_spawn"?"team_spawn":"job");
    // This acknowledgement also protects against retries after the SPA
    // removes its marker or redirects from project overview into a new chat.
    await api("/report",{id:job.id,status:"opening",tabId:tab.id});
    return tab;
  }

  async function messageTab(tab,job) {
    if(tab.discarded===true || tab.status!=="complete") return {status:"waiting",
      tabId:tab.id,error:"等待 ChatGPT 标签页加载"};
    const response=await withTabResponseDeadline(chrome.tabs.sendMessage(tab.id,{
      type:"CQ_REMOTE_EXECUTE",id:job.id,action:job.action,
      text:job.text,mode:job.mode,targetUrl:tab.url,captureResult:job.captureResult===true,
    }));
    if (!response || !response.ok)
      throw new Error(response?.error||"扩展页面尚未初始化");
    return {...response,tabId:tab.id};
  }

  async function inspectCreatedChat(job,target,tab) {
    const url=safeUrl(tab?.url);
    if(!url || !chatKey(url) || !sameScope(tab,target))
      return {status:"waiting",tabId:tab.id,error:"首条消息尚未建立新对话"};
    let confirmationDiagnostic = null;
    try {
      const result=await withTabResponseDeadline(chrome.tabs.sendMessage(tab.id,{
        type:"CQ_REMOTE_INSPECT",id:job.id,text:job.text,targetUrl:tab.url,
        captureDiagnostics:job.captureResult===true,
      }));
      if(result?.ok && result.confirmationDiagnostic)
        confirmationDiagnostic=result.confirmationDiagnostic;
      if(result?.ok && result.observed === true) {
        await noteOwnedTask(tab.id,job,job.taskId,url);
        if(job.channel==="team_spawn") {
          // The new chat is already confirmed. A storage hiccup must not
          // turn it into a failed/newly re-created chat; later messages may
          // still recover the marked channel or create a dedicated inbox.
          try {await rememberTeamChannel(chatKey(url).slice(5),tab.id);}
          catch(error) {console.warn("[ChatQueue] 团队通道绑定稍后恢复",error);}
        }
        return {status:"created",chatUrl:url,tabId:tab.id,taskId:job.taskId,
          ...(confirmationDiagnostic?{confirmationDiagnostic}:{})};
      }
    } catch { /* ChatGPT may still be hydrating the new route. */ }
    return {status:"waiting",tabId:tab.id,error:"等待确认新对话首条消息",
      ...(confirmationDiagnostic?{confirmationDiagnostic}:{})};
  }

  async function inspectSteeredChat(job,tab) {
    if (tab.discarded || tab.status!=="complete")
      return {status:"waiting",tabId:tab.id,error:"等待引导所在对话恢复"};
    try {
      const result=await withTabResponseDeadline(chrome.tabs.sendMessage(tab.id,{
        type:"CQ_REMOTE_INSPECT",mode:"steer",id:job.id,
        text:job.text,targetUrl:tab.url,
      }));
      if(result?.ok && result.observed)
        return {status:"steered",tabId:tab.id,taskId:job.taskId};
      if(result?.uncertain)
        return {status:"review_required",tabId:tab.id,
          error:"引导发送状态不明确，请检查对话后决定是否重新创建任务"};
    } catch { /* Browser may rebuild the page while a reply is forming. */ }
    return {status:"waiting",tabId:tab.id,
      error:"引导已提交或正在确认；不重复发送，等待网页证据"};
  }

  async function executeJob(job) {
    if(!UUID.test(job?.id) || typeof job.text!=="string" || !job.text.trim() ||
        !["continue","new_chat"].includes(job.action)) throw new Error("无效的远程任务");
    const target=pickTarget(job,targets);
    if(job.action==="continue" && target.kind!=="chat" ||
        job.action==="new_chat" && !["project","personal"].includes(target.kind))
      throw new Error("目标类型与任务不匹配");

    const store=await withTabResponseDeadline(readStore());
    const already=Object.values(store.conversations||{}).find(state=>
      state.recentSubmissions?.some(entry=>entry.id===job.id));
    // A successful queue submission must never be performed again on retry.
    if(job.action==="continue" && job.mode==="queue" && already)
      return {status:"queued",tabId:job.tabId,
        taskId:already.tasks.find(t=>t.remoteJobId===job.id)?.id};

    const tab=await findOrOpen(job,target);
    if(job.action==="continue" && job.mode==="steer" &&
        (already || job.sendIntent))
      return inspectSteeredChat(job,tab);
    if(job.action==="new_chat" && already) {
      if(chatKey(tab.url)) return inspectCreatedChat(job,target,tab);
      return {status:"waiting",tabId:tab.id,
        taskId:already.tasks.find(t=>t.remoteJobId===job.id)?.id,
        error:"首条消息已入队，等待新对话建立；不重复提交"};
    }
    if(job.action==="new_chat" && (job.taskId || chatKey(tab.url)))
      return inspectCreatedChat(job,target,tab);
    if(tab.discarded===true || tab.status!=="complete")
      return {status:"waiting",tabId:tab.id,error:"等待新后台标签页加载"};

    // Steering has a durable one-shot intent: a crash or lost response
    // after this point requires observation/manual review, never a re-send.
    const steering=job.action==="continue" && job.mode==="steer";
    if(steering) await api("/report",{
      id:job.id,status:"opening",tabId:tab.id,sendIntent:true,
    });
    try {
      const result=await messageTab(tab,job);
      if(result.taskId) {
        try {await noteOwnedTask(tab.id,job,result.taskId);}
        catch(error) {console.warn("[ChatQueue] 远程任务归属暂未同步",error);}
      }
      if(job.action==="new_chat" && result.status==="queued")
        return {status:"waiting",tabId:tab.id,taskId:result.taskId,
          error:"首条消息已安全入队，等待 ChatGPT 建立新对话"};
      return result;
    } catch(error) {
      if(steering) return {status:"review_required",tabId:tab.id,
        error:"引导已开始但未获得完整回执；需要核对旧对话，不自动重复发送"};
      if(error.message==="CQ_REMOTE_TAB_TIMEOUT")
        return {status:"waiting",tabId:tab.id,
          error:"浏览器消息回执超时，稍后核对原提交 ID；不会重新开页"};
      if(/Receiving end does not exist|Could not establish connection|扩展页面尚未初始化|context invalidated|队列尚未绑定当前页面|插件还没初始化/i.test(error.message))
        return {status:"waiting",tabId:tab.id,error:"队列扩展页面尚未就绪"};
      if(/目标旧对话正在执行、暂停或交接/.test(error.message))
        return {status:"waiting",tabId:tab.id,error:"旧对话繁忙；新后台页等待安全接管"};
      throw error;
    }
  }

  async function tick() {
    if(running) return;
    running=true;
    try {
      try {await refreshTargets();}
      catch {return;} // Bridge not running / extension hasn't connected.
      try {await flushRemoteResults();}
      catch(error) {console.warn("[ChatQueue] 远程结果稍后重试",error);}
      try {await releaseFinishedJobs();}
      catch(error) {console.warn("[ChatQueue] 后台标签自动释放暂时延迟",error);}
      try {
        const release=await api("/releases/poll");
        if(release.request) await releaseTeamRun(release.request);
      }catch(error) {console.warn("[ChatQueue] 协作窗口释放稍后再试",error);}
      const received=await api("/poll");
      const job=received.job;
      if(!job) return;
      try {
        const result=await executeJob(job);
        await api("/report",{id:job.id,...result});
      } catch(error) {
        // A job whose native click may have happened must never retry blindly.
        const review=job.mode==="steer" && job.attempts>1;
        await api("/report",{id:job.id,
          status:review?"review_required":"failed",error:String(error.message||error).slice(0,320)});
      }
    } catch(error) {
      console.warn("[ChatQueue] 远程桥接器通信暂时中断，保留未确认任务",error);
    } finally { running=false; }
  }

  return {ALARM,tick,listTargets,pickTarget,findOrOpen,executeJob,flushRemoteResults,
    onTaskFinished,onTabActivated,onTabNavigated,onTabRemoved,
    releaseOwnedChat,releaseFinishedJobs};
})();
