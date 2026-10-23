# ASN 廠商分頁圖示

名單「分頁依廠商」時，左側頁籤改用小圖示（滑過仍顯示全名）。

## 來源與授權

- 圖示為 **ASN 自繪簡化標誌**（`relay/asn/ui/lib/vendor-icons.mjs` 內嵌 SVG），刻意不做官方商標的像素級複製。
- 設計時參考公開品牌色系與 [Simple Icons](https://simpleicons.org/)（**CC0 1.0**）的構圖概念；**本 repo 未直接嵌入 Simple Icons 的 SVG 路徑**。
- 若日後改為直接引用 Simple Icons，請在此列出各 slug 與 CC0 聲明。

## 深／淺色

- 線條與中性形狀使用 `currentColor`，隨 ASN 主題前景色變化。
- 少量識別色（例如 Gemini 藍綠、Claude 橘）保留固定 hex，在深淺背景下仍辨識。

## 2026-10-21 更新：改用官方標誌

小良哥回報 Claude、Grok 圖示不對（原本是自繪的近似圖形）。claude、openai（codex、gpt）、gemini、grok、deepseek、minimax（10-24 加入）改用
[LobeHub Icons](https://github.com/lobehub/lobe-icons) 的 `@lobehub/icons-static-svg` 1.95.1（MIT 授權）原始 SVG，
只拿掉 `<title>`、`style`、尺寸屬性並加上 `aria-hidden`；pi、acp、other 仍為自繪。各標誌的商標權屬各公司，僅用於標示廠商。
