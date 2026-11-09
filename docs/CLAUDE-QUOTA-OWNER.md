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
3. **第二道**（擋「檢查完到開檔之間被換成連結」）：先開檔，再用已開啟的檔案確認真正位置。
   - Windows：`GetFinalPathNameByHandleW`，去掉 `\\?\` 前綴、不分大小寫後，要等於預期路徑；並確認不是 reparse point。
   - Unix：比對檔案 handle 與路徑的 dev／inode。
   - 不一致一律當沒有身分，走舊辦法。
4. 測試限制：檢查與開檔之間的替換在單元測試裡無法穩定模擬，所以測試只驗證「handle 與預期位置不符時會被擋」，真正的擋法就是第二道。

### 二、讀取與快取

- 只讀檔尾 256 KB；從中間開始讀時，第一行可能被截斷，要丟掉。
- 最後一筆 session-owner 格式不對（長度、字元）就當沒有，不退回更早的。
- 每次狀態列掛鉤是一個新行程，記憶體快取沒用，所以快取存在 `~/.asn/claude-owner-cache.json`：路徑 → 大小、修改時間、身分，最多 32 筆；
  同一個檔大小與修改時間沒變就不重讀。**快取不能繞過安全檢查**：每次都先開檔做兩道檢查，才看快取。

### 三、uuid 對應 email

1. 先在 `~/.asn/claude-accounts/` 底下**列目錄**找 `account.json`（只取 `accountUuid` 與 `emailAddress`）；
   資料夾名必須等於該 email 的標準資料夾名，對不上就不用。不拼使用者給的路徑。
2. 找不到再看目前登入的 `.claude.json`。
3. 都找不到＝未知帳號。

### 四、記到哪裡

- 對得到 email：記到該帳號底下，**不看現在登入的是誰**。每個帳號各有自己的待確認與 log 去重狀態（`claude-quota-state.json` 的 `owned`），
  所以兩個視窗交錯回報不會互相打斷，也不會互相污染。
- 未知帳號：**不進額度檔、不上傳**。本機另開 `~/.asn/claude-quota-unknown.json`：最多 16 個 uuid，每個只留最新一筆，7 天沒更新就刪。
- 查不到身分（沒有 `transcript_path`、路徑不安全、檔裡沒有 session-owner）：走 #1184 的舊辦法，記在目前登入的帳號。

### 五、上線時清掉沒有身分的舊基準

額度檔每筆新增 `owner` 標記（只有 `true` 才會寫出）。某個帳號第一次有身分的回報進來時，如果它在額度檔裡那筆沒有標記
（舊辦法記的，可能混進別的帳號的數字）：

- 先把額度檔複製成同目錄的 `claude-quota.json.bak`（只留一份，覆寫舊的）；
- 清掉那一筆，這次照有身分的數字收；
- log 只寫「清掉 N 筆沒有身分的舊基準」，不寫 email、不寫 uuid。

之後同一帳號的回報有標記，不再清、不再備份。

### 六、後台不改

額度檔的格式對後台不變（`owner` 欄位不上報），共用案例與 SQL 都不動。

## 驗收情境

工作機同時開著 gsit 與 cwen 兩個帳號的視窗：兩邊交錯回報（重置時間也不同）時，各自的數字分別記到各自帳號，沒有任何一筆被當成「別的帳號」拒收。
單元測試 `身分_兩個帳號的視窗交錯回報_各記各的_不互相污染` 鎖住這個情形（#1184 的 c8）。

## 假設，請確認

1. `transcript_path` 指向 `projects` 底下任意深度的 `.jsonl`（真實檔案是 `projects/<專案>/<工作階段>.jsonl`）；規格寫的是 `projects/*.jsonl`，我放寬成任意深度。
2. 路徑比對在 Windows 是逐層、大小寫有差的字串比對（`strip_prefix`）；Claude Code 給的路徑與設定資料夾同源，應該大小寫一致。大小寫不同會被擋，退回舊辦法，不會誤收。
3. 「清掉沒有身分的舊基準」我解讀為：額度檔裡沒有 `owner` 標記的那筆，在該帳號第一次有身分的回報時清掉。
4. 查不到身分的視窗走舊辦法（不是直接丟掉），因為舊版 Claude Code 或沒有對話紀錄的情境仍要能記額度。
5. `.claude.json` 備援只看家目錄那份，不看 `CLAUDE_CONFIG_DIR` 底下另一份。
6. 沒有 Windows junction 的自動測試（建立 junction 需要額外工具）；junction 由 `symlink_metadata` 的 reparse point 屬性檢查擋，只在 Windows 實機驗過才算數。
