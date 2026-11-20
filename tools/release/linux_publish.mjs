// Linux 版的本機簽章與發布（接在電腦版 local_sign_publish.mjs 之後；由 local_sign_publish 用 --platform linux 轉進來）。
// 前提：同一版的電腦版已經用 v<版本> 發好（Release 已公開、官網 latest.json 已是這一版）。Linux 版：
//   CI（asn-release-linux.yml、標籤 linux-v<版本>）只建未簽章的 .deb 與 .AppImage（artifact asn-linux-unsigned）＋來源證明；
//   這裡做：來源綁定 → 下載核對 → 驗來源證明 → 本機簽章 AppImage（同一把更新金鑰）→ 驗簽＋反向驗證 →
//   產 latest.json（既有內容不動，只新增 platforms["linux-x86_64"]）與首頁（只加 Linux 下載連結）→（--dry-run 到此為止，全寫暫存資料夾）
//   → 附加 deb、AppImage、AppImage.sig 到既有 Release v<版本>（不建、不轉正式、同名檔已存在就停）→ firebase 部署 → 線上核對 → 貼群組 → 提交回 main。
// 設計跟電腦版一樣：會碰外面的東西全部注入；簽章金鑰與密碼這裡不讀、不經手、不印。
import path from 'node:path'
import crypto from 'node:crypto'
import { REPO, releaseState } from './github_release.mjs'
import { verifyAll, sigMatchesLatest } from './verify_sig.mjs'
import { verifyOnlineLinux } from './verify_online.mjs'
import { listZip } from './zip_lite.mjs'

export const LINUX_WORKFLOW = '.github/workflows/asn-release-linux.yml'
export const LINUX_WORKFLOW_FILE = 'asn-release-linux.yml'
export const LINUX_ARTIFACT = 'asn-linux-unsigned'
export const LINUX_ARTIFACT_WHITELIST = [LINUX_ARTIFACT]
export const LINUX_PLATFORM = 'linux-x86_64'
export const LATEST_PATH = 'site/public/update/latest.json'
export const INDEX_PATH = 'site/public/index.html'
export const LINUX_SITE_FILES = [LATEST_PATH, INDEX_PATH]
export const SITE_BASE = 'https://asnmessenger.web.app'
const FIREBASE_PROJECT = 'asnmessenger'

export const linuxTag = version => `linux-v${version}`
export const appImageName = version => `ASN_${version}_amd64.AppImage`
export const debName = version => `ASN_${version}_amd64.deb`
export const linuxUrl = (version, name) => `${SITE_BASE}/update/${encodeURIComponent(name)}`

const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex')
class StepError extends Error {}
const bad = msg => { throw new StepError(msg) }
const first = s => String(s ?? '').trim()

/** latest.json：既有內容原樣保留，只新增 platforms["linux-x86_64"]；版本不對、沒有電腦版項、已有 Linux 項都擋 */
export function mergeLinuxLatest({ latestText, version, signature, url }) {
  let old
  try { old = JSON.parse(latestText) } catch { bad('官網 latest.json 不是合法的 JSON') }
  if (old?.version !== version) bad(`官網 latest.json 的版本是 ${old?.version}，不是 ${version}：Linux 版要接在同版的電腦版之後，請先發電腦版`)
  if (!old.platforms?.['windows-x86_64']) bad('官網 latest.json 沒有 windows-x86_64 項：先發電腦版')
  if (old.platforms[LINUX_PLATFORM]) bad(`官網 latest.json 已經有 ${LINUX_PLATFORM} 項：不覆蓋，請人工確認`)
  const sig = String(signature ?? '').trim()
  if (!sig) bad('簽章是空的')
  const next = { ...old, platforms: { ...old.platforms, [LINUX_PLATFORM]: { signature: sig, url } } }
  return { latest: next, text: `${JSON.stringify(next, null, 2)}\n` }
}

