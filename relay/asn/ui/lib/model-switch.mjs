// 對話中切換模型（名單右鍵「切換模型 ▸」與之後的對話上方功能列 #40 共用）。
// 只放純邏輯與一個小控制器，不碰 Vue、不碰 DOM；後端指令在 src-tauri/src/launch/switch.rs。
import { CLAUDE_MODELS } from './model-catalog.mjs'

/** 查詢最久等多久（右鍵選單不能被慢的查詢卡住）；切換本身要等舊視窗關掉、新對話出現，不設前端逾時。 */
export const MODEL_QUERY_TIMEOUT_MS = 2500

/** 啟動參數裡的 --model 屬於哪一家（opus／sonnet／haiku）；認不得回 null。 */
export function modelFamily(raw, models = CLAUDE_MODELS) {
  const s = String(raw ?? '').toLowerCase()
  return models.find(m => s.includes(m.family))?.family ?? null
}

/** 顯示用的目前模型名稱：沒指定＝「預設」；認得的用目錄裡的名稱；認不得原樣顯示。 */
export function currentModelLabel(raw, models = CLAUDE_MODELS) {
  if (raw == null || raw === '') return '預設'
  const fam = modelFamily(raw, models)
  return models.find(m => m.family === fam)?.label ?? String(raw)
}

/** 這個名單上的人，能不能出現「切換模型」：只有本機的 Claude 視窗（雲端代理、其他設備、Codex 等不適用）。 */
export function canOfferModelSwitch(friend, { selfNode, engine }) {
  if (!friend || friend.pending) return false
  if (engine !== 'claude') return false
  if (friend.engine === 'acp') return false
  return friend.node === selfNode
}

/**
 * 把後端的查詢結果整理成選單要的樣子。
 * state：none（切不了）／ready（可選）／busy（對話進行中，列出但停用）
 */
export function modelMenuState(q, models = CLAUDE_MODELS) {
  if (!q || !q.ok || !q.canSwitch) {
    return { state: 'none', reason: q?.reason || '找不到這個視窗', current: '', items: [] }
  }
  const fam = modelFamily(q.model, models)
  const idle = Boolean(q.idle)
  return {
    state: idle ? 'ready' : 'busy',
    reason: idle ? '' : (q.reason || '對話進行中，等它閒置再切換'),
    current: currentModelLabel(q.model, models),
    items: models.map(m => ({ id: m.id, label: m.label, checked: m.family === fam, disabled: !idle })),
  }
}

/** 確認視窗的文字（會關掉原視窗、正在打的字會不見、對話會接續）。 */
export function confirmText(name, currentLabel, targetLabel, { ownWindow = false } = {}) {
  return {
    title: '切換模型',
    lead: `要把「${name}」從 ${currentLabel} 切換成 ${targetLabel} 嗎？`,
    points: [
      '會關掉原本的視窗，再開一個新的。',
      '這個視窗裡正在打的字會不見。',
      '對話內容會接續，名字與工作資料夾不變。',
      // 使用者自己開的視窗：只結束裡面的 Claude，原本的終端機分頁會留著
      ...(ownWindow ? ['這是你自己開的視窗：原本的終端機分頁會留下，可以自己關掉；新視窗開在另一個分頁或視窗。'] : []),
    ],
    ok: '關掉並切換',
    cancel: '取消',
  }
}

/** 後端回報整理成一句話與（失敗時）可複製的手動指令。 */
export function resultView(r, targetLabel = '') {
  if (r?.ok) return { ok: true, message: targetLabel ? `已切換為 ${targetLabel}` : '已切換', manual: '' }
  const reason = r?.reason || '切換失敗'
  return { ok: false, message: reason, manual: r?.manual || '', closed: Boolean(r?.closed) }
}

function withTimeout(promise, ms) {
  return new Promise(resolve => {
    const t = setTimeout(() => resolve(null), ms)
    Promise.resolve(promise).then(v => { clearTimeout(t); resolve(v) }, () => { clearTimeout(t); resolve(null) })
  })
}

/**
 * 控制器：transport 要有 modelSwitchQuery(req)、modelSwitchRun(req)。
 * 名單右鍵與功能列各自 new 一個或共用一個都行；沒有內部狀態，狀態由呼叫端（Vue ref）持有。
 */
export function createModelSwitcher({ transport, models = CLAUDE_MODELS, log = () => {} } = {}) {
  return {
    models,
    /** → modelMenuState 的結果加上 raw；查詢逾時或出錯一律當作切不了（reason 說明）。 */
    async query(name) {
      const q = await withTimeout(transport.modelSwitchQuery({ name }), MODEL_QUERY_TIMEOUT_MS)
      const st = modelMenuState(q, models)
      return { ...st, raw: q }
    },
    /** 呼叫端應先讓使用者確認過。→ resultView */
    async run(name, st, modelId) {
      const m = models.find(x => x.id === modelId)
      if (!m || !st?.raw?.pid || !st.raw.sessionId) return resultView({ ok: false, reason: '查詢資料不完整，請重新開選單' })
      try {
        const r = await transport.modelSwitchRun({ name, pid: st.raw.pid, sessionId: st.raw.sessionId, model: m.id })
        return resultView(r, m.label)
      } catch (e) {
        log(`切換模型失敗：${e?.message ?? e}`)
        return resultView({ ok: false, reason: String(e?.message ?? e) })
      }
    },
  }
}
