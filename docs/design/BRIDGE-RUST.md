# ASN 內建收發室橋（全 Rust）

issue #12 第二期。目標：打開 ASN ＝ 這台設備的收發室就上線，不用另外裝、另外管 Node 的收發室橋；ASN 縮在系統匣保持活動（#61 已有）。別台的 ASN 看得到這台上線，之後可以遠端替這台開新的 Claude 視窗並對談。

決策沿革：`ONBOARDING.md` 3.5 原本推薦「隨附 Node 執行檔」（方案甲），之後小良哥改裁**全 Rust、不帶 Node**（D1）。本文件是那個裁決的實作設計。Node 橋（`relay/machine/bridge.mjs`）繼續存在，Linux 雲端環境與 Aegis 主機仍在用，不在本文件範圍。

## 1. 分段計畫

| 段 | 內容 | 狀態 |
|---|---|---|
| 第一段（PR #110） | Claude 引擎的核心：單一收信者鎖、名單回報（上線）、門鈴＋輪詢＋快速重試、轉交給本機 Claude 視窗、回覆寄回、ack／去重／逾時通知／遲到回覆／no-reply／self-recv、對應表跨重啟、設定開關與舊橋偵測、「改由 ASN 負責」（程式有、預設不放行） | 完成，設定「讓 ASN 負責這台的收發室」預設關 |
| 第二段（本 PR） | 群組轉送（`rooms.mjs`）；附件（照片）下載提示行；孤兒程序清理（`bridge.last`）；舊橋退出後自動接手（設定開著時，每 5 秒看一次舊橋還在不在） | 完成；「自己更新」不搬（ASN 的更新由 ASN 自己的更新機制負責，見第 6 節第 6 點） |
| 第三段（本 PR） | 遠端開視窗：`launcher.mjs` 的 `launch_pending`／`launch_result`、本機啟動設定、白名單與每小時上限、roster 的 `launcher` 摘要、開出視窗後的第一句話；別台的「開新夥伴」對話框列出那台回報的 profile 與資料夾；設定頁新增「允許我的其他設備替這台開新視窗」 | 完成，預設關（見第 7 節） |
| 第四段（本 PR） | `asn send`／`asn recv`／`asn room`／`asn attach` 命令列取代 `send.mjs`／`recv.mjs`／`room.mjs`／`attach.mjs`（含 `replied/`、`sent/` 記號、`--file` 附件、父行程鏈身分判定、`--watch` 心跳）；獨立的 console 子系統執行檔 `asn-cli.exe`；橋轉交信件裡的附件下載提示與群組翻頁提示改成這個命令 | 完成（見第 10 節） |
| 第五段 | 其他引擎：Codex、ACP（Gemini 等背景夥伴）的名單、投遞、回信，見 `BRIDGE-ENGINES.md`；遠端開這些夥伴、opt-in 後把預設改為開、淘汰安裝程式的工作排程仍待辦 | 引擎已完成（PR feat/12-bridge-engines）；其餘未開工 |

每段都維持「預設關、關著時 ASN 行為與以前完全一樣」，直到第五段才討論預設值。

## 2. Node 行為 → Rust 模組對應表

模組都在 `relay/asn/src-tauri/src/bridge/`。

