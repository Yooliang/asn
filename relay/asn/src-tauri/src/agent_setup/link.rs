//! 可以隨密碼請求送到手機的「登入網址」（asn真條件 A）。
//! 這個型別只能在 `agent_setup` 裡建立（建構子是 `pub(in crate::agent_setup)`）：`asn-cli`、夥伴能呼叫的指令、
//! 其他模組都建不出來，所以 AI 沒有辦法透過 ASN 自己的程式把一個假的登入頁推到小良哥的手機。
//! 就算有人繞過 ASN、直接拿節點金鑰呼叫後台，後台也要求帶登入網址的請求必須有本人簽章（AI 拿不到），見 `20261101230000_secret_link.sql`。

use crate::secret_remote::link::valid_login_link;

pub struct LoginLink(String);

impl LoginLink {
    /// 只收官方登入網域的 https（見 `secret_remote::link`）
    pub(in crate::agent_setup) fn parse(url: &str) -> Result<Self, String> {
        if valid_login_link(url) {
            Ok(LoginLink(url.to_string()))
        } else {
            Err("登入網址不是官方登入網域的 https，沒有送出".to_string())
        }
    }

    pub(crate) fn as_str(&self) -> &str {
        &self.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 只收官方登入網址() {
        assert!(LoginLink::parse("https://claude.ai/oauth/authorize?client_id=C").is_ok());
        for bad in ["http://claude.ai/x", "https://evil.example/x", "https://claude.ai@evil.com/x", ""] {
            assert!(LoginLink::parse(bad).is_err(), "{bad}");
        }
    }

    /// 條件 A：這個型別與它的建構子只能出現在 agent_setup 與請求端裡；asn-cli 與其他模組不能碰
    #[test]
    fn 守門_只有_agent_setup_能建立登入網址() {
        let src = include_str!("link.rs");
        let body = &src[..src.find("#[cfg(test)]").unwrap()];
        assert!(body.contains("pub(in crate::agent_setup) fn parse"), "建構子要限制在 agent_setup");
        assert!(!body.contains("pub fn parse") && !body.contains("pub(crate) fn parse"), "不能放寬建構子");
        // 整個程式裡，除了 agent_setup 與 secret_remote 以外，不能有任何地方提到登入網址型別或附網址的設定方法
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut stack = vec![root.clone()];
        let mut hits = vec![];
        let (a, b) = (["Login", "Link"].concat(), [".with", "_link("].concat());
        while let Some(d) = stack.pop() {
            for e in std::fs::read_dir(&d).unwrap().flatten() {
                let p = e.path();
                if p.is_dir() {
                    stack.push(p);
                } else if p.extension().is_some_and(|x| x == "rs") {
                    let rel = p.strip_prefix(&root).unwrap().to_string_lossy().replace('\\', "/");
                    if rel.starts_with("agent_setup/") || rel.starts_with("secret_remote/") {
                        continue;
                    }
                    let text = std::fs::read_to_string(&p).unwrap();
                    if text.contains(&a) || text.contains(&b) {
                        hits.push(rel);
                    }
                }
            }
        }
        assert!(hits.is_empty(), "這些檔案碰了登入網址：{hits:?}");
    }
}
