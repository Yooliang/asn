// #1864 設備頁 PR-D：標題只留一層＋字級四檔。
// 分頁標籤（電腦）／手機標題列算外殼，頁內只留一層標題；設備頁的字級只用 kit.css 的 --fs-1～4。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import * as Vue from 'vue'
import { renderToString as ssrRender } from 'vue/server-renderer'
import { SettingsPanel } from '../ui/lib/settings-panel.mjs'
import { SETTING_CATS } from '../ui/lib/settings-cats.mjs'
import { withIdentity } from './helpers/with-identity.mjs'

const read = p => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const renderToString = async app => (await ssrRender(app)).replace(/<!--[\s\S]*?-->/g, '')

const dev = (key, label, o = {}) => withIdentity({ key, label, self: false, kind: '電腦', online: true, onlineText: '在線', reportedText: '', empty: '', vendors: [], ...o })
const st = () => ({
  devices: [dev('H', '家用機', { self: true }), dev('W', '工作機')],
  accounts: { list: [], current: null, msg: '', autoNote: '', busy: false, confirmDel: '', allowSwitch: false },
})
const render = async props => {
  globalThis.Vue = Vue
  return renderToString(Vue.createSSRApp({ render: () => Vue.h(SettingsPanel, { title: '設定：設備', st: st(), meAv: '', catKey: 'devices', ...props }) }))
}

// ---------- 1. 標題只留一層 ----------
test('#1864 電腦設定頁：分頁標籤已寫「設定：○○」，所有分類的頁內 h2 都標成「有分頁標籤時收起」（現代、LINE 沒有分頁標籤，照舊顯示）', async () => {
  const html = await render({})
  assert.ok(html.includes('dv-list') || html.includes('dv-set'), '確認真的是設備列表頁')
  assert.match(html, /<h2 class="panel-h panel-h-tabbed">設定：設備<\/h2>/)
  const css = read('ui/style.css')
  const rule = /:root:not\(\[data-skin="modern"\]\):not\(\[data-skin="line"\]\) \.panel-h-tabbed\{display:none\}/
  assert.match(css, rule, '復古外觀把這一層收起；現代與 LINE 不在選擇器內＝仍顯示')
  // 所有設定分類都要帶（舊碼只有 devices 帶，外觀、帳號等分類在復古外觀會疊兩層標題）
  // 其餘分類（通知、語音…）要更多狀態欄位才畫得出來，改驗樣板原始碼：h2 的 class 不依分類而變
  assert.match(read('ui/lib/settings-panel.mjs'), /<h2 :class="\['panel-h', 'panel-h-tabbed'\]" v-if="title && /)
  for (const catKey of ['me', 'devices', 'accounts', 'cloud', 'look', 'about']) {
    const title = '設定：' + SETTING_CATS.find(c => c.key === catKey).title
    const out = await renderToString(Vue.createSSRApp({ render: () => Vue.h(SettingsPanel, { title, st: st(), meAv: '', catKey }) }))
    assert.match(out, /<h2 class="panel-h panel-h-tabbed">/, catKey + ' 分類的頁內標題沒有標成「有分頁標籤時收起」')
  }
})

test('#1864 電腦設備細部頁：只有「‹ 設備名 狀態」一行，沒有 h2；其他分類的頁內標題同樣標成收起', async () => {
  const html = await render({ dev: 'W', devView: 'info' })
  assert.ok(!html.includes('panel-h'))
  assert.match(html, /<div class="dv-dev-h">[\s\S]*?<h3 class="dv-name">工作機<\/h3>[\s\S]*?在線/)
  globalThis.Vue = Vue
  const other = await renderToString(Vue.createSSRApp({ render: () => Vue.h(SettingsPanel, { title: '設定：帳號', st: st(), meAv: '', catKey: 'accounts' }) }))
  assert.match(other, /<h2 class="panel-h panel-h-tabbed">設定：帳號<\/h2>/, '帳號頁沒有「設備名」那一層，頁內標題照常輸出（復古外觀由樣式收起）')
})

test('#1864 手機設備細部頁：標題列直接是「設備名＋狀態」，頁內不再有第二個設備名，也沒有「這支手機」標籤', async () => {
  const { acctHeadView } = await import('../ui/lib/mobile-acct.mjs')   // 動態匯入：main 上沒有這個匯出，靜態匯入會讓整檔 SyntaxError，回退驗證就看不出逐項紅綠
  const w = dev('W', '工作機')
  const head = acctHeadView('devices', w, '已隱藏')
  assert.equal(head.title, '工作機')
  assert.deepEqual(head.tags.map(t => t.text), ['在線'])
  const me = dev('P', '擁有者的手機', { self: true, kind: '手機', kindLabel: '手機', online: false, onlineText: '離線中', hidden: true })
  const h2 = acctHeadView('devices', me, '已隱藏')
  assert.equal(h2.title, '擁有者的手機')
  assert.deepEqual(h2.tags.map(t => t.text), ['手機', '離線中', '已隱藏'])
  assert.ok(!h2.tags.some(t => t.text.includes('這支手機')), '「這支手機」不另寫標籤')
  // 列表／帳號頁沒有細部，標題照舊
  assert.deepEqual(acctHeadView('devices', null), { title: '設備', tags: [] })
  assert.deepEqual(acctHeadView('accounts', null), { title: '帳號', tags: [] })

  const html = read('ui/m.html').replace(/<!--[\s\S]*?-->/g, '')
  assert.match(html, /\{\{ acctHead\.title \}\}/)
  assert.match(html, /v-for="t in acctHead\.tags"/)
  assert.ok(!html.includes('m-dv-name') && !html.includes('m-dv-dh'), '頁內的第二個設備名（h3）與標籤列已拿掉')
  assert.ok(!html.includes('這支手機</span>'))
  assert.match(read('ui/m.js'), /acctHeadView\(acctSw\.tab, acctCur\.value, DEVICE_TEXT\.hiddenTag\)/)
})

// ---------- 2. 字級四檔 ----------
const rulesOf = css => [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(m => ({ sel: m[1].trim(), body: m[2] }))

test('#1864 kit.css 定四檔字級：電腦 11/12/14/16、手機（.m-body）12/14/16/18', () => {
  const css = read('ui/kit.css')
  const root = /:root\{([^}]*)\}/.exec(css)[1]
  const mob = /\.m-body\{([^}]*)\}/.exec(css)[1]
  const lv = (b, n) => new RegExp(`--fs-${n}:\\s*(\\d+)px`).exec(b)?.[1]
  assert.deepEqual([1, 2, 3, 4].map(n => lv(root, n)), ['11', '12', '14', '16'])
  assert.deepEqual([1, 2, 3, 4].map(n => lv(mob, n)), ['12', '14', '16', '18'])
})

