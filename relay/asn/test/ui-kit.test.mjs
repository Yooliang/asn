// 共用畫面元件（#2105）：按鈕三級與狀態、原位確認（取消在左、確定在右）、狀態行五種寫法；設計變數不寫死 px 的守門。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { AsnButton, AsnConfirm, AsnNote, AsnStatus, BTN_LEVELS, BTN_STATES, NOTE_KINDS, STATUS_KINDS, STATUS_TEXT, btnView, noteView, statusView } from '../ui/lib/ui-kit.mjs'
import { mountComponent } from './helpers/render.mjs'

const read = p => fs.readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const settle = async m => { for (let i = 0; i < 4; i++) { await new Promise(r => setTimeout(r, 0)); await m.nextTick() } }

test('#2105 按鈕畫法：三級、五種狀態；不合法的級別與狀態退回一般，畫不出規範外的樣子', () => {
  assert.deepEqual([...BTN_LEVELS], ['primary', 'secondary', 'text'])
  assert.deepEqual(btnView({ level: 'primary' }).classes, ['asn-btn', 'lv-primary'])
  assert.deepEqual(btnView({}).classes, ['asn-btn', 'lv-secondary'])
  assert.deepEqual(btnView({ level: 'huge', state: 'rainbow' }).classes, ['asn-btn', 'lv-secondary'], '不認得的級別與狀態退回一般')
  // 使用中、切換中、不能做：一律不能按；黃色與紅色可以按
  for (const st of ['current', 'busy', 'blocked']) assert.equal(btnView({ state: st }).disabled, true, st)
  for (const st of ['', 'danger', 'relogin']) assert.equal(btnView({ state: st }).disabled, false, st)
  assert.equal(btnView({ disabled: true }).disabled, true)
  assert.deepEqual([...BTN_STATES], ['', 'danger', 'current', 'busy', 'blocked', 'relogin'])
})

test('#2105 AsnButton：能按的才送出 click；使用中／切換中／不能做按了沒有反應', async () => {
  const mk = (props = {}) => mountComponent(AsnButton, props, { slots: { default: () => '走' } })
  const m = mk({ level: 'primary' })
  try {
    await settle(m)
    await m.trigger(m.find('button'), 'click'); assert.equal(m.emitted('click').length, 1, '一般鈕按得動')
  } finally { m.unmount() }
  for (const state of ['current', 'busy', 'blocked']) {
    const x = mk({ state })
    try {
      await settle(x)
      const bt = x.find('button')
      assert.equal(bt.disabled, true, state)
      await x.trigger(bt, 'click'); assert.equal(x.emitted('click').length, 0, `${state}：按了沒有反應`)
      assert.ok(bt.className.includes(`st-${state}`), state)
    } finally { x.unmount() }
  }
})

test('#2105 AsnConfirm：取消在左、同意在右（右邊是主要鈕）；各自只送出自己的事件', async () => {
  const m = mountComponent(AsnConfirm, { text: '會下載官方安裝程式', yes: '同意並安裝', no: '先不要' })
  try {
    await settle(m)
    const btns = m.findAll('button')
    assert.deepEqual(btns.map(b => b.textContent.trim()), ['先不要', '同意並安裝'], '取消在左、同意在右')
    assert.ok(btns[1].className.includes('lv-primary') && btns[0].className.includes('lv-secondary'), '同意是主要鈕、取消是次要鈕')
    assert.match(m.container.textContent, /會下載官方安裝程式/)
    await m.trigger(btns[0], 'click'); assert.deepEqual(m.emitted().map(e => e[0]), ['no'])
    await m.trigger(btns[1], 'click'); assert.deepEqual(m.emitted().map(e => e[0]), ['no', 'yes'])
  } finally { m.unmount() }
})

