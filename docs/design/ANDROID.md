# 安卓版 ASN 設計筆記（#158 第一期）

目標：同一份 Tauri 2 程式、同一份前端（`relay/asn/ui/`），多一個安卓建置，出可安裝的 APK。**套件名 `tw.yooliang.asn`，上架後不能改**。

第一期做的事：登入、名單、對話、寄信、收檔案與照片、震動（對方傳來的「震動」讓手機震動）；打開 App 才收信。
第一期**不做**：推播（第二期，FCM）、偽通話（#99，後來在第十七節做了）、上架（第三期）、遠端操作（遠端更新、切換模型、看子代理）。手機版也永遠不做：內建收發室橋、開 Claude／Codex 視窗、密碼小幫手、用量分頁、本機的 Claude 帳號管理（加入、切換、刪除；替「別台電腦」切換帳號例外，見第二十節）、聽歌狀態、系統匣、截圖與語音輸入（這些是電腦端功能；手機的「通話」另走系統內建的語音，見第十七節）。

## 一、共用與隔開

原則：**能共用就共用，電腦端的東西用編譯條件隔開，電腦版一個字不變。**

| 層 | 共用 | 只有電腦版 | 只有手機版 |
| --- | --- | --- | --- |
| Rust（`src-tauri/src/`） | 收寄信（`relay`）、登入與權杖（`auth`、`account`）、附件（`attach`）、大頭貼、門鈴（`bell`）、心跳與改名、`identity` | `bridge`、`launch`、`askpass`、`cli`、`claude_*`、`codex_accounts`、`acct_remote`、`usage`、`tray`、`updater`、`wins`（多視窗）、`shot`、`stt`／`tts`／`voicecfg`、`ads`、`agent_tools`、`cloud_invite` | `android`（私有資料夾、開瀏覽器、收到的檔案）、`appdir`（算私有資料夾，電腦上也能測） |
| 前端（`ui/`） | `lib/core.mjs`（收寄信與記錄）、`lib/chatpane.mjs`（對話版面）、頭像、照片、文字、登入文字 | `list.html`／`chat.html`／`login.html` 等多視窗頁面與設定面板 | `m.html`、`m.js`、`mobile.css`、`lib/mobile.mjs`（單欄、導覽、提示規則、外殼橋） |
| 殼 | — | Windows／Linux 打包 | `src-tauri/gen/android/`（Kotlin 外殼 `MainActivity`、`AsnBridge`） |

隔開的方式：

- **模組**：`lib.rs` 把每個電腦端模組宣告成 `#[cfg(desktop)] mod …;`（`desktop` 是 Tauri 建置時給的條件，手機是 `mobile`）。手機建置根本不編譯它們。
- **指令**：電腦版的 `generate_handler!` 清單不動；手機另有一份短清單（`#[cfg(not(desktop))]`），只有名單與對話需要的指令。電腦端指令在手機上不存在，叫了只會得到「找不到指令」。
- **相依套件**：`Cargo.toml` 把系統匣（`tray-icon`）、自動更新、系統內建的加密連線（`native-tls`）放在 `cfg(not(target_os = "android"))`；安卓改用純 Rust 的加密連線（`rustls`，不用交叉編譯 OpenSSL）和「開網址」外掛。
- **設定**：`tauri.android.conf.json` 會自動疊在 `tauri.conf.json` 上：套件名、單一視窗（首頁 `m.html`）、不帶電腦端的打包資源與更新器。電腦版設定檔沒改。
- **畫面**：手機用另一個首頁 `m.html`，裡面**根本沒有**電腦端設定與按鈕（不是藏起來）；對話區共用 `ChatPane`，不傳功能列、語音、截圖三個屬性就沒有那些按鈕。唯一改到共用元件的地方：`ChatPane` 多一個屬性 `enterSends`（預設 `true`，電腦行為不變），手機傳 `false`，因為軟鍵盤的 Enter 是換行、傳送靠按鈕。
- **守門測試**：`test/android.test.mjs` 檢查以上每一條（模組有掛條件、手機指令清單沒有電腦端指令、手機畫面不叫電腦端指令、套件名、權限、備份關閉……）；`test/mobile.test.mjs` 測手機的純邏輯。

## 二、身分與資料夾

電腦靠 `~/.asn/<節點>.key` 認節點；手機沒有使用者資料夾，一律放在 **App 私有資料夾**（`/data/user/<使用者編號>/tw.yooliang.asn/files`，別的 App 讀不到，檔案另設 0600）：

- 節點金鑰、節點代號、登入存檔、對話記錄、設定都在 `files/.asn`、`files/.irori-asn` 底下（沿用電腦版的檔名與格式，所以 Rust 端的身分判定不用分平台）。
- 資料夾位置由 `appdir.rs` 算：套件名取 `/proc/self/cmdline`，使用者編號取 uid ÷ 100000；讀不到時退回主要使用者與預設套件名。
- 第一次打開沒有節點金鑰：登入 → 後台替這支手機建節點（電腦版同一條路：`account_bootstrap`＋`node_create`，名字預設「我的手機」）→ 存好金鑰。電腦版這時會自動重新啟動；**安卓行程不能自己重啟**，所以由畫面請外殼（`AsnBridge.relaunch`：先叫起新的 App，再結束舊行程）重開。外殼不在（例如在一般瀏覽器）就提示使用者自己重開。
- `android:allowBackup="false"`：不讓系統備份把節點金鑰與登入存檔帶到別支手機（會變成兩支手機共用一把節點金鑰）。

