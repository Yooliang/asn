# 插件化完整實作計畫（0.2.18～0.2.24）

> **狀態：計畫文件，不改程式。** 交兩位審查者審；審過、待決問題拍板後，才依 #935 一版一版開工。
>
> 依據：
> - 設計討論 `docs/design/PLUGIN-ARCH-DISCUSSION.md`（PR #894，已定案採**方案 B：自建輕量插件邊界**，DeepSeek Harness 只當參考）。
> - 版本切法：issue #935。
> - 運行方式與登入：#931（開新夥伴「運行」四選項）、#933（0.2.16 裝原生 CLI）、#934（0.2.17 登入改經 pi）。
>
> 程式對照基準：`origin/main` 的 `812c982e`（2026-11-06）。**注意 main 當時還沒有 0.2.9 Linux 終端服務與 0.2.11 FCM 的程式**（`relay/asn/package.json` 版本字串仍是 0.2.6，Rust 端搜不到 FCM），所以 0.2.22、0.2.23 兩節裡對那兩塊的描述是「依排程推斷」，開工前要用屆時的 main 重對一次。
>
> 出處格式：`檔案:行號`，路徑省略 `relay/asn/` 前綴者會寫明；行號都是上述基準的行號，之後會漂移。標「（推斷）」的是沒能在程式裡查實的地方。

---

## 1. 目標、非目標、底線

### 1.1 目標

1. 把「各家 AI 廠商的差異」從散落在十幾個檔案的 `if profile == "grok"` 收攏成**一家一份適配**，新增或修改一家廠商只動它自己的檔案。
2. 把「前端傳輸」切乾淨，讓收發信核心（AsnCore）能用一頁契約說清楚它到底依賴什麼，之後不再被周邊功能拖著長。
3. 通知管道、平台差異（開窗、程序、終端服務）也各有一個介面，讓 0.2.9 Linux、0.2.11 FCM 搬進去之後不再寫死在主流程。
4. **每一版行為不變、驗完就發**；使用者在這七版之間不應察覺任何差別（除了本來就排好的新功能）。

### 1.2 非目標

- 不做「使用者自己下載第三方插件」。這裡的「插件」指**編進 ASN 的內建模組＋穩定介面**，不是動態載入外部程式碼。要不要開放外部載入，列為待決問題（§9），本計畫不做。
- 不採用 Harness／Cordis 當底層（#894 已決）。
- 不重寫、不搬動寄信核心與終端服務核心。
- 不改後台（Supabase）協定，不改信件格式。
- 不順手清理無關的舊程式（例如 `term.rs` 六千多行的拆檔），除非該版明確要搬的部分剛好在裡面。

### 1.3 底線（每一版的守門條件）

1. **寄信（傳訊）核心、終端服務核心不插件化。**
2. **插件永遠不碰金鑰，也不碰 inbox／ack 協定。** 金鑰只在 Rust 行程記憶體；插件拿到的東西不可能包含它。
3. **讀畫面、送字一律走核心的權限檢查。** 插件只能回答「這段畫面是什麼」「這個回答該送哪幾個鍵」這類**純判斷**，由核心實際去讀、去送；插件手上不持有任何窗格或程序的控制代碼。
4. **啟動指令的白名單與環境變數過濾留在核心。** 插件只描述「想怎麼啟動」，核心照既有規則檢查後才執行。
5. **預設拒絕**：權限框沒有明確的允許回答就不放行；插件出錯、逾時、回傳看不懂的東西，一律當作「沒有答案」。
6. **每版全套測試＋至少一台實機回歸**；手機與電腦共用核心，兩邊都測。
7. 每版附**守門測試**：插件介面拿不到金鑰、繞不過權限檢查（具體寫法見各版）。

> 安全面在這份文件只寫原則；實作時的威脅分析走非公開管道，不寫進公開倉庫。

---

## 2. 現況盤點

### 2.1 前端 `transport`：58 個方法混在一起

`ui/lib/tauri.mjs:12-71` 的 `transport` 目前有 **58 個方法**（原討論文件寫「約 50」）。AsnCore 實際只用其中 12 個（`ui/lib/core.mjs:146,182,273,317,403,426,452,481,511,565,612` 與 `228-255` 的頭像三個）。其餘 46 個是終端、啟動、設定、額度、pi 等「桌面周邊」。

另外 `core.mjs:74-77` 做的是 `const guarded = { ...transport }`：傳什麼進來都會被帶著走，沒有任何「只認契約」的檢查。對話窗也把整包 `transport` 當 `agent-api` 傳給 ChatPane（`ui/chat.html:22`、`ui/chat.js:57`、`ui/lib/chatpane.mjs:54`），功能列（`ui/lib/actionbar.mjs:328-372`）從這包裡取終端與切模型的方法。

手機已經是切開的：`ui/m.js:69-81` 的 `transport` 只有 11 個收發信方法，管理夥伴與帳號切換另放 `opsTransport`（`m.js:83-87`）、`acctTransport`（`m.js:89-94`）。**0.2.18 等於把電腦版整理成跟手機一樣的形狀。**

#### 分類表（0.2.18 的搬遷依據）

行號是 `ui/lib/tauri.mjs`。

| 歸類 | 方法（行號） | 說明 |
|---|---|---|
| **mailTransport**（AsnCore 契約，12 個） | `list`(13) `localWindows`(14，電腦版專有、手機沒有，選用) `inbox`(15) `ack`(16) `send`(18) `history`(19) `sentStatus`(27) `readSync`(24) `avatar`(28) `partnerAvatar`(29) `setAvatar`(30) `sendAttachment`(31) | 手機 `m.js:69-81` 的 11 個＝這份扣掉 `localWindows` |
| **desktopExtras / ops**（經後台、Rust 簽章的遠端管理，7 個） | `rooms`(17) `partnerOp`(20) `partnerOps`(23) `partnerArchive`(25) `authStatus`(26) `launch`(32) `launchers`(33) | 不是信，但電腦與手機都用（手機走 `opsTransport`）。`rooms` 在 UI 搜不到直接呼叫點（推斷：由其他模組間接用，0.2.18 開工時再查） |
| **desktopExtras / self**（本機視窗登記，2 個） | `selfWindowDefault`(21) `selfWindowRegister`(22) | 「接進收發室」 |
| **desktopExtras / launch**（啟動與設定，8 個） | `cliDetect`(34) `partnerLaunchLocal`(35) `partnerConsoleQuery`(36) `partnerConsoleSet`(37) `launchCwdCandidates`(58) `launchCwdBrowse`(59) `launchPrefsGet`(60) `launchPrefsSet`(61) | |
| **desktopExtras / term**（ASN 自帶終端，11 個） | `termStart`(38) `termEnvNotice`(39) `termList`(45) `termStatus`(46) `termRead`(47) `termSend`(48) `termStop`(49) `termAdoptCandidates`(50) `termAdopt`(51) `termAdoptUnlock`(52) `termAnswer`(53) | **碰畫面與送字**，是權限檢查最敏感的一組 |
| **desktopExtras / screen**（讀畫面判斷、權限框，5 個） | `partnerPermissionPrompt`(40) `partnerPermissionAnswer`(41) `autoResumeStatus`(42) `partnerNoticesActive`(43) `partnerNotices`(44) | 同上，敏感 |
| **desktopExtras / switch**（Claude 視窗資訊與換模型，4 個） | `modelSwitchQuery`(54) `modelSwitchRun`(55) `subagentsQuery`(56) `tasksQuery`(57) | 只有 Claude 視窗有意義 |
| **desktopExtras / quota**（3 個） | `quotaHookStatus`(62) `quotaHookConnect`(63) `quotaHookDisconnect`(64) | |
| **desktopExtras / pi**（5 個） | `piModels`(66) `piProviders`(67) `piSetupStatus`(68) `piSetupInstall`(69) `piSetupRemove`(70) | 0.2.17 會再加登入相關（`ui/lib/connect-tools.mjs:57` 已預留 `piLogin`，transport 上還沒有） |
| **desktopExtras / site**（1 個） | `siteReleases`(65) | 版本紀錄 |

