// 藍圖頁與開發日誌頁的畫面：一律用 createElement＋textContent 建節點，資料庫內容絕不當 HTML 插入。
// 守門測試會掃這個資料夾，不准出現 innerHTML 這類寫法。兩頁共用同一套時間軸樣式（style.css 的 .tl）。
import { parseBlocks, STATUS_LABEL, MEETING_FIELDS, issueUrl, taipeiParts, EMPTY_LANE_TEXT } from './model.mjs'

const ATTRS = new Set(['class', 'id', 'scope', 'data-label', 'aria-label', 'aria-hidden', 'role', 'rel', 'target'])

// 建一個元素；attrs 只收白名單內的屬性，children 可以是字串（當純文字）或節點
export function h(tag, attrs, ...children) {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v == null || v === false) continue
    if (!ATTRS.has(k)) throw new Error(`不允許的屬性：${k}`)
    el.setAttribute(k, String(v))
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue
    el.append(typeof c === 'string' ? document.createTextNode(c) : c)
  }
  return el
}

// 連結只接受已驗證的 http(s) 網址（issueUrl 內部已檢查）
function link(href, text) {
  if (!href) return document.createTextNode(text)
  const a = h('a', { rel: 'noopener noreferrer', target: '_blank' }, text)
  a.href = href
  return a
}

function inline(parts) {
  return parts.map(p => {
    if (p.t === 'strong') return h('strong', null, p.v)
    if (p.t === 'code') return h('code', null, p.v)
    if (p.t === 'ref') return h('span', { class: 'ref' }, p.v)
    return document.createTextNode(p.v)
  })
}

// 內文：第一段接在 lead（例如標題）後面同一行，其餘段落與子清單接在下面
export function rich(text, lead) {
  const frag = document.createDocumentFragment()
  const blocks = parseBlocks(text)
  const first = blocks[0]?.kind === 'p' ? blocks.shift() : null
  if (lead || first) frag.append(h('span', { class: 'line' }, lead ?? null, first ? inline(first.parts) : null))
  for (const b of blocks) {
    if (b.kind === 'p') frag.append(h('p', null, inline(b.parts)))
    else frag.append(h('ul', null, b.items.map(parts => h('li', null, inline(parts)))))
  }
  return frag
}

export function refs(list) {
  const nums = (list ?? []).filter(n => Number.isInteger(n) && n > 0)
  if (!nums.length) return null
  return h('span', { class: 'refs', 'aria-label': '相關議題' }, nums.flatMap((n, i) => [i ? ' ' : null, link(issueUrl(n), `#${n}`)]))
}

// 藍圖／待辦的一個項目：**標題**：內文＋議題編號
export function itemNode(item, tagText) {
  const lead = item.title ? [h('strong', null, item.title), '：'] : null
  return h('li', null, rich(item.body, lead), tagText ? h('span', { class: 'tag' }, tagText) : null, refs(item.refs))
}

// ---- 時間軸 ----
function tlItem(kindClass, dateText, card, id) {
  return h('li', { class: `tl-item ${kindClass}`, id },
    h('span', { class: 'tl-dot', 'aria-hidden': 'true' }),
    h('div', { class: 'tl-date' }, dateText),
    card)
}
const chip = (cls, text) => h('span', { class: `tl-kind ${cls}` }, text)

export function releaseCard(release, extraItems, version) {
  const v = release?.version ?? version
  const card = h('article', { class: 'glass tl-card' },
    h('h3', null, chip('release', '發版'), v))
  if (release) {
    const facts = []
    if (release.platforms?.length) facts.push(`發佈到：${release.platforms.join('、')}`)
    if (release.commit_sha) facts.push(`發版 commit ${release.commit_sha}`)
    if (facts.length) card.append(h('p', { class: 'tl-meta' }, facts.join('；')))
    card.append(h('ul', null, (release.items ?? []).map(t => h('li', null, rich(t)))))
    if (release.notes) card.append(h('div', { class: 'tl-notes' }, rich(release.notes)))
  }
  if (extraItems?.length) {
    card.append(h('p', { class: 'tl-sub' }, release ? '藍圖裡的項目' : '藍圖裡隨這版發佈的項目'))
    card.append(h('ul', null, extraItems.map(i => itemNode(i))))
  }
  return card
}

