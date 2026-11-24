// #1863 核對指紋時請電腦自動跳出 QR Code：手機與電腦共用的純函式（ui/lib/fp-show.mjs）
import test from 'node:test'
import assert from 'node:assert/strict'
import { FP_SHOW_MIN_VERSION, FP_SHOW_RATE_LIMIT_MS, FP_SHOW_TEXT, FP_SHOW_WAIT_MS, FP_SHOW_WINDOW_MS, createFpShowFlow, fpShowPhaseOf, fpShowRateLimitedId, fpShowPrecheck, fpShowRequestError, groupFp16, newFpShowState } from '../ui/lib/fp-show.mjs'

const ID = '11111111-1111-4111-8111-111111111111'
const ID2 = '22222222-2222-4222-8222-222222222222'
const online = [{ window_name: 'asn', version: FP_SHOW_MIN_VERSION, status: 'online', psm: '' }]

// 假後台：status 依序回 statuses（不夠就一直回最後一個）；request 可以丟錯
function fakeApi({ statuses = ['pending'], requestErr = null, ids = [ID] } = {}) {
  const calls = []
  let si = 0, ri = 0
  return {
    calls,
    api: {
      request: async node => { calls.push(['request', node]); if (requestErr) { const e = requestErr; if (typeof requestErr === 'function') return requestErr(calls); throw new Error(e) } return { id: ids[Math.min(ri++, ids.length - 1)], expires_at: 'x' } },
      status: async id => { calls.push(['status', id]); return { status: statuses[Math.min(si++, statuses.length - 1)] } },
      end: async id => { calls.push(['end', id]); return { ok: true } },
    },
  }
}
const clock = () => { let t = 1_000_000; return { now: () => t, add: ms => { t += ms } } }
const ends = calls => calls.filter(c => c[0] === 'end').map(c => c[1])

test('數字：20 秒、5 分鐘、10 秒（設計稿的 30 秒一律改 20 秒）', () => {
  assert.equal(FP_SHOW_WAIT_MS, 20_000)
  assert.equal(FP_SHOW_WINDOW_MS, 300_000)
  assert.equal(FP_SHOW_RATE_LIMIT_MS, 10_000)
  assert.equal(FP_SHOW_TEXT.waitNote, '等待中…（最多等 20 秒）')
  for (const t of Object.values(FP_SHOW_TEXT)) if (typeof t === 'string') assert.doesNotMatch(t.replace(/QR Code|ASN/g, ''), /[A-Za-z]{2,}/, `不中英夾雜：${t}`)
})

test('電腦視窗的文字照設計稿', () => {
  assert.equal(FP_SHOW_TEXT.pcHeading, '你的手機正在核對這台電腦')
  assert.equal(FP_SHOW_TEXT.pcBody, '請用手機的相機，掃下面這個 QR Code。')
  assert.equal(FP_SHOW_TEXT.pcCancel, '取消核對')
  assert.equal(FP_SHOW_TEXT.pcCountdown(272_000), '核對完成後，這個視窗會自己關起來（還剩 4 分 32 秒）')
  assert.equal(FP_SHOW_TEXT.pcCountdown(-5), '核對完成後，這個視窗會自己關起來（還剩 0 分 0 秒）')
  assert.equal(FP_SHOW_TEXT.pcCountdown(300_000), '核對完成後，這個視窗會自己關起來（還剩 5 分 0 秒）')
  assert.equal(groupFp16('a3f907c251de8b40'), 'a3f9 07c2 51de 8b40')
  assert.equal(groupFp16('xyz'), '')
})

test('送之前先看名單：離線不送、版本舊、其餘照送', () => {
  assert.equal(fpShowPrecheck(undefined), 'offline')
  assert.equal(fpShowPrecheck([]), 'offline')
  assert.equal(fpShowPrecheck(online), 'ok')
  assert.equal(fpShowPrecheck([{ version: '0.2.96' }]), 'old')
  assert.equal(fpShowPrecheck([{ version: '0.2.96' }, { version: '0.3.0' }]), 'ok', '有一個視窗夠新就送')
  assert.equal(fpShowPrecheck([{ version: '看不懂' }]), 'ok', '格式看不懂交給後台')
})

