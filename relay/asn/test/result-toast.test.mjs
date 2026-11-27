// 結果提示（#2425 位置 D，PR-3）：共用的 AsnToast／showResult。電腦與手機同一份；封存結果與釘選滿五處都走它。
// 規範見 docs/畫面規範.md〈四之一、訊息與提示的位置〉；唯一出口見 docs/唯一出口.md。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { AsnToast, TOAST_KINDS, TOAST_MS, UI_KIT, currentResult, dismissResult, showResult, toastAnchorStyle, toastPlace, toastView } from '../ui/lib/ui-kit.mjs'
import { mountComponent } from './helpers/render.mjs'

const UI = fileURLToPath(new URL('../ui/', import.meta.url))
const read = p => fs.readFileSync(path.join(UI, p), 'utf8').replace(/\r\n/g, '\n')
const settle = async m => { for (let i = 0; i < 4; i++) { await new Promise(r => setTimeout(r, 0)); await m.nextTick() } }

// 假時鐘：只在呼叫 showResult 的那一小段取代 setTimeout／clearTimeout，記下排程，由測試手動「走時間」
function fakeClock() {
  const real = { st: globalThis.setTimeout, ct: globalThis.clearTimeout }
  const jobs = []
  globalThis.setTimeout = (fn, ms) => { const j = { fn, ms, live: true }; jobs.push(j); return j }
  globalThis.clearTimeout = j => { if (j && typeof j === 'object') j.live = false }
  return {
    jobs,
    live: () => jobs.filter(j => j.live),
    fire: () => { const j = jobs.filter(x => x.live).at(-1); j.live = false; j.fn() },
    restore: () => { globalThis.setTimeout = real.st; globalThis.clearTimeout = real.ct },
  }
}

test('#2425 toastView：只有 ok／fail；成功 4 秒、失敗 6 秒；不認得的種類當失敗，不把問題畫成成功', () => {
  assert.deepEqual([...TOAST_KINDS], ['ok', 'fail'])
  assert.deepEqual({ ...TOAST_MS }, { ok: 4000, fail: 6000 })
  assert.deepEqual(toastView('ok').classes, ['asn-toast', 'k-ok'])
  assert.deepEqual(toastView('fail').classes, ['asn-toast', 'k-fail'])
  assert.equal(toastView('ok').ms, 4000)
  assert.equal(toastView('fail').ms, 6000)
  assert.equal(toastView('ok').role, 'status')
  for (const bad of ['info', 'warn', 'error', '', null]) {
    const v = toastView(bad)
    assert.equal(v.kind, 'fail', String(bad)); assert.equal(v.kindOk, false)
  }
  assert.equal(toastView().kind, 'ok', '沒給種類＝預設成功')
})

test('#2425 showResult／AsnToast：顯示文字與種類；沒有文字什麼都不顯示；role 是 status', async () => {
  const m = mountComponent(AsnToast, {})
  try {
    await settle(m)
    assert.equal(m.find('.asn-toast'), null, '一開始沒有提示')
    showResult('ok', ''); showResult('ok', '   '); await settle(m)
    assert.equal(m.find('.asn-toast'), null, '空文字不顯示')
    showResult('ok', '已封存'); await settle(m)
    const t = m.find('.asn-toast')
    assert.equal(t.getAttribute('role'), 'status'); assert.ok(t.className.includes('k-ok'))
    assert.equal(m.find('.asn-toast-text').textContent, '已封存')
    showResult('fail', '封存失敗，請稍後再試'); await settle(m)
    assert.ok(m.find('.asn-toast').className.includes('k-fail'))
  } finally { dismissResult(); m.unmount() }
})

test('#2425 會自動消失：成功 4 秒、失敗 6 秒（假時鐘）；時間到才消失', async () => {
  const m = mountComponent(AsnToast, {})
  try {
    await settle(m)
    for (const [kind, ms] of [['ok', 4000], ['fail', 6000]]) {
      const clock = fakeClock()
      try { showResult(kind, '結果'); } finally { clock.restore() }
      assert.equal(clock.live().length, 1, `${kind}：只排一個計時`)
      assert.equal(clock.live()[0].ms, ms, `${kind}：${ms} 毫秒後消失`)
      await settle(m)
      assert.ok(m.find('.asn-toast'), `${kind}：時間沒到還在`)
      clock.fire(); await settle(m)
      assert.equal(m.find('.asn-toast'), null, `${kind}：時間到自己消失`)
      assert.equal(currentResult().text, '')
    }
  } finally { dismissResult(); m.unmount() }
})

