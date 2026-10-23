# ASN Linux 版（無視窗）規劃

狀態：規劃（勘查日 2026-10-23，未部署）。階段 0 的第一步「核心不連 Tauri 也能編譯執行」已實作，見最前面的「實作進度」。

## 0. 實作進度

階段 0 第一步（分支 `feat/headless-p0`）：

- `Cargo.toml` 新增功能旗標 `gui`（預設開）。`tauri`、`tauri-build`、各 Tauri 外掛都改成可選相依，掛在 `gui` 底下；Windows 與安卓照舊（預設開 `gui`，相依與設定不變）。
- 新增 `crate::rt`（`src/rt.rs`）：`spawn`／`block_on`／`JoinHandle`。有 `gui` 時原樣轉呼叫 `tauri::async_runtime`；沒有時用自己的 tokio 多執行緒執行環境。`bridge/`、`engines/`、`relay.rs` 全改用它，核心不再 use tauri（守門測試 `headless::tests::核心模組不得直接用_tauri` 掃原始碼）。
- `build.rs`：沒有 `gui` 時不呼叫 `tauri_build`，只補上原本由它宣告的 `desktop` 條件。
- `lib.rs`：視窗、系統匣、invoke 指令、更新器、截圖、語音等模組與指令都掛 `#[cfg(feature = "gui")]`；`agent_tools`、`claude_mod`、`claude_accounts`、`codex_accounts` 這類「邏輯與指令混在一起」的檔案，指令改成 `cfg_attr(feature = "gui", tauri::command)`。
- 新增 `Config.engine_only`（僅引擎模式）：不啟動 `claude -p` 收發室 worker；沒指定收件人的信照既有規則交給預設成員（`ASN_RELAY_DEFAULT_AGENT` 或 `bridge.json` 的 `unaddressed_to`）。測試：`bridge::tests::只有引擎模式_…`。
- 新增執行檔 `asn-bridge`（`src/bin/asn_bridge.rs`，主體在 `src/headless.rs`）：`asn-bridge run [--engine-only]`、`--version`、`--help`。資料夾解析沿用 `home.rs`（與 `relay/machine/home.mjs` 同一套規則）；結束碼 0／2（設定錯）／3（另一個收信者在跑）。無視窗模式關閉主控台切換、UI 自動化、遠端開視窗、系統匣，並在 log 記一行。
- TLS：Linux 一律改用 `rustls-tls-webpki-roots`（同安卓，不用 OpenSSL）。**注意：這會改變 Linux 電腦版（deb／AppImage）的憑證驗證來源**（由系統憑證改為內建根憑證）；Windows 與 macOS 維持系統內建加密連線。若要讓 Linux 視窗版繼續用系統憑證，要另拆功能旗標，需評估安卓建置（預設功能會一併開啟）。
- 驗證：`cargo check --no-default-features --bin asn-bridge`、預設 `cargo check`、`--target x86_64-unknown-linux-gnu`（本機沒有 Linux C 交叉編譯器，`ring` 的建置腳本需要 C 編譯器，檢查時以假的 CC／AR 略過；真正連結留給 CI 的 ubuntu 與 musl）。Linux 目標的相依樹不含 tauri／webkit／openssl。
- 尚未做：Aegis 引擎、收件匣模式、`asn-cli inbox`、CI 的 musl 建置與靜態連結檢查、`--check`（preflight）、任何部署。

## 1. 目標

做出「ASN 的 Linux 版（無視窗）」：同一份 Rust 程式，取代兩份 Node 實作，以後只維護 Rust 一份。

| 要取代的 | 現在在哪 | 取代後 |
|---|---|---|
| Node 機器橋 `relay/machine/bridge-aegis.mjs` | Aegis 主機（GCP `aegis-tokyo`），systemd | Rust 無視窗橋的 Aegis 引擎 |
| 雲端代理 `relay/cloud-agent/`（recv.mjs 等） | xAI Grok Bot 的雲端沙盒（不是我們的 GCP VM） | Rust 無視窗橋的「收件匣模式」 |

不在範圍：Windows／安卓版行為不變；Claude 視窗橋（`bridge.mjs`，Windows 家用機／工作機）已由內建橋取代中，不屬本案。

## 2. 勘查結果（證據）

### 2.1 Aegis 主機（唯讀）

直連 SSH 逾時，要加 `--tunnel-through-iap` 才連得上（家用機的慣例）。所有指令都是唯讀，沒印任何金鑰值。

