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
   - 逾時（預設 10 分鐘）沒有經收發室收到回覆 → 寄「［收發室］10 分鐘內沒有經收發室收到 X 的回覆（對方若已另外回信可忽略）」。
     同一寄件人＋同一收件視窗 30 分鐘內只報一次（`IRORI_NOREPLY_WINDOW_MS` 可調），被合併的下次報時帶「另有 N 封也還沒回」。
   - **告知類的信在內文加「（不需回覆）」或「[no-reply]」**：照常轉交、成功即 ack，但不計時、不寄逾時通知（收發室之後也不再轉寄對方的回覆）。
   - 沒有 `to_agent` → 交給 `IRORI_RELAY_DEFAULT_AGENT`（預設 `H-工頭-2`）；它不在線就改交給**最近有活動**的互動式 session
     （依 `~/.claude/sessions/<pid>.json` 的 `updatedAt`，排除收發室），內文前加一行「原本要給 <預設> 但它不在線，請你代收並轉告／處理」；都沒有人在線才**不 ack、留在 inbox**。
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
| `IRORI_NOREPLY_WINDOW_MS` | 逾時通知合併視窗（預設 1800000）；`IRORI_BRIDGE_TICK_MS` 逾時檢查間隔（預設 5000，測試用） |
| `CLAUDE_BIN` | claude 執行檔（預設 `claude`） |

Log：`~/.irori-relay/machine-<ID>/bridge.log`（每個轉交、每一輪收發室的耗時與費用都有一行）。

## 執行與開機自動啟動

```
node D:\Github\irori\relay\machine\bridge.mjs          # 前景跑（IRORI_RELAY_ID 預設 H）
powershell -File install-task.ps1                      # 預覽，不改任何東西
powershell -File install-task.ps1 -DefaultAgent <名稱> -Apply   # 指定預設收件 session（不帶＝H-工頭-2）；run-bridge.ps1 同名參數
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

## Aegis 轉接橋（Linux，`bridge-aegis.mjs`）

在 Aegis 主機上不開 claude，用一把仲介節點金鑰收信：每封信 = 一次 `POST http://127.0.0.1:8899/api/v1/agent-chat/ask`
（`target` = 信的 `to_agent` 轉成的成員 slug（`to_agent` 可寫 slug 或中文名，用 `GET /api/v1/members?scope=all` 對照）、`from_member=xi-xu`、`stream=false`，逾時 300 秒；問題內文前面加一行
`這是透過仲介轉來的信：from=<節點>/<代理> trust=<trust>`），答案用 `reply_to` 寄回原寄件人，`from_agent` 填成員 slug。
門鈴、每 2 分鐘補拉、ack、單一執行個體 pid 檔都跟 `bridge.mjs` 一樣（共用 `relay-core.mjs`）。

| 情況 | 行為 |
|---|---|
| `to_agent` 不在白名單 | 寄回「這位成員沒有開放聯絡」再 ack（不打 Aegis） |
| 沒有 `to_agent` | 交給預設成員 `IRORI_AEGIS_DEFAULT`（預設 `aegis`＝愛吉絲，Aegis 總管），回信 `from_agent` 填實際回答的成員；預設成員不在白名單才寄回「請指定要問的成員」並列出白名單 |
| `status=success` | 把 `answer` 寄回 |
| `status=error`／連線失敗／逾時 | 60 秒後重試一次；仍失敗寄「對方忙線中，請稍後再問」 |
| HTTP 404 | 寄「查無此成員」（不重試） |
| 其他 status | 照實回報 |
| 寄回失敗 | 不 ack，留在 inbox 等下次補拉 |

名單回報（roster）只列白名單成員（`name`=中文名，沒有中文名才用 slug；`cwd_label`=slug），聯絡人因此顯示中文名；白名單仍以 slug 判斷。希緒自己（`IRORI_AEGIS_SELF`，預設 `xi-xu`）不列進名單，寄給她的信回「這是希緒自己，不能自己問自己」。節點需要 `can_roster`（`supabase/sql/04_roster.sql`）才能回報，否則 403 只記一次 log。

