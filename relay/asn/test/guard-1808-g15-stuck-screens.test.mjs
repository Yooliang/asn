// #1808 第 15 組守門：夥伴卡在 CLI 某個畫面，ASN 沒認出也沒通知（復發單號：#1254 #1512 #1632 #1637 #1640 #1792 #1799）
//
// 一直被弄壞的那條規則：夥伴停在需要人處理的畫面時，ASN 要「認得出（偵測）→ 分類成固定代號 → 名單與提醒都有一句白話」，
// 而且偵測用的字串要和 Claude Code 真的畫面一致。每遇到一種新畫面，這條鏈要同時補三處（Rust 偵測的種類與代號、名單說明、前端提醒文字），
// 漏一處就是「卡著沒人知道」：#1254 Held message、#1512 額度選單、#1632 首次確認、#1792 登入逾時，都是這樣一個一個補。
//
// 這支測試從真的原始碼讀出「畫面種類」清單，三處必須同步；偵測字串要在 src-tauri/tests/fixtures 的真畫面樣本裡找得到
// （Claude Code 改字，或字串打錯，偵測就靜默失效）。之後新增一種畫面，漏登記任何一處都會在這裡紅。
//
// 待補（#1792 的修法在 PR #1795，#1799 還沒有 PR，都還沒進 main）：等進 main 後補一支用「Login reached its time limit」真畫面樣本的偵測測試；
// 新種類只要依這裡的規則登記，這支測試會自動涵蓋。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { noticeText, viewHint } from '../ui/lib/partner-notice.mjs'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = p => fs.readFileSync(path.join(root, p), 'utf8').replace(/\r\n/g, '\n')
const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]))

const screen = read('src-tauri/src/launch/claude_screen.rs')
const prod = screen.split('#[cfg(test)]')[0]
const roster = read('src-tauri/src/bridge/roster.rs')

/** 畫面種類（Rust enum 的每個變體） */
const kinds = [...prod.split('pub enum ClaudeScreenKind {')[1].split('\n}\n')[0].matchAll(/^\s{4}([A-Z][A-Za-z]+),/gm)].map(m => m[1])
/** status_code 對照：種類 → 固定代號 */
const codeOf = Object.fromEntries([...prod.split('pub fn status_code(')[1].split('\n}\n')[0].matchAll(/ClaudeScreenKind::([A-Za-z]+) => "([a-z_]+)"/g)].map(m => [m[1], m[2]]))
/** 名單 screen_label 認得的代號 */
const labelCodes = new Set([...roster.split('fn screen_label(')[1].split('\n}\n')[0].matchAll(/^\s+((?:"[a-z_]+"(?:\s*\|\s*)?)+)\s*=>/gm)].flatMap(m => [...m[1].matchAll(/"([a-z_]+)"/g)].map(x => x[1])))

test('#1254 #1512 #1632 #1792 每一種畫面種類都有固定代號、名單說明、前端提醒文字（三處同步，不能漏登記）', () => {
  assert.ok(kinds.length >= 10, `讀得到畫面種類：${kinds}`)
  const noCode = kinds.filter(k => !codeOf[k])
  assert.deepEqual(noCode, [], '沒有 status_code 代號的種類')
  const noLabel = kinds.filter(k => !labelCodes.has(codeOf[k]))
  assert.deepEqual(noLabel, [], '名單（bridge/roster.rs screen_label）沒有說明的種類：名單上只會看到卡住卻不知道卡在哪')
  // 前端：每個代號都要有提醒（本人不在電腦前也能知道）；代號不認得就不顯示——正是「沒人知道」的來源
  const noNotice = kinds.filter(k => !noticeText({ code: codeOf[k], name: '甲' }))
  assert.deepEqual(noNotice, [], '前端 partner-notice 沒有提醒文字的種類')
  for (const k of kinds) {
    const n = noticeText({ code: codeOf[k], name: '甲' })
    assert.match(n.title + n.body, /[一-鿿]/)
    assert.doesNotMatch(n.title + n.body, /[a-z]+_[a-z_]+|HTTP/, `${codeOf[k]} 的提醒不能秀內部代號`)
  }
  // 反過來：名單的說明不能有不存在的代號（改名後舊字串殘留）
  const known = new Set(Object.values(codeOf))
  assert.deepEqual([...labelCodes].filter(c => !known.has(c)), [], 'screen_label 有已經不存在的代號')
})

test('#1512 #1254 #1632 偵測用的字串都在真實畫面樣本裡找得到（Claude Code 改字或字串打錯就會紅）', () => {
  const samples = walk(path.join(root, 'src-tauri/tests/fixtures')).filter(f => f.endsWith('.txt')).map(f => fs.readFileSync(f, 'utf8'))
  assert.ok(samples.length >= 20, `樣本數 ${samples.length}`)
  const consts = {}
  for (const m of prod.matchAll(/^(?:pub )?const ([A-Z_]+): &str = "([^"\n]+)";/gm)) consts[m[1]] = m[2]
  // 這幾個是各種畫面的辨認字：種類 ↔ 常數
  const need = { TrustFolder: ['TRUST_YES', 'TRUST_NO'], BypassWarning: ['BYPASS_YES'], Login: ['LOGIN_MENU', 'LOGIN_EXPIRED'], UsageLimit: ['USAGE_LIMIT'], UsageMenu: ['USAGE_MENU_TITLE', 'USAGE_MENU_FOOTER', 'USAGE_STOP', 'USAGE_WAIT'], HeldMessage: ['HELD_TITLE'], Question: ['QUESTION_FOOTER'] }
  const missing = []
  for (const [kind, names] of Object.entries(need)) {
    assert.ok(kinds.includes(kind), `種類 ${kind} 還在`)
    for (const n of names) {
      assert.ok(consts[n], `找得到常數 ${n}`)
      // USAGE_WAIT 在真畫面裡後面還接「at …」，所以用「包含」比對
      if (!samples.some(s => s.includes(consts[n]))) missing.push(`${kind}：${n}＝「${consts[n]}」`)
    }
  }
  assert.deepEqual(missing, [], '這些辨認字沒有任何真實（或依真實截圖轉錄）的樣本支持')
})

test('#1640 #1637 卡在首次確認畫面：終端畫面上的提示（viewHint）與提醒用同一組代號，不能有只在一處出現的', () => {
  // viewHint 是「畫面開著時」的一行提示；它認得的代號必須是 status_code 的子集，且至少涵蓋要人回答的幾種
  for (const code of ['permission', 'trust', 'bypass_warning', 'attention', 'usage_menu', 'held_message']) {
    assert.ok(viewHint([{ code, name: '甲' }], '甲'), `${code} 在終端畫面上要有提示`)
    assert.ok(Object.values(codeOf).includes(code), `${code} 是 Rust 認得的代號`)
  }
})