| 項目 | 結果 | 證據（指令與輸出重點） |
|---|---|---|
| 主機 | `aegis-tokyo`，asia-northeast1-a，e2-standard-4，RUNNING | `gcloud compute instances list` |
| 作業系統 | Ubuntu 24.04.4 LTS，x86_64，核心 6.17.0-gcp，glibc 2.39，4 核、16 GB、磁碟 96 GB 用 59% | `uname -m`、`/etc/os-release`、`ldd --version`、`free -m`、`df -h /` |
| 單元名 | `irori-relay-aegis.service`（enabled，active running，NRestarts=0，自 2026-10-21 00:56 UTC 起沒重啟） | `systemctl list-units`、`systemctl show` |
| ExecStart | `/opt/node22/bin/node /home/cwen0708/asn/relay/machine/bridge-aegis.mjs`，User=cwen0708，Restart=on-failure，RestartSec=15，RestartPreventExitStatus=3 2 | `systemctl cat irori-relay-aegis` |
| 單元環境變數 | `IRORI_RELAY_ID=aegis`、`IRORI_RELAY_URL`（新後台 etccgmkrosbzpltudlgt）、`IRORI_AEGIS_ALLOW=`十個成員 slug（aegis,xiao-liang,xiao-yin,xiao-mu,hen,li-li,xiao-hui,xiao-wen,xiao-zhen,xi-xu） | 同上；行程環境變數名稱（只看名稱）僅有這三個 `IRORI_*` 加系統變數 |
| 跑的程式碼 | **已經不是 `~/irori` 的副本**：`/home/cwen0708/asn`，git 倉庫，`origin = https://github.com/Yooliang/asn.git`，分支 main，HEAD `cc25c4b`（2026-10-21 Merge PR #53 handoff-1021），工作樹乾淨。`/home/cwen0708/irori` 舊資料夾仍在（無人使用） | `git -C … rev-parse/remote/log/status` |
| Node | 單元用 `/opt/node22/bin/node` v22.20.0；系統預設 `node` 是 v20.20.1（別混） | `node -v` |
| 工作資料夾與 log | `~/.irori-relay/aegis-aegis/`（`bridge.log`、`bridge.pid`）。**用的還是舊家目錄 `~/.irori-relay`**，`~/.asn` 不存在（`home.mjs` 的回退行為）。Rust 版預設會找 `~/.asn`，部署時要處理 | `ls -la ~/.irori-relay`、`~/.asn`（不存在） |
| 設定檔（只列檔名） | `~/.irori-relay/aegis.key`（43 位元組，600）、`anon.key`（208，600）、`anon.key.old-irori`、`anon.key.old-wiiq`。沒有 `.env`、沒有 `agents.json`；全部其餘設定在 systemd 單元的 `Environment=` | `ls -la`（未讀內容） |
| 運作量 | 近日 log：`doorbell joined` 330 次、`status=success` 54 次、`blocked` 2 次；門鈴約每數小時斷線 1 次、1 秒內自動重連；偶有 `members fetch failed: timeout` | `grep -c` bridge.log |
| 工具鏈 | **沒有 Rust**（無 `~/.cargo`、無 `rustup`），有 gcc／build-essential；沒有 `libssl-dev`、`pkg-config`；從 Aegis 連 `static.crates.io` 回 403（不影響，只是別在 Aegis 上編） | `which rustc cargo`、`dpkg -l`、`curl` |
| 同機其他服務 | `aegis.service`（uvicorn FastAPI，WorkingDirectory `/home/cwen0708/onestack/aegis`）、`aegis-worker`、`aegis-heartbeat-l2`（failed，與本案無關）、GitHub Actions runner（OneStack 用） | `systemctl list-units` |

### 2.2 橋怎麼把信「送給」Aegis 成員（重點：不是 Claude 視窗，是 Aegis 的 API）

`bridge-aegis.mjs` 不開 `claude`、不碰視窗，只是把仲介（relay）上的信翻成 Aegis 本機 API 呼叫，再把回答寄回。介面如下。

| 面向 | 做法 |
|---|---|
| 接口 | 同機 `http://127.0.0.1:8899`（`IRORI_AEGIS_URL`）。**本機免認證**（沒有權杖／標頭；靠只聽本機）。主程式是 `aegis.service` 的 uvicorn（`--fd 3`，由 systemd socket 交給它） |
| 問成員 | `POST /api/v1/agent-chat/ask`，JSON `{target: <成員 slug>, question, from_member:"xi-xu", stream:false}`；同步等待，逾時 300 秒（`IRORI_AEGIS_TIMEOUT_MS`）。回 `{answer, member, member_name, status("success"/"tool_pending"/"error"/"streaming"), token_info, tool_calls}`。Aegis 端用常駐 PTY 程序池復用成員 session（註解：30 分鐘 TTL），成員綁的帳號與模型由 Aegis 自己決定（成員清單看得到 `provider: claude`、`accounts[]`）。**不是推送、不是串流**，是一信一次同步呼叫 |
| 成員名單 | `GET /api/v1/members?scope=all`，回 JSON 陣列，每筆有 `slug`、`name`（中文名）、`provider`、`accounts` 等。橋取 `slug→name` 對照表；啟動時載一次（收信前要等它載完），之後每 60 秒隨 roster 重載。我實測此 API 現在回 200 |
| 認證（橋對 relay 後台） | 節點金鑰（檔 `aegis.key`）放 `x-relay-key` 標頭；anon 金鑰只用於 Realtime 門鈴（`anon.key`）。**橋對 Aegis 本身沒有認證** |
| 收信 | Realtime 門鈴（WebSocket）＋每 2 分鐘補拉 inbox（`ASN_RELAY_POLL_MS`）。有門鈴所以多半即時 |
| 白名單 | `IRORI_AEGIS_ALLOW`（slug）；空＝全擋。名單外寄回「這位成員沒有開放聯絡」。`IRORI_AEGIS_SELF`（預設 xi-xu）不列名單、也不能被問 |
| 收件人對應 | `to_agent` 可寫 slug 或中文名（`resolveSlug`）；沒寫 → 預設成員 `IRORI_AEGIS_DEFAULT`（預設 `aegis`，需在白名單內），否則寄回「請指定要問的成員」附白名單 |
| 問題包裝 | 內文前加一行 `這是透過仲介轉來的信：from=<節點>/<視窗> trust=<trust>` |
| 重試／失敗 | `status=error`／連線失敗／HTTP 5xx → 等 60 秒（`IRORI_AEGIS_RETRY_MS`）重試一次，仍失敗回「[Aegis] 對方忙線中，請稍後再問」；HTTP 404 回「查無此成員」不重試；其他 status 照實回報 |
| 回信 | `send`（`to_node`＝寄件節點、`to_agent`＝寄件視窗、`reply_to`＝原信 id、`from_agent`＝`displayName(slug)`＝中文名，沒有才用 slug，與 roster 回報的視窗名一致，對方才看得到同一個視窗回信）。**寄回成功才 ack**；寄回失敗不 ack，等下次補拉再處理 |
| 名單 roster | 每 60 秒 `POST roster`，只列白名單成員（排除 SELF）：`{name:中文名, status:'idle', cwd_label:slug}`。節點需 `can_roster`，否則 403 只記一次 |
| 群組（rooms） | 被點名／主人發問才問；同一個 ask API，用 `roomText(room,msg)` 組問題；失敗不發言；`rooms.post(room, answer, 視窗名)` 回覆 |
| 去重 | 記憶體 `seen`（已 ack）＋`inflight`（處理中）；同一個節點金鑰只能一個收信者，`bridge.pid` 單一執行個體鎖（exit 3） |