test('#2105 AsnConfirm：沒給「取消」文字時預設寫「取消」；忙碌時兩顆都不能按', async () => {
  const m = mountComponent(AsnConfirm, { text: 'x', yes: '好', busy: true })
  try {
    await settle(m)
    const btns = m.findAll('button')
    assert.equal(btns[0].textContent.trim(), '取消')
    assert.ok(btns.every(b => b.disabled))
  } finally { m.unmount() }
})

test('#2105 狀態行：五種各一種寫法；進行中有轉圈、讀不到才有「重試」', async () => {
  assert.deepEqual([...STATUS_KINDS], ['busy', 'ok', 'fail', 'empty', 'unreadable'])
  assert.equal(statusView({ kind: 'busy' }).spin, true)
  assert.equal(statusView({ kind: 'ok' }).spin, false)
  assert.equal(statusView({ kind: 'nonsense' }).kind, 'empty', '不認得的種類當「空」')
  assert.equal(statusView({ kind: 'fail', retry: true }).retry, false, '失敗不附重試（要重試就再按原本的操作）')
  assert.equal(statusView({ kind: 'unreadable', retry: true }).retry, true)
  const busy = mountComponent(AsnStatus, { kind: 'busy' })
  const unread = mountComponent(AsnStatus, { kind: 'unreadable', text: '讀不到名單', retry: true })
  try {
    await settle(busy); await settle(unread)
    const p = busy.find('p.asn-status')
    assert.ok(p.className.includes('k-busy') && p.querySelector('.asn-spin'), '進行中有轉圈')
    assert.match(p.textContent, new RegExp(STATUS_TEXT.loading), '沒給文字時進行中寫「正在讀取…」')
    const q = unread.find('p.asn-status')
    assert.equal(q.getAttribute('role'), 'status')
    const retry = q.querySelector('button')
    assert.equal(retry.textContent.trim(), STATUS_TEXT.retry)
    assert.ok(retry.className.includes('lv-text'), '重試是文字鈕')
    await unread.trigger(retry, 'click'); assert.equal(unread.emitted('retry').length, 1)
  } finally { busy.unmount(); unread.unmount() }
})

// ---- #2425 AsnNote ----
const withWarnCapture = async fn => {
  const orig = console.warn; const msgs = []
  console.warn = (...a) => msgs.push(a.join(' '))
  try { await fn() } finally { console.warn = orig }
  return msgs
}

test('#2425 提示的畫法：只有 info（role=note）和 warn（role=status）；warn 沒有動作就不合法；種類不認得退回 info；橫幅加 class', () => {
  assert.deepEqual([...NOTE_KINDS], ['info', 'warn'])
  const info = noteView('info', false)
  assert.deepEqual(info.classes, ['asn-note', 'asn-note-info']); assert.equal(info.role, 'note'); assert.equal(info.valid, true)
  const warn = noteView('warn', true)
  assert.deepEqual(warn.classes, ['asn-note', 'asn-note-warn']); assert.equal(warn.role, 'status'); assert.equal(warn.valid, true)
  assert.equal(noteView('warn', false).valid, false, 'warn 沒有動作不合法')
  assert.equal(noteView('info', false).valid, true, 'info 不要求動作')
  for (const bad of ['error', 'busy', 'ok', '', 'x']) {
    const v = noteView(bad, true)
    assert.equal(v.kind, 'info', `${bad} 退回 info`); assert.equal(v.role, 'note'); assert.equal(v.valid, false, '種類不合法就不算合法')
  }
  assert.ok(noteView('warn', true, true).classes.includes('asn-note-banner'))
  assert.ok(!noteView('warn', true).classes.includes('asn-note-banner'))
})

