// 夥伴操作選單「項目固定」：右鍵選單、對話上方「管理」、手機「⋯」三處，每種夥伴都是同一套同一個順序；
// 用不到的項目反灰（aria-disabled）並寫明這一項為什麼不能用，點了不送出任何動作。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { manageItems } from '../ui/lib/archive.mjs'
import { MENU_KEYS } from '../ui/lib/partner-ops.mjs'
import { consoleBlock, canOfferConsole, managePanelItems, partnerMenuItems, wakeButtonView } from '../ui/lib/actionbar.mjs'
import { canOfferModelSwitch, modelSwitchBlock } from '../ui/lib/model-switch.mjs'

const read = p => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const F = (node, agent, o = {}) => ({ id: `${node}/${agent}`, node, agent, nick: agent, device: '家用機', status: 'online', engine: 'claude', ...o })
const ctx = { machines: { H: { online: true, launcher: { profiles: [] } }, C: { online: true, launcher: null } }, loaded: true, signedIn: true }
const KINDS = {
  'Claude 在線': F('H', 'a'), 'Claude 離線': F('H', 'b', { status: 'offline' }), '背景工作者在線': F('H', 'g', { engine: 'gemini' }), '背景工作者離線': F('H', 'g', { engine: 'gemini', status: 'offline' }),
  '雲端代理': F('G', 'k', { engine: 'grok', kind: 'grok' }), '其他引擎': F('H', 'x', { engine: 'codex' }), '沒開放遠端管理': F('C', 'c'),
}
const FIXED = [...MENU_KEYS, 'archive']

test('每種夥伴的選單都是同一套同一個順序；反灰一定有說明、能用一定沒有；說明純中文', () => {
  for (const [name, f] of Object.entries(KINDS)) {
    const items = manageItems(f, ctx)
    assert.deepEqual(items.map(i => i.key), FIXED, name)
    for (const i of items) {
      assert.equal(Boolean(i.reason), !i.ok, `${name} ${i.key}`)
      assert.ok(!/[A-Za-z]{4,}/.test(i.reason), `純中文：${i.reason}`)
    }
  }
})

test('說明逐案不同、寫的是程式真的判斷得出的條件', () => {
  const why = (name, key) => manageItems(KINDS[name], ctx).find(i => i.key === key).reason
  assert.equal(why('背景工作者在線', 'close'), '', '背景工作者可以「關閉」（停止本次執行）')
  assert.equal(why('背景工作者在線', 'model'), '', '背景工作者可以切換模型（0.2 B4）')
  assert.equal(why('背景工作者在線', 'rename'), '', '背景工作者可以改名（B5，#266）')
  assert.match(why('背景工作者離線', 'rename'), /已離線/)
  assert.match(why('沒開放遠端管理', 'rename'), /沒有開放遠端管理/)
  assert.match(why('Claude 離線', 'rename'), /已離線/)
  assert.match(why('雲端代理', 'info'), /雲端代理/)
  assert.match(why('其他引擎', 'close'), /引擎/)
  assert.match(why('Claude 在線', 'resume'), /不需要喚醒/)
  assert.equal(new Set(['Claude 在線', 'Claude 離線', '雲端代理', '其他引擎', '沒開放遠端管理'].map(n => why(n, 'close'))).size, 5, '關閉視窗的說明：Claude 在線沒有說明，其餘四種各不相同（共五種）')
})

test('前台／後台與切換模型：原因與啟用條件共用同一個判斷；ACP 工作者看 partnerEngine（名單上 engine 是 gemini／grok）', () => {
  const acp = F('H', 'a', { engine: 'gemini' })
  const cases = [F('H', 'a'), F('X', 'a'), F('H', 'a', { pending: true }), acp, F('H', 'a', { engine: 'grok' }), { room: true, node: 'H' }, null]
  for (const f of cases) {
    assert.equal(canOfferConsole(f, 'H'), consoleBlock(f, 'H') === '', JSON.stringify(f))
    if (consoleBlock(f, 'H')) assert.ok(consoleBlock(f, 'H').length <= 20)
  }
  assert.equal(consoleBlock(F('X', 'a'), 'H'), '視窗在另一台電腦上')
  assert.equal(consoleBlock(acp, 'H'), '內建通道執行，沒有視窗', 'engine 是 gemini 的 ACP 工作者也要判斷到')
  assert.equal(consoleBlock(F('H', 'a', { engine: 'grok' }), 'H'), '內建通道執行，沒有視窗')
  for (const [f, engine] of [[F('H', 'a'), 'claude'], [F('X', 'a'), 'claude'], [F('H', 'a'), 'codex'], [acp, 'gemini'], [F('H', 'a', { pending: true }), 'claude']]) {
    assert.equal(canOfferModelSwitch(f, { selfNode: 'H', engine }), modelSwitchBlock(f, { selfNode: 'H', engine }) === '')
    assert.ok(modelSwitchBlock(f, { selfNode: 'H', engine }).length <= 20)
  }
  assert.match(modelSwitchBlock(F('X', 'a'), { selfNode: 'H', engine: 'claude' }), /另一台電腦/)
  assert.match(modelSwitchBlock(acp, { selfNode: 'H', engine: 'gemini' }), /內建通道/)
})

