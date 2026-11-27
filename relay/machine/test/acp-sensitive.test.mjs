// 讀取的敏感位置判定（#2356 PR-2，Node 版）測試。
// 跟電腦版（relay/asn 的 acp_sensitive/tests_shared.rs）讀同一份清單（relay/shared/sensitive-roots.json）與同一份向量
// （relay/shared/test-vectors/sensitive-read.json）。測試只用暫存資料夾裡的假家目錄與假 ASN 資料夾，不碰真的使用者資料夾。
// 執行：node --test relay/machine/test/acp-sensitive.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import util from 'node:util'
import { DATA } from '../engines/acp-sensitive-data.mjs'
import { containerLike, fragments, proseCandidates } from '../engines/acp-sensitive-extract.mjs'
import { driveRelative, expand, nstr, opaqueDevicePath, stripFileUrl, wildcardPrefix, winClean } from '../engines/acp-sensitive-path.mjs'
import {
  ATTACHMENTS_READABLE, ReadTool, ReadVerdict, buildRoots, extractReadPaths, homesFrom, paramKeys, readToolOfAcpKind, readToolOfAgy, readVerdict, rootsForWorker,
} from '../engines/acp-sensitive.mjs'

const SENSITIVE_HOME_DIRS = DATA.homeDirs
const EXTRA_HOME_PATHS = DATA.extraHomePaths
const V = JSON.parse(fs.readFileSync(new URL('../../shared/test-vectors/sensitive-read.json', import.meta.url), 'utf8'))
const IS_WIN = process.platform === 'win32'
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'asn-2356-vec-'))
const fwd = p => p.replaceAll('\\', '/')
const urlp = p => `///${fwd(p).replace(/^\//, '')}`
const P = { TMP: T, HOME: path.join(T, 'home'), HOME2: path.join(T, 'home2'), WORK: path.join(T, 'work') }
P.ASN = path.join(P.HOME, '.asn')
P.MACH = path.join(P.ASN, 'machine-T')
P.OWN = path.join(P.MACH, 'workers', '甲')
const tpl = s => s
  .replace(/\{REP:(.*?):(\d+)\}/gs, (_, x, n) => x.repeat(Number(n)))
  .replaceAll('{HOME_URLP}', urlp(P.HOME)).replaceAll('{WORK_URLP}', urlp(P.WORK))
  .replace(/\{(TMP|HOME2|HOME|WORK|ASN|MACH|OWN)\}/g, (_, k) => P[k])
  .replaceAll('{BRACE}', '{')
const tplDeep = v => (typeof v === 'string' ? tpl(v) : Array.isArray(v) ? v.map(tplDeep) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, tplDeep(x)])) : v)
const mkdirs = list => { for (const d of list) fs.mkdirSync(d, { recursive: true }) }
const failCanon = () => { throw new Error('無法解析') }
const TOOLS = { single: ReadTool.Single, list: ReadTool.List, recursive: ReadTool.Recursive }

function rootsOf(c) {
  const homes = (c.homes ?? ['{HOME}']).map(tpl)
  const env = Object.entries(c.env ?? {}).map(([k, v]) => [k, tpl(v)])
  if (c.ex) return rootsForWorker(env, homes[0], c.ex.name, c.ex.ownDirs.map(tpl), tpl(c.ex.workDir), { attachments: c.ex.attachments ?? true })
  return buildRoots(homes, env, c.canonFails ? failCanon : undefined)
}

function runVerdict(c) {
  mkdirs([P.HOME, P.WORK, ...(c.mk ?? []).map(tpl)])
  const roots = rootsOf(c)
  return readVerdict(tpl(c.p), { roots, base: tpl(c.b ?? '{WORK}'), tool: TOOLS[c.t ?? 'single'] })
}

