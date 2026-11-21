import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { autoResumeNotice, createAutoResumePoller, isMuxCrashResult, launchNoticeLogPath } from '../ui/lib/auto-resume.mjs'

test('接回完成：顯示位數，說明權限相同、收到信才工作、會用額度', () => {
  const n = autoResumeNotice({ state: 'done', resumed: ['甲', '乙'], failed: [] })
  assert.equal(n.title, '已自動接回 2 位夥伴')
  assert.match(n.body, /權限和原本相同/)
  assert.match(n.body, /收到信就會繼續工作/)
  assert.doesNotMatch(n.body, /重新開始工作/, '接回時沒有第一句話，不會自己開始做事')
  assert.match(n.body, /額度/)
})

test('設定頁的說明也寫實際行為：收到信才工作，不寫重新開始工作', () => {
  const panel = fs.readFileSync(new URL('../ui/lib/settings-panel.mjs', import.meta.url), 'utf8')
  assert.match(panel, /接回原本的對話。權限和原本相同，收到信就會繼續工作，也會用到額度。/)
  assert.doesNotMatch(panel, /重新開始工作/)
})

test('接不回來的一定列出名字與原因', () => {
  const n = autoResumeNotice({ state: 'done', resumed: ['甲'], failed: [{ name: '乙', reason: '卡住了' }] })
  assert.match(n.body, /「乙」：卡住了/)
  assert.match(n.body, /12 小時/)
  const all = autoResumeNotice({ state: 'done', resumed: [], failed: [{ name: '乙', reason: '卡住了' }] })
  assert.equal(all.title, '夥伴沒有接回來')
  const many = autoResumeNotice({ state: 'done', resumed: [], failed: Array.from({ length: 12 }, (_, i) => ({ name: `p${i}`, reason: 'x' })) })
  assert.match(many.body, /還有 2 位沒列出/)
})

test('等登入、記憶體不足要講原因；進行中與沒有結果不跳', () => {
  assert.match(autoResumeNotice({ state: 'waiting_login' }).body, /重新登入/)
  assert.match(autoResumeNotice({ state: 'paused_memory' }).body, /3 GB/)
  for (const s of [null, undefined, 'x', {}, { state: 'running' }, { state: '怪' }, { state: 'done', resumed: [], failed: [] }]) assert.equal(autoResumeNotice(s), null)
})

test('同一階段只跳一次，換階段才再跳；查失敗不中斷', async () => {
  const shown = []
  const replies = [{ state: 'waiting_login' }, { state: 'waiting_login' }, { state: 'running' }, new Error('舊版'), { state: 'done', resumed: ['甲'], failed: [] }, { state: 'done', resumed: ['甲'], failed: [] }]
  const p = createAutoResumePoller({ fetch: async () => { const r = replies.shift(); if (r instanceof Error) throw r; return r }, show: x => shown.push(x.title) })
  for (let i = 0; i < 6; i++) await p.tick()
  assert.deepEqual(shown, ['夥伴還沒接回來', '已自動接回 1 位夥伴'])
})

test('接回的名字也列出來（最多 10 位，其餘寫還有幾位）；沒接回的不列接回行', () => {
  const n = autoResumeNotice({ state: 'done', resumed: ['asn西川', '家用正見'], failed: [] })
  assert.match(n.body, /接回的是：「asn西川」、「家用正見」/)
  const many = autoResumeNotice({ state: 'done', resumed: Array.from({ length: 12 }, (_, i) => `p${i}`), failed: [] })
  assert.match(many.body, /「p9」，還有 2 位/)
  assert.doesNotMatch(many.body, /p10/)
  const none = autoResumeNotice({ state: 'done', resumed: [], failed: [{ name: '乙', reason: 'x' }] })
  assert.doesNotMatch(none.body, /接回的是/)
  // 名字不是字串的丟掉，不當成空白行
  const odd = autoResumeNotice({ state: 'done', resumed: ['甲', 7, '', null], failed: [] })
  assert.match(odd.body, /接回的是：「甲」/)
})

