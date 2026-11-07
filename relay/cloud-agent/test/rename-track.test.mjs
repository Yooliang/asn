// 雲端夥伴改名自動接上（todo-next-181）：用編號認人、名單回報帶 renamed_from、群組游標接到新名、回報失敗不記錄
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createReceiver } from '../recv.mjs'
import { aliasCursors, detectRenames, OLD_KEEP_MS, OLD_PER_ID, pruneOldNames, readNames, readOldNames, recordOldNames, resolveOldName, writeNames } from '../rename-track.mjs'
import { main as inboxMain } from '../inbox.mjs'
import { startFakeRelay } from './fake-relay.mjs'
import { apiFor, rm, tmpEnv } from './helpers.mjs'

const ID1 = '11111111-2222-3333-4444-555555555555'
const ID2 = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const a = (id, name) => ({ name, profile_id: id, status: 'idle', engine: 'grok', cwd_label: 'grok-cloud' })

test('改名偵測：同一個編號名字變了才算；第一次看到只記錄；沒變不動', () => {
  assert.deepEqual(detectRenames([a(ID1, '新名')], { [ID1]: '舊名' }).renames, [{ id: ID1, from: '舊名', to: '新名' }])
  const first = detectRenames([a(ID1, '新名')], {})
  assert.deepEqual(first.renames, [])
  assert.deepEqual(first.names, { [ID1]: '新名' })
  assert.deepEqual(detectRenames([a(ID1, '同名')], { [ID1]: '同名' }).renames, [])
  assert.deepEqual(detectRenames([{ name: '手動', status: 'idle' }], { [ID1]: '舊名' }).renames, [], '沒有編號的（手動列的、Claude 視窗）不看')
  assert.deepEqual(detectRenames([], { [ID1]: '舊名' }).names, { [ID1]: '舊名' }, '這輪沒掃到的先留著，不忘記')
})

test('不確定的不猜：舊名被別的夥伴用著、兩位搶同一個名字，都跳過（照舊手動接），但記錄照常更新', () => {
  const swap = detectRenames([a(ID1, '乙'), a(ID2, '甲')], { [ID1]: '甲', [ID2]: '乙' })
  assert.deepEqual(swap.renames, [])
  assert.equal(swap.skipped.length, 2)
  assert.deepEqual(swap.names, { [ID1]: '乙', [ID2]: '甲' })
  const taken = detectRenames([a(ID1, '新'), a(ID2, '甲')], { [ID1]: '甲', [ID2]: '甲' })
  assert.deepEqual(taken.renames, [], '舊名「甲」現在還有別人在用')
  const same = detectRenames([a(ID1, '同'), a(ID2, '同')], { [ID1]: '甲', [ID2]: '乙' })
  assert.deepEqual(same.renames, [], '兩位改到同一個新名')
})

test('群組游標：舊名複製給新名；新名已經有就不覆蓋；節點本身與別的視窗不動', () => {
  const cur = { 'R1|n1~舊名': 7, 'R2|n1~舊名': 3, 'R1|n1~別人': 9, 'R1|n1': 5, 'R3|n1~新名': 100 }
  const r = aliasCursors({ ...cur, 'R3|n1~舊名': 2 }, [{ id: ID1, from: '舊名', to: '新名' }])
  assert.equal(r.changed, true)
  assert.deepEqual(r.cursors, { ...cur, 'R3|n1~舊名': 2, 'R1|n1~新名': 7, 'R2|n1~新名': 3 }, 'R3 的新名已經有游標（100），不被舊名（2）蓋掉')
  assert.equal(aliasCursors(cur, [{ id: ID1, from: '沒有的', to: 'x' }]).changed, false)
  assert.equal(aliasCursors(r.cursors, [{ id: ID1, from: '舊名', to: '新名' }]).changed, false, '再做一次不會變')
})

function writeProfile(dir, id, name) {
  fs.mkdirSync(path.join(dir, id), { recursive: true })
  fs.writeFileSync(path.join(dir, id, 'profile.json'), JSON.stringify({ name }))
}

