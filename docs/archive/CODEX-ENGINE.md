# Codex 轉接器：可行性、限制、費用、安全與上線步驟

> 2026-10-03 調查與原型。環境：Windows 11 原生、`codex-cli 0.154.0`（npm 安裝）、ChatGPT Plus 登入。
> 程式：`relay/machine/engines/codex*.mjs`（轉接器）、`relay/machine/tools-codex-probe.mjs`（手動檢查）、`relay/machine/test/codex-engine.test.mjs`＋`fake-codex.mjs`（契約測試）。
> 介面定義見 `relay/machine/README.md`「轉接器介面」；產品面的決定見 `docs/MULTI-USER.md` 第 14 節。

## 1. 結論

**可以做到跟 Claude 視窗一樣的「名單＋轉交＋回覆」，而且是對使用者自己開著的互動視窗（TUI／桌面版）做，不是另外開背景工作。** 全部用使用者自己的 ChatGPT 登入額度，不碰 API 金鑰。已在真的 Codex TUI 視窗上端到端驗證（開窗 → 列名單 → 轉交 → 取回覆，約 14～15 秒；視窗忙碌時信排隊、處理完回覆；關窗後從名單消失）。

| 功能 | Claude 視窗 | Codex 視窗（本原型） |
|---|---|---|
| 名單 | `claude agents --json` | `session_index.jsonl`（有名字的 thread）∩ `thread-writer-locks`（正被某行程開著）；忙碌＝最後一個 turn 尚未結束 |
| 轉交 | 收發室 worker 的 `SendMessage` | `codex queue --thread <id> --message=<信>`：寫進 Codex 自己的持久佇列，持有該 thread 的行程閒下來就當成使用者訊息處理 |
| 回覆 | 視窗回覆 → worker 輸出帶 nonce 的區塊 | 唯讀輪詢 `thread/turns/list`，找到含本信編號的 turn、等它結束，取最終回覆文字（**Codex 這一輪的最終回答就是回信**，不必另外呼叫寄信工具） |
| 登入／額度 | 無 | `account/read`、`account/rateLimits/read`；名單狀態標 `login-required`／`limit`，轉交時明確失敗 |
| 開新視窗 | `Start-Process claude … -n {name}` | 先建好「有名字、有內容」的 thread（不花模型額度），再 `Start-Process codex … resume <thread id>` |
| 身分判定 | 父行程鏈＋messaging socket | 環境變數 `CODEX_THREAD_ID` 對 `session_index.jsonl`（Codex 對每個 shell 指令注入） |
| 視窗自己收信（`recv --watch`） | 有 | 沒有（`selfRecv: false`），一律走橋轉交 |

**做不到或打折扣的**（細節見第 6 節）：沒有共用常駐 daemon（npm 安裝不能啟動）所以不能一次列出所有 session 的即時狀態，改用「鎖檔＋檔案」推斷；信走命令列參數所以有長度上限；視窗開機時會被「更新提示」與「是否信任資料夾」卡住；預設沙盒不給網路，視窗內的 `send.mjs` 連不上仲介（要走 MCP，列為第二期）。

## 2. 架構

```
橋(bridge.mjs) ──deliver──▶ codex.mjs ──▶ codex queue --thread <id> --message=<信>   (寫入 ~/.codex/queue_1.sqlite)
      ▲                         │                                   │
      │ onSent/onFail/onReply   │ reader app-server (stdio, 唯讀)    ▼
      └─────────────────────────┤  thread/read · thread/turns/list   持有該 thread 的 Codex 行程(TUI/桌面版)
                                │  account/read · account/rateLimits/read   閒下來 → 取出佇列 → 當一輪對話處理
                                └─ 讀檔：session_index.jsonl、thread-writer-locks/、rollout(.jsonl 的 turn_context)
```

