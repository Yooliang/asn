# 語音：念出回覆與語音輸入

ASN 電腦版有兩項語音功能，都是 ASN 自己的一份，不與 Irori 共用 Worker、秘密或後台函式：

| 功能 | 做什麼 | 聲音／文字去哪 |
|---|---|---|
| 念出訊息 | 對話裡對方（AI）的每則訊息旁有喇叭鈕，按下去念出來；設定頁可開「收到新訊息自動念」（預設關）、選聲音 | **那則訊息的文字**經收發室後台送到 Cloudflare Worker，再送到微軟 Edge 的線上語音合成；回來的是 MP3 |
| 語音輸入 | 輸入框旁的麥克風鈕，按一下開始說、再按一下結束；辨識結果填進輸入框，**讓你確認後自己按傳送，不會自動送出** | **錄音不離開這台電腦**：在本機用 whisper.cpp 辨識 |

兩項功能的金鑰與網路都在 Rust 端（前端拿不到節點金鑰，也不直接連任何網址），守門測試 `relay/asn/test/voice-ui.test.mjs` 會檢查前端語音程式碼不含金鑰字樣、不呼叫 `fetch`。

## 一、念出訊息（TTS）

### 架構

```
ASN 前端 ──tts_speak(文字)──▶ Rust（reqwest，帶節點金鑰）
   ▲                              │ POST ?action=tts
   │ base64 的 MP3                ▼
   └──────────────  Supabase Edge Function `relay`（驗節點金鑰、限長度、限頻率）
                                  │ POST + x-asn-tts-secret
                                  ▼
                       Cloudflare Worker `asn-edge-tts`（cloudflare/edge-tts/）
                                  │ WebSocket
                                  ▼
                       微軟 Edge 線上語音合成（非公開介面）
```

為什麼要經過 Cloudflare Worker：Supabase Edge Function 從雲端 IP 連微軟 Edge 語音的 WebSocket 會被擋（403），Worker 的出口連得上。Worker 的程式源自 Irori 專案，ASN 這邊複製一份後改名（Worker 名 `asn-edge-tts`、秘密 `ASN_TTS_SECRET`、標頭 `x-asn-tts-secret`）。

### 後台動作（`relay` 函式，程式在 `supabase/functions/_shared/tts.ts`）

- `GET ?action=tts_voices`：回 `{ enabled, default, voices: [{ id, label }] }`。`enabled` 是兩個秘密變數都設了才為真。不耗合成額度。
- `POST ?action=tts`，body `{ text, voice?, rate?, pitch? }`：
  - 一定要節點金鑰（`x-relay-key`）；節點代號只取自金鑰，body 不能指定。
  - 文字去掉控制字元後 1～1000 字；聲音只收白名單（見下）；`rate`、`pitch` 整數、絕對值 ≤ 50。
  - 頻率限制：每個節點每分鐘 12 次、每小時 120 次（超過回 429 `rate_limited`）。**限制記在函式實例的記憶體裡**，實例被回收就歸零、不跨實例，只擋得住失控的迴圈；要嚴格計次得另開資料表（需要 migration，這一期沒做）。真正的花費上限靠 Cloudflare 與微軟那端。
  - 成功回 `audio/mpeg`；沒設秘密變數回 503 `tts_disabled`（此時不會呼叫任何外部服務）；Worker 出錯、逾時、回空檔一律回 502 `tts_failed`，回應與 log 都不含秘密與 Worker 內文。
- 預設聲音 `zh-TW-HsiaoChenNeural`。白名單：`zh-TW-HsiaoChenNeural`（曉臻）、`zh-TW-HsiaoYuNeural`（曉雨）、`zh-TW-YunJheNeural`（雲哲）、`zh-CN-XiaoxiaoNeural`（曉曉）、`zh-CN-XiaoyiNeural`（曉伊）、`en-US-AriaNeural`。前四個中文聲音沿用 Irori `state.ts` 的清單（曉雨、曉臻、曉伊、曉曉），多加雲哲與一個英文聲音；要增減改 `TTS_VOICES`。夾在句中的日文假名由 Worker 自動換日文聲音。

### 前端

