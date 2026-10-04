// 頁面邏輯：記帳表單、佇列顯示、設定頁。資料存取都走 db.js，Trello 流程走 queue.js。

import {
  APP_NAME,
  DEFAULT_SETTINGS,
  BOARD_NAME_HINT,
  DEFAULT_LIST_HINT,
  DEFAULT_LABEL_HINT,
  SKIP_LIST_PATTERN,
  SYNC_TAG,
  LOCK_NAME,
} from './config.js';
import { kv, IdbQueueStore, inbox, idbAvailable } from './db.js';
import { TrelloApi, authorizeUrl } from './trello.js';
import { createEntry, processQueue, runExclusive, STATUS, MemoryQueueStore, makeId } from './queue.js';
import { compressImage, isImage } from './images.js';
import { formatAmount, parseAmount, splitKeywords, summarizeList, isSummaryCard, buildSummaryDesc } from './rules.js';

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const clone = (o) => JSON.parse(JSON.stringify(o));
const MAX_FILES = 12;

const state = {
  settings: null,
  boardMeta: null, // { boardId, lists, labels, customFields, fetchedAt }
  boards: [], // 設定頁載入的看板清單
  draft: null, // 設定頁的工作副本，按「儲存」才寫回 settings
  pendingFiles: [], // [{ id, file, url }]
  selectedCategoryId: '',
  syncing: false,
  busy: false,
  retryTimer: 0,
  installPrompt: null,
};
let store;
let toastTimer = 0;

// ---------------------------------------------------------------- utils
function toast(msg, isErr = false, ms = isErr ? 4000 : 2200) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.toggle('err', isErr);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), ms);
}

