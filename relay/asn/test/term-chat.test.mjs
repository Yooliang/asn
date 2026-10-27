// #331 終端整合進對話視窗：純邏輯（名單列、輸入區、確認列狀態機、時間軸、畫面文字）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { termFriendId, isTermFriend, termIdOf, termFriends, composerView, confirmReduce, confirmBarView, IDLE, timelineAdd, timelineSet, TIMELINE_MAX, entryLabel, remoteStatusToEntry, screenText, SCREEN_LINES, SCREEN_MAX } from '../ui/lib/term-chat.mjs'
import { rowsOf } from '../ui/lib/term-panel.mjs'
import { vendorBadgeHtml } from '../ui/lib/vendor-icons.mjs'

const listed = [
  { id: '1', profile: 'grok', cwd: 'D:\\Github\\asn-term-test' },
  { id: '2', profile: 'claude', cwd: 'D:\\w\\x', adopted: true, answer_unlocked: false, send_unlocked: false },
  { id: '3', profile: 'grok', cwd: '' },
]
const rows = rowsOf(listed, { 1: { state: 'idle' }, 2: { state: 'idle' }, 3: { state: 'busy' } })
const row = id => rows.find(r => r.id === id)

test('名單列：終端掛在自己這台、id 有 term: 前綴、不跟信件夥伴混', () => {
  const f = termFriends(rows, { selfNode: 'H', device: '家用機' })
  assert.deepEqual(f.map(x => x.id), ['term:1', 'term:2', 'term:3'])
  assert.ok(f.every(x => x.node === 'H' && x.device === '家用機' && x.agent === '' && x.entryKind === 'term'))
  assert.equal(f[0].nick, 'grok・asn-term-test')
  assert.equal(f[2].nick, 'grok #3', '沒資料夾就用終端標題')
  assert.equal(f[1].termBadge, '已接手')
  assert.equal(f[2].status, 'busy')
  assert.ok(isTermFriend(f[0]) && !isTermFriend({ id: 'H/H-ASN' }))
  assert.equal(termIdOf('term:12'), '12'); assert.equal(termIdOf('H/x'), '')
  assert.equal(termFriendId('5'), 'term:5')
  assert.ok(vendorBadgeHtml(f[0]).startsWith('<svg'), 'engine＝profile，廠商小圖照常')
  const w = termFriends(rowsOf([{ id: '9', profile: 'grok', cwd: 'D:\\a' }], { 9: { state: 'waiting_user', prompt: { kind: 'trust_dialog', text: '?', options: [{ n: 1, label: 'Yes' }] } } }))
  assert.equal(w[0].status, 'busy'); assert.equal(w[0].termBadge, '等你回答')
  assert.deepEqual(termFriends(null), []); assert.deepEqual(termFriends([{ id: '' }, null]), [])
})

test('輸入區：接手未解鎖＝locked；等你回答、忙碌、沒資料夾＝blocked；其餘 ready', () => {
  assert.deepEqual(composerView(row('2')), { mode: 'locked', reason: '這個視窗還沒允許 ASN 代送文字', unlock: 'send' })
  assert.equal(composerView(row('3')).mode, 'blocked')
  assert.match(composerView(row('3')).reason, /忙碌/)
  assert.equal(composerView({ ...row('1'), state: 'waiting_user' }).mode, 'blocked')
  assert.equal(composerView({ ...row('1'), cwd: '' }).mode, 'blocked')
  assert.equal(composerView(null).mode, 'blocked')
  assert.equal(composerView(row('1')).mode, 'ready')
  assert.equal(composerView({ ...row('2'), sendUnlocked: true }).mode, 'ready', '解鎖後可送')
})

const run = (acts, r = row('1')) => acts.reduce((acc, a) => { const o = confirmReduce(acc.state, a, r); return { state: o.state, effects: [...acc.effects, ...o.effects] } }, { state: IDLE, effects: [] })

test('確認列：按送出只跳確認列，不送也不傳手機', () => {
  const o = run([{ type: 'ask', text: 'hi', enter: true }])
  assert.equal(o.state.phase, 'confirm'); assert.deepEqual(o.effects, [])
})

test('確認列：只有「確認送出」產生 send；請求內容就是確認列上的字', () => {
  const o = run([{ type: 'ask', text: 'hi', enter: false }, { type: 'confirm' }])
  assert.deepEqual(o.effects, [{ type: 'send', req: { id: '1', text: 'hi', enter: false } }])
  assert.equal(o.state.phase, 'sending')
  assert.equal(run([{ type: 'ask', text: 'hi' }, { type: 'confirm' }, { type: 'confirm' }]).effects.filter(e => e.type === 'send').length, 1, '送出中再按不會重送')
})

test('確認列：按「改用手機確認」才產生 offer；之後取消、改字、離開都撤回', () => {
  const o = run([{ type: 'ask', text: 'hi' }, { type: 'phone' }])
  assert.deepEqual(o.effects, [{ type: 'offer', req: { id: '1', text: 'hi', enter: true } }])
  assert.equal(o.state.phase, 'phone')
  for (const t of ['cancel', 'edit', 'leave']) {
    const x = run([{ type: 'ask', text: 'hi' }, { type: 'phone' }, { type: t }])
    assert.deepEqual(x.effects.at(-1), { type: 'withdraw', id: '1' }, t)
    assert.equal(x.state.phase, 'idle', t)
  }
  assert.deepEqual(run([{ type: 'ask', text: 'hi' }, { type: 'cancel' }]).effects, [], '沒傳手機就不必撤回')
})

