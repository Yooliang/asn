# 同一句只由一台裝置唸（speaker 協定）

小良哥可能同時開著電腦 3D 頁、手機 App 泡泡、App 內 3D。後端推來的 say（夥伴回信、提醒、從 /chat 獨立頁送話的轉唸）
只由「小良哥最近互動的那一台」出聲；動作（`actions`）所有 3D 頁照做，畫面才一致。

## 出聲裝置要做的事（App 端）

1. 自己有一個 `client_id`（字串，最長 64，每次安裝／啟動固定即可）與 `kind`：3D 頁是 `3d`，Android App 是 `app`。
2. 輪詢 `GET /updates` 時加查詢參數：`client_id=<id>&kind=app&visible=1`。
   `visible=1`＝現在可以出聲（泡泡在顯示、或 App 在前景）；不能出聲就送 `visible=0`，或乾脆不輪詢。
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
  2. 沒有 speaker、或 speaker 超過 180 秒沒輪詢／`visible=0` → 下一台可見的出聲裝置輪詢時接手（先到先得，不會每 25 秒互搶）。
  3. 從 /chat 獨立頁發話不改 speaker，沿用上一條選出的「最近可見的 3D 頁或 App」。
- 推送 say 時（夥伴回信、提醒、speak_elsewhere）加 `speaker_client`＝推送當下還活著的 speaker。
- 實作：`supabase/functions/irori-api/speaker.ts`，測試 `speaker_test.ts`。

## 靜音播放（不是出聲裝置的 3D 頁）

原則：**出聲只有一台，但每一台 3D 畫面都顯示字幕、做同樣的表情／手勢／動作**。

- 3D 頁收到 say，用 `web/js/say_policy.js` 的 `sayPlan(job, 自己的 client_id, claim)` 決定要不要出聲：`speaker_client` 是別台、或同瀏覽器沒搶到「唸過了」標記的分頁 → `mute`。
- `mute` 的句子照樣走 `speakText`（同一套標籤解析，沒有另寫一份），字幕、`[happy]`／`[wave]` 這類表情手勢、`[outfit:]`／`[scene:]` 等動作片段與 `actions`（body／motion）都照做；差別只在 `createSpeaker`（`speech.js`）對 `mute` 句子不呼叫 TTS、不播聲音、**嘴巴不動**（沒聲音卻對嘴很怪，也省資源），改成停留 `mutedHoldMs(text)`（每字 200ms，0.7～12 秒）再接下一句，節奏跟出聲那台接近。
- 以前的作法是把 text 清成空字串，連字幕與文字裡的標籤都一起沒了，現已改掉。

## 主動說話（leader 3D 頁）

1. leader 擲骰到了，呼叫 `/chat`：帶 `from_3d` 與 **`speak_elsewhere: true`、不帶 `client_id`**（主動說話不算「小良哥在這台互動」，不搶 speaker），自己**不唸**（`sendChat` 的 onSegment 丟掉）。
2. 後端 `relayPlan`（`speak_elsewhere.ts`）：3D 頁的主動說話把整句話＋動作都推成一則 `say`（`origin: 'chat'`），並加 `speaker_client`＝目前活著的 speaker。
3. 所有裝置（含 leader 自己）都從 `/updates` 收到同一則 say：speaker 唸出聲（可能是手機 App），其他 3D 頁靜音播放。leader 自己也走這條路，所以不需要另外做「別重播給自己」的去重，也不會有「leader 以為自己是 speaker 但後端不這麼認為」的競態。
4. 代價：主動說話要等整段回覆完成才開口（不再邊串流邊唸），延遲多一個輪詢喚醒（後端推完會敲門鈴，通常 1 秒內）。

## 多裝置行為總表

出聲＝只有 speaker 那台；字幕／動作＝其他 3D 頁是否也顯示、也做。「已修」是本次（靜音播放＋主動說話走 speaker）改的。

