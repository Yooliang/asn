# 0.2.0：ASN 開的視窗全部改用 WezTerm，第 2 格固定按鈕

小良哥 2026-10-30 定案（群組 #1669，取代 #1664）：ASN 開的視窗全部改用 WezTerm（Windows 安裝檔已帶 wezterm，直接用那份）；claude 也要有「在等你回答」提醒與代答；對話視窗上排第 2 格固定按鈕（狀態表、用詞、跨設備）整包進 0.2.0。藍圖 todo-next-15q。

本文件只定設計，不含程式。分工：asn雯 主筆；第五節遠端指令／後台由 asn西川 撰寫。行號以 main 1fb4934c 為準，路徑省略 `relay/asn/src-tauri/src/`。

## 〇、先講現況（跟直覺不一樣的地方）

- **ASN 現在開視窗根本不走 Windows Terminal。** #476 之後，Claude 夥伴一律用原生主控台開：`Start-Process conhost.exe "powershell.exe -NoExit -EncodedCommand …"`（`launch/local.rs:338-394`）。承載的 PowerShell 設標題、跑指令，結束後印「[ASN] 程式已結束」並停住（`local.rs:264-290`）。
- 跟 WT 有關的只剩三處「辨識」程式：`in_windows_terminal`（`launch/switch.rs:295`）、`Plan.in_wt`（只記錄，`switch.rs:530`）、`find_for` 的 WT 分支（`launch/console_resolve.rs:158-168`）。
- pi 已經先試自帶 WezTerm，開不起來或要背景開才退回原生主控台（`launch/pi_term.rs:53-69`）。agy／grok 的終端（#286）本來就是 WezTerm。
- 所以這次實際要換掉的是「原生主控台＋承載 PowerShell」這條路；「沒裝 WT」本來就不影響（見第八節）。

## 一、開視窗的每條路改走 WezTerm

### 1.1 收斂成一個開窗點

所有原生主控台的路最後都進 `local::start_window` → `start_window_env` → `start_window_windows`（`local.rs:209`、`214`、`338`）。改法是只換最底層：Windows 上 `start_window` 改呼叫自帶 WezTerm（`launch/wezterm.rs` 的 `start_in_workspace_clean`，`302-356`），上層各條路不用各自改。

| 路 | 進入點 | 改法 |
|---|---|---|
| 開新夥伴（本機） | `partner_launch_local`（`local.rs:11`） | 參數照舊由 `build_spawn_spec`／`apply_resume_real` 組；開窗改走 WezTerm |
| 開新夥伴（手機／遠端） | `bridge/launcher.rs:192` → `start_remote_window`（`local.rs:132`） | 同上 |
| 接回對話（喚醒） | `bridge/partner_ops.rs:1342 resume` → `switch::real_launch` | 同上；`--resume <sid> -n 名字` 不變 |
| 換模型重開、改名退路 | `switch::run_with`（`switch.rs:577`）、`partner_ops.rs:1227 reopen` | 關舊（見 1.3）後開新，開窗走 WezTerm |
| 接班換手 | `partner_ops.rs:1472 handover` → `reopen` | 同上 |
| pi | `pi_term.rs` | 已是 WezTerm 優先；退路改成跟 claude 同一套（1.4） |
| 背景／前台切換 | `console_resolve::find_for`（`126`） | 用既有的 WezTerm 分支（`136-142`：往上找得到 ASN 自己開的 `wezterm-gui`、且只擁有一扇視窗才切） |

### 1.2 視窗怎麼記住、怎麼判斷「ASN 開的」

- 每開一扇就寫進既有的對照表 `data_dir/wezterm-terms.json`（`launch/term.rs:164-180`、`206`、`1456`），新增 `kind: "claude"` 與 `session_id`。GUI pid＋建立時間已經在表裡。
- Claude 的身分照舊靠 `~/.claude/sessions/<pid>.json`（`console.rs:41-85`）。
- 「ASN 開的」改成：claude pid 往上找到的 `wezterm-gui` 在對照表裡、且建立時間相符。取代現在解開 `-EncodedCommand` 找字串的 `is_asn_host_cmdline`／`asn_host_of`（`switch.rs:256`、`520`）。這兩個留到過渡期結束（第三節）。