### 2.3 Grok 雲端

**結論：沒有可勘查的 GCP VM。** Grok 雲端不是我們的 VM，是 xAI「Grok Bot」平台提供的雲端沙盒。證據：

- `gcloud compute instances list` 的 17 台（專案 greenshepherdcomtw）沒有任何一台是 Grok；`policy-verifier-*`、`aegis-*`、`td-*` 等都是別的用途。
- `relay/cloud-agent/README.md`：根目錄 `/workspace`、Grok 夥伴目錄 `/home/box/agent-data/agents`、金鑰由平台秘密變數 `ASN_RELAY_KEY` 注入（「你看不到它的值」）、環境「會被重置、只能往外連」、「boot.sh 重置後會重跑」、例行任務 webhook 只能在 Grok Bot 電腦版 app 設定。
- `install-cloud-node.sh` 在 `/workspace/.node` 自己裝 Node 22（`uname -m` 對 x64／arm64 兩種都處理），產生 `relay.env`（只有路徑）與 `start.sh`；`boot.example.sh` 每次重置後重裝 Node、再 `nohup setsid node recv.mjs`。
- 另外 README 開頭註明：新的雲端代理**不用這份程式**，改讀官網技能 `asnmessenger.web.app/skill/asn-cloud-agent.md`，在代理自己的電腦上產生收寄信腳本；這份只留給現有 Grok 節點。

**Grok 雲端的形態不是「引擎」，是「收件匣節點」**（與 Aegis 不同）：

- `recv.mjs` 只做：門鈴＋每 2 分鐘補拉 → 每封信先寫進 `inbox.jsonl` 並 fsync → 成功才 ack（以信件 id 去重，重啟靠檔案重建）→ 每 60 秒回報 roster（掃 `/home/box/agent-data/agents/<uuid>/profile.json` 的 `name`，與 `agents.json` 合併）。
- **沒有任何東西替 Grok 回信**：Grok（AI 本體）自己在例行任務裡用 `inbox.mjs` 讀信、用 `send.mjs --reply-to … --reply|--no-reply` 回信。橋只是郵差。
- `dispatch-watch.mjs`（即時喚醒 Grok 的觀察者）仍在 draft PR #4，沒進 main。
- 所以 Rust 要做的是：同一種「收件匣模式」常駐程式（寫 `inbox.jsonl` 相容格式）＋ 命令列（讀信／標記處理／寄信）。**寄信、讀信的命令列 `asn-cli send/recv/room/attach` 已經有 Rust 版**，缺的是常駐收信存檔與 Grok 夥伴掃描。

沒辦法確認的事（要試了才知道，列為階段 0 的驗證）：Grok 沙盒能不能執行下載來的 Linux 二進位檔、能不能連到下載來源、CPU 架構（`uname -m`）、有沒有外部網路白名單。這些在 Grok 沙盒裡才查得到，我不能從外面看。

## 3. 現況：Rust 內建橋已有什麼（摘自程式）

`relay/asn/src-tauri/src/`：

- `bridge/`：`core.rs`（核心：拉信、轉交、ack、pending 狀態機、逾時、遲到回覆、最近交辦者）、`worker.rs`（長駐 `claude -p` 收發室）、`mail.rs`（信頭格式）、`roster.rs`、`rooms.rs`、`lock.rs`（`bridge.pid` 鎖）、`pending.rs`、`orphans.rs`（孤兒清理，已有 Linux 分支，含 subreaper 處理）、`launcher.rs`（遠端開視窗）、`partner_ops*`、`engines/`（`Engine` 特徵：`list`／`deliver`／`start`／`stop`，事件 `Sent`／`Fail`／`Reply`／`RosterChanged`；已有 `acp`（Gemini／agy）、`codex`）。
- `cli/` 與 `bin/asn-cli.rs`：`send`／`recv`／`room`／`attach`，console 子系統小執行檔，已是 Linux 可編的 Rust。
- `heartbeat.rs`：`pid_alive` 已有 `#[cfg(not(windows))]` 版（讀 `/proc/<pid>`）；`is_asn_process` 也有。`bell.rs`：Realtime 門鈴。
- 已有 `.github/workflows/asn-linux-build.yml`（ubuntu-24.04，裝 webkit2gtk 等後建 deb／AppImage）：**證明桌面版整包在 Linux 能編**，但它是有視窗的 Tauri 版。
- `Cargo.toml`：`asn_lib` 無條件依賴 `tauri`；`reqwest`／`tokio-tungstenite` 在非安卓是 `native-tls`（需要 OpenSSL）；安卓是 `rustls-tls-webpki-roots`（已驗證可用）。`build.rs` 呼叫 `tauri_build::build()`。

## 4. 功能差距

左欄是 Node 機器橋＋雲端代理有的；右欄是 Rust 現況。