- 每則「對方」的訊息旁有喇叭鈕（再按一次＝停止）；同一時間只播一則。念之前會先整理文字：拿掉程式碼區塊、網址、舊式表情代碼與排版符號，超過 900 字在句子邊界截斷。
- 設定頁「語音」區：聲音、收到新訊息自動念（預設關；忙碌狀態不念；只念對方的新訊息，震動與登入提示不念；自動念排隊最多 3 則）。
- 設定存在資料夾的 `voice.json`（`%APPDATA%\tw.irori.asn\voice.json`），由 Rust 端讀寫並驗證；對話視窗與名單視窗讀同一份。
- 後台沒啟用時，設定頁會顯示「念出訊息要由維護者在後台啟用」，按喇叭鈕會得到白話提示，不會壞掉。

### 部署（維護者做；程式不會自己部署）

需要：Cloudflare 帳號、Supabase 專案 `asn` 的管理權限。**以下每一步都是對外有影響的動作，先取得維護者同意。**

1. **部署 Worker**

   ```
   cd cloudflare/edge-tts
   npx wrangler login
   npx wrangler secret put ASN_TTS_SECRET     # 貼上自己產的長隨機字串（例如 openssl rand -base64 48），不要進 repo、不要貼在聊天
   npx wrangler deploy
   ```

   記下 Worker 網址 `https://asn-edge-tts.<子網域>.workers.dev`（Worker 路徑是 `/tts`）。

2. **在 Supabase 設兩個 Edge Function 秘密**（同一個專案 `asn`）：

   ```
   npx supabase secrets set ASN_EDGE_TTS_URL=https://asn-edge-tts.<子網域>.workers.dev/tts --project-ref etccgmkrosbzpltudlgt
   npx supabase secrets set ASN_EDGE_TTS_SECRET=<與上一步 ASN_TTS_SECRET 同一組> --project-ref etccgmkrosbzpltudlgt
   ```

3. **部署 `relay` 函式**（讓新的 `tts`、`tts_voices` 動作上線）：

   ```
   npx supabase functions deploy relay --project-ref etccgmkrosbzpltudlgt
   ```

   不需要套用任何 migration（這一期沒有資料庫變更）。

4. **驗證**：
   - 不帶金鑰呼叫 `?action=tts_voices` 應回 401。
   - 用任何節點金鑰呼叫 `?action=tts_voices`，`enabled` 應為 `true`。
   - 開 ASN，對話裡按對方訊息旁的喇叭鈕，應聽到聲音。
   - 停用：把兩個秘密刪掉（`npx supabase secrets unset ASN_EDGE_TTS_URL ASN_EDGE_TTS_SECRET`），`tts_voices` 變 `enabled:false`，`tts` 回 503。

Worker 的本機測試與維護（微軟改版導致 403 時怎麼更新）見 [cloudflare/edge-tts/README.md](../cloudflare/edge-tts/README.md)。

### 授權與風險（重要）

- Edge TTS 走的是微軟 Edge「大聲朗讀」的**非公開介面**，不是微軟對外販售的語音服務，沒有服務條款保證，隨時可能被改掉或擋掉；Worker 內的 `TRUSTED_CLIENT_TOKEN` 是微軟客戶端的公開常數，所有 edge-tts 實作都內建。
- 依 Irori 開源前整理的結論（`docs/OPEN-SOURCE.md` 第 9 點）：**開源版不預設啟用**，並標明「**僅個人用**」。ASN 的做法是：不設秘密變數就整個功能關閉；啟用與否由各部署者自己決定並自負其責；官方託管版若要給多人使用，應先換成有授權的服務（見後續選項）。

## 二、語音輸入

### 評估（三個方案）

| 方案 | 能不能用 | 結論 |
|---|---|---|
| WebView2 的網頁語音辨識（`webkitSpeechRecognition`） | 在 Chromium 內是呼叫 Google 的雲端服務，需要 Google 的 API 金鑰；Edge 版 WebView2 沒有內建這個服務，在 Tauri 裡通常直接失敗（`network` 或 `service-not-allowed`）。聲音也會送到雲端 | 不可靠、也不符合「聲音不離開電腦」，不採用 |
| Windows 內建聽寫（Win+H／WinRT `SpeechRecognizer`） | Win+H 是系統介面，程式無法驅動；WinRT 的線上辨識要使用者在「設定 > 隱私權 > 語音」開啟線上語音辨識，聲音送微軟雲端，並依系統語言包；不同電腦行為不一，自動測試困難 | 不採用，列為備案 |
| 本機 whisper.cpp | 可離線、準確度夠、可在 CI 上用合成語音測；代價是要下載引擎與模型 | **採用** |

