// #2441：夥伴的「要重新登入」「額度用完」狀態要傳到畫面；不認得的狀態不再當成線上。
import test, { mock } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { AsnCore } from '../ui/lib/core.mjs'
import { buildFriends, statusOf, isDeviceLiveStatus } from '../ui/lib/roster.mjs'
import { SCREEN_STATUS, RAW_STATUS, announcesLogin } from '../ui/lib/partner-status.mjs'
import { loginNote, warnKind } from '../ui/lib/head-tone.mjs'
import { nameplateView } from '../ui/lib/actionbar.mjs'
import { statusNote } from '../ui/lib/tabs.mjs'
import { aiChoices } from '../ui/lib/groups.mjs'
import { infoRows } from '../ui/lib/partner-ops.mjs'
import { memStore, sleep } from './helpers.mjs'

const rd = f => readFileSync(new URL(`../ui/${f}`, import.meta.url), 'utf8')
const logged = fn => {
  const spy = mock.method(console, 'info', () => {})
  try { fn(); return spy.mock.calls.map(c => c.arguments.join(' ')) } finally { spy.mock.restore() }
}

test('statusOf：login-required＝要重新登入；quota、limit＝額度用完；原有的忙碌、暫離、已停止、線上不變', () => {
  assert.equal(statusOf('login-required'), 'login-required')
  assert.equal(statusOf(' Login-Required '), 'login-required')
  assert.equal(statusOf('quota'), 'quota')
  assert.equal(statusOf('limit'), 'quota')
  for (const s of ['busy', 'working', 'running', 'thinking']) assert.equal(statusOf(s), 'busy', s)
  for (const s of ['waiting', 'away', 'blocked', 'paused']) assert.equal(statusOf(s), 'away', s)
  assert.equal(statusOf('stopped'), 'stopped')
  for (const s of ['idle', 'online']) assert.equal(statusOf(s), 'online', s)
  assert.equal(statusOf('idle', true), 'running', '程序條目照舊一律 running')
})

test('statusOf：空值、沒有 status 欄位維持原本的意思（線上）', () => {
  for (const s of ['', '  ', null, undefined]) assert.equal(statusOf(s), 'online', String(s))
})

test('statusOf：不認得的狀態＝狀態不明（不是線上），原始值記一行 log，同一個值只記一次', () => {
  const lines = logged(() => {
    assert.equal(statusOf('zz-new-state-1'), 'unknown')
    assert.equal(statusOf('ZZ-New-State-1'), 'unknown')
    assert.equal(statusOf('zz-new-state-1'), 'unknown')
    assert.equal(statusOf('zz-new-state-2'), 'unknown')
    assert.equal(statusOf('constructor'), 'unknown', '原型上的名字不算已登記')
  })
  assert.equal(lines.filter(l => l.includes('zz-new-state-1')).length, 1, '同一個值只記一次')
  assert.equal(lines.filter(l => l.includes('zz-new-state-2')).length, 1)
  assert.ok(lines.every(l => l.includes('狀態不明')))
  const again = logged(() => { statusOf('zz-new-state-1'); statusOf('idle'); statusOf('login-required') })
  assert.deepEqual(again, [], '已記過的、認得的、空值都不再記')
})

test('buildFriends：名單帶 login-required／quota／limit／不認得的值，friend.status 照實反映', () => {
  const f = buildFriends([{ id: 'T', agents: [
    { name: 'T-甲', status: 'login-required' }, { name: 'T-乙', status: 'quota' }, { name: 'T-丙', status: 'limit' },
    { name: 'T-丁', status: 'zz-new-state-3' }, { name: 'T-戊', status: 'idle' }, { name: 'T-己' },
  ] }], { selfNode: 'X', selfName: 'X-ASN' })
  assert.deepEqual(Object.fromEntries(f.map(x => [x.agent, x.status])), { 'T-甲': 'login-required', 'T-乙': 'quota', 'T-丙': 'quota', 'T-丁': 'unknown', 'T-戊': 'online', 'T-己': 'online' })
  for (const x of f) assert.equal(isDeviceLiveStatus(x.status), true, `${x.agent} 所在的設備是活的`)
})

test('畫面：名單灰字、名牌、對話標題都看得到新狀態（用的是同一份對照表）', () => {
  assert.equal(statusNote('login-required'), '(要重新登入)')
  assert.equal(statusNote('quota'), '(額度用完)')
  assert.equal(statusNote('unknown'), '(狀態不明)')
  assert.equal(statusNote('online'), '', '線上不加字')
  assert.equal(nameplateView({ nick: '甲', device: 'PC', status: 'login-required' }).sub, 'PC・要重新登入')
  assert.equal(nameplateView({ nick: '甲', device: 'PC', status: 'quota' }).state, '額度用完')
  assert.equal(nameplateView({ nick: '甲', device: 'PC', status: 'unknown' }).state, '狀態不明')
  assert.equal(nameplateView({ nick: '甲', device: 'PC', status: 'busy' }).state, '忙碌', '原有的不變')
  const rows = aiChoices([{ id: 'T/a', node: 'T', agent: 'a', nick: 'a', status: 'login-required' }, { id: 'T/b', node: 'T', agent: 'b', nick: 'b', status: 'online' }])
  assert.deepEqual(rows.map(r => r.key), ['T~b', 'T~a'], '能收信的排在要重新登入的前面')
  assert.equal(infoRows({ status: 'login-required' }).find(r => r.label === '狀態').value, '要重新登入')
  assert.equal(infoRows({ status: 'limit' }).find(r => r.label === '狀態').value, '額度用完')
})