test('終端服務中斷：原因寫在最前面；重開機沒有原因欄位時和以前一樣', () => {
  const crash = autoResumeNotice({ state: 'done', cause: '共用的終端服務中斷了', resumed: ['甲'], failed: [{ name: '乙', reason: '沒有記到原本的對話編號，請手動喚醒' }] })
  assert.equal(crash.title, '已自動接回 1 位夥伴')
  assert.ok(crash.body.startsWith('原因：共用的終端服務中斷了。'), crash.body)
  assert.match(crash.body, /「乙」：沒有記到/)
  // 十分鐘內又中斷：沒有接回的，原因也在最前面
  const none = autoResumeNotice({ state: 'done', cause: '共用的終端服務中斷了', resumed: [], failed: [{ name: '甲', reason: '終端服務十分鐘內又中斷了，這次沒有自動接回，請手動喚醒' }] })
  assert.equal(none.title, '夥伴沒有接回來')
  assert.ok(none.body.startsWith('原因：共用的終端服務中斷了。'), none.body)
  // 沒有原因欄位（重開機、舊後端）：不出現「原因」，鍵也不同於有原因的
  const boot = autoResumeNotice({ state: 'done', resumed: ['甲'], failed: [] })
  assert.ok(!boot.body.includes('原因：'))
  assert.notEqual(boot.key, autoResumeNotice({ state: 'done', cause: 'x', resumed: ['甲'], failed: [] }).key)
})

test('#1867 接回的夥伴開在系統終端：講明是哪幾位與怎麼放回；沒有這個欄位（舊後端、都在終端服務裡）和以前一樣', () => {
  const n = autoResumeNotice({ state: 'done', cause: '共用的終端服務中斷了', resumed: ['甲', '乙'], failed: [], native: ['乙'] })
  assert.match(n.body, /其中 1 位開在系統終端，不在共用的終端服務裡：「乙」/)
  assert.match(n.body, /關掉那個視窗再按「喚醒」/)
  const plain = autoResumeNotice({ state: 'done', cause: '共用的終端服務中斷了', resumed: ['甲', '乙'], failed: [] })
  assert.ok(!plain.body.includes('系統終端'), plain.body)
  assert.notEqual(n.key, plain.key, '同樣人數、多了退回原生的，要再跳一次提示')
})

test('#1895 終端服務中斷後的接回：電腦版不跳框，摘要寫進 log；結果交給通知頁', async () => {
  const shown = []
  const logs = []
  const crash = { state: 'done', cause: '共用的終端服務中斷了', resumed: ['甲'], failed: [{ name: '乙', reason: '沒有記到原本的對話編號，請手動喚醒' }] }
  assert.equal(isMuxCrashResult(crash), true)
  const p = createAutoResumePoller({ fetch: async () => crash, show: x => shown.push(x), log: l => logs.push(l) })
  await p.tick()
  await p.tick()
  assert.deepEqual(shown, [], '不能跳框')
  assert.equal(logs.length, 1, '只記一行，不是每輪都記')
  assert.match(logs[0], /改由通知頁呈現/)
  assert.match(logs[0], /已自動接回 1 位夥伴/, '原本的摘要還在')
  assert.match(logs[0], /「乙」/)
})

test('#1895 重開機後的接回：目前沒有通知，框保留，但框上沒有記錄檔路徑（#2027 補通知後再拿掉框）', async () => {
  const shown = []
  const boot = { state: 'done', resumed: ['甲'], failed: [] }
  assert.equal(isMuxCrashResult(boot), false)
  const p = createAutoResumePoller({ fetch: async () => boot, show: x => shown.push(x), log: () => {} })
  await p.tick()
  assert.equal(shown.length, 1)
  assert.equal(shown[0].title, '已自動接回 1 位夥伴')
  assert.equal(launchNoticeLogPath(shown[0], 'C:/x/bridge.log'), '', '路徑不放在框上，也就沒有「開啟記錄資料夾」按鈕')
  // 其他提示（例如開不了終端畫面）照舊帶路徑
  assert.equal(launchNoticeLogPath({ title: 't', body: 'b' }, 'C:/x/bridge.log'), 'C:/x/bridge.log')
})

test('#1895 list.js 用同一個函式決定路徑；框的按鈕跟路徑綁在一起', () => {
  const js = fs.readFileSync(new URL('../ui/list.js', import.meta.url), 'utf8')
  assert.match(js, /logPath: launchNoticeLogPath\(notice, launchLogPaths\.bridgeLog\)/)
  assert.match(js, /createAutoResumePoller\(\{[^}]*log:/)
  const html = fs.readFileSync(new URL('../ui/list.html', import.meta.url), 'utf8')
  assert.match(html, /v-if="launchNotice\.logPath" @click="openLaunchLogFolder"/)
})
