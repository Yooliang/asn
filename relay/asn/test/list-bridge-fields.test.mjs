// 設定頁拿得到的 bridge 欄位：list.js 組給設定頁的物件，要涵蓋設定頁用到的每個 st.bridge.欄位（#872：曾漏傳，開關和「自動接回」勾選永遠顯示錯的）
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const listSrc = fs.readFileSync(new URL('../ui/list.js', import.meta.url), 'utf8')
const panelSrc = fs.readFileSync(new URL('../ui/lib/settings-panel.mjs', import.meta.url), 'utf8')
const m = listSrc.match(/bridge: bridge\.shown \? \{([^}]*)\} : null/)

test('list.js 組給設定頁的 bridge 物件找得到', () => {
  assert.ok(m, '找不到 bridge: bridge.shown ? { … } : null')
})

test('設定頁用到的每個 st.bridge 欄位都有傳過去', () => {
  const passed = new Set([...m[1].matchAll(/(\w+): bridge\.\w+/g)].map(x => x[1]))
  const used = new Set([...panelSrc.matchAll(/st\.bridge\.(\w+)/g)].map(x => x[1]))
  assert.ok(used.size >= 8, '設定頁用到的欄位數不對，檢查規則可能失效')
  const missing = [...used].filter(k => !passed.has(k))
  assert.deepEqual(missing, [])
})

test('開關相關欄位（含設定頁交給 term-server-setting 的）也要傳過去', () => {
  const passed = new Set([...m[1].matchAll(/(\w+): bridge\.\w+/g)].map(x => x[1]))
  for (const k of ['autoResume', 'termServer', 'termServerSupported', 'termServerActive', 'termServerLocked', 'termServerBackground']) {
    assert.ok(passed.has(k), `缺 ${k}`)
  }
})
