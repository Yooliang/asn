# irori-relay machine bridge（收發室橋）

> **本機有 ASN 電腦版時，Claude 視窗改用 ASN 內建的命令列（不需要 Node）**：`asn send`／`asn recv`／`asn room`／`asn attach`
> （Windows 為 ASN 安裝資料夾裡的 `asn-cli.exe`，設定頁「寄信指令」可複製完整路徑；原始碼在 `relay/asn/src-tauri/src/cli/`，設計見 `docs/design/BRIDGE-RUST.md` 第四段）。
> 參數、結束碼、輸出格式、`replied/`／`sent/` 記號都與下面的 Node 版相同。**這裡的 Node 版保留給雲端代理與沒有 ASN 的 Linux 無畫面節點。**

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
   `--strict-mcp-config --disable-slash-commands`，工作目錄是 `~/.asn/machine-<ID>/cwd`（沒有 CLAUDE.md、沒有記憶）。
   預設模型 `haiku`（`ASN_MAILBOX_MODEL` 可改）。
3. **收信**：訂 Realtime 門鈴＋每 2 分鐘補拉 inbox。每封信交給收發室，SendMessage 轉給 `to_agent` 指的 session，
   內文開頭是 `[RELAY 來信] trust=… from=<節點>/<代理> to=… id=… engine=… reply=yes|no|?`（`reply=` 是寄件人明說的「要不要回信」：yes 在等回信、no 只是告知不用回、? 是舊信沒說）。
   - 收發室回報 `SENT <id>` 才 ack；失敗（`FAIL`）、找不到 session、轉交逾時（2 分鐘），都寄一封說明給原寄件人再 ack。
   - 對方回覆（收發室收到的 `<cross-session-message>` 那一輪）→ `relay send` 帶 `reply_to` 寄回原寄件人，`from_agent` 填對方 session 名。
     之後同一 session 的追加回覆（10 分鐘內）也一併轉寄。
   - **不再通知寄件人「沒有回覆」**（小良哥 10/22 裁示：寄件人看已讀狀態就知道）。逾時（預設 10 分鐘）沒收到回覆，只是把這封信轉成「等遲到回覆」並記 log
     `reply wait over id=… -> 收件視窗: no notice to sender`；已經回了（`replied/<id>` 記號）或收件視窗在轉交後寄過信給原寄件人（`sent/` 記號）就直接清掉，也記 log。
   - **收件視窗提醒**：`reply=yes` 的信轉交後 `ASN_NUDGE_MS`（預設 5 分鐘）還沒回、收件視窗狀態是 `idle` → 提醒收件視窗一次：
     `（收發室提醒）你還沒回覆 <寄件人說明> 的信 <信件id>，若已處理完請用 asn_send 寄回結果`（log `nudged window`）。忙碌（或狀態不是 idle，例如使用者正在打字）不插話，下一輪再看；已回覆就不提醒；`reply=no` 的信、收發室系統信不提醒。
   - **來信信頭**：第一行機器可讀（回信位址 `from=` 本人是 `u:xxxxxxxxxxxx`，其他是 `節點/視窗名`），第二行 `寄件人：…` 說明，`reply=yes` 的信（收件是 Claude 視窗）第三行 `【要回信】…`。格式固定，規格見 `docs/design/MAIL-HEADER.md`。
   - **遲到的回覆不會被丟掉**：逾時後這封信的對應仍保留 `ASN_LATE_KEEP_MS`（預設 24 小時），最多 `ASN_LATE_MAX`（預設 200）筆（超過清最舊）；
     期間對方經收發室回覆，照常（原文，不加說明）寄回原寄件人，寄回後清掉。同一視窗有還在等的信時，回覆先對給還在等的，沒有才對給保留中的（先進先出）。
   - **對應表跨重啟（`WORK_DIR/pending.json`）**：還在等回覆、已通知「沒回」的信（含群組訊息）的對應，每次變動就原子寫入（先寫暫存檔再 rename），只存信件 id、寄件節點／視窗、收件視窗、時間、狀態、群組資訊，**不存信件內文**。橋啟動時載回並清掉超過 `ASN_LATE_KEEP_MS` 的；檔案損毀就忽略（log 記 `pending.json unreadable, ignored`）並重新開始。所以更新程式、改設定而重啟橋，長任務視窗之後才到的回覆仍會寄回。
   - **對不上的回覆轉給最近交辦者**：收發室另記每個視窗「最近一次交辦它的寄件人」（`lastRequester`，同存於 pending.json，保留同樣的期限；「不需回覆」信與收發室系統信不算）。視窗的回覆找不到對應的信時（例如長任務每小時回一則進度），若 24 小時內有這位寄件人，就寄給他（`reply_to` 用那封最近的信 id，內文前加「（收發室：這則回覆對不上特定來信，依最近一次交辦轉給你）」，log 記 `-> last requester`）；沒有才丟棄，log 寫 `dropped: no pending mail and no requester…`。
   - **更新 send.mjs 時，每台機器的橋也要 `git pull` 並重啟**（`git pull` 兩個檔一起換，但正在跑的舊橋行程要重啟才換新）：新 send.mjs 的 `--no-reply` 不在內文留標記，還在跑舊橋（只看內文）的機器會對只是告知的信誤報「沒有收到回覆」。
   - **視窗主動寄信（代寄）**：本機視窗用 SendMessage 傳給收發室（例如 `w02-收發室`），第一行寫 `[RELAY 寄信] to=<節點>[/<視窗>] reply=yes|no`（`[RELAY 回信]` 同義；加 ` re=<信件id>` 就是回那一封；`reply=` **必填**：yes＝在等回信、no＝只是告知；沒寫就不寄，收發室會通知寄件視窗補上，log `refused`），下面接內文。收發室把它當一封新信寄出，寄件人是這個視窗（名字取自 Claude Code 標記的 from-name，視窗無法冒名）。沒有這行頭的訊息照舊當回覆處理（對不上來信也沒有最近交辦者就丟棄）。`send.mjs` 照樣可用。
   - **要不要回信是信件的獨立欄位 `expects_reply`**（SQL 23；寄件人用 `send.mjs --reply`／`--no-reply`、代寄 `reply=yes|no` 明說，不往內文加標記）。`false`（只是告知）：照常轉交、成功即 ack，但不計時、不寄逾時通知（收發室之後也不再轉寄對方的回覆）；`true`：計時。欄位有值就**只看欄位**；欄位是 null（舊版寄件工具、舊信）才退回看內文的「（不需回覆）」「[no-reply]」（過渡期相容，之後拿掉）。逾時提醒（timeout／busy）結尾會提示「只是告知的信，寄件時用 --no-reply（代寄寫 reply=no）就不會提醒」。acp 轉接器（Gemini 工作者）用同一條規則決定要不要把回覆寄回。
   - **寄件人是收發室**（`from_agent` 以「收發室」結尾，即任何節點的 `<節點>-收發室`）的系統信：比照告知類，照常轉交、不計時、不寄逾時通知；轉交失敗／找不到視窗的說明也不回給收發室（只記 log），避免兩台收發室互相丟信。
   - 沒有 `to_agent` → 只有設定了 `ASN_RELAY_DEFAULT_AGENT` 而且那個視窗在線，才交給它（內文前加一行「這封信沒有指定收件視窗，依設定交給你處理」）；
     否則**不 ack、留在 inbox**，等 ASN 視窗的本人處理，不再丟給隨便一個 session。
     （依 `~/.claude/sessions/<pid>.json` 的 `updatedAt`，排除收發室），內文前加一行「原本要給 <預設> 但它不在線，請你代收並轉告／處理」；都沒有人在線才**不 ack、留在 inbox**。
   - 不在名單的 `to_agent` → 寄回「找不到這個 session（目前可達：…）」。
