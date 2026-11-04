// 夥伴卡住的本機提醒（todo-next-162）：後端只給視窗名與固定代號，畫面上的字都在這裡，不顯示任何畫面內容。
export const NOTICE_POLL_MS = 15_000

const NOTICES = {
  permission: name => ({ title: '夥伴在等你回答', body: `「${name}」在等你同意一項操作，請到它的視窗確認。` }),
  trust: name => ({ title: '夥伴在等你回答', body: `「${name}」在問要不要信任這個資料夾，請到它的視窗確認。` }),
  bypass_warning: name => ({ title: '夥伴在等你確認', body: `「${name}」第一次開啟，要你同意它的權限設定，請到它的視窗確認。` }),
  login: name => ({ title: '夥伴需要登入', body: `「${name}」需要登入才能繼續，請到它的視窗登入。` }),
  usage_limit: name => ({ title: '夥伴的額度用完了', body: `「${name}」的額度用完了，要等額度恢復才能繼續。` }),
  attention: name => ({ title: '夥伴需要你看一下', body: `「${name}」停在一個選單，請到它的視窗確認。` }),
}

/** 代號 → 要顯示的字；不認得的代號不顯示 */
export function noticeText(item) {
  const make = Object.hasOwn(NOTICES, item?.code) ? NOTICES[item.code] : null
  return make && typeof item.name === 'string' && item.name ? make(item.name) : null
}

/** 這一輪要新跳的提醒：上一輪沒有的才跳；回 { fresh, seen }，seen 是下一輪要帶的 */
export function nextNotices(list, seen = new Set()) {
  const now = new Set(), fresh = []
  for (const item of Array.isArray(list) ? list : []) {
    const text = noticeText(item)
    if (!text) continue
    const key = `${item.code}\n${item.name}`
    now.add(key)
    if (!seen.has(key)) fresh.push(text)
  }
  return { fresh, seen: now }
}

/** 定時查；查失敗（舊版後端沒有這個命令）就略過這一輪 */
export function createPartnerNoticePoller({ fetch, show, intervalMs = NOTICE_POLL_MS, setTimer = setInterval }) {
  let seen = new Set()
  async function tick() {
    try {
      const r = nextNotices(await fetch(), seen)
      seen = r.seen
      r.fresh.forEach(show)
    } catch { /* 下一輪再查 */ }
  }
  return { tick, start: () => setTimer(tick, intervalMs) }
}
