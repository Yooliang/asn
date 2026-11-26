// #2355 P4：替別台電腦開新夥伴帶型號、開好後顯示實際型號、手機切換模型接上清單。
import { test, mock, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { CODE_TEXT, MODEL_PICK_ERR, buildLaunchRequest, launchErrorText, launchFormError, modelUsedOf, progressView } from '../ui/lib/mobile-launch.mjs'
import { launchModelView, pickedModel, remoteLaunchModelChoice } from '../ui/lib/remote-launch-models.mjs'
import { createModelLoader } from '../ui/lib/local-models.mjs'
import { acpListVendor, acpListWhere } from '../ui/lib/partner-ops-ui.mjs'
import { collectLaunchModelUsed, launchOkNoticeText } from '../ui/lib/partner-launch-notify.mjs'
import { NONE_TEXT, REMOTE_REFRESH_HINT, REMOTE_RETRY_LABEL, modelState, remoteView } from '../ui/lib/remote-models.mjs'
import { NO_ENGINE_NOTE } from '../ui/lib/model-catalog.mjs'

const logs = []
mock.method(console, 'info', (...a) => { logs.push(a.join(' ')) })
afterEach(() => { logs.length = 0 })
const read = f => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')

const GEM = { vendor: 'gemini', status: 'ok', models: [{ id: 'gemini-4-argon-high', name: 'Gemini 4 Argon (High)' }, { id: 'gemini-3.8-flash-low', name: 'Gemini 3.8 Flash (Low)' }] }
const launcher = (extra = {}) => ({
  profiles: [{ id: 'claude', engine: 'claude', mode: 'window' }, { id: 'gemini', engine: 'acp', mode: 'background' }, { id: 'codex', engine: 'codex' }, { id: 'gemini-term', engine: 'agy', mode: 'term' }, { id: 'pi', engine: 'pi' }, { id: 'mine', engine: '' }],
  cwd_allow: ['D:/work'], launch_model: true, models: [GEM, { vendor: 'codex', status: 'ok', models: [{ id: 'gpt-x', name: 'GPT X' }] }], ...extra,
})
const row = (id, profileId = id) => ({ id, profileId })

// ---- 下拉出不出現、出什麼 ----
test('Claude 開成視窗＝四個別名；Gemini 內建通道＝向摘要讀的清單', () => {
  const c = remoteLaunchModelChoice(launcher(), row('claude'), 'term')
  assert.equal(c.show, true); assert.equal(c.kind, 'aliases')
  assert.deepEqual(c.models.map(m => m.id), ['fable', 'opus', 'sonnet', 'haiku'])
  assert.ok(c.models.every(m => m.label.endsWith('別名（最新版）')))
  const g = remoteLaunchModelChoice(launcher(), row('gemini'), 'acp')
  assert.deepEqual({ show: g.show, kind: g.kind, vendor: g.vendor }, { show: true, kind: 'list', vendor: 'gemini' })
})

test('那台沒有回報 launch_model：不出下拉，只寫一句說明（不讓使用者選了才被擋）', () => {
  for (const l of [launcher({ launch_model: false }), launcher({ launch_model: undefined }), (({ launch_model, ...r }) => r)(launcher())]) {
    for (const [r, run] of [[row('claude'), 'term'], [row('gemini'), 'acp']]) {
      const c = remoteLaunchModelChoice(l, r, run)
      assert.equal(c.show, false); assert.equal(c.note, NONE_TEXT); assert.deepEqual(c.models, [])
    }
  }
})

test('不出下拉的：asn終端、經 pi、Codex、Grok 都沒有型號下拉也沒有說明；沒寫 engine 的自訂設定說明原因', () => {
  for (const [r, run] of [[row('gemini'), 'term'], [row('claude'), 'pi'], [row('gemini'), 'pi'], [row('codex'), 'term'], [row('grok'), 'acp']]) {
    const c = remoteLaunchModelChoice(launcher(), r, run)
    assert.equal(c.show, false, `${r.id}/${run}`); assert.equal(c.note, '', `${r.id}/${run}`)
  }
  // 摘要裡 claude 這個設定沒寫 engine：後台的 profile 會被電腦端拒絕，所以說明、不出下拉
  const noEngine = launcher({ profiles: [{ id: 'claude', mode: 'window' }] })
  const c = remoteLaunchModelChoice(noEngine, row('claude'), 'term')
  assert.equal(c.show, false); assert.equal(c.note, NO_ENGINE_NOTE)
})

test('清單狀態：ready／stale／pending／unavailable／none 各自的說明（別台）；stale 與讀不到有「再查一次」與定期更新的說明', () => {
  const view = (entry, l = launcher()) => launchModelView(remoteLaunchModelChoice(l, row('gemini'), 'acp'), (() => {
    const s = remoteView({ ...modelState({ models: [entry] }, 'gemini', { where: 'remote', narrow: true }), loading: false })
    return s
  })())
  const ready = view(GEM)
  assert.equal(ready.note, ''); assert.equal(ready.canRetry, false); assert.equal(ready.models.length, 2)
  const stale = view({ ...GEM, stale: true, age_s: 900, code: 'timeout' })
  assert.match(stale.note, /^清單是 15 分鐘前讀到的，剛才重新讀取失敗。/); assert.ok(stale.note.includes(REMOTE_REFRESH_HINT))
  assert.equal(stale.canRetry, true); assert.equal(stale.retryLabel, REMOTE_RETRY_LABEL)
  const gone = view({ vendor: 'gemini', status: 'unavailable', code: 'not_logged_in', models: [] })
  assert.ok(gone.note.startsWith('讀不到型號清單：Gemini 還沒登入（到那台電腦登入後再試）')); assert.ok(gone.note.includes(REMOTE_REFRESH_HINT))
  assert.doesNotMatch(gone.note, /not_logged_in/, '代碼不上畫面')
  assert.deepEqual(gone.models, [])
  const pend = view({ vendor: 'gemini', status: 'pending', models: [] })
  assert.equal(pend.note, '正在讀取型號清單…'); assert.equal(pend.canRetry, false)
  // 舊電腦：摘要沒有 models（也就沒有 launch_model）→ 版本較舊的說明
  const old = launchModelView(remoteLaunchModelChoice(launcher({ launch_model: false, models: undefined }), row('gemini'), 'acp'), null)
  assert.equal(old.note, NONE_TEXT); assert.equal(old.show, false)
})

test('窄規則：切換模型的格式限制不收的型號先不列（筆數寫進 console）', () => {
  const l = { models: [{ vendor: 'gemini', status: 'ok', models: [{ id: 'a/b', name: 'x' }, { id: 'gemini-a', name: 'A' }] }] }
  const s = modelState(l, 'gemini', { where: 'remote', narrow: true })
  assert.deepEqual(s.models.map(m => m.id), ['gemini-a'])
  assert.ok(logs.some(x => x.includes('1 筆因切換模型的格式限制')))
})

test('選的型號必須還在目前的清單裡，否則算沒選（清單換了不能偷帶舊的）', () => {
  const v = { show: true, models: [{ id: 'opus' }, { id: 'haiku' }] }
  assert.equal(pickedModel(v, 'opus'), 'opus'); assert.equal(pickedModel(v, 'gone'), ''); assert.equal(pickedModel(v, ''), '')
  assert.equal(pickedModel({ show: false, models: [{ id: 'opus' }] }, 'opus'), '', '不出下拉就不帶')
})

// ---- 送出的請求 ----
const F = { node: 'H', name: ' 小格 ', cwd: 'D:/work', first: '', profile: 'gemini' }
test('buildLaunchRequest：背景 Gemini、Claude 視窗帶 model；asn終端與經 pi 不帶；不指定就沒有這個鍵（不送 null）', () => {
  const l = launcher()
  const acp = buildLaunchRequest(F, { run: 'acp', row: row('gemini'), launcher: l, model: 'gemini-4-argon-high' })
  assert.equal(acp.model, 'gemini-4-argon-high'); assert.equal(acp.profile, 'gemini')
  const claude = buildLaunchRequest({ ...F, profile: 'claude' }, { run: 'term', row: row('claude'), launcher: l, model: 'opus' })
  assert.deepEqual({ p: claude.profile, m: claude.model }, { p: 'claude', m: 'opus' })
  const term = buildLaunchRequest(F, { run: 'term', row: row('gemini'), launcher: l, model: 'gemini-4-argon-high' })
  assert.equal(term.profile, 'gemini-term'); assert.equal('model' in term, false, 'asn終端不帶（電腦端會拒絕）')
  for (const none of ['', undefined, null]) assert.equal('model' in buildLaunchRequest(F, { run: 'acp', row: row('gemini'), launcher: l, model: none }), false, String(none))
  assert.equal('model' in buildLaunchRequest(F, { run: 'acp', row: row('gemini'), launcher: l, model: 'a b' }), false, '格式不合的不送')
  // 經 pi：model 與 pi_provider／pi_model 不並存（後台會 bad_model）
  const pi = buildLaunchRequest({ ...F, profile: 'pi', piModel: '' }, { run: 'pi', row: row('gemini', 'pi'), launcher: { ...l, pi_models: [{ provider: 'google', model: 'gemini-x' }] }, model: 'opus' })
  assert.ok(pi === null || !('model' in pi))
})

test('launchFormError：選的型號不在清單裡就請他重選', () => {
  const elig = { ok: true, reason: '' }
  const f = { ...F, first: '', name: 'abc' }
  assert.equal(launchFormError(f, elig, { run: 'acp', modelOk: false }), MODEL_PICK_ERR)
  assert.equal(launchFormError(f, elig, { run: 'acp', modelOk: true }), '')
  assert.equal(launchFormError(f, elig, { run: 'acp' }), '', '沒給＝沒選型號')
})

// ---- 錯誤文案 ----
test('bad_model、model_unsupported 的中文跟後台 launch.ts 逐字相同（不另外寫一份）', () => {
  const ts = read('../../supabase/functions/_shared/launch.ts')
  for (const code of ['bad_model', 'model_unsupported']) {
    const m = new RegExp(`^  ${code}: "([^"]+)",$`, 'm').exec(ts)
    assert.ok(m, `launch.ts 找不到 ${code}`)
    assert.equal(CODE_TEXT[code], m[1], `${code} 要跟 launch.ts 逐字相同`)
    assert.equal(launchErrorText(`launch HTTP 400 ${code}`), m[1])
  }
})

// ---- 實際型號 ----
test('開好後顯示實際型號：用那台回報的 model_used；沒有回報就不提型號，也不拿選的值頂替', () => {
  const done = { status: 'ok', model_used: 'gemini-4-argon-high' }
  assert.equal(progressView(done, true, '小格').text, '「小格」已經開好了（型號：gemini-4-argon-high），可以直接對話。')
  assert.equal(progressView(done, false, '小格').text, '那台已經開好（型號：gemini-4-argon-high），等它出現在名單上…')
  // 沒指定型號：跟以前一樣
  assert.equal(progressView({ status: 'ok' }, true, '小格').text, '「小格」已經開好了，可以直接對話。')
  // 有選型號、那台沒回報 model_used：照實說，不寫成已套用、不把選的值寫上去
  const t = progressView({ status: 'ok' }, true, '小格', '', { picked: 'opus' }).text
  assert.ok(t.includes('沒有回報實際用了哪個型號')); assert.ok(!t.includes('opus'))
  // 這一輪沒查到（row 是 null）時沿用之前拿到的
  assert.equal(progressView(null, true, '小格', '', { used: 'opus' }).text, '「小格」已經開好了（型號：opus），可以直接對話。')
  // model_used 優先於名單上那個視窗回報的模型
  assert.equal(progressView(done, true, '小格', 'other').text, '「小格」已經開好了（型號：gemini-4-argon-high），可以直接對話。')
  // 壞的 model_used 不採用
  assert.equal(modelUsedOf({ model_used: 'a b' }), ''); assert.equal(modelUsedOf({ model_used: 5 }), ''); assert.equal(modelUsedOf(null, 'x'), 'x')
})

test('電腦版開好通知：只有那台回報了 model_used 才通知，內容是實際型號', () => {
  const track = [{ id: 'a', name: '小格', model: 'gemini-x' }, { id: 'b', name: '小文', model: 'opus' }, { id: 'c', name: '小武', model: '' }]
  const launches = [{ id: 'a', status: 'ok', model_used: 'gemini-4-argon-high' }, { id: 'b', status: 'ok' }, { id: 'c', status: 'ok', model_used: 'a b' }, { id: 'd', status: 'failed', model_used: 'opus' }]
  const got = collectLaunchModelUsed(launches, track)
  assert.deepEqual(got, [{ id: 'a', name: '小格', modelUsed: 'gemini-4-argon-high' }], '沒回報的（b）、格式不對的（c）、失敗的（d）都不通知；也不拿選的 gemini-x 頂替')
  const n = launchOkNoticeText('小格', 'gemini-4-argon-high')
  assert.ok(n.body.includes('「小格」') && n.body.includes('gemini-4-argon-high')); assert.equal(n.hideLogPath, true)
  const list = read('ui/list.js')
  assert.match(list, /collectLaunchModelUsed\(body\?\.launches, trackSnap\)/, 'pollLaunchResults 接上成功通知')
  assert.match(list, /model: body\.model \?\? ''/, '追蹤項目記下送出的型號')
})

// ---- 讀取器（別台）----
function rig(answers) {
  const timers = [], calls = [], seen = []
  const loader = createModelLoader({
    where: 'remote', vendorLabel: v => v,
    fetch: async a => { calls.push(a); const x = answers.shift(); if (x instanceof Error) throw x; return x },
    onChange: (v, view) => seen.push({ v, ...view }),
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length }, clearTimer: () => {},
  })
  return { loader, timers, calls, seen, last: () => seen[seen.length - 1] }
}
const src = e => ({ models: [e] })

