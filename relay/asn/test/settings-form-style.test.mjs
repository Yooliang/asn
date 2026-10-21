// 設定表單的統一風格與「更新」頁的排版：
// 1. 勾選框那條規則（label.chk）原本沒生效，是因為權重輸給設定表單的 label 規則——這裡用權重計算守住，以後有人再改回去會紅。
// 2. 更新頁是一張卡片：勾選框＋文字同一行、下一行「立即檢查」＋狀態、再下面是更新記錄。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import * as Vue from 'vue'
import { renderToString } from 'vue/server-renderer'
import { SettingsPanel } from '../ui/lib/settings-panel.mjs'
import { formatCheckTime, updateStatus } from '../ui/lib/update.mjs'

const css = fs.readFileSync(new URL('../ui/style.css', import.meta.url), 'utf8').replace(/\r\n/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '')

// 簡化的選擇器權重（只認這個樣式表用到的寫法）：[id, class／屬性／偽類, 元素]
function specificity(sel) {
  let s = sel.replace(/:not\(([^)]*)\)/g, ' $1 ')   // :not() 的權重是括號裡的
  const b = (s.match(/\.[\w-]+|\[[^\]]*\]|:(?!not)[\w-]+/g) ?? []).length
  const a = (s.match(/#[\w-]+/g) ?? []).length
  const c = (s.replace(/\.[\w-]+|\[[^\]]*\]|:[\w-]+|#[\w-]+/g, ' ').match(/(^|[\s>+~])[a-z][\w-]*/gi) ?? []).length
  return [a, b, c]
}
const cmp = (x, y) => { for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0 }

// 樣式規則（不處理 @media 巢狀；這個樣式表的設定規則都在最上層）
const rules = [...css.matchAll(/(^|\n)\s*([^@{}\s][^{}]*)\{([^}]*)\}/g)].map(m => ({ sels: m[2].split(',').map(s => s.trim()), body: m[3] }))
const declares = (r, prop, val) => new RegExp(`${prop}\\s*:\\s*${val}`).test(r.body)

test('權重計算本身：.settings input 比 label.chk 重——就是當初輸掉的原因', () => {
  assert.deepEqual(specificity('label.chk'), [0, 1, 1])
  assert.deepEqual(specificity('.list.settings label'), [0, 2, 1])
  assert.deepEqual(specificity('.settings input:not([type=checkbox])'), [0, 2, 1])
  assert.ok(cmp(specificity('.list.settings label'), specificity('label.chk')) > 0)
})

test('勾選框那行（label.chk）的排版規則，權重一定贏過設定表單的直排 label 規則', () => {
  const colRules = rules.filter(r => declares(r, 'flex-direction', 'column')).flatMap(r => r.sels.map(sel => ({ sel, r })).filter(x => /(^|\s)label(\s|$|[.:#[])/.test(x.sel) && /settings/.test(x.sel)))
  assert.ok(colRules.length > 0, '找得到把設定 label 排成直的那條規則')
  const rowRules = rules.filter(r => declares(r, 'flex-direction', 'row')).flatMap(r => r.sels.map(sel => ({ sel, r })).filter(x => /label\.chk/.test(x.sel)))
  assert.ok(rowRules.length > 0, '有 label.chk 排成橫的規則')
  const best = rowRules.map(x => specificity(x.sel)).sort(cmp).at(-1)
  for (const c of colRules) assert.ok(cmp(best, specificity(c.sel)) > 0, `label.chk（${best}）要比「${c.sel}」（${specificity(c.sel)}）重`)
})

test('勾選框不被 `.settings input` 的 flex:1／外框撐開：有專屬的重置規則', () => {
  const r = rules.find(x => x.sels.some(s => /input\[type=checkbox\]/.test(s)) && /width/.test(x.body))
  assert.ok(r, '有 input[type=checkbox] 的尺寸規則')
  const generic = rules.find(x => x.sels.includes('.settings input'))
  assert.ok(generic && /flex:\s*1/.test(generic.body), '通用規則會讓輸入框 flex:1')
  const sel = r.sels.find(s => /checkbox/.test(s))
  assert.ok(cmp(specificity(sel), specificity('.settings input')) > 0, '勾選框規則比通用的 input 規則重')
})

test('表單元件統一：下拉、文字輸入、多行輸入同一套外框；按鈕有統一高度', () => {
  const all = rules.find(x => x.sels.some(s => /^\.settings select/.test(s)))
  assert.ok(all, '有統一的 .settings select／textarea／input 規則')
  assert.ok(/border:\s*1px solid var\(--line\)/.test(all.body) && /border-radius:\s*4px/.test(all.body))
  assert.ok(all.sels.some(s => /textarea/.test(s)) && all.sels.some(s => /input:not/.test(s)))
  assert.ok(rules.some(x => x.sels.some(s => /^\.settings \.aero-btn/.test(s)) && /min-height/.test(x.body)))
})

// ---------- 更新頁的版面 ----------
const state = (over = {}) => ({
  autoCheck: true, version: '0.1.13', log: [],
  upd: { checking: false, installing: false, manual: '', status: updateStatus({ lastCheck: 0, current: '0.1.13' }) },
  accounts: { list: [], current: null, codexLine: '', busy: false, confirmDel: '', msg: '', trustOwn: false, remote: { node: '', devices: [], list: [], loading: false, busy: false, msg: '' } },
  ...over,
})
const render = async st => {
  globalThis.Vue = Vue
  return renderToString(Vue.createSSRApp({ render: () => Vue.h(SettingsPanel, { st, catKey: 'update' }) }))
}

test('更新頁：一張卡片——勾選框與文字同一個 label、下一行立即檢查＋狀態、最後才是更新記錄', async () => {
  const html = await render(state())
  assert.match(html, /<section class="set-card upd-card"/)
  assert.match(html, /<label class="chk"><input type="checkbox"[^>]*\/?><span>自動檢查更新<\/span><\/label>/, '勾選框在左、文字在右，同一個 label')
  const i = { chk: html.indexOf('自動檢查更新'), btn: html.indexOf('立即檢查'), status: html.indexOf('upd-status'), log: html.indexOf('版本更新記錄') }
  assert.ok(i.chk > 0 && i.chk < i.btn && i.btn < i.status && i.status < i.log, JSON.stringify(i))
  // 按鈕與狀態在同一行容器裡，且都在卡片裡面
  const card = /<section class="set-card upd-card"[\s\S]*?<\/section>/.exec(html)[0]
  assert.ok(/class="upd-row"[\s\S]*立即檢查[\s\S]*upd-status/.test(card))
  assert.ok(!card.includes('版本更新記錄'))
})

test('更新頁狀態文字：目前版本、最後檢查時間、已是最新／有新版／檢查中／失敗', () => {
  const now = new Date(2026, 9, 21, 15, 0).getTime()
  const at = new Date(2026, 9, 21, 14, 3).getTime()
  const base = { current: '0.1.13', lastCheck: at }
  assert.deepEqual(updateStatus(base, now), { tone: 'ok', head: '已是最新版', lines: ['目前版本 0.1.13', '最後檢查：今天 14:03'] })
  assert.equal(updateStatus({ current: '0.1.13' }, now).tone, 'idle')
  assert.deepEqual(updateStatus({ current: '0.1.13' }, now).lines, ['目前版本 0.1.13', '尚未檢查過'])
  const nw = updateStatus({ ...base, phase: 'available', info: { version: '0.1.14' } }, now)
  assert.equal(nw.tone, 'new'); assert.match(nw.head, /0\.1\.14/)
  assert.equal(updateStatus({ ...base, checking: true }, now).head, '檢查中…')
  assert.equal(updateStatus({ ...base, installing: true }, now).tone, 'busy')
  const er = updateStatus({ ...base, error: '連不上' }, now)
  assert.equal(er.tone, 'err'); assert.match(er.head, /連不上/)
  assert.equal(formatCheckTime(new Date(2026, 9, 19, 9, 5).getTime(), now), '10/19 09:05')
  assert.equal(formatCheckTime(0, now), '')
  assert.equal(formatCheckTime(NaN, now), '')
})

test('其他有勾選框的設定（登入時自動啟動、信任自己的設備）也用同一種排法', async () => {
  const html = await render(state())
  assert.equal((html.match(/<label class="chk">/g) ?? []).length, 1)
  globalThis.Vue = Vue
  const w = await renderToString(Vue.createSSRApp({ render: () => Vue.h(SettingsPanel, { st: { ...state(), autostart: { supported: true, on: false, busy: false }, closeTo: 'tray', trayOk: true }, catKey: 'window' }) }))
  assert.match(w, /<label class="chk"><input type="checkbox"[^>]*\/?><span>登入時自動啟動 ASN<\/span><\/label>/)
  const a = await renderToString(Vue.createSSRApp({ render: () => Vue.h(SettingsPanel, { st: state(), catKey: 'accounts' }) }))
  assert.match(a, /<label class="chk"><input type="checkbox"[^>]*\/?><span>信任我自己的設備/)
})
