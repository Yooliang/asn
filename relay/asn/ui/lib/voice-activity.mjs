// 簡單的人聲偵測（移植自 Irori 的 VoiceActivity.cs，#93）：把一段聲音切成 20 毫秒一格算 RMS，判斷有沒有人在講話，
// 並把頭尾的安靜修掉再送去辨識。Whisper 在靜音、底噪上會幻覺出「字幕製作」「謝謝觀看」之類的片尾，
// 所以沒人聲就不送，句尾的長段安靜也不送。純函式，好測。
// 門檻是一般桌上型麥克風量出來的：講話的 RMS 約 0.02～0.2，安靜房間的底噪約 0.001～0.005。
// 聲音一律是 { samples: Float32Array（單聲道 -1～1）, rate: 取樣率 }。

export const FRAME_SECONDS = 0.02
/** 整段最大聲的那一格都低於這個＝沒人講話 */
export const SPEECH_RMS = 0.012
/** 算「有聲音的格」的最低 RMS（底噪很低時用這個） */
export const MIN_VOICED_RMS = 0.006
/** 整段幾乎沒有起伏（風扇、冷氣這種穩定的聲音）時，底噪要大於這個才當成一直在講話 */
export const STEADY_LOUD_RMS = 0.03
/** 有聲音的格加起來至少要這麼久（秒）才算有人講話（擋掉碰到麥克風、單一聲喀） */
export const MIN_VOICED_SECONDS = 0.12
/** 修頭尾時，人聲前後各留這麼多（秒），不切到字頭字尾 */
export const PAD_SECONDS = 0.25
/** 修完至少留這麼長（秒）：whisper.cpp 不處理短於 1 秒的輸入 */
export const MIN_KEEP_SECONDS = 1.2
/** 整段的最大振幅低於這個就連分析都不用做（完全靜音） */
export const SILENCE_PEAK = 0.008

export const peakOf = take => { let p = 0; for (const s of take?.samples ?? []) { const a = Math.abs(s); if (a > p) p = a } return p }
export const secondsOf = take => (take?.rate > 0 ? (take.samples?.length ?? 0) / take.rate : 0)

export function analyze(take) {
  const frame = Math.max(1, Math.floor((take?.rate ?? 16000) * FRAME_SECONDS))
  const s = take?.samples
  const none = { hasSpeech: false, voicedSeconds: 0, peakRms: 0, floorRms: 0, threshold: 0, first: -1, last: -1, frame }
  if (!s || s.length === 0) return none
  const n = Math.ceil(s.length / frame)
  const rms = new Float32Array(n)
  let peak = 0
  for (let f = 0; f < n; f++) {
    const a = f * frame, b = Math.min(s.length, a + frame)
    let sum = 0
    for (let i = a; i < b; i++) sum += s[i] * s[i]
    rms[f] = Math.sqrt(sum / Math.max(1, b - a))
    if (rms[f] > peak) peak = rms[f]
  }
  const sorted = Array.from(rms).sort((x, y) => x - y)
  const floor = sorted[Math.min(n - 1, Math.floor(n / 10))]
  // 底噪的 3 倍；但整段都在講話時底噪會很高，所以不超過最大聲的一半
  const thr = Math.max(MIN_VOICED_RMS, Math.min(floor * 3, peak * 0.5))
  let voiced = 0, first = -1, last = -1
  for (let f = 0; f < n; f++) {
    if (rms[f] < thr) continue
    voiced++
    if (first < 0) first = f
    last = f
  }
  const voicedSeconds = voiced * FRAME_SECONDS
  // 講話有起伏（字與字之間會停）；穩定的底噪沒有。整段都很大聲（一直在講）另外放行
  const dynamic = peak >= floor * 2 || floor >= STEADY_LOUD_RMS
  const hasSpeech = peak >= SPEECH_RMS && dynamic && voicedSeconds >= MIN_VOICED_SECONDS
  return { hasSpeech, voicedSeconds, peakRms: peak, floorRms: floor, threshold: thr, first, last, frame }
}

export const hasSpeech = take => analyze(take).hasSpeech

/** 把頭尾的安靜修掉（人聲前後留 PAD_SECONDS，至少留 MIN_KEEP_SECONDS）。不用修就回傳原本那一份 */
export function trim(take, r = analyze(take)) {
  if (!take || !r.hasSpeech || r.first < 0) return take
  const len = take.samples.length, rate = take.rate
  const pad = Math.floor(PAD_SECONDS * rate)
  let a = Math.max(0, r.first * r.frame - pad)
  let b = Math.min(len, (r.last + 1) * r.frame + pad)
  const min = Math.min(len, Math.floor(MIN_KEEP_SECONDS * rate))
  if (b - a < min) {
    // 太短：往兩邊補回原本的聲音
    let need = min - (b - a)
    const left = Math.min(a, Math.floor(need / 2))
    a -= left; need -= left
    const right = Math.min(len - b, need)
    b += right; need -= right
    a = Math.max(0, a - need)
  }
  if (a === 0 && b === len) return take
  return { samples: take.samples.slice(a, b), rate }
}
