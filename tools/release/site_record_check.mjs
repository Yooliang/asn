// 官網版本紀錄草稿（#1892 規格 2.4）：由 CHANGELOG 的一段產出 { version, date, commit, items, platforms }，並用與
// supabase/functions/_shared/site_write.ts（parseRelease、checkText）相同的規則預檢。CI 的 guard 與 site-draft 都用它。
// 規則不與 site_write.ts 共用同一份檔（那邊是 Deno 的 .ts 且含型別與 Deno 專用註解，Node 不能直接載入）；
// 改以測試把 site_write.ts 的規則字面（正則、上限）讀出來與這裡逐項比對，兩邊漂移就會紅（見 test/site-record-check.test.mjs）。
// 全部是純函式，檔案內容與 git 結果由呼叫端傳入；錯誤訊息只寫第幾條與原因，不複述內容（CI log 與 issue 留言是公開的）。
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// ---- 與 site_write.ts 同步的規則（有測試比對字面）----
export const VERSION_RE = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/
export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
export const COMMIT_RE = /^[0-9a-f]{7,40}$/
// eslint-disable-next-line no-control-regex
export const CONTROL_RE = /[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]/
export const UNSAFE_RES = [
  /<\s*\/?\s*[A-Za-z!?]/, // HTML 標籤
  /[A-Za-z0-9_.+-]+@[A-Za-z0-9_-]+\.[A-Za-z0-9_.]+/, // 電子郵件
  /[A-Za-z]:\\|\/home\/|\/Users\/|~\/\./, // 本機路徑
  /eyJ[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}|service_role/, // 金鑰樣式
]
export const LIMITS = { itemsMin: 1, itemsMax: 30, itemLen: 1000, platformsMax: 10, platformLen: 20 }

// 一段公開文字：'ok'、'bad'（空白、太長、控制字元）、'unsafe'（不能公開）。長度以 code point 算
export function checkText(v, max) {
  if (typeof v !== 'string' || v.trim() === '' || [...v].length > max || CONTROL_RE.test(v) || v.includes('\0')) return 'bad'
  return UNSAFE_RES.some(re => re.test(v)) ? 'unsafe' : 'ok'
}

