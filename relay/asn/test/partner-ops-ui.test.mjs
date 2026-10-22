// 電腦版管理夥伴視窗介面：送出並輪詢、各動作的對話框文字、名單右鍵與對話上方「喚醒」按鈕的接線。判斷本身在 lib/partner-ops.mjs（partner-ops.test.mjs）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { loadOpsContext, opDialogText, runPartnerOp } from '../ui/lib/partner-ops-ui.mjs'
import { wakeButtonView } from '../ui/lib/actionbar.mjs'
import { REASON, menuItems } from '../ui/lib/partner-ops.mjs'
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
  assert.deepEqual(seen.map(x => x.text), ['已經送出，等那台電腦接手…', '已經送出，等那台電腦接手…', '請前任寫交接中…', '關閉前任視窗中…', '接班換手完成，新視窗開好了。'])
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
  assert.deepEqual(await loadOpsContext({ authStatus: async () => ({ signed_in: true }), launchers: async () => ({ machines: [{ node: 'H', launcher: LAUNCHER, online: true }] }) }), { machines: { H: { node: 'H', launcher: LAUNCHER, online: true } }, loaded: true, signedIn: true })
  assert.deepEqual(await loadOpsContext({ authStatus: async () => { throw new Error('x') }, launchers: async () => { throw new Error('y') } }), { machines: {}, loaded: false, signedIn: false })
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
  assert.match(js, /manageItems\(buddyMenuFriend\.value, \{ \.\.\.opsCtx, friends: friends\.value, asn: asnMap\.value \}\)\.filter\(i => i\.key !== 'model'\)/)
  assert.match(html, /v-for="it in buddyOpItems"[^>]*>[\s\S]*?:disabled="!it\.ok" :title="it\.reason" @click="openPartnerOp\(it\)"/)
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
