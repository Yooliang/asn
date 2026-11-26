import test, { mock } from 'node:test'
import assert from 'node:assert/strict'
import { runOnce, runCommand, parseArgs, ALERT_CAUSES, WORKFLOWS } from '../../../tools/release/auto_publish.mjs'
import { PENDING_PLATFORMS, PENDING_KINDS, isSemver, isCommit, isPlatform, isKind, validateItem, buildItem, enqueuePending, readPending, pendingPathOf, MAX_ITEM_BYTES, MAX_FILE_BYTES, LOCK_FUTURE_MS, PENDING_BAD_MESSAGE, cleanLastError } from '../../../tools/release/post_pending.mjs'
import { env, row, sha, short, opts, STATE, T0, lk, seededState, postFails, alertOf, lastState, pendingOf, PENDING, publishWithPostFailed, markerOut } from './helpers/auto-publish-env.mjs'

const FIELDS = ['at', 'attempts', 'claimedAt', 'claimedBy', 'commit', 'createdAt', 'id', 'kind', 'lastError', 'platform', 'version']
const quiet = () => mock.method(console, 'warn', () => {})
// 行分隔字元 U+2028、段落分隔字元 U+2029：用程式產生，不在原始碼裡放原始字元
const LS = String.fromCharCode(0x2028)
const PS = String.fromCharCode(0x2029)

test('#2345 發佈成功、沒貼成：佇列有 1 筆固定欄位（沒有 text、room），告警照舊 active', async () => {
  const e = env({ desktopRows: [row('v0.2.99', 222)] })
  const r = await publishWithPostFailed(e)
  assert.equal(r.outcome, 'publish')
  const q = pendingOf(e)
  assert.equal(q.v, 1)
  assert.equal(q.items.length, 1)
  const it = q.items[0]
  assert.equal(it.id, 'desktop@0.2.99#published')
  assert.equal(it.kind, 'published')
  assert.equal(it.platform, 'desktop')
  assert.equal(it.version, '0.2.99')
  assert.equal(it.commit, short(222))
  assert.match(it.commit, /^[0-9a-f]{8}$/)
  assert.equal(it.attempts, 0)
  assert.deepEqual(Object.keys(it).sort(), FIELDS)
  assert.ok(!('text' in it) && !('room' in it))
  assert.ok(!JSON.stringify(q).includes('發版完成'), '佇列裡沒有任何文案')
  assert.equal(alertOf(e).alerts['post-failed'].status, 'active')
  assert.equal(lastState(e.fsMap).done['desktop@0.2.99'].result, 'published')
})

test('#2345 寫佇列用自己的鎖 post-pending.json.lock，不碰 state.json.lock 以外的鎖名', async () => {
  const e = env({ desktopRows: [row('v0.2.99', 222)] })
  await publishWithPostFailed(e)
  assert.ok(e.calls.ops.includes(`lock:${PENDING}.lock`))
  assert.ok(!e.fsMap.has(`${PENDING}.lock`), '寫完要還鎖')
  assert.equal(pendingPathOf(opts), PENDING)
})

test('#2345 沒有標記（群組貼成功）：不寫佇列檔', async () => {
  const e = env({ desktopRows: [row('v0.2.99', 222)] })
  e.deps.spawn = () => ({ status: 0, stdout: 'done', stderr: '' })
  await runOnce(opts, e.deps)
  await runOnce(opts, e.deps)
  assert.ok(!e.fsMap.has(PENDING))
})

test('#2345 同一筆寫兩次：佇列仍只有 1 筆', () => {
  const e = env()
  const input = { kind: 'published', platform: 'desktop', version: '0.2.99', commit: sha(1) }
  assert.equal(enqueuePending(opts, e.deps, input).ok, true)
  e.clock.t = T0 + 60_000
  assert.equal(enqueuePending(opts, e.deps, input).ok, true)
  assert.equal(pendingOf(e).items.length, 1)
  assert.equal(pendingOf(e).items[0].createdAt, new Date(T0).toISOString(), '重複寫入不改動原有那筆')
})

