// 共用零件 U1（#1763 F2）：設定項目基本件在三種平台能力 × 三種外觀下都能渲染；--asn-hit 依 data-input（指標 28、觸控 44）；
// parts.css 只用變數、不寫死顏色與尺寸；殼設的 data-input／data-layout 沒有任何現有樣式用到（所以不改變畫面）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { PARTS_U1, selectOptions } from '../ui/parts/setting-parts.mjs'
import { UI_KIT } from '../ui/lib/ui-kit.mjs'
import { capsDesktop } from '../ui/shells/caps-desktop.mjs'
import { capsAndroid } from '../ui/shells/caps-android.mjs'
import { capsWeb } from '../ui/shells/caps-web.mjs'
import { ATTRS_DESKTOP, ATTRS_ANDROID, ATTRS_WEB, applyPlatformAttrs } from '../ui/shells/platform-attrs.mjs'
import { mountComponent } from './helpers/render.mjs'

const read = p => fs.readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const settle = async m => { for (let i = 0; i < 4; i++) { await new Promise(r => setTimeout(r, 0)); await m.nextTick() } }
const CSS = read('../ui/parts/parts.css')

const PLATFORMS = [['desktop', capsDesktop, ATTRS_DESKTOP], ['android', capsAndroid, ATTRS_ANDROID], ['web', capsWeb, ATTRS_WEB]]
const SKINS = ['aero', 'modern', 'line']

// 一張完整的設定卡：每種基本件各一個
const Demo = {
  components: { ...PARTS_U1 },
  data: () => ({ on: false, mode: 'b', name: '甲', hits: 0 }),
  template: `<asn-setting-card title="外觀">
    <asn-setting-row label="啟用" hint="一句說明"><asn-toggle v-model="on" label="開啟"></asn-toggle></asn-setting-row>
    <asn-setting-row label="模式"><asn-select v-model="mode" :options="[{ value: 'a', label: '甲' }, { value: 'b', label: '乙' }]" label="模式"></asn-select></asn-setting-row>
    <asn-setting-row label="名稱"><asn-text v-model="name" inputmode="text" enterkeyhint="done" label="名稱"></asn-text></asn-setting-row>
    <asn-part-button level="primary" @click="hits++">儲存</asn-part-button>
    <asn-note>這是一行說明</asn-note>
  </asn-setting-card>`,
}

for (const [pname, caps, attrs] of PLATFORMS) {
  for (const skin of SKINS) {
    test(`U1 基本件在 ${pname} × ${skin} 都能渲染，結構與需要的屬性都在`, async () => {
      assert.ok(caps && attrs)
      const m = mountComponent(Demo, {})
      try {
        const root = m.document.documentElement
        root.setAttribute('data-skin', skin); applyPlatformAttrs(root, attrs)
        assert.equal(root.getAttribute('data-input'), attrs.input); assert.equal(root.getAttribute('data-layout'), attrs.layout)
        await settle(m)
        const q = s => m.find(s)
        assert.ok(q('section.asn-card > h3.asn-card-title'), '卡片與標題')
        assert.equal(m.findAll('.asn-row').length, 3, '三列')
        assert.ok(q('.asn-row-hint'), '列的說明')
        const chk = q('label.asn-toggle > input[type=checkbox]'); assert.ok(chk, '開關')
        const sel = q('select.asn-select'); assert.deepEqual([...sel.options].map(o => o.value), ['a', 'b'])
        assert.equal(sel.getAttribute('aria-label'), '模式')
        const tx = q('input.asn-text')
        assert.equal(tx.getAttribute('enterkeyhint'), 'done', '手機要保留 enterkeyhint'); assert.equal(tx.getAttribute('inputmode'), 'text', '手機要保留 inputmode')
        assert.equal(tx.value, '甲')
        const bt = q('button.asn-btn.lv-primary.asn-part-btn'); assert.ok(bt, '按鈕用的是 #2105 的共用按鈕')
        assert.ok(q('p.asn-note'))
        // 互動：開關、下拉、按鈕
        await m.trigger(chk, "change", { checked: true })
        await m.trigger(bt, 'click')
        await settle(m)
      } finally { m.unmount() }
    })
  }
}

