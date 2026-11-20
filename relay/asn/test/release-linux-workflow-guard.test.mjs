// Linux 發版 workflow（asn-release-linux.yml）的守門：只吃 linux-v 標籤、無 secrets／environment、權限最小、action 釘 SHA。
// 風格比照 release-workflow-guard（字串與正則、先正規化換行與剝註解）；每條規則附壞例子，證明會紅。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { GUARD_STEPS, ALL_JOBS } from '../../../tools/release/notify_status.mjs'

const root = new URL('../../../', import.meta.url)
const FILE = '.github/workflows/asn-release-linux.yml'
const read = rel => fs.readFileSync(new URL(rel, root), 'utf8').replace(/\r\n/g, '\n')
const strip = src => src.replace(/\r\n/g, '\n').split('\n').map(l => l.replace(/(^|\s)#.*$/, '')).join('\n')
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
const jobsOf = src => {
  const lines = src.split('\n')
  const i = lines.findIndex(l => l.startsWith('jobs:'))
  const out = {}
  let name = null
  for (let j = i + 1; j < lines.length; j++) {
    const l = lines[j]
    if (l.trim() !== '' && !/^\s/.test(l)) break
    const m = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(l)
    if (m) { name = m[1]; out[name] = []; continue }
    if (name) out[name].push(l)
  }
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.join('\n')]))
}
const needsOf = text => {
  const m = /^ {4}needs:[ \t]*(\S.*)?$/m.exec(text)
  if (!m) return []
  if (m[1]) return [m[1].trim()]
  const out = []
  for (const l of text.slice(m.index + m[0].length).split('\n').slice(1)) { const x = /^ {6}- (\S+)\s*$/.exec(l); if (x) out.push(x[1]); else if (l.trim() !== '') break }
  return out
}
const permsOf = text => {
  const m = /^ {4}permissions:\s*\n((?: {6}\S.*\n?)+)/m.exec(text)
  return m ? Object.fromEntries(m[1].split('\n').filter(Boolean).map(l => l.trim().split(/:\s*/))) : null
}
const sorted = o => Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}: ${v}`).join(', ')

const JOBS_WANT = ['guard', 'linux', 'attest-linux', 'notify']
const TABLE = {
  guard: { contents: 'read', actions: 'read' },
  linux: { contents: 'read' },
  'attest-linux': { contents: 'read', 'id-token': 'write', attestations: 'write' },
  notify: { contents: 'read', issues: 'write' },
}

/** 回違規訊息陣列，空陣列＝通過 */
export const checkLinux = raw => {
  const src = strip(raw)
  const bad = []
  for (const m of src.matchAll(/^\s*(on|permissions|needs):[ \t]*([\[{].*)$/gm)) bad.push(`flow-style 的 ${m[1]}:`)
  const on = topBlock(src, 'on') ?? []
  if (on.filter(l => /^ {2}\S/.test(l)).map(l => l.trim()).join() !== 'push:') bad.push('on: 只能有 push')
  if (on.filter(l => /^ {4}\S/.test(l)).map(l => l.trim()).join() !== 'tags:') bad.push('on.push 底下只能有 tags:')
  if (on.filter(l => /^ {6}- /.test(l)).map(l => l.trim().slice(2)).join() !== "'linux-v*.*.*'") bad.push("標籤規則只能是 'linux-v*.*.*'")
  if (/workflow_dispatch/.test(src)) bad.push('不准 workflow_dispatch')
  if (/secrets\.(?!GITHUB_TOKEN\b)\w+/.test(src)) bad.push('不准有 secrets.')
  if (/secrets\s*:\s*inherit/.test(src)) bad.push('不准 secrets: inherit')
  if (/^\s*environment\s*:/m.test(src)) bad.push('不准有 environment:')
  if (/contents:\s*write|write-all/.test(src)) bad.push('不准 contents: write')
  if (topBlock(src, 'permissions')?.map(l => l.trim()).join('|') !== 'contents: read') bad.push('頂層 permissions 只能是 contents: read')
  if (/\bset\s+-[A-Za-z]*x/.test(src)) bad.push('不准 set -x')
  const jobs = jobsOf(src)
  if (Object.keys(jobs).join() !== JOBS_WANT.join()) bad.push(`job 清單不對：[${Object.keys(jobs).join(', ')}]`)
  for (const name of JOBS_WANT) {
    const t = jobs[name]
    if (t === undefined) continue
    const p = permsOf(t)
    if (!p || sorted(p) !== sorted(TABLE[name])) bad.push(`job ${name} 的 permissions 要是 {${sorted(TABLE[name])}}`)
    if (!/^ {4}timeout-minutes:\s*\d+\s*$/m.test(t)) bad.push(`job ${name} 缺 timeout-minutes`)
  }
  for (const [k, only] of [['id-token', 'attest-linux'], ['attestations', 'attest-linux'], ['issues', 'notify'], ['actions', 'guard']]) {
    for (const [name, t] of Object.entries(jobs)) if (name !== only && new RegExp(`^\\s+${k}:`, 'm').test(t)) bad.push(`${k} 只能在 ${only}，但 ${name} 有`)
  }
  for (const m of src.matchAll(/^\s*-?\s*uses:\s*(\S+)/gm)) if (!/^[\w.-]+\/[\w.\/-]+@[0-9a-f]{40}$/.test(m[1])) bad.push(`action 沒鎖到 40 位 commit：${m[1]}`)
  // 每個 checkout 都關掉憑證留存
  const co = [...src.matchAll(/uses:\s*actions\/checkout@[^\n]*\n((?: {8,}\S.*\n)+)/g)]
  if (co.length < 3) bad.push('checkout 命中數太少')
  for (const m of co) if (!/persist-credentials:\s*false/.test(m[1])) bad.push('checkout 沒有 persist-credentials: false')
  // 下游看 auto、順序
  if (jobs.linux !== undefined && !/^ {4}if: needs\.guard\.outputs\.auto == 'true'\s*$/m.test(jobs.linux)) bad.push("job linux 要有 if: needs.guard.outputs.auto == 'true'")
  if (jobs.linux !== undefined && needsOf(jobs.linux).join() !== 'guard') bad.push('linux 只能依賴 guard')
  if (jobs['attest-linux'] !== undefined && needsOf(jobs['attest-linux']).join() !== 'linux') bad.push('attest-linux 要在 linux 之後')
  if (jobs.notify !== undefined) {
    if (!/^ {4}if:\s*always\(\)\s*$/m.test(jobs.notify)) bad.push('notify 要有 if: always()')
    for (const j of ['guard', 'linux', 'attest-linux']) if (!needsOf(jobs.notify).includes(j)) bad.push(`notify 的 needs 缺 ${j}`)
  }
  const g = jobs.guard ?? ''
  if (!/ASN_RELEASE_AUTO:\s*\$\{\{\s*vars\.ASN_RELEASE_AUTO\s*\}\}/.test(g)) bad.push('guard 要從 vars.ASN_RELEASE_AUTO 讀開關')
  if (!g.includes('[ "${ASN_RELEASE_AUTO:-}" = "true" ]')) bad.push('開關判斷要是「恰為 true」')
  if (!/^ {6}auto:\s*\$\{\{\s*steps\.auto\.outputs\.auto\s*\}\}\s*$/m.test(g)) bad.push('guard 要輸出 auto')
  if (!g.includes('tools/release/tag_check.mjs "$TAG" --prefix linux-v')) bad.push('guard 要用 tag_check --prefix linux-v 檢查 linux-v 標籤本身')
  if (!g.includes('workflows/asn-release-linux.yml/runs')) bad.push('「別的 run 在跑」要查 asn-release-linux.yml')
  if (/releaseState|github_release/.test(g)) bad.push('guard 不准擋已公開的同版 Release（Linux 檔會附加到同一個 Release）')
  // rust-cache 不寫快取
  const rc = jobs.linux?.match(/Swatinem\/rust-cache@[^\n]*\n((?: {8,}\S.*\n)+)/)
  if (!rc || !/save-if:\s*false\s*$/m.test(rc[1])) bad.push('rust-cache 要 save-if: false')
  // 只收 deb 與 AppImage、SHA256SUMS、上傳 artifact
  const lt = jobs.linux ?? ''
  if (!/name:\s*asn-linux-unsigned/.test(lt) || !/if-no-files-found:\s*error/.test(lt) || !/retention-days:\s*14/.test(lt)) bad.push('linux 要上傳 asn-linux-unsigned（找不到檔就紅、保留 14 天）')
  if (!lt.includes('sha256sum -- *.deb *.AppImage > SHA256SUMS.txt')) bad.push('linux 要產 SHA256SUMS.txt（檔名不帶路徑）')
  if (!/sha256sum -c SHA256SUMS\.txt/.test(jobs['attest-linux'] ?? '')) bad.push('attest-linux 要核對 SHA256SUMS.txt')
  for (const m of src.matchAll(/^\s*run:\s*\|\s*\n\s*(.*)$/gm)) if (m[1].trim() !== 'set -euo pipefail') bad.push(`多行 run: 要以 set -euo pipefail 開頭：${m[1].trim().slice(0, 40)}`)
  return bad
}

const wf = read(FILE)
const flagged = (src, re) => checkLinux(src).some(m => re.test(m))
const mutate = (from, to) => { assert.ok(wf.includes(from), `壞例子替換目標不存在：${from}`); return wf.replace(from, to) }

test('Linux 發版 workflow 通過全部守門；job 與順序正確', () => {
  assert.ok(wf.length > 3000)
  assert.deepEqual(Object.keys(jobsOf(strip(wf))), JOBS_WANT)
  assert.deepEqual(checkLinux(wf), [])
})

test('1 只吃 linux-v 標籤：壞例子（加 workflow_dispatch／branches／改標籤規則／多一條）會紅', () => {
  assert.ok(flagged(mutate('on:\n  push:', 'on:\n  workflow_dispatch:\n  push:'), /workflow_dispatch|只能有 push/))
  assert.ok(flagged(mutate("      - 'linux-v*.*.*'", "      - 'v*.*.*'"), /標籤規則只能是/))
  assert.ok(flagged(mutate("      - 'linux-v*.*.*'", "      - 'linux-v*.*.*'\n      - '*'"), /標籤規則只能是/))
  assert.ok(flagged(mutate('    tags:\n', '    branches:\n      - main\n    tags:\n'), /只能有 tags/))
})

test('2 沒有 secrets／environment：壞例子會紅，註解與 GITHUB_TOKEN 不算', () => {
  assert.ok(flagged(mutate('          RUN_ID: ${{ github.run_id }}', '          RUN_ID: ${{ github.run_id }}\n          X: ${{ secrets.ASN_X }}'), /secrets\./))
  assert.ok(flagged(mutate('    timeout-minutes: 90\n', '    environment: release\n    timeout-minutes: 90\n'), /environment/))
  assert.ok(flagged(`${wf}\n    secrets: inherit\n`, /inherit/))
  assert.ok(!flagged(`${wf}\n# secrets.ASN_X environment: release\n`, /secrets|environment/))
  assert.ok(!flagged(mutate('GH_TOKEN: ${{ github.token }}', 'GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}'), /secrets\./))
})

