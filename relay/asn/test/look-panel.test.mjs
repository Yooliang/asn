// 「外觀」頁共用元件 AsnLookPanel／AsnSkinPicker（#1763 C3，U5）：電腦（split）與手機（stack）用同一個元件，畫面只搬不改。
// 守門：三張能力表 × 三套外觀都渲染得出來；lookItems 與 LOOK_CUSTOM 跟設定值清單的平台欄一致（手機是「無（未做）」，不用 caps）；
// 兩個殼真的掛載確認版面（電腦 is-split、手機 is-stack）；LINE／現代下用不到的選項整個藏起來；換外觀、選單的事件接到原本的函式；手機固定的三個值取自常數。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { AsnLookPanel, AsnSkinPicker, lookItems } from '../ui/parts/look-panel.mjs'
import { LOOK_CUSTOM, MOBILE_FIXED_LOOK } from '../ui/lib/look-info.mjs'
import { LOOK_HIDDEN_BY_SKIN, LOOK_OPTIONS } from '../ui/lib/settings-cats.mjs'
import { SKINS, SKIN_LABEL } from '../ui/lib/skin.mjs'
import { settingNeeds } from '../ui/lib/setting-needs.mjs'
import { effectiveLook } from '../ui/lib/skin.mjs'
import { capsDesktop } from '../ui/shells/caps-desktop.mjs'
import { capsAndroid } from '../ui/shells/caps-android.mjs'
import { capsWeb } from '../ui/shells/caps-web.mjs'
import { ATTRS_DESKTOP, ATTRS_ANDROID, ATTRS_WEB } from '../ui/shells/platform-attrs.mjs'
import { mountComponent } from './helpers/render.mjs'
import { COLS, colOf, parsePlatform, parseList } from './settings-list-check.mjs'

const read = p => fs.readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const DOC = read('../../../docs/設定值清單.md')
// 平台、能力表、平台屬性、自訂選項有沒有（網頁還沒有殼，先當沒有）
const PLATFORMS = [['desktop', capsDesktop, ATTRS_DESKTOP, LOOK_CUSTOM.desktop], ['android', capsAndroid, ATTRS_ANDROID, LOOK_CUSTOM.mobile], ['web', capsWeb, ATTRS_WEB, false]]
const LABEL = { skin: '外觀', frame: '視窗外框', mode: '視窗模式', dpMode: '頭像模式', toolbar: '工具列位置', bubble: '文字底色', tabDim: '分頁依', groupDim: '分組依' }
const ST = { skin: 'aero', frame: 'custom', mode: 'merged', dpMode: 'right', toolbar: 'bottom', bubble: 'color', tabDim: 'engine', groupDim: 'device' }
const props = (caps, attrs, custom, skin) => ({ items: lookItems(caps, custom), skin, values: { ...ST, skin }, layout: attrs.layout })

// ---- 渲染 ----
for (const [pname, caps, attrs, custom] of PLATFORMS) {
  for (const skin of SKINS) {
    test(`AsnLookPanel 在 ${pname} × ${skin} 都能渲染：外觀三選一、目前這一套勾著，其餘選單照 lookItems 與外觀藏起來的規則`, () => {
      const items = lookItems(caps, custom)
      const m = mountComponent(AsnLookPanel, props(caps, attrs, custom, skin))
      try {
        m.document.documentElement.setAttribute('data-skin', skin)
        const radios = m.findAll('input[type="radio"]')
        assert.deepEqual(radios.map(r => r.value), SKINS, '外觀三選一，順序照 SKINS')
        assert.deepEqual(radios.map(r => r.checked), SKINS.map(k => k === skin))
        assert.deepEqual(m.findAll('.skin-mini').map(e => e.className.replace(/\s+/g, ' ')), SKINS.map(k => `skin-mini skin-mini-${k}`), '縮圖 skin-mini 兩邊共用')
        const want = items.filter(i => i.key !== 'skin' && !(LOOK_HIDDEN_BY_SKIN[skin] ?? []).includes(i.key)).map(i => LABEL[i.key])
        assert.deepEqual(m.findAll('select').map(s => s.getAttribute('aria-label')), want)
        assert.ok(m.find(attrs.layout === 'stack' ? '.asn-look-skin.is-stack' : '.asn-look-skin.is-split'), '版面類別跟著 layout')
      } finally { m.unmount() }
    })
  }
}