test('#1864 設備頁（電腦、手機）的字級全走 --fs-*，沒有寫死的 px', () => {
  const desk = rulesOf(read('ui/style.css')).filter(r => /\.dv-|\.m-dv-|\.panel-h|\.set-h/.test(r.sel))
  const phone = rulesOf(read('ui/mobile.css')).filter(r => /\.m-dv-|\.m-title/.test(r.sel))
  assert.ok(desk.length > 40 && phone.length > 40, '有抓到設備頁的規則')
  const GLYPH = ['.m-dv-chev']   // 列右邊的「›」符號，不是文字字級
  const bad = [...desk, ...phone].filter(r => !GLYPH.includes(r.sel) && /font-size:\s*[\d.]+px/.test(r.body)).map(r => r.sel)
  assert.deepEqual(bad, [], '這些選擇器還寫死 px 字級')
  const get = (rules, sel) => rules.find(r => r.sel === sel)?.body ?? ''
  assert.match(get(desk, '.dv-dev-h .dv-name'), /font-size:var\(--fs-4\)/, '細部頁標題＝頁標題檔')
  assert.match(get(desk, '.dv-name'), /font-size:var\(--fs-3\)/, '列上的設備名＝區塊標題檔')
  assert.match(get(desk, '.set-h'), /font-size:var\(--fs-3\)/, '區塊標題')
  assert.match(get(desk, '.dv-tag'), /font-size:var\(--fs-1\)/, '標籤＝說明小字檔')
  assert.match(get(phone, '.m-title'), /font-size:var\(--fs-4\)/, '手機標題列＝頁標題檔')
  assert.match(get(phone, '.m-dv-tag'), /font-size:var\(--fs-1\)/)
})
