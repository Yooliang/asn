// 群組裡的 @ 點名（#226）的純邏輯：輸入時的成員選單、選好後寫回輸入框、訊息裡 @名字 變成小標記。
// 後台本來就會從內文解析「@名字」（supabase/functions/_shared/rooms.ts 的 parseMentions），所以這裡只負責輸入與顯示，不另送欄位。
// 名字一律用成員的完整標示（真人＝帳號名、自己的 AI＝「夥伴名（設備名）」、別人帳號的 AI＝「夥伴名（主人名）」，後台的 display_label，舊後台退回 label），與後台解析用的名字同一份；不顯示任何成員鍵。
import { KIND_BADGE, safeLabel } from './groups.mjs'
import { esc } from './text.mjs'

export const MENTION_MAX_QUERY = 20
export const MENTION_MAX_OPTIONS = 8

// 可以被點名的成員（只給畫面用的 { label, kind }）：自己（本人）不用點；沒有名字的略過；同名只留一個（後台也只認得第一個）
export function mentionTargets(members) {
  const seen = new Set(), out = []
  for (const m of Array.isArray(members) ? members : []) {
    if (!m) continue
    const kind = m.member_kind === 'ai' || (m.member_kind !== 'human' && (m.kind === 'window' || m.kind === 'ai')) ? 'ai' : 'human'
    if (kind === 'human' && m.mine === true) continue
    const label = safeLabel(m.display_label || m.label || m.name)
    if (!label || /\s{2,}|[@\n]/.test(label) || seen.has(label)) continue
    seen.add(label); out.push({ label, kind })
  }
  return out.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'human' ? -1 : 1))
}

// 輸入框游標前面正在打的「@字」：@ 要在開頭或空白之後，後面到游標之間不能有空白；回 { start, query } 或 null
export function mentionQuery(text, caret) {
  const t = String(text ?? '')
  const c = Number.isInteger(caret) ? Math.min(Math.max(caret, 0), t.length) : t.length
  const at = t.lastIndexOf('@', c - 1)
  if (at < 0 || (at > 0 && !/\s/.test(t[at - 1]))) return null
  const q = t.slice(at + 1, c)
  if (/\s/.test(q) || [...q].length > MENTION_MAX_QUERY) return null
  return { start: at, query: q }
}

// 依打到一半的字篩選（不分大小寫、包含即可，打得越像排越前）
export function mentionOptions(targets, query) {
  const q = String(query ?? '').trim().toLowerCase()
  const list = (Array.isArray(targets) ? targets : []).filter(t => !q || t.label.toLowerCase().includes(q))
  list.sort((a, b) => Number(b.label.toLowerCase().startsWith(q)) - Number(a.label.toLowerCase().startsWith(q)))
  return list.slice(0, MENTION_MAX_OPTIONS).map(t => ({ ...t, badge: KIND_BADGE[t.kind] ?? '' }))
}

// 選好一位：把「@打到一半的字」換成「@完整名字 」，游標落在空白之後
export function applyMention(text, q, label) {
  const t = String(text ?? '')
  const end = q.start + 1 + q.query.length
  const next = t.slice(end)
  const ins = `@${label}`
  const gap = /^\s/.test(next) ? '' : ' '
  return { text: t.slice(0, q.start) + ins + gap + next, caret: q.start + ins.length + 1 }
}

// ---- 顯示：把已轉成安全 HTML 的內文裡的 @名字 包成小標記 ----
const BOUNDARY = '(?![-_])(?=$|[\\s\\p{P}\\p{S}])'
// 內文是 renderMarkdown 的輸出（已跳脫、已淨化）；只動標籤之間的文字，程式碼與連結裡不動。labels 是成員完整標示
export function markMentions(html, labels) {
  const names = [...new Set((Array.isArray(labels) ? labels : []).filter(Boolean))].sort((a, b) => b.length - a.length)
  if (!names.length || !String(html).includes('@')) return String(html)
  const alt = names.map(n => esc(n).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
  const re = new RegExp(`@(${alt})${BOUNDARY}`, 'giu')
  let skip = 0
  return String(html).split(/(<[^>]+>)/).map(seg => {
    if (seg.startsWith('<')) {
      if (/^<(code|pre|a)[\s>]/i.test(seg)) skip++
      else if (/^<\/(code|pre|a)>/i.test(seg)) skip = Math.max(0, skip - 1)
      return seg
    }
    return skip ? seg : seg.replace(re, (all, name) => `<span class="mention">@${name}</span>`)
  }).join('')
}
