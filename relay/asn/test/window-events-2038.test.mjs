// #2038 PR-7：視窗之間的 JS 事件（asn:state／log／room／avatars／older／attach-done／panel／settings／call／cmd／set）改走事件中心
// 重點：事件一定要登進事件表才會向橋註冊（沒登記＝實機一個事件都收不到，但只測 hub.emit 的單元測試照綠）
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createWindowHub } from '../ui/lib/event-hub.mjs'
import { HUB_MIGRATED, RUST_EVENTS, isJsEvent, jsEventNames } from '../ui/lib/rust-events.mjs'
import { HUB_NOT_READY_CODE } from '../ui/lib/rust-bridge.mjs'
import { applyFpShow } from '../ui/lib/fp-show.mjs'

const UI = fileURLToPath(new URL('../ui/', import.meta.url))
const read = f => fs.readFileSync(path.join(UI, f), 'utf8')
const tick = (n = 5) => new Promise(r => { let i = 0; const go = () => (++i >= n ? r() : setImmediate(go)); go() })

// 假的 Tauri 事件匯流排：emit 投遞給「所有視窗、包括送的那一個」（模擬 T.event.emit）；
// gated 視窗的 listen 要 release 之後才算註冊完（沒註冊完之前送來的事件就掉了，跟真的一樣）
function mkBus() {
  const wins = []
  const mkWin = ({ gated = false } = {}) => {
    const w = { regs: [], gates: [], offs: 0 }
    w.listen = (evt, fn) => {
      const r = { evt, fn, live: !gated }
      w.regs.push(r)
      const off = () => { r.live = false; w.offs++ }
      return gated ? new Promise(res => w.gates.push(() => { r.live = true; res(off) })) : Promise.resolve(off)
    }
    w.release = async () => { for (const g of w.gates.splice(0)) g(); await tick() }
    w.emit = (evt, p) => { for (const x of wins) for (const r of x.regs) if (r.evt === evt && r.live) r.fn(p); return Promise.resolve() }
    w.hub = createWindowHub({ listen: w.listen, emit: w.emit })
    wins.push(w)
    return w
  }
  return { mkWin, disposeAll: () => wins.forEach(w => w.hub.dispose()) }
}

// ---------- 事件表 ----------
test('事件表：JS 事件每一種都在已搬清單（asn:skin 例外：classic script 不經 hub）', () => {
  const js = jsEventNames()
  assert.equal(js.length, 12, '先有正向：表上有 12 種 JS 事件，下面的迴圈才不是空集合')
  for (const n of js) {
    if (n === 'asn:skin') { assert.ok(!HUB_MIGRATED.includes(n), 'asn:skin 沒有 hub 訂閱者'); assert.equal(RUST_EVENTS[n].exception, 'skin-boot'); continue }
    assert.ok(HUB_MIGRATED.includes(n), `${n} 要登記在 HUB_MIGRATED`)
  }
  assert.ok(HUB_MIGRATED.includes('asn:fpshow') && !isJsEvent('asn:fpshow'), 'asn:fpshow 是 Rust 送的，只進已搬清單，不標 JS')
})

test('每個 JS 事件名 subscribe 之後，底層 listen 真的被呼叫、各 1 次（事件名從事件表取；沒登記就不通）', async t => {
  const bus = mkBus(); t.after(bus.disposeAll)
  const w = bus.mkWin()
  const names = jsEventNames()
  assert.ok(names.length > 0)
  for (const n of names) w.hub.subscribe(n, () => {})
  await w.hub.ready()
  assert.deepEqual(w.regs.map(r => r.evt).sort(), [...names].sort(), '每個 JS 事件名都向橋註冊，且不重複')
})

test('對照：沒登記進表的事件名 subscribe 不會向橋註冊（證明上一條測得出「忘了登記」）', async t => {
  const bus = mkBus(); t.after(bus.disposeAll)
  const w = bus.mkWin()
  w.hub.subscribe('asn:not-in-table', () => {})
  await w.hub.ready()
  assert.equal(w.regs.length, 0)
})

