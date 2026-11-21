// 設定頁基準情境的覆蓋清單（#1763 T3、風險 R9）：從 SETTING_CATS／MOBILE_SETTING_KEYS 算出「應該有哪些情境」，對照 SCENARIOS，漏一類就紅。
// 應有的名稱在這裡用自己的規則重新算一次（不從 smoke-lib 的產生器借），產生器改壞了這支才看得出來。
// 不開瀏覽器：只驗情境的結構、假後台表與探測原始碼的語法；真的畫出來由 ui-shots／smoke-ui 在瀏覽器裡驗。
import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'
import { MOBILE_SETTING_KEYS, mobileSettingTitle } from '../ui/lib/mobile-settings.mjs'
import { SETTING_CATS } from '../ui/lib/settings-cats.mjs'
import { SCENARIOS, SET_SCENARIOS, SET_STATE_GAPS, SET_STATE_MATRIX, injectSource, probeKind, probeSource, tableFor } from '../scripts/smoke-lib.mjs'

const SKINS = ['aero', 'modern', 'line']
const PHONE_360 = ['look', 'update', 'notify', 'about']
const STATES = ['empty', 'error', 'busy']
const STATE_CATS = ['devices', 'accounts', 'cloud']
const byName = new Map(SCENARIOS.map(s => [s.name, s]))

// 應有的情境名（每類 × 外觀；手機再加 360；三類多狀態）
const deskNames = SETTING_CATS.flatMap(c => SKINS.map(k => `list-set-${c.key}-${k}`))
const phoneNames = MOBILE_SETTING_KEYS.flatMap(k => SKINS.map(sk => `m-set-${k}-${sk}`))
const phone360 = PHONE_360.map(k => `m-set-${k}-360`)
const stateNames = STATE_CATS.flatMap(c => STATES.filter(st => !(`${c}:${st}` in SET_STATE_GAPS)).flatMap(st => [`list-set-${c}-${st}`, `m-set-${c}-${st}`]))

test('分類來源：電腦 12 類、手機 8 類、手機的類都在電腦那份裡（來源改了這支要跟著看）', () => {
  assert.equal(SETTING_CATS.length, 12)
  assert.equal(MOBILE_SETTING_KEYS.length, 8)
  for (const k of MOBILE_SETTING_KEYS) assert.ok(SETTING_CATS.some(c => c.key === k), `手機的 ${k} 電腦那份沒有`)
  for (const k of PHONE_360) assert.ok(MOBILE_SETTING_KEYS.includes(k), `${k} 不是手機的設定類`)
  for (const k of STATE_CATS) assert.ok(SETTING_CATS.some(c => c.key === k) && MOBILE_SETTING_KEYS.includes(k), `${k} 電腦與手機都要有`)
})

test('覆蓋清單：每一類 × 三套外觀（電腦 900、手機 412）、手機四類再加 360，都在 SCENARIOS 裡', () => {
  assert.equal(deskNames.length, 36)
  assert.equal(phoneNames.length, 24)
  assert.equal(phone360.length, 4)
  const missing = [...deskNames, ...phoneNames, ...phone360].filter(n => !byName.has(n))
  assert.deepEqual(missing, [], `少了這些設定頁情境：${missing.join('、')}`)
  for (const n of deskNames) { const s = byName.get(n); assert.equal(s.page, 'list.html', n); assert.equal(s.width, 900, n); assert.equal(s.state.skin ?? 'aero', n.split('-').pop(), n) }
  for (const n of phoneNames) { const s = byName.get(n); assert.equal(s.page, 'm.html', n); assert.equal(s.width, 412, n); assert.equal(s.state.skin ?? 'aero', n.split('-').pop(), n) }
  for (const n of phone360) { const s = byName.get(n); assert.equal(s.page, 'm.html', n); assert.equal(s.width, 360, n); assert.equal(s.state.skin ?? 'aero', 'aero', n) }
})

