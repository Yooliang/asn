// 開新夥伴「每個廠牌自動用最好的開法」（#2354）：autoRunFor 對照表、各廠牌實際送出的內容、廠牌卡標示的判斷規則、背景夥伴沒有看畫面入口
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { MODEL_CATALOG } from '../ui/lib/model-catalog.mjs'
import { AUTO_RUN, BADGE_TEXT, autoRunFor, launchBadge, loggedOutFromCli, loggedOutFromStates, localLaunchRequest, vendorCards, vendorStatesOf } from '../ui/lib/auto-run.mjs'
import { PI_ONLY_CHANNELS, buildLaunchRequest, launchPiChoice, launchVendorCards, remotePi } from '../ui/lib/mobile-launch.mjs'
import { PI_ONLY_VENDORS, piLaunchArgs, piVendorState } from '../ui/lib/pi-models.mjs'
import { STATE } from '../ui/lib/device-state.mjs'
import { isBackgroundPartner } from '../ui/lib/partner-ops.mjs'
import { modelUiRow } from '../ui/lib/partner.mjs'

const read = f => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8')
const cat = id => MODEL_CATALOG.find(m => m.id === id)
const piOnly = id => ({ ...PI_ONLY_VENDORS.find(v => v.id === id), viaPiOnly: true, profileId: 'pi', toolId: 'pi', mode: 'window', channels: PI_ONLY_CHANNELS })
const PI_MODELS = [{ provider: 'anthropic', model: 'claude-sonnet-5' }, { provider: 'deepseek', model: 'deepseek-v4' }, { provider: 'minimax', model: 'MiniMax-M3' }]
const prof = ids => ids.map(id => ({ id }))

test('autoRunFor 對照表：Claude、Codex 用終端；Gemini、Grok 用背景通道；只能經 pi 的廠牌（DeepSeek、MiniMax）用 pi', () => {
  assert.deepEqual(AUTO_RUN, { claude: 'term', codex: 'term', gemini: 'acp', grok: 'acp' })
  const table = [['claude', 'term', 'claude'], ['codex', 'term', 'codex'], ['gemini', 'acp', 'gemini'], ['grok', 'acp', 'grok']]
  for (const local of [true, false]) {
    for (const piInstalled of [true, false]) {
      for (const [id, run, profile] of table) {
        const r = autoRunFor(cat(id), { local, piInstalled, piReady: piInstalled })
        assert.deepEqual([r.run, r.profile, r.ok, r.why], [run, profile, true, ''], `${id} local=${local} pi=${piInstalled}`)
      }
    }
  }
  for (const id of ['deepseek', 'minimax']) {
    const ready = autoRunFor(piOnly(id), { local: true, piInstalled: true, piReady: true })
    assert.deepEqual([ready.run, ready.profile, ready.ok], ['pi', 'pi', true], id)
    const notReady = autoRunFor(piOnly(id), { local: true, piInstalled: true, piReady: false, piWhy: 'pi 還沒登入 deepseek：先在終端開 pi 打 /login' })
    assert.deepEqual([notReady.run, notReady.ok, notReady.why], ['pi', false, 'pi 還沒登入 deepseek：先在終端開 pi 打 /login'], `${id} 不能開時用 pi 自己給的原因`)
    assert.equal(autoRunFor(piOnly(id), { local: true, piInstalled: false }).ok, false, `${id} 沒有 pi`)
  }
  // 目錄外的自訂設定：照那台回報的 mode
  assert.deepEqual(autoRunFor({ id: 'my-tool', profileId: 'my-tool', mode: 'background' }), { run: 'acp', profile: 'my-tool', ok: true, why: '' })
  assert.deepEqual(autoRunFor({ id: 'my-tool', profileId: 'my-tool', mode: 'window' }), { run: 'term', profile: 'my-tool', ok: true, why: '' })
  assert.deepEqual(autoRunFor(null), { run: null, profile: '', ok: false, why: '' })
})

test('Gemini、Grok 永遠不是 term（收不到信），不管本機、遠端、有沒有 pi', () => {
  for (const id of ['gemini', 'grok']) for (const ctx of [{ local: true }, { local: false }, { local: true, piInstalled: true, piReady: true }]) assert.equal(autoRunFor(cat(id), ctx).run, 'acp', id)
})