for (const group of ['verdicts', 'exempt']) {
  for (const c of V[group]) {
    const skip = c.os && c.os !== (IS_WIN ? 'windows' : 'posix')
    test(`向量 ${group}：${c.n}`, { skip }, () => {
      assert.equal(runVerdict(c), c.e, c.p)
    })
  }
}

// ---- 純字串函式 ----
test('向量 pure：Windows 路徑形式的正規化（任何平台都能跑）', () => {
  for (const [i, o] of V.pure.winClean) assert.equal(winClean(i), o, i)
})
test('向量 pure：看不出實際指向哪裡的裝置與網路寫法', () => {
  const local = V.pure.opaqueLocalNames
  for (const p of V.pure.opaqueYes) assert.equal(opaqueDevicePath(p, local), true, p)
  for (const p of V.pure.opaqueNo) assert.equal(opaqueDevicePath(p, local), false, p)
})
test('向量 pure：磁碟機後面不接分隔符', () => {
  for (const p of V.pure.driveRelativeYes) assert.equal(driveRelative(p), true, p)
  for (const p of V.pure.driveRelativeNo) assert.equal(driveRelative(p), false, p)
})
test('向量 pure：萬用字元取前綴', () => {
  for (const [i, o] of V.pure.wildcardPrefix) assert.equal(wildcardPrefix(i), o, i)
})
test('向量 pure：file 網址', () => {
  for (const [i, o] of V.pure.stripFileUrl) assert.equal(stripFileUrl(i), o, i)
})
test('向量 pure：多位元組字元不會當掉', () => {
  mkdirs([P.HOME, P.WORK])
  const roots = buildRoots([P.HOME], [])
  for (const p of V.pure.multibyteNoCrash) {
    readVerdict(p, { roots, base: P.WORK, tool: ReadTool.Single })
    stripFileUrl(p)
  }
})

const sorted = a => [...a].sort()
for (const c of V.pure.extract) {
  test(`向量 extract：${c.n}`, () => {
    let params
    if (c.nest) {
      params = c.inner
      for (let i = 0; i < c.nest; i += 1) params = { arguments: JSON.stringify(params) }
    } else params = tplDeep(c.params)
    const got = extractReadPaths(params)
    if (Array.isArray(c.e)) { assert.deepEqual(sorted(got), sorted(c.e.map(tpl))); return }
    if (c.e.len !== undefined) assert.equal(got.length, c.e.len, JSON.stringify(got).slice(0, 200))
    for (const x of c.e.contains ?? []) assert.ok(got.includes(x), `${x} 在 ${JSON.stringify(got)}`)
    if (c.e.maxLen !== undefined) assert.ok(got.length <= c.e.maxLen, JSON.stringify(got))
    for (const x of c.e.notContains ?? []) assert.ok(!got.includes(x), x)
    if (c.e.containerLike) assert.equal(containerLike(got[0]), true)
  })
}
test('向量 prose：夾在有空白文字裡的敏感位置片段', () => {
  for (const c of V.pure.prose) {
    const got = proseCandidates(c.line)
    if (c.e) assert.deepEqual(got, c.e, c.line)
    for (const x of c.contains ?? []) assert.ok(got.includes(x), `${x} 在 ${JSON.stringify(got)}`)
  }
})

