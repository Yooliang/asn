#!/usr/bin/env bash
# 套 ASN 自己的 WezTerm 修補（#1896）：依 manifest.txt 核對後逐一 git apply 並 commit。
# 用法：wezterm-apply-patches.sh <原始碼資料夾（git repo）> <補丁資料夾（含 manifest.txt）> [聯集輸出檔]
# manifest.txt 每行：<補丁檔名><Tab><會改到的檔案，逗號分隔>；允許 # 註解與空行。
# 任何一項核對不過就以非零結束（::error:: 開頭）。成功時把所有補丁宣告檔案的聯集（排序、去重）印到 stdout，或寫到第三個參數指定的檔；其餘訊息走 stderr。
set -euo pipefail

SRC="${1:?用法：$0 <原始碼資料夾> <補丁資料夾> [聯集輸出檔]}"
PDIR="${2:?用法：$0 <原始碼資料夾> <補丁資料夾> [聯集輸出檔]}"
OUT="${3:-}"
MANIFEST="$PDIR/manifest.txt"
fail() { echo "::error::$*" >&2; exit 1; }

[ -f "$MANIFEST" ] || fail "找不到清單 $MANIFEST"
SRC="$(cd "$SRC" && pwd)"
PDIR="$(cd "$PDIR" && pwd)"

declare -A DECL=()
while IFS= read -r line || [ -n "$line" ]; do
  line="${line%$'\r'}"
  case "$line" in ''|'#'*) continue ;; esac
  case "$line" in *$'\t'*) ;; *) fail "清單格式錯誤（要有 Tab 分隔）：$line" ;; esac
  name="${line%%$'\t'*}"; files="${line#*$'\t'}"
  [ -n "$name" ] && [ -n "$files" ] || fail "清單格式錯誤（檔名或檔案為空）：$line"
  [ -z "${DECL[$name]+x}" ] || fail "清單重複列了 $name"
  DECL[$name]="$(printf '%s' "$files" | tr ',' '\n' | sed 's/^ *//;s/ *$//' | sed '/^$/d' | LC_ALL=C sort -u)"
done < "$MANIFEST"

mapfile -t listed < <(printf '%s\n' "${!DECL[@]}" | sed '/^$/d' | LC_ALL=C sort)
mapfile -t onDisk < <(cd "$PDIR" && ls -1 | grep '\.patch$' | LC_ALL=C sort || true)
[ "${#onDisk[@]}" -gt 0 ] || fail "$PDIR 底下沒有任何 .patch（預期至少有一份）"
for p in "${onDisk[@]}"; do [ -n "${DECL[$p]+x}" ] || fail "補丁 $p 沒有列在 manifest.txt"; done
for p in "${listed[@]}"; do [ -f "$PDIR/$p" ] || fail "manifest.txt 列了 $p，但資料夾裡沒有這個檔"; done

cd "$SRC"
union=""
for p in "${onDisk[@]}"; do
  want="${DECL[$p]}"
  got="$(git apply --numstat "$PDIR/$p" | awk -F'\t' '{print $3}' | LC_ALL=C sort -u)"
  if [ "$got" != "$want" ]; then
    echo "::error::補丁 $p 實際動到的檔案和 manifest 宣告的不同。宣告：" >&2
    echo "$want" >&2; echo "實際（git apply --numstat）：" >&2; echo "$got" >&2
    exit 1
  fi
  echo "套用 ASN 修補：$p" >&2
  git apply --check "$PDIR/$p"
  git apply "$PDIR/$p"
  git add -A
  git -c user.name=asn-ci -c user.email=asn-ci@users.noreply.github.com commit -q -m "asn patch: $p"
  after="$(git diff --name-only HEAD~1 HEAD | LC_ALL=C sort -u)"
  if [ "$after" != "$want" ]; then
    echo "::error::補丁 $p commit 之後實際改動的檔案和宣告的不同。宣告：" >&2
    echo "$want" >&2; echo "實際（git diff HEAD~1 HEAD）：" >&2; echo "$after" >&2
    exit 1
  fi
  union="$union$want"$'\n'
done
union="$(printf '%s' "$union" | sed '/^$/d' | LC_ALL=C sort -u)"
if [ -n "$OUT" ]; then printf '%s\n' "$union" > "$OUT"; else printf '%s\n' "$union"; fi
