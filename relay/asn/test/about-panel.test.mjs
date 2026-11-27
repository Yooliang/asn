// 「關於」頁共用元件 AsnAboutPanel（#1763 C1，U3）：電腦（split）與手機（stack）用同一個元件，畫面只搬不改。
// 守門：三種平台 × 三種外觀都渲染得出來、每一行都在、按了送對的事件；「檢視記錄」有沒有由設定值清單 open-ui-log 那一列決定（不是 caps）；
// 舊的 about 樣式規則已從 style.css／mobile.css／三套外觀刪掉。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { AsnAboutPanel } from '../ui/parts/about-panel.mjs'
import { ABOUT_ITEMS, ABOUT_LOG_VIEWER, aboutView } from '../ui/lib/about-info.mjs'
import { capsDesktop } from '../ui/shells/caps-desktop.mjs'
import { capsAndroid } from '../ui/shells/caps-android.mjs'
import { capsWeb } from '../ui/shells/caps-web.mjs'
import { ATTRS_DESKTOP, ATTRS_ANDROID, ATTRS_WEB } from '../ui/shells/platform-attrs.mjs'
import { mountComponent } from './helpers/render.mjs'
import { COLS, colOf, parsePlatform, parseList } from './settings-list-check.mjs'

const read = p => fs.readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const PLATFORMS = [['desktop', capsDesktop, ATTRS_DESKTOP], ['android', capsAndroid, ATTRS_ANDROID], ['web', capsWeb, ATTRS_WEB]]
const SKINS = ['aero', 'modern', 'line']
const about = aboutView({ deviceName: '測試筆電' })
const props = (attrs, extra = {}) => ({ about, version: '9.9.9', layout: attrs.layout, showLogViewer: false, ...extra })

for (const [pname, caps, attrs] of PLATFORMS) {
  for (const skin of SKINS) {
    test(`AsnAboutPanel 在 ${pname} × ${skin} 都能渲染，簡介、版本、設備名稱、連結、出品都在`, () => {
      assert.ok(caps)
      const m = mountComponent(AsnAboutPanel, props(attrs))
      try {
        m.document.documentElement.setAttribute('data-skin', skin)
        const text = m.container.textContent
        assert.ok(text.includes(about.intro), '簡介')
        assert.ok(text.includes('版本 9.9.9'), '版本號')
        assert.ok(text.includes('這台設備：測試筆電'), '設備名稱')
        assert.ok(text.includes(about.maker), '出品')
        const labels = m.findAll(`[class*="asn-about-"] button, button[class*="asn-about-"]`).map(b => b.textContent.replace(/[↗▸]/g, '').trim())
        assert.deepEqual(labels.filter(Boolean), ABOUT_ITEMS.map(i => i.label), '連結照順序')
        assert.ok(m.find(attrs.layout === 'stack' ? '.asn-about-intro.is-stack' : '.asn-about-intro.is-split'), '版面類別跟著 layout')
      } finally { m.unmount() }
    })
  }
}

test('split（電腦）：連結一排按鈕；stack（手機）：一列一列、外部連結帶 ↗、其他帶 ▸', () => {
  const d = mountComponent(AsnAboutPanel, props(ATTRS_DESKTOP))
  try { assert.equal(d.findAll('.upd-row button').length, 4); assert.equal(d.findAll('.m-row-btn').length, 0) } finally { d.unmount() }
  const s = mountComponent(AsnAboutPanel, props(ATTRS_ANDROID))
  try {
    assert.equal(s.findAll('.m-row-btn').length, 4)
    assert.deepEqual(s.findAll('.m-caret').map(c => c.textContent), ['↗', '▸', '↗', '▸'])
    assert.equal(s.findAll('.upd-row').length, 0)
  } finally { s.unmount() }
})

test('設備名稱是空的就不顯示那一行', () => {
  for (const attrs of [ATTRS_DESKTOP, ATTRS_ANDROID]) {
    const m = mountComponent(AsnAboutPanel, { ...props(attrs), about: aboutView({ deviceName: ' ' }) })
    try { assert.ok(!m.container.textContent.includes('這台設備')) } finally { m.unmount() }
  }
})

test('按連結送對的事件：外部連結交出網址、版本紀錄與使用指引只送事件名（兩種版面一樣）', async () => {
  for (const attrs of [ATTRS_DESKTOP, ATTRS_ANDROID]) {
    const m = mountComponent(AsnAboutPanel, props(attrs))
    try {
      for (const it of ABOUT_ITEMS) await m.trigger(m.find(`button.asn-about-${it.key}`), 'click')
      assert.deepEqual(m.emitted('open-link'), [[ABOUT_ITEMS[0].url], [ABOUT_ITEMS[2].url]])
      assert.equal(m.emitted('open-update').length, 1)
      assert.equal(m.emitted('open-guide').length, 1)
      assert.equal(m.emitted('open-log').length, 0)
    } finally { m.unmount() }
  }
})

