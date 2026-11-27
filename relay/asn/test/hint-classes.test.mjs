// #2425 提示樣式守門（棘輪）：掃 ui 底下的 html／js／mjs／css，找出「提示類 class」（名稱含 note／hint／err／error／warn／why／tip／notice／banner／toast
// 的片段，或掛在 role=status／alert／note 元素上），跟基準檔 test/golden/hint-classes.json 比：
//  - 找到基準裡沒有的新 class → 紅（新的提示樣式要用 AsnStatus／AsnNote）
//  - 基準裡有、實際已找不到 → 也紅（把它從基準刪掉；所以基準只會減少）
//  - 每個 class 記著出現的檔：出現在基準沒記錄的新檔 → 紅（舊 class 不准擴散）；基準記著、實際已不用的檔 → 也紅（從基準刪掉）
//  - 基準檔只准刪不准加：ASN_GOLDEN_UPDATE=1 只會把已消失的 class 移掉、刷新檔案清單，不會把新 class 放進去；
//    另外現在的基準必須是 PR base 上基準檔的子集（手改基準檔偷加會紅）；
//    唯一的例外是同一張 PR 裡的「一對一搬家」（evaluateMoves）：同一個 class 從 A 檔消失、在 B 檔出現，且該 class 的總檔案數與
//    總用處數（base 與 head 各用同一支掃描器數一次）都沒增加，基準照改（把 A 換成 B）；搬進 ui/parts/ 的，基準的 moved 表要註明「搬家帶進共用元件、待換」；node-test 在 pull_request 時只抓 base 的 sha 並設 ASN_HINT_BASE，讀不到就紅（不准空跑）；
//    沒設 ASN_HINT_BASE 時（本機、推 main）改比本機的 origin/main，沒有就略過
// 規範：docs/畫面規範.md〈四之一、訊息與提示的位置〉。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { scanText, scanUi, scanUiAt, scanSources, countUses, isScanPath, evaluateMoves, MOVE_NOTE } from './helpers/hint-classes-scan.mjs'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const GOLDEN = path.join(root, 'test', 'golden', 'hint-classes.json')
const GOLDEN_GIT = 'relay/asn/test/golden/hint-classes.json'
const MSG = '新的提示樣式要用 AsnStatus／AsnNote（見畫面規範〈訊息與提示的位置〉）'

const readGolden = () => JSON.parse(fs.readFileSync(GOLDEN, 'utf8'))
// 一個 class 一行，方便看 diff
const serialize = g => {
  const moved = Object.keys(g.moved ?? {}).sort()
  const movedText = moved.length ? `,\n "moved": {\n${moved.map(k => `  ${JSON.stringify(k)}: ${JSON.stringify(g.moved[k])}`).join(',\n')}\n }` : ''
  return `{\n "note": ${JSON.stringify(g.note)},\n "classes": {\n${Object.keys(g.classes).sort().map(k => `  ${JSON.stringify(k)}: ${JSON.stringify(g.classes[k])}`).join(',\n')}\n }${movedText}\n}\n`
}

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
  // 搬家註記：對應的 class／檔已經從基準消失的就一起清掉（搬家帶進共用元件的那一列換成 AsnStatus 時）
  const keptMoved = Object.entries(g.moved ?? {}).filter(([key]) => { const m = /^(.+)（(.+)）$/.exec(key); return m && next.classes[m[1]]?.includes(m[2]) })
  if (keptMoved.length) next.moved = Object.fromEntries(keptMoved)
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

const gitAt = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
// 那個提交上有沒有基準檔。ls-tree 的路徑預設相對於 cwd（relay/asn），GOLDEN_GIT 是從 repo 根目錄算的，一定要 --full-tree，
// 否則輸出永遠空白＝永遠當成「第一次加入」略過（#2428 二審抓到）
const baseHasGolden = ref => gitAt(['ls-tree', '--full-tree', ref, '--', GOLDEN_GIT]).trim() !== ''
// 掃某個提交上的 ui（用處數要在 base 上數，所以讀 git 上的檔，不碰工作樹）
// 一次 git cat-file --batch 讀完所有檔（一個檔開一次 git 太慢）
const blobsAt = (ref, paths) => {
  const buf = execFileSync('git', ['cat-file', '--batch'], { cwd: root, input: paths.map(p => `${ref}:${p}\n`).join(''), stdio: ['pipe', 'pipe', 'ignore'], maxBuffer: 1 << 29 })
  const out = new Map(); let pos = 0
  for (const p of paths) {
    const eol = buf.indexOf(0x0a, pos); const head = buf.toString('utf8', pos, eol).split(' ')
    assert.equal(head[1], 'blob', `${ref}:${p} 讀不到（${head.join(' ')}）`)
    const size = Number(head[2]); out.set(p, buf.toString('utf8', eol + 1, eol + 1 + size)); pos = eol + 1 + size + 1
  }
  return out
}
const scanAt = ref => {
  const paths = gitAt(['ls-tree', '-r', '-z', '--full-tree', '--name-only', ref, '--', 'relay/asn/ui']).split('\0').filter(Boolean).filter(isScanPath)
  let blobs
  return scanUiAt(() => paths, p => (blobs ??= blobsAt(ref, paths)).get(p))
}
const EMPTY = { extra: [], moreFiles: [], usesGrew: [], missingNote: [], orphanNote: [], droppedNote: [] }

