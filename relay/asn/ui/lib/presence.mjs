// 各設備的 ASN 在線狀態與版本（名單每個節點帶的 asn 列）。純函式，node 與瀏覽器都能跑。
// 後台只回 3 分鐘內有回報的 ASN 視窗；這裡再擋一次格式（外部資料）。之後聽歌狀態會接在同一欄。

const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,6}(-[0-9A-Za-z.]{1,16})?$/
const LABEL = { online: '線上', busy: '忙碌', away: '暫離' }

// 名單 members → { 節點: [{ window_name, version, status, psm }] }；格式不對的列丟掉，沒有 asn 的節點不列
export function asnByNode(members) {
  const out = {}
  for (const m of Array.isArray(members) ? members : []) {
    if (!m || typeof m.id !== 'string' || !Array.isArray(m.asn)) continue
    const rows = []
    for (const a of m.asn) {
      if (!a || typeof a.window_name !== 'string' || !a.window_name || typeof a.version !== 'string' || !VERSION.test(a.version)) continue
      const status = a.status === 'busy' || a.status === 'away' ? a.status : 'online'
      rows.push({ window_name: a.window_name, version: a.version, status, psm: typeof a.psm === 'string' ? a.psm : '' })
    }
    if (rows.length) out[m.id] = rows
  }
  return out
}

// 版本比大小：只比 x.y.z 三段數字（預發布字尾不比）；a 比 b 舊回 -1、相同 0、較新 1；格式不對回 0（不亂提示）
export function compareVersion(a, b) {
  if (!VERSION.test(String(a)) || !VERSION.test(String(b))) return 0
  const n = v => v.split('-')[0].split('.').map(Number)
  const [x, y] = [n(a), n(b)]
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1
  return 0
}

// 設備分組標題旁的標記：{ status, version, tip, outdated }；那台沒有在線的 ASN 回傳 null。
// 一台設備有多個 ASN 視窗時，狀態取最「在線」的（線上 > 忙碌 > 暫離）、版本取最新的；outdated＝比自己的版本舊（只是提示）。
export function deviceAsn(rows, myVersion) {
  if (!Array.isArray(rows) || !rows.length) return null
  const rank = s => ({ online: 0, busy: 1, away: 2 })[s] ?? 3
  const status = rows.map(r => r.status).sort((a, b) => rank(a) - rank(b))[0]
  const version = rows.map(r => r.version).sort((a, b) => compareVersion(b, a))[0]
  const outdated = compareVersion(version, myVersion) < 0
  return { status, version, outdated, tip: `ASN ${version} ${LABEL[status]}` }
}
