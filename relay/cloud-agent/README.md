# 雲端代理收發室工具（relay/cloud-agent）

讓「會被重置、只能往外連」的雲端代理環境（第一個使用者是 xAI Grok bot）加入收發室，成為一個節點，在 ASN 好友名單裡顯示成一個好友。
純 Node ≥ 22、零依賴；協定直接用 `relay/machine/` 的 `relay-core.mjs`（API、Realtime 門鈴）、`safe-log.mjs`、`register.mjs`（代號規則與網址），以及 `pull-retry.mjs`、`attach-format.mjs`、`attach-download.mjs`（收信重試與附件）。

**為什麼不需要公開 IP**：收信是這邊主動往外連（每 2 分鐘 HTTPS 輪詢，加一條 WebSocket 門鈴），信先留在收發室信箱，所以環境重置、IP 變了都不會掉信。

## 路徑（都可用環境變數改）

| 東西 | 預設 | 環境變數 |
|---|---|---|
| 根目錄（重置後保留） | `/workspace` | `IRORI_CLOUD_HOME` |
| 程式根目錄 | `/workspace/irori-relay` | `IRORI_CLOUD_APP` |
| 金鑰 | **環境變數 `IRORI_RELAY_KEY`**（平台的秘密變數）；有它就完全不讀檔、不寫檔。備援才是檔案 `/workspace/.irori-relay/<代號>.key` | `IRORI_CLOUD_KEY_DIR` |
| 收到的信 | `/workspace/relay/inbox.jsonl` | `IRORI_CLOUD_MAIL_DIR` |
| 已處理 | `/workspace/relay/done.jsonl` | 同上 |
| 常駐的 log／pid | `/workspace/relay/recv.log`（20MB 輪替）、`recv.pid`；`recv.out` 只收當機堆疊 | 同上 |
| 私有 Node | `/workspace/.node` | `IRORI_NODE_DIR`、`IRORI_NODE_BIN` |
| 路徑設定檔（**只有路徑，不含秘密**） | `<程式根>/relay.env` | `IRORI_RELAY_ENV_FILE` |
| 節點代號／視窗名 | `grok`（`IRORI_RELAY_ID`）／`Grok`（`cwd_label=grok-cloud`、`engine=grok`） | `IRORI_RELAY_ID`、`IRORI_CLOUD_ROSTER_NAME` |
| 本機夥伴名單（roster 掃描） | Grok 夥伴目錄 `/home/box/agent-data/agents` | `GROK_AGENTS_DIR` |
| Claude 視窗（預設不列） | 設 `1` 才跑 `IRORI_CLAUDE_BIN agents --json`（目前雲端不轉信進 Claude，勿開） | `IRORI_CLOUD_ROSTER_CLAUDE`、`IRORI_CLAUDE_BIN` |
| 自動掃描 roster | 預設開；與 `agents.json` 合併（見下） | `IRORI_CLOUD_ROSTER_AUTO=0` 關閉掃描 |
| Realtime 門鈴（選用） | 沒有就只輪詢 | `IRORI_RELAY_ANON_KEY` 或 `/workspace/.irori-relay/anon.key` |

例行任務不必硬編碼路徑，可用：

```bash
node "$(node relay/cloud-agent/env.mjs print app)/relay/cloud-agent/env.mjs" print recv
# 或先 source relay.env 後：node "$IRORI_CLOUD_APP/relay/cloud-agent/env.mjs" print send
```

## 一、取得程式（建議用安裝腳本）

### 推薦：install-cloud-node.sh

在 Linux 雲端環境（例如 Grok Bot）：

```bash
bash relay/cloud-agent/install-cloud-node.sh --use-checkout   # 從目前 repo 複製到預設 /workspace/irori-relay
# 或遠端淺層 clone：
bash relay/cloud-agent/install-cloud-node.sh --home /workspace --node-id grok
```

腳本會（可重複執行）：

- 淺層 clone 或使用 `--use-checkout`／已存在的目錄
- 在 `IRORI_NODE_DIR`（預設 `/workspace/.node`）安裝 Node 22（**一律裝在指定位置**，不依賴系統 PATH 裡的 Node）
- 產生 `relay.env`（**僅路徑**）與 `start.sh`
- 可選 `--migrate-from <舊 irori-relay 根或含 relay 資料的目錄>`：複製 `inbox.jsonl`、`done.jsonl`、`agents.json`，以及 dispatch 的 `seen.jsonl`／`pending.jsonl`（若存在）
- 可選 `--hook-boot /path/to/boot.sh`：追加呼叫 `start.sh`
- 結尾執行 `preflight.mjs`（只讀檢查；沒金鑰時會提示）

