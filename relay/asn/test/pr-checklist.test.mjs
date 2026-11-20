// PR 範本檢查（#1805）：三項必填檢查沒勾或沒說明就紅、豁免標籤不能放行程式變更、「復發」標籤要有以單號命名的守門測試
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { ITEMS, addedLines, changedFiles, descOk, evaluate, exemption, isDocOrCi, isTestPath, parseChecklist, recurrence, stripComments } from '../../../.github/scripts/pr-checklist.mjs'

const root = new URL('../../../', import.meta.url)
const TEMPLATE = fs.readFileSync(new URL('.github/pull_request_template.md', root), 'utf8').replace(/\r\n/g, '\n')
const SCRIPT = fileURLToPath(new URL('.github/scripts/pr-checklist.mjs', root))

const FILLED = `## 說明
改了設定頁。

## 必填檢查
- [x] **手機和電腦一起改了嗎？** 說明：兩邊共用同一個元件，手機和電腦一起改了
- [x] **測試用的是真資料或真路徑嗎？** 說明：用 30家用資料庫裡實際存的啟動設定當輸入
- [x] **有「舊程式會紅」的回歸測試嗎？** 測試名稱：launcher-term-rows.test.mjs 的「真資料」那條，還原驗證會紅

## 復發單號
（沒有）
`

test('範本本身：三項都在、都沒勾，直接送出會紅（不能留預設就過）', () => {
  const r = parseChecklist(TEMPLATE)
  assert.equal(r.length, 3)
  for (const it of r) { assert.equal(it.found, true, it.label); assert.equal(it.checked, false, it.label); assert.equal(it.ok, false) }
  assert.equal(evaluate({ title: 'x', body: TEMPLATE, headRef: 'fix/x', labels: [], files: ['relay/asn/ui/list.js'] }).pass, false)
})

test('範本的關鍵字與檢查程式的三項一致（改了範本文字就要一起改程式，否則找不到那一項）', () => {
  for (const it of ITEMS) assert.ok(TEMPLATE.includes(it.key), `範本找不到「${it.key}」`)
  assert.match(TEMPLATE, /復發單號/)
  assert.match(TEMPLATE, /免檢查表/)
})

test('範本上方的 HTML 註解不算數；註解裡的勾選與說明不會被當成已填', () => {
  assert.ok(!stripComments('<!-- a\nb -->x').includes('a'))
  const body = `<!-- - [x] **手機和電腦一起改了嗎？** 說明：寫在註解裡的不算數 -->\n${TEMPLATE}`
  assert.equal(parseChecklist(body).filter(r => r.ok).length, 0)
})

test('三項都勾且寫了說明：通過', () => {
  const r = parseChecklist(FILLED)
  assert.deepEqual(r.map(x => x.ok), [true, true, true])
  assert.equal(evaluate({ title: 'x', body: FILLED, headRef: 'fix/x', labels: [], files: ['relay/asn/ui/list.js'] }).pass, true)
})

test('沒勾、勾了但說明留「…」、說明太短、整項被刪掉，都紅，並說明是哪一項哪裡不對', () => {
  const miss = FILLED.replace('- [x] **手機和電腦一起改了嗎？**', '- [ ] **手機和電腦一起改了嗎？**')
  assert.equal(parseChecklist(miss)[0].why, '沒有勾')
  const placeholder = FILLED.replace('說明：兩邊共用同一個元件，手機和電腦一起改了', '說明：…（只改一邊就要寫明）')
  assert.match(parseChecklist(placeholder)[0].why, /沒有寫說明/)
  const short = FILLED.replace('說明：兩邊共用同一個元件，手機和電腦一起改了', '說明：有')
  assert.equal(parseChecklist(short)[0].ok, false)
  const gone = FILLED.split('\n').filter(l => !l.includes('測試用的是真資料或真路徑嗎')).join('\n')
  assert.match(parseChecklist(gone)[1].why, /找不到這一項/)
  const res = evaluate({ title: 'x', body: miss, headRef: 'fix/x', labels: [], files: ['a.js'] })
  assert.equal(res.pass, false)
  assert.ok(res.errors.some(e => e.includes('手機和電腦一起改了嗎') && e.includes('沒有勾')))
})

