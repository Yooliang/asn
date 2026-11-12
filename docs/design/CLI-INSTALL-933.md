# #933 ASN 幫用戶安裝並登入原生 CLI：拆 PR 計畫（草案，等 asn真 親審）

> 狀態：**asn真 已親審同意拆法，第 5 節五件已定案**；照第 5 節順序開工（PR-1 先）。
> 範圍：Claude、Codex、Gemini（agy）、Grok 四家的「偵測 → 安裝 → 登入 → 驗證」，電腦版本機觸發與手機遠端觸發。
> pi 本身的安裝與經 pi 登入屬 #934，不在這份；但這份做出的共用零件 #934 會沿用。
> 依據：#933、#931、#934、#628、#629、#343，PLUGIN-PLAN §1.3、§1.4、§5.2、§5.2b，以及 main 432a69af 的程式。
> 安全面只寫原則與做法；具體的威脅分析放非公開管道（asn-security），不寫進這份。

## 0. 現況（main 432a69af）

| 項目 | 狀態 | 位置 |
|---|---|---|
| Claude 安裝 | **已有「驗過再執行」**：只連 `downloads.claude.ai`、不跟轉址；比對 sha256、鎖檔後重算、Authenticode 簽署者必須完全等於 `Anthropic, PBC`；執行驗過的同一個檔；裝完再驗一次 | `agent_setup/claude_install.rs`、`authenticode.rs`、`net.rs` |
| Claude 登入 | **已有**（授權碼送回型）：`claude auth login --claudeai`，網址經 `secret_remote` 送到本人手機，授權碼加密回傳、只在記憶體、寫進標準輸入後清零；`claude auth status` 結束碼確認 | `agent_setup/{login,claude_login,phone,link,proc}.rs` |
| 手機遠端觸發 | **已有，只限 Claude**：後台 `setup_requests`（`kind` 只收 `'claude'`）、要本人登入憑證才建得了請求；本機三道把關（開關預設關、ASN 已登入、同一個帳號） | `agent_setup/{remote,switch,setup}.rs`、`20261102140000_setup_requests.sql`、`functions/relay/index.ts:464` |
| 畫面入口 | **藏著**：`AGENT_INSTALL_UI = false`（dde5b99b「真機跑過再開」） | `ui/lib/device-state.mjs:164`、`settings-panel.mjs:349,374`、`mobile-setup.mjs:72` |
| 其他三家安裝 | **舊路還在**：`ai_cli_install` 對 Claude 以外的工具仍是 `irm <網址> \| iex`（Windows）／`curl \| bash`（其他）／`npm install -g`。前端沒有呼叫，但 Tauri 指令仍註冊著 | `agent_tools/install.rs:67-120`、`lib.rs:2615` |
| 偵測 | 只看 PATH；目錄與 JS 共用 | `agent_tools/{detect,catalog}.rs`、`relay/shared/agent-tools.catalog.json` |

結論：Claude 的整條路已寫好、沒真機跑過；其他三家要補「驗過再執行」的安裝與各自的登入型，並先把舊的「執行網路腳本」那條路關掉。

## 1. 共通規則（每張 PR 都要守）