test('別台的讀取器：讀不到時寫「那台」、按鈕叫「再查一次」並說明會定期更新；再問會重新向後台拿', async () => {
  const r = rig([src({ vendor: 'gemini', status: 'unavailable', code: 'not_installed', models: [] }), src(GEM)])
  await r.loader.load('gemini')
  assert.ok(r.last().note.startsWith('讀不到型號清單：那台電腦沒有安裝 Gemini')); assert.ok(r.last().note.includes(REMOTE_REFRESH_HINT))
  assert.equal(r.last().retryLabel, REMOTE_RETRY_LABEL); assert.equal(r.last().canRetry, true)
  await r.loader.load('gemini', { force: true })
  assert.equal(r.last().state, 'ready'); assert.equal(r.last().note, '')
  assert.deepEqual(r.calls[1], { vendor: 'gemini', force: true, retry: false })
})

test('別台的讀取器：pending 自動再問（retry:true 要重新向後台拿）；連問都 pending 就當讀不到並可再查一次', async () => {
  const p = src({ vendor: 'gemini', status: 'pending', models: [] })
  const r = rig([p, p, p, p, src(GEM)])
  await r.loader.load('gemini')
  assert.equal(r.last().state, 'pending'); assert.equal(r.calls[0].retry, false)
  for (let i = 0; i < 3; i++) { r.timers.at(-1).fn(); await new Promise(x => setImmediate(x)) }
  assert.deepEqual(r.calls.map(c => c.retry), [false, true, true, true])
  assert.equal(r.last().state, 'unavailable'); assert.ok(r.last().note.includes('那台電腦還在')|| r.last().note.includes('讀取逾時'))
  assert.equal(r.last().retryLabel, REMOTE_RETRY_LABEL)
  await r.loader.load('gemini', { force: true })
  assert.equal(r.last().state, 'ready')
})

