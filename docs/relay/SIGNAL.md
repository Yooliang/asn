# 訊號指標：用 Firebase Realtime Database 降低 Edge Function 呼叫數（#120）

2026-10-03。對應進度表 #120。**來源**：`SYNC-OPTIONS.md` 方案 4 路線 A（公開讀、不可猜的路徑、零金鑰），小良哥裁示改採。
**目的**：每台裝置每 25 秒長輪詢一次 `/updates`，一個月是十幾萬次函式呼叫（Supabase Free 每月 50 萬次）。改成「監聽 Firebase 上的指標，**有變化才**打 `/updates`」，另留 **300 秒（5 分鐘）一次的保底輪詢**。
**紅線**：Firebase 只放指標（序號、時間、誰出聲），**不放任何內容**（話、信、聊天、記憶一律不進來）；前端與 App 零金鑰；兩個 secret 都沒設時整個功能關閉、行為跟以前完全一樣。

## 開關

兩個 Edge Function secret（**兩個都要設才開**，少一個、格式不對都等於關閉，只記一次 log）：

| secret | 內容 |
|---|---|
| `IRORI_FIREBASE_DB_URL` | 資料庫網址，例如 `https://irori-xisu-default-rtdb.asia-southeast1.firebasedatabase.app`（不含路徑，尾巴斜線會自動去掉） |
| `IRORI_FIREBASE_SA` | 服務帳戶 JSON（整份，字串） |

關閉時：不讀資料庫、不打網路、`/updates` 回應沒有 `signal`、離開判斷與裝置存活期維持舊值。前端與 App 看不到 `signal` 就一直走 25 秒長輪詢（舊做法）。

## 資料流

```
有新東西（Supabase 先寫）                      Firebase RTDB（後寫，只放指標）                裝置
  irori_updates_push（轉述、提醒、推話） ─┐
  PUT /state（含電視）                    ├─→  notify(owner) ─→ PUT /p/<hash>  ─ SSE ─→  EventSource(p) ─┐
  換出聲裝置（noteInteraction）           │                                                              ├→ 有變化才
  新增／取消提醒                          ┘                                                              │   GET /updates?since=…&wait=0
  irori-relay ring(topic)（來信門鈴）  ────→  PUT /b/<hash2> ＝ {at}  ─ SSE ─→  EventSource(b) ──────────┘
                                                                                      另有 poll_s（300 秒）保底、next_due 提醒到期
```

- **Supabase 永遠是真相來源**：指標只是「叫你來拉」，拉的內容（`updates_log`、`since` 游標、`seq` 去重）完全沒變。
- **RTDB 寫失敗只記 log、不丟錯、不擋原本流程**；寫不進去的代價只是裝置要等保底輪詢（最久 5 分鐘），而且前端偵測到「保底輪詢連續拉到沒人通知的新東西」會自己退回長輪詢（見「退回長輪詢」）。
- 長輪詢同時是排程器（提醒到點、收信轉述靠 `/updates` 被呼叫才會跑，見 `SYNC-OPTIONS.md` 1.2）。訊號模式下排程由三件事驅動：指標變化的那一拉、來信門鈴 `b` 響的那一拉、`next_due`／保底的那一拉。

## RTDB 節點

### `/p/<hash>`：每位使用者一個

```json
{ "seq": 123, "state_seq": 45, "speaker": "3d-abc123", "at": 1790000000000, "due": 1790003600 }
```

| 欄位 | 意義 |
|---|---|
| `seq` | `updates_log` 的最新 seq（寫入當下讀的） |
| `state_seq` | 狀態版本 |
| `speaker` | 現在活著的出聲裝置 `client_id`；沒有就**沒這個欄位**（RTDB 會把 `null` 當成刪除，讀到缺欄位請當 null） |
| `at` | 寫入時間，epoch 毫秒（每次寫都不同，所以每次寫入都會有事件） |
| `due` | **選填的加碼**：下一個還沒觸發的提醒到期時間（epoch 秒）；沒有提醒就沒這個欄位。新增、取消提醒不會推送任何東西，靠它讓裝置知道「下一次該打 `/updates` 的時間」變了。不認得這個欄位的端略過即可 |

