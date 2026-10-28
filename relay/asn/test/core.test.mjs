// AsnCore 對本機假 relay 的端到端（relay-core 的 api）：收信歸屬、未讀、震動、寄信格式、離線／上線、已送出等回信。
import { nudgeBody } from '../ui/lib/text.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AsnCore } from '../ui/lib/core.mjs'
import { startFakeRelay, U } from './fake-relay.mjs'
import { modelVendorKey, vendorBadgeHtml, vendorIconSvg } from '../ui/lib/vendor-icons.mjs'
import { groupByDevice } from '../ui/lib/roster.mjs'
import { httpTransport, memStore, sleep } from './helpers.mjs'

const NAME = 'T-ASN'
const roster = (extra = []) => [
  { id: 'T', agents: [{ name: NAME, status: 'idle', cwd_label: 'asn' }, { name: 'T-收發室', status: 'idle', cwd_label: 'r' }] },
  { id: 'W', agents: [{ name: 'W-政策', status: 'idle', cwd_label: 'policy-tw' }, { name: 'W-忙', status: 'working', cwd_label: 'x' }, ...extra] },
]

async function setup({ visible = false, store = memStore(), members = roster() } = {}) {
  const relay = await startFakeRelay({ node: 'T', members })
  const state = { visible }
  const core = new AsnCore({ transport: httpTransport(relay.url, NAME), store, selfNode: 'T', windowName: NAME, isChatVisible: async () => state.visible, pollMs: 60_000, rosterMs: 60_000 })
  const notes = []
  core.on('notify', n => notes.push(n))
  return { relay, core, notes, state, store }
}

test('名單：一視窗一列、收發室與自己不列、忙碌／線上', async () => {
  const { relay, core } = await setup()
  await core.start()
  const f = core.snapshot().friends
  assert.deepEqual(f.map(x => `${x.id}:${x.status}`).sort(), ['W/W-忙:busy', 'W/W-政策:online'])
  assert.equal(core.conn, 'on')
  await core.stop(); await relay.close()
})

test('收信：對到好友進對話、對話沒開→未讀＋提示＋音效；ack 之後不重複', async () => {
  const { relay, core, notes } = await setup()
  relay.mail(1, { body: '嗨 (L)' })
  relay.mail(2, { from_agent: 'Z-陌生人', from_node: 'Z', body: '你好' })
  relay.mail(3, { to_agent: '別的視窗', body: '不是給我的' })
  await core.start()
  const w = core.snapshot().friends.find(f => f.id === 'W/W-政策')
  assert.equal(w.unread, 1)
  assert.deepEqual(core.logOf('W/W-政策').map(m => m.text), ['嗨 (L)'])
  const z = core.snapshot().friends.find(f => f.id === 'Z/Z-陌生人')
  assert.ok(z, '對不到的來信要新增一列好友')
  assert.equal(z.status, 'offline')
  assert.deepEqual(notes.map(n => [n.kind, n.toast, n.sound]), [['msg', true, 'msg'], ['msg', true, 'msg']])
  assert.equal(relay.mails.find(m => m.id === U(3)).acked, false, '不是寄給本視窗的信不能 ack')
  assert.ok(relay.mails.filter(m => m.id !== U(3)).every(m => m.acked))
  await core.pull(); assert.equal(core.logOf('W/W-政策').length, 1)
  await core.stop(); await relay.close()
})

test('收信：對話視窗開著→不加未讀、不彈提示，但仍有音效', async () => {
  const { relay, core, notes } = await setup({ visible: true })
  relay.mail(1, { body: '在嗎' })
  await core.start()
  assert.equal(core.snapshot().friends.find(f => f.id === 'W/W-政策').unread, 0)
  assert.deepEqual(notes.map(n => [n.toast, n.sound]), [[false, 'msg']])
  await core.stop(); await relay.close()
})