4. 單一執行個體：`~/.asn/machine-<ID>/bridge.pid` 有活著的 pid 就直接退出（exit 3）。

> 重要：同一把節點金鑰只能有**一個**收信者。H 節點啟用本橋之後，工頭 session 若還掛著已封存的 channel 外掛（`archive/relay-channel/`）要拿掉，
> 否則兩邊搶同一個 inbox、互相 ack。

## 設定（`~/.asn/`，不進 repo）

使用者資料夾一律經 `home.mjs` 的單一解析函式（#14 第二期）：環境變數 `ASN_HOME`（舊名 `IRORI_HOME`）→ `~/.asn` → 舊的 `~/.irori-relay`。兩邊都在時，舊資料夾若是連結（遷移完成後的相容連結）或空的就用 `~/.asn`；若是有內容的真資料夾（還沒遷移），就先用舊的、新的當後備。獨立橋不主動遷移，遷移由 ASN 電腦版啟動時做（見 `docs/design/ONBOARDING.md` 第 9.4 節 R2）。

環境變數已改為 **`ASN_` 前綴**（`docs/design/ONBOARDING.md` 第 5 節，#14 第一期）。舊名 `IRORI_<名>` 照樣能用：新名優先，沒設（或只有空白）才讀舊名，兩個都設以新名為準（`env-compat.mjs` 的 `envGet`）。橋交給子程序的環境，已改名的變數兩個名字都帶，金鑰（`ASN_RELAY_KEY`／`ASN_RELAY_ANON_KEY` 與舊名）新舊名都擋。資料夾 `~/.asn/` 本期不搬。Aegis 轉接橋專用的 `IRORI_AEGIS_*` 不改名。

| 檔／環境變數 | 說明 |
|---|---|
| `<ID>.key` 或 `ASN_RELAY_KEY` | 節點金鑰（`ASN_RELAY_ID`，預設 `H`；家用機＝`H`）。**絕不印出** |
| `anon.key` 或 `ASN_RELAY_ANON_KEY` | Realtime 門鈴用 anon 公開金鑰；沒有＝只剩 2 分鐘輪詢 |
| `ASN_RELAY_DEFAULT_AGENT` | 沒指定收件 session 時交給哪個視窗（預設空＝不交給任何 session，信留在 inbox 給 ASN 視窗的本人） |
| `ASN_RELAY_ALLOW` | 逗號分隔，額外允許轉交的 session 名（測試用；預設只允許名單內的互動式 session） |
| `ASN_MAILBOX_NAME` / `ASN_MAILBOX_MODEL` | 收發室名稱／模型 |
| `ASN_REPLY_TIMEOUT_MS` | 等回覆逾時（預設 600000） |
| `ASN_ROOM_STAGGER_MS` | 群組同時叫醒多位 AI 的順位延遲間隔（毫秒，預設 60000，0＝關閉；內建橋）；見 docs/design/HUMANS-AND-GROUPS.md 2.7.1 |
| `ASN_NUDGE_MS` | 轉交後多久還沒回就提醒收件視窗一次（預設 300000＝5 分鐘）；`ASN_BRIDGE_TICK_MS` 逾時檢查間隔（預設 5000，測試用） |
| `ASN_LATE_KEEP_MS` / `ASN_LATE_MAX` | 逾時後，保留信件對應以便寄回遲到回覆的時間（預設 86400000＝24 小時）／最多筆數（預設 200） |
| `CLAUDE_BIN` | claude 執行檔（預設 `claude`） |

Log：`~/.asn/machine-<ID>/bridge.log`（每個轉交、每一輪收發室的耗時與費用都有一行）。

## 執行與開機自動啟動

```
node <ASN 原始碼>\relay\machine\bridge.mjs          # 前景跑（ASN_RELAY_ID 預設 H）
powershell -File install-task.ps1                      # 預覽，不改任何東西
powershell -File install-task.ps1 -DefaultAgent <名稱> -Apply   # 指定預設收件 session（不帶＝不指定，信留給 ASN 視窗的本人）；run-bridge.ps1 同名參數
powershell -File install-task.ps1 -Apply               # 建立工作排程 AsnBridge-H（舊安裝的 IroriRelayMachine-H 重建時會被移除）（登入時、隱藏視窗、失敗重啟）
powershell -File install-task.ps1 -Uninstall           # 移除
```

排程用 `conhost.exe --headless` 跑 `run-bridge.ps1`（沒有視窗，不會被誤關；橋掛掉 15 秒後自動重啟；撞到另一個執行個體則停手）。**目前沒有安裝**。

