// 讀取判定用的路徑字串處理（純字串，不碰檔案系統，除了 realPathWith）。與 Rust 端 acp_sensitive.rs 的①展開、③Windows 路徑形式一一對應。
import path from 'node:path'
import { IS_WIN } from './acp-sensitive-data.mjs'

const isAlpha = c => typeof c === 'string' && /^[A-Za-z]$/.test(c)

/** 比對用的字串：反斜線換成斜線、去掉 `\\?\` 與 `\\.\` 前綴與尾端斜線，Windows 轉小寫 */
export function nstr(s) {
  let t = s.replaceAll('\\', '/')
  for (const p of ['//?/', '//./']) {
    if (t.startsWith(p)) { t = t.slice(p.length); break }
  }
  t = t.replace(/\/+$/, '')
  return IS_WIN ? t.toLowerCase() : t
}

/** 最深一層存在的上層用 realpath 解開捷徑，還不存在的尾段接回去；一層都解不開回 null */
export function realPathWith(canon, abs) {
  let cur = abs
  const rest = []
  for (;;) {
    try {
      const c = canon(cur)
      return rest.length ? path.join(c, ...[...rest].reverse()) : c
    } catch { /* 往上一層 */ }
    const base = path.basename(cur)
    const up = path.dirname(cur)
    if (!base || base === '..' || up === cur) return null
    rest.push(base)
    cur = up
  }
}

// ---- 折疊（不碰檔案系統：補成絕對路徑、去掉 . 與 ..）----

// 開頭的「磁碟機／網路路徑／根」與其餘。字串裡的分隔符已經統一成 /（Windows）
function parseRoot(t) {
  if (IS_WIN) {
    const d = /^([A-Za-z]:)/.exec(t)
    if (d) {
      const after = t.slice(2)
      return after.startsWith('/') ? [`${d[1]}/`, after.replace(/^\/+/, '')] : [d[1], after]
    }
    const u = /^\/\/([^/]+)\/([^/]+)(\/|$)/.exec(t)
    if (u) return [`//${u[1]}/${u[2]}/`, t.slice(u[0].length)]
  }
  return t.startsWith('/') ? ['/', t.replace(/^\/+/, '')] : ['', t]
}

/** 這個字串算不算「自己就是絕對路徑」（Rust：is_absolute 或以 / 或 \ 開頭） */
export function absLike(p) {
  if (p.startsWith('/') || p.startsWith('\\')) return true
  return IS_WIN ? /^[A-Za-z]:[\\/]/.test(p) : false
}

export function joinBase(base, p) {
  return absLike(p) ? p : `${base}${/[\\/]$/.test(base) || base === '' ? '' : '/'}${p}`
}

/** 這條（接上基準資料夾的）路徑有沒有 `..` 這一段（折疊之前看） */
export function hasDotDot(joined) {
  return (IS_WIN ? joined.replaceAll('\\', '/') : joined).split('/').includes('..')
}

/** 不碰檔案系統的折疊（對應 Rust 的 resolve）：以 base 補成絕對路徑，去掉 `.` 與 `..`，回傳用 / 當分隔的字串 */
export function foldPath(base, p) {
  const joined = joinBase(base, p)
  const t = IS_WIN ? joined.replaceAll('\\', '/') : joined
  const [root, rest] = parseRoot(t)
  const out = []
  for (const seg of rest.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      if (out.length) out.pop()
      else out.push('..')
      continue
    }
    out.push(seg)
  }
  return root + out.join('/')
}

// ---- ① 展開 ----

function percentDecode(s) {
  const b = Buffer.from(s, 'utf8')
  const out = []
  const hex = c => (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x46) || (c >= 0x61 && c <= 0x66)
  for (let i = 0; i < b.length;) {
    if (b[i] === 0x25 && i + 2 < b.length && hex(b[i + 1]) && hex(b[i + 2])) {
      out.push(parseInt(b.toString('latin1', i + 1, i + 3), 16))
      i += 3
    } else {
      out.push(b[i])
      i += 1
    }
  }
  return Buffer.from(out).toString('utf8')
}

