// 夥伴卡住的本機提醒（todo-next-162）：後端只給視窗名與固定代號，畫面上的字都在這裡，不顯示任何畫面內容。
export const NOTICE_POLL_MS = 15_000

const NOTICES = {
  permission: name => ({ title: '夥伴在等你回答', body: `「${name}」在等你同意一項操作，請到它的視窗確認。` }),
  trust: name => ({ title: '夥伴在等你回答', body: `「${name}」在問要不要信任這個資料夾，請到它的視窗確認。` }),
  bypass_warning: name => ({ title: '夥伴在等你確認', body: `「${name}」第一次開啟，要你同意它的權限設定，請到它的視窗確認。` }),
  login: name => ({ title: '夥伴需要登入', body: `「${name}」需要登入才能繼續，請到它的視窗登入。` }),
  usage_limit: name => ({ title: '夥伴的額度用完了', body: `「${name}」的額度用完了，要等額度恢復才能繼續。` }),
  question: name => ({ title: '夥伴在問你問題', body: `「${name}」在等你選一個答案，請到它的視窗回答。` }),
  question_view: name => ({ title: '夥伴在問你問題', body: `「${name}」在等你選答案，請到它的視窗回答。` }),
  attention: name => ({ title: '夥伴需要你看一下', body: `「${name}」停在一個選單，請到它的視窗確認。` }),
}

/** 代號 → 要顯示的字；不認得的代號不顯示 */
export function noticeText(item) {
  const make = Object.hasOwn(NOTICES, item?.code) ? NOTICES[item.code] : null
  return make && typeof item.name === 'string' && item.name ? make(item.name) : null
}

/** 這一輪要新跳的提醒：上一輪沒有的才跳；回 { fresh, seen }，seen 是下一輪要帶的 */
export function nextNotices(list, seen = new Set()) {
  const now = new Set(), fresh = [], freshItems = []
  for (const item of Array.isArray(list) ? list : []) {
    const text = noticeText(item)
    if (!text) continue
    const key = `${item.code}\n${item.name}`
    now.add(key)
    if (seen.has(key)) continue
    // 權限詢問另外開確認框（要讀完整的提示），不跳一般提醒
    if (item.code === 'permission') freshItems.push(item)
    else fresh.push(text)
  }
  // 上一輪有、這一輪沒有的：夥伴已經回答了，開著的提醒要收掉
  const gone = [...seen].filter(k => !now.has(k)).map(k => {
    const i = k.indexOf('\n')
    return { code: k.slice(0, i), name: k.slice(i + 1) }
  })
  return { fresh, freshItems, seen: now, gone }
}

/** 終端畫面上要顯示的一行提示（畫面開著時本機的同意框不跳）。只給本人看，不含畫面內容 */
const VIEW_HINTS = {
  permission: '它在等你同意一項操作：直接在下面的畫面按數字鍵回答。',
  trust: '它在問要不要信任這個資料夾：直接在下面的畫面回答。',
  bypass_warning: '它在等你確認權限設定：直接在下面的畫面回答。',
  attention: '它停在一個選單：直接在下面的畫面回答。',
}
export function viewHint(list, name) {
  const hit = (Array.isArray(list) ? list : []).find(i => i?.name === name && Object.hasOwn(VIEW_HINTS, i?.code))
  return hit ? VIEW_HINTS[hit.code] : ''
}

/** 這個提醒畫面該不該收：提醒的文字就是那一項的文字（別的提醒、別的夥伴不動） */
export const noticeStillFor = (item, body) => noticeText(item)?.body === body

/** 權限確認框要顯示什麼：不完整就不給「允許」 */
export function permissionView(p) {
  const text = typeof p?.text === 'string' ? p.text : ''
  return { text, canAllow: p?.complete === true && !!text, canDeny: !!text, hint: p?.complete === true ? '' : '提示太長，這裡顯示不完整。要允許請到它的視窗確認。' }
}

/** 定時查；查失敗（舊版後端沒有這個命令）就略過這一輪 */
export function createPartnerNoticePoller({ fetch, show, onItem = null, onGone = null, intervalMs = NOTICE_POLL_MS, setTimer = setInterval }) {
  let seen = new Set()
  async function tick() {
    try {
      const r = nextNotices(await fetch(), seen)
      seen = r.seen
      r.fresh.forEach(show)
      for (const i of r.freshItems) {
        // 回 false：這次先不跳（例如本人正開著它的終端畫面），下一輪再問
        if ((await onItem?.(i)) === false) seen.delete(`${i.code}\n${i.name}`)
      }
      r.gone.forEach(i => onGone?.(i))
    } catch { /* 下一輪再查 */ }
  }
  return { tick, start: () => setTimer(tick, intervalMs) }
}
