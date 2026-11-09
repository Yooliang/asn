#!/usr/bin/env bash
# 取 WezTerm 上游原始碼（固定 tag）→ 核對 commit 與 submodule → 只 cherry-pick 上游 #7706 → 核對只動到三個 procinfo 檔。
# 用法：wezterm-src-prepare.sh <目的資料夾>（必須不存在或是空的）
# 必要環境變數：UPSTREAM_TAG、UPSTREAM_SHA（tag 指向的完整 commit）、PATCH_SHA（要 cherry-pick 的完整 commit）
# 任何一項核對不過就以非零結束，不做任何補救。
set -euo pipefail

DEST="${1:?用法：$0 <目的資料夾>}"
: "${UPSTREAM_TAG:?}" "${UPSTREAM_SHA:?}" "${PATCH_SHA:?}"
REPO_URL='https://github.com/wezterm/wezterm.git'
EXPECT_FILES=$'procinfo/src/linux.rs\nprocinfo/src/macos.rs\nprocinfo/src/windows.rs'

mkdir -p "$DEST"
cd "$DEST"
git init -q .
git remote add origin "$REPO_URL"
git config core.autocrlf false   # Windows 的 Git 預設會轉換換行；原始碼要與上游一字不差
git config core.longpaths true
git fetch -q --no-tags --depth=1 origin "refs/tags/${UPSTREAM_TAG}:refs/tags/${UPSTREAM_TAG}"
git -c advice.detachedHead=false checkout -q --detach "refs/tags/${UPSTREAM_TAG}"

head_sha="$(git rev-parse HEAD)"
if [ "$head_sha" != "$UPSTREAM_SHA" ]; then
  echo "::error::tag ${UPSTREAM_TAG} 指到 ${head_sha}，預期是 ${UPSTREAM_SHA}（tag 被移動了）" >&2
  exit 1
fi
echo "tag ${UPSTREAM_TAG} -> ${head_sha}（與預期一致）"

git submodule update --init --recursive --jobs 4
if git submodule status --recursive | grep -q '^[-+U]'; then
  echo "::error::submodule 狀態不乾淨（有 +、- 或 U）：" >&2
  git submodule status --recursive >&2
  exit 1
fi
echo "submodule 都停在 tag 記錄的 commit（$(git submodule status --recursive | wc -l) 個）"

# 取要 cherry-pick 的 commit（含它的上一層，三方合併要用）；git 會以內容核對 SHA，抓到的物件跟 SHA 不符就會失敗
git fetch -q --no-tags --depth=2 origin "$PATCH_SHA"
if [ "$(git rev-parse "${PATCH_SHA}^{commit}")" != "$PATCH_SHA" ]; then
  echo "::error::抓到的 commit 不是 ${PATCH_SHA}" >&2; exit 1
fi
changed_by_patch="$(git diff --name-only "${PATCH_SHA}^" "$PATCH_SHA")"
if [ "$changed_by_patch" != "$EXPECT_FILES" ]; then
  echo "::error::上游修補 ${PATCH_SHA} 動到的檔案不是預期的三個：" >&2
  echo "$changed_by_patch" >&2
  exit 1
fi

git -c user.name='asn-ci' -c user.email='asn-ci@users.noreply.github.com' cherry-pick --no-edit "$PATCH_SHA"

changed="$(git diff --name-only "${UPSTREAM_SHA}..HEAD")"
if [ "$changed" != "$EXPECT_FILES" ]; then
  echo "::error::cherry-pick 之後，和上游 tag 相比被改動的檔案不是剛好那三個：" >&2
  echo "$changed" >&2
  exit 1
fi
git diff --stat "${UPSTREAM_SHA}..HEAD"
if [ -n "$(git status --porcelain --ignore-submodules=none)" ]; then
  echo "::error::cherry-pick 之後工作樹不乾淨" >&2; git status --short >&2; exit 1
fi
echo "PATCHED_HEAD=$(git rev-parse HEAD)"
