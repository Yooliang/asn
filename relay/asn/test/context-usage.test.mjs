// 上下文用量：名單小字（70％顯示、90％變紅）與升破 90％的提醒（一次升破只提醒一次、降回去再升才再提醒）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CONTEXT_BANNER_MS, notifyPlan as mobilePlan } from '../ui/lib/mobile.mjs'
import { notifyPlan as desktopPlan } from '../ui/lib/prefs.mjs'
import { AsnCore } from '../ui/lib/core.mjs'
import { buildFriends } from '../ui/lib/roster.mjs'
import { contextAlertText, contextLabel, createContextWatch, pctOf } from '../ui/lib/context-usage.mjs'
import { memStore, sleep } from './helpers.mjs'

test('pctOf：0～100 的數字四捨五入成整數，其餘當沒有', () => {
  assert.equal(pctOf(85), 85); assert.equal(pctOf(92.6), 93); assert.equal(pctOf(0), 0); assert.equal(pctOf(100), 100)
  for (const bad of [-1, 101, NaN, Infinity, '80', null, undefined, {}]) assert.equal(pctOf(bad), null, String(bad))
})

test('contextLabel：低於 70％不顯示；70～89 一般；90 以上標紅；沒有資料不顯示', () => {
  assert.equal(contextLabel({ contextPct: 69 }), null)
  assert.equal(contextLabel({}), null)
  assert.equal(contextLabel(null), null)
  assert.deepEqual(contextLabel({ contextPct: 70 }), { text: '上下文 70%', danger: false })
  assert.deepEqual(contextLabel({ contextPct: 89 }), { text: '上下文 89%', danger: false })
  assert.deepEqual(contextLabel({ contextPct: 90 }), { text: '上下文 90%', danger: true })
  assert.deepEqual(contextLabel({ contextPct: 95 }), { text: '上下文 95%', danger: true })
})

test('提醒文字', () => {
  assert.equal(contextAlertText('甲', 92), '甲 的上下文已用 92%，快要壓縮了')
})

test('升破偵測：第一次只記現況；升破一次提醒一次；降回 90 以下再升才再提醒；沒有資料不當成降回', () => {
  const w = createContextWatch()
  const at = (a, b) => [{ id: 'A', contextPct: a }, { id: 'B', contextPct: b }]
  assert.deepEqual(w.update(at(95, 50)), [], '程式剛開就很滿：不算剛升破')
  assert.deepEqual(w.update(at(96, 91)), [{ id: 'B', pct: 91 }], 'B 升破；A 本來就高，不重複')
  assert.deepEqual(w.update(at(97, 99)), [], '還在高處不再提醒')
  assert.deepEqual(w.update([{ id: 'A', contextPct: null }, { id: 'B', contextPct: null }]), [], '沒資料：不提醒')
  assert.deepEqual(w.update(at(98, 98)), [], '沒資料那輪不算降回去')
  assert.deepEqual(w.update(at(10, 89)), [], '壓縮後降回去')
  assert.deepEqual(w.update(at(90, 89)), [{ id: 'A', pct: 90 }], '再升上去才再提醒')
  assert.deepEqual(w.update(at(90, 90)), [{ id: 'B', pct: 90 }])
})

test('升破偵測：剛開機後才出現的新視窗一出現就 ≥90，提醒一次', () => {
  const w = createContextWatch()
  w.update([{ id: 'A', contextPct: 10 }])
  assert.deepEqual(w.update([{ id: 'A', contextPct: 10 }, { id: 'N', contextPct: 93 }]), [{ id: 'N', pct: 93 }])
})

test('buildFriends：在線的帶 contextPct；離線、壞值、舊後台沒有欄位＝null', () => {
  const f = buildFriends([{ id: 'H', agents: [
    { name: 'H-甲', status: 'busy', context_pct: 85 },
    { name: 'H-乙', status: 'idle' },
    { name: 'H-丙', status: 'idle', context_pct: 'x' },
    { name: 'H-丁', status: 'idle', context_pct: 140 },
  ], offline_agents: [{ name: 'H-戊', status: 'offline', context_pct: 95, online: false }] }], { selfNode: 'X', selfName: 'X-ASN' })
  assert.deepEqual(f.map(x => [x.agent, x.contextPct]), [['H-甲', 85], ['H-乙', null], ['H-丙', null], ['H-丁', null], ['H-戊', null]])
})

