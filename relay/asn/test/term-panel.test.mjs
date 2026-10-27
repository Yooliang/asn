// 電腦版「終端」面板的純邏輯：狀態字樣、提示內容整理、使用者按選項才產生送出請求、輪詢（不重疊、單列失敗不拖累整輪）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { BUSY_LONG_MIN, PROMPT_TEXT_MAX, SEND_MAX, UNLOCK_TEXT, WAIT_LONG_MIN, adoptRequest, answerRequest, candidateRows, createTermPoller, folderName, kindTitle, promptKey, promptView, rowsOf, sendConfirmView, sendDraftView, sendRequest, sentText, stateView, trackHeld, unlockRequest, willSendText } from '../ui/lib/term-panel.mjs'

const MENU = { kind: 'menu', text: '要信任這個資料夾嗎？', options: [{ n: 2, label: 'No, quit' }, { n: 1, label: 'Yes, proceed' }] }

test('狀態字樣：四種狀態有中文與色調，不認得的當狀態未知', () => {
  assert.deepEqual([stateView('idle').label, stateView('busy').label, stateView('waiting_user').label, stateView('unknown').label], ['閒置', '忙碌', '等你回答', '狀態未知'])
  assert.equal(stateView('waiting_user').tone, 'warn')
  for (const bad of [undefined, null, '', 'Idle', '__proto__', 'toString', 42]) assert.equal(stateView(bad).key, 'unknown', String(bad))
})

test('提示內容：選項依 n 排序、壞的丟掉、不重複；文字截到上限；沒有提示是 null', () => {
  const pv = promptView(MENU)
  assert.equal(pv.kind, 'menu'); assert.equal(pv.title, kindTitle('menu'))
  assert.deepEqual(pv.options, [{ n: 1, label: 'Yes, proceed' }, { n: 2, label: 'No, quit' }])
  const messy = promptView({ kind: 'menu', text: 'x'.repeat(PROMPT_TEXT_MAX + 50), options: [{ n: 1, label: 'a' }, { n: 1, label: '重複' }, { n: 0, label: '零' }, { n: 100, label: '太大' }, { n: 'x', label: '壞' }, { n: 2, label: '' }, null, { n: 3, label: '好' }] })
  assert.equal(messy.text.length, PROMPT_TEXT_MAX)
  assert.deepEqual(messy.options, [{ n: 1, label: 'a' }, { n: 3, label: '好' }])
  assert.equal(promptView(null), null); assert.equal(promptView('x'), null); assert.equal(promptView(undefined), null)
  assert.equal(promptView({ text: '問題' }).kind, 'unknown_prompt', '沒有種類當 unknown_prompt')
  assert.deepEqual(promptView({ kind: 'unknown_prompt', text: '最後幾行' }).options, [], '解析不出選項＝空清單，只顯示文字')
})

test('送出：只有提示裡真的有的選項才產生請求，沒有預設選項；請求含編號、提示種類、選項 n、原文與選項清單（給遠端確認雜湊）', () => {
  const pv = promptView(MENU)
  assert.deepEqual(answerRequest('3', pv, 1), {
    id: '3',
    prompt_kind: 'menu',
    n: 1,
    prompt_text: pv.text,
    options: pv.options.map(o => ({ n: o.n, label: o.label })),
  })
  assert.deepEqual(answerRequest('3', pv, 2)?.n, 2)
  for (const bad of [0, 3, -1, 1.5, '1', undefined, null, NaN]) assert.equal(answerRequest('3', pv, bad), null, String(bad))
  assert.equal(answerRequest('', pv, 1), null); assert.equal(answerRequest('3', null, 1), null)
  assert.equal(answerRequest('3', promptView({ kind: 'unknown_prompt', text: 'x' }), 1), null, '沒有選項的提示不能代答')
  assert.deepEqual(Object.keys(answerRequest('3', pv, 1)).sort(), ['id', 'n', 'options', 'prompt_kind', 'prompt_text'])
})

test('送出前後的說明：送前寫「第 n 項」與游標由 ASN 算，送後用後端回的按鍵描述', () => {
  const pv = promptView(MENU)
  assert.match(willSendText(pv, 2), /第 2 項「No, quit」/)
  assert.equal(willSendText(pv, 9), '')
  assert.equal(sentText('Down×1+Enter'), '已送出：Down×1+Enter')
  assert.equal(sentText(''), '已送出'); assert.equal(sentText(undefined), '已送出')
})

