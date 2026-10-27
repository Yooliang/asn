// 主視窗的記錄寫進檔案（#339 收尾）：[ASN] 開頭的 console 記錄整批送給 Rust 的 ui_log 指令
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { UI_LOG_BUFFER_MAX, UI_LOG_LINE_MAX, formatUiLogLine, installUiLog, isAsnLog } from '../ui/lib/ui-log.mjs'

const T = new Date('2026-10-28T01:00:00Z')
function fake({ fail = false } = {}) {
  const printed = [], sent = [], timers = []
  const target = { info: (...a) => printed.push(['info', ...a]), warn: (...a) => printed.push(['warn', ...a]), error: (...a) => printed.push(['error', ...a]) }
  const invoke = async (cmd, args) => { if (fail) throw new Error('寫不進去'); sent.push([cmd, args.lines]) }
  const log = installUiLog({ invoke, target, setTimer: fn => { timers.push(fn); return timers.length }, now: () => T })
  return { target, printed, sent, timers, log }
}

test('只收 [ASN] 開頭的記錄；照常印到 console；幾秒後整批送一次', async () => {
  const f = fake()
  f.target.info('[ASN]', 'pull failed (poll): inbox HTTP 503')
  f.target.warn('[ASN] 查電腦設定失敗', new Error('HTTP 403'))
  f.target.info('別的程式庫的記錄')
  assert.equal(f.printed.length, 3, '全部照常印出')
  assert.equal(f.timers.length, 1, '同一批只排一次計時')
  await f.timers[0]()
  assert.deepEqual(f.sent, [['ui_log', [
    '2026-10-28T01:00:00.000Z info [ASN] pull failed (poll): inbox HTTP 503',
    '2026-10-28T01:00:00.000Z warn [ASN] 查電腦設定失敗 HTTP 403',
  ]]])
  assert.equal(f.log.pending(), 0)
})

test('一行限長、換行換成空白；寫檔失敗就丟掉這批，不重試也不再印記錄；佇列有上限', async () => {
  const line = formatUiLogLine('info', ['[ASN]', 'a\nb\tc', 'x'.repeat(UI_LOG_LINE_MAX)], T)
  assert.ok(!/[\n\t]/.test(line) && line.length === UI_LOG_LINE_MAX)
  assert.equal(isAsnLog(['[ASN] x']), true); assert.equal(isAsnLog([{}]), false); assert.equal(isAsnLog([]), false)
  const f = fake({ fail: true })
  for (let i = 0; i < UI_LOG_BUFFER_MAX + 20; i++) f.target.info(`[ASN] m${i}`)
  assert.equal(f.log.pending(), UI_LOG_BUFFER_MAX, '只留最新的')
  const printedBefore = f.printed.length
  await f.timers[0]()
  assert.equal(f.log.pending(), 0)
  assert.equal(f.printed.length, printedBefore, '失敗時不再印記錄（不會繞圈）')
})

test('接線：主視窗在 import 之後馬上裝；Rust 有註冊 ui_log、寫在機器資料夾', () => {
  const js = fs.readFileSync(new URL('../ui/list.js', import.meta.url), 'utf8')
  assert.match(js, /import \{ installUiLog \} from '\.\/lib\/ui-log\.mjs'/)
  assert.match(js, /\ninstallUiLog\(\{ invoke \}\)/)
  const rs = fs.readFileSync(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8')
  assert.match(rs, /fn ui_log\(app: State<'_, App>, lines: Vec<String>\)[^{]*\{\s*ui_log::append\(&app\.work_dir, &lines\)/)
  assert.match(rs, /relay_log_paths, ui_log, open_machine_log_dir/)
})