test('說明可以接在後面縮排的幾行；到下一個勾選項為止', () => {
  const body = FILLED.replace('說明：兩邊共用同一個元件，手機和電腦一起改了', '說明：\n  這是平台本來就沒有的功能，\n  手機沒有「工具列位置」這個選項')
  assert.equal(parseChecklist(body)[0].ok, true)
  assert.equal(descOk('…'), false)
  assert.equal(descOk('（）'), false)
  assert.equal(descOk('只改電腦：手機沒有這個選項'), true)
})

test('豁免：臨時 CI 載具（tmp:）與 release 分支自動豁免', () => {
  assert.equal(exemption({ title: 'tmp: CI for #1795', files: ['relay/asn/ui/list.js'] }).exempt, true)
  assert.equal(exemption({ title: 'release: 0.2.35', headRef: 'release/0.2.35', files: ['relay/asn/ui/list.js'] }).exempt, true)
  assert.equal(exemption({ title: '修一個東西', headRef: 'fix/x', files: ['a.js'] }).exempt, false)
})

test('免檢查表標籤：只有改的檔案真的只有文件與 CI 設定才放行；貼了標籤又改程式就紅', () => {
  assert.equal(isDocOrCi('docs/開發紀律.md'), true)
  assert.equal(isDocOrCi('README.md'), true)
  assert.equal(isDocOrCi('.github/workflows/asn-ui-shots.yml'), true)
  assert.equal(isDocOrCi('relay/asn/ui/list.js'), false)
  const ok = exemption({ labels: ['免檢查表'], files: ['docs/a.md', '.github/workflows/x.yml'] })
  assert.equal(ok.exempt, true)
  const bad = exemption({ labels: ['免檢查表'], files: ['docs/a.md', 'relay/asn/ui/list.js'] })
  assert.equal(bad.exempt, false)
  assert.match(bad.abuse, /relay\/asn\/ui\/list\.js/)
  const res = evaluate({ title: 'x', body: '', headRef: 'fix/x', labels: ['免檢查表'], files: ['relay/asn/ui/list.js'] })
  assert.equal(res.pass, false, '貼標籤也不能放行程式變更')
  assert.equal(exemption({ labels: ['免檢查表'], files: [] }).exempt, false, '看不到改了什麼檔案就不放行')
  assert.equal(evaluate({ title: 'x', body: '', headRef: 'docs/x', labels: ['免檢查表'], files: ['docs/a.md'] }).pass, true)
})

test('測試檔路徑與新增行的解析', () => {
  for (const f of ['relay/asn/test/foo-1764.test.mjs', 'tests/x_sql.test.mjs', 'supabase/functions/_shared/a_test.ts', 'relay/asn/src-tauri/src/bridge/tests.rs', 'relay/asn/test/golden/a.json']) assert.equal(isTestPath(f), true, f)
  for (const f of ['relay/asn/ui/list.js', 'docs/a.md']) assert.equal(isTestPath(f), false, f)
  const m = addedLines('diff --git a/x.rs b/x.rs\n--- a/x.rs\n+++ b/x.rs\n@@ -1 +1,2 @@\n-old\n+fn 回歸_1764() {}\n+let a = 1;\n')
  assert.deepEqual(m.get('x.rs'), ['fn 回歸_1764() {}', 'let a = 1;'])
})