## 三、登入（手機怎麼做）

沿用電腦版的流程，只換「開瀏覽器」與「回到 App」：

1. 畫面按「用 Google 登入／用 GitHub 登入」→ Rust 產生 PKCE 驗證碼與 state，在本機回送位址（`127.0.0.1:49200～49219`，與電腦版同一組埠）開一個只收一次回呼的小伺服器。
2. 用「開網址」外掛（系統的 Intent，會開預設瀏覽器）開後台的授權網址。
3. 使用者在瀏覽器完成登入 → 後台把瀏覽器導回 `http://127.0.0.1:<埠>/callback?code=…&state=…` → 本機小伺服器驗 state、收授權碼、回一張完成頁。
4. **完成頁（安卓版）帶使用者回 App**：頁面先用轉址、不行再用大按鈕（`intent://login-done#Intent;scheme=tw.yooliang.asn;package=tw.yooliang.asn;end`）喚起 `MainActivity`（`AndroidManifest.xml` 裡 `tw.yooliang.asn://login-done` 的 intent-filter）。這個網址不帶任何權杖或授權碼，只是叫 App 回到前景。
5. Rust 用授權碼＋驗證碼換權杖，存取憑證只放記憶體，更新憑證存檔。

為什麼用「本機回送位址」而不是自訂網址協定直接當回呼：後台（Supabase）的轉址白名單現在列的就是 `http://127.0.0.1:49200～49219/callback`，沿用代表**後台設定一個字都不用改、不用部署**；電腦版與手機版同一套程式、同一套測試。代價是瀏覽器要連回本機小伺服器，所以登入的幾十秒內 App 行程必須活著（前景離開到瀏覽器的短時間內，安卓不會凍結它）。

**權杖存放與限制（照實寫）**：

- 更新憑證存在 App 私有資料夾的 `login.bin`（非 Windows 的做法：不另外加密、0600 權限）；存取憑證只在記憶體。受保護的依據是安卓的 App 沙盒與整機儲存加密（檔案型加密，手機解鎖前讀不到）。
- **沒有**用 Android Keystore 再包一層：Tauri 沒有官方的 Keystore 外掛，第三方外掛維護狀況不明，第一期不引入。已經 root 的手機、或能取得本 App 私有資料夾的惡意程式，就讀得到更新憑證。
- 補強已做：關閉系統備份、權杖與金鑰不進 log 也不傳給前端、網頁畫面只拿得到「有沒有登入、email」。
- 之後要補（第三期上架前評估）：寫一個小 Kotlin 外掛，用 Keystore 產生的金鑰加密 `login.bin` 與節點金鑰檔。

## 四、收信（打開 App 才收）

- 前景時：和電腦版相同的輪詢（收信 2 分鐘、名單 1 分鐘、已讀狀態 15 秒），加上門鈴（Realtime，一響就拉）。
- 回到前景（`visibilitychange`）：立刻拉一次信、更新名單、補正在看的那位的往來記錄。
- 背景時：Android 會凍結行程，**不收信、不推播**（這是第一期明確的取捨）。收發室會把信留著，下次打開 App 一次收到；扇出回信若這支手機超過 3 分鐘沒回報在線，會寄給帳號底下其他設備，打開對話時用往來記錄補看（#108 的既有行為）。
- 第二期：FCM 推播（後台收到寄給本人的信時發推播），到時才會有鎖屏通知。

## 五、「我」＝登入帳號（#108）

手機的寄信與電腦版走同一條 Rust 路徑：

- `relay_send`／`relay_send_attachment` 取登入憑證，寄信帶本人簽章與 `as_person`（`AsnCore` 的 `#personFlag` 不分平台）；沒登入時憑證為空，後台不認 `as_person`，照舊以視窗名寄出。
- 打開對話呼叫 `chat_history`（`relay_chat_history`），向後台補「我和這位夥伴」90 天內的往來（本機只當快取）；收到扇出回信後也會補一次。
- 手機這支裝置自己是帳號底下的一個節點、有自己的視窗名（預設「我的手機-ASN」，在「我」分頁改暱稱就是改對外名字，不顯示節點代號）。

## 六、檔案、照片、震動

- **傳照片**：沿用 `ChatPane` 的選圖（`<input type=file>`，安卓會讓使用者選相簿或相機），前端壓成 webp（長邊 2048、≤ 5 MB）後由 Rust 上傳寄出。**傳檔案**（pdf、txt、md、json、csv、zip、docx、xlsx、pptx，單檔 25 MB 內）同電腦版。
- **收照片**：縮圖在對話裡，點開放大（Rust 換短效網址、下載、檢查，回 data URL）。
- **收檔案／另存**：手機沒有「另存新檔」對話框。Rust 把檔案下載到 App 私有資料夾的 `received/`，外殼（`AsnBridge.exportFile`）再複製到系統的 **「下載/ASN」**（MediaStore，不用儲存權限；Android 9 以下因為要儲存權限而不支援，會明講）；畫面顯示「已存到：下載/ASN/檔名」，「開啟資料夾」打開系統的下載清單。
- **震動**：對方傳來「震動」→ 手機震動兩下（`AsnBridge.vibrate`，用系統震動器，不受「網頁沒有點擊動作就不准震」的限制），正在看的對話畫面抖一下；自己按「傳送震動」鈕與電腦版相同。「我」分頁有兩個開關：對方傳震動時震（預設開）、收到新訊息時輕輕震（預設關）。

## 七、手機版面

單欄、直式、觸控目標至少 44px、輸入字級 16px（不會被放大）。沿用 MSN 的 Aero 玻璃配色。

