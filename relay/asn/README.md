# ASN 即時通（電腦版）

懷舊風格的 Windows 桌面即時通。好友＝收發室（relay）名單上的 Claude 視窗，聊天＝收發室的信。
Tauri 2（Rust）＋ Vue 3；多視窗：好友名單一扇、每位好友的對話各一扇、右下角提示一扇（置頂、不搶焦點、不進工作列）。

## 安裝與執行

需要：Node 22+、Rust（`winget install --id Rustlang.Rustup -e`，再 `rustup default stable-msvc`）、Visual Studio C++ 建置工具、WebView2（Windows 11 內建）。

```
cd relay/asn
npm install
npm start            # 開發模式（tauri dev）
npm run build        # 出 exe 與安裝檔（src-tauri/target/release/asn.exe、bundle/nsis/ASN_*_x64-setup.exe）
```

關掉好友名單視窗＝結束程式。

## 身分與心跳

- 節點、金鑰、`IRORI_RELAY_URL` 的判定與 `relay/machine/identity.mjs` 相同：`IRORI_RELAY_ID` → `~/.irori-relay/node` → 橋正在跑的 `machine-<ID>` → 唯一有金鑰檔的節點；金鑰讀 `IRORI_RELAY_KEY` 或 `~/.irori-relay/<節點>.key`；`IRORI_RELAY_ANON_KEY` 或 `~/.irori-relay/anon.key` 用來訂 Realtime 門鈴（沒有就只輪詢）。
- **金鑰只存在 Rust 的記憶體**：HTTP（reqwest）與 WebSocket 都在 Rust 端做，前端拿不到金鑰，也不寫 log。
- 暱稱＝視窗名＝對外寄信的 `from_agent`／收信的 agent 名：只有名單最上面那一格，預設 `<節點>-ASN`，直接改就是改對外名字（Rust 端驗證：去頭尾空白、1～40 字、不能結尾是「收發室」、不含控制字元；不合法就還原並提示），存在資料夾的 `settings.json`。介面其他地方不顯示節點代號或視窗名（設備名只在左側頁籤）。
- 改名後舊名繼續收信：`settings.json` 的 `old_names` 記改名前用過的名字（最多 5 個、保留 7 天），每個舊名照樣用 `inbox&agent=<舊名>` 收信（ack 對同一個名字）並各寫一份心跳；過期就停。用 `inbox&agent=<視窗名>` 只收寄給這個名字的信，收到存檔後才 `ack&agent=`。
- 心跳：每 30 秒寫 `~/.irori-relay/machine-<節點>/self-recv/<視窗名>.json`，內容 `{"pid","name","t"}`，格式、路徑、原子寫入都與 `relay/machine/self-recv.mjs` 相同，pid 是本程式。機器橋看到 90 秒內且 pid 活著的心跳，就不再轉交這個視窗的信。結束時清掉自己的心跳。同一個視窗名已有另一個 ASN 在跑就拒絕啟動。
- 寄信：`POST ?action=send`，`expects_reply` 一定明說（一般訊息 `true`、震動 `false`），回覆某封來信時帶 `reply_to`。`from_agent` 由 Rust 端強制設成視窗名，前端不能自填。
- 好友名單：`list` 的 members 各節點視窗，一視窗一列（名字＝視窗名，個人訊息＝資料夾（cwd_label，沒有就空；設備由左側頁籤表示））；結尾「收發室」的不列；每 60 秒更新，有人新上線會彈「已經登入」。狀態：busy／working／running＝忙碌、其餘＝線上、不在名單＝離線（有對話的好友才會留在離線）。
- 震動：寄內文 `[震動]`、`expects_reply:false` 的信；收到內文含 `[震動]` 就在 Rust 端左右抖動該對話視窗（沒開就未讀＋提示）。

## 介面

- 左側直立頁籤：每台設備一個（本機第一個、預設；其餘照收發室名單順序；名單消失但有對話紀錄的仍保留，全部顯示離線）。設備頁籤超過 6 個時，第 6 個起收進「更多」（本機不會被收進去）。頁籤上有未讀紅點。之後是「群組」「通知」「設定」。
- 設備內容：該設備的 Claude 視窗，線上／忙碌在前、離線在後，名字後灰字狀態；組標題「[−] 設備名 (線上數/總數)」可收合；名字下一行只顯示資料夾（cwd_label）。
- 群組：唯讀 `GET ?action=room_list`（只列本節點所在的群組：名稱、成員數、最後一句），不寄、不改。
- 通知：最近 50 筆右下角提示（只在記憶體，關程式就清），點一筆開對話。
- 底部廣告：Irori 自家宣傳輪播（`ui/lib/tabs.mjs` 的 `ADS`），可點的網址只有 `lib.rs` 的 `OPEN_ALLOW` 三個（`open_url` 指令比對完全相同才開）。
- 經機器橋轉回的回信若整段包著 `<cross-session-message …>…</cross-session-message>`，收信時剝掉最外層（`unwrapShell`）。

## 資料

- 對話紀錄：`%APPDATA%\tw.irori.asn\asn-chats.json`（每位好友最近 200 則，只有信件內容與系統提示）；暱稱／狀態／音效：`asn-me.json`。環境變數 `IRORI_ASN_DATA` 可改資料夾。
- 信件內文與好友名稱是外部資料：顯示前一律跳脫（`ui/lib/text.mjs` 的 `esc`／`emo`），介面模板不准 v-html 原文（有守門測試）。

## 測試

```
npm test             # node --test：純邏輯（roster、歸屬、震動、跳脫、v-html 守門）、AsnCore 對假 relay、asn.exe 端到端
npm run test:rust    # cargo test：心跳檔格式、身分判定、寄信欄位、門鈴訊息
node scripts/shot.mjs <資料夾>   # 開假 relay＋真的 asn.exe，名單＋對話＋提示各截一張 PNG（需要真桌面，沙盒裡會是黑的）
node scripts/mem.mjs             # 量閒置記憶體
```

所有測試與截圖只連 `127.0.0.1` 的假 relay（`test/fake-relay.mjs`），不碰真實後端；`--shot` 若 `IRORI_RELAY_URL` 不是本機會直接拒絕。

## 已知限制

- 音效用 WebAudio 合成，已用 WebView2 參數允許不點視窗就出聲；若系統靜音則聽不到。
- 與本機（同節點）視窗聊天：後端不擋，ASN 放行（`send.mjs` 擋同節點是因為 Claude 視窗之間有 SendMessage）。
- 若 ASN 沒開，寄給視窗名的信會留在節點信箱，機器橋心跳過期後會當成「找不到視窗」處理（照橋的退路）。
- 我的狀態（線上／忙碌…）只是本機顯示，不會回報給收發室。
