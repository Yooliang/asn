# 以帳號為「我」（#108）設計筆記

小良哥在家、公司、（之後）手機上用 ASN 跟同一位 AI 說話，對話不該被拆成三段。做法：登入後，「我」是帳號，不是這台設備。

## 一句話版

- **寄出**：登入的 ASN 寄信時，寄件人是「我的人代號」，不是這台設備的視窗名；後台仍記真實的寄件節點（頻率限制、已讀狀態、稽核都照舊）。
- **回信**：AI 回給人代號 → 後台複製成多列，帳號底下每個在線的 ASN 視窗各一列、各自 ack，不互搶。
- **記錄**：打開對話時向後台取「我和這位夥伴」90 天內的往來，補進本機；本機的 `asn-chats.json` 只當快取。
- **相容**：沒登入、舊版 ASN、機器橋、雲端代理的行為一個字都不變。

## 人代號

`u:` 加十二位十六進位（`public.asn_person_alias(使用者 id)`，對使用者 id 做固定字首的雜湊，不可回推）。每個帳號一個，穩定不變。AI 只會在信上看到它（`from_agent`），不需要理解；`trust=owner` 已經告訴它這是本人。

## 以人寄出

條件全部成立才換（資料庫 `irori_relay_send` 的 `p_as_person`）：

1. 信裡明說 `as_person: true`（新版 ASN 才會說）；
2. 本人簽章有效（#118 的 `x-asn-user`，驗過且「節點與租戶都是這個人的」）；
3. 簽章的人就是租戶擁有者；
4. 收件人不是同帳號的另一個 ASN 視窗（設備互聊要看得出是哪台設備，維持視窗名）。

成立時：`from_agent` 換成人代號，信上記 `person_user`。真實寄件節點 `from_node` 不動。

AI 收信時（`asn_relay_inbox`／`asn_relay_inbox_agent`），本人寄來的信的 `from_node` 是**實際寄出的設備節點**（migration `20261023140000_reply_to_person.sql` 起；之前是租戶擁有者節點 XISU，害回信寄到已不在線的角色節點）。AI 回信的慣例仍是 `to_node = from_node`、`to_agent = from_agent`，`to_agent` 是人代號就走下面的扇出；舊用戶端只寫節點（沒有視窗）寄給租戶角色節點的信，後台保底改寄本人位址。角色節點 XISU 在 `20261023150000_drop_xisu.sql` 拿掉，舊寫法 `XISU`、`XISU/u:xxxx` 仍視同寄給本人。

## 回信扇出

AI 寄給人代號（`to_agent` 等於租戶擁有者的人代號）時，資料庫不照 `to_node` 投遞，而是：

- 找帳號名下**3 分鐘內有回報在線**的 ASN 視窗（`relay.asn_presence`，最多 10 個），每個插一列（`to_node`＝該設備節點、`to_agent`＝該視窗名），列之間以 `fanout_id`（＝第一列的 id）相連、都記 `person_user`。
- 各列各自 `delivered_at`／`acked_at`：一台收到 ack 不影響另一台。ASN 收信路徑完全沒改（它本來就收「寄給自己視窗名」的信）。
- 沒有任何在線視窗：留一列給原收件節點（它不在了就挑帳號名下最早的節點），不讓 AI 的回信失敗；人打開 ASN 時從往來記錄補看。
- 回傳 `bell_topics`，Edge Function 每個都敲門鈴。
- 頻率限制按「一則」算（`count(distinct coalesce(fanout_id, id))`），不因扇出的複本變多而提早被擋。
- 附件綁在代表列：各複本查附件時對回代表列（`irori_relay_attach_for`），信上記 `person_user` 的附件，帳號名下的任何節點都能下載（`irori_relay_attach_access`）。

## 往來記錄

動作 `chat_history`（Edge Function `relay`）→ `public.asn_chat_history(使用者, 節點, 夥伴節點, 夥伴視窗名, 筆數)`：