| Node 行為（檔案） | Rust（檔案） | 第一段 |
|---|---|---|
| 設定與環境變數（`bridge.mjs` 開頭，`IRORI_*`） | `core.rs` `Config::from_env`（同名同預設值；忙碌狀態改成固定的 busy／working／running，不支援自訂正規式） | 已搬 |
| 單一執行個體 `bridge.pid`（`bridge.mjs`、`relay-core.mjs`） | `lock.rs` | 已搬，與 Node 橋互斥 |
| 認出舊橋、停舊橋與排程（`run-bridge.ps1`、`install-task.ps1` 的反向操作；ONBOARDING 3.9） | `handoff.rs` | 已搬，受設定開關保護 |
| 視窗名單 `claude agents --json`（`engines/claude.mjs` `listWindows`） | `roster.rs`：直接讀 `~/.claude/sessions/<pid>.json`（pid 活著、`kind=interactive`、`entrypoint=cli`、排除收發室自己） | 已搬（資料來源改了，見第 6 節） |
| roster 回報 `POST ?action=roster`（`bridge.mjs` `refreshRoster`） | `roster.rs` `roster_body`＋`core.rs` `refresh_roster`；每 60 秒；多列一筆 ASN 自己的視窗名（engine 標 `asn`）；`launcher` 送遠端開視窗摘要（沒有可用設定送 null） | 已搬 |
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
| 群組轉送（`rooms.mjs`）：`room_list`、游標、只轉 `for_me`、回覆貼回群組、上下文 | `rooms.rs`（格式、游標、確定性編號）＋`core.rs` `pull_rooms`／`handle_room_msg`／`post_room`；`pending.rs` 的 `room` 欄位與 Node 橋同格式 | 第二段已搬 |
| 附件下載提示行（`attach-format.mjs`） | `attach.rs`（清理檔名、白名單欄位、uuid 檢查、最多 4 筆、過期不給指令）；來信與群組訊息都用 | 第二段已搬 |
| 孤兒清理 `bridge.last`（`self-update.mjs` 的 `orphansOf`／`killTree`） | `orphans.rs` | 第二段已搬（`self-update.mjs` 的 git 自動更新不搬） |
| 遠端開視窗 `launcher.mjs`（驗證、歷史、紀錄、等視窗出現） | `launcher.rs`；設定與啟動沿用 `launch/`（`config.rs`、`cwds.rs`、`prefs.rs`、`local.rs`） | 第三段已搬（背景夥伴 `partner-*.mjs` 留到第五段） |
| `send.mjs`／`recv.mjs`／`room.mjs`／`attach.mjs`、`identity.mjs`、`self-recv.mjs`、`attach-upload.mjs`／`attach-download.mjs` | `cli/`（`send.rs`、`recv.rs`、`room.rs`、`attach_cmd.rs`、`upload.rs`、`caller.rs`） | 第四段已搬（Node 版保留給雲端／Linux 無畫面節點） |
| Codex／ACP 引擎（`engines/`） | `engines/`（`acp*.rs`、`codex*.rs`、`rpc.rs`），設計見 `BRIDGE-ENGINES.md` | 第五段已搬（遠端開 Codex／背景夥伴不搬，見該文件第 5 節） |

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
- **舊橋退出後自動接手**（第二段）：設定開著、啟動時因舊橋在跑而讓步，ASN 每 5 秒看一次舊橋的 pid；舊橋一退出（例如使用者自己停掉工作排程）就拿鎖、啟動內建橋。只有「因舊橋而讓步」的情況才會自動接手；設定關著、或啟動失敗是別的原因，都不會反覆重試。
- **孤兒清理**（第二段）：內建橋啟動拿到鎖之後、啟動 worker 之前，讀 `bridge.last`（上一個橋的 pid，正常結束也不刪）。上一個橋已經不在（它的 pid 不在程序表裡），而且 `mailbox.pid` 記的收發室 worker 的父程序還是它，就連同子孫結束那一個 worker（Windows `taskkill /PID /T /F`）。只看父 pid，不依名稱砍；比 Node 橋多一道限制——ASN 是桌面程式，上一個 ASN 還有別的子程序（例如 Linux 上開的終端機視窗）不能一起收掉，所以孤兒必須同時是上次記在 `mailbox.pid` 的 worker。然後把自己的 pid 寫進 `bridge.last`。
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
| `bridges.test.mjs` 附件提示行 | `tests::rooms_launch::信帶附件_…`、`attach::tests::*` |
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
| `rooms.test.mjs`（bridge 部分：只轉 for_me、標頭與上下文、`room_post` 身分、游標、read_seq=0、不可轉交略過、不需回覆、429） | `tests::rooms_launch::群組_*`、`rooms::tests::*` |
| `attach.test.mjs`（格式模組：safeText、normalize、noteLine、bodyWithNotes、群組文字） | `attach::tests::*`、`rooms::tests::標頭_提示_內文_…` |
| `launcher.test.mjs`（設定組合、摘要不含指令、check 各項、流程成功／驗不過／開不起來／unconfirmed 補 ok／每小時上限、第一句話、名單附摘要、沒設定回 failed 與 null） | `launcher::tests::*`、`tests::rooms_launch::遠端開視窗_*` |
| `launcher.test.mjs` 端到端（Start-Process 開假視窗） | `tests::rooms_launch::遠端開視窗_真的開一個隱藏視窗_…`（Windows；假視窗程式是測試執行檔自己） |
| `launch-auto-optin.test.mjs`（自動 profile 預設關） | `launcher::tests::沒有_launcher_json_也沒同意_…`、`設定_允許遠端開視窗預設關_…` |
| （新增）孤兒清理、舊橋退出後接手 | `orphans::tests::*`、`tests::rooms_launch::孤兒清理_…`（真的程序，只收自己記下的）、`管理器_舊橋退出後自動接手_…` |
| （新增）節點代號 | `tests::自動產生的節點代號辨識_…`、`視窗名預設值_新電腦用電腦名稱_不含節點代號`（`lib.rs`） |

