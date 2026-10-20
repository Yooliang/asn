// 改名後的舊名收信（AsnCore 這層）與回信外殼剝除。Rust 端的改名驗證、舊名清單與寄信用新名在 cargo test（names.rs）；
// 舊名真的用 inbox&agent=<舊名> 收信與 ack，由 e2e.test.mjs 跑真的 asn.exe 驗。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AsnCore } from '../ui/lib/core.mjs'
import { emo, esc, unwrapShell } from '../ui/lib/text.mjs'
import { memStore } from './helpers.mjs'
import { U } from './fake-relay.mjs'

const mail = (n, to, body = `信${n}`) => ({ id: U(n), from_node: 'W', from_agent: 'W-政策', to_node: 'T', to_agent: to, body, created_at: '2026-10-20T08:00:00Z', expects_reply: true })

function fakeTransport(messages) {
  const acked = []
  return { acked, list: async () => ({ members: [] }), inbox: async () => ({ messages }), ack: async ids => { acked.push(...ids) }, send: async () => ({}) }
}

test('收信涵蓋舊名：寄給新名與舊名的信都進對話並 ack；別人的名字不理', async () => {
  const t = fakeTransport([mail(1, '新名'), mail(2, '舊名'), mail(3, '陌生名')])
  const core = new AsnCore({ transport: t, store: memStore(), selfNode: 'T', windowName: '新名', aliases: ['舊名'] })
  await core.pull('test')
  assert.deepEqual(t.acked.sort(), [U(1), U(2)])
  assert.deepEqual(core.logOf('W/W-政策').map(m => m.text), ['信1', '信2'])
  await core.stop()
})

test('沒有登記的舊名（過期後不再傳進來）＝不收', async () => {
  const t = fakeTransport([mail(2, '舊名')])
  const core = new AsnCore({ transport: t, store: memStore(), selfNode: 'T', windowName: '新名', aliases: [] })
  await core.pull('test')
  assert.deepEqual(t.acked, [])
  await core.stop()
})

test('寄信用新名：from_agent＝現用視窗名', async () => {
  const sent = []
  const t = { ...fakeTransport([mail(1, '新名')]), send: async p => { sent.push(p); return {} } }
  const core = new AsnCore({ transport: t, store: memStore(), selfNode: 'T', windowName: '新名', aliases: ['舊名'] })
  await core.pull('test')
  await core.send('W/W-政策', '收到')
  assert.equal(sent[0].from_agent, '新名')
  await core.stop()
})

const BODY = '真正的內容\n第二行'
test('unwrapShell：兩種斜線寫法都剝', () => {
  assert.equal(unwrapShell(`<cross-session-message from="uds:\\\\.\\pipe\\LOCAL\\cc-msg-1" from-name="家用若莉" from-mode="bypass">\n${BODY}\n</cross-session-message>`), BODY)
  assert.equal(unwrapShell(`<\\cross-session-message from="uds:\\\\.\\pipe\\x">\n${BODY}\n<\\/cross-session-message>`), BODY)
  assert.equal(unwrapShell(`<cross-session-message>${BODY}<\\/cross-session-message>`), BODY)
})
test('unwrapShell：前後空白換行都容許', () => {
  assert.equal(unwrapShell(`\n  <cross-session-message a="b">\n\n${BODY}\n\n</cross-session-message>  \n\n`), BODY)
})
test('unwrapShell：只有開頭沒有結尾（或只有結尾）不剝', () => {
  const a = `<cross-session-message a="b">\n${BODY}`
  const b = `${BODY}\n</cross-session-message>`
  assert.equal(unwrapShell(a), a)
  assert.equal(unwrapShell(b), b)
})
test('unwrapShell：內容中間出現同字串不動；只剝最外層一次', () => {
  const mid = `前面 <cross-session-message> 說明文字 </cross-session-message> 後面`
  assert.equal(unwrapShell(mid), mid)
  const nested = `<cross-session-message a="1">外 <cross-session-message b="2">內</cross-session-message> 外</cross-session-message>`
  assert.equal(unwrapShell(nested), '外 <cross-session-message b="2">內</cross-session-message> 外')
  const two = `<cross-session-message>甲</cross-session-message> 中間 <cross-session-message>乙</cross-session-message>`
  assert.equal(unwrapShell(two), two)
  assert.equal(unwrapShell('一般內文'), '一般內文')
  assert.equal(unwrapShell(null), '')
})
test('unwrapShell：剝掉後仍要經 esc 才顯示', () => {
  const raw = '<cross-session-message>\n<img src=x onerror=alert(1)> :)\n</cross-session-message>'
  const out = emo(unwrapShell(raw))
  assert.ok(!out.includes('<img'), out)
  assert.ok(out.includes('&lt;img'))
  assert.equal(esc(unwrapShell(raw)), '&lt;img src=x onerror=alert(1)&gt; :)')
})
test('收信：外殼剝掉後才進對話與提示', async () => {
  const t = fakeTransport([mail(1, '新名', '<\\cross-session-message from="x">\n晚點回你\n<\\/cross-session-message>')])
  const core = new AsnCore({ transport: t, store: memStore(), selfNode: 'T', windowName: '新名' })
  const notes = []
  core.on('notify', n => notes.push(n))
  await core.pull('test')
  assert.equal(core.logOf('W/W-政策')[0].text, '晚點回你')
  assert.equal(notes[0].line, '晚點回你')
  await core.stop()
})
