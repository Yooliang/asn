//! 命令列外圍：子命令分派、指令路徑寫法
use super::*;
use crate::cli::{command_path, is_subcommand};
use std::path::Path;

#[test]
fn 子命令判斷_只有第一個參數是_send_recv_room_attach_才算命令列() {
    let v = |a: &[&str]| a.iter().map(|s| s.to_string()).collect::<Vec<_>>();
    for s in ["send", "recv", "room", "attach"] {
        assert!(is_subcommand(&v(&[s, "--x"])));
    }
    assert!(!is_subcommand(&v(&[])) && !is_subcommand(&v(&["--shot", "send"])) && !is_subcommand(&v(&["sendx"])));
}

#[test]
fn 沒有子命令或不認得_印總用法_結束碼_1() {
    let b = backend(200);
    let f = fx(&b.url(), Some("T-視窗甲"));
    let (c, _, err) = go(&f.env, &[], "");
    assert_eq!(c, 1);
    assert!(err.contains("asn send") && err.contains("asn recv") && err.contains("asn room") && err.contains("asn attach"));
    let (c, _, err) = go(&f.env, &["zzz"], "");
    assert_eq!(c, 1);
    assert!(err.contains("不認得的子命令 zzz"));
    let (c, out, _) = go(&f.env, &["--help"], "");
    assert_eq!(c, 0);
    assert!(out.contains("asn send"));
    assert_eq!(b.count(), 0);
}

#[test]
fn 指令路徑_反斜線換斜線_有空白才加引號() {
    assert_eq!(command_path(Path::new(r"C:\Users\x\AppData\Local\ASN\asn-cli.exe")), "C:/Users/x/AppData/Local/ASN/asn-cli.exe");
    assert_eq!(command_path(Path::new(r"C:\Program Files\ASN\asn-cli.exe")), "\"C:/Program Files/ASN/asn-cli.exe\"");
    assert_eq!(command_path(Path::new(r"\\?\C:\a\b.exe")), "C:/a/b.exe");
    assert_eq!(command_path(Path::new("/usr/bin/asn-cli")), "/usr/bin/asn-cli");
}

#[test]
fn 指令前綴_測試用固定值_其餘用執行檔旁邊的_asn_cli() {
    let b = backend(200);
    let f = fx(&b.url(), Some("T-視窗甲"));
    assert_eq!(f.env.prefix("attach").as_deref(), Some("/x/asn-cli attach"));
    let mut e = f.env.clone();
    e.cmd_prefix = None;
    let p = e.prefix("room").unwrap();
    assert!(p.ends_with(" room") && (p.contains("asn-cli") || p.contains("asn")), "{p}");
}
