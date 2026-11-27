// 聊天頁的終端入口（#900／#901／#902）：在共用終端服務裡的夥伴，上面那排第 2 格是「終端」、輸入框旁沒有終端圖示；
// 不在服務裡的舊夥伴照舊前台／後台，大按鈕下方常駐一行小字；終端開關與捲動位置；讀不到畫面的提示不猜原因。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { TERM_BACK_TIP, TERM_LABEL, TERM_REOPEN_NOTE, TERM_STATE_TEXT, TERM_TIP, TERM_WAITING_NOTE, askTermService, nextTermState, restoreTop, scrollMemo, termButtonView, termEntry } from '../ui/lib/term-entry.mjs'
import { infoRows } from '../ui/lib/partner-ops.mjs'
import { WINDOW_LABEL, barSlots } from '../ui/lib/actionbar.mjs'
import { TERM_VIEW_LOST } from '../ui/lib/term-view.mjs'
import { REMOTE_LABEL } from '../ui/lib/term-remote.mjs'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8').replace(/\r\n/g, '\n')
const friend = (o = {}) => ({ id: 'H/小乙', agent: '小乙', nick: '小乙', node: 'H', status: 'online', engine: 'claude', ...o })
const windowSlot = ctx => barSlots(friend(), { selfNode: 'H', api: true, console: { state: 'toggle', visible: true }, ...ctx }).find(s => s.key === 'window')

test('入口三種狀態：已登記＝終端；暫時接不回＝反灰、不叫人重開；確定不在＝才有重開那句；查不到＝都沒有', () => {
  assert.deepEqual(termEntry(true, 'ok'), { term: true, waiting: false, note: '' })
  assert.deepEqual(termEntry(true, 'waiting'), { term: false, waiting: true, note: '' }, '暫時接不回：不提示重開')
  assert.deepEqual(termEntry(true, 'gone'), { term: false, waiting: false, note: TERM_REOPEN_NOTE })
  assert.deepEqual(termEntry(true, null), { term: false, waiting: false, note: '' }, '查不到不亂講')
  assert.deepEqual(termEntry(false, 'ok'), { term: false, waiting: false, note: '' }, '別台電腦、離線、內建通道都不放')
  assert.deepEqual(termEntry(false, 'waiting'), { term: false, waiting: false, note: '' })
  assert.deepEqual(termEntry(false, 'gone'), { term: false, waiting: false, note: '' })
  // 舊版電腦端只回 true／false 時照舊
  assert.deepEqual(termEntry(true, true), termEntry(true, 'ok'))
  assert.deepEqual(termEntry(true, false), termEntry(true, 'gone'))
})

test('第 2 格：暫時接不回＝反灰＋「正在重新連上」、不叫人重開；確定不在＝照舊前台／後台，說明多帶重開那句', () => {
  const w = windowSlot({ term: false, termWaiting: true })
  assert.equal(w.ok, false, '按鈕不可按')
  assert.equal(w.reason, TERM_WAITING_NOTE)
  assert.ok(!w.reason.includes('重新開一次'), '不提示重開')
  assert.ok(!w.term)
  const g = windowSlot({ term: false, termNote: TERM_REOPEN_NOTE })
  assert.equal(g.ok, true, '確定不在：前台／後台照常可用')
  assert.equal(g.note, TERM_REOPEN_NOTE)
  assert.equal(windowSlot({ term: false }).note, '')
  const ab = read('ui', 'lib', 'actionbar.mjs')
  assert.match(ab, /slot\.window\.note \? consoleView\.tip \+ '（' \+ slot\.window\.note \+ '）' : consoleView\.tip/, '那句放在按鈕說明裡')
  assert.match(ab, /termWaiting: props\.term\?\.waiting === true, termNote: props\.term\?\.note \|\| ''/)
})

