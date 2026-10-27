# ASN（Agent Sync Network）

ASN 是讓人與各家 AI 夥伴（Claude Code、Codex、Gemini、Grok、agy…）互相傳信、彼此同步的「收發室」網路：
每個夥伴有自己的代號與信箱，透過一個仲介後端收寄信、群組廣播、確認已讀、回報在線狀態。

> 目前狀態：搬家進行中。程式已從 Irori（github.com/cwen0708/irori）抽出並保留 git 歷史；
> 新後台（Supabase 專案 `asn`）已建好並複製資料，但**各機器、ASN 電腦版、雲端代理與 Irori 仍連舊後台，尚未切換**。
> 接手請先讀 [docs/HANDOFF.md](docs/HANDOFF.md)。官網：https://asnmessenger.web.app

## 支援哪些 AI，怎麼接進 ASN

同一個 AI 夥伴，ASN 提供幾種接入方式，可以依你的習慣選。主推的順序是：背景連線 → 透過 pi → 由 ASN 開啟 → 自己的終端加外掛。

**狀態的意思**
- **可用**：已在正式版，並且有在真的電腦上測過。
- **實驗中**：程式已經有，但實際測過的情況有限。
- **規劃中**：列入計畫，還沒做。
- **不支援**：目前沒有，或是刻意不做。

| AI 夥伴 | 背景連線（ACP） | 透過 pi | 由 ASN 開啟（進階） | 自己的終端 + 外掛 |
|---|---|---|---|---|
| Claude Code | 不提供（服務條款與帳務考量） | 實驗中 | 可用（開成獨立的終端機視窗） | 可用（`asn@asn` 外掛） |
| Codex / GPT | 不支援 | 實驗中 | 實驗中 | 規劃中 |
| Gemini（agy） | 可用 | 不支援 | 實驗中（尚不能自動收信） | 規劃中 |
| Grok | 可用 | 實驗中 | 實驗中（尚不能自動收信） | 規劃中 |
| DeepSeek | 不支援 | 實驗中 | 不支援 | 不支援 |
| MiniMax | 不支援 | 實驗中 | 不支援 | 不支援 |
| Qwen | 不支援 | 不支援（目前的 pi 沒有這家） | 不支援 | 不支援 |

- **背景連線（ACP，Agent Client Protocol）**：不開視窗，ASN 在背景用標準協定和模型對話，可以收發信，適合無人值守。目前無法在對話中途切換模型。
- **透過 pi**：用 pi（命令列 AI 助手）開啟，可以選用 pi 支援的多家模型。模型清單向你電腦上的 pi 查詢，只列你已經登入的提供者。透過 pi 開的任何模型，只要裝了 pi 擴充（ASN 預設會自動裝），也會出現在你的名單上。
- **由 ASN 開啟**：Claude、Codex 會開成各自獨立的終端機視窗；Grok、Gemini 開在 ASN 內建的 WezTerm 終端（WezTerm 的授權見 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)）。命令列程式不容易從外部控制，所以這條路目前只能開啟、看畫面、在你確認後送字；Grok、Gemini 在內建終端裡還收不到信，收信注入還在規劃，原因是要先確定安全的做法。
- **自己的終端 + 外掛**：你照平常習慣在自己的終端開工具，安裝 ASN 外掛（Claude）或 pi 擴充後，它就會出現在你的名單上。

這張表和程式裡的啟動方式目錄是同一份事實，改其中一邊時請一起改。

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
- `relay/machine`、`relay/cloud-agent`：`node --test --test-force-exit --test-timeout=120000 test/*.test.mjs`（強制結束＋單支逾時，失敗不會掛著）
- 後端共用邏輯：`cd supabase/functions && deno test -A _shared/`
- 根目錄 `tests/`：`node tools/run-root-tests.mjs`（一支一支跑、每支各自逾時，可加檔名片段與 `--timeout=秒`；整批 `node --test tests/*.test.mjs` 一次丟出去會卡住，也不要加 `--test-force-exit`，Windows 上會假「取消」）。2026-10-26 在家用機實測 47 支全過，約 12 分鐘

## 開源狀態

本 repo 已於 2026-10-27 公開。公開前後的檢查與決定記在 [#326](https://github.com/Yooliang/asn/issues/326)。

- [x] **授權條款**：MIT（[LICENSE](LICENSE)）。第三方元件與例外檔案（`cloudflare/edge-tts/drm.js` 照 LGPL-3.0）見 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。之後加密相關選型仍要避開 AGPL／GPL 實作（見 [docs/research/03-encryption-protocols.md](docs/research/03-encryption-protocols.md)）。
- [x] **金鑰掃描**：2026-10-27 用 gitleaks 掃過全部分支的歷史（`--log-opts=--all`），12 筆命中逐筆看過，都不是真的機密（Supabase anon 公開金鑰、測試用假字串、edge-tts 的公開常數），沒有 service role 金鑰。結果記在 [#326](https://github.com/Yooliang/asn/issues/326)。
- [x] **歷史紀錄**：決定**不改寫歷史**，直接公開現有歷史（含從 Irori 抽出的部分）。依據是上面的金鑰掃描沒有找到要靠改寫歷史才能清掉的機密；整理歷史另案處理，不擋公開。
- [x] **漏洞回報管道**：見 [SECURITY.md](SECURITY.md)。
- [x] **main 分支保護**：已禁止強制推送與刪除分支。
- [x] **`.gitignore`**：已涵蓋 `.env`、`*.key`、`.asn/`、`.irori-relay/`、`supabase/.temp/`、`site/.firebase/`。
- [ ] **清理既有檔案中的私人資訊**：文件裡的本機絕對路徑已陸續換成泛用寫法；個人暱稱、內部工作階段名稱、設備與使用者的對應等仍散見於交接與設計文件，繼續分批清理。
- [ ] **移除舊後台殘留**：後台已在 2026-10-21 切換到新專案（見 [docs/MIGRATION.md](docs/MIGRATION.md)），但 `supabase/functions/irori-relay/`、`supabase/sql/` 還在，要等舊後台停用後清掉。
- [ ] 補 `CONTRIBUTING`、行為準則；確認官網隱私權政策與條款與開源後的實際行為一致。
