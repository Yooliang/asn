// #2163 PR-3b：發版 CI 的「正式安裝包不帶 test-hooks」證明（第三、第四道），一個入口跑完：
//   3. 標記掃描：正式 exe 掃不到標記、hooks 版 exe 掃得到（hooks-marker-scan.mjs）
//   4. 行為探針：正式 exe 設 ASN_SHOT_LOGIN 收不到 node_claim、hooks 版收得到（hooks-probe.mjs，要開視窗，只在 CI 跑）
// 第一道（原始碼守門）在 cargo test；第二道（build.rs 的 ASN_SHIPPING_BUILD 鎖）在編譯期。
// 用法：node scripts/hooks-proof.mjs [--release <正式 exe>] [--hooks <hooks 版 exe>]（預設 target/release 與 target/e2e）
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { hooksExePath, releaseExePath } from './build-hooks-exe.mjs'
import { main as scan } from './hooks-marker-scan.mjs'
import { main as probe } from './hooks-probe.mjs'

/** 解析：回 { release, hooks } 或 { error } */
export function parseArgs(argv, release = releaseExePath(), hooks = hooksExePath()) {
  const o = { release, hooks }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--release' || argv[i] === '--hooks') {
      const v = argv[i + 1]
      if (!v) return { error: `${argv[i]} 後面要接檔案` }
      o[argv[i].slice(2)] = v
      i++
    } else return { error: `不認得的參數：${argv[i]}` }
  }
  return o
}

export async function main(argv = process.argv.slice(2)) {
  const p = parseArgs(argv)
  if (p.error) { console.error(`證明：${p.error}`); return 2 }
  console.log('== 第三道：標記字串掃描 ==')
  const a = scan(['--absent', p.release, '--present', p.hooks])
  console.log('== 第四道：行為探針 ==')
  const b = await probe(['--release', p.release, '--hooks', p.hooks])
  return a === 0 && b === 0 ? 0 : 1
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(await main())
