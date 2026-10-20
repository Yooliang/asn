// 測試用的合成聲音：人聲用方波、安靜用固定亂數的小雜訊（每次結果相同）。
export const RATE = 16000

/** 依序接起來的幾段：[秒數, 振幅, 是不是人聲]。人聲用方波，安靜用小雜訊（固定亂數，每次結果相同） */
export function build(...parts) {
  const list = []
  let x = 98765
  for (const [sec, amp, tone] of parts) {
    const n = Math.floor(sec * RATE)
    for (let i = 0; i < n; i++) {
      if (tone) list.push(Math.floor(i / 40) % 2 === 0 ? amp : -amp)
      else { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; list.push((((x >>> 16) / 65535) - 0.5) * 2 * amp) }
    }
  }
  return { samples: Float32Array.from(list), rate: RATE }
}
