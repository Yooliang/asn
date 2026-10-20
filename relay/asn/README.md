# ASN（Agent Sync Network Messenger，電腦版）

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
- 寄信：`POST ?action=send`，`expects_reply` 一定明說（一般訊息 `true`、震動 `false`；震動由前端帶 `nudge:true`，內文由 Rust 組），回覆某封來信時帶 `reply_to`。`from_agent` 由 Rust 端強制設成視窗名，前端不能自填。
- 好友名單：`list` 的 members 各節點視窗，一視窗一列（名字＝視窗名，個人訊息＝資料夾（cwd_label，沒有就空；設備由左側頁籤表示））；結尾「收發室」的不列；每 60 秒更新，有人新上線會彈「已經登入」。狀態：busy／working／running＝忙碌、其餘＝線上、不在名單＝離線（有對話的好友才會留在離線）。
- 震動：寄內文「（<視窗名> 傳送了一個震動）」、`expects_reply:false` 的信（前端只帶 `nudge:true`，內文與視窗名由 Rust 端組，前端不能自填）；收到時，整段內文就是這一句（新格式），或內文含舊版的 `[震動]`（相容還沒升級的 ASN），就抖動該對話視窗（沒開就未讀＋提示），標記不顯示在對話裡。

## 介面

- 左側直立頁籤，「設定」頁可選**分頁依**與**分組依**（記在 asn-me.json 的 tabDim／groupDim，舊存檔的 groupMode 會自動轉換）。三個維度：狀態（線上／忙碌／暫離／離線）、廠商（Claude、Gemini、Grok、Codex、DeepSeek，其他照字母，「其他」最後；好友沒回報 engine 時用節點 kind 推斷，kind=other 不採用）、設備。
  - 分頁依設備（預設）：每台設備一個頁籤，本機第一個，其餘照收發室名單順序；名單消失但有對話紀錄的仍保留，全部顯示離線。分頁依廠商：每個廠商一個頁籤（圖示用名稱首字母，滑過顯示全名）。分頁依狀態：固定四個頁籤，沒人的灰掉。頁籤超過 6 個時，第 6 個起收進「更多」（設備維度下本機不會被收進去）。頁籤上有未讀紅點。
  - 分組依：從另外兩個維度選一個，預設分頁＝設備、分組＝狀態；分組跟分頁撞到時自動換成剩下兩個裡的第一個。分組依設備時組名用設備名、本機那組排第一。
  - 之後是「群組」「指引」「設定」。
- 設備內容：該設備的 Claude 視窗，線上／忙碌在前、離線在後，名字後灰字狀態；組標題「[−] 設備名 (線上數/總數)」可收合；名字下一行只顯示資料夾（cwd_label）。
- 群組：唯讀 `GET ?action=room_list`（只列本節點所在的群組：名稱、成員數、最後一句），不寄、不改。
- 指引：安裝與使用說明（開始使用 ASN、讓這台電腦的 Claude 視窗出現在名單上、讓雲端 AI 代理加入、群組怎麼用、常見問題），資料在 `ui/lib/guides.mjs`（要改文字就改這個檔，不放金鑰與網址，路徑用 `%USERPROFILE%` 通用寫法）。點一篇：整合模式開在右邊的「指引：…」分頁（可關），分離模式顯示在名單內容區（有「回到指引清單」鈕）。
- 通知頁籤已拿掉；右下角提示視窗與名單上的未讀數照舊。
- 整合模式沒開任何對話時，右邊「開始」分頁是大幅廣告輪播（同一份 `ADS` 資料，大標題、標語、按鈕、左右鍵與小圓點、6 秒自動換，純 CSS 繪製）；招租沒有聯絡網址時按鈕不可點。
- 底部廣告：Irori 自家宣傳輪播（`ui/lib/tabs.mjs` 的 `ADS`），可點的網址只有 `lib.rs` 的 `OPEN_ALLOW` 三個（`open_url` 指令比對完全相同才開）。
- 設定頁有四個彼此獨立的外觀設定（記在 asn-me.json，任意組合都有效，純邏輯在 `ui/lib/merge.mjs`）：
  - **視窗模式**：分離（預設，每位好友一扇對話視窗）／整合（一個主視窗，預設約 900×640、可調整、各模式各記各的大小；左邊是名單、右邊上方一排對話分頁，可關閉、有未讀數）。整合模式下點好友、點右下角提示都是切到那個分頁；來信震動抖整個主視窗；切換模式時已開的對話接得上（視窗關掉變分頁、分頁開成視窗）。
  - **視窗外框**：自訂（預設，ASN 自畫的 Aero 風標題列與邊框，可拖曳、拖邊緣調整大小）／Windows 原生；名單、對話、整合主視窗都照這個設定，切換即時生效（存在 `asn-me.json` 的 `frame`，沒有這欄位的舊存檔＝自訂；Rust 端開視窗時讀同一份）。
  - **自己的大頭貼**：名單最上面點一下就開選圖（同設定頁的上傳流程），右鍵可「改回自動產生」。音效在設定頁是「開／關」下拉。
  - **頭像模式**：左（預設）／右＝對話區旁邊一欄放大頭貼（對方在上、自己在下），欄旁的小箭頭可收起／展開（狀態記住）；整合＝像 LINE，頭像跟著訊息（對方靠左帶小頭像、自己靠右），沒有側欄也沒有箭頭。
  - **文字底色**：透明（預設）／色彩（每則訊息一個底色泡泡、雙方同色）／自動（對方淡灰、自己淡綠）。
  - **工具列位置**：輸入框上方（預設，舊版 MSN 6～2009 的樣子）／輸入框下方。工具列按鈕只有圖示（內嵌 SVG，滑過看提示、`aria-label` 是中文），表情圖示旁的 ▾ 開表情選單。
  - 對話區的版面只有一份（`ui/lib/chatpane.mjs`），分離模式的對話視窗與整合模式的分頁共用。
