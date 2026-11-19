// 「需要重新登入」提醒條（#1764）：電腦（list.html）與手機（m.html）共用這一個元件、這一份文字、這一套判斷。
// 這台已有節點金鑰、收發信照常，但登入掉了（或選了暫時不登入）時說一次；按「知道了」先不再提，登入後又掉才會再出現。
// 這個檔在 node 也要能載入（測試），所以不取用 Vue；元件只用 props 的物件寫法，判斷邏輯與畫面分開。
import { ROOM_LOAD_FAIL_TEXT } from './mobile-rooms.mjs'
import { RELOGIN_BAR_ACTION, RELOGIN_BAR_DISMISS, RELOGIN_BAR_HINT, RELOGIN_BAR_TEXT, showReloginBar } from './login.mjs'

/** 後台（Rust）在登入被清掉時發的事件；字串要和 src-tauri/src/auth_notice.rs 的 AUTH_LOST_EVENT 一樣 */
export const AUTH_LOST_EVENT = 'auth-signed-out'

/** 這台是電腦或手機：只換「這台電腦」的稱呼，其餘文字兩邊一模一樣 */
export const reloginBarText = device => (device === 'phone' ? RELOGIN_BAR_TEXT.replace('這台電腦', '這支手機') : RELOGIN_BAR_TEXT)

/** 群組清單原本的位置：登入失效、只列得出這台能看到的群組時說的一句話（電腦與手機同一句） */
export const ROOMS_NEED_LOGIN_TEXT = '需要重新登入才看得到所有群組。'
/** 群組清單原位的說明：讀不到就說讀不到，沒帶簽章（登入失效）就說要重新登入；都正常回空字串（畫面不多出任何東西） */
export const roomsNoteText = ({ err = false, signed = true } = {}) => (err ? ROOM_LOAD_FAIL_TEXT : signed === false ? ROOMS_NEED_LOGIN_TEXT : '')
/** 名單（夥伴列表）讀不到（連不上 ASN）時，在名單原本的位置說的一句話：電腦與手機同一句，講發生什麼事、要怎麼辦（#1808） */
export const ROSTER_LOAD_FAIL_TEXT = '連不上 ASN，請檢查網路。'

/** 群組列表的結果是不是「沒帶本人簽章」（後台只回得出這台的群組）；舊版 Rust 沒有 signed 欄位＝當作有簽章 */
export const roomsUnsigned = r => r?.signed === false
/** 登入已經失效（要重新登入才會好）；暫時連不上不算 */
export const roomsLoginLost = r => r?.signed === false && (r?.reason === 'login_expired' || r?.reason === 'not_signed_in')
/** 錯誤訊息像不像「登入失效」：後台回 401、或 Rust 回的登入已過期 */
export const looksLikeLoginLost = msg => /\b401\b|登入已過期|請重新登入|尚未登入/.test(String(msg ?? ''))

/**
 * 提醒條的狀態與觸發。觸發：收到清掉登入的事件、群組列表回報登入已失效、任何請求回 401、回到前景；平常每分鐘也看一次。
 * status：() => Promise<{signed_in}>；listen：(事件名, 回呼) => Promise；canSkipLogin：() => 這台有沒有節點金鑰
 * 不取得登入狀態時（取不到）就不顯示，不吵人。
 */
export function createReloginWatch({ status, listen, canSkipLogin, reactive = x => x, onSignedIn = () => {} }) {
  const st = reactive({ show: false })
  let dismissed = false
  let wasSignedIn = null
  // 「登入有問題」：後台回報登入失效、事件、401 時成立。登入檔還在（signed_in 仍是 true）時也要維持，
  // 例行檢查不能把提示收起來；只有真的成功換到憑證（群組列表回 signed:true）或重新登入才解除（#1764 B 審查）
  let troubled = false
  async function refresh({ force = false } = {}) {
    try {
      if (force) troubled = true
      const s = await status()
      const nowIn = s?.signed_in === true
      if (nowIn && wasSignedIn === false) troubled = false   // 重新登入了
      if (nowIn && !troubled) dismissed = false
      if (nowIn && wasSignedIn === false) onSignedIn()   // 從未登入變成已登入
      if (s?.signed_in === true || s?.signed_in === false) wasSignedIn = nowIn
      const known = s?.signed_in === true ? true : s?.signed_in === false ? false : null
      st.show = showReloginBar(canSkipLogin() === true, troubled ? false : known, dismissed)
    } catch { st.show = false }
    return st.show
  }
  const dismiss = () => { dismissed = true; st.show = false }
  // 清掉登入的事件：這是「剛掉」，之前按過「知道了」也要再提醒一次
  const onLost = () => { dismissed = false; return refresh({ force: true }) }
  return {
    st,
    refresh,
    dismiss,
    onLost,
    /** 群組列表回來了：登入已失效就立刻再查一次 */
    noteRooms: r => {
      if (roomsLoginLost(r)) return refresh({ force: true })
      if (r?.signed === true && troubled) { troubled = false; return refresh() }   // 成功換到憑證：解除
      return Promise.resolve(st.show)
    },
    /** 任何請求失敗：像登入失效（401…）就立刻再查一次 */
    noteError: e => (looksLikeLoginLost(e?.message ?? e) ? refresh({ force: true }) : Promise.resolve(st.show)),
    /** 回到前景（手機不能只在開 App 時查一次） */
    onForeground: () => refresh(),
    /** 掛上事件；收不到事件不影響其他觸發 */
    start() {
      try { void Promise.resolve(listen(AUTH_LOST_EVENT, () => { void onLost() })).catch(() => {}) } catch { /* 沒有事件通道（測試、舊殼） */ }
      return refresh()
    },
  }
}

export const ReloginBar = {
  name: 'ReloginBar',
  props: {
    show: { type: Boolean, default: false },
    variant: { type: String, default: 'desk' },   // 'desk'＝電腦、'phone'＝手機：只差外觀樣式的 class，文字一樣
  },
  emits: ['login', 'dismiss'],
  setup(props) {
    return { RELOGIN_BAR_HINT, RELOGIN_BAR_ACTION, RELOGIN_BAR_DISMISS, text: () => reloginBarText(props.variant) }
  },
  template: `<div class="relogin-bar" :class="variant === 'phone' ? 'm-upd' : 'upd-bar'" v-if="show" role="status">
    <span :class="variant === 'phone' ? 'm-upd-tx' : 'upd-text'" :title="RELOGIN_BAR_HINT">{{ text() }}</span>
    <button :class="variant === 'phone' ? 'm-btn m-upd-btn' : 'aero-btn upd-btn'" type="button" @click.stop="$emit('login')">{{ RELOGIN_BAR_ACTION }}</button>
    <button :class="variant === 'phone' ? 'm-btn m-upd-btn' : 'aero-btn upd-btn'" type="button" @click.stop="$emit('dismiss')">{{ RELOGIN_BAR_DISMISS }}</button>
  </div>`,
}
