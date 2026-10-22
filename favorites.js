/* global chrome */
"use strict";

(() => {
  const list = document.getElementById("favorites-list");
  if (!list) return;
  const search = document.getElementById("search-favorites");
  const sort = document.getElementById("sort-favorites");
  const categoryFilter = document.getElementById("filter-category");
  const categoryChoices = document.getElementById("favorite-categories");
  const pinnedButton = document.getElementById("pinned-only");
  const feedback = document.getElementById("feedback");
  const exportButton = document.getElementById("export-favorites");
  const importInput = document.getElementById("import-favorites");
  const importLabel = document.querySelector(".backup-file-label");
  const backupStatus = document.getElementById("backup-status");
  const MAX_BACKUP_BYTES = 60 * 1024 * 1024;
  const BACKUP_FORMAT = "chatgpt-taskqueue-favorites";
  const BACKUP_VERSION = 1;
  let favorites = [];
  let busy = false;
  let pinnedOnly = false;
  let editingId = null;
  let editingDraft = null;
  let editingDirty = false;

  const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;",
  })[char]);

  function showFeedback(message, error = false) {
    feedback.textContent = String(message);
    feedback.classList.toggle("error", error);
    feedback.hidden = false;
  }

  function showBackupProgress(message) {
    backupStatus.hidden = false;
    backupStatus.textContent = String(message);
  }

  function setTransferBusy(value) {
    busy = value;
    exportButton.disabled = value;
    importInput.disabled = value;
    importLabel.setAttribute("aria-disabled", String(value));
    exportButton.setAttribute("aria-busy",String(value));
  }

  async function request(type, fields = {}) {
    const reply = await chrome.runtime.sendMessage({type,...fields});
    if (!reply?.ok) throw new Error(reply?.error || "无法操作收藏夹");
    if (Array.isArray(reply.favorites)) favorites = reply.favorites;
    return reply;
  }

  const categoryOf = (item) => typeof item.category === "string" ? item.category : "";
  const usageOf = (item) => Math.max(0,Number(item.useCount) || 0);
  const createdAt = (item) => Number(item.createdAt) || 0;

  function categories() {
    return [...new Set(favorites.map(categoryOf).filter(Boolean))]
      .sort((a,b) => a.localeCompare(b,"zh-CN"));
  }

  function refreshCategoryOptions() {
    const before = categoryFilter.value;
    // Use DOM option nodes (not HTML interpolation) for untrusted labels.
    categoryFilter.replaceChildren(new Option("全部分类",""),
      new Option("未分类","__none__"),
      ...categories().map((category) => new Option(category,"cat:" + category)));
    categoryFilter.value = [...categoryFilter.options].some((item) => item.value === before)
      ? before : "";
    categoryChoices.replaceChildren(...categories().map((category) =>
      new Option(category,category)));
  }

  function visibleFavorites() {
    const q = search.value.trim().toLocaleLowerCase();
    const selectedCategory = categoryFilter.value;
    const result = favorites.filter((item) =>
      (!pinnedOnly || item.pinned === true) &&
      (!selectedCategory || (selectedCategory === "__none__"
        ? !categoryOf(item) : categoryOf(item) === selectedCategory.slice(4))) &&
      (!q || [item.title,item.text,categoryOf(item),
        ...(item.images || []).map((image) => image.name)]
        .some((value) => String(value || "").toLocaleLowerCase().includes(q))));
    const value = sort.value;
    return result.sort((a,b) => {
      const pinned = Number(b.pinned === true) - Number(a.pinned === true);
      if (pinned) return pinned;
      const diff = value === "name" ? String(a.title).localeCompare(String(b.title),"zh-CN")
        : value === "oldest" ? createdAt(a) - createdAt(b)
        : value === "recent" ? (Number(b.lastUsedAt)||0) - (Number(a.lastUsedAt)||0)
        : value === "popular" ? usageOf(b) - usageOf(a)
        : createdAt(b) - createdAt(a);
      return diff || createdAt(b) - createdAt(a) || String(a.id).localeCompare(String(b.id));
    });
  }

  function renderEditor(item) {
    const values = editingDraft || {
      title:item.title,text:item.text,category:categoryOf(item),
      templateEnabled:item.templateEnabled === true,
    };
    return `<form class="favorite-editor" data-id="${escapeHtml(item.id)}"
      aria-label="编辑 ${escapeHtml(item.title)}">
      <label>收藏名称 <input name="title" type="text" required maxlength="80"
        value="${escapeHtml(values.title)}"></label>
      <label>分类 <input name="category" type="text" maxlength="24"
        list="favorite-categories" placeholder="留空表示未分类"
        value="${escapeHtml(values.category)}"></label>
      <label>提示词正文 <textarea name="text" rows="5" maxlength="12000"
        ${item.images?.length ? "" : "required"}>${escapeHtml(values.text)}</textarea></label>
      <label class="template-mode-label"><input name="templateEnabled" type="checkbox"
        ${values.templateEnabled ? "checked" : ""}>
        使用变量模板（例如 {{项目名}}）
      </label>
      <p>保留原有图文附件；修改收藏正文不会改变已经加入队列的任务。</p>
      <span class="favorite-edit-dirty" ${editingDirty ? "" : "hidden"}>修改尚未保存</span>
      <div class="favorite-editor-actions">
        <button class="primary" type="submit" ${busy ? "disabled" : ""}>保存修改</button>
        <button type="button" data-action="cancel-edit" data-id="${escapeHtml(item.id)}"
          ${busy ? "disabled" : ""}>取消</button>
      </div>
    </form>`;
  }

  function render() {
    refreshCategoryOptions();
    const visible = visibleFavorites();
    const previousEditorId = list.querySelector(".favorite-editor")?.dataset.id || null;
    document.getElementById("favorite-count").textContent = favorites.length;
    document.getElementById("pinned-count").textContent =
      `★ 置顶 ${favorites.filter((item) => item.pinned === true).length}`;
    pinnedButton.setAttribute("aria-pressed", String(pinnedOnly));
    pinnedButton.textContent = pinnedOnly ? "★ 取消筛选" : "☆ 仅置顶";
    document.getElementById("result-count").textContent = `显示 ${visible.length} / ${favorites.length} 条`;
    const focused = document.activeElement;
    const focusedButton = list.contains(focused) ? {id:focused.dataset.id, action:focused.dataset.action} : null;
    const editFocus = list.contains(focused) && focused.closest?.(".favorite-editor")
      ? {name:focused.name, start:focused.selectionStart, end:focused.selectionEnd} : null;
    list.innerHTML = visible.length ? visible.map((item) => `<article class="favorite" data-id="${escapeHtml(item.id)}">
      <div class="favorite-main">
        <div class="favorite-head">
          <h3>${escapeHtml(item.title)}</h3>
          ${categoryOf(item) ? `<span class="favorite-category">${escapeHtml(categoryOf(item))}</span>`
            : '<span class="favorite-category unassigned">未分类</span>'}
          ${item.templateEnabled === true ? '<span class="favorite-template-label">变量模板</span>' : ""}
          <span>${(item.images || []).length ? `图文 · ${item.images.length} 张图片` : "文本"}</span>
        </div>
        <p class="favorite-text">${escapeHtml(item.text.slice(0, 500) || "仅图片任务")}${item.text.length > 500 ? "…" : ""}</p>
        ${(item.images || []).length ? `<div class="thumbnails">${item.images.map((image) =>
          `<img src="${escapeHtml(image.thumbnail)}" alt="${escapeHtml(image.name)}" title="${escapeHtml(image.name)}">`).join("")}</div>` : ""}
        <p class="favorite-usage" title="${item.lastUsedAt ? "最近入队：" + new Date(item.lastUsedAt).toLocaleString("zh-CN") + "。" : ""}仅统计升级后从收藏夹成功入队的次数，不等于实际发送次数">
          已复用 ${usageOf(item)} 次${item.lastUsedAt ? " · 最近使用 " + new Date(item.lastUsedAt).toLocaleDateString("zh-CN") : ""}
        </p>
        ${editingId === item.id ? renderEditor(item) : ""}
      </div>
      <div class="favorite-actions">
        <button type="button" data-action="pin" data-id="${escapeHtml(item.id)}"
          aria-pressed="${item.pinned === true}" aria-label="${item.pinned ? "取消置顶" : "置顶"} ${escapeHtml(item.title)}"
          title="收藏夹置顶，不调整任何对话队列顺序"
          class="${item.pinned ? "is-pinned" : ""}" ${busy ? "disabled" : ""}>${item.pinned ? "★" : "☆"}</button>
        <button type="button" data-action="copy" data-id="${escapeHtml(item.id)}"
          title="${item.text ? "复制提示词文字，图片需从对话队列复用" : "仅图片收藏请在对话队列中入队"}"
          ${busy || !item.text ? "disabled" : ""}>复制</button>
        <button type="button" data-action="edit" data-id="${escapeHtml(item.id)}" ${busy ? "disabled" : ""}>编辑</button>
        <button type="button" data-action="rename" data-id="${escapeHtml(item.id)}" ${busy ? "disabled" : ""}>改名</button>
        <button type="button" data-action="delete" data-id="${escapeHtml(item.id)}" class="danger" ${busy ? "disabled" : ""}>删除</button>
      </div>
    </article>`).join("") : `<div class="empty">${favorites.length
      ? "没有匹配的收藏，换个搜索词试试。" : "还没有收藏。可以在上方新增，或在 ChatGPT 队列任务旁点击 ☆。"}</div>`;
    if (focusedButton?.id) {
      [...list.querySelectorAll("button[data-id]")]
        .find((button) => button.dataset.id === focusedButton.id &&
          button.dataset.action === focusedButton.action)?.focus({preventScroll:true});
    }
    if (editFocus?.name && editingId) {
      const field = list.querySelector(`.favorite-editor [name="${editFocus.name}"]`);
      if (field) {
        field.focus({preventScroll:true});
        if (typeof editFocus.start === "number" && field.setSelectionRange) {
          field.setSelectionRange(editFocus.start,editFocus.end);
        }
      }
    }
    // Only animate when an editor is newly opened; ordinary list refreshes
    // must not flash or disturb a focused input/caret.
    if (editingId && editingId !== previousEditorId &&
        !window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches) {
      list.querySelector(".favorite-editor")?.animate?.([
        {opacity:0.5,transform:"translateY(5px)"},
        {opacity:1,transform:"translateY(0)"},
      ],{duration:180,easing:"ease-out"});
    }
  }

  async function runMutation(work, success) {
    if (busy) return;
    busy = true;
    try {
      await work();
      render();
      showFeedback(success);
    } catch (error) {
      showFeedback(error?.message || "收藏操作失败",true);
    } finally {
      busy = false;
      render();
    }
  }

  async function exportFavoriteBackup() {
    if (busy) return;
    if (editingDirty) {
      showFeedback("先保存或取消正在编辑的收藏，再导出完整备份。",true);
      return;
    }
    setTransferBusy(true);
    try {
      showBackupProgress("正在读取收藏清单并检查图片…");
      const {backup} = await request("GET_FAVORITES_BACKUP_META");
      if (!backup || backup.format !== BACKUP_FORMAT ||
          backup.version !== BACKUP_VERSION || !Array.isArray(backup.images)) {
        throw new Error("后台返回的收藏备份清单无效");
      }
      const images = [];
      for (let i = 0; i < backup.images.length; i++) {
        const source = backup.images[i];
        showBackupProgress(`正在导出原图 ${i + 1}/${backup.images.length}…`);
        const reply = await request("GET_FAVORITES_BACKUP_IMAGE",{imageId:source.id});
        if (!reply.image || reply.image.id !== source.id ||
            !reply.image.dataUrl || !reply.image.sha256) {
          throw new Error("原图导出失败或与清单不一致；不会生成残缺文件");
        }
        images.push(reply.image);
      }
      const file = new Blob([JSON.stringify({...backup,images})],{type:"application/json"});
      if (file.size > MAX_BACKUP_BYTES) {
        throw new Error("备份文件超过 60 MB；不会导出缺少图片的文件");
      }
      const href = URL.createObjectURL(file);
      const anchor = document.createElement("a");
      anchor.href = href;
      anchor.download = "ChatGPTQueue-Favorites-" +
        new Date().toISOString().slice(0,10) + ".json";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(href),60_000);
      showBackupProgress(`已生成完整备份：${backup.favorites.length} 条收藏、${images.length} 张原图。`);
    } catch (error) {
      showBackupProgress("导出未完成，未生成残缺备份文件。");
      showFeedback(error?.message || "导出收藏夹失败",true);
    } finally {
      setTransferBusy(false);
    }
  }

  async function importFavoriteBackup(file) {
    if (busy || !file) return;
    if (editingDirty) {
      showFeedback("先保存或取消正在编辑的收藏，再导入备份。",true);
      return;
    }
    setTransferBusy(true);
    let token = null;
    try {
      if (file.size > MAX_BACKUP_BYTES) {
        throw new Error("备份文件超过 60 MB，未导入任何数据");
      }
      showBackupProgress("正在读取备份并检查清单…");
      const backup = JSON.parse(await file.text());
      if (!backup || backup.format !== BACKUP_FORMAT ||
          backup.version !== BACKUP_VERSION ||
          !Array.isArray(backup.favorites) || !Array.isArray(backup.images)) {
        throw new Error("所选文件不是支持的收藏夹备份 JSON");
      }
      if (!confirm(`准备合并 ${backup.favorites.length} 条收藏和 ${backup.images.length} 张原图。\n\n已有收藏不会被替换，相同正文及图片会自动跳过。确定导入？`)) {
        showBackupProgress("已取消本次导入，现有收藏保持不变。");
        return;
      }
      const metadata = {
        format:backup.format,version:backup.version,exportedAt:backup.exportedAt,
        favorites:backup.favorites,
        images:backup.images.map((image) => ({
          id:image?.id,name:image?.name,type:image?.type,
          size:image?.size,sha256:image?.sha256,
        })),
      };
      const started = await request("RESTORE_FAVORITES_BEGIN",{backup:metadata});
      token = started.token;
      if (typeof token !== "string" || !token) throw new Error("收藏导入初始化失败");
      for (let i = 0; i < backup.images.length; i++) {
        showBackupProgress(`正在校验并导入原图 ${i + 1}/${backup.images.length}…`);
        await request("RESTORE_FAVORITES_IMAGE",{token,image:backup.images[i]});
      }
      showBackupProgress("原图已校验，正在合并收藏并跳过重复项…");
      const result = await request("RESTORE_FAVORITES_FINISH",{token});
      token = null;
      render();
      showBackupProgress(`导入完成：新增 ${result.imported} 条，跳过重复 ${result.skipped} 条。原收藏和队列未被覆盖。`);
      showFeedback(`成功导入 ${result.imported} 条收藏，跳过 ${result.skipped} 条重复内容。 `);
    } catch (error) {
      const message = error?.message || "收藏夹导入失败";
      if (token) {
        try { await request("RESTORE_FAVORITES_ABORT",{token}); }
        catch (abortError) {
          showBackupProgress("导入未完成，暂存图片将在插件后台清理；原有收藏不受影响。");
          showFeedback(message + "；暂存清理暂未确认。",true);
          return;
        }
      }
      showBackupProgress("导入未完成，未覆盖原收藏或队列。");
      showFeedback(message,true);
    } finally {
      setTransferBusy(false);
    }
  }

  exportButton.addEventListener("click",() => void exportFavoriteBackup());
  importInput.addEventListener("change",(event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file) void importFavoriteBackup(file);
  });

  document.getElementById("add-favorite-form").addEventListener("submit",(event) => {
    event.preventDefault();
    const title = document.getElementById("new-title").value.trim();
    const category = document.getElementById("new-category").value.trim();
    const text = document.getElementById("new-text").value;
    const templateEnabled = document.getElementById("new-template-enabled").checked;
    if (!text.trim()) return showFeedback("先填写提示词内容。",true);
    void runMutation(async () => {
      const reply = await request("ADD_FAVORITE",{text,category,templateEnabled,
        ...(title ? {title} : {})});
      if (!reply.alreadySaved) {
        document.getElementById("new-title").value = "";
        document.getElementById("new-text").value = "";
        document.getElementById("new-template-enabled").checked = false;
        // Keep the category to help users file a series of related prompts.
      }
    }, "收藏已保存（如果内容已存在，不会重复创建）");
  });

  function endEditing() {
    editingId = null;
    editingDraft = null;
    editingDirty = false;
  }

  list.addEventListener("input",(event) => {
    const form = event.target.closest?.(".favorite-editor");
    if (!form || form.dataset.id !== editingId || !editingDraft ||
        !["title","text","category","templateEnabled"].includes(event.target.name)) return;
    editingDraft[event.target.name] = event.target.name === "templateEnabled"
      ? event.target.checked : event.target.value;
    const original = favorites.find((item) => item.id === editingId);
    editingDirty = Boolean(original && (
      editingDraft.title !== original.title || editingDraft.text !== original.text ||
      editingDraft.category !== categoryOf(original) ||
      editingDraft.templateEnabled !== (original.templateEnabled === true)));
    const marker = form.querySelector(".favorite-edit-dirty");
    if (marker) marker.hidden = !editingDirty;
  });

  list.addEventListener("submit",(event) => {
    const form = event.target.closest?.(".favorite-editor");
    if (!form) return;
    event.preventDefault();
    if (busy || form.dataset.id !== editingId || !editingDraft) return;
    const id = editingId;
    const draft = {...editingDraft};
    if (!draft.title.trim() || (!draft.text.trim() &&
        !favorites.find((item) => item.id === id)?.images?.length)) {
      return showFeedback("名称不能为空；没有图片的收藏还需要提示词正文。",true);
    }
    void runMutation(async () => {
      await request("UPDATE_FAVORITE",{id, ...draft});
      endEditing();
    },"收藏修改已保存，之前入队的任务保持不变");
  });

  list.addEventListener("click",(event) => {
    const button = event.target.closest("button[data-action][data-id]");
    if (!button || busy) return;
    const item = favorites.find((entry) => entry.id === button.dataset.id);
    if (!item) return;
    if (button.dataset.action === "copy") {
      void navigator.clipboard.writeText(item.text)
        .then(() => showFeedback("文字已复制；图片请从 ChatGPT 队列收藏夹直接入队。"))
        .catch(() => showFeedback("复制失败，请使用 ChatGPT 队列内的收藏夹。",true));
    } else if (button.dataset.action === "pin") {
      const wasPinned = item.pinned === true;
      void runMutation(() => request("UPDATE_FAVORITE",{
        id:item.id, pinned:!wasPinned,
      }),wasPinned ? "已取消置顶" : "已置顶收藏，不影响任何对话的发送顺序");
    } else if (button.dataset.action === "edit") {
      if (editingId !== item.id && editingDirty &&
          !confirm("当前收藏有未保存的修改，确定放弃并编辑另一条吗？")) return;
      if (editingId === item.id) {
        list.querySelector(".favorite-editor input[name=title]")?.focus();
        return;
      }
      editingId = item.id;
      editingDraft = {title:item.title,text:item.text,category:categoryOf(item),
        templateEnabled:item.templateEnabled === true};
      editingDirty = false;
      render();
      list.querySelector(".favorite-editor input[name=title]")?.focus();
    } else if (button.dataset.action === "cancel-edit") {
      if (editingId !== item.id) return;
      if (editingDirty && !confirm("放弃这条收藏尚未保存的修改？")) return;
      endEditing();
      render();
    } else if (button.dataset.action === "rename") {
      if (editingId === item.id && editingDirty &&
          !confirm("当前编辑有未保存的修改，继续改名会放弃这些修改。确定吗？")) return;
      const title = prompt("修改收藏名称（1～80 字）",item.title);
      if (title == null || title === item.title) return;
      void runMutation(async () => {
        await request("RENAME_FAVORITE",{id:item.id,title});
        if (editingId === item.id) endEditing();
      },"名称已更新");
    } else if (button.dataset.action === "delete") {
      if (!confirm(`确定删除收藏「${item.title}」？\n\n已经加入队列的任务不会被删除。`)) return;
      void runMutation(async () => {
        await request("DELETE_FAVORITE",{id:item.id});
        if (editingId === item.id) endEditing();
      },"收藏已删除，现有队列不受影响");
    }
  });

  search.addEventListener("input",render);
  sort.addEventListener("change",render);
  categoryFilter.addEventListener("change",render);
  pinnedButton.addEventListener("click",() => {
    pinnedOnly = !pinnedOnly;
    render();
  });
  document.getElementById("open-dashboard").addEventListener("click",() => {
    void chrome.tabs.create({url:chrome.runtime.getURL("dashboard.html?view=full"),active:true})
      .catch((error) => showFeedback(error?.message || "无法打开管理中心",true));
  });
  chrome.storage.onChanged?.addListener((changes,area) => {
    if (area !== "local" || !changes["cq.state.v2"]) return;
    const next = changes["cq.state.v2"].newValue?.favorites;
    if (Array.isArray(next)) {
      favorites = next;
      // External queue activity can update lastUsedAt while someone is
      // editing a long prompt. Keep their current editor and caret intact.
      if (!editingDirty) render();
    }
  });

  void request("GET_FAVORITES").then(render)
    .catch((error) => {list.innerHTML = '<div class="empty">收藏夹读取失败。</div>';
      showFeedback(error?.message || "无法读取本地收藏夹",true);});
})();
