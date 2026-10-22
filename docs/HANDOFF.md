# ASN 交接（入口）

給接手的人：先讀這一頁，再依需要往下看其他文件。

## 一頁看懂

ASN（Agent Sync Network）是讓人與各家 AI 夥伴（Claude Code、Codex、Gemini、Grok、agy……）互相傳信的「收發室」網路。
每台設備、每個雲端代理是一個**節點**，節點有自己的金鑰與信箱；中間一個仲介後端負責收寄信、群組廣播、已讀回條、在線名單。
人用「ASN 電腦版」（類似舊式即時通）看好友名單與聊天；AI 視窗透過各設備上的「收發室橋」收信、回信。

ASN 從 Irori 專案（github.com/cwen0708/irori）拆出，保留 git 歷史。拆出後後端已在新的 Supabase 專案複製一份，**但尚未切換**：

| 項目 | 現況 |
|---|---|
| 程式碼 | 已搬進本 repo（`relay/`、`supabase/`、`site/`、`tools/`、`web/`） |
| 新後台 | Supabase 專案 `asn`（東京，專案代號 `etccgmkrosbzpltudlgt`）；Edge Function `relay`，網址 `https://etccgmkrosbzpltudlgt.supabase.co/functions/v1/relay`；資料已從舊後台複製（筆數見 [MIGRATION.md](MIGRATION.md)）；舊節點金鑰在新後台可直接使用（後端只存雜湊） |
| 切換 | **尚未切換**：各設備收發室橋、ASN 電腦版、雲端代理、Irori 仍連舊後台；切換前要再做一次增量同步 |
| 登入 | 新後台已開 Google（已發布）與 GitHub 登入；`relay.nodes.owner_user` 只有欄位，登入與認領流程還沒做（見 [AUTH.md](AUTH.md)） |
| 官網 | https://asnmessenger.web.app（首頁、隱私權政策、服務條款），Firebase Hosting；下載區尚未開放 |
| 訊息保存 | 90 天自動刪除排程（每天 03:17 UTC）新舊後台都已建立 |
| 授權 | 尚未選定（見 [README](../README.md) 的「開源前檢查清單」） |

## 元件與位置

| 路徑 | 說明 | 文件 |
|---|---|---|
| `relay/machine/` | 每台設備的收發室橋、收寄信指令（`send.mjs`、`recv.mjs`、`room.mjs`）、引擎轉接器、Windows 安裝程式 | `relay/machine/README.md` |
| `relay/cloud-agent/` | 雲端 Linux 代理（例如 Grok）用的收寄信腳本 | `relay/cloud-agent/README.md` |
| `relay/channel/` | Claude Code channel 外掛（早期做法，被收發室橋取代，仍保留） | `relay/channel/README.md` |
| `relay/asn/` | ASN 電腦版（Tauri 2 + Vue 3） | `relay/asn/README.md` |
| `cloudflare/edge-tts/` | 念出訊息用的 Edge TTS 代理（Cloudflare Worker，僅個人用、預設不啟用） | [VOICE.md](VOICE.md) |
| `supabase/migrations/` | 新後台的 migration（Supabase CLI 格式） | [BACKEND.md](BACKEND.md) |
| `supabase/functions/relay/` | 新後台的 Edge Function | [BACKEND.md](BACKEND.md) |
| `supabase/functions/_shared/` | 函式共用邏輯與單元測試 | [BACKEND.md](BACKEND.md) |
| `supabase/functions/irori-relay/`、`supabase/sql/` | 舊後台用的函式與 SQL，切換完成後整理或移除 | [MIGRATION.md](MIGRATION.md) |
| `tools/migrate/` | 舊後台到新後台的資料複製腳本 | [MIGRATION.md](MIGRATION.md) |
| `tools/release/` | 收發室安裝包打包 | `docs/DOWNLOADS.md` |
| `site/` | 官網（純靜態） | `site/README.md` |
| `web/relay/` | Claude Code skill「irori-relay」與安裝說明（內含舊後台網址，切換時要改） | — |
| `docs/relay/` | 早期設計文件（部分內容已過時，以程式與本批文件為準） | — |

## 目前在哪一步

