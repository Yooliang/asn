import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// 靜態守門共用：讀 Rust 原始碼、去掉註解、取出函式或大括號區塊（#1808 一審）。
const CRLF = String.fromCharCode(13, 10)
export const src = rel => fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src-tauri/src', rel), 'utf8').split(CRLF).join('\n')
export const prod = s => s.split('#[cfg(test)]')[0]

// 掃一遍 Rust 原始碼，回傳等長的字串：註解（// 與 /* */）一律換成空白（保留換行）；
// strings=true 時字串內容也換成空白（用來配對大括號，字串裡的 { } 不算）
function mask(text, strings) {
  let out = ''
  for (let i = 0; i < text.length;) {
    const c = text[i], n = text[i + 1]
    if (c === '/' && n === '/') {
      while (i < text.length && text[i] !== '\n') { out += ' '; i++ }
    } else if (c === '/' && n === '*') {
      let depth = 0
      do {
        if (text[i] === '/' && text[i + 1] === '*') { depth++; out += '  '; i += 2 }
        else if (text[i] === '*' && text[i + 1] === '/') { depth--; out += '  '; i += 2 }
        else { out += text[i] === '\n' ? '\n' : ' '; i++ }
      } while (depth > 0 && i < text.length)
    } else if (c === '"') {
      out += c; i++
      while (i < text.length && text[i] !== '"') {
        const skip = text[i] === '\\' ? 2 : 1
        for (let k = 0; k < skip && i < text.length; k++, i++) out += strings && text[i] !== '\n' ? ' ' : text[i]
      }
      if (i < text.length) { out += '"'; i++ }
    } else if (c === "'" && (text[i + 2] === "'" || (text[i + 1] === '\\' && text[i + 3] === "'"))) {
      // 字元常值（'"'、'{'、'\n'）：不是字串開頭；生命週期 'a 不會符合這個形狀
      const len = text[i + 1] === '\\' ? 4 : 3
      out += strings ? "'" + ' '.repeat(len - 2) + "'" : text.slice(i, i + len)
      i += len
    } else { out += c; i++ }
  }
  return out
}

export const stripComments = text => mask(text, false)

// 去掉註解後的文字與「連字串內容都清掉」的對照版（同長度，位置一一對應）
export function code(text) {
  return { text: mask(text, false), shape: mask(text, true) }
}

// 從 open（'{' 的位置）配對到收尾 '}'，回傳區塊本體（含大括號）
export function block(c, open) {
  assert(c.text[open] === '{', '區塊起點要是 {')
  let depth = 0
  for (let i = open; i < c.shape.length; i++) {
    if (c.shape[i] === '{') depth++
    else if (c.shape[i] === '}' && --depth === 0) return c.text.slice(open, i + 1)
  }
  throw new Error('大括號沒配對到')
}
function assert(ok, msg) { if (!ok) throw new Error(msg) }

// 取出函式整段（簽名到收尾大括號），先去註解；簽名要出現在註解以外
export function fnCode(rawText, sig) {
  const c = code(rawText)
  const i = c.text.indexOf(sig)
  assert(i >= 0, `找不到函式（註解不算）：${sig}`)
  const open = c.shape.indexOf('{', i + sig.length)
  return block(c, open)
}

// 在去註解的文字 body 中，找符合 re 的位置，取它後面第一個 { 起的區塊
export function blockAfter(body, re, from = 0) {
  const c = code(body)
  const m = re.exec(c.text.slice(from))
  assert(m, `找不到：${re}`)
  const at = from + m.index
  const open = c.shape.indexOf('{', at + m[0].length - (m[0].endsWith('{') ? 1 : 0))
  return { at, text: block(c, open) }
}
