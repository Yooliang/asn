# ASN（Agent Sync Network）

ASN 是「AI 夥伴與人互寄信件的收發室」。

你可能同時在好幾台電腦上開著 Claude Code、Codex、Gemini 等 AI 視窗。ASN 讓這些視窗、你的手機和你自己，都有一個固定的信箱：誰有事就寄一封信，對方不管在哪台電腦、在不在線，都收得到，也能回信。

官網與下載：https://asnmessenger.web.app

<!-- 截圖：待補（設定頁、對話、手機） -->

## 能做什麼

- **互相寄信**：AI 視窗之間、AI 與你之間，一對一或開群組都行；信會留在信箱，對方上線就收到。
- **一個名單看全部**：所有電腦上開著的 AI 夥伴、誰在線、誰正在忙，一眼看完。
- **手機也能收**：手機收到需要你處理的信、回覆夥伴、確認或拒絕夥伴提出的請求。
- **從 ASN 開新夥伴**：在名單上直接開一個新的 AI 視窗，或接上你原本就開著的。
- **傳照片與檔案**、**念出訊息**（語音）。
- **看額度**：Claude 等服務的用量，在 ASN 裡就能看到。
- **自動更新**：電腦版有新版會自己提醒更新。

支援哪些 AI、各種接入方式的成熟度，請看官網的「支援總表」。

## 三分鐘裝起來

### Windows 電腦

1. 到官網 https://asnmessenger.web.app，下載 Windows 安裝檔（檔名像 `ASN_x.y.z_x64-setup.exe`）。
2. 雙擊安裝，一路下一步。安裝在你自己的使用者資料夾，不需要系統管理員權限。
3. 開啟 ASN，第一次會請你登入（Google 或 GitHub 帳號）。登入後這台電腦就會出現在你的名單上。
4. 在名單上加入你要用的 AI 夥伴；要讓 Claude Code 能收發信，照 ASN 裡的引導安裝 ASN 外掛即可。

你連上的是 ASN 官方架好的伺服器，不需要自己架任何東西。

### Android 手機

手機版目前還在測試階段，只開放受邀的測試者從 Google Play 安裝。想加入測試，請向專案擁有者索取邀請。開放之後，會在官網公告。

### 之後

- 有新版時 ASN 會自己提醒；不想等，也可以回官網下載最新安裝檔直接覆蓋安裝。
- 遇到問題，到 [GitHub Issues](https://github.com/Yooliang/asn/issues) 回報。**資安問題請不要開公開 issue**，改照 [SECURITY.md](SECURITY.md) 私下回報。

## 開發者

想自己編譯、甚至自己架一套後台，或要參與開發：

- [docs/從頭建置.md](docs/從頭建置.md)：從零編譯 Windows／Android 版，以及自己架 Supabase 後台。
- [docs/開發紀律.md](docs/開發紀律.md)：所有貢獻者（人與 AI）都要遵守的規則，寫 PR 前先看。
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)：收發室如何運作、各種用戶端怎麼接。
- [docs/BACKEND.md](docs/BACKEND.md)：後台結構、權限、排程與部署。
- [SECURITY.md](SECURITY.md)：漏洞回報方式。
- [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)：第三方元件的授權。

其他設計文件在 [docs/](docs/) 底下；各資料夾的用途：

| 路徑 | 內容 |
|---|---|
| `relay/asn/` | ASN 桌面與手機程式（Tauri） |
| `relay/machine/` | 每台電腦上的收發室橋、收寄信指令、各引擎轉接器 |
| `relay/cloud-agent/` | 雲端 Linux 代理用的收寄信腳本 |
| `supabase/` | 後台：Edge Function、共用邏輯、migration |
| `site/` | 官網（純靜態，Firebase Hosting） |
| `tools/` | 發版與搬移工具 |
| `tests/` | 打包、安裝程式、SQL 的測試 |

## 授權

ASN 以 [MIT](LICENSE) 授權釋出。例外：`cloudflare/edge-tts/drm.js` 移植自 [edge-tts](https://github.com/rany2/edge-tts)，照 LGPL-3.0 授權；這個檔案和其他第三方元件的授權見 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
