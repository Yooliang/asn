# 同一句只由一台裝置唸（speaker 協定）

小良哥可能同時開著電腦 3D 頁、手機 App 泡泡、App 內 3D。後端推來的 say（夥伴回信、提醒、從 /chat 獨立頁送話的轉唸）
只由「小良哥最近互動的那一台」出聲；動作（`actions`）所有 3D 頁照做，畫面才一致。

## 出聲裝置要做的事（App 端）

1. 自己有一個 `client_id`（字串，最長 64，每次安裝／啟動固定即可）與 `kind`：3D 頁是 `3d`，Android App 是 `app`。
2. 輪詢 `GET /updates` 時加查詢參數：`client_id=<id>&kind=app&visible=1`。
   `visible=1`＝現在可以出聲（泡泡在顯示、或 App 在前景）；不能出聲就送 `visible=0`，或乾脆不輪詢。
   **暫時看不見時說一聲**：泡泡收起、App 進背景、鎖屏、分頁切走的那一刻送一次 `POST /device?client_id=<id>&kind=app&visible=0`（參數同 /updates，帶授權標頭，回 `{"ok":true}`）。
   **出聲裝置不會因此換給別台**——只有使用者碰觸／說話才換台。這支只更新裝置紀錄，不收信、不補講提醒。
   **真的離開**（網頁分頁關掉 pagehide、泡泡服務結束）再送 `POST /device?...&gone=1`。其餘參數：`host=<同一支手機的泡泡 client_id>`（App 內的 3D 頁帶）、`tv=1`（電視版 App）。
3. 送 `POST /chat` 時，body 多帶 `"client_id": "<id>", "client_kind": "app"`（使用者在這台發話，這台就成為 speaker）。
   /chat 獨立頁不出聲，不帶這兩個欄位。
4. 收到的 say 有 `speaker_client` 欄位時：
   - `speaker_client == 自己的 client_id` → 唸出聲
   - 否則 → 不唸（text 當作背景資料，動作若是 3D 才執行）
   - 沒有 `speaker_client` 欄位（後端找不到活著的 speaker）→ 照舊規則

## 後端怎麼選 speaker

- kv `dev:<client_id>`＝{kind, at, visible, form?, host?, tv?, gone?}，每次帶 client_id 的 `/updates` 或 `/device` 都更新。
- kv `speaker`＝{client_id, kind, at}＝最後被碰／說話的那台；kv `speaker_recent`＝最近被碰過的幾台（新的在前）。
- **誰出聲（`liveSpeaker`，讀的時候才算）——出聲裝置只在使用者「碰觸／說話」時換台，離開不換**：
  1. `/chat` 帶 client_id＋client_kind、或 `POST /device?interact=1`、或 `speak_via` → 該台成為 speaker。
  2. **暫時看不見**（`visible=0`：鎖屏、切背景、小視窗收起、分頁切走、電腦螢幕關了）：speaker 不動。
     手機 App 內的 3D 頁（全畫面、懸浮小視窗、子母畫面）帶 `host`＝同一支手機的泡泡，看不見時由那個泡泡代唸（`speaker_client` 填泡泡的 id，泡泡在鎖屏也能唸）；
     電腦分頁切走（沒有 host）→ 仍指向它、沒人唸，各台只顯示字幕、話記在聊天紀錄。
  3. **真的離開**（`gone=1`、可見卻超過 180 秒（訊號模式 400 秒）沒回報、暫時看不見超過 12 小時完全沒消息、泡泡也死了的 3D 頁）：交給「最近使用、還活著的手機泡泡」（kind app、不是電視）；手機也不在就不指定（不帶 `speaker_client`），下一台可見的出聲裝置輪詢時接手。
  4. 電視（`tv=1`）視為固定裝置，跟電腦同一套：遙控器對電視說話＝碰觸；電視關閉＝真的離開，回手機。
  5. 從 /chat 獨立頁發話不改 speaker。
  舊客戶端沒有 `gone`、`host`：只靠心跳逾時判離開；手機鎖屏時沒有泡泡代唸（仍指向那個 3D 頁、沒人唸）。
- 推送 say 時（夥伴回信、提醒、speak_elsewhere）加 `speaker_client`＝推送當下的出聲裝置（上面第 2 點時是泡泡的 id）。
- **換人立刻通知**：`/chat` 讓 speaker 換成另一台時（新的 client_id 跟原本記的不同），後端敲一次狀態門鈴（跟 `PUT /state` 同一個），各台等待中的 `/updates` 長輪詢馬上回來、帶新的 `speaker_client`（3D 頁據此即時換時間的深色底）。同一台連續說話不敲。長輪詢進來時先記當時的 speaker，門鈴一響就比一次，換了才回。發話那台 3D 頁另外在送出時先本機樂觀切成 speaker，之後仍以 `/updates` 為準。
- 實作：`supabase/functions/irori-api/speaker.ts`，測試 `speaker_test.ts`。

## 靜音播放（不是出聲裝置的 3D 頁）

原則：**出聲只有一台，但每一台 3D 畫面都顯示字幕、做同樣的表情／手勢／動作**。