採用本機 whisper.cpp 的實作方式：**前端錄音，Rust 呼叫官方預編譯的 `whisper-cli.exe` 辨識**。

沒有用 `whisper-rs`（把 whisper.cpp 編進程式）的原因：它要在每個開發者與 CI 的機器上編 C++，需要 cmake 與 libclang，這一期的開發機都沒有，也會讓一般人 `npm start` 的門檻變高。外部執行檔的介面（Rust 指令 `stt_status`、`stt_install`、`stt_transcribe`）之後可以直接換成內嵌，前端不用改。

### 流程

```
麥克風（getUserMedia + WebAudio，WebView2）
   │ 按麥克風開始；再按一次結束，多錄 0.28 秒尾巴
   ▼
前端 voice-input.mjs
   ├─ 整段太短（< 0.3 秒）或幾乎無聲（峰值 < 0.008）→ 不送，提示「沒聽到聲音」
   ├─ 人聲偵測（20 毫秒一格的 RMS，門檻同 Irori）：沒人聲不送
   ├─ 修掉頭尾的長段安靜（人聲前後各留 0.25 秒，至少留 1.2 秒）
   └─ 降到 16 kHz 單聲道、封成 WAV（≤ 60 秒）
   ▼ stt_transcribe(wav 的 base64)
Rust stt.rs：驗 WAV 規格 → 寫暫存檔 → whisper-cli.exe（無視窗、逾時 60 秒，逾時或取消時只結束自己啟動的那一個子程序）→ 讀文字 → 刪暫存檔
   ▼
前端 stt-text.mjs：去雜訊標記 → 整句是靜音幻覺字就丟掉 → 簡轉繁 → 中文間空白、全形標點
   ▼
填進輸入框（接在原有文字後面），人確認後自己按傳送
```

Irori 移植過來的部分（各有測試，位置 `relay/asn/test/`）：

- 幻覺字過濾 `ui/lib/stt-text.mjs`：整句都是「字幕製作:貝爾」「謝謝觀看」「請不吝點贊訂閱」「Amara.org 社群提供的字幕」這類片尾才丟掉；句子裡只是提到（「字幕太小了」「我在做字幕製作的工作」）不丟。測試 `stt-text.test.mjs` 是 Irori 的 15 句應丟、11 句應留的案例。
- 簡轉繁表 `ui/lib/s2t-table.mjs`：OpenCC STCharacters（Apache-2.0）的一對一字表，2571 字，與 Irori 同一份。
- 人聲偵測與頭尾修剪 `ui/lib/voice-activity.mjs`：門檻與測試案例同 Irori `VoiceActivity`。

### 首次使用與下載

