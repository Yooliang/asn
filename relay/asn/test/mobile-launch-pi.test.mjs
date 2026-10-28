// 手機開新夥伴：運行四選一（D1 #421）與遠端經 pi 帶提供者和模型（D2 #422）
import test from 'node:test'
import assert from 'node:assert/strict'
import { PI_REMOTE_NO_LIST, PI_REMOTE_NO_PI, buildLaunchRequest, launchFormError, launchPiChoice, launchRun, launchVendors, pickedRun, remotePi } from '../ui/lib/mobile-launch.mjs'

const prof = ids => ids.map(id => ({ id, label: id }))
const L = { profiles: prof(['claude', 'grok', 'pi']), cwd_allow: ['D:\\x'], pi_models: [{ provider: 'anthropic', model: 'claude-sonnet-5' }, { provider: 'minimax', model: 'MiniMax-M3.1-Flash' }, { provider: 'minimax', model: 'MiniMax-M3' }] }
const NO_LIST = { profiles: prof(['claude', 'pi']), cwd_allow: ['D:\\x'] }
const NO_PI = { profiles: prof(['claude']), cwd_allow: ['D:\\x'], pi_models: L.pi_models }
const elig = { ok: true, reason: '' }
const f = (extra = {}) => ({ node: 'H', profile: 'claude', vendor: 'claude', run: '', piModel: '', cwd: 'D:\\x', name: '夥伴-2', first: '', ...extra })

test('廠牌清單：pi 不列成廠牌；那台 pi 列得到模型的「只能經 pi」廠牌才出現', () => {
  assert.deepEqual(launchVendors(L).map(v => v.id), ['claude', 'grok', 'minimax'])
  assert.equal(launchVendors(L).find(v => v.id === 'minimax').profileId, 'pi')
  assert.deepEqual(launchVendors(NO_LIST).map(v => v.id), ['claude'], '沒有清單：不出現只能經 pi 的廠牌')
  assert.deepEqual(remotePi(NO_PI), { installed: false, models: [] }, '那台沒有 pi 的啟動設定：清單不採用')
})

test('運行四選一：順序固定、原生 CLI 永遠不能選；經 pi 沒有清單或沒有 pi 時反灰並寫原因', () => {
  const claude = launchVendors(L).find(v => v.id === 'claude')
  const r = launchRun(claude, L)
  assert.deepEqual(r.options.map(o => o.key), ['acp', 'pi', 'term', 'self'])
  assert.equal(r.options.find(o => o.key === 'self').ok, false)
  assert.equal(r.options.find(o => o.key === 'pi').ok, true)
  assert.equal(r.selected, 'pi', '依優先序第一個能選的')
  const noList = launchRun(launchVendors(NO_LIST)[0], NO_LIST).options.find(o => o.key === 'pi')
  assert.deepEqual([noList.ok, noList.why], [false, PI_REMOTE_NO_LIST])
  const noPi = launchRun(launchVendors(NO_PI)[0], NO_PI).options.find(o => o.key === 'pi')
  assert.deepEqual([noPi.ok, noPi.why], [false, PI_REMOTE_NO_PI])
  assert.equal(launchRun(launchVendors(NO_LIST)[0], NO_LIST).selected, 'term', '沒有清單：照舊開成視窗')
  const grokTerm = launchRun(launchVendors(L).find(v => v.id === 'grok'), L).options.find(o => o.key === 'term')
  assert.deepEqual([grokTerm.ok, grokTerm.why], [false, '只能在那台電腦上開'], 'ASN 自帶終端只能在那台開')
  assert.equal(pickedRun(r, 'term'), 'term')
  assert.equal(pickedRun(r, 'self'), 'pi', '不能選的不採用')
  assert.deepEqual(launchRun(null, L), { options: [], selected: null })
})

test('送出內容：經 pi 帶清單裡的提供者與模型，profile 一律 pi；清單外的不送；其他開法照舊不帶 pi 欄位', () => {
  const claude = launchVendors(L).find(v => v.id === 'claude')
  const minimax = launchVendors(L).find(v => v.id === 'minimax')
  assert.deepEqual(buildLaunchRequest(f(), { run: 'pi', row: claude, launcher: L }), { node: 'H', name: '夥伴-2', cwd: 'D:\\x', first_message: null, profile: 'pi', pi_provider: 'anthropic', pi_model: 'claude-sonnet-5' })
  assert.equal(buildLaunchRequest(f({ vendor: 'minimax', profile: 'pi', piModel: 'MiniMax-M3' }), { run: 'pi', row: minimax, launcher: L }).pi_model, 'MiniMax-M3')
  assert.equal(buildLaunchRequest(f({ piModel: 'MiniMax-M3' }), { run: 'pi', row: claude, launcher: L }), null, '別家的模型不送')
  assert.equal(buildLaunchRequest(f(), { run: 'pi', row: claude, launcher: NO_LIST }), null, '沒有清單不送')
  const term = buildLaunchRequest(f(), { run: 'term', row: claude, launcher: L })
  assert.equal(term.profile, 'claude')
  assert.ok(!('pi_provider' in term) && !('pi_model' in term), '不是經 pi：跟舊版一樣不帶')
  assert.equal(launchPiChoice(claude, L).defaultModel, 'claude-sonnet-5')
})

test('送出前檢查：沒有能用的開法、經 pi 沒選到清單裡的模型都擋下', () => {
  assert.equal(launchFormError(f(), elig, { run: 'pi', piOk: true }), '')
  assert.match(launchFormError(f(), elig, { run: null }), /沒有能用的開法/)
  assert.match(launchFormError(f(), elig, { run: 'pi', piOk: false }), /經 pi 的模型/)
  assert.equal(launchFormError(f(), elig), '', '舊的呼叫方式照常')
})