test('詳情的終端那一列和按鈕同一份狀態', () => {
  const row = s => infoRows({ by_asn: true, term_state: s }).find(x => x.label === '終端')?.value
  assert.equal(row('ok'), TERM_STATE_TEXT.ok)
  assert.equal(row('waiting'), TERM_WAITING_NOTE)
  assert.equal(row('gone'), TERM_STATE_TEXT.gone)
  assert.equal(row('亂寫'), undefined, '不認得的值不列')
  assert.equal(row(undefined), undefined, '舊版電腦端沒帶就不列')
  assert.equal(TERM_STATE_TEXT.waiting, TERM_WAITING_NOTE)
  assert.ok(!TERM_STATE_TEXT.waiting.includes('重新開一次'), '暫時接不回不叫人重開')
  assert.ok(TERM_STATE_TEXT.gone.includes('重新開一次這位夥伴'))
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

test('問電腦端：有 state 指令問狀態（ok／waiting／gone）；舊版退回在不在；沒有 api、丟錯、回別的東西都是 null', async () => {
  for (const s of ['ok', 'waiting', 'gone']) assert.equal(await askTermService({ state: async () => ({ state: s, reason: '' }) }, '小乙'), s)
  assert.equal(await askTermService({ state: async () => ({ state: '亂寫' }), available: async () => true }, '小乙'), 'ok', '不認得就退回在不在')
  const info0 = console.info
  console.info = () => {}
  try {
    assert.equal(await askTermService({ state: async () => { throw new Error('舊版沒有') }, available: async () => false }, '小乙'), 'gone', '舊版電腦端沒有 state：退回在不在')
  } finally { console.info = info0 }
  assert.equal(await askTermService({ available: async () => true }, '小乙'), 'ok')
  assert.equal(await askTermService({ available: async () => false }, '小乙'), 'gone')
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
  assert.match(pane, /<action-bar [^>]*:term="termBar"[^>]*@term="toggleTerm"/)
  assert.match(pane, /: \{ ready: canTermView\.value, on: termShown\.value, stuck: Boolean\(stuckNoteText\.value\), waiting: /, '本機的夥伴：第 2 格照舊是「終端」（別台電腦的夥伴走 REMOTE_LABEL，字也是「終端」）')
  assert.match(pane, /<term-view v-if="termShown" /)
  assert.match(pane, /const canTermView = computed\(\(\) => termEntryView\.value\.term\)/, '入口看「在不在服務裡」')
  assert.match(pane, /askTermService\(props\.termViewApi, termViewName\.value\)/)
})

test('聊天頁接線：重開提示不再常駐在大按鈕下方，改放在按鈕說明；狀態帶進按鈕', () => {
  const pane = read('ui', 'lib', 'chatpane.mjs')
  assert.ok(!pane.includes('termEntryView.note" role="note"'), '按鈕下方不再有常駐小字')
  assert.match(pane, /waiting: termEntryView\.value\.waiting, note: termEntryView\.value\.note \}/, '狀態帶進按鈕')
  assert.equal(TERM_REOPEN_NOTE, '重新開一次這位夥伴，就能在 ASN 裡看終端')
})

test('大按鈕接線：第 2 格按下發 term，開著時有 on 與 aria-pressed、提示是回到訊息', () => {
  const ab = read('ui', 'lib', 'actionbar.mjs')
  assert.match(ab, /function onWindow\(\) \{[\s\S]{0,200}if \(slot\.value\.window\.term\) \{ emit\('term'\); return \}/)
  assert.match(ab, /emits: \['call', 'ops', 'term', 'back', 'member', 'launch-new', 'op-note']/)
  assert.match(ab, /data-slot="window" :class="\{ on: slot\.window\.term && termOn \}" :aria-pressed="slot\.window\.term \? String\(termOn\) : null"/)
  assert.match(ab, /term: !lite\.value && props\.term\?\.ready === true/, '終端分頁的簡版不放')
  assert.ok(TERM_TIP.includes('ASN 裡') && TERM_BACK_TIP === '回到訊息')
  assert.match(read('ui', 'img', 'ab-term.svg'), /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 32 32" width="32" height="32">/)
})

test('上排第 2 個大按鈕依狀態換字與圖示（#901b、#1029）：看訊息時「終端」＋終端圖示，看終端時「訊息」＋對話圖示', () => {
  assert.deepEqual(termButtonView(false), { label: '終端', icon: 'img/ab-term.svg' })
  assert.deepEqual(termButtonView(true), { label: '訊息', icon: 'img/ab-window.svg' })
  assert.notEqual(termButtonView(true).icon, termButtonView(false).icon, '圖示不同，不只靠按下的顏色')
  assert.notEqual(termButtonView(true).label, termButtonView(false).label)
  // 別台夥伴（#968）：字和本機一樣（#1029），開著時一律「訊息」
  assert.deepEqual(termButtonView(false, REMOTE_LABEL), termButtonView(false), '別台夥伴：關著時和本機一樣是「終端」＋終端圖示')
  assert.deepEqual(termButtonView(true, REMOTE_LABEL), termButtonView(true), '別台夥伴：開著時和本機一樣是「訊息」＋對話圖示')
  assert.deepEqual(termButtonView(false, ''), { label: '終端', icon: 'img/ab-term.svg' })
  assert.deepEqual(termButtonView(true, ''), { label: '訊息', icon: 'img/ab-window.svg' })
  for (const old of ['看畫面', '看終端', '看訊息']) {
    for (const f of ['../ui/lib/term-entry.mjs', '../ui/lib/term-remote.mjs']) {
      const code = fs.readFileSync(new URL(f, import.meta.url), 'utf8').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/.*$/gm, '')
      assert.ok(!code.includes(`'${old}'`), `${f} 的按鈕不再寫「${old}」`)
    }
  }
  const ab = read('ui', 'lib', 'actionbar.mjs')
  assert.match(ab, /const termBtn = computed\(\(\) => termButtonView\(termOn\.value, props\.term\?\.label \|\| ''\)\)/)
  assert.match(ab, /slot\.window\.term \? termBtn\.icon : 'img\/ab-window\.svg'/, '圖示由 termButtonView 來')
  assert.match(ab, /\{\{ slot\.window\.term \? termBtn\.label : slot\.window\.label \}\}/, '文字由 termButtonView 來')
  assert.match(ab, /:aria-label="slot\.window\.term \? termBtn\.label : slot\.window\.label"/)
})

test('文案：不寫技術名詞；讀不到畫面不猜「視窗可能已經關了」', () => {
  assert.equal(TERM_VIEW_LOST, '暫時讀不到這個畫面。')
  for (const s of [TERM_LABEL, TERM_TIP, TERM_BACK_TIP, TERM_REOPEN_NOTE, TERM_WAITING_NOTE, TERM_VIEW_LOST]) {
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
// ---- 卡在第一次問的畫面（#1632）：離線也給終端入口，本人自己在 Claude 的畫面上選 ----
import { STUCK_NOTES, stuckCodeOf, stuckNote, termBaseOk } from '../ui/lib/term-entry.mjs'
import { backgroundRestoreNoticeText } from '../ui/lib/partner-launch-notify.mjs'

test('終端入口前提：離線＋讀畫面標 trust／bypass_warning 才例外放行；沒有標記或別的代號照舊不放', () => {
  const ok = { hasApi: true, canOffer: true }
  assert.equal(termBaseOk({ ...ok, status: 'online', stuck: '' }), true, '在線照舊')
  assert.equal(termBaseOk({ ...ok, status: 'offline', stuck: '' }), false, '離線沒標記：照舊不放')
  assert.equal(termBaseOk({ ...ok, status: 'offline', stuck: 'trust' }), true)
  assert.equal(termBaseOk({ ...ok, status: 'offline', stuck: 'bypass_warning' }), true)
  assert.equal(termBaseOk({ hasApi: false, canOffer: true, status: 'offline', stuck: 'trust' }), false, '沒有終端畫面功能')
  assert.equal(termBaseOk({ hasApi: true, canOffer: false, status: 'offline', stuck: 'trust' }), false, '別台電腦、內建通道等不能操作的')
})

test('卡住代號：只認 trust／bypass_warning，名字要對得上', () => {
  const list = [{ name: '小乙', code: 'trust' }, { name: '小丙', code: 'permission' }, { name: '小丁', code: 'bypass_warning' }]
  assert.equal(stuckCodeOf(list, '小乙'), 'trust')
  assert.equal(stuckCodeOf(list, '小丁'), 'bypass_warning')
  assert.equal(stuckCodeOf(list, '小丙'), '', '權限詢問不算')
  assert.equal(stuckCodeOf(list, '別人'), '')
  assert.equal(stuckCodeOf(list, ''), '')
  assert.equal(stuckCodeOf(null, '小乙'), '')
})

test('入口＋小字：離線卡在 trust 且在共用終端服務裡才出現；不在服務裡沒有終端也沒有這行小字', () => {
  const base = termBaseOk({ hasApi: true, canOffer: true, status: 'offline', stuck: 'trust' })
  assert.equal(termEntry(base, true).term, true)
  assert.equal(stuckNote('trust', termEntry(base, true).term), STUCK_NOTES.trust)
  assert.equal(stuckNote('trust', termEntry(base, false).term), '')
  assert.equal(stuckNote('trust', termEntry(base, null).term), '')
  assert.equal(stuckNote('', true), '')
  assert.equal(termEntry(termBaseOk({ hasApi: true, canOffer: true, status: 'offline', stuck: '' }), true).term, false, '離線沒標記：照舊不出現')
  assert.ok(STUCK_NOTES.trust.includes('打開終端') && STUCK_NOTES.bypass_warning.includes('打開終端'))
  for (const t of Object.values(STUCK_NOTES)) assert.ok(!/Enter/.test(t), 'ASN 不叫人按 Enter 帶過去')
})

test('聊天頁接線：離線入口例外與小字', () => {
  const pane = read('ui', 'lib', 'chatpane.mjs')
  assert.match(pane, /const termBase = computed\(\(\) => termBaseOk\(\{ hasApi: !!props\.termViewApi, canOffer: canOfferConsole\(props\.friend, props\.selfNode\), status: props\.friend\?\.status, stuck: stuckCode\.value \}\)\)/)
  assert.match(pane, /stuckCodeOf\(await props\.termViewApi\.notices\(\), termViewName\.value\)/)
  assert.match(pane, /<p class="term-reopen-note term-stuck-note" v-if="!noBar && !isRoom && stuckNoteText" role="note">\{\{ stuckNoteText \}\}<\/p>/)
  assert.ok(!/termViewApi\??\.(input|send)\([^)]*(\r|\n|Enter)/.test(pane + read('ui', 'lib', 'term-entry.mjs')), '不替本人送任何按鍵')
})

test('跨語言一致：前端的小字與逾時通知、Rust 端的句子用同一組選項字樣', () => {
  const rs = read('src-tauri', 'src', 'launch', 'stuck_notice.rs')
  const grab = k => rs.match(new RegExp(`${k}: &str = "([^"]+)"`))[1]
  const [yes, accept, no] = [grab('TRUST_YES'), grab('BYPASS_YES'), grab('BYPASS_NO')]
  assert.ok(STUCK_NOTES.trust.includes(`「${yes}」`))
  assert.ok(STUCK_NOTES.bypass_warning.includes(`「${accept}」`) && STUCK_NOTES.bypass_warning.includes(`「${no}」`))
  assert.ok(backgroundRestoreNoticeText('小乙').body.includes(`「${yes}」`))
  assert.match(rs, /CODE_TRUST: &str = "trust"/)
  assert.match(rs, /CODE_BYPASS: &str = "bypass_warning"/)
})
// ---- 暫時接不回：定期重問，接回後按鈕自己亮起來 ----
import { TERM_WAIT_POLL_MS, createWaitPoll } from '../ui/lib/term-entry.mjs'

/** 假計時器：tick() 觸發所有還活著的計時器一次 */
function fakeTimers() {
  const live = new Map()
  let n = 0
  return {
    setTimer: fn => { live.set(++n, fn); return n },
    clearTimer: id => { live.delete(id) },
    tick: () => { for (const fn of [...live.values()]) fn() },
    count: () => live.size,
  }
}

/** 照聊天頁的接法：狀態變了就依「是不是 waiting」同步計時器；探測回來的結果寫進狀態 */
function pane(api) {
  const t = fakeTimers()
  const s = { state: null, calls: 0 }
  const poll = createWaitPoll({
    probe: async () => { s.calls++; const r = await askTermService(api, '小乙'); s.state = nextTermState(s.state, r); poll.sync(s.state === 'waiting') },
    setTimer: t.setTimer, clearTimer: t.clearTimer,
  })
  return { t, s, poll, set(v) { s.state = v; poll.sync(v === 'waiting') } }
}
const settle = () => new Promise(r => setImmediate(r))

test('暫時接不回：計時器每輪重問，後端接回（回 ok）後按鈕變可按、之後不再輪詢', async () => {
  const answers = ['waiting', 'waiting', 'ok']
  const p = pane({ state: async () => ({ state: answers.shift() ?? 'ok' }) })
  p.set('waiting')
  assert.equal(termEntry(true, p.s.state).term, false, '一開始灰的')
  assert.equal(termEntry(true, p.s.state).waiting, true)
  p.t.tick(); await settle()
  assert.equal(termEntry(true, p.s.state).term, false, '還在接')
  p.t.tick(); await settle()
  p.t.tick(); await settle()
  assert.equal(p.s.state, 'ok')
  assert.equal(termEntry(true, p.s.state).term, true, '接回後可按')
  assert.equal(p.t.count(), 0, '變 ok 就停')
  const calls = p.s.calls
  p.t.tick(); p.t.tick(); await settle()
  assert.equal(p.s.calls, calls, '停了以後不再呼叫')
})

test('暫時接不回：變成確定不在也停；偶爾一次問不到不停也不誤判', async () => {
  const seq = [new Error('逾時'), { state: 'gone' }]
  const p = pane({ state: async () => { const v = seq.shift(); if (v instanceof Error) throw v; return v }, available: async () => { throw new Error('也問不到') } })
  p.set('waiting')
  p.t.tick(); await settle()
  assert.equal(p.s.state, 'waiting', '問不到不改狀態')
  assert.equal(p.t.count(), 1, '計時器還在')
  p.t.tick(); await settle()
  assert.equal(p.s.state, 'gone')
  assert.equal(p.t.count(), 0)
})

test('暫時接不回期間 api 回 null：狀態仍 waiting、輪詢不停；之後回 ok 變可按（聊天頁用同一個 nextTermState）', async () => {
  const seq = [null, null, { state: 'ok' }]
  const p = pane({ state: async () => seq.shift() ?? null })
  p.set('waiting')
  p.t.tick(); await settle()
  p.t.tick(); await settle()
  assert.equal(p.s.state, 'waiting', '問不到（null）不改狀態')
  assert.equal(termEntry(true, p.s.state).waiting, true)
  assert.equal(p.t.count(), 1, '輪詢不停')
  p.t.tick(); await settle()
  assert.equal(p.s.state, 'ok')
  assert.equal(termEntry(true, p.s.state).term, true, '回 ok 後按鈕可按')
  assert.equal(p.t.count(), 0)
  assert.equal(nextTermState('waiting', null), 'waiting')
  assert.equal(nextTermState('ok', null), null, '不在 waiting 時照回答')
  assert.match(read('ui', 'lib', 'chatpane.mjs'), /termInService\.value = nextTermState\(termInService\.value, r\)/, '聊天頁用同一份')
})

test('暫時接不回：切換夥伴（狀態被清掉）或離開畫面後，舊計時器不再呼叫', async () => {
  const p = pane({ state: async () => ({ state: 'waiting' }) })
  p.set('waiting')
  p.set('waiting')
  assert.equal(p.t.count(), 1, '同時只有一個計時器')
  p.t.tick(); await settle()
  const calls = p.s.calls
  p.set(null) // 切換夥伴：狀態清掉
  assert.equal(p.t.count(), 0)
  p.t.tick(); await settle()
  assert.equal(p.s.calls, calls, '舊的不再呼叫')
  p.set('waiting')
  p.poll.stop() // 離開畫面
  assert.equal(p.t.count(), 0)
  assert.equal(p.poll.running(), false)
  assert.equal(TERM_WAIT_POLL_MS, 10_000)
})

test('暫時接不回的說明經過 briefWhy 不會被截成 20 字', () => {
  assert.ok(TERM_WAITING_NOTE.length <= 20, `長度 ${TERM_WAITING_NOTE.length}`)
  const w = barSlots(friend({ status: 'online' }), { selfNode: 'H', api: true, term: false, termWaiting: true }).find(s => s.key === 'window')
  assert.equal(w.reason, TERM_WAITING_NOTE, '完整保留，沒有「…」')
})

test('聊天頁接線：waiting 時才開重查計時器，離開畫面清掉', () => {
  const src = read('ui', 'lib', 'chatpane.mjs')
  assert.match(src, /createWaitPoll\(\{ probe: \(\) => probeTerm\(\) \}\)/)
  assert.match(src, /waitPoll\.sync\(termInService\.value === 'waiting' && props\.active === true\)/)
  assert.match(src, /onBeforeUnmount\(\(\) => waitPoll\.stop\(\)\)/)
})

test('第 2 格：離線卡在第一次問的畫面時是「終端」不是「喚醒」；沒有 term 的離線夥伴照舊是「喚醒」', () => {
  const off = ctx => barSlots(friend({ status: 'offline' }), { selfNode: 'H', api: true, ...ctx }).find(s => s.key === 'window')
  const t = off({ term: true, termStuck: true })
  assert.equal(t.label, TERM_LABEL)
  assert.equal(t.term, true)
  assert.equal(t.ok, true)
  const w = off({})
  assert.equal(w.label, '喚醒', '沒有卡住的標記：照舊')
  assert.ok(!w.term)
  assert.ok(off({ term: true, termStuck: true, phone: true }).label !== TERM_LABEL, '手機不給這個例外')
})
