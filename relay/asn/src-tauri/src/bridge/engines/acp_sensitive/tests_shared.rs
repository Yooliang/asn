//! 與 Linux 版（relay/machine 的 acp-sensitive*.mjs）共用的清單與測試向量（#2356 PR-2）。
//! 清單與參數只存在 relay/shared/sensitive-roots.json（Node 版直接讀）：這裡逐項比對，Rust 的常數跟共用檔不一致，測試就紅。
//! 向量在 relay/shared/test-vectors/sensitive-read.json，兩邊逐筆比同一份期望。測試只用暫存資料夾裡的假家目錄與假 ASN 資料夾。
use super::fragments::{fragments, prose_candidates, LEAD, MAX_HITS, MAX_STARTS, TRAIL, TRIM};
use super::*;
use crate::bridge::engines::acp_policy::{category_of_agy_tool, is_registered_agy_tool, AGY_EXEC, AGY_INTERNAL, AGY_NET, AGY_READ, AGY_WRITE};
use serde_json::{json, Value};
use std::collections::HashMap;

const ROOTS_JSON: &str = include_str!("../../../../../../shared/sensitive-roots.json");
const VECTORS_JSON: &str = include_str!("../../../../../../shared/test-vectors/sensitive-read.json");

fn strs(v: &Value) -> Vec<String> {
    v.as_array().unwrap_or_else(|| panic!("不是陣列：{v}")).iter().map(|x| x.as_str().unwrap().to_string()).collect()
}
fn owned(a: &[&str]) -> Vec<String> {
    a.iter().map(|s| s.to_string()).collect()
}

#[test]
fn 共用清單_清單與判定參數跟共用檔逐項相同() {
    let j: Value = serde_json::from_str(ROOTS_JSON).unwrap();
    assert_eq!(owned(&SENSITIVE_HOME_DIRS), strs(&j["homeDirs"]), "homeDirs");
    assert_eq!(owned(&EXTRA_HOME_PATHS), strs(&j["extraHomePaths"]), "extraHomePaths");
    assert_eq!(owned(&[crate::home::NEW_NAME, crate::home::LEGACY_NAME]), strs(&j["asnDirNames"]), "asnDirNames");
    let prefix: Vec<(String, String)> = PREFIX_HOME_FILES.iter().map(|(a, b)| (a.to_string(), b.to_string())).collect();
    let json_prefix: Vec<(String, String)> = j["prefixHomeFiles"].as_array().unwrap().iter().map(|p| (p[0].as_str().unwrap().to_string(), p[1].as_str().unwrap().to_string())).collect();
    assert_eq!(prefix, json_prefix, "prefixHomeFiles");
    assert_eq!(owned(&ENV_ROOTS), strs(&j["envRoots"]), "envRoots");
    assert_eq!(owned(&LOCALAPPDATA_ROOTS), strs(&j["localAppDataRoots"]), "localAppDataRoots");
    assert_eq!(owned(&APPDATA_ROOTS), strs(&j["appDataRoots"]), "appDataRoots");
    assert_eq!(HOST_KEY_DIR, j["hostKeyDir"].as_str().unwrap(), "hostKeyDir");
    assert_eq!(owned(&SYSTEM_FILES), strs(&j["systemFiles"]), "systemFiles");
    assert_eq!(owned(&OTHER_HOME_PARENTS), strs(&j["otherHomeParents"]), "otherHomeParents");
    assert_eq!(owned(&SHARED_HOME_NAMES), strs(&j["sharedHomeNames"]), "sharedHomeNames");
    assert_eq!(MAX_PATH_LEN as u64, j["maxPathLen"].as_u64().unwrap(), "maxPathLen");
    assert_eq!(MAX_JSON_DEPTH as u64, j["maxJsonDepth"].as_u64().unwrap(), "maxJsonDepth");
    assert_eq!(owned(&PATH_KEY_WORDS), strs(&j["pathKeyWords"]), "pathKeyWords");
    assert_eq!(owned(&SKIP_KEYS), strs(&j["skipKeys"]), "skipKeys");
    let pr = &j["prose"];
    assert_eq!(std::str::from_utf8(LEAD).unwrap(), pr["lead"].as_str().unwrap(), "prose.lead");
    assert_eq!(std::str::from_utf8(TRAIL).unwrap(), pr["trail"].as_str().unwrap(), "prose.trail");
    assert_eq!(TRIM, pr["trim"].as_str().unwrap(), "prose.trim");
    assert_eq!(MAX_HITS as u64, pr["maxHits"].as_u64().unwrap(), "prose.maxHits");
    assert_eq!(MAX_STARTS as u64, pr["maxStarts"].as_u64().unwrap(), "prose.maxStarts");
    assert_eq!(crate::bridge::engines::acp_worker::READ_OK, j["preambleReadOk"].as_str().unwrap(), "preambleReadOk");
}

