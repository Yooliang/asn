#!/usr/bin/env bash
# 父子 PID 形成循環（A 的父是 B、B 的父是 A）時，procinfo 的 build_proc 會不會無限遞迴。
# 只在「測試用的暫時複本」加測試：把真實的程序清單換成一組假的循環清單（只在 cfg(test) 生效），再在檔案尾端加一個測試。
# 發佈用的建置不會經過這裡（那是另一個乾淨的工作樹／之後會還原並重新核對）。
#   綠燈：已套 #7706 的 linux.rs 必須通過，而且那個測試真的有跑。
#   紅燈對照：把 linux.rs 換回上游 tag 原版（沒有修補），同樣的測試必須因為堆疊溢位而失敗；失敗原因不是堆疊溢位也算沒通過。
# 用法：wezterm-procinfo-cycle-test.sh <已套修補的原始碼資料夾> [linux|windows]（預設 linux）；必要環境變數 UPSTREAM_SHA
# windows：把 Snapshot::entries() 的結果換成假的 PROCESSENTRY32W 清單；假 PID 開不起程序，ProcHandle::new 會回 None，build_proc 只用 szExeFile，不會 panic。
set -euo pipefail
SRC="${1:?用法：$0 <原始碼資料夾>}"
: "${UPSTREAM_SHA:?}"
PLATFORM="${2:-linux}"
cd "$SRC"
FILE="procinfo/src/${PLATFORM}.rs"
PY="$(command -v python3 || command -v python)"
LOGDIR="${CYCLE_LOG_DIR:-$PWD/../cycle-logs-${PLATFORM}}"
mkdir -p "$LOGDIR"

