// 登入畫面與設定頁「帳號登入」區塊的純邏輯（node 與瀏覽器都能跑，不碰 Tauri）。
// 權杖與金鑰都在 Rust 端；這裡只處理「現在是什麼狀態、要顯示什麼字」。
export const PROVIDERS = [
  { key: 'google', label: '用 Google 登入', name: 'Google' },
  { key: 'github', label: '用 GitHub 登入', name: 'GitHub' },
]
export const providerKeys = () => PROVIDERS.map(p => p.key)

// 登入畫面的階段：idle（等你按）、waiting（瀏覽器開著，等回呼）、setting（登入完成，正在替這台電腦建立節點）、error
export const PHASES = ['idle', 'waiting', 'setting', 'error']

export function phaseText(phase, provider = '') {
  const name = PROVIDERS.find(p => p.key === provider)?.name ?? ''
  switch (phase) {
    case 'waiting': return `請在瀏覽器完成${name ? ` ${name} ` : ''}登入，完成後回到這裡。`
    case 'setting': return '登入完成，正在設定這台電腦…'
    default: return ''
  }
}

// Rust 端回來的錯誤字串 → 畫面用的話（已經是中文就原樣，空的給預設）
export function errorText(e) {
  const s = String(e?.message ?? e ?? '').trim()
  return s || '登入沒有完成，請再試一次'
}

// 登入畫面按鈕是否可按（等待中不可再按；按「取消」才能重來）
export const canStart = phase => phase === 'idle' || phase === 'error'

// 設定頁「帳號登入」區塊：依登入狀態與帳號資訊決定顯示什麼
//   status：{ signed_in, email }；info：{ node_count, this_node_mine } 或 null（還沒取到）；hasNode：這台有沒有節點金鑰
export function accountView(status, info, hasNode) {
  if (!status?.signed_in) {
    return { signedIn: false, title: '尚未登入', detail: '登入後，這台電腦可以連到你的帳號，換電腦時也能用同一個帳號。', canClaim: false, mine: false }
  }
  const email = status.email || '（沒有 email）'
  let detail = ''
  let canClaim = false
  let mine = false
  if (info) {
    mine = hasNode && info.this_node_mine === true
    canClaim = hasNode && !mine
    const n = Number.isInteger(info.node_count) ? info.node_count : 0
    detail = mine ? `這台電腦已連到你的帳號，帳號底下共有 ${n} 台電腦。` : `帳號底下有 ${n} 台電腦，這台還沒連到你的帳號。`
  }
  return { signedIn: true, title: `已登入：${email}`, detail, canClaim, mine }
}

// 沒有節點金鑰＝新電腦；有登入就可以直接建立節點
export const needsDeviceSetup = (hasNode, status) => !hasNode && status?.signed_in === true
