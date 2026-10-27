# 開發與發版交接（asn西川 → asn雯，2026-10-27）

給接手「開發、合併、發版」這個位置的人。沒有任何金鑰在這份文件裡。

## 一、位置與規矩
- **誰做什麼**：asn真 領隊排優先序；開發（合併、發版）= 你；Gemini審查 = 外部唯讀審查員（審查副本 `<審查副本>`，家用機上，我把 diff 放它的 `_patches\`）；ASN-開發（Grok 雲端）= 會議召集人。
- **合併規則**（`docs/TEAM-FLOW.md`）：夥伴互審過就自己合併、發版，小良哥只定產品方向。**合併前一定核對 PR head 的完整 SHA 等於審查核可的 SHA**（我曾經沒核對就合，被糾正過）；別人在 PR 上留的意見要先處理完。疊在別的 PR 上的 PR，合併前先改目標分支成 main，不然內容不會進主線。
- 終端送字／代答這類 PR，審查要逐條走過「電腦確認、手機確認、手機拒絕、過期、取消、換分頁」六種結束方式。
- 對小良哥說話：中文、短、不要貼長串；結論與編號就好，細節寫 issue／PR。不確定的事就說不確定，**沒實測就講沒實測**。
- 不碰 `~/.asn` 底下內容（金鑰在那）。不用整批 taskkill，只關自己記下 PID 的程序。倉庫改成公開、刪資料這類不可回復的事，要小良哥明說才做。

## 二、發版流程（每一版都這樣）
在 `relay/asn` 底下：
1. 合併已核可的 PR（`git fetch origin pull/N/head:prN`，核對 SHA，`git merge --no-ff`），跑 `npm test`（前端）與 `cd src-tauri && cargo test --lib`（Rust）。前端有 2 項「缺口」測試（Codex／pi 能關閉）一直是紅的，是刻意標記的缺口，不是你弄壞的。
2. `npm run release -- --notes "<中文更新說明>"`（桌面版；會自動升版號、打包、簽章）。如果手機端有改，再跑 `npm run release:android -- --notes "…"` 與 `npm run release:play -- --upload`（安卓需要環境變數：`JAVA_HOME`＝Android Studio 的 jbr、`ANDROID_HOME`＝Sdk、`NDK_HOME`＝Sdk\ndk\28.2.13676358）。
3. 官網內容：藍圖、待辦、支援總表、發版與會議記錄都在資料庫（`public.asn_site_*`，寫法見 `site/README.md`），**發版不用再改官網頁面**。發完用 `asn-cli site release --version <版本> --date <YYYY-MM-DD> --commit <短碼> --item "…" --platform 官網 --platform 家用機` 加這一版，再用 `asn-cli site item --key <項目代號> --status released --version <版本>` 把待辦的狀態更新（`npm run release` 結束時會印出這行指令；用法見 `site/README.md`）。只有在官網寫入名單（`relay.site_writers`，以帳號／租戶為單位）上的帳號能寫，名單要有專案負責人的租戶。支援總表這一期還沒有指令，仍由維護者下 SQL。只有改了選單或版面才需要 `node site/make-layout.mjs` 與 `node --test tests/site_layout.test.mjs`。
4. 提交版本檔與 `site/public/update/*`，推上去；`cd site && npx firebase-tools deploy --only hosting`（很慢，丟背景跑，跑完用 `curl https://asnmessenger.web.app/update/latest.json` 確認版本）。
5. 在自己這台安裝：先**只關自己記下的 ASN 程序**，再 `MSYS_NO_PATHCONV=1 ./ASN_<版本>_x64-setup.exe /S`（Git Bash 會把 `/S` 當路徑，必須加那個環境變數），然後用 PowerShell `Start-Process "$env:LOCALAPPDATA\ASN\asn.exe"` 啟動。
6. 在群組貼：版本、主線 commit、合併了哪些 PR（含 SHA）、測試數、沒驗證的事。

踩過的坑：
- `release` 會依 `package.json` 升版；如果合併後又要補東西，先 `git checkout -- relay site/public` 還原版本檔再重跑，不然會跳版。
- 測試用 `CARGO_TARGET_DIR=<共用的 target 資料夾>`（共用編譯快取，快很多）。
- 新增 `Command::new` 一定要 `.no_window()`（有守門測試），電腦版專用模組要掛 `#[cfg(desktop)]`（安卓建置會壞，我犯過）。
- 樣板用到的名字要從 `setup()` return（`test/template-ctx.test.mjs` 會檢查）。

## 三、這一輪做完的（0.1.80～0.1.92）
手機遠端確認送字（#317/#318，含撤回、收確認列、防重送）、終端放進名單與對話分頁（#331）、開新夥伴兩頁流程與「運行」四選一（內建通道 ＞ 經 pi ＞ ASN 開的終端 ＞ 自己開的 CLI，自己開的永遠不能選）、經 pi 帶提供者與模型、pi 模型清單後端、額度一鍵接上 Claude 狀態列（#228）、活躍度分組（#347）、頭像並排廠商小圖第一期（#356）、納入管理進對話窗「管理」選單、ACP 權限 `write_dirs`、收信更耐壞（#375/#376）、README 支援表。

## 四、手上還沒收尾的
- **工作機連線中斷（#339）**：0.1.92 應該修好（asn真 的分析：工作機代收區 437 封＋後台 62 封，一次 ack 約 500 個編號超過 100 的上限）。請確認工作機裝上 0.1.92 後的狀況；asn真 提議 0.1.93 把主視窗記錄寫進檔案（`ui.log`），目前記錄只進 console，無法事後查。
- **ACP 切換模型（#235）與改名（#266）**：兩個都是後端、動到夥伴身分與持久化，**我還沒開始、設計也沒寫**。#266 的 session 回報（名單帶 session）其實已經有了（`bridge/engines/acp.rs` 的 `window_of`），缺的是 `AcpAdmin::rename`：驗新名字、搬 `Store` 的 key、改 `acp-workers.json`／接手名冊（`acp-adopted.json`）、換 `workers` 的 key 與 cfg、重啟工作者保留對話；先寫設計到 issue 給 asn真／Gemini 看再動手。
- **#343 引導頁**：額度、pi 登入、Claude 外掛放進引導，與「啟動設定」整合；入口卡片邏輯可沿用 `ui/lib/quota-hook.mjs`、`pi-setup.mjs`。
- **真機驗證欠帳**：從 ASN 開新夥伴對話框選「經 pi」實開一次，看開出來的 pi 用的是不是選到的模型（我只用 `pi -p --provider deepseek --model deepseek-flash` 驗證了 pi 本身接受旗標，ASN 這條路沒點過）；額度接上後 Claude 狀態列有沒有照常顯示（Windows 用哪個 shell 跑狀態列我沒實測）；`~/.asn/agents.json` 的 Gemini審查 write_dirs 要小良哥改。
- **A9（忙碌時連送兩則的佇列行為）**：只實測了 Grok（自己會排隊）；Claude、agy 測試台打不開，沒結果，#319 維持暫停。
- **issue**：#374（電腦版設定頁顯示額度進度條）、#371／#372 等小良哥說要做才排、#373 工作機換手回 403。
- **公開前清單 #326**：授權用 MIT（已進主線）；倉庫轉公開要小良哥明說；公開第一件事建分支保護（禁止強制推送與刪除）。

## 五、資料與位置速查
- Supabase 專案 ref `etccgmkrosbzpltudlgt`，唯讀查詢：`cd supabase && npx supabase db query --linked --project-ref etccgmkrosbzpltudlgt "<SQL>"`（只看時間與狀態，不要選金鑰欄位、不要看信件內文）。
- 官網 https://asnmessenger.web.app；Firebase 專案 `asnmessenger`。
- 家用機 ASN 安裝在 `%LOCALAPPDATA%\ASN`（含 `asn-cli.exe`、`wezterm`）。
- pi 1.4.0：`pi --list-models` 只列已設憑證的提供者；`pi auth check --provider X --json --no-refresh` 不會印憑證；Qwen 這版沒有。
