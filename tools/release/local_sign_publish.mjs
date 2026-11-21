// 發版機器的本機一步（#1892 規格 2.5）：確認來源 → 下載 CI 的未簽章安裝檔 → 本機簽章 → 驗簽與反向驗證 → 產 latest.json／index.html → 版本不退
//   →（以上全過才）寫入網站檔、發 GitHub Release → firebase 部署 → 線上核對 → 官網版本紀錄 → 貼群組 → 提交回 main。
// 發版只建一次（雯 11-20、asn真 同意）：CI 已把正式建置（含冒煙、npm test）做完，這裡全過之前不推 main、不發 Release、不部署官網；
// 失敗就丟掉版號提交、重來。--dry-run 只跑到版本不退，全部寫暫存資料夾，不呼叫任何發布類函式。
//
// 設計：所有會碰外面的東西都當參數注入（gh、git、檔案系統、asn-cli、firebase、簽章、fetch、發 Release），測試不靠 PATH 放假指令。
// 簽章金鑰與密碼：這支程式從不讀、不經手、不印；簽章函式（signer）自己讀金鑰資料夾，密碼只走環境變數交給 tauri；這裡只確認「存在、大小」。
// 用法：node tools/release/local_sign_publish.mjs --tag v<版本>（或 --version <版本>）[--run-id <id>] [--dry-run] [--with-play auto|yes|no]
//         [--same-version] [--items-file <json>] [--room <群組代號，或環境變數 ASN_RELEASE_ROOM>]
// Linux 版（電腦版發好之後）：node tools/release/local_sign_publish.mjs --platform linux --tag linux-v<版本> [--run-id <id>] [--dry-run] [--room <群組代號>]
//   做法見 linux_publish.mjs：簽 AppImage、附加到既有 Release v<版本>、latest.json 只加 linux-x86_64、首頁加 Linux 連結、部署與線上核對。
// --items-file：與 CI 草稿同格式的 JSON 物件（version、date、commit、items、platforms），或只有條目的字串陣列；仍過同一組檢查。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { PLATFORM, buildLatestJson, installerName, installerUrl, patchDownloadLink, resolveNotes, INSTALLER_HREF_RE } from '../../relay/asn/scripts/release-lib.mjs'
import { verifyAll, sigMatchesLatest } from './verify_sig.mjs'
import { verifyOnline } from './verify_online.mjs'
import { checkRecord } from './site_record_check.mjs'
import { listZip } from './zip_lite.mjs'
import { publishRelease as realPublishRelease, attachToRelease as realAttachToRelease } from './github_release.mjs'
import { linuxSignPublish } from './linux_publish.mjs'
import { makeAsnCli, asnCliFail } from './asn_cli.mjs'
import { onlineAheadOfMain } from './abort_notice.mjs'

export const REPO = 'Yooliang/asn'
export const WORKFLOW = '.github/workflows/asn-release.yml'
export const ARTIFACT_WHITELIST = ['asn-installer-unsigned', 'asn-site-draft', 'asn-aab', 'asn-debug']
export const SITE_FILES = ['site/public/update/latest.json', 'site/public/index.html']
export const SITE_BASE = 'https://asnmessenger.web.app'
const FIREBASE_PROJECT = 'asnmessenger'

const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex')
class StepError extends Error {}
const bad = msg => { throw new StepError(msg) }
const first = s => String(s ?? '').trim()

export const compareVersions = (a, b) => {
  const x = a.split('.').map(Number), y = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1
  return 0
}

