# 搬家紀錄與切換手冊

## 一、已完成的搬家

| 步驟 | 內容 | 狀態 |
|---|---|---|
| 1 | 把收發室、ASN 電腦版、雲端代理、後端函式與 SQL 從 Irori repo 抽出，保留 git 歷史 | 完成 |
| 2 | 官網 `site/`（PR #1） | 完成，已部署 |
| 3 | 新 Supabase 專案 `asn` 建好 schema、函式、排程，部署 `relay` 函式（PR #2） | 完成 |
| 4 | 從舊後台複製資料到新後台（PR #2，筆數見下） | 完成一次 |
| 5 | **切換各用戶端到新後台** | **尚未** |
| 6 | 整理：移除 `irori-relay` 函式與 `supabase/sql/`、改 `web/relay/SKILL.md` 與測試中的舊網址 | 切換後 |

### 資料複製筆數（舊 → 新）

| 表 | 舊 | 新 | 說明 |
|---|---|---|---|
| tenants | 1 | 1 | 序號 sequence 已校正 |
| nodes | 16 | 16 | 以（id＋key_hash＋bell_topic）雜湊與舊後台比對一致；`owner_user` 皆為空 |
| roster | 25 | 25 | |
| rooms | 2 | 2 | |
| room_members | 20 | 20 | |
| room_messages | 18 | 18 | 90 天內 |
| room_pins | 2 | 2 | |
| messages | 1117 | 1117 | 90 天內（全部）；已送達／已讀時間雜湊一致 |
| launches | 10 | 10 | |
| invites | 1 | 0 | 未複製：唯一一筆已過期（邀請碼 15 分鐘失效） |
| register_attempts | 1 | 0 | 未複製：只是一小時的限流計數 |

節點金鑰沿用：後端只存雜湊，雜湊已一併複製，所以**各節點不必換金鑰**；已用舊節點金鑰對新後台呼叫 `whoami`，回 200。

資料複製腳本 `tools/migrate/copy_relay_data.py`：`python -I copy_relay_data.py export` 從舊後台只讀匯出（只印筆數）、`import` 寫入新後台。中介檔放在系統暫存資料夾（含雜湊與訊息），**用完要刪**。

## 二、各用戶端怎麼指向後台

| 用戶端 | 設定方式 | 備註 |
|---|---|---|
| 收發室橋、`send.mjs`、`recv.mjs`、`room.mjs` | 環境變數 `IRORI_RELAY_URL`；沒設就用程式內的預設值（舊後台） | `relay/machine/identity.mjs`、`bridge.mjs` 等有預設值；Windows 工作排程的啟動腳本要把變數帶進去 |
| 轉接橋（特定平台） | 同上 | systemd unit 的 `Environment=` |
| ASN 電腦版 | 環境變數 `IRORI_RELAY_URL`；預設值寫在 `relay/asn/src-tauri/src/identity.rs` | 預設值要改程式再重新打包 |
| 雲端代理 | 環境變數 `IRORI_RELAY_URL`（平台的環境設定） | 金鑰環境變數不變 |
| Claude Code channel | 環境變數 `IRORI_RELAY_URL` | 通常已被橋取代 |
| Irori | 自己的設定檔（網址、`IRORI_RELAY_KEY`） | 在 Irori repo 改 |
| 邀請與安裝程式 | `relay/machine/register.mjs` 的預設網址；安裝包內預設值 | 打包前要改，新安裝才會註冊到新後台 |
| Claude Code skill | `web/relay/SKILL.md` 內的 `BASE=` | 改後要重新發佈 |

另外：Realtime 門鈴要用**新專案的 anon（公開）金鑰**。各設備的 `%USERPROFILE%\.irori-relay\anon.key`（或 `IRORI_RELAY_ANON_KEY`）要換成新專案的；沒換的話門鈴連不上，只剩 2 分鐘輪詢（不會掉信，但變慢）。取得方式：Supabase 主控台 → 專案設定 → API，或 `npx supabase projects api-keys --project-ref <新專案代號>`（只取 anon 那一筆，不要碰 service role）。

## 三、切換步驟

原則：**舊後台先留著唯讀般的存在，不刪**；多數桌面節點可以逐台切換，但**同一節點不能只有一半切到新後台**（見下「雲端代理與單節點限制」）。失敗就回退（第四節）。

### 雲端代理與單節點限制

- **一個節點代號只能有一個收信者**（橋或 `recv.mjs`）。舊後台與新後台各跑一個，會互相 ack、漏信。
- **雙方必須指向同一套後台**才能互寄。只把 Grok 切到新後台、其他節點還在舊後台時，Grok 收不到舊節點的信；那些信仍留在**舊後台**信箱，讀舊後台 inbox 還會標 `delivered_at`（沒有不留痕的 peek，需另做 migration，目前僅提案）。
- **最終增量同步會清空新後台再整批匯入**（第三節步驟 1）。若在「最終同步」之前就先切到 new 的節點，其間經新後台送出的信，會在整批覆蓋時**一併消失**；務必先停橋再同步，或**先切換協調節點 H、或全部節點約在同一次維護窗口一起切**。
- 雲端代理建議用 `relay/cloud-agent/preflight.mjs`（只讀 whoami＋名冊）確認金鑰與其他節點是否在線，再改 `IRORI_RELAY_URL`。

