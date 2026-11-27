// 敏感位置清單（共用 JSON）載入規則的測試：缺檔、格式壞、必要欄位缺、型別錯、清單欄位為空時，
// 背景夥伴的讀取一律擋、機器橋與引擎模組照常載入、log 有明確的路徑與欄位名。
// 只用暫存資料夾裡的假 JSON（透過 useSensitiveDataFile 指過去），不動真的共用檔。
// 執行：node --test relay/machine/test/acp-sensitive-data.test.mjs
import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { LEGACY_DIR_NAME, NEW_DIR_NAME } from '../home.mjs'
import { decide, describeAcpRequest, describeAgyTool, normalizePermissions } from '../engines/acp-policy.mjs'
import {
  DATA, DATA_FAILED_TEXT, SensitiveDataError, loadSensitiveData, sensitiveDataStatus, useSensitiveDataFile,
} from '../engines/acp-sensitive-data.mjs'
import { ReadTool, ReadVerdict, buildRoots, readVerdict } from '../engines/acp-sensitive.mjs'
import { createWorker, preambleFor } from '../engines/acp-worker.mjs'
import { workerSpecFromProfile } from '../partner-background.mjs'

const REAL_FILE = new URL('../../shared/sensitive-roots.json', import.meta.url)
const REAL = JSON.parse(fs.readFileSync(REAL_FILE, 'utf8'))
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'asn-2413-data-'))
const clone = o => JSON.parse(JSON.stringify(o))
const REQUIRED = Object.keys(REAL).filter(k => !k.startsWith('_'))

let seq = 0
/** 寫一份假 JSON 到暫存資料夾，回傳路徑 */
function fake(text) {
  seq += 1
  const f = path.join(TMP, `roots-${seq}.json`)
  fs.writeFileSync(f, typeof text === 'string' ? text : JSON.stringify(text))
  return f
}
/** 改過的共用內容：mutate 收一份複本直接改 */
function variant(mutate) { const d = clone(REAL); mutate(d); return fake(d) }
/** 指到某個檔跑 fn，之後一定還原 */
async function using(file, fn) {
  const restore = useSensitiveDataFile(file)
  try { return await fn() } finally { restore() }
}
const wrongTypeOf = v => (typeof v === 'string' ? 7 : typeof v === 'number' ? '七' : '錯')

// ---- 載入與格式驗證 ----
test('共用設定：真的共用檔載得起來，每個必要欄位都在', () => {
  assert.doesNotThrow(() => loadSensitiveData(fileURLToPath(REAL_FILE)))
  assert.ok(sensitiveDataStatus().ok)
  assert.ok(REQUIRED.length >= 15)
})

test('共用設定：缺檔、不是 JSON、最外層不是物件，載入錯誤帶檔案路徑', () => {
  const missing = path.join(TMP, '不存在.json')
  for (const f of [missing, fake('{ 壞掉'), fake(''), fake('[1,2]'), fake('null')]) {
    assert.throws(() => loadSensitiveData(f), e => e instanceof SensitiveDataError && e.message.includes(f), f)
  }
})

test('共用設定：每個必要欄位缺少時，錯誤帶欄位名', () => {
  for (const k of REQUIRED) {
    const f = variant(d => { delete d[k] })
    assert.throws(() => loadSensitiveData(f), e => e.message.includes(f) && e.message.includes(k) && e.field === k, k)
  }
})

test('共用設定：每個必要欄位型別不對時，錯誤帶欄位名', () => {
  for (const k of REQUIRED) {
    const f = variant(d => { d[k] = wrongTypeOf(REAL[k]) })
    assert.throws(() => loadSensitiveData(f), e => e.message.includes(f) && e.message.includes(k), k)
  }
  // 清單裡的元素型別不對、空字串、成對清單長度不對、數字不是正整數
  for (const [k, v] of [['homeDirs', [1]], ['envRoots', ['a', '']], ['systemFiles', [null]], ['prefixHomeFiles', [['.cargo']]], ['prefixHomeFiles', ['.cargo']],
    ['maxPathLen', 0], ['maxPathLen', 1.5], ['maxJsonDepth', -1], ['hostKeyDir', ''], ['preambleReadOk', '']]) {
    const f = variant(d => { d[k] = v })
    assert.throws(() => loadSensitiveData(f), e => e.message.includes(k), `${k}=${JSON.stringify(v)}`)
  }
})