test('收到檔案：帶檔案的信提示標 hasFile（選「收到檔案聲音」用），純照片與純文字不標', async () => {
  const att = (n, kind) => ({ id: `00000000-0000-4000-8000-00000000000${n}`, kind, name: kind === 'file' ? 'a.pdf' : 'p.webp', mime: kind === 'file' ? 'application/pdf' : 'image/webp', bytes: 10 })
  const { relay, core, notes } = await setup()
  relay.mail(1, { body: '', attachments: [att(1, 'file')] })
  relay.mail(2, { body: '', attachments: [att(2, 'image')] })
  relay.mail(3, { body: '純文字' })
  await core.start()
  assert.deepEqual(notes.map(n => [n.kind, n.sound, Boolean(n.hasFile)]), [['msg', 'msg', true], ['msg', 'msg', false], ['msg', 'msg', false]])
  await core.stop(); await relay.close()
})

test('震動：收到 [震動] 抖視窗（開著）或未讀＋提示（沒開）；標記不顯示在對話裡', async () => {
  const a = await setup({ visible: true })
  a.relay.mail(1, { body: '[震動]' })
  await a.core.start()
  assert.deepEqual(a.notes.map(n => [n.kind, n.shake, n.toast]), [['nudge', true, false]])
  assert.ok(!a.core.logOf('W/W-政策').some(m => m.text?.includes('[震動]') && m.k === 'them'))
  assert.equal(a.core.logOf('W/W-政策')[0].nudge, true)
  await a.core.stop(); await a.relay.close()
  const b = await setup({ visible: false })
  b.relay.mail(1, { body: '[震動]' })
  await b.core.start()
  assert.deepEqual(b.notes.map(n => [n.kind, n.shake, n.toast]), [['nudge', false, true]])
  assert.equal(b.core.snapshot().friends.find(f => f.id === 'W/W-政策').unread, 1)
  await b.core.stop(); await b.relay.close()
})

test('震動（新格式）：整段內文「（某某 傳送了一個震動）」也抖視窗、標記不顯示；一般訊息提到不算', async () => {
  const a = await setup({ visible: true })
  a.relay.mail(1, { body: '（W-政策 傳送了一個震動）' })
  a.relay.mail(2, { body: '他說（W-政策 傳送了一個震動）' })
  await a.core.start()
  assert.deepEqual(a.notes.map(n => n.kind), ['nudge', 'msg'])
  const lg = a.core.logOf('W/W-政策')
  assert.equal(lg[0].nudge, true)
  assert.deepEqual(lg.filter(m => m.k === 'them').map(m => m.text), ['他說（W-政策 傳送了一個震動）'])
  await a.core.stop(); await a.relay.close()
})

test('寄信：body／to_node／to_agent／from_agent／expects_reply／reply_to 都對；回信帶 reply_to；等回信狀態', async () => {
  const { relay, core } = await setup()
  relay.mail(7, { body: '請問進度？' })
  await core.start()
  const id = 'W/W-政策'
  assert.equal((await core.send(id, '  好的，在做 :)  ')).ok, true)
  assert.deepEqual(relay.sent[0], { to_node: 'W', to_agent: 'W-政策', body: '好的，在做 :)', reply_to: U(7), from_agent: NAME, expects_reply: true, person: true })
  assert.equal(relay.reqs.at(-1).key, 'fake-machine-key')
  assert.equal(core.snapshot().friends.find(f => f.id === id).waiting, true)
  await core.send(id, '再補一句')
  assert.equal(relay.sent[1].reply_to, undefined, '沒有新的未回來信就不帶 reply_to')
  relay.mail(8, { body: '收到' })
  await core.pull()
  assert.equal(core.snapshot().friends.find(f => f.id === id).waiting, false, '收到回信就不再等')
  assert.deepEqual(core.logOf(id).map(m => m.k), ['them', 'me', 'me', 'them'])
  await core.stop(); await relay.close()
})

