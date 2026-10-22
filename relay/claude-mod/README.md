# ASN Claude mod（第一期，#134）

把 ASN 收發室的「寄信」接進 Claude Code 視窗（需要 Claude Code 2.1.306 以上、支援 mod 的版本）。

## 裝法

開發／試用（只這個 session）：

```
claude --plugin-dir D:/Github/Yooliang/asn/relay/claude-mod
```

或在 Claude 視窗用 `/plugin install` 從本機資料夾／marketplace 安裝。第一次載入要使用者在畫面按「開啟」；`claude -p` 與雲端代理不適用。

## 設定（userConfig）

| 欄位 | 說明 |
| --- | --- |
| `asn_cli_path` | ASN 安裝資料夾的 `asn-cli.exe` 完整路徑（ASN 設定頁「寄信指令」可複製）。**優先使用**。 |
| `send_mjs_path` | 沒設 asn-cli 時的退路：`relay/machine/send.mjs` 完整路徑（需要 node）。 |
| `node_path` | 跑 send.mjs 的 node 指令，預設 `node`。 |

兩個路徑都沒設，`asn_send` 會回「尚未設定」而不寄信。

## 第一期做了什麼

1. **`asn_send` 工具**（`isDeferred:false`，全名 `mcp__asn__asn_send`）：`to`／`room` 二選一、`body` 必填、寄給 `to` 時 `expects_reply`（boolean）必填，對應 `--reply`／`--no-reply`；`reply_to` 選填。實際是呼叫 `asn-cli send`（或 `node send.mjs`），所以 `replied/`、`sent/` 記號、寄件人判定、額度都照原本行為。回傳 stdout（`sent id=…`）或錯誤。**不會自動帶 reply_to**。
2. **Bash 守門**：命令裡有 `send.mjs`／`asn send`／`asn-cli send`，用了 `--to` 卻沒有 `--reply`／`--no-reply` → 拒絕並提示改用 asn_send。`--room` 不擋。
3. **本人簽章紅線（ASN#118）**：mod 寄出的信一律是成員身分。`asn_send` 組出的參數、Bash 寄信命令只要出現 `as_person`、`x-asn-user`、`--person`、`ASN_USER…`、`user_token` 之類字樣就擋。mod 不傳任何環境變數給子行程，也不讀任何金鑰檔（金鑰由 asn-cli／send.mjs 自己讀）。

## 狀態列未讀數（第一期還沒做，但唯讀查詢已備好）

`recv --once`／`--watch` 都會 ack，不能拿來輪詢。現在 asn-cli 有唯讀的 **`asn-cli recv --peek`**：列出本視窗目前未讀的信，一行 JSON `{"count":N,"messages":[{"id","from","at","preview"}]}`（preview 截 80 字），**不 ack、不改任何狀態、不寫記號**；加 `--count-only` 只輸出 `{"count":N}`。狀態列腳本可直接輪詢它。後端要先部署 `inbox_peek` 動作（migration `20261022030000_inbox_peek.sql`）；還沒部署時 asn-cli 會印中文錯誤並以結束碼 4 離開，這時狀態列就不要顯示數字。

## 限制

- Bash 守門以命令字串判斷（含 `--to` 且無 `--reply`／`--no-reply` 旗標字樣），內文剛好含有這些字樣會放行；這是提醒用的守門，不是安全邊界。
- 後續：第二期收件匣面板與身分段、第三期轉交改由 mod 收；詳見 #134。

## 開發

```
claude plugin validate relay/claude-mod
claude plugin test relay/claude-mod
```

純邏輯在 `hooks/lib.ts`，測試在 `hooks/asn.test.ts`。
