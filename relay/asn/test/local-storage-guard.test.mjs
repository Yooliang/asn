// #2162 ⑧：localStorage 只准經過 ui/lib/local-prefs.mjs（允許清單＋try/catch），其他檔不准直接用。
// 明列例外：skin-boot.js 是不經打包的純腳本（畫面出來前就要套外觀，不能 import），保留內嵌的 localStorage.getItem('asnSkin')。
// 新增鍵：local-prefs.mjs 的 LOCAL_KEYS 與下面 KEYS 要一起改（兩邊不同就紅），這樣新增會被審到。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { LOCAL_KEYS, getLocal, setLocal, removeLocal } from '../ui/lib/local-prefs.mjs'

const UI = fileURLToPath(new URL('../ui', import.meta.url))
const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)])
const rel = f => path.relative(UI, f).split(path.sep).join('/')
const files = walk(UI).filter(f => /\.(m?js|html)$/.test(f)).filter(f => !/(^|\/)vendor\//.test(rel(f)))
const src = f => fs.readFileSync(f, 'utf8')

// 允許清單：與 ui/lib/local-prefs.mjs 的 LOCAL_KEYS 各抄一份
const KEYS = ['asnSkin', 'asnCloudNodes', 'asnNewComputerGuideHidden', 'asnUpdateTestUrl']
const EXCEPTIONS = ['lib/local-prefs.mjs', 'skin-boot.js']

test('local-prefs 的鍵清單與測試抄的那份完全一樣', () => {
  assert.deepEqual([...LOCAL_KEYS], KEYS)
})

test('ui/ 底下除 local-prefs.mjs 與 skin-boot.js 外，不准出現 localStorage／sessionStorage／indexedDB', () => {
  assert.ok(files.length > 50, '掃得到檔案')
  const bad = files.filter(f => !EXCEPTIONS.includes(rel(f))).filter(f => /localStorage|sessionStorage|indexedDB/.test(src(f))).map(rel)
  assert.deepEqual(bad, [], `這些檔直接用了瀏覽器儲存：${bad.join(', ')}（改走 lib/local-prefs.mjs；要跨裝置或可靠保存的走 store）`)
})

test('明列例外都還在用（沒用了就從例外清單拿掉）', () => {
  for (const e of EXCEPTIONS) assert.match(src(path.join(UI, e)), /localStorage/, e)
})

test('呼叫 store(\'xxx\') 的名稱只准是 me、onboard、chats（對應後端 RawName 白名單）', () => {
  const ok = new Set(['me', 'onboard', 'chats'])
  const seen = []
  for (const f of files) for (const m of src(f).matchAll(/(?<![\w.$])store\(\s*(['"`])([^'"`]*)\1/g)) seen.push([rel(f), m[2]])
  assert.ok(seen.length >= 4, '掃得到 store( 呼叫')
  const bad = seen.filter(([, n]) => !ok.has(n)).map(([f, n]) => `${f}：${n}`)
  assert.deepEqual(bad, [], `store 名稱不在白名單：${bad.join('；')}`)
})

test('也不准用 makeStore(\'xxx\') 直接建新名稱（名稱同樣只准 me、onboard、chats）', () => {
  const ok = new Set(['me', 'onboard', 'chats'])
  const seen = []
  for (const f of files) for (const m of src(f).matchAll(/(?<![\w.$])makeStore\(\s*(['"`])([^'"`]*)\1/g)) seen.push([rel(f), m[2]])
  const bad = seen.filter(([, n]) => !ok.has(n)).map(([f, n]) => `${f}：${n}`)
  assert.deepEqual(bad, [], `makeStore 名稱不在白名單：${bad.join('；')}`)
})

// ---- 出口本身的行為 ----
const fake = (init = {}) => { const d = { ...init }; return { d, getItem: k => (k in d ? d[k] : null), setItem: (k, v) => { d[k] = String(v) }, removeItem: k => { delete d[k] } } }

test('getLocal／setLocal／removeLocal：讀寫刪正常，不在清單的鍵直接丟錯', () => {
  const st = fake()
  setLocal('asnSkin', 'modern', st)
  assert.equal(getLocal('asnSkin', st), 'modern')
  removeLocal('asnSkin', st)
  assert.equal(getLocal('asnSkin', st), null)
  for (const f of [() => getLocal('x', st), () => setLocal('x', '1', st), () => removeLocal('x', st)]) assert.throws(f, /允許清單/)
})

test('存放區壞掉或不存在：讀回 null、寫與刪都不丟錯', () => {
  const boom = () => { throw new Error('denied') }
  const broken = { getItem: boom, setItem: boom, removeItem: boom }
  for (const st of [broken, null]) {
    assert.equal(getLocal('asnSkin', st), null)
    assert.doesNotThrow(() => setLocal('asnSkin', 'aero', st))
    assert.doesNotThrow(() => removeLocal('asnSkin', st))
  }
})