- **名單**（首頁）：上方是自己的大頭貼、連線狀態、重新整理；搜尋框；全部夥伴依設備分組（本機那組在最前，可收合；組內線上在前）；底下兩個分頁「名單」「我」。
- **對話**：第二個大分頁就是「最後使用的那一位」的單一對話（不是列表）：點夥伴分頁的某位，那位成為最後使用（記在手機本機設定 `lastChat`，重開 App 仍記得）並切到對話分頁；從來沒開過顯示「從夥伴分頁點一位開始對話」。上方是那位的頭像、名字、狀態與右上角「⋯」（管理夥伴視窗，見 PARTNER-OPS.md 第四節）；下面是訊息、工具列、輸入框與傳送鈕。系統返回鍵：分頁間互換不增加瀏覽記錄，夥伴分頁出去才推一筆。
- **我**：大頭貼（點一下換）、暱稱、狀態、個人訊息、震動開關、登入的帳號與「登出」、版本。
- **提示**：不在這位的對話時，來信會在畫面頂端跳橫幅（點了進去）；系統層級的通知列留給第二期的推播。
- **外殼**：邊到邊顯示（Android 15 起強制）；`MainActivity` 把狀態列、導覽列、鍵盤的高度用內距讓出來，輸入框不會被鍵盤蓋住。

## 八、工具鏈與建置

這台（Windows）原有：Android SDK（`%LOCALAPPDATA%\Android\Sdk`，平台 34～36、build-tools 34～36）、NDK `28.2.13676358`、Android Studio 內建的 JBR 21。第一期補裝／下載的：

- Rust 的四個安卓目標：`rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android`
- Gradle 9.6.1（由專案的 `gradlew` 自動下載到使用者的 `.gradle`）、Android Gradle 外掛 9.3.1、Kotlin 2.2.10（Gradle 依 `gen/android` 的設定自動下載）
- 沒有裝 `cmdline-tools`／`sdkmanager`（用不到）。`compileSdk`／`targetSdk` 設成 **36**（Tauri 預設的 37 這台沒有）；Google Play 現在要求 targetSdk 35 以上，36 符合。`minSdk` 26。

環境變數（PowerShell）：

```
$env:JAVA_HOME    = "C:\Program Files\Android\Android Studio\jbr"
$env:ANDROID_HOME = "$env:LOCALAPPDATA\Android\Sdk"
$env:NDK_HOME     = "$env:ANDROID_HOME\ndk\28.2.13676358"
```

出除錯版 APK（**只用除錯簽章**，不帶正式簽章金鑰；第三期處理）：

```
cd relay/asn
npm ci
npx tauri android build --apk --debug --target aarch64     # 手機（arm64）
# 要裝在 x86_64 模擬器：--target x86_64；四種都要（體積大）就不加 --target
```

APK 在 `src-tauri/gen/android/app/build/outputs/apk/universal/debug/` 底下。開發時 `npx tauri android dev` 會裝到連線的手機或模擬器（本期沒有做這件事）。

`src-tauri/gen/android/` **進 git**（Tauri 的慣例）：我們改過 `AndroidManifest.xml`（權限、關閉備份、登入回來的網址協定）、`MainActivity.kt`、新增 `AsnBridge.kt`、把 `compileSdk`／`targetSdk` 改成 36。它自己的 `.gitignore` 擋掉建置輸出與本機設定；`src-tauri/gen/schemas/` 仍不進 git。重新執行 `tauri android init` 會覆蓋這些檔案，要用 git 還原我們的修改。

`Cargo.toml` 的 `[lib]` 改成 `crate-type = ["cdylib", "rlib"]`（安卓要載入 `libasn_lib.so`）。電腦版仍從 rlib 連進執行檔，行為不變，只是 `cargo build` 多產生一個 `asn_lib.dll`／`.so`。

## 九、已知限制（第一期）

- 背景不收信、沒有通知列提示（推播留第二期）。
- 權杖與節點金鑰沒有用 Keystore 再加密（見第三節）。
- 收到的檔案要 Android 10 以上才能放進「下載/ASN」。
- 沒有「開新夥伴」「切換模型」「看子代理」「遠端更新」等遠端操作；沒有語音輸入、念出訊息、截圖標註。
- 登入要瀏覽器連回本機小伺服器：登入途中把 App 殺掉、或手機的省電設定在幾十秒內凍結了 App，登入會逾時（5 分鐘），重按即可。
- 本期**沒有在真機或模擬器上跑過**（任務規定不啟動模擬器、不安裝到裝置）：Rust 能編譯、APK 能組出來、靜態與純邏輯測試全過，但畫面與外殼的實際行為要真機驗，見下一節。

## 十、需要真機驗的事

1. 安裝 APK、開啟：看到登入畫面，不閃退。
2. 按「用 Google 登入」：開出瀏覽器；登入完成後頁面自動（或按大按鈕）回到 ASN；畫面接著設定手機並**自動重新開啟**，進到名單，名單裡看得到其他設備的夥伴。
3. 名單：分組可收合、搜尋可用、點進對話；返回鍵（系統）從對話回到名單，名單再按退到背景。
4. 對話：輸入框不被鍵盤蓋住；傳送鈕送出；Enter 是換行；對方回信後出現；打開對話補到 90 天往來；多設備（電腦、手機）看到同一個「我」。
5. 照片：選相簿／拍照傳出，對方收到；收到的照片點開放大。
6. 檔案：收到 pdf 後點「下載並另存」，「下載/ASN」資料夾出現檔案；「開啟資料夾」打得開。
7. 震動：對方傳震動，手機震動兩下並抖畫面；自己按「傳送震動」鈕對方收到。
8. 切到別的 App 再回來：立刻補收信；關掉 App 重開，仍是登入狀態。
9. 「我」分頁：改暱稱、換大頭貼、改狀態、登出後回到登入畫面。
10. 登入途中取消（按取消）能重來。

