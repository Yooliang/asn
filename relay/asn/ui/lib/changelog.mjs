// 版本更新記錄的純邏輯（打包腳本、介面與測試共用）：把 CHANGELOG.md 轉成清單，並排出設定「更新」分類要顯示的條目。
import { compareVersions } from './update.mjs'

const HEAD = /^##\s+v?(\d+\.\d+\.\d+)\s*(?:[（(]\s*([^）)]*?)\s*[）)])?\s*$/

// 解析：由上到下（新到舊）回傳 [{ version, date, lines }]；lines 去掉「- 」符號與空行
export const parseChangelog = text => {
  const out = []
  let cur = null
  for (const raw of String(text ?? '').replace(/\r\n/g, '\n').split('\n')) {
    const m = HEAD.exec(raw.trim())
    if (m) { cur = { version: m[1], date: m[2] ?? '', lines: [] }; out.push(cur); continue }
    if (/^#{1,2}\s/.test(raw)) { cur = null; continue }
    if (!cur) continue
    const line = raw.trim().replace(/^[-*]\s+/, '')
    if (line) cur.lines.push(line)
  }
  return out
}

// 說明文字（latest.json 的 notes）轉成條列
export const notesToLines = notes => String(notes ?? '').split(/\r?\n/).map(s => s.trim().replace(/^[-*]\s+/, '')).filter(Boolean)

// 設定畫面的條目：新到舊；目前版本標 current；已查到比目前新的版本放最上面標 update（說明用 update_check 的 notes）。
// 還沒發出去的版本（比目前版本新、又不是已查到的新版）不顯示。
export const buildLogView = ({ entries = [], current = '', available = null } = {}) => {
  const items = entries
    .filter(e => compareVersions(e.version, current) !== 1)
    .map(e => ({ version: e.version, date: e.date, lines: e.lines, tag: e.version === current ? 'current' : '' }))
  if (available?.version && compareVersions(available.version, current) === 1) {
    const known = entries.find(e => e.version === available.version)
    const lines = notesToLines(available.notes)
    items.unshift({ version: available.version, date: known?.date ?? '', lines: lines.length ? lines : (known?.lines ?? []), tag: 'update' })
  }
  return items
}

// 寫進 CHANGELOG：給了 --notes 時在最上面加一段（同版本已存在就替換）。notes 多行會逐行變成「- 」條列
export const addChangelogSection = (text, { version, date, notes }) => {
  const body = notesToLines(notes).map(l => `- ${l}`).join('\n')
  const section = `## ${version}（${date}）\n${body}\n`
  const lines = String(text ?? '').replace(/\r\n/g, '\n').split('\n')
  const same = lines.findIndex(l => { const m = HEAD.exec(l.trim()); return m && m[1] === version })
  if (same >= 0) {
    let end = lines.findIndex((l, i) => i > same && /^##\s/.test(l))
    if (end < 0) end = lines.length
    const tail = lines.slice(end)
    return [...lines.slice(0, same), ...section.split('\n'), ...(tail.length ? tail : [])].join('\n').replace(/\n{3,}/g, '\n\n')
  }
  const first = lines.findIndex(l => /^##\s/.test(l))
  if (first < 0) return `${lines.join('\n').replace(/\s*$/, '')}\n\n${section}`
  return [...lines.slice(0, first), ...section.split('\n'), ...lines.slice(first)].join('\n')
}
