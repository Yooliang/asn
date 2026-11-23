// #1860 H PR-2：新設備「是不是取代舊的」卡片（電腦與手機共用）。
// 輸入用後台真實回傳的形狀（tests/device_replace_sql.test.mjs 實跑的 asn_device_replace_candidates 輸出：
// { cards: [{ node, name, platform, created_at, candidates: [{ node, name, last_seen }] }] }）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { REPLACE_TEXT, createReplaceFlow, lastSeenText, newReplaceState, replaceCardsView, replaceDoneNote, syncAfterReplace } from '../ui/lib/device-replace.mjs'
import { createDeviceSync } from '../ui/lib/device-sync.mjs'
import { NOTICE_CAT_LABEL, noticeCategory, noticeGoOf, noticeRows } from '../ui/lib/notice.mjs'

const UI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'ui')
const src = f => fs.readFileSync(path.join(UI, f), 'utf8')
const NOW = Date.parse('2026-11-24T12:00:00Z')
const day = n => new Date(NOW - n * 86400000).toISOString()
const NEW_NODE = 'nodeNEW-aaaa-0001', OLD1 = 'nodeOLD-bbbb-0002', OLD2 = 'nodeOLD-cccc-0003'

// 後台真實形狀（候選依最後上線新到舊）
const REAL = () => ({ cards: [{ node: NEW_NODE, name: '電腦（X7K2）', platform: 'windows', created_at: day(0), candidates: [{ node: OLD1, name: '40家用', last_seen: day(3) }, { node: OLD2, name: '舊筆電', last_seen: day(70) }] }] })

test('#1860H 卡片 view：標題、說明、候選列、按鈕、選中說明（後台真實形狀）', () => {
  const [c] = replaceCardsView(REAL(), { now: NOW })
  assert.equal(c.title, '有一台新的電腦連上了')
  assert.equal(c.intro, '「電腦（X7K2）」是第一次連上。它是用來取代哪一台嗎？')
  assert.deepEqual(c.candidates.map(x => [x.label, x.line]), [['40家用', '離線中 · 最後在線 3 天前'], ['舊筆電', '離線中 · 最後在線 2 個月前']])
  assert.equal(c.sel, OLD1, '預設選第一個')
  assert.equal(c.keepLabel, '不是，兩台都留')
  assert.equal(c.replaceLabel, '取代 40家用')
  assert.equal(c.explain, '取代後，40家用 會移到「已移除的設備」，可以恢復；新的這台沿用「40家用」這個名字。')
  const [c2] = replaceCardsView(REAL(), { now: NOW, pick: { [NEW_NODE]: OLD2 } })
  assert.equal(c2.replaceLabel, '取代 舊筆電', '選別的候選，按鈕與說明跟著換')
  assert.match(c2.explain, /取代後，舊筆電 會移到/)
  assert.equal(replaceCardsView(REAL(), { now: NOW, pick: { [NEW_NODE]: 'not-a-candidate' } })[0].sel, OLD1, '選的不在候選裡就退回第一個')
})

test('#1860H 手機平台標題寫「手機」', () => {
  const raw = REAL(); raw.cards[0].platform = 'android'
  assert.equal(replaceCardsView(raw, { now: NOW })[0].title, '有一台新的手機連上了')
})

test('#1860H 沒卡、沒候選、壞資料都不出卡', () => {
  assert.deepEqual(replaceCardsView({ cards: [] }, { now: NOW }), [])
  assert.deepEqual(replaceCardsView(null), [])
  assert.deepEqual(replaceCardsView({ cards: [{ node: NEW_NODE, name: 'x', platform: 'windows', candidates: [] }] }), [])
  assert.deepEqual(replaceCardsView({ cards: [{ node: '', name: 'x', candidates: [{ node: OLD1, name: 'a' }] }] }), [])
})

