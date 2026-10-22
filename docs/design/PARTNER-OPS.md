# 遠端管理夥伴視窗：改名、關視窗、轉交下一任（手機對話頁「⋯」選單）

小良哥 2026-10-22 需求：手機對話畫面右上角加「⋯」選單，可以對這位 AI 夥伴「改名」「關視窗」「轉交下一任」。
手機只下指令；視窗在電腦上，由那台電腦的 ASN 內建收發室執行。和「開新夥伴」（#158 第十三節）同一套路。

## 一、三個動作在電腦上做什麼

全部重用 `launch/switch.rs`（切換模型）已經驗過的機制：讀 `~/.claude/sessions/<pid>.json` 找到視窗 → 讀命令列 → 結束那個已確認的 pid（`kill_set`：只關 claude 那棵樹，不碰 ASN 本身）→ 照原參數重開（`rewrite_args`）。

| 動作 | 電腦上做的事 | 夥伴 ID 怎麼延續 |
|---|---|---|
| 改名 | 結束舊 pid，照原參數重開：`--resume <同一個 sessionId> -n <新名字>`，模型不變 | 同 session、名字變了＝同一位夥伴改名（PARTNER-ID 規則 1）；舊名 7 天轉寄 |
| 關視窗 | 先送關閉訊息（`post_close`），等不到再 `terminate`；只關那一棵 | 不變；夥伴 ID 留著，之後可以被接班 |
| 轉交下一任 | 結束舊 pid，照原參數開**新的 session**（不帶 `--resume`／`--continue`），名字不變，第一句話是固定的接班提示 | 名字相同、session 換了＝同一位夥伴換 session（規則 2），不需要 `partner_succeed` |

| 切換模型（10-22 小良哥追加） | 優先「不重開」：內建收發室寫控制檔 `~/.asn/control/<sessionId>.json`，視窗裡的 ASN mod（relay/claude-mod）讀到後以 `$.command.run({ command: 'model', … })` 執行 /model（引擎排隊到閒置才跑，不重開、不搶輸入）；沒有 mod 的視窗（Codex、未裝 mod、mod 沒在 30 秒內回報）退回 `model_switch_run`（關掉後 `--resume` 同 session 換 `--model`） | 同 session，不變 |

改名同理：有 mod 的視窗由 mod 執行 `/rename <新名字>`，不重開；沒有才走上表的重開。mod 執行後把結果寫回狀態檔（`~/.asn/status/<sessionId>.json` 已有），內建收發室據此回報 `ok`／`failed`。relay/claude-mod 歸家用正見，這段開 PR 給他審（或請他實作），控制檔格式先在本文件定案。

| 詳情（10-22 小良哥追加，唯讀） | 同一條佇列的 `info` 動作：內建收發室回報 PID、模型（命令列 `--model`，mod 有回報就以 mod 為準）、引擎、工作資料夾、開啟時間、目前狀態、是 ASN 開的還是使用者自己開的、mod 有沒有裝；有 mod 時加上上下文用量；外殼鏈（從 PID 往上的祖先程序，用 `switch.rs` 的 `ancestors`，例如「Windows Terminal → PowerShell → pi → claude」「Orca → claude」），只列程式名稱、不列命令列參數 | 不動任何東西 |

詳情不寫進名單（名單每輪都報，PID、完整路徑不必常駐後台），按下去才問、結果存在那筆請求的 `result`（jsonb，≤4 KB），與其他動作一樣 2 分鐘逾時；不需要「允許遠端管理」開關，但仍要本人簽章。

轉交的第一句話（固定文字，手機可以再補一段）：
「你是『<名字>』的下一任，前任的上下文用完了。先讀你與收發室的往來記錄（信尾那行的路徑）和前任留下的交接檔，接著把手上的工作做下去。」

不做「先叫前任寫交接檔再關」：前任 context 快滿時寫交接常常失敗，而且要等它回覆，流程會卡住。前任要寫交接，小良哥可以先在對話裡叫它寫，再按轉交。

## 一之一、安全規則（asn 主線 10-22 審查補充，每條都要有守門測試並做還原驗證）

1. **只關名單上那一個 Claude 視窗的那棵樹**：用 `~/.claude/sessions/<pid>.json` 同時對上名字與 sessionId，對得上才動手；對不上回錯，不猜。**絕不用名稱或命令列字串比對去找程序**（曾因命令列比對誤殺 11 個 claude.exe）。
2. **使用者自己開的視窗**（父殼不是 ASN 開的）照 #82：只結束 claude 與它的子孫，留下使用者的終端機；手機提示「原本的終端機分頁會留下」。
3. **只收 owner 本人簽章**（後台 `asn_user_owns_node` 驗）；開關沿用「允許遠端開視窗」，設定頁文字改成「允許遠端開視窗與管理視窗」。
4. **收發室視窗與 ASN 自己的視窗**不能被關、不能被改名、不能被轉交；手機選單也不顯示（電腦端執行前再擋一次）。
5. **改名後確認夥伴 ID 延續**：下一輪 `partner_sync` 帶新名字後確認仍是同一個夥伴 ID；往來記錄（#153 以夥伴 ID 為鍵）跟著新名字走。
6. **每個操作都留紀錄**：寫進該夥伴的往來記錄與內建收發室 log（誰下的令、從哪台設備、何時、做了什麼、結果）。

