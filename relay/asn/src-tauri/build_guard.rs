// 發版建置絕不能帶 test-hooks（#2163 PR-3b 第二道證明）。
// build.rs 與 src/flags/test_var.rs 的測試都用 include! 引這個檔，所以判斷只有一份，而且能在 cargo test 裡驗。
// 發版腳本與 workflow 建正式安裝檔時設 ASN_SHIPPING_BUILD=1；帶了 test-hooks 就在編譯期直接失敗。

/// `shipping`：環境變數 ASN_SHIPPING_BUILD 的值；`hooks`：這次建置有沒有開 test-hooks。
/// 回 Some(訊息) 代表這組合不准建。
pub fn shipping_with_hooks_error(shipping: Option<&str>, hooks: bool) -> Option<String> {
    if hooks && shipping == Some("1") {
        Some("發版建置（ASN_SHIPPING_BUILD=1）不准帶 test-hooks feature：正式安裝包不能有測試掛鉤。e2e 專用的 hooks 版 exe 要另外建（見 scripts/release-ci.mjs）".to_string())
    } else {
        None
    }
}
