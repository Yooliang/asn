// 手機版「雲端代理」（#756、todo-next-199）：邀請、金鑰只顯示一次、清剪貼簿、清單與撤銷、核准主機、接線
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { CLIP_CLEAR_MS, CLOUD_KEY_KEEP_MS, CLOUD_LEAVE_TEXT, CLOUD_TEXT, createMobileCloud } from '../ui/lib/mobile-cloud.mjs'
import { fourthExpired, fourthMsLeft, FOURTH_KEEP_MS } from '../ui/lib/mobile-fourth.mjs'
import { phoneGuideList } from '../ui/lib/mobile-guides.mjs'

const read = f => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const KEY = 'SECRETKEY_once_only'

function make({ signedIn = true, nodes = [], createErr = null } = {}) {
  const calls = [], written = []
  let now = 1_000_000
  const timers = []
  const api = {
    list: async () => { calls.push(['list']); return { nodes } },
    create: async name => { calls.push(['create', name]); if (createErr) throw new Error(createErr); return { id: 't5-new', name, key: KEY, invite: `請閱讀並照著做：https://x.test/skill.md\n你的節點代號：t5-new\n名字：${name}` } },
    revoke: async id => { calls.push(['revoke', id]) },
    rename: async (id, name) => { calls.push(['rename', id, name]); return name },
    approve: async (code, name, nodeId) => { calls.push(['approve', code, name, nodeId]); return { id: 't5-host', name } },
  }
  const clip = { write: async t => { written.push(t) } }   // 刻意沒有 read：不讀剪貼簿
  const timer = { set: (fn, ms) => { timers.push({ fn, ms }); return timers.length - 1 }, clear: id => { if (timers[id]) timers[id].cleared = true } }
  const ui = createMobileCloud({ api, status: async () => ({ signed_in: signedIn }), clip, now: () => now, timer })
  return { ui, s: ui.state, calls, written, timers, tick: ms => { now += ms }, setNodes: n => { nodes = n } }
}

test('沒登入：不能用，也不去問後台的清單', async () => {
  const { ui, s, calls } = make({ signedIn: false })
  await ui.load()
  assert.equal(s.signedIn, false)
  assert.deepEqual(calls, [])
  assert.deepEqual(s.rows, [])
})

test('邀請：名字不合格不送；建立後金鑰只在記憶體、清單重讀、說明沒有金鑰', async () => {
  const { ui, s, calls } = make({ nodes: [{ id: 't5-new', name: '小真', last_seen_at: null, online: false }] })
  await ui.load()
  ui.openForm()
  s.name = '   '
  await ui.create()
  assert.equal(s.msg, CLOUD_TEXT.nameBad)
  assert.ok(!calls.some(c => c[0] === 'create'))
  s.name = '  小真 '
  await ui.create()
  assert.deepEqual(calls.filter(c => c[0] === 'create'), [['create', '小真']])
  assert.equal(s.stage, 'created')
  assert.equal(s.created.key, KEY)
  assert.ok(!s.created.invite.includes(KEY), '給代理的說明不含金鑰')
  assert.equal(s.rows.length, 1)
  assert.equal(ui.justJoined(), false, '還沒上線：等代理')
})

test('建立失敗：回到表單、說明原因、沒有金鑰', async () => {
  const { ui, s } = make({ createErr: '雲端代理（或電腦）的數量已達上限，請先撤銷用不到的' })
  await ui.load(); ui.openForm(); s.name = '小真'
  await ui.create()
  assert.equal(s.stage, 'form')
  assert.match(s.msg, /上限/)
  assert.equal(s.created, null)
})

test('建立途中離開這一頁：回來的金鑰不保留，提示撤銷後重來', async () => {
  const m = make()
  await m.ui.load(); m.ui.openForm(); m.s.name = '小真'
  // 先送出，在 create 回來前就離開
  const p = m.ui.create()
  await m.ui.leave()   // 還沒等到 create 回來就離開
  await p
  assert.equal(m.s.created, null, '金鑰不保留')
  assert.notEqual(m.s.stage, 'created')
  assert.equal(m.s.msg, CLOUD_TEXT.lostKey)
  assert.ok(!JSON.stringify(m.s).includes(KEY))
})

