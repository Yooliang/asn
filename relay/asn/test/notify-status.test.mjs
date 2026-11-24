// tools/release/notify_status.mjs（#1892 規格 2.3）：2.3 表每一列一個案例，含混合優先序、skipped 分辨、auto=false 靠 guard.result 區分。
import test from 'node:test'
import assert from 'node:assert/strict'
import { JOBS, JOB_NAME, GUARD_STEPS, autoEnabled, notifyStatus } from '../../../tools/release/notify_status.mjs'

const ok = Object.fromEntries(JOBS.map(j => [j, 'success']))
const RUN = 'https://github.com/Yooliang/asn/actions/runs/1'
const n = (over = {}) => notifyStatus({ guardResult: 'success', auto: true, results: ok, version: '0.2.37', runUrl: RUN, ...over })
const r = patch => n({ results: { ...ok, ...patch } })
const has = (res, ...parts) => parts.forEach(p => assert.ok(res.text.includes(p), `缺「${p}」：\n${res.text}`))
const lacks = (res, ...parts) => parts.forEach(p => assert.ok(!res.text.includes(p), `不該有「${p}」：\n${res.text}`))

test('autoEnabled：只有值恰為 true 才是 true', () => {
  assert.equal(autoEnabled('true'), true)
  assert.equal(autoEnabled(true), true)
  for (const v of [undefined, null, '', 'false', 'TRUE', 'True', ' true', 'true ', '1', 'yes', 0, 1, false]) assert.equal(autoEnabled(v), false, JSON.stringify(v))
})

test('guard 失敗：發版未開始（auto 不影響，下游全 skipped 也一樣）', () => {
  const a = notifyStatus({ guardResult: 'failure', auto: false, results: {}, version: '0.2.37', runUrl: RUN })
  has(a, '【發版未開始】', 'v0.2.37', '標籤檢查沒過', '沒有建置、沒有上傳', RUN)
  assert.equal(a.level, 'error')
  const b = notifyStatus({ guardResult: 'failure', auto: true, results: Object.fromEntries(JOBS.map(j => [j, 'skipped'])) })
  has(b, '【發版未開始】')
  lacks(b, '發版異常', '略過')
  has(notifyStatus({ guardResult: 'failure', guardStep: '標籤與版本檔' }), '卡在：標籤與版本檔')
})

test('guard 成功、auto=false：發版略過；與 guard 失敗靠 guardResult 區分', () => {
  const skipped = Object.fromEntries(JOBS.map(j => [j, 'skipped']))
  for (const auto of [false, '', 'false', 'TRUE', undefined]) {
    const x = notifyStatus({ guardResult: 'success', auto, results: skipped, version: '0.2.37' })
    has(x, '【發版略過】', '自動發版開關未開', '手動備援')
    assert.equal(x.level, 'info')
    lacks(x, '發版異常', '發版未開始')
  }
  // 同樣是下游全 skipped，guard 失敗與 auto=false 說的話不同
  assert.notEqual(notifyStatus({ guardResult: 'failure', results: skipped }).text, notifyStatus({ guardResult: 'success', auto: false, results: skipped }).text)
})

test('全部 success：CI 完成、尚未上線、14 天內要簽', () => {
  const x = n()
  has(x, '【CI 完成】', 'v0.2.37', '尚未上線', '14 天內要簽')
  assert.equal(x.level, 'success')
})

test('preflight 失敗（android-build／upload 因此 skipped）：Play 未上傳（版號預檢），電腦版成功', () => {
  const x = r({ 'preflight-play': 'failure', 'android-build': 'skipped', 'android-upload': 'skipped' })
  has(x, '【發版失敗】', 'Play 未上傳（版號預檢）', '電腦版成功')
  lacks(x, '發版異常', '略過')
  assert.equal(x.level, 'error')
})

test('preflight 失敗且 desktop 也失敗：兩邊都失敗，各自列出', () => {
  const x = r({ 'preflight-play': 'failure', desktop: 'failure', attest: 'skipped', 'android-build': 'skipped', 'android-upload': 'skipped' })
  has(x, '兩邊都失敗', '電腦版：卡在電腦版建置與測試', 'Play：卡在Play 版號預檢')
})