test('#2425 同一時間只有一則：新的取代舊的，舊的計時作廢、新的重新計時', async () => {
  const m = mountComponent(AsnToast, {})
  try {
    await settle(m)
    const clock = fakeClock()
    try { showResult('ok', '第一則'); showResult('fail', '第二則') } finally { clock.restore() }
    await settle(m)
    assert.equal(m.findAll('.asn-toast').length, 1, '畫面上只有一則')
    assert.equal(m.find('.asn-toast-text').textContent, '第二則')
    assert.ok(m.find('.asn-toast').className.includes('k-fail'))
    assert.equal(clock.live().length, 1, '舊的計時已作廢，只剩新的')
    assert.equal(clock.live()[0].ms, 6000, '新的照自己的種類計時')
    assert.equal(clock.jobs.length, 2)
    assert.equal(clock.jobs[0].live, false)
  } finally { dismissResult(); m.unmount() }
})

test('#2425 可以手動關掉：按 × 就消失，計時一併作廢；× 有名稱', async () => {
  const m = mountComponent(AsnToast, {})
  try {
    await settle(m)
    const clock = fakeClock()
    try {
      showResult('ok', '已封存')
      await m.nextTick()
      const b = m.find('.asn-toast-close')
      assert.equal(b.getAttribute('aria-label'), '關閉'); assert.equal(b.getAttribute('type'), 'button')
      await m.trigger(b, 'click')
      assert.equal(m.find('.asn-toast'), null)
      assert.equal(clock.live().length, 0, '手動關掉後不再留計時')
    } finally { clock.restore() }
  } finally { dismissResult(); m.unmount() }
})

test('#2425 頁面掛上之前就已經有的提示，掛上後也看得到（電腦頁面先出結果、元件後掛）', async () => {
  const clock = fakeClock()
  try { showResult('ok', '早到的結果') } finally { clock.restore() }
  const m = mountComponent(AsnToast, {})
  try {
    await settle(m)
    assert.equal(m.find('.asn-toast-text')?.textContent, '早到的結果')
  } finally { dismissResult(); m.unmount() }
})

test('#2425 AsnToast 在 UI_KIT 裡；樣式只用變數（字級、間距、顏色）；手機的位置跟著 .m-body', () => {
  assert.equal(UI_KIT.AsnToast, AsnToast)
  const css = read('kit.css').replace(/\r\n/g, '\n')
  const block = css.split('\n').filter(l => /^\.asn-toast/.test(l)).join('\n')
  assert.ok(block.length > 0)
  assert.doesNotMatch(block, /font-size:\s*\d/, '字級要用 --fs-*')
  assert.doesNotMatch(block, /(?:padding|margin|gap)\s*:[^;}]*\d+px/, '間距要用 --sp-*')
  assert.doesNotMatch(block, /#[0-9a-f]{3,6}\b/i, '顏色要用變數')
  assert.match(css, /\.m-body\{[^}]*--toast-bottom:/, '手機把提示放在底部分頁列上方')
})

// ---- 位置（asn真 二審原則，畫面規範〈四之一〉D：不准蓋住控制項；訊息、名單列這類內容列可以短暫被蓋）----
test('#2425 toastPlace：提示的下緣貼在錨點下緣往上 8、水平置中、寬度不超出錨點；看不到的錨點回 null', () => {
  const p = toastPlace({ left: 450, right: 890, top: 140, bottom: 480, width: 440, height: 340 }, 640)
  assert.deepEqual(p, { left: '670px', bottom: '168px', maxWidth: '424px' })   // 640 - 480 + 8
  assert.equal(toastPlace({ left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 }, 640), null)
  assert.equal(toastPlace(null, 640), null)
  assert.equal(toastPlace({ left: 0, right: 10, top: 0, bottom: 10, width: 10, height: 10 }, 0), null)
})

