// 預設後台網址守門：所有用戶端預設指向新後台（Supabase 專案 asn 的 relay 函式），環境變數 IRORI_RELAY_URL 仍可覆寫；
// 程式與 skill 裡不得殘留舊後台（舊 Irori 專案、irori-relay 函式）的網址。
// 執行：node --test relay/machine/test/
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { DEFAULT_URL } from '../register.mjs'

const NEW_URL = 'https://etccgmkrosbzpltudlgt.supabase.co/functions/v1/relay'
const OLD_REF = 'hwtahctsgjcemtwzlvnq'
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

test('register.mjs 的 DEFAULT_URL 是新後台', () => { assert.equal(DEFAULT_URL, NEW_URL) })

function baseUrlIn(env) {
  const id = pathToFileURL(path.join(ROOT, 'relay', 'machine', 'identity.mjs')).href
  const e = { ...process.env }; delete e.IRORI_RELAY_URL; delete e.ASN_RELAY_URL; Object.assign(e, env)
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', `import('${id}').then(m => console.log(m.BASE_URL))`], { env: e, encoding: 'utf8' })
  return r.stdout.trim()
}

test('identity.mjs：沒設變數＝新後台；IRORI_RELAY_URL 可覆寫並去尾斜線', () => {
  assert.equal(baseUrlIn({}), NEW_URL)
  assert.equal(baseUrlIn({ IRORI_RELAY_URL: 'http://127.0.0.1:9/x//' }), 'http://127.0.0.1:9/x')
})

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', 'target', 'test', '.git', 'dist'].includes(e.name)) continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (/\.(mjs|js|ps1|rs|md|txt|sh|json|service|cmd)$/.test(e.name) && e.name !== 'package-lock.json') out.push(p)
  }
  return out
}

test('relay/ 與 web/relay/ 沒有殘留舊後台網址或舊函式路徑', () => {
  const bad = []
  for (const f of [...walk(path.join(ROOT, 'relay')), ...walk(path.join(ROOT, 'web', 'relay'))]) {
    const t = fs.readFileSync(f, 'utf8')
    if (t.includes(OLD_REF) || /functions\/v1\/irori-relay/.test(t)) bad.push(path.relative(ROOT, f))
  }
  assert.deepEqual(bad, [])
})