| # | 功能 | Node 版 | Rust 內建橋現況 | 缺口與處理 |
|---|---|---|---|---|
| 1 | Aegis 引擎（收信→`POST /agent-chat/ask`→寄回） | `bridge-aegis.mjs` | **沒有** | 新增 `engines/aegis.rs`，實作 `Engine`。見 §5.3 |
| 2 | Aegis 成員名單（`/members?scope=all`，slug↔中文名） | 有 | 沒有 | 併入 aegis 引擎的 `list()`（回 `Window{name:中文名, cwd_label:slug, engine:"aegis"}`） |
| 3 | Aegis 白名單、SELF、預設成員 | `IRORI_AEGIS_*` | 沒有 | 新設定，沿用環境變數名（`ASN_AEGIS_*` 新名，舊名 `IRORI_AEGIS_*` 相容，走 `envc` 的登記表） |
| 4 | Aegis 失敗重試一次＋忙線回覆＋404 回覆 | 有 | 引擎 `Fail` 事件只有失敗原因 | 引擎內自己重試；最終失敗經 `Notice` 以 Aegis 文案寄回（見 §5.3 的「ack 時機」） |
| 5 | 群組（rooms）轉 Aegis | 有 | `bridge/rooms.rs` 有群組邏輯，但只對 Claude 視窗 | 確認 rooms 路徑能交給非 Claude 引擎（機器橋的 `handleRoomMsg` 對應） |
| 6 | **沒有 Claude 也能跑**（不開 `claude -p` 收發室） | Aegis 橋不需要 claude | `start_with` 一定會啟動 `ProcWorker`（`claude`） | **要加「僅引擎」模式**：不產生 worker、`mailbox` 名單為空、`unaddressed` 規則改看預設成員。這是 Aegis／Grok 的關鍵修改 |
| 7 | 雲端代理的收件匣模式（寫 `inbox.jsonl`、fsync 後才 ack、重啟靠檔案去重） | `cloud-agent/recv.mjs` | 沒有 | 新增 `asn bridge --mode inbox`（或獨立子命令）；寫同格式 JSONL 以便 Grok 現有的 `inbox.mjs`／`send.mjs` 過渡期照用 |
| 8 | Grok 夥伴掃描（`/home/box/agent-data/agents/*/profile.json` 的 name，與 `agents.json` 合併） | `grok-agents.mjs`、`config.mjs` | 沒有 | 收件匣模式的 `roster` 來源；路徑沿用 `GROK_AGENTS_DIR`；只讀 `name` |
| 9 | Grok 讀信／標處理／寄信命令（`inbox.mjs`、`send.mjs`） | 有 | `asn-cli send` 有；沒有「讀 `inbox.jsonl`、`--done`」 | `asn-cli inbox [--all\|--json\|--done <id>\|--agent 名]` 新子命令；或讓 Grok 直接改用 `asn recv --once`（改寫技能說明）。**建議保留 `inbox` 子命令做相容** |
| 10 | 身分判定：寄件人視窗名 | `send.mjs --from` 檢查名單 | `cli/caller.rs` 靠 `~/.claude/sessions` 父行程鏈認視窗，雲端沒有 | 在雲端模式加「`--from` 受名單約束」路徑（環境變數 `ASN_CLOUD_AGENT_MODE=1` 時改讀名單，不認父行程鏈） |
| 11 | 路徑與環境變數相容：`ASN_CLOUD_HOME`／`ASN_CLOUD_MAIL_DIR`／`ASN_RELAY_ID`／`ASN_RELAY_KEY` 平台秘密、`relay.env` | 有 | 部分（`ASN_RELAY_KEY` 已有） | 收件匣模式支援同名變數，使 Grok 平台那邊不用改設定 |
| 12 | 金鑰讀取順序：環境變數優先，**有就完全不讀檔、不寫檔** | cloud-agent 有 | 不確定 | 驗證後補；是雲端的硬規則 |
| 13 | 家目錄解析：`ASN_HOME` → `~/.asn` → 舊 `~/.irori-relay` | `home.mjs` | `home.rs` 有（需確認回退行為一致，Aegis 現在實際用 `~/.irori-relay`） | 用 `ASN_HOME` 明指，或在 Aegis 把資料夾遷移後再換 |
| 14 | 單一執行個體鎖 `bridge.pid`（exit 3 不重啟） | 有 | `lock.rs` 有 | 無缺口；單元用 `RestartPreventExitStatus=3 2` 沿用，要對齊結束碼 |
| 15 | Linux 程序管理：`setsid` 脫離、`/proc` 驗證 pid 命令列 | `start.sh`／boot | `orphans.rs` 有 Linux 分支（subreaper），`pid_alive` 有 | 單元用 systemd 管，不再需要 `nohup setsid`。Grok 沙盒沒有 systemd，需要自己的看門腳本（沿用 `boot.sh`，改啟 Rust 二進位） |
| 16 | systemd 整合（`Restart=`、`Type=notify`／WATCHDOG 心跳） | **Node 版也沒有**（`Type=simple`，無 sd_notify） | 沒有 | 不是差距。可選加強：`sd_notify` 或看門 `bridge.log` 最後更新時間；放後期 |
| 17 | 自我更新（`self-update.mjs`：git fast-forward） | 只有 `bridge.mjs`；**Aegis 橋沒有** | 沒有 | 不需要。Aegis 改為手動替換二進位檔 |
| 18 | log 輪替與防暴增（`safe-log.mjs`，曾 181 GB 事故） | 有 | `BridgeLog` 2 MB 輪替 | 無缺口，但無視窗模式要確認標準輸出寫不出去（systemd journal 斷線）不會無限迴圈 |
| 19 | `preflight`（只讀自檢、不碰 inbox） | `preflight.mjs` | 沒有 | 新增 `asn bridge --check` |
| 20 | 附件／照片（`attach-*`） | 有（收件匣會記附件欄位） | `bridge/attach.rs`、`cli/attach_cmd.rs` | 已有；確認收件匣模式保存 `attachments` 欄位 |
| 21 | Grok 作為「可被送信的引擎」（`grok agent stdio` ACP） | **沒有**（雲端代理只是郵差；AGENT-ENGINES §4 只調研、未實測） | 有 ACP 引擎 | 非必要。若日後要讓 Grok CLI 直接自動回信，重用 `engines/acp`。**第一期不做** |
| 22 | 即時喚醒（`dispatch-watch`） | 在 draft PR #4，未合併 | 沒有 | 不處理，隨收件匣模式一起重新評估 |

