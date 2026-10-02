# 多裝置同步：要不要換掉「長輪詢＋門鈴」？

2026-10-02。對應進度表 #110。**只評估，沒有改任何程式、沒有部署。**
起因：小良哥問「ws 或 realtime db 可不可以」，後來又補了 Firebase Realtime Database（下稱 RTDB），並要求 RTDB 裡只放指標、不放機敏資料。
行號都是這份文件寫成時（main `9c4d8bd` 之後）的行號。標「估」的數字是我讀程式推的，**沒有實測**，驗證辦法在第 6 節階段 0。

## 0. 結論

1. **建議：維持長輪詢＋門鈴（方案 3），不換傳輸層。** 缺口靠「新增事件種類＋去重鍵」補，另外做兩個低風險的減負與一個止血。
2. 理由一：`SPEAKER.md` 列的 5 個缺口都是**資料模型缺口**（缺某種事件、缺去重鍵、缺跨裝置的搶佔），不是推送太慢。換成 Realtime／WebSocket／RTDB，這些事件照樣要先設計；換傳輸只改善「事件到達的最後一哩」。
3. 理由二：長輪詢**同時是排程器**——提醒、夥伴來信處理、記憶整理都是靠 `/updates` 被呼叫才會跑（1.2）。換傳輸層就得同時搬排程，工程量比看起來大得多。
4. 理由三：前端**確實完全沒有任何 key**（1.4 逐項查證）。方案 1 的 WebSocket 握手必須帶 `apikey`，直接抵觸紅線；方案 4 在「只放指標」下可以做到零金鑰，但延遲沒有比現在好（內容還是得再拉一次），好處只剩「零金鑰直接收推送」與少量負載，還多一家供應商。
5. 順手發現兩件該修的事（和選哪個方案無關）：**speaker 那台關頁或切背景後，最長 3 分鐘沒有任何一台出聲**（缺口 6）；**每個 `/updates` 週期約打 3 次 irori-relay**（進場的 inbox、不必要的 `whoami`、訂好門鈴後補查的 inbox），若專案在 Supabase Free 方案，估計會把 Edge Function 月配額吃光（1.3）。

## 1. 現況盤點

### 1.1 資料流

```
裝置：電腦 3D 頁／電腦 /chat 頁／手機 App 服務（原生）／App 內 3D、聊天兩個 WebView
  │  GET /updates?wait=25&since=<seq>&state_seq=<n>&client_id&kind&visible      (web/js/inbox.js:100，BubbleService.kt:429)
  ▼
irori-api（Edge Function）每次進來先做一輪「維護」，再進入等待：
  │  等待＝在函式內開 WebSocket 訂 Realtime 的兩個 public 頻道（狀態門鈴、來信門鈴）(inbox.ts:175-223)
  ▼
Realtime 門鈴（不帶內容）←  ringStateBell（PUT /state、speak_elsewhere，state.ts:72）
                          ←  irori-relay 寄信時 ring(bell_topic)（irori-relay/index.ts:222）
真正的內容都在資料庫：irori.kv 的 updates_log（一列 jsonb，最近 50 則／24 小時，seq 游標，03_irori.sql:146-171）、
                      state_seq、speaker、dev:<id>、lease
```

- 每台裝置各帶自己的 `since` 游標（網頁放 `sessionStorage`，inbox.js:63-66；App 放 SharedPreferences），漏拉一次下次補得回來；網頁分頁切到背景就中斷請求、回前景用游標補拉（inbox.js:95-97）。
- 去重靠 `seq`；同瀏覽器多分頁靠 `localStorage` 搶「這則唸過了」（main.js:313）；同一句只由一台唸靠 `speaker_client`（speaker.ts:54-62）。
- 本機版（`isCloud=false`，inbox.js:123-125）每 2 秒輪詢、單台，不在這份評估範圍內，任何方案都不影響它。

### 1.2 重要發現：長輪詢兼任排程器

Edge Function 沒有常駐程序，下面這些事都是「有裝置在問 `/updates`」才會發生（inbox.ts:241-276）：

| 做的事 | 位置 | 沒人輪詢會怎樣 |
|---|---|---|
| 提醒到點就講 | `fireReminders`，inbox.ts:249、274 | 提醒不會響，等下次有人開頁才補講（有「補講口吻」，reminders.ts `LATE_SECONDS`） |
| 拉 relay inbox、讓她轉述、ack | `ensureProcessed`→`processInbox`，inbox.ts:118-158 | 信留在仲介，不轉述（設計如此：沒人開著就不呼叫模型） |
| 記憶閒置整理、跨日定稿 | `memory.idleTick`，inbox.ts:245 | 等下次有人開頁 |
| 在線偵測（away／離開期間的總結） | `irori_presence_touch`，inbox.ts:246 | — |
| 出聲裝置登記 | `touchDevice`，inbox.ts:244 | speaker 失效 |

所以「把長輪詢整個拿掉」不是換個推送管道而已：還得補一個排程（pg_cron＋pg_net、或讓 irori-relay 寄信後直接 HTTP 呼叫 irori-api）。`docs/SUPABASE.md` 的記憶一節明寫「不用 pg_cron」，這個決定要重新討論。方案 1、2、4 若要**取代**長輪詢都會撞上這件事；若只是**加在長輪詢旁邊**，就沒有減負的好處，只多一條路徑。

### 1.3 每個週期的成本（估）

