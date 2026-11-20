// #1892 演練 workflow 的守門：只吃手動觸發、沒有 environment、沒有 secrets、權限只讀、不准略過冒煙／WezTerm、不開除錯記錄。
// 風格比照 ci-workflow-guard（字串與正則，不引入 yaml 套件）。通則：
//   1. 先剝註解再比對（註解裡提到禁字不算違規，也不能拿註解充當正文）；
//   2. flow-style 的 on／permissions／needs（[a, b]、{…}）一律判失敗——解析器不支援，不猜；
//   3. 每條規則附「至少命中 N 次」計數，避免規則靜默失效（一律用 >=）；
//   4. 每條規則附「壞例子」，證明規則會紅。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const root = new URL('../../../', import.meta.url)
const REHEARSAL = '.github/workflows/asn-release-rehearsal.yml'

const listFiles = dir => {
  const base = new URL(dir, root)
  if (!fs.existsSync(base)) return []
  return fs.readdirSync(base, { recursive: true })
    .map(f => String(f).replaceAll('\\', '/'))
    .filter(f => /\.ya?ml$/.test(f))
    .map(f => `${dir}${f}`)
}
// 讀進來先把 CRLF 換成 LF：本機工作樹（autocrlf=true）是 CRLF，壞例子的多行 LF 字串與 includes 比對才找得到
const read = rel => fs.readFileSync(new URL(rel, root), 'utf8').replace(/\r\n/g, '\n')

/** 剝掉 # 註解：整行註解與「空白＋#」之後的尾註解（YAML 的 # 前面一定有空白） */
export const stripComments = src => src.split(/\r?\n/).map(l => l.replace(/(^|\s)#.*$/, '')).join('\n')

/** 取頂層區塊（例如 on:、permissions:）底下縮排的行；沒有回 null */
const topBlock = (src, key) => {
  const lines = src.split('\n')
  const i = lines.findIndex(l => l.startsWith(`${key}:`))
  if (i < 0) return null
  const body = []
  for (let j = i + 1; j < lines.length; j++) {
    if (lines[j].trim() === '') continue
    if (!/^\s/.test(lines[j])) break
    body.push(lines[j])
  }
  return body
}

/** 取 jobs 底下每個 job 的文字：{ 名稱: 整段 } */
const jobsOf = src => {
  const lines = src.split('\n')
  const i = lines.findIndex(l => l.startsWith('jobs:'))
  if (i < 0) return {}
  const out = {}
  let name = null
  for (let j = i + 1; j < lines.length; j++) {
    const l = lines[j]
    if (l.trim() !== '' && !/^\s/.test(l)) break
    const m = /^  ([A-Za-z0-9_-]+):\s*$/.exec(l)
    if (m) { name = m[1]; out[name] = []; continue }
    if (name) out[name].push(l)
  }
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.join('\n')]))
}

/** 取一個 job 文字裡的每個步驟（6 格縮排的 "- " 開頭到下一個步驟前） */
const stepsOf = jobText => jobText.split(/^(?= {6}- )/m).filter(s => /^ {6}- /.test(s))

/** 取步驟裡 with.path 的每一行（單行或 | 區塊）；沒有回 [] */
const uploadPaths = step => {
  const lines = step.split('\n')
  const i = lines.findIndex(l => /^\s+path:/.test(l))
  if (i < 0) return []
  const v = lines[i].replace(/^\s+path:\s*/, '').trim()
  if (!/^[|>][+-]?$/.test(v)) return [v]
  const indent = /^\s*/.exec(lines[i])[0].length
  const out = []
  for (let j = i + 1; j < lines.length; j++) {
    if (lines[j].trim() === '') continue
    if (/^\s*/.exec(lines[j])[0].length <= indent) break
    out.push(lines[j].trim())
  }
  return out
}

const SHOTS_GLOB = '${{ runner.temp }}/asn-smoke-shots/*.png'
const AAB_GLOBS = ['relay/asn/src-tauri/target/play/*.aab', 'relay/asn/src-tauri/target/play/SHA256SUMS.txt']