test('多狀態：設備、帳號、雲端代理三類的每個狀態，不是有情境就是有寫明做不出來的原因（沒有第三種）', () => {
  for (const c of STATE_CATS) for (const st of STATES) {
    const key = `${c}:${st}`
    const inMatrix = (SET_STATE_MATRIX[c] ?? []).includes(st), gap = SET_STATE_GAPS[key]
    assert.ok(inMatrix !== Boolean(gap), `${key} 要嘛有情境、要嘛在 SET_STATE_GAPS 寫原因（不能兩者都有或都沒有）`)
    if (gap) assert.ok(gap.length >= 20, `${key} 的原因太短，要寫清楚為什麼做不出來`)
    if (inMatrix) for (const n of [`list-set-${c}-${st}`, `m-set-${c}-${st}`]) assert.ok(byName.has(n), `缺狀態情境 ${n}`)
    else for (const n of [`list-set-${c}-${st}`, `m-set-${c}-${st}`]) assert.ok(!byName.has(n), `${n} 已有情境，卻還列在 SET_STATE_GAPS`)
  }
  assert.deepEqual(Object.keys(SET_STATE_MATRIX).sort(), [...STATE_CATS].sort())
  assert.ok(stateNames.length >= 10, `狀態情境只有 ${stateNames.length} 個`)
})

test('新增的情境全部帶 shot、探測（等標題＋代表字）、特徵選擇器；名稱不重複；接在既有情境後面', () => {
  const all = [...deskNames, ...phoneNames, ...phone360, ...stateNames]
  assert.equal(new Set(all).size, all.length, '應有的情境名不重複')
  assert.equal(SET_SCENARIOS.length, all.length, '設定頁基準情境的總數跟覆蓋清單算的不同（多了或少了情境）')
  assert.deepEqual(SET_SCENARIOS.map(s => s.name).sort(), [...all].sort())
  assert.equal(new Set(SCENARIOS.map(s => s.name)).size, SCENARIOS.length, 'SCENARIOS 名稱不可重複')
  // 新情境在最後面：既有情境的順序不變
  assert.deepEqual(SCENARIOS.slice(-SET_SCENARIOS.length).map(s => s.name), SET_SCENARIOS.map(s => s.name))
  for (const s of SET_SCENARIOS) {
    assert.equal(s.shot, `${s.name}.png`, `${s.name} 要帶 shot（進畫面比對）`)
    assert.ok(s.ready && /panel-h|m-row-btn/.test(s.ready), `${s.name} 要等設定頁的特徵元素`)
    assert.ok(s.probe?.setPage === true, `${s.name} 要用 setPage 探測`)
    assert.ok(s.probe.heading && s.probe.key, `${s.name} 要斷言分類標題`)
    assert.ok(Array.isArray(s.probe.want) && s.probe.want.length > 0 && s.probe.want.every(w => typeof w === 'string' && w.length >= 2), `${s.name} 要斷言畫面上有該類的代表字`)
    assert.ok(!s.probe.want.some(w => /^__.*__$/.test(w)), `${s.name} 的代表字還是佔位字`)
    assert.equal(s.state.signedIn, true, s.name)
  }
})

test('標題斷言：電腦是「設定：<分類名>」、手機是內頁標題（分類名），都從來源的 title 算，不寫死', () => {
  for (const c of SETTING_CATS) for (const k of SKINS) assert.equal(byName.get(`list-set-${c.key}-${k}`).probe.heading, `設定：${c.title}`)
  for (const k of MOBILE_SETTING_KEYS) for (const sk of SKINS) { const p = byName.get(`m-set-${k}-${sk}`).probe; assert.equal(p.heading, mobileSettingTitle(k)); assert.equal(p.row, mobileSettingTitle(k)) }
  // 設定類彼此標題不同，才能分辨「畫的是別類」
  assert.equal(new Set(SETTING_CATS.map(c => c.title)).size, SETTING_CATS.length)
})