test('寄震動：內文「（某某 傳送了一個震動）」（測試用傳輸層照 Rust 規則組）、expects_reply:false、不帶 reply_to', async () => {
  const { relay, core } = await setup()
  await core.start()
  assert.equal((await core.nudge('W/W-政策')).ok, true)
  assert.deepEqual(relay.sent[0], { to_node: 'W', to_agent: 'W-政策', body: nudgeBody(NAME), from_agent: NAME, expects_reply: false, person: true })
  await core.stop(); await relay.close()
})

test('寄信失敗：對話出現說明、不進「已送出」', async () => {
  const { relay, core } = await setup()
  await core.start()
  relay.members = []
  const bad = await setup()
  await bad.core.start()
  await bad.relay.close()   // 後端不見了
  const r = await bad.core.send('W/W-政策', 'hi')
  assert.equal(r.ok, false)
  assert.equal(bad.core.snapshot().friends.find(f => f.id === 'W/W-政策').waiting, false)
  assert.match(bad.core.logOf('W/W-政策').at(-1).text, /沒有送到/)
  await bad.core.stop(); await core.stop(); await relay.close()
})

test('上線提示：第一次名單不提示；之後有人新上線才提示；掉線的好友變離線但保留', async () => {
  const { relay, core, notes } = await setup()
  relay.mail(1, { body: 'hi' })
  await core.start()
  notes.length = 0
  relay.members = roster([{ name: 'W-新人', status: 'idle', cwd_label: 'n' }])
  await core.refreshRoster(); await sleep(5)
  assert.deepEqual(notes.map(n => [n.kind, n.friend.id]), [['login', 'W/W-新人']])
  relay.members = [{ id: 'T', agents: [] }]
  await core.refreshRoster()
  const w = core.snapshot().friends
  assert.equal(w.find(f => f.id === 'W/W-政策').status, 'offline', '有對話的好友掉線後留著')
  assert.ok(!w.find(f => f.id === 'W/W-新人'), '沒對話的掉線就消失')
  relay.members = roster()
  notes.length = 0
  await core.refreshRoster(); await sleep(5)
  assert.ok(notes.some(n => n.kind === 'login' && n.friend.id === 'W/W-政策'))
  await core.stop(); await relay.close()
})

test('程序條目（「pi #pid」）關掉後不留在名單上，就算本機有對話記錄也一樣；對話記錄本身不刪（#447）', async () => {
  const { relay, core } = await setup()
  relay.mail(1, { from_node: 'W', from_agent: 'pi #30784', to_node: 'T', to_agent: NAME, body: '我是程序掃描出來的' })
  await core.start()
  await core.refreshRoster(); await sleep(5)
  assert.ok(!core.snapshot().friends.some(f => f.id === 'W/pi #30784'), '帶對話記錄的程序條目也不當離線好友列著')
  assert.ok(core.logOf('W/pi #30784').some(m => /程序掃描/.test(m.text ?? m.body ?? '')), '對話記錄還在')
  assert.ok(core.snapshot().friends.some(f => f.id === 'W/W-政策'), '一般夥伴照舊')
  await core.stop(); await relay.close()
})

test('存檔：重開後好友與對話還在（離線）', async () => {
  const store = memStore()
  const a = await setup({ store })
  a.relay.mail(1, { body: '存起來' })
  await a.core.start(); await a.core.stop(); await a.relay.close()
  assert.ok(store.data.logs['W/W-政策'])
  const b = await setup({ store, members: [{ id: 'T', agents: [] }] })
  await b.core.start()
  const w = b.core.snapshot().friends.find(f => f.id === 'W/W-政策')
  assert.equal(w.status, 'offline')
  assert.equal(b.core.logOf('W/W-政策')[0].text, '存起來')
  await b.core.stop(); await b.relay.close()
})

