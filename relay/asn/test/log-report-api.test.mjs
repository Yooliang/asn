// #2129 ②：送記錄給開發者的前端出口。指令名與參數形狀釘住；Rust 端兩個指令電腦與手機都要註冊；收件處設定值留空且清單有登記
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { makeLogReportApi } from '../ui/lib/tauri.mjs'

const read = p => fs.readFileSync(new URL(p, import.meta.url), 'utf8')

test('logReportApi：指令名與參數形狀', async () => {
  const calls = []
  const api = makeLogReportApi((cmd, args) => { calls.push([cmd, args]); return Promise.resolve(null) })
  await api.preview('1h')
  await api.send('7d')
  await api.preview()
  assert.deepEqual(calls, [
    ['log_report_preview', { range: '1h' }],
    ['log_report_send', { range: '7d' }],
    ['log_report_preview', { range: undefined }],
  ])
})

test('Rust 端：兩個指令在電腦與手機的 handler 清單都註冊，指令與模組都不限電腦版', () => {
  const lib = read('../src-tauri/src/lib.rs')
  const handlers = [...lib.matchAll(/generate_handler!\[([\s\S]*?)\]\)/g)].map(m => m[1])
  assert.equal(handlers.length, 2, '電腦與手機各一份 handler 清單')
  for (const h of handlers) {
    const names = h.split(',').map(s => s.trim())
    for (const c of ['log_report_preview', 'log_report_send']) assert.ok(names.includes(c), `handler 清單沒有 ${c}`)
  }
  for (const re of [/((?:#\[[^\n]*\]\r?\n)*)fn log_report_preview\(/, /((?:#\[[^\n]*\]\r?\n)*)async fn log_report_send\(/, /((?:#\[[^\n]*\]\r?\n)*)mod log_report;/]) {
    const m = re.exec(lib)
    assert.ok(m, `找不到 ${re}`)
    assert.doesNotMatch(m[1], /cfg\(desktop\)/, '不可以只在電腦版')
  }
})

test('收件處設定值留空，而且設定值清單有登記', () => {
  const src = read('../src-tauri/src/log_report.rs')
  assert.match(src, /pub const RECIPIENT_ROOM: &str = "";/, '群組建好前收件處要留空（填了要同時更新這個測試與設定值清單）')
  const doc = fs.readFileSync(new URL('../../../docs/設定值清單.md', import.meta.url), 'utf8')
  assert.ok(doc.includes('`flag.LOG_REPORT_ROOM`') && doc.includes('RECIPIENT_ROOM'), '設定值清單缺收件處')
})

test('寄出指令先擋收件處，才取連線與憑證（沒設定時不碰網路）', () => {
  const lib = read('../src-tauri/src/lib.rs')
  const body = lib.slice(lib.indexOf('async fn log_report_send('))
  const i = body.indexOf('check_recipient(log_report::RECIPIENT_ROOM)')
  assert.ok(i > 0, 'log_report_send 沒有先檢查收件處')
  assert.ok(i < body.indexOf('relay_of('), '檢查收件處要在 relay_of 之前')
  assert.ok(i < body.indexOf('signing_token('), '檢查收件處要在取憑證之前')
})
