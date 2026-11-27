// #2425 提示樣式守門（棘輪）：掃 ui 底下的 html／js／mjs／css，找出「提示類 class」（名稱含 note／hint／err／error／warn／why／tip／notice／banner／toast
// 的片段，或掛在 role=status／alert／note 元素上），跟基準檔 test/golden/hint-classes.json 比：
//  - 找到基準裡沒有的新 class → 紅（新的提示樣式要用 AsnStatus／AsnNote）
//  - 基準裡有、實際已找不到 → 也紅（把它從基準刪掉；所以基準只會減少）
//  - 基準檔只准刪不准加：ASN_GOLDEN_UPDATE=1 只會把已消失的 class 移掉、刷新檔案清單，不會把新 class 放進去；
//    另外現在的基準必須是 origin/main 上基準檔的子集（手改基準檔偷加會紅）；CI 的 workflow 會另外抓 main，CI 上抓不到就紅（不准空跑）
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

const scan = scanUi(root)
const found = [...scan.classes.keys()]

// 只准縮減的更新：基準 ∩ 實際找到，並刷新檔案清單
if (process.env.ASN_GOLDEN_UPDATE === '1') {
  const g = readGolden()
  const next = { note: g.note, classes: {} }
  for (const k of Object.keys(g.classes)) if (scan.classes.has(k)) next.classes[k] = scan.classes.get(k)
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

test('#2425 基準檔只准刪不准加：必須是 origin/main 上基準檔的子集（main 上還沒有基準檔時略過；CI 上找不到 origin/main 一律紅）', t => {
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  let hasMain = true
  try { git(['rev-parse', '--verify', '--quiet', 'origin/main']) } catch { hasMain = false }
  // CI 的 checkout 是淺層的，workflow 另外抓 main（asn-node-tests.yml）；抓不到就是守門沒在跑，不准悄悄略過
  if (!hasMain) {
    assert.ok(!process.env.CI, 'CI 上找不到 origin/main：這條守門會空跑，請確認 workflow 有「取得 main」那一步')
    t.skip('本機找不到 origin/main（沒有遠端）'); return
  }
  let main
  try { main = JSON.parse(git(['show', `origin/main:${GOLDEN_GIT}`])) } catch { t.skip('main 上還沒有基準檔（第一次加入）'); return }
  const extra = baselineNames.filter(n => !(n in main.classes))
  assert.deepEqual(extra, [], `基準檔只准減少，這些是新加的：${MSG}`)
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
})

test('#2425 比對的純邏輯：多出來的、消失的各自抓得到', () => {
  assert.deepEqual(compareHintClasses(['a-note', 'b-err'], ['a-note', 'c-warn']), { added: ['c-warn'], gone: ['b-err'] })
  assert.deepEqual(compareHintClasses(['a-note'], ['a-note']), { added: [], gone: [] })
})
