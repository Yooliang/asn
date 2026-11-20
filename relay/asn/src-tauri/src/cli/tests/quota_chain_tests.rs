//! #1883：`asn claude-quota` 只剩舊設定的串接（下一版拿掉），不記任何額度、不讀任何憑證
use super::*;

fn dir_listing(root: &Path) -> Vec<String> {
    fn walk(p: &Path, out: &mut Vec<String>) {
        for e in std::fs::read_dir(p).into_iter().flatten().flatten() {
            let path = e.path();
            out.push(path.to_string_lossy().to_string());
            if path.is_dir() {
                walk(&path, out);
            }
        }
    }
    let mut v = vec![];
    walk(root, &mut v);
    v.sort();
    v
}

#[test]
fn claude_quota_只做轉送_不記任何額度_不產生任何檔案_結束碼_0() {
    let f = fx("http://127.0.0.1:9", None);
    let before = dir_listing(&f.home);
    let status = json!({
        "session_id": "S-1", "transcript_path": "x", "oauth_token": "SECRET-TOKEN",
        "rate_limits": { "five_hour": { "used_percentage": 38.0, "resets_at": 1_999_999_999 }, "seven_day": { "used_percentage": 20.0, "resets_at": 1_999_999_999 } }
    })
    .to_string();
    for args in [vec!["claude-quota"], vec!["claude-quota", "--chain"]] {
        let (code, out, err) = go(&f.env, &args, &status);
        assert_eq!(code, 0, "{args:?}");
        assert!(out.is_empty() && err.is_empty(), "沒有原本的狀態列就什麼都不印：{out}{err}");
    }
    assert_eq!(dir_listing(&f.home), before, "不記額度、不寫 log、不寫狀態檔");
    assert!(!f.rh().join("claude-quota.json").exists());
    let src = include_str!("../quota_cmd.rs");
    assert!(!src.contains("claude_quota::") && !src.contains("claude_home"), "串接命令不碰額度程式與家目錄的憑證");
}
