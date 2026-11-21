// 官網部署演練 workflow（site-deploy.yml，#1947 ②）的守門：只有演練、無 secrets／environment、權限最小、action 釘 SHA。
// 風格比照 release-linux-workflow-guard（字串與正則、先剝註解）；每條規則附壞例子，證明會紅。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const root = new URL('../../../', import.meta.url)
const FILE = '.github/workflows/site-deploy.yml'
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
const jobNames = src => [...(topBlock(src, 'jobs') ?? []).join('\n').matchAll(/^ {2}([A-Za-z0-9_-]+):\s*$/gm)].map(m => m[1])
/** 所有 run: 的內容（單行與 | 多行） */
export const runBlocks = src => {
  const lines = src.split('\n')
  const out = []
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)-?\s*run:[ \t]*(.*)$/.exec(lines[i])
    if (!m) continue
    const indent = m[1].length
    if (m[2] && !/^[|>][-+]?$/.test(m[2])) { out.push(m[2]); continue }
    const body = []
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j].trim() !== '' && lines[j].search(/\S/) <= indent + 1) break
      body.push(lines[j])
    }
    out.push(body.join('\n'))
  }
  return out
}

const PATHS = ['site/**', 'tools/release/site_predeploy.mjs', 'tools/release/legacy-installers.json', '.github/workflows/site-deploy.yml']

