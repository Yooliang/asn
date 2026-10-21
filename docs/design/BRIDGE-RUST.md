# ASN 內建收發室橋（全 Rust）

issue #12 第二期。目標：打開 ASN ＝ 這台設備的收發室就上線，不用另外裝、另外管 Node 的收發室橋；ASN 縮在系統匣保持活動（#61 已有）。別台的 ASN 看得到這台上線，之後可以遠端替這台開新的 Claude 視窗並對談。

決策沿革：`ONBOARDING.md` 3.5 原本推薦「隨附 Node 執行檔」（方案甲），之後小良哥改裁**全 Rust、不帶 Node**（D1）。本文件是那個裁決的實作設計。Node 橋（`relay/machine/bridge.mjs`）繼續存在，Linux 雲端環境與 Aegis 主機仍在用，不在本文件範圍。

## 1. 分段計畫

| 段 | 內容 | 狀態 |
|---|---|---|
| 第一段（本 PR） | Claude 引擎的核心：單一收信者鎖、名單回報（上線）、門鈴＋輪詢＋快速重試、轉交給本機 Claude 視窗、回覆寄回、ack／去重／逾時通知／遲到回覆／no-reply／self-recv、對應表跨重啟、設定開關與舊橋偵測、「改由 ASN 負責」（程式有、預設不放行） | 完成，設定「讓 ASN 負責這台的收發室」預設關 |
| 第二段 | 群組轉送（`rooms.mjs`）；附件（照片）轉交；孤兒程序清理（`bridge.last`）；舊橋退出後自動接手（現在要重開 ASN 或重按開關）；自己更新改由 ASN 更新負責 | 未開工 |
| 第三段 | 遠端開視窗：`launcher.mjs` 的 `launch_pending`／`launch_result` 輪詢、`launcher.json`／預設 profile、白名單與每小時上限、roster 的 `launcher` 欄位（本段先送 null）、開出視窗後的第一句話 | 未開工 |
| 第四段 | `asn send` 命令列取代 `send.mjs`（含 `replied/`、`sent/` 記號與父行程鏈身分判定），讓 Claude 視窗不依賴 Node；`asn recv`／`asn room` | 未開工 |
| 第五段 | 其他引擎：Codex、ACP（Gemini／Grok 背景夥伴）；opt-in 後把預設改為開、淘汰安裝程式的工作排程 | 未開工 |

每段都維持「預設關、關著時 ASN 行為與以前完全一樣」，直到第五段才討論預設值。

## 2. Node 行為 → Rust 模組對應表

模組都在 `relay/asn/src-tauri/src/bridge/`。