test('#2425 toastAnchorStyle：對話視窗用訊息區、名單頁用名單區；指定的那區看不到改用另一區；沒給 at（手機）不給行內位置', async () => {
  const m = mountComponent({ template: '<div><div data-toast-anchor="chat"></div><div data-toast-anchor="list"></div></div>' }, {})
  try {
    const [chat, list] = m.findAll('[data-toast-anchor]')
    const box = (el, r) => { el.getBoundingClientRect = () => ({ ...r, width: r.right - r.left, height: r.bottom - r.top }) }
    box(chat, { left: 450, right: 890, top: 140, bottom: 480 }); box(list, { left: 10, right: 300, top: 180, bottom: 545 })
    assert.equal(toastAnchorStyle('chat', m.document, 640).left, '670px')
    assert.equal(toastAnchorStyle('list', m.document, 640).left, '155px')
    assert.equal(toastAnchorStyle('list', m.document, 640).bottom, '103px')
    box(chat, { left: 0, right: 0, top: 0, bottom: 0 })   // 對話區看不到（例如沒開對話）
    assert.equal(toastAnchorStyle('chat', m.document, 640).left, '155px', '改用名單區')
    assert.equal(toastAnchorStyle('', m.document, 640), null, '沒給 at＝手機，走 CSS 的底部置中')
    assert.equal(toastAnchorStyle('nowhere', m.document, 640), null)
  } finally { m.unmount() }
})

test('#2425 toastPlace 貼上緣：提示的上緣貼在錨點上緣往下 8、不設 bottom（改成 auto）；沒給 edge 仍貼下緣', () => {
  const r = { left: 450, right: 890, top: 140, bottom: 480, width: 440, height: 340 }
  assert.deepEqual(toastPlace(r, 640, 'top'), { left: '670px', top: '148px', bottom: 'auto', maxWidth: '424px' })
  assert.deepEqual(toastPlace(r, 640, 'bottom'), toastPlace(r, 640))
  assert.equal(toastPlace({ ...r, width: 0 }, 640, 'top'), null)
})

test('#2425 錨點有好幾個（整合模式每個對話分頁各一個）：取第一個看得到的，不是第一個；藏起來的（方框全 0）略過', async () => {
  const m = mountComponent({ template: '<div><div id="a" data-toast-anchor="chat"></div><div id="b" data-toast-anchor="chat"></div><div id="l" data-toast-anchor="list"></div></div>' }, {})
  try {
    const box = (el, r) => { el.getBoundingClientRect = () => ({ ...r, width: r.right - r.left, height: r.bottom - r.top }) }
    const a = m.find('#a'), b = m.find('#b'), l = m.find('#l')
    box(a, { left: 0, right: 0, top: 0, bottom: 0 })                           // 第一個分頁：藏起來
    box(b, { left: 450, right: 890, top: 140, bottom: 480 })                    // 第二個分頁：目前看得到
    box(l, { left: 10, right: 300, top: 180, bottom: 545 })
    assert.equal(toastAnchorStyle('chat', m.document, 640).left, '670px', '選到第二個，不是退到名單區（155px）')
    box(a, { left: 450, right: 890, top: 140, bottom: 480 }); box(b, { left: 0, right: 0, top: 0, bottom: 0 })
    assert.equal(toastAnchorStyle('chat', m.document, 640).left, '670px', '第一個看得到就用第一個')
    box(a, { left: 0, right: 0, top: 0, bottom: 0 })                            // 兩個都藏（寬 500 只顯示名單等）
    assert.equal(toastAnchorStyle('chat', m.document, 640).left, '155px', '都藏起來才退到另一區')
    // 終端或對方畫面的錨點：data-toast-edge="top"，貼上緣
    b.setAttribute('data-toast-edge', 'top'); box(b, { left: 450, right: 890, top: 140, bottom: 480 })
    assert.deepEqual(toastAnchorStyle('chat', m.document, 640), { left: '670px', top: '148px', bottom: 'auto', maxWidth: '424px' })
  } finally { m.unmount() }
})

