// 設定頁「用量」：本機 Claude Code 對話記錄的 token 與成本估算。
// 記錄檔的掃描與加總全在 Rust（usage.rs，只讀這台電腦、不上傳）；這裡只呼叫指令並整理成要顯示的文字。
// 成本是用內建價目表算的估算值，不是帳單，也不是訂閱方案的剩餘額度。
export const USAGE_NOTE = '依這台電腦上 Claude Code 的對話記錄估算，不是帳單，也不是訂閱方案的剩餘額度；只在本機計算，不會上傳。'

// 大數字轉成短的：1234 → 1,234；10 萬以上用「萬」「億」
export function fmtTokens(n) {
  const v = Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0
  if (v >= 100_000_000) return `${(v / 100_000_000).toFixed(2)} 億`
  if (v >= 100_000) return `${(v / 10_000).toFixed(1)} 萬`
  return v.toLocaleString('en-US')
}
export function fmtCost(usd) {
  const v = Number.isFinite(usd) ? Math.max(0, usd) : 0
  if (v === 0) return '$0'
  return v < 0.01 ? '< $0.01' : `$${v.toFixed(2)}`
}
const totalTokens = t => (t.input || 0) + (t.output || 0) + (t.cacheWrite || 0) + (t.cacheRead || 0)

// 一格（今天、近 7 天…）要顯示的文字
export function periodView(p) {
  const t = p ?? {}
  return {
    key: t.key, label: t.label,
    cost: fmtCost(t.costUsd), tokens: fmtTokens(totalTokens(t)), messages: t.messages || 0,
    detail: `輸入 ${fmtTokens(t.input)}、輸出 ${fmtTokens(t.output)}、快取寫入 ${fmtTokens(t.cacheWrite)}、快取讀取 ${fmtTokens(t.cacheRead)}`,
    models: (t.models ?? []).map(m => ({
      model: m.model, priced: m.priced !== false,
      cost: m.priced === false ? '未列價目' : fmtCost(m.costUsd), tokens: fmtTokens(totalTokens(m)), messages: m.messages || 0,
    })),
  }
}

// 後端回來的統計 → 畫面資料（缺欄位不丟錯）
export function usageView(s) {
  if (!s) return null
  const periods = (s.periods ?? []).map(periodView)
  const unpriced = s.unpricedModels ?? []
  return {
    periods,
    empty: !s.rootsFound ? '這台電腦上找不到 Claude Code 的對話記錄資料夾。' : (periods.every(p => !p.messages) ? '本月還沒有可統計的對話記錄。' : ''),
    unpriced: unpriced.length ? `這些模型還沒有內建價目，只列 token、不計入成本：${unpriced.join('、')}` : '',
    priceLine: s.priceDate ? `價目依 Anthropic 官方公開定價（${s.priceDate} 抄錄），不含批次折扣與其他加價項目。` : '',
    files: s.files || 0,
  }
}

export function createUsageUi({ invoke, reactive, now = () => new Date() }) {
  const state = reactive({ loading: false, error: '', data: null, updated: '' })
  const refresh = async () => {
    if (state.loading) return
    state.loading = true
    try {
      // getTimezoneOffset：UTC 減本機的分鐘數，Rust 端用它切「今天」「本月」
      const s = await invoke('usage_summary', { tzOffsetMin: now().getTimezoneOffset() })
      state.data = usageView(s)
      state.error = ''
      const d = now()
      state.updated = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
    } catch (e) {
      state.error = `讀取用量失敗：${e?.message ?? e}`
    } finally {
      state.loading = false
    }
  }
  return { state, refresh }
}
