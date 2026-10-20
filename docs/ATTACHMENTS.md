# 附件（傳照片、傳檔案）設計

狀態：已實作，尚未部署（migration 與函式要維護者同意後才套用，步驟見最後一節）。對應 [ROADMAP.md](ROADMAP.md) 第 5 項。

## 原則

- 照片**不進信件內文**：檔案放後台 Supabase Storage 的私有 bucket，信裡只帶「附件編號＋縮圖資訊」。
- 寄件端在本機壓縮（長邊 2048、webp、≤ 5 MB），向 `relay` 函式要一次性上傳網址，傳完確認，再寄信。
- 只有寄件節點與收件節點（群組信＝群組成員）能換到下載網址，短效（5 分鐘）；拿到編號的別人打不開。
- 預設保存 30 天，之後檔案與縮圖都刪；信的文字仍依訊息規則保存 90 天。每台設備有總量上限。
- 金鑰只在各端的程式裡（ASN 的 Rust、`send/recv` 腳本）；網頁介面與模型拿不到。
- 型別用白名單：照片只收 webp（5 MB）；一般檔案收 pdf、txt、md、json、csv、zip、docx、xlsx、pptx（25 MB，不壓縮、不轉檔），可執行檔一律擋。新增型別只要加白名單一列，不改流程。

## 一般檔案（kind=file）

- 白名單（副檔名＝型別）：pdf、txt、md、json、csv、zip、docx、xlsx、pptx。單檔 ≤ 25 MB；每台設備未過期附件合計 ≤ 500 MB 且 ≤ 300 個（照片與檔案共用）。
- 不壓縮、不轉檔，位元組原樣上傳。三道檢查：ASN 的 Rust 端（副檔名、內容檔頭、大小）→ 後端 `attach_init`（副檔名與型別一致、大小）→ 後端 `attach_commit`（Storage 實際大小與型別）；下載端（ASN、`attach.mjs`）存檔前再比對一次內容檔頭（pdf＝`%PDF-`、zip／Office＝`PK`、文字檔不得含 NUL）。
- 顯示：ASN 對話裡是檔案卡（檔名、大小、點一下下載並另存到 `下載\ASN`）；Claude 視窗與雲端代理收到 `〔檔案〕檔名（2.5 MB）下載：node "…/attach.mjs" --id <編號>`。
- 授權、30 天保存、清理與照片完全相同。

## 可重用的送出介面（給之後的截圖標註功能）

- 前端：`photo-canvas.mjs` 的 `imageFromBlob(blob, name)`（任何圖片 Blob → 縮圖、轉 webp、附縮圖）、`fileFromBlob(blob, name)`、`attachmentFromFile(file)`；再交給 `core.sendAttachment(id, item, caption)`。截圖功能只要把標註後的 canvas 轉成 Blob 呼叫這兩步。
- Rust：`relay_send_attachment`（payload 見 `attach.rs` 的 `parse_photo`）。

## 資料表與 bucket（migration `20261020000500_attachments.sql`）

bucket `attachments`：**私有**、單檔上限 25 MB、`allowed_mime_types` 為上述白名單（照片另外在表與函式限 5 MB）。`storage.objects` 加一條針對 `anon`、`authenticated` 的限制性政策，這個 bucket 的物件任何情況都不開給前端角色；只有函式用 service role 簽網址。

表 `relay.attachments`（RLS 開、不建 policy、收回前端角色權限，與其他表一致）：

| 欄位 | 說明 |
|---|---|
| `id` | 附件編號（uuid，函式產生） |
| `tenant_id`、`owner_node` | 租戶、上傳的節點（＝寄件人） |
| `kind` | `image`（照片）或 `file`（一般檔案；檔案沒有縮圖與尺寸） |

