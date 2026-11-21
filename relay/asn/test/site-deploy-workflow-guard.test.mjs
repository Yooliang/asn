// 官網部署 workflow（site-deploy.yml，#1947 ②④）的守門：演練 job 不碰金鑰；真部署 job 只在 main、只有它掛 environment 與用 secret（只經 env:）；
// 權限最小（全檔只有 contents: read；失敗不另寫通知，擁有者 11-21）、action 釘 SHA、憑證暫存檔 always() 刪除。
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

/** 取某個 job 的整段文字（含 job 名那行）；沒有回 '' */
export const jobBlock = (src, name) => {
  const lines = (topBlock(src, 'jobs') ?? [])
  const i = lines.findIndex(l => l === `  ${name}:`)
  if (i < 0) return ''
  const out = [lines[i]]
  for (let j = i + 1; j < lines.length && !/^ {2}\S/.test(lines[j]); j++) out.push(lines[j])
  return out.join('\n')
}
const SECRET = 'FIREBASE_SERVICE_ACCOUNT_ASNMESSENGER'

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
  const dry = jobBlock(src, 'site-dryrun'), dep = jobBlock(src, 'site-deploy')
  const jobsText = (topBlock(src, 'jobs') ?? []).join('\n')
  if (jobNames(src).join() !== 'site-dryrun,site-deploy') bad.push(`job 清單只能是 site-dryrun,site-deploy（失敗不另寫通知），現在是 [${jobNames(src).join()}]`)
  // 權限：job 層一律不另設，全部繼承頂層 contents: read；不准任何 write
  const jobPerms = [...jobsText.matchAll(/^\s+permissions:/gm)].length
  if (jobPerms !== 0) bad.push('job 層 permissions 不准另設')
  if (/write-all/.test(src) || /:\s*write\b/.test(src)) bad.push('不准任何 write 權限')
  if (/gh issue comment|ASN_RELEASE_ISSUE/.test(src)) bad.push('失敗不另寫通知（擁有者 11-21：看 GitHub 日誌）')
  if (/id-token/.test(src)) bad.push('不准 id-token')
  // secret：只在 site-deploy job 的 env: 底下、只有一處、只准那個名字；不在 run、不在 dryrun／notify
  const allLines = src.split('\n')
  const secretLines = allLines.map((l, i) => ({ l, i })).filter(x => /secrets\./.test(x.l))
  if (secretLines.length !== 1) bad.push(`secrets. 只准出現一次（site-deploy 的 env），現在 ${secretLines.length} 次`)
  if (/secrets\./.test(dry)) bad.push('secrets. 不准出現在 site-dryrun')
  for (const x of secretLines) {
    const ind = x.l.search(/\S/)
    let k = x.i - 1
    while (k >= 0 && (allLines[k].trim() === '' || allLines[k].search(/\S/) >= ind)) k--
    if (!/^\s+SA_JSON: \$\{\{ secrets\.FIREBASE_SERVICE_ACCOUNT_ASNMESSENGER \}\}$/.test(x.l) || !/^\s+env:$/.test(allLines[k] ?? '') || !dep.includes(x.l)) bad.push(`secret 只能寫在 site-deploy 步驟的 env: 底下（SA_JSON: ${SECRET}）：${x.l.trim()}`)
  }
  if (/secrets\s*:\s*inherit/.test(src)) bad.push('不准 secrets: inherit')
  // environment：整份只有 site-deploy 掛，值是 site-deploy
  const envs = [...src.matchAll(/^\s*environment\s*:\s*(.*)$/gm)]
  if (envs.length !== 1 || envs[0][1].trim() !== 'site-deploy' || !/^ {4}environment: site-deploy$/m.test(dep)) bad.push('environment: 整份只准 site-deploy 這個 job 掛，值是 site-deploy')
  // site-deploy 的條件、依賴、排隊
  const ifLine = /^ {4}if: (.*)$/m.exec(dep)?.[1] ?? ''
  if (ifLine !== "(github.event_name == 'push' || github.event_name == 'workflow_dispatch') && github.ref == 'refs/heads/main'") bad.push(`site-deploy 的 if 必須限定 main 的 push／dispatch，現在是 [${ifLine}]`)
  if (!/^ {4}needs: site-dryrun$/m.test(dep)) bad.push('site-deploy 必須 needs: site-dryrun')
  if (!/^ {4}concurrency:\n {6}group: \S+\n {6}cancel-in-progress: false$/m.test(dep)) bad.push('site-deploy 要有 job 層 concurrency 且 cancel-in-progress: false')
  // 真部署只在 site-deploy；演練與 notify 不准 deploy
  for (const [n, b] of [['site-dryrun', dry]]) if (/\bdeploy\b/.test(b) && /firebase/.test(b)) bad.push(`${n} 不准 firebase deploy`)
  if (!/npx --yes "firebase-tools@\$FB_VER" deploy --only hosting --project asnmessenger --non-interactive/.test(dep)) bad.push('site-deploy 要跑固定版本 firebase-tools 的 deploy --only hosting --project asnmessenger --non-interactive')
  if (!/FIREBASE_TOOLS_VERSION/.test(dep)) bad.push('site-deploy 的 firebase-tools 版本要來自 FIREBASE_TOOLS_VERSION')
  if (!dep.includes('node tools/release/site_verify_online.mjs --site site')) bad.push('site-deploy 要跑 site_verify_online.mjs 線上核對')
  if (!dep.includes('GOOGLE_APPLICATION_CREDENTIALS=$RUNNER_TEMP/') || !dep.includes('chmod 600')) bad.push('憑證要寫到 RUNNER_TEMP、chmod 600、設 GOOGLE_APPLICATION_CREDENTIALS')
  if (!/- name: [^\n]*\n {8}if: always\(\)\n {8}run: \|\n(?: {10}.*\n)* {10}rm -f "\$RUNNER_TEMP\/firebase-sa\.json"/.test(dep + '\n')) bad.push('site-deploy 要有 if: always() 的刪憑證暫存檔步驟')
  const uses = [...src.matchAll(/^\s*-?\s*uses:\s*(\S+)/gm)].map(m => m[1])
  if (uses.length < 2) bad.push('uses 命中數太少')
  for (const u of uses) if (!/^[\w.-]+\/[\w.\/-]+@[0-9a-f]{40}$/.test(u)) bad.push(`action 沒鎖到 40 位 commit：${u}`)
  const co = [...src.matchAll(/uses:\s*actions\/checkout@[^\n]*\n((?: {8,}\S.*\n)+)/g)]
  if (co.length < 1) bad.push('checkout 命中數太少')
  for (const m of co) if (!/persist-credentials:\s*false/.test(m[1])) bad.push('checkout 沒有 persist-credentials: false')
  if (/continue-on-error/.test(src)) bad.push('不准 continue-on-error')
  if (/\bset\s+\+e/.test(src)) bad.push('不准 set +e')
  if (/\|\|\s*true\b/.test(src)) bad.push('不准 || true')
  const runs = runBlocks(src)
  if (runs.length < 2) bad.push(`run 區塊數太少：${runs.length}`)
  for (const r of runs) if (r.includes('${{')) bad.push(`run 區塊裡不准有 \${{：${r.trim().slice(0, 40)}`)
  for (const m of src.matchAll(/^\s*run:\s*\|\s*\n\s*(.*)$/gm)) if (m[1].trim() !== 'set -euo pipefail') bad.push(`多行 run: 要以 set -euo pipefail 開頭：${m[1].trim().slice(0, 40)}`)
  if (!dry.includes('node tools/release/site_predeploy.mjs --site site')) bad.push('site-dryrun 要跑 site_predeploy.mjs --site site')
  return bad
}

