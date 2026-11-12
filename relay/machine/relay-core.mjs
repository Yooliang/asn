// 仲介（relay）共用小模組：API 呼叫、ack、Realtime 門鈴、單一執行個體 pid 檔。
// createCore 目前只有 bridge-aegis.mjs 使用；寄信的 client_id 與重試（withClientId／retrySend）bridge.mjs、send.mjs 也共用。純 Node，無依賴。
import path from 'node:path'
import crypto from 'node:crypto'
import { acquireLock } from './bridge-lock.mjs'

export const API_TIMEOUT_MS = 20_000
export const BELL_HEARTBEAT_MS = 25_000
export const BELL_STALE_MS = 75_000   // 三個心跳週期都沒收到任何東西（含心跳回覆）＝連線半開，主動斷開重連

// ---- 寄信的 client_id 與重試（#1135）-----------------------------------------------------------------
// 同一次寄信帶一個 client_id（UUID），重試之間沿用同一個；後台在同一個寄件節點內據此去重，
// 所以請求可能已經送達、回應卻讀失敗時，重送也不會寄出兩封。只有 action＝send 會帶 client_id 與重試；其他動作完全不變。
export const SEND_RETRY_MS = [200, 500, 1000]

/** send 動作的內文補上 client_id（呼叫端自己帶了就沿用）；其他動作、沒有內文原樣回傳 */
export function withClientId(action, body) {
  if (action !== 'send' || !body || typeof body !== 'object' || Array.isArray(body)) return body
  return typeof body.client_id === 'string' && body.client_id ? body : { ...body, client_id: crypto.randomUUID() }
}

/** 值得重送的失敗：連線失敗、逾時、讀回應失敗（沒有 HTTP 狀態）或閘道暫時錯誤 502／503／504 */
export function retriable(e) {
  const s = e?.status
  return s === undefined || s === null || (s >= 502 && s <= 504)
}

/** 只有 send 才重試（內文要已經帶 client_id）；其他動作只呼叫一次 */
export async function retrySend(action, fn, { delays = SEND_RETRY_MS, sleep = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
  if (action !== 'send') return await fn()
  for (let i = 0; ; i++) {
    try { return await fn() } catch (e) {
      if (i >= delays.length || !retriable(e)) throw e
      await sleep(delays[i])
    }
  }
}

export function createCore({ baseUrl, key, anonKey, log, workDir, apiTimeoutMs = API_TIMEOUT_MS, bellHeartbeatMs = BELL_HEARTBEAT_MS, bellStaleMs = BELL_STALE_MS }) {
  const BASE = baseUrl.replace(/\/+$/, '')
  const sleep = ms => new Promise(r => setTimeout(r, ms))

  // 整個呼叫（連線、等回應、讀完內容）一個時限。不用 AbortSignal.timeout：它的計時器是 unref 的、訊號也沒人強持有，
  // 曾經懷疑過在長時間運作的行程裡不會觸發（#177，正見的收信停擺）；這裡用一般計時器＋外層再包一道競賽，兩道都擋。
  async function api(action, { method = 'GET', body } = {}) {
    // 寄信：一次寄信一個 client_id，重試沿用（#1135）；其他動作只呼叫一次
    const sendBody = body ? withClientId(action, body) : body
    return await retrySend(action, () => apiOnce(action, { method, body: sendBody }))
  }
  async function apiOnce(action, { method = 'GET', body } = {}) {
    const ac = new AbortController()
    let timer
    const work = (async () => {
      const res = await fetch(`${BASE}?action=${action}`, {
        method,
        headers: { 'x-relay-key': key, ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: ac.signal,
      })
      const text = await res.text()
      let data = null
      try { data = JSON.parse(text) } catch {}
      if (!res.ok) { const e = new Error(`${action} HTTP ${res.status} ${data?.error ?? ''}`.trim()); e.status = res.status; throw e }
      return data
    })()
    work.catch(() => {})   // 逾時放棄之後才失敗的，不變成 unhandled rejection
    const limit = new Promise((_, reject) => {
      timer = setTimeout(() => {
        ac.abort()
        const e = new Error(`${action} timeout after ${apiTimeoutMs}ms`); e.code = 'ETIMEDOUT'; reject(e)
      }, apiTimeoutMs)
    })
    try { return await Promise.race([work, limit]) } finally { clearTimeout(timer) }
  }

  // 同一個節點只能有一個收信者：pid 檔記的橋還在跑（編號活著、且不是寫檔之後才啟動的，見 bridge-lock.mjs）就退出（exit 3）。
  // 非同步：查程序啟動時間不卡住啟動；呼叫端要 await。
  async function singleInstance() {
    const got = await acquireLock(path.join(workDir, 'bridge.pid'))
    if (!got.ok) { console.error(`another bridge is running (pid ${got.pid})`); process.exit(3) }
  }

  // Realtime 門鈴（phoenix channels）；斷線指數退避重連
  let backoff = 1000
  function connectBell(topic, onBell) {
    if (!anonKey) { log('no anon key: doorbell off, polling only'); return }
    const url = `wss://${new URL(BASE).host}/realtime/v1/websocket?apikey=${encodeURIComponent(anonKey)}&vsn=1.0.0`
    let ref = 0, closed = false, hb = null, ws = null, lastRx = Date.now()
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
      lastRx = Date.now()
      send('realtime:' + topic, 'phx_join', { config: { broadcast: { self: false, ack: false }, presence: { key: '' }, postgres_changes: [], private: false } })
      hb = setInterval(() => {
        // 半開偵測：機器暫停或還原後，TCP 連線可能還「看起來連著」但再也收不到東西（也收不到我們心跳的回覆）。
        // 太久沒收到任何訊息就自己斷開，走重連（重連成功會補拉一次）
        if (Date.now() - lastRx > bellStaleMs) { try { ws.close() } catch {}; die('stale: no frames from server'); return }
        try { send('phoenix', 'heartbeat') } catch {}
      }, bellHeartbeatMs)
    }
    ws.onmessage = ev => {
      lastRx = Date.now()
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