- **reader 絕不 `thread/resume`**：載入 thread 的行程會變成持有者（實測：另一個 app-server 一載入就把佇列裡的信取走並處理），會跟使用者的視窗搶佇列。reader 只呼叫讀取類方法，測試裡有斷言。
- 檔案：`codex.mjs`（介面與流程，262 行）、`codex-rpc.mjs`（app-server JSON-RPC 客戶端）、`codex-state.mjs`（名字索引、鎖檔、沙盒設定）、`codex-bin.mjs`（找執行檔、環境清理）、`codex-identity.mjs`（身分判定，登記在 `identity-providers.mjs`）。
- 載入：`IRORI_ENGINES=claude,codex`（或只 `codex`）。`launcher.json` 的 profile 可寫 `"engine": "codex"` 指定用哪個轉接器開視窗（範本見 `launcher.example.json`）。
- 信件在 Codex 裡的樣子：原信全文（含 `[RELAY 來信] … engine=codex` 標頭）＋一行尾註 `（irori-mail:<信編號>｜這是收發室轉來的信；你這一輪的最終回覆會由收發室自動寄回給寄件人，不必另外寄信。）`。編號是回覆對應用的；尾註可用 `IRORI_CODEX_REPLY_NOTE=0` 拿掉（編號仍保留）。

## 3. README 那 11 題的答案（附實測）

> 輸出已遮蔽個資與金鑰。`$ ` 開頭是我實際下的指令。

### 1. 名單與長駐 session

- `codex agents` **只有 TUI**：`$ codex agents < /dev/null` → `ERROR: stdin is not a terminal`；`codex agents --json` → `unexpected argument '--json'`。沒有機器可讀輸出。
- 它瀏覽的「共用本機 app-server daemon」在 npm 安裝的機器上**起不來**：`$ codex app-server daemon start` → `managed standalone Codex install not found at …\.codex\packages\standalone\current\bin\codex.exe … Install it with: irm https://chatgpt.com/codex/install.ps1 | iex`。要用 daemon 就得改裝官方 standalone 版（未驗證，且會改變使用者的安裝方式，不建議當前提）。
- 可行的名單來源（全部實測）：
  - `$ codex app-server`（stdio JSON-RPC）→ `thread/list` 回每個 thread 的 `id`、`name`、`cwd`、`updatedAt`、`path`、`source`（`cli`／`vscode`／`exec`）、`status`。**`status` 只反映這個 app-server 行程自己載入的**，別的行程開著的 thread 一律是 `notLoaded`，所以不能拿來判斷「開著／忙碌」。
  - `~/.codex/thread-writer-locks/<thread-id>.lock`：行程載入 thread 時建立、乾淨結束時刪除；Windows 上持有者以不共用方式開著它。判斷方式：用 `FileShare.None` 試開——開不起來＝有人持有（`$ powershell … [IO.File]::Open(lock,'Open','ReadWrite','None')` → 持有中：`The process cannot access the file`；殘檔：成功）。**強制結束（`Stop-Process codex.exe`）會留下殘檔**，所以不能只看檔案在不在。Node 的 `fs.openSync` 檢測不出來（libuv 開檔時共用 delete），因此原型用一次 PowerShell 批次檢查（約 0.3 秒；非 Windows 退回只看檔案是否存在）。
  - `~/.codex/session_index.jsonl`：`{"id":…,"thread_name":…}` 附加式，後面的行蓋過前面；thread 被刪除時該行也會移除。
- **忙碌判斷**：`thread/turns/list`（`limit:1, sortDirection:desc`）最後一個 turn 的 `completedAt` 為 null 即忙碌。注意：從外部讀到的進行中 turn，`status` 會顯示成 `interrupted`（誤導），別用 status 判斷。實測：視窗處理 40 秒長任務期間，名單顯示 `busy`，結束後 `idle`。
- 沒有名字的 thread 不列入（跟 Claude 一樣要先 `/rename`）；Codex 內部子代理（`parentThreadId`／`agentRole`）排除。

### 2. 把訊息送進一個開著的互動 session

`codex queue --thread <UUID或完全相符的名字> --message <文字>` 可行，實測：

