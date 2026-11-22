// 前端呼叫後端只留一個出口（#2106 ①）：
// (a) 除 ui/lib/tauri.mjs 外，不准直接碰 __TAURI__.core.invoke（chatpane 以前有 3 處繞過出口）
// (b) 直接呼叫 invoke( 的檔案與次數以「待搬清單」為上限：只准少、不准多；變少時清單要同步更新（清單永遠精確）
// (c) 出口失敗要寫一行 [ASN] 記錄：不含 args、原文限長、e.message 不變、同一行 60 秒內只記一次
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const UI = fileURLToPath(new URL('../ui', import.meta.url))
const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)])
const rel = f => path.relative(UI, f).split(path.sep).join('/')
const files = walk(UI).filter(f => /\.m?js$/.test(f)).filter(f => rel(f) !== 'lib/tauri.mjs')
const src = f => fs.readFileSync(f, 'utf8')

// 待搬清單：各檔直接呼叫 invoke( 的次數（含註解裡的字樣）。後續分組搬遷時，搬完一個檔就刪一行或改小數字。
export const PENDING = {
  'lib/account-roster.mjs': 2,
  'lib/claude-accounts.mjs': 24,
  'lib/quota-readers.mjs': 6,
  'list.js': 2,
  'm.js': 25,
}

test('除 tauri.mjs 外，不准直接呼叫 __TAURI__.core.invoke', () => {
  const bad = files.filter(f => /(__TAURI__|\bT)\??\.core\??\.invoke/.test(src(f))).map(rel)
  assert.deepEqual(bad, [], `這些檔繞過出口：${bad.join(', ')}（改走 lib/tauri.mjs 的 invoke 或 transport）`)
})

