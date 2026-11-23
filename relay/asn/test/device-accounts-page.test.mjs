// 設定「設備與帳號」合併頁：原本的「帳號」與「設備」兩類併成一頁。
// 三層：橫向設備頁籤 → 該設備的廠商卡片 → 廠商底下的帳號列。本機那一頁有完整帳號管理，其他設備的 Claude 帳號走既有的遠端切換對話框。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import * as Vue from 'vue'
import { renderToString as ssrRender } from 'vue/server-renderer'
// 共用元件的插槽會在輸出裡留下片段標記，比對畫面文字前先拿掉
const renderToString = async app => (await ssrRender(app)).replace(/<!--\[-->|<!--\]-->/g, '')
import { SETTING_CATS, SETTING_KEYS, catByKey, catSummary, normalizeCatKey } from '../ui/lib/settings-cats.mjs'
import { SETTING_OPS, SettingsPanel } from '../ui/lib/settings-panel.mjs'
import { panelTitle } from '../ui/lib/panels.mjs'
import { buildDeviceTree } from '../ui/lib/device-tree.mjs'
import { VENDOR_ICON_KEYS, vendorIconSvg } from '../ui/lib/vendor-icons.mjs'

const read = f => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')

// ---------- 分類 ----------
test('分類：「設備與帳號」拆成「設備」（devices）和「帳號」（accounts）兩類，沒有別名；自己的 ASN 帳號仍在「個人」', () => {
  assert.ok(SETTING_KEYS.includes('devices') && SETTING_KEYS.includes('accounts'))
  assert.equal(SETTING_KEYS.filter(k => k === 'devices').length, 1)
  assert.equal(catByKey('devices').title, '設備')
  assert.equal(catByKey('accounts').title, '帳號')
  assert.ok(!SETTING_CATS.some(c => c.title === '設備與帳號'), '畫面上不再有「設備與帳號」')
  assert.equal(normalizeCatKey('accounts'), 'accounts')
  assert.equal(normalizeCatKey('devices'), 'devices')
  assert.equal(normalizeCatKey('look'), 'look')
  assert.equal(catByKey('me').title, '個人')
  assert.equal(panelTitle('setting', 'accounts'), '設定：帳號')
  assert.equal(panelTitle('setting', 'devices'), '設定：設備')
  assert.equal(catByKey('nope'), null)
  // 順序：個人、設備、帳號
  assert.deepEqual(SETTING_KEYS.slice(0, 3), ['me', 'devices', 'accounts'])
})

test('摘要：設備頁寫設備數與在線數，帳號頁寫本機 Claude 帳號庫；缺欄位不丟錯', () => {
  const devices = [{ online: true }, { online: false }, { online: true }]
  assert.equal(catSummary('devices', { devices, accountCount: 2 }), '3 台設備，2 台在線')
  assert.equal(catSummary('accounts', { devices, accountCount: 2, accountCurrent: 'a@x.test' }), '2 個 Claude 帳號，使用中：a@x.test')
  assert.equal(catSummary('accounts', { devices, accountCount: 0 }), '還沒有加入過帳號')
  assert.equal(catSummary('accounts', { devices, accountCount: 0, accountCurrent: 'a@x.test' }), '使用中：a@x.test（還沒加入帳號庫）')
  assert.equal(catSummary('accounts', { devices, accountCount: 2 }), '2 個 Claude 帳號')
  assert.ok(catSummary('devices', {}).trim() && catSummary('accounts', {}).trim())
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
  assert.deepEqual(self.vendors.find(v => v.key === 'claude').accounts, [{ email: 's@x.test', plan: 'max', current: true, incomplete: false, quota: { known: false, text: '讀取中', parts: ['讀取中'], meta: '', listMeta: '', ageLabel: '', readNodes: [], resetText: '', bars: [], stale: true, exhausted: false, gone: false } }])   // Claude 帳號都帶額度；這台還沒查到就是「讀取中」（#1883）
  assert.deepEqual(self.vendors.find(v => v.key === 'gemini').accounts, [])
  assert.equal(self.vendors.find(v => v.key === 'codex').accounts[0].email, 'c@x.test · plus')
  assert.deepEqual(w.vendors.find(v => v.key === 'claude').accounts.map(a => a.email), ['w1@x.test', 'w2@x.test'])
})