test('整條線：名單回報不送編號；改名後帶 renamed_from、游標先接到新名；回報成功才記錄', async () => {
  const st = await startFakeRelay()
  const { root, cfg } = tmpEnv(st.url)
  const grok = path.join(root, 'grok-custom')
  const mk = () => createReceiver({ api: apiFor(cfg), cfg, log: () => {}, env: { ASN_CLOUD_ROSTER_AUTO: '1', GROK_AGENTS_DIR: grok } })
  try {
    cfg.rosterAuto = true
    writeProfile(grok, ID1, 'ASN-開發')
    await mk().rosterOnce()
    assert.deepEqual(st.rosters[0].agents.map(x => Object.keys(x).sort()), [['cwd_label', 'engine', 'name', 'status']], '不送編號、第一次沒有 renamed_from')
    assert.deepEqual(readNames(cfg.namesFile), { [ID1]: 'ASN-開發' })
    // 改名；本機已有群組游標
    fs.writeFileSync(cfg.roomsFile, JSON.stringify({ 'R1|grok~ASN-開發': 12 }))
    writeProfile(grok, ID1, 'ASN會議')
    // 第一次回報失敗：不記錄、重試時還是帶 renamed_from
    st.rosterStatus = 500
    await mk().rosterOnce()
    assert.equal(st.rosters.at(-1).agents[0].renamed_from, 'ASN-開發')
    assert.deepEqual(readNames(cfg.namesFile), { [ID1]: 'ASN-開發' }, '失敗不更新記錄')
    const cursors = JSON.parse(fs.readFileSync(cfg.roomsFile, 'utf8'))
    assert.equal(cursors['R1|grok~ASN會議'], 12, '回報之前游標就已經接到新名（失敗也不退）')
    assert.equal(cursors['R1|grok~ASN-開發'], 12, '舊的留著，不刪')
    st.rosterStatus = 200
    await mk().rosterOnce()
    assert.equal(st.rosters.at(-1).agents[0].renamed_from, 'ASN-開發')
    assert.deepEqual(readNames(cfg.namesFile), { [ID1]: 'ASN會議' }, '成功才記錄')
    await mk().rosterOnce()
    assert.equal('renamed_from' in st.rosters.at(-1).agents[0], false, '記錄好之後不再重複帶')
  } finally { await st.close(); rm(root) }
})

// ---------- 舊名轉投（#746）：改名後 7 天內，寄到舊名的信算給改名後的那位 ----------
const DAY = 24 * 60 * 60 * 1000
const T0 = 1_800_000_000_000

test('舊名轉投：7 天內的舊名對到那位現在的名字；超過 7 天、那位不在名單、舊名現在有人用，都對不到', () => {
  const names = { [ID1]: '新名' }
  const old = recordOldNames([], [{ id: ID1, from: '舊名', to: '新名' }], T0)
  const ctx = now => ({ names, old, present: new Set(['新名', 'Grok']), now })
  assert.equal(resolveOldName('舊名', ctx(T0 + DAY)), '新名')
  assert.equal(resolveOldName('舊名', ctx(T0 + OLD_KEEP_MS - 1)), '新名', '剛好 7 天內')
  assert.equal(resolveOldName('舊名', ctx(T0 + OLD_KEEP_MS)), null, '滿 7 天就不轉了')
  assert.equal(resolveOldName('舊名', { ...ctx(T0 + DAY), present: new Set(['Grok']) }), null, '那位現在不在名單上')
  assert.equal(resolveOldName('舊名', { ...ctx(T0 + DAY), present: new Set(['新名', '舊名']) }), null, '舊名現在有夥伴在用：照常算給他（呼叫端先看名單）')
  assert.equal(resolveOldName('沒改過的名', ctx(T0 + DAY)), null)
  assert.equal(resolveOldName(null, ctx(T0 + DAY)), null)
})

