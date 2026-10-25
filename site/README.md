# ASN 官方網站（site）

純靜態網站（HTML／CSS，不用前端框架、頁面沒有執行階段腳本；只有「共用版面」要在改完後跑一支產生腳本），放在 Firebase Hosting（Google Cloud 專案 `asnmessenger`，預設網址 https://asnmessenger.web.app）。
同時是 Google 登入同意畫面要求的「應用程式首頁、隱私權政策、服務條款」。

| 頁面 | 檔案 |
|---|---|
| 首頁 | `public/index.html` |
| 隱私權政策 | `public/privacy.html`（網址 `/privacy`） |
| 服務條款 | `public/terms.html`（網址 `/terms`） |
| 主機核准頁 | `public/link/`（`/link/?code=ABCD-2345`；測試 `tests/approve_page.test.mjs`；Supabase Redirect URLs 要加 `https://asnmessenger.web.app/link/`） |
| 藍圖與更新日誌 | `public/roadmap.html`（`/roadmap`；測試 `tests/roadmap_page.test.mjs`） |
| 邀請加入頁 | `public/i/`（`/i/…`，有自己的腳本與較嚴的 CSP） |
| 雲端代理技能說明 | `public/skill/`（`/skill/`；說明本體 `asn-cloud-agent.md`，輕量檢查 `version.json`） |

## 共用版面：選單、Logo、圖示怎麼改

每一頁的頁首（Logo＋選單）、頁尾連結、網站圖示 `<link>` 都只在 `make-layout.mjs` 寫一份（`NAV`、`BRAND`、`FOOTER_NAV`、`PAGES`），再寫進各頁標記區段 `<!-- layout:header:start … -->` 到 `<!-- layout:header:end -->`（另有 `head`、`footer` 兩種）之間。**區段內不要手改。**

- **改選單**：編輯 `make-layout.mjs` 的 `NAV`，執行 `node site/make-layout.mjs`。順序固定：首頁、功能、畫面、下載、藍圖與更新日誌、隱私權政策、服務條款；首頁的錨點在別的頁要寫完整連結（`/#features`）。目前頁自動加 `aria-current="page"` 並高亮。
- **新增一頁**：在 `PAGES` 加一筆（`current` 是要高亮的項目，沒有對應項目就填 `null`），頁面裡放好標記區段（可抄 `privacy.html`），再執行腳本。
- **Logo**：`public/img/logo.svg`，與 App 的 `relay/asn/ui/img/logo.svg`（小機器人，電腦版與安卓圖示都由它而來）相同；`img/favicon-32.png`、`img/apple-touch-icon.png`（180，淺藍底）與 `favicon.ico` 由 App 的 `src-tauri/icons/icon.png` 縮出。
- 窄螢幕的排版在 `style.css`（`.top`、`.nav`）；高亮不改字重，避免各頁寬度不同而換行位置不一樣。
- 守門測試：`node --test --test-force-exit tests/site_layout.test.mjs`（各頁共用區段與腳本一致、選單順序、高亮、Logo 與圖示檔、沒有行內樣式／腳本）。忘了跑腳本會變紅。
- 不在共用版面內：`link/`（核准頁，自己的版面與較嚴的 CSP，只套網站圖示）、`ads/policy.html`（App 內嵌的廣告大頁，自帶樣式）。

## 藍圖與更新日誌頁怎麼更新

- **更新日誌**：來源是 `relay/asn/CHANGELOG.md`（唯一來源）。發版後執行 `node site/make-roadmap-page.mjs`，會把最近 10 版寫進頁面的標記區段；守門測試會檢查頁面與來源一致，忘了跑會變紅。
- **各家 AI 支援總表**（`#matrix`）：手寫的 HTML 表格，列＝各家 AI、欄＝開啟／關閉／接手／切換模型／群組聊天／帳號切換。狀態只有六種（已完成並驗證、已完成未驗證、進行中、尚未做、待確認、不適用），一律對照主線程式與 issue／PR 填，查不到依據標「待確認」；格子內的 issue／PR 編號只寫純文字（專案未公開、網站的內容安全政策也不允許外部連結）。每次發版或相關 PR 合併後，連同下面的藍圖一起更新；守門測試只檢查結構（欄位、狀態、原因），內容對不對靠人核對。
- **藍圖**：手寫在 `roadmap.html` 的三欄（已完成、進行中、規劃中），依 `docs/ROADMAP.md` 與 issue 的進度調整，並更新頁首的「最後整理」日期。
- 頁面只放可公開的內容（不放電子郵件、本機路徑、金鑰），也不能用行內樣式或腳本（網站的內容安全政策不允許）。

## 本機預覽

```
npx --yes http-server site/public -p 5179
```

開 http://127.0.0.1:5179 。

## 部署

```
cd site
firebase deploy --only hosting --project asnmessenger
```

**部署前要小良哥確認**；不要放 exe 等執行檔（免費方案不適合），下載區等開放時另行處理。
`shots/` 是本機截圖，已列入 .gitignore。
