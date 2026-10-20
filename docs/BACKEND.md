# 後端（新 Supabase 專案 asn）

專案：Supabase `asn`，區域東京，專案代號 `etccgmkrosbzpltudlgt`。
函式網址：`https://etccgmkrosbzpltudlgt.supabase.co/functions/v1/relay`

## 結構

```
supabase/
  config.toml                 [functions.relay] verify_jwt = false
  migrations/                 新後台的 migration（Supabase CLI 格式，已全部套用）
  functions/
    relay/index.ts            Edge Function（所有 HTTP 動作）
    _shared/*.ts              共用邏輯＋單元測試（房間、信箱、名單、啟動器、頭像、訊號、是否回信）
    irori-relay/index.ts      舊後台用的函式，切換完成後移除
  sql/                        舊後台用的編號 SQL，切換完成後移除（rollback/ 是對應回復檔）
  provision_*.py              手動建立節點／邀請碼的備援腳本
```

### 資料表（schema `relay`，不暴露給 PostgREST）

| 表 | 用途 |
|---|---|
| `tenants` | 租戶（目前只有一個）；含序號與 `owner_user` |
| `nodes` | 節點：代號、名稱、`key_hash`、`bell_topic`、種類、角色（owner／member）、`can_invite`、`can_roster`、狀態（active／left）、`last_seen_at`、頭像、所在設備名稱、**`owner_user`**（對應 `auth.users`，可為空＝尚未認領） |
| `invites` | 一次性邀請碼（只存雜湊，15 分鐘失效） |
| `register_attempts` | 註冊限流計數 |
| `messages` | 一對一訊息：寄收節點與視窗、內文（≤ 20,000 字）、`reply_to`、`expects_reply`、`created_at／delivered_at／acked_at` |
| `roster` | 各節點回報的視窗名單 |
| `launches` | 遠端開視窗的請求與結果 |
| `rooms`／`room_members`／`room_messages`／`room_pins` | 群組、成員（含已讀序號、自動入群來源）、群組訊息（含 `mentions`、群組內遞增序號）、置頂現況（版本號樂觀鎖） |

所有表啟用 RLS、不建 policy，並收回 anon／authenticated 權限。

### 函式與權限

- `relay` 內部輔助函式（schema `relay`）與 `public.irori_relay_*`（約 38 個）全部 SECURITY DEFINER，**只授權 service_role**。
- Edge Function `relay` 不驗 JWT（`verify_jwt = false`），自己用節點金鑰驗證；用 service role 呼叫上述函式。
- 動作一覽（`?action=`）：`register`、`whoami`、`list`、`roster`、`set_avatar`、`avatar`、`leave`、`update`、`invite`、`reissue`、`inbox`、`ack`、`sent_status`、`send`、啟動器（`launch_*`）、群組（`room_list／room_read／room_post／room_pin_get` 等）。誰能用哪個動作以 `index.ts` 與 `_shared/` 為準。

### 排程

- `relay-purge-90d`（pg_cron）：每天 03:17（UTC）刪除超過 90 天的 `messages` 與 `room_messages`；群組置頂不刪。migration `20261020000400`。

- `relay-purge-attachments`（pg_cron）：每天 03:27（UTC）把到期（30 天）與放棄的上傳標成 `expired` 並清掉縮圖；實體檔案由函式的 `attach_sweep` 經 Storage API 刪除。migration `20261020000500`。

### 附件（照片與檔案）

私有 Storage bucket `attachments`＋表 `relay.attachments`；動作 `attach_init`、`attach_commit`、`attach_url`、`attach_sweep`，`send`／`room_post` 可帶 `attachment_ids`，`inbox`／`room_read` 回的信多一個 `attachments` 欄位。設計、授權、型別白名單與部署順序見 [ATTACHMENTS.md](ATTACHMENTS.md)。

### 門鈴

函式在寫入訊息後，用服務金鑰呼叫 Realtime 的 broadcast REST（`/realtime/v1/api/broadcast`，event `bell`，非私有頻道，payload 為空）。新專案不需額外設定。用戶端訂閱時要用**新專案的 anon（公開）金鑰**。

### 選用的環境變數（Edge Function secrets）

`IRORI_FIREBASE_DB_URL`、`IRORI_FIREBASE_SA`：Firebase 訊號（設計見 `docs/relay/SIGNAL.md`），兩者都設才啟用，未設則該功能關閉。新專案目前未設。

## 部署與 migration（需維護者同意）

工具：Supabase CLI（`npx supabase …`），需先 `supabase login`（個人存取權杖，不進 repo）。

```
# 連結專案
npx supabase link --project-ref etccgmkrosbzpltudlgt

# 檢視 migration 狀態
npx supabase migration list

# 套用 migration（檔名時間戳遞增，新增檔案不要改舊檔）
npx supabase db push

# 部署 Edge Function
npx supabase functions deploy relay --project-ref etccgmkrosbzpltudlgt

# 臨時查詢（只讀為原則）
npx supabase db query --linked "select count(*) from relay.messages"
```

守則：
- migration 只新增檔案，已套用的不改；每個 migration 盡量附回復做法（見 `supabase/sql/rollback/` 的寫法）。
- `supabase/.temp/` 是 CLI 的本機暫存，已列入 `.gitignore`。
- 後端單元測試：`cd supabase/functions && deno test -A _shared/`。
- 冒煙測試：用假金鑰與不帶金鑰呼叫 `?action=whoami`，兩者都應回 401。
- 不要在 SQL 查詢或 log 中輸出 `key_hash`、金鑰或訊息內文。

## 與舊後台的差異

- 函式名稱由 `irori-relay` 改為 `relay`，網址路徑跟著變。
- 不帶 Irori 專用的函式（讀寫 Irori 自己資料表的 inbound／outbound／mark_read、`account_view`）。
- 無參數的 `irori_relay_room_auto_rules()` 內含租戶 1 的固定識別碼，之後可移除。
- 新增 `nodes.owner_user`。
