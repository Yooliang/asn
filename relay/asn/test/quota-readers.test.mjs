// 額度來源與查詢代碼（todo-next-193）
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { QUOTA_TEXT, createQuotaReaders, normalizeReaders, quotaReadersView, shareKey } from '../ui/lib/quota-readers.mjs'
import { SETTING_OPS, SettingsPanel } from '../ui/lib/settings-panel.mjs'
import { rosterQuota, rosterView } from '../ui/lib/account-roster.mjs'

const SECRET = 'test-key-value'
const CODE = 'a'.repeat(64)
const off = { grok: false, agy: false, minimax: [], minimax_supported: true, status: {} }

function make(answers = {}) {
  const calls = []
  const logs = []
  const changed = []
  const copied = []
  const invoke = async (cmd, args) => {
    calls.push([cmd, args])
    const a = answers[cmd]
    if (a instanceof Error) throw a
    return typeof a === 'function' ? a(args) : a ?? off
  }
  const ui = createQuotaReaders({ invoke, onShareChanged: () => changed.push(1), clipboard: async t => { copied.push(t) }, log: (...x) => logs.push(x) })
  return { ui, calls, logs, changed, copied }
}

test('預設全關；Rust 回的形狀不對也是全關', () => {
  for (const v of [null, undefined, 'x', {}, { grok: 'yes', agy: 1, minimax: 'x' }]) {
    const r = normalizeReaders(v)
    assert.equal(r.grok, false)
    assert.equal(r.agy, false)
    assert.deepEqual(r.minimax, [])
  }
  const { ui } = make()
  assert.equal(ui.state.grok, false)
  assert.equal(ui.state.agy, false)
})

test('失敗原因留在畫面；每個 MiniMax 帳號各自的狀態', () => {
  const r = normalizeReaders({ grok: true, status: { grok: '登入失效，要重新登入', minimax: { 'm@x.test': '連線失敗' } }, minimax: [{ email: 'm@x.test', has_key: true }, { email: 'n@x.test', has_key: false }] })
  assert.equal(r.status.grok, '登入失效，要重新登入')
  assert.deepEqual(r.minimax, [{ email: 'm@x.test', hasKey: true, status: '連線失敗' }, { email: 'n@x.test', hasKey: false, status: '' }])
})

test('開關：帶來源與布林', async () => {
  const { ui, calls } = make({ quota_readers_set: { ...off, grok: true } })
  await ui.setSource('grok', true)
  assert.deepEqual(calls[0], ['quota_readers_set', { source: 'grok', on: true }])
  assert.equal(ui.state.grok, true)
})

test('MiniMax key 交給 Rust 後不留在狀態、快照、訊息', async () => {
  const { ui, calls, logs } = make({ quota_minimax_add: { ...off, minimax: [{ email: 'm@x.test', has_key: true }] } })
  assert.equal(await ui.addMinimax({ email: ' m@x.test ', key: ` ${SECRET} ` }), true)
  assert.deepEqual(calls[0], ['quota_minimax_add', { email: 'm@x.test', key: SECRET }])
  assert.ok(!JSON.stringify(ui.state).includes(SECRET))
  assert.ok(!JSON.stringify(quotaReadersView(ui.state)).includes(SECRET))
  assert.ok(!JSON.stringify(logs).includes(SECRET))
  assert.equal(ui.state.msg, QUOTA_TEXT.added)
})

test('MiniMax：沒填不送；滿 2 個不送；存失敗的訊息不含 key', async () => {
  const { ui, calls } = make()
  assert.equal(await ui.addMinimax({ email: '', key: SECRET }), false)
  assert.equal(await ui.addMinimax({ email: 'm@x.test', key: ' ' }), false)
  assert.equal(calls.length, 0)
  assert.equal(ui.state.msg, QUOTA_TEXT.failInput)
  const full = make({ quota_readers_get: { ...off, minimax: [{ email: 'a@x.test' }, { email: 'b@x.test' }] } })
  await full.ui.load()
  assert.equal(await full.ui.addMinimax({ email: 'c@x.test', key: SECRET }), false)
  assert.equal(full.ui.state.msg, QUOTA_TEXT.failFull)
  const bad = make({ quota_minimax_add: new Error('無法存入憑證管理員') })
  assert.equal(await bad.ui.addMinimax({ email: 'm@x.test', key: SECRET }), false)
  assert.equal(bad.ui.state.msg, QUOTA_TEXT.failGeneric)
  assert.ok(!JSON.stringify(bad.logs).includes(SECRET))
})

