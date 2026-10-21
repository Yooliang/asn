# ASN（Agent Sync Network Messenger，電腦版）

懷舊風格的 Windows 桌面即時通。好友＝收發室（relay）名單上的 Claude 視窗，聊天＝收發室的信。
Tauri 2（Rust）＋ Vue 3；多視窗：好友名單一扇、每位好友的對話各一扇、右下角提示一扇（置頂、不搶焦點、不進工作列）。

## 安裝與執行

### Windows

需要：Node 22+、Rust（`winget install --id Rustlang.Rustup -e`，再 `rustup default stable-msvc`）、Visual Studio C++ 建置工具、WebView2（Windows 11 內建）。

```
cd relay/asn
npm install
npm start            # 開發模式（tauri dev）
npm run build        # 出 exe 與安裝檔（src-tauri/target/release/asn.exe、bundle/nsis/ASN_*_x64-setup.exe）
```

### Linux（deb／AppImage）

需要：Node 22+、Rust stable（`rustup default stable`）、Tauri 2 的 Linux 依賴（Ubuntu／Debian 範例）：

```
sudo apt-get update
sudo apt-get install -y build-essential pkg-config libssl-dev \
  libgtk-3-dev libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev \
  libjavascriptcoregtk-4.1-dev libsoup-3.0-dev patchelf
```

```
cd relay/asn
npm ci
npm start            # 開發模式（需要圖形桌面或 X11／Wayland）
npm run build        # 出 asn 二進位、bundle/deb/*.deb、bundle/appimage/*.AppImage
```

已知差異：開允許清單內的網址用 `xdg-open`；提示音在 WebKitGTK 上可能要先點過視窗才有聲（不像 WebView2 可背景播放）；右下角置頂提示在 Wayland 上「不搶焦點」行為需實機確認；`--shot` 端到端截圖與 `scripts/mem.mjs` 僅 Windows。

關掉好友名單視窗＝結束程式。

## 身分與心跳

- 節點、金鑰、`IRORI_RELAY_URL` 的判定與 `relay/machine/identity.mjs` 相同：`IRORI_RELAY_ID` → `~/.irori-relay/node` → 橋正在跑的 `machine-<ID>` → 唯一有金鑰檔的節點；金鑰讀 `IRORI_RELAY_KEY` 或 `~/.irori-relay/<節點>.key`；`IRORI_RELAY_ANON_KEY` 或 `~/.irori-relay/anon.key` 用來訂 Realtime 門鈴（沒有就只輪詢）。
- **金鑰只存在 Rust 的記憶體**：HTTP（reqwest）與 WebSocket 都在 Rust 端做，前端拿不到金鑰，也不寫 log。
- 暱稱＝視窗名＝對外寄信的 `from_agent`／收信的 agent 名：只有名單最上面那一格，預設 `<節點>-ASN`（登入時系統自動產生代號的新電腦改用 `<電腦名稱>-ASN`，畫面不會出現代號），直接改就是改對外名字（Rust 端驗證：去頭尾空白、1～40 字、不能結尾是「收發室」、不含控制字元；不合法就還原並提示），存在資料夾的 `settings.json`。介面其他地方不顯示節點代號或視窗名（設備名只在左側頁籤）。
- 改名後舊名繼續收信：`settings.json` 的 `old_names` 記改名前用過的名字（最多 5 個、保留 7 天），每個舊名照樣用 `inbox&agent=<舊名>` 收信（ack 對同一個名字）並各寫一份心跳；過期就停。用 `inbox&agent=<視窗名>` 只收寄給這個名字的信，收到存檔後才 `ack&agent=`。
- 心跳：每 30 秒寫 `~/.irori-relay/machine-<節點>/self-recv/<視窗名>.json`，內容 `{"pid","name","t"}`，格式、路徑、原子寫入都與 `relay/machine/self-recv.mjs` 相同，pid 是本程式。機器橋看到 90 秒內且 pid 活著的心跳，就不再轉交這個視窗的信。結束時清掉自己的心跳。同一個視窗名已有另一個 ASN 在跑就拒絕啟動。
- 寄信：`POST ?action=send`，`expects_reply` 一定明說（一般訊息 `true`、震動 `false`；震動由前端帶 `nudge:true`，內文由 Rust 組），回覆某封來信時帶 `reply_to`。`from_agent` 由 Rust 端強制設成視窗名，前端不能自填。
- 好友名單：`list` 的 members 各節點視窗，一視窗一列（名字＝視窗名，個人訊息＝資料夾（cwd_label，沒有就空；設備由左側頁籤表示））；結尾「收發室」的不列；每 60 秒更新，有人新上線會彈「已經登入」。狀態：busy／working／running＝忙碌、其餘＝線上、不在名單＝離線（有對話的好友才會留在離線）。
- 震動：寄兩行內文——「（<視窗名> 傳送了一個震動）」加一行請對方回一個震動的提示（`NUDGE_HINT`，`ui/lib/text.mjs` 與 `relay.rs` 同一句）——`expects_reply:false` 的信（前端只帶 `nudge:true`，內文與視窗名由 Rust 端組，前端不能自填）；收到時，第一行是這一句、其餘是空的或就是那行提示（新格式；AI 照提示回的震動只有第一行），或內文含舊版的 `[震動]`（相容還沒升級的 ASN），就抖動該對話視窗（沒開就未讀＋提示），標記不顯示在對話裡。

