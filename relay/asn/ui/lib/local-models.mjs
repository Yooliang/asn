// 本機型號清單的讀取器（#2355 P3）：向 agent_models 命令讀、交給 modelState 變成畫面狀態，並處理 pending 自動再問與「重新讀取」。
// 不碰畫面、不用 Vue：狀態變了就呼叫 onChange(廠牌, 畫面狀態)，呼叫端自己放進 ref／reactive。node 與瀏覽器都能載入。
import { UNKNOWN_FAILURE_TEXT, PENDING_TEXT, codeText, modelState, remoteView } from './remote-models.mjs'

/** pending 時自動再問幾次、隔多久（#2355 D8：合計約 15 秒，之後當成讀不到，不讓畫面一直轉圈） */
export const PENDING_RETRIES = 3
export const PENDING_INTERVAL_MS = 5000

/**
 * 畫面狀態：{ state, models, note, canRetry, loading }（前四個同 modelState；loading＝正在向本機問，重新讀取鈕要停用）。
 * opts：fetch({ vendor, force }) → 本機回應；onChange(vendor, view)；narrow（濾掉切換模型窄規則不收的型號）；
 *       where：'local'（預設）或 'remote'（別台，#2355 P4：fetch 回那台的摘要，force／retry 時要重新向後台問；畫面文案說「那台」，按鈕叫「再查一次」）；
 *       vendorLabel(vendor)、setTimer／clearTimer／now（測試用）。
 */
export function createModelLoader({ fetch, onChange, narrow = true, where = 'local', vendorLabel = v => v, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, retries = PENDING_RETRIES, intervalMs = PENDING_INTERVAL_MS } = {}) {
  let gen = 0
  const remote = where === 'remote'
  const timers = new Map(), tries = new Map(), views = new Map()
  // 別台（#2355 P4）：fetch 收到 { vendor, force, retry }，force／retry 時要重新向後台問一次；回的是那台的摘要（launcher），形狀同本機回應。
  // 別台的畫面多一句「那台會自己定期更新」，按鈕改叫「再查一次」（remoteView）
  const decorate = view => (remote ? remoteView(view) : view)
  const emit = (vendor, view) => { views.set(vendor, view); onChange?.(vendor, view) }
  const unavailable = (note) => decorate({ state: 'unavailable', models: [], note, canRetry: true, loading: false })

  async function load(vendor, { force = false } = {}) {
    const my = gen
    clearTimer(timers.get(vendor)); timers.delete(vendor)
    if (force) tries.set(vendor, 0)
    // 重新讀取時先留著原本的清單，回來之後才換（不讓下拉在中途清空）
    const prev = views.get(vendor) ?? { state: 'pending', models: [], note: PENDING_TEXT, canRetry: false }
    emit(vendor, { ...prev, canRetry: false, loading: true })
    let source
    try { source = await fetch(remote ? { vendor, force, retry: !force && (tries.get(vendor) ?? 0) > 0 } : { vendor, force }) } catch (e) {
      console.info('[型號清單]', vendor, remote ? '向後台查那台的清單失敗' : '向本機讀取失敗', e?.message ?? e)
      if (my === gen) emit(vendor, unavailable(UNKNOWN_FAILURE_TEXT))
      return
    }
    if (my !== gen) return
    const v = modelState(source, vendor, { where, now: now(), narrow })
    if (v.state === 'pending') {
      const n = (tries.get(vendor) ?? 0) + 1
      tries.set(vendor, n)
      if (n > retries) {
        console.info('[型號清單]', vendor, `連問 ${n} 次都還在讀取，當成讀不到`)
        emit(vendor, unavailable(`${UNKNOWN_FAILURE_TEXT}：${codeText('timeout', vendorLabel(vendor), where)}`))
        return
      }
      emit(vendor, { ...decorate(v), loading: false })
      timers.set(vendor, setTimer(() => { void load(vendor) }, intervalMs))
      return
    }
    tries.set(vendor, 0)
    emit(vendor, { ...decorate(v), loading: false })
  }

  return {
    load,
    /** 還沒讀過這家才讀（對話框切回第 2 頁不重讀；要重讀按「重新讀取」） */
    ensure(vendor) { if (!views.has(vendor)) void load(vendor) },
    view: vendor => views.get(vendor) ?? null,
    /** 對話框關掉／重開：丟掉所有結果、停掉等待中的再問，晚到的回應也不採用 */
    reset() { gen++; for (const t of timers.values()) clearTimer(t); timers.clear(); tries.clear(); views.clear() },
  }
}
