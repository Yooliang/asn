# asn-edge-tts

ASN 用的 Edge TTS 代理（Cloudflare Worker）。Supabase Edge Function 連不上微軟 Edge TTS 的 WebSocket（403），Workers 出口連得上，所以由 ASN 後台的 `relay` 函式（動作 `tts`）轉呼叫這裡。程式源自 Irori 專案的同名代理，在 ASN 這邊自己維護一份，不與 Irori 共用 Worker、秘密與網址。

> **僅個人用。** 這支代理使用的是微軟 Edge「大聲朗讀」的非公開介面（內建的 `TRUSTED_CLIENT_TOKEN` 是微軟客戶端的公開常數），不是微軟對外販售的語音服務，沒有服務條款保證，隨時可能被微軟改掉或擋掉。開源版**預設不啟用**：沒設秘密變數，後台就不會呼叫它。要用請自己部署一份、自己承擔風險；要商用或給多人用，請改接有授權的服務（見 `docs/VOICE.md` 的後續選項）。

## API

`POST /tts`，標頭 `x-asn-tts-secret: <ASN_TTS_SECRET>`，body JSON：

| 欄位 | 說明 |
|---|---|
| text | 必填，最多 2000 字 |
| voice | 預設 `zh-TW-HsiaoYuNeural`，須為 `xx-XX-NameNeural` 格式 |
| rate | 整數，單位 %（預設 0），同 edge-tts 套件的 `f"{rate:+d}%"` |
| pitch | 整數，單位 Hz（預設 0），同 `f"{pitch:+d}Hz"`；日文假名片段只套一半 |

回 `audio/mpeg`。密鑰錯／缺 401；格式錯 422；過長 413；微軟那端失敗 502。不開 CORS（只給後端呼叫）。

夾在句中的日文假名改用 `ja-JP-NanamiNeural`，其他用指定聲音，MP3 直接串接。文字依 edge-tts 規則跳脫 XML 並以 4096 位元組切段，每段一條 WebSocket（單次請求最多 12 段）。

## 部署（維護者做，需要 Cloudflare 帳號）

```
cd cloudflare/edge-tts
npx wrangler login
npx wrangler secret put ASN_TTS_SECRET     # 自己產一組長隨機字串，不要進 repo
npx wrangler deploy
```

然後在 Supabase 專案 `asn` 設兩個 Edge Function 秘密：`ASN_EDGE_TTS_URL`（例如 `https://asn-edge-tts.<子網域>.workers.dev/tts`）與 `ASN_EDGE_TTS_SECRET`（同上那組）。完整步驟見 [docs/VOICE.md](../../docs/VOICE.md)。

## 本機測試

`.dev.vars` 寫 `ASN_TTS_SECRET=test`（只放本機，別 commit），`npx wrangler dev`，再：

```
curl -X POST localhost:8787/tts -H "x-asn-tts-secret: test" -H "content-type: application/json" -d '{"text":"你好","rate":5,"pitch":15}' -o a.mp3
```

守門測試（不連網）：在 repo 根目錄 `node --test tests/edge_tts_drm.test.mjs`。

## 維護

檔頭「同步區」的常數（Chromium 版本、Sec-MS-GEC-Version、Origin、標頭）要跟 Python `edge-tts` 套件的 `constants.py` 同步；`Sec-MS-GEC` token 演算法在 `drm.js`，逐行對應套件的 `drm.py`（目前對到 7.3.1 的 v2 token）。微軟改版導致 403 時：

1. 升級套件，比對 `constants.py` 與 `drm.py`。
2. 用新版套件的 `generate_sec_ms_gec_v2(ts)` 重產 `tests/vectors/edge_tts_sec_ms_gec_v2.json`。
3. `node --test tests/edge_tts_drm.test.mjs` 全綠，再 `wrangler dev` 實際合成一句確認拿得到聲音。
