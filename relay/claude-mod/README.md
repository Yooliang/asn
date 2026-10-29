# ASN Claude mod（第一期，#134）

把 ASN 收發室的「寄信」接進 Claude Code 視窗（需要 Claude Code 2.1.306 以上、支援 mod 的版本）。

## 裝法

開發／試用（只這個 session）：

```
claude --plugin-dir <ASN 原始碼>/relay/claude-mod
```

正式安裝（本機資料夾 marketplace，只做一次）：

```
claude plugin marketplace add <ASN 安裝資料夾>\claude-mod
claude plugin install asn@asn
```

- `claude-mod` 資料夾裡的 `.claude-plugin/marketplace.json` 把它自己宣告成名為 `asn` 的 marketplace，外掛 `asn` 的 `source` 是相對路徑 `./`，所以語法是 `外掛名@marketplace名` ＝ `asn@asn`。
- `source` 是相對路徑時，Claude Code 直接讀該資料夾，不另存副本；ASN 更新時覆蓋檔案後，在視窗執行 `/reload-plugins`（新開 session 會自動讀）就生效，不必重裝。
- 預設裝在 user scope（`--scope user`），之後每個新視窗都會自動載入。
- 要停用：`claude plugin disable asn`；再啟用 `claude plugin enable asn`。
- 第一次載入要使用者在畫面按「開啟」；`claude -p` 與雲端代理不適用。

## 設定（userConfig）

| 欄位 | 說明 |
| --- | --- |
| `asn_cli_path` | ASN 安裝資料夾的 `asn-cli.exe` 完整路徑（ASN 設定頁「寄信指令」可複製）。**優先使用**。留空會自動找 `%LOCALAPPDATA%\ASN\asn-cli.exe`，檔案存在才用。 |
| `send_mjs_path` | 沒設 asn-cli 時的退路：`relay/machine/send.mjs` 完整路徑（需要 node）。 |
| `node_path` | 跑 send.mjs 的 node 指令，預設 `node`。 |

順序：`asn_cli_path` → 預設位置的 `asn-cli.exe` → `send_mjs_path`；都沒有，`asn_send` 會回「尚未設定」而不寄信。

## 第一期做了什麼

1. **`asn_send` 工具**（`isDeferred:false`，全名 `mcp__asn__asn_send`）：`to`／`room` 二選一、`body` 必填、寄給 `to` 時 `expects_reply`（boolean）必填，對應 `--reply`／`--no-reply`；`reply_to` 選填。實際是呼叫 `asn-cli send`（或 `node send.mjs`），所以 `replied/`、`sent/` 記號、寄件人判定、額度都照原本行為。回傳 stdout（`sent id=…`）或錯誤。**不會自動帶 reply_to**。
2. **Bash 守門**：命令裡有 `send.mjs`／`asn send`／`asn-cli send`，用了 `--to` 卻沒有 `--reply`／`--no-reply` → 拒絕並提示改用 asn_send。`--room` 不擋。
3. **本人簽章紅線（ASN#118）**：mod 寄出的信一律是成員身分。`asn_send` 組出的參數、Bash 寄信命令只要出現 `as_person`、`x-asn-user`、`--person`、`ASN_USER…`、`user_token` 之類字樣就擋。mod 不傳任何環境變數給子行程，也不讀任何金鑰檔（金鑰由 asn-cli／send.mjs 自己讀）。

## 狀態列未讀數（第一期還沒做，但唯讀查詢已備好）

`recv --once`／`--watch` 都會 ack，不能拿來輪詢。現在 asn-cli 有唯讀的 **`asn-cli recv --peek`**：列出本視窗目前未讀的信，一行 JSON `{"count":N,"messages":[{"id","from","at","preview"}]}`（preview 截 80 字），**不 ack、不改任何狀態、不寫記號**；加 `--count-only` 只輸出 `{"count":N}`。狀態列腳本可直接輪詢它。後端要先部署 `inbox_peek` 動作（migration `20261022030000_inbox_peek.sql`）；還沒部署時 asn-cli 會印中文錯誤並以結束碼 4 離開，這時狀態列就不要顯示數字。

## 視窗狀態檔

mod 把這個視窗的細部狀態寫到本機檔，給 ASN 內建橋讀進 roster。

