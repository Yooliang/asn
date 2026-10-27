// 主視窗的記錄寫進檔案（#339 收尾）：console 裡 [ASN] 開頭的記錄（收信、ack、連線原因、各功能的失敗原因）
// 以前只在 devtools 看得到，事後查不到。這裡照常印到 console，同時排進佇列，每隔幾秒整批交給 Rust（ui_log 指令）
// 附加到機器資料夾的 ui.log。寫檔失敗就丟掉這批，不重試、不再印記錄（免得自己繞圈）。
// node 也要能載入（測試），所以不碰 window；計時器與 console 都由呼叫端帶進來。

export const UI_LOG_FLUSH_MS = 3000
export const UI_LOG_BUFFER_MAX = 200   // 佇列最多留幾行（寫檔一直失敗時只留最新的）
export const UI_LOG_LINE_MAX = 500
const TAG = '[ASN]'
const LEVELS = ['info', 'warn', 'error']

const part = a => {
  if (typeof a === 'string') return a
  if (a instanceof Error) return a.message
  try { return JSON.stringify(a)?.slice(0, 200) ?? String(a) } catch { return String(a) }
}

// 一行記錄：時間、等級、內容（換行、tab 換成空白，限長）
export function formatUiLogLine(level, args, now = new Date()) {
  const text = args.map(part).join(' ').replace(/[\r\n\t]+/g, ' ').trim()
  return `${now.toISOString()} ${level} ${text}`.slice(0, UI_LOG_LINE_MAX)
}

export const isAsnLog = args => typeof args?.[0] === 'string' && args[0].startsWith(TAG)

// 包住 target（console）的 info／warn／error：照常印出，[ASN] 開頭的另外排進佇列。回 { flush, pending }
export function installUiLog({ invoke, target = console, flushMs = UI_LOG_FLUSH_MS, setTimer = setTimeout, now = () => new Date() }) {
  const queue = []
  let timer = null
  let sending = false
  async function flush() {
    timer = null
    if (sending || !queue.length) return
    sending = true
    const lines = queue.splice(0, queue.length)
    try { await invoke('ui_log', { lines }) } catch { /* 寫不進去就算了：不重試、不再印記錄 */ } finally { sending = false }
  }
  for (const level of LEVELS) {
    const orig = typeof target[level] === 'function' ? target[level].bind(target) : () => {}
    target[level] = (...args) => {
      orig(...args)
      if (!isAsnLog(args)) return
      queue.push(formatUiLogLine(level, args, now()))
      if (queue.length > UI_LOG_BUFFER_MAX) queue.splice(0, queue.length - UI_LOG_BUFFER_MAX)
      if (!timer) timer = setTimer(() => void flush(), flushMs)
    }
  }
  return { flush, pending: () => queue.length }
}
