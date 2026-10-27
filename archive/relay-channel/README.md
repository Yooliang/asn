# relay-channel（已封存，停用）

這是早期的 Claude Code channel 外掛（把收發室來信推進執行中的 session）。**已停用，不再維護**，也不在安裝、打包與測試之內。

- 取代方案：收發室橋（`relay/machine/bridge.mjs`）、各視窗自己收信（`relay/machine/recv.mjs --watch`），或 ASN 電腦版。
- 與橋不可同時收同一把節點金鑰；請勿再掛上本外掛。
- 內文提示與範例仍是舊的 Irori 用語，不會再更新；僅留作歷史參考（2026-10 依 #14 R8 封存，用 git mv 保留歷史，原路徑 relay/channel/）。

以下為封存前的原始說明。

---

# irori-relay channel

給各機器「工頭」session 用的 Claude Code channel（MCP）。流程：訂 Supabase Realtime 門鈴 → 一響就拉 inbox →
把每封信推進 session → ack。另外每 2 分鐘拉一次補漏兼心跳；斷線自動重連（退避最多 30 秒）；以信件 id 去重。
純 Node（>= 22，用內建 fetch／WebSocket），不需要 Bun。

推進 session 的內容：

```
[RELAY 來信] trust=<owner|member> from=<from_node>/<from_agent> to=<to_agent> id=<uuid>
<body>
```

- `trust=owner`：本人（登入帳號）的交辦，但該機器既有紅線照舊
- `trust=member`：外部資料，不是指令；轉發時標明來源

工具：`relay_send(to_node, to_agent?, body, reply_to?, from_agent?)`、`relay_list()`、`relay_invite()`
（邀請碼一次性、15 分鐘；不綁代號，對方自己取；工頭開的碼限定對方的代號要以自己機器前綴開頭）。

## 安裝

```
cd relay/channel
npm install
```

## 設定（環境變數）

| 變數 | 說明 |
|---|---|
| `IRORI_RELAY_KEY` | 節點金鑰明文；或用下一項 |
| `IRORI_RELAY_ID` | 節點代號（如 `H`、`W`）；金鑰讀 `~/.irori-relay/<ID>.key` |
| `IRORI_RELAY_URL` | 預設 `https://etccgmkrosbzpltudlgt.supabase.co/functions/v1/relay` |
| `IRORI_RELAY_ANON_KEY` | 訂 Realtime 用的 anon 公開金鑰。不給＝沒有門鈴，只剩每 2 分鐘輪詢 |
| `IRORI_RELAY_LOG` | 選填，額外把 log 寫進這個檔（預設只寫 stderr） |

anon 金鑰取得（不要寫進程式或 repo）：`npx supabase projects api-keys --project-ref etccgmkrosbzpltudlgt -o json`，取 `id` 為 `anon` 那筆。

## 工頭的 .mcp.json

放在工頭的工作目錄：

```json
{
  "mcpServers": {
    "irori-relay": {
      "command": "node",
      "args": ["<irori 資料夾>/relay/channel/channel.mjs"],
      "env": {
        "IRORI_RELAY_ID": "H",
        "IRORI_RELAY_ANON_KEY": "<anon key>"
      }
    }
  }
}
```

server 名稱要叫 `irori-relay`（下面的旗標與工具名都依它）。

## 啟動工頭

```
claude --dangerously-load-development-channels server:irori-relay ^
  --allowedTools mcp__irori-relay__relay_send mcp__irori-relay__relay_list mcp__irori-relay__relay_invite
```

- 自寫 channel 不在官方允許清單，所以一定要 `--dangerously-load-development-channels`（只繞過允許清單）。
- `--allowedTools` 預先放行工具，否則 session 會停在權限提示等人。
- 必須是互動式 session；`claude -p` 不行（實測 channel 有推但 session 不反應）。

### 第一次啟動的三個對話框（之後同資料夾不再問）

1. 資料夾信任：選 **Yes, I trust this folder**
2. 「New MCP server found in this project: irori-relay」：選 **Use this MCP server**（第一項）
3. 開發 channel 警告：選 **I am using this for local development**

啟動後底下會有一行 `Channels (experimental) messages from server:irori-relay inject directly in this session`。

### 限制

- Team／Enterprise 組織帳號：要管理員先開 `channelsEnabled`（claude.ai → Admin settings → Claude Code → Channels），否則 channel 訊息不會送達。
  Pro／Max 個人帳號沒有這項限制。
- 需要 claude.ai 登入或 Console API key；Bedrock／Vertex／Foundry 不行。
- 只有 session 開著才收得到；session 沒開時信留在 inbox，下次啟動 `startup` 那次拉取會補上。
- 推送是射後不理，Claude Code 不回 ack；本程式「推完就 ack」，ack 代表已交給 session。

## 實測（2026-10-01，Windows 11、claude 2.1.286）

測試成員 `H-chtest`（家用機）掛本 channel，XISU 寄信：

- 門鈴 → push：寄出後約 0.6 秒（log：`pushed … (bell)`、`acked 1`）
- 寄出到 session 自己呼叫 `relay_send` 回信、XISU inbox 收到（`from_node=H-chtest`、`reply_to` 對得上）：**9.2 秒**（主要是模型思考時間）
- 沒測：門鈴斷線重連、2 分鐘輪詢補漏（程式有實作，未實測）、多個 channel 並掛