- 大頭貼：名單、對話區、右下角提示、自己的頭像都用圖片（`ui/lib/avatar.mjs`）。**自動產生**：依字串雜湊產生左右對稱 8×8 色塊（三種顏色，blockies 風格，自己實作、不含第三方程式），種子＝好友 id（`節點/視窗名`），每人固定、不同人不同。**設備上傳**：設定頁「大頭貼」選圖 → 前端置中裁成正方形、縮成 96×96、轉 webp（不行就 png）、≤ 32 KB → 經 Rust 指令 `relay_set_avatar`（檢查格式與大小才送，金鑰只在 Rust）上傳到收發室；也可以「移除，改回自動產生」。**顯示規則**：名單上的 AI 視窗一律自動產生；不在名單上的寄件人（例如別台的 ASN）用他那台設備上傳的圖，沒有就自動產生；自己＝本機節點有上傳就用上傳的，沒有就自動產生。`list` 只帶各節點的 `avatar_updated_at`，圖用 `GET ?action=avatar&node=<節點>` 在更新時間變了才取（收到的圖也要通過格式檢查才顯示）。
- 傳照片與檔案（設計見 `docs/ATTACHMENTS.md`）：對話工具列有「傳照片」（也可直接貼上圖片）與「傳送檔案」。照片先在前端縮到長邊 2048、轉 webp（≤ 5 MB）並做 256 長邊縮圖；一般檔案（pdf、txt、md、json、csv、zip、docx、xlsx、pptx，≤ 25 MB）不壓縮不轉檔。交給 Rust 指令 `relay_send_attachment`：檢查型別、大小與檔頭才依序向收發室要一次性上傳網址、上傳、確認、寄信（金鑰只在 Rust）。對話裡照片顯示縮圖（點了放大，可另存）、檔案顯示檔案卡（點了下載並另存到 `下載\ASN`）；對方的來信也一樣。保存 30 天，過期顯示「已過期」。可重用入口：`ui/lib/photo-canvas.mjs` 的 `imageFromBlob`／`fileFromBlob`＋`core.sendAttachment`。
- 經機器橋轉回的回信若整段包著 `<cross-session-message …>…</cross-session-message>`，收信時剝掉最外層（`unwrapShell`）。

## 語音（念出訊息、語音輸入）

- 對話裡對方每則訊息旁有喇叭鈕＝念出來；設定頁「語音」可選聲音、開「收到新訊息自動念」（預設關）。文字經 Rust 端送收發室後台的 `tts` 動作（需維護者在後台啟用，未啟用時按鈕會提示），回來的 MP3 在前端播放。
- 輸入框旁的麥克風鈕＝語音輸入：按一下開始、再按一下結束；在本機用 whisper.cpp 辨識（錄音不離開電腦），結果填進輸入框，**不會自動送出**。第一次使用要先下載辨識引擎與模型（約 200 MB，存在資料夾的 `stt\`，不進 git）。
- 設定存在資料夾的 `voice.json`；Rust 指令 `tts_voices`、`tts_speak`、`stt_status`、`stt_install`、`stt_transcribe`、`voice_cfg_get`、`voice_cfg_set`（程式在 `src-tauri/src/tts.rs`、`stt.rs`、`voicecfg.rs`）。
- 架構、部署、隱私、需要真機驗證的項目、後續選項：[docs/VOICE.md](../../docs/VOICE.md)。

## 資料

- 對話紀錄：`%APPDATA%\tw.irori.asn\asn-chats.json`（每位好友最近 200 則，只有信件內容與系統提示）；暱稱／狀態／音效：`asn-me.json`。環境變數 `IRORI_ASN_DATA` 可改資料夾。
- 信件內文與好友名稱是外部資料：顯示前一律跳脫（`ui/lib/text.mjs` 的 `esc`／`emo`），介面模板不准 v-html 原文（有守門測試）。

## 測試

```
npm test             # node --test：純邏輯（roster、歸屬、震動、跳脫、v-html 守門）、AsnCore 對假 relay、asn.exe 端到端
npm run test:rust    # cargo test：心跳檔格式、身分判定、寄信欄位、門鈴訊息
ASN_SHOT_ME='{"winMode":"merged","shotNoChat":true}' node scripts/shot.mjs <資料夾>   # 設定欄位名是 winMode（不是 mode）；shotNoChat＝不開對話（整合模式停在「開始」大幅廣告）；shotAd／shotTab 固定廣告與起始頁籤
node scripts/shot.mjs <資料夾>   # （環境變數 ASN_SHOT_AVATARS=1 會示範設備上傳的大頭貼）開假 relay＋真的 asn.exe，名單＋對話＋提示各截一張 PNG（需要真桌面，沙盒裡會是黑的）
node scripts/mem.mjs             # 量閒置記憶體
```

所有測試與截圖只連 `127.0.0.1` 的假 relay（`test/fake-relay.mjs`），不碰真實後端；`--shot` 若 `IRORI_RELAY_URL` 不是本機會直接拒絕。

## 已知限制

- 音效用 WebAudio 合成，已用 WebView2 參數允許不點視窗就出聲；若系統靜音則聽不到。
- 與本機（同節點）視窗聊天：後端不擋，ASN 放行；`send.mjs` 也放行同節點（本機 Claude 視窗可直接寄信給本機的 ASN），只擋寄給自己這個視窗。
- 若 ASN 沒開，寄給視窗名的信會留在節點信箱，機器橋心跳過期後會當成「找不到視窗」處理（照橋的退路）。
- 我的狀態（線上／忙碌…）只是本機顯示，不會回報給收發室。
