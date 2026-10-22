// 手機版「管理夥伴視窗」的純邏輯：選單（誰有、誰反灰、為什麼）、請求內容、錯誤與進度的中文、詳情列。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { HANDOVER_GIVE_UP_MS, ONLINE_OPS, OPS, OP_GIVE_UP_MS, QUEUE_GIVE_UP_MS, REASON, STALE_TEXT, buildOpRequest, infoRows, isManageable, menuItems, opErrorText, opFormError, progressView } from '../ui/lib/partner-ops.mjs'
import { machinesByNode } from '../ui/lib/mobile-launch.mjs'

const LAUNCHER = { profiles: [{ id: 'claude' }], cwd_allow: ['D:\\Github\\asn'] }
const MACH = machinesByNode({ machines: [{ node: 'H', launcher: LAUNCHER, online: true }, { node: 'C', launcher: null, online: true }, { node: 'W', launcher: LAUNCHER, online: false }] })
const ctx = { machines: MACH, loaded: true, signedIn: true, asn: { H: [{ window_name: 'H-ASN' }] } }
const W = (node, agent, extra = {}) => ({ id: `${node}/${agent}`, node, agent, nick: agent, status: 'online', engine: 'claude', kind: 'claude', device: `設備${node}`, ...extra })

test('選單五項：詳情、改名、切換模型、關閉視窗、接班換手；都能用時全部 ok（在線的沒有喚醒）', () => {
  const items = menuItems(W('H', '小文'), ctx)
  assert.deepEqual(items.map(i => i.key), ONLINE_OPS)
  assert.deepEqual(OPS, [...ONLINE_OPS, 'resume'])
  assert.deepEqual(items.map(i => i.label), ['詳情', '改名', '切換模型', '關閉視窗', '接班換手'])
  assert.ok(items.every(i => i.ok && i.reason === ''))
})

test('人、手機、雲端代理、群組、ASN／收發室視窗：空陣列（不顯示選單）', () => {
  for (const f of [W('H', '小良', { kind: 'owner' }), W('P', '手機', { kind: 'phone' }), W('G', '代理', { kind: 'grok' }), W('H', '群', { room: true }), W('H', '某人', { person: true }),
    W('H', 'H-ASN'), W('H', '另一個', { engine: 'asn' }), W('H', '家用收發室'), W('Q', '雲端', {}), { node: '', agent: '' }, null]) {
    const nonWin = f?.node === 'Q' ? { ...ctx, nonWindowNodes: ['Q'] } : ctx
    assert.deepEqual(menuItems(f, nonWin), [], JSON.stringify(f))
    assert.equal(isManageable(f, nonWin), false)
  }
})

test('不能用就反灰並給中文原因：沒登入、離線、沒開放（詳情除外）、還沒查到設定、舊後台', () => {
  const rs = items => Object.fromEntries(items.map(i => [i.key, i.reason]))
  assert.ok(menuItems(W('H', 'a'), { ...ctx, signedIn: false }).every(i => !i.ok && i.reason === REASON.needLogin), '沒登入全反灰（含詳情）')
  assert.ok(menuItems(W('W', 'a'), ctx).every(i => !i.ok && i.reason === REASON.offline), '那台電腦離線')
  const closed = menuItems(W('C', 'a'), ctx)
  assert.deepEqual(closed.map(i => i.ok), [true, false, false, false, false], '沒開放：只有詳情能用')
  assert.equal(rs(closed).rename, REASON.closed)
  const notLoaded = menuItems(W('H', 'a'), { ...ctx, loaded: false })
  assert.deepEqual(notLoaded.map(i => i.ok), [true, false, false, false, false])
  assert.equal(rs(notLoaded).close, REASON.unknown)
  assert.ok(menuItems(W('H', 'a'), { ...ctx, supported: false }).every(i => !i.ok && i.reason === REASON.unsupported))
  for (const r of Object.values(REASON)) assert.ok(!/[A-Za-z]{4,}/.test(r), `純中文：${r}`)
  for (const i of menuItems(W('H', 'a'), ctx)) assert.ok(!/[A-Za-z]{4,}/.test(i.label))
})