test('確認列：手機請求還在時電腦按確認送出，只送一次（後端會作廢手機那筆）', () => {
  const o = run([{ type: 'ask', text: 'hi' }, { type: 'phone' }, { type: 'confirm' }])
  assert.deepEqual(o.effects.map(e => e.type), ['offer', 'send'])
})

test('確認列：終端狀態變了就不送，有手機請求一併撤回', () => {
  const s1 = confirmReduce(IDLE, { type: 'ask', text: 'hi' }, row('1')).state
  const s2 = confirmReduce(s1, { type: 'phone' }, row('1')).state
  const o = confirmReduce(s2, { type: 'confirm' }, { ...row('1'), state: 'busy' })
  assert.deepEqual(o.effects, [{ type: 'withdraw', id: '1' }])
  assert.equal(o.state.phase, 'idle'); assert.match(o.state.error, /忙碌/)
  assert.deepEqual(confirmReduce(s1, { type: 'confirm' }, row('3')).effects, [], '換成別的終端的列不送')
})

test('確認列：不能送的情況直接擋，連確認列都不出現', () => {
  for (const [r, why] of [[row('2'), '未解鎖'], [row('3'), '忙碌'], [null, '沒有終端']]) {
    const o = confirmReduce(IDLE, { type: 'ask', text: 'hi' }, r)
    assert.equal(o.state.phase, 'idle', why); assert.ok(o.state.error, why); assert.deepEqual(o.effects, [], why)
  }
  assert.equal(confirmReduce(IDLE, { type: 'ask', text: '   ' }, row('1')).state.phase, 'idle', '空白不送')
  assert.equal(confirmReduce(IDLE, { type: 'ask', text: 'x'.repeat(2001) }, row('1')).state.phase, 'idle', '太長不送')
})

test('確認列：done／failed 回到 idle；不認得的動作不變', () => {
  const s = run([{ type: 'ask', text: 'hi' }, { type: 'confirm' }]).state
  assert.equal(confirmReduce(s, { type: 'done' }).state.phase, 'idle')
  assert.equal(confirmReduce(s, { type: 'failed', error: '手機已拒絕' }).state.error, '手機已拒絕')
  assert.equal(confirmReduce(s, { type: 'nope' }).state, s)
  assert.equal(confirmReduce(undefined, { type: 'cancel' }).state.phase, 'idle')
})

test('確認列畫面：預覽截 60 字、等手機時有說明；idle 時沒有確認列', () => {
  const long = 'a'.repeat(70)
  const s = confirmReduce(IDLE, { type: 'ask', text: long }, row('1')).state
  const v = confirmBarView(s, row('1'))
  assert.equal(v.preview, `${'a'.repeat(60)}…`); assert.equal(v.waitingPhone, false)
  assert.match(v.target, /asn-term-test/)
  const p = confirmBarView(confirmReduce(s, { type: 'phone' }, row('1')).state, row('1'))
  assert.equal(p.waitingPhone, true); assert.match(p.phoneNote, /2 分鐘/)
  assert.equal(confirmBarView(IDLE, row('1')), null)
  assert.equal(confirmBarView(s, row('3')), null, '別的終端不顯示')
})

test('時間軸：加、改狀態、同 key 不重複、超過上限丟最舊的', () => {
  let t = timelineAdd([], { key: 'a', at: 1, text: 'hi', status: 'confirm' })
  t = timelineAdd(t, { key: 'a', at: 2, text: 'dup', status: 'sent' })
  assert.equal(t.length, 1)
  t = timelineSet(t, 'a', 'sent')
  assert.equal(t[0].status, 'sent'); assert.equal(entryLabel(t[0].status), '已送出')
  assert.equal(timelineSet(t, 'zz', 'sent'), t)
  assert.equal(timelineSet(t, 'a', 'weird')[0].status, 'failed', '不認得的狀態當沒送出')
  for (let i = 0; i < TIMELINE_MAX + 5; i++) t = timelineAdd(t, { key: `k${i}`, at: i, text: String(i), status: 'sent' })
  assert.equal(t.length, TIMELINE_MAX); assert.equal(t.at(-1).key, `k${TIMELINE_MAX + 4}`)
  assert.equal(timelineAdd([], { key: '', text: 'x', status: 'sent' }).length, 0)
})

test('後台請求狀態 → 時間軸：migration 的八種都有對應，其他當沒送出', () => {
  assert.deepEqual(['pending', 'approved', 'taken', 'done', 'denied', 'cancelled', 'expired', 'failed'].map(remoteStatusToEntry), ['phone', 'sending', 'sending', 'sent', 'rejected', 'withdrawn', 'expired', 'failed'])
  assert.equal(remoteStatusToEntry('toString'), 'failed')
  assert.equal(remoteStatusToEntry(undefined), 'failed')
})

test('畫面文字：去掉 ANSI 與控制字元、只留最後幾行、限字數', () => {
  assert.equal(screenText('\u001b[31mred\u001b[0m\r\nok\u0007\u0000'), 'red\nok')
  assert.equal(screenText('\u001b]0;title\u0007hi'), 'hi', 'OSC 標題拿掉')
  assert.equal(screenText('a\n\n\n'), 'a', '結尾空行拿掉')
  const many = Array.from({ length: SCREEN_LINES + 10 }, (_, i) => `L${i}`).join('\n')
  assert.equal(screenText(many).split('\n')[0], 'L10')
  assert.equal(screenText('x'.repeat(SCREEN_MAX + 50)).length, SCREEN_MAX)
  assert.equal(screenText('<img src=x onerror=alert(1)>'), '<img src=x onerror=alert(1)>', '原樣交給 {{ }} 跳脫，這裡不轉 HTML')
  assert.equal(screenText(null), '')
})