test('#1860H 畫面字串不含節點代號與 email（節點只留在 id／sel 欄位給按鈕回呼用）', () => {
  const [c] = replaceCardsView(REAL(), { now: NOW })
  const shown = JSON.stringify(c, (k, v) => (k === 'id' || k === 'sel' ? undefined : v))
  for (const code of [NEW_NODE, OLD1, OLD2]) assert.ok(!shown.includes(code), `畫面字串不能含 ${code}`)
  assert.ok(!/@/.test(shown))
  // 模板不畫代號：兩個畫面的卡片區塊裡都沒有 {{ …node }}
  for (const f of ['m.html', 'lib/settings-panel.mjs']) {
    const s = src(f); const i = s.indexOf('data-replace'); assert.ok(i > 0, `${f} 有卡片`)
    const block = s.slice(i, s.indexOf('</section>', i))
    assert.doesNotMatch(block, /\{\{\s*[\w.]*\b(node|sel|old)\s*\}\}/, `${f} 卡片不畫代號`)
  }
})

test('#1860H 文案只有一份：畫面檔裡沒有自己寫一次', () => {
  for (const f of ['m.html', 'm.js', 'list.js', 'list.html', 'lib/settings-panel.mjs']) {
    const s = src(f).replace(/<!--[\s\S]*?-->/g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/.*$/gm, '')   // 註解不算
    for (const phrase of ['不是，兩台都留', '第一次連上', '有一台新的', '會移到「已移除的設備」']) assert.ok(!s.includes(phrase), `${f} 不該自己寫「${phrase}」`)
  }
  const s = src('lib/device-replace.mjs')
  assert.equal((s.match(/不是，兩台都留/g) ?? []).length, 1)
})

test('#1860H 相對時間：天、個月、年；沒有最後上線時間只寫離線中', () => {
  assert.equal(lastSeenText(day(3), NOW), '離線中 · 最後在線 3 天前')
  assert.equal(lastSeenText(day(29), NOW), '離線中 · 最後在線 29 天前')
  assert.equal(lastSeenText(day(70), NOW), '離線中 · 最後在線 2 個月前')
  assert.equal(lastSeenText(day(400), NOW), '離線中 · 最後在線 1 年前')
  assert.equal(lastSeenText(null, NOW), '離線中')
})

test('#1860H 取代結果的提示：renamed＝false 改說「保留目前的名字」', () => {
  assert.equal(replaceDoneNote({ already: false, renamed: true }, '40家用'), '已取代：「40家用」移到「已移除的設備」，新的這台沿用這個名字。')
  assert.equal(replaceDoneNote({ already: false, renamed: false }, '40家用'), '已取代：「40家用」移到「已移除的設備」，新的這台保留目前的名字。')
  assert.equal(replaceDoneNote({ already: true, renamed: false }, '40家用'), REPLACE_TEXT.doneAlready)
})

function mkFlow(over = {}) {
  const state = newReplaceState(); const logs = []; const calls = []
  const api = {
    candidates: async () => { calls.push(['candidates']); return over.afterLoad ? over.afterLoad(calls) : REAL() },
    replace: async (n, o) => { calls.push(['replace', n, o]); if (over.replace) return over.replace(n, o); return { ok: true, already: false, renamed: true } },
    dismiss: async n => { calls.push(['dismiss', n]); if (over.dismiss) return over.dismiss(n); return { ok: true } },
  }
  let after = 0
  const flow = createReplaceFlow({ state, api, log: (...a) => logs.push(a.join(' ')), now: () => NOW, afterReplace: async (o, n) => { after++; calls.push(['after', o, n]) } })
  return { state, flow, logs, calls, afters: () => after }
}

test('#1860H 流程：取代成功→通知呼叫端更新設定與名單、重讀卡片、留一句結果', async () => {
  const { state, flow, calls } = mkFlow({ afterLoad: calls => (calls.some(c => c[0] === 'replace') ? { cards: [] } : REAL()) })
  await flow.load()
  assert.equal(flow.view().length, 1)
  assert.equal(await flow.replace(NEW_NODE, OLD1), true)
  assert.deepEqual(calls.map(c => c[0]), ['candidates', 'replace', 'after', 'candidates'])
  assert.deepEqual(calls[1], ['replace', NEW_NODE, OLD1])
  assert.equal(flow.view().length, 0, '取代後重讀，卡片消失')
  assert.match(state.note, /已取代：「40家用」/)
  assert.equal(state.busy, '')
})