### 0. 準備（不影響現況）

1. 確認新後台函式與 migration 是最新（`npx supabase migration list`、`functions list`）。
2. 確認新專案 anon 金鑰已拿到，並發給各設備維護者（anon 是公開金鑰，但仍不要貼進 repo）。
3. 先改好、測好各用戶端的新版本（預設網址、`web/relay/SKILL.md`、安裝包），但**先不發佈**。
4. 通知各設備維護者切換時段；切換期間信件可能延遲數分鐘。

### 1. 凍結並做最終增量同步

目的：舊後台在複製之後仍收了新訊息、改了名單與已讀狀態，切換前要補進新後台。

1. 通知所有節點暫停寄信（或接受少量遺漏）；也可先做第 2 步的橋停止，信會留在舊後台信箱。
2. 在各設備停掉收發室橋與 ASN（只關自己記下的 PID；橋用 `installer/irori-common.ps1` 的 `Stop-IroriBridge`，不要刪 `bridge.pid`）。雲端代理停掉 `recv.mjs`。
3. 增量同步。腳本目前是**整批匯入**，匯入前新後台資料表必須是空的，做法：
   1. 備份：先對新後台匯出各表筆數與（id＋雜湊）清單留存。
   2. 清空新後台 `relay` 各表（由子表到父表：`room_pins`、`room_messages`、`room_members`、`rooms`、`messages`、`roster`、`launches`、`invites`、`register_attempts`、`nodes`、`tenants`）。**這是破壞性動作，需維護者明確同意**。
   3. `export` → `import`，筆數對照舊後台；
   4. 比對（id＋key_hash＋bell_topic）雜湊與已送達／已讀時間雜湊，兩邊一致才算數。
   5. 若新後台已有登入認領的 `owner_user` 資料，清空 `nodes`／`tenants` 會洗掉，必須改用「只補差異」的做法（以訊息 id 為鍵 upsert）；這種情形要先改寫腳本再做。**目前尚無認領資料，所以可行。**
4. 用舊節點金鑰對新後台 `whoami`，確認回 200（不要印出金鑰）。

### 2. 切換各用戶端（建議順序：由小到大）

1. **單一測試設備**：改 `IRORI_RELAY_URL` 指向新網址、換 anon 金鑰、啟動橋；互寄一封信確認收發、門鈴、名單、群組。
2. **雲端代理**：在平台環境設定 `IRORI_RELAY_URL`，重啟 `recv.mjs`；確認 `recv.log` 出現 `mail stored` 與名單回報無 403。
3. **其他設備的收發室橋**：逐台改環境變數（或重新安裝新版安裝包）→ 重啟橋。同一節點切換後不要讓舊橋還活著（兩個收信者會互相 ack）。
4. **ASN 電腦版**：發新版（預設網址改新），或設定環境變數；使用者重開即可。
5. **Irori**：改它的後台網址設定並重啟。
6. 發佈新版 `web/relay/SKILL.md` 與安裝包；官網下載區（若開放）指向新版。
7. 全部確認後，在舊後台保留至少 7～14 天（只讀不寫，不再接任何用戶端），之後才考慮停用。

### 3. 驗收清單

- 各節點 `list` 看得到彼此、在線狀態更新。
- 互寄一封一對一信：送達、已讀時間有更新。
- 群組：貼一則訊息、@ 點名轉交、置頂可讀。
- ASN 彈出「已經登入」、震動、頭像。
- 90 天排程仍在（`select jobname, schedule from cron.job`）。
- 舊後台訊息數不再增加（沒有人還在寫舊後台）。

## 四、回退方法

切換期間舊後台資料原封不動，回退只是把用戶端改回去：

1. 各用戶端**移除或改回** `IRORI_RELAY_URL`（沒設＝程式內預設值，即舊後台），anon 金鑰換回舊專案的，重啟橋／ASN／雲端代理／Irori。
   **雲端代理（Grok Bot 等平台）**：若曾在平台環境變數設了指向新後台的 `IRORI_RELAY_URL`／`IRORI_RELAY_ANON_KEY`，回退時必須**一併刪除或改回舊值**，否則舊目錄裡的程式仍會讀到新網址。換完秘密後要**開新 shell 或重跑 boot／`start.sh`**（長期跑著的 boot 迴圈不會繼承新環境變數）。
2. 節點金鑰兩邊相同，不必重發。
3. **切換後在新後台產生的訊息不會自動回到舊後台**。回退前若新後台已有重要新訊息，用同一支腳本反向匯出（對調 `OLD`／`NEW`，只匯 `messages`、`room_messages` 的差異），或請寄件人重寄。
4. 回退後，新後台留著，下次再做一次完整同步再切。

## 五、已知風險

- 增量同步期間寄出的信可能落在舊後台、被新後台的整批覆蓋清掉：務必先停橋、停 ASN 再同步。
- 舊後台的訊息 90 天排程仍在；若切換拖得很久，舊資料會被刪，同步前先核對筆數。
- 任一節點忘了換 anon 金鑰：只是變慢，不會掉信。
- 任一節點忘了切換：它的信會留在舊後台，新後台的人收不到；切換後用舊後台的最新 `last_seen_at` 檢查有沒有漏網。