// ---- 清單 ----
test('清單：共用檔裡每個位置，本身與底下的檔都擋', () => {
  mkdirs([P.HOME, P.WORK])
  const roots = buildRoots([P.HOME], [])
  const ctx = { roots, base: P.WORK, tool: ReadTool.Single }
  for (const d of [...SENSITIVE_HOME_DIRS, ...EXTRA_HOME_PATHS]) {
    assert.equal(readVerdict(path.join(P.HOME, d), ctx), ReadVerdict.Sensitive, `${d} 本身`)
    assert.equal(readVerdict(path.join(P.HOME, d, 'x', 'y.txt'), ctx), ReadVerdict.Sensitive, `${d} 底下`)
  }
})
test('清單：另外寫死一份必要項目，誰把共用檔的項目拿掉這裡會紅', () => {
  for (const d of ['.gemini', '.ssh', '.asn', ['.irori', 'relay'].join('-'), '.claude', '.codex', '.pi', '.aws', '.config', '.gnupg']) assert.ok(SENSITIVE_HOME_DIRS.includes(d), d)
  for (const d of ['.grok', '.claude.json', '.netrc', '.git-credentials', '.docker', '.kube', '.azure', '.npmrc', 'AppData/Roaming/Microsoft/Credentials', 'AppData/Roaming/Microsoft/Protect',
    'AppData/Local/Google/Chrome/User Data', 'AppData/Local/Microsoft/Edge/User Data', 'AppData/Local/tw.yooliang.asn']) assert.ok(EXTRA_HOME_PATHS.includes(d), d)
  assert.deepEqual(DATA.envRoots, ['CODEX_HOME', 'PI_CODING_AGENT_DIR', 'ASN_HOME', 'IRORI_HOME', 'ASN_CLAUDE_HOME', 'ASN_GROK_HOME'])
  assert.deepEqual(DATA.systemFiles, ['/etc/shadow', '/etc/gshadow'])
  assert.equal(DATA.hostKeyDir, '/etc/ssh')
  assert.equal(DATA.maxPathLen, 4096)
  assert.equal(DATA.maxJsonDepth, 4)
  assert.deepEqual(DATA.asnDirNames, [SENSITIVE_HOME_DIRS[2], SENSITIVE_HOME_DIRS[3]])
})
test('清單：一般文字夾著的片段從清單自動產生，清單每一項都有對應的片段', () => {
  for (const e of [...SENSITIVE_HOME_DIRS, ...EXTRA_HOME_PATHS]) {
    const n = e.replaceAll('\\', '/').toLowerCase()
    assert.ok(fragments().some(f => n.endsWith(f)), e)
  }
  assert.ok(fragments().includes('chrome/user data'))
})
test('清單：agy 工具的類別表跟讀取工具的種類', () => {
  for (const [n, t] of [['list_dir', ReadTool.List], ['list_resources', ReadTool.List], ['find_by_name', ReadTool.Recursive], ['grep_search', ReadTool.Recursive], ['view_file', ReadTool.Single], ['read_resource', ReadTool.Single], ['沒看過', ReadTool.Single]]) assert.equal(readToolOfAgy(n), t, n)
  assert.equal(readToolOfAcpKind('search'), ReadTool.Recursive)
  assert.equal(readToolOfAcpKind('SEARCH'), ReadTool.Recursive)
  assert.equal(readToolOfAcpKind('read'), ReadTool.Single)
  assert.equal(readToolOfAcpKind('think'), ReadTool.Single)
})

// ---- 家目錄來源與建立清單的正式做法 ----
test('家目錄來源：工作者環境的與這台電腦實際的都要算', () => {
  const e = o => Object.entries(o)
  assert.deepEqual(homesFrom(e({ HOME: '/h', UserProfile: '/p' }), '/real'), ['/p', '/h', '/real'], 'USERPROFILE 與 HOME 兩個都算')
  assert.deepEqual(homesFrom(e({ HOME: '/h', USERPROFILE: ' ' }), '/real'), ['/h', '/real'])
  assert.deepEqual(homesFrom(e({ HOME: '/real' }), '/real'), ['/real'], '同一個不重複')
  assert.deepEqual(homesFrom([], '/real'), ['/real'])
  assert.deepEqual(homesFrom([], null), [])
  assert.deepEqual(homesFrom(e({ HOME: '/h' }), ''), ['/h'], '空的實際家目錄不算')
})

