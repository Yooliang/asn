// #2425 提示樣式守門（棘輪）：掃 ui 底下的 html／js／mjs／css，找出「提示類 class」（名稱含 note／hint／err／error／warn／why／tip／notice／banner／toast
// 的片段，或掛在 role=status／alert／note 元素上），跟基準檔 test/golden/hint-classes.json 比：
//  - 找到基準裡沒有的新 class → 紅（新的提示樣式要用 AsnStatus／AsnNote）
//  - 基準裡有、實際已找不到 → 也紅（把它從基準刪掉；所以基準只會減少）
//  - 每個 class 記著出現的檔：出現在基準沒記錄的新檔 → 紅（舊 class 不准擴散）；基準記著、實際已不用的檔 → 也紅（從基準刪掉）
//  - 基準檔只准刪不准加：ASN_GOLDEN_UPDATE=1 只會把已消失的 class 移掉、刷新檔案清單，不會把新 class 放進去；
//    另外現在的基準必須是 PR base 上基準檔的子集（手改基準檔偷加會紅）；
//    唯一的例外是同一張 PR 裡的搬家（evaluateMoves；只准一對一換檔，搬進 ui/parts/ 且帶註記與來源檔的可以多一個檔）：同一個 class 從 A 檔消失、在 B 檔出現，且該 class 的總檔案數與
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
const EMPTY = { extra: [], moreFiles: [], usesGrew: [], missingNote: [], noFrom: [], badSource: [], orphanNote: [], droppedNote: [] }
// 接線：把 base 與 head 的基準、掃描結果交給 evaluateMoves（真比對與假資料的接線測試共用這一條）
const wire = (baseGolden, baseScan, headGolden, headScan) => evaluateMoves({
  baseGolden, headGolden, baseUses: baseScan.uses, headUses: headScan.uses, baseByFile: baseScan.byFile, headByFile: headScan.byFile,
})

test('#2425 子集比對真的讀得到提交上的基準檔（HEAD 一定有，否則比對會永遠略過）；拿 HEAD 的基準當 base，偷加 class、多記檔案都抓得到', () => {
  assert.equal(baseHasGolden('HEAD'), true, 'HEAD 上讀不到基準檔：子集比對會永遠當成「第一次加入」略過')
  const head = JSON.parse(gitAt(['show', `HEAD:${GOLDEN_GIT}`]))
  assert.ok(Object.keys(head.classes).length >= 40, '前提：HEAD 上的基準讀得出內容')
  const at = scanAt('HEAD')
  assert.ok(at.files > 50 && at.classes.size >= 40 && at.uses.size === at.classes.size, '前提：能從提交上掃出 ui（base 的用處數靠這個）')
  const ev = h => wire(head, at, h, at)
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
  const baseScan = scanAt(ref)   // base 的用處數與各檔次數：用掃描器數 base 提交上的檔（不是讀基準檔）
  // 一次比對整個結果等於全空。各欄的意思：extra＝新 class；moreFiles＝檔案數增加不合規（只有搬進 ui/parts/ 且只多一個檔才准）；
  // usesGrew＝總用處數增加；missingNote／noFrom／badSource＝搬進 ui/parts/ 的註記沒寫、沒寫來源檔、來源檔沒減夠；
  // orphanNote＝註記對不上基準；droppedNote＝偷刪註記
  assert.deepEqual(wire(main, baseScan, golden, scan), EMPTY, `基準檔只准減少（${MSG}）。上面哪一欄不是空的就是哪一條沒過；搬家的規則見畫面規範 4A-4`)
})

