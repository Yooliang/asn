import test, { mock } from 'node:test'
import assert from 'node:assert/strict'
import { runOnce, WORKFLOWS } from '../../../tools/release/auto_publish.mjs'
import { PENDING_PLATFORMS, PENDING_KINDS, isSemver, isCommit, isPlatform, isKind, validateItem, buildItem, enqueuePending, readPending, pendingPathOf } from '../../../tools/release/post_pending.mjs'
import { env, row, sha, opts, STATE, T0, lk, alertOf, lastState, pendingOf, PENDING, publishWithPostFailed, markerOut } from './helpers/auto-publish-env.mjs'

const FIELDS = ['at', 'attempts', 'claimedAt', 'claimedBy', 'commit', 'createdAt', 'id', 'kind', 'lastError', 'platform', 'version']
const quiet = () => mock.method(console, 'warn', () => {})

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
  assert.equal(it.commit, sha(222))
  assert.match(it.commit, /^[0-9a-f]{40}$/)
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
  assert.equal(items.find((x) => x.platform === 'linux').commit, sha(333))
  assert.equal(items.find((x) => x.platform === 'desktop').commit, sha(222))
})

test('#2345 佇列檔損壞：不覆寫、改名保留、留 bad-state 告警；新的這筆仍寫進新檔', async () => {
  const e = env({ desktopRows: [row('v0.2.99', 222)], files: { [PENDING]: '{壞掉的內容' } })
  const r = await publishWithPostFailed(e)
  assert.equal(r.outcome, 'publish')
  const bad = [...e.fsMap.keys()].filter((k) => k.startsWith(`${PENDING}.bad-`))
  assert.equal(bad.length, 1)
  assert.equal(e.fsMap.get(bad[0]), '{壞掉的內容', '原內容原封不動留著')
  assert.equal(alertOf(e).alerts['bad-state'].status, 'active')
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

test('#2345 驗證函式：semver、40 位 hex、平台白名單、kind', () => {
  for (const v of ['0.2.99', '10.20.30', '0.2.99-rc.1', '1.0.0-beta']) assert.equal(isSemver(v), true, v)
  for (const v of ['0.2', 'v0.2.99', '0.2.99.1', '0.2.99-', '0.2.99 ', '', null, 5, '0.2.99\n--x']) assert.equal(isSemver(v), false, String(v))
  assert.equal(isCommit(sha(7)), true)
  for (const v of ['abc', 'A'.repeat(40), 'g'.repeat(40), `${sha(7)}0`, sha(7).slice(1), null]) assert.equal(isCommit(v), false, String(v))
  assert.equal(isPlatform('desktop'), true)
  assert.equal(isPlatform('linux'), true)
  for (const v of ['mac', 'Desktop', '', null]) assert.equal(isPlatform(v), false, String(v))
  assert.equal(isKind('published'), true)
  assert.equal(isKind('notice'), true)
  for (const v of ['other', '', null]) assert.equal(isKind(v), false, String(v))
})

test('#2345 平台白名單與常駐程式實際用到的平台一致', () => {
  assert.deepEqual([...PENDING_PLATFORMS].sort(), WORKFLOWS.map((w) => w.platform).sort())
  assert.deepEqual([...PENDING_KINDS].sort(), ['notice', 'published'])
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

test('#2345 讀佇列時多出 text、room 欄位：不採用（只留固定欄位）；欄位不合格的那筆丟掉', () => {
  const m = quiet()
  const ok = buildItem({ kind: 'published', platform: 'linux', version: '0.2.99', commit: sha(3) }, T0)
  const extra = { ...ok, id: 'linux@0.2.98#published', version: '0.2.98', text: '偷塞的文案', room: 'evil' }
  const e = env({ files: { [PENDING]: JSON.stringify({ v: 1, updatedAt: 'x', items: [ok, extra, { ...ok, commit: 'zz' }] }) } })
  const r = readPending(opts, e.deps)
  assert.equal(r.ok, true)
  assert.equal(r.items.length, 2)
  for (const it of r.items) assert.ok(!('text' in it) && !('room' in it) && Object.keys(it).sort().join() === FIELDS.join())
  m.mock.restore()
})

test('#2345 STATE 路徑決定佇列位置：與 state 同資料夾', () => {
  assert.equal(pendingPathOf({ state: STATE }), PENDING)
})
