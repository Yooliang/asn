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
- **與 5.5 不同**：西川的 5.5 寫的是「先開新的、接上後才關舊的」（失敗時原視窗原封不動）。兩案取捨見第十節，請領隊定。

### 4.4 確認框與別台顯示

- 確認框（待 asn真 定稿）：「會結束你原本視窗裡的 claude，改由 ASN 的視窗接著同一段對話。原本的終端視窗會留著。」#1664 要求寫「會關掉你原本的視窗」；實際上我們只關 claude、不關使用者的終端（那裡可能還有別的分頁），兩種寫法請領隊選。
- 名單加一欄 `managed`（`asn`／`self`），比照 `hidden` 的加法（`roster.rs:297-317`、`roster.ts`、migration 仿 `20261026000000_roster_hidden.sql`、`ui/lib/roster.mjs:104-112`）。舊版電腦不送 → 別台顯示反灰「請先更新那台」。
- 判斷盲點：npm 版 claude 外面多一層 node、或使用者自己用 WezTerm 開，`asn_host_of` 可能判錯；改用對照表後只會把「不認得的」當外部，不會把外部當成 ASN 開的。要實測（第九節）。

## 五、跨設備遠端指令（asn西川）

### 5.1 原則：不開新通道，沿用「遠端管理夥伴視窗」

現有的遠端管理（手機「⋯」選單下令 → 後台 `asn_relay_partner_op` 排進 `relay.partner_ops` → 敲目標電腦門鈴 → 電腦端 `bridge/partner_ops.rs` 取走、再驗一次、執行、回報 `partner_op_result`）已經有完整的簽章、授權、忙碌、限流與稽核。第 2 格按鈕的跨設備動作**全部走這一條**，只加動作，不另開路。理由：簽章與授權審過一次就好，新動作不會多出新的繞過點。

### 5.2 動作對照（第六節狀態表 → 後台動作）

| 第 2 格按鈕 | 後台動作 | 狀態 |
|---|---|---|
| 接回對話 | `resume` | 已有，不動（原「喚醒」鈕併進來，只換字） |
| 恢復運行（內建通道被停掉） | `restart` | 已有，不動（只換字） |
| 停止運行（內建通道運行中） | `close` | 已有，不動（電腦端 ACP 分支原本就是「結束工作者程序、名單顯示已停止」，只換字） |
| 切到背景／叫回前台 | `window`（新） | 新增 |
| 接手管理 | `adopt`（新） | 新增 |

`close` 對 Claude 視窗仍是「關閉視窗」，只是第 2 格不再給 Claude 視窗這顆按鈕（它們只有切背景／叫回前台、接回對話）；「管理」選單裡原本的關閉項不變。

### 5.3 簽章與權限（四層，新動作一律照舊，不放寬）

1. **Edge `relay`**：`requestPartnerOp` 沒有本人簽章（`signedUser` 為空）在打資料庫前就回 401；`PARTNER_OPS` 清單加入 `window`、`adopt`，`parsePartnerOp` 只留該動作用得到的欄位，其餘丟掉。
2. **資料庫函式 `asn_relay_partner_op`**（security definer，ACL 維持只有 `postgres`、`service_role`）：
   - 呼叫節點與目標節點都要是簽章者名下、同租戶、狀態 active，否則 `forbidden`／`not_found`；
   - 目標名字 3 分鐘內要在名單上，否則 `not_found`（這同時擋掉「電腦離線」，畫面灰掉寫「電腦離線」）；
   - 收發室與 ASN 自己的視窗一律 `protected`；
   - 目標電腦沒開「允許遠端開視窗與管理視窗」（`launcher` 為空）回 `no_launcher`，畫面灰掉寫「未開遠端」；
   - 同一視窗有未完成的操作回 `busy`；每台電腦每小時最多 30 次，回 `rate_limited`。
   新動作要同時改兩處：動作白名單（函式內的 `p_op not in (...)`）與資料表的 `partner_ops_op_check`，用新的 migration 重寫函式、放寬檢查；比照 `20261028210000` 的做法，部署前先和線上定義逐字比對。
3. **電腦端 `partner_ops.rs`**：`KNOWN_OPS` 加入兩個新動作；`execute` 一開頭照舊再驗 `allow_remote_launch`（非 `info` 一律要）；ASN 自己的視窗與收發室再擋一次（`protect`）。**所有決定關誰、開哪個資料夾、用什麼指令的資料一律在這台電腦本機取得，遠端請求只帶「視窗名字」與下列的少數欄位**（延續 `launcher.rs` 的原則：指令一律來自本機）。
4. **稽核**：每筆都寫內建收發室 log 與該夥伴的往來記錄（誰下令、何時、做了什麼、結果），新動作的 `what()` 要有中文描述。

### 5.4 新動作 `window`：切到背景／叫回前台

- 欄位：`to`，只能是 `front` 或 `back`。**用目標狀態，不用「切換」**：兩台設備同時按、或連按兩下，結果仍是同一個狀態，不會互相抵消。
- 電腦端：找到該夥伴的 WezTerm 視窗（第一～三節定義怎麼認），要求切到指定狀態；已經在該狀態就直接回 ok（冪等）。找不到視窗回 `failed`「找不到這個視窗」，第 2 格畫面不再顯示這顆（回到灰色「檢查中…」重查）。
- 風險低（不關程序、不丟對話），但仍受上述全部閘門約束，因為它會動使用者螢幕上的視窗。
- 舊版（尚未改走 WezTerm、還是 WT／主控台）開的視窗：升級過渡期的處理見第三節；電腦端若這個視窗不是 WezTerm 管的，回 `failed`「這個視窗還不能這樣切」，不猜。