合計 12＋7＋2＋8＋11＋5＋4＋3＋5＋1＝58，與原表逐項對得上。

`tauri.mjs` 裡其他早已分開的物件不在這次搬遷範圍：`photoApi`(73)、`termViewApi`(80，讀畫面與打字，Rust 端有前景視窗與授權檢查)、`shotApi`(89)、`authApi`(98)、`cloudApi`(114)、`store`(121)。

### 2.2 廠商差異散在哪裡

下表的「字串次數」是 `"claude"|"codex"|"gemini"|"agy"|"grok"|"pi"` 在該檔出現的次數，**含測試程式**，只拿來看熱點，不是精確指標。

| 差異面向 | 現在寫在哪 | 備註 |
|---|---|---|
| 目錄與顯示（廠牌名、可選運行、為什麼不能選） | `ui/lib/model-catalog.mjs:6-12`（`MODEL_CATALOG`）、`:62-87`（`runOptions`）、`:58`（`vendorRows`）；`shared/launcher-profiles.mjs:123-129`（**同一份複製**，`test/partner.test.mjs:9-10` 逐項比對） | 兩份要手動同步 |
| 型號清單 | `ui/lib/model-catalog.mjs:93-125`（Claude 別名、`GEMINI_MODELS`、`switchModelsFor`）、`:134-139`（`launchModelChoices`）；後端 `launch/local.rs:112-142`（`launch_model_plan`） | 前後端各判一次，註解要求「跟後端同一個判斷」（`model-catalog.mjs:131`） |
| 預設啟動設定（指令、參數） | `shared/launcher-profiles.mjs:11-99`（Node 舊版）、`src-tauri/src/launch/profiles.rs:39-156`（Rust，字串次數 15） | 又是兩份 |
| 偵測、安裝、登入 | `agent_tools/catalog.rs:5`（`include_str!("…/shared/agent-tools.catalog.json")`）、`agent_tools/detect.rs`、`install.rs`、`mod.rs:59,70`；`agent_setup/claude_install.rs`、`claude_login.rs:113-154` | **已經有資料驅動的先例**（catalog json），是 0.2.19 manifest 的範本 |
| 在 ASN 自帶終端開 agy／grok | `launch/term.rs:576-589`（`argv_for`，只有 agy 會帶額外參數）、`:2010-2036`（`resolve_command`：白名單寫死只有 `agy` 與 `grok`，並要求執行檔檔名＝profile）、`ui/lib/model-catalog.mjs:61`（前端也有一份 `TERM_PROFILES`） | `term.rs` 全檔字串次數 138，是最大熱點 |
| 讀畫面判斷：Claude | `launch/claude_screen.rs:10-27`（`ClaudeScreenKind`：權限、信任資料夾、略過權限警告、登入失效、額度用完、選項框…）、`:261`（`classify`）；呼叫端 `term.rs:1759-1816`（`permission_checked`／`permission_answer_with`／`phone_answer_with`）、`launch/screen_watch.rs` | 這一組**已經是純函式**（文字進、種類出），最容易抽 |
| 讀畫面判斷：grok／pi | `term.rs:2227-2245`（`grok_input_box`、`grok_processing`，靠 `│ ❯`、`[stop]` 等標記）、`:2397-2414`（`classify_prompt_for`：只有 pi 把行首「→」當選單記號）、`:2501`（`classify_prompt`）、`:1392-1414`（`status`：pi 只看有沒有提問，非 grok 一律 unknown） | 夾在 `TermService` 方法裡，要先剝出純函式 |
| 判斷結束／存活 | `term.rs:97`（`window_gone`）、`:65-67`（`EARLY_EXIT_WATCH`，早退偵測）、`launch/mux_watch.rs`、`launch/auto_resume.rs`；信件側 `bridge/engines/acp_worker.rs`（工作者存活）、`bridge/engines/pi.rs:43`（`parse_window`） | 各家「怎樣算結束」目前不是同一種訊號 |
| 判斷登入失效 | Claude：`login_watch.rs`（讀對話紀錄，設計見 `docs/design/LOGIN-EXPIRED-ALERT.md`）、畫面 `ClaudeScreenKind::Login`（`claude_screen.rs:18`）、`bridge/core/quota.rs`、`launch/auto_resume.rs:77`（`fn login`）；ACP：`bridge/engines/acp_policy.rs:449`（`classify_failure`，字串比對）、`acp_worker.rs:709`（401 自動重開驅動） | 三個機制各管一塊 |
| ACP 背景通道（Gemini＝agy、Grok） | `bridge/engines/acp_agy.rs`（`AgyDriver`，`agy_args:21`）、`acp.rs`、`acp_client.rs`、`acp_models.rs:73`（`parse_agy_models`）、`acp_policy.rs:75`（`category_of_agy_tool`） | 核心已有 `Driver`／`Guard` 兩個 trait（`acp_worker.rs:69,77`） |
| Codex／pi 信件側引擎 | `bridge/engines/codex.rs`、`codex_ops.rs`、`codex_state.rs`、`pi.rs`、`pi_control.rs`、`pi_adopt.rs`、`grok_adopt.rs` | 已實作核心的 `Engine` trait（`engines/mod.rs:68`） |
| 遠端開窗允許規則 | `bridge/launcher.rs:70-77`（`remote_allowed`：視窗型只認 engine 為空／claude／pi；背景型只認 grok、gemini 的 acp） | 規則寫死廠商名 |
| 換模型、視窗管理 | `launch/switch.rs`（`looks_like_claude:120`、`rewrite_args:195`）、`bridge/partner_ops.rs`（pi 走 `pi_control`，Codex 走 `codex_ops`）、`launch/console.rs:115-129`（依 engine 分三路） | |
| 額度、帳號 | `acct_remote.rs`（字串次數 52）、`claude_quota.rs`、`claude_accounts.rs`、`codex_accounts.rs` | **這版計畫不動**：屬額度系統（0.2.12）而非廠商適配 |

另外有兩個已存在、可直接沿用的介面，**新設計要接在它們旁邊，不要平行再造一套**：

- `Engine`（`bridge/engines/mod.rs:68-106`）：信件側，列名單、轉交一封信、回報結果。ACP／Codex／pi／Aegis 已實作。
- `Driver`＋`Guard`（`bridge/engines/acp_worker.rs:69-113`）：ACP 驅動與政策詢問。

新的 `VendorAdapter` 負責的是這兩者**之外**的那一半：啟動方式、畫面判斷、回答該送什麼鍵、結束與登入判斷、目錄與設定。必要時 `VendorAdapter` 可以**回傳**對應的 `Engine`／`Driver` 工廠，但不取代它們。

### 2.3 運行方式：四種，要能全部涵蓋

#931 的「運行」四選項，與現有程式碼的對照如下（對照是**推斷**，命名以 #931 定案為準）：

| #931 名稱 | 現有程式碼中的對應 | 現況 |
|---|---|---|
| asn終端（原生 cli） | `model-catalog.mjs` 的 `term`；Claude／Codex／pi 走 `launch/win_term.rs`（`WinTermHost`，`:114`）＋ mux；agy／grok 走 `launch/term.rs` 的 `TermService` | 兩條不同的程式路徑 |
| asn終端（pi shell） | `model-catalog.mjs` 的 `pi`；`launch/pi.rs`、`launch/pi_term.rs`（`PiTermHost`，`:15`）、`pi_setup.rs` | 0.2.17 要讓它真正可用 |
| acp通道（無介面） | `model-catalog.mjs` 的 `acp`；`bridge/engines/acp*.rs`、`launch/local.rs:237`（`enqueue_background`） | Gemini、Grok 可用；Claude 不做 |
| 原始 cli 視窗 | 現行 `runOptions` 的 `self`（`:82`，只顯示說明、不能選）與 `win_term` 失敗後的退路（`WIN_TERM_FALLBACK`，`win_term.rs:11`、`launch/local.rs:297` `start_window_windows`／`:640` `start_window_unix`） | 要確認它在 #931 裡是「ASN 幫開的一般視窗」還是「使用者自己開、ASN 接手」（見 §9 Q3） |