test('正式路徑建立清單：兩個家目錄與環境變數過濾', () => {
  const d = fs.mkdtempSync(path.join(T, 'rfw-'))
  const [h1, h2, h3, work, cx] = ['h1', 'h2', 'h3', 'work', 'cx'].map(n => path.join(d, n))
  mkdirs([h1, h2, h3, work])
  const env = { USERPROFILE: h1, HOME: h2, CODEX_HOME: cx, MYDIR: path.join(h1, '.ssh'), API_TOKEN: path.join(h1, '.ssh'), MY_SECRET_DIR: path.join(h1, '.ssh') }
  const roots = rootsForWorker(env, h3, '甲', [work], work)
  const v = p => readVerdict(p, { roots, base: work, tool: ReadTool.Single })
  for (const h of [h1, h2, h3]) assert.equal(v(path.join(h, '.ssh', 'id')), ReadVerdict.Sensitive, h)
  assert.equal(v(path.join(cx, 'auth.json')), ReadVerdict.Sensitive, '環境變數指定的位置')
  assert.equal(v('%MYDIR%/id'), ReadVerdict.Sensitive, '一般名字的變數可以用來展開')
  assert.equal(v('%API_TOKEN%/id'), ReadVerdict.Allow, '名字像金鑰的不帶進來')
  assert.equal(v('$MY_SECRET_DIR/id'), ReadVerdict.Allow)
  assert.ok(roots.env.every(([k]) => !k.includes('TOKEN') && !k.includes('SECRET')))
  assert.ok(!JSON.stringify(roots).includes('MYDIR') && !util.inspect(roots, { depth: 5 }).includes('MYDIR'), '印出來不含環境變數')
})

test('展開：每個家目錄各展開一次', () => {
  const [outs] = expand('~/.x', ['/a', '/b'], [])
  assert.deepEqual(outs, ['/a/.x', '/b/.x'])
  assert.equal(nstr('C:\\A\\b\\'), IS_WIN ? 'c:/a/b' : 'C:/A/b')
})

// ---- 捷徑（只能在各自測試裡用暫存資料夾建）----
const link = (target, l) => fs.symlinkSync(target, l, IS_WIN ? 'junction' : 'dir')
const rigLinks = () => {
  const d = fs.mkdtempSync(path.join(T, 'lnk-'))
  const home = path.join(d, 'home')
  const work = path.join(d, 'work')
  mkdirs([home, work])
  return { d, home, work, roots: buildRoots([home], []) }
}
const vIn = (roots, base, p, tool = ReadTool.Single) => readVerdict(p, { roots, base, tool })

test('捷徑指向敏感位置的也擋；指到一般資料夾的放行', () => {
  const r = rigLinks()
  mkdirs([path.join(r.home, '.ssh'), path.join(r.home, 'Desktop')])
  fs.writeFileSync(path.join(r.home, '.ssh', 'id'), 'x')
  const l = path.join(r.work, 'shortcut')
  link(path.join(r.home, '.ssh'), l)
  assert.equal(vIn(r.roots, r.work, l), ReadVerdict.Sensitive, '捷徑本身')
  assert.equal(vIn(r.roots, r.work, path.join(l, 'id')), ReadVerdict.Sensitive, '已存在的檔')
  assert.equal(vIn(r.roots, r.work, path.join(l, 'not-yet.txt')), ReadVerdict.Sensitive, '還不存在的檔')
  assert.equal(vIn(r.roots, r.work, 'shortcut/id'), ReadVerdict.Sensitive, '相對路徑')
  const ok = path.join(r.work, 'plain')
  link(path.join(r.home, 'Desktop'), ok)
  assert.equal(vIn(r.roots, r.work, path.join(ok, 'a.txt')), ReadVerdict.Allow, '對照：指到一般資料夾的捷徑放行')
})

test('捷徑加上一層寫法', { skip: IS_WIN }, () => {
  const r = rigLinks()
  mkdirs([path.join(r.home, '.ssh', 'inner')])
  fs.writeFileSync(path.join(r.home, '.ssh', 'secret'), 'x')
  link(path.join(r.home, '.ssh', 'inner'), path.join(r.work, 'hop'))
  assert.equal(vIn(r.roots, r.work, `${r.work}/hop/../secret`), ReadVerdict.Sensitive)
})

