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
