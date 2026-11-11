// 電腦版看終端：離開分頁後的寬限（term-grace.mjs）與它在畫面裡的接法
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { GRACE_AGAIN_LABEL, GRACE_ENDED_TEXT, TERM_GRACE_MS, TYPING_ENDED_TEXT, createGrace } from '../ui/lib/term-grace.mjs'
import { remoteBarState } from '../ui/lib/term-remote.mjs'

const read = p => fs.readFileSync(new URL(p, import.meta.url), 'utf8')

// 假的時間與計時器：手動往前撥
function fakeClock() {
  let t = 1_000, nextId = 1
  const timers = new Map()
  return {
    now: () => t,
    set: (fn, ms) => { const id = nextId++; timers.set(id, { at: t + ms, fn }); return id },
    clear: id => { timers.delete(id) },
    advance(ms, { fire = true } = {}) {
      t += ms
      if (!fire) return
      for (const [id, x] of [...timers]) if (x.at <= t) { timers.delete(id); x.fn() }
    },
    pending: () => timers.size,
  }
}

test('寬限是 5 分鐘，文字固定', () => {
  assert.equal(TERM_GRACE_MS, 300_000)
  assert.match(TYPING_ENDED_TEXT, /^已結束打字/)
  assert.equal(GRACE_ENDED_TEXT, '已結束觀看（離開超過 5 分鐘）')
  assert.equal(GRACE_AGAIN_LABEL, '重新看')
})

test('寬限內切回來：不結束、回 kept', () => {
  const c = fakeClock(); let ended = 0
  const g = createGrace({ now: c.now, set: c.set, clear: c.clear, onExpire: () => { ended++ } })
  g.leave()
  c.advance(TERM_GRACE_MS - 1)
  assert.equal(ended, 0)
  assert.equal(g.back(), 'kept')
  assert.equal(ended, 0)
  assert.equal(c.pending(), 0, '切回來就收掉計時')
})

test('超過寬限：到期的那一刻就結束，不等切回來', () => {
  const c = fakeClock(); let ended = 0
  const g = createGrace({ now: c.now, set: c.set, clear: c.clear, onExpire: () => { ended++ } })
  g.leave()
  c.advance(TERM_GRACE_MS)
  assert.equal(ended, 1, '第 5 分鐘到的當下就呼叫')
  c.advance(10 * 60_000)
  assert.equal(ended, 1, '同一段離開只結束一次')
  assert.equal(g.back(), 'expired')
  assert.equal(ended, 1)
})

test('計時器被節流沒觸發：切回來時看時間補結束', () => {
  const c = fakeClock(); let ended = 0
  const g = createGrace({ now: c.now, set: c.set, clear: c.clear, onExpire: () => { ended++ } })
  g.leave()
  c.advance(TERM_GRACE_MS + 5, { fire: false })
  assert.equal(ended, 0)
  assert.equal(g.back(), 'expired')
  assert.equal(ended, 1)
})

test('重複離開不重新計時；沒離開就切回來回 none；cancel 收掉', () => {
  const c = fakeClock(); let ended = 0
  const g = createGrace({ now: c.now, set: c.set, clear: c.clear, onExpire: () => { ended++ } })
  assert.equal(g.back(), 'none')
  g.leave(); c.advance(200_000); g.leave()
  c.advance(100_000)
  assert.equal(ended, 1, '第二次 leave 沒有把起點往後挪')
  g.back()
  g.leave(); g.cancel()
  assert.equal(c.pending(), 0)
  c.advance(TERM_GRACE_MS * 2)
  assert.equal(ended, 1)
  assert.equal(g.away(), false)
})

test('預設的計時器每次呼叫時才去拿全域的 setTimeout（探測可以事後換掉）', () => {
  const real = globalThis.setTimeout
  const seen = []
  globalThis.setTimeout = (fn, ms) => { seen.push(ms); return real(() => {}, 0) }
  try {
    const g = createGrace({ onExpire() {} })
    g.leave(); g.cancel()
  } finally { globalThis.setTimeout = real }
  assert.deepEqual(seen, [TERM_GRACE_MS])
})

