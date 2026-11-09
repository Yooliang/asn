# 黃金檔總說明

這個資料夾放「黃金檔」：純函式在固定輸入下的**現況輸出**，由 `src/golden_util.rs` 的 `golden!` 巨集比對。
鎖的是現況，不是期望——看起來像 bug 的結果也如實記著，改行為的人要自己看過差異、決定要不要更新。

- 分資料夾：`term/`（G1，終端畫面分類與按鍵）、`acp/`（G2，agy／ACP 通道），各有說明。
- 重新產生：`ASN_UPDATE_GOLDEN=1 cargo test --lib golden`，再不帶旗標重跑一次；CI 禁止重寫。重寫後要審 `git diff` 並逐檔列在 PR。
- 重要限制：`term/` 裡 22 份真實 claude／pi 樣本的 `classify_prompt` 結果全是 None，真正鎖住分類能力的是合成案例；
  agy／grok／codex 的真實畫面要等 G4 放進來，才算用樣本鎖住。