- 3D 頁收到 say，用 `web/js/say_policy.js` 的 `sayPlan(job, 自己的 client_id, claim)` 決定要不要出聲：`speaker_client` 是別台、或同瀏覽器沒搶到「唸過了」標記的分頁 → `mute`。
- `mute` 的句子照樣走 `speakText`（同一套標籤解析，沒有另寫一份），字幕、`[happy]`／`[wave]` 這類表情手勢、`[outfit:]`／`[scene:]` 等動作片段與 `actions`（body／motion）都照做；差別只在 `createSpeaker`（`speech.js`）對 `mute` 句子不呼叫 TTS、不播聲音、**嘴巴不動**（沒聲音卻對嘴很怪，也省資源），改成停留 `mutedHoldMs(text)`（每字 200ms，0.7～12 秒）再接下一句，節奏跟出聲那台接近。
- 以前的作法是把 text 清成空字串，連字幕與文字裡的標籤都一起沒了，現已改掉。

## 主動說話（後端決定）

要不要講、什麼時候講、由哪一台出聲，**全部由後端決定**；前端不再自己擲骰、也不再送「主動說話的 /chat」。實作：`supabase/functions/irori-api/proactive.ts`（流程）、`proactive_gate.ts`（狀態與閘門）、`proactive_deps.ts`（真實依賴），測試 `proactive_test.ts`、`tests/proactive_tick.test.mjs`。

### 流程

1. 前端（`web/js/proactive_tick.js`）：這台是 leader、看得到畫面、沒在想／講／按住說話時，約每 60 秒 `POST /proactive/tick`（帶 `client_id`、`kind`、`visible`，以及跟 `/chat` 同樣的世界資訊：`outfit`／`scene`／`posture`／`home`／`targets`／`standing_only`／`name`／`user_name`／`from_3d`）。回應 `{ok, speaking, skipped?, next_tick_s}`，下次間隔採後端建議（夾在 30～600 秒）。永遠回 200，前端不用處理錯誤。
2. 後端 `decide` 依序判斷（任何一步不符合就回 `skipped`，**零副作用**：不呼叫模型、不存世界資訊、不寫 history、不推給別台、不記帳）：

| 順序 | 條件 | skipped | 說明 |
|---|---|---|---|
| 1 | `visible=false` | `hidden` | 看不到畫面的裝置不算 |
| 2 | `state.settings.talk` ≤ 0 | `off` | 設定「不主動」就永遠不講；建議 120 秒後再看（使用者可能剛調過） |
| 2.5 | 作息處於「睡覺」固定事件時段（`routine_on`、在家裡）且沒被叫醒 | `sleeping` | 該睡就睡：不主動說話、不打招呼、不問更新，零副作用。建議等到睡覺時段結束，夾在 30～600 秒。見下節「睡覺時段」 |
| 3 | 有一輪對話正在進行 | `busy` | kv `chat_busy`：任何 `/chat` 串流或主動說話開始寫 `done:false`、結束（含出錯、取消）寫 `done:true`；超過 150 秒沒收尾視為實例掛了。建議等到忙完 |
| 4 | 最近 180 秒內使用者真的開過口 | `user_active` | kv `last_user_turn_at`：非主動說話、且不是［系統］／［通知］開頭的 `/chat`（含手機泡泡、App、`/chat` 頁、3D 頁按住說話），`/chat` 一收到就背景寫入（不等結束、不拖慢 `/chat`）。可用 secret `IRORI_PROACTIVE_QUIET_S` 調 |
| 5 | 這個擲骰時段已有別台處理 | `taken` | `irori_claim('proactive_tick', 45)` 原子鎖：多台同時送，只有第一台往下走（也等於每約一分鐘只擲一次骰） |
| 6 | 擲骰沒中 | `no_roll` | 機率 = `settings.talk`（每次擲骰的機率；設定頁「主動說話」滑桿 0～30%，預設 5% ≈ 平均 20 分鐘一次） |
| 7 | 額度用完（非管理者餘額 ≤ 0） | `no_credit` | 安靜略過，不顯示「額度用完」提示，也不佔每小時次數 |
| 8 | 超過每小時 `chat` 次數 | `rate_limited` | 跟一般對話同一個每小時上限 |

   **頻率完全依使用者設定**：沒有另外寫死「多久內不能再講」；唯一的間隔是擲骰時段（45 秒）與上面的忙碌／使用者剛開口條件。
3. 決定要講：回應立刻回 `speaking:true`，後端在背景（waitUntil）①標 `chat_busy` ②用 `resolveWorld` 補世界資訊（3D 頁來的就存起來）③用後端存的聊天紀錄＋［系統］提示（跟以前 `idle.js` 同一句話）呼叫模型（含工具，所以能走動、換姿勢；用量記在 owner 的額度上，來源類別 `proactive`、用量明細顯示「主動說話」，與 `chat` 分開看得出主動說話花了多少）④生成期間若使用者開口了，這句**不推、不寫紀錄**⑤否則照現有 say 流程推給各裝置（`origin:'chat'`、帶 `speaker_client`，speaker 那台出聲、其他 3D 頁靜音播放），並**由後端把「［系統］（你主動找…）」與她的回覆寫進聊天紀錄**（`irori_updates_push` 的 `p_turns`，跟提醒同一條路）、封存進長期記憶⑥解除 `chat_busy`。
4. 代價：話要等整段回覆完成才開口（不邊串流邊唸），多一個輪詢喚醒（後端推完會敲門鈴，通常 1 秒內）。

