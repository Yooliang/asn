// 後台「各電腦啟動設定」（transport.launchers() 的 machines）→ 設備頁要的兩張對照表（純邏輯）：
//   launchers：節點 → 啟動器本身（沒開放＝launcher 是 null 的不放進來，照舊算沒開放）
//   machines：節點 → { platform, launch_closed_reason }（platform 是那台自己回報的平台，#652；手機是 android）
// 電腦版（list.js 的 refreshLaunchers）用這個；手機版用 mobile-launch.mjs 的 machinesByNode（整筆電腦設定），buildDeviceTree 兩種形狀都認。
export function splitMachines(body) {
  const launchers = {}
  const machines = {}
  for (const m of Array.isArray(body?.machines) ? body.machines : []) {
    if (!m?.node) continue
    if (m.launcher) launchers[m.node] = m.launcher
    machines[m.node] = { platform: m.platform ?? null, launch_closed_reason: m.launch_closed_reason ?? null }
  }
  return { launchers, machines }
}