`<hash>` ＝ `HMAC-SHA256(key = 服務帳戶的 private_key, msg = "irori-signal-p:" + owner uuid)` 的前 32 個十六進位字元。沒有私鑰算不出來（不是 owner 的單純雜湊，知道 uuid 也猜不到路徑）。**換了服務帳戶金鑰，路徑會跟著換**：裝置每次 `/updates` 都拿到最新網址，會自己改接新的，舊節點只是不再更新。

### `/b/<hash2>`：希緒（XISU）的仲介來信門鈴

```json
{ "at": 1790000000000 }
```

`<hash2>` ＝ `sha256("irori-bell:" + 仲介節點的 bell_topic)` 的前 32 碼（`bell_topic` 是 irori-relay 發的隨機字串，本身就不可猜）。**irori-relay 每次 `ring(topic)` 都會寫 `/b/<sha256("irori-bell:"+topic) 前 32 碼>`**（含夥伴寄信、群組、遠端開視窗的門鈴；裝置只會監聽希緒自己那個）。irori-api 用 `relay.bellTopic()` 算出同一個 hash 放進 `signal.b`；頻道名除了記憶體快取 10 分鐘，另存一份在 kv `relay_bell_topic`（6 小時）——訊號模式下 `/updates` 5 分鐘才來一次，Edge Function 實例多半已回收，沒有 kv 的話每次都要多打一次 irori-relay 的 `whoami`。

### Rules（主線部署）

```json
{ "rules": { ".read": false, ".write": false,
  "p": { "$h": { ".read": true, ".write": false } },
  "b": { "$h": { ".read": true, ".write": false } } } }
```

只有「知道完整路徑」的人讀得到單一節點；不能列目錄、不能寫。後端用服務帳戶寫（Admin 身分不受 Rules 限制）。曝險面＝知道路徑的人能讀到序號、speaker 的 client_id、時間，等同現有的 public 門鈴頻道，不含任何內容。

## `/updates` 回應多帶 `signal`

只有功能開啟時才帶：

```json
"signal": {
  "p": "https://irori-xisu-default-rtdb.asia-southeast1.firebasedatabase.app/p/<hash>.json",
  "b": "https://irori-xisu-default-rtdb.asia-southeast1.firebasedatabase.app/b/<hash2>.json",
  "poll_s": 300,
  "next_due": 1790003600
}
```

- `p`、`b` 是完整網址（前端不需要知道 owner 或門鈴頻道名）。`b` 拿不到仲介門鈴（`whoami` 失敗、沒設仲介）時是 `null`：只監聽 `p`，下次回應有了再接上。
- `poll_s`：保底輪詢秒數，**端上照這個值走，不要寫死**。
- `next_due`：下一個提醒到期的 epoch 秒，沒有提醒＝`null`。提醒已經過了還沒觸發（別台正在處理）時後端回「3 秒後」，端上才不會連環打。

## 裝置端怎麼做

### 網頁（已實作）：`web/js/signal_logic.js`（純邏輯）、`signal_client.js`（EventSource 與計時）、`inbox.js`（接進現有收件匣）

1. **模式**：`/updates` 回應帶了合格的 `signal`（`p` 是 https）就切到監聽模式；沒帶、瀏覽器沒有 `EventSource`、或監聽失敗後還在冷卻（10 分鐘）就用 25 秒長輪詢。開機的第一次請求（不等待）就能拿到 `signal`；sessionStorage 留有游標的重新整理也會先不等待地問一次，免得白等 25 秒。
2. **連線**：對 `p`、`b` 各開一條 `EventSource`（瀏覽器原生，Firebase REST 串流，不需要 SDK 與任何金鑰）。事件名 `put`／`patch`，`data` 是 `{"path":"/…","data":…}`；還有 `keep-alive`（忽略）、`cancel`（Rules 拒絕讀取）、`auth_revoked`。
3. **什麼事件要拉**（`GET /updates?since=<本機 seq>&state_seq=<本機>&wait=0&<deviceQuery>`，照現有帶 `client_id`、`kind`、`visible`）：
   - `p`：`seq` 或 `state_seq` **比本機大**；`speaker` 跟上一筆不同且跟本機不同；`due` 跟上一筆不同且跟本機的 `next_due` 不同。連上時的第一筆只看序號（出聲裝置剛失效、指標寫的還是舊的，不值得多打一次）。
   - `b`：`at` 跟上一筆不同。連上時的第一筆只當基準。
   - 事件來了先等 400 ms（合併連續事件，也讓自己剛送出的請求的回應先到），拉的當下再判斷一次，本機已經追上就不拉；兩次拉取至少隔 1.5 秒；拉的途中又來事件，拉完再判斷。