- 內建收發室橋（全 Rust，預設關）：設定「視窗」分類的「讓 ASN 負責這台的收發室」打開後，ASN 自己做收發室橋的工作（名單回報＝上線、收信、轉交給本機 Claude 視窗、回覆寄回）；舊的 Node 橋在跑時不啟動。設計與分段計畫見 [docs/design/BRIDGE-RUST.md](../../docs/design/BRIDGE-RUST.md)。

## 命令列（`asn-cli`）：Claude 視窗寄信、收信、看群組、下載附件

ASN 兼當命令列工具，取代 `relay/machine` 的 `send.mjs`／`recv.mjs`／`room.mjs`／`attach.mjs`，**不需要 Node**。程式在 `src-tauri/src/cli/`，設計與取捨見 [docs/design/BRIDGE-RUST.md](../../docs/design/BRIDGE-RUST.md) 第 10 節。

```
asn-cli send --to <成員代號|節點/視窗名> --body "內文" (--reply|--no-reply) [--reply-to <信件id>] [--body-file 檔] [--file 路徑 ...]
asn-cli send --room <群組id> --body "內文"
asn-cli send --whoami            # 不寄信，印出父行程鏈、session 對照、節點判定
asn-cli recv --once | --watch    # 每封一行 JSON；--watch 寫心跳，橋就不再轉交這個視窗的信
asn-cli room --rooms | --room-read <群組id|群組名> [--last N | --since SEQ] [--json]
asn-cli attach --id <附件編號> [--out 路徑]
```

- **執行檔**：`asn-cli.exe`（Linux 是 `asn-cli`）和 `asn` 在同一個資料夾，是 console 子系統的獨立小執行檔——cmd／PowerShell／Claude 的 Bash 都會等它結束並拿到結束碼（1 用法、2 認不出視窗、3 超量／已有人在跑、4 後端錯誤），GUI 啟動時也不會閃黑視窗。`asn.exe` 遇到 `send`／`recv`／`room`／`attach` 也會跑同一份程式（備援；殼層不等它結束，不建議）。
- **不啟動視窗、不搶單一執行個體鎖**，可以和正在跑的 ASN 與內建橋並存。
- 寄件視窗名不能自填：沿父行程鏈找 `~/.claude/sessions` 登記的 claude 程序（備援 `CLAUDE_CODE_MESSAGING_SOCKET`）。寄成功留 `replied/`、`sent/` 記號（和 Node 版、橋相容）。
- 找不到命令列時：設定「視窗」分類的「寄信指令」顯示完整路徑，可複製。橋轉交的信件裡附件下載提示與群組翻頁提示也都是完整路徑。
- Node 版（`relay/machine/*.mjs`）保留給雲端代理與沒有 ASN 的 Linux 無畫面節點。

## 介面

- 左側直立頁籤，「設定」頁可選**分頁依**與**分組依**（記在 asn-me.json 的 tabDim／groupDim，舊存檔的 groupMode 會自動轉換）。三個維度：狀態（線上／忙碌／暫離／離線）、廠商（Claude、Gemini、Grok、Codex、DeepSeek，其他照字母，「其他」最後；好友沒回報 engine 時用節點 kind 推斷，kind=other 不採用）、設備。
  - 分頁依設備（預設）：每台設備一個頁籤，本機第一個，其餘照收發室名單順序；名單消失但有對話紀錄的仍保留，全部顯示離線。分頁依廠商：每個廠商一個頁籤（圖示用名稱首字母，滑過顯示全名）。分頁依狀態：固定四個頁籤，沒人的灰掉。頁籤超過 6 個時，第 6 個起收進「更多」（設備維度下本機不會被收進去）。頁籤上有未讀紅點。
  - 分組依：從另外兩個維度選一個，預設分頁＝設備、分組＝狀態；分組跟分頁撞到時自動換成剩下兩個裡的第一個。分組依設備時組名用設備名、本機那組排第一。
  - 之後是「群組」「指引」「設定」。
