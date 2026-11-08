// 手機看別台電腦夥伴的終端（PR④）：畫面守門與冒煙假 Tauri 的事件
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import { injectSource, tableFor, SCENARIOS, mtermviewFrames } from '../scripts/smoke-lib.mjs'

const read = p => fs.readFileSync(new URL(p, import.meta.url), 'utf8')
const tag = (src, start) => { const i = src.indexOf(start); assert.ok(i >= 0, `找不到 ${start}`); return src.slice(i, src.indexOf('</chat-pane>', i)) }

test('m.html：對話分頁的 chat-pane 給看畫面三樣，不給打字', () => {
  const html = read('../ui/m.html')
  const t = tag(html, '<chat-pane v-if="chatFriend"')
  assert.match(t, /:view-active="nav\.tab === 'chats'"/)
  assert.match(t, /:self-node="selfNode"/)
  assert.match(t, /:remote-view-api="mobileRemoteViewApi"/)
  assert.doesNotMatch(t, /remote-input-api/, '手機只能看')
  assert.doesNotMatch(tag(html, '<chat-pane v-if="noticeChat"'), /remote-view-api/, '通知分頁不看終端')
  assert.match(read('../ui/m.js'), /mobileRemoteViewApi/)
})

test('chatpane：切換鈕只在手機且看得到時出現，字與電腦版同一份', () => {
  const src = read('../ui/lib/chatpane.mjs')
  assert.match(src, /const mSwitch = computed\(\(\) => props\.noBar && canRemote\.value\)/)
  assert.match(src, /class="m-term-switch"[^>]*v-if="mSwitch"/)
  assert.match(src, /\{\{ TERM_BTN_MSG\.label \}\}/)
  assert.match(src, /\{\{ TERM_BTN_TERM\.label \}\}/)
  assert.match(src, /watch\(remoteLive, a => \{ if \(!a\) remoteOn\.value = false \}\)/, '離開對話分頁就結束觀看')
  assert.match(src, /:active="remoteLive"/)
})

test('冒煙假 Tauri：listen 記下回呼，指令呼叫後依序送出 __emitOn 的事件', async () => {
  const table = { cmd_a: 1, __emitOn: { cmd_a: mtermviewFrames('z') } }
  const g = { setTimeout, JSON, Object, Array, Promise }
  g.globalThis = g
  vm.createContext(g)
  vm.runInContext(injectSource(table), g)
  const got = []
  const off = await g.__TAURI__.event.listen('term-view-remote-frame', e => got.push(e))
  await g.__TAURI__.core.invoke('cmd_a', {})
  await new Promise(r => setTimeout(r, 400))
  assert.equal(got.length, 4)
  assert.equal(got[0].event, 'term-view-remote-frame')
  assert.equal(got[0].payload.id, 'z')
  assert.equal(got[0].payload.meta.cols, 120)
  off()
  assert.equal(g.__smokeListeners['term-view-remote-frame'].length, 0)
})

test('冒煙情境：三個手機看終端情境帶齊假指令', () => {
  const names = SCENARIOS.filter(s => s.name.startsWith('m-term-view')).map(s => s.name)
  assert.deepEqual(names, ['m-term-view', 'm-term-view-360', 'm-term-view-big'])
  const t = tableFor(SCENARIOS.find(s => s.name === 'm-term-view'))
  assert.equal(t.term_view_remote_available, true)
  assert.equal(t.android_term_view_remote_start.id, 'v1')
  assert.ok(t.android_term_view_remote_start.expires_s > Date.now() / 1000)
  assert.ok(t.__emitOn.android_term_view_remote_start.length >= 2)
  assert.ok(!('term_view_remote_start' in t), '冒煙也不給電腦版的發起指令：手機走電腦版就會失敗')
})

test('守門：手機頁不准直接用電腦版的 remoteViewApi（會跳過生物辨識）；只能用 mobileRemoteViewApi', () => {
  // m.js、m.html 裡出現的 remoteViewApi 一律要是 mobileRemoteViewApi（註解除外）
  const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/.*$/gm, '').replace(/<!--[\s\S]*?-->/g, '')
  // 手機頁：m.js、m.html，以及 ui/lib 下所有 mobile*.mjs（mobile-remote-view.mjs 本身除外：只有它能包裝電腦版的 available／pause／stop）
  const mobileLibs = fs.readdirSync(new URL('../ui/lib/', import.meta.url)).filter(x => /^mobile.*\.mjs$/.test(x) && x !== 'mobile-remote-view.mjs').map(x => `../ui/lib/${x}`)
  assert.ok(mobileLibs.length >= 5, '有找到手機的模組')
  for (const f of ['../ui/m.js', '../ui/m.html', ...mobileLibs]) {
    const code = strip(read(f))
    // 大小寫有別：mobileRemoteViewApi（大寫 R）不會被 \bremoteViewApi 比到
    assert.equal([...code.matchAll(/\bremoteViewApi\b/g)].length, 0, `${f} 直接用了 remoteViewApi`)
    assert.doesNotMatch(code, /from '\.\/lib\/tauri\.mjs'[^\n]*\bremoteViewApi\b/, `${f} 不能從 tauri.mjs 匯入 remoteViewApi`)
  }
  // 手機那一份的發起不能是電腦版的 start（電腦版不過生物辨識）
  const mob = read('../ui/lib/mobile-remote-view.mjs')
  assert.doesNotMatch(mob, /start:\s*remoteViewApi\.start/)
  assert.doesNotMatch(mob, /\.\.\.remoteViewApi/, '不能整包展開電腦版的介面（會帶進電腦版的 start）')
  assert.match(mob, /start: \(toNode, partner, machine\) => invoke\(MOBILE_START_CMD,/)
})