test('每個廠牌「電腦版開在這台」實際送出的內容（localLaunchRequest）', () => {
  const form = { name: ' 夥伴-1 ', cwd: 'D:/work', display: 'background', firstMessage: ' 你好 ' }
  const ctx = id => ({ local: true, piInstalled: true, piReady: true, ...(id ? {} : {}) })
  // Claude：視窗，帶顯示方式；第一句話不經後端（開好後畫面補送）；有選型號才帶 model
  assert.deepEqual(localLaunchRequest(autoRunFor(cat('claude'), ctx()), form), { profile: 'claude', name: '夥伴-1', cwd: 'D:/work', display: 'background', first_message: '' })
  assert.deepEqual(localLaunchRequest(autoRunFor(cat('claude'), ctx()), { ...form, model: 'opus' }), { profile: 'claude', name: '夥伴-1', cwd: 'D:/work', display: 'background', first_message: '', model: 'opus' })
  assert.equal(localLaunchRequest(autoRunFor(cat('codex'), ctx()), form).profile, 'codex')
  // Gemini、Grok：背景通道，profile 是自己的（不是 gemini-term／grok-term，也不是 agy），沒有 pi 欄位
  for (const id of ['gemini', 'grok']) {
    const req = localLaunchRequest(autoRunFor(cat(id), ctx()), form)
    assert.equal(req.profile, id)
    assert.ok(!('pi_provider' in req) && !('pi_model' in req) && !('run' in req), id)
  }
  assert.deepEqual(localLaunchRequest(autoRunFor(cat('gemini'), ctx()), { ...form, model: 'gemini-4-argon-high' }).model, 'gemini-4-argon-high')
  // DeepSeek、MiniMax：profile 一律 pi，只能前台，帶驗過的提供者與模型
  for (const [id, provider, model] of [['deepseek', 'deepseek', 'deepseek-v4'], ['minimax', 'minimax', 'MiniMax-M3']]) {
    const viaPi = piLaunchArgs(id, model, PI_MODELS)
    assert.deepEqual(localLaunchRequest(autoRunFor(piOnly(id), ctx()), { ...form, viaPi }), { profile: 'pi', name: '夥伴-1', cwd: 'D:/work', display: 'foreground', first_message: '你好', pi_provider: provider, pi_model: model }, id)
  }
  assert.equal(localLaunchRequest(autoRunFor(piOnly('minimax'), ctx()), form), null, '清單外的模型不送')
})

test('每個廠牌「開在別台」實際送出的內容（buildLaunchRequest，手機與電腦版同一份）：沒有 -term、Codex 不列', () => {
  const launcher = { profiles: [...prof(['claude', 'gemini', 'grok', 'pi']), { id: 'gemini-term', mode: 'term' }, { id: 'grok-term', mode: 'term' }], cwd_allow: ['D:/work'], pi_models: PI_MODELS }
  const cards = launchVendorCards(launcher)
  assert.deepEqual(cards.map(c => c.id), ['claude', 'gemini', 'grok', 'deepseek', 'minimax'], '順序：目錄順序、最後是只能經 pi 的；Codex 遠端不列')
  const f = { node: 'H', name: ' n1 ', cwd: 'D:/work', first: '', profile: '', piModel: '' }
  const send = row => { const a = autoRunFor(row, { local: false, piInstalled: remotePi(launcher).installed, piReady: launchPiChoice(row, launcher).ok }); return buildLaunchRequest({ ...f, profile: row.profileId }, { run: a.run, row, launcher }) }
  const by = id => cards.find(c => c.id === id)
  assert.deepEqual(send(by('claude')), { node: 'H', name: 'n1', cwd: 'D:/work', first_message: null, profile: 'claude' })
  assert.equal(send(by('gemini')).profile, 'gemini')
  assert.equal(send(by('grok')).profile, 'grok')
  assert.deepEqual(send(by('deepseek')), { node: 'H', name: 'n1', cwd: 'D:/work', first_message: null, profile: 'pi', pi_provider: 'deepseek', pi_model: 'deepseek-v4' })
  assert.deepEqual(send(by('minimax')), { node: 'H', name: 'n1', cwd: 'D:/work', first_message: null, profile: 'pi', pi_provider: 'minimax', pi_model: 'MiniMax-M3' })
  for (const c of cards) assert.ok(!/-term$/.test(send(c)?.profile ?? ''), `${c.id} 不送 -term`)
  // 就算那台回報了 codex，遠端也不列（後端擋）
  assert.ok(!launchVendorCards({ ...launcher, profiles: [...launcher.profiles, { id: 'codex' }] }).some(c => c.id === 'codex'))
})

