// lib/db.js — 签到脚本的 IndexedDB 存取（仅在侧边栏使用）
// 数据库 hamsterpunch v1，对象仓库 scripts（keyPath: id）。
// 运行期间侧边栏始终存活（关闭面板即中止运行），所以脚本数据的读写都在面板侧完成。

const HamsterDB = (() => {
  const DB_NAME = "hamsterpunch";
  const DB_VERSION = 1;
  const STORE = "scripts";

  let dbPromise = null;

  /** 打开数据库（结果缓存复用） */
  function open() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains(STORE)) {
            const store = db.createObjectStore(STORE, { keyPath: "id" });
            store.createIndex("updatedAt", "updatedAt");
          }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    }
    return dbPromise;
  }

  /** 在单个事务里操作仓库；fn 返回 IDBRequest 或普通值 */
  async function withStore(mode, fn) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const store = tx.objectStore(STORE);
      let output;
      const result = fn(store);
      if (result && typeof result.addEventListener === "function") {
        result.onsuccess = () => {
          output = result.result;
        };
        result.onerror = () => reject(result.error);
      } else {
        output = result;
      }
      tx.oncomplete = () => resolve(output);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  /** 全部脚本，按更新时间倒序 */
  async function listScripts() {
    const records = (await withStore("readonly", (store) => store.getAll())) || [];
    return records.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async function getScript(id) {
    return (await withStore("readonly", (store) => store.get(id))) || null;
  }

  /** 新建或更新：保留 createdAt，刷新 updatedAt；record.id 为空时自动生成 */
  async function saveScript(record) {
    const now = Date.now();
    const previous = record.id ? await getScript(record.id) : null;
    const next = {
      ...record,
      id: record.id || crypto.randomUUID(),
      createdAt: previous ? previous.createdAt : now,
      updatedAt: now,
    };
    await withStore("readwrite", (store) => store.put(next));
    return next;
  }

  async function deleteScript(id) {
    await withStore("readwrite", (store) => store.delete(id));
  }

  return { listScripts, getScript, saveScript, deleteScript };
})();
