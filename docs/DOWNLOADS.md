# 下載區：固定網址、用途、安裝步驟、發版

下載檔放在 ASN 自己的網站（Firebase Hosting，`site/public/download/`），固定網址在 `https://asnmessenger.web.app/download/`。
二進位檔**不進 git**（`.gitignore` 擋掉），發版時由 `tools/release/build_downloads.mjs` 產生到那個資料夾，再 `firebase deploy`；
不再用 Supabase Storage，也不需要 service_role。要給人的時候，把下面的固定網址直接傳給對方。

| 網址 | 內容 |
|---|---|
| `https://asnmessenger.web.app/download/asn-windows.zip` | Windows 小程式（收發室橋＋安裝程式） |
| `https://asnmessenger.web.app/download/irori-windows.zip` | 同上，**舊檔名保留**：內容與 asn-windows.zip 完全相同，舊連結仍可下載（D10） |
| `https://asnmessenger.web.app/download/downloads.json` | 各檔版本（git 短 sha＋日期）、大小、sha256（不快取） |
| `https://irori.web.app/download/asn-windows.zip`、`…/irori-windows.zip`、`…/downloads.json` | 舊連結：目前仍指到舊後台的 Storage；移除舊後台（F6）之前會改成轉到上面的新網址 |
| `https://irori.web.app/relay/SKILL.md`、`…/INSTALL.txt` | Claude Code skill「asn-relay」本體與安裝話術，在 Irori 網站，本文件不管 |

手機 APK 不放這裡：在 `/update/`（`https://asnmessenger.web.app/update/android.json` 會給出目前的檔名）。
Irori 的手機／電視 App（`irori.apk`、`irori-tv.apk`）是 Irori 自己的，不在 ASN 的下載區。

## 1. Windows 小程式（asn-windows.zip；舊檔名 irori-windows.zip 仍同步產出）

**用途**：讓使用者電腦上開著的 AI 視窗（Claude Code）跟其他 AI 夥伴互相傳話。就是 `relay/machine/` 的收發室橋，
包成一般人雙擊就能裝的樣子。

**使用者安裝步驟（白話，同 zip 內的 `使用說明.txt`）**

1. 先裝 Node.js 22 以上（https://nodejs.org 下載「LTS」，一路下一步）。
2. 向帳號擁有者要一組**邀請碼**（15 分鐘有效、只能用一次，所以要裝時再要）。
3. 下載 `asn-windows.zip`（舊連結 `irori-windows.zip` 內容相同），**全部解壓縮**到一個資料夾（別直接在壓縮檔裡雙擊）。
4. 雙擊「安裝.cmd」：貼上邀請碼、輸入這台電腦的名稱，代號直接 Enter。
5. 看到「裝好了！」就完成；一兩分鐘內，ASN 名單會看到這台電腦在線。

