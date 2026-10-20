// 錄音轉成 whisper.cpp 吃的格式：16 kHz、單聲道、16 位元 PCM 的 WAV（純函式，好測）。
export const WAV_RATE = 16000

/** 降到 16 kHz：每個輸出點取對應區間的平均（等於簡單低通＋抽樣）。取樣率低於 16 kHz 時線性內插 */
export function resample(samples, from, to = WAV_RATE) {
  if (from === to) return samples
  const n = Math.max(0, Math.round(samples.length * to / from))
  const out = new Float32Array(n)
  const ratio = from / to
  for (let i = 0; i < n; i++) {
    if (ratio >= 1) {
      const a = Math.floor(i * ratio), b = Math.max(a + 1, Math.min(samples.length, Math.floor((i + 1) * ratio)))
      let sum = 0
      for (let k = a; k < b; k++) sum += samples[Math.min(k, samples.length - 1)]
      out[i] = sum / (b - a)
    } else {
      const pos = i * ratio, a = Math.floor(pos), f = pos - a
      out[i] = samples[a] * (1 - f) + (samples[Math.min(a + 1, samples.length - 1)] ?? 0) * f
    }
  }
  return out
}

/** Float32（-1～1）→ 16 位元 PCM 的 WAV 位元組（含 44 位元組檔頭） */
export function encodeWav(samples, rate = WAV_RATE) {
  const n = samples.length
  const buf = new ArrayBuffer(44 + n * 2)
  const v = new DataView(buf)
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)) }
  str(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); str(8, 'WAVE'); str(12, 'fmt ')
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true)
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true)
  str(36, 'data'); v.setUint32(40, n * 2, true)
  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    v.setInt16(44 + i * 2, s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff), true)
  }
  return new Uint8Array(buf)
}

/** 位元組 → base64（分段轉，不會爆 call stack） */
export function toBase64(bytes) {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

/** 一段錄音 → 16 kHz 單聲道 WAV 的 base64 */
export const takeToWavBase64 = take => toBase64(encodeWav(resample(take.samples, take.rate)))