test('捷徑：對話資料夾裡的捷徑指到登入檔所在位置，用實際位置判，不放行', () => {
  const r = rigLinks()
  const g = path.join(r.home, '.gemini')
  const c1 = path.join(g, 'antigravity-cli', 'brain', 'c1')
  mkdirs([c1])
  link(g, path.join(c1, 'hop'))
  assert.equal(vIn(r.roots, r.work, path.join(c1, 'hop', 'oauth_creds.json')), ReadVerdict.Sensitive)
  assert.equal(vIn(r.roots, r.work, path.join(c1, 'x.md')), ReadVerdict.Allow, '對照：正常的放行')
})

test('捷徑：自己的資料夾裡經捷徑跳出去的照擋；附件資料夾或自己的資料夾是捷徑也不放行', () => {
  const d = fs.mkdtempSync(path.join(T, 'ex-'))
  const home = path.join(d, 'home')
  const asn = path.join(home, '.asn')
  const mach = path.join(asn, 'machine-T')
  const own = path.join(mach, 'workers', '甲')
  mkdirs([own, path.join(mach, 'attachments'), path.join(home, '.ssh', 'sub'), path.join(asn, 'other')])
  const mk = () => rootsForWorker([], home, '甲', [own], mach)
  let roots = mk()
  assert.equal(vIn(roots, own, path.join(own, 'a.md')), ReadVerdict.Allow, '對照：自己的檔放行')
  link(path.join(home, '.ssh'), path.join(own, 'hop'))
  assert.equal(vIn(roots, own, path.join(own, 'hop', 'id')), ReadVerdict.Sensitive, '字面在自己資料夾裡、實際位置在敏感位置')
  // 附件資料夾是捷徑，指向敏感位置
  fs.rmSync(path.join(mach, 'attachments'), { recursive: true })
  link(path.join(home, '.ssh', 'sub'), path.join(mach, 'attachments'))
  roots = mk()
  assert.equal(vIn(roots, own, path.join(mach, 'attachments', 'id')), ReadVerdict.Sensitive)
  assert.equal(vIn(roots, own, path.join(home, '.ssh', 'sub', 'id')), ReadVerdict.Sensitive, '捷徑的實際位置不能變成放行')
  // 附件資料夾是捷徑，指到 ASN 資料夾裡的別處
  fs.rmSync(path.join(mach, 'attachments'), { recursive: true })
  link(path.join(asn, 'other'), path.join(mach, 'attachments'))
  roots = mk()
  assert.equal(vIn(roots, own, path.join(mach, 'attachments', 'x')), ReadVerdict.Sensitive)
  assert.equal(vIn(roots, own, path.join(asn, 'other', 'x')), ReadVerdict.Sensitive)
  // 自己的資料夾本身是捷徑，指到 ASN 資料夾裡的別處
  fs.rmSync(own, { recursive: true })
  link(path.join(asn, 'other'), own)
  roots = mk()
  assert.equal(vIn(roots, own, path.join(own, 'x')), ReadVerdict.Sensitive)
  assert.equal(vIn(roots, own, path.join(asn, 'other', 'x')), ReadVerdict.Sensitive)
})

test('設定值：附件資料夾預設開放', () => { assert.equal(ATTACHMENTS_READABLE, true) })
test('參數欄位名：只有名字沒有值', () => {
  assert.deepEqual(paramKeys({ Path: 'x', Other: 1 }).sort(), ['Other', 'Path'])
  assert.deepEqual(paramKeys(JSON.stringify({ Path: 'x', Other: 1 })).sort(), ['Other', 'Path'])
  assert.deepEqual(paramKeys('not json'), [])
  assert.deepEqual(paramKeys(null), [])
})
