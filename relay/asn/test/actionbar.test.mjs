// 對話上方功能列（#40）：只放已有功能的按鈕、中文提示、圖示檔都在、兩種對話視窗都接上。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { canOfferCall, canOfferConsole, consoleButtonView, friendEngine, opsMenuItems } from '../ui/lib/actionbar.mjs'
import { roomHue, roomInitial } from '../ui/lib/groups.mjs'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = f => fs.readFileSync(path.join(root, f), 'utf8')

test('主控台按鈕：只有本機、已開起來、非雲端代理的視窗', () => {
  assert.equal(canOfferConsole({ node: 'H' }, 'H'), true)
  assert.equal(canOfferConsole({ node: 'W' }, 'H'), false, '別台設備')
  assert.equal(canOfferConsole({ node: 'H', engine: 'acp' }, 'H'), false)
  assert.equal(canOfferConsole({ node: 'H', pending: true }, 'H'), false)
  assert.equal(canOfferConsole(null, 'H'), false)
})

test('通話按鈕：夥伴在線、有語音功能才給；離線或等待中的不給', () => {
  assert.equal(canOfferCall({ status: 'online' }), true)
  assert.equal(canOfferCall({ status: 'busy' }), true)
  assert.equal(canOfferCall({ status: 'offline' }), false)
  assert.equal(canOfferCall({ status: 'online', pending: true }), false)
  assert.equal(canOfferCall({ status: 'online' }, { hasVoice: false }), false)
  assert.equal(canOfferCall(null), false)
})

test('前台／後台按鈕的字：看得到＝後台隱藏，看不到＝前台顯示，都有提示', () => {
  assert.equal(consoleButtonView(true).label, '後台隱藏')
  assert.equal(consoleButtonView(false).label, '前台顯示')
  for (const v of [true, false]) assert.match(consoleButtonView(v).tip, /[一-鿿]/)
})

test('代理用哪家指令：名單寫的優先，沒寫看啟動設定，再沒有就是 Claude', () => {
  assert.equal(friendEngine({ engine: 'codex' }), 'codex')
  assert.equal(friendEngine({ launchProfile: 'codex' }), 'codex')
  assert.equal(friendEngine({}), 'claude')
})

test('功能列按鈕都有中文 aria-label 與提示（能用放說明、反灰放原因），圖示檔存在且是 SVG', () => {
  const t = read('ui/lib/actionbar.mjs')
  assert.match(t, /aria-label="切換模型" :title="slot\.model\.ok \? MODEL_TIP : slot\.model\.reason"/)
  assert.match(t, /const MODEL_TIP = '[^']*[一-鿿]/)
  assert.match(t, /:aria-label="slot\.window\.label" :title="slot\.window\.ok \? consoleView\.tip : slot\.window\.reason"/)
  assert.match(t, /aria-label="工作項目" :title="slot\.tasks\.reason"/)
  assert.match(t, /role="toolbar" aria-label="代理功能列"/)
  const imgs = [...t.matchAll(/src="(img\/[^"]+)"/g)].map(m => m[1])
  assert.deepEqual(imgs, ['img/ab-more.svg', 'img/ab-call.svg', 'img/ab-window.svg', 'img/ab-model.svg', 'img/ab-agent.svg', 'img/ab-tasks.svg'])
  for (const m of imgs) assert.match(fs.readFileSync(path.join(root, 'ui', m), 'utf8'), /^<svg/, m)
  assert.ok(!/v-html|innerHTML/.test(t))
})

test('固定 6 顆（#539）：通話、前台／後台、切換模型、子代理、工作項目、管理；樣板不用 v-if 藏單顆，反灰用 :disabled', () => {
  const t = read('ui/lib/actionbar.mjs')
  assert.equal([...t.matchAll(/class="abtn"/g)].length, 6)
  const order = ['call', 'window', 'model', 'subs', 'tasks'].map(k => t.indexOf(`data-slot="${k}"`))
  assert.ok(order.every((n, i) => n > 0 && (i === 0 || n > order[i - 1])), `順序固定：${order}`)
  for (const k of ['call', 'window', 'model', 'subs', 'tasks']) assert.match(t, new RegExp(`data-slot="${k}"[^>]*:disabled="!slot\\.${k}\\.ok`), k)
  assert.match(t, /data-slot="manage"[^>]*:disabled="disabled"/)
  assert.doesNotMatch(t, /v-if="(showCall|showConsole|showModel|showSubs|wake\.show)"/, '不再整顆藏起來')
  assert.doesNotMatch(t, /aria-label="喚醒"/, '喚醒移進「管理」')
})

test('兩種對話視窗都把 transport 與本機節點傳給對話區，對話區放了功能列', () => {
  assert.match(read('ui/chat.html'), /:agent-api="transport" :self-node="selfNode"/)
  assert.match(read('ui/list.html'), /:agent-api="transport" :self-node="selfNode"/)
  assert.match(read('ui/lib/chatpane.mjs'), /<action-bar :friend="friend" :self-node="selfNode" :api="agentApi"/)
  assert.ok(read('ui/style.css').includes('.actionbar'))
})

test('管理按鈕（原收件人列的「⋯」）：群組三項、可邀請的一對一一項、其他沒有；群組不放通話與主控台', () => {
  assert.deepEqual(opsMenuItems({ room: true }).map(i => i.key), ['invite', 'addai', 'manage'])
  assert.equal(opsMenuItems(null).length, 0)
  assert.equal(opsMenuItems({ id: 'pending:1' }).length, 0)
  assert.equal(canOfferCall({ room: true, status: 'online' }), false)
  assert.equal(canOfferConsole({ room: true, node: 'H' }, 'H'), false)
})

