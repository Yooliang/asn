// PR 範本檢查（#1805）：PR 說明裡三項必填檢查沒勾、或沒附說明就紅；加「復發」標籤的 PR 要有以單號命名的守門測試。
// 檢查邏輯都是純函式（test 在 relay/asn/test/pr-checklist.test.mjs）；直接執行時讀 GitHub 的事件檔，沒有任何外部相依、不打 API。
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

/** 三項必填檢查：key＝範本裡那句問題的關鍵字（用來在 PR 說明找那一行），label＝報錯用的名字 */
export const ITEMS = [
  { id: 'both', key: '手機和電腦一起改了嗎', label: '手機和電腦一起改了嗎' },
  { id: 'real', key: '測試用的是真資料或真路徑嗎', label: '測試用的是真資料或真路徑嗎' },
  { id: 'regress', key: '舊程式會紅」的回歸測試嗎', label: '有「舊程式會紅」的回歸測試嗎' },
]
export const EXEMPT_LABEL = '免檢查表'
export const RECUR_LABEL = '復發'
const MIN_DESC = 6   // 說明至少這麼多字（拿掉空白與符號後）
const BOX = /^\s*[-*]\s*\[[ xX]\]/   // 勾選項那一行的開頭：- [ ] 或 - [x]
const CHECKED = /^\s*[-*]\s*\[[xX]\]/

/** 去掉 HTML 註解（範本上方的說明文字不能算數） */
export const stripComments = body => String(body ?? '').replace(/<!--[\s\S]*?-->/g, '')

