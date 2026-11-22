// #2111 ④：「讀額度」的開關從帳號頁搬到「設備 → 這台」，帳號頁沒開額度上報時改寫引導句
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import * as Vue from 'vue'
import { renderToString } from 'vue/server-renderer'
import { SettingsPanel, SETTING_OPS } from '../ui/lib/settings-panel.mjs'
import { QUOTA_TEXT, createQuotaReaders, quotaGuideFor, quotaGuide, vendorSections } from '../ui/lib/quota-readers.mjs'

const read = p => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')
const GUIDE = '還沒開啟額度上報。到『設備 → 這台』打開『讀 Grok 額度』，這裡就會顯示額度。'
const readers = (over = {}) => ({ grok: false, agy: false, busy: false, msg: '', confirm: '', code: null, extra: false, extraRefresh: false, extraDirs: [], minimax: [], minimaxSupported: true, status: { grok: '', agy: '' }, copied: false, ...over })
const dev = (key, label, self) => ({ key, label, self, kind: '電腦', online: true, onlineText: '在線', reportedText: '', empty: '', hidden: false, removed: false, vendors: [], identity: { title: label, rows: [] } })
const st = (quotaReaders, myAccounts = null) => ({ devices: [dev('H', '家用機', true), dev('W', '工作機', false)], accounts: { list: [], current: null, busy: false, msg: '', allowSwitch: true }, myAccounts, quotaReaders })
const render = async (catKey, state, extra = {}) => {
  globalThis.Vue = Vue
  return renderToString(Vue.createSSRApp({ render: () => Vue.h(SettingsPanel, { st: state, catKey, meAv: '', ...extra }) }))
}
const text = html => html.replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
const myGrok = { title: '帳號', empty: '', vendors: [{ key: 'grok', label: 'Grok', accounts: [] }] }

test('#2111 ④ 帳號頁不再有讀額度的開關與說明', async () => {
  const html = await render('accounts', st(readers({ extraDirs: [{ name: 'a', status: '' }], extra: true, minimax: [{ email: 'a@x.test', hasKey: true, status: '' }] }), myGrok))
  assert.ok(!html.includes('dv-qread'), '帳號頁沒有「這台讀額度」')
  assert.ok(!/<input[^>]*type="checkbox"/.test(html), '帳號頁沒有任何開關')
  for (const s of [QUOTA_TEXT.grok, QUOTA_TEXT.extra, QUOTA_TEXT.refreshOn, QUOTA_TEXT.minimax, QUOTA_TEXT.minimaxOpen, QUOTA_TEXT.agy]) {
    assert.ok(!text(html).replace(GUIDE, '').includes(s), `帳號頁不該出現「${s}」`)
  }
  const tpl = SettingsPanel.template
  const acct = tpl.slice(tpl.indexOf(`cat === 'accounts'`), tpl.indexOf(`cat === 'devices'`))
  assert.ok(!/quota-source|quota-refresh|quota-mm-add|quota-mm-remove/.test(acct), '帳號頁的樣板沒有讀額度的指令')
})

test('#2111 ④ 設備 → 這台 有「這台讀額度」各列，開關反映設定', async () => {
  const off = text(await render('devices', st(readers({ extraDirs: [{ name: 'a', status: '' }] })), { dev: 'H' }))
  assert.ok(off.includes('這台讀額度'))
  for (const s of ['讀 Grok 額度', '讀 Gemini 額度', '讀 Claude 額外帳號', 'MiniMax', '加入帳號', '要開著 Gemini 視窗才會更新。']) assert.ok(off.includes(s), s)
  const html = await render('devices', st(readers({ grok: true, extra: true, extraDirs: [{ name: 'a', status: '' }] })), { dev: 'H' })
  assert.equal([...html.matchAll(/class="dv-qsw" type="checkbox"[^>]*checked/g)].length, 2, 'Grok 與額外帳號兩個開關是開的')
  const none = await render('devices', st(readers()), { dev: 'H' })
  assert.ok(!text(none).includes('讀 Claude 額外帳號'), '沒有額外帳號就沒有那一列')
  assert.equal([...none.matchAll(/class="dv-qsw" type="checkbox"/g)].length, 1, '只有 Grok 一個開關（Gemini 的開關先藏起來，MiniMax 沒有開關）')
  const other = await render('devices', st(readers()), { dev: 'W' })
  assert.ok(!other.includes('dv-qread'), '別台設備不放這一區（讀額度只管這台）')
})

