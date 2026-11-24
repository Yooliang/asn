// 外觀「LINE 風格」（0.2.22，#1449 第一張）：外觀三選一的骨架。
// effectiveLook 是純函式；LINE 固定「頭像在泡泡旁、底色自動」只在「讀」的時候套用，不寫回存檔；line.css 每條規則都限定在 LINE 底下。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import { SKINS, SKIN_LABEL, SKIN_SHORT, DEFAULT_SKIN, effectiveLook, normalizeSkin } from '../ui/lib/skin.mjs'
import { catSummary } from '../ui/lib/settings-cats.mjs'
import { normalizePrefs } from '../ui/lib/mobile.mjs'
import { SCENARIOS, probeKind, probeSource, tableFor } from '../scripts/smoke-lib.mjs'

const read = p => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')

test('effectiveLook：LINE 固定 inline／auto，其他外觀照使用者原值，且不改輸入', () => {
  const mine = Object.freeze({ dpMode: 'left', bubble: 'none', toolbar: 'top' })
  assert.deepEqual(effectiveLook('line', mine), { dpMode: 'inline', bubble: 'auto', toolbar: 'top' })
  assert.deepEqual(effectiveLook('modern', mine), { dpMode: 'left', bubble: 'none', toolbar: 'top' })
  assert.deepEqual(effectiveLook('aero', mine), { dpMode: 'left', bubble: 'none', toolbar: 'top' })
  assert.deepEqual(effectiveLook(undefined, mine), { dpMode: 'left', bubble: 'none', toolbar: 'top' })
  assert.deepEqual(mine, { dpMode: 'left', bubble: 'none', toolbar: 'top' }, '輸入沒被改')
  assert.notEqual(effectiveLook('aero', mine), mine, '回傳新物件')
})

test('外觀清單：多了 LINE；預設仍是復古 Aero（新安裝不變）；手機偏好存得下 line', () => {
  assert.ok(SKINS.includes('line')); assert.equal(SKIN_LABEL.line, 'LINE 風格'); assert.equal(SKIN_SHORT.line, 'LINE 風格')
  assert.equal(DEFAULT_SKIN, 'aero')
  assert.equal(normalizeSkin('line'), 'line')
  assert.equal(normalizePrefs({ skin: 'line' }).skin, 'line')
  assert.equal(normalizePrefs({ skin: 'LINE' }).skin, 'aero', '大小寫不對當壞值')
})