test('離線的 AI 夥伴只有「喚醒」：有登入、那台電腦在線且開放才能按；其餘反灰並寫中文原因', () => {
  const off = (node, extra = {}) => W(node, '小離', { status: 'offline', ...extra })
  assert.deepEqual(menuItems(off('H'), ctx), [{ key: 'resume', label: '喚醒', ok: true, reason: '' }])
  const one = (f, c = ctx) => menuItems(f, c).map(i => [i.key, i.ok, i.reason])
  assert.deepEqual(one(off('H'), { ...ctx, signedIn: false }), [['resume', false, REASON.needLogin]])
  assert.deepEqual(one(off('W')), [['resume', false, REASON.deviceOffline]], '那台電腦離線')
  assert.deepEqual(one(off('Z')), [['resume', false, REASON.deviceOffline]], '查不到那台電腦')
  assert.deepEqual(one(off('C')), [['resume', false, REASON.closed]], '沒開放')
  assert.deepEqual(one(off('H'), { ...ctx, loaded: false }), [['resume', false, REASON.unknown]])
  assert.deepEqual(one(off('H'), { ...ctx, supported: false }), [['resume', false, REASON.unsupported]])
  assert.deepEqual(menuItems(off('H', { engine: 'codex' }), ctx), [], '只有 Claude 的夥伴能喚醒')
  assert.equal(menuItems(off('H', { engine: null }), ctx).length, 1, '名單沒寫引擎（離線記得的）就當 Claude')
  for (const f of [off('H', { kind: 'phone' }), off('H', { person: true }), off('H', { room: true }), off('H', { agent: '家用收發室' }), off('H', { engine: 'asn' })]) assert.deepEqual(menuItems(f, ctx), [], JSON.stringify(f))
  assert.deepEqual(buildOpRequest(off('H'), 'resume', { newName: 'x', note: 'y' }), { node: 'H', name: '小離', op: 'resume' }, '喚醒只送節點、名字、動作（session 由後台查）')
  assert.equal(opFormError(off('H'), 'resume', {}), '')
  assert.equal(opFormError(off('H'), 'resume', {}, one(off('C'))[0] && menuItems(off('C'), ctx)[0]), REASON.closed)
})

test('送出前檢查與請求內容：只放該動作的欄位；節點與視窗名取自名單', () => {
  const f = W('H', '小文')
  assert.deepEqual(buildOpRequest(f, 'close', { newName: 'x', model: 'y', note: 'z' }), { node: 'H', name: '小文', op: 'close' })
  assert.deepEqual(buildOpRequest(f, 'info'), { node: 'H', name: '小文', op: 'info' })
  assert.deepEqual(buildOpRequest(f, 'rename', { newName: ' 小文二號 ' }), { node: 'H', name: '小文', op: 'rename', new_name: '小文二號' })
  assert.deepEqual(buildOpRequest(f, 'model', { model: ' opus[1m] ' }), { node: 'H', name: '小文', op: 'model', model: 'opus[1m]' })
  assert.deepEqual(buildOpRequest(f, 'handover', { note: ' 接著做 ' }), { node: 'H', name: '小文', op: 'handover', note: '接著做' })
  assert.deepEqual(buildOpRequest(f, 'handover', { note: '  ' }), { node: 'H', name: '小文', op: 'handover' })
  assert.equal(opFormError(f, 'rename', { newName: '小文二號' }), '')
  for (const bad of ['', '-rf', 'a b', 'a;b', 'x'.repeat(41)]) assert.match(opFormError(f, 'rename', { newName: bad }), /名字/, bad)
  assert.match(opFormError(f, 'rename', { newName: '小文' }), /一樣/)
  assert.equal(opFormError(f, 'model', { model: 'opus[1m]' }), '')
  for (const bad of ['', 'a b', 'x;y', 'm'.repeat(61)]) assert.match(opFormError(f, 'model', { model: bad }), /模型/, bad)
  assert.match(opFormError(f, 'handover', { note: 'x'.repeat(1001) }), /1000/)
  assert.equal(opFormError(f, 'handover', { note: 'x'.repeat(1000) }), '')
  assert.match(opFormError(f, 'kill'), /不認得/)
  const blocked = menuItems(W('C', 'a'), ctx).find(i => i.key === 'close')
  assert.equal(opFormError(W('C', 'a'), 'close', {}, blocked), REASON.closed, '反灰的項目不送出')
})