test('提示指紋：內容沒變就同一個（使用者按「我自己處理」後不再跳出），內容或選項變了就是新的', () => {
  const a = promptView(MENU), b = promptView(MENU), c = promptView({ ...MENU, text: '另一個問題' })
  assert.equal(promptKey('1', a), promptKey('1', b))
  assert.notEqual(promptKey('1', a), promptKey('1', c))
  assert.notEqual(promptKey('1', a), promptKey('2', a), '不同終端不同指紋')
})

test('清單：提示只在 waiting_user 才帶；沒有狀態當未知；壞資料略過', () => {
  const rows = rowsOf(
    [{ id: '1', profile: 'grok' }, { id: '2', profile: 'agy' }, { id: '3', profile: 'grok' }, null, { profile: 'x' }],
    { 1: { state: 'waiting_user', prompt: MENU, reason: 'trust_dialog' }, 2: { state: 'busy', prompt: MENU } },
  )
  assert.deepEqual(rows.map(r => [r.id, r.state, r.stateLabel]), [['1', 'waiting_user', '等你回答'], ['2', 'busy', '忙碌'], ['3', 'unknown', '狀態未知']])
  assert.ok(rows[0].prompt && rows[0].prompt.options.length === 2)
  assert.equal(rows[1].prompt, null, '不是 waiting_user 不帶提示')
  assert.equal(rows[0].title, 'grok #1'); assert.equal(rows[0].reason, 'trust_dialog')
  assert.deepEqual(rowsOf(undefined), [])
})

function fakeTimers() {
  const q = []
  return { setTimer: (fn, ms) => { q.push({ fn, ms }); return q.length }, clearTimer: () => {}, q }
}

test('輪詢：每輪 list＋逐一 status，結束後排下一輪；單一終端 status 失敗只讓那列變未知', async () => {
  const t = fakeTimers(), updates = []
  const transport = {
    termList: async () => [{ id: '1', profile: 'grok' }, { id: '2', profile: 'agy' }],
    termStatus: async ({ id }) => { if (id === '2') throw new Error('壞了'); return { state: 'idle' } },
  }
  const p = createTermPoller({ transport, onUpdate: r => updates.push(r), setTimer: t.setTimer, clearTimer: t.clearTimer, intervalMs: 3000 })
  await p.tickNow()
  assert.ok(updates.length >= 1)
  const last = updates.at(-1)
  assert.deepEqual(last.map(r => [r.id, r.state]), [['1', 'idle'], ['2', 'unknown']])
  assert.equal(t.q.at(-1).ms, 3000, '下一輪排在間隔之後')
  p.stop()
})

test('輪詢：一輪還沒跑完不會開下一輪；term_list 失敗回報錯誤且不更新、仍會排下一輪；stop 之後不再更新', async () => {
  const t = fakeTimers(); let release, calls = 0, errors = []
  const slow = { termList: () => { calls++; return new Promise(r => { release = () => r([]) }) }, termStatus: async () => ({ state: 'idle' }) }
  const p = createTermPoller({ transport: slow, onUpdate: () => {}, setTimer: t.setTimer, clearTimer: t.clearTimer })
  p.tickNow(); p.tickNow()
  assert.equal(calls, 1, '第一輪還沒回來，不會重疊')
  release(); await new Promise(r => setImmediate(r))
  p.stop()

  const t2 = fakeTimers(), updates = []
  const broken = { termList: async () => { throw new Error('連不上') }, termStatus: async () => ({ state: 'idle' }) }
  const q = createTermPoller({ transport: broken, onUpdate: r => updates.push(r), onError: m => errors.push(m), setTimer: t2.setTimer, clearTimer: t2.clearTimer })
  await new Promise(r => setImmediate(r))
  assert.deepEqual(errors, ['連不上']); assert.equal(updates.length, 0); assert.ok(t2.q.length >= 1, '失敗也會再排下一輪')
  q.stop()
  const before = updates.length
  await q.tickNow()
  assert.equal(updates.length, before, 'stop 之後不再更新')
})

