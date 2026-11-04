// 雲端夥伴改名自動接上（todo-next-181）：用編號認人、名單回報帶 renamed_from、群組游標接到新名、回報失敗不記錄
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createReceiver } from '../recv.mjs'
import { aliasCursors, detectRenames, readNames } from '../rename-track.mjs'
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