## 十一、第二、三期

- 第二期：FCM 推播（鎖屏收得到；後台收到寄給本人的信時發推播；Firebase 專案 `asnmessenger` 已存在）。偽通話（#99）已提前做了（第十七節）。到時要加 Kotlin 推播服務、通知權限（Android 13 起要問）、後台記錄手機的推播代碼。
- 第三期：正式簽章金鑰、隱私權政策（要寫手機版蒐集什麼）、商店頁素材、內部測試軌道 → 正式；評估 Keystore 加密；`versionCode` 依 `tauri.conf.json` 的版本自動算。

## 十二、自動更新（自行安裝版）

上架 Google Play 之前，APK 從官網下載自行安裝，所以 App 自己檢查更新。**Google Play 版不含這套**（Play 政策不允許 App 自己更新）。

**兩種發行管道（建置時決定，程式碼與權限都分開）**

| | 自行安裝版（sideload） | Google Play 版（play，預設） |
| --- | --- | --- |
| Rust | `--features sideload`：編進更新清單檢查、下載、驗 sha256 | 不開旗標：檢查指令只回 `enabled: false`、下載指令回「這個版本不提供自動更新」，下載與驗證程式碼不編進去 |
| 外殼（Kotlin） | `src/sideload/java/…/SelfUpdate.kt`：叫系統安裝程式 | `src/play/java/…/SelfUpdate.kt`：空殼 |
| 權限 | `REQUEST_INSTALL_PACKAGES` | 沒有 |
| 畫面 | 更新橫幅、「我」分頁的「自動檢查新版本」與「檢查更新」 | 不出現（外殼回報沒有更新功能） |

Gradle 以環境變數 `ORG_GRADLE_PROJECT_asnDist=sideload` 選管道（不設＝play），Rust 以 `--features sideload` 對應。`npm run release:android` 兩個都會帶。

**流程**

1. App 啟動時與每 6 小時（「我」分頁可關閉自動檢查）向 `https://asnmessenger.web.app/update/android.json` 取更新清單。
2. 清單的版本碼比現在大才算有新版：頂端橫幅「有新版本 x.y.z：<說明第一行>」與「更新」鈕。**按了才下載**，橫幅顯示進度。
3. Rust 端重新抓清單、依清單網址下載到 App 私有資料夾（`.irori-asn/updates/`），邊下載邊算 sha256；**對不上就刪檔、顯示錯誤、不安裝**。
4. 通過後交給外殼用 FileProvider 叫出系統安裝畫面。第一次沒有「安裝未知應用程式」許可：外殼先開啟該許可的設定頁，橫幅提示「請在接下來的畫面允許 ASN 安裝應用程式，回來後再按一次『更新』」。

**android.json 格式**（官網新檔）：`{ "version", "versionCode", "url", "sha256", "notes", "bytes" }`。App 端嚴格檢查：版本碼必須等於由版本號算出的值、sha256 為 64 位小寫十六進位、`url` 必須是官網 `update/` 底下的 https、檔案不超過 200 MB、清單不超過 64 KB；任何一項不合就整份拒絕。測試用：只有帶本機回送網址（`http://127.0.0.1:…`）時才收回送位址，畫面不會自己帶。

**versionCode 規則**：與 Tauri 相同，主版 × 1,000,000 ＋ 次版 × 1,000 ＋ 修訂（0.1.32 → 1032），單調遞增；次版、修訂不可超過 999。發版腳本與 App 端各有一份同樣的算法，各有測試。

**發版**：先發電腦版（`npm run release`），再在同一版本號下跑 `npm run release:android`（需要 JAVA_HOME、ANDROID_HOME、NDK_HOME 與四個 Rust 安卓目標）。它會：建 release APK（只有 arm64）→ zipalign → 用本機 debug 金鑰簽章並驗證 → 把 `ASN_<版本>_android.apk` 與 `android.json` 放進 `site/public/update/`。`--dry-run` 只放到 `src-tauri/target/release-dry/`。部署官網由人做；`site/firebase.json` 已設 `android.json` 不快取。

**簽章與換管道（重要）**：這個「測試通道」用 Android 預設的 debug 金鑰（密碼是公開的 `android`），**不是**之後 Google Play 的正式簽章金鑰，兩者簽章不同。裝了自行安裝版的手機要換成 Play 版，必須先移除自行安裝版再從 Play 安裝；自行安裝版也因此永遠不能被 Play 版「更新」。debug 金鑰任何人都能簽出同樣簽章的 APK，所以這個通道只適合內部測試，不對外大量散布。

**模擬器驗證（第一期做過）**：用 `127.0.0.1` 假伺服器（`adb reverse` 對應）提供假的 android.json 與一支 APK，走完「橫幅出現 → 按更新 → 無許可時開啟許可設定頁 → 有許可後下載 → 系統『要更新這個應用程式嗎？』」；把 sha256 改錯，確認顯示錯誤、不叫安裝畫面。

Play 版（不設 asnDist）的合併後 manifest 已實測沒有 `REQUEST_INSTALL_PACKAGES`（`processUniversalReleaseMainManifest` 輸出）；自行安裝版的 APK 用 `aapt2 dump permissions` 看得到它。

