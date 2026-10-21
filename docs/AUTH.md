# 登入與帳號對應設備

## 現況

- 新後台（Supabase `asn`）已啟用 **Google** 與 **GitHub** 登入（Supabase Auth）；同一個電子郵件的兩種登入自動連結成同一個帳號（D4）。
- Google：OAuth 同意畫面已發布；需要的「應用程式首頁、隱私權政策、服務條款」由官網提供（`https://asnmessenger.web.app`、`/privacy`、`/terms`）。
- **第一期「登入與認領」已實作**（見下一節）：ASN 桌面版一鍵登入、每個帳號一個租戶（D3）、新電腦自動建立節點與金鑰、舊電腦認領現有節點、管理者一次性認領舊租戶。內建收發室橋是之後幾期，這期沒有。
- 還沒做：真人好友、我的設備清單頁（改名、換金鑰、移除）、邀請雲端代理（見 [design/ONBOARDING.md](design/ONBOARDING.md)）。

## 第一期：登入與認領（已實作）

### 流程

```
新電腦（沒有節點金鑰）                                  已有節點金鑰的舊電腦
  開機 → 登入畫面（用 Google／GitHub 登入）               開機 → 照常進名單
        │                                                   設定 → 帳號登入 → 登入 → 「把這台電腦連到我的帳號」
        ▼
  ① Rust 產生 PKCE 驗證碼＋state，在 127.0.0.1:49200～49219 開一次性小伺服器
  ② 系統瀏覽器開 <後台>/auth/v1/authorize?provider=…&redirect_to=http://127.0.0.1:<埠>/callback?state=…&code_challenge=…
  ③ 使用者在 Google／GitHub 登入 → 後台導回 http://127.0.0.1:<埠>/callback?state=…&code=…
  ④ Rust 驗 state、收下授權碼、回「登入完成」靜態頁、關伺服器（5 分鐘沒回呼也關）
  ⑤ Rust 用授權碼＋驗證碼向 /auth/v1/token?grant_type=pkce 換權杖
        存取憑證只放記憶體；更新憑證存 DPAPI 加密檔（%APPDATA%	w.irori.asn\login.bin）
  ⑥ relay?action=account_bootstrap   （Bearer 登入憑證）→ 第一次就建立這個帳號的租戶
  ⑦ relay?action=node_create          → 後台發新金鑰（只回這一次）→ Rust 寫 ~/.irori-relay/<節點>.key（權限只給本人）與 node → ASN 自動重新啟動進名單
                                       （舊電腦的認領改走 node_claim：Bearer 登入憑證＋x-relay-key 現有金鑰，節點的 owner_user 設成此帳號，金鑰不變）
```

### 為什麼用本機回送位址（127.0.0.1），不用自訂網址協定

| | 本機回送位址（採用） | 自訂網址協定（tauri 的 deep-link） |
|---|---|---|
| 開發模式（`npm start`） | 可直接測 | Windows 要寫登錄檔才會導回，開發模式很難測 |
| 安裝方式 | 不動登錄檔 | 安裝時註冊登錄檔；移除、搬位置容易殘留 |
| 瀏覽器行為 | 導回後立刻有頁面可顯示「登入完成」 | 瀏覽器會跳「要開啟 ASN 嗎？」的確認 |
| 被搶 | 同一台電腦的別的程式也能綁 127.0.0.1，但綁不到我們已占用的埠；有 state、PKCE 驗證碼、Host 檢查，截到授權碼也換不到權杖 | 別的程式可註冊同名協定搶授權碼（仍受 PKCE 保護） |
| 防火牆 | 只綁迴路介面，不對外，不跳 Windows 防火牆提示 | 無 |
| 缺點 | 埠可能被占（已準備 20 個） | 需要單一執行個體機制把網址轉給執行中的程式 |

結論：Windows 上回送位址比較可靠（不依賴登錄檔、不依賴瀏覽器是否允許開啟外部協定），所以採用；ONBOARDING 3.2 節也是這個選擇。

### 要在 Supabase 後台設定的（由管理者做，不進 repo）

Authentication → URL Configuration → **Redirect URLs** 加入以下 20 條（逐個列出比萬用字元安全；比對時查詢字串會被忽略，`?state=…` 不用列）：

```
http://127.0.0.1:49200/callback
http://127.0.0.1:49201/callback
…（依序到）…
http://127.0.0.1:49219/callback
```

Site URL 不用改。Google 與 GitHub 的授權回呼網址仍是 Supabase 提供的那一條，不用動。

### 部署順序