test('舊名轉投：連改兩次，最早的名字也對到最新的名字；同一個舊名被兩位用過就不猜', () => {
  let old = recordOldNames([], [{ id: ID1, from: '甲', to: '乙' }], T0)
  old = recordOldNames(old, [{ id: ID1, from: '乙', to: '丙' }], T0 + DAY)
  const present = new Set(['丙'])
  assert.equal(resolveOldName('甲', { names: { [ID1]: '丙' }, old, present, now: T0 + 2 * DAY }), '丙')
  assert.equal(resolveOldName('乙', { names: { [ID1]: '丙' }, old, present, now: T0 + 2 * DAY }), '丙')
  const both = recordOldNames(old, [{ id: ID2, from: '甲', to: '丁' }], T0 + DAY)
  assert.equal(resolveOldName('甲', { names: { [ID1]: '丙', [ID2]: '丁' }, old: both, present: new Set(['丙', '丁']), now: T0 + 2 * DAY }), null, '兩位都叫過「甲」')
})

test('舊名紀錄：每位最多 5 個、過期的丟掉；writeNames 不帶舊名時保留檔案裡原有的', () => {
  let old = []
  for (let i = 0; i < OLD_PER_ID + 2; i++) old = recordOldNames(old, [{ id: ID1, from: `名${i}`, to: `名${i + 1}` }], T0 + i)
  assert.deepEqual(old.map(o => o.from), ['名2', '名3', '名4', '名5', '名6'])
  assert.deepEqual(pruneOldNames(old, T0 + OLD_KEEP_MS + 10), [])
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || process.env.TEMP || '/tmp', 'asn746-'))
  try {
    const f = path.join(dir, 'agent-names.json')
    writeNames(f, { [ID1]: '名7' }, old)
    writeNames(f, { [ID1]: '名7', [ID2]: '別人' })
    assert.deepEqual(readOldNames(f), old)
    assert.deepEqual(readNames(f), { [ID1]: '名7', [ID2]: '別人' })
    fs.writeFileSync(f, JSON.stringify({ version: 1, names: { [ID1]: 'x' }, old: [{ id: ID1, from: '', to: 'x', at: 1 }, 'bad', { id: ID1, from: 'a', to: 'x', at: 'no' }] }))
    assert.deepEqual(readOldNames(f), [], '壞的列不收')
  } finally { rm(dir) }
})

test('整條線（#746）：改名回報成功後，寄到舊名的信 inbox --agent 算給新名，不給預設那位', async () => {
  const st = await startFakeRelay()
  const { root, cfg, env } = tmpEnv(st.url)
  const grok = path.join(root, 'grok-custom')
  const scanEnv = { ASN_CLOUD_ROSTER_AUTO: '1', GROK_AGENTS_DIR: grok }
  const mk = () => createReceiver({ api: apiFor(cfg), cfg, log: () => {}, env: scanEnv })
  try {
    cfg.rosterAuto = true
    writeProfile(grok, ID1, 'ASN-開發')
    await mk().rosterOnce()
    writeProfile(grok, ID1, 'ASN會議')
    st.rosterStatus = 500
    await mk().rosterOnce()
    assert.deepEqual(readOldNames(cfg.namesFile), [], '回報失敗不記舊名')
    st.rosterStatus = 200
    await mk().rosterOnce()
    assert.deepEqual(readOldNames(cfg.namesFile).map(o => [o.from, o.to]), [['ASN-開發', 'ASN會議']])
    const m = (n, to) => JSON.stringify({ id: `00000000-0000-0000-0000-00000000000${n}`, from_node: 'w02', from_agent: '工作機', to_agent: to, body: `信${n}`, expects_reply: true })
    fs.writeFileSync(cfg.inboxFile, [m(1, 'ASN-開發'), m(2, 'ASN會議'), m(3, '不存在的人')].join('\n') + '\n')
    const ids = async who => {
      const lines = []
      assert.equal(await inboxMain(['--json', '--agent', who], { ...env, ...scanEnv }, s => lines.push(s)), 0)
      return lines.flatMap(l => l.split('\n')).filter(Boolean).map(l => JSON.parse(l).id.slice(-1))
    }
    assert.deepEqual(await ids('ASN會議'), ['1', '2'], '寄到舊名的那封也給新名')
    assert.deepEqual(await ids(cfg.name), ['3'], '真的對不到的照舊給預設那位')
  } finally { await st.close(); rm(root) }
})