### 無視窗模式要關掉的 Windows／Tauri 相依

- **Tauri 本身**：`asn_lib` 無條件連 `tauri`，在 Linux 上會連 webkit2gtk／GTK（Aegis 沒有，也不該裝）。`bridge/` 與 `engines/` 只用到 `tauri::async_runtime::{spawn, JoinHandle, block_on}`，沒有視窗型別；`relay.rs` 一處 `block_on`。處理：見 §5.1。
- 視窗／系統匣／更新器：`tray.rs`、`updater.rs`、`wins.rs`、`shot.rs`、`tts.rs`、`stt.rs`、`ads.rs`、`nowplaying.rs`、`usage.rs`、`claude_*`、`codex_accounts.rs`、`cloud_invite.rs`、`askpass/dialog.rs` 等：全部在 `lib.rs` 掛 `#[cfg(desktop)]`。無視窗版這些不編進去（新增 cargo 功能 `gui` 預設開，`headless` 版用 `--no-default-features`）。
- 主控台切換（`launch/console.rs`、`attach_console`，Windows 專用）、UI 自動化／遠端開視窗（`launcher.rs`、`launch/local.rs`）：無視窗版關掉。`Config.report_asn_window` 設 `false`（不回報「ASN 視窗」）；`launch_env=None`（`start_with` 的第四個參數本來就是選用）。
- `windows-sys`、`windows`（Media_Control 等）：已是 `cfg(windows)` 目標相依，Linux 不編。
- `nowin.rs`：`.no_window()` 在非 Windows 本來就空操作，無需處理。
- `partner_ops`（遠端 Claude 帳號／夥伴操作）：需要視窗與本機 Claude，無視窗版不啟用。
- `Config.sessions_dir`（`~/.claude/sessions`）：Aegis／雲端沒有 Claude 視窗，名單為空，不是錯誤。

## 5. 架構

### 5.1 編譯切分（最關鍵）

| 方案 | 做法 | 優缺點 |
|---|---|---|
| **A（建議第一步）：cargo 功能旗標** | `Cargo.toml` 加 `gui`（預設開，含 `tauri`、`tauri-plugin-*`）；`tauri` 改 `optional = true`；`build.rs` 在沒有 `gui` 時跳過 `tauri_build`；新增 `crate::rt`（薄薄一層 `spawn`／`block_on`／`JoinHandle`，內部用 tokio；`gui` 版轉呼叫 `tauri::async_runtime` 以維持現行行為），把 `bridge/`、`relay.rs` 的 `tauri::async_runtime::` 換成 `crate::rt::`；`lib.rs` 的 Tauri 區塊與 `mod` 全掛 `#[cfg(feature="gui")]`；TLS 依平台選：headless 用 `rustls-tls-webpki-roots`（同安卓，已驗證），不需要 OpenSSL | 差異小、單一 crate、單一份原始碼；風險在 `lib.rs` 1130 行要把 Tauri 部分整理乾淨、Windows 版行為必須不變（靠既有 Rust 測試＋Windows 端到端） |
| B（長期）：拆 workspace | 新 crate `asn-core`（relay、bell、heartbeat、identity、envc、home、datadir、attach、bridge、cli）；`asn`（Tauri）與 `asn-headless` 都相依它 | 最乾淨、編譯快、不可能誤連 Tauri；但搬檔多、`crate::` 路徑要大改、測試要重排，PR 難審 |

建議：先做 A 求快（兩個 PR：①抽 `rt`＋功能旗標、Windows 行為不變；②新增 headless 執行檔），B 視日後維護成本再決定。

### 5.2 執行檔形態

| 選項 | 說明 |
|---|---|
| **新增 `asn-bridge` 二進位（建議）** | `[[bin]] name="asn-bridge" required-features=["headless"]`（或與 `gui` 互斥時無需該限制）。子命令：`asn-bridge run`（常駐）、`--check`（preflight）、`--version`。`asn-cli` 繼續只管 send／recv／room／attach／（新）inbox。理由：常駐行程與使用者命令分開，systemd 單元一行就好，也不會讓一般 CLI 帶著引擎相依 |
| asn-cli 加 `bridge` 子命令 | 少一個二進位，但 CLI 變大且 `asn-cli` 的契約是「短命、拿結束碼」，混入常駐行為不乾淨 |

模式：`asn-bridge run --engine aegis`（Aegis）、`asn-bridge run --mode inbox`（Grok 收件匣）。設定一律用環境變數（沿用 `ASN_` 前綴，`IRORI_` 舊名相容），不新增設定檔格式。

### 5.3 Aegis 引擎（`engines/aegis.rs`）

實作現有 `Engine` 特徵，完全比照 ACP 引擎的形狀：

