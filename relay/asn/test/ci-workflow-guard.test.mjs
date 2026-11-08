// CI 的守門：第三方 action 一律鎖到完整 commit；Android 的 WRY 參數不寫死，和 tauri.conf.json／Cargo.toml／Kotlin 套件路徑一致
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const root = new URL('../../../', import.meta.url)
const wfDir = new URL('.github/workflows/', root)
const workflows = fs.readdirSync(wfDir).filter(f => /\.ya?ml$/.test(f)).map(f => [f, fs.readFileSync(new URL(f, wfDir), 'utf8')])

test('每個 workflow 的 uses: 都鎖到 40 位的 commit（本地 ./ 例外）', () => {
  assert.ok(workflows.length >= 3, '找到的 workflow 數不對，檢查規則可能失效')
  const bad = []
  let seen = 0
  for (const [f, src] of workflows) {
    for (const m of src.matchAll(/^\s*-?\s*uses:\s*(\S+)/gm)) {
      seen++
      const ref = m[1]
      if (ref.startsWith('./')) continue
      if (!/^[\w.-]+\/[\w.\/-]+@[0-9a-f]{40}$/.test(ref)) bad.push(`${f}: ${ref}`)
    }
  }
  assert.ok(seen >= 20, `uses: 只找到 ${seen} 個，檢查規則可能失效`)
  assert.deepEqual(bad, [])
})

test('android-kotlin 的 WRY 參數不寫死，從 tauri.conf.json 與 Cargo.toml 讀', () => {
  const src = workflows.find(([f]) => f === 'asn-linux-build.yml')[1]
  assert.ok(!/WRY_ANDROID_PACKAGE:\s*\S/.test(src) && !/WRY_ANDROID_LIBRARY:\s*\S/.test(src), '不能在 env: 寫死')
  assert.match(src, /require\('\.\/tauri\.conf\.json'\)\.identifier/)
  assert.match(src, /\[lib\\\]/)
})

test('identifier、Kotlin 套件路徑、MainActivity 的 package 三者一致；[lib] name 存在', () => {
  const tauri = new URL('relay/asn/src-tauri/', root)
  const id = JSON.parse(fs.readFileSync(new URL('tauri.conf.json', tauri), 'utf8')).identifier
  assert.match(id, /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/)
  const main = fs.readFileSync(new URL(`gen/android/app/src/main/java/${id.replaceAll('.', '/')}/MainActivity.kt`, tauri), 'utf8')
  assert.match(main, new RegExp(`^package ${id.replaceAll('.', '\\.')}\\s*$`, 'm'))
  const cargo = fs.readFileSync(new URL('Cargo.toml', tauri), 'utf8')
  const lib = cargo.split(/\r?\n\[/).find(s => s.startsWith('lib]'))
  assert.match(lib ?? '', /^name\s*=\s*"[a-z][a-z0-9_]*"/m)
})