### 舊前端相容

還在送「主動說話 `/chat`」的舊前端（`speak_elsewhere`＋`from_3d`、不帶 `client_id`；或帶 `proactive:true`），後端套用同一套判斷（`dice=false`：骰子它自己擲過了，其餘第 2～5 步照樣套用）。不符合回 **HTTP 409** `{detail:"", skipped:true, reason, retry_after_s}`——在存世界資訊、記帳、呼叫模型之前就回，`detail` 是空字串所以舊前端的錯誤提示框也是空的（等於安靜地略過）。通過時照舊串流，但生成期間使用者開口了就不推。

### 睡覺時段（2026-10-03，小良哥裁示：「自動講話也要跟作息表，該睡就睡，除非我找他講話」）

「睡覺時段」＝作息（`routine.ts`）裡**活動名稱有「睡」字的固定事件**（預設的「睡覺」23:00～07:00，自訂的「午睡」也算），且 `routine_on` 沒關、場景在家裡（咖啡廳、海邊是帶她出去的，不睡）。`sleepEvent`／`sleepGate`（`proactive_gate.ts`）判斷。

| 情境 | 睡覺時段、沒被叫醒 | 睡覺時段、醒著視窗內 | 其他時間 |
|---|---|---|---|
| 主動說話（`/proactive/tick`、舊前端的主動 `/chat`） | **不做**，`skipped:'sleeping'`，零副作用（不擲骰、不拿鎖、不呼叫模型） | 照一般規則（仍受 busy／user_active／擲骰等約束） | 照一般規則 |
| 打招呼（`/proactive/greet`） | **不做**，`skipped:'sleeping'`，不吃 30 分鐘冷卻鎖（打開畫面不算叫醒她，要小良哥開口找她） | 照一般規則 | 照一般規則 |
| 新版本提醒 | 不問，不吃該版本的鎖（醒來後還會問） | 照一般規則 | 照一般規則 |
| 提醒到點 | **照常講**（使用者自己要的、有時間性；模板不呼叫模型，沒有額外語氣） | 照常 | 照常 |
| 夥伴來信轉述 | **延後**：不拉 inbox、不 ack，信留在仲介，一封都不會丟；起床（睡覺時段結束）或小良哥叫醒她之後，下一個 `/updates` 週期（最多約 25 秒）才拉、轉述（多封合成一則總結） | 照常轉述 | 照常 |
| 自主走位（`routine.move`） | 固定事件，維持在臥室的床上 | **不強制回床**（`plan` 的 `awake`），視窗過了又叫她回床 | 照機率時段 |

- **叫醒她**：小良哥任何裝置的使用者 `/chat`（3D 頁按住說話、App 泡泡、電視、`/chat` 頁；［系統］／［通知］開頭的不算）一收到就記 kv `awake_until`＝現在＋醒著視窗（預設 30 分鐘，secret `IRORI_AWAKE_S` 可調，秒），跟 `last_user_turn_at` 同一個背景寫入（`markStart`）。她照常回應，視窗內每次再開口都會重新計算。**過了視窗沒再互動**就回到睡覺：閘門又擋、走位又叫她回床。在睡覺時段之前開口（例如 22:50）也會記視窗，所以 23:00 睡覺時間要等視窗過了（23:20）才擋主動說話。
- **提示詞「現在的狀態」**（`routine.ts sleepLine`）：睡覺時段沒被叫醒（背景的主動說話、轉述）寫「現在是你的睡覺時間，你在臥室床上睡著；小良哥叫醒你才醒來，醒著時可以帶點剛睡醒的語氣，聊完可以說要回去睡」；`/chat` 使用者開口那一輪、或視窗內寫「…你剛被叫醒；可以帶點剛睡醒的語氣，聊完可以說要回去睡」。取代睡覺時段一般的「作息：現在是固定的…」那一行。人設 `persona.md` 也多一條說明這件事。
- **為什麼夥伴來信用「不拉」而不是另存 pending**：信本來就留在仲介直到 ack，沒人開著頁面時就是這樣運作的；睡覺時 `ensureProcessed` 直接返回（在搶鎖與記拉取時間之前），醒來後第一個 `/updates` 週期進場那次就會拉到（拉取時間戳沒更新，節流不會擋）。不需要新的佇列，也不會有「存了沒送」的殭屍。讀不到作息或醒著視窗時照常處理（不能因為判斷壞掉弄丟使用者在等的回信）。
- 讀不到醒著視窗的 kv：閘門當作沒被叫醒（主動開口可有可無，寧可不吵）；`/chat` 本身不受影響，使用者找她永遠照常回應。
- 實作：`routine.ts`（`isSleepEvent`／`sleepEvent`／`secondsUntilEnd`／`sleepLine`、`plan` 的 `awake`）、`proactive_gate.ts`（`AWAKE_KEY`、`markStart`、`sleepGate`）、`proactive.ts`（`decide`／`decideGreet`／`decideUpdate`）、`moves.ts`／`prompt.ts`（提示詞）、`routine_tick.ts`（走位）、`inbox.ts`（`deferForSleep`）；測試 `sleep_test.ts`。