1. **不執行任何下載來的腳本**：不跑 `install.ps1`／`install.sh`，不 `irm | iex`、不 `curl | sh`、不 `npm install -g`（pi 屬 #934 另議）。官方腳本只當「讀的參考」，由 ASN 用 Rust 重做同樣步驟。
2. **下載來源釘在程式裡**：每家一組固定網域（https、不跟轉址、限制大小與時間）。清單內容裡的下載網址也必須落在同一組網域，否則拒絕。
3. **完整性兩層以上**：官方清單提供的雜湊（sha256／sha512）＋ Windows Authenticode（`WinVerifyTrust` 驗整條鏈，簽署者名稱**完全相等**才過）。任何一層不過：刪檔、不執行、回報。
4. **版本不寫死**：取官方的穩定頻道，把清單裡的確切版本號記下；裝完用 `--version` 對照。不在 ASN 裡釘死版本號，因為各家會自動更新，釘死的版本很快過期，還可能把使用者降版。寫死在程式裡的是**網域、簽署者名稱、雜湊演算法**。每次安裝都記下版本、檔案雜湊、簽署者（第 5 節第 5 點）。
5. **已經好好的就不動**：已裝且簽章有效就不重裝；已登入就不重跑登入（沿用 `setup.rs` 的規則）。
6. **用完整路徑呼叫**，不依賴 PATH；子程序不開視窗；同一時間只允許一個安裝或登入；每一步有時限，逾時殺整棵程序樹。
7. **不讀、不印任何憑證**：只用各家的「狀態」子命令判斷登入與否；不碰 `.credentials.json`、`auth.json`、keyring；不走 API key、長效權杖、複製 `auth.json` 這些路。
8. **確認**
   - 本機：畫面先顯示「要裝什麼、從哪裡下載、會驗什麼、要登入哪一家」，本人按確認才帶 `confirmed = true` 開始（`agent_setup_start` 現有做法）。
   - 手機遠端（PLUGIN-PLAN §1.4 第 6 條）：
     - 請求要本人簽章（後台只收登入憑證本人建的請求）。
     - 手機發起前先過生物辨識／螢幕鎖（沿用 `mobile-confirm.mjs`）。
     - 目標電腦要事先打開「允許我的手機替這台安裝 CLI」（預設關，每台各自設，和開新視窗的許可分開），而且登入的帳號要是同一個人。
     - 開始時目標電腦跳通知，可以按「停止」；不用本人在那台再按確認（第 5 節第 3 點）。
     - 不能由信件、asn-cli、夥伴能呼叫的指令觸發。
9. **給人看的字**：手機與電腦共用一份文字（比照 `launch-run-parity` 的比對測試），不寫議題編號與內部原因。

## 2. 各家下載來源與核對方式

> 「待實測」的項目在該家 PR 開工前，先在測試機（40家用，用暫時的設定目錄，不動正式登入）把官方腳本存成文字逐行讀、把裝出來的檔跑 `Get-AuthenticodeSignature`，結果貼回 PR。

| 廠商 | 官方來源（只連這些網域） | 完整性 | 簽署者（完全相等） | 版本 | 登入型 | 狀態命令 |
|---|---|---|---|---|---|---|
| Claude | `downloads.claude.ai`（`claude-code-releases/<版本>/manifest.json`、執行檔） | 清單 sha256 ＋ Authenticode（官方另有 `manifest.json.sig` 的 GPG 簽章，Windows 這次不驗，見第 5 節第 1 點） | `Anthropic, PBC` | stable 頻道 | B 授權碼送回（已有） | `claude auth status`（結束碼） |
| Codex | `releases.openai.com/codex`（**不做** GitHub 備援，避免多一個來源） | metadata 的 sha256 ＝ 官方 `SHA256SUMS`（本身沒簽章）＝ 實算，再加每個 exe／dll 的 Authenticode（兩個寫死的例外，見 PR-3） | `OpenAI OpCo, LLC`（0.167.0 實測） | 穩定版 | A 裝置碼：`codex login --device-auth` | `codex login status` |
| Gemini（agy） | manifest：官方腳本寫死的 `antigravity-cli-auto-updater-974169037036.us-central1.run.app` 的 `/manifests/<平台>.json`；執行檔：`storage.googleapis.com` 的 `/antigravity-public/antigravity-cli/` 底下（主機＋路徑前綴都釘，見 PR-4） | 清單 sha512（本身沒簽章）＋ Authenticode | `Google LLC`（1.5.3 實測） | 穩定版 | C 只能操作畫面（沒有 `login` 子命令） | 待實測（候選：`agy` 某個狀態輸出、或 ACP `authenticate`） |
| Grok | `x.ai`（`cli/` 底下的清單與執行檔） | **官方腳本對 `grok.exe` 沒有比對雜湊**（#629），只能靠 Authenticode | **待實測**：#629 時工作機只有社群版，沒看到官方版的簽署者 | 穩定版 | A 裝置碼：`grok login --device-auth`（RFC 8628） | 待實測 |

Grok 的規則：實測結果若 `grok.exe` **沒有有效的 Authenticode 簽章**，就只剩「同網域下載」一層，不符合第 1 節第 3 條。這種情況**不做一鍵安裝**，畫面改成「請到 xAI 官網照說明安裝，裝好後 ASN 會自動偵測」，登入（裝置碼）照做。

## 3. 拆成幾張 PR

順序：PR-1 → PR-2 →（PR-3、PR-4 可並行）→ PR-5 → PR-6 → PR-7 → PR-8；PR-9 視 Grok 實測結果。每張都要 asn真 親審、西川二審。動到 migration 的那張另外照 migration 規則。