```
$ codex queue --thread irori-probe-B --message "irori-probe: reply with exactly QUEUED"
Queued message 01a1024f-8717-… for thread 01a1024f-368d-….        # exit 0
$ codex queue --thread irori-probe-nonexistent --message x         # exit 1
Error: No active session found matching 'irori-probe-nonexistent'.
$ codex queue --thread 00000000-0000-0000-0000-000000000000 --message x   # exit 1
Error: failed to queue session message: thread/queue/add failed: … no rollout found for thread id …
```

- 機制：寫一列到 `~/.codex/queue_1.sqlite` 的 `queued_items`（`payload_json={"UserInput":{"content":[{"type":"text","text":…}],"client_id":…}}`，並遞增 `queued_thread_revisions`）。**不需要 daemon、不需要網路、不需要登入**。
- **誰處理**：任何載入了該 thread 且閒下來的行程。實測三種情況都處理了：(a) 另一個 app-server 載入該 thread 時取走了先前排的信；(b) 該行程已載入、佇列即時加入 → 約 1 秒內開始處理（`turn/started`）；(c) **真的 Codex TUI 視窗**（`codex resume` 開在獨立 console 視窗）→ 處理並回覆。
- 視窗忙碌時：信排隊，這一輪結束才處理；實測先丟一個 40 秒的長任務、期間再丟第二封，兩封都依序處理、各自回覆。
- 沒有人載入該 thread（視窗已關）時：信留在佇列，**下次有人開啟那個 session 才處理**，且 CLI 不能撤回。轉接器因此在轉交前再確認鎖仍被持有，已關閉就 `onFail`。
- 信走**命令列參數**：Windows 命令列上限約 32k 字元 → 預設上限 12,000 字（`IRORI_CODEX_MAX_MAIL_CHARS`），超過回報失敗。**要用 `--message=<文字>` 連寫**：內文若以 `--` 開頭，分開寫會被 clap 當旗標（`error: unexpected argument '--message injected-looking-flag' found`）。已驗證含雙引號、單引號、反斜線、`%PATH%`、`^ & | > <`、反引號、`$()`、換行、tab、emoji、`--` 開頭的內文，經 `node codex.js` 進佇列後與原文逐字相同（讀 `queue_1.sqlite` 比對）。

### 3. 收回覆與格式

- **互動視窗（TUI／桌面版）**：回覆不經過我們的行程，所以用 reader 唯讀輪詢：
  `thread/turns/list {threadId, limit:10, sortDirection:"desc"}` → 每個 turn 有 `status`（`completed`／`failed`／`interrupted`／`inProgress`）、`completedAt`、`error{message,codexErrorInfo}`、`items[]`（`userMessage`、`agentMessage{text,phase}`…）。找 `userMessage` 文字含 `irori-mail:<信編號>` 的 turn，等 `completedAt` 有值，取 `phase:"final_answer"` 的 `agentMessage.text`。實測回覆文字（含繁中、換行、引號、反斜線）原樣取回。
  - 也可直接讀 rollout 檔（`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`，有 `task_complete.last_agent_message`），但那是內部格式；`thread/turns/list` 是 app-server 對外的方法，選它。
  - 輪詢間隔 2 秒（`IRORI_CODEX_POLL_MS`）。無事件串流可訂閱：事件（`item/agentMessage/delta`、`turn/completed`）只送給載入該 thread 的那個 app-server 連線。
- **`codex exec --json`（非互動，備用）** 輸出 JSONL：

```
$ codex exec --json --skip-git-repo-check -s read-only "irori-probe: reply with exactly EXEC-OK, no tools" < /dev/null
{"type":"thread.started","thread_id":"01a10251-…"}
{"type":"turn.started"}
{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"EXEC-OK"}}
{"type":"turn.completed","usage":{"input_tokens":16486,"cached_input_tokens":13184,"cache_write_input_tokens":0,"output_tokens":7,"reasoning_output_tokens":0}}
```
  跑指令時另有 `item.started／item.completed {type:"command_execution", command, aggregated_output, exit_code, status}`。`codex exec resume <thread id> "…"` 可接續同一段對話（實測記得上一輪答的 `EXEC-OK`）。**stdin 要關掉**（或給空輸入），否則印 `Reading additional input from stdin...` 並卡住。`-o/--output-last-message FILE` 可寫最終訊息。出錯：`{"type":"error",…}` 且 exit 1。
  但 exec 是**另一個行程另開一輪**，到不了使用者開著的視窗，也不能跟 TUI 同時寫同一個 thread，所以沒採用；若日後要「沒有視窗時也能代答」可當第二模式。
