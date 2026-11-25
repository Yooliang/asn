// #2303 對話視窗最小寬度降到 500：Windows 11 貼齊分割版面規定最小寬度 ≤ 500 有效像素。
// 真正的「500 寬不跑版」量測在冒煙探測 chatMinWidth；這裡鎖住 Rust 那邊的常數，並確認探測量的寬度就是視窗的最小寬度。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { SCENARIOS } from '../scripts/smoke-lib.mjs'

const wins = fs.readFileSync(new URL('../src-tauri/src/wins.rs', import.meta.url), 'utf8').replace(/\r\n/g, '\n')

test('對話視窗的最小寬度常數 ≤ 500，開窗時用的就是它', () => {
  const m = wins.match(/const CHAT_MIN_W: f64 = ([\d.]+);/)
  assert.ok(m, '找不到 CHAT_MIN_W')
  assert.ok(Number(m[1]) <= 500, '最小寬度 ' + m[1] + ' 超過 500，貼不進分割版面')
  assert.match(wins, /chat\.html\?id=[\s\S]{0,300}\.min_inner_size\(CHAT_MIN_W, CHAT_MIN_H\)/, 'open_chat 沒有用 CHAT_MIN_W')
})

test('冒煙：三套外觀 × （一般對話、看終端）都在對話視窗最小寬度（500）量過', () => {
  const m = wins.match(/const CHAT_MIN_W: f64 = ([\d.]+);/)
  const s = SCENARIOS.filter(x => x.probe?.chatMinWidth)
  assert.equal(s.length, 6)
  for (const skin of ['aero', 'modern', 'line']) for (const term of [false, true]) {
    const x = s.find(y => y.probe.chatMinWidth.skin === skin && y.probe.chatMinWidth.term === term)
    assert.ok(x, `缺 ${skin} term=${term}`)
    assert.equal(x.width, Number(m[1]), '探測的視窗寬度要等於最小寬度')
    assert.match(x.page, /^chat\.html/)
  }
})