一次 `GET /updates?wait=25`，在進入等待**之前**就做：`touchDevice`（2～4 次 kv RPC）、`presence_touch`、讀 baseline、補提醒、`ensureProcessed`（claim＋**打 irori-relay 的 inbox**＋release）、再讀一次、再**打 irori-relay 的 whoami 取門鈴頻道**（relay.ts:151-153 沒有快取）。訂好門鈴後（`phx_reply` ok）還會「補查一次」（inbox.ts:215），對來信頻道那次又是 `ensureProcessed`→**再打一次 irori-relay 的 inbox**（inbox.ts:270）。醒來後還要再讀、再查提醒、`stampSpeaker`（2 次 kv 讀）。

- 約 10～15 次資料庫 RPC，加上 **1 次 irori-api＋約 3 次 irori-relay 的 Edge Function 呼叫**（inbox、whoami、補查的 inbox）。
- `irori_updates_since` 每次讀都會**寫**一列 `pending`（03_irori.sql:303），讀等於寫。
- 週期最長 25 秒 → 一台「一直開著的輪詢者」每天約 3,456 個週期 ≈ 1.4 萬次函式呼叫 ≈ **每月 40 萬次**。手機 App 的原生服務（BubbleService.kt:412-453）是常駐的；電腦 3D 頁、電腦 /chat 頁、App 內兩個 WebView 只有「看得到」時才輪詢。
- 同時 2～4 個輪詢者 → 每月約 **80～160 萬次**（估）。Supabase 官方定價頁：Free 含 50 萬次、Pro 含 200 萬次再 $2／百萬。**如果專案在 Free 方案，這已經超額**；請先到 Dashboard 的 Edge Functions 用量確認方案與實際用量，再決定急不急。
- 同專案還有正見／ditrust 在用，Realtime 連線（Free 200／Pro 500）與訊息配額是共用的。

### 1.4 「前端零金鑰」紅線：查證結果

紅線出處：`docs/SUPABASE.md` 的「紅線：前端不放任何金鑰」（含 Supabase anon／publishable key，起因是以前 Vite 的設定讓金鑰進過前端）。

查證：**目前前端與 App 都沒有任何 key。**

| 檢查項 | 結果 |
|---|---|
| `web/js/api.js:5` | 只有 `SUPABASE_URL`（位址，不是金鑰）。`apiFetch` 只加 `Authorization: Bearer <使用者 token>`（api.js:147），從不送 `apikey` |
| 登入 | 純網址導向 `/auth/v1/authorize?provider=google&redirect_to=…`（api.js:58-64），不需 apikey |
| 換新 token | 走 `irori-api` 的 `auth/refresh`（api.js:99），**apikey 由後端帶**（index.ts:296） |
| 前端唯一持有的憑證 | 使用者自己的 access／refresh token，存 `localStorage`（api.js:21-28） |
| `web/chat/`、`web/js/phone/` | 一樣只用 `apiFetch`／`createInbox`，沒有任何 key |
| Android | `Api.kt:16-17` 只有 `SUPABASE_URL`／`API_BASE`；`loginUrl()` 不帶 key；README 寫「App 裡不放任何金鑰」 |
| 全文搜尋 | 在 `web/`、`android/`、`tools/`、`tests/`、`cloudflare/`、`relay/` 搜 `eyJ…`（JWT）、`sb_publishable`、`AIza…`、`apikey`、`anon`：只有 `web/relay/SKILL.md` 一句「不需要任何 JWT 或 apikey」、以及 `MainActivity.kt` 的 `elapsedRealtime` |
| 本 repo 歷史 | `git log -S"apikey" -- web android` 只有上面那個 SKILL.md；沒有 `VITE_SUPABASE` |
| `SUPABASE_ANON_KEY` 的使用處 | 只在後端環境變數：`index.ts:296`（換 token）、`inbox.ts:258`（函式內訂門鈴） |
| 小尾巴 | `index.ts:36` 的 CORS 還允許 `apikey` 標頭，是舊設計遺留，無害 |
| 機器端 | 夥伴機器（`relay/machine`）有 `anon.key` 訂門鈴（進度表 #65），那是各自電腦上的程式，不算前端 |

**這代表：前端到 Supabase 的資料連線，目前只有「經過 irori-api」這一條。** 任何讓前端直連 Supabase Realtime 的方案，都是第一次打破這件事。

Firebase 這邊：`firebase.json` 只有 Hosting，`web/` 沒有任何 Firebase 設定；Firebase 專案是 `irori-xisu`（`.firebaserc`）。

### 1.5 缺口：到底是傳輸問題還是資料問題

`SPEAKER.md:61-67` 的 5 個缺口，加上我多發現的 2 個：

