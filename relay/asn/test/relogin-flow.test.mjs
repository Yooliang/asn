// 電腦版設備頁「重新登入 Claude」（#1645）：別台走和手機同一套請求；本機開官方登入終端並觀察到登入好為止
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { DESK_RELOGIN_TEXT, LOCAL_GIVE_UP_MS, LOCAL_POLL_MS, createReloginFlow, reloginSnap } from '../ui/lib/relogin-flow.mjs'
import { SETUP_TEXT, PENDING_WAIT_MS } from '../ui/lib/mobile-setup.mjs'
import { STATE, localReloginAction, reloginAction } from '../ui/lib/device-state.mjs'

const read = f => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const plain = o => o   // 測試不需要響應，用原物件

// 假的時間與計時器：手動往前撥，到時間就跑已排的回呼
function clock() {
  let t = 1_000_000, id = 0
  const timers = new Map()
  return {
    now: () => t,
    setIntervalFn: (fn, ms) => { timers.set(++id, { fn, ms, at: t + ms }); return id },
    clearIntervalFn: i => timers.delete(i),
    count: () => timers.size,
    async advance(ms) {
      const end = t + ms
      for (;;) {
        const due = [...timers.values()].filter(x => x.at <= end).sort((a, b) => a.at - b.at)[0]
        if (!due) break
        t = due.at; due.at += due.ms
        await due.fn(); await new Promise(r => setImmediate(r))
      }
      t = end
    },
  }
}
const flush = () => new Promise(r => setImmediate(r))

test('入口：本機只在 Claude 登入失效時有（kind local）；別台和手機的判斷沒有變', () => {
  assert.deepEqual(localReloginAction({ vendor: 'claude', isSelf: true, state: STATE.LOGIN_FAILED }), { kind: 'local' })
  for (const s of Object.values(STATE).filter(s => s !== STATE.LOGIN_FAILED)) assert.equal(localReloginAction({ vendor: 'claude', isSelf: true, state: s }), null, s)
  assert.equal(localReloginAction({ vendor: 'codex', isSelf: true, state: STATE.LOGIN_FAILED }), null)
  assert.equal(localReloginAction({ vendor: 'claude', isSelf: false, state: STATE.LOGIN_FAILED }), null, '別台不是本機入口')
  assert.equal(localReloginAction({ vendor: 'claude', isSelf: true, phone: true, state: STATE.LOGIN_FAILED }), null)
  assert.equal(reloginAction({ vendor: 'claude', isSelf: true, online: true, state: STATE.LOGIN_FAILED }), null, '原本的別台判斷照舊不給本機')
  assert.deepEqual(reloginAction({ vendor: 'claude', online: true, state: STATE.LOGIN_FAILED }), { kind: 'remote' })
})

test('別台：先確認才送；送出帶 node 與 mode relogin；接手後說網址送到手機；完成就結束輪詢', async () => {
  const c = clock(), calls = []
  let status = { nodes: [] }
  const invoke = async (cmd, args) => { calls.push([cmd, args]); if (cmd === 'setup_remote_request') return {}; if (cmd === 'setup_remote_status') return status; throw new Error('不該呼叫 ' + cmd) }
  const f = createReloginFlow({ invoke, reactive: plain, ...c })
  f.ask('Q', 'remote')
  assert.equal(f.state.stage, 'confirm'); assert.equal(calls.length, 0, '按鈕只進確認，不送')
  await f.yes(); await flush()
  assert.deepEqual(calls[0], ['setup_remote_request', { node: 'Q', mode: 'relogin' }])
  assert.equal(f.state.stage, 'waiting'); assert.equal(f.state.text, SETUP_TEXT.pending)
  status = { nodes: [{ id: 'Q', setup: { state: 'taken', detail: '', replaced: '' } }] }
  await c.advance(5000); await flush()
  assert.equal(f.state.text, DESK_RELOGIN_TEXT.taken); assert.match(f.state.text, /你的手機/); assert.doesNotMatch(f.state.text, /這支手機|安裝/)
  status = { nodes: [{ id: 'Q', setup: { state: 'done', detail: '已重新登入', replaced: '' } }] }
  await c.advance(5000); await flush()
  assert.deepEqual([f.state.stage, f.state.ok, f.state.text], ['done', true, '已重新登入'])
  assert.equal(c.count(), 0, '結束就停止輪詢')
  assert.ok(!calls.some(x => x[0] === 'ai_cli_login'), '別台不開本機終端')
})