test('資料夾：清單帶 cwd 與最後一段資料夾名（Windows 與 POSIX 路徑都行）；舊後端沒有 cwd 就空', () => {
  assert.equal(folderName('D:\\Github\\Yooliang\\asn'), 'asn')
  assert.equal(folderName('/home/u/proj/'), 'proj')
  assert.equal(folderName('C:\\'), 'C:')
  for (const bad of ['', null, undefined, 42, '///']) assert.equal(folderName(bad), '', String(bad))
  const rows = rowsOf([{ id: '1', profile: 'grok', cwd: 'D:\\Github\\x' }, { id: '2', profile: 'agy' }])
  assert.deepEqual([rows[0].cwd, rows[0].folder, rows[1].cwd, rows[1].folder], ['D:\\Github\\x', 'x', '', ''])
})

// ---- 畫面接線的守門：term_answer 的唯一入口是提示框的「送出」，不自動代答 ----
const UI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'ui')
const readUi = f => fs.readFileSync(path.join(UI, f), 'utf8').replace(/\r\n/g, '\n')
const count = (text, needle) => text.split(needle).length - 1

test('接線：term_answer 只在 termConfirm 裡呼叫一次；termConfirm 只有「送出」按鈕觸發，且要先選了選項', () => {
  const js = readUi('list.js'), html = readUi('list.html')
  assert.equal(count(js, 'transport.termAnswer('), 1, '整支 list.js 只能有一處呼叫 termAnswer')
  const at = js.indexOf('transport.termAnswer(')
  const fnStart = js.lastIndexOf('async function termConfirm', at)
  assert.ok(fnStart > 0 && js.indexOf('\n}\n', fnStart) > at, '那一處在 termConfirm 裡')
  assert.ok(js.slice(fnStart, at).includes('answerRequest('), '送出前先過 answerRequest（選項必須真的在提示裡）')
  assert.equal(count(html, 'termConfirm'), 1, '模板裡只有一個按鈕呼叫 termConfirm')
  assert.ok(html.includes(':disabled="!terms.selected || terms.busy" @click="termConfirm"'), '沒選選項、或送出中，按鈕是停用的')
  assert.ok(!js.includes('terms.selected = terms.rows') && !js.includes('selected = 1'), '沒有預設選項')
})

test('接線：提示框有選項清單（逐項按鈕）、說明「將選擇…」、「我自己在視窗裡處理」只關框；用語不出現「收發室」', () => {
  const html = readUi('list.html'), js = readUi('list.js')
  const a = html.indexOf('id="term-prompt-title"'), b = html.indexOf('id="term-list-title"')
  assert.ok(a > 0 && b > a)
  const dlg = html.slice(a, b)
  assert.ok(dlg.includes('v-for="o in termPrompt.pv.options"') && dlg.includes('@click="termPick(o.n)"'))
  assert.ok(dlg.includes('{{ termWill }}') && dlg.includes('@click="termDismiss"') && dlg.includes('我自己在視窗裡處理'))
  assert.ok(!dlg.includes('收發室') && !html.slice(b, b + 900).includes('收發室'))
  const dismiss = js.slice(js.indexOf('function termDismiss'), js.indexOf('async function termConfirm'))
  assert.ok(!dismiss.includes('termAnswer') && !dismiss.includes('transport.'), '「我自己處理」不送任何東西')
})

test('接線：終端入口併進「＋」選單（#349）；有終端等你回答時「＋」上有紅點、選單可直接跳過去', () => {
  const html = readUi('list.html')
  const js = readUi('list.js')
  assert.ok(!html.includes('term-ic'), '搜尋列不再有終端按鈕')
  assert.ok(html.includes('class="search-ic plus-btn"') && html.includes('<span class="term-badge" v-if="termWaitCount"'), '「＋」上的紅點')
  const menu = html.slice(html.indexOf('class="av-menu launch-picker"'), html.indexOf('</ul>', html.indexOf('class="av-menu launch-picker"')))
  for (const s of ['@click="openWaitingTerm"', 'groupFlow.openCreate()', 'groupFlow.openJoin()']) assert.ok(menu.includes(s), `「＋」選單缺 ${s}`)
  assert.ok(!menu.includes('adoptLoad'), '「接手已開著的終端視窗…」搬到各對話窗的「管理」（小良哥 #753），「＋」選單不再有')
  assert.ok(!menu.includes('openTermStart'), '「在這台開終端…」併進開新夥伴對話框的『運行』，選單不再有獨立入口（小良哥 #697）')
  assert.ok(js.includes("const termWaitCount = computed(() => terms.rows.filter(r => r.state === 'waiting_user').length)"))
})