### 提醒與夥伴來信轉述不受影響

提醒（到點代講）與夥伴來信轉述是後端直接推 `say`（不經 `/chat`、不是閒聊），**不套用這道閘門**（夥伴來信轉述只看睡覺時段，見上節）：提醒有時間性、而且是使用者自己要的；夥伴來信轉述推到 3D 頁後，3D 頁的 inbox 本來就等「沒在想、沒在講、沒按著」才處理（`pump`），不會插話。取捨：它們在使用者講到一半時仍可能到達，要避開得另外做延後佇列，這次不做。

## 3D 頁自己的對話鏡像（origin '3d'）

3D 頁送 `/chat`（`from_3d`、帶 `client_id`、沒有 `speak_elsewhere`）回答完成後，後端把「她這輪說的話＋動作」另推一則 say 進 updates_log（不寫 history，`p_turns` 為 null）：

```json
{"type":"say","text":"…","origin":"3d","from_client":"<送話那台 client_id>","speaker_client":"<同上>","actions":[…]}
```

- 沒帶 `client_id` 的舊前端不推（分不出誰是送話那台）。主動說話（`speak_elsewhere`）仍走 `origin:'chat'`，不受影響。
- `speaker_client` 直接設成送話那台（不重新查活著的 speaker），所以舊版 App 泡泡（`speaker_client` 不是自己就不唸）也不會唸。
- 送話那台：`inbox.js` 的 `handle` 對 `origin:'3d'` 且 `from_client` 是自己的整則丟掉（已唸過、做過，也不進手機聊天串）。
- 其他 3D 頁：`sayPlan` 對 `origin:'3d'` 一律靜音播放（字幕、文字標籤、`actions`），開機補拉到超過 3 分鐘的舊話不處理。
- Android 泡泡：`sayTextOf` 對 `origin:'3d'` 回 null，不唸。
- 手機聊天串（`replies.js`）：`origin:'3d'` 不收。
- RTDB 內容通道：照一般事件加密寫入；超過 4 KB（約 1300 個中文字以上）標 big，裝置改打 `/updates` 補；序號去重與其他事件相同。

## 會讓她開口的情境總表（誰決定、誰生成、走哪條路）

原則：**前端只有「使用者自己說的話」會送 `/chat`**。其餘所有讓她開口的情境，前端最多只回報事實（剛打開畫面、我的網頁版本、我正在出聲），
要不要講、什麼時候講、由哪一台出聲都由後端決定（同一套閘門 `proactive_gate.ts` `checkQuiet`），並由後端生成後推 say。

| 情境 | 誰決定 | 誰生成 | 走哪條路 | 備註 |
|---|---|---|---|---|
| 使用者自己說話（3D 頁按住說話、App 泡泡、電視、`/chat` 頁） | 使用者 | 模型（`/chat` 串流） | 前端 `POST /chat` → 串流回該端；`speak_elsewhere` 時後端另推 say | 唯一由前端送 `/chat` 的情境；一收到就記 `last_user_turn_at` |
| 主動說話（閒聊） | **後端**（設定 talk、對話中、使用者剛說話、有人在出聲、擲骰） | 後端（`speak`，kind `idle`） | leader 3D 頁約每 60 秒 `POST /proactive/tick` → 後端推 say | 見上節「主動說話」；**睡覺時段不講**（被小良哥叫醒後的 30 分鐘內除外） |
| **進頁面打招呼** | **後端**（有人在出聲、對話中、使用者正在說話或 3 分鐘內說過話、30 分鐘內跨裝置打過 → 不打） | 後端（`speak`，kind `greet`） | 3D 頁載入 1.5 秒後 `POST /proactive/greet`（只回報「剛打開畫面」）→ 後端推 say，出聲裝置＝打開的那台 | 冷卻鎖 `irori_claim('greet', 1800)`，跨分頁、跨裝置；額度／次數不夠時放掉鎖。舊前端自己送的［通知］打招呼 `/chat` 套同一套判斷，不符合回 409 skipped |
| **新版本提醒** | **後端**（網頁版本比 `version.json` 已部署的舊、同一套安靜條件、每個新版本跨裝置只問一次） | 後端（`speak`，kind `update`） | 3D 頁 `POST /proactive/tick` 帶 `web_version`／`self_reload` → 後端比對後推 say | 鎖 `web_update_<版本>`；App 內嵌（`self_reload`）自己重新整理，不問；後端讀 `IRORI_WEB_ORIGIN`（預設 irori.web.app）的 `version.json`，快取 5 分鐘。舊前端的［通知］新版本 `/chat` 同樣套鎖 |
| 夥伴來信轉述 | 後端（有人開著頁面就收信；一次多封合成一則；**睡覺時段延後到起床或被叫醒**） | 後端（`inbox.ts narrate`，不帶工具；模型出錯重試一次） | `/updates` 驅動收信 → 推 `{type:'say'}`（帶 speaker_client） | 不看一般閘門（使用者要等的回信），只看睡覺時段（延後＝不拉不 ack，信留在仲介）。轉述失敗／額度用完／超過次數：**後端用固定模板自己講**（`templateNarration`，仍是 say，`templated:true`），不再退回 `{type:'done'}` 原文讓前端組提示詞。**跟她最近 10 分鐘說過的話重複的內容不再講第二遍**（提示帶最近說過的話＋事後逐句刪，全重複就不說、信照樣收到），主動說話與 /chat 串流同理，見 `NO-REPEAT.md` |
| 夥伴回報失敗（`failed`） | — | — | 雲端後端不產生；只有本機版 `server.py`（relay_bridge）會產生，前端 `inbox.js noticeFor` 仍保留給它 | 雲端不會走到 |
| 提醒到點 | 後端（時間到） | 後端模板（不呼叫模型） | `/updates` 驅動 → 推 say（帶 speaker_client） | 不看閘門（時間性、使用者自己要的），睡覺時段照常講 |
| 閒晃動作（走位、活動、手勢） | leader 3D 頁本機亂數 | 無（無聲） | 不經後端 | 不是「開口」，不碰 `/chat`（走位本身由後端作息決定：睡覺時段在床上，被叫醒的視窗內不強制回床） |

