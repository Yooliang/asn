// 設備頁（#1715）：第一行「設定：設備」＋名字＋標籤，第二行「返回」加一排按鈕；內容在按鈕下面展開成卡片
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import * as Vue from 'vue'
import { renderToString } from 'vue/server-renderer'
import { SettingsPanel } from '../ui/lib/settings-panel.mjs'

const read = p => fs.readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const dev = (key, label, o = {}) => ({ key, label, self: false, kind: '電腦', online: true, onlineText: '在線', reportedText: '', stateLine: '', empty: '', vendors: [], ...o })
const devices = () => [
  dev('H', '工作機', { self: true, platform: 'windows', stateLine: 'Claude 已登入', vendors: [{ key: 'claude', label: 'Claude', accounts: [], account: '', reported: false, extra: '', switchable: false, switchHint: '' }] }),
  dev('W', '客廳電腦', { vendors: [{ key: 'claude', label: 'Claude', accounts: [], account: '', reported: false, extra: '', switchable: false, switchHint: '' }] }),
  dev('P', '小良的手機', { phone: true, kind: '手機', kindLabel: '手機' }),
  dev('C', '雲端節點', { cloud: true, kindLabel: '雲端', reportedText: '帳號回報讀取失敗', vendors: [{ key: 'grok', label: 'Grok', accounts: [], account: '', reported: false, extra: '', switchable: false, switchHint: '' }] }),
]
const TASKS = { total: 0, dupCount: 0, dupBanner: '', error: '', loaded: true, empty: true, rows: [], known: [], note: '', wakeNote: '', hints: [], confirm: null, busy: false }
const st = (over = {}) => ({ version: '0.2.31', devices: devices(), accounts: { list: [], current: null, msg: '', autoNote: '', busy: false, confirmDel: '' }, known: { ownFp: 'AABBCCDDEEFF00112233', qr: null, busy: false, peers: [], error: '', renameError: '' }, taskMgr: TASKS, ...over })
const render = async (props, state = st()) => {
  globalThis.Vue = Vue
  return renderToString(Vue.createSSRApp({ render: () => Vue.h(SettingsPanel, { st: state, meAv: '', catKey: 'devices', ...props }) }))
}
const bar = html => { const m = html.match(/<div class="dv-tabs"[\s\S]*?<\/div>/); assert.ok(m, '有那排按鈕'); return m[0] }
const labels = html => [...bar(html).matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map(m => m[1].trim())

test('頁首：第一行「設定：設備」＋名字＋標籤，第二行才是返回和按鈕', async () => {
  const html = await render({ dev: 'H' })
  assert.match(html, /class="dv-dev-h"[^>]*><span class="dv-pt">設定：設備<\/span><h3 class="dv-name">工作機<\/h3>[\s\S]*在線[\s\S]*這台/)
  assert.ok(html.indexOf('class="dv-tabs"') > html.indexOf('class="dv-name"'), '按鈕在名字那行下面')
})

test('「返回」跟旁邊的按鈕同一套（aero-btn），放在那排最左', async () => {
  const b = bar(await render({ dev: 'H' }))
  assert.match(b, /^<div class="dv-tabs"[^>]*><button class="aero-btn dv-back"[^>]*>‹ 返回<\/button>/)
})

test('四種設備各自有哪幾顆鈕', async () => {
  assert.deepEqual(labels(await render({ dev: 'H' })), ['‹ 返回', '工作管理員', '詳情', 'QR Code', '改名', '帳號'], '這台：五顆')
  assert.deepEqual(labels(await render({ dev: 'W' })), ['‹ 返回', '詳情', '改名', '帳號'], '別台電腦：沒有工作管理員、沒有 QR')
  assert.deepEqual(labels(await render({ dev: 'P' })), ['‹ 返回', '詳情', '改名'], '手機：沒有帳號可看')
  assert.deepEqual(labels(await render({ dev: 'C' })), ['‹ 返回', '詳情', '改名', '帳號'], '雲端節點：沒有指紋，不出 QR')
})

test('沒有指紋或沒有工作管理員資料時，對應的鈕不出', async () => {
  const noFp = st({ known: { ownFp: '', qr: null, busy: false, peers: [], error: '', renameError: '' } })
  assert.ok(!labels(await render({ dev: 'H' }, noFp)).includes('QR Code'))
  const noTm = st(); delete noTm.taskMgr
  assert.ok(!labels(await render({ dev: 'H' }, noTm)).includes('工作管理員'))
})

test('預設打開「詳情」，按下的那顆標 aria-pressed', async () => {
  const html = await render({ dev: 'W' })
  assert.match(bar(html), />詳情<\/button>/)
  assert.match(bar(html), /aria-pressed="true"[^>]*>詳情</)
  assert.match(html, /<h3 class="set-h">設備資料<\/h3>/)
  assert.match(bar(await render({ dev: 'W', devView: 'acct' })), /aria-pressed="true"[^>]*>帳號</)
})

test('「工作管理員」展開時，那排按鈕還在、工作管理員那顆亮起', async () => {
  const html = await render({ dev: 'H', devView: 'tasks' }, st())
  // 直接用元件內部狀態切過去：devView 只認 acct／info，所以用樞紐實際的做法——掛上後按鈕
  assert.ok(html.includes('class="dv-tabs"'))
  const src = read('../ui/lib/settings-panel.mjs')
  assert.match(src, /<div class="dv-tabs"[\s\S]*?<\/div>\s*<div class="tm" v-if="view === 'tasks' && st\.taskMgr">/, '按鈕組在工作管理員內容的上面，兩者同時存在')
  assert.match(src, /:aria-pressed="view === 'tasks'" @click="setView\('tasks'\)"/)
})

test('詳情：指紋、第一次連線；雲端節點寫「沒有設備指紋」，不寫「還沒連線過」，也不顯示帳號回報讀取失敗', async () => {
  const me = (await render({ dev: 'H' })).replace(/<!--.*?-->/g, '')
  assert.match(me, /<dt>狀態<\/dt>[\s\S]*<dt>指紋<\/dt>[\s\S]*AABB CCDD EEFF 0011 2233/)
  const cloud = await render({ dev: 'C' })
  assert.ok(cloud.includes('這是雲端節點，沒有設備指紋'))
  assert.ok(!cloud.includes('還沒連線過') && !cloud.includes('帳號回報讀取失敗'))
  const other = await render({ dev: 'W' })
  assert.ok(other.includes('還沒連線過，連上時會記住指紋'))
})

test('詳情的卡片標題用「設備資料」，不跟「這台」標籤混淆', async () => {
  const src = read('../ui/lib/settings-panel.mjs')
  assert.match(src, /<h3 class="set-h">設備資料<\/h3>/)
  assert.doesNotMatch(src, /<h3 class="set-h">這台設備<\/h3>/)
})

test('窄的時候整排不換行、平均排成一列（用面板寬度判斷）', () => {
  const css = read('../ui/style.css')
  assert.match(css, /\.dv-dev\{container-type:inline-size\}/)
  assert.match(css, /\.dv-tabs\{display:flex;align-items:center;flex-wrap:nowrap;/)
  assert.match(css, /@container \(max-width:480px\)\{[^\n]*\.dv-tabs\{gap:4px\}\.dv-tabs \.aero-btn\{flex:1 1 auto;min-width:0;/)
})

test('危險鈕：永久移除用 aero-btn danger', () => {
  const src = read('../ui/lib/settings-panel.mjs')
  assert.match(src, /<button class="aero-btn danger" type="button" @click="askRemove = true">/)
})

test('詳情的欄位：狀態只寫在線與否；系統、ASN 版本有資料才放；帳號的事不寫在狀態裡', async () => {
  const me = (await render({ dev: 'H' })).replace(/<!--.*?-->/g, '')
  assert.match(me, /<dt>狀態<\/dt><dd>在線，這台電腦<\/dd>/)
  assert.ok(!me.includes('Claude 已登入'), '狀態格不寫帳號狀態')
  assert.match(me, /<dt>系統<\/dt><dd>Windows<\/dd>/)
  assert.match(me, /<dt>ASN 版本<\/dt><dd>0\.2\.31<\/dd>/)
  const other = await render({ dev: 'W' })
  assert.ok(!other.includes('ASN 版本') && !other.includes('<dt>系統</dt>'), '別台沒有 platform 就不放，也不放本機的版本')
  const mac = st(); mac.devices[1].platform = 'android'
  assert.match(await render({ dev: 'W' }, mac), /<dt>系統<\/dt><dd>Android<\/dd>/)
})

test('指紋跟同一張表的其他值一樣大（只保留等寬字）；窄的時候工作管理員收掉次要欄位', () => {
  const css = read('../ui/style.css')
  assert.match(css, /\.dv-kv \.pair-fp\{font-size:inherit;/)
  assert.match(css, /@container \(max-width:480px\)\{\.tm-table th:nth-child\(2\),[^}]*nth-child\(3\)[^}]*nth-child\(7\)[^}]*display:none\}\.settings \.tm-table th,\.settings \.tm-table td\{padding:6px 4px\}\.settings \.tm-table \.aero-btn\{padding:3px 6px\}\}/)
})