test('後台錯誤分類：rate_limited、400／404 當舊版、其他繼續等', () => {
  assert.equal(fpShowRequestError(new Error('fp_show_request HTTP 429 rate_limited')), 'rate_limited')
  assert.equal(fpShowRequestError('fp_show_request HTTP 404 not_found'), 'old')
  assert.equal(fpShowRequestError('fp_show_request HTTP 400 bad_request'), 'old')
  assert.equal(fpShowRequestError('fp_show_request HTTP 403 forbidden'), 'error')
  assert.equal(fpShowRequestError('fp_show_request 連線失敗：逾時'), 'error')
  assert.equal(fpShowPhaseOf('pending'), 'wait')
  assert.equal(fpShowPhaseOf('shown'), 'shown')
  assert.equal(fpShowPhaseOf('pc_cancelled'), 'pc_cancelled')
  for (const s of ['ended', 'superseded', 'expired', undefined]) assert.equal(fpShowPhaseOf(s), 'noreply', String(s))
})

test('離線：不送請求，直接是沒有回應', async () => {
  const f = fakeApi()
  const flow = createFpShowFlow({ api: f.api })
  await flow.start('PC1', [])
  assert.equal(flow.state.phase, 'noreply')
  assert.deepEqual(f.calls, [], '不打後台')
})

test('名單顯示版本舊：不送，顯示要更新', async () => {
  const f = fakeApi()
  const flow = createFpShowFlow({ api: f.api })
  await flow.start('PC1', [{ version: '0.2.50' }])
  assert.equal(flow.state.phase, 'old')
  assert.deepEqual(f.calls, [])
})

test('後台回 404（舊後台或那台不認得）：顯示要更新', async () => {
  const f = fakeApi({ requestErr: 'fp_show_request HTTP 404 not_found' })
  const flow = createFpShowFlow({ api: f.api })
  await flow.start('PC1', online)
  assert.equal(flow.state.phase, 'old')
})

test('在線：送請求、等待中；shown 換畫面；掃完結束時呼叫 end', async () => {
  const c = clock()
  const f = fakeApi({ statuses: ['pending', 'shown'] })
  const flow = createFpShowFlow({ api: f.api, now: c.now })
  await flow.start('PC1', online)
  assert.equal(flow.state.phase, 'wait')
  assert.equal(flow.state.id, ID)
  c.add(1000); await flow.tick()
  assert.equal(flow.state.phase, 'wait')
  c.add(1000); await flow.tick()
  assert.equal(flow.state.phase, 'shown')
  assert.deepEqual(ends(f.calls), [], 'shown 還不結束：電腦要繼續顯示給相機掃')
  await flow.finish()
  assert.equal(flow.state.phase, 'idle')
  assert.deepEqual(ends(f.calls), [ID])
})

test('20 秒還沒 shown：沒有回應，並結束那一筆', async () => {
  const c = clock()
  const f = fakeApi({ statuses: ['pending'] })
  const flow = createFpShowFlow({ api: f.api, now: c.now })
  await flow.start('PC1', online)
  c.add(FP_SHOW_WAIT_MS - 1); await flow.tick()
  assert.equal(flow.state.phase, 'wait', '還沒到 20 秒')
  c.add(1); await flow.tick()
  assert.equal(flow.state.phase, 'noreply')
  assert.deepEqual(ends(f.calls), [ID])
})

test('電腦端取消：顯示電腦端取消了核對，並結束那一筆', async () => {
  const c = clock()
  const f = fakeApi({ statuses: ['pc_cancelled'] })
  const flow = createFpShowFlow({ api: f.api, now: c.now })
  await flow.start('PC1', online)
  c.add(1000); await flow.tick()
  assert.equal(flow.state.phase, 'pc_cancelled')
  assert.deepEqual(ends(f.calls), [ID])
  await flow.finish()
  assert.deepEqual(ends(f.calls), [ID], '同一筆只結束一次')
})

test('rate_limited：顯示剛剛已經通知過，繼續等，下一秒再請求', async () => {
  const c = clock()
  let n = 0
  const f = fakeApi({ requestErr: () => { n += 1; if (n === 1) throw new Error('fp_show_request HTTP 429 rate_limited'); return { id: ID2 } } })
  const flow = createFpShowFlow({ api: f.api, now: c.now })
  await flow.start('PC1', online)
  assert.equal(flow.state.phase, 'wait')
  assert.equal(flow.state.note, FP_SHOW_TEXT.rateLimited)
  assert.equal(flow.state.id, '')
  c.add(1000); await flow.tick()
  assert.equal(flow.state.id, ID2, '過了限制就拿到編號')
  assert.equal(flow.state.note, '')
})