function fmtTime(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function normalizeSettings(raw) {
  const s = { ...DEFAULT_SETTINGS, ...(raw || {}) };
  s.categories = Array.isArray(s.categories)
    ? s.categories.map((c) => ({
        id: c.id || makeId(),
        name: String(c.name ?? ''),
        listId: String(c.listId ?? ''),
        labelIds: Array.isArray(c.labelIds) ? c.labelIds.filter(Boolean) : [],
        keywords: splitKeywords(c.keywords),
      }))
    : [];
  s.compressImages = s.compressImages === true || s.compressImages === 'true';
  s.imageMaxEdge = clampNum(s.imageMaxEdge, 480, 4096, DEFAULT_SETTINGS.imageMaxEdge);
  s.imageQuality = clampNum(s.imageQuality, 0.3, 1, DEFAULT_SETTINGS.imageQuality);
  s.maxAttachmentMB = clampNum(s.maxAttachmentMB, 1, 250, DEFAULT_SETTINGS.maxAttachmentMB);
  s.position = s.position === 'bottom' ? 'bottom' : 'top';
  return s;
}

function clampNum(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

async function saveSettings(s) {
  state.settings = normalizeSettings(s);
  await kv.set('settings', state.settings);
}

function apiFrom(s) {
  return new TrelloApi({ apiKey: (s.apiKey || '').trim(), token: (s.token || '').trim() });
}

function appUrl() {
  return location.origin + location.pathname;
}

// ---------------------------------------------------------------- init
async function init() {
  store = (await idbAvailable()) ? new IdbQueueStore() : new MemoryQueueStore();
  if (store instanceof MemoryQueueStore) toast('瀏覽器不支援本機儲存，離開頁面會遺失未送出的紀錄', true, 6000);

  state.settings = normalizeSettings(await kv.get('settings'));
  state.boardMeta = (await kv.get('boardMeta')) || null;
  state.boards = (await kv.get('boards')) || [];
  state.selectedCategoryId = (await kv.get('lastCategory')) || '';

  bindEvents();
  registerServiceWorker();

  const tokenFromHash = readTokenFromHash();
  if (tokenFromHash) {
    await saveSettings({ ...state.settings, token: tokenFromHash });
  }
  await handleSharedInbox();

  renderChips();
  renderSetupHint();
  renderTotalSection();
  await refreshQueueUI();

  if (!state.settings.token) {
    openSettings();
    setAuthStatus('請先透過 Trello 授權', 'err');
  } else if (tokenFromHash) {
    openSettings();
    const ok = await testAuth();
    if (ok) await loadBoards({ autoPick: true });
    setAuthStatus('已取得授權，請選擇看板並儲存', 'ok');
  } else if (!state.settings.boardId || !state.settings.categories.length) {
    openSettings();
  } else {
    $('#fTitle').focus();
  }
  syncNow();
}

function readTokenFromHash() {
  const m = location.hash.match(/[#&]token=([A-Za-z0-9]+)/);
  if (!m) return '';
  history.replaceState(null, '', location.pathname + location.search);
  return m[1];
}

async function handleSharedInbox() {
  const params = new URLSearchParams(location.search);
  if (!params.has('shared')) return;
  history.replaceState(null, '', location.pathname);
  let items = [];
  try {
    items = await inbox.takeAll();
  } catch {
    return;
  }
  for (const item of items) {
    if (item.title && !$('#fTitle').value) $('#fTitle').value = item.title;
    if (item.text && !$('#fContent').value) $('#fContent').value = item.text;
    addFiles((item.files || []).map((f) => new File([f.blob], f.name || 'photo.jpg', { type: f.type || f.blob?.type || '' })));
  }
  if (items.length) toast('已帶入分享的照片');
}

// ---------------------------------------------------------------- events
function bindEvents() {
  $('#entryForm').addEventListener('submit', onSubmit);
  $('#fTitle').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      $('#fAmount').focus();
    }
  });
  $('#categoryChips').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    state.selectedCategoryId = chip.dataset.id || '';
    kv.set('lastCategory', state.selectedCategoryId);
    renderChips();
  });
  $('#btnCamera').addEventListener('click', () => $('#fileCamera').click());
  $('#btnGallery').addEventListener('click', () => $('#fileGallery').click());
  for (const id of ['#fileCamera', '#fileGallery']) {
    $(id).addEventListener('change', (e) => {
      addFiles([...e.target.files]);
      e.target.value = '';
    });
  }
  $('#thumbs').addEventListener('click', (e) => {
    const rm = e.target.closest('.rm');
    if (!rm) return;
    removeFile(rm.dataset.id);
  });

  $('#btnSync').addEventListener('click', () => syncNow(true));
  $('#btnTotal').addEventListener('click', computeTotal);
  $('#totalList').addEventListener('change', () => {
    $('#totalOut').hidden = true;
    $('#btnWriteSummary').hidden = true;
  });
  $('#btnWriteSummary').addEventListener('click', writeSummary);
  $('#queueList').addEventListener('click', onQueueAction);
  $('#btnSettings').addEventListener('click', openSettings);
  $('#btnOpenSetup').addEventListener('click', openSettings);
  $('#btnCloseSettings').addEventListener('click', closeSettings);
  $('#btnSaveSettings').addEventListener('click', saveDraft);
  $('#btnInstall').addEventListener('click', async () => {
    const p = state.installPrompt;
    if (!p) return;
    state.installPrompt = null;
    $('#btnInstall').hidden = true;
    try {
      await p.prompt();
    } catch {
      /* ignore */
    }
  });

  // settings
  $('#sApiKey').addEventListener('input', updateManualLink);
  $('#btnAuthorize').addEventListener('click', startAuthorize);
  $('#btnTestAuth').addEventListener('click', () => testAuth());
  $('#btnLoadBoards').addEventListener('click', () => loadBoards({ autoPick: true }));
  $('#sBoard').addEventListener('change', onBoardChange);
  $('#catEditor').addEventListener('input', onCatInput);
  $('#catEditor').addEventListener('change', onCatInput);
  $('#catEditor').addEventListener('click', onCatClick);
  $('#btnAddCat').addEventListener('click', () => {
    state.draft.categories.push({ id: makeId(), name: '', listId: '', labelIds: [], keywords: [] });
    renderCatEditor();
    renderDefaultCatSelect();
  });
  $('#btnCatsFromLists').addEventListener('click', catsFromLists);
  $('#sCompress').addEventListener('change', (e) => ($('#compressOpts').hidden = !e.target.checked));
  $('#sDefaultCat').addEventListener('change', (e) => (state.draft.defaultCategoryId = e.target.value));
  $('#btnClearDone').addEventListener('click', async () => {
    await store.deleteWhere((e) => e.status === STATUS.DONE);
    await refreshQueueUI();
    toast('已清除');
  });

  window.addEventListener('online', () => {
    renderOffline();
    syncNow();
  });
  window.addEventListener('offline', () => {
    renderOffline();
    refreshQueueUI();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      refreshQueueUI();
      syncNow();
    }
  });
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    state.installPrompt = e;
    $('#btnInstall').hidden = false;
  });
  renderOffline();
}

