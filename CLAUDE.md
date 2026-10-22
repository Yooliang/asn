# ASN 專案守則

- 回覆一律使用繁體中文；給人看的文字不要中英夾雜（型別、變數的英文名稱只留在註解與 log）。
- 不讀、不印任何金鑰（節點金鑰、service role、`~/.asn`（舊位置 `~/.irori-relay` 同）目錄內容等）；提交前確認沒有金鑰進入歷史。
- 後端目前仍在 Irori 的 Supabase 專案。部署（migration、Edge Function、發版、官網）由負責的 session 自行判斷執行，不需再徵求同意（2026-10-22 小良哥授權）；部署前先跑完全套測試並確認舊版用戶端不會壞。花錢與不可回復的資料刪除仍要先問。
- `relay/machine`、`relay/cloud-agent` 的程式會在 Linux 上跑，檔案一律 LF（見 `.gitattributes`）。
- 改動先跑對應資料夾的測試（指令見 README）。
- 不用整批 taskkill；只關自己啟動並記下 PID 的程序。