1. 套用 migration `supabase/migrations/20261021030000_account_login.sql`（只新增欄位、表、函式，不改既有資料；回復：`supabase/sql/rollback/20261021030000_account_login_down.sql`）。
2. 部署 Edge Function `relay`（`supabase functions deploy relay --no-verify-jwt`；`verify_jwt` 維持 false，因為舊的節點動作用金鑰、不用登入憑證；新動作在函式內自己驗登入憑證）。
3. 在 Supabase 後台加上面 20 條 Redirect URLs。
4. 發 ASN 新版（舊版 ASN 不認得登入，照常運作）。
5. 管理者登入一次後，執行一次性的舊租戶認領（下一節）。

先 1、2 再 4：新版 ASN 打到還沒部署的後台時，登入會得到「後台沒有接受這個要求」。

### 舊的 16 個節點：管理者認領舊租戶（一次性）

現有節點都在舊租戶（序號 1），`owner_user` 是空的。D3 的決定是由管理者認領整個舊租戶：

1. 用管理者自己的 Google／GitHub 在任一台 ASN 登入一次（後台會替這個帳號建一個空租戶——別擔心，下一步會處理）。
2. 在 Supabase 的 SQL 編輯器執行：

   ```sql
   select public.asn_admin_adopt_tenant('管理者的 email');          -- 預設租戶序號 1
   ```

   函式會：找到該 email 的帳號 → 若它剛才自動建的空租戶底下沒有任何節點就刪掉（有節點就拒絕，回 `user_has_nodes`）→ 把舊租戶的 `owner_user` 設成此帳號 → 把舊租戶底下 `owner_user` 為空的節點全部掛到此帳號。回傳 `{"ok":true,"nodes_claimed":N}`。
   其他錯誤：`user_not_found`（email 沒登入過）、`tenant_owned`（舊租戶已經被別的帳號認領）。
3. 重開 ASN，設定 → 帳號登入，應該看到「這台電腦已連到你的帳號，帳號底下共有 16 台電腦」。
4. 認領前，舊租戶的節點在別的帳號登入時按「把這台電腦連到我的帳號」會得到「這個節點還在舊的收發室租戶底下…」（`tenant_not_yours`），這是刻意的：避免舊租戶被不相干的人認領。

### 後端動作

都在 `relay` 函式，網址 `?action=<動作>`，POST；驗證用 `Authorization: Bearer <Supabase 存取憑證>`（函式內用 `auth.getUser` 驗，匿名使用者不收）。程式在 `supabase/functions/_shared/account.ts`。

| 動作 | 輸入 | 輸出／說明 |
|---|---|---|
| `account_bootstrap` | 無 | 沒有租戶就建（代號前綴 `t<序號>-`）；回 `{created, user, tenant, nodes}`（名下節點，不含金鑰） |
| `node_create` | `{name, machine, device_id}` | 建節點（歸此帳號與其租戶），回 `{id, key, bell_topic, rotated}`；**金鑰只在這次回應出現**，資料庫只存雜湊。同帳號同 `device_id` 重送＝換新金鑰（舊的立即失效，解決「回應遺失」）。每個帳號最多 20 個節點 |
| `node_claim` | 標頭 `x-relay-key`＝這台電腦現有節點金鑰 | 節點尚未被認領、且在自己租戶底下才成功，回 `{ok, already, node}`；`409 already_claimed`／`409 tenant_not_yours`／`403 invalid_key` |

資料庫函式（`asn_account_bootstrap`、`asn_node_create`、`asn_node_claim`、`asn_admin_adopt_tenant`）全是 SECURITY DEFINER、只授權 `service_role`；新表 `relay.account_events`（稽核，不含金鑰）開 RLS 不建 policy，照現有慣例全關。`nodes` 新增 `device_id`、`created_via` 兩欄。

### 桌面端的安全做法

- OAuth `state`（16 位元組亂數）放在 `redirect_to` 的查詢字串裡，回呼時用常數時間比對；沒有或不符一律回 400 並繼續等（別人亂打的請求不能中斷你的登入）。PKCE 用 S256，驗證碼 32 位元組亂數，只存在 Rust 記憶體。
- 回呼伺服器只綁 `127.0.0.1`、只收 `GET /callback`、檢查 `Host`（擋 DNS 重綁定）、收到第一個有效回呼就關、5 分鐘逾時、最多處理 30 條連線；回應頁是不含外部資源的靜態頁（CSP `default-src 'none'`），不回顯授權碼。
- 權杖：存取憑證只放記憶體；更新憑證存 DPAPI 加密檔（非 Windows 是 0600 檔，沒有系統金鑰庫可用）；`Session`／`StoredLogin` 不實作 Debug 與 Serialize（有守門測試），權杖不進 log、不傳前端——前端只拿得到 `{signed_in, email}`。
- 節點金鑰：只經 Rust 一次，寫進 `~/.irori-relay/<節點>.key`（沿用現有格式：只有金鑰本身）。先建空檔、用 `icacls` 限縮成只有本人，才寫入內容；寫完讀回比對；限縮失敗就刪檔放棄。
- 登出：通知後台作廢這次登入（盡力而為），再清掉本機登入權杖。**不刪節點金鑰**，舊電腦登出後照常收發信。

