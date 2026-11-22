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
  'askpass.js': 2,
  'lib/account-roster.mjs': 2,
  'lib/agent-install.mjs': 6,
  'lib/claude-accounts.mjs': 24,
  'lib/device-rename.mjs': 2,
  'lib/groups.mjs': 1,
  'lib/login-panel.mjs': 1,
  'lib/mobile-login-seal.mjs': 1,
  'lib/mobile-remote-view.mjs': 5,
  'lib/quota-readers.mjs': 6,
  'lib/relogin-flow.mjs': 3,
  'lib/term-chat.mjs': 2,
  'lib/ui-log.mjs': 1,
  'lib/usage.mjs': 1,
  'lib/view-log.mjs': 2,
  'list.js': 97,
  'login.js': 6,
  'm.js': 49,
  'onboard.js': 6,
  'setup-progress.js': 2,
  'shot.js': 5,
  'toast.js': 2,
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