test('3 權限：頂層 contents: read；id-token／attestations 只在 attest-linux；無 contents: write；壞例子會紅', () => {
  const jobs = jobsOf(strip(wf))
  for (const j of JOBS_WANT) assert.equal(sorted(permsOf(jobs[j])), sorted(TABLE[j]), j)
  assert.ok(flagged(mutate('permissions:\n  contents: read\n\n# 每個標籤', 'permissions:\n  contents: write\n\n# 每個標籤'), /contents: write|頂層/))
  assert.ok(flagged(mutate('    timeout-minutes: 90\n    permissions:\n      contents: read', '    timeout-minutes: 90\n    permissions:\n      contents: read\n      id-token: write'), /id-token 只能在|job linux 的 permissions/))
  assert.ok(flagged(mutate('      attestations: write\n', '      attestations: write\n      actions: read\n'), /job attest-linux 的 permissions/))
  assert.ok(flagged(mutate('    timeout-minutes: 90\n', ''), /linux 缺 timeout/))
})

test('4 action 全釘 40 碼 SHA：uses 至少 10 個；壞例子（@v4、短 SHA）會紅', () => {
  const uses = [...strip(wf).matchAll(/^\s*-?\s*uses:\s*(\S+)/gm)].map(m => m[1])
  assert.ok(uses.length >= 10, `uses 只找到 ${uses.length}`)
  assert.ok(flagged(mutate('actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093', 'actions/download-artifact@v4'), /沒鎖到 40 位/))
  assert.ok(flagged(mutate('actions/attest-build-provenance@e8998f949152b193b063cb0ec769d69d929409be', 'actions/attest-build-provenance@e8998f9'), /沒鎖到 40 位/))
})