### 設定頁

設定 → 「帳號登入」分類（獨立於另一位開發者正在改的「Claude 帳號」）：未登入顯示兩個登入鈕；已登入顯示 email、帳號底下的電腦數、「把這台電腦連到我的帳號」（這台有節點金鑰、但還不在帳號名下時才出現）與「登出」。

## 設定位置（不放任何密鑰）

| 項目 | 位置 |
|---|---|
| 登入方式開關、Client ID／Secret | Supabase 主控台 → Authentication → Sign In / Providers（Google、GitHub） |
| 重新導向網址（Redirect URLs）、Site URL | Supabase 主控台 → Authentication → URL Configuration；新增前端網址時要在這裡加白名單 |
| Google 的 OAuth 用戶端與同意畫面 | Google Cloud 主控台 → API 與服務 → 憑證／OAuth 同意畫面（授權的重新導向 URI 填 Supabase 提供的 callback 網址） |
| GitHub 的 OAuth App | GitHub → Settings → Developer settings → OAuth Apps（Authorization callback URL 填 Supabase 提供的 callback 網址） |
| 官網三頁 | `site/public/`（部署見 `site/README.md`） |

Client Secret 只存在 Supabase 與各平台主控台，**不進 repo、不寫進文件**。

## 設計草案：帳號對應設備（認領）

（第一期已依此大致實作，細節以上方為準；認領碼的做法改成「節點金鑰證明擁有」，沒有另外發認領碼。）

目標：一個人登入後，看到「自己名下」的設備與代理，並能管理它們；為「真人好友」與共享記憶的權限（見 [ROADMAP.md](ROADMAP.md)）打底。

### 模型

```
auth.users（人）  1 ──< N  relay.nodes（設備／代理）   以 nodes.owner_user 關聯
                 1 ── 0..1 relay.tenants（租戶，擁有者）
```

- 人＝登入帳號；節點＝設備或代理。節點金鑰仍是「節點對後端」的憑證，**登入不取代金鑰**；兩者分工：金鑰證明「我是這個節點」，登入證明「我是這個人」，`owner_user` 把兩者綁起來。
- 後端對外介面分兩條：節點動作（金鑰）與人類動作（登入 JWT）。人類動作是新的，不要塞進現有 `relay` 函式的金鑰驗證邏輯，建議新增獨立函式（例如 `account`），驗 JWT。

### 認領流程（建議）

1. 人在網頁登入（Google／GitHub）。
2. 網頁按「認領設備」→ 後端產生一組一次性**認領碼**（比照現有邀請碼：只存雜湊、15 分鐘失效、一次性），綁定 `auth.uid()`。
3. 設備端（橋或 ASN）執行 `claim <認領碼>`：用節點金鑰＋認領碼呼叫後端 → 後端驗證碼有效後，把該節點的 `owner_user` 設為碼的擁有者。
4. 已被認領的節點不可再被他人認領；換主人需原主人釋出（`owner_user` 設回空）或維護者處理。
5. 新註冊的節點（邀請碼流程）若由已登入的人發出邀請，註冊時直接帶 `owner_user`。

### 權限

- 人可以：列出名下節點與狀態、改顯示名／頭像、重發金鑰（重設碼）、移除節點、查名下節點的訊息（依隱私設定）。
- 人不可以：讀別人名下節點的信、冒用別人節點寄信。
- RLS：若人類介面直接用 Supabase 用戶端讀表，需補 policy（以 `owner_user = auth.uid()` 為準）；目前表不暴露，建議維持「全走函式」。

### 要先決定的事

- 一個節點能否有多位擁有者（家人共用設備）？草案先限一位，多人走「群組」。
- 登入帳號合併（同一人用 Google 與 GitHub 兩種登入）：Supabase 可連結身分，需決定是否開放。
- 既有 16 個節點的認領：由維護者逐一發認領碼，或比對（舊後台已有的對應）後批次設定。
- 隱私：人能否看到自己名下節點的訊息內文？與之後的端對端加密互相牽動（加密後後端讀不到，認領只管名單與管理）。

### 工作量（估計）

認領碼＋帳號函式＋最小網頁（登入、名單、認領）約 1～2 週；含重設金鑰、釋出與既有節點遷移約再加 1 週。