| # | 缺口 | 根因 | 屬於 |
|---|---|---|---|
| 1 | 在 3D 頁自己說話，別台 3D 頁看不到字幕、不做手勢 | 後端對 `from_3d` 不推話（`relayPlan`，speak_elsewhere.ts:28-35；index.ts:184） | 資料模型（缺「鏡像」事件與 `origin_client` 去重鍵） |
| 2 | App 在 3D 房間沒顯示時自己唸，3D 頁沒有字幕 | 話不推給 3D 頁（App 若帶 `speak_elsewhere` 自己就不唸） | 資料模型（缺「只顯示、不出聲」的推送） |
| 3 | 閒晃動作別台只瞬移到終點 | wander 是 leader 本機亂數（wander.js:5、main.js:371），只有結果存進 state | 資料模型（缺 `behavior` 事件）。注意事件很稀疏：每分鐘最多 1 次、每個只是「去哪、什麼姿勢」的描述，各台自己算路徑 |
| 4 | 開機打招呼各台各打一次 | 去重只靠 `localStorage`（greet.js:7-26），跨裝置無效 | 資料模型（缺跨裝置 claim；`irori_claim` 現成） |
| 5 | 靜音播放的節奏是估的（每字 200ms） | say_policy.js `mutedHoldMs` | **唯一真的和傳輸有關**：要精準得靠出聲那台逐句回報，是高頻、暫態、裝置對裝置的小訊號 |
| 6 | speaker 關頁／切背景後最長 3 分鐘沒人出聲（新發現，**依程式推論，未實測**） | 3D 頁切背景只是中斷請求、不告知後端（inbox.js:96-97），全 `web/` 沒有 `pagehide`／`keepalive`；`liveSpeaker` 要等 `DEVICE_TTL_S=180` 才判死（speaker.ts:13、34），期間推送都蓋 `speaker_client=那台` 但那台不會唸（main.js:332 背景分頁不處理）；其他台的 `touchDevice` 要等它失效才接手（speaker.ts:42） | 資料／協定（缺「我要走了」訊號）。onDisconnect／WebSocket 關閉能天然解，但前端補一個 `visible=0` 就夠 |
| 7 | 輪詢負載（1.3） | 每個週期都做完整維護 | 成本 |

結論：缺口 1～4、6 **換任何傳輸都不會自動解掉**；缺口 5 只有「暫態廣播」類方案有價值，但價值低（字幕差 1 秒左右）。

## 2. 四個方案

通用前提：Supabase 永遠是真相來源（`updates_log`＋`since` 游標＋`seq` 去重）。任何推送管道都只能是「提示」，裝置重連後一律用 `GET /updates?since=` 對帳，否則斷線就漏訊。

### 方案 1：Supabase Realtime 直接帶內容

**形態 1a（Broadcast，建議的做法）**：資料庫端在 `irori_updates_push` 的同一個交易裡呼叫 `realtime.send()`，把這則事件的 JSON 送到私有頻道 `irori:<uid>`；前端與 App 直接訂這個頻道。

- **延遲（估）**：後端到前端 0.1～0.4 秒；比現在省掉「喚醒函式→再讀資料庫→組回應」的 0.2～0.7 秒。
- **可靠度**：Broadcast 是盡力送達，不保證不漏。官方有「重播」功能，但只限私有頻道、要給 `since`、最多 25 則、只含資料庫端 `realtime.send` 的訊息、保留 72～96 小時；公開頻道沒有重播。客戶端要自己做心跳（至少每 25 秒）與斷線重連（官方範例退避 1、2、5、10 秒）。所以 **`updates_log`＋`since` 必須保留**，每次重連打一次 `GET /updates?since=<seq>&wait=0` 補洞，並以 `seq` 去重。
- **安全**：
  - **WebSocket 網址必須帶 `apikey` 查詢參數**（官方 Realtime Protocol 文件：「API key is a required query parameter」）。前端就得持有 anon／publishable key → **抵觸紅線，要小良哥裁示**。
  - 官方文件沒說明能不能拿**使用者的 access token** 當 `apikey` 用。這件事可以用半小時實驗判定（用 `wscat` 帶使用者 token 當 apikey 連連看，**我沒做，因為不能碰金鑰與登入憑證**）；若可行，紅線問題就消失，但不改變下面的結論。
  - 現在的門鈴是 **public 頻道**（inbox.ts:207 `private:false`），頻道名由使用者 id 雜湊（state.ts:87-90）。因為不帶內容，洩漏頂多是「有事發生」。**一旦帶內容，必須改成私有頻道＋RLS**，否則任何持有 anon key、知道頻道名的人都收得到，**而且也能發**（偽造 say）。
  - RLS 要寫在 `realtime.messages`，這張表是**整個專案共用**；同專案的正見／ditrust 使用者用 Google 登入也會拿到 `authenticated` JWT，所以 policy 不能只寫 `to authenticated`，必須釘死 owner uid（或查一張 owner 清單表）。現在 irori-api 是靠 `IRORI_OWNER_EMAILS`＋`email_confirmed_at` 把關（index.ts:51、80），policy 要做到等效。
  - 私有頻道的 JWT 會到期，必須定期送 `access_token` 事件續期，否則頻道被關（官方協定文件）。前端現有的換新邏輯（api.js:94-124）要多接一條。
- **改動範圍**：
  - 前端：`inbox.js` 新增 Phoenix 協定的 WebSocket 客戶端（約 100 行，`inbox.ts:175-223` 已有一份後端版可照抄）或引入 supabase-js（又是一個 key 持有者）；`api.js` 要有 key。
  - 後端：新 migration（`realtime.messages` policy、`irori_updates_push` 加 `realtime.send`）；`/updates` 保留，作為對帳與排程器。
  - Android：`BubbleService` 另加 OkHttp WebSocket＋Phoenix 協定（或 supabase-kt），兩個 WebView 各自照網頁版。