守門測試都做過還原驗證（拿掉被守的行為，確認對應測試會紅）：ASN 自己視窗跳過、self-recv 跳過、假 nonce 偵測、30 分鐘合併、去重、ack 時機。

## 6. 與 Node 橋的已知差異

1. **名單來源**：Node 橋跑 `claude agents --json`（約每次 1～3 秒的子程序），內建橋直接讀 session 檔。欄位（pid、name、cwd、status、kind、entrypoint、updatedAt）與 Node 橋本來就讀的 `~/.claude/sessions/<pid>.json` 相同，但 `status` 在 session 檔裡是否與 `agents --json` 一致，要在實機確認（忙碌延後依賴它）。若不一致，第二段改回呼叫 `claude agents --json`。
2. **非互動式 session**：Node 橋另存一份含背景 session 的 `agents`（給 `IRORI_RELAY_ALLOW` 用）。內建橋名單與可轉交名單相同，`IRORI_RELAY_ALLOW` 只對名單內的視窗有效。
3. **忙碌狀態**：固定 busy／working／running（不分大小寫），不讀 `IRORI_BUSY_STATUS_RE`。
4. **寄給 ASN 自己視窗的信**：內建橋不處理（見第 2 節表格）。
5. **群組、附件、孤兒清理**（第二段已搬）：
   - 群組上下文與附件的「下載指令」第二段暫時沿用 Node，**第四段起換成 ASN 自己的命令列**：`<asn-cli 完整路徑> attach --id …`、`<asn-cli 完整路徑> room --room-read …`（路徑用斜線、含空白才加引號；`asn-cli` 找不到時退回 `asn` 主程式自己）。環境變數 `IRORI_ATTACH_CMD`／`IRORI_ROOM_CMD` 仍可整串覆寫。
   - 群組項目的逾時：轉交逾時、等回覆逾時都只記 log 並清掉，不寄通知（與 Node 橋相同）。
   - 孤兒清理多一道限制（見第 3 節）。
6. **自己更新**：Node 橋的 `self-update.mjs` 是「橋自己 git pull 並重啟」。內建橋跟著 ASN 走，ASN 的更新由 ASN 自己的更新機制（`updater.rs`）負責，所以這一項不搬。

## 7. 遠端開視窗（第三段）

目標：打開 ASN ＝ 這台收發室上線；別台（工作機）的 ASN 看到這台上線，可以遠端替這台開一個新的 Claude 視窗並跟它溝通。流程照 `relay/machine/launcher.mjs`：

