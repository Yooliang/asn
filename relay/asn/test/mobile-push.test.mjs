// 手機推播的前端流程（lib/mobile-push.mjs，#797 PR③）：外殼、註冊、計時都用假的。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createPushSync, isPushToken, pushSettingView, PUSH_MAX_RETRY, PUSH_RETRY_MS, PUSH_SYNC_MIN_MS, PUSH_TEXT } from '../ui/lib/mobile-push.mjs'
import { androidBridge } from '../ui/lib/mobile.mjs'

const TOK = 'f'.repeat(40) + ':APA91b_tok-1'

function setup({ state = 'granted', registerImpl = async () => {}, on = { v: true } } = {}) {
  let t = 1_000_000, seq = 0
  const timers = new Map()
  const calls = { ask: 0, request: 0, del: 0, register: [], unregister: 0 }
  const logs = []
  let handler = null, changes = 0
  const native = {
    state: () => state,
    askPermission: () => { calls.ask++ },
    requestToken: () => { calls.request++ },
    deleteToken: () => { calls.del++ },
    onEvent: fn => { handler = fn; return () => { handler = null } },
  }
  const p = createPushSync({
    native, register: async tok => { calls.register.push(tok); return registerImpl(tok) }, unregister: async () => { calls.unregister++ },
    enabled: () => on.v, onChange: () => { changes++ },
    now: () => t, setTimer: (f, ms) => { const id = ++seq; timers.set(id, { f, at: t + ms }); return id }, clearTimer: id => timers.delete(id), log: m => logs.push(m),
  }).start()
  return {
    p, calls, logs, on, changes: () => changes, emit: e => handler?.(e),
    advance(ms) { t += ms; for (const [id, x] of [...timers]) if (x.at <= t) { timers.delete(id); x.f() } },
    setState: s => { state = s }, timers, tick: () => new Promise(r => setImmediate(r)),
  }
}

test('權杖格式：和後台、Rust 一樣只看長度與字元集', () => {
  assert.ok(isPushToken(TOK))
  for (const bad of [undefined, null, 5, '', '短', 'x'.repeat(31), 'x'.repeat(1025), 'a'.repeat(40) + ' b', 'a'.repeat(40) + '"', 'a'.repeat(40) + '\n']) assert.equal(isPushToken(bad), false, String(bad))
})

test('已給權限：取權杖，收到權杖就註冊；權杖不進 log', async () => {
  const s = setup()
  s.p.sync()
  assert.deepEqual([s.calls.ask, s.calls.request], [0, 1])
  s.emit({ t: 'token', token: TOK }); await s.tick()
  assert.deepEqual(s.calls.register, [TOK])
  assert.ok(s.logs.length > 0 && s.logs.every(l => !l.includes(TOK)), s.logs.join('|'))
})

test('沒問過權限：只問一次（外殼記下），給了之後才取權杖；被拒什麼都不做；沒有 Firebase 什麼都不做', async () => {
  const s = setup({ state: 'ask' })
  s.p.sync()
  assert.deepEqual([s.calls.ask, s.calls.request], [1, 0])
  s.emit({ t: 'perm', granted: false }); await s.tick()
  assert.equal(s.calls.request, 0, '被拒不取權杖')
  s.setState('granted'); s.emit({ t: 'perm', granted: true })
  assert.equal(s.calls.request, 1, '給了就取（不看間隔）')
  for (const st of ['denied', 'unavailable']) {
    const x = setup({ state: st }); x.p.sync(); x.advance(PUSH_SYNC_MIN_MS * 2); x.p.sync()
    assert.deepEqual([x.calls.ask, x.calls.request], [0, 0], st)
  }
})

test('同步有間隔：回到前景很頻繁不重複取；權杖換新（refresh）馬上重取', () => {
  const s = setup()
  s.p.sync(); s.p.sync(); s.p.sync()
  assert.equal(s.calls.request, 1)
  s.advance(PUSH_SYNC_MIN_MS + 1); s.p.sync()
  assert.equal(s.calls.request, 2)
  s.emit({ t: 'refresh' })
  assert.equal(s.calls.request, 3)
})

test('第一次在線回報還沒成功（not_ready）：隔一會兒重取權杖重試，最多幾次；其他錯誤不重試', async () => {
  const s = setup({ registerImpl: async () => { throw 'not_ready' } })
  s.p.sync(); s.emit({ t: 'token', token: TOK }); await s.tick()
  assert.equal(s.timers.size, 1)
  for (let i = 0; i < PUSH_MAX_RETRY + 3; i++) { s.advance(PUSH_RETRY_MS); s.emit({ t: 'token', token: TOK }); await s.tick() }
  assert.equal(s.calls.request, 1 + PUSH_MAX_RETRY, '重試有上限')
  const o = setup({ registerImpl: async () => { throw 'push_register_failed' } })
  o.p.sync(); o.emit({ t: 'token', token: TOK }); await o.tick()
  assert.equal(o.timers.size, 0, '不是 not_ready 就不重試')
  const ok = setup({ registerImpl: async () => { throw new Error('not_ready') } })
  ok.p.sync(); ok.emit({ t: 'token', token: TOK }); await ok.tick()
  assert.equal(ok.timers.size, 1, 'Error 物件也認得')
})