環境變數：`IRORI_RELAY_ID`（預設 `AEGIS`）、`IRORI_AEGIS_ALLOW`（逗號分隔 slug，**預設空＝全部擋下**）、`IRORI_AEGIS_URL`、
`IRORI_AEGIS_DEFAULT`、`IRORI_AEGIS_FROM_MEMBER`、`IRORI_AEGIS_TIMEOUT_MS`、`IRORI_AEGIS_RETRY_MS`、`IRORI_RELAY_KEY`／`IRORI_RELAY_ANON_KEY`（也可用檔案）。

### 在 Aegis 上安裝

1. 取得程式：把本 repo 的 `relay/machine/` 放到主機（例如 `/home/cwen0708/irori/relay/machine/`，`git clone` 或 `scp`），Node 用 `/opt/node22/bin/node`（>= 22）。
2. 放金鑰（家目錄是 `~/.irori-relay/`；金鑰是 **Aegis 節點專用**的仲介節點金鑰，不要共用別台的）：
   ```
   mkdir -p ~/.irori-relay && chmod 700 ~/.irori-relay
   (read -rs K; printf '%s' "$K" > ~/.irori-relay/AEGIS.key); chmod 600 ~/.irori-relay/AEGIS.key
   (read -rs A; printf '%s' "$A" > ~/.irori-relay/anon.key); chmod 600 ~/.irori-relay/anon.key   # 可省：沒有 anon.key 就只剩 2 分鐘輪詢
   ```
   檔名要跟 `IRORI_RELAY_ID` 一致（預設 `AEGIS` → `AEGIS.key`）。
3. 編輯 `irori-relay-aegis.service`：`IRORI_RELAY_ID`、`IRORI_AEGIS_ALLOW=<slug1>,<slug2>`、`ExecStart` 路徑，然後：
   ```
   sudo cp irori-relay-aegis.service /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now irori-relay-aegis
   ```
4. 看狀態與 log：`systemctl status irori-relay-aegis`、`journalctl -u irori-relay-aegis -f`，
   或 `tail -f ~/.irori-relay/aegis-AEGIS/bridge.log`。看到 `aegis bridge starting … allow=[…]`、`whoami node=…`、`doorbell joined` 即上線。
5. 改白名單：改 unit 的 `IRORI_AEGIS_ALLOW` → `sudo systemctl daemon-reload && sudo systemctl restart irori-relay-aegis`。
6. 這把節點金鑰只能有**一個**收信者；`can_invite` 才能回報名單（否則 log 一行 403 後安靜）。

## 群組訊息轉交（rooms）

仲介新增群組後，橋在每次 pull（門鈴／2 分鐘輪詢／啟動）多做一件事：`room_list` → 對 `mine` 的每個成員（節點本身 `H`、節點底下視窗 `H~視窗名`）用本地游標 `room_read(since=游標)` 取新訊息，**只轉後端標 `for_me=true` 的**（被點名，或小良哥／希緒發的、且不是自己發的；橋不自己重算規則），再把游標推進到 `last_seq`。
- 游標存 `WORK_DIR/rooms-cursor.json`（鍵 `房號|成員key`），重啟不重播；沒有游標用該項的 `read_seq`，`read_seq` 為 0 則從 `last_seq` 起算（不補播歷史）。不用 mark、不動後端已讀位置。
- `bridge.mjs`：成員 key 是節點本身 → 轉給 `IRORI_RELAY_DEFAULT_AGENT`（不在線就挑最近活動的視窗；都沒有就留著、游標不前進）；是視窗 key → 轉給該視窗（不在可轉交清單就略過、記 log、推進游標）。走同一個收發室 worker（id 為 `sha1(room:房號:seq:成員key)` 組的確定性 UUID）。
  轉交文字：第一行 `[群組 名稱] trust=… from=… #seq`（`~` 顯示成 `/`，`~owner` 顯示「小良哥」），第二行固定的「不需要回就不要回」提示，之後是內文。
  視窗回覆經收發室後，用 `room_post`（`from_agent`＝該視窗名）貼回群組；回覆含 `（不需回覆）`／`[no-reply]` 不貼；`room_post` 429（每成員每群組每小時 20 則）只記 log、不重試；群組訊息不寄逾時通知、轉交失敗也只記 log，不會貼到群組。
