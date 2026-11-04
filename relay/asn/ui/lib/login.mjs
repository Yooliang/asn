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

// 這台電腦已經有節點金鑰（舊電腦、或登入掉了）：沒登入時收發信照常，登入畫面要講清楚，免得以為停擺
export const STILL_RUNNING_NOTE = '這台電腦還在收發信，夥伴照常工作；登入後才能在這裡打字和管理。'
// 名單視窗上方的提醒條：沒登入時（登入掉了、或選了暫時不登入），帳號回報與切換帳號會暫停
export const RELOGIN_BAR_TEXT = '這台電腦還沒登入，收發信照常。'
export const RELOGIN_BAR_HINT = '收發信和夥伴照常工作，但帳號回報和切換帳號暫停。請重新登入。'
export const RELOGIN_BAR_ACTION = '登入'
export const RELOGIN_BAR_DISMISS = '知道了'
// 要不要顯示提醒條：這台已有節點金鑰、目前沒登入、本人還沒按「知道了」（按了就這次不再顯示；之後登入又掉才會再出現）
export const showReloginBar = (hasNode, signedIn, dismissed) => hasNode === true && signedIn === false && dismissed !== true
// 主動登出的確認：預設只登出，收發信照常；要連收發信一起停，本人另外選
export const LOGOUT_NOTE = '登出後，這台電腦還會繼續收發信，夥伴照常工作；只是不能在這裡打字和管理，帳號回報和切換帳號也會暫停。'
export const LOGOUT_ONLY_LABEL = '只登出'
export const LOGOUT_STOP_LABEL = '登出並結束 ASN（停止收發信）'
export const LOGOUT_CANCEL_LABEL = '取消'
export const LOGOUT_DONE_TEXT = '已登出，正在回到登入畫面…這台電腦照常收發信。'
export const LOGOUT_STOP_DONE_TEXT = '已登出，ASN 即將結束，這台電腦不再收發信。'

// 上次用哪種方式登入，就在那顆按鈕上標這個小標籤
export const LAST_USED_LABEL = '上次使用'