/** 回違規訊息陣列，空陣列＝通過 */
export const checkSite = raw => {
  const src = strip(raw)
  const bad = []
  for (const m of src.matchAll(/^\s*(on|permissions):[ \t]*([\[{].*)$/gm)) bad.push(`flow-style 的 ${m[1]}:`)
  const on = topBlock(src, 'on') ?? []
  const events = on.filter(l => /^ {2}\S/.test(l)).map(l => l.trim().replace(/:$/, ''))
  if (events.join() !== 'push,pull_request,workflow_dispatch') bad.push(`觸發事件只能是 push、pull_request、workflow_dispatch，現在是 [${events.join()}]`)
  if (/pull_request_target/.test(src)) bad.push('不准 pull_request_target')
  const onText = on.join('\n') + '\n'
  const partOf = key => new RegExp(`^ {2}${key}:\\n((?: {4,}\\S.*\\n?)*)`, 'm').exec(onText)?.[1] ?? ''
  const listOf = (part, key) => {
    const m = new RegExp(`^ {4}${key}:\\n((?: {6}- .*\\n?)+)`, 'm').exec(part)
    return m ? m[1].split('\n').filter(Boolean).map(l => l.trim().slice(2).replace(/^'|'$/g, '')) : null
  }
  if (listOf(partOf('push'), 'branches')?.join() !== 'main') bad.push('push 只能收 main')
  if (listOf(partOf('push'), 'paths')?.join() !== PATHS.join()) bad.push('push.paths 不是規定的四條')
  if (listOf(partOf('pull_request'), 'paths')?.join() !== PATHS.join()) bad.push('pull_request.paths 不是規定的四條')
  if (/^ {4}tags:/m.test(onText)) bad.push('不准 tags 觸發')
  if (topBlock(src, 'permissions')?.map(l => l.trim()).join('|') !== 'contents: read') bad.push('頂層 permissions 只能是 contents: read')
  if (/^\s+permissions:/m.test((topBlock(src, 'jobs') ?? []).join('\n'))) bad.push('job 層不准另設 permissions（一律繼承頂層 contents: read）')
  if (/write-all|:\s*write\b/.test(src)) bad.push('不准任何 write 權限')
  if (/secrets\./.test(src)) bad.push('不准有 secrets.')
  if (/secrets\s*:\s*inherit/.test(src)) bad.push('不准 secrets: inherit')
  if (/^\s*environment\s*:/m.test(src)) bad.push('不准有 environment:')
  if (jobNames(src).join() !== 'site-dryrun') bad.push(`job 清單只能是 site-dryrun，現在是 [${jobNames(src).join()}]`)
  const uses = [...src.matchAll(/^\s*-?\s*uses:\s*(\S+)/gm)].map(m => m[1])
  if (uses.length < 2) bad.push('uses 命中數太少')
  for (const u of uses) if (!/^[\w.-]+\/[\w.\/-]+@[0-9a-f]{40}$/.test(u)) bad.push(`action 沒鎖到 40 位 commit：${u}`)
  const co = [...src.matchAll(/uses:\s*actions\/checkout@[^\n]*\n((?: {8,}\S.*\n)+)/g)]
  if (co.length < 1) bad.push('checkout 命中數太少')
  for (const m of co) if (!/persist-credentials:\s*false/.test(m[1])) bad.push('checkout 沒有 persist-credentials: false')
  if (/continue-on-error/.test(src)) bad.push('不准 continue-on-error')
  if (/\bset\s+\+e/.test(src)) bad.push('不准 set +e')
  if (/\|\|\s*true\b/.test(src)) bad.push('不准 || true')
  if (/\bfirebase(-tools)?[^\n]*\bdeploy\b(?![^\n]*--dry-run)/.test(src)) bad.push('不准真的 firebase deploy（只能 --dry-run）')
  const runs = runBlocks(src)
  if (runs.length < 2) bad.push(`run 區塊數太少：${runs.length}`)
  for (const r of runs) if (r.includes('${{')) bad.push(`run 區塊裡不准有 \${{：${r.trim().slice(0, 40)}`)
  for (const m of src.matchAll(/^\s*run:\s*\|\s*\n\s*(.*)$/gm)) if (m[1].trim() !== 'set -euo pipefail') bad.push(`多行 run: 要以 set -euo pipefail 開頭：${m[1].trim().slice(0, 40)}`)
  if (!src.includes('node tools/release/site_predeploy.mjs --site site')) bad.push('要跑 site_predeploy.mjs --site site')
  return bad
}

const wf = read(FILE)
const flagged = (src, re) => checkSite(src).some(m => re.test(m))
const mutate = (from, to) => { assert.ok(wf.includes(from), `壞例子替換目標不存在：${from}`); return wf.replace(from, to) }

test('前提：真的讀到 job 與 run 區塊、uses 至少 2 個', () => {
  assert.ok(wf.length > 1500)
  assert.deepEqual(jobNames(strip(wf)), ['site-dryrun'])
  assert.ok(runBlocks(strip(wf)).length >= 2)
  assert.ok([...strip(wf).matchAll(/^\s*-?\s*uses:\s*(\S+)/gm)].length >= 2)
})

test('整份 workflow 通過全部守門', () => {
  assert.deepEqual(checkSite(wf), [])
})

test('1 觸發：只有 main 的 push、pull_request、workflow_dispatch；paths 四條；壞例子會紅', () => {
  assert.ok(flagged(mutate('  pull_request:\n', '  pull_request_target:\n'), /pull_request_target|觸發事件/))
  assert.ok(flagged(mutate('  workflow_dispatch:\n', '  workflow_dispatch:\n  schedule:\n    - cron: "0 0 * * *"\n'), /觸發事件/))
  assert.ok(flagged(mutate('    branches:\n      - main\n', '    branches:\n      - main\n      - dev\n'), /push 只能收 main/))
  assert.ok(flagged(mutate("      - 'tools/release/legacy-installers.json'\n", ''), /paths/))
  assert.ok(flagged(mutate("      - 'site/**'\n", "      - 'site/**'\n      - '**'\n"), /paths/))
})

test('2 權限只有頂層 contents: read；壞例子會紅', () => {
  assert.ok(flagged(mutate('permissions:\n  contents: read', 'permissions:\n  contents: write'), /頂層 permissions|write/))
  assert.ok(flagged(mutate('    timeout-minutes: 15\n', '    timeout-minutes: 15\n    permissions:\n      contents: read\n'), /job 層不准/))
  assert.ok(flagged(mutate('permissions:\n  contents: read', 'permissions:\n  contents: read\n  id-token: write'), /頂層 permissions|write/))
})

test('3 所有 uses 釘 40 碼 SHA、checkout persist-credentials: false；壞例子會紅', () => {
  assert.ok(flagged(mutate('actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020', 'actions/setup-node@v4'), /沒鎖到 40 位/))
  assert.ok(flagged(mutate('actions/checkout@11d5960a326750d5838078e36cf38b85af677262', 'actions/checkout@11d5960'), /沒鎖到 40 位/))
  assert.ok(flagged(mutate('          persist-credentials: false', '          fetch-depth: 1'), /persist-credentials/))
})

test('4 沒有 secrets／environment、不真部署：壞例子會紅，註解不算', () => {
  assert.ok(flagged(mutate('        run: |\n          set -euo pipefail\n          node tools', '        env:\n          X: ${{ secrets.X }}\n        run: |\n          set -euo pipefail\n          node tools'), /secrets\./))
  assert.ok(flagged(mutate('    timeout-minutes: 15\n', '    timeout-minutes: 15\n    environment: site-deploy\n'), /environment/))
  assert.ok(flagged(`${wf}\n    secrets: inherit\n`, /inherit/))
  assert.ok(flagged(mutate('          node tools/release/site_predeploy.mjs --site site', '          node tools/release/site_predeploy.mjs --site site\n          npx firebase-tools@1.0.0 deploy --only hosting'), /真的 firebase deploy/))
  assert.ok(!flagged(`${wf}\n# secrets.X environment: y\n`, /secrets|environment/))
})

test('5 run 區塊：不准 ${{、|| true、set +e、continue-on-error；壞例子會紅', () => {
  assert.ok(flagged(mutate('          node tools/release/site_predeploy.mjs --site site', '          echo ${{ github.ref }}\n          node tools/release/site_predeploy.mjs --site site'), /run 區塊裡不准有/))
  assert.ok(flagged(mutate('          node tools/release/site_predeploy.mjs --site site', '          node tools/release/site_predeploy.mjs --site site || true'), /\|\| true/))
  assert.ok(flagged(mutate('          set -euo pipefail\n          node tools', '          set +e\n          node tools'), /set \+e|set -euo/))
  assert.ok(flagged(mutate('    timeout-minutes: 15\n', '    timeout-minutes: 15\n    continue-on-error: true\n'), /continue-on-error/))
})

test('6 步驟內容：跑 site_predeploy、固定版本 firebase-tools 來自 FIREBASE_TOOLS_VERSION；壞例子會紅', () => {
  assert.ok(flagged(mutate('node tools/release/site_predeploy.mjs --site site', 'true'), /site_predeploy/))
  assert.ok(wf.includes('tools/release/FIREBASE_TOOLS_VERSION'))
  assert.ok(fs.existsSync(new URL('tools/release/FIREBASE_TOOLS_VERSION', root)))
})