test('AsnSkinPicker 單獨渲染：兩種版面的結構、字與勾選', () => {
  const d = mountComponent(AsnSkinPicker, { skin: 'modern', layout: 'split' })
  try {
    assert.ok(d.find('fieldset.skin-pick[aria-label="外觀"] > legend'))
    assert.deepEqual(d.findAll('label.skin-opt').map(l => l.textContent.trim()), SKINS.map(k => SKIN_LABEL[k]))
    assert.deepEqual(d.findAll('label.skin-opt.on').map(l => l.textContent.trim()), [SKIN_LABEL.modern])
    assert.equal(d.findAll('.m-card').length, 0)
  } finally { d.unmount() }
  const s = mountComponent(AsnSkinPicker, { skin: 'line', layout: 'stack' })
  try {
    assert.ok(s.find('div.m-card.m-form.skin-pick[role="radiogroup"][aria-label="外觀"]'))
    assert.deepEqual(s.findAll('label.m-check.skin-opt').map(l => l.textContent.trim()), SKINS.map(k => SKIN_LABEL[k]))
    assert.deepEqual(s.findAll('label.skin-opt.on').map(l => l.textContent.trim()), [SKIN_LABEL.line])
    assert.equal(s.findAll('fieldset').length, 0)
  } finally { s.unmount() }
  const none = mountComponent(AsnSkinPicker, { skin: '', layout: 'split' })
  try { assert.deepEqual(none.findAll('input').map(i => i.checked), [true, false, false], '沒有值當 aero') } finally { none.unmount() }
})

test('文字照搬家前：電腦八項（外觀加七個選單）、手機只有外觀；選項與順序不變', () => {
  assert.deepEqual(lookItems(capsDesktop, LOOK_CUSTOM.desktop).map(i => i.label), ['外觀', '視窗外框', '視窗模式', '頭像模式', '工具列位置', '文字底色', '分頁依', '分組依'])
  assert.deepEqual(lookItems(capsDesktop, true).map(i => i.key), LOOK_OPTIONS, '順序跟 settings-cats 的 LOOK_OPTIONS 一致')
  assert.deepEqual(lookItems(capsAndroid, LOOK_CUSTOM.mobile).map(i => i.label), ['外觀'])
  assert.deepEqual(lookItems(capsDesktop, undefined).map(i => i.key), ['skin'], 'custom 沒明確給 true 就只有外觀')
  assert.deepEqual(lookItems(undefined, true).map(i => i.key), ['skin', 'mode', 'dpMode', 'toolbar', 'bubble', 'tabDim', 'groupDim'], '沒有能力表：只有視窗外框要 desktopWindow（會消失），其他自訂選項沒有能力需求')
  const m = mountComponent(AsnLookPanel, props(capsDesktop, ATTRS_DESKTOP, true, 'aero'))
  try {
    const opts = label => m.find(`select[aria-label="${label}"]`).options ? [...m.find(`select[aria-label="${label}"]`).options].map(o => o.textContent) : []
    assert.deepEqual(opts('視窗外框'), ['自訂（Aero 風）', 'Windows 原生'])
    assert.deepEqual(opts('分頁依'), ['活躍度', '廠商', '設備'])
    assert.deepEqual(opts('分組依'), ['活躍度', '設備'], '分組依的選項排除分頁依已用的那個（engine）')
    assert.equal(m.find('select[aria-label="視窗外框"]').value, 'custom')
    assert.equal(m.find('select[aria-label="頭像模式"]').value, 'right')
  } finally { m.unmount() }
})

// ---- lookItems／LOOK_CUSTOM 跟 setting-needs、設定值清單一致 ----
const ROWS = parseList(DOC)
const ROW = t => ROWS.find(r => r.tokens.includes(t)) ?? assert.fail(`清單裡找不到 ${t}`)

