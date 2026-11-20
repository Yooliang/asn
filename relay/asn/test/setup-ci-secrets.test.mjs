// tools/release/setup_ci_secrets.mjs（#1892，規格 4.2）：gh、檔案、輸出都用注入的假函式，不碰真的 GitHub
import test from 'node:test'
import assert from 'node:assert/strict'
import { run, parseArgs, SECRET_NAMES } from '../../../tools/release/setup_ci_secrets.mjs'

const SA = { type: 'service_account', client_email: 'x@y.iam.gserviceaccount.com', private_key: '-----BEGIN PRIVATE KEY-----\nSECRETKEYBODY\n-----END PRIVATE KEY-----\n' }
const SA_TEXT = JSON.stringify(SA)
const JKS = Buffer.from([0xfe, 0xed, 0xfe, 0xed, 1, 2, 3, 4, 9, 9])
const PASS = 'hunter2-PASSWORD'
const GS = '{"project_info":{"project_id":"asn-test"}}'
const P = { sa: '/k/sa.json', jks: '/k/upload.jks', pass: '/k/upload.jks.password', gs: '/k/google-services.json' }
const baseArgs = ['--play-sa-json', P.sa, '--upload-jks', P.jks, '--upload-password-file', P.pass, '--google-services', P.gs]

const goodFiles = () => ({ [P.sa]: Buffer.from(SA_TEXT), [P.jks]: JKS, [P.pass]: Buffer.from(PASS + '\r\n'), [P.gs]: Buffer.from(GS) })

/** 假環境：gh 全記錄；opts.failOn 讓指定 secret 寫入失敗；opts.envMissing 讓 environment 查不到；opts.existingEnv 是 environment 已有的設定（GET 的回傳） */
function setup(files = goodFiles(), opts = {}) {
  const calls = []
  const out = []
  const written = new Set()
  const gh = (args, o = {}) => {
    calls.push({ args: [...args], input: o.input })
    const j = args.join(' ')
    if (j === 'auth status') return ''
    if (j.endsWith('--jq .permissions.admin')) return 'true\n'
    if (/^api repos\/[^/]+\/[^/]+\/environments\/release$/.test(j)) { if (opts.envMissing) throw new Error('gh: Not Found (HTTP 404)'); if (opts.envError) throw new Error('gh: Internal Server Error (HTTP 500)'); return JSON.stringify(opts.existingEnv ?? {}) }
    if (args[0] === 'secret' && args[1] === 'set') {
      if (opts.failOn === args[2]) throw new Error(`HTTP 500 ${opts.leak ?? ''}`)
      written.add(args[2]); return ''
    }
    if (args[0] === 'secret' && args[1] === 'list') return JSON.stringify([...written].map(name => ({ name })))
    if (j.endsWith('deployment-branch-policies') && !args.includes('-X')) return JSON.stringify({ branch_policies: opts.hasTagPolicy ? [{ name: 'v*', type: 'tag' }] : [] })
    if (j.endsWith('/rulesets')) return JSON.stringify(opts.noRuleset ? [] : [{ id: 7, target: 'tag', enforcement: 'active' }])
    if (j.endsWith('/rulesets/7')) return JSON.stringify({ conditions: { ref_name: { include: ['refs/tags/v*'] } }, rules: [{ type: 'creation' }] })
    return ''
  }
  const exec = argv => run({ argv, gh, readFile: f => { if (!(f in files)) throw new Error('ENOENT'); return files[f] }, log: m => out.push(m), warn: m => out.push(m), env: {}, home: '/home/x', root: '/repo' })
  return { calls, out, exec, written }
}
const secretSets = calls => calls.filter(c => c.args[0] === 'secret' && c.args[1] === 'set')

test('dry-run：一次 gh 都不呼叫（含 auth status），含 --setup-env 也一樣', () => {
  for (const args of [[...baseArgs, '--dry-run'], ['--dry-run', '--setup-env']]) {
    const s = setup()
    assert.equal(s.exec(args), 0)
    assert.equal(s.calls.length, 0)
  }
})

test('缺檔：列出缺的、結束碼非 0、一個都不寫、gh 零呼叫', () => {
  const f = goodFiles(); delete f[P.jks]
  const s = setup(f)
  assert.equal(s.exec(baseArgs), 1)
  assert.equal(s.calls.length, 0)
  assert.match(s.out.join('\n'), /ASN_PLAY_UPLOAD_JKS[\s\S]*找不到/)
})