引擎與模型都**不進 git**，第一次按麥克風時，輸入框上方會出現「下載」提示（設定頁「語音」區也有按鈕），使用者按了才下載，存在 `%APPDATA%\tw.irori.asn\stt\`：

| 項目 | 來源 | 大小 | 驗證 |
|---|---|---|---|
| 辨識引擎 | whisper.cpp 官方 release `b5454` 的 `whisper-bin-x64.zip` | 約 8.9 MB | SHA-256 寫死在 `stt.rs`（`6ba69e34…`），不符就丟掉；只解出 `Release/` 底下的 `whisper-cli.exe` 與 `.dll`，其餘與路徑穿越一律略過 |
| 模型（預設「較準」） | Hugging Face `ggerganov/whisper.cpp` 的 `ggml-small-q5_1.bin` | 約 190 MB | SHA-256 寫死，邊下載邊算，不符就刪掉 |
| 模型（「較快」） | 同上 `ggml-base-q5_1.bin` | 約 60 MB | 同上 |

設定頁可選語音輸入的語言（中文、自動判斷、英文）與模型。中文會帶「以下是繁體中文的句子」的提示讓辨識偏繁體。升級引擎版本：改 `stt.rs` 的 `ENGINE_TAG`、`ENGINE_URL`、`ENGINE_SHA256`、`ENGINE_BYTES`（資料夾名含版本號，會自動重新下載）。

### 需要真機驗證（本期沒能在沙盒內測的）

自動測試涵蓋了：辨識流程（假麥克風）、幻覺過濾、WAV 規格、下載與校驗、zip 解壓縮、Rust 端參數。沒涵蓋、需要有麥克風的真實 Windows 桌面確認的：

1. WebView2 的麥克風授權：第一次按麥克風是否跳出授權、核准後能否錄到音（若 `getUserMedia` 被擋，錯誤訊息會指引到 Windows 隱私權設定）。
2. 兩種視窗（分離模式的對話視窗、整合模式的分頁）都能錄音、辨識、填字。
3. 按住麥克風期間、播放 TTS 的同時，聲音互相干擾的程度（目前沒做回音處理，只開了瀏覽器的回音消除）。
4. 停得下來：錄音中再按麥克風一定會結束並辨識；準備中、辨識中按麥克風（或按 Esc）會取消，字不會出現；辨識中按鈕不是灰的，旁邊有「聆聽中／辨識中…按一下取消」的文字。取消後馬上再錄一段能正常辨識（不會出現「上一段還在辨識中」）。

實測過的部分：用 Windows 內建合成語音產一段英文，走前端同一套修頭尾／16 kHz WAV 流程，再用真的 `whisper-cli.exe`（`b5454`＋`base` 模型，Rust 端同樣的參數）辨識，約 2.3 秒得到正確文字。

## 三、隱私說明

| 資料 | 離開本機嗎 | 去哪 |
|---|---|---|
| 語音輸入的錄音 | **不離開** | 只在本機交給 `whisper-cli.exe`，暫存 WAV 辨識完就刪 |
| 語音輸入的辨識文字 | 不自動送出 | 填進輸入框，使用者確認後按傳送才進入一般的寄信流程 |
| 下載辨識引擎／模型 | 是（只有下載請求） | GitHub 與 Hugging Face 看得到下載請求的 IP，看不到錄音 |
| 念出訊息的文字（僅在使用者按喇叭鈕或開自動念，且後台已啟用） | 是 | 收發室後台（Supabase 東京）→ Cloudflare Worker → 微軟 Edge 語音合成。本服務不保存這段文字；Cloudflare 與微軟如何處理由其各自政策決定 |
| 念出訊息的聲音 | 是（回傳） | MP3 只在記憶體與播放用的暫時網址，不寫檔 |

官網隱私權政策（`site/public/privacy.html`）已補上念出訊息與語音輸入的說明（未部署，需維護者隨官網一起部署）。

## 四、測試

```
cd relay/asn && npm ci && npm test           # 前端語音邏輯、與原有測試
cd relay/asn && npm run test:rust            # stt／tts／voicecfg 的 Rust 測試（假 HTTP 伺服器只連 127.0.0.1）
cd supabase/functions && deno test -A _shared/   # tts_test.ts：請求檢查、限頻、Worker 失敗處理
node --test tests/edge_tts_drm.test.mjs      # Worker 的 Sec-MS-GEC 簽章對 Python edge-tts 的標準答案
```

所有測試只連 `127.0.0.1` 的假服務，不碰真實後端、Cloudflare、微軟、GitHub、Hugging Face。

## 五、後續選項

- **有授權的 TTS**：ElevenLabs、Gemini TTS（Irori 的 `tts.ts` 已有實作可參考：`eleven:` 與 `gemini:` 聲音前綴、情緒風格、PCM 轉 WAV 與淡入淡出）。要給多人使用時，應優先換成這類有授權的服務；只需在 `_shared/tts.ts` 加一個提供者，前端不用改。
- **嚴格的頻率與用量計次**：新增資料表記錄每個節點的用量（需要 migration），取代目前記憶體內的限制。
- **內嵌辨識**：把 whisper.cpp 編進程式（`whisper-rs`），免下載引擎；要先備好 cmake／libclang 的建置環境與 CI。GPU 加速（whisper.cpp 的 CUDA／Vulkan 版）。
- **按住說話、串流辨識、說話時打斷 TTS**（Irori 有「開口就打斷」的做法，見 `Interrupter`）。
- **Windows 內建辨識**當作沒有下載模型時的備案。
- **對話自動朗讀的細節**：只念指定好友、長訊息只念摘要。

## 三、偽通話（#99）

對話上方「通話」鈕：麥克風一直開著，說完一句自動辨識並寄出，回信自動念出。設計見 `docs/design/PSEUDO-CALL.md`。
