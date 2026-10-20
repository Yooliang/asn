// 本機假 relay（測試與 --shot 驅動用）：只在記憶體裡，不碰真實後端。
// 行為照 supabase/functions/irori-relay/index.ts：x-relay-key 標頭、list／inbox&agent／ack&agent／send／whoami。
import http from 'node:http'

export const U = n => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`
export const FAKE_KEY = 'fake-machine-key'

export async function startFakeRelay({ node = 'T', members = [], mails = [], port = 0 } = {}) {
  const st = { node, members, mails: [...mails], reqs: [], sent: [], port: 0, url: '' }
  const readBody = req => new Promise(r => { let b = ''; req.on('data', d => (b += d)); req.on('end', () => r(b ? JSON.parse(b) : null)) })
  const srv = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x'), action = u.searchParams.get('action'), agent = u.searchParams.get('agent')
    const body = await readBody(req)
    st.reqs.push({ action, agent, method: req.method, key: req.headers['x-relay-key'], body })
    const out = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)) }
    if (req.headers['x-relay-key'] !== FAKE_KEY) return out(401, { error: 'unauthorized' })
    if (action === 'whoami') return out(200, { node, bell_topic: 'bell-test' })
    if (action === 'list') return out(200, { members: st.members })
    if (action === 'inbox' && agent) return out(200, { messages: st.mails.filter(m => !m.acked && m.to_agent === agent) })
    if (action === 'ack' && agent) {
      let n = 0
      for (const m of st.mails) if (!m.acked && body.ids.includes(m.id) && m.to_agent === agent) { m.acked = true; n++ }
      return out(200, { acked: n })
    }
    if (action === 'send') {
      if (typeof body?.to_node !== 'string' || typeof body?.body !== 'string') return out(400, { error: 'bad_request' })
      st.sent.push(body)
      return out(200, { id: U(900 + st.sent.length) })
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