4. **計時**：上次拉取後 `poll_s` 秒沒事就保底拉一次；`next_due` 到期後 1 秒也拉一次（提醒要準時；本機與後端時鐘差用 `server_clock.js` 換算）。
5. **背景**：頁面切到背景就關掉兩條 `EventSource`、停掉計時（跟長輪詢「背景不輪詢」同一個規則）；回前景重開並**立刻打一次** `/updates`。切背景、關頁的 `POST /device?visible=0` 沒變。
6. **退回長輪詢**（`onFail`，冷卻 10 分鐘後再試監聽）：`EventSource` 被關掉（`readyState` CLOSED）；30 秒內連不上、或斷線後 30 秒沒回來（從第一次出錯算，重連失敗不重新計時）；Firebase 回 `cancel`／`auth_revoked`；建構就丟錯；後端回應不再帶 `signal`；**保底輪詢連續 2 次拉到新結果、卻沒有任何指標事件通知過**（指標壞了，例如後端寫 Firebase 失敗）。
7. **獨立 /chat 頁**用同一個 `createInbox`（`web/chat/chat.js` → `inbox.js`），自動跟著走；`web/chat/sw.js` 的 `SHELL` 已補兩個新檔。`web/js/phone/app_chat.js` 的 30 秒 `refreshAll` 是聯絡人／紀錄刷新，**不在這次範圍**，沒動。本機版（`isCloud=false`）每 2 秒輪詢，不受影響。

### Android／其他端（約定，照這個做）

- 照上面 1～6：`EventSource` 可以用 OkHttp 串流自己解析（請求加 `Accept: text/event-stream`，會跟著 307 轉址；每行 `event: put` + `data: {...}`，空行分隔）。
- `p` 的欄位缺漏請當 null（`speaker` 為空時整個欄位不存在）；`due` 不認得可忽略，但**新增提醒後別台的 `next_due` 會過時**——Android 若要照樣準時，可在 `/chat` 結束後補打一次 `/updates`（或處理 `due`）。
- `signal.b` 可能是 `null`；`signal.p` 的網址每次回應都可能變（換了服務帳戶金鑰），變了就改接新的。
- `poll_s` 照回應走。

## 後端掛點（哪些地方寫 `/p/<hash>`）

寫入時讀一次最新的 `seq`／`state_seq`（`irori_updates_since` 一個 RPC）、活著的 speaker、下一個提醒，整包 PUT；同一個使用者的寫入排隊一個接一個做（每次讀輪到時的最新值，免得舊值蓋新值）；在背景跑（`waitUntil`），不拖慢請求。

| 地方 | 程式 |
|---|---|
| 存狀態（`PUT /state`、電視 `tv` 工具與 `POST /tv`）、換出聲裝置（`/chat` 帶 `client_id` 讓 speaker 換人）、推給 3D 頁的話（`relaySpeech`） | `state.ts` 的 `ringStateBell` 敲完 Supabase 門鈴後一併寫（這幾條路都經過它，一處涵蓋） |
| 夥伴來信轉述（`say`）、轉述失敗退回原文（`done`） | `inbox.ts` 的 `narrate`，`irori_updates_push` 之後 |
| 提醒到點的 `say` | `reminders.ts` 的 `push`，`irori_updates_push` 之後 |
| 新增、取消提醒（讓 `due` 更新） | `reminders.ts` 的 `add`／`remove` |
| 仲介來信門鈴 | `irori-relay/index.ts` 的 `ring(topic)` 寫 `/b/<hash2>` |

