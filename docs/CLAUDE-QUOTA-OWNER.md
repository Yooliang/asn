# Claude 額度：ASN 直接向 Claude 查（#1883）

額度不再靠狀態列掛鉤、對話紀錄猜帳號。ASN（Rust）在本機讀目前登入的 access token，直接向 Claude 查 5 小時與每週額度，再把（設備、email、數字、時間）回報給後台。

## 做法

1. **查**：每台電腦只查自己目前登入的那一個帳號，每 10 分鐘一次，切換帳號後立刻一次。目前登入的帳號以 `.claude.json` 的 oauthAccount email 為準；跟憑證檔對不上（切換進行到一半）這一輪不查，下一輪再查；查詢不跟切換同時跑。
2. **送**：隨帳號回報（`acct_report`）送出，每個窗 `{ name, left_pct, resets_at, read_at }`。沒有任何設備在用的帳號，不查。
3. **存**：後台同帳號每個窗只取讀取時間最新的那筆（`asn_relay_acct_roster_report`）。帳號頁與設備頁都讀這一份。手機沒有本機憑證，額度只看電腦回報。

## 狀態判定

| 情況 | 畫面 |
|---|---|
| 本地看 `expiresAt` 已過期，或查詢回 401 | 登入過期 |
| 查詢回 429 | 查詢太頻繁，稍後再試（退避，不加速） |
| 5xx、逾時、其他 | 暫時查不到 |
| 帳號目前沒有任何設備在用 | 顯示最後一次讀數與時間，加上「目前沒有設備在用」 |

失敗時不沿用舊數字當成現在的，也不寫「未知」；細節（狀態碼）只進 log。

## 安全

- 只用現成的 access token，不做 refresh（refresh 可能讓 Claude 視窗的登入失效）。過期就標「登入過期」，等使用者用那個帳號開 Claude 後自然恢復。
- 憑證只在本機記憶體裡用：不離開本機、不寫 log、不顯示、不進錯誤訊息或上傳內容。
- 查詢介面不是公開文件的；介面變了就照實顯示「暫時查不到」並記 log。

## 舊檔

升級後本機的 `claude-quota.json`、`claude-owner-cache.json` 不再讀，保留一版，下一版再清。狀態列上 ASN 接的那一條指令在升級時還原成原本的（只動 ASN 寫的那一條，還原前先備份）。

## 後台

- migration：`supabase/migrations/20261120100000_acct_quota_latest_per_window.sql`；回復：`supabase/sql/rollback/20261120100000_acct_quota_latest_per_window_down.sql`。
- 規則：進來的讀取時間比存著的早就不蓋，相等或較晚就蓋；不看重置時間、不看是哪一台送的。舊版用戶端的舊欄位照收，但蓋不掉較新的讀數。
- 測試：`tests/acct_quota_latest_per_window_sql.test.mjs`（規則）、`tests/claude_quota_e2e_sql.test.mjs`（整條，讀 `tests/fixtures/claude-quota-report.golden.json`）。
