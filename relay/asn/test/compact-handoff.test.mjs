// 視窗壓縮 N 次自動交接（#1852）：工作管理員「壓縮次數」欄、「交接」鈕、交接中不能停止、設定頁的開關與次數、各處接線。
// 壓縮次數的數法、額度門檻、不重複觸發的守門測試在 Rust（bridge/compact/tests.rs、partner_ops/tests/compact.rs）。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { SETTING_OPS } from '../ui/lib/settings-panel.mjs'
import { COMPACT_N_DEFAULT, COMPACT_N_MAX, COMPACT_N_MIN, clampCompactN } from '../ui/lib/compact-handoff.mjs'
import { COLUMNS, DASH, TEXT, compactCell, createTaskManager, stopPlan, stopRequest, viewRow } from '../ui/lib/task-manager.mjs'
import { noticeCategory } from '../ui/lib/notice.mjs'

const read = f => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const readRepo = f => fs.readFileSync(new URL(`../../../${f}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const NOW = 1_800_000_000_000
const SELF = 'P'
const row = (o = {}) => ({ kind: 'claude', name: '小悠', engine: 'claude', pid: 100, memory_bytes: 1 << 29, started_ms: NOW - 3600_000, status: 'busy', by_asn: true, cwd: 'G:/work', live: true, session_id: 'sid-1', ...o })
const friend = (o = {}) => ({ node: SELF, agent: '小悠', engine: 'claude', status: 'idle', ...o })
const OPS_OK = { signedIn: true, loaded: true, checking: false, machines: { [SELF]: { online: true, launcher: { profiles: [] } } } }
const ctx = (friends = [friend()]) => ({ friends, selfNode: SELF, ops: OPS_OK, asn: {} })

test('次數夾在 2～10，缺值或不是數字用 3（和 Rust 同一個範圍）', () => {
  assert.deepEqual([COMPACT_N_MIN, COMPACT_N_MAX, COMPACT_N_DEFAULT], [2, 10, 3])
  assert.equal(clampCompactN(1), 2)
  assert.equal(clampCompactN(99), 10)
  assert.equal(clampCompactN('5'), 5)
  assert.equal(clampCompactN(4.6), 5)
  assert.equal(clampCompactN(undefined), 3)
  assert.equal(clampCompactN(NaN, 7), 7, '不是數字就維持原本的值')
  assert.equal(clampCompactN('', 7), 7)
  assert.equal(clampCompactN(null, 'x'), 3)
  const rs = read('src-tauri/src/bridge/compact.rs')
  assert.match(rs, /N_MIN: u32 = 2;/)
  assert.match(rs, /N_MAX: u32 = 10;/)
  assert.match(rs, /N_DEFAULT: u32 = 3;/)
})

test('壓縮次數欄：位置在「狀態」之後、「運行位置」之前', () => {
  assert.deepEqual(COLUMNS, ['名字', '引擎', '程序編號', '記憶體', '開了多久', '狀態', '壓縮次數', '運行位置', '操作'])
})

test('壓縮次數欄：0 次、N 次、交接中、請交接；沒資料與非 Claude 是「—」', () => {
  assert.deepEqual(compactCell(row({ compact: { count: 0, state: 'count' } })), { text: '0 次', tag: '', state: '' })
  assert.deepEqual(compactCell(row({ compact: { count: 2, state: 'count' } })), { text: '2 次', tag: '', state: '' })
  assert.deepEqual(compactCell(row({ compact: { count: 3, state: 'handing' } })), { text: '3 次', tag: '交接中', state: 'handing' })
  assert.deepEqual(compactCell(row({ compact: { count: 4, state: 'remind' } })), { text: '4 次', tag: '請交接', state: 'remind' })
  assert.equal(compactCell(row({ compact: null })).text, DASH, '還沒數過')
  assert.equal(compactCell(row({ compact: { count: -1, state: 'count' } })).text, DASH)
  assert.equal(compactCell(row({ kind: 'pi', engine: 'pi', compact: { count: 3, state: 'count' } })).text, DASH, '只做 Claude 視窗')
  assert.equal(compactCell(row({ kind: 'asn', compact: { count: 3, state: 'count' } })).text, DASH)
})

test('原因小字拿掉了（11-20 擁有者改設計）：欄位只有次數與標籤，原因只寫在通知信', () => {
  const v = viewRow(row({ compact: { count: 3, state: 'remind' } }), NOW, ctx())
  assert.deepEqual(Object.keys(v).filter(k => k.startsWith('cmp')).sort(), ['cmpState', 'cmpTag', 'cmpText'])
  const banned = /cmp-note|額度不夠，只提醒|讀不到額度，只提醒|額度夠，正在/
  for (const f of [read('ui/lib/settings-panel.mjs'), read('ui/lib/task-manager.mjs'), read('ui/style.css'), readRepo('docs/design/1852-compact-handoff/tasks.html'), readRepo('docs/design/1852-compact-handoff/draft.css')]) assert.ok(!banned.test(f))
})

test('「交接」鈕只在「請交接」的列；交接中的列不能停止（沒有停止鈕、停止請求為空）', () => {
  const remind = viewRow(row({ compact: { count: 3, state: 'remind' } }), NOW, ctx())
  assert.equal(remind.canHandover, true)
  assert.equal(remind.canStop, true, '請交接的列照樣可以停止')
  const plain = viewRow(row({ compact: { count: 2, state: 'count' } }), NOW, ctx())
  assert.equal(plain.canHandover, false)
  const going = row({ compact: { count: 3, state: 'handing' } })
  const v = viewRow(going, NOW, ctx())
  assert.equal(v.canHandover, false)
  assert.equal(v.handing, true)
  assert.equal(v.canStop, false)
  assert.equal(v.why, TEXT.handingWhy)
  assert.equal(v.why, '交接完成前不能停止')
  assert.equal(v.viewOnly, false, '不是「只能看」，是暫時不能停止')
  assert.equal(stopPlan(going, ctx()).ok, false)
  assert.equal(stopRequest(going, ctx()), null)
  assert.equal(stopPlan(row({ compact: { count: 0, state: 'count' } }), ctx()).ok, true, '交接結束後新視窗照舊可以停止')
})

test('交接中的列不顯示「只能看」（只顯示原因）；真正只能看的列才顯示', () => {
  const going = viewRow(row({ compact: { count: 3, state: 'handing' } }), NOW, ctx())
  assert.equal(going.showViewOnly, false, '交接中：沒有停止鈕，也不能寫「只能看」')
  assert.equal(going.why, '交接完成前不能停止')
  const own = viewRow(row({ by_asn: false }), NOW, ctx())
  assert.equal(own.viewOnly, true)
  assert.equal(own.showViewOnly, true, '真正只能看的列照舊顯示')
  assert.equal(viewRow(row({ compact: { count: 3, state: 'remind' } }), NOW, ctx()).showViewOnly, false, '有停止鈕的列不顯示')
  // 範本只讀 showViewOnly，不能退回「沒鈕就 v-else 顯示只能看」
  const panel = read('ui/lib/settings-panel.mjs')
  assert.match(panel, /<small class="tm-viewonly" v-else-if="r\.showViewOnly"/)
  assert.ok(!/<small class="tm-viewonly" v-else /.test(panel))
})

test('控制器：交接中的列按停止不會開確認框；按「交接」只送視窗名', async () => {
  const sent = []
  const snap = { rows: [row({ compact: { count: 3, state: 'handing' } }), row({ pid: 101, name: '西川', session_id: 'sid-2', compact: { count: 3, state: 'remind' } })], known: [] }
  const tm = createTaskManager({
    api: { taskManagerList: async () => snap, compactHandoffRequest: async n => { sent.push(n) } },
    getFriends: () => [friend(), friend({ agent: '西川' })], getSelfNode: () => SELF, getOpsCtx: () => OPS_OK, now: () => NOW,
    setTimer: () => 0, clearTimer: () => {}, log: () => {},
  })
  tm.open(); await tm.refresh()
  const rows = tm.view().rows
  tm.ask(rows[0].key)
  assert.equal(tm.state.confirm, null, '交接中不能停止')
  await tm.handover('西川')
  assert.deepEqual(sent, ['西川'])
  assert.equal(tm.state.note, TEXT.handoverAsked)
  tm.close()
})

test('設定頁：開關與次數放在「電腦重開後自動接回夥伴」之後、「夥伴共用同一個終端服務」之前，文字照設計稿', () => {
  const panel = read('ui/lib/settings-panel.mjs')
  const a = panel.indexOf('aria-label="電腦重開後自動接回夥伴"')
  const c = panel.indexOf('aria-label="壓縮自動交接"')
  const t = panel.indexOf('aria-label="夥伴共用同一個終端服務"')
  assert.ok(a > 0 && c > a && t > c)
  assert.match(panel, /<span>壓縮<\/span><input class="set-input num" type="number" min="2" max="10"/)
  assert.match(panel, /<span>次自動交接<\/span>/)
  assert.match(panel, /Claude 視窗壓縮到這個次數時，額度夠就自動交給新視窗。取消勾選就只寄信提醒，不會自動交接。/)
  for (const op of ['bridge-compact', 'bridge-compact-n', 'tm-handover']) assert.ok(SETTING_OPS.includes(op), op)
  assert.match(panel, /act\('bridge-compact', \$event\.target\.checked\)/)
  assert.match(panel, /act\('bridge-compact-n', Number\(\$event\.target\.value\)\)/)
})

test('接線：list.js、tauri 指令、Rust 設定與預設（缺欄位＝開、次數 3）', () => {
  const list = read('ui/list.js'), lib = read('src-tauri/src/lib.rs'), mod = read('src-tauri/src/bridge/mod.rs')
  assert.match(list, /case 'bridge-compact': await setBridgeCompact\(value === true, bridge\.compactN\)/)
  assert.match(list, /case 'bridge-compact-n': await setBridgeCompact\(bridge\.compactHandoff, value\)/)
  assert.match(list, /case 'tm-handover': await taskMgr\.handover\(/)
  assert.match(list, /compactHandoff: s\.compact_handoff !== false/, '預設開：舊後端沒有這個欄位也顯示開著')
  assert.match(list, /bridgeApi\.setCompactHandoff\(on, clampCompactN\(n, bridge\.compactN\)\)/)
  assert.match(read('ui/lib/tauri.mjs'), /setCompactHandoff: \(on, n\) => invoke\('bridge_set_compact_handoff', \{ on, n \}\)/)
  assert.match(read('ui/lib/tauri.mjs'), /compactHandoffRequest: name => invoke\('compact_handoff_request', \{ name \}\)/)
  const desktop = lib.slice(lib.indexOf('.invoke_handler('), lib.lastIndexOf('.invoke_handler('))
  assert.match(desktop, /[\s,]bridge_set_compact_handoff[\s,]/)
  assert.match(desktop, /[\s,]compact_handoff_request[\s,]/)
  assert.match(mod, /compact_handoff_off: d\.compact_handoff_off/, '記「關」：缺欄位＝開（逐欄容錯在 settings/docs.rs 的 BridgeDoc）')
  assert.match(read('src-tauri/src/settings/docs.rs'), /deserialize_with = "lenient"\)\]\s*pub compact_handoff_off: bool/, '逐欄容錯（型別不對＝預設，缺欄位＝開）：lenient 要在這個欄位上')
  assert.match(mod, /compact_handoff_n: compact::clamp_n\(/)
  assert.match(read('src-tauri/src/launch/taskmgr.rs'), /r\["compact"\] = crate::bridge::compact::row_json/)
})

test('通知：compact 主題歸在「卡住」一類', () => {
  assert.equal(noticeCategory('notice:compact'), 'stuck')
})

test('三種外觀都有樣式：標籤、窄版欄位、次數輸入', () => {
  const css = read('ui/style.css')
  assert.match(css, /\.tm-tag\.cmp-warn\{/)
  assert.match(css, /\.tm-tag\.cmp-go\{/)
  assert.match(css, /\.chk-num\{/)
  assert.match(css, /\.tm-table th:nth-child\(8\),\.tm-table td:nth-child\(8\)\{display:none\}\.tm-table td\.cmp\{min-width:110px\}/, '窄版收掉引擎、程序編號、記憶體、開了多久與運行位置')
})