test('別台的讀取器：fetch 丟錯誤＝讀不到（有白話、有再查一次），不是「版本較舊」', async () => {
  const r = rig([new Error('boom')])
  await r.loader.load('gemini')
  assert.equal(r.last().state, 'unavailable'); assert.equal(r.last().canRetry, true); assert.doesNotMatch(r.last().note, /較舊/)
})

// ---- 切換模型讀哪裡 ----
test('acpListWhere：工作者在這台＝本機、在別台＝摘要；Grok、沒有讀的管道、不知道自己是哪台＝輸入框；acpListVendor 的老行為不變', () => {
  const g = { node: 'W', engine: 'gemini', agent: 'x' }
  assert.equal(acpListWhere(g, { selfNode: 'H', canReadRemote: true }), 'remote')
  assert.equal(acpListWhere(g, { selfNode: 'H' }), '', '沒有讀別台的管道')
  assert.equal(acpListWhere({ ...g, node: 'H' }, { selfNode: 'H', canReadRemote: true }), 'local')
  assert.equal(acpListWhere({ ...g, node: 'H' }, { selfNode: 'H', canReadLocal: false, canReadRemote: true }), '')
  assert.equal(acpListWhere({ ...g, engine: 'grok' }, { selfNode: 'H', canReadRemote: true }), '')
  assert.equal(acpListWhere(g, { selfNode: '', canReadRemote: true }), '')
  assert.equal(acpListVendor({ ...g, node: 'H' }, { selfNode: 'H' }), 'gemini'); assert.equal(acpListVendor(g, { selfNode: 'H' }), '')
})