- **成本**：Pro 含 500 連線／500 萬訊息、Free 含 200 連線／200 萬訊息；個人用遠低於，但和正見共用額度。Broadcast 單則上限 Free 256 KB／Pro 3 MB，夠用。
- **解缺口**：1、2、3 部分（事件仍要設計）；5 可做（客戶端可直接 send）；6 可用 Presence 解；4 無關。

**形態 1b（Postgres Changes，訂 `irori` 的表）：不採用。**
- `updates_log` 是**單一列 jsonb**（03_irori.sql:15-21、146-171），每次 push 整列（最多 50 則）都變成一則變更事件，payload 放大約 50 倍；`irori_updates_since` 每次讀都寫 `pending` 列（03_irori.sql:303），會產生一堆噪音事件。
- 要用就得新建 `irori.events`（一列一事件）、加入 `supabase_realtime` publication、對 `authenticated` 開 SELECT＋RLS——和 `03_irori.sql:6、33` 的設計原則（schema 不給 anon／authenticated 任何權限、只走 SECURITY DEFINER 函式）相反。
- 官方文件：Postgres Changes 對每位訂閱者逐一授權、單執行緒處理，並建議大規模改用 Broadcast；單人使用規模不是問題，但複雜度比 1a 高，同樣要 `apikey`。

### 方案 2：自建 WebSocket

**2a：Edge Function 當 WebSocket 伺服器（`Deno.upgradeWebSocket`）**
- 官方支援，但：Edge Function 牆鐘上限 Free 150 秒／付費 400 秒，要定期重連（比現在 25 秒稀疏 6～16 倍）；**實例之間不共享記憶體**，別台裝置的推送要傳到這個實例，還是得靠 Realtime 門鈴或資料庫輪詢——等於把 `waitBell`（inbox.ts:175）換個位置，什麼都沒省。
- 瀏覽器的 WebSocket 不能帶 `Authorization` 標頭，token 只能放網址或 `Sec-WebSocket-Protocol`（網址會進日誌）；`apiFetch` 的 401 換新重送邏輯（api.js:158-165）用不上。
- 如果真的想要「連著不斷」，**SSE 比 WebSocket 更適合這個環境**：用 `fetch` 串流、`Authorization` 標頭照舊、`/chat` 已經在用（Sse.kt、index.ts 的 `chat()`），Android 已有解析器。這是方案 3 裡階段 2 的選項（見 6）。
- 結論：不採用。

**2b：另起服務——Cloudflare Durable Object（每位使用者一個房間）**
- 技術上最契合「每人一個房間」：能帶內容、做逐句暫態廣播（缺口 5）、連線關閉即離線（缺口 6）、自帶重播緩衝。專案已經有 Cloudflare Worker 與 wrangler 流程（`cloudflare/edge-tts/`），不算全新供應商。
- 但：後端每次 push 要再 HTTP 通知 DO（**雙寫**，失敗要補償）；驗證要自己做（irori-api 驗過 Supabase JWT 後簽發短效 ticket，Worker 用共用 secret 驗，secret 命名 `IRORI_*`）；多一套部署、監控、secrets；Workers／DO 的免費額度與計費**我沒有查證**，採用前要先確認。
- 紅線：前端只持有 ticket（使用者憑證的一種），不持有 key，**不抵觸**。
- 它仍然沒有解掉缺口 1～4、6 的資料模型問題，也同樣要搬排程。**現在不做**；只有出現「毫秒級裝置間同步」（逐字字幕、嘴型同步）的需求才值得重新評估。

### 方案 3：維持長輪詢＋門鈴，只補缺口

- **延遲（估）**：門鈴一響到前端收到約 0.4～1.2 秒（REST 廣播約 0.1 秒＋函式喚醒再讀 2～3 次資料庫＋回應）。沒有敲鈴的路徑最壞等一個週期（≤25 秒）。已知敲鈴點：`PUT /state`（state.ts:67）、`relaySpeech`（speak_elsewhere.ts:47）、來信（irori-relay/index.ts:222）；提醒靠各台自己的計時（inbox.ts:268 `waitLimit`）。#109 正在補「換 speaker 時敲鈴」。
- **可靠度**：已經夠硬——游標＋`seq`＋先查再訂（phx_reply ok 後補查一次，inbox.ts:215）涵蓋「查完到訂好」之間的空窗；斷線就是下一次請求，天然重連；漏訊靠 `since` 補回；去重靠 `seq`。
- **安全**：維持現狀，前端零金鑰，後端驗 JWT＋email 白名單（index.ts:53-83）。
- **改動範圍**：前端少量（鏡像／behavior／greet 三處，6 的階段 1）、後端少量（`relayPlan` 新模式、2 個小端點）、Android 少量（`origin_client` 比對，`VoiceRoute.kt`）。**不動傳輸層、不動 schema（可選）、不動紅線。**
- **成本**：沒有新費用；階段 0 的減負反而會讓用量下降。
- **解缺口**：1、2、3、4、6 都解得掉（做法見 6）；5 不處理（接受誤差）。

### 方案 4：Firebase Realtime Database（RTDB 只放指標）

小良哥的前提：RTDB 不放機敏資料，只放 1、2 筆。照這個前提，設計如下：

- 每位使用者一個節點 `/p/<hash>`＝`{ seq, state_seq, speaker, at }`（`hash` 同 `stateTopic` 的作法，由後端在 `/updates` 回應裡下發，前端不需要知道 owner uuid）。內容（say、聊天、信、記憶）一律不進 RTDB。
- 裝置監聽這個節點；`seq` 變大就 `GET /updates?since=<local>&wait=0` 拉真正內容。**Supabase 先寫、RTDB 後寫**，RTDB 寫失敗只記 log；前端留一個 60～120 秒的保底輪詢。

