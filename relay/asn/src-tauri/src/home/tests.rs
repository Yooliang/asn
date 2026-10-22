//! 使用者資料夾解析與合併式遷移的測試。全部在暫存資料夾、注入的家目錄裡做，不碰真的 ~/.asn、~/.irori-relay；
//! 金鑰一律是假內容。
use super::*;
use std::cell::Cell;

/// 注入失敗的假動作：第 fail_rename_at 次 rename 失敗（0＝不失敗）、make_link 可失敗、alive 是「活著的 pid」。
/// rename 與建連結其餘時候都是真的檔案系統動作（建真的目錄接合點／符號連結）。
struct Fake {
    fail_rename_at: usize,
    calls: Cell<usize>,
    fail_link: bool,
    alive: Vec<u32>,
}
impl Fake {
    fn ok() -> Fake {
        Fake { fail_rename_at: 0, calls: Cell::new(0), fail_link: false, alive: vec![] }
    }
}
impl Ops for Fake {
    fn rename(&self, from: &Path, to: &Path) -> io::Result<()> {
        self.calls.set(self.calls.get() + 1);
        if self.fail_rename_at != 0 && self.calls.get() == self.fail_rename_at {
            return Err(io::Error::other("注入的失敗"));
        }
        fs::rename(from, to)
    }
    fn make_link(&self, link: &Path, target: &Path) -> io::Result<()> {
        if self.fail_link {
            return Err(io::Error::other("注入的失敗"));
        }
        RealOps.make_link(link, target)
    }
    fn pid_alive(&self, pid: u32) -> bool {
        self.alive.contains(&pid)
    }
}

fn w(p: &Path, body: &str) {
    fs::create_dir_all(p.parent().unwrap()).unwrap();
    fs::write(p, body).unwrap();
}
fn r(p: &Path) -> String {
    fs::read_to_string(p).unwrap()
}
/// 假的舊資料夾：金鑰與節點代號都是假內容
fn legacy_fixture(base: &Path) {
    let l = base.join(LEGACY_NAME);
    w(&l.join("H.key"), "fake-key");
    w(&l.join("node"), "H");
    w(&l.join("anon.key"), "fake-anon");
    w(&l.join("machine-H").join("bridge.log"), "log");
    w(&l.join("agents.json"), "{}");
}
/// 資料夾的全部內容快照（路徑→內容），用來證明失敗時什麼都沒變
fn snapshot(dir: &Path) -> Vec<(String, String)> {
    fn walk(root: &Path, d: &Path, out: &mut Vec<(String, String)>) {
        let Ok(rd) = fs::read_dir(d) else { return };
        let mut v: Vec<_> = rd.flatten().collect();
        v.sort_by_key(|e| e.file_name());
        for e in v {
            let p = e.path();
            let rel = p.strip_prefix(root).unwrap().to_string_lossy().replace('\\', "/");
            if p.is_dir() {
                out.push((format!("{rel}/"), String::new()));
                walk(root, &p, out);
            } else {
                out.push((rel, fs::read_to_string(&p).unwrap_or_default()));
            }
        }
    }
    let mut o = Vec::new();
    walk(dir, dir, &mut o);
    o
}
fn both(base: &Path) -> (Vec<(String, String)>, Vec<(String, String)>) {
    (snapshot(&base.join(".irori-relay")), snapshot(&base.join(".asn")))
}

// ---------------- 解析

#[test]
fn 解析_覆寫優先_不看舊位置() {
    let d = tempfile::tempdir().unwrap();
    legacy_fixture(d.path());
    let h = resolve_at(d.path(), Some("  X:/custom "));
    assert_eq!((h.state, h.primary), (State::Override, PathBuf::from("X:/custom")));
    assert_eq!(resolve_at(d.path(), Some("   ")).state, State::Legacy, "空白不算覆寫");
}

