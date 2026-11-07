// 雲端夥伴改名自動接上（todo-next-181）：用夥伴自己不變的編號（Grok 夥伴資料夾名＝profile 的 id）認人，
// 名字變了就在名單回報裡帶 renamed_from（舊名），後台走既有的改名路徑（搬群組身分與已讀位置）；
// 本機的群組收信游標（rooms.json）也把舊名那幾筆複製到新名，不漏信、不重複。
// 記錄放 agent-names.json（編號 → 上次成功回報的名字）；只在名單回報成功後才更新，失敗會下一輪再試。
import fs from 'node:fs'
import { writeFileAtomic } from './lib.mjs'

/** 最多記這麼多筆（編號暫時讀不到的夥伴先留著，不因為一次沒掃到就忘記他） */
export const NAMES_MAX = 200

export function readNames(file) {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8'))
    const names = v && typeof v === 'object' && !Array.isArray(v) ? v.names : null
    if (!names || typeof names !== 'object' || Array.isArray(names)) return {}
    return Object.fromEntries(Object.entries(names).filter(([id, n]) => typeof id === 'string' && typeof n === 'string' && n))
  } catch { return {} }
}

/** 不帶第三個參數時保留檔案裡原有的舊名紀錄（只改現名對照的呼叫端不會把舊名洗掉） */
export function writeNames(file, names, old = readOldNames(file)) {
  const entries = Object.entries(names).slice(-NAMES_MAX)
  writeFileAtomic(file, JSON.stringify({ version: 1, names: Object.fromEntries(entries), old }))
}

// ---------- 舊名轉投（#746）：改名後 7 天內，寄到舊名的信算給改名後的那位，不給預設那位 ----------
// 規則和電腦版 names.rs 一致：保留 7 天、每位最多 5 個舊名。記在 agent-names.json 的 old（[{ id, from, to, at }]），
// 只在名單回報成功、真的接上改名之後才記（detectRenames 跳過的不記，因為那些不確定是誰）。

export const OLD_KEEP_MS = 7 * 24 * 60 * 60 * 1000
export const OLD_PER_ID = 5

export function readOldNames(file) {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8'))
    const old = v && typeof v === 'object' && !Array.isArray(v) ? v.old : null
    if (!Array.isArray(old)) return []
    return old.filter(o => o && typeof o.id === 'string' && o.id && typeof o.from === 'string' && o.from && typeof o.to === 'string' && o.to && Number.isFinite(o.at))
  } catch { return [] }
}

/** 只留 7 天內的；每位（編號）只留最新的 5 筆；結果照時間由舊到新 */
export function pruneOldNames(old, now) {
  const fresh = (Array.isArray(old) ? old : []).filter(o => now - o.at < OLD_KEEP_MS && o.at - now < OLD_KEEP_MS)   // 時間在未來太遠的（時鐘亂掉）也丟
  const perId = new Map()
  const kept = [...fresh].sort((x, y) => y.at - x.at).filter(o => { const n = (perId.get(o.id) ?? 0) + 1; perId.set(o.id, n); return n <= OLD_PER_ID })
  return kept.sort((x, y) => x.at - y.at).slice(-NAMES_MAX)
}

/** 這一輪接上的改名記成舊名（同一位、同一個舊名只留最新一筆） */
export function recordOldNames(old, renames, now) {
  const add = (Array.isArray(renames) ? renames : []).map(r => ({ id: r.id, from: r.from, to: r.to, at: now }))
  const rest = (Array.isArray(old) ? old : []).filter(o => !add.some(a => a.id === o.id && a.from === o.from))
  return pruneOldNames([...rest, ...add], now)
}

/**
 * 收件名不在現在的名單上時，看它是不是 7 天內某位夥伴的舊名，是的話回那位現在的名字；對不到回 null（照舊給預設那位）。
 * 不猜：同一個舊名 7 天內被兩位不同的夥伴用過、或那位現在不在名單上，都回 null。
 * names＝agent-names.json 的編號 → 現名；present＝這一輪名單上的名字（Set）。
 */
export function resolveOldName(name, { names, old, present, now }) {
  if (typeof name !== 'string' || !name || present.has(name)) return null
  const hits = pruneOldNames(old, now).filter(o => o.from === name)
  if (!hits.length || new Set(hits.map(o => o.id)).size > 1) return null
  const cur = names?.[hits[0].id]
  return typeof cur === 'string' && cur !== name && present.has(cur) ? cur : null
}

/**
 * 這一輪掃到的夥伴（帶 profile_id 的才算）對照上次記的名字。
 * 回 { renames: [{ id, from, to }], names: 要記下的新對照, skipped: [說明] }
 * 不確定的不猜：舊名現在被別的夥伴用著、兩位夥伴搶同一個新名或舊名，都跳過（照舊要手動接），並照常更新記錄，免得每一輪重複提。
 */
export function detectRenames(agents, stored) {
  const withId = (Array.isArray(agents) ? agents : []).filter(a => typeof a?.profile_id === 'string' && a.profile_id && typeof a.name === 'string' && a.name)
  const present = new Set((Array.isArray(agents) ? agents : []).map(a => a?.name).filter(Boolean))
  const candidates = withId.filter(a => stored[a.profile_id] && stored[a.profile_id] !== a.name).map(a => ({ id: a.profile_id, from: stored[a.profile_id], to: a.name }))
  const count = (key, v) => candidates.filter(c => c[key] === v).length
  const renames = [], skipped = []
  for (const c of candidates) {
    if (present.has(c.from)) skipped.push(`${c.from} → ${c.to}：舊名現在有別的夥伴在用`)
    else if (count('to', c.to) > 1 || count('from', c.from) > 1) skipped.push(`${c.from} → ${c.to}：同一輪有別的夥伴也在改到相同的名字`)
    else renames.push(c)
  }
  const names = { ...stored }
  for (const a of withId) names[a.profile_id] = a.name
  return { renames, names, skipped }
}

/**
 * 群組游標（鍵「房號|節點~視窗名」）：舊名的游標複製給新名。新名已經有游標就不動它（只增不覆蓋，也不刪舊的）。
 * 一定要在名單回報「之前」做：後台改名後 room_list 會直接出現新名，若游標還沒有，第一次看到會從最新位置起算，中間的訊息就漏了。
 */
export function aliasCursors(cursors, renames) {
  const out = { ...cursors }
  let changed = false
  for (const [key, seq] of Object.entries(cursors)) {
    const bar = key.indexOf('|')
    const member = bar < 0 ? '' : key.slice(bar + 1)
    const tilde = member.indexOf('~')
    if (tilde < 0) continue
    const node = member.slice(0, tilde), agent = member.slice(tilde + 1)
    for (const r of renames) {
      if (agent !== r.from) continue
      const nk = `${key.slice(0, bar)}|${node}~${r.to}`
      if (out[nk] === undefined) { out[nk] = seq; changed = true }
    }
  }
  return { cursors: out, changed }
}