test('#1860H 流程：進行中不能連點（只送一次）', async () => {
  let release
  const gate = new Promise(r => { release = r })
  const { flow, calls } = mkFlow({ replace: async () => { await gate; return { ok: true, renamed: true } } })
  await flow.load()
  const a = flow.replace(NEW_NODE, OLD1)
  const b = flow.replace(NEW_NODE, OLD2)
  const c = flow.dismiss(NEW_NODE)
  assert.equal(await b, false); assert.equal(await c, false)
  release(); assert.equal(await a, true)
  assert.equal(calls.filter(x => x[0] === 'replace').length, 1)
  assert.equal(calls.filter(x => x[0] === 'dismiss').length, 0)
})

test('#1860H 流程：失敗顯示白話（Edge 的 message），原文寫 log；沒有訊息就用常數白話；失敗不呼叫更新', async () => {
  const msg = '這台舊設備現在不能被取代（可能剛剛又上線了，或已經處理過）。'
  const a = mkFlow({ replace: async () => { throw new Error(msg) } })
  await a.flow.load()
  assert.equal(await a.flow.replace(NEW_NODE, OLD1), false)
  assert.equal(a.state.error, msg); assert.equal(a.state.busy, ''); assert.equal(a.afters(), 0)
  assert.ok(a.logs.some(l => l.includes('取代沒成功') && l.includes(msg)), '原文寫 log')
  const b = mkFlow({ replace: async () => { throw new Error('') } })
  await b.flow.load(); await b.flow.replace(NEW_NODE, OLD1)
  assert.equal(b.state.error, REPLACE_TEXT.failed)
  const c = mkFlow({ dismiss: async () => { throw '登入過期了，請重新登入後再試' } })
  await c.flow.load(); assert.equal(await c.flow.dismiss(NEW_NODE), false)
  assert.equal(c.state.error, '登入過期了，請重新登入後再試')
})

test('#1860H 流程：讀不到卡片只寫 log，不丟錯、不出卡', async () => {
  const state = newReplaceState(); const logs = []
  const flow = createReplaceFlow({ state, api: { candidates: async () => { throw '要先登入 ASN 帳號才能處理新設備' } }, log: (...a) => logs.push(a.join(' ')) })
  await flow.load()
  assert.deepEqual(flow.view(), []); assert.ok(logs.some(l => l.includes('要先登入')))
})

test('#1860H 不取代＝兩台都留：呼叫 dismiss 並重讀', async () => {
  const { flow, calls, state } = mkFlow()
  await flow.load(); assert.equal(await flow.dismiss(NEW_NODE), true)
  assert.deepEqual(calls.map(c => c[0]), ['candidates', 'dismiss', 'candidates'])
  assert.equal(state.note, REPLACE_TEXT.doneKept)
})

// ---- 本機設定與推送節流（用 device-sync 的真實函式） ----
function realSync(prefs, gets) {
  const timers = []; const sets = []
  const sync = createDeviceSync({
    prefs, now: () => NOW, schedule: (fn, ms) => { timers.push([fn, ms]); return timers.length }, clear: () => {},
    api: { get: async () => ({ prefs: gets.shift() ?? null }), set: async b => { sets.push(b); return { prefs: b, stale: false } } },
  })
  return { sync, timers, sets, getPrefs: () => ({ prefs: gets[0] ?? null }) }
}
const synced = () => ({ deviceOrder: [], deviceShown: [], deviceRemoved: ['x1'], deviceRev: NOW - 60000, deviceSynced: true })
const backendAfterReplace = () => ({ order: [], shown: [], removed: ['x1', OLD1], rev: NOW })   // 後台回寫：舊設備進 removed，rev＝現在毫秒

test('#1860H 取代成功後：本機 removed 立刻有舊節點，且不排任何推送（不撞後台冷卻）', async () => {
  const prefs = synced()
  const { sync, timers, sets, getPrefs } = realSync(prefs, [backendAfterReplace()])
  const refreshed = []
  await syncAfterReplace({ getPrefs, devSync: sync, refreshRoster: async () => { refreshed.push(1) }, log: () => {} })
  assert.deepEqual(prefs.deviceRemoved, ['x1', OLD1])
  assert.equal(prefs.deviceRev, NOW)
  sync.noteLocal()   // 畫面端的變動監看接著會呼叫：採用後台的版本不是本機改動
  assert.equal(timers.length, 0, '沒有排推送')
  assert.equal(sets.length, 0)
  assert.deepEqual(refreshed, [1], '重讀名單，新設備的名字才會立刻換')
})