test('廠牌卡標示的判斷規則：尚未安裝 ＞ 尚未登入 ＞ 無終端畫面；只有尚未安裝反灰不能選，尚未登入只標字樣、照樣能選；自訂設定不加標示', () => {
  assert.deepEqual(BADGE_TEXT, { missing: '尚未安裝', loggedOut: '尚未登入', noTerm: '無終端畫面' })
  const gemini = { ...cat('gemini'), installed: true }, grok = { ...cat('grok'), installed: true }
  assert.deepEqual(launchBadge(gemini), { text: '無終端畫面', disabled: false, kind: 'noTerm' })
  assert.deepEqual(launchBadge(grok), { text: '無終端畫面', disabled: false, kind: 'noTerm' })
  assert.deepEqual(launchBadge({ ...cat('claude'), installed: true }), { text: '', disabled: false, kind: '' })
  assert.deepEqual(launchBadge({ ...cat('codex'), installed: true }), { text: '', disabled: false, kind: '' })
  // 優先序
  assert.deepEqual(launchBadge({ ...grok, installed: false }, { loggedOut: true }), { text: '尚未安裝', disabled: true, kind: 'missing' }, '沒裝＞沒登入')
  assert.deepEqual(launchBadge({ ...grok, installed: false }), { text: '尚未安裝', disabled: true, kind: 'missing' }, '沒裝＞無終端畫面')
  assert.deepEqual(launchBadge(grok, { loggedOut: true }), { text: '尚未登入', disabled: false, kind: 'loggedOut' }, '沒登入＞無終端畫面；只標字、不反灰（偵測可能是快取）')
  // 自訂設定（沒有 channels）：不加標示，背景的也不標
  assert.deepEqual(launchBadge({ id: 'my', mode: 'background', installed: true }), { text: '', disabled: false, kind: '' })
  const cards = vendorCards([{ ...cat('claude'), installed: true }, { ...grok, installed: false }, { ...cat('codex'), installed: true }], { loggedOut: { codex: true } })
  assert.deepEqual(cards.map(c => [c.id, c.badge.text, c.disabled]), [['claude', '', false], ['grok', '尚未安裝', true], ['codex', '尚未登入', false]])
})

test('「尚未登入」只在確定的時候標：Gemini 偵測不到永遠不標；沒收到回報、回報過期、登入失效、不確定都不標', () => {
  const states = { claude: STATE.LOGGED_IN, codex: STATE.INSTALLED_LOGGED_OUT, grok: STATE.LOGGED_OUT, gemini: STATE.LOGGED_OUT }
  assert.deepEqual(loggedOutFromStates(states), { codex: true, grok: true }, 'Gemini 就算狀態寫沒登入也不標')
  for (const s of [STATE.NO_REPORT, STATE.LOGIN_FAILED, STATE.UNKNOWN_INSTALL, STATE.NOT_INSTALLED, STATE.LOGGED_IN, undefined]) assert.deepEqual(loggedOutFromStates({ claude: s, codex: s, grok: s }), {}, String(s))
  assert.deepEqual(loggedOutFromStates(null), {})
  assert.deepEqual(loggedOutFromStates({ grok: STATE.LOGGED_OUT }, ['grok']), { grok: true })
  // 本機偵測（ai_cli_status）：只認 claude、codex 的 out；unknown 與 Gemini（agy）不標
  assert.deepEqual(loggedOutFromCli({ claude: { login: 'out' }, codex: { login: 'in' }, agy: { login: 'out' }, grok: { login: 'out' } }), { claude: true })
  assert.deepEqual(loggedOutFromCli({ claude: { login: 'unknown' }, codex: { login: 'unknown' } }), {})
  assert.deepEqual(loggedOutFromCli(null), {})
  assert.deepEqual(vendorStatesOf({ vendors: [{ key: 'claude', state: STATE.LOGGED_IN }, { key: 'grok', state: STATE.LOGGED_OUT }, null] }), { claude: STATE.LOGGED_IN, grok: STATE.LOGGED_OUT })
  assert.deepEqual(vendorStatesOf(undefined), {})
})

