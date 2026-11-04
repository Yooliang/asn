#!/bin/bash
S=/c/Users/cwen0708/AppData/Local/Temp/claude/a95c5df0d0e2737f/f11bf022-ab34-493d-94be-cfdc12424e3a/scratchpad
cd /d/Github/Yooliang/asn-15q/relay/asn/src-tauri || exit 1
export ASN_WEZTERM_DIR="$(cygpath -w /c/Users/cwen0708/AppData/Local/ASN/wezterm)"
export ASN_15Q_CLAUDE_MODE=$1
export ASN_15Q_FLAGS="$(cygpath -w $S/$2)"
T=$(ls -t target/debug/deps/asn_lib-*.exe | head -1)
"$T" "live_mux::真_claude" --ignored --nocapture --test-threads=1 2>&1 | grep -E "RESULT|panicked|test result|無法" | cut -c1-200