介面因此把運行方式列成**列舉**，每家廠商宣告它支援哪幾種、不支援的理由，而不是各處寫 `mode == 'background'`：

```ts
type RunKind = 'asn-term-native' | 'asn-term-pi' | 'acp-channel' | 'raw-cli-window'
```

### 2.4 測試現況（「行為不變」的證明要靠這些）

- 前端：`relay/asn/scripts/run-tests.mjs` 跑 `test/*.test.mjs`（`npm test`）。與本計畫直接相關的有 `core.test.mjs`、`partner.test.mjs`（目錄一致性）、`partner-launch-ui.test.mjs`、`launch-*.test.mjs`、`mobile-launch*.test.mjs`、`partner-ops*.test.mjs`。
- Rust：`npm run test:rust`（`cargo test`）。`launch/term.rs` 內建大量情境測試（`:3300` 起），畫面判斷有真實畫面樣本（例如 `tests/fixtures/term-screens/`，`term.rs:4409` 引用）。
- 另有 `launch/auto_resume.rs:489-499` 用 `include_str!` 掃原始碼的守門測試，這是現成的「靜態守門」寫法，本計畫的守門測試沿用。

---

## 3. 總體設計

### 3.1 三個介面、一種打包

| 介面 | 在哪一層 | 版本 | 一句話 |
|---|---|---|---|
| `mailTransport`／`desktopExtras` | 前端 JS | 0.2.18 | 把傳輸切成兩份，核心只吃第一份 |
| `VendorAdapter` | Rust（＋JS 目錄資料） | 0.2.19～0.2.21 | 一家一份：啟動、判斷畫面、答什麼鍵、結束與登入、目錄與設定 |
| `NotifyChannel` | Rust | 0.2.22 | 送一則通知給本人 |
| `PlatformHost` | Rust | 0.2.23 | 開窗、程序生命週期、終端服務安裝與接回 |

打包方式：**全部編進主程式**，用一份 `Registry` 在啟動時登記。不做動態載入。每個插件是一個資料夾＋一份 manifest（JSON，`include_str!` 進 Rust、`import` 進前端，沿用 `agent_tools/catalog.rs:5` 的做法），讓「顯示用的資料」只有一份來源。

### 3.2 邊界原則（所有版本共用）

1. **插件是純判斷＋資料，核心是動手的人。** 適配介面的函式簽名裡看不到 `Pane`、`Child`、`Relay`、金鑰、檔案寫入器。要讀畫面，核心讀完把文字交進去；要送鍵，插件回傳鍵序列，核心檢查後才送。
2. **適配只能收窄、不能放寬。** 核心的檢查（資料夾授權、視窗在前景、窗格是 ASN 開的、提示內容雜湊沒變、一次只送必要的鍵）在插件前後都跑；插件回的答案超出核心允許範圍就丟掉。
3. **不認得就是沒有。** 插件對畫面的判斷採既有原則——「寧可漏報，不可給錯按鈕」（`claude_screen.rs:6`）：任何一點對不上就回「需要人工確認」，不給按鈕。
4. **manifest 是資料，不含程式。** 設定欄位只能宣告型別，不能宣告「祕密」類型（§7）。
5. **畫面上的文字寫給使用者**：manifest 裡的 `why`、`label` 等會顯示在畫面的字串，遵守頁面文案規則（不放議題編號、內部原因、系統元件名）。#931 截圖上的「刻意不做（帳務風險，#273）」就是現行 `model-catalog.mjs:7` 違反這條的例子，0.2.19 搬 manifest 時順手改成使用者的話（或不列）。

---

## 4. 0.2.18：拆前端 transport＋AsnCore 傳輸契約

### 4.1 要做的事

1. `ui/lib/tauri.mjs` 的 `transport` 拆成 `mailTransport`（12 個）與 `desktopExtras`（46 個，依 §2.1 的子群分成 `ops/self/launch/term/screen/switch/quota/pi/site` 九個命名空間，扁平方法名保留別名）。
2. 為了「只改匯入、行為不變」，**暫時保留** `export const transport = { ...mailTransport, ...desktopExtras }` 作為相容出口；各呼叫端分批改成只 import 自己要的那份。相容出口在 0.2.19 發版時刪除。
3. 寫一頁 `docs/design/ASNCORE-TRANSPORT.md`（傳輸契約）並凍結：12 個方法的輸入輸出、錯誤包法（一律 `Error(字串)`，見 `tauri.mjs:5`）、哪些選用（`localWindows`、`avatar` 三個、`sendAttachment`、`history`、`sentStatus`、`readSync`，見 `core.mjs:3` 註解與 `core.mjs:225,423,475,555,602` 的 `typeof` 判斷）、哪些有逾時包裝（`core.mjs:75`）。
4. `core.mjs:74` 的 `{ ...transport }` 改成**只挑契約內的方法**（白名單），傳多的忽略。

### 4.2 介面草案

```ts
// ui/lib/transport-contract.mjs（新）
export const MAIL_TRANSPORT_METHODS = Object.freeze([
  'list', 'inbox', 'ack', 'send', 'history', 'sentStatus', 'readSync',
  'avatar', 'partnerAvatar', 'setAvatar', 'sendAttachment', 'localWindows',
])
export function pickMailTransport(t) { /* 回只含上面 12 個的新物件 */ }
```

```ts
// ui/lib/tauri.mjs
export const mailTransport    = { list, inbox, ack, send, history, /* … 共 12 */ }
export const desktopExtras    = { ops: {…}, self: {…}, launch: {…}, term: {…}, screen: {…}, switch: {…}, quota: {…}, pi: {…}, site: {…} }
export const transport        = flat({ mailTransport, desktopExtras })   // 相容出口，0.2.19 刪
```

### 4.3 動到哪些檔

| 檔 | 改什麼 |
|---|---|
| `ui/lib/tauri.mjs` | 拆分、保留相容出口 |
| `ui/lib/transport-contract.mjs`（新） | 契約清單與 `pickMailTransport` |
| `ui/lib/core.mjs:3,74-78` | 契約註解對齊、改用白名單 |
| `ui/list.js`（1927 行，import 在 `:41`，用到 transport 的點約 60 處，見 `:188-1789`） | 改 import；`new AsnCore({ transport: mailTransport … })`（`:278`） |
| `ui/m.js:42-81` | 本來就是切開的；把本地的 `transport` 物件改為 `pickMailTransport`，與電腦版共用契約檢查 |
| `ui/chat.js:11,57`、`ui/chat.html:22` | 對話窗 `agent-api` 改傳 `desktopExtras`（含 `ops` 與 `switch`） |
| `ui/lib/actionbar.mjs`、`archive.mjs`、`partner-ops-ui.mjs`、`model-switch.mjs`、`term-panel.mjs`、`term-chat.mjs`、`connect-tools.mjs`、`env-notice.mjs`、`remote-machines.mjs`、`mobile-acct.mjs` | 參數名 `api`／`transport` 不變，只確認收到的是哪一份（多半不需改，只改呼叫端傳入） |
| `test/` | 新增契約測試（見下） |

### 4.4 搬遷步驟（每步可獨立提交）

1. 先加 `transport-contract.mjs` 與契約測試，不動任何現有檔。
2. `tauri.mjs` 拆出兩個物件並保留 `transport` 相容出口；此時全部呼叫端仍用 `transport`，**整套測試必須全綠**。
3. 逐檔把呼叫端改成明確匯入（先 `chat.js`，再 `list.js`，最後 `m.js`）。
4. `core.mjs` 改白名單。
5. 寫 `ASNCORE-TRANSPORT.md`。
6. 刪相容出口（若審查者要求留一版，順延到 0.2.19）。

