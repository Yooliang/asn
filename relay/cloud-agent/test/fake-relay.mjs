// 雲端代理測試用的本機假 relay（只在記憶體，只聽 127.0.0.1；行為照 supabase/functions/irori-relay/index.ts）。
// 比 relay/asn/test/fake-relay.mjs 多了 register、節點信箱（不帶 agent 的 inbox／ack）、roster（可設成 403）。
import http from 'node:http'

export const U = n => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`
export const FAKE_KEY = 'fake-grok-node-key'
export const INVITE = 'good-invite-code'
export const ISSUED_KEY = 'issued-secret-key-for-test'

export async function startFakeRelay({ node = 'grok', rosterStatus = 200, onAck = null, inboxFailRemaining = 0 } = {}) {
  const st = { mails: [], reqs: [], sent: [], rosters: [], acks: [], rosterStatus, url: '', port: 0 }
  let inboxFailsLeft = inboxFailRemaining
  const readBody = req => new Promise(r => { let b = ''; req.on('data', d => (b += d)); req.on('end', () => r(b ? JSON.parse(b) : null)) })
  const srv = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x'), action = u.searchParams.get('action')
    const body = await readBody(req)
    st.reqs.push({ action, method: req.method, key: req.headers['x-relay-key'], body })
    const out = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)) }
    if (action === 'register') {
      st.registerBody = body
      if (body?.invite !== INVITE) return out(403, { error: 'invalid_invite' })
      if (body.id === 'taken') return out(409, { error: 'id_taken' })
      return out(200, { id: body.id, key: ISSUED_KEY, bell_topic: 'bell-x' })
    }
    const k = req.headers['x-relay-key']
    if (k !== FAKE_KEY && k !== ISSUED_KEY) return out(401, { error: 'unauthorized' })
    if (action === 'whoami') return out(200, { node, bell_topic: 'bell-test' })
    if (action === 'inbox') {
      if (inboxFailsLeft > 0) { inboxFailsLeft--; return out(500, { error: 'server_error' }) }
      return out(200, { messages: st.mails.filter(m => !m.acked) })
    }
    if (action === 'ack') {
      st.acks.push(body.ids)
      onAck?.(body.ids)
      for (const m of st.mails) if (body.ids.includes(m.id)) m.acked = true
      return out(200, { acked: body.ids.length })
    }
    if (action === 'roster') {
      st.rosters.push(body)
      if (st.rosterStatus !== 200) return out(st.rosterStatus, { error: 'forbidden' })
      return out(200, { ok: true, count: body.agents.length })
    }
    if (action === 'send') {
      if (typeof body?.to_node !== 'string' || typeof body?.body !== 'string') return out(400, { error: 'bad_request' })
      st.sent.push(body)
      return out(200, { id: U(900 + st.sent.length) })
    }
    out(404, { error: 'not_found' })
  })
  await new Promise(r => srv.listen(0, '127.0.0.1', r))
  st.port = srv.address().port
  st.url = `http://127.0.0.1:${st.port}/relay`
  st.close = () => new Promise(r => { srv.closeAllConnections?.(); srv.close(r) })
  st.mail = (n, extra = {}) => {
    const m = { id: U(n), from_node: 'W', from_agent: 'W-政策', to_node: node, to_agent: 'Grok', body: `信${n}`, reply_to: null, created_at: '2026-10-20T08:00:00Z', trust: 'member', expects_reply: true, acked: false, ...extra }
    st.mails.push(m)
    return m
  }
  return st
}
