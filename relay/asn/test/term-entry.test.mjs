// 聊天頁的終端入口（#900／#901／#902）：在共用終端服務裡的夥伴，上面那排第 2 格是「終端」、輸入框旁沒有終端圖示；
// 不在服務裡的舊夥伴照舊前台／後台，大按鈕下方常駐一行小字；終端開關與捲動位置；讀不到畫面的提示不猜原因。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { TERM_BACK_TIP, TERM_LABEL, TERM_REOPEN_NOTE, TERM_TIP, askTermService, restoreTop, scrollMemo, termButtonView, termEntry } from '../ui/lib/term-entry.mjs'
import { WINDOW_LABEL, barSlots } from '../ui/lib/actionbar.mjs'
import { TERM_VIEW_LOST } from '../ui/lib/term-view.mjs'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8').replace(/\r\n/g, '\n')
const friend = (o = {}) => ({ id: 'H/小乙', agent: '小乙', nick: '小乙', node: 'H', status: 'online', engine: 'claude', ...o })
const windowSlot = ctx => barSlots(friend(), { selfNode: 'H', api: true, console: { state: 'toggle', visible: true }, ...ctx }).find(s => s.key === 'window')

test('入口：在服務裡＝終端、沒有小字；不在服務裡＝不放終端、有小字；查不到＝兩個都沒有', () => {
  assert.deepEqual(termEntry(true, true), { term: true, note: '' })
  assert.deepEqual(termEntry(true, false), { term: false, note: TERM_REOPEN_NOTE })
  assert.deepEqual(termEntry(true, null), { term: false, note: '' }, '查不到不亂講')
  assert.deepEqual(termEntry(false, true), { term: false, note: '' }, '別台電腦、離線、內建通道都不放')
  assert.deepEqual(termEntry(false, false), { term: false, note: '' })
})

test('第 2 格：在服務裡的夥伴是「終端」；舊夥伴照舊前台／後台', () => {
  const t = windowSlot({ term: true })
  assert.equal(t.label, TERM_LABEL)
  assert.equal(t.ok, true)
  assert.equal(t.term, true)
  const c = windowSlot({ term: false })
  assert.equal(c.label, WINDOW_LABEL.hide, '舊夥伴：前台／後台')
  assert.ok(!c.term)
  assert.equal(windowSlot({}).label, WINDOW_LABEL.hide, '名單右鍵等沒傳 term 的照舊')
})

test('第 2 格：離線的夥伴仍是喚醒、手機仍是反灰，不放終端', () => {
  const off = barSlots(friend({ status: 'offline' }), { selfNode: 'H', api: true, term: true }).find(s => s.key === 'window')
  assert.equal(off.wake, true)
  assert.ok(!off.term)
  const phone = barSlots(friend({ node: 'H' }), { selfNode: 'P', phone: true, term: true }).find(s => s.key === 'window')
  assert.ok(!phone.term)
  assert.equal(phone.ok, false)
})

test('問電腦端：只認 true／false；沒有 api、丟錯、回別的東西都是 null', async () => {
  assert.equal(await askTermService({ available: async () => true }, '小乙'), true)
  assert.equal(await askTermService({ available: async () => false }, '小乙'), false)
  assert.equal(await askTermService({ available: async () => 'yes' }, '小乙'), null)
  assert.equal(await askTermService(null, '小乙'), null)
  assert.equal(await askTermService({ available: async () => true }, ''), null)
  const info = console.info
  console.info = () => {}
  try {
    assert.equal(await askTermService({ available: async () => { throw new Error('壞了') } }, '小乙'), null)
  } finally { console.info = info }
  const asked = []
  await askTermService({ available: async n => { asked.push(n); return true } }, '小乙')
  assert.deepEqual(asked, ['小乙'])
})

test('捲動位置：關掉終端回到原本看的那裡；原本在底部就回底部', () => {
  const memo = scrollMemo({ scrollTop: 300, scrollHeight: 2000, clientHeight: 500 })
  assert.deepEqual(memo, { top: 300, bottom: false })
  assert.equal(restoreTop(memo, { scrollHeight: 2000, clientHeight: 500 }), 300)
  assert.equal(restoreTop(memo, { scrollHeight: 2400, clientHeight: 500 }), 300, '新訊息進來也不跳')
  const atBottom = scrollMemo({ scrollTop: 1500, scrollHeight: 2000, clientHeight: 500 })
  assert.equal(atBottom.bottom, true)
  assert.equal(restoreTop(atBottom, { scrollHeight: 2400, clientHeight: 500 }), 1900, '在底部：回到新的底部')
  assert.equal(restoreTop(null, { scrollHeight: 800, clientHeight: 500 }), 300)
  assert.equal(scrollMemo(null), null)
})