### 4.5 測試與「行為不變」怎麼證明

- **方法清單快照**：新增測試把改版前 `Object.keys(transport)` 的 58 個名字寫成固定清單，斷言改版後 `Object.keys(相容出口)` 逐項相同、且 `mailTransport` ∪ `desktopExtras` 恰好等於這 58 個、互不重複。
- **契約靜態檢查**：掃 `ui/lib/core.mjs` 原始碼裡所有 `this.transport.<名字>`，斷言名字都在 `MAIL_TRANSPORT_METHODS` 內（沿用 `auto_resume.rs:489` 那種掃原始碼的守門寫法）。
- **反向守門**：斷言 `mailTransport` 的鍵裡沒有任何 `term*`、`launch*`、`partner*Permission*`、`pi*` 開頭的方法；斷言 `new AsnCore({ transport: { ...mailTransport, termSend: spy } })` 之後 `core.transport.termSend` 為 `undefined`（白名單生效）。
- 既有 `core.test.mjs`、`partner-ops-ui.test.mjs`、`mobile-*.test.mjs` 不改一行就要綠（若需改，代表行為變了，要回頭查）。
- `npm run smoke:ui`（`package.json` 的 script）跑一次，確認 `list.html`、`chat.html`、`m.html` 三個入口都能開。

### 4.6 實機驗收

- 電腦（工作機）：收信、寄信、傳照片、已讀同步、開對話窗、對話窗上方功能列（開主控台、切模型）、開新夥伴、ASN 自帶終端看畫面與回答提示。
- 手機：收信、寄信、傳照片、夥伴管理選單、替電腦切換帳號。
- 對照 0.2.17 的截圖／操作錄影（同一批動作），人工比對無差異。

### 4.7 回退

純前端、無資料格式變更：直接 revert 該版 commit 即可；已安裝的使用者更新回 0.2.17 無相容問題。

### 4.8 預估改動量（推斷）

新增約 150 行（契約＋測試）；`tauri.mjs` 重排約 120 行；呼叫端 import 改動約 60 行；文件一頁。純機械性，1 位開發員 1～2 天加驗收。

---

## 5. 0.2.19：廠商適配介面（先搬 agy 一家）

### 5.1 為什麼先搬 agy

agy 同時橫跨四種運行方式裡的兩種（ACP 通道、ASN 自帶終端），差異點最多，又沒有 Claude 的帳務與登入複雜度，能最完整地驗證介面長得對不對。其他家照舊，不碰。

agy 目前的觸點（要搬的範圍）：

| 面向 | 觸點 |
|---|---|
| 目錄 | `model-catalog.mjs:9`（`gemini`，toolId 為 `agy`）、`launcher-profiles.mjs:126`、`:58-70`（`profileGemini`） |
| 型號 | `model-catalog.mjs:103-110`（`GEMINI_MODELS`）；`bridge/engines/acp_models.rs:73`（`parse_agy_models`） |
| 偵測 | `shared/agent-tools.catalog.json`（agy 一項）、`agent_tools/detect.rs` |
| 終端啟動 | `term.rs:576-589`（`argv_for` 的 agy 專屬 `--settings`）、`:2010-2036`（`resolve_command`，agy 對應啟動設定裡叫 `gemini`） |
| ACP 通道 | `bridge/engines/acp_agy.rs`（整檔）、`acp_policy.rs:75`（`category_of_agy_tool`）、`:403`（`describe_agy_tool`） |
| 畫面判斷 | 目前 agy 在終端裡**沒有**專屬規則：`term.rs:1401-1413` 對非 grok 回 unknown（「只有 grok 有閒置規則」）；提問判斷走通用的 `classify_prompt`（`:2501`） |
| 結束／登入失效 | ACP 側 `acp_policy.rs:449`（`classify_failure`）、`acp_worker.rs:709` |

### 5.2 介面草案（Rust）

新增模組 `src-tauri/src/vendors/`（與 `launch/`、`bridge/` 平行）：

```rust
// vendors/mod.rs
pub trait VendorAdapter: Send + Sync {
    /// 穩定代號，如 "agy"。manifest 的 id 與它一致。
    fn id(&self) -> &'static str;
    fn manifest(&self) -> &'static VendorManifest;       // 目錄、運行支援、型號、設定欄位（資料）

    // ---- 啟動（只描述，不執行；核心檢查白名單與環境後才執行）----
    fn launch_plan(&self, run: RunKind, req: &LaunchRequest, profile: &ProfileView)
        -> Result<LaunchPlan, String>;                   // argv、額外環境變數名稱清單（不含值）、cwd 規則

    // ---- 讀畫面（純函式：文字進、判斷出）----
    fn classify_screen(&self, text: &str) -> ScreenState;
    fn answer_keys(&self, prompt: &PromptView, answer: &Answer) -> Result<Vec<KeyStroke>, String>;

    // ---- 結束與登入 ----
    fn judge_exit(&self, evidence: &ExitEvidence) -> ExitVerdict;
    fn judge_login(&self, evidence: &LoginEvidence) -> LoginVerdict;

    // ---- 信件側（有就回，沒有回 None；不取代既有 Engine/Driver）----
    fn acp_driver(&self, _args: DriverArgs) -> Option<Box<dyn Driver>> { None }
}

pub enum ScreenState {
    Idle, Busy, Unknown(String),                          // Unknown 的字串只進記錄，不進畫面
    Prompt(PromptView),                                   // 需要人回答；PromptView 含種類、文字、選項、游標
    LoginExpired, UsageLimit,
}
pub struct LaunchPlan { pub argv: Vec<String>, pub env_names: Vec<String>, pub cwd: CwdRule }
pub struct KeyStroke(/* 只允許可見字元、數字、方向、Enter、Esc 等白名單鍵 */);
```

設計重點：

- `ScreenState` 與現有 `ClaudeScreenKind`（`claude_screen.rs:10-27`）、`term.rs` 的 `ScreenPrompt`（`:2270`）、`TermStatus.state`（`:233`）對齊，**第一步是把三種既有回傳型別收成同一個**，不是發明新語意。
- `answer_keys` 是純函式。現行 `term.rs:1802-1816` 的「重查文字雜湊、只送一個數字鍵不帶 Enter」這套核心檢查**原封不動留在核心**，適配只負責「這個選項號碼對應哪個鍵」（目前 `menu_keys`、`trust_keys`、`encode_key` 在 `term.rs:2293-2339`）。
- `launch_plan` 回傳的 argv 仍要過核心的 `resolve_command` 同級檢查（執行檔檔名＝該廠商、不含控制字元，`term.rs:2023-2034`），以及 `child_env`／`acp_clean_env`／`codex_child_env`（`engines/mod.rs:163-176`）的環境過濾。**插件只能指名要哪些環境變數名稱，值由核心填；金鑰類一律被核心濾掉。**
- `judge_exit`／`judge_login` 的 `evidence` 是核心整理好的**事實**（最後輸出、結束碼、錯誤文字），不是檔案或程序。

### 5.3 Manifest（資料）

`relay/shared/vendors/agy.json`，由 Rust `include_str!`、前端以 JSON 匯入（沿用 `agent-tools.catalog.json` 的先例）。欄位：

```jsonc
{
  "id": "agy",
  "label": "Gemini",
  "toolId": "agy",             // 對應 agent-tools catalog
  "profileId": "gemini",       // 對應啟動設定的 key（歷史包袱：id 與 profileId 不同）
  "runs": {
    "acp-channel":      { "status": "ok",      "why": "" },
    "asn-term-native":  { "status": "noinbox", "why": "可以開在 ASN 的終端裡，但收不到信，只能看畫面、送字" },
    "asn-term-pi":      { "status": "no",      "why": "pi 已不支援 Gemini 訂閱登入" },
    "raw-cli-window":   { "status": "…" }
  },
  "models": [ { "id": "gemini-4-argon-high", "label": "…", "runs": ["acp-channel"] } ],
  "settings": []               // 0.2.21 才有內容
}
```