### PR-1 關掉舊的「執行網路腳本」安裝路（先做，獨立可合）
- `agent_tools/install.rs`：刪掉 `irm | iex`、`curl | bash`、`npm install -g` 三段。Claude 照舊走 `claude_install`；其他工具回「這家還不能由 ASN 安裝，請到官網安裝」。
- `agent_tools/mod.rs`：`ai_cli_install` 只接「驗過再執行」登記過的工具。
- `relay/shared/agent-tools.catalog.json`：`install` 的 `ps1`、`sh`、`npm` 欄位**整個拿掉**，只剩 `kind`（`verified`／`manual`；認不得的當 `manual`）；`agent_tools/catalog.rs` 同步（#1156 實作）。
- 測試：
  - 原始碼守衛：`src-tauri/src` 不得出現 `| iex`、`irm `、`| bash`、`| sh`、`npm install -g`。
  - 呼叫 `ai_cli_install("codex")` 不會啟動任何子程序（假 Runner）。
- 不動畫面。

### PR-2 共用的「驗過再執行」安裝骨架（Claude 搬上去，行為不變）
- 新增 `agent_setup/verified_install.rs`：把 `claude_install.rs` 的通用流程抽出來。
  - 流程：取清單 → 檢查清單網址網域 → 下載 → 鎖檔 → 重算雜湊 → Authenticode 簽署者 → 執行或放置 → 裝完再驗。
  - 每家的差異用一份資料描述 `InstallSpec`：網域、清單路徑、雜湊演算法、簽署者、安裝方式（「執行 `<exe> install <版本>`」或「解壓縮放到固定資料夾」）、裝完怎麼驗版本。
  - 欄位對齊 PLUGIN-PLAN `install_plan`，0.2.20 之後直接搬進 `VendorAdapter`。
- `claude_install.rs` 改用骨架。既有測試（假下載、假簽章、假執行）全部照過，用來證明行為不變。
- 每次安裝在 ASN 記錄寫一行：廠商、版本、檔案雜湊、簽署者、來源網域、結果（第 5 節第 5 點）。
- 不加 GPG（第 5 節第 1 點）。
- 動到：`agent_setup/{mod,claude_install,verified_install}.rs`。

### PR-3 Codex 安裝
- **實測結果**（2026-11-09，40家用，官方 0.167.0；只讀、沒執行下載的東西）：
  - 官方腳本 `chatgpt.com/codex/install.ps1` 轉到 `releases.openai.com/codex/install.ps1`。ASN 不下載腳本，直接連 `releases.openai.com/codex`，三個網址都沒有轉址：
    - `channels/latest`：JSON，含 `tag_name=rust-v<版本>`、各檔的 `sha256` 與下載網址；
    - `releases/<版本>/codex-package_SHA256SUMS`；
    - `releases/<版本>/codex-package-<target>.tar.gz`。
  - 套件是 **tar.gz**（不是 zip），約 201 MB、52 項，含 `bin\codex.exe` 等多個執行檔與 voice 的 dll。metadata、`SHA256SUMS`、實際算出的雜湊三者一致。
  - 簽章：31 個檔是 `OpenAI OpCo, LLC`；`codex-path\rg.exe` 沒有簽章；`codex-resources\voice\bin\vcruntime140.dll` 是 `Microsoft Windows`。
  - 官方會解到 `~\.codex\packages\standalone\releases\…`、建交接點，並把 `%LOCALAPPDATA%\Programs\OpenAI\Codex\bin` 加進 PATH。