test('接班換手的進度分段：請前任寫交接 → 關閉前任視窗 → 開新視窗 → 完成（附交接檔位置）', () => {
  const t0 = 1_000_000
  const at = (detail, now = t0 + 1000) => progressView({ status: 'taken', detail }, { op: 'handover', sentAt: t0, now })
  const states = v => v.steps.map(s => s.state)
  assert.deepEqual([at('stage:handoff').text, states(at('stage:handoff'))], ['請前任寫交接中…', ['active', 'todo', 'todo']])
  assert.deepEqual([at('stage:closing').text, states(at('stage:closing'))], ['關閉前任視窗中…', ['done', 'active', 'todo']])
  assert.deepEqual([at('stage:opening').text, states(at('stage:opening'))], ['開新視窗中…', ['done', 'done', 'active']])
  assert.equal(at('').text, '那台電腦正在處理…', '還沒回報階段')
  assert.equal(at('stage:evil <b>').text, '那台電腦正在處理…', '看不懂的階段不外露')
  const p = 'C:/Users/x/.asn/handoff/交接/p_1/20261022-101500.md'
  const done = progressView({ status: 'ok', result: { handoff_path: p, handoff_done: true } }, { op: 'handover' })
  assert.deepEqual([done.phase, done.text, states(done), done.extra], ['done', '接班換手完成，新視窗開好了。', ['done', 'done', 'done'], ['交接檔：' + p]])
  const partial = progressView({ status: 'ok', result: { handoff_path: 'D:/h/a.md', handoff_done: false } }, { op: 'handover' })
  assert.match(partial.extra.join(' '), /前任沒有寫完交接/)
  assert.deepEqual(progressView({ status: 'ok' }, { op: 'handover' }).extra, [], '沒有結果也不壞')
  assert.deepEqual(progressView({ status: 'ok' }, { op: 'resume' }), { phase: 'done', done: true, text: '已喚醒，視窗開好了。' })
  // 處理中的上限：接班換手要等前任寫交接，放寬到 15 分鐘；其他動作仍是 3 分鐘
  assert.equal(at('stage:handoff', t0 + OP_GIVE_UP_MS + 1).done, false)
  assert.equal(at('stage:handoff', t0 + HANDOVER_GIVE_UP_MS + 1).done, true)
  assert.equal(progressView({ status: 'taken' }, { op: 'close', sentAt: t0, now: t0 + OP_GIVE_UP_MS + 1 }).done, true)
  // 改名、切換模型遇到忙碌視窗會排隊等（電腦端最多 10 分鐘）：回報 stage:queued 顯示排隊中，上限放寬到 15 分鐘
  for (const op of ['rename', 'model']) {
    const q = progressView({ status: 'taken', detail: 'stage:queued' }, { op, sentAt: t0, now: t0 + OP_GIVE_UP_MS + 1 })
    assert.deepEqual([q.phase, q.done, q.text], ['working', false, '排隊中，等它忙完…'], op)
    assert.equal(progressView({ status: 'taken', detail: 'stage:queued' }, { op, sentAt: t0, now: t0 + QUEUE_GIVE_UP_MS + 1 }).done, true, op)
  }
  assert.equal(QUEUE_GIVE_UP_MS > 10 * 60 * 1000, true)
  assert.equal(progressView({ status: 'pending' }, { op: 'handover', sentAt: t0, now: t0 + OP_GIVE_UP_MS + 1 }).done, true, '還沒被取走照舊 3 分鐘')
  assert.equal(HANDOVER_GIVE_UP_MS > 10 * 60 * 1000, true)
})

