// 本機看終端：分頁不在畫面上時暫停讀取窗格（term_view_set），切回來先重畫再恢復
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createTermViewSession } from '../ui/lib/term-view.mjs'

const read = (...p) => fs.readFileSync(new URL(['..', ...p].join('/'), import.meta.url), 'utf8')

test('前端 API：pause 對應到 term_view_set，帶觀看編號與旗標', () => {
  const src = read('ui', 'lib', 'tauri.mjs')
  assert.match(src, /pause: \(viewId, paused\) => invoke\('term_view_set', \{ viewId, paused: !!paused \}\)/)
})

test('工作階段：開好後把觀看編號交給 onOpened（隱藏中開好的要補送暫停）', async () => {
  const opened = []
  const s = createTermViewSession({
    open: async () => 5,
    close: async () => {},
    listen: async () => () => {},
    createTerm: async () => ({ resize() {}, write() {}, dispose() {} }),
    onOpened: id => opened.push(id),
  })
  await s.start()
  assert.deepEqual(opened, [5])
  assert.equal(s.viewId(), 5)
  s.stop()
})

test('接線：keep 離開分頁先請後台暫停；切回來先重畫再恢復；舊版後台失敗要吞掉', () => {
  const src = read('ui', 'lib', 'term-view.mjs')
  assert.match(src, /if \(!a\) \{ hidden = true; sendPause\(session\?\.viewId\(\), true\); return \}/, '離開分頁：暫停')
  assert.match(src, /refit\(\)\.then\(\(\) => \{ if \(props\.active && !hidden\) sendPause\(session\?\.viewId\(\), false\) \}\)/, '切回來：先 refit、再恢復')
  assert.match(src, /onOpened: id => \{ if \(hidden\) sendPause\(id, true\) \}/, '隱藏中才開好的，開好就暫停')
  assert.match(src, /Promise\.resolve\(r\)\.catch\(/, '後台沒有這個指令（舊版）時失敗要吞掉')
  assert.match(src, /try \{ r = props\.api\.pause\(viewId, paused\) \} catch \(e\) \{ r = Promise\.reject\(e\) \}/, '同步丟錯也吞掉')
  assert.match(src, /if \(!props\.keep\) return\s*\r?\n\s*if \(!a\)/, '只有 keep（電腦版）才暫停；手機不受影響')
})

test('Rust：暫停旗標、指令、註冊、迴圈裡的判斷都在（本機不能編譯，靠這個守門與 CI）', () => {
  const view = read('src-tauri', 'src', 'launch', 'term_view.rs')
  const lib = read('src-tauri', 'src', 'lib.rs')
  assert.match(view, /pub paused: AtomicBool,/)
  assert.match(view, /if state\.paused\.load\(Ordering::SeqCst\) \{\s*\r?\n\s*last = None;\s*\r?\n\s*port\.sleep\(Duration::from_millis\(HIDDEN_MS\)\);\s*\n\s*continue;/, '暫停：不讀、清掉上一幅、睡一下')
  assert.match(lib, /#\[cfg\(feature = "gui"\)\]\r?\n#\[cfg\(desktop\)\]\r?\n#\[tauri::command\]\r?\nfn term_view_set\(views: State<'_, Arc<TermViews>>, view_id: u64, paused: bool\)/, '只在電腦版')
  assert.match(lib, /term_view_history, term_view_set, device_known_list/, '指令要註冊')
  assert.match(lib, /st\.paused\.store\(paused, std::sync::atomic::Ordering::SeqCst\)/)
})