test('「記錄」卡：showLogViewer 為 true 才顯示，按了送 open-log，結果提示照 logMsg；預設不顯示', async () => {
  const off = mountComponent(AsnAboutPanel, props(ATTRS_DESKTOP))
  try { assert.ok(!off.container.textContent.includes('檢視記錄')); assert.ok(!off.container.textContent.includes('出問題時可以看這份記錄')) } finally { off.unmount() }
  const on = mountComponent(AsnAboutPanel, props(ATTRS_DESKTOP, { showLogViewer: true, logMsg: '記錄檔打不開' }))
  try {
    const t = on.container.textContent
    assert.ok(t.includes('記錄') && t.includes('出問題時可以看這份記錄') && t.includes('檢視記錄'))
    assert.equal(on.find('[role="status"]').textContent, '記錄檔打不開')
    await on.trigger(on.findByText('檢視記錄'), 'click')
    assert.equal(on.emitted('open-log').length, 1)
  } finally { on.unmount() }
  const noMsg = mountComponent(AsnAboutPanel, props(ATTRS_DESKTOP, { showLogViewer: true }))
  try { assert.equal(noMsg.find('[role="status"]'), null) } finally { noMsg.unmount() }
})

// ---- 「檢視記錄」有沒有，照設定值清單 ----
test('設定值清單 open-ui-log 那一列：電腦欄「有」、手機欄「無（未做）」；殼傳的 ABOUT_LOG_VIEWER 要跟清單一致', () => {
  const row = parseList(read('../../../docs/設定值清單.md')).find(r => r.tokens.includes('open-ui-log'))
  assert.ok(row, '清單裡找不到 open-ui-log')
  const desk = parsePlatform(colOf(row, COLS.desktop)), mob = parsePlatform(colOf(row, COLS.mobile))
  assert.ok(desk.ok && mob.ok)
  assert.equal(ABOUT_LOG_VIEWER.desktop, desk.has, '電腦：清單寫有，就要傳 true')
  assert.equal(ABOUT_LOG_VIEWER.mobile, mob.has, '手機：清單寫無（未做），就要傳 false；清單改成有，這裡也要改')
  assert.equal(mob.kind, 'todo', '手機沒有是「未做」不是「平台做不到」，所以不放 caps')
})

test('兩個殼都把 ABOUT_LOG_VIEWER 的值傳給元件（不寫死、不看 caps）', () => {
  assert.match(read('../ui/lib/settings-panel.mjs'), /aboutLogViewer = ABOUT_LOG_VIEWER\.desktop/)
  assert.match(read('../ui/lib/settings-panel.mjs'), /:show-log-viewer="aboutLogViewer"/)
  assert.match(read('../ui/lib/settings-panel.mjs'), /@open-log="act\('open-ui-log'\)"/)
  assert.match(read('../ui/m.js'), /aboutLogViewer = ABOUT_LOG_VIEWER\.mobile/)
  assert.match(read('../ui/m.html'), /<asn-about-panel [^>]*:show-log-viewer="aboutLogViewer"/)
  assert.ok(!/logViewer/.test(read('../ui/shells/caps-desktop.mjs') + read('../ui/shells/caps-android.mjs') + read('../ui/shells/caps-web.mjs')), 'logViewer 不是能力')
})

// ---- 舊樣式已刪、新樣式只在一個檔 ----
test('舊的 about 樣式規則已從 style.css、mobile.css、modern.css、line.css、skin-common.css 刪掉，新規則只在 parts/about-panel.css', () => {
  const OLD = /\.ver-line|\.about-(intro|device|maker|links)|\.m-about(-|\b)/
  for (const f of ['style.css', 'mobile.css', 'modern.css', 'line.css', 'skin-common.css', 'group.css', 'kit.css']) assert.ok(!OLD.test(read(`../ui/${f}`)), `${f} 還有舊的 about 規則`)
  const css = read('../ui/parts/about-panel.css')
  for (const sel of ['.asn-about-ver.is-split', '.asn-about-intro.is-split', '.asn-about-device.is-split', '.asn-about-maker.is-split', '.asn-about-links.is-split', '.asn-about-intro:where(.is-stack)', '.asn-about-links:where(.is-stack)', '.asn-about-maker:where(.is-stack)']) assert.ok(css.includes(sel), `about-panel.css 少了 ${sel}`)
  // 載入位置：電腦頁在 style.css 之後、手機頁在 mobile.css 之後（維持原本跟其他規則的先後）
  for (const f of ['list.html', 'panel.html']) { const h = read(`../ui/${f}`); assert.ok(h.indexOf('href="style.css"') < h.indexOf('href="parts/about-panel.css"') && h.indexOf('href="parts/about-panel.css"') < h.indexOf('href="skin-common.css"'), f) }
  const m = read('../ui/m.html'); assert.ok(m.indexOf('href="mobile.css"') < m.indexOf('href="parts/about-panel.css"') && m.indexOf('href="parts/about-panel.css"') < m.indexOf('href="group.css"'))
})
