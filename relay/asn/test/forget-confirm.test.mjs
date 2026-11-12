// 設定 → 設備：「忘記」先跳確認框（共用的 AsnDialog），預設焦點在「取消」
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { TEXT, createForgetConfirm } from '../ui/lib/known-peers.mjs'

const panel = fs.readFileSync(new URL('../ui/lib/settings-panel.mjs', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const TAIL = '之後這台再連上，要重新確認指紋。'

test('確認句：有名字＋指紋、缺指紋、缺名字，都不出現 undefined 或空括號', () => {
  const f = TEXT.forgetConfirm
  assert.equal(f('小乙的電腦', 'abcd efgh ijkl'), `忘記「小乙的電腦」（指紋 abcd efgh）？${TAIL}`)
  assert.equal(f('小乙的電腦', 'abcdefghijkl'), `忘記「小乙的電腦」（指紋 abcd efgh）？${TAIL}`, '指紋取畫面分組的前兩組')
  assert.equal(f('小乙的電腦', ''), `忘記「小乙的電腦」？${TAIL}`)
  assert.equal(f('', 'abcdefghijkl'), `忘記這台電腦（指紋 abcd efgh）？${TAIL}`)
  assert.equal(f('未命名的電腦', null), `忘記這台電腦？${TAIL}`)
  for (const t of [f(undefined, undefined), f(null, null), f('  ', ' ')]) assert.doesNotMatch(t, /undefined|null|（）|「」/)
})

test('取消不送 known-forget；按「忘記」才送，參數是那筆的 id', () => {
  const calls = [], box = { value: null }
  const c = createForgetConfirm({ box, forget: id => calls.push(['known-forget', id]) })
  c.ask({ id: 'n1', label: '小乙', fingerprint: 'aaaabbbbcccc' })
  assert.match(box.value.text, /小乙/)
  c.no()
  assert.equal(box.value, null)
  assert.deepEqual(calls, [], '按取消不送')
  c.yes()
  assert.deepEqual(calls, [], '沒有待確認的就不送')
  c.ask({ id: 'n1', label: '小乙', fingerprint: 'aaaabbbbcccc' })
  assert.deepEqual(calls, [], '只是問，還沒送')
  c.yes()
  assert.deepEqual(calls, [['known-forget', 'n1']])
  assert.equal(box.value, null)
  c.ask({}); assert.equal(box.value, null, '沒有 id 不開確認框')
})

test('畫面接線：兩顆「忘記」都先問；確認框預設焦點在取消', () => {
  assert.doesNotMatch(panel, /@click="act\('known-forget'/, '不能繞過確認直接忘記')
  assert.equal((panel.match(/forget\.ask\(/g) ?? []).length, 2, '詳情和舊設備紀錄兩顆')
  assert.match(panel, /forget\.ask\(p\)">忘記</)
  assert.match(panel, /<asn-dialog v-if="forgetBox"[^>]*initial-focus="\.forget-cancel"/)
  assert.match(panel, /class="aero-btn forget-cancel"[^>]*forget\.no[^>]*>\{\{ KNOWN\.forgetCancel \}\}/)
  assert.match(panel, /forget\.yes[^>]*>\{\{ KNOWN\.forgetYes \}\}/)
  assert.equal(TEXT.forgetYes, '忘記')
  assert.equal(TEXT.forgetCancel, '取消')
})