/** `file:` 網址：解開 `%XX`、剝掉前綴與 `localhost`、補掉 `/C:` 前面的斜線；有別的主機名就當網路路徑 `//主機/…`。不是 file 網址就原樣回傳 */
export function stripFileUrl(s) {
  if (s.slice(0, 5).toLowerCase() !== 'file:') return s
  let rest = percentDecode(s.slice(5))
  if (rest.startsWith('//')) {
    const after = rest.slice(2)
    const k = after.indexOf('/')
    const host = k < 0 ? after : after.slice(0, k)
    const p = k < 0 ? '' : after.slice(k)
    const adminShare = p.length >= 3 && p[0] === '/' && isAlpha(p[1]) && p[2] === '$'
    if (host === '' || (host.toLowerCase() === 'localhost' && !adminShare)) rest = p
    else return `//${host}${p}`
  }
  if (rest.length >= 3 && rest[0] === '/' && isAlpha(rest[1]) && rest[2] === ':') rest = rest.slice(1)
  return rest
}

const validVar = name => /^[A-Za-z_][A-Za-z0-9_()]*$/.test(name)

/** 展開 `~`、`$NAME`、`${NAME}`、`%NAME%`。home 為 null 時家目錄相關的展開不了。回傳 [結果, 有沒有展開不了的] */
export function expandOne(raw, home, env) {
  const chars = Array.from(raw)
  const lookup = name => {
    const up = name.toUpperCase()
    if (home !== null) {
      if (up === 'HOME' || up === 'USERPROFILE') return home
      const split = home[1] === ':' ? 2 : 0
      if (up === 'HOMEDRIVE') return home.slice(0, split)
      if (up === 'HOMEPATH') return home.slice(split)
    }
    const hit = env.find(([k, v]) => k.toUpperCase() === up && v !== '')
    return hit ? hit[1] : null
  }
  let out = ''
  let bad = false
  let i = 0
  while (i < chars.length) {
    const c = chars[i]
    if (c === '~' && i === 0 && (chars.length === 1 || chars[1] === '/' || chars[1] === '\\')) {
      if (home !== null) out += home
      else { out += '~'; bad = true }
      i += 1
      continue
    }
    if (c === '$') {
      let name
      let next
      if (chars[i + 1] === '{') {
        const p = chars.slice(i + 2).indexOf('}')
        if (p >= 0) { name = chars.slice(i + 2, i + 2 + p).join(''); next = i + 3 + p } else { name = ''; next = i + 1 }
      } else {
        let j = i + 1
        while (j < chars.length && /^[A-Za-z0-9_]$/.test(chars[j])) j += 1
        name = chars.slice(i + 1, j).join(''); next = j
      }
      if (validVar(name)) {
        const v = lookup(name)
        if (v !== null) out += v
        else { out += chars.slice(i, next).join(''); bad = true }
        i = next
        continue
      }
    }
    if (c === '%') {
      const p = chars.slice(i + 1).indexOf('%')
      if (p >= 0) {
        const name = chars.slice(i + 1, i + 1 + p).join('')
        if (validVar(name)) {
          const v = lookup(name)
          if (v !== null) out += v
          else { out += chars.slice(i, i + p + 2).join(''); bad = true }
          i += p + 2
          continue
        }
      }
    }
    out += c
    i += 1
  }
  return [out, bad]
}

/** 每個家目錄各展開一次（`~`、`$HOME` 在兩個來源下各是一條路徑）。回傳 [候選們, 有沒有展開不了的] */
export function expand(raw, homes, env) {
  const outs = []
  let bad = false
  if (!homes.length) {
    const [s, b] = expandOne(raw, null, env)
    outs.push(s)
    bad = b
  }
  for (const h of homes) {
    const [s, b] = expandOne(raw, h, env)
    if (!outs.includes(s)) outs.push(s)
    bad = bad || b
  }
  return [outs, bad]
}

