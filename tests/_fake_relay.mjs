// 測試用的假仲介（node http）：只實作註冊／whoami／leave，規則照後端 register（邀請碼一次性、前綴、代號格式、撞名）。
// 絕不連真的仲介。用法：const srv = await fakeRelay({ invites: { CODE1: {}, CODE2: { prefix: 'W-' } } })
import http from 'node:http'
import crypto from 'node:crypto'

export async function fakeRelay({ invites = {}, takenIds = [] } = {}) {
  const st = { reqs: [], keys: new Map(), issued: [], invites: { ...invites }, nodes: new Set(takenIds), registers: [] }
  const srv = http.createServer((req, res) => {
    let raw = ''
    req.on('data', d => { raw += d })
    req.on('end', () => {
      const u = new URL(req.url, 'http://x')
      const action = u.searchParams.get('action')
      let body = null
      try { body = raw ? JSON.parse(raw) : null } catch { /* 留給下面當 bad_request */ }
      st.reqs.push({ action, method: req.method, key: req.headers['x-relay-key'] || null, body })
      const send = (status, obj) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)) }

      if (action === 'register' && req.method === 'POST') {
        st.registers.push(body)
        if (!body || typeof body.id !== 'string' || !/^[A-Za-z0-9_-]{1,32}$/.test(body.id) || typeof body.invite !== 'string') return send(400, { error: 'bad_request' })
        const inv = st.invites[body.invite]
        if (!inv || inv.used) return send(403, { error: 'invalid_invite' })
        if (inv.prefix && !body.id.startsWith(inv.prefix)) return send(403, { error: 'bad_id_prefix', prefix: inv.prefix })
        if (typeof body.name !== 'string' || typeof body.machine !== 'string' || body.machine.length < 1 || body.machine.length > 40) return send(400, { error: 'bad_request' })
        if (st.nodes.has(body.id)) return send(409, { error: 'id_taken' })
        inv.used = true
        const key = crypto.randomBytes(24).toString('base64url')
        st.keys.set(key, body.id); st.nodes.add(body.id); st.issued.push(key)
        return send(200, { id: body.id, key, bell_topic: 'relay-bell-test' })
      }
      const node = st.keys.get(req.headers['x-relay-key'])
      if (!node) return send(401, { error: 'unauthorized' })
      if (action === 'whoami') return send(200, { node, bell_topic: 'relay-bell-test' })
      if (action === 'leave' && req.method === 'POST') {
        for (const [k, v] of st.keys) if (v === node) st.keys.delete(k)
        st.nodes.delete(node)
        return send(200, { ok: true })
      }
      return send(400, { error: 'bad_request' })
    })
  })
  await new Promise(r => srv.listen(0, '127.0.0.1', r))
  st.url = `http://127.0.0.1:${srv.address().port}/functions/v1/irori-relay`
  st.close = () => new Promise(r => { srv.closeAllConnections?.(); srv.close(r) })
  return st
}