- **asn真 定案**：
  - 放 `%LOCALAPPDATA%\ASN\tools\codex\<版本>\`，ASN 記完整路徑，不動 `~\.codex`、不動 PATH。
  - 這台已有官方裝好的 codex（PATH 上的 `codex.exe` 簽署者是 `OpenAI OpCo, LLC`）就直接用它。
  - 「更新」先不做，畫面只顯示目前版本。
  - 雜湊三方一致；每個 exe／dll 都要 `OpenAI OpCo, LLC`，只有兩個寫死相對路徑的例外：`codex-path\rg.exe` 允許沒簽章、`vcruntime140.dll` 必須是 `Microsoft Windows`。例外寫成常數，有測試鎖住。
  - 不退回 GitHub；不跟任何轉址。
- `agent_setup/codex_install.rs`：
  - 解 tar.gz，只收一般檔與資料夾，不收連結、絕對路徑、`..`，最多 200 項、600 MB。
  - 先解到暫存資料夾，全驗過才改名就位。
  - 腳本類檔案出現就整包不裝；`bin\codex.exe --version` 要看得到驗過的版本。
- 測試：
  - 假清單、三方雜湊不一致、簽署者不符、多出沒簽的執行檔、別處的 `rg.exe`、腳本、清單網址跑到別的網域；
  - tar 裡有 `..`、絕對路徑、連結；超過項目數或總量。
  - 以上都要拒絕。

### PR-4 Gemini（agy）安裝
- **實測結果**（2026-11-09，40家用，官方 1.5.3；沒有轉址）：
  - 官方腳本 `antigravity.google/cli/install.ps1`（172 行）的流程：
    1. 從 `https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/windows_amd64.json` 取 `version`、`url`、`sha512`；
    2. 下載 `url`、比 sha512；
    3. 複製到 `%LOCALAPPDATA%\agy\bin\agy.exe`；
    4. 跑 `agy install` 設 PATH。
  - 執行檔在 `https://storage.googleapis.com/antigravity-public/antigravity-cli/<版本>-<編號>/windows-x64/cli_windows_x64.exe`，單一 exe、約 225 MB；sha512 一致，簽署者 `Google LLC`。
  - `agy --version` 只印版本號（`1.5.3`），結束碼 0；在隔離的使用者資料夾跑過，不會建立任何檔案。
- **asn真 定案**：
  - **manifest**：只連那台 run.app 主機，路徑寫死 `/manifests/windows_amd64.json`（或 arm64）。
  - **執行檔**：必須在 `https://storage.googleapis.com/antigravity-public/antigravity-cli/` 底下，路徑只收英數字與 `.` `_` `-` `/`，不收 `..`、`?`、`#`、`%`。兩者都不跟轉址。
  - **白名單共用**：`Spec` 加路徑前綴，三家同一套檢查（`url_allowed`）。
  - **放哪裡**：`%LOCALAPPDATA%\ASN\tools\agy\agy.exe`，不分版本資料夾；不跑 `agy install`、不動 PATH。已有官方的（`%LOCALAPPDATA%\agy\bin\agy.exe` 或 PATH 上的，簽署者 `Google LLC`）就直接用。
  - **每次啟動前重驗**：agy 會在背景自己更新，所以每次啟動 agy 前都要重驗簽署者，驗不過就不啟動、提示重新安裝（`check_before_launch`、`usable_here()` 每次重驗）。
- 測試同 PR-3，另加：白名單擋別人的 bucket、百分比編碼、`..`、查詢字串；啟動前重驗；官方優先。

### PR-5 登入：補「裝置碼型」與「只能在電腦前登入」
- `agent_setup/login.rs` 現在只有授權碼送回型（B）。新增：
  - **A 裝置碼型**（Codex、Grok）：
    - 從輸出抓「網址＋代碼」。**本機**登入時交給這台 ASN 的畫面（PR-5a，#1186）；**手機遠端觸發**時不走 `secret_remote`，改走 PR-5b 定案的反向加密通道：手機用設備金鑰簽請求，電腦用一次性公鑰加密網址＋代碼並用設備金鑰簽，手機用本機記住的電腦公鑰驗過才顯示（安全細節在私有設計）。手機只顯示，不用回傳任何東西。
    - 等子程序自己結束，再用狀態命令確認。
    - 代碼與網址記 log 前遮掉。
  - **C 只能操作畫面**（agy）：不做自動送鍵。
    - 本機：「在這台電腦開終端機登入」（`ai_cli_login` 開互動終端，本人自己操作）。
    - 手機：顯示「Gemini 要在那台電腦前登入：打開 ASN →設定→啟動設定→登入 Gemini」。
    - 理由：選單會隨 agy 改版變，送鍵很脆弱，授權碼也會經過畫面那一層。
- 各家登入參數寫成資料 `LoginSpec`（子命令、型別、狀態命令、成功訊號），對齊 PLUGIN-PLAN `login_plan`／`login_verify`。
- Codex 的前提：本人要先在 ChatGPT 帳號安全設定打開「允許裝置碼登入」，AI 不代做。沒開時要能辨認出來，畫面照第 4 節顯示。
- 開工前先實測（用暫時設定目錄）：
  - Codex `--device-auth` 的輸出格式、代碼效期、沒開「允許裝置碼登入」時的輸出；
  - Grok 同樣三項，加上確認已登入的方法；
  - agy 的狀態判斷方式。