#[test]
fn 解析_全新電腦用新位置_只有舊的用舊的_只有新的用新的() {
    let d = tempfile::tempdir().unwrap();
    let h = resolve_at(d.path(), None);
    assert_eq!((h.state, h.primary.clone()), (State::Fresh, d.path().join(".asn")));
    assert!(!d.path().join(".asn").exists(), "解析不建任何東西");
    legacy_fixture(d.path());
    let h = resolve_at(d.path(), None);
    assert_eq!((h.state, h.primary, h.fallback), (State::Legacy, d.path().join(".irori-relay"), None));
    let d2 = tempfile::tempdir().unwrap();
    w(&d2.path().join(".asn").join("handoff").join("a.md"), "x");
    assert_eq!(resolve_at(d2.path(), None).state, State::New);
}

#[test]
fn 解析_兩邊都有且舊的有內容_用舊的並以新的當後備() {
    let d = tempfile::tempdir().unwrap();
    legacy_fixture(d.path());
    w(&d.path().join(".asn").join("handoff").join("a.md"), "x");
    let h = resolve_at(d.path(), None);
    assert_eq!((h.state, h.primary, h.fallback), (State::Pending, d.path().join(".irori-relay"), Some(d.path().join(".asn"))));
}

#[test]
fn 解析_舊的是空資料夾_用新的() {
    let d = tempfile::tempdir().unwrap();
    fs::create_dir_all(d.path().join(".irori-relay")).unwrap();
    fs::create_dir_all(d.path().join(".asn")).unwrap();
    assert_eq!(resolve_at(d.path(), None).state, State::New);
}

// ---------------- 遷移

#[test]
fn 遷移_只有舊的_整個改名後舊位置變相容連結_舊路徑仍讀得到() {
    let d = tempfile::tempdir().unwrap();
    legacy_fixture(d.path());
    let o = migrate(d.path(), &Fake::ok());
    assert_eq!(o, Outcome::Migrated { moved: vec![], conflicts: vec![], whole: true });
    assert_eq!(r(&d.path().join(".asn").join("H.key")), "fake-key");
    assert_eq!(r(&d.path().join(".irori-relay").join("H.key")), "fake-key", "經連結讀舊路徑");
    assert_eq!(kind_of(&d.path().join(".irori-relay")), Some(Kind::Link));
    assert!(d.path().join(".asn").join(MARKER).exists());
    let h = resolve_at(d.path(), None);
    assert_eq!((h.state, h.primary), (State::Linked, d.path().join(".asn")));
}

#[test]
fn 遷移_只有新的_沒事做() {
    let d = tempfile::tempdir().unwrap();
    w(&d.path().join(".asn").join("handoff").join("a.md"), "x");
    assert!(matches!(migrate(d.path(), &Fake::ok()), Outcome::Nothing(_)));
    assert!(!d.path().join(".irori-relay").exists(), "沒有舊的就不憑空建連結");
}

#[test]
fn 遷移_兩邊都有_逐項合併_新的原有項目不動() {
    let d = tempfile::tempdir().unwrap();
    legacy_fixture(d.path());
    w(&d.path().join(".asn").join("handoff").join("a.md"), "keep");
    w(&d.path().join(".asn").join("status").join("s.json"), "keep2");
    let o = migrate(d.path(), &Fake::ok());
    let Outcome::Migrated { moved, conflicts, whole } = o else { panic!("{o:?}") };
    assert!(!whole && conflicts.is_empty());
    assert_eq!(moved, vec!["H.key", "agents.json", "anon.key", "machine-H", "node"]);
    let n = d.path().join(".asn");
    assert_eq!(r(&n.join("H.key")), "fake-key");
    assert_eq!(r(&n.join("machine-H").join("bridge.log")), "log");
    assert_eq!(r(&n.join("handoff").join("a.md")), "keep");
    assert_eq!(r(&n.join("status").join("s.json")), "keep2");
    assert_eq!(kind_of(&d.path().join(".irori-relay")), Some(Kind::Link));
    assert_eq!(r(&d.path().join(".irori-relay").join("node")), "H", "舊路徑經連結仍讀得到");
    assert!(n.join(MARKER).exists());
    assert_eq!(resolve_at(d.path(), None).state, State::Linked);
    // 再跑一次：已是連結，不重做
    assert!(matches!(migrate(d.path(), &Fake::ok()), Outcome::Nothing(_)));
}

