// 外觀「復古 Aero／現代」（0.2.18）：兩套共用同一份畫面，只換樣式表（modern.css 全部規則都在 :root[data-skin="modern"] 底下）；
// 選擇記在設定檔（電腦 me 存檔、手機 mobilePrefs），套用時另記 localStorage，每個視窗開啟前由 skin-boot.js 先套上、別的視窗改了跟著換。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { DEFAULT_SKIN, SKINS, SKIN_KEY, SKIN_LABEL, applySkin, initSkin, normalizeSkin } from '../ui/lib/skin.mjs'

const read = p => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const fakeDoc = () => ({ documentElement: { dataset: {} } })
const fakeStore = (init = {}) => { const m = new Map(Object.entries(init)); return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), m } }

test('兩個選項、預設復古 Aero（舊使用者升級後樣子不變）、壞值退回預設', () => {
  assert.deepEqual(SKINS, ['aero', 'modern'])
  assert.deepEqual(SKINS.map(k => SKIN_LABEL[k]), ['復古 Aero（現在的樣子）', '現代'])
  assert.equal(DEFAULT_SKIN, 'aero')
  for (const v of [undefined, null, '', 'neon', 3, {}]) assert.equal(normalizeSkin(v), 'aero', String(v))
  assert.equal(normalizeSkin('modern'), 'modern')
})

test('套用：寫到 <html data-skin>，並記到 localStorage（其他視窗、下次開啟一開始就是這一套）；壞值當復古 Aero；沒有 localStorage 也不會壞', () => {
  const doc = fakeDoc(), st = fakeStore()
  assert.equal(applySkin('modern', { doc, storage: st }), 'modern')
  assert.equal(doc.documentElement.dataset.skin, 'modern'); assert.equal(st.getItem(SKIN_KEY), 'modern')
  assert.equal(applySkin('x', { doc, storage: st }), 'aero'); assert.equal(st.getItem(SKIN_KEY), 'aero')
  assert.equal(applySkin('modern', { doc, storage: null }), 'modern')
  const broken = { getItem() { throw new Error('denied') }, setItem() { throw new Error('denied') } }
  assert.doesNotThrow(() => applySkin('modern', { doc, storage: broken }))
  // 開啟時讀記下來的；別的視窗改了（storage 事件）跟著換
  const d2 = fakeDoc(), handlers = {}
  const win = { addEventListener: (k, f) => { handlers[k] = f } }
  assert.equal(initSkin({ doc: d2, storage: fakeStore({ [SKIN_KEY]: 'modern' }), win }), 'modern')
  assert.equal(d2.documentElement.dataset.skin, 'modern')
  handlers.storage({ key: SKIN_KEY, newValue: 'aero' }); assert.equal(d2.documentElement.dataset.skin, 'aero')
  handlers.storage({ key: 'other', newValue: 'modern' }); assert.equal(d2.documentElement.dataset.skin, 'aero', '別的鍵不理')
})

test('樣式表：modern.css 每一條規則都限定在 :root[data-skin="modern"]（選復古 Aero 時完全不作用）；每個用 style.css 的頁面都載入 modern.css 與 skin-boot.js', () => {
  const css = read('ui/modern.css').replace(/\/\*[\s\S]*?\*\//g, '')
  const selectors = [...css.matchAll(/([^{}]+)\{[^{}]*\}/g)].map(m => m[1].trim()).filter(Boolean)
  assert.ok(selectors.length > 40)
  for (const sel of selectors) for (const part of sel.split(',')) assert.match(part.trim(), /^:root\[data-skin="modern"\]/, `沒有限定在現代：${part.trim()}`)
  assert.match(css, /--accent:#2f7a70/); assert.match(css, /--panel-soft:#f6f5f2/)
  for (const page of ['list', 'chat', 'panel', 'toast', 'm', 'login', 'onboard', 'askpass', 'setup-progress']) {
    const html = read(`ui/${page}.html`)
    const a = html.indexOf('href="style.css"'), b = html.indexOf('href="modern.css"'), c = html.indexOf('src="skin-boot.js"')
    assert.ok(a > 0 && b > a && c > b, `${page}.html：modern.css 在 style.css 之後、skin-boot.js 在畫面出來之前`)
  }
  const boot = read('ui/skin-boot.js')
  assert.match(boot, /localStorage\.getItem\('asnSkin'\)/); assert.match(boot, /addEventListener\('storage'/)
  assert.doesNotMatch(boot, /setItem|fetch|invoke/, '開機腳本只讀不寫')
})

test('設定接線：電腦「設定 → 外觀」最上面二選一、存在 me 存檔、選了馬上套用；手機「設定」多一類「外觀」，存在 mobilePrefs', () => {
  const panel = read('ui/lib/settings-panel.mjs'), list = read('ui/list.js'), m = read('ui/m.js'), mh = read('ui/m.html')
  assert.match(panel, /<template v-if="catKey === 'look'">\n\s*<!--[^\n]*-->\n\s*<fieldset class="skin-pick" aria-label="外觀">/, '外觀選項在外觀分類的最上面')
  assert.match(panel, /@change="act\('skin', k\)"/)
  assert.match(list, /const skin = ref\(applySkin\(savedMe\.skin\)\)/); assert.match(list, /watch\(skin, v => applySkin\(v\)\)/)
  assert.match(list, /case 'skin': skin\.value = normalizeSkin\(value\); break/)
  assert.match(list, /skin: skin\.value, frame: frame\.value, mode: ui\.mode/, '設定快照帶外觀（分離模式的設定視窗也看得到）')
  assert.match(m, /watch\(\(\) => prefs\.skin, v => applySkin\(v\), \{ immediate: true \}\)/)
  assert.match(mh, /<template v-else-if="settingCat === 'look'">[\s\S]*?v-model="prefs\.skin"/)
})