function renderOffline() {
  $('#offlineBanner').hidden = navigator.onLine !== false;
}

// ---------------------------------------------------------------- form
function addFiles(files) {
  let added = 0;
  for (const file of files) {
    if (!file || !file.size) continue;
    if (state.pendingFiles.length >= MAX_FILES) {
      toast(`最多 ${MAX_FILES} 個附件`, true);
      break;
    }
    state.pendingFiles.push({ id: makeId(), file, url: isImage(file) ? URL.createObjectURL(file) : null });
    added += 1;
  }
  if (added) renderThumbs();
}

function removeFile(id) {
  const i = state.pendingFiles.findIndex((p) => p.id === id);
  if (i < 0) return;
  const [p] = state.pendingFiles.splice(i, 1);
  if (p.url) URL.revokeObjectURL(p.url);
  renderThumbs();
}

function renderThumbs() {
  $('#thumbs').innerHTML = state.pendingFiles
    .map(
      (p) => `<div class="thumb">${
        p.url ? `<img src="${esc(p.url)}" alt="">` : `<span>${esc(p.file.name)}</span>`
      }<button type="button" class="rm" data-id="${esc(p.id)}" aria-label="移除">✕</button></div>`,
    )
    .join('');
}

function renderChips() {
  const chips = [{ id: '', name: '自動' }, ...state.settings.categories];
  if (!chips.some((c) => c.id === state.selectedCategoryId)) state.selectedCategoryId = '';
  $('#categoryChips').innerHTML = chips
    .map(
      (c) =>
        `<button type="button" class="chip${c.id === state.selectedCategoryId ? ' on' : ''}" data-id="${esc(c.id)}">${esc(
          c.name || '(未命名)',
        )}</button>`,
    )
    .join('');
}

function renderSetupHint() {
  const s = state.settings;
  const el = $('#setupHint');
  let text = '';
  if (!s.token) text = '尚未連結 Trello。';
  else if (!s.boardId) text = '尚未選擇看板。';
  else if (!s.categories.length) text = '尚未建立分類（哪一個清單要放哪種帳）。';
  el.hidden = !text;
  $('#setupHintText').textContent = text;
}

function setSubmitBusy(busy, label) {
  const b = $('#btnSubmit');
  b.disabled = busy;
  b.textContent = busy ? label || '處理中…' : '記一筆';
}

function resetForm() {
  $('#fTitle').value = '';
  $('#fAmount').value = '';
  $('#fContent').value = '';
  for (const p of state.pendingFiles) if (p.url) URL.revokeObjectURL(p.url);
  state.pendingFiles = [];
  renderThumbs();
  $('#fTitle').focus();
}

async function onSubmit(e) {
  e.preventDefault();
  if (state.busy) return;
  const title = $('#fTitle').value.trim();
  const amount = parseAmount($('#fAmount').value);
  if (!title) {
    toast('請輸入標題', true);
    $('#fTitle').focus();
    return;
  }
  if (!Number.isFinite(amount)) {
    toast('請輸入金額', true);
    $('#fAmount').focus();
    return;
  }
  if (!state.settings.token || !state.settings.categories.length) {
    toast('請先完成設定', true);
    openSettings();
    return;
  }

  state.busy = true;
  const { compressImages, imageMaxEdge, imageQuality, maxAttachmentMB } = state.settings;
  setSubmitBusy(true, state.pendingFiles.length && compressImages ? '處理照片…' : '儲存中…');
  try {
    const files = [];
    const limit = maxAttachmentMB * 1048576;
    for (const p of state.pendingFiles) {
      const r = compressImages
        ? await compressImage(p.file, { maxEdge: imageMaxEdge, quality: imageQuality })
        : { blob: p.file, name: p.file.name };
      if (r.blob.size > limit) {
        throw new Error(
          `${p.file.name} 有 ${(r.blob.size / 1048576).toFixed(1)}MB，超過設定的附件上限 ${maxAttachmentMB}MB（可在設定調整或開啟壓縮）`,
        );
      }
      files.push({ blob: r.blob, name: r.name, type: r.blob.type, size: r.blob.size });
    }
    const entry = createEntry({
      title,
      amount,
      content: $('#fContent').value,
      categoryId: state.selectedCategoryId,
      files,
    });
    await store.put(entry);
    resetForm();
    toast(`已加入：${title} $${formatAmount(amount)}`);
    navigator.vibrate?.(30);
    await refreshQueueUI();
    registerBackgroundSync();
    syncNow();
  } catch (err) {
    console.error(err);
    toast(err?.message || String(err), true);
  } finally {
    state.busy = false;
    setSubmitBusy(false);
  }
}