| Node 行為（檔案） | Rust（檔案） | 第一段 |
|---|---|---|
| 設定與環境變數（`bridge.mjs` 開頭，`IRORI_*`） | `core.rs` `Config::from_env`（同名同預設值；忙碌狀態改成固定的 busy／working／running，不支援自訂正規式） | 已搬 |
| 單一執行個體 `bridge.pid`（`bridge.mjs`、`relay-core.mjs`） | `lock.rs` | 已搬，與 Node 橋互斥 |
| 認出舊橋、停舊橋與排程（`run-bridge.ps1`、`install-task.ps1` 的反向操作；ONBOARDING 3.9） | `handoff.rs` | 已搬，受設定開關保護 |
| 視窗名單 `claude agents --json`（`engines/claude.mjs` `listWindows`） | `roster.rs`：直接讀 `~/.claude/sessions/<pid>.json`（pid 活著、`kind=interactive`、`entrypoint=cli`、排除收發室自己） | 已搬（資料來源改了，見第 6 節） |
| roster 回報 `POST ?action=roster`（`bridge.mjs` `refreshRoster`） | `roster.rs` `roster_body`＋`core.rs` `refresh_roster`；每 60 秒；多列一筆 ASN 自己的視窗名（engine 標 `asn`）；`launcher` 先送 null | 已搬 |
| 門鈴 Realtime（`connectBell`） | 沿用 `bell.rs`；`mod.rs` 另開一條連線，響了就叫醒主迴圈 | 已搬 |
| 2 分鐘輪詢＋拉信失敗短退避（`pull-retry.mjs`） | `mod.rs` `run_loop`（輪詢）、`core.rs` `pull`／`retry_due`（5→10→20→40→60 秒，成功歸零，不並行兩個 pull） | 已搬 |
| 收信處理 `handleMail`：預設收件人、最近活動的視窗代收、找不到視窗、告知類不計時、收發室系統信 | `core.rs` `handle_mail` | 已搬 |
| `pick-fallback.mjs` | `core.rs` `handle_mail`（取 `updatedAt` 最大者） | 已搬 |
| 來信抬頭、`wantsReply`、代寄抬頭、回覆抬頭拆除（`mail-format.mjs`） | `mail.rs`（手寫解析，不用正則套件） | 已搬 |
| 收發室 worker：`claude -p`、三個工具、系統提示、nonce、BRIDGE-FORWARD、SENT／FAIL／REPLY 解析、漏寫 SENT 的補救、假 nonce 重啟（`engines/claude.mjs`） | `worker.rs`（`Parser` 純函式＋`ProcWorker` 子程序監督） | 已搬 |
| worker 子程序無視窗、記 PID、結束只關自己的（`windowsHide`、`mailbox.pid`） | `worker.rs`（`.no_window()`、`mailbox.pid`、`stop()` 只關記下的 PID） | 已搬 |
| ack 時機、去重、`onSent`／`onFail`、轉交逾時 | `core.rs` | 已搬 |
| 回覆對應 `onReply`：優先序、遲到回覆、對不上轉最近交辦者、通知信的回覆丟掉 | `core.rs` `on_reply` | 已搬 |
| 代寄 `[RELAY 寄信]`／`[RELAY 回信]`、缺 `reply=` 的拒絕與通知 | `core.rs` `on_reply`／`send_new`／`refuse_send`／`tell_window` | 已搬 |
| 逾時通知：timeout／window-closed／busy-idle-grace／busy-max、30 分鐘合併、`replied/`、`sent/` 記號 | `core.rs` `judge_timeout`／`notice_no_reply`／`tick`（記號檔名 sha1 與 `sent-mark.mjs` 位元組一致，測試用 Node 算出的向量鎖住） | 已搬 |
| 遲到回覆保留期與筆數上限 | `core.rs` `tick`／`evict_notified` | 已搬 |
| `pending.json` 跨重啟（`pending-store.mjs`） | `pending.rs`，檔案格式相同（新舊橋換手對應表接得上；群組項目本段略過） | 已搬 |
| self-recv 心跳（`self-recv.mjs`） | 沿用 `heartbeat.rs`（ASN 本來就寫同格式心跳）；`handle_mail` 心跳新鮮且 pid 活著就跳過、不 ack | 已搬 |
| 寄給 ASN 自己視窗的信 | `handle_mail` 直接跳過、不 ack，留給 ASN 畫面收（Node 橋的行為是回「找不到」並 ack，這是刻意修正） | 新增 |
| `bridge.log`＋上限輪替（`safe-log.mjs`） | `core.rs` `BridgeLog`（2 MB 輪替成 `bridge.log.1`） | 已搬 |
| 群組轉送（`rooms.mjs`） | — | 第二段 |
| 附件下載提示行（`attach-format.mjs`） | 本段只在內文後補一行「帶有 N 個附件，請到 ASN 查看」 | 第二段 |
| 孤兒清理 `bridge.last`、`self-update.mjs` | — | 第二段 |
| 遠端開視窗 `launcher.mjs`、`partner-*.mjs` | — | 第三段 |
| `send.mjs`／`recv.mjs`／`room.mjs`／`attach.mjs`、`identity.mjs` | — | 第四段 |
| Codex／ACP 引擎 | — | 第五段 |

### 主迴圈

`mod.rs` 的 `run_loop` 是單一任務，依序處理：worker 輸出、門鈴、輪詢、名單、逾時檢查。核心狀態（`core.rs` `Core`）一次只被這個任務使用，所以不需要鎖；所有時間由呼叫端傳入，測試不必真的等逾時。

## 3. 與舊 Node 橋共存與交接

