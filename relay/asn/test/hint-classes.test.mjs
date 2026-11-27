// #2425 提示樣式守門（棘輪）：掃 ui 底下的 html／js／mjs／css，找出「提示類 class」（名稱含 note／hint／err／error／warn／why／tip／notice／banner／toast
// 的片段，或掛在 role=status／alert／note 元素上），跟基準檔 test/golden/hint-classes.json 比：
//  - 找到基準裡沒有的新 class → 紅（新的提示樣式要用 AsnStatus／AsnNote）
//  - 基準裡有、實際已找不到 → 也紅（把它從基準刪掉；所以基準只會減少）
//  - 每個 class 記著出現的檔：出現在基準沒記錄的新檔 → 紅（舊 class 不准擴散）；基準記著、實際已不用的檔 → 也紅（從基準刪掉）
//  - 基準檔只准刪不准加：ASN_GOLDEN_UPDATE=1 只會把已消失的 class 移掉、刷新檔案清單，不會把新 class 放進去；
//    另外現在的基準必須是 PR base 上基準檔的子集（手改基準檔偷加會紅）；node-test 在 pull_request 時只抓 base 的 sha 並設 ASN_HINT_BASE，讀不到就紅（不准空跑）；
//    沒設 ASN_HINT_BASE 時（本機、推 main）改比本機的 origin/main，沒有就略過
// 規範：docs/畫面規範.md〈四之一、訊息與提示的位置〉。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { scanText, scanUi } from './helpers/hint-classes-scan.mjs'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const GOLDEN = path.join(root, 'test', 'golden', 'hint-classes.json')
const GOLDEN_GIT = 'relay/asn/test/golden/hint-classes.json'
const MSG = '新的提示樣式要用 AsnStatus／AsnNote（見畫面規範〈訊息與提示的位置〉）'

const readGolden = () => JSON.parse(fs.readFileSync(GOLDEN, 'utf8'))
// 一個 class 一行，方便看 diff
const serialize = g => `{\n "note": ${JSON.stringify(g.note)},\n "classes": {\n${Object.keys(g.classes).sort().map(k => `  ${JSON.stringify(k)}: ${JSON.stringify(g.classes[k]).replace(/","/g, '","')}`).join(',\n')}\n }\n}\n`

// 比對：回傳 { added: 找到但基準沒有, gone: 基準有但找不到 }
export const compareHintClasses = (baselineNames, foundNames) => {
  const b = new Set(baselineNames); const f = new Set(foundNames)
  return { added: [...f].filter(n => !b.has(n)).sort(), gone: [...b].filter(n => !f.has(n)).sort() }
}

// 比對使用的檔案（class 都在基準裡的前提下）：
//  spread＝class 出現在基準沒記錄的檔（舊 class 擴散到新檔）；stale＝基準記著、實際已不用的檔（要從基準刪掉）
export const compareHintFiles = (baselineClasses, foundClasses) => {
  const spread = []; const stale = []
  for (const [k, files] of foundClasses) {
    const bf = baselineClasses[k]; if (!bf) continue
    for (const f of files) if (!bf.includes(f)) spread.push(`${k}（${f}）`)
  }
  for (const [k, bf] of Object.entries(baselineClasses)) {
    const ff = foundClasses.get(k); if (!ff) continue
    for (const f of bf) if (!ff.includes(f)) stale.push(`${k}（${f}）`)
  }
  return { spread: spread.sort(), stale: stale.sort() }
}

const scan = scanUi(root)
const found = [...scan.classes.keys()]

// 只准縮減的更新：基準 ∩ 實際找到；檔案清單也只留基準原本就有、實際還在用的（不會加進新檔）
if (process.env.ASN_GOLDEN_UPDATE === '1') {
  const g = readGolden()
  const next = { note: g.note, classes: {} }
  for (const k of Object.keys(g.classes)) if (scan.classes.has(k)) next.classes[k] = g.classes[k].filter(f => scan.classes.get(k).includes(f))
  const text = serialize(next)
  if (text !== fs.readFileSync(GOLDEN, 'utf8').replace(/\r\n/g, '\n')) fs.writeFileSync(GOLDEN, text)
}

const golden = readGolden()
const baselineNames = Object.keys(golden.classes)

test('#2425 前提：掃得到足夠的檔案，基準也不是空的（否則守門是空的）', () => {
  assert.ok(scan.files > 50, `只掃到 ${scan.files} 個檔案`)
  assert.ok(baselineNames.length >= 40, `基準只有 ${baselineNames.length} 個 class`)
  assert.ok(found.length >= 40, `只掃到 ${found.length} 個提示類 class`)
  assert.deepEqual([...baselineNames], [...baselineNames].sort(), '基準要排序')
  for (const k of baselineNames) assert.ok(Array.isArray(golden.classes[k]) && golden.classes[k].length > 0, `${k} 要附出現的檔案`)
})