test('狀態列：結束的說明是 warn；離開超過寬限的那一條帶「重新看」', () => {
  assert.deepEqual(remoteBarState({ phase: 'ended', soon: false, note: GRACE_ENDED_TEXT, warn: '', main: { waiting: '', active: '' }, danger: false }), { text: GRACE_ENDED_TEXT, level: 'warn' })
})

test('接線：只有電腦版（viewActive 沒給）走寬限，手機照舊離開就結束', () => {
  const pane = read('../ui/lib/chatpane.mjs')
  assert.match(pane, /if \(props\.viewActive !== null\) \{ if \(!a\) remoteOn\.value = false; return \}/, '手機：離開分頁就結束觀看')
  assert.match(pane, /if \(remoteTyping\.value\) \{ typingEndedNote\.value = TYPING_ENDED_TEXT; remoteTyping\.value = false \} else if \(remoteShown\.value\) graceView\.leave\(\)/, '打字中離開馬上結束打字並留「已結束打字」，只看才開寬限')
  assert.match(pane, /:ended-note="typingEndedNote"/, '切回來停在已結束，不自動重新發起')
  assert.match(pane, /graceView\.back\(\) === 'kept'\) nextTick\(\(\) => rvEl\.value\?\.refit\?\.\(\)\)/, '寬限內切回來重畫一次')
  assert.match(pane, /<remote-view v-if="remoteShown && !typingShown" ref="rvEl"/)
  assert.match(pane, /<term-view v-if="termShown"[^>]*:keep="viewActive === null"/, '本機終端只有電腦版保留')
  assert.match(pane, /remoteBar\.restartable[^>]*>[\s\S]*?GRACE_AGAIN_LABEL/, '狀態列有「重新看」')
  assert.match(pane, /watch\(remoteShown, on => \{ if \(!on\) \{ remoteBar\.value = null; typingEndedNote\.value = ''; graceView\.cancel\(\) \} \}\)/, '觀看收掉時狀態列與計時一起清')
})

test('接線：RemoteView 到期當下 stop 並結束，重新看走原本的發起', () => {
  const src = read('../ui/lib/term-remote.mjs')
  assert.match(src, /const expire = \(\) => \{\s*if \(phase\.value === 'ended'\) return\s*gen\+\+; stop\(\); finish\(GRACE_ENDED_TEXT\); expired\.value = true/, '作廢發起中的、stop、寫下結束說明')
  assert.match(src, /restartable: expired\.value/, '狀態列拿到可重新開始的旗標')
  assert.match(src, /expired\.value = false\s*\n?\s*try \{/, '重新開始時清掉旗標')
  assert.match(src, /return \{ host, phase, note, soon, again: start, expire, refit,/)
  assert.match(src, /onMounted\(\(\) => \{ if \(props\.active && !props\.endedNote\) void start\(\) \}\)/, '帶著已結束說明掛上時不發起')
  assert.doesNotMatch(src, /gen === 0 && alive/, '不再在變成可見時自動發起')
})

test('接線：TermView 的 keep 不因分頁離開而停止或關閉，切回來重畫', () => {
  const src = read('../ui/lib/term-view.mjs')
  assert.match(src, /keep: \{ type: Boolean, default: false \}/)
  assert.match(src, /props\.keep \? true : props\.active/, 'keep 時分頁狀態不進重開的條件')
  assert.match(src, /if \(props\.keep \|\| props\.active\) start\(\); else stop\(\)/)
  assert.match(src, /watch\(\(\) => props\.active, a => \{\s*\r?\n\s*if \(!props\.keep\) return/, '分頁在不在畫面上只有 keep 才管（暫停讀取另見 term-view-pause.test.mjs）')
  assert.match(src, /onMounted\(\(\) => \{ if \(props\.active \|\| props\.keep\) start\(\) \}\)/)
})
