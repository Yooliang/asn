// 前端功能旗標的唯一住處（#2163 PR-4）。`ui/` 底下（vendor 除外）不准在這支以外的地方宣告旗標常數，
// 守門測試是 test/flags-guard.test.mjs；每個旗標在 docs/設定值清單.md 的「前端旗標」一節要有一列（名稱、值、用途一致）。
// 旗標值是建置期常數，改值要發版；手機與桌面共用這一份，沒有各自的旗標。純邏輯，node 與瀏覽器都能跑。

/** 「安裝並登入 Claude Code」的畫面入口（電腦版按鈕、允許從手機安裝的勾選、手機版按鈕）。完整真機流程沒跑過前不給一般使用者按；跑過再改成 true */
export const AGENT_INSTALL_UI = false

/**
 * 入口旗標：預設關，一般使用者看不到（旗標關＝畫面上沒有這顆鈕，不是灰掉）。
 * 擁有者在家用機跑完一次安裝與一次更新之後，另開小 PR 改成 true。與 AGENT_INSTALL_UI（設備頁的「安裝並登入」）互不相干。
 */
export const LAUNCH_INSTALL_BTN = false

// pi 是通道不是廠牌，最後不列在廠牌裡；但「經 pi」要等後端能帶提供者與模型開 pi（0.1.90 後續）才能選，
// 在那之前先留著 pi 這一列，不然使用者完全開不了 pi 夥伴（小東 #737）
export const PI_VIA_READY = true

/**
 * Claude 那一列的「進行安裝／進行更新」是否開啟（#1548 ⑤）：旗標預設關；
 * 冒煙探測用 globalThis.__smokeLaunchInstallBtn 注入開啟（只在假後台設，正式環境沒有）。
 */
export const launchInstallOn = () => LAUNCH_INSTALL_BTN === true || globalThis.__smokeLaunchInstallBtn === true

/** 登記表：名稱、值、用途、誰在讀。守門測試用它跟文件逐列比對；新增旗標要在這裡加一列 */
export const FLAGS = Object.freeze([
  Object.freeze({
    name: 'AGENT_INSTALL_UI',
    value: AGENT_INSTALL_UI,
    purpose: '「安裝並登入」入口總開關',
    readers: Object.freeze(['ui/lib/new-computer-guide.mjs']),
  }),
  Object.freeze({
    name: 'LAUNCH_INSTALL_BTN',
    value: LAUNCH_INSTALL_BTN,
    purpose: '開視窗對話框 Claude 那一列的「進行安裝／更新」按鈕',
    readers: Object.freeze(['ui/lib/tool-install.mjs', 'ui/list.js']),
    via: Object.freeze(['launchInstallOn']),   // list.js 不直接用旗標名，經 launchInstallOn 讀（含冒煙掛勾）
  }),
  Object.freeze({
    name: 'PI_VIA_READY',
    value: PI_VIA_READY,
    purpose: '開新夥伴對話框的「經 pi」選項是否就緒',
    readers: Object.freeze(['ui/list.js']),
  }),
])