// ---------------------------------------------------------------- queue
async function syncNow(force = false) {
  if (state.syncing) return;
  if (!state.settings?.token) return;
  if (navigator.onLine === false) {
    await refreshQueueUI();
    return;
  }
  clearTimeout(state.retryTimer);
  state.syncing = true;
  renderSyncStatus();
  try {
    const api = apiFrom(state.settings);
    const result = await runExclusive(LOCK_NAME, () =>
      processQueue({ store, api, settings: state.settings, force, onEntry: () => refreshQueueUI() }),
    );
    if (result?.nextRetryAt) {
      const delay = Math.max(1000, result.nextRetryAt - Date.now());
      state.retryTimer = setTimeout(() => syncNow(), delay);
    }
  } catch (err) {
    console.error(err);
    toast(`同步發生錯誤：${err?.message || err}`, true);
  } finally {
    state.syncing = false;
    await refreshQueueUI();
  }
}

let lastEntries = [];
async function refreshQueueUI() {
  let entries;
  try {
    entries = (await store.all()).sort((a, b) => b.createdAt - a.createdAt);
  } catch (err) {
    console.error(err);
    return;
  }
  // 已完成的只留最近 60 筆
  const oldDone = entries.filter((e) => e.status === STATUS.DONE).slice(60);
  if (oldDone.length) {
    const ids = new Set(oldDone.map((e) => e.id));
    entries = entries.filter((e) => !ids.has(e.id));
    store.deleteWhere((e) => ids.has(e.id)).catch(() => {});
  }
  lastEntries = entries;
  $('#queueList').innerHTML = entries.slice(0, 80).map(renderQueueItem).join('');
  renderSyncStatus();
}

function renderQueueItem(e) {
  const files = e.files?.length ? ` · ${e.files.length} 個附件` : '';
  const cat = e.categoryName ? `${e.categoryName} · ` : '';
  let sub = '';
  let subCls = '';
  let actions = '';
  switch (e.status) {
    case STATUS.DONE:
      sub = '✓ 已寫入 Trello';
      actions = `${
        e.cardUrl ? `<a href="${esc(e.cardUrl)}" target="_blank" rel="noopener">開啟卡片</a>` : ''
      }<button type="button" class="link-btn" data-action="delete" data-id="${esc(e.id)}">移除紀錄</button>`;
      break;
    case STATUS.RUNNING:
      sub = e.cardId ? `上傳附件中 ${e.attached.length}/${e.files.length}` : '建立卡片中…';
      break;
    case STATUS.PENDING:
      if (e.attempts) sub = `⟳ 等待自動重試（第 ${e.attempts} 次失敗：${e.error}）`;
      else sub = navigator.onLine === false ? '離線，連線後自動送出' : '排隊中';
      actions = `<button type="button" class="link-btn" data-action="retry" data-id="${esc(
        e.id,
      )}">立即重試</button><button type="button" class="link-btn danger" data-action="delete" data-id="${esc(e.id)}">刪除</button>`;
      break;
    case STATUS.ERROR:
      sub = `✕ 失敗：${e.error}`;
      subCls = 'err';
      actions = `<button type="button" class="link-btn" data-action="retry" data-id="${esc(
        e.id,
      )}">重試</button><button type="button" class="link-btn danger" data-action="delete" data-id="${esc(e.id)}">刪除</button>`;
      break;
  }
  return `<li class="q-item status-${esc(e.status)}">
    <div class="q-main"><span class="q-title">${esc(e.title)}</span><span class="q-amount">$${esc(formatAmount(e.amount))}</span></div>
    <div class="q-sub">${esc(cat)}${esc(fmtTime(e.createdAt))}${esc(files)}</div>
    <div class="q-sub ${subCls}">${esc(sub)}</div>
    ${actions ? `<div class="q-actions">${actions}</div>` : ''}
  </li>`;
}

async function onQueueAction(e) {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  const entry = await store.get(btn.dataset.id);
  if (!entry) return;
  if (btn.dataset.action === 'retry') {
    entry.status = STATUS.PENDING;
    entry.nextRetryAt = 0;
    entry.attempts = 0;
    entry.error = null;
    await store.put(entry);
    await refreshQueueUI();
    syncNow(true);
    return;
  }
  if (btn.dataset.action === 'delete') {
    if (entry.status !== STATUS.DONE) {
      const warn = entry.cardId ? '\n（Trello 上的卡片已建立，不會被刪除，只是不再補傳附件。）' : '';
      if (!confirm(`刪除「${entry.title}」？這筆不會送到 Trello。${warn}`)) return;
    }
    await store.delete(entry.id);
    await refreshQueueUI();
  }
}

