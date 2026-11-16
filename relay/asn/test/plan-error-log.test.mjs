// 帳號方案變動與非登入類錯誤代碼寫進記錄（方便排查）：靜態守門，鎖住登入類清單不變、記錄只寫固定句型
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const read = f => fs.readFileSync(new URL(`../src-tauri/src/${f}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const prod = f => read(f).split('#[cfg(test)]')[0]

test('登入類錯誤清單不變，其餘錯誤只記代碼', () => {
  const s = prod('login_watch.rs')
  assert.ok(s.includes('pub const LOGIN_ERRORS: [&str; 2] = ["authentication_failed", "oauth_org_not_allowed"];'))
  assert.ok(s.includes('format!("Claude 回報錯誤代碼 {key}（累計 {n} 次）")'))
  assert.ok(s.includes('c.is_ascii_alphanumeric() || c == \'_\''), '代碼只允許英數與底線')
})

test('方案記錄只用既有分支結果，不新增讀取、不上報', () => {
  const s = prod('claude_accounts.rs')
  assert.equal(s.split('read_to_string(cred_file)').length - 1, 1, 'info_of 內讀權杖檔仍只有一處')
  assert.ok(s.includes('#[serde(skip)]\n    pub plan_from'))
  const lib = read('lib.rs')
  assert.ok(lib.includes('.observe(&cur.plan, cur.plan_from)'))
  assert.ok(/#\[cfg\(desktop\)\]\n\s*login_watch::set_log_dir\(&work_dir\);/.test(lib))
})