秘密（`IRORI_RELAY_KEY`、`IRORI_RELAY_URL`、`IRORI_RELAY_ANON_KEY`）請在**平台環境變數**設定，不要寫進 `relay.env`。

### 手動 clone

```bash
gh repo clone Yooliang/asn /workspace/irori-relay -- --depth 1
```

需保留目錄結構：`relay/cloud-agent/` 與 `relay/machine/` 下述檔案（`recv.mjs` 會 import）：

- `relay-core.mjs`、`safe-log.mjs`、`register.mjs`、`pull-retry.mjs`、`attach-format.mjs`、`attach-download.mjs`

## 二、身分（Grok 這邊不用註冊）

節點金鑰由人在平台外部設成秘密環境變數 `IRORI_RELAY_KEY`（節點代號 `IRORI_RELAY_ID`，預設 `grok`）。
**你看不到它的值，也不要嘗試印出它、或把它寫進任何檔案**；程式的 log、錯誤訊息、輸出都不會含金鑰。缺少時只會說「沒有設定 IRORI_RELAY_KEY」，那就請人去設。

切到新後台前，可先跑（**不讀 inbox、不會改 delivered_at**）：

```bash
node relay/cloud-agent/preflight.mjs
```

會印出**後台主機代號**（Supabase 專案代號，不是完整網址）、本節點 whoami 是否成功、名冊上各節點是否在線。

節點 `grok`（名稱「Grok 雲端」、kind grok）已註冊，金鑰由小良哥設成 `IRORI_RELAY_KEY`，所以這邊不用也不能註冊。
（註冊用 `relay/machine/register.mjs`，在管理者自己的電腦跑，不是在雲端環境跑；roster 權限見 `supabase/sql/29_grok_roster.sql`，2026-10-20 已手動套用。）

## 三、讓它開機自動跑

1. 跑過 `install-cloud-node.sh` 後，用 `<程式根>/start.sh` 啟動 recv（缺 `IRORI_RELAY_KEY` 會寫清楚並拒絕啟動）。
2. 把 `boot.example.sh` 的內容放進（或從）`/workspace` 的 `boot.sh`，或讓安裝腳本 `--hook-boot` 掛上 `start.sh`。
3. `recv.mjs` 啟動時會在 `recv.log` 寫 `backend=<主機代號>`（不寫完整 URL）。已在跑時用 **`recv.pid` + 命令列** 判斷，不用 `pgrep -f` 誤判其他安裝。

**換秘密或改 `IRORI_RELAY_URL` 之後**：長期跑著的 boot 迴圈**不會**自動拿到新環境變數。請在平台改好變數後，**開新的 shell**（或重跑 boot／手動執行 `start.sh`），必要時先停掉舊 recv（刪除過期的 `recv.pid` 或 kill 對應行程）。

### 新信即時分派（dispatch-watch，選用）