test('#2425 子集比對真的讀得到提交上的基準檔（HEAD 一定有，否則比對會永遠略過）；拿 HEAD 的基準當 base，偷加 class、多記檔案都抓得到', () => {
  assert.equal(baseHasGolden('HEAD'), true, 'HEAD 上讀不到基準檔：子集比對會永遠當成「第一次加入」略過')
  const head = JSON.parse(gitAt(['show', `HEAD:${GOLDEN_GIT}`]))
  assert.ok(Object.keys(head.classes).length >= 40, '前提：HEAD 上的基準讀得出內容')
  const at = scanAt('HEAD')
  assert.ok(at.files > 50 && at.classes.size >= 40 && at.uses.size === at.classes.size, '前提：能從提交上掃出 ui（base 的用處數靠這個）')
  const ev = h => evaluateMoves({ baseGolden: head, headGolden: h, baseUses: at.uses, headUses: at.uses })
  assert.deepEqual(ev({ ...head, classes: { ...head.classes, 'an-ghost-note': ['ui/x.html'] } }).extra, ['an-ghost-note'])
  const [first] = Object.keys(head.classes)
  assert.deepEqual(ev({ ...head, classes: { ...head.classes, [first]: [...head.classes[first], 'ui/new-file.mjs'] } }).moreFiles, [`${first}（ui/new-file.mjs）`])
  assert.deepEqual(ev(head), EMPTY, '自己跟自己比沒有增加')
})

test('#2425 基準檔只准刪不准加：必須是 PR base（或本機 origin/main）上基準檔的子集，含每個 class 用的檔（該處還沒有基準檔時略過）', t => {
  const git = gitAt
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
  if (!baseHasGolden(ref)) { t.skip(`${ref} 上還沒有基準檔（第一次加入）`); return }
  const main = JSON.parse(git(['show', `${ref}:${GOLDEN_GIT}`]))
  const baseScan = scanAt(ref)
  const r = evaluateMoves({ baseGolden: main, headGolden: golden, baseUses: baseScan.uses, headUses: scan.uses })
  assert.deepEqual(r.extra, [], `基準檔只准減少，這些是新加的：${MSG}`)
  assert.deepEqual(r.moreFiles, [], '基準檔只准減少，這些 class 多記了使用的檔且總檔案數增加（只有同一張 PR 裡一對一搬家，檔案總數不增，才放行）')
  assert.deepEqual(r.usesGrew, [], '搬家的 class 總用處數增加了（base → head）')
  assert.deepEqual(r.missingNote, [], `搬進 ui/parts/ 的，基準檔的 moved 要註明「${MOVE_NOTE}」`)
  assert.deepEqual(r.orphanNote, [], 'moved 的註記對不上基準裡記著的 class／檔，或註記文字不對')
  assert.deepEqual(r.droppedNote, [], '搬家註記不准偷刪：那一列還在基準裡，註記就要留著（換成 AsnStatus 後會一起清掉）')
})

// ── 一對一搬家的純邏輯（假資料；寫法照 #1763 C4：m-err 原樣從 ui/m.html 搬進 ui/parts/notify-panel.mjs）──
const G = (classes, moved) => ({ note: 'x', classes, ...(moved ? { moved } : {}) })
const NOTED = { 'm-err（ui/parts/notify-panel.mjs）': MOVE_NOTE }
const move = ({ baseUses = { 'm-err': 1 }, headUses = { 'm-err': 1 }, base = G({ 'm-err': ['ui/m.html'] }), head = G({ 'm-err': ['ui/parts/notify-panel.mjs'] }, NOTED) } = {}) =>
  evaluateMoves({ baseGolden: base, headGolden: head, baseUses, headUses })

