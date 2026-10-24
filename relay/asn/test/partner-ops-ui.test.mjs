// 電腦版管理夥伴視窗介面：送出並輪詢、各動作的對話框文字、名單右鍵與對話上方「喚醒」按鈕的接線。判斷本身在 lib/partner-ops.mjs（partner-ops.test.mjs）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { loadOpsContext, opDialogText, runPartnerOp } from '../ui/lib/partner-ops-ui.mjs'
import { sameFriend, wakeButtonView } from '../ui/lib/actionbar.mjs'
import { REASON, initialOpsCtx, loginBlock, menuItems } from '../ui/lib/partner-ops.mjs'
import { machinesByNode } from '../ui/lib/mobile-launch.mjs'

const read = f => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const LAUNCHER = { profiles: [{ id: 'claude' }], cwd_allow: ['D:\\x'] }
const MACH = machinesByNode({ machines: [{ node: 'H', launcher: LAUNCHER, online: true }, { node: 'C', launcher: null, online: true }, { node: 'W', launcher: LAUNCHER, online: false }] })
const ctx = { machines: MACH, loaded: true, signedIn: true }
const F = (node, agent, extra = {}) => ({ id: `${node}/${agent}`, node, agent, nick: agent, status: 'online', engine: 'claude', device: `設備${node}`, ...extra })

function fakeApi(rows, { fail = null } = {}) {
  const calls = { op: [], ops: [] }
  let i = 0
  return {
    calls,
    partnerOp: async body => { calls.op.push(body); if (fail) throw new Error(fail); return { id: 'op-1' } },
    partnerOps: async ids => { calls.ops.push(ids); const r = rows[Math.min(i++, rows.length - 1)]; return { ops: r ? [{ id: 'op-1', ...r }] : [] } },
  }
}
const run = (api, friend, op, input, extra = {}) => {
  let t = 1_000_000
  const seen = []
  return runPartnerOp(api, friend, op, input, { now: () => t, sleep: async ms => { t += ms }, pollMs: 3000, onUpdate: v => seen.push(v), ...extra }).then(v => ({ v, seen }))
}

test('送出並輪詢：只送 node／name／op 與該動作的欄位，進度逐段回報到完成', async () => {
  const api = fakeApi([{ status: 'pending' }, { status: 'taken', detail: 'stage:handoff' }, { status: 'taken', detail: 'stage:closing' }, { status: 'ok', result: { handoff_path: 'D:/h/a.md', handoff_done: true } }])
  const { v, seen } = await run(api, F('H', '小文'), 'handover', { note: ' 先看 PR ', newName: 'x', model: 'y' })
  assert.deepEqual(api.calls.op, [{ node: 'H', name: '小文', op: 'handover', note: '先看 PR' }])
  assert.deepEqual(api.calls.ops, [['op-1'], ['op-1'], ['op-1'], ['op-1']])
  assert.deepEqual(seen.map(x => x.text), ['正在發送指令…', '正在發送指令…', '請前任寫交接中…', '關閉前任視窗中…', '接班換手完成，新視窗開好了。'])
  assert.equal(v.phase, 'done'); assert.deepEqual(v.extra, ['交接檔：D:/h/a.md'])
})

test('送出失敗：沒登入、後台代碼都翻成中文，不洩漏英文；喚醒走同一個動作', async () => {
  let r = await run(fakeApi([], { fail: '尚未登入，無法管理夥伴視窗' }), F('H', '小離', { status: 'offline' }), 'resume', {})
  assert.deepEqual([r.v.phase, r.v.text], ['failed', REASON.needLogin])
  r = await run(fakeApi([], { fail: 'partner_op HTTP 409 already_online' }), F('H', '小離', { status: 'offline' }), 'resume', {})
  assert.match(r.v.text, /已經在線上/)
  const api = fakeApi([{ status: 'taken' }, { status: 'ok' }])
  r = await run(api, F('H', '小離', { status: 'offline' }), 'resume', { newName: 'x' })
  assert.deepEqual(api.calls.op, [{ node: 'H', name: '小離', op: 'resume' }])
  assert.equal(r.v.text, '已喚醒，視窗開好了。')
})