test('#2345 電腦版與 Linux 同一版都沒貼成：2 筆，不互相覆蓋', async () => {
  const e = env({ desktopRows: [row('v0.2.99', 222)], linuxRows: [row('linux-v0.2.99', 333)] })
  e.deps.spawn = (bin, args) => ({ status: 0, stdout: args.includes('--dry-run') ? 'ok' : markerOut('x'), stderr: '' })
  for (let i = 0; i < 4; i++) { e.clock.t = T0 + i * 120_000; await runOnce(opts, e.deps) }
  const items = pendingOf(e).items
  assert.deepEqual(items.map((x) => x.id).sort(), ['desktop@0.2.99#published', 'linux@0.2.99#published'])
  assert.equal(items.find((x) => x.platform === 'linux').commit, short(333))
  assert.equal(items.find((x) => x.platform === 'desktop').commit, short(222))
})

test('#2345 佇列檔損壞：不覆寫、改名保留、留 pending-bad 告警；新的這筆仍寫進新檔', async () => {
  const e = env({ desktopRows: [row('v0.2.99', 222)], files: { [PENDING]: '{壞掉的內容' } })
  const r = await publishWithPostFailed(e)
  assert.equal(r.outcome, 'publish')
  const bad = [...e.fsMap.keys()].filter((k) => k.startsWith(`${PENDING}.bad-`))
  assert.equal(bad.length, 1)
  assert.equal(e.fsMap.get(bad[0]), '{壞掉的內容', '原內容原封不動留著')
  assert.equal(alertOf(e).alerts['pending-bad'].status, 'active')
  assert.equal(alertOf(e).alerts['pending-bad'].message, PENDING_BAD_MESSAGE)
  assert.ok(!alertOf(e).alerts['bad-state'])
  assert.equal(pendingOf(e).items.length, 1)
})

test('#2345 結構不對（不是 v:1 的佇列）也當損壞處理', () => {
  const e = env({ files: { [PENDING]: JSON.stringify({ v: 2, items: [] }) } })
  const r = enqueuePending(opts, e.deps, { kind: 'published', platform: 'linux', version: '0.2.99', commit: sha(5) })
  assert.equal(r.ok, true)
  assert.ok([...e.fsMap.keys()].some((k) => k.startsWith(`${PENDING}.bad-`)))
})

test('#2345 佇列鎖被活著的 pid 佔住：發版結果仍是已發佈，只記 log，不寫佇列', async () => {
  const e = env({ desktopRows: [row('v0.2.99', 222)], files: { [`${PENDING}.lock`]: lk(777) }, alive: [777] })
  const r = await publishWithPostFailed(e)
  assert.equal(r.outcome, 'publish')
  assert.equal(lastState(e.fsMap).done['desktop@0.2.99'].result, 'published')
  assert.ok(!e.fsMap.has(PENDING))
  assert.ok(e.calls.logs.some((l) => /待貼佇列的鎖被佔用/.test(l)))
  assert.equal(alertOf(e).alerts['post-failed'].status, 'active', '告警照舊')
})

test('#2345 寫佇列丟錯：發版結果仍是已發佈，只記 log', async () => {
  const e = env({ desktopRows: [row('v0.2.99', 222)] })
  const w = e.deps.writeFile
  e.deps.writeFile = (p, s) => { if (p.includes('post-pending')) throw new Error('磁碟滿了'); w(p, s) }
  const r = await publishWithPostFailed(e)
  assert.equal(r.outcome, 'publish')
  assert.equal(lastState(e.fsMap).done['desktop@0.2.99'].result, 'published')
  assert.ok(e.calls.logs.some((l) => /寫待貼佇列失敗/.test(l)))
  assert.ok(!e.fsMap.has(`${PENDING}.lock`), '丟錯也要還鎖')
})

test('#2345 gh 查不到 commit：不寫佇列、記 warn，發版結果不變', async () => {
  const m = quiet()
  const e = env({ desktopRows: [row('v0.2.99', 222, { headSha: undefined })] })
  const r = await publishWithPostFailed(e)
  assert.equal(r.outcome, 'publish')
  assert.ok(!e.fsMap.has(PENDING))
  assert.ok(m.mock.calls.some((c) => /commit/.test(c.arguments[0])))
  m.mock.restore()
})