- 設備內容：該設備的 Claude 視窗，線上／忙碌在前、離線在後，名字後灰字狀態；組標題「[−] 設備名 (線上數/總數)」可收合；名字下一行只顯示資料夾（cwd_label）。
- 群組：唯讀 `GET ?action=room_list`（只列本節點所在的群組：名稱、成員數、最後一句），不寄、不改。
- 指引：安裝與使用說明（開始使用 ASN、讓這台電腦的 Claude 視窗出現在名單上、讓雲端 AI 代理加入、群組怎麼用、常見問題），資料在 `ui/lib/guides.mjs`（要改文字就改這個檔，不放金鑰與網址，路徑用 `%USERPROFILE%` 通用寫法）。清單只列標題，點一篇＝開「指引聊天窗」（見下一條）。
- 設定：清單列十個分類（個人、帳號、外觀、分頁與分組、音效、語音、視窗與系統匣、啟動設定、更新、關於），每類一行目前值摘要（`ui/lib/settings-cats.mjs`）；點一類＝開「設定聊天窗」。存檔格式與各設定的行為不變。表單元件（勾選框、下拉、輸入框、按鈕）共用 `ui/style.css` 的「設定表單統一風格」；「更新」是一張卡片（自動檢查開關一行、立即檢查＋狀態一行、下面是版本更新記錄）。
- **帳號**（含「登入狀態」區塊 `ui/lib/login-panel.mjs`；`ui/lib/claude-accounts.mjs`、`src-tauri/src/claude_accounts.rs`、`codex_accounts.rs`、`acct_remote.rs`）：
  - **Claude 帳號**：以 email（`.claude.json` 的 `oauthAccount.emailAddress`）識別，不用取名字。「加入目前登入的帳號」把現在的登入存進帳號庫 `<家目錄>\.asn\claude-accounts\<email 正規化>\`（email 轉小寫、不安全字元改成 `_xx`；舊版以名字存的資料夾第一次讀到時自動改名）；切換前先把目前權杖回存、備份、兩個檔案原子寫入，失敗會還原。權杖只在本機搬，介面只拿得到 email／方案／使用中。
  - **OpenAI（Codex）帳號**：只顯示目前登入的 email 與方案——讀 `<CODEX_HOME 或 ~/.codex>\auth.json` 的 `tokens.id_token`（JWT）公開聲明裡的 `email` 與 `chatgpt_plan_type`，其餘欄位一律不讀、不留；**切換尚未支援**（Codex 會在使用中回寫權杖，得像 Claude 那樣先回存再換，還沒做）。Gemini 與其他廠商只留位置，顯示「尚未支援」。
  - **遠端切換**：擁有者設備可切換別台的 Claude 帳號。流程與安全設計見 `supabase/migrations/20261021040000_asn_account_switch.sql` 的開頭註解與 `supabase/functions/_shared/account_switch.ts`：每台 ASN 定期回報帳號庫清單（只有 email、方案、使用中）；發起端（帳號管理的「遠端設備」，或名單上對設備標題按右鍵）選對方的 email 送出指令；對方 ASN 取走後預設跳出確認框，按「同意切換」才在本機搬檔（設定可勾「信任我自己的設備」略過確認），並把結果回報給發起端。指令只帶 email，權杖不經過收發室；本機只處理自己剛從收發室取走的指令編號，每個編號只能用一次。
- **指引、設定的聊天窗**：左側直立頁籤切換的是「列表」（好友名單／群組／指引列表／設定分類列表），列表裡點一項就開聊天窗，跟點好友同一套機制（純邏輯在 `ui/lib/panels.mjs`）。所有指引共用一扇、所有設定分類共用一扇——點另一篇／另一類是換內容，不再多開。
  - **整合模式**：右邊分頁列多出「指引：<標題>」「設定：<分類名>」兩種分頁（id 是 `@guide`、`@setting`，不會撞到好友 id），各最多一個；點另一篇／另一類就換內容並切過去；可用 ✕、中鍵、右鍵選單（關閉／關閉其他／關閉右側／全部關閉）關掉；**可拖曳排序、不可固定**（右鍵選單沒有「固定分頁」，存檔裡的固定清單也不收這兩個 id）。
  - **分離模式**：各開一扇獨立視窗（`ui/panel.html`＋`panel.js`，Rust 端 `open_panel`／`close_panels`，標籤 `panel-guide`、`panel-setting`），有跟聊天視窗一樣的自訂外框（可拖曳標題列、最小化／最大化／關閉、拖邊緣調整大小，外框設定即時跟著改），大小記在 asn-me.json 的 `guideSize`／`settingSize`（停止調整 0.4 秒後存）；點不同項目就換內容並叫到前面。
  - **跨視窗同步**：設定的狀態與所有動作都留在名單視窗的樞紐（`list.js`），金鑰與存檔不搬到別的視窗。設定視窗只用事件溝通——`asn:panel`（顯示哪一篇／哪一類）、`asn:settings`（設定快照）由樞紐推出去，視窗用 `asn:set`（`{ op, value }`）把改動送回樞紐的 `applySetting`；改了立即生效於名單視窗並寫進存檔。整合模式的分頁用同一個元件（`ui/lib/settings-panel.mjs`），同一個 `applySetting`。
  - 切換視窗模式時，開著的指引、設定跟著轉（分離視窗→分頁、分頁→視窗），內容不變。
- 通知頁籤已拿掉；右下角提示視窗與名單上的未讀數照舊。
- 整合模式沒開任何對話時，右邊「開始」分頁是大幅廣告輪播（跟底部小廣告同一份資料，大標題、標語、按鈕、左右鍵與小圓點、6 秒自動換）；每則可以改用官網上的網頁（`page`），沒有就用純 CSS 畫的樣板；招租沒有聯絡網址時按鈕不可點。
- 廣告來源與安全：見下面「廣告輪播」一節。

### 廣告輪播

- **來源**：官網 `site/public/ads.json`（線上網址 `https://asnmessenger.web.app/ads.json`）。ASN 啟動時抓一次、之後每 6 小時一次，由 Rust 的 `ads_fetch` 發出請求（`src-tauri/src/ads.rs`）：只准 https、不跟轉址、5 秒逾時、64 KB 上限；逐則驗證欄位，不合格的那一則丟掉，過期或還沒開始的也過濾掉。整份抓不到就用打包在 `ui/lib/tabs.mjs` 的 `ADS`（備用，key 集合與 `ads.json` 一致，有守門測試）。`--shot` 模式不上網，一律用備用。
- **怎麼改**：只改 `site/public/ads.json` 然後部署官網，使用者最久 6 小時後看到（官網對它設 `max-age=300`）。要同步改 `tabs.mjs` 的 `ADS` 備用（至少 key 要一致）。
- **欄位**（`version` 目前是 1，最多 10 則，key 不可重複）：
  - `key`：英數與 `-` `_`，32 字內；`title`：30 字內；`sub`：60 字內（畫面上實際顯示約 24 字，太長會被截）；`badge`：選填，6 字內（例如 `TIP`、`NEW`）；`cta`：按鈕字，6 字內，有 `url` 就必填；`url`：選填，點了用系統瀏覽器開；`hue`：0–360 的色相。
  - `start`、`end`：選填，`YYYY-MM-DD`（UTC，含當天）。
  - `smallImage`：選填，小輪播（名單底部）用的圖，官網路徑如 `/ads/<key>-small.webp`，只收 png／webp，300 KB 內；建議 **336×54（2 倍圖 672×108）**，左右留邊距，右下角有輪播小圓點。Rust 端下載、看檔頭確認真的是 png／webp 後轉成 data URI 給畫面（所以 CSP 的 `img-src` 不用放寬）；沒有、抓不到、太大、格式不對都退回樣板。
  - `page`：選填，大幅輪播用的網頁，官網路徑如 `/ads/<key>.html`（只准 `/ads/` 底下、小寫英數與 `-` `_` `.` `/`、副檔名 `.html`）；Rust 端組成 `https://asnmessenger.web.app/ads/…` 後交給畫面。5 秒內沒載入完或載入失敗就退回樣板。
