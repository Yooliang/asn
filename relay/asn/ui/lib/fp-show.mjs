// 核對電腦指紋時，請那台電腦自動跳出 QR Code（#1863）。手機（m.js）與電腦跳出的視窗（panel.js）共用的字與判斷。
// 純函式，不碰 DOM、不碰 Tauri；呼叫後台的事由呼叫端注入（api），方便測。
//
// 手機的流程（createFpShowFlow）：
//   1. 名單上那台的 ASN 不在線 → 不送，直接顯示「沒有回應」；版本太舊 → 顯示要更新
//   2. 送 fp_show_request，顯示「已通知那台電腦…」，每秒查一次 fp_show_status
//   3. shown → 換成「QR Code 出現了」，本人按鈕開相機（接回原本的 scanFingerprint）
//   4. 20 秒還沒 shown → 「沒有回應」；pc_cancelled → 「電腦端取消了核對」
//   5. 掃完、取消、離開畫面、逾時、電腦端取消：一律呼叫 fp_show_end（同一筆只送一次）
import { compareVersion } from './presence.mjs'

/** 手機最多等那台電腦跳出來多久 */
export const FP_SHOW_WAIT_MS = 20_000
/** 電腦上的視窗最多開多久（和後台請求的壽命一樣） */
export const FP_SHOW_WINDOW_MS = 5 * 60_000
/** 同一台 10 秒內不能重複請求（後台回 rate_limited） */
export const FP_SHOW_RATE_LIMIT_MS = 10_000
/** 手機每隔多久查一次狀態 */
export const FP_SHOW_POLL_MS = 1000
/** 會自動跳出 QR Code 的最舊版本：比這個舊的電腦只能到它的設定頁手動顯示 */
export const FP_SHOW_MIN_VERSION = '0.2.97'

export const FP_SHOW_TEXT = {
  // 電腦跳出的視窗
  pcTitle: '核對這台電腦',
  pcHeading: '你的手機正在核對這台電腦',
  pcBody: '請用手機的相機，掃下面這個 QR Code。',
  pcFp: fp => `這台電腦的指紋　${fp}`,
  pcCountdown: ms => { const s = Math.max(0, Math.ceil((Number(ms) || 0) / 1000)); return `核對完成後，這個視窗會自己關起來（還剩 ${Math.floor(s / 60)} 分 ${s % 60} 秒）` },
  pcCancel: '取消核對',
  pcQrFailed: '暫時做不出 QR Code，請在手機上改用選的。',
  pcQrAlt: '這台電腦的指紋 QR Code',
  // 手機
  wait: '已通知那台電腦，請看電腦螢幕，會自動跳出一個 QR Code。',
  waitNote: `等待中…（最多等 ${FP_SHOW_WAIT_MS / 1000} 秒）`,
  rateLimited: '剛剛已經通知過，請看電腦螢幕',
  shown: '電腦上的 QR Code 出現了。請用相機掃它。',
  noReplyHead: '那台電腦沒有回應。',
  noReplyBody: '那台電腦要開著 ASN、連得上網路，才能顯示 QR Code。請先到那台電腦打開 ASN，再按「重試」。人不在電腦旁邊的話，等到了那台電腦旁再核對。',
  pcCancelled: '電腦端取消了核對。',
  old: '那台電腦的 ASN 要更新，或到它的設定頁按「顯示 QR Code」。',
  retry: '重試',
  cancel: '取消',
  ok: '知道了',
}

/** 16 碼指紋每 4 個一組（不是 16 個十六進位字元回空字串） */
export const groupFp16 = fp => (/^[0-9a-f]{16}$/.test(String(fp ?? '')) ? String(fp).match(/.{4}/g).join(' ') : '')

/**
 * 送請求之前先看名單：那台的 ASN 不在線回 'offline'（不送）；在線但版本比 minVersion 舊回 'old'；其餘 'ok'。
 * asnRows＝名單上那台的 ASN 視窗（presence.mjs 的 asnByNode 給的 [{ version, … }]）；版本格式看不懂就當新的（交給後台判斷）
 */
export function fpShowPrecheck(asnRows, minVersion = FP_SHOW_MIN_VERSION) {
  const rows = Array.isArray(asnRows) ? asnRows.filter(r => r && typeof r === 'object') : []
  if (!rows.length) return 'offline'
  const versions = rows.map(r => r.version).filter(v => typeof v === 'string')
  const newest = versions.sort((a, b) => compareVersion(b, a))[0]
  return newest && compareVersion(newest, minVersion) < 0 ? 'old' : 'ok'
}