test('聊天頁接線：輸入框旁沒有終端圖示，入口只在上面那排', () => {
  const pane = read('ui', 'lib', 'chatpane.mjs')
  assert.ok(!pane.includes('看終端畫面'), '輸入框旁的終端圖示拿掉了')
  assert.match(pane, /<action-bar [^>]*:term="\{ ready: canTermView, on: termShown \}"[^>]*@term="toggleTerm"/)
  assert.match(pane, /<term-view v-if="termShown" /)
  assert.match(pane, /const canTermView = computed\(\(\) => termEntryView\.value\.term\)/, '入口看「在不在服務裡」')
  assert.match(pane, /askTermService\(props\.termViewApi, termViewName\.value\)/)
})

test('聊天頁接線：舊夥伴的那行小字在大按鈕下方，只在確定不在服務裡時出現', () => {
  const pane = read('ui', 'lib', 'chatpane.mjs')
  assert.match(pane, /<\/action-bar>\n  <p class="term-reopen-note" v-if="!noBar && !isRoom && termEntryView\.note" role="note">\{\{ termEntryView\.note \}\}<\/p>/)
  assert.equal(TERM_REOPEN_NOTE, '重新開一次這位夥伴，就能在 ASN 裡看終端')
  assert.ok(!read('ui', 'lib', 'actionbar.mjs').includes('TERM_REOPEN_NOTE'), '不放在按鈕提示裡')
})

test('大按鈕接線：第 2 格按下發 term，開著時有 on 與 aria-pressed、提示是回到訊息', () => {
  const ab = read('ui', 'lib', 'actionbar.mjs')
  assert.match(ab, /function onWindow\(\) \{[\s\S]{0,200}if \(slot\.value\.window\.term\) \{ emit\('term'\); return \}/)
  assert.match(ab, /emits: \['call', 'ops', 'term'\]/)
  assert.match(ab, /data-slot="window" :class="\{ on: slot\.window\.term && termOn \}" :aria-pressed="slot\.window\.term \? String\(termOn\) : null"/)
  assert.match(ab, /term: !lite\.value && props\.term\?\.ready === true/, '終端分頁的簡版不放')
  assert.ok(TERM_TIP.includes('ASN 裡') && TERM_BACK_TIP === '回到訊息')
  assert.match(read('ui', 'img', 'ab-term.svg'), /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 32 32" width="32" height="32">/)
})

test('上排第 2 個大按鈕依狀態換字與圖示（#901b）：看訊息時「看終端」＋終端圖示，看終端時「看訊息」＋對話圖示', () => {
  assert.deepEqual(termButtonView(false), { label: '看終端', icon: 'img/ab-term.svg' })
  assert.deepEqual(termButtonView(true), { label: '看訊息', icon: 'img/ab-window.svg' })
  assert.notEqual(termButtonView(true).icon, termButtonView(false).icon, '圖示不同，不只靠按下的顏色')
  assert.notEqual(termButtonView(true).label, termButtonView(false).label)
  const ab = read('ui', 'lib', 'actionbar.mjs')
  assert.match(ab, /const termBtn = computed\(\(\) => termButtonView\(termOn\.value\)\)/)
  assert.match(ab, /slot\.window\.term \? termBtn\.icon : 'img\/ab-window\.svg'/, '圖示由 termButtonView 來')
  assert.match(ab, /\{\{ slot\.window\.term \? termBtn\.label : slot\.window\.label \}\}/, '文字由 termButtonView 來')
  assert.match(ab, /:aria-label="slot\.window\.term \? termBtn\.label : slot\.window\.label"/)
})

test('文案：不寫技術名詞；讀不到畫面不猜「視窗可能已經關了」', () => {
  assert.equal(TERM_VIEW_LOST, '暫時讀不到這個畫面。')
  for (const s of [TERM_LABEL, TERM_TIP, TERM_BACK_TIP, TERM_REOPEN_NOTE, TERM_VIEW_LOST]) {
    assert.doesNotMatch(s, /mux|pane|WezTerm|窗格|#\d|服務/i, s)
  }
})

test('電腦端指令 term_view_available：只回 bool、只讀對照表、名字照夥伴名規則', () => {
  const lib = read('src-tauri', 'src', 'lib.rs')
  const cmd = /#\[tauri::command\]\nfn term_view_available\(([^)]*)\) -> bool \{\n([\s\S]*?)\n\}/.exec(lib)
  assert.ok(cmd, '找不到 term_view_available，或回傳不是 bool')
  assert.equal(cmd[2].trim(), 'terms.partner_in_service(&name)', '只轉給 partner_in_service，不做別的')
  assert.match(lib, /tauri::generate_handler!\[\n\s+term_view_open, term_view_close, term_view_input, term_view_active, term_view_available, /, '只掛在電腦版清單')
  const term = read('src-tauri', 'src', 'launch', 'term.rs')
  const body = term.split('pub fn partner_in_service(&self, name: &str) -> bool {')[1]?.split('\n    }\n')[0]
  assert.ok(body, '找不到 partner_in_service')
  assert.match(body, /super::config::valid_partner_name\(name\)/, '名字照夥伴名規則驗')
  for (const bad of ['wez(', 'pane_exit', 'pane_id', '.sock', 'persist', 'elog', 'println', 'dir()']) {
    assert.ok(!body.includes(bad), `不叫 wezterm、不回不記窗格編號或路徑：${bad}`)
  }
})
