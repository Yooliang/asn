// #2345 PR-2：--post-pending 代貼子命令。外部呼叫（gh、asn-cli、檔案系統）全部是假的。
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import fs from 'node:fs'
import { parseArgs } from '../../../tools/release/auto_publish.mjs'
import { runPostPending } from '../../../tools/release/post_pending_cmd.mjs'
import { buildItem } from '../../../tools/release/post_pending.mjs'
import {
  SEND_TIMEOUT_MS, READ_TIMEOUT_MS, GH_TIMEOUT_MS, CLAIM_TIMEOUT_MS, WORST_CASE_ITEM_MS, MAX_AGE_MS, MAX_PER_RUN,
  POST_FAILED_FIXED, composeMessage, signatureOf, defaultConfigPath,
} from '../../../tools/release/post_pending_rules.mjs'
import { env, sha, opts, T0, PENDING, ALERT, alertOf, pendingOf } from './helpers/auto-publish-env.mjs'

const CFG = path.join('/cfg', 'post-room.json')
const HOUR = 3600_000
const full = (id) => sha(id) // 40 碼
const put = (e, items) => e.fsMap.set(PENDING, JSON.stringify({ v: 1, updatedAt: 'x', items }, null, 2))
const mk = (kind, platform, version, id, ageMs = HOUR, over = {}) => ({ ...buildItem({ kind, platform, version, commit: full(id) }, T0 - ageMs), ...over })

// 假的 GitHub：refs 是 標籤 → { type, sha }；annotated 是 tag 物件 sha → { type, sha }；releases 是 標籤 → release 內容
function fakeGh(e, { refs = {}, annotated = {}, releases = {} } = {}) {
  e.calls.ghPost = []
  e.deps.gh = (args) => {
    e.calls.ghPost.push(args)
    const joined = args.join(' ')
    let m
    if ((m = /git\/ref\/tags\/(\S+)$/.exec(joined))) return refs[m[1]] ? { status: 0, stdout: JSON.stringify({ object: refs[m[1]] }), stderr: '' } : { status: 1, stdout: '', stderr: 'nf' }
    if ((m = /git\/tags\/(\S+)$/.exec(joined))) return annotated[m[1]] ? { status: 0, stdout: JSON.stringify({ object: annotated[m[1]] }), stderr: '' } : { status: 1, stdout: '', stderr: 'nf' }
    if (args[0] === 'release' && args[1] === 'view') return releases[args[2]] ? { status: 0, stdout: JSON.stringify(releases[args[2]]), stderr: '' } : { status: 1, stdout: '', stderr: 'nf' }
    return { status: 1, stdout: '', stderr: 'unexpected' }
  }
}
const goodRelease = (platform, v, over = {}) => ({
  tagName: `v${v}`, isDraft: false, isPrerelease: false,
  assets: (platform === 'linux' ? [`ASN_${v}_amd64.AppImage`, `ASN_${v}_amd64.AppImage.sig`, `ASN_${v}_amd64.deb`] : [`ASN_${v}_x64-setup.exe`, `ASN_${v}_x64-setup.exe.sig`]).map((name) => ({ name })),
  ...over,
})
const tagOf = (it) => (it.platform === 'linux' ? `linux-v${it.version}` : `v${it.version}`)
// 每個項目預設：標籤指向它的 commit、Release 正常
function okGithub(e, items) {
  const refs = {}, releases = {}
  // 同一版的電腦版與 Linux 版共用同一個 Release（v<版號>），資產是兩個平台的合併
  for (const it of items) {
    refs[tagOf(it)] = { type: 'commit', sha: full(Number.parseInt(it.commit, 16)) }
    const prev = releases[`v${it.version}`]
    const mine = goodRelease(it.platform, it.version)
    releases[`v${it.version}`] = prev ? { ...mine, assets: [...prev.assets, ...mine.assets] } : mine
  }
  fakeGh(e, { refs, releases })
}
// 假的 asn-cli：讀群組回 rows（可依第幾次讀取給不同內容）、送出記錄下來
// 假的 --whoami 輸出（格式照 caller.rs 的 whoami）：節點 n、視窗名 a ＝ 群組裡的 from 是 n~a
const whoamiOut = (node = 'n', name = 'a') => ({ status: 0, stdout: `asn pid=9 ppid=8 platform=windows home=/h\nCLAUDE_CODE_MESSAGING_SOCKET=(未設)\n父行程鏈（由近到遠）：\n  pid=5 node  <== session「${name}」\n判定（行程鏈）：pid=5 name=${name}\n判定（環境變數備援）：無\n~/.claude/sessions：\n  pid=5 name=${name} kind=interactive entrypoint=cli\n機器節點判定：${node}\n`, stderr: '' })
const isWhoami = (args) => args[0] === 'send' && args.includes('--whoami')
const SELF = 'n~a'
// rows 的每一項是字串（自己發的）或 { body, from }（指定發言者）
function fakeCli(e, { rows = () => [], sendStatus = 0, who = whoamiOut() } = {}) {
  e.calls.reads = 0; e.calls.sends = []; e.calls.order = []; e.calls.readArgs = []; e.calls.whoami = 0
  e.deps.asnCli = (args) => {
    if (isWhoami(args)) { e.calls.whoami += 1; return who }
    if (args[0] === 'room') {
      e.calls.reads += 1; e.calls.order.push('read'); e.calls.readArgs.push(args)
      // 真實輸出（room.rs json_line）：每則一行 JSON 物件，沒有外層陣列；沒有訊息時輸出是空的
      const lines = rows(e.calls.reads).map((row, i) => JSON.stringify({ seq: i + 1, from: typeof row === 'string' ? SELF : row.from, from_name: '甲', trust: 'owner', at: '2026-11-21T10:00:00Z', mentions: [], body: typeof row === 'string' ? row : row.body }))
      return { status: 0, stdout: lines.length ? `${lines.join('\n')}\n` : '', stderr: '' }
    }
    e.calls.order.push('send'); e.calls.sends.push({ room: args[args.indexOf('--room') + 1], body: args[args.indexOf('--body') + 1] }); return { status: sendStatus, stdout: '', stderr: sendStatus ? '拒絕：/kick @all【發版完成】' : '' }
  }
}
function setup(items, { cfg = true } = {}) {
  const e = env()
  e.fsMap.set(CFG, JSON.stringify({ v: 1, room: 'room-a' }))
  if (!cfg) e.fsMap.delete(CFG)
  e.deps.postConfigPath = CFG
  put(e, items)
  okGithub(e, items)
  fakeCli(e)
  return e
}
const run = (e) => runPostPending(opts, e.deps)
// refs：告警記錄的來源（平台@版號；null＝來源不明，例如沒寫進佇列的失敗）
const raise = (e, status = 'active', refs = ['desktop@0.2.99']) => e.fsMap.set(ALERT, JSON.stringify({ updatedAt: 'x', alerts: { 'post-failed': { cause: 'post-failed', reason: 'post-failed', message: POST_FAILED_FIXED, ref: refs[0] ?? null, refs, firstAt: 'x', lastAt: 'x', count: 1, status } } }))
const ids = (e) => pendingOf(e).items.map((x) => x.id)