test('#2345 驗證函式：三段數字版號、8 位 hex、平台白名單、kind', () => {
  for (const v of ['0.2.99', '10.20.30']) assert.equal(isSemver(v), true, v)
  for (const v of ['0.2', 'v0.2.99', '0.2.99.1', '0.2.99-', '0.2.99-rc.1', '1.0.0-beta', '0.2.99 ', '', null, 5, '0.2.99\n--x']) assert.equal(isSemver(v), false, String(v))
  assert.equal(isCommit(short(7)), true)
  for (const v of ['abc', 'A'.repeat(8), 'g'.repeat(8), `${short(7)}0`, short(7).slice(1), sha(7), null]) assert.equal(isCommit(v), false, String(v))
  assert.equal(isPlatform('desktop'), true)
  assert.equal(isPlatform('linux'), true)
  for (const v of ['mac', 'Desktop', '', null]) assert.equal(isPlatform(v), false, String(v))
  assert.equal(isKind('published'), true)
  assert.equal(isKind('ci-failed'), true)
  assert.equal(isKind('blocked'), true)
  for (const v of ['notice', 'other', '', null]) assert.equal(isKind(v), false, String(v))
})

test('#2345 平台白名單與常駐程式實際用到的平台一致', () => {
  assert.deepEqual([...PENDING_PLATFORMS].sort(), WORKFLOWS.map((w) => w.platform).sort())
  assert.deepEqual([...PENDING_KINDS].sort(), ['blocked', 'ci-failed', 'dryrun-failed', 'publish-failed', 'published'])
})

test('#2345 不合格就整筆丟掉並 warn，warn 說欄位但不含原文', () => {
  const m = quiet()
  const good = buildItem({ kind: 'published', platform: 'desktop', version: '0.2.99', commit: sha(9) }, T0)
  assert.ok(good)
  const secret = '機密原文XYZ-123'
  const cases = [['version', { version: secret }], ['commit', { commit: secret }], ['platform', { platform: secret }], ['kind', { kind: secret }]]
  for (const [field, over] of cases) {
    m.mock.resetCalls()
    const x = { ...good, ...over }
    if (field !== 'platform' && field !== 'kind' && field !== 'version') assert.equal(validateItem(x), null)
    else assert.equal(validateItem({ ...x, id: `${x.platform}@${x.version}#${x.kind}` }), null)
    const msg = m.mock.calls.map((c) => c.arguments[0]).join('\n')
    assert.ok(msg.includes(field), `warn 要說出 ${field}：${msg}`)
    assert.ok(!msg.includes(secret), 'warn 不能印出原文')
  }
  m.mock.restore()
})

test('#2345 寫入端拿到不合格的值：不寫入、記 warn（不含原文）', () => {
  const m = quiet()
  const e = env()
  const r = enqueuePending(opts, e.deps, { kind: 'published', platform: 'desktop', version: '0.2.99', commit: '不是hex-ZZZ' })
  assert.equal(r.ok, false)
  assert.ok(!e.fsMap.has(PENDING))
  assert.ok(e.calls.logs.some((l) => /commit/.test(l)))
  assert.ok(!e.calls.logs.join('\n').includes('ZZZ'))
  m.mock.restore()
})

test('#2345 讀佇列時多出欄位（text、room 等）的那筆整筆拒絕；欄位不合格的也丟掉；其餘照留', () => {
  const m = quiet()
  const ok = buildItem({ kind: 'published', platform: 'linux', version: '0.2.99', commit: sha(3) }, T0)
  const extra = { ...ok, text: '偷塞的文案', room: 'evil' }
  const e = env({ files: { [PENDING]: JSON.stringify({ v: 1, updatedAt: 'x', items: [ok, extra, { ...ok, commit: 'zz' }] }) } })
  const r = readPending(opts, e.deps)
  assert.equal(r.ok, true)
  assert.equal(r.items.length, 1)
  assert.deepEqual(Object.keys(r.items[0]).sort(), FIELDS)
  assert.ok(m.mock.calls.some((c) => /extra/.test(c.arguments[0])))
  m.mock.restore()
})

test('#2345 型別不對的整筆拒絕（attempts 字串、claimedBy 字串、lastError 數字、version 數字）', () => {
  const m = quiet()
  const ok = buildItem({ kind: 'published', platform: 'linux', version: '0.2.99', commit: sha(3) }, T0)
  for (const [f, v] of [['attempts', '0'], ['attempts', -1], ['claimedBy', '12'], ['lastError', 5], ['at', 12345], ['version', 299]]) {
    assert.equal(validateItem({ ...ok, [f]: v }), null, `${f}=${v}`)
  }
  assert.equal(validateItem(null), null)
  assert.equal(validateItem([ok]), null)
  assert.equal(validateItem({ ...ok, attempts: undefined }), null)
  m.mock.restore()
})

