# 夥伴 ID（#109）設計筆記

AI 夥伴現在以「節點／視窗名」為識別，但視窗名會改、session 會換。夥伴 ID 是每位夥伴一個系統產生、永不改變的身分（`p_` 加 20 個小寫十六進位字元）；使用者看不到，畫面永遠只顯示目前的名字。

## 第一期做了什麼（只記錄，不改變投遞）

- **後台**（migration `20261022000100_partner_id.sql`，尚未套用）：
  - `relay.partners`：夥伴 ID、所屬租戶、目前節點、目前名字（被讓出時為空）、目前 session、引擎、模型、建立／更新時間。同一節點同一個名字同時只屬於一位夥伴（部分唯一索引）。
  - `relay.partner_names`：舊名字與改名時間。`relay.partner_sessions`：歷任 session（空的結束時間＝目前這個），每位夥伴最多留 50 筆。
  - 動作 `partner_sync`（Edge Function relay）→ 資料庫函式 `irori_relay_partner_sync(p_node, p_windows)`：節點取自金鑰；一次最多 100 個視窗；同一節點的同步用 advisory lock 串起來；可重複執行（同一份名單報兩次沒有任何變化）。
  - `messages.to_partner_id`／`from_partner_id`（可空）：寄信的 insert trigger 依「節點＋名字」解析並記下，寄信函式本身一行沒改，誰收到信完全不變。解析失敗不擋寄信。
- **內建橋（Rust）**：每次回報視窗名單後呼叫 `partner_sync`（名字、session 編號取自 `~/.claude/sessions/<pid>.json` 的 `sessionId`、引擎），回來的對照只放記憶體；往來記錄（#107）檔名仍是視窗名，檔案第一行寫 `# 夥伴 ID：p_…｜目前名字：…`，輪替不會弄丟。
- **相容**：後台沒有這個動作（404／400，或函式還沒套用）→ 橋靜默停用到下次啟動、只記一次 log，其餘一切照舊；舊版橋不呼叫＝沒有夥伴記錄、信上的夥伴欄位為空；節點橋（Node）與雲端代理不受影響。

## 判斷規則（每次回報名單時套用）

| 情形 | 判斷 | 記錄 |
| --- | --- | --- |
| 同 session、名字變了 | 同一位夥伴改名 | 舊名寫進 `partner_names`；名字若還掛在另一位夥伴身上（對方已換 session 離開），對方讓出並把這個名字記成它的舊名 |
| 名字相同、session 換了 | 同一位夥伴換 session（同名就接手） | 舊 session 記結束時間，新 session 開始；舊 session 接回來也算同一位 |
| 名字和 session 都換了 | 新夥伴 | 建新的夥伴 ID（「這是某某的接班」由第二期處理，見下） |
| 同一台同時兩個同名（或同 session 出現兩次） | 不處理（維持現有的擋法） | 回傳裡沒有那個視窗，橋也不會有它的夥伴 ID |
| 沒帶 session（舊橋、未知） | 只靠名字：同名認得，名字對不上就當新夥伴 | 不動 session |

session 優先於名字：名字屬於 A、session 屬於 B 時，以 B 為準（B 改名成這個名字，A 讓出）。互換名字也安全（先讓出再改名，不撞唯一索引）。夥伴只在自己的節點內比對；別台的同名是不同夥伴（跨設備接班是第二期）。

寄信解析：目前的名字優先；其次是 7 天內改掉的舊名（轉寄期，與 ASN 的 `old_names` 同樣 7 天），多個舊名都在轉寄期內時最近改的優先。

## 清理

每天 03:31（UTC）：舊名紀錄留 90 天；180 天沒回報的夥伴整筆刪（名字與 session 歷史跟著刪；信上的夥伴欄位只是文字，不受影響）。

## 部署順序

1. 套用 migration（建表、函式、欄位、trigger、排程）。
2. 部署 Edge Function `relay`（加上 `partner_sync`）。
3. 之後出的 ASN 版本自動開始回報。順序反過來也安全：函式部署了但 migration 還沒套 → RPC 找不到函式，回 404，橋靜默停用。

## 第二期（#153）：改名、換 session、換設備都延續同一位夥伴

migration `20261022060000_partner_succession.sql`（尚未套用）。四件事，全部向下相容（見「相容」）。

### 1. 往來記錄檔以夥伴 ID 為鍵（Rust 內建橋 `bridge/corrlog.rs`）