#[test]
fn 遷移_同名衝突不覆寫_舊的那份保留在衝突資料夾() {
    let d = tempfile::tempdir().unwrap();
    legacy_fixture(d.path());
    w(&d.path().join(".asn").join("node"), "NEW-NODE");
    w(&d.path().join(".asn").join("machine-H").join("other.txt"), "new-side");
    let o = migrate(d.path(), &Fake::ok());
    let Outcome::Migrated { moved, conflicts, .. } = o else { panic!("{o:?}") };
    assert_eq!(conflicts, vec!["machine-H", "node"]);
    assert!(moved.contains(&"H.key".to_string()));
    let n = d.path().join(".asn");
    assert_eq!(r(&n.join("node")), "NEW-NODE", "新位置的同名項目不被覆寫");
    assert_eq!(r(&n.join("machine-H").join("other.txt")), "new-side");
    assert_eq!(r(&n.join(CONFLICTS_DIR).join("node")), "H", "舊的那份沒丟");
    assert_eq!(r(&n.join(CONFLICTS_DIR).join("machine-H").join("bridge.log")), "log");
    assert!(r(&n.join(MARKER)).contains("\"node\""), "標記檔記下衝突");
}

#[test]
fn 遷移_舊的已經是連結_不重做() {
    let d = tempfile::tempdir().unwrap();
    legacy_fixture(d.path());
    assert!(matches!(migrate(d.path(), &Fake::ok()), Outcome::Migrated { .. }));
    let before = snapshot(&d.path().join(".asn"));
    let fake = Fake::ok();
    assert!(matches!(migrate(d.path(), &fake), Outcome::Nothing(_)));
    assert_eq!(fake.calls.get(), 0, "一次 rename 都沒做");
    assert_eq!(snapshot(&d.path().join(".asn")), before);
}

#[test]
fn 遷移_舊橋還在跑_不遷移_什麼都不動() {
    let d = tempfile::tempdir().unwrap();
    legacy_fixture(d.path());
    w(&d.path().join(".irori-relay").join("machine-H").join("bridge.pid"), "4242");
    w(&d.path().join(".asn").join("handoff").join("a.md"), "x");
    let before = both(d.path());
    let fake = Fake { alive: vec![4242], ..Fake::ok() };
    let o = migrate(d.path(), &fake);
    assert!(matches!(&o, Outcome::Skipped(m) if m.contains("4242")), "{o:?}");
    assert_eq!(fake.calls.get(), 0);
    assert_eq!(both(d.path()), before);
    // mailbox.pid 也算；程序已不在（pid 檔過期）就照常遷移
    let d2 = tempfile::tempdir().unwrap();
    legacy_fixture(d2.path());
    w(&d2.path().join(".irori-relay").join("machine-H").join("mailbox.pid"), "777");
    let alive = Fake { alive: vec![777], ..Fake::ok() };
    assert!(matches!(migrate(d2.path(), &alive), Outcome::Skipped(_)));
    assert!(matches!(migrate(d2.path(), &Fake::ok()), Outcome::Migrated { .. }), "pid 檔還在但程序已死：可以遷移");
}

#[test]
fn 遷移_中途失敗_全部倒回_不刪任何東西_仍讀得到() {
    for fail_at in 1..=5 {
        let d = tempfile::tempdir().unwrap();
        legacy_fixture(d.path());
        w(&d.path().join(".asn").join("handoff").join("a.md"), "keep");
        w(&d.path().join(".asn").join("node"), "NEW-NODE"); // 讓衝突路徑也被走到
        let before = both(d.path());
        let fake = Fake { fail_rename_at: fail_at, ..Fake::ok() };
        let o = migrate(d.path(), &fake);
        let Outcome::Failed { rollback_errors, .. } = o else { panic!("第 {fail_at} 次：{o:?}") };
        assert!(rollback_errors.is_empty(), "{rollback_errors:?}");
        assert_eq!(both(d.path()), before, "第 {fail_at} 次失敗後內容要與遷移前完全相同");
        assert_eq!(kind_of(&d.path().join(".irori-relay")), Some(Kind::Dir), "舊位置仍是真資料夾");
        assert!(!d.path().join(".asn").join(MARKER).exists(), "失敗不寫完成標記");
        let h = resolve_at(d.path(), None);
        assert_eq!(r(&h.primary.join("H.key")), "fake-key", "失敗後照舊讀得到金鑰");
    }
}