- **路徑**：`~/.asn/status/<sessionId>.json`（`~` 取 `USERPROFILE`，沒有再取 `HOME`；資料夾不存在會自動建）。
- **格式**：`{ "sessionId", "state", "detail", "at", "turnId", "plugin" }`
  - `state`：`busy`｜`idle`｜`waiting_user`｜`background`｜`scheduled`
  - `detail`：人看得懂的短字串，例如 `背景工作 2 件`、`ScheduleWakeup 13:20`、`AskUserQuestion：<問題前 80 字>`、`中斷`、`出錯`、`已結束`
  - `at`：寫檔時間（epoch 毫秒）；`turnId`：目前這一輪；`plugin`：`asn@<plugin.json 的 version>`
  - `tasks`（選填，#539 之三）：`state` 為 `background` 時寫，`[{ id, desc, kind? }]`，最多 20 筆。取自 Stop hook `background_tasks` 每筆的 `id`、`description`、`type`；`command`（指令全文）與 `last_assistant_message` 不存。說明壓成一行、遮掉像金鑰的字串、截到 60 字。ASN 對話頁「工作項目」按鈕讀它列出本機的背景工作。
- **狀態轉換**（只看主迴圈，子代理輪次一律忽略）：
  - `session.start` → `idle`；`turn.start` → `busy`。
  - `AskUserQuestion` 呼叫前 → `waiting_user`，使用者答完回來 → `busy`。純觀察，不改也不擋該工具。
  - `turn.complete`：該輪的 `classic.Stop` 帶有 `background_tasks` → `background`；否則有 `session_crons` → `scheduled`；否則 `idle`。結束原因是中斷或出錯一律 `idle`（detail 註明）。`Stop` 與 `turn.complete` 的先後沒有保證：`turn.complete` 先寫一次，`Stop` 晚到會重算並覆蓋。
  - `session.end` → 寫 `state:"idle"`、`detail:"已結束"`（引擎沒有刪檔與改名的介面，所以不刪檔）。
- **寫檔方式**：直接覆蓋（無法先寫 `.tmp` 再改名），讀的一方讀到半份 JSON 要當沒有。任何寫檔失敗都吞掉（最多 `$.ui.log` 一行），不影響 Claude 運作。
- **過期**：超過 30 分鐘沒更新的檔由讀的一方判為過期（ASN 內建橋負責），mod 不做清理。

## 第三期：來信輪次自動回信

由來信觸發的那一輪，做完時外掛自動把最後的回答寄回寄件人（#134）。

- **記下來信**：`turn.start`（主迴圈，子代理忽略）解析開頭文字。要 `[RELAY 來信]` 開頭、`trust=member|owner`，且 `reply=yes`，或有新版「【要回信】」行（帶回信位址與 id，優先於第一行的 `from`／`id`；舊版只有第一行也能用）。`reply=no`／`?`、寄件人含「收發室」、內文以「［收發室］」開頭、trust 不是 member／owner 的一律不記。使用者自己打字的輪次不記。
- **本輪已回就不寄**：`asn_send` 的 `to` 等於寄件人或 `reply_to` 等於信件 id；或 Bash 的 send.mjs／asn send／asn-cli send 帶 `--reply-to <id>`／`--to <寄件人>`（成功才算）。
- **`turn.complete`（同一 turnId、主迴圈）**：`answer` 且沒有背景工作／排程（`classic.Stop`）→ 把 answer 寄回（`--to <from> --reply-to <id>`）；結尾是問句（`?`／`？`，或最後一句含嗎、呢、要不要、是否）→ `--reply` 並在內文前加「（對方在問）」，否則 `--no-reply`；answer 為空寄「（這一輪沒有文字回覆）」；超過 20000 字截斷並註明。`aborted`／`error`／`refusal` → 寄一行「這封信的處理中斷了／出錯了／被拒答了」（`--no-reply`）。
- **簽章**：自動寄出走同一個 `buildSendArgv`，簽章守門照舊（一律成員身分）。寄信失敗吞掉，最多 `$.ui.log` 一行。
- **限制**：Stop 與 turn.complete 的先後沒保證，Stop 還沒到時最多等 0.6 秒。有背景工作或排程時整輪不寄，之後真正做完的那一輪若不是同一個 turnId（不是來信觸發）也不會寄；第一版不處理。【要回信】行格式已由 ASN 主線定案：第三行 `【要回信】回信位址=<位址> 信件編號=<id>：…`，只認這兩個欄位（值不含空白，遇空白或全形冒號結束）；第二行「寄件人：」說明含「收發室」也算系統信。