### 1.3 關閉

- 沒了承載 PowerShell，`close_session`（`switch.rs:542`）對 WezTerm 視窗改成：先結束 claude 那棵（`kill_set_with`，`switch.rs:308-340`），再用 `WezTerm::stop`（`wezterm.rs:483-495`，建立時間對不上就不動）收掉那個 GUI。不送 `WM_CLOSE`。
- 只動對照表裡、建立時間相符的那一個 GUI；不認得的一律不關。

### 1.4 背景開、程式結束後的畫面

- WezTerm 沒有隱藏啟動參數。背景開改成：開完立刻對那扇視窗 `ShowWindow(SW_HIDE)`。會不會閃一下要實測（第九節第 1 點）；閃得明顯就改「開在螢幕外再隱藏」。
- 程式結束後視窗要留著讓人看最後畫面：在 ASN 自己的設定檔 `data_dir/wezterm-term.lua`（`term.rs:315-325`）加 `exit_behavior = "Hold"`。不再包一層 PowerShell，程序樹保持 `wezterm-gui → claude`（中間是否多一層 OpenConsole 要實測，`find_for` 的 8 層上限夠不夠一起驗）。

### 1.5 退場與保留

- **退場**：`start_window_windows` 的 conhost 腳本與 `window_launcher_args(_env)`、`build_window_script(_env)`、`parse_launcher_output`（`local.rs:244-333`）；`post_close` 送 `WM_CLOSE` 那段（`switch.rs:871`）；`launch/config.rs:284-286` 斷言「必須用 conhost」改寫成「Windows 開窗走 WezTerm」。
- **過渡期保留、第 4 階段才拿掉**：`is_asn_host_cmdline`／`asn_host_of`、`find_for` 的傳統主控台與 WT 分支、`in_windows_terminal`／`Plan.in_wt`。
- **只當退路**：自帶 WezTerm 找不到或開不起來時，照舊開原生主控台（同 pi 現在的做法），畫面提示一次「內建終端開不起來，改用一般視窗」。
- **順帶修**：`locate_with`（`wezterm.rs:164`）只看檔案存不存在，`build.rs:8-21` 的空檔占位會被當成可用；改成大小為 0 就當找不到。

### 1.6 `console_resolve` 與 `wt_launch` 的去留

- `console_resolve`：保留。WezTerm 分支是新主路；主控台與 WT 分支只為辨識舊視窗。
- `wt_launch`：main 上已無這個函式（#476 拿掉），沒有要退場的 WT 開窗程式。

## 二、claude 在 WezTerm 裡的忙閒、「在等你回答」與代答

### 2.1 忙閒

- 主依據照舊：外掛狀態檔 `~/.asn/status/<sessionId>.json` 與 sessions 的 status（`switch.rs:234 is_idle`）。比讀畫面可靠，也不用為 claude 調畫面規則。
- 畫面只用在「在等你回答」與代答前的重讀。

### 2.2 「在等你回答」

- 觸發：外掛已經掛 hook，加回報「等你回答」（權限詢問、信任詢問、選單）寫進狀態檔；沒裝外掛的視窗才每 5 秒讀一次畫面（`get_text`，`wezterm.rs:437`）判斷。
- 判斷：`classify_prompt`（`term.rs:1312`）加 claude 專用規則（權限詢問的 1／2／3 選項、信任資料夾、AskUserQuestion 選單）。規則依實機截樣寫，截樣存測試資料。
- 提醒：沿用現有 agy／grok 的「在等你回答」提醒（名單標記＋通知），不另做。

### 2.3 代答（沿用 term.rs 的審查約束，一條不放寬）