test('#2345 單筆序列化超過上限：整筆拒絕', () => {
  const m = quiet()
  const ok = buildItem({ kind: 'published', platform: 'linux', version: '0.2.99', commit: sha(3) }, T0)
  assert.ok(Buffer.byteLength(JSON.stringify(ok)) < MAX_ITEM_BYTES)
  m.mock.resetCalls()
  const version = `${'1'.repeat(200)}.0.0`
  assert.equal(validateItem({ ...ok, version, id: `linux@${version}#published` }), null, '各欄位都合格、只有總大小超過')
  assert.ok(m.mock.calls.some((c) => /size/.test(c.arguments[0])))
  m.mock.restore()
})

test('#2345 cleanLastError：拿掉換行與控制字元、截到 100 字、非字串回 null', () => {
  assert.equal(cleanLastError('甲\n乙\r丙\t丁\u0000戊\u007f己\u0085庚' + LS + '辛' + PS + '壬'), '甲乙丙丁戊己庚辛壬')
  assert.equal(cleanLastError('x'.repeat(250)).length, 100)
  assert.equal(cleanLastError('a\nb'.repeat(80)).length, 100)
  assert.equal(cleanLastError('正常'), '正常')
  for (const v of [null, undefined, 5, {}, ['a']]) assert.equal(cleanLastError(v), null)
})

test('#2345 lastError 驗證：null 或 ≤100 字無控制字元的字串才收，換行、控制字元、超過 100 字整筆拒絕', () => {
  const m = quiet()
  const ok = buildItem({ kind: 'published', platform: 'linux', version: '0.2.99', commit: sha(3) }, T0)
  assert.ok(validateItem({ ...ok, lastError: null }))
  assert.ok(validateItem({ ...ok, lastError: 'x'.repeat(100) }))
  for (const bad of ['x'.repeat(101), 'a\nb', 'a\rb', 'a\u0000b', 'a\u007fb', 'a\u0085b', 'a' + LS + 'b', 'a' + PS + 'b', 5]) {
    m.mock.resetCalls()
    assert.equal(validateItem({ ...ok, lastError: bad }), null, JSON.stringify(bad))
    assert.ok(m.mock.calls.some((c) => /lastError/.test(c.arguments[0])))
  }
  m.mock.restore()
})

test('#2345 整個檔案超過上限：當成壞檔（改名保留、pending-bad 告警）', () => {
  const big = JSON.stringify({ v: 1, updatedAt: 'x', items: [], pad: 'x'.repeat(MAX_FILE_BYTES) })
  const e = env({ files: { [PENDING]: big } })
  const r = enqueuePending(opts, e.deps, { kind: 'published', platform: 'linux', version: '0.2.99', commit: sha(3) })
  assert.equal(r.ok, true)
  const bad = [...e.fsMap.keys()].filter((k) => k.startsWith(`${PENDING}.bad-`))
  assert.equal(bad.length, 1)
  assert.equal(e.fsMap.get(bad[0]), big)
  assert.equal(alertOf(e).alerts['pending-bad'].status, 'active')
  assert.equal(pendingOf(e).items.length, 1)
})

test('#2345 commit 由完整 SHA 取前 8 碼；不是 hex 或太短的拒絕', () => {
  const it = buildItem({ kind: 'blocked', platform: 'linux', version: '0.2.99', commit: sha(0x1234abcd) }, T0)
  assert.equal(it.commit, '1234abcd')
  const m = quiet()
  assert.equal(buildItem({ kind: 'blocked', platform: 'linux', version: '0.2.99', commit: 'abc1234' }, T0), null)
  assert.equal(buildItem({ kind: 'blocked', platform: 'linux', version: '0.2.99-rc.1', commit: sha(1) }, T0), null)
  m.mock.restore()
})