## 二、後台：新動作 `partner_op`（要本人簽章）

新表 `relay.partner_ops`（與 `relay.launches` 同形）：id、tenant_id、requested_by、node、name（目標視窗目前名字）、op（`rename`／`close`／`handover`）、new_name（改名才有）、note（轉交的補充，≤1000 字）、status（`pending`／`taken`／`ok`／`failed`）、detail、created_at、done_at。

| 動作 | 誰呼叫 | 說明 |
|---|---|---|
| `partner_op` | 手機（帶 `x-asn-user` 本人簽章） | 資料庫函式核對：簽章的人擁有呼叫節點與目標節點（`asn_user_owns_node`）；目標節點有 `launcher`（＝打開了「允許我的其他設備替這台開新視窗」，同一個開關）；目標名字 3 分鐘內在名單上；改名的新名字過 `irori_relay_launch_name_ok`、不撞名；同一個視窗同時只能有一筆未完成；每小時上限與開視窗共用。成功敲門鈴、回 `{id}` |
| `partner_ops` | 手機 | 查進度（ids，最多 20） |
| `partner_op_pending`／`partner_op_result` | 內建收發室 | 取走自己節點的待辦、回報結果（只動得到自己節點的） |

2 分鐘沒被取走自動標失敗（與 launches 同一個排程）。沒簽章一律 401（Edge Function 就擋）。

## 三、內建收發室（Rust，`bridge/`）

- 門鈴響或每輪輪詢時順便 `partner_op_pending`；後台回 404 就靜默停用到下次啟動（舊後台不壞）。
- 執行前再驗一次：本機設定仍允許遠端操作、名字對得到一個活著的 claude 視窗、命令列看得出是 claude（`looks_like_claude`）、不是 ASN 自己。
- 改名／轉交：重開後等新視窗出現在 sessions 且名字正確才回 `ok`；逾時回 `unconfirmed`。
- 開出去的視窗一律用 `child_env` 的乾淨環境（同開新夥伴）。

## 四、手機介面（`ui/m.html`、`ui/m.js`、`ui/lib/` 新增純邏輯模組）

- 對話頁標題列右邊「⋯」按鈕，點開選單：改名…／關閉視窗／轉交下一任…。
- 只有「這位是 AI 視窗、在線、它那台電腦允許遠端操作、手機有登入」才可按；不能按的反灰並寫中文原因（與開新夥伴同一套 `launchEligibility`）。人、手機、雲端代理、群組不顯示這個按鈕。
- 改名：輸入框（預設目前名字，同一條名字規則），確定後送出。
- 關閉視窗：確認框「關掉『名字』在『設備名』上的視窗？對話記錄會留著。」
- 轉交下一任：確認框，可補一段話給下一任（選填）。
- 送出後在對話頁頂端顯示進度（已送出 → 電腦正在處理 → 完成／失敗原因）；完成時改名的對話自動跳到新名字（同一位夥伴 ID）。
- 純中文、不顯示節點代號與夥伴 ID。

## 五、相容

| 情形 | 行為 |
|---|---|
| 舊後台（沒有 `partner_op`） | 手機選單項目反灰「電腦端還不支援」；內建收發室 404 靜默停用 |
| 舊版 ASN 電腦版（沒有執行端） | 待辦 2 分鐘後被排程標失敗，手機顯示「那台電腦的 ASN 版本太舊」 |
| 舊 Node 橋、雲端代理 | 不認這個動作，不受影響 |

## 六、部署順序

migration → relay 函式 → 發 ASN（電腦版與安卓同一版）。順序反過來也安全（見上表）。

## 七、分工與檔案

- 手機介面：`ui/m.html`、`ui/m.js`、`ui/mobile.css`、新 `ui/lib/partner-ops.mjs`＋測試（等 feat/158-android-polish 合併後開分支）。
- Rust：`android.rs`（手機呼叫）、`bridge/` 新 `partner_ops.rs`＋接到輪詢、`launch/switch.rs` 抽出可重用的「關／重開」函式。動 `bridge/` 前先通知 asn 主線。
- 後台：新 migration、`_shared/partner_ops.ts`＋測試、`relay/index.ts` 分派。動 `supabase/` 前先通知 asn 主線。
