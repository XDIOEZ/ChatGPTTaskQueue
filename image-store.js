"use strict";

// Store full images apart from chrome.storage.local's lightweight task state.
// IndexedDB survives tab reloads and extension service-worker suspension.
const cqImageStore = (() => {
  let opening;

  function database() {
    if (!opening) {
      opening = new Promise((resolve, reject) => {
        const request = indexedDB.open("cq.images.v1", 1);
        request.onupgradeneeded = () => request.result.createObjectStore("images", { keyPath: "id" });
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error("图片数据库无法打开"));
      }).catch((error) => { opening = null; throw error; });
    }
    return opening;
  }

  async function save(items) {
    if (!items.length) return;
    const db = await database();
    await new Promise((resolve, reject) => {
      const transaction = db.transaction("images", "readwrite");
      const table = transaction.objectStore("images");
      items.forEach((item) => table.put(item));
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error || new Error("保存图片失败"));
      transaction.onabort = () => reject(transaction.error || new Error("保存图片已中止"));
    });
  }

  async function load(ids) {
    if (!ids.length) return [];
    const db = await database();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction("images", "readonly");
      const table = transaction.objectStore("images");
      const results = new Array(ids.length);
      ids.forEach((id, index) => {
        const request = table.get(id);
        request.onsuccess = () => { results[index] = request.result; };
      });
      transaction.oncomplete = () => {
        if (results.filter(Boolean).length !== ids.length) reject(new Error("队列图片不存在，请先核对该任务，不能只发送文字"));
        else resolve(results);
      };
      transaction.onerror = () => reject(transaction.error || new Error("读取队列图片失败"));
    });
  }

  async function missing(ids) {
    if (!ids.length) return [];
    const db = await database();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction("images", "readonly");
      const table = transaction.objectStore("images");
      const missingIds = [];
      // getKey checks that the original record exists without loading up to
      // 8 MB of base64 for every image referenced in the current conversation.
      for (const id of new Set(ids)) {
        const request = table.getKey(id);
        request.onsuccess = () => {
          if (request.result === undefined) missingIds.push(id);
        };
      }
      transaction.oncomplete = () => resolve(missingIds);
      transaction.onerror = () => reject(transaction.error || new Error("读取图片引用失败"));
      transaction.onabort = () => reject(transaction.error || new Error("图片引用检查中止"));
    });
  }

  async function remove(ids) {
    if (!ids.length) return;
    const db = await database();
    await new Promise((resolve, reject) => {
      const transaction = db.transaction("images", "readwrite");
      const table = transaction.objectStore("images");
      for (const id of ids) table.delete(id);
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error || new Error("清理未完成的备份图片失败"));
      transaction.onabort = () => reject(transaction.error || new Error("备份图片清理已中止"));
    });
  }

  async function prune(keepIds) {
    const db = await database();
    await new Promise((resolve, reject) => {
      const transaction = db.transaction("images", "readwrite");
      const table = transaction.objectStore("images");
      const keys = table.getAllKeys();
      keys.onsuccess = () => {
        for (const key of keys.result) {
          if (!keepIds.has(key)) table.delete(key);
        }
      };
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error || new Error("图片清理失败"));
    });
  }

  return { save, load, missing, remove, prune };
})();