// 表上的每個 JS 事件，ui/ 底下（排除 vendor）都要真的有送出端或接收端；表上留死名字就紅
const uiFiles = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => (e.name === 'vendor' ? [] : e.isDirectory() ? uiFiles(path.join(dir, e.name)) : /\.(m?js)$/.test(e.name) && e.name !== 'rust-events.mjs' ? [path.join(dir, e.name)] : []))
const usesOf = (name, files) => files.filter(f => new RegExp(`\\b(?:emit|subscribe|on|listen)\\(\\s*'${name}'`).test(fs.readFileSync(f, 'utf8')))

test('事件表上的每個 JS 事件，ui/ 裡都有送出端或接收端（表不放死名字）', () => {
  const files = uiFiles(UI)
  assert.ok(files.length > 20, '掃描有抓到檔案')
  const dead = jsEventNames().filter(n => usesOf(n, files).length === 0)
  assert.deepEqual(dead, [])
  assert.equal(usesOf('asn:no-such-event', files).length, 0, '對照：不存在的名字掃不到')
  assert.ok(usesOf('asn:cmd', files).length >= 3, '掃描規則抓得到 chat／panel／list')
})

// ---------- 兩扇視窗（假匯流排）----------
test('hello 握手：接收處沒註冊完就送，回的快照會掉；等 readyFor 再送，一定收得到', async t => {
  const bus = mkBus(); t.after(bus.disposeAll)
  const list = bus.mkWin(), chat = bus.mkWin({ gated: true })
  const helloSeen = []
  // 名單視窗：收到 hello 就把狀態廣播出去（送給所有視窗，包括自己）
  list.hub.on('asn:cmd', c => { if (c.op === 'hello') { helloSeen.push(c.id); list.emit('asn:state', { friends: [{ id: c.id }] }) } })
  await list.hub.ready()
  const got = []
  chat.hub.subscribe('asn:state', s => got.push(s))
  // 對照（舊作法：不等註冊就送）：回的快照掉了
  chat.emit('asn:cmd', { op: 'hello', id: 'f1' })
  await tick()
  assert.equal(helloSeen.length, 1)
  assert.equal(got.length, 0, '對照：接收處還沒註冊完，快照掉了')
  // 新作法：readyFor 之後才送
  let sent = 0
  const p = (async () => { await chat.hub.readyFor(['asn:state']); sent++; chat.emit('asn:cmd', { op: 'hello', id: 'f2' }) })()
  await tick()
  assert.equal(sent, 0, 'readyFor 還沒完成，不能送')
  await chat.release(); await p
  assert.equal(sent, 1)
  assert.equal(helloSeen.length, 2)
  assert.deepEqual(got, [{ friends: [{ id: 'f2' }] }], '註冊完才送，回的快照收得到')
})

test('readyFor 掛不起來：丟 hub-not-ready 且訊息帶事件名（chat／panel 記一行 warn、照送）', async t => {
  const bus = mkBus(); t.after(bus.disposeAll)
  const hub = createWindowHub({ listen: () => Promise.reject(new Error('no tauri')), log: () => {}, warn: () => {} })
  t.after(() => hub.dispose())
  hub.subscribe('asn:older', () => {})
  await assert.rejects(() => hub.readyFor(['asn:older']), e => e.code === HUB_NOT_READY_CODE && e.message.includes('asn:older'))
})

test('一次性訂閱（older／attach-done）：別人的 id／token 不退訂，自己的回報才退訂；退訂後底層 listener 也取消', async t => {
  const bus = mkBus(); t.after(bus.disposeAll)
  const list = bus.mkWin(), chat = bus.mkWin()
  const got = []
  const off = chat.hub.subscribe('asn:attach-done', r => { if (r?.token === 'mine') { got.push(r); off() } })
  await chat.hub.ready()
  assert.equal(chat.hub.subscriberCount('asn:attach-done'), 1)
  await list.emit('asn:attach-done', { id: 'f', token: 'other', ok: true })
  assert.equal(got.length, 0, '別人的 token 不結束')
  assert.equal(chat.hub.subscriberCount('asn:attach-done'), 1, '正向：還訂著')
  await list.emit('asn:attach-done', { id: 'f', token: 'mine', ok: true })
  assert.equal(got.length, 1)
  assert.equal(chat.hub.subscriberCount('asn:attach-done'), 0)
  assert.equal(chat.offs, 1, '底層 listener 取消 1 次')
})