test('收到格式不對的權杖：不送；取權杖失敗：稍後重試', async () => {
  const s = setup()
  s.p.sync(); s.emit({ t: 'token', token: 'bad"token' }); s.emit({ t: 'token' }); await s.tick()
  assert.deepEqual(s.calls.register, [])
  s.emit({ t: 'token-error' }); assert.equal(s.timers.size, 1)
})

test('登出：先取消後台的，再刪 Firebase 的權杖；取消失敗也照樣刪；之後不再重試', async () => {
  const s = setup({ registerImpl: async () => { throw 'not_ready' } })
  s.p.sync(); s.emit({ t: 'token', token: TOK }); await s.tick()
  await s.p.logout()
  assert.deepEqual([s.calls.unregister, s.calls.del, s.timers.size], [1, 1, 0])
  const f = createPushSync({ native: { state: () => 'granted', askPermission() {}, requestToken() {}, deleteToken() { f.deleted = true }, onEvent: () => () => {} }, register: async () => {}, unregister: async () => { throw new Error('offline') } })
  await f.logout()
  assert.equal(f.deleted, true)
})

test('外殼橋：push 只在外殼有這些方法時才有；state 認不得的值一律當 unavailable', () => {
  const win = { AsnAndroid: { vibrate() {} } }
  assert.equal(androidBridge(win).push, null, '舊外殼沒有推播方法')
  win.AsnAndroid.pushState = () => 'weird'
  const b = androidBridge(win).push
  assert.equal(b.state(), 'unavailable')
  win.AsnAndroid.pushState = () => 'ask'; assert.equal(b.state(), 'ask')
  const seen = []; const off = b.onEvent(e => seen.push(e))
  win.__asnPushEvent('{"t":"refresh"}'); win.__asnPushEvent('不是 JSON')
  assert.deepEqual(seen, [{ t: 'refresh' }])
  off(); assert.equal(win.__asnPushEvent, null)
})

test('設定頁那一列：沒有 Firebase 不顯示；問過被拒時打勾仍留著並說明怎麼打開；文字是白話', () => {
  assert.equal(pushSettingView('unavailable', true).show, false)
  assert.equal(pushSettingView('weird', true).show, false)
  const g = pushSettingView('granted', true)
  assert.deepEqual([g.show, g.checked, g.denied], [true, true, ''])
  assert.deepEqual([pushSettingView('ask', true).show, pushSettingView('ask', true).denied], [true, ''], '還沒問過：勾著就是第一次會問')
  assert.equal(pushSettingView('denied', true).denied, PUSH_TEXT.denied)
  assert.equal(pushSettingView('denied', false).denied, '', '自己關掉就不用再提醒權限')
  assert.equal(pushSettingView('granted', false).checked, false)
  assert.ok(PUSH_TEXT.note.includes('只告訴你「有新訊息」') && PUSH_TEXT.note.includes('要打開 App 才看得到'), '不洩漏內容的說明')
  assert.ok(PUSH_TEXT.denied.includes('「設定」→「應用程式」→「ASN」→「通知」'))
  for (const t of Object.values(PUSH_TEXT)) assert.doesNotMatch(t.replace(/App|ASN/g, ''), /[A-Za-z]{3,}/, '給人看的文字不要中英夾雜：' + t)
})

test('使用者關掉：不取權杖、不註冊、外殼推什麼進來都不理；關的當下先取消後台再刪權杖；再打開才同步（沒問過就在這時問）', async () => {
  const on = { v: false }
  const s = setup({ on, state: 'ask' })
  s.p.sync(); s.emit({ t: 'perm', granted: true }); s.emit({ t: 'token', token: TOK }); s.emit({ t: 'refresh' }); await s.tick()
  assert.deepEqual([s.calls.ask, s.calls.request, s.calls.register.length], [0, 0, 0])
  on.v = true
  s.p.enable()
  assert.equal(s.calls.ask, 1, '打開時才問權限')
  s.setState('granted'); s.emit({ t: 'perm', granted: true }); s.emit({ t: 'token', token: TOK }); await s.tick()
  assert.deepEqual(s.calls.register, [TOK])
  on.v = false
  await s.p.disable()
  assert.deepEqual([s.calls.unregister, s.calls.del], [1, 1])
  assert.ok(s.changes() >= 2, '狀態有變就通知畫面重畫')
})