test('錯誤翻成中文：後台代碼、沒登入、斷線、舊後台；看不懂的給通用句，不洩漏英文', () => {
  assert.match(opErrorText('partner_op HTTP 409 busy'), /進行中/)
  assert.match(opErrorText('partner_op HTTP 403 protected'), /收發室/)
  assert.match(opErrorText('partner_op HTTP 409 name_taken'), /同名/)
  assert.match(opErrorText('partner_op HTTP 401 unauthorized'), /登入/)
  assert.match(opErrorText('partner_op HTTP 409 no_launcher'), /沒有開放/)
  assert.match(opErrorText('partner_op HTTP 429 rate_limited'), /太多次/)
  assert.match(opErrorText('partner_op HTTP 409 already_online'), /已經在線上/)
  assert.match(opErrorText('partner_op HTTP 409 no_session'), /對話紀錄/)
  assert.match(opErrorText('partner_op HTTP 409 device_offline'), /不在線/)
  assert.equal(opErrorText('partner_op HTTP 404 '), REASON.unsupported, '舊後台沒有這個動作')
  assert.equal(opErrorText('尚未登入，無法管理夥伴視窗'), REASON.needLogin)
  assert.match(opErrorText('partner_op 連線失敗：timeout'), /網路/)
  assert.equal(opErrorText('模型名稱不對'), '模型名稱不對', 'Rust 端自己擋下的中文原樣')
  assert.equal(opErrorText('partner_op HTTP 500 weird_thing'), '送出失敗，請稍後再試')
  assert.equal(opErrorText('some English failure'), '送出失敗，請稍後再試')
  assert.equal(opErrorText(undefined), '送出失敗，請稍後再試')
})

test('進度：已送出 → 電腦正在處理 → 完成／失敗原因；等太久顯示版本可能太舊', () => {
  const t0 = 1_000_000
  assert.deepEqual(progressView({ status: 'pending' }, { sentAt: t0, now: t0 + 1000 }), { phase: 'sent', done: false, text: '已經送出，等那台電腦接手…' })
  assert.deepEqual(progressView({ status: 'taken' }, { sentAt: t0, now: t0 + 1000 }), { phase: 'working', done: false, text: '那台電腦正在處理…' })
  assert.equal(progressView({ status: 'ok' }, { op: 'rename' }).text, '已改名。')
  assert.match(progressView({ status: 'ok' }, { op: 'close' }).text, /已關閉/)
  assert.match(progressView({ status: 'ok' }, { op: 'handover' }).text, /接班換手/)
  assert.equal(progressView({ status: 'ok', op: 'model' }).text, '已切換模型。', 'op 取自那一筆')
  assert.ok(progressView({ status: 'ok' }).done)
  assert.equal(progressView({ status: 'failed', detail: '找不到這個視窗' }).text, '沒有成功：找不到這個視窗')
  assert.equal(progressView({ status: 'failed', detail: 'expired' }).text, `沒有成功：${STALE_TEXT}`)
  assert.equal(progressView({ status: 'failed', detail: 'Error: ENOENT' }).text, '沒有成功：電腦端回報失敗', '英文錯誤不外露')
  assert.equal(progressView({ status: 'failed', detail: '' }).text, '沒有成功：沒有說明原因')
  assert.match(progressView({ status: 'unconfirmed' }).text, /還沒確認/)
  for (const s of ['pending', 'taken']) {
    const v = progressView({ status: s }, { sentAt: t0, now: t0 + OP_GIVE_UP_MS + 1 })
    assert.deepEqual([v.phase, v.done, v.text], ['failed', true, `沒有成功：${STALE_TEXT}`])
  }
  assert.equal(STALE_TEXT, '那台電腦的 ASN 版本可能太舊，或沒有在跑')
})

