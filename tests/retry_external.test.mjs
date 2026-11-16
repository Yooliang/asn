// CI 外部下載重試（.github/scripts/retry-external.sh）的判斷：哪些失敗算「外部服務的錯誤」要退避重試，哪些立刻照原本的結束碼失敗。
// main c259abe0 的 android-kotlin 因為 Gradle 抓 repo.maven.apache.org 回 429 卻被判成「不是外部服務的錯誤，不重試」而紅；
// 429（太多請求、被限流）跟 5xx、逾時一樣是對方的問題。這裡直接讀腳本裡的 pattern，用 bash＋grep -Ei 跟 CI 一模一樣地比對真實 log 的寫法。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const SCRIPT = new URL('../.github/scripts/retry-external.sh', import.meta.url)
const scriptPath = path.resolve(decodeURIComponent(SCRIPT.pathname.replace(/^\/([A-Za-z]:)/, '$1')))
const src = fs.readFileSync(SCRIPT, 'utf8')
const pattern = src.match(/^pattern='([^']+)'$/m)?.[1]

const hasBash = spawnSync('bash', ['-c', 'echo ok'], { encoding: 'utf8' }).stdout?.trim() === 'ok'
// 跟腳本裡一樣用 grep -Eiq 比對（回 true＝算外部錯誤、會重試）
const external = line => spawnSync('bash', ['-c', 'printf "%s\\n" "$1" | grep -Eiq "$2"', '_', line, pattern]).status === 0

const RETRY = [
  // Gradle（這次紅的那一種）
  "> Could not GET 'https://repo.maven.apache.org/maven2/org/jetbrains/kotlin/kotlin-stdlib/2.0.21/kotlin-stdlib-2.0.21.pom'. Received status code 429 from server: Too Many Requests",
  "> Could not GET 'https://dl.google.com/dl/android/maven2/com/android/tools/build/gradle/8.5.2/gradle-8.5.2.pom'. Received status code 502 from server: Bad Gateway",
  "> Could not GET 'https://repo.maven.apache.org/maven2/a/b/1/b-1.pom'. > Read timed out",
  "> Could not HEAD 'https://repo.maven.apache.org/maven2/a/b/1/b-1.jar'. > Connect timed out",
  // curl
  'curl: (22) The requested URL returned error: 429',
  'curl: (22) The requested URL returned error: 503',
  'HTTP/2 429',
  'HTTP/1.1 504 Gateway Time-out',
  'curl: (28) Operation timed out after 30001 milliseconds with 0 bytes received',
  // reqwest／tauri bundler
  'error sending request for url (https://github.com/x/y/releases/download/v1/z.zip): operation timed out',
  'response code: 429',
  'status: 429',
  'status code 503',
  // 產品自己的取得流程
  '伺服器回 429',
  '伺服器回 503',
  '連不上或逾時',
]
const NO_RETRY = [
  "> Could not GET 'https://repo.maven.apache.org/maven2/a/b/1/b-1.pom'. Received status code 404 from server: Not Found",
  'curl: (22) The requested URL returned error: 404',
  'HTTP/1.1 403 Forbidden',
  'status code 401',
  'response code: 400',
  'error[E0425]: cannot find value `x` in this scope',
  'e: file:///home/runner/work/asn/relay/asn/src-tauri/gen/android/app/src/main/java/Foo.kt:12:5 Unresolved reference: bar',
  'FAILURE: Build failed with an exception.',
  'Tests: 4290 passed, 1 failed',
  'expected 429 rows but got 430',
  // 單獨一句 Too Many Requests（沒有狀態碼）不算：cargo、Gradle 的單元測試也包在這支裡，有些測試拿它當輸入，真的失敗時不該被多跑兩輪、再寫成外部服務
  'Too Many Requests',
  'assertion failed: body == "429 Too Many Requests"',
]

test('腳本裡讀得到判斷用的 pattern（改了寫法這個測試要跟著改，不能默默通過）；只認帶狀態碼的 429，沒有單獨的 Too Many Requests', () => {
  assert.ok(pattern, '找不到 pattern=\'…\' 那一行')
  assert.match(pattern, /429/)
  assert.ok(!pattern.split('|').includes('Too Many Requests'), '單獨的 Too Many Requests 範圍太寬（測試輸入也會中）')
})

test('429、5xx、逾時、連線中斷：算外部服務錯誤，要退避重試', { skip: !hasBash && '這台沒有 bash' }, () => {
  for (const line of RETRY) assert.equal(external(line), true, line)
})

test('其他 4xx、編譯錯誤、剛好含 429 的數字：不是外部錯誤，立刻失敗、不重試', { skip: !hasBash && '這台沒有 bash' }, () => {
  for (const line of NO_RETRY) assert.equal(external(line), false, line)
})

test('實際跑腳本：不是外部錯誤就照原本的結束碼立刻失敗，不重試', { skip: !hasBash && '這台沒有 bash' }, () => {
  const r = spawnSync('bash', [scriptPath, '測試', '--', 'bash', '-c', 'echo "error[E0425]: cannot find value"; exit 3'], { encoding: 'utf8' })
  assert.equal(r.status, 3)
  assert.match(r.stderr, /不是外部服務的錯誤，不重試/)
})

test('實際跑腳本：第一次 Gradle 回 429、第二次成功 → 退避後重試並通過', { skip: !hasBash && '這台沒有 bash', timeout: 60_000 }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asn-retry-'))
  const flag = path.join(dir, 'tried').replace(/\\/g, '/')
  const cmd = `if [ -e "${flag}" ]; then echo ok; exit 0; fi; touch "${flag}"; echo "Received status code 429 from server: Too Many Requests"; exit 1`
  const r = spawnSync('bash', [scriptPath, '測試', '--', 'bash', '-c', cmd], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stderr, /第 1 次碰到外部服務錯誤（429／5xx／逾時／連線中斷），15 秒後重試/)
})
