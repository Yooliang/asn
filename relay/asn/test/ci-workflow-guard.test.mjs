// CI 的守門：第三方 action 一律鎖到完整 commit；Android 的 WRY 參數不寫死，和 tauri.conf.json／Cargo.toml／Kotlin 套件路徑一致
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const root = new URL('../../../', import.meta.url)
const wfDir = new URL('.github/workflows/', root)
const workflows = fs.readdirSync(wfDir).filter(f => /\.ya?ml$/.test(f)).map(f => [f, fs.readFileSync(new URL(f, wfDir), 'utf8')])
// 共用的本地 composite action（.github/actions/**/*.yml）也要掃：裡面的 uses: 一樣要鎖到完整 commit（#1892）
const actionsDir = new URL('.github/actions/', root)
const actionFiles = fs.existsSync(actionsDir)
  ? fs.readdirSync(actionsDir, { recursive: true }).map(f => String(f).replaceAll('\\', '/')).filter(f => /\.ya?ml$/.test(f)).map(f => [`actions/${f}`, fs.readFileSync(new URL(f, actionsDir), 'utf8')])
  : []

test('每個 workflow 的 uses: 都鎖到 40 位的 commit（本地 ./ 例外）', () => {
  assert.ok(workflows.length >= 3, '找到的 workflow 數不對，檢查規則可能失效')
  const bad = []
  let seen = 0
  assert.ok(actionFiles.length >= 1, '.github/actions/ 底下找不到任何 yml，掃描範圍可能失效')
  for (const [f, src] of [...workflows, ...actionFiles]) {
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

// WezTerm 自建的 release 不能被標成整個 repo 的 Latest（否則 repo 首頁和 releases/latest 會指到 WezTerm，而不是 ASN）。
// 光帶 --latest=false 不夠：repo 沒有別的正式 release 時 GitHub 仍會把它當成 Latest（11-10 asn.1 第一次發佈就是這樣），所以一律建成預發行
test('wezterm-build 的每一處 gh release create 都帶 --latest=false 與 --prerelease', () => {
  const scriptsDir = new URL('.github/scripts/', root)
  const files = [
    ['wezterm-build.yml', fs.readFileSync(new URL('wezterm-build.yml', wfDir), 'utf8')],
    ...fs.readdirSync(scriptsDir).filter(f => /^wezterm-.*\.sh$/.test(f)).map(f => [f, fs.readFileSync(new URL(f, scriptsDir), 'utf8')]),
  ]
  let seen = 0
  const bad = []
  for (const [f, src] of files) {
    for (const line of releaseCreateLines(src)) {
      seen++
      if (!/--latest=false\b/.test(line) || !/--prerelease\b/.test(line)) bad.push(`${f}: ${line.trim().slice(0, 80)}`)
    }
  }
  assert.ok(seen >= 1, '找不到任何 gh release create，檢查規則可能失效')
  assert.deepEqual(bad, [])
})

// 取出每一處 gh release create 的整條指令（接上以反斜線結尾的續行；LF 與 CRLF 都行；註解行不算）
function releaseCreateLines(src) {
  return src.replace(/\\\r?\n/g, ' ').split(/\r?\n/).filter(l => /gh\s+release\s+create\b/.test(l) && !/^\s*#/.test(l))
}

test('releaseCreateLines：LF、CRLF 的續行都接得起來，旗標在第二行也判得出來', () => {
  for (const eol of ['\n', '\r\n']) {
    const withFlag = ['gh release create v1 \\', '  --latest=false \\', '  a.zip'].join(eol)
    const without = ['gh release create v1 \\', '  --title x \\', '  a.zip'].join(eol)
    const l1 = releaseCreateLines(withFlag)
    const l2 = releaseCreateLines(without)
    assert.equal(l1.length, 1)
    assert.match(l1[0], /--latest=false/)
    assert.equal(l2.length, 1)
    assert.doesNotMatch(l2[0], /--latest=false/)
  }
  assert.equal(releaseCreateLines('# gh release create x').length, 0)
})

// #1973 冒煙測試是獨立 job（與 build 並行）：搬出去不能變成「沒人跑冒煙」，也不能在 build 裡又跑一次。
const linuxBuildWf = () => workflows.find(([f]) => f === 'asn-linux-build.yml')[1].replace(/\r\n/g, '\n')
const jobText = (src, name) => {
  const m = src.match(new RegExp(String.raw`^  ${name}:\n([\s\S]*?)(?=^  [A-Za-z0-9_-]+:\n|(?![\s\S]))`, 'm'))
  return m ? m[1] : null
}
const smokeJobProblems = src => {
  const problems = []
  const smoke = jobText(src, 'smoke-ui')
  const build = jobText(src, 'build')
  if (smoke === null) problems.push('沒有 smoke-ui job')
  else {
    if (!/^\s+run: node scripts\/smoke-ui\.mjs\s*$/m.test(smoke)) problems.push('smoke-ui job 沒有跑整支 node scripts/smoke-ui.mjs')
    if (/--only|continue-on-error|\|\| true/.test(smoke)) problems.push('smoke-ui job 不准只跑部分情境或吞掉失敗')
    if (!/node scripts\/prep\.mjs/.test(smoke)) problems.push('smoke-ui job 沒有先跑 prep.mjs（沒有 ui/vendor）')
    if (/^\s+needs:/m.test(smoke)) problems.push('smoke-ui job 不能 needs 別的 job（要和 build 並行）')
  }
  if (build === null) problems.push('沒有 build job')
  else if (/smoke-ui\.mjs|smoke:ui/.test(build)) problems.push('build job 不該再跑冒煙（已搬到 smoke-ui）')
  return problems
}

test('#1973 smoke-ui 是獨立 job：跑整支 smoke-ui.mjs、先 prep、不 needs build；build 不再重複跑冒煙', () => {
  assert.deepEqual(smokeJobProblems(linuxBuildWf()), [])
})

test('#1973 守門本身會紅：拿掉 smoke-ui job、或 build 又跑冒煙、或只跑部分情境，都要被抓到', () => {
  const src = linuxBuildWf()
  const smoke = jobText(src, 'smoke-ui')
  assert.ok(smoke)
  const without = src.replace(`  smoke-ui:\n${smoke}`, '')
  assert.ok(smokeJobProblems(without).some(p => /沒有 smoke-ui job/.test(p)))
  const dup = src.replace('      - name: 上傳成品', '      - name: 冒煙\n        run: node scripts/smoke-ui.mjs\n\n      - name: 上傳成品')
  assert.ok(smokeJobProblems(dup).some(p => /build job 不該再跑冒煙/.test(p)))
  const partial = src.replace('run: node scripts/smoke-ui.mjs', 'run: node scripts/smoke-ui.mjs --only m-signed-in')
  assert.ok(smokeJobProblems(partial).length > 0)
})