- 測試：假子程序輸出各家實測樣本（實測後去識別化再存成測試資料）、逾時、使用者取消、代碼過期。

### PR-6 後台：遠端請求帶廠商（migration，asn真 親審）
- `setup_requests.kind` 的檢查從 `('claude')` 擴成 `('claude','codex','agy','grok')`。
- `setup_version_ok` 最低版本拉到這版，舊版 ASN 收不到新種類的請求，不會誤裝 Claude。
- `asn_setup_request` 多收 `p_kind`。舊呼叫不帶時預設 `'claude'`，舊手機不壞。
- presence 回應多回 `setup_kind`。舊版只讀 `setup_requested`，所以舊電腦收到非 Claude 的請求時，靠版本閘門擋在後台。
- 回復檔：`supabase/sql/rollback/`。
- SQL 測試：別人的節點、離線、舊版、未知 kind、頻率限制。
- Rust `agent_setup/remote.rs`：照 `kind` 分派到各家流程，三道本機把關不變。

### PR-7 畫面（電腦＋手機）
> 0.2.17 先開「手機替電腦登入 Codex」（只登入，不安裝）：手機入口 `DEVICE_LOGIN_UI` 打開，後台 Codex 最低版本改成 0.2.17（`20261113400000_setup_device_login_codex.sql`）。Grok 等驗證過的安裝（PR-9）、各家的安裝畫面（`AGENT_INSTALL_UI`）之後再開。

- 共用文字與狀態模組：在 `ui/lib/agent-install.mjs` 擴充成四家，手機 `mobile-setup.mjs` 共用。
- 電腦：「設定 → 設備 → 這台」各家一列：
  - 狀態：未安裝、已安裝未登入、已登入、失敗。
  - 按鈕：安裝並登入、只登入、重試。
  - 確認窗列出：來源網域、會驗什麼、要登入哪一家。
  - 「允許從手機替這台安裝並登入」開關，現有的那個擴成四家共用。
- 手機：設備細部頁對「別台可以裝」的那幾家出現按鈕。按下後過生物辨識，送出請求，顯示進度。
  - 裝置碼型：顯示網址＋代碼，「開啟登入頁」直接開瀏覽器。
  - 授權碼送回型：沿用現有貼回授權碼。
- `AGENT_INSTALL_UI` 改成每家一個開關，**只開真機跑過的那幾家**。
- 冒煙：
  - 電腦三種狀態；
  - 手機三種型別；
  - 失敗文字；
  - 360、412、放大字。

### PR-8 引導頁＋啟動設定接上（#933「引導頁」、#343 第二階段的 CLI 部分）
- 引導頁加一步「要用哪幾家 AI」：
  - 每家顯示偵測結果，可以勾選後一次裝並登入，或略過。
  - 略過的之後可在「設定 → 啟動設定」補做（同一份元件）。
- 狀態存本機 `asn-setup.json` 的 CLI 部分（#343 方案），舊的 `done: true` 視為已完成姓名兩步。
- 動到：`ui/lib/onboard.mjs`、引導頁、`settings-panel.mjs` 啟動設定區。

### PR-9（視實測）Grok 安裝
- 實測 `grok.exe` 有有效 Authenticode（簽署者確定）→ 照 PR-3 做，簽署者寫死。
- 沒有 → 不做一鍵安裝，只做偵測與裝置碼登入（已在 PR-5），畫面指向官網。

## 4. 失敗時畫面上的字（手機與電腦同一份）

