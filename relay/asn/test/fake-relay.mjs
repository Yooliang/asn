// 本機假 relay（測試與 --shot 驅動用）：只在記憶體裡，不碰真實後端。
// 行為照 supabase/functions/irori-relay/index.ts：x-relay-key 標頭、list／inbox&agent／ack&agent／send／whoami。
import http from 'node:http'

export const U = n => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`
export const FAKE_KEY = 'fake-machine-key'

// avatars：節點 → data URL（設備上傳的大頭貼）。名單每個節點帶 avatar_updated_at（沒上傳＝沒有這個欄位）；圖用 GET avatar&node=<節點> 取。
// set_avatar（POST，只能改金鑰所屬的自己節點）：前綴須是 data:image/png|webp;base64,、全長 ≤ 48000，否則回白話代碼（同後端）。
export async function startFakeRelay({ node = 'T', members = [], mails = [], rooms = [], avatars = {}, port = 0 } = {}) {
  const st = {
    node, members, mails: [...mails], outbox: [], rooms,
    avatars: Object.fromEntries(Object.entries(avatars).map(([n, d]) => [n, { data: d, at: '2026-10-20T08:00:00Z' }])),
    reqs: [], sent: [], launches: [],
    launchers: { profiles: [{ id: 'claude', label: 'Claude' }], cwd_allow: ['C:/work'], max_per_hour: 6 },
    setCount: 1, port: 0, url: '',
  }
  const readBody = req => new Promise(r => { let b = ''; req.on('data', d => (b += d)); req.on('end', () => r(b ? JSON.parse(b) : null)) })
  const srv = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x'), action = u.searchParams.get('action'), agent = u.searchParams.get('agent')
    const body = await readBody(req)
    st.reqs.push({ action, agent, method: req.method, key: req.headers['x-relay-key'], body })
    const out = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)) }
    if (req.headers['x-relay-key'] !== FAKE_KEY) return out(401, { error: 'unauthorized' })
    if (action === 'whoami') return out(200, { node, bell_topic: 'bell-test' })
    if (action === 'list') return out(200, { members: st.members.map(m => (st.avatars[m.id] ? { ...m, avatar_updated_at: st.avatars[m.id].at } : m)) })
    if (action === 'avatar' && req.method === 'GET') {
      const a = st.avatars[u.searchParams.get('node')]
      return a ? out(200, { node: u.searchParams.get('node'), avatar: a.data, avatar_updated_at: a.at }) : out(404, { error: 'not_found' })
    }
    if (action === 'set_avatar' && req.method === 'POST') {
      const v = body?.avatar
      if (v === null) { delete st.avatars[node]; return out(200, { ok: true, avatar_updated_at: null }) }
      if (typeof v !== 'string' || !/^data:image\/(png|webp);base64,[A-Za-z0-9+/]+=*$/.test(v)) return out(400, { error: 'bad_avatar_format' })
      if (v.length > 48000) return out(400, { error: 'avatar_too_large' })
      const at = new Date(Date.now() + st.setCount++ * 1000).toISOString()
      st.avatars[node] = { data: v, at }
      return out(200, { ok: true, avatar_updated_at: at })
    }
    if (action === 'room_list' && req.method === 'GET') return out(200, { rooms: st.rooms })
    if (action === 'inbox' && agent) return out(200, { messages: st.mails.filter(m => !m.acked && m.to_agent === agent) })
    if (action === 'ack' && agent) {
      let n = 0
      for (const m of st.mails) if (!m.acked && body.ids.includes(m.id) && m.to_agent === agent) { m.acked = true; n++ }
      return out(200, { acked: n })
    }
    if (action === 'send') {
      if (typeof body?.to_node !== 'string' || typeof body?.body !== 'string') return out(400, { error: 'bad_request' })
      st.sent.push(body)
      const id = U(900 + st.sent.length)
      st.outbox.push({
        id,
        from_node: node,
        to_node: body.to_node,
        to_agent: body.to_agent ?? null,
        body: body.body,
        reply_to: body.reply_to ?? null,
        created_at: new Date().toISOString(),
        delivered_at: null,
        acked_at: null,
      })
      return out(200, { id })
    }
    if (action === 'sent_status' && req.method === 'POST') {
      const ids = body?.ids
      if (!Array.isArray(ids) || ids.length > 50) return out(400, { error: 'bad_ids' })
      const rows = st.outbox.filter(m => m.from_node === node && ids.includes(m.id)).map(m => ({
        id: m.id,
        delivered_at: m.delivered_at,
        acked_at: m.acked_at,
        replied_at: st.mails.concat(st.outbox).reduce((t, r) => {
          if (r.reply_to !== m.id) return t
          const c = r.created_at
          return !t || (c && c < t) ? c : t
        }, null),
      }))
      return out(200, { status: rows })
    }
    if (action === 'launch' && req.method === 'POST') {
      const id = U(800 + st.launches.length + 1)
      st.launches.push({ id, status: 'pending', ...body })
      return out(200, { id })
    }
    if (action === 'launchers') {
      const ids = body?.ids
      if (Array.isArray(ids) && ids.length) {
        return out(200, { launches: st.launches.filter(l => ids.includes(l.id)).map(l => ({ id: l.id, status: l.status ?? 'ok', detail: l.detail ?? '' })) })
      }
      return out(200, { machines: [{ node, launcher: st.launchers }], launches: st.launches })
    }
    out(404, { error: 'not_found' })
  })
  await new Promise(r => srv.listen(port, '127.0.0.1', r))
  st.port = srv.address().port
  st.url = `http://127.0.0.1:${st.port}/relay`
  st.close = () => new Promise(r => { srv.closeAllConnections?.(); srv.close(r) })
  st.mail = (n, extra = {}) => {
    const m = { id: U(n), from_node: 'W', from_agent: 'W-政策', to_node: node, to_agent: 'T-ASN', body: `信${n}`, reply_to: null, created_at: '2026-10-20T08:00:00Z', trust: 'member', expects_reply: true, acked: false, ...extra }
    st.mails.push(m)
    return m
  }
  return st
}
