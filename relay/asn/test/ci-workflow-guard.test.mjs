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
const shardCount = smoke => { const m = smoke.match(/^\s+shard: \[([^\]]*)\]/m); return m ? m[1].split(',').filter(x => x.trim()).length : 0 }
const smokeJobProblems = src => {
  const problems = []
  const smoke = jobText(src, 'smoke-ui')
  const build = jobText(src, 'build')
  if (smoke === null) problems.push('沒有 smoke-ui job')
  else {
    if (!/^\s+run: node scripts\/smoke-ui\.mjs --shard=\$\{\{ matrix\.shard \}\}\/\$\{\{ strategy\.job-total \}\} --manifest=.+$/m.test(smoke)) problems.push('smoke-ui job 沒有用 --shard=<片>/<總片數> 與 --manifest 跑 node scripts/smoke-ui.mjs')
    if (/--only|continue-on-error|\|\| true/.test(smoke)) problems.push('smoke-ui job 不准只跑部分情境或吞掉失敗')
    // #1975：4 片並行、fail-fast: false（一片紅其他片照跑完）、每片都上傳清單（不論紅綠）
    if (shardCount(smoke) !== 4) problems.push('smoke-ui job 的 matrix.shard 不是 4 片')
    if (!/^\s+fail-fast: false\s*$/m.test(smoke)) problems.push('smoke-ui job 沒有 fail-fast: false')
    if (!/if: always\(\)\n\s+uses: actions\/upload-artifact@[^\n]*\n\s+with:\n\s+name: smoke-manifest-\$\{\{ matrix\.shard \}\}/.test(smoke)) problems.push('smoke-ui job 沒有（不論紅綠都）上傳本片的情境清單')
    if (!/node scripts\/prep\.mjs/.test(smoke)) problems.push('smoke-ui job 沒有先跑 prep.mjs（沒有 ui/vendor）')
    if (!/apt-install\.sh[^\n]*fonts-droid-fallback/.test(smoke) || !/fc-list :lang=zh/.test(smoke)) problems.push('smoke-ui job 沒有安裝並檢查中文字型（冒煙靠它量長名字省略號）')
    if (/^\s+needs:/m.test(smoke)) problems.push('smoke-ui job 不能 needs 別的 job（要和 build 並行）')
  }
  const gate = jobText(src, 'smoke-ui-gate')
  if (gate === null) problems.push('沒有 smoke-ui-gate 彙總 job')
  else {
    if (!/^    needs: smoke-ui\s*$/m.test(gate)) problems.push('smoke-ui-gate 沒有 needs: smoke-ui')
    if (!/^    if: always\(\)\s*$/m.test(gate)) problems.push('smoke-ui-gate 沒有 if: always()（分片紅了就不會跑，守門等於消失）')
    const n = gate.match(/smoke-shard-gate\.mjs[^\n]*--shards (\d+)/)?.[1]
    if (Number(n) !== shardCount(smoke ?? '')) problems.push(`smoke-ui-gate 的 --shards（${n}）和 matrix 片數（${shardCount(smoke ?? '')}）不一致`)
    if (!/needs\.smoke-ui\.result/.test(gate) || !/!= "success"/.test(gate)) problems.push('smoke-ui-gate 沒有檢查分片本身是否全部成功')
    if (!/download-artifact@[0-9a-f]{40}/.test(gate) || !/smoke-manifest-\*/.test(gate)) problems.push('smoke-ui-gate 沒有下載各片清單')
    if (/continue-on-error|\|\| true/.test(gate.replace(/continue-on-error: true   # 一份都沒有[^\n]*/, '').replace(/\|\| rc=1/g, ''))) problems.push('smoke-ui-gate 不准吞掉失敗')
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
  const nofont = src.replace('no-install-recommends fonts-droid-fallback', 'no-install-recommends fonts-dejavu-core')
  assert.ok(smokeJobProblems(nofont).some(p => /中文字型/.test(p)))
  const partial = src.replace('--manifest=', '--only m-signed-in --manifest=')
  assert.ok(smokeJobProblems(partial).length > 0)
})

test('#1975 冒煙分片守門：matrix 4 片、fail-fast: false、每片上傳清單、彙總 job 一定跑且檢查分片結果；拿掉任何一項都要被抓到', () => {
  const src = linuxBuildWf()
  const has = (s, re) => smokeJobProblems(s).some(p => re.test(p))
  const mut = (a, b) => { assert.ok(src.includes(a), `找不到要改的文字：${a}`); return src.replace(a, b) }
  assert.ok(has(mut('shard: [1, 2, 3, 4]', 'shard: [1, 2, 3]'), /不是 4 片|不一致/))
  assert.ok(has(mut('fail-fast: false\n      matrix:', 'fail-fast: true\n      matrix:'), /fail-fast/))
  assert.ok(has(mut('        if: always()\n        uses: actions/upload-artifact', '        uses: actions/upload-artifact'), /上傳本片/))
  assert.ok(has(src.replace(/^  smoke-ui-gate:\n[\s\S]*?(?=^  build:)/m, ''), /沒有 smoke-ui-gate/))
  assert.ok(has(mut('    needs: smoke-ui\n    if: always()', '    needs: smoke-ui'), /if: always/))
  assert.ok(has(mut('--shards 4', '--shards 3'), /不一致/))
  assert.ok(has(mut('!= "success"', '!= "never"'), /分片本身/))

// #1977 Rust／Node 單元測試（rust-test）與建置＋端到端（build）是兩個並行 job：拆開不能變成「有的測試沒人跑」，也不能兩邊都跑一次。
const splitJobProblems = src => {
  const problems = []
  const rust = jobText(src, 'rust-test')
  const build = jobText(src, 'build')
  if (rust === null) problems.push('沒有 rust-test job')
  if (build === null) problems.push('沒有 build job')
  if (rust === null || build === null) return problems
  for (const [name, text] of [['rust-test', rust], ['build', build]]) {
    if (/^\s+needs:/m.test(text)) problems.push(`${name} job 不能 needs 別的 job（兩個要並行）`)
    if (!/uses: Swatinem\/rust-cache@/.test(text)) problems.push(`${name} job 沒有 rust-cache`)
    if (!/apt-install\.sh/.test(text)) problems.push(`${name} job 沒有走 apt-install.sh 安裝系統依賴`)
    if (!/^\s+run: npm ci\s*$/m.test(text)) problems.push(`${name} job 沒有 npm ci`)
  }
  // rust-test：Node 單元測試 → Rust 單元測試 → keyring 整合測試，順序不能變（npm test 的 pretest 先產 ui/vendor，之後才 cargo test）
  const order = [/^\s+run: npm test\s*$/m, /^\s+run: npm run test:rust\s*$/m, /keystore::linux -- --ignored/]
  const at = order.map(re => rust.search(re))
  if (at.some(i => i < 0)) problems.push('rust-test 少了 npm test、npm run test:rust 或 keyring 整合測試')
  else if (at[0] > at[1] || at[1] > at[2]) problems.push('rust-test 的順序要是 npm test → test:rust → keyring')
  if (/npm run build|xvfb-run|upload-artifact/.test(rust)) problems.push('rust-test 不該做打包、端到端或上傳成品（那是 build 的事）')
  // build：打包、端到端、上傳成品；不再重複跑單元測試
  if (!/npm run build/.test(build)) problems.push('build 沒有打包（npm run build）')
  if (!/xvfb-run -a node --test .*test\/e2e\.test\.mjs/.test(build)) problems.push('build 沒有端到端測試')
  if (!/uses: actions\/upload-artifact@/.test(build)) problems.push('build 沒有上傳成品')
  if (/^\s+run: npm test\s*$/m.test(build) || /npm run test:rust|keystore::linux/.test(build)) problems.push('build 不該再跑單元測試或 keyring（已搬到 rust-test）')
  return problems
}

test('#1977 rust-test 與 build 是兩個並行 job，各自步驟齊全、不重複', () => {
  assert.deepEqual(splitJobProblems(linuxBuildWf()), [])
})

test('#1977 守門本身會紅：拿掉 rust-test、串起兩個 job、少一步、順序顛倒、build 又跑單元測試，都要被抓到', () => {
  const src = linuxBuildWf()
  const rust = jobText(src, 'rust-test')
  assert.ok(rust)
  assert.ok(splitJobProblems(src.replace(`  rust-test:\n${rust}`, '')).some(p => /沒有 rust-test job/.test(p)))
  assert.ok(splitJobProblems(src.replace('  build:\n    runs-on: ubuntu-24.04\n', '  build:\n    needs: rust-test\n    runs-on: ubuntu-24.04\n')).some(p => /needs/.test(p)))
  assert.ok(splitJobProblems(src.replace('run: npm run test:rust', 'run: echo skip')).some(p => /少了/.test(p)))
  assert.ok(splitJobProblems(src.replace('keystore::linux -- --ignored', 'keystore::linux --')).some(p => /少了/.test(p)))
  const swapped = src.replace('        run: npm test\n', '        run: npm run test:rust\n').replace('        run: npm run test:rust\n\n      # 系統金鑰庫', '        run: npm test\n\n      # 系統金鑰庫')
  assert.ok(splitJobProblems(swapped).some(p => /順序/.test(p)), '順序顛倒要被抓到')
  const dup = src.replace('      - name: 建置 deb 與 AppImage', '      - name: 重複的 Rust 測試\n        run: npm run test:rust\n\n      - name: 建置 deb 與 AppImage')
  assert.ok(splitJobProblems(dup).some(p => /build 不該再跑單元測試/.test(p)))
  assert.ok(splitJobProblems(src.replace('        run: npm run build\n', '        run: echo\n').replace(/npm run build/g, 'echo')).some(p => /build 沒有打包/.test(p)))
})