test('desktop 失敗（attest skipped 是連帶，不單獨列）：電腦版失敗，Play 已上傳／未上傳', () => {
  const up = r({ desktop: 'failure', attest: 'skipped' })
  has(up, '電腦版失敗', '電腦版建置與測試', 'Play 已上傳')
  lacks(up, '安裝檔來源證明', '發版異常')
  const none = r({ desktop: 'failure', attest: 'skipped', 'android-build': 'failure', 'android-upload': 'skipped' })
  has(none, '兩邊都失敗')
  const noUp = r({ desktop: 'failure', attest: 'skipped', 'android-upload': 'skipped' })
  has(noUp, 'Play 未上傳')
})

test('attest 失敗：同樣算電腦版失敗', () => {
  has(r({ attest: 'failure' }), '電腦版失敗', '安裝檔來源證明', 'Play 已上傳')
})

test('desktop 和 android 都失敗：兩邊都失敗，分行列出', () => {
  const x = r({ desktop: 'failure', attest: 'skipped', 'android-build': 'failure', 'android-upload': 'skipped' })
  has(x, '兩邊都失敗', '電腦版：卡在電腦版建置與測試', 'Play：卡在Android 建置')
  assert.ok(x.text.split('\n').length >= 3)
})

test('只有 android 失敗：部分完成，電腦版就緒、Play 未上傳、見 2.6', () => {
  const x = r({ 'android-build': 'failure', 'android-upload': 'skipped' })
  has(x, '【部分完成】', '電腦版就緒', 'Play 未上傳', '2.6')
  assert.equal(x.level, 'warning')
  lacks(x, 'Play 上傳（')
})

test('android-upload 失敗：不斷言「未上傳」，要人先查 Play Console', () => {
  const x = r({ 'android-upload': 'failure' })
  has(x, '【部分完成】', '可能已部分上傳', 'Play Console')
  lacks(x, 'Play 未上傳')
})

test('只有 site-draft 失敗、desktop 成功：電腦版就緒、草稿沒產出、Play 已上傳不可重傳、可用 --items-file', () => {
  const x = r({ 'site-draft': 'failure' })
  has(x, '電腦版就緒', '官網紀錄草稿沒產出', 'Play 已上傳', '同版不可重傳', '--items-file')
  assert.equal(x.level, 'warning')
  const y = r({ 'site-draft': 'failure', 'android-build': 'skipped', 'android-upload': 'skipped', 'preflight-play': 'failure' })
  has(y, 'Play 未上傳（版號預檢）', '官網紀錄草稿也沒產出')
})

test('failure 與 cancelled 混合：failure 優先並列出全部 failure（依 needs 順序），cancelled 附記', () => {
  const x = r({ attest: 'failure', 'android-build': 'failure', desktop: 'failure', 'android-upload': 'cancelled' })
  has(x, '兩邊都失敗', '電腦版建置與測試、安裝檔來源證明', '另有被取消：Play 上傳')
  const y = r({ 'site-draft': 'cancelled', desktop: 'failure', attest: 'skipped' })
  has(y, '電腦版失敗', '另有被取消：官網紀錄草稿')
  lacks(y, '發版中止')
})

test('全部 cancelled、無 failure：發版中止，列已完成', () => {
  const all = Object.fromEntries(JOBS.map(j => [j, 'cancelled']))
  const x = n({ results: all })
  has(x, '【發版中止】', '已完成：無')
  const some = r({ attest: 'cancelled', 'android-build': 'cancelled', 'android-upload': 'skipped', 'site-draft': 'cancelled' })
  has(some, '【發版中止】', 'Play 版號預檢', '電腦版建置與測試')
  lacks(some, '尚未上線')
  assert.equal(x.level, 'warning')
  has(notifyStatus({ guardResult: 'cancelled', auto: true, results: {} }), '【發版中止】')
})

test('skipped 成因不明：上游都成功卻 skipped → 發版異常；上游失敗造成的不算', () => {
  const x = r({ 'site-draft': 'skipped' })
  has(x, '【發版異常】', '官網紀錄草稿')
  assert.equal(x.level, 'error')
  // 缺鍵視為 skipped
  const { 'android-upload': _drop, ...partial } = ok
  has(n({ results: partial }), '【發版異常】', 'Play 上傳')
  // 連鎖：android-build 失敗 → android-upload skipped 是連帶
  lacks(r({ 'android-build': 'failure', 'android-upload': 'skipped' }), '發版異常', '不明')
  // 有失敗時，不明的略過另外附記
  has(r({ desktop: 'failure', attest: 'skipped', 'site-draft': 'skipped' }), '電腦版失敗', '另有不明的略過：官網紀錄草稿')
})