// ---------- 畫面 ----------
const ACCT = { list: [{ email: 'a@b.c', plan: 'Max', current: true, saved: true }, { email: 'p@b.c', plan: '', current: false, saved: true }], current: { email: 'a@b.c', plan: 'Max', current: true, saved: true }, codexLine: 'x@openai.test · plus', busy: false, confirmDel: '', msg: '', trustOwn: false, autoAdd: true, autoNote: '', mod: '', remote: { node: '', devices: [], list: [], loading: false, busy: false, msg: '' } }
const vend = (key, label, accounts, o = {}) => ({ key, label, account: accounts.length ? '有帳號' : '未回報', reported: accounts.length > 0, extra: '', accounts, switchable: false, switchHint: '', ...o })
import { withIdentity } from './helpers/with-identity.mjs'
const devs = () => [
  { key: 'H', label: '家用機', self: true, kind: '電腦', online: true, onlineText: '在線', reportedText: '', empty: '', vendors: [
    vend('claude', 'Claude', ACCT.list), vend('codex', 'OpenAI（Codex）', [{ email: 'x@openai.test', plan: 'plus', current: true }]), vend('gemini', 'Gemini', [])] },
  { key: 'W', label: '工作機', self: false, kind: '電腦', online: true, onlineText: '在線', reportedText: '帳號最後回報：3 分鐘前', empty: '', vendors: [
    vend('claude', 'Claude', [{ email: 'w1@b.c', plan: 'pro', current: true }, { email: 'w2@b.c', plan: 'max', current: false }], { switchable: true }),
    vend('grok', 'Grok', []), vend('pi', 'Pi', [{ email: 'pi@b.c', plan: '', current: true }])] },
  { key: 'G', label: 'Grok 雲端', self: false, kind: '電腦', online: false, onlineText: '離線', reportedText: '', empty: '', vendors: [
    vend('claude', 'Claude', [{ email: 'g1@b.c', plan: '', current: true }, { email: 'g2@b.c', plan: '', current: false }], { switchable: false, switchHint: '對方電腦的 ASN 沒有在線，無法切換' })] },
  { key: 'E', label: '空設備', self: false, kind: '電腦', online: false, onlineText: '離線', reportedText: '', empty: '這台設備還沒有回報任何廠商', vendors: [] },
].map(withIdentity)
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
  assert.match(rows[1], /<small class="dv-sub">電腦 · 在線<\/small>/)
  assert.match(rows[2], /<small class="dv-sub">電腦 · 離線中<\/small>/)
  for (const r of rows) assert.ok(!r.includes('dv-chev') && !r.includes('>帳號<') && r.includes('>詳情<'), '右邊只有一顆「詳情」')
})

test('進入細部頁：指定 dev 才進；沒指定或認不得的鍵都留在列表（不再自動選「這台」）', async () => {
  const noSelf = st({ devices: devs().map(d => ({ ...d, self: false })) })
  assert.ok((await render({ catKey: 'devices' }, noSelf)).includes('class="dv-list"'))
  assert.match(await render({ catKey: 'devices', dev: 'W' }), /dv-dev-h[\s\S]*工作機/)
  assert.ok((await render({ catKey: 'devices', dev: 'zzz' })).includes('class="dv-list"'))
})

test('第 2 層：設備標題（名稱、類型標籤、在線標籤）；詳情沒有帳號、廠商卡片（#1860）', async () => {
  const html = await render({ catKey: 'devices', dev: 'W' })
  assert.match(html, /<h3 class="dv-name">工作機<\/h3>/)
  assert.ok(!html.includes('class="dv-tag kind">電腦<'), '電腦類型標籤多餘，不顯示'); assert.match(html, /class="dv-tag on">在線</)
  assert.ok(!html.includes('最後回報'), '帳號的事（回報時間）不放設備辨認區，只放帳號頁（#1879）')
  assert.ok(!html.includes('dv-vendor') && !html.includes('asn-aline') && !html.includes('w1@b.c'), '詳情裡沒有廠商卡片與帳號行：帳號只在設定的「帳號」頁')
  for (const k of ['claude', 'grok', 'pi']) assert.ok(!html.includes(vendorIconSvg(k)), `${k} 圖示不在詳情`)
})

test('設備頁不再送帳號相關的指令：沒有 open-accounts／device-switch 的鈕，切換只在帳號頁的設備列（row-switch）', () => {
  const t = SettingsPanel.template, devicesPage = t.slice(t.indexOf("cat === 'devices'"))
  assert.ok(!devicesPage.includes("act('device-switch'"), '設備頁不再有 device-switch 的鈕')
  assert.ok(!read('ui/lib/settings-panel.mjs').includes('open-accounts'), '帳號行拿掉之後，沒有人再送 open-accounts')
  assert.ok(!read('ui/list.js').includes("case 'open-accounts'"), '樞紐也不再留 open-accounts')
  assert.ok(read('ui/list.js').includes("case 'device-switch'") && read('ui/list.js').includes('openDeviceAcct('), 'device-switch 本身留給右鍵選單等其他入口')
})