### 自己更新、自己重啟（`self-update.mjs`，小良哥 10/06）

收發室不用再靠別的 AI 幫它更新重啟（那個 AI 又得靠收發室傳指令，會互相卡住）：

- 橋每 10 分鐘（`ASN_SELF_UPDATE_MS`，`0`＝關掉；有設 `ASN_RELAY_URL` 指向別的 relay 時預設關，測試的橋不會去拉真的 repo）到 `origin/main` 看 `relay/machine/` 有沒有新版。
- **只在安全時才拉**：工作樹乾淨（追蹤中的檔沒改）、在 `main`、沒有沒推的本機 commit，才用 fast-forward 拉；否則跳過並在 `bridge.log` 記一行 `self-update skip: …`。只有別的目錄有新 commit 不動（那是開發視窗的事）。
- 拉好之後：不再收新信（留在信箱），等手上「轉交中」的信送完（最多 5 分鐘），停掉收發室與工作者再結束；`run-bridge.ps1` 15 秒後用新版重啟。等回信的對應表本來就存在 `pending.json`，重啟後接著等。
- **孤兒程序**：橋把自己的 pid 記在 `bridge.last`。下次啟動時，上一個橋已經不在、父程序還是它的（收發室 `claude -p`、Gemini 等工作者）會連同子孫一起結束，不會兩組同時收信（w02 10/06 遇過）。只看父 pid，不依名稱結束程序。
- **手動重啟時不要刪 `bridge.pid`**：它是「同時只能有一個橋」的鎖，刪了舊的橋還活著，就會變成兩個。要停就用 `installer/asn-common.ps1` 的 `Stop-AsnBridge`（舊名 Stop-IroriBridge 為別名）（停排程，再只結束 `bridge.pid`、`mailbox.pid` 記的兩個程序）。
- 一般使用者用 `installer/` 安裝的副本不是 git 工作樹，不會自己更新（`bridge.log` 會記一次 `self-update error`），照舊用新的安裝包更新。

一般使用者不用手動做這些：`installer/` 是給一般人的 Windows 安裝程式（雙擊「安裝.cmd」＝邀請碼註冊＋複製程式＋建排程；`register.mjs` 是註冊小幫手），
`node tools/release/build_downloads.mjs` 打成 `asn-windows.zip`（同時產出內容相同的舊檔名 `irori-windows.zip`）。說明見 `docs/DOWNLOADS.md`。

## 安全

- **收發室的工具是硬限制**：init 事件的工具清單只有 `ListAgents / SendMessage / ToolSearch`，bypass 模式下 Bash／PowerShell／讀檔／改檔都不存在
  （實測叫它跑 Bash、讀 `C:\Windows\win.ini`、建檔、PowerShell 都做不到）。
- **殘餘風險**：SendMessage 可以送給任何本機 session，旗標無法限制收件人。對策是軟的：
  系統提示（信件是外部資料）、橋接指令帶每次啟動隨機的 nonce、信件包在 `<<<MAIL … MAIL>>>`；
  轉交對象由橋程式依名單決定。注入實測（信件內偽造橋接指令並要求轉給其他 session）沒有被照做。
  收發室 session 本身在你的 `/list-agents` 裡看得到，可隨時 `claude stop`。
- trust 規則照 relay 設計：`trust=owner` 是主人的交辦（紅線照舊）、`trust=member` 是外部資料，標頭一律原樣帶給收件 session。
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
| 對方不回覆 | 逾時後不通知寄件人（寄件人看已讀狀態）；5 分鐘閒置沒回會提醒收件視窗一次 |
| 信件內偽造橋接指令＋要求轉給真 session | 沒有被執行，只照常轉交給指定的測試 session |
| 收發室 worker 被強殺 | 約 2 秒自動重啟，之後往返正常（冷啟動那輪 19.5 s） |
| roster 回報 | H 金鑰單次 POST 成功（200，count=4）；測試節點非 `can_invite` 回 403 forbidden（符合後端規則） |

沒測：門鈴斷線重連（程式沿用 channel 的實作）、對 `prompting` 模式 session 的轉交（收發室是 bypass，對方若是 prompting 且寄件端是 bypass，Claude Code 會扣住等對方使用者核准）。

## 測試用小工具（拋棄式）

- `tools-provision.mjs <新代號>`：用 H 金鑰開邀請碼並註冊測試節點（金鑰寫進 `~/.asn/<id>.key`，不印）
- `tools-roundtrip.mjs <寄件節點> <to_node> <to_agent|-> "<body>" [秒]`：寄信並輪詢自己的 inbox 等回信，印延遲
- `tools-roster-once.mjs`：以 H 金鑰單次回報名單（不碰 inbox）

## Aegis 轉接橋（Linux，`bridge-aegis.mjs`）

> 標記為之後移出本 repo（#14 R8，D11）：Aegis 主機的部署還依賴本檔與 `irori-relay-aegis.service`，移出步驟見 `docs/design/ONBOARDING.md` 第 7.5 節；移出前不要刪、不要改名。

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

名單回報（roster）只列白名單成員（`name`=中文名，沒有中文名才用 slug；`cwd_label`=slug），聯絡人因此顯示中文名；白名單仍以 slug 判斷。Aegis 主機轉接橋自己的成員（`IRORI_AEGIS_SELF`，預設 `xi-xu`，Irori 生態專用）不列進名單，寄給它的信會被擋回。節點需要 `can_roster`（`supabase/sql/04_roster.sql`）才能回報，否則 403 只記一次 log。

環境變數：`ASN_RELAY_ID`（預設 `AEGIS`）、`IRORI_AEGIS_ALLOW`（逗號分隔 slug，**預設空＝全部擋下**）、`IRORI_AEGIS_URL`、
`IRORI_AEGIS_DEFAULT`、`IRORI_AEGIS_FROM_MEMBER`、`IRORI_AEGIS_TIMEOUT_MS`、`IRORI_AEGIS_RETRY_MS`、`ASN_RELAY_KEY`／`ASN_RELAY_ANON_KEY`（也可用檔案）。

### 在 Aegis 上安裝