搬家共四步：
1. 程式從 Irori 拆出（完成，PR #1 官網、其餘歷史保留）。
2. 新後台建好（完成，PR #2）。
3. 資料複製（完成一次；切換時還要再同步一次）。
4. **切換各用戶端（尚未）**。步驟與回退見 [MIGRATION.md](MIGRATION.md)。

## 下一步（建議順序）

1. 切換：做增量同步、切換各設備收發室橋、ASN、雲端代理、Irori（[MIGRATION.md](MIGRATION.md)）。
2. 登入與認領：帳號對應設備（[AUTH.md](AUTH.md)）。
3. 開源前整理（[README](../README.md) 的檢查清單）。
4. 其餘設計方向見 [ROADMAP.md](ROADMAP.md)。

## 常用指令

```
# ASN 電腦版
cd relay/asn && npm ci && npm test          # Rust 端另有 npm run test:rust
cd relay/asn && npm start                   # 開發模式

# 收發室橋、雲端代理
cd relay/machine && node --test test/*.test.mjs
node --test "relay/cloud-agent/test/*.test.mjs"

# 後端共用邏輯
cd supabase/functions && deno test -A _shared/

# 念出訊息代理的簽章守門測試
node --test tests/edge_tts_drm.test.mjs

# 根目錄測試（部分仍相依 Irori 其他檔案，搬家期間可能失敗）
node --test tests/*.test.mjs

# 官網預覽
npx --yes http-server site/public -p 5179
```

後端部署、migration 套用、官網部署都是**對外有影響的動作**，先取得維護者同意再做（指令見 [BACKEND.md](BACKEND.md)）。

## 注意事項（紅線）

- **不讀、不印任何金鑰**：節點金鑰、service role、anon 以外的任何密鑰、`%USERPROFILE%\.asn\`（舊位置 `.irori-relay` 同）目錄內容。提交前確認沒有金鑰進入歷史。
- **只關自己啟動並記下 PID 的程序**；不要用程序名稱整批結束。橋的鎖檔 `bridge.pid` 不要手動刪。
- 同一把節點金鑰同時只能有**一個**收信者（橋、ASN 以視窗名收信、channel 外掛不要搶同一個信箱）。
- `relay/machine`、`relay/cloud-agent` 會在 Linux 上跑，檔案一律 LF（見 `.gitattributes`）。
- 切換完成前，未經維護者同意不對舊後台做寫入性變更；對新後台套用 migration、部署函式前也要同意。
- 測試只連 `127.0.0.1` 的假後端，不要把測試指向真實後端。
- 給人看的文字一律繁體中文、不中英夾雜（英文名稱只留在註解與 log）。

## 2026-10-21 現況（asn session 交接用）

- 切換新後台（#7）：新後台已套照片 migration、部署最新 relay 函式；增量同步用 `tools/migrate/sync_relay_delta.py`（以主鍵 upsert、不清空、可重跑）。**已切**：H 家用機收發室橋（排程改跑本 repo `relay/machine`，`anon.key` 已換新、舊的備份成 `anon.key.old-irori`）、grok 小真。**未切**：w02、aegis（小良哥到公司做）、Irori XISU（請家用若莉）。切完後再跑一次 `sync_relay_delta.py export`＋`upsert` 補舊後台的信。
- 開發分工：小真（grok，能直接開 PR，環境編不了 Rust）做功能；本 session 審查、Windows 打包＋端到端、合併。介面 PR 合併前要實際開起來操作。
- 進行中：#48 開新 AI 夥伴（疊在 #49 偵測上；待 Windows 實測開 Claude／Codex 視窗）；#44 雲端代理安裝腳本＋ASN_ 改名（待審）；#4 dispatch-watch 草稿（待審）。
- 待辦：#51 切換 Claude 帳號、#52 用量（Rust 讀本機紀錄，參考 ccusage）、#12 登入＋內建橋（已改裁全 Rust 重寫，設計文件 D1 待改）、#13 雲端代理技能與設定頁邀請（PR feat/13-cloud-invite；待部署：migration → relay 函式 → 官網 → ASN 發版）、#14 去 Irori 化、#20 聽歌狀態、#22 系統匣、#26 機密保管、#27 子代理、#40 功能列。
- 部署狀態：念出回覆（TTS）要部署 Cloudflare Worker＋設兩個秘密才會出聲（未做，要小良哥同意）；官網隱私權政策的照片／語音段落未部署。
