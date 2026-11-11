# ASN 專案守則

- 回覆一律使用繁體中文；給人看的文字不要中英夾雜（型別、變數的英文名稱只留在註解與 log）。
- ASN 的資料夾（`~/.asn`、舊位置 `~/.irori-relay`、`%APPDATA%`／`%LOCALAPPDATA%\tw.yooliang.asn`）預設不開，只有下列檔查問題時可以讀，只取相關的時段和行：
  - log：`ui.log`、`bridge.log`、`mux.log`、`guard.log`，以及其他 `*.log`（例如 `claude-quota.log`、`gemini-quota.log`）
  - 狀態檔：`claude-quota.json`、`claude-quota-state.json`、`gemini-quota.json`、`quota-readers.json`、`claude-owner-cache.json`、`mux-resume.json`、`known-windows.json`、`auto-resume.json`
- 不在清單裡的一律不開，尤其是：`reply-outbox.json`（可能含信件內文）；`claude-accounts`、`grok-accounts` 和各帳號資料夾；節點金鑰、設備金鑰、記住的電腦檔；`login.bin`、它的備份和 `.unreadable`；含加密前綴的檔；任何 token、憑證、service role。拿不準就不開，改問 asn真。提交前確認沒有金鑰進入歷史。
- 後端目前仍在 Irori 的 Supabase 專案。部署（migration、Edge Function、發版、官網）由負責的 session 自行判斷執行，不需再徵求同意（2026-10-22 小良哥授權）；部署前先跑完全套測試並確認舊版用戶端不會壞。花錢與不可回復的資料刪除仍要先問。
- `relay/machine`、`relay/cloud-agent` 的程式會在 Linux 上跑，檔案一律 LF（見 `.gitattributes`）。
- 改動先跑對應資料夾的測試（指令見 README）。
- 不用整批 taskkill；只關自己啟動並記下 PID 的程序。
- 開 PR 一律掛要進的版本里程碑（`gh pr create --milestone 0.2.x`），不確定進哪一版就問 asn真；版號由 asn真 統一改；發版照里程碑清點，沒掛的不進。
- PR 不夾帶：跟這次無關的改動各開一張。
