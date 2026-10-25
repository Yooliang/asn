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

// 這台電腦還沒綁到帳號時的小字提示（舊租戶還沒被認領；登入後每次啟動會自動再試，不用按任何鈕）
export const PENDING_HINT = '這台電腦尚未綁到你的帳號（認領後會自動完成）'

// 設定頁「帳號登入」區塊：只顯示登入狀態（已登入的 email、登出；或尚未登入與登入鈕）
//   status：{ signed_in, email }；info：{ node_count, this_node_mine } 或 null（還沒取到）
export function accountView(status, info) {
  if (!status?.signed_in) {
    return { signedIn: false, title: '尚未登入', detail: '登入後，這台電腦會自動連到你的帳號，換電腦時也能用同一個帳號。', mine: false }
  }
  const email = status.email || '（沒有 email）'
  let detail = ''
  let mine = false
  if (info) {
    mine = info.this_node_mine === true
    const n = Number.isInteger(info.node_count) ? info.node_count : 0
    detail = mine ? `這台電腦已連到你的帳號，帳號底下共有 ${n} 台電腦。` : PENDING_HINT
  }
  return { signedIn: true, title: `已登入：${email}`, detail, mine }
}

// 沒有節點金鑰＝新電腦：登入後要建立節點；有金鑰的舊電腦登入後改為自動綁定
export const needsDeviceSetup = (hasNode, status) => !hasNode && status?.signed_in === true

// 登入畫面是否顯示「暫時不登入」小字連結：只有這台已有節點金鑰、而且沒在登入途中
export const showSkip = (canSkip, phase) => canSkip === true && (phase === 'idle' || phase === 'error')
export const SKIP_LABEL = '暫時不登入（只用這台電腦的金鑰）'

// 上次用哪種方式登入，就在那顆按鈕上標這個小標籤
export const LAST_USED_LABEL = '上次使用'
