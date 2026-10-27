# 遠端開 Claude 視窗（手機 App「電腦」）規劃

2026-10-02 小良哥要求：裝了 #50 機器橋的電腦，要能從手機開一個新的 Claude 對話視窗；做成獨立的 App，每台電腦各自設定啟動方式。
規劃：H-Irori（保留期內應小良哥要求撰寫）；實作由 H-Irori-2 排程。前提：#50 機器橋已安裝。

## 使用方式

- 手機（3D 房間的手機與 Irori Chat PWA 都有）新增 App「**電腦**」：
  1. 列出所有機器（家用機、公司工作機…），顯示在線燈與目前開著的視窗（來自 roster）。
  2. 點一台 → 「開新視窗」：選啟動設定（每台預設一組）、填視窗名（例：H-英雄-2）、選工作資料夾（從該機器允許的清單選）、可選第一句話（開場指令）。
  3. 送出後幾秒，名單上出現新視窗；之後就能在 Irori Chat 跟它對話（經收發室），或在電腦上直接用。
- 也可以跟希緒說「在家用機開一個新視窗做英雄傳說」，她用工具送出同樣的請求（只限小良哥親口要求）。

## 每台電腦自己的啟動設定（不在雲端、不在訊息裡）

`%USERPROFILE%\.irori-relay\launcher.json`（機器橋讀取；**不進 repo**）：

```json
{
  "profiles": {
    "default": {
      "label": "一般（含 Chrome）",
      "command": "%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      "args": ["-NoExit", "-Command", "claude --dangerously-skip-permissions --chrome -n {name}"]
    }
  },
  "cwd_allow": ["<專案上層資料夾>", "<專案資料夾 A>", "<專案資料夾 B>"],
  "max_per_hour": 6
}
```

- 家用機的 default 是小良哥給的指令**去掉** `--dangerously-load-development-channels server:irori-relay`（#50 機器橋已接手 H 節點收信，帶 channel 的視窗會搶同一把 H 金鑰的 inbox）；公司機在自己的 launcher.json 寫自己的。
- `{name}` 是唯一允許的替換欄位，且必須符合 `^[A-Za-z0-9\-\u4e00-\u9fff]{1,40}$`；**工作資料夾只能從 cwd_allow 選**；第一句話不拼進指令列，改在視窗啟動後由收發室用 SendMessage 送進去。
- 建議沿用 partner-relay 的 `spawn-partner.ps1` 的做法（清掉繼承的 `CLAUDE_*`、`NO_COLOR`，開 Remote Control），launcher 可以直接呼叫它。

## 安全（這是能在你電腦上開程式的入口，必須嚴格）

1. **只有 owner 能下令**：仲介新增動作 `launch {machine, profile, name, cwd, first_message?}`，只接受 role=owner（小良哥經希緒或 Irori Chat）；其他成員、工頭、外部 AI 一律 403。
2. **訊息裡永遠不帶指令內容**：只帶 profile 名稱、視窗名、cwd（從清單選）；真正要執行什麼完全由該機器的 launcher.json 決定。
3. 機器橋執行前再驗一次：profile 存在、name 符合格式且不和現有視窗重名、cwd 在 cwd_allow、每小時次數未超過。
4. 每次啟動記一筆紀錄（誰、何時、哪台、哪個 profile、視窗名、結果），回傳給手機顯示，也寫進機器的 log。
5. 第一次在某資料夾開視窗會卡「是否信任此資料夾」（partner-relay 已知坑）：機器橋偵測 10 秒內沒新 node 子行程就回報「可能卡在信任確認，請到電腦前按一次 Enter」。

## 介面

- 「電腦」App：機器列表 → 機器頁（在線狀態、開著的視窗、「開新視窗」按鈕、最近的啟動紀錄）。
- 開新視窗表單：啟動設定（下拉）、視窗名（預設依前一個同名＋1）、工作資料夾（下拉，來自該機器 cwd_allow，由機器橋回報）、第一句話（選填）。
- 結果：成功顯示「H-英雄-2 已開啟」並可直接點進對話；失敗顯示原因。

## 分期

1. 機器橋：讀 launcher.json、回報可用 profile 與 cwd_allow（附在 roster）、處理 launch、紀錄。
2. 仲介：`launch` 動作（owner 限定）、轉送到機器節點、回傳結果。
3. 手機「電腦」App（3D 房間手機＋PWA 共用）。
4. 希緒工具 `open_window(machine, name, cwd, first_message?)` 與 persona（只在小良哥親口要求時用）。


## 實作狀態（2026-10-02，I-Irori-3）

- **介面改動（小良哥裁示）**：不做獨立的「電腦」App，改放在 Irori Chat「聯絡人」分頁——每個設備分組的標題列旁有「＋ 開新視窗」（只有機器橋回報了 launcher.json 的電腦才出現）。表單＝電腦（同設備多台才出現）、啟動設定、視窗名（依最近開過的「名字-數字」＋1）、工作資料夾、第一句話（選填）；下方列最近的啟動紀錄。送出後顯示進度，開好可直接「開啟對話」；新視窗出現在同一個列表。3D 房間手機與 /chat/ 共用同一份（`web/js/phone/app_chat.js`）。
- 仲介：`supabase/sql/07_launch.sql`（`relay.launches`、`relay.nodes.launcher`；`irori_relay_set_launcher／launch／launch_pending／launch_result／launchers`）；`irori-relay` 動作 `launch`、`launchers`（owner 節點）、`launch_pending`、`launch_result`（機器節點），`roster` 可附 `launcher` 摘要；`irori-api` 的 `GET /launchers`、`POST /launch`（登入的小良哥，身分是 owner 節點，跟建群組同一條路）。共用邏輯 `supabase/functions/_shared/launch.ts`。
- 機器橋：`relay/machine/launcher.mjs`（細節見 relay/machine/README.md「遠端開 Claude 視窗」），範本 `relay/machine/launcher.example.json`。
- 跟規劃不同的地方：卡信任確認的判斷改成「30 秒內沒出現在 `claude agents` 名單」（回 `unconfirmed`，3 分鐘內出現仍補 `ok`），不列舉 node 子行程；第一句話在視窗出現後當成 owner 來信經收發室送進去，同時記進該視窗的往來紀錄（聊天裡看得到）。
- 沒做：第 4 期希緒的 `open_window` 工具（I-Irori-2 裁示這次不做）。
