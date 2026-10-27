# 內建收發室橋：其他引擎（Gemini／ACP 與 Codex）

issue #12 內建橋第五期。`BRIDGE-RUST.md` 的第一至四段讓 ASN 內建橋能替 Claude 視窗收信、轉交、寄回；這一期讓同一座橋也能投遞給 **ACP 背景夥伴**（Gemini CLI 的 `--experimental-acp`、Antigravity `agy` 等）和 **Codex 視窗**，行為對齊舊 Node 橋（`relay/machine/bridge.mjs` 與 `engines/acp*.mjs`、`engines/codex*.mjs`）。目標：工作機換成內建橋之後，名單上的 Gemini、Codex 夥伴照樣收得到信、回得了信，名單回報的引擎名正確。

## 1. 各引擎怎麼投遞

| 引擎 | 名單從哪來 | 怎麼把信交給對方 | 回覆怎麼回來 |
|---|---|---|---|
| Claude（原本的） | `~/.claude/sessions/<pid>.json` | 收發室 worker（`claude -p`）呼叫 `SendMessage` | worker 輸出的 `<<REPLY-…>>` 區塊 |
| ACP 背景夥伴（`engines/acp*.rs`） | `~/.asn/agents.json`（與舊橋同一份）列的工作者；起得來的才列 | 橋替每位工作者長駐一個子程序，信排進該工作者的佇列，一次送一輪（標準 ACP：`initialize` → `session/new`／`session/load` → `session/prompt`；agy：stream-json） | 該輪的最後文字，由橋帶 `reply_to` 以工作者名寄回 |
| Codex（`engines/codex*.rs`） | `~/.codex/session_index.jsonl`（有名字的 thread）∩ `thread-writer-locks/`（正被某個行程開著） | `codex queue --thread <id> --message=<信>`：寫進 Codex 佇列，持有該 thread 的視窗閒下來就當成使用者訊息處理 | 唯讀的 `codex app-server` 輪詢 `thread/turns/list`，找到含 `irori-mail:<信件編號>` 的 turn，等它結束取最終回答 |

共同規則（與 Claude 一致，核心 `core.rs` 不分引擎）：

- 引擎回報「已轉交」（`Sent`）核心才 ack 並開始計時；失敗（`Fail`）寄 `[收發室] 轉交給 … 失敗：<原因>` 給寄件人；回覆（`Reply`）依信件編號對上 pending，找不到就轉給最近一次交辦的人。
- 逾時、忙碌延後、遲到回覆、不需回覆（`reply=no`）、收發室系統信不回、`asn send --reply-to` 直接回覆的記號，全部沿用核心既有流程。
- 名單狀態：`idle`／`busy`；ACP 工作者沒登入或額度用完標 `login-required`／`quota`，Codex 標 `login-required`／`limit`（核心的忙碌判斷只認 busy／working／running，標示用狀態不會被當成忙碌而延後通知）。
- 名單回報與夥伴同步的引擎名：ACP 工作者用設定檔的 `roster_engine`（例如 `gemini`），Codex 是 `codex`，Claude 是 `claude`。信件抬頭 `engine=` 也用同一個名字。
- Codex 視窗的夥伴 ID 同步帶 thread id 當 session 編號（視窗改名、換電腦後仍認得是同一位）。

## 2. 模組

`relay/asn/src-tauri/src/bridge/engines/`：

| 檔案 | 內容 | 對應舊橋 |
|---|---|---|
| `mod.rs` | `Engine` 介面、事件（`Sent`／`Fail`／`Reply`／`RosterChanged`）、`EngineSet`（名單快取＋背景重列）、`PidBook`（記下自己開的子程序）、孤兒清理、子程序環境過濾 | `engines/index.mjs` |
| `rpc.rs` | 一行一則 JSON 的子程序通道：無視窗、`env_clear`、請求逾時、行程結束時讓等待中的請求失敗 | `acp-client.mjs`／`codex-rpc.mjs` 的行程管理 |
| `acp_client.rs` | 最小 ACP 用戶端（收集 `agent_message_chunk`、回應 `session/request_permission`） | `acp-client.mjs` |
| `acp_config.rs` | `agents.json` 讀取與檢查（壞條目只跳過那一條） | `acp-config.mjs` |
| `acp_policy.rs` | 權限政策（read／write／execute／network／other × allow／deny／ask、白名單資料夾）、錯誤分類、摘要遮蔽金鑰 | `acp-policy.mjs`、`acp-errors.mjs` |
| `acp_approvals.rs` | 「問我」授權簿 | `acp-approvals.mjs` |
| `acp_worker.rs` | 一位工作者：佇列、驅動、政策、問人、健康狀態、session 記憶 | `acp-worker.mjs` |
| `acp.rs` | ACP 引擎（含標準 ACP 驅動） | `acp.mjs`、`acp-driver-acp.mjs` |
| `acp_agy.rs` | agy 原生 stream-json 驅動（絆線） | `acp-driver-agy.mjs` |
| `codex.rs`、`codex_state.rs` | Codex 引擎；讀 `~/.codex` 的名單、鎖檔、權限設定 | `codex.mjs`、`codex-state.mjs`、`codex-bin.mjs` |

