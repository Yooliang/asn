// 「提醒與聲音」頁共用元件 AsnNotifyPanel（#1763 C4，U6）：電腦（split）與手機（stack）用同一個元件，畫面只搬不改。
// 守門：三張能力表 × 三種外觀都渲染得出來；notifyItems 的結果跟 setting-needs／設定值清單的平台欄一致；
// 兩個殼真的掛載確認版面（電腦 is-split、手機 is-stack）；震動、推播在殼裡的接線照舊（點了呼叫原本的函式）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { AsnNotifyPanel, notifyItems } from '../ui/parts/notify-panel.mjs'
import { NOTIFY_ITEMS } from '../ui/lib/prefs.mjs'
import { PUSH_TEXT, pushSettingView } from '../ui/lib/mobile-push.mjs'
import { settingNeeds } from '../ui/lib/setting-needs.mjs'
import { capsDesktop } from '../ui/shells/caps-desktop.mjs'
import { capsAndroid } from '../ui/shells/caps-android.mjs'
import { capsWeb } from '../ui/shells/caps-web.mjs'
import { ATTRS_DESKTOP, ATTRS_ANDROID, ATTRS_WEB } from '../ui/shells/platform-attrs.mjs'
import { mountComponent } from './helpers/render.mjs'
import { COLS, colOf, parsePlatform, parseList } from './settings-list-check.mjs'

const read = p => fs.readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const PLATFORMS = [['desktop', capsDesktop, ATTRS_DESKTOP, COLS.desktop], ['android', capsAndroid, ATTRS_ANDROID, COLS.mobile], ['web', capsWeb, ATTRS_WEB, COLS.web]]
const SKINS = ['aero', 'modern', 'line']
const TOKENS = ['notify', 'prefs.vibrateNudge', 'prefs.vibrateMsg', 'prefs.push']
const pushOn = pushSettingView('granted', true)
const VALUES = { toast: true, msg: false, nudge: true, file: false, vibrateNudge: true, vibrateMsg: false }

// ---- 渲染 ----
for (const [pname, caps, attrs] of PLATFORMS) {
  for (const skin of SKINS) {
    test(`AsnNotifyPanel 在 ${pname} × ${skin} 都能渲染，項目照 notifyItems 的順序、字與勾選都對`, () => {
      const items = notifyItems(caps)
      const m = mountComponent(AsnNotifyPanel, { items, values: VALUES, push: pushOn, layout: attrs.layout })
      try {
        m.document.documentElement.setAttribute('data-skin', skin)
        const labels = m.findAll('label').map(l => l.textContent.trim())
        assert.deepEqual(labels, items.map(i => i.label), '每一項一個勾選，順序照 notifyItems')
        const boxes = m.findAll('input[type="checkbox"]')
        assert.equal(boxes.length, items.length)
        items.forEach((it, i) => { if (it.kind === 'toggle') assert.equal(boxes[i].checked, VALUES[it.key], it.label); else assert.equal(boxes[i].checked, pushOn.checked) })
        if (items.length) assert.ok(m.find(attrs.layout === 'stack' ? '.is-stack' : '.is-split'), '版面類別跟著 layout')
      } finally { m.unmount() }
    })
  }
}

test('文字照搬家前：電腦四項、手機兩個震動加推播（字與順序不變）', () => {
  assert.deepEqual(notifyItems(capsDesktop).map(i => i.label), ['右下角通知', '通知聲音', '震動聲音', '收到檔案聲音'])
  assert.deepEqual(notifyItems(capsDesktop).map(i => i.label), NOTIFY_ITEMS.map(i => i.label))
  assert.deepEqual(notifyItems(capsAndroid).map(i => i.label), ['對方傳來「震動」時，手機跟著震動', '收到新訊息時輕輕震一下', PUSH_TEXT.label])
  assert.deepEqual(notifyItems(capsWeb), [])
  assert.deepEqual(notifyItems(undefined), [])
})

test('split（電腦）：每項一個 .chk、沒有卡片與推播說明；stack（手機）：一張卡，推播底下有說明，被拒才有權限提示', () => {
  const d = mountComponent(AsnNotifyPanel, { items: notifyItems(capsDesktop), values: VALUES, layout: 'split' })
  try { assert.equal(d.findAll('label.chk').length, 4); assert.equal(d.findAll('.m-card').length, 0); assert.equal(d.findAll('.m-fine').length, 0) } finally { d.unmount() }
  const s = mountComponent(AsnNotifyPanel, { items: notifyItems(capsAndroid), values: VALUES, push: pushSettingView('granted', true), layout: 'stack' })
  try {
    assert.equal(s.findAll('.m-card.m-form').length, 1)
    assert.equal(s.findAll('label.m-check').length, 3)
    assert.equal(s.find('.m-fine').textContent, PUSH_TEXT.note)
    assert.equal(s.find('.m-err'), null)
    assert.equal(s.findAll('.chk').length, 0)
  } finally { s.unmount() }
})