`runs` 的 `status` 沿用現有字彙（`ok/window/noinbox/untested/no`，`model-catalog.mjs:38`）；`why` 一律寫給使用者看。

### 5.4 動到哪些檔

| 檔 | 改什麼 |
|---|---|
| `src-tauri/src/vendors/{mod,registry,agy}.rs`（新） | trait、登記表、agy 實作 |
| `shared/vendors/agy.json`（新） | agy manifest |
| `launch/term.rs:576-589,2010-2036` | agy 的 `argv_for`／`resolve_command` 分支改為呼叫適配（白名單檢查本身留著） |
| `bridge/engines/acp_agy.rs`、`acp_models.rs`、`acp_policy.rs`（agy 相關函式） | 函式搬到 `vendors/agy.rs` 或由它轉呼叫；`AgyDriver` 仍實作既有 `Driver` |
| `bridge/launcher.rs:70-77` | `remote_allowed` 的 gemini 判斷改查登記表 |
| `ui/lib/model-catalog.mjs`、`shared/launcher-profiles.mjs` | agy（gemini）那一列改由 manifest 產生；其餘四家照舊。`MODEL_CATALOG` 兩份仍並存，一致性測試保留 |
| `ui/lib/tauri.mjs` | 刪 0.2.18 的相容出口 |

### 5.5 搬遷步驟

1. 建 `vendors/` 骨架＋空的登記表；`VendorAdapter` trait 與型別。**此時不接任何呼叫點。**
2. 寫 agy manifest；加測試比對 manifest 衍生的目錄列＝現行 `MODEL_CATALOG` 的 gemini 列（逐欄位相同）。
3. 把 `argv_for`／`resolve_command` 的 agy 分支改為「問適配，再過同一個核心檢查」；舊分支留到測試全綠後再刪。
4. 把 ACP 的 agy 專屬函式搬進適配檔，`acp.rs` 透過登記表取驅動。
5. `classify_screen` 先**只實作現況等價物**（agy 終端沒有專屬規則，維持 `Unknown` 或通用提問判斷），不趁機加規則。
6. 前端目錄那一列改讀 manifest。
7. 刪舊分支與相容出口。

### 5.6 測試與「行為不變」

- **黃金測試（golden）**：改版前先用現有程式把下列輸出存成固定檔，改版後逐位元組比對——(a) agy 在三種運行方式下的 `launch_plan` argv（含 `--settings` 有／無兩種）；(b) `acp_agy::agy_args`（`:21`）在 `full_access` 真／假的輸出；(c) `parse_agy_models` 對既有樣本的輸出；(d) manifest 產生的目錄列。
- **畫面樣本回歸**：`tests/fixtures/term-screens/` 內所有樣本，對 `classify_screen("agy", …)` 的結果必須與改版前的 `classify_prompt` 結果相同。
- **守門測試（必寫）**：
  - 用 `include_str!` 掃 `vendors/*.rs`，斷言不 `use` 金鑰模組（relay 憑證）、不呼叫 inbox／ack 相關函式、不引入 `WezTerm`／`Pane` 型別。
  - 適配回傳含控制字元或非白名單鍵的 `KeyStroke`／`argv` 時，核心端拒絕並記錄（偽造一個壞適配做測試）。
  - 適配 panic 或逾時，核心當作「沒有答案」，不送任何鍵（預設拒絕）。
- 既有 `bridge/tests/engines_it.rs`、`term.rs` 內 agy／grok 情境測試不改就要綠。

### 5.7 實機驗收

- 一台有 agy 的電腦：開 Gemini 夥伴（內建通道）→ 收信、回信、權限詢問、換型號、停止。
- 同一台：在 ASN 自帶終端開 agy → 看畫面、送字、關閉、重開 ASN 後認回。
- 手機：替那台電腦開 Gemini 夥伴（遠端開窗）。
- 與 0.2.18 版逐項對照。

### 5.8 回退

Rust 與資料都沒有格式變更：revert 即可。保留舊分支到下一版（0.2.20）才刪，作為緊急退路（以 feature flag 或保留函式二選一，見 §9 Q5）。

### 5.9 預估改動量（推斷）

新增約 600～900 行（trait、登記表、agy 實作、manifest、測試）；搬動約 400 行；`term.rs` 只動 agy 分支約 30～50 行。1～2 位開發員約 1 週，加兩輪驗收。

---

## 6. 0.2.20：其餘廠商搬進同一介面（Claude、Codex、Grok、pi）

### 6.1 建議順序（一家一個 PR，可個別發版前的內部合併）

1. **Grok**：最像 agy（ACP＋自帶終端），規則已有（`term.rs:2227-2245`）。
2. **Codex**：信件側引擎完整（`bridge/engines/codex*.rs`），畫面判斷幾乎沒有。
3. **pi**：`classify_prompt_for` 的「→」特例（`term.rs:2397-2414`）、`pi_term.rs`、`pi_setup.rs`、`pi_models.rs`；與 0.2.17 的登入改版相鄰，**必須等 0.2.17 發完再動**，避免兩邊同時改 pi。
4. **Claude 最後**：畫面判斷最完整（`claude_screen.rs` 842 行）、牽涉帳號切換、額度、登入失效偵測、換模型、子代理與背景工作查詢，是風險最大的一家。

### 6.2 各家要處理的重點

| 廠商 | 重點 |
|---|---|
| Grok | `grok_input_box`／`grok_processing`（閒置判斷）→ `classify_screen` 的 `Idle`／`Busy`；`grok_adopt.rs`（接手既有 grok 對話） |
| Codex | 啟動參數（`launcher-profiles.mjs:44-56`、`profiles.rs`）；`codex_ops.rs` 的關閉與換模型目前標「未實機驗證」（`engines/mod.rs:17`），**搬遷時不補功能、不轉正**，維持現狀 |
| pi | 啟動需帶擴充與提供者／模型（`LocalLaunchReq.pi_provider/pi_model`，`launch/mod.rs:73-77`）；「經 pi」同時是運行方式 `asn-term-pi` 與廠商 `pi` 本身，manifest 要能表達「channelOnly」（`model-catalog.mjs:58`） |
| Claude | `claude_screen.rs` 整檔搬到 `vendors/claude/screen.rs`（它本來就是純函式，連測試一起搬）；`launch/switch.rs`、`subagents.rs`、`tasks.rs` 屬 Claude 專屬的視窗資訊，歸 `vendors/claude/`；登入失效的 `login_watch.rs` 屬核心偵測（讀紀錄檔），只把「哪種錯誤算失效」這份判斷交給適配的 `judge_login` |

### 6.3 要補進介面的東西（在 0.2.19 後才看得出缺什麼）

- `ModelSwitch`：換模型的方式因家而異（Claude 關了重開、pi 走檔案管道 `pi_control.rs`、agy 原生切換 `Driver::set_model`，`acp_worker.rs:104`）。預計加 `fn switch_model(&self, …) -> SwitchPlan`，**同樣只回計畫，由核心執行**。
- `AdoptHint`：接手使用者自己開的 CLI（`term_adopt.rs`、`grok_adopt.rs`、`pi_adopt.rs`）要辨認「這是不是我家的程式」。
- 若 0.2.19 的 trait 要大改，**允許在 0.2.20 內調整**，但調整前先回頭確認 agy 的黃金測試仍全綠。

### 6.4 動到哪些檔

