// 帳號卡設備列「切換」的結果：原位顯示、切換後畫面同步（#2111 ③、#2110）。電腦（claude-accounts／settings-panel）與手機（m.js）共用這一份。
// 純邏輯：不碰 DOM、不碰 Tauri。按下去 → 那一列「切換中…」→ 結果出來 → 重讀帳號列表直到那一列真的變成「使用中」→ 那一列下方顯示一句話。
// 成功＝綠色（約 6 秒後自己消失）；失敗＝紅色（留著到再按一次）；不跳框。原文（錯誤代碼、回應內容）只進 log。

export const SWITCH_RESULT_OK_MS = 6000     // 成功那一句停留多久
export const SWITCH_SYNC_MS = 30000         // 成功後等列表更新最多多久，期間那一列維持「切換中…」
export const SWITCH_SYNC_POLL_MS = 3000     // 等列表更新時每隔多久重讀一次

export const SWITCH_RESULT_TEXT = Object.freeze({
  ok: label => `已切換，${label || '那台'} 現在用這個帳號。`,
  fail: why => `沒有切換成功：${why}`,
  waiting: '已送出，等那台回報；稍後這裡會自動更新。',
})

// 後台錯誤代碼 → 一句白話（說發生什麼、怎麼辦）
const CODE_REASON = Object.freeze({
  forbidden: '這個帳號沒有權限替那台切換，請確認兩邊登入的是同一個人。',
  not_found: '找不到那台電腦，它可能已經移除。',
  bad_request: '資料格式不對，請重新整理名單後再試。',
  bad_vendor: '這個服務還不能切換。',
  bad_email: '帳號的 email 格式不對。',
  asn_offline: '那台的 ASN 尚未開啟。',
  unknown_account: '那台的帳號庫裡還沒有這個帳號，請讓那台開著 ASN 一會兒。',
  busy: '那台還有一個切換在處理，請稍後再試。',
  rate_limited: '這個小時切換太多次了，請稍後再試。',
  internal: '後台暫時有問題，請稍後再試。',
})
const GENERIC = '切換沒有完成，請稍後再試。'
const hasCjk = s => /[一-鿿]/.test(s)
const errRaw = e => (typeof e === 'string' ? e : e?.message || '')
const failRaw = f => (f?.error ? errRaw(f.error) : f ? JSON.stringify(f) : '')

/**
 * 失敗原因的白話。f＝{ error?（例外或字串）, status?（'denied'｜'failed'）, detail?, code?（'timeout'｜'missing'｜'no_id'） }
 * 回一句以句號結尾的話；錯誤代碼、狀態碼、英文原文一律不放進去（呼叫端把原文寫進 log）。
 */
export function switchFailReason(f) {
  const x = f ?? {}
  if (x.code === 'timeout') return '那台沒有回應，請稍後再試。'
  if (x.code === 'missing') return '查不到這次切換的結果，請稍後再試。'
  if (x.code === 'no_id') return '後台沒有回指令編號，請稍後再試。'
  if (x.status === 'denied') return '那台的使用者沒有同意。'
  if (x.status === 'failed') {
    const d = String(x.detail ?? '').trim().replace(/[。.]+$/, '')
    return d && hasCjk(d) ? `那台沒有完成切換：${d}。` : '那台沒有完成切換，請稍後再試。'
  }
  const raw = errRaw(x.error).trim()
  if (!raw) return GENERIC
  const m = /HTTP (\d{3})\s*([a-z_]*)/.exec(raw)
  if (m) {
    if (CODE_REASON[m[2]]) return CODE_REASON[m[2]]
    if (m[1] === '404') return '後台還沒支援切換帳號，請等後台更新後再試。'
    if (m[1] === '401') return '尚未登入，請先到「我」分頁登入。'
    return '後台暫時回不來，請稍後再試。'
  }
  return hasCjk(raw) ? (/[。！？]$/.test(raw) ? raw : `${raw}。`) : GENERIC
}

/** 一列的識別：廠商｜帳號（不分大小寫）｜設備 */
export const switchRowKey = (vendor, account, node) => `${vendor}|${String(account ?? '').trim().toLowerCase()}|${node}`

/**
 * 切換結果的狀態與流程。state＝一個物件（電腦、手機都傳 reactive({})），key → { phase: 'busy'|'ok'|'fail'|'waiting', text, seq }。
 * press({ key, label, run, reload, synced })：
 *   run() → { ok: true } 或 { ok: false, fail }（fail 給 switchFailReason；拋例外也算失敗）
 *   reload() → 重讀帳號列表（成功後呼叫；失敗只寫 log）；synced() → 那一列現在是不是真的「使用中」了
 * 同一列正在切換時再按不理它；每次按的 seq 不同，舊的計時器不會洗掉新的結果。
 */
export function createSwitchTracker({ state, log = () => {}, sleep = ms => new Promise(r => setTimeout(r, ms)), now = () => Date.now(), setTimer = (fn, ms) => setTimeout(fn, ms), okMs = SWITCH_RESULT_OK_MS, syncMs = SWITCH_SYNC_MS, pollMs = SWITCH_SYNC_POLL_MS }) {
  let counter = 0
  const put = (key, v) => { state[key] = v }
  const clearLater = (key, seq) => setTimer(() => { if (state[key]?.seq === seq) delete state[key] }, okMs)
  async function press({ key, label, run, reload = async () => {}, synced = () => true }) {
    if (!key || state[key]?.phase === 'busy') return state[key] ?? null
    const seq = ++counter
    put(key, { phase: 'busy', text: '', seq })
    let r
    try { r = await run() } catch (e) { r = { ok: false, fail: { error: e } } }
    if (!r?.ok) {
      log('[帳號切換] 沒有切換成功：', key, failRaw(r?.fail))
      put(key, { phase: 'fail', text: SWITCH_RESULT_TEXT.fail(switchFailReason(r?.fail)), seq })
      return state[key]
    }
    const deadline = now() + syncMs
    let ok = false
    for (;;) {
      try { await reload() } catch (e) { log('[帳號切換] 切換後重讀列表失敗：', key, errRaw(e)) }
      if (state[key]?.seq !== seq) return state[key] ?? null   // 期間又按了別的（理論上被擋掉），不蓋掉新的
      let now1 = false
      try { now1 = synced() === true } catch (e) { log('[帳號切換] 判斷列表有沒有更新失敗：', key, errRaw(e)) }
      if (now1) { ok = true; break }
      if (now() >= deadline) break
      await sleep(pollMs)
    }
    if (ok) put(key, { phase: 'ok', text: SWITCH_RESULT_TEXT.ok(label), seq })
    else { log('[帳號切換] 已送出但列表等不到更新：', key); put(key, { phase: 'waiting', text: SWITCH_RESULT_TEXT.waiting, seq }) }
    clearLater(key, seq)
    return state[key]
  }
  return { press, state }
}

/** 畫面用：這一列要顯示的結果句（沒有就 null）。busy 不寫句子（鈕上已寫「切換中…」） */
export const switchResultOf = (state, key) => {
  const r = state?.[key]
  return r && r.text ? { phase: r.phase, text: r.text } : null
}
/** 這一列是不是正在切換（鈕要寫「切換中…」） */
export const switchBusyNode = (state, vendor, account, nodes) => nodes.find(n => state?.[switchRowKey(vendor, account, n)]?.phase === 'busy') ?? ''
