// 復發報告（紀律 九.1）：例行報告的「本期復發幾件」由 .github/scripts/recur-report.mjs 算，定義和 PR 範本檢查同一套
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { DEFAULT_REF, LOG_FORMAT, fixesIn, formatReport, parseArgs, parseLog, recurrencesIn } from '../../../.github/scripts/recur-report.mjs'
import { recurrenceHits, scanRecurrences } from '../../../.github/scripts/pr-checklist.mjs'

const root = new URL('../../../', import.meta.url)
const SCRIPT = fileURLToPath(new URL('.github/scripts/recur-report.mjs', root))

// 下面每一筆都是這個 repo 主線上真的提交（提交日期＋標題，2026-11-27 從 git log 取出，照進主線的先後；中間無關的提交略去），直接寫死當固定資料。
const REAL = [
  // #903：11-07 修、補修，發了版，11-10 又修 → 復發
  { date: '2026-11-07', title: 'release: 0.2.7' },
  { date: '2026-11-07', title: '終端畫面：拿掉「回到訊息」按鈕、修游標差一到兩列（#901b／#903）' },
  { date: '2026-11-07', title: '終端畫面游標落在輸入列下一列：整份結尾帶殘留顏色序列時沒去掉假列（#903 補修）' },
  { date: '2026-11-07', title: 'release: 0.2.8' },
  { date: '2026-11-10', title: 'release: 0.2.13' },
  { date: '2026-11-10', title: '修 #903：終端畫面游標對位——emoji 字寬對齊 WezTerm、手機看終端跟著窗格欄列數' },
  { date: '2026-11-10', title: '終端字寬：emoji 只看 Emoji_Presentation，🖥 🌡 這類文字樣式符號照 1 格（#903 二審）' },
  { date: '2026-11-10', title: 'release: 0.2.14' },
  // #1897：一審修正之後還沒發版，就接著二審修正 → 不算
  { date: '2026-11-22', title: 'release: 0.2.54' },
  { date: '2026-11-22', title: '#1897 ④ 終端服務心跳停了就判卡死，結束後接回' },
  { date: '2026-11-22', title: '#1897 ④ 一審修正：核對判停那一輪的 mux 與 seq、事故文字依有沒有接回分兩句' },
  { date: '2026-11-22', title: '#1897 ④ 二審修正：結束前再驗、不殺 ASN 自己與祖先、cli 跑不起來不當成連不上、心跳恢復重設通知' },
  { date: '2026-11-22', title: '#1897 ④ 二審修正：程序表讀不到、空、找不到 ASN 自己或 mux 時取消處置' },
  { date: '2026-11-22', title: 'release: 0.2.55' },
  // #2161：3c 那張是修正、發了版，之後 F1 那張又是修正 → 照定義算復發（標題結尾是合併時加的 PR 編號，不是單號）
  { date: '2026-11-24', title: '#2161 3b：term_view_pending 輪詢保底間隔 10 秒改 30 秒 (#2226)' },
  { date: '2026-11-24', title: 'fix(asn): #2161 3c term_req_take 輪詢有請求才快、閒置慢 (#2228)' },
  { date: '2026-11-24', title: 'release: 0.2.90' },
  { date: '2026-11-24', title: '#2161 第 3d-1 段：手機決定權限框／終端確認後，後台敲門鈴（migration＋Edge） (#2265)' },
  { date: '2026-11-24', title: 'release: 0.2.93' },
  { date: '2026-11-24', title: 'fix(#2161 F1): node_update_status 輪詢改為依進行中狀態變速 (#2271)' },
  { date: '2026-11-24', title: '#2161 F2：寄出狀態（sent_status）降頻——最小間隔、年齡分級、可見才打 (#2272)' },
  // #2355：同一張單連續好幾張 PR，中間發過版，但都不是修正 → 不算
  { date: '2026-11-26', title: 'release: 0.2.102' },
  { date: '2026-11-26', title: '#2355 P1：型號清單的前端純函式（remote-models.mjs），不改畫面 (#2396)' },
  { date: '2026-11-27', title: '#2355 P2：新增本機讀型號清單的 Tauri 命令 agent_models（兩審） (#2397)' },
  { date: '2026-11-27', title: '#2355 P3：電腦版本機接上型號清單（開新夥伴第 2 頁、切換模型），依賴 #2397 (#2399)' },
  { date: '2026-11-27', title: 'release: 0.2.103' },
  { date: '2026-11-27', title: '#2355 P4：替別台開窗帶型號、開好顯示實際型號、手機接上型號清單（兩審，等 #2393 發版） (#2401)' },
]
const HIT903 = {
  n: '903', date: '2026-11-10', title: '修 #903：終端畫面游標對位——emoji 字寬對齊 WezTerm、手機看終端跟著窗格欄列數',
  priorDate: '2026-11-07', priorTitle: '終端畫面游標落在輸入列下一列：整份結尾帶殘留顏色序列時沒去掉假列（#903 補修）',
}
const HIT2161 = {
  n: '2161', date: '2026-11-24', title: 'fix(#2161 F1): node_update_status 輪詢改為依進行中狀態變速 (#2271)',
  priorDate: '2026-11-24', priorTitle: 'fix(asn): #2161 3c term_req_take 輪詢有請求才快、閒置慢 (#2228)',
}

