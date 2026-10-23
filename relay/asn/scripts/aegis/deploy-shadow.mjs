// 把 Rust 版 asn-bridge 部署到 Aegis 當「並行試跑」單元（asn-bridge-shadow）。不碰現有的 irori-relay-aegis。
// 用法（在 relay/asn）：
//   node scripts/aegis/deploy-shadow.mjs --dry-run            只印出會執行的指令，不執行任何東西
//   node scripts/aegis/deploy-shadow.mjs                      本機建置 -> 傳到 Aegis -> 安裝單元 -> 啟動
//   選項：--skip-build（用既有產物）、--restart（已在跑時重啟換新檔）、--instance、--zone、--project、--user
// 金鑰：本腳本不讀、不傳、不印任何金鑰。遠端只檢查金鑰檔「存在」（test -f），不存在就停手，
// 避免單元一啟動就因缺金鑰反覆重啟。金鑰由「註冊步驟」直接在 Aegis 上產生（見 LINUX-HEADLESS.md 階段 2）。
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { resolvePaths, sha256 } from '../build-linux-bridge.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
export const ASN_ROOT = path.join(here, '..', '..')
export const UNIT_NAME = 'asn-bridge-shadow.service'
export const UNIT_FILE = path.join(here, UNIT_NAME)

export const DEFAULTS = {
  instance: 'aegis-tokyo',
  zone: 'asia-northeast1-a',
  project: null,
  user: 'cwen0708',
  nodeId: 'aegis-rs',
  skipBuild: false,
  restart: false,
  dryRun: false,
}

const SAFE = /^[A-Za-z0-9._-]+$/

/** 解析命令列。 */
export function parseArgs(argv) {
  const o = { ...DEFAULTS }
  const val = (a, i) => {
    const v = argv[i + 1]
    if (!v || v.startsWith('--')) throw new Error(`${a} 需要一個值`)
    return v
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--dry-run') o.dryRun = true
    else if (a === '--skip-build') o.skipBuild = true
    else if (a === '--restart') o.restart = true
    else if (a === '--instance') o.instance = val(a, i++)
    else if (a === '--zone') o.zone = val(a, i++)
    else if (a === '--project') o.project = val(a, i++)
    else if (a === '--user') o.user = val(a, i++)
    else if (a === '--node') o.nodeId = val(a, i++)
    else throw new Error(`不認得的參數：${a}`)
  }
  for (const k of ['instance', 'zone', 'user', 'nodeId']) {
    if (!SAFE.test(o[k])) throw new Error(`${k} 含不允許的字元：${o[k]}`)
  }
  if (o.project !== null && !SAFE.test(o.project)) throw new Error(`project 含不允許的字元：${o.project}`)
  if (o.nodeId === 'aegis') throw new Error('試跑節點不可以是正式節點 aegis')
  return o
}

/** 遠端路徑：成品放在目標使用者家目錄底下（與舊的 ~/.irori-relay 分開）；傳輸先落在 /tmp，再用 sudo 安裝。 */
export function remotePaths(user, nodeId) {
  const home = `/home/${user}`
  return {
    dir: `${home}/asn-bridge`,
    bin: `${home}/asn-bridge/asn-bridge`,
    tmpBin: '/tmp/asn-bridge.new',
    tmpUnit: `/tmp/${UNIT_NAME}`,
    asnHome: `${home}/.asn-rs`,
    keyFile: `${home}/.asn-rs/${nodeId}.key`,
  }
}

/**
 * 遠端安裝腳本（單行，經 gcloud compute ssh --command 執行）。
 * 登入的 OS Login 帳號不是目標使用者，所以家目錄內的動作一律 sudo 成目標使用者。
 */
export function remoteInstallScript({ user, nodeId, sha, restart }) {
  const p = remotePaths(user, nodeId)
  const parts = [
    `sudo test -f ${p.keyFile} || { echo 缺少試跑節點金鑰檔，請先做註冊步驟; exit 3; }`,
    `test "$(sha256sum ${p.tmpBin} | cut -d' ' -f1)" = ${sha} || { echo 傳輸後 sha256 不符; exit 4; }`,
    `sudo install -o ${user} -g ${user} -m 755 ${p.tmpBin} ${p.bin}`,
    `sudo -u ${user} ${p.bin} --version`,
    `sudo install -m 644 ${p.tmpUnit} /etc/systemd/system/${UNIT_NAME}`,
    `rm -f ${p.tmpBin} ${p.tmpUnit}`,
    'sudo systemctl daemon-reload',
    `sudo systemctl enable --now ${UNIT_NAME}`,
  ]
  if (restart) parts.push(`sudo systemctl restart ${UNIT_NAME}`)
  parts.push(`systemctl is-active ${UNIT_NAME}`)
  return parts.join(' && ')
}

