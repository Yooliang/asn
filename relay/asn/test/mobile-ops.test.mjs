// 手機版「對話」分頁（最後使用的那一位）與「⋯」選單的純邏輯，以及頁面接線的守門。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { EMPTY_CHAT_TEXT, LOADING_CHAT_TEXT, MODEL_NOTE, OP_STEP, chatPageState, normalizeLastChat, opStep, phoneModels, renamedChatId, runBanner, showsInSheet } from '../ui/lib/mobile-ops.mjs'
import { MODEL_RE, OPS, buildOpRequest, menuItems } from '../ui/lib/partner-ops.mjs'

const read = (...p) => fs.readFileSync(new URL(`../${p.join('/')}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const F = (node, agent, extra = {}) => ({ id: `${node}/${agent}`, node, agent, nick: agent, status: 'online', engine: 'claude', device: `設備${node}`, ...extra })

test('對話分頁：記得最後使用的那一位；從來沒開過、記的那位不在名單上顯示提示；名單還沒載入顯示載入中', () => {
  const fl = [F('H', '小文'), F('W', '小武')]
  assert.deepEqual(chatPageState(fl, 'W/小武'), { kind: 'friend', friend: fl[1], text: '' })
  assert.deepEqual(chatPageState(fl, ''), { kind: 'empty', friend: null, text: EMPTY_CHAT_TEXT })
  assert.equal(EMPTY_CHAT_TEXT, '從夥伴分頁點一位開始對話')
  assert.equal(chatPageState(fl, 'X/不在了').kind, 'empty')
  assert.deepEqual(chatPageState([], 'W/小武'), { kind: 'loading', friend: null, text: LOADING_CHAT_TEXT })
  assert.equal(chatPageState([], '').kind, 'empty', '沒記過人就不用等名單')
  for (const bad of [null, undefined, 5, {}, [], 'x'.repeat(201)]) assert.equal(normalizeLastChat(bad), '', String(bad))
  assert.equal(normalizeLastChat('H/小文'), 'H/小文')
})

test('「⋯」選單：項目與可按條件完全來自 partner-ops.menuItems（在線五項、離線只有喚醒、其他不顯示）', () => {
  const machines = { H: { node: 'H', online: true, launcher: { profiles: [{ id: 'claude' }] } }, C: { node: 'C', online: true, launcher: null } }
  const ctx = { machines, loaded: true, signedIn: true, nonWindowNodes: ['P'] }
  assert.deepEqual(menuItems(F('H', '小文'), ctx).map(i => i.key), ['info', 'rename', 'model', 'close', 'handover'])
  assert.deepEqual(menuItems(F('H', '小離', { status: 'offline' }), ctx).map(i => i.key), ['resume'])
  assert.deepEqual(menuItems(F('P', '手機'), ctx), [], '手機自己不顯示「⋯」')
  assert.deepEqual(menuItems(F('H', '正見群', { room: true }), ctx), [])
  const closed = menuItems(F('C', '小乙'), ctx)
  assert.equal(closed[0].ok, true, '詳情唯讀，不需開放')
  assert.ok(closed.slice(1).every(i => !i.ok && /[一-鿿]/.test(i.reason)), '不能按的有中文原因')
  // 每個項目都有下一步，且涵蓋所有動作
  assert.deepEqual(Object.keys(OP_STEP).sort(), [...OPS].sort())
  assert.equal(opStep('rename'), 'form'); assert.equal(opStep('model'), 'pick'); assert.equal(opStep('close'), 'confirm'); assert.equal(opStep('handover'), 'confirm')
  assert.equal(opStep('info'), 'run'); assert.equal(opStep('resume'), 'run'); assert.equal(opStep('x'), '')
  assert.equal(showsInSheet('info'), true); assert.equal(showsInSheet('close'), false)
})

test('切換模型：手機列常用三個（opus／sonnet／haiku），都過後台的模型名稱規則，並註明只是常用清單', () => {
  const ms = phoneModels()
  assert.deepEqual(ms.map(m => m.id), ['opus', 'sonnet', 'haiku'])
  for (const m of ms) assert.match(m.id, MODEL_RE)
  assert.match(MODEL_NOTE, /常用/)
  assert.deepEqual(buildOpRequest(F('H', '小文'), 'model', { model: 'sonnet' }), { node: 'H', name: '小文', op: 'model', model: 'sonnet' })
})

test('改名完成：對話跳到新名字；沒完成或不是改名不動', () => {
  const f = F('H', '小文')
  assert.equal(renamedChatId(f, 'rename', { newName: ' 小文二 ' }, { phase: 'done' }), 'H/小文二')
  assert.equal(renamedChatId(f, 'rename', { newName: '小文二' }, { phase: 'failed' }), '')
  assert.equal(renamedChatId(f, 'close', { newName: '小文二' }, { phase: 'done' }), '')
})

test('頂端進度條：主句、接班換手分段（✓／…／○）、交接檔位置；沒有進度不顯示', () => {
  assert.equal(runBanner(null), null); assert.equal(runBanner({ op: 'close' }), null)
  const b = runBanner({ op: 'handover', view: { phase: 'working', done: false, text: '關閉前任視窗中…', steps: [{ key: 'handoff', text: '請前任寫交接', state: 'done' }, { key: 'closing', text: '關閉前任視窗', state: 'active' }, { key: 'opening', text: '開新視窗', state: 'todo' }] } })
  assert.deepEqual(b.steps.map(s => s.mark), ['✓', '…', '○']); assert.equal(b.done, false)
  const d = runBanner({ op: 'handover', view: { phase: 'done', done: true, text: '接班換手完成，新視窗開好了。', extra: ['交接檔：x'] } })
  assert.equal(d.done, true); assert.deepEqual(d.extra, ['交接檔：x'])
})

// ---------- 頁面接線 ----------
test('接線：對話分頁是單一對話（不是列表）；「⋯」只在有選單項目時出現；選單在分頁外層、觸控目標 ≥ 44px', () => {
  const html = read('ui', 'm.html'), css = read('ui', 'mobile.css'), js = read('ui', 'm.js')
  assert.match(html, /<section class="m-pg m-chat" [^>]*aria-label="對話"/, '第二頁就是對話本身')
  assert.doesNotMatch(html, /m-threads|m-thread|threads|threadTimeText/, '對話列表拿掉')
  assert.match(html, /<chat-pane v-if="chatFriend"/); assert.match(html, /\{\{ chatEmptyText \}\}/)
  assert.match(html, /<button class="m-icon-btn" type="button" aria-label="更多操作" v-if="opsItems\.length" @click="openOps">/, '只有選單有項目才顯示「⋯」')
  assert.match(html, /<circle[\s\S]*?<circle[\s\S]*?<circle/, '「⋯」是三個點的 SVG（與其他圖示按鈕同一套）')
  // 選單是 position:fixed 的最外層元素，不放在 pager 裡（pager 有 transform 與 overflow:hidden，會裁掉）
  assert.ok(html.indexOf('class="m-ops"') > html.indexOf('<nav class="m-tabs"'), '選單在三個分頁之外')
  assert.match(css, /\.m-ops\{[^}]*position:fixed/)
  assert.match(css, /\.m-ops-panel\{[^}]*max-height:\d+dvh[^}]*overflow-y:auto/, '選單可捲動、不超出螢幕')
  assert.match(css, /\.m-ops-item\{[^}]*min-height:(4[4-9]|[5-9]\d)px/, '選單項目觸控目標 ≥ 44px')
  assert.match(css, /\.m-ops-panel\{[^}]*env\(safe-area-inset-bottom/, '不被手勢列蓋住')
  assert.match(js, /const opsItems = computed\(\(\) => \(chatFriend\.value \? menuItems\(chatFriend\.value, opsCtx\.value\) : \[\]\)\)/, '選單項目只用 menuItems')
  assert.match(js, /nonWindowNodes: \[info\.node\]/, '手機自己的視窗不顯示')
})

test('接線：送出走手機的 Rust 指令、先過 opFormError、輪詢用 runPartnerOp；不能按的不送', () => {
  const js = read('ui', 'm.js'), html = read('ui', 'm.html')
  assert.match(js, /invoke\('android_partner_op', \{ body \}\)/); assert.match(js, /invoke\('android_partner_ops', \{ ids \}\)/)
  const fn = /async function submitOp\(op\) \{([\s\S]*?)\n    \}\n/.exec(js)[1]
  assert.ok(fn.indexOf('opFormError(') >= 0 && fn.indexOf('opFormError(') < fn.indexOf('runPartnerOp('), '先檢查再送出')
  assert.match(fn, /if \(err\)/)
  assert.match(html, /:disabled="!i\.ok"/, '不能按的項目反灰'); assert.match(html, /\{\{ i\.reason \}\}/, '並顯示中文原因')
  assert.match(html, /v-for="m in opsModels"/); assert.match(html, /\{\{ opsModelNote \}\}/)
  assert.match(html, /v-model="ops\.newName"/); assert.match(html, /v-model="ops\.note"/)
  assert.match(html, /v-if="opsBanner"/, '對話頁頂端顯示進度')
})

test('接線：最後使用的那位存在手機本機設定、點夥伴就成為最後使用並切到對話分頁；舊的對話層與列表程式已移除', () => {
  const js = read('ui', 'm.js'), mob = read('ui', 'lib', 'mobile.mjs'), css = read('ui', 'mobile.css')
  assert.match(js, /lastChat: lastChat\.value/, '存進本機設定')
  assert.match(js, /lastChat\.value = normalizeLastChat\(saved\.lastChat\)/, '重開 App 讀回來')
  const open = /function openChat\(id\) \{([\s\S]*?)\n    \}\n/.exec(js)[1]
  assert.match(open, /lastChat\.value = id/); assert.match(open, /goTab\('chats'\)/)
  assert.doesNotMatch(js, /chatNav|nav\.chat|swipeStart\(\$event, 'chat'\)|backAsync|threadMap|threadRows|\bpc\b/)
  assert.doesNotMatch(mob, /threadRows|threadTime|lastMessage|chatNav/)
  assert.doesNotMatch(css, /m-thread|m-threads|b-last2/)
  assert.match(js, /isChatVisible: async id => document\.visibilityState === 'visible' && nav\.tab === 'chats' && lastChat\.value === id/, '正在看對話分頁那位才算看得到（不算未讀）')
})
