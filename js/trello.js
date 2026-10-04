// 極薄的 Trello REST client。只做這個 app 需要的幾個呼叫。
// 429 / 5xx / 網路錯誤會自動重試幾次，其餘錯誤丟 TrelloError 給上層決定。

const BASE = 'https://api.trello.com/1';

export class TrelloError extends Error {
  constructor(message, status = 0, body = '') {
    super(message);
    this.name = 'TrelloError';
    this.status = status;
    this.body = body;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function describe(status, text) {
  let detail = String(text ?? '').trim();
  try {
    const j = JSON.parse(detail);
    detail = j.message || j.error || detail;
  } catch {
    /* 純文字 */
  }
  detail = detail.slice(0, 200);
  switch (status) {
    case 400:
      return `Trello 拒絕請求：${detail || 'bad request'}`;
    case 401:
      return `Trello 授權失敗（${detail || 'token 無效或已過期'}），請到設定重新連結`;
    case 403:
      return `Trello 拒絕存取：${detail || '沒有權限'}`;
    case 404:
      return `Trello 找不到資源（清單或卡片可能已被刪除）${detail ? '：' + detail : ''}`;
    case 413:
      return '附件太大，Trello 拒絕上傳';
    case 429:
      return 'Trello 流量限制，稍後自動重試';
    default:
      return status >= 500 ? `Trello 伺服器錯誤 (${status})` : `Trello 錯誤 ${status}：${detail}`;
  }
}

export class TrelloApi {
  constructor({ apiKey, token, fetchFn, retries = 2, baseUrl = BASE } = {}) {
    this.apiKey = apiKey;
    this.token = token;
    this.fetchFn = fetchFn || ((...args) => globalThis.fetch(...args));
    this.retries = retries;
    this.baseUrl = baseUrl;
  }

  url(path, query = {}) {
    const u = new URL(this.baseUrl + path);
    u.searchParams.set('key', this.apiKey ?? '');
    u.searchParams.set('token', this.token ?? '');
    for (const [k, v] of Object.entries(query)) {
      if (v == null || v === '') continue;
      u.searchParams.set(k, Array.isArray(v) ? v.join(',') : String(v));
    }
    return u.toString();
  }

  async request(method, path, { query, json, form } = {}) {
    const headers = { Accept: 'application/json' };
    let body;
    if (json !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(json);
    } else if (form) {
      body = form; // FormData，瀏覽器自己補 multipart boundary
    }

    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        res = await this.fetchFn(this.url(path, query), { method, headers, body });
      } catch (err) {
        if (attempt < this.retries) {
          await sleep(1000 * 2 ** attempt);
          continue;
        }
        throw new TrelloError(`網路錯誤：${err?.message || err}`, 0);
      }

      const text = await res.text().catch(() => '');
      if (res.ok) {
        if (!text) return null;
        try {
          return JSON.parse(text);
        } catch {
          return text;
        }
      }

      const transient = res.status === 429 || res.status >= 500;
      if (transient && attempt < this.retries) {
        const retryAfter = Number(res.headers?.get?.('retry-after'));
        await sleep(retryAfter > 0 ? retryAfter * 1000 : 1500 * 2 ** attempt);
        continue;
      }
      throw new TrelloError(describe(res.status, text), res.status, text);
    }
  }

  me() {
    return this.request('GET', '/members/me', { query: { fields: 'id,fullName,username' } });
  }

  boards() {
    return this.request('GET', '/members/me/boards', { query: { fields: 'id,name,shortUrl', filter: 'open' } });
  }

  lists(boardId) {
    return this.request('GET', `/boards/${boardId}/lists`, { query: { fields: 'id,name,pos', filter: 'open' } });
  }

  labels(boardId) {
    return this.request('GET', `/boards/${boardId}/labels`, { query: { fields: 'id,name,color', limit: 1000 } });
  }

  // 看板沒啟用 Custom Fields power-up 時 Trello 可能回錯誤；視為沒有欄位。
  async customFields(boardId) {
    try {
      const fields = await this.request('GET', `/boards/${boardId}/customFields`);
      return Array.isArray(fields) ? fields : [];
    } catch (err) {
      if (err instanceof TrelloError && err.status && err.status !== 401) return [];
      throw err;
    }
  }

  listCards(listId) {
    return this.request('GET', `/lists/${listId}/cards`, {
      query: { fields: 'id,name,desc,shortUrl,pos', pluginData: 'true' },
    });
  }

  updateCard(cardId, fields) {
    return this.request('PUT', `/cards/${cardId}`, { json: fields });
  }

  createCard({ idList, name, desc, pos, idLabels }) {
    return this.request('POST', '/cards', {
      json: {
        idList,
        name,
        desc: desc || '',
        pos: pos || 'top',
        idLabels: Array.isArray(idLabels) && idLabels.length ? idLabels.join(',') : undefined,
      },
    });
  }

  setCustomField(cardId, fieldId, value) {
    return this.request('PUT', `/cards/${cardId}/customField/${fieldId}/item`, { json: { value } });
  }

  addAttachment(cardId, blob, name) {
    const form = new FormData();
    form.append('file', blob, name || 'attachment');
    if (name) form.append('name', name);
    if (blob?.type) form.append('mimeType', blob.type);
    return this.request('POST', `/cards/${cardId}/attachments`, { form });
  }
}

export function authorizeUrl({ apiKey, appName, returnUrl }) {
  const u = new URL('https://trello.com/1/authorize');
  u.searchParams.set('expiration', 'never');
  u.searchParams.set('name', appName || 'Trello Debt');
  u.searchParams.set('scope', 'read,write');
  u.searchParams.set('response_type', 'token');
  u.searchParams.set('key', apiKey);
  if (returnUrl) {
    u.searchParams.set('callback_method', 'fragment');
    u.searchParams.set('return_url', returnUrl);
  }
  return u.toString();
}