test('第一次讀取就失敗：畫面看得到原因，不是一直「讀取中」', async () => {
  const ui = createMobileCloud({ api: { list: async () => [] }, status: async () => { throw new Error('連不上後台') }, clip: { write: async () => {} } })
  await ui.load()
  assert.equal(ui.state.signedIn, null)
  assert.match(ui.state.msg, /連不上後台/)
  assert.match(read('ui/m.html'), /cloudSt\.signedIn === null">\{\{ cloudSt\.msg \|\| CLOUD_TEXT\.loading \}\}/)
})

test('清剪貼簿失敗不能沒聲音：畫面提醒用別的內容蓋掉，狀態留著，回到前景再試', async () => {
  let fail = true
  const written = []
  let now = 1_000_000
  const ui = createMobileCloud({
    api: { list: async () => ({ nodes: [] }), create: async name => ({ id: 't5-new', name, key: KEY, invite: 'x' }) },
    status: async () => ({ signed_in: true }),
    clip: { write: async t => { if (t === '' && fail) throw new Error('denied'); written.push(t) } },
    now: () => now, timer: { set: () => 1, clear: () => {} },
  })
  await ui.load(); ui.openForm(); ui.state.name = '小真'; await ui.create(); await ui.copyKey()
  now += CLIP_CLEAR_MS + 1
  await ui.clearClipboard()
  assert.equal(ui.state.clipNote, CLOUD_TEXT.clipFail, '清不掉要講')
  assert.match(CLOUD_TEXT.clipFail, /金鑰可能還在裡面/)
  assert.match(CLOUD_TEXT.clipNote, /嘗試/, '說明不保證')
  fail = false
  await ui.onVisible()   // 回到前景再試
  assert.deepEqual(written.filter(t => t === ''), [''], '回到前景又試了一次而且清掉了')
  assert.equal(ui.state.clipNote, CLOUD_TEXT.clipCleared)
})

test('輪詢讀取失敗的提示：下一輪讀成功就消掉，不一直掛著', async () => {
  let bad = true
  const ui = createMobileCloud({ api: { list: async () => { if (bad) throw new Error('暫時連不上'); return { nodes: [] } } }, status: async () => ({ signed_in: true }), clip: { write: async () => {} } })
  await ui.load()
  assert.match(ui.state.msg, /暫時連不上/)
  bad = false
  await ui.load()
  assert.equal(ui.state.msg, '')
})

test('金鑰還在畫面上時離開（含系統返回鍵）：先問一次；問的是金鑰那句，選離開才丟', () => {
  assert.match(CLOUD_LEAVE_TEXT.lead, /不能重發/)
  const js = read('ui/m.js'), html = read('ui/m.html')
  assert.match(js, /needs: next => !!cloudSt\.created \|\|/, '離開詢問對金鑰也成立')
  assert.match(js, /keyBackGuard = \(\) => \{[\s\S]*?!cloudSt\.created[\s\S]*?leave\.ask\(null, \(\) => \{ cloud\.confirmLeave\(\); void cloud\.leave\(\); history\.back\(\) \}\)/, '返回鍵先取消、問、選離開才丟金鑰再返回')
  assert.ok(js.includes("window.addEventListener('popstate', e => {\n  if (keyBackGuard()) return"), '返回鍵一進來就先問')
  assert.match(html, /leaveText\.lead/)
})

function makeFailing() {
  let fail = true
  const ui = createMobileCloud({
    api: { list: async () => ({ nodes: [] }), create: async name => ({ id: 't5-new', name, key: KEY, invite: 'x' }) },
    status: async () => ({ signed_in: true }),
    clip: { write: async t => { if (t === '' && fail) throw new Error('denied') } },
    timer: { set: () => 1, clear: () => {} },
  })
  return { ui, s: ui.state, fixIt: () => { fail = false } }
}
async function withKey(m) { await m.ui.load(); m.ui.openForm(); m.s.name = '小真'; await m.ui.create(); await m.ui.copyKey() }

test('按「完成」時清不掉剪貼簿：回到清單也看得到提示', async () => {
  const m = makeFailing(); await withKey(m)
  await m.ui.done()
  assert.equal(m.s.stage, 'list')
  assert.equal(m.s.msg, CLOUD_TEXT.clipFail)
})

test('離開這一頁時清不掉剪貼簿：提示留在清除之後（不被離開時的清空蓋掉）', async () => {
  const m = makeFailing(); await withKey(m)
  m.ui.confirmLeave()
  await m.ui.leave()
  assert.equal(m.s.created, null)
  assert.equal(m.s.msg, CLOUD_TEXT.clipFail)
  const k = makeFailing(); await withKey(k)
  await k.ui.leave()   // 沒經過確認又清不掉：兩句都講
  assert.equal(k.s.msg, CLOUD_TEXT.keyDropped + CLOUD_TEXT.clipFail)
})

test('金鑰還在畫面、頁面保留時間到了才丟：明講丟了；沒有金鑰就不講', async () => {
  const m = makeFailing(); m.fixIt(); await withKey(m)
  m.ui.markExpired()
  await m.ui.leave()
  assert.equal(m.s.created, null)
  assert.equal(m.s.msg, CLOUD_TEXT.keyExpired)
  assert.match(CLOUD_TEXT.keyExpired, /撤銷後重新邀請/)
  const n = makeFailing(); n.fixIt(); await n.ui.load()
  n.ui.markExpired()   // 沒有金鑰：標記不成立
  await n.ui.leave()
  assert.equal(n.s.msg, '')
})

test('沒經過確認就丟掉金鑰（任何沒先問的離開路徑）：一律明講；本人按了離開就不再提示', async () => {
  const m = makeFailing(); m.fixIt(); await withKey(m)
  await m.ui.leave()   // 例如其他路徑直接切走
  assert.equal(m.s.msg, CLOUD_TEXT.keyDropped)
  const n = makeFailing(); n.fixIt(); await withKey(n)
  n.ui.confirmLeave()   // 本人在「要離開嗎」按了離開
  await n.ui.leave()
  assert.equal(n.s.msg, '')
  assert.match(read('ui/m.js'), /askBeforeLeave = \(next, run\) => \{ leave\.ask\(next, \(\) => \{ cloud\.confirmLeave\(\); run\(\) \}\) \}/)
  assert.match(read('ui/m.js'), /const openLaunch = node => askBeforeLeave\(launchPage\(\)/, '開新夥伴也先問')
})

test('頁面保留時間：預設 3 分鐘；金鑰還在畫面上給 30 分鐘，超過才過期', () => {
  const fourth = { leftAt: 1_000 }
  assert.equal(fourthExpired(fourth, 1_000 + FOURTH_KEEP_MS), true)
  assert.equal(fourthExpired(fourth, 1_000 + FOURTH_KEEP_MS, CLOUD_KEY_KEEP_MS), false, '金鑰還在：3 分鐘不過期')
  assert.equal(fourthExpired(fourth, 1_000 + CLOUD_KEY_KEEP_MS - 1, CLOUD_KEY_KEEP_MS), false)
  assert.equal(fourthExpired(fourth, 1_000 + CLOUD_KEY_KEEP_MS, CLOUD_KEY_KEEP_MS), true)
  assert.equal(fourthMsLeft(fourth, 1_000 + 60_000, CLOUD_KEY_KEEP_MS), CLOUD_KEY_KEEP_MS - 60_000)
  assert.equal(CLOUD_KEY_KEEP_MS, 30 * 60_000)
})

test('內頁「關閉」與頁面過期都走金鑰的判斷（接線）', () => {
  const js = read('ui/m.js')
  assert.match(js, /const closePage = \(\) => askBeforeLeave\(null, \(\) => fourthNav\.closePage\(\)\)/, '關閉先問')
  assert.match(js, /checkFourth = \(\) => \{ if \(cloudSt\.created && fourthExpired\(.*?CLOUD_KEY_KEEP_MS\)\) cloud\.markExpired\(\); return fourthNav\.check\(fourthKeepMs\(\)\) \}/)
  assert.match(js, /cloud\.leave\(\)\.then\(\(\) => \{ if \(cloudSt\.msg\) showToast\(cloudSt\.msg\) \}\)/, '頁面關了就用一句話提示')
})

test('代理連上來就顯示已加入', async () => {
  const m = make()
  await m.ui.load(); m.ui.openForm(); m.s.name = '小真'
  await m.ui.create()
  m.setNodes([{ id: 't5-new', name: '小真', last_seen_at: new Date().toISOString(), online: true }])
  await m.ui.load()
  assert.equal(m.ui.justJoined(), true)
})

test('複製金鑰：60 秒後清剪貼簿，而且不讀剪貼簿（讀會跳權限詢問）；只複製說明不用清', async () => {
  const { ui, s, written, timers } = make()
  await ui.load(); ui.openForm(); s.name = 'a'; await ui.create()
  await ui.copyInvite()
  assert.equal(timers.length, 0, '複製說明不排清除')
  await ui.copyKey()
  assert.deepEqual(written.at(-1), KEY)
  assert.equal(timers.at(-1).ms, CLIP_CLEAR_MS)
  assert.equal(CLIP_CLEAR_MS, 60_000)
  await timers.at(-1).fn()
  assert.equal(written.at(-1), '', '60 秒到了清成空白')
  assert.equal(s.clipNote, CLOUD_TEXT.clipCleared)
})

test('按「完成」或離開這一頁：金鑰丟掉、剪貼簿清掉；沒複製過金鑰就不碰剪貼簿', async () => {
  const a = make()
  await a.ui.load(); a.ui.openForm(); a.s.name = 'a'; await a.ui.create()
  await a.ui.copyKey()
  await a.ui.done()
  assert.equal(a.s.created, null)
  assert.equal(a.written.at(-1), '')
  const b = make()
  await b.ui.load(); b.ui.openForm(); b.s.name = 'a'; await b.ui.create()
  await b.ui.copyKey()
  await b.ui.leave()
  assert.equal(b.s.created, null)
  assert.equal(b.s.stage, 'list')
  assert.equal(b.written.at(-1), '')
  const c = make()
  await c.ui.load(); await c.ui.leave()
  assert.deepEqual(c.written, [], '沒複製過就不碰剪貼簿')
})

test('回到前景：複製金鑰後已經過了 60 秒（計時器在背景沒跑）才清；沒到不清', async () => {
  const m = make()
  await m.ui.load(); m.ui.openForm(); m.s.name = 'a'; await m.ui.create()
  await m.ui.copyKey()
  m.tick(30_000); m.ui.onVisible(); await Promise.resolve()
  assert.equal(m.written.at(-1), KEY, '才過 30 秒不清')
  m.tick(31_000); m.ui.onVisible(); await new Promise(r => setTimeout(r, 0))
  assert.equal(m.written.at(-1), '', '過了 60 秒清')
})

test('改名：名字不合格不送；成功後收起輸入、提示、清單重讀', async () => {
  const m = make({ nodes: [{ id: 't5-a', name: '小真', last_seen_at: null, online: false }] })
  await m.ui.load()
  m.ui.openRename('t5-a')
  assert.equal(m.s.renameName, '小真')
  m.s.renameName = '   '
  await m.ui.rename()
  assert.ok(!m.calls.some(c => c[0] === 'rename'))
  assert.equal(m.s.msg, CLOUD_TEXT.renameNeed)
  m.s.renameName = ' 小美 '
  await m.ui.rename()
  assert.deepEqual(m.calls.filter(c => c[0] === 'rename'), [['rename', 't5-a', '小美']])
  assert.equal(m.s.msg, CLOUD_TEXT.renamed)
  assert.equal(m.s.renameId, '')
})

test('撤銷：第一次點只是確認、第二次才送；成功後清單重讀', async () => {
  const m = make({ nodes: [{ id: 't5-a', name: '小真', last_seen_at: null, online: false }] })
  await m.ui.load()
  await m.ui.revoke('t5-a')
  assert.equal(m.s.confirmId, 't5-a')
  assert.ok(!m.calls.some(c => c[0] === 'revoke'))
  m.setNodes([])
  await m.ui.revoke('t5-a')
  assert.deepEqual(m.calls.filter(c => c[0] === 'revoke'), [['revoke', 't5-a']])
  assert.equal(m.s.msg, CLOUD_TEXT.revoked)
  assert.equal(m.s.confirmId, '')
  assert.deepEqual(m.s.rows, [])
})

test('核准無畫面主機：要名字與短碼才送；送出後清掉輸入、金鑰不經過這裡', async () => {
  const m = make()
  await m.ui.load(); m.ui.openApprove()
  m.s.code = 'ABCD-2345'; m.s.hostName = ''
  await m.ui.approve()
  assert.equal(m.s.msg, CLOUD_TEXT.approveNeedName)
  m.s.hostName = '機房甲'; m.s.code = '  '
  await m.ui.approve()
  assert.equal(m.s.msg, CLOUD_TEXT.approveNeedCode)
  m.s.code = 'ABCD-2345'; m.s.hostId = ' t5-host '
  await m.ui.approve()
  assert.deepEqual(m.calls.filter(c => c[0] === 'approve'), [['approve', 'ABCD-2345', '機房甲', 't5-host']])
  assert.match(m.s.approved, /已核准「機房甲」（t5-host）/)
  assert.equal(m.s.approveForm, false)
  assert.equal(m.s.code, '')
  assert.ok(!JSON.stringify(m.s).includes(KEY))
})

test('沒有重發金鑰（電腦版也沒有）：畫面寫明金鑰弄丟就撤銷後重新邀請', () => {
  const src = read('ui/lib/mobile-cloud.mjs')
  assert.doesNotMatch(src, /reissue|revokeOld/)
  assert.match(CLOUD_TEXT.lostKey, /撤銷/)
  assert.match(CLOUD_TEXT.lostKey, /重新邀請/)
})

test('接線守門：手機的指令清單有這四個指令、頁面接上、離開會清、說明不再寫手機不能做、文字是人話', () => {
  const lib = read('src-tauri/src/lib.rs')
  const mobile = /#\[cfg\(not\(desktop\)\)\]\n\s*let builder = builder\.invoke_handler\(tauri::generate_handler!\[([\s\S]*?)\]\);/.exec(lib)[1]
  for (const c of ['cloud_agent_create', 'cloud_agent_list', 'cloud_agent_revoke', 'cloud_agent_approve']) assert.ok(mobile.includes(`cloud_invite::${c}`), `手機要有 ${c}`)
  assert.match(lib, /#\[cfg\(feature = "gui"\)\]\nmod cloud_invite;/, '電腦與手機共用，不能掛 cfg(desktop)')
  const rs = read('src-tauri/src/cloud_invite.rs')
  assert.match(rs, /auth\.access_token\(/, '一律用登入憑證（沒登入就不能用），手機沒有多拿權限')
  const js = read('ui/m.js'), html = read('ui/m.html')
  assert.match(js, /createMobileCloud\(\{/)
  assert.match(js, /if \(c === 'cloud'\)/)
  assert.match(js, /else if \(old === 'cloud'\)[\s\S]{0,120}cloud\.leave\(\)/, '離開這一頁金鑰與剪貼簿都清掉')
  assert.match(js, /visibilitychange'.*cloud\.onVisible\(\)/)
  assert.match(html, /v-else-if="settingCat === 'cloud'"/)
  assert.match(html, /:type="cloudSt\.reveal \? 'text' : 'password'"/, '金鑰預設遮住')
  assert.ok(!html.includes('localStorage') && !js.includes("store('cloud"), '金鑰不寫任何儲存')
  const cloud = phoneGuideList().find(g => g.key === 'cloud')
  assert.doesNotMatch(cloud.note, /手機不能做/)
  assert.match(cloud.note, /設定/); assert.doesNotMatch(cloud.note, /設置/)
  for (const [k, t] of Object.entries(CLOUD_TEXT)) if (typeof t === 'string') assert.doesNotMatch(t, /cloud_|agent_|invoke|https?:/i, k)
})
