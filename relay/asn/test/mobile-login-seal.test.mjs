import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { LOGIN_UNSEALED_TEXT, loginUnsealedNote } from '../ui/lib/mobile-login-seal.mjs'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8').replace(/\r\n/g, '\n')

test('登入資料沒加密：只有回 false 才顯示固定的一句話', async () => {
  assert.equal(LOGIN_UNSEALED_TEXT, '登入資料暫時沒有加密保存，下次開啟會再試')
  const calls = []
  const mk = v => async (cmd, args) => { calls.push([cmd, args]); if (v instanceof Error) throw v; return v }
  assert.equal(await loginUnsealedNote(mk(false)), LOGIN_UNSEALED_TEXT)
  assert.deepEqual(calls[0], ['android_login_sealed', undefined])
  assert.equal(await loginUnsealedNote(mk(true)), '')
  assert.equal(await loginUnsealedNote(mk(undefined)), '')
  assert.equal(await loginUnsealedNote(mk(null)), '')
  assert.equal(await loginUnsealedNote(mk(new Error('not found'))), '', '電腦版沒有這個命令：不顯示')
})

test('設定頁：提醒只用文字節點顯示，只在有字時出現；命令只登記在手機清單', () => {
  const html = read('ui', 'm.html')
  assert.match(html, /<p class="m-fine" v-if="sealNote">\{\{ sealNote \}\}<\/p>/)
  assert.doesNotMatch(html, /v-html="sealNote"/)
  const js = read('ui', 'm.js')
  assert.match(js, /loginUnsealedNote\(invoke\)/)
  const lib = read('src-tauri', 'src', 'lib.rs')
  const at = lib.indexOf('#[cfg(not(desktop))]\n    let builder = builder.invoke_handler(')
  assert.ok(at > 0)
  const phone = lib.slice(at)
  const desk = lib.slice(lib.indexOf('generate_handler!['), at)
  assert.ok(phone.includes('android::android_login_sealed'), '手機清單有')
  assert.ok(!desk.includes('android_login_sealed'), '電腦版沒有')
  const rs = read('src-tauri', 'src', 'android.rs')
  assert.match(rs, /pub fn android_login_sealed\(app: State<'_, App>\) -> bool/)
})
