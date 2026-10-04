import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEntry, processEntry, processQueue, MemoryQueueStore, STATUS, MAX_AUTO_ATTEMPTS, backoffMs, runExclusive } from '../js/queue.js';
import { TrelloError } from '../js/trello.js';

const settings = {
  token: 't',
  categories: [{ id: 'c1', name: '吃', listId: 'L1', labelIds: [], keywords: [] }],
  defaultCategoryId: 'c1',
  titleTemplate: '{title}',
  descTemplate: '{content}',
  amountFieldId: 'cf1',
  position: 'top',
};

function fakeApi(opts = {}) {
  const calls = [];
  let n = 0;
  return {
    calls,
    async createCard(card) {
      calls.push(['createCard', card]);
      if (opts.failCreate) throw opts.failCreate;
      n += 1;
      return { id: `card${n}`, shortUrl: `https://trello.com/c/x${n}`, name: card.name };
    },
    async setCustomField(cardId, fieldId, value) {
      calls.push(['setCustomField', cardId, fieldId, value]);
      if (opts.failCustomField) throw opts.failCustomField;
    },
    async addAttachment(cardId, blob, name) {
      calls.push(['addAttachment', cardId, name]);
      if (opts.failAttachment && opts.failAttachment(name)) throw new TrelloError('boom', 500);
    },
  };
}

const blob = (s) => new Blob([s], { type: 'image/jpeg' });

test('createEntry 正規化欄位', () => {
  const e = createEntry({ title: '  a ', amount: '12', files: [{ blob: blob('x'), name: 'p.jpg' }] }, 5);
  assert.equal(e.title, 'a');
  assert.equal(e.amount, 12);
  assert.equal(e.status, STATUS.PENDING);
  assert.equal(e.createdAt, 5);
  assert.equal(e.files[0].size, 1);
  assert.equal(e.files[0].type, 'image/jpeg');
});

test('完整流程：建卡 → 自訂欄位 → 附件 → done，並丟掉 blob', async () => {
  const store = new MemoryQueueStore();
  const api = fakeApi();
  const e = createEntry({ title: 'a', amount: 10, files: [{ blob: blob('1'), name: 'a.jpg' }, { blob: blob('2'), name: 'b.jpg' }] });
  await store.put(e);
  const r = await processEntry(e, { api, settings, store, now: () => 100 });
  assert.equal(r.status, STATUS.DONE);
  assert.equal(r.cardId, 'card1');
  assert.equal(r.cardUrl, 'https://trello.com/c/x1');
  assert.equal(r.categoryName, '吃');
  assert.deepEqual(r.attached, [0, 1]);
  assert.equal(r.files[0].blob, undefined);
  assert.deepEqual(
    api.calls.map((c) => c[0]),
    ['createCard', 'setCustomField', 'addAttachment', 'addAttachment'],
  );
  assert.deepEqual(api.calls[1].slice(1), ['card1', 'cf1', { number: '10' }]);
  const stored = await store.get(e.id);
  assert.equal(stored.status, STATUS.DONE);
});

test('附件中途失敗 → 重跑不會重複建卡、只補沒傳的附件', async () => {
  const store = new MemoryQueueStore();
  let fail = true;
  const api = fakeApi({ failAttachment: (name) => fail && name === 'b.jpg' });
  const e = createEntry({
    title: 'a',
    amount: 10,
    files: [{ blob: blob('1'), name: 'a.jpg' }, { blob: blob('2'), name: 'b.jpg' }, { blob: blob('3'), name: 'c.jpg' }],
  });
  await store.put(e);
  let r = await processEntry(e, { api, settings, store, now: () => 1000 });
  assert.equal(r.status, STATUS.PENDING);
  assert.equal(r.attempts, 1);
  assert.equal(r.nextRetryAt, 1000 + backoffMs(1));
  assert.deepEqual(r.attached, [0]);
  assert.match(r.error, /boom/);

  fail = false;
  r = await processEntry(r, { api, settings, store, now: () => 2000 });
  assert.equal(r.status, STATUS.DONE);
  assert.deepEqual(r.attached, [0, 1, 2]);
  assert.equal(api.calls.filter((c) => c[0] === 'createCard').length, 1);
  assert.deepEqual(
    api.calls.filter((c) => c[0] === 'addAttachment').map((c) => c[2]),
    ['a.jpg', 'b.jpg', 'b.jpg', 'c.jpg'],
  );
});

