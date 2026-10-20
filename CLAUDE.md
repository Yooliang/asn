# ASN 專案守則

- 回覆一律使用繁體中文；給人看的文字不要中英夾雜（型別、變數的英文名稱只留在註解與 log）。
- 不讀、不印任何金鑰（節點金鑰、service role、`.irori-relay` 目錄內容等）；提交前確認沒有金鑰進入歷史。
- 後端目前仍在 Irori 的 Supabase 專案：未經明確同意，不部署 Edge Function、不對資料庫套用 migration。
- `relay/machine`、`relay/cloud-agent` 的程式會在 Linux 上跑，檔案一律 LF（見 `.gitattributes`）。
- 改動先跑對應資料夾的測試（指令見 README）。
- 不用整批 taskkill；只關自己啟動並記下 PID 的程序。
