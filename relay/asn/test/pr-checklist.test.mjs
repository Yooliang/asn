// PR 範本檢查（#1805）：三項必填檢查沒勾或沒說明就紅、豁免標籤不能放行程式變更、「復發」標籤要有以單號命名的守門測試
// 另外兩項由機器主動發現（紀律 一.2、二.6、六.3）：只動到手機或電腦一邊的頁面與樣式檔（腳本檔不算）要寫「只改一邊：原因」；
// 同一張單修過、發過版又再修算復發，要寫機器比對到的那張復發單號並附守門測試，或寫「不是復發：原因」。
// 在 CI 的 PR 事件下，改動的檔案清單或目標分支的歷史取不到就紅燈（檢查做不了，不當成通過）。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  DESKTOP_UI, ITEMS, MOBILE_UI, ONE_SIDED_SCOPE, addedLines, autoRecurrence, changedFiles, declared, descOk, evaluate, exemption, historyLines,
  isDocOrCi, isFixTitle, isReleaseTitle, isTestPath, oneSided, oneSidedCheck, parseChecklist, recurrence, recurrenceHits, scanRecurrences, stripComments, ticketNumbers, uiSide,
} from '../../../.github/scripts/pr-checklist.mjs'

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
  // 機器主動發現的兩項：範本要教人怎麼寫（關鍵字和檢查程式認的一樣）
  assert.match(TEMPLATE, /「只改一邊：原因」/)
  assert.match(TEMPLATE, /「不是復發：原因」/)
  assert.match(TEMPLATE, /「復發單號：#單號」/)
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

// ---------- 只改一邊畫面：機器依改到的檔主動發現（只看頁面與樣式檔） ----------
const UI = 'relay/asn/ui/'
const uiDir = new URL(UI, root)
const ui = (...names) => names.map(f => UI + f)

test('只改一邊：只動 m.html（或手機的樣式檔）、只動 list.html（或電腦的其他頁面）才算，回報是哪一邊、哪幾個檔', () => {
  assert.deepEqual(oneSided(ui('m.html')), { side: 'mobile', files: ui('m.html') })
  assert.deepEqual(oneSided(ui('list.html')), { side: 'desktop', files: ui('list.html') })
  for (const f of ['m.html', 'mobile.css']) assert.equal(oneSided(ui(f)).side, 'mobile', f)
  for (const f of ['list.html', 'panel.html', 'chat.html', 'login.html', 'onboard.html']) assert.equal(oneSided(ui(f)).side, 'desktop', f)
  // 一起改到的腳本檔、共用模組、測試檔不列進「哪幾個檔」
  assert.deepEqual(oneSided([...ui('m.html', 'mobile.css', 'm.js', 'lib/mobile-nav.mjs'), 'relay/asn/test/x.test.mjs']), { side: 'mobile', files: ui('m.html', 'mobile.css') })
  assert.deepEqual(oneSided(ui('list.html', 'list.js', 'lib/core.mjs')), { side: 'desktop', files: ui('list.html') })
})

test('只改一邊：腳本檔一律不算——只動 list.js、m.js、lib/mobile-*.mjs 都不算只改一邊', () => {
  const scripts = ['list.js', 'panel.js', 'chat.js', 'login.js', 'onboard.js', 'm.js', 'skin-boot.js',
    'lib/mobile.mjs', 'lib/mobile-acct.mjs', 'lib/mobile-nav.mjs', 'lib/mobile-push.mjs', 'lib/mobile-rooms.mjs', 'lib/settings-panel.mjs', 'lib/task-manager.mjs']
  for (const f of scripts) {
    assert.equal(uiSide(UI + f), '', f)
    assert.equal(oneSided(ui(f)).side, '', f)
    const r = evaluate({ title: 'x', body: FILLED, headRef: 'feat/x', labels: [], files: ui(f) })
    assert.equal(r.pass, true, `${f}：${r.errors.join('；')}`)
    assert.ok(!r.lines.some(l => l.includes('只改一邊')), f)
  }
  assert.equal(oneSided(ui(...scripts)).side, '')
  // 真的例子：主線最近被舊清單（腳本檔也算）判成只改電腦的改動，各自在畫面資料夾改到的檔
  assert.equal(oneSided(ui('lib/rust-events.mjs', 'panel.js')).side, '', '#2344')
  assert.equal(oneSided(ui('lib/room-hub.mjs', 'list.js')).side, '', '#2327')
  assert.equal(oneSided(ui('lib/settings-panel.mjs', 'lib/storage-keys.mjs', 'lib/tauri.mjs', 'list.js')).side, '', '#2352、#2349')
  // 腳本檔也不能拿來抵另一邊：改了電腦的頁面，手機那邊只動 m.js，還是只改電腦（真的例子 #2399 在畫面資料夾改到的檔）
  assert.deepEqual(oneSided(ui('lib/local-models.mjs', 'lib/mobile-ops.mjs', 'lib/model-catalog.mjs', 'lib/model-switch.mjs', 'lib/partner-ops-ui.mjs', 'lib/remote-models.mjs', 'list.html', 'list.js', 'm.js')),
    { side: 'desktop', files: ui('list.html') })
  assert.deepEqual(oneSided(ui('m.html', 'list.js')), { side: 'mobile', files: ui('m.html') })
})

test('只改一邊：兩邊都動、只動共用的檔、沒動畫面檔，都不算', () => {
  assert.equal(oneSided(ui('m.html', 'list.html')).side, '')
  assert.equal(oneSided(ui('mobile.css', 'panel.html')).side, '')
  assert.equal(oneSided(ui('lib/chatpane.mjs', 'lib/core.mjs', 'parts/setting-parts.mjs', 'parts/parts.css', 'shells/caps-android.mjs', 'shells/caps-desktop.mjs')).side, '')
  assert.equal(oneSided(['relay/asn/src-tauri/src/auth.rs', 'docs/a.md', 'relay/asn/test/a.test.mjs']).side, '')
  assert.equal(oneSided([]).side, '')
  assert.equal(oneSidedCheck({ files: ui('m.html', 'list.html'), body: '' }).required, false)
})

test('只改一邊：兩邊都載入的樣式檔（style.css 與各外觀）算共用；電腦才有的小視窗、別的資料夾裡同名的檔不算', () => {
  for (const f of ['style.css', 'kit.css', 'group.css', 'modern.css', 'line.css', 'skin-common.css', 'parts/parts.css']) assert.equal(uiSide(UI + f), '', f)
  for (const f of ['toast.html', 'askpass.html', 'setup-progress.html', 'shot.html']) assert.equal(uiSide(UI + f), '', f)
  assert.equal(uiSide('site/public/m.html'), '')
  assert.equal(uiSide('relay/asn/test/list.html'), '')
  assert.equal(uiSide(UI + 'sub/m.html'), '')
  assert.equal(uiSide(UI + 'xm.html'), '')
  // 真的例子，都是那張 PR 在畫面資料夾改到的檔：
  // #2245：手機的頁面與樣式，加共用的 style.css 與兩個共用模組 → 只改手機（style.css 不能當成電腦那一邊）
  assert.deepEqual(oneSided(ui('lib/account-roster.mjs', 'lib/settings-panel.mjs', 'm.html', 'mobile.css', 'style.css')), { side: 'mobile', files: ui('m.html', 'mobile.css') })
  // #2209：電腦的登入頁，加三個模組 → 只改電腦
  assert.deepEqual(oneSided(ui('lib/login-panel.mjs', 'lib/login.mjs', 'lib/mobile.mjs', 'login.html', 'login.js')), { side: 'desktop', files: ui('login.html') })
  // #1661：全是共用的樣式與模組 → 不算
  assert.equal(oneSided(ui('group.css', 'lib/chatpane.mjs', 'lib/mobile-rooms.mjs', 'lib/room-hub.mjs')).side, '')
})

test('只改一邊：沒寫「只改一邊：原因」就紅，訊息講明哪一邊、哪幾個檔、怎麼辦；寫了就過，原因印進報告', () => {
  const files = [...ui('list.html', 'panel.html', 'list.js', 'lib/core.mjs'), 'relay/asn/test/list.test.mjs']
  const bad = evaluate({ title: 'x', body: FILLED, headRef: 'feat/x', labels: [], files })
  assert.equal(bad.pass, false)
  assert.equal(bad.errors.length, 1, bad.errors.join('；'))
  const msg = bad.errors[0]
  assert.match(msg, /只動到電腦的頁面與樣式檔（relay\/asn\/ui\/list\.html、relay\/asn\/ui\/panel\.html）/)
  assert.match(msg, /手機的頁面與樣式檔完全沒動/)
  assert.match(msg, /補上手機那一邊/)
  assert.match(msg, /「只改一邊：是哪個平台本來就沒有這個功能」/)
  assert.match(msg, /手機那一邊其實改在腳本檔或共用的檔，也寫在這一行/)
  // 反過來：只動手機
  const m = evaluate({ title: 'x', body: FILLED, headRef: 'feat/x', labels: [], files: ui('m.html') })
  assert.match(m.errors.join('\n'), /只動到手機的頁面與樣式檔（relay\/asn\/ui\/m\.html），電腦的頁面與樣式檔完全沒動/)
  assert.match(m.errors.join('\n'), /補上電腦那一邊/)
  // 全形、半形冒號都收
  for (const colon of ['：', ':', ' : ']) {
    const ok = evaluate({ title: 'x', body: `${FILLED}\n只改一邊${colon}手機本來就沒有工作管理員這個畫面\n`, headRef: 'feat/x', labels: [], files })
    assert.equal(ok.pass, true, ok.errors.join('；'))
    assert.ok(ok.lines.some(l => l.includes('只改一邊') && l.includes('手機本來就沒有工作管理員這個畫面')), '原因要印進報告給審查的人看')
  }
})

test('只改一邊：報告那一行不管過或不過，最後都寫明檢查範圍（只看頁面與樣式檔，腳本檔與共用模組要靠審查的人看）', () => {
  assert.equal(ONE_SIDED_SCOPE, '這項只看頁面與樣式檔；腳本檔與共用的畫面模組（ui/lib、ui/parts、style.css）不在檢查範圍，要靠審查的人看。')
  const files = ui('m.html', 'mobile.css')
  const line = body => evaluate({ title: 'x', body, headRef: 'feat/x', labels: [], files }).lines.filter(l => l.includes('只改一邊'))
  const red = line(FILLED)
  assert.equal(red.length, 1)
  assert.ok(red[0].startsWith('- ❌ 只改一邊：') && red[0].endsWith(ONE_SIDED_SCOPE), red[0])
  const short = line(`${FILLED}\n只改一邊：沒有\n`)
  assert.ok(short[0].startsWith('- ❌ 只改一邊：') && short[0].endsWith(ONE_SIDED_SCOPE), short[0])
  for (const reason of ['電腦本來就沒有推播設定這一頁', '電腦本來就沒有推播設定這一頁。']) {
    const green = line(`${FILLED}\n只改一邊：${reason}\n`)
    assert.equal(green.length, 1)
    assert.ok(green[0].startsWith('- ✅ 只改一邊：') && green[0].endsWith(`PR 說明寫的原因：電腦本來就沒有推播設定這一頁。${ONE_SIDED_SCOPE}`), green[0])
  }
  // 沒觸發（兩邊都動、只動腳本）就沒有這一行
  assert.deepEqual(evaluate({ title: 'x', body: FILLED, headRef: 'feat/x', labels: [], files: ui('m.html', 'list.html') }).lines.filter(l => l.includes('只改一邊')), [])
})

test('只改一邊：原因太短、留著「…」、寫在註解裡、沒有自成一行，都不算；清單符號、引言、粗體開頭的算', () => {
  const files = ui('m.html')
  const run = extra => evaluate({ title: 'x', body: `${FILLED}\n${extra}\n`, headRef: 'feat/x', labels: [], files })
  const short = run('只改一邊：沒有')
  assert.equal(short.pass, false)
  assert.match(short.errors.join('\n'), /「只改一邊：」後面的原因沒寫清楚/)
  assert.equal(run('只改一邊：…').pass, false)
  assert.equal(run('只改一邊：').pass, false)
  assert.equal(run('<!-- 只改一邊：電腦本來就沒有推播設定這一頁 -->').pass, false, '寫在註解裡的不算')
  assert.equal(run('這張是只改一邊：電腦本來就沒有推播設定這一頁').pass, false, '要自成一行')
  assert.equal(run('只改一邊就要寫明：電腦本來就沒有推播設定這一頁').pass, false)
  for (const line of ['- 只改一邊：電腦本來就沒有推播設定這一頁', '  * 只改一邊: 電腦本來就沒有推播設定這一頁', '> 只改一邊：電腦本來就沒有推播設定這一頁', '**只改一邊：**電腦本來就沒有推播設定這一頁', '**只改一邊**：電腦本來就沒有推播設定這一頁']) {
    assert.equal(run(line).pass, true, line)
  }
  // 兩行都有：取原因寫清楚的那一行
  assert.deepEqual(declared('只改一邊：…\n只改一邊：電腦本來就沒有推播設定這一頁', '只改一邊'), { found: true, ok: true, reason: '電腦本來就沒有推播設定這一頁' })
  assert.deepEqual(declared('沒有這一行', '只改一邊'), { found: false, ok: false, reason: '' })
})

test('只改一邊：豁免沿用既有的（臨時 CI 載具、release 分支、免檢查表）', () => {
  const files = ui('list.html')
  assert.equal(evaluate({ title: 'tmp: CI for #1795', body: '', headRef: 'tmp/x', labels: [], files }).pass, true)
  assert.equal(evaluate({ title: 'release: 0.2.35', body: '', headRef: 'release/0.2.35', labels: [], files }).pass, true)
  // 免檢查表只放行文件與 CI 設定：改到頁面檔照樣紅，而且照樣要說明只改一邊
  const abuse = evaluate({ title: 'x', body: FILLED, headRef: 'docs/x', labels: ['免檢查表'], files })
  assert.equal(abuse.pass, false)
  assert.ok(abuse.errors.some(e => e.includes('只動到電腦的頁面與樣式檔')))
})

// 把範本的三項必填填好，其他字一個都不動（教人怎麼寫的那幾句都還在）
const TEMPLATE_FILLED = TEMPLATE.replace(/^- \[ \] (\*\*.+?\*\*) (說明|測試名稱)：….*$/gm, '- [x] $1 $2：這一項已經照實寫了完整的說明')

test('範本原文不算已經申報：範本裡教人怎麼寫的那幾句，不會被當成「只改一邊」「不是復發」「復發單號」', () => {
  assert.deepEqual(parseChecklist(TEMPLATE_FILLED).map(x => x.ok), [true, true, true])
  assert.equal(declared(TEMPLATE, '只改一邊').found, false)
  assert.equal(declared(TEMPLATE, '不是復發').found, false)
  assert.equal(recurrence({ labels: ['復發'], body: TEMPLATE }).ok, false)
  // 第一項底下那句提示在註解裡：不會被算進第一項的說明（否則說明只寫一個字也會過）
  const oneWord = TEMPLATE_FILLED.replace('說明：這一項已經照實寫了完整的說明', '說明：有')
  assert.equal(parseChecklist(oneWord)[0].ok, false)
  const os = evaluate({ title: 'x', body: TEMPLATE_FILLED, headRef: 'feat/x', labels: [], files: ui('m.html') })
  assert.equal(os.pass, false)
  assert.ok(os.errors.every(e => e.includes('只動到手機的頁面與樣式檔')), os.errors.join('；'))
  const rc = evaluate({ title: PR903, body: TEMPLATE_FILLED, headRef: 'fix/903', labels: [], files: ['relay/asn/src-tauri/src/term.rs'], baseTitles: H903 })
  assert.equal(rc.pass, false)
  assert.ok(rc.errors.every(e => e.includes('機器判定是復發')), rc.errors.join('；'))
})

test('守門：兩份頁面與樣式檔清單上的檔都真的存在，而且沒有腳本檔（清單不能留著已經刪掉、改名的檔）', () => {
  assert.ok(MOBILE_UI.length >= 1 && DESKTOP_UI.length >= 1)
  for (const f of [...MOBILE_UI, ...DESKTOP_UI]) {
    assert.match(f, /^[^/]+\.(html|css)$/, `${f}：這份清單只放頁面與樣式檔，腳本檔不算（實測會誤報純邏輯的改動）`)
    assert.ok(fs.existsSync(new URL(f, uiDir)), `relay/asn/ui/${f} 不存在，請更新 .github/scripts/pr-checklist.mjs 的清單`)
  }
  assert.ok(!MOBILE_UI.some(f => DESKTOP_UI.includes(f)), '同一個檔不能兩邊都列')
  // 兩邊都載入的樣式檔不能列成某一邊：手機頁面真的有載入 style.css
  assert.match(fs.readFileSync(new URL('m.html', uiDir), 'utf8'), /href="style\.css"/)
  assert.ok(![...MOBILE_UI, ...DESKTOP_UI].includes('style.css'))
})

// ---------- 復發：機器比對歷史 ----------
// 下面的標題都是這個 repo 主線上真的提交標題（2026-11-27 從 git log 取出，照進主線的先後；中間無關的提交略去），直接寫死當固定資料。

// 一、同一張單修過、發過版、後來又修：#903（11-07 修、補修，發了 0.2.8～0.2.13，11-10 又修）
const H903 = [
  'release: 0.2.7',
  '終端畫面：拿掉「回到訊息」按鈕、修游標差一到兩列（#901b／#903）',
  '終端畫面游標落在輸入列下一列：整份結尾帶殘留顏色序列時沒去掉假列（#903 補修）',
  'release: 0.2.8',
  'release: 0.2.9',
  'release: 0.2.10',
  'release: 0.2.11（候選）',
  'release: 0.2.11（官網檔）',
  'release: 0.2.12（候選）',
  'release: 0.2.12（官網檔；已知問題第 1 條改成橫向畫面）',
  'release: 0.2.13',
]
const PR903 = '修 #903：終端畫面游標對位——emoji 字寬對齊 WezTerm、手機看終端跟著窗格欄列數'
const PRIOR903 = '終端畫面游標落在輸入列下一列：整份結尾帶殘留顏色序列時沒去掉假列（#903 補修）'

// 一之二、標題結尾帶合併時自動加的 PR 編號：#2161（3c 那張是修正、發了 0.2.90，之後 F1 那張又是修正）
const H2161 = [
  '#2161 第 3a 段：開窗清單與切換帳號待處理輪詢降到 60 秒（追啟動進度維持 15 秒） (#2224)',
  '#2161 3b：term_view_pending 輪詢保底間隔 10 秒改 30 秒 (#2226)',
  'fix(asn): #2161 3c term_req_take 輪詢有請求才快、閒置慢 (#2228)',
  'release: 0.2.90',
  'release: 0.2.91',
  '#2161 第 3d-1 段：手機決定權限框／終端確認後，後台敲門鈴（migration＋Edge） (#2265)',
  'release: 0.2.92',
  '#2161 第 3d-2 段：權限框／終端請求改由門鈴叫醒領取（perm 保底 10 秒、term 有請求 10 秒） (#2269)',
  'release: 0.2.93',
]
const PR2161 = 'fix(#2161 F1): node_update_status 輪詢改為依進行中狀態變速'   // 合進主線後的標題結尾多了「 (#2271)」
const PRIOR2161 = 'fix(asn): #2161 3c term_req_take 輪詢有請求才快、閒置慢 (#2228)'

// 二、同一張單連續好幾張 PR，但都不是修正：#2355（P1～P3，發了 0.2.103，再來 P4）
const H2355 = [
  'release: 0.2.102',
  '#2355 P1：型號清單的前端純函式（remote-models.mjs），不改畫面 (#2396)',
  '#2355 P2：新增本機讀型號清單的 Tauri 命令 agent_models（兩審） (#2397)',
  '#2355 P3：電腦版本機接上型號清單（開新夥伴第 2 頁、切換模型），依賴 #2397 (#2399)',
  'release: 0.2.103',
]
const PR2355 = '#2355 P4：替別台開窗帶型號、開好顯示實際型號、手機接上型號清單（兩審，等 #2393 發版）'

// 二之二、這張標題有「修」字，但同一張單先前幾張都不是修正：#2038（PR-1～PR-4，發了 0.2.99，再來 PR-5）
const H2038 = [
  '#2038 PR-1：前端事件中心（EventHub）＋Rust 橋，先搬安裝視窗四種事件（Rust 不動） (#2334)',
  '#2038 PR-2：進度類事件改從事件中心訂閱 (#2337)',
  '#2038 PR-3：帳號登入類事件改從事件中心訂閱 (#2338)',
  '#2038 PR-4：邀請碼、正在聽、被看提示改走 EventHub（兩種沒人接的只登記） (#2339)',
  'release: 0.2.99',
]
const PR2038 = '#2038 PR-5：門鈴 relay-bell 6 個接收處改走 EventHub，修 poll-intervals 假綠（兩審）'

// 三、修正了、還沒發版就又補一張：#1897（0.2.54 之後一審修正，還沒發下一版就二審修正；之後才發 0.2.55）
const H1897 = [
  'release: 0.2.54',
  '#1897 ④ 終端服務心跳停了就判卡死，結束後接回',
  '#1897 ④ 一審修正：核對判停那一輪的 mux 與 seq、事故文字依有沒有接回分兩句',
  '#1897 ④ 沒有 seen 時不處置，只寫一次 mux.log，下一輪有 seen 才處置',
]
const PR1897 = '#1897 ④ 二審修正：結束前再驗、不殺 ASN 自己與祖先、cli 跑不起來不當成連不上、心跳恢復重設通知'
const PRIOR1897 = '#1897 ④ 一審修正：核對判停那一輪的 mux 與 seq、事故文字依有沒有接回分兩句'

test('修正字樣（真標題）：fix、修、復發算修正；prefix、fixture 這類別的字與一般功能標題不算', () => {
  for (const t of [
    'fix(#2412): 動態開背景夥伴與 start 共用帳本，不再 ReferenceError (#2421)',
    'fix(asn): #2161 3c term_req_take 輪詢有請求才快、閒置慢 (#2228)',
    'fix: 換班接手後新視窗不再因收空的終端服務而退回原生主控台 (#1867)',
    '修正 #2307：重開機接回時，原本藏著的終端服務夥伴被開成可見視窗 (#2308)',
    '#2197 修 relay/index.ts 型別錯，CI 加 deno check (#2390)',
    '修 main 紅燈：運行手冊不寫裸的 --failed，改 docs/release/ 要觸發 Node 測試（#2360） (#2369)',
    'test: #1808 復發防護守門測試（第 4、5、7、8、15 組）',
    PR903, PR2161, PR2038, PR1897,
  ]) assert.equal(isFixTitle(t), true, t)
  for (const t of [
    'test(fixtures): C1 終端畫面樣本（claude、pi，已遮罩）',
    '群組自動收入（後端）：rooms.auto_prefixes、成員 joined_via；roster 回報與設定變更時比對視窗名開頭字串自動入群、視窗消失標離開；附測試',
    'feat(asn): #2171 啟動時清掉崩潰後殘留的原子寫入暫存檔 (#2247)',
    'release: 0.2.103',
    PR2355,
  ]) assert.equal(isFixTitle(t), false, t)
  // 大小寫與變化形（這幾個是自己寫的短例子，只驗字樣規則）
  for (const t of ['Fix: x', 'FIX x', 'fixes #12', 'fixed #12', 'hot-fix']) assert.equal(isFixTitle(t), true, t)
  for (const t of ['prefix', 'hotfix', 'suffix 調整', 'fixture', '', null, undefined]) assert.equal(isFixTitle(t), false, String(t))
  assert.equal(isReleaseTitle('release: 0.2.11（候選）'), true)
  assert.equal(isReleaseTitle('發版 v0.2.103：更新 latest.json 與首頁下載連結'), false)
  assert.equal(isReleaseTitle('docs: release: 流程說明'), false)
})

test('取單號（真標題）：標題裡的 #數字 都算，全形括號裡的也算；結尾括號的 PR 編號不算', () => {
  assert.deepEqual(ticketNumbers('fix(#2412): 動態開背景夥伴與 start 共用帳本，不再 ReferenceError (#2421)'), ['2412'])
  assert.deepEqual(ticketNumbers('手機核對指紋時，電腦自動跳出 QR Code；設定頁拿掉 QR 分頁（#1863） (#2285)'), ['1863'])
  assert.deepEqual(ticketNumbers('#2355 P4：替別台開窗帶型號、開好顯示實際型號、手機接上型號清單（兩審，等 #2393 發版） (#2401)'), ['2355', '2393'])
  assert.deepEqual(ticketNumbers('終端畫面：拿掉「回到訊息」按鈕、修游標差一到兩列（#901b／#903）'), ['901', '903'])
  assert.deepEqual(ticketNumbers('紀律：同一條規則只有一個實作（復發統計最大宗）'), [])
  // 同一個單號出現兩次只算一次
  assert.deepEqual(ticketNumbers('#1548 審查修正：#1548 的上限只在設定頁改過才寫'), ['1548'])
  // 結尾括號：歷史裡的標題一律當成合併時自動加的 PR 編號
  const tail = 'fix: 換班接手後新視窗不再因收空的終端服務而退回原生主控台 (#1867)'
  assert.deepEqual(ticketNumbers(tail), [])
  // 檢查某一張 PR 時知道它自己的編號：結尾括號裡不是自己編號的，是作者寫的單號，照算；是自己的編號就不算
  assert.deepEqual(ticketNumbers(tail, { own: 1870 }), ['1867'])
  assert.deepEqual(ticketNumbers(tail, { own: 1867 }), [])
  assert.deepEqual(ticketNumbers('fix(#2412): 動態開背景夥伴與 start 共用帳本，不再 ReferenceError (#2421)', { own: 2421 }), ['2412'])
})

test('復發判斷（真標題）：#903 修過、發過版、後來又修，命中並帶出先前那筆修正', () => {
  assert.deepEqual(recurrenceHits(PR903, H903), [{ n: '903', prior: PRIOR903 }])
  // 標題結尾的 PR 編號不是單號：命中的是 #2161，不是 #2228、#2271
  assert.deepEqual(recurrenceHits(PR2161, H2161), [{ n: '2161', prior: PRIOR2161 }])
  assert.deepEqual(recurrenceHits(`${PR2161} (#2271)`, H2161), [{ n: '2161', prior: PRIOR2161 }])
  assert.deepEqual(recurrenceHits(PR2161, H2161, { own: 2271 }), [{ n: '2161', prior: PRIOR2161 }])
  // 修的是別張單：不算
  assert.deepEqual(recurrenceHits('修 #904：別的毛病', H903), [])
  // 走一遍歷史的結果：#903、#901 都記成已經發過版的修正，取最近一筆
  const { released, hits } = scanRecurrences(H903)
  assert.equal(released.get('903'), PRIOR903)
  assert.equal(released.get('901'), '終端畫面：拿掉「回到訊息」按鈕、修游標差一到兩列（#901b／#903）')
  assert.deepEqual(hits, [], '這段歷史本身沒有復發（兩筆修正之間沒有發版）')
})

test('復發判斷（真標題）：同一張單連續好幾張 PR 但不是修正（#2355、#2038），不算復發', () => {
  assert.deepEqual(recurrenceHits(PR2355, H2355), [], '這張和先前幾張都不是修正')
  assert.equal(isFixTitle(PR2038), true)
  assert.deepEqual(recurrenceHits(PR2038, H2038), [], '這張標題有「修」，但先前幾張不是修正')
  // 反過來：先前修過又發過版，但這張不是修正，也不算
  assert.deepEqual(recurrenceHits('終端字寬：emoji 只看 Emoji_Presentation，🖥 🌡 這類文字樣式符號照 1 格（#903 二審）', H903), [])
})

test('復發判斷（真標題）：#1897 修正還沒發版就又補一張，不算；發了版之後再修才算', () => {
  assert.deepEqual(recurrenceHits(PR1897, H1897), [])
  assert.deepEqual(recurrenceHits(PR1897, [...H1897, 'release: 0.2.55']), [{ n: '1897', prior: PRIOR1897 }])
  // 發版在修正之前不算數：只有「修正之後」的發版才算發過版
  assert.deepEqual(recurrenceHits(PR1897, ['release: 0.2.53', ...H1897]), [])
  assert.deepEqual(recurrenceHits(PR903, []), [])
})

test('復發（機器比對）：命中就照「復發」標籤處理——沒寫復發單號紅、寫了沒有守門測試紅、兩樣都有才過', () => {
  const base = { title: PR903, headRef: 'fix/903', labels: [], baseTitles: H903 }
  const src = ['relay/asn/src-tauri/src/term.rs']
  const none = evaluate({ ...base, body: FILLED, files: src })
  assert.equal(none.pass, false)
  assert.equal(none.errors.length, 1, none.errors.join('；'))
  // 訊息：講明是哪張單、先前那筆修正的標題、兩條路怎麼走
  assert.match(none.errors[0], /修的 #903 在主線上已經修過並且發過版/)
  assert.ok(none.errors[0].includes(`先前那筆修正：「${PRIOR903}」`))
  assert.match(none.errors[0], /一、是復發：在 PR 說明寫「復發單號：#903」，並在這張 PR 加一支以單號命名的守門測試/)
  assert.match(none.errors[0], /二、確定不是復發：在 PR 說明另外加一行「不是復發：原因」/)
  const body = FILLED.replace('（沒有）', '復發單號：#903')
  const noTest = evaluate({ ...base, body, files: src })
  assert.equal(noTest.pass, false)
  assert.match(noTest.errors[0], /寫了復發單號 #903，但這張 PR 沒有以 903 命名的守門測試/)
  const byName = evaluate({ ...base, body, files: [...src, 'relay/asn/test/term-cursor-903.test.mjs'] })
  assert.equal(byName.pass, true, byName.errors.join('；'))
  assert.ok(byName.lines.some(l => l.includes('照復發處理') && l.includes('term-cursor-903.test.mjs')))
  const added = new Map([['relay/asn/test/term-cursor.test.mjs', ["test('#903 游標對位：emoji 字寬', () => {"]]])
  assert.equal(evaluate({ ...base, body, files: [...src, 'relay/asn/test/term-cursor.test.mjs'], added }).pass, true)
  // 純函式的回傳
  assert.deepEqual(autoRecurrence({ title: PR2355, baseTitles: H2355, body: FILLED }), { required: false, ok: true, hits: [], waived: '', why: '' })
})

test('復發（機器比對）：申報的復發單號必須是機器比對到的那一張——寫別張單、附那張單的守門測試也不過', () => {
  const base = { title: PR903, headRef: 'fix/903', labels: [], baseTitles: H903 }
  const src = ['relay/asn/src-tauri/src/term.rs']
  const other = FILLED.replace('（沒有）', '復發單號：#1764')
  // 別張單（#1764），而且真的附了以 1764 命名的守門測試：照樣紅
  const wrong = evaluate({ ...base, body: other, files: [...src, 'relay/asn/test/auth-1764.test.mjs'] })
  assert.equal(wrong.pass, false)
  assert.equal(wrong.errors.length, 1, wrong.errors.join('；'))
  assert.match(wrong.errors[0], /機器比對到的是 #903，PR 說明寫的復發單號是 #1764，不是同一張/)
  assert.match(wrong.errors[0], /復發單號要寫機器比對到的那一張，守門測試也要用那個單號命名/)
  assert.ok(wrong.errors[0].includes(`先前那筆修正：「${PRIOR903}」`))
  // 新增的測試裡寫上 1764 也一樣不過
  const added1764 = new Map([['relay/asn/src-tauri/src/auth.rs', ['    async fn 回歸_1764_存檔失敗不丟新憑證() {']]])
  assert.equal(evaluate({ ...base, body: other, files: ['relay/asn/src-tauri/src/auth.rs'], added: added1764 }).pass, false)
  // 單號只是包含在更大的數字裡不算同一張（#9030、#90）
  for (const n of ['9030', '90']) assert.equal(evaluate({ ...base, body: FILLED.replace('（沒有）', `復發單號：#${n}`), files: [...src, `relay/asn/test/x-${n}.test.mjs`] }).pass, false, n)
  // 寫機器比對到的那一張才過
  const right = evaluate({ ...base, body: FILLED.replace('（沒有）', '復發單號：#903'), files: [...src, 'relay/asn/test/term-cursor-903.test.mjs'] })
  assert.equal(right.pass, true, right.errors.join('；'))
  // 機器比對到兩張（真歷史裡 #901、#903 都修過又發過版）：寫其中任何一張都可以，寫第三張不行，訊息把兩張都列出來
  const both = { ...base, title: '修 #901、#903：終端游標還是差一列' }
  for (const n of ['901', '903']) {
    const r = evaluate({ ...both, body: FILLED.replace('（沒有）', `復發單號：#${n}`), files: [...src, `relay/asn/test/term-cursor-${n}.test.mjs`] })
    assert.equal(r.pass, true, `${n}：${r.errors.join('；')}`)
  }
  const third = evaluate({ ...both, body: other, files: [...src, 'relay/asn/test/auth-1764.test.mjs'] })
  assert.equal(third.pass, false)
  assert.match(third.errors[0], /機器比對到的是 #901、#903，PR 說明寫的復發單號是 #1764，不是同一張/)
})

test('復發（機器比對）：貼「復發」標籤換不掉機器比對到的那一張；機器沒命中、只貼標籤的照舊', () => {
  const src = ['relay/asn/src-tauri/src/term.rs']
  const other = FILLED.replace('（沒有）', '復發單號：#1764')
  const files = [...src, 'relay/asn/test/auth-1764.test.mjs']
  // 機器命中 #903，貼了標籤、申報別張單：一樣紅
  const labelled = evaluate({ title: PR903, body: other, headRef: 'fix/903', labels: ['復發'], files, baseTitles: H903 })
  assert.equal(labelled.pass, false)
  assert.match(labelled.errors.join('\n'), /機器比對到的是 #903，PR 說明寫的復發單號是 #1764/)
  // 貼了標籤、申報機器比對到的那一張：過
  assert.equal(evaluate({ title: PR903, body: FILLED.replace('（沒有）', '復發單號：#903'), headRef: 'fix/903', labels: ['復發'], files: [...src, 'relay/asn/test/term-cursor-903.test.mjs'], baseTitles: H903 }).pass, true)
  // 真正復發的是別張單：先寫「不是復發：原因」說明機器比對到的那張為什麼不算，再照標籤申報別張
  const waived = evaluate({ title: PR903, body: `${other}\n不是復發：#903 這次是另一個毛病，真正又壞的是 #1764\n`, headRef: 'fix/903', labels: ['復發'], files, baseTitles: H903 })
  assert.equal(waived.pass, true, waived.errors.join('；'))
  assert.ok(waived.lines.some(l => l.includes('不是復發：#903 這次是另一個毛病') && l.includes('請審查的人確認這個原因')))
  assert.ok(waived.lines.some(l => l.includes('守門測試檔：relay/asn/test/auth-1764.test.mjs')))
  // 機器沒命中（標題不是修正、修的單沒修過、沒給歷史）：只貼標籤的那條路和以前一樣，申報哪一張都可以
  for (const [title, baseTitles] of [['新功能：設定頁加一個開關', H903], ['修 #904：別的毛病', H903], [PR903, undefined]]) {
    const r = evaluate({ title, body: other, headRef: 'fix/x', labels: ['復發'], files, baseTitles })
    assert.equal(r.pass, true, `${title}：${r.errors.join('；')}`)
    assert.equal(evaluate({ title, body: other, headRef: 'fix/x', labels: ['復發'], files: src, baseTitles }).pass, false, '沒有守門測試照舊紅')
  }
})

test('復發（機器比對）：「不是復發：原因」放行，原因印進報告給審查的人看；原因太短、寫在註解裡不放行', () => {
  const base = { title: PR2161, number: 2271, headRef: 'fix/2161-f1', labels: [], baseTitles: H2161, files: ['relay/asn/ui/lib/remote-update.mjs'] }
  assert.equal(evaluate({ ...base, body: FILLED }).pass, false)
  const reason = '#2161 是分階段的降頻單，這張是其中一段，不是同一個毛病又壞'
  for (const colon of ['：', ':']) {
    const ok = evaluate({ ...base, body: `${FILLED}\n不是復發${colon}${reason}\n` })
    assert.equal(ok.pass, true, ok.errors.join('；'))
    const line = ok.lines.find(l => l.includes('不是復發'))
    assert.ok(line?.includes(reason), '原因要印進報告')
    assert.ok(line.includes(PRIOR2161), '先前那筆修正也要印出來，審查的人才有得對')
    assert.match(line, /請審查的人確認這個原因/)
  }
  const short = evaluate({ ...base, body: `${FILLED}\n不是復發：不是\n` })
  assert.equal(short.pass, false)
  assert.match(short.errors[0], /「不是復發：」後面的原因沒寫清楚/)
  assert.equal(evaluate({ ...base, body: `${FILLED}\n<!-- 不是復發：${reason} -->\n` }).pass, false)
  assert.equal(evaluate({ ...base, body: `${FILLED}\n我覺得這張不是復發：${reason}\n` }).pass, false, '要自成一行')
})

test('復發（機器比對）：不是修正、先前不是修正、修過但還沒發版，都不要求任何東西', () => {
  const files = ['relay/asn/src-tauri/src/term.rs']
  for (const [title, baseTitles] of [[PR2355, H2355], [PR2038, H2038], [PR1897, H1897]]) {
    const r = evaluate({ title, body: FILLED, headRef: 'feat/x', labels: [], files, baseTitles })
    assert.equal(r.pass, true, `${title}：${r.errors.join('；')}`)
    assert.ok(!r.lines.some(l => l.includes('復發')), title)
  }
  assert.equal(evaluate({ title: PR1897, body: FILLED, headRef: 'feat/x', labels: [], files, baseTitles: [...H1897, 'release: 0.2.55'] }).pass, false)
})

test('復發（機器比對）：直接呼叫 evaluate 沒給目標分支的歷史（本機、測試用），略過這一項、不因此紅，報告寫明略過', () => {
  const base = { title: PR903, body: FILLED, headRef: 'fix/903', labels: [], files: ['relay/asn/src-tauri/src/term.rs'] }
  for (const baseTitles of [null, undefined]) {
    const r = evaluate({ ...base, baseTitles })
    assert.equal(r.pass, true, r.errors.join('；'))
    assert.ok(r.lines.some(l => /略過/.test(l) && /復發的自動比對/.test(l) && /沒有目標分支的提交歷史/.test(l)))
  }
  // 對照：同一張 PR，歷史取得到就會紅
  assert.equal(evaluate({ ...base, baseTitles: H903 }).pass, false)
  // 歷史是空的（取得到，只是沒有提交）：不是略過，也沒有命中
  const empty = evaluate({ ...base, baseTitles: [] })
  assert.equal(empty.pass, true)
  assert.ok(!empty.lines.some(l => /略過/.test(l)))
})

test('復發：貼了「復發」標籤照舊要復發單號與守門測試——「不是復發」那一行只放行機器比對，抵不掉標籤', () => {
  const body = `${FILLED}\n不是復發：這張其實是分階段做的其中一段\n`
  const labelled = evaluate({ title: PR903, body, headRef: 'fix/903', labels: ['復發'], files: ['relay/asn/src-tauri/src/term.rs'], baseTitles: H903 })
  assert.equal(labelled.pass, false)
  assert.deepEqual(labelled.errors, ['有「復發」標籤，PR 說明要寫「復發單號：#單號」'])
  // 沒貼標籤、機器也沒命中：和以前一樣不要求
  assert.equal(evaluate({ title: '新功能', body: FILLED, headRef: 'feat/x', labels: [], files: ['a.js'], baseTitles: H903 }).pass, true)
})

test('復發（機器比對）：豁免的 PR（臨時 CI 載具、release 分支、免檢查表）不比對', () => {
  const files = ['relay/asn/src-tauri/src/term.rs']
  assert.equal(evaluate({ title: `tmp: ${PR903}`, body: '', headRef: 'tmp/903', labels: [], files, baseTitles: H903 }).pass, true)
  assert.equal(evaluate({ title: PR903, body: '', headRef: 'release/0.2.14', labels: [], files, baseTitles: H903 }).pass, true)
  assert.equal(evaluate({ title: PR903, body: '', headRef: 'docs/903', labels: ['免檢查表'], files: ['docs/a.md'], baseTitles: H903 }).pass, true)
  // 貼了免檢查表卻改了程式：不算豁免，照樣比對
  const abuse = evaluate({ title: PR903, body: FILLED, headRef: 'fix/903', labels: ['免檢查表'], files, baseTitles: H903 })
  assert.ok(abuse.errors.some(e => e.includes('機器判定是復發')))
})

test('復發（機器比對）：這張 PR 自己的編號不算單號；結尾括號裡別的編號是作者寫的單號，照算', () => {
  // 真標題：先前那筆修正的單號寫在結尾半形括號裡（歷史裡當成 PR 編號，不記成修過的單）
  const history = ['fix(#1867): 自動接回的視窗退回系統終端時，畫面也要講明是哪幾位', 'fix(#1867): pi 退回原生主控台的三處也寫進 ui.log', 'release: 0.2.37']
  const title = 'fix: 換班接手後新視窗不再因收空的終端服務而退回原生主控台 (#1867)'
  assert.deepEqual(recurrenceHits(title, history), [], '不知道自己的編號時，結尾括號一律當成 PR 編號')
  assert.deepEqual(recurrenceHits(title, history, { own: 1870 }).map(h => h.n), ['1867'])
  assert.deepEqual(recurrenceHits(title, history, { own: 1867 }), [])
  const r = evaluate({ title, number: 1870, body: FILLED, headRef: 'fix/1867', labels: [], files: ['relay/asn/src-tauri/src/term.rs'], baseTitles: history })
  assert.equal(r.pass, false)
  assert.match(r.errors[0], /修的 #1867 在主線上已經修過並且發過版/)
})

// 臨時 repo：每筆提交指定時間（分支上的提交比主線的發版早寫好，才測得出排序）
function tempRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prck-'))
  let tick = 0
  const g = (...a) => {
    const when = `2026-01-01T00:${String(tick++).padStart(2, '0')}:00+08:00`
    const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when } })
    assert.equal(r.status, 0, r.stderr)
    return r.stdout
  }
  const commit = (msg, file, text) => {
    if (file) { fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true }); fs.writeFileSync(path.join(dir, file), text); g('add', '-A') }
    g('commit', '-q', '--allow-empty', '-m', msg)
  }
  g('init', '-q', '-b', 'main')
  return { dir, g, commit, done: () => fs.rmSync(dir, { recursive: true, force: true }) }
}

test('歷史的取法：照進主線的先後排——分支上早就寫好、發版後才合進來的修正，不會排到那次發版前面；合併提交不算', () => {
  const { dir, g, commit, done } = tempRepo()
  try {
    commit('第一筆')
    g('checkout', '-q', '-b', 'fix/9001-x')
    commit('fix(#9001): 分支上先寫好的修正')          // 時間比下面那筆發版早
    g('checkout', '-q', 'main')
    commit('release: 0.0.1')                           // 這次發版不含上面那筆修正
    g('merge', '-q', '--no-ff', 'fix/9001-x', '-m', 'Merge pull request #5 from someone/fix/9001-x')
    const titles = historyLines('main', { cwd: dir })
    assert.deepEqual(titles, ['第一筆', 'release: 0.0.1', 'fix(#9001): 分支上先寫好的修正'])
    assert.deepEqual(recurrenceHits('fix(#9001): 再補一張', titles), [], '那筆修正還沒跟著任何一版發出去')
    commit('release: 0.0.2')
    assert.deepEqual(recurrenceHits('fix(#9001): 再補一張', historyLines('main', { cwd: dir })), [{ n: '9001', prior: 'fix(#9001): 分支上先寫好的修正' }])
    // 合併提交的標題（分支名有 fix、帶 PR 編號）沒有被當成「修過 #5」
    assert.equal(scanRecurrences(historyLines('main', { cwd: dir })).released.has('5'), false)
  } finally { done() }
})

// 在臨時 repo 裡對一個事件檔跑檢查腳本（GITHUB_STEP_SUMMARY 另外指定，免得寫進真的 CI 摘要）
function runCli(dir, pr, summary = '') {
  const evPath = path.join(dir, 'event.json')
  fs.writeFileSync(evPath, JSON.stringify({ pull_request: { number: 1234, base: { ref: 'main' }, labels: [], ...pr } }))
  return spawnSync(process.execPath, [SCRIPT], { cwd: dir, encoding: 'utf8', env: { ...process.env, GITHUB_EVENT_PATH: evPath, GITHUB_STEP_SUMMARY: summary } })
}
const DECLARED = `${FILLED}\n只改一邊：手機看終端沒有這個游標對位的設定\n不是復發：這次是 emoji 字寬，和上次的殘留顏色序列不是同一個毛病\n`

test('命令列：整條路跑一次（臨時 repo＋事件檔）——只改一邊與復發都會紅，補上說明就綠', () => {
  const { dir, g, commit, done } = tempRepo()
  try {
    commit(PRIOR903, 'relay/asn/ui/list.html', '<!-- 一 -->\n')
    commit('release: 0.2.8')
    g('update-ref', 'refs/remotes/origin/main', 'main')   // 腳本比的是 origin/<目標分支>
    g('checkout', '-q', '-b', 'fix/903')
    commit('再修一次', 'relay/asn/ui/list.html', '<!-- 二 -->\n')
    const pr = { title: PR903, head: { ref: 'fix/903' } }
    const bad = runCli(dir, { ...pr, body: FILLED })
    assert.equal(bad.status, 1, bad.stdout + bad.stderr)
    assert.match(bad.stdout, /::error::這張 PR 只動到電腦的頁面與樣式檔（relay\/asn\/ui\/list\.html）/)
    assert.match(bad.stdout, /::error::這張 PR 的標題是修正，修的 #903 在主線上已經修過並且發過版/)
    assert.ok(bad.stdout.includes(PRIOR903))
    const good = runCli(dir, { ...pr, body: DECLARED })
    assert.equal(good.status, 0, good.stdout + good.stderr)
    assert.match(good.stdout, /通過。/)
    assert.match(good.stdout, /不是復發：這次是 emoji 字寬/)
    assert.doesNotMatch(good.stdout, /::error::|檢查沒辦法做/)
  } finally { done() }
})

test('命令列：PR 事件下取不到目標分支的歷史或改動的檔案清單，結束碼 1、講明檢查沒辦法做（不能只印警告照樣綠）', () => {
  const { dir, g, commit, done } = tempRepo()
  try {
    commit(PRIOR903, 'relay/asn/ui/list.html', '<!-- 一 -->\n')
    commit('release: 0.2.8')
    g('checkout', '-q', '-b', 'fix/903')
    commit('再修一次', 'relay/asn/ui/list.html', '<!-- 二 -->\n')
    const pr = { title: PR903, head: { ref: 'fix/903' }, body: DECLARED }   // 說明寫得再完整也一樣：檢查做不了就是紅
    const plain = /檢查沒辦法做，不是你的 PR 有問題。請重跑這個檢查；一直這樣請回報領隊。/
    // 一、沒有 origin/main：歷史與檔案清單都取不到
    const summary = path.join(dir, 'summary.md')
    const none = runCli(dir, pr, summary)
    assert.equal(none.status, 1, none.stdout + none.stderr)
    assert.match(none.stdout, /::error::取不到目標分支的提交歷史（.+）。檢查沒辦法做/)
    assert.match(none.stdout, /::error::取不到這張 PR 改動的檔案清單（.+）。檢查沒辦法做/)
    assert.match(none.stdout, plain)
    assert.doesNotMatch(none.stdout, /通過。|::warning::|略過/)
    assert.match(fs.readFileSync(summary, 'utf8'), plain, '摘要也要寫明，不能是空的')
    // 二、有 origin/main、但這條分支和它沒有共同的起點：歷史取得到，檔案清單取不到，一樣紅
    g('update-ref', 'refs/remotes/origin/main', 'main')
    assert.equal(runCli(dir, pr).status, 0, '對照：資料都取得到時，同一張 PR 是綠的')
    g('checkout', '-q', '--orphan', 'lost')
    commit('另一條沒有共同起點的歷史', 'relay/asn/ui/list.html', '<!-- 三 -->\n')
    const noFiles = runCli(dir, { ...pr, head: { ref: 'lost' } })
    assert.equal(noFiles.status, 1, noFiles.stdout + noFiles.stderr)
    assert.match(noFiles.stdout, /::error::取不到這張 PR 改動的檔案清單（.+）。檢查沒辦法做/)
    assert.doesNotMatch(noFiles.stdout, /取不到目標分支的提交歷史|通過。/)
    // 三、不是 PR 事件：和以前一樣略過，結束碼 0
    const evPath = path.join(dir, 'event.json')
    fs.writeFileSync(evPath, JSON.stringify({ inputs: {} }))
    const notPr = spawnSync(process.execPath, [SCRIPT], { cwd: dir, encoding: 'utf8', env: { ...process.env, GITHUB_EVENT_PATH: evPath, GITHUB_STEP_SUMMARY: '' } })
    assert.equal(notPr.status, 0)
    assert.match(notPr.stdout, /不是 pull_request 事件，略過/)
  } finally { done() }
})