1. **名單回報附摘要**：`launcher` 欄位＝`{ profiles:[{id,label}], cwd_allow:[…], max_per_hour }`，**不含指令**；沒有可用設定送 null（仲介會清掉，別台就不顯示「開新夥伴」）。
2. **取走待辦**：門鈴響、輪詢、重試時，信件拉完之後 `launch_pending`；每個 id 只處理一次。
3. **執行前再驗一次**（`launcher.rs` `verify`）：視窗名格式、profile 存在且沒停用、cwd 在白名單且是存在的資料夾（先正規化，`..` 與符號連結落到實際路徑）、不和本機視窗重名（不分大小寫，也包含正在開的）、每小時上限（`launch-history.json`，與 Node 橋同格式，重啟也算）。沒通過就 `launch_result failed` 並寫原因。
4. **開視窗**：`launch/local.rs` 的 `start_remote_window`——Claude 引擎先自動信任該資料夾（`claude_json`），再依本機 profile 組命令，用有自己主控台的 PowerShell 視窗開出來（Windows）。
5. **等它出現**：輪詢 `~/.claude/sessions`（每 2 秒），30 秒內沒出現先回 `unconfirmed`（可能卡在「是否信任此資料夾」，提示到電腦前按 Enter），3 分鐘內出現再補 `ok`，超過就放棄（只記 log）。
6. **第一句話**：視窗出現後馬上刷新名單，有 `first_message` 就當成 owner 的來信（id＝launch id）經收發室送進新視窗。
7. 紀錄寫在 `launch.log`（JSON 一行一筆，與 Node 橋同位置）與 `bridge.log`。

**指令只來自本機**（守門測試 `守門_啟動請求的處理程式不讀任何指令類欄位`、`遠端開視窗_取走_開視窗_…`：請求夾帶 `command`／`args`／`env` 也不採用，開出來的命令等於本機 profile 展開 `{name}` 之後的結果）。遠端請求只有 profile 名、視窗名、cwd 會被採用。

**設定來源與同意**（延續 Node 橋「遠端開視窗是擴大權限的動作，預設關」的裁決）：

| 條件 | profile | 工作資料夾白名單 |
|---|---|---|
| 沒有 `launcher.json`、設定頁「允許我的其他設備替這台開新視窗」關著（預設） | 無（整個功能關閉，名單 launcher 送 null） | — |
| 有 `launcher.json`（本機自己寫的＝明確同意） | 檔案裡的 profile | 檔案裡的 `cwd_allow` |
| 打開「允許我的其他設備替這台開新視窗」（`bridge.json` 的 `allow_remote_launch`） | 再加上 ASN 偵測到的 Claude CLI（自動 profile） | 再加上啟動偏好的 `cwdAllow` 與「工作資料夾候選」（`launch/cwds.rs`：最近用過、開著的視窗、信任過的資料夾，最多 15 筆） |

其他限制：只收 **Claude 引擎的視窗型 profile**（Codex、Gemini 等背景夥伴留到第五段）；白名單最多 50 筆（仲介的上限）；不存在的資料夾不列；所有路徑正規化成同一種寫法再比對。切換同意不用重啟橋（每次回報和處理請求都重讀 `bridge.json`）。

**安全取捨（請小良哥確認）**：打開同意後，白名單包含「工作資料夾候選」（開著的視窗、信任過的資料夾），不只是使用者在「瀏覽…」明確加過的。這是照任務要求（資料來源改用 `launch/prefs.rs`、`launch/cwds.rs`）；如果要更嚴，改成只用 `launcher.json` 與 `cwdAllow`，只要在 `SystemEnv::build` 拿掉 `cwds::candidates` 那一行。

**前端**：「開新夥伴」選別台設備時，模型列用那台回報的 profile 與標籤（不再顯示本機偵測到的 CLI），工作資料夾下拉用它回報的 `cwd_allow`；開對話框時重抓一次別台的設定。那台是 ASN 內建橋或舊版 Node 橋都一樣。設定頁新增「允許我的其他設備替這台開新視窗」。

## 7.5 依視窗名的往來記錄（#107）