test('文字只放中文名、版本、run 連結：錯誤原文與非 https 連結一律不收', () => {
  const x = notifyStatus({
    guardResult: 'success', auto: true, results: { ...ok, desktop: 'failure', attest: 'skipped' },
    version: '0.2.37\nTOKEN=abc', runUrl: 'javascript:alert(1)', guardStep: 'x\nsecret', jobUrls: { desktop: 'https://github.com/Yooliang/asn/actions/runs/1/job/2', attest: 'http://x' },
    log: 'secret log text',
  })
  lacks(x, 'TOKEN', 'javascript', 'secret', 'log text')
  has(x, 'https://github.com/Yooliang/asn/actions/runs/1/job/2')
  assert.ok(!x.text.includes('v0.2.37'))
  // 每個 job 都有中文名
  for (const j of [...JOBS, 'guard']) assert.ok(JOB_NAME[j])
})

test('窮舉：每一種結果組合（4^6）都有 level 與非空文字，且 success 只在全部成功時出現', () => {
  const vals = ['success', 'failure', 'skipped', 'cancelled']
  let count = 0
  const walk = (i, acc) => {
    if (i === JOBS.length) {
      const x = n({ results: acc })
      count++
      assert.ok(['success', 'info', 'warning', 'error'].includes(x.level))
      assert.ok(x.text.length > 0)
      const allOk = JOBS.every(j => acc[j] === 'success')
      assert.equal(x.level === 'success', allOk, JSON.stringify(acc))
      if (!allOk) lacks(x, '【CI 完成】')
      return
    }
    for (const v of vals) walk(i + 1, { ...acc, [JOBS[i]]: v })
  }
  walk(0, {})
  assert.equal(count, 4 ** 6)
})

test('#1926 一審：連結只收本 repo 的 Actions 執行頁；步驟名只收固定清單', () => {
  const base = { guardResult: 'success', auto: true, results: { ...ok, desktop: 'failure', attest: 'skipped' } }
  const bad = [
    'https://github.com/other/repo/actions/runs/1/job/2', // 別的 repo
    'https://evil.example/Yooliang/asn/actions/runs/1', // 別的網域
    'https://github.com/Yooliang/asn/actions/runs/1?x=@someone', // 查詢字串
    'https://github.com/Yooliang/asn/actions/runs/1#frag', // 片段
    'https://github.com/Yooliang/asn/actions/runs/abc', // 不是數字
    'https://github.com/Yooliang/asn/actions/runs/1/job/2/extra',
  ]
  for (const u of bad) lacks(notifyStatus({ ...base, runUrl: u, jobUrls: { desktop: u } }), 'github.com', 'evil', '@someone')
  has(notifyStatus({ ...base, runUrl: 'https://github.com/Yooliang/asn/actions/runs/123' }), 'https://github.com/Yooliang/asn/actions/runs/123')
  for (const s of ['@someone 看這裡', '[點我](https://x.example)', 'C:/Users/x', '版本檔不一致\n另一行', 'Cargo.lock 版本']) lacks(notifyStatus({ guardResult: 'failure', guardStep: s }), '卡在')
  for (const s of GUARD_STEPS) has(notifyStatus({ guardResult: 'failure', guardStep: s }), '卡在：' + s)
})

// ---- 只接電腦版與官網（#1892 拆分後）：jobs 只傳實際存在的 job，文字不提 Play ----
const DESK = ['desktop', 'attest', 'site-draft']
const dok = Object.fromEntries(DESK.map(j => [j, 'success']))
const d = (patch = {}, extra = {}) => notifyStatus({ guardResult: 'success', auto: true, results: { ...dok, ...patch }, jobs: DESK, version: '0.2.37', runUrl: RUN, ...extra })

test('只有電腦版 job：全成功 → CI 完成，不提 Play；沒傳 jobs 時仍是原本含 Play 的文字', () => {
  const x = d()
  has(x, '【CI 完成】', '未簽章安裝檔已就緒，尚未上線', '14 天內要簽')
  lacks(x, 'Play', 'Android', '發版異常', '不明的略過')
  assert.equal(x.level, 'success')
  has(n(), 'Play 內部測試')
})