function renderSyncStatus() {
  const el = $('#syncStatus');
  const pending = lastEntries.filter((e) => e.status === STATUS.PENDING || e.status === STATUS.RUNNING).length;
  const errors = lastEntries.filter((e) => e.status === STATUS.ERROR).length;
  let text;
  if (!state.settings?.token) text = '未連結';
  else if (state.syncing) text = `同步中…${pending ? ` (${pending})` : ''}`;
  else if (errors) text = `⚠ ${errors} 筆失敗`;
  else if (pending) text = navigator.onLine === false ? `離線 · ${pending} 筆待送` : `${pending} 筆待送`;
  else text = '✓ 已同步';
  el.textContent = text;
}

// ---------------------------------------------------------------- 清單總計（免費方案沒有 Custom Fields，用這個取代 Smart Fields 的加總）
let lastTotal = null; // { listId, cards, summary }

function renderTotalSection() {
  const lists = state.boardMeta?.boardId === state.settings.boardId ? state.boardMeta?.lists || [] : [];
  const sec = $('#totalSection');
  sec.hidden = !state.settings.token || !lists.length;
  if (sec.hidden) return;
  const sel = $('#totalList');
  const defaultCat = state.settings.categories.find((c) => c.id === state.settings.defaultCategoryId);
  const current = sel.value || defaultCat?.listId || lists[0].id;
  sel.innerHTML = lists
    .map((l) => `<option value="${esc(l.id)}"${l.id === current ? ' selected' : ''}>${esc(l.name)}</option>`)
    .join('');
}

async function computeTotal() {
  const listId = $('#totalList').value;
  if (!listId) return;
  const btn = $('#btnTotal');
  btn.disabled = true;
  btn.textContent = '計算中…';
  try {
    const cards = await apiFrom(state.settings).listCards(listId);
    const summary = summarizeList(cards);
    lastTotal = { listId, cards, summary };
    const sources = summary.items.filter((i) => i.source === 'smartfield').length;
    const out = $('#totalOut');
    out.innerHTML = `
      <div class="total-big">$${esc(formatAmount(summary.total))}</div>
      <div class="muted">${summary.count} 筆${sources ? `（${sources} 筆讀自 Smart Fields，其餘讀自說明第一行）` : '（讀自說明第一行）'}</div>
      ${
        summary.unparsed.length
          ? `<div class="muted err">${summary.unparsed.length} 張卡讀不到金額，沒算進去：</div><ul>${summary.unparsed
              .map((u) => `<li><a href="${esc(u.shortUrl)}" target="_blank" rel="noopener">${esc(u.name)}</a></li>`)
              .join('')}</ul>`
          : ''
      }`;
    out.hidden = false;
    $('#btnWriteSummary').hidden = !cards.some(isSummaryCard);
  } catch (err) {
    toast(err?.message || String(err), true);
  } finally {
    btn.disabled = false;
    btn.textContent = '計算';
  }
}

async function writeSummary() {
  if (!lastTotal) return;
  const summaryCard = lastTotal.cards.find(isSummaryCard);
  if (!summaryCard) return toast('這個清單沒有 Summary 卡', true);
  const btn = $('#btnWriteSummary');
  btn.disabled = true;
  try {
    const { total, count } = lastTotal.summary;
    const d = new Date();
    const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const desc = buildSummaryDesc(summaryCard.desc, { total, count, date });
    await apiFrom(state.settings).updateCard(summaryCard.id, { desc });
    summaryCard.desc = desc;
    toast(`已寫入「${summaryCard.name}」`);
  } catch (err) {
    toast(err?.message || String(err), true);
  } finally {
    btn.disabled = false;
  }
}

// ---------------------------------------------------------------- service worker
async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  try {
    await navigator.serviceWorker.register('./sw.js', { type: 'module' });
    navigator.serviceWorker.addEventListener('message', (ev) => {
      if (ev.data?.type === 'queue-updated') refreshQueueUI();
    });
  } catch (err) {
    console.warn('service worker 註冊失敗', err);
  }
}