- `list()`：呼叫 `GET /api/v1/members?scope=all`，以白名單過濾，回 `Window{name:中文名, cwd_label:slug, status:idle, engine:"aegis"}`。讀不到回 `None`（沿用上次名單）。
- `deliver(id,to,text)`：`to` 是視窗名（中文名）→ 反查 slug；同步檢查白名單／SELF（失敗即時 `Err` 或事件 `Fail`）；通過就派一個非同步任務：POST `/agent-chat/ask`（逾時 300 秒、失敗等 60 秒重試一次），結果以 `EngineEvent::Reply{from:中文名, text:answer, mail_id:Some(id)}` 交回核心，由核心寄回並 ack。
- **ack 時機是唯一的語意差異**：Node 版「回覆寄出成功才 ack」；Rust 核心的契約是「引擎回 `Sent` 時 ack 並開始計時」。對 Aegis 而言，ask 是同步 5～300 秒，若 `Sent` 太早就 ack，橋當機會丟信。處理：Aegis 引擎在 ask 回來、`Reply` 事件之前才發 `Sent`（或在核心加「引擎自管 ack」旗標）。**這點要在實作前與核心作者確認，並寫進契約測試。**
- 逾時與忙線：引擎自己的失敗文案要與 Node 版一致（`[Aegis] 對方忙線中，請稍後再問` 等），經 `Notice` 寄回，讓聯絡人看到的訊息不變。
- 白名單、預設成員：`ASN_AEGIS_ALLOW`／`ASN_AEGIS_DEFAULT`／`ASN_AEGIS_SELF`／`ASN_AEGIS_URL`／`ASN_AEGIS_FROM_MEMBER`／`ASN_AEGIS_TIMEOUT_MS`／`ASN_AEGIS_RETRY_MS`，舊名 `IRORI_AEGIS_*` 在 `envc` 登記表登記為相容名，**這樣 Aegis 主機的單元環境變數完全不用改**（降低切換風險）。
- 沒指定收件人的信：「僅引擎」模式下交給預設成員，不留在 inbox 給「本人」（沒有本人視窗）。
- 契約測試：用假 Aegis（本機 127.0.0.1 的小 HTTP 伺服器，回 success／error／404／逾時）跑 `bridge` 主流程，覆蓋 §2.2 表的每一列；比照 Node 版 `test/engine-contract.test.mjs`、`bridge-aegis` 既有測試的案例清單，**逐條對照搬移**。

### 5.4 收件匣模式（Grok 雲端）

- 行為完全比照 `cloud-agent/recv.mjs`：門鈴＋2 分鐘補拉＋退避重試（`pull-retry.mjs` 的退避表 5、10、20、40、60 秒，Rust `Config.pull_backoff_ms` 已有同一組）→ 寫 `inbox.jsonl`（fsync）→ 成功才 ack → 去重靠檔案 → 每 60 秒 roster（Grok 夥伴掃描）→ roster 403 只記一次、之後每小時試一次。
- 檔案格式與路徑和現在相同（`/workspace/relay/inbox.jsonl`、`done.jsonl`、`recv.log`、`recv.pid`），這樣階段 1 試跑時 Grok 現有的 `inbox.mjs`／`send.mjs` 與例行任務完全不用改，可隨時切回。
- 後續（階段 1 之後）才把 Grok 的例行任務改用 `asn-cli inbox`／`asn-cli send`，最後停用 Node 工具。

### 5.5 編譯目標與交叉編譯

| 目標 | 用途 | 說明 |
|---|---|---|
| `x86_64-unknown-linux-musl`（建議） | Aegis、Grok（若 x86_64） | 靜態連結、零系統相依、glibc 版本無關；headless 用 rustls，不需要 OpenSSL。`x86_64-unknown-linux-gnu` 也可行（Aegis glibc 2.39），但沙盒的 glibc 未知，musl 最安全 |
| `aarch64-unknown-linux-musl` | Grok 沙盒若是 ARM | `install-cloud-node.sh` 已對 x64／arm64 兩種處理，意味著曾遇過兩種可能；階段 0 要確認 |

怎麼編（建議順序）：

1. **GitHub Actions 的 ubuntu-24.04 runner**（repo 已有 `asn-linux-build.yml`）：新增 workflow `asn-headless-build.yml`，`cargo build --release --no-default-features --features headless --target x86_64-unknown-linux-musl`（需 `musl-tools`），同時跑 `cargo test --no-default-features --features headless`，成品上傳為 artifact，並可掛到 GitHub Release。**不依賴小真的環境**（小真編不了 Rust）、**不在 Aegis 編**（沒有 Rust 工具鏈、也不該為此在正式機裝）。
2. 本機交叉編譯（Windows 上）不建議：musl 目標需要 C 交叉工具鏈，rustls 版可用純 Rust（`ring` 需要 C 編譯器），維護成本高。
3. 在 Aegis 上編：可行（有 gcc）但要裝 rustup、需外網（crates.io 在 Aegis 回 403，疑似出口限制），不建議。

## 6. 引擎

| 引擎 | 狀態 | 本案處理 |
|---|---|---|
| Aegis | Rust 沒有 | **新增**（§5.3），第一個要做的引擎 |
| 收件匣（Grok 雲端） | Rust 沒有 | **新增模式**（§5.4），不是引擎 |
| Claude CLI（`claude -p` 收發室＋互動視窗） | Rust 有（`worker.rs`） | 無視窗模式**預設關閉**；Aegis／Grok 都不用它。日後要在 Linux 伺服器上跑 Claude 視窗橋再開 |
| ACP（Gemini／agy）、Codex | Rust 有 | 沿用，無視窗版同樣編入（不依賴視窗）；不是本案目標，但不應被破壞 |
| Grok 本身作為引擎（`grok agent stdio`） | 只調研未實測 | 第一期不做 |

## 7. 分階段、驗收與退路