test('選了「尚未登入」的廠牌：卡片能選，別台、本機送出的參數都照常（只標字樣、不擋人）', () => {
  const launcher = { profiles: prof(['claude', 'gemini', 'grok']), cwd_allow: ['D:/work'] }
  const out = loggedOutFromStates({ claude: STATE.LOGGED_OUT, grok: STATE.INSTALLED_LOGGED_OUT })
  const cards = launchVendorCards(launcher, { loggedOut: out })
  const claude = cards.find(c => c.id === 'claude'), grok = cards.find(c => c.id === 'grok')
  assert.deepEqual([claude.badge.text, claude.disabled, grok.badge.text, grok.disabled], ['尚未登入', false, '尚未登入', false], '兩張都標尚未登入、都沒反灰')
  // 手機選卡的閘門（pickLaunchVendor）只看 disabled：這兩張都過得去
  assert.equal(cards.filter(c => !c.disabled && c.badge.text === '尚未登入').length, 2)
  // 別台：送出的內容跟已登入的一樣
  const f = { node: 'n1', name: ' helper ', cwd: 'D:/work', first: '', piModel: '' }
  const remote = row => { const a = autoRunFor(row, { local: false }); return [a.ok, buildLaunchRequest({ ...f, profile: row.profileId }, { run: a.run, row, launcher })] }
  assert.deepEqual(remote(claude), [true, { node: 'n1', name: 'helper', cwd: 'D:/work', first_message: null, profile: 'claude' }])
  assert.deepEqual(remote(grok), [true, { node: 'n1', name: 'helper', cwd: 'D:/work', first_message: null, profile: 'grok' }])
  // 本機（電腦版）：同樣能送
  const la = autoRunFor(claude, { local: true })
  assert.equal(la.ok, true)
  assert.deepEqual(localLaunchRequest(la, { name: ' helper ', cwd: 'D:/work' }), { profile: 'claude', name: 'helper', cwd: 'D:/work', display: 'foreground', first_message: '' })
  // 電腦版選卡（pickPartnerModel）只看 m.disabled；手機也是
  assert.match(read('ui/list.js'), /function pickPartnerModel\(m\) \{\s+if \(m\.disabled\) return/)
  assert.match(read('ui/m.js'), /function pickLaunchVendor\(v\) \{ if \(v\.disabled\) return;/)
})

test('別台的廠牌卡：那台沒有的標尚未安裝（反灰）；只能經 pi 的廠牌永遠列出，沒有 pi＝尚未安裝、pi 沒登入這家＝尚未登入', () => {
  const brief = cards => cards.map(c => [c.id, c.badge.text, c.disabled])
  // 只有 Claude：其餘都尚未安裝，DeepSeek、MiniMax 也是（沒有 pi）
  assert.deepEqual(brief(launchVendorCards({ profiles: prof(['claude']), cwd_allow: ['D:/work'] })), [['claude', '', false], ['gemini', '尚未安裝', true], ['grok', '尚未安裝', true], ['deepseek', '尚未安裝', true], ['minimax', '尚未安裝', true]])
  // 有 pi 與模型清單：清單裡只有 minimax → deepseek 尚未登入（反灰）、minimax 可選
  const L = { profiles: prof(['claude', 'gemini', 'pi']), cwd_allow: ['D:/work'], pi_models: [{ provider: 'minimax', model: 'MiniMax-M3' }] }
  assert.deepEqual(brief(launchVendorCards(L)), [['claude', '', false], ['gemini', '無終端畫面', false], ['grok', '尚未安裝', true], ['deepseek', '尚未登入', false], ['minimax', '', false]])
  // 有 pi 但那台沒回報模型清單（沒開放遠端管理）：不知道有沒有登入，不標、不反灰（開的時候再說明原因）
  const noList = launchVendorCards({ profiles: prof(['claude', 'pi']), cwd_allow: ['D:/work'] })
  assert.deepEqual(brief(noList).slice(-2), [['deepseek', '', false], ['minimax', '', false]])
  // 帳號回報確定 Grok、Claude 沒登入：標尚未登入；回報裡的 Gemini 不標
  const out = loggedOutFromStates({ claude: STATE.LOGGED_OUT, grok: STATE.INSTALLED_LOGGED_OUT, gemini: STATE.LOGGED_OUT })
  assert.deepEqual(brief(launchVendorCards({ profiles: prof(['claude', 'gemini', 'grok']), cwd_allow: ['D:/work'] }, { loggedOut: out })).slice(0, 3), [['claude', '尚未登入', false], ['gemini', '無終端畫面', false], ['grok', '尚未登入', false]])
  // 目錄外的自訂設定：照回報列出、不加標示
  const custom = launchVendorCards({ profiles: [...prof(['claude']), { id: 'my-tool', mode: 'background' }], cwd_allow: ['D:/work'] }).find(c => c.id === 'my-tool')
  assert.deepEqual([custom.badge.text, custom.disabled, custom.installed], ['', false, true])
})

test('本機：pi 的狀態判斷（piVendorState）：沒查到不標；這版 pi 沒有這家＝尚未安裝；pi 有但沒登入＝尚未登入', () => {
  assert.deepEqual(piVendorState('deepseek', [], {}, { known: false }), { missing: false, loggedOut: false })
  assert.deepEqual(piVendorState('deepseek', [], {}, { known: true }), { missing: false, loggedOut: true })
  assert.deepEqual(piVendorState('deepseek', PI_MODELS, { deepseek: 'ready' }, { known: true }), { missing: false, loggedOut: false })
  assert.deepEqual(piVendorState('deepseek', PI_MODELS, { deepseek: 'provider_not_found' }, { known: true }), { missing: true, loggedOut: false })
  assert.deepEqual(piVendorState('minimax', PI_MODELS.filter(m => m.provider !== 'minimax'), { minimax: 'not_ready' }, { known: true }), { missing: false, loggedOut: true })
})

test('本機廠牌列：沒偵測到 CLI＝尚未安裝（反灰），偵測到就可選', () => {
  const rows = MODEL_CATALOG.filter(m => !m.channelOnly).map(m => modelUiRow(m, m.id === 'claude' ? { binary_found: true } : undefined))
  const cards = vendorCards(rows)
  assert.deepEqual(cards.map(c => [c.id, c.badge.text, c.disabled]), [['claude', '', false], ['codex', '尚未安裝', true], ['gemini', '尚未安裝', true], ['grok', '尚未安裝', true]])
})

test('背景夥伴（Gemini、Grok 的內建通道）沒有看畫面入口；終端夥伴照舊有', () => {
  for (const engine of ['gemini', 'agy', 'antigravity', 'acp', 'grok', 'Gemini', ' GROK ']) assert.equal(isBackgroundPartner({ engine, kind: '' }), true, engine)
  for (const engine of ['claude', '', null, undefined, 'pi', 'codex']) assert.equal(isBackgroundPartner({ engine }), false, String(engine))
  assert.equal(isBackgroundPartner({}), false, '名單沒寫引擎（舊資料）當 Claude，不誤傷')
  assert.equal(isBackgroundPartner(null), false)
  // chatpane 只有一個出口：canRemote 加上背景判斷；其餘入口（切換鈕、標頭終端鈕、按鍵列、打字、終端格）都由 canRemote 供電
  const src = read('ui/lib/chatpane.mjs')
  assert.match(src, /const canRemote = computed\(\(\) => !canTermView\.value && !isBackgroundPartner\(props\.friend\) && remoteEntry\(/)
  assert.match(src, /const mSwitch = computed\(\(\) => props\.noBar && canRemote\.value\)/)
  assert.match(src, /const remoteShown = computed\(\(\) => remoteOn\.value && canRemote\.value\)/)
  assert.match(src, /const keyRowShown = computed\(\(\) => props\.noBar && remoteShown\.value\)/)
  assert.match(src, /\(canRemote\.value \? \{ ready: true, on: remoteShown\.value, label: REMOTE_LABEL/)
})
