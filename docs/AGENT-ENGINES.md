# 多引擎轉接：Gemini、Grok、pi，以及 ACP／AgentAPI 值不值得用

> 2026-10-04 調研與原型。環境：Windows 11 原生、`agy 1.2.4`、`gemini 0.52.0`（舊版）、`codex-cli 0.154.0`、`claude 2.1.288`、`pi 0.84.4`、`grok`（社群版 `@vibe-kit/grok-cli 0.0.34`）。
> 程式：`relay/machine/engines/acp-client.mjs`（最小 ACP 用戶端，無 npm 依賴）、`relay/machine/tools-acp-probe.mjs`（手動檢查）、`relay/machine/test/acp-client.test.mjs`＋`fake-acp-agent.mjs`（4 個測試，不碰真的 AI）。
> 轉接器介面見 `relay/machine/README.md`「轉接器介面」；Codex 那一份見 `docs/archive/CODEX-ENGINE.md`。

## 0. 給小良哥的白話摘要

**你問的三件事：**

1. **「ACP 或 AgentAPI 還是通知得到 Claude CLI 吧？」**
   - **接不到你已經開著的視窗。** 兩者的做法都是「由它們自己啟動 agent」：ACP 是「編輯器／程式把 agent 當子行程叫起來，用 stdio 講話」，AgentAPI 是「自己開一個模擬終端把 agent 包在裡面」。你自己在 Windows Terminal 開的 `claude`，兩者都碰不到。
   - 現在 Irori 能送進你開著的 Claude 視窗，靠的是 Claude Code 自己的「跨 session 訊息」（`ListAgents`／`SendMessage`，收發室用 `claude -p` 去呼叫它）。**這條路目前是唯一不改 Claude、又能進已開視窗的官方路**，不要拆。
   - **用「＋開新視窗」開的 Claude 視窗，本來就是一個真的互動式 Claude 視窗**（`Start-Process claude …`），所以 SendMessage 本來就接得到，**不需要為它改走 ACP**。改走 ACP 反而變成「看不見的背景工作」，還會碰到下一點的帳務規定。
   - **對 Claude 用 ACP 有帳務風險（來源與限定範圍，2026-10-26 查證）**：ACP 的 Claude 轉接器是用 Anthropic 的 Agent SDK 寫的。Anthropic 官方〈[Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance#authentication-and-credential-use)〉寫明：「開發產品或服務、包含用 Agent SDK 的，應使用 Claude Console 或支援的雲端廠商的 API 金鑰；Anthropic 不允許第三方開發者在自己的應用程式提供 Claude.ai 登入，或代使用者以 Free／Pro／Max 方案憑證發送請求」，也不得收集、儲存或轉手 Claude.ai 憑證。**但這不是「完全不能做」**：同一份文件說，使用者自己在未修改的 Claude Code 登入自己的訂閱沒有問題；另外〈[Use the Claude Agent SDK with your Claude plan](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)〉（Claude 說明中心）2026-10-07 更新寫「你仍可用 Claude Agent SDK、`claude -p` 與第三方 app 吃你的訂閱額度」，Max／Team 並含每月 API 額度，且 2026-06-15 曾暫停原先宣布的收緊。所以結論是**灰色地帶**：ASN 是對外發佈的產品，若由 ASN 的轉接器帶著使用者的訂閱登入去跑 Agent SDK，可能落入「第三方產品代為使用方案憑證」；使用者自己本機跑自己的登入則較沒問題，但規則仍在變。現行收發室用的是「沒改過的 `claude -p`＋你自己的訂閱登入」，文件允許。目前決定：**Claude 不走 ACP**（保守作法，要改需小良哥決定，必要時向 Anthropic 業務確認）。
   - AgentAPI 更不用考慮：它的 GitHub 專案 **2026-09-13 已封存、不再維護**。

2. **「pi shell 會自動找到電腦上有的 AI 嗎？」**
   - **不會。** pi 不是「包裝別家 CLI」的工具，它**自己就是一個 agent**（自己跑工具迴圈、自己打各家模型的 API），它也不會去偵測電腦上裝了 `claude`、`codex`、`agy`。它找金鑰的方式是：環境變數（`ANTHROPIC_API_KEY` 等）、`~/.pi/agent/auth.json`（`/login` 存的訂閱登入）、雲端環境登入。
   - 你這台的 pi 是公司 Aegis 版：`pi --mode rpc` 回報的模型提供者是「牧陽能控」、網址指向 Aegis 的 LLM 閘道、模型是「小蕙 — 財務主管」之類的成員，另外裝了 aegis／orca 擴充。**「自動找到」很可能是公司安裝腳本幫你設好了這個提供者，不是 pi 在偵測。**（這是我的推論，沒有看安裝腳本內容。）
   - **用 pi 開的視窗不是 Claude Code session**，不會出現在 `claude agents --json`，SendMessage 也送不進去。我在這台實測：pi 的 RPC 模式正常（`get_state` 回得來），我看了 `claude agents --json`，裡面只有 Claude 的 session。它要被送訊息，要靠 pi 自己的入口：RPC（限 Irori 自己啟動的）或「擴充」（可以放進你自己開的互動視窗，見第 5 節）。

3. **「有什麼專案可以讓我們少走歪路？」**
   - 標準有：**ACP**（Zed 提的、已有 50 幾個 agent 加入的官方登錄表，Gemini、Grok、Codex、pi、Antigravity、Claude 都在裡面）。它**不能**解決「送進已開視窗」，但**很適合**解決「Irori 自己啟動一個工作者並對話」，這一類各家不用寫私有整合。
   - 現成的多 agent 工具（claude-squad、vibe-kanban、Crystal、OpenHands…）全都只管「自己啟動的 session」，沒有一個能把訊息送進你自己開的視窗；其中 vibe-kanban 已宣布停運、Crystal 已棄用。只有 **Orca**（你本機已有）有 `orca terminal send`，但限在 Orca 內嵌終端機。

**一句話結論：不整套改成 ACP。** 維持現在的「引擎轉接器」架構，每個引擎照它**能不能接到已開視窗**分兩類處理：

| 引擎 | 你已開的視窗 | Irori 自己開的視窗／工作者 |
|---|---|---|
| Claude | 維持 SendMessage 轉接器（現行） | 同左（互動式視窗，一樣接得到） |
| Codex | 維持 `codex queue`（已做） | 同左 |
| Gemini（agy） | **接不到**（沒有官方入口） | **ACP 或 agy 自己的 stream-json**，已實測「送一句、拿回覆」成功 |
| Grok | **接不到**（官方文件沒提） | ACP（`grok agent stdio`），**這台沒裝官方版，未實測** |
| pi | 寫一個 pi 擴充放進視窗（官方範例就有這個做法） | pi 的 RPC 模式（已實測啟動成功） |

**分期建議：** 第一期做一個通用「ACP 轉接器」讓 Gemini（agy）以工作者形式上線（已實測可行）；第二期 pi 擴充＋pi 轉接器、Grok；第三期評估把 Orca 當作「已開視窗」的通用入口。細節與風險見第 8、9 節。

---

## 1. 重點驗證：ACP／AgentAPI 能不能通知到「使用者自己開著的 Claude 視窗」

| 問題 | 答案 | 依據 |
|---|---|---|
| ACP 怎麼接上 agent？ | 用戶端把 agent **當子行程啟動**，stdio 上跑 JSON-RPC。遠端傳輸（HTTP／WebSocket）還在制定中 | [ACP 簡介](https://agentclientprotocol.com/overview/introduction)、[Streamable HTTP RFD](https://agentclientprotocol.com/rfds/streamable-http-websocket-transport.md) |
| ACP 的 `session/list` 列的是什麼？ | **磁碟上存著的歷史 session，不是正在跑的**。所以不能拿它列出「使用者開著哪些視窗」 | [session/list](https://agentclientprotocol.com/protocol/v2/session-list.md) |
| ACP 的 `session/load`／`resume` 呢？ | 在**新啟動**的 agent 行程裡把舊對話載回來，不是接上舊行程 | [session setup](https://agentclientprotocol.com/protocol/session-setup) |
| Claude 的 ACP 轉接器怎麼做？ | 用 **Claude Agent SDK** 實作 ACP agent（SDK 自己啟動 Claude Code 行程）。文件沒有「附著到已開視窗」 | [claude-agent-acp](https://github.com/agentclientprotocol/claude-agent-acp) |
| AgentAPI 怎麼做？ | 在記憶體裡開**模擬終端**，把 HTTP 呼叫翻成按鍵、把終端畫面解析成訊息；只能控制它自己啟動的 agent | [coder/agentapi](https://github.com/coder/agentapi) |
| AgentAPI 現況？ | README 開頭：「AgentAPI is deprecated and no longer maintained」，**2026-09-13 封存** | 同上 |
| 現在 Irori 用的 SendMessage 呢？ | 每個 Claude Code 互動 session 都有本機訊息 socket；`ListAgents` 找得到、`SendMessage` 送得進去，收件視窗忙時在兩次工具呼叫之間讀、閒時開新一輪。**目前只能從另一個 Claude session 的模型工具呼叫發出**（所以收發室要有一個 `claude -p` worker）；官方沒有「不經模型直接送」的 CLI（社群 [#99049](https://github.com/anthropics/claude-code/issues/99049) 在要這個功能，2026-10-02 開、尚未處理） | [跨 session 訊息說明](https://claudefa.st/blog/guide/mechanics/cross-session-messaging)、#99049 |
| 還有別條進已開 Claude 視窗的官方路嗎？ | **Channels**（MCP 伺服器把事件推進「執行中的 session」，也可雙向）。限制：啟動時要帶 `--channels`、研究預覽、只接受官方白名單的插件（自製的要用 `--dangerously-load-development-channels`）、Team／Enterprise 要管理員開 | [Channels 文件](https://code.claude.com/docs/en/channels) |

**結論**：ACP、AgentAPI 都**不能**把訊息送進使用者已開的互動 Claude 視窗。要進已開視窗，Claude 只有兩條：SendMessage（現行）、Channels（研究預覽，要重開視窗並加旗標）。

### 混合做法評估（Claude 部分）

| 方案 | 已開的 Claude 視窗 | 「＋開新視窗」開的 Claude 視窗 | 評語 |
|---|---|---|---|
| A. 全部維持 SendMessage | 接得到 | 接得到（它是真的互動式視窗） | **推薦**。零改動 |
| B. 已開用 SendMessage，launcher 開的改 ACP 啟動 | 接得到 | 接得到，但變成**看不見的背景工作** | 使用者開「新視窗」是要一個看得到、可以接手的視窗；ACP 會破壞這件事，且碰 Agent SDK 帳務限制。不推薦 |
| C. 用 Channels | 要重開並加 `--channels` | 可從 launcher 啟動就帶上 | 研究預覽、白名單限制，目前不當主線；可當「收發室 worker 之外的第二條路」觀察 |

---

## 2. 「pi」是什麼、能不能當多引擎層

- **pi** ＝ Mario Zechner 的 coding agent（原 `badlogic/pi-mono`，2026-05 移到 Earendil Works，套件名 `@earendil-works/pi-coding-agent`，MIT，Node ≥ 22.19，Windows 可用）。官方 [GitHub](https://github.com/earendil-works/pi)。預設只有 read／bash／edit／write 四個工具，靠擴充、skills、prompt 範本、套件客製。
- **它自己是 agent，不是包裝器**：內建多家模型的統一 API（Pi AI），自己跑工具迴圈。登入方式（本機文件 `docs/providers.md`）：訂閱 OAuth（ChatGPT Plus/Pro＝Codex、Claude Pro/Max、GitHub Copilot、**xAI Grok／X 訂閱**、OpenRouter）、30 幾家的 API 金鑰環境變數、`auth.json`、雲端環境登入。**沒有偵測其他 CLI 或其憑證的功能。**
- 注意帳務：文件寫明 Claude Pro/Max 在 pi 這類第三方 harness 用的是「extra usage」，**按 token 另計，不扣 Claude 方案額度**。
- Google 的 Gemini 訂閱（agy 的登入）**不在 pi 的訂閱清單**；Google 官方也說不准把 agy 的憑證抽出來給別的程式用（見第 3 節），所以 pi 解不了 Gemini 的訂閱用法（要用 `GEMINI_API_KEY` 另計費）。
- **外部入口（回答「pi 開的視窗傳得進去嗎」）**：
  - `pi --mode rpc`：stdin／stdout 一行一則 JSON，指令有 `prompt`、`steer`、`follow_up`、`abort`、`get_state`、`get_last_assistant_text`、`new_session`、`switch_session`…，事件有 `agent_end`、`agent_settled`。**實測**：在 `irori-probe` 資料夾用白名單環境啟動，`get_state` 立即回傳（含 `sessionName`、`isStreaming`）。但這是「Irori 啟動的 pi 行程」，文件沒有附著到使用者已開的互動 pi 的方式（[rpc.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md)）。
  - `--mode json`（單次事件流）、TypeScript SDK、ACP 轉接器（社群 `pi-acp`，登錄表有）。
  - **擴充**（可以放進使用者自己開的互動視窗）：擴充 API 有 `pi.sendUserMessage()`（「像使用者打的一樣，一定觸發一輪」），官方範例 `examples/extensions/file-trigger.ts` 的註解就是「監看觸發檔，把內容注入對話。給外部系統對 agent 發訊息用」。所以做法是：寫一個 `irori-inbox` 擴充，`session_start` 時在 `~/.asn/…/pi-inbox/<視窗名>/` 登記並監看，收到信就 `sendUserMessage`，`agent_end` 時把最後回覆寫回。**這只是設計，我沒有實作也沒有跑**（跑了會花模型額度，且要動使用者的擴充設定）。
  - **2026-10-24 更新（#135 第二期，已實作、單元與整合測試通過，尚未用真的 pi 實測）**：上面「只是設計」的 `irori-inbox` 已做成 `relay/pi-extension/` 的收信功能＋橋內建的 `pi` 引擎（`bridge/engines/pi.rs`）。對照本機 pi 1.4.0 型別確認可行：`session_start` 起計時器（`session_shutdown` 清）、`pi.sendMessage({customType,content,display},{triggerTurn,deliverAs})` 注入（閒置立刻開一輪，忙碌用 `followUp` 排在整輪之後）、`ctx.ui.notify/setStatus`、`ctx.sessionManager.getSessionId()`、`pi.getSessionName()`。做法：擴充每 60 秒寫 `~/.asn/pi-windows/<sessionId>.json`（名單用，含 pid、idle／busy），橋把信寫成 `~/.asn/pi-inbox/<sessionId>/<信件編號>.json`，擴充每 2 秒掃、注入後移到 `done/`（去重）；pi 用 `asn_send`（`reply_to`）自己回信，核心照 Claude 視窗的方式認直接回覆與提醒。同一個 pi 不再被程序掃描重複列成「僅顯示」。限制：只有互動（tui）與 rpc 模式能收；`-p`／json 單次執行不登記。細節見 `relay/pi-extension/README.md`。
- **「把 pi 當成 Irori 的一種引擎轉接器，是否比逐家整合省事？」**
  - 只在「視窗本來就是 pi」時才成立（你的公司 Aegis 流程正是這樣）。這時一個 `pi` 轉接器（RPC＋擴充）就同時涵蓋 pi 背後所有模型，包含 Grok 訂閱、ChatGPT 訂閱、Aegis 成員。
  - **不成立的地方**：它不能替代 Claude Code／Codex／agy 的視窗——那些是各家官方 harness，行為、外掛、記憶、帳務都不同。若想「全部改用 pi 開」，等於換掉使用者的日常工具，並讓 Claude 改按 token 另計，這不是轉接器的事，是產品決定。
  - 小提醒：你這台 pi 的模型是 Aegis 成員，**Aegis 轉接橋（`bridge-aegis.mjs`）本來就能直接問這些成員**（呼叫 `agent-chat/ask`）；pi 視窗只是另一個介面。

---

## 3. Gemini：`agy`（Antigravity CLI）與舊的 `gemini` CLI

| | `agy`（Antigravity CLI） | `gemini`（Google 官方舊 CLI） |
|---|---|---|
| 這台版本 | 1.2.4，已登入，可用 | 0.52.0（npm 全域） |
| 登入狀態 | 可用（實測 1.8 秒回 PONG） | **不能用**：ACP 實測 `Error authenticating: IneligibleTierError: This client is no longer supported for Gemini Code Assist for individuals… migrate to the Antigravity suite`。你的 gemini skill 也寫 2026-06-18 起個人免費方案已停 |
| 非互動 | `-p`、`--output-format text/json/stream-json`、`--input-format stream-json`（長駐、一行一則）、`--json-schema` | `-p`、`-o stream-json` |
| ACP | CLI 本身沒有 `--acp`；Google 另出**官方 ACP 伺服器**（`agy_acp_server`，登錄表 `antigravity-acp` 1.3.0）；社群 `google-antigravity-acp`（MIT）包 agy | `gemini --acp`（原生，ACP 的第一個示範實作；`loadSession` 支援） |
| 恢復 session | `--continue`、`--conversation <id>`（實測可恢復並記得上文） | `--resume`、`--list-sessions` |
| 列名單 | 沒有「列出開著的視窗」；官方 ACP 伺服器宣告 `sessionCapabilities.list`（列歷史） | `--list-sessions`（歷史） |
| 送進已開視窗 | **沒有官方入口**。Remote Control（`/remote-control` 或 `agy remote-control start` 常駐）只給 Google 自家網頁；文件「沒有提供第三方本機 API」。社群 `agy-remote` 靠 tmux `send-keys` 接手已開的視窗，Windows 原生沒有 tmux | 同左，無 |

來源：[agy 無頭模式](https://antigravity.google/docs/cli/headless/)、[Remote Control](https://antigravity.google/docs/remote-control/)、[Google 論壇：外部協調 agy 無頭模式是否支援](https://discuss.ai.google.dev/t/is-external-orchestration-of-antigravity-cli-headless-mode-supported-with-account-based-usage/183051)（Google 代表回覆：把官方 `agy` 當本機子行程、沿用其快取登入，**是支援的用法**，用量與互動使用共用同一份額度；**不支援**把 OAuth 憑證抽出來用、或直接打 Antigravity 後端）、[Gemini CLI ACP 模式](https://geminicli.com/docs/cli/acp-mode/)、[sibbl/google-antigravity-acp](https://github.com/sibbl/google-antigravity-acp)、[agy-remote](https://pypi.org/project/agy-remote/)。

### 在這台的實測（都是新開的 `irori-probe` 暫存資料夾，測完刪除；子行程環境用白名單，不帶任何金鑰）

| 路線 | 結果 |
|---|---|
| `gemini --acp`（0.52.0）→ `tools-acp-probe.mjs init gemini` | `initialize` 5.5 秒成功（`loadSession: true`，登入方式 4 種）；一送 session 就因帳號層級被拒。**舊 gemini CLI 在這台已無法使用，不必投資** |
| Google 官方 `agy_acp_server.exe` 1.3.0（`dl.google.com` 下載 zip 124 MB，解壓後 81 MB＋145 MB 兩個執行檔，Python 打包） | `initialize` 13～18 秒（冷啟動慢）成功；宣告 `loadSession`、`sessionCapabilities.list`、`resume`。`session/new` 回「Authentication required」；`authenticate oauth-personal` 會**另開一次瀏覽器 Google 登入**（它有自己的憑證庫，**不共用 agy 已登入的憑證**），我沒有替使用者完成登入，到此為止 |
| 社群 `google-antigravity-acp` 2.0.1（MIT，npm，無安裝腳本；包本機 `agy`，沿用 agy 登入） | **成功**：`initialize` 0.2 秒、`session/new` 2.2 秒、`session/prompt`「只回 PONG」→ 回 `PONG`，`stopReason=end_turn`，整輪 4.7 秒。只宣告 `loadSession: false`，沒有名單 |
| `agy` 原生長駐 stream-json（不經 ACP） | **成功**：單次 `-p` 1.8 秒回 PONG；長駐行程同一個 `conversation_id` 連問兩輪，第二輪記得上文（KIWI），第二輪 2.2 秒；另開新行程 `--conversation <id>` 恢復後仍記得（3.8 秒）。輸入格式（試錯得知，官方文件沒給）：`{"event":"user","message":{"content":"…"}}`；輸出事件 `init`／`step_update`（`text_delta`）／`result`（`response`、`status`、`usage`） |

小觀察：agy 每輪即使很短，輸入 token 約 1.16 萬（系統提示加工具定義），量大時要算進成本。

**預設權限**：社群轉接器預設是**自動核准所有工具**，要加 `--no-skip-permissions`（我的測試有加）。agy 本身在非互動模式下，需要核准的工具會被「軟拒絕」（繼續跑、結束碼 0）；我們的 ACP 用戶端也對 `session/request_permission` 一律回「拒絕」。

---

## 4. Grok

- **這台的 `grok` 不是官方版**：是社群的 `@vibe-kit/grok-cli 0.0.34`（只有 `-p` 無頭、`mcp`、`git`；要 `GROK_API_KEY`／xAI API 金鑰；沒有 ACP、沒有 session 名單）。我沒有用它跑任何東西（它需要金鑰，我不碰）。
- **官方 Grok Build**（xAI／SpaceXAI，2026-05 發表、v1.0 於 2026-08-07、Apache-2.0，倉庫 [xai-org/grok-build](https://github.com/xai-org/grok-build)，npm `@xai-official/grok`）：
  - 三種用法：TUI、無頭（`grok -p "…"`，可 `-s/--session-id`、`-r/--resume`、`-c`）、**ACP（`grok agent stdio`）**。ACP 登錄表有登錄（`grok-build` 1.0.49，啟動：`npx @xai-official/grok agent stdio`）。
  - Session 存在 `~/.grok/sessions/`（依工作資料夾分），TUI／無頭／ACP 共用；`grok sessions list`、`grok sessions search`。
  - 登入：瀏覽器登入（需要 SuperGrok 或 X Premium+ 訂閱）或 `XAI_API_KEY`。MCP 支援。
  - **Windows：倉庫寫「best-effort，目前沒有測試」。**
  - 文件**沒有**提到對執行中的 TUI 從外部送訊息（[sessions 文件](https://docs.x.ai/build/features/sessions)）。→ 已開視窗接不到，同 agy。
  - **名稱衝突**：官方版和社群版都叫 `grok`。裝官方版前要先處理（解除社群版，或用完整路徑／`npx` 呼叫）。
- 另一條：pi 的 `/login xai` 可用 Grok／X 訂閱，走 pi 的 RPC（見第 2 節）。
- 來源：[Grok Build 概覽](https://docs.x.ai/build/overview)、[無頭模式](https://docs.x.ai/build/cli/headless-scripting)、[Sessions](https://docs.x.ai/build/features/sessions)、[ACP 登錄表](https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json)。
- **接手使用者自己開的 grok（2026-10-25，已實作，尚未用真的 grok 實測 `session/load`）**：名單上的「grok #pid（前景）」沒有外部入口，但 grok 自己把使用中的對話登記在 `~/.grok/active_sessions.json`（陣列：session_id、pid、cwd、opened_at），對話資料夾在 `~/.grok/sessions/<編碼後的工作資料夾>/<session_id>/`。選單「接手」（沿用 `handover` 動作代號，後台不用改）用名單上的 pid 查登記檔，唯一才採用（沒登記、同 pid 對到多段、對話資料夾不在、登記比程序還早＝pid 被重用，一律不接手並回中文原因）；然後用現有 Grok 工作者的指令另開專屬工作者「grok-接手-<資料夾名>」（`bridge/engines/grok_adopt.rs`），以 ACP `session/load` 載入同一段對話，載不進來就失敗、不退回開新對話（`WorkerCfg.adopted`）。專屬工作者寫檔最多「詢問」、工作資料夾白名單換成那段對話的資料夾；接手名冊存 `acp-adopted.json`，橋重啟後建回來。只讀登記檔與資料夾名稱，不讀對話內容、不碰 auth；絕不結束或操作使用者的 grok 程序。風險：終端機的 grok 與專屬工作者同時寫同一段對話可能互相覆蓋，所以對話框要二次確認「接手後請先關掉終端機那個 grok」。
- **未實測**：官方 Grok Build 的安裝與 ACP（需要訂閱登入，且 Windows 為 best-effort）。要實測時再做，約一個工作階段內可完成（裝 → 登入 → `tools-acp-probe.mjs prompt custom "…" --cmd <grok 路徑> agent stdio`）。

---

## 5. 現成標準與專案比較

### 5.1 ACP 登錄表中和我們有關的（2026-10-04 從登錄表 JSON 抓的）

| 登錄名 | 版本 | 啟動 | 底層 | 備註 |
|---|---|---|---|---|
| `claude-acp`（Claude Agent） | 0.85.1 | `npx @agentclientprotocol/claude-agent-acp` | Claude Agent SDK | **帳務限制（灰色地帶），見第 1 節** |
| `codex-acp` | 2.1.1 | `npx @agentclientprotocol/codex-acp` | 新版建在 Codex App Server | 舊倉庫 `zed-industries/codex-acp` 2026-07-22 封存；支援 ChatGPT 訂閱登入，但「遠端專案不能用」 |
| `gemini`（Gemini CLI） | 0.62.0 | `npx @google/gemini-cli --acp` | 原生 | 這台的帳號層級已被拒 |
| `antigravity-acp`（Google） | 1.3.0 | 下載 `agy_acp_server`（有 windows-x86_64） | Google 官方 | 要另外登入，體積大 |
| `grok-build` | 1.0.49 | `npx @xai-official/grok agent stdio` | 原生 | Windows best-effort |
| `pi-acp` | 0.0.34 | `npx pi-acp` | 社群，包 pi | — |

ACP 本身：Apache-2.0、穩定版是 v1、v2 在開發中、TypeScript／Python／Rust／Kotlin／Java SDK（TypeScript 的 `@agentclientprotocol/sdk`，舊的 `ClientSideConnection` 已改為 `agent()`／`client()` 流式 API）。Irori 的橋「沒有 npm 依賴」，所以原型自己寫了約 100 行的 JSON-RPC 用戶端（`acp-client.mjs`），夠用。

### 5.2 多 agent 編排工具（背景研究，部分取自二手摘要，已標註）

| 工具 | 引擎 | 控制方式 | 進得了使用者自己開的視窗？ | Windows | 授權／狀態 |
|---|---|---|---|---|---|
| [claude-squad](https://github.com/smtg-ai/claude-squad) | Claude Code、Codex、OpenCode、Amp（Aider、Gemini 靠設定） | tmux＋git worktree | 否，只管自己建的 | 無原生版，要 WSL | AGPL-3.0，持續更新 |
| [vibe-kanban](https://github.com/BloopAI/vibe-kanban) | 10 種以上 | 未確認 | 否（推測） | 不明確 | Apache-2.0，**2026-04 宣布停運**，改社群維護（[公告](https://vibekanban.com/blog/shutdown)） |
| [Crystal](https://github.com/stravu/crystal) | Claude Code、Codex | 桌面 App＋worktree | 否 | 從未支援 | MIT，**2026-02 棄用**，後繼 Nimbalyst |
| [Orca](https://github.com/stablyai/orca) | 40 種以上（含 Claude Code、Codex、Grok、pi；agy 未列） | 內嵌終端機＋`orca` CLI：`terminal list/read/send/wait` | **可以，限 Orca 內嵌終端機**；你在 Orca 外開的視窗不行 | 原生 | MIT，每日發版 |
| [OpenHands](https://github.com/OpenHands/OpenHands) | 原生、Claude Code、Codex、Gemini CLI、任何 ACP agent | 透過 ACP 啟動子行程 | 否（文件明說未涵蓋附著） | 有 | MIT。文件說會自動用訂閱登入檔，**沒提 Anthropic 政策**（疑慮） |
| [happy](https://github.com/slopus/happy) | Claude Code、Codex | 用 `happy claude`／`happy codex` 取代原指令 | 否，必須用它啟動 | 有 | MIT。內含 `claude-agent-sdk`（帳務疑慮同上）。**你這台有裝 happy** |
| cmux、Conductor | 多種 | macOS 專用 | — | **無** | — |

沒有任何一個能「把訊息送進使用者自己開的 Claude／Gemini／Grok 視窗」，這個需求確實是特殊的，只有各家自己的入口能做（Claude SendMessage、Codex queue、pi 擴充）。多 agent 工具沒有一個比我們現在的架構更適合直接拿來用。

### 5.3 MCP 的角色

MCP 管的是「agent 呼叫外部工具」，不是「外部把訊息送給 agent」（Claude 的 Channels 是 MCP 加的例外）。它對我們有用的地方是**讓各引擎的 agent 用同一個工具回寄信**：寫一個 `irori-mail` MCP 伺服器（包 `send.mjs` 的 `send`／`reply`），Claude、Codex、agy（`agy mcp add`）、Grok（`grok mcp`）都支援 MCP，就不用靠「視窗內跑 `node send.mjs`」（沙盒沒網路時行不通，Codex 文件第二期就是這件事）。pi 的內建 MCP 支援我沒有查到，標為未驗證（pi 的設計是用擴充，不是 MCP）。這是第二期以後的獨立工作，與 ACP 不衝突。

---

## 6. 比較表：各引擎「接得到什麼」

| | Claude Code | Codex | Gemini（agy） | Grok Build | pi |
|---|---|---|---|---|---|
| 送進**使用者已開**的視窗 | 是：SendMessage（現行）；Channels（需 `--channels`） | 是：`codex queue --thread` | **否**（無官方入口） | **否**（文件未提） | 擴充（需設計）；RPC 否 |
| 列出開著的視窗 | `claude agents --json` | 名字索引＋鎖檔推斷 | 無 | 無（`grok sessions list` 是歷史） | 無（可由擴充登記 presence） |
| Irori 啟動的工作者 | `claude -p`（現行收發室） | `codex exec`／app-server | **ACP 或原生 stream-json（已實測）** | ACP `grok agent stdio`（未實測） | `pi --mode rpc`（`get_state` 已實測） |
| 取回覆 | worker 輸出帶 nonce 區塊 | 讀 turns 的最終回答 | `result.response`／ACP `agent_message_chunk` | 同左（ACP） | `agent_end` 事件、`get_last_assistant_text` |
| ACP | 有（Agent SDK，**帳務風險**） | 有 | 有（官方＋社群） | 原生 | 社群 |
| 帳務 | 訂閱（`claude -p` 沒改過的 binary） | ChatGPT 訂閱 | Google 帳號額度（官方說明可） | SuperGrok／X Premium+ 或 API 金鑰 | 看選的提供者；Claude 走 extra usage |
| Windows | 原生 | 原生 | 原生（agy 是 Go 執行檔） | best-effort | 原生（需 Git Bash） |
| 授權 | 專有 | Apache-2.0 | 專有 | Apache-2.0 | MIT |

---

## 7. 原型：最小 ACP 用戶端

- `engines/acp-client.mjs`：`initialize`（宣告不提供 fs／terminal 能力）→ `authenticate`（選用）→ `session/new` → `session/prompt`，收集 `session/update` 裡的 `agent_message_chunk` 文字；agent 發出的 `session/request_permission` **一律選拒絕**；agent 要求沒宣告的用戶端方法（fs／terminal）回 method not found；行程掛掉時等待中的請求會被拒絕，不會卡死。
- **子行程環境是白名單**（`cleanEnv`：只留 PATH、HOME/USERPROFILE、APPDATA、TEMP 等系統變數）。任何 `*_API_KEY`、`*_TOKEN`、`ASN_RELAY_*` 一律不帶；登入狀態讀各 CLI 自己在家目錄的憑證檔。這比 `codexChildEnv` 的黑名單更嚴，建議新引擎都用白名單。
- `tools-acp-probe.mjs`：
  ```
  node tools-acp-probe.mjs init   gemini                       # 只 initialize，印能力，不花額度
  node tools-acp-probe.mjs prompt custom "只回 PONG" --cmd node <google-antigravity-acp>/dist/cli.js --binary-path <agy.exe> --no-skip-permissions
  ```
  只開 `irori-probe-acp-*` 暫存資料夾，結束即刪；不碰任何使用者視窗。
- 測試：`node --test relay/machine/test/acp-client.test.mjs`（4 個，含「金鑰環境變數不會傳進子行程」「權限請求被拒」「agent 行程消失」），全部通過。

實測的「送一句、拿回覆」結果見第 3 節表格（經 ACP 與經 agy 原生各一次，都成功）。

---

## 8. 建議

### 8.1 要不要把轉接器層改成以 ACP（或 AgentAPI）為主？

**不要整套改。** 理由：

1. **最大的價值（送進使用者開著的視窗）ACP 給不了**，這是 Irori 收發室的核心。改了只會失去 Claude／Codex 的現有能力。
2. Claude 走 ACP 有**帳務風險**（Agent SDK 不准用 Pro／Max 訂閱登入），現行方式沒有這個問題。
3. ACP 的名單是歷史不是即時；我們需要的「現在誰開著、忙不忙」ACP 沒有。
4. 但 ACP 對「Irori 自己啟動的工作者」確實省事：一個 `acp` 轉接器 + 設定檔（每個 agent 一條啟動指令）就能涵蓋 Gemini、Grok、pi（社群）、Codex 等，不必各寫私有整合。

**AgentAPI：不採用**（已封存、靠解析終端畫面脆弱、Windows 文件未提）。

### 8.2 優缺點（採用「只用 ACP 做工作者」的混合方案）

| 優點 | 缺點／風險 |
|---|---|
| 新引擎的接入成本從「一整個轉接器」降到「一條啟動指令＋授權檢查」 | 工作者是**看不見**的背景 session，不是使用者的視窗；使用者不能直接插話（可考慮之後用 `agy --conversation <id>`、`grok --resume <id>` 讓他接手，**未驗證互動式能不能恢復這類 session**） |
| 協定是 Apache-2.0、跨廠商、有登錄表可查啟動方式 | 各家 ACP 實作品質不一（舊 gemini 的帳號被拒、官方 agy 伺服器要另外登入且很大、社群轉接器是第三方套件） |
| 回覆是結構化事件（`agent_message_chunk`、`stopReason`），比解析終端好 | 權限：ACP 的 agent 會要求核准工具；無人值守只能「全拒」或「全放」，全拒時 agent 幾乎只能聊天，全放有安全風險（社群轉接器預設全放，必須關掉） |
| 與現有 `capabilities()`／`deliver()`／`onReply()` 介面可對應 | 要定義「ACP 工作者」在名單裡怎麼顯示、什麼時候建立／回收（見分期） |

### 8.3 遷移成本與對現有 Claude 轉接器的影響

- **對現有 Claude 轉接器（SendMessage、名單、收發室）：零影響。** ACP 轉接器是新增一個引擎，`ASN_ENGINES=claude,codex,acp` 並存；Claude 不動。
- 新增工作：`engines/acp.mjs`（約 200 行，沿用 `acp-client.mjs`，實作 `capabilities`／`start`／`stop`／`listWindows`／`listNames`／`activityOf`／`deliver`）、啟動指令設定檔（例如 `~/.asn/acp-agents.json`：名稱 → 指令、參數、模型、權限策略）、契約測試（照 `engine-contract.test.mjs`）、README 一節。
- 名單裡的 ACP 工作者視窗名：建議 `工作者-<引擎>`（例如 `Gemini-工作者`），引擎欄位 `engine=acp:gemini`。

### 8.4 分期

| 期 | 內容 | 前提／驗收 |
|---|---|---|
| **一（已實作，第 9 節）** | `engines/acp.mjs` 通用轉接器＋ agy 工作者（主線＝直連 agy 原生 stream-json，備援＝標準 ACP 驅動；選擇理由見 9.1）；權限一律拒絕；每信一個 `session/new`（無狀態）或每寄件人一個 session（有記憶，需設計回收）；契約測試 | `ASN_ENGINES=claude,acp` 時，Irori 手機對 `Gemini-工作者` 送一句、收到回覆；不影響 Claude |
| **二** | ① pi：`irori-inbox` 擴充（已開視窗）＋ `pi --mode rpc` 工作者；② Grok：裝官方 Grok Build（先處理 `grok` 名稱衝突）、登入、實測 `grok agent stdio`，Windows 若不穩就退到 `grok -p --resume`；③ `irori-mail` MCP 伺服器讓各引擎自己回信 | 每個都先跑 `tools-acp-probe.mjs`／RPC probe 再寫轉接器 |
| **三** | 評估 Orca 當「已開視窗」通用入口（`orca terminal send`，限 Orca 內嵌終端機）；Claude Channels 轉正式後評估是否取代收發室 worker | Orca 是否支援使用者手動開的終端機待查；Channels 仍是研究預覽 |

### 8.5 風險清單

1. **Claude 帳務**：不要讓任何 ACP／Agent SDK 路徑用到使用者的 Claude 訂閱登入。若有人想「方便」把 Claude 加進 ACP 轉接器，這是紅線。
2. **金鑰外洩到 AI 對話**：子行程一律白名單環境（`cleanEnv`）。這次實測沒有印出或傳送任何環境變數；測試用的子行程環境只含系統變數。
3. **無人值守的權限**：ACP 工作者預設全拒；要放行任何工具，要有逐引擎的明確設定與白名單，且信的內容視為外部資料（提示注入）。
4. **第三方套件供應鏈**：`google-antigravity-acp`（社群、MIT、2 個依賴、無安裝腳本，我已檢查 `npm view`）上線前要釘版本並看過原始碼；或用 35 行直連 agy 取代。
5. **Google 條款**：Google 論壇答覆說「把官方 `agy` 當子行程、沿用其快取登入」是支援的；直接抽取憑證或打後端不支援。社群轉接器是包 `agy` 子行程，屬於前者；Google 官方 ACP 伺服器則走自己的登入。
6. **Windows**：Grok Build 官方標示 best-effort；官方 `agy_acp_server` 冷啟動 13～18 秒，且需 226 MB。
7. **工作者的可見性**：使用者看不到背景工作者在做什麼；需要在回信裡標明「這是 Irori 啟動的 Gemini 工作者，不是你開的視窗」，並限制它的工作資料夾（暫存資料夾，無專案檔）。

### 8.6 這次沒做到／未驗證

- 沒有送任何訊息到使用者開著的視窗（依規定）。
- 沒有實測：官方 Grok Build（沒裝、要訂閱登入）、pi 擴充（只讀文件與官方範例）、Orca 對使用者自開終端機、Claude Channels。
- 官方 `agy_acp_server` 的登入沒有完成（需要使用者互動的瀏覽器授權）；啟動它時它嘗試開登入頁，我讓逾時結束並關掉行程。如果你看到有一個 Google 登入分頁，是這個，可以直接關。
- 多 agent 工具表中標「推測」「二手」者未逐一點進第一手頁面。
- 「用 pi 開一個 irori-probe 的 claude session」這個測法**不適用**：pi 不會啟動 `claude`，所以沒有 Claude session 可以看；我改測 pi 自己的 RPC（`get_state`，不呼叫任何模型）。

---

## 9. 第一期實作：Gemini 工作者上線（2026-10-04）

程式：`relay/machine/engines/acp.mjs`（轉接器）＋ `acp-config.mjs`（設定）、`acp-worker.mjs`（佇列／健康狀態／問人）、`acp-policy.mjs`（權限政策）、`acp-approvals.mjs`（授權簿）、`acp-driver-agy.mjs`、`acp-driver-acp.mjs`（兩種驅動）、`acp-errors.mjs`。範本 `relay/machine/agents.example.json`。測試 `relay/machine/test/acp-*.test.mjs`＋假 agent（`fake-agy.mjs`、`fake-acp-worker.mjs`）。

### 9.1 選哪一條路：agy 原生 stream-json（主），標準 ACP（備援）

兩條都實測成功（真的 agy 1.2.16，Windows）。選 **agy 原生**為主，理由：

1. **社群 `google-antigravity-acp` 只是 agy 原生的薄包裝**：我讀了它的原始碼（`agy-session.js`），它做的事就是 `spawn agy --input-format=stream-json …`，再把事件翻成 ACP。所以能力沒有比較多：它**從不送 `session/request_permission`**（只有一個「要不要加 `--dangerously-skip-permissions`」的開關），宣告 `loadSession:false`（重啟後接不回對話），多一層第三方程式碼（供應鏈）與多一層行程。
2. **原生可以 resume**：`--conversation <id>` 實測接得回上文（問過 note.txt 的內容，重啟後問「剛剛讀的檔案裡 secret-fruit 是什麼」答 KIWI）；ACP 備援重啟後答「沒讀過」。
3. **原生的結果帶結構化狀態**：`result.status=ERROR`＋`error` 文字（登入、額度、模型錯誤都從這裡判斷）、`denied_actions`、每個工具步驟的事件（寫檔絆線靠它）。
4. 兩者共用同一個 agy 子行程，登入額度、速度（單輪約 2～5 秒）一樣。

備援（`protocol:"acp"`）仍完整可用：任何標準 ACP agent（社群 agy 包裝、之後的 Grok Build、codex-acp、`gemini --acp`…）設定檔改幾行就接得上，**而且只有這條路有「執行到一半問人」的能力**（見 9.3）。agy 1.2.16 的格式與 1.2.4 不同（`--print` 現在要吃一個提示字串，不能再跟 `--input-format stream-json` 並用；`result` 變成巢狀物件），驅動已照 1.2.16 實測寫。

### 9.2 權限的現實（實測，重要）

預設政策＝**讀、寫、執行、上網都放行，限工作者自己的工作資料夾**（2026-10-23 小良哥裁示；agents.json 明寫的照寫，明寫 deny 就是 deny）。但 agy 在無頭模式（stream-json）**自己只擋指令**：

| 動作 | agy 無頭模式的實際行為（這台，使用者設定 `allowNonWorkspaceAccess:true`） | 我們怎麼擋 |
|---|---|---|
| 執行指令（`run_command`） | 自動拒絕（步驟 ERROR、結果 `denied_actions`），模型會看到被拒 | 靠 agy 自己；`execute:allow` 才加 `--dangerously-skip-permissions` |
| 寫檔（`write_to_file`…） | **不問就直接寫，連工作資料夾以外也寫得進去**（`--mode plan` 也擋不住：被明確要求時照寫；`--sandbox` 只限制終端機） | **絆線**：驅動看每個工具步驟事件，違反政策（write 不是 allow、或路徑在白名單資料夾外）就立刻殺掉 agy 並回報。真 agy 實測 3/3 在檔案寫成前殺掉，但這是「事件比寫入早到」的時間差，不是保證 |
| 讀檔 | 不問；連資料夾外也讀得到（agy 自己也會讀它內建的說明檔） | **擋不了**。唯讀只靠：工作資料夾是空的專用資料夾（預設 `~/.asn/machine-<ID>/workers/<名字>/`）＋說明（第一則訊息附的角色說明）。不要把工作者的資料夾指到專案目錄 |
| 上網 | 不問 | `network:deny` 時同樣用絆線 |

所以：**agy 的寫檔無法「預防」，只能「偵測並中止」**，這是 agy 目前的限制，不是我們的取捨。要真正預防，只能用會送權限請求的 ACP agent（9.3）。另外模型本身也會遵守第一則訊息附的角色說明（真實測試：要它寫檔，它直接回「做不到，我目前是唯讀狀態」），但那是軟性的，不能當安全邊界。

ACP 路線（標準 ACP agent）的權限是**真的預防**：agent 要做事前先送 `session/request_permission`，轉接器依政策回 `allow_once`／`reject_once`，沒有政策批准就不會執行（前提是 agent 老實送請求）。

### 9.3 政策設定與「問我」模式

`agents.json` 每個工作者的 `permissions`：

```jsonc
"permissions": {
  "read": "allow", "write": "allow", "execute": "allow", "network": "allow", "other": "deny",   // 每類 allow / deny / ask
  "allow_dirs": ["C:\\...\\workers\\Gemini"]   // 白名單資料夾：有路徑的讀／寫請求，路徑在這些資料夾外一律拒絕（預設只有 cwd）
}
```

- 類別：`read`（讀、搜尋、思考）、`write`（寫、刪、搬）、`execute`（執行指令）、`network`（抓網頁／搜尋）、`other`（分不出類別）。
- `ask`＝問人：轉接器把「哪個工作者想做什麼（檔案或指令的摘要，已遮蔽疑似金鑰／token）」寄給 `ask.notify`（預設 `"sender"`＝原寄件人；可寫 `{"node":"PC1"}` 寄給指定的節點（例如帳號擁有者的 ASN），由他決定），**回信寫給工作者**：「允許 ABCD」「拒絕 ABCD」「全部允許 ABCD」（全部允許＝這一輪之後的同類請求都放行，下一輪重新問）。只有被問的節點的回覆算數（別人冒名不算，會被當成一般來信送進模型）；沒附編號時只認單純的一個表態（「允許」「拒絕」「好」「ok」），免得「好的，我晚點看」被當成放行。`ask.timeout_ms`（預設 5 分鐘）內沒回就**自動拒絕**並通知被問的人。
- **agy-stream 的限制**：agy 無頭模式不能在執行中暫停，所以 `write`、`network`、`other` 設 `ask` 會自動降成 `deny`（log 提醒）。`execute:"ask"` 以「事後問」實作：指令被 agy 擋下後，問你要不要放行，同意就用放行模式（`--dangerously-skip-permissions`，只這一輪、resume 同一段對話）請它重做，之後回到一般模式。
- **標準 ACP 路線**：`write`／`execute`／`network` 都能真的「先問再做」。要用真能問的 agent（例如 Grok Build `grok agent stdio`，**這台沒裝、未實測**；社群 agy 包裝不會送請求，設 ask 也不會被問）。
- 範本與預設政策：`read`、`write`、`execute`、`network` 預設 `allow`，`other` 預設 `deny`；有路徑的讀寫以 `allow_dirs`（預設只有工作資料夾）為界，資料夾外一律拒絕。**執行指令沒有路徑可查，工作資料夾不是沙盒**：agy 開著放行模式時指令能碰到資料夾外，邊界只靠專用空資料夾、角色說明與可信的寄件人。要收緊就在 agents.json 明寫 `deny`。提示注入若引誘它把資料帶進網址有外洩風險，要全封閉就把 `network` 設 `deny`。

### 9.4 登入／額度／其他失敗怎麼偵測、怎麼回報（不是 ACP 權限請求的那一類）

| 情況 | 偵測 | 名單狀態 | 回報 |
|---|---|---|---|
| 沒登入／登入失效（agy 要 Google 瀏覽器登入；ACP 的 `Authentication required`） | 結果的 `error` 或 stderr／JSON-RPC 錯誤文字符合「not logged in／login／authentication／unauthenticated／401…」；ACP 在啟動握手時就會發現 | `login-required`（手機聯絡人顯示「需要登入」，詳細頁紅字「需要到電腦前登入」） | 寄件人收到「Gemini 需要登入… 請到這台電腦前在終端機執行 agy 完成 Google 瀏覽器登入，好了再寄一次」；`ask.notify` 裡指定的人（非寄件人）另外收到一封，同一狀態一小時最多一次 |
| 額度用完／被限流 | 文字符合「quota／rate limit／RESOURCE_EXHAUSTED／429／usage limit」（先判額度再判登入） | `quota`（「額度用完」） | 同上，說明「額度用完，請稍後再試」 |
| 一輪太久沒動靜 | 看門狗：`turn_timeout_ms`（預設 5 分鐘，任何事件／等人授權都會重計）；`turn_max_ms` 總上限 30 分鐘 | 不變 | 殺掉該行程、回報「處理太久沒有動靜，已中止這一輪」；下一封自動重啟並 resume |
| 行程中途死掉／指令不存在 | 結束碼＋stderr 尾端 | 起不來（找不到指令）→ 從名單消失，每分鐘重試；寄信得到「工作者目前沒有在跑：原因」 | 寄件人收到說明 |
| 違反政策（絆線） | 見 9.2 | 不變 | 「Gemini 想做不被允許的事：寫入：檔案：X（原因）。已立刻中止這一輪；若是寫檔，檔案可能已經被寫入」 |
| 佇列太長 | `queue_max`（預設 10，含正在處理的那封） | `busy` | 超過的信立刻回「前面還排著 N 封信，這封先不收」 |

**登入狀態的恢復**：`login-required`／`quota` 不擋信（每封信都還是會試一次），所以你登入完之後寄一封，成功就自動回 `idle`。一律不吞信：成功→回覆；失敗→`[收發室] 轉交給 Gemini 失敗：…`（含 reply_to）。

登入的實際步驟（人工、不能自動化）：在那台電腦開終端機執行 `agy`，照畫面用 Google 帳號完成瀏覽器登入；子行程只讀 agy 自己存在使用者家目錄的憑證檔，橋不碰任何金鑰。

### 9.5 第一期上線步驟（工作機）

> 以下是**使用者**在那台電腦做的事；這次實作沒有重啟任何橋、沒有部署。

1. **先確認 agy 本身能用**：終端機執行 `agy --version`，再 `agy -p "只回 PONG"` 要回 PONG（沒登入就先照 9.4 登入）。
2. **放設定檔**：複製 `relay/machine/agents.example.json` 到 `%USERPROFILE%\.asn\agents.json`，至少改 `cwd` 與 `allow_dirs`（把 `你` 換成使用者名稱）。`cwd` 請用**專用的空資料夾**（不存在會自動建），不要指到專案。
3. **載入轉接器**：橋要用 `ASN_ENGINES=claude,acp` 啟動。用排程／手動啟動的話：`run-bridge.ps1 -NodeId <ID> -Engines claude,acp`（新增的 `-Engines` 參數）；或在使用者環境變數設 `ASN_ENGINES`。**重啟橋才會生效**（橋有單一執行個體鎖，先正常關掉舊的再開）。
4. **看 log**：`%USERPROFILE%\.asn\machine-<ID>\bridge.log`，搜尋 `acp:`。啟動時會有 `acp: 工作者 Gemini 啟動（protocol=agy-stream cwd=… 權限 read=allow write=deny …）`；設定有問題會有 `acp: 設定有問題，已跳過：…`／`設定提醒：…`。之後每封信有 `handed id=… to=Gemini`、`[Gemini] …` 行（權限請求、等授權、狀態變化、失敗原因都在這裡）。對話的 session id 存在 `machine-<ID>\acp-workers.json`（刪掉＝下次從新對話開始）。
5. **確認名單**：幾十秒內，手機 Irori Chat「聯絡人」那台電腦底下出現 `Gemini`（頭像右下有 ✦ 角標；要先部署 9.6 的前後端，沒部署時它會被當成 Claude 視窗顯示，功能照常）。
6. **試一封**：從手機對 Gemini 傳一句話，或在那台電腦用 `node relay/machine/send.mjs`（見 README）寄一封，等幾秒收到回信。
7. **關掉**：把 `agents.json` 裡該工作者加 `"enabled": false`，或移除 `ASN_ENGINES` 裡的 `acp`，然後重啟橋；Claude 的收發室完全不受影響（兩者是獨立的轉接器）。緊急時直接結束橋，工作者子行程會跟著結束。

### 9.6 手機聯絡人顯示（後端 deno、前端 node，已實作、**未部署**）

橋本來就把每個視窗的 `engine` 放進 roster 上報；仲介以前直接忽略。這次補上完整鏈路：

| 層 | 改法 | 檔案 |
|---|---|---|
| 資料庫 | `relay.roster` 加 `engine` 欄位；`irori_relay_roster` 收 `engine`（格式 `^[a-z][a-z0-9_-]{0,19}$`，不對就當 null，不拒整份名單）；`irori_relay_list(uuid)` 回傳 `engine`。可重複執行、只加欄位 | `supabase/sql/19_roster_engine.sql` |
| 仲介函式 | roster 動作多帶 `engine` | `supabase/functions/irori-relay/index.ts`、`_shared/roster.ts` |
| 後端 API | 視窗聯絡人的 `kind` 依 engine（gemini→gemini、codex→gpt、grok→grok、不認得→other、沒帶→claude）並多一個 `engine` 欄位；給使用者看的聯絡人清單寫成「Gemini 背景工作者」，狀態 `login-required`／`quota` 講明白 | `supabase/functions/irori-api/relay.ts` |
| 前端 | 非 Claude 視窗的頭像加引擎角標、詳細頁多一行「種類：Gemini 背景工作者（由電腦啟動，不是開著的視窗）」、狀態字（需要登入／額度用完） | `web/js/phone/engine_logic.js`、`app_chat.js`、`web/style.css` |

**部署順序**（這次沒做）：① 跑 `npx supabase db query --linked -f supabase/sql/19_roster_engine.sql` → ② 部署 `irori-relay`、`irori-api` 兩個函式 → ③ 部署前端。SQL 先上線時舊函式照常運作（只是沒有 engine）；前後端對沒有 engine 的資料（舊版機器橋）完全維持原樣。回復：重跑 `04_roster.sql`、`16_tenants.sql` 裡的同名函式（欄位留著無妨）。

另外橋與仲介的對接有兩個小改動（都向下相容）：`onReply(視窗, 內文, 信件id)` 多一個選用的信件編號（工作者同時有好幾封在處理，不能再靠先進先出猜這則回覆是回哪一封；Claude 轉接器不帶，行為不變）；名單上的視窗可標 `noFallback`（背景工作者不代收「沒指定收件人」的信）。

### 9.7 這次的實測（真 agy 1.2.16，`irori-probe` 暫存資料夾，環境白名單、無任何金鑰）

| 項目 | 結果 |
|---|---|
| Gemini 工作者上線（agy-stream），名單 `Gemini`／`engine_label gemini` | OK |
| 送「自我介紹」→ 回「我是由 Irori 收發室啟動的背景工作者「Gemini」，目前以唯讀身分…」 | OK（回覆約 3～5 秒） |
| 工作資料夾讀 `note.txt` | 回 KIWI |
| 要它直接寫資料夾外的檔案 | 模型自己回「做不到，我目前是唯讀狀態」；檔案不存在 |
| 絆線（不附說明、直接要求 `write_to_file`）3 次 | 3/3 在檔案寫成前殺掉 agy，回報違規 |
| 橋重啟（停掉引擎再起一個）後問「剛剛讀的檔案裡 secret-fruit 是什麼」 | 答 KIWI（resume 成功） |
| 備援：同一支 agy 走社群 ACP 包裝（標準 ACP 驅動） | 自我介紹、讀檔 OK；重啟後答「沒讀過」（`loadSession:false`，符合預期，log 會寫「先前的對話找不到了」） |
| 接上真的 `bridge.mjs`（假仲介＋假 agy，`acp-bridge.test.mjs`） | 名單帶 `engine:"gemini"`；回覆帶 `reply_to`、`from_agent:"Gemini"`；沒登入回「轉交給 Gemini 失敗：需要登入」；詢問信／允許信各寄對地方 |

沒實測：**真的登入失效與額度用完的錯誤文字**（不能弄壞使用者的登入）——偵測靠 agy 回報格式（`result.status=ERROR`＋`error`）與關鍵字，遇到沒涵蓋的措辭會被當成一般錯誤（照樣回報給寄件人，只是名單不會標 `login-required`）；**真能送權限請求的 ACP agent**（只用假 ACP agent 驗證流程）；**收件夥伴收到詢問信後在手機上問你、再替你回信**這一段（程式端的詢問、解析、放行、逾時都有測試，但夥伴的轉述與回信要上線後觀察）；官方 Grok Build。

### 9.8 風險

1. **agy 寫檔無法預防**（9.2）：只有絆線。所以工作資料夾一定要是專用空資料夾，不要放有價值的檔案；agy 設定 `allowNonWorkspaceAccess` 是使用者全域的，我們不改。
2. **讀檔無法限制**：工作者可以讀到使用者帳號讀得到的任何檔案，回信內容會寄給寄件人。寄件人是 `trust=member` 以上的節點，信任邊界等同「能對這台電腦的 Claude 視窗發信的人」。提示注入（信件內容叫它去讀機密）靠角色說明與寄件人信任，不是強制。
3. **`execute:allow` 等於放行一切**（agy 只有一個總開關，同時放行寫檔與上網，只剩絆線檢查寫檔／上網）。非必要不要開；要用就用 `ask`（事後問）。
4. **每輪成本**：agy 每輪即使很短輸入約 1.2 萬 token（系統提示加工具定義）；對話一直累積，沒有自動換新對話（要重來就刪 `acp-workers.json` 裡該工作者的 session）。
5. **橋異常結束**：已收下（已 ack）但還沒回覆的信不會重做；寄件人會在 10 分鐘後收到「沒有回覆」通知（橋的既有機制）。
6. **第三方程式碼**：主線不依賴任何第三方套件；備援用社群包裝時要釘版本（我讀的是 2.0.1，MIT，2 個依賴，無安裝腳本），它會用外層行程的完整環境啟動 agy，所以一定要由我們的白名單環境啟動它（驅動已這樣做）。
7. **Google 條款**：把官方 `agy` 當本機子行程、沿用其快取登入屬支援用法（見第 3 節）；不抽取憑證。用量與互動使用共用同一份額度。
8. **授權詢問走一般信件**：被問的節點回信必須寫給工作者本人；`from_agent` 可由對方節點自填，所以 `ask.notify` 寫節點（`{"node":"PC1"}`）比綁定視窗名穩；詢問內容會經仲介傳送（已遮蔽疑似金鑰，但檔名、指令摘要會出現在信裡）。
9. **同名衝突**：工作者名不可與 Claude 視窗同名（先載入的引擎優先）。

## 10. 來源

**ACP**
- [ACP 簡介](https://agentclientprotocol.com/overview/introduction)、[文件索引 llms.txt](https://agentclientprotocol.com/llms.txt)、[session setup](https://agentclientprotocol.com/protocol/session-setup)、[session list (v2)](https://agentclientprotocol.com/protocol/v2/session-list.md)、[Streamable HTTP／WebSocket RFD](https://agentclientprotocol.com/rfds/streamable-http-websocket-transport.md)
- [ACP 登錄表（網頁）](https://agentclientprotocol.com/get-started/registry.md)、[登錄表 JSON](https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json)、[registry 倉庫](https://github.com/agentclientprotocol/registry)
- [協定倉庫](https://github.com/agentclientprotocol/agent-client-protocol)、[TypeScript SDK](https://agentclientprotocol.com/libraries/typescript)
- [Zed：External Agents](https://zed.dev/docs/ai/external-agents)、[Zed ACP](https://zed.dev/acp)
- [claude-agent-acp](https://github.com/agentclientprotocol/claude-agent-acp)、[ToS 疑問 issue #337](https://github.com/agentclientprotocol/claude-agent-acp/issues/337)、[codex-acp（舊倉庫，已封存）](https://github.com/zed-industries/codex-acp)
- [acpx：無頭 ACP 用戶端 CLI](https://github.com/openclaw/acpx)

**AgentAPI**：[coder/agentapi](https://github.com/coder/agentapi)（已封存）

**Claude Code**
- [法務與合規：認證與憑證使用](https://code.claude.com/docs/en/legal-and-compliance)
- [Agent SDK 概覽（含「不准第三方提供 claude.ai 登入」註記）](https://code.claude.com/docs/en/agent-sdk/overview)
- [Channels](https://code.claude.com/docs/en/channels)
- [跨 session 訊息（第三方說明）](https://claudefa.st/blog/guide/mechanics/cross-session-messaging)、[#99049 要求不經模型的 send CLI](https://github.com/anthropics/claude-code/issues/99049)

**Gemini／Antigravity**
- [Headless mode](https://antigravity.google/docs/cli/headless/)、[Remote Control](https://antigravity.google/docs/remote-control/)、[IDE extensions](https://antigravity.google/docs/ide/extensions)
- [Google 論壇：外部協調 agy 無頭模式](https://discuss.ai.google.dev/t/is-external-orchestration-of-antigravity-cli-headless-mode-supported-with-account-based-usage/183051)
- [Gemini CLI ACP 模式](https://geminicli.com/docs/cli/acp-mode/)
- [sibbl/google-antigravity-acp](https://github.com/sibbl/google-antigravity-acp)、[dongitran/agy-agent-acp](https://github.com/dongitran/agy-agent-acp)、[agy-remote](https://pypi.org/project/agy-remote/)

**Grok**：[Grok Build 概覽](https://docs.x.ai/build/overview)、[無頭與腳本](https://docs.x.ai/build/cli/headless-scripting)、[Sessions](https://docs.x.ai/build/features/sessions)、[xai-org/grok-build](https://github.com/xai-org/grok-build)、[發表文](https://x.ai/news/grok-build-cli)

**pi**：[earendil-works/pi](https://github.com/earendil-works/pi)、[coding-agent README](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/README.md)、[rpc.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md)、[providers.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/providers.md)、[Wikipedia：Pi (AI agent)](https://en.wikipedia.org/wiki/Pi_(AI_agent))（本機另讀了套件內附的 `docs/` 與 `examples/extensions/file-trigger.ts`）

**多 agent 工具**：[claude-squad](https://github.com/smtg-ai/claude-squad)、[vibe-kanban](https://github.com/BloopAI/vibe-kanban)與[停運公告](https://vibekanban.com/blog/shutdown)、[Crystal](https://github.com/stravu/crystal)、[Orca](https://github.com/stablyai/orca)與[orca-cli 指南](https://github.com/stablyai/orca/blob/main/skill-guides/orca-cli.md)、[OpenHands](https://github.com/OpenHands/OpenHands)與[ACP agents 文件](https://docs.openhands.dev/openhands/usage/agent-canvas/acp-agents)、[happy](https://github.com/slopus/happy)