test('輪詢：暫時連不上不算失敗、等太久顯示逾時；被取消就停手', async () => {
  const api = { partnerOp: async () => ({ id: 'op-1' }), partnerOps: async () => { throw new Error('連線失敗') } }
  const r = await run(api, F('H', 'a'), 'close', {})
  assert.equal(r.v.phase, 'failed'); assert.match(r.v.text, /版本可能太舊/)
  let n = 0
  const c = await run(fakeApi([{ status: 'taken' }]), F('H', 'a'), 'close', {}, { cancelled: () => ++n > 2 })
  assert.equal(c.v, null)
})

test('詳情：完成時附中文詳情列', async () => {
  const r = await run(fakeApi([{ status: 'ok', result: { pid: 7, model: 'opus', status: 'idle' } }]), F('H', 'a'), 'info', {})
  assert.deepEqual(r.v.rows.map(x => x.label), ['PID', '模型', '狀態'])
})

test('設定載入：沒登入、查不到的都當沒查到（反灰說明），不丟錯', async () => {
  assert.deepEqual(await loadOpsContext({ authStatus: async () => ({ signed_in: true }), launchers: async () => ({ machines: [{ node: 'H', launcher: LAUNCHER, online: true }] }) }), { machines: { H: { node: 'H', launcher: LAUNCHER, online: true } }, loaded: true, signedIn: true, checking: false, authError: '', loadError: '' })
  assert.deepEqual(await loadOpsContext({ authStatus: async () => { throw new Error('x') }, launchers: async () => { throw new Error('y') } }), { machines: {}, loaded: false, signedIn: null, checking: false, authError: 'x', loadError: 'y' })
})

test('對話框文字：接班換手說明流程、全部純中文、不出現節點代號與夥伴 ID', () => {
  const h = opDialogText('handover', '小文', '家用機')
  assert.equal(h.title, '接班換手')
  assert.match(h.lead, /「小文」/); assert.match(h.lead, /家用機/)
  assert.match(h.points.join(''), /交接.*關掉.*同一個名字/s)
  assert.equal(opDialogText('close', '小文', '家用機').lead, '關掉「小文」在「家用機」上的視窗？對話記錄會留著。')
  assert.equal(opDialogText('resume', '小離').auto, true, '喚醒不用再確認')
  assert.equal(opDialogText('info', '小文').auto, true)
  assert.equal(opDialogText('rename', '小文').auto, false)
  for (const op of ['info', 'rename', 'close', 'handover', 'resume']) {
    const t = opDialogText(op, '小文', '家用機')
    for (const x of [t.title, t.lead, t.ok, ...t.points]) assert.ok(!/[A-Za-z]{4,}|p_[0-9a-f]{20}/.test(x), `${op}: ${x}`)
  }
})

test('喚醒按鈕：只有離線的 AI 夥伴才顯示；條件與右鍵選單同一套，不能按就反灰並寫原因', () => {
  assert.deepEqual(wakeButtonView(F('H', 'a'), ctx), { show: false, ok: false, reason: '' }, '在線的不顯示')
  assert.deepEqual(wakeButtonView(F('H', 'a', { status: 'busy' }), ctx).show, false)
  assert.deepEqual(wakeButtonView(F('H', 'a', { status: 'offline' }), ctx), { show: true, ok: true, reason: '' })
  assert.deepEqual(wakeButtonView(F('W', 'a', { status: 'offline' }), ctx), { show: true, ok: false, reason: REASON.deviceOffline })
  assert.deepEqual(wakeButtonView(F('C', 'a', { status: 'offline' }), ctx), { show: true, ok: false, reason: REASON.closed })
  assert.deepEqual(wakeButtonView(F('H', 'a', { status: 'offline' }), { ...ctx, signedIn: false }), { show: true, ok: false, reason: REASON.needLogin })
  for (const f of [F('H', 'p', { status: 'offline', kind: 'owner' }), F('H', 'p', { status: 'offline', person: true }), F('H', '家用收發室', { status: 'offline' }), F('H', 'x', { status: 'offline', engine: 'codex' }), null, F('H', 'a', { status: 'offline', pending: true })]) {
    assert.equal(wakeButtonView(f, ctx).show, false, JSON.stringify(f))
  }
  const off = F('H', 'a', { status: 'offline' })
  assert.deepEqual(wakeButtonView(off, ctx).ok, menuItems(off, ctx).find(i => i.key === 'resume').ok, '同一套判斷')
})