**授權怎麼接（兩條路）**

| | 路線 A：公開讀的不可猜路徑（建議的做法） | 路線 B：Firebase Auth custom token |
|---|---|---|
| Rules | `{"rules":{".read":false,".write":false,"p":{"$h":{".read":true,".write":false}}}}`；後端用服務帳戶寫（Admin 身分不受 Rules 限制） | `"$uid":{".read":"$uid===auth.uid"}`；寫入仍只有後端 |
| 前端怎麼連 | 瀏覽器原生 `EventSource('https://…firebasedatabase.app/p/<hash>.json')`，**不需要 SDK、不需要 Auth、不需要 apiKey**；Android 用 OkHttp 串流 | irori-api 驗 Supabase JWT 後簽 custom token（RS256，Deno 自己簽，約 40 行），前端 `signInWithCustomToken`。**SDK 初始化與 identitytoolkit 都要 Firebase Web `apiKey`** |
| 紅線 | 前端只有資料庫網址（和 `SUPABASE_URL` 同性質），**不抵觸** | 前端要持有 `apiKey`。它是公開識別碼、可用網域／套件限制，但小良哥的紅線寫「前端零金鑰」，**要裁示**；「由後端 `/status` 下發」只是不進 repo，前端還是拿得到，**不能當作符合紅線** |
| 洩漏面 | 知道路徑的人能讀到 4 個值（序號、speaker 的 client_id、時間）。等同現在 public 門鈴頻道（state.ts:87-90）的曝險，不含任何內容 | 只有本人能讀 |
| 能做 onDisconnect 在線偵測嗎 | **不能**（要客戶端寫入，得開放寫入權限，等於路徑變成金鑰） | 能（客戶端可寫 `presence/<uid>/<client>`），但要 apiKey |

**後端（Deno）要做的**：服務帳戶 JSON 放 secret（`IRORI_FIREBASE_SA`、`IRORI_FIREBASE_DB_URL`）；用它簽 JWT 換 Google OAuth2 access token（快取約 55 分鐘）；對 `PUT /p/<hash>.json?access_token=…`。約 60 行，掛在「所有 push 與敲門鈴的地方」（`irori_updates_push` 的呼叫端、`ringStateBell`、speaker 變更）。

- **延遲（估）**：後端寫 RTDB 0.1～0.3 秒＋推到前端 0.1～0.3 秒，**之後還要多一次 `GET /updates`（0.3～0.8 秒）才拿到內容**。合計 0.5～1.4 秒，**不比現在快**——因為「只放指標」讓第二跳還在。要縮短得另做一條輕量的 `/updates` 讀取路徑（跳過維護）。
- **可靠度**：RTDB 是「同步狀態」而不是訊息：重連後客戶端一定會收到最新值，所以天然不漏提示；Android SDK 的斷線重連成熟。但只放指標時，離線快取沒有意義（沒有內容可快取）。保底輪詢仍要留。
- **Android**：官方 SDK 有重連與離線持久化，但需要 `google-services.json`（含 API key），和 Android README 的「App 裡不放任何金鑰」衝突；走 REST 串流就不衝突，但重連要自己寫（簡單）。
- **成本**：Spark 免費：100 同時連線、1 GB 儲存、10 GB／月下載；這個用量遠低於。不需要 Blaze。需先在 Console 建立 RTDB 實例、選區域（離台灣近的）。REST 串流連線是否計入 100 連線上限，官方文件沒寫明，請當作計入。
- **維運代價**：多一家供應商的 Rules、服務帳戶金鑰輪替、區域與配額；多一條「Supabase 寫成功、RTDB 寫失敗」的不一致情境（有保底輪詢就不致命）。
- **跟 Supabase Realtime 門鈴比，「只放指標」之後還剩哪些好處**：
  1. **前端零金鑰地直接收到推送**（路線 A）——這是方案 1 做不到的；
  2. 不需要等「函式被呼叫再喚醒」，閒置時不必每 25 秒打一次完整維護；
  3. 重連自動給最新值（同步狀態語意）；
  4. 免費、Firebase 專案已經存在（Hosting）。

  **沒有了的**：onDisconnect 在線偵測（要客戶端寫入，見上表）、離線內容快取（沒有內容）、Android SDK 的持久化（SDK 要放 key）。
- **解缺口**：6 在路線 B 可解、路線 A 不行；1～5 都不解（只是通知管道）。**而且它不能取代長輪詢**（1.2），所以會變成兩條通知路徑並存。

## 3. 總比較