// ── 搬家的純邏輯（假資料；形狀照 #1763 C4 的真實情況）──
// C4：m-err 在 ui/m.html（25 處）和 ui/mobile.css（1 處）；搬走 1 處到 ui/parts/notify-panel.mjs，m.html 剩 24 處、仍在用
const DEST = 'ui/parts/notify-panel.mjs'
const KEY = `m-err（${DEST}）`
const G = (classes, moved) => ({ note: 'x', classes, ...(moved ? { moved } : {}) })
const NOTE = { note: MOVE_NOTE, from: 'ui/m.html' }
const BASE_FILES = { 'm-err': { 'ui/m.html': 25, 'ui/mobile.css': 1 } }
const BASE = G({ 'm-err': ['ui/m.html', 'ui/mobile.css'] })
const HEAD = G({ 'm-err': ['ui/m.html', 'ui/mobile.css', DEST] }, { [KEY]: NOTE })
const HEAD_FILES = { 'm-err': { 'ui/m.html': 24, 'ui/mobile.css': 1, [DEST]: 1 } }
const total = f => Object.fromEntries(Object.entries(f).map(([k, v]) => [k, Object.values(v).reduce((a, b) => a + b, 0)]))
const move = ({ base = BASE, head = HEAD, baseFiles = BASE_FILES, headFiles = HEAD_FILES } = {}) =>
  evaluateMoves({ baseGolden: base, headGolden: head, baseUses: total(baseFiles), headUses: total(headFiles), baseByFile: baseFiles, headByFile: headFiles })
const withFiles = (extra, m = HEAD.moved) => G({ 'm-err': ['ui/m.html', 'ui/mobile.css', ...extra] }, m)

