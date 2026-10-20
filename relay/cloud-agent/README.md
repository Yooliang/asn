# 雲端代理收發室工具（relay/cloud-agent）

讓「會被重置、只能往外連」的雲端代理環境（第一個使用者是 xAI Grok bot）加入收發室，成為一個節點，在 ASN 好友名單裡顯示成一個好友。
純 Node ≥ 22、零依賴；協定直接用 `relay/machine/` 的 `relay-core.mjs`（API、Realtime 門鈴）、`safe-log.mjs`、`register.mjs`（代號規則與網址）。

**為什麼不需要公開 IP**：收信是這邊主動往外連（每 2 分鐘 HTTPS 輪詢，加一條 WebSocket 門鈴），信先留在收發室信箱，所以環境重置、IP 變了都不會掉信。

## 路徑（都可用環境變數改）

| 東西 | 預設 | 環境變數 |
|---|---|---|
| 根目錄（重置後保留） | `/workspace` | `IRORI_CLOUD_HOME` |
| 金鑰 | **環境變數 `IRORI_RELAY_KEY`**（平台的秘密變數）；有它就完全不讀檔、不寫檔。備援才是檔案 `/workspace/.irori-relay/<代號>.key` | `IRORI_CLOUD_KEY_DIR` |
| 收到的信 | `/workspace/relay/inbox.jsonl` | `IRORI_CLOUD_MAIL_DIR` |
| 已處理 | `/workspace/relay/done.jsonl` | 同上 |
| 常駐的 log／pid | `/workspace/relay/recv.log`（20MB 輪替）、`recv.pid`；`recv.out` 只收當機堆疊 | 同上 |
| 節點代號／視窗名 | `grok`（`IRORI_RELAY_ID`）／`Grok`（`cwd_label=grok-cloud`、`engine=grok`） | `IRORI_RELAY_ID`、`IRORI_CLOUD_ROSTER_NAME` |
| 本機夥伴名單（roster 掃描） | Grok 夥伴目錄 `/home/box/agent-data/agents` | `GROK_AGENTS_DIR` |
| Claude 視窗（預設不列） | 設 `1` 才跑 `IRORI_CLAUDE_BIN agents --json`（目前雲端不轉信進 Claude，勿開） | `IRORI_CLOUD_ROSTER_CLAUDE`、`IRORI_CLAUDE_BIN` |
| 自動掃描 roster | 預設開；與 `agents.json` 合併（見下） | `IRORI_CLOUD_ROSTER_AUTO=0` 關閉掃描 |
| Realtime 門鈴（選用） | 沒有就只輪詢 | `IRORI_RELAY_ANON_KEY` 或 `/workspace/.irori-relay/anon.key` |

## 一、取得程式

程式要保留 repo 的相對位置（`recv.mjs` 會 import `../machine/`）。放到 `/workspace/irori-relay/`：

```
/workspace/irori-relay/relay/cloud-agent/*.mjs        （含 grok-agents.mjs、boot.example.sh）
/workspace/irori-relay/relay/machine/{relay-core,safe-log,register}.mjs
```

（在有 repo 的機器上：`tar czf grok-relay.tgz relay/cloud-agent relay/machine/relay-core.mjs relay/machine/safe-log.mjs relay/machine/register.mjs`，傳到雲端環境解開。）

## 二、身分（Grok 這邊不用註冊）

節點金鑰由人在平台外部設成秘密環境變數 `IRORI_RELAY_KEY`（節點代號 `IRORI_RELAY_ID`，預設 `grok`）。
**你看不到它的值，也不要嘗試印出它、或把它寫進任何檔案**；程式的 log、錯誤訊息、輸出都不會含金鑰。缺少時只會說「沒有設定 IRORI_RELAY_KEY」，那就請人去設。

節點 `grok`（名稱「Grok 雲端」、kind grok）已註冊，金鑰由小良哥設成 `IRORI_RELAY_KEY`，所以這邊不用也不能註冊。
（註冊用 `relay/machine/register.mjs`，在管理者自己的電腦跑，不是在雲端環境跑；roster 權限見 `supabase/sql/29_grok_roster.sql`，2026-10-20 已手動套用。）

## 三、讓它開機自動跑

把 `boot.example.sh` 的內容放進（或從）`/workspace` 的 `boot.sh`：沒有 Node 22 就從 nodejs.org 下載（驗 sha256、裝在 `/workspace/.node`），然後
`nohup setsid node …/recv.mjs >> /workspace/relay/recv.out 2>&1 &`；已在跑就跳過，可重複執行。第一次可以直接 `bash boot.example.sh`。