// ---- ASN 替使用者往終端送字（#296）----
const ROW = { id: '4', title: 'grok #4', folder: 'proj', cwd: 'D:\\work\\proj', state: 'idle' }

test('送字草稿：空白、太長、終端在等你回答、沒有資料夾紀錄都不能送，並說明原因', () => {
  assert.equal(sendDraftView(ROW, '請只回覆 OK').ok, true)
  assert.equal(sendDraftView(ROW, '   \n ').ok, false)
  assert.match(sendDraftView(ROW, '').reason, /請先寫/)
  assert.match(sendDraftView(ROW, 'a'.repeat(SEND_MAX + 1)).reason, /太長/)
  assert.equal(sendDraftView(ROW, 'a'.repeat(SEND_MAX)).ok, true)
  assert.match(sendDraftView({ ...ROW, state: 'waiting_user' }, 'hi').reason, /等你回答/)
  assert.match(sendDraftView({ ...ROW, cwd: '' }, 'hi').reason, /沒有工作資料夾/)
  assert.equal(sendDraftView(null, 'hi').ok, false)
  assert.equal(sendDraftView(ROW, 'a\nb').flattened, true, '多行會合成一行')
  assert.equal(sendDraftView(ROW, 'a\n\n').flattened, false, '空行不算多行')
})

test('送字確認框：寫明送到哪個終端與資料夾、送什麼字、按不按 Enter；草稿不合格就沒有確認框', () => {
  const v = sendConfirmView(ROW, '請只回覆 OK', true)
  assert.equal(v.target, 'grok #4・proj')
  assert.equal(v.text, '請只回覆 OK')
  assert.match(v.note, /再按一次 Enter/)
  assert.match(sendConfirmView(ROW, 'a\nb', false).note, /合成一行.*不按 Enter/)
  assert.equal(sendConfirmView({ ...ROW, state: 'waiting_user' }, 'hi', true), null)
  assert.equal(sendConfirmView(ROW, '', true), null)
})

test('送字請求：只有編號、文字、是否換行三個欄位；草稿不合格回 null；enter 只認 true', () => {
  assert.deepEqual(sendRequest(ROW, 'hi', true), { id: '4', text: 'hi', enter: true })
  assert.deepEqual(sendRequest(ROW, 'hi', false), { id: '4', text: 'hi', enter: false })
  assert.equal(sendRequest(ROW, 'hi', 'yes').enter, false)
  assert.deepEqual(Object.keys(sendRequest(ROW, 'hi', true)).sort(), ['enter', 'id', 'text'])
  assert.equal(sendRequest(ROW, '  ', true), null)
  assert.equal(sendRequest({ ...ROW, state: 'waiting_user' }, 'hi', true), null)
})