| | 方案 1 Supabase Realtime 帶內容 | 方案 2a Edge Function WS | 方案 2b Cloudflare DO | 方案 4 RTDB 指標 | 方案 3 長輪詢＋門鈴（現狀＋補缺口） |
|---|---|---|---|---|---|
| 推送延遲（估） | 0.1～0.4 s | 0.2～0.6 s | 0.05～0.3 s | 0.5～1.4 s（要再拉一次） | 0.4～1.2 s |
| 斷線重連與漏訊 | 要自己重連；漏訊靠 `since` 對帳 | 同左，且 ≤150 s 就得重連 | 自帶重播緩衝，仍建議對帳 | 重連給最新值；保底輪詢 | 已完備（游標＋seq） |
| 去重 | `seq` | `seq` | `seq` | `seq` | `seq`＋`origin_client`（新增） |
| 前端零金鑰 | **否**（握手要 apikey；用使用者 token 代替待實驗） | 是（但 token 進網址） | 是（ticket） | 路線 A 是；路線 B 否 | 是 |
| 授權複雜度 | 高（`realtime.messages` RLS、共用專案、JWT 續期） | 中 | 中（ticket 簽發與驗證） | 低（A）／中（B） | 無新增 |
| 改動：前端 | 新 WS 客戶端＋key | 新 WS 客戶端 | 新 WS 客戶端 | EventSource＋保底輪詢 | 三處小改 |
| 改動：後端 | SQL＋policy＋push | 新 WS 端點 | 新服務＋雙寫 | 簽 token／寫 RTDB＋Rules | `relayPlan`＋2 個小端點 |
| 改動：Android | WS＋Phoenix | WS | WS | OkHttp 串流（或 SDK＋key） | `origin_client` 比對 |
| 新費用／新供應商 | 否（共用額度） | 否 | 是（計費未查證） | 是（Spark 免費） | 否 |
| 取代排程器要做的事 | 要搬 | 要搬 | 要搬 | 要搬 | 不用 |

## 4. 缺口對照（誰解得掉）

「解」＝這個方案本身就能解；「還要設計」＝傳輸幫得上忙，但事件與去重鍵照樣得先做。

| 缺口 | 方案 1 | 方案 2a | 方案 2b | 方案 4 | 方案 3 |
|---|---|---|---|---|---|
| 1 自己說話別台看不到 | 還要設計 | 還要設計 | 還要設計 | 無關 | **解**（`mirror` 事件） |
| 2 App 自己唸、3D 無字幕 | 還要設計 | 還要設計 | 還要設計 | 無關 | **解**（`mirror_text`） |
| 3 閒晃只瞬移 | 還要設計 | 還要設計 | 還要設計 | 無關 | **解**（`behavior` 事件） |
| 4 開機各打一次招呼 | 無關 | 無關 | 無關 | 無關 | **解**（`irori_claim('greet')`） |
| 5 靜音節奏估算 | 解（客戶端直送） | 還要設計 | 解 | 無關 | 不解，接受誤差 |
| 6 speaker 關頁空窗 | 解（Presence） | 解（連線關閉） | 解 | 路線 B 解／路線 A 不解 | **解**（前端補 `visible=0`） |
| 7 輪詢負載 | 要搬排程才解 | 要搬排程 | 要搬排程 | 要搬排程 | 解（階段 0、2 的減負） |

## 5. 建議（只有一個）

**採用方案 3：維持長輪詢＋門鈴，不換傳輸層；用新增事件種類補缺口 1～4、用前端補一個訊號解缺口 6、用兩個小改動壓低輪詢負載。**

為什麼不是換掉它：

1. 缺口都是資料模型問題（1.5），換傳輸一個都不會自動解；
2. 長輪詢是排程器（1.2），換掉等於同時重做排程；
3. 目前 0.4～1.2 秒（估）的推送延遲，對「字幕與動作跟上」已經夠用；缺口 5 的 1 秒誤差不值得為它引入新管道；
4. 方案 1 要打破紅線（或要賭一個未驗證的做法）；方案 4 可以零金鑰，但只放指標之後延遲沒有更好、還要雙寫與多一家供應商；方案 2b 是最完整的設計，但是工程量最大、現在的需求用不到。

**保險條款（不是第二個選項，是「什麼情況下回頭重評」）**：階段 0 量到任一條才重評——(a) 推送到收到的 p95 超過 2 秒；(b) 減負之後 Edge Function 用量仍超過方案額度 60%；(c) 小良哥明確要毫秒級的裝置間同步。屆時 (a)(b) 的第一選擇是方案 4 路線 A（零金鑰、最小、免費），(c) 重評方案 2b。

## 6. 分階段落地

每階段獨立可上線、可回退；每項都要先寫測試（Deno 測試，比照 `speaker_test.ts`、`updates_speaker_test.ts`；前端純邏輯比照 `tests/say_policy.test.mjs`）。

### 階段 0：量測與止血（半天，不改行為）

1. **量延遲**：`/updates` 回應多帶 `server_now`（秒）；前端與 App 收到結果時記 `server_now - item.at`（後端處理段）與本機收到時間，累積一週看 p50／p95。`at` 本來就在每則事件裡（03_irori.sql:146-171 的 push 會蓋）。
2. **修缺口 6**：3D 頁在 `visibilitychange`→hidden 與 `pagehide` 時，用 `fetch(…, { keepalive: true })` 送一次 `GET /updates?…&visible=0&wait=0`（`apiFetch` 可帶標頭，不必用 `sendBeacon`；不能帶標頭的才是它的限制）。後端**不用改**：`liveSpeaker` 已經把 `visible===false` 視為失效（speaker.ts:34），其他台下一次輪詢就接手（speaker.ts:42）。Android 在 `paused`／`roomShowing` 變化時也立刻送一次 `visible=0`。`DEVICE_TTL_S` 先不動。
   **【3D 頁已做；Android 還沒做；尚未部署】** 實作時改了一處：不送 `GET /updates?…&visible=0&wait=0`，改送新的 `POST /device?client_id=…&kind=…&visible=0`（只呼叫 `touchDevice`）。原因：`/updates` 就算 `wait=0`、沒帶 `since`，進場一樣會 `ensureProcessed`（拉 inbox、呼叫模型轉述、ack）與補講提醒，產生的結果只回給正在關閉的頁面，之後新開的頁面（不帶 `since`）看不到，等於把來信吃掉；`POST /device` 沒有這個副作用，也不打 irori-relay。Android 要改送 `POST /device`（`SPEAKER.md`「App 端需要的配合」）。`/chat` 獨立頁不帶 `client_id`、不是出聲裝置，不需要送。