test('#2345 PR-2 成功：1 筆、GitHub 檢查過、群組沒有同則 → 送出 1 次、佇列清空、告警 resolved', () => {
  const items = [mk('published', 'desktop', '0.2.99', 1)]
  const e = setup(items); raise(e)
  const r = run(e)
  assert.equal(r.code, 0)
  assert.equal(e.calls.sends.length, 1)
  assert.equal(e.calls.sends[0].room, 'room-a')
  assert.equal(e.calls.sends[0].body, composeMessage(items[0]))
  assert.deepEqual(ids(e), [])
  assert.equal(alertOf(e).alerts['post-failed'].status, 'resolved')
})

test('#2345 PR-2 文案模板：平台顯示名由代貼端對照，各 kind 的開頭固定，結尾帶分隔符', () => {
  const c = (kind, platform) => composeMessage(mk(kind, platform, '0.2.99', 1))
  assert.match(c('published', 'desktop'), /^【發版完成】v0\.2\.99：電腦版已發佈，commit [0-9a-f]{8}。$/)
  assert.match(c('published', 'linux'), /^【Linux 版發版完成】v0\.2\.99：Linux 版已發佈，commit [0-9a-f]{8}。$/)
  assert.match(c('ci-failed', 'desktop'), /^【發版回報】電腦版 v0\.2\.99：打包流程沒有成功。commit [0-9a-f]{8}。$/)
  assert.match(c('blocked', 'linux'), /^【發版回報】Linux 版 v0\.2\.99：等人工處理，不會自動發佈。commit /)
  assert.match(c('dryrun-failed', 'desktop'), /試跑失敗，不會自動重試/)
  assert.match(c('publish-failed', 'desktop'), /正式發佈失敗，不會自動重試/)
  assert.notEqual(signatureOf(mk('published', 'desktop', '0.2.9', 1)), signatureOf(mk('published', 'desktop', '0.2.99', 1)))
  assert.ok(!composeMessage(mk('published', 'desktop', '0.2.99', 1)).startsWith(signatureOf(mk('published', 'desktop', '0.2.9', 1))), 'v0.2.9 不會誤認 v0.2.99')
})

for (const [name, mutate] of [
  ['tag 不在', (g, it) => { delete g.refs[tagOf(it)] }],
  ['Release 是草稿', (g, it) => { g.releases[`v${it.version}`].isDraft = true }],
  ['Release 是預發行', (g, it) => { g.releases[`v${it.version}`].isPrerelease = true }],
  ['Release 不存在', (g, it) => { delete g.releases[`v${it.version}`] }],
  ['tag 的 SHA 不符', (g, it) => { g.refs[tagOf(it)] = { type: 'commit', sha: 'f'.repeat(40) } }],
  ['資產不在', (g, it) => { g.releases[`v${it.version}`].assets.pop() }],
  ['tag 型別不認得', (g, it) => { g.refs[tagOf(it)] = { type: 'blob', sha: full(1) } }],
]) {
  for (const platform of ['desktop', 'linux']) {
    test(`#2345 PR-2 GitHub 檢查不過（${platform}：${name}）：不送、不清、attempts 加 1、告警維持 active`, () => {
      const it = mk('published', platform, '0.2.99', 1)
      const e = setup([it])
      const g = { refs: { [tagOf(it)]: { type: 'commit', sha: full(1) } }, annotated: {}, releases: { [`v${it.version}`]: goodRelease(platform, it.version) } }
      mutate(g, it); fakeGh(e, g)
      const r = run(e)
      assert.equal(r.code, 0)
      assert.equal(e.calls.sends.length, 0)
      const left = pendingOf(e).items
      assert.equal(left.length, 1)
      assert.equal(left[0].attempts, 1)
      assert.equal(left[0].claimedBy, null)
      assert.equal(typeof left[0].lastError, 'string')
      assert.equal(alertOf(e).alerts['post-failed'].status, 'active')
      assert.equal(alertOf(e).alerts['post-failed'].message, POST_FAILED_FIXED)
    })
  }
}