| 路徑 | 誰產生 | 經後端？ | 哪台出聲 | 哪台顯示字幕 | 哪台做動作 | 狀態 |
|---|---|---|---|---|---|---|
| 在 3D 頁按住說話 → 她回答 | 該 3D 頁 `/chat`（帶 client_id，成為 speaker） | 是，串流只回該頁 | 該頁 | **只有該頁**；後端不推話給別台 | 該頁全做；別台只靠 state 同步到 body／衣服／場景，motion 與手勢不會重演 | 缺口：別台 3D 頁看不到她回答了什麼 |
| 從 /chat 獨立頁打字 | /chat 頁 `speak_elsewhere` → 後端推 say（origin chat） | 是 | speaker（最近互動的 3D／App） | /chat 頁自己＋所有 3D 頁（其他台靜音播放） | 所有 3D 頁照 `actions` 做 | 已修（以前非 speaker 的 3D 頁連字幕與標籤都沒有） |
| App 泡泡說話（3D 房間顯示中） | App `/chat`＋`speak_elsewhere` | 是 | speaker（3D 房間顯示時 App 不搶 speaker） | App 泡泡＋所有 3D 頁 | 所有 3D 頁 | 已修（同上） |
| App 泡泡說話（3D 房間沒顯示） | App `/chat`（App 成為 speaker），App 自己唸 | 是，只動作推回 | App | App 泡泡；**3D 頁沒有字幕** | 3D 頁照 `actions` 做 body／motion | 缺口：話不推給 3D 頁（要推需 App 也帶 speak_elsewhere，但那樣 App 自己就不唸；要改需協議，見下） |
| 夥伴回信轉述 | 後端 inbox 以她的口氣寫好 say（帶 speaker_client） | 是 | speaker | 所有 3D 頁（其他台靜音播放） | 所有 3D 頁（文字裡的標籤） | 已修 |
| 提醒 | 後端 reminders 推 say（帶 speaker_client） | 是 | speaker | 所有 3D 頁 | 所有 3D 頁（文字標籤） | 已修 |
| 主動說話 | leader 3D 頁生成，經 `/chat`＋`speak_elsewhere` 推回 | 是 | speaker（不再是 leader 無條件出聲） | 所有 3D 頁 | 所有 3D 頁（話與 body／motion 都推） | 已修（需部署後端） |
| 閒晃動作（wander：走位、活動、手勢） | leader 本機亂數 | 否 | 無聲 | 無字幕 | **只有 leader**；別台只靠 state 同步到之後的 body，活動／手勢不會重演 | 缺口 |
| 開機打招呼／新版本通知 | 每台 3D 頁自己的本機 notice → 自己 `/chat` | 是（各自一次 `/chat`） | 各自本機出聲（同瀏覽器 30 分鐘去重，跨裝置不去重） | 各自 | 各自 | 缺口：電腦＋手機各開 3D 頁時會各打一次招呼、各自出聲 |
| 換衣服／換場景／身體擺放 | 任一台（`[outfit:]` 標籤、set_body、手動） | 是，state 存後端 | — | — | 別台輪詢到較新的 `state_seq` 就瞬移跟上（不走路） | 一致（但別台看不到「走出去換」的過程） |
| 沒有活著的 speaker | — | — | 每台可見的 3D 頁都唸（舊規則） | 所有 | 所有 | 缺口：理論上可能多台同時出聲；實務上 3D 頁輪詢會立刻接手成 speaker |

### 仍有的缺口（這次沒修）

1. 在 3D 頁自己說話得到的回答，別台 3D 頁看不到字幕、不做手勢／motion。修法：3D 頁送話也帶 `speak_elsewhere` 並讓自己丟棄推回的那一句（需去重，例如 say 帶 `origin_client`），或讓後端對 `from_3d` 也推「僅字幕＋動作」版。
2. App 在 3D 房間沒顯示時自己唸，3D 頁沒有字幕；需要 App 與後端協議新增「只顯示、不出聲」的推送。
3. 閒晃動作只有 leader 做；別台不重演。要重演需後端推一則動作 say（無話、帶 actions）。
4. 開機打招呼、新版本通知是各台本機行為，跨裝置不去重。
5. 靜音播放的停留時間是估的，跟出聲那台不會完全同步。

### App 端需要的配合

- 主動說話現在由後端 say 推給 App：若 App 是 speaker（`speaker_client == 自己`），收到後照一般 say 唸出聲，**不需要程式改動**；它在 `origin: 'chat'` 的 say 上本來就是這樣處理。
- 不想多唸的情況：App 不是 speaker 時照既有規則不唸。
- 想補缺口 2：需要 App 在自己唸的同時，通知後端把同一句以「僅字幕」形式推給 3D 頁（新欄位，如 `/chat` 的 `mirror_text: true`），這次沒做。
