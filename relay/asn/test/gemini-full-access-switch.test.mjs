// #2348：「Gemini 背景工作者可以寫檔和執行指令」開關（預設關）：畫面與接線
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { SETTING_OPS } from '../ui/lib/settings-panel.mjs'

const read = p => fs.readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const panel = read('../ui/lib/settings-panel.mjs'), list = read('../ui/list.js'), bridgeRs = read('../src-tauri/src/bridge/mod.rs'), lib = read('../src-tauri/src/lib.rs')

test('設定頁：有勾選與完整說明，動作有登記', () => {
  assert.match(panel, /:checked="st\.bridge\.geminiFullAccess" :disabled="st\.bridge\.busy" @change="act\('bridge-gemini-full-access', \$event\.target\.checked\)" aria-label="Gemini 背景工作者可以寫檔和執行指令"/)
  assert.ok(panel.includes('讓 Gemini 能寫檔和執行指令。寫到工作資料夾以外時，ASN 會中止那一輪，但那一次可能已經寫出去；執行指令可能動到資料夾以外的地方。切換後，正在跑的 Gemini 會馬上重開套用。'))
  assert.ok(SETTING_OPS.includes('bridge-gemini-full-access'))
})

test('接線：預設關、只有明確 true 才當開，呼叫 Rust 指令', () => {
  assert.match(list, /geminiFullAccess: false/)
  assert.match(list, /geminiFullAccess: s\.gemini_full_access === true/)
  assert.match(list, /case 'bridge-gemini-full-access': await setBridgeGeminiFullAccess\(value === true\)/)
  assert.match(list, /geminiFullAccess: bridge\.geminiFullAccess/, '傳給設定面板')
  assert.match(read('../ui/lib/tauri.mjs'), /setGeminiFullAccess: on => invoke\('bridge_set_gemini_full_access', \{ on \}\)/)
})

test('Rust：欄位預設關、存 bridge.json、指令已登記、建工作者時讀它', () => {
  assert.match(bridgeRs, /gemini_full_access: s\.gemini_full_access/)
  assert.match(read('../src-tauri/src/settings/docs.rs'), /deserialize_with = "lenient"\)\]\s*pub gemini_full_access: bool/)
  assert.match(lib, /fn bridge_set_gemini_full_access\(/)
  assert.match(lib, /bridge_set_remote_input, bridge_set_gemini_full_access,/)
  assert.match(read('../src-tauri/src/bridge/engines/partner_queue.rs'), /permissions_for\(&req\.profile, env\.gemini_full_access\(\)\)/)
})