核心：`supabase/functions/_shared/signal.ts`（irori-api 與 irori-relay 共用：服務帳戶 JWT、token 快取、`put`、路徑雜湊）、`irori-api/pointer.ts`（`notify`、`withSignal`、離開判斷）。

- **JWT／token**：用服務帳戶 JSON 簽 RS256 JWT（`crypto.subtle`，scope `firebase.database` ＋ `userinfo.email`，有效 1 小時），向 `https://oauth2.googleapis.com/token` 換 access token；模組層快取 55 分鐘，同時多個呼叫共用一次換取，換失敗 30 秒內不再試。每次呼叫逾時 3 秒。log 一律遮掉 access token（Deno 的連線錯誤訊息會帶出整條網址）。
- **不寫的情況**：功能關閉、換不到 token、被拒、逾時、連不上；一律只記 log。

## 離開判斷與裝置存活期（保底拉長後要跟著調）

保底只有 300 秒一次，**舊的固定值會把「人明明在」誤判**：

| | 長輪詢（沒開訊號） | 訊號模式 | 為什麼 |
|---|---|---|---|
| 離開判斷（`irori_presence_touch`，超過就算「離開又回來」→「你不在的時候」總結） | 60 秒 | **450 秒**（保底的 1.5 倍） | 兩次保底之間不能被當成離開；多封信一起轉述時的口氣（「你剛回來」）與離開後第一次進場一定拉 inbox 都靠它 |
| 出聲裝置存活期 `DEVICE_TTL_S`（超過就視為失效、沒有 speaker） | 180 秒 | **400 秒**（保底＋100 秒餘裕） | 小於保底的話，兩次保底之間 speaker 就失效，推來的話沒有 `speaker_client`，退回「每台可見 3D 頁都唸」的舊規則 |

正常關頁、切背景有 `POST /device?visible=0` 立刻讓位，拉長存活期只影響當機、斷網的兜底（最久 400 秒沒人出聲）。實作：`speaker_live.ts` 的 `deviceTtlS()`、`pointer.ts` 的 `isAway()`，都隨「功能是否開啟」切換；`speaker_test.ts`、`pointer_test.ts` 兩種模式各有測試，並守著「兩個值都大於保底」。

## 預估的 Edge Function 呼叫數（每台「一直開著」的裝置，每月；**估，沒實測**）

一次 `/updates` ＝ 1 次 irori-api ＋ 1 次 irori-relay（`inbox`；有信才多 `list`／`ack`）。

| | irori-api | irori-relay | 合計 |
|---|---|---|---|
| 以前（25 秒長輪詢，約 10.4 萬個週期） | 約 10.4 萬 | 約 10～31 萬（`SYNC-OPTIONS.md` 1.3：每週期約 1～3 次，階段 0 的節流部署後是 ≤1） | **約 21～41 萬** |
| 以後（300 秒保底 ＋ 事件才拉） | 約 0.86 萬（保底）＋ 事件約 0.3 萬 | 同左 | **約 2.3 萬**（事件多就多一些） |

約降 **9 成**（約 89～94%）。電腦 3D 頁、/chat 頁只有「看得到」時才計；手機 App 原生服務是常駐的。同時 3 台常駐約 7 萬 vs 以前 60～120 萬，Free 的 50 萬次夠用。事件＝別台存狀態、夥伴來信、提醒、換出聲裝置；估每台每天 ~50 次。

RTDB 這邊：Spark 免費（100 同時連線、10 GB／月下載）。每台裝置 2 條串流（p、b），**官方沒寫 REST 串流是否計入 100 連線**，請當作計入：3 台約 6 條，遠低於上限。

## 上線步驟（主線做）

