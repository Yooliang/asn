// 通話模式的「一句話說完了沒」偵測（純函式，好測）。
// 麥克風一直開著，每收到一塊聲音（約 0.1 秒）算一次音量（RMS）餵進來：
// 連續有聲音超過 minSpeech 秒＝開始說話；開始後安靜超過 endSilence 秒＝這一句結束。
// 底噪會自己追蹤（只在沒人講話時更新），門檻＝底噪的 3 倍，但不低於 MIN_THRESHOLD（與 voice-activity 的 SPEECH_RMS 同一數量級）、不高於 MAX_THRESHOLD。
// 這裡只負責切句；一句裡有沒有真的人聲、要不要送去辨識，交給 voice-activity.analyze 再把關一次（擋掉咳嗽、碰桌子）。

export const MIN_THRESHOLD = 0.012
export const MAX_THRESHOLD = 0.06
export const END_SILENCE_SECONDS = 1.0     // 小良哥要求停頓約 0.8～1.2 秒收一句
export const MIN_SPEECH_SECONDS = 0.15     // 持續這麼久的聲音才算開始說話（擋掉單一聲喀）
export const MAX_UTTERANCE_SECONDS = 30    // 一句最長；一直講不停就強制切一刀

export const rmsOf = samples => {
  const n = samples?.length ?? 0
  if (!n) return 0
  let sum = 0
  for (let i = 0; i < n; i++) sum += samples[i] * samples[i]
  return Math.sqrt(sum / n)
}

export function createEndpointer({ endSilence = END_SILENCE_SECONDS, minSpeech = MIN_SPEECH_SECONDS, maxUtterance = MAX_UTTERANCE_SECONDS, floorInit = 0.004 } = {}) {
  let floor = floorInit, speaking = false, run = 0, silence = 0, length = 0
  const threshold = () => Math.min(MAX_THRESHOLD, Math.max(MIN_THRESHOLD, floor * 3))
  return {
    get speaking() { return speaking },
    get threshold() { return threshold() },
    /** 餵一塊（rms＝這一塊的音量、dt＝這一塊多少秒）。回傳 'start'（剛開始說話）｜'end'（這句結束）｜null */
    push(rms, dt) {
      const thr = threshold()
      if (!speaking) {
        if (rms >= thr) {
          run += dt
          if (run >= minSpeech) { speaking = true; silence = 0; length = run; return 'start' }
        } else {
          run = 0
          floor += (rms - floor) * 0.05   // 只在安靜時追蹤底噪
        }
        return null
      }
      length += dt
      if (rms >= thr * 0.7) silence = 0   // 結束的判斷放寬一點（滯後），句中的小停頓與輕聲不會被切斷
      else silence += dt
      if (silence >= endSilence || length >= maxUtterance) { speaking = false; run = 0; silence = 0; length = 0; return 'end' }
      return null
    },
    /** 放棄目前這一句、重新開始聽（靜音、念出回覆之後用） */
    reset() { speaking = false; run = 0; silence = 0; length = 0 },
  }
}
