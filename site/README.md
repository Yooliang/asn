# ASN 官方網站（site）

純靜態網站（HTML／CSS，無建置步驟），放在 Firebase Hosting（Google Cloud 專案 `asnmessenger`，預設網址 https://asnmessenger.web.app）。
同時是 Google 登入同意畫面要求的「應用程式首頁、隱私權政策、服務條款」。

| 頁面 | 檔案 |
|---|---|
| 首頁 | `public/index.html` |
| 隱私權政策 | `public/privacy.html`（網址 `/privacy`） |
| 服務條款 | `public/terms.html`（網址 `/terms`） |
| 主機核准頁 | `public/link/`（`/link/?code=ABCD-2345`；測試 `tests/approve_page.test.mjs`；Supabase Redirect URLs 要加 `https://asnmessenger.web.app/link/`） |
| 藍圖與更新日誌 | `public/roadmap.html`（`/roadmap`；測試 `tests/roadmap_page.test.mjs`） |
| 雲端代理技能說明 | `public/skill/`（`/skill/`；說明本體 `asn-cloud-agent.md`，輕量檢查 `version.json`） |

## 藍圖與更新日誌頁怎麼更新

- **更新日誌**：來源是 `relay/asn/CHANGELOG.md`（唯一來源）。發版後執行 `node site/make-roadmap-page.mjs`，會把最近 10 版寫進頁面的標記區段；守門測試會檢查頁面與來源一致，忘了跑會變紅。
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