test('對方 ASN 沒在線：離線設備的詳情照常打開，在線標籤寫離線；沒回報任何廠商的設備也一樣', async () => {
  const g = await render({ catKey: 'devices', dev: 'G' })
  assert.ok(!/<button[^>]*>切換<\/button>/.test(g), '設備頁沒有切換鈕')
  assert.ok(!g.includes('g1@b.c') && !g.includes('g2@b.c'), '帳號不在詳情')
  assert.match(g, /class="dv-tag off">離線</)
  const e = await render({ catKey: 'devices', dev: 'E' })
  assert.match(e, /<h3 class="dv-name">空設備<\/h3>/)
  assert.ok(!e.includes('這台設備還沒有回報任何廠商'), '沒回報廠商也不寫在詳情裡（帳號頁才講帳號）')
})

test('這台的詳情：「允許別台設備替這台切換帳號」在連線安全裡；沒有帳號行、加入、切換、刪除', async () => {
  const html = await render({ catKey: 'devices', dev: 'H' })
  const safety = html.slice(html.indexOf('連線安全'))
  assert.ok(safety.includes('允許別台設備替這台切換帳號') && safety.includes('勾了之後，手機或別台設備可以替這台切換 Claude 帳號。'), '設定放進連線安全')
  assert.ok(!html.includes('允許切換帳號') && !html.includes('a@b.c') && !html.includes('x@openai.test'), '舊位置的設定與帳號行都沒有了')
  assert.ok(!html.includes('邀請雲端代理'), '雲端代理只放設備列表頁，細部頁沒有（asn真 在 #678 的要求）')
  assert.ok(!/<button[^>]*>(切換|刪除|確認刪除)<\/button>/.test(html), '切換與刪除不在設備頁')
  assert.ok(SettingsPanel.template.includes("act('acct-allow-switch'"))
  assert.ok(!html.includes('加入目前登入的帳號') && !html.includes('<span>自動加入</span>'), '加入按鈕與自動加入勾選已拿掉（固定自動加入）')
})

test('別台的詳情沒有「允許別台設備替這台切換帳號」（只有這台自己能設）', async () => {
  const html = await render({ catKey: 'devices', dev: 'W' })
  assert.ok(!html.includes('允許別台設備替這台切換帳號'))
})

test('「設備」和「帳號」是兩頁：各畫各的，不混在一起；其他類別不混進來', async () => {
  const dev = await render({ catKey: 'devices' }), acct = await render({ catKey: 'accounts' })
  assert.notEqual(dev, acct)
  assert.ok(!dev.includes('class="dv-my"'), '設備頁沒有「我的帳號」')
  assert.ok(!acct.includes('class="dv-list"') && !acct.includes('雲端代理'), '帳號頁沒有設備列表與雲端代理')
  const look = await render({ catKey: 'look' }, st({ frame: 'custom', mode: 'merged', dpMode: 'left', toolbar: 'top', bubble: 'none' }))
  assert.ok(!look.includes('dv-set') && !look.includes('重新整理'))
})

test('遠端設備下拉選單已被頁籤取代：元件與樞紐不再有 acct-remote-node／acct-remote-switch，其餘指令清單一致', () => {
  assert.ok(!SETTING_OPS.includes('acct-remote-node') && !SETTING_OPS.includes('acct-remote-switch'))
  assert.ok(!read('ui/lib/settings-panel.mjs').includes('acct-remote'))
  assert.ok(!read('ui/list.js').includes("case 'acct-remote"))
  for (const op of ['acct-allow-switch', 'device-reorder', 'device-remove']) assert.ok(SETTING_OPS.includes(op), op)
  for (const op of ['acct-switch', 'grok-switch', 'device-switch', 'acct-remove', 'open-accounts']) assert.ok(!SETTING_OPS.includes(op), `#2111 ⑦／#1860：設備頁不再送 ${op}（切換只在帳號頁；帳號行與它的刪除隨設備詳情的帳號區拿掉）`)
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

test('手機版沒有設定的帳號／設備分類：只做電腦版（手機設定頁維持原狀）', () => {
  const js = read('ui/m.js') + read('ui/m.html')
  assert.ok(!js.includes('settings-panel') && !js.includes('SETTING_CATS'))
})

test('帳號切換只剩一個勾「允許別台設備替這台切換帳號」，底下只有一行說明，舊的兩個勾與長說明都拿掉（#371；#1860 搬進連線安全）', () => {
  const t = SettingsPanel.template
  assert.ok(t.includes('<span>允許別台設備替這台切換帳號</span></label>') && t.includes('<small>勾了之後，手機或別台設備可以替這台切換 Claude 帳號。</small>'))
  for (const old of ['信任我自己的設備', '不用再到這台確認', '沒有本人簽章的要求', "act('acct-trust'"]) assert.ok(!t.includes(old), old)
})