test('行為變好：listen 還沒回來就退訂（逾時或很快收到），回來後底層 listener 照樣被取消，不殘留', async t => {
  const bus = mkBus(); t.after(bus.disposeAll)
  const chat = bus.mkWin({ gated: true })
  const off = chat.hub.subscribe('asn:older', () => {})
  off()   // 舊寫法此時 un 還是 null，listener 回來後沒人退訂
  assert.equal(chat.hub.subscriberCount('asn:older'), 0)
  await chat.release()
  assert.equal(chat.regs.length, 1, '正向：有註冊過')
  assert.equal(chat.regs[0].live, false, '回來後被取消')
  assert.equal(chat.offs, 1)
})

test('兩個 loadOlder 同時進行：只有 id 符合的那個結束', async t => {
  const bus = mkBus(); t.after(bus.disposeAll)
  const list = bus.mkWin(), chat = bus.mkWin()
  const done = []
  for (const fid of ['a', 'b']) { const off = chat.hub.subscribe('asn:older', r => { if (r?.id === fid) { done.push(fid); off() } }) }
  await chat.hub.ready()
  assert.equal(chat.regs.length, 1, '兩個訂閱共用 1 個底層 listener')
  await list.emit('asn:older', { id: 'b', more: false, added: 0 })
  assert.deepEqual(done, ['b'])
  assert.equal(chat.hub.subscriberCount('asn:older'), 1, 'a 還在等（正向）')
  await list.emit('asn:older', { id: 'a', more: true, added: 3 })
  assert.deepEqual(done, ['b', 'a'])
  assert.equal(chat.hub.subscriberCount('asn:older'), 0)
})

test('名單視窗的兩個 asn:cmd 訂閱者：同一個 payload 物件、順序＝訂閱順序、底層 listener 只有 1 個；asn:set 自己送自己收', async t => {
  const bus = mkBus(); t.after(bus.disposeAll)
  const list = bus.mkWin(), chat = bus.mkWin()
  const seen = []
  list.hub.on('asn:cmd', c => seen.push(['main', c]))
  list.hub.on('asn:cmd', c => seen.push(['panel', c]))
  const sets = []
  list.hub.on('asn:set', c => sets.push(c))
  await list.hub.ready()
  assert.equal(list.regs.filter(r => r.evt === 'asn:cmd').length, 1)
  const cmd = { op: 'panel-hello', kind: 'guide' }
  await chat.emit('asn:cmd', cmd)
  assert.deepEqual(seen.map(x => x[0]), ['main', 'panel'])
  assert.ok(seen.every(x => x[1] === cmd), '同一個物件')
  await list.emit('asn:set', { op: 'x', value: 1 })   // --shot：自己送、自己收
  assert.deepEqual(sets, [{ op: 'x', value: 1 }])
})

test('asn:fpshow（Rust 對那扇視窗送的）：hub 收得到並交給 applyFpShow；id 不是字串、until 不是有限數各自不動，換編號時 busy 復位', async t => {
  const bus = mkBus(); t.after(bus.disposeAll)
  const w = bus.mkWin()
  const fps = { id: 'old', until: 100, busy: true }
  w.hub.subscribe('asn:fpshow', p => applyFpShow(fps, p))
  await w.hub.ready()
  w.regs.find(r => r.evt === 'asn:fpshow').fn({ id: 'new', until: 999 })
  assert.deepEqual(fps, { id: 'new', until: 999, busy: false })
  fps.busy = true
  applyFpShow(fps, { id: 5, until: 'x' })
  assert.deepEqual(fps, { id: 'new', until: 999, busy: true }, '壞資料不動')
  applyFpShow(fps, null)
  applyFpShow(fps, { until: Infinity })
  assert.deepEqual(fps, { id: 'new', until: 999, busy: true })
  applyFpShow(fps, { until: 5 })
  assert.equal(fps.until, 5); assert.equal(fps.busy, true, '只換到期時間不動 busy')
})

