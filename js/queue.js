// 離線佇列與同步流程。每一筆帳是一個 entry，分三步寫入 Trello：
//   1. 建卡片（存下 cardId）→ 2. 寫金額自訂欄位 → 3. 逐張上傳附件（存下已完成的索引）
// 每一步完成都會 store.put，所以 app 被殺掉或斷線後再跑，會從沒做完的那一步接著做，不會重複建卡。

import { buildCard } from './rules.js';

export const STATUS = Object.freeze({
  PENDING: 'pending', // 排隊中（含等待重試）
  RUNNING: 'running', // 正在送
  DONE: 'done',
  ERROR: 'error', // 放棄自動重試，等使用者手動重試或刪除
});

export const MAX_AUTO_ATTEMPTS = 6;

export function makeId() {
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function createEntry({ title, amount, content = '', categoryId = '', files = [] }, now = Date.now()) {
  return {
    id: makeId(),
    createdAt: now,
    updatedAt: now,
    status: STATUS.PENDING,
    attempts: 0,
    nextRetryAt: 0,
    error: null,
    title: String(title ?? '').trim(),
    amount: Number(amount),
    content: String(content ?? ''),
    categoryId: categoryId || '',
    files: files.map((f) => ({
      blob: f.blob,
      name: f.name || 'photo.jpg',
      type: f.type || f.blob?.type || '',
      size: f.size ?? f.blob?.size ?? 0,
    })),
    attached: [],
    customFields: [],
    customFieldsDone: false,
    cardId: null,
    cardUrl: null,
    cardName: '',
    categoryName: '',
  };
}

// 4xx（除了 429）代表資料本身有問題，重試也不會好；其餘都值得再試。
export function isRetryable(err) {
  if (err?.name === 'RulesError') return false;
  if (err?.name === 'TrelloError') {
    const s = err.status;
    return s === 0 || s === 429 || s >= 500;
  }
  return true;
}

export function backoffMs(attempts) {
  return Math.min(15_000 * 2 ** Math.max(0, attempts - 1), 10 * 60_000);
}

export async function processEntry(entry, { api, settings, store, now = () => Date.now() }) {
  entry.status = STATUS.RUNNING;
  entry.updatedAt = now();
  await store.put(entry);

  try {
    if (!entry.cardId) {
      const card = buildCard(entry, settings);
      const created = await api.createCard(card);
      if (!created?.id) throw new Error('Trello 沒有回傳卡片 id');
      entry.cardId = created.id;
      entry.cardUrl = created.shortUrl || created.url || null;
      entry.cardName = created.name || card.name;
      entry.categoryName = card.categoryName;
      entry.customFields = card.customFields;
      entry.customFieldsDone = card.customFields.length === 0;
      entry.updatedAt = now();
      await store.put(entry);
    }

    if (!entry.customFieldsDone) {
      for (const cf of entry.customFields || []) {
        await api.setCustomField(entry.cardId, cf.id, cf.value);
      }
      entry.customFieldsDone = true;
      entry.updatedAt = now();
      await store.put(entry);
    }

    for (let i = 0; i < entry.files.length; i++) {
      if (entry.attached.includes(i)) continue;
      const f = entry.files[i];
      if (!f.blob) throw new Error(`附件 ${f.name} 的檔案內容遺失`);
      await api.addAttachment(entry.cardId, f.blob, f.name);
      entry.attached.push(i);
      entry.updatedAt = now();
      await store.put(entry);
    }

    entry.status = STATUS.DONE;
    entry.error = null;
    entry.nextRetryAt = 0;
    // 寫完就把圖片內容丟掉，只留檔名與大小，省 IndexedDB 空間。
    entry.files = entry.files.map(({ blob, ...rest }) => rest);
    entry.updatedAt = now();
    await store.put(entry);
    return entry;
  } catch (err) {
    entry.attempts += 1;
    entry.error = err?.message || String(err);
    const retry = isRetryable(err) && entry.attempts < MAX_AUTO_ATTEMPTS;
    entry.status = retry ? STATUS.PENDING : STATUS.ERROR;
    entry.nextRetryAt = retry ? now() + backoffMs(entry.attempts) : 0;
    entry.updatedAt = now();
    await store.put(entry);
    return entry;
  }
}

// 依建立順序處理所有 pending / running（running 代表上次被中斷）的 entry。
// 回傳統計與下一次該重試的時間（給呼叫端排 timer 用）。
export async function processQueue({ store, api, settings, now = () => Date.now(), force = false, onEntry } = {}) {
  const result = { processed: 0, done: 0, failed: 0, waiting: 0, nextRetryAt: 0, skipped: null };
  if (!api || !settings?.token) {
    result.skipped = 'no-auth';
    return result;
  }
  const entries = (await store.listByStatus([STATUS.PENDING, STATUS.RUNNING])).sort((a, b) => a.createdAt - b.createdAt);
  for (const entry of entries) {
    if (!force && entry.nextRetryAt > now()) {
      result.waiting += 1;
      result.nextRetryAt = result.nextRetryAt ? Math.min(result.nextRetryAt, entry.nextRetryAt) : entry.nextRetryAt;
      continue;
    }
    const r = await processEntry(entry, { api, settings, store, now });
    result.processed += 1;
    if (r.status === STATUS.DONE) result.done += 1;
    else {
      result.failed += 1;
      if (r.status === STATUS.PENDING && r.nextRetryAt) {
        result.nextRetryAt = result.nextRetryAt ? Math.min(result.nextRetryAt, r.nextRetryAt) : r.nextRetryAt;
      }
    }
    if (onEntry) await onEntry(r);
  }
  return result;
}

// 同一時間只讓一個 context（頁面或 service worker）跑佇列。
// 有 Web Locks 就跨 context 鎖；沒有就只在本 context 內互斥。拿不到鎖回傳 null。
let localBusy = false;
export async function runExclusive(name, fn) {
  const locks = globalThis.navigator?.locks;
  if (locks?.request) {
    return locks.request(name, { ifAvailable: true }, async (lock) => (lock ? fn() : null));
  }
  if (localBusy) return null;
  localBusy = true;
  try {
    return await fn();
  } finally {
    localBusy = false;
  }
}

// 記憶體版 store：測試用，也當 IndexedDB 不能用時的退路（重新整理就沒了）。
export class MemoryQueueStore {
  constructor() {
    this.map = new Map();
  }
  async put(entry) {
    this.map.set(entry.id, structuredClone ? structuredClone(entry) : { ...entry });
    return entry.id;
  }
  async get(id) {
    return this.map.get(id);
  }
  async delete(id) {
    this.map.delete(id);
  }
  async all() {
    return [...this.map.values()];
  }
  async listByStatus(statuses) {
    const set = new Set(statuses);
    return (await this.all()).filter((e) => set.has(e.status));
  }
  async deleteWhere(pred) {
    for (const e of await this.all()) if (pred(e)) this.map.delete(e.id);
  }
}