test('共用設定：清單欄位為空陣列時載入失敗（不能變成全部放行）', () => {
  const lists = REQUIRED.filter(k => Array.isArray(REAL[k]))
  assert.ok(lists.length >= 10)
  for (const k of lists) {
    const f = variant(d => { d[k] = [] })
    assert.throws(() => loadSensitiveData(f), e => e.message.includes(f) && e.message.includes(k) && e.message.includes('空'), k)
  }
})

test('共用設定：物件欄位的必要鍵缺少、型別錯、清單為空，錯誤帶「欄位.鍵」', () => {
  for (const [obj, mutations] of [
    ['prose', [d => { delete d.prose.lead }, d => { d.prose.maxHits = 0 }, d => { d.prose.trim = 3 }]],
    ['agyTools', [d => { delete d.agyTools.list }, d => { d.agyTools.read = [] }, d => { d.agyTools.recursive = [5] }, d => { d.agyTools.internal = 'x' }]],
  ]) {
    for (const m of mutations) {
      const f = variant(m)
      assert.throws(() => loadSensitiveData(f), e => e.message.includes(f) && e.message.includes(`${obj}.`), `${obj} ${m}`)
    }
  }
})

// ---- 讀取一律擋 ----
const CASES = [
  ['缺檔', () => path.join(TMP, '沒有這個檔.json'), '（整份檔）'],
  ['格式壞（不是 JSON）', () => fake('{ "homeDirs": [ '), '（整份檔）'],
  ['必要欄位缺少', () => variant(d => { delete d.sharedHomeNames }), 'sharedHomeNames'],
  ['型別錯', () => variant(d => { d.maxPathLen = '很長' }), 'maxPathLen'],
  ['清單欄位為空', () => variant(d => { d.homeDirs = [] }), 'homeDirs'],
  ['物件裡的清單為空', () => variant(d => { d.agyTools.read = [] }), 'agyTools.read'],
]

function rig(profile) {
  const dir = fs.mkdtempSync(path.join(TMP, 'rig-'))
  const home = path.join(dir, 'home')
  const work = path.join(home, '.asn', 'machine-T')
  const own = path.join(work, 'workers', '甲')
  const proj = path.join(dir, 'proj')
  for (const d of [own, path.join(proj, 'src')]) fs.mkdirSync(d, { recursive: true })
  fs.writeFileSync(path.join(proj, 'src', 'main.rs'), 'x')
  const spec = workerSpecFromProfile({ name: '甲', cwd: own, profile, workDir: work })
  const logs = []
  let guard
  const makeDriver = a => { guard = a.guard; return { onExit() {}, start: async () => {}, resumeLost: () => false, alive: () => true, touch() {}, stop() {}, fullAccess: a.fullAccess } }
  const w = createWorker({
    cfg: spec, env: { USERPROFILE: home, HOME: home }, log: m => logs.push(m), handlers: {}, approvals: {}, notify: async () => {},
    store: { get: () => '', set() {}, clear() {} }, makeDriver, realHome: home, workDir: work,
  })
  w.start()
  return { home, proj, own, spec, logs, get guard() { return guard } }
}
const GEMINI = { command: 'agy', model: 'gemini', label: 'Gemini', acp: { protocol: 'agy-stream', roster_engine: 'gemini' } }
const GROK = { command: 'grok', model: 'grok', label: 'Grok', acp: { protocol: 'acp', roster_engine: 'grok' } }
const wait = async r => { for (let i = 0; i < 100 && !r.guard; i += 1) await new Promise(res => setTimeout(res, 20)); assert.ok(r.guard) }

