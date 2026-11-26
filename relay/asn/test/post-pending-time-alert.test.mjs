// #2345 PR-2 一審修正：時間欄位不能在未來、告警的來源清單、舊告警訊息覆寫、寫佇列失敗的告警。
import test, { mock } from 'node:test'
import assert from 'node:assert/strict'
import { runOnce, makeAlerts } from '../../../tools/release/auto_publish.mjs'
import { PENDING_BAD_MESSAGE, PENDING_REJECTED_MESSAGE, PENDING_LOCK_BAD_MESSAGE, PENDING_FULL_MESSAGE, checkItem, buildItem, readPending, FUTURE_TIME_MS, MAX_ITEMS } from '../../../tools/release/post_pending.mjs'
import { EXPIRED_FIXED, BAD_CLAIM_FIXED, POST_FAILED_FIXED, PENDING_WRITE_FAILED_FIXED } from '../../../tools/release/post_pending_rules.mjs'
import { env, row, sha, opts, T0, postFails, alertOf, PENDING, ALERT } from './helpers/auto-publish-env.mjs'

const good = () => buildItem({ kind: 'published', platform: 'desktop', version: '0.2.99', commit: sha(1) }, T0)
const iso = (ms) => new Date(ms).toISOString()
const quiet = () => mock.method(console, 'warn', () => {})

test('#2345 PR-2 寫入端驗證：createdAt、claimedAt 比現在晚超過容許值整筆不合格，剛好在容許值內合格', () => {
  assert.equal(FUTURE_TIME_MS, 5 * 60 * 1000)
  assert.equal(checkItem(good(), { nowMs: T0 }).ok, true)
  const r1 = checkItem({ ...good(), createdAt: iso(T0 + FUTURE_TIME_MS + 1000) }, { nowMs: T0 })
  assert.deepEqual([r1.ok, r1.field], [false, 'createdAt'])
  assert.equal(checkItem({ ...good(), createdAt: iso(T0 + FUTURE_TIME_MS) }, { nowMs: T0 }).ok, true)
  const r2 = checkItem({ ...good(), claimedBy: 1, claimedAt: iso(T0 + FUTURE_TIME_MS + 1000) }, { nowMs: T0 })
  assert.deepEqual([r2.ok, r2.field], [false, 'claimedAt'])
  assert.equal(checkItem({ ...good(), claimedBy: 1, claimedAt: iso(T0 + FUTURE_TIME_MS) }, { nowMs: T0 }).ok, true)
  // 沒給現在時間就不比（只驗格式）
  assert.equal(checkItem({ ...good(), createdAt: iso(T0 + 10 * FUTURE_TIME_MS) }).ok, true)
})

test('#2345 PR-2 讀取端：createdAt 在未來整筆隔離並留 pending-bad；claimedAt 在未來不隔離（由代貼命令當認領逾時）', () => {
  const m = quiet()
  const bad = { ...good(), createdAt: iso(T0 + FUTURE_TIME_MS + 60_000) }
  const claimFuture = { ...good(), id: 'linux@0.2.99#published', platform: 'linux', claimedBy: 7, claimedAt: iso(T0 + FUTURE_TIME_MS + 60_000) }
  const e = env({ files: { [PENDING]: JSON.stringify({ v: 1, updatedAt: 'x', items: [bad, claimFuture] }) } })
  const r = readPending(opts, e.deps, () => {})
  assert.equal(r.ok, true)
  assert.deepEqual(r.items.map((x) => x.id), [claimFuture.id])
  assert.deepEqual(r.rejected, [bad])
  m.mock.restore()
})

