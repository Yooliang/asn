// #1954 讀 DevToolsActivePort：慢 runner 上剛建檔會撞 EBUSY，要短輪詢重試，不能直接讓冒煙失敗
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readDevToolsPort, parseDevToolsPort } from '../scripts/devtools-port.mjs'

const err = code => Object.assign(new Error(`${code}: resource busy or locked, open 'DevToolsActivePort'`), { code })
const GOOD = '53117\n/devtools/browser/0b5c6f0e-1111-2222-3333-444455556666\n'

// 假時鐘：sleep 只把時間往前推，不真的等
const clock = () => {
  let t = 0
  return { now: () => t, sleep: async ms => { t += ms }, elapsed: () => t }
}

test('#1954 前幾次 EBUSY、之後讀得到：重試後拿到埠號與路徑', async () => {
  const c = clock()
  let n = 0
  const read = () => { n++; if (n <= 3) throw err('EBUSY'); return GOOD }
  const r = await readDevToolsPort('x', { read, now: c.now, sleep: c.sleep })
  assert.deepEqual(r, { port: '53117', wsPath: '/devtools/browser/0b5c6f0e-1111-2222-3333-444455556666' })
  assert.equal(n, 4)
  assert.equal(c.elapsed(), 300, '每次間隔 100ms')
})

test('#1954 ENOENT 與「還沒寫完」也重試', async () => {
  const c = clock()
  const seq = [() => { throw err('ENOENT') }, () => '53117', () => '53117\n', () => GOOD]
  const r = await readDevToolsPort('x', { read: () => seq.shift()(), now: c.now, sleep: c.sleep })
  assert.equal(r.port, '53117')
})

test('#1954 一直 EBUSY：5 秒後明確失敗，訊息寫出原因與檔名', async () => {
  const c = clock()
  let n = 0
  await assert.rejects(
    readDevToolsPort('C:/tmp/asn-smoke-x/DevToolsActivePort', { read: () => { n++; throw err('EBUSY') }, now: c.now, sleep: c.sleep }),
    e => /5 秒內一直是 EBUSY/.test(e.message) && e.message.includes('DevToolsActivePort'))
  assert.equal(c.elapsed(), 5000)
  assert.equal(n, 51, '0ms 到 5000ms 每 100ms 一次')
})

test('#1954 其他錯誤（例如 EACCES）不重試，原錯誤直接丟出', async () => {
  const c = clock()
  let n = 0
  await assert.rejects(readDevToolsPort('x', { read: () => { n++; throw err('EACCES') }, now: c.now, sleep: c.sleep }), e => e.code === 'EACCES')
  assert.equal(n, 1)
})

test('#1954 真檔案：寫一份 Chrome 格式的檔（CRLF 也行），讀出埠號與路徑', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asn-devport-'))
  try {
    const f = path.join(dir, 'DevToolsActivePort')
    fs.writeFileSync(f, GOOD.replace(/\n/g, '\r\n'))
    assert.deepEqual(await readDevToolsPort(f), parseDevToolsPort(GOOD))
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('#1954 三支開瀏覽器的腳本都改用 readDevToolsPort（兄弟副本不留直接讀檔）', () => {
  for (const f of ['smoke-ui.mjs', 'ui-shots.mjs', 'hit-targets.mjs']) {
    const src = fs.readFileSync(new URL(`../scripts/${f}`, import.meta.url), 'utf8')
    assert.ok(src.includes('DevToolsActivePort'), `前提：${f} 會開瀏覽器讀偵錯連線檔`)
    assert.match(src, /await readDevToolsPort\(portFile\)/, f)
    assert.ok(!/readFileSync\(portFile/.test(src), `${f} 不能再直接讀 portFile`)
  }
})