1. 只經 UI 確認：電腦版名單（`ui/list.js:1063`、`1094`）或手機確認流程（`term_remote.rs` 的 `offer_*`／`local_confirm_*`）。AI 夥伴的信不能觸發代答。
2. 送前重讀畫面：提示還在、種類相符、選項合法才送（`answer`，`term.rs:611-654`）。按鍵只從固定對照表產生（`term.rs:1160-1184`）。
3. 資料夾授權：要有授權記錄才可代送（`confirm_send`，`term.rs:425-448`、`656-674`）。

### 2.4 profile 白名單怎麼放寬

- 現在 `resolve_command`（`term.rs:934-960`）只收 agy、grok，測試 `term.rs:1848-1854` 明擋 claude，怕啟動設定裡的 claude 被這條路直接執行。
- 放寬方式：**「依 profile 開終端」那條路不收 claude**（名單「＋」的進階終端照舊只有 agy／grok）。claude 視窗一律由 1.1 的開窗點開，開完把 `kind: "claude"` 寫進對照表；忙閒、等你回答、代答這些「對已開視窗的操作」才認 claude。
- 認領（`term.rs:1018-1020`）加 claude，但只認對照表裡、建立時間相符的那扇。
- 測試 `term.rs:1848-1854` 保留「依 profile 開不准 claude」，另加「對照表裡的 claude 視窗可讀畫面、可代答」。

## 三、舊版開的視窗怎麼過渡

- **升級不砍任何視窗。** conhost 視窗是獨立程序，ASN 更新重啟不影響它們；新版不主動關、不主動搬。
- 新版仍認得舊視窗：`asn_host_of` 判為「ASN 開的（舊式）」，前後景照舊用 `ConsoleWindowClass`；名單、管理選單照常。
- 舊視窗下一次被重開（換模型、接回對話、接班、改名退路），新的那扇就開在 WezTerm。不另做「一鍵搬過去」。
- 舊式視窗不提供「在等你回答」與代答（沒有畫面可讀），第 2 格照常是切到背景／叫回前台。
- 第 4 階段（0.2.x 之後、至少隔兩個版本）才拿掉舊式辨識；拿掉前那台電腦若還有舊式視窗，就會被當外部，可用「接手管理」接過來。

## 四、接手管理

### 4.1 拿得到什麼

- 這台電腦讀得到：`~/.claude/sessions/<pid>.json` 有 **claude 程序本身的 pid**（原生版 claude.exe、npm 版 node.exe，不是殼）、cwd、sessionId（`bridge/roster.rs:178-200`）。外掛狀態檔沒有 pid、cwd（`relay/claude-mod/hooks/status.ts:12-25`）。
- **後台與別台拿不到**：名單只送 name、status、cwd 最後一段、engine…（`roster.rs:297-332`，後台白名單 `supabase/functions/_shared/roster.ts:5`），也沒有欄位分辨外部或 ASN 開的。
- 所以：在哪台按都一樣，**實際判斷與執行都在夥伴所在那台**；別台只需要多一個旗標決定顯示哪個字（4.4）。

### 4.2 流程（在夥伴所在那台執行）

1. 依名字找 sessions 裡活著的那筆；必須是外部（不在對照表、`asn_host_of` 也不是）。記下 pid、程序建立時間（`heartbeat::process_started_ms`，`heartbeat.rs:89`）、sessionId、cwd。
2. 要閒置：忙就回「對話進行中，等它閒置再接手」。
3. cwd 要在 `cwd_allow` 允許清單（同接回對話）；不在就反灰寫「這個資料夾沒有允許」。
4. 預檢：自帶 WezTerm 在、參數組得出來（`resume_argv`，`partner_ops.rs:1580`）。預檢不過就不關任何東西。
5. **先關後開**：重新核對 pid 的建立時間，相符才結束 claude 那棵（`close_session` 的 `host=None` 路徑：只結束 claude 與子程序，**使用者的終端視窗與殼留著**，`switch.rs:542-566`）；等程序真的結束。
6. 在同一個資料夾開 WezTerm：`claude --resume <sid> -n <原名>`，寫進對照表。之後就是 ASN 開的視窗。
7. 第 6 步失敗：回報「已關掉原本的，接手沒開起來」，夥伴變離線，第 2 格變「接回對話」可以再試；對話不會丟。