test('別台：後台代碼對成人話；沒回應、讀不到狀態、已有進行中的要求都說出來', async () => {
  let c = clock()
  let f = createReloginFlow({ invoke: async () => { throw new Error('setup:asn_outdated') }, reactive: plain, ...c })
  f.ask('Q'); await f.yes()
  assert.deepEqual([f.state.stage, f.state.ok, f.state.text], ['done', false, '那台電腦的 ASN 版本太舊，請先在那台電腦更新 ASN'])
  c = clock()
  f = createReloginFlow({ invoke: async cmd => (cmd === 'setup_remote_request' ? {} : { nodes: [] }), reactive: plain, ...c })
  f.ask('Q'); await f.yes()
  await c.advance(PENDING_WAIT_MS + 10_000); await flush()
  assert.deepEqual([f.state.stage, f.state.ok, f.state.text], ['done', false, SETUP_TEXT.noReply])
  c = clock()
  f = createReloginFlow({ invoke: async cmd => { if (cmd === 'setup_remote_request') return {}; throw new Error('x') }, reactive: plain, ...c })
  f.ask('Q'); await f.yes()
  await c.advance(20_000); await flush()
  assert.equal(f.state.text, SETUP_TEXT.pollFail)
  c = clock()
  f = createReloginFlow({ invoke: async cmd => (cmd === 'setup_remote_request' ? { already: true } : { nodes: [{ id: 'Q', setup: { state: 'pending', detail: '' } }] }), reactive: plain, ...c })
  f.ask('Q'); await f.yes(); await flush()
  assert.equal(f.state.lead, SETUP_TEXT.already)
})

test('本機：確認後開官方登入終端；登入好了就停，不送請求、不碰手機', async () => {
  const c = clock(), calls = []
  let logged = false
  const invoke = async (cmd, args) => { calls.push([cmd, args]); return null }
  const f = createReloginFlow({ invoke, reactive: plain, checkLoggedIn: async () => logged, ...c })
  f.ask('H', 'local'); assert.equal(f.state.kind, 'local'); assert.equal(calls.length, 0)
  await f.yes()
  assert.deepEqual(calls, [['ai_cli_login', { toolId: 'claude' }]])
  assert.equal(f.state.text, DESK_RELOGIN_TEXT.localOpened)
  await c.advance(LOCAL_POLL_MS * 3); assert.equal(f.state.stage, 'waiting', '還沒登入好就繼續等')
  logged = true
  await c.advance(LOCAL_POLL_MS); await flush()
  assert.deepEqual([f.state.stage, f.state.ok, f.state.text], ['done', true, DESK_RELOGIN_TEXT.localDone])
  assert.equal(c.count(), 0)
  assert.ok(!calls.some(x => x[0].startsWith('setup_remote')), '本機不送請求')
})

test('本機：5 分鐘內沒登入好就收手並說明；開不起來就說原因', async () => {
  let c = clock()
  let f = createReloginFlow({ invoke: async () => null, reactive: plain, checkLoggedIn: async () => false, ...c })
  f.ask('H', 'local'); await f.yes()
  await c.advance(LOCAL_GIVE_UP_MS - 5000); assert.equal(f.state.stage, 'waiting')
  await c.advance(10_000); await flush()
  assert.deepEqual([f.state.stage, f.state.ok, f.state.text], ['done', false, DESK_RELOGIN_TEXT.localWaitOut])
  assert.equal(c.count(), 0)
  c = clock()
  f = createReloginFlow({ invoke: async () => { throw '尚未安裝 Claude Code，請先按「安裝」。' }, reactive: plain, ...c })
  f.ask('H', 'local'); await f.yes()
  assert.deepEqual([f.state.stage, f.state.ok], ['done', false]); assert.match(f.state.text, /沒有開始登入：尚未安裝/)
})