export function validDate(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false
  const d = new Date(`${s}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s
}

const textArrayProblems = (v, min, max, len, field, label) => {
  if (!Array.isArray(v) || v.length < min || v.length > max) {
    return [{ field, error: 'bad_request', message: `${label}要有 ${min} 到 ${max} 條（現在是${Array.isArray(v) ? ` ${v.length} ` : '不是清單'}）` }]
  }
  const out = []
  v.forEach((s, i) => {
    const c = checkText(s, len)
    if (c === 'unsafe') out.push({ field, error: 'unsafe_content', index: i, message: `${label}第 ${i + 1} 條含不能公開的內容（HTML 標籤、電子郵件、本機路徑或金鑰樣式）` })
    else if (c !== 'ok') {
      const tooLong = typeof s === 'string' && [...s].length > len
      out.push({ field, error: 'bad_request', index: i, message: `${label}第 ${i + 1} 條${tooLong ? `超過 ${len} 字（${[...s].length} 字，不會自動截斷，請改寫）` : '是空白或含控制字元'}` })
    }
  })
  return out
}

// 檢查一筆官網紀錄（欄位同 site_write.ts 的 parseRelease，但草稿要求全部欄位都有）。回傳問題清單，空陣列＝通過
export function checkRecord(rec) {
  if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return [{ field: null, error: 'bad_request', message: '紀錄不是物件' }]
  const out = []
  if (typeof rec.version !== 'string' || !VERSION_RE.test(rec.version)) out.push({ field: 'version', error: 'bad_request', message: '版本號格式不對' })
  if (!validDate(rec.date)) out.push({ field: 'date', error: 'bad_request', message: '發版日期格式不對或不是真實日期' })
  if (typeof rec.commit !== 'string' || !COMMIT_RE.test(rec.commit)) out.push({ field: 'commit', error: 'bad_request', message: 'commit 要是 7 到 40 位小寫十六進位' })
  out.push(...textArrayProblems(rec.items, LIMITS.itemsMin, LIMITS.itemsMax, LIMITS.itemLen, 'items', '更新說明'))
  out.push(...textArrayProblems(rec.platforms, 0, LIMITS.platformsMax, LIMITS.platformLen, 'platforms', '發佈平台'))
  return out
}

// ---- CHANGELOG 解析 ----
const HEADING_RE = /^##\s+(\d+\.\d+\.\d+)（(\d{4}-\d{2}-\d{2})）\s*$/

// 切成「## 開頭的段落」：每段 { heading, version, date, lines }；標題不合格式時 version／date 為 null
export function changelogSections(text) {
  const lines = String(text ?? '').replace(/\r\n/g, '\n').split('\n')
  const out = []
  let cur = null
  for (const line of lines) {
    if (/^##\s/.test(line)) {
      const m = HEADING_RE.exec(line)
      cur = { heading: line, version: m ? m[1] : null, date: m ? m[2] : null, lines: [] }
      out.push(cur)
    } else if (cur) cur.lines.push(line)
  }
  return out
}

// 一段的 items：頂層 bullet 一條；縮排續行以空白併入；縮排子 bullet 以「；」併入父條；標題與非 bullet 段落不算
export function sectionItems(lines) {
  const items = []
  let cur = -1
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '')
    if (line === '') continue
    const top = /^[-*] (.*)$/.exec(line)
    if (top) {
      items.push(top[1].trim())
      cur = items.length - 1
    } else if (/^[ \t]/.test(line)) {
      if (cur < 0) continue
      const child = /^[ \t]+[-*] (.*)$/.exec(line)
      if (child) items[cur] += `；${child[1].trim()}`
      else items[cur] += ` ${line.trim()}`
    } else cur = -1 // 頂層的非 bullet 段落：自己不算 item，也結束前一條
  }
  return items
}

// 由第 index 段（預設最新一段）產草稿。commit 由呼叫端給（git rev-parse --short=8 <標籤>^{commit}）。
// 回 { ok, draft, problems }：標題不合格式、沒有內容或任何規則不符都算失敗，不放寬、不截斷
export function draftFromChangelog({ changelog, commit, index = 0, version = null }) {
  const sec = changelogSections(changelog)[index]
  if (!sec) return { ok: false, draft: null, problems: [{ field: 'changelog', error: 'bad_request', message: 'CHANGELOG 沒有這一段' }] }
  if (!sec.version) return { ok: false, draft: null, problems: [{ field: 'changelog', error: 'bad_request', message: '段落標題不是「## 版本（日期）」格式' }] }
  const draft = { version: sec.version, date: sec.date, commit, items: sectionItems(sec.lines), platforms: ['官網'] }
  const problems = checkRecord(draft)
  if (version && sec.version !== version) problems.unshift({ field: 'version', error: 'bad_request', message: `CHANGELOG 最新一段是 ${sec.version}，不是 ${version}` })
  return { ok: problems.length === 0, draft, problems }
}

// ---- 薄 CLI：node tools/release/site_record_check.mjs --changelog <檔> --tag v<版本> [--out <json>]
const arg = (a, k) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : undefined }
export function main(argv = process.argv.slice(2), { readFile = p => fs.readFileSync(p, 'utf8'), writeFile = (p, t) => fs.writeFileSync(p, t), git = a => execFileSync('git', a, { encoding: 'utf8' }).trim(), log = console.log } = {}) {
  const file = arg(argv, '--changelog')
  const tag = arg(argv, '--tag')
  const out = arg(argv, '--out')
  if (!file || !tag || !/^v\d+\.\d+\.\d+$/.test(tag)) { log('用法：--changelog <CHANGELOG.md> --tag v<版本> [--out <json>]'); return 2 }
  let commit
  try { commit = git(['rev-parse', '--short=8', `${tag}^{commit}`]) } catch { log(`讀不到標籤 ${tag} 的 commit`); return 1 }
  const r = draftFromChangelog({ changelog: readFile(file), commit, version: tag.slice(1) })
  if (!r.ok) {
    log(`官網紀錄預檢沒過（${r.problems.length} 項）：`)
    for (const p of r.problems) log(`- ${p.message}`)
    return 1
  }
  if (out) writeFile(out, `${JSON.stringify(r.draft, null, 2)}\n`)
  log(`官網紀錄草稿 OK：v${r.draft.version}，${r.draft.items.length} 條`)
  return 0
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exit(main())
