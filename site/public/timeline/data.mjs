// 從資料庫讀官網內容（Supabase PostgREST，公開唯讀的 asn_site_* 表）。
// 用的是 Supabase 的 anon 公開金鑰（任何網頁前端都看得到），與核准頁共用同一份設定（/link/config.mjs），不另外抄一份。
// 頁面的內容安全政策只對 /roadmap 與 /log 開放連到這個網址（site/firebase.json）。
import { AUTH_BASE, ANON_KEY } from '../link/config.mjs'

const REST = `${AUTH_BASE}/rest/v1/`
const TIMEOUT_MS = 15000

// 各表要讀的欄位與排序（版本的先後在前端用語意版本排，這裡只求穩定）
export const QUERIES = {
  releases: 'asn_site_releases?select=version,released_on,items,platforms,commit_sha,notes&order=released_on.desc,version.desc',
  meetings: 'asn_site_meetings?select=id,held_at,attendees,progress,decisions,assignments,improvements&order=held_at.desc',
  lanes: 'asn_site_lanes?select=section,lane,label,tone,sort_order&order=section.asc,sort_order.asc',
  items: 'asn_site_roadmap_items?select=item_key,section,lane,title,body,refs,status,version,sort_order&order=section.asc,lane.asc,sort_order.asc',
  columns: 'asn_site_matrix_columns?select=column_key,label,sort_order&order=sort_order.asc',
  rows: 'asn_site_matrix_rows?select=row_key,name,kind,note,sort_order&order=sort_order.asc',
  cells: 'asn_site_matrix_cells?select=row_key,column_key,status,body,refs',
}

async function getJson(name) {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS)
  try {
    const r = await fetch(REST + QUERIES[name], {
      headers: { apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}`, Accept: 'application/json' },
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      signal: ctl.signal,
    })
    if (!r.ok) throw new Error(`${name}: HTTP ${r.status}`)
    const body = await r.json()
    if (!Array.isArray(body)) throw new Error(`${name}: 回應不是陣列`)
    return body
  } finally {
    clearTimeout(timer)
  }
}

// 一次讀需要的幾張表；任何一張失敗就整個丟錯（畫面顯示一句「暫時讀不到資料」，細節在 console）
export async function load(names) {
  const lists = await Promise.all(names.map(getJson))
  return Object.fromEntries(names.map((n, i) => [n, lists[i]]))
}
