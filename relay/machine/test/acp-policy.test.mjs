// acp 轉接器的純邏輯測試：設定檢查、權限政策、授權簿、錯誤分類。不起任何行程。
// 執行：node --test relay/machine/test/acp-policy.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createApprovals, parseMailText, parseVerdict } from '../engines/acp-approvals.mjs'
import { loadWorkersConfig, normalizeWorker } from '../engines/acp-config.mjs'
import { classifyFailure } from '../engines/acp-errors.mjs'
import { categoryOfAcpKind, categoryOfAgyTool, decide, describeAcpRequest, describeAgyTool, normalizePermissions, redact } from '../engines/acp-policy.mjs'

const WORK = path.join(os.tmpdir(), 'irori-acp-policy-test')
const base = { name: 'Gemini', engine: 'acp', protocol: 'agy-stream', command: 'agy' }

test('設定：預設值（預設開放、工作資料夾在 workDir/workers/<name>、roster 引擎預設 acp）', () => {
  const { worker, warnings } = normalizeWorker(base, { workDir: WORK, index: 0 })
  assert.equal(worker.cwd, path.resolve(WORK, 'workers', 'Gemini'))
  assert.deepEqual(worker.permissions.rules, { read: 'allow', write: 'allow', execute: 'allow', network: 'allow', other: 'deny' })
  assert.deepEqual(worker.permissions.allowDirs, [worker.cwd])
  assert.equal(worker.rosterEngine, 'acp')
  assert.deepEqual(worker.ask.notify, [{ sender: true }])
  assert.equal(worker.ask.timeoutMs, 300_000)
  assert.deepEqual(warnings, [])
})

test('設定：壞條目只被跳過並說明原因', () => {
  const bad = (raw, re) => assert.match(normalizeWorker(raw, { workDir: WORK, index: 3 }).error, re)
  bad({ ...base, name: '-bad' }, /name/)
  bad({ ...base, name: 'a b' }, /name/)
  bad({ ...base, engine: 'codex' }, /engine/)
  bad({ ...base, protocol: 'telepathy' }, /protocol/)
  bad({ ...base, command: '' }, /command/)
  bad({ ...base, args: [1] }, /args/)
  bad({ ...base, env_pass: ['GEMINI_API_KEY'] }, /env_pass/)
  bad(null, /物件/)
})

test('設定：agy-stream 的 write／network 設 ask 會降成 deny 並提醒；acp 協定可以 ask', () => {
  const a = normalizeWorker({ ...base, permissions: { write: 'ask', execute: 'ask', network: 'ask' } }, { workDir: WORK, index: 0 })
  assert.equal(a.worker.permissions.rules.write, 'deny')
  assert.equal(a.worker.permissions.rules.network, 'deny')
  assert.equal(a.worker.permissions.rules.execute, 'ask')   // agy 的指令可以事後問
  assert.equal(a.warnings.length, 2)
  const b = normalizeWorker({ ...base, protocol: 'acp', permissions: { write: 'ask' } }, { workDir: WORK, index: 0 })
  assert.equal(b.worker.permissions.rules.write, 'ask')
})

test('設定：ask.notify 解析、壞值被忽略', () => {
  const r = normalizeWorker({ ...base, ask: { notify: ['sender', { node: 'PC1', agent: '夥伴甲' }, { nope: 1 }], timeout_ms: 5000 } }, { workDir: WORK, index: 0 })
  assert.deepEqual(r.worker.ask.notify, [{ sender: true }, { node: 'PC1', agent: '夥伴甲' }])
  assert.equal(r.worker.ask.timeoutMs, 5000)
  assert.equal(r.warnings.length, 1)
})