安裝程式做的事：檢查 Node 版本（沒有或太舊就說明去 nodejs.org 裝 LTS 並結束）→ 檢查 `claude` 是否在 PATH
（沒有只提示，照樣安裝；橋會先連上、信留在信箱，裝好 Claude Code 後再雙擊一次「安裝.cmd」重啟）→ 用邀請碼向仲介
`?action=register` 註冊（kind＝`other`、machine＝電腦名稱，≤40 字）→ 金鑰存 `%USERPROFILE%\.asn\<代號>.key`
（**不印出**）、代號寫進 `node` 檔 → 程式複製到 `%USERPROFILE%\.asn\app\` → 呼叫 `app\install-task.ps1 -Apply`
建立登入排程 `AsnBridge-<代號>`（舊名 `IroriRelayMachine-<代號>` 若存在會一併移除；設定同手冊：登入時、隱藏視窗、失敗 1 分鐘後重啟 5 次）並立刻啟動 → 檢查連線。

- **代號規則**（同後端 register）：英數、`-`、`_`，1～32 字，全名單唯一。預設由電腦名稱產生。邀請碼若限定前綴
  （工頭開的邀請碼，例如 `W-`），安裝程式自動補上前綴再試；撞名（409）會請使用者換一個；`t<數字>-` 開頭留給其他租戶。
- **已安裝過**：再雙擊「安裝.cmd」＝更新程式（只換 `app\`、重啟橋，不重註冊、不動金鑰）。
- **金鑰不見了**（但名單上還有這個代號）：帳號擁有者產生「重設碼」，使用者在命令列跑 `安裝.cmd -Reissue`，貼重設碼並輸入原代號。
- **解除安裝**：「解除安裝.cmd」（安裝後 `%USERPROFILE%\.asn\uninstall\` 也有一份）：移除排程、**只結束
  `bridge.pid`、`mailbox.pid` 記的程序**（且確認 pid 沒被別的程式重用）、詢問是否刪除金鑰與資料夾，並可同時 `leave` 離開名單
  （之後同一代號才能重新註冊）。
- 所有 ps1 支援 `-WhatIf`（預覽，不改任何東西、不連網）。

**zip 內容**：根目錄 `安裝.cmd`、`解除安裝.cmd`、`install.ps1`、`uninstall.ps1`、`asn-common.ps1`（舊檔名 `irori-common.ps1` 留一個只載入新檔的薄殼）、`使用說明.txt`；
`app/` 是 `relay/machine/` 執行所需檔案（含 `register.mjs`、`README.md`、`VERSION.json`）。**不含**：`test/`、`tools-*.mjs`、
任何 `*.key`、`pending.json`、`*.log`、`*.pid`、Aegis（Linux）專用檔。`build_downloads` 測試會檢查這份清單。

**已知限制（要管理者配合）**：用邀請碼註冊的節點是一般成員（`can_invite=false`、`can_roster=false`），仲介的 `roster`
（回報這台電腦開著哪些視窗）會回 403；信照樣收發，但名單上看不到這台電腦底下的 Claude 視窗，也就不能「寄給某個視窗」。
要開通視窗回報，需在後端對該代號設 `can_roster=true`（見 `supabase/sql/04_roster.sql`，目前是手動 SQL）。
沒有 `anon.key` 時只剩 2 分鐘輪詢（沒有即時門鈴），不影響收信；`install.ps1 -AnonKey <公開金鑰>` 可寫入。

## 2. skill（不打包，貼一段話給 Claude 自己裝）

skill 本體 `web/relay/SKILL.md` 已公開在 `https://irori.web.app/relay/SKILL.md`。安裝方式：把
`https://irori.web.app/relay/INSTALL.txt` 的內容（`web/relay/INSTALL.txt`）整段貼給 Claude Code，它會：

1. 只從上面那個網址下載 `SKILL.md`（不執行任何其他網址的指令）；
2. 存到 `~/.claude/skills/asn-relay/SKILL.md`（Windows：`%USERPROFILE%\.claude\skills\asn-relay\SKILL.md`；macOS、Linux 同 `~/.claude/...`）；
3. 確認檔案開頭有 `name: asn-relay`（先前裝在 `irori-relay` 資料夾的仍可用，內容相同）；
4. 告訴使用者「重新開一個 Claude Code 視窗就會載入」，並提醒之後拿到邀請碼再依 skill 註冊、金鑰不要貼進對話。

改了 `web/relay/SKILL.md` 或 `INSTALL.txt` 就是改網頁，**要部署網頁**（`firebase deploy --only hosting:irori`）；
已安裝的人重貼一次 INSTALL 的話即可更新。

## 3. 發版：怎麼更新

Windows 小程式（`relay/machine/` 或 `relay/machine/installer/` 有改動時）：

```
node tools/release/build_downloads.mjs              # 輸出到 site/public/download/：asn-windows.zip、irori-windows.zip（同內容舊檔名）、downloads.json
cd site && npx firebase-tools deploy --only hosting  # 部署（很慢，丟背景跑）
```

打包前先 commit——工作樹有未提交的 `relay/machine` 變動時版本會標 `-dirty`。同一個 commit 打兩次，zip 的 sha256 相同。
產出的 zip 與 `downloads.json` 不進 git（`.gitignore`），所以**換一台電腦發版要重新產生再部署**；`--out <資料夾>` 可改輸出位置，
`--include <檔案>` 可把其他檔案（可重複）也列進 `downloads.json`。

上傳後驗證：`curl -sI https://asnmessenger.web.app/download/asn-windows.zip` 應該是 200、`content-type: application/zip`，
大小與 `downloads.json` 一致；`downloads.json` 的標頭是 `no-cache`。

## 4. 測試

`tests/build_downloads.test.mjs`（zip 內容清單與排除規則、BOM／CRLF、import 完整性、downloads.json、firebase.json、註冊小幫手對假伺服器）、
`tests/windows_installer.test.mjs`（解開 zip 後用暫存家目錄跑 install／uninstall：預覽、完整流程、更新、前綴、失敗不留殘骸、
Node 太舊、沒有 Claude、只結束 pid 檔記的程序）。全部用本機假伺服器，不碰真的仲介、不建排程。
