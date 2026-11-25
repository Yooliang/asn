// 新手引導卡（#1605）：什麼時候出現、四家各給什麼動作、文字不含技術名詞
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { GUIDE_HIDDEN_KEY, GUIDE_TEXT, GUIDE_VENDORS, guideApplies, guideReshowVisible, guideRows, guideVisible, loadGuideHidden, localVendorStates, saveGuideHidden, singleFlight } from '../ui/lib/new-computer-guide.mjs'
import { STATE } from '../ui/lib/device-state.mjs'
import { AGENT_INSTALL_UI } from '../ui/lib/flags.mjs'
import { REASON } from '../ui/lib/mobile-launch.mjs'
import { INSTALL_TEXT } from '../ui/lib/agent-install.mjs'

const ctx = (o = {}) => ({ conn: 'on', rosterLoaded: true, query: '', localWindows: 0, hidden: false, ...o })
const mem = () => { const m = new Map(); return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) } }
const all = (installed, accounts = {}) => localVendorStates({ detected: true, accountsReady: true, installed: { claude: false, codex: false, gemini: false, grok: false, ...installed }, accounts })
const view = rows => rows.map(r => `${r.key}:${r.checking ? 'checking' : r.action ?? '-'}`).join(' ')

test('guideVisible：這台沒有視窗才出現；有視窗、按過先不用、搜尋中、沒連線、名單沒到都不出現', () => {
  assert.equal(guideVisible(ctx()), true)
  assert.equal(guideVisible(ctx({ localWindows: 1 })), false)
  assert.equal(guideVisible(ctx({ hidden: true })), false)
  assert.equal(guideVisible(ctx({ query: '小' })), false)
  assert.equal(guideVisible(ctx({ query: '   ' })), true, '只有空白不算在搜尋')
  assert.equal(guideVisible(ctx({ conn: 'connecting' })), false)
  assert.equal(guideVisible(ctx({ conn: 'off' })), false)
  assert.equal(guideVisible(ctx({ rosterLoaded: false })), false)
})

test('「顯示新手引導」只在卡片本來會出現、卻被收起時出現', () => {
  assert.equal(guideReshowVisible(ctx({ hidden: true })), true)
  assert.equal(guideReshowVisible(ctx({ hidden: false })), false)
  assert.equal(guideReshowVisible(ctx({ hidden: true, localWindows: 2 })), false, '已經有視窗就不再提示')
  assert.equal(guideReshowVisible(ctx({ hidden: true, query: 'x' })), false)
  assert.equal(guideApplies(ctx({ hidden: true })), true)
})

test('先不用記在本機：存、讀、清掉；儲存壞掉不丟錯', () => {
  const s = mem()
  assert.equal(GUIDE_HIDDEN_KEY, 'asnNewComputerGuideHidden')
  assert.equal(loadGuideHidden(s), false)
  saveGuideHidden(true, s)
  assert.equal(loadGuideHidden(s), true)
  saveGuideHidden(false, s)
  assert.equal(loadGuideHidden(s), false)
  assert.equal(s.getItem(GUIDE_HIDDEN_KEY), null)
  const broken = { getItem() { throw new Error('x') }, setItem() { throw new Error('x') }, removeItem() { throw new Error('x') } }
  assert.equal(loadGuideHidden(broken), false)
  assert.doesNotThrow(() => saveGuideHidden(true, broken))
})

