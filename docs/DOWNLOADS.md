# 下載區：固定網址、用途、安裝步驟、發版

下載頁 `web/download/index.html` **不放任何下載連結**（`tests/test_landing.py` 的規則：開放下載前不放 github／.apk）。
要給人的時候，把下面的固定網址直接傳給對方。檔案放在 Supabase Storage 公開 bucket `downloads`，
`firebase.json` 用 302 轉址，所以**更新檔案不用重新部署網頁**。

| 網址 | 內容 | 轉到 |
|---|---|---|
| `https://irori.web.app/download/irori.apk` | 手機 App | `…/storage/v1/object/public/downloads/irori.apk` |
| `https://irori.web.app/download/irori-tv.apk` | 電視 App | `…/downloads/irori-tv.apk` |
| `https://irori.web.app/download/asn-windows.zip` | Windows 小程式（收發室橋＋安裝程式，新檔名） | `…/downloads/asn-windows.zip` |
| `https://irori.web.app/download/irori-windows.zip` | 同上，**舊檔名保留**：內容與 asn-windows.zip 完全相同，舊連結仍可下載（D10） | `…/downloads/irori-windows.zip` |
| `https://irori.web.app/download/downloads.json` | 各檔版本（git 短 sha＋日期）、大小、sha256 | `…/downloads/downloads.json` |
| `https://irori.web.app/relay/SKILL.md` | Claude Code skill「asn-relay」本體（舊名 irori-relay，已安裝的人不受影響） | 網頁本身（不經轉址） |
| `https://irori.web.app/relay/INSTALL.txt` | 「安裝 skill」用的話，貼給 Claude Code | 網頁本身 |

Storage 的基底：`https://hwtahctsgjcemtwzlvnq.supabase.co/storage/v1/object/public/downloads/`。

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
node tools/release/build_downloads.mjs              # 輸出到 %TEMP%\asn-downloads\：asn-windows.zip、irori-windows.zip（同內容舊檔名）、downloads.json
```

（要把 APK 也列進 `downloads.json`：加 `--include <路徑>\irori.apk`，可重複。）打包前先 commit——工作樹有未提交的
`relay/machine` 變動時版本會標 `-dirty`。同一個 commit 打兩次，zip 的 sha256 相同。

上傳（service_role 用 `npx supabase projects api-keys --project-ref hwtahctsgjcemtwzlvnq -o json` 取，**不要印出、不要進 repo**；
`x-upsert: true` 覆蓋舊檔）：

```
curl -sS -X POST "https://hwtahctsgjcemtwzlvnq.supabase.co/storage/v1/object/downloads/asn-windows.zip" \
  -H "Authorization: Bearer $SERVICE_KEY" -H "x-upsert: true" -H "Content-Type: application/zip" \
  --data-binary @"$TEMP/asn-downloads/asn-windows.zip"
curl -sS -X POST "https://hwtahctsgjcemtwzlvnq.supabase.co/storage/v1/object/downloads/irori-windows.zip" \
  -H "Authorization: Bearer $SERVICE_KEY" -H "x-upsert: true" -H "Content-Type: application/zip" \
  --data-binary @"$TEMP/asn-downloads/irori-windows.zip"
curl -sS -X POST "https://hwtahctsgjcemtwzlvnq.supabase.co/storage/v1/object/downloads/downloads.json" \
  -H "Authorization: Bearer $SERVICE_KEY" -H "x-upsert: true" -H "Content-Type: application/json" \
  --data-binary @"$TEMP/asn-downloads/downloads.json"
```

**不用重新部署網頁**（轉址規則在 `firebase.json`；新增檔名 `asn-windows.zip` 時要先在轉址表加一條 `/download/asn-windows.zip` 並部署一次，舊的 `irori-windows.zip` 那條不要刪）。bucket 的 `allowed_mime_types`
要含 `application/zip`（原本只有 apk 與 json）。上傳後驗證：`curl -sIL https://irori.web.app/download/asn-windows.zip`
應該 302 → 200，大小與 `downloads.json` 一致；Storage 公開物件有 CDN 快取，剛覆蓋後可能要等一下才看到新版。

手機／電視 APK：在 `android/` 跑 `./gradlew assemblePhoneDebug assembleTvDebug`，發版後上傳到同一個 bucket 的 `downloads/irori.apk`、`irori-tv.apk`（`x-upsert: true`）。

## 4. 測試

`tests/build_downloads.test.mjs`（zip 內容清單與排除規則、BOM／CRLF、import 完整性、downloads.json、firebase.json、註冊小幫手對假伺服器）、
`tests/windows_installer.test.mjs`（解開 zip 後用暫存家目錄跑 install／uninstall：預覽、完整流程、更新、前綴、失敗不留殘骸、
Node 太舊、沒有 Claude、只結束 pid 檔記的程序）。全部用本機假伺服器，不碰真的仲介、不建排程。