inject() {
  "$PY" - "$FILE" "$PLATFORM" <<'PY'
import sys
p = sys.argv[1]
plat = sys.argv[2]
s = open(p, encoding='utf-8').read()
if plat == 'linux':
    anchor = "let procs: Vec<_> = all_pids().into_iter().filter_map(info_for_pid).collect();\n"
    fake = '''
        #[cfg(test)]
        let procs: Vec<LinuxStat> = vec![
            LinuxStat { pid: 4000001, name: "a".into(), status: "S".into(), ppid: 4000002, starttime: 0 },
            LinuxStat { pid: 4000002, name: "b".into(), status: "S".into(), ppid: 4000001, starttime: 0 },
        ];
'''
else:
    anchor = "let procs = Snapshot::entries();\n"
    fake = '''
        #[cfg(test)]
        let procs: Vec<PROCESSENTRY32W> = {
            let mk = |pid: u32, ppid: u32| {
                let mut e: PROCESSENTRY32W = unsafe { std::mem::zeroed() };
                e.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as _;
                e.th32ProcessID = pid;
                e.th32ParentProcessID = ppid;
                e
            };
            if std::env::var("PROCINFO_FAKE").as_deref() == Ok("chain") {
                // 2000 層、不成環的父子鏈：5000001 <- 5000002 <- ... <- 5002000（每個的父是前一個）
                let mut v = vec![mk(5000001, 4999999)];
                for n in 2..=2000u32 {
                    v.push(mk(5000000 + n, 5000000 + n - 1));
                }
                v
            } else if std::env::var("PROCINFO_FAKE").as_deref() == Ok("reuse") {
                // PID 重用（#1914）：根 6000001（啟動 50）底下掛 A=6000002（100，正常）、B=6000003（10，比父早啟動＝原父已結束、PID 被重用）、
                // D=6000005（拿不到時間，照舊接上）；C=6000004 掛在 B 底下（B 不接上，C 也跟著不在樹上）。啟動時間見下面的 proc_start_time 注入。
                vec![mk(6000001, 1), mk(6000002, 6000001), mk(6000003, 6000001), mk(6000004, 6000003), mk(6000005, 6000001)]
            } else {
                vec![mk(4000001, 4000002), mk(4000002, 4000001)]
            }
        };
'''
assert s.count(anchor) == 1, "找不到注入點（上游程式碼變了？）"
s = s.replace(anchor, anchor + fake)
if plat == 'windows':
    # 假的啟動時間（只在 cfg(test) 且 PROCINFO_FAKE=reuse 生效）。沒有 0002 的版本沒有這個函式，就略過（那種版本也不會去查啟動時間）
    hook_anchor = "fn proc_start_time(pid: u32) -> Option<u64> {" + chr(10)
    if hook_anchor in s:
        s = s.replace(hook_anchor, hook_anchor + '''            #[cfg(test)]
            {
                if std::env::var("PROCINFO_FAKE").as_deref() == Ok("reuse") {
                    return match pid {
                        6000001 => Some(50),
                        6000002 => Some(100),
                        6000003 => Some(10),
                        6000004 => Some(20),
                        _ => None,
                    };
                }
            }
''')
s += '''
#[cfg(test)]
mod cycle_probe {
    use super::*;

    fn count(i: &LocalProcessInfo) -> usize {
        1 + i.children.values().map(count).sum::<usize>()
    }

    #[test]
    fn parent_child_cycle_terminates() {
        let info = LocalProcessInfo::with_root_pid(4000001).expect("root");
        assert_eq!(count(&info), 2);
    }

    // 只在 windows 的測試複本有用：長鏈（PROCINFO_FAKE=chain）。迭代修補版：展開到深度 64 就停，共 65 個節點。
    #[test]
    fn long_chain_terminates() {
        let info = LocalProcessInfo::with_root_pid(5000001).expect("root");
        assert_eq!(count(&info), 65);
    }

    // 只在 windows 的測試複本有用：PID 重用（PROCINFO_FAKE=reuse）。B 比父早啟動，不能接在根底下（連同它的子行程 C）；A、D 要在。
    #[test]
    fn pid_reuse_not_attached() {
        let info = LocalProcessInfo::with_root_pid(6000001).expect("root");
        let mut kids: Vec<u32> = info.children.keys().copied().collect();
        kids.sort();
        assert_eq!(kids, vec![6000002, 6000005], "父比子晚啟動的 6000003 不該被接上");
        assert_eq!(count(&info), 3);
    }
}
'''
open(p, 'w', encoding='utf-8', newline='\n').write(s)
if plat == 'windows':
    # procinfo 單獨編譯時 winapi 缺 winbase（上游靠整個 workspace 的 feature 合併才編得過）；只在這個暫時複本補上
    c = open('procinfo/Cargo.toml', encoding='utf-8').read()
    assert c.count('"tlhelp32",') == 1
    open('procinfo/Cargo.toml', 'w', encoding='utf-8', newline='\n').write(c.replace('"tlhelp32",', '"tlhelp32",\n    "winbase",'))
PY
}

run_test() { cargo test --locked -p procinfo --no-default-features parent_child_cycle_terminates -- --nocapture; }
# 長鏈測試要設 PROCINFO_FAKE=chain（只有 windows 用到）；--exact 避免被別的測試名誤匹配
run_reuse_test() { PROCINFO_FAKE=reuse cargo test --locked -p procinfo --no-default-features pid_reuse_not_attached -- --nocapture; }
run_chain_test() { PROCINFO_FAKE=chain cargo test --locked -p procinfo --no-default-features long_chain_terminates -- --nocapture; }

echo "::group::綠燈：已套修補"
inject
if ! run_test 2>&1 | tee "$LOGDIR/green.log"; then
  echo "::error::綠燈失敗：已套修補的版本沒有通過循環測試" >&2; exit 1
fi
grep -q "${PLATFORM}::cycle_probe::parent_child_cycle_terminates ... ok" "$LOGDIR/green.log" \
  || { echo "::error::綠燈：找不到測試通過的那一行（測試可能根本沒跑）" >&2; exit 1; }
echo "::endgroup::"
git checkout -- "$FILE" procinfo/Cargo.toml

echo "::group::紅燈對照：換回上游原版（沒有修補），預期失敗"
git checkout "$UPSTREAM_SHA" -- "$FILE"
inject
set +e
run_test > "$LOGDIR/red.log" 2>&1
rc=$?
set -e
cat "$LOGDIR/red.log"
echo "::endgroup::"
git checkout HEAD -- "$FILE" procinfo/Cargo.toml   # 還原成已套修補的版本
if [ -n "$(git status --porcelain)" ]; then
  echo "::error::還原後工作樹不乾淨" >&2; git status --short >&2; exit 1
