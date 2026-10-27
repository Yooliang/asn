import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { LAUNCHERS_POLL_MAX_MS, LAUNCHERS_POLL_MS, isAuthDenied, launchersErrorText, nextLaunchersDelay } from '../ui/lib/launcher-poll.mjs'
import { loadOpsContext } from '../ui/lib/partner-ops-ui.mjs'

const denied = new Error('launchers HTTP 403 forbidden')

test('被後台擋（401／403）才算沒有權限；連線失敗、尚未登入不算', () => {
  for (const m of ['launchers HTTP 403 forbidden', 'acct_list HTTP 401 unauthorized', 'Forbidden']) assert.ok(isAuthDenied(new Error(m)), m)
  for (const m of ['launchers 連線失敗：timeout', 'HTTP 500 internal', '尚未登入，無法查詢電腦的啟動設定', '4030 筆']) assert.ok(!isAuthDenied(new Error(m)), m)
})

test('#380：連續被擋就把間隔加倍、最長 5 分鐘；查到一次或其他失敗都回到 15 秒', () => {
  let d = LAUNCHERS_POLL_MS
  const seen = []
  for (let i = 0; i < 8; i++) { d = nextLaunchersDelay(d, denied); seen.push(d) }
  assert.deepEqual(seen.slice(0, 4), [30_000, 60_000, 120_000, 240_000])
  assert.ok(seen.slice(4).every(x => x === LAUNCHERS_POLL_MAX_MS), '最長 5 分鐘')
  assert.equal(nextLaunchersDelay(LAUNCHERS_POLL_MAX_MS, null), LAUNCHERS_POLL_MS, '查到就恢復')
  assert.equal(nextLaunchersDelay(LAUNCHERS_POLL_MAX_MS, new Error('連線失敗')), LAUNCHERS_POLL_MS, '暫時連不上不拉長')
  assert.equal(nextLaunchersDelay(undefined, denied), 30_000)
  // 以一天計：舊的每 15 秒一次是 5760 次；被擋時拉到 5 分鐘只剩 288 次左右
  let t = 0, n = 0; d = LAUNCHERS_POLL_MS
  while (t < 86_400_000) { n++; d = nextLaunchersDelay(d, denied); t += d }
  assert.ok(n < 300, `一天被擋最多約 300 次，實際 ${n}`)
})

test('畫面說明不露 HTTP 狀態碼與後台原文，只說使用者能做什麼', () => {
  const t = launchersErrorText(denied)
  assert.ok(!/HTTP|403|forbidden/i.test(t) && t.includes('登入'), t)
  assert.ok(!/HTTP|500/.test(launchersErrorText(new Error('HTTP 500 internal'))))
  assert.ok(launchersErrorText(new Error('尚未登入，無法查詢')).includes('登入'))
})

test('管理選單的「查不到這台電腦的設定」用改寫後的說明（#380）', async () => {
  const info = console.info; console.info = () => {}
  try {
    const ctx = await loadOpsContext({ authStatus: async () => ({ signed_in: true }), launchers: async () => { throw denied } })
    assert.equal(ctx.loaded, false)
    assert.ok(!/403|HTTP|forbidden/i.test(ctx.loadError) && ctx.loadError.includes('登入'), ctx.loadError)
  } finally { console.info = info }
})

test('接線：名單視窗用退避的節奏查啟動設定，不再每 15 秒固定打；開新夥伴查完 CLI 後補選本機', () => {
  const js = fs.readFileSync(new URL('../ui/list.js', import.meta.url), 'utf8')
  assert.ok(js.includes('launchersDelay = nextLaunchersDelay(launchersDelay, err)'))
  assert.ok(js.includes('setTimeout(() => void launchersLoop(), launchersDelay)') && js.includes('void launchersLoop()'))
  assert.ok(!/setInterval\(\(\) => \{ void refreshLaunchers\(\)/.test(js), '舊的固定 15 秒已拿掉')
  assert.match(js, /watch\(launchCtx, \(\) => \{\s*if \(partnerDlg\.open && partnerDlg\.step === 1 && !partnerDlg\.node && !launchDisableReasonFor\(info\.node\)\) pickPartnerDevice\(info\.node\)/)
})