| 情況 | 畫面文字 |
|---|---|
| 連不上官方網站 | 連不上 {廠商} 的官方下載網站，請檢查網路後再按「重試」。 |
| 清單或檔案的雜湊不符 | 下載的檔案和官方公布的不一樣，已刪除，沒有安裝。可能是網路被攔截或檔案損壞，請換個網路再試。 |
| 數位簽章不符或沒有簽章 | 這個檔案沒有 {廠商} 的有效數位簽章，已刪除，沒有安裝。 |
| 清單裡的網址不是官方網域 | 官方清單指向不認得的下載位置，為了安全沒有安裝。請稍後再試，或到官網手動安裝。 |
| 執行安裝程式失敗 | {廠商} 的安裝程式沒有成功（結束碼 {n}）。請重試；還是不行就到官網手動安裝：{官網說明頁}。 |
| 裝完驗不過（版本對不上、簽章失效） | 裝好的程式沒有通過檢查，已停用這次安裝。請重試。 |
| 已安裝但檔案壞了 | 這台的 {廠商} 程式簽章不對，可能被換過。要重新安裝嗎？ |
| 登入逾時 | 等太久沒有完成登入（{n} 分鐘），已停止。請再按一次「登入」。 |
| 授權碼錯誤或過期（Claude） | 授權碼不對或已過期，請重新登入一次，拿到授權碼後盡快貼回。 |
| 裝置碼過期（Codex、Grok） | 登入代碼已過期，請再按一次「登入」取得新的代碼。 |
| Codex 沒開裝置碼登入 | 你的 ChatGPT 帳號還沒打開「允許裝置碼登入」。請到 ChatGPT →設定→安全，打開後再按「登入」。 |
| 看不出登入狀態 | 看不出這台 {廠商} 有沒有登入，為了不蓋掉現有的登入，先停在這裡。請在這台電腦上打開 {廠商} 確認。 |
| 只能在電腦前登入（agy） | Gemini 要在那台電腦前登入：打開 ASN →設定→啟動設定→登入 Gemini。 |
| 那台沒開遠端許可 | 那台電腦沒有允許從手機安裝。請到那台的「設定 → 設備」打開「允許我的手機替這台安裝 CLI」。 |
| 那台登入的是別的帳號 | 那台電腦登入的是別的帳號，只能替自己的電腦安裝。 |
| 那台 ASN 太舊或離線 | 那台電腦的 ASN 太舊（或沒開），請先更新並打開 ASN。 |
| 已有安裝或登入在進行 | 這台正在安裝或登入另一個程式，請等它結束再試。 |
| 本人取消 | （不顯示錯誤，回到原畫面） |

## 5. 已定案（asn真 2026-11-09 親審）

1. **Claude 不加 GPG**：Windows 靠 Authenticode（`Anthropic, PBC`）＋ sha256 就夠，這次不多加 OpenPGP 套件。Linux 沒有 Authenticode，等 Linux 版再議；Linux 這一輪不做一鍵安裝。PR-2 的「加 Claude 清單 GPG 驗證」一段**拿掉**。
2. **agy 不寫使用者的 PATH**：ASN 自己記住裝好的完整路徑，存在 ASN 的設定裡，不動系統。PR-4 照這樣做，畫面只說明「自己開終端機要打完整路徑」。
3. **遠端安裝不用到那台再按一次**，但目標電腦要有一個**獨立的開關「允許我的手機替這台安裝 CLI」**：
   - 預設關，和「允許我的其他設備替這台開新視窗」分開。現有的「允許從手機替這台安裝並登入」就是這個開關，PR-7 改名、擴成四家共用。
   - 開始時那台跳通知「手機正在替這台安裝 {廠商}」，上面有「停止」。PR-5／PR-7 實作，停止走現有的 `agent_setup_cancel`。
4. **Grok 沒有 Authenticode 就只偵測＋登入**，不做一鍵安裝（PR-9）。
5. **不釘版本**。但每次安裝都要在 ASN 的記錄裡寫下：廠商、裝了哪一版、檔案雜湊、簽署者、來源網域、成功或失敗原因，出事時查得到。不寫任何網址參數或憑證。PR-2 的共用骨架負責寫這一行，各家自動帶上。

**順序**：PR-1 最優先。舊的 Tauri 指令還註冊著，就算前端沒呼叫，也是一個叫得到的入口。之後照 PR-2 往下。每張都由 asn真 親審、西川二審。

## 6. 不做的事
- 不執行任何官方或非官方的安裝腳本，不 `curl | sh`、`irm | iex`。
- 不用 API key、長效權杖、複製 `auth.json`、Codex `--with-access-token`、Grok `XAI_API_KEY`／`GROK_DEPLOYMENT_KEY`、agy「Use a Google Cloud project」。
- 不在畫面裡替 agy 自動送鍵登入。
- 不替使用者改帳號設定（Codex 的「允許裝置碼登入」要本人去開）。
- Linux／macOS 這一輪不做一鍵安裝（偵測照舊），等 Windows 四家穩了再議。