1. 取得程式：把本 repo 的 `relay/machine/` 放到主機（例如 `/home/<使用者>/asn/relay/machine/`，`git clone` 或 `scp`），Node 用 `/opt/node22/bin/node`（>= 22）。
2. 放金鑰（家目錄是 `~/.asn/`；金鑰是 **Aegis 節點專用**的仲介節點金鑰，不要共用別台的）：
   ```
   mkdir -p ~/.asn && chmod 700 ~/.asn
   (read -rs K; printf '%s' "$K" > ~/.asn/AEGIS.key); chmod 600 ~/.asn/AEGIS.key
   (read -rs A; printf '%s' "$A" > ~/.asn/anon.key); chmod 600 ~/.asn/anon.key   # 可省：沒有 anon.key 就只剩 2 分鐘輪詢
   ```
   檔名要跟 `ASN_RELAY_ID` 一致（預設 `AEGIS` → `AEGIS.key`）。
3. 編輯 `irori-relay-aegis.service`：`ASN_RELAY_ID`、`IRORI_AEGIS_ALLOW=<slug1>,<slug2>`、`ExecStart` 路徑，然後：
   ```
   sudo cp irori-relay-aegis.service /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now irori-relay-aegis
   ```
4. 看狀態與 log：`systemctl status irori-relay-aegis`、`journalctl -u irori-relay-aegis -f`，
   或 `tail -f ~/.asn/aegis-AEGIS/bridge.log`。看到 `aegis bridge starting … allow=[…]`、`whoami node=…`、`doorbell joined` 即上線。
5. 改白名單：改 unit 的 `IRORI_AEGIS_ALLOW` → `sudo systemctl daemon-reload && sudo systemctl restart irori-relay-aegis`。
6. 這把節點金鑰只能有**一個**收信者；`can_invite` 才能回報名單（否則 log 一行 403 後安靜）。

## 群組訊息轉交（rooms）

仲介新增群組後，橋在每次 pull（門鈴／2 分鐘輪詢／啟動）多做一件事：`room_list` → 對 `mine` 的每個成員（節點本身 `H`、節點底下視窗 `H~視窗名`）用本地游標 `room_read(since=游標)` 取新訊息，**只轉後端標 `for_me=true` 的**（被點名，或帳號擁有者本人發的、且不是自己發的；橋不自己重算規則），再把游標推進到 `last_seq`。
- 游標存 `WORK_DIR/rooms-cursor.json`（鍵 `房號|成員key`），重啟不重播；沒有游標用該項的 `read_seq`，`read_seq` 為 0 則從 `last_seq` 起算（不補播歷史）。不用 mark、不動後端已讀位置。
- `bridge.mjs`：成員 key 是節點本身 → 只轉給 `ASN_RELAY_DEFAULT_AGENT`（沒設或不在線就留著、游標不前進，不丟給別的視窗）；是視窗 key → 轉給該視窗（不在可轉交清單就略過、記 log、推進游標）。走同一個收發室 worker（id 為 `sha1(room:房號:seq:成員key)` 組的確定性 UUID）。
  轉交文字：第一行 `[群組 名稱] trust=… from=… #seq`（`~` 顯示成 `/`，`~owner` 顯示主人的名字（沒帶名字就顯示「主人」）），第二行固定的「不需要回就不要回」提示，之後是內文。
  視窗回覆經收發室後，用 `room_post`（`from_agent`＝該視窗名）貼回群組；回覆含 `（不需回覆）`／`[no-reply]` 不貼；`room_post` 429（每成員每群組每小時 20 則）只記 log、不重試；群組訊息不寄逾時通知、轉交失敗也只記 log，不會貼到群組。
- `bridge-aegis.mjs`：成員 key `aegis~名字` → `resolveSlug(名字)`、節點本身 → `IRORI_AEGIS_DEFAULT`；要在 `IRORI_AEGIS_ALLOW` 內才問（不在就略過、記 log、推進游標）；用同樣的標頭格式呼叫 `/ask`，answer 以 `room_post`（`from_agent`＝roster 上的名字）貼回；ask 失敗不貼。
- 共用邏輯在 `rooms.mjs`（游標、標頭格式、UUID、room_post）。
- 轉交時（只有 `bridge.mjs`）在內文最後附「前面 5 則」當上下文（`rooms.context()`：`room_read` 帶 `since=seq-6&limit=5`，只讀；讀失敗就不附、照常轉交）與往回翻的指令。

### 視窗主動查群組：asn-room（`room.mjs`；舊稱 irori-room）

橋只轉 for_me 的訊息；視窗要看別人之間的對話、往回翻前後文，自己跑：
```
node room.mjs --rooms                                        # 我（節點~視窗名）在的群組、新訊息數、最後一則
node room.mjs --room-read <群組id|群組名> [--last 20 | --since <seq>] [--json]
```
- 身分跟 send.mjs／recv.mjs 同一套（`identity.mjs`，父行程鏈／環境變數備援，不能自填）；只列、只讀自己是成員的群組（本機先擋，仲介 403 也擋）。
- **只讀**：`room_read` 一律帶 `since`（仲介在沒帶 since 時會推進已讀），不帶 `mark`；不動後端已讀、不動橋的 `rooms-cursor.json`。
- 新訊息數用本機 `machine-<節點>/room-seen.json`（每次 `--room-read` 讀到哪記到哪），含自己發的；沒讀過就從加入時算。
- 不需要改仲介、不需要部署 Edge Function。
- exit code：1 用法、2 認不出視窗、3 不是成員／找不到群組、4 後端錯誤。測試：`test/room.test.mjs`。

## 視窗主動寄信：asn-send（`send.mjs`；舊稱 irori-send）

本機任何 Claude 視窗要主動寄信（回報給別人、寄給別台機器的視窗、貼到群組），用 Bash 直接跑 CLI，**不經收發室、不經任何模型、不花額度**（收信仍靠橋，回信照舊由橋經收發室轉進該視窗）。
用 `--reply-to` 直接回某封信、寄成功後，會在 `machine-<節點>/replied/<信件id>` 留記號；橋看到就不再對那封寄「10 分鐘內沒有經收發室收到回覆」（2026-10-02 收件的人把真回信和這則通知一起轉述成「沒回」，使用者因此連問三次）。記號留一天。
另外每次寄給節點／視窗（不論有沒有 `--reply-to`）也會在 `machine-<節點>/sent/<雜湊>` 留「誰寄給誰」的記號，橋據此判斷「對方已直接寄信給原寄件人」（檔名由 `sent-mark.mjs` 產生，send 與橋共用）：