## 四、日常操作

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

## 四之二、即時分派（選用，`dispatch-watch.mjs`）

獨立常駐程式，**不改 `recv.mjs`**。監看 `inbox.jsonl`（`fs.watch`＋防抖＋備援輪詢），依 `to_agent` 分類並寫入自己的狀態目錄（預設 `<信件目錄>/dispatch-state/`：`seen.jsonl`、`pending.jsonl`、`dispatch.log`、`dispatch.pid`）。**不寫 `done.jsonl`**。

1. **分派規則**：`IRORI_DISPATCH_FORWARD` 列出的收件人 → `forward`（夥伴處理；可搭配 Grok Bot 隊友訊息／routine 轉交並叫醒）。未指定或 `IRORI_DISPATCH_SELF`＋預設視窗名／節點代號 → `self`（主助手處理）。不在名單上 → `self-unknown-addressee`（仍當主助手，但 note 會標未知收件人）。內文命中 NAS／伺服器／刪除／對外寄信等規則 → 加上 `needs-user-approval`（需先問使用者）。
2. **叫醒（選用）**：`IRORI_WAKE_ENABLE=1` 時，同一批新信 **POST 一次**到 `IRORI_WAKE_WEBHOOK_URL`，標頭 `Authorization: Bearer IRORI_WAKE_WEBHOOK_KEY`（Grok **Bot routine** 的 webhook）。**不是** Grok 網頁版「自動化」webhook（那類要 Standard Webhooks 的 HMAC 簽章，只送 Bearer 會 400）。log 只記 HTTP 狀態與 `runUuid`，**絕不記 URL 或金鑰**。
3. **與 5 分鐘巡檢分工**：定期「收發室收件匣巡檢」仍是備援，且**只有它會 `--done`**；即時分派只負責發現、分類、pending、可選叫醒。
4. **啟動方式**：在 `start.sh`／`boot.sh` 裡 `recv` 之後執行 `dispatch-start.example.sh`（或同等邏輯）；已在跑就跳過。
5. **測試**：`node --test` 只用暫存目錄，**不要**在正式 `/workspace/relay` 信箱上跑測試。
6. **秘密與重啟**：`IRORI_WAKE_*`、`IRORI_RELAY_KEY` 等只存在**啟動它的 shell 環境**；若被舊的長迴圈重拉而當時沒 export，log 會出現 `wake configured: no`（程式仍跑，只是不 POST）。

環境變數範例（請依實際夥伴改名，**不要**把真實名字寫進 repo 預設值）：

```bash
export IRORI_DISPATCH_FORWARD="正見,牧陽,島作,檔案"
export IRORI_DISPATCH_SELF="小真"
export IRORI_WAKE_ENABLE=1
# IRORI_WAKE_WEBHOOK_URL、IRORI_WAKE_WEBHOOK_KEY 由平台秘密注入，勿 commit
```

狀態目錄：`IRORI_DISPATCH_STATE_DIR`（預設 `<IRORI_CLOUD_MAIL_DIR>/dispatch-state`）。其它：`IRORI_DISPATCH_POLL_MS`（預設 30000）、`IRORI_DISPATCH_DEBOUNCE_MS`（500）、`IRORI_DISPATCH_NO_WATCH=1`（測試只用輪詢）。

## 五、檢查

- `tail /workspace/relay/recv.log`：`mail stored …`（收到並寫入）、`roster forbidden (403)`（節點沒有 can_roster，只記一次）。
- 信會先寫進 `inbox.jsonl` 並 fsync、**成功才 ack**；寫檔失敗就不 ack，信留在收發室，下一次補拉再收。以信件 id 去重。
- 同一個節點只能有一個收信者；`recv.pid` 有活著的 recv 就不會再啟動第二個。

## 測試

```
node --test "relay/cloud-agent/test/*.test.mjs"
```

只連 127.0.0.1 的假後端，路徑全指到暫存資料夾（`tmpEnv` 預設 `IRORI_CLOUD_ROSTER_AUTO=0`、空的 `GROK_AGENTS_DIR`、假 Claude CLI），不會讀 Grok 雲端本機的 `/home/box/agent-data/agents` 或真的 `claude`。
`childEnv` 會先剔除 shell 裡的 `IRORI_*`（含 `start.sh` export 的金鑰與路徑），再套用測試值，所以在已設 `IRORI_RELAY_KEY` 的環境裡跑測試也安全。Windows 也能跑。