const wf = read(FILE)
const flagged = (src, re) => checkSite(src).some(m => re.test(m))
const mutate = (from, to) => { assert.ok(wf.includes(from), `壞例子替換目標不存在：${from}`); return wf.replace(from, to) }

test('前提：真的讀到 job 與 run 區塊、uses 至少 2 個', () => {
  assert.ok(wf.length > 1500)
  assert.deepEqual(jobNames(strip(wf)), ['site-dryrun', 'site-deploy'])
  assert.ok(jobBlock(strip(wf), 'site-deploy').includes('environment: site-deploy'))
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
  assert.ok(flagged(mutate('    timeout-minutes: 15\n', '    timeout-minutes: 15\n    permissions:\n      contents: read\n'), /job 層 permissions/))
  assert.ok(flagged(mutate('    timeout-minutes: 30\n    environment', '    timeout-minutes: 30\n    permissions:\n      issues: write\n    environment'), /job 層 permissions|write/))
  // 擁有者 11-21：GitHub 上的失敗看 GitHub 日誌，不另寫失敗通知
  assert.ok(flagged(wf + '\n  notify:\n    needs: site-deploy\n    runs-on: ubuntu-latest\n    steps:\n      - name: 留言\n        run: gh issue comment 1 --body x\n', /job 清單|失敗不另寫通知/))
  assert.ok(flagged(mutate('permissions:\n  contents: read', 'permissions:\n  contents: read\n  id-token: write'), /頂層 permissions|write/))
})