| `mime`、`bytes`、`name` | 內容型別、位元組數、檔名（去除控制字元與括號，≤ 80 字） |
| `width`、`height` | 圖片尺寸（可空） |
| `thumb` | 縮圖：`data:image/webp;base64,…`，≤ 12000 字（約 9 KB），可空 |
| `sha256` | 內容雜湊（可空，預留去重） |
| `storage_path` | `<租戶>/<節點>/<附件編號>.webp` |
| `status` | `pending`（已要網址、未確認）→ `ready`（已確認）→ `expired` |
| `message_id` | 綁定的一對一信件；`room_id`＋`room_seq` 綁定的群組訊息 |
| `created_at`、`committed_at`、`expires_at`、`removed_at` | `expires_at` 預設建立後 30 天；`removed_at` 是檔案真的從 Storage 刪掉的時間 |

不改既有的信件資料表與函式：附件關聯放在這張表，後端在回信件時**附帶**查出來。

## API 動作（Edge Function `relay`，金鑰同其他動作）

| 動作 | 說明 |
|---|---|
| `POST attach_init` | 要上傳網址。body：`kind`（image）、`mime`、`name`、`bytes`、`width`、`height`、`thumb`、`sha256`（可空）。檢查白名單、大小、縮圖格式、**每台設備總量**（未過期的附件合計 ≤ 500 MB 且 ≤ 300 個）、每分鐘 30 次。回 `{id, upload_url, expires_in, expires_at}`；`upload_url` 是 Storage 的一次性簽名網址，用 `PUT` 傳檔案位元組（`content-type: image/webp`）。 |
| `POST attach_commit` | body：`id`。後端向 Storage 查實際大小與型別，一致才把 `pending` 改 `ready`；不一致刪檔並回 400。 |
| `GET attach_url&id=<編號>` | 換下載網址。回 `{url, expires_in, name, mime, bytes}`；不是寄件人、收件人（群組＝成員）一律 404（不分「不存在」與「沒權限」），過期回 410。 |
| `POST attach_sweep` | 只有 `owner` 角色節點能呼叫：把過期與放棄的上傳真的從 Storage 刪除。`attach_init` 也會順手清最多 20 筆。 |
| `POST send`（既有） | 新增選填 `attachment_ids`（uuid 陣列，最多 4）。寄出前驗：每個都是自己上傳、`ready`、尚未綁定、未過期；寄出後綁定到這封信。 |
| `POST room_post`（既有） | 同樣選填 `attachment_ids`；綁定到該群組訊息。 |
| `GET inbox`、`room_read`（既有） | 每封信多一個 `attachments` 陣列（沒有附件就不帶這欄）。 |

## 信件的附件欄位（向下相容）

```json
{
  "id": "…", "body": "〔照片〕cat.webp\n看這隻",
  "attachments": [
    { "id": "<附件編號>", "kind": "image", "name": "cat.webp", "mime": "image/webp",
      "bytes": 183422, "width": 1536, "height": 2048,
      "thumb": "data:image/webp;base64,…", "expires_at": "2026-11-19T…Z", "expired": false }
  ]
}
```

- 內文 `body` 照舊必填。寄件端在內文最前面放一行**可讀的替代文字** `〔照片〕檔名`，所以沒升級的用戶端（舊版 ASN、舊橋、舊腳本）看到的是「有一張照片，檔名是…」，不會看到亂碼，也不會壞。
- 新用戶端讀 `attachments`；舊用戶端不認得這個欄位就忽略。
- 信件資料表不動，也就不需要改 `irori_relay_send`／`inbox`／`room_*` 這幾個大函式。
- 過期後 `expired: true`、`thumb` 為 null。
- 型別白名單在 `_shared/attachments.ts` 的 `ATTACH_KINDS`／`FILE_TYPES`，要同時更新 migration 的 bucket `allowed_mime_types` 與表的 mime check（有守門測試比對兩邊）。檔案的副檔名必須在白名單且與型別一致（例如 `.exe` 標成任何型別都被擋）。

## 授權

- 上傳：金鑰決定寄件節點（`owner_node` 一律是金鑰所屬節點，body 不能指定）。
- 綁定：只有上傳者能把自己的附件綁到信上，且一個附件只能綁一次。
- 下載：`attach_url` 只在下列任一成立時發網址 ── 呼叫者是上傳者；呼叫者的節點是綁定信件的收件節點；呼叫者所屬節點是綁定群組的有效成員。網址 300 秒失效，每次下載重新要。
- 簽名網址由 service role 產生，bucket 對前端角色完全關閉，所以沒有其他途徑能讀檔。