`vendors/{claude,codex,grok,pi}.rs`（新）；`launch/term.rs`（刪各家分支，是最大改動；建議每家一個 commit）；`launch/claude_screen.rs`（搬走）；`launch/{switch,subagents,tasks}.rs`（Claude 專屬部分搬走）；`bridge/launcher.rs`、`bridge/partner_ops.rs`、`launch/console.rs:115-129`、`launch/local.rs`（`launch_model_plan`）、`launch/profiles.rs`（預設啟動設定改由適配提供）；`ui/lib/model-catalog.mjs`、`shared/launcher-profiles.mjs`（`MODEL_CATALOG` 全改由 manifest 產生，**兩份合併為一份來源**，`partner.test.mjs:9` 的比對測試改成比對 manifest）。

### 6.5 測試與「行為不變」

- 同 0.2.19 的黃金測試方法，每家各做一份：啟動 argv（各運行方式×有無型號）、畫面樣本→`ScreenState`、答案→鍵序列、目錄列。
- Claude 的 `claude_screen.rs` 既有單元測試**整批隨檔搬移、一個不刪**；搬完前後測試個數相同（用腳本比對 `#[test]` 數量）。
- 守門測試擴充到所有 `vendors/*.rs`。
- 全套 `cargo test` ＋ `npm test` ＋ `smoke:ui`。

### 6.6 實機驗收

每家各一台實機走一遍：開（四種運行方式中該家支援的）→ 收發信 → 權限框／選項框回答（電腦與手機）→ 換模型 → 關閉 → 重開 ASN 認回。Claude 另外加：帳號切換、登入失效通知、額度回報、子代理與背景工作查詢、重開機後自動接回（`auto_resume.rs`）。

### 6.7 回退

每家一個 commit：可只 revert 出問題的那一家。整版若要退，回 0.2.19（agy 在適配上、其餘舊路徑）仍可運作，因為 0.2.19 的新舊並存設計；因此 0.2.20 發版**前**不得刪掉 0.2.19 的舊分支以外的共用函式（待決 Q5）。

### 6.8 預估改動量（推斷）

最大的一版：新增約 1500～2500 行，搬動約 3000 行（`term.rs` 與 `claude_screen.rs` 為主）。建議 2 位開發員分 Claude 與其他三家平行，約 2 週，驗收需四台以上實機環境。若審查者認為太大，**建議拆成 0.2.20（Grok、Codex）與 0.2.20.1（pi、Claude）**，但這會動 #935 的版本表（待決 Q4）。

---

## 7. 0.2.21：插件自帶設定＋權限框回答鏈（預設拒絕）

### 7.1 要做的事

**A. 插件自帶設定欄位**

1. manifest 的 `settings` 宣告欄位；設定頁（`ui/list.js` 的設定區，現有 `launchPrefsGet/Set` 在 `:437-448`、`launch/prefs.rs` 25 行）與「開新夥伴」第 2 頁**統一從 manifest 產生欄位**，不再為各家各寫一段 UI。
2. 欄位型別限定：`bool`、`enum`、`string`（有長度與字元限制）、`path`（走既有的資料夾授權清單，不能自由輸入）、`number`（有範圍）。**不提供「密碼／金鑰／權杖」型別**，manifest 驗證器遇到就拒收；字串欄位的值若長得像金鑰也在寫入時被核心擋下（沿用 `acp_policy.rs:323` `redact` 的判斷詞表，細節實作時再定）。
3. 儲存在各自命名空間下（`launch-prefs.json` 的 `vendors.<id>.*`），插件只讀得到自己那一塊。
4. 目前散在各處的廠商專屬設定要收進來——例如 pi 的提供者／模型（`LocalLaunchReq`）、Gemini 型號（`launchModelChoices`）、agy 額外參數（`term.rs:571` 的 `AgyArgs`）。

**B. 權限框回答者做成鏈，預設拒絕**

現況（只列事實）：

- ACP：`Guard::ask_permission`（`acp_worker.rs:71`）→ `decide`（`acp_policy.rs:207`，政策判定）→ 需要人時走 `Approvals`（`acp_approvals.rs:94`，等本人回信，逾時走拒絕，見 `:196` 附近 `finish(&id, Answer::Deny)`）。
- 終端畫面：Claude 的權限框／選項框由本人在電腦（`partner_permission_answer`，`term.rs:2835`）或手機（`phone_answer_with`，`:1787`）按；沒人按就一直停在畫面上，**不會自動送任何鍵**。

新增（行為先與現況等價，再談擴充）：

```rust
pub trait ApprovalResponder: Send + Sync {
    fn id(&self) -> &'static str;
    /// 給出明確答案，或 None 表示「我不管這個」。永遠不會有「預設允許」。
    fn respond(&self, req: &ApprovalRequest) -> Option<Decision>;   // Decision::{Allow, Deny}
}
pub struct ApprovalChain { responders: Vec<Box<dyn ApprovalResponder>>, on_exhausted: Decision /* 固定 Deny */ }
```

- 鏈的順序由核心寫死（先政策、後本人）；插件**只能新增排在「本人」之後的觀察者或建議者，不能插到前面自動放行**（待決 Q6）。
- 沒有任何回應者給出明確答案＝**拒絕**（ACP 路徑）；畫面路徑則維持「不送鍵、維持原提示」，兩者的語意差別在介面註解寫清楚。
- `Allow` 仍須通過 §3.2 第 2 點的核心檢查才會變成按鍵。

### 7.2 動到哪些檔

`vendors/{mod,settings,registry}.rs`；`launch/prefs.rs`、`ui/lib/launch-prefs.mjs`（命名空間）；`ui/list.js` 設定區與開新夥伴對話框（`ui/lib/partner-launch-ui.mjs`、`mobile-launch.mjs`）改為由 manifest 渲染；`bridge/engines/acp_policy.rs`、`acp_approvals.rs`、`acp_worker.rs`（`Guard` 實作改為走鏈）；`launch/term.rs:1759-1816`（權限檢查呼叫點）。

### 7.3 測試與「行為不變」

- 設定：每個既有設定項寫一筆「舊存檔→新讀法→值相同」的遷移測試（舊 `launch-prefs.json` 不需改格式即可讀，新增命名空間欄位向下相容）。
- 權限鏈：把現有 ACP 授權相關測試（`bridge/tests/respond_it.rs`、`engines_it.rs` 內授權情境、`acp_approvals` 單元測試）**原樣跑一遍**；新增表格式測試——(政策判定, 本人回答, 逾時) 各種組合的最終結果＝改版前的結果。
- 守門：manifest 驗證器對「金鑰型欄位」「未知型別」「路徑越出授權清單」各一條拒收測試；回應者 panic／逾時＝拒絕；沒有回應者＝拒絕。
- 文案檢查：掃 manifest 的所有 `label/why/help`，不得含 `#數字`、`TDengine` 這類內部詞（寫一條簡單的 regex 測試，呼應頁面文案規則）。

### 7.4 實機驗收

- 設定頁每個廠商欄位：改、存、重開 ASN 仍在；手機開新夥伴看到同樣欄位。
- ACP 夥伴（Gemini）觸發一次需要授權的動作：本人手機回「允許」→ 執行；回「拒絕」→ 不執行；放著不回 → 逾時後不執行。
- Claude 視窗權限框：電腦按、手機按各一次。

### 7.5 回退

設定是新增命名空間、舊欄位不刪：revert 後舊版仍能讀。權限鏈回退即回到直接呼叫舊函式。

### 7.6 預估改動量（推斷）

新增約 800～1200 行（設定框架、渲染、鏈、測試）；UI 改動約 300 行。1～2 位開發員約 1.5 週。

---

## 8. 0.2.22～0.2.24

### 8.1 0.2.22：通知管道（FCM 搬入）

**要做的事：** 抽 `NotifyChannel`，把門鈴後的「通知本人」收進去：Firebase 推播（0.2.11）、系統通知、門鈴延伸。

現況（基準 main）：

- 門鈴接收：`src-tauri/src/bell.rs`（連 `realtime:<bell_topic>`，收到 `bell` 就通知前端去拉信；註解 `:2`）。這是**收**，屬寄信核心，不動。
- 後台側：`supabase/functions/_shared/signal.ts`、`relay/index.ts` 有 FCM 相關程式（grep 命中）；**Rust 與前端沒有 FCM**（推斷：0.2.11 尚在途中，開工時重對）。
- 系統通知：Rust／前端搜 `notification` 無命中（未查實，推斷是別的做法，例如視窗閃動；開工時要找出來）。