test('3 所有 uses 釘 40 碼 SHA、checkout persist-credentials: false；壞例子會紅', () => {
  assert.ok(flagged(mutate('actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020', 'actions/setup-node@v4'), /沒鎖到 40 位/))
  assert.ok(flagged(mutate('actions/checkout@11d5960a326750d5838078e36cf38b85af677262', 'actions/checkout@11d5960'), /沒鎖到 40 位/))
  assert.ok(flagged(mutate('          persist-credentials: false', '          fetch-depth: 1'), /persist-credentials/))
})

test('4 secret／environment／真部署只在 site-deploy：壞例子會紅，註解不算', () => {
  const dryRun = '        run: |\n          set -euo pipefail\n          node tools'
  // secret 寫進 dryrun 的 env、寫進 run、多一處、inherit
  assert.ok(flagged(mutate(dryRun, '        env:\n          X: ${{ secrets.X }}\n' + dryRun), /secrets\./))
  assert.ok(flagged(mutate('printf \'%s\' "$SA_JSON"', 'printf \'%s\' "${{ secrets.FIREBASE_SERVICE_ACCOUNT_ASNMESSENGER }}"'), /secret 只能寫在|secrets\.|run 區塊裡不准有/))
  assert.ok(flagged(mutate('          SA_JSON: ${{ secrets.FIREBASE_SERVICE_ACCOUNT_ASNMESSENGER }}', '          SA_JSON: ${{ secrets.FIREBASE_SERVICE_ACCOUNT_ASNMESSENGER }}\n          X: ${{ secrets.OTHER }}'), /secrets\./))
  assert.ok(flagged(`${wf}\n    secrets: inherit\n`, /inherit/))
  // environment 掛到 dryrun、從 site-deploy 拿掉、值改掉
  assert.ok(flagged(mutate('    timeout-minutes: 15\n', '    timeout-minutes: 15\n    environment: site-deploy\n'), /environment/))
  assert.ok(flagged(mutate('    environment: site-deploy\n', ''), /environment/))
  assert.ok(flagged(mutate('    environment: site-deploy\n', '    environment: production\n'), /environment/))
  // if 限制拿掉或放寬
  assert.ok(flagged(mutate("    if: (github.event_name == 'push' || github.event_name == 'workflow_dispatch') && github.ref == 'refs/heads/main'\n", ''), /site-deploy 的 if/))
  assert.ok(flagged(mutate(" && github.ref == 'refs/heads/main'\n", '\n'), /site-deploy 的 if/))
  assert.ok(flagged(mutate("github.event_name == 'push' ||", "github.event_name == 'pull_request' ||"), /site-deploy 的 if/))
  // 不重疊排隊、依賴、firebase 參數、核對、刪檔步驟
  assert.ok(flagged(mutate('cancel-in-progress: false', 'cancel-in-progress: true'), /concurrency/))
  assert.ok(flagged(mutate('    needs: site-dryrun\n', ''), /needs: site-dryrun/))
  assert.ok(flagged(mutate('--project asnmessenger ', ''), /deploy --only hosting/))
  assert.ok(flagged(mutate('          node tools/release/site_verify_online.mjs --site site\n', '          true\n'), /線上核對/))
  assert.ok(flagged(mutate('        if: always()\n', ''), /always\(\)/))
  assert.ok(flagged(mutate('rm -f "$RUNNER_TEMP/firebase-sa.json"', 'true'), /always\(\)/))
  assert.ok(flagged(mutate('chmod 600', 'chmod 644'), /chmod 600/))
  // 演練 job 不准 deploy
  assert.ok(flagged(mutate('          node tools/release/site_predeploy.mjs --site site', '          node tools/release/site_predeploy.mjs --site site\n          npx firebase-tools@1.0.0 deploy --only hosting'), /site-dryrun 不准 firebase deploy/))
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
