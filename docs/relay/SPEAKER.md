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