3. **減負兩項**：`relay.bellTopic()` 快取 10 分鐘（relay.ts:151-153，一行）；inbox 拉取加節流——進場那次 `ensureProcessed`（inbox.ts:250）只在「`away`、或這次請求不會進入等待、或距上次拉取超過 120 秒」時做（進入等待的請求，訂好門鈴後本來就會補查一次，進場那次是重複的）；補查那次也用 kv 時間戳擋掉「20 秒內別台剛拉過」的情況（同樣的原則，`DESIGN.md:73、84` 對夥伴機器端的橋已經採用：門鈴＋每 2 分鐘補拉）。預期每週期 irori-relay 呼叫從約 3 降到 ≤1。
   **【已做；尚未部署】** `bellTopic()` 快取 10 分鐘（失敗不快取）；拉取時間戳放 kv `inbox_pulled_at`＝`{at, bell}`。門鈴**真的響**一律拉，只節流「訂好後的補查」（`waitBell` 現在把補查與真響分開傳給 `onRing(topic, real)`）。補查只認「別人在門鈴守著時拉的」（`bell: true`）那種時間戳：進場那次不在門鈴守著，不算，免得訂好門鈴前來的信被漏掉。補查被擋時若別台正在拉，會等它做完再讀結果。決策抽成 `shouldPullOnEntry`／`shouldPullOnBell`，測試在 `inbox_throttle_test.ts`。**殘留的窗口**：補查被擋、而前一次拉取的請求已經提早結束（狀態門鈴喚醒）時，兩個請求交接的那 1～2 秒內來的信會漏掉門鈴，最久約 25～30 秒後的下一次補查才拉到（沒有人會漏信，只是慢）。
4. 到 Dashboard 確認方案與用量，記下基準。

驗收：階段 0 之後一週，p95、每日呼叫數、「關掉 speaker 那台後最久多久有別台出聲」三個數字有紀錄。

### 階段 1：補資料模型缺口（各 ≤1 天，彼此獨立）

1. **缺口 4：打招呼跨裝置去重**。新增 `POST /greet/claim`→`irori_claim('greet', 1800)`（03_irori.sql 現成函式，TTL 30 分鐘）；`main.js:247` 的 `greetDue()` 通過後再問後端，搶不到就不打招呼。最簡單，先做。
2. **缺口 3：閒晃重演**。leader 在 `doBehavior`（main.js:371 附近）同時 `POST /behavior`→push `{type:'behavior', origin_client, spec, ttl_s:30}` 並敲狀態門鈴；其他 3D 頁照同一個 `doBehavior(spec)` 做（真的走過去，而不是瞬移），超過 `ttl_s` 的丟掉（和 `chatSayStale` 同型，main.js:312）。**前置條件**：重演不能寫回 state——`actions.js:25、37、44、65` 都會 `saver.update`，各台重演就各自 `PUT /state`、`state_seq` 連跳、狀態門鈴連響；要加 `{ replay: true }` 旗標跳過寫回。（這個風險**現在就存在**：靜音播放照做 `[outfit:]`／`[scene:]`／body 動作時，非出聲的 3D 頁也會各自寫回。）
3. **缺口 1、2：鏡像**。後端 `relayPlan`（speak_elsewhere.ts:28-35）新增 `mirror` 模式：3D 頁自己送話（及 App 帶 `mirror_text:true` 時）也推 `{type:'say', origin:'mirror', origin_client, mode:'caption'}`；`origin_client` 等於自己的 client_id 就丟棄（已經在本機做過）；其他 3D 頁一律 `mute`，不看 `speaker_client`（`sayPlan`，say_policy.js 加一條）。App 端 `shouldSpeakSay`（VoiceRoute.kt:17）對 `mode:'caption'` 一律不唸。**第一版整段回覆結束才推**（字幕比聲音晚到，因為 index.ts:184 在串流結束後才呼叫）；若覺得太晚，再改成串流中每句推一則（每輪最多 8 則，遠低於聊天每小時 120 次的限額）。
4. **缺口 5**：不處理。記為已知限制；真覺得難受再議。

驗收：電腦＋手機同開，逐項走過 `SPEAKER.md` 的行為總表，缺口 1～4 的格子改成「已修」。

### 階段 2：成本（條件觸發，視階段 0 的數字）

1. 維護只由「最近有 presence 的那一台」做（`kv` 時間戳節流），其他台只做 `touchDevice`＋讀＋等待。
2. 若量到連線重建本身是瓶頸：`/updates` 改 SSE 長連線（同路徑、`Accept: text/event-stream`、`Authorization` 照舊；Android 已有 `Sse.kt`）。

### 階段 3：保險（只有觸發條件成立才做）