/** 說明是不是真的寫了：範本留下的「…」、純標點、太短都不算 */
export function descOk(desc) {
  const t = String(desc ?? '').trim()
  if (!t || t.startsWith('…') || t.startsWith('...')) return false
  const core = t.replace(/[\s…。，、；：:;,.()（）「」『』\-—*_`~!?！？]/g, '')
  return core.length >= MIN_DESC
}

/** 從 PR 說明取出三項的勾選狀態與說明。回 [{ id, label, found, checked, desc, ok, why }] */
export function parseChecklist(body) {
  const lines = stripComments(body).split(/\r?\n/)
  return ITEMS.map(it => {
    const i = lines.findIndex(l => BOX.test(l) && l.includes(it.key))
    if (i < 0) return { id: it.id, label: it.label, found: false, checked: false, desc: '', ok: false, why: '說明裡找不到這一項（不要刪掉範本的必填檢查）' }
    const checked = CHECKED.test(lines[i])
    // 說明＝這一行問題後面「說明：」或「測試名稱：」之後的字，加上之後的續行（到下一個勾選項或標題為止）
    const after = lines[i].slice(lines[i].indexOf(it.key) + it.key.length)
    const m = /[：:]/.exec(after)
    const first = m ? after.slice(m.index + 1) : ''
    const rest = []
    for (let j = i + 1; j < lines.length; j++) {
      if (BOX.test(lines[j]) || /^#{1,6}\s/.test(lines[j])) break
      rest.push(lines[j])
    }
    const desc = [first, ...rest].join(' ').replace(/\*+/g, '').trim()
    const ok = checked && descOk(desc)
    const why = !checked ? '沒有勾' : !descOk(desc) ? '沒有寫說明（或還是範本的「…」）' : ''
    return { id: it.id, label: it.label, found: true, checked, desc, ok, why }
  })
}

/** 檔案路徑是不是「只有文件或 CI 設定」（豁免標籤要靠這個驗證，貼了標籤也不放行程式變更） */
export const isDocOrCi = f => /\.md$/i.test(f) || f.startsWith('docs/') || f.startsWith('.github/')

/** 這張 PR 能不能免檢查表：回 { exempt, why, abuse }；abuse＝貼了標籤但改了不該豁免的檔案 */
export function exemption({ title = '', headRef = '', labels = [], files = [] } = {}) {
  if (/^tmp:/i.test(title.trim())) return { exempt: true, why: '臨時 CI 載具 PR（標題 tmp:）' }
  if (headRef.startsWith('release/')) return { exempt: true, why: 'release 分支' }
  if (labels.includes(EXEMPT_LABEL)) {
    const bad = files.filter(f => !isDocOrCi(f))
    if (files.length === 0) return { exempt: false, abuse: '貼了「免檢查表」標籤但看不到改了哪些檔案', why: '' }
    if (bad.length) return { exempt: false, abuse: `貼了「免檢查表」標籤，但改了文件與 CI 設定以外的檔案：${bad.slice(0, 5).join('、')}${bad.length > 5 ? ` 等 ${bad.length} 個` : ''}`, why: '' }
    return { exempt: true, why: '免檢查表標籤（改的檔案只有文件與 CI 設定）' }
  }
  return { exempt: false, why: '' }
}

/** 測試檔路徑 */
export const isTestPath = f => /(^|\/)(tests?|__tests__|golden)\//.test(f) || /([._-]test\.|_test\.|tests\.rs$)/.test(f)

/** 從 unified diff（-U0）取出每個檔案新增的行：Map(檔名 → [行…]) */
export function addedLines(diff) {
  const out = new Map()
  let file = ''
  for (const l of String(diff ?? '').split(/\r?\n/)) {
    const m = /^\+\+\+ b\/(.+)$/.exec(l)
    if (m) { file = m[1]; if (!out.has(file)) out.set(file, []); continue }
    if (l.startsWith('+') && !l.startsWith('+++') && file) out.get(file).push(l.slice(1))
  }
  return out
}

/** 「復發」標籤：PR 說明要寫「復發單號：#N」，而且這張 PR 要加一支以 N 命名的守門測試（檔名有 N，或新增的測試程式裡有 N） */
export function recurrence({ labels = [], body = '', files = [], added = new Map() } = {}) {
  if (!labels.includes(RECUR_LABEL)) return { required: false, ok: true, why: '' }
  const m = /復發單號\s*[：:]\s*#?(\d+)/.exec(stripComments(body))
  if (!m) return { required: true, ok: false, why: '有「復發」標籤，PR 說明要寫「復發單號：#單號」' }
  const n = m[1]
  const num = new RegExp(`(^|[^0-9])${n}([^0-9]|$)`)
  const byName = files.filter(f => isTestPath(f) && num.test(f))
  if (byName.length) return { required: true, ok: true, n, why: `守門測試檔：${byName[0]}` }
  for (const [f, lines] of added) {
    if (!(isTestPath(f) || f.endsWith('.rs') || f.endsWith('.ts'))) continue
    if (lines.some(l => num.test(l) && /(test|fn |assert|describe|it\()/.test(l))) return { required: true, ok: true, n, why: `守門測試：${f}` }
  }
  return { required: true, ok: false, n, why: `復發的 PR 必須加一支以單號 #${n} 命名的守門測試（檔名含 ${n}，或新增的測試裡寫上 ${n}）` }
}

/** 整合：回 { pass, lines（報告）, errors } */
export function evaluate({ title, body, headRef, labels = [], files = [], added = new Map() }) {
  const errors = []
  const lines = []
  const ex = exemption({ title, headRef, labels, files })
  if (ex.abuse) errors.push(ex.abuse)
  if (ex.exempt) lines.push(`- ✅ 免檢查表：${ex.why}`)
  else {
    for (const r of parseChecklist(body)) {
      if (r.ok) lines.push(`- ✅ ${r.label}`)
      else { lines.push(`- ❌ ${r.label}：${r.why}`); errors.push(`「${r.label}」${r.why}`) }
    }
  }
  const rc = recurrence({ labels, body, files, added })
  if (rc.required) {
    if (rc.ok) lines.push(`- ✅ 復發：${rc.why}`)
    else { lines.push(`- ❌ 復發：${rc.why}`); errors.push(rc.why) }
  }
  return { pass: errors.length === 0, lines, errors }
}

// core.quotePath=false：不加的話，git 會把中文檔名印成 "docs/\345\276…"（加引號、轉八進位），
// isDocOrCi／isTestPath 認不出來，只改中文檔名文件的 PR 貼「免檢查表」會被誤擋。
function git(args, cwd) {
  return execFileSync('git', ['-c', 'core.quotePath=false', ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, cwd })
}

/** 取 base...HEAD 改到的檔名與新增行（檔名保留原字，不轉義） */
export function changedFiles(base, cwd) {
  const files = git(['diff', '--name-only', `${base}...HEAD`], cwd).split(/\r?\n/).filter(Boolean)
  const added = addedLines(git(['diff', '-U0', '--no-color', `${base}...HEAD`], cwd))
  return { files, added }
}

function main() {
  const evPath = process.env.GITHUB_EVENT_PATH
  const ev = evPath && fs.existsSync(evPath) ? JSON.parse(fs.readFileSync(evPath, 'utf8')) : null
  const pr = ev?.pull_request
  if (!pr) { console.log('不是 pull_request 事件，略過'); return 0 }
  const base = `origin/${pr.base.ref}`
  let files = [], added = new Map()
  try {
    ;({ files, added } = changedFiles(base))
  } catch (e) {
    console.log(`::warning::取不到改動的檔案清單（${String(e.message).split('\n')[0]}），豁免與復發檢查可能不準`)
  }
  const labels = (pr.labels ?? []).map(l => l.name)
  const res = evaluate({ title: pr.title, body: pr.body, headRef: pr.head?.ref ?? '', labels, files, added })
  const md = ['## PR 範本檢查', '', ...res.lines, '', res.pass ? '通過。' : '**沒通過**：到 PR 說明把三項必填檢查勾起來並寫說明（範本見 .github/pull_request_template.md）；只改文件／CI 的 PR 可加標籤「免檢查表」。', ''].join('\n')
  console.log(md)
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + '\n')
  for (const e of res.errors) console.log(`::error::${e}`)
  return res.pass ? 0 : 1
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exit(main())
