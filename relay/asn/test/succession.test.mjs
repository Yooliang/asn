// 夥伴 ID 第二期（#153）的介面端：接班選項、送出時機與錯誤處理、往來記錄帶夥伴 ID、夥伴 ID 不顯示給使用者。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { AsnCore } from '../ui/lib/core.mjs'
import { buildFriends } from '../ui/lib/roster.mjs'
import {
  SUCCESSION_GIVE_UP_MS, alreadyDone, canMarkSuccessor, giveUpNotice, newSuccession, readySuccessions, succeedOutcome, successorOptions,
} from '../ui/lib/succession.mjs'
import { startFakeRelay } from './fake-relay.mjs'
import { httpTransport, memStore } from './helpers.mjs'

const P = n => `p_${String(n).padStart(2, '0').repeat(10)}`
const NAME = 'T-ASN'

test('接班選項：視窗還開著的、自己、壞資料都不列；標籤只有名字與設備名；同名同設備加序號', () => {
  const list = [
    { partner_id: P(1), name: '小文', device: '家用', live: false },
    { partner_id: P(2), name: '小武', device: '家用', live: true },
    { partner_id: P(3), name: '自己', device: '家用', live: false },
    { partner_id: P(4), name: '小文', device: '家用', live: false },
    { partner_id: 'p_BAD', name: '壞', device: '家用' },
    { partner_id: P(5), name: '', device: '家用' },
    { partner_id: P(6), name: '小美', device: '', live: false },
    null,
  ]
  const o = successorOptions(list, { exceptPartnerId: P(3) })
  assert.deepEqual(o, [
    { value: P(1), label: '小文（家用） 1' },
    { value: P(4), label: '小文（家用） 2' },
    { value: P(6), label: '小美' },
  ])
  for (const x of o) assert.ok(!/p_[0-9a-f]{20}/.test(x.label), '標籤不含夥伴 ID')
  assert.deepEqual(successorOptions(null), [])
})

test('送出時機：新視窗出現在名單且後台認得它（有夥伴 ID、不是前任本人）才送；已經沿用前任就不用送', () => {
  const s = newSuccession({ node: 'T', name: '新夥伴', predecessor: P(1) }, 1000)
  assert.deepEqual(readySuccessions([s], []), [])
  assert.deepEqual(readySuccessions([s], [{ id: 'T/新夥伴', node: 'T', agent: '新夥伴' }]), [], '名單上有但後台還沒認出夥伴 ID')
  const f = { id: 'T/新夥伴', node: 'T', agent: '新夥伴', partnerId: P(9) }
  assert.deepEqual(readySuccessions([s], [f]), [{ s, friend: f }])
  assert.deepEqual(alreadyDone([s], [{ ...f, partnerId: P(1) }]), [s])
  assert.deepEqual(readySuccessions([s], [{ ...f, partnerId: P(1) }]), [])
  assert.ok(SUCCESSION_GIVE_UP_MS >= 60_000)
})

test('送出失敗：前任視窗還開著→稍後再試；沒登入／不是你的→放棄；文案純中文、不含 ID 或代號', () => {
  const live = succeedOutcome('partner_succeed HTTP 409 predecessor_live', '新夥伴')
  assert.equal(live.act, 'retry')
  assert.match(live.text, /關掉/)
  assert.equal(succeedOutcome('partner_succeed HTTP 403 forbidden').act, 'drop')
  assert.equal(succeedOutcome('尚未登入，無法指定接班').act, 'drop')
  assert.equal(succeedOutcome('partner_succeed HTTP 404 not_found').act, 'retry', '新視窗還沒被認進來')
  assert.equal(succeedOutcome('partner_succeed 連線失敗：timeout').act, 'retry')
  for (const t of [live.text, giveUpNotice('新夥伴', live.text).body]) assert.ok(!/predecessor|HTTP|p_[0-9a-f]/.test(t), t)
})

