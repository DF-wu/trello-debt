// Service worker：離線快取 app 外殼、Background Sync 補送佇列、接收系統「分享」進來的照片。
// 不碰 api.trello.com 的請求（那些交給頁面或 sync 事件自己 fetch）。

import { kv, IdbQueueStore, inbox } from './js/db.js';
import { TrelloApi } from './js/trello.js';
import { processQueue, runExclusive, makeId } from './js/queue.js';
import { SYNC_TAG, LOCK_NAME } from './js/config.js';

const VERSION = '1.0.0';
const CACHE = `trello-debt-${VERSION}`;
const SHELL = [
  './',
  './index.html',
  './css/app.css',
  './js/app.js',
  './js/config.js',
  './js/db.js',
  './js/images.js',
  './js/queue.js',
  './js/rules.js',
  './js/trello.js',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-512-maskable.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  if (req.method === 'POST' && url.origin === self.location.origin && url.pathname.endsWith('/share-target')) {
    event.respondWith(handleShareTarget(req));
    return;
  }

  if (req.method !== 'GET' || url.origin !== self.location.origin) return;

  if (req.mode === 'navigate') {
    event.respondWith(networkFirst(req));
    return;
  }
  event.respondWith(staleWhileRevalidate(req));
});

async function networkFirst(req) {
  try {
    const res = await fetch(req);
    if (res.ok) {
      const cache = await caches.open(CACHE);
      cache.put('./index.html', res.clone()).catch(() => {});
    }
    return res;
  } catch {
    const cached = (await caches.match(req)) || (await caches.match('./index.html'));
    return cached || new Response('offline', { status: 503, headers: { 'Content-Type': 'text/plain' } });
  }
}

async function staleWhileRevalidate(req) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(req);
  const network = fetch(req)
    .then((res) => {
      if (res && res.ok) cache.put(req, res.clone()).catch(() => {});
      return res;
    })
    .catch(() => null);
  if (cached) return cached;
  const res = await network;
  return res || new Response('offline', { status: 503, headers: { 'Content-Type': 'text/plain' } });
}

async function handleShareTarget(req) {
  const redirectTo = new URL('./?shared=1', self.registration.scope).toString();
  try {
    const form = await req.formData();
    const files = form.getAll('photos').filter((f) => f && typeof f === 'object' && 'size' in f);
    await inbox.add({
      id: makeId(),
      createdAt: Date.now(),
      title: String(form.get('title') || ''),
      text: String(form.get('text') || ''),
      files: files.map((f) => ({ blob: f, name: f.name || 'photo.jpg', type: f.type || '', size: f.size })),
    });
  } catch (err) {
    console.warn('share-target 處理失敗', err);
  }
  return Response.redirect(redirectTo, 303);
}

self.addEventListener('sync', (event) => {
  if (event.tag === SYNC_TAG) event.waitUntil(syncFromSw());
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'sync') event.waitUntil?.(syncFromSw());
});

async function syncFromSw() {
  const settings = await kv.get('settings');
  if (!settings?.token) return;
  const api = new TrelloApi({ apiKey: settings.apiKey, token: settings.token });
  const store = new IdbQueueStore();
  const result = await runExclusive(LOCK_NAME, () => processQueue({ store, api, settings }));
  if (!result || !result.processed) return;
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const c of clients) c.postMessage({ type: 'queue-updated', result });
}
