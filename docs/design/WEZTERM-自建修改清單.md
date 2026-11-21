# 自建 WezTerm 修改清單

> ASN 附的 WezTerm 是本 repo 的 `.github/workflows/wezterm-build.yml` 自己建的，**不是上游原樣**。這份列出跟上游 tag 不一樣的每一處：改了什麼、為什麼改、對應單號、上游有沒有對應的修正。
> 原則（領隊 11-20）：只維護少量、確實需要的修改。新增或拿掉修改時，同一張 PR 要一起改這份。
> 合上游（換新的上游 tag）時，照最後一節逐項判斷「還要不要帶」。

## 基準

| 項目 | 值 | 位置 |
|---|---|---|
| 上游 tag | `20240203-110809-5046fc22`（commit `5046fc225992db6ba2ef8812743fadfdfe4b184a`） | `wezterm-build.yml` 的 `UPSTREAM_TAG`／`UPSTREAM_SHA` |
| Rust | 1.76.0 | `RUST_VERSION` |
| 發佈後綴 | `asn.N`（release tag `wezterm-<上游 tag>-asn.N`） | `ASN_SUFFIX`／`RELEASE_TAG` |
| ASN 用哪一版 | `relay/asn/scripts/wezterm-pins.json` | Windows 安裝檔附的、Linux 按需下載的都看這份 |

## 原始碼修改

修改依下表順序套用，全部由 `.github/scripts/wezterm-src-prepare.sh` 處理：先 cherry-pick 上游的修正，再套 `patches/wezterm/` 的 ASN 補丁（依檔名排序）。每一步都會核對動到哪些檔，對不上就讓建置失敗。

| # | 修改 | 動到的檔 | 為什麼 | 單號 | 上游有沒有對應修正 |
|---|---|---|---|---|---|
| 1 | cherry-pick 上游 #7706（`29d01fc8e53f4d0fe0c1cf4f31b64b49358a2ff8`）：`build_proc` 加 visited，防父子 PID 成環時無限遞迴 | `procinfo/src/{linux,macos,windows}.rs` | mux-server 堆疊溢位（0xc00000fd）；上游 20240203 沒有這個修正 | #1318 | **有**：上游 main 2026-06-07 合入。換到含這個 commit 的上游 tag 時就不用再 cherry-pick。 |
| 2 | ASN 補丁 `0001-procinfo-build-proc-iterative.patch`：Windows 的 `build_proc` 改成迭代（廣度優先找樹、再由後往前組裝），深度上限 64，超過不再展開並記 `log::warn!` | `procinfo/src/windows.rs` | #7706 只防成環。一條很長、不成環的鏈照樣一路遞迴，工作機崩潰時約 857 層就溢位（dmp 結論見 #1318 issuecomment-7029219309） | #1896（PR #1971） | **沒有**：2026-11-21 查上游 main（最新動到這個檔的 commit 是 `d2f3f05b38`，2026-09-06），`build_proc` 仍然是遞迴。合上游時要確認補丁還套得上，並重跑紅燈測試。 |

- linux.rs、macos.rs 沒有加補丁 2：Linux 主執行緒的堆疊有 8MB，2000 層也不會溢位，做不出紅燈對照，目前也沒有崩潰實例。要改請另開單、先拿到證據。
- 每份 ASN 補丁會動到哪些檔，宣告在 `patches/wezterm/manifest.txt`；`wezterm-apply-patches.sh` 會逐份核對：套用前比對 `git apply --numstat`，commit 之後比對 diff。
- 「父行程啟動時間要早於子行程」（擋 PID 被重用接錯父行程）是另一項修改，單號 #1914，還沒做。做了之後要加進上表。

## 建置設定（不改原始碼）

| 設定 | 為什麼 | 單號 |
|---|---|---|
| `cargo build --locked --release -p wezterm -p wezterm-gui -p wezterm-mux-server`，用 tag 自帶的 Cargo.lock | 跟上游鎖定的依賴一致 | — |
| Windows 建置設 `CARGO_PROFILE_RELEASE_DEBUG=line-tables-only`，同一次建置產生帶行號的 PDB，存成 artifact `pdb-windows-…`（保留 90 天，不進 release） | 之前發佈版沒附 PDB，只能另外重建再比對位元組，也拿不到行號 | #1896（PR #1985） |

## 不是我們建的檔

`conpty.dll`、`OpenConsole.exe`、`libEGL.dll`、`libGLESv2.dll` 直接取自上游 repo 的 `assets/windows`，沒有重建。建置時會跟官方壓縮檔裡的同名檔逐一比對 SHA-256。

## 驗證（守門）

| 守什麼 | 在哪 |
|---|---|
| 成環不會無限遞迴（綠燈）；只有上游 tag 原版會溢位（紅燈對照） | `.github/scripts/wezterm-procinfo-cycle-test.sh`（Linux、Windows） |
| 2000 層長鏈：套了補丁 2 會停在 64 層（綠燈）；只套 #7706 會溢位（紅燈對照） | 同上，只有 Windows（`PROCINFO_FAKE=chain`） |
| 補丁和 manifest 一一對應，動到的檔等於宣告 | `relay/asn/test/wezterm-apply-patches.test.mjs` |
| PDB 有產生、對得上 exe、不會被撿進 release | `relay/asn/test/wezterm-pdb-artifact.test.mjs` |

## 合上游時的步驟

1. 換 `UPSTREAM_TAG`／`UPSTREAM_SHA`，同步更新 `wezterm-pins.json`，並換新的 `ASN_SUFFIX`。
2. 逐項看上面的「原始碼修改」：
   - 上游已經有對應修正的（例如新 tag 含 #7706），就拿掉那一項，並更新 `wezterm-src-prepare.sh` 的 `PATCH_SHA` 與 `EXPECT_FILES`。
   - 上游沒有的，確認 `git apply --check` 還過得去；過不去就依新原始碼重做補丁，manifest 一起改。
3. 重跑 `wezterm-build.yml`。cycle-test 的紅燈對照必須仍然會紅：如果新的上游本身就不會溢位，代表那個補丁可以拿掉了。
4. 這份清單、`SOURCE.txt` 與 release 說明（在 workflow 裡），以及 `fetch-wezterm.mjs` 的說明文字，要在同一張 PR 一起更新。