- **做一則新廣告**：(1) 在 `ads.json` 加一則；(2) 要大頁就放 `site/public/ads/<key>.html`（範例：`ads/policy.html`），要小圖就放 `site/public/ads/<key>-small.webp`；(3) 備用 `ADS` 也加上同 key；(4) 跑測試；(5) 部署官網。
- **大頁的限制**：靜態單檔，樣式寫在頁內，動畫只用 CSS；**不能引用外部資源**（官網對 `/ads/**` 的 CSP 是 `default-src 'none'; style-src 'unsafe-inline'; img-src data:; script-src 'none'`，圖片只能 data URI）；不能有腳本。ASN 用 `<iframe sandbox="">`（不給 same-origin、scripts、top-navigation、forms、popups）、`referrerpolicy="no-referrer"`、`allow=""`，而且 iframe 不接收滑鼠，**頁面裡的連結點不到**——要導流請用 `cta` 與 `url`，ASN 會在頁面下方放自己的按鈕，經網域允許清單開外部瀏覽器。頁面大小隨視窗變，請用 `vw`／`vmin`／`clamp()`，建議以 16:9 到 4:3 都好看為準，底部留 58px 給按鈕與小圓點。
- **嵌入的來源**：Tauri 2 在 Windows 的網頁來源是 `http://tauri.localhost`（Linux／macOS 是 `tauri://localhost`），官網只對 `/ads/**` 的 `frame-ancestors` 放行這兩個，其餘路徑仍是 `X-Frame-Options: DENY`＋`frame-ancestors 'none'`。`tauri.conf.json` 的 CSP 只加了 `frame-src https://asnmessenger.web.app`。
- **網域允許清單**：廣告的 `url` 與 `open_url` 指令共用 `ads::url_allowed`——只准 https、不能帶帳號密碼、主機要是網域名稱（IP 位址一律不行）且完全等於清單內的一項（子網域不算）、埠只能是預設的 443。目前清單（`ads.rs` 的 `ALLOWED_HOSTS`）：`asnmessenger.web.app`、`policy-tw.web.app`。要加網域就改這一處並補測試。
- **純文字顯示**：線上內容一律用 `{{ }}` 當純文字，不進 `v-html`；圖片只收 Rust 轉好的 png／webp data URI。
- 設定頁有四個彼此獨立的外觀設定（記在 asn-me.json，任意組合都有效，純邏輯在 `ui/lib/merge.mjs`）：
  - **視窗模式**：分離（預設，每位好友一扇對話視窗）／整合（一個主視窗，預設約 900×640、可調整、各模式各記各的大小；左邊是名單、右邊上方一排對話分頁，可關閉、有未讀數）。整合模式下點好友、點右下角提示都是切到那個分頁；來信震動抖整個主視窗；切換模式時已開的對話接得上（視窗關掉變分頁、分頁開成視窗）。
  - **視窗外框**：自訂（預設，ASN 自畫的 Aero 風標題列與邊框，可拖曳、拖邊緣調整大小）／Windows 原生；名單、對話、整合主視窗都照這個設定，切換即時生效（存在 `asn-me.json` 的 `frame`，沒有這欄位的舊存檔＝自訂；Rust 端開視窗時讀同一份）。
  - **關閉視窗時**：縮到系統匣（預設）／結束程式（存在 `asn-me.json` 的 `closeTo`，沒有這欄位的舊存檔＝縮到系統匣）。縮到系統匣只把名單視窗藏起來，收信、心跳、門鈴與右下角提示照常；系統匣圖示左鍵叫回名單、右鍵選單「開啟」「結束」，提示文字帶未讀總數。系統匣建不起來（例如 Linux 缺 appindicator）時關閉一律結束。程式在 `src-tauri/src/tray.rs`。
  - **登入時自動啟動 ASN**（預設關）：Windows 寫 `HKCU\...\Run` 的 `ASN` 值、Linux 寫 `~/.config/autostart/asn.desktop`，都帶 `--background`（開機只常駐系統匣、不跳名單）；其他系統隱藏這個開關。是否開啟以系統上的實際設定為準，不存在 `asn-me.json`。
  - **自己的大頭貼**：名單最上面點一下就開選圖（同設定頁的上傳流程），右鍵可「改回自動產生」。音效在設定頁是「開／關」下拉。
  - **頭像模式**：左（預設）／右＝對話區旁邊一欄放大頭貼（對方在上、自己在下），欄旁的小箭頭可收起／展開（狀態記住）；整合＝像 LINE，頭像跟著訊息（對方靠左帶小頭像、自己靠右），沒有側欄也沒有箭頭。
  - **文字底色**：透明（預設）／色彩（每則訊息一個底色泡泡、雙方同色）／自動（對方淡灰、自己淡綠）。
  - **工具列位置**：輸入框上方（預設，舊版 MSN 6～2009 的樣子）／輸入框下方。工具列按鈕只有圖示（內嵌 SVG，滑過看提示、`aria-label` 是中文），按表情圖示開表情選單。
  - 對話區的版面只有一份（`ui/lib/chatpane.mjs`），分離模式的對話視窗與整合模式的分頁共用。
