// 麥克風錄音（WebView2 的 getUserMedia + WebAudio）：開始錄 → 結束時交回一整段單聲道 Float32。
// 這支碰瀏覽器 API，沒有單元測試（流程在 voice-input.mjs 用假麥克風測）；真機驗證項目見 docs/VOICE.md。
export const micErrorText = e => {
  const n = e?.name
  if (n === 'NotAllowedError' || n === 'SecurityError') return '麥克風沒有授權。請到 Windows「設定 > 隱私權與安全性 > 麥克風」允許桌面應用程式使用。'
  if (n === 'NotFoundError' || n === 'OverconstrainedError') return '找不到麥克風。'
  if (n === 'NotReadableError') return '麥克風被別的程式占用了。'
  return '無法使用麥克風。'
}

export function createMic() {
  let ctx = null, stream = null, node = null, src = null, mute = null, chunks = []
  const release = () => {
    try { node && (node.onaudioprocess = null, node.disconnect()) } catch { /* 已斷 */ }
    try { src && src.disconnect() } catch { /* 已斷 */ }
    try { mute && mute.disconnect() } catch { /* 已斷 */ }
    try { stream && stream.getTracks().forEach(t => t.stop()) } catch { /* 已停 */ }
    const c = ctx
    ctx = stream = node = src = mute = null
    if (c) c.close().catch(() => {})
  }
  return {
    async start() {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('這個環境不支援麥克風錄音。')
      try { stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } }) }
      catch (e) { throw new Error(micErrorText(e)) }
      chunks = []
      ctx = new AudioContext()
      if (ctx.state === 'suspended') await ctx.resume().catch(() => {})
      src = ctx.createMediaStreamSource(stream)
      // ScriptProcessor 雖然被標為過時，但不需要另外載入 worklet 檔案（受 CSP 限制），WebView2 長期支援
      node = ctx.createScriptProcessor(4096, 1, 1)
      node.onaudioprocess = ev => { chunks.push(new Float32Array(ev.inputBuffer.getChannelData(0))) }
      mute = ctx.createGain(); mute.gain.value = 0   // 要接到輸出才會觸發處理，但不要把麥克風聲音播出來
      src.connect(node); node.connect(mute); mute.connect(ctx.destination)
    },
    async stop() {
      const rate = ctx?.sampleRate ?? 48000
      const parts = chunks; chunks = []
      release()
      const len = parts.reduce((n, p) => n + p.length, 0)
      const samples = new Float32Array(len)
      let o = 0
      for (const p of parts) { samples.set(p, o); o += p.length }
      return { samples, rate }
    },
  }
}
