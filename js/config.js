// 全域常數與預設設定。設定本身存在 IndexedDB（key: settings），這裡只是預設值。

export const APP_NAME = '快速記帳';

// Trello API key 不是秘密（每個瀏覽器請求都會帶在網址上）；真正的秘密是 token，
// token 只存在使用者自己的瀏覽器裡，不會進到 repo。
export const DEFAULT_API_KEY = '93e60036aef0dd70b0f973164b41815d';

// 第一次載入看板清單時，優先自動選到名稱含這個字的看板。
export const BOARD_NAME_HINT = '債務';
// 自動建分類時：預設分類優先用名稱含這個字的清單，並自動掛上這個標籤。
export const DEFAULT_LIST_HINT = '爸爸債務';
export const DEFAULT_LABEL_HINT = 'DF債權';
// 自動建分類時跳過的清單（已結帳 / 封存 / 總結）。
export const SKIP_LIST_PATTERN = /paid|archiv|done|summary|結[帳賬]/i;

export const SYNC_TAG = 'trello-debt-sync';
export const LOCK_NAME = 'trello-debt-queue';

export const DEFAULT_SETTINGS = Object.freeze({
  apiKey: DEFAULT_API_KEY,
  token: '',
  boardId: '',
  boardName: '',
  // 分類：{ id, name, listId, labelIds: [], keywords: [] }
  categories: [],
  defaultCategoryId: '',
  // 跟使用者既有習慣一致：標題只放品項，說明第一行是純數字金額
  titleTemplate: '{title}',
  descTemplate: '{rawAmount}\n\n{content}',
  // 金額要寫入的 Trello 自訂欄位（number 型），空字串 = 不寫入
  amountFieldId: '',
  position: 'top',
  // 預設不壓縮，照片原檔上傳；只有超過 maxAttachmentMB 才擋下來
  compressImages: false,
  imageMaxEdge: 1600,
  imageQuality: 0.82,
  // Trello 附件上限：免費 workspace 10MB，付費 250MB
  maxAttachmentMB: 10,
});