test('#2425 沒有新的提示類 class：新的提示樣式要用 AsnStatus／AsnNote', () => {
  const { added } = compareHintClasses(baselineNames, found)
  assert.deepEqual(added.map(n => `${n}（${scan.classes.get(n).join('、')}）`), [], `${MSG}。新出現的 class 如上`)
})

test('#2425 棘輪：基準裡的 class 都還找得到；找不到就從基準刪掉（只准減少）', () => {
  const { gone } = compareHintClasses(baselineNames, found)
  assert.deepEqual(gone, [], '這些 class 已經不見了，請從 test/golden/hint-classes.json 刪掉（ASN_GOLDEN_UPDATE=1 node --test test/hint-classes.test.mjs 會代刪）')
})

test('#2425 棘輪（檔案層）：舊 class 不准擴散到基準沒記錄的檔；不再用的檔要從基準刪掉', () => {
  const { spread, stale } = compareHintFiles(golden.classes, scan.classes)
  assert.deepEqual(spread, [], `舊 class 不准用在新的檔案。${MSG}。出現在這些檔：`)
  assert.deepEqual(stale, [], '這些檔已經不用那個 class，請從 test/golden/hint-classes.json 刪掉（ASN_GOLDEN_UPDATE=1 會代刪）')
})

test('#2425 基準檔只准刪不准加：必須是 PR base（或本機 origin/main）上基準檔的子集，含每個 class 用的檔（該處還沒有基準檔時略過）', t => {
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  const ok = args => { try { git(args); return true } catch { return false } }
  // 比對對象：node-test 在 pull_request 時設 ASN_HINT_BASE＝PR 的 base 提交（workflow 只抓這個 sha）。
  // 設了卻讀不到就是守門沒在跑，直接紅。沒設（本機、推 main、其他 job）就用本機的 origin/main，沒有就略過。
  const base = (process.env.ASN_HINT_BASE || '').trim()
  let ref
  if (base) {
    assert.ok(ok(['cat-file', '-e', `${base}^{commit}`]), `抓不到 PR 的 base（${base}）：請確認 asn-node-tests.yml 有「取得 PR 的 base」那一步`)
    ref = base
  } else {
    if (!ok(['rev-parse', '--verify', '--quiet', 'origin/main'])) { t.skip('沒有指定 PR 的 base，本機也沒有 origin/main（守門由 node-test 的 pull_request 負責）'); return }
    ref = 'origin/main'
  }
  // 只有「那個提交裡真的沒有這個檔」才是第一次加入，用 ls-tree 判斷（找不到路徑＝輸出空白；git 本身出錯會丟例外＝紅）。
  // 檔案存在卻讀不出來或解析失敗，也一律紅，不能略過
  if (git(['ls-tree', ref, '--', GOLDEN_GIT]).trim() === '') { t.skip(`${ref} 上還沒有基準檔（第一次加入）`); return }
  const main = JSON.parse(git(['show', `${ref}:${GOLDEN_GIT}`]))
  const extra = baselineNames.filter(n => !(n in main.classes))
  assert.deepEqual(extra, [], `基準檔只准減少，這些是新加的：${MSG}`)
  const moreFiles = baselineNames.filter(n => n in main.classes).flatMap(n => golden.classes[n].filter(f => !main.classes[n].includes(f)).map(f => `${n}（${f}）`))
  assert.deepEqual(moreFiles, [], '基準檔只准減少，這些 class 多記了使用的檔')
})

