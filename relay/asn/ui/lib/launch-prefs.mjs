// 啟動設定（本機存檔）：最近用過的工作資料夾、進階覆寫。
export const LAUNCH_PREFS_KEY = 'launch'

export function normalizeLaunchPrefs(raw) {
  const o = raw && typeof raw === 'object' ? raw : {}
  const recent = Array.isArray(o.recentCwd) ? o.recentCwd.filter(p => typeof p === 'string').slice(0, 12) : []
  const cwdAllow = Array.isArray(o.cwdAllow) ? o.cwdAllow.filter(p => typeof p === 'string') : []
  const maxPerHour = Number.isInteger(o.maxPerHour) ? Math.min(Math.max(o.maxPerHour, 1), 20) : 6
  const launchDisplay = o.launchDisplay === 'background' ? 'background' : 'foreground'
  return { recentCwd: recent, cwdAllow, maxPerHour, showAdvanced: Boolean(o.showAdvanced), launchDisplay }
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

/** 下拉最多幾筆 */
export const CWD_MAX = 15
export const CWD_EMPTY_HINT = '按「瀏覽…」選一個資料夾'

// 路徑比對用：Windows 路徑（磁碟代號開頭）的 / 與 \ 視為同一個、不分大小寫、去尾端分隔線
function cwdKey(p) {
  let x = String(p ?? '').trim()
  if (/^[a-zA-Z]:([\\/]|$)/.test(x)) x = x.replace(/\//g, '\\').toLowerCase()
  while (x.length > 3 && (x.endsWith('\\') || x.endsWith('/'))) x = x.slice(0, -1)
  return x
}

/** 把多份清單依先後合併：去重（不同寫法算同一個）、最多 CWD_MAX 筆 */
export function mergeCwdLists(lists, max = CWD_MAX) {
  const seen = new Set()
  const out = []
  for (const list of lists) {
    for (const p of list ?? []) {
      const x = String(p ?? '').trim()
      const k = cwdKey(x)
      if (!x || seen.has(k)) continue
      seen.add(k)
      out.push(x)
      if (out.length >= max) return out
    }
  }
  return out
}

/** 「瀏覽…」選到的資料夾：放最前面並選取（已在清單裡就移到最前） */
export function withPickedCwd(list, picked) {
  const x = String(picked ?? '').trim()
  if (!x) return list
  return mergeCwdLists([[x], list])
}
