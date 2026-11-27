// 守門：流程規則只有 docs/開發紀律.md 一份（開發紀律第零節）。
// 由來（2026-11-27 流程盤點）：規則原本散在 開發紀律、TEAM-FLOW、版本規劃 三份，領隊是誰、要幾審、誰能合併互相矛盾；
// 版本規劃手寫的「已發」表落後 40 版、做完的單還寫「待領」。不記得前情的夥伴讀到哪一份就照哪一份做。
// 這支守四件事：① 舊文件不准寫回規則或手寫的表 ② 規則對照表登記的守門真的存在 ③ 專案守則指到的規範文件都存在 ④ 開發紀律裡的連結沒斷。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n')
const exists = rel => fs.existsSync(path.join(ROOT, rel))

const RULES = 'docs/開發紀律.md'
const TABLE_TITLE = '## 規則對照表'
export const MODES = ['機器擋', '靠人']

/** 取出某個標題底下第一張 Markdown 表的資料列（去掉表頭與分隔線），每列回傳各欄文字 */
export function tableUnder(md, title) {
  const at = md.indexOf(title)
  if (at < 0) return null
  const rest = md.slice(at + title.length)
  const next = rest.search(/\n## /)
  const lines = (next < 0 ? rest : rest.slice(0, next)).split('\n').filter(l => l.startsWith('|'))
  return lines.slice(2).map(l => l.replace(/^\|/, '').replace(/\|\s*$/, '').split('|').map(c => c.trim()))
}

/** 一段文字裡用反引號包起來、看起來是 repo 內路徑的字串 */
export const pathsIn = text => [...String(text).matchAll(/`([^`]+)`/g)].map(m => m[1]).filter(p => /[/.]/.test(p) && !/\s/.test(p))

test('開發紀律開頭寫明「流程規則只有這一份」，並有第零節與規則對照表', () => {
  const md = read(RULES)
  assert.ok(md.includes('流程規則只有這一份'), '開發紀律開頭要寫明流程規則只有這一份')
  assert.ok(md.includes('## 零、規則怎麼立'), '開發紀律要有第零節「規則怎麼立」')
  assert.ok(md.includes(TABLE_TITLE), '開發紀律文末要有「規則對照表」')
})

test('規則對照表：每列四欄，執行方式只能是「機器擋」或「靠人」', () => {
  const rows = tableUnder(read(RULES), TABLE_TITLE)
  assert.ok(rows && rows.length >= 30, `規則對照表至少要有 30 列，現在 ${rows?.length ?? 0} 列（整張表不見了？）`)
  for (const r of rows) {
    assert.equal(r.length, 4, `這一列不是四欄：${r.join(' | ')}`)
    assert.ok(r[0], '規則欄不能空')
    assert.ok(MODES.includes(r[2]), `「${r[0]}」的執行方式是「${r[2]}」，只能填 機器擋 或 靠人（一條規則兩種都有，就拆成兩列）`)
  }
})

test('規則對照表：「機器擋」的每一列都寫了守門檔案，而且檔案真的存在', () => {
  const rows = tableUnder(read(RULES), TABLE_TITLE)
  const missing = []
  for (const r of rows.filter(r => r[2] === '機器擋')) {
    const ps = pathsIn(r[3])
    assert.ok(ps.length > 0, `「${r[0]}」標成機器擋，卻沒寫是哪個守門檔案（用反引號寫完整路徑）`)
    for (const p of ps) if (!exists(p)) missing.push(`「${r[0]}」→ ${p}`)
  }
  assert.deepEqual(missing, [], `規則對照表寫的守門檔案不存在（守門被刪或改名了？改名就一起改這張表；真的拿掉守門，就把這一列改成「靠人」並寫誰查）：\n${missing.join('\n')}`)
})

test('規則對照表：「靠人」的每一列都寫了誰查；提到的工具檔案也要存在', () => {
  const rows = tableUnder(read(RULES), TABLE_TITLE)
  for (const r of rows.filter(r => r[2] === '靠人')) {
    assert.ok(r[3].replace(/[\s。，、：:]/g, '').length >= 2, `「${r[0]}」標成靠人，要寫誰在什麼時候查`)
    for (const p of pathsIn(r[3])) assert.ok(exists(p), `「${r[0]}」提到的 ${p} 不存在`)
  }
})

test('規則對照表：同一條規則不重複登記', () => {
  const names = tableUnder(read(RULES), TABLE_TITLE).map(r => r[0])
  const dup = names.filter((n, i) => names.indexOf(n) !== i)
  assert.deepEqual(dup, [], `重複的列：${dup.join('、')}`)
})

test('docs/TEAM-FLOW.md 只是指向開發紀律，不准寫回規則', () => {
  const md = read('docs/TEAM-FLOW.md')
  const lines = md.trim().split('\n')
  assert.ok(md.includes('開發紀律.md'), 'TEAM-FLOW 要指向開發紀律')
  assert.ok(lines.length <= 30, `TEAM-FLOW 現在 ${lines.length} 行：它只能是指向（30 行以內），規則請寫進開發紀律`)
  assert.ok(!lines.some(l => /^##\s/.test(l)), 'TEAM-FLOW 不准再有小節：規則請寫進開發紀律')
})

test('docs/版本規劃.md 不准有手寫的「已發」表、「開發順序」表或規則小節', () => {
  const md = read('docs/版本規劃.md')
  const lines = md.split('\n')
  const released = lines.filter(l => /^\|\s*\d+\.\d+\.\d+\s*\|/.test(l))
  assert.deepEqual(released, [], '版本規劃不准手寫已發版本的表（它會過期）：已發內容以 relay/asn/CHANGELOG.md 與 GitHub Release 為準')
  const queue = lines.filter(l => /^\|\s*(PR\s*)?#\d+\s*\|/.test(l))
  assert.deepEqual(queue, [], '版本規劃不准手寫開發順序的表（它會過期）：順序以 GitHub 上開著的單為準')
  assert.ok(!lines.some(l => /^##\s*規則/.test(l)), '版本規劃不准另寫一份規則：開發順序與版號的規則在開發紀律第九之一節')
  assert.ok(md.includes('開發紀律.md'), '版本規劃要指向開發紀律')
  assert.ok(md.includes('## 調整紀錄'), '版本規劃要保留「調整紀錄」')
})

test('專案守則（CLAUDE.md）指到的規範文件都存在', () => {
  const md = read('CLAUDE.md')
  for (const f of ['docs/開發紀律.md', 'docs/唯一出口.md', 'docs/退場清單.md', 'docs/通知種類.md']) {
    assert.ok(md.includes(f), `CLAUDE.md 要指向 ${f}（新開的夥伴只會先讀 CLAUDE.md）`)
    assert.ok(exists(f), `${f} 不存在`)
  }
})

test('開發紀律裡連到其他文件的連結都沒斷', () => {
  const md = read(RULES)
  const links = [...md.matchAll(/\]\(([^)#]+\.md)(#[^)]*)?\)/g)].map(m => m[1]).filter(l => !/^https?:/.test(l))
  assert.ok(links.length >= 4, '開發紀律應該至少連到唯一出口、退場清單、通知種類、畫面規範等文件')
  const broken = [...new Set(links)].filter(l => !exists(path.posix.join('docs', l)))
  assert.deepEqual(broken, [], `開發紀律裡的連結找不到檔案：${broken.join('、')}`)
})

test('解析工具本身：tableUnder 只取標題底下那張表、pathsIn 只取路徑', () => {
  const md = '# x\n\n## 甲\n\n| a | b |\n|---|---|\n| 1 | `p/q.mjs` |\n\n## 乙\n\n| c |\n|---|\n| 9 |\n'
  assert.deepEqual(tableUnder(md, '## 甲'), [['1', '`p/q.mjs`']])
  assert.equal(tableUnder(md, '## 丙'), null)
  assert.deepEqual(pathsIn('用 `a/b.mjs` 檢查，不是 `代號` 也不是 `有 空白/x`'), ['a/b.mjs'])
})
