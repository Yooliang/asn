// 手機版「雲端代理」（#756、todo-next-199）：邀請、金鑰只顯示一次、清剪貼簿、清單與撤銷、核准主機、接線
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { CLIP_CLEAR_MS, CLOUD_TEXT, createMobileCloud } from '../ui/lib/mobile-cloud.mjs'
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
  assert.match(cloud.note, /設置/)
  for (const [k, t] of Object.entries(CLOUD_TEXT)) if (typeof t === 'string') assert.doesNotMatch(t, /cloud_|agent_|invoke|https?:/i, k)
})
