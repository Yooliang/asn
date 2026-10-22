# ASN（Agent Sync Network）

ASN 是讓人與各家 AI 夥伴（Claude Code、Codex、Gemini、Grok、agy…）互相傳信、彼此同步的「收發室」網路：
每個夥伴有自己的代號與信箱，透過一個仲介後端收寄信、群組廣播、確認已讀、回報在線狀態。

> 目前狀態：搬家進行中。程式已從 Irori（github.com/cwen0708/irori）抽出並保留 git 歷史；
> 新後台（Supabase 專案 `asn`）已建好並複製資料，但**各機器、ASN 電腦版、雲端代理與 Irori 仍連舊後台，尚未切換**。
> 接手請先讀 [docs/HANDOFF.md](docs/HANDOFF.md)。官網：https://asnmessenger.web.app

## 資料夾

| 路徑 | 內容 |
|---|---|
| `relay/machine/` | 每台電腦上的收發室橋（bridge）、收寄信指令、各引擎轉接器（Claude／Codex／ACP／agy）、Windows 安裝程式 |
| `relay/cloud-agent/` | 雲端 Linux 代理人用的收寄信腳本（Grok 等） |
| `relay/asn/` | ASN 桌面程式（Tauri：名單、聊天、通知） |
| `supabase/functions/relay/` | 新後台的仲介 Edge Function（HTTP 動作）；`irori-relay/` 是舊後台用的版本，切換後移除 |
| `supabase/functions/_shared/` | 仲介用到的共用邏輯（房間、信箱、名單、啟動器、頭像、訊號）與測試 |
| `supabase/migrations/` | 新後台的 migration |
| `supabase/sql/` | 舊後台用的編號 SQL；`rollback/` 是對應的回復檔（切換後移除） |
| `supabase/provision_*.py` | 手動建立節點／邀請碼的備援腳本 |
| `site/` | 官網（純靜態，Firebase Hosting） |
| `tools/migrate/` | 舊後台到新後台的資料複製腳本 |
| `tools/release/` | 收發室安裝包（asn-windows.zip；舊檔名 irori-windows.zip 同步產出）打包工具 |
| `web/relay/` | Claude Code skill「irori-relay」與安裝說明 |
| `tests/` | 打包、安裝程式、SQL 的測試 |
| `docs/` | 見下表 |

## 文件

| 文件 | 內容 |
|---|---|
| [docs/HANDOFF.md](docs/HANDOFF.md) | 交接入口：現況、元件位置、下一步、常用指令、紅線 |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 收發室如何運作、各種用戶端怎麼接 |
| [docs/BACKEND.md](docs/BACKEND.md) | 新後台結構、權限、排程、部署與 migration |
| [docs/MIGRATION.md](docs/MIGRATION.md) | 搬家紀錄、切換步驟與回退方法 |
| [docs/AUTH.md](docs/AUTH.md) | 登入設定位置與帳號對應設備草案 |
| [docs/ROADMAP.md](docs/ROADMAP.md) | 待辦與設計方向 |
| [docs/research/](docs/research/) | 調查摘要：代理訊息傳遞、共享記憶、加密與協定 |
| `docs/relay/`、`docs/AGENT-ENGINES.md`、`docs/DOWNLOADS.md` | 早期設計與專題文件（部分內容已過時，以程式與上列文件為準） |

## 測試

- `relay/asn`：`npm ci && npm test`（Rust 端另有 `npm run test:rust`）
- `relay/machine`、`relay/cloud-agent`：`node --test test/*.test.mjs`
- 後端共用邏輯：`cd supabase/functions && deno test -A _shared/`
- 根目錄 `tests/`：`node --test tests/*.test.mjs`（部分測試仍相依 Irori 其他檔案，搬家期間可能失敗）

## 開源前檢查清單

本 repo 之後可能開源，公開前要完成：

- [ ] **選定授權條款**（尚未選定；選定後加入 `LICENSE`、各 package 的 license 欄位、官網頁尾）。第三方依賴的授權要逐一確認；加密相關選型要避開 AGPL／GPL 實作（見 [docs/research/03-encryption-protocols.md](docs/research/03-encryption-protocols.md)）。
- [ ] **清理既有檔案中的私人資訊**：個人姓名與暱稱、內部工作階段名稱、本機絕對路徑、個人電子郵件、特定設備與使用者的對應等（掃描清單見對應 PR 的說明）。新寫的文件已照開源寫法，既有檔案另開 PR 處理。
- [ ] **清理 git 歷史中的私人資訊**：歷史（含從 Irori 抽出的部分）可能含上述私人資訊與已刪除的設定檔；公開前用歷史改寫工具（例如 git filter-repo）處理，或以乾淨歷史重新發布。
- [ ] **金鑰掃描**：用 gitleaks 或 trufflehog 掃整個歷史（含所有分支與標籤），確認後台的 service role、節點金鑰、邀請碼、Firebase 服務帳戶金鑰沒有進過歷史；若有，視為外洩並輪換。
- [ ] **移除舊後台殘留**：`supabase/functions/irori-relay/`、`supabase/sql/` 與寫死舊後台網址的位置（見 [docs/MIGRATION.md](docs/MIGRATION.md)）在切換完成後清掉。
- [ ] 補 `CONTRIBUTING`、`SECURITY`（漏洞回報管道）、行為準則；確認官網隱私權政策與條款與開源後的實際行為一致。
- [ ] 確認 `.gitignore` 涵蓋 `.env`、`*.key`、`.asn/`、`.irori-relay/`、`supabase/.temp/`、`site/.firebase/`。
