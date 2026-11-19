// 手機觸控目標棘輪（#1763 T3）：手機設定頁上寬或高小於 44px 的可點元素，違規只准減少、不准增加。
// 純邏輯層（讀 JSON 比對）：基準檔 test/golden/hit-targets-baseline.json 與（若有）最新量測結果。
// 真的量測由 scripts/hit-targets.mjs 在無頭 Chrome 跑；要把最新結果也一起檢查，就把 ASN_HIT_TARGETS_LATEST 指到它產生的 hit-targets.json：
//   node scripts/hit-targets.mjs --out <資料夾>
//   ASN_HIT_TARGETS_LATEST=<資料夾>/hit-targets.json node --test test/hit-targets.test.mjs
// 基準裡有、現在沒有的算改善（印提示，不算失敗），確定變少之後用 node scripts/hit-targets.mjs --update 更新基準。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import { SCENARIOS } from '../scripts/smoke-lib.mjs'
import { MIN_TARGET_PX, baselineProblems, compareHitTargets, hitTargetSource, idOf, lineOf, makeBaseline, minSide, sortViolations } from '../scripts/hit-targets-lib.mjs'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const BASELINE = path.join(root, 'test', 'golden', 'hit-targets-baseline.json')
const v = (scenario, tag, text, w, h, cls = '') => ({ scenario, tag, text, cls, w, h })

test('比對：新增的違規＝紅；惡化（最短邊縮短超過 1px）＝紅；改善只提示；沒量到的情境＝紅', () => {
  const baseline = makeBaseline({ scenarios: ['a', 'b'], violations: [v('a', 'button', '改名', 40, 30), v('a', 'a', '官網', 100, 30), v('b', 'input', '', 200, 36)] })
  const same = { scenarios: ['a', 'b'], violations: [...baseline.violations] }
  assert.equal(compareHitTargets(baseline, same).ok, true)
  // 縮短 1px 以內不算惡化（量測的小數誤差）；放大不算
  assert.equal(compareHitTargets(baseline, { scenarios: ['a', 'b'], violations: [v('a', 'button', '改名', 40, 29.5), v('a', 'a', '官網', 100, 40), v('b', 'input', '', 200, 36)] }).ok, true)
  // 新增
  const added = compareHitTargets(baseline, { scenarios: ['a', 'b'], violations: [...baseline.violations, v('b', 'button', '新鈕', 30, 30)] })
  assert.equal(added.ok, false); assert.deepEqual(added.added.map(x => x.text), ['新鈕'])
  // 同一個 id 多出一筆也算新增
  const dup = compareHitTargets(baseline, { scenarios: ['a', 'b'], violations: [...baseline.violations, v('a', 'button', '改名', 40, 30)] })
  assert.equal(dup.ok, false); assert.equal(dup.added.length, 1)
  // 惡化
  const worse = compareHitTargets(baseline, { scenarios: ['a', 'b'], violations: [v('a', 'button', '改名', 40, 20), v('a', 'a', '官網', 100, 30), v('b', 'input', '', 200, 36)] })
  assert.equal(worse.ok, false); assert.equal(worse.worsened.length, 1); assert.equal(minSide(worse.worsened[0].was), 30)
  // 改善：少一筆
  const better = compareHitTargets(baseline, { scenarios: ['a', 'b'], violations: [v('a', 'button', '改名', 40, 30), v('b', 'input', '', 200, 36)] })
  assert.equal(better.ok, true); assert.deepEqual(better.improved.map(x => x.text), ['官網'])
  // 全部消失（量到 0 筆違規）也是改善；但情境沒量到不能靠「沒有違規」過關
  assert.equal(compareHitTargets(baseline, { scenarios: ['a', 'b'], violations: [] }).ok, true)
  const lost = compareHitTargets(baseline, { scenarios: ['a'], violations: [v('a', 'button', '改名', 40, 30), v('a', 'a', '官網', 100, 30)] })
  assert.equal(lost.ok, false); assert.deepEqual(lost.unmeasured, ['b'])
})

test('基準檔格式：排序固定、含計數；手改壞了（總數、各情境數、順序）會被抓到', () => {
  const b = makeBaseline({ scenarios: ['z', 'a'], violations: [v('z', 'button', 'x', 10, 10), v('a', 'button', 'y', 10, 10), v('a', 'a', 'y', 10, 10)] })
  assert.deepEqual(baselineProblems(b), [])
  assert.equal(b.total, 3); assert.deepEqual(b.scenarios, { a: 2, z: 1 }); assert.deepEqual(Object.keys(b.scenarios), ['a', 'z'])
  assert.deepEqual(b.violations.map(idOf), ['a|a|y|', 'a|button|y|', 'z|button|x|'])
  assert.ok(baselineProblems({ ...b, total: 9 }).length)
  assert.ok(baselineProblems({ ...b, violations: [...b.violations].reverse() }).length)
  assert.ok(baselineProblems({ ...b, scenarios: { a: 1, z: 1 } }).length)
  assert.ok(baselineProblems({ ...b, scenarios: { a: 2 } }).length)
  assert.ok(baselineProblems(null).length)
  assert.deepEqual(sortViolations([v('b', 'a', 'x', 1, 1), v('a', 'a', 'x', 1, 1)]).map(x => x.scenario), ['a', 'b'])
  assert.match(lineOf(v('m-set-x', 'button', '改名', 40.5, 30, 'm-btn')), /m-set-x.*button.*改名.*\.m-btn.*40\.5×30/)
})

