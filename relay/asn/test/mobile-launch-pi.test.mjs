// 手機開新夥伴：自動開法（#2354，原本的運行四選一 D1 #421 拿掉了）與遠端經 pi 帶提供者和模型（D2 #422）
import test from 'node:test'
import assert from 'node:assert/strict'
import { PI_ONLY_CHANNELS, PI_REMOTE_NO_LIST, PI_REMOTE_NO_PI, buildLaunchRequest, launchFormError, launchPiChoice, launchVendors, remotePi } from '../ui/lib/mobile-launch.mjs'
import { autoRunFor } from '../ui/lib/auto-run.mjs'

// 手機畫面用的自動開法（m.js 的 lchAuto）：那台有沒有 pi、pi 能不能帶這家的模型
const autoOf = (row, launcher) => { const pc = launchPiChoice(row, launcher); return autoRunFor(row, { local: false, piInstalled: remotePi(launcher).installed, piReady: pc.ok, piWhy: pc.why }) }

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

test('自動開法：Claude 用終端（那台 pi 有清單也不改經 pi）、Grok 用背景通道、只能經 pi 的廠牌用 pi；沒清單或沒有 pi 時不能開並寫原因', () => {
  const claude = launchVendors(L).find(v => v.id === 'claude')
  assert.deepEqual(autoOf(claude, L), { run: 'term', profile: 'claude', ok: true, why: '' }, 'asn終端優先：那台 pi 有清單也不預設經 pi（#931）')
  assert.deepEqual(autoOf(launchVendors(NO_LIST)[0], NO_LIST).run, 'term', '沒有清單：照舊開成視窗')
  const grok = autoOf(launchVendors(L).find(v => v.id === 'grok'), L)
  assert.deepEqual([grok.run, grok.profile, grok.ok], ['acp', 'grok', true], 'Grok 一律背景通道（ASN 自帶終端收不到信，不再當開法）')
  const mm = autoOf(launchVendors(L).find(v => v.id === 'minimax'), L)
  assert.deepEqual([mm.run, mm.profile, mm.ok], ['pi', 'pi', true])
  // 只能經 pi 的廠牌：那台沒有清單、沒有 pi 時不能開，原因寫給使用者
  const noListRow = { id: 'minimax', label: 'MiniMax', viaPiOnly: true, profileId: 'pi', toolId: 'pi', mode: 'window', channels: PI_ONLY_CHANNELS }
  const noList = autoOf(noListRow, NO_LIST)
  assert.deepEqual([noList.run, noList.ok, noList.why], ['pi', false, PI_REMOTE_NO_LIST])
  const noPi = autoOf(noListRow, NO_PI)
  assert.deepEqual([noPi.run, noPi.ok, noPi.why], ['pi', false, PI_REMOTE_NO_PI])
  assert.deepEqual(autoRunFor(null), { run: null, profile: '', ok: false, why: '' })
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

test('送出內容與 Rust 共用樣本相同（#2386：Rust 的 build_launch_body 讀同一份，證明 pi 欄位到得了後台）', async () => {
  const { readFileSync } = await import('node:fs')
  const sample = JSON.parse(readFileSync(new URL('../../shared/test-vectors/mobile-launch-pi-request.json', import.meta.url), 'utf8')).request
  const claude = launchVendors(L).find(v => v.id === 'claude')
  assert.deepEqual(buildLaunchRequest(f({ first: ' 開始吧 ' }), { run: 'pi', row: claude, launcher: L }), sample)
})

test('送出前檢查：沒有能用的開法、經 pi 沒選到清單裡的模型都擋下', () => {
  assert.equal(launchFormError(f(), elig, { run: 'pi', piOk: true }), '')
  assert.match(launchFormError(f(), elig, { run: null }), /沒有能用的開法/)
  assert.match(launchFormError(f(), elig, { run: 'pi', piOk: false }), /pi 的模型/)
  assert.equal(launchFormError(f(), elig), '', '舊的呼叫方式照常')
})

test('舊版電腦提醒與開好時寫出實際模型（asn真 審 #471）', async () => {
  const { PI_REMOTE_VERSION_NOTE, appearedModel, progressView } = await import('../ui/lib/mobile-launch.mjs')
  assert.match(PI_REMOTE_VERSION_NOTE, /預設模型/)
  assert.doesNotMatch(PI_REMOTE_VERSION_NOTE, /\d+\.\d+\.\d+/, '畫面上不寫版本號')
  const friends = [{ node: 'H', agent: '小皮', status: 'online', model: 'minimax/MiniMax-M3' }, { node: 'H', agent: '舊的', status: 'offline', model: 'x' }]
  assert.equal(appearedModel(friends, 'H', '小皮'), 'minimax/MiniMax-M3')
  assert.equal(appearedModel(friends, 'H', '舊的'), '', '離線的不算')
  assert.equal(progressView(null, true, '小皮', 'minimax/MiniMax-M3').text, '「小皮」已經開好了（型號：minimax/MiniMax-M3），可以直接對話。')
  assert.equal(progressView(null, true, '小皮').text, '「小皮」已經開好了，可以直接對話。', '沒回報模型：照舊')
  const fs = await import('node:fs')
  const m = fs.readFileSync(new URL('../ui/m.html', import.meta.url), 'utf8')
  const l = fs.readFileSync(new URL('../ui/list.html', import.meta.url), 'utf8')
  assert.ok(m.includes(`<p class="m-note" v-if="lchAuto.run === 'pi' && lchPi.ok">{{ PI_REMOTE_VERSION_NOTE }}</p>`), '手機：選經 pi 時寫提醒')
  assert.ok(l.includes('dlgRemote">{{ PI_REMOTE_VERSION_NOTE }}</p>'), '電腦版替別台開也寫')
})