const LINUX_HREF_RE = /href="[^"]*\/update\/ASN_\d+\.\d+\.\d+_amd64\.(?:AppImage|deb)"/g
/** 首頁：下載區（id="download"）的「下載 Windows 版」按鈕後面加（或換掉）一行 Linux 連結；其餘原樣 */
export function patchLinuxLinks(html, version) {
  const app = linuxUrl(version, appImageName(version)), deb = linuxUrl(version, debName(version))
  if (LINUX_HREF_RE.test(html)) { LINUX_HREF_RE.lastIndex = 0; bad('首頁已經有 Linux 下載連結：不重複加，請人工確認') }
  LINUX_HREF_RE.lastIndex = 0
  const sec = html.indexOf('<section id="download">')
  if (sec < 0) bad('index.html 裡找不到下載區（<section id="download">），不知道要加在哪裡')
  const mark = '下載 Windows 版</a>'
  const at = html.indexOf(mark, sec)
  if (at < 0) bad('index.html 下載區裡找不到「下載 Windows 版」按鈕，不知道要加在哪裡')
  const end = at + mark.length
  const line = `\n        <p>Linux（64 位元）：<a href="${app}">下載 AppImage</a>、<a href="${deb}">下載 deb</a></p>`
  return html.slice(0, end) + line + html.slice(end)
}

/**
 * opts＝parseArgs 的結果（platform:'linux'）；deps 與電腦版同一組，另加 attachRelease（附加到既有 Release）。
 * 回 { ok, dryRun, failedStep, completed, latest, dir }
 */