視窗以名字認人，同名的新 session 要能接手。橋（`bridge/corrlog.rs`）在本機替每個視窗名維護一份往來記錄 `%USERPROFILE%\.asn\handoff\<視窗名>.md`（檔名非法字元換成 `_`，和心跳檔同一套；家目錄沿用 `identity::home_dir`，測試一律把資料夾指到暫存資料夾）。檔案只在本機，不上傳。

- **記什麼、何時記**：每次成功轉交信件或群組訊息給該視窗（`收到`，含寄件人、編號、內文、附件檔名）；橋轉出的該視窗回覆（`回覆`，含一般回覆、對不上來信而轉給最近交辦者的回覆、貼回群組的回覆、視窗代寄的新信）。轉交失敗、被丟棄的回覆、被標「不需回覆」的群組回覆不記。橋的系統通知（補 reply 欄位、逾時提醒）不記、不附路徑。
- **橋看不到的**：視窗自己用 `asn-cli send --reply-to`／`send` 直接寄的信，內文橋拿不到，只有逾時判定時看得到記號檔；那時記一筆 `自行回信`（無內文，註明收發室看不到）。若視窗在逾時前就回了、或根本沒有逾時判定的信（不等回覆的信），就沒有這一筆。
- **每封轉交的信最後多一行**（格式固定）：`你與收發室的往來記錄在：<完整路徑>（接手前請先讀）`，放在 `MAIL` 區塊內、內文與附件提示之後。
- **格式**：每筆以 `▌ <本地時間> <方向>｜<誰> → <誰>｜id=<編號>` 起頭；內文裡以 `▌` 開頭的行會縮排一格，數筆數不會被騙。單筆內文超過 4 KB 截斷並加「（以下省略）」。
- **輪替**：超過 1 MB 或 200 筆，較舊的搬到 `handoff\archive\<視窗名>-<yyyymmdd-HHMMSS>.md`（同一秒內接在同一檔後面），活檔留最近 200 筆（若仍超過 1 MB 再少留幾筆）。寫檔用 `write_atomic`，行程內一把互斥鎖。寫不進去只記 bridge.log，不擋轉交。
- **夥伴 ID（#109）**：橋回報名單後呼叫 `partner_sync`，取得各視窗的夥伴 ID（只放記憶體）；記錄檔名仍用視窗名，檔案第一行寫 `# 夥伴 ID：p_…｜目前名字：…`（輪替時保留，封存檔不帶）。後台不支援（404／400）就不寫檔頭、其餘照舊。規則見 `PARTNER-ID.md`。
- **後續**：「同名開新夥伴預設接續原 session（`--resume`）」屬 #82，這一版沒做；沒有 `--resume` 時（選「全新開始」）才完全靠這份記錄。

## 8. 留到後面的段

- 第五段（引擎部分已完成，見 `BRIDGE-ENGINES.md`）：遠端開視窗支援 Codex 與背景夥伴；opt-in 後把預設改為開、淘汰安裝程式的工作排程。
- 遠端開視窗在 Linux／macOS 的實機驗證（程式沿用 `start_window_unix`，沒有在真機跑過）。

## 9. 真機驗證步驟（第二段＋第三段）

測試都用假後端，真機只能人工驗。建議被控端用**沒有舊 Node 橋**的電腦；家用機的收發室橋正在服務時不要動它。

1. **被控端（甲）**：裝這一版 ASN，登入。設定 → 收發室 → 勾「讓 ASN 負責這台的收發室」。
   - 若顯示「這台的收發室目前由舊版收發室橋負責」：先自己停掉舊橋（停用工作排程 `IroriRelayMachine-<代號>` 並結束它），ASN 會在 5 秒內自動接手；不需要重開 ASN。
   - 看記錄檔（設定 → 記錄資料夾 → `bridge.log`）：應有 `bridge starting … (ASN built-in)`，沒有 `killed orphan`（除非上次是被硬砍）。