## 外掛控制檔（rename／model／command）

ASN 橋（`bridge/partner_ops.rs`，格式見 `docs/design/PARTNER-OPS.md` 第八節）要改這個視窗的名字或模型時，寫 `~/.asn/control/<sessionId>.json`：`{"id","op":"rename"|"model","arg","at"}`。

- **偵測**：`session.start` 起每 1.5 秒讀一次（`$.clock.every`）；檔案不存在、JSON 壞掉、sessionId 不是英數／`-`／`_`（≤128）一律安靜忽略。
- **執行**：`rename` → `$.command.run({ command: 'rename', args: arg })`；`model` → `command: 'model'`。完成後在狀態檔加 `control: {id, ok, detail}`（id 原樣回傳、detail 中文 ≤200 字），其餘欄位照舊，之後的狀態更新也會保留這個欄位。
- **command**（從手機傳 / 指令）：`{"id","op":"command","command","args","at"}`，`command` 只收 `[A-Za-z0-9:_-]{1,64}`（不含開頭斜線），`args` 可空、≤2000 字、不含控制字元；用 `$.command.run({ command, args })` 執行（一樣排到閒置才跑），成功時 `detail` 放指令輸出文字（保留換行，截 1500 字；沒有輸出寫「已執行 /指令」），引擎拒絕（例如未知指令）回 `ok:false` 帶原因。只有本人簽章、以 / 開頭的信會被電腦端轉成這種控制檔。
- **規則**：`at` 超過 2 分鐘的忽略；同一個 `id` 只執行一次；op 不認得、arg 空白／含控制字元／rename 超過 100 字／model 格式不合法 → `ok:false` 帶中文說明，不執行。外掛不刪控制檔（橋會刪）。
- **橋放棄等待**：`$.command.run` 排到閒置才跑，橋可能已逾時刪掉控制檔。外掛的 `command.run` hook 在真正執行前再讀一次控制檔，不在或 `id` 不同就不執行、不寫結果（只擋自己排進去的那一筆：來源是外掛、指令與參數相同）；已經開始執行無法取消的，跑完發現控制檔不在照樣寫 `control`，`detail` 開頭加「（橋已放棄等待）」。
- **心跳**：狀態檔沒有變化時，計時器每 5 分鐘只把 `at` 換成現在重寫一次（其餘欄位照上次寫出去的內容），讓收發室不會把閒置超過 30 分鐘的視窗當成沒外掛。還沒寫過狀態、或寫入失敗沒留下內容就不重寫。
- **選填欄位**：狀態檔另有 `model`（`$.session.model()`）與 `context: {used, limit, percent}`（`$.session.usage()`），拿不到就不寫。
- 程式在 `hooks/control.ts`，測試在 `hooks/control.test.ts`。

## 限制

- Bash 守門以命令字串判斷（含 `--to` 且無 `--reply`／`--no-reply` 旗標字樣），內文剛好含有這些字樣會放行；這是提醒用的守門，不是安全邊界。
- 後續：第二期收件匣面板與身分段、第三期轉交改由 mod 收；詳見 #134。

## asn 技能與開窗提示

讓沒有 ASN 原始碼的電腦上的 Claude 也知道怎麼用收發室。

- **`skills/asn/SKILL.md`**：收信格式與信任等級（owner／member）、`asn-cli` 各子命令、回信要回 `from=` 完整位址、查版本的方法。技能的說明文字每個視窗都會列出，Claude 自己會判斷何時讀。
- **`skills/asn/CHANGELOG.md`**：不在 repo 裡，打包時把 `relay/asn/CHANGELOG.md`（ASN 版本更新記錄的唯一來源）帶進這個位置（`tauri.conf.json` 的 `bundle.resources`），所以更新說明跟著 ASN 發版自動更新，不用另外維護。
- **開窗提示**：`session.start` 用 `$.session.append` 附一則系統提示「這台裝了 ASN x.y.z，看 asn 技能」。附不上（例如引擎說沒有對話可附）只記一行 log，不影響開窗。

## 開發

```
claude plugin validate relay/claude-mod
claude plugin test relay/claude-mod
```

寄信與來信解析的純邏輯在 `hooks/lib.ts`，視窗狀態檔邏輯在 `hooks/status.ts`；測試在 `hooks/asn.test.ts`、`hooks/status.test.ts`、`hooks/reply.test.ts`。
