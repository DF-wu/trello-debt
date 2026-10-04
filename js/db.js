// IndexedDB 封裝：settings 等小資料（kv）、帳務佇列（queue）、分享進來的照片暫存（inbox）。
// 頁面與 service worker 都用這支。IndexedDB 不能用時 kv 退回 localStorage / 記憶體。

const DB_NAME = 'trello-debt';
const DB_VERSION = 1;

let dbPromise = null;

export function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const idb = globalThis.indexedDB;
    if (!idb) {
      reject(new Error('IndexedDB unavailable'));
      return;
    }
    let req;
    try {
      req = idb.open(DB_NAME, DB_VERSION);
    } catch (err) {
      reject(err);
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
      if (!db.objectStoreNames.contains('queue')) {
        db.createObjectStore('queue', { keyPath: 'id' }).createIndex('status', 'status');
      }
      if (!db.objectStoreNames.contains('inbox')) db.createObjectStore('inbox', { keyPath: 'id' });
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };
    req.onerror = () => reject(req.error || new Error('IndexedDB open failed'));
    req.onblocked = () => reject(new Error('IndexedDB blocked'));
  });
  dbPromise.catch(() => {
    dbPromise = null;
  });
  return dbPromise;
}

export async function idbAvailable() {
  try {
    await openDb();
    return true;
  } catch {
    return false;
  }
}

async function withStore(name, mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    let t;
    try {
      t = db.transaction(name, mode);
    } catch (err) {
      reject(err);
      return;
    }
    let req;
    try {
      req = fn(t.objectStore(name));
    } catch (err) {
      reject(err);
      try {
        t.abort();
      } catch {
        /* ignore */
      }
      return;
    }
    t.oncomplete = () => resolve(req?.result);
    t.onerror = () => reject(t.error || new Error('IndexedDB transaction failed'));
    t.onabort = () => reject(t.error || new Error('IndexedDB transaction aborted'));
  });
}

// ---- kv ----------------------------------------------------------------
const memKv = new Map();
const LS_PREFIX = 'trello-debt:';

function lsGet(key) {
  try {
    const raw = globalThis.localStorage?.getItem(LS_PREFIX + key);
    if (raw != null) return JSON.parse(raw);
  } catch {
    /* ignore */
  }
  return memKv.get(key);
}

function lsSet(key, value) {
  memKv.set(key, value);
  try {
    globalThis.localStorage?.setItem(LS_PREFIX + key, JSON.stringify(value));
  } catch {
    /* ignore */
  }
}

function lsDel(key) {
  memKv.delete(key);
  try {
    globalThis.localStorage?.removeItem(LS_PREFIX + key);
  } catch {
    /* ignore */
  }
}

export const kv = {
  async get(key) {
    try {
      const v = await withStore('kv', 'readonly', (s) => s.get(key));
      return v === undefined ? lsGet(key) : v;
    } catch {
      return lsGet(key);
    }
  },
  async set(key, value) {
    try {
      await withStore('kv', 'readwrite', (s) => s.put(value, key));
    } catch {
      lsSet(key, value);
    }
  },
  async del(key) {
    lsDel(key);
    try {
      await withStore('kv', 'readwrite', (s) => s.delete(key));
    } catch {
      /* ignore */
    }
  },
};

// ---- queue -------------------------------------------------------------
export class IdbQueueStore {
  put(entry) {
    return withStore('queue', 'readwrite', (s) => s.put(entry));
  }
  get(id) {
    return withStore('queue', 'readonly', (s) => s.get(id));
  }
  delete(id) {
    return withStore('queue', 'readwrite', (s) => s.delete(id));
  }
  async all() {
    return (await withStore('queue', 'readonly', (s) => s.getAll())) || [];
  }
  async listByStatus(statuses) {
    const set = new Set(statuses);
    return (await this.all()).filter((e) => set.has(e.status));
  }
  async deleteWhere(pred) {
    const victims = (await this.all()).filter(pred);
    if (!victims.length) return;
    await withStore('queue', 'readwrite', (s) => {
      let last;
      for (const e of victims) last = s.delete(e.id);
      return last;
    });
  }
}

// ---- inbox（Web Share Target 收到的檔案）---------------------------------
export const inbox = {
  add(item) {
    return withStore('inbox', 'readwrite', (s) => s.put(item));
  },
  // 取出全部並清空
  async takeAll() {
    const items = await withStore('inbox', 'readwrite', (s) => {
      const req = s.getAll();
      req.onsuccess = () => s.clear();
      return req;
    });
    return items || [];
  },
};
