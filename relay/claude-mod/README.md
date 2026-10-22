# ASN Claude mod（第一期，#134）

把 ASN 收發室的「寄信」接進 Claude Code 視窗（需要 Claude Code 2.1.306 以上、支援 mod 的版本）。

## 裝法

開發／試用（只這個 session）：

```
claude --plugin-dir D:/Github/Yooliang/asn/relay/claude-mod
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
- **狀態轉換**（只看主迴圈，子代理輪次一律忽略）：
  - `session.start` → `idle`；`turn.start` → `busy`。
  - `AskUserQuestion` 呼叫前 → `waiting_user`，使用者答完回來 → `busy`。純觀察，不改也不擋該工具。
  - `turn.complete`：該輪的 `classic.Stop` 帶有 `background_tasks` → `background`；否則有 `session_crons` → `scheduled`；否則 `idle`。結束原因是中斷或出錯一律 `idle`（detail 註明）。`Stop` 與 `turn.complete` 的先後沒有保證：`turn.complete` 先寫一次，`Stop` 晚到會重算並覆蓋。
  - `session.end` → 寫 `state:"idle"`、`detail:"已結束"`（引擎沒有刪檔與改名的介面，所以不刪檔）。
- **寫檔方式**：直接覆蓋（無法先寫 `.tmp` 再改名），讀的一方讀到半份 JSON 要當沒有。任何寫檔失敗都吞掉（最多 `$.ui.log` 一行），不影響 Claude 運作。
- **過期**：超過 30 分鐘沒更新的檔由讀的一方判為過期（ASN 內建橋負責），mod 不做清理。

## 限制

- Bash 守門以命令字串判斷（含 `--to` 且無 `--reply`／`--no-reply` 旗標字樣），內文剛好含有這些字樣會放行；這是提醒用的守門，不是安全邊界。
- 後續：第二期收件匣面板與身分段、第三期轉交改由 mod 收；詳見 #134。

## 開發

```
claude plugin validate relay/claude-mod
claude plugin test relay/claude-mod
```

寄信純邏輯在 `hooks/lib.ts`，視窗狀態檔邏輯在 `hooks/status.ts`；測試在 `hooks/asn.test.ts`、`hooks/status.test.ts`。