test('loadWorkersConfig：沒有檔案＝沒有工作者；壞 JSON 回報；重名跳過', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'irori-acp-cfg-'))
  const file = path.join(dir, 'agents.json')
  assert.deepEqual(loadWorkersConfig({ file, workDir: dir }).workers, [])
  assert.deepEqual(loadWorkersConfig({ file, workDir: dir }).errors, [])
  fs.writeFileSync(file, '{oops')
  assert.match(loadWorkersConfig({ file, workDir: dir }).errors[0], /JSON/)
  fs.writeFileSync(file, JSON.stringify({ workers: [base, { ...base, name: 'gemini' }, { ...base, name: 'Other', command: '' }, { ...base, name: 'G2' }] }))
  const r = loadWorkersConfig({ file, workDir: dir })
  assert.deepEqual(r.workers.map(w => w.name), ['Gemini', 'G2'])
  assert.equal(r.errors.length, 2)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('範本 agents.example.json 載得進來：只有 Gemini 開著，備援條目 enabled:false 被略過，沒有錯誤', () => {
  const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'agents.example.json')
  const r = loadWorkersConfig({ file, workDir: WORK })
  assert.deepEqual(r.errors, [])
  assert.deepEqual(r.workers.map(w => w.name), ['Gemini'])
  assert.equal(r.workers[0].protocol, 'agy-stream')
  assert.equal(r.workers[0].rosterEngine, 'gemini')
  assert.equal(r.workers[0].permissions.rules.write, 'allow')
})

test('政策：類別對照', () => {
  assert.equal(categoryOfAcpKind('edit'), 'write')
  assert.equal(categoryOfAcpKind('delete'), 'write')
  assert.equal(categoryOfAcpKind('execute'), 'execute')
  assert.equal(categoryOfAcpKind('fetch'), 'network')
  assert.equal(categoryOfAcpKind('search'), 'read')
  assert.equal(categoryOfAcpKind('switch_mode'), 'other')
  assert.equal(categoryOfAcpKind(undefined), 'other')
  assert.equal(categoryOfAgyTool('write_to_file'), 'write')
  assert.equal(categoryOfAgyTool('run_command'), 'execute')
  assert.equal(categoryOfAgyTool('view_file'), 'read')
  assert.equal(categoryOfAgyTool('search_web'), 'network')
  assert.equal(categoryOfAgyTool('browser_click_element'), 'network')
  assert.equal(categoryOfAgyTool('manage_task'), 'internal')
  assert.equal(categoryOfAgyTool('apply_patch_v2'), 'write')       // 新工具名用關鍵字推測
  assert.equal(categoryOfAgyTool('totally_new_thing'), 'internal')
})

test('政策：decide——預設開放；白名單資料夾外的讀寫一律拒絕；ask 原樣回傳', () => {
  const cwd = path.resolve(WORK, 'w')
  const p = normalizePermissions({ write: 'ask', execute: 'allow' }, cwd)
  assert.equal(decide(p, { category: 'read', paths: [path.join(cwd, 'a.txt')] }, cwd).verdict, 'allow')
  assert.equal(decide(p, { category: 'read', paths: ['a.txt'] }, cwd).verdict, 'allow')             // 相對路徑以工作資料夾為準
  assert.equal(decide(p, { category: 'read', paths: [path.resolve(WORK, 'other', 'x')] }, cwd).verdict, 'deny')
  assert.equal(decide(p, { category: 'read', paths: [path.join(cwd, '..', 'x')] }, cwd).verdict, 'deny')
  assert.equal(decide(p, { category: 'write', paths: [path.join(cwd, 'a.txt')] }, cwd).verdict, 'ask')
  assert.equal(decide(p, { category: 'write', paths: [path.resolve(WORK, 'x')] }, cwd).verdict, 'deny')
  assert.equal(decide(p, { category: 'execute', paths: [] }, cwd).verdict, 'allow')
  assert.equal(decide(p, { category: 'other', paths: [] }, cwd).verdict, 'deny')
  assert.equal(decide(p, { category: 'internal', paths: [] }, cwd).verdict, 'allow')
  const dflt = normalizePermissions(undefined, cwd)
  assert.equal(decide(dflt, { category: 'write', paths: [path.join(cwd, 'a.txt')] }, cwd).verdict, 'allow')
  assert.equal(decide(dflt, { category: 'write', paths: [path.resolve(WORK, 'x')] }, cwd).verdict, 'deny', '預設開放仍擋資料夾外的寫入')
  assert.equal(decide(dflt, { category: 'read', paths: ['/etc/passwd'] }, cwd).verdict, 'deny')
  assert.equal(decide(dflt, { category: 'execute', paths: [] }, cwd).verdict, 'allow')
  assert.equal(decide(dflt, { category: 'other', paths: [] }, cwd).verdict, 'deny')
  assert.equal(decide(dflt, { category: 'network', paths: [] }, cwd).verdict, 'allow')
})

