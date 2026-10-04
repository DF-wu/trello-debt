// 純邏輯：把一筆輸入（標題 / 金額 / 內容 / 分類）依設定轉成 Trello 卡片參數。
// 這個模組不碰 DOM、不碰網路，方便在 node 裡測試。

export class RulesError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RulesError';
    this.code = code;
  }
}

export function parseAmount(raw) {
  if (raw == null) return NaN;
  const s = String(raw).replace(/[,\s$]|NT|元/gi, '');
  if (!s) return NaN;
  return Number(s);
}

export function formatAmount(amount) {
  if (amount == null || amount === '') return '';
  const n = Number(amount);
  if (!Number.isFinite(n)) return String(amount);
  return n.toLocaleString('zh-TW', { maximumFractionDigits: 2 });
}

// "午餐, 便當、咖啡\n飲料" -> ['午餐','便當','咖啡','飲料']
export function splitKeywords(raw) {
  if (Array.isArray(raw)) return raw.map((k) => String(k).trim()).filter(Boolean);
  return String(raw ?? '')
    .split(/[,，、\n;；]/)
    .map((k) => k.trim())
    .filter(Boolean);
}

export function matchKeywords(text, keywords) {
  const hay = String(text ?? '').toLowerCase();
  if (!hay) return false;
  return splitKeywords(keywords).some((k) => hay.includes(k.toLowerCase()));
}

// 決定分類：明確指定 > 關鍵字命中（依分類順序）> 預設分類 > 第一個分類 > null
export function pickCategory(entry, settings) {
  const cats = Array.isArray(settings?.categories) ? settings.categories : [];
  if (entry?.categoryId) {
    const explicit = cats.find((c) => c.id === entry.categoryId);
    if (explicit) return explicit;
  }
  const hay = `${entry?.title ?? ''}\n${entry?.content ?? ''}`;
  const byKeyword = cats.find((c) => matchKeywords(hay, c.keywords));
  if (byKeyword) return byKeyword;
  return cats.find((c) => c.id === settings?.defaultCategoryId) || cats[0] || null;
}

export function templateVars(entry, category, date = new Date(entry?.createdAt || Date.now())) {
  const pad = (n) => String(n).padStart(2, '0');
  return {
    title: String(entry?.title ?? '').trim(),
    content: String(entry?.content ?? '').trim(),
    amount: formatAmount(entry?.amount),
    rawAmount: Number.isFinite(Number(entry?.amount)) ? String(Number(entry.amount)) : '',
    date: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    time: `${pad(date.getHours())}:${pad(date.getMinutes())}`,
    category: category?.name ?? '',
  };
}

// 未知的 {變數} 原樣保留，避免吃掉使用者故意打的大括號。
export function fillTemplate(tpl, vars) {
  return String(tpl ?? '').replace(/\{(\w+)\}/g, (m, k) => (Object.prototype.hasOwnProperty.call(vars, k) ? vars[k] : m));
}

// ---- 讀既有卡片的金額（免費方案沒有 Custom Fields，所以從 Smart Fields 的 pluginData 或說明第一行讀）----

// Smart Fields Power-Up 把值存在卡片 pluginData：{"__CFT_DATA__":{"<varId>":{"v":920}}}
export function amountFromSmartFields(card, varId = '') {
  for (const pd of card?.pluginData || []) {
    let data;
    try {
      data = JSON.parse(pd.value)?.__CFT_DATA__;
    } catch {
      continue;
    }
    if (!data || typeof data !== 'object') continue;
    const slots = varId ? [data[varId]] : Object.values(data).filter((x) => x && typeof x === 'object' && 'v' in x);
    for (const slot of slots) {
      const n = Number(slot?.v);
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}

// 說明第一行：純數字、簡單算式（1155+1050）、或「算式 = 結果」取等號右邊。
export function amountFromDesc(desc) {
  const first = String(desc ?? '')
    .split('\n')
    .map((l) => l.trim())
    .find(Boolean);
  if (!first) return null;
  let s = first.replace(/\\/g, '').replace(/,/g, '');
  if (/[=＝]/.test(s)) s = s.split(/[=＝]/).pop();
  s = s.replace(/(NTD?|TWD|元|\$)/gi, '').trim();
  if (!s || !/^[\d.\s+\-*/()]+$/.test(s) || !/\d/.test(s)) return null;
  try {
    // 上面的白名單只允許數字與四則運算符號，這裡的 Function 不會碰到任何識別字
    const n = Function(`"use strict"; return (${s});`)();
    return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
  } catch {
    return null;
  }
}

export function isSummaryCard(card) {
  return /summary|總計|合計/i.test(card?.name ?? '');
}

export function cardAmount(card, { smartFieldVar = '' } = {}) {
  const sf = amountFromSmartFields(card, smartFieldVar);
  if (sf != null) return { amount: sf, source: 'smartfield' };
  const d = amountFromDesc(card?.desc);
  if (d != null) return { amount: d, source: 'desc' };
  return { amount: null, source: null };
}

export function summarizeList(cards, opts = {}) {
  const items = [];
  const unparsed = [];
  let total = 0;
  for (const card of cards || []) {
    if (isSummaryCard(card)) continue;
    const { amount, source } = cardAmount(card, opts);
    if (amount == null) {
      unparsed.push({ id: card.id, name: card.name, shortUrl: card.shortUrl });
      continue;
    }
    items.push({ id: card.id, name: card.name, shortUrl: card.shortUrl, amount, source });
    total += amount;
  }
  return { total: Math.round(total * 100) / 100, count: items.length, items, unparsed };
}

const AUTO_LINE = /^總計 .*自動計算）\s*$/m;

// 把總計寫在 Summary 卡說明的第一行；之前自動寫的那行會被換掉，使用者自己寫的內容保留。
export function buildSummaryDesc(existingDesc, { total, count, date }) {
  const rest = String(existingDesc ?? '').replace(AUTO_LINE, '').replace(/^\s+/, '');
  const line = `總計 ${formatAmount(total)}（${count} 筆，${date} 自動計算）`;
  return rest ? `${line}\n\n${rest}` : line;
}

export function buildCard(entry, settings) {
  const category = pickCategory(entry, settings);
  const idList = category?.listId || '';
  if (!idList) {
    throw new RulesError('NO_LIST', '找不到要寫入的清單，請到「設定 → 分類規則」建立至少一個分類');
  }
  const vars = templateVars(entry, category);
  const name = fillTemplate(settings.titleTemplate ?? '{title}', vars).trim() || vars.title || '(無標題)';
  const desc = fillTemplate(settings.descTemplate ?? '', vars).trim();

  const customFields = [];
  const n = Number(entry?.amount);
  if (settings.amountFieldId && Number.isFinite(n)) {
    customFields.push({ id: settings.amountFieldId, value: { number: String(n) } });
  }

  return {
    idList,
    name,
    desc,
    pos: settings.position === 'bottom' ? 'bottom' : 'top',
    idLabels: Array.isArray(category?.labelIds) ? [...category.labelIds] : [],
    customFields,
    categoryName: category?.name ?? '',
  };
}