// ---- 接線 ----
test('接線：手機開新夥伴有型號下拉與「再查一次」、電腦版別台也有；手機切換模型的 Gemini 清單讀摘要', () => {
  const html = read('ui/m.html'), m = read('ui/m.js'), list = read('ui/list.js'), lhtml = read('ui/list.html')
  assert.match(html, /v-if="lchModel\.show"[^>]*>型號<select[^>]*v-model="lch\.model"/)
  assert.match(html, /@click="reloadLchModels"/)
  assert.match(m, /buildLaunchRequest\(lch, \{[^}]*model: lchModelPick\.value/, '送出帶選的型號')
  assert.match(m, /modelOk: !lch\.model \|\| !!lchModelPick\.value/)
  assert.match(m, /progressView\(row, appeared, t\.name,[\s\S]*?\{ used, picked: t\.model \}\)/, '進度顯示實際型號')
  assert.match(html, /@click="reloadOpsAcp"/); assert.match(html, /v-if="opsAcpNote"/)
  assert.match(lhtml, /launchModel\.retryLabel \|\| '重新讀取'/)
  assert.match(list, /remoteLaunchModelChoice\(dlgRemoteLauncher\.value, dlgRow\.value, dlgAuto\.value\.run\)/)
  assert.match(list, /model: launchModelPick\.value \}\)/, '電腦版別台送出帶型號')
  assert.match(read('ui/lib/partner-ops-ui.mjs'), /machinesByNode\(await props\.api\.launchers\(\)\)\[props\.friend\.node\]/, '別台工作者的清單向後台問 launchers')
})