2. 同一頁勾「允許我的其他設備替這台開新視窗」。
3. 等 1 分鐘（名單每 60 秒回報一次）。**操控端（乙，另一台電腦的 ASN，同一帳號）**：名單上方 ＋ → 選甲這台設備。對話框應顯示甲回報的模型（例如「Claude（互動視窗）」）與甲的工作資料夾清單，而不是乙自己偵測到的 CLI。
4. 填名字、選資料夾、寫第一句話（例如「回我一句收到」）→ 開啟。
   - 甲的螢幕應跳出新的 Claude 視窗（標題是那個名字）；乙的名單幾秒到幾十秒內出現這個新夥伴。
   - 30 秒內沒出現，乙會先看到「可能卡在信任此資料夾，請到電腦前按一次 Enter」；按了之後 3 分鐘內出現會補成功。
   - 第一句話應已送進新視窗，視窗的回覆會回到乙。
5. 乙對這個新夥伴再傳一句，確認甲的 Claude 視窗收到並回覆。
6. **群組**：在乙建立含甲某個視窗的群組並點名它 → 甲的視窗收到 `[群組 …]` 開頭的訊息，回覆會貼回群組；帶照片的訊息應多一行 `〔照片〕…下載：…`。
7. **同意開關**：甲取消勾「允許我的其他設備替這台開新視窗」→ 約 1 分鐘內乙選甲時應顯示「這台設備尚未回報啟動設定」（甲沒有 `launcher.json` 的情況）。
8. **要確認的未知數**：session 檔的 `status` 欄位是否和 `claude agents --json` 一致（第 6 節第 1 點，忙碌延後依賴它）；「30 秒內出現在 `~/.claude/sessions`」的判斷在 Claude Code 新版上是否仍成立（視窗名來自 `-n <名字>`）。
9. **退回**：取消勾「讓 ASN 負責這台的收發室」→ 橋停止，`bridge.pid` 被清掉；舊橋要自己重新啟用工作排程。

## 10. 第四段：命令列（`asn send`／`recv`／`room`／`attach`）

目標「ASN 全 Rust、不帶 Node」：Claude 視窗寄信、收信、翻群組、下載附件，不再需要 `node relay/machine/*.mjs`。

### 10.1 命令列方案：獨立的 `asn-cli.exe`（console 子系統）

評估過兩個做法，選獨立執行檔：

| | 單一 `asn.exe` ＋ `AttachConsole(ATTACH_PARENT_PROCESS)` | 獨立 `asn-cli.exe`（採用） |
|---|---|---|
| cmd／PowerShell 會不會等它結束 | **不會**（GUI 子系統的程式，殼層直接回到提示字元）；`%ERRORLEVEL%`／`$LASTEXITCODE` 拿不到真正的結束碼 | 會，結束碼正確 |
| 輸出 | 要接上父行程的主控台，還要補標準代碼；輸出會在提示字元之後才冒出來 | 一般的主控台程式，輸出入走管線或主控台都正常 |
| GUI 啟動時閃黑視窗 | 不會 | 不會（asn.exe 還是 GUI 子系統，沒有改動） |
| 建置 | 不用多一個檔 | `Cargo.toml` 多一個 `[[bin]]`，Tauri 會把它跟 `asn.exe` 一起打進安裝檔 |

Claude 的 Bash／PowerShell 工具都要「等指令結束並拿結束碼」（寄信失敗要看得到 exit 1～4），所以正式入口是 `asn-cli.exe`。
`asn.exe` 遇到第一個參數是 `send`／`recv`／`room`／`attach` 時仍會跑同一份程式（先 `AttachConsole` 接上父行程的主控台，已被導向的標準輸出入不動），當備援，讓使用者打 `asn send` 也能用；這條路在 cmd／PowerShell 不會等待，文件一律建議用 `asn-cli`。
兩者都不啟動視窗、不碰單一執行個體鎖，所以可以和正在跑的 ASN（以及橋）並存。

### 10.2 行為對照