test('#2345 PR-2 註解標籤：多查一層 tag 物件才拿到 commit；輕量標籤直接就是 commit', () => {
  const it = mk('published', 'desktop', '0.2.99', 1)
  const e = setup([it])
  fakeGh(e, { refs: { 'v0.2.99': { type: 'tag', sha: 'a'.repeat(40) } }, annotated: { ['a'.repeat(40)]: { type: 'commit', sha: full(1) } }, releases: { 'v0.2.99': goodRelease('desktop', '0.2.99') } })
  run(e)
  assert.equal(e.calls.sends.length, 1)
  assert.ok(e.calls.ghPost.some((a) => a.join(' ').includes(`git/tags/${'a'.repeat(40)}`)), '有查 tag 物件')
  // 輕量標籤
  const e2 = setup([mk('published', 'desktop', '0.2.99', 1)])
  run(e2)
  assert.equal(e2.calls.sends.length, 1)
  assert.ok(!e2.calls.ghPost.some((a) => a.join(' ').includes('git/tags/')), '輕量標籤不查 tag 物件')
})

test('#2345 PR-2 倉庫寫死 Yooliang/asn：每個 gh 呼叫都指向它，不受環境變數影響', () => {
  const old = process.env.GITHUB_REPOSITORY, old2 = process.env.GH_REPO
  process.env.GITHUB_REPOSITORY = 'evil/repo'; process.env.GH_REPO = 'evil/repo'
  try {
    const e = setup([mk('published', 'linux', '0.2.99', 1)])
    run(e)
    assert.ok(e.calls.ghPost.length >= 2)
    for (const a of e.calls.ghPost) assert.ok(a.join(' ').includes('Yooliang/asn') && !a.join(' ').includes('evil'), a.join(' '))
  } finally {
    if (old === undefined) delete process.env.GITHUB_REPOSITORY; else process.env.GITHUB_REPOSITORY = old
    if (old2 === undefined) delete process.env.GH_REPO; else process.env.GH_REPO = old2
  }
})

test('#2345 PR-2 註解標籤指到的不是 commit（再包一層 tag）或 tag 物件的 SHA 對不上：不貼', () => {
  for (const inner of [{ type: 'tag', sha: full(1) }, { type: 'commit', sha: 'f'.repeat(40) }, null]) {
    const e = setup([mk('published', 'desktop', '0.2.99', 1)])
    fakeGh(e, { refs: { 'v0.2.99': { type: 'tag', sha: 'a'.repeat(40) } }, annotated: inner ? { ['a'.repeat(40)]: inner } : {}, releases: { 'v0.2.99': goodRelease('desktop', '0.2.99') } })
    run(e)
    assert.equal(e.calls.sends.length, 0)
    assert.equal(pendingOf(e).items[0].attempts, 1)
  }
})

test('#2345 PR-2 失敗回報類只確認標籤與 commit（那一版本來就沒有 Release），通過就貼', () => {
  const it = mk('ci-failed', 'desktop', '0.2.99', 1)
  const e = setup([it])
  fakeGh(e, { refs: { 'v0.2.99': { type: 'commit', sha: full(1) } } })
  run(e)
  assert.equal(e.calls.sends.length, 1)
  assert.deepEqual(ids(e), [])
})

test('#2345 PR-2 冪等：送出前群組已有同平台同版號那則 → 不送、不查 GitHub、只清待貼', () => {
  const it = mk('published', 'desktop', '0.2.99', 1)
  const e = setup([it]); raise(e)
  fakeCli(e, { rows: () => ['別的訊息', `${composeMessage(it)} 人工補貼的也行`] })   // 自己發的、開頭整段相符
  run(e)
  assert.equal(e.calls.sends.length, 0)
  assert.deepEqual(ids(e), [])
  assert.equal(alertOf(e).alerts['post-failed'].status, 'resolved')
})

test('#2345 PR-2 讀群組的命令列：照 room.rs 的參數名（room --room-read <代號> --last 200 --json），群組代號取自設定檔', () => {
  const it = mk('published', 'desktop', '0.2.99', 1)
  const e = setup([it])
  run(e)
  assert.deepEqual(e.calls.readArgs[0], ['room', '--room-read', 'room-a', '--last', '200', '--json'])
})

test('#2345 PR-2 群組讀回來是空的（真實格式：沒有訊息時輸出為空）：視為沒貼過，照送', () => {
  const e = setup([mk('published', 'desktop', '0.2.99', 1)])
  fakeCli(e, { rows: () => [] })
  run(e)
  assert.equal(e.calls.sends.length, 1)
})

test('#2345 PR-2 冪等：認領後、送出前才出現同則（第二次讀才有）→ 不送，只清', () => {
  const it = mk('published', 'linux', '0.2.99', 1)
  const e = setup([it])
  fakeCli(e, { rows: (n) => (n >= 2 ? [composeMessage(it)] : []) })
  run(e)
  assert.equal(e.calls.reads, 2)
  assert.equal(e.calls.sends.length, 0)
  assert.deepEqual(ids(e), [])
})

test('#2345 PR-2 讀不到群組內容：不送、attempts 加 1（不能確認有沒有貼過就不貼）', () => {
  const it = mk('published', 'desktop', '0.2.99', 1)
  const e = setup([it])
  e.deps.asnCli = (args) => (isWhoami(args) ? whoamiOut() : args[0] === 'room' ? { status: 1, stdout: '', stderr: 'x' } : (e.calls.sends.push(args), { status: 0 }))
  e.calls.sends = []
  run(e)
  assert.equal(e.calls.sends.length, 0)
  assert.equal(pendingOf(e).items[0].attempts, 1)
  // 不是真實格式（外層陣列、外層物件、缺 body、混進非 JSON 的行）一律當讀不到
  for (const stdout of ['不是 JSON', '{"x":1}', '[{"seq":1,"body":"x"}]', '{"messages":[{"body":"x"}]}', '{"seq":1,"body":"x"}\n壞行\n']) {
    const e2 = setup([it]); e2.deps.asnCli = (args) => (isWhoami(args) ? whoamiOut() : args[0] === 'room' ? { status: 0, stdout, stderr: '' } : (e2.calls.sends = [1], { status: 0 }))
    e2.calls.sends = []; run(e2)
    assert.equal(e2.calls.sends.length, 0)
  }
})