- **防假回覆**：回覆文字是 Codex 的輸出（不是信件內文），轉接器只拿「含本信編號的 turn」的 agentMessage，不解析 nonce 區塊，內文裡的假標記沒有作用。

### 4. MCP

- Codex 是 MCP **客戶端**：`codex mcp list|get|add|remove|login|logout`；設定在 `config.toml` 的 `[mcp_servers.<name>]`（`command`、`args`、`env`），也可用 `-c mcp_servers.<name>.command=…` 或 app-server `thread/start` 的 `config` 參數針對單一 thread 掛（實測：掛了自寫的最小 stdio MCP 伺服器，Codex 成功 `initialize`、`tools/list`、`tools/call`）。
- **MCP 工具呼叫的 `_meta` 帶視窗識別**（實測）：`_meta["x-codex-turn-metadata"] = {"session_id":…,"thread_id":…,"turn_id":…,"sandbox":"windows_elevated","sandbox_mode":"read-only","model":…,"codex_version":"0.154.0"}`。所以一個共用的「寄信／收信」MCP 伺服器能知道是哪個視窗在呼叫，不必靠父行程鏈。
- **MCP 伺服器行程不受沙盒限制、有網路**（實測：在 `read-only` 沙盒的 thread 裡，MCP 工具從伺服器行程 `fetch('https://example.com')` 回 200）；它拿到的環境變數是最小集合（只有設定裡的 `env`）。
- **核准**：`approval_policy=never` 時 MCP 工具呼叫會失敗：`MCP tool call requires approval, but approval policy is never`；在該伺服器設定加 `default_tools_approval_mode = "approve"` 後正常（實測）。`on-request` 則每次都會跳核准給使用者。
- 結論：**寄信走 MCP 是正解**（有網路、有視窗識別、不用經過 shell 沙盒），但需要寫一支 MCP 伺服器包 `send.mjs`／`recv.mjs`，列為第二期。第一期 Codex 視窗只能「被轉交＋自動回覆」，不能主動寄信給別人（除非放寬沙盒網路，見第 5 節）。

### 5. 身分判定

Codex 對它執行的每個 shell 指令注入環境變數（實測，值已遮蔽）：`CODEX_THREAD_ID`、`CODEX_SESSION_ID`（兩者相同，＝thread UUID）、`CODEX_CI=1`、`CODEX_VERSION`、`CODEX_SANDBOX_NETWORK_DISABLED=1`（沙盒不給網路時）。`CODEX_THREAD_ID` 對 `session_index.jsonl` 即得視窗名，`identity-providers.mjs` 已登記（`codex-identity.mjs`）。
**父行程鏈在沙盒內讀不到**：`Get-CimInstance Win32_Process` 回 `PermissionDenied`，所以不能沿用 Claude 的做法。同一使用者的行程可以偽造這個環境變數——信任邊界跟 Claude 一樣是「同一個使用者帳號」。

### 6. Windows 開新視窗

