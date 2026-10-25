// 手機版「幫電腦開新夥伴」的純邏輯：能不能開、為什麼不能、送出前的檢查、請求內容、錯誤與進度的中文。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LAUNCH_GIVE_UP_MS, REASON, appearedIn, buildLaunchRequest, initialLaunch, launchChoices, launchDevices, launchEligibility, launchErrorText, launchFormError, machinesByNode, progressView } from '../ui/lib/mobile-launch.mjs'

const LAUNCHER = { profiles: [{ id: 'claude', label: 'Claude' }, { id: 'gemini', label: 'Gemini' }], cwd_allow: ['D:\\Github\\asn', 'D:\\Github\\irori'], max_per_hour: 6 }
const BODY = { machines: [{ node: 'H', name: '小良的家用機', launcher: LAUNCHER, online: true }, { node: 'W', name: '公司', launcher: LAUNCHER, online: false }, { node: 'C', name: '關著的', launcher: null, online: true }, { node: 'E', launcher: { profiles: [], cwd_allow: ['x'] }, online: true }, { node: 'D', launcher: { profiles: [{ id: 'claude' }], cwd_allow: [] }, online: true }] }
const ctx = { machines: machinesByNode(BODY), loaded: true, signedIn: true, friends: [] }
const F = (node, nick, status = 'online') => ({ id: `${node}/${nick}`, node, agent: nick, nick, status, device: `設備${node}` })

test('電腦能不能開：在線、有開放遠端開視窗、有模型、有資料夾；不能就給中文原因', () => {
  assert.deepEqual(launchEligibility('H', ctx), { ok: true, reason: '' })
  assert.equal(launchEligibility('W', ctx).reason, REASON.offline)
  assert.equal(launchEligibility('C', ctx).reason, REASON.closed)
  assert.equal(launchEligibility('E', ctx).reason, REASON.noModel)
  assert.equal(launchEligibility('D', ctx).reason, REASON.noCwd)
  assert.equal(launchEligibility('Z', { ...ctx, friends: [F('Z', 'a')] }).reason, REASON.closed, '名單上有、在線，但後台沒有它的啟動設定＝沒開放')
  assert.equal(launchEligibility('Z', { ...ctx, friends: [F('Z', 'a', 'offline')] }).reason, REASON.offline)
  for (const r of Object.values(REASON)) assert.ok(!/[A-Za-z]{4,}/.test(r), `純中文：${r}`)
})

test('沒有本人簽章（沒登入）或還沒查到設定：一律不能開', () => {
  assert.deepEqual(launchEligibility('H', { ...ctx, signedIn: false }), { ok: false, reason: REASON.needLogin })
  assert.deepEqual(launchEligibility('H', { ...ctx, loaded: false }), { ok: false, reason: REASON.unknown })
})

test('可選的電腦：不含手機自己；照名單順序；不能開的列原因', () => {
  const fl = [F('W', 'a'), F('H', 'b'), F('P', 'phone'), F('C', 'c')]
  const rows = launchDevices(fl, { selfNode: 'P', nodeOrder: ['H', 'W', 'C'], ...ctx })
  assert.deepEqual(rows.map(r => [r.key, r.ok]), [['H', true], ['W', false], ['C', false]])
  assert.equal(rows[0].label, '設備H'); assert.equal(rows[1].reason, REASON.offline)
})

test('選項：模型與資料夾用電腦回報的設定', () => {
  const c = launchChoices(ctx.machines.H)
  assert.deepEqual(c.models.map(m => [m.profileId, m.label]), [['claude', 'Claude'], ['gemini', 'Gemini']])
  assert.deepEqual(c.cwds, LAUNCHER.cwd_allow)
  assert.deepEqual(launchChoices(null), { models: [], cwds: [] })
})

test('送出前檢查：不能開的電腦、缺欄位、名字格式、第一句話長度都擋下；通過才有請求，且只有五個欄位', () => {
  const ok = { ...initialLaunch(), node: 'H', profile: 'claude', cwd: 'D:\\Github\\asn', name: ' 夥伴-2 ', first: ' 開始 ' }
  const elig = launchEligibility('H', ctx)
  assert.equal(launchFormError(ok, elig), '')
  assert.deepEqual(buildLaunchRequest(ok), { node: 'H', profile: 'claude', cwd: 'D:\\Github\\asn', name: '夥伴-2', first_message: '開始' })
  assert.equal(buildLaunchRequest({ ...ok, first: '  ' }).first_message, null)
  assert.equal(launchFormError({ ...ok, node: 'W' }, launchEligibility('W', ctx)), REASON.offline, '不在線不送出')
  assert.equal(launchFormError({ ...ok, node: 'C' }, launchEligibility('C', ctx)), REASON.closed, '未開放不送出')
  assert.equal(launchFormError(ok, launchEligibility('H', { ...ctx, signedIn: false })), REASON.needLogin, '沒登入不送出')
  assert.match(launchFormError({ ...ok, node: '' }, elig), /選一台電腦/)
  assert.match(launchFormError({ ...ok, profile: '' }, elig), /模型/)
  assert.match(launchFormError({ ...ok, cwd: '' }, elig), /資料夾/)
  for (const bad of ['', '-rf', 'a b', 'a;b', 'x'.repeat(41)]) assert.match(launchFormError({ ...ok, name: bad }, elig), /名字/, bad)
  assert.match(launchFormError({ ...ok, first: 'x'.repeat(4001) }, elig), /4000/)
})

