// 測試共用：skin-common.css 把「現代」與「LINE 風格」逐字相同的規則寫成 `:root[data-skin="modern"] X,:root[data-skin="line"] X{…}`。
// skinCss(skin, 專屬檔) 回傳該外觀「實際生效的全部規則」：共用檔裡只留該外觀的選擇器（先排）＋該外觀自己的檔（後排），
// 讓測試照舊用 `:root[data-skin="modern"] X{…}` 的寫法比對，不必知道規則放在哪一份。
import fs from 'node:fs'
const rd = f => fs.readFileSync(new URL(`../ui/${f}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
function splitTop(s) {
  const out = []; let d = 0, cur = '', q = ''
  for (const ch of s) {
    if (q) { cur += ch; if (ch === q) q = ''; continue }
    if (ch === '"' || ch === "'") { q = ch; cur += ch; continue }
    if (ch === '(' || ch === '[') d++
    else if (ch === ')' || ch === ']') d--
    if (ch === ',' && d === 0) { out.push(cur); cur = '' } else cur += ch
  }
  out.push(cur); return out.map(x => x.trim()).filter(Boolean)
}
export function commonFor(skin) {
  const css = rd('skin-common.css'); const prefix = `:root[data-skin="${skin}"] `
  let out = '', i = 0
  while (i < css.length) {
    if (css.startsWith('/*', i)) { const j = css.indexOf('*/', i) + 2; out += css.slice(i, j) + '\n'; i = j; continue }
    if (/\s/.test(css[i])) { i++; continue }
    const k = css.indexOf('{', i), e = css.indexOf('}', k)
    const sels = splitTop(css.slice(i, k)).filter(s => s.startsWith(prefix))
    if (sels.length) out += sels.join(',') + css.slice(k, e + 1) + '\n'
    i = e + 1
  }
  return out
}
export const skinCss = (skin, own = skin === 'line' ? 'line.css' : 'modern.css') => commonFor(skin) + rd(own)