核心只多了：`Window` 帶 `engine`／`engine_label`／`no_fallback`（`roster.rs`）、`Core` 依視窗的引擎分流投遞（`core.rs` 的 `deliver`）、`on_engine_event`、`run_loop` 多收一條引擎事件通道（`mod.rs`）。**沒有任何非 Claude 引擎被載入時，行為與第四段完全相同**（既有測試只因 `Window` 多了欄位而改了建構寫法，預期都沒動）。

## 3. 設計決定

1. **載入規則**：沒設 `ASN_ENGINES`（舊名 `IRORI_ENGINES`）時自動判斷——`agents.json`（或 `ASN_AGENTS_FILE`）存在才載 ACP、`~/.codex`（或 `CODEX_HOME`）資料夾存在才載 Codex。設了就照它（逗號分隔的 `acp`、`codex`；Claude 一律載入，`ASN_ENGINES=claude` 即關掉其他引擎）。舊橋預設只載 Claude、靠 `run-bridge.ps1 -Engines` 開；內建橋改成自動，是因為換手後使用者不該再去改啟動參數。環境變數名稱改為 `ASN_*`，舊名 `IRORI_*` 照樣能用（#14 第一期，見 ONBOARDING 第 5 節與 `envc.rs`）。
2. **設定與狀態沿用舊檔**：`agents.json`、`machine-<ID>/acp-workers.json`（各工作者的 session 編號，換橋後接續同一段對話；指令或協定換了就不沿用）。換手時使用者不用搬任何東西。
3. **子程序一律無視窗＋乾淨環境**（守門測試 `守門_引擎的每個子程序都先清環境…`）：
   - ACP（兩種驅動）：`env_clear` 後只套用白名單（`PATH`、`USERPROFILE`、`HOME`、`APPDATA`…），不帶任何 `*_KEY`／`*_TOKEN`；設定檔 `env_pass` 列的才多帶，且名稱像金鑰的會被拒絕。登入狀態讀各 CLI 自己的憑證檔。
   - Codex：`env_clear` 後套用過濾清單——清掉 `OPENAI_API_KEY`／`CODEX_API_KEY`（帳務要走使用者的 ChatGPT 登入額度）、繼承來的 `CODEX_THREAD_ID` 等視窗識別、`NO_COLOR`、`CLAUDE*`、仲介金鑰；保留 `CODEX_HOME`。
4. **只關自己記下的 PID**：每個引擎子程序的 PID 寫進 `machine-<ID>/engine.pids`，結束時劃掉；ASN 正常結束只停這些（先關 stdin 讓對方收尾，1.5 秒後仍在才強制結束並連子孫一起收，Windows 上 codex 是 node 包原生程式）。ASN 被硬砍後，下次啟動只關「帳本記著、仍活著、父程序是上一個橋」的子程序。不用名稱比對、不 `taskkill /IM`。
5. **名單不卡住收信**：各引擎的名單由背景任務每 `ASN_ROSTER_MS`（預設 60 秒）重列並快取，核心回報名單時只讀快取；名單有變（新增／消失／狀態／引擎名）立刻補報一次。啟動時第一次回報最多等 8 秒讓引擎先列一次，才不會把 Gemini、Codex 漏在第一份名單外。Codex 讀名單可能要啟動 `codex app-server`，慢不會拖住門鈴與輪詢。
6. **預設代收者**：沒指定收件人且預設視窗不在線時，ACP 背景工作者**不代收**（`no_fallback`，同舊橋）；Codex 視窗可以（依 `updatedAt` 排最近有活動的）。
7. **往來記錄路徑行**（#108 的 `corrlog`）：ACP 工作者只能讀自己的工作資料夾，讀不到 `~/.asn/handoff`，所以信件最後不附那一行；記錄本身照常寫。Claude、Codex 照舊附。
8. **Codex 轉交一次一封、依收到的順序**：`codex queue` 由單一任務依序執行，對方視窗才會照順序處理；回覆帶著信件編號（`Reply.mail_id`），同一視窗連續兩封不會串（舊橋靠先進先出猜）。
9. **登入／額度失敗後換新驅動**：ACP 工作者回報 `auth`／`quota` 後把驅動停掉，下一封重新啟動——使用者在終端機登入好之後，新啟動的行程才讀得到新的登入狀態。
10. **Codex 的安全閘門不放寬**：視窗是「完全存取（沒有沙盒）」或讀不到權限設定一律不轉外部來信（fail-closed），`ASN_CODEX_ALLOW_FULL_ACCESS=1` 才放行；信太長（預設 12000 字，命令列放不下）直接失敗；額度用完、沒登入在轉交時明確回報，不無聲失敗。
11. **Windows 鎖檔判斷不開 PowerShell**：舊橋用 PowerShell 試開鎖檔判斷誰在用；內建橋直接以共用模式 0 開檔（`ERROR_SHARING_VIOLATION` 即持有中），少一個子程序、不閃視窗。非 Windows 只看檔案在不在。