#[test]
fn 遷移_建連結失敗_倒回_新舊內容與遷移前相同() {
    for with_new in [false, true] {
        let d = tempfile::tempdir().unwrap();
        legacy_fixture(d.path());
        if with_new {
            w(&d.path().join(".asn").join("handoff").join("a.md"), "keep");
        }
        let before = both(d.path());
        let o = migrate(d.path(), &Fake { fail_link: true, ..Fake::ok() });
        assert!(matches!(&o, Outcome::Failed { rollback_errors, .. } if rollback_errors.is_empty()), "{o:?}");
        assert_eq!(both(d.path()), before);
        assert_eq!(kind_of(&d.path().join(".irori-relay")), Some(Kind::Dir));
    }
}

#[test]
fn 遷移_整個改名失敗_舊的原封不動() {
    let d = tempfile::tempdir().unwrap();
    legacy_fixture(d.path());
    let before = snapshot(&d.path().join(".irori-relay"));
    let o = migrate(d.path(), &Fake { fail_rename_at: 1, ..Fake::ok() });
    assert!(matches!(o, Outcome::Failed { .. }));
    assert_eq!(snapshot(&d.path().join(".irori-relay")), before);
    assert!(!d.path().join(".asn").exists());
}

#[test]
fn 遷移_ASN_HOME_有設就不遷移() {
    let d = tempfile::tempdir().unwrap();
    legacy_fixture(d.path());
    let fake = Fake::ok();
    let o = migrate_unless_override(d.path(), Some("D:/somewhere"), &fake);
    assert!(matches!(o, Outcome::Skipped(_)));
    assert_eq!(fake.calls.get(), 0);
    assert!(d.path().join(".irori-relay").join("H.key").exists());
    assert!(matches!(migrate_unless_override(d.path(), Some("  "), &Fake::ok()), Outcome::Migrated { .. }), "空白不算覆寫");
}

#[test]
fn 身分解析_主要位置缺項時回頭找後備() {
    // 倒回不完整的假想狀態：舊位置有節點代號、金鑰卻已在新位置
    let d = tempfile::tempdir().unwrap();
    w(&d.path().join(".irori-relay").join("node"), "H");
    w(&d.path().join(".asn").join("H.key"), "fake-key");
    let h = resolve_at(d.path(), None);
    assert_eq!(h.state, State::Pending);
    let id = crate::identity::resolve_in(&h).expect("後備位置有金鑰");
    assert_eq!((id.node.as_str(), id.key.as_str()), ("H", "fake-key"));
}

#[test]
fn 守門_舊資料夾名只在_home_rs_出現_其他程式一律經單一解析函式() {
    fn walk(d: &Path, out: &mut Vec<String>) {
        for e in fs::read_dir(d).unwrap().flatten() {
            let p = e.path();
            if p.is_dir() {
                walk(&p, out);
            } else if p.extension().map(|x| x == "rs").unwrap_or(false) {
                let name = p.to_string_lossy().replace('\\', "/");
                if name.ends_with("/home.rs") || name.ends_with("/home/tests.rs") {
                    continue;
                }
                for (i, line) in fs::read_to_string(&p).unwrap().lines().enumerate() {
                    let code = line.split("//").next().unwrap_or("");
                    if code.contains("\".irori-relay\"") {
                        out.push(format!("{name}:{}", i + 1));
                    }
                }
            }
        }
    }
    let mut bad = Vec::new();
    walk(&Path::new(env!("CARGO_MANIFEST_DIR")).join("src"), &mut bad);
    assert!(bad.is_empty(), "這些地方還寫死舊資料夾名：{bad:?}");
}
