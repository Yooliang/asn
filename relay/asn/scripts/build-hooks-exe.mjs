// #2163 PR-3b：建 e2e 專用的 test-hooks 版 exe（只給需要 ASN_SHOT_* 變數的 e2e 用，絕不發出去）。
// 做法：在 `tauri build` 之前用同一組 release 設定多建一份帶 test-hooks 的 asn，複製到 src-tauri/target/e2e/asn(.exe)。
// 之後 `tauri build` 會重編 asn 並覆蓋 target/release/asn(.exe)（正式版）；兩份只差 test-hooks，第三方依賴共用不重編。
// 要先跑過 prep（ui 與資源就緒）；Windows 要先取好 WezTerm（release-ci.mjs 裡的順序已經是這樣）。
// 用法：node scripts/build-hooks-exe.mjs
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { checkMarker } from './hooks-marker-scan.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const exeName = process.platform === 'win32' ? 'asn.exe' : 'asn'
/** hooks 版 exe 的存放處（與正式版的 target/release 分開） */
export const hooksExePath = (root = path.join(here, '..')) => path.join(root, 'src-tauri', 'target', 'e2e', exeName)
export const releaseExePath = (root = path.join(here, '..')) => path.join(root, 'src-tauri', 'target', 'release', exeName)

/**
 * cargo 參數：與 `tauri build` 同一組 release 設定，另加 test-hooks。
 * tauri/custom-protocol 是 tauri CLI 在 release 建置時自己加的，這裡照加，兩份的依賴特徵才一樣、才能共用編譯結果
 */
export const hooksBuildArgs = () => ['build', '--release', '--locked', '--manifest-path', path.join('src-tauri', 'Cargo.toml'), '--bin', 'asn', '--features', 'test-hooks,tauri/custom-protocol']

/** 建 hooks 版時絕不能帶 ASN_SHIPPING_BUILD（build.rs 看到它加 test-hooks 會直接 panic） */
export const hooksBuildEnv = env => {
  const e = { ...env }
  delete e.ASN_SHIPPING_BUILD
  return e
}

export function main(env = process.env) {
  const root = path.join(here, '..')
  const fail = m => { console.error(`建 hooks 版中止：${m}`); process.exit(1) }
  const r = spawnSync('cargo', hooksBuildArgs(), { cwd: root, stdio: 'inherit', env: hooksBuildEnv(env) })
  if (r.status !== 0) fail(`cargo build 失敗（結束碼 ${r.status}）`)
  const built = releaseExePath(root)
  const dest = hooksExePath(root)
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.copyFileSync(built, dest)
  // 建完立刻確認這一份真的有標記，沒有的話後面所有的 e2e 與證明都是假的
  const m = checkMarker(dest, 'present')
  if (!m.ok) fail(m.message)
  console.log(`hooks 版已就緒：${dest}`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
