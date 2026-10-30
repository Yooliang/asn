// #539 收尾：喚醒併進第 2 格、群組按鈕拿掉「輸入邀請碼加入」、開新夥伴的型號下拉跟後端 launch_model_plan 同一個判斷。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { BAR_KEYS, WAKE_LABEL, barSlots, groupMenuItems, managePanelItems, partnerMenuItems } from '../ui/lib/actionbar.mjs'
import { phoneOpsRows } from '../ui/lib/mobile-ops.mjs'
import { launchModelChoices } from '../ui/lib/model-catalog.mjs'
import { localProfileEngine } from '../ui/lib/partner-launch-ui.mjs'
import { manageItems } from '../ui/lib/archive.mjs'

const read = p => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')
const F = (o = {}) => ({ id: 'H/a', node: 'H', agent: 'a', nick: 'a', status: 'idle', engine: 'claude', ...o })
const ops = { loaded: true, signedIn: true, machines: { H: { online: true, launcher: { profiles: [] } } } }
const CTX = { selfNode: 'H', api: true, callable: true, console: { state: 'toggle', visible: true }, subagents: true, tasks: true, ops, manageCount: 5 }
const win = (f, ctx = CTX) => barSlots(f, ctx).find(s => s.key === 'window')

test('第 2 格：離線的 Claude／pi 變「喚醒」可按（條件照 menuItems 的 resume）；在線照舊前後台；ACP 照舊反灰', () => {
  assert.equal(WAKE_LABEL, '喚醒')
  for (const engine of ['claude', 'pi']) {
    const w = win(F({ engine, status: 'offline' }))
    assert.deepEqual([w.key, w.label, w.ok, w.reason, w.wake], ['window', '喚醒', true, '', true], engine)
  }
  assert.deepEqual(barSlots(F({ status: 'offline' }), CTX).map(s => s.key), BAR_KEYS, '還是固定 6 格、順序不變')
  const on = win(F())
  assert.deepEqual([on.label, on.ok, Boolean(on.wake)], ['後台隱藏', true, false])
  const acp = win(F({ engine: 'gemini', status: 'offline' }))
  assert.deepEqual([acp.label, acp.ok, Boolean(acp.wake)], ['ACP 模式', false, false])
})

test('喚醒不能按時反灰並寫原因（20 字內）：電腦不在線、沒開放遠端管理、沒登入；其他電腦上的也一樣能喚醒', () => {
  const offMachine = win(F({ status: 'offline' }), { ...CTX, ops: { ...ops, machines: { H: { online: false, launcher: {} } } } })
  assert.deepEqual([offMachine.label, offMachine.ok, offMachine.reason], ['喚醒', false, '電腦不在線，叫不醒'])
  const closed = win(F({ status: 'offline' }), { ...CTX, ops: { ...ops, machines: { H: { online: true, launcher: null } } } })
  assert.deepEqual([closed.ok, closed.reason], [false, '這台電腦沒開放遠端管理'])
  const noLogin = win(F({ status: 'offline' }), { ...CTX, ops: { signedIn: false } })
  assert.equal(noLogin.ok, false)
  assert.ok(noLogin.reason.length > 0 && noLogin.reason.length <= 20, noLogin.reason)
  const remote = win(F({ status: 'offline', node: 'W' }), { ...CTX, ops: { ...ops, machines: { W: { online: true, launcher: {} } } } })
  assert.deepEqual([remote.label, remote.ok], ['喚醒', true], '別台電腦上的離線視窗也能叫醒（p:resume 本來就走遠端）')
})