```
node <ASN 原始碼>/relay/machine/send.mjs --to PC1 --body "內文" --reply|--no-reply [--reply-to <信件id>]
node <ASN 原始碼>/relay/machine/send.mjs --to W/W-政策 --body-file msg.txt --no-reply   # 節點/視窗名
node <ASN 原始碼>/relay/machine/send.mjs --room <群組id> --body "內文"            # 貼到群組（room_post）
echo 內文 | node send.mjs --to PC1 --body - --reply                                 # 內文從 stdin 讀
node send.mjs --to PC1 --file 報告.pdf --file 圖.webp --body "說明" --no-reply        # 寄檔案／照片
```

**寄附件（`--file <路徑>`，可重複，一封至多 4 個，`--to`、`--room` 都能用）**：共用邏輯在 `attach-upload.mjs`（對應下載端 `attach-download.mjs`），規則同 `docs/ATTACHMENTS.md` 與 `supabase/functions/_shared/attachments.ts`。
- **照片只收已經是 webp 的**（檔頭 `RIFF….WEBP`、≤ 5 MB，位元組原樣上傳，不縮放、不帶縮圖）。Node 沒有影像函式庫、也不加原生依賴，所以不轉檔：png／jpg／gif 等會被明確拒絕並提示先轉 webp（它們不在一般檔案白名單，不會被當檔案混進去）；要自動轉請用 ASN 電腦版寄。
- 一般檔案：副檔名在白名單（pdf、txt、md、json、csv、zip、docx、xlsx、pptx）、內容檔頭要對得上（`%PDF-`、`PK`、文字檔不含 NUL）、≤ 25 MB；exe、bat、ps1、sh、js 等一律擋。
- 內文可省略：只有附件時，內文是每個附件一行 `〔照片〕檔名`／`〔檔案〕檔名`；有 `--body` 就把說明接在後面。
- 順序：本機全部檢查完（不碰網路）→ 認呼叫者、計次 → 逐個 `attach_init`、`PUT`、`attach_commit` → 全部成功才 `send`／`room_post`（帶 `attachment_ids`）。超過上限、白名單外、內容不符、第 5 個在本機就 exit 1；上傳或確認失敗、後端拒收（額度、型別、舊後端不支援）exit 4；兩種情況都不寄信。上傳網址必須與收發室同一主機，錯誤訊息不含簽名網址。
- 收的人用 `attach.mjs --id <編號>` 下載。測試：`test/send-attach.test.mjs`（假後端模擬 attach_init／上傳／commit／send）。

**寄給成員／視窗（含回信）一定要二選一**：`--reply`＝我在等回信、`--no-reply`＝只是告知；都沒給就不寄（exit 1：「請說明要不要回信：等對方回就加 --reply，只是告知就加 --no-reply」），兩個都給也報錯。結果以 `expects_reply` 欄位送後端，**內文一字不動**。`--room` 群組不計時，給了會忽略（印一行說明）。

輸出 `sent id=… to=… from=節點/視窗名`（群組：`posted room=… seq=…`）；錯誤印到 stderr。exit code：0 成功、1 用法或內容不合、2 認不出呼叫者、3 超量、4 後端錯誤。

- **機器金鑰**：用橋同一把 `~/.asn/<節點>.key`；節點代號依序取 `ASN_RELAY_ID`、`~/.asn/node`（一行節點代號）、橋正在跑的 `machine-<ID>`（`bridge.pid` 的程序還活著）、唯一有 `<ID>.key` 的 `machine-<ID>` 資料夾；仍不唯一就報錯並列出候選（這時在 `~/.asn/node` 寫一行節點代號即可，家用機＝`H`）。`from_node` 由金鑰決定，trust 由後端決定（member）。
- **寄件視窗名不能自填**：CLI 沿父行程鏈往上，找第一個在 `~/.claude/sessions/<pid>.json` 有登記的 claude 程序，用它的 `name` 當 `from_agent`。（行程鏈用 Windows PID，Git Bash／PowerShell／cmd 的中間層都在鏈上，實測兩種殼都認得。）若鏈斷了（`nohup`／背景化後父行程已消失的孤兒行程），改用 Claude Code 匯出給 Bash 指令的 `CLAUDE_CODE_MESSAGING_SOCKET`，對上某個還活著的 session 的 `messagingSocketPath` 才算；獨立啟動的程式兩者都沒有。實例：I-Irori-2 的 Bash 工具外層包了 `timeout.exe`，行程鏈斷在那裡，靠這個環境變數備援才認出視窗（實寄成功，`from=H/I-Irori-2`）。**除錯**：`node send.mjs --whoami` 不寄信，印出父行程鏈（Windows PID＋名稱）、每個 session 的 pid／name 對照、環境變數備援結果與節點判定。沒有 `--from-agent` 之類參數；內文、環境變數裡寫的名字無效。找不到（不是在 Claude 視窗裡跑、父行程已結束的孤兒行程、視窗沒有名字）就拒絕、不打後端。
  這擋的是「本機非 Claude 程式隨手冒用」，不是同一個 Windows 使用者的惡意程式（它拿得到金鑰檔，本來就能直接打後端）。
- **檢查**：`--to` 與 `--room` 二選一；成員代號格式合法；可以寄給本機其他視窗（含 ASN；信經後端回到本機橋，照一般信轉交，視窗有自己收信的心跳就由它自己拉），只擋「寄給自己這個視窗」；內文非空且 ≤ 20000 字；`--reply-to` 要是 uuid；每視窗每小時 `ASN_SEND_PER_HOUR`（預設 30）封，記在 `~/.asn/send-rate.json`（超量 exit 3 並說明幾分鐘後可再寄）。
- 判定呼叫者要讀一次行程表（Windows 用 PowerShell `Get-CimInstance`，約 0.6 秒）；整個指令約 1–2 秒。
- 實作注意：結束時不呼叫 `process.exit()`（Windows 上 node 偶爾在關閉 handle 時 assertion 當掉），改設 `process.exitCode`。

