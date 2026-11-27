// agy 自己各段對話的資料夾（#2351；Rust 端 acp_policy.rs 的 inside_agy_conv_dir 同一套規則）。
// 寫入政策（acp-policy.mjs）與讀取判定（acp-sensitive.mjs）共用，所以放在獨立的小模組，兩邊才不會互相引用。
// agy 把分析檔寫在 <家>/.gemini/antigravity-cli/brain/<對話編號>/ 底下；換班或重開後的新一段也要能改舊段寫的文件。
// 放行：brain/<合法編號>/<檔>（含 scratch）。不放行：直接寫在 brain 底下、對話資料夾本身、任一段的 .system_generated/、brain 以外（含 oauth_creds.json）
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const norm = p => (process.platform === 'win32' ? p.toLowerCase() : p)

export const validConvId = s => typeof s === 'string' && s.length > 0 && s.length <= 100 && /^[A-Za-z0-9_-]+$/.test(s)

export function agyBrainDir(env = process.env) {
  const home = [env?.USERPROFILE, env?.HOME].find(v => typeof v === 'string' && v.trim()) ?? os.homedir()
  return path.join(home, '.gemini', 'antigravity-cli', 'brain')
}

// 解成實際位置：最深一層存在的上層用 realpath 解開捷徑與 junction，還不存在的部分接在後面
function realPathOf(base, p) {
  let cur = path.resolve(base, String(p))
  const rest = []
  for (;;) {
    try { return path.join(fs.realpathSync.native(cur), ...rest.reverse()) } catch { /* 往上一層 */ }
    const up = path.dirname(cur)
    if (up === cur) return null
    rest.push(path.basename(cur))
    cur = up
  }
}

export function insideAgyConvDir(paths, brain, base) {
  let realBrain
  try { realBrain = fs.realpathSync.native(brain) } catch { return false }
  if (!paths.length) return false
  return paths.every(p => {
    const real = realPathOf(base, p)
    if (!real) return false
    const rel = path.relative(norm(realBrain), norm(real))
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return false
    const [id, first] = rel.split(path.sep)
    // Windows 會吃掉名字尾巴的點與空白（`.system_generated.` 開到同一個資料夾），先去掉再比
    const f = (first ?? '').replace(/[. ]+$/, '').toLowerCase()
    return validConvId(id) && f !== '' && f !== '.system_generated'
  })
}