### 出聲回報與避讓（打招呼、主動說話不能疊在別人的聲音上）

kv `voice_until`＝`{until, by}`（`voice.ts`），閘門 `checkQuiet` 多一條 `speaking`：現在有人在出聲、或剛唸完 6 秒內，就不打招呼、不主動說話、不問更新（零副作用）。兩個來源：

1. **新版 App 自己回報**：泡泡播放 TTS 期間 `POST /proactive/hold {speaking:true, client_id}`，每 10 秒續期（每次算 30 秒，漏了「結束」也會過期），唸完送 `speaking:false`；別台說「唸完了」不會蓋掉正在講的這台。同時經 JS 橋通知 App 內的 3D 頁：`window.iroriHostSpeaking(true|false)`（網頁裝好後也會呼叫橋的 `IroriRoom.isSpeaking()` 問一次，避免通知落空）。3D 頁在外殼出聲期間不開始唸新的話、不打招呼、不送 tick，結束後恢復。
2. **舊版沒有回報**：後端每推一則 say（`stampSpeaker`）就依字數估播放長度（2 秒＋每字 0.28 秒，上限 90 秒）寫進 `voice_until`，只往後延、不縮短（保守估算）。
3. 3D 頁自己出聲時**不另外回報**：它唸的是後端推來的 say（已經估算過），或自己 `/chat` 的回覆（`chat_busy`＋`last_user_turn_at` 已經涵蓋）。

`/proactive/hold` 的 body 現在是 `{listening?, speaking?, client_id?}`，至少要有 `listening` 或 `speaking`；舊版只送 `listening` 照常運作。

## 多裝置行為總表

出聲＝只有 speaker 那台；字幕／動作＝其他 3D 頁是否也顯示、也做。「已修」是本次（靜音播放＋主動說話走 speaker）改的。