- `Start-Process cmd.exe /c "codex … resume <id>"`（沿用 launcher 的 `startWindow`）可開出有自己主控台的 TUI；`IRORI_LAUNCH_WINDOW_STYLE=Minimized` 也可正常運作。
- **沒有 `--name` 旗標**，所以 `openWindow` 先用一個短命的 app-server 做 `thread/start`（cwd＝profile 的資料夾）→ `thread/name/set` → `thread/inject_items`（注入一則說明「[RELAY 來信] 是外部輸入」的種子訊息；**這樣才會有 rollout 檔**，空 thread 不會落地、`codex resume` 找不到；也**不花模型額度**），乾淨結束該行程（才會釋放鎖），再把 profile 參數裡的 `{name}` 換成 thread id 去 `codex resume`。同名的舊 session 沒開著就接續它。
- **會卡住視窗的兩個提示**（實測，用 `AttachConsole`＋`ReadConsoleOutputCharacter` 讀視窗內容確認）：
  1. 「Update available! 0.154.0 -> 0.160.0 … 1. Update now 2. Skip 3. Skip until next version」→ profile 加 `-c check_for_update_on_startup=false` 即不出現（實測）。
  2. 「Do you trust the contents of this directory?」→ **沒有**命令列旗標可跳過（嘗試過 `-c projects.'<path>'.trust_level=trusted`，沒用）。卡在這裡時 TUI 還沒載入 thread，沒有鎖檔，**不會出現在名單**；launcher 既有的 30 秒 `unconfirmed` 回報＋`TRUST_HINT` 正好涵蓋。要免卡：把 `cwd_allow` 裡的資料夾預先信任——在 `~/.codex/config.toml` 加 `[projects.'<小寫路徑>'] trust_level = "trusted"`。注意信任是套到 **git 專案根目錄**（提示內寫 "Trusting will apply to the repository root"）。
- 資料夾信任也可能被 Codex 自己寫進設定：實測 `codex exec -s workspace-write` 在某資料夾跑過一次後，使用者的 `config.toml` 多了該資料夾的 `trust_level="trusted"`（我已還原）。轉接器本身不跑 `exec`，不會觸發。
- 結束視窗：對 `codex.exe` 直接 `Stop-Process` 會留下殘鎖（名單判斷已能辨識）；關掉主控台視窗則會乾淨釋放。

### 7. 沙盒與核准

- 旗標：`-s/--sandbox read-only|workspace-write|danger-full-access`；`-a/--ask-for-approval on-request|never`（另有 `untrusted`、granular 設定）；`--approve-for-me`（自動審核）；`--dangerously-bypass-approvals-and-sandbox`（**一律不用**）。TUI 在信任的資料夾裡不帶旗標時，實測是 `workspace-write` ＋ `on-request`。
- Windows 沙盒由 `codex-windows-sandbox-service.exe`（設定 `[windows] sandbox = "elevated"`）提供；`windowsSandbox/readiness` 回 `ready`。沙盒內：`workspace-write` 預設**不給網路**（`CODEX_SANDBOX_NETWORK_DISABLED=1`）、不能讀行程表。
- 外部來信等於「別人對 Codex 下指令」。轉接器的把關：
  1. 轉交前讀該視窗 rollout 最後一個 `turn_context` 的 `sandbox_policy.type`；**`danger-full-access` 的視窗預設不轉外部來信**（`onFail` 帶原因），要放行設 `IRORI_CODEX_ALLOW_FULL_ACCESS=1`。
  2. 開視窗的 profile 範本用 `-s workspace-write -a on-request`：寫檔限工作資料夾，其他動作要使用者在視窗按核准。需要更嚴就 `-s read-only`。
  3. 種子訊息提醒 Codex 把 `[RELAY 來信]` 當外部輸入。
  4. 沿用橋既有的 `trust` 等級與 launcher 白名單（`cwd_allow`、每小時上限）。
- **環境變數洩漏（實測發現）**：預設 Codex 把父行程的環境變數原樣給它跑的 shell 指令——我的環境裡有 `OPENAI_API_KEY`，Codex 的指令一印就把值送進了對話（該 thread 已刪除）。轉接器自己的子行程已清掉 `OPENAI_API_KEY`／`CODEX_API_KEY`／`CODEX_THREAD_ID`／`CLAUDE*`／仲介金鑰；**使用者自己開的視窗不受我們控制**，建議在 `config.toml` 加 `[shell_environment_policy] inherit = "core"`（實測：shell 指令只剩 `CODEX_*` 與基本變數）。

### 8. Windows 原生或 WSL

