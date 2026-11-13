// 手機版「對話」分頁（最後使用的那一位）與「⋯」選單的純邏輯，以及頁面接線的守門。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { EMPTY_CHAT_TEXT, LOADING_CHAT_TEXT, MODEL_NOTE, OP_STEP, chatPageState, clearRun, moveRun, normalizeLastChat, opStep, phoneModels, renamedChatId, runBanner, runFor, setRun, showsInSheet } from '../ui/lib/mobile-ops.mjs'
import { MODEL_RE, OPS, buildOpRequest, menuItems } from '../ui/lib/partner-ops.mjs'

const read = (...p) => fs.readFileSync(new URL(`../${p.join('/')}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const F = (node, agent, extra = {}) => ({ id: `${node}/${agent}`, node, agent, nick: agent, status: 'online', engine: 'claude', device: `設備${node}`, ...extra })

test('對話分頁：記得最後使用的那一位；從來沒開過、記的那位不在名單上顯示提示；名單還沒載入顯示載入中', () => {
  const fl = [F('H', '小文'), F('W', '小武')]
  assert.deepEqual(chatPageState(fl, 'W/小武'), { kind: 'friend', friend: fl[1], text: '' })
  assert.deepEqual(chatPageState(fl, ''), { kind: 'empty', friend: null, text: EMPTY_CHAT_TEXT })
  assert.equal(EMPTY_CHAT_TEXT, '從夥伴分頁點一位開始對話')
  assert.equal(chatPageState(fl, 'X/不在了').kind, 'empty')
  const merged = [...fl, { ...F('Q', '終端服務收發室'), mergedInto: '~notice' }]
  assert.deepEqual(chatPageState(merged, 'Q/終端服務收發室'), { kind: 'empty', friend: null, text: EMPTY_CHAT_TEXT }, '已併進「通知」的舊收發室列不再開在對話頁（#895）')
  assert.deepEqual(chatPageState([], 'W/小武'), { kind: 'loading', friend: null, text: LOADING_CHAT_TEXT })
  assert.equal(chatPageState([], '').kind, 'empty', '沒記過人就不用等名單')
  for (const bad of [null, undefined, 5, {}, [], 'x'.repeat(201)]) assert.equal(normalizeLastChat(bad), '', String(bad))
  assert.equal(normalizeLastChat('H/小文'), 'H/小文')
})

test('「⋯」選單：項目與可按條件完全來自 partner-ops.menuItems（項目固定，可用的在線五項、離線只有喚醒）', () => {
  const machines = { H: { node: 'H', online: true, launcher: { profiles: [{ id: 'claude' }] } }, C: { node: 'C', online: true, launcher: null } }
  const ctx = { machines, loaded: true, signedIn: true, nonWindowNodes: ['P'] }
  assert.deepEqual(menuItems(F('H', '小文'), ctx).filter(i => i.ok).map(i => i.key), ['info', 'rename', 'model', 'close', 'handover'])
  assert.deepEqual(menuItems(F('H', '小離', { status: 'offline' }), ctx).filter(i => i.ok).map(i => i.key), ['resume'])
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

test('頂端進度條：主句、換班接手分段（✓／…／○）、交接檔位置；沒有進度不顯示', () => {
  assert.equal(runBanner(null), null); assert.equal(runBanner({ op: 'close' }), null)
  const b = runBanner({ op: 'handover', view: { phase: 'working', done: false, text: '關閉前任視窗中…', steps: [{ key: 'handoff', text: '請前任寫交接', state: 'done' }, { key: 'closing', text: '關閉前任視窗', state: 'active' }, { key: 'opening', text: '開新視窗', state: 'todo' }] } })
  assert.deepEqual(b.steps.map(s => s.mark), ['✓', '…', '○']); assert.equal(b.done, false)
  const d = runBanner({ op: 'handover', view: { phase: 'done', done: true, text: '換班接手完成，新視窗開好了。', extra: ['交接檔：x'] } })
  assert.equal(d.done, true); assert.deepEqual(d.extra, ['交接檔：x'])
})

// ---------- #928：進度綁在下指令的那位夥伴 ----------
const handoverRun = step => ({ op: 'handover', view: { phase: 'working', done: false, text: `${step}中…`, steps: [{ key: 'handoff', text: '請前任寫交接', state: 'active' }] } })
const modelRun = { op: 'model', view: { phase: 'working', done: false, text: '切換模型中…' } }

test('#928 進度只在下指令那位的對話：換班接手（重啟）切到別位看不到，回來還在、步驟照常前進', () => {
  let runs = setRun({}, 'w02/A', handoverRun('請前任寫交接'))
  assert.equal(runBanner(runFor(runs, 'w02/B')), null, '別位的對話看不到 A 的進度')
  assert.equal(runBanner(runFor(runs, 'w02/A')).text, '請前任寫交接中…')
  runs = setRun(runs, 'w02/A', { op: 'handover', view: { phase: 'working', done: false, text: '開新視窗中…' } })
  assert.equal(runBanner(runFor(runs, 'w02/A')).text, '開新視窗中…', '步驟前進只更新 A')
  runs = clearRun(runs, 'w02/A')
  assert.deepEqual(runs, {}, '按「知道了」只清 A，不殘留')
})

test('#928 切換模型與封存也各自綁在自己的夥伴；兩位同時在跑各自保留，互不覆蓋', () => {
  let runs = setRun({}, 'w02/A', handoverRun('請前任寫交接'))
  runs = setRun(runs, 'w02/B', modelRun)
  assert.equal(runFor(runs, 'w02/A').op, 'handover'); assert.equal(runFor(runs, 'w02/B').op, 'model')
  runs = setRun(runs, 'w02/C', { op: 'archive', view: { phase: 'done', done: true, text: '已封存' } })
  assert.equal(Object.keys(runs).length, 3)
  runs = clearRun(runs, 'w02/B')
  assert.deepEqual(Object.keys(runs).sort(), ['w02/A', 'w02/C'], '清 B 不動 A、C')
})

test('#928 key 是完整位址（節點/視窗名）：兩台電腦的同名夥伴不互蓋', () => {
  let runs = setRun({}, 'w02/asn40', handoverRun('請前任寫交接'))
  runs = setRun(runs, 'n678feaac/asn40', modelRun)
  assert.equal(runFor(runs, 'w02/asn40').op, 'handover'); assert.equal(runFor(runs, 'n678feaac/asn40').op, 'model')
  assert.equal(runFor(runs, 'asn40'), null, '只有名字查不到')
})

test('#928 改名完成：進度搬到新位址，舊位址清掉；沒有進度或位址相同不動；原物件不被改', () => {
  const before = setRun(setRun({}, 'w02/old', { op: 'rename', view: { phase: 'done', done: true, text: '改好了' } }), 'w02/B', modelRun)
  const after = moveRun(before, 'w02/old', 'w02/new')
  assert.equal(runFor(after, 'w02/old'), null); assert.equal(runFor(after, 'w02/new').op, 'rename'); assert.equal(runFor(after, 'w02/B').op, 'model')
  assert.ok(runFor(before, 'w02/old'), '不改原本的物件')
  assert.equal(moveRun(after, 'w02/none', 'w02/x'), after); assert.equal(moveRun(after, 'w02/new', 'w02/new'), after)
  assert.deepEqual(setRun({}, '', modelRun), {}, '沒有位址不存'); assert.equal(runFor({}, undefined), null)
})

test('#928 接線：m.js 不再有全域的單一進度；頂端進度只取目前對話那位，送出、封存、知道了都帶夥伴位址', () => {
  const js = read('ui', 'm.js')
  assert.doesNotMatch(js, /\bopsRun\b/, '單一全域進度拿掉')
  assert.match(js, /const opsBanner = computed\(\(\) => runBanner\(runFor\(opsRuns\.value, chatFriend\.value\?\.id\)\)\)/)
  assert.match(js, /opsRuns\.value = setRun\(opsRuns\.value, f\.id, \{ op, view: v \}\)/, '指令進度存在下指令那位')
  assert.match(js, /opsRuns\.value = setRun\(opsRuns\.value, f\.id, \{ op: 'archive'/, '封存也存在那位')
  assert.match(js, /opsRuns\.value = moveRun\(opsRuns\.value, f\.id, next\)/, '改名搬位址')
  assert.match(js, /const dismissRun = \(\) => \{ opsRuns\.value = clearRun\(opsRuns\.value, chatFriend\.value\?\.id\) \}/)
})

// ---------- 頁面接線 ----------
test('接線：對話分頁直接就是最後那一則（#1438，回到 0.2.17）、沒有最後一則時顯示提示；「⋯」只在有選單項目時出現；選單在分頁外層、觸控目標 ≥ 44px', () => {
  const html = read('ui', 'm.html'), css = read('ui', 'mobile.css'), js = read('ui', 'm.js')
  assert.match(html, /<section class="m-pg m-chat" :class="\{ shake, 'is-room': chatFriend && chatFriend\.room \}" aria-label="對話">/, '對話分頁直接就是那一則（不再先列清單、不看 nav.chat）')
  assert.doesNotMatch(html, /m-chat-list|v-for="x in chatRows"|aria-label="回對話清單"/, '對話分頁沒有清單、也沒有回清單的鍵')
  // 0.2.21（小良哥拍板）：左上「返回」加回來，切到夥伴分頁；對話是記錄最底層，所以走 goTab，不用 history.back()
  const back = html.match(/<button class="m-icon-btn m-back"[^>]*>/)?.[0] ?? ''
  assert.match(back, /aria-label="回夥伴"/)
  assert.match(back, /@click="goTab\('list'\)"/)
  assert.doesNotMatch(back, /history\.back|@click="back"/)
  assert.ok(html.indexOf('m-icon-btn m-back') < html.indexOf('class="m-plate"'), '返回在名牌前面（頂端左邊）')
  assert.match(html, /<div class="m-scroll" v-else><div class="empty-list">\{\{ chatEmptyText \}\}<\/div><\/div>/, '還沒有最後一則：顯示提示')
  assert.doesNotMatch(html, /m-threads|m-thread|threads|threadTimeText/, '舊的對話列表程式不再用')
  assert.match(html, /<chat-pane v-if="chatFriend"/); assert.match(html, /\{\{ chatEmptyText \}\}/)
  assert.match(html, /<button class="m-icon-btn m-head-more" type="button" aria-label="更多操作" v-if="opsItems\.length \|\| groupItems\.length" @click="openOps">/, '只有選單有項目（夥伴管理或邀請別人）才顯示「⋯」')
  assert.match(html, /<circle[\s\S]*?<circle[\s\S]*?<circle/, '「⋯」是三個點的 SVG（與其他圖示按鈕同一套）')
  // 選單是 position:fixed 的最外層元素，不放在 pager 裡（pager 有 transform 與 overflow:hidden，會裁掉）
  assert.ok(html.indexOf('class="m-ops"') > html.indexOf('<nav class="m-tabs"'), '選單在三個分頁之外')
  assert.match(css, /\.m-ops\{[^}]*position:fixed/)
  assert.match(css, /\.m-ops-panel\{[^}]*max-height:\d+dvh[^}]*overflow-y:auto/, '選單可捲動、不超出螢幕')
  assert.match(css, /\.m-ops-item\{[^}]*min-height:(4[4-9]|[5-9]\d)px/, '選單項目觸控目標 ≥ 44px')
  assert.match(css, /\.m-ops-panel\{[^}]*env\(safe-area-inset-bottom/, '不被手勢列蓋住')
  assert.match(js, /const opsItems = computed\(\(\) => \(chatFriend\.value \? manageItems\(chatFriend\.value, opsCtx\.value\) : \[\]\)\)/, '選單項目只用 manageItems（menuItems 加封存）')
  assert.match(js, /nonWindowNodes: \[info\.node\]/, '手機自己的視窗不顯示')
})

test('接線：送出走手機的 Rust 指令、先過 opFormError、輪詢用 runPartnerOp；不能按的不送', () => {
  const js = read('ui', 'm.js'), html = read('ui', 'm.html')
  assert.match(js, /invoke\('android_partner_op', \{ body \}\)/); assert.match(js, /invoke\('android_partner_ops', \{ ids \}\)/)
  const fn = /async function submitOp\(op\) \{([\s\S]*?)\n    \}\n/.exec(js)[1]
  assert.ok(fn.indexOf('opFormError(') >= 0 && fn.indexOf('opFormError(') < fn.indexOf('runPartnerOp('), '先檢查再送出')
  assert.match(fn, /if \(err\)/)
  assert.match(html, /v-for="i in opsView\.rows"[^>]*:aria-disabled="i\.ok \? 'false' : 'true'"[^>]*:aria-describedby="i\.ok \? null : 'ops-why-' \+ i\.key"/, '不能按的項目反灰（aria-disabled）並連到說明')
  assert.doesNotMatch(html, /v-for="i in opsView\.rows"[^>]*:disabled=/, '不用原生 disabled（讀得到說明、仍可聚焦）')
  assert.match(html, /<small class="m-opt-why" :id="'ops-why-' \+ i\.key" v-if="!i\.ok && i\.why">\{\{ i\.why \}\}<\/small>/, '手機沒有 hover，原因寫在項目下面的小字')
  assert.match(js, /if \(!item \|\| !item\.ok\) return/, '點反灰的項目不送出任何動作')
  assert.match(html, /v-for="m in opsModels"/); assert.match(html, /\{\{ opsModelNote \}\}/)
  assert.match(html, /v-model="ops\.newName"/); assert.match(html, /v-model="ops\.note"/)
  assert.match(html, /v-if="opsBanner"/, '對話頁頂端顯示進度')
})

test('接線：最後使用的那位存在手機本機設定、點夥伴就成為最後使用並進到那一則對話；舊的對話層與列表程式已移除', () => {
  const js = read('ui', 'm.js'), mob = read('ui', 'lib', 'mobile.mjs'), css = read('ui', 'mobile.css')
  assert.match(js, /lastChat: lastChat\.value/, '存進本機設定')
  assert.match(js, /lastChat\.value = normalizeLastChat\(saved\.lastChat\)/, '重開 App 讀回來')
  const open = /function openChat\(id\) \{([\s\S]*?)\n    \}\n/.exec(js)[1]
  assert.match(open, /lastChat\.value = id/); assert.match(open, /fourthNav\.openChat\(\)/)
  assert.doesNotMatch(js, /swipeStart\(\$event, 'chat'\)|backAsync|threadMap|threadRows|\bpc\b/)
  assert.doesNotMatch(mob, /threadRows|threadTime|lastMessage/)
  assert.doesNotMatch(css, /m-thread|m-threads|b-last2/)
  assert.match(js, /isChatVisible: async id => document\.visibilityState === 'visible' && viewedChatId\(\{ tab: nav\.tab, chat: nav\.chat, lastChat: lastChat\.value \}\) === id/, '正在看的那位（對話分頁點進去的那位或通知分頁）才算看得到（不算未讀）')
})