- 後台認得這個視窗（回報名單時拿到夥伴 ID）→ 檔案是 `~/.asn/handoff/<夥伴ID>.md`，檔頭 `# 夥伴 ID：p_…｜目前名字：…` 每次追加時更新成目前名字。視窗改名、換 session 都續寫同一份。
- 後台沒有夥伴 ID（舊後台、橋剛啟動還沒拿到）→ 維持 `<視窗名>.md`，一個字不變。
- 信尾那行「你與收發室的往來記錄在：<路徑>」指向**實際要寫的檔**（先對回舊檔再組路徑，所以信一發出去，AI 讀到的就是併好的那一份）。
- **舊檔對回（`reconcile`，每位夥伴每次執行掃一次）**：資料夾裡檔頭夥伴 ID 等於這位夥伴的舊檔（改名前的視窗名檔），以及這個視窗名底下沒有檔頭的舊檔（第一期以前寫的），依修改時間由舊到新併進 `<夥伴ID>.md`，記錄原樣不重寫、再依每筆標頭行的時間穩定排序（同一秒維持原順序）；併完才刪舊檔，寫不進去就留著下次再試。別位夥伴的檔（檔頭 ID 不同）絕不動，所以舊名字被新夥伴沿用時，新舊夥伴各有各的檔，沒有串檔。
- 後台暫時沒回對照（重啟後第一輪名單還沒回）：先看視窗名舊檔的檔頭沿用；真的沒有就先寫 `<視窗名>.md`，對照回來時再併回去（寫了沒有 ID 的檔會重新開放掃描）。
- 輪替封存檔名用檔案的名稱（`archive/<夥伴ID>-<時間>.md`）；封存檔不帶檔頭，舊的 `archive/<視窗名>-…` 不動。

### 2. 後台：寄給舊名字的信改投新名字（trigger，寄信函式一行不動）

`relay.messages_resolve_partner`（第一期的 before insert trigger）多做一步：收件人（`to_node`＋`to_agent`）解析到夥伴後，**同時成立**才改投——

1. 解析是靠「7 天內改掉的舊名」（沒有夥伴現在叫這個名字）；
2. `relay.roster` 裡沒有同名且 3 分鐘內回報過的在線視窗（名單與夥伴同步之間的空檔也算「有人用」）；
3. 夥伴現在的名字存在、在同一個節點、和寫的不同。

→ `to_agent` 換成現在的名字，原本寫的記在 `forwarded_from`，`to_partner_id` 照第一期記下。名字現在有人用（夥伴現用或名單上有）就一個字不改；超過 7 天、別的節點、解析不到都不改。整段包在 `exception when others then null`，出事不擋寄信。誰收到信因此只在「確實是舊名、新名字存在、舊名沒人用」時才變。

跨設備接班的夥伴不轉寄（舊名在舊節點、夥伴已在新節點；轉寄只限同節點）：接班時不為跨節點的舊名寫 `partner_names`，免得新節點上同名的陌生視窗被誤轉。

### 3. 後台：往來記錄以帳號＋夥伴 ID 查

`asn_chat_history` 多一個選填的 `p_partner_id`（舊的五參數版本先 drop，否則兩版並存會「函式不唯一」）。帶了而且夥伴屬於同一個租戶，就在原本的名字比對之外再 OR 上「我寄給這位夥伴（`to_partner_id`）」「這位夥伴寄給我（`from_partner_id`）」，所以改名前後、換 session 前後的往來都拿得到；第一期以前沒有夥伴欄位的舊信仍靠名字比對。別租戶的夥伴 ID、格式不對的，當沒帶。Edge Function 只在請求帶了合格的 `partner_id` 才傳；資料庫還沒有第六個參數（找不到函式）就退回不帶重呼叫。

名單 `irori_relay_list` 的每個 agent 多帶 `partner_id`（沒同步到的是 null），ASN 用它查往來記錄與指定接班；舊用戶端多一個鍵會直接略過。

### 4. ASN 介面：這是某某的接班（要本人簽章）

- **新動作**（Edge Function `relay`，都要 `x-asn-user` 本人簽章，節點取自金鑰）：
  - `partner_list`：同租戶的夥伴清單（名字、設備名、是否在線，最多 100 位，最近有動靜的在前；被讓出名字的用最近的舊名）。
  - `partner_succeed`：body `{predecessor, node, name}`＝前任夥伴 ID、新視窗所在節點與名字。資料庫函式 `irori_relay_partner_succeed(p_user, p_caller, p_predecessor, p_node, p_name)`：
    - 簽章的人必須擁有「呼叫的節點」與「新視窗的節點」（`asn_user_owns_node`），前任必須在同一個租戶，否則 `forbidden`；沒簽章 401（Edge Function 就擋，不打資料庫）。
    - 新視窗必須已被 `partner_sync` 認進來（有自己的夥伴列），否則 `not_found`（橋剛啟動；介面會稍後再試）。
    - 前任的視窗 3 分鐘內還在名單上 → `predecessor_live`（409）：兩個視窗不能同時用同一個夥伴 ID，請先把舊視窗關掉。
    - 成功：夥伴 ID 沿用前任；`node`／`current_name`／`current_session`／引擎／模型改成新視窗的；新夥伴的 session 與舊名紀錄併進前任（前任原本開著的 session 記結束時間，最多留 50 筆）；信上 `to_partner_id`／`from_partner_id` 指向新夥伴的全部改指前任；新視窗原本那筆夥伴刪除；同節點時前任原本的名字記成舊名（寄給它的信會轉到新名字）；寫一筆 `relay.partner_handovers`（稽核，跟著夥伴一起刪）。同一個新視窗重複送出沒有副作用。兩個節點的同步鎖按固定順序拿，接班期間 `partner_sync` 不會插進來。
