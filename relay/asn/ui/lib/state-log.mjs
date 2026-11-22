// 狀態變動記錄（#2104 B）：下列狀態「第一次記一行初始，之後只在值變了才記一行」，寫進 ui.log。
// 寫法比照 Rust 端的 PlanLog／SubLog。每行都有固定可 grep 的開頭（見 docs 與測試）；
// 只寫版本、固定代號、資料夾路徑與白話原因，不寫憑證、token、email、信件內容。
// emit(text) 由呼叫端帶進來（list.js 用 console.info('[ASN]', text)，ui-log.mjs 只收 info／warn／error 的 [ASN] 開頭記錄）。
// node 也要能載入（測試），所以不碰 window。

export const LOG_HEAD = Object.freeze({
  cliInit: 'ai-cli 初始：',
  cliChange: 'ai-cli 變動：',
  detectInit: 'ai-cli-detect 初始：',
  detectChange: 'ai-cli-detect 變動：',
  modInit: '外掛 初始：',
  modChange: '外掛 變動：',
  cwdAdd: '資料夾 加入：',
  cwdRemove: '資料夾 移除：',
  cwdReject: '資料夾 拒絕：',
})

const clean = (v, max = 100) => String(v ?? '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, max)

// ai_cli_status 一列 → { 版本, 最新, 登入 }（登入只記 in／out／unknown 與已登入家數，不記帳號）
function cliFields(t) {
  const state = t.version_state === 'latest' ? 'latest' : t.version_state === 'behind' ? 'behind' : 'unknown'
  const n = Number(t.login_count) || 0
  return {
    版本: t.installed === false ? '未安裝' : clean(t.version) || '不明',
    最新: state === 'behind' && t.latest ? `behind(${clean(t.latest, 30)})` : state,
    登入: t.login === 'in' ? (n > 1 ? `in(${n})` : 'in') : t.login === 'out' ? 'out' : 'unknown',
  }
}

// ai_cli_detect 一列 → 一個字串
const detectField = t => (t.binary_found ? `已安裝 ${clean(t.version) || '版本不明'}` : '未安裝')

const toMap = (tools, f) => {
  const m = new Map()
  for (const t of Array.isArray(tools) ? tools : []) if (t && typeof t.id === 'string') m.set(clean(t.id, 30), f(t))
  return m
}
const ids = m => [...m.keys()].sort()

export function createStateLog(emit) {
  let cli = null, detect = null, mod = null
  const out = text => { try { emit(text) } catch { /* 記錄寫不進去不影響畫面 */ } }
  return {
    /** ai_cli_status 回來的 tools；查不到（丟錯）時不要呼叫，保留上一次的值 */
    aiCliStatus(tools) {
      const cur = toMap(tools, cliFields)
      if (cli === null) {
        out(LOG_HEAD.cliInit + (ids(cur).map(id => { const f = cur.get(id); return `${id} 版本=${f.版本} 最新=${f.最新} 登入=${f.登入}` }).join('；') || '（沒有任何工具）'))
      } else {
        const diffs = []
        for (const id of new Set([...ids(cur), ...ids(cli)]).values()) {
          const a = cli.get(id), b = cur.get(id)
          if (!a || !b) { diffs.push(`${id} ${a ? '消失' : '出現'}`); continue }
          for (const k of ['版本', '最新', '登入']) if (a[k] !== b[k]) diffs.push(`${id} ${k} ${a[k]}→${b[k]}`)
        }
        if (diffs.length) out(LOG_HEAD.cliChange + diffs.join('；'))
      }
      cli = cur
    },
    /** ai_cli_detect 回來的 tools */
    aiCliDetect(tools) {
      const cur = toMap(tools, detectField)
      if (detect === null) {
        out(LOG_HEAD.detectInit + (ids(cur).map(id => `${id} ${cur.get(id)}`).join('；') || '（沒有任何工具）'))
      } else {
        const diffs = []
        for (const id of new Set([...ids(cur), ...ids(detect)]).values()) {
          const a = detect.get(id) ?? '無', b = cur.get(id) ?? '無'
          if (a !== b) diffs.push(`${id} ${a}→${b}`)
        }
        if (diffs.length) out(LOG_HEAD.detectChange + diffs.join('；'))
      }
      detect = cur
    },
    /** Claude 外掛狀態 { state, version?, reason? }（claude_mod_report、claude-mod-status 事件）；null 不記 */
    claudeMod(report) {
      if (!report || typeof report !== 'object') return
      const text = [clean(report.state, 30) || '不明', report.version ? clean(report.version, 30) : '', report.reason ? `原因：${clean(report.reason)}` : ''].filter(Boolean).join(' ')
      if (mod === null) out(LOG_HEAD.modInit + text)
      else if (mod !== text) out(LOG_HEAD.modChange + `${mod}→${text}`)
      mod = text
    },
    /** 資料夾：成功加入／移除各記一行（不重複的才記）；被拒絕（Rust 端驗證不過）把白話原因記進來 */
    cwdAdded: p => out(LOG_HEAD.cwdAdd + clean(p, 300)),
    cwdRemoved: p => out(LOG_HEAD.cwdRemove + clean(p, 300)),
    cwdRejected: (action, reason) => out(LOG_HEAD.cwdReject + `${clean(action, 10)} ${clean(reason, 200)}`),
  }
}
