// 設定「設備與帳號」合併頁：原本的「帳號」與「設備」兩類併成一頁。
// 三層：橫向設備頁籤 → 該設備的廠商卡片 → 廠商底下的帳號列。本機那一頁有完整帳號管理，其他設備的 Claude 帳號走既有的遠端切換對話框。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import * as Vue from 'vue'
import { renderToString } from 'vue/server-renderer'
import { SETTING_CATS, SETTING_KEYS, catByKey, catSummary, normalizeCatKey } from '../ui/lib/settings-cats.mjs'
import { SETTING_OPS, SettingsPanel } from '../ui/lib/settings-panel.mjs'
import { panelTitle } from '../ui/lib/panels.mjs'
import { buildDeviceTree } from '../ui/lib/device-tree.mjs'
import { VENDOR_ICON_KEYS, vendorIconSvg } from '../ui/lib/vendor-icons.mjs'

const read = f => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')

// ---------- 分類 ----------
test('分類：帳號與設備併成一類（鍵沿用 devices、標題「設備與帳號」），舊的 accounts 鍵正規化到 devices', () => {
  assert.ok(!SETTING_KEYS.includes('accounts'))
  assert.equal(SETTING_KEYS.filter(k => k === 'devices').length, 1)
  assert.equal(catByKey('devices').title, '設備與帳號')
  assert.ok(!SETTING_CATS.some(c => c.title === '帳號' || c.title === '設備'))
  assert.equal(normalizeCatKey('accounts'), 'devices')
  assert.equal(normalizeCatKey('devices'), 'devices')
  assert.equal(normalizeCatKey('look'), 'look')
  assert.equal(catByKey('accounts')?.key, 'devices', '舊存檔或連結裡的 accounts 還找得到')
  assert.equal(panelTitle('setting', 'accounts'), '設定：設備與帳號')
  assert.equal(catByKey('nope'), null)
})

test('摘要：設備數與帳號數合在一行，缺欄位不丟錯', () => {
  const devices = [{ online: true }, { online: false }, { online: true }]
  assert.equal(catSummary('devices', { devices, accountCount: 2, accountCurrent: 'a@x.test' }), '3 台設備，2 台在線；2 個 Claude 帳號，使用中：a@x.test')
  assert.equal(catSummary('devices', { devices, accountCount: 0 }), '3 台設備，2 台在線；還沒有加入過帳號')
  assert.equal(catSummary('devices', { devices, accountCount: 0, accountCurrent: 'a@x.test' }), '3 台設備，2 台在線；使用中：a@x.test（還沒加入帳號庫）')
  assert.equal(catSummary('devices', { devices, accountCount: 2 }), '3 台設備，2 台在線；2 個 Claude 帳號')
  assert.ok(catSummary('devices', {}).trim())
  assert.equal(catSummary('accounts', { devices, accountCount: 2 }), catSummary('devices', { devices, accountCount: 2 }), '舊鍵給同一句')
})

// ---------- 資料：每個廠商帶帳號清單 ----------
test('設備樹：廠商帶出各自的帳號清單（email、方案、使用中），沒回報的是空陣列', () => {
  const S = 'aaaaaaaa-0000-4000-8000-000000000001', W = 'bbbbbbbb-0000-4000-8000-000000000002'
  const fr = (node, device, engine) => ({ node, device, engine, kind: 'pc', status: 'online', id: `${node}/${engine}` })
  const t = buildDeviceTree({
    friends: [fr(S, '家用機', 'claude'), fr(S, '家用機', 'gemini'), fr(W, '工作機', 'claude')], nodeOrder: [S, W], selfNode: S,
    asn: { [W]: [{}] },
    reports: { [W]: { error: '', asnOnline: true, reportedAt: new Date().toISOString(), accounts: [{ vendor: 'claude', email: 'w1@x.test', plan: 'pro', current: true }, { vendor: 'claude', email: 'w2@x.test', plan: 'pro', current: false }] } },
    self: { claude: [{ email: 's@x.test', plan: 'max', current: true }], codex: { loggedIn: true, text: 'c@x.test · plus' } },
  })
  const self = t.find(d => d.self), w = t.find(d => !d.self)
  assert.deepEqual(self.vendors.find(v => v.key === 'claude').accounts, [{ email: 's@x.test', plan: 'max', current: true, quota: { known: false, text: '額度未知', meta: '', resetText: '', stale: true, exhausted: false } }])   // Claude 帳號都帶額度；沒有紀錄就是「額度未知」
  assert.deepEqual(self.vendors.find(v => v.key === 'gemini').accounts, [])
  assert.equal(self.vendors.find(v => v.key === 'codex').accounts[0].email, 'c@x.test · plus')
  assert.deepEqual(w.vendors.find(v => v.key === 'claude').accounts.map(a => a.email), ['w1@x.test', 'w2@x.test'])
})