test('#2425 終端與對方畫面的錨點掛在 .term-view-screen（畫面本體），不是外層容器：貼上緣才會落在貼上確認列、停止列的下方', () => {
  for (const f of ['lib/term-view.mjs', 'lib/term-remote.mjs', 'lib/term-remote-input.mjs']) {
    const src = read(f)
    assert.match(src, /<div class="term-view-screen" data-toast-anchor="chat" data-toast-edge="top"/, `${f}：畫面本體是貼上緣的對話錨點`)
    assert.doesNotMatch(src, /<div class="term-view(?: [^"]*)?"[^>]*[ "]data-toast-anchor=/, `${f}：外層容器不能一直是錨點（只有已結束時才是，見下一條）`)
  }
  assert.match(read('lib/chatpane.mjs'), /<div class="msgs" data-toast-anchor="chat" ref/, '訊息區貼下緣（沒有 edge）')
  assert.doesNotMatch(read('lib/chatpane.mjs'), /data-toast-edge/)
})

test('#2452 終端「已結束觀看」：畫面本體與訊息區都藏著時，整塊終端區當對話錨點（貼下緣，在輸入區上面、「重新看」狀態列的上方）；沒結束時不是錨點', () => {
  for (const f of ['lib/term-remote.mjs', 'lib/term-remote-input.mjs']) {
    const src = read(f)
    const root = src.split('\n').find(l => /^<div class="term-view term-remote/.test(l))
    assert.ok(root, `${f}：找得到終端區根元素`)
    assert.match(root, /:data-toast-anchor="phase === 'ended' \? 'chat' : null"/, `${f}：只有 phase 是 ended 時才是對話錨點`)
    assert.doesNotMatch(root, /data-toast-edge/, `${f}：沒有 edge＝貼下緣`)
  }
  // 優先順序靠「第一個看得到的」自然排出：訊息區看得到時終端區不看（一邊顯示終端時 .conv 整個藏起來）；畫面本體看得到時終端區不是錨點（phase 不是 ended）；
  // 兩者都藏、只剩已結束的終端區時才輪到它。「重新看」在 chatpane 最下面的狀態列（.typing），終端區在輸入區上面，所以貼終端區下緣不蓋到
  const pane = read('lib/chatpane.mjs')
  assert.ok(pane.indexOf('<remote-view') < pane.indexOf('<div class="typing"'), '終端區在狀態列之前（上面）')
  assert.match(pane, /GRACE_AGAIN_LABEL \}\}<\/button>/, '「重新看」鈕畫在狀態列')
})

test('#2425 AsnToast 依 at 寫行內位置：給 at 才有，手機（沒給）沒有；換一則會重算', async () => {
  const anchor = mountComponent({ template: '<div data-toast-anchor="chat"></div>' }, {})
  const el = anchor.find('[data-toast-anchor]')
  el.getBoundingClientRect = () => ({ left: 450, right: 890, top: 140, bottom: 480, width: 440, height: 340 })
  Object.defineProperty(globalThis, 'innerHeight', { value: 640, configurable: true, writable: true })
  const m = mountComponent(AsnToast, {})
  try {
    await settle(m)
    const clock = fakeClock()
    try { showResult('ok', '已封存', { at: 'chat' }) } finally { clock.restore() }
    await settle(m)
    const st = m.find('.asn-toast').getAttribute('style') || ''
    assert.match(st, /bottom:\s*168px/); assert.match(st, /left:\s*670px/)
    const c2 = fakeClock()
    try { showResult('fail', '釘選滿') } finally { c2.restore() }   // 手機：沒給 at
    await settle(m)
    assert.doesNotMatch(m.find('.asn-toast').getAttribute('style') || '', /left|bottom/, '沒給 at 就沒有行內位置')
  } finally { dismissResult(); m.unmount(); anchor.unmount() }
})