- **必須帶本人簽章**。節點金鑰 AI 的視窗也拿得到（`.asn`），但登入憑證只在 ASN 的 Rust 端；不要簽章就等於任何 AI 都能讀人和所有夥伴的往來。沒簽章 401、簽章的人不擁有這個節點 403。
- 回「我寄給這位夥伴」與「這位夥伴寄給我」兩個方向、90 天內、最多 200 則（預設 100），由舊到新；扇出的複本合成一則，`id` 是代表列、`ids` 是所有複本（讓舊的本機快取也對得上）。附件資訊一併附上。
- 夥伴改名後（#153）：請求可帶 `partner_id`，另外以「帳號＋夥伴 ID」查（`asn_chat_history` 第六個參數），改名前後的往來都拿得到，見 PARTNER-ID.md 第二期。
- 多設備修正（migration `20261022100000_chat_history_fanout_device.sql`）：同一個 `fanout_id` 只回一列（優先呼叫端節點自己的那份，沒有就最早的一份），回傳帶 `fanout_id`；每則另帶真實寄出節點 `from_node` 與設備名 `from_node_name`。
- 前端合併以 `fanout_id` 去重（本機已有的那則優先；後台一次回多列同 `fanout_id` 也只收一則；沒有 `fanout_id` 的照舊用 id）。補進來的信不算未讀，所以去重不影響已讀／未讀。
- 「從哪台設備」：自己（本人）寄的信，寄出節點不是這台時，在名字旁小字標「從 Oppo 手機」（設備名優先取名單的，沒有就用後台帶的）；這台寄的、對方寄來的都不標；畫面不顯示節點代號。
- 只認有 `person_user` 的信：沒登入時、舊版 ASN 寄的信不在後台往來記錄裡，仍在各自設備的本機記錄（不遷移，不重寫歷史）。

ASN 端（`ui/lib/history.mjs` 的 `mergeHistory`）：

- 時機：打開對話；收到扇出回信後（人在別台說的話，這台才補得到）。同一位夥伴 20 秒內不重問（回信觸發除外）。
- 只「補」本機沒有的信，不改、不刪本機已有的（含系統提示行）；補進來的不算未讀、不跳提示。
- 後台不支援（404／400）→ 這次執行不再問；沒登入或連不上 → 靜默沿用本機快取，下次再試。
- 本機收到扇出的信，記錄用的 id 是代表列 id（`fanout_id`），與後台記錄自然對上。

已讀同步（選做）：這期不做。往來記錄裡已有各則的 `acked_at`（自己寄的信對方讀了沒），「一台讀過、另一台也標已讀」需要另外的已讀指標，留給下一期。

## 相容性怎麼確保

| 情形 | 行為 |
| --- | --- |
| 沒登入的設備、機器橋、asn-cli、雲端代理 | 沒簽章＝資料庫不認 `as_person`；Rust 端沒有憑證時還會先把 `as_person` 拿掉；上述程式碼不含 `as_person`／`chat_history`（守門測試） |
| 舊版 ASN（不說 `as_person`）在新後台 | 寄信完全照舊（視窗名寄出）；收信走原路徑（多一個它不認得的 `fanout_id` 欄位，被忽略）；若 AI 回給人代號，舊版 ASN 所在的設備只要有在線視窗也會收到扇出的那一列 |
| 新版 ASN 在還沒套用 migration 的後台 | Edge Function 遇到「找不到九個參數的 `irori_relay_send`」退回不帶 `p_as_person` 重呼叫；`chat_history` 回 404，ASN 靜默停用 |
| 舊 Edge Function 配新 migration | 舊函式呼叫八個參數，新函式的第九個參數有預設值，行為不變 |
| 同帳號的新舊 ASN 混用 | 新版以人寄出、舊版以視窗名寄出，AI 會看到兩個寄件人；兩邊升級後自然合一 |

## 部署順序

1. 套用 migration `20261022020000_account_me.sql`（新欄位可空、新函式；不影響現有呼叫）。
2. 部署 Edge Function `relay`（`send` 認 `as_person`、`chat_history`、扇出門鈴）。
3. 發新版 ASN（開始說 `as_person`、打開對話時補往來）。

順序反過來也安全（見上表）。

## 已知限制與下一期

- 扇出只送給「3 分鐘內有回報在線」的視窗；關機的設備靠打開對話時的往來記錄補看，不會有提示音。
- AI 看到的人代號是 `u:xxxxxxxxxxxx`；信頭 `from=` 現在直接就是這個代號（不再掛在租戶主節點 XISU 底下），第二行 `寄件人：小良（本人，帳號簽章已驗證，從「Oppo 手機」寄出）` 說明是誰、從哪台寄；回信寫 `--to u:xxxxxxxxxxxx` 即可，舊寫法 `XISU/u:xxxx` 後台仍認。格式規格見 MAIL-HEADER.md。
- 手機版／網頁版直接沿用 `as_person`＋`chat_history` 兩個動作即可。
- 已讀同步、往來記錄分頁（超過 200 則）、舊記錄遷移（把沒有 `person_user` 的舊信認回人）留給下一期。

## 測試

- SQL：`node --test tests/account_me_sql.test.mjs`（靜態檢查；有 `npm i --no-save @electric-sql/pglite` 時真的套用 migration 跑：以人寄出的條件、扇出與各自 ack、AI 看到同一個人、頻率限制、往來記錄、附件）。
- Edge Function：`cd supabase/functions && deno test -A _shared/account_me_test.ts`。
- ASN 前端：`cd relay/asn && node --test test/account-me.test.mjs`。
- ASN Rust：`cargo test --manifest-path relay/asn/src-tauri/Cargo.toml 以人寄出 往來記錄`。