test('政策：自訂白名單資料夾；壞值被忽略並提醒', () => {
  const cwd = path.resolve(WORK, 'w')
  const extra = path.resolve(WORK, 'shared')
  const p = normalizePermissions({ read: 'allow', allow_dirs: [cwd, extra], write: 'maybe', bogus: 1 }, cwd)
  assert.equal(p.rules.write, 'allow')  // 壞值改用預設（現在是 allow）
  assert.equal(p.warnings.length, 2)
  assert.equal(decide(p, { category: 'read', paths: [path.join(extra, 'f')] }, cwd).verdict, 'allow')
})

test('摘要：不含機密、指令與路徑會截斷', () => {
  const secret = redact('curl -H "Authorization: Bearer abc.def.ghi" https://x --data key=AIzaSyA1234567890abcdefghijkl token=hunter2')
  assert.doesNotMatch(secret, /abc\.def|AIzaSy|hunter2/)
  const d = describeAcpRequest({ toolCall: { kind: 'execute', rawInput: { command: 'echo sk-abcdefghijklmnopqrstuvwxyz && ' + 'x'.repeat(400) } } })
  assert.equal(d.category, 'execute')
  assert.doesNotMatch(d.summary, /sk-abcdef/)
  assert.ok(d.summary.length < 220)
  const e = describeAcpRequest({ toolCall: { kind: 'edit', locations: [{ path: 'C:\\w\\a.txt' }] } })
  assert.deepEqual(e.paths, ['C:\\w\\a.txt'])
  assert.match(e.summary, /寫入：檔案：C:\\w\\a\.txt/)
  const g = describeAgyTool('run_command', { CommandLine: 'echo hi' })
  assert.match(g.summary, /執行指令：指令：echo hi/)
})

test('授權簿：回覆解析', () => {
  const t = (s, v) => assert.equal(parseVerdict(s), v, s)
  t('允許', 'allow'); t('允許 A1B2', 'allow'); t('ok', 'allow'); t('好', 'allow'); t('可以', 'allow'); t('Yes', 'allow')
  t('拒絕', 'deny'); t('不允許', 'deny'); t('不要', 'deny'); t('no', 'deny'); t('deny A1B2', 'deny')
  t('全部允許', 'allow_all'); t('這次全部允許 A1B2', 'allow_all'); t('allow all', 'allow_all')
  t('你好嗎', null); t('nothing', null); t('', null)
})

test('授權簿：信件標頭解析', () => {
  const p = parseMailText('[RELAY 來信] trust=owner from=PC1/夥伴甲 to=Gemini id=abc engine=gemini\n允許 A1B2')
  assert.deepEqual(p, { node: 'PC1', agent: '夥伴甲', body: '允許 A1B2' })
  // 抬頭多了 reply=yes|no|?（要不要回信）也照樣解析；欄位本身由 mail-format.mjs 的 headReply 取
  const q = parseMailText('[RELAY 來信] trust=owner from=PC1/夥伴甲 to=Gemini id=abc engine=gemini reply=no\n允許 A1B2')
  assert.deepEqual(q, { node: 'PC1', agent: '夥伴甲', body: '允許 A1B2' })
  assert.deepEqual(parseMailText('沒有標頭'), { node: '', agent: '', body: '沒有標頭' })
})

