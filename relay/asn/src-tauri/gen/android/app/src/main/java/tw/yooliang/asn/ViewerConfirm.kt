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

// 手機查看電腦終端前的本人確認（生物辨識或螢幕鎖）。結果只有三種：ok／cancel（取消或失敗）／no_lock（沒設螢幕鎖），
// 交回網頁的 window.__asnConfirmViewer(callbackId, result)。一次只處理一個，忙著時新的一律回 cancel。
object ViewerConfirm {
  const val REQ = 4711
  private const val STALE_MS = 130_000L   // 比網頁的 120 秒逾時長一點；回呼沒回來時不讓 pending 永遠卡住
  private var pending: String? = null
  private var pendingSince = 0L

  /** 外殼重建或結束時清掉還沒回的確認（網頁那邊自己會逾時） */
  fun clear() { pending = null }

  fun ask(activity: MainActivity, callbackId: String) {
    val old = pending
    if (old != null) {
      if (android.os.SystemClock.elapsedRealtime() - pendingSince <= STALE_MS) { reply(activity, callbackId, "cancel"); return }
      pending = null
      reply(activity, old, "cancel")
    }
    val km = activity.getSystemService(Context.KEYGUARD_SERVICE) as? KeyguardManager
    if (km == null || !km.isDeviceSecure) { reply(activity, callbackId, "no_lock"); return }
    pending = callbackId
    pendingSince = android.os.SystemClock.elapsedRealtime()
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
        val prompt = BiometricPrompt(activity, ContextCompat.getMainExecutor(activity), object : BiometricPrompt.AuthenticationCallback() {
          override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) = finish(activity, "ok")
          override fun onAuthenticationError(errorCode: Int, errString: CharSequence) = finish(activity, "cancel")
        })
        val info = BiometricPrompt.PromptInfo.Builder()
          .setTitle("查看電腦終端")
          .setSubtitle("請驗證是你本人")
          .setAllowedAuthenticators(BIOMETRIC_STRONG or DEVICE_CREDENTIAL)
          .build()
        prompt.authenticate(info)
      } else {
        // API 29 以下的 BiometricPrompt 不能同時允許生物辨識與螢幕鎖密碼，改走系統的螢幕鎖確認畫面
        @Suppress("DEPRECATION")
        val intent = km.createConfirmDeviceCredentialIntent("查看電腦終端", "請驗證是你本人")
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
    finish(activity, if (resultCode == Activity.RESULT_OK) "ok" else "cancel")
  }

  private fun finish(activity: MainActivity, result: String) {
    val id = pending ?: return
    pending = null
    reply(activity, id, result)
  }

  private fun reply(activity: MainActivity, id: String, result: String) {
    val w = activity.webView ?: return
    w.post { w.evaluateJavascript("window.__asnConfirmViewer && window.__asnConfirmViewer(${JSONObject.quote(id)}, ${JSONObject.quote(result)})", null) }
  }
}

val ciRedProbe = (
