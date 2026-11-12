// 下方輸入框送來的一整句打進終端（看別台 #1288、看本機 #1378 共用同一套）：打進去之後隔一下再按 Enter；
// 還不能送（別台還在等那台同意）就先排著，能送了才送；多行的先問一次；整句沒送出去就交還給輸入框，不默默丟掉。
// 這裡不碰網路與 Tauri：送字的函式由外面給（別台＝remoteInputApi.send，本機＝termViewApi.input），只管順序與交還。

/** 一整句送進去後隔多久按 Enter（分開送，免得那個視窗把整句連 Enter 當成貼上） */
export const ENTER_DELAY_MS = 120

/** 貼上的文字有幾行；一行以內不用問 */
export function pasteLines(text) {
  const s = String(text ?? '').replace(/\r\n?/g, '\n').replace(/\n+$/, '')
  return s ? s.split('\n').length : 0
}

/**
 * @param {object} o
 * @param {(data: string, paste: boolean) => Promise<boolean>} o.send  送字：回送出去了沒
 * @param {{ value: string|null }} o.askPaste  多行先問用的那一格（和貼上同一個確認框）
 * @param {(event: 'unsent', text: string) => void} o.emit  沒送出去的整句交還給外層
 * @param {() => boolean} [o.ready]  現在能不能送（別台：開始打字了沒）；不能就排著，等外層呼叫 flush
 * @param {() => boolean} [o.ended]  已經結束了（別台：打字通道關了），送一句就重新開始
 * @param {() => void} [o.restart]
 */
export function createLineSender({ send, askPaste, emit, ready = () => true, ended = () => false, restart = () => {} }) {
  let queued = null, lineAsk = false
  // 整句沒送出去就交還給輸入框（不用重打）；整句送出了才按 Enter（Enter 沒送出只提示，不重複放回）
  const typeLine = (text, multi) => {
    void send(text, multi).then(ok => {
      if (!ok) { emit('unsent', text); return }
      setTimeout(() => { void send('\r', false) }, ENTER_DELAY_MS)
    })
  }
  const flush = () => {
    if (queued === null || !ready()) return
    const t = queued; queued = null
    if (pasteLines(t) > 1) { lineAsk = true; askPaste.value = t } else typeLine(t, false)
  }
  const sendLine = text => {
    const t = String(text ?? '').replace(/\r\n?/g, '\n').replace(/\n+$/, '')
    if (!t) return
    if (queued !== null) emit('unsent', queued)
    queued = t
    if (ended()) restart(); else flush()
  }
  // 輸入框那句還在等確認時又貼上別段：那句交還給輸入框，不要被這次蓋掉
  const yieldAsk = () => {
    if (lineAsk) { lineAsk = false; const t = askPaste.value; askPaste.value = null; if (t) emit('unsent', t) }
  }
  // 確認框的回答：是輸入框那句就處理掉並回 true；不是（是貼上）回 false，由外層照原本的貼上處理
  const answer = yes => {
    if (!lineAsk) return false
    lineAsk = false
    const t = askPaste.value; askPaste.value = null
    if (yes) typeLine(t, true); else if (t) emit('unsent', t)
    return true
  }
  // 結束時還沒送出的那句（排著的、或正在問的），拿走後清空
  const takeLeft = () => {
    const left = queued ?? (lineAsk ? askPaste.value : null)
    queued = null; lineAsk = false
    return left
  }
  return { sendLine, flush, yieldAsk, answer, takeLeft }
}