/** fp_show_request 的錯誤 → 'rate_limited'（10 秒內重複）｜'old'（後台或那台不認得：400／404）｜'error'（其他，繼續等、到時間算沒回應） */
export function fpShowRequestError(e) {
  const m = String(e?.message ?? e ?? '')
  if (/\brate_limited\b|HTTP 429\b/.test(m)) return 'rate_limited'
  if (/HTTP 40[04]\b/.test(m)) return 'old'
  return 'error'
}

/** fp_show_status 的 status → 畫面階段：'wait'｜'shown'｜'pc_cancelled'｜'noreply'（結束、被取代、過期都當沒回應） */
export function fpShowPhaseOf(status) {
  if (status === 'pending') return 'wait'
  if (status === 'shown') return 'shown'
  if (status === 'pc_cancelled') return 'pc_cancelled'
  return 'noreply'
}

/** 新的流程狀態（畫面用 reactive 包起來再交給 createFpShowFlow） */
export const newFpShowState = () => ({ phase: 'idle', node: '', id: '', startedAt: 0, note: '', gen: 0 })

/**
 * 手機的流程。api＝{ request(node) → { id }, status(id) → { status }, end(id) }；state 由呼叫端給（會直接改它的欄位，畫面才跟得上）。
 * phase：'idle'｜'wait'｜'shown'｜'noreply'｜'pc_cancelled'｜'old'
 */
export function createFpShowFlow({ state = newFpShowState(), api, now = () => Date.now(), log = () => {} }) {
  const st = state
  const ended = new Set()
  let busy = false
  const endId = async id => {
    if (!id || ended.has(id)) return
    ended.add(id)
    try { await api.end(id) } catch (e) { log('[ASN] 請電腦收掉 QR Code 失敗', String(e?.message ?? e)) }
  }
  const request = async gen => {
    let r
    try { r = await api.request(st.node) } catch (e) {
      if (st.gen !== gen) return
      const k = fpShowRequestError(e)
      if (k === 'rate_limited') st.note = FP_SHOW_TEXT.rateLimited   // 後台沒給編號：下一秒再請求，10 秒過了就會成功
      else if (k === 'old') st.phase = 'old'
      else log('[ASN] 請電腦跳出 QR Code 失敗，繼續等', String(e?.message ?? e))
      return
    }
    const id = typeof r?.id === 'string' ? r.id : ''
    if (st.gen !== gen) { await endId(id); return }   // 這段時間本人已經取消或重來：剛拿到的這筆也收掉
    if (!id) { log('[ASN] 請電腦跳出 QR Code：後台沒回編號', JSON.stringify(r ?? null)); return }
    st.id = id
    st.note = ''
  }
  // 換到結束的畫面（沒回應、電腦端取消）：那一筆也結束
  const finishWith = async phase => { const id = st.id; st.phase = phase; await endId(id) }
  return {
    state: st,
    /** 開始（或重試）：先結束上一筆，再看名單決定送不送 */
    async start(node, asnRows) {
      await this.finish()
      const gen = st.gen
      st.node = String(node ?? '')
      const pre = fpShowPrecheck(asnRows)
      if (pre !== 'ok') { st.phase = pre === 'offline' ? 'noreply' : 'old'; return }
      st.phase = 'wait'
      st.startedAt = now()
      await request(gen)
    },
    /** 每秒呼叫一次：查狀態、判斷逾時 */
    async tick() {
      if (st.phase !== 'wait' || busy) return
      busy = true
      const gen = st.gen
      try {
        if (now() - st.startedAt >= FP_SHOW_WAIT_MS) { await finishWith('noreply'); return }
        if (!st.id) { await request(gen); return }
        let s
        try { s = await api.status(st.id) } catch (e) { log('[ASN] 查電腦跳出 QR Code 了沒失敗', String(e?.message ?? e)); return }
        if (st.gen !== gen || st.phase !== 'wait') return
        const phase = fpShowPhaseOf(s?.status)
        if (phase === 'shown') st.phase = 'shown'
        else if (phase !== 'wait') await finishWith(phase)
      } finally { busy = false }
    },
    /** 掃完、取消、離開畫面：回到 idle，並請電腦收掉視窗 */
    async finish() {
      const id = st.id
      st.gen += 1
      Object.assign(st, { phase: 'idle', id: '', startedAt: 0, note: '' })
      await endId(id)
    },
  }
}