1. **Firebase Console**（專案 `irori-xisu`）→ Realtime Database → 建立資料庫，區域選 `asia-southeast1`（新加坡，離台灣近）。
2. **Rules**：貼上面那份（或 `firebase deploy --only database`，需另加 `database.rules.json` 與 `firebase.json` 的 `database` 區塊；這次沒改 `firebase.json`，避免影響現有 hosting 部署）。
3. **服務帳戶**：專案設定 → 服務帳戶 → 產生新的私密金鑰（JSON）。需要有寫 RTDB 的角色（預設的 `firebase-adminsdk` 就有）。**金鑰不進 repo、不貼對話、不進 `.env` 之外的任何地方。**
4. **部署兩個函式**（先不設 secret，功能是關的，行為跟現在完全一樣）：`supabase functions deploy irori-api`、`supabase functions deploy irori-relay`（兩個都 import `_shared/signal.ts`）。再部署網頁（前端看不到 `signal` 就照舊長輪詢，先上沒有風險）。
5. **設 secret（這一步才開功能，不用重新部署）**：`supabase secrets set IRORI_FIREBASE_DB_URL=https://…firebasedatabase.app`；服務帳戶 JSON 用單行（`private_key` 裡的換行是 `\n` 跳脫字元，不要真的換行），例如放進一個單行的 env 檔後 `supabase secrets set --env-file <檔>`。
6. **驗證**：
   - 公開讀不可列目錄、不可寫：`curl https://<db>/.json` 應回 401；`curl -X PUT https://<db>/p/zzz.json -d 1` 應回 401。
   - 開網頁（開發者工具 → Network）：`/updates` 回應有 `signal`；出現兩條 `EventSource` 連線（`.json`，type `eventsource`）；之後不再有每 25 秒一次的 `/updates`。
   - 在另一台存個狀態（換衣服）或傳一句話：這台應在約 1～2 秒內拉一次 `/updates` 並更新；Firebase Console 資料庫裡應該有 `p/<hash>`（只有 4～5 個欄位）。
   - Function logs 沒有 `signal 寫入被拒`／`signal 換 token 失敗`。
7. **退回**：`supabase secrets unset IRORI_FIREBASE_DB_URL IRORI_FIREBASE_SA`。後端立刻停止寫指標、`/updates` 不再帶 `signal`；各端下次拿到沒有 `signal` 的回應就自己退回長輪詢（`off`）。

## 已知限制與沒把握的地方

- **前端的 EventSource 連 Firebase 沒在真實環境測過**（我拿不到服務帳戶、也沒建 RTDB）。事件格式照官方 REST 串流文件（`put`／`patch`／`keep-alive`／`cancel`／`auth_revoked`）實作，測試用假的 EventSource。上線驗證請看上面第 6 步。
- **指標寫入的交錯**：同一個 Edge Function 實例內的寫入有排隊；**不同實例同時寫**時，理論上舊值可能蓋掉新值，然後有裝置本機序號剛好等於舊值而不拉，最久等保底輪詢（5 分鐘）。需要兩次推送在幾毫秒內由不同實例處理才會發生，很罕見；要更嚴謹得用 RTDB 的條件寫入（ETag），這次沒做。
- **`touchDevice` 接手 speaker 不寫指標**（現有行為本來就不敲門鈴）：speaker 在沒人說話時悄悄換人，別台要等下一次拉取才知道。
- **事件觸發的拉取也會打一次 irori-relay `inbox`**（`/updates?wait=0` 進場一律拉）。可以另加「這次拉取是指標觸發、不用收信」的參數省掉，這次沒做。
- 保底拉長到 5 分鐘後，**新增提醒後別台的 `next_due` 靠 `p.due` 更新**；不認得 `due` 的端（Android 若沒做）要在新增提醒後自己補拉，否則「一分鐘後提醒我」這類很近的提醒可能晚到最久一個保底間隔。
- `touchDevice` 的 speaker 存活期拉長到 400 秒：訊號模式下，出聲那台**當機或斷網**後最久 400 秒沒人出聲（以前 180 秒）。
- 仲介門鈴頻道名在 kv 快取 6 小時：仲介重新發金鑰（`reissue`）導致 bell_topic 換掉時，最久 6 小時 `signal.b` 還指到舊節點，來信不會被指標通知，靠保底輪詢（以及「漏通知就退回長輪詢」）兜底。換了金鑰後想立刻跟上，刪掉 kv 的 `relay_bell_topic` 即可。
- 每個冷啟動的 Edge Function 實例各自換一次 Google access token（JWT 簽章加一個對 Google 的請求，不算 Supabase 的 Edge Function 呼叫）；token 只放記憶體，不存資料庫。