test('#2425 電腦版位置的接線：訊息區與名單區各有錨點；封存／釘選滿的呼叫端各自說 at；CSS 預設只給手機與找不到錨點時用（底部）', () => {
  assert.match(read('lib/chatpane.mjs'), /<div class="msgs" data-toast-anchor="chat"/, '訊息區（輸入區正上方）是對話錨點')
  assert.match(read('list.html'), /<div class="content" role="tabpanel" data-toast-anchor="list">/, '名單區（搜尋框與分頁列下面）是名單錨點')
  assert.match(read('lib/actionbar.mjs'), /showResult\(r\.ok \? 'ok' : 'fail', r\.text, \{ at: 'chat' \}\)/, '功能列的封存：對話視窗')
  assert.match(read('list.js'), /showResult\(r\.ok \? 'ok' : 'fail', r\.text, \{ at: 'list' \}\)/, '名單的封存：名單區')
  assert.match(read('list.js'), /showResult\('fail', r\.text, \{ at: 'list' \}\)/, '名單的釘選滿：名單區')
  assert.doesNotMatch(read('m.js'), /\bat: '(?:chat|list)'/, '手機不給 at，維持底部')
  const css = read('kit.css')
  const base = css.split('\n').find(l => /^\.asn-toast\{/.test(l))
  assert.match(base, /bottom:var\(--toast-bottom\)/, '預設在底部（手機）')
  assert.doesNotMatch(base, /(?:^|[;{\s])top\s*:/, '不再靠右上角（會蓋到功能列與分頁）')
  assert.match(css, /\.m-body\{[^}]*--toast-bottom:calc\(env\(safe-area-inset-bottom/, '手機浮在分頁列上方')
})

// ---- 唯一出口守門：結果提示只能從 showResult 出去 ----
function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'vendor' || e.name === 'node_modules') continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) yield* walk(p)
    else if (/\.(js|mjs|html)$/.test(e.name)) yield p
  }
}

