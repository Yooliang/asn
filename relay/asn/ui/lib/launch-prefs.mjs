// 啟動設定（本機存檔）：最近用過的工作資料夾、進階覆寫。
export const LAUNCH_PREFS_KEY = 'launch'

export function normalizeLaunchPrefs(raw) {
  const o = raw && typeof raw === 'object' ? raw : {}
  const recent = Array.isArray(o.recentCwd) ? o.recentCwd.filter(p => typeof p === 'string').slice(0, 12) : []
  const cwdAllow = Array.isArray(o.cwdAllow) ? o.cwdAllow.filter(p => typeof p === 'string') : []
  const maxPerHour = Number.isInteger(o.maxPerHour) ? Math.min(Math.max(o.maxPerHour, 1), 20) : 6
  return { recentCwd: recent, cwdAllow, maxPerHour, showAdvanced: Boolean(o.showAdvanced) }
}

export function bumpRecentCwd(prefs, cwd) {
  const c = String(cwd ?? '').trim()
  if (!c) return prefs
  const recentCwd = [c, ...prefs.recentCwd.filter(x => x !== c)].slice(0, 12)
  return { ...prefs, recentCwd }
}

export function cwdChoices({ allow, recent }) {
  const set = new Set()
  const out = []
  for (const p of [...recent, ...allow]) {
    const x = String(p ?? '').trim()
    if (!x || set.has(x)) continue
    set.add(x)
    out.push(x)
  }
  return out
}
