// 藍圖頁與開發日誌頁的純邏輯（不碰 DOM，tests/roadmap_page.test.mjs 直接測）。
// 資料來自資料庫（public.asn_site_* 表），這裡只負責：解析內文的極小標記、排版本順序、組時間軸。
// 內文標記：**粗體**、`程式碼`、#123（議題編號）；以「- 」開頭的行是子項目。其他字元一律當純文字。

export const STATUS_LABEL = { ok: '已完成並驗證', unv: '已完成未驗證', doing: '進行中', todo: '尚未做', tbc: '待確認', na: '不適用' }
export const MEETING_FIELDS = [
  ['attendees', '出席／回覆'],
  ['progress', '各項進度'],
  ['decisions', '決議'],
  ['assignments', '分派'],
  ['improvements', '改善意見'],
]
export const REPO_ISSUE_BASE = 'https://github.com/Yooliang/asn/issues/'
const TZ = 'Asia/Taipei'

// 一行文字 → 片段陣列：{ t: 'text'|'strong'|'code'|'ref', v }
export function parseInline(line) {
  const out = []
  const re = /\*\*([^*\n]+)\*\*|`([^`\n]+)`|#(\d{1,6})(?![\d])/g
  let last = 0
  let m
  const s = String(line ?? '')
  while ((m = re.exec(s))) {
    if (m.index > last) out.push({ t: 'text', v: s.slice(last, m.index) })
    if (m[1] != null) out.push({ t: 'strong', v: m[1] })
    else if (m[2] != null) out.push({ t: 'code', v: m[2] })
    else out.push({ t: 'ref', v: `#${m[3]}` })
    last = re.lastIndex
  }
  if (last < s.length) out.push({ t: 'text', v: s.slice(last) })
  return out
}

// 多行內文 → 區塊：{ kind: 'p', parts } 或 { kind: 'ul', items: [parts…] }（連續的「- 」行併成一個清單）
export function parseBlocks(text) {
  const blocks = []
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.trim()
    if (!line) continue
    if (line.startsWith('- ')) {
      const last = blocks[blocks.length - 1]
      const parts = parseInline(line.slice(2))
      if (last?.kind === 'ul') last.items.push(parts)
      else blocks.push({ kind: 'ul', items: [parts] })
    } else blocks.push({ kind: 'p', parts: parseInline(line) })
  }
  return blocks
}

// 只接受 http(s) 網址；其他（javascript:、data: 等）一律回 null
export function safeHttpUrl(u) {
  try {
    const url = new URL(String(u))
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null
  } catch { return null }
}

export const issueUrl = n => (Number.isInteger(n) && n > 0 ? safeHttpUrl(REPO_ISSUE_BASE + n) : null)

// 語意版本比較（0.1.9 < 0.1.10）；不是版本號的排最後
export function cmpVersion(a, b) {
  const pa = /^(\d+)\.(\d+)\.(\d+)$/.exec(a ?? ''), pb = /^(\d+)\.(\d+)\.(\d+)$/.exec(b ?? '')
  if (!pa || !pb) return pa ? -1 : pb ? 1 : 0
  for (let i = 1; i <= 3; i++) { const d = Number(pa[i]) - Number(pb[i]); if (d) return d }
  return 0
}

