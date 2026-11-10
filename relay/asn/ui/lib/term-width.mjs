// 終端畫面的字寬對齊（#903）：xterm 預設用 Unicode 6 的字寬表，emoji（例如 ✅ 🙂）算 1 格，
// 但 WezTerm 回報的游標欄（cursor_x）是把它們算 2 格；一行裡有幾個 emoji，游標就往左偏幾格。
// 這裡自己註冊一份字寬表（全形、中日韓、emoji 佔 2 格，組合字、零寬字元佔 0 格），不加任何套件。

/** 東亞全形、寬字元的區段（含頭尾） */
const WIDE_RANGES = [
  [0x1100, 0x115f], [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xa000, 0xa4cf],
  [0xac00, 0xd7a3], [0xf900, 0xfaff], [0xfe10, 0xfe19], [0xfe30, 0xfe6f], [0xff00, 0xff60], [0xffe0, 0xffe6],
  [0x1f300, 0x1f64f], [0x1f900, 0x1f9ff], [0x20000, 0x3fffd],
]
const ZERO = /^[\p{Mn}\p{Me}\p{Cf}]$/u
const EMOJI_WIDE = /^\p{Emoji_Presentation}$/u

/** 一個碼位佔幾格：0、1 或 2 */
export function cellWidth(cp) {
  if (cp === 0 || cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0
  if (cp < 0x300) return 1
  const ch = String.fromCodePoint(cp)
  if (ZERO.test(ch)) return 0
  if (EMOJI_WIDE.test(ch)) return 2
  for (const [a, b] of WIDE_RANGES) if (cp >= a && cp <= b) return 2
  return 1
}

/** 一段字佔幾格（測試與探測用） */
export const stringWidth = s => [...String(s)].reduce((n, c) => n + cellWidth(c.codePointAt(0)), 0)

const widthOf = props => (props >> 1) & 3
/** xterm 的字寬提供者（介面同它內建的 Unicode 6：charProperties 回傳「寬度與是否接在前一個字上」的打包值） */
export const wezTermWidthProvider = {
  version: 'asn-wide',
  wcwidth: cp => cellWidth(cp),
  charProperties(cp, preceding) {
    let width = cellWidth(cp)
    let join = width === 0 && preceding !== 0
    if (join) {
      const old = widthOf(preceding)
      if (!old) join = false
      else if (old > width) width = old
    }
    return ((width & 3) << 1) | (join ? 1 : 0)
  },
}

/** 把字寬表裝到 xterm 上並啟用。xterm 沒有這個介面（舊版或測試用的假終端）就不動，回 false */
export function installWideChars(term) {
  const u = term?.unicode
  if (!u || typeof u.register !== 'function') return false
  try {
    u.register(wezTermWidthProvider)
    u.activeVersion = wezTermWidthProvider.version
    return true
  } catch (e) {
    console.info('[ASN] 終端字寬表裝不上', String(e?.message ?? e))
    return false
  }
}
