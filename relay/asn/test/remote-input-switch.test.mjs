// 遠端打字不再跳確認框，改成這台設定頁的「允許遠端在這台打字」開關（預設開，#1745）：畫面與接線
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { SETTING_OPS } from '../ui/lib/settings-panel.mjs'
import { normalizeView } from '../ui/lib/known-peers.mjs'

const read = p => fs.readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const panel = read('../ui/lib/settings-panel.mjs'), list = read('../ui/list.js'), bridgeRs = read('../src-tauri/src/bridge/mod.rs'), lib = read('../src-tauri/src/lib.rs')


test('設定頁：有「允許遠端在這台打字」勾選，說明寫清楚紅條與關掉的效果，沒有內部名詞', () => {
  assert.match(panel, /:checked="st\.bridge\.remoteInput" :disabled="st\.bridge\.busy" @change="act\('bridge-remote-input', \$event\.target\.checked\)" aria-label="允許遠端在這台打字"/)
  assert.match(panel, /<span>允許遠端在這台打字<\/span>/)
  assert.match(panel, /關掉後，別台就不能在這台打字，看畫面不受影響/)
  assert.match(panel, /紅條會顯示誰在打字，你隨時可以按「結束」/)
  assert.ok(SETTING_OPS.includes('bridge-remote-input'), '動作清單有登記')
})

test('設定頁：舊的「這台要在這裡打字時，不用每次問我」整段拿掉', () => {
  assert.doesNotMatch(panel, /inputNoAsk|known-input-no-ask|inputFirstAsk/)
  assert.deepEqual(normalizeView({ peers: [{ node: 'a', name: 'A', input_no_ask: true, input_confirmed: true }] }).peers.map(p => Object.keys(p).filter(k => /input/i.test(k))), [[]], '舊資料裡的欄位直接忽略')
})

test('接線：預設開（舊後端沒有欄位也顯示開著）、開關呼叫 Rust 指令', () => {
  assert.match(list, /remoteInput: true/)
  assert.match(list, /remoteInput: s\.remote_input !== false/)
  assert.match(list, /case 'bridge-remote-input': await setBridgeRemoteInput\(value === true\)/)
  assert.match(list, /bridgeApi\.setRemoteInput\(on\)/)
  assert.match(fs.readFileSync(new URL('../ui/lib/tauri.mjs', import.meta.url), 'utf8'), /setRemoteInput: on => invoke\('bridge_set_remote_input', \{ on \}\)/)
  assert.match(list, /remoteInput: bridge\.remoteInput/, '傳給設定面板')
  assert.ok(!list.includes('input-consent-'), '畫面不再聽確認框的事件')
})

test('結束原因的白話：告訴對方去哪裡打開，名稱要跟設定頁實際放勾選的那一區一致', () => {
  const rs = read('../src-tauri/src/view_remote.rs')
  const text = rs.match(/"input_off" => "([^"]*)"/)?.[1]
  assert.ok(text, '有 input_off 的白話')
  assert.ok(text.includes('設定 → 視窗與系統匣') && text.includes('允許遠端在這台打字'), text)
  const cats = read('../ui/lib/settings-cats.mjs')
  assert.match(cats, /key: 'window', title: '視窗與系統匣'/)
  const before = panel.slice(0, panel.indexOf('aria-label="允許遠端在這台打字"'))
  assert.equal([...before.matchAll(/catKey === '([a-z]+)'/g)].pop()[1], 'window', '勾選框就在「視窗與系統匣」那一區')
})

test('Rust：存在 bridge.json 的 remote_input_off（預設開）；指令有登記；只有設定頁的命令能改', () => {
  assert.match(bridgeRs, /remote_input: !s\.remote_input_off/)
  assert.match(bridgeRs, /remote_input_off: d\.remote_input_off/)
  assert.match(read('../src-tauri/src/settings/docs.rs'), /deserialize_with = "lenient"\)\]\s*pub remote_input_off: bool/, '逐欄容錯與預設（缺欄位＝開）在 BridgeDoc')
  assert.match(lib, /fn bridge_set_remote_input\(/)
  assert.match(lib, /bridge_set_mobile_view, bridge_set_remote_input,/)
  const callers = [...lib.matchAll(/m\.set_remote_input\(/g)].length
  assert.equal(callers, 1, 'lib.rs 只有一個命令會改')
})

test('守門：打字開關在握手驗章之後才擋；進行中的打字每次也重讀', () => {
  assert.match(lib, /let allow_input = settings\.input_allowed\(\);/)
  assert.match(lib, /Refused::InputOff\) => \{\s*rej = "input_off";\s*Err\(view_stream::INPUT_OFF/)
  assert.match(lib, /reason == view_stream::INPUT_OFF && view_stream::stop_refused\(&r\)/, '舊後台不認得就退回 rejected')
  assert.match(lib, /st\.view_allowed\(self\.mobile\) && \(self\.input\.is_none\(\) \|\| st\.input_allowed\(\)\)/)
  assert.match(lib, /!st\.view_allowed\(self\.mobile\) \|\| !st\.input_allowed\(\)/)
})