test('只有電腦版 job：desktop 失敗、attest 連帶略過 → 電腦版失敗，不提 Play；site-draft 失敗；取消', () => {
  const a = d({ desktop: 'failure', attest: 'skipped' })
  has(a, '【發版失敗】', '電腦版失敗', '電腦版建置與測試')
  lacks(a, 'Play', '發版異常', '不明的略過')
  const b = d({ 'site-draft': 'failure' })
  has(b, '【發版部分完成】', '電腦版就緒', '官網紀錄草稿沒產出', '--items-file')
  lacks(b, 'Play')
  const c = d({ attest: 'failure' })
  has(c, '電腦版失敗', '安裝檔來源證明'); lacks(c, 'Play')
  const e = d({ desktop: 'failure', attest: 'skipped', 'site-draft': 'failure' })
  has(e, '電腦版失敗', '另外：官網紀錄草稿也沒產出'); lacks(e, 'Play')
  const f = d({ desktop: 'cancelled', attest: 'skipped' })
  has(f, '【發版中止】'); lacks(f, 'Play')
})

test('只有電腦版 job：沒傳的 Play job 不算不明的略過；但電腦版 job 無故略過仍報異常', () => {
  lacks(d(), '異常')
  has(d({ 'site-draft': 'skipped' }), '【發版異常】', '官網紀錄草稿')
})

// ---- 手機版自己的 workflow（#1944）：只有 Play 三個 job，沒有電腦版／attest／官網草稿 ----
const PLAY = ['preflight-play', 'android-build', 'android-upload']
const p = (patch = {}, over = {}) => notifyStatus({ guardResult: 'success', auto: true, jobs: PLAY, results: { ...Object.fromEntries(PLAY.map(j => [j, 'success'])), ...patch }, version: '0.2.38', runUrl: RUN, ...over })

test('只有 Play job：全成功 → 講 Play internal 已就緒，不提未簽章安裝檔／14 天內要簽', () => {
  const a = p()
  assert.equal(a.level, 'success')
  has(a, '【CI 完成】v0.2.38', 'Play 內部測試已就緒')
  lacks(a, '安裝檔', '要簽', '電腦版', '官網')
})

test('只有 Play job：預檢、建置、上傳各自失敗只講 Play；沒傳的電腦版 job 不算不明的略過', () => {
  const a = p({ 'preflight-play': 'failure', 'android-build': 'skipped', 'android-upload': 'skipped' })
  has(a, '【發版失敗】', 'Play 未上傳（版號預檢沒過）'); lacks(a, '電腦版', '安裝檔', '發版異常', '不明的略過'); assert.equal(a.level, 'error')
  const b = p({ 'android-build': 'failure', 'android-upload': 'skipped' })
  has(b, 'Play 未上傳（Android 建置失敗）'); lacks(b, '電腦版', '安裝檔', '不明的略過')
  const c = p({ 'android-upload': 'failure' })
  has(c, 'Play 上傳失敗，可能已部分上傳', '2.6'); lacks(c, '電腦版', '安裝檔')
  lacks(p({ 'android-build': 'failure', 'android-upload': 'skipped' }), '尚未上線')
})

test('只有 Play job：被取消仍報中止；Play job 無故略過報異常；預設（全 job）行為不變', () => {
  has(p({ 'android-build': 'cancelled', 'android-upload': 'skipped' }), '【發版中止】')
  has(p({ 'android-upload': 'skipped' }), '【發版異常】', 'Play 上傳')
  has(r({}), '未簽章安裝檔已就緒；Play 內部測試已就緒')
})

// ---- Linux 版自己的 workflow：只有 linux、attest-linux 兩個 job ----
const LIN = ['linux', 'attest-linux']
const l = (patch = {}, over = {}) => notifyStatus({ guardResult: 'success', auto: true, jobs: LIN, results: { ...Object.fromEntries(LIN.map(j => [j, 'success'])), ...patch }, version: '0.2.38', runUrl: RUN, ...over })

test('只有 Linux job：全成功 → Linux 未簽章安裝檔已就緒，不提電腦版／Play／官網', () => {
  const a = l()
  assert.equal(a.level, 'success')
  has(a, '【CI 完成】v0.2.38', 'Linux 未簽章安裝檔已就緒', '14 天內要簽')
  lacks(a, 'Play', '電腦版', '官網', '發版異常')
})

test('只有 Linux job：建置失敗（來源證明連帶略過）、來源證明失敗、取消、無故略過', () => {
  const a = l({ linux: 'failure', 'attest-linux': 'skipped' })
  has(a, '【發版失敗】', 'Linux 版失敗（卡在Linux 版建置與測試）'); lacks(a, '電腦版', 'Play', '不明的略過'); assert.equal(a.level, 'error')
  has(l({ 'attest-linux': 'failure' }), 'Linux 安裝檔來源證明')
  has(l({ linux: 'cancelled', 'attest-linux': 'skipped' }), '【發版中止】')
  has(l({ 'attest-linux': 'skipped' }), '【發版異常】', 'Linux 安裝檔來源證明')
})