test('存檔：舊好友重開後模型與設備名還在，pi 夥伴的廠商圖示照模型換、設備不顯示未命名', async () => {
  const store = memStore()
  const members = [
    { id: 'T', agents: [{ name: NAME, status: 'idle' }] },
    { id: 'W', name: '工作機', kind: 'phone', agents: [{ name: 'W-pi', status: 'idle', engine: 'pi', model: 'anthropic/claude-sonnet-4' }] },
  ]
  const a = await setup({ store, members })
  a.relay.mail(1, { from_agent: 'W-pi', body: '存起來' })
  await a.core.start(); await a.core.stop(); await a.relay.close()
  const saved = store.data.friends.find(f => f.id === 'W/W-pi')
  assert.equal(saved.model, 'anthropic/claude-sonnet-4')
  assert.equal(saved.device, '工作機')
  assert.equal(saved.kind, 'phone')
  const b = await setup({ store, members: [{ id: 'T', agents: [] }] })   // 重開後 W 已不在名單
  await b.core.start()
  const w = b.core.snapshot().friends.find(f => f.id === 'W/W-pi')
  assert.equal(w.status, 'offline')
  assert.equal(w.model, 'anthropic/claude-sonnet-4')
  assert.equal(w.device, '工作機')
  assert.equal(w.kind, 'phone')
  assert.equal(modelVendorKey(w.model), 'claude')
  assert.equal(vendorBadgeHtml(w), vendorIconSvg('claude'), '離線的 pi 夥伴仍顯示模型廠商的圖示，不退回 pi')
  assert.equal(groupByDevice(b.core.snapshot().friends, { selfNode: 'T' }).find(g => g.key === 'W').label, '工作機')
  await b.core.stop(); await b.relay.close()
})

test('存檔：舊格式（沒有模型與設備名）照常讀，顯示照舊退回 pi 圖示與未命名設備；壞值不帶進畫面', async () => {
  const store = memStore({
    friends: [
      { id: 'W/W-pi', node: 'W', agent: 'W-pi', nick: 'W-pi', psm: '', engine: 'pi', lastAt: 1, known: true, onRoster: true },
      { id: 'X/X-壞', node: 'X', agent: 'X-壞', nick: 'X-壞', psm: '', engine: 'pi', model: { bad: 1 }, device: 42, kind: '', lastAt: 1, known: true },
    ],
    logs: { 'W/W-pi': [{ k: 'them', text: '舊信', t: 1 }] },
  })
  const { relay, core } = await setup({ store, members: [{ id: 'T', agents: [] }] })
  await core.start()
  const friends = core.snapshot().friends
  const w = friends.find(f => f.id === 'W/W-pi')
  assert.ok(w, '舊格式的好友要讀得回來')
  assert.equal(w.status, 'offline')
  assert.equal(w.model, undefined)
  assert.equal(w.device, undefined)
  assert.equal(core.logOf('W/W-pi')[0].text, '舊信')
  assert.equal(vendorBadgeHtml(w), vendorIconSvg('pi'))
  const x = friends.find(f => f.id === 'X/X-壞')
  assert.equal(x.model, undefined); assert.equal(x.device, undefined); assert.equal(x.kind, undefined)
  assert.equal(groupByDevice(friends, { selfNode: 'T' }).find(g => g.key === 'W').label, '未命名設備')
  await core.stop(); await relay.close()
})

test('寄信狀態：sent_status 更新已送達／已讀；收到 reply_to 標已回覆', async () => {
  const { relay, core } = await setup()
  await core.start()
  await core.send('W/W-政策', '你好')
  const mine = core.logOf('W/W-政策').find(m => m.k === 'me' && m.text === '你好')
  assert.ok(mine?.id, '寄信後對話要記 message id')
  const row = relay.outbox.find(m => m.id === mine.id)
  row.delivered_at = '2026-10-20T08:01:00Z'
  await core.refreshSentStatus('test')
  assert.equal(mine.deliveredAt, '2026-10-20T08:01:00Z')
  row.acked_at = '2026-10-20T08:02:00Z'
  await core.refreshSentStatus('test')
  assert.equal(mine.ackedAt, '2026-10-20T08:02:00Z')
  relay.mail(9, { body: '回你', reply_to: mine.id })
  await core.pull('test')
  assert.equal(Date.parse(mine.repliedAt), Date.parse('2026-10-20T08:00:00Z'))
  await core.stop(); await relay.close()
})