test('「⋯」搬到大按鈕區：收件人列不再有選單，大按鈕區有「管理」鈕，選單搬到 body 並用 fixed 定位', () => {
  const pane = read('ui/lib/chatpane.mjs')
  assert.ok(!/to-menu/.test(pane), '收件人列不該再有「⋯」')
  assert.ok(!/to-menu/.test(read('ui/group.css')))
  assert.match(pane, /<action-bar [^>]*v-if="!isRoom \|\| opsItems\.length" :ops="opsItems" :pi-models-for="piModelsFor" @ops="pickMenu"/, '群組對話也要有大按鈕區')
  const ab = read('ui/lib/actionbar.mjs')
  assert.match(ab, /aria-label="管理"/)
  assert.match(ab, /<teleport to="body">/)
  assert.match(read('ui/style.css'), /\.ab-ops\{position:fixed;z-index:70/)
  // 群組維持現狀（#539 第 2 張才改）：一對一的 6 格只在不是群組時出現，群組只有「管理」
  assert.match(ab, /<template v-if="!isRoom && api">/)
  assert.match(ab, /<ops-menu-button v-if="\(!isRoom && api\) \|\| opsAll\.length"/)
})

test('群組列表：未讀徽章垂直置中、不被拉長；大頭像與個人名單同一個 dp xs 尺寸', () => {
  const html = read('ui/list.html'), css = read('ui/group.css')
  assert.match(html, /<span class="dp xs room-av/)
  assert.match(html, /<asn-avatar :src="avOf\(c\)" :friend="c" :status="g\.kind === 'archived' \? 'offline' : c\.status"/, '個人名單用統一頭像（預設 xs，同 dp xs 尺寸；已封存群組一律灰）')
  assert.ok(!/room-ic/.test(html))
  assert.match(css, /\.room-btn\{display:flex;align-items:center;/)
  assert.match(css, /\.room-btn \.unread\{align-self:center;height:18px/)
  assert.equal(roomInitial('  小良 團隊'), '小')
  assert.equal(roomInitial(''), '群')
  assert.equal(roomHue('abc'), roomHue('abc'))
  assert.ok(roomHue('團購群') >= 0 && roomHue('團購群') < 360)
})

test('一對一「管理」選單（#539 瘦身）：沒有前後景切換與切換模型；喚醒在這裡（離線才可按）；分隔線後接邀請；反灰原因 20 字內', async () => {
  const { managePanelItems } = await import('../ui/lib/actionbar.mjs')
  const f = { id: 'H/a', node: 'H', agent: 'asn-2', window: 'w1', status: 'online' }
  const ctx = { loaded: true, signedIn: true, machines: { H: { online: true, launcher: true } } }
  const inv = opsMenuItems(f)
  const it = managePanelItems(f, ctx, inv, { selfNode: 'H' })
  assert.deepEqual(it.map(i => i.key), ['p:info', 'p:rename', 'p:close', 'p:handover', 'p:resume', 'p:restart', 'p:remove', 'p:adopt', 'p:archive', 'invite'])
  assert.deepEqual(it.map(i => i.ok), [true, true, true, true, false, false, false, true, true, true], '在線：喚醒、重開、移除不適用')
  for (const i of it) { assert.equal(Boolean(i.reason), !i.ok, i.key); assert.ok(i.reason.length <= 20, `${i.key}：${i.reason}`) }
  assert.equal(it.find(i => i.key === 'p:resume').reason, '這個視窗在線上，不需要喚醒')
  const off = managePanelItems({ ...f, status: 'offline' }, ctx, inv, { selfNode: 'H' })
  assert.equal(off.find(i => i.key === 'p:resume').ok, true, '離線時才可以喚醒')
  assert.match(off.find(i => i.key === 'p:rename').reason, /已離線/)
  assert.equal(it.find(i => i.key === 'invite').sep, true, '邀請前有分隔線')
  assert.ok(!it.some(i => i.sep && i.key !== 'invite'))
  const noLogin = managePanelItems(f, { ...ctx, signedIn: false }, inv).find(i => i.key === 'p:rename')
  assert.equal(noLogin.ok, false)
  assert.match(noLogin.reason, /登入/)
  assert.equal(managePanelItems({ room: true }, ctx, opsMenuItems({ room: true }))[0].sep, false, '群組沒有夥伴項目，不畫分隔線')
  const t = read('ui/lib/actionbar.mjs')
  assert.match(t, /from '\.\/archive\.mjs'/)
  assert.match(t, /<partner-op-dialog v-if="opDlg\.open" :friend="friend" :op="opDlg\.item\.key"/)
  assert.match(t, /role="separator"/)
  // 反灰：aria-disabled 加說明小字，點了不送出（OpsMenuButton.pick 與 pickOps 都擋）
  assert.match(t, /:aria-disabled="it\.ok === false \? 'true' : 'false'"/)
  assert.match(t, /<small class="menu-why" v-if="it\.ok === false && it\.why" :id="'ops-why-' \+ it\.key">\{\{ it\.why \}\}<\/small>/)
  assert.doesNotMatch(t, /:disabled="it\.ok === false"/, '不用原生 disabled')
  assert.match(t, /function pick\(it\) \{ if \(it\.ok === false\) return;/)
  assert.match(t, /const it = opsAll\.value\.find\(i => i\.key === key\)\s*\n\s*if \(!it\?\.ok\) return/)
})