// ---------- 畫面 ----------
const ACCT = { list: [{ email: 'a@b.c', plan: 'Max', current: true, saved: true }, { email: 'p@b.c', plan: '', current: false, saved: true }], current: { email: 'a@b.c', plan: 'Max', current: true, saved: true }, codexLine: 'x@openai.test · plus', busy: false, confirmDel: '', msg: '', trustOwn: false, autoAdd: true, autoNote: '', mod: '', remote: { node: '', devices: [], list: [], loading: false, busy: false, msg: '' } }
const vend = (key, label, accounts, o = {}) => ({ key, label, account: accounts.length ? '有帳號' : '未回報', reported: accounts.length > 0, extra: '', accounts, switchable: false, switchHint: '', ...o })
const devs = () => [
  { key: 'H', label: '家用機', self: true, kind: '電腦', online: true, onlineText: '在線', reportedText: '', empty: '', vendors: [
    vend('claude', 'Claude', ACCT.list), vend('codex', 'OpenAI（Codex）', [{ email: 'x@openai.test', plan: 'plus', current: true }]), vend('gemini', 'Gemini', [])] },
  { key: 'W', label: '工作機', self: false, kind: '電腦', online: true, onlineText: '在線', reportedText: '帳號最後回報：3 分鐘前', empty: '', vendors: [
    vend('claude', 'Claude', [{ email: 'w1@b.c', plan: 'pro', current: true }, { email: 'w2@b.c', plan: 'max', current: false }], { switchable: true }),
    vend('grok', 'Grok', []), vend('pi', 'Pi', [{ email: 'pi@b.c', plan: '', current: true }])] },
  { key: 'G', label: 'Grok 雲端', self: false, kind: '電腦', online: false, onlineText: '離線', reportedText: '', empty: '', vendors: [
    vend('claude', 'Claude', [{ email: 'g1@b.c', plan: '', current: true }, { email: 'g2@b.c', plan: '', current: false }], { switchable: false, switchHint: '對方電腦的 ASN 沒有在線，無法切換' })] },
  { key: 'E', label: '空設備', self: false, kind: '電腦', online: false, onlineText: '離線', reportedText: '', empty: '這台設備還沒有回報任何廠商', vendors: [] },
]
const st = (over = {}) => ({ devices: devs(), accounts: { ...ACCT }, ...over })
const render = async (props, state = st()) => {
  globalThis.Vue = Vue
  return renderToString(Vue.createSSRApp({ render: () => Vue.h(SettingsPanel, { st: state, meAv: '', ...props }) }))
}

test('頁首：設定圖示與標題（10-25 起拿掉說明文字與「重新整理」，細節在 device-list-page.test.mjs）', async () => {
  const html = await render({ catKey: 'devices' })
  assert.ok(!html.includes('dv-title'), '設定視窗標題已是「設備與帳號」，面板內不重複')
  assert.ok(!html.includes('只有 Claude 帳號能從這裡切換') && !html.includes('重新整理'))
})