- **互斥**：兩邊共用 `~/.irori-relay/machine-<節點>/bridge.pid`。內建橋啟動時讀它：pid 活著且不是自己＝舊橋在跑，內建橋不啟動。內建橋啟動後寫入自己的 pid，Node 橋啟動時看到活著的 pid 也會自己退出（exit 3），`run-bridge.ps1` 對 exit 3 是停手而不是重啟。結束時只在檔案裡還是自己的 pid 時才刪。
- **設定開關**：`<ASN 資料夾>/bridge.json`，`enabled`（讓 ASN 負責這台的收發室，預設 false）、`allow_takeover`（放行「改由 ASN 負責」，預設 false，本段不開放）。獨立一個檔案是因為 `settings.json` 會在改名時整份重寫。
- **關閉時行為不變**：開關關著時，ASN 啟動不建立任何橋相關的程序、檔案或連線。`--shot` 截圖模式永遠不啟動。
- **設定頁**：舊橋在跑時顯示「這台的收發室目前由舊版收發室橋負責」；`allow_takeover` 放行時才出現「改由 ASN 負責」，按下去要再按一次「確定」。
- **改由 ASN 負責**（`handoff.rs`，Rust 端要求放行＋確認兩者都有才動作）：
  1. 停用工作排程 `IroriRelayMachine-<節點>`（只停用、不刪除）；
  2. 結束 `mailbox.pid` 記的 PID（收發室 worker）；
  3. 結束 `bridge.pid` 記的 PID（橋）；只殺這兩個 PID，不用名稱比對、不連子程序一起殺、不整批結束；
  4. 等舊橋 pid 消失（最多 10 秒），拿鎖，啟動內建橋；
  任何一步失敗就停手並回報，不繼續下一步。
- **信箱的 ack 責任**：同一把金鑰同一時間只有一個收信者。接手之前舊橋已轉交、還在等回覆的信，其對應表在 `pending.json`，格式兩邊相同，內建橋啟動時載回，回覆照樣寄得回去。
- **退回**：把 `bridge.json` 的 `enabled` 關掉（或設定頁取消勾選），內建橋結束並釋放鎖；舊橋要使用者自己重新啟用工作排程（本段不自動恢復）。

## 4. 節點代號自動產生（小良哥追加）

原則：設備代號（節點 id）由系統自動產生，使用者不用取也不會看到，畫面一律顯示 ASN 視窗名。

核對結果與補強：

- **後端**（`asn_node_create`、`_shared/account.ts`）本來就是自動產生：`<租戶前綴>` 加亂數 8 碼十六進位（前綴 `t<序號>-`，舊租戶用 `n`），只含 `[a-z0-9-]`，撞到 PK 就重試最多 5 次。電腦名稱只進 `nodes.name`／`nodes.machine`（顯示用），使用者不輸入任何代號，所以**不需要新的 migration**。
- **ASN 端補強**（本 PR）：預設視窗名原本是 `<節點>-ASN`，新電腦會因此在畫面上露出自動產生的代號（例如 `t5-ab12cd34-ASN`）。改成：節點代號符合自動產生格式（`is_auto_node_id`）時，預設視窗名用電腦名稱（`<電腦名>-ASN`，電腦名稱限 36 字）。手動取代號的舊電腦（`H`、`w02`…）不符合這個格式，照舊不動。使用者仍可在設定改視窗名，設定值優先。
- **身分檔**：沒有 `IRORI_RELAY_ID`、沒有 `~/.irori-relay/node` 的新電腦，登入建立節點後 `write_node_files` 會把代號寫進 `~/.irori-relay/node`（金鑰在 `<代號>.key`，先限縮權限再寫入、讀回比對）。之後 ASN、內建橋、未來的 `asn send` 都經 `identity::resolve` 讀同一份，所以是同一個節點。環境變數 `IRORI_RELAY_ID` 永遠優先。
- **device_id 綁定這台電腦**：ASN 資料夾（`%APPDATA%\tw.irori.asn\device_id`，本機自產的亂數）。後端以「帳號＋device_id」唯一：
  - 同一個帳號、同一個 `device_id` 重送 `node_create`＝換新金鑰（舊金鑰立即失效），不會多出節點；回應遺失或金鑰檔沒寫成功時重試即可。
  - **重灌 Windows**：`%APPDATA%` 與 `~/.irori-relay` 都沒了，產生新的 `device_id`，會建立**新節點**；舊節點留在帳號下，由使用者在「我的設備」移除（帳號上限 20 個）。若重灌時有保留 `%APPDATA%\tw.irori.asn` 與 `~/.irori-relay`，就是同一台，什麼都不會變。
  - **同一台換 Windows 使用者**：`%APPDATA%` 與家目錄都不同，視為另一台設備，建立新節點。
  - 「這就是這台電腦（接手）」的選單（ONBOARDING 3.3）仍是後續工作，不在本 PR。

## 5. 測試對照

