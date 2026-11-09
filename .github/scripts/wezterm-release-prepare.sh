#!/usr/bin/env bash
# 發佈與發佈前演練共用：檢查下載回來的產物、取出 LICENSE.md 核對雜湊、產生 SOURCE.txt 與 SHA256SUMS，
# 並把 attest 的 subject-path（dist/*.tar.xz、dist/WezTerm-windows-*.zip）用 shell 展開列出來。
# 用法：wezterm-release-prepare.sh <dist 資料夾>；必要環境變數：UPSTREAM_TAG、UPSTREAM_SHA、PATCH_SHA、RUST_VERSION、LICENSE_SHA256、RUN_URL、COMMIT_SHA、REPO
set -euo pipefail
DIST="${1:?用法：$0 <dist>}"
: "${UPSTREAM_TAG:?}" "${UPSTREAM_SHA:?}" "${PATCH_SHA:?}" "${RUST_VERSION:?}" "${LICENSE_SHA256:?}" "${RUN_URL:?}" "${COMMIT_SHA:?}" "${REPO:?}"
cd "$DIST"
ls -la
[ "$(ls -1 ./*.tar.xz | wc -l)" = 5 ] || { echo "::error::Linux 產物不是 5 個" >&2; exit 1; }
[ "$(ls -1 WezTerm-windows-*.zip | wc -l)" = 1 ] || { echo "::error::Windows 產物不是 1 個" >&2; exit 1; }
for l in Debian10 Debian11 Debian12 Ubuntu20.04 Ubuntu22.04; do
  [ -f "wezterm-${UPSTREAM_TAG}-asn.1.${l}.tar.xz" ] || { echo "::error::缺 ${l} 的包" >&2; exit 1; }
done
unzip -p WezTerm-windows-*.zip LICENSE.md > LICENSE.md
[ "$(sha256sum LICENSE.md | cut -d' ' -f1)" = "$LICENSE_SHA256" ] || { echo "::error::LICENSE.md 雜湊不符" >&2; exit 1; }
cat > SOURCE.txt <<TXT
WezTerm ${UPSTREAM_TAG}（ASN 自行建置，只多套用上游 #7706）
上游：https://github.com/wezterm/wezterm  tag ${UPSTREAM_TAG}  commit ${UPSTREAM_SHA}
額外套用：上游 commit ${PATCH_SHA}（#7706）
Rust：${RUST_VERSION}；cargo build --locked --release
建置紀錄：${RUN_URL}（commit ${COMMIT_SHA}）
驗證：gh attestation verify <檔案> -R ${REPO}
各壓縮檔裡也各有一份 SOURCE.txt，記錄該包自己的建置環境。
TXT
sha256sum ./*.tar.xz WezTerm-windows-*.zip | sed 's# \./# #' > SHA256SUMS
cat SHA256SUMS
{
  echo '### SHA256SUMS'; echo; echo '```'; cat SHA256SUMS; echo '```'; echo
  echo '### attest 的 subject（shell 展開後）'; echo; echo '```'
  ls -1 ./*.tar.xz WezTerm-windows-*.zip | sed 's#^\./#dist/#; t; s#^#dist/#'
  echo '```'
} | tee -a "${GITHUB_STEP_SUMMARY:-/dev/null}"