export function parseArgs(argv) {
  const o = { platform: 'windows', tag: null, version: null, runId: null, dryRun: false, withPlay: 'auto', sameVersion: false, itemsFile: null, room: null, error: null }
  const val = (i, k) => { const v = argv[i + 1]; if (v === undefined || v.startsWith('--')) { o.error = `${k} 後面要有值`; return null } return v }
  for (let i = 0; i < argv.length && !o.error; i++) {
    const a = argv[i]
    if (a === '--dry-run') o.dryRun = true
    else if (a === '--same-version') o.sameVersion = true
    else if (a === '--platform') o.platform = val(i++, a)
    else if (a === '--tag') o.tag = val(i++, a)
    else if (a === '--version') o.version = val(i++, a)
    else if (a === '--run-id') o.runId = val(i++, a)
    else if (a === '--with-play') o.withPlay = val(i++, a)
    else if (a === '--items-file') o.itemsFile = val(i++, a)
    else if (a === '--room') o.room = val(i++, a)
    else o.error = `不認得的參數：${a}`
  }
  if (o.error) return o
  const linux = o.platform === 'linux'
  const TAG_RE = linux ? /^linux-v\d+\.\d+\.\d+$/ : /^v\d+\.\d+\.\d+$/
  const prefix = linux ? 'linux-v' : 'v'
  if (!['windows', 'linux'].includes(o.platform)) o.error = '--platform 只能是 windows 或 linux'
  else if (linux && (o.withPlay !== 'auto' || o.sameVersion || o.itemsFile)) o.error = 'Linux 版不用 --with-play、--same-version、--items-file'
  else if (!['auto', 'yes', 'no'].includes(o.withPlay)) o.error = '--with-play 只能是 auto、yes、no'
  else if (o.runId !== null && !/^\d+$/.test(o.runId)) o.error = '--run-id 要是數字'
  else if (o.tag && !TAG_RE.test(o.tag)) o.error = `標籤格式不對：${o.tag}`
  else if (o.version && !/^\d+\.\d+\.\d+$/.test(o.version)) o.error = `版本格式不對：${o.version}`
  else if (o.tag && o.version && o.tag !== `${prefix}${o.version}`) o.error = '--tag 與 --version 不一致'
  else if (!o.tag && !o.version) o.error = '要給 --tag 或 --version'
  else if (!o.tag) o.tag = `${prefix}${o.version}`
  if (!o.error) o.version = o.tag.slice(prefix.length)
  return o
}

/**
 * opts＝parseArgs 的結果；deps（全部注入）：
 *   git(args)→字串、gh(args)→字串（失敗要拋）、ghDownloadArtifact(id, 目的檔)、ghDownload(版本, 檔名, 資料夾)（給 publishRelease 用）、
 *   asnCli(args)→{ status, stdout, stderr }、firebase({ version, args, cwd })→字串、signer{ check()→{ ok, … }, sign(exe 路徑)→.sig 路徑 }、
 *   fetchFn、sleep、publishRelease、runTests()→{ ok, output }、fs、repoRoot、mkTmp()→新的空資料夾、now、log、onlineAttempts、onlineIntervalMs
 * 回 { ok, dryRun, failedStep, completed, record, latest }
 */