- **跨設備接班**：呼叫節點、新視窗節點、前任原本的節點可以是三台不同的設備（只要都是這個人的）；成功後夥伴的目前節點就是新視窗所在的設備。
- **ASN 介面**（純中文，不顯示夥伴 ID 與節點代號，守門測試檢查模板裡沒有 `partnerId`／`partner_id` 的插值）：
  - 「開新夥伴」對話框，有登入且清單取得到時多一個下拉「這是誰的接班（選填）」，選項是「名字（設備名）」，預設「不是接班，是全新的夥伴」。選了就在送出啟動後記一筆等待中的接班，新視窗一出現在名單且後台認得它（有夥伴 ID）就送 `partner_succeed`；前任視窗還開著就每輪重試並提示「請先把它關掉」，放棄時（5 分鐘、被拒絕）跳通知。
  - 名單上的視窗（在線、後台已認得）右鍵多「這是誰的接班…」：選前任、確定。已經是名單上的新視窗用這個。
  - 清單只列視窗已關閉的夥伴、不列自己。沒登入或後台還沒支援（404）→ 不顯示這個選項。
- 往來記錄：ASN 把名單裡的 `partner_id` 存在好友資料（離線時也留著），向後台問往來時一併帶上。

### 相容（為什麼舊東西不會壞）

| 情形 | 行為 |
| --- | --- |
| 舊 Node 橋（工作機還在用）、雲端代理、沒有夥伴 ID 的節點 | 不呼叫 `partner_sync`，沒有夥伴列：轉寄條件第 1 點不成立，信完全照舊；它們的檔案與程式碼沒有 `partner_succeed`／`partner_list`（守門測試：Node 端檢查檔案內容、Rust 端檢查 `bridge/`、`cli/`、`bin/` 原始碼） |
| 舊版 ASN（不送 `partner_id`、不認 `partner_id` 鍵） | 往來記錄照舊用名字比對；名單多一個鍵被略過；沒有接班介面 |
| 新版 ASN 配還沒套 migration／沒部署的後台 | `partner_sync`、`partner_list`、`partner_succeed` 都是 404：橋靜默停用（第一期已有）、接班選項不顯示；往來記錄的 `partner_id` 被 Edge Function 退回不帶重呼叫（或舊 Edge Function 直接忽略多的欄位） |
| 舊 Edge Function 配新 migration | 舊函式呼叫五個參數的 `asn_chat_history`，新函式第六個參數有預設值，行為不變；`irori_relay_list` 多一個鍵 |
| 後台暫時沒回夥伴 ID（橋重啟後第一輪） | 往來記錄先寫 `<視窗名>.md`，ID 回來後併回夥伴檔，不丟 |
| 橋的往來記錄檔 | 後台沒有夥伴 ID 的視窗檔名與格式一個字不變；只有拿到夥伴 ID 的視窗才改鍵 |

### 部署順序

1. 套用 migration `20261022060000_partner_succession.sql`（新欄位可空、新表、函式；trigger 與名單函式是 `create or replace`，`asn_chat_history` 換簽章，交易內完成）。
2. 部署 Edge Function `relay`（`partner_list`、`partner_succeed`、`chat_history` 帶夥伴 ID）。
3. 發新版 ASN（橋改檔名、介面接班）。

順序反過來也安全（見上表）。已知限制：橋的 `reconcile` 只併「檔頭夥伴 ID 對得上」與「同視窗名沒檔頭」的舊檔；第一期期間視窗改名前寫的、而且當時還沒拿到夥伴 ID 的舊名檔（沒有檔頭）認不出是誰的，原地保留不丟，但不會自動併進來。

## 測試

- Edge Function：`cd supabase/functions && deno test -A _shared/partners_test.ts`（格式整理、錯誤對應、動作排在金鑰驗證之後且節點取自金鑰、規則的純函式版與解析）。
- SQL：`node --test tests/partner_id_sql.test.mjs`（靜態檢查；若以 `npm i --no-save @electric-sql/pglite` 裝了記憶體內 Postgres，會真的套用 migration 逐條跑規則 1～4、冪等、轉寄期、寄信解析，沒裝則略過）。
- 第二期（#153）SQL：`node --test tests/partner_succession_sql.test.mjs`（同上，有 pglite 才實跑：轉寄、接班、跨設備、往來記錄、名單與清單）；Edge Function：`deno test -A _shared/partners_test.ts _shared/account_me_test.ts`；ASN 前端：`node --test test/succession.test.mjs`；橋：`cargo test corrlog`。
- 橋：`cargo test --manifest-path relay/asn/src-tauri/Cargo.toml 夥伴`（請求內容、回應解析、不支援時靜默停用、檔頭行與輪替）。
