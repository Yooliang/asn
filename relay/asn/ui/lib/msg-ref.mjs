// 訊息內文裡的編號（#1530）：#N 可以點。GitHub 議題／PR 編號開網頁；群組訊息編號跳到群組裡那一則並標亮。
// 純函式，電腦版與手機版共用；不碰 DOM、不碰 Tauri。
// 判斷規則（refKind）：
//   1. 群組裡寫成「回 #N」「回覆 #N」「#N 則」這種明顯在講群組訊息的：不管有沒有載入，一律當群組訊息。
//   2. 群組裡、數字落在已知範圍內（下限＝畫面上已載入最舊那則的序號，上限＝群組最新的序號）：當群組訊息。
//   3. 其他（含一對一對話）：設定「把 #編號 連到 ASN 的 GitHub 議題」打開才當 GitHub；沒開（預設）就維持普通文字。
//      ASN 是給所有人用的，一般人寫「第 #2 點」不該連到我們的議題（asn真 #3942）。
// 程式碼（行內與區塊）和連結（含網址）裡的 # 不處理；HTML 實體（&#39; 這類）不會被當成編號。
import { esc } from './text.mjs'

export const GITHUB_ISSUES = 'https://github.com/Yooliang/asn/issues/'
export const githubUrl = n => `${GITHUB_ISSUES}${n}`
export const MAX_REF = 9_999_999

// 「回 #N」「回覆 #N」：#N 前面緊接著這些字；「#N 則」：#N 後面緊接著「則」
const CUE_BEFORE = /(?:回覆|回)[ \t　]*$/u
const CUE_AFTER = /^[ \t　]*則/u
export const groupCue = (before, after) => CUE_BEFORE.test(String(before ?? '')) || CUE_AFTER.test(String(after ?? ''))

const seqOk = v => Number.isInteger(v) && v > 0

// 已知的群組訊息範圍：lo＝已載入最舊那則的序號，hi＝max(群組最新序號, 已載入最新那則)；沒有載入任何一則＝沒有範圍
export function refRange(log, lastSeq) {
  let lo = null, hi = null
  for (const m of Array.isArray(log) ? log : []) {
    if (!seqOk(m?.seq)) continue
    if (lo === null || m.seq < lo) lo = m.seq
    if (hi === null || m.seq > hi) hi = m.seq
  }
  if (lo === null) return { lo: null, hi: null }
  return { lo, hi: seqOk(lastSeq) && lastSeq > hi ? lastSeq : hi }
}

// 回 'group'、'github'，或 null（不是可點的編號）。github＝設定「把 #編號 連到 ASN 的 GitHub 議題」有沒有打開（預設關）
export function refKind({ n, room = false, lo = null, hi = null, cue = false, github = false } = {}) {
  if (room && cue) return 'group'
  if (room && seqOk(lo) && seqOk(hi) && n >= lo && n <= hi) return 'group'
  return github === true ? 'github' : null
}

// 設定頁的開關文字（電腦「外觀」與手機「外觀」共用）
export const GH_REFS_LABEL = '把訊息裡的 #編號 連到 ASN 的 GitHub 議題'
export const GH_REFS_NOTE = '給開發 ASN 的人用，一般不用開。不管開不開，群組裡的訊息編號都可以點，點了跳到那一則。'

export const refTip = (kind, n) => (kind === 'group' ? `跳到群組第 ${n} 則` : `開啟 GitHub #${n}`)

// #N：前面不能是英文字母數字、底線、/、#、&（C#12、網址片段、HTML 實體、##）；中文字後面可以直接接（「見#12」）；後面不能接著字母數字或底線；不收 0 開頭
const REF = /#([1-9][0-9]{0,6})(?![\p{L}\p{N}_])/gu
const BLOCKED_BEFORE = /[A-Za-z0-9_/#&]$/

// 在 renderMarkdown（＋markMentions）輸出的安全 HTML 裡，把 #N 包成可點的標記。只動標籤之間的文字；code／pre／a 裡面不動。
// ctx：{ room, lo, hi, github }。輸出的標記只有固定的 class／role／tabindex 與 data-ref（group|github）、data-n（數字）、title（固定句子）。
export function linkRefs(html, ctx = {}) {
  const s = String(html ?? '')
  if (!s.includes('#')) return s
  let skip = 0
  return s.split(/(<[^>]+>)/).map(seg => {
    if (seg.startsWith('<')) {
      if (/^<(code|pre|a)[\s>]/i.test(seg)) skip++
      else if (/^<\/(code|pre|a)>/i.test(seg)) skip = Math.max(0, skip - 1)
      return seg
    }
    if (skip || !seg.includes('#')) return seg
    return seg.replace(REF, (all, num, at) => {
      const before = seg.slice(0, at)
      if (BLOCKED_BEFORE.test(before) || /&amp;$/.test(before)) return all
      const n = Number(num)
      if (!seqOk(n) || n > MAX_REF) return all
      const kind = refKind({ n, room: ctx.room === true, lo: ctx.lo, hi: ctx.hi, cue: groupCue(before, seg.slice(at + all.length)), github: ctx.github === true })
      if (!kind) return all
      return `<span class="msg-ref" role="link" tabindex="0" data-ref="${kind}" data-n="${n}" title="${esc(refTip(kind, n))}">#${n}</span>`
    })
  }).join('')
}

// 點到的元素 → { kind, n }；不是編號標記回 null。n 只從 data-n 取數字，網址一律由 githubUrl(n) 組，不讀任何 href
export function refOf(el) {
  const t = el?.closest?.('.msg-ref[data-ref]')
  if (!t) return null
  const kind = t.getAttribute('data-ref')
  const n = Number(t.getAttribute('data-n'))
  if ((kind !== 'group' && kind !== 'github') || !seqOk(n) || n > MAX_REF) return null
  return { kind, n }
}