async function registerBackgroundSync() {
  try {
    if (!('serviceWorker' in navigator)) return;
    const reg = await Promise.race([navigator.serviceWorker.ready, new Promise((r) => setTimeout(r, 3000))]);
    if (reg && 'sync' in reg) await reg.sync.register(SYNC_TAG);
  } catch {
    /* 瀏覽器不支援 Background Sync，就靠頁面自己送 */
  }
}

// ---------------------------------------------------------------- settings
function openSettings() {
  state.draft = clone(state.settings);
  const d = state.draft;
  $('#sApiKey').value = d.apiKey;
  $('#sToken').value = d.token;
  $('#sTitleTpl').value = d.titleTemplate;
  $('#sDescTpl').value = d.descTemplate;
  $('#sPosition').value = d.position;
  $('#sCompress').checked = !!d.compressImages;
  $('#sMaxEdge').value = d.imageMaxEdge;
  $('#sQuality').value = d.imageQuality;
  $('#sMaxMB').value = d.maxAttachmentMB;
  $('#compressOpts').hidden = !d.compressImages;
  setAuthStatus('');
  setBoardStatus(state.boardMeta?.boardId === d.boardId && d.boardId ? metaSummary(state.boardMeta) : '');
  renderBoardSelect();
  renderCatEditor();
  renderDefaultCatSelect();
  renderAmountFieldSelect();
  updateManualLink();
  $('#versionInfo').textContent = `${APP_NAME} · 資料只存在這個瀏覽器`;
  $('#settingsView').hidden = false;
  window.scrollTo(0, 0);
  if (d.boardId && state.boardMeta?.boardId !== d.boardId && d.token) loadBoardMeta(d.boardId).catch(() => {});
}

function closeSettings() {
  state.draft = null;
  $('#settingsView').hidden = true;
}

function readDraftInputs() {
  const d = state.draft;
  d.apiKey = $('#sApiKey').value.trim();
  d.token = $('#sToken').value.trim();
  d.titleTemplate = $('#sTitleTpl').value;
  d.descTemplate = $('#sDescTpl').value;
  d.position = $('#sPosition').value;
  d.compressImages = $('#sCompress').checked;
  d.imageMaxEdge = $('#sMaxEdge').value;
  d.imageQuality = $('#sQuality').value;
  d.maxAttachmentMB = $('#sMaxMB').value;
  d.amountFieldId = $('#sAmountField').value;
  d.defaultCategoryId = $('#sDefaultCat').value;
  return d;
}

async function saveDraft() {
  const d = readDraftInputs();
  if (!d.apiKey) return toast('請填 API Key', true);
  if (!d.token) return toast('請先授權取得 Token', true);
  if (!d.boardId) return toast('請選擇看板', true);
  const lists = state.boardMeta?.lists || [];
  for (const c of d.categories) {
    if (!c.listId) return toast(`分類「${c.name || '(未命名)'}」還沒選清單`, true);
    if (!c.name.trim()) c.name = lists.find((l) => l.id === c.listId)?.name || '未命名';
  }
  if (!d.categories.length) return toast('請至少建立一個分類', true);
  if (!d.categories.some((c) => c.id === d.defaultCategoryId)) d.defaultCategoryId = d.categories[0].id;

  await saveSettings(d);
  closeSettings();
  renderChips();
  renderSetupHint();
  renderTotalSection();
  toast('設定已儲存');
  syncNow(true);
}

function setAuthStatus(text, cls = '') {
  const el = $('#authStatus');
  el.textContent = text;
  el.className = `muted ${cls}`;
}

function setBoardStatus(text, cls = '') {
  const el = $('#boardStatus');
  el.textContent = text;
  el.className = `muted ${cls}`;
}

function updateManualLink() {
  const key = $('#sApiKey').value.trim();
  $('#manualAuthLink').href = key ? authorizeUrl({ apiKey: key, appName: APP_NAME }) : '#';
}

async function startAuthorize() {
  const key = $('#sApiKey').value.trim();
  if (!key) return toast('請先填 API Key', true);
  // 先把 key 存起來，回跳後才讀得到
  await saveSettings({ ...state.settings, apiKey: key });
  location.href = authorizeUrl({ apiKey: key, appName: APP_NAME, returnUrl: appUrl() });
}

function draftApi() {
  readDraftInputs();
  return apiFrom(state.draft);
}

