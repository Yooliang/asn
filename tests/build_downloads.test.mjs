// 下載區打包（node --test tests/build_downloads.test.mjs）：zip 內容清單、排除規則、downloads.json、zip 讀寫、註冊小幫手（假伺服器）。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { buildDownloads, windowsEntries, FORBIDDEN_IN_ZIP, WINDOWS_ZIP, LEGACY_WINDOWS_ZIP } from '../tools/release/build_downloads.mjs'
import { buildZip, listZip } from '../tools/release/zip_lite.mjs'
import { registerNode, checkNode, leaveNode, suggestNodeId, applyPrefix } from '../relay/machine/register.mjs'
import { fakeRelay } from './_fake_relay.mjs'

const tmp = prefix => fs.mkdtempSync(path.join(os.tmpdir(), prefix))
const sha = buf => crypto.createHash('sha256').update(buf).digest('hex')
let built
const build = () => (built ??= buildDownloads({ outDir: tmp('irori-dl-test-') }))
const zipNames = () => listZip(fs.readFileSync(build().zipPath)).map(e => e.name)

test('zip_lite：中文檔名、空檔、壓不下去的檔案都能來回，CRC 驗證通過', () => {
  const rnd = crypto.randomBytes(500)
  const zip = buildZip([
    { name: '安裝.cmd', data: Buffer.from('@echo off\r\n') },
    { name: 'app/空.txt', data: Buffer.alloc(0) },
    { name: 'app/rnd.bin', data: rnd },
    { name: 'app/長.txt', data: Buffer.from('abc'.repeat(1000)) },
  ])
  const back = Object.fromEntries(listZip(zip).map(e => [e.name, e.data]))
  assert.deepEqual(Object.keys(back).sort(), ['app/rnd.bin', 'app/空.txt', 'app/長.txt', '安裝.cmd'].sort())
  assert.equal(back['安裝.cmd'].toString(), '@echo off\r\n')
  assert.ok(back['app/rnd.bin'].equals(rnd))
  assert.equal(back['app/長.txt'].length, 3000)
  assert.throws(() => buildZip([{ name: '../evil', data: Buffer.from('x') }]))
  assert.throws(() => buildZip([{ name: 'a\\b', data: Buffer.from('x') }]))
})

test('Windows zip：必要的檔案都在（程式、安裝／解除安裝、使用說明、版本）', () => {
  const names = zipNames()
  for (const must of ['安裝.cmd', '解除安裝.cmd', 'install.ps1', 'uninstall.ps1', 'asn-common.ps1', 'irori-common.ps1', '使用說明.txt',
    'app/bridge.mjs', 'app/send.mjs', 'app/recv.mjs', 'app/room.mjs', 'app/identity.mjs', 'app/register.mjs',
    'app/install-task.ps1', 'app/run-bridge.ps1', 'app/package.json', 'app/README.md', 'app/VERSION.json', 'app/engines/claude.mjs', 'app/engines/index.mjs']) {
    assert.ok(names.includes(must), `缺 ${must}`)
  }
})