test('#2425 規範那一章存在，守門訊息指到的章名對得上', () => {
  const doc = fs.readFileSync(path.join(root, '..', '..', 'docs', '畫面規範.md'), 'utf8')
  assert.match(doc, /^## 四之一、訊息與提示的位置/m)
  assert.match(doc, /hint-classes\.test\.mjs/)
})

test('#2425 偵測是真的：新的 class、role 元素上的 class、CSS 選擇器、classList 都抓得到；共用元件與一般字眼不誤抓', () => {
  assert.deepEqual([...scanText('<p class="foo-note">x</p>', '.html')], ['foo-note'])
  assert.deepEqual([...scanText(`<div :class="{ 'bar-err': a, warn: b }">`, '.html')].sort(), ['bar-err', 'warn'])
  assert.deepEqual([...scanText('<span role="status" class="plain big">', '.html')].sort(), ['big', 'plain'], 'role 元素上的 class 不管名字都算')
  assert.deepEqual([...scanText('<span class="plain">', '.html')], [], '沒有 role、名字也不像提示就不算')
  assert.deepEqual([...scanText('.x-hint:hover{color:red} .ok{}', '.css')], ['x-hint'])
  assert.deepEqual([...scanText(`el.classList.add('q-why', 'big')`, '.js')], ['q-why'])
  assert.deepEqual([...scanText('<p class="asn-note asn-note-warn asn-status k-fail" role="status">', '.html')], [], '白名單')
  assert.deepEqual([...scanText(`const error = 1; log('note', warn)`, '.mjs')], [], '一般字眼不是 class')
  assert.deepEqual([...scanText(`<i :class="['tone-' + k]" role="status">`, '.html')], [], '動態前綴不算')
  assert.deepEqual([...scanText('<span v-if="a > 1" role="status" class="x-count">', '.html')], ['x-count'], '屬性值裡有 > 也要抓到')
  assert.deepEqual([...scanText(`<span v-if='a > 1' role='status' class='y-count'>`, '.html')], ['y-count'], '單引號')
  assert.deepEqual([...scanText('<p class="x-warning">x</p><p class="a-notes b-errors c-tips">', '.html')].sort(), ['a-notes', 'b-errors', 'c-tips', 'x-warning'], 'warning 與複數')
})

test('#2425 偵測補齊：class 陣列、三元、setAttribute、className（= 與 +=）、跳脫的 class=\\"…\\"、模板字串插值、<style> 區塊', () => {
  const s = (x, ext = '.html') => [...scanText(x, ext)].sort()
  assert.deepEqual(s(`<i :class="['x-note', ok && 'y-warn', plain]">`), ['x-note', 'y-warn'], ':class 陣列')
  assert.deepEqual(s(`<i :class="a ? 'x-err' : 'y-hint'">`), ['x-err', 'y-hint'], ':class 三元')
  assert.deepEqual(s(`h('p', { class: ['x-err', ok && 'y-note'] })`, '.mjs'), ['x-err', 'y-note'], 'JS 的 class: 陣列')
  assert.deepEqual(s(`h('p', { class: cond ? 'x-err' : '' })`, '.mjs'), ['x-err'], 'JS 的 class: 三元')
  assert.deepEqual(s(`el.setAttribute('class', 'x-note plain')`, '.js'), ['x-note'], 'setAttribute')
  assert.deepEqual(s(`el.className += ' x-warn'`, '.js'), ['x-warn'], 'className +=')
  assert.deepEqual(s(`el.className = 'q-hint z'`, '.js'), ['q-hint'], 'className =')
  assert.deepEqual(s('const t = "<p class=\\"w-note\\">x</p>"', '.js'), ['w-note'], '字串裡跳脫的 class=\\"…\\"')
  assert.deepEqual(s('const t = `<p class="v-${k} t-tip">x</p>`', '.js'), ['t-tip'], '模板字串插值外的字')
  assert.deepEqual(s('const t = `<p class="${a ? \'u-err\' : \'\'}">x</p>`', '.js'), ['u-err'], '模板字串插值裡的運算式')
  assert.deepEqual(s('<style>.s-note{color:red} .plain{}</style><p>x</p>'), ['s-note'], '<style> 區塊')
  assert.deepEqual(s(`<p class="plain" v-if="error" aria-describedby="a-why">`), [], '同一個標籤的其他屬性不是 class')
  assert.deepEqual(s(`log('error', 'warn'); const x = { kind: 'warn' }`, '.mjs'), [], '一般字串不誤抓')
})

test('#2425 白名單是精確清單：asn-note-error／asn-note-ok／asn-note-fail 這種不在清單裡的一律照一般規則抓', () => {
  assert.deepEqual([...scanText('<p class="asn-note asn-note-info asn-note-warn asn-note-banner asn-status k-busy k-ok k-fail k-empty k-unreadable" role="status">', '.html')], [])
  assert.deepEqual([...scanText('<p class="asn-note-error asn-note-ok asn-note-fail asn-status-x" role="status">', '.html')].sort(), ['asn-note-error', 'asn-note-fail', 'asn-note-ok', 'asn-status-x'])
  assert.deepEqual([...scanText('<p class="asn-note-error">', '.html')], ['asn-note-error'], '名字像提示也照抓')
  assert.ok(golden.classes['asn-note-fail'], 'asn-note-fail 是舊的訂閱說明樣式，記在基準裡，只准減少')
})

test('#2425 檔案層比對的純邏輯：擴散到新檔、已不用的檔各自抓得到；新 class 不歸這裡管', () => {
  const b = { 'a-note': ['x.mjs', 'y.mjs'], 'b-err': ['z.mjs'] }
  assert.deepEqual(compareHintFiles(b, new Map([['a-note', ['x.mjs', 'y.mjs']], ['b-err', ['z.mjs']]])), { spread: [], stale: [] })
  assert.deepEqual(compareHintFiles(b, new Map([['a-note', ['x.mjs', 'n.mjs']], ['b-err', ['z.mjs']]])), { spread: ['a-note（n.mjs）'], stale: ['a-note（y.mjs）'] })
  assert.deepEqual(compareHintFiles(b, new Map([['c-new', ['q.mjs']]])), { spread: [], stale: [] })
})

test('#2425 比對的純邏輯：多出來的、消失的各自抓得到', () => {
  assert.deepEqual(compareHintClasses(['a-note', 'b-err'], ['a-note', 'c-warn']), { added: ['c-warn'], gone: ['b-err'] })
  assert.deepEqual(compareHintClasses(['a-note'], ['a-note']), { added: [], gone: [] })
})
