// #1841 守門：repo 追蹤的文字檔不准再出現擁有者的稱呼（開發紀律七之一第 3 條）。
//
// 這道守門的作用只有一個：防止有人「不小心再把稱呼寫回去」。它【不是保密】：
//   - 清單用的是沒加鹽的雜湊，長度也是公開的；兩三個字的中文、七八個字母的英文，窮舉一下就能還原。
//   - 這個 repo 的 PR 歷史與 git 歷史本來就留有舊內容，不會因為這個測試而消失。
// 所以不要把這份清單當成機密，也不要在別處宣稱它能保密；真要保密得換方式（例如清單放 CI secret）。
// 清單裡每個稱呼正規化（NFKC、小寫、去零寬字元）後只存 [長度, 快速雜湊, sha256]；真稱呼在 repo 任何形式都不出現，
// 自我測試用的也是臨時合成的假名。命中時只報位置（CI 上只報檔案序號與行號，避免路徑本身進公開 log）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// [長度, FNV-1a 32 位元, sha256]
export const BLOCKED = [
  [2, 3162880579, 'b0c63928f74234599875c0fb75220294cc139f44c525c439fb6382ab659dae65'],
  [3, 1826008914, '5901df67d9d01f268f0f6391e17c58e4533a96c5e5beba3fc6eb626f2f43b90c'],
  [2, 2882427283, '64d35779f3ccc1d4c02c4ab8bbac93806878c6d70841f37143e8af4875037c81'],
  [3, 1795114218, '08157ce1fa934f987448fc60c2ab81c793956274321065321192147f7fae2101'],
  [3, 217927104, 'f0d215490bcb86cad3bde8d9303278a95bccb7b9092c381159681923ef2fda28'],
  [8, 3440370851, '69ce9add341076df5f9005edb21a67e73d288de72a7c23cf22d5999d54e69c37'],
  [7, 4261061008, '3da4c3d21d1dbd976cc60a277536c3219ea05e2af527cad0dbcc0aa72a50134e'],
]

const fnv = (s, from, len) => {
  let h = 0x811c9dc5
  for (let i = from; i < from + len; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0 }
  return h
}
const sha = s => createHash('sha256').update(s).digest('hex')
// 正規化：全形轉半形（NFKC）、小寫、去零寬字元
const norm = s => s.normalize('NFKC').toLowerCase().replace(/[\u200b-\u200f\u2060\ufeff\u00ad]/g, '')
// 分隔符（空白、底線、連字號、點）去掉的版本也比一次，擋「拼音加空格或底線」
const stripSep = s => s.replace(/[\s_\-.\u00b7]/g, '')

// 用 [長度, 快速雜湊, sha256] 表做出比對函式；回傳該行第一個命中的位置（-1＝乾淨），不回命中的字
export function makeMatcher(table) {
  const lengths = [...new Set(table.map(b => b[0]))]
  const fast = new Set(table.map(b => b[1]))
  const full = new Set(table.map(b => b[2]))
  const scan = s => {
    for (let i = 0; i < s.length; i++) {
      for (const len of lengths) {
        if (i + len > s.length) continue
        if (fast.has(fnv(s, i, len)) && full.has(sha(s.slice(i, i + len)))) return i
      }
    }
    return -1
  }
  return line => {
    const s = norm(line)
    const a = scan(s)
    return a >= 0 ? a : scan(stripSep(s))
  }
}
// 由明文算出一筆表項（只給自我測試用合成的假名；真清單不經這裡）
export const entryOf = word => { const w = norm(word); return [w.length, fnv(w, 0, w.length), sha(w)] }

const findBlocked = makeMatcher(BLOCKED)
const root = fileURLToPath(new URL('..', import.meta.url))
// 只略過頂層以外也算：任何路徑段叫 node_modules／target 的追蹤檔都不掃（它們不是我們寫的）
const SKIP_DIR = /(^|\/)(node_modules|target)\//

test('#1841：追蹤的文字檔沒有擁有者稱呼', () => {
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: root, maxBuffer: 1 << 28 })
    .toString('utf8').split('\0').filter(Boolean)
  const inCI = !!process.env.CI
  const hits = []
  files.forEach((f, idx) => {
    if (SKIP_DIR.test(f)) return
    const label = inCI ? `檔案序號 ${idx}（git ls-files -z 的第 ${idx} 個，從 0 起算）` : f
    if (findBlocked(f) >= 0) hits.push(`${label} 的檔名`)
    let buf
    try { buf = readFileSync(root + f) } catch { return } // 已刪除或讀不到的追蹤項
    if (buf.includes(0)) return // 二進位檔
    const lines = buf.toString('utf8').split('\n')
    for (let n = 0; n < lines.length; n++) if (findBlocked(lines[n]) >= 0) hits.push(`${label} 第 ${n + 1} 行`)
  })
  assert.deepEqual(hits, [], `這些位置還有擁有者稱呼，請改成「擁有者」或中性名稱：\n${hits.join('\n')}`)
})

test('#1841：清單格式正確（長度 2～10、雜湊格式、沒有重複）', () => {
  for (const [len, f, h] of BLOCKED) {
    assert.ok(Number.isInteger(len) && len >= 2 && len <= 10)
    assert.ok(Number.isInteger(f) && f >= 0 && f <= 0xffffffff)
    assert.match(h, /^[0-9a-f]{64}$/)
  }
  assert.equal(new Set(BLOCKED.map(b => b[2])).size, BLOCKED.length)
})

test('#1841：比對邏輯有效（用臨時合成的假名，與任何真稱呼無關）', () => {
  const m = makeMatcher([entryOf('甲乙丙'), entryOf('Zeta-Omega'), entryOf('ZetaOmega')])
  assert.ok(m('前文甲乙丙後文') >= 0, '中文命中')
  assert.ok(m('前文甲乙丙後文') === 2, '位置正確')
  assert.ok(m('ZETA-OMEGA') >= 0, '大小寫不影響')
  assert.ok(m('ＺＥＴＡ－ＯＭＥＧＡ') >= 0, '全形字母也抓')
  assert.ok(m('zeta_omega') >= 0 && m('zeta omega') >= 0 && m('zetaomega') >= 0, '分隔符變化也抓')
  assert.ok(m('甲\u200b乙丙') >= 0, '夾零寬字元也抓')
  assert.equal(m('擁有者與測試用戶 owner@example.com'), -1, '一般文字不誤報')
  assert.equal(m('甲乙'), -1, '只有一部分不算')
})