export async function localSignPublish(opts, deps) {
  if (opts.platform === 'linux') return linuxSignPublish(opts, { ...deps, fs: deps.fs ?? fs, attachRelease: deps.attachRelease ?? realAttachToRelease })
  const { git, gh, ghDownloadArtifact, ghDownload, asnCli, firebase, signer, fetchFn, sleep, publishRelease, runTests, repoRoot } = deps
  const fsx = deps.fs ?? fs
  const log = deps.log ?? (() => {})
  const now = deps.now ?? Date.now
  const { tag, version, dryRun } = opts
  const room = opts.room ?? null
  const completed = []
  const st = { step: 0, name: '' }
  const S = {} // 各步之間傳遞的東西

  const step = async (n, name, fn) => {
    st.step = n; st.name = name
    log(`第 ${n} 步：${name}`)
    await fn()
    completed.push(`${n} ${name}`)
  }
  const gitOk = args => { try { git(args); return true } catch { return false } }
  const showAt = (ref, rel) => git(['show', `${ref}:${rel}`])
  const blobOf = (ref, rel) => { try { return first(git(['rev-parse', `${ref}:${rel}`])) } catch { return '' } }

  const post = async text => {
    if (dryRun) return
    let r
    try { r = await asnCli(['send', '--room', room, '--body', text]) } catch (e) { r = { status: 1, stderr: e.message } }
    if (r?.status !== 0) log(`貼群組失敗（${asnCliFail(r)}），請自行通知：${text}`)
  }

  try {
    // ---- 0 起手檢查
    await step(0, '起手檢查', async () => {
      if (first(git(['rev-parse', '--is-shallow-repository'])) !== 'false') bad('這是淺複製（shallow clone），git 歷史不完整：改用完整複製再跑')
      let hist = ''
      try { hist = first(git(['log', '-n1', '--format=%H', '--', 'site/'])) } catch { hist = '' }
      if (!hist) bad('讀不到 site/ 的 git 歷史（git log -- site/ 失敗或沒有結果）：官網部署前檢查會靜默當成沒歷史，不繼續')
      if (!dryRun && !room) bad('沒有群組代號：用 --room 或環境變數 ASN_RELEASE_ROOM（失敗與完成都要貼群組）')
      git(['fetch', 'origin', 'main', '--tags', '--quiet'])
      S.tagSha = first(git(['rev-parse', `${tag}^{commit}`]))
      if (!/^[0-9a-f]{40}$/.test(S.tagSha)) bad(`讀不到標籤 ${tag} 的 commit`)
      const head = first(git(['rev-parse', 'HEAD']))
      if (head !== S.tagSha) bad(`HEAD（${head.slice(0, 8)}）不是標籤 ${tag} 的 commit（${S.tagSha.slice(0, 8)}）：先切到標籤那個 commit`)
      const dirty = git(['status', '--porcelain']).split('\n').map(l => l.trimEnd()).filter(Boolean).map(l => l.slice(3).replace(/^"|"$/g, '')).filter(p => !SITE_FILES.includes(p))
      if (dirty.length) bad(`工作樹除了兩個網站檔以外不乾淨：${dirty.slice(0, 5).join('、')}${dirty.length > 5 ? ' 等' : ''}`)
      if (!first(git(['branch', '-r', '--contains', S.tagSha]))) bad(`標籤 ${tag} 的 commit 還沒推上 origin`)
      S.originMain = first(git(['rev-parse', 'origin/main']))
      try { gh(['auth', 'status']) } catch { bad('gh 沒有登入（gh auth status 失敗）') }
      const verFile = fsx.readFileSync(path.join(repoRoot, 'tools', 'release', 'FIREBASE_TOOLS_VERSION'), 'utf8')
      S.firebaseVersion = verFile.split(/\r?\n/).map(l => l.trim()).find(l => l && !l.startsWith('#'))
      if (!/^\d+\.\d+\.\d+$/.test(S.firebaseVersion ?? '')) bad('tools/release/FIREBASE_TOOLS_VERSION 讀不到固定版本（x.y.z）')
      const who = first(await firebase({ version: S.firebaseVersion, args: ['login:list'], cwd: path.join(repoRoot, 'site') }))
      if (!who || /no authorized accounts/i.test(who)) bad('firebase 沒有登入（firebase login:list 沒有帳號）')
      const k = await signer.check()
      if (!k?.ok) bad('簽章金鑰檔不在或是空的（只檢查存在與大小）')
    })

    // ---- 1 來源綁定（簽章前全部要過）
    await step(1, '來源綁定', async () => {
      if (!gitOk(['merge-base', '--is-ancestor', S.tagSha, 'origin/main'])) bad(`標籤 ${tag} 的 commit 不是 origin/main 的祖先（標籤只能打在 main）`)
      const a = blobOf(tag, WORKFLOW), b = blobOf('origin/main', WORKFLOW)
      if (!a || !b) bad(`讀不到 ${WORKFLOW}（標籤或 origin/main 上沒有）`)
      if (a !== b) bad(`標籤上的 ${WORKFLOW} 與 origin/main 上的不同（位元組不相同）`)
      // 找 run
      const okRun = r => r && (r.path === WORKFLOW || r.path === `${WORKFLOW}@refs/tags/${tag}`) && r.event === 'push' && r.head_sha === S.tagSha && (r.head_branch === undefined || r.head_branch === tag)
      let run
      if (opts.runId) {
        run = JSON.parse(gh(['api', `repos/${REPO}/actions/runs/${opts.runId}`]))
        if (!okRun(run)) bad(`run ${opts.runId} 不是這個標籤的 ${WORKFLOW} push run（path／event／head_sha 對不上）`)
        if (run.conclusion !== 'success') bad(`run ${opts.runId} 的結果是 ${run.conclusion}，不是 success`)
      } else {
        const list = JSON.parse(gh(['api', `repos/${REPO}/actions/workflows/asn-release.yml/runs?event=push&head_sha=${S.tagSha}&per_page=100`])).workflow_runs ?? []
        const mine = list.filter(okRun)
        const ok = mine.filter(r => r.conclusion === 'success')
        if (ok.length === 0) bad(`找不到這個標籤的成功 run（同標籤的 push run 共 ${mine.length} 個，沒有 success）`)
        if (ok.length > 1) bad(`同一個標籤有 ${ok.length} 個成功的 run（${ok.map(r => r.id).join('、')}）：用 --run-id 指定一個`)
        run = ok[0]
      }
      S.run = run
      // artifact
      const arts = JSON.parse(gh(['api', `repos/${REPO}/actions/runs/${run.id}/artifacts?per_page=100`])).artifacts ?? []
      const seen = new Map()
      for (const x of arts) {
        if (!ARTIFACT_WHITELIST.includes(x.name)) bad(`artifact 名稱不在白名單：${x.name}`)
        if (x.workflow_run?.id !== run.id) bad(`artifact ${x.name} 不是這個 run 產的`)
        if (x.workflow_run?.head_sha !== S.tagSha) bad(`artifact ${x.name} 的 head_sha 不是標籤的 commit`)
        if (x.expired !== false) bad(`artifact ${x.name} 已過期（14 天）：重打標籤（升版）或重跑 CI`)
        if (seen.has(x.name)) bad(`artifact ${x.name} 出現不只一次`)
        seen.set(x.name, x)
      }
      S.artifacts = seen
      if (!seen.has('asn-installer-unsigned')) bad('沒有 asn-installer-unsigned 這個 artifact')
      // Play 有沒有上：要最新一次嘗試的 jobs
      if (opts.withPlay === 'yes') S.play = true
      else if (opts.withPlay === 'no') S.play = false
      else {
        const jobs = JSON.parse(gh(['api', `repos/${REPO}/actions/runs/${run.id}/attempts/${run.run_attempt ?? 1}/jobs?per_page=100`])).jobs ?? []
        const up = jobs.find(j => j.name === 'android-upload')
        if (!up) bad('--with-play auto 找不到 android-upload 這個 job，無法判斷有沒有上 Play：請明確給 --with-play yes 或 --with-play no')
        S.play = up.conclusion === 'success'
        if (!S.play) log('android-upload 這個 job 沒有成功：這次官網版本紀錄不帶 Play')
      }
    })

    // ---- 2 下載（全新空資料夾）、核對、來源證明
    await step(2, '下載與來源證明', async () => {
      S.dir = deps.mkTmp()
      if (fsx.readdirSync(S.dir).length) bad('下載資料夾不是空的')
      const fetchZip = (name, wanted) => {
        const art = S.artifacts.get(name)
        const zip = path.join(S.dir, `${name}.zip`)
        ghDownloadArtifact(art.id, zip)
        const want = String(art.digest ?? '').replace(/^sha256:/, '')
        if (!/^[0-9a-f]{64}$/.test(want)) bad(`artifact ${name} 的 API 沒有 sha256 digest`)
        const buf = fsx.readFileSync(zip)
        if (sha256(buf) !== want) bad(`artifact ${name} 下載的 zip sha256 與 API 的 digest 不同`)
        const entries = listZip(buf)
        const out = {}
        for (const w of wanted) {
          const e = entries.find(x => x.name === w)
          if (e) out[w] = e.data
        }
        return out
      }
      const exeName = installerName(version)
      const inst = fetchZip('asn-installer-unsigned', [exeName, 'SHA256SUMS.txt'])
      if (!inst[exeName]?.length) bad(`artifact 裡沒有 ${exeName}`)
      if (!inst['SHA256SUMS.txt']) bad('artifact 裡沒有 SHA256SUMS.txt')
      const sums = new Map(inst['SHA256SUMS.txt'].toString('utf8').split(/\r?\n/).map(l => /^([0-9a-f]{64}) [ *]?(\S.*)$/.exec(l)).filter(Boolean).map(m => [m[2], m[1]]))
      if (sums.get(exeName) !== sha256(inst[exeName])) bad(`${exeName} 的 sha256 與 SHA256SUMS.txt 不符`)
      S.exe = path.join(S.dir, exeName)
      fsx.writeFileSync(S.exe, inst[exeName])
      S.exeSha = sha256(inst[exeName])
      S.exeSize = inst[exeName].length
      // 來源證明（必要）
      try {
        gh(['attestation', 'verify', S.exe, '--repo', REPO, '--signer-workflow', `${REPO}/${WORKFLOW}`, '--source-ref', `refs/tags/${tag}`, '--source-digest', S.tagSha])
      } catch { bad('來源證明（gh attestation verify）沒過') }
      // 官網紀錄：items-file 優先，否則 CI 草稿；簽章前先預檢，免得發完才發現寫不進去
      let given = null
      if (opts.itemsFile) {
        try { given = JSON.parse(fsx.readFileSync(opts.itemsFile, 'utf8')) } catch { bad('--items-file 讀不到或不是合法的 JSON') }
      } else if (S.artifacts.has('asn-site-draft')) {
        const d = fetchZip('asn-site-draft', ['site-record-draft.json'])
        if (!d['site-record-draft.json']) bad('asn-site-draft 裡沒有 site-record-draft.json')
        try { given = JSON.parse(d['site-record-draft.json'].toString('utf8')) } catch { bad('site-record-draft.json 不是合法的 JSON') }
      } else bad('沒有官網紀錄草稿（asn-site-draft），也沒給 --items-file')
      S.given = given
      S.record = buildRecord()
      const problems = checkRecord(S.record)
      if (problems.length) bad(`官網紀錄預檢沒過：${problems.map(p => p.message).join('；')}`)
    })

    function buildRecord() {
      const g = S.given
      const obj = Array.isArray(g) ? { items: g } : g
      if (!obj || typeof obj !== 'object') bad('官網紀錄不是物件或清單')
      if (obj.version !== undefined && obj.version !== version) bad(`官網紀錄的版本是 ${obj.version}，不是 ${version}`)
      const commit = S.tagSha.slice(0, 8)
      if (obj.commit !== undefined && obj.commit !== commit) bad(`官網紀錄的 commit 是 ${obj.commit}，標籤是 ${commit}`)
      return { version, date: obj.date, commit, items: obj.items, platforms: S.play ? ['官網', 'Play'] : ['官網'] }
    }

    // ---- 3 本機簽章
    await step(3, '本機簽章', async () => {
      const sigPath = await signer.sign(S.exe)
      if (sigPath !== `${S.exe}.sig`) bad('簽章檔不在預期的位置（安裝檔旁的 .sig）')
      S.sigText = fsx.readFileSync(sigPath, 'utf8')
      if (!S.sigText.trim()) bad('簽章檔是空的')
      S.sigPath = sigPath
      if (sha256(fsx.readFileSync(S.exe)) !== S.exeSha) bad('簽章過程中安裝檔被改動')
    })

    // ---- 4 驗簽＋反向驗證
    await step(4, '驗簽與反向驗證', async () => {
      let pubkeyText
      try { pubkeyText = JSON.parse(showAt(tag, 'relay/asn/src-tauri/tauri.conf.json')).plugins.updater.pubkey } catch { bad('讀不到標籤上 tauri.conf.json 的 updater 公鑰') }
      const r = verifyAll({ pubkeyText, sigText: S.sigText, fileBytes: fsx.readFileSync(S.exe), expectedFileName: installerName(version) })
      if (!r.ok) bad(`驗簽沒過：${r.problems.join('；')}`)
    })

    // ---- 5 產 latest.json 與 index.html（只寫暫存資料夾）
    await step(5, '產 latest.json 與 index.html', async () => {
      let changelog
      try { changelog = showAt(tag, 'relay/asn/CHANGELOG.md') } catch { bad('讀不到標籤上的 CHANGELOG.md') }
      const { notes } = resolveNotes({ arg: '', changelog, version, date: S.record.date })
      S.notes = notes
      const latest = buildLatestJson({ version, notes, pubDate: new Date(now()), signature: S.sigText })
      const m = sigMatchesLatest({ sigText: S.sigText, latest })
      if (!m.ok) bad(m.problems.join('；'))
      let html
      try { html = showAt(tag, 'site/public/index.html') } catch { bad('讀不到標籤上的 site/public/index.html') }
      html = html.replace(/\r\n/g, '\n')
      if (!INSTALLER_HREF_RE.test(html)) bad('index.html 裡找不到安裝檔連結，不知道要改哪裡')
      INSTALLER_HREF_RE.lastIndex = 0
      const patched = patchDownloadLink(html, installerUrl(version))
      S.latest = latest
      S.latestText = `${JSON.stringify(latest, null, 2)}\n`
      S.indexText = patched
      const out = path.join(S.dir, 'site-out')
      fsx.mkdirSync(out, { recursive: true })
      fsx.writeFileSync(path.join(out, 'latest.json'), S.latestText)
      fsx.writeFileSync(path.join(out, 'index.html'), S.indexText)
    })

    // ---- 6 版本不退
    await step(6, '版本不退', async () => {
      let online
      try {
        const res = await fetchFn(`${SITE_BASE}/update/latest.json?t=${now()}`, { headers: { 'cache-control': 'no-cache' } })
        if (!res.ok) bad(`讀不到線上 latest.json（HTTP ${res.status}）`)
        const onlineObj = JSON.parse(await res.text())
        online = onlineObj.version
        // #1964：記下線上目前有沒有 Linux 項（電腦版產的 latest.json 只有 windows-x86_64，部署後 Linux 項會暫時消失）
        S.onlineHadLinux = !!onlineObj?.platforms?.['linux-x86_64']
      } catch (e) { if (e instanceof StepError) throw e; bad('讀不到線上 latest.json，無法確認版本不退') }
      if (!/^\d+\.\d+\.\d+$/.test(online ?? '')) bad('線上 latest.json 的 version 格式不對')
      const c = compareVersions(version, online)
      if (c < 0) bad(`版本會倒退：這次 ${version}，線上已是 ${online}`)
      if (c === 0 && !opts.sameVersion) bad(`線上已經是 ${version}：要重發同一版請加 --same-version`)
    })

    if (dryRun) {
      log('--dry-run：到版本不退為止，全部寫在暫存資料夾，沒有發布')
      return { ok: true, dryRun: true, failedStep: null, completed, record: S.record, latest: S.latest, dir: S.dir }
    }

    // ---- 7 寫入網站檔並發 Release
    await step(7, '寫入網站檔並發 Release', async () => {
      fsx.writeFileSync(path.join(repoRoot, ...SITE_FILES[0].split('/')), S.latestText)
      fsx.writeFileSync(path.join(repoRoot, ...SITE_FILES[1].split('/')), S.indexText)
      await publishRelease({
        version, target: S.tagSha, notes: S.notes, gh, ghDownload, fetchFn, log,
        files: [{ name: installerName(version), file: S.exe }, { name: `${installerName(version)}.sig`, file: S.sigPath }],
      })
    })

    // #1964：latest.json 只有一個 version，舊的 Linux 項不能留（Linux 端會看到新版、裝到舊檔，無限更新），所以電腦版部署後 Linux 項會暫時沒有。
    // 不靜默：每次都寫 log；這版沒打 linux-v 標籤（不發 Linux）時另貼群組。有發 Linux 時空窗只有幾分鐘（常駐程式接著跑），不貼群組以免洗版（領隊 #1964 定 A）
    const noteLinuxGap = async () => {
      if (!S.onlineHadLinux) return
      let linuxTag = ''
      try { linuxTag = String(git(['tag', '--list', `linux-v${version}`])).trim() } catch { linuxTag = '' }
      const releasing = !!linuxTag
      log(`latest.json 的 Linux 項已暫時移除（電腦版 v${version} 只帶 windows-x86_64）：${releasing ? `這版有 linux-v${version}，等 Linux 發佈補回` : `這版沒有 linux-v${version}，Linux 使用者停在上一版`}`)
      if (!releasing) await post(`【Linux 更新資訊暫停】v${version}：這版不發 Linux，Linux 使用者停在上一版，直到下一個有 Linux 的版本。`)
    }

    // ---- 8 firebase 部署（predeploy 照舊由 firebase.json 觸發）
    await step(8, 'firebase 部署', async () => {
      await firebase({ version: S.firebaseVersion, args: ['deploy', '--only', 'hosting', '--project', FIREBASE_PROJECT], cwd: path.join(repoRoot, 'site') })
      await noteLinuxGap()
    })

    // ---- 9 線上核對
    await step(9, '線上核對', async () => {
      const skill = JSON.parse(fsx.readFileSync(path.join(repoRoot, 'site', 'public', 'skill', 'version.json'), 'utf8'))
      const r = await verifyOnline({
        expected: { version, notes: S.latest.notes, signature: S.latest.platforms[PLATFORM].signature, sigText: S.sigText, exeSha256: S.exeSha, exeSize: S.exeSize, skill },
        base: SITE_BASE, fetchFn, sleep, now, attempts: deps.onlineAttempts ?? 10, intervalMs: deps.onlineIntervalMs ?? 15000, log,
      })
      if (!r.ok) bad(`線上核對 ${r.attempts} 次都沒過：${r.problems.join('；')}`)
    })

    // ---- 10 官網版本紀錄
    await step(10, '官網版本紀錄', async () => {
      const rec = buildRecord()
      const problems = checkRecord(rec)
      if (problems.length) bad(`官網紀錄再檢查沒過：${problems.map(p => p.message).join('；')}`)
      const args = ['site', 'release', '--version', rec.version, '--date', rec.date, '--commit', rec.commit,
        ...rec.items.flatMap(i => ['--item', i]), ...rec.platforms.flatMap(p => ['--platform', p])]
      const r = await asnCli(args)
      if (r?.status !== 0) { log(`asn-cli site release 原文：${asnCliFail(r)}`); bad(`asn-cli site release 失敗（結束碼 ${r?.status}，原文見發版機器終端機）`) }
      S.record = rec
    })

    // ---- 11 貼群組
    await step(11, '貼群組', async () => {
      const text = `【發版完成】v${version}：安裝檔已發 GitHub Release、官網已部署並線上核對通過、官網版本紀錄已寫入（平台：${S.record.platforms.join('、')}）。commit ${S.record.commit}。接著提交兩個網站檔回 main。`
      const r = await asnCli(['send', '--room', room, '--body', text])
      if (r?.status !== 0) { log(`貼群組 asn-cli 原文：${asnCliFail(r)}`); bad(`貼群組失敗（結束碼 ${r?.status}）`) }
    })

    // ---- 12 提交回 main
    await step(12, '提交回 main', async () => {
      const staged = git(['diff', '--cached', '--name-only']).split('\n').map(s => s.trim()).filter(Boolean)
      const extra = staged.filter(f => !SITE_FILES.includes(f))
      if (extra.length) bad(`暫存區有網站檔以外的檔案：${extra.slice(0, 5).join('、')}`)
      const changed = git(['status', '--porcelain', '--', ...SITE_FILES]).trim()
      if (!changed) { log('兩個網站檔與 HEAD 相同，不需要提交'); return }
      const t = await runTests()
      if (!t?.ok) bad('提交前的相關測試沒過')
      // 標籤可以落後 main：不在標籤 commit 上提交，改在最新 origin/main 上用暫存的 worktree 只套這兩個檔，
      // 不動使用者目前工作樹與暫存區的其他東西；推送被拒（有人又推了）就重新 fetch 重做，最多共 3 次，不強推、不 rebase。
      const MAX_TRIES = 3
      for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
        git(['fetch', 'origin', 'main', '--quiet'])
        const base = first(git(['rev-parse', 'origin/main']))
        if (!/^[0-9a-f]{40}$/.test(base)) bad('讀不到最新 origin/main 的 commit')
        for (const f of SITE_FILES) {
          const onTag = blobOf(tag, f), onMain = blobOf(base, f)
          if (!onTag || onTag !== onMain) bad(`最新 origin/main 上的 ${f} 與標籤 ${tag} 上的不同（標籤之後有人改過）：不覆蓋，請人工處理`)
        }
        const wt = deps.mkTmp()
        let sha
        try {
          git(['worktree', 'add', '--detach', wt, base])
          for (const f of SITE_FILES) {
            const dest = path.join(wt, ...f.split('/'))
            fsx.mkdirSync(path.dirname(dest), { recursive: true })
            fsx.writeFileSync(dest, fsx.readFileSync(path.join(repoRoot, ...f.split('/'))))
          }
          git(['-C', wt, 'add', '--', ...SITE_FILES])
          if (!git(['-C', wt, 'diff', '--cached', '--name-only']).trim()) { log('最新 origin/main 上的兩個網站檔已是這次的內容，不需要提交'); return }
          git(['-C', wt, 'commit', '-m', `發版 v${version}：更新 latest.json 與首頁下載連結`, '--', ...SITE_FILES])
          sha = first(git(['-C', wt, 'rev-parse', 'HEAD']))
        } finally {
          try { git(['worktree', 'remove', '--force', wt]) } catch { log(`暫存 worktree 沒清掉：${wt}（可手動 git worktree remove）`) }
        }
        try { git(['push', 'origin', `${sha}:main`]); return } catch { log(`推送被拒（第 ${attempt} 次）${attempt < MAX_TRIES ? '，重新 fetch 重做' : ''}`) }
      }
      bad(`推送回 main 連續被拒 ${MAX_TRIES} 次（有人一直在推 main）：請人工處理，不強推`)
    })

    return { ok: true, dryRun: false, failedStep: null, completed, record: S.record, latest: S.latest, dir: S.dir }
  } catch (e) {
    const known = e instanceof StepError
    const done = completed.length ? completed.join('、') : '（無）'
    // 只有自己寫的訊息才貼出去；其他錯誤（外部指令的原文）只留終端機
    const text = `【發版中止】v${version}：卡在第 ${st.step} 步（${st.name}）${known ? `：${e.message}` : '（詳見發版機器終端機）'}。已完成：${done}${onlineAheadOfMain(completed, version)}`
    log(`${text}${known ? '' : `\n原因：${e?.message ?? e}`}`)
    await post(text)
    return { ok: false, dryRun, failedStep: st.step, failedName: st.name, completed, error: e.message }
  }
}