test('第 1 層：進入先是設備列表（不再是橫向頁籤）：每台一列，附線上／離線標籤，右邊有「›」', async () => {
  const html = await render({ catKey: 'devices' })
  const rows = [...html.matchAll(/<li[^>]*class="dv-row[^"]*"[\s\S]*?<\/li>/g)].map(m => m[0])
  assert.equal(rows.length, 4)
  assert.ok(!html.includes('role="tablist"') && !html.includes('role="tab"'))
  assert.match(rows[0], /家用機/)
  assert.match(rows[1], /dv-tag on[^>]*>在線/); assert.match(rows[2], /dv-tag off[^>]*>離線/)
  for (const r of rows) assert.ok(r.includes('dv-chev'))
})

test('進入細部頁：指定 dev 才進；沒指定或認不得的鍵都留在列表（不再自動選「這台」）', async () => {
  const noSelf = st({ devices: devs().map(d => ({ ...d, self: false })) })
  assert.ok((await render({ catKey: 'devices' }, noSelf)).includes('class="dv-list"'))
  assert.match(await render({ catKey: 'devices', dev: 'W' }), /dv-dev-h[\s\S]*工作機/)
  assert.ok((await render({ catKey: 'devices', dev: 'zzz' })).includes('class="dv-list"'))
})

test('第 2 層：設備標題（名稱、類型標籤、在線標籤）與一列一個的廠商卡片（我們自己的圖示）', async () => {
  const html = await render({ catKey: 'devices', dev: 'W' })
  assert.match(html, /<h3 class="dv-name">工作機<\/h3>/)
  assert.ok(!html.includes('class="dv-tag kind">電腦<'), '電腦類型標籤多餘，不顯示'); assert.match(html, /class="dv-tag on">在線</)
  assert.ok(html.includes('帳號最後回報：3 分鐘前'))
  const cards = [...html.matchAll(/<li class="dv-vendor[^"]*"/g)]
  assert.equal(cards.length, 3)
  for (const k of ['claude', 'grok', 'pi']) assert.ok(html.includes(vendorIconSvg(k)), `${k} 圖示用 vendorIconSvg`)
  assert.ok(!html.includes(vendorIconSvg('gemini')), '別台的廠商圖示不混進來')
})

test('第 3 層（其他設備）：Claude 每個帳號一列——信箱、方案、使用中或「切換」；沒回報的廠商是虛線框', async () => {
  const html = await render({ catKey: 'devices', dev: 'W' })
  const rows = [...html.matchAll(/<li class="dv-acct[^"]*"[\s\S]*?<\/li>/g)].map(m => m[0])
  const w1 = rows.find(r => r.includes('w1@b.c')), w2 = rows.find(r => r.includes('w2@b.c'))
  assert.ok(w1.includes('class="dv-plan">pro<') && w1.includes('class="dv-cur">使用中<') && !w1.includes('切換'))
  assert.ok(w2.includes('class="dv-plan">max<') && w2.includes('>切換<') && !w2.includes('使用中'))
  assert.ok(!/<button[^>]*disabled[^>]*>切換/.test(w2), '對方 ASN 在線＝可切換')
  assert.match(html, /class="dv-none"[^>]*>[\s\S]*目前未回報任何帳號/)
  // 其他廠商只顯示：沒有任何切換或刪除
  const pi = rows.find(r => r.includes('pi@b.c'))
  assert.ok(!pi.includes('<button') && pi.includes('使用中'))
  assert.ok(!/<button[^>]*>(刪除|確認刪除|加入目前登入的帳號)</.test(html), '別台沒有帳號管理')
})

test('其他設備的「切換」送既有的 device-switch（帶設備與信箱），樞紐沿用右鍵切換的確認對話框', () => {
  assert.match(SettingsPanel.template, /act\('device-switch', \{ node: curDev.key, email: a\.email, vendor: v\.key \}\)/)
  const hub = read('ui/list.js')
  assert.ok(hub.includes("case 'device-switch'") && hub.includes('openDeviceAcct('))
  assert.match(hub, /openDeviceAcct = async \(node, email = '', vendor = 'claude'\)/, '可帶預選的信箱')
  assert.match(hub, /deviceAcct\.selected = email/)
})

test('對方 ASN 沒在線：切換鈕停用並寫原因；離線設備整體偏灰；沒回報任何廠商顯示整塊空狀態', async () => {
  const g = await render({ catKey: 'devices', dev: 'G' })
  assert.match(g, /<button[^>]*disabled[^>]*>切換<\/button>/)
  assert.ok(g.includes('對方電腦的 ASN 沒有在線，無法切換'))
  assert.match(g, /class="dv-body off"/); assert.match(g, /class="dv-tag off">離線</)
  const e = await render({ catKey: 'devices', dev: 'E' })
  assert.match(e, /class="dv-empty"[^>]*>[\s\S]*這台設備還沒有回報任何廠商/)
  assert.ok(!e.includes('dv-vendor'))
  assert.ok(!(await render({ catKey: 'devices', dev: 'W' })).includes('dv-empty'))
})

test('這台的頁籤：完整的帳號管理（切換、刪除、加入、自動加入、信任自己的設備）都在', async () => {
  const html = await render({ catKey: 'devices', dev: 'H' })
  for (const w of ['a@b.c', 'p@b.c', '使用中', '切換', '刪除', '信任我自己的設備', '邀請雲端代理', 'x@openai.test', '這台']) assert.ok(html.includes(w), `少了「${w}」`)
  const cur = /<li class="dv-acct[^"]*"[^>]*>(?:(?!<\/li>)[\s\S])*a@b\.c[\s\S]*?<\/li>/.exec(html)[0]
  assert.match(cur, /<button[^>]*disabled[^>]*>切換<\/button>/, '使用中的帳號不能再切換')
  for (const op of ['acct-switch', 'acct-remove', 'acct-trust', 'acct-trust-signed']) assert.ok(SettingsPanel.template.includes(`act('${op}'`), op)
  assert.ok(!html.includes('加入目前登入的帳號') && !html.includes('<span>自動加入</span>'), '加入按鈕與自動加入勾選已拿掉（固定自動加入）')
})

test('這台的頁籤：刪除要二次確認、忙碌時按鈕停用、警告與狀態列照實顯示；沒登入 Claude 時寫提示', async () => {
  const a = { ...ACCT, confirmDel: 'p@b.c', busy: true, msg: '已切換', mod: '外掛已安裝', autoNote: '已自動加入 q@b.c', current: { email: 'z@b.c', saved: false } }
  const html = await render({ catKey: 'devices', dev: 'H' }, st({ accounts: a }))
  assert.ok(html.includes('確認刪除') && html.includes('已切換') && html.includes('外掛已安裝') && html.includes('已自動加入 q@b.c'))
  assert.ok(html.includes('目前登入的 z@b.c 還沒加入帳號庫'))
  const none = await render({ catKey: 'devices', dev: 'H' }, st({ accounts: { ...ACCT, list: [], current: null }, devices: [{ ...devs()[0], vendors: [] }, ...devs().slice(1)] }))
  assert.ok(none.includes('這台電腦目前沒有 Claude 登入。') && none.includes('還沒有加入過帳號。'))
})

test('這台沒有 Codex 登入：Codex 卡片寫登入說明，不整張消失', async () => {
  const d = devs(); d[0].vendors = d[0].vendors.filter(v => v.key !== 'codex')
  const html = await render({ catKey: 'devices', dev: 'H' }, st({ devices: d, accounts: { ...ACCT, codexLine: '這台電腦目前沒有登入 Codex。' } }))
  assert.ok(html.includes('這台電腦目前沒有登入 Codex。') && html.includes(vendorIconSvg('codex')))
})

test('舊的 accounts 鍵與新的 devices 鍵畫出同一頁；其他類別不混進來', async () => {
  assert.equal(await render({ catKey: 'accounts' }), await render({ catKey: 'devices' }))
  const look = await render({ catKey: 'look' }, st({ frame: 'custom', mode: 'merged', dpMode: 'left', toolbar: 'top', bubble: 'none' }))
  assert.ok(!look.includes('dv-set') && !look.includes('重新整理'))
})

test('遠端設備下拉選單已被頁籤取代：元件與樞紐不再有 acct-remote-node／acct-remote-switch，其餘指令清單一致', () => {
  assert.ok(!SETTING_OPS.includes('acct-remote-node') && !SETTING_OPS.includes('acct-remote-switch'))
  assert.ok(!read('ui/lib/settings-panel.mjs').includes('acct-remote'))
  assert.ok(!read('ui/list.js').includes("case 'acct-remote"))
  for (const op of ['acct-switch', 'acct-remove', 'acct-trust', 'acct-trust-signed', 'device-switch', 'device-reorder', 'device-remove']) assert.ok(SETTING_OPS.includes(op), op)
})

test('守門：不引入 Tailwind 或外部網址；樣式只用既有的 CSS 變數；畫面不顯示節點代號', () => {
  const css = read('ui/style.css'), panel = read('ui/lib/settings-panel.mjs')
  const dv = css.split('\n').filter(l => /\.dv-/.test(l)).join('\n')
  assert.ok(dv.length > 400, '有 dv- 樣式')
  assert.ok(!/tailwind|cdn\.|googleapis|https?:\/\//i.test(dv + panel + read('ui/lib/device-tree.mjs')))
  assert.ok(/var\(--line\)/.test(dv) && /var\(--panel/.test(dv) && /var\(--accent\)/.test(dv) && /var\(--online\)/.test(dv))
  const block = panel.slice(panel.indexOf('class="dv-set"'), panel.indexOf("catKey === 'look'"))
  assert.ok(!/\{\{[^}]*\.key\s*}}|partnerId|\.node\b/.test(block))
})

test('守門：廠商圖示鍵齊全（claude、codex、gemini、grok、deepseek、minimax、pi、aegis、other）', () => {
  for (const k of ['claude', 'codex', 'gemini', 'grok', 'deepseek', 'minimax', 'pi', 'aegis', 'other']) assert.ok(VENDOR_ICON_KEYS.includes(k), k)
})

test('手機版沒有設定的帳號／設備分類：只做電腦版（手機設置頁維持原狀）', () => {
  const js = read('ui/m.js') + read('ui/m.html')
  assert.ok(!js.includes('settings-panel') && !js.includes('SETTING_CATS'))
})