test('5 checkout 都 persist-credentials: false（至少 3 個）；壞例子會紅', () => {
  assert.ok(flagged(mutate('        with:\n          persist-credentials: false\n\n      # apt', '        with:\n          fetch-depth: 1\n\n      # apt'), /persist-credentials/))
})

test('6 下游看 auto、順序、notify always()：壞例子會紅', () => {
  assert.ok(flagged(mutate("    needs: guard\n    if: needs.guard.outputs.auto == 'true'\n", '    needs: guard\n'), /job linux 要有 if/))
  assert.ok(flagged(mutate('    needs: linux\n', '    needs: guard\n'), /attest-linux 要在 linux 之後/))
  assert.ok(flagged(mutate('    if: always()\n', ''), /notify 要有 if: always/))
  assert.ok(flagged(mutate('      - attest-linux\n    if: always()', '    if: always()'), /notify 的 needs 缺 attest-linux/))
  assert.ok(flagged(mutate('[ "${ASN_RELEASE_AUTO:-}" = "true" ]', '[ "${ASN_RELEASE_AUTO:-}" != "false" ]'), /恰為 true/))
})

test('7 guard：用 tag_check --prefix linux-v、查 Linux 自己的 run、不擋已公開的同版 Release；壞例子會紅', () => {
  assert.ok(flagged(mutate('"$TAG" --prefix linux-v', '"${TAG#linux-}"'), /--prefix linux-v/))
  assert.ok(flagged(mutate('workflows/asn-release-linux.yml/runs', 'workflows/asn-release.yml/runs'), /asn-release-linux\.yml/))
  assert.ok(flagged(mutate('          echo "自動發版開關：$auto"', '          echo "自動發版開關：$auto"\n          node tools/release/github_release.mjs'), /不准擋已公開/))
})