test('檢查：服務帳戶缺欄位或 type 不對失敗；JKS 空失敗；密碼只有換行失敗；google-services 非 JSON 失敗', () => {
  const cases = [
    [P.sa, Buffer.from(JSON.stringify({ type: 'service_account', client_email: 'a' })), /private_key/],
    [P.sa, Buffer.from(JSON.stringify({ ...SA, type: 'user' })), /service_account/],
    [P.sa, Buffer.from('not json SECRETKEYBODY'), /不是合法/],
    [P.jks, Buffer.alloc(0), /空的/],
    [P.pass, Buffer.from('\r\n\n'), /空的/],
    [P.gs, Buffer.from('{bad'), /不是合法/],
  ]
  for (const [file, buf, re] of cases) {
    const s = setup({ ...goodFiles(), [file]: buf })
    assert.equal(s.exec(baseArgs), 1, String(re))
    assert.equal(s.calls.length, 0)
    assert.match(s.out.join('\n'), re)
  }
})

test('base64 結果可還原成原 JSON；密碼去掉結尾換行；JKS 還原一致', () => {
  const s = setup()
  assert.equal(s.exec(baseArgs), 0)
  const by = Object.fromEntries(secretSets(s.calls).map(c => [c.args[2], c.input]))
  assert.deepEqual(JSON.parse(Buffer.from(by.ASN_PLAY_SA_JSON_B64, 'base64').toString()), SA)
  assert.equal(by.ASN_PLAY_UPLOAD_PASSWORD, PASS)
  assert.deepEqual(Buffer.from(by.ASN_PLAY_UPLOAD_JKS, 'base64'), JKS)
  assert.equal(Buffer.from(by.ASN_GOOGLE_SERVICES_JSON, 'base64').toString(), GS)
  assert.deepEqual(secretSets(s.calls).map(c => c.args[2]), SECRET_NAMES)
})

test('金鑰與密碼不出現在 gh 參數（只走 stdin）與任何輸出，錯誤訊息夾到值也被遮掉', () => {
  const s = setup(goodFiles(), { failOn: 'ASN_PLAY_UPLOAD_PASSWORD', leak: PASS })
  s.exec(baseArgs)
  const argText = s.calls.map(c => c.args.join(' ')).join('\n')
  const outText = s.out.join('\n')
  const b64 = Buffer.from(SA_TEXT).toString('base64')
  for (const secret of ['SECRETKEYBODY', PASS, b64, JKS.toString('base64'), Buffer.from(GS).toString('base64')]) {
    assert.ok(!argText.includes(secret), `參數含 ${secret.slice(0, 6)}`)
    assert.ok(!outText.includes(secret), `輸出含 ${secret.slice(0, 6)}`)
  }
  assert.ok(secretSets(s.calls).every(c => typeof c.input === 'string' && c.input.length > 0))
})

test('寫一半失敗：停下、列出已寫入與未寫入、結束碼非 0', () => {
  const s = setup(goodFiles(), { failOn: 'ASN_PLAY_UPLOAD_PASSWORD' })
  assert.equal(s.exec(baseArgs), 1)
  const t = s.out.join('\n')
  assert.match(t, /已寫入：ASN_PLAY_SA_JSON_B64、ASN_PLAY_UPLOAD_JKS\n/)
  assert.match(t, /未寫入：ASN_PLAY_UPLOAD_PASSWORD、ASN_GOOGLE_SERVICES_JSON/)
  assert.equal(secretSets(s.calls).length, 3)
})

test('environment 不存在：中止並提示 --setup-env，一個都沒寫', () => {
  const s = setup(goodFiles(), { envMissing: true })
  assert.equal(s.exec(baseArgs), 1)
  assert.equal(secretSets(s.calls).length, 0)
  assert.match(s.out.join('\n'), /--setup-env/)
})

test('--repo 其他值拒絕；預設與明講 Yooliang/asn 通過', () => {
  assert.match(parseArgs(['--repo', 'evil/asn']).error, /只接受/)
  const s = setup()
  assert.equal(s.exec([...baseArgs, '--repo', 'evil/asn']), 2)
  assert.equal(s.calls.length, 0)
  assert.ok(parseArgs(['--repo', 'Yooliang/asn']).opts)
})

