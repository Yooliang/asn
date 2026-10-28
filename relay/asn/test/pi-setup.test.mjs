// 設定頁「pi 與 ASN 互通」（#240 方案 A）：畫面狀態、文案、接線。後端（pi install／remove）見 src-tauri 的 launch/pi_setup.rs。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import * as Vue from 'vue'
import { renderToString } from 'vue/server-renderer'
import { SettingsPanel } from '../ui/lib/settings-panel.mjs'
import { PI_SETUP_TEXT, normalizePiSetup, piSetupError, piSetupView } from '../ui/lib/pi-setup.mjs'

const read = (...p) => fs.readFileSync(new URL(`../${p.join('/')}`, import.meta.url), 'utf8')
const S = (o = {}) => ({ pi: true, ext: true, installed: false, stale: 0, ...o })

test('沒查到狀態不顯示這一區；沒有 pi 又沒裝過擴充：顯示說明與官方說明連結（#343）', () => {
  assert.equal(piSetupView(null), null)
  assert.equal(piSetupView(undefined), null)
  const miss = piSetupView(S({ pi: false }))
  assert.equal(miss.missing, true)
  assert.deepEqual(miss.lines, ['沒偵測到 pi，裝好後可以到設定開啟互通'])
  assert.match(miss.docUrl, /^https:\/\/github\.com\//, '官方說明的網址寫死在程式裡')
  assert.ok(!miss.showAsk && !miss.showRemove && !miss.showLogin, '沒有 pi：不給安裝或登入按鈕')
  assert.notEqual(piSetupView(S({ pi: false, installed: true })), null, '裝過就算 pi 暫時找不到也要能移除')
})

test('還沒啟用：先只有「啟用…」；按了才出現同意說明與「同意並安裝／取消」', () => {
  const a = piSetupView(S())
  assert.deepEqual([a.showAsk, a.showAgree, a.showCancel, a.showRemove, a.consent], [true, false, false, false, ''])
  assert.deepEqual(a.lines, [PI_SETUP_TEXT.off])
  const b = piSetupView(S(), { confirm: true })
  assert.deepEqual([b.showAsk, b.showAgree, b.showCancel, b.showRemove], [false, true, true, false])
  assert.equal(b.consent, PI_SETUP_TEXT.consent)
  assert.match(b.consent, /修改 pi 的設定檔/, '要講明會改設定')
  assert.match(b.consent, /隨時可以在這裡移除/, '要講明可以還原')
})

test('預設開啟：已啟用的說明講明「已替你的 pi 安裝，可在此關閉」；使用者關掉後改說已關閉自動安裝', () => {
  assert.match(PI_SETUP_TEXT.on, /已替你的 pi 安裝 ASN 擴充，可在此關閉/)
  assert.equal(piSetupView(S({ installed: true })).lines[0], PI_SETUP_TEXT.on)
  assert.equal(piSetupView(S({ installed: true })).removeLabel, '關閉並移除')
  assert.match(PI_SETUP_TEXT.removed, /不會再自動裝回/)
  assert.equal(piSetupView(S({ auto: true })).lines[0], PI_SETUP_TEXT.off)
  assert.equal(piSetupView(S({ auto: false })).lines[0], PI_SETUP_TEXT.offAuto)
  assert.match(PI_SETUP_TEXT.offAuto, /已關閉自動安裝/)
  assert.doesNotMatch(Object.values(PI_SETUP_TEXT).join(''), /收發室/)
})

test('已啟用：只有「移除」；有舊的失效擴充時多一個「清理並重新安裝」並說明', () => {
  const a = piSetupView(S({ installed: true }))
  assert.deepEqual([a.showRemove, a.showAsk, a.showAgree, a.showReinstall], [true, false, false, false])
  assert.deepEqual(a.lines, [PI_SETUP_TEXT.on])
  const b = piSetupView(S({ installed: true, stale: 2, auto: true }))
  assert.equal(b.showReinstall, true)
  assert.ok(b.lines.includes(PI_SETUP_TEXT.stale))
  assert.equal(piSetupView(S({ installed: true, stale: 2, ext: false })).showReinstall, false, '找不到擴充就不能重新安裝')
})

test('找不到 ASN 附的擴充：不能啟用，並說明原因；處理中所有按鈕鎖住', () => {
  const a = piSetupView(S({ ext: false }), { confirm: true })
  assert.deepEqual([a.showAsk, a.showAgree], [false, false])
  assert.ok(a.lines.includes(PI_SETUP_TEXT.noExt))
  const b = piSetupView(S(), { busy: true, confirm: true })
  assert.equal(b.busy, true)
  assert.equal(b.showAgree, false, '處理中不再顯示同意鈕，避免連按')
  assert.ok(b.lines.includes(PI_SETUP_TEXT.busy))
  assert.equal(b.consent, '')
})

test('已經啟用就不會再顯示同意說明（即使 confirm 還是 true）；訊息原樣帶出', () => {
  const v = piSetupView(S({ installed: true }), { confirm: true, msg: '已啟用。' })
  assert.equal(v.consent, '')
  assert.equal(v.msg, '已啟用。')
  assert.equal(piSetupView(S(), { msg: 5 }).msg, '', '壞值當空字串')
})

test('狀態正規化：壞值用保守預設（不啟用、沒有舊的）', () => {
  assert.deepEqual(normalizePiSetup(null), { pi: false, ext: false, installed: false, stale: 0, auto: true })
  assert.deepEqual(normalizePiSetup({ pi: 'yes', ext: 1, installed: 'true', stale: -3 }), { pi: false, ext: false, installed: false, stale: 0, auto: true })
  assert.equal(normalizePiSetup({ pi: true, auto: false }).auto, false, '只有明確 false 才算關閉自動安裝')
  assert.deepEqual(normalizePiSetup({ pi: true, ext: true, installed: true, stale: 2, auto: true }), { pi: true, ext: true, installed: true, stale: 2, auto: true })
})

test('錯誤訊息：加前綴並限長', () => {
  assert.equal(piSetupError(new Error('x')), `${PI_SETUP_TEXT.failed}x`)
  assert.equal(piSetupError('boom'), `${PI_SETUP_TEXT.failed}boom`)
  assert.ok(piSetupError(new Error('a'.repeat(500))).length <= PI_SETUP_TEXT.failed.length + 500)
})

test('文案：對使用者不說「收發室」（小良哥 #38），每一句都有講清楚', () => {
  for (const [k, v] of Object.entries(PI_SETUP_TEXT)) {
    assert.equal(typeof v, 'string', k)
    assert.ok(v.length > 0, k)
    assert.ok(!v.includes('收發室'), `${k} 不能出現「收發室」`)
  }
})

test('接線：設定頁有區塊與四個指令；樞紐只在使用者按同意才安裝，沒有任何自動安裝', () => {
  const panel = read('ui', 'lib', 'settings-panel.mjs')
  for (const op of ['pi-setup-ask', 'pi-setup-install', 'pi-setup-cancel', 'pi-setup-remove']) assert.ok(panel.includes(`act('${op}'`), op)
  const hub = read('ui', 'list.js')
  assert.match(hub, /case 'pi-setup-install': await runPiSetup\(\(\) => transport\.piSetupInstall\(\)/)
  assert.match(hub, /case 'pi-setup-remove': await runPiSetup\(\(\) => transport\.piSetupRemove\(\)/)
  const calls = [...hub.matchAll(/transport\.piSetupInstall\(\)/g)].length
  assert.equal(calls, 1, '安裝只從「同意並安裝」那個指令呼叫')
  assert.match(hub, /case 'pi-setup-ask': piSetup\.confirm = true/, '按「啟用…」只是打開同意說明，不安裝')
  const tauri = read('ui', 'lib', 'tauri.mjs')
  for (const c of ['pi_setup_status', 'pi_setup_install', 'pi_setup_remove']) assert.ok(tauri.includes(`'${c}'`), c)
  const lib = read('src-tauri', 'src', 'lib.rs')
  for (const c of ['pi_setup_status', 'pi_setup_install', 'pi_setup_remove']) assert.ok(lib.includes(`async fn ${c}(`) && lib.includes(`${c},`), `${c} 要定義也要註冊`)
})

// ---------- 真的用 Vue 轉成 HTML 看設定頁（啟動設定那一類） ----------
const render = async piSetup => {
  globalThis.Vue = Vue
  const st = { launch: { tools: [], maxPerHour: 6, cwdText: '' }, piSetup }
  const app = Vue.createSSRApp({ render: () => Vue.h(SettingsPanel, { st, catKey: 'launch', meAv: '' }) })
  return renderToString(app)
}
const buttons = html => [...html.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map(m => m[1])

test('畫面：沒有 pi＝整區不出現；還沒啟用＝只有「啟用…」，沒有同意說明', async () => {
  assert.ok(!(await render(null)).includes(PI_SETUP_TEXT.title))
  const html = await render(piSetupView(S()))
  assert.ok(html.includes(PI_SETUP_TEXT.title) && html.includes(PI_SETUP_TEXT.off))
  assert.deepEqual(buttons(html).filter(b => [PI_SETUP_TEXT.ask, PI_SETUP_TEXT.agree, PI_SETUP_TEXT.cancel, PI_SETUP_TEXT.remove].includes(b)), [PI_SETUP_TEXT.ask])
  assert.ok(!html.includes('修改 pi 的設定檔'))
})

test('畫面：按了「啟用…」才看得到同意說明與「同意並安裝／取消」', async () => {
  const html = await render(piSetupView(S(), { confirm: true }))
  assert.ok(html.includes('修改 pi 的設定檔'))
  assert.deepEqual(buttons(html).filter(b => [PI_SETUP_TEXT.ask, PI_SETUP_TEXT.agree, PI_SETUP_TEXT.cancel, PI_SETUP_TEXT.remove].includes(b)), [PI_SETUP_TEXT.agree, PI_SETUP_TEXT.cancel])
})

test('畫面：已啟用＝只有「移除」；處理中按鈕全部 disabled；訊息會顯示', async () => {
  const on = await render(piSetupView(S({ installed: true }), { msg: PI_SETUP_TEXT.installed }))
  assert.ok(on.includes(PI_SETUP_TEXT.on) && on.includes(PI_SETUP_TEXT.installed))
  assert.deepEqual(buttons(on).filter(b => [PI_SETUP_TEXT.ask, PI_SETUP_TEXT.agree, PI_SETUP_TEXT.remove].includes(b)), [PI_SETUP_TEXT.remove])
  const busy = await render(piSetupView(S({ installed: true }), { busy: true }))
  assert.ok(/<button[^>]*disabled[^>]*>關閉並移除<\/button>/.test(busy), '處理中移除鈕要鎖住')
})