介面草案：

```rust
pub trait NotifyChannel: Send + Sync {
    fn id(&self) -> &'static str;                        // "fcm" | "system" | "doorbell-ext"
    fn available(&self) -> ChannelStatus;                // 可用／未設定／被使用者關閉
    fn deliver(&self, n: &Notification) -> Result<(), NotifyError>;   // 成功／失敗，不重試（重試由核心排程）
}
pub struct Notification { pub kind: NoticeKind, pub title: String, pub deep_link: Option<DeepLink> /* 不含信件內文 */ }
```

- `Notification` **不含信件內文與發信者原文**（門鈴原則：只告知有事，不帶內容；內文仍由收件端用金鑰拉取）。
- 通知管道**拿不到金鑰**；FCM 的伺服器端權杖不進這一層（待決 Q7：device token 的存放位置，要由核心代管）。
- 設定欄位走 0.2.21 的 manifest（開關、靜音時段）。

動到的檔（預估）：`src-tauri/src/notify/{mod,fcm,system}.rs`（新）；0.2.11 的 FCM 實作搬入；呼叫點（目前散在 `bell.rs` 之後與 `bridge/core.rs` 的通知寄送，需開工時盤點）；Android 外殼（`src-tauri/gen/android/` 與 `android.rs`）。

測試與行為不變：搬入前後對同一組事件（有新信、被叫醒、登入失效通知等）斷言送出的通知清單相同（用假管道記錄）；守門測試——`Notification` 型別不含內文欄位（編譯期保證），管道實作不引用金鑰模組。實機：手機 App 關著收到推播並點開到對的畫面；電腦收系統通知。回退：revert（FCM 回到 0.2.11 的位置）。預估：新增 300～500 行、搬動 400 行（推斷），1 位開發員約 1 週。

### 8.2 0.2.23：平台介面（Linux 搬入）

**要做的事：** 抽 `PlatformHost`，統一 Windows／Linux（未來 macOS）的：開窗、程序生命週期、終端服務的安裝與接回。

現況（基準 main）：

- Windows 開窗：`launch/local.rs:297`（`start_window_windows`）、`:581`（`start_console_window_windows`）；`launch/win_term.rs`（`WinTermHost` trait `:114`）、`launch/pi_term.rs`（`PiTermHost` trait `:15`）：**兩個長得很像的 trait 並存**，0.2.23 合併成一個。
- Unix 開窗：`local.rs:640`（`start_window_unix`）、`:674`（`pick_linux_terminal`）。
- 終端服務（WezTerm mux）：`launch/mux.rs`、`wezterm.rs`、`mux_watch.rs`、`term_live_mux.rs`，整片用 `#[cfg(desktop)]` 圈起來（`launch/mod.rs:25-38`）。
- Linux 終端服務（0.2.9）：main 上尚未見到完整實作；已有 `test/launch-linux.test.mjs`、`docs/design/LINUX-HEADLESS.md`、`.github/workflows/asn-linux-build.yml`。開工前以屆時 main 為準。

介面草案：

```rust
pub trait PlatformHost: Send + Sync {
    fn open_window(&self, cwd: &Path, spec: &WindowSpec) -> Result<WindowHandleId, OpenError>;   // 回編號，不回控制代碼
    fn process_alive(&self, pid: u32, started_ms: Option<u64>) -> bool;
    fn kill_owned(&self, pids: &[u32]) -> Vec<u32>;       // 只能砍 ASN 自己記過的 pid（沿用 PidBook 規則，engines/mod.rs:111-142）
    fn term_service(&self) -> Option<&dyn TermServiceInstaller>;   // 安裝／啟動／接回；沒有就 None
}
```

- 終端服務**核心**（mux 生命週期、窗格對照表、權限檢查）不搬；搬的是「在這個作業系統上怎麼把它裝起來、接回來」。
- `kill_owned` 只認 ASN 自己記錄過的程序（沿用現行 pid 帳本規則）。

測試與行為不變：Windows 既有 `win_term.rs`／`pi_term.rs` 測試（含 `FakeHost`）合併後數量不減；新增 Linux 版對同一組 `WindowSpec` 的 argv 黃金測試；守門——`PlatformHost` 簽名不回傳窗格或程序控制代碼。實機：Windows 工作機、Linux 一台（有桌面）、Linux 無桌面（若 0.2.9 含）各走：開夥伴→關 ASN→重開認回→停止。回退：revert；Windows 路徑維持原函式至下一版再刪。預估：新增 400～700 行、搬動約 1200 行（推斷），1～2 位開發員約 1.5 週。

> **衝突提醒**：0.2.23 與 0.2.19／0.2.20 都會動 `term.rs`（6687 行）與 `local.rs`。三版不可同時進行；見 §9.2。

### 8.3 0.2.24（視需要）：UI 套件

**要做的事：** 把 ChatPane、Markdown、群組畫面變成有明確匯入出口的套件（現在是 `ui/lib/` 下約 131 個平鋪的 `.mjs`）。

- 候選：`lib/chatpane.mjs`（約 526 行，只收 `friend/me/log` 等 props、只發事件，不碰網路）、`lib/markdown.mjs`、`lib/groups.mjs`／`group-flow.mjs`／`room-hub.mjs`。
- **是否做的判準**（建議由審查者拍板，待決 Q8）：①前三個大版之後 `list.js` 仍超過約 1500 行且新功能持續往裡塞；②ChatPane 有第二個使用者（例如另一個殼）；③ 有人要單獨測試或發佈。三者皆無就不做。
- 若做：每個套件一個資料夾＋`index.mjs` 出口＋依賴規則測試（群組套件不得 import 任何 ack／inbox 相關模組；名單套件不得自己發請求）。
- 預估：視範圍，純搬檔＋改匯入，與 0.2.18 同類，約 3～5 天。

---

## 9. 版本間相依、可平行處、風險與待決

### 9.1 相依關係

```
0.2.16 (#933 裝原生 CLI) ─┐
0.2.17 (#934 登入改經 pi) ─┼─► 之後的適配要涵蓋它們新增的 install/login 流程
                          │
0.2.18 transport 拆分 ────┴──► 0.2.19 agy ──► 0.2.20 其餘廠商 ──► 0.2.21 設定＋權限鏈
                                      │                               │
                                      └──────────────► 0.2.22 通知 ◄──┘（要用 0.2.21 的設定欄位；FCM 本身獨立）
                                      └──────────────► 0.2.23 平台（與 0.2.19/20 同動 term.rs）
                                                                      └──► 0.2.24 UI 套件（視需要）
```

### 9.2 可平行與不可平行

| 組合 | 能否平行 | 理由 |
|---|---|---|
| 0.2.18（前端）∥ 0.2.19 的 Rust 骨架與 manifest | **可以**（開發平行，發版仍依序） | 前者只動 `ui/lib/`，後者先動新目錄 `vendors/`，檔案不重疊 |
| 0.2.19 ∥ #931 開新夥伴改版（分支 `feat/931-launch-copy-remote-bg` 已存在） | **有衝突**：都動 `model-catalog.mjs` 的 `runOptions`／`MODEL_CATALOG`、`mobile-launch*.mjs` | 建議 #931 先發，0.2.19 在其後 rebase |
| 0.2.20 內四家 | **可以**，Claude 與其他三家分兩人 | 各自的 `vendors/<id>.rs` 不重疊；`term.rs` 刪分支的 commit 要排隊合併 |
| 0.2.19／0.2.20 ∥ 0.2.23 | **不可以** | 同時大改 `term.rs` 與 `local.rs` |
| 0.2.21 的設定框架 ∥ 0.2.22 | **部分可以** | 通知管道只依賴設定框架的「型別與儲存」，可在 0.2.21 內先合入框架、0.2.22 再用 |
| 0.2.22 FCM ∥ 其他 | **可以** | 與廠商適配幾乎無交集 |