// 台北時間的「YYYY-MM-DD」與「HH:MM」
export function taipeiParts(iso) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return { date: '', time: '' }
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
  const p = Object.fromEntries(f.formatToParts(d).map(x => [x.type, x.value]))
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` }
}

const bySort = (a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0)

// 藍圖頁的時間軸：過去（已發的版本，舊到新）→「現在」（進行中的項目）→ 未來（預定版本，再來是還沒定版本的規劃）
// releases：asn_site_releases 的列；items：asn_site_roadmap_items 的列（藍圖與待辦都可以給，只取需要的）
export function buildRoadmapTimeline(releases, items) {
  const roadmap = items.filter(i => i.section === 'roadmap')
  const byVersion = new Map()
  const node = v => {
    if (!byVersion.has(v)) byVersion.set(v, { version: v, release: null, items: [] })
    return byVersion.get(v)
  }
  for (const r of releases) node(r.version).release = r
  for (const i of roadmap.filter(i => i.status === 'released' && i.version)) node(i.version).items.push(i)
  const past = [...byVersion.values()].sort((a, b) => cmpVersion(a.version, b.version))
  for (const n of past) n.items.sort(bySort)

  const earlier = roadmap.filter(i => i.status === 'released' && !i.version).sort(bySort)
  const now = roadmap.filter(i => i.status === 'doing').sort(bySort)
  const latest = past.filter(n => n.release).map(n => n.version).pop() ?? null

  // 未來：任何一區標「規劃中」且綁了版本的項目（例如待辦的「0.1.95 預定」），版本要比已發的新
  const futureMap = new Map()
  for (const i of items.filter(i => i.status === 'planned' && i.version && (!latest || cmpVersion(i.version, latest) > 0))) {
    if (!futureMap.has(i.version)) futureMap.set(i.version, { version: i.version, items: [] })
    futureMap.get(i.version).items.push(i)
  }
  const future = [...futureMap.values()].sort((a, b) => cmpVersion(a.version, b.version))
  for (const n of future) n.items.sort(bySort)
  const later = roadmap.filter(i => i.status === 'planned' && !i.version).sort(bySort)

  return { earlier, past, latest, now, future, later }
}

// 待辦欄位：依 sort_order，項目放進對應欄
export function buildLanes(lanes, items, section) {
  return lanes.filter(l => l.section === section).sort(bySort).map(l => ({
    ...l,
    items: items.filter(i => i.section === section && i.lane === l.lane).sort(bySort),
  }))
}

// 欄裡沒有項目時顯示的一句話（欄位標題照留，讓人知道這欄確實是空的，而不是沒讀到）
export const EMPTY_LANE_TEXT = '目前沒有'

// 藍圖頁「待辦與優先順序」區：已發佈（released）的項目不再列在待辦，只留在上面的時間軸。
// 欄位全被濾光時不隱藏整欄，改由畫面寫「目前沒有」（empty 為 true）。
export function buildTodoLanes(lanes, items) {
  return buildLanes(lanes, items.filter(i => i.status !== 'released'), 'todo')
    .map(l => ({ ...l, empty: l.items.length === 0 }))
}

// 支援總表：列依 sort_order，每列帶齊每個功能欄的格子（缺的格子當「待確認」）
export function buildMatrix(columns, rows, cells) {
  const cols = [...columns].sort(bySort)
  const map = new Map(cells.map(c => [`${c.row_key}\u0000${c.column_key}`, c]))
  return {
    columns: cols,
    rows: [...rows].sort(bySort).map(r => ({
      ...r,
      cells: cols.map(c => map.get(`${r.row_key}\u0000${c.column_key}`) ?? { row_key: r.row_key, column_key: c.column_key, status: 'tbc', body: '這一格還沒有資料。', refs: [] }),
    })),
  }
}

// 開發日誌：會議與發版合成一條，最新在上。發版只有日期，排在當天所有會議之上（當天結束時）；同一天多版依版本新到舊。
export function buildLog(meetings, releases) {
  const entries = [
    ...meetings.map(m => {
      const { date, time } = taipeiParts(m.held_at)
      return { kind: 'meeting', date, time, key: `${date} ${time}`, meeting: m }
    }),
    ...releases.map(r => ({ kind: 'release', date: r.released_on, time: '', key: `${r.released_on} 99:99`, release: r })),
  ]
  return entries.sort((a, b) => {
    if (a.key !== b.key) return a.key < b.key ? 1 : -1
    if (a.kind === 'release' && b.kind === 'release') return cmpVersion(b.release.version, a.release.version)
    return 0
  })
}
