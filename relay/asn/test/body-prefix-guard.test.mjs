// 守門：舊版內文開頭 [收發室] 標記的規則，只能出現在「不要回頭通知寄件人」的三個地方
// （Rust 橋 core.rs 的 tell_sender_waiting、hold_for_self_pull，core/quota.rs 的 quota_notify_sender）。
// 不能進 is_system_notice、sender_line、不回信的判斷，也不能進 UI 的系統通知歸類。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const root = new URL('../../../', import.meta.url)
const read = rel => fs.readFileSync(new URL(rel, root), 'utf8')
const RS = 'relay/asn/src-tauri/src/'
const ID = /has_legacy_body_prefix\w*|has_legacy_notice_mark|hasLegacyBodyPrefix|LEGACY_BODY_PREFIX/g

// 標識符出現的位置所在的函式名（往前找最近的 fn 宣告）
function fnAt(src, idx, len) {
  const head = src.slice(0, idx + len)   // 含識別字的第一個字元：定義本身（fn 名＝識別字）也算在自己的函式裡
  const all = [...head.matchAll(/\bfn\s+(\w+)/g)]
  return all.length ? all[all.length - 1][1] : ''
}
function usesOf(rel) {
  const src = read(rel)
  return [...src.matchAll(ID)].map(m => ({ id: m[0], fn: fnAt(src, m.index, m[0].length) }))
}
// 某個函式的本體（到下一個 fn 宣告前）
function bodyOf(src, name) {
  const s = src.search(new RegExp(`\\bfn\\s+${name}\\b`))
  assert.ok(s >= 0, `找不到 ${name}`)
  const rest = src.slice(s + 3)
  const n = rest.search(/\n\s*(?:pub(?:\([a-z]+\))?\s+)?(?:async\s+)?fn\s/)
  const body = n < 0 ? rest : rest.slice(0, n)
  return body.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n')   // 註解行不算（下一個函式的說明會落在這段尾巴）
}

test('Rust：舊內文標記只出現在三個「不回頭通知寄件人」的函式（外加它自己的定義與測試）', () => {
  const allowed = {
    [RS + 'bridge/core.rs']: new Set(['tell_sender_waiting', 'hold_for_self_pull']),
    [RS + 'bridge/core/quota.rs']: new Set(['quota_notify_sender']),
    [RS + 'bridge/mail.rs']: new Set(['has_legacy_notice_mark']),   // 方法定義
  }
  const files = []
  const walk = d => { for (const e of fs.readdirSync(new URL(d, root), { withFileTypes: true })) { const p = d + e.name; if (e.isDirectory()) walk(p + '/'); else if (e.name.endsWith('.rs')) files.push(p) } }
  walk(RS)
  let seen = 0
  for (const f of files) {
    if (f === RS + 'bridge/notice.rs') continue   // 定義與它自己的測試
    const uses = usesOf(f)
    if (!uses.length) continue
    seen += uses.length
    const ok = allowed[f]
    assert.ok(ok, `${f} 不該用舊內文標記規則`)
    for (const u of uses) assert.ok(ok.has(u.fn), `${f}：${u.id} 出現在 ${u.fn}，不在允許的函式裡`)
  }
  assert.ok(seen >= 4, '三個通知處和方法定義都找得到（守門本身沒有失效）')
  const core = usesOf(RS + 'bridge/core.rs').map(u => u.fn)
  assert.ok(core.includes('tell_sender_waiting') && core.includes('hold_for_self_pull'))
  assert.ok(usesOf(RS + 'bridge/core/quota.rs').some(u => u.fn === 'quota_notify_sender'))
})

test('Rust：is_system_notice、sender_line 與不回信的判斷不含舊內文標記規則', () => {
  const mail = read(RS + 'bridge/mail.rs')
  const notice = read(RS + 'bridge/notice.rs')
  const core = read(RS + 'bridge/core.rs')
  for (const [src, name] of [[mail, 'is_system_notice'], [mail, 'sender_line'], [notice, 'is_system_notice'], [notice, 'is_system_notice_at'], [notice, 'is_system_notice_name'], [core, 'is_system_notice']]) {
    const b = bodyOf(src, name)
    assert.ok(b.length > 20, name)
    assert.ok(!ID.test(b) && !/收發室\]/.test(b), `${name} 不該含舊內文標記規則`)
    ID.lastIndex = 0
  }
  // 不回信的決定（Pending::new 的 no_reply）那一行不含它
  const line = core.split('\n').find(l => l.includes('let no_reply = '))
  assert.ok(line && !ID.test(line))
  ID.lastIndex = 0
})

test('Node：舊內文標記只在 system-notice.mjs 定義，橋與雲端代理沒有用', () => {
  for (const dir of ['relay/machine/', 'relay/cloud-agent/', 'relay/pi-extension/']) {
    const walk = d => { for (const e of fs.readdirSync(new URL(d, root), { withFileTypes: true })) {
      const p = d + e.name
      if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p + '/'); continue }
      if (!e.name.endsWith('.mjs') || p.includes('/test/') || p === 'relay/machine/system-notice.mjs') continue
      assert.ok(!ID.test(read(p)), `${p} 不該用舊內文標記規則`); ID.lastIndex = 0
    } }
    walk(dir)
  }
  const sn = read('relay/machine/system-notice.mjs')
  assert.ok(!ID.test(bodyOfJs(sn, 'isSystemNotice'))); ID.lastIndex = 0
})

function bodyOfJs(src, name) {
  const s = src.indexOf(`function ${name}`)
  assert.ok(s >= 0)
  const n = src.slice(s + 8).search(/\n(?:export )?(?:function|const) /)
  return n < 0 ? src.slice(s) : src.slice(s, s + 8 + n)
}

test('UI：沒有舊內文標記規則（系統通知只看 kind 與寄件名）', () => {
  const walk = d => { for (const e of fs.readdirSync(new URL(d, root), { withFileTypes: true })) {
    const p = d + e.name
    if (e.isDirectory()) { if (e.name !== 'vendor' && e.name !== 'node_modules') walk(p + '/'); continue }
    if (!/\.(mjs|js)$/.test(e.name)) continue
    assert.ok(!ID.test(read(p)), `${p} 不該用舊內文標記規則`); ID.lastIndex = 0
  } }
  walk('relay/asn/ui/')
  const n = read('relay/asn/ui/lib/notice.mjs')
  assert.ok(!/收發室\]/.test(bodyOfJs(n, 'isSystemNotice')))
})