## 十三、幫電腦開新夥伴（遠端開視窗）

手機上最重要的功能之一：視窗開在**那台電腦**上，手機只下指令，不跑任何電腦端模組。

- 入口：名單頂端的「＋」，或每台電腦（設備群組）標題右邊的「＋ 開新夥伴」。
- 流程（一頁表單）：選電腦 → 選模型（那台電腦回報的啟動設定 profile）→ 選工作資料夾（那台允許的清單）→ 名字（預設「夥伴-N」）→ 選填「這是誰的接班」（沿用 #153，新視窗出現後由手機送 `partner_succeed`）→ 選填第一句話 → 「開啟」。
- 不能開就反灰並寫中文原因：沒登入（要先登入）、不在線（這台電腦不在線）、沒開放（這台電腦沒有開放遠端開視窗——橋沒跑或設定頁沒打開「允許我的其他設備替這台開新視窗」）、沒有模型、沒有資料夾。送出前一定先過表單檢查，不能開的電腦選不起來也送不出去。
- 送出後顯示進度：已送出 → 那台電腦正在開視窗 → 等它出現在名單 → 「已經開好了」（可直接開始對話）；失敗顯示原因（後台 2 分鐘內沒被取走會自己標失敗）。可以先關閉表單，完成時頂端橫幅提示。
- 走現有的後台動作 `launch`／`launchers`（沒有新增動作），手機的 Rust 指令是 `android_launch`／`android_launchers`：**沒有本人簽章在打後台之前就回錯**；內容只放行 node／profile／name／cwd／first_message 五個欄位，指令內容一律不帶。
- **後台要補一個 migration**（`supabase/migrations/20261022070000_launch_signed.sql`，**尚未套用**）：原本只有 `role='owner'` 的節點准下令，而手機（與登入建立的電腦節點）是 `member`。新增「帶本人簽章、且簽章的人擁有這個節點與租戶（`asn_user_owns_node`）」也視同擁有者；沒簽章＝與以前完全相同。Edge Function `relay` 的 launch／launchers 會讀 `x-asn-user`。部署順序：先套 migration，再部署 relay 函式，再發新版 ASN（反過來也安全，沒簽章的舊行為不變）。Deno 測試：`supabase/functions/_shared/launch_test.ts`。

## 十四、App 圖示與登入畫面 logo

- App 圖示用 `ui/img/logo.svg` 的機器人：自適應圖示（前景＝機器人縮在 66dp 安全區內，背景＝淺藍單色 `#DCEBFA`）＋各密度的舊版方形與圓形圖示。由 `scripts/gen-android-icons.mjs` 產生（需要 `npm i --no-save @resvg/resvg-js`），不動電腦版 `src-tauri/icons`。
- 登入畫面的 logo 只留一層玻璃框，機器人放大填滿。

## 十五、手機版面整修（polish）

- 標題列圖示按鈕統一：返回鍵與「＋」都是 SVG，觸控區 48dp、圖示 28dp。群組標題旁的「＋ 開新夥伴」拿掉，只留右上角一個「＋」（第一步選電腦）。
- 下拉重整取代右上角的重新整理鈕：名單捲到最上面時往下拉，頂端長出我們自己的機器人（與 logo.svg 同一份圖形：眨眼、拉過門檻會彈跳；更新中時上下彈跳加眨眼與影子），放開後顯示「更新中…」，完成收回。純 CSS／SVG，只動 transform 與 opacity。
- 檢查更新失敗不顯示原始錯誤：官網回 404（還沒發布）＝「目前已是最新版」，連不上或其他錯誤＝「暫時無法檢查更新」。
- 頭像是圓角方形加狀態色外框（`.m-pic`，標題列 44px、「我」112px），不是圓形。
- **名字兩層**：「我的名字」＝帳號層（租戶稱呼 `tenant.owner_name`，所有設備共用，例如「啟良」），對話裡自己的訊息與「我」分頁頂端都用它；還是建租戶時的預設稱呼「朋友」或沒取到，就退到 email 的帳號部分，再沒有就「我」。可在「設置」分頁修改（#166，走後台 `account_name`，所有設備共用）。第一次登入後會先走引導畫面（帳號已有名字就只問設備名稱），旗標存在本機 `asn-onboard.json`。「這台設備的名稱」＝這支手機自己的名字（視窗名／節點顯示名），可改，只用在「從 手機」小標與名單上的設備群組標題。
- 名單每列：頭像右下角疊廠商小徽章（電腦版 `vendor-icons.mjs` 的官方圖，ASN 自己的視窗用機器人 logo；約頭像寬的 40%、白底圓角）；第二行是資料夾（或狀態）；**第三行是這位夥伴最後說的一句話**（只取對方寄來的，跳過自己的、震動、系統提示；單行、超出用省略號、色淡）。來源是本機的對話記錄；沒有本機記錄的（剛裝的手機），登入後依畫面順序向後台 `chat_history` 補一次（每位最多一次、間隔 0.6 秒、整個執行期最多 40 位），補到的記錄存在本機當快取。

**後台設計建議（沒有動 relay 的 list）**：用 `chat_history` 補是「每位一次請求」，名單很長或換手機時還是會多打。比較好的做法是在名單（`list` 的 members.agents）每個視窗多帶 `last_from_them`：`{ at, snippet }`（只取寄給本人的、不含震動與系統信，snippet 截 80 字，且只在請求帶本人簽章時才給，避免 AI 視窗讀得到人的對話摘要）。手機就一次拿到所有第三行，不必補往來。這會動 relay 的 list 與資料庫（要多一個索引或快取欄位），先寫在這裡，等另一位開發員改完 list 再決定。