test('U1 事件：開關、下拉、輸入框在確認時才送出；Enter 會讓輸入框失焦；按鈕沿用共用按鈕的規則', async () => {
  const { AsnToggle, AsnSelect, AsnText, AsnPartButton } = PARTS_U1
  const t = mountComponent(AsnToggle, { modelValue: false, label: '開' })
  try {
    await settle(t)
    await t.trigger(t.find('input'), 'change', { checked: true })
    assert.deepEqual(t.emitted('change'), [[true]]); assert.deepEqual(t.emitted('update:modelValue'), [[true]])
  } finally { t.unmount() }
  const s = mountComponent(AsnSelect, { modelValue: 'a', options: [{ value: 'a', label: '甲' }, { value: 2, label: '乙' }] })
  try {
    await settle(s)
    await s.trigger(s.find('select'), 'change', { value: '2' })
    assert.deepEqual(s.emitted('change'), [['2']], '值一律是字串')
  } finally { s.unmount() }
  const x = mountComponent(AsnText, { modelValue: '', enterkeyhint: 'send', inputmode: 'numeric', maxlength: 5 })
  try {
    await settle(x)
    const inp = x.find('input')
    assert.equal(inp.getAttribute('enterkeyhint'), 'send'); assert.equal(inp.getAttribute('inputmode'), 'numeric'); assert.equal(inp.getAttribute('maxlength'), '5')
    await x.trigger(inp, 'input', { value: '12' }); assert.deepEqual(x.emitted('update:modelValue'), [['12']])
    assert.equal(x.emitted('change').length, 0, '還沒確認就不送 change')
    inp.focus(); assert.equal(x.document.activeElement, inp)
    await x.trigger(inp, 'keydown', { key: 'Enter' })
    assert.notEqual(x.document.activeElement, inp, '按 Enter 後失焦')
  } finally { x.unmount() }
  const b = mountComponent(AsnPartButton, { state: 'busy' }, { slots: { default: () => '走' } })
  try {
    await settle(b)
    await b.trigger(b.find('button'), 'click'); assert.equal(b.emitted('click').length, 0, '切換中的按鈕不送 click')
  } finally { b.unmount() }
  assert.deepEqual(selectOptions([{ value: 1, label: 'a' }, { label: 'x' }, null, { value: 'k', label: 3 }]), [{ value: '1', label: 'a' }])
  assert.ok(UI_KIT.AsnButton, '共用按鈕仍由 ui-kit 提供')
})

// ---- 尺寸：--asn-hit ----
const ruleOf = sel => {
  const esc = sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const mt = CSS.match(new RegExp(`(?:^|\\n)${esc}\\s*\\{([^}]*)\\}`))
  assert.ok(mt, `parts.css 找不到規則 ${sel}`)
  return mt[1]
}
const hitOf = body => (body.match(/--asn-hit\s*:\s*([^;}\s]+)/) || [])[1]

test('--asn-hit：指標 28px、觸控 44px；沒設 data-input 時照指標', () => {
  assert.equal(hitOf(ruleOf(':root[data-input="touch"]')), '44px')
  assert.equal(hitOf(ruleOf(':root[data-input="pointer"]')), '28px')
  assert.equal(hitOf(ruleOf(':root')), '28px')
  assert.equal(ATTRS_ANDROID.input, 'touch'); assert.equal(ATTRS_DESKTOP.input, 'pointer')
  assert.equal(ATTRS_ANDROID.layout, 'stack'); assert.equal(ATTRS_DESKTOP.layout, 'split')
})