#[test]
fn 共用清單_agy_工具分類跟共用檔逐項相同() {
    let j: Value = serde_json::from_str(ROOTS_JSON).unwrap();
    let t = &j["agyTools"];
    assert_eq!(owned(&AGY_READ), strs(&t["read"]), "read");
    assert_eq!(owned(&AGY_WRITE), strs(&t["write"]), "write");
    assert_eq!(owned(&AGY_EXEC), strs(&t["execute"]), "execute");
    assert_eq!(owned(&AGY_NET), strs(&t["network"]), "network");
    assert_eq!(owned(AGY_INTERNAL), strs(&t["internal"]), "internal");
    for (cat, key) in [("read", "read"), ("write", "write"), ("execute", "execute"), ("network", "network"), ("internal", "internal")] {
        for n in strs(&t[key]) {
            assert_eq!(category_of_agy_tool(&n), cat, "{n}");
            assert!(is_registered_agy_tool(&n), "{n}");
        }
    }
    let (list, rec) = (strs(&t["list"]), strs(&t["recursive"]));
    for n in strs(&t["read"]) {
        let want = if list.contains(&n) { ReadTool::List } else if rec.contains(&n) { ReadTool::Recursive } else { ReadTool::Single };
        assert_eq!(ReadTool::of_agy(&n), want, "{n}");
    }
}

// ---- 向量 ----

struct Tp {
    _d: tempfile::TempDir,
    p: HashMap<&'static str, String>,
}
fn tp() -> Tp {
    let d = tempfile::tempdir().unwrap();
    let t = d.path().to_path_buf();
    let ps = |p: &Path| p.display().to_string();
    let home = t.join("home");
    let asn = home.join(".asn");
    let mach = asn.join("machine-T");
    let mut p: HashMap<&'static str, String> = HashMap::new();
    p.insert("TMP", ps(&t));
    p.insert("HOME", ps(&home));
    p.insert("HOME2", ps(&t.join("home2")));
    p.insert("WORK", ps(&t.join("work")));
    p.insert("ASN", ps(&asn));
    p.insert("OWN", ps(&mach.join("workers").join("甲")));
    p.insert("MACH", ps(&mach));
    Tp { _d: d, p }
}
fn urlp(p: &str) -> String {
    format!("///{}", p.replace('\\', "/").trim_start_matches('/'))
}
fn rep(s: &str) -> String {
    let mut out = s.to_string();
    while let Some(i) = out.find("{REP:") {
        let j = out[i..].find('}').unwrap() + i;
        let (x, n) = out[i + 5..j].rsplit_once(':').unwrap();
        let r = x.repeat(n.parse().unwrap());
        out = format!("{}{}{}", &out[..i], r, &out[j + 1..]);
    }
    out
}
fn tpl(s: &str, t: &Tp) -> String {
    let mut o = rep(s).replace("{HOME_URLP}", &urlp(&t.p["HOME"])).replace("{WORK_URLP}", &urlp(&t.p["WORK"]));
    for k in ["TMP", "HOME2", "HOME", "WORK", "ASN", "MACH", "OWN"] {
        o = o.replace(&format!("{{{k}}}"), &t.p[k]);
    }
    o.replace("{BRACE}", "{")
}
fn tpl_deep(v: &Value) -> Value {
    match v {
        Value::String(s) => Value::String(rep(s)),
        Value::Array(a) => Value::Array(a.iter().map(tpl_deep).collect()),
        Value::Object(m) => Value::Object(m.iter().map(|(k, x)| (k.clone(), tpl_deep(x))).collect()),
        o => o.clone(),
    }
}
fn tool_of(c: &Value) -> ReadTool {
    match c.get("t").and_then(Value::as_str).unwrap_or("single") {
        "list" => ReadTool::List,
        "recursive" => ReadTool::Recursive,
        _ => ReadTool::Single,
    }
}
fn skip(c: &Value) -> bool {
    match c.get("os").and_then(Value::as_str) {
        Some("windows") => !cfg!(windows),
        Some("posix") => cfg!(windows),
        _ => false,
    }
}
fn fail_canon(_: &Path) -> io::Result<PathBuf> {
    Err(io::Error::other("無法解析"))
}