// 假的 DOM：只實作量測原始碼用到的那幾個（getComputedStyle、closest、getBoundingClientRect、querySelectorAll）
const mk = (o, parent) => ({
  tagName: o.tag.toUpperCase(), type: o.type, disabled: o.disabled, hidden: o.hidden, isConnected: true, parentElement: parent, value: o.value, innerText: o.text ?? '', className: o.cls ?? '',
  _style: { display: 'block', visibility: 'visible', opacity: '1', ...(o.style ?? {}) }, _rect: { width: o.w ?? 100, height: o.h ?? 30 }, _label: o.label ? mk(o.label, parent) : null,
  getAttribute(n) { return (o.attrs ?? {})[n] ?? null }, getBoundingClientRect() { return this._rect }, closest(sel) { return sel === 'label' ? this._label : null },
})
const runSource = (list, src = hitTargetSource()) => {
  const top = { parentElement: null }
  const items = list.map(o => mk(o, top))
  const doc = { querySelector: () => ({ querySelectorAll: () => items }), documentElement: top }
  const ctx = vm.createContext({ document: doc, getComputedStyle: e => e._style, JSON, Math, Set })
  return vm.runInContext(src, ctx)
}

const LONG = '這是一段超過二十個字的很長很長很長很長很長的文字'
test('量測原始碼：語法正確；只列看得到、沒停用、寬或高小於 44 的；勾選框量包著它的標籤；文字只取前 20 字', () => {
  assert.doesNotThrow(() => new vm.Script(hitTargetSource()))
  assert.ok(hitTargetSource().includes('44'))
  assert.equal(MIN_TARGET_PX, 44)
  const r = runSource([
    { tag: 'button', text: '夠大', w: 100, h: 48 },
    { tag: 'button', text: '太矮', w: 100, h: 40, cls: 'm-btn on' },
    { tag: 'button', text: '太窄', w: 30, h: 60 },
    { tag: 'button', text: '停用的', w: 10, h: 10, disabled: true },
    { tag: 'button', text: '看不到', w: 10, h: 10, style: { display: 'none' } },
    { tag: 'button', text: '透明', w: 10, h: 10, style: { opacity: '0' } },
    { tag: 'button', text: '零大小', w: 0, h: 0 },
    { tag: 'input', type: 'checkbox', w: 13, h: 13, label: { tag: 'label', text: '勾選的標籤', w: 300, h: 30 } },
    { tag: 'button', text: LONG, w: 20, h: 20, attrs: { 'aria-hidden': 'false' } },
  ])
  assert.equal(r.ok, true)
  assert.equal(r.total, 5, '算入的是看得到、沒停用的可點元素：夠大、太矮、太窄、勾選框的標籤、長文字')
  assert.deepEqual(Array.from(r.violations, x => `${x.tag}|${x.text}|${x.cls}|${x.w}x${x.h}`), ['button|太矮|m-btn|100x40', 'button|太窄||30x60', 'label|勾選的標籤||300x30', `button|${[...LONG].slice(0, 20).join('')}||20x20`])
  assert.deepEqual(Array.from(r.violations.filter(x => x.tag === 'label')).length, 1, '勾選框不列自己（13×13），列包著它的標籤（300×30 的高不到 44）')
  // 量測範圍不在（內頁沒打開）＝量不到，不是「沒有違規」
  const none = vm.runInContext(hitTargetSource(), vm.createContext({ document: { querySelector: () => null }, JSON, Math, Set }))
  assert.equal(none.ok, false); assert.match(none.why, /找不到量測範圍/)
})

const readJson = f => JSON.parse(fs.readFileSync(f, 'utf8'))

test('基準檔：存在、格式一致、涵蓋每個手機設定頁情境（新增情境要重量基準）、每筆真的小於 44px', () => {
  assert.ok(fs.existsSync(BASELINE), '沒有 test/golden/hit-targets-baseline.json：先跑 node scripts/hit-targets.mjs --update')
  const b = readJson(BASELINE)
  assert.deepEqual(baselineProblems(b), [])
  assert.equal(b.min, MIN_TARGET_PX)
  const phone = SCENARIOS.filter(s => s.page.startsWith('m.html') && s.probe?.setPage).map(s => s.name).sort()
  assert.ok(phone.length >= 30, `手機設定頁情境只有 ${phone.length} 個`)
  assert.deepEqual(Object.keys(b.scenarios).sort(), phone, '基準涵蓋的情境和 SCENARIOS 裡的手機設定頁情境不同：新增或拿掉情境後要用 node scripts/hit-targets.mjs --update 重量')
  for (const x of b.violations) assert.ok(minSide(x) < MIN_TARGET_PX, `基準裡有不是違規的一筆：${lineOf(x)}`)
  // 空基準會讓棘輪變成「什麼都擋不住」或「什麼都放行」：現況手機設定頁一定量得到違規
  assert.ok(b.total > 0, '基準是空的（量測壞了？）')
})

test('最新量測結果（有設 ASN_HIT_TARGETS_LATEST 才檢查）：不准比基準多、不准惡化', { skip: process.env.ASN_HIT_TARGETS_LATEST ? false : '沒設 ASN_HIT_TARGETS_LATEST（沒有最新量測可比；用 scripts/hit-targets.mjs 量）' }, () => {
  const latest = readJson(process.env.ASN_HIT_TARGETS_LATEST)
  const b = readJson(BASELINE)
  const c = compareHitTargets(b, latest)
  if (c.improved.length) console.log(`觸控目標：改善 ${c.improved.length} 筆，可用 node scripts/hit-targets.mjs --update 更新基準`)
  assert.deepEqual(c.added.map(lineOf), [], '新增的觸控目標違規（手機要 ≥ 44px）')
  assert.deepEqual(c.worsened.map(x => lineOf(x.now)), [], '惡化的觸控目標違規')
  assert.deepEqual(c.unmeasured, [], '基準裡的情境這次沒量到')
})
