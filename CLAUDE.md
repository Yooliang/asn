# ASN 專案守則

- **開發紀律見 [docs/開發紀律.md](docs/開發紀律.md)，寫 PR、審 PR、發版前都要照那份逐條對。** 最重要的四條：
  - 手機、電腦、網頁只有一份畫面；修毛病先找兄弟副本。
  - 每個修正都附一支「拿掉修正會紅燈」的回歸測試，測試用真資料。
  - 不准靜默失敗：畫面講白話，原文寫進 log。
  - 選項沒作用就變灰並說明；框一定要給使用者能做的事。
- **流程規則只有開發紀律那一份。** 別的文件寫了不一樣的規則，以開發紀律為準，並回報領隊把那份改掉。
- **動手前先查 [docs/唯一出口.md](docs/唯一出口.md)**：要做的事表上有出口，就走那個出口，不准另寫一份；新增一類共用出口要登記進去。
- **[docs/退場清單.md](docs/退場清單.md) 上的資料夾只修不加**（例如 `relay/machine` 的 Node 版機器橋）：新功能做在取代它的那一邊；單上要求「兩邊都做」時先問領隊，不要照抄一份過去。
- **新增系統通知先登記 [docs/通知種類.md](docs/通知種類.md)**；通知的前綴與用字照開發紀律第四之一節。

- 回覆一律使用繁體中文；給人看的文字不要中英夾雜（型別、變數的英文名稱只留在註解與 log）。
- ASN 的資料夾（`~/.asn`、舊位置 `~/.irori-relay`、`%APPDATA%`／`%LOCALAPPDATA%\tw.yooliang.asn`）預設不開，只有下列檔查問題時可以讀，只取相關的時段和行：
  - log：`ui.log`、`bridge.log`、`mux.log`、`guard.log`，以及其他 `*.log`（例如 `claude-quota.log`、`gemini-quota.log`）
  - 狀態檔：`claude-quota.json`、`claude-quota-state.json`、`gemini-quota.json`、`quota-readers.json`、`claude-owner-cache.json`、`mux-resume.json`、`known-windows.json`、`auto-resume.json`、`stuck-prompt-state.json`（只有視窗名、畫面雜湊、時間）
- 不在清單裡的一律不開，尤其是：`reply-outbox.json`（可能含信件內文）；`claude-accounts`、`grok-accounts` 和各帳號資料夾；節點金鑰、設備金鑰、記住的電腦檔；`login.bin`、它的備份和 `.unreadable`；含加密前綴的檔；任何 token、憑證、service role。拿不準就不開，改問 asn真。提交前確認沒有金鑰進入歷史。
- 後端目前仍在 Irori 的 Supabase 專案。部署（migration、Edge Function、發版、官網）由負責的 session 自行判斷執行，不需再徵求同意（2026-10-22 擁有者授權）；部署前先跑完全套測試並確認舊版用戶端不會壞。花錢與不可回復的資料刪除仍要先問。
- `relay/machine`、`relay/cloud-agent` 的程式會在 Linux 上跑，檔案一律 LF（見 `.gitattributes`）。
- 改動先跑對應資料夾的測試（指令見 README）。
- 不用整批 taskkill；只關自己啟動並記下 PID 的程序。
- 合進 main 就進下一版，PR 不掛里程碑；版號由 asn真 統一改。
- PR 不夾帶：跟這次無關的改動各開一張。
