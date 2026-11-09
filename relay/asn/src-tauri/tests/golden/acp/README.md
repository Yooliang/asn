# acp 黃金檔（G2）

鎖的是 agy／ACP 通道純函式與固定文字的**現況**，不是期望。測試在 `src/bridge/engines/golden.rs`。

| 檔 | 對應函式 |
|---|---|
| agy_args.json | `acp_agy::agy_args` |
| parse_agy_models.json | `acp_models::parse_agy_models`（輸入 `tests/fixtures/agy-models/sample.txt`，測試內另做 CRLF 版本） |
| category_of_agy_tool.json | `acp_policy::category_of_agy_tool`（白名單表是私有常數，測試直接讀 `acp_policy.rs` 原始碼取名字） |
| describe_agy_tool.json | `acp_policy::describe_agy_tool` |
| failure_classes.json | `classify_failure`、`is_network_error` |
| templates.json | `acp_worker::preamble_for`、`redirect_note` |
| ask_text.json | `acp_approvals::ask_text` |
| handle_reply.json | `Approvals::handle_reply`（授權編號是隨機的，輸出前換成 `<ID>`） |
| constants.json | 公開常數（類別、類別標籤、`perm_remote::TICK_SECS`） |

重新產生：`ASN_UPDATE_GOLDEN=1 cargo test --lib golden`，不帶旗標再跑一次；要審 `git diff`，並在 PR 逐檔列出變動。

注意：`tests/golden/term` 裡 22 份真實 claude／pi 樣本的 `classify_prompt` 結果全是 None，
真正鎖住分類能力的是合成案例；agy／grok／codex 真實畫面要等 G4 放進來才算用樣本鎖住。