test('--only 只檢查並寫指定的；其他檔不存在也不影響；不認得的名稱拒絕', () => {
  const f = goodFiles(); delete f[P.jks]
  const s = setup(f)
  assert.equal(s.exec([...baseArgs, '--only', 'ASN_PLAY_UPLOAD_PASSWORD,ASN_GOOGLE_SERVICES_JSON']), 0)
  assert.deepEqual(secretSets(s.calls).map(c => c.args[2]), ['ASN_PLAY_UPLOAD_PASSWORD', 'ASN_GOOGLE_SERVICES_JSON'])
  assert.equal(setup().exec([...baseArgs, '--only', 'ASN_NOPE']), 2)
})

test('--setup-env：先設 custom_branch_policies，再加 v* 標籤規則（type: tag），不碰 reviewers；ruleset 只讀', () => {
  const s = setup()
  assert.equal(s.exec(['--setup-env']), 0)
  const writes = s.calls.filter(c => c.args.includes('-X'))
  assert.equal(writes.length, 2)
  assert.deepEqual(JSON.parse(writes[0].input), { deployment_branch_policy: { protected_branches: false, custom_branch_policies: true } })
  assert.match(writes[0].args.join(' '), /PUT repos\/Yooliang\/asn\/environments\/release/)
  assert.deepEqual(JSON.parse(writes[1].input), { name: 'v*', type: 'tag' })
  assert.match(writes[1].args.join(' '), /POST .*deployment-branch-policies/)
  assert.ok(!writes.some(w => /reviewers/.test(w.input)))
  assert.ok(s.calls.filter(c => /rulesets/.test(c.args.join(' '))).every(c => !c.args.includes('-X')))
  assert.equal(secretSets(s.calls).length, 0)
})

test('--setup-env：v* 規則已存在就不重加；ruleset 沒設警告並結束碼非 0', () => {
  const a = setup(goodFiles(), { hasTagPolicy: true })
  assert.equal(a.exec(['--setup-env']), 0)
  assert.equal(a.calls.filter(c => c.args.includes('POST')).length, 0)
  const b = setup(goodFiles(), { noRuleset: true })
  assert.equal(b.exec(['--setup-env']), 1)
  assert.match(b.out.join('\n'), /ruleset/)
})

const EXISTING_ENV = {
  name: 'release',
  can_admins_bypass: false,
  protection_rules: [
    { id: 1, type: 'wait_timer', wait_timer: 30 },
    { id: 2, type: 'required_reviewers', prevent_self_review: true, reviewers: [{ type: 'User', reviewer: { id: 4242, login: 'x' } }, { type: 'Team', reviewer: { id: 77, slug: 't' } }] },
  ],
  deployment_branch_policy: null,
}

test('#1925 --setup-env：environment 已存在就先讀、把原本的等待時間與審核者原樣帶回，不被 PUT 重置', () => {
  const s = setup(goodFiles(), { existingEnv: EXISTING_ENV })
  assert.equal(s.exec(['--setup-env']), 0)
  const put = s.calls.find(c => c.args.includes('PUT'))
  assert.deepEqual(JSON.parse(put.input), {
    deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
    can_admins_bypass: false,
    wait_timer: 30,
    reviewers: [{ type: 'User', id: 4242 }, { type: 'Team', id: 77 }],
    prevent_self_review: true,
  })
  const iGet = s.calls.findIndex(c => c.args.join(' ') === 'api repos/Yooliang/asn/environments/release')
  assert.ok(iGet >= 0 && iGet < s.calls.indexOf(put), '先 GET 再 PUT')
  assert.match(s.out.join('\n'), /原樣保留/)
})

test('#1925 --setup-env：environment 還不存在就只帶部署規則（不新增 reviewers）', () => {
  const s = setup(goodFiles(), { envMissing: true })
  assert.equal(s.exec(['--setup-env']), 0)
  assert.deepEqual(JSON.parse(s.calls.find(c => c.args.includes('PUT')).input), { deployment_branch_policy: { protected_branches: false, custom_branch_policies: true } })
})

test('#1925 --setup-env 和 --only／輸入檔旗標一起給：報用法錯，不默默忽略', () => {
  assert.equal(setup().exec(['--setup-env', '--only', 'ASN_PLAY_UPLOAD_JKS']), 2)
  assert.equal(setup().exec(['--setup-env', '--upload-jks', '/k/upload.jks']), 2)
})

test('#1925 二審：讀 environment 現況回 500（不是 404）就中止，不 PUT、不加規則、結束碼 1', () => {
  const s = setup(goodFiles(), { envError: true })
  assert.equal(s.exec(['--setup-env']), 1)
  assert.equal(s.calls.filter(c => c.args.includes('-X')).length, 0)
  assert.match(s.out.join('\n'), /中止/)
})
