// #1808 第 8 組守門：電腦版沒帶本人簽章，開夥伴／看設定回 403（復發單號：#373 #380 #381 #1753）
//
// 一直被弄壞的那條規則：後台對「替自己別台設備操作」的動作，成員角色的電腦要靠本人簽章（X-ASN-User）證明身分；
// 手機一直有帶，電腦版每次只補壞掉的那一個呼叫——#380 補了 relay_launchers，同一檔的 relay_launch 漏掉，19 天後 #1753 又 403。
// 這支測試不靠人記：從後台真的原始碼（supabase/functions）讀出「需要本人簽章的動作」清單，
// 再掃 Rust 全部呼叫點，任何一個用沒簽章的 `.api("動作"` 打這些動作就紅。新動作加進後台清單、前端漏帶，下次也會被擋下。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const repo = path.join(root, '..', '..')
const read = f => fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n')
const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]))
const rsFiles = walk(path.join(root, 'src-tauri/src')).filter(f => f.endsWith('.rs'))
const rel = f => path.relative(path.join(root, 'src-tauri/src'), f).replace(/\\/g, '/')

/** 後台真的清單：relay/index.ts 裡「? await signedUserId(」那幾行的 action 條件，加上各 *_SIGNED_ACTIONS 集合 */
function backendSignedActions() {
  const out = new Set()
  const idx = read(path.join(repo, 'supabase/functions/relay/index.ts'))
  for (const line of idx.split('\n')) {
    if (!/\?\s*await signedUserId\(/.test(line)) continue
    for (const m of line.matchAll(/action === "([a-z_]+)"/g)) out.add(m[1])
  }
  const shared = path.join(repo, 'supabase/functions/_shared')
  for (const f of fs.readdirSync(shared).filter(n => n.endsWith('.ts') && !n.endsWith('_test.ts'))) {
    for (const m of read(path.join(shared, f)).matchAll(/_SIGNED_ACTIONS\s*=\s*new Set(?:<string>)?\(\[([^\]]*)\]/g)) {
      for (const a of m[1].matchAll(/"([a-z_]+)"/g)) out.add(a[1])
    }
  }
  // attach_init 的簽章是選填（給自己的夥伴用 CLI 上傳時沒有人登入），不在這條規則裡
  out.delete('attach_init')
  return out
}

test('#1753 後台要本人簽章的動作清單讀得到，而且包含 launch／launchers（#380／#1753 壞過的那兩個）', () => {
  const s = backendSignedActions()
  for (const a of ['launch', 'launchers', 'acct_list', 'acct_switch', 'term_req_decide', 'perm_req_decide']) assert.ok(s.has(a), `後台清單裡有 ${a}`)
  assert.ok(s.size >= 10, `讀到 ${s.size} 個`)
})

// 刻意不帶簽章的（有另一條帶簽章的版本與測試）：secret_request 沒有登入網址時走 Backend::request，有登入網址才走 request_signed（secret_remote/tests.rs 鎖住）
const ALLOWED_UNSIGNED = new Set(['secret_remote/wire.rs:secret_request', 'view_d.rs:term_view_start', 'view_d.rs:term_view_report'])   // view_d 走 ViewBackend::api(action, body, token)：token 是必填參數（下面另一支測試鎖住）

test('#373 #380 #381 #1753 電腦版沒有任何地方用「沒簽章」的呼叫打後台要簽章的動作', () => {
  const signed = backendSignedActions()
  const bad = []
  for (const f of rsFiles) {
    const src = read(f)
    const prod = src.includes('#[cfg(test)]') ? src.slice(0, src.indexOf('#[cfg(test)]')) : src
    for (const m of prod.matchAll(/\.api(?:_with)?\(\s*"([a-z_]+)"([^\n]*)/g)) {
      // 呼叫裡有交 token 的（view_d 的 ViewBackend::api(action, body, token)）就是帶簽章的版本
      if (!signed.has(m[1]) || /token/.test(m[2]) || ALLOWED_UNSIGNED.has(`${rel(f)}:${m[1]}`)) continue
      bad.push(`${rel(f)}：.api("${m[1]}"…) 沒帶簽章`)
    }
  }
  assert.deepEqual(bad, [], '這些呼叫成員角色的電腦會被後台回 403 forbidden（要改用 api_signed 並帶 signing_token）')
})

test('#380 #1753 開新夥伴與各電腦啟動設定都走 api_signed，而且 lib.rs 的命令真的把簽章交進去', () => {
  const launch = read(path.join(root, 'src-tauri/src/launch/mod.rs'))
  assert.match(launch, /relay\.api_signed\("launch", Some\(body\), token\)/)
  assert.match(launch, /relay\.api_signed\("launchers", body, token\)/)
  const lib = read(path.join(root, 'src-tauri/src/lib.rs'))
  // 電腦版的 Tauri 命令：從 signing_token 拿簽章，交給 launch::relay_launch／relay_launchers
  const cmd = name => (lib.split(`async fn ${name}(`)[1] ?? '').split('\n}\n')[0]
  for (const name of ['relay_launch', 'relay_launchers']) {
    const body = cmd(name)
    assert.ok(body.length > 50, `找得到命令 ${name}`)
    assert.match(body, /account::signing_token\(&auth\)\.await/, `${name} 要先取本人簽章`)
    assert.match(body, new RegExp(`launch::${name}\\(.*token\\.as_deref\\(\\)`), `${name} 要把簽章交給 launch::${name}`)
  }
  // 手機那條（一直都有帶）
  const android = read(path.join(root, 'src-tauri/src/android.rs'))
  assert.match(android, /r\.launch_signed\(&body, token\.as_deref\(\)\)/)
})

test('#1753 view_d 的後台介面把 token 設成必填參數；api_inner 只在 token 非空時才帶 x-asn-user 標頭', () => {
  assert.ok(read(path.join(root, 'src-tauri/src/view_d.rs')).includes('fn api(&self, action: &str, body: Value, token: &str)'))
  const relay = read(path.join(root, 'src-tauri/src/relay.rs'))
  assert.ok(relay.includes('pub const SIGN_HEADER: &str = "x-asn-user";'))
  assert.ok(relay.includes('user_token.filter(|t| !t.is_empty())') && relay.includes('req.header(SIGN_HEADER, format!("Bearer {t}"))'), '空憑證不帶標頭、有憑證帶 Bearer')
})