test('Windows zip：不含金鑰、測試、紀錄、開發工具、執行狀態，也沒有 skill zip', () => {
  const names = zipNames()
  for (const n of names) assert.ok(!FORBIDDEN_IN_ZIP.test(n), `不該出現：${n}`)
  assert.ok(!names.some(n => /(^|\/)test\//.test(n) || /(^|\/)tools-/.test(n) || /\.key$/.test(n) || /\.log$/.test(n) || /pending\.json/.test(n) || /\.pid$/.test(n)))
  assert.ok(!names.some(n => /aegis|\.service$/.test(n)), 'Linux／Aegis 專用檔不進 Windows 包')
  assert.ok(!fs.existsSync(path.join(build().outDir, 'irori-relay-skill.zip')))
})

test('排除規則：用假的專案目錄塞進金鑰／測試／紀錄／開發工具，全部不會進 zip', () => {
  const repo = tmp('irori-fakerepo-')
  const m = path.join(repo, 'relay', 'machine')
  fs.mkdirSync(path.join(m, 'test'), { recursive: true })
  fs.mkdirSync(path.join(m, 'installer'), { recursive: true })
  fs.mkdirSync(path.join(m, 'engines'), { recursive: true })
  fs.mkdirSync(path.join(m, 'node_modules', 'x'), { recursive: true })
  for (const f of ['bridge.mjs', 'engines/a.mjs', 'H.key', 'W-1.key', 'pending.json', 'bridge.log', 'bridge.pid', 'mailbox.pid', 'tools-roundtrip.mjs',
    'test/a.test.mjs', 'node_modules/x/i.js', '.env', 'bridge-aegis.mjs', 'irori-relay-aegis.service', 'agents.example.json']) {
    fs.writeFileSync(path.join(m, f), 'SECRET-DO-NOT-SHIP')
  }
  fs.writeFileSync(path.join(m, 'installer', 'install.ps1'), 'x')
  const names = windowsEntries(repo, { sha: 't', date: '2026-01-01' }).map(e => e.name).sort()
  assert.deepEqual(names, ['app/VERSION.json', 'app/agents.example.json', 'app/bridge.mjs', 'app/engines/a.mjs', 'install.ps1'])
})

test('文字檔格式：.ps1／.txt 有 UTF-8 BOM、.cmd／.ps1 是 CRLF、.cmd 只有 ASCII（Windows 才不會亂碼）', () => {
  const files = Object.fromEntries(listZip(fs.readFileSync(build().zipPath)).map(e => [e.name, e.data]))
  for (const n of ['install.ps1', 'uninstall.ps1', 'asn-common.ps1', 'irori-common.ps1', 'app/install-task.ps1', 'app/run-bridge.ps1', '使用說明.txt']) {
    assert.deepEqual([...files[n].subarray(0, 3)], [0xef, 0xbb, 0xbf], `${n} 缺 BOM`)
  }
  for (const n of ['安裝.cmd', '解除安裝.cmd']) {
    assert.ok(/^[\x00-\x7f]*$/.test(files[n].toString('latin1')), `${n} 含非 ASCII`)
    assert.ok(files[n].toString().includes('\r\n') && !/[^\r]\n/.test(files[n].toString()), `${n} 不是 CRLF`)
  }
  assert.ok(!/[^\r]\n/.test(files['install.ps1'].toString()))
})

test('zip 裡每個 .mjs 的相對 import 都找得到檔案（少打包任何一支就會壞）', () => {
  const entries = listZip(fs.readFileSync(build().zipPath))
  const names = new Set(entries.map(e => e.name))
  let checked = 0
  for (const e of entries.filter(x => x.name.endsWith('.mjs'))) {
    const src = e.data.toString('utf8')
    for (const m of src.matchAll(/(?:from\s+|import\s*\(\s*|import\s+)['"](\.{1,2}\/[^'"]+)['"]/g)) {
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(e.name), m[1]))
      assert.ok(names.has(target), `${e.name} 引用了 ${m[1]}，zip 裡沒有 ${target}`)
      checked++
    }
  }
  assert.ok(checked > 20)
})

test('downloads.json：版本（git 短 sha＋日期）、大小、sha256 與實際檔案一致', () => {
  const { outDir, manifest } = build()
  const onDisk = JSON.parse(fs.readFileSync(path.join(outDir, 'downloads.json'), 'utf8'))
  assert.deepEqual(onDisk, manifest)
  const w = manifest.files[WINDOWS_ZIP]
  const buf = fs.readFileSync(path.join(outDir, WINDOWS_ZIP))
  assert.equal(w.size, buf.length)
  assert.equal(w.sha256, sha(buf))
  assert.match(w.version, /^[0-9a-f]{7,}(-dirty)? \(\d{4}-\d{2}-\d{2}\)$/)
  assert.equal(w.url, 'https://asnmessenger.web.app/download/asn-windows.zip')
  // 舊檔名仍產出、內容與新檔名一模一樣（舊網址與舊連結不會壞）
  const old = manifest.files[LEGACY_WINDOWS_ZIP]
  assert.equal(old.url, 'https://asnmessenger.web.app/download/irori-windows.zip')
  assert.equal(old.sha256, w.sha256)
  assert.ok(fs.readFileSync(path.join(outDir, LEGACY_WINDOWS_ZIP)).equals(buf))
  const v = JSON.parse(listZip(buf).find(e => e.name === 'app/VERSION.json').data.toString())
  assert.equal(w.version, `${v.sha} (${v.date})`)
  assert.ok(!('irori-relay-skill.zip' in manifest.files))
  assert.equal(manifest.files['SKILL.md'].sha256, sha(fs.readFileSync(new URL('../web/relay/SKILL.md', import.meta.url))))
})

test('同一份內容打包兩次，zip 的 sha256 一樣（可重現）；--include 的檔案會列進去', () => {
  const extra = path.join(tmp('irori-extra-'), 'irori.apk')
  fs.writeFileSync(extra, 'fake apk')
  const a = buildDownloads({ outDir: tmp('irori-dl-a-') })
  const b = buildDownloads({ outDir: tmp('irori-dl-b-'), include: [extra] })
  assert.equal(a.manifest.files[WINDOWS_ZIP].sha256, b.manifest.files[WINDOWS_ZIP].sha256)
  assert.equal(b.manifest.files['irori.apk'].sha256, sha(Buffer.from('fake apk')))
})

// 下載檔在 ASN 自己的網站（F2 #424）：預設輸出到 site/public/download/、二進位檔不進 git、zip 與 json 有正確的標頭
test('下載區：預設輸出資料夾是 site/public/download，網址基底是 asnmessenger.web.app', async () => {
  const m = await import('../tools/release/build_downloads.mjs')
  assert.equal(path.relative(m.REPO, m.DEFAULT_OUT).split(path.sep).join('/'), 'site/public/download')
  assert.equal(m.PUBLIC_BASE, 'https://asnmessenger.web.app/download')
})

test('下載區：firebase.json 給 zip 與 downloads.json 標頭；.gitignore 擋掉產出的檔案', () => {
  const cfg = JSON.parse(fs.readFileSync(new URL('../site/firebase.json', import.meta.url), 'utf8'))
  const rule = src => cfg.hosting.headers.find(h => h.source === src)?.headers ?? []
  const val = (src, key) => rule(src).find(h => h.key === key)?.value
  assert.equal(val('download/*.zip', 'Content-Type'), 'application/zip')
  assert.equal(val('download/downloads.json', 'Content-Type'), 'application/json')
  assert.equal(val('download/downloads.json', 'Cache-Control'), 'no-cache')
  const ignore = fs.readFileSync(new URL('../.gitignore', import.meta.url), 'utf8')
  assert.match(ignore, /^site\/public\/download\/\*\.zip$/m)
  assert.match(ignore, /^site\/public\/download\/downloads\.json$/m)
  // 舊的轉址規則不在這個站（irori.web.app 是另一個專案，轉址移到 F6 前置）
  assert.ok(!(cfg.hosting.redirects ?? []).some(r => String(r.source).startsWith('/download')))
})
// ---- 註冊小幫手（假伺服器）----

test('代號建議：只留合法字元、≤32 字、前綴補在前面、不佔 t<數字>- 開頭', () => {
  assert.equal(suggestNodeId('AB12-PC'), 'AB12-PC')
  assert.equal(suggestNodeId('小美 的 筆電'), 'PC')
  assert.equal(suggestNodeId('my laptop!'), 'my-laptop')
  assert.equal(suggestNodeId('x'.repeat(50)).length, 32)
  assert.equal(suggestNodeId('pc1', 'W-'), 'W-pc1')
  assert.equal(applyPrefix('W-pc1', 'W-'), 'W-pc1')
  assert.equal(suggestNodeId('x'.repeat(40), 'W-').length, 32)
  assert.equal(suggestNodeId('t2-box'), 'pc-t2-box')
})

test('註冊：成功寫金鑰檔與 node 檔、讀回一致，回傳值與輸出不含金鑰；邀請碼只能用一次', async () => {
  const srv = await fakeRelay({ invites: { CODE1: {} } })
  const home = tmp('irori-reg-')
  const r = await registerNode({ baseUrl: srv.url, invite: 'CODE1', id: 'PC-1', name: '小美的筆電', machine: '小美的筆電', home })
  assert.deepEqual(r, { ok: true, id: 'PC-1', verified: true })
  const key = fs.readFileSync(path.join(home, '.asn', 'PC-1.key'), 'utf8')
  assert.equal(key, srv.issued[0])
  assert.ok(!JSON.stringify(r).includes(key))
  assert.equal(fs.readFileSync(path.join(home, '.asn', 'node'), 'utf8'), 'PC-1')
  assert.equal(srv.registers[0].kind, 'other')
  assert.equal(srv.registers[0].machine, '小美的筆電')
  const again = await registerNode({ baseUrl: srv.url, invite: 'CODE1', id: 'PC-2', name: 'x', machine: 'x', home })
  assert.equal(again.ok, false); assert.equal(again.error, 'invalid_invite')
  assert.ok(!fs.existsSync(path.join(home, '.asn', 'PC-2.key')))
  await srv.close()
})

test('註冊：node 檔已經有了就不改（替別台註冊不會改掉這台的身分）；帶 setNode 才改', async () => {
  const srv = await fakeRelay({ invites: { X: {}, Y: {} } })
  try {
    const home = tmp('irori-reg-node-')
    fs.mkdirSync(path.join(home, '.asn'), { recursive: true })
    fs.writeFileSync(path.join(home, '.asn', 'node'), 'H')
    assert.equal((await registerNode({ baseUrl: srv.url, invite: 'X', id: 'grok', name: 'Grok 雲端', machine: 'grok-cloud', home })).ok, true)
    assert.equal(fs.readFileSync(path.join(home, '.asn', 'node'), 'utf8'), 'H')
    assert.equal((await registerNode({ baseUrl: srv.url, invite: 'Y', id: 'PC-9', name: 'x', machine: 'x', home, setNode: true })).ok, true)
    assert.equal(fs.readFileSync(path.join(home, '.asn', 'node'), 'utf8'), 'PC-9')
  } finally { await srv.close() }
})

test('註冊：撞名、前綴不符、格式錯、網路不通都回白話訊息，且不寫任何檔案', async () => {
  const srv = await fakeRelay({ invites: { A: {}, B: { prefix: 'W-' }, C: {} }, takenIds: ['TAKEN'] })
  const home = tmp('irori-reg2-')
  const taken = await registerNode({ baseUrl: srv.url, invite: 'A', id: 'TAKEN', name: 'n', machine: 'm', home })
  assert.equal(taken.error, 'id_taken'); assert.match(taken.message, /已經有人用/)
  const pref = await registerNode({ baseUrl: srv.url, invite: 'B', id: 'pc1', name: 'n', machine: 'm', home })
  assert.equal(pref.error, 'bad_id_prefix'); assert.equal(pref.prefix, 'W-'); assert.match(pref.message, /W-/)
  const okAfterPrefix = await registerNode({ baseUrl: srv.url, invite: 'B', id: suggestNodeId('pc1', 'W-'), name: 'n', machine: 'm', home })
  assert.equal(okAfterPrefix.ok, true, '前綴不符時邀請碼沒被用掉，補前綴後可以再用')
  const bad = await registerNode({ baseUrl: srv.url, invite: 'C', id: 'bad id!', name: 'n', machine: 'm', home })
  assert.equal(bad.error, 'bad_request')
  const empty = await registerNode({ baseUrl: srv.url, invite: '  ', id: 'x', name: 'n', machine: 'm', home })
  assert.equal(empty.error, 'bad_request')
  assert.deepEqual(fs.readdirSync(path.join(home, '.asn')).sort(), ['W-pc1.key', 'node'])
  await srv.close()
  const down = await registerNode({ baseUrl: srv.url, invite: 'C', id: 'x1', name: 'n', machine: 'm', home })
  assert.equal(down.error, 'network'); assert.match(down.message, /網路/)
})

test('註冊：機器名稱超過 40 字會被截成 40（後端上限），check／leave 用已存的金鑰', async () => {
  const srv = await fakeRelay({ invites: { A: {} } })
  const home = tmp('irori-reg3-')
  const long = '機'.repeat(60)
  const r = await registerNode({ baseUrl: srv.url, invite: 'A', id: 'LONG-1', name: long, machine: long, home })
  assert.equal(r.ok, true)
  assert.equal(srv.registers[0].machine.length, 40)
  assert.equal((await checkNode({ baseUrl: srv.url, id: 'LONG-1', home })).ok, true)
  assert.equal((await leaveNode({ baseUrl: srv.url, id: 'LONG-1', home })).ok, true)
  assert.equal((await checkNode({ baseUrl: srv.url, id: 'LONG-1', home })).ok, false, '離開後金鑰作廢')
  assert.equal((await checkNode({ baseUrl: srv.url, id: 'NOPE', home })).error, 'no_key')
  await srv.close()
})