test('#2345 PR-2 超過 48 小時：不貼、移到 .expired 檔、記 warn 並發告警；剛好在期限內的照貼', () => {
  const old = mk('published', 'desktop', '0.2.98', 1, MAX_AGE_MS + 1000)
  const fresh = mk('published', 'desktop', '0.2.99', 2, MAX_AGE_MS - 1000)
  const e = setup([old, fresh])
  const r = run(e)
  assert.equal(e.calls.sends.length, 1)
  assert.ok(e.calls.sends[0].body.includes('v0.2.99') && !e.calls.sends[0].body.includes('v0.2.98'))
  assert.deepEqual(ids(e), [])
  const expiredFile = [...e.fsMap.keys()].find((k) => k.includes('post-pending.json.expired-'))
  assert.ok(expiredFile, '有 .expired 檔')
  assert.deepEqual(JSON.parse(e.fsMap.get(expiredFile)).items.map((x) => x.id), [old.id])
  assert.equal(alertOf(e).alerts['pending-bad'].status, 'active')
  assert.ok(e.calls.logs.some((l) => l.includes('超過期限')))
  assert.ok(r.lines.some((l) => l.includes('超過 48 小時')))
})

test('#2345 PR-2 一次 6 筆：只處理 4 筆（由舊到新），剩下 2 筆留到下次，告警維持', () => {
  const items = [1, 2, 3, 4, 5, 6].map((n) => mk('published', 'desktop', `0.2.${90 + n}`, n, (10 - n) * 60_000))
  const e = setup(items); raise(e, 'active', items.map((x) => `${x.platform}@${x.version}`))
  // createdAt 越小越舊：n=1 最舊
  run(e)
  assert.equal(MAX_PER_RUN, 4)
  assert.equal(e.calls.sends.length, 4)
  assert.deepEqual(e.calls.sends.map((s) => /v(0\.2\.\d+)/.exec(s.body)[1]), ['0.2.91', '0.2.92', '0.2.93', '0.2.94'])
  assert.deepEqual(ids(e).sort(), ['desktop@0.2.95#published', 'desktop@0.2.96#published'])
  assert.equal(alertOf(e).alerts['post-failed'].status, 'active')
  run(e)
  assert.deepEqual(ids(e), [])
  assert.equal(alertOf(e).alerts['post-failed'].status, 'resolved')
})

test('#2345 PR-2 別人的認領還沒逾時 → 略過那一筆（不貼、不動、告警維持）', () => {
  const it = mk('published', 'desktop', '0.2.99', 1, HOUR, { claimedBy: 999, claimedAt: new Date(T0 - CLAIM_TIMEOUT_MS + 60_000).toISOString() })
  const e = setup([it]); raise(e)
  run(e)
  assert.equal(e.calls.sends.length, 0)
  assert.equal(e.calls.reads, 0)
  assert.deepEqual(pendingOf(e).items[0].claimedBy, 999)
  assert.equal(alertOf(e).alerts['post-failed'].status, 'active')
})

test('#2345 PR-2 別人的認領已逾時 → 接手，而且送出前一定先讀群組比對；群組已有就不送', () => {
  const it = mk('published', 'desktop', '0.2.99', 1, HOUR, { claimedBy: 999, claimedAt: new Date(T0 - CLAIM_TIMEOUT_MS - 1000).toISOString() })
  const e = setup([it])
  run(e)
  assert.deepEqual(e.calls.order, ['read', 'read', 'send'], '送出前讀過群組')
  const e2 = setup([it])
  fakeCli(e2, { rows: () => [composeMessage(it)] })
  run(e2)
  assert.equal(e2.calls.sends.length, 0)
  assert.deepEqual(ids(e2), [])
})

test('#2345 PR-2 認領逾時必須大於送出逾時，也大於一筆最壞的總耗時', () => {
  assert.ok(CLAIM_TIMEOUT_MS > SEND_TIMEOUT_MS)
  assert.ok(CLAIM_TIMEOUT_MS > WORST_CASE_ITEM_MS)
  assert.ok(WORST_CASE_ITEM_MS >= SEND_TIMEOUT_MS + 2 * READ_TIMEOUT_MS)
  assert.equal(SEND_TIMEOUT_MS, 120_000)
  assert.equal(CLAIM_TIMEOUT_MS, 600_000)
  assert.equal(GH_TIMEOUT_MS, 30_000)
  assert.equal(MAX_AGE_MS, 48 * HOUR)
})

test('#2345 PR-2 認領時寫進自己的 pid 與時間；貼的當下佇列檔裡看得到', () => {
  const it = mk('published', 'desktop', '0.2.99', 1)
  const e = setup([it])
  let seen = null
  const base = e.deps.asnCli
  e.deps.asnCli = (args) => { if (args[0] === 'send') seen = pendingOf(e).items[0]; return base(args) }
  run(e)
  assert.equal(seen.claimedBy, 4242)
  assert.equal(seen.claimedAt, new Date(T0).toISOString())
})

test('#2345 PR-2 送出失敗：項目留著、attempts 加 1、lastError 經過清洗（不含群組指令字樣與控制字元）、告警維持 active', () => {
  const it = mk('published', 'desktop', '0.2.99', 1)
  const e = setup([it])
  fakeCli(e, { sendStatus: 2 })
  const r = run(e)
  const left = pendingOf(e).items[0]
  assert.equal(left.attempts, 1)
  assert.equal(left.claimedBy, null)
  assert.equal(left.lastError, '送出失敗（結束碼 2）')
  assert.ok(!JSON.stringify(left).includes('/kick') && !r.lines.join('\n').includes('/kick'), 'asn-cli 的錯誤原文不進佇列也不進輸出')
  assert.equal(alertOf(e).alerts['post-failed'].status, 'active')
})