test('復發報告（真提交）：修過、發過版又再修的算得出來，帶這次與先前那筆的標題和日期', () => {
  assert.deepEqual(recurrencesIn(REAL, { since: '2026-11-06' }), [HIT903, HIT2161])
  assert.deepEqual(recurrencesIn(REAL), [HIT903, HIT2161], '沒給期間就不設限')
})

test('復發報告（真提交）：同一張單連續好幾張但不是修正（#2355）、修完還沒發版又補一張（#1897），都不算', () => {
  const items = recurrencesIn(REAL, { since: '2026-11-06' })
  assert.ok(!items.some(x => x.n === '2355'))
  assert.ok(!items.some(x => x.n === '1897'))
  // 對照：同一筆二審修正如果是在 0.2.55 發版之後才進來，就算
  const i = REAL.findIndex(c => c.title === 'release: 0.2.55')
  const later = [...REAL.slice(0, i + 1), { date: '2026-11-23', title: '#1897 ④ 二審修正：程序表讀不到、空、找不到 ASN 自己或 mux 時取消處置' }, ...REAL.slice(i + 1)]
  assert.deepEqual(recurrencesIn(later, { since: '2026-11-23', until: '2026-11-23' }).map(x => x.n), ['1897'])
})

test('復發報告：只算期間內的（頭尾兩天都算）；先前那筆修正可以在期間之前', () => {
  assert.deepEqual(recurrencesIn(REAL, { since: '2026-11-11' }), [HIT2161])
  assert.deepEqual(recurrencesIn(REAL, { since: '2026-11-06', until: '2026-11-23' }), [HIT903])
  assert.deepEqual(recurrencesIn(REAL, { since: '2026-11-10', until: '2026-11-10' }), [HIT903])
  assert.deepEqual(recurrencesIn(REAL, { since: '2026-11-24', until: '2026-11-24' }), [HIT2161])
  assert.deepEqual(recurrencesIn(REAL, { since: '2026-11-08', until: '2026-11-09' }), [])
  assert.deepEqual(recurrencesIn(REAL, { since: '2026-11-25' }), [])
  assert.deepEqual(recurrencesIn([], { since: '2026-11-06' }), [])
})

test('復發報告：和 PR 範本檢查同一套判斷——報告列出來的每一件，拿當時的歷史給 PR 檢查看也會命中', () => {
  const { hits } = scanRecurrences(REAL, c => c.title)
  assert.equal(hits.length, 2)
  for (const h of hits) {
    const before = REAL.slice(0, REAL.indexOf(h.current)).map(c => c.title)
    assert.deepEqual(recurrenceHits(h.current.title, before), [{ n: h.n, prior: h.prior.title }])
  }
  // 反過來：報告沒列的修正，PR 檢查也不會命中
  const i = REAL.findIndex(c => c.title.startsWith('#1897 ④ 二審修正：結束前再驗'))
  assert.deepEqual(recurrenceHits(REAL[i].title, REAL.slice(0, i).map(c => c.title)), [])
})

