import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TrelloApi, TrelloError, authorizeUrl } from '../js/trello.js';

function fakeFetch(responses) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    const r = responses.shift();
    if (r instanceof Error) throw r;
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      headers: { get: (k) => r.headers?.[k.toLowerCase()] ?? null },
      text: async () => r.body ?? '',
    };
  };
  fn.calls = calls;
  return fn;
}

test('url 帶 key/token 與 query', () => {
  const api = new TrelloApi({ apiKey: 'K', token: 'T' });
  const u = new URL(api.url('/cards', { fields: ['a', 'b'], empty: '', n: 0 }));
  assert.equal(u.origin + u.pathname, 'https://api.trello.com/1/cards');
  assert.equal(u.searchParams.get('key'), 'K');
  assert.equal(u.searchParams.get('token'), 'T');
  assert.equal(u.searchParams.get('fields'), 'a,b');
  assert.equal(u.searchParams.get('empty'), null);
  assert.equal(u.searchParams.get('n'), '0');
});

test('createCard 送 JSON，labels 合併成字串', async () => {
  const f = fakeFetch([{ status: 200, body: '{"id":"c1"}' }]);
  const api = new TrelloApi({ apiKey: 'K', token: 'T', fetchFn: f });
  const r = await api.createCard({ idList: 'L', name: 'n', desc: 'd', pos: 'top', idLabels: ['a', 'b'] });
  assert.deepEqual(r, { id: 'c1' });
  const body = JSON.parse(f.calls[0].init.body);
  assert.equal(body.idLabels, 'a,b');
  assert.equal(f.calls[0].init.method, 'POST');
  assert.equal(f.calls[0].init.headers['Content-Type'], 'application/json');
});

test('429 / 5xx 會重試，重試後成功', async () => {
  const f = fakeFetch([
    { status: 429, headers: { 'retry-after': '0' } },
    { status: 503 },
    { status: 200, body: '[]' },
  ]);
  const api = new TrelloApi({ apiKey: 'K', token: 'T', fetchFn: f });
  const origSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (cb) => origSetTimeout(cb, 0);
  try {
    assert.deepEqual(await api.boards(), []);
  } finally {
    globalThis.setTimeout = origSetTimeout;
  }
  assert.equal(f.calls.length, 3);
});

test('401 不重試，訊息中文化', async () => {
  const f = fakeFetch([{ status: 401, body: 'invalid token' }]);
  const api = new TrelloApi({ apiKey: 'K', token: 'T', fetchFn: f });
  await assert.rejects(api.me(), (err) => err instanceof TrelloError && err.status === 401 && /授權失敗/.test(err.message));
  assert.equal(f.calls.length, 1);
});

test('網路錯誤重試後仍失敗 → status 0', async () => {
  const f = fakeFetch([new TypeError('Failed to fetch'), new TypeError('Failed to fetch')]);
  const api = new TrelloApi({ apiKey: 'K', token: 'T', fetchFn: f, retries: 1 });
  const origSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (cb) => origSetTimeout(cb, 0);
  try {
    await assert.rejects(api.me(), (err) => err instanceof TrelloError && err.status === 0);
  } finally {
    globalThis.setTimeout = origSetTimeout;
  }
});

test('customFields 遇到 4xx 視為沒有欄位', async () => {
  const api = new TrelloApi({ apiKey: 'K', token: 'T', fetchFn: fakeFetch([{ status: 404, body: 'nope' }]) });
  assert.deepEqual(await api.customFields('B'), []);
});

test('addAttachment 用 multipart', async () => {
  const f = fakeFetch([{ status: 200, body: '{"id":"att"}' }]);
  const api = new TrelloApi({ apiKey: 'K', token: 'T', fetchFn: f });
  await api.addAttachment('c1', new Blob(['x'], { type: 'image/jpeg' }), 'p.jpg');
  const form = f.calls[0].init.body;
  assert.ok(form instanceof FormData);
  assert.equal(form.get('name'), 'p.jpg');
  assert.equal(form.get('mimeType'), 'image/jpeg');
  assert.equal(form.get('file').name, 'p.jpg');
  assert.equal(f.calls[0].init.headers['Content-Type'], undefined);
});

test('authorizeUrl', () => {
  const u = new URL(authorizeUrl({ apiKey: 'K', appName: 'App', returnUrl: 'https://x.y/z/' }));
  assert.equal(u.searchParams.get('key'), 'K');
  assert.equal(u.searchParams.get('scope'), 'read,write');
  assert.equal(u.searchParams.get('callback_method'), 'fragment');
  assert.equal(u.searchParams.get('return_url'), 'https://x.y/z/');
  const manual = new URL(authorizeUrl({ apiKey: 'K' }));
  assert.equal(manual.searchParams.get('callback_method'), null);
});