### 9.3 風險與對策（一般工程風險）

| # | 風險 | 對策 |
|---|---|---|
| 1 | 介面定太早，後面版本發現不夠用 | 0.2.19 只搬 agy，0.2.20 明文允許調整 trait；調整的條件是 agy 黃金測試仍全綠。trait 方法盡量回**資料／計畫**，少回行為，日後加欄位不破壞 |
| 2 | 搬遷時悄悄改了行為（例如畫面判斷的邊界條件） | 每版先做黃金測試（先錄舊行為、再搬、再比對）；搬移與修正**分開 commit**；不順手修 bug（發現的記議題，下版再修） |
| 3 | `term.rs`／`claude_screen.rs` 檔案巨大，合併衝突頻繁 | 0.2.19／0.2.20 期間凍結其他人對這兩檔的非緊急改動；每家一個小 commit、小 PR；先開 PR 描述宣告「正在搬哪一段」 |
| 4 | 兩份目錄資料（JS 與 Rust、前端與 shared）漂移 | 0.2.19 起以 manifest 為唯一來源，兩邊都由它產生或比對；`partner.test.mjs:9` 的一致性測試保留並改為比對 manifest |
| 5 | 守門測試只是形式，掃字串容易被繞過 | 守門以**型別簽名**為主（適配函式簽名裡根本沒有金鑰、窗格型別），字串掃描為輔；審查清單固定列「新增的適配方法簽名」一項 |
| 6 | 實機回歸成本高（多廠商×多平台×手機電腦），拖慢發版 | 驗收清單文件化、可分工；每版只驗該版動到的廠商＋一組共通煙霧測試；`smoke:ui` 與 `cargo test` 在 CI 跑 |
| 7 | 手機與電腦共用核心，改一邊另一邊壞 | 0.2.18 起契約測試同時載入 `m.js` 與 `list.js` 的傳輸物件；每版驗收含手機 |
| 8 | 還有一批在途功能（#931、0.2.9、0.2.11、0.2.12）同時改這些檔 | §9.2 的排程；每版開工前重對 main，更新本文件的行號與推斷處 |
| 9 | 版本表被打亂（某版超時、拆版） | 本計畫每版自成一件事、可獨立回退；0.2.20 預先備好拆版方案（§6.8） |
| 10 | 畫面判斷規則會隨各家 CLI 版本變動（既有問題） | 不在這輪解決；搬進適配後單家改動範圍縮小，且樣本測試集中，是順帶改善 |

### 9.4 待決問題（需要小良哥或領隊拍板）

| # | 問題 | 建議 | 影響版本 |
|---|---|---|---|
| Q1 | **「插件」是否永遠只指內建模組？** 要不要保留日後載入外部插件的可能（那會改變安全模型，需另開一輪設計） | 本輪只做內建；介面不為外部載入預留任何動態載入機制，避免誤開後門 | 全部 |
| Q2 | **0.2.18 要切兩份還是三份？** #935 寫兩份（`mailTransport`／`desktopExtras`）；但「遠端管理」那 7 個（`partnerOp`、`launch`、`launchers`…）既不是信、電腦與手機又都用（手機已另放 `opsTransport`，`m.js:83`） | 維持兩份，`desktopExtras.ops` 命名空間承接；手機的 `opsTransport` 日後與它對齊。若審查者要三份也只是多一個匯出 | 0.2.18 |
| Q3 | **#931 的「原始 cli 視窗」確切指什麼？** 是「ASN 幫開、但開成一般視窗」（現行 `win_term` 退路），還是「使用者自己開、ASN 只接手」（現行 `runOptions` 的 `self`，`:82`） | 請領隊定義；`RunKind` 的第四個值依此命名與實作 | 0.2.19 起 |
| Q4 | **0.2.20 是否拆版？** 四家一起（約 2 週、風險集中在 Claude）或拆成 0.2.20（Grok、Codex）＋0.2.20.1（pi、Claude）。這會改 #935 的版本表 | 建議拆；若不拆，至少要 Claude 單獨一個內部里程碑與回退點 | 0.2.20 |
| Q5 | **新舊並存要留多久？** 每版搬完是否保留舊程式一版當緊急退路（用旗標切換）？代價是重複程式碼與測試 | 建議保留一版、且只在 0.2.19／0.2.20 這兩個動廠商核心路徑的版本；其他版本直接 revert 當退路 | 0.2.19、0.2.20 |
| Q6 | **權限鏈能不能讓插件排在「本人」前面自動回答？** 例如某家廠商插件想對低風險動作自動允許 | 本輪**不允許**；只允許插件當「建議者」（在畫面上標示建議，最終仍由本人按）。要放寬需另案設計與審查 | 0.2.21 |
| Q7 | **推播的裝置權杖（FCM token）由誰保管？** 建議核心代管、`NotifyChannel` 只拿「發送」能力 | 同左 | 0.2.22 |
| Q8 | **0.2.24 做或不做？** 判準見 §8.3 | 先不排，0.2.23 發完再評估 | 0.2.24 |
| Q9 | **manifest 放哪？** `relay/shared/vendors/*.json`（Node 舊橋 `relay/machine/launcher.mjs` 也能讀）或 `src-tauri` 內。舊橋是否還要維持（`shared/launcher-profiles.mjs` 目前兩邊都在用） | 放 `relay/shared/`；舊橋的存廢另案 | 0.2.19 |
| Q10 | **manifest 裡 `why` 等畫面文字要不要在 0.2.19 一併改成使用者的話？** 會讓畫面文字有變，違反「行為不變」的字面 | 建議**要改**（#931 已把此列為缺陷），但單獨一個 commit、在發版說明中列明 | 0.2.19 |
| Q11 | **每版實機驗收的最低配置**：哪幾台、誰操作（Windows 工作機、Linux、手機各一？） | 領隊排；本文件各版「實機驗收」節可直接當清單 | 全部 |

---

## 10. 各版一覽（給審查者速覽）

| 版本 | 主要事項 | 新增介面 | 主要動到 | 改動量（推斷） | 回退 |
|---|---|---|---|---|---|
| 0.2.18 | 拆 transport、凍結 AsnCore 契約 | `mailTransport`／`desktopExtras` | `ui/lib/tauri.mjs`、`list.js`、`chat.js`、`core.mjs` | 小（約 300 行，1～2 天） | revert |
| 0.2.19 | 廠商適配介面，先搬 agy | `VendorAdapter`、manifest | 新 `vendors/`、`term.rs`（agy 分支）、`acp_agy.rs` | 中（約 1000～1500 行，1 週） | revert／舊分支保留一版 |
| 0.2.20 | Claude、Codex、Grok、pi 搬入 | 同上（可能微調） | `term.rs`、`claude_screen.rs`、`switch.rs`、`launcher.rs` | 大（約 2000～4000 行，2 週） | 逐家 revert |
| 0.2.21 | 插件自帶設定＋權限鏈預設拒絕 | `settings` 欄位、`ApprovalResponder` | `launch/prefs.rs`、設定頁、`acp_policy/approvals` | 中（約 1100～1500 行，1.5 週） | revert（存檔向下相容） |
| 0.2.22 | 通知管道（FCM 搬入） | `NotifyChannel` | 新 `notify/`、0.2.11 的 FCM | 小～中（約 700～900 行，1 週） | revert |
| 0.2.23 | 平台介面（Linux 搬入） | `PlatformHost` | `local.rs`、`win_term.rs`、`pi_term.rs`、`mux*.rs` | 中（約 1600～1900 行，1.5 週） | revert |
| 0.2.24 | （視需要）UI 套件 | 套件出口與依賴規則 | `ui/lib/` | 小（搬檔，3～5 天） | revert |

（完）