// ---- 真的接線（只有直接執行才用到；測試不碰）
function realDeps(repoRoot, env) {
  const git = args => execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 })
  const gh = args => { try { return execFileSync('gh', args, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 }) } catch (e) { throw new Error(String(e.stderr || e.message)) } }
  const keyDir = env.ASN_UPDATER_KEY_DIR || path.join(os.homedir(), '.asn', 'updater')
  const keyFile = path.join(keyDir, 'asn.key'), passFile = path.join(keyDir, 'asn.key.password')
  const tauriJs = path.join(repoRoot, 'relay', 'asn', 'node_modules', '@tauri-apps', 'cli', 'tauri.js')
  return {
    repoRoot, git, gh,
    ghDownloadArtifact: (id, dest) => { const buf = execFileSync('gh', ['api', `repos/${REPO}/actions/artifacts/${id}/zip`], { cwd: repoRoot, maxBuffer: 1024 * 1024 * 1024 }); fs.writeFileSync(dest, buf) },
    ghDownload: (version, name, dir) => gh(['release', 'download', `v${version}`, '--repo', REPO, '--pattern', name, '--dir', dir]),
    asnCli: makeAsnCli({ env }),
    // firebase-tools 固定版本；版本字串已驗證過是 x.y.z，shell 只用來找 npx.cmd
    firebase: ({ version, args, cwd }) => {
      const r = spawnSync(`npx firebase-tools@${version} ${args.join(' ')}`, { cwd, shell: true, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
      if (r.status !== 0) throw new Error(`firebase ${args[0]} 失敗（結束碼 ${r.status}）`)
      return r.stdout
    },
    // 簽章：金鑰路徑與密碼只在這裡碰；密碼走環境變數交給 tauri，不放在參數、不印
    signer: {
      check: () => { try { const k = fs.statSync(keyFile); return { ok: k.isFile() && k.size > 0 } } catch { return { ok: false } } },
      sign: exe => {
        const childEnv = { ...env }
        if (fs.existsSync(passFile)) childEnv.TAURI_SIGNING_PRIVATE_KEY_PASSWORD = fs.readFileSync(passFile, 'utf8').replace(/[\r\n]+$/, '')
        const r = spawnSync(process.execPath, [tauriJs, 'signer', 'sign', '-f', keyFile, exe], { env: childEnv, encoding: 'utf8' })
        if (r.status !== 0) throw new Error(`tauri signer sign 失敗（結束碼 ${r.status}）`)
        return `${exe}.sig`
      },
    },
    fetchFn: fetch,
    sleep: ms => new Promise(r => setTimeout(r, ms)),
    publishRelease: realPublishRelease,
    attachRelease: realAttachToRelease,
    runTests: () => {
      const files = ['tests/site_predeploy.test.mjs', 'tests/github_release.test.mjs', 'relay/asn/test/ci-workflow-guard.test.mjs', 'relay/asn/test/release-workflow-guard.test.mjs', 'relay/asn/test/local-sign-publish-linux.test.mjs'].filter(f => fs.existsSync(path.join(repoRoot, f)))
      const r = spawnSync(process.execPath, ['--test', ...files], { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
      return { ok: r.status === 0, output: r.stdout }
    },
    mkTmp: () => fs.mkdtempSync(path.join(os.tmpdir(), 'asn-local-sign-')),
    log: m => console.log(m),
  }
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const opts = parseArgs(argv)
  if (opts.error) { console.error(`${opts.error}\n用法：[--platform linux] --tag v<版本>（Linux 用 linux-v<版本>） [--run-id <id>] [--dry-run] [--with-play auto|yes|no] [--same-version] [--items-file <json>] [--room <代號>]`); return 2 }
  opts.room = opts.room ?? env.ASN_RELEASE_ROOM ?? null
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
  const r = await localSignPublish(opts, realDeps(repoRoot, env))
  console.log(r.ok ? (r.dryRun ? '演練完成（沒有發布任何東西）' : `完成：v${opts.version}`) : `中止於第 ${r.failedStep} 步（${r.failedName}）`)
  return r.ok ? 0 : 1
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(await main())