| 路徑 | 誰產生 | 經後端？ | 哪台出聲 | 哪台顯示字幕 | 哪台做動作 | 狀態 |
|---|---|---|---|---|---|---|
| 在 3D 頁按住說話 → 她回答 | 該 3D 頁 `/chat`（帶 client_id，成為 speaker）；回答完成後後端另推一則鏡像 say（`origin:'3d'`） | 是，串流回該頁，鏡像推給其他裝置 | 該頁（鏡像一律不出聲） | 該頁＋所有**其他** 3D 頁（靜音播放）；送話那台忽略鏡像（`from_client` 是自己） | 該頁全做；其他 3D 頁照 `actions` 做 body／motion，文字標籤的表情手勢也做；App 泡泡與手機聊天串略過 | 已修（需部署後端與網頁；舊版 App 靠 speaker_client＝送話那台而不唸，新版 sayTextOf 直接略過） |
| 從 /chat 獨立頁打字 | /chat 頁 `speak_elsewhere` → 後端推 say（origin chat） | 是 | speaker（最近互動的 3D／App） | /chat 頁自己＋所有 3D 頁（其他台靜音播放） | 所有 3D 頁照 `actions` 做 | 已修（以前非 speaker 的 3D 頁連字幕與標籤都沒有） |
| App 泡泡說話（3D 房間顯示中） | App `/chat`＋`speak_elsewhere`＋`speak_via`（App 內 3D 頁的 client_id） | 是 | **App 內那個 3D 頁**（後端先把它蓋成 speaker；它已離開則維持原選法）。以前沒指定，後端挑最近互動的 3D 頁，常是電腦那台，手機 Live 只有字幕沒有聲音 | App 泡泡＋所有 3D 頁 | 所有 3D 頁 | 已修（需部署後端、網頁、App）；見下「speak_via」 |
| 內容通道（RTDB）送來的 say | 同上各種 say，經加密事件 | 是 | 同各列（speaker） | 同各列 | 同各列 | 已修：以前 `applyContent` 先把 seq 登記成「已收過」才交給 `handle`，`handle` 的去重把這批全濾光，內容通道的 say 一則都沒唸也沒字幕（開了 `IRORI_SIGNAL_CONTENT` 才會發生）。測試 `tests/content_say.test.mjs` |
| App 泡泡說話（3D 房間沒顯示） | App `/chat`（App 成為 speaker），App 自己唸 | 是，只動作推回 | App | App 泡泡；**3D 頁沒有字幕** | 3D 頁照 `actions` 做 body／motion | 缺口：話不推給 3D 頁（要推需 App 也帶 speak_elsewhere，但那樣 App 自己就不唸；要改需協議，見下） |
| 夥伴回信轉述 | 後端 inbox 以她的口氣寫好 say（帶 speaker_client） | 是 | speaker | 所有 3D 頁（其他台靜音播放） | 所有 3D 頁（文字裡的標籤） | 已修 |
| 提醒 | 後端 reminders 推 say（帶 speaker_client） | 是 | speaker | 所有 3D 頁 | 所有 3D 頁（文字標籤） | 已修 |
| 主動說話 | **後端決定**：leader 3D 頁只送 `POST /proactive/tick`，後端判斷（設定、對話中、使用者剛開口、多台只算一次、擲骰）後自己生成並推 say、寫聊天紀錄 | 是 | speaker（不再是 leader 無條件出聲） | 所有 3D 頁 | 所有 3D 頁（話與 body／motion 都推） | 已改（需部署後端＋網頁；撞車已擋） |
| 閒晃動作（wander：走位、活動、手勢） | leader 本機亂數 | 否 | 無聲 | 無字幕 | **只有 leader**；別台只靠 state 同步到之後的 body，活動／手勢不會重演 | 缺口 |
| 開機打招呼／新版本通知 | **後端決定**（見上方「會讓她開口的情境總表」）：3D 頁只回報 `POST /proactive/greet`、tick 的 `web_version` | 是（後端生成、推 say） | 打開的那台（出聲裝置） | 所有 3D 頁 | 所有 3D 頁 | 已修：以前每台自己 `/chat`、會蓋在泡泡的聲音上 |
| 換衣服／換場景／身體擺放 | 任一台（`[outfit:]` 標籤、set_body、手動） | 是，state 存後端 | — | — | 別台輪詢到較新的 `state_seq` 就瞬移跟上（不走路） | 一致（但別台看不到「走出去換」的過程） |
| 沒有活著的 speaker | — | — | 每台可見的 3D 頁都唸（舊規則） | 所有 | 所有 | 缺口：理論上可能多台同時出聲；實務上 3D 頁輪詢會立刻接手成 speaker |
| 出聲那台關頁／切背景（缺口 6） | 3D 頁在 `visibilitychange`→hidden 與 `pagehide` 用 `keepalive` 送 `POST /device?…&visible=0` | 是（只更新裝置紀錄） | 別台下一次輪詢接手（以前最長 3 分鐘沒人出聲：推來的話蓋著離開那台的 `speaker_client`、但它不唸） | 所有 3D 頁 | 所有 3D 頁 | 3D 頁已修（需部署後端與網頁）；App 要自己在泡泡收起／進背景時送，**還沒做**（見下） |

### 仍有的缺口（這次沒修）

1. （已修）在 3D 頁自己說話得到的回答，別台 3D 頁現在有字幕、動作，見上一節「3D 頁自己的對話鏡像」。
2. App 在 3D 房間沒顯示時自己唸，3D 頁沒有字幕；需要 App 與後端協議新增「只顯示、不出聲」的推送。
3. 閒晃動作只有 leader 做；別台不重演。要重演需後端推一則動作 say（無話、帶 actions）。
4. 開機打招呼、新版本通知是各台本機行為，跨裝置不去重。
5. 靜音播放的停留時間是估的，跟出聲那台不會完全同步。

### 「3D 房間在畫面上」的定義（App 的 `roomShowing`，2026-10-03 修）

泡泡送話時問 `roomShowing`：true 就帶 `speak_elsewhere`（不帶 client_id、不當 speaker），把出聲交給 3D 頁。
這個旗標必須是「3D 房間真的看得到、聽得到」，定義是三個條件同時成立（`roomShowingFor`）：**App 在前景（onResume～onPause）、已登入、目前分頁是 Live**。

曾經的 bug：只算後兩項。App 進背景時 `onPause` 會把旗標設 false，但之後任何呼叫 `applyTabVisibility` 的路徑（登入狀態變化、token 換新，背景也會發生）
又把它設回 `showingRoom`（停在 Live 分頁就是 true），還順手 `room.onResume()`。結果泡泡在背景以為 3D 房間會唸，
送 `speak_elsewhere`，後端把出聲交給一台沒人在聽的 3D 頁（`speaker_client`＝那台），**整句話沒有任何一台唸**。
現在 `MainActivity` 有 `foreground` 旗標，`applyTabVisibility` 一律吃它；`onPause` 先關旗標再套用，`onDestroy` 也清掉。