- `bridge-aegis.mjs`：成員 key `aegis~名字` → `resolveSlug(名字)`、節點本身 → `IRORI_AEGIS_DEFAULT`；要在 `IRORI_AEGIS_ALLOW` 內才問（不在就略過、記 log、推進游標）；用同樣的標頭格式呼叫 `/ask`，answer 以 `room_post`（`from_agent`＝roster 上的名字）貼回；ask 失敗不貼。
- 共用邏輯在 `rooms.mjs`（游標、標頭格式、UUID、room_post）。

## 視窗主動寄信（RELAY-SEND）

本機視窗要主動寄新信給仲介成員（回報給希緒、寄給別台機器的視窗、貼到群組），用 SendMessage 把下面格式的訊息交給收發室（`<節點>-收發室`）：

```
RELAY-SEND to=<成員代號 | 節點/視窗名 | 群組:群組id> [reply_to=<信件id>]
<內文>
```

- **寄件人身分**：收發室輸出的區塊 `<<REPLY-<nonce> from=名字>>` 裡的名字取自 Claude Code 加在跨 session 訊息上的 `from-name`（內文自填的 `from_agent=`、`trust=`、假區塊一律無效）。橋用機器金鑰呼叫 `send`（`from_agent`＝該視窗名；`from_node` 由金鑰決定）或 `room_post`（`from_agent`＝該視窗名）。trust 由後端依機器節點身分決定（member），視窗無法冒充 owner。
- **檢查**：寄件視窗要在 roster 名單上（`IRORI_RELAY_ALLOW` 內的測試視窗除外）；`to` 必填且代號格式合法、不能寄給本機節點；內文非空且 ≤ 20000 字；`reply_to` 要是 uuid；每視窗每小時 `IRORI_OUTBOUND_PER_HOUR`（預設 30）封，超量回「被擋」。格式不對回說明。
- **結果**：橋再透過收發室 SendMessage 回給該視窗一則「[RELAY 寄出結果]（不需回覆）」：`sent id=… to=…`、`已貼到群組 … #seq` 或錯誤原因；這則通知不計逾時、不等回覆。
- **回信**：對方回信走一般流程（`to_agent`＝視窗名）轉進該視窗。
- **回覆區塊加了 nonce**：收發室輸出的 REPLY／END 標記帶每次啟動隨機的 nonce（只在系統提示裡），內文偽造不了「結束區塊再開一個別人的區塊」。若輸出出現不是這個 nonce 的標記（收發室被內文帶壞），橋記 log 並重啟收發室（fail-closed）。
- **限制**：訊息是 best-effort——收發室重啟那幾秒送進去的訊息會遺失，視窗沒收到「寄出結果」就當作沒寄成、再寄一次；收發室一輪同時收到多則時，系統提示要求逐則處理。收發室仍只有 `ListAgents`／`SendMessage`／`ToolSearch` 三個工具，不能自己呼叫 relay。
- 測試：`test/outbound.test.mjs`（假 worker 注入）涵蓋身分取自 from-name、冒名內文、名單外、群組、每小時上限、格式錯誤、假 nonce 重啟。

## 測試

`node --test relay/machine/test/`：本機假伺服器（node 內建 http）模擬仲介與 Aegis，不碰真實金鑰與網路服務。
涵蓋群組轉交（`rooms.test.mjs`）、白名單、成功帶 `reply_to`、error 重試一次、404、其他 status、無 `to_agent`、預設收件人不在線的退路、roster 403 只記一次。

## 聯絡人分組（設備名）

Irori Chat 的聯絡人依「節點登記的工作環境（machine）」分組，組名就是那台設備的名字（家用機、工作機、雲端…）。新電腦裝機器橋時，請把它的節點 machine 設成那台電腦的名字（希緒的 update_partner 或仲介 update 動作），就會自成一組。