export async function linuxSignPublish(opts, deps) {
  const { git, gh, ghDownloadArtifact, ghDownload, asnCli, firebase, signer, fetchFn, sleep, attachRelease, runTests, repoRoot } = deps
  const fsx = deps.fs
  const log = deps.log ?? (() => {})
  const now = deps.now ?? Date.now
  const { tag, version, dryRun } = opts
  const room = opts.room ?? null
  const completed = []
  const st = { step: 0, name: '' }
  const S = {}
  const exeName = appImageName(version), dName = debName(version)

  const step = async (n, name, fn) => { st.step = n; st.name = name; log(`第 ${n} 步：${name}`); await fn(); completed.push(`${n} ${name}`) }
  const gitOk = args => { try { git(args); return true } catch { return false } }
  const showAt = (ref, rel) => git(['show', `${ref}:${rel}`])
  const blobOf = (ref, rel) => { try { return first(git(['rev-parse', `${ref}:${rel}`])) } catch { return '' } }
  const post = async text => {
    if (dryRun) return
    let r
    try { r = await asnCli(['send', '--room', room, '--body', text]) } catch (e) { r = { status: 1, stderr: e.message } }
    if (r?.status !== 0) log(`貼群組失敗（結束碼 ${r?.status}），請自行通知：${text}`)
  }

  try {
    await step(0, '起手檢查', async () => {
      if (first(git(['rev-parse', '--is-shallow-repository'])) !== 'false') bad('這是淺複製（shallow clone），git 歷史不完整：改用完整複製再跑')
      let hist = ''
      try { hist = first(git(['log', '-n1', '--format=%H', '--', 'site/'])) } catch { hist = '' }
      if (!hist) bad('讀不到 site/ 的 git 歷史（git log -- site/ 失敗或沒有結果）：官網部署前檢查會靜默當成沒歷史，不繼續')
      if (!dryRun && !room) bad('沒有群組代號：用 --room 或環境變數 ASN_RELEASE_ROOM（失敗與完成都要貼群組）')
      git(['fetch', 'origin', 'main', '--tags', '--quiet'])
      S.tagSha = first(git(['rev-parse', `${tag}^{commit}`]))
      if (!/^[0-9a-f]{40}$/.test(S.tagSha)) bad(`讀不到標籤 ${tag} 的 commit`)
      S.originMain = first(git(['rev-parse', 'origin/main']))
      // Linux 版要改網站檔：工作樹要正好在最新 origin/main 上、且完全乾淨（標籤可以落後 main，網站檔以 main 為底）
      const head = first(git(['rev-parse', 'HEAD']))
      if (head !== S.originMain) bad(`HEAD（${head.slice(0, 8)}）不是最新的 origin/main（${S.originMain.slice(0, 8)}）：Linux 版以最新 main 的網站檔為底，先切到 origin/main`)
      const dirty = git(['status', '--porcelain']).split('\n').map(l => l.trimEnd()).filter(Boolean)
      if (dirty.length) bad(`工作樹不乾淨：${dirty.slice(0, 5).join('、')}${dirty.length > 5 ? ' 等' : ''}`)
      if (!first(git(['branch', '-r', '--contains', S.tagSha]))) bad(`標籤 ${tag} 的 commit 還沒推上 origin`)
      try { gh(['auth', 'status']) } catch { bad('gh 沒有登入（gh auth status 失敗）') }
      const verFile = fsx.readFileSync(path.join(repoRoot, 'tools', 'release', 'FIREBASE_TOOLS_VERSION'), 'utf8')
      S.firebaseVersion = verFile.split(/\r?\n/).map(l => l.trim()).find(l => l && !l.startsWith('#'))
      if (!/^\d+\.\d+\.\d+$/.test(S.firebaseVersion ?? '')) bad('tools/release/FIREBASE_TOOLS_VERSION 讀不到固定版本（x.y.z）')
      const who = first(await firebase({ version: S.firebaseVersion, args: ['login:list'], cwd: path.join(repoRoot, 'site') }))
      if (!who || /no authorized accounts/i.test(who)) bad('firebase 沒有登入（firebase login:list 沒有帳號）')
      const k = await signer.check()
      if (!k?.ok) bad('簽章金鑰檔不在或是空的（只檢查存在與大小）')
    })

    await step(1, '來源綁定', async () => {
      if (!gitOk(['merge-base', '--is-ancestor', S.tagSha, 'origin/main'])) bad(`標籤 ${tag} 的 commit 不是 origin/main 的祖先（標籤只能打在 main）`)
      const a = blobOf(tag, LINUX_WORKFLOW), b = blobOf('origin/main', LINUX_WORKFLOW)
      if (!a || !b) bad(`讀不到 ${LINUX_WORKFLOW}（標籤或 origin/main 上沒有）`)
      if (a !== b) bad(`標籤上的 ${LINUX_WORKFLOW} 與 origin/main 上的不同（位元組不相同）`)
      const okRun = r => r && (r.path === LINUX_WORKFLOW || r.path === `${LINUX_WORKFLOW}@refs/tags/${tag}`) && r.event === 'push' && r.head_sha === S.tagSha && (r.head_branch === undefined || r.head_branch === tag)
      let run
      if (opts.runId) {
        run = JSON.parse(gh(['api', `repos/${REPO}/actions/runs/${opts.runId}`]))
        if (!okRun(run)) bad(`run ${opts.runId} 不是這個標籤的 ${LINUX_WORKFLOW} push run（path／event／head_sha 對不上）`)
        if (run.conclusion !== 'success') bad(`run ${opts.runId} 的結果是 ${run.conclusion}，不是 success`)
      } else {
        const list = JSON.parse(gh(['api', `repos/${REPO}/actions/workflows/${LINUX_WORKFLOW_FILE}/runs?event=push&head_sha=${S.tagSha}&per_page=100`])).workflow_runs ?? []
        const mine = list.filter(okRun)
        const ok = mine.filter(r => r.conclusion === 'success')
        if (ok.length === 0) bad(`找不到這個標籤的成功 run（同標籤的 push run 共 ${mine.length} 個，沒有 success）`)
        if (ok.length > 1) bad(`同一個標籤有 ${ok.length} 個成功的 run（${ok.map(r => r.id).join('、')}）：用 --run-id 指定一個`)
        run = ok[0]
      }
      S.run = run
      const arts = JSON.parse(gh(['api', `repos/${REPO}/actions/runs/${run.id}/artifacts?per_page=100`])).artifacts ?? []
      const seen = new Map()
      for (const x of arts) {
        if (!LINUX_ARTIFACT_WHITELIST.includes(x.name)) bad(`artifact 名稱不在白名單：${x.name}`)
        if (x.workflow_run?.id !== run.id) bad(`artifact ${x.name} 不是這個 run 產的`)
        if (x.workflow_run?.head_sha !== S.tagSha) bad(`artifact ${x.name} 的 head_sha 不是標籤的 commit`)
        if (x.expired !== false) bad(`artifact ${x.name} 已過期（14 天）：重跑 CI 或重打標籤`)
        if (seen.has(x.name)) bad(`artifact ${x.name} 出現不只一次`)
        seen.set(x.name, x)
      }
      if (!seen.has(LINUX_ARTIFACT)) bad(`沒有 ${LINUX_ARTIFACT} 這個 artifact`)
      S.artifact = seen.get(LINUX_ARTIFACT)
      // 官網與 Release 的前提（簽章前就查，免得簽完才發現接不上）
      S.siteBlobs = Object.fromEntries(LINUX_SITE_FILES.map(f => [f, blobOf('origin/main', f)]))
      S.latestBase = fsx.readFileSync(path.join(repoRoot, ...LATEST_PATH.split('/')), 'utf8')
      mergeLinuxLatest({ latestText: S.latestBase, version, signature: 'x', url: 'x' })
      let rel
      try { rel = releaseState(gh, version) } catch { bad(`讀不到 Release v${version} 的狀態`) }
      if (!rel) bad(`Release v${version} 不存在：Linux 版只附加到已發的電腦版 Release，請先發電腦版`)
      for (const n of [dName, exeName, `${exeName}.sig`]) if (rel.assets.has(n)) bad(`Release v${version} 上已經有 ${n}：不覆蓋，請人工確認`)
    })

    await step(2, '下載與來源證明', async () => {
      S.dir = deps.mkTmp()
      if (fsx.readdirSync(S.dir).length) bad('下載資料夾不是空的')
      const zip = path.join(S.dir, `${LINUX_ARTIFACT}.zip`)
      ghDownloadArtifact(S.artifact.id, zip)
      const want = String(S.artifact.digest ?? '').replace(/^sha256:/, '')
      if (!/^[0-9a-f]{64}$/.test(want)) bad(`artifact ${LINUX_ARTIFACT} 的 API 沒有 sha256 digest`)
      const buf = fsx.readFileSync(zip)
      if (sha256(buf) !== want) bad(`artifact ${LINUX_ARTIFACT} 下載的 zip sha256 與 API 的 digest 不同`)
      const entries = listZip(buf)
      const get = n => entries.find(x => x.name === n)?.data
      const app = get(exeName), deb = get(dName), sumsRaw = get('SHA256SUMS.txt')
      if (!app?.length) bad(`artifact 裡沒有 ${exeName}`)
      if (!deb?.length) bad(`artifact 裡沒有 ${dName}`)
      if (!sumsRaw) bad('artifact 裡沒有 SHA256SUMS.txt')
      const sums = new Map(sumsRaw.toString('utf8').split(/\r?\n/).map(l => /^([0-9a-f]{64}) [ *]?(\S.*)$/.exec(l)).filter(Boolean).map(m => [m[2], m[1]]))
      if (sums.get(exeName) !== sha256(app)) bad(`${exeName} 的 sha256 與 SHA256SUMS.txt 不符`)
      if (sums.get(dName) !== sha256(deb)) bad(`${dName} 的 sha256 與 SHA256SUMS.txt 不符`)
      S.exe = path.join(S.dir, exeName); S.deb = path.join(S.dir, dName)
      fsx.writeFileSync(S.exe, app); fsx.writeFileSync(S.deb, deb)
      S.exeSha = sha256(app); S.exeSize = app.length; S.debSha = sha256(deb); S.debSize = deb.length
      for (const f of [S.exe, S.deb]) {
        try { gh(['attestation', 'verify', f, '--repo', REPO, '--signer-workflow', `${REPO}/${LINUX_WORKFLOW}`, '--source-ref', `refs/tags/${tag}`, '--source-digest', S.tagSha]) } catch { bad(`來源證明（gh attestation verify）沒過：${path.basename(f)}`) }
      }
    })

    await step(3, '本機簽章', async () => {
      const sigPath = await signer.sign(S.exe)
      if (sigPath !== `${S.exe}.sig`) bad('簽章檔不在預期的位置（AppImage 旁的 .sig）')
      S.sigText = fsx.readFileSync(sigPath, 'utf8')
      if (!S.sigText.trim()) bad('簽章檔是空的')
      S.sigPath = sigPath
      if (sha256(fsx.readFileSync(S.exe)) !== S.exeSha) bad('簽章過程中 AppImage 被改動')
    })

    await step(4, '驗簽與反向驗證', async () => {
      let pubkeyText
      try { pubkeyText = JSON.parse(showAt(tag, 'relay/asn/src-tauri/tauri.conf.json')).plugins.updater.pubkey } catch { bad('讀不到標籤上 tauri.conf.json 的 updater 公鑰') }
      const r = verifyAll({ pubkeyText, sigText: S.sigText, fileBytes: fsx.readFileSync(S.exe), expectedFileName: exeName })
      if (!r.ok) bad(`驗簽沒過：${r.problems.join('；')}`)
    })

    await step(5, '產 latest.json 與 index.html', async () => {
      const m = mergeLinuxLatest({ latestText: S.latestBase, version, signature: S.sigText, url: linuxUrl(version, exeName) })
      const chk = sigMatchesLatest({ sigText: S.sigText, latest: m.latest, platform: LINUX_PLATFORM })
      if (!chk.ok) bad(chk.problems.join('；'))
      let html
      try { html = fsx.readFileSync(path.join(repoRoot, ...INDEX_PATH.split('/')), 'utf8') } catch { bad('讀不到 site/public/index.html') }
      S.latest = m.latest; S.latestText = m.text
      S.indexText = patchLinuxLinks(html.replace(/\r\n/g, '\n'), version)
      const out = path.join(S.dir, 'site-out')
      fsx.mkdirSync(out, { recursive: true })
      fsx.writeFileSync(path.join(out, 'latest.json'), S.latestText)
      fsx.writeFileSync(path.join(out, 'index.html'), S.indexText)
    })

    if (dryRun) {
      log('--dry-run：到簽章與驗簽（含暫存的網站檔產物）為止，全部寫在暫存資料夾，沒有發布')
      return { ok: true, dryRun: true, failedStep: null, completed, latest: S.latest, dir: S.dir }
    }

    await step(6, '寫入網站檔並附加到 Release', async () => {
      // 線上版本要正好是這一版（電腦版已部署）；不是就不附加
      let online
      try {
        const res = await fetchFn(`${SITE_BASE}/update/latest.json?t=${now()}`, { headers: { 'cache-control': 'no-cache' } })
        if (!res.ok) bad(`讀不到線上 latest.json（HTTP ${res.status}）`)
        online = JSON.parse(await res.text())
      } catch (e) { if (e instanceof StepError) throw e; bad('讀不到線上 latest.json，無法確認電腦版已上線') }
      if (online?.version !== version) bad(`線上 latest.json 的版本是 ${online?.version}，不是 ${version}：電腦版還沒部署這一版`)
      S.onlineWindows = online.platforms?.['windows-x86_64']
      if (!S.onlineWindows) bad('線上 latest.json 沒有 windows-x86_64 項')
      fsx.writeFileSync(path.join(repoRoot, ...LATEST_PATH.split('/')), S.latestText)
      fsx.writeFileSync(path.join(repoRoot, ...INDEX_PATH.split('/')), S.indexText)
      await attachRelease({
        version, gh, ghDownload, fetchFn, log,
        files: [{ name: dName, file: S.deb }, { name: exeName, file: S.exe }, { name: `${exeName}.sig`, file: S.sigPath }],
      })
    })

    await step(7, 'firebase 部署', async () => {
      await firebase({ version: S.firebaseVersion, args: ['deploy', '--only', 'hosting', '--project', FIREBASE_PROJECT], cwd: path.join(repoRoot, 'site') })
    })

    await step(8, '線上核對', async () => {
      const r = await verifyOnlineLinux({
        expected: {
          version, windows: { signature: S.onlineWindows.signature, url: S.onlineWindows.url },
          linux: { signature: S.latest.platforms[LINUX_PLATFORM].signature, url: S.latest.platforms[LINUX_PLATFORM].url, sigText: S.sigText, appImage: { name: exeName, sha256: S.exeSha, size: S.exeSize }, deb: { name: dName, sha256: S.debSha, size: S.debSize } },
        },
        base: SITE_BASE, fetchFn, sleep, now, attempts: deps.onlineAttempts ?? 10, intervalMs: deps.onlineIntervalMs ?? 15000, log,
      })
      if (!r.ok) bad(`線上核對 ${r.attempts} 次都沒過：${r.problems.join('；')}`)
    })

    await step(9, '貼群組', async () => {
      const text = `【Linux 版發版完成】v${version}：AppImage、deb 已附加到 GitHub Release v${version}、官網 latest.json 已加 ${LINUX_PLATFORM}、首頁已加 Linux 下載連結，部署與線上核對通過。接著提交兩個網站檔回 main。`
      const r = await asnCli(['send', '--room', room, '--body', text])
      if (r?.status !== 0) bad(`貼群組失敗（結束碼 ${r?.status}）`)
    })

    await step(10, '提交回 main', async () => {
      const staged = git(['diff', '--cached', '--name-only']).split('\n').map(s => s.trim()).filter(Boolean)
      const extra = staged.filter(f => !LINUX_SITE_FILES.includes(f))
      if (extra.length) bad(`暫存區有網站檔以外的檔案：${extra.slice(0, 5).join('、')}`)
      const changed = git(['status', '--porcelain', '--', ...LINUX_SITE_FILES]).trim()
      if (!changed) { log('兩個網站檔與 HEAD 相同，不需要提交'); return }
      const t = await runTests()
      if (!t?.ok) bad('提交前的相關測試沒過')
      const MAX_TRIES = 3
      for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
        git(['fetch', 'origin', 'main', '--quiet'])
        const base = first(git(['rev-parse', 'origin/main']))
        if (!/^[0-9a-f]{40}$/.test(base)) bad('讀不到最新 origin/main 的 commit')
        for (const f of LINUX_SITE_FILES) {
          if (!S.siteBlobs[f] || blobOf(base, f) !== S.siteBlobs[f]) bad(`最新 origin/main 上的 ${f} 與發版開始時的不同（之後有人改過）：不覆蓋，請人工處理`)
        }
        const wt = deps.mkTmp()
        let sha
        try {
          git(['worktree', 'add', '--detach', wt, base])
          for (const f of LINUX_SITE_FILES) {
            const dest = path.join(wt, ...f.split('/'))
            fsx.mkdirSync(path.dirname(dest), { recursive: true })
            fsx.writeFileSync(dest, fsx.readFileSync(path.join(repoRoot, ...f.split('/'))))
          }
          git(['-C', wt, 'add', '--', ...LINUX_SITE_FILES])
          if (!git(['-C', wt, 'diff', '--cached', '--name-only']).trim()) { log('最新 origin/main 上的兩個網站檔已是這次的內容，不需要提交'); return }
          git(['-C', wt, 'commit', '-m', `發版 Linux v${version}：latest.json 加 ${LINUX_PLATFORM}、首頁加 Linux 下載連結`, '--', ...LINUX_SITE_FILES])
          sha = first(git(['-C', wt, 'rev-parse', 'HEAD']))
        } finally {
          try { git(['worktree', 'remove', '--force', wt]) } catch { log(`暫存 worktree 沒清掉：${wt}（可手動 git worktree remove）`) }
        }
        try { git(['push', 'origin', `${sha}:main`]); return } catch { log(`推送被拒（第 ${attempt} 次）${attempt < MAX_TRIES ? '，重新 fetch 重做' : ''}`) }
      }
      bad(`推送回 main 連續被拒 ${MAX_TRIES} 次（有人一直在推 main）：請人工處理，不強推`)
    })

    return { ok: true, dryRun: false, failedStep: null, completed, latest: S.latest, dir: S.dir }
  } catch (e) {
    const known = e instanceof StepError
    const done = completed.length ? completed.join('、') : '（無）'
    const text = `【Linux 發版中止】v${version}：卡在第 ${st.step} 步（${st.name}）${known ? `：${e.message}` : '（詳見發版機器終端機）'}。已完成：${done}`
    log(`${text}${known ? '' : `\n原因：${e?.message ?? e}`}`)
    await post(text)
    return { ok: false, dryRun, failedStep: st.step, failedName: st.name, completed, error: e.message }
  }
}
