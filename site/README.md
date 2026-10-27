# ASN 官方網站（site）

純靜態網站（HTML／CSS，不用前端框架；只有「共用版面」要在改完後跑一支產生腳本。例外：藍圖與開發日誌兩頁用外部腳本從資料庫讀內容），放在 Firebase Hosting（Google Cloud 專案 `asnmessenger`，預設網址 https://asnmessenger.web.app）。
同時是 Google 登入同意畫面要求的「應用程式首頁、隱私權政策、服務條款」。

| 頁面 | 檔案 |
|---|---|
| 首頁 | `public/index.html` |
| 隱私權政策 | `public/privacy.html`（網址 `/privacy`） |
| 服務條款 | `public/terms.html`（網址 `/terms`） |
| 主機核准頁 | `public/link/`（`/link/?code=ABCD-2345`；測試 `tests/approve_page.test.mjs`；Supabase Redirect URLs 要加 `https://asnmessenger.web.app/link/`） |
| 藍圖 | `public/roadmap.html`（`/roadmap`；內容在資料庫，見下方；測試 `tests/roadmap_page.test.mjs`） |
| 開發日誌 | `public/log.html`（`/log`；會議與發版合成一條時間軸，內容在資料庫） |
| 邀請加入頁 | `public/i/`（`/i/…`，有自己的腳本與較嚴的 CSP） |
| 雲端代理技能說明 | `public/skill/`（`/skill/`；說明本體 `asn-cloud-agent.md`，輕量檢查 `version.json`） |

## 共用版面：選單、Logo、圖示怎麼改

每一頁的頁首（Logo＋選單）、頁尾連結、網站圖示 `<link>` 都只在 `make-layout.mjs` 寫一份（`NAV`、`BRAND`、`FOOTER_NAV`、`PAGES`），再寫進各頁標記區段 `<!-- layout:header:start … -->` 到 `<!-- layout:header:end -->`（另有 `head`、`footer` 兩種）之間。**區段內不要手改。**

- **改選單**：編輯 `make-layout.mjs` 的 `NAV`，執行 `node site/make-layout.mjs`。順序固定：首頁、功能、畫面、下載、藍圖、開發日誌、隱私權政策、服務條款；首頁的錨點在別的頁要寫完整連結（`/#features`）。目前頁自動加 `aria-current="page"` 並高亮。
- **新增一頁**：在 `PAGES` 加一筆（`current` 是要高亮的項目，沒有對應項目就填 `null`），頁面裡放好標記區段（可抄 `privacy.html`），再執行腳本。
- **Logo**：`public/img/logo.svg`，與 App 的 `relay/asn/ui/img/logo.svg`（小機器人，電腦版與安卓圖示都由它而來）相同；`img/favicon-32.png`、`img/apple-touch-icon.png`（180，淺藍底）與 `favicon.ico` 由 App 的 `src-tauri/icons/icon.png` 縮出。
- 窄螢幕的排版在 `style.css`（`.top`、`.nav`）；高亮不改字重，避免各頁寬度不同而換行位置不一樣。
- 守門測試：`node --test --test-force-exit tests/site_layout.test.mjs`（各頁共用區段與腳本一致、選單順序、高亮、Logo 與圖示檔、沒有行內樣式／腳本）。忘了跑腳本會變紅。
- 不在共用版面內：`link/`（核准頁，自己的版面與較嚴的 CSP，只套網站圖示）、`ads/policy.html`（App 內嵌的廣告大頁，自帶樣式）。

## 藍圖與開發日誌：內容在資料庫

2026-10-27 起，藍圖頁（`/roadmap`）與開發日誌頁（`/log`）的內容**不再寫在 HTML 裡**，改放 Supabase 的公開唯讀表；頁面只剩骨架，由 `public/timeline/` 的外部腳本讀資料、用時間軸畫出來。之前的 `make-roadmap-page.mjs`、`site/meetings.json` 已拿掉，`relay/asn/CHANGELOG.md` 仍是 App 內「更新」記錄的來源，但官網不再讀它。

