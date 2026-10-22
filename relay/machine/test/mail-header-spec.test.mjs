// 守門：docs/design/MAIL-HEADER.md 寫的信頭格式（供外掛逐字解析）要和橋的實際輸出字面一致。
// 兩邊（文件與程式）任何一邊改了格式、另一邊沒改，這裡就會紅。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { mailHead, mailPreamble, replyLine, senderLine } from '../mail-format.mjs'

const doc = fs.readFileSync(fileURLToPath(new URL('../../../docs/design/MAIL-HEADER.md', import.meta.url)), 'utf8').replace(/\r\n/g, '\n')
const blocks = [...doc.matchAll(/```\n([\s\S]*?)\n```/g)].map(m => m[1])
const ID = '11111111-2222-3333-4444-555555555555'
const ADDR = 'u:3cda66252c34'
const m = { id: ID, trust: 'owner', from_node: 'XISU', from_agent: ADDR, to_agent: 'T-甲', expects_reply: true, sender_display: '小良', sender_device: 'Oppo 手機' }
const fill = t => t.replaceAll('<回信位址>', ADDR).replaceAll('<信件id>', ID).replaceAll('<信件編號>', ID)

test('規格第一行範本：欄位與順序和 mailHead 一致', () => {
  const t = blocks.find(b => b.startsWith('[RELAY 來信]'))
  assert.ok(t, '文件裡找不到第一行範本')
  const want = fill(t).replace('trust=<owner|member>', 'trust=owner').replace('to=<視窗>', 'to=T-甲').replace('engine=<引擎>', 'engine=claude').replace('reply=<yes|no|?>', 'reply=yes')
  assert.equal(mailHead(m), want)
})

test('規格第三行範本：與 replyLine 字面一致（回信位址＝、信件編號＝ 後面的值不含空白、以空白或全形冒號結束）', () => {
  const t = blocks.find(b => b.startsWith('【要回信】'))
  assert.ok(t, '文件裡找不到第三行範本')
  assert.equal(replyLine(m), fill(t))
  for (const addr of [ADDR, 'H/asn']) {
    const line = replyLine({ ...m, from_node: 'H', from_agent: addr === ADDR ? ADDR : 'asn', sender_display: addr === ADDR ? '小良' : undefined })
    const a = /回信位址=(\S+?)[ ：]/.exec(line), b = /信件編號=(\S+?)[ ：]/.exec(line)
    assert.equal(a[1], addr); assert.equal(b[1], ID)
  }
})

test('規格第二行：範例表裡每一句都能由 senderLine 產生', () => {
  const owner = { ...m }
  const member = { id: ID, trust: 'member', from_node: 'H', from_agent: 'asn', sender_device: '小良的家用機', sender_engine: 'claude' }
  const expected = new Set([
    senderLine(owner), senderLine({ ...owner, sender_device: undefined }), senderLine(member),
    senderLine({ ...member, sender_engine: undefined }), senderLine({ ...member, sender_device: undefined, sender_engine: 'gemini' }),
    senderLine({ ...member, sender_device: undefined, sender_engine: undefined }),
    senderLine({ ...member, from_agent: 'Grok', sender_engine: 'cloud' }), senderLine({ ...member, from_agent: 'W-收發室' }),
  ])
  const inDoc = [...doc.matchAll(/`(寄件人：[^`]*)`/g)].map(x => x[1]).filter(x => !x.includes('<'))
  assert.ok(inDoc.length >= 8, `文件範例只有 ${inDoc.length} 句`)
  for (const s of inDoc) assert.ok(expected.has(s), `文件範例「${s}」不是 senderLine 的輸出`)
})

test('實際組出來的前三行：本人信 reply=yes 有三行、reply=no 只有兩行；不含 XISU', () => {
  const lines = (mailHead(m) + '\n' + mailPreamble(m)).split('\n')
  assert.equal(lines.length, 4)   // 三行＋結尾空字串
  assert.ok(lines[0].startsWith('[RELAY 來信]') && lines[1].startsWith('寄件人：') && lines[2].startsWith('【要回信】回信位址='))
  assert.ok(!lines.join('\n').includes('XISU'))
  const no = (mailHead({ ...m, expects_reply: false }) + '\n' + mailPreamble({ ...m, expects_reply: false })).split('\n')
  assert.equal(no.length, 3)
})
