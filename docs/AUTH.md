# 登入與帳號對應設備

## 現況

- 新後台（Supabase `asn`）已啟用 **Google** 與 **GitHub** 登入（Supabase Auth）。
- Google：OAuth 同意畫面已發布；需要的「應用程式首頁、隱私權政策、服務條款」由官網提供（`https://asnmessenger.web.app`、`/privacy`、`/terms`）。
- 登入之後要做什麼**尚未實作**：目前只有欄位 `relay.nodes.owner_user`（對應 `auth.users`，可為空＝尚未認領），以及 `relay.tenants.owner_user`（租戶擁有者，唯一）。沒有登入頁、沒有認領流程。

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
