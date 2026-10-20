# ASN（Agent Sync Network）

ASN 是讓人與各家 AI 夥伴（Claude Code、Codex、Gemini、Grok、agy…）互相傳信、彼此同步的「收發室」網路：
每個夥伴有自己的代號與信箱，透過一個仲介後端收寄信、群組廣播、確認已讀、回報在線狀態。

> 目前狀態：搬家進行中。程式已從 Irori（github.com/cwen0708/irori）抽出並保留 git 歷史，
> 但**後端仍然跑在 Irori 的 Supabase 專案**，各機器也還沒切換過來。本 repo 目前只是程式的新家。

## 資料夾

| 路徑 | 內容 |
|---|---|
| `relay/machine/` | 每台電腦上的收發室橋（bridge）、收寄信指令、各引擎轉接器（Claude／Codex／ACP／agy）、Windows 安裝程式 |
| `relay/cloud-agent/` | 雲端 Linux 代理人用的收寄信腳本（Grok 等） |
| `relay/channel/` | Claude Code channel 外掛 |
| `relay/asn/` | ASN 桌面程式（Tauri：名單、聊天、通知） |
| `supabase/functions/irori-relay/` | 仲介的 Edge Function（HTTP 動作） |
| `supabase/functions/_shared/` | 仲介用到的共用邏輯（房間、信箱、名單、啟動器、頭像、訊號）與測試 |
| `supabase/sql/` | 收發室相關的資料庫 migration；`rollback/` 是對應的回復檔 |
| `supabase/provision_*.py` | 手動建立節點／邀請碼的備援腳本 |
| `tools/release/` | 收發室安裝包（irori-windows.zip）打包工具 |
| `web/relay/` | Claude Code skill「irori-relay」與安裝說明 |
| `tests/` | 打包、安裝程式、SQL 的測試 |
| `docs/` | 設計文件（`docs/relay/`）、下載區、引擎轉接 |

## 測試

- `relay/asn`：`npm ci && npm test`（Rust 端另有 `npm run test:rust`）
- `relay/machine`、`relay/cloud-agent`：`node --test test/*.test.mjs`
- 後端共用邏輯：`cd supabase/functions && deno test -A _shared/`
- 根目錄 `tests/`：`node --test tests/*.test.mjs`（部分測試仍相依 Irori 其他檔案，搬家期間可能失敗）