Rust 測試在各模組的 `#[cfg(test)]`，整合測試在 `bridge/tests.rs`（本機假後端只連 `127.0.0.1`、假 worker；真的子程序那一項由測試執行檔自己扮演假 claude，不需要 Node）。時間由測試傳入，不真的等逾時。

| Node 測試 | Rust 測試（`bridge::`） |
|---|---|
| `bridges.test.mjs` 預設收件人／代收／留在 inbox | `tests::沒指定收件人_…` |
| `bridges.test.mjs` expects_reply 欄位／舊標記／收發室系統信 | `tests::告知類信_…`、`欄位是_null_才看內文舊標記`、`收發室寄來的系統信不計時` |
| `bridges.test.mjs` 附件提示行 | 第二段 |
| `reply-notice.test.mjs` 遲到回覆、保留期與筆數上限 | `tests::遲到的回覆照寄_…`、`遲到回覆的保留期與筆數上限` |
| `reply-notice.test.mjs` 忙碌延後／寬限／上限／延後期間回覆 | `tests::對方忙碌_…`、`延後期間對方回覆了_…` |
| `reply-notice.test.mjs` 視窗已關閉、合併、sent／replied 記號 | `tests::對方視窗已關閉_…`、`逾時沒回_…30_分鐘內只報一次`、`視窗在轉交後曾寄信給原寄件人_…`、`轉交逾時_但對方已經用_reply_to_回了_…` |
| `reply-notice.test.mjs` 漏寫 SENT 但 SendMessage 成功 | `tests::收發室漏寫_sent_行…`、`worker::tests::漏寫_sent_行…` |
| `reply-notice.test.mjs` 代寄／缺 reply／回信 re= | `tests::代寄_…`、`代寄少了_reply_…`、`代寄回信_re_…`、`mail::tests::代寄抬頭_各種寫法` |
| `reply-head.test.mjs` | `mail::tests::回覆抬頭拆除`、`tests::視窗自己加的回覆抬頭會被拆掉_…` |
| `nonce.test.mjs` 假編號重啟 | `tests::假_nonce_的回覆區塊_…`、`worker::tests::假_nonce_…`、`tests::信件內文偽造橋接指令_…` |
| `pending-persist.test.mjs` | `pending::tests::*`、`tests::重啟_還在等的信_…`、`重啟_已通知沒回的信_…`、`對不上的回覆_最近交辦者…` |
| `pull-retry.test.mjs` | `tests::拉信失敗_短退避重試_成功後歸零` |
| self-recv（`recv.test.mjs` 心跳部分） | `tests::視窗自己在收信_…` |
| （新增）鎖與舊橋共存 | `lock::tests::*`、`handoff::tests::*`、`tests::管理器_…`、`設定_預設關閉_…` |
| （新增）名單／上線 | `roster::tests::*`、`tests::名單回報_…` |
| （新增）真的子程序 | `tests::真的子程序_…`（啟動、轉交、回覆寄回、結束時只關自己的 worker、清掉 `mailbox.pid`／`bridge.pid`） |
| （新增）節點代號 | `tests::自動產生的節點代號辨識_…`、`視窗名預設值_新電腦用電腦名稱_不含節點代號`（`lib.rs`） |

守門測試都做過還原驗證（拿掉被守的行為，確認對應測試會紅）：ASN 自己視窗跳過、self-recv 跳過、假 nonce 偵測、30 分鐘合併、去重、ack 時機。

## 6. 與 Node 橋的已知差異

1. **名單來源**：Node 橋跑 `claude agents --json`（約每次 1～3 秒的子程序），內建橋直接讀 session 檔。欄位（pid、name、cwd、status、kind、entrypoint、updatedAt）與 Node 橋本來就讀的 `~/.claude/sessions/<pid>.json` 相同，但 `status` 在 session 檔裡是否與 `agents --json` 一致，要在實機確認（忙碌延後依賴它）。若不一致，第二段改回呼叫 `claude agents --json`。
2. **非互動式 session**：Node 橋另存一份含背景 session 的 `agents`（給 `IRORI_RELAY_ALLOW` 用）。內建橋名單與可轉交名單相同，`IRORI_RELAY_ALLOW` 只對名單內的視窗有效。
3. **忙碌狀態**：固定 busy／working／running（不分大小寫），不讀 `IRORI_BUSY_STATUS_RE`。
4. **寄給 ASN 自己視窗的信**：內建橋不處理（見第 2 節表格）。
5. **群組、附件、孤兒清理**：第二段。
