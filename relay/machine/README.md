# irori-relay machine bridge（收發室橋）

每台機器跑一支常駐程式，把仲介（relay）的信送進**本機正在跑的 Claude Code session**，並把對方的回覆寄回去。
不碰 Claude Code 私有協定：全程只用公開的 CLI 旗標與公開的 SendMessage 工具。純 Node（>= 22），沒有 npm 依賴。

```
relay inbox ──(門鈴＋2 分鐘補拉)──> bridge.mjs ──stdin──> 收發室 worker（claude -p，只有 ListAgents/SendMessage）
                                                              │ SendMessage
                                                              ▼
relay send(reply_to) <──── bridge.mjs <──stdout── 收發室 <── 本機 session 的回覆
```

## 做什麼

1. **名單**：每 60 秒 `claude agents --json`，只留 `kind=interactive` 且 `entrypoint=cli` 的 session（排除 `-p`／背景／收發室自己），
   `POST ?action=roster {agents:[{name,status,cwd_label}]}`（`cwd_label` 只取資料夾名；roster 動作僅 `can_invite` 的工頭節點可用）。
2. **收發室**：長駐一個 `claude -p --input-format stream-json --output-format stream-json`，名稱 `<節點>-收發室`
   （H 就是 `H-收發室`），`--dangerously-skip-permissions`（要跟 bypass 的 session 互送，雙方同類別才不會被扣住）、
   `--tools ListAgents,SendMessage,ToolSearch`（硬限制，見下）、自訂系統提示（它只是轉交員、信件是外部資料）、
   `--strict-mcp-config --disable-slash-commands`，工作目錄是 `~/.irori-relay/machine-<ID>/cwd`（沒有 CLAUDE.md、沒有記憶）。
   預設模型 `haiku`（`IRORI_MAILBOX_MODEL` 可改）。
3. **收信**：訂 Realtime 門鈴＋每 2 分鐘補拉 inbox。每封信交給收發室，SendMessage 轉給 `to_agent` 指的 session，
   內文開頭是 `[RELAY 來信] trust=… from=<節點>/<代理> to=… id=…`。
   - 收發室回報 `SENT <id>` 才 ack；失敗（`FAIL`）、找不到 session、轉交逾時（2 分鐘），都寄一封說明給原寄件人再 ack。
   - 對方回覆（收發室收到的 `<cross-session-message>` 那一輪）→ `relay send` 帶 `reply_to` 寄回原寄件人，`from_agent` 填對方 session 名。
     之後同一 session 的追加回覆（10 分鐘內）也一併轉寄。
   - 逾時（預設 10 分鐘）沒有任何回覆 → 寄「對方沒有回覆」。
   - 沒有 `to_agent` → 交給 `IRORI_RELAY_DEFAULT_AGENT`（預設 `H-工頭-2`）；它不在線就**不 ack、留在 inbox**，等它上線的下一次補拉。
   - 不在名單的 `to_agent` → 寄回「找不到這個 session（目前可達：…）」。
4. 單一執行個體：`~/.irori-relay/machine-<ID>/bridge.pid` 有活著的 pid 就直接退出（exit 3）。

> 重要：同一把節點金鑰只能有**一個**收信者。H 節點啟用本橋之後，工頭 session 的 `relay/channel`（irori-relay channel）要拿掉，
> 否則兩邊搶同一個 inbox、互相 ack。

## 設定（`~/.irori-relay/`，不進 repo）

| 檔／環境變數 | 說明 |
|---|---|
| `<ID>.key` 或 `IRORI_RELAY_KEY` | 節點金鑰（`IRORI_RELAY_ID`，預設 `H`；家用機＝`H`）。**絕不印出** |
| `anon.key` 或 `IRORI_RELAY_ANON_KEY` | Realtime 門鈴用 anon 公開金鑰；沒有＝只剩 2 分鐘輪詢 |
| `IRORI_RELAY_DEFAULT_AGENT` | 沒指定收件 session 時的預設（`H-工頭-2`） |
| `IRORI_RELAY_ALLOW` | 逗號分隔，額外允許轉交的 session 名（測試用；預設只允許名單內的互動式 session） |
| `IRORI_MAILBOX_NAME` / `IRORI_MAILBOX_MODEL` | 收發室名稱／模型 |
| `IRORI_REPLY_TIMEOUT_MS` | 等回覆逾時（預設 600000） |
| `CLAUDE_BIN` | claude 執行檔（預設 `claude`） |