## 4. 跟舊橋的行為差異

| 項目 | 舊橋 | 內建橋 |
|---|---|---|
| 引擎載入 | 預設只有 claude，靠 `-Engines` | 自動（見上）；`ASN_ENGINES` 可限縮 |
| Codex 回覆對應 | 不帶信件編號，核心先進先出 | 帶信件編號，精確對上 |
| 標準 ACP 的指令不存在 | 回報一般錯誤，工作者仍留在名單上 | 與 agy 一樣標為不可用、不列名單，約每分鐘重試一次 |
| 登入／額度失敗後 | 沿用同一個驅動 | 換新驅動（見 3-9） |
| Codex 額度用完的訊息 | 「約 HH:MM 重置」（本機時區） | 「約 N 小時 M 分後重置」（不依賴時區） |
| ACP 工作者收信的往來記錄路徑行 | 有 | 沒有（見 3-7） |
| 鎖檔判斷 | PowerShell | 直接開檔 |

## 5. 這一期沒搬的

- **遠端開 Codex 視窗**（舊橋 `openWindow`：建 thread 再 `codex resume`）與**遠端開 Gemini／Grok 背景夥伴**（`partner-background.mjs`、launcher 的背景 profile）：屬於 launch／#82 的範圍，名單與投遞不依賴它們。工作機上已經開著的 Codex 視窗與 `agents.json` 裡的工作者照常運作。
- **Codex 視窗裡的身分判定**（`CODEX_THREAD_ID` → `asn send`／`recv`）：`asn-cli` 還認不得 Codex 視窗，Codex 視窗**回信靠橋自動寄回最終回覆**即可，主動寄信要等 CLI 補上。
- 動態加工作者（`addPartnerWorker`）：隨遠端開背景夥伴一起處理。

## 6. 切換工作機前要注意

1. 工作機要先把舊 Node 橋與它的工作排程停掉（設定頁「改由 ASN 負責」，需 `allow_takeover` 放行並按確認）；內建橋拿不到 `bridge.pid` 鎖時不會啟動。
2. 確認 `%USERPROFILE%\.asn\agents.json` 還在；Gemini 工作者的 `command` 要在 ASN 行程的 `PATH` 找得到（從工作排程或開機啟動的 ASN，PATH 可能比互動終端機少，必要時在 `agents.json` 寫完整路徑）。
3. Gemini 要保持登入：ASN 是背景程式，不會替它開瀏覽器登入；失效時寄信會收到「需要登入…請到這台電腦前登入」並在名單標 `login-required`。
4. Codex 要在 `~/.codex`（或 `CODEX_HOME`）有資料、版本 ≥ 0.154（已驗證 0.154.0）；視窗要先 `/rename` 取名才會列入名單，且必須是**普通沙盒**（完全存取的視窗不收外部來信）。Codex 預設沙盒沒有網路，視窗裡的程式連不上仲介，所以回信一律走橋自動寄回。
5. 換手後先看 `machine-<ID>\bridge.log` 的 `acp:`、`codex` 開頭的行：設定錯誤、跳過的條目、版本不符、起不來的原因都記在這裡。
6. 想回到舊行為：把 `ASN_ENGINES=claude` 設在 ASN 的環境，或停掉內建橋、重新啟動舊橋（`bridge.pid` 的鎖會自動讓出）。

## 7. 測試

- 單元：政策與錯誤分類、授權簿、設定、環境過濾、PID 帳本、Codex 的名字索引／鎖檔／權限讀取（含長對話分段回讀與 Windows 共用模式）。
- 整合（`bridge/tests/engines_it.rs`）：用 node 寫的假程式（`relay/machine/test/fake-acp-worker.mjs`、`fake-agy.mjs`、`fake-codex.mjs`）接上真的核心與 127.0.0.1 的假仲介，涵蓋收信回覆、政策、問人、登入／額度、逾時、崩潰、重啟接續對話、Codex 轉交與安全閘門、三種引擎共存、以及 `start()` 整條路徑與結束時只關記下的子程序。全程不啟動真的 claude／gemini／agy／codex，不碰真實的 `~/.claude`、`~/.codex`、`~/.gemini`、`~/.asn`。
- 守門：每個引擎子程序都先 `env_clear`、ACP 與 Codex 的環境一定先過濾（已做還原驗證：拿掉任一處測試會紅）；既有的「背景子程序一律 `.no_window()`」掃描器自動涵蓋 `engines/`。