test('復發報告：期間內帶單號的修正筆數（給報告當分母）', () => {
  // 11-07 兩筆（#901b／#903、#903 補修）、11-10 一筆、11-22 三筆（一審修正、兩筆二審修正）、11-24 兩筆
  assert.equal(fixesIn(REAL, { since: '2026-11-06' }), 8)
  assert.equal(fixesIn(REAL, { since: '2026-11-22', until: '2026-11-22' }), 3)
  assert.equal(fixesIn(REAL, { since: '2026-11-25' }), 0)
})

test('復發報告：輸出白話文字——期間、復發幾件、每件一行（單號、這次與先前的日期和標題）', () => {
  const text = formatReport({ ref: 'origin/main', latest: '2026-11-27', since: '2026-11-06', until: '', fixes: 8, items: [HIT903, HIT2161] })
  const lines = text.split('\n')
  assert.equal(lines[0], '復發報告（主線 origin/main，最新一筆提交 2026-11-27）')
  assert.equal(lines[1], '期間：2026-11-06 ～ 2026-11-27（沒給結束日，算到主線最新一筆）')
  assert.match(lines[2], /^算法：/)
  assert.equal(lines[3], '復發：2 件，共 2 張單（期間內帶單號的修正共 8 筆）')
  assert.equal(lines[4], `- #903　這次：2026-11-10「${HIT903.title}」　先前：2026-11-07「${HIT903.priorTitle}」`)
  assert.equal(lines[5], `- #2161　這次：2026-11-24「${HIT2161.title}」　先前：2026-11-24「${HIT2161.priorTitle}」`)
  assert.equal(lines.length, 6)
  // 同一張單復發兩次：件數 2、單數 1
  assert.match(formatReport({ since: '2026-11-06', until: '2026-11-27', fixes: 5, items: [HIT903, { ...HIT903, date: '2026-11-12' }] }), /復發：2 件，共 1 張單/)
  // 有給結束日就照寫；沒有復發寫 0 件，不是空白
  const none = formatReport({ ref: 'origin/main', latest: '2026-11-27', since: '2026-11-25', until: '2026-11-26', fixes: 3, items: [] }).split('\n')
  assert.equal(none[1], '期間：2026-11-25 ～ 2026-11-26')
  assert.equal(none[3], '復發：0 件（期間內帶單號的修正共 3 筆）')
  assert.equal(none.length, 4)
})

test('復發報告：讀參數——起始日必填、日期要是 西元年-月-日、結束日不能比起始日早、可以指定主線', () => {
  assert.deepEqual(parseArgs(['--since', '2026-11-20']), { since: '2026-11-20', until: '', ref: DEFAULT_REF })
  assert.deepEqual(parseArgs(['--since', '2026-11-20', '--until', '2026-11-27', '--ref', 'main']), { since: '2026-11-20', until: '2026-11-27', ref: 'main' })
  assert.equal(DEFAULT_REF, 'origin/main')
  assert.match(parseArgs([]).error, /要給 --since/)
  assert.match(parseArgs(['--until', '2026-11-27']).error, /要給 --since/)
  assert.match(parseArgs(['--since']).error, /後面要接內容/)
  assert.match(parseArgs(['--since', '11/20']).error, /西元年-月-日/)
  assert.match(parseArgs(['--since', '2026-11-20', '--until', '明天']).error, /西元年-月-日/)
  assert.match(parseArgs(['--since', '2026-11-20', '--until', '2026-11-19']).error, /還早/)
  assert.match(parseArgs(['--since', '2026-11-20', '--all']).error, /看不懂的參數：--all/)
})

