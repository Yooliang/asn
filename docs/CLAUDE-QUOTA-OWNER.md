# Claude 狀態列額度帶上帳號身分（#1185）

## 要解的問題

同一台電腦同時開著登入不同帳號的 Claude 視窗時，狀態列掛鉤（`asn claude-quota`）收到的輸入裡沒有帳號欄位。
原本只能看「現在 `.claude.json` 登入的是誰」，把每個視窗的數字都記到那個帳號底下，結果 A 視窗的數字蓋到 B 帳號。
#1184 用「換身分要連續確認 3 次、隔 10 分鐘」降低污染，但只要兩個視窗持續交錯回報，就只能一直不收。

## 做法

Claude Code 會在每個對話紀錄（transcript，`<設定資料夾>/projects/**/*.jsonl`）寫入一筆
`{"type":"session-owner","accountUuid":…,"organizationUuid":…}`。狀態列輸入有這個視窗的 `transcript_path`，
所以掛鉤讀該檔**最後 256 KB** 裡**最後一筆** session-owner，當作這個視窗的帳號鍵。

```
狀態列輸入 ──▶ transcript_path ──▶ 兩道路徑檢查 ──▶ 讀檔尾 ──▶ accountUuid
                                                                  │
                  帳號庫 account.json ◀── 先找 ◀── uuid → email ◀─┘
                  .claude.json        ◀── 再找
                  都找不到 ──▶ 未知帳號（只存本機一小區，不上傳）
```

程式在 `relay/asn/src-tauri/src/claude_quota/`：`owner.rs`（路徑檢查與讀取）、`owner_store.rs`（快取與未知區）、
`../claude_quota.rs` 的 `hook_in`／`hook_owned`（記到帳號底下）、`../claude_accounts.rs` 的 `email_of_account_uuid`。

### 一、路徑安全（`transcript_path` 是外面送進來的字串，不能信）

1. 只接受 `<CLAUDE_CONFIG_DIR 或 ~/.claude>/projects/` 底下、副檔名 `.jsonl` 的檔案；路徑裡不能有 `..`。
2. **第一道**：從 `projects` 往下每一層都用 `symlink_metadata` 檢查，是符號連結或 junction（Windows 的 reparse point）就不收。
3. **大小寫**：Windows 的檔案系統不分大小寫，`transcript_path` 的磁碟代號與資料夾名大小寫常和我們算出的路徑不同（例如 `c:` 與 `C:`），
   所以 Windows 逐層不分大小寫比對前綴；Unix 仍分大小寫。放寬大小寫不會變弱，因為安全靠下一點的 handle 確認與 reparse point 檢查。
