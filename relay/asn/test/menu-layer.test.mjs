// 彈出選單的層級（#392）：.av-menu 寫在後面、同樣的權重，會把各選單的 fixed／層級蓋回 absolute／31，選單就被個人資訊區（.me，50）壓住
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const css = fs.readFileSync(new URL('../ui/style.css', import.meta.url), 'utf8')
const ruleOf = sel => css.split('\n').find(l => l.split('{')[0].split(',').map(s => s.trim()).includes(sel)) ?? ''
const zOf = sel => Number(/z-index:(\d+)/.exec(ruleOf(sel))?.[1] ?? NaN)

test('「＋」、名單右鍵、設備、分頁右鍵選單：同時帶 av-menu 時仍是 fixed，層級高過個人資訊區', () => {
  const me = zOf('.me')
  for (const sel of ['.av-menu.launch-picker', '.av-menu.buddy-menu', '.av-menu.device-menu', '.av-menu.ctab-menu']) {
    assert.match(ruleOf(sel), /position:fixed/, sel)
    assert.ok(zOf(sel) > me, `${sel} 的層級要高過 .me（${me}）`)
  }
  assert.ok(zOf('.av-menu.buddy-subpop') > zOf('.av-menu.buddy-menu'), '二級選單要比主選單高一層')
})

// 活躍度頁籤的三種燈號（#372）：活躍、閒置以前都退回 .dot 預設的綠，看起來是「綠、綠、灰」
test('活躍度三個級別都有自己的燈號樣式：活躍綠實心、閒置綠空心、離線灰', async () => {
  const { ACTIVITY_LEVELS } = await import('../ui/lib/activity.mjs')
  for (const [key] of ACTIVITY_LEVELS) assert.match(css, new RegExp(`\.dot\.st-${key}\{`), key)
  assert.match(css, /\.dot\.st-active\{--frame:var\(--online\)\}/)
  assert.match(css, /\.dot\.st-idle\{background:transparent;box-shadow:inset 0 0 0 2px var\(--online\)\}/)
  assert.match(css, /\.dot\.st-offline\{--frame:var\(--offline\)\}/)
})