- 大頭貼：名單、對話區、右下角提示、自己的頭像都用圖片（`ui/lib/avatar.mjs`）。**自動產生**：DiceBear 的 `shapes` 風格，在本機離線產生（官方套件 `@dicebear/core`＋`@dicebear/shapes`，固定 9.x 版；`npm run prep` 用 esbuild 打成單檔 `ui/vendor/dicebear.mjs`，不連 api.dicebear.com，`ui/vendor` 不進 git），種子＝好友 id（`節點/視窗名`），每人固定、不同人不同。**設備上傳**：設定頁「大頭貼」選圖 → 前端置中裁成正方形、縮成 96×96、轉 webp（不行就 png）、≤ 32 KB → 經 Rust 指令 `relay_set_avatar`（檢查格式與大小才送，金鑰只在 Rust）上傳到收發室；也可以「移除，改回自動產生」。**顯示規則**：名單上的 AI 視窗一律自動產生；不在名單上的寄件人（例如別台的 ASN）用他那台設備上傳的圖，沒有就自動產生；自己＝本機節點有上傳就用上傳的，沒有就自動產生。`list` 只帶各節點的 `avatar_updated_at`，圖用 `GET ?action=avatar&node=<節點>` 在更新時間變了才取（收到的圖也要通過格式檢查才顯示）。
- 傳照片與檔案（設計見 `docs/ATTACHMENTS.md`）：對話工具列有「傳照片」（也可直接貼上圖片）與「傳送檔案」。照片先在前端縮到長邊 2048、轉 webp（≤ 5 MB）並做 256 長邊縮圖；一般檔案（pdf、txt、md、json、csv、zip、docx、xlsx、pptx，≤ 25 MB）不壓縮不轉檔。交給 Rust 指令 `relay_send_attachment`：檢查型別、大小與檔頭才依序向收發室要一次性上傳網址、上傳、確認、寄信（金鑰只在 Rust）。對話裡照片顯示縮圖（點了放大，可另存）、檔案顯示檔案卡（點了跳出系統「另存新檔」對話框，預設在 `下載\ASN` 或上次存的資料夾、預設檔名＝原檔名；選好才下載，按取消就不下載；存好後狀態列顯示位置並可「開啟資料夾」，路徑由 Rust 決定）；對方的來信也一樣。保存 30 天，過期顯示「已過期」。可重用入口：`ui/lib/photo-canvas.mjs` 的 `imageFromBlob`／`fileFromBlob`＋`core.sendAttachment`。
- 對話中切換模型（issue #82，含使用者自己開的 Claude 視窗）：名單上本機 Claude 夥伴按右鍵「切換模型 ▸」（Opus／Sonnet／Haiku，清單在 `ui/lib/model-catalog.mjs` 的 `CLAUDE_MODELS`，目前模型打勾）。Rust 端（`src-tauri/src/launch/switch.rs`，全 Rust、不帶 Node、不啟動 powershell／wmic）：讀 `~/.claude/sessions/<pid>.json`（pid、sessionId、cwd、name、status）＋該 pid 的啟動參數（`NtQueryInformationProcess` 取 PEB、`ReadProcessMemory` 讀命令列，只支援 64 位元程序）；目前模型取最後一個 `--model`，沒有就顯示「預設」。只在 status 為 `idle` 時允許；前端先跳確認窗（會關掉原視窗、正在打的字會不見、對話接續）才呼叫；後端再重驗 pid／sessionId／名字／閒置／命令列像 Claude，並由 `kill_set` 算出允許結束的清單（只含該 pid、它的後代、以及確實是 ASN 承載殼的直接父殼；絕不含自己、自己的祖先與同輩程序）。流程：優雅關閉（對傳統主控台視窗送 `WM_CLOSE`，等 4 秒）→ 否則 `TerminateProcess` 只結束允許清單內的 pid → 確認原 pid 消失 → 照原參數重開（去掉舊的 `--model`／`--resume`／`-r`／`--continue`／`-c`／`-n`／`--fork-session`／`--session-id`，加 `-n <名字> --resume <sessionId> --model <新模型>`，同 cwd；原本在 Windows Terminal 分頁就用 `wt.exe -w 0 new-tab` 開回新分頁，偵測不到才用 `launch/local.rs` 的 powershell -NoExit 承載視窗）→ 最多等 45 秒，同名且 pid 不同的新工作階段出現才回報成功。失敗會回傳可複製的手動重開指令（PowerShell）與「原視窗是否已關」。前端邏輯在 `ui/lib/model-switch.mjs`（`createModelSwitcher`，之後 #40 功能列直接重用）。測試：`test/model-switch.test.mjs`；Rust 的命令列解析、參數改寫、閒置判斷、只殺指定 PID 的守門與整條流程（假的作業系統介面）在 `switch.rs`，另有 `#[ignore]` 的真機測試（假程式讀命令列→結束→重開）。已知限制：新視窗不繼承原視窗的環境變數（例如 `CLAUDE_CONFIG_DIR`）；原命令列若帶尾端提示詞（positional prompt）會原樣帶回。
  - 使用者自己開的 Claude 視窗（#82 剩餘項目 1）：辨識方式＝收發室名單上的視窗名等於該 Claude 工作階段記錄的 `name`（`-n`、`--remote-control <名>` 或 /rename 取的名字），所以不需要 ASN 當初開它。查詢結果的 `ownWindow` 標示這是使用者自己的視窗（父殼不是 ASN 的承載 PowerShell）：只結束 claude 與它的後代，**不碰使用者的終端機殼**，新視窗開在 Windows Terminal 新分頁（原本在 WT 時）或新主控台視窗，原分頁會留一個空的命令列，確認窗會先說明。限制：沒取名的視窗（沒有 `name`）名單上本來就認不出來，無法切換；讀不到命令列（權限較高的程序、32 位元）或命令列不像 Claude 時不處理；VS Code 內建終端機等非傳統主控台的視窗送不了關閉訊息，會直接強制結束 claude；原視窗的環境變數與終端機專屬設定不帶過去。