Log：`~/.irori-relay/machine-<ID>/bridge.log`（每個轉交、每一輪收發室的耗時與費用都有一行）。

## 執行與開機自動啟動

```
node D:\Github\irori\relay\machine\bridge.mjs          # 前景跑（IRORI_RELAY_ID 預設 H）
powershell -File install-task.ps1                      # 預覽，不改任何東西
powershell -File install-task.ps1 -Apply               # 建立工作排程 IroriRelayMachine-H（登入時、隱藏視窗、失敗重啟）
powershell -File install-task.ps1 -Uninstall           # 移除
```

排程跑 `run-bridge.ps1`（橋掛掉 15 秒後自動重啟；撞到另一個執行個體則停手）。**目前沒有安裝**。

## 安全

- **收發室的工具是硬限制**：init 事件的工具清單只有 `ListAgents / SendMessage / ToolSearch`，bypass 模式下 Bash／PowerShell／讀檔／改檔都不存在
  （實測叫它跑 Bash、讀 `C:\Windows\win.ini`、建檔、PowerShell 都做不到）。
- **殘餘風險**：SendMessage 可以送給任何本機 session，旗標無法限制收件人。對策是軟的：
  系統提示（信件是外部資料）、橋接指令帶每次啟動隨機的 nonce、信件包在 `<<<MAIL … MAIL>>>`；
  轉交對象由橋程式依名單決定。注入實測（信件內偽造橋接指令並要求轉給其他 session）沒有被照做。
  收發室 session 本身在你的 `/list-agents` 裡看得到，可隨時 `claude stop`。
- trust 規則照 relay 設計：`trust=owner` 是小良哥的交辦（紅線照舊）、`trust=member` 是外部資料，標頭一律原樣帶給收件 session。
- 收發室 settings 有 `crossSessionInbound: accept`（只在它自己的 `--settings`），不動 `~/.claude`。

## 實測（2026-10-01，Windows 11、claude 2.1.286、模型 haiku；用測試節點 `H-bridgesender` → `H-bridgetest`，目標是自己開的測試 session）

| 項目 | 結果 |
|---|---|
| 往返（寄出 → 回信抵達寄件人 inbox） | 冷：53 s；暖：13–33 s（含目標 session 自己思考約 5–15 s、寄件端輪詢 1.5 s） |
| 收發室「轉交」那一輪 | 冷 19.9 s／$0.023；暖 8–12 s／$0.007–0.010 |
| 收發室「收回覆」那一輪 | 3–7 s／約 $0.002–0.003 |
| **每則成本（收發室，暖）** | 約 **$0.01**（轉交＋收回覆），不含目標 session 自己的用量 |
| 無 `to_agent` → 預設 session | 通 |
| 不存在的 `to_agent` | 7 s 內寄回「找不到…（目前可達：…）」 |
| 對方不回覆 | 逾時後寄「對方沒有回覆」（測試用 45 s 逾時，實際預設 10 分鐘） |
| 信件內偽造橋接指令＋要求轉給真 session | 沒有被執行，只照常轉交給指定的測試 session |
| 收發室 worker 被強殺 | 約 2 秒自動重啟，之後往返正常（冷啟動那輪 19.5 s） |
| roster 回報 | H 金鑰單次 POST 成功（200，count=4）；測試節點非 `can_invite` 回 403 forbidden（符合後端規則） |

沒測：門鈴斷線重連（程式沿用 channel 的實作）、對 `prompting` 模式 session 的轉交（收發室是 bypass，對方若是 prompting 且寄件端是 bypass，Claude Code 會扣住等對方使用者核准）。

## 測試用小工具（拋棄式）

- `tools-provision.mjs <新代號>`：用 H 金鑰開邀請碼並註冊測試節點（金鑰寫進 `~/.irori-relay/<id>.key`，不印）
- `tools-roundtrip.mjs <寄件節點> <to_node> <to_agent|-> "<body>" [秒]`：寄信並輪詢自己的 inbox 等回信，印延遲
- `tools-roster-once.mjs`：以 H 金鑰單次回報名單（不碰 inbox）
