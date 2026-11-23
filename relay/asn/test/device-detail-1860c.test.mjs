// #1860 PR-C 設備詳情：拿掉「帳號」（分頁、帳號行）、「允許別台設備替這台切換帳號」搬進連線安全、
// 詳情不列節點代號末 4 碼、「忘記這台」改成只在被擋下時才出現的「重新認這台」（電腦、手機一起）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import * as Vue from 'vue'
import { renderToString as ssrRender } from 'vue/server-renderer'
import { SettingsPanel } from '../ui/lib/settings-panel.mjs'
import { TEXT as KNOWN, createForgetConfirm, isBlockedPeer, normalizeView } from '../ui/lib/known-peers.mjs'
import { TEXT as M_KNOWN, normalizeList } from '../ui/lib/mobile-known-peers.mjs'
import { IDENTITY_TEXT, deviceIdentity, unnamedClue } from '../ui/lib/device-identity.mjs'
import { withIdentity } from './helpers/with-identity.mjs'

const renderToString = async app => (await ssrRender(app)).replace(/<!--[\s\S]*?-->/g, '')
const read = p => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')

const dev = (key, label, o = {}) => withIdentity({ key, label, self: false, kind: '電腦', online: true, onlineText: '在線', reportedText: '', empty: '', vendors: [{ key: 'claude', label: 'Claude', accounts: [{ email: 'acct@example.test', plan: 'pro', current: true }], account: '有帳號', reported: true, extra: '', switchable: true, switchHint: '' }], ...o })
const devices = () => [dev('H', '家用機', { self: true }), dev('W', '工作機'), dev('P', '擁有者的手機', { phone: true, kind: '手機', kindLabel: '手機' })]
const known = peers => ({ ownFp: 'AABBCCDDEEFF00112233', qr: null, busy: false, peers, error: '', renameError: '' })
const peer = (node, o = {}) => ({ node, label: node, name: node, fingerprint: '0123456789abcdef', firstSeen: '', firstSeenMs: 0, loginOk: false, ...o })
const st = (over = {}) => ({ devices: devices(), accounts: { list: [{ email: 'acct@example.test', plan: 'pro', current: true, saved: true }], current: null, msg: '', autoNote: '', busy: false, confirmDel: '', allowSwitch: true }, known: known([]), ...over })
const render = async (props, state = st()) => {
  globalThis.Vue = Vue
  return renderToString(Vue.createSSRApp({ render: () => Vue.h(SettingsPanel, { st: state, meAv: '', catKey: 'devices', ...props }) }))
}
const tabLabels = html => [...(/<div class="dv-tabs"[\s\S]*?<\/div>/.exec(html)?.[0] ?? '').matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map(m => m[1].trim())

// ---------- 1. 詳情沒有「帳號」 ----------
test('電腦詳情沒有「帳號」分頁、帳號行、廠商卡片；這台、別台、手機都一樣', async () => {
  for (const dev of ['H', 'W', 'P']) {
    const html = await render({ dev })
    assert.ok(!tabLabels(html).includes('帳號'), `${dev}：不該有「帳號」分頁`)
    for (const bad of ['asn-aline', 'dv-vendor', 'dv-accts', 'acct@example.test', 'dv-body']) assert.ok(!html.includes(bad), `${dev}：詳情不該有 ${bad}`)
  }
  const src = read('ui/lib/settings-panel.mjs')
  assert.ok(!src.includes("setView('acct')") && !src.includes("view === 'acct'") && !src.includes('hasAcct'))
})

test('手機詳情沒有「詳情｜帳號」分頁；設備列也沒有帳號鈕', () => {
  const html = read('ui/m.html'), js = read('ui/m.js')
  assert.ok(!html.includes('m-dv-subbtn') && !html.includes('data-sub') && !html.includes('acctLines') && !html.includes('acctCardGo'))
  assert.ok(!js.includes('setAcctSub') && !js.includes('acctSw.sub') && !js.includes('acctCardGo'))
  const detail = html.slice(html.indexOf('class="m-dv-info"'), html.indexOf('<template v-else-if="acctSw.phase === \'rm\'">'))
  assert.ok(!detail.includes('v-for="v in acctCur.vendors"') && !detail.includes('asn-aline'), '細部頁沒有廠商卡片與帳號行')
})

test('設備詳情的帳號相關程式與樣式沒人用就刪掉（setAcctSub、m-dv-subbtn、帳號行樣式、open-accounts）', () => {
  assert.ok(!read('ui/mobile.css').includes('m-dv-subbtn'))
  const kit = read('ui/kit.css')
  for (const gone of ['asn-aline', 'data-flash', 'asn-tag-ok', 'asn-tag-warn']) assert.ok(!kit.includes(gone), `kit.css 不該還有 ${gone}`)
  const lines = read('ui/lib/device-account-lines.mjs')
  assert.ok(!lines.includes('deviceAccountLines') && !lines.includes('ACCOUNT_REMOVE'), '只剩帳號頁還在用的判斷函式')
  assert.ok(!read('ui/list.js').includes("case 'open-accounts'"))
})

// ---------- 2. 允許別台設備替這台切換帳號：在連線安全 ----------
test('這台的詳情：「允許別台設備替這台切換帳號」在「連線安全」那張卡裡，設定值（acct-allow-switch）與行為不變', async () => {
  const html = await render({ dev: 'H' })
  const card = /<div class="set-card dv-safety">[\s\S]*?<\/div><!---->|<div class="set-card dv-safety">[\s\S]*?(?=<div class="set-card)/.exec(html)?.[0] ?? ''
  assert.ok(card.includes('連線安全'), '有連線安全卡')
  assert.ok(card.includes('允許別台設備替這台切換帳號'), '設定在連線安全裡')
  assert.ok(card.includes('勾了之後，手機或別台設備可以替這台切換 Claude 帳號。'))
  assert.equal((html.match(/允許別台設備替這台切換帳號/g) ?? []).length, 1, '只出現一處')
  assert.ok(!html.includes('允許切換帳號'), '舊位置、舊文字都沒有了')
  assert.match(html, /<input type="checkbox" checked>/, '目前值照 st.accounts.allowSwitch')
  // 行為：勾選照舊送 acct-allow-switch（值是布林），樞紐照舊接
  assert.ok(SettingsPanel.template.includes("@change=\"act('acct-allow-switch', $event.target.checked)\""))
  assert.ok(read('ui/list.js').includes("case 'acct-allow-switch': await accounts.setAllowSwitch(value === true)"))
  const off = await render({ dev: 'H' }, st({ accounts: { ...st().accounts, allowSwitch: false } }))
  assert.doesNotMatch(off.slice(off.indexOf('連線安全')), /<input type="checkbox" checked>/)
})

test('別台與手機的詳情沒有這個設定（只有被切換的那台自己能設）', async () => {
  for (const dev of ['W', 'P']) assert.ok(!(await render({ dev })).includes('允許別台設備替這台切換帳號'), dev)
  assert.ok(!read('ui/m.html').includes('允許別台設備替這台切換帳號') && !read('ui/m.html').includes('acct-allow-switch'))
})

// ---------- 3. 詳情不列代號末 4 碼 ----------
test('詳情的辨認區沒有「代號」那一列；名字空白時的標題「電腦（X7K2）」照留', async () => {
  const id = deviceIdentity({ node: 'node-old-pc-X7K2', label: '', named: false, platform: 'windows', createdMs: Date.UTC(2026, 10, 5), online: false, seenMs: Date.UTC(2026, 10, 19) })
  assert.deepEqual(id.rows.map(r => r.key), ['created', 'platform', 'seen'])
  assert.equal(IDENTITY_TEXT.code, undefined)
  assert.equal(id.title, '電腦（X7K2）', '名字空白時的辨認線索照留')
  assert.equal(unnamedClue({ node: 'node-fp-name-Q9Z8', phone: true }), '手機（Q9Z8）')
  const html = await render({ dev: 'W' }, st({ devices: [dev('W', '', { named: false, identity: id })] }))
  assert.match(html, /<h3 class="dv-name">電腦（X7K2）<\/h3>/, '標題的線索還在')
  assert.ok(!html.includes('<dt>代號</dt>') && !html.includes('dvid-code'), '詳情裡沒有代號那一列')
  assert.equal((html.match(/X7K2/g) ?? []).length, 2, '只剩標題與無障礙名稱（section 的 aria-label）有它，詳情內容沒有')
  assert.ok(!read('ui/style.css').includes('.dvid-code'))
})

// ---------- 4. 重新認這台：只在被擋下時出現 ----------
test('電腦：正常的設備詳情沒有「忘記這台」也沒有「重新認這台」；被擋下的才在最上面出提示與「重新認這台」', async () => {
  const normal = await render({ dev: 'W' }, st({ known: known([peer('W')]) }))
  for (const t of ['重新認這台', '忘記這台', '已擋下', 'dv-block']) assert.ok(!normal.includes(t), `正常狀態不該有 ${t}`)
  const blocked = await render({ dev: 'W' }, st({ known: known([peer('W', { blocked: true })]) }))
  assert.ok(blocked.includes('重新認這台') && blocked.includes('dv-block'))
  assert.ok(blocked.includes('「工作機」的指紋和之前不一樣，已經擋下。'))
  assert.ok(blocked.includes('只有你剛重灌或換掉它時才按「重新認這台」。如果你沒動過它，不要按，並告訴管理的人。'))
  assert.ok(blocked.indexOf('dv-block') < blocked.indexOf('class="dv-tabs"'), '提示在詳情最上面（分頁之前）')
  assert.ok(!blocked.includes('忘記這台'), '不再叫「忘記這台」')
  // 沒有認得紀錄的設備（雲端、尚未連線過）也沒有這顆
  assert.ok(!(await render({ dev: 'W' }, st({ known: known([]) }))).includes('重新認這台'))
})

test('電腦：清單那一列只有被擋下的標「已擋下」', async () => {
  const state = st({ known: known([peer('W', { blocked: true }), peer('P')]) })
  const html = await render({}, state)
  const rows = [...html.matchAll(/<li[^>]*class="dv-row[^"]*"[\s\S]*?<\/li>/g)].map(m => m[0])
  assert.equal(rows.length, 3)
  assert.ok(rows.find(r => r.includes('工作機')).includes('>已擋下<'))
  assert.ok(!rows.find(r => r.includes('家用機')).includes('已擋下') && !rows.find(r => r.includes('擁有者的手機')).includes('已擋下'))
})

test('電腦：按「重新認這台」先問，確認句寫明會發生什麼；確認才送 known-forget（行為同原本的忘記），取消不送', () => {
  const calls = [], box = { value: null }
  const c = createForgetConfirm({ box, forget: id => calls.push(id) })
  c.askReaccept({ id: 'W', label: '工作機' })
  const t = box.value.text
  assert.ok(t.startsWith('重新認「工作機」？'))
  for (const part of ['清掉記住的指紋', '下次連上來會當成第一次', '再通知你', '只有你剛重灌或換掉它時才按', '如果你沒動過它，不要按，並告訴管理的人']) assert.ok(t.includes(part), part)
  assert.equal(box.value.title, '重新認這台設備？'); assert.equal(box.value.yes, '重新認')
  c.no(); assert.deepEqual(calls, [])
  c.askReaccept({ id: 'W', label: '工作機' }); c.yes(); assert.deepEqual(calls, ['W'])
  const panel = read('ui/lib/settings-panel.mjs')
  assert.match(panel, /<asn-button state="danger" class="dv-reaccept"[^>]*@click="forget\.askReaccept\(curKnown\)">\{\{ KNOWN\.reaccept \}\}/, '危險鈕')
  assert.match(panel, /<asn-dialog v-if="forgetBox" :title="forgetBox\.title"/, '確認框的標題與確認鈕跟著問的是哪一種')
})

test('被擋下的旗標（blocked）電腦、手機同一個判斷；沒帶就是沒被擋；已移除設備的「忘記」照舊', () => {
  assert.equal(isBlockedPeer({ blocked: true }), true)
  for (const p of [null, undefined, {}, { blocked: false }, { blocked: 'yes' }]) assert.equal(isBlockedPeer(p), false)
  assert.equal(normalizeView({ peers: [{ node: 'a', name: 'x', blocked: true }, { node: 'b', name: 'y' }] }).peers.map(p => isBlockedPeer(p)).join(), 'true,false')
  assert.equal(normalizeList({ peers: [{ node: 'a', name: 'x', blocked: true }, { node: 'b', name: 'y' }] }).map(p => isBlockedPeer(p)).join(), 'true,false')
  assert.equal(M_KNOWN.reaccept, KNOWN.reaccept, '手機的字就是電腦那一份')
  assert.equal(KNOWN.forgetTitle, '忘記這台設備？'); assert.equal(KNOWN.forgetYes, '忘記')
  assert.ok(read('ui/lib/settings-panel.mjs').includes('forget.ask(r.peer)'), '已移除的設備只剩紀錄的照舊用「忘記」')
})

test('手機：被擋下才出提示與「重新認這台」（原位確認，確認才走原本的忘記）；沒有常駐的「忘記這台」', () => {
  const html = read('ui/m.html'), js = read('ui/m.js')
  assert.match(html, /<div class="m-dv-block" role="alert" v-if="curKnown && curKnown\.blocked">/)
  assert.ok(html.includes('KNOWN_TEXT.reacceptNotice(acctCur.identity.title)') && html.includes('KNOWN_TEXT.reacceptConfirm(acctCur.identity.title)'))
  assert.match(html, /@click="reacceptAsk\(curKnown\.node\)">\{\{ KNOWN_TEXT\.reaccept \}\}/)
  assert.match(html, /@click="reacceptYes">\{\{ KNOWN_TEXT\.reacceptYes \}\}/)
  const info = html.slice(html.indexOf('class="m-dv-info"'), html.indexOf('<!-- 新電腦引導卡'))
  assert.ok(!info.includes('forgetKnown(') && !html.includes('forgetThis'), '詳情沒有常駐的忘記')
  assert.match(js, /const reacceptYes = async \(\) => \{ const node = reaccept\.value; reaccept\.value = ''; if \(node\) await forgetKnown\(node\) \}/, '確認後走原本的忘記（先過本人確認）')
  assert.ok(html.includes('KNOWN_TEXT.blockedTag'), '清單那一列也標「已擋下」')
})

test('各處被擋下的提示句都指到「重新認這台」，不再叫人按「忘記這台」', () => {
  for (const t of [M_KNOWN.blocked, M_KNOWN.noneMatch, M_KNOWN.scanMismatch]) assert.ok(t.includes('「重新認這台」') && !t.includes('忘記這台'), t)
  for (const f of ['src-tauri/src/device_id.rs', 'src-tauri/src/view_remote.rs']) assert.ok(!read(f).includes('「忘記這台」'), f)
})
