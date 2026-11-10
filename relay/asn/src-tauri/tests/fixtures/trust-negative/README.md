# trust-negative：不是「信任此資料夾」的畫面

守 #884：剛開、還沒有輸出的夥伴，不能被判成卡在信任框（status_code 不能是 trust）。
這裡放的都是**反例**：長得有點像、但不該判成 TrustFolder 的畫面。

- 內容是依真實畫面格式手寫的合成樣本，路徑、使用者名已用 `<user>`、`<scratch>` 替代。
- 為什麼不放進 `../term-screens/`：那個資料夾有黃金檔守門（`tests/golden/term/*.json`），
  放進去就要重產黃金檔。這裡獨立一個資料夾，不被黃金檔掃到。
- 讀法：`claude_screen.rs` 與 `term.rs` 的測試用
  `include_str!("../../tests/fixtures/trust-negative/<名>.txt")`。

| 檔案 | 內容 |
|---|---|
| claude-blank | 剛開、全空白 |
| claude-welcome-empty-input | Welcome 橫幅框、cwd、空輸入框、提示行 |
| claude-input-has-text | 版本標題、輸入框已有字 |
| claude-safety-check-one-option | 有 Quick safety check，只有一個選項 |
| claude-safety-check-three-options | 有 Quick safety check，三個選項 |
| claude-trust-options-no-title | 兩個信任選項但沒有 Quick safety check |
| claude-trust-options-quoted-in-reply | 模型回覆引用兩個選項文字，底下是輸入框 |
| pi-blank | pi 剛開、空白 |
| pi-welcome | pi 歡迎畫面、空輸入框 |
