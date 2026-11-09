#!/usr/bin/env bash
# 在發行版容器裡建置 wezterm 與 wezterm-mux-server（動態連結系統的 libssl，不內建 OpenSSL），印依賴、做 mux 實測、打包。
# 容器由 workflow 用 docker run 起（原始碼已準備好、Rust 工具鏈由主機掛進來）；不在容器裡跑任何 action。
# 必要環境變數：SCRIPTS（本資料夾）、SRC（原始碼）、OUT（輸出資料夾）、TARBALL（輸出檔名）、IMAGE、RUST_VERSION、UPSTREAM_TAG、UPSTREAM_SHA、PATCH_SHA、RUN_URL
# 選用：DEBIAN_ARCHIVE=1（debian:10 已 EOL，apt 要改指 archive.debian.org）
set -euo pipefail
: "${SCRIPTS:?}" "${SRC:?}" "${OUT:?}" "${TARBALL:?}" "${IMAGE:?}" "${RUST_VERSION:?}" "${UPSTREAM_TAG:?}" "${UPSTREAM_SHA:?}" "${PATCH_SHA:?}" "${RUN_URL:?}"
SUMMARY="${GITHUB_STEP_SUMMARY:-/dev/stdout}"
export DEBIAN_FRONTEND=noninteractive
mkdir -p "$OUT"
git config --global --add safe.directory "*"   # 原始碼資料夾是主機使用者建的，容器裡是 root

if [ "${DEBIAN_ARCHIVE:-}" = 1 ]; then
  # debian:10（buster）已 EOL：主網址已下架，改指 archive.debian.org；archive 的 Release 檔早已過期，要關掉有效期檢查；security 與 updates 這兩列已無內容
  sed -i -e 's|http://deb.debian.org/debian-security|http://archive.debian.org/debian-security|g' \
         -e 's|http://security.debian.org/debian-security|http://archive.debian.org/debian-security|g' \
         -e 's|http://deb.debian.org/debian|http://archive.debian.org/debian|g' /etc/apt/sources.list
  sed -i '/buster-updates/d' /etc/apt/sources.list
  echo 'Acquire::Check-Valid-Until "false";' > /etc/apt/apt.conf.d/99archive
fi

apt-get update -qq
apt-get install -y -qq --no-install-recommends ca-certificates curl git pkg-config make perl procps xz-utils lsb-release >/dev/null
# 上游的相依清單（原樣使用 tag 自帶的 get-deps；容器是 root，沒有 sudo，它會直接呼叫 apt-get）
( cd "$SRC" && SUDO= sh ./get-deps ) > "$OUT/get-deps.log" 2>&1 || { tail -40 "$OUT/get-deps.log"; exit 1; }

export RUSTUP_HOME=/rustup CARGO_HOME=/cargo PATH=/cargo/bin:$PATH
rustc --version | tee "$OUT/rustc-version.txt"
case "$(rustc --version)" in "rustc ${RUST_VERSION} "*) ;; *) echo "::error::Rust 不是 ${RUST_VERSION}" >&2; exit 1;; esac

cd "$SRC"
cargo build --locked --release -p wezterm -p wezterm-mux-server
WEZ="$SRC/target/release/wezterm"; MUX="$SRC/target/release/wezterm-mux-server"

{
  echo "### ${IMAGE}"
  echo
  echo '```'
  "$WEZ" --version
  "$MUX" --version
  echo '```'
  echo
  for b in "$WEZ" "$MUX"; do
    echo "**ldd $(basename "$b")**"
    echo
    echo '```'
    ldd "$b"
    echo '```'
    echo
  done
} | tee -a "$SUMMARY" > "$OUT/versions-and-ldd.txt"
for b in "$WEZ" "$MUX"; do
  if ldd "$b" | grep -q 'not found'; then echo "::error::$(basename "$b") 有找不到的函式庫" >&2; exit 1; fi
done
# 不內建 OpenSSL：應動態連到系統的 libssl／libcrypto
ldd "$MUX" | grep -Eq 'libssl\.so' || { echo "::error::mux-server 沒有動態連到系統的 libssl" >&2; exit 1; }

bash "$SCRIPTS/wezterm-mux-smoke.sh" "$WEZ" "$MUX" "$OUT/smoke"

# ---- 打包：wezterm、wezterm-mux-server、LICENSE.md（上游 tag 原檔）、SOURCE.txt ----
PKG="$OUT/pkg"; rm -rf "$PKG"; mkdir -p "$PKG"
install -m 0755 "$WEZ" "$PKG/wezterm"
install -m 0755 "$MUX" "$PKG/wezterm-mux-server"
git -C "$SRC" show "${UPSTREAM_SHA}:LICENSE.md" > "$PKG/LICENSE.md"
cat > "$PKG/SOURCE.txt" <<TXT
WezTerm ${UPSTREAM_TAG}（ASN 自行建置，只多套用上游 #7706）
上游：https://github.com/wezterm/wezterm  tag ${UPSTREAM_TAG}  commit ${UPSTREAM_SHA}
額外套用：上游 commit ${PATCH_SHA}（#7706，只改 procinfo/src/{linux,macos,windows}.rs）
Rust：${RUST_VERSION}（cargo build --locked --release -p wezterm -p wezterm-mux-server，用 tag 自帶的 Cargo.lock）
建置環境：容器映像 ${IMAGE}（主機 runner：ubuntu-22.04）；動態連結系統的 libssl，沒有內建 OpenSSL
建置紀錄：${RUN_URL}
授權：MIT（見 LICENSE.md，與上游 tag 的 LICENSE.md 逐位元組相同）
TXT
cmp "$PKG/LICENSE.md" <(git -C "$SRC" show "${UPSTREAM_SHA}:LICENSE.md")
( cd "$PKG" && tar --owner=0 --group=0 --numeric-owner --sort=name -cJf "$OUT/$TARBALL" wezterm wezterm-mux-server LICENSE.md SOURCE.txt )
chmod a+r "$OUT/$TARBALL"
tar -tvJf "$OUT/$TARBALL"
sha256sum "$OUT/$TARBALL"