test('手機推播開關三種狀態：可用（勾著）、被拒（勾著但提示去系統設定）、不可用（整組不顯示，只剩兩個震動）', () => {
  const mk = view => { const m = mountComponent(AsnNotifyPanel, { items: notifyItems(capsAndroid), values: VALUES, push: view, layout: 'stack' }); return m }
  const ok = mk(pushSettingView('granted', true))
  try { assert.equal(ok.findAll('label.m-check').length, 3); assert.equal(ok.findAll('input')[2].checked, true); assert.equal(ok.find('.m-err'), null) } finally { ok.unmount() }
  const denied = mk(pushSettingView('denied', true))
  try { assert.equal(denied.findAll('label.m-check').length, 3); assert.equal(denied.find('.m-err').textContent, PUSH_TEXT.denied); assert.equal(denied.find('.m-err').getAttribute('role'), 'status') } finally { denied.unmount() }
  const none = mk(pushSettingView('unavailable', true))
  try { assert.equal(none.findAll('label.m-check').length, 2); assert.equal(none.find('.m-fine'), null); assert.equal(none.find('.m-err'), null) } finally { none.unmount() }
})

test('按勾選送對的事件：toggle 帶 { key, on }（兩種版面一樣）、推播送 push(on)', async () => {
  for (const [caps, layout] of [[capsDesktop, 'split'], [capsAndroid, 'stack']]) {
    const items = notifyItems(caps)
    const m = mountComponent(AsnNotifyPanel, { items, values: VALUES, push: pushOn, layout })
    try {
      const boxes = m.findAll('input[type="checkbox"]')
      for (let i = 0; i < items.length; i++) await m.trigger(boxes[i], 'change', { checked: i % 2 === 0 })
      const want = items.map((it, i) => [it, i % 2 === 0]).filter(([it]) => it.kind === 'toggle').map(([it, on]) => [{ key: it.key, on }])
      assert.deepEqual(m.emitted('toggle'), want)
      if (caps === capsAndroid) assert.deepEqual(m.emitted('push'), [[(items.length - 1) % 2 === 0]], '推播是最後一項，送它勾選後的值')
      else assert.equal(m.emitted('push').length, 0)
    } finally { m.unmount() }
  }
})

// ---- notifyItems 跟 setting-needs／設定值清單一致 ----
test('notifyItems 的每一項，在三張能力表下有沒有，跟 setting-needs 的 needs 一致（沒登記的項目不准出現）', () => {
  for (const [pname, caps] of PLATFORMS) {
    const got = new Set(notifyItems(caps).map(i => i.token))
    for (const t of TOKENS) {
      const needs = settingNeeds(t)
      assert.ok(needs.length > 0, `${t} 要有明確的能力需求`)
      assert.equal(got.has(t), needs.every(n => caps[n] === true), `${pname}：${t} 該有嗎（needs ${needs.join('、')}）`)
    }
    for (const t of got) assert.ok(TOKENS.includes(t), `${pname}：多出沒對照的項目 ${t}`)
  }
})

test('notifyItems 的每一項，在三張能力表下有沒有，跟設定值清單「提醒與聲音」那幾列的平台欄一致', () => {
  const rows = parseList(read('../../../docs/設定值清單.md'))
  for (const t of TOKENS) {
    const row = rows.find(r => r.tokens.includes(t))
    assert.ok(row, `清單裡找不到 ${t}`)
    for (const [pname, caps, , col] of PLATFORMS) {
      const p = parsePlatform(colOf(row, col))
      assert.ok(p.ok, `${t} ${pname} 欄看不懂`)
      assert.equal(notifyItems(caps).some(i => i.token === t), p.has, `${pname}：${t} 清單寫${p.has ? '有' : '無'}`)
    }
  }
})

test('「聲音」不另外加能力：通知聲音、震動聲音、收到檔案聲音跟右下角通知同一個標記（notify），都歸 desktopToast', () => {
  assert.deepEqual(settingNeeds('notify'), ['desktopToast'])
  const sounds = notifyItems(capsDesktop).filter(i => i.label.includes('聲音'))
  assert.equal(sounds.length, 3)
  assert.ok(sounds.every(i => i.token === 'notify'))
  assert.equal(Object.keys(capsDesktop).length, 14, '沒有新增能力名稱')
})

// ---- 版面接線：手機一定畫 stack、電腦一定畫 split；元件預設是 split，所以手機漏傳 :layout 會靜默畫成電腦版面 ----
test('版面接線：電腦殼真的掛載，「提醒與聲音」畫成 split（is-split）', async () => {
  const { SettingsPanel } = await import('../ui/lib/settings-panel.mjs')
  const m = mountComponent(SettingsPanel, { st: { notify: { toast: true, msg: true, nudge: true, file: true } }, catKey: 'notify' })
  try {
    assert.equal(m.findAll('label.chk.is-split').length, 4, '電腦的提醒要帶 is-split')
    assert.equal(m.find('.is-stack'), null)
    assert.equal(m.findAll('.m-check').length, 0)
  } finally { m.unmount() }
  const src = read('../ui/lib/settings-panel.mjs')
  assert.match(src, /notifyLayout = ATTRS_DESKTOP\.layout/)
  assert.match(src, /notifyItems\(capsDesktop\)/)
  assert.match(src, /<asn-notify-panel [^>]*:layout="notifyLayout"/)
})

