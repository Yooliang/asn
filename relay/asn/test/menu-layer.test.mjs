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

// 活躍度頁籤的燈（#372、小良哥 #950）：活躍綠、閒置黃、離線紅；名單「已封存」群組裡的頭像一律灰
test('活躍度頁籤：活躍綠、閒置黃、離線一定是紅（用 lv-，不跟上線狀態的 st-offline 灰共用）', async () => {
  const { ACTIVITY_LEVELS } = await import('../ui/lib/activity.mjs')
  for (const [key] of ACTIVITY_LEVELS) assert.match(css, new RegExp(`\\.dot\\.lv-${key}\\{`), key)
  assert.match(css, /\.dot\.lv-active\{--frame:var\(--online\)\}/)
  assert.match(css, /\.dot\.lv-idle\{--frame:var\(--away\)\}/)
  assert.match(css, /\.dot\.lv-offline\{--frame:var\(--busy\)\}/)
  const html = fs.readFileSync(new URL('../ui/list.html', import.meta.url), 'utf8')
  assert.ok(html.includes(`class="dot big" :class="'lv-' + d.dot"`), '頁籤的燈用 lv-')
})

test('名單「已封存」群組裡的夥伴燈號一律灰，不管實際在不在線', () => {
  const html = fs.readFileSync(new URL('../ui/list.html', import.meta.url), 'utf8')
  assert.ok(html.includes(`<span class="dp xs" :class="'st-' + (g.kind === 'archived' ? 'offline' : c.status)">`))
  assert.match(css, /\.dp\.st-offline,\.dot\.st-offline\{--frame:var\(--offline\)\}/, '灰＝--offline')
})