test('#2425 唯一出口守門：ui 底下沒有第二套結果提示（showToast 實作、m-toast 元素、自己的 toast ref）；右下角系統提示 windowApi.showToast 是另一回事', () => {
  const bad = []
  for (const f of walk(UI)) {
    const rel = path.relative(UI, f).split(path.sep).join('/')
    const src = fs.readFileSync(f, 'utf8')
    // showToast 只准出現在 windowApi.showToast（右下角的系統視窗提示）與 tauri.mjs 裡轉呼叫 Rust 的那一行
    if (rel !== 'lib/tauri.mjs') for (const m of src.matchAll(/(?<!windowApi\.)\bshowToast\b/g)) bad.push(`${rel}: 自己的 showToast（位置 ${m.index}）`)
    if (/\bm-toast\b/.test(src)) bad.push(`${rel}: m-toast`)
    if (/\b(?:const|let|var)\s+toast\s*=\s*ref\(/.test(src)) bad.push(`${rel}: 自己的 toast ref`)
  }
  assert.deepEqual(bad, [], '結果提示一律呼叫 showResult（ui-kit.mjs），不要另寫一套')
})

test('#2425 三個頁面根部各掛一個 <asn-toast>，並註冊元件（電腦名單、手機、分離的對話視窗）', () => {
  for (const [html, js] of [['list.html', 'list.js'], ['m.html', 'm.js'], ['chat.html', 'chat.js']]) {
    assert.equal((read(html).match(/<asn-toast><\/asn-toast>/g) || []).length, 1, `${html} 掛一個`)
    const src = read(js)
    assert.match(src, js === 'm.js' ? /Object\.entries\(UI_KIT\)/ : /app\.component\('AsnToast', AsnToast\)/, `${js} 註冊`)
  }
})

// ---- 五處搬遷：條件與字不變，種類帶對 ----
test('#2425 第 1 處 電腦釘選滿：togglePin 失敗（滿 50 個）才提示，種類 fail、字用 togglePin 回的原文；成功不提示', () => {
  const src = read('list.js')
  const fn = src.slice(src.indexOf('function togglePinChat'), src.indexOf('// 設備順序同步到帳號層'))
  assert.match(fn, /if \(r\.ok\) chatPins\.value = r\.state\s*\n\s*else showResult\('fail', r\.text, \{ at: 'list' \}\)/)
  assert.doesNotMatch(src, /pinNote/, '舊的常駐 pin-note 不留')
  assert.doesNotMatch(read('list.html'), /pin-note/)
})

test('#2425 第 2 處 電腦封存結果：封存／取消封存做完都提示，成功 ok、失敗 fail，字用 runArchive 回的原文', () => {
  const src = read('list.js')
  const fn = src.slice(src.indexOf('async function setArchived'), src.indexOf('function closeOpDlg'))
  assert.match(fn, /const r = await runArchive\(transport, f, archived\)\s*\n\s*if \(r\.ok\) await core\.refreshRoster\(\)\s*\n\s*showResult\(r\.ok \? 'ok' : 'fail', r\.text, \{ at: 'list' \}\)/)
  assert.doesNotMatch(src, /archiveNote/)
  // env-notice 已在 PR-4 搬去設定頁終端區（見 list-notes-pr4.test.mjs）；名單上不再有它
  assert.doesNotMatch(read('list.html'), /env-notice|archive-note/)
})

test('#2425 第 3 處 對話視窗功能列封存結果：封存／取消封存做完提示，ok／fail 照結果；功能列不再有 ab-note', () => {
  const src = read('lib/actionbar.mjs')
  const fn = src.slice(src.indexOf("if (op === 'archive' || op === 'unarchive') {"), src.indexOf("Object.assign(opDlg, { open: true, item: { key: op"))
  assert.match(fn, /const r = await runArchive\(props\.api, props\.friend, op === 'archive'\)\s*\n\s*showResult\(r\.ok \? 'ok' : 'fail', r\.text, \{ at: 'chat' \}\)[^\n]*\n\s*return/)
  assert.doesNotMatch(src, /archiveNote|ab-note|noteTimer/)
  assert.match(src, /import \{ showResult \} from '\.\/ui-kit\.mjs'/)
})

test('#2425 第 4 處 手機封存結果：onArchived 做完提示，ok／fail 照結果；m.html 不再有 m-archive-note', () => {
  const src = read('m.js')
  const fn = src.slice(src.indexOf('const onArchived = async r => {'), src.indexOf('const opRunner = createOpRunner'))
  assert.match(fn, /if \(r\.ok\) await core\.refreshRoster\(\)\s*\n\s*showResult\(r\.ok \? 'ok' : 'fail', r\.text\)/)
  assert.doesNotMatch(src, /archiveNote/)
  assert.doesNotMatch(read('m.html'), /m-archive-note/)
})

test('#2425 第 5 處（續）設備名回呼：本機寄信名字沒換成＝fail；對齊成功＝ok、對齊失敗＝fail（手機 notifyResult 接收第二個參數）', async () => {
  const { followSelfRename, alignDeviceName } = await import('../ui/lib/device-rename.mjs')
  const got = []
  const notify = (text, kind) => got.push([kind, text])
  followSelfRename({}, { name: '新名', window_rename_failed: '名字不符合規則' }, notify, () => {})
  assert.equal(got.length, 1); assert.equal(got[0][0], 'fail'); assert.ok(got[0][1].length > 0)
  const src = read('lib/device-rename.mjs')
  assert.match(src, /notify\(alignNote\(r\.name\), 'ok'\)/)
  assert.match(src, /notify\(alignFailedNote\([^\n]*\), 'fail'\)/)
  assert.equal(typeof alignDeviceName, 'function')
})

test('#2425 第 5 處 手機釘選滿與其餘 showToast 呼叫端：全部改走 showResult，種類帶對；本機不再留一套浮動提示', () => {
  const src = read('m.js')
  assert.match(src, /else showResult\('fail', r\.text\)/, '釘選滿')
  assert.match(src, /if \(cloudSt\.msg\) showResult\('fail', cloudSt\.msg\)/, '離開雲端頁的提示')
  assert.match(src, /showResult\(v\.phase === 'done' \? 'ok' : 'fail', acctResultToast\(v, \{ label, email \}\)\)/, '切換帳號結果：成功 ok、其餘 fail')
  assert.match(src, /notify: notifyResult \}\); await alignDeviceName\(invoke, \{ info, core, me \}, notifyResult\)/, '設備名補送與對齊')
  assert.match(src, /window_rename_failed: r\.windowRenameFailed \}, notifyResult\)/, '改自己這支手機的名字')
  assert.match(src, /const notifyResult = \(text, kind = 'ok'\) => showResult\(kind, text\)/)
  assert.doesNotMatch(src, /showToast|toastTimer|ACCT_TOAST_MS/)
  assert.doesNotMatch(read('m.html'), /m-toast/)
})
