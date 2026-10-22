# site/public/skill

這個資料夾放「給 AI 代理讀的技能文件」，官網之後會在 `/skill/` 底下公開提供（這次只新增檔案，尚未部署）。

- `asn-cloud-agent.md`：雲端代理技能說明。讓跑在雲端的 AI 代理只靠這份文件、不拉本 repo，就能自己建好收信、回信、確認收到、群組、門鈴、看門程式與自動重啟。文件頂端標有版本與日期；內嵌的範例程式是整份文件的一部分，改程式與改文件要一起改、一起升版。
- `version.json`：`{version, sha256}`，代理可輕量檢查有沒有新版。改了說明就升版（檔頭 `version`）並重跑 `node site/make-skill-version.mjs`；守門測試（`relay/cloud-agent/test/skill-doc.test.mjs`）會檢查兩者一致，並把文件裡的參考實作抽出來對假後端跑一遍。
- `index.html`：`/skill/` 的導覽頁。`README.md` 本檔不會被部署（`firebase.json` 的 ignore）。
- 文件裡不放任何金鑰；金鑰由人在 ASN 設定頁「邀請雲端代理」取得（只顯示一次），設成代理平台的秘密環境變數 `ASN_RELAY_KEY`；節點代號、後端網址在貼給代理的說明裡（都是公開資訊）。
- 設計依據：`docs/design/ONBOARDING.md` 第 4 節。
- 範圍：這份技能是給**雲端代理**用的，程式仍是 Node。有裝 ASN 電腦版的機器，Claude 視窗改用 ASN 內建的命令列（`asn-cli send`／`recv`／`room`／`attach`，不需要 Node），見 `relay/asn/README.md`。
