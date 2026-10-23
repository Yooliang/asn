// 語音辨識結果的整理（純函式，移植自 Irori 的 unity/Assets/Irori/Voice/SpeechToText.cs 的 SttText）：
// 去掉 Whisper 在安靜時會冒出來的雜訊標記、整句都是「靜音幻覺」（字幕製作者、謝謝觀看、請訂閱…）就丟掉、簡轉繁、判斷是不是空的。
import { SIMPLIFIED, TRADITIONAL } from './s2t-table.mjs'

// [音樂]、(掌聲)、（笑）、♪…、【字幕】等括號整段與音符
const NOISE = /\[[^\]]*\]|\([^)]*\)|（[^）]*）|【[^】]*】|[♪♫♬]+/g
// Whisper 在靜音／雜訊上常幻覺出來的影片片尾。比對前已轉繁體、去掉空白與標點、轉小寫。
// 整句都由這些片段組成才算幻覺；句子裡只是提到（「我在做字幕製作的工作」）不算。
// 會接人名（\w{0,N}）的片段，前面一定要有「製作／提供／由／by…」這類字，不然「字幕太小了」也會被當成「字幕＋人名」吃掉。
const W = '[\\p{L}\\p{N}_]'   // .NET 的 \w 含中文，JS 的 \w 不含：這裡明寫
const HALLUCINATION_PART = new RegExp(
  '(字幕)?(由)?amara(org)?(社群|社區|社羣)?(提供)?(的)?(字幕)?' +
  `|(中文|中英|簡體|繁體)?字幕(製作|製作者|製作人|提供|翻譯|校對|志願者|志愿者|組|君|由|by)(人|者)?(by|由)?${W}{0,8}` +
  `|(翻譯|校對|時間軸|後期|壓制|潤色|聽譯)(製作|製作者|製作人|提供|志願者|組|君)(人|者)?(by|由)?${W}{0,8}` +
  '|(請|歡迎|記得)?(大家)?(不吝)?(點贊|點讚|按讚|訂閱|轉發|打賞)(支持)?(我的|本|我們的)?(頻道|欄目|節目)?' +
  '|明鏡(與|和)點點欄目|點點欄目|優優獨播劇場|yoyotelevisionseriesexclusive' +
  '|(謝謝|感謝|多謝)(大家|各位|你|您)?(的)?(收看|觀看|觀賞|收聽|聆聽|觀看本期節目)' +
  '|(我們)?(下期|下集)(節目)?再見|本期(節目)?(就)?到這(裡|里)' +
  `|thanksforwatching|pleasesubscribe|subscribe|subtitlesby${W}{0,12}`,
  'gu',
)

const MAP = new Map()
{
  const s = [...SIMPLIFIED], t = [...TRADITIONAL]
  for (let i = 0; i < Math.min(s.length, t.length); i++) MAP.set(s[i], t[i])
}

/** 簡體 → 繁體（字對字） */
export function s2t(text) {
  if (!text) return text
  let out = ''
  for (const ch of text) out += ch.codePointAt(0) >= 0x80 ? (MAP.get(ch) ?? ch) : ch
  return out
}

const isCjk = ch => { const c = ch.charCodeAt(0); return (c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3400 && c <= 0x4dbf) || (c >= 0x3000 && c <= 0x303f) || (c >= 0xff00 && c <= 0xffef) }
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u

/** 只留字母數字（轉小寫），標點、括號、空白、符號都拿掉 */
const core = s => [...s].filter(c => LETTER_OR_DIGIT.test(c)).join('').toLowerCase()
const whole = c => c.length > 0 && [...c].length <= 60 && c.replace(HALLUCINATION_PART, '') === ''

/**
 * 送給本機辨識（Rust 的 stt.rs prompt_for）的提示詞。Whisper 在靜音或極短的聲音上會把提示詞「念回來」，
 * 通話一開始的按鍵聲就曾因此寄出「請使用正確的標點符號。」。這份要和 stt.rs 的 prompt_for("zh") 一字不差（有測試對照）。
 */
export const STT_PROMPTS = ['以下是繁體中文的句子，請使用正確的標點符號。']
/** 提示詞的片段至少要這麼長（字數）才算念回來；太短的（例如「標點符號」）可能是真的話 */
export const PROMPT_FRAGMENT_MIN = 5
const PROMPT_CORES = STT_PROMPTS.map(core)

/** 辨識結果是不是提示詞本身、提示詞的一段，或提示詞重複好幾遍 */
export function isPromptEcho(raw) {
  if (!raw || !String(raw).trim()) return false
  const test = c => {
    if (!c) return false
    const a = [...c]
    if (a.length > 300) return false
    // 整段能切成若干片段，每片都是提示詞的一段（至少 PROMPT_FRAGMENT_MIN 字）
    return PROMPT_CORES.some(p => {
      const ok = [true]
      for (let i = 1; i <= a.length; i++) {
        ok[i] = false
        for (let j = 0; j <= i - PROMPT_FRAGMENT_MIN && !ok[i]; j++) ok[i] = ok[j] && p.includes(a.slice(j, i).join(''))
      }
      return ok[a.length]
    })
  }
  return test(core(raw)) || test(core(s2t(raw)))
}

/**
 * 整句是不是 Whisper 的靜音幻覺（「（字幕製作:貝爾）」「謝謝觀看」「請不吝點贊 訂閱 轉發 打賞支持明鏡與點點欄目」「由 Amara.org 社群提供的字幕」…）。
 * 括號不論全形半形、配不配對都算。空字串不算。
 */
export function isHallucination(raw) {
  if (!raw || !String(raw).trim()) return false
  if (isPromptEcho(raw)) return true
  // 原文與轉繁體後各比一次（轉換表會把「群」轉成「羣」之類的，兩邊都要能對到）
  return whole(core(raw)) || whole(core(s2t(raw)))
}

/** 接在中文字後面的半形標點 , . ? ! : ; 換成全形（Whisper 的中文輸出常是半形） */
export function fullWidthPunctuation(s) {
  if (!s) return s
  const chars = [...s]
  const map = { ',': '，', '.': '。', '?': '？', '!': '！', ':': '：', ';': '；' }
  return chars.map((c, i) => (i > 0 && isCjk(chars[i - 1]) && map[c] ? map[c] : c)).join('')
}

/** 整理好的文字；沒有內容（含被當成幻覺丟掉）回空字串 */
export function normalize(raw) {
  if (!raw || !String(raw).trim()) return ''
  let s = String(raw).replace(NOISE, ' ').replace(/\s+/g, ' ').trim()
  if (isHallucination(raw)) return ''
  s = s2t(s)
  // 中文字之間 Whisper 偶爾留空白：拿掉（中英交界的空白保留）
  const chars = [...s]
  s = chars.filter((c, i) => !(c === ' ' && i > 0 && i < chars.length - 1 && isCjk(chars[i - 1]) && isCjk(chars[i + 1]))).join('')
  s = fullWidthPunctuation(s.trim())
  return LETTER_OR_DIGIT.test(s) ? s : ''
}