test('流程防呆：送出只在確認階段；先不要會清掉；進行中不能重來；關閉只在結果階段；快照只含畫面要的欄位', async () => {
  const c = clock(), calls = []
  const f = createReloginFlow({ invoke: async cmd => { calls.push(cmd); return {} }, reactive: plain, ...c })
  await f.yes(); assert.equal(calls.length, 0, '沒確認不送')
  f.ask('Q'); f.no(); assert.equal(f.state.stage, 'idle')
  f.ask('Q'); await f.yes(); f.ask('Z'); assert.equal(f.state.node, 'Q', '進行中再按不重來')
  f.close(); assert.equal(f.state.stage, 'waiting', '還沒結果不能關')
  f.stop()
  assert.deepEqual(Object.keys(reloginSnap(f.state)).sort(), ['kind', 'lead', 'note', 'ok', 'stage', 'target', 'text'])
})

test('接線：電腦版指令清單補了兩個註冊（指令本身沒改）；畫面只在 Claude 區、有入口時出現；文字是人話', () => {
  const lib = read('src-tauri/src/lib.rs')
  assert.ok(lib.includes('account::update_remote_status, account::setup_remote_request, account::setup_remote_status,'), '電腦版清單有兩個指令')
  // 本機的登入失效判定：只讀的小指令，和手機要求重新登入時看的是同一個（claude_relogin_evidence），只在電腦版清單
  assert.match(lib, /fn claude_login_failed\(\) -> bool \{\s+claude_relogin_evidence\(\)\.is_some\(\)\s+\}/)
  assert.equal((lib.match(/claude_login_failed,/g) ?? []).length, 1, '只註冊在電腦版清單')
  const acct = read('src-tauri/src/account.rs')
  assert.match(acct, /pub async fn setup_remote_request[\s\S]*?"node_setup_request"/)
  const panel = read('ui/lib/settings-panel.mjs'), js = read('ui/list.js')
  assert.match(panel, /class="dv-install dv-relogin" v-if="v\.key === 'claude' && st\.relogin/)
  for (const op of ['relogin-ask', 'relogin-yes', 'relogin-no', 'relogin-close']) assert.ok(js.includes(`case '${op}'`), op)
  assert.match(js, /createReloginFlow\(\{/)
  const flow = read('ui/lib/relogin-flow.mjs')
  assert.equal((flow.match(/invoke\('setup_remote_request'/g) ?? []).length, 1, '只有一處送出')
  assert.ok(!/node_setup|setup_device/.test(flow), '不繞過原本的指令')
  for (const t of Object.values(DESK_RELOGIN_TEXT).map(x => (typeof x === 'function' ? x('示範電腦') : x))) assert.doesNotMatch(t, /setup|install|asn_|https?:\/\//i, t)
})

test('設備樹：本機帳號被標登入失效時，這台的 Claude 狀態是登入失效、帶本機入口；沒標就是已登入、沒有入口', async () => {
  const { buildDeviceTree } = await import('../ui/lib/device-tree.mjs')
  const mk = failed => buildDeviceTree({ friends: [], selfNode: 'P', self: { claude: [{ email: 'me@example.com', plan: 'max', current: true, ...(failed ? { login_failed: true } : {}) }] }, reports: {}, launchers: {}, machines: [] }).find(d => d.self)
  const bad = mk(true).vendors.find(v => v.key === 'claude')
  assert.deepEqual([bad.state, bad.relogin], [STATE.LOGIN_FAILED, { kind: 'local' }])
  const ok = mk(false).vendors.find(v => v.key === 'claude')
  assert.deepEqual([ok.state, ok.relogin], [STATE.LOGGED_IN, undefined])
})