// ---- ③ Windows 路徑形式 ----

const isDrive = seg => seg.length === 2 && isAlpha(seg[0]) && seg[1] === ':'

const splitUnc = t => {
  if (!t.startsWith('//')) return null
  const rest = t.slice(2)
  const k = rest.indexOf('/')
  return k < 0 ? [rest, ''] : [rest.slice(0, k), rest.slice(k + 1)]
}

/** Windows 路徑的寫法變體：逐段正規化成一般寫法，並把磁碟機前綴與指向本機的網路路徑轉回一般盤符路徑（純字串處理，任何平台都能跑） */
export function winClean(s, hosts = ['localhost', '127.0.0.1']) {
  let t = s.replaceAll('\\', '/')
  for (const p of ['//?/', '//./']) {
    if (t.startsWith(p)) { t = t.slice(p.length); break }
  }
  const unc = splitUnc(t)
  if (unc && hosts.some(h => h.toLowerCase() === unc[0].toLowerCase())) {
    const k = unc[1].indexOf('/')
    const first = k < 0 ? unc[1] : unc[1].slice(0, k)
    const tail = k < 0 ? '' : unc[1].slice(k + 1)
    if (first.length === 2 && isAlpha(first[0]) && first.endsWith('$')) t = `${first[0]}:/${tail}`
  }
  const segs = []
  t.split('/').forEach((seg, i) => {
    if (i === 0 && isDrive(seg)) { segs.push(seg); return }
    if (seg === '' || seg === '.' || seg === '..') { segs.push(seg); return }
    const name = seg.split(':')[0].replace(/[. ]+$/, '')
    if (name) segs.push(name)
  })
  return segs.join('/')
}

/** 看不出實際指向哪裡的寫法：磁碟機以外的裝置前綴，或指向別台（或無法確認是本機）管理共用的網路路徑。純字串判斷 */
export function opaqueDevicePath(s, localNames) {
  const t = s.replaceAll('\\', '/')
  const driveAfter = rest => rest.length >= 2 && isAlpha(rest[0]) && rest[1] === ':' && (rest.length === 2 || rest[2] === '/')
  if (t.startsWith('//?/')) return !driveAfter(t.slice(4))
  if (t.startsWith('//./')) return !driveAfter(t.slice(4))
  const unc = splitUnc(t)
  if (unc) {
    const share = unc[1].split('/')[0]
    const admin = share.length === 2 && isAlpha(share[0]) && share.endsWith('$')
    const host = unc[0].toLowerCase()
    return admin && !localNames.some(n => n === host)
  }
  return false
}

/** 磁碟機字母加冒號、後面接的不是分隔符（`C:xxx`）：意思取決於各程序自己的目前資料夾，沒辦法在這裡確定。`C:`、`C:\`、`C:/` 本身不算 */
export function driveRelative(s) {
  let t = s.replaceAll('\\', '/')
  if (t.startsWith('//?/') || t.startsWith('//./')) t = t.slice(4)
  return t.length >= 3 && isAlpha(t[0]) && t[1] === ':' && t[2] !== '/'
}

/** 路徑段含萬用字元（`* ? [ {`）：回傳第一個萬用字元段之前的部分（沒有萬用字元回 null）。前面什麼都沒有就是根或目前資料夾 */
export function wildcardPrefix(c) {
  const segs = c.split(/[/\\]/)
  const i = segs.findIndex(s => /[*?[{]/.test(s))
  if (i < 0) return null
  const prefix = segs.slice(0, i).join('/')
  if (prefix === '') return /^[/\\]/.test(c) ? '/' : '.'
  return prefix.length === 2 && isDrive(prefix) ? `${prefix}/` : prefix
}
