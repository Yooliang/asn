// 此檔由 src-tauri/src/launch/screen_catalog.rs 產出，不要手改（#1813）。
// 新增或修改畫面種類：改 Rust 的清單，再執行 ASN_REGEN_SCREENS=1 cargo test --lib screen_catalog 重產；
// 不一致時 Rust 測試會紅。內文的 {name} 換成夥伴名。
export const STUCK_SCREENS = [
  { code: "permission", label: "等你回答：權限", notice: { title: "夥伴在等你回答", body: "「{name}」在等你同意一項操作，請到它的視窗確認。" }, hint: "它在等你同意一項操作：直接在下面的畫面按數字鍵回答。" },
  { code: "trust", label: "等你回答：信任資料夾", notice: { title: "夥伴在等你回答", body: "「{name}」在問要不要信任這個資料夾，請到它的視窗確認。" }, hint: "它在問要不要信任這個資料夾：直接在下面的畫面回答。" },
  { code: "bypass_warning", label: "卡在略過權限警告", notice: { title: "夥伴在等你確認", body: "「{name}」第一次開啟，要你同意它的權限設定，請到它的視窗確認。" }, hint: "它在等你確認權限設定：直接在下面的畫面回答。" },
  { code: "login", label: "需要登入", notice: { title: "夥伴需要登入", body: "「{name}」需要登入才能繼續，請到它的視窗登入。" }, hint: null },
  { code: "usage_limit", label: "額度用完", notice: { title: "夥伴的額度用完了", body: "「{name}」的額度用完了，要等額度恢復才能繼續。" }, hint: null },
  { code: "usage_menu", label: "額度用完：等你選", notice: { title: "夥伴的額度用完了", body: "「{name}」的額度用完了，在問接下來要怎麼做。手機上可以選「停下來等」或「在這裡等」，付費的選項請到它的視窗選。" }, hint: "它的額度用完了，在問接下來要怎麼做：直接在下面的畫面選。" },
  { code: "question", label: "等你回答：問題", notice: { title: "夥伴在問你問題", body: "「{name}」在等你選一個答案，請到它的視窗回答。" }, hint: null },
  { code: "question_view", label: "等你回答：問題", notice: { title: "夥伴在問你問題", body: "「{name}」在等你選答案，請到它的視窗回答。" }, hint: null },
  { code: "attention", label: "需要人工確認", notice: null, hint: null },
  { code: "held_message", label: "等你確認：外來訊息", notice: { title: "夥伴收到外來訊息", body: "「{name}」收到一則外來訊息，等你決定要不要放行。" }, hint: "它收到一則外來訊息，在等你決定要不要放行：請用跳出的提示框，或到它自己的終端視窗處理；這裡打的字不會送出。" },
]
