# 同一句只由一台裝置唸（speaker 協定）

小良哥可能同時開著電腦 3D 頁、手機 App 泡泡、App 內 3D。後端推來的 say（夥伴回信、提醒、從 /chat 獨立頁送話的轉唸）
只由「小良哥最近互動的那一台」出聲；動作（`actions`）所有 3D 頁照做，畫面才一致。

## 出聲裝置要做的事（App 端）

1. 自己有一個 `client_id`（字串，最長 64，每次安裝／啟動固定即可）與 `kind`：3D 頁是 `3d`，Android App 是 `app`。
2. 輪詢 `GET /updates` 時加查詢參數：`client_id=<id>&kind=app&visible=1`。
   `visible=1`＝現在可以出聲（泡泡在顯示、或 App 在前景）；不能出聲就送 `visible=0`，或乾脆不輪詢。
   **離開時要馬上說一聲**：泡泡收起、App 進背景、關頁的那一刻送一次 `POST /device?client_id=<id>&kind=app&visible=0`（參數同 /updates，帶授權標頭，回 `{"ok":true}`）。
   後端立刻視這台為失效，別台下一次輪詢就接手；不送的話要等 180 秒沒輪詢才會判死，期間推來的話都蓋這台的 `speaker_client`、但這台不會唸，等於沒人出聲。
   這支只更新裝置紀錄，不收信、不補講提醒，所以離開時送它比送 `GET /updates?visible=0&wait=0` 安全（後者會把來信轉述成只回給正在關閉的頁面）。
3. 送 `POST /chat` 時，body 多帶 `"client_id": "<id>", "client_kind": "app"`（使用者在這台發話，這台就成為 speaker）。
   /chat 獨立頁不出聲，不帶這兩個欄位。
4. 收到的 say 有 `speaker_client` 欄位時：
   - `speaker_client == 自己的 client_id` → 唸出聲
   - 否則 → 不唸（text 當作背景資料，動作若是 3D 才執行）
   - 沒有 `speaker_client` 欄位（後端找不到活著的 speaker）→ 照舊規則

## 後端怎麼選 speaker

- kv `dev:<client_id>`＝{kind, at, visible}，每次帶 client_id 的 `/updates` 或 `/chat` 都更新。
- kv `speaker`＝{client_id, kind, at}：
  1. `/chat` 帶 client_id＋client_kind → 該台成為 speaker（最近互動的那台）。
  2. 沒有 speaker、或 speaker 超過 180 秒沒輪詢／`visible=0`（輪詢帶的，或離開時 `POST /device` 送的）→ 下一台可見的出聲裝置輪詢時接手（先到先得，不會每 25 秒互搶）。
     後端有開訊號模式（Firebase 指標，`SIGNAL.md`）時，裝置只每 300 秒保底輪詢一次，存活期改成 **400 秒**（要大於保底間隔，否則兩次保底之間 speaker 就失效）；正常離開的 `visible=0` 照樣立刻讓位。
  3. 從 /chat 獨立頁發話不改 speaker，沿用上一條選出的「最近可見的 3D 頁或 App」。
- 推送 say 時（夥伴回信、提醒、speak_elsewhere）加 `speaker_client`＝推送當下還活著的 speaker。
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

### 提醒與夥伴來信轉述不受影響

提醒（到點代講）與夥伴來信轉述是後端直接推 `say`（不經 `/chat`、不是閒聊），**不套用這道閘門**：提醒有時間性、而且是使用者自己要的；夥伴來信轉述推到 3D 頁後，3D 頁的 inbox 本來就等「沒在想、沒在講、沒按著」才處理（`pump`），不會插話。取捨：它們在使用者講到一半時仍可能到達，要避開得另外做延後佇列，這次不做。

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
| 開機打招呼／新版本通知 | 每台 3D 頁自己的本機 notice → 自己 `/chat` | 是（各自一次 `/chat`） | 各自本機出聲（同瀏覽器 30 分鐘去重，跨裝置不去重） | 各自 | 各自 | 缺口：電腦＋手機各開 3D 頁時會各打一次招呼、各自出聲 |
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