test('復發報告：歷史的每一行拆成日期與標題；標題裡有分隔字元不會斷', () => {
  assert.equal(LOG_FORMAT, '%cs\t%s')
  assert.deepEqual(parseLog(['2026-11-10\t修 #903：終端畫面游標對位', '2026-11-10\t標題裡\t有分隔字元', '', '沒有日期的一行']), [
    { date: '2026-11-10', title: '修 #903：終端畫面游標對位' },
    { date: '2026-11-10', title: '標題裡\t有分隔字元' },
    { date: '', title: '沒有日期的一行' },
  ])
})

// 命令列整條路：臨時 repo 裡照真的順序排幾筆提交（標題取自上面的真提交，日期是測試自己給的），確認 git 取歷史、判斷、輸出接得起來
function tempRepo(commits) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recur-'))
  const g = (when, ...a) => {
    const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when } })
    assert.equal(r.status, 0, r.stderr)
  }
  g('2026-11-01T12:00:00+08:00', 'init', '-q', '-b', 'main')
  for (const c of commits) g(`${c.date}T12:00:00+08:00`, 'commit', '-q', '--allow-empty', '-m', c.title)
  return dir
}
const run = (dir, ...args) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd: dir, encoding: 'utf8' })

test('命令列：在 repo 裡跑得出報告（只讀 git）；期間外的不列', () => {
  const dir = tempRepo(REAL)
  try {
    const all = run(dir, '--since', '2026-11-06', '--ref', 'main')
    assert.equal(all.status, 0, all.stderr)
    assert.equal(all.stdout.trimEnd(), formatReport({ ref: 'main', latest: '2026-11-27', since: '2026-11-06', until: '', fixes: 8, items: [HIT903, HIT2161] }))
    const week = run(dir, '--since', '2026-11-20', '--until', '2026-11-27', '--ref', 'main')
    assert.equal(week.status, 0, week.stderr)
    assert.match(week.stdout, /期間：2026-11-20 ～ 2026-11-27\n/)
    assert.match(week.stdout, /復發：1 件，共 1 張單（期間內帶單號的修正共 5 筆）/)
    assert.ok(week.stdout.includes(`- #2161　這次：2026-11-24「${HIT2161.title}」`))
    assert.ok(!week.stdout.includes('#903　這次'))
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('命令列：參數不對、讀不到歷史，都講白話並以結束碼 1 結束（不印半份報告）', () => {
  const dir = tempRepo(REAL.slice(0, 3))
  try {
    const noSince = run(dir)
    assert.equal(noSince.status, 1)
    assert.match(noSince.stderr, /要給 --since 起始日/)
    assert.match(noSince.stderr, /用法：node \.github\/scripts\/recur-report\.mjs --since/)
    assert.equal(noSince.stdout, '')
    const badRef = run(dir, '--since', '2026-11-06', '--ref', 'origin/main')   // 這個臨時 repo 沒有 origin/main
    assert.equal(badRef.status, 1)
    assert.match(badRef.stderr, /讀不到 origin\/main 的提交歷史/)
    assert.match(badRef.stderr, /用 --ref 指定/)
    assert.equal(badRef.stdout, '')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('守門：復發報告只讀 git、不連網路，判斷不另寫一份（從 pr-checklist.mjs 匯入）', () => {
  const src = fs.readFileSync(SCRIPT, 'utf8')
  assert.match(src, /import \{[^}]*\bscanRecurrences\b[^}]*\} from '\.\/pr-checklist\.mjs'/)
  assert.match(src, /import \{[^}]*\bisFixTitle\b[^}]*\bticketNumbers\b[^}]*\} from '\.\/pr-checklist\.mjs'/)
  assert.match(src, /import \{[^}]*\bhistoryLines\b[^}]*\} from '\.\/pr-checklist\.mjs'/)
  // 不自己另外定義修正字樣、取單號、走歷史這幾個函式（只能有 pr-checklist.mjs 那一份）
  assert.doesNotMatch(src, /(?:function|const|let|var)\s+(?:isFixTitle|ticketNumbers|scanRecurrences|isReleaseTitle|historyLines)\b/)
  assert.doesNotMatch(src, /\bfetch\(|node:https?|node:net|child_process|\bgh\b|api\.github\.com/)
})