test('名單右鍵不用第 2 格當喚醒（wake:false）：照舊「前台／後台」反灰；右鍵選單自己保留喚醒', () => {
  const w = win(F({ status: 'offline' }), { ...CTX, wake: false })
  assert.deepEqual([w.label, w.ok, w.reason, Boolean(w.wake)], ['前台／後台', false, '夥伴離線，要先喚醒', false])
  const right = partnerMenuItems(F({ status: 'offline' }), ops, 'H')
  assert.equal(right.find(i => i.key === 'p:resume')?.ok, true, '右鍵沒有大按鈕列，喚醒留著')
  const list = read('ui/list.js')
  assert.match(list, /barSlots\(c, \{ selfNode: info\.node, api: true, wake: false,/, '右鍵呼叫 barSlots 時關掉喚醒')
})

test('對話頁「管理」選單拿掉喚醒（已在第 2 格）；說明文字也不再寫喚醒', () => {
  const f = F({ status: 'offline' })
  const items = managePanelItems(f, ops, [], { selfNode: 'H' })
  assert.ok(items.length > 0)
  assert.equal(items.some(i => i.key === 'p:resume'), false)
  assert.equal(managePanelItems(F(), ops, [], { selfNode: 'H' }).some(i => i.key === 'p:resume'), false, '在線時也不列')
  const t = read('ui/lib/actionbar.mjs')
  const tip = t.match(/const MANAGE_TIP = '([^']*)'/)[1]
  assert.doesNotMatch(tip, /喚醒/)
})

test('電腦版第 2 格樣板：喚醒時換圖示、點了開喚醒對話框（p:resume 那條路）；圖示檔存在', () => {
  const t = read('ui/lib/actionbar.mjs')
  assert.match(t, /data-slot="window"[^>]*@click="onWindow"/)
  assert.match(t, /:src="slot\.window\.wake \? 'img\/ab-wake\.svg' : 'img\/ab-window\.svg'"/)
  assert.match(t, /function onWindow\(\) \{[\s\S]{0,200}slot\.value\.window\.wake[\s\S]{0,200}pickOps\('p:resume'\)/)
  assert.ok(fs.existsSync(new URL('../ui/img/ab-wake.svg', import.meta.url)))
  assert.match(read('ui/img/ab-wake.svg'), /<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 32 32" width="32" height="32">/)
})

test('pickOps 的喚醒不能因為管理選單拿掉喚醒就失效：找項目要用含喚醒的那份', () => {
  const t = read('ui/lib/actionbar.mjs')
  assert.match(t, /const wakeItem = slot\.value\.window/)
})

test('手機「⋯」：離線的喚醒排第一、可按；按下去走 resume（跟電腦版同一份 menuItems）', () => {
  const pops = { ...ops, machines: { Q: { online: true, launcher: {} } } }
  const rows = phoneOpsRows(manageItems(F({ node: 'Q', status: 'offline' }), pops))
  assert.deepEqual([rows[0].key, rows[0].ok], ['resume', true])
  const m = read('ui/m.js')
  assert.match(m, /function pickOp\(op\) \{\s*\n\s*const item = opsItems\.value\.find\(i => i\.key === op\)/)
})

test('群組按鈕拿掉「輸入邀請碼加入」（電腦與手機同一份）；提示不提邀請碼；加入別的群組照舊走「＋」', () => {
  assert.deepEqual(groupMenuItems({ room: true }).map(i => i.key), ['invite', 'addai', 'manage'])
  assert.equal(groupMenuItems({ room: true }).some(i => /邀請碼/.test(i.label)), false)
  const t = read('ui/lib/actionbar.mjs')
  const tip = t.match(/slot-key="group" label="群組" icon="img\/ab-group\.svg" tip="([^"]*)"/)[1]
  assert.doesNotMatch(tip, /邀請碼/)
  assert.ok(tip.length <= 20, tip)
  assert.doesNotMatch(read('ui/list.js'), /what === 'join'/, '對話上方不再有 join，名單的「＋」另有自己的入口')
  assert.doesNotMatch(read('ui/m.js'), /key === 'join' && f\.room/)
  assert.match(read('ui/m.js'), /pickPlus\('join'\)|op === 'join'\) groupFlow\.openJoin\(\)/, '手機「＋」的加入群組不動')
  assert.match(read('ui/list.html'), /groupFlow\.openJoin\(\)/, '電腦名單「＋」的加入群組不動')
})

test('開新夥伴型號下拉跟後端 launch_model_plan 同一個判斷：視窗只認 profile 明寫 engine "claude"；背景（內建通道）照記', () => {
  assert.equal(launchModelChoices('claude', 'term', { local: true, engine: 'claude' }).show, true)
  assert.equal(launchModelChoices('claude', 'term', { local: true, engine: '' }).show, false, '沒寫 engine 的自訂 profile：不出下拉')
  assert.equal(launchModelChoices('claude', 'term', { local: true }).show, false, '不知道 engine 也不出')
  assert.equal(launchModelChoices('claude', 'term', { local: true, engine: 'codex' }).show, false)
  assert.equal(launchModelChoices('gemini', 'acp', { local: true, engine: 'acp' }).show, true, '背景模式後端照記，不看 engine')
  assert.equal(launchModelChoices('gemini', 'acp', { local: true, engine: '' }).show, true)
  assert.equal(launchModelChoices('claude', 'term', { local: false, engine: 'claude' }).show, false, '別台電腦照舊不出')
  assert.deepEqual(launchModelChoices('claude', 'term', { local: true, engine: '' }).models, [])
})

test('本機 profile 的 engine：有回報就用回報的（含空字串）；沒回報退回內建設定（profiles.rs）的 engine；目錄外的當沒寫', () => {
  assert.equal(localProfileEngine('claude', { profiles: [{ id: 'claude', engine: 'claude' }] }), 'claude')
  assert.equal(localProfileEngine('claude', { profiles: [{ id: 'claude', engine: '' }] }), '')
  assert.equal(localProfileEngine('claude', { profiles: [{ id: 'claude' }] }), '', '回報裡沒有 engine＝沒寫')
  assert.equal(localProfileEngine('claude', null), 'claude', '這台沒開放遠端管理（沒回報）：內建 claude 設定')
  assert.equal(localProfileEngine('gemini', null), 'acp')
  assert.equal(localProfileEngine('codex', null), 'codex')
  assert.equal(localProfileEngine('my-custom', null), '')
  assert.equal(localProfileEngine('my-custom', { profiles: [{ id: 'claude', engine: 'claude' }] }), '')
  const list = read('ui/list.js')
  assert.match(list, /launchModelChoices\(dlgRow\.value\?\.id, partnerRunChoice\.value, \{ local: partnerDlg\.node === info\.node, engine: localProfileEngine\(partnerDlg\.profile, remoteLaunchers\.value\[info\.node\]\) \}\)/)
})