test('lookItems 的每一項，電腦與手機有沒有，跟設定值清單「外觀」那幾列的平台欄一致（網頁沒有殼，不比）', () => {
  for (const [pname, caps, , custom, col] of [['desktop', capsDesktop, 0, LOOK_CUSTOM.desktop, COLS.desktop], ['android', capsAndroid, 0, LOOK_CUSTOM.mobile, COLS.mobile]]) {
    const got = new Set(lookItems(caps, custom).map(i => i.token))
    for (const k of LOOK_OPTIONS) {
      const p = parsePlatform(colOf(ROW(k), col))
      assert.ok(p.ok, `${k} ${pname} 欄看不懂`)
      assert.equal(got.has(k), p.has, `${pname}：${k} 清單寫${p.has ? '有' : '無'}`)
    }
  }
})

test('LOOK_CUSTOM：清單 mode、dpMode、toolbar、bubble、tabDim、groupDim 六列，電腦欄「有」就傳 true、手機欄「無（未做）」就傳 false；清單改了、常數沒跟上就紅', () => {
  for (const k of ['mode', 'dpMode', 'toolbar', 'bubble', 'tabDim', 'groupDim']) {
    const row = ROW(k)
    const desk = parsePlatform(colOf(row, COLS.desktop)), mob = parsePlatform(colOf(row, COLS.mobile))
    assert.ok(desk.ok && mob.ok, k)
    assert.equal(LOOK_CUSTOM.desktop, desk.has, `${k}：電腦清單寫有，就要傳 true`)
    assert.equal(LOOK_CUSTOM.mobile, mob.has, `${k}：手機清單寫無（未做），就要傳 false；清單改成有，這裡也要改`)
    assert.equal(mob.kind, 'todo', `${k}：手機沒有是「未做」不是「平台做不到」，所以不放 caps`)
    assert.deepEqual(settingNeeds(k), [], `${k}：設計選擇，不需要任何能力`)
  }
})

test('視窗外框：手機是「無（平台）」，由能力 desktopWindow 決定，不看 LOOK_CUSTOM', () => {
  const mob = parsePlatform(colOf(ROW('frame'), COLS.mobile))
  assert.equal(mob.has, false); assert.equal(mob.kind, 'platform')
  assert.deepEqual(settingNeeds('frame'), ['desktopWindow'])
  assert.ok(lookItems(capsDesktop, true).some(i => i.key === 'frame'))
  assert.ok(!lookItems({ ...capsDesktop, desktopWindow: false }, true).some(i => i.key === 'frame'), '沒有 desktopWindow 就沒有視窗外框，其餘自訂選項還在')
  assert.ok(lookItems({ ...capsDesktop, desktopWindow: false }, true).some(i => i.key === 'mode'))
  assert.ok(!lookItems(capsAndroid, true).some(i => i.key === 'frame'), '手機沒有 desktopWindow，即使 custom 為 true 也沒有視窗外框')
})

test('外觀本身（skin）每個平台都有，不需要能力；「外觀」不放 customLook 能力', () => {
  assert.deepEqual(settingNeeds('skin'), [])
  for (const [, caps] of PLATFORMS) assert.ok(lookItems(caps, false).some(i => i.key === 'skin'))
  assert.ok(!/customLook/.test(read('../ui/shells/caps-desktop.mjs') + read('../ui/shells/caps-android.mjs') + read('../ui/shells/caps-web.mjs')), 'customLook 不是能力')
})

test('兩個殼都把 LOOK_CUSTOM 的值傳給 lookItems（不寫死、不看 caps）', () => {
  assert.match(read('../ui/lib/settings-panel.mjs'), /lookItems\(capsDesktop, LOOK_CUSTOM\.desktop\)/)
  assert.match(read('../ui/m.js'), /lookItems\(capsAndroid, LOOK_CUSTOM\.mobile\)/)
})