test('rate_limited 帶著那一筆的編號：沿用它接著查狀態，不另外開一筆', async () => {
  const c = clock()
  const f = fakeApi({ requestErr: () => { throw new Error(`fp_show_request HTTP 429 rate_limited:${ID}`) }, statuses: ['shown'] })
  const flow = createFpShowFlow({ api: f.api, now: c.now })
  await flow.start('PC1', online)
  assert.equal(flow.state.id, ID)
  assert.equal(flow.state.note, '')
  c.add(1000); await flow.tick()
  assert.equal(flow.state.phase, 'shown')
  assert.deepEqual(f.calls.filter(x => x[0] === 'request').length, 1, '沒有再開新的一筆')
  assert.deepEqual(f.calls.filter(x => x[0] === 'status'), [['status', ID]])
  assert.equal(fpShowRateLimitedId(new Error('fp_show_request HTTP 429 rate_limited:../x')), '')
  assert.equal(fpShowRateLimitedId(new Error('fp_show_request HTTP 429 rate_limited')), '')
})

test('不管怎麼結束都會呼叫 end：取消、離開、重試、逾時、電腦端取消', async () => {
  for (const [name, run] of [
    ['等待中按取消', async (flow) => { await flow.finish() }],
    ['shown 之後離開畫面', async (flow, c) => { c.add(1000); await flow.tick(); await flow.finish() }],
    ['重試', async (flow) => { await flow.start('PC1', online) }],
    ['逾時', async (flow, c) => { c.add(FP_SHOW_WAIT_MS); await flow.tick() }],
  ]) {
    const c = clock()
    const f = fakeApi({ statuses: ['shown'], ids: [ID, ID2] })
    const flow = createFpShowFlow({ api: f.api, now: c.now })
    await flow.start('PC1', online)
    await run(flow, c)
    assert.ok(ends(f.calls).includes(ID), `${name}：要結束第一筆`)
  }
})

test('守門：手機三個指令、電腦取消指令都有註冊；畫面接的是共用流程', async () => {
  const fs = await import('node:fs')
  const read = p => fs.readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
  const lib = read('../src-tauri/src/lib.rs')
  for (const c of ['android::android_fp_show_request', 'android::android_fp_show_status', 'android::android_fp_show_end', 'fp_show::fp_show_cancel']) assert.ok(lib.includes(c), `${c} 要註冊`)
  const android = read('../src-tauri/src/android.rs')
  for (const a of ['fp_show_request', 'fp_show_status', 'fp_show_end']) assert.match(android, new RegExp(`r\\.api_signed\\("${a}"`), `${a} 要帶本人簽章`)
  const tauri = read('../ui/lib/tauri.mjs')
  for (const c of ['android_fp_show_request', 'android_fp_show_status', 'android_fp_show_end', 'fp_show_cancel']) assert.ok(tauri.includes(`'${c}'`), c)
  const m = read('../ui/m.js')
  assert.match(m, /createFpShowFlow\(\{ state: fs, api: makeFpShowApi\(\)/)
  assert.match(m, /fpShow\.start\(cur\.node, core\?\.asn\?\.\[cur\.node\]\)/, '送之前看名單上那台的 ASN 在不在線、版本')
  const html = read('../ui/m.html')
  for (const ph of ["fs.phase === 'wait'", "fs.phase === 'shown'", "fs.phase === 'noreply'", "fs.phase === 'pc_cancelled'"]) assert.ok(html.includes(ph), ph)
  const panel = read('../ui/panel.js')
  assert.match(panel, /q === 'fpshow' \? 'fpshow'/, 'panel.js 認得 fpshow')
  assert.match(panel, /fpShowCancel\(fps\.id\)/, '取消核對交給 Rust 回報')
  assert.match(panel, /if \(kind === 'fpshow'\) return   \/\/ 這扇不跟樞紐要內容/, '不跟樞紐打招呼（不會被當成設定、指引視窗）')
})

test('請求還在路上就取消：拿到的編號也結束，不會復活', async () => {
  let release
  const calls = []
  const api = {
    request: () => new Promise(r => { release = () => r({ id: ID }) }),
    status: async () => ({ status: 'shown' }),
    end: async id => { calls.push(id) },
  }
  const flow = createFpShowFlow({ api, state: newFpShowState() })
  const p = flow.start('PC1', online)
  await new Promise(r => setTimeout(r, 0))
  await flow.finish()
  release()
  await p
  assert.equal(flow.state.phase, 'idle')
  assert.deepEqual(calls, [ID])
})