test('#2425 AsnNote 渲染：info 一行字；warn 附動作文字鈕、點了送 action；動作插槽可換內容', async () => {
  const info = mountComponent(AsnNote, {}, { slots: { default: () => '一般說明' } })
  const warn = mountComponent(AsnNote, { kind: 'warn', actionLabel: '重開', banner: true }, { slots: { default: () => '已停止' } })
  const slot = mountComponent(AsnNote, { kind: 'warn' }, { slots: { default: () => '要登入', action: () => 'X' } })
  try {
    await settle(info); await settle(warn); await settle(slot)
    const p = info.find('p.asn-note')
    assert.equal(p.getAttribute('role'), 'note'); assert.ok(p.className.includes('asn-note-info')); assert.ok(!p.querySelector('button'))
    const w = warn.find('p.asn-note')
    assert.equal(w.getAttribute('role'), 'status'); assert.ok(w.className.includes('asn-note-warn') && w.className.includes('asn-note-banner'))
    const b = w.querySelector('button'); assert.equal(b.textContent.trim(), '重開'); assert.ok(b.className.includes('lv-text'))
    await warn.trigger(b, 'click'); assert.equal(warn.emitted('action').length, 1)
    assert.equal(slot.find('.asn-note-action').textContent.trim(), 'X')
  } finally { info.unmount(); warn.unmount(); slot.unmount() }
})

test('#2425 AsnNote：warn 沒有動作、或種類不認得，會 console.warn；正常寫法不吵', async () => {
  const mount = async props => { const m = mountComponent(AsnNote, props, { slots: { default: () => 'x' } }); try { await settle(m) } finally { m.unmount() } }
  const noAction = await withWarnCapture(() => mount({ kind: 'warn' }))
  assert.ok(noAction.some(s => s.includes('warn 一定要附一個動作')), noAction.join('|'))
  const badKind = await withWarnCapture(() => mount({ kind: 'error' }))
  assert.ok(badKind.some(s => s.includes('不認得的種類')), badKind.join('|'))
  assert.deepEqual(await withWarnCapture(() => mount({ kind: 'warn', actionLabel: '重開' })), [])
  assert.deepEqual(await withWarnCapture(() => mount({})), [])
})

