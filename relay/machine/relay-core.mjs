// 仲介（relay）共用小模組：API 呼叫、ack、Realtime 門鈴、單一執行個體 pid 檔。
// 目前只有 bridge-aegis.mjs 使用（bridge.mjs 為 Windows 家用機常駐中，暫不動它）。純 Node，無依賴。
import fs from 'node:fs'
import path from 'node:path'

export function createCore({ baseUrl, key, anonKey, log, workDir }) {
  const BASE = baseUrl.replace(/\/+$/, '')
  const sleep = ms => new Promise(r => setTimeout(r, ms))

  async function api(action, { method = 'GET', body } = {}) {
    const res = await fetch(`${BASE}?action=${action}`, {
      method,
      headers: { 'x-relay-key': key, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20_000),
    })
    const text = await res.text()
    let data = null
    try { data = JSON.parse(text) } catch {}
    if (!res.ok) { const e = new Error(`${action} HTTP ${res.status} ${data?.error ?? ''}`.trim()); e.status = res.status; throw e }
    return data
  }

  // 同一個節點只能有一個收信者：pid 檔裡有活著的 pid 就退出（exit 3）
  function singleInstance() {
    const lock = path.join(workDir, 'bridge.pid')
    try {
      const old = Number(fs.readFileSync(lock, 'utf8'))
      if (old && old !== process.pid) { try { process.kill(old, 0); console.error(`another bridge is running (pid ${old})`); process.exit(3) } catch (e) { if (e.code === 'EPERM') process.exit(3) } }
    } catch {}
    fs.writeFileSync(lock, String(process.pid))
    process.on('exit', () => { try { if (Number(fs.readFileSync(lock, 'utf8')) === process.pid) fs.unlinkSync(lock) } catch {} })
  }

  // Realtime 門鈴（phoenix channels）；斷線指數退避重連
  let backoff = 1000
  function connectBell(topic, onBell) {
    if (!anonKey) { log('no anon key: doorbell off, polling only'); return }
    const url = `wss://${new URL(BASE).host}/realtime/v1/websocket?apikey=${encodeURIComponent(anonKey)}&vsn=1.0.0`
    let ref = 0, closed = false, hb = null, ws = null
    const send = (t, event, payload = {}) => ws.send(JSON.stringify({ topic: t, event, payload, ref: String(++ref), join_ref: '1' }))
    const die = why => {
      if (closed) return
      closed = true; clearInterval(hb)
      log(`doorbell down (${why}); retry in ${backoff}ms`)
      setTimeout(() => connectBell(topic, onBell), backoff)
      backoff = Math.min(backoff * 2, 30_000)
    }
    try { ws = new WebSocket(url) } catch (e) { die(String(e)); return }
    ws.onopen = () => {
      send('realtime:' + topic, 'phx_join', { config: { broadcast: { self: false, ack: false }, presence: { key: '' }, postgres_changes: [], private: false } })
      hb = setInterval(() => { try { send('phoenix', 'heartbeat') } catch {} }, 25_000)
    }
    ws.onmessage = ev => {
      let m; try { m = JSON.parse(ev.data) } catch { return }
      if (m.event === 'phx_reply' && m.topic === 'realtime:' + topic) {
        if (m.payload?.status === 'ok') { backoff = 1000; log('doorbell joined'); onBell('join') }
      } else if (m.event === 'broadcast' && m.payload?.event === 'bell') onBell('bell')
      else if (m.event === 'phx_error' || m.event === 'phx_close') { try { ws.close() } catch {}; die(m.event) }
    }
    ws.onerror = () => die('error')
    ws.onclose = () => die('close')
  }

  return { api, singleInstance, connectBell, sleep }
}