test('共用設定正常時，同一組讀取請求可以放行（對照組，避免上面的擋是別的原因）', async () => {
  const r = rig(GEMINI)
  await wait(r)
  assert.equal(r.guard.checkTool({ ...describeAgyTool('read_file', { Path: path.join(r.proj, 'src', 'main.rs') }), state: 'DONE' }).ok, true)
  const roots = buildRoots([r.home], [])
  assert.equal(readVerdict(path.join(r.proj, 'src', 'main.rs'), { roots, base: r.proj, tool: ReadTool.Single }), ReadVerdict.Allow)
})

for (const [label, make, field] of CASES) {
  test(`共用設定${label}時讀取一律擋，狀態與 log 講清楚是哪個檔哪個欄位`, async () => {
    const file = make()
    await using(file, async () => {
      const st = sensitiveDataStatus()
      assert.equal(st.ok, false)
      assert.ok(st.error.message.includes(file) && st.error.message.includes(field), st.error.message)

      // 判定函式：連最普通的路徑都不放行
      const roots = buildRoots(['/home/u'], [])
      for (const p of ['/tmp/a.txt', 'relative.txt', '']) {
        assert.notEqual(readVerdict(p, { roots, base: '/work', tool: ReadTool.Single }), ReadVerdict.Allow, `「${p}」`)
      }
      // 政策：讀取與其他要掃路徑的類別都拒絕，原因是白話文字；寫入只看白名單，不受影響
      const policy = { ...normalizePermissions({}, '/work'), sensitive: roots }
      for (const category of ['read', 'execute', 'network', 'other']) {
        const d = decide(policy, { category, paths: ['/tmp/a.txt'] }, '/work')
        assert.equal(d.verdict, 'deny', category)
        assert.equal(d.reason, DATA_FAILED_TEXT)
        assert.ok(!d.reason.includes(file) && !d.reason.includes(field), '給人看的文字不放路徑與欄位名')
      }
      assert.equal(decide(policy, { category: 'read', paths: [] }, '/work').verdict, 'deny', '沒帶路徑的讀取也擋')
      assert.equal(decide(policy, { category: 'write', paths: ['/work/a.txt'] }, '/work').verdict, 'allow')

      // 引擎：建立時 log 一行（路徑與欄位），兩種協定的守門員都擋讀取
      for (const profile of [GEMINI, GROK]) {
        const r = rig(profile)
        assert.ok(r.logs.some(l => l.includes(file) && l.includes(field)), `log：${r.logs.join('|')}`)
        await wait(r)
        const target = path.join(r.proj, 'src', 'main.rs')
        if (profile === GEMINI) {
          assert.equal(r.guard.checkTool({ ...describeAgyTool('read_file', { Path: target }), state: 'DONE' }).ok, false)
          assert.equal(r.guard.checkTool({ ...describeAgyTool('read_file', {}), state: 'DONE' }).ok, false, '沒帶路徑的讀取也擋')
        } else {
          assert.equal(await r.guard.askPermission(describeAcpRequest({ toolCall: { kind: 'read', locations: [{ path: target }] } })), 'deny')
          assert.equal(await r.guard.askPermission(describeAcpRequest({ toolCall: { kind: 'search', rawInput: {} } })), 'deny')
        }
      }
    })
  })
}

test('載入失敗：政策沒帶敏感位置也擋讀取類請求，寫入不受影響', async () => {
  await using(path.join(TMP, '沒有這個檔.json'), async () => {
    const policy = normalizePermissions({}, '/work') // 沒有 sensitive
    for (const category of ['read', 'execute', 'network', 'other']) {
      const d = decide(policy, { category, paths: [] }, '/work')
      assert.equal(d.verdict, 'deny', category)
      assert.equal(d.reason, DATA_FAILED_TEXT)
    }
    assert.equal(decide(policy, { category: 'write', paths: ['/work/a.txt'] }, '/work').verdict, 'allow')
  })
  assert.equal(decide(normalizePermissions({}, '/work'), { category: 'read', paths: [] }, '/work').verdict, 'allow', '清單正常時照舊')
})

