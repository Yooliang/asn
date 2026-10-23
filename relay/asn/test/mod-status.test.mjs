// Claude 外掛狀態顯示：名單帶出（設備層級＋每個視窗）與詳情的「Claude 外掛」一列。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { claudeModText, infoRows } from '../ui/lib/partner-ops.mjs'
import { buildFriends, modOf } from '../ui/lib/roster.mjs'

const INST = { state: 'installed', version: '0.4.2', reason: '' }

test('claudeModText：各狀態純中文；已安裝再分這個視窗載入與否', () => {
  assert.equal(claudeModText(INST, true), '已安裝 0.4.2，這個視窗已載入')
  assert.equal(claudeModText(INST, false), '已安裝 0.4.2，但這個視窗是安裝前開的，重開後才會載入')
  assert.equal(claudeModText(INST, null), '已安裝 0.4.2')
  assert.equal(claudeModText({ state: 'installed', version: '', reason: '' }, true), '已安裝，這個視窗已載入')
  assert.equal(claudeModText({ state: 'removed' }), '已被使用者移除，不會自動重裝')
  assert.equal(claudeModText({ state: 'no_claude' }), '這台電腦找不到 Claude')
  assert.equal(claudeModText({ state: 'failed', reason: '安裝外掛失敗：網路不通' }), '安裝失敗：安裝外掛失敗：網路不通')
  assert.equal(claudeModText({ state: 'failed', reason: 'ENOENT spawn' }), '安裝失敗', '英文原因不外露')
  assert.equal(claudeModText({ state: 'update_failed', reason: '' }), '更新失敗')
  assert.equal(claudeModText({ state: 'checking' }), '檢查中')
  assert.equal(claudeModText(null), ''); assert.equal(claudeModText({ state: 'weird' }), '')
})

test('modOf：只收認得的狀態；其餘（含舊後台）＝null', () => {
  assert.deepEqual(modOf({ state: 'installed', version: '1.0.0', reason: undefined, updated_at: 'x' }), { state: 'installed', version: '1.0.0', reason: '' })
  for (const bad of [null, undefined, 5, [], {}, { state: 'x' }]) assert.equal(modOf(bad), null)
})

test('buildFriends：電腦的外掛狀態與視窗是否載入；離線、非布林、舊後台＝null', () => {
  const f = buildFriends([
    { id: 'H', name: '家用機', claude_mod: { state: 'installed', version: '0.4.2' }, agents: [
      { name: 'H-甲', status: 'idle', mod_loaded: true }, { name: 'H-乙', status: 'idle', mod_loaded: false },
      { name: 'H-丙', status: 'idle', mod_loaded: 'yes' }, { name: 'H-丁', status: 'idle' }],
    offline_agents: [{ name: 'H-戊', status: 'offline', online: false, mod_loaded: true }] },
    { id: 'W', name: '舊後台機', agents: [{ name: 'W-甲', status: 'idle' }] },
  ], { selfNode: 'X', selfName: 'X-ASN' })
  const by = Object.fromEntries(f.map(x => [x.agent, x]))
  assert.deepEqual(['H-甲', 'H-乙', 'H-丙', 'H-丁', 'H-戊'].map(n => by[n].modLoaded), [true, false, null, null, null])
  assert.deepEqual(by['H-甲'].deviceMod, { state: 'installed', version: '0.4.2', reason: '' })
  assert.equal(by['W-甲'].deviceMod, null); assert.equal(by['W-甲'].modLoaded, null)
})

test('infoRows：有電腦回報就顯示「Claude 外掛」一列（取代舊的「ASN 外掛」）；視窗載入以詳情為先、沒有再用名單', () => {
  const dev = { deviceMod: INST, modLoaded: true }
  assert.deepEqual(infoRows({ pid: 7, mod: true }, dev), [{ label: 'PID', value: '7' }, { label: 'Claude 外掛', value: '已安裝 0.4.2，這個視窗已載入' }])
  assert.deepEqual(infoRows({ pid: 7, mod: false }, dev).at(-1), { label: 'Claude 外掛', value: '已安裝 0.4.2，但這個視窗是安裝前開的，重開後才會載入' })
  assert.deepEqual(infoRows({ pid: 7 }, dev).at(-1), { label: 'Claude 外掛', value: '已安裝 0.4.2，這個視窗已載入' }, '詳情沒說就用名單的')
  assert.deepEqual(infoRows({}, { deviceMod: { state: 'removed' } }), [{ label: 'Claude 外掛', value: '已被使用者移除，不會自動重裝' }])
  // 舊後台：沒有 deviceMod → 和以前一模一樣
  assert.deepEqual(infoRows({ pid: 7, mod: true }, { deviceMod: null }), [{ label: 'PID', value: '7' }, { label: 'ASN 外掛', value: '已安裝' }])
  assert.deepEqual(infoRows({ pid: 7, mod: true }), [{ label: 'PID', value: '7' }, { label: 'ASN 外掛', value: '已安裝' }])
  assert.ok(!JSON.stringify(infoRows({ pid: 7 }, { ...dev, node: 'H', partnerId: 'p_0123456789abcdef0123' })).match(/p_0123|"H"/), '不顯示節點代號與夥伴 ID')
})

test('守門：電腦版詳情把名單上的那位傳給 infoRows；名單合併每輪以最新為準', () => {
  const read = p => fs.readFileSync(new URL('../ui/lib/' + p, import.meta.url), 'utf8')
  assert.match(read('partner-ops-ui.mjs'), /infoRows\(row\.result, friend\)/)
  assert.match(read('core.mjs'), /modLoaded: m\.modLoaded \?\? null, deviceMod: m\.deviceMod \?\? null/)
})