### 4.3 為什麼先關後開

- 「先開再關」會讓兩個程序同時 `--resume` 同一段對話：Claude Code 是共寫同一份紀錄還是另開，未知；而且同名、同 sid 兩筆時 `find_target` 直接失敗（`partner_ops.rs:891`），接回對話的防呆也會擋（`1356-1361`）。
- 先關後開、且預檢通過才關，最壞情況是「變離線、按接回對話」，跟現有 pi 接手（`partner_ops.rs:603-683`）同一個順序。

### 4.4 確認框與別台顯示

- 確認框（待 asn真 定稿）：「會結束你原本視窗裡的 claude，改由 ASN 的視窗接著同一段對話。原本的終端視窗會留著。」#1664 要求寫「會關掉你原本的視窗」；實際上我們只關 claude、不關使用者的終端（那裡可能還有別的分頁），兩種寫法請領隊選。
- 名單加一欄 `managed`（`asn`／`self`），比照 `hidden` 的加法（`roster.rs:297-317`、`roster.ts`、migration 仿 `20261026000000_roster_hidden.sql`、`ui/lib/roster.mjs:104-112`）。舊版電腦不送 → 別台顯示反灰「請先更新那台」。
- 判斷盲點：npm 版 claude 外面多一層 node、或使用者自己用 WezTerm 開，`asn_host_of` 可能判錯；改用對照表後只會把「不認得的」當外部，不會把外部當成 ASN 開的。要實測（第九節）。

## 五、跨設備遠端指令（asn西川）

（撰寫中）

給西川的盤點（`partner_ops` 五層：前端 `ui/lib/partner-ops.mjs:7`、電腦端 `relay.rs:824`、後台 `supabase/functions/_shared/partner_ops.ts:10`、資料庫 `supabase/migrations/20261028210000_partner_op_resume_pi.sql`＋約束 `20261028100000_partner_ops_remove.sql:8-10`、執行端 `bridge/partner_ops.rs:34`）：

- 前後景：新 op，要帶 `visible`；表沒有這欄。執行端呼叫 `console::partner_console_set`。
- 接手管理：新 op，在線才可；執行端照第四節。
- 停止／恢復運行：沿用 close、restart。restart、remove 在電腦端白名單漏掉，0.1.112 小 PR 先修。
- 喚醒用「不在名單上」，其他動作用「3 分鐘內在名單上」（migration `:53-59`、`:82-84`），新 op 照後者。
- 手機發起時 `requested_by` 是手機節點，後台要求兩台都屬於簽章本人；新 op 沿用，不開例外。

## 六、第 2 格固定按鈕：狀態表與用詞

字一律四個字；群組不放這格。

| 夥伴種類 | 狀態 | 按鈕 | 做什麼 |
|---|---|---|---|
| 外部（自己開的 claude） | 在線 | 接手管理 | 第四節 |
| ASN 開的視窗 | 在線、前台 | 切到背景 | 隱藏視窗 |
| ASN 開的視窗 | 在線、背景 | 叫回前台 | 顯示視窗 |
| ASN 開的視窗 | 離線 | 接回對話 | 現在的喚醒 |
| 內建通道（ACP） | 運行中 | 停止運行 | 現在的關閉 |
| 內建通道（ACP） | 已停止 | 恢復運行 | 現在的重開 |

反灰（滑過寫原因，20 字內）：「未開遠端」（那台沒允許遠端管理）、「電腦離線」、「檢查中…」；外部但不在線、或舊版電腦沒送 `managed` 時寫「請先更新那台」。