test('8 guard 步驟名與 GUARD_STEPS 一一對應：workflow 輸出的每個名字都在白名單，且涵蓋預設「其他」；壞例子會被抓到', () => {
  const names = [...strip(wf).matchAll(/name="([^"]+)"/g)].map(m => m[1])
  assert.deepEqual([...new Set(names)].sort(), ['其他', '別的發版 run 在跑', '標籤與版本檔'].sort())
  for (const n of names) assert.ok(GUARD_STEPS.includes(n), `「${n}」不在 GUARD_STEPS`)
  assert.ok(![...wf.replace('name="標籤與版本檔"', 'name="標籤檢查"').matchAll(/name="([^"]+)"/g)].every(m => GUARD_STEPS.includes(m[1])))
  const real = JOBS_WANT.filter(j => j !== 'guard' && j !== 'notify')
  assert.deepEqual(real.filter(j => !ALL_JOBS.includes(j)), [], 'notify_status 認不得 workflow 的 job')
})

test('9 rust-cache save-if: false；壞例子（改成 main 才存）會紅', () => {
  assert.ok(flagged(mutate('          save-if: false', "          save-if: ${{ github.ref == 'refs/heads/main' }}"), /save-if/))
})

test('10 只收 deb 與 AppImage、SHA256SUMS 檔名不帶路徑、artifact 找不到檔就紅：壞例子會紅', () => {
  assert.ok(flagged(mutate('sha256sum -- *.deb *.AppImage > SHA256SUMS.txt', 'sha256sum ./* > SHA256SUMS.txt'), /SHA256SUMS/))
  assert.ok(flagged(mutate('          if-no-files-found: error\n          retention-days: 14', '          if-no-files-found: warn\n          retention-days: 14'), /asn-linux-unsigned/))
  assert.ok(flagged(mutate('sha256sum -c SHA256SUMS.txt', 'true'), /核對 SHA256SUMS/))
})

test('11 測試全跑、不略過：npm test、test:rust、金鑰庫、e2e、冒煙、npm run build 都在，且順序正確', () => {
  const t = jobsOf(strip(wf)).linux
  const at = s => { const i = t.indexOf(s); assert.ok(i > 0, s); return i }
  assert.ok(at('npm test') < at('npm run test:rust') && at('npm run test:rust') < at('keystore::linux') && at('keystore::linux') < at('-- npm run build') && at('-- npm run build') < at('test/e2e.test.mjs') && at('test/e2e.test.mjs') < at('scripts/smoke-ui.mjs'))
  assert.doesNotMatch(wf, /--skip|continue-on-error/)
})

test('12 多行 run 都以 set -euo pipefail 開頭：壞例子會紅', () => {
  assert.ok(flagged(mutate('          set -euo pipefail\n          npm ci', '          npm ci'), /set -euo pipefail 開頭/))
})


// #1892 守門缺口：run: 區塊不得內插 ${{ }}（外部字串一律經 env:）；不准 || true、set +e、continue-on-error。
// 唯一例外（整行精確相等才放行，附理由與至少命中次數）：
const RUN_ALLOW = [
  { line: `ids=$(printf '%s\\n' "$all" | grep -vx "$RUN_ID" | grep -v '^$' || true)`, min: 1, why: '取「其他發版 run 編號」：grep 沒找到（＝沒有別的 run）回 1 是正常，不該讓 guard 紅' },
]
const runBodies = raw => {
  const lines = strip(raw).split('\n')
  const out = []
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)(- )?run:[ \t]*(.*)$/.exec(lines[i])
    if (!m) continue
    if (!/^[|>][+-]?$/.test(m[3].trim())) { out.push([m[3]]); continue }
    const keyCol = m[1].length + (m[2] ? 2 : 0)
    const body = []
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j].trim() === '') { body.push(''); continue }
      if (lines[j].search(/\S/) <= keyCol) break
      body.push(lines[j])
    }
    out.push(body)
  }
  return out
}
/** 回違規訊息陣列，空陣列＝通過 */
const runProblems = raw => {
  const bad = []
  const bodies = runBodies(raw)
  if (bodies.length < 15) bad.push(`run 區塊命中數太少：${bodies.length}`)
  const hits = new Map(RUN_ALLOW.map(a => [a.line, 0]))
  for (const body of bodies) for (const l of body) {
    const t = l.trim()
    if (t.includes('${{')) bad.push(`run 內不准 \${{ }}（改經 env:）：${t.slice(0, 60)}`)
    if (hits.has(t)) { hits.set(t, hits.get(t) + 1); continue }
    if (/\|\|\s*true\b/.test(t)) bad.push(`不准 || true：${t.slice(0, 60)}`)
    if (/\bset\s+\+e\b/.test(t)) bad.push(`不准 set +e：${t.slice(0, 60)}`)
  }
  for (const a of RUN_ALLOW) if (hits.get(a.line) < a.min) bad.push(`白名單「${a.line.slice(0, 40)}」命中 ${hits.get(a.line)} 次，少於 ${a.min}（${a.why}）`)
  if (/continue-on-error/.test(strip(raw))) bad.push('不准 continue-on-error')
  return bad
}