**原生可用，不需要 WSL。** 套件是 `@openai/codex` 的 `codex-win32-x64` 原生 `codex.exe`，npm 在 PATH 放 `codex.cmd`／`codex.ps1` 外殼。
- Node 20.12+ 不經 shell 不能直接 `spawn` `.cmd`（`EINVAL`），轉接器改成 `node <npm>/node_modules/@openai/codex/bin/codex.js …`（外殼本來做的事），不需要 shell、沒有引號跳脫問題。找不到時可用 `IRORI_CODEX_BIN` 指定。
- `windowsHide: true` 下 app-server／queue／`--version` 都正常。編碼：JSON 一律 UTF-8（繁中、emoji 往返無誤）；只有主控台顯示用 cp950，不影響資料。
- `codex doctor` 警告 Microsoft Defender 可能干擾（建議為 `codex.exe` 等加排除項）。

### 9. 登入與額度

- `codex login status` → `Logged in using ChatGPT`（exit 0）／`Not logged in`（exit 1）。沒登入時 `codex exec` 會對 websocket 401 重試 5 次才 exit 1，很慢，所以轉接器改用 app-server：`account/read {refreshToken:false}` → `{"account":{"type":"chatgpt","planType":"plus"}}`；沒登入 `account:null`。
- 額度：`account/rateLimits/read` → `primary`（300 分鐘＝5 小時窗）與 `secondary`（10080 分鐘＝每週窗）的 `usedPercent`、`resetsAt`，另有 `ordinaryUsageAllowed`、`rateLimitReachedType`。處理中用完會在 turn 上得到 `codexErrorInfo: usageLimitExceeded`（登入失效是 `unauthorized`）。
- 轉接器行為：沒登入／額度用完 → 名單上該引擎所有視窗的 `status` 變成 `login-required`／`limit`；轉交時 `onFail`（「Codex 還沒登入 ChatGPT（請在這台電腦執行 codex login）」、「Codex 額度用完了，約 HH:mm 重置」）；turn 在處理中失敗也 `onFail` 帶原因。`engine.health()` 可查（版本、方案、5 小時／每週用量百分比）。
- 非 ChatGPT 登入（`type` 不是 `chatgpt`，例如 API 金鑰登入）會在 log 提醒：用量不會算在 ChatGPT 額度。

### 10. 版本穩定性

- app-server 與 queue 都標「experimental」；實測已看到 `deprecationNotice`（`thread/read` 帶 `includeTurns:true`、`thread/resume` 一次載入完整歷史都被標為棄用，要改用 `thread/turns/list`／`thread/items/list` 分頁）。`codex doctor` 顯示 0.160.0 已出（本機 0.154.0）。
- 做法：(1) 只用少數方法（`initialize`、`account/read`、`account/rateLimits/read`、`thread/read`、`thread/turns/list`；開窗另用 `thread/start`、`thread/name/set`、`thread/inject_items`）；(2) 啟動時偵測 `codex --version`，**低於 0.154 停用**（`listWindows` 回 `null`、`deliver` 同步 throw），新於 0.154.0 照用但 log 提醒；(3) `codex app-server generate-json-schema --out <dir>` 可產生當版協定，升級 Codex 前後各產一份比對；(4) 建議上線時鎖版本：`npm i -g @openai/codex@0.154.0`，升級走「先跑 `node --test relay/machine/test/codex-engine.test.mjs` 與 `tools-codex-probe.mjs status`」。

### 11. 忙碌狀態與逾時

- 忙碌：見第 1 題（最後一個 turn 沒結束）。名單的 `status` 為 `busy`／`idle`，橋既有的 `BUSY_STATUS_RE`、「忙碌時延後無回覆通知」直接沿用，**不需要改橋的狀態機**。
- 轉交 → 回覆的時序：`deliver` 成功排進佇列就 `onSent`（橋才會轉成等待回覆），之後輪詢到 turn 結束 → `onReply`。視窗忙、或卡在核准提示時 turn 一直沒結束，轉接器不回覆，由橋的回覆逾時（預設 10 分鐘）通知寄件人；之後回覆才來走既有的「遲到回覆」。轉接器本身追蹤 1 小時（`IRORI_CODEX_OUTSTANDING_MAX_MS`），3 分鐘還沒被處理會在 log 記一筆。
- 不支援撤回：已排進佇列的信，視窗關掉再開才會處理（屆時變成對不上的回覆，橋會依 `lastRequester` 轉給最近的寄件人）。

