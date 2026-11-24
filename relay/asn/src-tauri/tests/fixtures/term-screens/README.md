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
| claude-limit-menu.real.txt | 額度用完後的選單（**依 11-14 截圖逐字轉錄**，#1512） | 標題「What do you want to do?」、「Stop and wait for limit to reset」「Wait here, then continue automatically at …」、頁尾「Enter to confirm」；付費的「Switch to usage credits」排第 3 |
| claude-limit-menu-paid-first.synthetic.txt | 同上，付費選項排在前面（合成） | 認字不認編號：手機給第 3、4 項 |
| claude-limit-menu-auto-armed.synthetic.txt | 同上，已設好自動繼續（合成） | 沒有「Wait here」→ 需要人工確認、不給按鈕 |
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

## 第二批（todo-next-162，2026-11-03）

工作機、claude 2.1.317、窗格 80x24。這台已登入，也接受過略過權限警告，所以**不等於乾淨機器**。遮罩方式同上。

| 檔案 | 狀態 |
|---|---|
| claude-permission-write.txt | 權限詢問：寫檔 |
| claude-permission-webfetch.txt | 權限詢問：讀網頁 |
| claude-plan-approval.txt | 計畫確認 |
| claude-ask-user-question.txt | AskUserQuestion |
| claude-auto-mode-teach.txt | auto 模式的說明選單，下方還有輸入框 |
| claude-lookalike-model-text.txt | 內容長得像提示，實際上是閒置 |
| claude-lookalike-tool-output.txt | 同上，內容來自工具輸出 |
| claude-bypass-warning.synthetic.txt | 第一次略過權限的警告：**未實測**，字串取自執行檔，排版是推測的 |

## #1445 加的

- `claude-permission-long-bash.txt`：2026-11-14 在測試用的電腦上，用全新的空資料夾開一次性的 claude 2.1.323（pywinpty＋pyte 讀畫面，窗格 120x45）。
  - 讓它跑一條 90 行的 `python -c`（只有 print）。權限框跳出來就按 Esc 拒絕，沒有執行。
  - 權限框裡的指令照原樣全部列出，沒有「… +N lines」這種收起記號。框比畫面高，所以頂端的實線不在畫面裡。
  - 內容只有 print 文字，沒有需要遮掉的東西。第一行開頭的 `u` 是捲動殘留，照原樣保留。

## #1799 加的（合成，貼近真實排版）

回覆裡有編號清單和表格、對話區有使用者提問的回顯：選單偵測的誤報反例。個人資訊已不含。

| 檔案 | 狀態 | 判斷重點 |
|---|---|---|
| claude-1799-reply-list-table-no-input.synthetic.txt | 回覆含編號清單＋表格，底部看不到輸入框（被捲出） | 不是選單；回顯 `❯ 提問` 不算選單游標 |
| claude-1799-echo-numbered-no-input.synthetic.txt | 回顯本身是 `❯ 1. …`，底部看不到輸入框 | 不是選單；游標後面接 ● 回覆 |
| claude-1799-reply-list-table-idle.synthetic.txt | 同上，輸入框與狀態列都在 | 不是選單（舊程式本來就對，當護欄） |

## #2256 加的

| 檔案 | 內容 | 預期 |
|---|---|---|
| claude-permission-scrolled-more-lines.txt | 擁有者截圖逐字抄：長指令的權限框被捲動，標題捲出畫面；有安全提示（左邊框「│ 」）、虛線分隔、選項只有 Yes／No；選項下方有 `↑ 10 more lines`；頁尾 `Esc to cancel · Tab to amend · ctrl+x ctrl+k twice to stop background agents`；最底實線右邊帶視窗名 | 判成 Permission、不完整（手機只給拒絕）。檔案是 LF，測試用 `.replace("\r\n", "\n")` 讀，LF／CRLF 都能處理 |