test('復發標籤：要寫復發單號，而且要有以單號命名的守門測試', () => {
  const none = recurrence({ labels: [], body: '' })
  assert.deepEqual([none.required, none.ok], [false, true])
  assert.equal(recurrence({ labels: ['復發'], body: '沒有寫單號' }).ok, false)
  assert.match(recurrence({ labels: ['復發'], body: '' }).why, /復發單號/)
  const body = '## 復發單號\n復發單號：#1764\n'
  // 沒有任何測試：紅
  assert.equal(recurrence({ labels: ['復發'], body, files: ['relay/asn/src-tauri/src/auth.rs'] }).ok, false)
  // 測試檔名含單號：過
  assert.equal(recurrence({ labels: ['復發'], body, files: ['relay/asn/test/auth-1764.test.mjs'] }).ok, true)
  // 新增的測試裡寫了單號（Rust 內嵌測試）：過
  const added = new Map([['relay/asn/src-tauri/src/auth.rs', ['    async fn 回歸_1764_存檔失敗不丟新憑證() {']]])
  assert.equal(recurrence({ labels: ['復發'], body, files: ['relay/asn/src-tauri/src/auth.rs'], added }).ok, true)
  // 別的單號（包含在更大的數字裡）不算：17640、11764
  assert.equal(recurrence({ labels: ['復發'], body, files: ['relay/asn/test/foo-17640.test.mjs', 'relay/asn/test/foo-11764.test.mjs'] }).ok, false)
  // 只在註解或普通程式行提到單號、沒有測試字樣：不算
  const weak = new Map([['relay/asn/src-tauri/src/auth.rs', ['    // 見 1764']]])
  assert.equal(recurrence({ labels: ['復發'], body, files: ['relay/asn/src-tauri/src/auth.rs'], added: weak }).ok, false)
})

test('整合：復發 PR 即使三項都填了，沒有守門測試仍然紅；補上就過', () => {
  const body = FILLED.replace('（沒有）', '復發單號：#1764')
  const bad = evaluate({ title: 'x', body, headRef: 'fix/x', labels: ['復發'], files: ['relay/asn/src-tauri/src/auth.rs'] })
  assert.equal(bad.pass, false)
  assert.ok(bad.errors.some(e => e.includes('#1764')))
  const good = evaluate({ title: 'x', body, headRef: 'fix/x', labels: ['復發'], files: ['relay/asn/src-tauri/src/auth.rs', 'relay/asn/test/auth-1764.test.mjs'] })
  assert.equal(good.pass, true)
})

test('命令列：不是 pull_request 事件（例如手動觸發）直接略過，結束碼 0', () => {
  const r = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8', env: { ...process.env, GITHUB_EVENT_PATH: '' } })
  assert.equal(r.status, 0)
  assert.match(r.stdout, /略過/)
})

test('守門：workflow 只用 pull_request 事件、只讀權限、不用任何外部 action 以外的相依（只 checkout 與 setup-node，釘 SHA）', () => {
  const y = fs.readFileSync(new URL('.github/workflows/asn-pr-checklist.yml', root), 'utf8').replace(/\r\n/g, '\n')
  assert.match(y, /pull_request:/)
  assert.match(y, /types: \[opened, edited, synchronize, reopened, labeled, unlabeled/)
  assert.match(y, /permissions:\n  contents: read/)
  const uses = [...y.matchAll(/uses: (\S+)/g)].map(m => m[1])
  assert.ok(uses.length >= 1)
  for (const u of uses) assert.match(u, /^actions\/(checkout|setup-node)@[0-9a-f]{40}$/, `${u} 要釘 SHA 且只能是 checkout／setup-node`)
  assert.match(y, /node \.github\/scripts\/pr-checklist\.mjs/)
})

test('中文檔名：取改動清單時保留原字，只改中文檔名文件的 PR 貼「免檢查表」能過', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prck-'))
  const g = (...a) => { const r = spawnSync('git', a, { cwd: dir, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout }
  try {
    g('init', '-q', '-b', 'main')
    g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'base')
    g('checkout', '-q', '-b', 'docs-x')
    fs.mkdirSync(path.join(dir, 'docs'))
    fs.writeFileSync(path.join(dir, 'docs', '從頭建置.md'), '# 從頭建置\n')
    g('add', '-A')
    g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'docs')
    const { files, added } = changedFiles('main', dir)
    assert.deepEqual(files, ['docs/從頭建置.md'])
    assert.ok(added.has('docs/從頭建置.md'))
    const r = evaluate({ title: 'docs', body: '', headRef: 'docs-x', labels: ['免檢查表'], files, added })
    assert.equal(r.pass, true, r.errors.join('；'))
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
