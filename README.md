# 快速記帳 → Trello

幾秒鐘記一筆帳（標題、金額、內容、照片），背景自動依你設定的分類規則寫進 Trello 看板（例如「債務看板」）。

純靜態 PWA：沒有伺服器、不用自己 host，瀏覽器直接呼叫 Trello REST API。
記下的帳先存在手機的 IndexedDB 佇列，送出後可以馬上離開；斷線、Trello 暫時掛掉、app 被殺掉都會自動補送，不會重複建卡。

## 功能

- **一頁完成**：標題 → 金額（數字鍵盤）→ 選分類（可不選）→ 拍照 / 相簿多選 → 「記一筆」。
- **分類規則**：每個分類對應看板上的一個清單，可附加標籤；標題或內容含關鍵字時自動歸類；都沒命中就用預設分類。
- **卡片格式可調**：標題 / 說明用 `{title} {rawAmount} {amount} {content} {date} {time} {category}` 變數組合（預設：說明第一行是純數字金額）；有付費 Custom Fields 的看板也可把金額寫進數字欄位。
- **清單總計 / 一鍵結帳**：免費方案沒有 Custom Fields、Smart Fields 又不開放外部寫入，所以 app 自己算：讀每張卡的 Smart Fields 值（pluginData）或說明第一行的數字 / 算式。算完可以：下載 CSV（Excel 直接開，含日期、項目、金額、附件數、卡片連結、說明、總計列）、手機分享存檔 / 傳 LINE、複製純文字版、把總計寫進該清單的 `[Summary]` 卡。
- **照片自動縮圖**：長邊縮到 1600px 轉 JPEG，上傳快，也避開 Trello 免費方案 10MB 附件上限。
- **離線佇列 + 背景同步**：每一步（建卡 → 自訂欄位 → 每張附件）都記進度；中斷後從斷掉那步接著做。Chrome / Android 另外支援 Background Sync，關掉 app 也會補送。
- **系統分享**：安裝成 PWA 後（Android Chrome），在相簿選照片「分享」到「記帳」就直接帶進表單。
- 深色模式、可加到主畫面、繁中介面。

## 線上版

**https://df-wu.github.io/trello-debt/** （GitHub Pages，push 到 `main` 後約一分鐘自動更新）

手機開這個網址 → 瀏覽器選單「加入主畫面」就是一個 app。

## 部署（免費）

這是純靜態網站，任何靜態主機都行。最簡單：**GitHub Pages**。

1. Repo → Settings → Pages → Source 選 `Deploy from a branch`，Branch 選 `main` / `/ (root)`。
   （私人 repo 的 Pages 需要 GitHub Pro；免費帳號可把 repo 設成 public — repo 裡沒有任何秘密 — 或改用 Cloudflare Pages / Netlify 把資料夾拖上去。）
2. 網址會是 `https://<帳號>.github.io/trello-debt/`。

本機試用：`npm run serve` 然後開 http://localhost:8080 （Service worker 在 localhost 可用）。

## 第一次設定

1. **API Key**：Trello 現在要在 <https://trello.com/power-ups/admin> 建一個 Power-Up 才拿得到 API key。
   建好後在 Power-Up 的 **API Key** 頁：
   - 複製 API key 填進 app 的設定（repo 已預填一組）。
   - **Allowed origins** 加入 app 的網址（例如 `https://df-wu.github.io`），授權後才能自動跳回 app。
     不加也可以：用設定頁裡的「手動方式」把 token 貼進來。
2. 開 app → 設定 → 「透過 Trello 授權」→ 同意 → 自動跳回並填好 Token。
3. 「載入看板」→ 會自動選到名稱含「債務」的看板，並依看板清單自動建立分類。
4. 調整分類（清單 / 標籤 / 關鍵字）、預設分類、卡片格式 → 儲存。

Token 只存在你的瀏覽器裡（IndexedDB），不會傳到任何第三方。

## 開發

```
npm test        # node:test，純邏輯單元測試（規則引擎、佇列、Trello client）
npm run serve   # 本機靜態伺服器
```

結構：

| 檔案 | 說明 |
| --- | --- |
| `index.html` / `css/app.css` | 介面 |
| `js/app.js` | 頁面邏輯：表單、佇列列表、設定頁 |
| `js/rules.js` | 分類規則與卡片組裝（純函式） |
| `js/queue.js` | 離線佇列、逐步寫入 Trello、重試策略 |
| `js/trello.js` | Trello REST client（含 429/5xx 重試） |
| `js/images.js` | 照片縮圖 |
| `js/db.js` | IndexedDB 封裝 |
| `sw.js` | Service worker：離線快取、Background Sync、Share Target |

更新版本時改 `sw.js` 裡的 `VERSION`，舊快取會在下次開啟時換掉。
