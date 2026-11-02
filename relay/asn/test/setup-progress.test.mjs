// 安裝並登入的常駐進度小窗（todo-next-174 的 E1，#650）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { TITLE, CANCEL_HINT, FIRST_LINE, applyEvent, canCancel, initialView, requestCancel, statusLines } from '../ui/lib/setup-progress.mjs'

const read = f => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')

test('一開始寫「正在準備」，可取消；開場事件不當成進度行', () => {
  let v = initialView()
  assert.equal(v.title, TITLE.working)
  assert.deepEqual(statusLines(v), [FIRST_LINE])
  assert.ok(canCancel(v))
  v = applyEvent(v, { phase: 'starting', text: '正在依你手機的要求安裝並登入 Claude Code' })
  assert.deepEqual(statusLines(v), [FIRST_LINE])
  v = applyEvent(v, { phase: 'installing', text: '正在下載' })
  assert.deepEqual(statusLines(v), ['正在下載'])
})

test('結果：成功、失敗、已取消各一個標題；結果出來後晚到的進度不蓋掉；重裝說明放在備註', () => {
  let v = applyEvent(initialView(), { phase: 'done', ok: true, text: '完成', replaced: '這次是因為原本的 Claude Code 跑不起來才重新安裝的' })
  assert.equal(v.title, TITLE.ok)
  assert.equal(v.done, true)
  assert.deepEqual(statusLines(v), ['完成', '這次是因為原本的 Claude Code 跑不起來才重新安裝的'])
  assert.equal(applyEvent(v, { phase: 'installing', text: '晚到' }).line, '完成')
  assert.equal(applyEvent(initialView(), { phase: 'done', ok: false, text: 'x' }).title, TITLE.failed)
  assert.equal(applyEvent(initialView(), { phase: 'done', ok: false, cancelled: true, text: 'x' }).title, TITLE.cancelled)
  assert.equal(canCancel(v), false)
})

test('取消：只記下要求，畫面照實說「這一步做完才停」；只能按一次；做完後不再改', () => {
  const v = requestCancel(initialView())
  assert.equal(canCancel(v), false)
  assert.ok(statusLines(v).includes(CANCEL_HINT))
  const d = applyEvent(v, { phase: 'done', ok: false, cancelled: true, text: '已取消' })
  assert.ok(!statusLines(d).includes(CANCEL_HINT))
  assert.equal(requestCancel(d), d)
})

test('壞輸入不會炸，控制字元被清掉', () => {
  const v = initialView()
  for (const e of [null, undefined, 5, 'x']) assert.deepEqual(applyEvent(v, e), v)
  assert.equal(applyEvent(v, { phase: 'x', text: 'a\u0000b\nc' }).line, 'a b c')
})

test('接線守門：小窗頁聽兩種事件、先要快照、取消走既有指令；Rust 端不搶焦點不進工作列、結束會關', () => {
  const js = read('ui/setup-progress.js'), html = read('ui/setup-progress.html')
  assert.match(js, /invoke\('setup_progress_snapshot'\)/)
  assert.match(js, /listen\('agent-setup', apply\)/)
  assert.match(js, /listen\('agent-setup-remote', apply\)/)
  assert.match(js, /invoke\('agent_setup_cancel'\)/)
  assert.match(html, /@click="cancel"/)
  const wins = read('src-tauri/src/wins.rs'), lib = read('src-tauri/src/lib.rs')
  // 只看小窗那個函式（提示視窗也有同樣的設定，不能被它們蓋過去）
  const open = wins.slice(wins.indexOf('pub fn open_setup_progress'), wins.indexOf('pub fn close_setup_progress'))
  assert.ok(open.length > 100)
  for (const k of ['.focusable(false)', '.focused(false)', '.skip_taskbar(true)', '.always_on_top(true)']) assert.ok(open.includes(k), k)
  assert.match(lib, /wins::open_setup_progress\(&handle\)/)
  assert.match(lib, /wins::close_setup_progress\(&handle\)/)
  assert.match(lib, /wins::setup_progress_snapshot/)
  assert.match(read('scripts/smoke-lib.mjs'), /setup-progress\.html/)
  // 畫面文字是人話：不出現檔名、網址、授權碼
  assert.doesNotMatch(read('ui/lib/setup-progress.mjs'), /claude\.exe|https?:\/\//)
})