- 從 ASN 開同名夥伴視窗預設接續上一段對話（#82 剩餘項目 2，`src-tauri/src/launch/resume.rs`）：開 Claude 視窗前（本機「開新夥伴」與遠端 launch 兩條路徑）到 `<Claude 設定資料夾>/projects/<資料夾編碼>/*.jsonl` 找對話檔，取每個檔最後一筆標題記錄（`custom-title`／`agent-name`）等於這個夥伴名字、且最近修改的那一個，在啟動參數最前面加 `--resume <sessionId>`；沒有舊對話才新開。只讀標題那幾行；資料夾編碼＝路徑中非英數字元換成 `-`（磁碟機代號大小寫不拘）。守門：只對指令是 `claude` 的 profile 加；profile 已自帶 `--resume`／`-c`／`--session-id` 就尊重；同名視窗還活著、或那段對話正被另一個活視窗使用時不接續（避免兩個視窗寫同一段對話）；找不到或格式認不得一律退回新開，不擋啟動。`LocalLaunchReq.fresh=true` 可強制新開；回傳多一個 `resumed`。限制：標題記錄是 Claude Code 的內部格式，改版後可能認不得（退回新開）；對話檔只看最近修改的 60 個；Codex 本來就是 `resume <名字>`，Gemini／Grok 為背景工作者不適用。
- 截圖與標註（issue #10）：對話工具列有「截圖」鈕（Windows 版；Linux 版沒有這個按鈕，因為擷取程式碼只在 Windows 編譯，`shot_supported` 回 false）。按下後 Rust 端（`src-tauri/src/shot.rs`）隱藏 ASN 所有可見視窗、等 260 ms 讓桌面重繪，再用 GDI（`BitBlt`＋`CAPTUREBLT`，只多開 `windows-sys` 兩個功能開關，不新增擷取套件）把整個虛擬桌面一次抓成凍結圖，然後每個螢幕開一扇置頂無邊框覆蓋視窗（`ui/shot.html`／`shot.js`）顯示該螢幕那一塊；拖曳框選、Esc 或右鍵取消、5 分鐘沒動作自動取消。框選範圍限在同一個螢幕內（不能跨螢幕邊界）。座標換算不信任 `devicePixelRatio`，用「視窗實際大小 ÷ 圖片實體像素」的比例（`ui/lib/shot.mjs`），所以 125%／150%／混合縮放的多螢幕都對得準；Rust 端再夾一次範圍。截圖以 PNG 位元組直接經 `tauri::ipc::Response` 傳（不經 JSON／base64）。框選完進入標註畫面（`ui/lib/annotator.mjs`，浮層在對話區內）：畫筆、螢光筆、矩形、箭頭、文字、馬賽克，8 種顏色、細／中／粗，復原／重做（Ctrl+Z／Ctrl+Y）、清除（可復原）；規則、堆疊與畫法在 `ui/lib/markup.mjs`。按「傳送」輸出 PNG（長邊超過 4096 先縮小）→ `imageFromBlob` 轉成 webp → `core.sendAttachment`（可加說明文字）；取消則整張丟掉。在輸入框貼上圖片也會進同一個標註畫面（不再直接送出）。測試：`test/shot.test.mjs`、`test/markup.test.mjs`、`test/shot-wiring.test.mjs`；Rust 的裁切、座標夾限、PNG 編碼與真的擷取桌面在 `shot.rs` 的單元測試。
- 經機器橋轉回的回信若整段包著 `<cross-session-message …>…</cross-session-message>`，收信時剝掉最外層（`unwrapShell`）。