## 4. 費用與用量

- **誰付錢**：使用者自己的 ChatGPT 方案額度（Plus／Pro 等）；官方不付、不經手金鑰。`OPENAI_API_KEY` 即使存在也被清掉，不會走 API 計費。
- **一封信的成本**：實測一個最小回覆（「只回 PONG」）就有約 16k 輸入 token（系統提示＋工具定義，快取後約 8k 計費）；長回覆（600 字短文）約 8–10k 輸出。在 Plus 上，這次調查約 25 個 turn（含幾個 500～600 字的長回覆、掛了額外 MCP 工具）用掉 5 小時窗 15%、每週窗 2%，平均每個 turn 約 0.5～0.7% 的 5 小時額度。視窗裡已有對話歷史時，每封信的輸入會更大（歷史＋工具輸出）。所以**一天幾十封信是可以的，一個 5 小時窗內塞上百封會碰到額度**。
- **使用者怎麼看**：Codex TUI 的 `/status`；ChatGPT 網站的 Codex 用量頁；`tools-codex-probe.mjs status`（印出 `primaryPct`／`secondaryPct`／`resetsAt`）；app-server `account/usage/read` 有每日 token 數。額度用完時名單會標 `limit`，並在轉交時明確回報，不會無聲失敗。
- 開視窗的種子 thread（`thread/inject_items`）不呼叫模型，不花額度。

## 5. 安全（彙整）

1. **預設不轉進「完全存取」視窗**；開視窗 profile 用 `-s workspace-write -a on-request`（或更嚴）。**絕不**用 `--dangerously-bypass-approvals-and-sandbox`。
2. 外部來信是不受信任輸入：標頭帶 `trust=`，種子訊息提醒；有破壞性的動作靠 Codex 的核准提示讓使用者攔。
3. 清掉 `OPENAI_API_KEY` 等環境變數；使用者視窗建議 `shell_environment_policy.inherit = "core"`（第 7 題）。
4. `config.toml` 的資料夾信任與更新提示是使用者的設定，轉接器不改它；預先信任 `cwd_allow` 資料夾是上線步驟（由使用者做）。
5. 沙盒預設不給網路 → 視窗內的 `send.mjs`／`recv.mjs` 會連不上仲介。有兩條路：(a) 第二期 MCP 工具（建議）；(b) 放寬沙盒網路（`[sandbox_workspace_write] network_access = true`），代價是 Codex 的指令也能上網，**不建議預設開**。
6. reader 不 `resume`，不會偷走使用者視窗的佇列；使用者視窗的對話內容（rollout）只被讀取最後一個 `turn_context` 與含本信編號的 turn。

## 6. 限制與已知問題

1. **名單不是即時、也不是 Codex 官方「session 清單」**：靠鎖檔與索引檔推斷，每 60 秒（橋的名單週期）更新；非 Windows 平台只看鎖檔是否存在，**強制結束留下的殘檔會被誤判成開著**（Windows 才有持有檢查）。macOS／Linux 需另行驗證。
2. 沒有名字的視窗不列入；同名視窗只留最近有動靜的。
3. 信走命令列：上限 12,000 字；超過會失敗而不是截斷。
4. 回覆＝Codex 這一輪的最終回答：Codex 若沒有文字回答（只做了動作）會回「（Codex 這一輪沒有文字回覆）」；沒有「這封信不用回」的機制（Claude 視窗可以選擇不寄）。
5. 視窗關掉後排進佇列的信無法撤回。
6. 開新視窗會被「信任資料夾」提示卡住（需預先信任或人按 Enter）；`check_for_update_on_startup=false` 要寫在 profile。橋同一時間只用 profile 指定的轉接器開窗；沒指定時用第一個宣告 `openWindow` 的轉接器。
7. 視窗內主動寄信（`send.mjs`）在預設沙盒不通（第 5 節），第一期只支援「被轉交＋自動回覆」。
8. 桌面版（Codex app）的視窗理論上同樣持有鎖並處理佇列（桌面版設定有 `followUpQueueMode`），**本次未實測**。
9. 協定是實驗性的，升級 Codex 前要重跑測試（第 10 題）。
10. 實測時 `codex doctor` 回報 0.160.0 已出；未在 0.160.0 上驗證。