**【2026-10-03 小良哥改裁示提前做，#120】** 方案 4 路線 A 已實作，規格、約定、上線步驟見 `SIGNAL.md`（保底輪詢 300 秒、離開判斷 450 秒、speaker 存活期 400 秒、兩個 secret 都沒設時整個功能關閉）。以下是當時的規劃原文。

方案 4 路線 A：建 RTDB 實例與 Rules（只開 `/p/$h` 公開讀）、後端加 `notify()` 寫指標、前端 `EventSource` 加保底輪詢。**先在 irori-api 側加一個 feature flag，可隨時退回純門鈴。**

## 7. 風險

1. **事件擠掉重要訊息**：`updates_log` 只留 50 則／24 小時（03_irori.sql:146-171）；`mirror`（每輪對話 1～N 則）與 `behavior`（每分鐘 ≤1 則）會擠掉夥伴轉述與提醒。對策：`behavior` 與 `mirror` 的 `ttl_s` 很短，push 時優先清掉過期的；或另開一個短命的 kv（例如最近 20 則、TTL 60 秒）、獨立 seq。要先決定，否則會出現「轉述被擠掉」的隱性 bug。
2. **重演造成 state 風暴**（階段 1 第 2 項）：沒有 `replay` 旗標就會連跳 `state_seq`。上線前要用兩台實測 `state_seq` 的增量。
3. **去重鍵不一致**：`origin_client` 在網頁是 `sessionStorage` 的 UUID（lease.js:10-23，每個分頁一個）、在 App 是 SharedPreferences 的 `app-<uuid>`；同瀏覽器多分頁另有 `localStorage` 搶標記（main.js:313）。三套並存，鏡像要避免「發話那台又重播一次」或「誰都不播」，需要逐一測。
4. **數字全是估**：延遲、用量都沒實測（階段 0 的目的）。如果專案已經在 Pro，成本就不急；如果在 Free，階段 0 第 3 項要提前。
5. **紅線**：本建議不需要前端放任何 key。若日後改走方案 1 或方案 4 路線 B，必須先請小良哥裁示；「由後端下發 config」不能算符合。
6. **共用專案**：方案 1 會碰 `realtime.messages` 的 policy 與共用的連線／訊息配額，會影響正見／ditrust；方案 3 不碰。
7. **排程器依賴**：只要有人想「減少輪詢」就會誤傷提醒與收信（1.2）。階段 2 動維護路徑時，提醒與收信處理要有測試守著（`reminders_test.ts`、`partner_feed_test.ts` 現成）。
8. **缺口 6 的修法是前端單方面**：瀏覽器在 `pagehide` 時 `keepalive` 請求不保證送達（盡力而為），所以 `DEVICE_TTL_S` 的兜底仍要留；崩潰、斷網還是最長 180 秒。

## 8. 附錄：查證來源與未驗證事項

查證日 2026-10-02，官方文件：
- Supabase Realtime 限制：https://supabase.com/docs/guides/realtime/limits （Free 200 連線／100 訊息每秒／Broadcast 256 KB；Pro 500／500／3,000 KB；Postgres Changes 1,024 KB）
- Realtime Authorization（私有頻道、`realtime.messages` RLS）：https://supabase.com/docs/guides/realtime/authorization
- Realtime Protocol（`apikey` 必填、`access_token` 續期、心跳 ≤25 秒、退避）：https://supabase.com/docs/guides/realtime/protocol
- Broadcast（`realtime.send`、重播 `since`／最多 25 則／72～96 小時）：https://supabase.com/docs/guides/realtime/broadcast
- Postgres Changes 限制：https://supabase.com/docs/guides/realtime/postgres-changes
- Edge Functions WebSocket：https://supabase.com/docs/guides/functions/websockets ；限制（牆鐘 Free 150 s／付費 400 s、idle 150 s、CPU 2 s、記憶體 256 MB）：https://supabase.com/docs/guides/functions/limits
- Supabase 定價（Edge Function 呼叫 Free 50 萬／Pro 200 萬；Realtime 連線 200／500；訊息 200 萬／500 萬）：https://supabase.com/pricing
- Firebase RTDB 限制與定價（Spark：100 同時連線、1 GB、10 GB／月）：https://firebase.google.com/docs/database/usage/limits ，https://firebase.google.com/pricing
- RTDB REST 串流（SSE、`put`／`patch`／`keep-alive`、公開讀不需 auth）：https://firebase.google.com/docs/database/rest/retrieve-data
- RTDB Rules（公開讀、禁止寫）：https://firebase.google.com/docs/database/security/rules-conditions
- Firebase custom token（服務帳戶簽、1 小時、可不用 Admin SDK）：https://firebase.google.com/docs/auth/admin/create-custom-tokens

**未驗證／只是推論**（採用相關方案前要先確認）：
1. 使用者 access token 能不能直接當 Realtime 握手的 `apikey`（官方文件沒說）。
2. `signInWithCustomToken` 一定要 Firebase Web `apiKey`——這是我對 SDK 行為的認識，官方那頁沒有明寫；若要走路線 B，先做一次最小實驗。
3. 管理身分（服務帳戶）繞過 RTDB Rules——Admin SDK 的已知行為，這次抓的 Rules 文件頁沒有明寫。
4. REST 串流連線是否計入 Spark 的 100 同時連線。
5. Cloudflare Workers／Durable Objects 的免費額度與計費。
6. 缺口 6（speaker 空窗）是讀程式推論，沒有在兩台裝置上實測。
7. 所有延遲與每月呼叫數。