test('#2345 PR-2 寫佇列失敗（佇列滿了）：post-failed 記來源不明、另留自己的 pending-write-failed 告警', async () => {
  const items = Array.from({ length: MAX_ITEMS }, (_, i) => buildItem({ kind: 'published', platform: 'desktop', version: `0.${i}.1`, commit: sha(i + 1) }, T0))
  const e = env({ desktopRows: [row('v0.2.99', 222, { conclusion: 'failure' })], files: { [PENDING]: JSON.stringify({ v: 1, updatedAt: 'x', items }) } })
  postFails(e)
  await runOnce(opts, e.deps)
  const a = alertOf(e).alerts
  assert.equal(a['post-failed'].status, 'active')
  assert.ok(a['post-failed'].refs.includes(null), '來源不明，--post-pending 清空佇列也不會把它清掉')
  assert.equal(a['pending-write-failed'].status, 'active')
  assert.equal(a['pending-write-failed'].message, PENDING_WRITE_FAILED_FIXED)
})

test('#2345 PR-2 寫佇列成功：post-failed 的來源是那一筆的平台@版號，沒有來源不明', async () => {
  const e = env({ desktopRows: [row('v0.2.99', 222, { conclusion: 'failure' })] })
  postFails(e)
  await runOnce(opts, e.deps)
  const a = alertOf(e).alerts
  assert.deepEqual(a['post-failed'].refs, ['desktop@0.2.99'])
  assert.equal(a['pending-write-failed'], undefined)
})

test('#2345 PR-2 升級前就存在的 post-failed：舊訊息直接覆寫成固定句，不往後接；新的同句不重複', () => {
  const legacy = '舊版訊息：【發版完成】v0.2.98：舊的原文'
  const e = env({ files: { [ALERT]: JSON.stringify({ updatedAt: 'x', alerts: { 'post-failed': { cause: 'post-failed', reason: 'post-failed', message: legacy, ref: 'desktop@0.2.98', firstAt: 'x', lastAt: 'x', count: 1, status: 'active' } } }) } })
  const al = makeAlerts(opts, e.deps)
  al.raiseAppend('post-failed', 'post-failed', POST_FAILED_FIXED, 'desktop@0.2.99')
  assert.equal(alertOf(e).alerts['post-failed'].message, POST_FAILED_FIXED)
  assert.ok(!alertOf(e).alerts['post-failed'].message.includes('舊'))
  al.raiseAppend('post-failed', 'post-failed', POST_FAILED_FIXED, 'linux@0.2.99')
  assert.equal(alertOf(e).alerts['post-failed'].message, POST_FAILED_FIXED)
  assert.deepEqual(alertOf(e).alerts['post-failed'].refs, [null, 'desktop@0.2.99', 'linux@0.2.99'], '舊告警沒有來源清單＝來源不明')
})

test('#2345 PR-2 pending-bad 累加不同的原因：每個原因一行固定句，同一原因重複只留一行，清掉後重新開始', () => {
  const e = env()
  const al = makeAlerts(opts, e.deps)
  const lines = [PENDING_BAD_MESSAGE, PENDING_REJECTED_MESSAGE, PENDING_LOCK_BAD_MESSAGE, PENDING_FULL_MESSAGE, EXPIRED_FIXED, BAD_CLAIM_FIXED]
  al.raiseLine('pending-bad', 'pending-bad', lines[0], 'post-pending')
  al.raiseLine('pending-bad', 'pending-bad', lines[1], 'post-pending')
  assert.deepEqual(alertOf(e).alerts['pending-bad'].message.split('\n'), [lines[0], lines[1]], '兩種原因兩行都在')
  al.raiseLine('pending-bad', 'pending-bad', lines[1], 'post-pending')
  al.raiseLine('pending-bad', 'pending-bad', lines[0], 'post-pending')
  assert.deepEqual(alertOf(e).alerts['pending-bad'].message.split('\n'), [lines[0], lines[1]], '同一原因重複只有一行')
  for (const l of lines) al.raiseLine('pending-bad', 'pending-bad', l, 'post-pending')
  assert.deepEqual(alertOf(e).alerts['pending-bad'].message.split('\n'), lines)
  assert.equal(alertOf(e).alerts['pending-bad'].status, 'active')
  al.resolve('pending-bad')
  al.raiseLine('pending-bad', 'pending-bad', lines[2], 'post-pending')
  assert.equal(alertOf(e).alerts['pending-bad'].message, lines[2], '清掉後重新開始')
})