4. **第二道**（擋「檢查完到開檔之間被換成連結」）：先開檔，再用已開啟的檔案確認真正位置。
   - Windows：`GetFinalPathNameByHandleW`，去掉 `\\?\` 前綴、不分大小寫後，要等於預期路徑；並確認不是 reparse point。
   - Unix：比對檔案 handle 與路徑的 dev／inode。
   - 不一致一律當沒有身分，走舊辦法。
5. 測試限制：檢查與開檔之間的替換在單元測試裡無法穩定模擬，所以測試只驗證「handle 與預期位置不符時會被擋」，真正的擋法就是第二道。

### 二、讀取與快取

- 只讀檔尾 256 KB；從中間開始讀時，第一行可能被截斷，要丟掉。
- 最後一筆 session-owner 格式不對（長度、字元）就當沒有，不退回更早的。
- 每次狀態列掛鉤是一個新行程，記憶體快取沒用，所以快取存在 `~/.asn/claude-owner-cache.json`：路徑 → 大小、修改時間、身分，最多 32 筆；
  同一個檔大小與修改時間沒變就不重讀。**快取不能繞過安全檢查**：每次都先開檔做兩道檢查，才看快取。

### 三、uuid 對應 email

1. 先在 `~/.asn/claude-accounts/` 底下**列目錄**找 `account.json`（只取 `accountUuid` 與 `emailAddress`）；
   資料夾名必須等於該 email 的標準資料夾名，對不上就不用。不拼使用者給的路徑。
2. 找不到再看這個視窗自己的設定資料夾（transcript 所屬的 `CLAUDE_CONFIG_DIR` 根目錄）裡的 `.claude.json`：同一台機器開多個帳號的視窗，
   正是靠各自的設定資料夾分開，所以先看這份。
3. 再找不到才看家目錄那份 `.claude.json`。
4. 第 2、3 步只取 `accountUuid` 與 `emailAddress`，而且 `accountUuid` 要和要找的 uuid 完全相同才用。
5. 都找不到＝未知帳號。

### 四、記到哪裡（#1266 簡化後）

- 對得到 email：記到該帳號底下，**不看現在登入的是誰**。每個帳號各有自己的 log 去重狀態（`claude-quota-state.json` 的 `owned`，鍵是 email，與額度檔一致）。
- 未知帳號：**不進額度檔、不上傳**。本機另開 `~/.asn/claude-quota-unknown.json`：最多 16 個 uuid，每個只留最新一筆，7 天沒更新就刪。
- **資料時間**：額度的讀取時間（`read_at`）用對話紀錄最後 256 KB 裡**最後一筆 assistant 回應的時間戳**，不是掛鉤執行的時間。
  這是整個簡化的前提：閒置的視窗每次重繪都會重送舊數字，用「執行時間」會讓舊數字看起來是新的；用 assistant 回應的時間，舊視窗重送的數字資料時間就是舊的，會被 `older_read` 擋掉。
  取不到時間戳（沒有 assistant 行、格式不對）的那次，**不記**。時間戳與身分一起快取（`claude-owner-cache.json`），檔案大小或修改時間變了才重讀。
- **有帶 `transcript_path` 卻解不出身分**（還沒寫出 session-owner、被擠出檔尾、格式壞、路徑不安全、檔案不存在）：這次不記，狀態檔與額度檔都不動。
- **沒帶 `transcript_path` 的舊版 Claude Code：不收**。掛鉤只記下「最近看過舊版視窗」的時間（`legacy_at`，10 分鐘最多寫一次），
  畫面對「目前登入的帳號、額度檔還沒有它的紀錄、最近 30 分鐘內有舊版視窗」寫一句固定的人話：**「升級 Claude Code 後才會顯示額度」**；
  其他視窗帶了身分、記下數字之後，就照數字顯示。
- 合併規則只剩三條（見 `merge.rs` 與 `tests/fixtures/quota-merge-cases.json`）：`future_read`（資料時間比現在晚超過 5 分鐘）、
  `older_read`（資料時間比記著的早，以秒比較、同一秒照收）、`reset_out_of_range`（重置時間不在現在 −1 天到 +8 天）。
  其餘一律照收：同期剩餘回升、重置時間倒退、不是 7 天倍數、記著的還沒過期卻來了更晚的重置時間。每條窗各自判斷，一條被擋不連帶另一條。
- 拿掉的規則與理由見 `supabase/migrations/20261113000000_acct_quota_rules_simplify.sql` 開頭的說明。

### 五、上線時清掉沒有身分的舊基準

額度檔每筆新增 `owner` 標記（只有 `true` 才會寫出）。某個帳號第一次有身分的回報進來時，如果它在額度檔裡那筆沒有標記
（舊辦法記的，可能混進別的帳號的數字）：

- 先把額度檔備份成同目錄的 `claude-quota.json.bak`（只留一份，覆寫舊的）：先複製到 `.bak.tmp`，寫完再改名蓋掉 `.bak`，不會留下寫一半的備份；
- **備份失敗就不清舊基準**（log 記一句「備份失敗，沒有清舊基準」，下次再試）；備份成功才清掉那一筆，這次照有身分的數字收；
- log 只寫「清掉 N 筆沒有身分的舊基準」，不寫 email、不寫 uuid。

之後同一帳號的回報有標記，不再清、不再備份。

### 六、狀態檔不留明文身分

簡化後狀態檔（`~/.asn/claude-quota-state.json`）只剩：各帳號兩條最後記過的不收原因代碼（鍵是 email，與額度檔一致，**已決定**不改成雜湊）、最近看過舊版視窗的時間。
不再有「上次登入的身分」欄位（換身分確認、`rebase_gate`、待確認次數都已拿掉），舊版狀態檔裡的那些欄位讀進來會被忽略。
身分快取 `claude-owner-cache.json` 只存路徑、大小、修改時間、accountUuid、organizationUuid、最後一筆 assistant 的時間；未知帳號區只存 accountUuid 與額度數字。

### 七、舊版視窗的提示

見第四節：舊版 Claude Code（沒帶 `transcript_path`）不收，畫面寫固定的一句「升級 Claude Code 後才會顯示額度」，不出現內部代號。

### 八、後台（#1266 簡化後：三條規則）

後台（`asn_relay_acct_window_decide`、`asn_relay_acct_window_judge`）與電腦端 `merge.rs` 一樣只剩三條規則，共用案例 `tests/fixtures/quota-merge-cases.json` 兩邊都跑：

1. `future_read`：資料時間（`read_at`）比現在晚超過 5 分鐘（電腦時鐘走快）。
2. `older_read`：資料時間比記著的那條早（同一秒照收）。
3. `reset_out_of_range`：新的重置時間不在「現在 −1 天」到「現在 +8 天」之間（含兩端）。

其餘一律照收（同期回升、重置時間倒退、不是 7 天倍數）。每條窗各自判斷。額度檔的格式對後台不變（`owner` 與 `legacy` 都不上報：`acct_remote.rs` 的回報是逐欄挑選額度欄位，不會整筆序列化，有測試鎖住不含 `owner`）。
Claude 的資料時間是對話紀錄最後一筆 assistant 回應的時間戳。**部署順序：migration 必須先於客戶端上線**，否則舊後台加上新客戶端時，同期回升會被舊規則擋掉，重現 11-09 的停更。

## 驗收情境

工作機同時開著 gsit 與 cwen 兩個帳號的視窗：兩邊交錯回報（重置時間也不同）時，各自的數字分別記到各自帳號，沒有任何一筆被當成「別的帳號」拒收。
單元測試 `身分_兩個帳號的視窗交錯回報_各記各的_不互相污染` 鎖住這個情形（#1184 的 c8）。

## 假設，請確認

1. `transcript_path` 指向 `projects` 底下任意深度的 `.jsonl`（真實檔案是 `projects/<專案>/<工作階段>.jsonl`）。
2. Windows 路徑比對逐層不分大小寫，Unix 分大小寫。
3. 「清掉沒有身分的舊基準」：額度檔裡沒有 `owner` 標記的那筆，在該帳號第一次有身分的回報時清掉並備份一份 `.bak`；備份失敗就不清、這筆也不蓋標記。
4. 沒有 Windows junction 的自動測試；檢查與開檔之間被換掉的情況無法在單元測試穩定模擬。
5. **Claude Code 的對話紀錄每筆 assistant 回應都有 `timestamp`（ISO、UTC、帶毫秒）**：這是簡化的前提，我是依現有對話紀錄的格式推定的，需要在實機確認；如果某個版本沒有這個欄位，那個版本的視窗就不會記額度（畫面不會提示，因為它有帶 `transcript_path`）。
6. 狀態列輸入的額度數字就是「該視窗最後一次 API 回應」帶回來的值，所以資料時間取最後一筆 assistant 回應的時間是對得上的。
7. agy 的 `/quota` 輪詢**不再把讀數記到任何帳號**：`/quota` 的回應不帶帳號，找不到可信的帳號來源（原本用的「最近一次狀態列記到的帳號」切過帳號會對錯；
   `~/.gemini/google_accounts.json` 的 `active` 實測是空的、檔案從 7 月就沒再寫過，agy 不會寫這個檔）。照「帳號不可信就不收」處理，
   Gemini 的額度只靠 agy 視窗狀態列帶的 email 那條路徑更新。輪詢的程式與設定開關保留（`quota_readers.rs` 的 `agy_poll_account` 一律回 None），
   之後 agy 開始回帳號時，只要讓它回那個帳號就能接回去。設定頁那一項寫「Gemini 額度要開著 agy 視窗才會更新」。

## 讀數沒有某一窗、存著的那一窗已過重置時間：拿掉（#1321，另一張 PR）

Claude 的最大訂閱方案拿掉了 5 小時限制，`rate_limits` 裡不再有 `five_hour`。合併時「新讀數沒有的窗就留著舊的」，所以後台的 five_hour 停在最後一次有值的時候，重置時間早就過了，畫面一直掛著一個過期的舊數字。
現在：**這次讀數完全沒有某一窗，而存著的那一窗重置時間已經過了（剛好等於現在也算），就把那一窗拿掉**（剩餘 %、重置時間、資料時間都清掉，舊的單一 `reset_at` 依剩下的窗重算）。還沒過重置時間的（只是這次剛好沒帶）、存著的那一窗沒有重置時間的（無從判斷）都留著。Claude 與 Gemini 一樣（`merge.rs` 的 `without_missing_expired`）；後台 `roster_report` 做同樣的事（只在這次回報有帶 `windows` 時，沒帶的舊用戶端不動）。
畫面：沒有資料的那一窗整列不顯示；原本重置時間已過就寫「可能已恢復」的那句拿掉，不用別的結論取代。

## Gemini 的資料時間（#1316，另一張 PR）

agy 狀態列給的 `transcript_path` 在啟動時指向一個不存在的檔，不能從對話紀錄取時間，所以 Gemini 的資料時間用「數值有沒有變」來決定（`gemini_quota/seen.rs`）：
以「agy 視窗＋那一窗額度（five_hour／weekly）」為單位，記住上次的數值（剩餘 %、重置時間差 10 分鐘內算沒變）與資料時間；數值有變才把資料時間設成現在，沒變沿用上次的。
閒置視窗一直重送快取的舊數字，資料時間就不會前進，會被 `older_read` 擋掉，蓋不掉別處較新的值。
第一次看到某個視窗（沒有存過紀錄）只記下來、不送、不寫進 `gemini-quota.json`；視窗用 `session_id`（沒有才用 `conversation_id`）認，**只存 sha256 雜湊**，都沒有就認不出，這筆不記。
狀態檔 `~/.asn/gemini-quota-seen.json`：最多 32 個視窗，7 天沒更新就刪。