async function testAuth() {
  try {
    setAuthStatus('連線中…');
    const me = await draftApi().me();
    setAuthStatus(`已連結：${me.fullName || ''} (@${me.username})`, 'ok');
    return true;
  } catch (err) {
    setAuthStatus(err?.message || String(err), 'err');
    return false;
  }
}

async function loadBoards({ autoPick = false } = {}) {
  try {
    setBoardStatus('載入看板中…');
    const boards = await draftApi().boards();
    state.boards = boards.map((b) => ({ id: b.id, name: b.name, shortUrl: b.shortUrl }));
    await kv.set('boards', state.boards);
    const d = state.draft;
    if (!state.boards.some((b) => b.id === d.boardId)) {
      d.boardId = '';
      d.boardName = '';
    }
    if (!d.boardId && autoPick && state.boards.length) {
      const hit = state.boards.find((b) => b.name.includes(BOARD_NAME_HINT)) || state.boards[0];
      d.boardId = hit.id;
      d.boardName = hit.name;
    }
    renderBoardSelect();
    if (d.boardId) await loadBoardMeta(d.boardId);
    else setBoardStatus(`找到 ${state.boards.length} 個看板，請選擇`);
  } catch (err) {
    setBoardStatus(err?.message || String(err), 'err');
  }
}

function renderBoardSelect() {
  const d = state.draft;
  const sel = $('#sBoard');
  const boards = [...state.boards];
  if (d.boardId && !boards.some((b) => b.id === d.boardId)) boards.unshift({ id: d.boardId, name: d.boardName || d.boardId });
  sel.innerHTML =
    `<option value="">（請選擇看板）</option>` +
    boards.map((b) => `<option value="${esc(b.id)}"${b.id === d.boardId ? ' selected' : ''}>${esc(b.name)}</option>`).join('');
}

async function onBoardChange(e) {
  const d = state.draft;
  d.boardId = e.target.value;
  d.boardName = state.boards.find((b) => b.id === d.boardId)?.name || '';
  if (d.boardId) await loadBoardMeta(d.boardId);
  else {
    state.boardMeta = null;
    renderCatEditor();
    renderAmountFieldSelect();
  }
}

function metaSummary(meta) {
  const numFields = (meta.customFields || []).filter((f) => f.type === 'number').length;
  return `${meta.lists.length} 個清單、${meta.labels.length} 個標籤${numFields ? `、${numFields} 個數字自訂欄位` : ''}`;
}

async function loadBoardMeta(boardId) {
  try {
    setBoardStatus('載入清單與標籤中…');
    const api = draftApi();
    const [lists, labels, customFields] = await Promise.all([api.lists(boardId), api.labels(boardId), api.customFields(boardId)]);
    state.boardMeta = {
      boardId,
      lists: lists.map((l) => ({ id: l.id, name: l.name })),
      labels: labels.map((l) => ({ id: l.id, name: l.name, color: l.color })),
      customFields: customFields.map((f) => ({ id: f.id, name: f.name, type: f.type })),
      fetchedAt: Date.now(),
    };
    await kv.set('boardMeta', state.boardMeta);
    setBoardStatus(metaSummary(state.boardMeta), 'ok');
    if (state.draft && !state.draft.categories.length) catsFromLists();
    renderCatEditor();
    renderDefaultCatSelect();
    renderAmountFieldSelect();
  } catch (err) {
    setBoardStatus(err?.message || String(err), 'err');
  }
}

function catsFromLists() {
  const d = state.draft;
  const lists = state.boardMeta?.lists || [];
  if (!lists.length) return toast('請先選擇看板', true);
  // 已結帳 / 封存的清單不建分類（這種看板常常有幾十個舊清單）；全部都被跳過時才退回建全部。
  let candidates = lists.filter((l) => !SKIP_LIST_PATTERN.test(l.name));
  if (!candidates.length) candidates = lists;
  const labelHit = (state.boardMeta?.labels || []).find((l) => l.name === DEFAULT_LABEL_HINT);
  let added = 0;
  let hinted = null;
  for (const l of candidates) {
    if (d.categories.some((c) => c.listId === l.id)) continue;
    const isHint = l.name.includes(DEFAULT_LIST_HINT);
    const cat = { id: makeId(), name: l.name, listId: l.id, labelIds: isHint && labelHit ? [labelHit.id] : [], keywords: [] };
    d.categories.push(cat);
    if (isHint && !hinted) hinted = cat;
    added += 1;
  }
  if (hinted) d.defaultCategoryId = hinted.id;
  if (!d.categories.some((c) => c.id === d.defaultCategoryId)) d.defaultCategoryId = d.categories[0]?.id || '';
  renderCatEditor();
  renderDefaultCatSelect();
  if (added) toast(`已新增 ${added} 個分類`);
}