test('切到 LINE 再切回：使用者存的頭像模式、文字底色不變（有效值只在讀的地方套用）', () => {
  const saved = { dpMode: 'left', bubble: 'none' }
  const seen = []
  for (const skin of ['aero', 'line', 'modern', 'aero']) { seen.push(effectiveLook(skin, saved)); assert.deepEqual(saved, { dpMode: 'left', bubble: 'none' }, `切到 ${skin} 後`) }
  assert.deepEqual(seen.map(x => x.dpMode), ['left', 'inline', 'left', 'left'])
  // 程式端：存檔與設定快照用 ui.dpMode／ui.bubble 自己的值；有效值只給對話窗格與獨立對話視窗用
  const list = read('ui/list.js')
  assert.match(list, /const lookNow = computed\(\(\) => effectiveLook\(skin\.value, \{ dpMode: ui\.dpMode, bubble: ui\.bubble \}\)\)/)
  assert.match(list, /winMode: ui\.mode, dpMode: ui\.dpMode, bubble: ui\.bubble, toolbar: ui\.toolbar/, '存檔用使用者自己的值')
  assert.match(list, /mode: ui\.mode, dpMode: ui\.dpMode, toolbar: ui\.toolbar, bubble: ui\.bubble,\n\s+tabDim/, '設定快照用使用者自己的值')
  assert.match(list, /emit\('asn:state'[^\n]*ui: \{ dpMode: lookNow\.value\.dpMode, bubble: lookNow\.value\.bubble/, '獨立對話視窗收到的是有效值')
  assert.match(read('ui/list.html'), /:dp-mode="lookNow\.dpMode" :bubble="lookNow\.bubble"/)
  assert.doesNotMatch(read('ui/list.html'), /:dp-mode="ui\.dpMode"/)
})

test('設定頁摘要（#1547）：LINE 外觀不列被藏起來的頭像、底色、分頁依；有作用的工具列與分組依照列', () => {
  const base = { frame: 'custom', mode: 'merged', toolbar: 'top', dpMode: 'left', bubble: 'none', tabDim: 'device', groupDim: 'status' }
  const line = catSummary('look', { ...base, skin: 'line' }), modern = catSummary('look', { ...base, skin: 'modern' })
  assert.match(line, /^LINE 風格/); assert.doesNotMatch(line, /頭像|底色|分頁依/); assert.match(line, /工具列輸入框上方/); assert.match(line, /分組依活躍度/)
  assert.match(modern, /^現代/); assert.match(modern, /頭像左/); assert.doesNotMatch(modern, /工具列/)
})

test('設定頁（#1547）：被當前外觀用不到的選項整個藏起來，不再變灰加說明；選單顯示存檔的原值', () => {
  const panel = read('ui/lib/settings-panel.mjs')
  assert.doesNotMatch(panel, /:disabled="st\.skin === '(line|modern)'"/, '不再用變灰')
  assert.doesNotMatch(panel, /set-note-(dp|bubble|toolbar)/, '不再有變灰的說明')
  for (const [label, key] of [['頭像模式', 'dpMode'], ['工具列位置', 'toolbar'], ['文字底色', 'bubble'], ['分頁依', 'tabDim']]) assert.ok(panel.includes(`<label v-if="lookShows(st.skin, '${key}')">${label}
`), `${label} 依外觀藏起來`)
  assert.match(panel, /:value="st\.dpMode"/); assert.match(panel, /:value="st\.bubble"/)
  const st = { skin: 'line', dpMode: 'left', bubble: 'none' }
  assert.deepEqual([effectiveLook(st.skin, st).dpMode, effectiveLook(st.skin, st).bubble], ['inline', 'auto'], '對話畫面仍用 effectiveLook 的有效值')
  assert.deepEqual(st, { skin: 'line', dpMode: 'left', bubble: 'none' }, '快照沒被改')
})

test('skin-boot.js：認得 line，壞值回復古 Aero（在假的視窗裡真的跑一次）', () => {
  const run = (stored, ev) => {
    const attrs = {}, handlers = {}
    const ctx = { document: { documentElement: { setAttribute: (k, v) => { attrs[k] = v } } }, localStorage: { getItem: () => stored }, window: { addEventListener: (k, f) => { handlers[k] = f } } }
    ctx.window.__TAURI__ = { event: { listen: (n, f) => { handlers[n] = f } } }
    vm.runInNewContext(read('ui/skin-boot.js'), ctx)
    if (ev) handlers.storage({ key: 'asnSkin', newValue: ev })
    return attrs['data-skin']
  }
  assert.equal(run('line'), 'line'); assert.equal(run('modern'), 'modern'); assert.equal(run('aero'), 'aero')
  for (const bad of [null, '', 'neon', 'LINE']) assert.equal(run(bad), 'aero', String(bad))
  assert.equal(run('aero', 'line'), 'line', '別的視窗切成 LINE，這個視窗跟著換')
  assert.equal(run('line', 'oops'), 'aero')
})

test('line.css：每條規則都限定在 LINE 底下（縮圖除外）；九個頁面都在 modern.css 之後載入；LINE 專屬色票是變數', () => {
  const css = read('ui/line.css').replace(/\/\*[\s\S]*?\*\//g, '')
  const selectors = [...css.matchAll(/([^{}]+)\{[^{}]*\}/g)].map(m => m[1].trim()).filter(Boolean)
  assert.ok(selectors.length > 150)
  for (const sel of selectors) for (const part of sel.split(',')) assert.match(part.trim(), /^(:root\[data-skin="line"\]|\.skin-mini-line\b)/, `沒有限定在 LINE：${part.trim()}`)
  assert.doesNotMatch(css, /@/, '不寫 @ 規則：包在裡面的選擇器上面的檢查抓不到')
  assert.match(css, /--line-me:#9be685/, '自己的泡泡顏色是變數，擁有者拍板亮綠')
  assert.match(css, /background:var\(--line-me\)/); assert.match(css, /--line-bg:#a9bde2/)
  assert.doesNotMatch(css, /modern/, '不引用現代的變數或選擇器：自成一套')
  for (const page of ['list', 'chat', 'panel', 'toast', 'm', 'login', 'onboard', 'askpass', 'setup-progress']) {
    const html = read(`ui/${page}.html`)
    const a = html.indexOf('href="style.css"'), b = html.indexOf('href="modern.css"'), c = html.indexOf('href="line.css"'), d = html.indexOf('src="skin-boot.js"')
    assert.ok(a > 0 && b > a && c > b && d > c, `${page}.html：line.css 在 modern.css 之後、skin-boot.js 之前`)
  }
})

test('LINE 情境：電腦清單、一對一、群組、設定；手機清單、一對一、群組、設定；存檔選 LINE，探測語法正確、設定頁用真的點擊', () => {
  const sc = SCENARIOS.filter(s => s.probe?.line)
  assert.deepEqual(sc.map(s => s.name), ['list-line-msgs', 'list-line-group', 'list-line-list', 'list-line-settings', 'm-line-msgs', 'm-line-group', 'm-line-list', 'list-line-nav', 'list-line-nav-notice', 'list-line-nav-notice-narrow', 'list-line-chat', 'list-line-narrow', 'm-line-nav', 'm-line-chat', 'm-line-settings', 'list-line-rows', 'm-line-rows', 'list-line-compose', 'm-line-compose'])
  for (const s of sc) {
    const me = JSON.parse(tableFor(s).store_load.values.me)
    assert.equal(me.skin, 'line', s.name); assert.equal(me.mobilePrefs.skin, 'line', s.name)
    assert.doesNotThrow(() => new vm.Script(probeSource(s.probe)), s.name)
    assert.ok(probeKind(s.probe), s.name)
  }
  const settings = probeSource(sc.find(s => s.name === 'list-line-settings').probe)
  for (const w of ['__smokeInput', '.skin-pick input[type="radio"]', '#9be685', 'modern', 'aero']) assert.ok(settings.includes(w), w)
  assert.ok(!settings.includes('.click()'), '不用 element.click()，都走真的輸入')
  const lookMe = JSON.parse(tableFor(sc.find(s => s.name === 'list-line-settings')).store_load.values.me)
  assert.equal(lookMe.dpMode, 'left'); assert.equal(lookMe.bubble, 'none'); assert.equal(lookMe.session.panel.setting, 'look')
  const groupMsgs = tableFor(sc.find(s => s.name === 'list-line-group')).relay_room_read.messages
  assert.ok(groupMsgs.some(m => m.relation === 'mine') && groupMsgs.some(m => m.relation === 'system'))
})
