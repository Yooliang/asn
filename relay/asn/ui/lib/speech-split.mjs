// 把要念的長文字切成幾段，第一段短、好了就先念（#99 第二期「邊生成邊念」）。
// 做法：先依句號、問號、驚嘆號、換行（中英文都算）切成句子；第一段只放第一句（太短就併下一句），
// 其餘句子合併成較長的幾段，最多 MAX_SEGMENTS 段。段數要少，因為後台有頻率限制（每節點每分鐘 12 次）。
export const FIRST_MIN = 6        // 第一段至少這麼多字，太短的語氣詞（「好。」）併到下一句
export const SEG_MAX = 100        // 後面每段盡量不超過這麼多字
export const MAX_SEGMENTS = 4     // 一則最多切成幾段（超過的併進最後一段）

/** 依句尾標點與換行切句，標點留在句尾；空白句丟掉 */
export function splitSentences(text) {
  const out = []
  let cur = ''
  const chars = [...String(text ?? '')]
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i]
    if (c === '\n') { if (cur.trim()) out.push(cur.trim()); cur = ''; continue }
    cur += c
    if ('。！？!?；'.includes(c) || (c === '.' && (chars[i + 1] === undefined || /\s/.test(chars[i + 1])))) {
      while ('」』）)”"'.includes(chars[i + 1] ?? 'x')) cur += chars[++i]   // 收尾引號跟著前一句
      if (cur.trim()) out.push(cur.trim())
      cur = ''
    }
  }
  if (cur.trim()) out.push(cur.trim())
  return out
}

/** 切成要分段合成的幾段文字：串起來等於原文（只差空白） */
export function speechSegments(text) {
  const sents = splitSentences(text)
  if (sents.length <= 1) return sents.length ? [sents[0]] : []
  const segs = []
  let i = 0, first = ''
  while (i < sents.length && [...first].length < FIRST_MIN) first += (first ? ' ' : '') + sents[i++]
  segs.push(first)
  let cur = ''
  for (; i < sents.length; i++) {
    if (cur && [...cur].length + [...sents[i]].length > SEG_MAX) { segs.push(cur); cur = '' }
    cur += (cur ? ' ' : '') + sents[i]
  }
  if (cur) segs.push(cur)
  while (segs.length > MAX_SEGMENTS) { const last = segs.pop(); segs[segs.length - 1] += ' ' + last }
  return segs
}