## 十六、三個大分頁與左右滑動

頁籤改成三個（在畫面最上方，視覺高 32px、可點範圍 36px；輸入區貼齊底部）：**夥伴**（依設備分組，廠商小徽章、最後一句話、下拉重整）、**對話**（最近的對話串，依最後訊息時間；每列頭像、名字、最後一句——雙方都算，自己寄的前面加「你：」——時間、未讀數；下拉重整）、**設置**（原本的「我」：我的名字、設備名稱、頭像、狀態、震動與自動更新開關、登出；沒有下拉重整）。

- **橫向翻頁**：三頁並排在同一排，整排用 `transform` 平移；手指拖動時跟手，放開吸附到最近的一頁（拖過寬度的 22%，或夠快——0.5 px/ms 以上且位移 30px 以上——就換頁），頁籤底線指示條跟著手指移動，也可以點上方頁籤。第一頁往右、最後一頁往左有橡皮筋（打 3 折）。
- **對話上也能滑**：對話分頁和其他兩頁一起在橫向翻頁排裡，在訊息區左右滑就是切分頁（輸入框、工具列上不接手）。
- **不搶手勢**：離螢幕左右邊緣 24px 內不接手（留給安卓系統的邊緣返回手勢）；從輸入框、下拉選單、工具列（可橫向捲動）、放大照片上開始的手勢不接手；正在選取文字時不接手；水平位移要大於垂直位移的 **2 倍**且超過 14px 才算左右滑，斜的與上下捲動一律當垂直，所以對話的上下捲動、文字選取、下拉重整都不會被誤判。左右滑動一旦鎖定，下拉重整就不會觸發。
- **返回鍵**：從「夥伴」切到其他分頁會推一筆瀏覽記錄（返回回到夥伴）；其他分頁之間互換不增加記錄；在「夥伴」再按返回才退到背景。
- 純 CSS／JS 實作，不引入框架；動畫只動 `transform`／`opacity`。

## 十七、偽通話（#99）

對話頁**下方工具列**（表情、震動、照片、檔案那一排）多一顆綠色話筒「通話」。按下進入全螢幕通話畫面：講話 → 辨識成文字寄給這位夥伴 → 回覆到了就念出來 → 回到聽你說，隨時可掛斷、靜音。只有 AI 夥伴有這顆鈕（人、ASN 程式本身、離線的、還在開的都沒有；判斷在 `canCallPartner`）。

做法與取捨：

- **共用的**：畫面 `CallView`（加一個 `phaseText` 屬性讓手機用自己的狀態文字，電腦版不傳＝不變）、`speakableText` 與 `speech-split` 的分段、`call-session.mjs` 的常數（寄信前綴、念出字數上限、回信逾時）、`call-poll.mjs`（通話中每 2 秒收一次信）、`ChatPane` 的 `newCall` 掛點（手機傳新屬性 `callApi`，電腦仍走 `voice.newCall`）。
- **手機自己的**：`lib/mobile-call.mjs`（階段機：聽你說 → 傳送中 → 等回覆 → 念出中，純邏輯，外殼與寄信都注入）＋ Kotlin `CallVoice.kt`。
- **聽**：安卓內建 `SpeechRecognizer`，`zh-TW`，一次聽一句，句子好了給文字。電腦版是自己收音再丟本機 whisper（`stt.rs`），那是電腦端模組，手機沒有也不該有。取捨：辨識品質與是否上傳雲端取決於手機的系統語音服務（Google 語音服務通常會連網），聲音不經過 ASN 的伺服器。
- **念**：安卓內建 `TextToSpeech`（`zh-TW`，沒有就退 `Locale.CHINESE`）。**沒有沿用**電腦版的 `tts.rs`＋後台代理：那段 Rust 在 `#[cfg(desktop)]` 模組裡，守門測試（`android.test.mjs`）規定手機不得編進，且手機要另外把金鑰與頻率限制搬一份。系統念出最穩（不用網路、沒有頻率限制），代價是聲音較機械、要手機有中文語音資料（缺的時候畫面會說怎麼裝）。
- **不同時收音和念出**：只有「聽你說」那一段開辨識；傳送、等回覆、念出時都不收音（不會聽到自己，也避免辨識器反覆嗶聲），念完再等 0.6 秒才聽。代價：等回覆的時候不能插話。
- **自動結束**：螢幕關閉或切到其他程式（`MainActivity.onStop`）、按返回鍵（掛斷但不離開畫面）、換夥伴、連續約 20 次沒聽到聲音、辨識連續出錯。通話中螢幕保持亮著（`FLAG_KEEP_SCREEN_ON`，結束就放掉）。
- **權限**：`RECORD_AUDIO`，Play 版與自行安裝版共用同一份 `AndroidManifest.xml`。第一次按「通話」才詢問（不是安裝時）；拒絕了畫面說明怎麼到「設定 → 應用程式 → ASN → 權限」開。另宣告 `microphone` 特性為非必要（沒麥克風的裝置照裝）與 `<queries>`（Android 11 以上才看得到系統的語音辨識與語音合成服務）。
- **事件**：Kotlin 以 `window.__asnCallEvent(json 字串)` 推 perm／level／partial／result／error／tts-done／tts-error／background；前端 `androidBridge(win).call` 包起來，外殼太舊（沒有這些方法）或這支手機沒有辨識服務時整顆鈕不出現。