// ---- 守門：零件規則不寫死顏色與尺寸 ----
// 去掉註解，再把 :root 開頭的 token 區塊拿掉；剩下的零件規則裡 var() 的預設值也算變數那一邊，先去掉
const partRules = () => {
  const noComment = CSS.replace(/\/\*[\s\S]*?\*\//g, '')
  const noRoot = noComment.replace(/(?:^|\n)\s*:root[^{]*\{[^}]*\}/g, '\n')
  return noRoot.replace(/var\([^()]*\)/g, 'var()')
}
const COLOR_WORDS = /\b(?:white|black|red|blue|green|gray|grey|yellow|orange|purple|pink|silver|navy)\b/i

test('守門：parts.css 的零件規則沒有寫死顏色（#hex、rgb／hsl、顏色名稱），也沒有寫死的 px 尺寸', () => {
  const rules = partRules()
  assert.ok(rules.includes('.asn-card'), '掃描範圍要包含零件規則（否則守門是空的）')
  assert.deepEqual(rules.match(/#[0-9a-fA-F]{3,8}\b/g) || [], [], '寫死的 #hex 顏色')
  assert.deepEqual(rules.match(/\b(?:rgba?|hsla?)\s*\(/gi) || [], [], '寫死的 rgb／hsl 顏色')
  assert.deepEqual((rules.match(new RegExp(`:[^;{}]*${COLOR_WORDS.source}[^;{}]*;`, 'gi')) || []).filter(d => !/^\s*:\s*var/.test(d)), [], '寫死的顏色名稱')
  // 邊框粗細與焦點框用 1px／2px 以外的 px 一律要走變數
  assert.deepEqual((rules.match(/\b\d+(?:\.\d+)?px\b/g) || []).filter(v => v !== '1px' && v !== '2px'), [], '寫死的 px 尺寸')
})

test('守門的偵測是真的：塞一個字面顏色或 px 尺寸進零件規則會被抓到', () => {
  const bad = s => { const r = s.replace(/var\([^()]*\)/g, 'var()'); return /#[0-9a-fA-F]{3,8}\b/.test(r) || /\b(?:rgba?|hsla?)\s*\(/i.test(r) || /\b(?:[3-9]|\d{2,})px\b/.test(r) }
  assert.equal(bad('.x{color:#123456}'), true)
  assert.equal(bad('.x{color:rgb(1,2,3)}'), true)
  assert.equal(bad('.x{padding:7px}'), true)
  assert.equal(bad('.x{color:var(--asn-fg,#123456);padding:var(--asn-gap)}'), false, 'var 的預設值例外')
})

// ---- 守門：別名指到的變數在非根元素被改時，同一個選擇器上要重設別名（var() 在定義的元素上就算完，不會跟著往下改） ----
const blocks = css => [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .map(([, sel, body]) => ({ sel: sel.trim(), props: new Set([...body.matchAll(/(--[\w-]+)\s*:/g)].map(x => x[1])) }))
const missingAliasResets = (partsCss, kitCss) => {
  const root = blocks(partsCss).find(b => b.sel === ':root')
  const aliases = [...partsCss.match(/:root\s*\{[^}]*\}/)[0].matchAll(/(--asn-[\w-]+)\s*:\s*var\(\s*(--[\w-]+)/g)].map(([, a, src]) => [a, src])
  assert.ok(root && aliases.length > 5, '要讀得到 parts.css :root 的別名（否則守門是空的）')
  const mine = blocks(partsCss)
  const miss = []
  for (const kb of blocks(kitCss)) {
    if (kb.sel === ':root') continue
    for (const [alias, src] of aliases) {
      if (!kb.props.has(src)) continue
      if (!mine.some(b => b.sel === kb.sel && b.props.has(alias))) miss.push(`${kb.sel} 改了 ${src}，但 parts.css 沒在 ${kb.sel} 重設 ${alias}`)
    }
  }
  return miss
}

test('守門：kit.css 在非根元素（例如手機 .m-body）改到的變數，parts.css 同一個選擇器也要重設對應的別名', () => {
  const kit = read('../ui/kit.css')
  assert.ok(/\.m-body\s*\{[^}]*--fs-2/.test(kit), '前提：kit.css 在 .m-body 改了字級（不然這支測不到東西）')
  assert.deepEqual(missingAliasResets(CSS, kit), [])
})

test('別名重設守門的偵測是真的：拿掉 .m-body 那一行會被抓到', () => {
  const kit = read('../ui/kit.css')
  const without = CSS.replace(/\n\.m-body\{[^}]*\}/, '')
  assert.notEqual(without, CSS, '前提：parts.css 有 .m-body 那一行')
  const miss = missingAliasResets(without, kit)
  assert.ok(miss.some(m => m.includes('--asn-fs')) && miss.some(m => m.includes('--asn-fs-s')), miss.join('\n'))
})

// ---- 不改變現有畫面 ----
test('data-input／data-layout：現有樣式沒有任何選擇器用到；parts.css 沒有被任何頁面載入', () => {
  const dir = new URL('../ui/', import.meta.url)
  for (const f of fs.readdirSync(dir)) {
    if (!/\.(css|html)$/.test(f)) continue
    const s = fs.readFileSync(new URL(f, dir), 'utf8')
    assert.ok(!/data-input|data-layout/.test(s), `${f} 用到了 data-input／data-layout`)
    assert.ok(!/parts\.css/.test(s), `${f} 載入了 parts.css（F2 還不該有頁面使用）`)
  }
  // 入口只加屬性：list.js、panel.js 設電腦值，m.js 設手機值
  for (const [f, name] of [['list.js', 'ATTRS_DESKTOP'], ['panel.js', 'ATTRS_DESKTOP'], ['m.js', 'ATTRS_ANDROID']]) {
    assert.match(read(`../ui/${f}`), new RegExp(`applyPlatformAttrs\\(document\\.documentElement, ${name}\\)`), f)
  }
})

test('applyPlatformAttrs：不合法的值不寫', () => {
  const m = mountComponent({ template: '<i></i>' }, {})
  try {
    const root = m.document.createElement('html')
    applyPlatformAttrs(root, { input: 'mouse', layout: 'grid' })
    assert.equal(root.getAttribute('data-input'), null); assert.equal(root.getAttribute('data-layout'), null)
    applyPlatformAttrs(root, { input: 'touch', layout: 'stack' })
    assert.equal(root.getAttribute('data-input'), 'touch'); assert.equal(root.getAttribute('data-layout'), 'stack')
    applyPlatformAttrs(null, ATTRS_WEB)
  } finally { m.unmount() }
})