test('移除要按兩次', async () => {
  const { ui, calls } = make()
  assert.equal(await ui.removeMinimax('m@x.test'), false)
  assert.equal(calls.length, 0)
  assert.equal(ui.state.confirm, 'minimax\nm@x.test')
  assert.equal(await ui.removeMinimax('m@x.test'), true)
  assert.deepEqual(calls[0], ['quota_minimax_remove', { email: 'm@x.test' }])
})

test('第一次產生代碼直接做；代碼顯示到關掉為止，關掉就讀不回來', async () => {
  const { ui, calls, changed, copied } = make({ quota_share_create: { ok: true, code: CODE } })
  assert.equal(await ui.share({ vendor: 'claude', account: 'a@x.test', shared: false }), true)
  assert.deepEqual(calls[0], ['quota_share_create', { vendor: 'claude', account: 'a@x.test' }])
  assert.deepEqual(ui.state.code, { key: shareKey('claude', 'a@x.test'), value: CODE })
  assert.equal(changed.length, 1, '要重讀列表，才看得到已開放')
  await ui.copyCode()
  assert.deepEqual(copied, [CODE])
  assert.equal(ui.state.copied, true)
  ui.closeCode()
  assert.equal(ui.state.code, null)
  assert.ok(!JSON.stringify(quotaReadersView(ui.state)).includes(CODE))
})

test('重新產生、撤銷都要按兩次；撤銷收掉畫面上的代碼', async () => {
  const { ui, calls } = make({ quota_share_create: { ok: true, code: CODE }, quota_share_revoke: { ok: true } })
  const a = { vendor: 'claude', account: 'a@x.test', shared: true }
  assert.equal(await ui.share(a), false)
  assert.equal(calls.length, 0)
  assert.equal(await ui.share(a), true)
  assert.ok(ui.state.code)
  assert.equal(await ui.unshare(a), false)
  assert.equal(calls.length, 1)
  assert.equal(await ui.unshare(a), true)
  assert.equal(calls[1][0], 'quota_share_revoke')
  assert.equal(ui.state.code, null)
})

test('代碼失敗：畫面是白話，細節進主控台；沒回代碼不算成功', async () => {
  const net = make({ quota_share_create: new Error('quota_share_create HTTP 404 not_found') })
  assert.equal(await net.ui.share({ vendor: 'claude', account: 'a@x.test' }), false)
  assert.equal(net.ui.state.msg, QUOTA_TEXT.failShare)
  assert.ok(!net.ui.state.msg.includes('HTTP'))
  assert.equal(net.logs.length, 1)
  const login = make({ quota_share_create: new Error('尚未登入，無法變更查詢代碼') })
  await login.ui.share({ vendor: 'claude', account: 'a@x.test' })
  assert.equal(login.ui.state.msg, QUOTA_TEXT.failLogin)
  const empty = make({ quota_share_create: { ok: true } })
  assert.equal(await empty.ui.share({ vendor: 'claude', account: 'a@x.test' }), false)
  assert.equal(empty.ui.state.code, null)
})