## 語音（念出訊息、語音輸入）

- 對話裡對方每則訊息旁有喇叭鈕＝念出來；設定頁「語音」可選聲音、開「收到新訊息自動念」（預設關）。文字經 Rust 端送收發室後台的 `tts` 動作（需維護者在後台啟用，未啟用時按鈕會提示），回來的 MP3 在前端播放。
- 輸入框旁的麥克風鈕＝語音輸入：按一下開始、再按一下結束；在本機用 whisper.cpp 辨識（錄音不離開電腦），結果填進輸入框，**不會自動送出**。第一次使用要先下載辨識引擎與模型（約 200 MB，存在資料夾的 `stt\`，不進 git）。
- 設定存在資料夾的 `voice.json`；Rust 指令 `tts_voices`、`tts_speak`、`stt_status`、`stt_install`、`stt_transcribe`、`voice_cfg_get`、`voice_cfg_set`（程式在 `src-tauri/src/tts.rs`、`stt.rs`、`voicecfg.rs`）。
- 架構、部署、隱私、需要真機驗證的項目、後續選項：[docs/VOICE.md](../../docs/VOICE.md)。

## 往來記錄（依視窗名）

內建收發室橋每轉交一封信（含群組訊息）給某個視窗、每轉出該視窗的一則回覆，就追加到 `%USERPROFILE%\.asn\handoff\<視窗名>.md`（只在本機）。每封轉交的信最後多一行「你與收發室的往來記錄在：<路徑>（接手前請先讀）」，同名的新視窗接手時先讀它。單筆內文最多約 4 KB；檔案超過 1 MB 或 200 筆，較舊的搬到 `handoff\archive\`。視窗自己用命令列直接回的信，橋看不到內文，只記一筆「自行回信」。細節見 [docs/design/BRIDGE-RUST.md](../../docs/design/BRIDGE-RUST.md) 7.5。

記錄檔第一行是檔頭 `# 夥伴 ID：p_…｜目前名字：…`（#109）：橋回報名單時由後台判斷每個視窗是哪位夥伴，名字改了、session 換了，夥伴 ID 都不變；後台還不支援時沒有這一行、一切照舊。規則見 [docs/design/PARTNER-ID.md](../../docs/design/PARTNER-ID.md)。

## 資料

- 對話紀錄：`%APPDATA%\tw.irori.asn\asn-chats.json`（每位好友最近 200 則，只有信件內容與系統提示）；暱稱／狀態／音效／自動檢查更新：`asn-me.json`。環境變數 `IRORI_ASN_DATA` 可改資料夾。
- 信件內文與好友名稱是外部資料：顯示前一律跳脫（`ui/lib/text.mjs` 的 `esc`／`emo`），介面模板不准 v-html 原文（有守門測試）。

## 測試

```
npm test             # node --test：純邏輯（roster、歸屬、震動、跳脫、v-html 守門）、AsnCore 對假 relay、asn.exe 端到端
npm run test:rust    # cargo test：心跳檔格式、身分判定、寄信欄位、門鈴訊息、命令列（send／recv／room／attach，本機假後端；含真的跑 asn-cli 的測試）
ASN_SHOT_ME='{"winMode":"merged","shotNoChat":true}' node scripts/shot.mjs <資料夾>   # 設定欄位名是 winMode（不是 mode）；shotNoChat＝不開對話（整合模式停在「開始」大幅廣告）；shotAd／shotTab 固定廣告與起始頁籤；逐頁籤截圖最後會各開一次指引（bridge）與設定聊天窗：整合模式在右邊分頁（`tabs-guide-doc.png`、`tabs-settings-doc.png`），分離模式另存兩扇獨立視窗（`panel-guide.png`、`panel-setting.png`）；shotSetting 指定設定窗顯示哪一類（預設 look），shotSettingSet 是 `[{"op":"dpMode","value":"right"}]` 這樣的清單，模擬在設定窗裡改值
node scripts/shot.mjs <資料夾>   # （環境變數 ASN_SHOT_AVATARS=1 會示範設備上傳的大頭貼）開假 relay＋真的 asn.exe，名單＋對話＋提示各截一張 PNG（需要真桌面，沙盒裡會是黑的）
node scripts/mem.mjs             # 量閒置記憶體
```

所有測試與截圖只連 `127.0.0.1` 的假 relay（`test/fake-relay.mjs`），不碰真實後端；`--shot` 若 `IRORI_RELAY_URL` 不是本機會直接拒絕。

## 發版與自動更新

ASN 用 Tauri 官方 updater：啟動時與每 6 小時檢查 `https://asnmessenger.web.app/update/latest.json`；有新版就在名單上方顯示「有新版本 x.y.z：<說明第一行>　[更新]」，**按了才**下載、驗簽、安裝並重開（不強制）。設定頁可關「自動檢查更新」（存在 `asn-me.json` 的 `autoUpdate`，預設開），也有「立即檢查」。`--shot` 模式不檢查。只接受用更新私鑰簽過的安裝檔（公鑰寫在 `src-tauri/tauri.conf.json` 的 `plugins.updater.pubkey`）。