test('接線：term_send 只在 termSendConfirm 裡呼叫一次；只有「確認送出」按鈕觸發；「送出」只跳確認框，不送', () => {
  const js = readUi('list.js'), html = readUi('list.html'), tauri = readUi('lib/tauri.mjs')
  assert.equal(count(js, 'transport.termSend('), 1, '整支 list.js 只能有一處呼叫 termSend')
  const at = js.indexOf('transport.termSend(')
  const fnStart = js.lastIndexOf('async function termSendConfirm', at)
  assert.ok(fnStart > 0 && js.indexOf('\n}\n', fnStart) > at, '那一處在 termSendConfirm 裡')
  assert.ok(js.slice(fnStart, at).includes('sendRequest('), '送出前先過 sendRequest（草稿要合格）')
  // #331：確認有兩處擺放（對話分頁裡的確認列、舊面板的確認框），都只在 termSendConfirmView 存在時才看得到
  assert.equal((html.match(/termSendConfirm(?![A-Za-z])/g) ?? []).length, 2, '模板裡只有兩個按鈕呼叫 termSendConfirm（確認列、確認框）')
  assert.equal(count(html, '@click="termSendConfirm"'), 2)
  for (const m of html.matchAll(/@click="termSendConfirm"/g)) {
    assert.ok(html.lastIndexOf('termSendConfirmView', m.index) > 0, '按鈕在確認畫面裡（前面要有 termSendConfirmView 的條件）')
  }
  assert.ok(html.includes('@click="termSendAsk"') && html.includes('v-if="termSendConfirmView"'), '「送出」先開確認框')
  const ask = js.slice(js.indexOf('function termSendAsk'), js.indexOf('function termSendPhone'))
  assert.ok(!ask.includes('termSend(') && !ask.includes('term_remote_offer_send'), 'termSendAsk 不送字、也不自動傳手機（#331）')
  assert.equal(count(js, "invoke('term_remote_offer_send'"), 1, '傳手機只有 termSendPhone 一處')
  assert.ok(js.slice(js.indexOf('function termSendPhone'), js.indexOf('function termSendBack')).includes("invoke('term_remote_offer_send'"))
  assert.equal(count(html, '@click="termSendPhone"'), 2, '「改用手機確認」按鈕兩處（確認列、確認框）')
  assert.ok(tauri.includes("termSend: req => invoke('term_send', { req })"))
  const back = js.slice(js.indexOf('function termSendBack'), js.indexOf('async function termSendConfirm'))
  assert.ok(back.includes('termSendWithdraw()'), '按「返回」要撤回手機上的請求（#329）')
  assert.ok(js.slice(js.indexOf('function termSendOpen'), js.indexOf('function termSendAsk')).includes('termSendWithdraw()'), '關掉或換終端也撤回')
  assert.ok(js.includes("invoke('term_remote_withdraw'"))
  assert.ok(js.slice(js.indexOf('function termsClose'), js.indexOf('function termSendOpen')).includes('termSendWithdraw()'), '關整個面板也撤回')
  assert.ok(!html.includes('terms.open = false'), '模板裡不再直接把面板關掉（一律走 termsClose）')
  // 手機已處理後不能再送一次（#334 審查）：phone 狀態下 termSend 前要先查 term_remote_pending；忙碌也擋
  const conf = js.slice(js.indexOf('async function termSendConfirm'), js.indexOf('// ---------- 終端放進名單'))
  assert.ok(conf.indexOf('termPhonePending(') > 0 && conf.indexOf('termPhonePending(') < conf.indexOf('transport.termSend('), '送字前先查手機那筆還在不在')
  assert.ok(conf.includes("composerView(termSendRow.value).mode !== 'ready'") && conf.indexOf("composerView(termSendRow.value).mode") < conf.indexOf('transport.termSend('), '送字前再擋一次忙碌')
  assert.ok(js.includes('p?.termId === id'), 'PendingView 欄位是 camelCase（termId）')
  const ph = js.slice(js.indexOf('function termSendPhone'), js.indexOf('async function termPhonePending'))
  assert.ok(ph.includes("invoke('term_remote_withdraw'"), '傳手機途中取消：回來後再撤一次')
  assert.ok(html.includes('aria-label="要送進終端的文字"'))
})

