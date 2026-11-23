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
  assert.equal(f('', 'abcdefghijkl'), `忘記這台設備（指紋 abcd efgh）？${TAIL}`)
  assert.equal(f('電腦（K9B2）', null), `忘記「電腦（K9B2）」？${TAIL}`, '沒名字的設備畫面上寫辨認線索，句子就寫它（#1829）')
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

test('畫面接線：「忘記」與「重新認這台」都先問；確認框預設焦點在取消', () => {
  assert.doesNotMatch(panel, /@click="act\('known-forget'/, '不能繞過確認直接忘記')
  assert.equal((panel.match(/forget\.ask\(/g) ?? []).length, 1, '只剩已移除的設備那一顆「忘記」')
  assert.equal((panel.match(/forget\.askReaccept\(/g) ?? []).length, 1, '被擋下的「重新認這台」一顆')
  assert.match(panel, /forget\.ask\(r\.peer\)">\{\{ DEVICE_TEXT\.forget \}\}</)
  assert.match(panel, /<asn-dialog v-if="forgetBox"[^>]*initial-focus="\.forget-cancel"/)
  assert.match(panel, /<asn-button class="forget-cancel"[^>]*forget\.no[^>]*>\{\{ KNOWN\.forgetCancel \}\}/)
  assert.match(panel, /forget\.yes[^>]*>\{\{ forgetBox\.yes \}\}/, '確認鈕的字跟著問的是哪一種')
  assert.equal(TEXT.forgetYes, '忘記')
  assert.equal(TEXT.forgetCancel, '取消')
})

test('「重新認這台」：確認句寫明按下去會發生什麼；確認才送 known-forget，取消不送', () => {
  const calls = [], box = { value: null }
  const c = createForgetConfirm({ box, forget: id => calls.push(['known-forget', id]) })
  c.askReaccept({ id: 'n9', label: '工作機', fingerprint: 'aaaabbbbcccc' })
  assert.equal(box.value.title, TEXT.reacceptTitle)
  assert.equal(box.value.yes, TEXT.reacceptYes)
  assert.match(box.value.text, /清掉記住的指紋/)
  assert.match(box.value.text, /下次連上來會當成第一次/)
  assert.match(box.value.text, /剛重灌或換掉/)
  assert.match(box.value.text, /沒動過它，不要按，並告訴管理的人/)
  assert.ok(box.value.text.includes('「工作機」'))
  assert.doesNotMatch(box.value.text, /aaaa|undefined|null/, '不寫指紋、不出現 undefined')
  c.no()
  assert.deepEqual(calls, [])
  c.askReaccept({ id: 'n9', label: '工作機' }); c.yes()
  assert.deepEqual(calls, [['known-forget', 'n9']], '行為同忘記：清掉釘住的指紋')
  c.askReaccept({}); assert.equal(box.value, null)
})