另外 App 在 `applyTabVisibility` 時對 Live 的 WebView 呼叫 `window.iroriHostVisible(true|false)`（`web/js/host_visibility.js`）：
WebView.onPause 不保證 `document.visibilityState` 變 hidden，3D 頁可能在背景繼續回報 visible=1、被選成 speaker。
這支把 `visibilityState`／`hidden` 蓋成外殼說的並觸發 `visibilitychange`，既有的「離開時 POST /device visible=0」「停輪詢」「不唸話」就都照常動作。

後端規則不用改：`speak_elsewhere` 沒帶 client_id 時，speaker 是「最近互動、且 `dev:` 紀錄新鮮且 visible 的那台」，
它沒回報離開就視為活著——後端無法分辨一台「說自己 visible 但其實沒人聽」的 3D 頁，所以靠端上正確回報。

### speak_via：泡泡在 Live 前景時，指定 App 內那個 3D 頁當 speaker（2026-10-03）

實測：手機 App 在 Live 分頁、用泡泡講話，Live 的 3D 頁只有字幕、沒有聲音（它的時鐘也沒變深色＝不認為自己是出聲裝置）。
原因：泡泡把出聲交給 3D 頁時送 `speak_elsewhere` 且不帶 `client_id`，後端 speaker 是「最近互動、還活著的那台」，
結果是電腦上另一個開著的 3D 頁（`dev:5f60…`），App 內的 3D 頁只被當成「別台 3D 頁」靜音播放。

- App 內的 3D 頁（`?app=1`）開機時呼叫 `window.IroriRoom.setClientId(<自己的 client_id>)`（`host_visibility.js` 的 `reportClientId`；瀏覽器沒有這座橋就什麼都不做）。
  外殼（`MainActivity.RoomBridge`）驗證格式（1～64 字、英數與 `-` `_`）後放進 `BubbleService.roomClientId`，房間 WebView 銷毀（登出）時清掉。
- 泡泡（`BubbleService.send`）與電視（`TvTalk`）送 `/chat` 時，`speak_elsewhere` 搭配 `speak_via=<roomClientId>`（泡泡只在 `roomShowing` 時帶；房間沒顯示由泡泡自己唸，不帶）。
- 後端 `chat()`：`speak_elsewhere` ＋ `speak_via` 且沒有 `client_id` → `noteSpeakVia`（`speaker.ts`）：指定的裝置必須是 **還活著、可見的 3D 頁**（`dev:<id>` 新鮮、`kind=3d`、`visible` 不是 false），
  通過就等於它剛互動過（`noteInteraction`：蓋成 speaker，換人就敲門鈴）；沒通過就不指定，維持原本選法（不會把出聲交給沒人聽的頁）。在開始回答之前就做，回答完推 say 時 `stampSpeaker` 蓋的就是它。
- 舊版 App 不帶 `speak_via`，行為不變。

### 其他一起修的（2026-10-03）

- **內容通道 say 不出聲**：見總表「內容通道送來的 say」。`inbox.js` 現在先 `handle` 再 `rememberDelivered`（`signal_logic.js`）。
- **播放不能卡死佇列**（`playback_guard.js`、`lipsync.js`、`speech.js`）：頁面因版本更新自動重新整理後沒有使用者手勢，AudioContext 一直是 suspended；
  音訊元素接在 suspended 的 AudioContext 上 `play()` 成功但時間不走、永遠不會 ended，整條說話佇列卡死（那台之後再也不向 `/tts` 要聲音）。
  現在：起播前 AudioContext 不是 running → 不接它、直接播（不真的對嘴，畫面提示「點一下畫面讓她能出聲」）；第一次手勢就建立／叫醒 AudioContext；
  播放中連續約 6 秒沒進度就放棄這一句；`/tts` 取聲音 20 秒逾時。
- **App 泡泡的聲音**：`Voice.from` 以前讀 state 根層的 voice／pitch（後端放在 `settings` 底下），讀不到就用預設的 HsiaoYu／pitch 15。現在優先讀 `settings`，沒有才退回根層。
- **App 內 3D 頁載入完補說一次可見狀態**：`onPageFinished` 對 Live 的 WebView 再呼叫一次 `iroriHostVisible`（`applyTabVisibility` 在網頁還沒載好時呼叫是空操作）。
- **聊天紀錄重複**：主動說話的使用者句每次都是同一句「［系統］（你主動找…說了話）」，`mergeHistory`（網頁、App 兩份）只看「開頭相同幾則」會配錯位置，紀錄滿 40 則後把同一段接兩次（再經 App 存回時 `fillAt` 讓這些重複的輪次拿到同一個時間）。
  現在優先找「一路相同到其中一邊結尾」的完整重疊，分岔（兩邊各自往後長）至少要兩則共同段。已經寫壞的紀錄不會自己消失（清除記憶或手動整理）。

### App 端需要的配合

- 缺口 6（離開時讓位）：App 在 `paused`／泡泡收起（`roomShowing` 變化）時，立刻 `POST /device?client_id=<id>&kind=app&visible=0`（路徑與參數見上；`BubbleService` 現有的 `visible=0` 輪詢不用改）。沒做之前，暫停／泡泡收起要等進行中的那次長輪詢結束（最多 25 秒）才讓位；App 被系統殺掉則要等 180 秒判死，期間沒有任何一台出聲。