test('手機提醒：前景跳橫幅（帶換班接手、停留較久、不震動）；背景不跳；正在看那位也要跳；一般訊息橫幅沒有換手', () => {
  const n = { kind: 'context', friend: { id: 'A', nick: '甲', status: 'busy', hue: 1 }, line: '甲 的上下文已用 92%，快要壓縮了' }
  const p = mobilePlan(n, { openId: '', foreground: true })
  assert.equal(p.banner.id, 'A'); assert.equal(p.banner.handover, true); assert.equal(p.banner.ms, CONTEXT_BANNER_MS); assert.equal(p.vibrate, 0)
  assert.equal(mobilePlan(n, { foreground: false }).banner, null)
  assert.equal(mobilePlan(n, { openId: 'A', foreground: true }).banner.id, 'A')
  const m = mobilePlan({ kind: 'msg', friend: n.friend, line: '嗨' }, { foreground: true })
  assert.equal(m.banner.handover, undefined)
})

test('電腦提醒：走既有的 toast，不出聲', () => {
  const n = { kind: 'context', friend: { id: 'A' }, line: 'x', toast: true }
  assert.deepEqual(desktopPlan(n, { toast: true, msg: true }, 'online'), { sound: null, toast: true })
  assert.deepEqual(desktopPlan(n, { toast: false }, 'online'), { sound: null, toast: false })
})

test('核心：名單升破 90％才發提醒事件，點開用的好友帶在事件上；降回去再升才再發', async () => {
  let members = []
  const roster = pct => [{ id: 'T', name: 'T機', agents: [{ name: 'T-甲', status: 'busy', cwd_label: 'p', context_pct: pct }] }]
  const transport = { list: async () => ({ members }), inbox: async () => ({ messages: [] }), ack: async () => ({}), sentStatus: async () => [] }
  const core = new AsnCore({ transport, store: memStore(), selfNode: 'S', windowName: 'S-ASN', now: () => 1 })
  const notes = []
  core.on('notify', n => { if (n.kind === 'context') notes.push(n) })
  const step = async pct => { members = roster(pct); await core.refreshRoster(); await sleep(5) }
  await step(60)
  await step(88); assert.equal(notes.length, 0)
  assert.equal(core.friends.get('T/T-甲').contextPct, 88)
  await step(92)
  assert.equal(notes.length, 1)
  assert.equal(notes[0].friend.id, 'T/T-甲'); assert.equal(notes[0].line, 'T-甲 的上下文已用 92%，快要壓縮了'); assert.equal(notes[0].toast, true)
  await step(97); assert.equal(notes.length, 1, '一次升破只提醒一次')
  await step(30); await step(91); assert.equal(notes.length, 2, '降回去再升才再提醒')
  members = [{ id: 'T', name: 'T機', agents: [] }]; await core.refreshRoster()
  assert.equal(core.friends.get('T/T-甲')?.contextPct ?? null, null, '視窗不在名單：用量不沿用舊值')
})

test('接線：電腦版與手機版名單都顯示用量小字；手機橫幅有「換班接手」按鈕並接到同一個換手流程', async () => {
  const { readFileSync } = await import('node:fs')
  const rd = f => readFileSync(new URL(`../ui/${f}`, import.meta.url), 'utf8')
  for (const f of ['list.html', 'm.html']) assert.match(rd(f), /<span class="b-ctx" :class="\{ danger: contextLabel\(c\)\.danger \}" v-if="contextLabel\(c\)">\{\{ contextLabel\(c\)\.text \}\}<\/span>/, f)
  assert.match(rd('m.html'), /<button class="m-banner-act"[^>]*v-if="banner\.handover" @click\.stop="bannerHandover">換班接手<\/button>/)
  const js = rd('m.js')
  assert.match(js, /async function bannerHandover\(\)[\s\S]*pickOp\('handover'\)/, '直接帶到換班接手的確認框')
  assert.match(js, /bannerHandover, contextLabel/, '要交給樣板')
  assert.match(rd('list.js'), /contextLabel, avOf/, '電腦版要交給樣板')
})
