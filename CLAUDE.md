# ASN 專案守則

- 回覆一律使用繁體中文；給人看的文字不要中英夾雜（型別、變數的英文名稱只留在註解與 log）。
- ASN 自己的 log（ui.log、bridge.log、mux.log 等）和狀態檔（各種 json）查問題時可以讀，只取相關的時段和行。節點金鑰（*.key）、login.bin、憑證、token、service role 照舊絕對不讀不印，可能含金鑰的檔一律不開；提交前確認沒有金鑰進入歷史。
- 後端目前仍在 Irori 的 Supabase 專案。部署（migration、Edge Function、發版、官網）由負責的 session 自行判斷執行，不需再徵求同意（2026-10-22 小良哥授權）；部署前先跑完全套測試並確認舊版用戶端不會壞。花錢與不可回復的資料刪除仍要先問。
- `relay/machine`、`relay/cloud-agent` 的程式會在 Linux 上跑，檔案一律 LF（見 `.gitattributes`）。
- 改動先跑對應資料夾的測試（指令見 README）。
- 不用整批 taskkill；只關自己啟動並記下 PID 的程序。
- 開 PR 一律掛要進的版本里程碑（`gh pr create --milestone 0.2.x`），不確定進哪一版就問 asn真；版號由 asn真 統一改；發版照里程碑清點，沒掛的不進。
- PR 不夾帶：跟這次無關的改動各開一張。
