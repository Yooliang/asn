# 調查：本機 AI 工具訂閱額度／用量顯示（2026-10-21）

只讀網路與公開 repo 資料。星數、最近推送日、release 標籤取自 GitHub API（擷取當下）。背景：PR [#47](https://github.com/Yooliang/asn/pull/47) 曾在 ASN 新增「用量」分頁，以本機 OAuth 憑證查詢多家額度（含 Grok 非公開 billing 端點）；審查關切合規與可維護性，故先以本文件釐清現成方案與官方界線，**不涉及**修改 #47／#48 分支。

## 結論摘要

| 工具 | 官方可查「訂閱額度／剩餘窗口」的方式 | ASN 較穩的做法 |
|---|---|---|
| Claude（Claude Code） | 互動指令 `/usage`；狀態列 JSON 的 `rate_limits`（Pro／Max 或 gateway 情境） | 偵測登入＋引導在 Claude Code 內查看；**不要**在 ASN 內讀取訂閱 OAuth token 代打後端 |
| Codex | 實驗性 `codex app-server` 的 `account/rateLimits/read`；ChatGPT 網頁「各 App 用量」 | 可選：使用者同意後**子行程**呼叫官方 `codex`（非自行實作 wham API）；或 SIWC 合規整合 |
| Gemini／agy（Antigravity） | TUI `/usage`（別名 `/quota`）、`/credits`；statusline 的 `quota` 物件 | 可選：`agy -p /usage` 獨立程序（官方 headless 建議）；避免複製 Gemini CLI OAuth 查額度 |
| Grok | 網頁 Settings → Usage、grok.com 儀表板；Build TUI `/usage` | 儀表板深連結＋登入狀態；**不建議**依賴 `cli-chat-proxy.grok.com` 非公開 billing |
| pi | `pi auth check`（就緒與否）；**無**內建遠端訂閱額度 API | 僅顯示登入／就緒；額度靠使用者 API 金鑰供應商或第三方擴充，ASN 不自建 |

**推薦整體策略：** 第一階段只做 PATH／憑證檔**存在性**偵測、官方登入／儀表板連結、本機 session **token 用量**（ccusage 類）；第二階段若要做「剩餘％」，優先**委派給官方 CLI 子行程**（Codex app-server、agy `/usage`），並在隱私說明中要求使用者自負條款風險；**不要**在 Rust／前端重複 PR #47 的「讀 auth.json → Bearer 打非公開 HTTP」。

---

## 一、現有開源／社群工具

### 總表

| 專案 | 網址 | 授權 | 維護（擷取當下） | 支援與 ASN 重疊的供應商 | 資料來源 | 能否內建進 ASN（Windows＋Linux，Tauri） |
|---|---|---|---|---|---|---|
| ccusage | https://github.com/ccusage/ccusage | MIT（[LICENSE](https://github.com/ccusage/ccusage/blob/main/LICENSE)） | 約 1.9 萬星；最近推送 2026-10-20；最新 release `v20.0.37`（2026-10-19） | Claude、Codex、Antigravity、Grok、pi 等（**以本機日誌為主**） | 讀各 CLI 寫入的 JSONL／專案 log；**不**讀 OAuth 打遠端額度 API（Claude 另有 `blocks`／statusline hook 讀本機資料） | **可以**：以 `npx`／bundled Node 子行程、`--json` 解析；跨平台；與 Tauri 整合成本低；**注意** MIT 可嵌入，但語意是「用量／成本估算」而非各廠訂閱上限 |
| CodexBar | https://github.com/steipete/CodexBar | MIT | 約 2.3 萬星；最近推送 2026-10-20；最新 release `v0.79.0`（2026-10-20） | Claude、Codex、Antigravity、Grok、Gemini 等數十家 | OAuth API、瀏覽器 cookie、**官方 CLI**（含 Codex MCP／PTY）、本機 log、部分非公開端點（文件自承） | **部分**：Linux 有 [CLI 與 `codexbar serve`](https://github.com/steipete/CodexBar/blob/main/docs/cli.md)（`usage --format json`）；Windows 原生為 WSL2 托盤（[README](https://github.com/steipete/CodexBar/blob/main/README.md)），不適合整包連結 Swift/Qt；可列為「使用者自行安裝」或僅 Linux 選用外部 CLI |
| OpenUsage | https://github.com/robinebers/openusage | MIT | 約 4400 星；最近推送 2026-10-18；最新 release `v0.7.15` | Claude、Codex、Antigravity、Grok 等 11 家 | 與 CodexBar 類似：本機憑證、Codex app-server、非公開 Grok billing 等 | **不適合直接內建**：僅 **macOS 15+**（[官網](https://www.openusage.ai/)）；本機 HTTP `127.0.0.1:6736/v1/limits` 可給其他 App 讀，但 ASN 目標含 Windows／Linux |
| agy-cli-usage | https://github.com/abruption/agy-cli-usage | 見 repo | **已封存**；維護者指 Antigravity CLI ≥1.1.11 有原生 print 模式 | agy | `v1internal:retrieveUserQuotaSummary` 等非公開 API ＋ PTY 解析 `/usage` | **不建議**：與 PR #47 同類風險；官方已提供 headless 下獨立跑 `/usage` 的指引 |
| pi-usage-hub／pi-quota-status | https://pi.dev/packages/pi-usage-hub 、 https://pi.dev/packages/pi-quota-status | 見各 npm 套件 | 社群 Pi 擴充 | 多供應商（含 Codex、xAI） | 讀 `auth.json`、供應商 HTTP | **不建議整包進 ASN**：Pi 生態擴充，非 pi 核心；且仍涉及訂閱 token 轉打 |

### ccusage（本機 log 路線）

- 定位：從 coding agent **本機產物**彙整 token／估算成本；預設 `npx ccusage@latest`（[指南](https://ccusage.com/guide/)）。
- Claude：`ccusage claude daily` 讀 `~/.config/claude/projects/`、`~/.claude/projects/`（[Claude 資料源](https://github.com/ccusage/ccusage/blob/main/docs/guide/claude/index.md)）；`ccusage blocks` 為 Claude 5 小時窗口（本機）。
- Codex／Antigravity／Grok／pi：各有子命令（[README 支援列表](https://github.com/ccusage/ccusage/)）。
- **限制**：官網写明估算可能不準、不含部分工具 API 呼叫；**不能**取代「Claude Pro 剩餘 session％」這類訂閱配額（除非搭配 Claude 官方 statusline／log 內嵌欄位）。

### CodexBar／OpenUsage（多源額度路線）

- CodexBar [providers 文件](https://github.com/steipete/CodexBar/blob/main/docs/providers.md) 摘要：Claude 優先 OAuth API，其次 cookie、CLI PTY；Codex 為 OAuth 或 Codex CLI；Gemini 為 CLI OAuth quota；Antigravity 為本機 LSP／`agy` HTTPS；Grok 為 Grok CLI billing RPC。
- CLI 輸出：`codexbar usage --format json`；長駐 `codexbar serve` 提供 `GET /usage`（[cli.md](https://github.com/steipete/CodexBar/blob/main/docs/cli.md)）。
- OpenUsage 設計哲學：本機 `openusage` CLI／HTTP 給 statusline 讀「預報」，token 不離開本機流程（[官網](https://www.openusage.ai/)）——但實作上仍可能觸及與 CodexBar 相同的非公開端點（例如 [Grok provider 說明](https://github.com/robinebers/openusage/blob/main/docs/providers/grok.md)）。

### 與 Tauri ASN 的整合含意

| 做法 | 優點 | 缺點 |
|---|---|---|
| 嵌入 ccusage（子行程＋JSON） | 合規風險低、跨 Win／Linux、MIT | 多數指標是 **token／成本**，不是訂閱「剩餘％」 |
| 呼叫 CodexBar CLI（Linux 為主） | 一家整合多家額度 | Win 需 WSL；Swift 本體不可靜態連結；仍含非公開端點策略 |
| 複製 PR #47：Rust 讀 auth 打 API | UI 一致、無外部依賴 | Anthropic 明確禁止；端點易變；資安與審查風險高 |
| 僅 UI＋官方 CLI 子行程 | 界線較清楚 | 需處理逾時、無 TTY、版本差異；Grok／Claude 可能無穩定 JSON |

---

## 二、五家官方「額度／用量」查詢方式

以下「訂閱額度」指方案內 rolling window（session／weekly 等）；「API 用量」指按 token 計費帳戶。

### Claude（Claude Code）

| 類型 | 內容 | 來源 |
|---|---|---|
| 互動 CLI | `/usage` 顯示方案用量與 reset；訂閱與 claude.ai 共用額度 | [Manage costs](https://code.claude.com/docs/en/costs) 、[Pro/Max 說明](https://support.claude.com/en/articles/11145838-use-claude-code-with-your-pro-or-max-plan) |
| 狀態列（可腳本化） | 自訂 statusline 時，stdin JSON 含 `rate_limits.five_hour`／`seven_day` 的 `used_percentage`、`resets_at`（Pro／Max 或 Claude apps gateway） | [Status line](https://code.claude.com/docs/en/statusline) |
| 公開 REST「訂閱餘額 API」 | **查不到**官方文件記載給第三方 App 用的穩定公開 REST | — |
| 功能請求 | 社群 issue 提案 `claude quota` CLI，**非**已釋出功能 | [anthropics/claude-code#13585](https://github.com/anthropics/claude-code/issues/13585) |
| API 金鑰／企業 | Console 用量與帳單；與 Pro 訂閱 OAuth 分開 | [Models, usage, and limits](https://support.claude.com/en/articles/14552983-models-usage-and-limits-in-claude-code) |

### Codex（OpenAI ChatGPT 方案）

| 類型 | 內容 | 來源 |
|---|---|---|
| 互動／App | ChatGPT 設定中檢視各 App 用量（SIWC 連結的 App） | [Using your ChatGPT plan in other apps](https://help.openai.com/en/articles/20001542-using-your-chatgpt-plan-in-other-apps-and-sites) |
| Codex CLI（實驗性 MCP） | `codex app-server` JSON-RPC `account/rateLimits/read`；底層 HTTP 如 `/wham/usage`（ChatGPT 後端） | [codex_mcp_interface.md](https://github.com/openai/codex/blob/main/codex-rs/docs/codex_mcp_interface.md) 、[backend-client rate_limit](https://github.com/openai/codex/blob/main/codex-rs/backend-client/src/client/rate_limit_resets.rs) |
| OSS 整合條款 | Sign in with ChatGPT：token 須**本機、使用者掌控**；請求須來自使用者授權的自動化 | [SIWC Terms](https://openai.com/policies/sign-in-with-chatgpt-terms/) 、[OSS 概述](https://developers.openai.com/siwc/token-sharing-open-source) |
| 公開「訂閱餘額 REST 手冊」 | **查不到**獨立於 Codex 二進位的穩定公開 API 文件；以 app-server **實驗介面**為準 | 同上 |

### Gemini／agy（Antigravity）

| 類型 | 內容 | 來源 |
|---|---|---|
| TUI | `/usage`（`/quota`）刷新模型配額；`/credits` 看 AI credits | [Model quotas](https://antigravity.google/docs/cli/commands/usage/) 、[CLI credits](https://antigravity.google/docs/cli/credits/) |
| Headless | 串流 JSON **不可**注入 `/usage`；文件建議 **`agy -p /usage` 獨立命令** | [Headless mode](https://antigravity.google/docs/cli/headless/) |
| Statusline | 腳本 stdin 含 `quota`（`remaining_fraction`、`reset_time` 等） | [Status line customization](https://antigravity.google/docs/cli/statusline/) |
| 網頁 | 方案 baseline quota 說明 | [Plans](https://antigravity.google/docs/plans/) |
| 機器可讀 JSON schema（`/usage`） | **查不到** antigravity.google.com 上與 `agy -p /usage --output-format json` 對應的正式 schema（社群套件有描述，非本次官方頁面查證） | — |

**舊 Gemini CLI 與第三方：** Google 明確禁止第三方工具「借用」Gemini CLI OAuth 存取後端（Antigravity／agy 為另一產品線，但仍不宜在 ASN 複製未文件化 internal API）。原文見下節風險。

### Grok（xAI Build CLI）

| 類型 | 內容 | 來源 |
|---|---|---|
| 網頁 | Settings → Usage；付費方案 weekly pool 說明 | [Grok FAQ](https://docs.x.ai/grok/faq) |
| Build TUI | `/usage` 查看 credit usage／billing | [Modes and Commands](https://docs.x.ai/build/modes-and-commands) |
| API（開發者帳） | 每次推理回應含 `cost_in_usd_ticks`；Management API 團隊用量 | [Cost tracking](https://docs.x.ai/developers/cost-tracking) 、[Management API](https://docs.x.ai/developers/rest-api-reference/management) |
| 訂閱 CLI 的穩定公開 REST | **查不到**（OpenUsage 使用 CLI 同源之 `cli-chat-proxy.grok.com`，屬**非公開**） | [openusage grok.md](https://github.com/robinebers/openusage/blob/main/docs/providers/grok.md) |
| Headless `/usage` JSON | **查不到**官方 CLI reference 記載非互動 quota JSON | [CLI Reference](https://docs.x.ai/build/cli/reference) |

### pi

| 類型 | 內容 | 來源 |
|---|---|---|
| 登入 | `/login [provider]` 寫入 `~/.pi/agent/auth.json` | [Providers](https://pi.dev/docs/latest/providers) |
| 非互動 | `pi auth check --provider … --json`（就緒／無效）；`pi auth print-bearer-token` **會輸出秘密** | [CLI](https://pi.dev/docs/latest/cli) |
| 內建訂閱額度 | **查不到**官方核心文件記載遠端 quota API | — |
| 擴充 | `pi-usage-hub`、`pi-quota-status` 等套件（第三方） | [pi-usage-hub](https://pi.dev/packages/pi-usage-hub) 、[pi-quota-status](https://pi.dev/packages/pi-quota-status) |

---

## 三、風險與條款（含原文摘錄）

### 3.1 Anthropic（Claude 訂閱 OAuth）

[Legal and compliance - Claude Code](https://code.claude.com/docs/en/legal-and-compliance) 節錄（Authentication and credential use）：

> OAuth authentication is intended exclusively for purchasers of Claude Free, Pro, Max, Team, and Enterprise subscription plans and is designed to support ordinary use of Claude Code and other native Anthropic applications.
>
> Anthropic does not permit third-party developers to offer Claude.ai login into their own applications, or to route requests through Free, Pro, or Max plan credentials on behalf of their users. Moreover, developers may not **collect, store, or intermediate Claude.ai credentials or session tokens** — sign-in to a Claude account must complete through Anthropic’s own flow.

[Consumer Terms of Service](https://www.anthropic.com/legal/consumer-terms) 第 3 節禁止（節錄）：

> Except when you are accessing our Services via an Anthropic API Key or where we otherwise explicitly permit it, to access the Services through **automated or non-human means**, whether through a bot, script, or otherwise.

**ASN 含意：** 在 ASN 內讀取 Claude Code OAuth 檔並代打 usage 端點（PR #47 作法）與「第三方產品不得代收／代用訂閱 token」衝突；即使用戶本機、且不列印 token，仍屬第三方應用程式行為。

### 3.2 OpenAI（Codex／ChatGPT 方案）

[Sign in with ChatGPT Terms](https://openai.com/policies/sign-in-with-chatgpt-terms/) 節錄：

> Obtain and use SIWC access and refresh tokens (“Authentication Tokens”) only through OpenAI’s supported sign-in flow and as authorized by the user.
>
> Requests must originate from the user’s **local runtime or a remote runtime only that user controls**.
>
> You must not … **Pool, transferring, reselling, gifting, or sharing ChatGPT plan usage or Authentication Tokens**, except for token handling expressly permitted by these Terms.

**ASN 含意：** 若 ASN 要代查 Codex 額度，較合規敘事是「使用者已安裝的 Codex 二進位／完整 SIWC 流程」，而非自行解析 `auth.json` 打 `/wham/usage`；後者仍可能違反「僅供已連線 App」與 General Terms 對自動化存取 ChatGPT 服務的限制（[Terms of Use](https://openai.com/policies/row-terms-of-use/) 禁止繞過速率限制等）。

### 3.3 Google（Gemini CLI OAuth 借用）

[Gemini CLI FAQ](https://github.com/google-gemini/gemini-cli/blob/main/docs/resources/faq.md) 節錄：

> Using third-party software, tools, or services to **harvest or piggyback on Gemini CLI's OAuth authentication** to access our backend services is a direct violation of our applicable terms and policies. … such actions may be grounds for **immediate suspension or termination** of your account.

Antigravity 官方文件未在本次調查中找到等價「禁止第三方讀 agy token」條文；**查不到**時仍應假設 Google 帳號服務通用條款適用，且 **非公開** `v1internal:*` 隨時可改。

### 3.4 xAI（Grok）

[Terms of Service](https://x.ai/legal/terms-of-service) 節錄：

> You may not **share your account credentials** or make your account available to anyone else, and are responsible for all activities that occur under your account.

**ASN 含意：** ASN 若複製 token 至自己的 HTTP client（即使本機），需避免讓憑證暴露於 log、crash report 或遠端同步；非公開 billing 端點變更會導致功能靜默失效（PR #47 已預期 Grok 降級）。

### 3.5 技術與資安（與條款無關但實務必計）

- **非公開端點**：Grok billing、過往 Gemini internal quota、CodexBar 記載的各種 web cookie API — 無 semver 保證。
- **憑證外洩**：讀 `auth.json`／Keychain 的程式必須不寫 log、不上傳；Tauri 前端不可觸及 raw token（PR #47 方向正確，但 API 呼叫本身仍有條款問題）。
- **PTY／子行程**：spawn CLI 可能觸發 MFA、更新、互動提示；需逾時與錯誤 UI。
- **授權**：AGPL/GPL 工具（若有）與 ASN 發行策略衝突 — 本調查列出的 ccusage／CodexBar／OpenUsage 均 MIT。

---

## 四、建議（ASN）

### 可以馬上做（低風險）

1. **共用 catalog**（#23／#47 已有雛形）：僅偵測 binary、憑證檔**是否存在**（不讀內容）、顯示 install／login 指令與官方說明連結。
2. **本機 token／成本視圖**：選配整合 **ccusage** JSON（使用者機器需 Node／bun）；標示「估算、非帳單權威」。
3. **深連結**：Grok [FAQ 用量頁](https://docs.x.ai/grok/faq)、ChatGPT App 用量設定、Claude Code 內 `/usage` 教學。
4. **pi**：僅 `pi auth check` 結果（可選子行程，禁止 `print-bearer-token`）。

### 需要等官方或產品界線更清楚

1. **Claude 訂閱剩餘％進第三方桌面**：等 Anthropic 釋出類似 statusline 的**支援外掛 API** 或 `claude quota` 正式指令（[#13585](https://github.com/anthropics/claude-code/issues/13585)）。
2. **ChatGPT 方案配額給任意 Tauri App**：完整 **Sign in with ChatGPT** OSS 註冊流程（[developers.openai.com/siwc](https://developers.openai.com/siwc/token-sharing-open-source)），而非讀取 Codex 既有 token。
3. **Grok／Antigravity 穩定 machine-readable quota**：官方若文件化 headless JSON 或 localhost API，再評估。

### 不建議（與 PR #47 核心爭點一致）

1. 在 ASN Rust 內 **parse OAuth token 並呼叫** Claude OAuth usage、Grok `cli-chat-proxy`、Google internal quota 等。
2. 預設打包 **CodexBar／OpenUsage** 並假設 macOS 能力（OpenUsage）或 WSL（Windows CodexBar）。
3. 在 UI 顯示精確「剩餘％」而無法標示資料來源（官方 CLI vs 非公開 API vs 過期 session fallback）。

### 若仍要「剩餘額度」的中間路線（次佳、需法律／產品確認）

- **Codex**：使用者同意後 spawn `codex app-server --stdio` → `account/rateLimits/read`（實驗介面，版本綁定）。
- **agy**：spawn `agy -p /usage`（文字解析；或監聽 agy statusline 腳本 JSON 的 `quota` 欄位，需 agy 常駐 — 通常不適合 ASN）。
- **Claude**：引導使用者設定 Claude Code statusline hook，ASN **不碰 token**（僅讀使用者自願寫入的摘要檔 — 若未來做，須 opt-in）。
- **Grok／pi**：以儀表板＋登入狀態為主；pi 不承諾遠端 quota。

---

## 五、與 PR #47 的對照

| 項目 | PR #47 作法 | 本調查建議 |
|---|---|---|
| Claude／Codex 額度 | 本機 OAuth 打 usage API | Claude 避免；Codex 改官方 app-server 或 SIWC |
| Grok | 非公開 billing URL | 不預設；儀表板為主 |
| pi | 僅登入狀態 | 維持 |
| 測試 mock | `IRORI_ASN_USAGE_MOCK` | 文件 PR 不涉程式；未來實作仍建議 mock 邊界 |

---

## 參考連結（彙整）

- ccusage：https://github.com/ccusage/ccusage 、 https://ccusage.com/guide/
- CodexBar：https://github.com/steipete/CodexBar 、 https://codexbar.app/
- OpenUsage：https://github.com/robinebers/openusage 、 https://www.openusage.ai/
- Claude 合規：https://code.claude.com/docs/en/legal-and-compliance
- Anthropic 消費者條款：https://www.anthropic.com/legal/consumer-terms
- OpenAI SIWC：https://openai.com/policies/sign-in-with-chatgpt-terms/ 、 https://developers.openai.com/siwc/token-sharing-open-source
- Google Gemini CLI FAQ：https://github.com/google-gemini/gemini-cli/blob/main/docs/resources/faq.md
- Antigravity CLI：https://antigravity.google/docs/cli/commands/usage/
- xAI Grok：https://docs.x.ai/grok/faq 、 https://docs.x.ai/build/modes-and-commands 、 https://x.ai/legal/terms-of-service
- pi：https://pi.dev/docs/latest/providers 、 https://pi.dev/docs/latest/cli