// 守門：原始碼裡寫了 warn 的 AsnNote 就一定要有動作。涵蓋的寫法：
//  - 模板：<asn-note>／<AsnNote>，kind="warn"、kind='warn'、:kind="'warn'"（也含三元裡的 'warn'），屬性值可含 >，可多行，可自閉合 <asn-note … />
//  - 有動作＝action-label／actionLabel 有非空的值，或有 #action／v-slot:action 插槽（空的 action-label="" 不算）
//  - 渲染函式：h(AsnNote, { kind: 'warn', … }, …)，要有非空的 actionLabel 或 action 插槽
// 已知限制：kind 完全是變數（沒有 'warn' 字面值）看不出來，只靠執行時的 console.warn
const TAG_ATTRS = '(?:"[^"]*"|\'[^\']*\'|[^<>"\'])'
const NOTE_TAG = new RegExp(`<(?:asn-note|AsnNote)\\b(${TAG_ATTRS}*?)\\/>|<(asn-note|AsnNote)\\b(${TAG_ATTRS}*)>([\\s\\S]*?)<\\/\\2>`, 'g')
const KIND_WARN = /(?:^|\s):?kind\s*=\s*(?:"[^"]*\bwarn\b[^"]*"|'[^']*\bwarn\b[^']*')/
const LABEL_SET = /(?:^|\s):?(?:action-label|actionLabel)\s*=\s*(?:"[^"]+"|'[^']+')/
const parenBody = (src, i) => { // i 在 '(' 之後；回傳到對應的 ')' 之前
  let depth = 1
  for (let j = i; j < src.length; j++) {
    const c = src[j]
    if (c === '"' || c === "'" || c === '`') { for (j++; j < src.length && src[j] !== c; j++) if (src[j] === '\\') j++; continue }
    if (c === '(') depth++
    else if (c === ')' && --depth === 0) return src.slice(i, j)
  }
  return src.slice(i)
}
export const warnNotesWithoutAction = src => {
  const bad = []
  for (const m of src.matchAll(NOTE_TAG)) {
    const attrs = m[1] ?? m[3] ?? ''; const body = m[4] ?? ''
    if (!KIND_WARN.test(attrs)) continue
    if (LABEL_SET.test(attrs) || /<template\s+(?:#action|v-slot:action)\b/.test(body)) continue
    bad.push(m[0].slice(0, 80))
  }
  for (const m of src.matchAll(/\bh\(\s*AsnNote\s*,/g)) {
    const call = parenBody(src, m.index + m[0].length)
    if (!/\bkind\s*:\s*(?:'[^']*\bwarn\b[^']*'|"[^"]*\bwarn\b[^"]*"|`[^`]*\bwarn\b[^`]*`)/.test(call)) continue
    if (/\bactionLabel\s*:\s*(?!(?:''|""|``)\s*[,}])\S/.test(call) || /\baction\s*:/.test(call)) continue
    bad.push(m[0] + call.slice(0, 70))
  }
  return bad
}

test('#2425 守門：ui 底下沒有「warn 卻沒附動作」的 <asn-note>；偵測是真的', () => {
  const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? (e.name === 'vendor' ? [] : walk(`${d}/${e.name}`)) : /\.(html|js|mjs)$/.test(e.name) ? [`${d}/${e.name}`] : [])
  const files = walk(fileURLToPath(new URL('../ui', import.meta.url)))
  assert.ok(files.length > 50, `前提：要掃得到 ui 的檔案（只掃到 ${files.length}）`)
  const hits = files.flatMap(f => warnNotesWithoutAction(fs.readFileSync(f, 'utf8')).map(h => `${f}：${h}`))
  assert.deepEqual(hits, [], 'warn 一定要附動作（action-label 或 #action 插槽）')
  assert.equal(warnNotesWithoutAction('<asn-note kind="warn">只有字</asn-note>').length, 1)
  assert.equal(warnNotesWithoutAction('<asn-note kind="warn" action-label="重開">字</asn-note>').length, 0)
  assert.equal(warnNotesWithoutAction('<asn-note kind="warn">字<template #action><button>x</button></template></asn-note>').length, 0)
  assert.equal(warnNotesWithoutAction('<asn-note>一般</asn-note>').length, 0)
  assert.equal(warnNotesWithoutAction('<asn-note v-if="n > 0" kind="warn">只有字</asn-note>').length, 1, '屬性值裡有 > 也要抓到')
  assert.equal(warnNotesWithoutAction(`<asn-note kind='warn'>只有字</asn-note>`).length, 1, '單引號')
  assert.equal(warnNotesWithoutAction(`<asn-note :kind="'warn'">只有字</asn-note>`).length, 1, '綁定寫法')
  assert.equal(warnNotesWithoutAction('<asn-note v-if="n > 0" kind="warn" action-label="重開">字</asn-note>').length, 0)
  assert.equal(warnNotesWithoutAction('<AsnNote kind="warn">只有字</AsnNote>').length, 1, '大駝峰寫法')
  assert.equal(warnNotesWithoutAction('<asn-note kind="warn" action-label="">只有字</asn-note>').length, 1, '空的 action-label 不算動作')
  assert.equal(warnNotesWithoutAction('<asn-note\n  v-if="a > 1"\n  kind="warn"\n>只有字</asn-note>').length, 1, '多行標籤')
  assert.equal(warnNotesWithoutAction('<asn-note kind="warn" />').length, 1, '自閉合')
  assert.equal(warnNotesWithoutAction('<asn-note kind="warn" action-label="重開" />').length, 0, '自閉合附動作')
  assert.equal(warnNotesWithoutAction('<p><asn-note kind="warn" /></p><asn-note>一般</asn-note>').length, 1, '自閉合後面接著別的 asn-note 不誤吞')
  assert.equal(warnNotesWithoutAction(`h(AsnNote, { kind: 'warn' }, () => '字')`).length, 1, '渲染函式')
  assert.equal(warnNotesWithoutAction(`h(AsnNote, { kind: 'warn', actionLabel: '重開' }, () => '字')`).length, 0)
  assert.equal(warnNotesWithoutAction(`h(AsnNote, { kind: 'warn', actionLabel: '' }, () => '字')`).length, 1, '渲染函式空的 actionLabel')
  assert.equal(warnNotesWithoutAction(`h(AsnNote, { kind: 'warn' }, { default: () => '字', action: () => h('b') })`).length, 0, '渲染函式的 action 插槽')
})

test('#2425 AsnNote：有條件的 #action 插槽會跟著出現／消失；消失時不留空按鈕並警告', async () => {
  let setCan
  const Host = {
    components: { AsnNote },
    setup() { const can = globalThis.Vue.ref(false); setCan = v => { can.value = v }; return { can } },
    template: `<asn-note kind="warn">要處理<template v-if="can" #action><button class="act">去處理</button></template></asn-note>`,
  }
  const msgs = []
  const orig = console.warn; console.warn = (...a) => msgs.push(a.join(' '))
  const m = mountComponent(Host, {})
  try {
    await settle(m)
    assert.ok(!m.find('.asn-note-action'), '一開始沒有動作，不畫動作區')
    assert.ok(msgs.some(s => s.includes('warn 一定要附一個動作')), '沒動作要警告')
    setCan(true); await settle(m)
    assert.equal(m.find('.act')?.textContent, '去處理', '後來有了，按鈕要出現')
    const n = msgs.length
    setCan(false); await settle(m)
    assert.ok(!m.find('.act') && !m.find('.asn-note-action') && !m.find('button'), '又沒有了，按鈕與空殼都要消失')
    assert.ok(msgs.length > n, '從有變沒有要再警告')
  } finally { console.warn = orig; m.unmount() }
})

test('#2105 設計變數守門：kit.css 的字級、間距、鈕高都走變數，不寫死 px（變數表本身除外）', () => {
  const css = read('../ui/kit.css')
  const noVars = css.replace(/:root\{[^}]*\}/g, '').replace(/\.m-body\{[^}]*\}/g, '')
  assert.doesNotMatch(noVars, /font-size:\s*\d/, '字級要用 --fs-*')
  assert.doesNotMatch(noVars, /(?:^|[;{\s])(?:padding|margin|gap|row-gap|column-gap)\s*:[^;}]*\d+px/, '間距要用 --sp-*')
  assert.doesNotMatch(noVars, /min-height:\s*\d+px/, '鈕高要用 --btn-h')
  for (const v of ['--sp-1', '--sp-2', '--sp-3', '--sp-4', '--sp-5', '--fs-1', '--fs-2', '--fs-3', '--fs-4', '--btn-h']) assert.match(css, new RegExp(`${v}:`), v)
  // 規範第五節：字級 4 檔、間距 5 檔
  assert.equal((css.match(/--fs-\d:/g) || []).length >= 4, true)
  assert.match(css, /\.m-body\{[^}]*--btn-h:40px/, '手機鈕高 40')
})

test('#2105 三個頁面都載入 kit.css（電腦主視窗、手機、分離的對話視窗）', () => {
  for (const f of ['list.html', 'm.html', 'chat.html']) assert.match(read(`../ui/${f}`), /<link rel="stylesheet" href="kit\.css">/, f)
})

test('#2105 第一個搬進來的畫面：設定頁「進行安裝」的確認走共用元件（取消在左），舊排版不留', () => {
  const panel = read('../ui/lib/settings-panel.mjs')
  assert.match(panel, /<asn-confirm class="launch-install-note"[^>]*@yes="act\('launch-install-yes'\)"[^>]*@no="act\('launch-install-no'\)"/)
  assert.match(panel, /components: \{ \.\.\.UI_KIT,/)
  assert.doesNotMatch(panel, /launch-install-btns/)
})