const MOBILE_TAG = read('../ui/m.html').match(/<asn-notify-panel\s[^>]*>/)?.[0]

test('版面接線：手機殼把 ATTRS_ANDROID.layout（stack）傳給元件；用殼裡同一份接線真的掛載，畫出 is-stack', async () => {
  const js = read('../ui/m.js')
  assert.ok(MOBILE_TAG, 'm.html 找不到 asn-notify-panel')
  assert.match(MOBILE_TAG, /\s:layout="notifyLayout"/, '手機要傳 :layout（元件預設是 split，沒傳會畫成電腦版面）')
  assert.equal(/\bnotifyLayout = [^,\n]*?(\w+)\.layout\b/.exec(js)?.[1], 'ATTRS_ANDROID', 'm.js 的 notifyLayout 要取自 ATTRS_ANDROID')
  assert.match(js, /import \{[^}]*\bATTRS_ANDROID\b[^}]*\} from '\.\/shells\/platform-attrs\.mjs'/)
  assert.match(js, /notifyList = notifyItems\(capsAndroid\)/)
  assert.equal(ATTRS_ANDROID.layout, 'stack')
  const m = mountComponent(hostFor(ATTRS_ANDROID.layout).Host)
  try {
    assert.ok(m.find('.asn-notify-card.is-stack'), '手機的提醒要帶 is-stack')
    assert.equal(m.find('.is-split'), null)
    assert.equal(m.findAll('.chk').length, 0)
    assert.equal(m.findAll('label.m-check').length, 3)
  } finally { m.unmount() }
})

// ---- 殼裡的接線：prefs.vibrate*、推播開關 ----
// 用 m.html 裡真的那一行標籤當樣板；setNotifyPref、setPush 從 m.js 原始碼取出來照原樣執行，所以殼的接線改壞測試會紅。
function hostFor(layout, pushState = 'granted') {
  const js = read('../ui/m.js')
  const setNotifySrc = /const (setNotifyPref = [^\n]*)/.exec(js)?.[1]
  const setPushSrc = /setPush: (on => \{[^\n]*?\}),/.exec(js)?.[1]
  assert.ok(setNotifySrc && setPushSrc, 'm.js 找不到 setNotifyPref／setPush')
  const calls = []
  const Host = {
    components: { AsnNotifyPanel },
    setup() {
      const { reactive } = globalThis.Vue
      const prefs = reactive({ vibrateNudge: true, vibrateMsg: false, push: true })
      const push = { enable: () => calls.push('enable'), disable: () => { calls.push('disable'); return Promise.resolve() } }
      const setNotifyPref = new Function('prefs', `const ${setNotifySrc}; return setNotifyPref`)(prefs)
      const setPush = new Function('prefs', 'push', `return ${setPushSrc}`)(prefs, push)
      return { prefs, notifyList: notifyItems(capsAndroid), notifyLayout: layout, pushView: pushSettingView(pushState, true), setNotifyPref, setPush }
    },
    template: MOBILE_TAG.replace(/><\/asn-notify-panel>$/, '>') + '</asn-notify-panel>',
  }
  return { Host, calls }
}

test('殼裡的接線：點震動開關改 prefs.vibrate*；點推播呼叫 setPush（開＝enable、關＝disable 並存 prefs.push）', async () => {
  const { Host, calls } = hostFor('stack')
  const m = mountComponent(Host)
  try {
    const boxes = m.findAll('input[type="checkbox"]')
    assert.deepEqual(boxes.map(b => b.checked), [true, false, true])
    await m.trigger(boxes[0], 'change', { checked: false })
    await m.trigger(boxes[1], 'change', { checked: true })
    assert.deepEqual([boxes[0].checked, boxes[1].checked], [false, true])
    await m.trigger(boxes[2], 'change', { checked: false })
    await m.trigger(boxes[2], 'change', { checked: true })
    assert.deepEqual(calls, ['disable', 'enable'])
  } finally { m.unmount() }
})

test('殼裡的接線：prefs 欄位真的被改（vibrateNudge、vibrateMsg、push）', async () => {
  const js = read('../ui/m.js')
  const setNotifySrc = /const (setNotifyPref = [^\n]*)/.exec(js)?.[1]
  const prefs = {}
  const setNotifyPref = new Function('prefs', `const ${setNotifySrc}; return setNotifyPref`)(prefs)
  setNotifyPref({ key: 'vibrateNudge', on: false }); setNotifyPref({ key: 'vibrateMsg', on: true })
  assert.deepEqual(prefs, { vibrateNudge: false, vibrateMsg: true })
  const setPushSrc = /setPush: (on => \{[^\n]*?\}),/.exec(js)?.[1]
  const calls = []
  const setPush = new Function('prefs', 'push', `return ${setPushSrc}`)(prefs, { enable: () => calls.push('e'), disable: () => { calls.push('d'); return Promise.resolve() } })
  setPush(true); setPush(false)
  assert.equal(prefs.push, false); assert.deepEqual(calls, ['e', 'd'])
})
