// 設定頁「夥伴共用同一個終端服務」開關（#868）：文字用使用者的話（不出現技術名詞）、被系統設定固定時反灰、
// 改了還沒生效要提示重開、非 Windows 不顯示；改設定只存檔，不動已開著的夥伴。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import * as Vue from 'vue'
import { renderToString } from 'vue/server-renderer'
import { SETTING_OPS, SettingsPanel } from '../ui/lib/settings-panel.mjs'
import { termServerNote, TERM_SERVER_LOCKED_NOTE, TERM_SERVER_OFF_NOTE, TERM_SERVER_ON_NOTE, TERM_SERVER_RESTART_NOTE } from '../ui/lib/term-server-setting.mjs'

const base = () => ({
  closeTo: 'tray', trayOk: true, autostart: { supported: true, on: false, busy: false },
  accounts: { list: [], current: null, codexLine: '', busy: false, confirmDel: '', msg: '', trustOwn: false, remote: { node: '', devices: [], list: [], loading: false, busy: false, msg: '' } },
})
const bridge = (o = {}) => ({ enabled: true, running: true, legacy: false, takeoverAllowed: false, remoteLaunch: false, autoResume: true, error: '', busy: false, confirm: false, termServerSupported: true, termServer: true, termServerActive: true, termServerLocked: false, ...o })
const render = async st => {
  globalThis.Vue = Vue
  return renderToString(Vue.createSSRApp({ render: () => Vue.h(SettingsPanel, { st, catKey: 'window' }) }))
}
const ALL_TEXT = [TERM_SERVER_ON_NOTE, TERM_SERVER_OFF_NOTE, TERM_SERVER_RESTART_NOTE, TERM_SERVER_LOCKED_NOTE].join('')

test('說明文字：不出現技術名詞，講清楚關掉會怎樣', () => {
  for (const bad of ['mux', 'MUX', 'WezTerm', 'wezterm', '環境變數', 'ASN_TERM', 'server', '伺服器']) {
    assert.ok(!ALL_TEXT.includes(bad), `給使用者看的字不要出現「${bad}」`)
  }
  assert.ok(TERM_SERVER_OFF_NOTE.includes('各自開一扇視窗') && TERM_SERVER_OFF_NOTE.includes('ASN 重開時夥伴不會繼續留著'), '關掉會怎樣要寫清楚')
  assert.ok(TERM_SERVER_RESTART_NOTE.includes('重開 ASN 後生效') && TERM_SERVER_RESTART_NOTE.includes('已開著的夥伴不會被搬動'), '什麼時候生效、已開著的夥伴怎麼樣')
})

test('說明：一般只講開與關；設定和這次啟動不同才加「重開後生效」', () => {
  const same = termServerNote({ termServer: true, termServerActive: true, termServerLocked: false })
  assert.ok(same.includes(TERM_SERVER_ON_NOTE) && same.includes(TERM_SERVER_OFF_NOTE) && !same.includes('重開 ASN 後生效'))
  const offNow = termServerNote({ termServer: false, termServerActive: true, termServerLocked: false })
  assert.ok(offNow.includes(TERM_SERVER_RESTART_NOTE), '剛關掉、這次還在用：要重開才生效')
  const onNow = termServerNote({ termServer: true, termServerActive: false, termServerLocked: false })
  assert.ok(onNow.includes(TERM_SERVER_RESTART_NOTE), '剛打開、這次沒在用：也要重開才生效')
  const offSame = termServerNote({ termServer: false, termServerActive: false, termServerLocked: false })
  assert.ok(!offSame.includes('重開 ASN 後生效'), '關著而且這次也沒用：沒有待生效的變更')
})

test('被系統設定固定：寫「已由系統設定固定」，不講重開（改了也沒用）', () => {
  const s = termServerNote({ termServer: true, termServerActive: false, termServerLocked: true })
  assert.ok(s.includes(TERM_SERVER_LOCKED_NOTE) && !s.includes('重開 ASN 後生效'))
  assert.equal(termServerNote(null), '')
})

test('畫面：Windows 顯示開關；固定時停用；其他平台不顯示', async () => {
  const on = await render({ ...base(), bridge: bridge() })
  assert.ok(on.includes('夥伴共用同一個終端服務'), on.slice(0, 200))
  assert.ok(/aria-label="夥伴共用同一個終端服務"/.test(on) && !/disabled[^>]*aria-label="夥伴共用同一個終端服務"|aria-label="夥伴共用同一個終端服務"[^>]*disabled/.test(on.replace(/<small[\s\S]*?<\/small>/g, '')), '一般狀態可以按')
  const locked = await render({ ...base(), bridge: bridge({ termServer: false, termServerActive: false, termServerLocked: true }) })
  const box = locked.match(/<input[^>]*aria-label="夥伴共用同一個終端服務"[^>]*>/)?.[0] ?? ''
  assert.ok(box.includes('disabled'), '被系統設定固定：反灰：' + box)
  assert.ok(locked.includes('已由系統設定固定'))
  const other = await render({ ...base(), bridge: bridge({ termServerSupported: false }) })
  assert.ok(!other.includes('夥伴共用同一個終端服務'), '非 Windows 不顯示')
})

test('畫面：忙碌時也停用，避免連按', async () => {
  const html = await render({ ...base(), bridge: bridge({ busy: true }) })
  assert.ok((html.match(/<input[^>]*aria-label="夥伴共用同一個終端服務"[^>]*>/)?.[0] ?? '').includes('disabled'))
})

test('接線：指令在清單裡、樞紐會分派、前端只呼叫存檔的命令', () => {
  assert.ok(SETTING_OPS.includes('bridge-term-server'), 'SETTING_OPS 要有這個指令（樞紐要接得住）')
  const list = fs.readFileSync(new URL('../ui/list.js', import.meta.url), 'utf8')
  assert.ok(list.includes("case 'bridge-term-server': await setBridgeTermServer(value === true); break"))
  assert.ok(list.includes("invoke('bridge_set_term_server', { on })"))
  const rust = fs.readFileSync(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8')
  assert.ok(rust.includes('fn bridge_set_term_server') && rust.includes('bridge_set_term_server, startup_info'), '命令要註冊')
})

test('守門：改設定只存檔，不動執行中的終端服務（已開著的夥伴不被搬動或關掉）', () => {
  const rust = fs.readFileSync(new URL('../src-tauri/src/bridge/mod.rs', import.meta.url), 'utf8')
  const f = rust.split('pub fn set_term_server(')[1].split('pub fn set_unaddressed_to')[0]
  assert.ok(f.includes('write_settings(') && f.includes('term_server_locked()'), '存檔，而且被固定時拒絕')
  // 只擋明確的服務操作；讀 win_term 的「被固定」旗標是必要的（所以不能擋 term::）
  assert.ok(!/set_use_mux|kill_tree|\.stop\(|stop_if_empty|reclaim|LiveTerms|mux_handle/.test(f), '這個函式不碰執行中的終端服務：' + f)
  const cmd = fs.readFileSync(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8').split('fn bridge_set_term_server(')[1].split('}')[0]
  assert.ok(!/set_use_mux|kill_tree|stop\(/.test(cmd), '命令只存檔')
})