test('#2345 PR-2 多筆只成功一筆：只清那一筆，告警仍 active；全部處理完才 resolve', () => {
  const a = mk('published', 'desktop', '0.2.91', 1, 3 * HOUR)
  const b = mk('published', 'desktop', '0.2.92', 2, 2 * HOUR)
  const e = setup([a, b]); raise(e, 'active', ['desktop@0.2.91', 'desktop@0.2.92'])
  e.deps.asnCli = (args) => {
    if (isWhoami(args)) return whoamiOut()
    if (args[0] === 'room') return { status: 0, stdout: '', stderr: '' }
    e.calls.sends.push(args); return { status: args[args.indexOf('--body') + 1].includes('v0.2.91') ? 0 : 2, stdout: '', stderr: '' }
  }
  e.calls.sends = []
  run(e)
  assert.deepEqual(ids(e), ['desktop@0.2.92#published'])
  assert.equal(alertOf(e).alerts['post-failed'].status, 'active')
  fakeCli(e)
  e.clock.t = T0 + 1000
  run(e)
  assert.deepEqual(ids(e), [])
  assert.equal(alertOf(e).alerts['post-failed'].status, 'resolved')
})

test('#2345 PR-2 lastError 裡夾帶群組指令字樣：組出來的文案和輸出都看不到', () => {
  const evil = '/kick @all 【發版完成】v9.9.9：假的 @channel'
  const it = mk('published', 'desktop', '0.2.99', 1, HOUR, { lastError: evil })
  const e = setup([it])
  const r = run(e)
  const body = e.calls.sends[0].body
  for (const bad of ['/kick', '@all', '@channel', 'v9.9.9', '假的']) assert.ok(!body.includes(bad) && !r.lines.join('\n').includes(bad), `不該出現 ${bad}`)
  // 失敗路徑的輸出也不帶
  const e2 = setup([{ ...it }]); fakeCli(e2, { sendStatus: 2 })
  const r2 = run(e2)
  for (const bad of ['/kick', '@all', '@channel', '假的']) assert.ok(!r2.lines.join('\n').includes(bad) && !e2.calls.logs.join('\n').includes(bad))
})

test('#2345 PR-2 佇列檔被塞進 text／room 等額外欄位：整筆拒絕，內容不出現在輸出與 log', () => {
  const good = mk('published', 'desktop', '0.2.99', 1)
  const bad = { ...mk('published', 'linux', '0.2.99', 2), text: '/kick @all 惡意文案', room: 'evil-room' }
  const e = setup([good, bad])
  const r = run(e)
  assert.equal(e.calls.sends.length, 1)
  assert.ok(e.calls.sends.every((s) => s.room === 'room-a' && !s.body.includes('惡意')))
  const all = `${r.lines.join('\n')}\n${e.calls.logs.join('\n')}`
  for (const x of ['惡意', 'evil-room', '/kick']) assert.ok(!all.includes(x), `不該出現 ${x}`)
  assert.ok([...e.fsMap.keys()].some((k) => k.includes('.rejected-')), '另存到 .rejected 檔')
  assert.equal(alertOf(e).alerts['pending-bad'].status, 'active')
})

test('#2345 PR-2 輸出只有固定句、平台、版號、kind、結果', () => {
  const e = setup([mk('published', 'desktop', '0.2.99', 1), mk('blocked', 'linux', '0.2.99', 2)])
  const r = run(e)
  assert.deepEqual(r.lines, ['電腦版 v0.2.99 已發佈通知：已貼到群組', 'Linux 版 v0.2.99 等人工處理回報：已貼到群組'])
})

test('#2345 PR-2 parseArgs：--post-pending 搭配 --room（不論順序）報錯；不和其他子命令混用', () => {
  assert.match(parseArgs(['--post-pending', '--room', 'x']).error, /--post-pending 不接受 --room/)
  assert.match(parseArgs(['--room', 'x', '--post-pending']).error, /--post-pending 不接受 --room/)
  assert.equal(parseArgs(['--post-pending']).error, null)
  assert.equal(parseArgs(['--post-pending', '--state', '/w/state.json']).error, null)
  assert.equal(parseArgs(['--post-pending']).postPending, true)
  for (const extra of [['--ack', 'desktop@0.2.1'], ['--once'], ['--yes'], ['--dry-run-only'], ['--ack-alert', 'post-failed'], ['--seed', '0.2.1']]) assert.ok(parseArgs(['--post-pending', ...extra]).error, extra.join(' '))
  assert.equal(parseArgs(['--room', 'x']).error, null, '常駐程式自己的 --room 照舊')
})

test('#2345 PR-2 群組設定檔不存在：不貼，輸出白話說明怎麼設定', () => {
  const e = setup([mk('published', 'desktop', '0.2.99', 1)], { cfg: false })
  const r = run(e)
  assert.equal(r.code, 2)
  assert.equal(e.calls.sends.length, 0)
  assert.equal(e.calls.reads, 0)
  assert.equal(r.lines.length, 1)
  assert.ok(r.lines[0].includes('還沒有設定要貼的群組') && r.lines[0].includes(CFG) && r.lines[0].includes('"room"'))
  assert.equal(pendingOf(e).items.length, 1, '佇列不動')
})