- 跨設備：夥伴在別台（含從手機按）時一樣顯示上表，經遠端管理送到那台執行（第五節）。手機的 `barSlots` 第 2 格（`ui/lib/actionbar.mjs:120`，現在一律反灰）改成照上表。
- 用詞一起改：「管理」選單、名單右鍵、手機「⋯」：喚醒→接回對話、重開→恢復運行、ACP 的關閉→停止運行（`ui/lib/partner-ops.mjs:17`、`93`；`actionbar.mjs:99-100`、`292`；`ui/list.html:281-288`；`ui/lib/partner-launch-ui.mjs:135`；對話框 `ui/lib/partner-ops-ui.mjs:63-100`）。
- 舊的「把這台電腦上開著的終端納入管理…」（`actionbar.mjs:202-212`）由接手管理取代；名單「＋」裡的「ASN 開的終端（進階）」照舊。

## 七、分階段與發版

每階段單獨可發，前一階段不依賴後一階段。版本號暫定 0.2.0-rc.1～rc.4，全部完成發 0.2.0；預發版號在官網更新與 Play versionCode 的換算要先確認，不行就改用 0.1.113～0.1.116。

| 階段 | 內容 | 動到 | 需領隊親審 |
|---|---|---|---|
| 0.1.112（已排） | 電腦端白名單補 restart、remove＋防漏測試 | Rust | — |
| 第 1 階段 | 開窗改走 WezTerm（1.1～1.5）、舊視窗辨識保留、退路、`locate` 大小檢查 | Rust | 啟動參數、關程序 |
| 第 2 階段 | 第 2 格固定按鈕（本機）、用詞全改、接手管理（本機）、名單 `managed` 欄 | 前端、Rust、migration | 關程序 |
| 第 3 階段 | 遠端：前後景、接手管理新 op；手機第 2 格 | 前端、Rust、後台、migration | 遠端指令 |
| 第 4 階段 | claude「在等你回答」與代答（第二節） | 外掛、Rust、前端 | 代答約束 |
| 之後 | 拿掉舊式主控台辨識（第三節） | Rust | — |

一次只跑一個 Rust 建置；後台與 migration 先比對線上再套、附回復檔。

## 八、沒裝 Windows Terminal 的電腦

- ASN 開視窗本來就不靠 WT（第〇節），改 WezTerm 後也不靠。家用機沒裝 WT 行為完全一樣。
- 會影響的是「自帶 WezTerm 不在」：開發版沒抓檔、占位空檔、被防毒軟體隔離。這時退回原生主控台（1.5），功能少了「在等你回答」與代答，其餘照舊。
- 使用者自己在 WT 開的 claude：照外部處理，第 2 格是接手管理；接手後就在 WezTerm。
- 非 Windows：`start_window_unix`（`local.rs:397`）不動。

## 九、要實測才能定的點

1. 背景開：開完再隱藏會不會閃。
2. `exit_behavior = "Hold"` 能不能取代「程式已結束」提示；程序樹中間有沒有 OpenConsole、`find_for` 8 層夠不夠。
3. 關閉：結束 claude 後 GUI 會不會自己關；`WezTerm::stop` 的建立時間核對在實機上可靠。
4. 隔離設定檔 `return {}` 真的不讀使用者的 `~/.wezterm.lua`；中文字型、配色目視。
5. 每扇一個 GUI（`--always-new-process`）開十幾個夥伴的記憶體與啟動時間。
6. claude 的權限詢問、信任詢問、選單畫面截樣，`classify_prompt` 的「>」「❯」適不適用。
7. `send-text --no-paste` 送中文進 claude 輸入框。
8. npm 版 claude（node 包一層）的 pid 與外部判斷。
9. 接手管理：結束外部 claude 後，使用者的終端是否乾淨回到殼；`--resume` 立刻接得上。
10. 預發版號（rc）在官網更新與 Play versionCode 換算可不可行。