## 視窗自己收信：asn-recv（`recv.mjs`，#84；舊稱 irori-recv）

仲介信箱是「一台機器一個節點」，橋收信後經收發室（`claude -p`，每封約 1 美分、多一層）轉給視窗。視窗也可以**自己收**寄給自己的信，不經收發室、不經模型：

```
node <ASN 原始碼>/relay/machine/recv.mjs --watch    # 長駐；掛在 Claude Code 的 Monitor 上，每封信一行 JSON 就是一則通知
node <ASN 原始碼>/relay/machine/recv.mjs --once     # 拉一次、印出、ack、結束
```

每行 JSON：`{id, trust, from_node, from_agent, to_agent, reply_to, created_at, expects_reply, body}`（`expects_reply`：true 要回、false 只是告知、null 舊信沒說）；回信用 `send.mjs --to <from_node>/<from_agent> --reply-to <id> --body "…" --reply|--no-reply`。診斷只印 stderr。exit code：1 用法、2 認不出視窗、3 這個視窗已有另一個 `--watch` 在跑、4 後端錯誤。

- **只收寄給自己的信**：視窗名用和 `send.mjs` 同一套判定（`identity.mjs`：父行程鏈／`CLAUDE_CODE_MESSAGING_SOCKET`，不能自填）。仲介 `inbox`／`ack` 帶 `agent=<視窗名>` 時只回／只 ack `to_agent` 精確等於該視窗名的信（`supabase/sql/08_agent_inbox.sql`）：A 視窗 ack 不到 B 視窗的信，`to_agent` 為空的總機信也碰不到（仍由橋處理）。recv 收到後端回來的信還會再比一次 `to_agent`，不是自己的不印、不 ack（對還沒部署新版仲介也安全）。
- **與橋並存（心跳）**：`--watch` 每 30 秒在 `~/.asn/machine-<節點>/self-recv/<視窗名>.json` 寫 `{pid, name, t}`。橋轉交 `to_agent` 為某視窗的信前先看這個檔：心跳在 90 秒內**且** pid 還活著 → 橋跳過（不轉、不 ack，留給視窗自己拉，log 印 `window receives by itself`）；心跳過期、pid 已死或沒有檔 → 照舊經收發室轉交，所以 Monitor 被關掉最多 90 秒後橋就接手，不會漏信。極窄的競態（心跳剛好過期那一刻橋轉交、視窗同時又啟動）可能重複一封。沒指定視窗的總機信、群組訊息（rooms）、Aegis 橋不受影響，仍照舊。
- 收信走 Realtime 門鈴＋每 2 分鐘輪詢（`ASN_RECV_POLL_MS`）；門鈴需要 `~/.asn/anon.key`，沒有就只輪詢。同一視窗只留一個 `--watch`；視窗本體結束它也會自己結束並清心跳。
- **上線順序**：先在 Supabase 跑 `supabase/sql/08_agent_inbox.sql`，再部署 `irori-relay`，各機器同步程式後**重啟橋**（橋要換成新版才看得懂心跳；舊橋照舊全轉，視窗會收到重複信）。

## 收發室回覆區塊的 nonce

收發室輸出的 REPLY／END 標記帶每次啟動隨機的 nonce（只在它的系統提示裡），內文偽造不了「結束區塊再開一個別人的區塊」。若輸出出現不是這個 nonce 的標記（收發室被內文帶壞，會沿用內文裡的假編號），橋記 log 並重啟收發室（fail-closed）。測試：`test/nonce.test.mjs`；CLI 測試：`test/send.test.mjs`（用 `test/fake-window.mjs` 假裝 claude 視窗）。

## 遠端開 Claude 視窗（`launcher.mjs`，#64，規劃見 docs/relay/LAUNCHER.md）

使用者在 Irori Chat「聯絡人」分頁對某台電腦按「＋ 開新視窗」→ 仲介記一筆 launch 並敲門鈴 → 橋 `launch_pending` 取走 → 照**本機** launcher.json 開視窗 → `launch_result` 回報。
- 設定：`~/.asn/launcher.json`（不進 repo；範本 `launcher.example.json`；`ASN_LAUNCHER_FILE` 可改路徑）。沒有這個檔＝這台不能遠端開視窗（名單回報 `launcher: null`，手機上不出現按鈕）。profile 可加 `"engine": "codex"` 指定用哪個轉接器開（沒寫＝第一個宣告 `openWindow` 的轉接器；指定了但沒載入該轉接器會回報開不起來）。
- 自動偵測本機 CLI（claude、codex、agy…）併成遠端開視窗的 profile **預設關**；要開請在橋的環境設 `ASN_LAUNCH_AUTO=1`（`ASN_LAUNCH_NO_AUTO=1` 仍可強制關）。ASN 電腦版的「開新夥伴」在本機啟動，不受這個設定影響。
  - `profiles.<名>`：`label`、`command`（可用 `%SystemRoot%` 這類環境變數）、`args`（字串陣列；**唯一**允許的替換欄位是 `{name}`，其他 `{…}` 整個檔案拒收）
  - `cwd_allow`：可選的工作資料夾（精確比對，不做前綴）；`max_per_hour`：每小時上限（預設 6，最多 20）
  - 改檔不用重啟橋：每次用到時看修改時間重讀；格式錯在 bridge.log 記一行原因。
- 名單回報（每 60 秒）附 `launcher` 摘要：只有 profile 名與標籤、cwd 白名單、上限，**指令內容不上雲**。
- 執行前再驗一次：profile 存在、視窗名 `^[A-Za-z0-9一-鿿][A-Za-z0-9一-鿿-]{0,39}$`（不能以 `-` 開頭）、不和本機任何 session 重名（不分大小寫）、cwd 在白名單且存在、這小時次數（`machine-<ID>/launch-history.json`，重啟照算）。
- 開視窗：經 `Start-Process`（跟 partner-relay 的 spawn-partner.ps1 一樣有自己的主控台視窗），腳本固定、檔名／參數／資料夾經環境變數傳入，不拼字串；子行程環境清掉 `CLAUDE*`、`NO_COLOR`、仲介金鑰。
- 確認：每 2 秒看 `claude agents` 有沒有出現這個名字。出現 → `ok`、立刻刷新名單、有第一句話就當成 owner 來信經收發室送進去（id＝launch id，回覆照常寄回發起的人）；30 秒還沒出現 → 先回 `unconfirmed`（可能卡在「是否信任此資料夾」，請到電腦前按 Enter），3 分鐘內出現仍補回 `ok`。
  （規劃原本寫「10 秒內沒有新 node 子行程」；改成看名單，因為那才是「真的能對話了」，也不必列舉子行程。）