test('#2345 鎖檔時間戳在未來超過 5 分鐘：當壞鎖（改名、留告警）後仍可寫入；未超過 5 分鐘且 pid 活著則照舊被擋', () => {
  const e = env({ files: { [`${PENDING}.lock`]: lk(777, T0 + LOCK_FUTURE_MS + 60_000) }, alive: [777] })
  const r = enqueuePending(opts, e.deps, { kind: 'published', platform: 'linux', version: '0.2.99', commit: sha(3) })
  assert.equal(r.ok, true)
  assert.ok([...e.fsMap.keys()].some((k) => k.startsWith(`${PENDING}.lock.bad-`)))
  assert.equal(alertOf(e).alerts['pending-bad'].status, 'active')
  assert.equal(pendingOf(e).items.length, 1)
  const e2 = env({ files: { [`${PENDING}.lock`]: lk(777, T0 + 60_000) }, alive: [777] })
  assert.equal(enqueuePending(opts, e2.deps, { kind: 'published', platform: 'linux', version: '0.2.99', commit: sha(3) }).ok, false)
})

test('#2345 未來時間戳的壞鎖處理只作用在待貼鎖，state 鎖不受影響', async () => {
  const e = env({ desktopRows: [row('v0.2.99', 222)], files: { [`${STATE}.lock`]: lk(777, T0 + LOCK_FUTURE_MS + 60_000) }, alive: [777] })
  const r = await runOnce(opts, e.deps)
  assert.equal(r.outcome, 'locked')
})

// ---- ci-failed／blocked：決定階段的回報貼群組失敗，另寫進待貼佇列 ----
test('#2345 ci-failed 回報貼群組失敗：佇列有一筆 kind=ci-failed，欄位合格，告警訊息照舊', async () => {
  const e = env({ desktopRows: [row('v0.2.99', 222, { conclusion: 'failure' })] })
  postFails(e)
  const r = await runOnce(opts, e.deps)
  assert.equal(r.outcome, 'report')
  const it = pendingOf(e).items[0]
  assert.equal(pendingOf(e).items.length, 1)
  assert.deepEqual(Object.keys(it).sort(), FIELDS)
  assert.equal(it.id, 'desktop@0.2.99#ci-failed')
  assert.equal(it.kind, 'ci-failed')
  assert.equal(it.platform, 'desktop')
  assert.equal(it.version, '0.2.99')
  assert.equal(it.commit, short(222))
  assert.ok(alertOf(e).alerts['post-failed'].message.startsWith('通知群組失敗'))
})

test('#2345 blocked 回報貼群組失敗：佇列有一筆 kind=blocked（Linux 那版，commit 取 Linux 的 run）', async () => {
  const done = { 'desktop@0.2.44': { result: 'seeded' }, 'linux@0.2.44': { result: 'seeded' }, 'desktop@0.2.99': { result: 'publish-failed', at: 'x', runId: '222' } }
  const e = env({ desktopRows: [row('v0.2.99', 222)], linuxRows: [row('linux-v0.2.99', 333)], files: { [STATE]: JSON.stringify(seededState({ done })) } })
  postFails(e)
  const r = await runOnce(opts, e.deps)
  assert.equal(r.outcome, 'report')
  const it = pendingOf(e).items.find((x) => x.kind === 'blocked')
  assert.ok(it, JSON.stringify(pendingOf(e)))
  assert.equal(it.id, 'linux@0.2.99#blocked')
  assert.equal(it.platform, 'linux')
  assert.equal(it.version, '0.2.99')
  assert.equal(it.commit, short(333))
  assert.deepEqual(Object.keys(it).sort(), FIELDS)
})

test('#2345 ci-failed 回報貼成功：不寫佇列', async () => {
  const e = env({ desktopRows: [row('v0.2.99', 222, { conclusion: 'failure' })] })
  await runOnce(opts, e.deps)
  assert.ok(!e.fsMap.has(PENDING))
})

test('#2345 dry-run 失敗的回報貼群組失敗：佇列有一筆 kind=dryrun-failed，欄位合格', async () => {
  const e = env({ desktopRows: [row('v0.2.99', 222)], spawnStatus: 1 })
  postFails(e)
  const r = await runOnce(opts, e.deps)
  assert.equal(r.outcome, 'dryRun-failed')
  const items = pendingOf(e).items
  assert.equal(items.length, 1)
  assert.deepEqual(Object.keys(items[0]).sort(), FIELDS)
  assert.equal(items[0].id, 'desktop@0.2.99#dryrun-failed')
  assert.equal(items[0].kind, 'dryrun-failed')
  assert.equal(items[0].version, '0.2.99')
  assert.equal(items[0].commit, short(222))
})