test('#2111 ④ 開關呼叫的是既有命令：樣板送 quota-source，樞紐轉成 quota_readers_set，指令清單沒變', async () => {
  const tpl = SettingsPanel.template
  assert.match(tpl, /class="dv-qsw" type="checkbox" :checked="st\.quotaReaders\.grok"[^>]*@change="act\('quota-source', \{ source: 'grok', on: \$event\.target\.checked \}\)"/)
  assert.match(tpl, /class="dv-qsw" type="checkbox" :checked="st\.quotaReaders\.extra"[^>]*@change="act\('quota-source', \{ source: 'extra_claude', on: \$event\.target\.checked \}\)"/)
  for (const op of ['quota-source', 'quota-refresh', 'quota-mm-add', 'quota-mm-remove']) assert.ok(SETTING_OPS.includes(op), op)
  assert.match(read('ui/list.js'), /case 'quota-source': await quotaReaders\.setSource\(value\?\.source, value\?\.on\)/)
  const calls = []
  const ui = createQuotaReaders({ invoke: async (c, a) => { calls.push([c, a]); return { grok: true } } })
  await ui.setSource('grok', true)
  assert.deepEqual(calls, [['quota_readers_set', { source: 'grok', on: true }]])
  assert.equal(ui.state.grok, true)
})

test('#2111 ④ 沒開額度上報：帳號頁的 Grok 區段寫引導句；開了就不寫', async () => {
  assert.equal(GUIDE, quotaGuide('Grok'))
  const off = await render('accounts', st(readers(), myGrok))
  assert.ok(text(off).includes(GUIDE), '沒開：寫引導句')
  const on = await render('accounts', st(readers({ grok: true }), myGrok))
  assert.ok(!text(on).includes('還沒開啟額度上報'), '開了：不寫')
  const noAcct = await render('accounts', st(readers(), { title: '帳號', empty: '', vendors: [] }))
  assert.ok(text(noAcct).includes(GUIDE), '沒有 Grok 帳號、也沒開：照樣寫（空區段）')
  assert.equal(quotaGuideFor('grok', readers({ grok: true })), '')
  assert.equal(quotaGuideFor('claude', readers()), '', 'Claude 沒有這種引導')
  assert.equal(quotaGuideFor('gemini', readers()), '', 'Gemini 的開關先藏起來，不指一個不存在的開關')
  assert.deepEqual(vendorSections(null, readers({ grok: true })), [])
})

test('#2111 ④ MiniMax：沒有開關只有「加入帳號」；只能在 Windows 設定時寫明、不放鈕', async () => {
  const ok = await render('devices', st(readers()), { dev: 'H' })
  const row = ok.slice(ok.indexOf('data-reader="minimax"'))
  assert.ok(text(row.slice(0, row.indexOf('</li>'))).includes('加入帳號'))
  assert.ok(!/data-reader="minimax"[\s\S]*?<\/li>/.exec(ok)[0].includes('type="checkbox"'), 'MiniMax 那一列沒有開關')
  const no = await render('devices', st(readers({ minimaxSupported: false })), { dev: 'H' })
  const row2 = /data-reader="minimax"[\s\S]*?<\/li>/.exec(no)[0]
  assert.ok(text(row2).includes('只能在 Windows 電腦設定。'))
  assert.ok(!row2.includes('<button'), '不放鈕')
  assert.ok(!no.includes('type="password"'), '也沒有輸入欄')
})

test('#2111 ④ 手機沒有讀額度的設定，所以手機的「設備 → 這台」不放這一區', () => {
  for (const f of ['ui/m.js', 'ui/m.html']) assert.doesNotMatch(read(f), /quota_readers|quotaReaders|這台讀額度|quota-source/, f)
  assert.match(fs.readFileSync(new URL('../../../docs/設定值清單.md', import.meta.url), 'utf8'), /手機沒有這些設定/)
})

test('#2111 ④ 說明文字只留能動手的話；自動換新的風險與警告還在', () => {
  assert.ok(!('agyNote' in QUOTA_TEXT) && !('extraNote' in QUOTA_TEXT) && !('thisPc' in QUOTA_TEXT))
  assert.equal(QUOTA_TEXT.agyShort, '要開著 Gemini 視窗才會更新。')
  assert.equal(QUOTA_TEXT.minimaxUnsupported, '只能在 Windows 電腦設定。')
  assert.match(QUOTA_TEXT.refreshRisk, /可能隨時失效.*服務條款/)
  assert.match(QUOTA_TEXT.refreshWarn, /只能有一個程式在換新.*被登出/)
})

test('#2111 ④ 讀額度的訊息只在「這台讀額度」卡片顯示，帳號頁不重複', async () => {
  const msgState = readers({ msg: '沒有成功，請稍後再試。' })
  const acct = await render('accounts', st(msgState, myGrok))
  assert.ok(!text(acct).includes('沒有成功，請稍後再試。'), '帳號頁不再顯示讀額度的訊息')
  const devPage = await render('devices', st(msgState), { dev: 'H' })
  assert.ok(text(devPage).includes('沒有成功，請稍後再試。'), '新卡片顯示')
  assert.equal(devPage.split('沒有成功，請稍後再試。').length - 1, 1, '只顯示一次')
})