test('右鍵選單的「這是誰的接班」：只有在名單上、後台已認得（有夥伴 ID）的視窗才有', () => {
  assert.equal(canMarkSuccessor({ onRoster: true, partnerId: P(1) }), true)
  assert.equal(canMarkSuccessor({ onRoster: true }), false)
  assert.equal(canMarkSuccessor({ onRoster: false, partnerId: P(1) }), false)
  assert.equal(canMarkSuccessor({ onRoster: true, partnerId: 'x' }), false)
  assert.equal(canMarkSuccessor(null), false)
})

test('名單：後台帶 partner_id 才記成 partnerId（格式不對丟掉）；舊後台沒有這個鍵＝沒有欄位', () => {
  const f = buildFriends([{ id: 'W', name: '工作機', agents: [
    { name: '甲', partner_id: P(1) }, { name: '乙', partner_id: 'junk' }, { name: '丙', partner_id: null }, { name: '丁' },
  ] }])
  assert.equal(f.find(x => x.agent === '甲').partnerId, P(1))
  for (const n of ['乙', '丙', '丁']) assert.ok(!('partnerId' in f.find(x => x.agent === n)), n)
})

test('往來記錄：向後台問的時候帶夥伴 ID（改名前後的往來都拿得到）；沒有夥伴 ID 的視窗不帶', async () => {
  const members = [
    { id: 'T', agents: [{ name: NAME, status: 'idle' }], asn: [{ window_name: NAME, version: '0.1.29', status: 'online' }] },
    { id: 'W', agents: [{ name: '甲', status: 'idle', partner_id: P(1) }, { name: '乙', status: 'idle' }] },
  ]
  const relay = await startFakeRelay({ node: 'T', members })
  const calls = []
  const transport = { ...httpTransport(relay.url, NAME), history: (node, agent, partnerId) => { calls.push([node, agent, partnerId ?? null]); return Promise.resolve({ messages: [] }) } }
  const core = new AsnCore({ transport, store: memStore(), selfNode: 'T', windowName: NAME, pollMs: 60_000, rosterMs: 60_000, now: () => 1_000_000, log: () => {} })
  try {
    await core.start()
    await core.syncHistory('W/甲')
    await core.syncHistory('W/乙')
    assert.deepEqual(calls, [['W', '甲', P(1)], ['W', '乙', null]])
    assert.equal(core.snapshot().friends.find(f => f.id === 'W/甲').partnerId, P(1), '存檔會留著，離線時也能查')
  } finally { await core.stop(); await relay.close() }
})

test('守門：夥伴 ID 與節點代號不顯示在畫面上（模板裡沒有 partnerId／partner_id 的插值）', () => {
  const html = fs.readFileSync(new URL('../ui/list.html', import.meta.url), 'utf8')
  const interp = [...html.matchAll(/\{\{([\s\S]*?)\}\}/g)].map(m => m[1])
  assert.ok(interp.length > 20, '有掃到模板插值')
  for (const t of interp) assert.ok(!/partnerId|partner_id|predecessor|\bsuccessorOf\b/.test(t), `不該顯示：{{${t}}}`)
  // 接班選單的選項值是夥伴 ID，但文字只能是 label
  const opts = html.match(/:value="o\.value">\{\{ o\.label \}\}</g) ?? []
  assert.equal(opts.length, 2, '開新夥伴與右鍵接班兩個下拉都只顯示 label')
  assert.ok(!/\{\{\s*o\.value\s*\}\}/.test(html), '選項的值（夥伴 ID）不能當文字顯示')
})

test('守門：指定接班與夥伴清單只在 ASN 視窗的前端出現，AI 用的 CLI／橋／雲端代理沒有（登入憑證不交給 AI）', () => {
  const root = new URL('../../', import.meta.url)
  for (const f of ['machine/send.mjs', 'machine/recv.mjs', 'machine/bridge.mjs', 'machine/relay-core.mjs', 'cloud-agent/agent.mjs']) {
    const p = new URL(f, root)
    if (!fs.existsSync(p)) continue
    const t = fs.readFileSync(p, 'utf8')
    assert.ok(!t.includes('partner_succeed') && !t.includes('partner_list'), `${f} 不該碰指定接班／夥伴清單`)
  }
})