Google Play 資料安全性申報要補：「音訊：語音或聲音錄音」——用途為 App 功能（語音通話）；本 App 不收集、不傳送到自家伺服器，辨識由系統語音服務處理；辨識出的**文字**才當成訊息寄給對方（與一般訊息相同）。權限說明可寫：「麥克風：僅在使用者按下『通話』時用於語音辨識，把說的話轉成文字寄給 AI 夥伴；通話結束或離開 App 立即停止。」

真機要驗的：第一次詢問權限與拒絕後的說明；辨識準確度與停頓長度；系統語音（念出）是否有中文；螢幕關閉、來電、切 App 時是否乾淨結束；藍牙耳機；辨識器的系統提示音有沒有太吵。

## 十八、群組對話與使用指引

- **群組對話**：不新增分頁，放在「夥伴」分頁各設備分組之後的一個分組「群組對話」（可收合，搜尋字比對群組名）。每列：群組名、人數、最後一句、未讀數；群組未讀併入「對話」頁籤的總未讀紅點。點進去＝對話分頁（`lastChat` 記成 `room:<代號>`），版面沿用 `ChatPane`；群組沒有震動、傳照片、傳檔案，工具列的鈕以 CSS 藏起來，只留表情符號。純邏輯在 `ui/lib/mobile-rooms.mjs`。
- **資料與發言**：列表沿用電腦版的 `relay_rooms`（節點金鑰、限成員，每 60 秒與門鈴、回到前景時更新）；訊息讀取走新指令 `android_room_read`（動作 `room_read`，一定帶 since，讀完標已讀）；發言走新指令 `android_room_post`（動作 `room_post`，**要本人簽章**，沒登入在打後台前就回錯；內容只放行 room、body、from_agent）。發言用的成員身分：優先「這台節點~這支手機的視窗名」，其次節點本身，其次節點底下任一個。群組上限（每人每群組每小時 20 則）由後台擋，畫面顯示中文說明。
- **使用指引**：「設置」分頁的一個項目，點進去是滿版獨立一頁（左上返回；先列篇目，再看內文），篇目與內文沿用 `lib/guides.mjs`（不複製），內文用 `guide-doc`（不用 v-html）。`lib/mobile-guides.mjs` 替每一篇標示手機適用程度：安裝收發室橋、讓雲端代理加入標「電腦版功能」，開始使用標「部分是電腦版功能」，群組、常見問題手機也適用。導覽 `{ tab: 'me', sheet: 'guide', guide: <篇目> }`，系統返回鍵先回篇目列表再回設置。

## 十九、自動上傳 Play

發版時把 Play 版 AAB 自動上傳到 Google Play「內部測試」軌道並直接發布，不用人去 Play Console 點。實作在 `relay/asn/scripts/play-upload.mjs`，用 Google Play Developer API（androidpublisher v3），不新增相依套件。

**指令**（在 `relay/asn`）：

- `npm run release:play -- --upload`：建置簽章 AAB 後接著上傳。
- `npm run publish:play`：只上傳已建好的 `src-tauri/target/play/ASN_<版本>_play.aab`（可加 `--aab=<路徑>` 指定檔案）。

**流程**：`edits.insert` → `edits.bundles.upload`（media 上傳）→ `edits.tracks.update`（`internal`、狀態 `completed`、`zh-TW` 更新說明取 `CHANGELOG.md` 最新一段，上限 500 字）→ `edits.commit`。任何一步失敗就不提交，並用 `edits.delete` 清掉半成品。請求有逾時（120 秒），只重試網路錯誤與 5xx（最多 3 次）。套件名 `tw.yooliang.asn`。版本碼（versionCode）由 Play 在上傳時回報，同一個版本碼不能重複上傳，所以重發前要先調高版本。

**金鑰安全**：服務帳戶 JSON 只讀進記憶體，用 `node:crypto` 簽 JWT（RS256，範圍 `https://www.googleapis.com/auth/androidpublisher`）換存取權杖；不印出、不寫 log，錯誤訊息只有 HTTP 狀態與 Google 的錯誤代碼。

**一次性設定**：

1. Google Cloud Console 選（或建立）一個專案，啟用「Google Play Android Developer API」。
2. 「IAM 與管理」→「服務帳戶」→ 建立服務帳戶（名稱例如 asn-play-upload），不必給專案角色。
3. 進該服務帳戶 →「金鑰」→「新增金鑰」→ JSON，下載檔案。
4. 把檔案存成 `%USERPROFILE%\.asn\play\play-service-account.json`（與上傳金鑰同一個限本人存取的資料夾；要放別處就設環境變數 `ASN_PLAY_SA_FILE`）。不進 repo。
5. Play Console →「使用者和權限」→ 邀請新使用者，信箱填服務帳戶的 `client_email`；在「應用程式權限」加入 ASN，勾「發布到測試軌道」（內部測試）；送出邀請。權限生效可能要等數分鐘到數小時。
6. 第一次必須已在 Play Console 手動建立過該 App 並上傳過第一版（API 不能建立新 App）。

找不到金鑰檔時，指令會用中文說明並以非 0 結束。

**GitHub Actions 恢復後**（同一支腳本直接用）：把服務帳戶 JSON 的全文存成 repo secret `ASN_PLAY_SA_JSON`，上傳金鑰檔與密碼另存為 `ASN_PLAY_UPLOAD_JKS`（base64）、`ASN_PLAY_UPLOAD_PASSWORD`。工作流程的步驟：