test('#2345 PR-2 群組設定檔格式不對（多欄位、room 含怪字、不是 JSON、太大）或放在待貼檔同資料夾：不貼', () => {
  const bads = [
    JSON.stringify({ v: 1, room: 'a', extra: 1 }), JSON.stringify({ v: 2, room: 'a' }), JSON.stringify({ v: 1, room: 'a b;/kick' }),
    JSON.stringify({ v: 1, room: '' }), JSON.stringify({ v: 1, room: 5 }), '不是JSON', JSON.stringify({ v: 1, room: 'a', pad: 'x'.repeat(2000) }), '[]',
  ]
  for (const text of bads) {
    const e = setup([mk('published', 'desktop', '0.2.99', 1)]); e.fsMap.set(CFG, text)
    const r = run(e)
    assert.equal(r.code, 2, text.slice(0, 30))
    assert.equal(e.calls.sends.length, 0)
    assert.ok(r.lines[0].includes(CFG))
    assert.ok(!r.lines[0].includes('/kick'))
  }
  const e = setup([mk('published', 'desktop', '0.2.99', 1)])
  const same = path.join(path.dirname(PENDING), 'post-room.json')
  e.fsMap.set(same, JSON.stringify({ v: 1, room: 'room-a' })); e.deps.postConfigPath = same
  const r = run(e)
  assert.equal(r.code, 2)
  assert.equal(e.calls.sends.length, 0)
  assert.ok(r.lines[0].includes('不能和待貼佇列放在同一個資料夾'))
})

test('#2345 PR-2 預設設定檔位置：只有 LOCALAPPDATA 底下的 asn-post-config，不在 ~/.asn，也不在待貼檔的資料夾', () => {
  const p = defaultConfigPath({ LOCALAPPDATA: path.join('/home', 'u', 'Local') })
  assert.equal(p, path.join('/home', 'u', 'Local', 'asn-post-config', 'post-room.json'))
  assert.ok(!p.includes(`${path.sep}.asn${path.sep}`))
  assert.equal(defaultConfigPath({}), null)
  assert.equal(defaultConfigPath({ LOCALAPPDATA: '', HOME: '/home/u', USERPROFILE: '/home/u' }), null)
})

test('#2345 PR-2 沒有 LOCALAPPDATA：就算家目錄底下有同名的檔也不讀，不貼，白話說明原因', () => {
  const e = setup([mk('published', 'desktop', '0.2.99', 1)])
  e.deps.postConfigPath = undefined
  e.deps.env = { HOME: '/home/u', USERPROFILE: '/home/u' }
  const home = path.join('/home/u', 'asn-post-config', 'post-room.json')
  e.fsMap.set(home, JSON.stringify({ v: 1, room: 'room-a' }))
  const readPaths = []
  const baseRead = e.deps.readFile
  e.deps.readFile = (p) => { readPaths.push(p); return baseRead(p) }
  const r = run(e)
  assert.equal(r.code, 2)
  assert.equal(e.calls.sends.length, 0)
  assert.equal(e.calls.reads, 0)
  assert.ok(!readPaths.some((p) => p.includes('asn-post-config')), '沒有去讀任何設定檔')
  assert.ok(r.lines[0].includes('LOCALAPPDATA') && r.lines[0].includes('不貼'))
  assert.equal(pendingOf(e).items.length, 1)
})

test('#2345 PR-2 有 LOCALAPPDATA 時讀的就是它底下的設定檔', () => {
  const e = setup([mk('published', 'desktop', '0.2.99', 1)])
  e.deps.postConfigPath = undefined
  e.deps.env = { LOCALAPPDATA: path.join('/home', 'u', 'Local') }
  e.fsMap.set(path.join('/home', 'u', 'Local', 'asn-post-config', 'post-room.json'), JSON.stringify({ v: 1, room: 'from-local' }))
  run(e)
  assert.equal(e.calls.sends[0].room, 'from-local')
})

test('#2345 PR-2 待貼鎖被佔用：不動佇列、不貼', () => {
  const it = mk('published', 'desktop', '0.2.99', 1)
  const e = setup([it])
  e.fsMap.set(`${PENDING}.lock`, `777\n${T0 - 1000}`)
  e.deps.pidAlive = (p) => p === 777
  const r = run(e)
  assert.equal(r.code, 3)
  assert.equal(e.calls.sends.length, 0)
})

test('#2345 PR-2 運行手冊：寫明發版收尾由發版視窗跑 --post-pending、要從乾淨的 main 簽出，沒有「照原文貼」的寫法', () => {
  const doc = fs.readFileSync(new URL('../../../docs/release/自動發佈運行手冊.md', import.meta.url), 'utf8')
  assert.ok(doc.includes('--post-pending') && doc.includes('乾淨的 main') && doc.includes('發版視窗'))
  assert.ok(!doc.includes('照貼到群組') && !doc.includes('照原文貼') && !doc.includes('人工補貼這則原文'))
  assert.ok(doc.includes(POST_FAILED_FIXED), '手冊引用的告警固定句與程式一致')
})

test('#2345 PR-2 佇列是空的、這一輪沒貼也沒清任何一筆：告警維持 active（空佇列不等於已恢復）', () => {
  const e = setup([]); raise(e)
  const r = run(e)
  assert.equal(r.code, 0)
  assert.equal(e.calls.sends.length, 0)
  assert.equal(alertOf(e).alerts['post-failed'].status, 'active')
})

test('#2345 PR-2 有一筆沒進佇列的 post-failed（來源不明）＋佇列裡一筆送成功、佇列空了：告警仍然亮著', () => {
  const e = setup([mk('published', 'desktop', '0.2.99', 1)])
  raise(e, 'active', ['desktop@0.2.99', null])
  run(e)
  assert.equal(e.calls.sends.length, 1)
  assert.deepEqual(ids(e), [])
  assert.equal(alertOf(e).alerts['post-failed'].status, 'active')
  assert.deepEqual(alertOf(e).alerts['post-failed'].refs, [null], '處理完的來源被拿掉，來源不明的留著')
})

