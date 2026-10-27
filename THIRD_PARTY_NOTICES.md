# 第三方元件與授權

ASN 自己的程式碼採用的授權寫在根目錄的 `LICENSE`（由專案負責人決定，見 #326）。下列元件來自第三方，各自沿用原本的授權。

| 元件 | 用在哪裡 | 授權 | 說明 |
|---|---|---|---|
| [edge-tts](https://github.com/rany2/edge-tts) 7.3.1 的 `drm.py` | `cloudflare/edge-tts/drm.js` | **LGPL-3.0** | 逐行移植成 JavaScript。這個檔案（以及由它衍生的修改）照 LGPL-3.0 授權，不受 ASN 主授權影響。edge-tts 除了 `srt_composer.py`（MIT）以外，其餘檔案都是 LGPLv3。 |
| [LobeHub Icons](https://github.com/lobehub/lobe-icons)（`@lobehub/icons-static-svg` 1.95.1） | `relay/asn/ui/lib/vendor-icons.mjs` 裡的 claude、openai、gemini、grok、deepseek、minimax 圖示 | MIT | 詳見 `docs/ASN-VENDOR-ICONS.md`。pi、acp、aegis、other 的圖示是自己畫的。 |
| [DiceBear](https://www.dicebear.com/) `@dicebear/core`、`@dicebear/shapes` 9.4.2 | 自動產生的大頭貼（建置時打包成 `ui/vendor/dicebear.mjs`，不放進倉庫） | 程式碼 MIT；Shapes 風格 CC0 1.0 | 「Shapes by DiceBear, licensed under CC0 1.0」。 |
| [WezTerm](https://github.com/wez/wezterm) 20240203 | 隨電腦版安裝檔附帶（建置時放進 `src-tauri/resources/wezterm/`，不放進倉庫） | MIT | 安裝檔裡附上原授權文字 `LICENSE.md` 和來源說明 `SOURCE.txt`。 |
| [Vue](https://vuejs.org/) | 介面框架（建置時打包成 `ui/vendor/`） | MIT | |

**從 Irori 移植的程式**（`relay/asn/ui/lib/stt-text.mjs`、`voice-activity.mjs` 等）：Irori 是同一位作者的專案，跟 ASN 用同一個授權，不另外列出。

**Edge TTS 代理**（`cloudflare/edge-tts/`）呼叫的是微軟 Edge「大聲朗讀」的非公開介面，見該資料夾的 README。開源版預設不啟用。