test('後端斷線：連線狀態變 off，不丟例外', async () => {
  const { relay, core } = await setup()
  await relay.close()
  await core.start()
  assert.equal(core.conn, 'off')
  await core.stop()
})

test('未指定收件人的信（橋交給本人）：對話先顯示「XX 寄來的信沒有指定收件人」，再顯示內文；一般信不加這行；震動信（含附帶文字）只顯示震動，不出現未指定收件人', async () => {
  const { relay, core } = await setup()
  relay.mail(1, { body: '沒人指定我要給誰', unaddressed: true })
  relay.mail(2, { body: '正常信' })
  relay.mail(3, { body: '[震動]\n順便說一聲', unaddressed: true })
  relay.mail(4, { body: '（W-政策 傳送了一個震動）\n別的提示字樣', unaddressed: true })
  await core.start()
  const lg = core.logOf('W/W-政策')
  assert.deepEqual(lg.slice(0, 3).map(m => `${m.k}:${m.text}`), ['sys:W-政策 寄來的信沒有指定收件人', 'them:沒人指定我要給誰', 'them:正常信'])
  const all = lg.map(m => m.text).join('|')
  assert.ok(!all.includes('→ 未指定收件人'), all)
  assert.equal(lg.filter(m => m.nudge).length, 2)
  assert.equal(lg.filter(m => m.text?.includes('沒有指定收件人')).length, 1, '震動信不加未指定收件人這行')
  await core.stop()
  await relay.close()
})

// ---- #339：一封壞信、ack 超過 100 個、連線原因 ----
import { connReason } from '../ui/lib/core.mjs'

test('連線中斷的簡短原因：逾時、憑證、後台出錯、連不上、存檔失敗各自說清楚；認不得的留空', () => {
  assert.equal(connReason(new Error('inbox 逾時')), '請求逾時')
  assert.match(connReason(new Error('inbox HTTP 401 unauthorized')), /憑證/)
  assert.match(connReason(new Error('inbox HTTP 503')), /後台/)
  assert.match(connReason(new Error('inbox 連線失敗：error sending request')), /連不上/)
  assert.match(connReason(new Error('save 逾時')), /逾時/)
  assert.equal(connReason(new Error('怪怪的')), '')
})

test('收信：一次 250 封，ack 分批、每批最多 100 個（後台一次超過 100 個整批 400）', async () => {
  const acks = []
  const msgs = Array.from({ length: 250 }, (_, i) => ({ id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, from_node: 'W', from_agent: 'W-政策', to_node: 'T', to_agent: NAME, body: `m${i}`, created_at: '2026-10-27T08:00:00Z' }))
  const transport = { list: async () => ({ members: roster() }), inbox: async () => ({ messages: msgs }), ack: async ids => { acks.push(ids.length); return { acked: ids.length } }, send: async () => ({}) }
  const core = new AsnCore({ transport, store: memStore(), selfNode: 'T', windowName: NAME, isChatVisible: async () => false, pollMs: 60_000, rosterMs: 60_000 })
  await core.pull('test')
  assert.deepEqual(acks, [100, 100, 50])
  assert.equal(core.conn, 'on')
})

