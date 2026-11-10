# 外來訊息確認框的畫面樣本（#1254）

`claude-held-message.txt`：Claude Code 的「Held message from another session」確認框。
11-10 asn40 在 40家用取樣（Claude Code 2.1.322，wezterm cli get-text，窗格 120×40，取第 14 列起）。

- 選項沒有編號，**游標預設在 Deny**；框出現時輸入列被擠出畫面。
- 已遮掉：pipe 編號、信件 id、信件內容、交接檔路徑、遠端工作階段網址。

放在這裡、不放 `term-screens/`：那個資料夾的每個樣本都要同步更新 `tests/golden/term/*.json`（要建置才能產生），等第二張（畫面）一起搬過去。