test('#2425 搬家（綠）：C4 的真實形狀——m.html 25→24、mobile.css 還在、notify-panel.mjs 新增 1 處，有註記並寫明來源', () => {
  assert.deepEqual(move(), EMPTY)
})
test('#2425 搬家（綠）：整個搬空的一對一換檔——到 ui/parts/ 要註記；不在 ui/parts/ 不需要註記', () => {
  const baseFiles = { 'm-err': { 'ui/m.html': 1 } }
  const one = f => move({ baseFiles, base: G({ 'm-err': ['ui/m.html'] }), headFiles: { 'm-err': { [f]: 1 } }, head: G({ 'm-err': [f] }, f === DEST ? { [KEY]: NOTE } : undefined) })
  assert.deepEqual(one(DEST), EMPTY)
  assert.deepEqual(one('ui/lib/x.mjs'), EMPTY)
})
test('#2425 搬家（紅）：總用處數增加（搬家之外又在 B 多加一處）', () => {
  assert.deepEqual(move({ headFiles: { 'm-err': { 'ui/m.html': 24, 'ui/mobile.css': 1, [DEST]: 2 } } }).usesGrew, ['m-err（26 → 27）'])
})
test('#2425 搬家（紅）：目的地不在 ui/parts/，檔案數增加（來源檔還在）', () => {
  const dest = 'ui/lib/x.mjs'
  const r = move({ head: withFiles([dest], {}), headFiles: { 'm-err': { 'ui/m.html': 24, 'ui/mobile.css': 1, [dest]: 1 } } })
  assert.deepEqual(r, { ...EMPTY, moreFiles: [`m-err（${dest}）`] })
})
test('#2425 搬家（紅）：同一個 class 多出兩個以上的新檔，即使都在 ui/parts/ 也紅', () => {
  const d2 = 'ui/parts/other.mjs'
  const r = move({ head: withFiles([DEST, d2], { [KEY]: NOTE, [`m-err（${d2}）`]: NOTE }), headFiles: { 'm-err': { 'ui/m.html': 23, 'ui/mobile.css': 1, [DEST]: 1, [d2]: 1 } } })
  assert.deepEqual(r.moreFiles, [`m-err（${d2}）`, KEY].sort())
})
test('#2425 搬家（紅）：搬到 ui/parts/ 但基準沒寫註記，或註記文字寫錯', () => {
  assert.deepEqual(move({ head: withFiles([DEST], {}) }), { ...EMPTY, missingNote: [KEY] })
  assert.deepEqual(move({ head: withFiles([DEST], { [KEY]: { note: '待換', from: 'ui/m.html' } }) }).missingNote, [KEY])
})
test('#2425 搬家（紅）：註記沒寫來源檔', () => {
  assert.deepEqual(move({ head: withFiles([DEST], { [KEY]: { note: MOVE_NOTE } }) }), { ...EMPTY, noFrom: [KEY] })
})
test('#2425 搬家（紅）：來源檔寫錯（那個檔的用處數沒減少，或根本不是這個 class 記著的檔）', () => {
  const wrong = move({ head: withFiles([DEST], { [KEY]: { note: MOVE_NOTE, from: 'ui/mobile.css' } }) })
  assert.deepEqual(wrong.badSource.length, 1, '寫 mobile.css：它沒減少')
  const nope = move({ head: withFiles([DEST], { [KEY]: { note: MOVE_NOTE, from: 'ui/never.html' } }) })
  assert.match(nope.badSource[0], /不是 base 上這個 class 記著的檔/)
})
test('#2425 搬家（紅）：來源檔減少的量比目的地新增的少（總用處數沒增加，但搬的比寫的少）', () => {
  // 來源只少 1，目的地多了 2，另一個檔（mobile.css）少 1 讓總數不增加：總數守得住，來源守不住
  const r = move({ headFiles: { 'm-err': { 'ui/m.html': 24, 'ui/mobile.css': 0, [DEST]: 2 } } })
  assert.deepEqual(r.usesGrew, [])
  assert.match(r.badSource[0], /減少 1 處，少於新增的 2 處/)
})
test('#2425 搬家（紅）：搬家了但基準沒把 A 換成 B（還記著 A、沒記 B）——檔案層「基準有、實際沒有」那條會紅', () => {
  // 假資料：基準還是 A，實際找到的是 B。compareHintFiles 一邊抓到擴散、一邊抓到已不用
  assert.deepEqual(compareHintFiles({ 'm-err': ['ui/m.html'] }, new Map([['m-err', ['ui/parts/notify-panel.mjs']]])),
    { spread: ['m-err（ui/parts/notify-panel.mjs）'], stale: ['m-err（ui/m.html）'] })
})
test('#2425 搬家（紅）：新 class、孤兒註記、偷刪既有註記', () => {
  assert.deepEqual(move({ head: G({ 'm-err': ['ui/m.html', 'ui/mobile.css', DEST], 'n-new': ['ui/x.mjs'] }, { [KEY]: NOTE }) }).extra, ['n-new'])
  assert.deepEqual(move({ head: withFiles([DEST], { [KEY]: NOTE, 'm-err（ui/gone.html）': NOTE }) }).orphanNote, ['m-err（ui/gone.html）'])
  const had = G({ 'm-err': ['ui/m.html', DEST] }, { [KEY]: NOTE })
  const hadFiles = { 'm-err': { 'ui/m.html': 24, [DEST]: 1 } }
  const stay = G({ 'm-err': ['ui/m.html', DEST] })
  assert.deepEqual(evaluateMoves({ baseGolden: had, headGolden: stay, baseUses: total(hadFiles), headUses: total(hadFiles), baseByFile: hadFiles, headByFile: hadFiles }), { ...EMPTY, droppedNote: [KEY] })
  assert.deepEqual(evaluateMoves({ baseGolden: had, headGolden: G({ 'm-err': ['ui/m.html'] }), baseUses: total(hadFiles), headUses: { 'm-err': 24 }, baseByFile: hadFiles, headByFile: { 'm-err': { 'ui/m.html': 24 } } }), EMPTY, '換成共用元件、那一列連註記一起清掉：綠')
  assert.equal(move({ baseFiles: {}, headFiles: {} }).usesGrew.length, 1, '讀不到用處數時不放行')
})
test('#2425 接線：用假的 base／head 提交內容走一遍「掃描 → evaluateMoves」，C4 形狀綠；把用處數接錯就紅', () => {
  const html = n => Array.from({ length: n }, () => '<i class="m-err">x</i>').join('\n')
  const baseScan = scanSources([{ rel: 'ui/m.html', text: html(25) }, { rel: 'ui/mobile.css', text: '.m-err{color:red}' }])
  const headScan = scanSources([
    { rel: 'ui/m.html', text: html(24) }, { rel: 'ui/mobile.css', text: '.m-err{color:red}' },
    { rel: DEST, text: '// 這一行說明 m-err 從 m.html 搬來，註解不算用處\nexport const t = `<p class="m-err">${x}</p>`' },
  ])
  assert.equal(baseScan.uses.get('m-err'), 26)
  assert.equal(headScan.uses.get('m-err'), 26)
  assert.deepEqual(wire(BASE, baseScan, HEAD, headScan), EMPTY)
  const more = scanSources([
    { rel: 'ui/m.html', text: html(24) }, { rel: 'ui/mobile.css', text: '.m-err{color:red}' },
    { rel: DEST, text: 'export const t = `<p class="m-err">a</p><p class="m-err">b</p>`' },
  ])
  assert.deepEqual(wire(BASE, baseScan, HEAD, more).usesGrew, ['m-err（26 → 27）'], '目的地多一處：用處數與各檔次數都有接到比對')
  assert.equal(wire(BASE, baseScan, HEAD, more).badSource.length, 1, '來源只少 1、目的地多 2')
})
test('#2425 用處數：只數 class 位置——註解、一般字串、屬性名、role="note" 不算；一個 class="a note b" 算 1 次', () => {
  const n = (text, ext = '.mjs', name = 'note') => countUses(text, ext).get(name) ?? 0
  assert.equal(n('// 這裡提到 m-err 與 note\nconst x = 1', '.mjs', 'm-err'), 0, '註解不算')
  assert.equal(n('/* .note{} */ a{}', '.css'), 0, 'CSS 註解不算')
  assert.equal(n(`const s = 'note'; log("note", st.voice.note)`), 0, '一般字串、屬性名不算')
  assert.equal(n('<p role="note">x</p>'), 0, 'role="note" 本身不算')
  assert.equal(n('<p class="a note b">x</p>', '.html'), 1)
  assert.equal(n('<p class="note">x</p><p class="note">y</p>', '.html'), 2, '兩處 class 算兩次')
  assert.equal(n(`<p role="note" class="note">x</p>`, '.html'), 1, '同一個標籤被多關抓到只算一次')
  assert.equal(n('const t = "<p class=\\"note\\">x</p>"'), 1, '跳脫的 class=\\"…\\" 算一次')
  assert.equal(n(`h('p', { class: ['x-err', ok && 'x-note'] }); el.className = 'x-err'`, '.mjs', 'x-err'), 2)
  assert.equal(n(`el.classList.add('q-why', 'q-why')`, '.js', 'q-why'), 2, 'classList 兩個字串各算一次')
  assert.equal(n('.x-hint:hover{color:red} .x-hint .y{} <style>.q{}</style>', '.css', 'x-hint'), 2, 'CSS 選擇器每出現一次算一次')
  const a = scanSources([{ rel: 'ui/m.html', text: '<p class="m-err">x</p>' }])
  const b = scanSources([{ rel: DEST, text: 'const t = `<p class="m-err">${x}</p>`' }])
  assert.equal(a.uses.get('m-err'), b.uses.get('m-err'), 'html 屬性 → mjs 模板字串，同一把尺')
})
test('#2425 用處數：note 從 1 處改成放 2 處 class，守門要紅（舊版用整個字數，一般字會當餘額）', () => {
  const base = scanSources([{ rel: 'ui/lib/s.mjs', text: '<p class="note">x</p> ' + 'st.voice.note '.repeat(12) + '<i role="note">' }])
  const head = scanSources([{ rel: 'ui/lib/s.mjs', text: 'st.voice.note '.repeat(12) + '<i role="note">' }, { rel: 'ui/lib/n.mjs', text: '<p class="note">a</p><p class="note">b</p>' }])
  assert.equal(base.uses.get('note'), 1)
  assert.equal(head.uses.get('note'), 2)
  const g0 = G({ note: ['ui/lib/s.mjs'] })
  assert.deepEqual(wire(g0, base, G({ note: ['ui/lib/n.mjs'] }), head).usesGrew, ['note（1 → 2）'])
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
