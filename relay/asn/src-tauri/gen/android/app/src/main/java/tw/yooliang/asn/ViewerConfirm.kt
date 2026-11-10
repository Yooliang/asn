package tw.yooliang.asn

import android.app.Activity
import android.app.KeyguardManager
import android.content.Context
import android.os.Build
import androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_STRONG
import androidx.biometric.BiometricManager.Authenticators.DEVICE_CREDENTIAL
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import org.json.JSONObject
import java.io.File
import java.security.MessageDigest

// 手機上的本人確認（生物辨識或螢幕鎖）。結果只有三種：ok／cancel（取消或失敗）／no_lock（沒設螢幕鎖），
// 交回網頁的 window.__asnConfirmViewer(callbackId, result)。一次只處理一個，忙著時新的一律回 cancel。
// 有帶憑證（challenge）的那種（「記住這台」「忘記」）：**只有在驗證通過的那一刻**（onAuthenticationSucceeded、API 29 以下的 RESULT_OK）
// 才呼叫 writeConsentMarker，在 `<filesDir>/.irori-asn/consent/<憑證的 SHA-256 小寫十六進位>` 寫一個檔；Rust 端（consent.rs）收到憑證時
// 核對並刪掉這個檔才算數。資料夾要和 Rust 的 app.data_dir／consent 一致：手機的 data_dir 是 filesDir 底下的 `.irori-asn`（datadir.rs 的 FALLBACK_NAME）。
// 檔名由這裡自己算雜湊，不用網頁給的字串組路徑；沒有任何 @JavascriptInterface 方法會寫這個檔。
object ViewerConfirm {
  const val REQ = 4711
  private const val STALE_MS = 130_000L   // 比網頁的 120 秒逾時長一點；回呼沒回來時不讓 pending 永遠卡住
  private var pending: String? = null
  private var pendingSince = 0L
  private var pendingChallenge: String? = null
  private const val CONSENT_DIR = ".irori-asn/consent"
  private const val CHALLENGE_LEN = 64

  /** 外殼重建或結束時清掉還沒回的確認（網頁那邊自己會逾時） */
  fun clear() { pending = null; pendingChallenge = null }

  /** challenge＝null：查看電腦終端前的確認（不寫任何檔）；有值：64 個小寫十六進位字元的憑證，驗證通過時寫憑證檔 */
  fun ask(activity: MainActivity, callbackId: String, challenge: String? = null) {
    if (challenge != null && !validChallenge(challenge)) { reply(activity, callbackId, "cancel"); return }
    val old = pending
    if (old != null) {
      if (android.os.SystemClock.elapsedRealtime() - pendingSince <= STALE_MS) { reply(activity, callbackId, "cancel"); return }
      pending = null
      pendingChallenge = null
      reply(activity, old, "cancel")
    }
    // 框上的字：查看終端是固定字；帶憑證的只用 Rust 發憑證時寫的說明檔（動作＋電腦名＋指紋），讀不到就不跳框
    val title = if (challenge == null) VIEW_TITLE else readDescription(activity, challenge)
    if (title == null) { reply(activity, callbackId, "cancel"); return }
    val km = activity.getSystemService(Context.KEYGUARD_SERVICE) as? KeyguardManager
    if (km == null || !km.isDeviceSecure) { reply(activity, callbackId, "no_lock"); return }
    pending = callbackId
    pendingChallenge = challenge
    pendingSince = android.os.SystemClock.elapsedRealtime()
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
        val prompt = BiometricPrompt(activity, ContextCompat.getMainExecutor(activity), object : BiometricPrompt.AuthenticationCallback() {
          override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) = verified(activity)
          override fun onAuthenticationError(errorCode: Int, errString: CharSequence) = finish(activity, "cancel")
        })
        val info = BiometricPrompt.PromptInfo.Builder()
          .setTitle(title)
          .setSubtitle("請驗證是你本人")
          .setAllowedAuthenticators(BIOMETRIC_STRONG or DEVICE_CREDENTIAL)
          .build()
        prompt.authenticate(info)
      } else {
        // API 29 以下的 BiometricPrompt 不能同時允許生物辨識與螢幕鎖密碼，改走系統的螢幕鎖確認畫面
        @Suppress("DEPRECATION")
        val intent = km.createConfirmDeviceCredentialIntent(title, "請驗證是你本人")
        if (intent == null) {
          finish(activity, "no_lock")
        } else {
          @Suppress("DEPRECATION")
          activity.startActivityForResult(intent, REQ)
        }
      }
    } catch (e: Exception) {
      finish(activity, "cancel")
    }
  }

  /** MainActivity.onActivityResult 轉進來（API 29 以下） */
  fun onActivityResult(activity: MainActivity, requestCode: Int, resultCode: Int) {
    if (requestCode != REQ) return
    if (resultCode == Activity.RESULT_OK) verified(activity) else finish(activity, "cancel")
  }

  /** 驗證通過（只有 onAuthenticationSucceeded 與 RESULT_OK 會叫到這裡）：有憑證就先寫憑證檔，寫不出來當作沒通過 */
  private fun verified(activity: MainActivity) {
    if (pending == null) return
    val ch = pendingChallenge
    if (ch != null && !writeConsentMarker(activity, ch)) { finish(activity, "cancel"); return }
    finish(activity, "ok")
  }

  private fun validChallenge(s: String): Boolean = s.length == CHALLENGE_LEN && s.all { it in '0'..'9' || it in 'a'..'f' }

  private const val VIEW_TITLE = "查看電腦終端"
  private const val DESC_MAX = 60

  private fun hashOf(challenge: String): String =
    MessageDigest.getInstance("SHA-256").digest(challenge.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }

  /** Rust 發憑證時寫的說明檔（`<consent>/<雜湊>.desc`）：框上只用這段字。沒有、讀不到、是空的就回 null（不跳框） */
  private fun readDescription(activity: MainActivity, challenge: String): String? {
    return try {
      val f = File(File(activity.filesDir, CONSENT_DIR), hashOf(challenge) + ".desc")
      if (!f.isFile) return null
      val t = f.readText(Charsets.UTF_8).filter { !it.isISOControl() }.take(DESC_MAX).trim()
      if (t.isEmpty()) null else t
    } catch (e: Exception) {
      null
    }
  }

  /** 憑證檔：檔名＝憑證字串（UTF-8）的 SHA-256 小寫十六進位。只有 verified 能叫；回有沒有寫成功 */
  private fun writeConsentMarker(activity: MainActivity, challenge: String): Boolean {
    return try {
      val name = hashOf(challenge)
      val dir = File(activity.filesDir, CONSENT_DIR)
      if (!dir.isDirectory && !dir.mkdirs()) return false
      File(dir, name).writeText("1")
      true
    } catch (e: Exception) {
      false
    }
  }

  private fun finish(activity: MainActivity, result: String) {
    val id = pending ?: return
    pending = null
    pendingChallenge = null
    reply(activity, id, result)
  }

  private fun reply(activity: MainActivity, id: String, result: String) {
    val w = activity.webView ?: return
    w.post { w.evaluateJavascript("window.__asnConfirmViewer && window.__asnConfirmViewer(${JSONObject.quote(id)}, ${JSONObject.quote(result)})", null) }
  }
}