test('Linux：guard 失敗帶步驟名、auto=false 略過；預設（全 job）與電腦版文字不變；statusFromNeeds 認得 linux 的 needs', async () => {
  has(notifyStatus({ guardResult: 'failure', guardStep: '標籤與版本檔' }), '卡在：標籤與版本檔')
  has(l({}, { auto: 'false' }), '【發版略過】')
  has(r({}), '未簽章安裝檔已就緒；Play 內部測試已就緒')
  const { statusFromNeeds } = await import('../../../tools/release/notify_run.mjs')
  const needs = { guard: { result: 'success', outputs: { auto: 'true', version: '0.2.38' } }, linux: { result: 'success' }, 'attest-linux': { result: 'success' } }
  has(statusFromNeeds(needs, { runUrl: RUN }), 'Linux 未簽章安裝檔已就緒')
  has(statusFromNeeds({ ...needs, linux: { result: 'failure' }, 'attest-linux': { result: 'skipped' } }, { runUrl: RUN }), 'Linux 版失敗')
})

// ---- #2246：Play 兩條測試軌道各自的結果 ----
test('Play 兩條都成功 → 通知寫「內部測試已就緒、封閉測試已就緒」', () => {
  const a = p({}, { playAlpha: { status: 'ok' } })
  assert.equal(a.level, 'success')
  has(a, '【CI 完成】v0.2.38', 'Play 內部測試已就緒、封閉測試已就緒')
  lacks(a, 'play-alpha')
})

test('封閉測試沒發成（降級）→ 部分完成、warning；寫 play-alpha、白話原因與請擁有者去 Play Console 哪裡；內部測試仍說已就緒', () => {
  const a = p({}, { playAlpha: { status: 'failed', kind: 'permission' } })
  assert.equal(a.level, 'warning')
  has(a, '【CI 部分完成】', 'Play 內部測試已就緒', 'play-alpha', '封閉測試沒發成', '服務帳戶沒有封閉測試的發布權限', 'Play Console 的「使用者和權限」')
  lacks(a, '【CI 完成】', 'HTTP', '403')
  has(p({}, { playAlpha: { status: 'failed', kind: 'notfound' } }), '找不到封閉測試軌道', '「測試」→「封閉測試」')
  has(p({}, { playAlpha: { status: 'failed', kind: 'other' } }), '審核中', 'Play Console')
  has(p({}, { playAlpha: { status: 'failed', kind: '亂寫' } }), '封閉測試沒發成', '審核中')   // 不認得的分類走通用說明，不原樣印出
  lacks(p({}, { playAlpha: { status: 'failed', kind: '亂寫' } }), '亂寫')
})

test('內部測試（上傳 job）失敗仍是整體失敗，alpha 結果不蓋掉失敗訊息', () => {
  const a = p({ 'android-upload': 'failure' }, { playAlpha: { status: 'ok' } })
  assert.equal(a.level, 'error')
  has(a, '【發版失敗】', 'Play 上傳失敗'); lacks(a, '已就緒')
})

test('statusFromNeeds：android-upload 的 outputs.alpha_status／alpha_kind 對應到通知文字', async () => {
  const { statusFromNeeds } = await import('../../../tools/release/notify_run.mjs')
  const base = over => ({ guard: { result: 'success', outputs: { auto: 'true', version: '0.2.38' } }, ...Object.fromEntries(PLAY.map(j => [j, { result: 'success' }])), ...over })
  has(statusFromNeeds(base({ 'android-upload': { result: 'success', outputs: { alpha_status: 'ok', alpha_kind: '' } } }), { runUrl: RUN }), '內部測試已就緒、封閉測試已就緒')
  const f = statusFromNeeds(base({ 'android-upload': { result: 'success', outputs: { alpha_status: 'failed', alpha_kind: 'permission' } } }), { runUrl: RUN })
  assert.equal(f.level, 'warning'); has(f, 'play-alpha', '發布權限')
  has(statusFromNeeds(base({ 'android-upload': { result: 'success', outputs: {} } }), { runUrl: RUN }), 'Play 內部測試已就緒'); lacks(statusFromNeeds(base({ 'android-upload': { result: 'success', outputs: {} } }), { runUrl: RUN }), '封閉測試')
})