```yaml
- name: 還原 Play 金鑰
  shell: bash
  run: |
    mkdir -p "$HOME/.asn/play"
    printf '%s' "$ASN_PLAY_SA_JSON" > "$HOME/.asn/play/play-service-account.json"
    printf '%s' "$ASN_PLAY_UPLOAD_JKS" | base64 -d > "$HOME/.asn/play/upload.jks"
    printf '%s' "$ASN_PLAY_UPLOAD_PASSWORD" > "$HOME/.asn/play/upload.jks.password"
  env:
    ASN_PLAY_SA_JSON: ${{ secrets.ASN_PLAY_SA_JSON }}
    ASN_PLAY_UPLOAD_JKS: ${{ secrets.ASN_PLAY_UPLOAD_JKS }}
    ASN_PLAY_UPLOAD_PASSWORD: ${{ secrets.ASN_PLAY_UPLOAD_PASSWORD }}
- name: 建置並上傳 Play 版
  working-directory: relay/asn
  run: npm run release:play -- --upload
```

只想在 CI 上傳（建置在別處）時，省略上傳金鑰那兩項，直接跑 `npm run publish:play`。

## 二十、替別台電腦切換 Claude 帳號（#227）

- **用途**：在外面時，用手機把某台電腦（含工作機）正在用的 Claude 帳號換成另一個。名單的設備標題列（別台電腦才有）多一顆「切換 Claude 帳號」：打開後顯示那台電腦回報的帳號（email、方案、使用中）→ 點選要換的帳號 →「下一步」看確認畫面（哪台電腦、從哪個換到哪個、對方要按同意、開著的 Claude 視窗要重開）→「確定切換」→ 顯示等待中、成功或失敗原因。
- **沿用電腦版的後台動作**：`acct_list`／`acct_switch`／`acct_switch_status`（設計見 `acct_remote.rs`、`supabase/migrations/20261021040000_asn_account_switch.sql`）。權杖只在各自那台電腦搬，不經過手機與收發室；指令只帶設備與目標 email。對方電腦預設仍要使用者在本機按「同意」才會換（或對方設定「信任我自己的設備」）；這和「允許遠端管理」開關是兩回事。
- **權限**：手機節點是 `member`，所以 `acct_list`／`acct_switch` 多認一條本人簽章（`asn_user_owns_node`，與遠端開視窗 `launch_signed` 同一套）；`supabase/migrations/20261024130000_acct_switch_signed.sql`。沒簽章＝行為與以前相同（只有 owner 節點准）。沒權限時畫面說明「只有登入同一個帳號的本人手機才能替自己的電腦切換帳號」。
- **手機端指令**：`android_acct_list`、`android_acct_switch`（要本人簽章；沒登入在打後台之前就回錯）、`android_acct_status`。電腦版的 `acct_remote_*` 仍只在電腦編進去。
- **不做**：剩餘額度。後台的帳號回報只有 email、方案、是否使用中；要顯示各帳號剩餘額度，需要電腦端把額度也回報（新欄位），另案處理。（後來 #228 加了 Claude 額度四欄，#374 再加下面的帳號列表。）

### 帳號列表（#374 第一批，後台）

- **用途**：「設備與帳號」最上面的「我的帳號」：以 ASN 帳號為單位，列出各廠牌（Claude、Codex、Grok）的帳號與每個額度窗剩幾 %、多久前讀、哪台讀的。電腦與手機同一份。
- **資料**：新表 `relay.asn_user_accounts`，一筆＝「ASN 帳號 × 廠牌 × 該廠牌帳號」（主鍵 `user_id, vendor, account`）；`windows` 最多 4 個窗，每窗 `{name, left_pct, resets_at, read_at, read_node}`；另記 `seen_at`／`seen_node`。每人最多 100 筆。舊的 `relay.asn_accounts`（每台一筆，給遠端切換用）照舊，兩份並存。
- **寫入**：relay 的 `acct_report` 先照舊寫 `relay.asn_accounts`，再呼叫 `asn_relay_acct_roster_report`（新的失敗只記 log、照樣回 ok）。只有已認領的電腦（`asn_user_owns_node`）才寫。舊版只送 Claude 四欄時，後台照電腦端 `merge.rs` 的規則反推成 5 小時與每週兩窗。Grok 只記帳號、不收額度。
- **新舊判斷**（每窗各自，#1342／#1372，放在資料庫一次交易內做，因為好幾台會同時寫）：以重置時間比；差 10 分鐘內算同一期，剩餘只能下降；較早不收；較晚只有現記的已過才收；Claude 每週窗另要差接近 7 天倍數；Codex 週窗與 5 小時窗不看倍數；現記的已過超過 7 天、或任一邊沒有重置時間就照收。不收的只記 relay log（原因代碼，不含 email）。電腦端本機也照同一套做，兩邊共用 `tests/fixtures/quota-merge-cases.json`。
- **讀取**：新動作 `acct_roster`，一定要本人簽章，只回自己的；列 30 天內有回報過的帳號（所有電腦都不再回報的保留 30 天，畫面用時間標「N 天前讀的」），附本人哪幾台在用設備目前回報著它、哪台正在用。`windows` 是空陣列＝沒有額度資料（例如沒開 Codex）。超過 30 天的列只是不列出，不會自動刪；要不要定期刪另案。
- **migration**：`supabase/migrations/20261029100000_acct_roster.sql`；回復 `supabase/sql/rollback/20261029100000_acct_roster_down.sql`（drop 表算刪資料，執行前先問）。