fn run_case(c: &Value, t: &Tp) -> ReadVerdict {
    for d in [t.p["HOME"].clone(), t.p["WORK"].clone()].into_iter().chain(c.get("mk").map(strs).unwrap_or_default().iter().map(|d| tpl(d, t))) {
        std::fs::create_dir_all(d).unwrap();
    }
    let homes: Vec<PathBuf> = c.get("homes").map(strs).unwrap_or_else(|| vec!["{HOME}".into()]).iter().map(|h| PathBuf::from(tpl(h, t))).collect();
    let env: Vec<(String, String)> = c.get("env").and_then(Value::as_object).map(|m| m.iter().map(|(k, v)| (k.clone(), tpl(v.as_str().unwrap(), t))).collect()).unwrap_or_default();
    let roots = match c.get("ex") {
        Some(ex) => {
            let own: Vec<PathBuf> = strs(&ex["ownDirs"]).iter().map(|d| PathBuf::from(tpl(d, t))).collect();
            let own_refs: Vec<&Path> = own.iter().map(PathBuf::as_path).collect();
            let work = PathBuf::from(tpl(ex["workDir"].as_str().unwrap(), t));
            let name = ex["name"].as_str().unwrap();
            if ex.get("attachments").and_then(Value::as_bool) == Some(false) {
                SensitiveRoots::build(&homes_from(&env, Some(homes[0].clone())), &env).with_workdirs(name, &own_refs, &work, false)
            } else {
                roots_for_worker(&env, homes[0].clone(), name, &own_refs, &work)
            }
        }
        None => {
            let canon: Canon = if c.get("canonFails").and_then(Value::as_bool) == Some(true) { fail_canon } else { std_canon };
            SensitiveRoots::build_with(&homes, &env, canon)
        }
    };
    let base = PathBuf::from(tpl(c.get("b").and_then(Value::as_str).unwrap_or("{WORK}"), t));
    read_verdict(&tpl(c["p"].as_str().unwrap(), t), &ReadCtx { roots: &roots, base: &base, tool: tool_of(c) })
}

fn want(c: &Value) -> ReadVerdict {
    match c["e"].as_str().unwrap() {
        "allow" => ReadVerdict::Allow,
        "sensitive" => ReadVerdict::Sensitive,
        "unresolvable" => ReadVerdict::Unresolvable,
        o => panic!("不認得的期望 {o}"),
    }
}

fn check_group(group: &str) {
    let v: Value = serde_json::from_str(VECTORS_JSON).unwrap();
    let t = tp();
    let mut bad: Vec<String> = vec![];
    let cases = v[group].as_array().unwrap();
    let mut ran = 0;
    for c in cases {
        if skip(c) {
            continue;
        }
        ran += 1;
        let got = run_case(c, &t);
        if got != want(c) {
            bad.push(format!("{}：{} → {:?}（期望 {:?}）", c["n"].as_str().unwrap(), c["p"].as_str().unwrap(), got, want(c)));
        }
    }
    assert!(ran > 20, "{group} 只跑了 {ran} 筆");
    assert!(bad.is_empty(), "{group} 有 {} 筆不一致：\n{}", bad.len(), bad.join("\n"));
}

#[test]
fn 向量_判定結果逐筆相同() {
    check_group("verdicts");
}

#[test]
fn 向量_放行資料夾逐筆相同() {
    check_group("exempt");
}