test('授權簿：只認被問的人；編號、單筆自動對應、多筆要編號；逾時＝timeout', async () => {
  let timers = []
  const ap = createApprovals({ setTimer: (fn, ms) => { const t = { fn, ms, unref() {} }; timers.push(t); return t }, clearTimer: t => { t.cleared = true }, newId: (() => { let n = 0; return () => `ID0${++n}` })() })
  const a1 = ap.ask({ worker: 'G', summary: '寫入：a', targets: [{ node: 'PC1', agent: '夥伴甲' }], timeoutMs: 1000 })
  assert.equal(a1.id, 'ID01')
  assert.equal(timers[0].ms, 1000)
  // 別的節點、別的視窗：不算
  assert.equal(ap.handleReply({ worker: 'G', from: { node: 'EVIL', agent: '夥伴甲' }, text: '允許' }).handled, false)
  assert.equal(ap.handleReply({ worker: 'G', from: { node: 'PC1', agent: '別人' }, text: '允許' }).handled, false)
  assert.equal(ap.handleReply({ worker: 'OTHER', from: { node: 'PC1', agent: '夥伴甲' }, text: '允許' }).handled, false)
  // 不是授權回覆的話：不攔
  assert.equal(ap.handleReply({ worker: 'G', from: { node: 'PC1', agent: '夥伴甲' }, text: '今天天氣如何' }).handled, false)
  assert.equal(ap.handleReply({ worker: 'G', from: { node: 'PC1', agent: '夥伴甲' }, text: '好的，我晚點看' }).handled, false)
  // 單筆：不用編號
  const r = ap.handleReply({ worker: 'G', from: { node: 'PC1', agent: '夥伴甲' }, text: '允許' })
  assert.equal(r.handled, true); assert.equal(r.verdict, 'allow')
  assert.equal(await a1.promise, 'allow')
  assert.equal(ap.size(), 0)
  // 兩筆：要編號
  const b1 = ap.ask({ worker: 'G', summary: 'x', targets: [{ node: 'PC1' }], timeoutMs: 1000 })
  const b2 = ap.ask({ worker: 'G', summary: 'y', targets: [{ node: 'PC1' }], timeoutMs: 1000 })
  const amb = ap.handleReply({ worker: 'G', from: { node: 'PC1', agent: 'x' }, text: '允許' })
  assert.equal(amb.handled, true); assert.equal(amb.id, undefined); assert.match(amb.note, /編號/)
  assert.equal(ap.size(), 2)
  ap.handleReply({ worker: 'G', from: { node: 'PC1', agent: 'x' }, text: `拒絕 ${b2.id}` })
  assert.equal(await b2.promise, 'deny')
  ap.handleReply({ worker: 'G', from: { node: 'PC1', agent: 'x' }, text: `全部允許 ${b1.id}` })
  assert.equal(await b1.promise, 'allow_all')
  // 逾時
  const c = ap.ask({ worker: 'G', summary: 'z', targets: [{ node: 'PC1' }], timeoutMs: 50 })
  timers.at(-1).fn()
  assert.equal(await c.promise, 'timeout')
  assert.equal(ap.size(), 0)
})

test('錯誤分類：登入／額度／其他', () => {
  assert.equal(classifyFailure('Error: not logged in. Run agy to sign in'), 'auth')
  assert.equal(classifyFailure('Authentication required'), 'auth')
  assert.equal(classifyFailure('401 Unauthorized'), 'auth')
  assert.equal(classifyFailure('IneligibleTierError: authenticating failed'), 'auth')
  assert.equal(classifyFailure('RESOURCE_EXHAUSTED: Quota exceeded; check your plan and billing'), 'quota')
  assert.equal(classifyFailure('429 Too Many Requests'), 'quota')
  assert.equal(classifyFailure('invalid model selection'), null)
  assert.equal(classifyFailure(''), null)
})