test('直接呼叫 invoke( 的檔案與次數只准少、不准多，變少要同步更新待搬清單', () => {
  const now = {}
  for (const f of files) {
    const n = (src(f).match(/(?<![\w.$])invoke\(/g) || []).length
    if (n) now[rel(f)] = n
  }
  const more = Object.entries(now).filter(([k, n]) => n > (PENDING[k] ?? 0)).map(([k, n]) => `${k}：${PENDING[k] ?? 0} → ${n}`)
  assert.deepEqual(more, [], `直接 invoke 變多或新檔出現，請改走 lib/tauri.mjs 的 transport：${more.join('；')}`)
  const less = Object.entries(PENDING).filter(([k, n]) => (now[k] ?? 0) < n).map(([k, n]) => `${k}：清單 ${n} → 實際 ${now[k] ?? 0}`)
  assert.deepEqual(less, [], `次數變少了，請同步更新本檔的待搬清單：${less.join('；')}`)
})

test('chatpane 開連結走出口 openLink', () => {
  const s = src(path.join(UI, 'lib/chatpane.mjs'))
  assert.match(s, /import \{ openLink \} from '\.\/tauri\.mjs'/)
  assert.equal((s.match(/openLink\(/g) || []).length, 3)
})

// ---- 出口失敗寫記錄：用假的 __TAURI__ 注入，每個測試載入一份全新的模組 ----
let seq = 0
async function load(fake) {
  const saved = globalThis.__TAURI__
  globalThis.__TAURI__ = { core: { invoke: fake } }
  try { return await import(`../ui/lib/tauri.mjs?t=${++seq}`) } finally { globalThis.__TAURI__ = saved }
}
function capture() {
  const lines = []
  const orig = console.warn
  console.warn = (...a) => lines.push(a)
  return { lines, restore: () => { console.warn = orig } }
}

test('invoke 失敗：記一行 [ASN]、不含 args、限長，e.message 維持原文', async () => {
  const SECRET = 'sk-secret-body-123'
  const long = 'x'.repeat(1000)
  const { invoke } = await load(async (cmd) => { throw cmd === 'a' ? 'denied: 找不到' : new Error(long) })
  const cap = capture()
  try {
    await assert.rejects(invoke('a', { body: SECRET, path: 'C:\\Users\\x' }), e => e instanceof Error && e.message === 'denied: 找不到')
    await assert.rejects(invoke('b', { body: SECRET }), e => e.message === long)   // 原文不被截斷
  } finally { cap.restore() }
  assert.equal(cap.lines.length, 2)
  assert.equal(cap.lines[0][0], '[ASN]')
  assert.equal(cap.lines[0][1], 'invoke 失敗：a denied: 找不到')
  assert.ok(cap.lines[1][1].startsWith('invoke 失敗：b xxx'))
  assert.ok(cap.lines[1][1].length <= 'invoke 失敗：b '.length + 300)
  assert.ok(!JSON.stringify(cap.lines).includes(SECRET))
  assert.ok(!JSON.stringify(cap.lines).includes('Users'))
})

test('invoke 成功：不記、回傳值不變', async () => {
  const { invoke } = await load(async (cmd, args) => ({ cmd, args }))
  const cap = capture()
  try { assert.deepEqual(await invoke('ok', { n: 1 }), { cmd: 'ok', args: { n: 1 } }) } finally { cap.restore() }
  assert.equal(cap.lines.length, 0)
})

test('同一指令＋同一原文 60 秒內只記一次，換原文或過 60 秒再記；ui_log 失敗不記（免得繞圈）', async () => {
  const { invoke } = await load(async (cmd, args) => { throw args?.m ?? 'boom' })
  const realNow = Date.now
  let t = 1_000_000
  Date.now = () => t
  const cap = capture()
  try {
    for (let i = 0; i < 5; i++) await invoke('poll').catch(() => {})
    assert.equal(cap.lines.length, 1)
    await invoke('poll', { m: 'other' }).catch(() => {})
    await invoke('poll2').catch(() => {})
    assert.equal(cap.lines.length, 3)
    t += 61_000
    await invoke('poll').catch(() => {})
    assert.equal(cap.lines.length, 4)
    await invoke('ui_log', { lines: ['x'] }).catch(() => {})
    assert.equal(cap.lines.length, 4)
  } finally { cap.restore(); Date.now = realNow }
})

test('openLink：沒有 Tauri 時什麼都不做；有就走 open_link', async () => {
  const calls = []
  const m = await load(async (cmd, args) => { calls.push([cmd, args]) })
  assert.ok(m.openLink('https://x.test') instanceof Promise)
  await Promise.resolve()
  assert.deepEqual(calls, [['open_link', { url: 'https://x.test' }]])
  const saved = globalThis.__TAURI__
  delete globalThis.__TAURI__
  try { const n = await import(`../ui/lib/tauri.mjs?t=${++seq}`); assert.equal(n.openLink('https://x.test'), undefined) } finally { globalThis.__TAURI__ = saved }
})

// ---- ⑦：list.js 第一批（設定頁各區塊）的出口：指令名與參數形狀與以前直接 invoke 時完全相同 ----
test('設定頁出口：指令名與參數形狀不變', async () => {
  const calls = []
  const m = await load(async (cmd, args) => { calls.push([cmd, args]); return null })
  await m.settingsApi.setFrame(true); await m.settingsApi.setCloseToTray(false); await m.settingsApi.trayAvailable()
  await m.settingsApi.guardGet(); await m.settingsApi.guardSet(true); await m.settingsApi.guardResume(); await m.settingsApi.askpassHelperInfo()
  await m.autostartApi.supported(); await m.autostartApi.get(); await m.autostartApi.blocked(); await m.autostartApi.set(true)
  await m.bridgeApi.status(); await m.bridgeApi.setRemoteLaunch(true); await m.bridgeApi.setAutoResume(false); await m.bridgeApi.setCompactHandoff(true, 4)
  await m.bridgeApi.setTermServer(true); await m.bridgeApi.retryTermFetch(); await m.bridgeApi.setPermPhone(true); await m.bridgeApi.setMobileView(false)
  await m.bridgeApi.setRemoteInput(true); await m.bridgeApi.setScreenWatch(true); await m.bridgeApi.setUnaddressedTo('x'); await m.bridgeApi.takeover()
  await m.updateApi.check(); await m.updateApi.install(); await m.updateApi.remoteStatus(); await m.updateApi.remoteRequest('N1')
  await m.logViewApi.openMachineLogDir()
  await m.voiceApi.ttsVoices(); await m.voiceApi.sttStatus(); await m.voiceApi.cfgGet(); await m.voiceApi.cfgSet({ a: 1 })
  assert.deepEqual(calls, [
    ['set_frame', { native: true }], ['set_close_to_tray', { tray: false }], ['tray_available', undefined],
    ['guard_get', undefined], ['guard_set', { on: true }], ['guard_resume', undefined], ['askpass_helper_info', undefined],
    ['autostart_supported', undefined], ['autostart_get', undefined], ['autostart_blocked', undefined], ['autostart_set', { on: true }],
    ['bridge_status', undefined], ['bridge_set_remote_launch', { on: true }], ['bridge_set_auto_resume', { on: false }], ['bridge_set_compact_handoff', { on: true, n: 4 }],
    ['bridge_set_term_server', { on: true }], ['bridge_retry_term_fetch', undefined], ['bridge_set_perm_phone', { on: true }], ['bridge_set_mobile_view', { on: false }],
    ['bridge_set_remote_input', { on: true }], ['bridge_set_screen_watch', { on: true }], ['bridge_set_unaddressed_to', { name: 'x' }], ['bridge_takeover', { confirmed: true }],
    ['update_check', undefined], ['update_install', undefined], ['update_remote_status', undefined], ['update_remote_request', { node: 'N1' }],
    ['open_machine_log_dir', undefined],
    ['tts_voices', undefined], ['stt_status', undefined], ['voice_cfg_get', undefined], ['voice_cfg_set', { cfg: { a: 1 } }],
  ])
})

test('list.js 第一批：已搬的設定頁指令不再直接 invoke、走具名出口', () => {
  const s = src(path.join(UI, 'list.js'))
  const moved = ['set_frame', 'tray_available', 'autostart_supported', 'autostart_get', 'autostart_blocked', 'autostart_set', 'guard_get', 'guard_set', 'guard_resume',
    'askpass_helper_info', 'bridge_status', 'bridge_set_', 'bridge_retry_term_fetch', 'bridge_takeover', 'update_check', 'update_install', 'update_remote_', 'open_machine_log_dir',
    'tts_voices', 'stt_status', 'voice_cfg_']
  for (const c of moved) assert.ok(!s.includes(`'${c}`), `${c} 還在 list.js 直接呼叫`)
  assert.ok(!/invoke\('set_close_to_tray'/.test(s), 'set_close_to_tray 還在 list.js 直接呼叫')
  for (const api of ['settingsApi.setFrame(', 'settingsApi.setCloseToTray(', 'bridgeApi.takeover()', 'updateApi.check()', 'autostartApi.set(on)', 'voiceApi.cfgSet(next)']) assert.ok(s.includes(api), api)
})

// ---- ⑧：list.js 第二批（視窗開關、版面、啟動／--shot 截圖）的出口：指令名與參數形狀不變 ----
test('視窗與啟動截圖出口：指令名與參數形狀不變', async () => {
  const calls = []
  const m = await load(async (cmd, args) => { calls.push([cmd, args]); return null })
  await m.windowApi.openChat('c1', 'T'); await m.windowApi.openPanel('guide', 'G', 1, 2); await m.windowApi.closePanels('guide'); await m.windowApi.closeAllPanels()
  await m.windowApi.closeChats(); await m.windowApi.mainLayout(true, 3, 4, false); await m.windowApi.shake('c1', true); await m.windowApi.showToast({ cid: 'c1' })
  await m.windowApi.openWindows(); await m.windowApi.mainVisible(); await m.windowApi.chatVisible('c1')
  await m.shellApi.startupInfo(); await m.shellApi.showMain(); await m.shellApi.captureUiReady('t'); await m.shellApi.takeShot('x'); await m.shellApi.takeShot()
  await m.shellApi.shotFrontendLog('error', 5); await m.shellApi.quitApp()
  assert.deepEqual(calls, [
    ['open_chat', { id: 'c1', title: 'T' }], ['open_panel', { kind: 'guide', title: 'G', w: 1, h: 2 }], ['close_panels', { kind: 'guide' }], ['close_panels', undefined],
    ['close_chats', undefined], ['main_layout', { merged: true, w: 3, h: 4, recenter: false }], ['shake', { id: 'c1', main: true }], ['show_toast', { toast: { cid: 'c1' } }],
    ['open_windows', undefined], ['main_visible', undefined], ['chat_visible', { id: 'c1' }],
    ['startup_info', undefined], ['show_main', undefined], ['capture_ui_ready', { tag: 't' }], ['take_shot', { tab: 'x' }], ['take_shot', undefined],
    ['shot_frontend_log', { level: 'error', message: '5' }], ['quit_app', undefined],
  ])
})

test('list.js 第二批：已搬的視窗與啟動截圖指令不再直接 invoke、走具名出口', () => {
  const s = src(path.join(UI, 'list.js'))
  const moved = ['startup_info', 'shot_frontend_log', 'open_windows', 'main_visible', 'chat_visible', 'shake', 'show_toast', 'show_main', 'open_chat', 'open_panel', 'close_panels',
    'close_chats', 'main_layout', 'capture_ui_ready', 'take_shot', 'quit_app']
  for (const c of moved) assert.ok(!s.includes("invoke('" + c + "'"), `${c} 還在 list.js 直接呼叫`)
  for (const api of ['windowApi.openChat(', 'windowApi.openPanel(', 'windowApi.mainLayout(', 'windowApi.closeChats()', 'shellApi.showMain()', 'shellApi.takeShot(', 'shellApi.quitApp()', 'shellApi.startupInfo()']) assert.ok(s.includes(api), api)
  const ex = src(path.join(UI, 'lib/tauri.mjs'))
  for (const c of moved) assert.ok(ex.includes(`'${c}'`), `${c} 不在 tauri.mjs 出口`)
})

// ---- ⑨：list.js 第三批（終端遠端、已知電腦、連結、邀請、記錄路徑、托盤未讀、正在播放、廣告）的出口：指令名與參數形狀不變 ----
test('終端遠端、已知電腦、連結、托盤出口：指令名與參數形狀不變', async () => {
  const calls = []
  const m = await load(async (cmd, args) => { calls.push([cmd, args]); return null })
  const k = m.makeKnownDeviceApi(m.invoke), t = m.makeTermRemoteApi(m.invoke), l = m.makeLogViewApi(m.invoke)
  await k.ownFingerprint(); await k.ownFingerprintQr(); await k.list(); await k.setLoginOk('n1', 1); await k.setLoginOk('n1', false); await k.forget('n1')
  await t.viewedStop('v1'); await t.viewActive('p'); await t.offerAnswer({ id: 1 }); await t.offerSend({ id: 2 }); await t.withdraw('t1'); await t.pending()
  await l.relayLogPaths()
  await m.linkApi.openLink('https://a'); await m.linkApi.openUrl('https://b'); await m.linkApi.invitePending()
  await m.trayApi.setUnread(3); await m.trayApi.setPresence('on', ''); await m.trayApi.setNowPlaying(true); await m.trayApi.adsFetch()
  assert.deepEqual(calls, [
    ['device_own_fingerprint', undefined], ['device_own_fingerprint_qr', undefined], ['device_known_list', undefined], ['device_known_login_ok', { node: 'n1', on: true }], ['device_known_login_ok', { node: 'n1', on: false }], ['device_known_forget', { node: 'n1' }],
    ['term_viewed_stop', { id: 'v1' }], ['term_view_active', { name: 'p' }], ['term_remote_offer_answer', { req: { id: 1 } }], ['term_remote_offer_send', { req: { id: 2 } }], ['term_remote_withdraw', { id: 't1' }], ['term_remote_pending', undefined],
    ['relay_log_paths', undefined],
    ['open_link', { url: 'https://a' }], ['open_url', { url: 'https://b' }], ['invite_pending', undefined],
    ['set_tray_unread', { n: 3 }], ['set_presence', { status: 'on', psm: '' }], ['set_now_playing', { on: true }], ['ads_fetch', undefined],
  ])
})

test('list.js 第三批：已搬的指令不再直接 invoke、走具名出口；只剩帳號那邊的 ai_cli_login', () => {
  const s = src(path.join(UI, 'list.js'))
  const moved = ['relay_log_paths', 'term_viewed_stop', 'device_own_fingerprint', 'device_own_fingerprint_qr', 'device_known_list', 'device_known_login_ok', 'device_known_forget', 'invite_pending',
    'set_tray_unread', 'set_presence', 'set_now_playing', 'ads_fetch', 'term_remote_offer_answer', 'term_remote_offer_send', 'term_remote_withdraw', 'term_remote_pending', 'term_view_active', 'open_url', 'open_link']
  for (const c of moved) assert.ok(!s.includes("invoke('" + c + "'"), `${c} 還在 list.js 直接呼叫`)
  for (const api of ['logViewApi.relayLogPaths(', 'knownDeviceApi.list()', 'knownDeviceApi.setLoginOk(', 'knownDeviceApi.forget(', 'knownDeviceApi.ownFingerprintQr()', 'termRemoteApi.offerSend(', 'termRemoteApi.withdraw(', 'termRemoteApi.pending()',
    'termRemoteApi.viewActive(', 'linkApi.openLink(', 'linkApi.openUrl(', 'linkApi.invitePending()', 'trayApi.setUnread(', 'trayApi.setPresence(', 'trayApi.setNowPlaying(', 'trayApi.adsFetch()', 'termRemoteErrorText(']) assert.ok(s.includes(api), api)
  assert.deepEqual([...s.matchAll(/(?<![\w.$])invoke\('([a-z_]+)'/g)].map(x => x[1]), ['ai_cli_login', 'ai_cli_login'])
  const ex = src(path.join(UI, 'lib/tauri.mjs'))
  for (const c of moved) assert.ok(ex.includes(`'${c}'`), `${c} 不在 tauri.mjs 出口`)
})

// ---- ⑩：m.js 第一批（收寄信、管理夥伴、照片、三種請求確認）的出口：指令名與參數形狀與以前直接 invoke 時完全相同 ----
test('手機出口：指令名與參數形狀不變', async () => {
  const calls = []
  const m = await load(async (cmd, args) => { calls.push([cmd, args]); return cmd === 'relay_sent_status' ? { status: [1] } : null })
  const r = m.makeMobileRelayApi(m.invoke)
  assert.deepEqual(await r.sentStatus(['a']), [1])
  await r.list(); await r.inbox(); await r.ack(['a']); await r.send({ p: 1 }); await r.history('N', 'ag', 'pid', 5, 20); await r.history('N')
  await r.readSync({ b: 1 }); await r.avatar('N'); await r.partnerAvatar('P'); await r.setAvatar(null); await r.sendAttachment({ f: 1 })
  const o = m.makeMobileOpsApi(m.invoke); await o.partnerOp({ b: 1 }); await o.partnerOps(['i']); await o.partnerArchive({ b: 2 })
  const p = m.makeMobilePhotoApi(m.invoke); await p.fetch('id1'); await p.fetch('id2', 99); await p.save('id3', 'n.png')
  const a = m.makeMobileAskApi(m.invoke)
  await a.secretPending(); await a.secretReply('s1', 'pw'); await a.secretReply('s2', null)
  await a.permReqList(); await a.permReqDecide({ id: 'q1', choiceN: 2, hash: 'h', extra: 'x' })
  await a.termReqList(); await a.termReqDecide({ id: 't1', decision: 'allow', choiceN: 1, hash: 'h2', extra: 'x' })
  assert.deepEqual(calls, [
    ['relay_sent_status', { ids: ['a'] }],
    ['relay_list', undefined], ['relay_inbox', undefined], ['relay_ack', { ids: ['a'] }], ['relay_send', { payload: { p: 1 } }],
    ['relay_chat_history', { node: 'N', agent: 'ag', partnerId: 'pid', before: 5, limit: 20 }],
    ['relay_chat_history', { node: 'N', agent: null, partnerId: null, before: null, limit: null }],
    ['relay_read_sync', { body: { b: 1 } }], ['relay_avatar', { node: 'N' }], ['relay_partner_avatar', { partner: 'P' }], ['relay_set_avatar', { avatar: null }],
    ['relay_send_attachment', { payload: { f: 1 } }],
    ['android_partner_op', { body: { b: 1 } }], ['android_partner_ops', { ids: ['i'] }], ['android_partner_archive', { body: { b: 2 } }],
    ['relay_attachment_fetch', { id: 'id1', expiresAt: null }], ['relay_attachment_fetch', { id: 'id2', expiresAt: 99 }], ['relay_attachment_save', { id: 'id3', name: 'n.png' }],
    ['android_secret_pending', undefined], ['android_secret_reply', { id: 's1', secret: 'pw' }], ['android_secret_reply', { id: 's2', secret: null }],
    ['android_perm_req_list', undefined], ['android_perm_req_decide', { id: 'q1', choiceN: 2, hash: 'h' }],
    ['android_term_req_list', undefined], ['android_term_req_decide', { id: 't1', decision: 'allow', choiceN: 1, hash: 'h2' }],
  ])
})

test('m.js 第一批：已搬的指令不再直接 invoke、走具名出口', () => {
  const s = src(path.join(UI, 'm.js'))
  const moved = ['relay_list', 'relay_inbox', 'relay_ack', 'relay_send', 'relay_chat_history', 'relay_sent_status', 'relay_read_sync', 'relay_avatar', 'relay_partner_avatar',
    'relay_set_avatar', 'relay_send_attachment', 'android_partner_op', 'android_partner_ops', 'android_partner_archive', 'relay_attachment_fetch', 'relay_attachment_save',
    'android_secret_pending', 'android_secret_reply', 'android_perm_req_list', 'android_perm_req_decide', 'android_term_req_list', 'android_term_req_decide']
  for (const c of moved) assert.ok(!s.includes(`'${c}'`), `${c} 還在 m.js 直接呼叫`)
  for (const api of ['const transport = mobileRelayApi', 'const opsTransport = mobileOpsApi', 'mobilePhotoApi.fetch(id, expiresAt)', 'mobilePhotoApi.save(id, name)',
    'mobileAskApi.secretPending()', 'mobileAskApi.secretReply(cur.id, value)', 'mobileAskApi.permReqDecide(args)', 'mobileAskApi.termReqDecide(args)']) assert.ok(s.includes(api), api)
  assert.equal((s.match(/mobileAskApi\.permReqList\(\)/g) ?? []).length, 3)
  assert.equal((s.match(/mobileAskApi\.termReqList\(\)/g) ?? []).length, 1)
  // 手機沒有 ui.log：出口的失敗原文只留在 console.warn；這幾處「下一輪再查」的靜默 catch 要有註解交代
  assert.equal((s.match(/出口已留警告記錄，下一輪再查/g) ?? []).length, 5)
})