// ---- 卡太久的提示 ----
test('忙碌／等你回答太久：從第一次看到這個狀態起算，超過門檻才出字；狀態一變就重新起算；消失的列不留', () => {
  const M = 60000, T0 = 1_000_000
  const r = (id, state) => ({ id, state })
  let t = trackHeld({}, [r('1', 'busy'), r('2', 'waiting_user'), r('3', 'idle')], T0)
  assert.deepEqual(t.rows.map(x => x.held), ['', '', ''], '剛看到：沒有提示')
  t = trackHeld(t.since, [r('1', 'busy'), r('2', 'waiting_user'), r('3', 'idle')], T0 + (WAIT_LONG_MIN - 1) * M)
  assert.deepEqual(t.rows.map(x => x.held), ['', '', ''], '還沒到門檻')
  t = trackHeld(t.since, [r('1', 'busy'), r('2', 'waiting_user'), r('3', 'idle')], T0 + WAIT_LONG_MIN * M + 5000)
  assert.deepEqual(t.rows.map(x => x.held), ['', `已等你回答 ${WAIT_LONG_MIN} 分鐘`, ''], '等你回答先到門檻；閒置永遠不提示')
  t = trackHeld(t.since, [r('1', 'busy'), r('2', 'waiting_user')], T0 + BUSY_LONG_MIN * M)
  assert.equal(t.rows[0].held, `忙碌已 ${BUSY_LONG_MIN} 分鐘`)
  assert.equal(t.since['3'], undefined, '消失的列從對照拿掉')
  t = trackHeld(t.since, [r('1', 'idle'), r('2', 'waiting_user')], T0 + (BUSY_LONG_MIN + 1) * M)
  assert.equal(t.rows[0].held, '', '狀態變了就不再提示')
  t = trackHeld(t.since, [r('1', 'busy')], T0 + (BUSY_LONG_MIN + 2) * M)
  assert.equal(t.rows[0].held, '', '又變回忙碌是重新起算')
  assert.deepEqual(trackHeld(undefined, 'x', T0), { since: {}, rows: [] }, '壞資料不丟錯')
  assert.equal(trackHeld({ 1: { state: 'busy', since: 'x' } }, [r('1', 'busy')], T0).rows[0].held, '', '對照壞掉就重新起算')
})

test('卡太久的提示：只有狀態與時間，不帶終端畫面文字；接線在輪詢更新裡', () => {
  const t = trackHeld({}, [{ id: '1', state: 'waiting_user', prompt: { text: '機密畫面文字' } }], 0).rows[0]
  assert.ok(!t.held.includes('機密'), '提示文字不含畫面內容')
  const js = readUi('list.js'), html = readUi('list.html')
  assert.ok(js.includes('trackHeld(termSince, raw, Date.now())'))
  assert.ok(html.includes('class="term-held" v-if="r.held"'))
})

// ---- 接手使用者自己開的 WezTerm 窗格（#285，後端 #313）----
const CAND = { pid: 4242, pane_id: 3, started_ms: 1700000000000, profile: 'grok', tab_title: 'my grok', cwd_raw: 'file://HOST/D:/work/proj%20x', cwd_authorized: true, version_verified: true, version_note: '', already_adopted: false }

test('接手候選：欄位壞掉的丟掉；資料夾取最後一段（網址編碼會還原）；版本未驗證說明原因；已接手的不能再按', () => {
  const rows = candidateRows([CAND, { ...CAND, pid: 0 }, { ...CAND, pane_id: -1 }, { ...CAND, started_ms: 'x' }, null, { ...CAND, profile: 3 }])
  assert.equal(rows.length, 1)
  assert.deepEqual([rows[0].key, rows[0].profile, rows[0].folder, rows[0].authorized, rows[0].canAdopt, rows[0].note], ['4242:3', 'grok', 'proj x', true, true, ''])
  const un = candidateRows([{ ...CAND, version_verified: false, version_note: '版本不是 20240203', cwd_authorized: false }])[0]
  assert.deepEqual([un.verified, un.note, un.authorized], [false, '版本不是 20240203', false])
  assert.match(candidateRows([{ ...CAND, version_verified: false, version_note: '' }])[0].note, /只能讀取/, '沒有原因也要說只能讀')
  assert.equal(candidateRows([{ ...CAND, already_adopted: true }])[0].canAdopt, false)
  assert.equal(candidateRows([{ ...CAND, tab_title: 'a\u0000b\u001bc' }])[0].title, 'a b c', '控制字元不進畫面')
  assert.deepEqual(candidateRows('壞的'), [])
})

test('接手請求：pid、窗格、建立時間原樣帶回；已接手或欄位壞的回 null', () => {
  const row = candidateRows([CAND])[0]
  assert.deepEqual(adoptRequest(row), { pid: 4242, pane_id: 3, started_ms: 1700000000000 })
  assert.equal(adoptRequest({ ...row, canAdopt: false }), null)
  assert.equal(adoptRequest(null), null)
  assert.equal(adoptRequest({ ...row, started_ms: 0 }), null)
  assert.deepEqual(Object.keys(adoptRequest(row)).sort(), ['pane_id', 'pid', 'started_ms'])
})