- 紀錄：每一步一行 JSON 在 `machine-<ID>/launch.log`（誰、何時、profile、視窗名、cwd、結果），bridge.log 也有一行；仲介的 `relay.launches` 另有一份給手機看。
- 仲介端：2 分鐘沒被取走的 launch 標失敗（電腦開機後不會突然補開一堆視窗）。

## 轉接器介面（engines/，docs/MULTI-USER.md 第 14 節第一步）

`bridge.mjs` 不再直接碰 Claude Code，只依「轉接器」運作。Claude Code 是第一個轉接器（`engines/claude.mjs`，行為與重構前完全相同）；之後的 Codex 等照同一個介面加。`ASN_ENGINES`（逗號分隔，預設 `claude`）決定橋載入哪些轉接器；內建名稱以外的值當成模組檔路徑（測試用假引擎 `test/fake-engine.mjs` 就是這樣載入）。

轉接器模組輸出 `createEngine({ log, workDir, mailboxName, env })`，回傳：

| 成員 | 作用 | Claude 轉接器 |
|---|---|---|
| `id` | 引擎代號，名單與信件標頭的 `engine` 欄位 | `'claude'` |
| `capabilities()` | 能力宣告：`listWindows`、`deliver`、`openWindow`、`selfRecv`（視窗能自己收信，橋看到心跳就不轉）、`identity`（send／recv 認得出呼叫者）、`fallbackByActivity` | 全部 true |
| `start(handlers)` / `stop()` | 啟動／結束引擎的常駐部分；`handlers = { onSent(id), onFail(id, reason), onReply(fromWindow, text) }` | 啟動／結束收發室 worker（`claude -p`），自動重啟 |
| `listWindows()` | 回傳 `null`（讀取失敗，橋沿用舊名單）或 `{ all, windows }`。`windows`＝可轉交的視窗，每筆 `{ name, status('busy'/'idle'…), cwd_label, engine, pid? }`；`all`＝引擎看得到的所有 session（含非互動式，給 `ASN_RELAY_ALLOW` 用） | `claude agents --json` 過濾互動式、`entrypoint=cli`、排除收發室自己 |
| `listNames()` | 回傳所有 session 名的 `Set`（或 `null`），launcher 用來確認新視窗出現、擋同名 | 同上 |
| `activityOf(window)` | 最近活動時間（ms），目前橋不再用它挑代收視窗 | `~/.claude/sessions/<pid>.json` 的 `updatedAt` |
| `deliver({ id, to, text })` | 轉交一封信（`text` 是含標頭的全文，一字不改交給視窗）。同步 throw＝引擎沒起來，橋把信留在 inbox 不 ack。結果非同步經 `handlers.onSent(id)`（交出去了）或 `onFail(id, reason)`（SENT／FAIL）回來；視窗的回覆經 `handlers.onReply(window, text)` 回來（Claude：帶 nonce 的 `<<REPLY-…>>` 區塊） | `BRIDGE-FORWARD nonce=… ` 給收發室 worker |
| `openWindow(spec)`、`childEnv(env)` | 開新視窗（launcher 組好 `{command,args,cwd,env}` 後呼叫）與子行程環境清理；`capabilities().openWindow` 為 true 才需要 | `Start-Process`（`launcher.mjs` 的 `startWindow`）；清掉 `CLAUDE*` 環境變數 |
| `identity` | 身分判定區塊 `{ engine, inspectCaller() }`，登記在 `engines/identity-providers.mjs`；`inspectCaller` 回傳 `{ viaChain, viaEnv, … }`，命中是 `{ pid, name }`。`identity.mjs` 的 `findCaller()` 依序問每個引擎，回傳 `{ pid, name, engine }` | 父行程鏈＋`CLAUDE_CODE_MESSAGING_SOCKET` 對 `~/.claude/sessions` |

橋這邊保留的（與引擎無關）：relay API、ack／去重、`pending` 狀態機（轉交逾時、回覆逾時、忙碌延後、遲到回覆）、群組（rooms）、launcher.json 白名單與每小時上限、`replied/`／`sent/` 記號、單一執行個體鎖。

引擎欄位：
- roster 上報每個視窗多帶 `engine`。仲介 `action=roster` 只取 `name`／`status`／`cwd_label`，多餘欄位直接忽略，舊仲介不會 400；要讓手機顯示圖示，之後仲介（SQL 與 `index.ts` 的 map）再加欄位。
- 信件標頭尾端加 ` engine=<id>`、再加 ` reply=yes|no|?`（`[RELAY 來信] trust=… from=… to=… id=… engine=claude reply=yes`）。reply 一律放最後，前面欄位順序不動。
- 同名視窗出現在不同引擎時，名單順序在前的引擎優先（先到先得；之後要同時跑多引擎時再決定要不要改成 `引擎/名字`）。

契約測試：`test/engine-contract.test.mjs` 用假引擎跑 bridge 主流程（名單上報、轉交＋回覆寄回、onFail、找不到視窗、介面檢查、身分判定登記）。新轉接器至少要能通過同形狀的測試。

### Codex 轉接器（原型，`engines/codex.mjs`）

`ASN_ENGINES=claude,codex` 載入。用使用者自己電腦上的 Codex CLI 與自己的 ChatGPT 登入額度；對使用者**開著的互動視窗**（TUI／桌面版）做「名單＋轉交＋回覆」。調查（原 11 題的實測答案）、限制、費用、安全與上線步驟全在 `docs/archive/CODEX-ENGINE.md`。重點：

