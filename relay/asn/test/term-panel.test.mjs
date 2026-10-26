// 電腦版「終端」面板的純邏輯：狀態字樣、提示內容整理、使用者按選項才產生送出請求、輪詢（不重疊、單列失敗不拖累整輪）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PROMPT_TEXT_MAX, SEND_MAX, answerRequest, createTermPoller, folderName, kindTitle, promptKey, promptView, rowsOf, sendConfirmView, sendDraftView, sendRequest, sentText, stateView, willSendText } from '../ui/lib/term-panel.mjs'

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

test('送出：只有提示裡真的有的選項才產生請求，沒有預設選項；請求只含編號、提示種類、選項 n', () => {
  const pv = promptView(MENU)
  assert.deepEqual(answerRequest('3', pv, 1), { id: '3', prompt_kind: 'menu', n: 1 })
  assert.deepEqual(answerRequest('3', pv, 2), { id: '3', prompt_kind: 'menu', n: 2 })
  for (const bad of [0, 3, -1, 1.5, '1', undefined, null, NaN]) assert.equal(answerRequest('3', pv, bad), null, String(bad))
  assert.equal(answerRequest('', pv, 1), null); assert.equal(answerRequest('3', null, 1), null)
  assert.equal(answerRequest('3', promptView({ kind: 'unknown_prompt', text: 'x' }), 1), null, '沒有選項的提示不能代答')
  assert.deepEqual(Object.keys(answerRequest('3', pv, 1)).sort(), ['id', 'n', 'prompt_kind'])
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

test('接線：終端清單按鈕只在有終端時出現；有等你回答的終端時顯示提醒點', () => {
  const html = readUi('list.html')
  assert.ok(html.includes('v-if="terms.rows.length" title="終端"'))
  assert.ok(html.includes('v-if="terms.rows.some(r => r.prompt)"'))
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
  assert.equal((html.match(/termSendConfirm(?![A-Za-z])/g) ?? []).length, 1, '模板裡只有一個按鈕呼叫 termSendConfirm')
  assert.equal(count(html, '@click="termSendConfirm"'), 1)
  assert.ok(html.includes('@click="termSendAsk"') && html.includes('v-if="termSendConfirmView"'), '「送出」先開確認框')
  const ask = js.slice(js.indexOf('function termSendAsk'), js.indexOf('function termSendBack'))
  assert.ok(!ask.includes('termSend('), 'termSendAsk 不送字')
  assert.ok(tauri.includes("termSend: req => invoke('term_send', { req })"))
  assert.ok(html.includes('aria-label="要送進終端的文字"'))
})