test('假後台表：電腦存檔停在該類、手機停在設定分頁；三類的狀態表（空、錯誤、忙碌）各自不同；錯誤／忙碌用 __fail／__hang', () => {
  for (const c of SETTING_CATS) {
    const t = tableFor(byName.get(`list-set-${c.key}-aero`))
    assert.equal(JSON.parse(t.store_load.values.me).session.panel.setting, c.key, `${c.key} 的存檔沒有停在那一類`)
  }
  for (const k of MOBILE_SETTING_KEYS) assert.equal(JSON.parse(tableFor(byName.get(`m-set-${k}-aero`)).store_load.values.me).navTab, 'me')
  // 外觀寫進存檔（跟其他情境同一條路）
  assert.equal(JSON.parse(tableFor(byName.get('list-set-look-line')).store_load.values.me).skin, 'line')
  assert.equal(JSON.parse(tableFor(byName.get('m-set-look-modern')).store_load.values.me).mobilePrefs.skin, 'modern')
  const T = n => tableFor(byName.get(n))
  assert.deepEqual(T('list-set-cloud-empty').cloud_agent_list, { nodes: [] })
  assert.equal(T('list-set-cloud-aero').cloud_agent_list.nodes.length, 3)
  assert.ok(T('list-set-cloud-error').__fail.cloud_agent_list)
  assert.ok(!('cloud_agent_list' in (T('list-set-cloud-aero').__fail ?? {})))
  assert.deepEqual(T('m-set-cloud-busy').__hang, ['cloud_agent_create'])
  assert.equal(byName.get('list-set-cloud-busy').probe.flow, 'cloud-busy')
  assert.ok(T('list-set-accounts-error').__fail.acct_roster && T('m-set-accounts-error').__fail.android_acct_roster)
  assert.equal(T('list-set-devices-empty').relay_list.members.length, 0)
  assert.ok(T('list-set-devices-aero').relay_list.members.length >= 3)
  // 三個狀態的表不能彼此相同（相同＝做不出差別，要改成寫進 SET_STATE_GAPS）
  for (const c of STATE_CATS) for (const side of ['list', 'm']) {
    const sts = ['aero', ...(SET_STATE_MATRIX[c] ?? [])]
    const tabs = sts.map(st => JSON.stringify(T(`${side}-set-${c}-${st}`)))
    assert.equal(new Set(tabs).size, tabs.length, `${side} ${c} 的狀態假後台表有重複`)
  }
})

test('假 Tauri：__fail 回錯誤、__hang 永遠不回、其他指令照舊', async () => {
  const ctx = vm.createContext({ globalThis: null, setTimeout, clearTimeout, setInterval, clearInterval, JSON, Promise })
  ctx.globalThis = ctx
  vm.runInContext(injectSource({ a: 1, b: 2, c: 3, __fail: { b: '連線逾時' }, __hang: ['c'] }), ctx)
  const inv = ctx.__TAURI__.core.invoke
  assert.equal(await inv('a'), 1)
  await assert.rejects(inv('b'), e => e === '連線逾時')
  let settled = false
  inv('c').then(() => { settled = true }, () => { settled = true })
  await new Promise(r => setTimeout(r, 30))
  assert.equal(settled, false, '__hang 的指令不該回')
  assert.deepEqual(Array.from(ctx.__smokeCalls, x => x[0]), ['a', 'b', 'c'])
})

test('探測：每個設定頁情境的探測原始碼語法正確、帶入標題與代表字；種類名稱看得出是哪一類', () => {
  for (const s of SET_SCENARIOS) {
    const src = probeSource(s.probe)
    assert.doesNotThrow(() => new vm.Script(src), s.name)
    assert.ok(src.includes(JSON.stringify(s.probe.heading)), `${s.name} 的探測沒有帶入標題`)
    for (const w of s.probe.want) assert.ok(src.includes(JSON.stringify(w)), `${s.name} 的探測沒有帶入代表字「${w}」`)
    assert.ok(probeKind(s.probe).includes(s.probe.key), s.name)
  }
})