test('詳情列：中文標籤；沒有的欄位不列；外殼只列程式名稱不列參數', () => {
  const started = new Date(2026, 9, 22, 9, 5).toISOString()
  const rows = infoRows({
    pid: 4321, model: 'opus[1m]', engine: 'claude', cwd: 'D:\\Github\\asn', started_at: started, status: 'idle', opened_by: 'asn',
    shell_chain: ['Windows Terminal', 'C:\\Program Files\\PowerShell\\pwsh.exe -NoProfile -Command secret', 'claude.exe --resume abc'], mod: true, context: { used: 123000, limit: 1000000, percent: 12.3 },
  })
  assert.deepEqual(rows, [
    { label: 'PID', value: '4321' }, { label: '模型', value: 'opus[1m]' }, { label: '引擎', value: 'Claude' }, { label: '工作資料夾', value: 'D:\\Github\\asn' },
    { label: '開啟時間', value: '2026-10-22 09:05' }, { label: '狀態', value: '閒置' }, { label: '開啟方式', value: 'ASN 開的' },
    { label: '外殼', value: 'Windows Terminal → pwsh → claude' }, { label: 'ASN 外掛', value: '已安裝' }, { label: '上下文用量', value: '已用 12%（12.3 萬 / 100 萬）' },
  ])
  assert.ok(!JSON.stringify(rows).match(/secret|resume|NoProfile/), '參數不外露')
  assert.deepEqual(infoRows({ pid: 7, opened_by: 'user', mod: false, status: 'busy' }), [
    { label: 'PID', value: '7' }, { label: '狀態', value: '忙碌' }, { label: '開啟方式', value: '自己開的' }, { label: 'ASN 外掛', value: '沒有安裝' }])
  assert.deepEqual(infoRows({}), []); assert.deepEqual(infoRows(null), []); assert.deepEqual(infoRows([1]), [])
  assert.deepEqual(infoRows({ pid: 'abc', status: 'weird', started_at: 'nope', context: {} }), [], '壞資料與看不懂的英文不列')
})

test('守門：手機指令清單有兩個簽章指令；沒有電腦端指令；Rust 沒簽章在打後台之前就回錯；後台只對 partner_op／partner_ops 讀簽章', () => {
  const root = new URL('..', import.meta.url)
  const read = (...p) => fs.readFileSync(new URL(p.join('/'), root), 'utf8').replace(/\r\n/g, '\n')
  const lib = read('src-tauri', 'src', 'lib.rs')
  const m = /#\[cfg\(not\(desktop\)\)\]\n\s*let builder = builder\.invoke_handler\(tauri::generate_handler!\[([\s\S]*?)\]\);/.exec(lib)
  const names = m[1].split(',').map(s => s.trim().replace(/^\w+::/, '')).filter(Boolean)
  assert.ok(names.includes('android_partner_op') && names.includes('android_partner_ops'), '手機要有管理視窗的兩個指令')
  const desktop = /#\[cfg\(desktop\)\]\n\s*let builder = builder\.invoke_handler\(tauri::generate_handler!\[([\s\S]*?)\]\);/.exec(lib)
  if (desktop) assert.ok(!desktop[1].includes('android_partner_op'), '電腦版不帶手機指令')
  const rs = read('src-tauri', 'src', 'android.rs')
  assert.match(rs, /pub async fn android_partner_op\b[\s\S]*?signing_token\(&auth\)\.await[\s\S]*?partner_op_signed\(&body, token\.as_deref\(\)\)/)
  assert.match(rs, /pub async fn android_partner_ops\b[\s\S]*?signing_token\(&auth\)\.await[\s\S]*?partner_ops_signed\(&ids, token\.as_deref\(\)\)/)
  const relay = read('src-tauri', 'src', 'relay.rs')
  assert.match(relay, /pub async fn partner_op_signed[\s\S]*?ok_or\("尚未登入，無法管理夥伴視窗"\)\?;[\s\S]*?api_signed\("partner_op"/, '沒憑證在打後台之前就回錯')
  assert.match(relay, /pub async fn partner_ops_signed[\s\S]*?ok_or\("尚未登入，無法查詢管理操作的進度"\)\?;[\s\S]*?api_signed\("partner_ops"/)
  assert.match(read('..', '..', 'supabase', 'functions', 'relay', 'index.ts'), /action === "partner_op" \|\| action === "partner_ops"\) \? await signedUserId/)
})