test('#2345 PR-2 告警記的另一個來源這一輪沒處理到（例如已逾期被移走）：貼成功也不清告警；舊告警檔沒有來源清單也不自動清', () => {
  const old = mk('published', 'desktop', '0.2.98', 1, MAX_AGE_MS + 1000)
  const e = setup([old, mk('published', 'desktop', '0.2.99', 2)])
  raise(e, 'active', ['desktop@0.2.98', 'desktop@0.2.99'])
  run(e)
  assert.deepEqual(ids(e), [])
  assert.equal(alertOf(e).alerts['post-failed'].status, 'active')
  const e2 = setup([mk('published', 'desktop', '0.2.99', 1)])
  e2.fsMap.set(ALERT, JSON.stringify({ updatedAt: 'x', alerts: { 'post-failed': { cause: 'post-failed', reason: 'post-failed', message: POST_FAILED_FIXED, ref: 'desktop@0.2.99', firstAt: 'x', lastAt: 'x', count: 1, status: 'active' } } }))
  run(e2)
  assert.equal(alertOf(e2).alerts['post-failed'].status, 'active')
})

test('#2345 PR-2 一輪貼成一個來源、另一個失敗：只把貼成的來源從告警拿掉，告警維持 active', () => {
  const a = mk('published', 'desktop', '0.2.91', 1, 3 * HOUR)
  const b = mk('published', 'desktop', '0.2.92', 2, 2 * HOUR)
  const e = setup([a, b]); raise(e, 'active', ['desktop@0.2.91', 'desktop@0.2.92'])
  e.deps.asnCli = (args) => {
    if (isWhoami(args)) return whoamiOut()
    if (args[0] === 'room') return { status: 0, stdout: '', stderr: '' }
    return { status: args[args.indexOf('--body') + 1].includes('v0.2.91') ? 0 : 2, stdout: '', stderr: '' }
  }
  run(e)
  assert.deepEqual(alertOf(e).alerts['post-failed'].refs, ['desktop@0.2.92'])
  assert.equal(alertOf(e).alerts['post-failed'].status, 'active')
})

// ---- 冪等只認自己的身分、開頭整段相符
test('#2345 PR-2 別人的訊息含有同一句簽名（甚至整句一樣）：不算已貼，照送', () => {
  const it = mk('published', 'desktop', '0.2.99', 1)
  const e = setup([it]); raise(e)
  fakeCli(e, { rows: () => [{ body: composeMessage(it), from: 'x~別人' }, { body: composeMessage(it), from: 'n~b' }, { body: composeMessage(it), from: 'm~a' }] })
  run(e)
  assert.equal(e.calls.sends.length, 1)
  assert.deepEqual(ids(e), [])
})

test('#2345 PR-2 自己的訊息：開頭完全相同才算已貼；簽名出現在中間、只有簽名開頭但 commit 不同，都不算', () => {
  const it = mk('published', 'desktop', '0.2.99', 1)
  const cases = [
    [`${composeMessage(it)}後面再接別的`, 0],
    [`前面多一句 ${composeMessage(it)}`, 1],
    [signatureOf(it), 1],
    [composeMessage(mk('published', 'desktop', '0.2.99', 2)), 1],
    [composeMessage(mk('published', 'desktop', '0.2.98', 1)), 1],
    [composeMessage(mk('published', 'linux', '0.2.99', 1)), 1],
  ]
  for (const [body, sends] of cases) {
    const e = setup([it])
    fakeCli(e, { rows: () => [body] })
    run(e)
    assert.equal(e.calls.sends.length, sends, body)
  }
  // 失敗回報類同樣：同版號但 commit 不同不算已貼
  const f = mk('ci-failed', 'desktop', '0.2.99', 1)
  const e2 = setup([f]); fakeCli(e2, { rows: () => [composeMessage(mk('ci-failed', 'desktop', '0.2.99', 2))] })
  run(e2)
  assert.equal(e2.calls.sends.length, 1)
  const e3 = setup([f]); fakeCli(e3, { rows: () => [composeMessage(f)] })
  run(e3)
  assert.equal(e3.calls.sends.length, 0)
})

test('#2345 PR-2 舊版發版腳本貼的開頭照舊認得（電腦版要 commit 前 8 碼相符；Linux 舊文沒有 commit）', () => {
  const it = mk('published', 'desktop', '0.2.99', 1)
  const oldDesktop = (commit) => `【發版完成】v0.2.99：安裝檔已發 GitHub Release、官網已部署並線上核對通過、官網版本紀錄已寫入（平台：desktop）。commit ${commit}。接著提交兩個網站檔回 main。`
  const same = setup([it]); fakeCli(same, { rows: () => [oldDesktop(full(1))] }); run(same)
  assert.equal(same.calls.sends.length, 0, '舊文的 commit 是完整 SHA，前 8 碼相符就算已貼')
  assert.deepEqual(ids(same), [])
  const diff = setup([it]); fakeCli(diff, { rows: () => [oldDesktop(full(2))] }); run(diff)
  assert.equal(diff.calls.sends.length, 1, 'commit 不同不算')
  const li = mk('published', 'linux', '0.2.99', 1)
  const oldLinux = '【Linux 版發版完成】v0.2.99：AppImage、deb 已附加到 GitHub Release v0.2.99、官網 latest.json 已加 linux、首頁已加 Linux 下載連結，部署與線上核對通過，網站檔已提交回 main。'
  const l = setup([li]); fakeCli(l, { rows: () => [oldLinux] }); run(l)
  assert.equal(l.calls.sends.length, 0)
  const other = setup([li]); fakeCli(other, { rows: () => [{ body: oldLinux, from: 'x~別人' }] }); run(other)
  assert.equal(other.calls.sends.length, 1, '別人貼的舊文也不算')
})