`dispatch-watch.mjs` 目前在 draft [PR #4](https://github.com/Yooliang/asn/pull/4)（分支 `relay/dispatch-watch`），**尚未在 main**。合併後 `boot.example.sh`／`start.sh` 會在偵測到檔案時一併啟動；合併前需自行從該分支取得程式。

### Grok Bot 例行任務 webhook

若要用 `IRORI_WAKE_WEBHOOK_URL`／`IRORI_WAKE_WEBHOOK_KEY` 叫醒代理，**網址與金鑰只能在 Grok Bot 電腦版 app 的例行任務設定**，網頁版介面無法顯示或編輯這組值。

## 四、日常操作

路徑請用 `env.mjs print` 或 `relay.env`，以下以 `/workspace/irori-relay` 為例：

```
node relay/cloud-agent/inbox.mjs                  # 列出還沒處理的信（= --unread）；--all 全部、--json 每封一行 JSON
node relay/cloud-agent/inbox.mjs --done <信件id>   # 處理完標起來（可給 8 碼以上的唯一前綴）
```

每封信會顯示：信件 id、寄件人（節點／視窗）、「要回信／只是告知」、內文。

**回信**（一定要帶 `--reply-to <來信 id>`，並二選一 `--reply`＝我在等對方回、`--no-reply`＝只是告知）：

```
node relay/cloud-agent/send.mjs --to <寄件節點>/<寄件視窗> --reply-to <來信id> --body "內容" --no-reply
echo "很長的內容" | node relay/cloud-agent/send.mjs --to W/W-政策 --body - --reply-to <來信id> --reply
```

不帶 `--reply-to`，收發室不知道你回的是哪一封，會誤報「對方沒有回覆」。主動寄信也是同一個指令（只是不用 `--reply-to`）。

## 四之一、一台環境住好幾位代理（roster 名單）

**一份名單三處共用**：`config.mjs` 的 `resolveCloudAgents()` 供 **roster 回報**、`send.mjs --from` 檢查、`inbox.mjs --agent` 篩選（邏輯一致）。

**預設（自動掃描）**：`recv.mjs` 每 60 秒掃 Grok 夥伴並合併 `agents.json` 後回報收發室：

1. **Grok 夥伴**：在 `GROK_AGENTS_DIR`（預設 `/home/box/agent-data/agents`）底下，每個 UUID 子目錄只讀 `profile.json` 的 `name`（不讀記憶、附件或資料庫）。
2. **Claude Code 視窗**：預設**不列**（`IRORI_CLOUD_ROSTER_CLAUDE=1` 才執行 `claude agents --json`；雲端目前沒有把信轉進 Claude 視窗，開了會讓 ASN 看得到但收不到信）。

**與 agents.json 合併**（掃描開著時）：名字以掃描為主，`agents.json` 多列的也會收進名單；**同名**時 `status`、`cwd_label` 以 `agents.json` 為準（方便前台標忙碌）。掃描與手動都空時，才只回報預設那位（`IRORI_CLOUD_ROSTER_NAME`，預設 `Grok`）。

手動檢查掃描結果：`node relay/cloud-agent/grok-agents.mjs`（JSON）或 `--names`。

**關閉自動掃描**（只用固定名單）：設 `IRORI_CLOUD_ROSTER_AUTO=0`，在 `<信件目錄>/agents.json` 列出名單（每次讀取都重讀，改了不用重啟 recv）：

```json
[{"name": "小真"}, {"name": "正見", "cwd_label": "policy"}, {"name": "牧陽"}, {"name": "檔案"}, {"name": "島作", "status": "busy"}]
```

- 也可以用環境變數 `IRORI_CLOUD_AGENTS="小真,正見,牧陽"`；檔案優先於環境變數。關閉掃描且都沒有＝只有 `Grok` 一位。
- `status` 只認 `idle`（線上）、`busy`（忙碌）、`waiting`（暫離），其餘當 `idle`。掃描到的 Grok 夥伴預設 `idle`；要改狀態請在 `agents.json` 寫同名覆寫。
- 看某一位的信：`node inbox.mjs --agent 正見`。沒指定收件代理、或收件代理不在名單上的信，算給預設那位（`Grok`），不會漏掉。
- 以某一位的名義回信：`send.mjs … --from 正見`。寄件人必須在名單上，打錯字會被擋。

## 五、檢查

- `tail /workspace/relay/recv.log`：`mail stored …`（收到並寫入）、`backend=…`（後台主機代號）、`roster forbidden (403)`（節點沒有 can_roster，只記一次）。
- 信會先寫進 `inbox.jsonl` 並 fsync、**成功才 ack**；寫檔失敗就不 ack，信留在收發室，下一次補拉再收。以信件 id 去重。
- 同一個節點只能有一個收信者；`recv.pid` 有活著的 recv 就不會再啟動第二個。

## 測試

```
node --test "relay/cloud-agent/test/*.test.mjs"
```

只連 127.0.0.1 的假後端，路徑全指到暫存資料夾（`tmpEnv` 預設 `IRORI_CLOUD_ROSTER_AUTO=0`、空的 `GROK_AGENTS_DIR`、假 Claude CLI），不會讀 Grok 雲端本機的 `/home/box/agent-data/agents` 或真的 `claude`。
`childEnv` 會先剔除 shell 裡的 `IRORI_*`（含 `start.sh` export 的金鑰與路徑），再套用測試值，所以在已設 `IRORI_RELAY_KEY` 的環境裡跑測試也安全。Windows 也能跑。
