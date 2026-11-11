package tw.yooliang.asn

import android.content.Intent

// 「掃電腦畫面上的 QR code 核對指紋」的流程（手機端）。
// 網頁只拿得到結果的狀態字：ok／cancel／denied／no_camera／bad_qr／no_lock，從頭到尾拿不到掃到的字——
//   1. 網頁向 Rust 要一個 scan 憑證（android_known_token），再叫 AsnBridge.scanFingerprint(callbackId, challenge)
//   2. 這裡開 FingerprintScanActivity 掃 QR code（掃到的字只放在這個物件裡，同一個行程）
//   3. 掃到後跳生物辨識或螢幕鎖（框上的字是 Rust 寫的說明檔）；**只有驗證通過的那一刻**，ViewerConfirm 才把掃到的字寫成
//      `<憑證雜湊>.scan` 並寫憑證檔，狀態字 ok 才交回網頁
//   4. 網頁再叫 android_known_scan_confirm：Rust 用憑證、讀出並刪掉掃描檔，自己判斷格式、節點與指紋
// 沒有任何 @JavascriptInterface 方法會寫掃描檔或憑證檔。
object FingerprintScan {
  // 和 ViewerConfirm 的 4711～5710（帶世代編號）錯開
  const val REQ = 7101
  /** 掃到的字最多幾個字元（和 Rust 的 consent::SCAN_MAX 一樣）；超過就不是 ASN 的 QR code */
  const val MAX_CHARS = 200
  private const val STALE_MS = 130_000L   // 比網頁的 120 秒逾時長一點；沒回來時不讓它永遠卡住
  private var pendingId: String? = null
  private var pendingChallenge: String? = null
  private var pendingSince = 0L
  private var resultStatus: String? = null
  private var resultText: String? = null

  /** 外殼重建或結束時清掉還沒回的掃描（網頁那邊自己會逾時） */
  fun clear() {
    pendingId = null
    pendingChallenge = null
    resultStatus = null
    resultText = null
  }

  /** 開始掃：憑證要合格、Rust 的說明檔要在（沒有說明就不掃）；不行一律回 cancel。一次只處理一個 */
  fun start(activity: MainActivity, callbackId: String, challenge: String) {
    if (!ViewerConfirm.validChallenge(challenge) || ViewerConfirm.readDescription(activity, challenge) == null) {
      ViewerConfirm.reply(activity, callbackId, "cancel")
      return
    }
    val old = pendingId
    if (old != null) {
      if (android.os.SystemClock.elapsedRealtime() - pendingSince <= STALE_MS) {
        ViewerConfirm.reply(activity, callbackId, "cancel")
        return
      }
      clear()
      ViewerConfirm.reply(activity, old, "cancel")
    }
    pendingId = callbackId
    pendingChallenge = challenge
    pendingSince = android.os.SystemClock.elapsedRealtime()
    resultStatus = null
    resultText = null
    try {
      @Suppress("DEPRECATION")
      activity.startActivityForResult(Intent(activity, FingerprintScanActivity::class.java), REQ)
    } catch (e: Exception) {
      clear()
      ViewerConfirm.reply(activity, callbackId, "no_camera")
    }
  }

  /** 掃描畫面結束前交結果（同一個行程裡的呼叫，不經過網頁）；status 是 ok 才有字 */
  fun deliver(status: String, text: String?) {
    resultStatus = status
    resultText = text
  }

  /** MainActivity.onActivityResult 轉進來：掃到了就接著跳本人確認，其他狀態直接回網頁 */
  fun onActivityResult(activity: MainActivity, requestCode: Int) {
    if (requestCode != REQ) return
    val id = pendingId ?: return
    val challenge = pendingChallenge
    val status = resultStatus ?: "cancel"
    val text = resultText
    clear()
    if (status != "ok" || text == null || challenge == null) {
      ViewerConfirm.reply(activity, id, if (status == "denied" || status == "no_camera") status else "cancel")
      return
    }
    if (text.length > MAX_CHARS) {
      ViewerConfirm.reply(activity, id, "bad_qr")
      return
    }
    // 回到主畫面、畫面穩定後再跳生物辨識
    activity.window.decorView.post { ViewerConfirm.ask(activity, id, challenge, text) }
  }
}