test('對話上方「管理」：和右鍵同一份 partnerMenuItems（不含前後景切換、切換模型），納入管理在封存之前；反灰說明 20 字內', () => {
  for (const [name, f] of Object.entries(KINDS)) {
    const items = managePanelItems(f, ctx, [], { selfNode: 'H' })
    const fixed = FIXED.filter(k => k !== 'model').map(k => `p:${k}`)
    const at = fixed.findIndex(k => /archive/.test(k))
    const want = at < 0 ? [...fixed, 'p:adopt'] : [...fixed.slice(0, at), 'p:adopt', ...fixed.slice(at)]
    assert.deepEqual(items.map(i => i.key), want, name)
    assert.deepEqual(items, partnerMenuItems(f, ctx, 'H'), `${name}：管理與右鍵同一份`)
    for (const i of items) assert.ok(i.reason.length <= 20, `${name} ${i.key}：${i.reason}`)
    assert.ok(!items.some(i => i.key === 'p:console' || i.key === 'p:model'), name)
  }
})

test('離線的背景工作者、其他引擎不會冒出「喚醒」大按鈕（固定選單不改變大按鈕的出現條件）', () => {
  for (const n of ['背景工作者離線', '雲端代理']) assert.equal(wakeButtonView({ ...KINDS[n], status: 'offline' }, ctx).show, false, n)
  assert.equal(wakeButtonView(KINDS['Claude 離線'], ctx).show, true)
})

test('接線：三處選單都用 aria-disabled＋說明小字，不靠隱藏；點反灰項目不送出也不收起選單', () => {
  const lhtml = read('ui/list.html'), ljs = read('ui/list.js'), mhtml = read('ui/m.html'), mjs = read('ui/m.js')
  // 電腦版右鍵：每一列都有 aria-disabled 與說明；切換模型與背景／前台切換不再 v-if 隱藏
  assert.match(lhtml, /:aria-disabled="it\.ok \? 'false' : 'true'"[^>]*>[\s\S]*?<small class="menu-why"[^>]*v-if="!it\.ok && buddyWhyOf\(it\.key\)">\{\{ buddyWhyOf\(it\.key\) \}\}<\/small>/)
  assert.match(lhtml, /aria-describedby="buddy-why-console"/)
  assert.doesNotMatch(lhtml, /<li v-if="buddyModel\.show"/, '切換模型不再看狀態隱藏')
  assert.doesNotMatch(lhtml, /<button[^>]*role="menuitem"[^>]*:disabled="!it\.ok"/, '右鍵項目不用原生 disabled')
  // 守門：點反灰項目在送出之前就返回，而且先返回、後關選單
  const open = ljs.slice(ljs.indexOf('function openPartnerOp'), ljs.indexOf('// 封存／取消封存'))
  assert.ok(open.indexOf('!it?.ok') >= 0 && open.indexOf('!it?.ok') < open.indexOf('closeBuddyMenu()'), '反灰先返回，不收起選單')
  assert.ok(open.indexOf('!it?.ok') < open.indexOf('setArchived(') && open.indexOf('!it?.ok') < open.indexOf('opDlg'), '反灰不會開對話框也不會封存')
  const tog = ljs.slice(ljs.indexOf('async function toggleBuddyConsole'), ljs.indexOf('async function submitPartnerDlg'))
  assert.match(tog, /buddyConsole\.state !== 'toggle'\) return/, '反灰的前景／背景切換什麼都不做')
  // 手機
  assert.match(mhtml, /v-for="i in opsView\.rows"/)
  assert.match(mjs, /const opsRows = computed\(\(\) => \(opsItems\.value\.length \? \[\{ key: 'console'/, '手機也固定列出背景／前台切換（反灰）')
  assert.match(mjs, /function pickOp\(op\) \{\s*\n\s*const item = opsItems\.value\.find\(i => i\.key === op\)\s*\n\s*if \(!item \|\| !item\.ok\) return/, '手機點反灰項目不送出')
})

test('樣式：反灰只淡化項目名稱，說明維持完整對比；手機說明可換行', () => {
  const css = read('ui/style.css'), m = read('ui/mobile.css')
  assert.match(css, /\.av-menu button\.off \.mi-t,\.ab-menu button\.off \.mi-t\{opacity:\.\d+\}/)
  assert.match(css, /\.menu-why\{[^}]*color:var\(--muted\)[^}]*white-space:normal/)
  assert.match(m, /\.m-ops-item\.off \.m-opt-t\{opacity:/)
  assert.doesNotMatch(m, /\.m-ops-item\.off\{[^}]*opacity/, '不把整列（含說明）變淡')
})