fi
if [ "$rc" -eq 0 ]; then
  echo "::error::紅燈對照沒有失敗：沒套修補的版本竟然通過了，這個測試擋不住循環" >&2; exit 1
fi
grep -Eq 'overflowed its stack|stack overflow|STATUS_STACK_OVERFLOW|0xc00000fd' "$LOGDIR/red.log" \
  || { echo "::error::紅燈對照雖然失敗了（結束碼 $rc），但原因不是堆疊溢位" >&2; exit 1; }
echo "紅燈對照如預期：沒套修補的版本因堆疊溢位而失敗（結束碼 $rc）"

{
  echo "### procinfo 循環測試（${PLATFORM}）"
  echo
  echo "- 綠燈（已套 #7706）：通過"
  echo "- 紅燈對照（上游原版）：因堆疊溢位失敗，結束碼 $rc（預期要失敗，失敗才算通過）"
  echo
  echo '```'
  grep -E 'overflowed its stack|stack overflow|cycle_probe' "$LOGDIR/green.log" "$LOGDIR/red.log" | head -10
  echo '```'
} >> "${GITHUB_STEP_SUMMARY:-/dev/null}"

# ---- 長鏈（2000 層、不成環）：只做 windows（Linux 的遞迴不會在 2000 層溢位，紅燈對照做不出來）----
if [ "$PLATFORM" = "windows" ]; then
  echo "::group::長鏈綠燈：已套 #7706 與 ASN 修補"
  # 紅燈對照要「只套 #7706」的版本：用明確的 commit，不靠 HEAD~1（之後多一份 ASN 修補，HEAD~1 就不是它了）。
  # 取「最近一個不是 ASN 修補的 commit」＝cherry-pick 的 #7706，並核對它的標題與上游 PATCH_SHA 相同
  : "${PATCH_SHA:?}"
  ONLY_7706="$(git rev-list --max-count=1 --invert-grep --grep='^asn patch: ' HEAD)"
  [ -n "$ONLY_7706" ] && [ "$ONLY_7706" != "$(git rev-parse HEAD)" ] || { echo "::error::找不到 ASN 修補之前的 commit（HEAD 不是 ASN 修補？）" >&2; exit 1; }
  [ "$(git log -1 --format=%s "$ONLY_7706")" = "$(git log -1 --format=%s "$PATCH_SHA")" ] || { echo "::error::ASN 修補之前的 commit（$ONLY_7706）不是 #7706 的 cherry-pick" >&2; exit 1; }
  [ -z "$(git diff "$ONLY_7706" "$PATCH_SHA" -- "$FILE")" ] || { echo "::error::$ONLY_7706 的 $FILE 和上游 #7706（$PATCH_SHA）不同" >&2; exit 1; }
  inject
  if ! run_chain_test 2>&1 | tee "$LOGDIR/chain-green.log"; then
    echo "::error::長鏈綠燈失敗：已套 ASN 修補的版本沒有通過" >&2; exit 1
  fi
  grep -q "windows::cycle_probe::long_chain_terminates ... ok" "$LOGDIR/chain-green.log"     || { echo "::error::長鏈綠燈：找不到測試通過的那一行（測試可能根本沒跑）" >&2; exit 1; }
  echo "::endgroup::"
  git checkout -- "$FILE" procinfo/Cargo.toml

  echo "::group::長鏈紅燈對照：只套 #7706、不套 ASN 修補（$ONLY_7706），預期堆疊溢位"
  git checkout "$ONLY_7706" -- "$FILE"
  inject
  set +e
  run_chain_test > "$LOGDIR/chain-red.log" 2>&1
  rc2=$?
  set -e
  cat "$LOGDIR/chain-red.log"
  echo "::endgroup::"
  git checkout HEAD -- "$FILE" procinfo/Cargo.toml
  if [ -n "$(git status --porcelain)" ]; then
    echo "::error::長鏈還原後工作樹不乾淨" >&2; git status --short >&2; exit 1
  fi
  [ "$rc2" -ne 0 ] || { echo "::error::長鏈紅燈對照沒有失敗：只套 #7706 的版本竟然通過了" >&2; exit 1; }
  grep -Eq 'overflowed its stack|stack overflow|STATUS_STACK_OVERFLOW|0xc00000fd' "$LOGDIR/chain-red.log"     || { echo "::error::長鏈紅燈對照雖然失敗了（結束碼 $rc2），但原因不是堆疊溢位" >&2; exit 1; }
  echo "長鏈紅燈對照如預期：只套 #7706 的版本因堆疊溢位而失敗（結束碼 $rc2）"
  {
    echo "### procinfo 長鏈測試（windows，2000 層）"
    echo
    echo "- 綠燈（#7706＋ASN 修補）：通過"
    echo "- 紅燈對照（只套 #7706）：因堆疊溢位失敗，結束碼 $rc2"
  } >> "${GITHUB_STEP_SUMMARY:-/dev/null}"

  # ---- PID 重用（#1914）：綠燈＝已套 0002；紅燈對照＝只套到 0001（用明確 commit，不靠 HEAD~1）----
  echo "::group::PID 重用綠燈：已套 #7706、0001、0002"
  ONLY_0001="$(git log -1 --format=%H --grep='^asn patch: 0001' HEAD)"
  [ -n "$ONLY_0001" ] || { echo "::error::找不到 0001 那個 asn patch 的 commit" >&2; exit 1; }
  [ "$(git log -1 --format=%s "$ONLY_0001")" = "asn patch: 0001-procinfo-build-proc-iterative.patch" ] || { echo "::error::$ONLY_0001 不是 0001 的 asn patch" >&2; exit 1; }
  [ "$ONLY_0001" != "$(git rev-parse HEAD)" ] || { echo "::error::HEAD 就是 0001：還沒套 0002，沒有東西可以驗" >&2; exit 1; }
  inject
  if ! run_reuse_test 2>&1 | tee "$LOGDIR/reuse-green.log"; then
    echo "::error::PID 重用綠燈失敗：已套 0002 的版本沒有通過" >&2; exit 1
  fi
  grep -q "windows::cycle_probe::pid_reuse_not_attached ... ok" "$LOGDIR/reuse-green.log"     || { echo "::error::PID 重用綠燈：找不到測試通過的那一行（測試可能根本沒跑）" >&2; exit 1; }
  echo "::endgroup::"
  git checkout -- "$FILE" procinfo/Cargo.toml

  echo "::group::PID 重用紅燈對照：只套到 0001（$ONLY_0001），預期子行程被錯接而斷言失敗"
  git checkout "$ONLY_0001" -- "$FILE"
  inject
  set +e
  run_reuse_test > "$LOGDIR/reuse-red.log" 2>&1
  rc3=$?
  set -e
  cat "$LOGDIR/reuse-red.log"
  echo "::endgroup::"
  git checkout HEAD -- "$FILE" procinfo/Cargo.toml
  if [ -n "$(git status --porcelain)" ]; then
    echo "::error::PID 重用還原後工作樹不乾淨" >&2; git status --short >&2; exit 1
  fi
  [ "$rc3" -ne 0 ] || { echo "::error::PID 重用紅燈對照沒有失敗：只套到 0001 的版本竟然通過了" >&2; exit 1; }
  grep -q "父比子晚啟動的 6000003 不該被接上" "$LOGDIR/reuse-red.log"     || { echo "::error::PID 重用紅燈對照雖然失敗了（結束碼 $rc3），但不是因為子行程被錯接" >&2; exit 1; }
  echo "PID 重用紅燈對照如預期：只套到 0001 的版本把父比子晚啟動的行程錯接上去（結束碼 $rc3）"
  {
    echo "### procinfo PID 重用測試（windows）"
    echo
    echo "- 綠燈（#7706＋0001＋0002）：通過"
    echo "- 紅燈對照（只套到 0001）：子行程被錯接而斷言失敗，結束碼 $rc3"
  } >> "${GITHUB_STEP_SUMMARY:-/dev/null}"
fi