## 7. 建議上線步驟

1. **固定版本**：`npm i -g @openai/codex@0.154.0`；`codex login status` 確認是 `Logged in using ChatGPT`。
2. **檢查**：`node relay/machine/tools-codex-probe.mjs status`（版本、方案、5 小時／每週用量、目前開著的 Codex 視窗）。
3. **先在一台自己的電腦上試**：`~/.codex/config.toml` 加 `[shell_environment_policy] inherit = "core"`；把準備給收發室用的資料夾加入信任（`[projects.'<小寫路徑>'] trust_level = "trusted"`）。
4. **手動端到端**：開一個 Codex 視窗（`codex resume` 或 `tools-codex-probe.mjs open <名字> <資料夾> -c check_for_update_on_startup=false -s workspace-write -a on-request`），在視窗裡 `/rename`（開窗工具已命名則免）；再 `tools-codex-probe.mjs send <名字> "…"`，確認約 15 秒內收到回覆。
5. **掛進橋**：`IRORI_ENGINES=claude,codex`（`codex` 單獨也行）；`launcher.json` 加 `codex` profile（見 `launcher.example.json`，`"engine": "codex"`）。重啟橋由使用者自己決定時機。
6. **觀察一週**：看 `bridge.log` 的 `codex …` 行（版本提醒、同名、未處理的信、額度），確認手機名單的 `engine` 欄位顯示 codex。
7. **第二期**：MCP 伺服器（寄信／收信，視窗識別用 `_meta`）、`recv` 免輪詢的通知、桌面版驗證、macOS／Linux 的鎖檔偵測。

## 8. 設定與環境變數

| 變數 | 預設 | 作用 |
|---|---|---|
| `IRORI_ENGINES` | `claude` | 逗號分隔；加上 `codex` 即載入本轉接器 |
| `IRORI_CODEX_BIN` | 自動找 | 指定 `codex` 執行檔 |
| `IRORI_CODEX_POLL_MS` | 2000 | 輪詢回覆間隔 |
| `IRORI_CODEX_MAX_MAIL_CHARS` | 12000 | 單封信字數上限 |
| `IRORI_CODEX_ALLOW_FULL_ACCESS` | 無 | `1`＝放行轉給「完全存取」視窗（不建議） |
| `IRORI_CODEX_REPLY_NOTE` | 開 | `0`＝信尾不附「回覆會自動寄回」說明（編號標記仍保留） |
| `IRORI_CODEX_OUTSTANDING_MAX_MS` | 3600000 | 轉接器追蹤一封信回覆的上限 |
| `IRORI_CODEX_DRAIN_WARN_MS` | 180000 | 信排進佇列這麼久還沒被處理就記 log |
| `IRORI_CODEX_HEALTH_TTL_MS` | 30000 | 登入／額度檢查快取 |
| `IRORI_CODEX_LOCK_MODE` | `auto` | `exists`＝只看鎖檔是否存在（測試用） |
| `IRORI_CODEX_SKIP_VERSION_CHECK` | 無 | `1`＝不擋 0.154 以下的版本（自負風險） |
| `CODEX_HOME` | `~/.codex` | Codex 資料夾 |

## 9. 這次調查動過什麼（可稽核）

- 只用名稱帶 `irori-probe` 的 session 測試（先後建立十餘個 thread 與幾個 TUI 視窗，全部測完刪除；用 `codex delete`，`session_index.jsonl` 回到原本 3 行）；沒有對使用者既有的 3 個 session 送任何訊息、沒有 resume 它們。
- 測試中 `codex exec -s workspace-write` 與一次暫時加入的信任設定動到了使用者的 `~/.codex/config.toml`（加入探針資料夾的 `trust_level`），**已還原成與原檔逐位元組相同**。
- 結束視窗一律用自己記下的 PID（`Stop-Process -Id`），沒有用映像名稱批次結束。