### 5.5 新動作 `adopt`：接手管理（會關掉對方原本的程序）

這是整批裡**唯一會結束程序**的動作，所以限制最嚴：

- 欄位：只有視窗名字與 `confirmed`（必須是 `true`）。**遠端請求不帶 pid、session id、資料夾**：這三樣由目標電腦本機從外掛條目（`~/.claude/sessions/<pid>.json`）讀取，能不能讀到由第四節的查證結論決定；讀不到就回 `failed`「讀不到這個視窗的對話或資料夾」，第 2 格灰掉寫原因，**不猜**。
- `confirmed` 由下令那台設備的確認框產生，框內寫清楚「會關掉你原本的視窗」；缺少或不是 `true`，Edge 就回 `bad_request`，不打資料庫。這是為了防止誤觸，不是安全邊界（安全邊界仍是本人簽章＋電腦端開關）。
- 電腦端的順序固定：
  1. 讀取外掛條目，記下 pid 與它登記的建立時間；
  2. 核對該 pid 仍活著，且**程序的實際建立時間與登記相符**（防 pid 被重用；不符就中止，不關任何東西）；
  3. 在同一資料夾用 ASN 自己的視窗接回同一段對話（和「接回對話」同一條路）；
  4. 新視窗出現在名單、對話確實接上之後，才關掉第 1 步記下的那一個 pid；**接不起來就不關舊的**，回 `failed`，使用者原本的視窗原封不動；
  5. 只關那一個 pid，不比對名稱、不整批結束。
- 回報分階段：`stage:opening`（開新視窗）、`stage:closing`（關舊程序），沿用現有階段格式，畫面依它顯示中文。
- 若舊程序關不掉（權限、已不存在），結果回 `unconfirmed` 並寫明「新視窗已開，原本的視窗仍開著」，不重試關閉。

### 5.6 版本相容與灰態

- 先部署後台（migration＋Edge），再發新版 ASN。舊版 ASN 收到 `window`／`adopt` 會回「這個版本的 ASN 不認得這個動作」（現有行為），不會執行。
- 為了不要等按了才失敗：電腦端在名單回報附帶的摘要裡加一個「支援的動作」清單（不含指令，延續啟動摘要的做法）；沒有該動作的目標，第 2 格灰掉寫「對方版本太舊」。這一點若造成名單回報格式變動，另外評估，必要時退回「按了才失敗」。
- 灰態用詞對照（滑過寫原因）：`no_launcher`＝未開遠端；`not_found`／`device_offline`＝電腦離線；名單還沒回＝檢查中…；`busy`＝已有操作進行中。
- 手機本身沒有 ASN 開的視窗，只當下令端；目標是手機時第 2 格不顯示。

### 5.7 測試與審查

- Edge：`partner_ops_test.ts` 加新動作的格式檢查、沒簽章回 401、`confirmed` 缺少回 `bad_request`。
- 資料庫：pglite 測試涵蓋新動作的各個拒絕分支（他人節點、跨租戶、離線、未開放、保護名單、忙碌、限流），並做還原驗證（把新 migration 的檢查拿掉，測試必須變紅）。
- 電腦端：假的作業系統介面測 `adopt` 的順序——建立時間不符不關、新視窗沒接上不關、關不掉回 `unconfirmed`、`allow_remote_launch` 關閉時不執行。
- 動到「關程序」與 security definer 函式的部分，依慣例由 asn真 最後審；部署 migration 前先比對線上定義並在群組公告。

### 5.8 待第四節確認的前提

`adopt` 能不能做，取決於 asn雯 第四節的查證：外掛條目是否一定拿得到 session id、資料夾，以及登記的建立時間能不能和程序實際建立時間對上。若其中任一項拿不到，這顆按鈕對那類條目就灰掉寫原因，本節其餘（`window`、換字）不受影響。

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

## 十、待領隊定

1. 接手管理的順序：第四節「預檢後先關再開」（不會兩個程序同時接同一段對話，最壞是變離線再按接回對話）vs 5.5「先開再關」（失敗時原視窗不動，但要先實測兩個程序同時 `--resume` 的行為，且要改 `find_target`、接回對話防呆對同名同 sid 的處理）。
2. 確認框用詞：「會關掉你原本的視窗」vs「會結束你原本視窗裡的 claude，原本的終端視窗會留著」（實際只關 claude 那個 pid）。
3. 別台怎麼知道顯示哪個字：第四節的名單 `managed` 欄，或 5.6 的「支援的動作」清單；兩者可並存（`managed` 決定字、清單決定能不能按）。
4. 「建立時間」的來源：sessions 檔有沒有可以對照的時間要查；沒有就在第一次看到該 pid 時本機記下（`process_started_ms`），按下時再比一次。
5. 版本號：0.2.0-rc.1～rc.4 還是 0.1.113～0.1.116。