- 主動說話現在由後端 say 推給 App：若 App 是 speaker（`speaker_client == 自己`），收到後照一般 say 唸出聲，**不需要程式改動**；它在 `origin: 'chat'` 的 say 上本來就是這樣處理。
- 不想多唸的情況：App 不是 speaker 時照既有規則不唸。
- 想補缺口 2：需要 App 在自己唸的同時，通知後端把同一句以「僅字幕」形式推給 3D 頁（新欄位，如 `/chat` 的 `mirror_text: true`），這次沒做。

## 碰到哪個畫面，聲音就從那個畫面出來（2026-10-04，App 0.1.28）

小良哥實測：用手機的懸浮小視窗講話，電腦的 3D 頁也開著，聲音卻從電腦出來。規則：**觸控、說話的是哪個畫面，出聲裝置就是哪個畫面**，兩個方向都要成立。

### 根因

1. App 內的 3D 頁（WebView）搬進懸浮視窗時，網頁瞬間被當成「不在畫面上」，**離開**（`POST /device visible=0`）與**回來**（下一次 `/updates` 帶 visible=1）是兩個並行的請求，後端收到的順序不保證；訊號模式下回來的那次可能要等 300 秒。後端的 `dev:<id>` 因此留在 `visible=false`。
2. 泡泡送話帶 `speak_via=<App 內 3D 頁>`，`noteSpeakVia` 要求「還活著且 visible」，被拒絕後**退回原本的選法**＝最近互動的那台（電腦）。證據：正式 kv 的 updates_log 在小視窗送話的那幾輪（seq 472）`speaker_client` 是電腦那個 3D 頁。
3. 另外：觸控（旋轉、移動鏡頭）從來不會改 speaker，只有說話（/chat 帶 client_id）會。

### 修法

- **App 擔保**：`speak_via` 由外殼送來，等於外殼在說「這個 3D 頁現在在畫面上」（全畫面、懸浮小視窗、系統子母畫面都算）。`noteSpeakVia` 對 3D 頁只要求紀錄存在且 30 分鐘內有動靜（`VIA_GRACE_S`），並把它記成可見；對 App 泡泡（手機頁打字指定的）仍要求還活著、可見。
- **指定不到絕不跳別台**：真的指不到（頁面已不在）時，`/chat` 回標頭 `x-speak-via: miss`，後端這一輪**不把話推給任何 3D 頁**（只推動作），App 自己唸（`speakViaMissed`）。手機頁打字與電視沒有這個備案，維持原本的選法。
- **回報排隊**：3D 頁的 visible=0 / visible=1 / interact 回報走同一條序列（`inbox.js post`），回來時立刻明講 visible=1，不等輪詢。外殼搬進懸浮視窗後 0.3、1.2 秒再各說一次「看得見」。
- **觸控切換**：3D 頁任何 `pointerdown`／`wheel`／`keydown` → `POST /device?…&interact=1`（`touch_speaker.js`，本機樂觀切成 speaker，已是 speaker 不重送，間隔 1.5 秒）；後端走 `noteInteraction`（換人敲門鈴）。叫出／收起小視窗（`iroriHostPip` 變化）也算一次互動，立刻切回手機。
- **讓位給最近被碰過的**：`speaker_recent`（kv，最近 6 台互動過的裝置）。speaker 離開（visible=0）時，立刻讓給「還看得見、最近被碰過」的那台並敲門鈴；沒有 speaker 時新輪詢的裝置接手前也先看這份名單。
- **手機頁（Irori Chat）打字**：App 內嵌時帶 `speak_via=<手機泡泡的 client_id>`（`IroriAndroid.clientId()`，泡泡沒在跑回空字串），泡泡還活著就由手機出聲。
- **身分**：裝置紀錄與 speaker 多一個 `form`：`float`（懸浮小視窗）、`pip`（系統子母畫面）。來源：`iroriHostPip(on, form)`、`IroriRoom.miniForm()`；3D 頁在 `/updates`、`/device` 帶 `form=`。`/chat` 的 `origin` 多 `float`、`pip`（點懸浮視窗、按子母畫面的「說話」），`speak_form` 隨 `speak_via` 帶。後端 `channel.ts` 對希緒說「手機上的懸浮小視窗／子母畫面，聲音從小視窗裡的 3D 房間出來」；`/updates` 的回應多 `speaker_form`；出聲裝置的時鐘標記的提示字顯示「手機小視窗」。
- **小視窗字幕**：`body.pip` 時字幕最多兩行、貼下緣，長句兩行一組輪替（`subtitle_logic.js`，每組 1.2～3 秒，依字數）。

測試：`speaker_mini_test.ts`、`speaker_test.ts`、`channel_test.ts`、`tests/touch_speaker.test.mjs`、`tests/device_report.test.mjs`、`tests/host_visibility.test.mjs`、`tests/subtitle_logic.test.mjs`、`tests/phone_talk_via.test.mjs`、Android `RoomVisibilityTest`。
