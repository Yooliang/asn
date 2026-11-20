// tools/release/notify_status.mjs（#1892 規格 2.3）：2.3 表每一列一個案例，含混合優先序、skipped 分辨、auto=false 靠 guard.result 區分。
import test from 'node:test'
import assert from 'node:assert/strict'
import { JOBS, JOB_NAME, autoEnabled, notifyStatus } from '../../../tools/release/notify_status.mjs'

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
  has(notifyStatus({ guardResult: 'failure', guardStep: 'Cargo.lock 版本' }), '卡在：Cargo.lock 版本')
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
    version: '0.2.37\nTOKEN=abc', runUrl: 'javascript:alert(1)', guardStep: 'x\nsecret', jobUrls: { desktop: 'https://github.com/o/r/actions/runs/1/job/2', attest: 'http://x' },
    log: 'secret log text',
  })
  lacks(x, 'TOKEN', 'javascript', 'secret', 'log text')
  has(x, 'https://github.com/o/r/actions/runs/1/job/2')
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