// ---- 手機固定的三個值 ----
test('手機固定的三個值：清單 dpMode、toolbar、bubble 的手機欄寫的固定值，跟 MOBILE_FIXED_LOOK 一致；對話窗兩處都取自它', () => {
  for (const k of ['dpMode', 'toolbar', 'bubble']) {
    const cell = colOf(ROW(k), COLS.mobile)
    assert.ok(cell.includes(`《ui/lib/look-info.mjs＃${k}: '${MOBILE_FIXED_LOOK[k]}'》`), `${k}：清單手機欄要指到常數的值（${MOBILE_FIXED_LOOK[k]}）`)
  }
  assert.deepEqual({ ...MOBILE_FIXED_LOOK }, { dpMode: 'inline', bubble: 'auto', toolbar: 'bottom' }, '值照舊')
  const html = read('../ui/m.html')
  const tags = html.match(/<chat-pane\b[^>]*>/g) ?? []
  assert.equal(tags.length, 2, '手機有兩處對話窗')
  for (const t of tags) {
    assert.match(t, /:dp-mode="fixedLook\.dpMode"/); assert.match(t, /:bubble="fixedLook\.bubble"/); assert.match(t, /:toolbar="fixedLook\.toolbar"/)
    assert.doesNotMatch(t, /\sdp-mode="|\sbubble="|\stoolbar="/, '不再寫死')
  }
  assert.match(read('../ui/m.js'), /fixedLook = MOBILE_FIXED_LOOK/)
  // 固定值本來就是 LINE 外觀下的有效值（頭像在旁、底色自動）；手機的 look 跟 effectiveLook 的結果同一組
  assert.deepEqual([effectiveLook('line', {}).dpMode, effectiveLook('line', {}).bubble], [MOBILE_FIXED_LOOK.dpMode, MOBILE_FIXED_LOOK.bubble])
})

// ---- 外觀用不到的選項整個藏起來 ----
test('依外觀藏起來：LINE 藏「頭像模式」「文字底色」「分頁依」、現代藏「工具列位置」，藏起來是整個不在畫面上（不是變灰）；清單的說明跟程式一致', () => {
  const hidden = skin => {
    const m = mountComponent(AsnLookPanel, props(capsDesktop, ATTRS_DESKTOP, true, skin))
    try { return { labels: m.findAll('select').map(s => s.getAttribute('aria-label')), disabled: m.findAll('select[disabled]').length } } finally { m.unmount() }
  }
  const all = LOOK_OPTIONS.slice(1).map(k => LABEL[k])
  const line = hidden('line'), modern = hidden('modern'), aero = hidden('aero')
  assert.deepEqual(aero.labels, all)
  assert.deepEqual(modern.labels, all.filter(l => l !== '工具列位置'))
  assert.deepEqual(line.labels, all.filter(l => !['頭像模式', '文字底色', '分頁依'].includes(l)))
  assert.equal(line.disabled + modern.disabled + aero.disabled, 0, '不再有變灰的選單')
  assert.ok(DOC.includes('現代藏「工具列位置」；LINE 風格藏「頭像模式」「文字底色」「分頁依」'), '設定值清單裡的說明還在，而且跟上面一致')
  assert.ok(!/set-note|disabled/.test(read('../ui/parts/look-panel.mjs')), '元件裡沒有變灰與說明的殘留')
})

// ---- 事件 ----
test('換外觀送 skin（外觀代號）、選單送 pick（{ key, value }），兩種版面一樣', async () => {
  for (const [caps, attrs, custom] of [[capsDesktop, ATTRS_DESKTOP, true], [capsAndroid, ATTRS_ANDROID, false]]) {
    const m = mountComponent(AsnLookPanel, props(caps, attrs, custom, 'aero'))
    try {
      for (const k of ['modern', 'line', 'aero']) await m.trigger(m.find(`input[value="${k}"]`), 'change', { checked: true })
      assert.deepEqual(m.emitted('skin'), [['modern'], ['line'], ['aero']])
      if (custom) {
        await m.trigger(m.find('select[aria-label="視窗外框"]'), 'change', { value: 'native' })
        await m.trigger(m.find('select[aria-label="分組依"]'), 'change', { value: 'status' })
        assert.deepEqual(m.emitted('pick'), [[{ key: 'frame', value: 'native' }], [{ key: 'groupDim', value: 'status' }]])
      } else assert.equal(m.findAll('select').length, 0, '手機沒有任何選單')
    } finally { m.unmount() }
  }
})

// ---- 版面接線：電腦一定畫 split、手機一定畫 stack；元件預設是 split，所以手機漏傳 :layout 會靜默畫成電腦版面 ----
test('版面接線：電腦殼真的掛載，「外觀」畫成 split（is-split）；選了送 act(skin)、act(op, 值)', async () => {
  const { SettingsPanel } = await import('../ui/lib/settings-panel.mjs')
  const m = mountComponent(SettingsPanel, { st: { ...ST }, catKey: 'look' })
  try {
    assert.ok(m.find('fieldset.asn-look-skin.is-split'), '電腦的外觀要帶 is-split')
    assert.equal(m.find('.is-stack'), null)
    assert.equal(m.findAll('.m-card').length, 0)
    assert.equal(m.findAll('select').length, 7)
    await m.trigger(m.find('input[value="line"]'), 'change', { checked: true })
    await m.trigger(m.find('select[aria-label="視窗模式"]'), 'change', { value: 'split' })
    assert.deepEqual(m.emitted('act'), [['skin', 'line'], ['mode', 'split']])
  } finally { m.unmount() }
  const src = read('../ui/lib/settings-panel.mjs')
  assert.match(src, /lookLayout = ATTRS_DESKTOP\.layout/)
  assert.match(src, /<asn-look-panel [^\n]*:layout="lookLayout"[^\n]*@pick="p => act\(p\.key, p\.value\)"/)
  assert.match(src, /@skin="k => act\('skin', k\)"/)
  assert.equal(ATTRS_DESKTOP.layout, 'split')
})

const MOBILE_TAG = read('../ui/m.html').match(/<asn-look-panel\s[^>]*>/)?.[0]

test('版面接線：手機殼把 ATTRS_ANDROID.layout（stack）傳給元件；用殼裡同一份接線真的掛載，畫出 is-stack；選外觀寫 prefs.skin', async () => {
  const js = read('../ui/m.js')
  assert.ok(MOBILE_TAG, 'm.html 找不到 asn-look-panel')
  assert.match(MOBILE_TAG, /\s:layout="lookLayout"/, '手機要傳 :layout（元件預設是 split，沒傳會畫成電腦版面）')
  assert.equal(/\blookLayout = (\w+)\.layout\b/.exec(js)?.[1], 'ATTRS_ANDROID', 'm.js 的 lookLayout 要取自 ATTRS_ANDROID')
  assert.match(js, /import \{[^}]*\bATTRS_ANDROID\b[^}]*\} from '\.\/shells\/platform-attrs\.mjs'/)
  assert.match(js, /app\.component\('AsnLookPanel', AsnLookPanel\)/)
  const setSkinSrc = /setSkin = (k => \{[^\n]*?\})(?:,|\n)/.exec(js)?.[1]
  assert.ok(setSkinSrc, 'm.js 找不到 setSkin')
  const Host = {
    components: { AsnLookPanel },
    setup() {
      const { reactive } = globalThis.Vue
      const prefs = reactive({ skin: 'aero' })
      const setSkin = new Function('prefs', `return ${setSkinSrc}`)(prefs)
      return { prefs, lookList: lookItems(capsAndroid, LOOK_CUSTOM.mobile), lookLayout: ATTRS_ANDROID.layout, setSkin }
    },
    template: MOBILE_TAG + '</asn-look-panel>',
  }
  const m = mountComponent(Host)
  try {
    assert.ok(m.find('.asn-look-skin.is-stack.m-card'), '手機的外觀要帶 is-stack')
    assert.equal(m.find('.is-split'), null)
    assert.equal(m.findAll('.skin-pick').length, 1)
    assert.equal(m.findAll('label.m-check.skin-opt').length, 3)
    assert.equal(m.findAll('select').length, 0)
    assert.deepEqual(m.findAll('input').map(i => i.checked), [true, false, false])
    await m.trigger(m.find('input[value="line"]'), 'change', { checked: true })
    assert.deepEqual(m.findAll('input').map(i => i.checked), [false, false, true], '選了之後 prefs.skin 換成 line，勾選跟著動')
    assert.deepEqual(m.findAll('label.skin-opt.on').map(l => l.textContent.trim()), [SKIN_LABEL.line])
  } finally { m.unmount() }
})