function gcloudBase(o) {
  const extra = o.project ? ['--project', o.project] : []
  return { extra, tunnel: ['--tunnel-through-iap'], zone: ['--zone', o.zone] }
}

/**
 * 組出全部步驟：每步 { desc, cmd, args, cwd?, local? }。
 * binary＝本機產物路徑；sha＝產物 sha256（dry-run 可用佔位字串）。
 */
export function buildPlan(o, { binary, sha = '<sha256>', asnRoot = ASN_ROOT } = {}) {
  const p = remotePaths(o.user, o.nodeId)
  const g = gcloudBase(o)
  // 不指定登入使用者：指定 user@ 會變成另一個 OS Login 帳號而沒有權限寫目標家目錄
  const target = o.instance
  const ssh = command => ['compute', 'ssh', target, ...g.zone, ...g.extra, ...g.tunnel, '--command', command]
  const scp = (src, dst) => ['compute', 'scp', src, `${target}:${dst}`, ...g.zone, ...g.extra, ...g.tunnel]
  const steps = []
  if (!o.skipBuild) steps.push({ desc: '本機建置 Linux 靜態版 asn-bridge', cmd: 'npm', args: ['run', 'build:linux-bridge'], cwd: asnRoot })
  steps.push({ desc: '遠端建立資料夾（權限 700）', cmd: 'gcloud', args: ssh(`sudo -u ${o.user} mkdir -p ${p.dir} ${p.asnHome} && sudo chmod 700 ${p.asnHome}`) })
  steps.push({ desc: '傳送二進位檔（先放 /tmp）', cmd: 'gcloud', args: scp(binary, p.tmpBin) })
  steps.push({ desc: '傳送 systemd 單元', cmd: 'gcloud', args: scp(UNIT_FILE, p.tmpUnit) })
  steps.push({ desc: '遠端驗證 sha256、安裝、啟動（不動 irori-relay-aegis）', cmd: 'gcloud', args: ssh(remoteInstallScript({ user: o.user, nodeId: o.nodeId, sha, restart: o.restart })) })
  return steps
}

/** 把指令印成人看得懂的一行（含空白或特殊字元的參數加雙引號）。 */
export function formatCmd(cmd, args) {
  const q = s => (/^[A-Za-z0-9_@%+=:,./~-]+$/.test(s) ? s : `"${s.replace(/(["\\$`])/g, '\\$1')}"`)
  return [cmd, ...args].map(q).join(' ')
}

function run(step) {
  const win = process.platform === 'win32'
  // Windows 上 npm、gcloud 都是 .cmd，需經 shell；含特殊字元的參數自行加雙引號
  const quote = s => (/^[A-Za-z0-9_@%+=:,./~\\-]+$/.test(s) ? s : `"${s.replace(/"/g, '')}"`)
  const r = win
    ? spawnSync([step.cmd, ...step.args.map(quote)].join(' '), { cwd: step.cwd, stdio: 'inherit', shell: true })
    : spawnSync(step.cmd, step.args, { cwd: step.cwd, stdio: 'inherit' })
  return r.status ?? 1
}

function main() {
  let o
  try { o = parseArgs(process.argv.slice(2)) } catch (e) { console.error(e.message); process.exit(2) }
  const binary = resolvePaths({}).out
  if (o.dryRun) {
    console.log('（--dry-run：只印出，不執行任何指令）')
    buildPlan(o, { binary }).forEach((s, i) => console.log(`${i + 1}. ${s.desc}\n   ${formatCmd(s.cmd, s.args)}`))
    return
  }
  // 先建置（若要），之後才算 sha256，所以分兩段組計畫
  const first = buildPlan(o, { binary }).filter(s => s.cwd)
  for (const s of first) { console.log(`> ${s.desc}`); const c = run(s); if (c !== 0) process.exit(c) }
  if (!fs.existsSync(binary)) { console.error(`找不到產物：${binary}（先建置，或不要加 --skip-build）`); process.exit(1) }
  const sha = sha256(fs.readFileSync(binary))
  console.log(`二進位 sha256：${sha}`)
  const rest = buildPlan({ ...o, skipBuild: true }, { binary, sha })
  for (const s of rest) { console.log(`> ${s.desc}`); const c = run(s); if (c !== 0) { console.error(`失敗（結束碼 ${c}）：${s.desc}`); process.exit(c) } }
  console.log('完成。舊單元 irori-relay-aegis 未被動到；停掉試跑：sudo systemctl disable --now ' + UNIT_NAME)
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main()