| 表（`public` schema） | 內容 | 顯示在 |
|---|---|---|
| `asn_site_releases` | 一版一列：版本、日期、更新說明條列、發佈到哪裡、發版 commit、補充說明 | 藍圖時間軸的過去節點、開發日誌的「發版」 |
| `asn_site_meetings` | 一場小會議一列：時間、出席、進度、決議、分派、改善意見（都是字串陣列） | 開發日誌的「會議」 |
| `asn_site_lanes`、`asn_site_roadmap_items` | 藍圖三欄與待辦三欄的欄位與項目（狀態 released／doing／planned／decide，可綁版本） | 藍圖時間軸（現在、未來）與「待辦與優先順序」 |
| `asn_site_matrix_columns`、`_rows`、`_cells` | 各家 AI 支援總表（欄＝功能、列＝AI、格＝狀態＋說明） | 「各家 AI 支援總表」 |

- 表定義：`supabase/migrations/20261027100000_site_content.sql`（欄位說明寫在 SQL 註解）；搬家時的全部內容：`20261027100100_site_content_seed.sql`，由 `site/tools/extract-roadmap-seed.mjs` 從凍結快照 `site/tools/seed-source/` 產生（只在搬家時用，之後以資料庫為準，不要再改快照）。
- **內文格式**：不存 HTML。只有 `**粗體**`、`` `程式碼` ``、`#123`（議題編號的文字樣式），以換行開頭的「- 」行是子項目；項目的 `refs` 欄會在頁面上連到 GitHub 的議題頁。頁面一律用 textContent 建節點，資料庫內容不會被當 HTML。
- **現在怎麼更新（第二期，#400）**：用 `asn-cli site` 指令，經 relay Edge Function（節點金鑰認證）寫入，不用再手下 SQL（anon 仍然只能讀）：
  - 發版：`asn-cli site release --version 0.1.96 --date 2026-10-28 --commit abc1234 --item "新增：…" --item "修正：…" --platform 官網 --platform 家用機`。依版本新增或更新；已有的版本只改有給的欄位（`--commit ""`、`--notes ""` 清掉）。
  - 小會議：`asn-cli site meeting --file meeting.json`。檔案格式同以前的 `site/meetings.json`：`time`（台北時間 `2026-10-28 08:00`）、`attendees`、`progress`、`decisions`、`assignments`、`improvements`（字串或字串陣列，一行一項，沒內容寫「無」）；同一時間再送一次＝整筆覆寫。
  - 藍圖與待辦：`asn-cli site item --key todo-next-15b --section todo --lane next --title "…" --body "…" --ref 400 --status doing`（新項目要 section、lane、body、status）；之後改狀態只要 `asn-cli site item --key todo-next-15b --status released --version 0.1.96`。這一期不能刪除，要下架就改狀態。
  - 誰能寫：只有官網寫入名單 `relay.site_writers`（以帳號／租戶為單位）上的帳號；名單外回「不在官網寫入名單」。migration 不放任何一列，**要由負責人把專案擁有者的租戶加進去**：`insert into relay.site_writers (tenant_id, note) values ('<租戶 id>', '專案負責人');`。每次寫入記在 `relay.site_write_log`（不公開）；每個帳號每小時最多 120 次。
  - 後台會擋：HTML 標籤、電子郵件、本機路徑、金鑰樣式（頁面是公開的），以及不合表格限制的長度與格式。後端：`supabase/migrations/20261027200000_site_write.sql`、`supabase/functions/_shared/site_write.ts`。
- 支援總表（`asn_site_matrix_*`）這一期還沒有指令，仍由維護者下 SQL（`update … where row_key/column_key`）。
- **內容安全政策**：只有這兩頁（`firebase.json` 的 `/{roadmap,log}{,.html}`）放寬成 `script-src 'self'` 與 `connect-src` 到 Supabase；其他頁維持全站的 `script-src 'none'`。Supabase 的 anon 公開金鑰沿用 `public/link/config.mjs`。
- 讀不到資料時畫面只寫「暫時讀不到資料，請稍後重新整理。」，細節進 console。
- 守門測試：`node --test --test-force-exit --test-timeout=120000 tests/roadmap_page.test.mjs`（種子 SQL 與產生腳本一致、兩頁沒有行內腳本、畫面程式不用 innerHTML、內容安全政策只對兩頁放寬、公開內容沒有個資與金鑰、時間軸排序）。

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