test('畫面文字：agy 帳號判斷、key 不再顯示、代碼只顯示一次都寫明；沒有內部名稱', () => {
  assert.match(QUOTA_TEXT.agyNote, /帳號依上次開視窗判斷/)
  assert.match(QUOTA_TEXT.minimaxNote, /不會再顯示/)
  assert.match(QUOTA_TEXT.codeOnce, /只顯示這一次/)
  assert.match(QUOTA_TEXT.codeOnce, /只能重新產生/)
  assert.match(QUOTA_TEXT.note, /都是關的/)
  const all = Object.values(QUOTA_TEXT).filter(v => typeof v === 'string').join('\n')
  assert.doesNotMatch(all, /relay|supabase|rpc|hash|雜湊|憑證管理員|HTTP|API|agy/i)
})

test('設定頁：指令都在清單；key 欄位是密碼欄且只綁元件內部；樞紐接得住', () => {
  const ops = ['quota-source', 'quota-mm-add', 'quota-mm-remove', 'quota-share', 'quota-unshare', 'quota-copy', 'quota-close']
  const list = fs.readFileSync(new URL('../ui/list.js', import.meta.url), 'utf8')
  const panel = fs.readFileSync(new URL('../ui/lib/settings-panel.mjs', import.meta.url), 'utf8')
  for (const op of ops) {
    assert.ok(SETTING_OPS.includes(op), op)
    assert.ok(panel.includes(`act('${op}'`), `${op} 元件`)
    assert.ok(list.includes(`case '${op}':`), `${op} 樞紐`)
  }
  assert.match(SettingsPanel.template, /type="password"[^>]*autocomplete="off"/)
  assert.doesNotMatch(SettingsPanel.template.replaceAll('st.quotaReaders.code.key', ''), /st\.quotaReaders\.[a-zA-Z.]*key\b/i, '快照裡沒有 MiniMax key')
})

test('電腦版註冊了四個設定指令與兩個代碼指令', () => {
  const lib = fs.readFileSync(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8')
  const at = [...lib.matchAll(/\.invoke_handler\(/g)].map(m => m.index)
  const desktop = lib.slice(at[0], at[1])
  for (const c of ['quota_readers_get', 'quota_readers_set', 'quota_minimax_add', 'quota_minimax_remove', 'quota_share_create', 'quota_share_revoke']) {
    assert.match(desktop, new RegExp(`[\\s,]${c}[\\s,]`), c)
  }
})

const NOW = Date.parse('2026-11-05T00:00:00Z')
const AT = '2026-11-04T23:50:00Z'
const RESET = '2026-11-06T00:00:00Z'

test('我的帳號：MiniMax 有名稱、讀得到窗，Grok 的窗也顯示；舊資料沒有窗照舊', () => {
  const v = rosterView({ accounts: [
    { vendor: 'minimax', account: 'm@x.test', plan: '', windows: [{ name: 'five_hour', left_pct: 80, resets_at: RESET, read_at: AT }], nodes: [{ node: 'W', current: true }], seen_at: AT, shared: true },
    { vendor: 'grok', account: 'g@x.test', plan: '', windows: [{ name: 'weekly', left_pct: 47, resets_at: RESET, read_at: AT }], nodes: [{ node: 'W', current: true }], seen_at: AT },
  ] }, { now: NOW })
  assert.deepEqual(v.vendors.map(x => [x.key, x.label]), [['grok', 'Grok'], ['minimax', 'MiniMax']])
  assert.equal(v.vendors[1].accounts[0].shared, true)
  assert.equal(v.vendors[0].accounts[0].shared, false)
  assert.match(v.vendors[1].accounts[0].quota.text, /5 小時剩 80%/)
  assert.match(v.vendors[0].accounts[0].quota.text, /每週剩 47%/)
  const none = rosterQuota({ vendor: 'grok', account: 'g@x.test', windows: [], nodes: [], seen_at: AT }, { now: NOW })
  assert.equal(none.known, false)
})

test('MiniMax 不會因為舊表沒有它就標成沒有設備在回報', () => {
  const q = rosterQuota({ vendor: 'minimax', account: 'm@x.test', windows: [{ name: 'weekly', left_pct: 50, read_at: AT }], nodes: [], seen_at: AT }, { now: NOW })
  assert.equal(q.gone, false)
})