test('#2425 搬家（綠）：C4 的實例——m-err 從 ui/m.html 原樣搬進 ui/parts/notify-panel.mjs，基準把 A 換成 B 並註記', () => {
  assert.deepEqual(move(), EMPTY)
  assert.deepEqual(move({ headUses: { 'm-err': 0 } }), EMPTY, '用處數減少也行')
})
test('#2425 搬家（綠）：目的地不在 ui/parts/ 時不需要註記；一個 class 搬兩個檔（兩進兩出）也行', () => {
  assert.deepEqual(move({ head: G({ 'm-err': ['ui/lib/x.mjs'] }) }), EMPTY)
  const base = G({ a: ['ui/p.html', 'ui/q.html'] })
  assert.deepEqual(evaluateMoves({ baseGolden: base, headGolden: G({ a: ['ui/lib/p.mjs', 'ui/lib/q.mjs'] }), baseUses: { a: 2 }, headUses: { a: 2 } }), EMPTY)
})
test('#2425 搬家（紅）：搬家之外又在 B 多加一處，總用處數增加', () => {
  assert.deepEqual(move({ headUses: { 'm-err': 2 } }).usesGrew, ['m-err（1 → 2）'])
})
test('#2425 搬家（紅）：只在 B 出現、A 沒有消失，總檔案數增加', () => {
  const r = move({ head: G({ 'm-err': ['ui/m.html', 'ui/parts/notify-panel.mjs'] }, NOTED) })
  assert.deepEqual(r.moreFiles, ['m-err（ui/parts/notify-panel.mjs）'])
})
test('#2425 搬家（紅）：搬到 ui/parts/ 但基準沒寫註記，或註記寫錯字', () => {
  assert.deepEqual(move({ head: G({ 'm-err': ['ui/parts/notify-panel.mjs'] }) }).missingNote, ['m-err（ui/parts/notify-panel.mjs）'])
  assert.deepEqual(move({ head: G({ 'm-err': ['ui/parts/notify-panel.mjs'] }, { 'm-err（ui/parts/notify-panel.mjs）': '待換' }) }).missingNote, ['m-err（ui/parts/notify-panel.mjs）'])
})
test('#2425 搬家（紅）：搬家了但基準沒把 A 換成 B（還記著 A、沒記 B）——檔案層「基準有、實際沒有」那條會紅', () => {
  // 假資料：基準還是 A，實際找到的是 B。compareHintFiles 一邊抓到擴散、一邊抓到已不用
  assert.deepEqual(compareHintFiles({ 'm-err': ['ui/m.html'] }, new Map([['m-err', ['ui/parts/notify-panel.mjs']]])),
    { spread: ['m-err（ui/parts/notify-panel.mjs）'], stale: ['m-err（ui/m.html）'] })
})
test('#2425 搬家（紅）：新 class、孤兒註記、偷刪既有註記', () => {
  assert.deepEqual(move({ head: G({ 'm-err': ['ui/parts/notify-panel.mjs'], 'n-new': ['ui/x.mjs'] }, NOTED) }).extra, ['n-new'])
  assert.deepEqual(move({ head: G({ 'm-err': ['ui/parts/notify-panel.mjs'] }, { ...NOTED, 'm-err（ui/m.html）': MOVE_NOTE }) }).orphanNote, ['m-err（ui/m.html）'])
  const had = G({ 'm-err': ['ui/parts/notify-panel.mjs'] }, NOTED)
  assert.deepEqual(evaluateMoves({ baseGolden: had, headGolden: G({ 'm-err': ['ui/parts/notify-panel.mjs'] }), baseUses: { 'm-err': 1 }, headUses: { 'm-err': 1 } }).droppedNote, ['m-err（ui/parts/notify-panel.mjs）'])
  assert.deepEqual(evaluateMoves({ baseGolden: had, headGolden: G({}), baseUses: {}, headUses: {} }), EMPTY, '換成共用元件、那一列連註記一起清掉：綠')
  assert.deepEqual(move({ baseUses: {}, headUses: {} }).usesGrew.length, 1, '讀不到用處數時不放行')
})
test('#2425 用處數：同一個 class 不管哪種寫法、搬到哪種檔，都用同一把尺數（C4 實例：html 屬性 → mjs 模板字串）', () => {
  const a = scanSources([{ rel: 'ui/m.html', text: '<p class="m-err">x</p>' }])
  const b = scanSources([{ rel: 'ui/parts/notify-panel.mjs', text: 'const t = `<p class="m-err">${x}</p>`' }, { rel: 'ui/lib/y.mjs', text: 'const q = 1' }])
  assert.equal(a.uses.get('m-err'), 1)
  assert.equal(b.uses.get('m-err'), 1)
  const c = scanSources([{ rel: 'ui/parts/notify-panel.mjs', text: 'a = `<p class="m-err">`; b = `<p class="m-err">`' }])
  assert.equal(c.uses.get('m-err'), 2)
  assert.equal(countUses('x-m-err m-err2 m-err', 'm-err'), 1, '整個字才算')
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