test('#1860H 對照：若本機自己把舊節點加進 removed 再推，就會排推送（所以必須走 adoptRemote）', () => {
  const prefs = synced()
  const { sync, timers } = realSync(prefs, [])
  prefs.deviceRemoved = [...prefs.deviceRemoved, OLD1]
  sync.noteLocal()
  assert.equal(timers.length, 1)
})

test('#1860H 取代後讀設定失敗：只記 log，名單照樣重讀', async () => {
  const logs = []; const refreshed = []
  const sync = { adoptRemote: () => assert.fail('不該被呼叫') }
  await syncAfterReplace({ getPrefs: async () => { throw new Error('逾時') }, devSync: sync, refreshRoster: async () => { refreshed.push(1) }, log: (...a) => logs.push(a.join(' ')) })
  assert.ok(logs.some(l => l.includes('逾時'))); assert.deepEqual(refreshed, [1])
})

// ---- 通知 ----
test('#1860H 通知 notice:new_device：歸「安全」、帶「查看設備」去處；其他通知沒有去處', () => {
  assert.equal(noticeCategory('notice:new_device'), 'security')
  assert.equal(NOTICE_CAT_LABEL.security, '安全')
  assert.deepEqual(noticeGoOf('notice:new_device'), { page: 'devices', label: '查看設備' })
  assert.equal(noticeGoOf('notice:quota'), null); assert.equal(noticeGoOf(undefined), null)
  const rows = noticeRows([{ k: 'them', t: 1, id: 'a', kind: 'notice:new_device', text: '有一台新的電腦連上了\n請到設備頁確認' }, { k: 'them', t: 2, id: 'b', kind: 'notice:quota', text: '額度\n快用完' }])
  assert.equal(rows.find(r => r.key === 'a').go.page, 'devices'); assert.equal(rows.find(r => r.key === 'b').go, null)
})

// ---- 接線守門（電腦、手機兩邊都用同一份流程） ----
test('#1860H 接線：list.js 與 m.js 都用同一個 createReplaceFlow／syncAfterReplace／出口，畫面接上卡片與通知去處', () => {
  for (const f of ['list.js', 'm.js']) {
    const s = src(f)
    assert.match(s, /from '\.\/lib\/device-replace\.mjs'/, f)
    assert.match(s, /createReplaceFlow\(\{/, f); assert.match(s, /syncAfterReplace\(\{[^}]*devSync/, f + ' 取代後併入後台的設定')
    assert.match(s, /deviceReplaceApi/, f); assert.match(s, /replaceFlow\.load\(\)/, f); assert.match(s, /goNotice/, f)
    assert.doesNotMatch(s.replace(/\/\/.*$/gm, ''), /invoke\('relay_device_replace/, f + ' 要走出口')
  }
  assert.match(src('m.html'), /data-replace/); assert.match(src('m.html'), /noticeGo/)
  assert.match(src('lib/settings-panel.mjs'), /data-replace/); assert.match(src('list.html'), /goNotice\(noticeSelRow\.go\)/)
  assert.match(src('list.js'), /case 'replace-do'/); assert.match(src('list.js'), /case 'replace-keep'/)
  // 卡片放在清單前面：設備頁模板裡卡片區塊在 <ul … aria-label="設備"> 之前
  const m = src('m.html'); assert.ok(m.indexOf('data-replace') < m.indexOf('aria-label="設備"'))
  const p = src('lib/settings-panel.mjs'); assert.ok(p.indexOf('data-replace') < p.indexOf('aria-label="設備"'))
})

test('#1860H 出口的命令都在 Rust 兩份指令清單裡', () => {
  const t = src('lib/tauri.mjs'); const lib = fs.readFileSync(path.join(UI, '..', 'src-tauri', 'src', 'lib.rs'), 'utf8')
  for (const c of ['relay_device_replace_candidates', 'relay_device_replace', 'relay_device_replace_dismiss']) {
    assert.ok(t.includes(`'${c}'`), c)
    assert.equal((lib.match(new RegExp(`[ ,]${c}[,\\n]`, 'g')) ?? []).length, 2, `${c} 電腦與手機各一份清單`)
  }
})