test('解鎖請求：只對已接手的窗格；一次只開被選的那一個，另一個維持關；不認得的種類回 null', () => {
  const adopted = { id: '7', adopted: true }
  assert.deepEqual(unlockRequest(adopted, 'answer'), { id: '7', allow_answer: true, allow_send: false })
  assert.deepEqual(unlockRequest(adopted, 'send'), { id: '7', allow_answer: false, allow_send: true })
  assert.equal(unlockRequest({ id: '7', adopted: false }, 'send'), null, '自己開的終端不需要也不能解鎖')
  assert.equal(unlockRequest(adopted, 'both'), null)
  assert.equal(unlockRequest(null, 'send'), null)
  assert.match(UNLOCK_TEXT.send.ask, /確認送出/)
  assert.match(UNLOCK_TEXT.answer.ask, /送出/)
})

test('清單：term_list 的 adopted 帶進列，沒有就是 false', () => {
  const rows = rowsOf([{ id: '1', profile: 'grok', adopted: true, cwd: 'D:\a' }, { id: '2', profile: 'grok', cwd: 'D:\b' }])
  assert.deepEqual(rows.map(r => r.adopted), [true, false])
})

test('清單：接手窗格的「已允許」照 term_list 的 answer_unlocked／send_unlocked；要明確 true 才算，自己開的終端一律已允許', () => {
  const rows = rowsOf([
    { id: '1', adopted: true, answer_unlocked: true, send_unlocked: false },
    { id: '2', adopted: true },                                          // 缺欄（舊後端）：當沒允許
    { id: '3', adopted: true, answer_unlocked: 'true', send_unlocked: 1 }, // 壞值：當沒允許
    { id: '4', answer_unlocked: false, send_unlocked: false },             // 自己開的：不用解鎖
  ])
  assert.deepEqual(rows.map(r => [r.answerUnlocked, r.sendUnlocked]), [[true, false], [false, false], [false, false], [true, true]])
})

test('接線：term_adopt_unlock 只在 adoptUnlockConfirm 裡呼叫一次、只有「允許」按鈕觸發（先跳確認）；term_adopt 只在 adoptDo；寫入開關預設關', () => {
  const js = readUi('list.js'), html = readUi('list.html'), tauri = readUi('lib/tauri.mjs')
  assert.equal(count(js, 'transport.termAdoptUnlock('), 1)
  const at = js.indexOf('transport.termAdoptUnlock(')
  const fnStart = js.lastIndexOf('async function adoptUnlockConfirm', at)
  assert.ok(fnStart > 0 && js.indexOf('\n}\n', fnStart) > at, '那一處在 adoptUnlockConfirm 裡')
  assert.ok(js.slice(fnStart, at).includes('unlockRequest('), '送出前先過 unlockRequest')
  assert.equal((html.match(/adoptUnlockConfirm(?![A-Za-z])/g) ?? []).length, 1, '模板只有一個按鈕呼叫 adoptUnlockConfirm')
  assert.equal((html.match(/adoptUnlockAsk\(r, /g) ?? []).length, 2, '兩個「允許…」按鈕都只是開確認框')
  const ask = js.slice(js.indexOf('function adoptUnlockAsk'), js.indexOf('function adoptUnlockCancel'))
  assert.ok(!ask.includes('termAdoptUnlock'), 'adoptUnlockAsk 不解鎖')
  assert.equal(count(js, 'transport.termAdopt('), 1)
  assert.ok(js.slice(js.lastIndexOf('async function adoptDo', js.indexOf('transport.termAdopt(')), js.indexOf('transport.termAdopt(')).includes('adoptRequest('))
  assert.ok(!/adopt\.unlocked|unlocked: \{\}/.test(js + html), '「已允許」不在畫面自己記（#317 起讀 term_list）')
  assert.equal((html.match(/v-if="!r\.answerUnlocked"/g) ?? []).length, 1); assert.equal((html.match(/v-if="!r\.sendUnlocked"/g) ?? []).length, 1)
  const confirmFn = js.slice(js.indexOf('async function adoptUnlockConfirm')).split('\n}\n')[0]
  assert.ok(confirmFn.includes('termPoller?.tickNow()'), '允許後立刻重讀清單')
  assert.ok(tauri.includes("termAdoptUnlock: req => invoke('term_adopt_unlock', { req })") && tauri.includes("termStop: req => invoke('term_stop', { req })"))
})