通則：**每一階段都保留 Node 版隨時可切回**，而且同一把節點金鑰只能有一個收信者，所以「切換」永遠是「停一邊、啟另一邊」的單向開關，不能兩邊同時開。每個階段的退路都是同一個動作：停 Rust 版、啟動 Node 版。

### 階段 0：前置（不影響任何線上服務）

| 工作 | 驗收 |
|---|---|
| ①抽 `rt`＋`gui` 功能旗標；②新增 headless 建置；③GitHub Actions 出 musl 成品 | `cargo test`（有 GUI，Windows）全綠、行為不變；`--no-default-features --features headless` 在 ubuntu 上編過且 `ldd` 顯示靜態（musl）；headless 二進位檔裡不含 webkit／gtk 字樣 |
| 「僅引擎」模式（不開 `claude`） | 單元測試：不產生 worker 子程序 |
| Aegis 引擎＋契約測試（假 Aegis） | 契約測試涵蓋 §2.2 每列；與 Node 版同案例輸入產生相同回信文字 |
| 收件匣模式＋`asn-cli inbox` | 與 `cloud-agent/test/*.test.mjs` 同案例的 Rust 測試全綠；用同一份 `inbox.jsonl` 讓 Node 的 `inbox.mjs` 讀得出來（格式相容互測） |
| 在 Grok 沙盒驗證可行性（只查不裝）：`uname -m`、能否下載與執行二進位、glibc／musl | 有明確結論才進階段 1；不行則收件匣改走「Grok 平台技能自產腳本」路線（官網技能），本案對 Grok 的部分降級為「提供命令列」 |

退路：未部署，沒有退路問題。

### 階段 1：Grok 雲端一台，試跑一週

- 範圍：只有 Grok 一個節點（金鑰 `ASN_RELAY_KEY` 平台秘密，路徑沿用 `/workspace`）。
- 做法：`boot.sh` 改啟動 `asn-bridge run --mode inbox`（舊的 `start.sh` 保留不刪）。
- 每日驗收（一週）：
  1. `recv.log` 顯示 `backend=<主機代號>`，roster 每 60 秒回報成功（聯絡人看得到 Grok 與各夥伴）；
  2. 對 Grok 寄測試信（含附件、`expects_reply` 兩種）都落入 `inbox.jsonl`、且收發室端已讀；
  3. 平台重置一次後，開機自動拉起、未 ack 的信沒掉、沒重複；
  4. 連續 7 天沒有「雙收信者」搶信（以 log 與已讀順序檢查）；
  5. 記憶體與 CPU 穩定（對照 Node 版）。
- 退路：把 `boot.sh` 改回啟動 `start.sh`（Node），因格式與路徑相同，信箱無需轉換。

### 階段 2：Aegis

- 先在非正式時段做**影子測試**：不動正式單元；另開一個測試節點金鑰與暫時單元（`asn-bridge-aegis-test`）、`IRORI_AEGIS_ALLOW` 只放一位低風險成員，驗過 §2.2 全部列（含 404、忙線、白名單外、群組）。
- 切換：停 `irori-relay-aegis`（Node），啟動新單元 `asn-bridge-aegis`（Rust），兩個單元設 `Conflicts=` 互斥，避免同時啟。
- 驗收：切換後 24 小時：`status=success` 次數、回覆延遲與 Node 版同量級（近日基線：約 54 次成功，75 秒與 8 秒各有紀錄）；門鈴斷線後 1～2 秒內重連；roster 回報一致（中文名顯示）；`/proc` 與 `ps` 看不到殘留 node 行程；log 正常輪替。
- 退路：`systemctl stop asn-bridge-aegis && systemctl start irori-relay-aegis`（Node 單元檔保留不刪，`/home/cwen0708/asn` 的 checkout 保留）；信箱以仲介為準，沒有狀態要轉移（`pending` 狀態在 Rust 的 `pending.json`，Node 版不讀，切回時進行中的回信等待會遺失，影響範圍僅切換瞬間處理中的 1～2 封，且 Node 版會在補拉時重新處理，因為未 ack）。

### 階段 3：刪除 Node 版

- 前提：階段 1、2 都穩定運作滿兩週，且 `docs/design/ONBOARDING.md` 7.5 節的「移出本 repo」問題先釐清（`bridge-aegis.mjs` 檔頭註明：移出前不要刪、不要改名）。
- 刪除對象：`relay/machine/bridge-aegis.mjs`、`irori-relay-aegis.service`、`relay/cloud-agent/`（連同 `install-cloud-node.sh`、`boot.example.sh`）、對應測試與 README 章節；`README`／`HANDOFF` 更新。
- 注意：`relay/machine/` 的其他檔案（`bridge.mjs` 等）仍是 Windows 工作機／Linux 家用機的橋，**不在這一階段刪**；cloud-agent 目前會 `import` machine 的 `relay-core.mjs` 等，刪 cloud-agent 不影響 machine，反向則會。
- 退路：git 歷史；單元檔與二進位版本在 Release 保留。

## 8. 部署：systemd 單元草稿（Aegis）