- 參數、錯誤訊息、結束碼（1 用法／內容、2 認不出呼叫者、3 超量／被擋／已有人在跑、4 後端錯誤）、輸出格式（`sent id=…`、`posted room=… seq=…`、`saved <路徑>`、`recv` 每封一行 JSON）都照 Node 版。
- 寄件／收件視窗名不能自填：沿父行程鏈（Windows 用 Toolhelp 行程快照，不再呼叫 PowerShell，約快 0.5 秒）找 `~/.claude/sessions/<pid>.json` 登記的 claude 程序；鏈斷了用 `CLAUDE_CODE_MESSAGING_SOCKET` 對上還活著的 session；`--whoami` 印判定過程。
- 記號檔與橋相容：`machine-<節點>/replied/<信件id>`、`machine-<節點>/sent/<sha1([寄件視窗,節點,視窗])>`（與 Node 的 `sentMarkName` 逐字相同，測試內有 Node 算出的向量）、`send-rate.json`、`room-seen.json`、`self-recv/<視窗名>.json` 心跳（`recv --watch` 每 30 秒寫，格式同 `self-recv.mjs`）。
- `recv --watch` 的失敗退避、單一實例（exit 3）、視窗本體不在就自己結束、結束時清心跳，都與 Node 版相同。
- 沒搬的：Codex 視窗的身分判定（`CODEX_THREAD_ID`，`BRIDGE-ENGINES.md` 第 5 節）；照片轉 webp（命令列與 Node 版一樣只收已是 webp 的照片）。

### 10.3 在哪裡找到命令列

- 橋轉交的信件與群組訊息裡的附件下載提示、群組「要看更多」提示，都帶 `asn-cli` 的**完整路徑**（和 `asn.exe` 同一個資料夾），舊的 Claude 視窗不用重開、不用 PATH 就能直接照著打。
- 設定頁新增「寄信指令」：顯示命令列的完整路徑與寄信範例，可複製。
- 沒有改安裝檔的 PATH（這一版不動使用者的環境變數）；之後要加，可在 NSIS 的 installerHooks 把安裝資料夾加進使用者 PATH。

### 10.4 測試

`cargo test`：`cli/tests/` 底下由 Node 版的 `send.test.mjs`／`send-attach.test.mjs`／`recv.test.mjs`／`room.test.mjs`／`attach.test.mjs` 改寫（本機假後端，只連 127.0.0.1），另有 `tests/cli_bin.rs` 真的跑 `asn-cli`／`asn`（父行程當 Claude 視窗）。Node 版的測試保留，因為 Node 版還在（雲端、Linux 無畫面節點）。

### 10.5 真機驗證步驟

1. 安裝或執行新版 ASN；到設定頁「寄信指令」確認路徑存在，按「複製」。
2. 在 Claude 視窗用 Bash 跑：`<路徑> send --whoami`，確認「判定（行程鏈）」是該視窗的名字、節點正確。
3. `<路徑> send --to <本機節點>/<另一個視窗名> --body "測試" --no-reply`，另一個視窗（或 ASN）收到；本機 `~/.irori-relay/machine-<節點>/sent/` 多一個檔。
4. 對收到的信用 `--reply-to <id> --no-reply` 回覆，`replied/` 多一個檔，之後橋不再報「沒有收到回覆」。
5. `--file` 寄一個 pdf 與一張 webp；對方信裡看到「下載：…asn-cli.exe attach --id …」，照打可存檔。
6. `<路徑> recv --watch` 掛在 Monitor：另一邊寄一封，印出一行 JSON；`self-recv/<視窗名>.json` 有心跳；關掉後約 90 秒橋接手。
7. 群組：`<路徑> room --rooms`、`room --room-read <群組> --last 5`。
8. 在 cmd／PowerShell 打 `<路徑> send` 看結束碼（`echo %ERRORLEVEL%`／`$LASTEXITCODE`）是 1，確認會等到結束、沒有閃黑視窗；GUI 的 `asn.exe` 照常啟動沒有黑視窗。