test('自訂欄位失敗 → 重跑時只補欄位，不重建卡', async () => {
  const store = new MemoryQueueStore();
  const api = fakeApi({ failCustomField: new TrelloError('x', 503) });
  const e = createEntry({ title: 'a', amount: 1 });
  await store.put(e);
  let r = await processEntry(e, { api, settings, store });
  assert.equal(r.status, STATUS.PENDING);
  assert.equal(r.cardId, 'card1');
  assert.equal(r.customFieldsDone, false);
  api.setCustomField = async (...args) => {
    api.calls.push(['setCustomField', ...args]);
  };
  r = await processEntry(r, { api, settings, store });
  assert.equal(r.status, STATUS.DONE);
  assert.equal(api.calls.filter((c) => c[0] === 'createCard').length, 1);
});

test('4xx 錯誤直接 ERROR，不自動重試', async () => {
  const store = new MemoryQueueStore();
  const api = fakeApi({ failCreate: new TrelloError('invalid id', 400) });
  const e = createEntry({ title: 'a', amount: 1 });
  await store.put(e);
  const r = await processEntry(e, { api, settings, store });
  assert.equal(r.status, STATUS.ERROR);
  assert.equal(r.nextRetryAt, 0);
});

test('沒有清單設定 → ERROR（RulesError 不重試）', async () => {
  const store = new MemoryQueueStore();
  const api = fakeApi();
  const e = createEntry({ title: 'a', amount: 1 });
  await store.put(e);
  const r = await processEntry(e, { api, settings: { ...settings, categories: [] }, store });
  assert.equal(r.status, STATUS.ERROR);
  assert.match(r.error, /清單/);
  assert.equal(api.calls.length, 0);
});

test('連續失敗達上限後變 ERROR', async () => {
  const store = new MemoryQueueStore();
  const api = fakeApi({ failCreate: new TrelloError('down', 503) });
  const e = createEntry({ title: 'a', amount: 1 });
  await store.put(e);
  let r = e;
  for (let i = 1; i < MAX_AUTO_ATTEMPTS; i++) {
    r = await processEntry(r, { api, settings, store });
    assert.equal(r.status, STATUS.PENDING, `attempt ${i}`);
  }
  r = await processEntry(r, { api, settings, store });
  assert.equal(r.status, STATUS.ERROR);
  assert.equal(r.attempts, MAX_AUTO_ATTEMPTS);
});

test('processQueue 依序處理、跳過還沒到重試時間的、running 視為中斷重跑', async () => {
  const store = new MemoryQueueStore();
  const api = fakeApi();
  const a = createEntry({ title: 'a', amount: 1 }, 1);
  const b = createEntry({ title: 'b', amount: 2 }, 2);
  b.nextRetryAt = 5000;
  const c = createEntry({ title: 'c', amount: 3 }, 3);
  c.status = STATUS.RUNNING;
  c.cardId = 'cardOld';
  c.customFieldsDone = true;
  const d = createEntry({ title: 'd', amount: 4 }, 4);
  d.status = STATUS.DONE;
  for (const e of [a, b, c, d]) await store.put(e);

  const seen = [];
  const result = await processQueue({ store, api, settings, now: () => 1000, onEntry: (e) => seen.push(e.title) });
  assert.deepEqual(seen, ['a', 'c']);
  assert.equal(result.processed, 2);
  assert.equal(result.done, 2);
  assert.equal(result.waiting, 1);
  assert.equal(result.nextRetryAt, 5000);
  assert.equal((await store.get(c.id)).cardId, 'cardOld');
  assert.equal(api.calls.filter((x) => x[0] === 'createCard').length, 1);

  const forced = await processQueue({ store, api, settings, now: () => 1000, force: true });
  assert.equal(forced.processed, 1);
  assert.equal((await store.get(b.id)).status, STATUS.DONE);
});

test('processQueue 沒 token 就跳過', async () => {
  const r = await processQueue({ store: new MemoryQueueStore(), api: fakeApi(), settings: { token: '' } });
  assert.equal(r.skipped, 'no-auth');
});

test('backoff 上限 10 分鐘', () => {
  assert.equal(backoffMs(1), 15_000);
  assert.equal(backoffMs(2), 30_000);
  assert.equal(backoffMs(20), 600_000);
});

test('runExclusive 沒有 Web Locks 時本地互斥', async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const first = runExclusive('x', async () => {
    await gate;
    return 'first';
  });
  const second = await runExclusive('x', async () => 'second');
  assert.equal(second, null);
  release();
  assert.equal(await first, 'first');
  assert.equal(await runExclusive('x', async () => 'third'), 'third');
});
