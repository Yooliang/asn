// 敏感位置裡明確放行的資料夾，和工作者建立時算清單的正式做法（與 Rust 端 acp_sensitive/exempt.rs 對應）。
// 放行只開在這幾處（每個形式——字面與實際位置——都要各自落在裡面，經捷徑跳出去的照擋）：
// - 這位工作者自己的資料夾（`<ASN 資料夾>/workers/<自己的名字>` 或 `<機器工作資料夾>/workers/<自己的名字>`，名字要過名字驗證）：
//   工作資料夾、白名單資料夾各自要落在它本身或底下；實際位置也要在同一個預期位置，不能經捷徑落到別處；
//   它本身是敏感根、或底下含別的敏感根時不放行
// - 收信附件的下載資料夾（可以整個關掉，見 ATTACHMENTS_READABLE）
// - agy 的內建說明檔（`.gemini/antigravity-cli/builtin/skills`）
// Node 版的工作資料夾結構與 Rust 版相同：機器工作資料夾是 `<ASN 資料夾>/machine-<ID>`，工作者預設在它底下的 `workers/<名字>`。
import path from 'node:path'
import { agyBrainDir } from './acp-brain.mjs'
import { DATA } from './acp-sensitive-data.mjs'
import { nstr } from './acp-sensitive-path.mjs'
import { asnHomeOverride, buildRoots, envPairs, homesFrom, pushForms, sealRoots } from './acp-sensitive-roots.mjs'

/** 收信附件的下載資料夾（工作資料夾底下的 attachments）要不要開放給背景夥伴讀。領隊還沒裁決，預設開放；要關掉改成 false */
export const ATTACHMENTS_READABLE = true

// 工作者名字：字母、數字、中文開頭，後面可加連字號，最長 40 字（與 acp-config.mjs 的名字檢查同一條規則）
export const validName = s => typeof s === 'string' && Array.from(s).length <= 40 && /^[A-Za-z0-9一-鿿][A-Za-z0-9一-鿿-]*$/.test(s)

const SECRET_WORDS = ['KEY', 'TOKEN', 'SECRET', 'PASSWORD', 'CREDENTIAL']

/** 算明確放行的資料夾（字面與實際位置兩種形式各自判斷）。回傳新的清單物件，不改原本的 */
export function withWorkdirs(roots, name, ownDirs, workDir, attachments) {
  const canon = roots.canon
  const asn = []
  for (const h of roots.homePaths) for (const n of DATA.asnDirNames) pushForms(asn, path.join(h, n), canon)
  for (const k of ['ASN_HOME', 'IRORI_HOME']) {
    const hit = roots.env.find(([a, b]) => a.toUpperCase() === k && b.trim() !== '')
    if (hit) pushForms(asn, hit[1].trim(), canon)
  }
  const asnHome = asnHomeOverride(roots.env)
  if (asnHome !== null) pushForms(asn, asnHome, canon) // 跟 home.mjs 同一套解析：相對值也算進來
  // 容器的位置一律由「上層的各形式＋固定的下一層」組出來，不去解開容器自己：容器自己若是捷徑，它的實際位置就不在預期位置，不放行。
  // 自己的容器有兩個位置（名字要先過名字驗證）：ASN 資料夾底下的 workers/<名字>、機器工作資料夾底下的 workers/<名字>
  const workForms = workDir ? pushForms([], workDir, canon) : []
  let own = []
  if (validName(name)) {
    const n = nstr(name)
    for (const base of [...asn, ...workForms]) {
      const c = `${base}/workers/${n}`
      if (!own.includes(c)) own.push(c)
    }
  }
  const strictlyInAsn = c => asn.some(a => c.startsWith(`${a}/`))
  own = own.filter(strictlyInAsn)
  const att = workForms.map(w => `${w}/attachments`).filter(strictlyInAsn)
  const dirs = []
  // 每個形式（字面、實際位置）各自要落在指定的容器資料夾裡（容器本身算不算由 orEqual 決定）、而且底下不含別的敏感根才算；捷徑指到別處的那一種形式不收
  const add = (dir, containers, orEqual) => {
    for (const f of pushForms([], dir, canon)) {
      const inside = containers.some(c => f.startsWith(`${c}/`) || (orEqual && f === c))
      const holdsARoot = roots.roots.some(r => r === f || r.startsWith(`${f}/`))
      if (inside && !holdsARoot && !dirs.includes(f)) dirs.push(f)
    }
  }
  // 工作資料夾與所有白名單資料夾：同一條規則
  for (const d of ownDirs) add(d, own, true)
  if (attachments && workDir) add(path.join(workDir, 'attachments'), att, true)
  for (const h of roots.homePaths) {
    const brain = agyBrainDir({ USERPROFILE: h })
    const cont = pushForms([], path.dirname(path.dirname(brain)), canon)
    add(path.join(path.dirname(brain), 'builtin', 'skills'), cont, false)
  }
  return sealRoots({ ...roots, exemptDirs: dirs })
}

/** 這個（已正規化的）位置在不在明確放行的資料夾裡 */
export const isExempt = (roots, f) => roots.exemptDirs.some(d => f === d || f.startsWith(`${d}/`))

/**
 * 工作者建立時算敏感清單的唯一做法（createWorker 呼叫，測試也走這裡）：
 * 家目錄＝環境裡的 USERPROFILE、HOME 加上 realHome（正式是這台電腦實際的使用者資料夾，測試傳假的）；
 * 環境變數只帶名字不像金鑰的（展開變數與環境變數指定的位置用）；
 * name、ownDirs（工作資料夾、白名單資料夾）、workDir 用來算明確放行的資料夾
 */
export function rootsForWorker(env, realHome, name, ownDirs, workDir, { canon, attachments = ATTACHMENTS_READABLE } = {}) {
  const pairs = envPairs(env)
  const safe = pairs.filter(([k]) => !SECRET_WORDS.some(w => k.toUpperCase().includes(w)))
  return withWorkdirs(buildRoots(homesFrom(pairs, realHome), safe, canon), name, ownDirs, workDir, attachments)
}