```
# /etc/systemd/system/asn-bridge-aegis.service  （草稿，尚未建立）
[Unit]
Description=ASN 無視窗橋（Aegis 引擎）
After=network-online.target aegis.service
Wants=network-online.target
# 與 Node 版互斥，避免同一把金鑰兩個收信者
Conflicts=irori-relay-aegis.service

[Service]
Type=simple
User=cwen0708
# 沿用舊單元的環境變數（舊名 IRORI_* 由程式相容），切換時不必改白名單
Environment=ASN_RELAY_ID=aegis
Environment=ASN_RELAY_URL=https://etccgmkrosbzpltudlgt.supabase.co/functions/v1/relay
Environment=IRORI_AEGIS_ALLOW=aegis,xiao-liang,xiao-yin,xiao-mu,hen,li-li,xiao-hui,xiao-wen,xiao-zhen,xi-xu
# 金鑰仍放 ~/.irori-relay/aegis.key（chmod 600）；需要時用 ASN_HOME 明指，單元檔裡不放金鑰
Environment=ASN_HOME=/home/cwen0708/.irori-relay
Environment=ASN_ENGINES=aegis
ExecStart=/opt/asn/bin/asn-bridge run
Restart=on-failure
RestartSec=15
# 撞到另一個執行個體（結束碼 3）、設定錯誤（結束碼 2）不要一直重啟
RestartPreventExitStatus=3 2
# 收尾：先停收信、等轉交中的信（Node 版最多 5 分鐘），再退出
TimeoutStopSec=330
# 基本沙盒（只需要 HOME 下的資料夾與本機/外網連線）
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=/home/cwen0708/.irori-relay

[Install]
WantedBy=multi-user.target
```

要點：
- 二進位放 `/opt/asn/bin/asn-bridge`（root 擁有、不可被 cwen0708 改寫），用 Release 的 sha256 驗證後以 `install -m 755` 替換；更新 = 停單元、換檔、啟單元，由人手動（不做自我更新）。
- Aegis 本機 API 無認證，單元以 `User=cwen0708` 直接連 `127.0.0.1:8899`；不要把 8899 開到外面。
- Grok 沙盒沒有 systemd：沿用 `boot.sh` 的 `nohup setsid … &` 加 pid 檔判斷（沿用 `recv_running` 的 `/proc/<pid>/cmdline` 檢查，字串改為 `asn-bridge`）。

## 9. 風險

| # | 風險 | 影響 | 對策 |
|---|---|---|---|
| 1 | **`tauri` 相依拆不乾淨**，headless 版仍連 webkit2gtk | 無法在 Aegis 執行（缺系統庫）或要在正式機裝一堆 GUI 套件 | 階段 0 的驗收項「無 webkit／gtk」用 `ldd` 與 `strings` 自動檢查，放進 CI |
| 2 | 動到 `lib.rs`／`bridge` 的非同步執行環境，影響 Windows／安卓正式版 | 現有用戶回歸 | `rt` 版 `gui` 路徑原樣轉呼叫 `tauri::async_runtime`；Windows 全部 Rust 測試＋端到端必跑；安卓建置也要編過（已有 `cfg` 守門測試 `test/android.test.mjs`） |
| 3 | **ack 時機語意差異**（§5.3） | 橋當機時 Aegis 的信遺失，或重複問成員（每次問都會花成員帳號額度） | 引擎在寄回成功後才 ack；契約測試「ask 完成前殺行程→重啟後必須重問且不重複回覆」 |
| 4 | Aegis API 沒有認證、且介面屬 OneStack 另一個專案（`app/api/agent_chat.py`），可能改版 | 橋靜默壞掉 | 契約測試固定回應格式；對 `status` 未知值照實回報（Node 版已如此）；在 Aegis 側加一條回報給 aegis 維護者的備忘：此介面有外部呼叫者 |
| 5 | Grok 沙盒可能不允許執行外來二進位、或架構未知 | 階段 1 做不起來 | 階段 0 先驗證；失敗則 Grok 維持官網「技能自產腳本」路線 |
| 6 | 單一收信者規則 | 切換瞬間雙收信者會搶信、互相 ack | 單元 `Conflicts=`；切換用同一指令序列且先停後啟；Grok 以 `recv.pid` 檢查 |
| 7 | 家目錄回退行為不一致（Aegis 現在用 `~/.irori-relay`，Rust 預設 `~/.asn`） | 找不到金鑰、起不來 | 單元用 `ASN_HOME` 明指；遷移到 `~/.asn` 另開一步，不與切換同時做 |
| 8 | 金鑰洩漏面 | 紅線 | 沿用「環境變數優先、有就不讀檔不寫檔」；子行程環境白名單（已有守門測試 `env_clear`）；log 不印金鑰；二進位以外不放任何祕密檔進 Release |
| 9 | 靜態 musl 在 Aegis／沙盒上 DNS 或憑證行為差異 | 連不上 Supabase | rustls 內建 webpki 根憑證（不吃系統憑證），階段 0 在目標機上跑 `--check` |
| 10 | 同機 `aegis.service` 負載（4 核 16 GB，已用約 3.7 GB） | Rust 橋極輕（Node 橋 RSS 約 73 MB），風險低 | 以 `ps` 對照；Rust 預期更小 |
| 11 | 規劃過時風險：`docs/design/BRIDGE-RUST.md` 寫「Node 橋仍保留給 Linux 雲端與 Aegis」，與本案方向相反；`HANDOFF` 記 #12 裁「全 Rust 重寫」 | 文件互相矛盾 | 本案提交時同步修 `BRIDGE-RUST.md`、`HANDOFF.md`、`relay/machine/README.md` 的 Aegis 章節 |

## 10. 待小良哥或相關人確認

1. Aegis 的 `/agent-chat/ask` 之後會不會改版／加認證？（OneStack 的 Aegis 維護者）
2. Grok Bot 沙盒：能不能下載並執行 Linux 二進位？CPU 架構？有沒有網域白名單？（只能在沙盒裡查，需請 Grok 自己回報 `uname -m` 等）
3. 切換時段：Aegis 切換選在非上班時間（信量低）。
4. `bridge-aegis.mjs` 檔頭「之後移出本 repo（#14 R8，D11）」與本案的先後順序。
5. 是否要順便把 Aegis 的家目錄從 `~/.irori-relay` 遷到 `~/.asn`（建議另一步）。
