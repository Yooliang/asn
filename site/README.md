# ASN 官方網站（site）

純靜態網站（HTML／CSS，無建置步驟），放在 Firebase Hosting（Google Cloud 專案 `asnmessenger`，預設網址 https://asnmessenger.web.app）。
同時是 Google 登入同意畫面要求的「應用程式首頁、隱私權政策、服務條款」。

| 頁面 | 檔案 |
|---|---|
| 首頁 | `public/index.html` |
| 隱私權政策 | `public/privacy.html`（網址 `/privacy`） |
| 服務條款 | `public/terms.html`（網址 `/terms`） |
| 雲端代理技能說明 | `public/skill/`（`/skill/`；說明本體 `asn-cloud-agent.md`，輕量檢查 `version.json`） |

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