**遠端更新**：名單上別台設備顯示「有新版」時，已登入的本人（該設備在同一個帳號下）可按旁邊的「更新」。流程：本人用登入憑證呼叫後台 `node_update_request`（只認 `relay.nodes.owner_user` 等於本人的節點，別人的設備一律 `not_found`；對方 ASN 要在線）→ 後台在 `relay.asn_update_requests` 留一筆請求 → 那台 ASN 回報在線（`asn_presence`，每 60 秒）的回應帶 `update_requested: true`（只回一次）→ 它在 Rust 端用同一個內建更新器（檢查 → 下載 → 驗簽 → 安裝 → 重開，`updater::run_remote`）自己更新，正在更新中就不重複啟動 → 已是最新版或失敗用 `asn_update_result` 回報；更新成功則重開後回報的版本變了，請求自動清掉。請求 30 分鐘沒完成就過期。名單上依序顯示「已送出更新要求」→「更新中…」→ 版本變新後標記消失；失敗顯示「更新失敗，重試」。全程不經 AI。需要 migration `20261021070000_asn_remote_update.sql` 與重新部署 relay 函式；後台還沒部署時 `node_update_status` 會失敗，名單就不顯示「更新」鈕。

### 發一版

```
npm run release -- --notes "這版改了什麼（第一行會顯示在通知列）"
```

`scripts/release.mjs` 依序：版本號加一（`bump.mjs`）→ `prep` → `tauri build --bundles nsis`（帶簽章環境變數，產出 `.exe` 與 `.exe.sig`）→ 產生 `site/public/update/latest.json`（version、notes、pub_date、`platforms.windows-x86_64` 的 signature 與 url）→ 把安裝檔與 `.sig` 複製到 `site/public/update/`。沒給 `--notes` 時取 `relay/asn/CHANGELOG.md` 的第一段，再沒有就用預設句。腳本只在本機產檔，**不部署**。

之後：

1. 提交版本號（`package.json`、`tauri.conf.json`、`Cargo.toml`）與 `site/public/update/latest.json`（安裝檔與 `.sig` 已被 `.gitignore` 擋住，不進 git）。
2. 由人部署官網：在 `site/` 底下 `firebase deploy --only hosting`。**先確認安裝檔已一起上傳**，使用者的 ASN 才下載得到；`latest.json` 已設 `no-cache`。
3. 想先演練：`npm run release -- --dry-run`（不改版本號、不動官網目錄，產物放 `src-tauri/target/release-dry/`）；`--no-bump` 則沿用目前版本號但照常寫進官網目錄。

平常的 `npm run build`（含 CI）不簽章、不產 `.sig`（用 `src-tauri/tauri.nosign.conf.json` 關掉 `createUpdaterArtifacts`），所以不需要私鑰。

### 更新簽章私鑰

- 位置：`%USERPROFILE%\.asn\updater\`（`asn.key` 私鑰、`asn.key.password` 密碼、`asn.key.pub` 公鑰）。環境變數 `ASN_UPDATER_KEY_DIR` 可改資料夾。發版腳本只把私鑰的**檔案路徑**交給 `TAURI_SIGNING_PRIVATE_KEY`，密碼檔讀進子程序的 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`，兩者都不印出；私鑰與密碼不進 repo（`.gitignore` 擋 `*.key`）。
- **遺失私鑰的後果**：已安裝的舊版只認現在這把公鑰，換一把新的簽的更新檔會驗簽失敗，舊版**再也收不到自動更新**，只能請使用者手動重新安裝（新版內建新公鑰）。私鑰外洩則是別人能發出舊版會接受的惡意更新，要立刻換鑰並請使用者手動重裝。
- 備份建議：把 `asn.key` 與 `asn.key.password` 各複製一份到離線的位置（加密隨身碟或密碼管理器），兩份分開放；換電腦打包時整個資料夾搬過去。

## 第三方授權

- **Vue 3**（`vue`）：MIT。
- **DiceBear 程式**（`@dicebear/core`、`@dicebear/shapes` 的程式碼）：MIT，Copyright (c) 2024 Florian Körner。
- **shapes 風格的圖案設計**：DiceBear（<https://www.dicebear.com>）創作，CC0 1.0（公眾領域貢獻，<https://creativecommons.org/publicdomain/zero/1.0/>）。以上依據套件內的 `LICENSE` 與風格中繼資料（`meta.license`）。
- **esbuild**（只用於建置，不隨程式發佈）：MIT。

## 已知限制

- 音效用 WebAudio 合成；Windows 已用 WebView2 參數允許不點視窗就出聲，Linux WebKitGTK 可能需先點過視窗；若系統靜音則聽不到。
- 與本機（同節點）視窗聊天：後端不擋，ASN 放行；`asn-cli send`（與 Node 版 `send.mjs`）也放行同節點（本機 Claude 視窗可直接寄信給本機的 ASN），只擋寄給自己這個視窗。
- 若 ASN 沒開，寄給視窗名的信會留在節點信箱，機器橋心跳過期後會當成「找不到視窗」處理（照橋的退路）。
- 我的狀態（線上／忙碌…）只是本機顯示，不會回報給收發室。