// ---------- 接線（讀原始碼）----------
test('接線：chat／panel／list／m 都不再 import listen', () => {
  for (const f of ['chat.js', 'panel.js', 'list.js', 'm.js']) {
    const src = read(f)
    assert.ok(/from '\.\/lib\/tauri\.mjs'/.test(src), `${f} 有 import tauri.mjs（正向）`)
    assert.ok(!/import \{[^}]*\blisten\b[^}]*\} from '\.\/lib\/tauri\.mjs'/.test(src), `${f} 不該再 import listen`)
    assert.ok(!/(?<![.\w])listen\(/.test(src), `${f} 不該再直接 listen(`)
  }
})

test('接線：chat.js 只有 1 座 createWindowHub、panel.js 恰好 1 座；initFrame 都還在', () => {
  assert.equal((read('chat.js').match(/createWindowHub\(\)/g) ?? []).length, 1)
  assert.equal((read('panel.js').match(/createWindowHub\(\)/g) ?? []).length, 1)
  for (const f of ['chat.js', 'panel.js', 'list.js']) assert.match(read(f), /await initFrame\(\)/, f)
})

test('接線：chat 的四個接收處、older、attach-done 都掛在 eventHub；panel 的五個接收處掛在 eventHub；list 掛在 core.hub', () => {
  const chat = read('chat.js'), panel = read('panel.js'), list = read('list.js')
  for (const n of ['asn:avatars', 'asn:state', 'asn:log', 'asn:room', 'asn:older', 'asn:attach-done']) assert.ok(chat.includes(`eventHub.subscribe('${n}'`), `chat.js ${n}`)
  for (const n of ['asn:panel', 'asn:settings', 'asn:state', 'asn:avatars', 'asn:fpshow']) assert.ok(panel.includes(`eventHub.subscribe('${n}'`), `panel.js ${n}`)
  assert.ok(list.includes("core.hub.on('asn:call'") && list.includes("core.hub.on('asn:set'"))
  assert.equal((list.match(/core\.hub\.on\('asn:cmd'/g) ?? []).length, 2, 'list 的 asn:cmd 兩個接收處')
  assert.ok(!/(?<![.\w])hub\.on\('asn:/.test(list), 'list 不能寫成群組的 hub.on')
})

test('接線：hello／panel-hello／older／attach 都先 readyFor 才 emit；失敗用 console.warn 記一行帶事件名', () => {
  const chat = read('chat.js'), panel = read('panel.js')
  const before = (src, a, b, why) => { const i = src.indexOf(a), j = src.indexOf(b); assert.ok(i >= 0 && j >= 0, `${why}：找不到 ${i} ${j}`); assert.ok(i < j, why) }
  before(chat, "readyFor(['asn:avatars', 'asn:state', 'asn:log', 'asn:room'])", "emit('asn:cmd', { op: 'hello', id })", 'chat hello')
  before(chat, "readyFor(['asn:older'])", "emit('asn:cmd', { op: 'older'", 'older')
  before(chat, "readyFor(['asn:attach-done'])", "emit('asn:cmd', { op: 'attach'", 'attach')
  before(panel, "readyFor(['asn:panel', 'asn:settings', 'asn:state', 'asn:avatars'])", "emit('asn:cmd', { op: 'panel-hello', kind })", 'panel-hello')
  assert.ok(chat.includes('console.warn(`[ASN] 事件 asn:older 沒掛好'))
  assert.ok(chat.includes('console.warn(`[ASN] 事件 asn:attach-done 沒掛好'))
  const list = read('list.js')
  before(list, "core.hub.on('asn:cmd', async c =>", 'await core.hub.ready()   // 這個接收處註冊完', 'list 的 asn:cmd 註冊完才往下')
})

test('接線：older／attach-done 的退訂在 done／finish 裡同步 off()（不再有 un 變數）', () => {
  const chat = read('chat.js')
  assert.ok(/const done = r => \{[^}]*\boff\(\)/.test(chat), 'older 的 done 會 off()')
  assert.ok(/const finish = r => \{[^}]*\boff\(\)/.test(chat), 'attach 的 finish 會 off()')
  assert.ok(!/\bun\b\s*=|if \(un\)/.test(chat), '舊的 un 變數整段刪掉')
})