test('#1892 run: 區塊不內插 ${{ }}、不用 || true／set +e／continue-on-error（白名單：guard 取其他 run 編號那行，至少命中 1 次；run 區塊至少 15 個）', () => {
  const W = wf
  assert.deepEqual(runProblems(W), [])
  assert.ok(runBodies(W).length >= 15, 'run 區塊命中數太少')
  assert.ok([...strip(W).matchAll(/^\s+\w+:\s*\$\{\{/gm)].length >= 15, 'env／with 的 ${{ }} 至少 15 處（確認外部值確實走 env:）')
})

test('#1892 壞例子：run 內加 ${{ }}、|| true、set +e、continue-on-error 會紅；白名單那行被改掉或拿掉會紅；env: 與註解裡的不算', () => {
  const W = wf
  const has = (src, re) => runProblems(src).some(m => re.test(m))
  const sub = (from, to) => { assert.ok(W.includes(from), `壞例子替換目標不存在：${from}`); return W.replace(from, () => to) }
  const anchor = '          set -euo pipefail\n'
  assert.ok(has(sub(anchor, `${anchor}          echo "\${{ github.ref_name }}"\n`), /\$\{\{/))
  assert.ok(has(sub(anchor, `${anchor}          npm test || true\n`), /\|\| true/))
  assert.ok(has(sub(anchor, `${anchor}          npm test ||true\n`), /\|\| true/))
  assert.ok(has(sub(anchor, `${anchor}          set +e\n`), /set \+e/))
  assert.ok(has(sub('    timeout-minutes:', '    continue-on-error: true\n    timeout-minutes:'), /continue-on-error/))
  // 白名單是整行相等：多接一段、換成別的 || true、拿掉 || true 都不放行
  assert.ok(has(sub("grep -v '^$' || true)", "grep -v '^$' || true); npm test || true"), /\|\| true/))
  assert.ok(has(sub("grep -v '^$' || true)", "grep -v '^x$' || true)"), /\|\| true/))
  assert.ok(has(sub("grep -v '^$' || true)", "grep -v '^$')"), /白名單/))
  // 不誤傷：註解裡提到不算
  assert.deepEqual(runProblems(`${W}\n# echo "\${{ github.ref_name }}" || true; set +e; continue-on-error\n`), [])
})
