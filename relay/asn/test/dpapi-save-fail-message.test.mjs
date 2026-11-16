// 登入時保存失敗（#1603）：畫面上是一句看得懂、能照著做的話；錯誤碼只進 ui.log
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8').replace(/\r\n/g, '\n')
const auth = read('src-tauri', 'src', 'auth.rs')
const fn = name => auth.split(`pub(crate) fn ${name}(`)[1].split('\n}\n')[0]

const TEXT = '這台電腦的 Windows 沒辦法保存登入資料。請用平常的方式登入 Windows 再開 ASN（不要用系統管理員或排程啟動）；如果最近被重設過 Windows 密碼，請先用舊密碼登入一次'

test('畫面文字常數是指定的那一句，不含 DPAPI 與錯誤碼', () => {
  assert.ok(auth.includes(`pub(crate) const SAVE_FAIL_TEXT: &str = "${TEXT}";`))
  assert.ok(!/DPAPI|0x/.test(TEXT))
})

test('加密失敗：取 GetLastError、寫 ui.log、回給畫面的是常數', () => {
  const body = fn('dpapi_protect')
  assert.match(body, /GetLastError/)
  assert.match(body, /dpapi_log\("加密", unsafe \{ GetLastError\(\) \}\)/)
  assert.match(body, /Err\(SAVE_FAIL_TEXT\.into\(\)\)/)
  assert.ok(!body.includes('Windows 加密失敗"'), '舊的短訊息不能再回給畫面')
})

test('解密失敗：取 GetLastError 並寫 ui.log（不上畫面，字不變）', () => {
  const body = fn('dpapi_unprotect')
  assert.match(body, /dpapi_log\("解密", unsafe \{ GetLastError\(\) \}\)/)
  assert.ok(body.includes('Windows 解密失敗（可能不是這個使用者存的）'))
})

test('dpapi_log 寫進 ui.log（不是只有 stderr），錯誤碼格式由純函式產生', () => {
  const log = auth.split('fn dpapi_log(')[1].split('\n}\n')[0]
  assert.match(log, /crate::ui_log::append\(dir/)
  assert.match(log, /dpapi_err_line\(op, code\)/)
  assert.match(auth, /format!\("Windows \{op\}失敗 0x\{code:08X\}"\)/)
})

test('啟動時把 ui.log 資料夾交給 auth（拿不到 app handle 的那條路）', () => {
  assert.match(read('src-tauri', 'src', 'lib.rs'), /auth::set_dpapi_log_dir\(&exit_log_dir\)/)
})

test('登入頁原樣顯示錯誤字串：不加前綴、不截斷', async () => {
  const { errorText } = await import('../ui/lib/login.mjs')
  assert.equal(errorText(TEXT), TEXT)
  assert.equal(errorText(new Error(TEXT)), TEXT)
})
