// 訊息內文裡的編號（#1530、#1776）：可以點。電腦版、手機版共用同一份；純函式，不碰 DOM、不碰 Tauri。
// 規則（GitHub 通用寫法，沒有 ASN 專用規則）：
//   1. 「擁有者/repo#111」（例如 Yooliang/asn#1751）：顯示成「repo#111」，開 https://github.com/擁有者/repo/issues/111（GitHub 會自己轉到 PR）。
//      擁有者與 repo 名照 GitHub 規則驗，不合就不轉。群組裡要連 GitHub 的單，一律寫全名。
//   2. 單獨的「#111」：
//      - 群組：群組訊息編號（寫成「回 #N」「#N 則」，或數字落在已載入的訊息範圍內）→ 跳到那一則；其他不處理。
//      - 一對一：知道這位夥伴的 repo（ctx.repo，Rust 端讀 git remote）才連到那個 repo；不知道就是普通文字，不會連錯 repo。
//   3. 只產生 github.com 的連結；點擊交給外部瀏覽器（open_link）。
// 程式碼（行內與區塊）和連結（含網址）裡的 # 不處理；HTML 實體（&#39; 這類）不會被當成編號；前面緊貼英數字（a#1、C#12）也不處理。
import { esc } from './text.mjs'

export const MAX_REF = 9_999_999

// ---- GitHub 倉庫名（擁有者/repo）的驗證：前端與 Rust（src-tauri/src/partner_repo.rs）同一套規則 ----
// 擁有者：英數與 -，1～39 字，不以 - 開頭或結尾，不連續兩個 -；repo：英數與 . _ -，1～100 字，不能是 . 或 ..
export const validOwner = s => typeof s === 'string' && s.length >= 1 && s.length <= 39 && /^[A-Za-z0-9-]+$/.test(s) && !s.startsWith('-') && !s.endsWith('-') && !s.includes('--')
export const validRepo = s => typeof s === 'string' && s.length >= 1 && s.length <= 100 && s !== '.' && s !== '..' && /^[A-Za-z0-9._-]+$/.test(s)
// 「擁有者/repo」→ { owner, repo }；不合規則回 null
export function parseRepo(full) {
  if (typeof full !== 'string') return null
  const i = full.indexOf('/')
  if (i < 0) return null
  const owner = full.slice(0, i), repo = full.slice(i + 1)
  return validOwner(owner) && validRepo(repo) ? { owner, repo } : null
}
// 議題連結（GitHub 會自己把 PR 編號轉到 PR）；repo 或編號不合就回 null，不組出怪網址
export function githubUrl(full, n) {
  const p = parseRepo(full)
  return p && seqOk(n) && n <= MAX_REF ? `https://github.com/${p.owner}/${p.repo}/issues/${n}` : null
}

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

// 單獨的 #N 是什麼：'group'（群組訊息編號）、'github'（連到 repo 這個倉庫）、或 null（普通文字）
export function refKind({ n, room = false, lo = null, hi = null, cue = false, repo = '' } = {}) {
  if (room) return cue || (seqOk(lo) && seqOk(hi) && n >= lo && n <= hi) ? 'group' : null   // 群組裡單獨的 #N 不連 GitHub
  return parseRepo(repo) ? 'github' : null
}

export const refTip = (kind, n, repo = '') => (kind === 'group' ? `跳到群組第 ${n} 則` : `開啟 GitHub ${repo}#${n}`)

