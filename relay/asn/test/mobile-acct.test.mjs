// 手機版替電腦切換 Claude 帳號（#227）：純邏輯與頁面接線的守門。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { ACCT_VENDORS, acctVendorSections, ACCT_TEXT, acctButtonDevices, acctErrorText, acctSheetView, confirmText, runAcctSwitch } from '../ui/lib/mobile-acct.mjs'
import { acctNav, normalizeNav, tabLabel, tabNav } from '../ui/lib/mobile.mjs'

const read = (...p) => fs.readFileSync(new URL(`../${p.join('/')}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const ID = '11111111-1111-1111-1111-111111111111'
const G = (node, items = [{ node, kind: 'pc' }]) => ({ key: `device:${node}`, kind: 'device', node, label: `設備${node}`, items })

test('哪些設備卡有「切換 Claude 帳號」：別台電腦才有；本機、手機、群組與已封存都沒有', () => {
  const groups = [G('S'), G('W'), G('P', [{ node: 'P', kind: 'phone' }]), { key: 'status:online', kind: 'status', items: [] }, { key: 'archived', kind: 'archived', items: [] }]
  assert.deepEqual(acctButtonDevices(groups, 'S').map(g => g.node), ['W'])
  assert.deepEqual(acctButtonDevices([], 'S'), [])
  assert.deepEqual(acctButtonDevices(null, 'S'), [])
})

test('導覽：新增 acct 浮層，瀏覽記錄讀回來能還原', () => {
  assert.deepEqual(acctNav(), { tab: 'chats', sheet: 'acct' })
  assert.deepEqual(normalizeNav({ tab: 'chats', sheet: 'acct' }), acctNav())
})

test('帳號清單的畫面資料：顯示 email 與方案、使用中的不能選、離線時不能送', () => {
  const remote = { loading: false, asnOnline: true, reportedAt: '', msg: '', list: [{ email: 'a@x.test', plan: 'max', current: true }, { email: 'b@x.test', plan: 'pro', current: false }] }
  const v = acctSheetView(remote, 'b@x.test')
  assert.equal(v.currentText, '目前使用：a@x.test')
  assert.deepEqual(v.rows.map(r => [r.email, r.plan, r.current, r.picked]), [['a@x.test', 'max', true, false], ['b@x.test', 'pro', false, true]])
  assert.equal(v.canPick, true)
  assert.equal(v.pickEmail, 'b@x.test')
  assert.equal(acctSheetView(remote, 'a@x.test').pickEmail, '', '使用中的帳號不能當切換目標')
  assert.equal(acctSheetView({ ...remote, asnOnline: false }, 'b@x.test').canPick, false)
  assert.match(acctSheetView({ ...remote, asnOnline: false }, '').onlineText, /沒有在線/)
  assert.equal(acctSheetView({ ...remote, list: [] }, '').empty, ACCT_TEXT.empty)
  assert.match(ACCT_TEXT.quotaNote, /額度/, '要老實說明手機看不到剩餘額度')
})

test('切換前確認：寫清楚哪台電腦、從哪個換到哪個、對方要按同意、開著的 Claude 視窗要重開', () => {
  const c = confirmText('工作機', 'a@x.test', 'b@x.test')
  assert.match(c.lead, /工作機/)
  assert.ok(c.lead.includes('a@x.test') && c.lead.includes('b@x.test'))
  assert.ok(c.points.some(p => p.includes('同意')))
  assert.ok(c.points.some(p => p.includes('重開')))
  assert.equal(confirmText('工作機', '', 'b@x.test').lead.includes('undefined'), false)
})

test('錯誤原因翻成中文：沒有權限、不在線、對方沒這個帳號、太頻繁、後台還沒支援、沒登入', () => {
  assert.match(acctErrorText('acct_switch HTTP 403 forbidden'), /本人.*登入|登入.*本人/)
  assert.match(acctErrorText('acct_list HTTP 403 forbidden'), /權限|本人/)
  assert.match(acctErrorText('acct_switch HTTP 409 asn_offline'), /沒有在線/)
  assert.match(acctErrorText('acct_switch HTTP 409 unknown_account'), /沒有這個帳號/)
  assert.match(acctErrorText('acct_switch HTTP 409 busy'), /處理中/)
  assert.match(acctErrorText('acct_switch HTTP 429 rate_limited'), /太多次/)
  assert.match(acctErrorText('acct_list HTTP 404 not_found'), /找不到/)
  assert.match(acctErrorText('acct_list HTTP 404'), /還沒支援|更新/)
  assert.match(acctErrorText('尚未登入，無法切換電腦的帳號'), /尚未登入/)
  assert.match(acctErrorText(new Error('連線失敗')), /連線失敗/)
  assert.match(acctErrorText(undefined), /失敗/)
  for (const e of ['acct_switch HTTP 403 forbidden', 'acct_switch HTTP 409 busy']) assert.doesNotMatch(acctErrorText(e), /[A-Za-z]{4,}/, `給人看的文字不夾英文：${e}`)
})

test('送出並等結果：成功、對方拒絕、失敗原因、逾時都有一句話；每次只帶設備與 email', async () => {
  const mk = statuses => {
    const calls = []
    let i = 0
    return {
      calls,
      t: {
        acctSwitch: async (node, email) => { calls.push(['switch', node, email]); return { id: ID } },
        acctStatus: async ids => { calls.push(['status', ids]); return { switches: [{ id: ID, ...statuses[Math.min(i++, statuses.length - 1)] }] } },
      },
    }
  }
  const seen = []
  const a = mk([{ status: 'pending' }, { status: 'taken' }, { status: 'ok' }])
  const ok = await runAcctSwitch(a.t, 'W', 'b@x.test', { sleep: async () => {}, onUpdate: v => seen.push(v.phase) })
  assert.deepEqual(a.calls[0], ['switch', 'W', 'b@x.test'])
  assert.equal(ok.phase, 'done')
  assert.match(ok.text, /b@x\.test/)
  assert.match(ok.text, /重開/)
  assert.deepEqual(seen.slice(0, 2), ['sending', 'waiting'])
  const d = await runAcctSwitch(mk([{ status: 'denied' }]).t, 'W', 'b@x.test', { sleep: async () => {} })
  assert.equal(d.phase, 'failed'); assert.match(d.text, /沒有同意/)
  const f = await runAcctSwitch(mk([{ status: 'failed', detail: '目前登入的帳號還沒加入帳號庫' }]).t, 'W', 'b@x.test', { sleep: async () => {} })
  assert.equal(f.phase, 'failed'); assert.match(f.text, /還沒加入帳號庫/)
  const slow = await runAcctSwitch(mk([{ status: 'taken' }]).t, 'W', 'b@x.test', { sleep: async () => {}, pollMax: 3 })
  assert.equal(slow.phase, 'failed'); assert.match(slow.text, /等太久/)
  const bad = await runAcctSwitch({ acctSwitch: async () => { throw 'acct_switch HTTP 403 forbidden' }, acctStatus: async () => ({}) }, 'W', 'b@x.test', { sleep: async () => {} })
  assert.equal(bad.phase, 'failed'); assert.match(bad.text, /本人|權限/)
})

test('頁面接線：m.js 走 android_acct_* 指令且不碰電腦端指令；m.html 有按鈕與浮層、先確認再送', () => {
  const js = read('ui', 'm.js'), html = read('ui', 'm.html')
  for (const c of ['android_acct_list', 'android_acct_switch', 'android_acct_status']) assert.match(js, new RegExp(c))
  assert.doesNotMatch(js, /acct_remote_/, '手機不叫電腦端的 acct_remote_* 指令')
  assert.match(html, /nav\.sheet === 'acct'/)
  assert.match(html, /切換 Claude 帳號/)
  assert.match(html, /@click="[^"]*openAcct\(/)
  assert.match(html, /acctSw\.phase === 'confirm'/)
  const lib = read('src-tauri', 'src', 'lib.rs')
  const m = /#\[cfg\(not\(desktop\)\)\]\n\s*let builder = builder\.invoke_handler\(tauri::generate_handler!\[([\s\S]*?)\]\);/.exec(lib)
  for (const c of ['android_acct_list', 'android_acct_switch', 'android_acct_status']) assert.ok(m[1].includes(`android::${c}`), `手機指令清單要有 ${c}`)
})

test('入口改成低調的「選項」小按鈕，按下切到第二個分頁（對話）整頁顯示，不是浮層', () => {
  const html = read('ui', 'm.html'), css = read('ui', 'mobile.css'), js = read('ui', 'm.js')
  assert.equal(ACCT_TEXT.button, '選項')
  assert.doesNotMatch(ACCT_TEXT.button, /Claude|切換/)
  // 導覽：選項頁屬於第二個分頁；分頁列上第二個標籤暫時叫「選項」，離開（任何不是 acct 的狀態）就恢復「對話」
  assert.equal(acctNav().tab, 'chats')
  assert.equal(tabLabel('chats', acctNav()), '選項')
  assert.equal(tabLabel('chats', tabNav('chats')), '對話')
  assert.equal(tabLabel('list', acctNav()), '夥伴')
  assert.equal(tabLabel('me', acctNav()), '設置')
  assert.match(html, /\{\{ tabLabel\(t\) \}\}/, '分頁列標籤走 tabLabel')
  // 畫面：選項頁在對話分頁那一格裡，有返回鍵；原本的對話內容只用 hidden 藏起來（不卸載，草稿才不會丟）
  const pane = /<section class="m-pg m-chat"[\s\S]*?<!-- 設置 -->/.exec(html)
  assert.ok(pane, '找得到對話分頁')
  assert.match(pane[0], /v-if="nav\.sheet === 'acct'"/)
  assert.match(pane[0], /class="m-keep" :hidden="nav\.sheet === 'acct'"/)
  assert.match(pane[0], /acctSw\.phase === 'confirm'/)
  assert.match(pane[0], /aria-label="返回"[^>]*@click="back"/)
  assert.doesNotMatch(html, /<div class="m-ops"[^>]*nav\.sheet === 'acct'/)
  assert.doesNotMatch(html, /<section class="m-sheet"[^>]*nav\.sheet === 'acct'/)
  // 分頁切換：選項頁時點「夥伴」＝返回上一頁；對話被蓋住時不標已讀
  assert.match(js, /nav\.sheet === 'acct'\) \{[\s\S]*?t === 'list'\) history\.back\(\)/)
  assert.match(js, /if \(nav\.sheet === 'acct'\) return/)
  // 按鈕外觀：小字淡色、無外框，但可點區域至少 32px 高
  const rule = /\.m-ghead-act\{([^}]*)\}/.exec(css)[1]
  assert.match(rule, /min-height:\s*(3[2-9]|4\d)px/)
  assert.match(rule, /border:\s*0/)
  assert.match(rule, /font-size:\s*(1[0-2])px/)
  assert.doesNotMatch(rule, /border-radius:\s*18px/)
})

test('選項頁依廠商分區：現在只有 Claude 一區，資料驅動、沒有假區塊', () => {
  assert.deepEqual(acctVendorSections().map(v => v.key), ['claude'])
  assert.deepEqual(ACCT_VENDORS.map(v => v.key), ['claude'])
  // 之後加一家（資料裡多一筆）就多一區；缺名稱或鍵的不列
  assert.deepEqual(acctVendorSections([...ACCT_VENDORS, { key: 'grok', name: 'Grok' }, { key: '', name: '壞' }]).map(v => v.key), ['claude', 'grok'])
  const html = read('ui', 'm.html')
  assert.match(html, /v-for="v in acctSections"/)
  assert.match(html, /vendorIconSvg\(v\.key\)/)
  assert.match(html, /\{\{ v\.name \}\}/)
  assert.doesNotMatch(html, /Gemini|Grok/, '頁面不放寫死的別家區塊')
  assert.match(html, /ACCT_TEXT\.title\(acctSw\.label\)/, '標題寫設備名')
})
