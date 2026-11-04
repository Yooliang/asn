// 電腦重開後自動接回夥伴（#767）：後端的結果 → 要跳的提示。每個階段只跳一次；接不回來的一定列出名字與原因。
export const AUTO_RESUME_POLL_MS = 15_000
const MAX_LISTED = 10
const NL = String.fromCharCode(10)

function failedLines(failed) {
  const rows = failed.slice(0, MAX_LISTED).map(f => `「${f.name}」：${f.reason}`)
  if (failed.length > MAX_LISTED) rows.push(`還有 ${failed.length - MAX_LISTED} 位沒列出`)
  return rows.join('\n')
}

function resumedLine(resumed) {
  const names = resumed.filter(n => typeof n === 'string' && n).slice(0, MAX_LISTED).map(n => `「${n}」`)
  if (!names.length) return ''
  const more = resumed.length > MAX_LISTED ? `，還有 ${resumed.length - MAX_LISTED} 位` : ''
  return `接回的是：${names.join('、')}${more}`
}

/** 結果 → 提示；這個階段不用跳就回 null */
export function autoResumeNotice(s) {
  if (!s || typeof s !== 'object') return null
  const resumed = Array.isArray(s.resumed) ? s.resumed.length : 0
  const failed = Array.isArray(s.failed) ? s.failed.filter(f => typeof f?.name === 'string' && typeof f?.reason === 'string') : []
  switch (s.state) {
    case 'waiting_login': return { key: 'waiting_login', title: '夥伴還沒接回來', body: 'Claude 需要重新登入。登入後會自動把夥伴接回來。' }
    case 'paused_memory': return { key: 'paused_memory', title: '夥伴還沒接回來', body: '這台電腦的空記憶體不到 3 GB，先暫停接回，記憶體夠了會繼續。' }
    case 'done': {
      if (!resumed && !failed.length) return null
      const title = resumed ? `已自動接回 ${resumed} 位夥伴` : '夥伴沒有接回來'
      const lead = resumed ? ['它們照原本的權限重新開始工作，會開始用額度。', resumedLine(s.resumed)].filter(Boolean).join(NL) : ''
      const rest = failed.length ? `沒有接回 ${failed.length} 位，給它們的信會先留著，最多 12 小時：\n${failedLines(failed)}` : ''
      return { key: `done:${resumed}:${failed.length}`, title, body: [lead, rest].filter(Boolean).join('\n') }
    }
    default: return null
  }
}

/** 定時查；查失敗（舊版後端沒有這個命令）就略過這一輪 */
export function createAutoResumePoller({ fetch, show, intervalMs = AUTO_RESUME_POLL_MS, setTimer = setInterval }) {
  let seen = ''
  async function tick() {
    try {
      const n = autoResumeNotice(await fetch())
      if (n && n.key !== seen) {
        seen = n.key
        show({ title: n.title, body: n.body })
      }
    } catch { /* 下一輪再查 */ }
  }
  return { tick, start: () => setTimer(tick, intervalMs) }
}
