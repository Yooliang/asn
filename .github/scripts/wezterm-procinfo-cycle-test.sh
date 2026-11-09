#!/usr/bin/env bash
# 父子 PID 形成循環（A 的父是 B、B 的父是 A）時，procinfo 的 build_proc 會不會無限遞迴。
# 只在「測試用的暫時複本」加測試：把真實的程序清單換成一組假的循環清單（只在 cfg(test) 生效），再在檔案尾端加一個測試。
# 發佈用的建置不會經過這裡（那是另一個乾淨的工作樹／之後會還原並重新核對）。
#   綠燈：已套 #7706 的 linux.rs 必須通過，而且那個測試真的有跑。
#   紅燈對照：把 linux.rs 換回上游 tag 原版（沒有修補），同樣的測試必須因為堆疊溢位而失敗；失敗原因不是堆疊溢位也算沒通過。
# 用法：wezterm-procinfo-cycle-test.sh <已套修補的原始碼資料夾>；必要環境變數 UPSTREAM_SHA
set -euo pipefail
SRC="${1:?用法：$0 <原始碼資料夾>}"
: "${UPSTREAM_SHA:?}"
cd "$SRC"
FILE=procinfo/src/linux.rs
LOGDIR="${CYCLE_LOG_DIR:-$PWD/../cycle-logs}"
mkdir -p "$LOGDIR"

inject() {
  python3 - "$FILE" <<'PY'
import sys
p = sys.argv[1]
s = open(p, encoding='utf-8').read()
anchor = "let procs: Vec<_> = all_pids().into_iter().filter_map(info_for_pid).collect();\n"
assert s.count(anchor) == 1, "找不到注入點（上游程式碼變了？）"
fake = '''
        #[cfg(test)]
        let procs: Vec<LinuxStat> = vec![
            LinuxStat { pid: 4000001, name: "a".into(), status: "S".into(), ppid: 4000002, starttime: 0 },
            LinuxStat { pid: 4000002, name: "b".into(), status: "S".into(), ppid: 4000001, starttime: 0 },
        ];
'''
s = s.replace(anchor, anchor + fake)
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
}
'''
open(p, 'w', encoding='utf-8', newline='\n').write(s)
PY
}

run_test() { cargo test --locked -p procinfo --no-default-features parent_child_cycle_terminates -- --nocapture; }

echo "::group::綠燈：已套修補"
inject
if ! run_test 2>&1 | tee "$LOGDIR/green.log"; then
  echo "::error::綠燈失敗：已套修補的版本沒有通過循環測試" >&2; exit 1
fi
grep -q 'linux::cycle_probe::parent_child_cycle_terminates ... ok' "$LOGDIR/green.log" \
  || { echo "::error::綠燈：找不到測試通過的那一行（測試可能根本沒跑）" >&2; exit 1; }
echo "::endgroup::"
git checkout -- "$FILE"

echo "::group::紅燈對照：換回上游原版（沒有修補），預期失敗"
git checkout "$UPSTREAM_SHA" -- "$FILE"
inject
set +e
run_test > "$LOGDIR/red.log" 2>&1
rc=$?
set -e
cat "$LOGDIR/red.log"
echo "::endgroup::"
git checkout HEAD -- "$FILE"   # 還原成已套修補的版本
if [ -n "$(git status --porcelain)" ]; then
  echo "::error::還原後工作樹不乾淨" >&2; git status --short >&2; exit 1
fi
if [ "$rc" -eq 0 ]; then
  echo "::error::紅燈對照沒有失敗：沒套修補的版本竟然通過了，這個測試擋不住循環" >&2; exit 1
fi
grep -Eq 'overflowed its stack|stack overflow' "$LOGDIR/red.log" \
  || { echo "::error::紅燈對照雖然失敗了（結束碼 $rc），但原因不是堆疊溢位" >&2; exit 1; }
echo "紅燈對照如預期：沒套修補的版本因堆疊溢位而失敗（結束碼 $rc）"

{
  echo "### procinfo 循環測試"
  echo
  echo "- 綠燈（已套 #7706）：通過"
  echo "- 紅燈對照（上游原版）：因堆疊溢位失敗，結束碼 $rc（預期要失敗，失敗才算通過）"
  echo
  echo '```'
  grep -E 'overflowed its stack|stack overflow|cycle_probe' "$LOGDIR/green.log" "$LOGDIR/red.log" | head -10
  echo '```'
} >> "${GITHUB_STEP_SUMMARY:-/dev/null}"
