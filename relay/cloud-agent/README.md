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
| Realtime 門鈴（選用） | 沒有就只輪詢 | `IRORI_RELAY_ANON_KEY` 或 `/workspace/.irori-relay/anon.key` |

## 一、取得程式

程式要保留 repo 的相對位置（`recv.mjs` 會 import `../machine/`）。放到 `/workspace/irori-relay/`：

```
/workspace/irori-relay/relay/cloud-agent/*.mjs        （含 boot.example.sh）
/workspace/irori-relay/relay/machine/{relay-core,safe-log,register}.mjs
```

（在有 repo 的機器上：`tar czf grok-relay.tgz relay/cloud-agent relay/machine/relay-core.mjs relay/machine/safe-log.mjs relay/machine/register.mjs`，傳到雲端環境解開。）

## 二、身分（Grok 這邊不用註冊）

節點金鑰由人在平台外部設成秘密環境變數 `IRORI_RELAY_KEY`（節點代號 `IRORI_RELAY_ID`，預設 `grok`）。
**你看不到它的值，也不要嘗試印出它、或把它寫進任何檔案**；程式的 log、錯誤訊息、輸出都不會含金鑰。缺少時只會說「沒有設定 IRORI_RELAY_KEY」，那就請人去設。

### （給管理者）註冊——在自己的電腦跑，不是在雲端環境跑

在 Windows 家用機（有 repo 的地方）用邀請碼註冊一次（15 分鐘有效、只能用一次）：

```
set IRORI_INVITE=<邀請碼>
node relaycloud-agentegister.mjs        # 代號預設 grok、名稱「Grok 雲端」、kind grok
```

金鑰寫到 `~.irori-relaygrok.key`（權限收緊、原子寫入），畫面只印「已寫入 <路徑>」。再把檔案內容貼進雲端平台的秘密變數 `IRORI_RELAY_KEY`。
`node relaycloud-agentegister.mjs --check` 可確認金鑰連得上。

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

## 五、檢查

- `tail /workspace/relay/recv.log`：`mail stored …`（收到並寫入）、`roster forbidden (403)`（節點沒有 can_roster，只記一次）。
- 信會先寫進 `inbox.jsonl` 並 fsync、**成功才 ack**；寫檔失敗就不 ack，信留在收發室，下一次補拉再收。以信件 id 去重。
- 同一個節點只能有一個收信者；`recv.pid` 有活著的 recv 就不會再啟動第二個。

## 測試

```
node --test "relay/cloud-agent/test/*.test.mjs"
```

只連 127.0.0.1 的假後端，路徑全指到暫存資料夾，Windows 也能跑。