test('#2345 正式發佈失敗的回報貼群組失敗：佇列有一筆 kind=publish-failed，欄位合格', async () => {
  const e = env({ desktopRows: [row('v0.2.99', 222)] })
  await runOnce(opts, e.deps)
  e.deps.spawn = () => ({ status: 1, stdout: '', stderr: '' })
  postFails(e)
  const r = await runOnce(opts, e.deps)
  assert.equal(r.outcome, 'publish-failed')
  const items = pendingOf(e).items
  assert.equal(items.length, 1)
  assert.deepEqual(Object.keys(items[0]).sort(), FIELDS)
  assert.equal(items[0].id, 'desktop@0.2.99#publish-failed')
  assert.equal(items[0].commit, short(222))
})

test('#2345 dry-run 失敗的回報貼成功：不寫佇列', async () => {
  const e = env({ desktopRows: [row('v0.2.99', 222)], spawnStatus: 1 })
  await runOnce(opts, e.deps)
  assert.ok(!e.fsMap.has(PENDING))
})

test('#2345 dry-run 失敗、run 沒有 commit：不寫佇列', async () => {
  const m = quiet()
  const e = env({ desktopRows: [row('v0.2.99', 222, { headSha: undefined })], spawnStatus: 1 })
  postFails(e)
  await runOnce(opts, e.deps)
  assert.ok(!e.fsMap.has(PENDING))
  m.mock.restore()
})

test('#2345 暫停（paused）回報貼群組失敗：沒有版號與 commit，不寫佇列', async () => {
  const done = { 'desktop@0.2.44': { result: 'seeded' }, 'linux@0.2.44': { result: 'seeded' }, 'desktop@0.2.45': { result: 'ci-failed', at: 'x', runId: '1' } }
  const e = env({ desktopRows: [row('v0.2.46', 223)], files: { [STATE]: JSON.stringify(seededState({ done })) } })
  postFails(e)
  const r = await runOnce(opts, e.deps)
  assert.equal(r.outcome, 'report')
  assert.ok(!e.fsMap.has(PENDING))
})

test('#2345 pending-bad 在 ALERT_CAUSES；之後 state 讀成功、貼文成功都不會自動清，--ack-alert pending-bad 才清', async () => {
  assert.ok(ALERT_CAUSES.includes('pending-bad'))
  const e = env({ desktopRows: [row('v0.2.99', 222)], linuxRows: [row('linux-v0.2.99', 333)], files: { [PENDING]: '{壞' } })
  await publishWithPostFailed(e)
  assert.equal(alertOf(e).alerts['pending-bad'].status, 'active')
  // 下一輪：state 讀成功（resolve bad-state）、Linux dry-run 失敗的回報貼成功（resolve post-failed）
  e.deps.spawn = () => ({ status: 1, stdout: '', stderr: '' })
  e.deps.asnCli = (args) => { e.calls.posts.push(args[args.indexOf('--body') + 1]); return { status: 0, stdout: '', stderr: '' } }
  e.clock.t = T0 + 120_000
  await runOnce(opts, e.deps)
  assert.ok(e.calls.posts.length >= 1, '這一輪有貼成功的訊息')
  assert.equal(alertOf(e).alerts['post-failed'].status, 'resolved')
  assert.equal(alertOf(e).alerts['pending-bad'].status, 'active')
  const res = await runCommand(parseArgs(['--ack-alert', 'pending-bad', '--state', STATE]), e.deps)
  assert.equal(res.code, 0)
  assert.equal(alertOf(e).alerts['pending-bad'].status, 'resolved')
})

test('#2345 ci-failed 的 run 沒有 commit：不寫佇列，也不放寬驗證', async () => {
  const m = quiet()
  const e = env({ desktopRows: [row('v0.2.99', 222, { conclusion: 'failure', headSha: undefined })] })
  postFails(e)
  await runOnce(opts, e.deps)
  assert.ok(!e.fsMap.has(PENDING))
  m.mock.restore()
})

test('#2345 STATE 路徑決定佇列位置：與 state 同資料夾', () => {
  assert.equal(pendingPathOf({ state: STATE }), PENDING)
})