## 保存與清理

- `relay-purge-attachments`（pg_cron，每天 03:27 UTC，仿 `relay-purge-90d`）：把到期或放棄超過 1 小時的上傳標成 `expired` 並清掉縮圖；`removed_at` 已有值且超過 90 天的列刪除。
- 實體檔案**只能經 Storage API 刪**（直接刪 `storage.objects` 資料列不會刪到底層檔案），所以由函式的 `attach_sweep`（與 `attach_init` 的順手清理）真的刪檔並寫 `removed_at`。部署後建議由維護者排一個每日呼叫 `attach_sweep` 的排程（見下），否則流量很低時過期檔案會多留一陣子。到期的附件不論檔案是否已刪，下載一律回 410。

## 用戶端

- **ASN 電腦版**：選圖（或貼上）→ 前端畫布縮到長邊 2048 並轉 webp（逐步降品質到 ≤ 5 MB）、另做 256 長邊縮圖 → 交 Rust 指令 `relay_send_attachment`。Rust 檢查檔頭是 webp、大小 ≤ 5 MB、縮圖格式，才依序 `attach_init` → `PUT` → `attach_commit` → `send`（金鑰只在 Rust）。對話裡顯示縮圖，點了放大（Rust 指令 `relay_attachment_fetch` 取回整張，轉成 data URL 顯示），可「另存」（`relay_attachment_save`，存到 `下載\ASN\`）。
- **Claude 視窗（收發室橋轉交）**：橋把信轉給視窗時，在內文後面加一行 `〔照片〕檔名（image/webp，183 KB，1536×2048）下載：node "…/attach.mjs" --id <編號>`，與內文一起放在既有的外部資料區塊內（`<<<MAIL … MAIL>>>`）。`recv.mjs` 的 JSON 行同樣把這行附在 `body` 後面，並多一個 `attachments` 欄位。
- **雲端代理**：`inbox.mjs` 顯示同樣的一行，`attach.mjs` 下載；`inbox.jsonl` 保存原始的 `attachments`（不含縮圖）。
- 下載腳本（`relay/machine/attach.mjs`、`relay/cloud-agent/attach.mjs`）：`--id <編號> [--out <路徑>]`，向 `attach_url` 換網址再下載，預設存到工作資料夾的 `attachments/`，檔案權限 600，不覆蓋既有檔案，下載後檢查大小與 webp 檔頭，印出本機路徑。網址只接受與收發室同一主機。
- 檔名與其他欄位來自寄件人，視為外部資料：進替代文字、提示行前一律清掉控制字元、換行與括號；附件編號必須是 uuid 才會組進指令。

## 相容與風險

| 情況 | 行為 |
|---|---|
| 舊 ASN／舊橋收到新信 | 看到內文第一行 `〔照片〕檔名`，沒有縮圖與下載，不壞 |
| 新 ASN 寄給舊橋 | 同上，舊橋當純文字轉交 |
| 後端尚未部署新函式 | 新 ASN 的 `attach_init` 回 404，介面顯示「這個收發室還不支援傳照片」，不寄信 |
| `attachment_ids` 給舊函式 | 舊函式忽略該欄位，信照寄、沒有附件（所以部署順序是先函式、後用戶端） |
| 綁定失敗（寄出後極少數競態） | 信已寄出但沒有附件；內文的替代文字仍在，寄件人可重傳 |

## 部署順序（維護者同意後）

1. 套用 migration `20261020000500_attachments.sql`（`npx supabase db push`）。
2. 部署函式 `relay`（`npx supabase functions deploy relay --project-ref etccgmkrosbzpltudlgt`）。
3. 冒煙：用假金鑰呼叫 `?action=attach_url&id=00000000-0000-0000-0000-000000000000` 應回 401。
4. 發新版 ASN 與收發室橋、雲端代理腳本。
5. 選用：排每日 `attach_sweep`（例如 owner 節點的排程工作呼叫一次）。
6. 官網隱私權政策（已改檔）另行部署。