function listCard(chipCls, chipText, title, items) {
  return h('article', { class: 'glass tl-card' },
    h('h3', null, chip(chipCls, chipText), title),
    h('ul', null, items.map(i => itemNode(i))))
}

// 藍圖頁：過去 →「現在」→ 未來
export function roadmapTimeline(tl) {
  const nodes = []
  if (tl.earlier.length) nodes.push(tlItem('is-past', '更早', listCard('done', '已完成', '更早完成的功能', tl.earlier)))
  for (const n of tl.past) nodes.push(tlItem('is-past', n.release?.released_on ?? '已發佈', releaseCard(n.release, n.items, n.version)))
  nodes.push(tlItem('is-now', '現在', listCard('now', '進行中', tl.latest ? `目前最新版 ${tl.latest}` : '目前', tl.now), 'now'))
  for (const n of tl.future) nodes.push(tlItem('is-future', '預定', listCard('future', '預定', n.version, n.items)))
  if (tl.later.length) nodes.push(tlItem('is-future', '之後', listCard('future', '規劃中', '還沒排定版本', tl.later)))
  return h('ol', { class: 'tl' }, nodes)
}

// 開發日誌：會議與發版合成一條，最新在上
export function logTimeline(entries) {
  return h('ol', { class: 'tl' }, entries.map(e => e.kind === 'release'
    ? tlItem('is-release', e.date, releaseCard(e.release))
    : tlItem('is-meeting', `${e.date} ${e.time}`, meetingCard(e.meeting))))
}

export function meetingCard(m) {
  const { date, time } = taipeiParts(m.held_at)
  const dl = h('dl', { class: 'tl-fields' })
  for (const [k, label] of MEETING_FIELDS) {
    const list = m[k] ?? []
    dl.append(h('dt', null, label), h('dd', null, list.length === 1 ? rich(list[0]) : h('ul', null, list.map(t => h('li', null, rich(t))))))
  }
  return h('article', { class: 'glass tl-card' }, h('h3', null, chip('meeting', '會議'), `小會議 ${date} ${time}`), dl)
}

// ---- 待辦欄位 ----
export function lanesView(lanes) {
  return h('div', { class: 'road' }, lanes.map(l => h('div', { class: 'glass lane' },
    h('h3', null, h('span', { class: `status ${l.tone}` }, l.label)),
    l.items.length ? h('ul', null, l.items.map(i => itemNode(i))) : h('p', { class: 'lane-empty' }, EMPTY_LANE_TEXT))))
}

// ---- 支援總表 ----
export function matrixView(m) {
  const head = h('tr', null, h('th', { scope: 'col' }, 'AI'), m.columns.map(c => h('th', { scope: 'col' }, c.label)), h('th', { scope: 'col' }, '備註與限制'))
  const body = m.rows.map(r => h('tr', null,
    h('th', { scope: 'row', 'data-label': 'AI' }, h('strong', null, r.name), h('span', { class: 'kind' }, r.kind)),
    r.cells.map((c, i) => h('td', { 'data-label': m.columns[i].label },
      h('span', { class: `st st-${STATUS_LABEL[c.status] ? c.status : 'tbc'}` }, STATUS_LABEL[c.status] ?? STATUS_LABEL.tbc),
      h('div', { class: 'cell-body' }, rich(c.body), refs(c.refs)))),
    h('td', { 'data-label': '備註與限制', class: 'note-cell' }, rich(r.note))))
  return h('table', { class: 'matrix' },
    h('caption', null, '各家 AI 與各項管理功能的現況（各格的版本與驗證狀態以格內文字為準）'),
    h('thead', null, head),
    h('tbody', null, body))
}

// 讀取狀態：畫面只放一句使用者看得懂的話，細節進 console
export function showStatus(el, text) {
  if (!el) return
  el.textContent = text
  el.hidden = !text
}