const baseColor = (color) => String(color || 'none').split('_')[0];

function renderCatEditor() {
  const d = state.draft;
  const lists = state.boardMeta?.lists || [];
  const labels = state.boardMeta?.labels || [];
  const el = $('#catEditor');
  if (!d.categories.length) {
    el.innerHTML = '<p class="muted">還沒有分類。選好看板後會自動依清單建立，也可以手動新增。</p>';
    return;
  }
  el.innerHTML = d.categories
    .map((c) => {
      const missing = c.listId && !lists.some((l) => l.id === c.listId);
      const listOpts =
        `<option value="">（請選擇清單）</option>` +
        (missing ? `<option value="${esc(c.listId)}" selected>（清單已不存在）</option>` : '') +
        lists.map((l) => `<option value="${esc(l.id)}"${l.id === c.listId ? ' selected' : ''}>${esc(l.name)}</option>`).join('');
      const labelChips = labels.length
        ? labels
            .map(
              (l) =>
                `<button type="button" class="label-chip lc-${esc(baseColor(l.color))}${
                  c.labelIds.includes(l.id) ? ' on' : ''
                }" data-label="${esc(l.id)}">${esc(l.name || l.color || '標籤')}</button>`,
            )
            .join('')
        : '<span class="muted">看板沒有標籤</span>';
      return `<div class="cat-row" data-id="${esc(c.id)}">
        <div class="cat-head">
          <input class="cat-name" placeholder="分類名稱" value="${esc(c.name)}">
          <button type="button" class="link-btn danger cat-del">刪除</button>
        </div>
        <label>寫入清單 <select class="cat-list">${listOpts}</select></label>
        <div class="label-chips">${labelChips}</div>
        <label>關鍵字（逗號分隔）<input class="cat-keywords" value="${esc(c.keywords.join(', '))}" placeholder="例如：午餐, 便當"></label>
      </div>`;
    })
    .join('');
}

function catOf(target) {
  const row = target.closest('.cat-row');
  return row ? state.draft.categories.find((c) => c.id === row.dataset.id) : null;
}

function onCatInput(e) {
  const c = catOf(e.target);
  if (!c) return;
  if (e.target.classList.contains('cat-name')) c.name = e.target.value;
  else if (e.target.classList.contains('cat-keywords')) c.keywords = splitKeywords(e.target.value);
  else if (e.target.classList.contains('cat-list')) c.listId = e.target.value;
  if (e.type === 'change' || e.target.classList.contains('cat-name')) renderDefaultCatSelect();
}

function onCatClick(e) {
  const c = catOf(e.target);
  if (!c) return;
  const chip = e.target.closest('.label-chip');
  if (chip) {
    const id = chip.dataset.label;
    const i = c.labelIds.indexOf(id);
    if (i >= 0) c.labelIds.splice(i, 1);
    else c.labelIds.push(id);
    chip.classList.toggle('on', i < 0);
    return;
  }
  if (e.target.closest('.cat-del')) {
    state.draft.categories = state.draft.categories.filter((x) => x.id !== c.id);
    renderCatEditor();
    renderDefaultCatSelect();
  }
}

function renderDefaultCatSelect() {
  const d = state.draft;
  const sel = $('#sDefaultCat');
  const current = sel.value || d.defaultCategoryId;
  sel.innerHTML = d.categories.length
    ? d.categories
        .map((c) => `<option value="${esc(c.id)}"${c.id === current ? ' selected' : ''}>${esc(c.name || '(未命名)')}</option>`)
        .join('')
    : '<option value="">（尚無分類）</option>';
}

function renderAmountFieldSelect() {
  const d = state.draft;
  const sel = $('#sAmountField');
  const fields = (state.boardMeta?.customFields || []).filter((f) => f.type === 'number');
  const current = sel.value || d.amountFieldId;
  sel.innerHTML =
    '<option value="">（不寫入自訂欄位）</option>' +
    fields.map((f) => `<option value="${esc(f.id)}"${f.id === current ? ' selected' : ''}>${esc(f.name)}</option>`).join('');
}

init().catch((err) => {
  console.error(err);
  toast(`啟動失敗：${err?.message || err}`, true, 8000);
});
