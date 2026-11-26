// 自動發佈常駐程式測試共用的假環境（auto-publish-daemon.test.mjs、post-pending.test.mjs 共用）
import path from 'node:path'
import { REQUIRED_DEPS, runOnce } from '../../../../tools/release/auto_publish.mjs'
import { formatPostFailedMarker } from '../../../../tools/release/asn_cli.mjs'

export const REPO = path.resolve('/repo')
export const inRepo = (p) => path.join(REPO, p)
export const STATE = '/w/state.json'
export const LOCK = `${STATE}.lock`
export const SECRET = '子程序原文-不可貼群組-ABC123'
export const T0 = Date.parse('2026-11-21T10:00:00Z')
// 鎖檔內容：pid 換行 時間戳
export const lk = (pid, ts = T0 - 60_000) => `${pid}
${ts}`
// 核心現在要求先播種：預設的初始 state 是已播種（0.2.44 以下都算處理過）
export const seededState = (extra = {}) => ({ v: 1, done: { 'desktop@0.2.44': { result: 'seeded', at: 'x', runId: null }, 'linux@0.2.44': { result: 'seeded', at: 'x', runId: null } }, pending: {}, inflight: null, seeded: true, since: { desktop: '0.2.44', linux: '0.2.44' }, seedNoticed: false, pausedNoticed: false, ...extra })

// 假環境：檔案、gh、git、子程序、asn-cli 全是假的
export function env({ desktopRows = [], linuxRows = [], files = {}, alive = [], gitOver = {}, spawnStatus = 0, ghStatus = 0, noDeps = false, noState = false, online = '0.2.43' } = {}) {
  const fsMap = new Map(Object.entries(files).map(([k, v]) => [path.isAbsolute(k) ? k : inRepo(k), v]))
  if (!noState && !fsMap.has(STATE)) fsMap.set(STATE, JSON.stringify(seededState()))
  const clock = { t: T0 }
  if (!noDeps) for (const p of REQUIRED_DEPS) fsMap.set(inRepo(p), 'x')
  const calls = { gh: [], git: [], spawn: [], posts: [], fetch: [], logs: [], unlinks: [], ops: [] }
  const deps = {
    pid: 4242, repoRoot: REPO, now: () => clock.t,
    gh: (args) => {
      calls.gh.push(args)
      if (ghStatus) return { status: ghStatus, stdout: '', stderr: 'boom' }
      const wf = args[args.indexOf('--workflow') + 1]
      return { status: 0, stdout: JSON.stringify(wf === 'asn-release.yml' ? desktopRows : linuxRows), stderr: '' }
    },
    git: (args) => {
      const k = args.join(' ')
      calls.git.push(k)
      for (const [pat, fn] of Object.entries(gitOver)) if (k.startsWith(pat)) return fn(k)
      return { status: 0, stdout: '', stderr: '' }
    },
    spawn: (bin, args, o) => { calls.spawn.push([bin, args, o]); return { status: spawnStatus, stdout: SECRET, stderr: SECRET } },
    asnCli: (args) => { calls.posts.push(args[args.indexOf('--body') + 1]); return { status: 0, stdout: '', stderr: '' } },
    exists: (p) => fsMap.has(p),
    readFile: (p) => { if (!fsMap.has(p)) throw Object.assign(new Error('no'), { code: 'ENOENT' }); return fsMap.get(p) },
    fileSize: (p) => { if (!fsMap.has(p)) throw Object.assign(new Error('no'), { code: 'ENOENT' }); return Buffer.byteLength(fsMap.get(p), 'utf8') },
    writeFile: (p, s) => { calls.ops.push(`write:${p}`); fsMap.set(p, s) },
    rename: (a, b) => { calls.ops.push(`rename:${a}>${b}`); if (!fsMap.has(a)) throw Object.assign(new Error('no'), { code: 'ENOENT' }); fsMap.set(b, fsMap.get(a)); fsMap.delete(a) },
    createLock: (p, s) => { calls.ops.push(`lock:${p}`); if (fsMap.has(p)) throw Object.assign(new Error('exists'), { code: 'EEXIST' }); fsMap.set(p, s) },
    unlink: (p) => { calls.unlinks.push(p); fsMap.delete(p) },
    pidAlive: (pid) => alive.includes(pid),
    log: (m) => calls.logs.push(m),
    fetch: async (u) => { calls.fetch.push(u); if (online === null) throw new Error('offline'); return { ok: true, status: 200, json: async () => ({ version: online }) } },
  }
  return { deps, calls, fsMap, clock }
}

// headSha 預設由 run 編號補成 40 位 hex，每個 run 的 commit 都不同
export const sha = (id) => Number(id).toString(16).padStart(8, '0') + 'a'.repeat(32)
export const short = (id) => sha(id).slice(0, 8)
export const row = (branch, id = 100, over = {}) => ({ databaseId: id, headBranch: branch, headSha: sha(id), status: 'completed', conclusion: 'success', createdAt: '2026-11-21T09:00:00Z', attempt: 1, ...over })
export const opts = { state: STATE, room: 'r1', dryRunOnly: false }
export const lastState = (fsMap) => JSON.parse(fsMap.get(STATE))
export const ALERT = path.join(path.dirname(STATE), 'alert.json')
export const alertOf = (e) => JSON.parse(e.fsMap.get(ALERT))
export const PENDING = path.join(path.dirname(STATE), 'post-pending.json')
export const pendingOf = (e) => JSON.parse(e.fsMap.get(PENDING))
export const postFails = (e) => { e.deps.asnCli = () => ({ status: 2, stdout: '', stderr: '拒絕：找不到呼叫者所屬的 Claude 視窗' }) }

export const markerOut = () => `...log...\n${formatPostFailedMarker()}\n`
// 第一輪 dry-run 先過，第二輪才是正式發佈
export async function publishWithPostFailed(e, text = '【發版完成】v0.2.99：…') {
  e.deps.spawn = (bin, args) => ({ status: 0, stdout: args.includes('--dry-run') ? 'ok' : markerOut(text), stderr: '' })
  await runOnce(opts, e.deps)
  return await runOnce(opts, e.deps)
}
