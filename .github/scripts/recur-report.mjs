// 復發報告（紀律 九.1）：例行報告的「本期復發幾件」用這支算，不靠人數。
// 定義和 PR 範本檢查同一套（判斷只有一份，在 pr-checklist.mjs 的 scanRecurrences）：
// 標題是修正，而且它修的那張單在主線上已經修過並且發過版，就是復發。
//
// 用法：node .github/scripts/recur-report.mjs --since 2026-11-20 [--until 2026-11-27] [--ref origin/main]
//   --since、--until：期間的起訖日（都算在內，西元年-月-日）；沒給 --until 就算到主線最新一筆。
//   --ref：要掃的主線，預設 origin/main。
// 日期用提交時間（合併進主線的那一刻），照提交自己記的時區。
// 只讀本機 git，不連網路、不抓遠端：主線是不是最新，看輸出第一行的「最新一筆」日期。
// 結束碼：0＝報告印出來了（不管有沒有復發）；1＝參數不對或讀不到歷史。
// 判斷邏輯都是純函式（test 在 relay/asn/test/recur-report.test.mjs）；git 呼叫只在 main 裡。
import { fileURLToPath } from 'node:url'
import { historyLines, isFixTitle, scanRecurrences, ticketNumbers } from './pr-checklist.mjs'

const DATE = /^\d{4}-\d{2}-\d{2}$/
export const DEFAULT_REF = 'origin/main'
const SEP = '\t'

/** 讀參數：回 { since, until, ref } 或 { error } */
export function parseArgs(argv = []) {
  const out = { since: '', until: '', ref: DEFAULT_REF }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a !== '--since' && a !== '--until' && a !== '--ref') return { error: `看不懂的參數：${a}` }
    const v = argv[++i]
    if (!v) return { error: `${a} 後面要接內容` }
    out[a.slice(2)] = v
  }
  if (!out.since) return { error: '要給 --since 起始日（例如 --since 2026-11-20）' }
  for (const k of ['since', 'until']) if (out[k] && !DATE.test(out[k])) return { error: `--${k} 的日期要寫成 西元年-月-日（例如 2026-11-20），收到的是「${out[k]}」` }
  if (out.until && out.until < out.since) return { error: `--until（${out.until}）比 --since（${out.since}）還早` }
  return out
}

/** 歷史的每一行要取的內容：提交日期（年-月-日）＋分隔字元＋標題 */
export const LOG_FORMAT = `%cs${SEP}%s`

/** 把歷史（每行「日期＋分隔字元＋標題」，由舊到新）轉成 [{ date, title }] */
export function parseLog(lines = []) {
  return lines.filter(Boolean).map(l => {
    const i = l.indexOf(SEP)
    return i < 0 ? { date: '', title: l } : { date: l.slice(0, i), title: l.slice(i + 1) }
  })
}

/**
 * 期間內的復發。commits＝主線的提交 [{ date, title }]（由舊到新，要給完整歷史：先前修過沒有，得從頭看）。
 * 回 [{ n, date, title, priorDate, priorTitle }]，照時間由舊到新；since、until 都算在內，沒給就不設限。
 */
export function recurrencesIn(commits = [], { since = '', until = '' } = {}) {
  return scanRecurrences(commits, c => c.title).hits
    .filter(h => (!since || h.current.date >= since) && (!until || h.current.date <= until))
    .map(h => ({ n: h.n, date: h.current.date, title: h.current.title, priorDate: h.prior.date, priorTitle: h.prior.title }))
}

/** 期間內有幾筆修正（標題是修正而且有單號），給報告當分母 */
export function fixesIn(commits = [], { since = '', until = '' } = {}) {
  return commits.filter(c => (!since || c.date >= since) && (!until || c.date <= until) && isFixTitle(c.title) && ticketNumbers(c.title).length).length
}

/** 排成給人看的報告文字 */
export function formatReport({ ref = DEFAULT_REF, latest = '', since = '', until = '', fixes = 0, items = [] } = {}) {
  const tickets = new Set(items.map(x => x.n)).size
  const lines = [
    `復發報告（主線 ${ref}${latest ? `，最新一筆提交 ${latest}` : ''}）`,
    `期間：${since} ～ ${until || `${latest}（沒給結束日，算到主線最新一筆）`}`,
    `算法：標題是修正、修的那張單在主線上已經修過並且發過版，算一件復發（和 PR 範本檢查同一套）`,
    items.length ? `復發：${items.length} 件，共 ${tickets} 張單（期間內帶單號的修正共 ${fixes} 筆）` : `復發：0 件（期間內帶單號的修正共 ${fixes} 筆）`,
  ]
  for (const x of items) lines.push(`- #${x.n}　這次：${x.date}「${x.title}」　先前：${x.priorDate}「${x.priorTitle}」`)
  return lines.join('\n')
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.error) {
    console.error(`${args.error}\n用法：node .github/scripts/recur-report.mjs --since 2026-11-20 [--until 2026-11-27] [--ref origin/main]`)
    return 1
  }
  let commits
  try {
    // 歷史的取法（排序）和 PR 範本檢查共用同一個函式，兩邊算出來才會一樣
    commits = parseLog(historyLines(args.ref, { format: LOG_FORMAT }))
  } catch (e) {
    console.error(`讀不到 ${args.ref} 的提交歷史（${String(e.message).split('\n')[0]}）。請在 repo 目錄下執行；主線不叫這個名字時用 --ref 指定。`)
    return 1
  }
  const range = { since: args.since, until: args.until }
  console.log(formatReport({ ref: args.ref, latest: commits.at(-1)?.date ?? '', ...range, fixes: fixesIn(commits, range), items: recurrencesIn(commits, range) }))
  return 0
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exit(main())
