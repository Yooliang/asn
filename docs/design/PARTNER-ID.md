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
| 名字和 session 都換了 | 新夥伴 | 建新的夥伴 ID（「這是某某的接班」留給第二期） |
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

## 第二期（#108）規劃

- 往來記錄與對話一律掛在「帳號（人）＋夥伴 ID」上：記錄檔改以夥伴 ID 命名，檔頭寫目前名字（第一期的檔頭行就是為此預留；遷移時以檔頭的夥伴 ID 對回舊檔）。
- 信的投遞改以夥伴 ID 為準（收件人解析到夥伴 ID 後，再找它現在的節點與視窗），改名、換 session、搬設備都不斷線。
- ASN 介面：名單與對話只顯示名字；在新開的夥伴上提供「這是某某的接班」（規則 3 的例外，夥伴 ID 沿用、名字與 session 更新）。
- 跨設備：使用者在 ASN 指定接班，夥伴 ID 不變、所在節點更新（第一期的 `partners.node` 已是「目前節點」）。
- 後台聊天記錄以帳號＋夥伴 ID 為鍵（#108 第 3 點）。

## 測試

- Edge Function：`cd supabase/functions && deno test -A _shared/partners_test.ts`（格式整理、錯誤對應、動作排在金鑰驗證之後且節點取自金鑰、規則的純函式版與解析）。
- SQL：`node --test tests/partner_id_sql.test.mjs`（靜態檢查；若以 `npm i --no-save @electric-sql/pglite` 裝了記憶體內 Postgres，會真的套用 migration 逐條跑規則 1～4、冪等、轉寄期、寄信解析，沒裝則略過）。
- 橋：`cargo test --manifest-path relay/asn/src-tauri/Cargo.toml 夥伴`（請求內容、回應解析、不支援時靜默停用、檔頭行與輪替）。
