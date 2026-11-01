# 終端畫面樣本（C1，0.2.1 讀畫面判斷用）

`wezterm cli get-text` 讀到的純文字畫面，給 C2（本機判斷）與 C3（Jev 判讀）當測試資料。

## 怎麼取的

- 2026-10-31 在工作機用 wezterm-mux-server（20240203-110809-5046fc22）開窗格取樣，窗格 80x24。
- claude 2.1.316、pi 1.4.0。
- 只在新建的暫存資料夾裡取，不讀正在跑的夥伴視窗。
- 檔名結尾是 `.synthetic.txt` 的不是真實畫面：重現不了的狀態（額度用完、登入失效），字串取自 claude 執行檔內嵌的文字。

## 入庫前已遮掉

網址參數、`sk-` 開頭的金鑰、星號遮罩與尾碼、32 字以上的長字串、email、`req_` 請求編號、使用者名稱（`<user>`）、pi 擴充顯示的個人狀態列（`<個人狀態列已遮>`）。

## 檔案

| 檔案 | 狀態 | 判斷重點 |
|---|---|---|
| claude-trust-folder.txt | 卡信任資料夾 | 「Quick safety check」「Yes, I trust this folder」；**預設選項是 No, exit** |
| claude-trust-folder-yes-selected.txt | 同上，游標移到 Yes | 代答前核對游標位置用 |
| claude-firstrun-theme.txt | 第一次執行：選主題 | 「Choose the text style」 |
| claude-login-method.txt | 未登入：選登入方式 | 「Select login method」 |
| claude-login-expired.synthetic.txt | 登入失效（合成） | 「Please run /login」 |
| claude-usage-limit.synthetic.txt | 額度用完（合成） | 「You've hit your limit · resets」 |
| claude-idle-auto-mode.txt | 閒置（auto 模式） | 空輸入框＋狀態列 |
| claude-idle-manual-mode.txt | 閒置（manual 模式） | 狀態列「manual mode on」 |
| claude-running.txt | 執行中 | 「✻ …」動態字樣、沒有「done」 |
| claude-permission-bash.txt | 卡權限詢問 | 「Do you want to proceed?」＋編號選項 |
| claude-idle-after-reply.txt | 回完一輪後閒置 | 「✻ … · done」 |
| pi-trust-folder.txt | 卡信任資料夾 | 「Trust project folder?」；**預設選項是 Trust**（跟 claude 相反） |
| pi-idle.txt | 閒置（已登入） | 底部模型列 |
| pi-idle-no-auth.txt | 閒置（沒有設定，第一次執行） | 同上，模型是預設值 |
| pi-error-401-invalid-key.txt | 金鑰無效 | 「Error: … (401)」「invalid_api_key」 |
| pi-error-400-credit-low.txt | 帳戶額度不足 | 「Error: 400」「credit balance is too low」 |
| pi-crash-verbatim-cwd.txt | 啟動就當掉（#601） | 「Error: ENOENT … mkdir」、Node 堆疊 |

## 還缺

- claude 卡額度、登入失效的真實畫面（遇到時再補，同名去掉 `.synthetic`）。
- pi 的權限詢問、執行中動態字樣（這次的請求很快就回錯誤，沒有取到）。
- codex、gemini：由 w02/Gemini 協助蒐集。