/** 檢查一份演練檔（或共用 action）；回違規訊息陣列，空陣列＝通過。kind：'workflow' 才檢查觸發與權限 */
export const checkRehearsal = (raw, { kind = 'workflow' } = {}) => {
  const src = stripComments(raw)
  const bad = []
  // flow-style 直接失敗
  for (const m of src.matchAll(/^\s*(on|permissions|needs):[ \t]*([\[{].*)$/gm)) bad.push(`flow-style 的 ${m[1]}:（解析器不支援，請改成區塊寫法）`)
  // 禁字
  for (const s of ['--skip-smoke', 'ASN_SKIP_WEZTERM', 'ACTIONS_STEP_DEBUG', 'pull_request_target']) if (src.includes(s)) bad.push(`不准出現 ${s}`)
  if (/\bset\s+-[A-Za-z]*x/.test(src) || /\b(?:ba|da|z)?sh\s+(?:-\S+\s+)*-[A-Za-z]*x/.test(src)) bad.push('不准 set -x／sh -x／bash -x（會把環境變數印進記錄）')
  // 共用 action 不准自己下載東西（下載走 release-ci.mjs 裡有來源證明的路徑）
  if (kind !== 'workflow') for (const s of ['curl', 'wget', 'Invoke-WebRequest']) if (new RegExp(`(^|[^\\w-])${s}(?![\\w-])`, 'i').test(src)) bad.push(`共用 action 不准出現 ${s}`)
  // 沒有 environment、沒有 secrets（GITHUB_TOKEN 例外）、沒有寫入權限
  if (/^\s*environment\s*:/m.test(src)) bad.push('不准掛 environment')
  for (const m of src.matchAll(/secrets\.(?!GITHUB_TOKEN\b)[A-Za-z0-9_]+/g)) bad.push(`不准引用 ${m[0]}`)
  if (/secrets\s*:\s*inherit/.test(src)) bad.push('不准 secrets: inherit')
  for (const m of src.matchAll(/^\s*([a-z-]+):\s*write\b/gm)) bad.push(`不准寫入權限：${m[1]}: write`)
  if (/write-all/.test(src)) bad.push('不准 write-all')
  if (kind !== 'workflow') return bad

  // 上傳：截圖只能是固定目錄的 *.png、if: failure()、保留 7 天；Android 的 AAB 上傳只能是 *.aab 與 SHA256SUMS.txt
  for (const [name, text] of Object.entries(jobsOf(src))) {
    for (const step of stepsOf(text)) {
      if (!step.includes('actions/upload-artifact@')) continue
      const paths = uploadPaths(step)
      if (paths.some(p => p.includes('asn-smoke-shots'))) {
        if (paths.length !== 1 || paths[0] !== SHOTS_GLOB) bad.push(`job ${name} 截圖上傳的 path 只能是 ${SHOTS_GLOB}`)
        if (!/^\s+if:\s*failure\(\)\s*$/m.test(step)) bad.push(`job ${name} 截圖上傳只能在 if: failure() 時`)
        if (!/retention-days:\s*7\s*$/m.test(step)) bad.push(`job ${name} 截圖上傳要保留 7 天`)
      } else if (name === 'android') {
        for (const p of paths) if (!AAB_GLOBS.includes(p)) bad.push(`android 上傳的 glob 只能是 *.aab 與 SHA256SUMS.txt（截圖例外）：${p}`)
      }
    }
  }
  // android：拋棄式金鑰的目錄不准落在 target/play 底下（那裡的檔會被上傳）
  const androidJob = jobsOf(src).android
  if (androidJob) for (const m of androidJob.matchAll(/ASN_PLAY_KEY_DIR=(\S*)/g)) if (/target\/play|src-tauri/.test(m[1])) bad.push(`拋棄式金鑰目錄不准在 target/play（或 src-tauri）底下：${m[1]}`)

  // 觸發：只有 workflow_dispatch
  const on = topBlock(src, 'on')
  if (!on) bad.push('找不到區塊寫法的 on:')
  else {
    const keys = on.filter(l => /^ {2}[A-Za-z_]+:/.test(l)).map(l => /^ {2}([A-Za-z_]+):/.exec(l)[1])
    if (keys.length !== 1 || keys[0] !== 'workflow_dispatch') bad.push(`on: 只能有 workflow_dispatch，現在是 [${keys.join(', ')}]`)
  }
  // 頂層 permissions 只有 contents: read
  const perms = topBlock(src, 'permissions')
  if (!perms) bad.push('頂層缺 permissions: 區塊')
  else if (perms.map(l => l.trim()).join('|') !== 'contents: read') bad.push(`頂層 permissions 只能是 contents: read，現在是 ${perms.map(l => l.trim()).join(' / ')}`)
  // 每個 job：有自己的 permissions 時只能是 contents: read
  for (const [name, text] of Object.entries(jobsOf(src))) {
    const m = /^ {4}permissions:\s*\n((?: {6}\S.*\n?)+)/m.exec(text)
    if (m && m[1].split('\n').filter(Boolean).map(l => l.trim()).join('|') !== 'contents: read') bad.push(`job ${name} 的 permissions 只能是 contents: read`)
  }
  return bad
}

const rehearsal = read(REHEARSAL)
const actionFiles = listFiles('.github/actions/')

test('演練檔存在，掃描範圍涵蓋演練檔與 .github/actions/（至少命中數）', () => {
  assert.ok(rehearsal.length > 500, '演練檔不見了或是空的')
  assert.ok(actionFiles.length >= 1, `.github/actions/ 只找到 ${actionFiles.length} 個 yml，檢查規則可能失效`)
  assert.ok(Object.keys(jobsOf(stripComments(rehearsal))).length >= 2, '演練檔至少要有 desktop 與 android 兩個 job')
})

test('演練檔通過全部守門', () => {
  assert.deepEqual(checkRehearsal(rehearsal), [])
})

test('.github/actions/ 底下的每個檔都沒有 secrets／environment／寫入權限／略過旗標', () => {
  for (const f of actionFiles) assert.deepEqual(checkRehearsal(read(f), { kind: 'action' }), [], f)
})

test('觸發只有 workflow_dispatch（至少命中 1 個 input）', () => {
  const on = topBlock(stripComments(rehearsal), 'on')
  assert.ok(on && on.length >= 5, 'on: 區塊讀不到，規則可能失效')
  assert.ok(/^ {2}workflow_dispatch:/m.test(on.join('\n')))
  assert.ok(/^ {6}target:/m.test(on.join('\n')), '找不到 target input')
})

test('頂層與每個 job 的 permissions 都只有 contents: read（至少 3 處）', () => {
  const src = stripComments(rehearsal)
  const n = [...src.matchAll(/^\s*permissions:\s*$/gm)].length
  assert.ok(n >= 3, `permissions: 只找到 ${n} 處`)
  assert.equal([...src.matchAll(/^\s*contents:\s*read\s*$/gm)].length, n)
})

test('每個第三方 action 與本地 action 都有用到（至少命中數）', () => {
  const src = stripComments(rehearsal)
  assert.ok([...src.matchAll(/^\s*-?\s*uses:\s*\S+/gm)].length >= 10, 'uses: 數量不對')
  assert.ok([...src.matchAll(/uses:\s*\.\/\.github\/actions\/[\w-]+/g)].length >= 2, '共用 action 沒被兩個 job 用到')
})

test('desktop：checkout 前關 autocrlf、checkout 不留憑證、帶 GH_TOKEN 驗來源證明、跑 release-ci.mjs', () => {
  const src = stripComments(rehearsal)
  const desktop = jobsOf(src).desktop
  assert.ok(desktop, '找不到 desktop job')
  assert.match(desktop, /runs-on:\s*windows-latest/)
  const iCrlf = desktop.indexOf('git config --global core.autocrlf false')
  const iCheckout = desktop.indexOf('actions/checkout@')
  assert.ok(iCrlf >= 0 && iCheckout >= 0 && iCrlf < iCheckout, 'autocrlf 要在 checkout 之前關')
  assert.match(desktop, /node scripts\/release-ci\.mjs/)
  assert.match(desktop, /GH_TOKEN:\s*\$\{\{\s*github\.token\s*\}\}/)
  assert.ok([...src.matchAll(/persist-credentials:\s*false/g)].length >= 2, '兩個 job 的 checkout 都要 persist-credentials: false')
})

test('upload-artifact 的名稱帶 run_attempt 且 overwrite: true（重跑不撞名；至少 3 處）', () => {
  const src = stripComments(rehearsal)
  const uploads = [...src.matchAll(/actions\/upload-artifact@[\s\S]*?(?=\n\s*-\s|\n\S|$)/g)].map(m => m[0])
  assert.ok(uploads.length >= 3, `upload-artifact 只找到 ${uploads.length} 處`)
  for (const u of uploads) {
    assert.match(u, /name:\s*\S*\$\{\{\s*github\.run_attempt\s*\}\}/, u.slice(0, 80))
    assert.match(u, /overwrite:\s*true/)
  }
})

test('android：NDK_HOME 與 ring 編譯器環境同一版、不帶 --upload、不放金鑰', () => {
  const android = jobsOf(stripComments(rehearsal)).android
  assert.ok(android, '找不到 android job')
  for (const k of ['NDK_HOME=', 'CC_aarch64_linux_android=', 'AR_aarch64_linux_android=', 'CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER=']) assert.ok(android.includes(k), `缺 ${k}`)
  assert.match(android, /node scripts\/release-play\.mjs\s*$/m)
  assert.doesNotMatch(android, /--upload|play-upload|ASN_PLAY_SA_FILE/)
})

// ---- 壞例子：每條規則都要真的會紅 ----
const good = rehearsal
const mutate = (from, to) => {
  assert.ok(good.includes(from), `壞例子的替換目標不存在：${from}`)
  return good.replace(from, to)
}
const flagged = (src, re, opts) => checkRehearsal(src, opts).some(m => re.test(m))

test('壞例子：加 pull_request 觸發會紅', () => {
  assert.ok(flagged(mutate('on:\n  workflow_dispatch:', 'on:\n  pull_request:\n  workflow_dispatch:'), /只能有 workflow_dispatch/))
  assert.ok(flagged(mutate('on:\n  workflow_dispatch:', 'on:\n  push:\n  workflow_dispatch:'), /只能有 workflow_dispatch/))
})

test('壞例子：flow-style 的 on／permissions／needs 一律紅', () => {
  assert.ok(flagged('on: [workflow_dispatch]\npermissions:\n  contents: read\n', /flow-style 的 on/))
  assert.ok(flagged('on:\n  workflow_dispatch:\npermissions: {contents: read}\n', /flow-style 的 permissions/))
  assert.ok(flagged('jobs:\n  a:\n    needs: [b, c]\n', /flow-style 的 needs/))
})

test('壞例子：掛 environment 會紅', () => {
  assert.ok(flagged(mutate('    timeout-minutes: 90', '    timeout-minutes: 90\n    environment: release'), /environment/))
})

test('壞例子：引用 secrets.ASN_X 會紅，GITHUB_TOKEN 與註解裡的不算', () => {
  assert.ok(flagged(mutate('GH_TOKEN: ${{ github.token }}', 'GH_TOKEN: ${{ secrets.ASN_X }}'), /secrets\.ASN_X/))
  assert.ok(flagged(mutate('    timeout-minutes: 90', '    timeout-minutes: 90\n    environment: release'), /environment/))
  assert.ok(!flagged(mutate('GH_TOKEN: ${{ github.token }}', 'GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}'), /secrets/))
  assert.ok(!flagged(`${good}\n# secrets.ASN_X 只是註解\n`, /secrets/))
  assert.ok(flagged(`${good}\n    secrets: inherit\n`, /secrets: inherit/))
})

test('壞例子：頂層 permissions 多了或換成別的會紅；job 層加寫入權限會紅', () => {
  assert.ok(flagged(mutate('permissions:\n  contents: read\n\njobs:', 'permissions:\n  contents: read\n  id-token: write\n\njobs:'), /寫入權限|頂層 permissions/))
  assert.ok(flagged(mutate('permissions:\n  contents: read\n\njobs:', 'permissions:\n  contents: write\n\njobs:'), /contents: write/))
  assert.ok(flagged(mutate('    timeout-minutes: 90\n    permissions:\n      contents: read', '    timeout-minutes: 90\n    permissions:\n      contents: read\n      actions: read'), /job desktop 的 permissions/))
  assert.ok(flagged(mutate('permissions:\n  contents: read\n\njobs:', 'permissions: write-all\n\njobs:'), /write-all|頂層/))
})

test('壞例子：--skip-smoke／ASN_SKIP_WEZTERM／ACTIONS_STEP_DEBUG／set -x／pull_request_target 都會紅，註解裡提到不算', () => {
  for (const s of ['--skip-smoke', 'ASN_SKIP_WEZTERM', 'ACTIONS_STEP_DEBUG', 'pull_request_target']) {
    assert.ok(flagged(`${good}\n      - run: echo ${s}\n`, new RegExp(s.replace(/[-]/g, '\\$&'))), s)
    assert.ok(!flagged(`${good}\n# ${s}\n`, new RegExp(s.replace(/[-]/g, '\\$&'))), `${s} 在註解裡不該算`)
  }
  assert.ok(flagged(`${good}\n      - run: set -x\n`, /set -x/))
  assert.ok(flagged(`${good}\n      - run: set -euxo pipefail\n`, /set -x/))
  assert.ok(!flagged(`${good}\n      - run: set -euo pipefail\n`, /set -x/))
})

test('android：上傳的 glob 只有 *.aab 與 SHA256SUMS.txt，金鑰目錄在 RUNNER_TEMP（至少命中數）', () => {
  const android = jobsOf(stripComments(rehearsal)).android
  const ups = stepsOf(android).filter(s => s.includes('actions/upload-artifact@'))
  assert.ok(ups.length >= 2, 'android 的 upload-artifact 步驟數不對，規則可能失效')
  const all = ups.flatMap(uploadPaths)
  for (const g of AAB_GLOBS) assert.ok(all.includes(g), `沒有上傳 ${g}`)
  assert.ok(all.includes(SHOTS_GLOB), '沒有失敗時上傳截圖的步驟')
  assert.match(android, /ASN_PLAY_KEY_DIR=\$RUNNER_TEMP\//)
  assert.match(android, /sha256sum \*\.aab > SHA256SUMS\.txt/)
})

test('壞例子：金鑰目錄落在 target/play、上傳多帶別的檔、截圖上傳放寬都會紅', () => {
  const shotTail = '/asn-smoke-shots/*.png\n          if-no-files-found: ignore\n          retention-days: 7\n          overwrite: true\n\n      - name: 清掉'
  assert.ok(flagged(mutate('ASN_PLAY_KEY_DIR=$RUNNER_TEMP/rehearsal-play-key', 'ASN_PLAY_KEY_DIR=relay/asn/src-tauri/target/play/key'), /拋棄式金鑰目錄/))
  assert.ok(flagged(mutate('            relay/asn/src-tauri/target/play/SHA256SUMS.txt\n', '            relay/asn/src-tauri/target/play/SHA256SUMS.txt\n            relay/asn/src-tauri/target/play/*\n'), /android 上傳的 glob/))
  assert.ok(flagged(mutate('relay/asn/src-tauri/target/play/*.aab', 'relay/asn/src-tauri/target/**'), /android 上傳的 glob/))
  assert.ok(flagged(mutate('        if: failure()\n        uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4.6.2\n        with:\n          name: asn-rehearsal-smoke-shots-android', '        uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4.6.2\n        with:\n          name: asn-rehearsal-smoke-shots-android'), /if: failure\(\)/))
  assert.ok(flagged(mutate(shotTail, shotTail.replace('*.png', '*')), /截圖上傳的 path/))
  assert.ok(flagged(mutate(shotTail, shotTail.replace('retention-days: 7', 'retention-days: 30')), /保留 7 天/))
})

test('壞例子：sh -x／bash -x 會紅，一般的 sh／bash 不會', () => {
  for (const c of ['sh -x script.sh', 'bash -x script.sh', 'bash -ex script.sh', 'bash -e -x s.sh']) assert.ok(flagged(`${good}\n      - run: ${c}\n`, /set -x/), c)
  for (const c of ['sh script.sh', 'bash -e script.sh', 'bash "$GITHUB_WORKSPACE/.github/scripts/apt-install.sh" --no-install-recommends fonts-noto-cjk']) assert.ok(!flagged(`${good}\n      - run: ${c}\n`, /set -x/), c)
})

test('壞例子：共用 action 裡出現 curl／wget／Invoke-WebRequest 會紅，註解與別的詞不算', () => {
  const act = read(actionFiles[0])
  for (const c of ['curl -sSL https://x', 'wget https://x', 'Invoke-WebRequest https://x']) {
    assert.ok(flagged(`${act}\n      - run: ${c}\n`, /共用 action 不准出現/, { kind: 'action' }), c)
    assert.ok(!flagged(`${act}\n# ${c}\n`, /共用 action 不准出現/, { kind: 'action' }), `${c} 在註解裡不該算`)
  }
  assert.ok(!flagged(`${act}\n      - run: echo curly-wget_x\n`, /共用 action 不准出現/, { kind: 'action' }))
  assert.deepEqual(checkRehearsal(act, { kind: 'action' }), [])
})

test('壞例子：共用 action 裡出現 secrets／environment／contents: write 會紅', () => {
  const act = actionFiles.length ? read(actionFiles[0]) : ''
  assert.ok(act.length > 0)
  assert.ok(flagged(`${act}\n    env:\n      K: \${{ secrets.ASN_X }}\n`, /secrets\.ASN_X/, { kind: 'action' }))
  assert.ok(flagged(`${act}\n    environment: release\n`, /environment/, { kind: 'action' }))
  assert.ok(flagged(`${act}\npermissions:\n  contents: write\n`, /contents: write/, { kind: 'action' }))
})

test('stripComments：整行與尾註解都剝掉，字串內沒有空白前綴的 # 保留', () => {
  assert.equal(stripComments('a: 1 # x\n# y\nb: c#d'), 'a: 1\n\nb: c#d')
})