- 名單：`session_index.jsonl`（有名字的 thread）∩ `thread-writer-locks/`（正被某行程開著；Windows 以 FileShare.None 試開判斷）；忙碌＝最後一個 turn 沒結束。`codex agents` 只有 TUI、其 daemon 在 npm 安裝上起不來，所以不用。
- 轉交：`codex queue --thread <id> --message=<信>`（寫進 Codex 佇列，持有該 thread 的視窗閒下來就處理）；回覆：reader app-server 唯讀輪詢 `thread/turns/list`，取含本信編號的 turn 的最終回答。reader 絕不 `thread/resume`。
- 開視窗：先建有名字、有種子內容的 thread（不花額度）再 `codex resume <id>`；profile 寫 `"engine": "codex"`。會被「更新提示」與「信任資料夾」卡住，見文件第 3 節第 6 題。
- 身分：環境變數 `CODEX_THREAD_ID` 對 `session_index.jsonl`。沙盒預設無網路，視窗內主動寄信要走 MCP（第二期）。
- 安全：預設不轉進「完全存取」視窗；不用 `--dangerously-bypass-approvals-and-sandbox`；子行程清掉 `OPENAI_API_KEY` 等。
- 檢查工具：`node tools-codex-probe.mjs status|send|open`。測試：`test/codex-engine.test.mjs`（假 codex `test/fake-codex.mjs`；含讓 bridge.mjs 載入 codex 轉接器的整合測試）。

### acp 轉接器：背景工作者（Gemini 等，`engines/acp.mjs`，#134 第一期）

`ASN_ENGINES=claude,acp` 載入（`run-bridge.ps1 -Engines claude,acp`）。不接「使用者已開的視窗」，而是依 `~/.asn/agents.json`（範本 `agents.example.json`，`ASN_AGENTS_FILE` 可改路徑）長駐啟動一批**工作者**（背景 AI），名單上以工作者名出現（roster 的 `engine` 欄位＝`roster_engine`，例如 `gemini`）。
收到信就送一輪、拿回覆寄回（橋負責帶 `reply_to`），同一工作者保持同一段對話（session id 存 `machine-<ID>/acp-workers.json`，重啟 resume）。

- 驅動：`protocol:"agy-stream"`（預設；直接跑 `agy` 的 stream-json）或 `"acp"`（標準 ACP，備援／其他 agent）。選擇理由、實測與風險見 `docs/AGENT-ENGINES.md` 第 9 節。
- 權限：預設唯讀（read/network 放行，write/execute/other 拒絕）、白名單資料夾；每類可設 `allow`／`deny`／`ask`（問人：詢問信經仲介寄給原寄件人或指定節點，回「允許／拒絕／全部允許 編號」，逾時拒絕）。**agy 無頭模式無法預防寫檔，只能偵測中止（絆線）**，詳見該文件 9.2。
- 失敗不吞信：沒登入（名單狀態 `login-required`）、額度用完（`quota`）、逾時、崩潰、違規、佇列滿，都以 `[收發室] 轉交給 X 失敗：…` 回給寄件人。
- 子行程環境是白名單（`cleanEnv`），不帶任何金鑰；`env_pass` 只能列非金鑰名稱的變數。
- 轉接器介面的擴充（向下相容）：`createEngine` 的 ctx 多一個 `send({to_node,to_agent,body,from_agent})`（轉接器主動寄信用）；名單上的視窗可帶 `engine_label`（roster 與信件標頭顯示的引擎名，路由仍用 `engine`＝轉接器代號）與 `noFallback`（不代收沒指定收件人的信）；`handlers.onReply(視窗, 內文, 信件id?)` 第三個參數選用，轉接器知道回哪一封時帶上。
- 測試：`test/acp-policy.test.mjs`（設定、政策、授權簿、錯誤分類）、`test/acp-engine.test.mjs`（假 agy `fake-agy.mjs`、假 ACP agent `fake-acp-worker.mjs`，完整流程）、`test/acp-bridge.test.mjs`（接上真的 `bridge.mjs`）。

### 其他引擎（Gemini、Grok、pi）與 ACP

調研與建議見 `docs/AGENT-ENGINES.md`：ACP／AgentAPI 都接不到使用者已開的視窗（只能控制自己啟動的 agent），所以不整套改 ACP；
已開視窗各引擎走各自入口（Claude SendMessage、Codex queue、pi 擴充），Gemini（agy）／Grok 先以「Irori 啟動的工作者」形式接。
`engines/acp-client.mjs` 是最小 ACP 用戶端原型（白名單子行程環境、權限一律拒絕），`node tools-acp-probe.mjs init|prompt …` 手動檢查任何 ACP agent。

## 測試

`node --test relay/machine/test/*.test.mjs`（Node 25 的目錄寫法 `relay/machine/test/` 會失敗，用 glob）：本機假伺服器（node 內建 http）模擬仲介與 Aegis，不碰真實金鑰與網路服務。
涵蓋群組轉交（`rooms.test.mjs`）、白名單、成功帶 `reply_to`、error 重試一次、404、其他 status、無 `to_agent`、沒指定收件人不丟給隨便的視窗、roster 403 只記一次。
視窗自己收信（`recv.test.mjs`）：只印／只 ack 自己的信、舊仲介相容、心跳寫入與更新、重複 `--watch` 被擋、`selfRecvAlive` 判定、橋「有心跳不轉／過期照轉」。
轉接器介面契約（`engine-contract.test.mjs`，假引擎 `fake-engine.mjs` 跑 bridge 主流程）：名單帶 engine、轉交＋回覆、onFail、找不到視窗、介面檢查、身分判定登記。
遠端開視窗（`launcher.test.mjs`）：設定檔檢查、執行前再驗、環境清理、成功／失敗／卡信任確認後補成功／每小時上限；端到端真的經 Start-Process 開 `test/fake-launched.mjs`（隱藏視窗，`ASN_LAUNCH_WINDOW_STYLE=Hidden`）。

## 聯絡人分組（設備名）

Irori Chat 的聯絡人依「節點登記的工作環境（machine）」分組，組名就是那台設備的名字（家用機、工作機、雲端…）。新電腦裝機器橋時，請把它的節點 machine 設成那台電腦的名字（update_partner 或仲介 update 動作），就會自成一組。
