// #1853 設定值清單（docs/設定值清單.md）的檢查核心：全是純函式，測試與「還原驗證」（把清單改壞要變紅）共用。
// 這個檔不是測試檔（檔名沒有 .test）；程式與檔案內容都從外面傳進來，所以負向測試可以餵假的。
//
// 一份清單可以有好幾張表，各表由各自的測試守：
//   - 表頭含「指令／鍵」的表（設定項目）：由這裡解析、檢查。
//   - 「環境變數」節（表頭是「名稱」）：由 Rust 測試守（#2163）；這裡不解析。
//   - 「前端旗標」節（#2321）：表頭不含「指令／鍵」時一樣不解析。
// 所以新加的表不要用「指令／鍵」當表頭，除非它想被這裡管。

export const COLS = { desktop: '電腦', mobile: '手機', web: '網頁' }
const ANCHOR_RE = /《([^＃#》]+)[＃#]([^》]+)》/g
const LINE_REF_RE = /(?:ui|src-tauri)\/[\w./-]+\.(?:mjs|js|rs|html):\d+/
const MANUAL_RE = /〔人工：([^〕]{2,})〕/

// 清單的標準解析：每個以 | 開頭的連續區塊是一張表；只認表頭有「指令／鍵」的表，標記只從第一欄取。
// 每列帶所在章節的分類（`## 一、個人（`me`）` 取 me；分類總表＝cats；「其他存在檔裡…」＝other）。
export function parseList(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const rows = []
  let cat = ''
  for (let i = 0; i < lines.length; i++) {
    const h = /^##\s+(.*)$/.exec(lines[i])
    if (h) cat = (/（`(\w+)`）/.exec(h[1]) ?? [])[1] ?? (h[1].includes('分類總表') ? 'cats' : h[1].startsWith('其他') ? 'other' : h[1].trim())
    if (!lines[i].startsWith('|') || !lines[i].includes('指令／鍵')) continue
    const cut = l => l.split(/(?<!\\)\|/).slice(1, -1).map(c => c.trim())
    const head = cut(lines[i])
    for (let j = i + 2; j < lines.length && lines[j].startsWith('|'); j++) {
      const cells = cut(lines[j])
      rows.push({ head, cells, cat, line: j + 1, tokens: [...(cells[0] ?? '').matchAll(/`([^`]+)`/g)].map(m => m[1]) })
    }
  }
  return rows
}

export const colOf = (r, name) => r.cells[r.head.indexOf(name)] ?? ''

// 把一列的某一欄改成新值，回傳新的整份文字（還原驗證用）；找不到列或欄就丟錯，避免「沒改到」卻以為測過了
export function editRow(text, token, colName, value) {
  const rows = parseList(text)
  const r = rows.find(x => x.tokens.includes(token))
  if (!r) throw new Error(`editRow：找不到 ${token}`)
  const idx = r.head.indexOf(colName)
  if (idx < 0) throw new Error(`editRow：${token} 那張表沒有「${colName}」欄`)
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const cells = [...r.cells]
  cells[idx] = value
  lines[r.line - 1] = `| ${cells.join(' | ')} |`
  return lines.join('\n')
}

// 刪掉某個標記所在的整列
export function dropRow(text, token) {
  const r = parseList(text).find(x => x.tokens.includes(token))
  if (!r) throw new Error(`dropRow：找不到 ${token}`)
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  lines.splice(r.line - 1, 1)
  return lines.join('\n')
}

// 平台欄：只能是「有…」或「無：原因」「無（原因）」；空白、只寫「無」、原因是「同上」都不行
export function parsePlatform(raw) {
  const s = String(raw ?? '').trim()
  if (!s) return { ok: false, has: false, reason: '', why: '空白' }
  if (s.startsWith('有')) return { ok: true, has: true, reason: '' }
  if (s.startsWith('無')) {
    const m = /^無[：:（(]\s*(.+?)\s*[）)]?$/.exec(s)
    const reason = m ? m[1] : ''
    if (reason.length < 4 || /^(同上|同左|如上|無)$/.test(reason)) return { ok: false, has: false, reason, why: '「無」後面要寫原因（不能只寫「同上」）' }
    return { ok: true, has: false, reason }
  }
  return { ok: false, has: false, reason: '', why: '要以「有」或「無：原因」開頭' }
}

// 錨點：《檔案＃一段程式內容》，檔案路徑從 relay/asn/ 起算；內容必須真的在那個檔案裡
export function anchorsOf(cell) {
  return [...String(cell ?? '').matchAll(ANCHOR_RE)].map(m => ({ file: m[1].trim(), snippet: m[2].trim() }))
}

// 掃元件原始碼裡送出的指令字面：act('x'…)、$emit('act', 'x'…)；opProps 打開時再收 op: 'x'
// （只有「選單項目物件」那種檔案要開，例如 quota-readers.mjs；其他檔的 op: 屬性是別的用途，不能一律算）
export function scanOpLiterals(sourceText, { opProps = false } = {}) {
  const out = new Set()
  const res = [/\bact\(\s*'([\w-]+)'/g, /\bemit\(\s*'act'\s*,\s*'([\w-]+)'/g]
  if (opProps) res.push(/\bop:\s*'([\w-]+)'/g)
  for (const re of res) {
    for (const m of sourceText.matchAll(re)) out.add(m[1])
  }
  return out
}

// SETTING_OPS 跟元件實際送出的指令是否一致：互相多出來的各報一筆
export function diffOps(sourceOps, settingOps) {
  const have = new Set(settingOps)
  const errs = []
  for (const op of sourceOps) if (!have.has(op)) errs.push({ kind: 'ops-not-registered', token: op, msg: `元件送出了 ${op}，但它不在 SETTING_OPS` })
  for (const op of settingOps) if (!sourceOps.has(op)) errs.push({ kind: 'ops-not-sent', token: op, msg: `SETTING_OPS 有 ${op}，元件原始碼裡找不到送出它的地方` })
  return errs
}

// 取 Rust 具名常數的數字值（const NAME: 型別 = 數字;）
export const rustConst = (text, name) => {
  const m = new RegExp(`const\\s+${name}\\s*:\\s*\\w+\\s*=\\s*(\\d+)`).exec(text ?? '')
  return m ? Number(m[1]) : null
}

// 取 `impl Default for BridgeSettings` 初值那一行裡某個欄位的值
export const bridgeDefault = (text, field) => {
  const m = /impl Default for BridgeSettings[\s\S]*?BridgeSettings \{([^}]*)\}/.exec(text ?? '')
  const f = m && new RegExp(`\\b${field}:\\s*([^,]+?)\\s*(?:,|$)`).exec(m[1])
  return f ? f[1] : null
}

const pass = (spec, cell) => {
  const bad = []
  if (spec.startsWith !== undefined && !cell.startsWith(spec.startsWith)) bad.push(`要以「${spec.startsWith}」開頭`)
  for (const s of spec.includes ?? []) if (!cell.includes(s)) bad.push(`要包含「${s}」`)
  return bad
}

// 主檢查。text＝清單全文；truth＝從程式取得的標準答案（見 settings-list.test.mjs）。
// 回傳 { errors, entries }：errors 是 { kind, token?, line?, msg }；entries 是 { token, cat, platforms, line }，
// 給之後的合約表（#1763）直接用，不要在別的測試再寫一份 markdown 解析器。
export function checkList(text, truth) {
  const rows = parseList(text)
  const errors = []
  const err = (kind, msg, r, token) => errors.push({ kind, msg, token, line: r?.line })
  const allTokens = rows.flatMap(r => r.tokens)
  const rowOf = tok => rows.find(r => r.tokens.includes(tok))
  const tokensOf = prefix => allTokens.filter(t => t.startsWith(prefix))
  const read = rel => truth.readFile(rel)

  // 1 結構
  if (rows.length <= 60) err('row-count', `解析到的列數太少（${rows.length}），表頭格式變了？`)
  for (const r of rows) {
    if (r.cells.length !== r.head.length) err('row-shape', `第 ${r.line} 列欄數跟表頭不同`, r)
    if (r.tokens.length === 0) err('row-shape', `第 ${r.line} 列第一欄沒有反引號標記`, r)
  }
  for (const t of new Set(allTokens.filter((x, i) => allTokens.indexOf(x) !== i))) err('dup', `標記重複：${t}（同一個設定只能有一列）`, rowOf(t), t)

  // 2 指令（SETTING_OPS）雙向
  const ops = new Set(truth.ops)
  const have = new Set(allTokens)
  for (const op of truth.ops) if (!have.has(op)) err('op-missing', `設定值清單缺指令 ${op}（新增設定要一起登記）`, null, op)
  const prefixed = /^(prefs|cat|flag|app)\./
  for (const t of allTokens.filter(x => !prefixed.test(x))) if (!ops.has(t)) err('op-extra', `設定值清單寫了程式已經沒有的指令 ${t}`, rowOf(t), t)

  // 3 手機偏好雙向＋預設
  for (const k of truth.prefs.keys) {
    const r = rowOf(`prefs.${k}`)
    if (!r) { err('pref-missing', `設定值清單缺手機偏好 prefs.${k}`, null, `prefs.${k}`); continue }
    const dv = truth.prefs.defaults[k]
    const cell = colOf(r, '預設值')
    if (typeof dv === 'boolean' && !cell.startsWith(dv ? '開' : '關')) err('pref-default', `prefs.${k} 預設值應為${dv ? '開' : '關'}`, r, `prefs.${k}`)
    if (Array.isArray(dv) && dv.length === 0 && !cell.startsWith('空')) err('pref-default', `prefs.${k} 預設值應為空`, r, `prefs.${k}`)
    if (k === 'skin' && !cell.includes(truth.prefs.skinLabel)) err('pref-default', 'prefs.skin 預設值跟程式不一致', r, 'prefs.skin')
  }
  for (const t of tokensOf('prefs.')) if (!truth.prefs.keys.includes(t.slice(6))) err('pref-extra', `設定值清單寫了程式已經沒有的手機偏好 ${t}`, rowOf(t), t)

  // 4 分類
  for (const c of truth.cats) {
    const r = rowOf(`cat.${c.key}`)
    if (!r) { err('cat-missing', `分類總表缺 ${c.key}（${c.title}）`, null, `cat.${c.key}`); continue }
    if (colOf(r, '標題') !== c.title) err('cat-title', `${c.key} 標題跟程式不同`, r, `cat.${c.key}`)
    if (colOf(r, COLS.desktop) !== '有') err('cat-desktop', `${c.key} 電腦欄應為「有」`, r, `cat.${c.key}`)
    if (colOf(r, COLS.mobile).startsWith('有') !== truth.mobileCats.includes(c.key)) err('cat-mobile', `${c.key} 手機欄跟 MOBILE_SETTING_KEYS 不一致`, r, `cat.${c.key}`)
  }
  const catKeys = new Set(truth.cats.map(c => c.key))
  for (const t of tokensOf('cat.')) if (!catKeys.has(t.slice(4))) err('cat-extra', `分類總表寫了不存在的分類 ${t}`, rowOf(t), t)

  // 5 旗標：清單寫的目前值跟程式一致
  for (const [name, on] of Object.entries(truth.flags)) {
    const r = rowOf(`flag.${name}`)
    if (!r) { err('flag', `設定值清單缺旗標 ${name}`, null, `flag.${name}`); continue }
    if (!colOf(r, '預設值').includes(`目前：${on ? '開' : '關'}`)) err('flag', `旗標 ${name} 目前值跟清單不一致（翻旗標要改清單）`, r, `flag.${name}`)
  }

  // 6 預設值：跟程式比對；比不了的要標〔人工：原因〕；沒有預設的寫「不適用」
  const checked = new Set()
  for (const spec of truth.defaults) {
    const r = rowOf(spec.token)
    if (!r) { err('default', `預設值檢查找不到 ${spec.token}`, null, spec.token); continue }
    checked.add(r)
    for (const why of pass(spec, colOf(r, '預設值'))) err('default', `${spec.token} 預設值${why}（跟程式不一致）`, r, spec.token)
    for (const [file, re] of spec.code ?? []) {
      const src = read(file)
      if (src == null) err('default-code', `${spec.token} 的預設值依據檔案不存在：${file}`, r, spec.token)
      else if (!re.test(src)) err('default-code', `${spec.token} 的預設值在 ${file} 找不到對應內容 ${re}`, r, spec.token)
    }
  }
  for (const r of rows) {
    if (!r.head.includes('預設值')) continue
    const cell = colOf(r, '預設值')
    if (!cell) { err('default-empty', `第 ${r.line} 列預設值是空的`, r, r.tokens[0]); continue }
    if (checked.has(r) || r.tokens.some(t => t.startsWith('prefs.') || t.startsWith('flag.')) || /^不適用/.test(cell)) continue
    if (!MANUAL_RE.test(cell)) err('default-uncovered', `${r.tokens[0]} 的預設值沒有跟程式比對，也沒寫〔人工：原因〕`, r, r.tokens[0])
  }

  // 7 平台欄＋誰會讀它（錨點）
  const entries = []
  for (const r of rows) {
    const platforms = {}
    for (const [k, name] of Object.entries(COLS)) {
      if (!r.head.includes(name)) continue
      const p = parsePlatform(colOf(r, name))
      platforms[k] = p
      if (!p.ok) err(p.why === '空白' ? 'platform-empty' : 'platform-bad', `${r.tokens[0]} 的「${name}」欄：${p.why}`, r, r.tokens[0])
    }
    for (const t of r.tokens) entries.push({ token: t, cat: r.cat, platforms, line: r.line })

    for (const c of r.cells) {
      const rest = c.replace(ANCHOR_RE, '')
      if (LINE_REF_RE.test(rest)) err('anchor-linenum', `${r.tokens[0]}：還有「檔案:行號」的寫法（${LINE_REF_RE.exec(rest)[0]}），請改成《檔案＃程式內容》`, r, r.tokens[0])
      for (const a of anchorsOf(c)) {
        const src = read(a.file)
        if (src == null) err('anchor-file', `${r.tokens[0]}：錨點的檔案不存在 ${a.file}`, r, r.tokens[0])
        else if (a.snippet.length < 3 || !src.includes(a.snippet)) err('anchor-miss', `${r.tokens[0]}：${a.file} 裡找不到「${a.snippet}」（程式改了，請更新清單）`, r, r.tokens[0])
      }
    }
    if (r.head.includes('誰會讀它') && anchorsOf(colOf(r, '誰會讀它')).length === 0) err('anchor-none', `${r.tokens[0]}：「誰會讀它」沒有任何錨點`, r, r.tokens[0])
  }
  return { errors, entries }
}

export const fmtErrors = errors => errors.map(e => `[${e.kind}]${e.line ? ` 第 ${e.line} 列` : ''} ${e.msg}`).join('\n')