test('錯誤翻成中文：後台代碼、沒登入、斷線；看不懂的給通用句，不洩漏英文', () => {
  assert.match(launchErrorText('launch HTTP 403 forbidden'), /本人/)
  assert.match(launchErrorText('launch HTTP 409 name_taken'), /同名/)
  assert.match(launchErrorText('launch HTTP 409 no_launcher'), /沒有開放/)
  assert.match(launchErrorText('launch HTTP 429 rate_limited'), /開太多/)
  assert.match(launchErrorText('launch HTTP 400 bad_cwd'), /資料夾/)
  assert.equal(launchErrorText('尚未登入，無法替電腦開新夥伴'), REASON.needLogin)
  assert.match(launchErrorText('launch 連線失敗：error sending request'), /連不上/)
  assert.equal(launchErrorText('名字只能用英數、連字號、中文，1～40 字，不能以連字號開頭'), '名字只能用英數、連字號、中文，1～40 字，不能以連字號開頭')
  assert.equal(launchErrorText('launch HTTP 500 weird'), '送出失敗，請稍後再試')
  assert.equal(launchErrorText(undefined), '送出失敗，請稍後再試')
})

test('進度：送出→接手→開視窗→出現在名單；失敗顯示原因；出現在名單就算成功', () => {
  assert.equal(progressView({ status: 'pending' }, false).phase, 'sending')
  assert.equal(progressView({ status: 'taken' }, false).phase, 'opening')
  assert.equal(progressView({ status: 'ok' }, false).phase, 'waiting')
  assert.equal(progressView({ status: 'unconfirmed' }, false).phase, 'waiting')
  const f = progressView({ status: 'failed', detail: '機器橋 2 分鐘內沒有取走（電腦可能沒開或橋沒在跑）' }, false)
  assert.equal(f.phase, 'failed'); assert.match(f.text, /沒有取走/)
  assert.match(progressView({ status: 'failed' }, false).text, /沒有說明原因/)
  const d = progressView({ status: 'ok' }, true, '夥伴-2')
  assert.equal(d.phase, 'done'); assert.match(d.text, /夥伴-2/)
  assert.equal(progressView(undefined, false).phase, 'sending')
  assert.ok(LAUNCH_GIVE_UP_MS >= 2 * 60 * 1000)
  const fl = [F('H', '夥伴-2'), F('H', '另一個', 'offline'), { ...F('H', '夥伴-3'), pending: true }]
  assert.equal(appearedIn(fl, 'H', '夥伴-2'), true); assert.equal(appearedIn(fl, 'H', '另一個'), false); assert.equal(appearedIn(fl, 'H', '夥伴-3'), false); assert.equal(appearedIn(fl, 'W', '夥伴-2'), false)
})

test('新版清單：Grok、Gemini 背景與 pi 視窗都列得出來，模型列帶名稱與模式；舊版清單（只有 id 與標籤）照常顯示', () => {
  const neu = { profiles: [
    { id: 'claude', label: 'Claude（互動視窗）', engine: 'claude', mode: 'window' },
    { id: 'gemini', label: 'Gemini（背景運行、內建通道）', engine: 'acp', mode: 'background' },
    { id: 'grok', label: 'Grok（背景運行、內建通道）', engine: 'acp', mode: 'background' },
    { id: 'pi', label: 'pi（互動視窗）', engine: 'pi', mode: 'window' },
  ], cwd_allow: ['D:\\a'], max_per_hour: 6 }
  const m = launchChoices({ launcher: neu }).models
  assert.deepEqual(m.map(r => [r.profileId, r.label, r.mode]), [['claude', 'Claude（互動視窗）', 'window'], ['gemini', 'Gemini（背景運行、內建通道）', 'background'], ['grok', 'Grok（背景運行、內建通道）', 'background'], ['pi', 'pi（互動視窗）', 'window']])
  const c = { ...ctx, machines: machinesByNode({ machines: [{ node: 'H', launcher: neu, online: true }] }) }
  assert.deepEqual(launchEligibility('H', c), { ok: true, reason: '' })
  const ok = { node: 'H', profile: 'grok', cwd: 'D:\\a', name: '小格', first: '' }
  assert.equal(launchFormError(ok, launchEligibility('H', c)), '')
  assert.deepEqual(buildLaunchRequest(ok), { node: 'H', profile: 'grok', name: '小格', cwd: 'D:\\a', first_message: null }, '請求只有四個欄位，不帶指令')
  // 舊版回報（沒有 engine／mode）：同一份程式照常讀
  assert.deepEqual(launchChoices(BODY.machines[0]).models.map(r => r.profileId), ['claude', 'gemini'])
})

test('失敗與進度的文字是純中文、沒有「收發室」，並講下一步', () => {
  for (const t of [...Object.values(REASON), launchErrorText('launch HTTP 500 internal'), launchErrorText('連線失敗：x'), launchErrorText('launch HTTP 400 bad_profile')]) assert.doesNotMatch(t, /收發室/)
  assert.match(REASON.closed, /設定/)
  const p = progressView({ status: 'failed', detail: '開不起來：這台電腦找不到「grok」的執行檔（grok.exe），請先安裝後再試' }, false)
  assert.equal(p.phase, 'failed'); assert.match(p.text, /請先安裝/)
  assert.match(progressView({ status: 'unconfirmed', detail: '背景夥伴已排入' }, false).text, /名單/)
  assert.equal(progressView({ status: 'ok' }, true, '小格').phase, 'done')
})