#[test]
fn 向量_純字串函式與抽取逐筆相同() {
    let v: Value = serde_json::from_str(VECTORS_JSON).unwrap();
    let pure = &v["pure"];
    for p in pure["winClean"].as_array().unwrap() {
        assert_eq!(win_clean(p[0].as_str().unwrap()), p[1].as_str().unwrap(), "{p}");
    }
    let local = strs(&pure["opaqueLocalNames"]);
    for p in strs(&pure["opaqueYes"]) {
        assert!(opaque_device_path(&p, &local), "{p}");
    }
    for p in strs(&pure["opaqueNo"]) {
        assert!(!opaque_device_path(&p, &local), "{p}");
    }
    for p in strs(&pure["driveRelativeYes"]) {
        assert!(drive_relative(&p), "{p}");
    }
    for p in strs(&pure["driveRelativeNo"]) {
        assert!(!drive_relative(&p), "{p}");
    }
    for p in pure["wildcardPrefix"].as_array().unwrap() {
        assert_eq!(wildcard_prefix(p[0].as_str().unwrap()), p[1].as_str().map(String::from), "{p}");
    }
    for p in pure["stripFileUrl"].as_array().unwrap() {
        assert_eq!(strip_file_url(p[0].as_str().unwrap()), p[1].as_str().unwrap(), "{p}");
    }
    let t = tp();
    std::fs::create_dir_all(&t.p["HOME"]).unwrap();
    let roots = SensitiveRoots::build(&[PathBuf::from(&t.p["HOME"])], &[]);
    let work = PathBuf::from(&t.p["WORK"]);
    for p in strs(&pure["multibyteNoCrash"]) {
        let _ = read_verdict(&p, &ReadCtx { roots: &roots, base: &work, tool: ReadTool::Single });
        let _ = strip_file_url(&p);
    }
    for c in pure["extract"].as_array().unwrap() {
        let params = match c.get("nest").and_then(Value::as_u64) {
            Some(n) => {
                let mut cur = c["inner"].clone();
                for _ in 0..n {
                    cur = json!({"arguments": cur.to_string()});
                }
                cur
            }
            None => tpl_deep(&c["params"]),
        };
        let mut got = extract_read_paths(&params);
        let name = c["n"].as_str().unwrap();
        match &c["e"] {
            Value::Array(_) => {
                let mut exp = strs(&c["e"]);
                got.sort();
                exp.sort();
                assert_eq!(got, exp, "{name}");
            }
            e => {
                if let Some(n) = e.get("len").and_then(Value::as_u64) {
                    assert_eq!(got.len() as u64, n, "{name}");
                }
                for x in e.get("contains").map(strs).unwrap_or_default() {
                    assert!(got.contains(&x), "{name}：{x} 在 {got:?}");
                }
                if let Some(n) = e.get("maxLen").and_then(Value::as_u64) {
                    assert!(got.len() as u64 <= n, "{name}：{got:?}");
                }
                for x in e.get("notContains").map(strs).unwrap_or_default() {
                    assert!(!got.contains(&x), "{name}");
                }
                if e.get("containerLike").and_then(Value::as_bool) == Some(true) {
                    assert!(container_like(&got[0]), "{name}");
                }
            }
        }
    }
    for c in pure["prose"].as_array().unwrap() {
        let got = prose_candidates(c["line"].as_str().unwrap());
        if let Some(e) = c.get("e") {
            assert_eq!(got, strs(e), "{c}");
        }
        for x in c.get("contains").map(strs).unwrap_or_default() {
            assert!(got.contains(&x), "{x} 在 {got:?}");
        }
    }
    assert!(fragments().iter().any(|f| f == "chrome/user data"));
}

/// 工作資料夾、白名單資料夾、寫入資料夾三組彼此不重疊（分在三個不同的放行位置）：各拿掉一組，那一組裡的檔就變成擋下，所以每一組都要真的被收進「自己的資料夾」
#[test]
fn 自己的資料夾_三組資料夾各自守住() {
    use crate::bridge::engines::acp_config::normalize_worker;
    use crate::bridge::engines::acp_worker::own_dirs_of;
    let d = tempfile::tempdir().unwrap();
    let home = d.path().join("home");
    let asn2 = d.path().join("asn2");
    let work = asn2.join("machine-T");
    let (cwd, allow, write) = (home.join(".asn").join("workers").join("甲"), asn2.join("workers").join("甲"), work.join("workers").join("甲"));
    for p in [&cwd, &allow, &write] {
        std::fs::create_dir_all(p).unwrap();
    }
    let ps = |p: &Path| p.display().to_string();
    let raw = json!({"name": "甲", "engine": "acp", "command": "x", "protocol": "acp", "cwd": ps(&cwd), "permissions": {"allow_dirs": [ps(&allow)], "write_dirs": [ps(&write)]}});
    let cfg = normalize_worker(&raw, &work, 0).unwrap().0;
    let env = vec![("ASN_HOME".to_string(), ps(&asn2))];
    let own = own_dirs_of(&cfg);
    assert_eq!(own, vec![cwd.clone(), allow.clone(), write.clone()], "三組都要收進來");
    let check = |dirs: &[PathBuf], probe: &Path| {
        let refs: Vec<&Path> = dirs.iter().map(PathBuf::as_path).collect();
        let roots = roots_for_worker(&env, home.clone(), "甲", &refs, &work);
        read_verdict(&ps(&probe.join("a.md")), &ReadCtx { roots: &roots, base: &cwd, tool: ReadTool::Single })
    };
    for p in [&cwd, &allow, &write] {
        assert_eq!(check(&own, p), ReadVerdict::Allow, "{}", p.display());
    }
    // 對照：少了哪一組，那一組裡的檔就擋下（證明三組互不補位）
    for (i, p) in [&cwd, &allow, &write].into_iter().enumerate() {
        let rest: Vec<PathBuf> = own.iter().enumerate().filter(|(j, _)| *j != i).map(|(_, x)| x.clone()).collect();
        assert_eq!(check(&rest, p), ReadVerdict::Sensitive, "少了 {}", p.display());
    }
}
