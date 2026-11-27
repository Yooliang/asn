// 讀取請求的參數 → 所有可能是路徑的字串（與 Rust 端 acp_sensitive.rs 的「路徑抽取」、fragments.rs、jsonstr.rs 對應）。
import { DATA, byteLen, currentSensitiveData, hasWs, trimWs } from './acp-sensitive-data.mjs'

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v)

// ---- JSON 字串 ----

/** 字串本身是一段 JSON 物件或陣列（前綴先篩，免得每個字串都去解析）。回傳解開的值或 null */
export function jsonContainer(s) {
  const t = s.trimStart()
  if (!t.startsWith('{') && !t.startsWith('[')) return null
  try {
    const v = JSON.parse(s)
    return v !== null && typeof v === 'object' ? v : null
  } catch { return null }
}

/** 長得像 JSON 容器的字串（不管解不解得開）：去掉開頭的位元組順序記號與空白後，以 `{` 或 `[` 開頭，或以引號開頭而且裡面有 `{`（多重編碼）。這種字串路徑判定看不透，一律當解析不了 */
export function containerLike(s) {
  const t = trimWs(s.replace(/^﻿+/, ''))
  return t.startsWith('{') || t.startsWith('[') || (t.startsWith('"') && t.includes('{'))
}

// ---- 一般文字裡夾著敏感位置路徑 ----

const norm = s => s.replaceAll('\\', '/').replace(/[A-Z]/g, c => c.toLowerCase())
let fragCache = null // { data, out }：清單換了一份（測試改讀別的檔）就重算
/** 清單每一項的最後兩段（只有一段的就是那一段）。片段不手寫：清單加一項，這裡自動跟著認得 */
export function fragments() {
  const data = currentSensitiveData()
  if (fragCache && fragCache.data === data) return fragCache.out
  const rels = [...data.homeDirs, ...data.extraHomePaths, ...data.prefixHomeFiles.map(([d, p]) => `${d}/${p}`), ...data.systemFiles, data.hostKeyDir]
  const out = []
  for (const r of rels) {
    const segs = norm(r).split('/').filter(s => s !== '')
    if (!segs.length) continue
    const tail = segs.slice(Math.max(0, segs.length - 2)).join('/')
    if (!out.includes(tail)) out.push(tail)
  }
  fragCache = { data, out }
  return out
}

const trimChars = (s, set) => {
  let a = 0
  let b = s.length
  while (a < b && set.includes(s[a])) a += 1
  while (b > a && set.includes(s[b - 1])) b -= 1
  return s.slice(a, b)
}

/** 一行有空白的文字：夾著敏感位置片段的，回傳可能的路徑候選（從幾個空白邊界到片段後面那段路徑結束），其餘回空 */
export function proseCandidates(line) {
  const { lead: LEAD, trail: TRAIL, trim: TRIM, maxHits: MAX_HITS, maxStarts: MAX_STARTS } = DATA.prose
  const n = norm(line)
  const out = []
  let hits = 0
  for (const f of fragments()) {
    for (let i = n.indexOf(f); i >= 0; i = n.indexOf(f, i + f.length)) {
      const end = i + f.length
      const leadOk = i === 0 || LEAD.includes(n[i - 1])
      const trailOk = end === n.length || TRAIL.includes(n[end])
      if (!leadOk || !trailOk) continue
      hits += 1
      if (hits > MAX_HITS) return out
      let stop = line.length
      for (let j = end; j < line.length; j += 1) { if (hasWs(line[j])) { stop = j; break } }
      // 路徑本身可能含空白：每個空白邊界都當一個可能的起點
      const starts = [0]
      for (let j = 0; j < i; j += 1) if (hasWs(line[j])) starts.push(j + 1)
      const from = Math.max(0, starts.length - MAX_STARTS)
      for (const j of starts.slice(from)) {
        const c = trimChars(line.slice(j, stop), TRIM)
        if (c && !out.includes(c)) out.push(c)
      }
    }
  }
  return out
}

// ---- 抽取 ----

const keyIsPath = k => { const l = k.toLowerCase(); return DATA.pathKeyWords.some(w => l.includes(w)) }

const looksLikePath = s => s.includes('/') || s.includes('\\') || s.startsWith('~') || s.startsWith('$') || s.toLowerCase().startsWith('file:')
  || /^[A-Za-z]:/.test(s) || (s.match(/%/g) ?? []).length >= 2

const pushUnique = (out, s) => { if (trimWs(s) !== '' && !out.includes(s)) out.push(s) }

function walk(v, underKey, out, depth) {
  if (typeof v === 'string') {
    // 字串能解成物件或陣列：往裡面找（有層數上限，超過的原樣收進來由判定擋）
    const inner = jsonContainer(v)
    if (inner !== null) {
      if (depth < DATA.maxJsonDepth) walk(inner, underKey, out, depth + 1)
      else pushUnique(out, v)
      return
    }
    // 長得像 JSON 容器卻解不開（缺括號、多接文字、單引號、多重編碼…）：原樣收進來，判定那邊當解析不了
    if (containerLike(v)) { pushUnique(out, v); return }
    if (underKey) { pushUnique(out, v); return } // 路徑類欄位的字串一律收（超長、含換行的由判定那邊直接擋）
    if (byteLen(v) <= DATA.maxPathLen && !v.includes('\n')) {
      if (looksLikePath(v)) pushUnique(out, v)
      return
    }
    // 其他欄位的超長或多行文字，逐行看：沒有空白又像路徑的收；有空白的，夾著敏感位置片段的才把那段路徑收進來
    for (const line of v.split(/\r?\n/).map(trimWs).filter(l => l !== '')) {
      if (!hasWs(line)) { if (looksLikePath(line)) pushUnique(out, line) } else proseCandidates(line).forEach(c => pushUnique(out, c))
    }
    return
  }
  if (Array.isArray(v)) { v.forEach(x => walk(x, underKey, out, depth)); return }
  if (isObj(v)) {
    for (const [k, x] of Object.entries(v)) {
      // 指令與程式碼欄位是整段命令，不是路徑，路徑判定管不到（敏感清單不是邊界）
      if (keyIsPath(k) || !DATA.skipKeys.includes(k.toLowerCase())) walk(x, underKey || keyIsPath(k), out, depth)
    }
  }
}

/** 讀取請求的參數 → 所有可能是路徑的字串：路徑類欄位名底下的字串（含陣列、巢狀），以及任何位置長得像路徑的字串 */
export function extractReadPaths(params) {
  const out = []
  walk(params, false, out, 0)
  return out
}

/** 參數的最上層欄位名（只有名字、沒有值；寫 log 用） */
export function paramKeys(params) {
  if (isObj(params)) return Object.keys(params)
  if (typeof params === 'string') {
    try { const v = JSON.parse(params); return isObj(v) ? Object.keys(v) : [] } catch { return [] }
  }
  return []
}