test('對話視窗：login-required 帶到 friend.status，「要重新登入」黃條真的出現；額度用完、狀態不明走一般的狀態說明', () => {
  assert.equal(warnKind('login-required'), 'login')
  assert.equal(warnKind('quota'), 'status')
  assert.equal(warnKind('unknown'), 'status')
  assert.equal(warnKind('online'), null)
  const friend = buildFriends([{ id: 'T', name: '甲機', agents: [{ name: 'Gemini', status: 'login-required', engine: 'gemini' }] }], { selfNode: 'X', selfName: 'X-ASN' })[0]
  assert.equal(warnKind(friend.status), 'login')
  assert.match(loginNote(friend), /Gemini 需要重新登入/)
  const cp = rd('lib/chatpane.mjs')
  assert.match(cp, /<div class="warn" v-if="warn === 'login'">\s*<i>i<\/i>\s*<span>\{\{ loginText \}\}<\/span>/, '黃條接在 warn === login 上')
  assert.match(cp, /warnKind\(props\.friend\?\.status/)
})

test('「已經登入」通知：只在從離線或要重新登入變成真的能用時發；轉成要重新登入、額度用完、狀態不明不發', async () => {
  let agents = [{ name: 'T-甲', status: 'idle' }]
  const transport = { list: async () => ({ members: [{ id: 'T', name: 'T機', agents }] }), inbox: async () => ({ messages: [] }), ack: async () => ({}), sentStatus: async () => [] }
  const core = new AsnCore({ transport, store: memStore(), selfNode: 'S', windowName: 'S-ASN', now: () => 1 })
  const notes = []
  core.on('notify', n => { if (n.kind === 'login') notes.push(`${n.friend.agent}:${n.friend.status}`) })
  const step = async next => { agents = next; await core.refreshRoster(); await sleep(5) }
  await step([{ name: 'T-甲', status: 'idle' }])                                          // 第一輪只記現況
  await step([{ name: 'T-甲', status: 'idle' }, { name: 'T-乙', status: 'login-required' }])
  assert.deepEqual(notes, [], '新出現就是登入失效：不能通知成已經登入')
  await step([{ name: 'T-甲', status: 'login-required' }, { name: 'T-乙', status: 'login-required' }])
  assert.deepEqual(notes, [], '線上轉成要重新登入：不通知')
  await step([{ name: 'T-甲', status: 'quota' }, { name: 'T-乙', status: 'zz-new-state-4' }])
  assert.deepEqual(notes, [], '轉成額度用完、狀態不明：不通知')
  await step([{ name: 'T-甲', status: 'idle' }, { name: 'T-乙', status: 'idle' }])
  assert.deepEqual(notes, [], '額度用完、狀態不明變回線上：不是重新登入，不通知')
  await step([{ name: 'T-甲', status: 'login-required' }, { name: 'T-乙', status: 'idle' }])
  await step([{ name: 'T-甲', status: 'busy' }, { name: 'T-乙', status: 'idle' }])
  assert.deepEqual(notes, ['T-甲:busy'], '要重新登入 → 能用：發一次')
  await step([{ name: 'T-乙', status: 'idle' }])                                          // 甲離線
  await step([{ name: 'T-甲', status: 'idle' }, { name: 'T-乙', status: 'idle' }])
  assert.deepEqual(notes, ['T-甲:busy', 'T-甲:online'], '離線 → 上線：照舊發')
})

test('announcesLogin：判斷表', () => {
  assert.equal(announcesLogin(undefined, 'online'), true)
  assert.equal(announcesLogin('offline', 'busy'), true)
  assert.equal(announcesLogin('login-required', 'away'), true)
  assert.equal(announcesLogin('offline', 'login-required'), false)
  assert.equal(announcesLogin('offline', 'quota'), false)
  assert.equal(announcesLogin('offline', 'unknown'), false)
  assert.equal(announcesLogin('online', 'online'), false)
  assert.equal(announcesLogin('online', 'busy'), false)
})

test('對照表自身一致：每個狀態都有字、都有圓點樣式；各檔不再各寫一份清單', () => {
  for (const [k, v] of Object.entries(SCREEN_STATUS)) assert.ok(v.label && v.plate, k)
  for (const [raw, v] of Object.entries(RAW_STATUS)) assert.ok(SCREEN_STATUS[v.to] && v.text, raw)
  const css = rd('style.css')
  for (const k of Object.keys(SCREEN_STATUS)) assert.ok(css.includes(`.dp.st-${k}`), `style.css 少了 .dp.st-${k}`)
  assert.ok(Object.keys(SCREEN_STATUS).includes('login-required') && Object.keys(SCREEN_STATUS).includes('quota') && Object.keys(SCREEN_STATUS).includes('unknown'))
  assert.doesNotMatch(rd('lib/chatpane.mjs'), /const STATUS = \{/)
  assert.doesNotMatch(rd('lib/actionbar.mjs'), /const PLATE_STATUS = \{/)
  assert.doesNotMatch(rd('lib/partner-ops.mjs'), /const STATUS_TEXT = \{/)
  assert.doesNotMatch(rd('lib/groups.mjs'), /const STATUS_RANK = \{/)
  assert.doesNotMatch(rd('lib/tabs.mjs'), /const NOTE = \{/)
  assert.doesNotMatch(rd('lib/roster.mjs'), /const (BUSY|AWAY) = new Set/)
})
