// #1841 守門：repo 追蹤的文字檔不准出現擁有者的稱呼（開發紀律七之一第 3 條）。
// 守門清單不寫明文（寫了就等於把名字寫進公開 repo）：每個稱呼正規化（NFC、小寫）後只存長度、快速雜湊與 sha256；
// 掃描時對每一行每個位置取該長度的子字串比對，先用快速雜湊篩，命中再用 sha256 確認。
// 命中時只報檔名與行號，不印命中的字。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// [長度, FNV-1a 32 位元, sha256]
const BLOCKED = [
  [2, 3162880579, 'b0c63928f74234599875c0fb75220294cc139f44c525c439fb6382ab659dae65'],
  [3, 1826008914, '5901df67d9d01f268f0f6391e17c58e4533a96c5e5beba3fc6eb626f2f43b90c'],
  [2, 2882427283, '64d35779f3ccc1d4c02c4ab8bbac93806878c6d70841f37143e8af4875037c81'],
  [3, 1795114218, '08157ce1fa934f987448fc60c2ab81c793956274321065321192147f7fae2101'],
  [3, 217927104, 'f0d215490bcb86cad3bde8d9303278a95bccb7b9092c381159681923ef2fda28'],
  [8, 3440370851, '69ce9add341076df5f9005edb21a67e73d288de72a7c23cf22d5999d54e69c37'],
  [7, 4261061008, '3da4c3d21d1dbd976cc60a277536c3219ea05e2af527cad0dbcc0aa72a50134e'],
]
const LENGTHS = [...new Set(BLOCKED.map(b => b[0]))]
const FAST = new Set(BLOCKED.map(b => b[1]))
const SHA = new Set(BLOCKED.map(b => b[2]))

const fnv = (s, from, len) => {
  let h = 0x811c9dc5
  for (let i = from; i < from + len; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0 }
  return h
}
const sha = s => createHash('sha256').update(s).digest('hex')

// 回傳這一行第一個命中的位置（-1 表示乾淨）；只回位置，不回命中的字
export function findBlocked(line) {
  const s = line.normalize('NFC').toLowerCase()
  for (let i = 0; i < s.length; i++) {
    for (const len of LENGTHS) {
      if (i + len > s.length) continue
      if (FAST.has(fnv(s, i, len)) && SHA.has(sha(s.slice(i, i + len)))) return i
    }
  }
  return -1
}

const root = fileURLToPath(new URL('..', import.meta.url))
const SKIP_DIR = /(^|\/)(node_modules|target)\//

test('#1841：追蹤的文字檔沒有擁有者稱呼', () => {
  const t0 = Date.now()
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: root, maxBuffer: 1 << 28 })
    .toString('utf8').split('\0').filter(f => f && !SKIP_DIR.test(f))
  const hits = []
  for (const f of files) {
    let buf
    try { buf = readFileSync(root + f) } catch { continue } // 已刪除或讀不到的追蹤項
    if (buf.includes(0)) continue // 二進位檔
    const lines = buf.toString('utf8').split('\n')
    for (let n = 0; n < lines.length; n++) if (findBlocked(lines[n]) >= 0) hits.push(`${f}:${n + 1}`)
    if (findBlocked(f) >= 0) hits.push(`${f} (檔名)`)
  }
  assert.deepEqual(hits, [], `這些位置還有擁有者稱呼，請改成「擁有者」或中性名稱：\n${hits.join('\n')}`)
  assert.ok(Date.now() - t0 < 15000, '掃描太慢，檢查是否掃到不該掃的目錄')
})

test('#1841：守門本身有效（自測用的組字，不在檔案裡留明文）', () => {
  // 用 code point 組出稱呼，確認比對真的會命中；也確認一般文字不誤報
  const a = String.fromCodePoint(0x5c0f, 0x826f) // 兩字稱呼
  const b = String.fromCodePoint(0x6e29, 0x555f, 0x826f) // 三字稱呼
  assert.ok(findBlocked(`前文${a}後文`) >= 0)
  assert.ok(findBlocked(b) >= 0)
  assert.ok(findBlocked(['Qi', 'Liang'].join('-').toUpperCase()) >= 0, '大小寫不影響')
  assert.equal(findBlocked('擁有者與測試用戶 owner@example.com'), -1)
})