// 全名「擁有者/repo#N」或單獨「#N」。全名的擁有者與 repo 名先照字元收，再用 parseRepo 驗長度與格式
// 先找「#N」，再從 # 往回切出 repo 與擁有者（每個字只掃一次，長字串不會二次方回溯）
const NUM = /#([1-9][0-9]{0,6})(?![\p{L}\p{N}_])/gu
const REPO_CH = /[A-Za-z0-9._-]/, OWNER_CH = /[A-Za-z0-9-]/, ALNUM = /[A-Za-z0-9]/
// 在 floor（前一個已處理的結尾）之後、hash 之前，找「擁有者/repo」；沒有回 null
function prefixBefore(seg, hash, floor) {
  let i = hash
  while (i > floor && REPO_CH.test(seg[i - 1])) i--
  if (i === hash || i - 1 < floor || seg[i - 1] !== '/') return null
  const slash = i - 1
  let j = slash
  while (j > floor && OWNER_CH.test(seg[j - 1])) j--
  while (j < slash && !ALNUM.test(seg[j])) j++
  if (j === slash) return null
  return { start: j, owner: seg.slice(j, slash), repoName: seg.slice(i, hash) }
}
// 與 seg.replace(REF, cb) 同義：cb(all, owner|undefined, repoName|undefined, num, at)
function replaceRefs(seg, cb) {
  let out = '', last = 0
  NUM.lastIndex = 0
  let m
  while ((m = NUM.exec(seg))) {
    const p = prefixBefore(seg, m.index, last)
    const start = p ? p.start : m.index
    const end = m.index + m[0].length
    out += seg.slice(last, start) + (p ? cb(seg.slice(start, end), p.owner, p.repoName, m[1], start) : cb(m[0], undefined, undefined, m[1], start))
    last = end
  }
  return out + seg.slice(last)
}
// 單獨 #N：前面不能是英文字母數字、底線、/、#、&（C#12、網址片段、HTML 實體、##）；中文字後面可以直接接（「見#12」）
const BLOCKED_BEFORE = /[A-Za-z0-9_/#&]$/
// 全名：前面還不能是 . - : @（網址、網域、帳號裡的片段，例如 x.com/foo/bar#12）
const BLOCKED_BEFORE_FULL = /[A-Za-z0-9_/#&.\-:@]$/

// 在 renderMarkdown（＋markMentions）輸出的安全 HTML 裡，把可以點的編號包成標記。只動標籤之間的文字；code／pre／a 裡面不動。
// ctx：{ room, lo, hi, repo }。輸出的標記只有固定的 class／role／tabindex 與 data-ref（group|github）、data-n（數字）、
// data-repo（已驗過的擁有者/repo，只有 github）、title（固定句子加驗過的 repo）。
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
    return replaceRefs(seg, (all, owner, repoName, num, at) => {
      const before = seg.slice(0, at)
      const n = Number(num)
      if (!seqOk(n) || n > MAX_REF) return all
      if (owner !== undefined) {
        const full = `${owner}/${repoName}`
        if (BLOCKED_BEFORE_FULL.test(before) || /&amp;$/.test(before) || !parseRepo(full)) return all
        return `<span class="msg-ref" role="link" tabindex="0" data-ref="github" data-n="${n}" data-repo="${esc(full)}" title="${esc(refTip('github', n, full))}">${esc(repoName)}#${n}</span>`
      }
      if (BLOCKED_BEFORE.test(before) || /&amp;$/.test(before)) return all
      const kind = refKind({ n, room: ctx.room === true, lo: ctx.lo, hi: ctx.hi, cue: groupCue(before, seg.slice(at + all.length)), repo: ctx.repo })
      if (!kind) return all
      const repo = kind === 'github' ? ctx.repo : ''
      return `<span class="msg-ref" role="link" tabindex="0" data-ref="${kind}" data-n="${n}"${repo ? ` data-repo="${esc(repo)}"` : ''} title="${esc(refTip(kind, n, repo))}">#${n}</span>`
    })
  }).join('')
}

// 點到的元素 → { kind, n, repo }（repo 只有 github 有）；不是編號標記、或 data-repo 不合規則回 null。
// 網址一律由 githubUrl(repo, n) 重新驗證後組，不讀任何 href
export function refOf(el) {
  const t = el?.closest?.('.msg-ref[data-ref]')
  if (!t) return null
  const kind = t.getAttribute('data-ref')
  const n = Number(t.getAttribute('data-n'))
  if ((kind !== 'group' && kind !== 'github') || !seqOk(n) || n > MAX_REF) return null
  if (kind === 'group') return { kind, n }
  const repo = t.getAttribute('data-repo')
  return parseRepo(repo) ? { kind, n, repo } : null
}