test('空白電腦：四家都沒裝 → 沒有按鈕，每家一句說明加官網連結；Claude 那句固定', () => {
  const rows = guideRows({ states: all({}) })
  assert.deepEqual(rows.map(r => r.key), ['claude', 'codex', 'gemini', 'grok'])
  assert.ok(rows.every(r => r.action === null && !r.checking))
  assert.equal(rows[0].note, '找不到 Claude Code。剛裝好的話，按下面的「重新檢查」。')
  // 手機看別台：叫人到那台電腦上按（手機沒辦法叫那台重新偵測）；不再叫人重開 ASN
  const remoteRows = guideRows({ states: all({}), isSelf: false })
  assert.equal(remoteRows[0].note, '找不到 Claude Code。剛裝好的話，請在那台電腦上按「重新檢查」。')
  for (const r of [...rows, ...remoteRows]) assert.ok(!/重開|結束/.test(r.note ?? ''), r.note)
  assert.equal(rows[1].note, '還沒裝 Codex，裝好後這裡會出現「開一個視窗」。')
  assert.equal(rows[2].note, '還沒裝 Gemini，裝好後這裡會出現「開一個視窗」。')
  assert.equal(rows[3].note, '還沒裝 Grok，裝好後這裡會出現「開一個視窗」。')
  for (const r of rows) {
    assert.equal(`${r.site.before}${r.site.name}${r.site.after}`, `到 ${r.label} 官網 下載安裝`)
    assert.match(r.site.url, /^https:\/\//)
  }
  // 官網網址不當文字寫在說明裡
  assert.ok(rows.every(r => !/https?:/.test(r.note)))
})

test('部分裝好：Claude 已登入、Codex 已裝沒登入、Gemini 已裝、Grok 沒裝', () => {
  const st = all({ claude: true, codex: true, gemini: true }, { claude: [{ email: 'a@b.c', current: true }] })
  assert.deepEqual(st, { claude: STATE.LOGGED_IN, codex: STATE.INSTALLED_LOGGED_OUT, gemini: STATE.INSTALLED_LOGGED_OUT, grok: STATE.NOT_INSTALLED })
  assert.equal(view(guideRows({ states: st })), 'claude:open codex:login gemini:open grok:-')
})

test('登入失效算要登入；已有帳號卻沒裝（程式被移走）算沒裝', () => {
  const st = all({ claude: true }, { claude: [{ email: 'a@b.c', current: true, login_failed: true }], codex: [{ email: 'x', current: true }] })
  assert.equal(st.claude, STATE.LOGIN_FAILED)
  assert.equal(st.codex, STATE.NOT_INSTALLED, '帳號在、程式不在：開不了視窗')
  assert.equal(view(guideRows({ states: st })).split(' ')[0], 'claude:login')
})

test('全部可用：四個都是開一個視窗；Gemini 偵測不到登入，裝了就直接開', () => {
  const st = all({ claude: true, codex: true, gemini: true, grok: true }, { claude: [{ email: 'a', current: true }], codex: [{ email: 'b', current: true }], grok: [{ email: 'c', current: true }] })
  assert.equal(view(guideRows({ states: st })), 'claude:open codex:open gemini:open grok:open')
  // 只裝 Gemini、沒有任何帳號：照樣開，不會說沒登入
  assert.equal(guideRows({ states: all({ gemini: true }) })[2].action, 'open')
})

test('偵測還沒回來：四列都是正在檢查、沒有按鈕', () => {
  const rows = guideRows({ states: localVendorStates({ detected: false, accountsReady: true }) })
  assert.ok(rows.every(r => r.checking && r.action === null && !r.note && !r.site))
  const rows2 = guideRows({ states: localVendorStates({ detected: true, accountsReady: false, installed: { claude: true } }) })
  assert.ok(rows2.every(r => r.checking), '帳號還沒讀好也不能先說沒登入')
  assert.equal(GUIDE_TEXT.checking, '正在檢查…')
})

test('安裝入口（AGENT_INSTALL_UI）開了、而且裝得動：沒裝的 Claude 給「安裝並登入」；關著或裝不動就是說明', () => {
  const st = all({})
  assert.equal(AGENT_INSTALL_UI, false, '旗標（ui/lib/flags.mjs）預設關')
  assert.equal(view(guideRows({ states: st })), 'claude:- codex:- gemini:- grok:-', '入口預設關')
  const on = guideRows({ states: st, installUi: true, installAvail: { grok: true } })
  assert.equal(on[0].action, 'install', 'Claude 本機裝得動（installAction local）')
  assert.equal(on[1].action, null, 'Codex 目前裝不動')
  assert.equal(on[3].action, 'install', '偵測回報 Grok 裝得動')
  assert.equal(on[0].note, undefined)
  assert.equal(GUIDE_TEXT.install, '安裝並登入')
})

test('手機看別台電腦：只有設備卡說可以的動作才給按鈕，其他寫說明', () => {
  const st = { claude: STATE.LOGGED_IN, codex: STATE.INSTALLED_LOGGED_OUT, gemini: STATE.INSTALLED_LOGGED_OUT, grok: STATE.NOT_INSTALLED }
  assert.equal(view(guideRows({ states: st, isSelf: false, remote: { login: { codex: true } } })), 'claude:open codex:login gemini:open grok:-')
  const noLogin = guideRows({ states: st, isSelf: false })
  assert.equal(noLogin[1].action, null)
  assert.equal(noLogin[1].note, GUIDE_TEXT.loginHere)
  // 安裝入口關著，就算設備卡有遠端安裝也不給
  assert.equal(guideRows({ states: { ...st, claude: STATE.NOT_INSTALLED }, isSelf: false, remote: { install: { claude: true } } })[0].action, null)
  assert.equal(guideRows({ states: { ...st, claude: STATE.NOT_INSTALLED }, isSelf: false, installUi: true, remote: { install: { claude: true } } })[0].action, 'install')
  // 還沒收到回報：正在檢查
  assert.ok(guideRows({ states: { claude: STATE.NO_REPORT }, isSelf: false }).every(r => r.checking))
})

test('手機的說明用設定裡真正的字', () => {
  assert.equal(GUIDE_TEXT.installSwitch, `到那台電腦的 設定 → 設備，勾選「${INSTALL_TEXT.allowRemote}」`)
  assert.ok(REASON.closed.includes('「允許我的其他設備替這台開新視窗」'), '不能開視窗時既有的原因就說要勾這一項')
  const settings = readFileSync(new URL('../ui/lib/settings-panel.mjs', import.meta.url), 'utf8')
  assert.ok(settings.includes('<span>允許我的其他設備替這台開新視窗</span>'))
})

test('官網：四家各一個 https 網址，順序固定', () => {
  assert.deepEqual(GUIDE_VENDORS.map(v => v.key), ['claude', 'codex', 'gemini', 'grok'])
  assert.deepEqual(GUIDE_VENDORS.map(v => v.url), ['https://claude.com/product/claude-code', 'https://developers.openai.com/codex', 'https://antigravity.google', 'https://docs.x.ai/build/overview'])
})

test('singleFlight：進行中再呼叫回同一個 promise、不重跑；跑完才能再開下一份；失敗也會放行', async () => {
  let n = 0, release
  const gate = () => new Promise(r => { release = r })
  const f = singleFlight(async () => { n++; await gate(); return n })
  const p1 = f(), p2 = f()
  assert.equal(p1, p2)
  await new Promise(r => setTimeout(r, 0))
  assert.equal(n, 1)
  release(); assert.equal(await p1, 1)
  const p3 = f()
  assert.notEqual(p3, p1)
  await new Promise(r => setTimeout(r, 0))
  release(); assert.equal(await p3, 2)
  const bad = singleFlight(async () => { throw new Error('x') })
  await assert.rejects(bad())
  await assert.rejects(bad(), /x/, '失敗後可以再試')
})

test('Edge 擋下載的小提醒：只在有官網連結的列，樣板放在官網那行下面，文字逐字相等', () => {
  assert.equal(GUIDE_TEXT.edgeKeep, 'Edge 擋下載的話，按「…」→「保留」→「仍要保留」')
  // 沒裝（有官網）的列都有 site；已裝／檢查中的列沒有 site，所以不會顯示
  assert.ok(guideRows({ states: all({}) }).every(r => r.site))
  assert.ok(guideRows({ states: all({}), isSelf: false }).every(r => r.site))
  const partial = guideRows({ states: all({ claude: true, gemini: true }, { claude: [{ email: 'a@b.c', current: true }] }) })
  assert.deepEqual(partial.map(r => !!r.site), [false, true, false, true])
  assert.ok(guideRows({ states: {} }).every(r => !r.site))
  const view = readFileSync(new URL('../ui/lib/new-computer-guide-view.mjs', import.meta.url), 'utf8')
  const lines = view.split(/\r?\n/)
  const siteAt = lines.findIndex(l => l.includes('v-if="r.site"') && l.includes('ng-link'))
  assert.ok(siteAt >= 0)
  assert.match(lines[siteAt + 1], /v-if="r\.site"/)
  assert.match(lines[siteAt + 1], /\{\{ T\.edgeKeep \}\}/)
})

test('引導卡的字沒有技術名詞', () => {
  const texts = [
    ...Object.values(GUIDE_TEXT),
    ...GUIDE_VENDORS.flatMap(v => [v.label, v.siteName, v.missing ?? '', v.missingRemote ?? '']),
    ...guideRows({ states: all({}) }).flatMap(r => [r.note, r.site?.before, r.site?.name, r.site?.after]),
  ].filter(Boolean)
  for (const t of texts) assert.ok(!/CLI|PATH|token|指令|終端機|curl|npm/i.test(t), `技術名詞：${t}`)
  // 畫面元件的樣板也不放
  const view = readFileSync(new URL('../ui/lib/new-computer-guide-view.mjs', import.meta.url), 'utf8')
  const tpl = view.slice(view.indexOf('template:'))
  assert.ok(!/CLI|PATH|token|指令|終端機/.test(tpl))
})
