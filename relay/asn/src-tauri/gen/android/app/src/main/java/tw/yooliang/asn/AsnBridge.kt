package tw.yooliang.asn

import android.app.DownloadManager
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Process
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.provider.MediaStore
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.MimeTypeMap
import java.io.File

// 網頁（ui/m.js）能呼叫的系統功能。方法都在 WebView 的背景執行緒上被叫到，要碰畫面的一律丟回主執行緒。
// 這個物件只交給本 App 內建的頁面；收到的檔案路徑一律先檢查是在 App 私有資料夾底下才動。
class AsnBridge(private val activity: MainActivity) {
  private val filesRoot: File = activity.filesDir.canonicalFile

  /** 震動（對方傳來「震動」時）：兩下短震。網頁自己的 navigator.vibrate 沒有點擊動作就會被擋，所以走這裡 */
  @JavascriptInterface
  fun vibrate(ms: Long) {
    val v: Vibrator? = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      (activity.getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as? VibratorManager)?.defaultVibrator
    } else {
      @Suppress("DEPRECATION")
      activity.getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator
    }
    if (v == null || !v.hasVibrator()) return
    val d = ms.coerceIn(20L, 1000L)
    v.vibrate(VibrationEffect.createWaveform(longArrayOf(0, d, 80, d), -1))
  }

  /** 把收到的檔案從 App 私有資料夾複製到系統「下載/ASN」。成功回給人看的位置，失敗回空字串 */
  @JavascriptInterface
  fun exportFile(path: String): String {
    try {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return ""
      val src = File(path).canonicalFile
      if (!src.path.startsWith(filesRoot.path + File.separator) || !src.isFile) return ""
      val ext = src.extension.lowercase()
      val mime = MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext) ?: "application/octet-stream"
      val values = ContentValues().apply {
        put(MediaStore.Downloads.DISPLAY_NAME, src.name)
        put(MediaStore.Downloads.MIME_TYPE, mime)
        put(MediaStore.Downloads.RELATIVE_PATH, "Download/ASN")
        put(MediaStore.Downloads.IS_PENDING, 1)
      }
      val resolver = activity.contentResolver
      val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values) ?: return ""
      resolver.openOutputStream(uri)?.use { out -> src.inputStream().use { it.copyTo(out) } } ?: return ""
      values.clear()
      values.put(MediaStore.Downloads.IS_PENDING, 0)
      resolver.update(uri, values, null, null)
      return "下載/ASN/" + src.name
    } catch (e: Exception) {
      return ""
    }
  }

  /** 開啟系統的「下載」清單 */
  @JavascriptInterface
  fun openDownloads() {
    activity.runOnUiThread {
      try {
        activity.startActivity(Intent(DownloadManager.ACTION_VIEW_DOWNLOADS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
      } catch (e: Exception) {
      }
    }
  }

  /** 自行安裝版的自動更新：這個版本有沒有（Play 版回 false） */
  @JavascriptInterface
  fun selfUpdateEnabled(): Boolean = SelfUpdate.ENABLED

  /** 把下載好的更新檔交給系統安裝程式。回 ok／need_permission／error／unsupported */
  @JavascriptInterface
  fun installApk(path: String): String = SelfUpdate.install(activity, path)

  // ---------- 偽通話（#99）：安卓內建的語音辨識與語音合成，見 CallVoice.kt；事件由它推回網頁 ----------
  @JavascriptInterface fun callAvailable(): Boolean = activity.callVoice.available()
  /** 麥克風權限：granted／ask */
  @JavascriptInterface fun callMicState(): String = activity.callVoice.micState()
  @JavascriptInterface fun callRequestMic() = activity.callVoice.requestMic()
  @JavascriptInterface fun callListen(names: String) = activity.callVoice.listen(names)
  @JavascriptInterface fun callStopListen() = activity.callVoice.stopListen()
  @JavascriptInterface fun callSpeak(id: String, text: String) = activity.callVoice.speak(id, text)
  @JavascriptInterface fun callStopSpeak() = activity.callVoice.stopSpeak()
  @JavascriptInterface fun callEnd() = activity.callVoice.end()

  /** 通話中讓螢幕保持亮著（不然自己暗掉就會被當成切到背景而結束通話） */
  @JavascriptInterface
  fun keepAwake(on: Boolean) {
    activity.runOnUiThread {
      if (on) activity.window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
      else activity.window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    }
  }

  /** 重新開啟 ASN（第一次登入建好這支手機的節點後，Rust 端要重新讀身分）。先叫起新的，再結束這個行程 */
  @JavascriptInterface
  fun relaunch() {
    activity.runOnUiThread {
      val intent = activity.packageManager.getLaunchIntentForPackage(activity.packageName) ?: return@runOnUiThread
      intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
      activity.startActivity(intent)
      activity.finishAffinity()
      Process.killProcess(Process.myPid())
    }
  }
}