test('#2345 PR-2 自己的身分：用 send --whoami 取得，讀群組每則的 from 是 節點~視窗名；拿不到就不送', () => {
  const it = mk('published', 'desktop', '0.2.99', 1)
  const e = setup([it])
  fakeCli(e, { who: whoamiOut('節點X', '視窗Y'), rows: () => [{ body: composeMessage(it), from: '節點X~視窗Y' }] })
  run(e)
  assert.equal(e.calls.sends.length, 0)
  assert.equal(e.calls.whoami, 1, '整輪只查一次')
  // 行程鏈判不到時改用環境變數備援那一行
  const env2 = setup([it])
  fakeCli(env2, { who: { status: 0, stdout: '判定（行程鏈）：無\n判定（環境變數備援）：pid=5 name=視窗Z\n機器節點判定：N\n', stderr: '' }, rows: () => [{ body: composeMessage(it), from: 'N~視窗Z' }] })
  run(env2)
  assert.equal(env2.calls.sends.length, 0)
  for (const who of [
    { status: 1, stdout: '', stderr: 'x' },
    { status: 0, stdout: '', stderr: '' },
    { status: 0, stdout: '判定（行程鏈）：無\n判定（環境變數備援）：無\n機器節點判定：N\n', stderr: '' },
    { status: 0, stdout: '判定（行程鏈）：pid=5 name=(無名)\n機器節點判定：N\n', stderr: '' },
    { status: 0, stdout: '判定（行程鏈）：pid=5 name=甲\n機器節點判定失敗：x\n', stderr: '' },
    { status: 0, stdout: '判定（行程鏈）：pid=5 name=甲\n機器節點判定：N~M\n', stderr: '' },
  ]) {
    const e3 = setup([it]); fakeCli(e3, { who })
    run(e3)
    assert.equal(e3.calls.sends.length, 0, JSON.stringify(who))
    assert.equal(pendingOf(e3).items[0].attempts, 1)
    assert.equal(alertOf(e3).alerts['post-failed'].status, 'active')
  }
})

// ---- 時間在未來
test('#2345 PR-2 createdAt 在未來：整筆隔離、不貼、發 pending-bad 告警', () => {
  const it = mk('published', 'desktop', '0.2.99', 1, -(5 * 60_000 + 60_000))
  const e = setup([it])
  run(e)
  assert.equal(e.calls.sends.length, 0)
  assert.deepEqual(ids(e), [])
  assert.ok([...e.fsMap.keys()].some((k) => k.includes('.rejected-')))
  assert.equal(alertOf(e).alerts['pending-bad'].status, 'active')
})

test('#2345 PR-2 claimedAt 在未來：不會永遠被當成別人在處理，當成認領逾時；接手前先比對群組、發 pending-bad 告警', () => {
  const claimedAt = new Date(T0 + 5 * 60_000 + 60_000).toISOString()
  const it = mk('published', 'desktop', '0.2.99', 1, HOUR, { claimedBy: 999, claimedAt })
  const e = setup([it])
  const r = run(e)
  assert.deepEqual(e.calls.order, ['read', 'read', 'send'], '先比對群組才接手')
  assert.ok(!r.lines.some((l) => l.includes('別人正在處理')))
  assert.deepEqual(ids(e), [])
  assert.equal(alertOf(e).alerts['pending-bad'].status, 'active')
  // 群組已經有就只清
  const e2 = setup([it]); fakeCli(e2, { rows: () => [composeMessage(it)] })
  run(e2)
  assert.equal(e2.calls.sends.length, 0)
  assert.deepEqual(ids(e2), [])
  // 容許值內的未來時間（時鐘稍有誤差）仍算有效的認領
  const near = mk('published', 'desktop', '0.2.99', 1, HOUR, { claimedBy: 999, claimedAt: new Date(T0 + 60_000).toISOString() })
  const e3 = setup([near]); run(e3)
  assert.equal(e3.calls.sends.length, 0)
  assert.equal(pendingOf(e3).items[0].claimedBy, 999)
})

// ---- 小地方
test('#2345 PR-2 貼完但待貼檔沒更新成：輸出固定句、那筆不算處理完、告警維持 active', () => {
  const it = mk('published', 'desktop', '0.2.99', 1)
  const e = setup([it]); raise(e)
  const base = e.deps.asnCli
  e.deps.asnCli = (args) => {
    const r = base(args)
    if (args[0] === 'send' && !isWhoami(args)) { e.fsMap.set(`${PENDING}.lock`, `777\n${T0 - 1000}`); e.deps.pidAlive = (p) => p === 777 }
    return r
  }
  const r = run(e)
  assert.equal(e.calls.sends.length, 1)
  assert.ok(r.lines.includes('電腦版 v0.2.99 已發佈通知：已貼，但待貼檔沒更新'), r.lines.join('|'))
  assert.equal(pendingOf(e).items.length, 1)
  assert.equal(alertOf(e).alerts['post-failed'].status, 'active')
})

test('#2345 PR-2 群組設定檔：代號第一個字要是英數；超過大小先用 stat 擋、不讀內容', () => {
  for (const room of ['-abc', '_abc']) {
    const e = setup([mk('published', 'desktop', '0.2.99', 1)]); e.fsMap.set(CFG, JSON.stringify({ v: 1, room }))
    assert.equal(run(e).code, 2, room)
    assert.equal(e.calls.sends.length, 0)
  }
  const ok = setup([mk('published', 'desktop', '0.2.99', 1)]); ok.fsMap.set(CFG, JSON.stringify({ v: 1, room: 'a-b_c' }))
  assert.equal(run(ok).code, 0)
  const e = setup([mk('published', 'desktop', '0.2.99', 1)])
  const reads = []
  const baseRead = e.deps.readFile
  e.deps.readFile = (p) => { reads.push(p); return baseRead(p) }
  const baseSize = e.deps.fileSize
  e.deps.fileSize = (p) => (p === CFG ? 1025 : baseSize(p))
  const r = run(e)
  assert.equal(r.code, 2)
  assert.ok(!reads.includes(CFG), '太大就不讀')
})