test('接線：名單右鍵用 menuItems（不另寫判斷、不重複切換模型）；喚醒按鈕與圖示；接班舊介面已清掉', () => {
  const js = read('ui/list.js'), html = read('ui/list.html'), bar = read('ui/lib/actionbar.mjs')
  assert.match(js, /manageItems\(buddyMenuFriend\.value, \{ \.\.\.opsCtx, friends: friends\.value, asn: asnMap\.value \}\)\)/)
  assert.doesNotMatch(js, /buddyOpItems = computed\([^\n]*\.filter\(/, '項目固定，不再過濾掉任何一項（切換模型換成子選單但位置不變）')
  assert.match(html, /v-for="it in buddyOpItems"[^>]*>[\s\S]*?:aria-disabled="it\.ok \? 'false' : 'true'"[\s\S]*?:title="it\.reason" @click="openPartnerOp\(it\)"/)
  assert.match(html, /<partner-op-dialog v-if="opDlg\.open"/)
  assert.match(js, /app\.component\('partner-op-dialog', PartnerOpDialog\)/)
  assert.match(bar, /aria-label="喚醒"/); assert.match(bar, /v-if="wake\.show" class="abtn" type="button" :disabled="!wake\.ok" :title="wake\.ok \? '[^']*' : wake\.reason"/, '不能用就反灰、原因寫在提示')
  assert.match(fs.readFileSync(new URL('../ui/img/ab-wake.svg', import.meta.url), 'utf8'), /^<svg/)
  for (const f of ['ui/list.js', 'ui/list.html', 'ui/m.js', 'ui/m.html', 'ui/lib/tauri.mjs']) assert.doesNotMatch(read(f), /這是誰的接班|succeed|Succession|successor|partnerList|relay_partner_list/i, f)
  assert.ok(!fs.existsSync(new URL('../ui/lib/succession.mjs', import.meta.url)))
  const tauri = read('ui/lib/tauri.mjs')
  assert.match(tauri, /partnerOp: body => invoke\('relay_partner_op', \{ body \}\)/); assert.match(tauri, /partnerOps: ids => invoke\('relay_partner_ops', \{ ids \}\)/)
})

test('電腦端指令：relay_partner_op／relay_partner_ops 只在電腦版清單，走本人簽章；手機清單沒有它們', () => {
  const lib = read('src-tauri/src/lib.rs')
  assert.match(lib, /#\[cfg\(desktop\)\]\n#\[tauri::command\]\nasync fn relay_partner_op\([^)]*\) -> Result<Value, String> \{\n    let r = relay_of\(&app\)\?;\n    let token = account::signing_token\(&auth\)\.await;\n    r\.partner_op_signed\(&body, token\.as_deref\(\)\)\.await/)
  assert.match(lib, /#\[cfg\(desktop\)\]\n#\[tauri::command\]\nasync fn relay_partner_ops\([^)]*\) -> Result<Value, String> \{\n    let r = relay_of\(&app\)\?;\n    let token = account::signing_token\(&auth\)\.await;\n    r\.partner_ops_signed\(&ids, token\.as_deref\(\)\)\.await/)
  const d = /#\[cfg\(desktop\)\]\n\s*let builder = builder\s*\.invoke_handler\(tauri::generate_handler!\[([\s\S]*?)\]\);/.exec(lib)[1]
  assert.match(d, /relay_partner_op, relay_partner_ops,/)
  const m = /#\[cfg\(not\(desktop\)\)\]\n\s*let builder = builder\.invoke_handler\(tauri::generate_handler!\[([\s\S]*?)\]\);/.exec(lib)[1]
  assert.doesNotMatch(m, /\brelay_partner_ops?\b/, '電腦端指令不能進手機清單')
})

// ---------- 喚醒按鈕「要先登入」誤報（0.1.45） ----------

const OFFLINE = F('H', '小文', { status: 'offline' })

test('還沒查到登入狀態：喚醒顯示查詢中，不是要先登入', () => {
  const v = wakeButtonView(OFFLINE, initialOpsCtx())
  assert.equal(v.show, true); assert.equal(v.ok, false)
  assert.equal(v.reason, REASON.checking)
  assert.notEqual(v.reason, REASON.needLogin)
  assert.deepEqual(menuItems(F('H', '小文'), initialOpsCtx()).slice(0, 5).map(i => i.reason), Array(5).fill(REASON.checking))
})

test('登入狀態查詢失敗：顯示真正原因，不當成沒登入；查到真的沒登入才說要先登入', async () => {
  const bad = await loadOpsContext({ authStatus: async () => { throw new Error('讀不到登入存檔') }, launchers: async () => ({ machines: [{ node: 'H', launcher: LAUNCHER, online: true }] }) })
  assert.equal(bad.signedIn, null)
  const r = wakeButtonView(OFFLINE, bad).reason
  assert.match(r, /查不到登入狀態：讀不到登入存檔/)
  const no = await loadOpsContext({ authStatus: async () => ({ signed_in: false }), launchers: async () => ({ machines: [] }) })
  assert.equal(wakeButtonView(OFFLINE, no).reason, REASON.needLogin)
  const empty = await loadOpsContext({ authStatus: async () => undefined, launchers: async () => ({ machines: [] }) })
  assert.equal(empty.signedIn, null)
  assert.equal(loginBlock({ signedIn: true }), '')
  assert.equal(loginBlock({}), '', '舊呼叫端沒給就不擋')
})

test('已登入、電腦設定查到、那台在線且開放：喚醒可按；設定查詢失敗顯示原因', async () => {
  const ok = await loadOpsContext({ authStatus: async () => ({ signed_in: true }), launchers: async () => ({ machines: [{ node: 'H', launcher: LAUNCHER, online: true }] }) })
  assert.equal(wakeButtonView(OFFLINE, ok).ok, true)
  const bad = await loadOpsContext({ authStatus: async () => ({ signed_in: true }), launchers: async () => { throw new Error('連不上收發室') } })
  assert.equal(wakeButtonView(OFFLINE, bad).reason, '查不到這台電腦的設定：連不上收發室')
})

test('查詢回來時名單物件已換新：以夥伴 ID 判斷是同一位，結果不丟掉', () => {
  assert.equal(sameFriend({ id: 'H/小文', a: 1 }, { id: 'H/小文', a: 2 }), true)
  assert.equal(sameFriend({ id: 'H/小文' }, { id: 'H/別人' }), false)
  assert.equal(sameFriend(null, { id: 'x' }), false)
})

test('三個畫面都用「未知」當初始值，不再寫死 signedIn:false', () => {
  for (const f of ['ui/lib/actionbar.mjs', 'ui/list.js']) {
    const t = read(f)
    assert.ok(t.includes('initialOpsCtx()'), f)
    assert.ok(!/signedIn:\s*false/.test(t), `${f} 不可把初始登入狀態寫成 false`)
  }
  const m = read('ui/m.js')
  assert.ok(m.includes('acctSigned()') && !/signedIn:\s*acct\.value\.signed_in/.test(m), '手機版要區分「還沒查到」')
  assert.ok(!/props\.friend [!=]== f/.test(read('ui/lib/actionbar.mjs')), '查詢回來要比夥伴 ID，不能比物件')
})

test('對話框文字：重開要確認、接班換手依引擎說不同的事（ACP 不請前任寫交接）', () => {
  const r = opDialogText('restart', 'Gemini', '家用機', 'acp')
  assert.equal(r.auto, false); assert.equal(r.title, '重開'); assert.match(r.lead, /背景工作者/); assert.match(r.lead, /對話會保留/)
  const acp = opDialogText('handover', 'Gemini', '', 'acp')
  assert.ok(acp.points.some(p => /不會請前任寫交接/.test(p)))
  const claude = opDialogText('handover', '小文', '')
  assert.ok(claude.points.some(p => /先請它把交接寫到一個檔案/.test(p)))
  for (const t of [r, acp, claude]) for (const s of [t.title, t.lead, t.ok, ...t.points]) assert.ok(!/[A-Za-z]{4,}/.test(s.replace('Gemini', '')), `純中文：${s}`)
})
