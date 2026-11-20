// #1764 群組讀不到：原位要有白話提示和「重試」鈕，按下去要真的重新讀；電腦版與手機版同一句、同一個動作。
// 用真的 relay_rooms 失敗（createRoomHub 真的跑），再把 m.html／list.html 裡的真實樣板片段編譯、渲染、點按鈕。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import * as Vue from 'vue'
import { renderToString } from 'vue/server-renderer'
import { createRoomHub } from '../ui/lib/room-hub.mjs'
import { ROOM_LOAD_FAIL_TEXT } from '../ui/lib/mobile-rooms.mjs'
import { roomsNoteText } from '../ui/lib/relogin-bar.mjs'

const require = createRequire(import.meta.url)
const { compile } = require('@vue/compiler-dom')
const html = p => fs.readFileSync(new URL(`../ui/${p}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')

// 取出樣板裡「roomsNote 那一行」和緊接著的重試鈕那一行（真實檔案內容，不是自己抄一份）
const fragment = file => {
  const lines = html(file).split('\n')
  const i = lines.findIndex(l => l.includes('v-if="roomsNote"'))
  assert.ok(i >= 0, `${file} 找不到群組提示那一行`)
  return `<div>${lines[i]}\n${lines[i + 1]}</div>`
}
const renderFn = src => new Function('Vue', `${compile(src, { prefixIdentifiers: true, mode: 'function' }).code}`)(Vue)

async function failedHub() {
  let calls = 0, fail = true
  const hub = createRoomHub({ invoke: async cmd => { if (cmd !== 'relay_rooms') return {}; calls++; if (fail) throw new Error('relay_rooms 連線失敗'); return { rooms: [], signed: true } }, groupApi: {}, selfNode: 'T', windowName: 'w', onFail: () => {} })
  await hub.refresh()
  return { hub, calls: () => calls, heal: () => { fail = false } }
}

for (const [file, errName] of [['m.html', 'roomsErr'], ['list.html', 'hub.st.err']]) {
  test(`#1764 ${file}：第一次就讀不到（群組清單是空的）也看得到失敗提示和重試鈕，按重試會重新讀取`, async () => {
    const { hub, calls, heal } = await failedHub()
    assert.deepEqual(hub.rows(), [], '前提：沒有任何群組資料')
    const ctx = { roomsNote: roomsNoteText(hub.st), roomsErr: hub.st.err, hub, refreshRooms: () => hub.refresh() }
    const out = await renderToString(Vue.createSSRApp({ render: renderFn(fragment(file)) }).mixin({ beforeCreate() { Object.assign(this, ctx) } }))
    assert.ok(out.includes(ROOM_LOAD_FAIL_TEXT), `${file} 要顯示失敗提示：${out}`)
    assert.match(out, /<button[^>]*>重試<\/button>/, `${file} 要有重試鈕`)
    assert.ok(!/[A-Za-z_]{3,}/.test(out.replace(/<[^>]+>/g, '')), '畫面文字不夾英文或內部名稱')
    // 點按鈕：從 render 出來的 vnode 找到 onClick 真的呼叫
    const vnode = renderFn(fragment(file))(ctx, [])
    const btn = [].concat(vnode.children).find(c => c?.type === 'button')
    assert.ok(btn, '渲染結果有按鈕')
    const before = calls(); heal()
    await btn.props.onClick()
    assert.equal(calls(), before + 1, '按重試要重新呼叫 relay_rooms')
    assert.equal(hub.st.err, false)
    // 讀取成功後不再顯示重試鈕
    const ok = await renderToString(Vue.createSSRApp({ render: renderFn(fragment(file)) }).mixin({ beforeCreate() { Object.assign(this, { ...ctx, roomsNote: roomsNoteText(hub.st), roomsErr: hub.st.err, hub: { st: hub.st } }) } }))
    assert.ok(!ok.includes('重試'), '讀取成功後不留重試鈕')
  })
}

test('#1764 失敗提示只說發生什麼：沒有錯誤碼、內部名稱，也沒有「晚點再試」這種沒有動作的話', () => {
  assert.equal(ROOM_LOAD_FAIL_TEXT, '群組暫時讀不到。')
  assert.ok(!/[A-Za-z_]/.test(ROOM_LOAD_FAIL_TEXT))
})

test('#1764 重試鈕：電腦與手機同一個 class、同一條樣式（一份畫面一份樣式）', () => {
  const cls = f => [...html(f).matchAll(/<button class="([^"]+)"[^>]*@click="refreshRooms\(\)"/g)].map(m => m[1])
  assert.deepEqual(cls('m.html'), ['rooms-retry'], '手機的重試鈕')
  assert.deepEqual(cls('list.html'), ['rooms-retry'], '電腦的重試鈕')
  // 樣式只准寫一次，而且寫在兩邊都載入的樣式檔
  const sheets = fs.readdirSync(new URL('../ui/', import.meta.url)).filter(f => f.endsWith('.css'))
  const hits = sheets.flatMap(f => [...html(f).matchAll(/(^|[\s,}])\.rooms-retry\b[^{]*\{/g)].map(() => f))
  assert.deepEqual(hits, ['group.css'], `重試鈕的樣式要只寫在 group.css 一處：${hits}`)
  const links = f => [...html(f).matchAll(/href="([^"]+\.css)"/g)].map(m => m[1])
  for (const f of ['m.html', 'list.html']) assert.ok(links(f).includes('group.css'), `${f} 要載入 group.css`)
})