test('收信：ack 失敗時連線標 off 並寫出原因；下一輪成功就恢復', async () => {
  let fail = true
  const msgs = [{ id: '00000000-0000-4000-8000-000000000001', from_node: 'W', from_agent: 'W-政策', to_node: 'T', to_agent: NAME, body: 'x', created_at: '2026-10-27T08:00:00Z' }]
  const transport = { list: async () => ({ members: roster() }), inbox: async () => ({ messages: msgs }), ack: async () => { if (fail) throw new Error('ack HTTP 503'); return {} }, send: async () => ({}) }
  const core = new AsnCore({ transport, store: memStore(), selfNode: 'T', windowName: NAME, isChatVisible: async () => false, pollMs: 60_000, rosterMs: 60_000 })
  await core.pull('test')
  assert.equal(core.conn, 'off'); assert.match(core.connWhy, /後台/)
  assert.equal(core.snapshot().connWhy, core.connWhy)
  fail = false
  await core.pull('test')
  assert.equal(core.conn, 'on'); assert.equal(core.connWhy, '')
})

test('收信：編號不是 UUID 的信不會讓整批 ack 失敗，其他信照常確認；連線原因認得「格式不對」', async () => {
  const acked = []
  const good = '00000000-0000-4000-8000-000000000001'
  const msgs = [good, 'not-a-uuid'].map((id, i) => ({ id, from_node: 'W', from_agent: 'W-政策', to_node: 'T', to_agent: NAME, body: `x${i}`, created_at: '2026-10-27T08:00:00Z' }))
  const logs = []
  const transport = { list: async () => ({ members: roster() }), inbox: async () => ({ messages: msgs }), ack: async ids => { acked.push(...ids); return {} }, send: async () => ({}) }
  const core = new AsnCore({ transport, store: memStore(), selfNode: 'T', windowName: NAME, isChatVisible: async () => false, pollMs: 60_000, rosterMs: 60_000, log: l => logs.push(l) })
  await core.pull('test')
  assert.deepEqual(acked, [good])
  assert.equal(core.conn, 'on')
  assert.ok(logs.some(l => l.includes('ack skipped 1 bad id')))
  assert.match(connReason(new Error('信件 id 格式不對')), /格式不對/)
})

// #339 收尾：Rust 代收的舊信（spooled）一次很多封時，照常進對話、算未讀、ack，但只跳一則摘要
const spoolMsgs = (n, extra = {}) => Array.from({ length: n }, (_, i) => ({ id: `00000000-0000-4000-8000-${String(900 + i).padStart(12, '0')}`, from_node: 'W', from_agent: 'W-政策', to_node: 'T', to_agent: NAME, body: `舊信${i}`, created_at: `2026-10-27T08:0${i % 10}:00Z`, spooled: true, ...extra }))
async function pullWith(msgs) {
  const acks = []
  const transport = { list: async () => ({ members: roster() }), inbox: async () => ({ messages: msgs }), ack: async ids => { acks.push(...ids); return {} }, send: async () => ({}) }
  const core = new AsnCore({ transport, store: memStore(), selfNode: 'T', windowName: NAME, isChatVisible: async () => false, pollMs: 60_000, rosterMs: 60_000 })
  const notes = []
  core.on('notify', n => notes.push(n))
  await core.pull('test')
  return { core, notes, acks }
}

test('代收舊信超過 3 封：不逐封跳提示，只跳一則「收到 N 封你不在時代收的信」；信照樣進對話、算未讀、ack', async () => {
  const { core, notes, acks } = await pullWith(spoolMsgs(5))
  assert.deepEqual(notes.map(n => n.line), ['收到 5 封你不在時代收的信'])
  assert.equal(notes[0].friend.id, 'W/W-政策')
  const f = core.snapshot().friends.find(x => x.id === 'W/W-政策')
  assert.equal(f.unread, 5)
  assert.equal(core.viewOf('W/W-政策').filter(e => e.k === 'them').length, 5)
  assert.equal(acks.length, 5)
})

test('代收舊信 3 封以內、或不是代收的信：照舊逐封提示', async () => {
  assert.equal((await pullWith(spoolMsgs(3))).notes.length, 3)
  const live = spoolMsgs(6).map(({ spooled, ...m }) => m)
  const { notes } = await pullWith(live)
  assert.equal(notes.length, 6, '一般新信不受影響')
  assert.ok(notes.every(n => !/代收/.test(n.line)))
})