test('載入失敗：開場說明把讀取放在允許清單外另起一句；擋下的原因寫「讀取檢查設定載入失敗」並記 log', async () => {
  await using(path.join(TMP, '沒有這個檔.json'), async () => {
    const r = rig(GEMINI)
    await wait(r)
    const text = preambleFor(r.spec)
    assert.ok(text.includes('目前讀取檢查設定載入失敗，讀取檔案暫時不能用，請先不要讀檔。你被允許：寫檔'), text)
    assert.ok(!text.includes('你被允許：讀取'), '讀取不能接在「你被允許：」後面')
    const v = r.guard.checkTool({ ...describeAgyTool('read_file', { Path: path.join(r.proj, 'src', 'main.rs') }), state: 'DONE' })
    assert.equal(v.ok, false)
    assert.ok(v.reason.includes('讀取檢查設定載入失敗') && !v.reason.includes('路徑無法解析'), v.reason)
    assert.ok(r.logs.some(l => l.includes('讀取檢查設定載入失敗') && !l.includes('路徑無法解析')), r.logs.join('|'))
  })
})

test('載入失敗：開場說明不把執行指令列進「你被允許」，並講明執行與上網暫時不能用', async () => {
  await using(path.join(TMP, '沒有這個檔.json'), async () => {
    const r = rig(GEMINI)
    await wait(r)
    const spec = { ...r.spec, permissions: { ...r.spec.permissions, rules: { ...r.spec.permissions.rules, write: 'allow', execute: 'allow' } } }
    const text = preambleFor(spec)
    assert.ok(!/你被允許：[^；。]*執行指令/.test(text), text)
    assert.ok(text.includes('不被允許：執行指令、上網'), text)
    assert.ok(text.includes('讀取檔案、執行指令、上網這段期間暫時不能用'), text)
  })
})

// ---- 機器橋與引擎模組照常載入 ----
test('共用設定載入失敗時，引擎與橋的模組仍能匯入（不在匯入時丟錯）', async () => {
  await using(path.join(TMP, '沒有這個檔.json'), async () => {
    for (const m of ['acp-policy', 'acp-worker', 'acp-sensitive', 'acp-sensitive-roots', 'acp-sensitive-extract', 'acp', 'index']) {
      await assert.doesNotReject(import(`../engines/${m}.mjs?bad-data`), m)
    }
    await assert.doesNotReject(import('../partner-background.mjs?bad-data'))
  })
})

test('清單模組匯入時不讀檔，第一次用到才讀', async () => {
  // 只攔共用 JSON 這一個檔；其他路徑（載入 ESM 原始碼等）一律交回原函式，所以不受 Node 版本載入方式影響
  const original = fs.readFileSync
  const sharedReads = []
  const spy = mock.method(fs, 'readFileSync', function (p, ...rest) {
    if (path.basename(String(p?.pathname ?? p)) === 'sensitive-roots.json') {
      sharedReads.push(String(p))
      throw Object.assign(new Error('讀不到'), { code: 'ENOENT' })
    }
    return original.call(this, p, ...rest)
  })
  try {
    const fresh = await import('../engines/acp-sensitive-data.mjs?no-read-on-import')
    assert.equal(sharedReads.length, 0, '匯入時不該讀共用 JSON')
    assert.equal(fresh.sensitiveDataStatus().ok, false)
    assert.equal(sharedReads.length, 1)
    assert.ok(fresh.sensitiveDataStatus().error.message.includes('sensitive-roots.json'))
    assert.equal(sharedReads.length, 1, '只讀一次')
  } finally { spy.mock.restore() }
})

test('清單載入失敗時 DATA 不丟例外（只給空的樣子），還原後回到真的清單', async () => {
  await using(fake('壞'), async () => {
    assert.deepEqual([...DATA.homeDirs], [])
    assert.equal(DATA.maxPathLen, 4096)
  })
  assert.ok(DATA.homeDirs.includes('.ssh'))
})

// ---- 小項：資料夾名與 home.mjs 一致 ----
test('共用設定的 ASN 資料夾名（新名、舊名）與 home.mjs 一致', () => {
  assert.deepEqual([...DATA.asnDirNames], [NEW_DIR_NAME, LEGACY_DIR_NAME])
  for (const n of [NEW_DIR_NAME, LEGACY_DIR_NAME]) assert.ok(DATA.homeDirs.includes(n), `homeDirs 要包含 ${n}`)
})
